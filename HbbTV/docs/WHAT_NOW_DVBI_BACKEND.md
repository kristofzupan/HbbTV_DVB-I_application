# What now: link your HbbTV app to the DVB-I service list

You have the DVB-I Reference Client running and can open both the **backend** (service list editor) and the **frontend** (HTML5 client). Next: create a service list that points to your accessibility app so that “your channel” carries the sign-language interpreter app.

---

## 1. Start your HbbTV app

In a separate terminal, run your app so it is reachable at a URL:

```bash
cd "/Users/kristof/Desktop/Master's thesis/HbbTV_DVB-I_application/HbbTV"
python3 -m http.server 8080
```

Use **http://localhost:8080** for same-machine testing, or **http://\<your-Mac-IP\>:8080** if you will test from the TV (same Wi‑Fi). Remember this URL — you will put it in the service list as the “Application with media in parallel”.

---

## 2. Create a service list in the backend editor

1. Open the **backend** in the browser:  
   **http://localhost:9080/backend/**  
   (or the URL your `start-dvbi-reference-client.js` script showed.)

2. **Service list metadata** (left column):  
   - Service list identifier: e.g. `thesis-accessibility`  
   - Version: e.g. `1`  
   - Service list name: e.g. `Thesis accessibility list`  
   - Provider: e.g. `Thesis`  
   - Other fields (logo, target region, content guide, language) can stay empty or be filled optionally.

3. **Add a service:**  
   Click **“Add Service”**.

4. **Service details:**  
   - Give it a **Service name** (e.g. `Accessibility demo channel`).  
   - **Service identifier**: e.g. `tag:thesis,2025:accessibility1`  
   - **Provider**: e.g. `Thesis`.

5. **Add a service instance** (the actual “channel”):  
   In that service, use the control to add a **Service instance**.

6. **Instance fields:**  
   - **Priority**: e.g. `1`  
   - **Application with media in parallel**: set this to your HbbTV app URL, e.g.  
     `http://localhost:8080/`  
     or `http://192.168.x.x:8080/` (your Mac’s IP) for TV.  
     No trailing path is needed; the app loads `index.html` from that base URL.  
   - **Application controlling media presentation**: leave empty (your app is type 1.1 “in parallel”).  
   - **Source type**: choose **DVB-DASH**.  
   - **DASH manifest URI**: use a test stream so the channel has something to play, e.g.  
     `https://refapp.hbbtv.org/livesim/02_llamanofragv1/manifest.mpd`

7. **Save the servicelist:**  
   - In “Service list filename” enter e.g. **thesis.xml**  
   - Click **“Save Servicelist”**.  
   The file is written to the Reference Client’s `backend/servicelists/thesis.xml`.

---

## 3. Use your app and the list

**Option A – Use your app directly (simplest)**  
- Open **http://localhost:8080** (or http://\<your-ip\>:8080 on the TV).  
- Your dual-video + interpreter overlay app runs. The DVB-I backend is only proving that a service list can point to this URL.

**Option B – Load your list in the DVB-I HTML5 client**  
- Your list is served at:  
  `http://localhost:9080/backend/servicelist.php?list=thesis.xml`  
- Open the HTML5 client with that list (URL‑encode the query):  
  `http://localhost:9080/frontend/android/player.html?servicelist=http%3A%2F%2Flocalhost%3A9080%2Fbackend%2Fservicelist.php%3Flist%3Dthesis.xml`  
- In the client, pick “Thesis accessibility list” (or the name you gave) if it appears, or the client may load it automatically from the URL.  
- Select your channel; the client will play the DASH stream. Your **accessibility app** is signalled as “application with media in parallel” for that channel. On a real HbbTV TV, the device would typically offer a red-button or “Launch app” that opens your URL; in the browser you can open **http://localhost:8080** in another tab to use your app.

