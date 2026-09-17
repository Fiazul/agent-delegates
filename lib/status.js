'use strict';

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { resolveBin } = require('./bins');
const { spawn } = require('./process');
const { homeDir, readJson } = require('./util');

function run(command, args, options = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { cwd: options.cwd || os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, options.timeout || 60000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function getJson(url, headers, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function percentLeft(used) {
  return Number.isFinite(Number(used)) ? `${100 - Math.trunc(Number(used))}%` : '?';
}

function claudeRow(home) {
  const snapshot = readJson(path.join(home, '.claude', 'rate_limits.json'));
  if (!snapshot) return ['claude', 'no snapshot', '-'];
  let quota = `wk ${percentLeft(snapshot.seven_day?.used_percentage)} · 5h ${percentLeft(snapshot.five_hour?.used_percentage)}`;
  try {
    const { loadConfig } = require('./policy');
    const staleMinutes = loadConfig(home).staleMinutes;
    const ageMinutes = Math.round((Math.floor(Date.now() / 1000) - Number(snapshot.ts)) / 60);
    if (Number.isFinite(ageMinutes) && ageMinutes > staleMinutes) quota += ` (stale ${ageMinutes}m)`;
  } catch { /* config/staleness is best-effort; never break the status row over it */ }
  return ['claude', quota, 'fable-5.1 opus-5 sonnet-5 haiku-4.5'];
}

async function codexRow(home) {
  const root = path.join(home, '.codex');
  const cache = readJson(path.join(root, 'models_cache.json'), {});
  const models = Array.isArray(cache.models) ? cache.models.map(model => model.slug).filter(slug => slug && !slug.startsWith('codex-')).join(' ') || '?' : '?';
  const auth = readJson(path.join(root, 'auth.json'), {});
  const tokens = auth.tokens || {};
  if (!tokens.access_token) return ['codex', 'logged out', models];
  try {
    const data = await getJson('https://chatgpt.com/backend-api/wham/usage', {
      Authorization: `Bearer ${tokens.access_token}`,
      'ChatGPT-Account-Id': tokens.account_id || '',
      'User-Agent': 'codex-cli'
    });
    const limit = data.rate_limit || {};
    const primary = limit.primary_window || {};
    const secondary = limit.secondary_window || {};
    const reset = secondary.reset_after_seconds == null ? '?' : Math.floor(secondary.reset_after_seconds / 3600);
    let quota = `wk ${100 - (secondary.used_percent || 0)}% (reset ${reset}h) · 5h ${100 - (primary.used_percent || 0)}%`;
    if (limit.limit_reached) quota += '  EXHAUSTED';
    return ['codex', quota, models];
  } catch {
    return ['codex', 'usage unavailable', models];
  }
}

function compactAgyModels(output) {
  const families = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('\t')) continue;
    const slug = line.split('\t')[0];
    const match = slug.match(/^(.*)-(low|medium|high)$/);
    const family = match ? match[1] : slug;
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(match ? match[2][0] : '');
  }
  return [...families].map(([family, levels]) => `${family}${levels.some(Boolean) ? `{${levels.join('/')}}` : ''}`).join(' ') || '?';
}

// L2: every other vendor row (codex/grok/cursor/opencode) resolves its binary through
// lib/bins.js's resolveBin so an env override, a routing.json bins.agy entry, or a well-known
// install dir all work — agyRow was the one row still hardcoding the bare 'agy' command name.
async function agyRow(home) {
  const bin = resolveBin('agy', { home: home || homeDir() });
  const cmd = bin.command || 'agy';
  const [modelResult, usageResult] = await Promise.all([
    run(cmd, ['models']),
    run(cmd, ['--output-format', 'json', '-p', '/usage'])
  ]);
  const models = modelResult.code === 0 ? compactAgyModels(modelResult.stdout) : '?';
  let quota = 'usage unavailable';
  try {
    const lines = usageResult.stdout.trim().split(/\r?\n/);
    const data = JSON.parse(lines.at(-1));
    const groups = data.command.data.groups;
    quota = groups.map(group => {
      const bucket = group.buckets[0];
      const label = group.name.includes('Gemini') ? 'gemini' : 'claude/gpt';
      return `${label} wk ${Math.round(bucket.remaining_fraction * 100)}%`;
    }).join(' · ');
  } catch {}
  return ['agy', quota, models];
}

async function grokRow(home, probe) {
  const bin = resolveBin('grok', { home });
  const grokCmd = bin.command || 'grok';
  const modelResult = await run(grokCmd, ['models'], { timeout: 20000 });
  const models = [...new Set((modelResult.stdout.match(/grok-[0-9.]+/g) || []))].sort().join(' ') || '?';
  const grokHome = path.join(home, '.grok');
  const auth = path.join(grokHome, 'auth.json');
  const marker = path.join(grokHome, '.last_402');
  if (!fs.existsSync(auth)) return ['grok', 'logged out', models];
  if (probe) {
    const result = await run(grokCmd, ['-p', 'OK'], { timeout: 30000 });
    if (`${result.stdout}\n${result.stderr}`.includes('402')) {
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(marker, `${new Date().toISOString().slice(0, 10)}\n`);
      return ['grok', 'exhausted (402)', models];
    }
    try { fs.unlinkSync(marker); } catch {}
    return ['grok', 'ok', models];
  }
  if (fs.existsSync(marker)) return ['grok', `exhausted (402 on ${fs.readFileSync(marker, 'utf8').trim()})`, models];
  return ['grok', 'unknown (--probe-grok)', models];
}

function compactModelIds(output, preferred = []) {
  const ids = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(Available models|Tip:)/i.test(trimmed)) continue;
    const match = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9._/-]*)/);
    if (!match) continue;
    ids.push(match[1]);
  }
  const unique = [...new Set([...preferred.filter(Boolean), ...ids])];
  if (unique.length <= 8) return unique.join(' ') || '?';
  return `${unique.slice(0, 6).join(' ')} …`;
}

