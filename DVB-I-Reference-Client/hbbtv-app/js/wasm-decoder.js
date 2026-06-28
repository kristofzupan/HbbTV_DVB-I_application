/**
 * WasmDecoder: decodes a DASH H.264 stream using Broadway.js (pure JS/WASM)
 * and renders frames to a <canvas> element.
 *
 * Supports both VOD (static) and live (dynamic) DASH streams.
 * No <video> element or hardware decoder is used.
 *
 * Pipeline:
 *   fetch MPD → parse available segments → fetch fMP4 segments
 *   → extract H.264 NAL units (AVCC→Annex B) → Broadway.decode() → canvas
 *   For live streams: re-fetches MPD each window to follow live edge.
 */
(function (global) {
  'use strict';

  // ── MPD parser ─────────────────────────────────────────────────────────────

  function parseMPD(mpdText, mpdUrl) {
    var base = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);
    var parser = new DOMParser();
    var doc = parser.parseFromString(mpdText, 'application/xml');

    var mpdEl   = doc.querySelector('MPD');
    var isLive  = (mpdEl && mpdEl.getAttribute('type') === 'dynamic');

    // Find video AdaptationSet
    var adaptations = doc.querySelectorAll('AdaptationSet');
    var videoAdapt  = null;
    adaptations.forEach(function (a) {
      if (!videoAdapt && (a.getAttribute('mimeType') || '').indexOf('video') !== -1) {
        videoAdapt = a;
      }
    });
    if (!videoAdapt) videoAdapt = adaptations[0];

    var rep = videoAdapt && videoAdapt.querySelector('Representation');
    if (!rep) throw new Error('WasmDecoder: no Representation in MPD');

    var seg = rep.querySelector('SegmentTemplate') || (videoAdapt && videoAdapt.querySelector('SegmentTemplate'));
    if (!seg) throw new Error('WasmDecoder: no SegmentTemplate in MPD');

    var initAttr  = seg.getAttribute('initialization') || '';
    var mediaAttr = seg.getAttribute('media') || '';
    var startNum  = parseInt(seg.getAttribute('startNumber') || '1', 10);
    var timescale = parseInt(seg.getAttribute('timescale') || '1000', 10);
    var segDur    = parseInt(seg.getAttribute('duration') || '6000', 10);
    var repId     = rep.getAttribute('id') || '0';

    function resolve(tpl, num) {
      return base + tpl
        .replace('$RepresentationID$', repId)
        .replace(/\$Number%0(\d+)d\$/, function (_, w) {
          return String(num).padStart(parseInt(w, 10), '0');
        })
        .replace('$Number$', num);
    }

    // For live: determine available segment range from SegmentTimeline if present,
    // otherwise use window_size heuristic (try startNumber + up to 10 segments).
    var segCount;
    if (isLive) {
      // Count explicit <S> entries if SegmentTimeline is present
      var timeline = seg.querySelector('SegmentTimeline');
      if (timeline) {
        var entries = timeline.querySelectorAll('S');
        var count = 0;
        entries.forEach(function (s) {
          count += parseInt(s.getAttribute('r') || '0', 10) + 1;
        });
        segCount = count || 10;
      } else {
        segCount = 10; // conservative window — live with no timeline
      }
    } else {
      // VOD: use mediaPresentationDuration
      var durAttr = mpdEl && mpdEl.getAttribute('mediaPresentationDuration');
      var totalSec = 0;
      if (durAttr) {
        var m = durAttr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
        if (m) totalSec = (parseFloat(m[1]||0)*3600) + (parseFloat(m[2]||0)*60) + parseFloat(m[3]||0);
      }
      segCount = totalSec > 0 ? Math.ceil(totalSec * timescale / segDur) : 100;
    }

    var segs = [];
    for (var i = 0; i < segCount; i++) segs.push(resolve(mediaAttr, startNum + i));

    // Parse suggestedPresentationDelay (e.g. "PT5S") so live start offset
    // matches what dash.js does — otherwise WasmDecoder starts at live edge
    // while dash.js starts SPD seconds behind it.
    return {
      initUrl:     resolve(initAttr, startNum),
      segmentUrls: segs,
      segDurSec:   segDur / timescale,
      startNumber: startNum,
      isLive:      isLive
    };
  }

  // ── avcC SPS/PPS extractor (init segment) ─────────────────────────────────
  // Init segment has no mdat — codec params are in moov→trak→mdia→minf→stbl→stsd→avc1→avcC

  function extractSPSPPS(buffer) {
    var view = new DataView(buffer);
    var nals = [];

    function read16(o) { return view.getUint16(o, false); }
    function read32(o) { return view.getUint32(o, false); }

    function walkBoxes(start, end) {
      var pos = start;
      while (pos + 8 <= end) {
        var size = read32(pos);
        if (size < 8 || pos + size > end) break;
        var type = String.fromCharCode(
          view.getUint8(pos+4), view.getUint8(pos+5),
          view.getUint8(pos+6), view.getUint8(pos+7)
        );

        if (type === 'avcC') {
          var o = pos + 8; // skip box header (size + 'avcC')
          o += 5;          // skip configVersion, profile, compat, level, lengthSizeMinusOne
          var numSPS = view.getUint8(o++) & 0x1F;
          for (var i = 0; i < numSPS; i++) {
            var spsLen = read16(o); o += 2;
            var sps = new Uint8Array(4 + spsLen);
            sps[0]=0; sps[1]=0; sps[2]=0; sps[3]=1;
            sps.set(new Uint8Array(buffer, o, spsLen), 4);
            nals.push(sps); o += spsLen;
          }
          var numPPS = view.getUint8(o++);
          for (var j = 0; j < numPPS; j++) {
            var ppsLen = read16(o); o += 2;
            var pps = new Uint8Array(4 + ppsLen);
            pps[0]=0; pps[1]=0; pps[2]=0; pps[3]=1;
            pps.set(new Uint8Array(buffer, o, ppsLen), 4);
            nals.push(pps); o += ppsLen;
          }
          return; // found, stop walking
        }

        // Recurse into container boxes
        if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
          walkBoxes(pos + 8, pos + size);
        } else if (type === 'stsd') {
          walkBoxes(pos + 16, pos + size); // stsd: 8 header + 4 version/flags + 4 entry count
        } else if (type === 'avc1' || type === 'avc3') {
          walkBoxes(pos + 86, pos + size); // avc1: 8 header + 6 reserved + 2 data ref + 50 VisualSampleEntry
        }

        pos += size;
      }
    }

    walkBoxes(0, buffer.byteLength);
    return nals;
  }

  // ── fMP4 NAL unit extractor ────────────────────────────────────────────────

  function extractNALs(buffer) {
    var view = new DataView(buffer);
    var nals = [];
    var pos  = 0;

    function read32(o) { return view.getUint32(o, false); }
    function boxAt(o) {
      if (o + 8 > buffer.byteLength) return null;
      var sz = read32(o);
      if (sz < 8 || o + sz > buffer.byteLength) return null;
      return {
        size: sz,
        type: String.fromCharCode(
          view.getUint8(o+4), view.getUint8(o+5),
          view.getUint8(o+6), view.getUint8(o+7)
        ),
        offset: o
      };
    }

    while (pos < buffer.byteLength) {
      var box = boxAt(pos);
      if (!box) break;
      if (box.type === 'mdat') {
        var end = pos + box.size;
        var sp  = pos + 8;
        while (sp + 4 <= end) {
          var nalLen = read32(sp); sp += 4;
          if (nalLen <= 0 || sp + nalLen > end) break;
          var bytes = new Uint8Array(4 + nalLen);
          bytes[0]=0; bytes[1]=0; bytes[2]=0; bytes[3]=1;
          bytes.set(new Uint8Array(buffer, sp, nalLen), 4);
          nals.push(bytes);
          sp += nalLen;
        }
      }
      pos += box.size;
    }
    return nals;
  }

  // ── WasmDecoder ────────────────────────────────────────────────────────────

  var FRAME_DUR_MS = 40; // 25 fps

  // How many segments behind live edge to start, matching dash.js default live delay
  // (3 × minBufferTime = 3 × 2s = 6s for this stream). Tune if interpreter drifts:
  //   too early → increase; too late → decrease.
  var LIVE_LAG_SEGS = 3;

  function WasmDecoder(canvas) {
    this._canvas      = canvas;
    this._ctx         = canvas.getContext('2d');
    this._player      = null;
    this._stopped     = false;
    this._initFetched = false;
    this._lastSegNum  = -1;
    this._mpdUrl      = null;
    this._offscreen   = document.createElement('canvas');
    this._offCtx      = this._offscreen.getContext('2d');
    this._imgData     = null; // reused ImageData to avoid per-frame allocation
    this._globalFrameIdx  = 0;
    this._playbackStart   = null;
    this._targetLagSegs   = 0; // segments behind live edge we're allowed to be (matches SPD)
    this._playerGen       = 0; // incremented on each _createPlayer(); stale callbacks ignored
  }

  // Creates (or re-creates) the Broadway player and wires up onPictureDecoded.
  // Called on start() and whenever we jump to the live edge so the old worker
  // is terminated and all its queued (stale) frames are discarded.
  WasmDecoder.prototype._createPlayer = function () {
    var self = this;

    // Terminate any existing worker cleanly
    if (self._player && self._player.worker) {
      try { self._player.worker.terminate(); } catch (e) {}
    }
    self._player = null;

    self._globalFrameIdx  = 0;
    self._playbackStart   = null;
    self._imgData         = null;
    self._playerGen++;
    var myGen = self._playerGen; // captured in closure; stale workers have lower gen

    // useWorker: true     → Broadway decodes in a Web Worker; main thread stays free.
    // webgl: false        → Worker outputs RGBA pixels via asm.js YUV→RGB.
    // render: false       → Disable Broadway's own renderFrameRGB (it draws to an
    //                       internal canvas that is never in the DOM — pure waste).
    // transferMemory:true → Zero-copy NAL transfer to worker (transfers ArrayBuffer
    //                       ownership instead of copying each NAL before postMessage).
    self._player = new Player({
      useWorker:      true,
      workerFile:     'js/broadway-decoder.js',
      webgl:          false,
      render:         false,
      transferMemory: true,
      size: { width: 1, height: 1 } // irrelevant with render:false
    });

    self._player.onPictureDecoded = function (buf, width, height) {
      if (self._stopped) return;
      // Discard callbacks queued by a previous player that fired after terminate().
      if (self._playerGen !== myGen) return;

      var fi = self._globalFrameIdx++;
      if (self._playbackStart === null) self._playbackStart = Date.now();
      var targetMs = self._playbackStart + fi * FRAME_DUR_MS;
      // Negative delay means frame is late — clamp to 0 (render immediately).
      // Do NOT drop late frames: Broadway decodes slower than 25fps on TV so
      // almost every frame would be late. We render at actual decode throughput
      // rather than dropping most frames and showing 1fps.
      var delay = Math.max(0, targetMs - Date.now());

      // buf arrives from a transferred ArrayBuffer — worker no longer owns it,
      // so it is stable for the lifetime of this closure. No copy needed.
      var w = width, h = height;

      setTimeout(function () {
        if (self._stopped) return;
        try {
          // Reuse ImageData to avoid per-frame allocation.
          if (!self._imgData || self._imgData.width !== w || self._imgData.height !== h) {
            self._imgData = new ImageData(w, h);
          }
          self._imgData.data.set(buf);

          // If display canvas matches decode dimensions: one putImageData, no scaling.
          // Otherwise use offscreen canvas so drawImage handles GPU scaling.
          if (self._canvas.width === w && self._canvas.height === h) {
            self._ctx.putImageData(self._imgData, 0, 0);
          } else {
            if (self._offscreen.width !== w || self._offscreen.height !== h) {
              self._offscreen.width  = w;
              self._offscreen.height = h;
            }
            self._offCtx.putImageData(self._imgData, 0, 0);
            self._ctx.drawImage(self._offscreen, 0, 0, self._canvas.width, self._canvas.height);
          }
        } catch (e) {
          console.warn('[WasmDecoder] render error', e);
        }
      }, Math.max(0, delay));
    };
  };

  WasmDecoder.prototype.start = function (mpdUrl) {
    var self = this;
    self._stopped     = false;
    self._initFetched = false;
    self._lastSegNum  = -1;
    self._mpdUrl      = mpdUrl;

    self._createPlayer();

    console.log('[WasmDecoder] started, fetching MPD:', mpdUrl);
    self._fetchMPDAndDecode();
  };

  WasmDecoder.prototype._fetchMPDAndDecode = function () {
    var self = this;
    if (self._stopped) return;

    fetch(self._mpdUrl)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        if (self._stopped) return;
        var parsed = parseMPD(text, self._mpdUrl);

        console.log('[WasmDecoder] MPD parsed — live:', parsed.isLive, 'segments:', parsed.segmentUrls.length, 'startNum:', parsed.startNumber);

        // Init segment — only once per session
        var initPromise = self._initFetched
          ? Promise.resolve()
          : fetch(parsed.initUrl)
              .then(function (r) { return r.arrayBuffer(); })
              .then(function (buf) {
                if (self._stopped) return;
                var nals = extractSPSPPS(buf);
                console.log('[WasmDecoder] init SPS/PPS NALs:', nals.length);
                nals.forEach(function (nal) { self._player.decode(nal); });
                self._initFetched = true;
              });

        return initPromise.then(function () {
          if (self._stopped) return;

          var urls = parsed.segmentUrls;
          var startIdx = 0;

          if (parsed.isLive) {
            var liveEdge = parsed.startNumber + urls.length - 1;
            if (self._targetLagSegs === 0) {
              self._targetLagSegs = LIVE_LAG_SEGS;
            }

            if (self._lastSegNum < 0) {
              // First fetch: start SPD-equivalent segments behind live edge,
              // matching the position dash.js picks.
              // Player was just created in start() — do NOT recreate or SPS/PPS
              // sent during init will be lost (player killed before segment arrives).
              startIdx = Math.max(0, urls.length - 1 - self._targetLagSegs);
              console.log('[WasmDecoder] live start: idx', startIdx, 'seg', parsed.startNumber + startIdx, '(target lag', self._targetLagSegs, 'segs)');
            } else {
              var nextSeg = self._lastSegNum + 1;
              // Jump as soon as we're even 1 segment past target lag.
              // On slow TV this fires quickly, skipping content instead of accumulating lag.
              if (liveEdge - nextSeg > self._targetLagSegs) {
                // Behind live edge: jump forward and restart worker so all
                // queued stale frames are discarded immediately.
                console.log('[WasmDecoder] behind by', liveEdge - nextSeg, 'segs (target', self._targetLagSegs, ') — jumping, restarting player');
                startIdx = Math.max(0, urls.length - 1 - self._targetLagSegs);
                self._createPlayer();
                self._initFetched = false; // re-send SPS/PPS to fresh decoder
              } else {
                startIdx = Math.max(0, nextSeg - parsed.startNumber);
              }
            }
          }

          // Decode ONE segment per MPD fetch so we re-check the live edge every
          // ~segDurSec seconds.  On slow devices this triggers the live-edge jump
          // above frequently, skipping content rather than falling behind.
          var pending = urls.slice(startIdx, startIdx + 1);
          return self._decodeSegments(pending, parsed.segDurSec, parsed.startNumber + startIdx)
            .then(function () {
              if (self._stopped) return;

              // Segment-boundary lag check: compare wall-clock elapsed to how many
              // frames the worker has actually decoded.  If the worker is more than
              // one segment behind schedule (slow device / Broadway too slow), force
              // a live-edge jump on the next MPD fetch by resetting _lastSegNum.
              if (parsed.isLive && self._playbackStart !== null) {
                var elapsed   = Date.now() - self._playbackStart;
                var decodedMs = self._globalFrameIdx * FRAME_DUR_MS;
                var lagMs     = elapsed - decodedMs;
                if (lagMs > parsed.segDurSec * 1000) {
                  console.log('[WasmDecoder] decode lag', Math.round(lagMs), 'ms — will jump to live edge');
                  // Resetting lastSegNum forces the next MPD fetch to treat this
                  // as a first-fetch and restart at targetLagSegs behind live edge.
                  self._lastSegNum  = -1;
                  self._createPlayer();
                  self._initFetched = false;
                }
              }

              // _decodeNALsPaced already waited segDurSec — fetch next MPD immediately.
              if (parsed.isLive) self._fetchMPDAndDecode();
            });
        });
      })
      .catch(function (e) {
        console.error('[WasmDecoder] MPD error:', e);
        if (!self._stopped) {
          setTimeout(function () { self._fetchMPDAndDecode(); }, 5000);
        }
      });
  };

  // Decode picture NALs from one segment.
  // With useWorker:true, player.decode() is a non-blocking postMessage — all NALs
  // are queued to the worker immediately.  The per-frame display timing is handled
  // inside onPictureDecoded via the global monotonic frame counter.
  // We wait one segment duration before advancing so segments don't overlap and the
  // frame counter stays accurate.
  WasmDecoder.prototype._decodeNALsPaced = function (nals, segDurSec) {
    var self = this;

    // Skip SEI NALs (type 6) — they produce no picture
    var filtered = nals.filter(function (nal) {
      return nal.length >= 5 && (nal[4] & 0x1F) !== 6;
    });

    // Feed NALs one at a time — _broadwayPlayStream processes one NAL unit per
    // call; a concatenated multi-NAL buffer would only decode the first frame.
    // transferMemory:true (set on the Player) makes each postMessage a zero-copy
    // ownership transfer instead of copying the NAL data before sending.
    filtered.forEach(function (nal) {
      if (!self._stopped) self._player.decode(nal);
    });

    // Wait one segment duration before fetching the next segment.
    return new Promise(function (resolve) {
      setTimeout(resolve, segDurSec * 1000);
    });
  };

  WasmDecoder.prototype._decodeSegments = function (urls, segDurSec, startSegNum) {
    var self = this;
    if (self._stopped || urls.length === 0) return Promise.resolve();

    var url    = urls[0];
    var segNum = startSegNum;
    var rest   = urls.slice(1);

    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        if (self._stopped) return;
        var nals = extractNALs(buf);
        console.log('[WasmDecoder] seg', segNum, '— NALs:', nals.length, 'bytes:', buf.byteLength);
        self._lastSegNum = segNum;
        return self._decodeNALsPaced(nals, segDurSec);
      })
      .then(function () {
        return self._decodeSegments(rest, segDurSec, segNum + 1);
      })
      .catch(function (e) {
        console.warn('[WasmDecoder] skip segment', segNum, e.message);
        return self._decodeSegments(rest, segDurSec, segNum + 1);
      });
  };

  WasmDecoder.prototype.stop = function () {
    this._stopped = true;
    if (this._player && this._player.worker) {
      try { this._player.worker.terminate(); } catch (e) {}
    }
    this._player = null;
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  };

  global.WasmDecoder = WasmDecoder;

})(window);
