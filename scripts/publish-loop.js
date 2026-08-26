#!/usr/bin/env node
/**
 * Serve the pre-packaged loop as a live DASH stream.
 *
 *   node scripts/publish-loop.js
 *
 * Nothing is encoded or packaged here. ffmpeg_stream_commands/package-loop has
 * already produced every segment the stream will ever send; this decides which
 * of them is current, links it under the name the manifest promises, and
 * rewrites the manifest. That is the whole of it, and it is why the host no
 * longer needs the CPU to encode two 1080p streams in real time.
 *
 * Three properties come out of building it this way rather than adjusting the
 * encoders:
 *
 *   - The channels cannot drift apart. Both presentations are placed on the
 *     same timeline from the same constant, so the overlay and burnt-in
 *     channels show the same moment of the programme by construction, not by
 *     starting two encoders close together and hoping.
 *
 *   - Restarting is invisible. availabilityStartTime is a fixed constant rather
 *     than the time the process happened to start, so a restart puts the stream
 *     back exactly where it would have been. The encoders it replaces deleted
 *     every segment on exit and reset the timeline, which is what black-screened
 *     clients on each deploy.
 *
 *   - The subtitles cannot drift. They are segments on the same timeline as the
 *     picture, not a document replayed against a measured loop length, so the
 *     56 ms per loop that put them 94 seconds out after five days has nowhere
 *     to accumulate.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOOP = path.join(ROOT, 'DVB-I-Reference-Client', 'stream', 'loop');
const LIVE = path.join(ROOT, 'DVB-I-Reference-Client', 'stream', 'live');

// Any fixed instant in the past does; what matters is that it never changes,
// because it is what makes a restart continuous and the two channels identical.
// Moving it re-phases the programme against the clock, nothing worse.
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

// Segments kept available behind the live edge. 15 at 4 s is the minute that
// the encoders offered, and the client is asked to sit 12 s back, so there is
// most of a minute of slack for a client that stalls.
const WINDOW = 15;

// Published in the manifest, and the reason it is here rather than left to the
// client: an encoder that fell behind used to publish segments in bursts, and a
// client sitting one segment from the live edge ran dry on every burst. Nothing
// falls behind any more, but a manifest that asks for 4 s of headroom is
// promising something it cannot make good on the moment anything does.
const PRESENTATION_DELAY = 12;

const loop = JSON.parse(fs.readFileSync(path.join(LOOP, 'loop.json'), 'utf8'));
const SEG = loop.segmentSeconds;
const COUNT = loop.segments;

const segmentNow = () => Math.floor((Date.now() - EPOCH_MS) / 1000 / SEG) + 1;

// Segment n of the endless timeline is segment ((n-1) mod COUNT)+1 of the loop.
const loopFile = (rep, n) =>
  `chunk-stream${rep}-${String(((n - 1) % COUNT) + 1).padStart(5, '0')}.m4s`;

const liveName = (rep, n) => `chunk-stream${rep}-${String(n).padStart(5, '0')}.m4s`;

function link(from, to) {
  // Replace rather than skip-if-exists: a half-written link from a killed
  // process would otherwise persist and serve the wrong four seconds forever.
  const tmp = to + '.tmp';
  try { fs.unlinkSync(tmp); } catch (e) { /* not there */ }
  fs.symlinkSync(from, tmp);
  fs.renameSync(tmp, to);
}

function publish(name, reps) {
  const dir = path.join(LIVE, name);
  fs.mkdirSync(dir, { recursive: true });

  const latest = segmentNow();
  const oldest = Math.max(1, latest - WINDOW + 1);

  const expected = new Set(['stream.mpd']);
  for (const rep of reps) {
    const init = `init-stream${rep.id}.m4s`;
    expected.add(init);
    link(path.join(LOOP, name, init), path.join(dir, init));
    for (let n = oldest; n <= latest; n++) {
      const live = liveName(rep.id, n);
      expected.add(live);
      link(path.join(LOOP, name, loopFile(rep.id, n)), path.join(dir, live));
    }
  }

  // Delete whatever is not currently promised, rather than only links that have
  // fallen out of the window. Left alone the directory would grow a link per
  // representation every four seconds forever, and on the first run after the
  // switchover it still holds the encoders' own output — real segments from a
  // dead timeline, plus .tmp files one of them left behind in August. Serving
  // those alongside the new ones is the corruption the old deploy script had a
  // step to prevent.
  for (const f of fs.readdirSync(dir)) {
    if (expected.has(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* raced, or a directory */ }
  }

  fs.writeFileSync(path.join(dir, 'stream.mpd.tmp'), manifest(reps, oldest, latest));
  fs.renameSync(path.join(dir, 'stream.mpd.tmp'), path.join(dir, 'stream.mpd'));
  return latest;
}

function manifest(reps, oldest, latest) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
  const count = latest - oldest + 1;

  const sets = reps.map((r) => {
    const role = r.role
      ? `\n      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="${r.role}"/>`
      : '';
    const lang = r.lang ? ` lang="${r.lang}"` : '';
    const dims = r.width ? ` maxWidth="${r.width}" maxHeight="${r.height}" frameRate="${r.frameRate}"` : '';
    const repAttrs = [
      `id="${r.id}"`, `mimeType="${r.mimeType}"`, `codecs="${r.codecs}"`,
      `bandwidth="${r.bandwidth}"`,
      r.width ? `width="${r.width}" height="${r.height}" frameRate="${r.frameRate}"` : '',
      r.sar ? `sar="${r.sar}"` : '',
      r.audioSamplingRate ? `audioSamplingRate="${r.audioSamplingRate}"` : '',
    ].filter(Boolean).join(' ');

    // ETSI TS 103 285 clause 7.1.1 requires @contentType="text" on subtitles;
    // the packager does not emit it, so it is set here along with the Role.
    const audioChannels = r.contentType === 'audio'
      ? '\n        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>'
      : '';

    return `    <AdaptationSet contentType="${r.contentType}"${lang}${dims} segmentAlignment="true" startWithSAP="1">${role}
      <Representation ${repAttrs}>${audioChannels}
        <SegmentTemplate timescale="1000" duration="${SEG * 1000}" startNumber="${oldest}"
                         initialization="init-stream${r.id}.m4s"
                         media="chunk-stream${r.id}-$Number%05d$.m4s">
          <SegmentTimeline>
            <S t="${(oldest - 1) * SEG * 1000}" d="${SEG * 1000}" r="${count - 1}"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"
     profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="dynamic"
     availabilityStartTime="${iso(EPOCH_MS)}"
     publishTime="${iso(Date.now())}"
     minimumUpdatePeriod="PT${SEG}S"
     timeShiftBufferDepth="PT${WINDOW * SEG}S"
     suggestedPresentationDelay="PT${PRESENTATION_DELAY}S"
     maxSegmentDuration="PT${SEG}.0S"
     minBufferTime="PT${SEG * 2}.0S">
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="https://time.akamai.com/?iso"/>
  <Period id="0" start="PT0.0S">
${sets}
  </Period>
</MPD>
`;
}

function tick() {
  let latest;
  for (const [name, reps] of Object.entries(loop.presentations)) {
    latest = publish(name, reps);
  }
  return latest;
}

let previous = 0;
console.log(`publishing ${Object.keys(loop.presentations).join(', ')} — ` +
            `${COUNT} segments of ${SEG}s, loop ${loop.loopSeconds}s`);
tick();
setInterval(() => {
  const n = segmentNow();
  if (n !== previous) {
    previous = n;
    tick();
  }
}, 500);
