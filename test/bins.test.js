'use strict';

// Category: any vendor invoked by a bare command name that another installed tool can shadow.
// Verified live: Grok's own installer puts BOTH ~/.grok/bin/agent and ~/.grok/bin/grok on disk
// (same binary, two names); Cursor's installer puts ~/.local/bin/agent -> cursor-agent. These
// tests build fake PATH directories with real files/symlinks reproducing both installs and
// assert resolveBin never lets one vendor's `agent` launch the other vendor.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ENV_VAR, configPath, detectAgentCollision, exeCandidates, loadBinsConfig, resolveBin
} = require('../lib/bins');

// Runs `fn` with process.platform temporarily overridden — exeCandidates() reads the real
// process.platform directly (it isn't parameterized like lib/process.js's resolveCommand), so
// this is the only way to exercise its win32 branch on a non-Windows CI host. Always restored,
// even on throw.
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function mkExecutable(file, contents = '#!/bin/bash\necho ok\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function mkSymlink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try { fs.unlinkSync(linkPath); } catch {}
  fs.symlinkSync(target, linkPath);
}

test('loadBinsConfig reads only the bins key, defaults to {} when missing/invalid', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-config-'));
  assert.deepEqual(loadBinsConfig(home), {});

  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(loadBinsConfig(home), {});

  fs.writeFileSync(file, JSON.stringify({ bins: { cursor: '/opt/cursor-agent' }, guard: { keywords: ['x'] } }));
  assert.deepEqual(loadBinsConfig(home), { cursor: '/opt/cursor-agent' });
});

test('resolveBin: cursor picks cursor-agent on PATH even when a grok-owned agent is also on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const grokHome = path.join(dir, 'grok-home', '.grok', 'bin');
  const binDir = path.join(dir, 'bin');
  const realGrok = path.join(grokHome, 'grok');
  mkExecutable(realGrok);
  // Grok's real install: agent and grok are the SAME binary, two names, both real files (not
  // symlinks) in the same directory — the actual shape verified live.
  mkExecutable(path.join(grokHome, 'agent'));
  mkExecutable(path.join(binDir, 'cursor-agent'));

  const env = { PATH: [binDir, grokHome].join(path.delimiter) };
  const result = resolveBin('cursor', { home: dir, env, config: {} });
  assert.equal(result.command, path.join(binDir, 'cursor-agent'));
  assert.equal(result.source, 'path:cursor-agent');
  assert.equal(result.verified, true);
});

test('resolveBin: cursor resolution fails clearly (never falls back to grok\'s agent) when only grok\'s agent is on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const grokBinDir = path.join(dir, 'grok-bin');
  mkExecutable(path.join(grokBinDir, 'grok'));
  // A symlink named `agent` pointing at a target whose path clearly says "grok" — this is the
  // identity check's positive-conflict case.
  const grokReal = path.join(dir, 'grok-install', 'grok-real-binary');
  mkExecutable(grokReal);
  mkSymlink(grokReal, path.join(grokBinDir, 'agent'));

  const env = { PATH: grokBinDir };
  const result = resolveBin('cursor', { home: dir, env, config: {} });
  assert.equal(result.command, null);
  assert.match(result.reason, /cursor:.*resolves to.*grok/);
  assert.match(result.reason, /refusing to use it for cursor/);
  assert.doesNotMatch(result.reason, /undefined/);
});

test('resolveBin: cursor accepts a bare `agent` on PATH whose realpath says cursor (verified true)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const binDir = path.join(dir, 'bin');
  const cursorReal = path.join(dir, 'cursor-install', 'cursor-agent-binary');
  mkExecutable(cursorReal);
  mkSymlink(cursorReal, path.join(binDir, 'agent'));

  const env = { PATH: binDir };
  const result = resolveBin('cursor', { home: dir, env, config: {} });
  assert.equal(result.command, path.join(binDir, 'agent'));
  assert.equal(result.source, 'path:agent');
  assert.equal(result.verified, true);
});

test('resolveBin: cursor accepts an unrecognizable bare `agent` (verified false) when it is the only candidate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const binDir = path.join(dir, 'bin');
  // A plain (non-symlink) executable named `agent` whose path carries no vendor marker at all.
  mkExecutable(path.join(binDir, 'agent'));

  const env = { PATH: binDir };
  const result = resolveBin('cursor', { home: dir, env, config: {} });
  assert.equal(result.command, path.join(binDir, 'agent'));
  assert.equal(result.verified, false);
});

