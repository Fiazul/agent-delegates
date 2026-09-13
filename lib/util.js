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

function shellQuote(value) {
  if (process.platform === 'win32') return `"${String(value).replace(/"/g, '""')}"`;
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = { exists, homeDir, outputRoot, packageRoot, readJson, shellQuote, sleep, timestamp, writeJson };
