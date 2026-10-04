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

const segmentNow = () => Math.floor((Date.now() - EPOCH_MS) / 1000 / SEG) + 1;

// ── Test reset ───────────────────────────────────────────────────────────────
// The control page for user tests (DVB-I-Reference-Client/test/) starts each
// participant's session by writing the time into test-data/state.json. From the
// segment playing at that moment, every loop starts again from its first
// segment, so every participant sees the same programme from the same point.
//
// Only the content restarts, not the timeline. Moving EPOCH_MS instead would
// send the timeline backwards under every player that is already playing; this
// way segment numbers and media times keep increasing, and to a player the
// reset is an ordinary cut.
//
// The reset segment is the one players are showing at the reset time —
// PRESENTATION_DELAY behind the live edge — not the one being published, so the
// cut happens on screen when the button is pressed, and a television reloading
// a few seconds later joins a few seconds into the restarted programme. Derived
// from the stored time rather than kept in memory, so a restart of this process
// puts it back in the same place.
const RESET_FILE = path.join(ROOT, 'test-data', 'state.json');
let resetSegment = 1;
let resetMtime = 0;

function readReset() {
  let st;
  try { st = fs.statSync(RESET_FILE); } catch (e) { return false; }
  if (st.mtimeMs === resetMtime) return false;
  resetMtime = st.mtimeMs;
  let resetAt;
  try { resetAt = JSON.parse(fs.readFileSync(RESET_FILE, 'utf8')).resetAt; } catch (e) { return false; }
  if (!resetAt) return false;
  const n = Math.max(1, Math.floor((resetAt - EPOCH_MS) / 1000 / SEG) + 1
                        - Math.ceil(PRESENTATION_DELAY / SEG));
  if (n === resetSegment) return false;
  resetSegment = n;
  return true;
}

// Segment n of the endless timeline is segment loopPosition(n) of the loop. The
// count is per presentation: the accessibility channels loop every 248 s, the
// plain channel every 4296 s, and all of them restart together at the reset
// segment, so a segment number still means the same instant on every channel.
// Segments before the reset keep the mapping they were published with, counted
// from the epoch.
function loopPosition(n, count) {
  const from = n >= resetSegment ? resetSegment : 1;
  return ((n - from) % count) + 1;
}

const loopFile = (rep, position) =>
  `chunk-stream${rep}-${String(position).padStart(5, '0')}.m4s`;

// Segments at or after this number are rewritten on the next tick even if they
// exist: after a reset they hold the programme from before it, and at startup
// they may have been published before a reset this process has not seen.
let rewriteFrom = 0;

const liveName = (rep, n) => `chunk-stream${rep}-${String(n).padStart(5, '0')}.m4s`;

function link(from, to) {
  // Replace rather than skip-if-exists: a half-written link from a killed
  // process would otherwise persist and serve the wrong four seconds forever.
  const tmp = to + '.tmp';
  try { fs.unlinkSync(tmp); } catch (e) { /* not there */ }
  fs.symlinkSync(from, tmp);
  fs.renameSync(tmp, to);
}

/**
 * Copy a segment out of the loop with its timestamp moved onto the live
 * timeline.
 *
 * This cannot be a symlink. The packaged segments carry the time of their
 * position *within* the loop — segment 11 says it begins at 40 s, every time
 * round — while the manifest places them on a timeline that has been running
 * since the epoch. Served unchanged, a player is told to present something at
 * day 237 and handed a buffer that claims to be 40 seconds in, so it appends
 * the data, finds nothing at the time it wants, and shows black forever. The
 * signer kept playing throughout because the application decodes NAL units
 * itself and never looks at a timestamp, which is what made the cause visible.
 *
 * The fix is the one thing a continuously running encoder gave for free: a
 * baseMediaDecodeTime that always increases. Adding a whole number of loops
 * to it is enough, and normalise-segments.py has already guaranteed a single
 * 64-bit tfdt and no sidx holding a second copy of the same number.
 */
function serveSegment(from, to, offsetTicks, offsetSeconds, isText) {
  const buf = fs.readFileSync(from);
  const i = buf.indexOf('tfdt');
  if (i < 0) throw new Error(`no tfdt in ${from}`);
  buf.writeBigUInt64BE(buf.readBigUInt64BE(i + 8) + offsetTicks, i + 8);

  if (isText) shiftTtmlTimes(buf, offsetSeconds);

  const tmp = to + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, to);
}

