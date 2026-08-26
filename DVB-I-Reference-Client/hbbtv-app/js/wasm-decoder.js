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

  // String.prototype.padStart is ES2017 and missing from the browsers in HbbTV
  // terminals of the generation this work targets. It was reached on every
  // manifest refresh, from inside a promise chain whose only handler logs to the
  // console — so on those terminals the overlay stayed empty and said nothing.
  function zeroPad(num, width) {
    var s = String(num);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  function isVideoAdaptationSet(a) {
    if ((a.getAttribute('contentType') || '').indexOf('video') !== -1) return true;
    if ((a.getAttribute('mimeType') || '').indexOf('video') !== -1) return true;
    var rep = a.querySelector('Representation');
    return !!(rep && (rep.getAttribute('mimeType') || '').indexOf('video') !== -1);
  }

  function hasSignRole(a) {
    // DASH signals sign language on the AdaptationSet, either as a Role or an
    // Accessibility descriptor with value "sign" (role scheme of ISO/IEC 23009-1).
    // Packagers differ on which of the two they emit, so accept both.
    var names = ['Role', 'Accessibility'], i, j, els;
    for (i = 0; i < names.length; i++) {
      els = a.getElementsByTagName(names[i]);
      for (j = 0; j < els.length; j++) {
        if (els[j].getAttribute('value') === 'sign') return true;
      }
    }
    return false;
  }

  // The interpreter and the main picture may share one manifest, which is what
  // keeps them on a common presentation timeline. Pick the signer explicitly by
  // its Role rather than by position: in a combined manifest the first video
  // AdaptationSet is the full-size main picture, which Broadway cannot decode.
  // Falls back to the first video set so single-stream manifests still work.
  function selectSignAdaptationSet(doc) {
    var sets = doc.getElementsByTagName('AdaptationSet');
    var firstVideo = null, i, a;
    for (i = 0; i < sets.length; i++) {
      a = sets[i];
      if (!isVideoAdaptationSet(a)) continue;
      if (!firstVideo) firstVideo = a;
      if (hasSignRole(a)) return a;
    }
    return firstVideo || sets[0] || null;
  }

  function parseMPD(mpdText, mpdUrl) {
    var base = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);
    var parser = new DOMParser();
    var doc = parser.parseFromString(mpdText, 'application/xml');

    var mpdEl   = doc.querySelector('MPD');
    var isLive  = (mpdEl && mpdEl.getAttribute('type') === 'dynamic');

    var videoAdapt = selectSignAdaptationSet(doc);

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
          return zeroPad(num, parseInt(w, 10));
        })
        .replace('$Number$', num);
    }

    // For live: determine available segment range from SegmentTimeline if present,
    // otherwise use window_size heuristic (try startNumber + up to 10 segments).
    // Presentation start of each segment, in seconds on the period timeline.
    // When main and signer share a manifest they share this timeline, so these
    // times are what let a signer frame be matched to the main frame it belongs
    // with instead of being paced off an unrelated wall clock.
    var segCount, segStarts = [];
    if (isLive) {
      // Walk explicit <S> entries if SegmentTimeline is present
      var timeline = seg.querySelector('SegmentTimeline');
      if (timeline) {
        var entries = timeline.getElementsByTagName('S');
        var ticks = 0;
        for (var si = 0; si < entries.length; si++) {
          var tAttr = entries[si].getAttribute('t');
          var d     = parseInt(entries[si].getAttribute('d') || '0', 10);
          var r     = parseInt(entries[si].getAttribute('r') || '0', 10);
          if (tAttr !== null) ticks = parseInt(tAttr, 10);
          for (var k = 0; k <= r; k++) { segStarts.push(ticks / timescale); ticks += d; }
        }
        segCount = segStarts.length || 10;
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

    // On-demand manifests have no SegmentTimeline; segments are evenly spaced.
    if (!segStarts.length) {
      for (var j = 0; j < segCount; j++) segStarts.push(j * segDur / timescale);
    }

    return {
      initUrl:     resolve(initAttr, startNum),
      segmentUrls: segs,
      segStartSec: segStarts,
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

  // How far ahead of the master clock the decoder may run. Frames decoded early
  // just wait in the display queue, but decoding much further ahead wastes work
  // and holds too many pending timers.
  var LEAD_SEGS = 1;

  // How far a frame may be behind the master clock before it is dropped rather
  // than drawn late. One frame of slack either side.
  var LATE_FRAME_TOLERANCE_MS = 60;

  /**
   * @param canvas       destination canvas for signer frames
   * @param masterClock  optional () => seconds on the manifest's period
   *                     timeline, normally the main video's currentTime. When
   *                     supplied, frames are shown at their own presentation
   *                     time relative to that clock rather than paced off the
   *                     decoder's wall clock.
   */
  function WasmDecoder(canvas, masterClock) {
    this._masterClock = typeof masterClock === 'function' ? masterClock : null;
    this._ptsQueue    = [];   // presentation times, in submission order
    this._loggedOffset = false;
    this._canvas      = canvas;
    this._ctx         = canvas.getContext('2d');
    this._player      = null;
    this._stopped     = false;
    this._initFetched = false;
    this._mpdFails    = 0;
    this._lastSegNum  = -1;
    // Cumulative across worker restarts, unlike _globalFrameIdx. "Decoded but
    // never drawn" is the signature of a broken render path, and telling that
    // apart from "never decoded" is most of the diagnosis on a device with no
    // reachable console.
    this._framesDecoded = 0;
    this._framesDrawn   = 0;
    this._lastFailure   = null;
    this._forceNoWebGL  = false;
    this._mpdUrl      = null;
    this._offscreen   = document.createElement('canvas');
    this._offCtx      = this._offscreen.getContext('2d');
    this._imgData     = null; // reused ImageData (RGBA path)
    this._globalFrameIdx  = 0;
    this._playbackStart   = null;
    this._targetLagSegs   = 0;
    this._playerGen       = 0;
    // WebGL YUV path — populated in _createPlayer if WebGL is available
    this._useWebGL    = false;
    this._yuvCanvas   = null; // hidden canvas with WebGL context for YUV shader
    this._yuvRenderer = null; // YUVCanvas instance
  }

  // A master clock is only usable if it lands inside the manifest's segment
  // window. If it does not, the two are on different timelines and following it
  // would reposition on every refresh, restarting the decoder each time.
  function masterInRange(masterT, parsed) {
    if (masterT === null || !parsed.segStartSec || !parsed.segStartSec.length) return false;
    var first = parsed.segStartSec[0] - parsed.segDurSec;
    var last  = parsed.segStartSec[parsed.segStartSec.length - 1] + 2 * parsed.segDurSec;
    return masterT >= first && masterT <= last;
  }

  // Master time, or null when there is no usable clock (interpreter-only mode,
  // or the main video has not started). Callers fall back to wall-clock pacing.
  WasmDecoder.prototype._masterTime = function () {
    if (!this._masterClock) return null;
    var t = this._masterClock();
    return (typeof t === 'number' && isFinite(t) && t > 0) ? t : null;
  };

  // Creates (or re-creates) the Broadway player and wires up onPictureDecoded.
  // Called on start() and whenever we jump to the live edge so the old worker
  // is terminated and all its queued (stale) frames are discarded.
  // Draw src canvas into dst context maintaining aspect ratio (letterbox / pillarbox).
  function drawContain(ctx, src, srcW, srcH, dstW, dstH) {
    var scale = Math.min(dstW / srcW, dstH / srcH);
    var x = (dstW - srcW * scale) / 2 | 0;
    var y = (dstH - srcH * scale) / 2 | 0;
    ctx.clearRect(0, 0, dstW, dstH);
    ctx.drawImage(src, x, y, srcW * scale | 0, srcH * scale | 0);
  }

  WasmDecoder.prototype._createPlayer = function () {
    var self = this;

    // Terminate any existing worker cleanly
    if (self._player && self._player.worker) {
      try { self._player.worker.terminate(); } catch (e) {}
    }
    self._player = null;

    self._globalFrameIdx  = 0;
    self._playbackStart   = null;
    self._ptsQueue.length = 0;  // queued times belong to the discarded worker
    self._imgData         = null;
    self._yuvCanvas       = null;
    self._yuvRenderer     = null;
    self._playerGen++;
    var myGen = self._playerGen;

    // useWorker: true     → Broadway decodes in a Web Worker; main thread stays free.
    // webgl: 'auto'       → If TV has WebGL: worker sends raw YUV420 (no asm.js
    //                       YUV→RGBA in worker, 37.5% less postMessage data);
    //                       YUVCanvas GPU shader handles conversion on main thread.
    //                       If no WebGL: falls back to RGBA worker output automatically.
    // render: false       → Disable Broadway's own canvas render (never in DOM).
    // transferMemory:true → Zero-copy NAL transfer to worker.
    self._player = new Player({
      useWorker:      true,
      workerFile:     'js/broadway-decoder.js',
      // 'auto' unless a YUVCanvas init has already failed on this device, in
      // which case the worker must convert to RGBA itself.
      webgl:          self._forceNoWebGL ? false : 'auto',
      render:         false,
      transferMemory: true,
      size:           { width: 1, height: 1 }
    });

    // Record which path the worker will use for this player instance.
    // self._player.webgl is set by Broadway's auto-detection before we read it.
    self._useWebGL = self._player.webgl;
    console.log('[WasmDecoder] render path:', self._useWebGL ? 'WebGL YUV shader' : 'software RGBA');

    self._player.onPictureDecoded = function (buf, width, height) {
      if (self._stopped) return;
      if (self._playerGen !== myGen) return;

      if (!self._firstFrameReported) {
        self._firstFrameReported = true;
        if (typeof self.onFirstFrame === 'function') { self.onFirstFrame(width, height); }
      }

      var fi = self._globalFrameIdx++;
      self._framesDecoded++;
      if (self._playbackStart === null) self._playbackStart = Date.now();

      // Broadway emits pictures in submission order (Baseline profile has no
      // frame reordering), so the oldest queued presentation time belongs to
      // this picture.
      var ptsSec    = self._ptsQueue.length ? self._ptsQueue.shift() : null;
      var masterSec = self._masterTime();
      var delay;

      if (ptsSec !== null && masterSec !== null) {
        delay = (ptsSec - masterSec) * 1000;
        if (!self._loggedOffset) {
          self._loggedOffset = true;
          console.log('[WasmDecoder] first synced frame: master', masterSec.toFixed(2),
                      's, signer pts', ptsSec.toFixed(2),
                      's, offset', (masterSec - ptsSec).toFixed(2), 's');
        }
        // Too far behind the picture to be useful — drop it and let the next
        // manifest refresh reposition us.
        if (delay < -LATE_FRAME_TOLERANCE_MS) { return; }
        if (delay < 0) { delay = 0; }
      } else {
        var targetMs = self._playbackStart + fi * FRAME_DUR_MS;
        delay = Math.max(0, targetMs - Date.now());
      }

      // buf is from a transferred ArrayBuffer — stable for this closure lifetime.
      var w = width, h = height;

      if (self._useWebGL) {
        // ── WebGL YUV path ──────────────────────────────────────────────────
        // Lazy-init YUVCanvas at actual video dimensions (not display size).
        // YUVCanvas creates its own WebGL context on a hidden canvas; we then
        // blit that canvas to the display canvas via drawImage (GPU scaling).
        if (!self._yuvRenderer || self._yuvCanvas.width !== w || self._yuvCanvas.height !== h) {
          self._yuvCanvas          = document.createElement('canvas');
          self._yuvCanvas.width    = w;
          self._yuvCanvas.height   = h;
          self._yuvRenderer        = new YUVCanvas({ canvas: self._yuvCanvas, width: w, height: h });
          if (!self._yuvRenderer.isWebGL()) {
            // Broadway's detection said WebGL, YUVCanvas disagrees. Skipping the
            // frame and retrying is not a recovery: the flag is never cleared, so
            // every later frame lands here too and the overlay stays empty for
            // the rest of the session with only a console warning to show for it.
            //
            // Falling through to the RGBA branch below would not work either —
            // webgl:'auto' told the worker to emit YUV planes, so `buf` is the
            // wrong shape for putImageData. The worker has to be rebuilt with
            // conversion switched back on, which is what _forceNoWebGL does.
            console.warn('[WasmDecoder] YUVCanvas WebGL init failed — ' +
                         'restarting the worker in software RGBA mode');
            self._yuvRenderer  = null;
            self._forceNoWebGL = true;
            self._createPlayer();
            self._initFetched  = false; // fresh worker needs SPS/PPS again
            return;
          }
        }

        // Snapshot YUV plane views before setTimeout (all views into same stable buffer).
        var yLen  = w * h;
        var uvLen = (w >> 1) * (h >> 1);
        var yData = buf.subarray(0, yLen);
        var uData = buf.subarray(yLen, yLen + uvLen);
        var vData = buf.subarray(yLen + uvLen, yLen + uvLen + uvLen);

        setTimeout(function () {
          if (self._stopped || !self._yuvRenderer) return;
          try {
            // drawNextOutputPicture({yData,uData,vData}) — first arg passed as `par`
            // to drawNextOuptutPictureGL(par); par.yData/uData/vData are the planes.
            self._yuvRenderer.drawNextOutputPicture({ yData: yData, uData: uData, vData: vData });
            drawContain(self._ctx, self._yuvCanvas, w, h, self._canvas.width, self._canvas.height);
            self._framesDrawn++;
          } catch (e) {
            self._lastFailure = 'WebGL render: ' + (e && e.message ? e.message : e);
            console.warn('[WasmDecoder] WebGL render error', e);
          }
        }, Math.max(0, delay));

      } else {
        // ── Software RGBA path (original) ───────────────────────────────────
        setTimeout(function () {
          if (self._stopped) return;
          try {
            if (!self._imgData || self._imgData.width !== w || self._imgData.height !== h) {
              self._imgData = new ImageData(w, h);
            }
            self._imgData.data.set(buf);

            if (self._canvas.width === w && self._canvas.height === h) {
              self._ctx.putImageData(self._imgData, 0, 0);
            } else {
              if (self._offscreen.width !== w || self._offscreen.height !== h) {
                self._offscreen.width  = w;
                self._offscreen.height = h;
              }
              self._offCtx.putImageData(self._imgData, 0, 0);
              drawContain(self._ctx, self._offscreen, w, h, self._canvas.width, self._canvas.height);
            }
            self._framesDrawn++;
          } catch (e) {
            self._lastFailure = 'RGBA render: ' + (e && e.message ? e.message : e);
            console.warn('[WasmDecoder] render error', e);
          }
        }, Math.max(0, delay));
      }
    };
  };

  // Snapshot for the on-screen diagnostic. Everything here is otherwise only
  // visible in a console, which a television does not offer.
  WasmDecoder.prototype.getStats = function () {
    return {
      decoded:   this._framesDecoded,
      drawn:     this._framesDrawn,
      mpdFails:  this._mpdFails,
      renderPath: this._useWebGL ? 'webgl' : 'rgba',
      lastFailure: this._lastFailure
    };
  };

  WasmDecoder.prototype.start = function (mpdUrl) {
    var self = this;
    self._stopped            = false;
    self._initFetched        = false;
    self._lastSegNum         = -1;
    self._mpdUrl             = mpdUrl;
    self._firstFrameReported = false;

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
        self._mpdFails = 0;   // recovered — stop reporting the old failure

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
          var masterT  = self._masterTime();

          if (masterT !== null && !masterInRange(masterT, parsed) && !self._warnedClock) {
            self._warnedClock = true;
            console.warn('[WasmDecoder] master clock', masterT.toFixed(2),
                         's is outside the manifest window',
                         parsed.segStartSec[0].toFixed(2), '-',
                         (parsed.segStartSec[parsed.segStartSec.length - 1] + parsed.segDurSec).toFixed(2),
                         's — different timelines, falling back to live-edge pacing');
          }

          if (parsed.isLive && masterInRange(masterT, parsed)) {
            // Follow the main video rather than the live edge. The main player
            // sits several seconds behind live, so chasing the edge here is
            // itself a source of offset.
            var wantIdx = 0;
            for (var wi = 0; wi < parsed.segStartSec.length; wi++) {
              if (parsed.segStartSec[wi] <= masterT) wantIdx = wi;
            }

            // Decode the segment *after* the one the master clock is inside,
            // not the one containing it. The containing segment has the master
            // somewhere in its middle, so every frame before that point is
            // already late and onPictureDecoded drops it. How much of the
            // segment survived depended on where the master happened to fall,
            // which is why the overlay played part of each segment and froze
            // for the rest — the hitch every few seconds. Position was never
            // the problem: the decoder held the same slot in the window for
            // twenty consecutive refreshes without once repositioning.
            //
            // One segment later, every frame is still in the future, so all of
            // them arrive with a positive delay and are shown in order. The
            // cost is up to four more seconds behind the main picture, which
            // does not show: the overlay is judged against that picture, and
            // the live delay holds both back together.
            var targetIdx = Math.min(wantIdx + 1, parsed.segStartSec.length - 1);

            var contIdx = (self._lastSegNum < 0)
              ? -1 : (self._lastSegNum + 1 - parsed.startNumber);

            if (contIdx < 0 || contIdx < targetIdx - 1 || contIdx > targetIdx + 2) {
              // Never started, fell out of the window, or wildly ahead: the only
              // way back is to jump and restart the worker.
              startIdx = targetIdx;
              if (self._lastSegNum >= 0) {
                console.log('[WasmDecoder] repositioning to master clock',
                            masterT.toFixed(2), 's — segment idx', targetIdx);
                self._ptsQueue.length = 0;
                self._createPlayer();
                self._initFetched = false;
              }
            } else if (contIdx >= urls.length || contIdx > targetIdx + LEAD_SEGS) {
              // Caught up with the live edge, or far enough ahead of the master
              // clock. Wait for more content instead of re-decoding what we have;
              // repositioning here is what made the decoder restart every refresh.
              setTimeout(function () {
                if (!self._stopped) self._fetchMPDAndDecode();
              }, Math.max(250, parsed.segDurSec * 250));
              return;
            } else {
              startIdx = contIdx;   // in step with the master clock, carry on
            }

          } else if (parsed.isLive) {
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
          return self._decodeSegments(pending, parsed.segDurSec,
                                      parsed.startNumber + startIdx,
                                      parsed.segStartSec[startIdx])
            .then(function () {
              if (self._stopped) return;

              // Segment-boundary lag check: compare wall-clock elapsed to how many
              // frames the worker has actually decoded.  If the worker is more than
              // one segment behind schedule (slow device / Broadway too slow), force
              // a live-edge jump on the next MPD fetch by resetting _lastSegNum.
              // Only meaningful without a master clock. When one is driving
              // playback, position is corrected against it on every refresh and
              // this wall-clock comparison would force needless jumps.
              if (parsed.isLive && masterT === null && self._playbackStart !== null) {
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
        // Retrying forever against a manifest that will never load looks exactly
        // like a decoder that is merely slow to start: an empty overlay, no
        // message. On a terminal there is no console to check, so say it on
        // screen once the retries stop being plausibly transient.
        self._mpdFails++;
        self._lastFailure = 'MPD: ' + (e && e.message ? e.message : e);
        if (self._mpdFails === 3 && typeof self.onError === 'function') {
          self.onError('Interpreter stream unavailable: ' + (e && e.message ? e.message : e) +
                       ' (' + self._mpdUrl + ')');
        }
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
  WasmDecoder.prototype._decodeNALsPaced = function (nals, segDurSec, segPtsSec) {
    var self = this;

    // Skip SEI NALs (type 6) — they produce no picture
    var filtered = nals.filter(function (nal) {
      return nal.length >= 5 && (nal[4] & 0x1F) !== 6;
    });

    // Queue the presentation time of each picture so onPictureDecoded can show
    // it against the master clock. Only picture NALs produce output.
    if (typeof segPtsSec === 'number' && isFinite(segPtsSec)) {
      var pi = 0;
      filtered.forEach(function (nal) {
        var t = nal[4] & 0x1F;
        if (t === 1 || t === 5) {
          self._ptsQueue.push(segPtsSec + pi * (FRAME_DUR_MS / 1000));
          pi++;
        }
      });
    }

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

  WasmDecoder.prototype._decodeSegments = function (urls, segDurSec, startSegNum, segPtsSec) {
    var self = this;
    if (self._stopped || urls.length === 0) return Promise.resolve();

    var url     = urls[0];
    var segNum  = startSegNum;
    var rest    = urls.slice(1);
    var nextPts = (segPtsSec == null) ? null : segPtsSec + segDurSec;

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
        return self._decodeNALsPaced(nals, segDurSec, segPtsSec);
      })
      .then(function () {
        return self._decodeSegments(rest, segDurSec, segNum + 1, nextPts);
      })
      .catch(function (e) {
        console.warn('[WasmDecoder] skip segment', segNum, e.message);
        return self._decodeSegments(rest, segDurSec, segNum + 1, nextPts);
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
