'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_GUARD, assessCriticality, capList, configPath, enforce, keywordRegex, loadGuardConfig, pathMatches, permissionMode
} = require('../lib/guard');

test('loadGuardConfig falls back to defaults when the file is missing or invalid', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-guard-'));
  assert.deepEqual(loadGuardConfig(home), { keywords: DEFAULT_GUARD.keywords.slice(), paths: DEFAULT_GUARD.paths.slice() });

  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(loadGuardConfig(home), { keywords: DEFAULT_GUARD.keywords.slice(), paths: DEFAULT_GUARD.paths.slice() });
});

test('loadGuardConfig merges the guard key over defaults', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-guard-'));
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ guard: { paths: ['/srv/prod/**'] } }));
  const config = loadGuardConfig(home);
  assert.deepEqual(config.paths, ['/srv/prod/**']);
  assert.deepEqual(config.keywords, DEFAULT_GUARD.keywords);
});

test('DEFAULT_GUARD.keywords dropped TRUNCATE, helm, .env and kept the rest', () => {
  assert.ok(!DEFAULT_GUARD.keywords.includes('TRUNCATE'));
  assert.ok(!DEFAULT_GUARD.keywords.includes('helm'));
  assert.ok(!DEFAULT_GUARD.keywords.includes('.env'));
  for (const kept of ['DROP TABLE', 'rm -rf', 'kubectl', 'ssh', 'terraform', 'ansible', 'secrets', 'payment', 'billing', 'customer data', 'live server', 'production', 'deploy', 'migrate']) {
    assert.ok(DEFAULT_GUARD.keywords.includes(kept), `expected default keyword list to keep "${kept}"`);
  }
});

test('assessCriticality: critical (hard) comes ONLY from --critical or a path glob match, never from keywords', () => {
  const flagOnly = assessCriticality({ brief: 'do nothing special', cwd: '/tmp/x', options: { critical: true }, config: DEFAULT_GUARD });
  assert.equal(flagOnly.critical, true);
  assert.equal(flagOnly.suspected, false);
  assert.ok(flagOnly.reasons.some(r => /--critical/.test(r)));

  const config = { keywords: [], paths: ['/srv/prod/**', '/opt/*-live'] };
  const hitCwd = assessCriticality({ brief: '', cwd: '/srv/prod/app', options: {}, config });
  assert.equal(hitCwd.critical, true);
  const hitAddDir = assessCriticality({ brief: '', cwd: '/tmp/x', addDir: ['/opt/db-live'], options: {}, config });
  assert.equal(hitAddDir.critical, true);
  const noHit = assessCriticality({ brief: '', cwd: '/tmp/x', options: {}, config });
  assert.equal(noHit.critical, false);
  assert.equal(noHit.suspected, false);
});

test('assessCriticality: keyword hits are suspected/hints only, never critical/reasons', () => {
  const withKeyword = assessCriticality({ brief: 'ssh into the box and run the migration', cwd: '/tmp', options: {}, config: DEFAULT_GUARD });
  assert.equal(withKeyword.critical, false);
  assert.equal(withKeyword.suspected, true);
  assert.equal(withKeyword.reasons.length, 0);
  assert.ok(withKeyword.hints.some(h => h.startsWith('heuristic:') && /ssh/.test(h)));
  assert.ok(withKeyword.hints.some(h => h.startsWith('heuristic:') && /migrat/.test(h)));
});

// The 8 non-critical briefs from the review: keyword hits (if any) must stay advisory
// (suspected true/false either way is fine) but critical must always be false.
test('assessCriticality: the 8 review briefs are never critical', () => {
  const briefs = [
    'production-ready and add tests',
    'deployment docs',
    'migration script parser test',
    '.env.example keys',
    'payment rounding',
    'truncated output',
    'overwhelmed',
    'migrated'
  ];
  for (const brief of briefs) {
    const result = assessCriticality({ brief, cwd: '/tmp', options: {}, config: DEFAULT_GUARD });
    assert.equal(result.critical, false, `"${brief}" must not be critical`);
  }
});

// False-positive regressions the word-boundary rewrite specifically targets.
test('assessCriticality: dropped/word-boundary keywords no longer false-positive', () => {
  assert.equal(assessCriticality({ brief: '.env.example keys', cwd: '/tmp', options: {}, config: DEFAULT_GUARD }).suspected, false);
  assert.equal(assessCriticality({ brief: 'truncated output', cwd: '/tmp', options: {}, config: DEFAULT_GUARD }).suspected, false);
  assert.equal(assessCriticality({ brief: 'overwhelmed', cwd: '/tmp', options: {}, config: DEFAULT_GUARD }).suspected, false);
  assert.equal(assessCriticality({ brief: 'update the product roadmap doc', cwd: '/tmp', options: {}, config: DEFAULT_GUARD }).suspected, false);
});

test('assessCriticality: "production" / "deploy to prod" / "kubectl apply" are suspected but not critical', () => {
  for (const brief of ['production', 'deploy to prod', 'kubectl apply']) {
    const result = assessCriticality({ brief, cwd: '/tmp', options: {}, config: DEFAULT_GUARD });
    assert.equal(result.critical, false, `"${brief}" must not be critical`);
    assert.equal(result.suspected, true, `"${brief}" must be suspected`);
    assert.ok(result.hints.length > 0);
  }
});

