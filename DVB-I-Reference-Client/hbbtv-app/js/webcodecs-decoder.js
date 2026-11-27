(function (global) {
  'use strict';

  if (typeof VideoDecoder === 'undefined') {
    global.WebCodecsDecoder = null;
    return;
  }

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
    var doc    = parser.parseFromString(mpdText, 'application/xml');

    var mpdEl  = doc.querySelector('MPD');
    var isLive = (mpdEl && mpdEl.getAttribute('type') === 'dynamic');

    var videoAdapt = selectSignAdaptationSet(doc);

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
          return zeroPad(num, parseInt(w, 10));
        })
        .replace('$Number$', num);
    }

    var segCount, segStarts = [];
    if (isLive) {
      var timeline = seg.querySelector('SegmentTimeline');
      if (timeline) {
        var sList = timeline.getElementsByTagName('S');
        var ticks = 0;
        for (var si = 0; si < sList.length; si++) {
          var tAttr = sList[si].getAttribute('t');
          var d     = parseInt(sList[si].getAttribute('d') || '0', 10);
          var r     = parseInt(sList[si].getAttribute('r') || '0', 10);
          if (tAttr !== null) ticks = parseInt(tAttr, 10);
          for (var k = 0; k <= r; k++) { segStarts.push(ticks / timescale); ticks += d; }
        }
        segCount = segStarts.length || 10;
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

    if (!segStarts.length) {
      for (var j = 0; j < segCount; j++) segStarts.push(j * segDur / timescale);
    }

    return {
      initUrl:     resolve(initAttr, startNum),
      segmentUrls: segs,
      segStartSec: segStarts,
      segDurSec:   segDur / timescale,
      startNumber: startNum,
      isLive:      isLive,
      codecs:      codecs
    };
  }

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

  function codecFromAVCC(avcc) {
    if (!avcc || avcc.length < 4) return 'avc1.42001f';
    var hex = function (b) { return ('0' + b.toString(16)).slice(-2); };
    return 'avc1.' + hex(avcc[1]) + hex(avcc[2]) + hex(avcc[3]);
  }

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

  var FRAME_DUR_MS  = 40;
  var FRAME_DUR_US  = 40000;
  var LIVE_LAG_SEGS = 3;

  var LEAD_SEGS = 1;

  var RESYNC_TOLERANCE_SEC = 4;

  function WebCodecsDecoder(canvas, masterClock) {
    this._canvas        = canvas;
    this._ctx           = canvas.getContext('2d');
    this._decoder       = null;
    this._stopped       = false;
    this._initFetched   = false;
    this._lastSegNum    = -1;
    this._mpdUrl        = null;
    this._codec         = 'avc1.42001f';
    this._avcc          = null;
    this._nextTsUs      = 0;
    this._segPtsUs      = null;
    this._displayIdx    = 0;
    this._decodingStart = null;
    this._targetLagSegs = 0;
    this._decoderGen    = 0;
    this._masterClock   = typeof masterClock === 'function' ? masterClock : null;
    this._queue         = [];
    this._rafId         = null;
    this._loggedOffset  = false;
    this._firstFrameReported = false;
    this._framesDecoded = 0;
    this._framesDrawn   = 0;
    this._framesDropped = 0;
    this._lastSyncMs    = null;
    this._lastFailure   = null;
  }

  function masterInRange(masterT, parsed) {
    if (masterT === null || !parsed.segStartSec || !parsed.segStartSec.length) return false;
    var first = parsed.segStartSec[0] - parsed.segDurSec;
    var last  = parsed.segStartSec[parsed.segStartSec.length - 1] + 2 * parsed.segDurSec;
    return masterT >= first && masterT <= last;
  }

  WebCodecsDecoder.prototype._masterTime = function () {
    if (!this._masterClock) return null;
    var t = this._masterClock();
    return (typeof t === 'number' && isFinite(t) && t > 0) ? t : null;
  };

  WebCodecsDecoder.prototype._startPresenting = function () {
    var self = this;
    if (self._rafId !== null) return;

    function tick() {
      self._rafId = null;
      if (self._stopped) return;

      var now = self._masterTime();
      if (now !== null) {
        var due = null;
        while (self._queue.length && self._queue[0].ptsSec <= now) {
          if (due) {
            due.frame.close();
            self._framesDropped++;
          }
          due = self._queue.shift();
        }
        if (due) {
          if (!self._loggedOffset) {
            console.log('[WebCodecsDecoder] first synced frame: master', now.toFixed(2),
                        's, signer pts', due.ptsSec.toFixed(2), 's, offset',
                        (now - due.ptsSec).toFixed(2), 's');
            self._loggedOffset = true;
          }
          try {
            self._ctx.drawImage(due.frame, 0, 0, self._canvas.width, self._canvas.height);
            self._framesDrawn++;
            self._lastSyncMs = (now - due.ptsSec) * 1000;
          } catch (e) {
            self._lastFailure = 'draw: ' + (e && e.message ? e.message : e);
          }
          due.frame.close();
        }
        if (self._queue.length && self._queue[0].ptsSec > now + RESYNC_TOLERANCE_SEC) {
          self._flushQueue();
        }
      }
      self._rafId = requestAnimationFrame(tick);
    }
    self._rafId = requestAnimationFrame(tick);
  };

  WebCodecsDecoder.prototype._flushQueue = function () {
    for (var i = 0; i < this._queue.length; i++) {
      try { this._queue[i].frame.close(); } catch (e) {}
    }
    this._queue.length = 0;
  };

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
        self._framesDecoded++;

        if (!self._firstFrameReported) {
          self._firstFrameReported = true;
          if (typeof self.onFirstFrame === 'function') {
            self.onFirstFrame(frame.displayWidth  || frame.codedWidth,
                              frame.displayHeight || frame.codedHeight);
          }
        }

        if (self._masterTime() !== null) {
          self._queue.push({ ptsSec: frame.timestamp / 1e6, frame: frame });
          self._startPresenting();
          return;
        }

        var fi = self._displayIdx++;
        if (self._decodingStart === null) self._decodingStart = Date.now();
        var targetMs = self._decodingStart + fi * FRAME_DUR_MS;
        var delay    = Math.max(0, targetMs - Date.now());

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
              self._framesDrawn++;
            } catch (e) {
              self._lastFailure = 'draw: ' + (e && e.message ? e.message : e);
            }
          }
          frame.close();
        }, delay);
      },
      error: function (err) {
        self._lastFailure = 'decode: ' + (err && err.message ? err.message : err);
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

  WebCodecsDecoder.prototype.getStats = function () {
    return {
      decoded:     this._framesDecoded,
      drawn:       this._framesDrawn,
      dropped:     this._framesDropped,
      syncMs:      this._lastSyncMs,
      mpdFails:    0,
      renderPath:  'webcodecs',
      lastFailure: this._lastFailure
    };
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
          var masterT  = self._masterTime();

          if (masterT !== null && !masterInRange(masterT, parsed) && !self._warnedClock) {
            self._warnedClock = true;
            console.warn('[WebCodecsDecoder] master clock', masterT.toFixed(2),
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

            var contIdx = (self._lastSegNum < 0)
              ? -1 : (self._lastSegNum + 1 - parsed.startNumber);

            if (contIdx < 0 || contIdx < wantIdx - 1 || contIdx > wantIdx + 2) {
              startIdx = wantIdx;
              if (self._lastSegNum >= 0) {
                console.log('[WebCodecsDecoder] repositioning to master clock',
                            masterT.toFixed(2), 's — segment idx', wantIdx);
                self._flushQueue();
                self._createDecoder();
                self._configure();
              }
            } else if (contIdx >= urls.length || contIdx > wantIdx + LEAD_SEGS) {
              setTimeout(function () {
                if (!self._stopped) self._fetchMPDAndDecode();
              }, Math.max(250, parsed.segDurSec * 250));
              return;
            } else {
              startIdx = contIdx;
            }

          } else if (parsed.isLive) {
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
          return self._decodeSegments(pending, parsed.segDurSec,
                                      parsed.startNumber + startIdx,
                                      parsed.segStartSec[startIdx])
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

  WebCodecsDecoder.prototype._decodeSegments = function (urls, segDurSec, startSegNum, segPtsSec) {
    var self = this;
    if (self._stopped || urls.length === 0) return Promise.resolve();

    var url    = urls[0];
    var segNum = startSegNum;
    var rest   = urls.slice(1);
    var baseUs = (typeof segPtsSec === 'number' && isFinite(segPtsSec))
      ? Math.round(segPtsSec * 1e6) : null;
    var nextPts = (segPtsSec == null) ? null : segPtsSec + segDurSec;

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
        var frameInSeg = 0;

        nals.forEach(function (nal) {
          if (self._stopped || !self._decoder) return;

          var nalType = nal[4] & 0x1F;
          if (nalType === 6) return;
          if (nalType !== 1 && nalType !== 5) return;

          var ts;
          if (baseUs !== null) {
            ts = baseUs + frameInSeg * FRAME_DUR_US;
            frameInSeg++;
          } else {
            ts = self._nextTsUs;
            self._nextTsUs += FRAME_DUR_US;
          }

          try {
            self._decoder.decode(new EncodedVideoChunk({
              type:      (nalType === 5) ? 'key' : 'delta',
              timestamp: ts,
              data:      nal
            }));
          } catch (e) {
            console.warn('[WebCodecsDecoder] chunk error:', e.message);
          }
        });

        return new Promise(function (resolve) {
          setTimeout(resolve, segDurSec * 1000);
        });
      })
      .then(function () {
        return self._decodeSegments(rest, segDurSec, segNum + 1, nextPts);
      })
      .catch(function (e) {
        console.warn('[WebCodecsDecoder] skip segment', segNum, e.message);
        return self._decodeSegments(rest, segDurSec, segNum + 1, nextPts);
      });
  };

  WebCodecsDecoder.prototype.stop = function () {
    this._stopped = true;
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._flushQueue();
    if (this._decoder) {
      try { this._decoder.close(); } catch (e) {}
      this._decoder = null;
    }
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  };

  WebCodecsDecoder.isSupported = function (codec) {
    codec = codec || 'avc1.42001f';
    if (typeof VideoDecoder === 'undefined') return Promise.resolve(false);
    return VideoDecoder.isConfigSupported({ codec: codec, optimizeForLatency: true })
      .then(function (s) { return s.supported === true; })
      .catch(function ()  { return false; });
  };

  global.WebCodecsDecoder = WebCodecsDecoder;

})(window);
