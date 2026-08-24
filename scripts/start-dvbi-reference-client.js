#!/usr/bin/env node
/**
 * Start DVB-I Reference Client backend + frontend on macOS using PHP built-in server.
 * Run from repo root: node scripts/start-dvbi-reference-client.js
 *
 * The Reference Client backend is PHP; this script:
 * 1. Loads .env from repo root (BASE_URL, PORT)
 * 2. Sets INSTALL_LOCATION in backend/configuration.php and frontend/configuration.js
 * 3. Patches stream URLs in backend/servicelists/thesis.xml and hbbtv-app/js/app.js
 * 4. Starts php -S so you don't need Apache
 *
 * Prerequisites: PHP (macOS: built-in or brew install php)
 * .env overrides: BASE_URL=http://<your-ip>:9080  PORT=9080
 *
 * The files this script rewrites are committed with http://localhost:9080, so a
 * fresh clone runs locally as-is and forgetting to run this on a deployment host
 * fails obviously rather than pointing at some other machine's address. Do not
 * commit them after running it, or that address travels into the repository.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

// ── Load .env (shell env vars take precedence) ────────────────────────────────
function loadDotEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const REF_CLIENT = path.join(REPO_ROOT, 'DVB-I-Reference-Client');
const PORT = parseInt(process.env.PORT || '9080', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

function getLocalIp() {
  try {
    const nets = os.networkInterfaces();
    if (!nets) return null;
    for (const name of Object.keys(nets)) {
      for (const n of nets[name]) {
        if (n.family === 'IPv4' && !n.internal) return n.address;
      }
    }
  } catch (e) {
    // Sandbox or permission may block networkInterfaces()
  }
  return null;
}

// Origin of a URL this project serves: an http(s) host that either carries an
// explicit port, or is followed by one of our own top-level paths. The second
// form is what makes a portless origin (https://dvb-i.lmmfe.org) replaceable on
// a later run; matching scheme://host unconditionally would rewrite the XML
// namespace URIs in the service lists, which are not addresses at all.
const ORIGIN = /https?:\/\/[\w.\-]+(?::\d+)?(?=\/(?:frontend|backend|hbbtv-app|stream)\/)|https?:\/\/[\w.\-]+:\d+/g;

// Replace any origin of ours in a file with installLocation.
function patchUrls(filePath, installLocation) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const patched = content.replace(ORIGIN, installLocation);
  if (patched !== content) {
    fs.writeFileSync(filePath, patched, 'utf8');
    console.log('Patched URLs in', path.relative(REPO_ROOT, filePath));
  }
}

function main() {
  if (!fs.existsSync(REF_CLIENT)) {
    console.error('DVB-I-Reference-Client not found at:', REF_CLIENT);
    console.error('From repo root run: git clone https://github.com/DVBProject/DVB-I-Reference-Client.git');
    process.exit(1);
  }

  const backendCfg = path.join(REF_CLIENT, 'backend', 'configuration.php');
  const frontendCfg = path.join(REF_CLIENT, 'frontend', 'configuration.js');

  if (!fs.existsSync(backendCfg) || !fs.existsSync(frontendCfg)) {
    console.error('Reference Client config files not found. Check path:', REF_CLIENT);
    process.exit(1);
  }

  const installLocation = BASE_URL.replace(/\/$/, '');
  const backendContent = `<?php
//
// install_location is the installation directory
// see also frontend/configuration.js
// (set by scripts/start-dvbi-reference-client.js)
//
$install_location = "${installLocation}";
?>
`;
  const frontendContent = `// DVB-I Reference installation location -- also backend/configuration.php
// (set by scripts/start-dvbi-reference-client.js)
var INSTALL_LOCATION = "${installLocation}";

// set to true to include <Service> channels that are not included in the selected LCN table.
var INCLUDE_NON_LCN_CHANNELS = false;
`;

  fs.writeFileSync(backendCfg, backendContent, 'utf8');
  fs.writeFileSync(frontendCfg, frontendContent, 'utf8');
  console.log('Configured INSTALL_LOCATION =', installLocation);

  // Patch stream URLs in thesis service list and hbbtv-app fallback defaults
  patchUrls(path.join(REF_CLIENT, 'backend', 'servicelists', 'thesis.xml'), installLocation);
  patchUrls(path.join(REF_CLIENT, 'hbbtv-app', 'js', 'app.js'), installLocation);
  patchUrls(path.join(REF_CLIENT, 'hbbtv-app', 'wrapper.html'), installLocation);
  patchUrls(path.join(REF_CLIENT, 'frontend', 'android_apk', 'app', 'src', 'main', 'assets', 'appConfig.json'), installLocation);

  const servicelistsDir = path.join(REF_CLIENT, 'backend', 'servicelists');
  if (!fs.existsSync(servicelistsDir)) {
    fs.mkdirSync(servicelistsDir, { recursive: true });
    console.log('Created backend/servicelists');
  }

  const php = process.platform === 'win32' ? 'php.exe' : 'php';
  const child = spawn(php, ['-S', `0.0.0.0:${PORT}`, '-t', REF_CLIENT], {
    cwd: REF_CLIENT,
    stdio: 'inherit',
  });

  const lanIp = getLocalIp();
  console.log('');
  console.log('DVB-I Reference Client running');
  console.log('  Backend (service list editor): ' + installLocation + '/backend/');
  console.log('  Frontend (HTML5 client):       ' + installLocation + '/frontend/android/player.html');
  if (lanIp && BASE_URL.includes('localhost')) {
    console.log('  For TV on same Wi-Fi use:       http://' + lanIp + ':' + PORT);
  }
  console.log('  Stop with Ctrl+C');
  console.log('');

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('PHP not found. On macOS: install with Homebrew: brew install php');
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code || 0));
}

main();
