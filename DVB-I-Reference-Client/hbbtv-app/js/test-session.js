(function () {
  'use strict';

  try {
    if (window.parent !== window && window.parent.TestSession) {
      window.TestSession = window.parent.TestSession;
      return;
    }
  } catch (e) {}

  var POLL_MS = 2000;
  var FLUSH_MS = 2000;
  var HEARTBEAT_MS = 30000;
  var RESUME_GRACE_MS = 5000;
  var MAX_QUEUE = 2000;
  var QUEUE_KEY = 'testSession.queue';
  var DEVICE_KEY = 'testSession.device';

  var script = document.currentScript ||
    (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var BASE = script.src.replace(/hbbtv-app\/js\/test-session\.js.*$/, 'test/');

  var loadedAt = Date.now();
  var session = null;
  var counter = null;
  var reloading = false;
  var heartbeatState = null;

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) {}
  }

  var ua = navigator.userAgent || '';
  var DEVICE_TYPE =
    typeof window.android_interface !== 'undefined' ? 'android_apk' :
    /Tizen|SMART-TV/i.test(ua) ? 'samsung_tizen' :
    /Web0S|webOS/.test(ua) ? 'lg_webos' :
    /HbbTV/i.test(ua) ? 'hbbtv_tv' :
    'browser';

  var device;
  if (DEVICE_TYPE !== 'browser') {
    device = storageGet(DEVICE_KEY);
    if (!device) {
      device = 'tv-' + Math.random().toString(36).slice(2, 10);
      storageSet(DEVICE_KEY, device);
    }
  } else {
    try { device = window.sessionStorage.getItem(DEVICE_KEY); } catch (e) { device = null; }
    if (!device) {
      device = 'browser-' + Math.random().toString(36).slice(2, 10);
      try { window.sessionStorage.setItem(DEVICE_KEY, device); } catch (e) {}
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
    queue.push({
      t: Date.now(),
      device: device,
      deviceType: DEVICE_TYPE,
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
  document.addEventListener('keydown', function (e) {
    if ((e.keyCode === 82 || e.keyCode === '82') && e.isTrusted === false) onResume();
  }, true);

  window.TestSession = {
    log: log,
    setHeartbeatState: function (fn) { heartbeatState = fn; }
  };

  poll();
  setInterval(poll, POLL_MS);
  setInterval(flush, FLUSH_MS);
  setInterval(function () {
    var state = {};
    try { if (heartbeatState) state = heartbeatState() || {}; } catch (e) {}
    log('tv', 'still_watching', state);
  }, HEARTBEAT_MS);
  log('tv', 'page_loaded', {});
})();
