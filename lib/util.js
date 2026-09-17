'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function homeDir() {
  return os.homedir();
}

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function outputRoot() {
  return process.env.DELEGATE_OUT || process.env.CODEX_WORKER_OUT || path.join(os.tmpdir(), 'codex-workers');
}

// Shared location of the user's routing.json config, used by lib/bins.js (`bins` key),
// lib/guard.js (`guard` key) and lib/policy.js (everything else) — one implementation so all
// three always agree on where the file lives.
function configPath(home) {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'delegates', 'routing.json');
  }
  return path.join(home, '.config', 'delegates', 'routing.json');
}

function shellQuote(value) {
  if (process.platform === 'win32') return `"${String(value).replace(/"/g, '""')}"`;
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Stable, non-transient home for the copied package (see lib/install.js copyPackageToInstallHome)
// and, on win32, for the command shims. Never points into an npx cache or any other ephemeral
// package location — everything an install leaves behind (skill symlinks, statusline/hook copy
// sources, shims) resolves through this instead of packageRoot(). POSIX: ~/.agent-delegates.
// win32: %LOCALAPPDATA%\agent-delegates, falling back to %USERPROFILE%\.agent-delegates (or the
// passed-in `home`) when LOCALAPPDATA isn't set.
function installHome(home) {
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'agent-delegates');
    return path.join(process.env.USERPROFILE || home, '.agent-delegates');
  }
  return path.join(home, '.agent-delegates');
}

module.exports = { configPath, exists, homeDir, installHome, outputRoot, packageRoot, readJson, shellQuote, sleep, timestamp, writeJson };