test('resolveBin: cursor fails with the exact documented message when nothing is found at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const result = resolveBin('cursor', { home: dir, env: { PATH: emptyBin }, config: {} });
  assert.equal(result.command, null);
  assert.equal(
    result.reason,
    "cursor: could not find cursor-agent (set DELEGATE_CURSOR_BIN or bins.cursor in routing.json)"
  );
});

test('resolveBin: cursor prefers the newest ~/.local/share/cursor-agent/versions/*/cursor-agent by mtime over nothing on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const versionsDir = path.join(dir, '.local', 'share', 'cursor-agent', 'versions');
  const older = path.join(versionsDir, '1.0.0', 'cursor-agent');
  const newer = path.join(versionsDir, '2.0.0', 'cursor-agent');
  mkExecutable(older);
  fs.utimesSync(older, new Date(Date.now() - 100000), new Date(Date.now() - 100000));
  mkExecutable(newer);

  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const result = resolveBin('cursor', { home: dir, env: { PATH: emptyBin }, config: {} });
  assert.equal(result.command, newer);
  assert.equal(result.source, 'well-known:cursor-agent-versions');
  assert.equal(result.verified, true);
});

test('resolveBin: grok NEVER resolves to `agent`, even when grok is absent and only agent exists on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const binDir = path.join(dir, 'bin');
  mkExecutable(path.join(binDir, 'agent')); // no `grok` binary present at all
  const result = resolveBin('grok', { home: dir, env: { PATH: binDir }, config: {} });
  assert.equal(result.command, null);
  assert.doesNotMatch(String(result.command), /agent/);
  assert.equal(
    result.reason,
    'grok: could not find grok (set DELEGATE_GROK_BIN or bins.grok in routing.json)'
  );
});

test('resolveBin: grok resolves via PATH, then ~/.grok/bin/grok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const binDir = path.join(dir, 'bin');
  mkExecutable(path.join(binDir, 'grok'));
  let result = resolveBin('grok', { home: dir, env: { PATH: binDir }, config: {} });
  assert.equal(result.command, path.join(binDir, 'grok'));
  assert.equal(result.source, 'path:grok');

  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  mkExecutable(path.join(dir, '.grok', 'bin', 'grok'));
  result = resolveBin('grok', { home: dir, env: { PATH: emptyBin }, config: {} });
  assert.equal(result.command, path.join(dir, '.grok', 'bin', 'grok'));
  assert.equal(result.source, 'well-known:~/.grok/bin/grok');
});

test('resolveBin: env override (DELEGATE_<VENDOR>_BIN) wins over everything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const binDir = path.join(dir, 'bin');
  mkExecutable(path.join(binDir, 'cursor-agent'));
  const forced = '/my/custom/cursor-agent-build';
  const env = { PATH: binDir, [ENV_VAR.cursor]: forced };
  const result = resolveBin('cursor', { home: dir, env, config: { cursor: '/should/not/win' } });
  assert.equal(result.command, forced);
  assert.equal(result.source, 'env');
});

test('resolveBin: config bins.<vendor> wins over PATH (but loses to env)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const binDir = path.join(dir, 'bin');
  mkExecutable(path.join(binDir, 'cursor-agent'));
  const configured = '/from/routing/json/cursor-agent';
  const result = resolveBin('cursor', { home: dir, env: { PATH: binDir }, config: { cursor: configured } });
  assert.equal(result.command, configured);
  assert.equal(result.source, 'config');
});

test('resolveBin: env var names match DELEGATE_<VENDOR>_BIN for every vendor', () => {
  assert.deepEqual(ENV_VAR, {
    cursor: 'DELEGATE_CURSOR_BIN',
    grok: 'DELEGATE_GROK_BIN',
    codex: 'DELEGATE_CODEX_BIN',
    agy: 'DELEGATE_AGY_BIN',
    claude: 'DELEGATE_CLAUDE_BIN',
    opencode: 'DELEGATE_OPENCODE_BIN'
  });
});

test('resolveBin: codex/claude/agy/opencode use PATH then a well-known dir, falling back to the bare name (no hard failure)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const binDir = path.join(dir, 'bin');
  mkExecutable(path.join(binDir, 'claude'));
  let result = resolveBin('claude', { home: dir, env: { PATH: binDir }, config: {} });
  assert.equal(result.command, path.join(binDir, 'claude'));
  assert.equal(result.verified, true);

  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  mkExecutable(path.join(dir, '.opencode', 'bin', 'opencode'));
  result = resolveBin('opencode', { home: dir, env: { PATH: emptyBin }, config: {} });
  assert.equal(result.command, path.join(dir, '.opencode', 'bin', 'opencode'));

  // Nothing found anywhere -> bare command name, never a hard failure for these four.
  result = resolveBin('agy', { home: dir, env: { PATH: emptyBin }, config: {} });
  assert.equal(result.command, 'agy');
  assert.equal(result.verified, false);
  assert.equal(result.reason, undefined);
});

