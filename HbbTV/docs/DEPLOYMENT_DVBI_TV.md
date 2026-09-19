# How the application works for final deployment on a DVB-I–supported TV

This document describes the flow and behaviour when the app is deployed on a real DVB-I/HbbTV TV. See **PROJECT_VISION.md** for the overall plan (both streams via DVB-I, app displays both, WASM for single-decoder).

---

## 1. Intended deployment: both streams via DVB-I, app displays both

The **plan** is to send **both** streams (main + interpreter) **via DVB-I**. The HbbTV application then receives both and **correctly displays** the main content and the interpreter stream as a user-controllable overlay (resize, relocate, on/off).

**Flow:**

1. **Service list** signals for the channel: (a) **main** stream (e.g. DASH), (b) **interpreter** (sign-language) stream as an accessibility/secondary stream, (c) **linked app** URL (this HbbTV app).
2. **User** selects the channel or presses the red button; the **TV** launches the app.
3. **TV** opens the app URL with **both** stream URLs, e.g.  
   `https://our-app.example.com/?main=<main-dash-url>&interpreter=<interpreter-stream-url>`
4. **App** loads with `?main=...` and `?interpreter=...`, fetches both streams from DVB-I, and **displays both**: main content (full area) and interpreter as a resizable/repositionable overlay. User can move, resize, and toggle the overlay.
5. On **single-decoder** TVs, the interpreter stream may be decoded in **WASM** (Phase 2) so both streams can still be shown.

So for **final deployment**, both streams come from DVB-I and the **app** is the one that displays both. Local videos are only a fallback for standalone/testing.

---

## 2. Alternative: interpreter-only mode (TV plays main)

If the TV **already plays** the main stream (e.g. from the service list) and only passes the **interpreter** URL to the app, the app can run in **interpreter-only mode**: it shows only the overlay and does not load the main video. That is supported when the launch URL has only `?interpreter=...` (no `?main=...`).

| Mode | When | What the app shows |
|------|------|---------------------|
| **Dual-video (both from DVB-I)** | Launched with `?main=...&interpreter=...` | Main + interpreter overlay; both streams from DVB-I. **Intended deployment.** |
| **Interpreter-only** | Launched with `?interpreter=...` only (TV plays main) | Only interpreter overlay. Optional variant. |
| **Standalone / testing** | No DVB-I params | Main + overlay from local files or “Video sources” fields. |

---

## 3. What the service list must provide

- **Main stream:** In the service list, the channel has a **delivery** (e.g. `DASHDeliveryParameters` with the main DASH URL). For “both streams in app”, the TV/client passes this URL to the app as `?main=...`.
- **Interpreter stream:** The sign-language stream must be signalled (e.g. as an additional accessibility stream or via `<RelatedMaterial>` / descriptor) and its URL passed to the app as `?interpreter=...`.
- **Linked application URL:** The **MediaUri** in the service list is the URL the TV will open. It should include both stream URLs when the app is to display both, e.g.  
  `https://our-app.example.com/?main=<main-dash>&interpreter=<interpreter-stream>`

---

## 4. Deployment requirements (production)

- **HTTPS:** The app and all stream URLs must be served over **HTTPS** (and valid certificates). TVs and browsers block mixed content.
- **CORS:** If the app or the player fetches streams from another origin, the stream server must send correct **CORS** headers.
- **Single decoder:** Many TVs have only one hardware video decoder. The TV uses it for the main channel. Our app then decodes only the **interpreter** stream; on some sets that may be software-decoded (or Phase 2 WASM). Interpreter-only mode fits this: we only need one stream in the app.
- **DASH (`.mpd`) streams:** The Thesis list currently uses a DASH URL for `?interpreter=`. The native `<video>` element does not play `.mpd` in many browsers/TVs. For **testing** you can use an MP4 URL in the service list (e.g. `?interpreter=https://example.com/interpreter.mp4`). For **production** with DASH you need a JavaScript DASH player (e.g. dash.js, Shaka Player) in the app, or the broadcaster provides an MP4/CMAF URL the TV’s `<video>` can play.
- **Remote control:** The app already handles key events (Play, Pause, position 1–6, size S/M/L, subtitles C). On the TV, the remote sends these keys; no change needed for deployment.

---

## 5. Summary: “How should this application work exactly for final deployment?”

1. **TV** plays the main channel (from the DVB-I service list).
2. **User** presses the red button / “Interpreter” / “Accessibility”.
3. **TV** opens our app with a URL that includes `?interpreter=<interpreter-stream-url>` (from the service list).
4. **App** runs in **interpreter-only mode**: shows only the interpreter overlay (position/size configurable), no main video. Main content stays on the TV.
5. **User** can move/resize the overlay, toggle subtitles, and close the app to return to normal viewing.
6. **Production** needs HTTPS, CORS, and possibly a DASH-capable player for the interpreter stream; single-decoder behaviour is already aligned (one stream in the app).

**Intended plan (both streams via DVB-I):** The service list signals both main and interpreter; the TV opens the app with `?main=...&interpreter=...`; the app displays both (main + overlay). See PROJECT_VISION.md.
