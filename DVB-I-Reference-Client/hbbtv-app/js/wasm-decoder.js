(function (global) {
  'use strict';

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
    var names = ['Role', 'Accessibility'], i, j, els;
    for (i = 0; i < names.length; i++) {
      els = a.getElementsByTagName(names[i]);
      for (j = 0; j < els.length; j++) {
        if (els[j].getAttribute('value') === 'sign') return true;
      }
    }
    return false;
  }

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

    var segCount, segStarts = [];
    if (isLive) {
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
        segCount = 10;
      }
    } else {
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
          var o = pos + 8;
          o += 5;
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
          return;
        }

        if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
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
    return nals;
  }

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

  var FRAME_DUR_MS = 40;

  var LIVE_LAG_SEGS = 3;

  var LEAD_SEGS = 1;

  var LATE_FRAME_TOLERANCE_MS = 60;

  function WasmDecoder(canvas, masterClock) {
    this._masterClock = typeof masterClock === 'function' ? masterClock : null;
    this._ptsQueue    = [];
    this._loggedOffset = false;
    this._canvas      = canvas;
    this._ctx         = canvas.getContext('2d');
    this._player      = null;
    this._stopped     = false;
    this._initFetched = false;
    this._mpdFails    = 0;
    this._lastSegNum  = -1;
    this._framesDecoded = 0;
    this._framesDrawn   = 0;
    this._framesDropped = 0;
    this._lastSyncMs    = null;
    this._lastFailure   = null;
    this._forceNoWebGL  = false;
    this._mpdUrl      = null;
    this._offscreen   = document.createElement('canvas');
    this._offCtx      = this._offscreen.getContext('2d');
    this._imgData     = null;
    this._globalFrameIdx  = 0;
    this._playbackStart   = null;
    this._targetLagSegs   = 0;
    this._playerGen       = 0;
    this._useWebGL    = false;
    this._yuvCanvas   = null;
    this._yuvRenderer = null;
  }

  WasmDecoder.CHROMA_KEY  = { u: 96, v: 55, similarity: 0.03, blend: 0.15 };
  WasmDecoder.chromaKeyOn = true;

  function masterInRange(masterT, parsed) {
    if (masterT === null || !parsed.segStartSec || !parsed.segStartSec.length) return false;
    var first = parsed.segStartSec[0] - parsed.segDurSec;
    var last  = parsed.segStartSec[parsed.segStartSec.length - 1] + 2 * parsed.segDurSec;
    return masterT >= first && masterT <= last;
  }

  WasmDecoder.prototype._masterTime = function () {
    if (!this._masterClock) return null;
    var t = this._masterClock();
    return (typeof t === 'number' && isFinite(t) && t > 0) ? t : null;
  };

  function drawContain(ctx, src, srcW, srcH, dstW, dstH) {
    var scale = Math.min(dstW / srcW, dstH / srcH);
    var x = (dstW - srcW * scale) / 2 | 0;
    var y = (dstH - srcH * scale) / 2 | 0;
    ctx.clearRect(0, 0, dstW, dstH);
    ctx.drawImage(src, x, y, srcW * scale | 0, srcH * scale | 0);
  }

  WasmDecoder.prototype._createPlayer = function () {
    var self = this;

    if (self._player && self._player.worker) {
      try { self._player.worker.terminate(); } catch (e) {}
    }
    self._player = null;

    self._globalFrameIdx  = 0;
    self._playbackStart   = null;
    self._ptsQueue.length = 0;
    self._imgData         = null;
    self._yuvCanvas       = null;
    self._yuvRenderer     = null;
    self._playerGen++;
    var myGen = self._playerGen;

    self._player = new Player({
      useWorker:      true,
      workerFile:     'js/broadway-decoder.js',
      webgl:          self._forceNoWebGL ? false : 'auto',
      render:         false,
      transferMemory: true,
      size:           { width: 1, height: 1 }
    });

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
        if (delay < -LATE_FRAME_TOLERANCE_MS) { self._framesDropped++; return; }
        if (delay < 0) { delay = 0; }
      } else {
        var targetMs = self._playbackStart + fi * FRAME_DUR_MS;
        delay = Math.max(0, targetMs - Date.now());
      }

      var w = width, h = height;

      if (self._useWebGL) {
        if (!self._yuvRenderer || self._yuvCanvas.width !== w || self._yuvCanvas.height !== h) {
          self._yuvCanvas          = document.createElement('canvas');
          self._yuvCanvas.width    = w;
          self._yuvCanvas.height   = h;
          self._yuvRenderer        = new YUVCanvas({ canvas: self._yuvCanvas, width: w, height: h });
          if (!self._yuvRenderer.isWebGL()) {
            console.warn('[WasmDecoder] YUVCanvas WebGL init failed — ' +
                         'restarting the worker in software RGBA mode');
            self._yuvRenderer  = null;
            self._forceNoWebGL = true;
            self._createPlayer();
            self._initFetched  = false;
            return;
          }
        }

        var yLen  = w * h;
        var uvLen = (w >> 1) * (h >> 1);
        var yData = buf.subarray(0, yLen);
        var uData = buf.subarray(yLen, yLen + uvLen);
        var vData = buf.subarray(yLen + uvLen, yLen + uvLen + uvLen);

        setTimeout(function () {
          if (self._stopped || !self._yuvRenderer) return;
          try {
            self._yuvRenderer.setChromaKey(WasmDecoder.chromaKeyOn, WasmDecoder.CHROMA_KEY);
            self._yuvRenderer.drawNextOutputPicture({ yData: yData, uData: uData, vData: vData });
            drawContain(self._ctx, self._yuvCanvas, w, h, self._canvas.width, self._canvas.height);
            self._framesDrawn++;
            if (ptsSec !== null) {
              var m = self._masterTime();
              if (m !== null) { self._lastSyncMs = (m - ptsSec) * 1000; }
            }
          } catch (e) {
            self._lastFailure = 'WebGL render: ' + (e && e.message ? e.message : e);
            console.warn('[WasmDecoder] WebGL render error', e);
          }
        }, Math.max(0, delay));

      } else {
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
            if (ptsSec !== null) {
              var m = self._masterTime();
              if (m !== null) { self._lastSyncMs = (m - ptsSec) * 1000; }
            }
          } catch (e) {
            self._lastFailure = 'RGBA render: ' + (e && e.message ? e.message : e);
            console.warn('[WasmDecoder] render error', e);
          }
        }, Math.max(0, delay));
      }
    };
  };

  WasmDecoder.prototype.getStats = function () {
    return {
      decoded:    this._framesDecoded,
      drawn:      this._framesDrawn,
      dropped:    this._framesDropped,
      syncMs:     this._lastSyncMs,
      mpdFails:   this._mpdFails,
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

    var cycleStart = Date.now();

    fetch(self._mpdUrl)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        if (self._stopped) return;
        var parsed = parseMPD(text, self._mpdUrl);
        self._mpdFails = 0;

        console.log('[WasmDecoder] MPD parsed — live:', parsed.isLive, 'segments:', parsed.segmentUrls.length, 'startNum:', parsed.startNumber);

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
            var wantIdx = 0;
            for (var wi = 0; wi < parsed.segStartSec.length; wi++) {
              if (parsed.segStartSec[wi] <= masterT) wantIdx = wi;
            }

            var targetIdx = Math.min(wantIdx + 1, parsed.segStartSec.length - 1);

            var contIdx = (self._lastSegNum < 0)
              ? -1 : (self._lastSegNum + 1 - parsed.startNumber);

            if (contIdx < 0 || contIdx < targetIdx - 1 || contIdx > targetIdx + 2) {
              startIdx = targetIdx;
              if (self._lastSegNum >= 0) {
                console.log('[WasmDecoder] repositioning to master clock',
                            masterT.toFixed(2), 's — segment idx', targetIdx);
                self._ptsQueue.length = 0;
                self._createPlayer();
                self._initFetched = false;
              }
            } else if (contIdx >= urls.length || contIdx > targetIdx + LEAD_SEGS) {
              setTimeout(function () {
                if (!self._stopped) self._fetchMPDAndDecode();
              }, Math.max(250, parsed.segDurSec * 250));
              return;
            } else {
              startIdx = contIdx;
            }

          } else if (parsed.isLive) {
            var liveEdge = parsed.startNumber + urls.length - 1;
            if (self._targetLagSegs === 0) {
              self._targetLagSegs = LIVE_LAG_SEGS;
            }

            if (self._lastSegNum < 0) {
              startIdx = Math.max(0, urls.length - 1 - self._targetLagSegs);
              console.log('[WasmDecoder] live start: idx', startIdx, 'seg', parsed.startNumber + startIdx, '(target lag', self._targetLagSegs, 'segs)');
            } else {
              var nextSeg = self._lastSegNum + 1;
              if (liveEdge - nextSeg > self._targetLagSegs) {
                console.log('[WasmDecoder] behind by', liveEdge - nextSeg, 'segs (target', self._targetLagSegs, ') — jumping, restarting player');
                startIdx = Math.max(0, urls.length - 1 - self._targetLagSegs);
                self._createPlayer();
                self._initFetched = false;
              } else {
                startIdx = Math.max(0, nextSeg - parsed.startNumber);
              }
            }
          }

          var pending = urls.slice(startIdx, startIdx + 1);
          return self._decodeSegments(pending, parsed.segDurSec,
                                      parsed.startNumber + startIdx,
                                      parsed.segStartSec[startIdx],
                                      cycleStart)
            .then(function () {
              if (self._stopped) return;

              if (parsed.isLive && masterT === null && self._playbackStart !== null) {
                var elapsed   = Date.now() - self._playbackStart;
                var decodedMs = self._globalFrameIdx * FRAME_DUR_MS;
                var lagMs     = elapsed - decodedMs;
                if (lagMs > parsed.segDurSec * 1000) {
                  console.log('[WasmDecoder] decode lag', Math.round(lagMs), 'ms — will jump to live edge');
                  self._lastSegNum  = -1;
                  self._createPlayer();
                  self._initFetched = false;
                }
              }

              if (parsed.isLive) self._fetchMPDAndDecode();
            });
        });
      })
      .catch(function (e) {
        console.error('[WasmDecoder] MPD error:', e);
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

  WasmDecoder.prototype._decodeNALsPaced = function (nals, segDurSec, segPtsSec, cycleStartMs) {
    var self = this;

    var filtered = nals.filter(function (nal) {
      return nal.length >= 5 && (nal[4] & 0x1F) !== 6;
    });

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

    filtered.forEach(function (nal) {
      if (!self._stopped) self._player.decode(nal);
    });

    var waitMs;
    var master = self._masterTime();
    if (master !== null && typeof segPtsSec === 'number' && isFinite(segPtsSec)) {
      waitMs = (segPtsSec - master) * 1000;
    } else {
      var elapsed = typeof cycleStartMs === 'number' ? Date.now() - cycleStartMs : 0;
      waitMs = segDurSec * 1000 - elapsed;
    }
    waitMs = Math.max(0, Math.min(waitMs, segDurSec * 1000));

    return new Promise(function (resolve) {
      setTimeout(resolve, waitMs);
    });
  };

  WasmDecoder.prototype._decodeSegments = function (urls, segDurSec, startSegNum, segPtsSec, cycleStartMs) {
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
        return self._decodeNALsPaced(nals, segDurSec, segPtsSec, cycleStartMs);
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
