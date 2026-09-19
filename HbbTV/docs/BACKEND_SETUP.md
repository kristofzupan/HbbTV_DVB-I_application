# DVB-I backend setup (Reference Client + optional CSR)

Quick steps to run the open-source DVB-I backend so you can **simulate a DVB-I provider** and point a service list at this HbbTV app. Full context and technical problems: **[TECHNICAL_PLAN_AND_BACKEND.md](TECHNICAL_PLAN_AND_BACKEND.md)**.

---

## Prerequisites

- **Node.js** (to run the start script and, later, CSR and validators).
- **PHP** (the Reference Client backend is PHP; on macOS use the built-in PHP or `brew install php`).
- This HbbTV app served at a known URL (e.g. `http://<your-ip>:8080` when you run `python3 -m http.server 8080` from the **HbbTV** folder).

---

## 1. DVB-I Reference Client (service list editor + host)

### 1a. macOS + Node: one-command start (recommended)

If you already cloned **DVB-I-Reference-Client** next to **HbbTV** (repo root = `HbbTV_DVB-I_application`), run from the **repo root**:

```bash
cd "/Users/kristof/Desktop/Master's thesis/HbbTV_DVB-I_application"
node scripts/start-dvbi-reference-client.js
```

This script sets `INSTALL_LOCATION` to `http://localhost:9080` (or your `BASE_URL`), then starts PHP’s built-in server so you don’t need Apache. It prints the backend and frontend URLs and, if you use the default, your LAN IP for TV testing.

- **Backend (service list editor):** http://localhost:9080/backend/  
- **Frontend (HTML5 client):** http://localhost:9080/frontend/android/player.html  

To use a different port or base URL (e.g. for TV on the same Wi‑Fi):

```bash
PORT=9090 node scripts/start-dvbi-reference-client.js
# or with your machine’s IP so the TV can reach it:
BASE_URL="http://192.168.1.100:9080" node scripts/start-dvbi-reference-client.js
```

Stop with **Ctrl+C**.

### 1b. Manual run (without the script)

Clone the Reference Client if you haven’t:

```bash
cd "/Users/kristof/Desktop/Master's thesis/HbbTV_DVB-I_application"
git clone https://github.com/DVBProject/DVB-I-Reference-Client.git
```

Then run the backend with PHP (no Node script): edit `DVB-I-Reference-Client/backend/configuration.php` and `DVB-I-Reference-Client/frontend/configuration.js` and set the same `$install_location` / `INSTALL_LOCATION` to your base URL (e.g. `http://localhost:9080`). From the repo root:

```bash
cd DVB-I-Reference-Client
php -S 0.0.0.0:9080 -t .
```

### In the service list (editor at …/backend/)

1. Create a service (e.g. “Thesis accessibility channel”).
2. Set the **linked application** URL to this HbbTV app, e.g.  
   `http://<your-computer-ip>:8080/`  
   or `http://<your-computer-ip>:8080/index.html`
3. When you add stream URLs later, add the **interpreter** (sign-language) stream as an accessibility-related or secondary stream (see TECHNICAL_PLAN_AND_BACKEND.md for XML details).
4. Publish/save the list and note the **service list URL** (e.g. `http://<backend-host>:9080/backend/servicelist.php?list=yourlist.xml`).

---

## 2. DVB-I Reference CSR (optional – discovery)

Use this when you want the TV to **discover** your service list via the Central Service Registry.

```bash
git clone https://github.com/DVBProject/DVB-I-Reference-CSR.git
cd DVB-I-Reference-CSR
npm install
npm start
```

Then register your service list URL with the CSR (via its API or configuration) so clients that query the CSR can find your list. See the CSR repo’s README for how to add a list.

---

## 3. Validating the service list

Before relying on the list on a TV or DVB-I client, validate it:

- **dvb-sl-check** (e.g. [paulhiggs/dvb-sl-check](https://github.com/paulhiggs/dvb-sl-check)) or the validator in **dvb-i-tools** ([paulhiggs/dvb-i-tools](https://github.com/paulhiggs/dvb-i-tools)):

  ```bash
  # Example (adjust to the tool’s actual CLI)
  npx dvb-sl-check "http://<your-backend>/path/to/servicelist.xml"
  ```

Fix any reported BlueBook A177 issues so the TV does not reject the list.

---

## 4. This HbbTV app

- Run the app (e.g. `python3 -m http.server 8080` from the **HbbTV** project root).
- The **base URL** must match the **application URL** you put in the DVB-I service list.
- For production-like and cross-origin tests, use **HTTPS** and correct **CORS** (see TECHNICAL_PLAN_AND_BACKEND.md, TP2).

---

## 5. Order of operations (quick start)

1. Start **this HbbTV app** at `http://<your-ip>:8080` (see [LOCAL_SETUP.md](../LOCAL_SETUP.md)).
2. From repo root run **`node scripts/start-dvbi-reference-client.js`** (or run the Reference Client manually as in §1b). Open the backend at `http://localhost:9080/backend/` and create a service list that points the linked application to `http://<your-ip>:8080/`.
3. Validate the list with dvb-sl-check (or dvb-i-tools).
4. Optionally run the **CSR** and register your list.
5. On the TV or DVB-I client, either open your app URL directly, or use discovery via the CSR so the app launches from the service list.

For technical problems (XML structure, CORS, keys, Wasm, sync, device limits), see **[TECHNICAL_PLAN_AND_BACKEND.md](TECHNICAL_PLAN_AND_BACKEND.md)**.
