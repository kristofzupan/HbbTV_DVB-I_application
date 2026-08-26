//
// Remote-control layer for the Android/PWA frontend.
//
// The reference client's mobile frontend is a touch UI: player.html and
// dvbi-mobile.js contain no key handling at all. On a television there is no
// pointer, so without this file nothing on screen can be reached — not even the
// "Ok" of the first-run dialog, which is an <a href="javascript:modalClosed()">
// and answers a click only.
//
// The scope is deliberately narrow: change service, and let a linked
// application keep its own keys. Driving the EPG and the settings screens from
// a remote would mean making every Bootstrap control focusable, which is a
// different job and is not needed to present a service.
//
// Key ownership follows HbbTV: a running application owns the keys it uses. The
// signer overlay uses the colour keys for on/off, size and reset, and the
// arrows to move itself, so the client does not answer those while the
// application is present — it hands them over. Service change is never the
// application's, so the client always keeps it.
//

// Terminals disagree about what a colour key is. This television reports 183
// for red, which is what Android sends as KEYCODE_PROG_RED; a terminal
// following TS 102 796 reports VK_RED, 403. Some report neither and only set
// KeyboardEvent.key. All three are matched, because binding one of them ties
// the client to the set it was written on.
var REMOTE_KEYS = {
  red: { codes: [403, 183], names: ["ColorF0Red", "Red"] },
  green: { codes: [404, 184], names: ["ColorF1Green", "Green"] },
  yellow: { codes: [405, 185], names: ["ColorF2Yellow", "Yellow"] },
  blue: { codes: [406, 186], names: ["ColorF3Blue", "Blue"] },
  channelUp: { codes: [427, 33], names: ["ChannelUp"] },
  channelDown: { codes: [428, 34], names: ["ChannelDown"] },
  up: { codes: [38], names: ["ArrowUp"] },
  down: { codes: [40], names: ["ArrowDown"] },
  left: { codes: [37], names: ["ArrowLeft"] },
  right: { codes: [39], names: ["ArrowRight"] },
  enter: { codes: [13], names: ["Enter"] },
  back: { codes: [461, 27, 8], names: ["Escape", "Backspace", "GoBack"] },
};

function remoteKeyName(event) {
  var name;
  for (name in REMOTE_KEYS) {
    if (REMOTE_KEYS[name].codes.indexOf(event.keyCode) != -1) return name;
    if (event.key && REMOTE_KEYS[name].names.indexOf(event.key) != -1) return name;
  }
  return null;
}

// The dialog is shown by showModalDialog() and hidden by modalClosed(); both
// work on #modal, so its inline display is the state.
function modalIsOpen() {
  var modal = document.getElementById("modal");
  return !!modal && modal.style.display != "none";
}

function visibleLinkedAppFrame() {
  var frame = document.getElementById("linked_app");
  if (!frame || frame.style.display == "none") return null;
  return frame;
}

// Re-dispatch the key into the application's document rather than relying on
// the iframe holding focus. Focus moves whenever the client shows something of
// its own, and a signer that stops answering the remote after a banner appeared
// is worse than no overlay at all.
//
// Returns whether the application took the key, so the caller knows the key was
// dealt with.
function forwardKeyToLinkedApp(event) {
  var frame = visibleLinkedAppFrame(),
    appDocument,
    copy;
  if (!frame) return false;

  // The application is served from the client's own origin (the XML AIT's
  // URLBase), so its document is reachable. Guard anyway: a service list may
  // point its linked application somewhere else entirely, and that must not
  // throw on every key press.
  try {
    appDocument = frame.contentWindow && frame.contentWindow.document;
  } catch (e) {
    return false;
  }
  if (!appDocument || !appDocument.body) return false;

  copy = new KeyboardEvent("keydown", {
    key: event.key,
    code: event.code,
    bubbles: true,
    cancelable: true,
  });
  // KeyboardEventInit has no keyCode, so a constructed event reports 0 for it.
  // Applications written for television read keyCode, this one included, so it
  // has to be put back before the event is delivered.
  Object.defineProperty(copy, "keyCode", {
    get: function () {
      return event.keyCode;
    },
  });
  Object.defineProperty(copy, "which", {
    get: function () {
      return event.keyCode;
    },
  });

  appDocument.body.dispatchEvent(copy);
  return true;
}

function currentChannelIndex() {
  var i;
  if (!selectedChannel) return -1;
  for (i = 0; i < channels.length; i++) {
    if (channels[i].id == selectedChannel.id) return i;
  }
  return -1;
}

// Wraps at both ends, which is what a television does and what the viewer will
// expect from three services.
function changeChannel(step) {
  var index, next;
  if (!channels || channels.length == 0) return;

  index = currentChannelIndex();
  // Nothing selected yet — channel up starts at the first service, channel down
  // at the last.
  if (index == -1) index = step > 0 ? -1 : 0;

  next = (index + step + channels.length) % channels.length;
  channelSelected(channels[next].id);

  // The same banner the touch UI shows on selection, so the viewer sees which
  // service they landed on. It hides itself again after five seconds.
  if (typeof resetHideTimeout == "function") resetHideTimeout();
}

function onRemoteKeyDown(event) {
  var key = remoteKeyName(event);
  if (!key) return;

  // The dialog is the one thing that must answer OK, and the one that blocks a
  // first run: the client shows it when no service list has been chosen and its
  // only control is a click-only link.
  if (modalIsOpen()) {
    if (key == "enter" || key == "back") {
      modalClosed();
      event.preventDefault();
    }
    return;
  }

  if (key == "channelUp" || key == "channelDown") {
    changeChannel(key == "channelUp" ? 1 : -1);
    event.preventDefault();
    return;
  }

  // Everything else is the application's while one is running.
  if (forwardKeyToLinkedApp(event)) {
    event.preventDefault();
  }
}

document.addEventListener("keydown", onRemoteKeyDown, false);
