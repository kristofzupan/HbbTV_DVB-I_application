/**
 * User-test sessions, on the television side.
 *
 * Loaded by the DVB-I client page (frontend/android/player.html) and by the
 * signer application (hbbtv-app/index.html). Three jobs:
 *
 *   1. Reset. The top-level page polls test/state.php. When the control page
 *      starts a new participant the counter changes, and the page reloads:
 *      the client comes back on channel 1, the application in its defaults.
 *
 *   2. Resume. Leaving the client with HOME does not close it on Android TV;
 *      the WebView is only paused, with everything as it was. Coming back, the
 *      player is minutes behind a live window of one minute and the stream is
 *      lost. The page reloads instead, which also clears whatever state the
 *      previous viewer left. Recognised by visibilitychange, and by the keydown
 *      82 the APK's MainActivity.onResume() dispatches into the page.
 *
 *   3. Logging. TestSession.log(source, action, state, key) queues an event; the
 *      queue is sent to test/log.php every two seconds and kept in
 *      localStorage until it has been, so a reload or a network drop loses
 *      nothing.
 *
 * Only the top-level page polls, reloads and sends. The application, when the
 * client hosts it in an iframe, hands its events to the client's instance, so
 * there is one queue, one device id and one session per television.
 *
 * ES5 and XMLHttpRequest throughout: this runs in television browsers.
 */
(function () {
  'use strict';

  // Same origin, so the hosting client's instance is reachable. On another
  // origin this throws, and the application behaves as its own top page.
  try {
    if (window.parent !== window && window.parent.TestSession) {
      window.TestSession = window.parent.TestSession;
      return;
    }
  } catch (e) { /* cross-origin parent */ }

  var POLL_MS = 2000;
  var FLUSH_MS = 2000;
  var HEARTBEAT_MS = 30000;
  // onResume() fires on a cold start too, while the page is still loading; a
  // reload then would loop. Anything that early is a start, not a return.
  var RESUME_GRACE_MS = 5000;
  var MAX_QUEUE = 2000;
  var QUEUE_KEY = 'testSession.queue';
  var DEVICE_KEY = 'testSession.device';

  // Resolved from this script's own address, so it works from the client page
  // and from the application alike: …/hbbtv-app/js/test-session.js → …/test/
  var script = document.currentScript ||
    (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var BASE = script.src.replace(/hbbtv-app\/js\/test-session\.js.*$/, 'test/');

  var loadedAt = Date.now();
  var session = null;      // null until the first poll answers
  var counter = null;
  var reloading = false;
  var heartbeatState = null;

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* full or blocked */ }
  }

  // Only the test television is recorded. The APK injects android_interface
  // into the page (WebViewConfiguration.java); a browser has nothing of the
  // kind, so someone watching online, or the experimenter checking from a
  // laptop mid-test, does not end up in a participant's results. ?testlog=1
  // records a browser anyway, for trying the logging out. Unrecorded pages
  // still reload on a reset and on return, which is harmless.
  var RECORD = typeof window.android_interface !== 'undefined' ||
               /[?&]testlog=1(&|$)/.test(window.location.search);

  // Stable across reloads on the television. A browser keeps its id per tab
  // instead: tabs share localStorage, and two tabs under one id would read as
  // one television flicking between two states.
  var device;
  if (typeof window.android_interface !== 'undefined') {
    device = storageGet(DEVICE_KEY);
    if (!device) {
      device = 'tv-' + Math.random().toString(36).slice(2, 10);
      storageSet(DEVICE_KEY, device);
    }
  } else {
    try { device = window.sessionStorage.getItem(DEVICE_KEY); } catch (e) { device = null; }
    if (!device) {
      device = 'browser-' + Math.random().toString(36).slice(2, 10);
      try { window.sessionStorage.setItem(DEVICE_KEY, device); } catch (e) { /* blocked */ }
    }
  }

  var queue;
  try { queue = JSON.parse(storageGet(QUEUE_KEY) || '[]'); } catch (e) { queue = []; }
  if (!(queue instanceof Array)) queue = [];

  function persist() {
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    storageSet(QUEUE_KEY, JSON.stringify(queue));
  }

  function log(source, action, state, key) {
    if (!RECORD) return;
    queue.push({
      t: Date.now(),
      device: device,
      // Stamped now when known. Events from before the first poll are stamped
      // when sent, which is moments later and in the same session.
      session: session,
      source: source,
      action: action,
      key: key || null,
      state: state || {}
    });
    persist();
  }

  var sending = false;
  function flush() {
    if (sending || !queue.length || session === null) return;
    var batch = queue.slice(0, 200);
    for (var i = 0; i < batch.length; i++) {
      if (batch[i].session === null) batch[i].session = session;
    }
    sending = true;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + 'log.php');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      sending = false;
      if (xhr.status === 200) {
        queue.splice(0, batch.length);
        persist();
      }
    };
    xhr.onerror = xhr.ontimeout = function () { sending = false; };
    xhr.timeout = 10000;
    xhr.send(JSON.stringify(batch));
  }

  function reload(reason) {
    if (reloading) return;
    reloading = true;
    log('tv', reason, {});
    // The queue is in localStorage already; the new page sends it.
    window.location.reload();
  }

  function poll() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', BASE + 'state.php?_=' + Date.now());
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      var s;
      try { s = JSON.parse(xhr.responseText); } catch (e) { return; }
      if (counter !== null && s.counter !== counter) {
        reload('restart_received');
        return;
      }
      counter = s.counter;
      session = s.session || '';
    };
    xhr.timeout = 5000;
    xhr.send();
  }

  function onResume() {
    if (Date.now() - loadedAt < RESUME_GRACE_MS) return;
    reload('returned_to_app');
  }

  var wasHidden = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      wasHidden = true;
      log('tv', 'left_app', {});
      flush();
    } else if (wasHidden) {
      onResume();
    }
  });
  // Dispatched by the APK, never by a remote: a real key press is trusted.
  document.addEventListener('keydown', function (e) {
    if ((e.keyCode === 82 || e.keyCode === '82') && e.isTrusted === false) onResume();
  }, true);

  window.TestSession = {
    log: log,
    // The client registers what a heartbeat should report — the channel and
    // subtitles as they are, which corrects the log if an event was missed.
    setHeartbeatState: function (fn) { heartbeatState = fn; }
  };

  poll();
  setInterval(poll, POLL_MS);
  setInterval(flush, FLUSH_MS);
  setInterval(function () {
    var state = {};
    try { if (heartbeatState) state = heartbeatState() || {}; } catch (e) { /* keep {} */ }
    log('tv', 'still_watching', state);
  }, HEARTBEAT_MS);
  log('tv', 'page_loaded', {});
})();
