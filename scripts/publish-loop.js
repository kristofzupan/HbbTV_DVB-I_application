#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOOP = path.join(ROOT, 'DVB-I-Reference-Client', 'stream', 'loop');
const LIVE = path.join(ROOT, 'DVB-I-Reference-Client', 'stream', 'live');

const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

const WINDOW = 15;

const PRESENTATION_DELAY = 12;

const loop = JSON.parse(fs.readFileSync(path.join(LOOP, 'loop.json'), 'utf8'));
const SEG = loop.segmentSeconds;

const FROM_START = new Set(['prenosniki', 'napoved']);

const FROM_START_SPARE = 10;

const windowFor = (name, count) => (FROM_START.has(name) ? count + FROM_START_SPARE : WINDOW);

const segmentNow = () => Math.floor((Date.now() - EPOCH_MS) / 1000 / SEG) + 1;

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

function loopPosition(n, count) {
  const from = n >= resetSegment ? resetSegment : 1;
  return ((n - from) % count) + 1;
}

const loopFile = (rep, position) =>
  `chunk-stream${rep}-${String(position).padStart(5, '0')}.m4s`;

let rewriteFrom = 0;

const liveName = (rep, n) => `chunk-stream${rep}-${String(n).padStart(5, '0')}.m4s`;

function link(from, to) {
  const tmp = to + '.tmp';
  try { fs.unlinkSync(tmp); } catch (e) {}
  fs.symlinkSync(from, tmp);
  fs.renameSync(tmp, to);
}

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

const TTML_TIME = /(begin|end)="(\d{5}):(\d{2}):(\d{2})\.(\d{3})"/g;

function shiftTtmlTimes(buf, offsetSeconds) {
  const text = buf.toString('latin1');
  const shifted = text.replace(TTML_TIME, (whole, attr, h, m, s, ms) => {
    const total = Number(h) * 3600 + Number(m) * 60 + Number(s) + offsetSeconds;
    const hh = String(Math.floor(total / 3600)).padStart(5, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    const out = `${attr}="${hh}:${mm}:${ss}.${ms}"`;
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
  const win = windowFor(name, count);
  const oldest = Math.max(1, latest - win + 1);

  const expected = new Set(['stream.mpd', 'loop-start.json']);
  writeLoopStart(dir, FROM_START.has(name), latest, oldest, count);
  for (const rep of reps) {
    const init = `init-stream${rep.id}.m4s`;
    expected.add(init);
    link(path.join(LOOP, name, init), path.join(dir, init));

    for (let n = oldest; n <= latest; n++) {
      const live = liveName(rep.id, n);
      expected.add(live);
      const target = path.join(dir, live);
      if (n < rewriteFrom && fs.existsSync(target)) continue;

      const position = loopPosition(n, count);
      const offsetSeconds = (n - position) * SEG;
      const offsetTicks = BigInt(offsetSeconds) * BigInt(rep.timescale);
      serveSegment(path.join(LOOP, name, loopFile(rep.id, position)), target,
                   offsetTicks, offsetSeconds,
                   rep.contentType === 'text');
    }
  }

  for (const f of fs.readdirSync(dir)) {
    if (expected.has(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
  }

  fs.writeFileSync(path.join(dir, 'stream.mpd.tmp'), manifest(reps, oldest, latest, win));
  fs.renameSync(path.join(dir, 'stream.mpd.tmp'), path.join(dir, 'stream.mpd'));
  return latest;
}

function writeLoopStart(dir, fromStart, latest, oldest, count) {
  let n = latest - Math.ceil(PRESENTATION_DELAY / SEG);
  if (fromStart) {
    while (n > oldest && loopPosition(n, count) !== 1) n--;
  }
  const body = fromStart && loopPosition(n, count) === 1
    ? JSON.stringify({
        start: (EPOCH_MS + (n - 1) * SEG * 1000) / 1000,
        segment: n,
        loopSeconds: count * SEG,
      })
    : JSON.stringify({ start: null });
  fs.writeFileSync(path.join(dir, 'loop-start.json.tmp'), body);
  fs.renameSync(path.join(dir, 'loop-start.json.tmp'), path.join(dir, 'loop-start.json'));
}

function manifest(reps, oldest, latest, win) {
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

    const audioChannels = r.contentType === 'audio'
      ? '\n        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>'
      : '';

    const priority = r.role === 'main' ? ' selectionPriority="1"'
      : r.role === 'sign' ? ' selectionPriority="0"' : '';

    return `    <AdaptationSet contentType="${r.contentType}"${lang}${dims}${priority} segmentAlignment="true" startWithSAP="1">${role}
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
     timeShiftBufferDepth="PT${win * SEG}S"
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