test('keywordRegex: word-boundary — "deploy" matches inflections, "prod"/"production" do not match "product"', () => {
  assert.match('we will deploy this', keywordRegex('deploy'));
  assert.match('deploying now', keywordRegex('deploy'));
  assert.match('deployment plan', keywordRegex('deploy'));
  assert.match('already deployed', keywordRegex('deploy'));
  assert.doesNotMatch('deployable', keywordRegex('deploy')); // no such inflection listed — intentional
  assert.doesNotMatch('the product roadmap', keywordRegex('production'));
  assert.match('push to prod', keywordRegex('production'));
  assert.match('production-ready', keywordRegex('production'));
  assert.match('run the migration', keywordRegex('migrate'));
  assert.match('already migrated', keywordRegex('migrate'));
});

test('capList caps a list to max entries with a "+N more" summary', () => {
  assert.deepEqual(capList(['a', 'b', 'c'], 5), ['a', 'b', 'c']);
  assert.deepEqual(capList(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 5), ['a', 'b', 'c', 'd', 'e', '+2 more']);
  assert.deepEqual(capList([], 5), []);
});

test('permissionMode reports per-vendor bypass state', () => {
  assert.equal(permissionMode('codex', { ro: true }), 'sandbox read-only (no bypass)');
  assert.equal(permissionMode('codex', {}), 'sandbox workspace-write (no bypass)');
  assert.match(permissionMode('agy', {}), /FULL BYPASS/);
  assert.equal(permissionMode('agy', { safe: true }), 'accept-edits');
  assert.match(permissionMode('claude', { yolo: true }), /FULL BYPASS/);
  assert.equal(permissionMode('claude', {}), 'acceptEdits');
  assert.equal(permissionMode('cursor', {}), 'trust workspace, no --force');
  assert.equal(permissionMode('grok', {}), 'approval prompts');
  assert.equal(permissionMode('opencode', {}), 'default approvals');
});

