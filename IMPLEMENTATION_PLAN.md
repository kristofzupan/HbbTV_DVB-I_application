# Implementation Plan: HbbTV/DVB-I Accessibility Application

## Thesis context

**Goal:** Prototype HbbTV application for DVB-I that enables separate, flexible display of sign-language interpreter video and subtitles for deaf and hard-of-hearing users, using WebAssembly where beneficial and CMAF for distribution.

**References:** [1]–[9] as in the proposal (accessibility, HbbTV 2.X limitations, DVB-I, WebAssembly, CMAF, evaluation).

---

## Phase 0: MVP demo (current phase)

**Objective:** Prove dual-video playback with configurable interpreter overlay and subtitles in a browser/HbbTV-like environment, without full HbbTV stack.

### 0.1 Scope

- **Dual video:** Main content + interpreter stream as two independent video elements.
- **Overlay:** Interpreter video as a movable/resizable overlay (position and size configurable).
- **Synchronisation:** Start/stop and basic time alignment of both streams (same timeline or manual sync).
- **Subtitles:** At least one subtitle track (e.g. WebVTT) for the main content.
- **Delivery:** Static files (HTML/CSS/JS); optional local or remote HTTP URLs for video/WebVTT (no CMAF/DASH yet).
- **Target:** Runs in desktop/mobile browsers and, where possible, on HbbTV test environments (e.g. reference emulator).

### 0.2 Out of scope for MVP

- Full HbbTV AIT/manifest and DVB-I service discovery.
- WebAssembly-based decoding (defer to Phase 2).
- CMAF/DASH packaging and adaptive streaming (defer to Phase 2).
- Real STB/tablet testing (defer to Phase 3).

### 0.3 Deliverables

| Item | Description |
|------|-------------|
| Single-page app | `index.html` + CSS + JS; HbbTV-friendly structure (no heavy frameworks). |
| Video components | Two `<video>` elements: main and interpreter; overlay styling and z-order. |
| Overlay controls | UI to change interpreter position (e.g. corners/edges) and size (small/medium/large or %). |
| Sync logic | Start both videos together; optional pause/seek alignment. |
| Subtitle track | One WebVTT track bound to main video; toggle on/off. |
| Sample assets | Placeholder or short test videos + one WebVTT file (or instructions to add). |
| README | How to run locally and which URLs/formats are supported. |

### 0.4 Success criteria

- Both videos play in sync from a single “Play” action.
- Interpreter overlay can be repositioned and resized without breaking playback.
- Subtitles display in sync with main content and can be toggled.
- Layout works on different viewports (responsive); documented limitations.

---

## Phase 1: HbbTV/DVB-I integration

**Objective:** Run the same concept as a real HbbTV application in a DVB-I context.

### 1.1 Tasks

- **Application manifest:** Define HbbTV application (e.g. AIT) and, where applicable, DVB-I linked application metadata (type 1.1 or 1.2 as per service).
- **DVB-I discovery:** Document or implement minimal service list / manifest usage so the app can be launched from a DVB-I client.
- **HbbTV APIs:** Use HbbTV APIs for lifecycle (start/stop), optional fullscreen, and key handling (remote control).
- **Single-decoder constraint:** Document behaviour when only one hardware decoder is available (e.g. main on decoder, interpreter in software/WebAssembly in Phase 2).

### 1.2 Deliverables

- Valid HbbTV application package (HTML + manifest + resources).
- Instructions or scripts for deployment on HbbTV test platform / emulator.
- Short document on DVB-I integration points and single-decoder considerations.

---

## Phase 2: WebAssembly and CMAF

**Objective:** Improve compatibility and flexibility using WebAssembly decoding and CMAF-based delivery.

### 2.1 WebAssembly

- **Architecture:** Design which stream (main vs interpreter) is decoded in WebAssembly on single-decoder devices; document trade-offs (CPU, power, latency).
- **Decoder choice:** Evaluate existing WASM decoders (e.g. broadway.js, libde265.wasm, or similar) for one stream; prioritise stability and sync.
- **Sync and stability:** Implement or document sync strategy (e.g. shared time base, segment alignment) and measure drift; ensure resize/reposition does not affect sync.

### 2.2 CMAF

- **Packaging:** Produce or use test content in CMAF (e.g. DASH with CMAF segments) for main and interpreter.
- **Compatibility:** Verify playback on target device types (TV, STB, tablet, phone) and document supported profiles/codecs.
- **Dual-stream delivery:** Serve both streams via same or separate CMAF/DASH manifests; document URL and manifest structure.

### 2.3 Deliverables

- Architecture document (WebAssembly + dual stream + single-decoder fallback).
- Test CMAF assets and playback verification report.
- Updated app that can use CMAF/DASH when available, with fallback to MVP-style URLs.

---

## Phase 3: Evaluation and thesis writing

**Objective:** Collect technical and user-experience evidence for the thesis.

### 3.1 Technical evaluation

- **Test environment:** Hardware and software setup (HbbTV/DVB-I devices, emulators).
- **Metrics:** Sync accuracy (main vs interpreter), playback stability (no dropouts, no freezes), resource usage where measurable.
- **Devices:** Test on at least two device classes (e.g. TV + tablet or STB + phone) and document results.

### 3.2 User experience

- **Comparison:** Adaptive interpreter (position/size) vs fixed built-in interpreter (e.g. from literature or mock).
- **Subjective measures:** Ease of use, perceived quality, accessibility (e.g. short questionnaire or guided tasks).
- **Subtitles:** Confirm subtitle usability (readability, timing, toggle).

### 3.3 Deliverables

- Test report (methodology, metrics, device matrix).
- Summary of UX findings and implications.
- Thesis chapters integrating problem statement, state of the art, design, implementation, and evaluation.

---

## Dependency overview

```
Phase 0 (MVP) ──► Phase 1 (HbbTV/DVB-I) ──► Phase 2 (WASM/CMAF) ──► Phase 3 (Evaluation)
     │                     │                        │
     └── demo runs in      └── same UI +            └── same app +
          browser               manifest +               WASM decoder +
          (and optionally       DVB-I linkage             CMAF sources
           emulator)
```

---

## Risk and mitigation

| Risk | Mitigation |
|------|------------|
| Single decoder on device | Phase 2: decode one stream in WebAssembly; Phase 1: document and optionally reduce quality/resolution of overlay. |
| Sync drift between streams | Single “Play” and aligned segment boundaries; in Phase 2 use same time base and segment duration; measure and correct drift. |
| CMAF profile support varies | Test early on target devices; document required codec/profile; provide fallback (e.g. single-file or non-CMAF DASH). |
| HbbTV emulator vs real device | Run MVP in emulator in Phase 0; Phase 1 and 3 include at least one real DVB-I/HbbTV device. |

---

## Next step

Implement **Phase 0 (MVP)** in this repository: single-page app with dual video, configurable interpreter overlay, subtitle track, and README. After MVP is validated, proceed to Phase 1 (HbbTV/DVB-I integration).
