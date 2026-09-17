'use strict';

// Vendor binary resolution: some vendor CLIs are launched by a bare, generic command name that
// another installed tool can shadow via PATH order. Verified live (2026-09): Grok's installer
// puts BOTH `~/.grok/bin/agent` and `~/.grok/bin/grok` on disk (same binary, two names) and
// Cursor's installer puts `~/.local/bin/agent` -> cursor-agent. Our own code called bare
// `agent` for cursor everywhere (lib/runner.js's commands map, lib/status.js's cursorRow and
// preflight) — so whichever one came first on PATH silently decided whether `run cursor`
// actually launched Cursor or Grok. This module is the single place that decides which real
// binary a vendor name resolves to, in a fixed, explainable order, and refuses to guess wrong
// for cursor/grok specifically (the only two that share a command name).

const fs = require('node:fs');
const path = require('node:path');
const { configPath, homeDir } = require('./util');

// Env var a caller/user can set to force a specific binary for a vendor, bypassing all other
// resolution. Names match the vendor keys used throughout the rest of the codebase (agy is
// the canonical name for Antigravity).
const ENV_VAR = Object.freeze({
  cursor: 'DELEGATE_CURSOR_BIN',
  grok: 'DELEGATE_GROK_BIN',
  codex: 'DELEGATE_CODEX_BIN',
  agy: 'DELEGATE_AGY_BIN',
  claude: 'DELEGATE_CLAUDE_BIN',
  opencode: 'DELEGATE_OPENCODE_BIN'
});

// The command name each vendor is documented/expected to run as, used only for error messages
// and PATH lookups below (not necessarily what actually gets returned — cursor's PATH lookup
// tries `cursor-agent` before ever considering bare `agent`).
const EXPECTED_NAME = Object.freeze({
  cursor: 'cursor-agent',
  grok: 'grok',
  codex: 'codex',
  agy: 'agy',
  claude: 'claude',
  opencode: 'opencode'
});

// The other vendor a bare `agent` could actually belong to — used by the identity check to
// reject (not just warn about) a clear cross-vendor match.
const OTHER_VENDOR_MARKER = Object.freeze({ cursor: 'grok', grok: 'cursor' });

// Loads only the `bins` key from the shared routing.json config (the same file lib/guard.js
// reads `guard` from). Never writes the file. Missing/invalid file or key -> {}.
function loadBinsConfig(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    const bins = parsed && typeof parsed === 'object' ? parsed.bins : null;
    return bins && typeof bins === 'object' ? bins : {};
  } catch {
    return {};
  }
}

function pathDirs(env) {
  return String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
}

// M5: on win32 only .exe/.cmd/.bat (etc.) are actually launchable — an extensionless file is
// never invoked as a command by CreateProcess/PATHEXT conventions, so it must never be tried as
// a candidate there (it was previously listed first, which could pick a non-executable
// extensionless file over the real .exe/.cmd sitting right next to it). .exe is preferred over
// .cmd since it needs no shim-unwrapping (see lib/process.js's resolveCommand).
function exeCandidates(name) {
  if (process.platform !== 'win32') return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true; // extension already narrowed the candidate
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

// First match of `name` found by walking env.PATH left to right (first-wins, exactly how the
// shell/child_process would resolve it) — or null.
function findOnPath(name, env) {
  for (const dir of pathDirs(env)) {
    for (const candidate of exeCandidates(name)) {
      const file = path.join(dir, candidate);
      if (isExecutableFile(file)) return file;
    }
  }
  return null;
}

// Resolves a symlink chain to its final target; a plain (non-symlink) file resolves to itself.
function realTarget(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

// Only the last two path segments (the realpath's basename + its immediate parent directory)
// are checked, never the whole absolute path or deeper ancestors — a real install always signals
// within this narrow window (~/.grok/downloads/grok-1.0.24-linux-x86_64: basename alone carries
// "grok"; .../cursor-agent/versions/X/cursor-agent: basename alone carries "cursor"), but an
// ancestor two-or-more levels up (a project folder, a username, a tmp-dir prefix) must never
// count: e.g. a user whose $HOME happens to contain "cursor" must not make every vendor look
// like cursor. Previously this window was 3 segments, which let a coincidental grandparent
// directory name (e.g. a test fixture's own tmpdir name) masquerade as a real vendor signal.
const IDENTITY_WINDOW = 2;

function guessOwner(target) {
  const segments = String(target).toLowerCase().split(path.sep).filter(Boolean).slice(-IDENTITY_WINDOW);
  if (segments.some(segment => segment.includes('cursor'))) return 'cursor';
  if (segments.some(segment => segment.includes('grok'))) return 'grok';
  return 'unknown';
}

// Identity check for a bare `agent` candidate: does its resolved real path look like it belongs
// to `vendor` (a lowercase marker, e.g. 'cursor')? 'match' — the target's path (basename or any
// parent directory) contains the vendor's own marker. 'conflict' — it contains the OTHER
// vendor's marker instead (the actual collision this module exists to catch — e.g. Grok's
// `~/.grok/bin/agent`). 'unknown' — neither marker is present (a non-symlink, or a layout this
// check doesn't recognize); still usable, just not verified.
function checkIdentity(file, vendor) {
  const target = realTarget(file);
  const owner = guessOwner(target);
  if (owner === vendor) return { verdict: 'match', target };
  if (owner === OTHER_VENDOR_MARKER[vendor]) return { verdict: 'conflict', target, conflictsWith: owner };
  return { verdict: 'unknown', target };
}

function fileExists(file) {
  try { fs.statSync(file); return true; } catch { return false; }
}

// Newest (by mtime) `cursor-agent` binary under ~/.local/share/cursor-agent/versions/*/ — the
// layout Cursor's own installer uses for self-updating installs.
function newestCursorAgentVersion(home) {
  const versionsDir = path.join(home, '.local', 'share', 'cursor-agent', 'versions');
  let entries;
  try { entries = fs.readdirSync(versionsDir); } catch { return null; }
  const candidates = entries
    .map(name => path.join(versionsDir, name, 'cursor-agent'))
    .filter(fileExists)
    .map(file => { try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; } })
    .filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].file;
}

