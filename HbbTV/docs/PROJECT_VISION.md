# Project vision: DVB-I sign-language interpreter app with WASM

## Goal

Build a **DVB-I compatible** application that on a DVB-I–supported TV:

- Receives **both** the main content stream and the **sign-language interpreter** stream **via DVB-I** (service list and delivery).
- **Displays** the main content and the interpreter stream as a **separate video overlay** that the user can **manipulate**: resize, relocate, and turn on/off.
- Uses **WebAssembly (WASM)** where needed to decode the interpreter stream in software on TVs that have only one hardware video decoder (so both streams can still be shown).

So: **both streams are sent via DVB-I; the HbbTV application correctly receives and displays both**, with the interpreter as a user-controllable overlay.

---

## How it fits together

1. **DVB-I backend / provider**  
   The service list signals for each channel:
   - The **primary** (main) stream (e.g. DASH URL).
   - The **sign-language interpreter** stream as an additional accessibility stream (e.g. via `<RelatedMaterial>` or accessibility descriptors).
   - The **linked application** (this HbbTV app) with type 1.1 (application with media in parallel) or 1.2 (app controlling media).

2. **TV launches the app**  
   When the user selects the channel or presses the red button, the TV opens the app URL. That URL should carry **both** stream URLs (e.g. `?main=<main-dash-url>&interpreter=<interpreter-stream-url>`) so the app gets both from DVB-I.

3. **HbbTV app**  
   The app loads with both URLs, fetches both streams, and:
   - Displays the **main** content (full area).
   - Displays the **interpreter** stream as a resizable, repositionable overlay (position, size, on/off).
   - Optionally shows subtitles and keeps interpreter in sync with main.

4. **Single-decoder TVs (Phase 2)**  
   Many TVs have only one hardware decoder. Then:
   - Main stream uses the **hardware** decoder (e.g. native `<video>` or broadcast object).
   - Interpreter stream is **software-decoded** in the browser, e.g. via a **WASM** video decoder, and rendered to a `<canvas>` overlay. This avoids the “no second decoder” limitation and is the approach used in projects like 3Cat’s HbbTV sign-language overlay.

---

## Open-source backend options (DVB-I provider simulation)

| Tool | Purpose |
|------|--------|
| **DVB-I Reference Client** (DVBProject/DVB-I-Reference-Client) | PHP-backed backend to create/edit/host DVB-I Service Lists (XML) and mock EPG. Use this to signal both main and interpreter streams and the app URL. |
| **DVB-I Reference CSR** (DVBProject/DVB-I-Reference-CSR) | Node.js Central Service Registry so the TV can discover service lists by region/provider. |
| **DVB-I validators** (e.g. dvb-sl-check, dvb-i-tools) | Validate service list XML against DVB-I BlueBook A177. |

See **BACKEND_SETUP.md** and **TECHNICAL_PLAN_AND_BACKEND.md** for setup and technical problems.

---

## Phased plan and technical problems

The detailed phased plan (backend, frontend, WASM decoder, sync, hardware testing) and the **eight technical problems** (XML structure, CORS, key capture, canvas transparency, TV CPU, main-thread blocking, drift/latency, emulator vs real device) are documented in:

- **[TECHNICAL_PLAN_AND_BACKEND.md](TECHNICAL_PLAN_AND_BACKEND.md)** – phases, technical problems, and backend options.
- **IMPLEMENTATION_PLAN.md** (in project root) – thesis phases (MVP → HbbTV/DVB-I → WASM/CMAF → evaluation).

---

## Summary

- **Both streams via DVB-I:** Main and interpreter are signalled and delivered through the DVB-I service list; the TV passes both URLs to the app when launching it.
- **HbbTV app:** Receives both URLs and **displays** both – main content plus interpreter overlay (resize, relocate, on/off).
- **WASM:** Used to decode the interpreter stream in software on single-decoder TVs so both streams can be shown.
- **Backend:** DVB-I Reference Client (and optionally CSR) to simulate the provider and generate the service list with both streams and the app URL.
