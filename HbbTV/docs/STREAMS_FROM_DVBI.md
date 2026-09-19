# Where do the video streams come from?

**The plan is to send both streams via DVB-I.** The HbbTV application then receives both and correctly displays the main content and the interpreter stream (as a user-controllable overlay).

---

## With DVB-I (intended design)

- The **DVB-I service list** defines for each channel:
  - The **main** stream (e.g. DASH URL).
  - The **interpreter (sign-language) stream** as an additional accessibility stream.
  - The **linked app** (this HbbTV app) as "application with media in parallel" (or media-controlling).

- When the user selects the channel or presses the red button, the **TV** launches the app and should open the app URL **with both stream URLs**, for example:  
  `https://your-app.example.com/?main=<main-dash-url>&interpreter=<interpreter-stream-url>`

- The app then **gets both streams from DVB-I** and **displays both**: main content (full area) and interpreter overlay (resize, relocate, on/off). No local video files are required.

- In the **Thesis accessibility list** we can encode one or both URLs in the app URL. For "both streams in app", set "Application with media in parallel" to a URL that includes both params so the client passes both streams from DVB-I to the app.

## Standalone (no DVB-I client)

- When the app is opened **directly** (e.g. bookmark or no query params), it falls back to **local files** (`videos/main.mp4`, `videos/interpreter.mp4`) or the "Video sources" fields.

So: **local videos are only for standalone use and testing** when the app is not launched from DVB-I with `?main=...` and `?interpreter=...`.

---

## What we have in the project

- **Thesis service list (thesis.xml)**  
  - Main stream: DASH URL (in the service instance).  
  - Linked app: `http://localhost:8080/?interpreter=...` (interpreter stream passed via app URL). For "both streams in app", the app URL can include `?main=...&interpreter=...` when the client supports it.

- **HbbTV app**  
  - Reads `?main=...` and `?interpreter=...` from the URL. If both present, it uses them (**both streams from DVB-I**) and displays main + interpreter overlay.  
  - If only `?interpreter=...` is present, it runs in interpreter-only mode (TV may be playing main).  
  - If no params, it uses the "Video sources" fields or local paths (standalone/testing).

When the app is **launched from DVB-I** with `?main=...&interpreter=...`, it gets **both** streams from DVB-I and displays both. Local videos are only the fallback.