function notFoundReason(vendor) {
  return `${vendor}: could not find ${EXPECTED_NAME[vendor]} (set ${ENV_VAR[vendor]} or bins.${vendor} in routing.json)`;
}

// resolveBin(vendor, { home, env, config }) -> { command, source, verified, reason }
//
// Resolution order: env override -> config override -> vendor-specific lookup. `command` is
// null only when vendor-specific lookup truly found nothing usable (cursor/grok only — the
// other four vendors fall back to the bare command name so spawn()'s own PATH resolution
// behaves exactly as it did before this module existed). `reason` is set whenever `command` is
// null, explaining why and how to fix it.
function resolveBin(vendor, { home, env, config } = {}) {
  const resolvedHome = home || homeDir();
  const resolvedEnv = env || process.env;

  const envVarName = ENV_VAR[vendor];
  if (envVarName && resolvedEnv[envVarName]) {
    const command = resolvedEnv[envVarName];
    return { command, source: 'env', verified: fileExists(command) };
  }

  const bins = config || loadBinsConfig(resolvedHome);
  if (bins && bins[vendor]) {
    const command = bins[vendor];
    return { command, source: 'config', verified: fileExists(command) };
  }

  if (vendor === 'cursor') {
    let found = findOnPath('cursor-agent', resolvedEnv);
    if (found) return { command: found, source: 'path:cursor-agent', verified: true };
    found = newestCursorAgentVersion(resolvedHome);
    if (found) return { command: found, source: 'well-known:cursor-agent-versions', verified: true };
    const agentPath = findOnPath('agent', resolvedEnv);
    if (agentPath) {
      const identity = checkIdentity(agentPath, 'cursor');
      if (identity.verdict === 'conflict') {
        return {
          command: null,
          source: null,
          verified: false,
          reason: `cursor: 'agent' on PATH resolves to ${identity.target}, which looks like ${identity.conflictsWith} — refusing to use it for cursor (set ${ENV_VAR.cursor} or bins.cursor in routing.json)`
        };
      }
      return { command: agentPath, source: 'path:agent', verified: identity.verdict === 'match' };
    }
    return { command: null, source: null, verified: false, reason: notFoundReason('cursor') };
  }

  if (vendor === 'grok') {
    // Deliberately never considers `agent` — Grok's own installer puts `agent` next to `grok`
    // (same binary, two names) so an identity check couldn't disambiguate this direction
    // anyway. `grok` is unambiguous; use only that.
    let found = findOnPath('grok', resolvedEnv);
    if (found) return { command: found, source: 'path:grok', verified: true };
    const wellKnown = path.join(resolvedHome, '.grok', 'bin', 'grok');
    if (fileExists(wellKnown)) return { command: wellKnown, source: 'well-known:~/.grok/bin/grok', verified: true };
    return { command: null, source: null, verified: false, reason: notFoundReason('grok') };
  }

  // codex/claude/agy/opencode: no known collision — PATH, then a well-known install dir, else
  // fall back to the bare command name (unchanged behavior from before this module existed).
  const wellKnownDir = vendor === 'opencode'
    ? path.join(resolvedHome, '.opencode', 'bin', 'opencode')
    : path.join(resolvedHome, '.local', 'bin', EXPECTED_NAME[vendor]);
  const found = findOnPath(EXPECTED_NAME[vendor], resolvedEnv);
  if (found) return { command: found, source: `path:${EXPECTED_NAME[vendor]}`, verified: true };
  if (fileExists(wellKnownDir)) return { command: wellKnownDir, source: `well-known:${wellKnownDir}`, verified: true };
  return { command: EXPECTED_NAME[vendor], source: 'bare (unresolved)', verified: false };
}

// detectAgentCollision({ env }) -> [{ path, realpath, owner }] for every `agent` (or
// `agent.exe`/`.cmd`/`.bat` on win32) found on PATH, first-to-last, deduplicated by path. Meant
// for an installer/doctor command to report "you have N things named agent on PATH, here's what
// each one actually is" — this module's own resolution never needs it (grok never looks for
// `agent` at all, and cursor's identity check already handles the collision inline).
function detectAgentCollision({ env } = {}) {
  const resolvedEnv = env || process.env;
  const seen = new Set();
  const results = [];
  for (const dir of pathDirs(resolvedEnv)) {
    for (const candidate of exeCandidates('agent')) {
      const file = path.join(dir, candidate);
      if (seen.has(file) || !isExecutableFile(file)) continue;
      seen.add(file);
      const target = realTarget(file);
      results.push({ path: file, realpath: target, owner: guessOwner(target) });
    }
  }
  return results;
}

module.exports = {
  ENV_VAR, EXPECTED_NAME, configPath, detectAgentCollision, exeCandidates, loadBinsConfig, resolveBin
};
