# HbbTV/DVB-I Accessibility Application — MVP Demo

Prototype for **flexible display of sign-language interpreter and subtitles** on DVB-I/HbbTV devices, as part of a master’s thesis on TV accessibility for deaf and hard-of-hearing users.

## What this MVP does

- **Dual video:** Main content + interpreter stream as two separate video elements.
- **Interpreter overlay:** Interpreter video is shown as a resizable, repositionable overlay (position: corners/edges; size: small/medium/large).
- **Synchronisation:** Play/Pause/Restart control both streams; interpreter is kept in sync with main content.
- **Subtitles:** One WebVTT track on the main video; can be toggled on/off.
- **Video sources:** Default: `videos/main.mp4` and `videos/interpreter.mp4`; optional fields or URL params `?main=...&interpreter=...` for custom streams (e.g. when used with the DVB-I backend).
- **Remote / keyboard:** Play, Pause, Restart, interpreter position (1–6) and size (S/M/L), subtitle toggle (C). See **LOCAL_SETUP.md** for the full key list and TV testing.
- **Phase 1:** Application manifest (`manifest.json`), HbbTV bridge (lifecycle, fullscreen), DVB-I integration notes and single-decoder documentation in **docs/PHASE1_DVB-I_AND_DECODER.md**.

## How to run

**Use local video files** so playback works without CORS issues:

1. **Put your videos in the `videos/` folder:**
   - `videos/main.mp4` — main content
   - `videos/interpreter.mp4` — sign language interpreter (can be the same file for testing)

2. **Run a local HTTP server** from the project root (required; `file://` often blocks video):

```bash
# From the project root (HbbTV_DVB-I_application)
python3 -m http.server 8080
```

3. Open **http://localhost:8080** in your browser.

If you don’t have your own files yet, you can use any two short MP4s (e.g. from your phone or a screen recording) and rename them to `main.mp4` and `interpreter.mp4` in `videos/`.

## Testing on TV

When the app works locally, you can run it on a TV on the same Wi‑Fi: start the server, open **http://\<your-computer-ip\>:8080** in the TV’s browser or HbbTV app launcher, and use the remote (same as keyboard). Full steps and troubleshooting: **[LOCAL_SETUP.md](LOCAL_SETUP.md)**.

## Project structure

```
HbbTV_DVB-I_application/
├── IMPLEMENTATION_PLAN.md   # Full phased plan (MVP → HbbTV → WASM/CMAF → Evaluation)
├── LOCAL_SETUP.md           # Local checklist + TV testing (keyboard/remote, same network)
├── README.md                # This file
├── manifest.json            # Phase 1: Application manifest for DVB-I/HbbTV (name, URL, type 1.1/1.2)
├── index.html               # Single-page app
├── css/
│   └── style.css            # Layout, overlay positions/sizes, controls
├── js/
│   ├── app.js               # Sync, overlay controls, subtitle toggle, keys
│   └── hbbtv-bridge.js      # Phase 1: HbbTV lifecycle, fullscreen, detection
├── docs/
│   └── PHASE1_DVB-I_AND_DECODER.md   # DVB-I linkage + single-decoder note
├── videos/                  # Put main.mp4 and interpreter.mp4 here
└── subtitles/
    └── sample.vtt           # Sample WebVTT for main video
```

## Where do the streams come from?

**When launched from DVB-I:** The TV/client opens the app URL with stream info (e.g. `?interpreter=<url>`). The app then uses those URLs — **streams come from DVB-I**. The Thesis list encodes the interpreter stream in the app URL; see [docs/STREAMS_FROM_DVBI.md](docs/STREAMS_FROM_DVBI.md).

**When opened standalone** (no DVB-I, or no query params), the app falls back to **local files** or the Video sources fields:

- **Main:** `videos/main.mp4` (or leave empty if main is played by the DVB-I client)
- **Interpreter:** `videos/interpreter.mp4`

Put MP4 files in `videos/` for standalone use. Optional: use Video sources or `?main=...&interpreter=...` in the URL.

## Project vision and deployment

**Plan:** Both streams (main + interpreter) are sent **via DVB-I**; the HbbTV application receives both and displays the main content and the interpreter as a user-controllable overlay (resize, relocate, on/off). WASM is used to decode the interpreter stream on single-decoder TVs. See **[docs/PROJECT_VISION.md](docs/PROJECT_VISION.md)** for the full vision, open-source backend options, and phased plan. For deployment flow and requirements, see **[docs/DEPLOYMENT_DVBI_TV.md](docs/DEPLOYMENT_DVBI_TV.md)**.

## Next steps (see IMPLEMENTATION_PLAN.md)

1. **Phase 1:** ✅ HbbTV/DVB-I integration (manifest, HbbTV bridge, DVB-I doc, single-decoder note).
2. **DVB-I backend (simulate provider):** Use the open-source DVB-I Reference Client (and optionally CSR) to serve a service list that points to this app. **From repo root:** `node scripts/start-dvbi-reference-client.js` (macOS: needs PHP, e.g. `brew install php`). Step-by-step: **[docs/BACKEND_SETUP.md](docs/BACKEND_SETUP.md)**. Full technical plan and 8 technical problems: **[docs/TECHNICAL_PLAN_AND_BACKEND.md](docs/TECHNICAL_PLAN_AND_BACKEND.md)**.
3. **Phase 2:** WebAssembly decoding for single-decoder devices; CMAF/DASH delivery and compatibility checks.
4. **Phase 3:** Evaluation on devices and UX comparison with existing solutions.

## References (thesis)

[1]–[9] as in the thesis proposal (accessibility, HbbTV limitations, DVB-I, WebAssembly, CMAF, evaluation).
