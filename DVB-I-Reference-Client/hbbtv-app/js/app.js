(function () {
  'use strict';

  var mainVideo         = document.getElementById('mainVideo');
  var interpreterVideo  = document.getElementById('interpreterVideo');
  var interpreterCanvas = document.getElementById('interpreterCanvas');
  var subtitleEl        = document.getElementById('subtitles');
  var overlay           = document.getElementById('interpreterOverlay');

  var decoderMode           = 'canvas';
  var wasmDecoder           = null;
  var videoCanvasRafId      = null;
  var mainDashPlayer        = null;
  var interpreterDashPlayer = null;
  var currentMainUrl        = '';
  var currentInterpreterUrl = '';
  var interpreterOnlyMode   = false;
  var terminalPresentsMain  = false;
  var mediaSync             = null;
  var appPresentsMain       = false;

  var interpreterVisible = true;

  var POS_GRID = [
    ['tl', 'tc', 'tr'],
    ['ml', 'mc', 'mr'],
    ['bl', 'bc', 'br']
  ];
  var POS_LABELS = {
    tl: 'Zgoraj levo',  tc: 'Zgoraj sredina',  tr: 'Zgoraj desno',
    ml: 'Sredina levo', mc: 'Sredina',         mr: 'Sredina desno',
    bl: 'Spodaj levo',  bc: 'Spodaj sredina',  br: 'Spodaj desno'
  };
  var posRow = 2;
  var posCol = 2;

  var SIZE_WIDTHS    = [10, 15, 20, 27, 35, 44, 50];
  var DEFAULT_SIZE_IDX = 3;
  var sizeIdx        = DEFAULT_SIZE_IDX;
  var videoRatio     = 3 / 4;

  var LAYOUT_TRANSPARENT = 0;
  var LAYOUT_GREY        = 1;
  var LAYOUT_OVERLAP     = 2;
  var LAYOUT_SIDE        = 3;
  var LAYOUT_LABELS = ['Prosojno ozadje', 'Sivo ozadje', 'Tolmač čez sliko', 'Tolmač ob sliki'];
  var layoutMode    = LAYOUT_TRANSPARENT;

  var OVERLAP_STEPS = [
    { main: 90, signer: 0.60 },
    { main: 87, signer: 0.70 },
    { main: 84, signer: 0.80 },
    { main: 81, signer: 0.90 },
    { main: 78, signer: 1.00 }
  ];
  var SIDE_STEPS    = [80, 74, 68, 62, 56];
  var splitIdx      = 2;
  var MAIN_RATIO    = 9 / 16;

  var toastTimer = null;
  var interpreterLoading = false;
  var loadingPoll = null;
  var LOADING_MSG = 'Nalaganje tolmača...';
  var hintTimer  = null;
  var HINT_SHOW_MS = 30000;

  var LIVE_DELAY_SEC = 12;

  function getUrlParams() {
    var params = {};
    var q = window.location.search ? window.location.search.slice(1) : '';
    q.split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i >= 0) {
        var k = decodeURIComponent(pair.slice(0, i)).toLowerCase();
        var v = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        if (k === 'main' || k === 'interpreter') { params[k] = v; }
      }
    });
    return params;
  }

  function createDashPlayer(videoEl, url, autoplay) {
    if (typeof dashjs === 'undefined') {
      videoEl.src = url;
      if (autoplay) { safePlay(videoEl); }
      return null;
    }
    var p = dashjs.MediaPlayer().create();
    p.on(dashjs.MediaPlayer.events.ERROR, function (e) {
      var msg = (e && e.error && (e.error.message || JSON.stringify(e.error))) || 'dash.js error';
      showError('DASH error: ' + msg);
    });

    try {
      p.updateSettings({ streaming: {
        delay:     { liveDelay: LIVE_DELAY_SEC },
        liveDelay: LIVE_DELAY_SEC
      }});
    } catch (e) {}

    p.initialize(videoEl, url, autoplay);
    return p;
  }

  function destroyDashPlayer(player) {
    if (player) { try { player.destroy(); } catch (e) {} }
    return null;
  }

  function initSources() {
    var urlParams = getUrlParams();
    var COMBINED_MPD = 'http://localhost:9080/stream/live/prenosniki/stream.mpd';
    var mainUrl   = urlParams.main        || COMBINED_MPD;
    var interpUrl = urlParams.interpreter || COMBINED_MPD;

    interpreterOnlyMode   = !!(urlParams.interpreter && !urlParams.main);
    currentMainUrl        = mainUrl;
    currentInterpreterUrl = interpUrl;

    mainDashPlayer        = destroyDashPlayer(mainDashPlayer);
    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }

    terminalPresentsMain = HbbTV.bindToCurrentChannel();
    if (terminalPresentsMain) {
      console.log('[App] bound to the terminal\'s channel — overlay only');
      if (!mediaSync) {
        HbbTV.startTimelineClock(currentInterpreterUrl, function (ms) { mediaSync = ms; });
      }
    }

    appPresentsMain = !interpreterOnlyMode && !terminalPresentsMain &&
                      (!HbbTV.isHbbTV || !!urlParams.main);
    if (appPresentsMain) {
      mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
    } else {
      mainVideo.style.display = 'none';
    }

    var overlayOnly = noMainToAwait();
    document.documentElement.classList.toggle('overlay-mode', overlayOnly);
    document.body.classList.toggle('overlay-mode', overlayOnly);

    applyDecoderMode(decoderMode);
    clearError();
  }

  function noMainToAwait() {
    return !appPresentsMain;
  }

  function stopVideoCanvas() {
    if (videoCanvasRafId) { cancelAnimationFrame(videoCanvasRafId); videoCanvasRafId = null; }
  }

  function drawContain(ctx, src, srcW, srcH, dstW, dstH) {
    var scale = Math.min(dstW / srcW, dstH / srcH);
    var w = srcW * scale, h = srcH * scale;
    ctx.clearRect(0, 0, dstW, dstH);
    ctx.drawImage(src, ((dstW - w) / 2) | 0, ((dstH - h) / 2) | 0, w, h);
  }

  function applyDecoderMode(mode) {
    decoderMode = mode;
    setInterpreterLoading(interpreterVisible && !!currentInterpreterUrl);

    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }
    stopVideoCanvas();
    interpreterVideo.pause();

    if (mode === 'webcodecs') {
      interpreterVideo.style.display = 'none';
      interpreterCanvas.style.display = 'block';

      if (!noMainToAwait() && currentMainUrl && !mainDashPlayer) {
        mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
      }
      if (!window.WebCodecsDecoder) {
        applyDecoderMode('canvas');
        return;
      }
      var startWC = function () {
        mainVideo.removeEventListener('playing', startWC);
        if (decoderMode !== 'webcodecs') { return; }
        whenMasterReady(function () {
          if (decoderMode !== 'webcodecs') { return; }
          if (currentInterpreterUrl && !wasmDecoder) {
            wasmDecoder = new WebCodecsDecoder(interpreterCanvas, masterClock);
            wasmDecoder.onFirstFrame = function (w, h) { adaptToVideoRatio(w, h); };
            wasmDecoder.onError = onInterpreterError;
            wasmDecoder.start(currentInterpreterUrl);
          }
        });
      };
      if (noMainToAwait() || !mainVideo.paused) { startWC(); }
      else { mainVideo.addEventListener('playing', startWC); }
      return;
    }

    if (mode === 'video-canvas') {
      interpreterVideo.style.display = 'none';
      interpreterCanvas.style.display = 'block';

      if (!noMainToAwait() && currentMainUrl && !mainDashPlayer) {
        mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
      }
      var startVC = function () {
        mainVideo.removeEventListener('playing', startVC);
        if (decoderMode !== 'video-canvas' || !currentInterpreterUrl) { return; }
        interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
        var ctx = interpreterCanvas.getContext('2d');
        var fallbackT = setTimeout(function () {
          if (decoderMode === 'video-canvas' && interpreterVideo.videoWidth === 0) {
            applyDecoderMode('canvas');
          }
        }, 6000);
        function rafLoop() {
          if (decoderMode !== 'video-canvas') { return; }
          if (interpreterVideo.readyState >= 2 && interpreterVideo.videoWidth > 0) {
            clearTimeout(fallbackT);
            drawContain(ctx, interpreterVideo,
              interpreterVideo.videoWidth, interpreterVideo.videoHeight,
              interpreterCanvas.width, interpreterCanvas.height);
          }
          videoCanvasRafId = requestAnimationFrame(rafLoop);
        }
        videoCanvasRafId = requestAnimationFrame(rafLoop);
      };
      if (noMainToAwait() || !mainVideo.paused) { startVC(); }
      else { mainVideo.addEventListener('playing', startVC); }
      return;
    }

    if (mode === 'canvas') {
      interpreterVideo.pause();
      interpreterVideo.style.display = 'none';
      interpreterCanvas.style.display = 'block';

      if (!noMainToAwait() && currentMainUrl && !mainDashPlayer) {
        mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
      }
      var startCanvas = function () {
        mainVideo.removeEventListener('playing', startCanvas);
        if (decoderMode !== 'canvas') { return; }
        whenMasterReady(function () {
          if (decoderMode !== 'canvas') { return; }
          if (currentInterpreterUrl && !wasmDecoder) {
            wasmDecoder = new WasmDecoder(interpreterCanvas, masterClock);
            wasmDecoder.onFirstFrame = function (w, h) { adaptToVideoRatio(w, h); };
            wasmDecoder.onError = onInterpreterError;
            wasmDecoder.start(currentInterpreterUrl);
          }
        });
      };
      if (noMainToAwait() || !mainVideo.paused) { startCanvas(); }
      else { mainVideo.addEventListener('playing', startCanvas); }
      return;
    }

    interpreterCanvas.style.display = 'none';
    interpreterVideo.style.display  = 'block';

    var startNative = function () {
      mainVideo.removeEventListener('playing', startNative);
      if (decoderMode !== 'native') { return; }
      if (currentInterpreterUrl && !interpreterDashPlayer) {
        interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
      }
    };
    if (noMainToAwait() || !mainVideo.paused) { startNative(); }
    else { mainVideo.addEventListener('playing', startNative); }
  }

  var hostVideo = null;
  var warnedNoHostClock = false;

  function warnNoHostClock(reason) {
    if (warnedNoHostClock) { return; }
    warnedNoHostClock = true;
    console.warn('[App] no host video clock (' + reason + ') — the interpreter ' +
                 'will pace itself against the live edge and drift from the main picture');
  }

  function findHostVideo() {
    if (window.parent === window) { return null; }
    try {
      var doc = window.parent.document;
      var v = doc.getElementById('video') ||
              doc.getElementsByTagName('video')[0] || null;
      if (v) { console.log('[App] host video clock acquired'); }
      else   { warnNoHostClock('host page has no video element'); }
      return v;
    } catch (e) {
      warnNoHostClock('host page is cross-origin: ' + e.message);
      return null;
    }
  }

  function hostVideoTime() {
    if (!hostVideo || !hostVideo.parentNode) { hostVideo = findHostVideo(); }
    if (!hostVideo) { return 0; }
    try {
      var t = hostVideo.currentTime;
      return (typeof t === 'number' && isFinite(t)) ? t : 0;
    } catch (e) {
      hostVideo = null;
      return 0;
    }
  }

  function masterClock() {
    if (terminalPresentsMain) { return mediaSync ? (mediaSync.currentTime || 0) : 0; }
    if (!interpreterOnlyMode && mainVideo) { return mainVideo.currentTime || 0; }
    return hostVideoTime();
  }

  function safePlay(videoEl, onSuccess, onError) {
    var result;
    try { result = videoEl.play(); } catch (e) { if (onError) { onError(e); } return; }
    if (result && typeof result.then === 'function') {
      result.then(onSuccess || function () {}).catch(onError || function () {});
    } else {
      if (onSuccess) { onSuccess(); }
    }
  }

  function showToast(msg) {
    var el = document.getElementById('toast');
    if (!el) { return; }
    el.textContent = msg;
    el.style.display = 'block';
    placeToast(el);
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (interpreterLoading) { el.textContent = LOADING_MSG; placeToast(el); }
      else { el.style.display = 'none'; }
    }, 1500);
  }

  function placeToast(el) {
    el.classList.remove('toast-left');
    if (!interpreterVisible) { return; }
    var t = el.getBoundingClientRect();
    var o = overlay.getBoundingClientRect();
    var overlaps = t.left < o.right && t.right > o.left &&
                   t.top < o.bottom && t.bottom > o.top;
    if (overlaps) { el.classList.add('toast-left'); }
  }

  function setInterpreterLoading(on) {
    interpreterLoading = on;
    if (loadingPoll) { clearInterval(loadingPoll); loadingPoll = null; }
    if (on) {
      loadingPoll = setInterval(function () {
        var stats = (wasmDecoder && typeof wasmDecoder.getStats === 'function')
          ? wasmDecoder.getStats() : null;
        if (stats && stats.drawn > 0) { setInterpreterLoading(false); }
      }, 100);
    }
    if (toastTimer) { return; }
    var el = document.getElementById('toast');
    if (!el) { return; }
    if (on) { el.textContent = LOADING_MSG; el.style.display = 'block'; placeToast(el); }
    else { el.style.display = 'none'; }
  }

  function onInterpreterError(msg) {
    setInterpreterLoading(false);
    showError(msg);
  }

  function showHintBar() {
    var el = document.getElementById('hintBar');
    if (!el) { return; }
    el.classList.remove('faded');
    if (hintTimer) { clearTimeout(hintTimer); }
    hintTimer = setTimeout(function () {
      el.classList.add('faded');
      hintTimer = null;
    }, HINT_SHOW_MS);
  }

  function setPositionClass(pos) {
    overlay.classList.remove(
      'interpreter-position-tl', 'interpreter-position-tc', 'interpreter-position-tr',
      'interpreter-position-ml', 'interpreter-position-mc', 'interpreter-position-mr',
      'interpreter-position-bl', 'interpreter-position-bc', 'interpreter-position-br'
    );
    overlay.classList.add('interpreter-position-' + pos);
    var toast = document.getElementById('toast');
    if (toast && toast.style.display === 'block') { placeToast(toast); }
  }

  function applyPosition(announce) {
    var pos = POS_GRID[posRow][posCol];
    setPositionClass(pos);
    if (announce !== false) { showToast(POS_LABELS[pos]); }
  }

  function applySize(announce) {
    if (isSplitLayout()) {
      applySplit();
      if (announce) { showToast('Razmerje ' + (splitIdx + 1) + ' / ' + SIDE_STEPS.length); }
      return;
    }
    var w = SIZE_WIDTHS[sizeIdx];
    overlay.style.width  = w + 'vw';
    overlay.style.height = (w * videoRatio).toFixed(3) + 'vw';
    if (announce) { showToast('Velikost ' + (sizeIdx + 1) + ' / ' + SIZE_WIDTHS.length); }
  }

  function adaptToVideoRatio(srcW, srcH) {
    if (!srcW || !srcH) { return; }
    videoRatio = srcH / srcW;
    interpreterCanvas.width  = srcW;
    interpreterCanvas.height = srcH;
    applySize();
  }

  function isSplitLayout() {
    return layoutMode === LAYOUT_OVERLAP || layoutMode === LAYOUT_SIDE;
  }

  function applyLayout() {
    overlay.classList.toggle('grey-bg', layoutMode === LAYOUT_GREY);
    if (isSplitLayout()) { setPositionClass('br'); }
    else { applyPosition(false); }
    applySize();
    if (!isSplitLayout()) { applySplit(); }
    showToast(LAYOUT_LABELS[layoutMode]);
  }

  function applySplit() {
    var split = isSplitLayout() && interpreterVisible;
    var hint = document.getElementById('hintBar');
    if (hint) { hint.classList.toggle('pinned', split); }
    if (!split) {
      setMainRect(null, null);
      setGreyFrame(null, null);
      setSubtitleRect(null, null);
      return;
    }
    var sw = window.innerWidth, sh = window.innerHeight;
    var mainW, sigW, sigH;
    if (layoutMode === LAYOUT_OVERLAP) {
      mainW = sw * OVERLAP_STEPS[splitIdx].main / 100;
      sigH  = sh * OVERLAP_STEPS[splitIdx].signer;
      sigW  = sigH / videoRatio;
      if (sigW > sw) { sigW = sw; sigH = sigW * videoRatio; }
    } else {
      mainW = sw * SIDE_STEPS[splitIdx] / 100;
      sigW  = sw - mainW;
      sigH  = sigW * videoRatio;
      if (sigH > sh) { sigH = sh; sigW = sigH / videoRatio; }
    }
    var mainH = Math.min(mainW * MAIN_RATIO, sh);
    mainW = Math.round(mainW);
    mainH = Math.round(mainH);
    overlay.style.width  = Math.round(sigW) + 'px';
    overlay.style.height = Math.round(sigH) + 'px';
    setMainRect(mainW, mainH);
    setGreyFrame(mainW, mainH);
    setSubtitleRect(mainW, mainH);
  }

  window.addEventListener('resize', function () {
    if (isSplitLayout()) { applySplit(); }
  });

  function setGreyFrame(w, h) {
    var right  = document.getElementById('greyRight');
    var bottom = document.getElementById('greyBottom');
    if (!right || !bottom) { return; }
    if (w == null || !(appPresentsMain || terminalPresentsMain)) {
      right.style.display = bottom.style.display = 'none';
      return;
    }
    right.style.left    = w + 'px';
    bottom.style.top    = h + 'px';
    bottom.style.width  = w + 'px';
    right.style.display = bottom.style.display = 'block';
  }

  function setMainRect(w, h) {
    var width  = w == null ? '100%' : w + 'px';
    var height = h == null ? '100%' : h + 'px';
    if (appPresentsMain) {
      mainVideo.style.width  = width;
      mainVideo.style.height = height;
    } else if (terminalPresentsMain) {
      var bc = document.getElementById('broadcastVideo');
      if (bc) { bc.style.width = width; bc.style.height = height; }
    } else {
      setHostVideoRect(w == null ? null : width, height);
    }
  }

  var hostVideoCss = null;
  var hostBoxBg    = null;

  function setHostVideoRect(width, height) {
    if (!hostVideo || !hostVideo.parentNode) { hostVideo = findHostVideo(); }
    if (!hostVideo) { return; }
    var box = hostVideo.parentNode;
    try {
      if (width == null) {
        if (hostVideoCss !== null) { hostVideo.style.cssText = hostVideoCss; hostVideoCss = null; }
        if (hostBoxBg !== null) { box.style.background = hostBoxBg; hostBoxBg = null; }
        return;
      }
      if (hostVideoCss === null) { hostVideoCss = hostVideo.style.cssText; }
      if (hostBoxBg === null) { hostBoxBg = box.style.background; }
      box.style.background = '#808080';
      hostVideo.style.cssText = hostVideoCss +
        ';position:fixed;left:0;top:0;max-width:none;max-height:none' +
        ';width:' + width + ';height:' + height;
    } catch (e) {
      console.warn('[App] could not resize the host video:', e && e.message);
    }
  }

  function restoreHostVideo() { if (hostVideoCss !== null) { setHostVideoRect(null, null); } }
  window.addEventListener('pagehide', restoreHostVideo);
  window.addEventListener('unload', restoreHostVideo);

  function setSubtitleRect(w, h) {
    if (!subtitleEl) { return; }
    var s = subtitleEl.style;
    if (w == null) { s.left = s.right = s.bottom = s.fontSize = ''; return; }
    s.left     = Math.round(w * 0.1) + 'px';
    s.right    = Math.round(window.innerWidth - w * 0.9) + 'px';
    s.bottom   = Math.round(window.innerHeight - h * 0.9) + 'px';
    s.fontSize = Math.round(w * 0.032) + 'px';
  }

  var MASTER_WAIT_MS = 5000;
  var masterWaitGen  = 0;

  function whenMasterReady(fn) {
    var gen = ++masterWaitGen;
    var waited = 0;
    (function check() {
      if (gen !== masterWaitGen) { return; }
      if (masterClock() > 0 || waited >= MASTER_WAIT_MS) { fn(); return; }
      waited += 100;
      setTimeout(check, 100);
    })();
  }

  function stopInterpreterDecoder() {
    masterWaitGen++;
    setInterpreterLoading(false);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }
    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    stopVideoCanvas();
    interpreterVideo.pause();
  }

  function startInterpreterDecoder() {
    if (!currentInterpreterUrl) { return; }
    stopInterpreterDecoder();
    setInterpreterLoading(true);

    if (decoderMode === 'canvas') {
      whenMasterReady(function () {
        wasmDecoder = new WasmDecoder(interpreterCanvas, masterClock);
        wasmDecoder.onFirstFrame = function (w, h) { adaptToVideoRatio(w, h); };
        wasmDecoder.onError = onInterpreterError;
        wasmDecoder.start(currentInterpreterUrl);
      });

    } else if (decoderMode === 'webcodecs') {
      if (window.WebCodecsDecoder) {
        whenMasterReady(function () {
          wasmDecoder = new WebCodecsDecoder(interpreterCanvas, masterClock);
          wasmDecoder.onFirstFrame = function (w, h) { adaptToVideoRatio(w, h); };
          wasmDecoder.onError = onInterpreterError;
          wasmDecoder.start(currentInterpreterUrl);
        });
      }

    } else if (decoderMode === 'video-canvas') {
      interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
      var ctx = interpreterCanvas.getContext('2d');
      function rafLoop() {
        if (decoderMode !== 'video-canvas') { return; }
        var cw = interpreterCanvas.width;
        var ch = interpreterCanvas.height;
        if (interpreterVideo.readyState >= 2 && interpreterVideo.videoWidth > 0) {
          drawContain(ctx, interpreterVideo,
            interpreterVideo.videoWidth, interpreterVideo.videoHeight, cw, ch);
        }
        videoCanvasRafId = requestAnimationFrame(rafLoop);
      }
      videoCanvasRafId = requestAnimationFrame(rafLoop);

    } else {
      interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
    }
  }

  function toggleInterpreter() {
    interpreterVisible = !interpreterVisible;
    if (interpreterVisible) {
      overlay.classList.remove('hidden');
      startInterpreterDecoder();
      showToast('Tolmač VKLOPLJEN');
    } else {
      overlay.classList.add('hidden');
      stopInterpreterDecoder();
      showToast('Tolmač IZKLOPLJEN');
    }
    var hint = document.getElementById('hintBar');
    if (hint) { hint.classList.toggle('signer-off', !interpreterVisible); }
    if (isSplitLayout()) { applySplit(); }
  }

  function showError(msg) {
    var el = document.getElementById('errorOverlay');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function clearError() {
    var el = document.getElementById('errorOverlay');
    if (el) { el.style.display = 'none'; }
  }

  var diagEl = null;
  var diagForced = false;

  var fpsPrev = { t: 0, decoded: null, drawn: null, main: null };
  var fpsLine = 'fps  main=-  interp=-';

  function videoFrameTotal(el) {
    if (!el) { return null; }
    try {
      if (typeof el.getVideoPlaybackQuality === 'function') {
        var q = el.getVideoPlaybackQuality();
        if (q && typeof q.totalVideoFrames === 'number') { return q.totalVideoFrames; }
      }
      if (typeof el.webkitDecodedFrameCount === 'number') {
        return el.webkitDecodedFrameCount;
      }
    } catch (e) {}
    return null;
  }

  function fpsRate(curr, prev, dt) {
    if (curr == null || prev == null || dt <= 0) { return '-'; }
    var n = (curr - prev) / dt;
    return isFinite(n) ? n.toFixed(1) : '-';
  }

  function sampleFps(stats) {
    var now = Date.now();
    var dt  = fpsPrev.t ? (now - fpsPrev.t) / 1000 : 0;
    if (!appPresentsMain && !terminalPresentsMain) { hostVideoTime(); }
    var mainEl = appPresentsMain ? mainVideo : hostVideo;
    var mainN  = videoFrameTotal(mainEl);
    var decodedN = (stats && typeof stats.decoded === 'number') ? stats.decoded : null;
    var drawnN   = (stats && typeof stats.drawn   === 'number') ? stats.drawn   : null;
    if (drawnN == null) { drawnN = videoFrameTotal(interpreterVideo); }
    if (decodedN == null) { decodedN = drawnN; }

    if (dt >= 0.4) {
      var mainStr = (terminalPresentsMain && mainN == null)
        ? 'n/a'
        : fpsRate(mainN, fpsPrev.main, dt);
      fpsLine = 'fps  main=' + mainStr +
                '  interp=' + fpsRate(drawnN, fpsPrev.drawn, dt) +
                ' (decode=' + fpsRate(decodedN, fpsPrev.decoded, dt) + ')';
    }

    fpsPrev.t       = now;
    fpsPrev.decoded = decodedN;
    fpsPrev.drawn   = drawnN;
    fpsPrev.main    = mainN;
  }

  function capabilities() {
    var webgl = false;
    try {
      var c = document.createElement('canvas');
      webgl = !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) {}
    return {
      wasm:   typeof WebAssembly !== 'undefined',
      webgl:  webgl,
      wc:     typeof VideoDecoder !== 'undefined',
      worker: typeof Worker !== 'undefined',
      fetch:  typeof fetch !== 'undefined',
      pad:    typeof String.prototype.padStart === 'function',
      secure: !!window.isSecureContext
    };
  }

  function yn(v) { return v ? 'Y' : 'N'; }

  function renderDiag() {
    var stats = (wasmDecoder && typeof wasmDecoder.getStats === 'function')
      ? wasmDecoder.getStats() : null;
    sampleFps(stats);

    if (!diagForced) {
      if (diagEl) { diagEl.style.display = 'none'; }
      return;
    }

    if (!diagEl) {
      diagEl = document.createElement('div');
      diagEl.style.cssText =
        'position:fixed;left:0;top:0;z-index:9998;max-width:70%;' +
        'background:rgba(0,0,0,0.8);color:#0f0;font-family:monospace;' +
        'font-size:0.85rem;line-height:1.35;padding:0.5rem 0.75rem;' +
        'white-space:pre-wrap;word-break:break-all';
      document.body.appendChild(diagEl);
    }
    diagEl.style.display = 'block';

    var c = capabilities();
    var clockValue = masterClock();
    var clock = clockValue
      ? clockValue.toFixed(2) + 's (loop ' + (clockValue % LOOP_SECONDS).toFixed(2) + 's' +
        ', cue ' + activeCueIndex + '/' + subtitleCues.length + ')'
      : '0 — no clock (' +
        (terminalPresentsMain ? 'terminal presents'
         : appPresentsMain    ? 'own player not started'
                              : 'no host video') + ')';

    diagEl.textContent =
      'decoder=' + decoderMode + '  render=' + (stats ? stats.renderPath : '-') + '\n' +
      'WASM=' + yn(c.wasm) + ' WebGL=' + yn(c.webgl) + ' WebCodecs=' + yn(c.wc) +
      ' Worker=' + yn(c.worker) + ' fetch=' + yn(c.fetch) +
      ' padStart=' + yn(c.pad) + ' secure=' + yn(c.secure) + '\n' +
      'terminal=' + yn(terminalPresentsMain) + ' interpOnly=' + yn(interpreterOnlyMode) +
      ' clock=' + clock + '\n' +
      'url=' + currentInterpreterUrl + '\n' +
      'viewport=' + window.innerWidth + 'x' + window.innerHeight +
      ' dpr=' + (window.devicePixelRatio || 1) +
      ' screen=' + (window.screen ? screen.width + 'x' + screen.height : '-') +
      ' rem=' + parseFloat(getComputedStyle(document.documentElement).fontSize) + 'px\n' +
      fpsLine + '\n' +
      (stats
        ? 'mpdFails=' + stats.mpdFails + '  decoded=' + stats.decoded +
          '  drawn=' + stats.drawn +
          (typeof stats.dropped === 'number' ? '  dropped=' + stats.dropped : '') +
          '  queued=' + (stats.decoded - stats.drawn) + '\n' +
          'sync=' + (stats.syncMs == null || !isFinite(stats.syncMs)
            ? 'n/a'
            : (stats.syncMs >= 0 ? '+' : '') + Math.round(stats.syncMs) + 'ms' +
              (stats.syncMs > 40 ? ' late' : stats.syncMs < -40 ? ' early' : '')) +
          (stats.lastFailure ? '\nlast: ' + stats.lastFailure : '')
        : 'decoder not started');
  }

  setInterval(renderDiag, 1000);

  var VK_LEFT   = 37;
  var VK_UP     = 38;
  var VK_RIGHT  = 39;
  var VK_DOWN   = 40;
  var VK_RED    = 403; var VK_RED2    = 183;
  var VK_GREEN  = 404; var VK_GREEN2  = 184;
  var VK_YELLOW = 405; var VK_YELLOW2 = 185;
  var VK_BLUE   = 406; var VK_BLUE2   = 186;
  var VK_0      = 48;
  var VK_ENTER  = 13;
  var VK_SUBTITLE = HbbTV.VK_SUBTITLE;

  var SIGNER_KEYS = [VK_GREEN, VK_GREEN2, VK_YELLOW, VK_YELLOW2, VK_BLUE, VK_BLUE2,
                     VK_UP, VK_DOWN, VK_LEFT, VK_RIGHT];
  function isSignerKey(key) { return SIGNER_KEYS.indexOf(key) >= 0; }

  showHintBar();

  document.addEventListener('keydown', function (e) {
    var key = e.keyCode || e.which;
    showHintBar();

    if (!interpreterVisible && isSignerKey(key)) {
      e.preventDefault();
      return;
    }

    if (isSplitLayout() && (key === VK_UP || key === VK_DOWN || key === VK_LEFT || key === VK_RIGHT)) {
      showToast('Premik v tem pogledu ni mogoč');
      e.preventDefault();
      return;
    }

    switch (key) {
      case VK_SUBTITLE:
      case VK_ENTER:
        toggleSubtitles();
        e.preventDefault();
        break;

      case VK_0:
        diagForced = !diagForced;
        if (!diagForced && diagEl) { diagEl.style.display = 'none'; }
        else { renderDiag(); }
        e.preventDefault();
        break;

      case VK_RED:
      case VK_RED2:
        toggleInterpreter();
        e.preventDefault();
        break;

      case VK_YELLOW:
      case VK_YELLOW2:
        if (isSplitLayout()) {
          if (splitIdx < SIDE_STEPS.length - 1) { splitIdx++; applySize(true); }
          else { showToast('Največji tolmač'); }
        } else if (sizeIdx < SIZE_WIDTHS.length - 1) { sizeIdx++; applySize(true); }
        else { showToast('Največja velikost'); }
        e.preventDefault();
        break;

      case VK_GREEN:
      case VK_GREEN2:
        if (isSplitLayout()) {
          if (splitIdx > 0) { splitIdx--; applySize(true); }
          else { showToast('Najmanjši tolmač'); }
        } else if (sizeIdx > 0) { sizeIdx--; applySize(true); }
        else { showToast('Najmanjša velikost'); }
        e.preventDefault();
        break;

      case VK_BLUE:
      case VK_BLUE2:
        layoutMode = (layoutMode + 1) % LAYOUT_LABELS.length;
        applyLayout();
        e.preventDefault();
        break;

      case VK_UP:
        if (posRow > 0) { posRow--; applyPosition(); }
        else { showToast('Zgornja vrsta'); }
        e.preventDefault();
        break;

      case VK_DOWN:
        if (posRow < POS_GRID.length - 1) { posRow++; applyPosition(); }
        else { showToast('Spodnja vrsta'); }
        e.preventDefault();
        break;

      case VK_LEFT:
        if (posCol > 0) { posCol--; applyPosition(); }
        else { showToast('Skrajno levo'); }
        e.preventDefault();
        break;

      case VK_RIGHT:
        if (posCol < POS_GRID[0].length - 1) { posCol++; applyPosition(); }
        else { showToast('Skrajno desno'); }
        e.preventDefault();
        break;
    }
  });

  var VIEW_NAMES = ['floating_transparent', 'floating_grey', 'split_overlapping', 'split_side_by_side'];
  var POSITION_NAMES = {
    tl: 'top-left',    tc: 'top-centre',    tr: 'top-right',
    ml: 'middle-left', mc: 'centre',        mr: 'middle-right',
    bl: 'bottom-left', bc: 'bottom-centre', br: 'bottom-right'
  };
  var TEST_KEY_NAMES = {};
  TEST_KEY_NAMES[VK_RED] = TEST_KEY_NAMES[VK_RED2] = 'red';
  TEST_KEY_NAMES[VK_GREEN] = TEST_KEY_NAMES[VK_GREEN2] = 'green';
  TEST_KEY_NAMES[VK_YELLOW] = TEST_KEY_NAMES[VK_YELLOW2] = 'yellow';
  TEST_KEY_NAMES[VK_BLUE] = TEST_KEY_NAMES[VK_BLUE2] = 'blue';
  TEST_KEY_NAMES[VK_UP] = 'up';
  TEST_KEY_NAMES[VK_DOWN] = 'down';
  TEST_KEY_NAMES[VK_LEFT] = 'left';
  TEST_KEY_NAMES[VK_RIGHT] = 'right';
  TEST_KEY_NAMES[VK_ENTER] = 'ok';

  function testState() {
    var size = null;
    if (interpreterVisible) {
      var w = overlay.getBoundingClientRect().width;
      if (w > 0 && window.innerWidth > 0) { size = Math.round(w / window.innerWidth * 100); }
    }
    return {
      signer: interpreterVisible,
      view: VIEW_NAMES[layoutMode],
      position: isSplitLayout() ? null : POSITION_NAMES[POS_GRID[posRow][posCol]],
      signer_size_pct: size
    };
  }

  function testLog(action, key) {
    if (window.TestSession) { window.TestSession.log('signer_app', action, testState(), key); }
  }

  var testBefore = null;
  window.addEventListener('keydown', function () {
    testBefore = { visible: interpreterVisible, split: isSplitLayout(), size: sizeIdx,
                   splitStep: splitIdx, row: posRow, col: posCol };
  }, true);

  function testAction(key, b) {
    if (!b.visible && key !== 'red' && key !== 'ok') { return 'ignored_signer_off'; }
    var resized = b.split ? splitIdx !== b.splitStep : sizeIdx !== b.size;
    switch (key) {
      case 'red':    return interpreterVisible ? 'signer_on' : 'signer_off';
      case 'green':  return resized ? 'signer_smaller' : 'size_limit_reached';
      case 'yellow': return resized ? 'signer_larger' : 'size_limit_reached';
      case 'blue':   return 'view_changed';
      case 'ok':     return 'ok_pressed';
      default:
        if (b.split) { return 'move_not_possible_in_split_view'; }
        return (posRow !== b.row || posCol !== b.col) ? 'signer_moved' : 'move_limit_reached';
    }
  }

  document.addEventListener('keydown', function (e) {
    var key = TEST_KEY_NAMES[e.keyCode || e.which];
    if (key && testBefore) { testLog(testAction(key, testBefore), key); }
  });
  testLog('app_opened');

  interpreterVideo.addEventListener('loadedmetadata', function () {
    adaptToVideoRatio(interpreterVideo.videoWidth, interpreterVideo.videoHeight);
  });

  interpreterVideo.addEventListener('loadeddata', function () {
    setInterpreterLoading(false);
  });

  interpreterVideo.addEventListener('error', function () {
    if (decoderMode === 'native') {
      showError('Interpreter decoder failed — switching to canvas mode.');
      applyDecoderMode('canvas');
    }
  });

  mainVideo.addEventListener('waiting', function () {
    if (decoderMode === 'native' && interpreterDashPlayer && !interpreterVideo.paused) {
      showError('Main video stalled — single hardware decoder conflict. Switching to canvas mode.');
      applyDecoderMode('canvas');
    }
  });

  var onFirstPlay = function () {
    mainVideo.removeEventListener('playing', onFirstPlay);
    mainVideo.muted = false;
  };
  mainVideo.addEventListener('playing', onFirstPlay);

  var LOOP_SECONDS  = 249.856;
  var SUBTITLE_URL  = 'subtitles/main_slv.srt';

  var subtitleCues    = [];
  var APP_RENDERED_SUBTITLES = false;

  var subtitlesOn     = APP_RENDERED_SUBTITLES;
  var activeCueIndex  = -1;

  function parseSrt(text) {
    var cues = [];
    var blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) { continue; }
      var i = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
      if (i >= lines.length) { continue; }
      var m = /^(.+?)\s*-->\s*(.+?)$/.exec(lines[i]);
      if (!m) { continue; }
      var body = lines.slice(i + 1);
      if (!body.length) { continue; }
      cues.push({ start: srtSeconds(m[1]), end: srtSeconds(m[2]), lines: body });
    }
    return cues;
  }

  function srtSeconds(t) {
    var m = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(t.trim());
    if (!m) { return NaN; }
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  }

  function loadSubtitles() {
    if (typeof fetch === 'undefined') {
      console.warn('[Subs] no fetch() — subtitles unavailable');
      return;
    }
    fetch(SUBTITLE_URL)
      .then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.text();
      })
      .then(function (text) {
        subtitleCues = parseSrt(text);
        console.log('[Subs] ' + subtitleCues.length + ' cues loaded');
        if (!subtitleCues.length) { showError('Subtitle file contained no cues'); }
      })
      .catch(function (e) {
        console.warn('[Subs] load failed:', e && e.message);
        showError('Subtitles could not be loaded: ' + (e && e.message));
      });
  }

  function updateSubtitles() {
    if (!subtitleEl) { return; }
    if (!subtitlesOn || !subtitleCues.length) {
      subtitleEl.style.display = 'none';
      activeCueIndex = -1;
      return;
    }

    var clock = masterClock();
    if (!clock) {
      if (activeCueIndex !== -1) { subtitleEl.style.display = 'none'; activeCueIndex = -1; }
      return;
    }

    var t = clock % LOOP_SECONDS;
    var found = -1;
    for (var i = 0; i < subtitleCues.length; i++) {
      if (t >= subtitleCues[i].start && t < subtitleCues[i].end) { found = i; break; }
    }
    if (found === activeCueIndex) { return; }

    activeCueIndex = found;
    if (found === -1) {
      subtitleEl.style.display = 'none';
    } else {
      subtitleEl.innerHTML = subtitleCues[found].lines
        .map(function (l) {
          return l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        })
        .join('<br>');
      subtitleEl.style.display = 'block';
    }
  }

  function toggleSubtitles() {
    if (!APP_RENDERED_SUBTITLES) {
      showToast('Podnapisi so zagotovljeni s strani televizorja');
      return;
    }
    subtitlesOn = !subtitlesOn;
    activeCueIndex = -1;
    updateSubtitles();
    showToast('Subtitles ' + (subtitlesOn ? 'on' : 'off'));
  }

  if (APP_RENDERED_SUBTITLES) {
    loadSubtitles();
    setInterval(updateSubtitles, 200);
  }

  if (HbbTV.showApplication()) {
    console.log('[App] HbbTV application shown and activated');
  }

  HbbTV.requestKeys(
    HbbTV.KEYSET.RED | HbbTV.KEYSET.GREEN | HbbTV.KEYSET.YELLOW |
    HbbTV.KEYSET.BLUE | HbbTV.KEYSET.NAVIGATION,
    [HbbTV.VK_SUBTITLE]
  );

  var bootEl = document.getElementById('dvbi-boot-status');
  if (bootEl) { bootEl.style.display = 'none'; }

  var DECODER_MODES = ['canvas', 'webcodecs', 'video-canvas', 'native'];

  function detectDecoderMode() {
    var wcSupported   = typeof VideoDecoder !== 'undefined';
    var wasmSupported = typeof WebAssembly  !== 'undefined';
    var mseSupported  = (function () {
      try {
        return typeof MediaSource !== 'undefined' &&
               typeof MediaSource.isTypeSupported === 'function' &&
               MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
      } catch (e) { return false; }
    })();

    console.log('[Caps] MSE:', mseSupported ? 'YES' : 'NO');
    console.log('[Caps] WebCodecs:', wcSupported ? 'YES' : 'NO',
                '(secure context:', window.isSecureContext ? 'yes' : 'no', ')');
    console.log('[Caps] WASM:', wasmSupported ? 'YES' : 'NO');

    if (!mseSupported) {
      showError('MSE not supported — DASH streams cannot play. HbbTV 2.0 required for DASH.');
    }

    var requested = getUrlParams().decoder;

    if (requested === 'webcodecs') {
      if (!wcSupported || !window.WebCodecsDecoder) {
        console.warn('[Caps] ?decoder=webcodecs requested but WebCodecs is unavailable' +
                     (window.isSecureContext ? '' : ' (page is not a secure context)') +
                     ' — using WASM');
        return Promise.resolve('canvas');
      }
      return WebCodecsDecoder.isSupported('avc1.42001f')
        .then(function (ok) {
          console.log(ok ? '[Caps] WebCodecs H.264 OK — using webcodecs mode'
                         : '[Caps] WebCodecs cannot decode H.264 Baseline — using WASM');
          return ok ? 'webcodecs' : 'canvas';
        })
        .catch(function () { return 'canvas'; });
    }

    if (requested && DECODER_MODES.indexOf(requested) >= 0) {
      console.log('[Caps] decoder forced by ?decoder= to', requested);
      return Promise.resolve(requested);
    }
    if (requested) {
      console.warn('[Caps] unknown ?decoder=' + requested +
                   ' — ignoring. Modes: ' + DECODER_MODES.join(', '));
    }

    if (wasmSupported) {
      console.log('[Caps] using WASM software decoding (default)');
      return Promise.resolve('canvas');
    }

    if (wcSupported && window.WebCodecsDecoder) {
      console.warn('[Caps] no WebAssembly — falling back to WebCodecs');
      return WebCodecsDecoder.isSupported('avc1.42001f')
        .then(function (ok) { return ok ? 'webcodecs' : 'video-canvas'; })
        .catch(function () { return 'video-canvas'; });
    }
    console.warn('[Caps] neither WebAssembly nor WebCodecs — falling back to video-canvas');
    return Promise.resolve('video-canvas');
  }

  applySize();
  applyPosition(false);

  detectDecoderMode().then(function (mode) {
    decoderMode = mode;
    initSources();
  });

})();
