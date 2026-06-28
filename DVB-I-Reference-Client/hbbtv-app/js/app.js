/**
 * DVB-I Accessibility app: dual video PiP with decoder mode toggle.
 *
 * Decoder modes:
 *   native — both streams use dash.js → <video> elements (hardware decoder)
 *            On single-decoder TVs the interpreter may show black / fail.
 *   canvas — main stream uses dash.js → <video>; interpreter uses dash.js →
 *            hidden <video> → <canvas> via requestAnimationFrame.
 *            Works on all devices regardless of hardware decoder count.
 *
 * Streams arrive via DVB-I URL params: ?main=<dash-url>&interpreter=<dash-url>
 */
(function () {
  'use strict';

  var mainVideo         = document.getElementById('mainVideo');
  var interpreterVideo  = document.getElementById('interpreterVideo');
  var interpreterCanvas = document.getElementById('interpreterCanvas');
  var subtitleTrack     = document.getElementById('subtitleTrack');
  var subtitleToggle    = document.getElementById('subtitleToggle');
  var overlay           = document.getElementById('interpreterOverlay');
  var decoderStatus     = document.getElementById('decoderStatus');

  var decoderMode           = 'canvas';
  var wasmDecoder           = null;
  var mainDashPlayer        = null;
  var interpreterDashPlayer = null;
  var currentMainUrl        = '';
  var currentInterpreterUrl = '';
  var interpreterOnlyMode   = false;

  // ── URL params ────────────────────────────────────────────────────────────

  function getUrlParams() {
    var params = {};
    var q = window.location.search ? window.location.search.slice(1) : '';
    q.split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i >= 0) {
        var k = decodeURIComponent(pair.slice(0, i)).toLowerCase();
        var v = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        if (k === 'main' || k === 'interpreter') params[k] = v;
      }
    });
    return params;
  }

  // ── dash.js helper ────────────────────────────────────────────────────────

  function createDashPlayer(videoEl, url, autoplay) {
    if (typeof dashjs === 'undefined') {
      // fallback for plain MP4
      videoEl.src = url;
      if (autoplay) videoEl.play();
      return null;
    }
    var p = dashjs.MediaPlayer().create();
    p.initialize(videoEl, url, autoplay);
    return p;
  }

  function destroyDashPlayer(player) {
    if (player) { try { player.destroy(); } catch (e) {} }
    return null;
  }

  // ── Source initialisation ─────────────────────────────────────────────────

  function initSources() {
    var urlParams = getUrlParams();
    var mainUrl   = urlParams.main        || document.getElementById('mainVideoUrl').value.trim();
    var interpUrl = urlParams.interpreter || document.getElementById('interpreterVideoUrl').value.trim();

    interpreterOnlyMode   = !!(interpUrl && !mainUrl);
    currentMainUrl        = mainUrl        || 'http://192.168.1.118:9080/stream/live/main/stream.mpd';
    currentInterpreterUrl = interpUrl      || 'http://192.168.1.118:9080/stream/live/interpreter/stream.mpd';

    // Tear down existing players
    mainDashPlayer        = destroyDashPlayer(mainDashPlayer);
    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }

    if (interpreterOnlyMode) {
      document.body.classList.add('interpreter-only-mode');
      var sourcesEl = document.querySelector('.control-group.sources');
      if (sourcesEl) sourcesEl.style.display = 'none';
    } else {
      document.body.classList.remove('interpreter-only-mode');
      mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
    }

    applyDecoderMode(decoderMode);
    clearVideoError();
  }

  // ── Decoder mode ──────────────────────────────────────────────────────────

  function applyDecoderMode(mode) {
    decoderMode = mode;

    // Tear down interpreter player / wasm decoder
    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }

    if (mode === 'canvas') {
      interpreterVideo.pause();
      interpreterVideo.style.display = 'none';
      interpreterCanvas.style.display = 'block';

      document.getElementById('btnNativeDecoder').classList.remove('active');
      document.getElementById('btnWasmDecoder').classList.add('active');
      decoderStatus.textContent = 'Canvas mode — interpreter via hidden video → canvas';
      decoderStatus.className = 'decoder-status wasm';

      // Restart main — recovers from decoder steal if coming from native mode
      if (!interpreterOnlyMode && currentMainUrl) {
        mainDashPlayer = destroyDashPlayer(mainDashPlayer);
        mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
      }

      // Start Broadway WASM decoder after main is playing
      function startCanvasOnce() {
        mainVideo.removeEventListener('playing', startCanvasOnce);
        if (decoderMode !== 'canvas') return;
        if (currentInterpreterUrl && !wasmDecoder) {
          wasmDecoder = new WasmDecoder(interpreterCanvas);
          wasmDecoder.start(currentInterpreterUrl);
        }
      }
      if (!mainVideo.paused) {
        startCanvasOnce();
      } else {
        mainVideo.addEventListener('playing', startCanvasOnce);
      }
    } else {
      // native — start interpreter only after main is playing so main gets decoder first
      interpreterCanvas.style.display = 'none';
      interpreterVideo.style.display  = 'block';

      document.getElementById('btnWasmDecoder').classList.remove('active');
      document.getElementById('btnNativeDecoder').classList.add('active');
      decoderStatus.textContent = 'Native <video> decoder (hardware)';
      decoderStatus.className = 'decoder-status';

      function startInterpreterOnce() {
        mainVideo.removeEventListener('playing', startInterpreterOnce);
        if (decoderMode !== 'native') return;
        if (currentInterpreterUrl && !interpreterDashPlayer) {
          interpreterDashPlayer = createDashPlayer(interpreterVideo, currentInterpreterUrl, true);
        }
      }
      if (!mainVideo.paused) {
        // main already playing (e.g. decoder toggle mid-stream)
        startInterpreterOnce();
      } else {
        mainVideo.addEventListener('playing', startInterpreterOnce);
      }
    }
  }

  // ── Playback controls ─────────────────────────────────────────────────────

  function syncPlay() {
    if (interpreterOnlyMode) {
      if (decoderMode === 'canvas') {
        if (!wasmDecoder) {
          wasmDecoder = new WasmDecoder(interpreterCanvas);
          wasmDecoder.start(currentInterpreterUrl);
        }
        return;
      }
      interpreterVideo.play().catch(function (e) {
        showVideoError(e.message || 'Interpreter video failed.');
      });
      return;
    }

    if (decoderMode === 'canvas') {
      mainVideo.play().then(function () {
        if (!wasmDecoder) {
          wasmDecoder = new WasmDecoder(interpreterCanvas);
          wasmDecoder.start(currentInterpreterUrl);
        }
      }).catch(function (e) {
        showVideoError(e.message || 'Main video failed.');
      });
    } else {
      // native: play both
      mainVideo.play().catch(function (e) {
        showVideoError(e.message || 'Main video failed.');
      });
      interpreterVideo.play().catch(function () {
        showVideoError('Interpreter failed on native decoder — expected on single-decoder TVs. Switch to Canvas mode.');
      });
    }
  }

  function syncPause() {
    mainVideo.pause();
    interpreterVideo.pause();
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }
  }

  function syncRestart() {
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }
    mainVideo.pause();
    interpreterVideo.pause();
    // Re-init sources to restart from beginning
    initSources();
  }

  // ── Overlay controls ──────────────────────────────────────────────────────

  function setOverlayPosition(pos) {
    overlay.classList.remove('interpreter-position-tl','interpreter-position-tc','interpreter-position-tr',
                             'interpreter-position-bl','interpreter-position-bc','interpreter-position-br');
    overlay.classList.add('interpreter-position-' + pos);
    document.querySelectorAll('#positionButtons button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.position === pos ? 'true' : 'false');
    });
  }

  function setOverlaySize(size) {
    overlay.classList.remove('interpreter-size-small','interpreter-size-medium','interpreter-size-large');
    overlay.classList.add('interpreter-size-' + size);
    document.querySelectorAll('#sizeButtons button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.size === size ? 'true' : 'false');
    });
  }

  function setSubtitleVisible(visible) {
    if (subtitleTrack.track) subtitleTrack.track.mode = visible ? 'showing' : 'hidden';
  }

  // ── Error display ─────────────────────────────────────────────────────────

  function showVideoError(msg) {
    var el = document.getElementById('videoError');
    if (!el) {
      el = document.createElement('p');
      el.id = 'videoError'; el.className = 'video-error';
      el.setAttribute('role', 'alert');
      var sg = document.querySelector('.control-group.sources');
      if (sg) sg.insertBefore(el, sg.firstChild);
      else document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = msg; el.style.display = 'block';
  }

  function clearVideoError() {
    var el = document.getElementById('videoError');
    if (el) el.style.display = 'none';
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  document.getElementById('btnPlay').addEventListener('click', syncPlay);
  document.getElementById('btnPause').addEventListener('click', syncPause);
  document.getElementById('btnRestart').addEventListener('click', syncRestart);
  document.getElementById('btnFullscreen').addEventListener('click', function () {
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
  });

  document.getElementById('btnUnmute').addEventListener('click', function () {
    mainVideo.muted = !mainVideo.muted;
    this.textContent = mainVideo.muted ? '🔇 Unmute' : '🔊 Mute';
  });

  document.getElementById('btnNativeDecoder').addEventListener('click', function () { applyDecoderMode('native'); });
  document.getElementById('btnWasmDecoder').addEventListener('click', function () { applyDecoderMode('canvas'); });

  document.querySelectorAll('#positionButtons button').forEach(function (btn) {
    btn.setAttribute('aria-pressed', btn.dataset.position === 'br' ? 'true' : 'false');
    btn.addEventListener('click', function () { setOverlayPosition(btn.dataset.position); });
  });
  document.querySelectorAll('#sizeButtons button').forEach(function (btn) {
    btn.setAttribute('aria-pressed', btn.dataset.size === 'medium' ? 'true' : 'false');
    btn.addEventListener('click', function () { setOverlaySize(btn.dataset.size); });
  });

  subtitleToggle.addEventListener('change', function () { setSubtitleVisible(subtitleToggle.checked); });
  document.getElementById('btnApplySources').addEventListener('click', initSources);

  interpreterVideo.addEventListener('error', function () {
    if (decoderMode === 'native') {
      showVideoError('Interpreter failed on native decoder — single-decoder TV limitation. Switch to Canvas mode to fix.');
    }
  });

  mainVideo.addEventListener('waiting', function () {
    if (decoderMode === 'native' && interpreterDashPlayer && !interpreterVideo.paused) {
      showVideoError('Main video stalled — interpreter took the hardware decoder. This is the single-decoder problem. Switch to Canvas mode.');
    }
  });

  if (subtitleTrack.track) setSubtitleVisible(subtitleToggle.checked);
  subtitleTrack.addEventListener('load', function () {
    if (subtitleTrack.track) setSubtitleVisible(subtitleToggle.checked);
  });

  // ── Keyboard / remote control ─────────────────────────────────────────────
  (function () {
    var positions = ['tl','tc','tr','bl','bc','br'];
    document.addEventListener('keydown', function (e) {
      var key = e.keyCode || e.which;
      var ch  = (e.key || '').toLowerCase();
      if (key === 32) e.preventDefault();
      if      (key === 13 || key === 32 || key === 415) { syncPlay();  e.preventDefault(); }
      else if (key === 19 || ch === 'p')                { syncPause(); e.preventDefault(); }
      else if (key === 413 || ch === 'r')               { syncRestart(); e.preventDefault(); }
      else if (ch === 'c')                              { subtitleToggle.checked = !subtitleToggle.checked; setSubtitleVisible(subtitleToggle.checked); e.preventDefault(); }
      else if (ch === 'w')                              { applyDecoderMode(decoderMode === 'canvas' ? 'native' : 'canvas'); e.preventDefault(); }
      else if (ch === 's')                              { setOverlaySize('small');  e.preventDefault(); }
      else if (ch === 'm')                              { setOverlaySize('medium'); e.preventDefault(); }
      else if (ch === 'l')                              { setOverlaySize('large');  e.preventDefault(); }
      else if (ch >= '1' && ch <= '6')                 { setOverlayPosition(positions[parseInt(ch,10)-1]); e.preventDefault(); }
    });
  })();

  initSources();

  // Capability checks — run after initSources so decoderStatus isn't overwritten
  (function () {
    var wcSupported   = typeof VideoDecoder !== 'undefined';
    var wasmSupported = typeof WebAssembly  !== 'undefined';
    console.log('[Caps] VideoDecoder (WebCodecs):', wcSupported   ? 'SUPPORTED' : 'NOT SUPPORTED');
    console.log('[Caps] WebAssembly:',              wasmSupported ? 'SUPPORTED' : 'NOT SUPPORTED');
    decoderStatus.textContent += ' | WebCodecs: ' + (wcSupported   ? 'YES' : 'NO')
                               + ' | WASM: '      + (wasmSupported ? 'YES' : 'NO');
  })();
})();
