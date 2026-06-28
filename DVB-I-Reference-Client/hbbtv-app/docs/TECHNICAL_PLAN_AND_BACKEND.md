# Detailed technical plan: DVB-I accessibility app (sign-language overlay + WASM)

This document merges the thesis implementation phases with the technical problems and open-source backend options for a DVB-I–compatible application that streams a sign-language interpreter as a separate, user-controllable overlay (resize, relocate, on/off), using WebAssembly where needed for single-decoder devices.

---

## 1. Open-source backend options (DVB-I provider simulation)

To simulate a real DVB-I environment you need a backend that serves **service lists** (channel lists + program data) and optionally a **discovery registry**. All of the following are from or aligned with the DVB Project.

| Tool | Repository | Role | Stack |
|------|------------|------|--------|
| **DVB-I Reference Client** | [DVBProject/DVB-I-Reference-Client](https://github.com/DVBProject/DVB-I-Reference-Client) | Web UI to create/edit/host DVB-I Service Lists (XML); can generate mock TV-Anytime EPG. This is your main “DVB-I provider” for development. | Backend (e.g. PHP) + frontend |
| **DVB-I Reference CSR** | [DVBProject/DVB-I-Reference-CSR](https://github.com/DVBProject/DVB-I-Reference-CSR) | Central Service Registry: simulates the global registry. Clients discover available service lists by region/provider. Use for full bootstrapping/discovery testing. | Node.js / Express |
| **Service list validator** | e.g. [paulhiggs/dvb-sl-check](https://github.com/paulhiggs/dvb-sl-check) (or tools in [dvb-i-tools](https://github.com/paulhiggs/dvb-i-tools)) | Validates your XML service lists against DVB-I BlueBook A177 so the TV parses them correctly. | Node.js |

**Practical order:** Start with the **Reference Client** to produce and host a service list that points to your HbbTV app and (later) to main/interpreter stream URLs. Add the **CSR** when you want to test discovery. Use **validators** before deploying new or edited XML.

---

## 2. High-level architecture (how the project fits together)

- **Service signalling (XML):** The backend emits a DVB-I Service List. The primary TV channel (broadcast or DVB-DASH) and the **sign-language stream** must be signalled (e.g. as an accessibility-related service or via `<RelatedMaterial>` / application URL). The same list points to your **application URL** (this repo’s `index.html` / manifest).
- **Frontend (this repo):** HbbTV/HTML5 app (OpApp or broadcast-related app). It reads stream metadata, shows main video + interpreter overlay, and handles remote/keyboard (resize, move, toggle overlay).
- **WebAssembly:** On single-decoder TVs, the **interpreter** stream can be decoded in software via a WASM decoder and rendered to a `<canvas>` so the user can still move/resize/toggle it; the main stream keeps using the hardware decoder.
- **Sync:** Primary (broadcast/DASH) and secondary (broadband interpreter) must be aligned using timeline sync (e.g. TEMI, DVB-DASH PTS) and possibly buffer/segment alignment.

---

## 3. Phased plan with technical problems

The phases below align with your existing **IMPLEMENTATION_PLAN.md** (Phase 0 → 1 → 2 → 3) and add the **concrete technical problems** to solve at each stage.

---

### Phase 1: Backend infrastructure and signalling *(start here for “DVB-I provider”)*

**Goal:** Have an environment where the TV “discovers” your app and (later) stream URLs via DVB-I.

**Actions:**

1. Deploy the **DVB-I Reference Client** to generate and host XML Service Lists.
2. In the service list, **signal your application** (base URL of this HbbTV app) and, when ready, primary and sign-language stream URLs.
3. Serve **primary** and **interpreter** streams (e.g. simple HTTP/HTTPS or, later, DASH).
4. Serve the **frontend** (this app) and ensure **HTTPS + CORS** where the TV will load it.

| # | Technical problem | What to do |
|---|-------------------|------------|
| **TP1** | **DVB-I XML structure** | Use the correct elements (e.g. `<Dashtemplate>`, `<RelatedMaterial>`, or application linkage) so the interpreter is signalled as an accessibility/secondary stream and the app URL is the linked application (type 1.1 or 1.2). Validate with dvb-sl-check (or dvb-i-tools). |
| **TP2** | **CORS and mixed content** | Serve DVB-I backend, streams, and frontend over **HTTPS** with correct **CORS** headers. TVs often block cross-origin or mixed HTTP/HTTPS requests; otherwise the Wasm module or app may not fetch streams or manifests. |

**Deliverables:**  
- Running Reference Client (and optionally CSR) with a service list that points to this app.  
- Short doc or comments in the service list describing how the accessibility/interpreter stream is signalled.

---

### Phase 2: Frontend UI and orchestration (HbbTV/HTML5)

**Goal:** App controls main video and overlay, and responds to the remote.

**Status:** Largely done in this repo (dual `<video>`, overlay, keys, subtitles, manifest, HbbTV bridge).

**Remaining / refinements:**

| # | Technical problem | What to do |
|---|-------------------|------------|
| **TP3** | **Focus and key capture** | Use HbbTV **Application.privateData.keyset** (or equivalent) so arrow keys and coloured keys are routed to your app instead of the platform (volume/channel). Document key mapping for remote. |
| **TP4** | **Canvas transparency** | When you switch the interpreter to a Wasm-rendered `<canvas>`, some TVs show a black box. If needed, implement **chroma-keying** (e.g. green-screen removal) in the Wasm pipeline before drawing to the canvas. |

---

### Phase 3: WebAssembly decoder (single-decoder path)

**Goal:** On single-decoder devices, decode the **interpreter** stream in software (Wasm) and render to a `<canvas>`.

**Actions:**

1. Choose a lightweight decoder (e.g. stripped FFmpeg, Broadway.js, or similar) and build to Wasm.
2. Fetch interpreter segments (e.g. Fetch API or WebSockets).
3. Decode in Wasm → raw frames → draw to `<canvas>` (e.g. via `requestAnimationFrame`).
4. Prefer **Web Worker** (or OffscreenCanvas) so the main thread stays responsive.

| # | Technical problem | What to do |
|---|-------------------|------------|
| **TP5** | **TV CPU limits** | Use **low resolution and bitrate** for the interpreter (e.g. 360p/480p), **baseline H.264** (avoid heavy AV1/HEVC for the Wasm-decoded stream). Profile on real TV hardware. |
| **TP6** | **Main-thread blocking** | Run **fetch + decode in a Web Worker**; pass decoded frames to the main thread (or use OffscreenCanvas) so UI and remote input do not freeze. |

---

### Phase 4: Media synchronisation

**Goal:** Interpreter (broadband) stays in sync with main (broadcast/DASH).

**Actions:**

1. Use **timeline data** from primary (e.g. DVB-DASH PTS, TEMI).
2. Align secondary stream with that timeline (buffer, skip/drop frames, or small speed adjustments).
3. Prefer HbbTV 2.0+ **MediaSynchroniser** (or equivalent) if available on target devices.

| # | Technical problem | What to do |
|---|-------------------|------------|
| **TP7** | **Drift and network latency** | Lock Wasm playback to the **primary** timeline (TEMI or DASH PTS). Implement a small buffer manager and simple A/V sync logic to correct for broadband jitter. |

---

### Phase 5: Real-device testing

**Goal:** Validate on physical DVB-I/HbbTV hardware.

| # | Technical problem | What to do |
|---|-------------------|------------|
| **TP8** | **“Emulator lie”** | Profile **memory and CPU** on a real TV. Emulators on a PC are much more capable; TVs have strict memory limits and can kill the app without clear errors if the Wasm heap or decoding pipeline is too heavy. |

---

## 4. Where this repo stands and what to do first

- **Phase 0 (MVP)** and **Phase 1 (HbbTV/DVB-I app integration)** in your IMPLEMENTATION_PLAN are done: dual video, overlay, subtitles, manifest, HbbTV bridge, DVB-I integration notes.
- **Next concrete “start”:**  
  - **Backend:** Set up the **DVB-I Reference Client** (and optionally CSR) so a real or simulated DVB-I client can discover and launch this app from a service list (see **Section 5**).  
  - **Signalling:** Define the exact XML snippet that links your app and the interpreter stream (and validate with dvb-sl-check).  
  - **Phase 2 (WASM/CMAF):** Proceed to Wasm decoder and, in parallel, CMAF/DASH packaging and compatibility (as in IMPLEMENTATION_PLAN Phase 2).

---

## 5. Getting started: DVB-I backend (Reference Client + optional CSR)

### 5.1 DVB-I Reference Client (service list editor and host)

1. **Clone the reference client** (includes backend that serves/edits service lists):

   ```bash
   cd /path/to/your/workspace
   git clone https://github.com/DVBProject/DVB-I-Reference-Client.git
   cd DVB-I-Reference-Client
   ```

2. **Run the backend**  
   - If the backend is PHP: use PHP’s built-in server from the backend directory, or point a local Apache/Nginx at it.  
   - If it’s Node: `npm install` and `npm start` (or see repo’s README/package.json).  
   Check the repo’s `backend/` and top-level README for exact commands.

3. **Create a service list** that includes:
   - One service (e.g. “Thesis accessibility channel”).
   - **Linked application** pointing to your HbbTV app, e.g.  
     `https://<your-host>:<port>/` or `https://<your-host>:<port>/index.html`  
     (same base URL that serves this repo’s `index.html` and `manifest.json`).
   - When you have stream URLs: add the **primary** and **interpreter** (accessibility) stream URLs in the structure required by DVB-I (e.g. `<RelatedMaterial>` or service-level accessibility descriptors).

4. **Host the XML**  
   The Reference Client typically serves the generated list at a URL like  
   `https://<backend-host>/path/to/servicelist.xml`.  
   Note this URL for the CSR or for direct client configuration.

### 5.2 DVB-I Reference CSR (optional – discovery)

1. **Clone and run:**

   ```bash
   git clone https://github.com/DVBProject/DVB-I-Reference-CSR.git
   cd DVB-I-Reference-CSR
   npm install
   npm start
   ```

2. **Register your service list** with the CSR (via its API or config) so that clients that query the CSR discover your list (e.g. by country or provider).

3. **Point your DVB-I client / TV** at the CSR URL for discovery, or directly at your service list URL for simpler testing.

### 5.3 This HbbTV app (frontend)

- Serve this app over **HTTPS** (and same origin or correct CORS if the TV fetches from a different host).
- **Base URL** you use here must match the **application URL** you put in the DVB-I service list.
- For local LAN testing, you can use `http://<your-PC-IP>:8080` if the TV allows it; for production-like testing, use HTTPS and proper CORS.

### 5.4 Validating the service list

- Before relying on a new or edited list, validate it:

  ```bash
  # If using dvb-sl-check or dvb-i-tools (see their README for exact CLI)
  npx dvb-sl-check https://<your-backend>/path/to/servicelist.xml
  ```

- Fix any BlueBook A177 violations so the TV does not reject the list silently.

---

## 6. Summary table: technical problems by phase

| Phase | Focus | Technical problems |
|-------|--------|---------------------|
| 1 | Backend & signalling | TP1 (XML structure), TP2 (CORS / HTTPS) |
| 2 | Frontend / HbbTV | TP3 (key capture), TP4 (canvas transparency) |
| 3 | Wasm decoder | TP5 (TV CPU), TP6 (main-thread blocking) |
| 4 | Sync | TP7 (drift, latency) |
| 5 | Device testing | TP8 (real-device limits) |

---

## 7. References

- DVB-I BlueBook A177 (service discovery, programme metadata).
- ETSI TS 103 770 (DVB-I).
- HbbTV 2.x (Application, keyset, optional MediaSynchroniser).
- Thesis references [1]–[9] (accessibility, HbbTV limitations, DVB-I, WebAssembly, CMAF, evaluation).
