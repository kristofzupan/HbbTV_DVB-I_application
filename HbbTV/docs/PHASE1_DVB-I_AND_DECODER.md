# Phase 1: DVB-I integration and single-decoder considerations

## DVB-I integration points

### Linked application types

DVB-I allows **linked applications** to be associated with TV services (DVB BlueBook A177 / ETSI TS 103 770). For this accessibility app, the relevant types are:

| Type | Meaning | Use case |
|------|--------|----------|
| **1.1** | Application with media in parallel (“red button” style) | App runs alongside broadcast/stream; user gets interpreter overlay + subtitles. |
| **1.2** | Application controlling media presentation | App controls playback (e.g. main + interpreter streams). |

This prototype can be signalled as either **1.1** or **1.2** depending on whether the DVB-I service treats it as parallel companion (1.1) or media-controlling (1.2).

### How the app is referenced in a DVB-I service list

- The **service list** (or application discovery metadata) contains an entry that points to this application.
- **Application URL:** the base URL where the app is served, e.g.  
  `http://<host>:<port>/`  
  so that the client loads `index.html` (or the URL given in `manifest.json`).
- **Manifest:** `manifest.json` in this project describes the app (name, type, features). A DVB-I client or service list tool can reference either:
  - The **application entry point** (e.g. `http://<host>:8080/index.html`), or  
  - The **manifest** (e.g. `http://<host>:8080/manifest.json`) and resolve the `url` field to load the app.

For **broadband-only** testing (no broadcast AIT):

- Serve the project (e.g. `python3 -m http.server 8080`) so the app is at `http://<your-ip>:8080/`.
- On the TV or DVB-I client, open that URL (or configure the service list so the linked application points to it).
- No transport stream or AIT is required for this path.

For **broadcast + broadband** (full HbbTV):

- The AIT in the transport stream signals the application (e.g. organisation id, app id, URL).
- The same HTML/JS app can be hosted at that URL; the TV launches it when the user selects the service or presses the red button.

---

## Single-decoder constraint

Many HbbTV receivers have **only one hardware video decoder**. That affects dual-stream designs.

### Current Phase 1 behaviour

- **Main video** and **interpreter video** are two independent `<video>` elements.
- On a device with **two decoders**, both streams can use hardware decoding.
- On a device with **one decoder**, typical behaviour is:
  - One stream uses the hardware decoder (usually the first or “primary” one, e.g. main content).
  - The other may fail to play, fall back to software decoding if the platform allows, or show an error depending on the device.

### Documented assumption

- **Main content** is treated as the primary stream (intended for the hardware decoder when only one is available).
- **Interpreter overlay** is the secondary stream. On single-decoder devices it may:
  - Not play (current baseline), or  
  - Be decoded in software (Phase 2: WebAssembly or platform software decoder) so both streams still work.

### Phase 2 direction

- Use **WebAssembly** (or platform APIs) to decode the **interpreter** stream in software when only one hardware decoder is available.
- Keep **main content** on the hardware decoder for performance and battery.
- This keeps sync and layout (position/size) unchanged; only the decoding path for the overlay changes.

---

## Summary

| Topic | Phase 1 approach |
|-------|------------------|
| **DVB-I linkage** | App described in `manifest.json`; service list or AIT points to app URL (base or `index.html`). Types 1.1 / 1.2. |
| **Broadband testing** | Serve app over HTTP on LAN; TV opens URL. No AIT needed. |
| **Single decoder** | Main = primary (hardware); interpreter = secondary. Phase 2 adds software/WASM decoding for interpreter when only one decoder exists. |
