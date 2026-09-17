'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCommand } = require('./process');
const { homeDir } = require('./util');

const VENDORS = [
  { id: 'codex', command: 'codex', installCommand: 'npm install -g @openai/codex', auth: 'codex login' },
  { id: 'agy', command: 'agy', posixUrl: 'https://antigravity.google/cli/install.sh', windowsUrl: 'https://antigravity.google/cli/install.ps1', auth: 'agy' },
  { id: 'grok', command: 'grok', posixUrl: 'https://x.ai/cli/install.sh', auth: 'grok', windowsManual: 'https://docs.x.ai/build/overview' },
  { id: 'claude', command: 'claude', posixUrl: 'https://claude.ai/install.sh', windowsUrl: 'https://claude.ai/install.ps1', auth: 'claude' },
  { id: 'cursor', command: 'cursor-agent', posixUrl: 'https://cursor.com/install', windowsUrl: 'https://cursor.com/install?win32=true', auth: 'cursor-agent login' },
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

async function defaultPrompt(message, { defaultYes = false } = {}) {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let settled = false;
    const finish = answer => { if (!settled) { settled = true; resolve(Boolean(answer)); } };
    rl.on('close', () => finish(false));
    rl.on('SIGINT', () => { rl.close(); finish(false); });
    rl.question(message, answer => {
      const trimmed = answer.trim();
      finish(trimmed ? /^y(?:es)?$/i.test(trimmed) : defaultYes);
      rl.close();
    });
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

// H1: Cursor's own binary is `cursor-agent`, but PATH can also carry a bare `agent` that
// actually belongs to Grok (both vendors' installers put a same-binary-two-names launcher on
// disk — see lib/bins.js's module comment). A plain `commandExists('cursor-agent')` lookup here
// would miss a valid install that only shows up under lib/bins.js's other resolution paths (a
// routing.json bins.cursor override, or the well-known ~/.local/share/cursor-agent/versions/
// layout) and would happily say "found" for a bare `agent` that's actually Grok's. Route the
// existence check for cursor through resolveBin so this is the one place that ever answers
// "is Cursor installed" — matching the check --main cursor uses in lib/install.js.
function cursorExists(env, home) {
  try {
    const { resolveBin } = require('./bins');
    const resolved = resolveBin('cursor', { env, home });
    return Boolean(resolved && resolved.command && resolved.verified);
  } catch {
    return false; // lib/bins.js unavailable; fail closed rather than guess with a bare lookup
  }
}

// Derives the honest tri-state ('ok' | 'logged-out' | 'unknown') from a lib/status.js preflight
// result, for callers (like the fallback default below) whose result predates or omits `state`.
function preflightState(result) {
  if (result && result.state) return result.state;
  if (!result) return 'unknown';
  if (result.ok === false) return 'logged-out';
  if (result.skipped) return 'unknown';
  return 'ok';
}

function authLine(command, verb, state, loginCommand) {
  if (state === 'ok') return `${command}: ${verb}, logged in.`;
  if (state === 'logged-out') return `${command}: ${verb}, NOT logged in — run '${loginCommand}'.`;
  return `${command}: ${verb}; login status could not be verified — run '${loginCommand}' if a job fails with an auth error.`;
}

// Splits a login command string ("codex login", "cursor-agent login") into the argv
// checkedSpawn/spawn expects; used only for the interactive re-login prompt below.
function splitLoginCommand(loginCommand) {
  const [command, ...args] = String(loginCommand).trim().split(/\s+/);
  return { command, args };
}

async function setupVendorClis(options = {}) {
  const platform = options.platform || process.platform;
  const log = options.log || console.log;
  const env = options.env || process.env;
  const home = options.home || homeDir();
  const exists = options.commandExists || (name => (name === 'cursor-agent' ? cursorExists(env, options.home) : commandExists(name, platform)));
  const installer = options.install || (vendor => defaultInstall(vendor, platform));
  const prompt = options.prompt || defaultPrompt;
  // No injected preflight -> never spawn/check anything for real; report 'unknown' for every
  // found/installed vendor and let the caller (lib/install.js, in production) supply the real
  // lib/status.js preflight explicitly. Keeps this function's own unit tests hermetic by default.
  const preflightFn = options.preflight || (async () => ({ ok: true, skipped: true, state: 'unknown' }));
  const isTTY = options.isTTY == null ? Boolean(process.stdin.isTTY && process.stdout.isTTY) : options.isTTY;
  const noLogin = Boolean(options.noLogin);
  const result = { existing: [], installed: [], skipped: [], ready: false, authNeeded: [] };
  const vendorList = Array.isArray(options.vendorIds) && options.vendorIds.length
    ? VENDORS.filter(vendor => options.vendorIds.includes(vendor.id))
    : VENDORS;

  // Prints the found/installed auth line for `vendor`, and when it's confirmed 'logged-out',
  // offers to log in right now (TTY + not --yes/--no-login only). Re-checks and reprints after a
  // login attempt. Always records the vendor's final state in result.authNeeded when it isn't
  // 'ok', so the install step's closing "Next: authenticate" line only names vendors that still
  // need attention.
  async function reportAuth(vendor, verb) {
    let check = await preflightFn(vendor.id, home, {});
    let state = preflightState(check);
    const loginCommand = check.loginCommand || vendor.auth;
    log(authLine(vendor.command, verb, state, loginCommand));

    if (state === 'logged-out' && isTTY && !options.yes && !noLogin) {
      const yes = await prompt(`Log in to ${vendor.command} now? [Y/n] `, { defaultYes: true });
      if (yes) {
        const { command, args } = splitLoginCommand(loginCommand);
        try {
          await (options.loginSpawn || checkedSpawn)(command, args, {}, platform);
        } catch (error) {
          log(`${vendor.command}: login command exited with an error (${error.message}); re-checking anyway.`);
        }
        check = await preflightFn(vendor.id, home, {});
        state = preflightState(check);
        log(authLine(vendor.command, 're-checked', state, check.loginCommand || loginCommand));
      }
    }
    if (state !== 'ok') result.authNeeded.push(vendor.id);
  }

  for (const vendor of vendorList) {
    if (exists(vendor.command)) {
      result.existing.push(vendor.id);
      await reportAuth(vendor, 'found');
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
    await reportAuth(vendor, 'installed');
  }
  result.ready = result.skipped.length === 0;
  if (!result.ready) log('CLI setup is partial; install skipped CLIs before using their vendors.');
  return result;
}

module.exports = { VENDORS, checkedSpawn, commandExists, cursorExists, defaultInstall, displayedCommand, setupVendorClis };