**Option C – Show your list in “Select servicelist”**  
- The client’s list of providers comes from **slepr-master.xml** in the Reference Client. To make “Thesis accessibility list” appear in the UI, you can add a new `<sld:ServiceListOffering>` in `DVB-I-Reference-Client/backend/slepr-master.xml` that points to  
  `INSTALL~~LOCATION/backend/servicelist.php?list=thesis.xml`  
  (the backend replaces `INSTALL~~LOCATION` with the configured base URL).  
  Copy an existing `<sld:ServiceListOffering>` block and change the name and the `list=...` parameter to `thesis.xml`.

---

## 4. Testing with your HbbTV app

Your thesis channel signals the HbbTV app as **“application with media in parallel”** (type 1.1). The DVB-I HTML5 client plays the main DASH stream; it does not show a “red button” to launch the parallel app. You test the full setup like this:

### On your computer (same machine)

1. **Start both servers**
   - **DVB-I Reference Client:**  
     `node scripts/start-dvbi-reference-client.js` (port 9080).
   - **HbbTV app:**  
     From the `HbbTV` folder: `python3 -m http.server 8080`.

2. **Open the DVB-I frontend**  
   Go to **http://localhost:9080/frontend/android/player.html**.

3. **Select your list and channel**
   - In Settings → servicelist (or the initial list choice), choose **“Thesis accessibility list”**.
   - Select **channel 1 – Accessibility demo channel**.  
   The DASH stream (reference video) plays in the DVB-I client.

4. **Open your HbbTV app**
   - In **another browser tab**, open **http://localhost:8080**.  
   Your dual-video + interpreter overlay app runs there. You can use it in parallel with the DVB-I client: one tab = “channel” (DVB-I), other tab = your accessibility app (interpreter overlay, position/size, subtitles).

5. **What you’re testing**
   - The service list correctly links the channel to your app URL.
   - On a real DVB-I/HbbTV TV, the same list would allow the device to offer a “red button” or “Launch app” that opens your app; in the browser you simulate that by opening the app in a second tab.

### On a TV (same Wi‑Fi)

1. Use your Mac’s LAN IP for the HbbTV app (e.g. **http://192.168.x.x:8080**). If you haven’t already, set that URL in the thesis service list (“Application with media in parallel”) and re-save the list (or edit `servicelists/thesis.xml` and replace `localhost` with your IP).

2. On the TV, open **http://\<your-Mac-IP\>:8080** in the browser (or HbbTV app launcher if it supports a broadband URL). Your HbbTV app runs on the TV; use the remote as in [LOCAL_SETUP.md](../LOCAL_SETUP.md).

3. The DVB-I client on the TV (if you open it at http://\<your-Mac-IP\>:9080/frontend/android/player.html) would show the Thesis list and channel; the “main” test on TV is that your app at :8080 loads and works with the remote.

---

## 5. What you have achieved

- A **DVB-I service list** (thesis.xml) that defines a channel with a DASH stream and a **linked application** (your HbbTV app) as “application with media in parallel” (type 1.1).  
- Your **HbbTV app** is the one that provides the sign-language overlay; the DVB-I backend only tells clients where to find it.

On a **real DVB-I/HbbTV device**, the TV would use this list to discover the channel and your app URL and could launch your app when the user selects the channel or presses the red button.

---

## 6. Suggested next steps

1. **Validate the list** (see [BACKEND_SETUP.md](BACKEND_SETUP.md#3-validating-the-service-list)) with a DVB-I service list validator (e.g. dvb-sl-check or dvb-i-tools) so the XML is correct.  
2. **Test on a TV**: serve both the Reference Client and your HbbTV app from your Mac (e.g. ports 9080 and 8080), use your Mac’s LAN IP in the “Application with media in parallel” URL, and open the app on the TV at `http://<your-ip>:8080` (see [LOCAL_SETUP.md](../LOCAL_SETUP.md)).  
3. **Phase 2**: add WebAssembly decoding for the interpreter stream on single-decoder devices and, if needed, CMAF/DASH for your own streams (see [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) and [TECHNICAL_PLAN_AND_BACKEND.md](TECHNICAL_PLAN_AND_BACKEND.md)).
