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
  subtitle: {
    codes: [460, 175, 233],
    names: ["Subtitle", "ClosedCaptionToggle", "Teletext", "TvTeletext"],
  },
};

function isUnidentifiedKey(event) {
  return !event.keyCode && (!event.key || event.key == "Unidentified");
}

function remoteKeyName(event) {
  var name;
  for (name in REMOTE_KEYS) {
    if (REMOTE_KEYS[name].codes.indexOf(event.keyCode) != -1) return name;
    if (event.key && REMOTE_KEYS[name].names.indexOf(event.key) != -1) return name;
  }
  if (isUnidentifiedKey(event)) return "subtitle";
  return null;
}

function modalIsOpen() {
  var modal = document.getElementById("modal");
  return !!modal && modal.style.display != "none";
}

function visibleLinkedAppFrame() {
  var frame = document.getElementById("linked_app");
  if (!frame || frame.style.display == "none") return null;
  return frame;
}

function forwardKeyToLinkedApp(event) {
  var frame = visibleLinkedAppFrame(),
    appDocument,
    copy;
  if (!frame) return false;

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

function changeChannel(step) {
  var index, next;
  if (!channels || channels.length == 0) return;

  index = currentChannelIndex();
  if (index == -1) index = step > 0 ? -1 : 0;

  next = (index + step + channels.length) % channels.length;
  channelKey = step > 0 ? "channel_up" : "channel_down";
  channelSelected(channels[next].id);
  channelKey = null;

  if (typeof resetHideTimeout == "function") resetHideTimeout();
}

function toggleSubtitleTrack() {
  if (typeof player == "undefined" || !player) return;
  var tracks;
  try {
    tracks = player.getTracksFor("text") || [];
  } catch (e) {
    return;
  }
  if (!tracks.length) {
    notify(i18n.getString("subtitles_unavailable"));
    return;
  }
  var on = player.isTextEnabled();
  player.setTextTrack(on ? -1 : 0);
  logClientState(on ? "subtitles_off" : "subtitles_on", { subtitles: !on }, "subtitle");
  notify(on ? i18n.getString("subtitles_off") : i18n.getString("subtitles_on_prefix") + i18n.getLanguageName(tracks[0].lang || "unknown"));
}

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

function handleClientOwnedKey(key) {
  if (key == "channelUp" || key == "channelDown") {
    changeChannel(key == "channelUp" ? 1 : -1);
    return true;
  }
  if (key == "enter" && !modalIsOpen()) {
    if (typeof resetHideTimeout == "function") resetHideTimeout();
    logClientState("info_shown", null, "ok");
    return true;
  }
  if (key == "subtitle") {
    toggleSubtitleTrack();
    return true;
  }
  return false;
}

function bindRemoteToLinkedApp(frame) {
  var appDocument;
  try {
    appDocument = frame.contentWindow && frame.contentWindow.document;
  } catch (e) {
    return;
  }
  if (!appDocument) return;
  appDocument.addEventListener("keydown", onLinkedAppKeyDown, true);
}

function onLinkedAppKeyDown(event) {
  var key = remoteKeyName(event);
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
  if (!key) {
    console.log("[remote] unmapped key", event.keyCode, JSON.stringify(event.key), event.code);
    return;
  }

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

  if (forwardKeyToLinkedApp(event)) {
    event.preventDefault();
  }
}

document.addEventListener("keydown", onRemoteKeyDown, false);

var channelKey = null;

function clientTestState() {
  var state = { channel: null, channel_name: null, subtitles: null };
  if (selectedChannel) {
    state.channel = selectedChannel.lcn;
    try {
      state.channel_name = getLocalizedText(selectedChannel.titles, language_settings.ui_language);
    } catch (e) {}
  }
  try {
    if (player) state.subtitles = player.isTextEnabled();
  } catch (e) {}
  return state;
}

function logClientState(action, override, key) {
  if (!window.TestSession) return;
  var state = clientTestState();
  if (override) {
    for (var k in override) state[k] = override[k];
  }
  TestSession.log("tv", action, state, key || channelKey);
}

if (window.TestSession) TestSession.setHeartbeatState(clientTestState);
