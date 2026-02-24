# Local setup and TV testing

Use this as a checklist: what to do **locally** first, then how to run the app on a **TV** for testing.

---

## Part 1: What to do locally

### 1.1 Get playback working in the browser

- [ ] Put `main.mp4` and `interpreter.mp4` in the `videos/` folder (same short clip is fine for testing).
- [ ] From the project root run: `python3 -m http.server 8080`
- [ ] Open **http://localhost:8080** and confirm:
  - [ ] Both videos play when you click **Play**
  - [ ] **Pause** and **Restart** work
  - [ ] Interpreter **position** (e.g. bottom-right) and **size** (small/medium/large) change correctly
  - [ ] **Subtitles** show and toggle on/off

### 1.2 Test keyboard control (same as remote on TV)

The app supports keyboard keys that mirror the TV remote. Try them locally:

| Key | Action |
|-----|--------|
| **Enter / Space** | Play |
| **P** | Pause |
| **R** | Restart |
| **1–6** | Interpreter position (1=top-left … 6=bottom-right) |
| **S / M / L** | Interpreter size (Small / Medium / Large) |
| **C** | Toggle subtitles |

- [ ] Confirm all of the above work in the browser before moving to the TV.

### 1.3 Prepare for TV: same network and URL

- [ ] Connect your **computer** (where the server runs) and your **TV** to the **same Wi‑Fi network**.
- [ ] Find your computer’s IP on the LAN, e.g.:
  - **macOS:** System Settings → Network → Wi‑Fi → Details, or run `ipconfig getifaddr en0`
  - **Windows:** `ipconfig` → “IPv4 Address”
- [ ] Note the app URL you’ll use on the TV: **http://\<your-computer-ip\>:8080**  
  Example: `http://192.168.1.100:8080`

### 1.4 Optional: test from another device on the same network

- [ ] On your phone or another laptop (same Wi‑Fi), open **http://\<your-computer-ip\>:8080**
- [ ] If the app loads and videos play, the TV should be able to reach it the same way.

---

## Part 2: Testing on the TV

### 2.1 Start the server and allow access

1. On your computer, from the project root:
   ```bash
   python3 -m http.server 8080
   ```
2. If you use a firewall, allow incoming connections on port **8080** for your LAN (so the TV can connect).

### 2.2 Open the app on the TV

How you open the URL depends on the TV:

- **Built‑in browser**  
  Open the browser app, go to address bar, and enter:  
  `http://<your-computer-ip>:8080`

- **HbbTV / DVB‑I “App” or “Red button”**  
  If the TV has a way to enter a “broadband app” or “developer” URL, enter the same URL there.

- **USB / external browser**  
  Some setups allow running a browser from USB or an external device; open the same URL there.

If you’re unsure, check the TV manual for “HbbTV”, “broadband app”, “browser”, or “developer URL”.

### 2.3 Use the remote control

On the TV, the remote should map to the same actions as the keyboard:

- **OK / Enter** → Play  
- **Pause** → Pause  
- **Arrow keys** → Can be used for position/size if we add that mapping; otherwise use the on‑screen buttons.

If your TV uses different key codes, we can add fallbacks (see “Troubleshooting” below).

### 2.4 What to check on the TV

- [ ] App loads (no blank or error page).
- [ ] Main and interpreter videos play and stay in sync.
- [ ] Interpreter overlay position and size can be changed (buttons or keys).
- [ ] Subtitles appear and can be toggled.
- [ ] Play / Pause / Restart work with the remote (or keys).

---

## Troubleshooting

### “Videos don’t load” on the TV

- Use **local files** (`videos/main.mp4`, `videos/interpreter.mp4`) so the TV doesn’t have to load from the internet (avoids CORS and mixed content).
- Ensure the server is running on your computer and the TV is on the same network.
- Try opening the same URL in a phone browser on the same Wi‑Fi to confirm the server is reachable.

### “Remote control keys don’t do anything”

- Some TVs use different key codes. The app uses standard HbbTV-style codes (e.g. VK_ENTER = 13) with keyboard fallbacks (Enter, P, R, etc.). If needed, we can add more key codes for your set.
- Use the **on‑screen buttons** as a fallback.

### “Page doesn’t load” on the TV

- Confirm the TV’s IP is on the same subnet as your computer (e.g. both 192.168.1.x).
- Turn off “guest” or “isolation” Wi‑Fi if it prevents devices from seeing each other.
- Ensure nothing else is using port 8080 on your computer.

### “CORS” or “mixed content” in browser console

- Serve everything from the same origin (your `http://<ip>:8080` server) and use local video paths (e.g. `videos/main.mp4`). Don’t open the page from `file://` and don’t mix `https` and `http` unnecessarily.

---

## Summary

| Where | Action |
|-------|--------|
| **Locally** | Run server, test in browser, test keyboard, put videos in `videos/`, get computer IP. |
| **TV** | Same Wi‑Fi, open `http://<computer-ip>:8080` in TV browser/app, use remote (and on‑screen buttons). |

Once local checks pass and the TV can load the same URL, you’re ready for real-device testing and evaluation (Phase 3).
