'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCommand } = require('./process');

const VENDORS = [
  { id: 'codex', command: 'codex', installCommand: 'npm install -g @openai/codex', auth: 'codex login' },
  { id: 'agy', command: 'agy', posixUrl: 'https://antigravity.google/cli/install.sh', windowsUrl: 'https://antigravity.google/cli/install.ps1', auth: 'agy' },
  { id: 'grok', command: 'grok', posixUrl: 'https://x.ai/cli/install.sh', auth: 'grok', windowsManual: 'https://docs.x.ai/build/overview' },
  { id: 'claude', command: 'claude', posixUrl: 'https://claude.ai/install.sh', windowsUrl: 'https://claude.ai/install.ps1', auth: 'claude' },
  { id: 'cursor', command: 'agent', posixUrl: 'https://cursor.com/install', windowsUrl: 'https://cursor.com/install?win32=true', auth: 'agent login' },
  { id: 'opencode', command: 'opencode', posixUrl: 'https://opencode.ai/install', auth: 'opencode auth login', windowsManual: 'https://opencode.ai/docs/' },
];

function commandExists(command, platform = process.platform, env = process.env) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const directories = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(item => item.toLowerCase())
    : [''];
  for (const directory of directories) for (const extension of extensions) {
    const candidate = path.join(directory, command + extension);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      if (platform === 'win32' || (stat.mode & 0o111)) return true;
    } catch {}
  }
  return false;
}

function checkedSpawn(command, args, options = {}, platform = process.platform) {
  const resolved = resolveCommand(command, args, options.env || process.env, platform);
  const result = childProcess.spawnSync(resolved.command, resolved.args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function installPosixScript(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delegates-'));
  const script = path.join(dir, 'install.sh');
  try {
    checkedSpawn('curl', ['-fsSL', url, '-o', script]);
    checkedSpawn('bash', [script]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function installWindowsScript(url) {
  const script = `$ErrorActionPreference = 'Stop'; $installer = Invoke-RestMethod -Uri '${url}' -ErrorAction Stop; Invoke-Expression $installer; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
  checkedSpawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function displayedCommand(vendor, platform) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) return `Manual install required for ${vendor.command}`;
  if (vendor.id === 'codex') return vendor.installCommand;
  if (platform === 'win32' && (vendor.id === 'grok' || vendor.id === 'opencode')) return `Manual install: ${vendor.windowsManual}`;
  const url = platform === 'win32' ? vendor.windowsUrl : vendor.posixUrl;
  return platform === 'win32' ? `irm '${url}' | iex` : `curl -fsSL ${url} | bash`;
}

async function defaultPrompt(message) {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let settled = false;
    const finish = answer => { if (!settled) { settled = true; resolve(Boolean(answer)); } };
    rl.on('close', () => finish(false));
    rl.on('SIGINT', () => { rl.close(); finish(false); });
    rl.question(message, answer => { finish(/^y(?:es)?$/i.test(answer.trim())); rl.close(); });
  });
}

async function defaultInstall(vendor, platform) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unsupported OS '${platform}'; install ${vendor.command} manually.`);
  if (vendor.id === 'codex') return checkedSpawn('npm', ['install', '-g', '@openai/codex']);
  if (platform === 'win32') {
    if (vendor.id === 'grok' || vendor.id === 'opencode') throw new Error(`${vendor.command} for Windows has no verified installer URL. See ${vendor.windowsManual}`);
    return installWindowsScript(vendor.windowsUrl);
  }
  return installPosixScript(vendor.posixUrl);
}

async function setupVendorClis(options = {}) {
  const platform = options.platform || process.platform;
  const log = options.log || console.log;
  const exists = options.commandExists || (name => commandExists(name, platform));
  const installer = options.install || (vendor => defaultInstall(vendor, platform));
  const prompt = options.prompt || defaultPrompt;
  const isTTY = options.isTTY == null ? Boolean(process.stdin.isTTY && process.stdout.isTTY) : options.isTTY;
  const result = { existing: [], installed: [], skipped: [], ready: false };

  for (const vendor of VENDORS) {
    if (exists(vendor.command)) {
      result.existing.push(vendor.id);
      log(`${vendor.command}: found. Authentication is unverified; run '${vendor.auth}' to authenticate or confirm access.`);
      continue;
    }
    const command = displayedCommand(vendor, platform);
    log(`${vendor.command}: missing. Install command: ${command}`);
    if (!['linux', 'darwin', 'win32'].includes(platform)) {
      log(`${vendor.command}: unsupported OS '${platform}'; install manually.`);
      result.skipped.push(vendor.id);
      continue;
    }
    if (platform === 'win32' && (vendor.id === 'grok' || vendor.id === 'opencode')) {
      log(`${vendor.command} for Windows needs manual installation. See ${vendor.windowsManual}`);
      result.skipped.push(vendor.id);
      continue;
    }
    let approved = Boolean(options.yes);
    if (!approved && isTTY) approved = await prompt(`Install ${vendor.command}? [y/N] `);
    if (!approved) {
      if (!isTTY) log(`Skipping ${vendor.command}: non-interactive install requires --yes. Run: ${command}`);
      else log(`Skipping ${vendor.command}. Run later: ${command}`);
      result.skipped.push(vendor.id);
      continue;
    }
    await installer(vendor);
    if (!exists(vendor.command)) throw new Error(`${vendor.command} was not found after installation. It may need a new terminal or PATH update.`);
    result.installed.push(vendor.id);
    log(`${vendor.command}: installed. Authentication is unverified; run '${vendor.auth}' to authenticate or confirm access.`);
  }
  result.ready = result.skipped.length === 0;
  if (!result.ready) log('CLI setup is partial; install skipped CLIs before using their vendors.');
  return result;
}

module.exports = { VENDORS, checkedSpawn, commandExists, defaultInstall, displayedCommand, setupVendorClis };
