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
  // VK_SUBTITLE from TS 102 796, and what Android sends as KEYCODE_CAPTIONS.
  //
  // Measured on the Philips television this is tested against: the media keys
  // arrive with keyCode 0 and are identifiable only by name, while the colour
  // keys arrive with a numeric code and an empty name. Neither matcher would be
  // enough on its own, which is why remoteKeyName tries both.
  //
  // Teletext is here because the button a viewer reaches for is the one marked
  // TEXT, and this television reports it as KEYCODE_TV_TELETEXT rather than
  // KEYCODE_CAPTIONS. There is no teletext in an IP deployment for it to
  // collide with, and leaving it unmapped means the obvious button does nothing.
  subtitle: {
    codes: [460, 175, 233],
    names: ["Subtitle", "ClosedCaptionToggle", "Teletext", "TvTeletext"],
  },
};

// The button marked TEXT on this television's remote emits Linux KEY_TITLE
// (0x171), confirmed with getevent on the device against a marker pattern of
// three TEXT presses followed by red, repeated. The vendor key layout under
// /vendor/usr/keylayout leaves 0x171 unmapped, so Android hands the WebView no
// keycode at all: keyCode 0, key "Unidentified", empty code. Nothing identifies
// it but the absence itself, and the layout cannot be corrected without root.
//
// Claiming every unidentified key for subtitles is a deliberate trade. Every
// button the client uses — digits, colour keys, arrows, channel, and the real
// captions key — arrives properly identified, so within this application the
// unidentified one is TEXT. The risk is another unlabelled vendor button
// sharing the signature and toggling subtitles unexpectedly; the alternative is
// the button a viewer reaches for doing nothing at all.
function isUnidentifiedKey(event) {
  return !event.keyCode && (!event.key || event.key == "Unidentified");
}

function remoteKeyName(event) {
  var name;
  for (name in REMOTE_KEYS) {
    if (REMOTE_KEYS[name].codes.indexOf(event.keyCode) != -1) return name;
    if (event.key && REMOTE_KEYS[name].names.indexOf(event.key) != -1) return name;
  }
  // Checked last so a key that identifies itself is always matched on its own
  // terms first: ClosedCaptionToggle and Teletext also arrive with keyCode 0,
  // but they carry a name and the loop above resolves them.
  if (isUnidentifiedKey(event)) return "subtitle";
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

// Switch the subtitle track straight on or off, rather than opening the track
// list the pointer UI opens. The list is a column of links, and reaching a link
// needs the focus model this file deliberately does not have; a viewer pressing
// SUBTITLE on a remote wants subtitles, not a menu they cannot move around in.
//
// Selecting the first track rather than remembering one: the stream carries a
// single EBU-TT-D track, and a chooser is only worth having when there is a
// choice. If more languages are added this becomes a menu and needs the focus
// model with it.
function toggleSubtitleTrack() {
  if (typeof player == "undefined" || !player) return;
  var tracks;
  try {
    tracks = player.getTracksFor("text") || [];
  } catch (e) {
    return; // no source attached yet
  }
  if (!tracks.length) {
    notify("No subtitles on this service");
    return;
  }
  var on = player.isTextEnabled();
  player.setTextTrack(on ? -1 : 0);
  notify(on ? "Subtitles off" : "Subtitles on: " + (tracks[0].lang || "unknown"));
}

// The client already has somewhere to say things; the alternative is a viewer
// pressing a key on a television and having no way to tell whether it did
// anything.
function notify(text) {
  var el = document.getElementById("notification");
  if (!el) return;
  el.textContent = text;
  el.style.display = "";
  clearTimeout(notify._timer);
  notify._timer = setTimeout(function () {
    el.style.display = "none";
  }, 3000);
}

// The keys the client keeps for itself whatever else is running. Service change
// is never the application's. The subtitle key is the terminal's too, because
// the terminal is what draws the subtitles — the application only says so.
//
// Returns whether the key was taken, so both entry points below can share one
// rule rather than each carrying their own copy of it.
function handleClientOwnedKey(key) {
  if (key == "channelUp" || key == "channelDown") {
    changeChannel(key == "channelUp" ? 1 : -1);
    return true;
  }
  if (key == "subtitle") {
    toggleSubtitleTrack();
    return true;
  }
  return false;
}

// A keydown inside an iframe is delivered to that frame's document and does not
// cross the boundary, so a listener on this document never sees it. showLinkedApp()
// hands the application focus on purpose — it owns the colour keys — and from
// that moment the client stopped seeing every key, its own included. Changing
// service was impossible without switching the application off first.
//
// Binding the same ownership rule inside the application's document restores it.
// Only client-owned keys are taken, in the capture phase and with propagation
// stopped, so the application never sees them twice; everything else is left
// alone and reaches the application's own listener untouched.
//
// Called again on every load because each load is a new document. Re-binding the
// same function on a document that already has it is a no-op — addEventListener
// ignores an identical type/listener/capture triple.
function bindRemoteToLinkedApp(frame) {
  var appDocument;
  try {
    appDocument = frame.contentWindow && frame.contentWindow.document;
  } catch (e) {
    return; // application on another origin: not reachable, and not ours to touch
  }
  if (!appDocument) return;
  appDocument.addEventListener("keydown", onLinkedAppKeyDown, true);
}

function onLinkedAppKeyDown(event) {
  var key = remoteKeyName(event);
  // Logged here as well as on the client's own document: with an application
  // running this is the only place an unmapped key is visible at all, and it is
  // exactly when a viewer would press one.
  if (!key) {
    console.log("[remote] unmapped key (application has focus)",
                event.keyCode, JSON.stringify(event.key), event.code);
    return;
  }
  if (handleClientOwnedKey(key)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function onRemoteKeyDown(event) {
  var key = remoteKeyName(event);
  // Unrecognised keys are the thing that cannot be guessed from a desk: every
  // terminal numbers its remote differently. Naming them in the console turns
  // "the subtitle button does nothing" into a number that can be added above.
  if (!key) {
    console.log("[remote] unmapped key", event.keyCode, JSON.stringify(event.key), event.code);
    return;
  }

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

  if (handleClientOwnedKey(key)) {
    event.preventDefault();
    return;
  }

  // Everything else is the application's while one is running.
  if (forwardKeyToLinkedApp(event)) {
    event.preventDefault();
  }
}

document.addEventListener("keydown", onRemoteKeyDown, false);