/**
 * Move the cue times inside a subtitle segment onto the live timeline.
 *
 * Subtitles carry their timing twice: once in the container, as the sample's
 * baseMediaDecodeTime, and again inside the TTML document as begin and end
 * attributes against ttp:timeBase="media". Audio and video have only the
 * container, which is why moving the tfdt was enough for them and is not enough
 * here. A segment whose sample says 20,553,660 s while its document says
 * 00:02:03.640 gets its cues thrown away as out of range: dash.js reported the
 * track present, enabled and showing, with zero cues in it.
 *
 * The times are authored five hour digits wide by scripts/srt-to-ebu-tt-d.js so
 * that this can overwrite them where they lie. Nothing moves, so no sample size
 * and no box length has to be corrected.
 */
const TTML_TIME = /(begin|end)="(\d{5}):(\d{2}):(\d{2})\.(\d{3})"/g;

function shiftTtmlTimes(buf, offsetSeconds) {
  const text = buf.toString('latin1');
  const shifted = text.replace(TTML_TIME, (whole, attr, h, m, s, ms) => {
    const total = Number(h) * 3600 + Number(m) * 60 + Number(s) + offsetSeconds;
    const hh = String(Math.floor(total / 3600)).padStart(5, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    const out = `${attr}="${hh}:${mm}:${ss}.${ms}"`;
    // Same length or the document has outgrown its hour field, and every sample
    // size in the segment would be wrong. Louder now than corrupt later.
    if (out.length !== whole.length) {
      throw new Error(`TTML time ${out} does not fit the field it replaces`);
    }
    return out;
  });
  buf.write(shifted, 0, 'latin1');
}

function publish(name, { segments: count, representations: reps }) {
  const dir = path.join(LIVE, name);
  fs.mkdirSync(dir, { recursive: true });

  const latest = segmentNow();
  const oldest = Math.max(1, latest - WINDOW + 1);

  const expected = new Set(['stream.mpd']);
  for (const rep of reps) {
    // The init segment carries no timing, so it can stay a link.
    const init = `init-stream${rep.id}.m4s`;
    expected.add(init);
    link(path.join(LOOP, name, init), path.join(dir, init));

    for (let n = oldest; n <= latest; n++) {
      const live = liveName(rep.id, n);
      expected.add(live);
      const target = path.join(dir, live);
      // Only the newest segment is new on any given tick; rewriting the whole
      // window every four seconds would copy 30 MB to no purpose.
      if (n < rewriteFrom && fs.existsSync(target)) continue;

      // The packaged segment at loop position p begins at (p-1)*SEG; on the
      // live timeline segment n begins at (n-1)*SEG. The difference is a whole
      // number of segments, whichever loop and whichever reset this is.
      const position = loopPosition(n, count);
      const offsetSeconds = (n - position) * SEG;
      const offsetTicks = BigInt(offsetSeconds) * BigInt(rep.timescale);
      serveSegment(path.join(LOOP, name, loopFile(rep.id, position)), target,
                   offsetTicks, offsetSeconds,
                   rep.contentType === 'text');
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
  for (const [name, presentation] of Object.entries(loop.presentations)) {
    latest = publish(name, presentation);
  }
  rewriteFrom = Infinity;
  return latest;
}

let previous = 0;
console.log(`publishing ${SEG}s segments: ` + Object.entries(loop.presentations)
  .map(([name, p]) => `${name} (${p.segments} segments, loop ${p.loopSeconds}s)`)
  .join(', '));
readReset();
if (resetSegment > 1) console.log(`loops restarted at segment ${resetSegment}`);
tick();
setInterval(() => {
  // Checked every half second rather than once a segment, so the cut is on
  // screen within moments of the button being pressed.
  if (readReset()) {
    console.log(`test reset: loops restart at segment ${resetSegment}`);
    rewriteFrom = resetSegment;
    tick();
    return;
  }
  const n = segmentNow();
  if (n !== previous) {
    previous = n;
    tick();
  }
}, 500);
