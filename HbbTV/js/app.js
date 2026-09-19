/**
 * MVP: Dual video sync + interpreter overlay position/size + subtitle toggle
 * HbbTV/DVB-I accessibility demo.
 * Linked as "application with media in parallel" (type 1.1) from DVB-I Thesis accessibility list.
 */

(function () {
  'use strict';

  const mainVideo = document.getElementById('mainVideo');
  const interpreterVideo = document.getElementById('interpreterVideo');
  const mainSource = document.getElementById('mainSource');
  const interpreterSource = document.getElementById('interpreterSource');
  const subtitleTrack = document.getElementById('subtitleTrack');
  const subtitleToggle = document.getElementById('subtitleToggle');
  const overlay = document.getElementById('interpreterOverlay');

  // Defaults: local files (same origin) to avoid CORS. Match README and DVB-I testing.
  const DEFAULT_MAIN = 'videos/main.mp4';
  const DEFAULT_INTERPRETER = 'videos/interpreter.mp4';

  /** Parse ?main=...&interpreter=... from URL (e.g. when launched from DVB-I or for testing). */
  function getUrlParams() {
    var params = {};
    var q = (typeof window !== 'undefined' && window.location && window.location.search) ? window.location.search.slice(1) : '';
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

  function setSource(el, src, type) {
    if (!src) return;
    el.src = src;
    if (type) el.type = type;
  }

  /** Call after changing <source> src so the video element loads the new URL. */
  function loadVideos() {
    mainVideo.load();
    interpreterVideo.load();
  }

  /** True when launched from DVB-I with only ?interpreter= (main is played by the TV). */
  var interpreterOnlyMode = false;

  function initSources() {
    var urlParams = getUrlParams();
    var mainUrl = urlParams.main || document.getElementById('mainVideoUrl').value.trim();
    var interpUrl = urlParams.interpreter || document.getElementById('interpreterVideoUrl').value.trim();
    interpreterOnlyMode = !!(interpUrl && !mainUrl);
    if (interpreterOnlyMode) {
      document.body.classList.add('interpreter-only-mode');
      setSource(interpreterSource, interpUrl, 'video/mp4');
      mainSource.src = '';
      var sourcesEl = document.querySelector('.control-group.sources');
      if (sourcesEl) sourcesEl.style.display = 'none';
    } else {
      document.body.classList.remove('interpreter-only-mode');
      setSource(mainSource, mainUrl || DEFAULT_MAIN, 'video/mp4');
      setSource(interpreterSource, interpUrl || DEFAULT_INTERPRETER, 'video/mp4');
      var sourcesEl = document.querySelector('.control-group.sources');
      if (sourcesEl) sourcesEl.style.display = '';
    }
    loadVideos();
    clearVideoError();
  }

  function showVideoError(msg) {
    var container = document.querySelector('.controls') || document.body;
    var el = document.getElementById('videoError');
    if (!el) {
      el = document.createElement('p');
      el.id = 'videoError';
      el.className = 'video-error';
      el.setAttribute('role', 'alert');
      var sourcesGroup = document.querySelector('.control-group.sources');
      if (sourcesGroup) {
        var firstLabel = sourcesGroup.querySelector('label');
        sourcesGroup.insertBefore(el, firstLabel || sourcesGroup.firstChild);
      } else {
        container.insertBefore(el, container.firstChild);
      }
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function clearVideoError() {
    var el = document.getElementById('videoError');
    if (el) el.style.display = 'none';
  }

  function syncPlay() {
    var interp = interpreterVideo;
    if (interpreterOnlyMode) {
      interp.play().catch(function (e) {
        console.warn('Play failed:', e);
        showVideoError((e.message || e.name || 'Video not loaded') + '. Check interpreter URL or use a playable video (e.g. MP4).');
      });
      return;
    }
    var main = mainVideo;
    if (main.readyState >= 2 && interp.readyState >= 2) {
      var t = main.currentTime;
      interp.currentTime = Math.min(t, interp.duration);
      interp.play();
      main.play();
    } else {
      main.play().then(function () {
        interp.currentTime = main.currentTime;
        return interp.play();
      }).catch(function (e) {
        console.warn('Play failed:', e);
        showVideoError((e.message || e.name || 'Video not loaded') + '. Add videos/main.mp4 and videos/interpreter.mp4 in the videos/ folder, or set URLs in Video sources.');
      });
    }
  }

  function syncPause() {
    interpreterVideo.pause();
    if (!interpreterOnlyMode) mainVideo.pause();
  }

  function syncRestart() {
    interpreterVideo.currentTime = 0;
    interpreterVideo.pause();
    if (!interpreterOnlyMode) {
      mainVideo.currentTime = 0;
      mainVideo.pause();
    }
  }

  function keepSync() {
    if (interpreterOnlyMode) return;
    var main = mainVideo;
    var interp = interpreterVideo;
    if (main.paused || interp.paused) return;
    var diff = Math.abs(main.currentTime - interp.currentTime);
    if (diff > 0.5) {
      interp.currentTime = main.currentTime;
    }
  }

  mainVideo.addEventListener('timeupdate', keepSync);
  mainVideo.addEventListener('seeked', function () {
    if (interpreterOnlyMode) return;
    if (!interpreterVideo.paused) {
      interpreterVideo.currentTime = mainVideo.currentTime;
    }
  });

  function setOverlayPosition(position) {
    overlay.classList.remove(
      'interpreter-position-tl', 'interpreter-position-tc', 'interpreter-position-tr',
      'interpreter-position-bl', 'interpreter-position-bc', 'interpreter-position-br'
    );
    overlay.classList.add('interpreter-position-' + position);
    document.querySelectorAll('#positionButtons button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.position === position ? 'true' : 'false');
    });
  }

  function setOverlaySize(size) {
    overlay.classList.remove('interpreter-size-small', 'interpreter-size-medium', 'interpreter-size-large');
    overlay.classList.add('interpreter-size-' + size);
    document.querySelectorAll('#sizeButtons button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.size === size ? 'true' : 'false');
    });
  }

  function setSubtitleVisible(visible) {
    if (subtitleTrack.track) {
      subtitleTrack.track.mode = visible ? 'showing' : 'hidden';
    }
  }

  document.getElementById('btnPlay').addEventListener('click', syncPlay);
  document.getElementById('btnPause').addEventListener('click', syncPause);
  document.getElementById('btnRestart').addEventListener('click', syncRestart);
  document.getElementById('btnFullscreen').addEventListener('click', function () {
    if (window.HbbTV && typeof window.HbbTV.toggleFullscreen === 'function') {
      window.HbbTV.toggleFullscreen().catch(function () {});
    }
  });

  document.querySelectorAll('#positionButtons button').forEach(function (btn) {
    btn.setAttribute('aria-pressed', btn.dataset.position === 'br' ? 'true' : 'false');
    btn.addEventListener('click', function () {
      setOverlayPosition(btn.dataset.position);
    });
  });

  document.querySelectorAll('#sizeButtons button').forEach(function (btn) {
    btn.setAttribute('aria-pressed', btn.dataset.size === 'medium' ? 'true' : 'false');
    btn.addEventListener('click', function () {
      setOverlaySize(btn.dataset.size);
    });
  });

  subtitleToggle.addEventListener('change', function () {
    setSubtitleVisible(subtitleToggle.checked);
  });

  document.getElementById('btnApplySources').addEventListener('click', function () {
    initSources();
  });

  mainVideo.addEventListener('error', function () {
    showVideoError('Main video failed to load. Put main.mp4 in videos/ and run from a local server, or set the main URL in Video sources, or use ?main=... in the URL (see README and docs/WHAT_NOW_DVBI_BACKEND.md).');
  });
  interpreterVideo.addEventListener('error', function () {
    showVideoError('Interpreter video failed to load. Put interpreter.mp4 in videos/ and run from a local server, or set the interpreter URL in Video sources, or use ?interpreter=... in the URL (see README and docs/WHAT_NOW_DVBI_BACKEND.md).');
  });
  mainVideo.addEventListener('loadeddata', clearVideoError);
  interpreterVideo.addEventListener('loadeddata', clearVideoError);

  if (subtitleTrack.track) {
    setSubtitleVisible(subtitleToggle.checked);
  }
  subtitleTrack.addEventListener('load', function () {
    if (subtitleTrack.track) setSubtitleVisible(subtitleToggle.checked);
  });

  initSources();

  // --- Keyboard and remote control (HbbTV-style); works locally and on TV ---
  (function () {
    var VK_ENTER = typeof window.VK_ENTER !== 'undefined' ? window.VK_ENTER : 13;
    var VK_PAUSE = typeof window.VK_PAUSE !== 'undefined' ? window.VK_PAUSE : 19;
    var VK_PLAY = typeof window.VK_PLAY !== 'undefined' ? window.VK_PLAY : 415;
    var VK_STOP = typeof window.VK_STOP !== 'undefined' ? window.VK_STOP : 413;
    var VK_LEFT = typeof window.VK_LEFT !== 'undefined' ? window.VK_LEFT : 37;
    var VK_UP = typeof window.VK_UP !== 'undefined' ? window.VK_UP : 38;
    var VK_RIGHT = typeof window.VK_RIGHT !== 'undefined' ? window.VK_RIGHT : 39;
    var VK_DOWN = typeof window.VK_DOWN !== 'undefined' ? window.VK_DOWN : 40;
    var VK_BACK = typeof window.VK_BACK !== 'undefined' ? window.VK_BACK : 8;

    var positions = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
    var sizes = ['small', 'medium', 'large'];

    document.addEventListener('keydown', function (e) {
      var key = e.keyCode || e.which;
      var keyChar = (e.key || '').toLowerCase();

      if (key === 32) e.preventDefault(); // Space

      if (key === VK_ENTER || key === 13 || key === 32) {
        syncPlay();
        e.preventDefault();
        return;
      }
      if (key === VK_PAUSE || key === 19 || keyChar === 'p') {
        syncPause();
        e.preventDefault();
        return;
      }
      if (key === VK_PLAY || key === 415) {
        syncPlay();
        e.preventDefault();
        return;
      }
      if (key === VK_STOP || keyChar === 'r') {
        syncRestart();
        e.preventDefault();
        return;
      }
      if (keyChar === 'c') {
        subtitleToggle.checked = !subtitleToggle.checked;
        setSubtitleVisible(subtitleToggle.checked);
        e.preventDefault();
        return;
      }
      if (keyChar >= '1' && keyChar <= '6') {
        setOverlayPosition(positions[parseInt(keyChar, 10) - 1]);
        e.preventDefault();
        return;
      }
      if (key >= 49 && key <= 54) {
        setOverlayPosition(positions[key - 49]);
        e.preventDefault();
        return;
      }
      if (keyChar === 's') {
        setOverlaySize('small');
        e.preventDefault();
        return;
      }
      if (keyChar === 'm') {
        setOverlaySize('medium');
        e.preventDefault();
        return;
      }
      if (keyChar === 'l') {
        setOverlaySize('large');
        e.preventDefault();
        return;
      }
    });
  })();
})();