async function cursorRow() {
  const bin = resolveBin('cursor', { home: homeDir() });
  if (!bin.command) return ['cursor', 'missing', '?'];
  const [statusResult, modelResult] = await Promise.all([
    run(bin.command, ['status', '--format', 'json'], { timeout: 20000 }),
    run(bin.command, ['--list-models'], { timeout: 30000 })
  ]);
  const models = compactModelIds(modelResult.stdout, ['auto', 'composer-2.5']);
  let quota = 'unavailable';
  try {
    const data = JSON.parse(statusResult.stdout.trim() || '{}');
    if (data.isAuthenticated || data.status === 'authenticated') quota = 'ok';
    else if (statusResult.code === 0) quota = 'logged out';
  } catch {
    if (statusResult.code === 127) quota = 'missing';
    else if (statusResult.code !== 0) quota = 'unavailable';
  }
  return ['cursor', quota, models];
}

async function opencodeRow() {
  const bin = resolveBin('opencode', { home: homeDir() });
  const modelResult = await run(bin.command, ['models'], { timeout: 30000 });
  const models = compactModelIds(modelResult.stdout, ['opencode/mimo-v2.5-free', 'opencode-go/kimi-k2.7-code']);
  const authFile = path.join(homeDir(), '.local', 'share', 'opencode', 'auth.json');
  let quota = 'unknown';
  if (modelResult.code === 127) quota = 'missing';
  else if (!fs.existsSync(authFile)) quota = 'logged out';
  return ['opencode', quota, models];
}

