#!/usr/bin/env node
'use strict';

const fs = require('fs');

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
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];

  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) { continue; }

    let i = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    if (i >= lines.length) { continue; }

    const timing = /^(.+?)\s*-->\s*(.+?)$/.exec(lines[i]);
    if (!timing) { throw new Error(`no timecode line in block:\n${block}`); }
    const text_ = lines.slice(i + 1);
    if (text_.length === 0) { continue; }

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
