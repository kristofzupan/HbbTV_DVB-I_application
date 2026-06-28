/**
 * WebCodecsDecoder: decodes a DASH H.264 stream using the WebCodecs VideoDecoder API
 * and renders VideoFrames to a <canvas> via ctx.drawImage (GPU blit, no pixel copies).
 *
 * Configured with avc1.* + description (raw avcC from init segment) so media segments
 * are fed as AVCC-format EncodedVideoChunks (4-byte length prefix, no start codes).
 *
 * Live-edge management mirrors WasmDecoder exactly.
 * Falls back to null (WasmDecoder used instead) when VideoDecoder is unavailable.
 *
 * Public API identical to WasmDecoder: start(mpdUrl) / stop()
 */
(function (global) {
  'use strict';

  if (typeof VideoDecoder === 'undefined') {
    global.WebCodecsDecoder = null;
    return;
  }

  // ── MPD parser ──────────────────────────────────────────────────────────────

  function parseMPD(mpdText, mpdUrl) {
    var base = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);
    var parser = new DOMParser();
    var doc    = parser.parseFromString(mpdText, 'application/xml');

    var mpdEl  = doc.querySelector('MPD');
    var isLive = (mpdEl && mpdEl.getAttribute('type') === 'dynamic');

    var adaptations = doc.querySelectorAll('AdaptationSet');
    var videoAdapt  = null;
    adaptations.forEach(function (a) {
      if (!videoAdapt && (a.getAttribute('mimeType') || '').indexOf('video') !== -1)
        videoAdapt = a;
    });
    if (!videoAdapt) videoAdapt = adaptations[0];

    var rep = videoAdapt && videoAdapt.querySelector('Representation');
    if (!rep) throw new Error('WebCodecsDecoder: no Representation in MPD');

    var seg = rep.querySelector('SegmentTemplate') ||
              (videoAdapt && videoAdapt.querySelector('SegmentTemplate'));
    if (!seg) throw new Error('WebCodecsDecoder: no SegmentTemplate in MPD');

    var initAttr  = seg.getAttribute('initialization') || '';
    var mediaAttr = seg.getAttribute('media') || '';
    var startNum  = parseInt(seg.getAttribute('startNumber') || '1', 10);
    var timescale = parseInt(seg.getAttribute('timescale') || '1000', 10);
    var segDur    = parseInt(seg.getAttribute('duration') || '6000', 10);
    var repId     = rep.getAttribute('id') || '0';
    var codecs    = rep.getAttribute('codecs') || null;

    function resolve(tpl, num) {
      return base + tpl
        .replace('$RepresentationID$', repId)
        .replace(/\$Number%0(\d+)d\$/, function (_, w) {
          return String(num).padStart(parseInt(w, 10), '0');
        })
        .replace('$Number$', num);
    }

    var segCount;
    if (isLive) {
      var timeline = seg.querySelector('SegmentTimeline');
      if (timeline) {
        var count = 0;
        timeline.querySelectorAll('S').forEach(function (s) {
          count += parseInt(s.getAttribute('r') || '0', 10) + 1;
        });
        segCount = count || 10;
      } else {
        segCount = 10;
      }
    } else {
      var durAttr  = mpdEl && mpdEl.getAttribute('mediaPresentationDuration');
      var totalSec = 0;
      if (durAttr) {
        var m = durAttr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
        if (m) totalSec = (parseFloat(m[1]||0)*3600) + (parseFloat(m[2]||0)*60) + parseFloat(m[3]||0);
      }
      segCount = totalSec > 0 ? Math.ceil(totalSec * timescale / segDur) : 100;
    }

    var segs = [];
    for (var i = 0; i < segCount; i++) segs.push(resolve(mediaAttr, startNum + i));

    return {
      initUrl:     resolve(initAttr, startNum),
      segmentUrls: segs,
      segDurSec:   segDur / timescale,
      startNumber: startNum,
      isLive:      isLive,
      codecs:      codecs
    };
  }

  // ── Extract raw avcC record from init segment ───────────────────────────────
  // Returns a copied Uint8Array of the AVCDecoderConfigurationRecord (avcC box
  // content minus the 8-byte box header). Used as VideoDecoder config.description.

  function extractAVCC(buffer) {
    var view   = new DataView(buffer);
    var result = null;

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
          // Copy — don't hold a view into the init segment ArrayBuffer
          result = new Uint8Array(new Uint8Array(buffer, pos + 8, size - 8));
          return;
        }
        if (type === 'moov' || type === 'trak' || type === 'mdia' ||
            type === 'minf' || type === 'stbl') {
          walkBoxes(pos + 8, pos + size);
        } else if (type === 'stsd') {
          walkBoxes(pos + 16, pos + size);
        } else if (type === 'avc1' || type === 'avc3') {
          walkBoxes(pos + 86, pos + size);
        }
        pos += size;
      }
    }

    walkBoxes(0, buffer.byteLength);
    return result;
  }

  // Derive codec string from avcC bytes 1–3: profile / constraint_flags / level
  function codecFromAVCC(avcc) {
    if (!avcc || avcc.length < 4) return 'avc1.42001f';
    var hex = function (b) { return ('0' + b.toString(16)).slice(-2); };
    return 'avc1.' + hex(avcc[1]) + hex(avcc[2]) + hex(avcc[3]);
  }

  // ── fMP4 NAL extractor — AVCC format output ─────────────────────────────────
  // Returns NALs with 4-byte big-endian length prefix (AVCC), ready for
  // EncodedVideoChunk when decoder is configured with description/avcC.

  function extractNALsAVCC(buffer) {
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
        )
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
          // Keep AVCC length prefix (same 4 bytes, same value)
          var bytes = new Uint8Array(4 + nalLen);
          new DataView(bytes.buffer).setUint32(0, nalLen, false);
          bytes.set(new Uint8Array(buffer, sp, nalLen), 4);
          nals.push(bytes);
          sp += nalLen;
        }
      }
      pos += box.size;
    }
    return nals;
  }

  // ── WebCodecsDecoder ────────────────────────────────────────────────────────

  var FRAME_DUR_MS  = 40;   // 25 fps display pacing
  var FRAME_DUR_US  = 40000; // microseconds — EncodedVideoChunk timestamps
  var LIVE_LAG_SEGS = 3;

  function WebCodecsDecoder(canvas) {
    this._canvas        = canvas;
    this._ctx           = canvas.getContext('2d');
    this._decoder       = null;
    this._stopped       = false;
    this._initFetched   = false;
    this._lastSegNum    = -1;
    this._mpdUrl        = null;
    this._codec         = 'avc1.42001f';
    this._avcc          = null;
    this._nextTsUs      = 0;   // monotonic timestamp fed to EncodedVideoChunk
    this._displayIdx    = 0;   // frame counter for setTimeout display pacing
    this._decodingStart = null;
    this._targetLagSegs = 0;
    this._decoderGen    = 0;
  }

  WebCodecsDecoder.prototype._createDecoder = function () {
    var self = this;
    if (self._decoder) {
      try { self._decoder.close(); } catch (e) {}
      self._decoder = null;
    }

    self._nextTsUs      = 0;
    self._displayIdx    = 0;
    self._decodingStart = null;
    self._decoderGen++;
    var myGen = self._decoderGen;

    self._decoder = new VideoDecoder({
      output: function (frame) {
        if (self._stopped || self._decoderGen !== myGen) { frame.close(); return; }

        // Schedule display at the correct wall-clock time.
        // VideoFrame is GPU-resident; drawImage is a GPU blit — no pixel data on CPU.
        var fi = self._displayIdx++;
        if (self._decodingStart === null) self._decodingStart = Date.now();
        var targetMs = self._decodingStart + fi * FRAME_DUR_MS;
        var delay    = Math.max(0, targetMs - Date.now());

        // If we've drifted more than one segment ahead in buffered frames,
        // reset the clock (avoids holding too many VideoFrames open at once).
        if (delay > 2000) {
          self._displayIdx    = 0;
          self._decodingStart = null;
          delay = 0;
        }

        setTimeout(function () {
          if (!self._stopped) {
            try {
              self._ctx.drawImage(frame, 0, 0,
                self._canvas.width, self._canvas.height);
            } catch (e) {}
          }
          frame.close(); // always release GPU memory
        }, delay);
      },
      error: function (err) {
        console.error('[WebCodecsDecoder] decode error:', err);
      }
    });
  };

  WebCodecsDecoder.prototype._configure = function () {
    if (!this._decoder || !this._codec) return;
    var cfg = { codec: this._codec, optimizeForLatency: true };
    if (this._avcc) cfg.description = this._avcc;
    try {
      this._decoder.configure(cfg);
      console.log('[WebCodecsDecoder] configured codec:', this._codec);
    } catch (e) {
      console.error('[WebCodecsDecoder] configure failed:', e);
    }
  };

  WebCodecsDecoder.prototype.start = function (mpdUrl) {
    var self      = this;
    self._stopped     = false;
    self._initFetched = false;
    self._lastSegNum  = -1;
    self._mpdUrl      = mpdUrl;
    self._createDecoder();
    console.log('[WebCodecsDecoder] started:', mpdUrl);
    self._fetchMPDAndDecode();
  };

  WebCodecsDecoder.prototype._fetchMPDAndDecode = function () {
    var self = this;
    if (self._stopped) return;

    fetch(self._mpdUrl)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        if (self._stopped) return;
        var parsed = parseMPD(text, self._mpdUrl);

        var initPromise = self._initFetched
          ? Promise.resolve()
          : fetch(parsed.initUrl)
              .then(function (r) { return r.arrayBuffer(); })
              .then(function (buf) {
                if (self._stopped) return;
                self._avcc  = extractAVCC(buf);
                self._codec = parsed.codecs || codecFromAVCC(self._avcc);
                self._configure();
                self._initFetched = true;
              });

        return initPromise.then(function () {
          if (self._stopped) return;

          var urls     = parsed.segmentUrls;
          var startIdx = 0;

          if (parsed.isLive) {
            var liveEdge = parsed.startNumber + urls.length - 1;
            if (self._targetLagSegs === 0) self._targetLagSegs = LIVE_LAG_SEGS;

            if (self._lastSegNum < 0) {
              startIdx = Math.max(0, urls.length - 1 - self._targetLagSegs);
              console.log('[WebCodecsDecoder] live start: idx', startIdx);
            } else {
              var nextSeg = self._lastSegNum + 1;
              if (liveEdge - nextSeg > self._targetLagSegs) {
                console.log('[WebCodecsDecoder] behind by', liveEdge - nextSeg,
                            'segs — jumping to live edge, recreating decoder');
                startIdx = Math.max(0, urls.length - 1 - self._targetLagSegs);
                self._createDecoder();
                self._configure();
              } else {
                startIdx = Math.max(0, nextSeg - parsed.startNumber);
              }
            }
          }

          var pending = urls.slice(startIdx, startIdx + 1);
          return self._decodeSegments(pending, parsed.segDurSec, parsed.startNumber + startIdx)
            .then(function () {
              if (!self._stopped && parsed.isLive) self._fetchMPDAndDecode();
            });
        });
      })
      .catch(function (e) {
        console.error('[WebCodecsDecoder] MPD error:', e);
        if (!self._stopped) setTimeout(function () { self._fetchMPDAndDecode(); }, 5000);
      });
  };

  WebCodecsDecoder.prototype._decodeSegments = function (urls, segDurSec, startSegNum) {
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
        var nals = extractNALsAVCC(buf);
        console.log('[WebCodecsDecoder] seg', segNum, '— NALs:', nals.length,
                    'bytes:', buf.byteLength);
        self._lastSegNum = segNum;

        nals.forEach(function (nal) {
          if (self._stopped || !self._decoder) return;

          // nal[4] = first byte of NAL data (after 4-byte AVCC length prefix) = NAL header
          var nalType = nal[4] & 0x1F;
          if (nalType === 6) return;    // skip SEI — no picture, no timestamp needed
          if (nalType !== 1 && nalType !== 5) return; // only picture NALs

          var ts = self._nextTsUs;
          self._nextTsUs += FRAME_DUR_US;

          try {
            self._decoder.decode(new EncodedVideoChunk({
              type:      (nalType === 5) ? 'key' : 'delta',
              timestamp: ts,
              data:      nal  // AVCC: [4-byte length][NAL RBSP]
            }));
          } catch (e) {
            console.warn('[WebCodecsDecoder] chunk error:', e.message);
          }
        });

        // Pace segment fetching — same as WasmDecoder
        return new Promise(function (resolve) {
          setTimeout(resolve, segDurSec * 1000);
        });
      })
      .then(function () {
        return self._decodeSegments(rest, segDurSec, segNum + 1);
      })
      .catch(function (e) {
        console.warn('[WebCodecsDecoder] skip segment', segNum, e.message);
        return self._decodeSegments(rest, segDurSec, segNum + 1);
      });
  };

  WebCodecsDecoder.prototype.stop = function () {
    this._stopped = true;
    if (this._decoder) {
      try { this._decoder.close(); } catch (e) {}
      this._decoder = null;
    }
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  };

  // Check if codec is likely supported before creating a decoder instance.
  // Returns a Promise<bool>.
  WebCodecsDecoder.isSupported = function (codec) {
    codec = codec || 'avc1.42001f';
    if (typeof VideoDecoder === 'undefined') return Promise.resolve(false);
    return VideoDecoder.isConfigSupported({ codec: codec, optimizeForLatency: true })
      .then(function (s) { return s.supported === true; })
      .catch(function ()  { return false; });
  };

  global.WebCodecsDecoder = WebCodecsDecoder;

})(window);