function formatTable(rows) {
  const all = [['CLI', 'LEFT', 'MODELS'], ...rows];
  const widths = [0, 1].map(column => Math.max(...all.map(row => row[column].length)));
  return all.map(row => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`).join('\n');
}

async function status(options = {}) {
  const home = options.home || homeDir();
  const rows = await Promise.all([
    Promise.resolve(claudeRow(home)),
    codexRow(home),
    agyRow(home),
    grokRow(home, options.probeGrok),
    cursorRow(),
    opencodeRow()
  ]);
  // H3: `status` is the one command that always does a real probe of every vendor, so it's also
  // the one place that always refreshes route-check/pick/run auto's rows.json cache — running
  // `agent-delegates status` (or the `delegates` shell alias) keeps routing decisions fresh for
  // free without every routing call re-probing on its own.
  try { require('./route').writeRowsCache(rows); } catch { /* best-effort cache */ }
  let table = formatTable(rows);
  if (rows[0] && rows[0][1] === 'no snapshot') {
    table += '\nclaude: no quota snapshot — install with the statusline (default) and open a Claude Code session once.';
  }
  return table;
}

// Pre-spawn login check (lib/runner.js calls this before submitting a job): cheap, local,
// deterministic checks only, except cursor which shells out to `agent status` (same call
// cursorRow makes, 20s timeout) since Cursor has no local auth file to read. claude/agy have no
// deterministic "logged in" signal available locally (see below) and are skipped rather than
// guessed at.
const PREFLIGHT_AUTH_COMMAND = Object.freeze({
  codex: 'codex login',
  grok: 'grok login',
  cursor: 'cursor-agent login',
  opencode: 'opencode auth login'
});

async function preflight(vendor, home, options = {}) {
  if (vendor === 'claude' || vendor === 'agy') {
    // claude: quota snapshot file existing/missing doesn't mean logged in/out (it's written by
    // the statusline helper, not auth state). agy: the CLI itself owns its auth state with no
    // local file this process can read cheaply. Neither has a deterministic local check.
    return { ok: true, skipped: true, reason: `${vendor}: no deterministic login check available` };
  }

  if (vendor === 'codex') {
    // A non-full run never actually authenticates against `root` — lib/runner.js's
    // freshCodexHome() symlinks ~/.codex-fresh/auth.json to the real ~/.codex/auth.json (or, on
    // win32, copies it) so the sandboxed CODEX_HOME still has valid credentials. Check whichever
    // of the two locations exists; either having a valid access_token means the run can proceed.
    const root = options.full ? (process.env.CODEX_HOME || path.join(home, '.codex')) : path.join(home, '.codex');
    const fresh = path.join(home, '.codex-fresh');
    const hasToken = candidate => Boolean(readJson(path.join(candidate, 'auth.json'), {})?.tokens?.access_token);
    if (!hasToken(root) && !hasToken(fresh)) {
      return { ok: false, reason: `codex: not logged in — run '${PREFLIGHT_AUTH_COMMAND.codex}' first (skip with --no-preflight)` };
    }
    return { ok: true };
  }

  if (vendor === 'grok') {
    const grokHome = path.join(home, '.grok');
    if (!fs.existsSync(path.join(grokHome, 'auth.json'))) {
      return { ok: false, reason: `grok: not logged in — run '${PREFLIGHT_AUTH_COMMAND.grok}' first (skip with --no-preflight)` };
    }
    const marker = path.join(grokHome, '.last_402');
    if (fs.existsSync(marker)) {
      return { ok: true, warning: `grok: quota was marked exhausted on ${fs.readFileSync(marker, 'utf8').trim()} — proceeding anyway` };
    }
    return { ok: true };
  }

  if (vendor === 'cursor') {
    // Fail OPEN: cursor has no local auth file, only `agent status`, so anything short of a
    // clean, parseable "not authenticated" answer (missing binary, non-zero exit, timeout,
    // malformed JSON) must never block a run outright — it only means the check itself
    // couldn't run, not that the user is logged out. Only a JSON response that positively says
    // isAuthenticated === false / status !== 'authenticated' refuses.
    const bin = resolveBin('cursor', { home });
    if (!bin.command) return { ok: true, warning: `cursor: could not verify login (${bin.reason})` };
    const result = await run(bin.command, ['status', '--format', 'json'], { timeout: 20000 });
    if (result.code !== 0) {
      return { ok: true, warning: `cursor: could not verify login (${bin.command} status exited ${result.code})` };
    }
    let data;
    try {
      data = JSON.parse(result.stdout.trim() || '{}');
    } catch {
      return { ok: true, warning: 'cursor: could not verify login (unparseable agent status output)' };
    }
    const authenticated = Boolean(data.isAuthenticated || data.status === 'authenticated');
    if (!authenticated) {
      return { ok: false, reason: `cursor: not logged in — run '${PREFLIGHT_AUTH_COMMAND.cursor}' first (skip with --no-preflight)` };
    }
    return { ok: true };
  }

  if (vendor === 'opencode') {
    const authFile = path.join(home, '.local', 'share', 'opencode', 'auth.json');
    if (!fs.existsSync(authFile)) {
      return { ok: false, reason: `opencode: not logged in — run '${PREFLIGHT_AUTH_COMMAND.opencode}' first (skip with --no-preflight)` };
    }
    return { ok: true };
  }

  return { ok: true, skipped: true };
}

module.exports = { agyRow, claudeRow, codexRow, compactAgyModels, compactModelIds, cursorRow, formatTable, grokRow, opencodeRow, preflight, status };