test('enforce refuses a small model on critical work and allows override', () => {
  const refused = enforce({ vendor: 'codex', tier: 'luna', model: 'gpt-5.6-luna', critical: true, reasons: ['--critical flag set'], options: {}, mode: 'run' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /CRITICAL WORK/);
  assert.match(refused.message, /small model; critical work requires a large model/);
  assert.match(refused.message, /sol/);

  const allowed = enforce({ vendor: 'codex', tier: 'luna', model: 'gpt-5.6-luna', critical: true, reasons: ['x'], options: { allowSmall: true }, mode: 'run' });
  assert.equal(allowed.ok, true);
});

test('enforce refuses a standard model on critical work (only large passes)', () => {
  const refused = enforce({ vendor: 'codex', tier: 'terra', model: 'gpt-5.6-terra', critical: true, reasons: ['x'], options: {}, mode: 'run' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /standard model; critical work requires a large model/);
  assert.match(refused.message, /sol/);

  const allowed = enforce({ vendor: 'codex', tier: 'terra', model: 'gpt-5.6-terra', critical: true, reasons: ['x'], options: { allowSmall: true }, mode: 'run' });
  assert.equal(allowed.ok, true);
});

test('enforce passes a large model on critical work (codex sol, grok best)', () => {
  const sol = enforce({ vendor: 'codex', tier: 'sol', model: 'gpt-5.6-sol', critical: true, reasons: ['x'], options: {}, mode: 'run' });
  assert.equal(sol.ok, true);
  const grokBest = enforce({ vendor: 'grok', tier: 'best', model: 'grok-4.6', critical: true, reasons: ['x'], options: {}, mode: 'run' });
  assert.equal(grokBest.ok, true);
});

test('enforce refuses opencode and cursor on critical work (no large tier) unless allowSmall', () => {
  const opencodeRefused = enforce({ vendor: 'opencode', tier: 'go', model: 'opencode-go/kimi-k2.7-code', critical: true, reasons: ['x'], options: {}, mode: 'run' });
  assert.equal(opencodeRefused.ok, false);
  const opencodeAllowed = enforce({ vendor: 'opencode', tier: 'go', model: 'opencode-go/kimi-k2.7-code', critical: true, reasons: ['x'], options: { allowSmall: true }, mode: 'run' });
  assert.equal(opencodeAllowed.ok, true);

  const cursorRefused = enforce({ vendor: 'cursor', tier: 'composer', model: 'composer-2.5', critical: true, reasons: ['x'], options: {}, mode: 'run' });
  assert.equal(cursorRefused.ok, false);
  assert.match(cursorRefused.message, /vendor with a large tier/);
});

test('enforce treats an unresolvable raw model slug as not-large (a typo cannot bypass the guard)', () => {
  const refused = enforce({ vendor: 'codex', tier: 'gpt-5.6-typo', model: 'gpt-5.6-typo', critical: true, reasons: ['x'], options: {}, mode: 'run' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /unknown model; critical work requires a large model/);
});

test('enforce caps the reasons list embedded in the refusal message to 5, with a "+N more" tail', () => {
  const reasons = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
  const refused = enforce({ vendor: 'codex', tier: 'terra', model: 'gpt-5.6-terra', critical: true, reasons, options: {}, mode: 'run' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /r1; r2; r3; r4; r5; \+2 more/);
  assert.doesNotMatch(refused.message, /r6/);
});

test('enforce never refuses when only suspected (critical: false), regardless of tier', () => {
  const result = enforce({ vendor: 'codex', tier: 'luna', model: 'gpt-5.6-luna', critical: false, reasons: [], options: {}, mode: 'run' });
  assert.equal(result.ok, true);
});

test('enforce warns on critical work with full bypass permissions', () => {
  const result = enforce({ vendor: 'agy', tier: 'opus', model: 'claude-opus-4-6-thinking', critical: true, reasons: ['x'], options: {}, mode: 'run' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => /bypass/i.test(w)));
  assert.ok(result.warnings.some(w => /destructive commands/.test(w)));
});

test('enforce never refuses on resume, but still warns', () => {
  const result = enforce({ vendor: 'agy', tier: '', model: '', critical: true, reasons: ['x'], options: {}, mode: 'resume' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => /bypass/i.test(w)));
});

// H4: a trailing '/**' guard.paths glob (the idiomatic "this dir and everything under it"
// pattern) used to compile to a regex requiring a slash after the prefix (`^/srv/prod/.*$`), so
// cwd === the guarded root exactly (no trailing segment) silently did NOT match — exactly the
// case that most needs to match.
test('assessCriticality: a trailing /** guard.paths glob also matches the bare directory itself (H4)', () => {
  const config = { keywords: [], paths: ['/srv/prod/**'] };
  const exact = assessCriticality({ brief: '', cwd: '/srv/prod', options: {}, config });
  assert.equal(exact.critical, true);
  const nested = assessCriticality({ brief: '', cwd: '/srv/prod/app', options: {}, config });
  assert.equal(nested.critical, true);
  const sibling = assessCriticality({ brief: '', cwd: '/srv/production', options: {}, config });
  assert.equal(sibling.critical, false);
});

// Tested directly against globToRegExp/pathMatches rather than through assessCriticality: M2's
// path.resolve() step is host-platform-dependent (POSIX's path.resolve doesn't recognize a
// Windows-style backslash path as absolute), so a literal Windows path only round-trips
// meaningfully on an actual win32 host. The normalization itself — backslashes to forward
// slashes, on both sides — is what H4 fixes and is host-independent to test directly.
test('pathMatches: backslashes are normalized on both glob and candidate so Windows-style paths match (H4)', () => {
  assert.equal(pathMatches('/srv/prod/**', '\\srv\\prod\\app'), true);
  assert.equal(pathMatches('\\srv\\prod\\**', '/srv/prod/app'), true);
  assert.equal(pathMatches('/srv/prod/**', '\\srv\\production'), false);
});

// M2: cwd/addDir are now resolved to absolute paths once, inside assessCriticality itself, so
// lib/runner.js's invoke() and lib/route.js's runAuto() (which both call this same function)
// always agree on the verdict for the same relative input — a relative --add-dir or cwd can no
// longer slip past the guard in one caller while being caught in the other.
test('assessCriticality: a relative --add-dir into a guarded path is resolved and matches (M2)', () => {
  const config = { keywords: [], paths: ['/srv/prod/**'] };
  const cwd = process.cwd();
  const relative = path.relative(cwd, '/srv/prod/subdir') || '.';
  const result = assessCriticality({ brief: '', cwd: '/tmp/somewhere', addDir: [relative], options: {}, config });
  assert.equal(result.critical, true);
});

test('assessCriticality: a relative cwd resolved against process.cwd() matches guard.paths (M2)', () => {
  const config = { keywords: [], paths: [`${process.cwd()}/**`] };
  const result = assessCriticality({ brief: '', cwd: '.', options: {}, config });
  assert.equal(result.critical, true);
});

// F1: an empty/omitted `cwd` (what lib/runner.js's invoke() and lib/route.js's runAuto() both
// pass through unresolved as `options.cd || ''`) must default to process.cwd() INSIDE
// assessCriticality itself, so both callers agree on the verdict whether or not they bothered to
// pre-resolve. Regression: runner.js used to pre-resolve `options.cd || process.cwd()` before
// calling assessCriticality while route.js passed `options.cd || ''` straight through — the two
// callers could disagree on a guarded cwd with no --cd given.
test('assessCriticality: an empty cwd defaults to process.cwd() (F1)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-f1-'));
  const config = { keywords: [], paths: [`${scratch}/**`] };
  const originalCwd = process.cwd();
  process.chdir(scratch);
  try {
    const withEmptyCwd = assessCriticality({ brief: '', cwd: '', options: {}, config });
    assert.equal(withEmptyCwd.critical, true);

    const withExplicitCwd = assessCriticality({ brief: '', cwd: process.cwd(), options: {}, config });
    assert.equal(withExplicitCwd.critical, true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
