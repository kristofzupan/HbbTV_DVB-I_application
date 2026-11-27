#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

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
  }
  return null;
}

const ORIGIN = /https?:\/\/[\w.\-]+(?::\d+)?(?=\/(?:frontend|backend|hbbtv-app|stream)\/)|https?:\/\/[\w.\-]+:\d+/g;

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
//
$install_location = "${installLocation}";
?>
`;
  const frontendContent = `// DVB-I Reference installation location -- also backend/configuration.php
var INSTALL_LOCATION = "${installLocation}";

// set to true to include <Service> channels that are not included in the selected LCN table.
var INCLUDE_NON_LCN_CHANNELS = false;
`;

  fs.writeFileSync(backendCfg, backendContent, 'utf8');
  fs.writeFileSync(frontendCfg, frontendContent, 'utf8');
  console.log('Configured INSTALL_LOCATION =', installLocation);

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