test('detectAgentCollision reports every `agent` on PATH with its realpath and owner guess', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const cursorDir = path.join(dir, 'cursor-bin');
  const grokDir = path.join(dir, 'grok-bin');
  const cursorReal = path.join(dir, 'cursor-install', 'cursor-agent-binary');
  const grokReal = path.join(dir, 'grok-install', 'grok-binary');
  mkExecutable(cursorReal);
  mkExecutable(grokReal);
  mkSymlink(cursorReal, path.join(cursorDir, 'agent'));
  mkSymlink(grokReal, path.join(grokDir, 'agent'));

  const env = { PATH: [cursorDir, grokDir].join(path.delimiter) };
  const results = detectAgentCollision({ env });
  assert.equal(results.length, 2);
  const owners = results.map(r => r.owner).sort();
  assert.deepEqual(owners, ['cursor', 'grok']);
  for (const entry of results) {
    assert.ok(entry.path.endsWith('agent'));
    assert.ok(fs.existsSync(entry.realpath));
  }
});

// M5: on win32 only .exe/.cmd/.bat are ever launchable — an extensionless candidate must never
// be tried (it used to be listed FIRST, ahead of the real launchable extensions), and .exe is
// preferred over .cmd since it needs no shim-unwrapping.
test('exeCandidates: win32 never includes the extensionless name and prefers .exe over .cmd (M5)', () => {
  withPlatform('win32', () => {
    assert.deepEqual(exeCandidates('grok'), ['grok.exe', 'grok.cmd', 'grok.bat']);
  });
});

test('exeCandidates: non-win32 is unaffected (bare name only)', () => {
  assert.deepEqual(exeCandidates('grok'), ['grok']);
});

test('detectAgentCollision returns an empty list when no `agent` is on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  assert.deepEqual(detectAgentCollision({ env: { PATH: emptyBin } }), []);
});

// M1: the identity heuristic used to scan the last 3 path segments (basename + 2 parent dirs),
// which let a coincidental ancestor directory name (a project folder, a username, a tmp-dir
// prefix) two levels above the binary masquerade as a real vendor signal. It now scans only the
// basename + its immediate parent (IDENTITY_WINDOW = 2).
test('resolveBin: cursor — a "cursor" substring two-or-more levels up the ancestor chain is never trusted (M1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  // "cursor-flavored-tmp" sits at the grandparent level (2 up from the `agent` basename) — under
  // the old 3-segment window this would have wrongly "confirmed" cursor; under the new 2-segment
  // window only 'mydir' (immediate parent) and 'agent' (basename) are ever looked at, and neither
  // carries a marker.
  const binDir = path.join(dir, 'cursor-flavored-tmp', 'mydir');
  const realTarget = path.join(dir, 'somewhere-else', 'plain-binary');
  mkExecutable(realTarget);
  mkSymlink(realTarget, path.join(binDir, 'agent'));

  const env = { PATH: binDir };
  const result = resolveBin('cursor', { home: dir, env, config: {} });
  // Not a hard failure (owner is 'unknown', not 'conflict' with grok) — but must never be
  // reported as a confirmed/verified match either.
  assert.equal(result.command, path.join(binDir, 'agent'));
  assert.equal(result.verified, false);
});

test('resolveBin: real Grok layout (basename alone carries the marker) is still identified within the 2-segment window (M1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bins-'));
  // Verified-live shape: ~/.grok/bin/agent is a symlink into a versioned
  // ~/.grok/downloads/grok-<version>-<arch> binary — the "grok" signal lives in the basename
  // itself, not in an intermediate ".grok"/"bin" segment, so it survives the narrower window.
  const grokBinDir = path.join(dir, '.grok', 'bin');
  const grokReal = path.join(dir, '.grok', 'downloads', 'grok-1.0.24-linux-x86_64');
  mkExecutable(grokReal);
  mkSymlink(grokReal, path.join(grokBinDir, 'agent'));

  const env = { PATH: grokBinDir };
  const result = resolveBin('cursor', { home: dir, env, config: {} });
  assert.equal(result.command, null);
  assert.match(result.reason, /looks like grok — refusing to use it for cursor/);
});
