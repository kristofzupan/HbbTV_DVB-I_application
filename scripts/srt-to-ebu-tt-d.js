#!/usr/bin/env node
/**
 * SubRip (.srt) to EBU-TT-D (EBU Tech 3380), the subtitle format DVB-DASH
 * requires (ETSI TS 103 285) and HbbTV terminals must support.
 *
 * ffmpeg cannot do this. Its `ttml` encoder emits generic TTML with no
 * ebutts: namespace, no urn:ebu:tt:distribution profile and an empty xml:lang,
 * which is not EBU-TT-D and would be signalled as such falsely.
 *
 * Usage:
 *   node scripts/srt-to-ebu-tt-d.js <in.srt> <out.xml> [--lang slv]
 *
 * Subtitles are authored in the conventional bottom position. A terminal
 * renders them with no knowledge of the application drawing over the same
 * picture, and neither DVB-I nor HbbTV lets the two negotiate, so the overlay
 * defaults to the top right instead — moving the thing this project controls
 * rather than the thing viewers have expectations about.
 */
'use strict';

const fs = require('fs');

// EBU-TT-D expresses times against the media timeline as HH:MM:SS.mmm.
// SubRip uses a comma for the decimal separator and is otherwise identical.
// Hours are written in five digits — 00000:02:03.640 — where two would do.
//
// TTML's clock-time allows two or more hour digits, so this is well formed, and
// nothing reading the document cares how wide the field is. What it buys is
// that scripts/publish-loop.js can move a cue onto the live timeline by
// overwriting the digits where they sit, without the string changing length.
//
// The alternative is that a time grows from 00:02:03.640 to 5709:21:00.140 as
// it is offset, which lengthens the document inside the mdat, which changes the
// sample sizes recorded in trun and the size of the mdat box around them. Three
// things to keep in agreement, rewritten every four seconds, to save three
// characters here. Five digits reach 99999 hours, which is eleven years past
// the publisher's epoch.
function srtTimeToTtml(t) {
  const m = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(t.trim());
  if (!m) { throw new Error(`unparsable timecode: "${t}"`); }
  return `${m[1].padStart(5, '0')}:${m[2]}:${m[3]}.${m[4]}`;
}

function toSeconds(t) {
  const [h, m, rest] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'));
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseSrt(text) {
  // Strip a UTF-8 BOM and normalise line endings before splitting on blank
  // lines: a stray CR turns every timecode into an unparsable string.
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];

  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) { continue; }

    // The numeric counter is optional in practice; skip it when present.
    let i = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    if (i >= lines.length) { continue; }

    const timing = /^(.+?)\s*-->\s*(.+?)$/.exec(lines[i]);
    if (!timing) { throw new Error(`no timecode line in block:\n${block}`); }
    const text_ = lines.slice(i + 1);
    if (text_.length === 0) { continue; }   // timed but empty: nothing to show

    cues.push({
      begin: srtTimeToTtml(timing[1]),
      end: srtTimeToTtml(timing[2]),
      lines: text_
    });
  }
  return cues;
}

function buildEbuTtD(cues, lang) {
  const body = cues.map((c) => {
    const content = c.lines.map(xmlEscape).join('<br/>');
    return `        <p region="bottom" style="para" begin="${c.begin}" end="${c.end}">` +
           `<span style="text">${content}</span></p>`;
  }).join('\n');

  // tts:extent on tt establishes the root container; EBU-TT-D expresses region
  // geometry as percentages of it. cellResolution 32x15 is the EBU-TT-D default.
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    xmlns:ebutts="urn:ebu:tt:style"
    ttp:timeBase="media"
    ttp:cellResolution="32 15"
    tts:extent="1920px 1080px"
    xml:lang="${lang}">
  <head>
    <metadata>
      <ttm:title>Subtitles</ttm:title>
    </metadata>
    <styling>
      <!-- Two styles, and the split matters. A p is block level, so a
           background on it paints the full width of the region whatever the
           text is — a bar reaching almost across the picture with a few words
           floating in the middle of it. Carrying the background on the span
           instead paints only the text, which is what EBU-TT-D expects and what
           broadcast subtitles look like: each line boxed to its own length.
           ebutts:linePadding adds the half-character either side that stops the
           first and last glyph touching the edge of that box. -->
      <style xml:id="para"
             tts:fontFamily="sansSerif"
             tts:fontSize="100%"
             tts:lineHeight="125%"
             tts:textAlign="center"/>
      <style xml:id="text"
             tts:color="#FFFFFF"
             tts:backgroundColor="#000000C0"
             ebutts:linePadding="0.5c"/>
    </styling>
    <layout>
      <!-- The conventional EBU-TT-D bottom region: the title-safe area, with
           displayAlign="after" pinning text to its bottom edge so multi-line
           cues grow upwards. Subtitles land where viewers expect them and where
           every other broadcaster puts them, which matters more than dodging
           the sign-language overlay — that is kept clear by defaulting the
           overlay to the top right instead. -->
      <region xml:id="bottom"
              tts:origin="10% 10%"
              tts:extent="80% 80%"
              tts:displayAlign="after"
              tts:writingMode="lrtb"
              tts:overflow="visible"/>
    </layout>
  </head>
  <body>
    <div>
${body}
    </div>
  </body>
</tt>
`;
}

function main() {
  const args = process.argv.slice(2);
  const langIdx = args.indexOf('--lang');
  let lang = 'slv';
  if (langIdx >= 0) { lang = args[langIdx + 1]; args.splice(langIdx, 2); }

  const [input, output] = args;
  if (!input || !output) {
    console.error('Usage: node scripts/srt-to-ebu-tt-d.js <in.srt> <out.xml> [--lang slv]');
    process.exit(1);
  }

  const cues = parseSrt(fs.readFileSync(input, 'utf8'));
  if (cues.length === 0) {
    console.error('No cues parsed — refusing to write an empty subtitle document.');
    process.exit(1);
  }

  // Overlapping or reversed cues are legal TTML but almost always an authoring
  // mistake, and they surface on a TV as subtitles that never clear. Report
  // them rather than silently packaging them.
  let problems = 0;
  for (let i = 0; i < cues.length; i++) {
    if (toSeconds(cues[i].end) <= toSeconds(cues[i].begin)) {
      console.warn(`  cue ${i + 1}: ends before it begins (${cues[i].begin} → ${cues[i].end})`);
      problems++;
    }
    if (i > 0 && toSeconds(cues[i].begin) < toSeconds(cues[i - 1].end)) {
      console.warn(`  cue ${i + 1}: overlaps cue ${i} (${cues[i - 1].end} > ${cues[i].begin})`);
      problems++;
    }
  }

  fs.writeFileSync(output, buildEbuTtD(cues, lang), 'utf8');
  console.log(`${cues.length} cues, ${cues[0].begin} → ${cues[cues.length - 1].end}, lang=${lang}`);
  console.log(`${problems} timing problem(s)`);
  console.log(`wrote ${output}`);
}

main();
