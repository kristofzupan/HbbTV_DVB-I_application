# HbbTV/DVB-I Accessibility Application — MVP Demo

Prototype for **flexible display of sign-language interpreter and subtitles** on DVB-I/HbbTV devices, as part of a master’s thesis on TV accessibility for deaf and hard-of-hearing users.

## What this MVP does

- **Dual video:** Main content + interpreter stream as two separate video elements.
- **Interpreter overlay:** Interpreter video is shown as a resizable, repositionable overlay (position: corners/edges; size: small/medium/large).
- **Synchronisation:** Play/Pause/Restart control both streams; interpreter is kept in sync with main content.
- **Subtitles:** One WebVTT track on the main video; can be toggled on/off.
- **Video sources:** Default: `videos/main.mp4` and `videos/interpreter.mp4`; optional fields for custom URLs.
- **Remote / keyboard:** Play, Pause, Restart, interpreter position (1–6) and size (S/M/L), subtitle toggle (C). See **LOCAL_SETUP.md** for the full key list and TV testing.

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
├── index.html               # Single-page app
├── css/
│   └── style.css            # Layout, overlay positions/sizes, controls
├── js/
│   └── app.js               # Sync, overlay controls, subtitle toggle
└── subtitles/
    └── sample.vtt           # Sample WebVTT for main video
```

## Default video sources

The app loads **local files by default**:

- **Main:** `videos/main.mp4`
- **Interpreter:** `videos/interpreter.mp4`

Put your own MP4 files there and run via a local server (see above). For testing you can use the same short clip for both. Optional: use the “Video sources” fields to point to other URLs (e.g. remote DASH/CMAF later) and click “Apply URLs”.

## Next steps (see IMPLEMENTATION_PLAN.md)

1. **Phase 1:** HbbTV/DVB-I integration (application manifest, DVB-I discovery, HbbTV APIs).
2. **Phase 2:** WebAssembly decoding for single-decoder devices; CMAF/DASH delivery and compatibility checks.
3. **Phase 3:** Evaluation on devices and UX comparison with existing solutions.

## References (thesis)

[1]–[9] as in the thesis proposal (accessibility, HbbTV limitations, DVB-I, WebAssembly, CMAF, evaluation).
