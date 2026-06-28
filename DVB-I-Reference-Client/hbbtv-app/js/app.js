/**
 * DVB-I Accessibility app: dual video PiP with TV remote navigation.
 *
 * Streams arrive via DVB-I URL params: ?main=<dash-url>&interpreter=<dash-url>
 *
 * Decoder modes (auto-selected):
 *   native      — both streams via dash.js → <video> (hardware decoder)
 *   webcodecs   — interpreter via WebCodecs API (hardware-accelerated)
 *   video-canvas — interpreter via hidden <video> → canvas RAF copy
 *   canvas      — interpreter via Broadway WASM → canvas
 *
 * TV remote keys:
 *   OK (13)       — show controls / confirm selection
 *   UP (38)       — previous control row
 *   DOWN (40)     — next control row
 *   LEFT (37)     — previous option in row
 *   RIGHT (39)    — next option in row
 *   BACK (461/27) — close controls
 *   RED (403)     — toggle interpreter on/off instantly
 */
(function () {
  'use strict';

  // ── Elements ───────────────────────────────────────────────────────────────
  var mainVideo         = document.getElementById('mainVideo');
  var interpreterVideo  = document.getElementById('interpreterVideo');
  var interpreterCanvas = document.getElementById('interpreterCanvas');
  var subtitleTrack     = document.getElementById('subtitleTrack');
  var overlay           = document.getElementById('interpreterOverlay');

  // ── Decoder state ──────────────────────────────────────────────────────────
  var decoderMode           = 'canvas'; // Broadway WASM default
  var wasmDecoder           = null;
  var videoCanvasRafId      = null;
  var mainDashPlayer        = null;
  var interpreterDashPlayer = null;
  var currentMainUrl        = '';
  var currentInterpreterUrl = '';
  var interpreterOnlyMode   = false;

  // ── UI state ───────────────────────────────────────────────────────────────
  var interpreterVisible = true;

  // Position grid: [row][col] — 3 rows × 3 cols
  var POS_GRID = [
    ['tl', 'tc', 'tr'],
    ['ml', 'mc', 'mr'],
    ['bl', 'bc', 'br']
  ];
  var POS_LABELS = {
    tl: 'Top left',    tc: 'Top centre',    tr: 'Top right',
    ml: 'Middle left', mc: 'Middle centre', mr: 'Middle right',
    bl: 'Bottom left', bc: 'Bottom centre', br: 'Bottom right'
  };
  var posRow = 2; // bottom
  var posCol = 2; // right  (default: br)

  // 7 size steps — widths only (vw); height computed from detected video ratio
  var SIZE_WIDTHS    = [10, 15, 20, 27, 35, 44, 55];
  var DEFAULT_SIZE_IDX = 3;
  var sizeIdx        = DEFAULT_SIZE_IDX;
  var videoRatio     = 3 / 4; // default 4:3; updated from stream on first frame

  var toastTimer = null;

  // ── URL params ─────────────────────────────────────────────────────────────
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

  // ── dash.js helpers ────────────────────────────────────────────────────────
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
    p.initialize(videoEl, url, autoplay);
    return p;
  }

  function destroyDashPlayer(player) {
    if (player) { try { player.destroy(); } catch (e) {} }
    return null;
  }

  // ── Source initialisation ──────────────────────────────────────────────────
  function initSources() {
    var urlParams = getUrlParams();
    var mainUrl   = urlParams.main        || 'http://192.168.1.118:9080/stream/live/main/stream.mpd';
    var interpUrl = urlParams.interpreter || 'http://192.168.1.118:9080/stream/live/interpreter/stream.mpd';

    interpreterOnlyMode   = !!(urlParams.interpreter && !urlParams.main);
    currentMainUrl        = mainUrl;
    currentInterpreterUrl = interpUrl;

    mainDashPlayer        = destroyDashPlayer(mainDashPlayer);
    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }

    if (!interpreterOnlyMode) {
      mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
    }

    applyDecoderMode(decoderMode);
    clearError();
  }

  // ── Decoder mode ───────────────────────────────────────────────────────────
  function stopVideoCanvas() {
    if (videoCanvasRafId) { cancelAnimationFrame(videoCanvasRafId); videoCanvasRafId = null; }
  }

  function applyDecoderMode(mode) {
    decoderMode = mode;

    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }
    stopVideoCanvas();
    interpreterVideo.pause();

    if (mode === 'webcodecs') {
      interpreterVideo.style.display = 'none';
      interpreterCanvas.style.display = 'block';

      if (!interpreterOnlyMode && currentMainUrl && !mainDashPlayer) {
        mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
      }
      if (!window.WebCodecsDecoder) {
        applyDecoderMode('canvas');
        return;
      }
      var startWC = function () {
        mainVideo.removeEventListener('playing', startWC);
        if (decoderMode !== 'webcodecs') { return; }
        if (currentInterpreterUrl && !wasmDecoder) {
          wasmDecoder = new WebCodecsDecoder(interpreterCanvas);
          wasmDecoder.start(currentInterpreterUrl);
        }
      };
      if (interpreterOnlyMode || !mainVideo.paused) { startWC(); }
      else { mainVideo.addEventListener('playing', startWC); }
      return;
    }

    if (mode === 'video-canvas') {
      interpreterVideo.style.display = 'none';
      interpreterCanvas.style.display = 'block';

      if (!interpreterOnlyMode && currentMainUrl && !mainDashPlayer) {
        mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
      }
      var startVC = function () {
        mainVideo.removeEventListener('playing', startVC);
        if (decoderMode !== 'video-canvas' || !currentInterpreterUrl) { return; }
        interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
        var ctx = interpreterCanvas.getContext('2d');
        var cw  = interpreterCanvas.width;
        var ch  = interpreterCanvas.height;
        var fallbackT = setTimeout(function () {
          if (decoderMode === 'video-canvas' && interpreterVideo.videoWidth === 0) {
            applyDecoderMode('canvas');
          }
        }, 6000);
        function rafLoop() {
          if (decoderMode !== 'video-canvas') { return; }
          if (interpreterVideo.readyState >= 2 && interpreterVideo.videoWidth > 0) {
            clearTimeout(fallbackT);
            ctx.drawImage(interpreterVideo, 0, 0, cw, ch);
          }
          videoCanvasRafId = requestAnimationFrame(rafLoop);
        }
        videoCanvasRafId = requestAnimationFrame(rafLoop);
      };
      if (interpreterOnlyMode || !mainVideo.paused) { startVC(); }
      else { mainVideo.addEventListener('playing', startVC); }
      return;
    }

    if (mode === 'canvas') {
      interpreterVideo.pause();
      interpreterVideo.style.display = 'none';
      interpreterCanvas.style.display = 'block';

      if (!interpreterOnlyMode && currentMainUrl && !mainDashPlayer) {
        mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
      }
      var startCanvas = function () {
        mainVideo.removeEventListener('playing', startCanvas);
        if (decoderMode !== 'canvas') { return; }
        if (currentInterpreterUrl && !wasmDecoder) {
          wasmDecoder = new WasmDecoder(interpreterCanvas);
          wasmDecoder.onFirstFrame = function (w, h) { adaptToVideoRatio(w, h); };
          wasmDecoder.start(currentInterpreterUrl);
        }
      };
      if (!mainVideo.paused) { startCanvas(); }
      else { mainVideo.addEventListener('playing', startCanvas); }
      return;
    }

    // native
    interpreterCanvas.style.display = 'none';
    interpreterVideo.style.display  = 'block';

    var startNative = function () {
      mainVideo.removeEventListener('playing', startNative);
      if (decoderMode !== 'native') { return; }
      if (currentInterpreterUrl && !interpreterDashPlayer) {
        interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
      }
    };
    if (!mainVideo.paused) { startNative(); }
    else { mainVideo.addEventListener('playing', startNative); }
  }

  // ── Safe play ──────────────────────────────────────────────────────────────
  function safePlay(videoEl, onSuccess, onError) {
    var result;
    try { result = videoEl.play(); } catch (e) { if (onError) { onError(e); } return; }
    if (result && typeof result.then === 'function') {
      result.then(onSuccess || function () {}).catch(onError || function () {});
    } else {
      if (onSuccess) { onSuccess(); }
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg) {
    var el = document.getElementById('toast');
    if (!el) { return; }
    el.textContent = msg;
    el.style.display = 'block';
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () {
      el.style.display = 'none';
      toastTimer = null;
    }, 1500);
  }

  // ── Overlay position ───────────────────────────────────────────────────────
  function applyPosition() {
    var pos = POS_GRID[posRow][posCol];
    overlay.classList.remove(
      'interpreter-position-tl', 'interpreter-position-tc', 'interpreter-position-tr',
      'interpreter-position-ml', 'interpreter-position-mc', 'interpreter-position-mr',
      'interpreter-position-bl', 'interpreter-position-bc', 'interpreter-position-br'
    );
    overlay.classList.add('interpreter-position-' + pos);
    showToast(POS_LABELS[pos]);
  }

  // ── Overlay size ───────────────────────────────────────────────────────────
  function applySize() {
    var w = SIZE_WIDTHS[sizeIdx];
    overlay.style.width  = w + 'vw';
    overlay.style.height = (w * videoRatio).toFixed(3) + 'vw';
    showToast('Size ' + (sizeIdx + 1) + ' / ' + SIZE_WIDTHS.length);
  }

  // Called when actual video dimensions are known (first frame or loadedmetadata)
  function adaptToVideoRatio(srcW, srcH) {
    if (!srcW || !srcH) { return; }
    videoRatio = srcH / srcW;
    // Resize canvas buffer to match source (drawContain fills it exactly)
    interpreterCanvas.width  = srcW;
    interpreterCanvas.height = srcH;
    applySize(); // reapply current size with correct ratio
  }

  // ── Interpreter decoder start / stop ──────────────────────────────────────
  function stopInterpreterDecoder() {
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }
    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    stopVideoCanvas();
    interpreterVideo.pause();
  }

  function startInterpreterDecoder() {
    if (!currentInterpreterUrl) { return; }
    stopInterpreterDecoder();

    if (decoderMode === 'canvas') {
      wasmDecoder = new WasmDecoder(interpreterCanvas);
      wasmDecoder.onFirstFrame = function (w, h) { adaptToVideoRatio(w, h); };
      wasmDecoder.start(currentInterpreterUrl);

    } else if (decoderMode === 'webcodecs') {
      if (window.WebCodecsDecoder) {
        wasmDecoder = new WebCodecsDecoder(interpreterCanvas);
        wasmDecoder.start(currentInterpreterUrl);
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

    } else { // native
      interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
    }
  }

  // ── Interpreter toggle ─────────────────────────────────────────────────────
  function toggleInterpreter() {
    interpreterVisible = !interpreterVisible;
    if (interpreterVisible) {
      overlay.classList.remove('hidden');
      startInterpreterDecoder();
      showToast('Interpreter ON');
    } else {
      overlay.classList.add('hidden');
      stopInterpreterDecoder();
      showToast('Interpreter OFF');
    }
  }

  // ── Error display ──────────────────────────────────────────────────────────
  function showError(msg) {
    var el = document.getElementById('errorOverlay');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function clearError() {
    var el = document.getElementById('errorOverlay');
    if (el) { el.style.display = 'none'; }
  }

  // ── TV remote key handler ──────────────────────────────────────────────────
  var VK_LEFT   = 37;
  var VK_UP     = 38;
  var VK_RIGHT  = 39;
  var VK_DOWN   = 40;
  var VK_RED    = 403; var VK_RED2    = 183; // HbbTV / Android
  var VK_GREEN  = 404; var VK_GREEN2  = 184;
  var VK_YELLOW = 405; var VK_YELLOW2 = 185;
  var VK_BLUE   = 406; var VK_BLUE2   = 186;

  document.addEventListener('keydown', function (e) {
    var key = e.keyCode || e.which;

    switch (key) {
      case VK_RED:
      case VK_RED2:
        toggleInterpreter();
        e.preventDefault();
        break;

      case VK_GREEN:
      case VK_GREEN2:
        if (sizeIdx < SIZE_WIDTHS.length - 1) { sizeIdx++; applySize(); }
        else { showToast('Maximum size'); }
        e.preventDefault();
        break;

      case VK_YELLOW:
      case VK_YELLOW2:
        if (sizeIdx > 0) { sizeIdx--; applySize(); }
        else { showToast('Minimum size'); }
        e.preventDefault();
        break;

      case VK_BLUE:
      case VK_BLUE2:
        posRow = 2; posCol = 2; applyPosition();
        sizeIdx = DEFAULT_SIZE_IDX; applySize();
        showToast('Reset');
        e.preventDefault();
        break;

      case VK_UP:
        if (posRow > 0) { posRow--; applyPosition(); }
        else { showToast('Top row'); }
        e.preventDefault();
        break;

      case VK_DOWN:
        if (posRow < POS_GRID.length - 1) { posRow++; applyPosition(); }
        else { showToast('Bottom row'); }
        e.preventDefault();
        break;

      case VK_LEFT:
        if (posCol > 0) { posCol--; applyPosition(); }
        else { showToast('Leftmost'); }
        e.preventDefault();
        break;

      case VK_RIGHT:
        if (posCol < POS_GRID[0].length - 1) { posCol++; applyPosition(); }
        else { showToast('Rightmost'); }
        e.preventDefault();
        break;
    }
  });

  // ── Video dimension detection ──────────────────────────────────────────────
  interpreterVideo.addEventListener('loadedmetadata', function () {
    adaptToVideoRatio(interpreterVideo.videoWidth, interpreterVideo.videoHeight);
  });

  // ── Video error handlers ───────────────────────────────────────────────────
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

  // ── Auto-unmute main video once playing ───────────────────────────────────
  // Browser autoplay requires muted; unmute as soon as play() succeeds.
  var onFirstPlay = function () {
    mainVideo.removeEventListener('playing', onFirstPlay);
    mainVideo.muted = false;
  };
  mainVideo.addEventListener('playing', onFirstPlay);

  // ── Subtitle: show by default ─────────────────────────────────────────────
  function enableSubtitles() {
    if (subtitleTrack && subtitleTrack.track) {
      subtitleTrack.track.mode = 'showing';
    }
  }
  enableSubtitles();
  if (subtitleTrack) {
    subtitleTrack.addEventListener('load', enableSubtitles);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  var bootEl = document.getElementById('dvbi-boot-status');
  if (bootEl) { bootEl.style.display = 'none'; }

  // Apply initial size (no CSS class — use inline style)
  applySize();

  initSources();

  // ── Capability detection + auto-select best decoder ───────────────────────
  (function () {
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
    console.log('[Caps] WebCodecs:', wcSupported ? 'YES' : 'NO');
    console.log('[Caps] WASM:', wasmSupported ? 'YES' : 'NO');

    if (!mseSupported) {
      showError('MSE not supported — DASH streams cannot play. HbbTV 2.0 required for DASH.');
    }

    if (wcSupported && window.WebCodecsDecoder) {
      WebCodecsDecoder.isSupported('avc1.42001f').then(function (ok) {
        if (ok) {
          console.log('[Caps] WebCodecs H.264 OK — using webcodecs mode');
          applyDecoderMode('webcodecs');
        }
      });
    }
  })();

})();
