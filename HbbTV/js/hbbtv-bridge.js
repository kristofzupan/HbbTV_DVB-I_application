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
})();
