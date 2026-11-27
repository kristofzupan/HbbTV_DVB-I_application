(function () {
  'use strict';

  function isHbbTV() {
    if (typeof navigator === 'undefined') return false;
    var ua = navigator.userAgent || '';
    return (ua.indexOf('HbbTV') !== -1) || (ua.indexOf('CEHTML') !== -1) || (ua.indexOf('OIPF') !== -1);
  }

  var hbbtv = window.HbbTV = window.HbbTV || {};
  hbbtv.isHbbTV = isHbbTV();

  function getOwnerApplication() {
    try {
      var mgr = document.getElementById('appManager');
      if (mgr && typeof mgr.getOwnerApplication === 'function') {
        return mgr.getOwnerApplication(document);
      }
    } catch (e) {
    }
    return null;
  }

  hbbtv.showApplication = function () {
    var app = getOwnerApplication();
    if (!app) { return false; }
    try {
      app.show();
      app.activate();
      return true;
    } catch (e) {
      console.warn('[HbbTV] show/activate failed:', e && e.message);
      return false;
    }
  };

  hbbtv.KEYSET = {
    RED: 0x1, GREEN: 0x2, YELLOW: 0x4, BLUE: 0x8,
    NAVIGATION: 0x10, VCR: 0x20, SCROLL: 0x40, INFO: 0x80, NUMERIC: 0x100
  };

  hbbtv.VK_SUBTITLE = (typeof KeyEvent !== 'undefined' && KeyEvent.VK_SUBTITLE) || 460;

  hbbtv.requestKeys = function (mask, otherKeys) {
    var app = getOwnerApplication();
    if (!app) { return false; }
    try {
      var keyset = app.privateData.keyset;
      var wanted = mask | (keyset.value || 0);
      if (otherKeys && otherKeys.length) {
        try {
          keyset.setValue(wanted, otherKeys);
        } catch (e) {
          console.warn('[HbbTV] keyset rejected other keys (' + (e && e.message) +
                       ') — retrying without them');
          keyset.setValue(wanted);
        }
      } else {
        keyset.setValue(wanted);
      }
      console.log('[HbbTV] keyset requested 0x' + mask.toString(16) +
                  ', now 0x' + (keyset.value || wanted).toString(16));
      return true;
    } catch (e) {
      console.warn('[HbbTV] keyset.setValue failed:', e && e.message);
      return false;
    }
  };

  hbbtv.bindToCurrentChannel = function () {
    var bc = document.getElementById('broadcastVideo');
    if (!bc || typeof bc.bindToCurrentChannel !== 'function') { return false; }
    try {
      bc.bindToCurrentChannel();
      bc.style.width  = '100%';
      bc.style.height = '100%';
      bc.style.zIndex = '-1';
      bc.style.visibility = 'visible';
      return true;
    } catch (e) {
      console.warn('[HbbTV] bindToCurrentChannel failed:', e && e.message);
      return false;
    }
  };

  var MPD_TICKS_PER_SEC = 1000;

  hbbtv.startTimelineClock = function (manifestUrl, done) {
    var factory = window.oipfObjectFactory;
    var bc = document.getElementById('broadcastVideo');
    if (!factory || typeof factory.createMediaSynchroniser !== 'function' || !bc) {
      done(null);
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', manifestUrl, true);
    xhr.onload = function () {
      var m = /<Period[^>]*\sid="([^"]+)"/.exec(xhr.responseText || '');
      if (!m) {
        console.warn('[HbbTV] MediaSynchroniser: manifest Period has no id, no clock');
        done(null);
        return;
      }
      var selector = 'urn:dvb:css:timeline:mpd:period:rel:' + MPD_TICKS_PER_SEC + ':' + m[1];
      try {
        var ms = factory.createMediaSynchroniser();
        ms.onError = function (code) {
          console.warn('[HbbTV] MediaSynchroniser error ' + code);
        };
        ms.initMediaSynchroniser(bc, selector);
        console.log('[HbbTV] MediaSynchroniser clock on ' + selector);
        done(ms);
      } catch (e) {
        console.warn('[HbbTV] MediaSynchroniser failed:', e && e.message);
        done(null);
      }
    };
    xhr.onerror = function () { done(null); };
    xhr.send();
  };

  function onHide() {
    var main = document.getElementById('mainVideo');
    var interp = document.getElementById('interpreterVideo');
    if (main && main.pause) main.pause();
    if (interp && interp.pause) interp.pause();
  }

  if (document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) onHide();
    });
    window.addEventListener('pagehide', onHide);
  }

  hbbtv.requestFullscreen = function () {
    var el = document.documentElement;
    if (!el) return Promise.reject(new Error('No document element'));
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    if (el.msRequestFullscreen) return el.msRequestFullscreen();
    return Promise.reject(new Error('Fullscreen not supported'));
  };

  hbbtv.exitFullscreen = function () {
    var doc = document;
    if (doc.exitFullscreen) return doc.exitFullscreen();
    if (doc.webkitExitFullscreen) return doc.webkitExitFullscreen();
    if (doc.msExitFullscreen) return doc.msExitFullscreen();
    return Promise.reject(new Error('Exit fullscreen not supported'));
  };

  hbbtv.toggleFullscreen = function () {
    var isFull = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
    return isFull ? hbbtv.exitFullscreen() : hbbtv.requestFullscreen();
  };
  if (window.tizen && tizen.tvinputdevice) {
    var tizenKeys = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Back'];
    tizenKeys.forEach(function (name) {
      try { tizen.tvinputdevice.registerKey(name); } catch (e) {}
    });
  }
})();
