/**
 * HbbTV bridge: lifecycle, fullscreen, and environment detection.
 * Safe no-op when not running in an HbbTV stack (browser, emulator).
 */
(function () {
  'use strict';

  function isHbbTV() {
    if (typeof navigator === 'undefined') return false;
    var ua = navigator.userAgent || '';
    return (ua.indexOf('HbbTV') !== -1) || (ua.indexOf('CEHTML') !== -1) || (ua.indexOf('OIPF') !== -1);
  }

  var hbbtv = window.HbbTV = window.HbbTV || {};
  hbbtv.isHbbTV = isHbbTV();

  /**
   * The OIPF application object for this document, or null off-HbbTV.
   */
  function getOwnerApplication() {
    try {
      var mgr = document.getElementById('appManager');
      if (mgr && typeof mgr.getOwnerApplication === 'function') {
        return mgr.getOwnerApplication(document);
      }
    } catch (e) {
      // Terminal refused, or the object was never instantiated.
    }
    return null;
  }

  /**
   * Make the application visible. HbbTV applications start hidden; without this
   * the overlay is running but nothing is drawn on screen.
   * Returns true if the terminal accepted the call.
   */
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

  /**
   * Key masks from OIPF DAE table 8-3, as used by HbbTV (TS 102 796 clause
   * 10.2.2). NAVIGATION covers the arrows, OK and BACK.
   */
  hbbtv.KEYSET = {
    RED: 0x1, GREEN: 0x2, YELLOW: 0x4, BLUE: 0x8,
    NAVIGATION: 0x10, VCR: 0x20, SCROLL: 0x40, INFO: 0x80, NUMERIC: 0x100
  };

  /**
   * The subtitle key is not part of any keyset mask. It belongs to the "other
   * keys" list, which HbbTV 2.0.1 added a second setValue() argument for, and
   * a terminal is free to refuse it. 460 is the OIPF DAE value, used when the
   * terminal does not expose a KeyEvent object to read it from.
   */
  hbbtv.VK_SUBTITLE = (typeof KeyEvent !== 'undefined' && KeyEvent.VK_SUBTITLE) || 460;

  /**
   * Ask the terminal to deliver the keys this application actually handles.
   *
   * A terminal keeps every key to itself until an application requests it by
   * mask: without this call the colour buttons change nothing and the arrows
   * drive the terminal's own UI, so the handlers in app.js never fire and the
   * overlay cannot be moved, resized or switched off. In a browser there is no
   * such gate, which is why this is invisible until the app reaches a TV.
   *
   * Which application this configures depends on how the overlay was launched.
   * Started from the XML AIT it is its own HbbTV application and this sets its
   * own keyset. Hosted in an iframe by the DVB-I client it is not a separate
   * application at all — getOwnerApplication returns the *client's* object, and
   * this widens the client's mask instead, which is what makes the keys reach
   * the iframe the client has already focused. Both paths want the same call.
   *
   * The existing mask is preserved: on the hosted path the client registered
   * keys for its own UI, and replacing its value outright would break the
   * channel bar and EPG to fix the overlay.
   *
   * Returns true if the terminal accepted the call.
   */
  hbbtv.requestKeys = function (mask, otherKeys) {
    var app = getOwnerApplication();
    if (!app) { return false; }
    try {
      var keyset = app.privateData.keyset;
      var wanted = mask | (keyset.value || 0);
      // The two-argument form is HbbTV 2.0.1 and later. Older terminals throw
      // on the extra argument, and losing the colour keys to gain a subtitle
      // key we may not be granted anyway is a bad trade — so fall back.
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

  /**
   * Bind to whatever the terminal is currently presenting, and leave it alone.
   *
   * This is what makes the app a well-behaved type 1.1 linked application: the
   * terminal keeps presenting the service (broadcast, or a DVB-I DASH instance
   * via the native player), and the app contributes only the overlay. Without a
   * realized video/broadcast object, any broadband video the app starts causes
   * the terminal to suspend the channel — see TS 102 796 clause A.2.1.
   *
   * Returns true only if the terminal actually bound; the caller then knows not
   * to start a player of its own.
   */
  hbbtv.bindToCurrentChannel = function () {
    var bc = document.getElementById('broadcastVideo');
    if (!bc || typeof bc.bindToCurrentChannel !== 'function') { return false; }
    try {
      bc.bindToCurrentChannel();
      // Only now give it the screen. Until a terminal has accepted the call the
      // object stays zero-sized and hidden, so a browser never paints a
      // "plugin not supported" placeholder in its place.
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

  /**
   * A readable clock for the picture the terminal is presenting.
   *
   * A video/broadcast object has no playback position, and TS 102 796
   * clause 13.11.2 points to MediaSynchroniser for that: initialised with the
   * video/broadcast object as master media, its currentTime property reports the
   * master's position in seconds on the chosen timeline, accurate to 100 ms
   * (clause 13.11.3), with no other media object needing to be added. That is
   * what the software decoders need, since a canvas is not a media object that
   * the terminal could synchronise for us.
   *
   * The timeline is the DASH period-relative one, on the manifest the terminal
   * is presenting. It equals media presentation time where the Period starts at
   * zero and has no presentationTimeOffset, as ours does, which is what the
   * decoders read segment times against.
   *
   * NOT TESTED. Neither the DVB-I reference client nor HybridTv Viewer provides
   * oipfObjectFactory.createMediaSynchroniser, so here this calls back with null
   * and the caller keeps the clock it already had. Unverified on a terminal:
   * that the period-relative selector is accepted for a video/broadcast master
   * presenting a DVB-I DASH instance (Table 18 lists it for broadband streaming).
   *
   * Calls back with the MediaSynchroniser, or null when it was not started.
   */
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

  /**
   * Lifecycle: when app is hidden or closed, pause playback (like HbbTV "stop").
   */
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

  /**
   * Fullscreen: use standard Fullscreen API (supported in many HbbTV browsers).
   * Call from app when user requests fullscreen (e.g. remote key or button).
   */
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
  /**
   * Tizen TV: register special remote keys so they fire keydown events.
   * Without registration, colored buttons and Back produce no keydown.
   * Safe no-op on non-Tizen platforms.
   */
  if (window.tizen && tizen.tvinputdevice) {
    var tizenKeys = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Back'];
    tizenKeys.forEach(function (name) {
      try { tizen.tvinputdevice.registerKey(name); } catch (e) {}
    });
  }
})();
