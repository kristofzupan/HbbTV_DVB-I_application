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
  var subtitleEl        = document.getElementById('subtitles');
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
  // True once the terminal's own presentation is driving the main picture, in
  // which case the app neither plays nor has a clock for it.
  var terminalPresentsMain  = false;
  var mediaSync             = null;   // MediaSynchroniser giving the terminal picture's position, if provided
  // True only when this application is itself playing the main picture, which
  // is a browser-only situation. Set once per initSources(); everything that
  // waits on the main video reads it through noMainToAwait() rather than
  // re-deriving the condition, so no path can decline to start a player and
  // still leave the decoder waiting for a 'playing' event that cannot arrive.
  var appPresentsMain       = false;

  // ── UI state ───────────────────────────────────────────────────────────────
  var interpreterVisible = true;

  // Position grid: [row][col] — 3 rows × 3 cols
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
  // Top right by default. The bottom of the screen belongs to subtitles: they
  // are authored in the conventional bottom region, a terminal renders them
  // with no knowledge of this overlay, and nothing in DVB-I or HbbTV lets the
  // two negotiate the space. The overlay is the part under our control, so it
  // is the part that moves. The viewer can still put it anywhere.
  var posRow = 0; // top
  var posCol = 2; // right  (default: tr)

  // 7 size steps — widths only (vw); height computed from detected video ratio.
  // The largest is 50, not 55: the signer is square, and on a 16:9 screen 55vw
  // is 98% of the height, which leaves no room to move it between rows.
  var SIZE_WIDTHS    = [10, 15, 20, 27, 35, 44, 50];
  var DEFAULT_SIZE_IDX = 3;
  var sizeIdx        = DEFAULT_SIZE_IDX;
  var videoRatio     = 3 / 4; // default 4:3; updated from stream on first frame

  var toastTimer = null;
  var interpreterLoading = false;
  var loadingPoll = null;
  var LOADING_MSG = 'Nalaganje tolmača...';
  var hintTimer  = null;
  var HINT_SHOW_MS = 6000;

  // Seconds behind the live edge to hold the main picture, so the interpreter
  // decoder has whole segments available at the time the main video is showing.
  // Three 4 s segments; must stay well inside the manifest's 60 s window.
  var LIVE_DELAY_SEC = 12;

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

    // Hold playback further behind the live edge than dash.js would choose on
    // its own. The software-decoded interpreter can only present segments that
    // are already written to the manifest, so if the main picture plays closer
    // to live than that, the overlay can never reach it — no amount of clock
    // correction helps. A few seconds of extra latency in exchange for an
    // interpreter that is actually aligned is the right trade here.
    // (dash.js 4.4+ nests this under `delay`; the flat key covers older builds.)
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

  // ── Source initialisation ──────────────────────────────────────────────────
  function initSources() {
    var urlParams = getUrlParams();
    // Both defaults are the combined manifest, not the separate main/interpreter
    // ones: those stopped being published when the two tracks moved into a single
    // encoder, and a default that 404s costs nothing at load time — it fails
    // inside the decoder's retry loop, which reports to the console and leaves an
    // empty overlay on screen. dash.js takes the main role from this manifest and
    // the software decoder takes the sign role, so they also share a timeline.
    var COMBINED_MPD = 'http://localhost:9080/stream/live/combined/stream.mpd';
    var mainUrl   = urlParams.main        || COMBINED_MPD;
    var interpUrl = urlParams.interpreter || COMBINED_MPD;

    interpreterOnlyMode   = !!(urlParams.interpreter && !urlParams.main);
    currentMainUrl        = mainUrl;
    currentInterpreterUrl = interpUrl;

    mainDashPlayer        = destroyDashPlayer(mainDashPlayer);
    interpreterDashPlayer = destroyDashPlayer(interpreterDashPlayer);
    if (wasmDecoder) { wasmDecoder.stop(); wasmDecoder = null; }

    // On a terminal, the main picture is the terminal's to present and ours to
    // leave alone. Binding to the current channel keeps that presentation alive;
    // starting our own player instead would suspend it.
    terminalPresentsMain = HbbTV.bindToCurrentChannel();
    if (terminalPresentsMain) {
      console.log('[App] bound to the terminal\'s channel — overlay only');
      // The terminal's picture has no position we can read directly; ask
      // MediaSynchroniser for one. Until it answers, or if it is absent, the
      // decoder paces itself, as before.
      if (!mediaSync) {
        HbbTV.startTimelineClock(currentInterpreterUrl, function (ms) { mediaSync = ms; });
      }
    }

    // Presenting the main picture is a browser affordance, never a terminal one.
    // The two flags above cover every path we launch deliberately — the AIT
    // passes ?interpreter= with no ?main=, and a bound terminal sets
    // terminalPresentsMain — but both are conditions that happen to hold rather
    // than guarantees. bindToCurrentChannel() returns false whenever a terminal
    // refuses or throws, which is what an older one does, and the parameterless
    // default above is the full-screen combined manifest. Those two together
    // would start broadband video with no realized video/broadcast object, and
    // the terminal would suspend the channel (TS 102 796 clause A.2.1) —
    // blacking out the programme this overlay exists to accompany. Refusing on
    // any HbbTV stack makes that structurally impossible rather than unlikely.
    // ?main= is an explicit instruction to present the picture, and the only
    // thing that lifts the refusal above. An emulator carries an HbbTV user
    // agent while nothing is actually presenting anything, so without this the
    // app correctly declines to play and leaves a blank screen with no clock —
    // safe on a television, useless on a desk. Launched from the AIT there is
    // never a ?main=, so a real terminal still cannot reach this path.
    appPresentsMain = !interpreterOnlyMode && !terminalPresentsMain &&
                      (!HbbTV.isHbbTV || !!urlParams.main);
    if (appPresentsMain) {
      mainDashPlayer = createDashPlayer(mainVideo, currentMainUrl, true);
    } else {
      // Nothing will ever be decoded into it, and at z-index 0 over the full
      // screen an empty video element is an opaque black rectangle sitting on
      // top of whatever is presenting the picture.
      mainVideo.style.display = 'none';
    }

    // Someone else is presenting the picture, so stop painting over it.
    var overlayOnly = noMainToAwait();
    document.documentElement.classList.toggle('overlay-mode', overlayOnly);
    document.body.classList.toggle('overlay-mode', overlayOnly);

    applyDecoderMode(decoderMode);
    clearError();
  }

  // ── Decoder mode ───────────────────────────────────────────────────────────

  // The interpreter decoder normally waits for the main video to start, so the
  // two come up together. When the app is not playing the main picture — the
  // terminal is, we were launched interpreter-only, or we are on an HbbTV stack
  // at all — there is no such event, and waiting for it would mean the overlay
  // never appears. The three places in applyDecoderMode() that would otherwise
  // start a main player of their own are gated on this too, so the refusal
  // above holds for every decoder path rather than only the initial one.
  function noMainToAwait() {
    return !appPresentsMain;
  }

  function stopVideoCanvas() {
    if (videoCanvasRafId) { cancelAnimationFrame(videoCanvasRafId); videoCanvasRafId = null; }
  }

  // Draw a source into the canvas preserving aspect ratio (letterbox/pillarbox).
  // WasmDecoder has its own copy of this for its YUV output; keeping one here
  // rather than reaching into that module's scope is what stops the two from
  // drifting apart — and reaching into it was a ReferenceError, since only the
  // decoder constructor is exported.
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
            // Canvas dimensions are re-read each frame: adaptToVideoRatio resizes
            // the buffer once the stream's real dimensions are known.
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
    if (noMainToAwait() || !mainVideo.paused) { startNative(); }
    else { mainVideo.addEventListener('playing', startNative); }
  }

  // ── Master clock ───────────────────────────────────────────────────────────
  // Position of the main video on the manifest's period timeline. When main and
  // interpreter come from one manifest they share that timeline, so this is what
  // the software decoder presents the signer against — the app-side equivalent
  // of what MediaSynchroniser does on an HbbTV 2.0.4 terminal.
  // Returns 0 when there is no main video to follow (interpreter-only mode, or
  // playback has not started), which tells the decoder to pace itself instead.
  // Returns 0 when there is nothing to follow: interpreter-only mode, playback
  // not started, or the terminal presenting the main picture itself — a
  // video/broadcast object exposes no presentation timeline, which is the gap
  // MediaSynchroniser is meant to fill. The decoder then paces itself.
  // When the app runs as an overlay inside a DVB-I client, the main picture is a
  // video element in the hosting page. Same-origin embedding lets the overlay
  // read that element's position directly — the browser-side equivalent of what
  // MediaSynchroniser provides on a terminal, which has no such reach.
  var hostVideo = null;
  var warnedNoHostClock = false;

  // Losing the host clock is not fatal — the decoder falls back to pacing itself
  // against the live edge — but it silently costs synchronisation, which looks
  // like a decoder fault rather than a broken bridge. Say it once, out loud.
  function warnNoHostClock(reason) {
    if (warnedNoHostClock) { return; }
    warnedNoHostClock = true;
    console.warn('[App] no host video clock (' + reason + ') — the interpreter ' +
                 'will pace itself against the live edge and drift from the main picture');
  }

  function findHostVideo() {
    if (window.parent === window) { return null; }
    try {
      var doc = window.parent.document;   // throws when cross-origin
      var v = doc.getElementById('video') ||
              doc.getElementsByTagName('video')[0] || null;
      if (v) { console.log('[App] host video clock acquired'); }
      else   { warnNoHostClock('host page has no video element'); }
      return v;
    } catch (e) {
      // Hosted cross-origin: no clock reachable from here. Usually means the AIT
      // URLBase and the page the client was opened from are different hosts.
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
    // A terminal is presenting: video/broadcast has no playback position, so
    // read it from MediaSynchroniser (TS 102 796 clause 13.11.3) when the
    // terminal provides one. NaN, before the timeline is available, and 0, with
    // no MediaSynchroniser, both mean nothing to follow: the decoder paces itself.
    if (terminalPresentsMain) { return mediaSync ? (mediaSync.currentTime || 0) : 0; }
    // We are playing the main picture ourselves.
    if (!interpreterOnlyMode && mainVideo) { return mainVideo.currentTime || 0; }
    // Overlay inside a same-origin host: follow the host's picture.
    return hostVideoTime();
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
  // While the interpreter is loading, the toast holds a loading message instead
  // of disappearing: a key's toast still shows for its 1.5 s, then hands back to
  // it. Until the first frame the overlay is empty, which otherwise looks broken.
  function showToast(msg) {
    var el = document.getElementById('toast');
    if (!el) { return; }
    el.textContent = msg;
    el.style.display = 'block';
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (interpreterLoading) { el.textContent = LOADING_MSG; }
      else { el.style.display = 'none'; }
    }, 1500);
  }

  // The decoder reports its first picture when it is decoded, but at startup
  // that picture is usually dropped or held until the main video catches up,
  // so the signer appears seconds later. The loading message waits for the
  // first frame actually drawn, which the decoder counts in getStats().
  // native and video-canvas have no decoder object; 'loadeddata' ends theirs.
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
    if (toastTimer) { return; } // a toast is up; its timeout picks this up
    var el = document.getElementById('toast');
    if (!el) { return; }
    if (on) { el.textContent = LOADING_MSG; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  }

  function onInterpreterError(msg) {
    setInterpreterLoading(false);
    showError(msg);
  }

  // ── Hint bar ───────────────────────────────────────────────────────────────
  // Shown at startup and after every key, then faded out. Left up for good it
  // would sit over the lower part of the picture, and the signer's hands.
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
  // Announced only when the viewer changed the size. At startup and when the
  // stream's ratio arrives the toast would cover "Nalaganje tolmača...".
  function applySize(announce) {
    var w = SIZE_WIDTHS[sizeIdx];
    overlay.style.width  = w + 'vw';
    overlay.style.height = (w * videoRatio).toFixed(3) + 'vw';
    if (announce) { showToast('Velikost ' + (sizeIdx + 1) + ' / ' + SIZE_WIDTHS.length); }
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
  // The software decoders choose their first segment from the master clock
  // once, when they start. Started before the main picture has a position —
  // the host video still held by autoplay, say — they read 0, guess from the
  // live edge instead, land seconds behind the picture and drop frames until
  // they catch up: a stutter on exactly the fast starts. So wait for a
  // position, but not forever: with no clock at all (a terminal without
  // MediaSynchroniser, interpreter-only mode) the decoder has to pace itself
  // anyway, and only the wait is lost.
  var MASTER_WAIT_MS = 5000;
  var masterWaitGen  = 0;

  function whenMasterReady(fn) {
    var gen = ++masterWaitGen;
    var waited = 0;
    (function check() {
      if (gen !== masterWaitGen) { return; } // stopped or restarted meanwhile
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
      showToast('Tolmač VKLOPLJEN');
    } else {
      overlay.classList.add('hidden');
      stopInterpreterDecoder();
      showToast('Tolmač IZKLOPLJEN');
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

  // ── On-screen diagnostic ───────────────────────────────────────────────────
  // Every way this application can fail on a television reports to a console no
  // one can read there. The panel below shows the same facts on the screen, and
  // takes itself away as soon as frames are reaching the canvas, so a working
  // deployment looks no different than it did before. Key 0 brings it back.
  //
  // "decoded" rising while "drawn" stays at 0 means the decoder is fine and the
  // render path is not — the single most useful distinction here, and the one
  // that is invisible from the picture alone.
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

    // Hidden unless the viewer asks for it with 0.
    //
    // It used to show itself whenever no frame had been drawn yet, which sounds
    // conservative but meant it appeared during every start and every channel
    // change — a green debug panel over the picture, in exactly the configuration
    // a viewer sees. It also stayed up for as long as anything was wrong, which
    // is the worst moment to be covering the screen with monospace text.
    //
    // Nothing is lost by hiding it: real failures surface on their own through
    // showError() and #errorOverlay, which is a separate element and unaffected
    // by this. The panel is a development instrument, so it now behaves like one.
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
    // Always report the number masterClock() actually returns, whatever the
    // mode. Labelling interpreter-only as "none" described the launch path
    // rather than the clock, and hid the one value worth seeing in exactly the
    // mode the application is launched in from an AIT — where the clock does
    // exist, read from the hosting page. Subtitles depend on it directly, so
    // the loop position and active cue are shown beside it.
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

  // ── TV remote key handler ──────────────────────────────────────────────────
  var VK_LEFT   = 37;
  var VK_UP     = 38;
  var VK_RIGHT  = 39;
  var VK_DOWN   = 40;
  var VK_RED    = 403; var VK_RED2    = 183; // HbbTV / Android
  var VK_GREEN  = 404; var VK_GREEN2  = 184;
  var VK_YELLOW = 405; var VK_YELLOW2 = 185;
  var VK_BLUE   = 406; var VK_BLUE2   = 186;
  var VK_0      = 48;
  var VK_ENTER  = 13;
  // Not part of any keyset mask — requested separately, and a terminal may
  // refuse it, which is why OK toggles subtitles as well.
  var VK_SUBTITLE = HbbTV.VK_SUBTITLE;

  showHintBar();

  document.addEventListener('keydown', function (e) {
    var key = e.keyCode || e.which;
    showHintBar();

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

      case VK_GREEN:
      case VK_GREEN2:
        if (sizeIdx < SIZE_WIDTHS.length - 1) { sizeIdx++; applySize(true); }
        else { showToast('Največja velikost'); }
        e.preventDefault();
        break;

      case VK_YELLOW:
      case VK_YELLOW2:
        if (sizeIdx > 0) { sizeIdx--; applySize(true); }
        else { showToast('Najmanjša velikost'); }
        e.preventDefault();
        break;

      case VK_BLUE:
      case VK_BLUE2:
        // Grey behind the keyed signer, for a viewer who finds the cut-out hard
        // to follow against a busy or dark picture.
        overlay.classList.toggle('grey-bg');
        showToast(overlay.classList.contains('grey-bg') ? 'Sivo ozadje' : 'Prosojno ozadje');
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

  // ── Video dimension detection ──────────────────────────────────────────────
  interpreterVideo.addEventListener('loadedmetadata', function () {
    adaptToVideoRatio(interpreterVideo.videoWidth, interpreterVideo.videoHeight);
  });

  // native and video-canvas show a frame as soon as the element has one.
  interpreterVideo.addEventListener('loadeddata', function () {
    setInterpreterLoading(false);
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

  // ── Subtitles ─────────────────────────────────────────────────────────────
  // Rendered by this application rather than the terminal, and signalled in the
  // service list as SubtitleCarriageCS "app" — a real value in the DVB scheme,
  // not a workaround. The conformant alternative is an EBU-TT-D AdaptationSet
  // in the manifest, which ffmpeg's DASH muxer cannot produce: it labels a TTML
  // track as contentType="audio" and refuses WebVTT outright. See
  // subtitles/main_slv.xml for the EBU-TT-D the conformant path would carry.
  //
  // The cost is real and belongs in any honest account of this: the viewer's
  // font size, colour and contrast preferences live in the television's own
  // subtitle settings, and an application that draws its own text does not
  // inherit them. What it buys is that one renderer owns both access services,
  // so the signer and the subtitles can be positioned with knowledge of each
  // other — which nothing in DVB-I or HbbTV otherwise allows.

  // The programme loops, and the cues come from outside the stream, so they
  // have to be folded back into the loop by hand. The signer needs none of
  // this: it is an AdaptationSet inside the manifest, so it loops with the
  // content for free. That asymmetry is the whole argument for in-band
  // subtitles — this constant is the price of not having them.
  //
  // 249.856, not the 249.8 the video runs for. ffmpeg's -stream_loop advances
  // the timeline by the longest stream, and the AAC audio outlasts the video:
  // 11712 frames x 1024 samples / 48000 Hz = 249.856 s, against 6245 frames at
  // 25 fps = 249.8 s.
  //
  // Those 56 ms are invisible in one loop and fatal across many, because the
  // error is multiplied by the loop count rather than staying put. Measured
  // against the live stream after five days of encoder uptime — 1670 loops —
  // the cues were 94 seconds out. Restarting the encoder made them correct
  // again, which is what confirmed the cause: a fresh stream has no loops to
  // multiply, so any value works until the drift builds back up.
  //
  // Verified by fetching a segment at a known presentation time, decoding its
  // first frame, and matching it against the source at the position this value
  // predicts — the same frame, where 249.8 pointed 94 seconds away.
  //
  // This is a property of the encoded source, not of the standard. Re-measure
  // whenever video_content changes:
  //   ffprobe -v error -select_streams a:0 -show_entries stream=nb_frames \
  //           video_content/source_combined.mp4
  //   loop = nb_frames * 1024 / 48000
  var LOOP_SECONDS  = 249.856;
  var SUBTITLE_URL  = 'subtitles/main_slv.srt';

  var subtitleCues    = [];
  // Whether this application draws the subtitles itself.
  //
  // It no longer needs to. The stream carries them as an EBU-TT-D track in the
  // manifest, encapsulated in ISO BMFF per ETSI TS 103 285 clause 7.1.1, so the
  // terminal renders them and the viewer's own subtitle settings — size, colour,
  // contrast — apply to them. That is the whole reason for putting them in band,
  // and drawing over the top of them would take it away again.
  //
  // Leaving them on was also actively wrong once the loop length changed:
  // LOOP_SECONDS below is 249.856, measured from the old source, and the loop is
  // now exactly 248 s. Cues folded into the wrong length slip 1.856 s further
  // out on every pass.
  //
  // Kept behind a flag rather than deleted, because an application that renders
  // both access services can position the signer and the subtitles with
  // knowledge of each other, and nothing in DVB-I or HbbTV lets a terminal and
  // an application negotiate that. Turning this on demonstrates the alternative;
  // it is not the conformant path.
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
      // Older terminal browsers predate fetch; the overlay still works without
      // subtitles, so degrade rather than taking the application down with us.
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
        // Silence here would look identical to a programme with no dialogue.
        console.warn('[Subs] load failed:', e && e.message);
        showError('Subtitles could not be loaded: ' + (e && e.message));
      });
  }

  // Called from the same animation loop that presents the signer, so both
  // access services are driven by one clock and cannot disagree about where
  // the programme is.
  function updateSubtitles() {
    if (!subtitleEl) { return; }
    if (!subtitlesOn || !subtitleCues.length) {
      // Hide unconditionally rather than only when a cue was active. Guarding
      // on activeCueIndex looks like a cheap way to avoid touching the DOM
      // every tick, but toggleSubtitles() clears that index before calling
      // here, so the guard was always false at exactly the moment it mattered
      // and the cue on screen when the viewer switched subtitles off stayed
      // there for good.
      subtitleEl.style.display = 'none';
      activeCueIndex = -1;
      return;
    }

    var clock = masterClock();
    if (!clock) {
      // No clock: on a terminal there is no presentation timeline to read, the
      // same gap that leaves the signer unsynchronised. Showing cues paced
      // against nothing would put the wrong words on screen, which is worse
      // than showing none.
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
    // The terminal owns the subtitles now, and it offers its own control for
    // them. Claiming the key here would leave the viewer pressing it and seeing
    // nothing happen, which is worse than the key doing nothing at all.
    if (!APP_RENDERED_SUBTITLES) {
      showToast('Podnapisi so zagotovljeni s strani televizorja');
      return;
    }
    subtitlesOn = !subtitlesOn;
    activeCueIndex = -1;
    updateSubtitles();
    showToast('Subtitles ' + (subtitlesOn ? 'on' : 'off'));
  }

  // Neither the fetch nor the 5 Hz timer is worth running when the terminal is
  // the one drawing the subtitles.
  if (APP_RENDERED_SUBTITLES) {
    loadSubtitles();
    setInterval(updateSubtitles, 200);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  // HbbTV applications start hidden; without this the overlay runs but nothing
  // is drawn. No-op in a browser.
  if (HbbTV.showApplication()) {
    console.log('[App] HbbTV application shown and activated');
  }

  // A terminal delivers no key events until an application asks for them, so
  // every handler below is dead on a TV without this. The four colour keys plus
  // NAVIGATION are exactly the set app.js binds: RED toggles the overlay, GREEN
  // and YELLOW resize it, BLUE puts a grey background behind it, the arrows
  // move it and BACK closes the
  // controls. Nothing else is requested — keys an application holds are keys
  // the terminal can no longer use for its own UI.
  // NUMERIC is deliberately absent: on a terminal the number keys are how a
  // viewer types a channel number, and an application holding them takes that
  // away. The subtitle key is asked for separately because it belongs to no
  // mask, and a terminal that refuses it costs nothing here — OK toggles
  // subtitles too.
  HbbTV.requestKeys(
    HbbTV.KEYSET.RED | HbbTV.KEYSET.GREEN | HbbTV.KEYSET.YELLOW |
    HbbTV.KEYSET.BLUE | HbbTV.KEYSET.NAVIGATION,
    [HbbTV.VK_SUBTITLE]
  );

  var bootEl = document.getElementById('dvbi-boot-status');
  if (bootEl) { bootEl.style.display = 'none'; }

  // ── Capability detection ──────────────────────────────────────────────────
  // Resolves to the decoder mode to use. Detection has to finish before the
  // first decoder starts: starting one and switching a moment later spins up a
  // Broadway worker and a WASM instance only to tear them down, which on TV
  // hardware is far from free.
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
    // WebCodecs is gated on a secure context, so the same terminal reports NO
    // over http:// and YES over https:// — and silently changes decoder. Log the
    // context alongside it, or a decoder switch caused by moving to TLS looks
    // like a decoder switch caused by nothing.
    console.log('[Caps] WebCodecs:', wcSupported ? 'YES' : 'NO',
                '(secure context:', window.isSecureContext ? 'yes' : 'no', ')');
    console.log('[Caps] WASM:', wasmSupported ? 'YES' : 'NO');

    if (!mseSupported) {
      showError('MSE not supported — DASH streams cannot play. HbbTV 2.0 required for DASH.');
    }

    // Software decoding is the default, deliberately. Presenting the signer from
    // a second video track on a terminal that has one hardware decoder is the
    // case this work exists to demonstrate, and a decoder that only some
    // terminals have must not quietly replace it — least of all because
    // WebCodecs is gated on a secure context, so moving a deployment from http
    // to https would otherwise change the decoder with nobody choosing to.
    // WebCodecs stays available for comparison: ?decoder=webcodecs.
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

    // No WebAssembly at all: the default cannot run, so take whatever remains
    // rather than showing nothing.
    if (wcSupported && window.WebCodecsDecoder) {
      console.warn('[Caps] no WebAssembly — falling back to WebCodecs');
      return WebCodecsDecoder.isSupported('avc1.42001f')
        .then(function (ok) { return ok ? 'webcodecs' : 'video-canvas'; })
        .catch(function () { return 'video-canvas'; });
    }
    console.warn('[Caps] neither WebAssembly nor WebCodecs — falling back to video-canvas');
    return Promise.resolve('video-canvas');
  }

  // Apply initial size (no CSS class — use inline style)
  applySize();

  detectDecoderMode().then(function (mode) {
    decoderMode = mode;
    initSources();
  });

})();
