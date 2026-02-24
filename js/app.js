/**
 * MVP: Dual video sync + interpreter overlay position/size + subtitle toggle
 * HbbTV/DVB-I accessibility demo
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

  // Prefer local files (same origin) to avoid CORS; fallback to remote only if user enters URLs
  const DEFAULT_MAIN = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  const DEFAULT_INTERPRETER = 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

  function setSource(el, src, type) {
    if (!src) return;
    el.src = src;
    if (type) el.type = type;
  }

  function initSources() {
    const mainUrl = document.getElementById('mainVideoUrl').value.trim();
    const interpUrl = document.getElementById('interpreterVideoUrl').value.trim();
    setSource(mainSource, mainUrl || DEFAULT_MAIN, 'video/mp4');
    setSource(interpreterSource, interpUrl || DEFAULT_INTERPRETER, 'video/mp4');
    clearVideoError();
  }

  function showVideoError(msg) {
    var el = document.getElementById('videoError');
    if (!el) {
      el = document.createElement('p');
      el.id = 'videoError';
      el.className = 'video-error';
      el.setAttribute('role', 'alert');
      document.querySelector('.control-group.sources').insertBefore(el, document.querySelector('.sources label'));
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function clearVideoError() {
    var el = document.getElementById('videoError');
    if (el) el.style.display = 'none';
  }

  function syncPlay() {
    const main = mainVideo;
    const interp = interpreterVideo;
    if (main.readyState >= 2 && interp.readyState >= 2) {
      const t = main.currentTime;
      interp.currentTime = Math.min(t, interp.duration);
      interp.play();
      main.play();
    } else {
      main.play().then(function () {
        interp.currentTime = main.currentTime;
        interp.play();
      }).catch(function (e) {
        console.warn('Play failed:', e);
      });
    }
  }

  function syncPause() {
    mainVideo.pause();
    interpreterVideo.pause();
  }

  function syncRestart() {
    mainVideo.currentTime = 0;
    interpreterVideo.currentTime = 0;
    mainVideo.pause();
    interpreterVideo.pause();
  }

  function keepSync() {
    const main = mainVideo;
    const interp = interpreterVideo;
    if (main.paused || interp.paused) return;
    const diff = Math.abs(main.currentTime - interp.currentTime);
    if (diff > 0.5) {
      interp.currentTime = main.currentTime;
    }
  }

  mainVideo.addEventListener('timeupdate', keepSync);
  mainVideo.addEventListener('seeked', function () {
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
    showVideoError('Main video failed to load. Put main.mp4 in the videos/ folder and run from a local server (see README).');
  });
  interpreterVideo.addEventListener('error', function () {
    showVideoError('Interpreter video failed to load. Put interpreter.mp4 in the videos/ folder and run from a local server (see README).');
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
