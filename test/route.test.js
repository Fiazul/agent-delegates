'use strict';

// Tests for lib/route.js: pickVendor() (pure, judged from literal lib/status.js row text) and
// runAuto() (quota-exhaustion-only hop logic, invoke/handoff injected so no live vendor calls).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isHopWorthy, pickVendor, runAuto: realRunAuto } = require('../lib/route');

// Hermetic: runAuto now reads routing.json `priority` from `home` (same as `pick`), so every call runs
// against an empty scratch home unless a test passes its own `home`/`config`, never the real ~/.config.
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-route-home-'));
const runAuto = (briefSource, options = {}, stdinText) => realRunAuto(briefSource, { home: ISOLATED_HOME, ...options }, stdinText);

test('pickVendor: claude usable with wk N% > 0', () => {
  const rows = [['claude', 'wk 42% · 5h 88%', 'opus-5.5 sonnet-5.5']];
  assert.equal(pickVendor(rows, ['claude']), 'claude');
});

test('pickVendor: claude unusable at wk 0%', () => {
  const rows = [['claude', 'wk 0% · 5h 12%', 'opus-5.5']];
  assert.equal(pickVendor(rows, ['claude']), null);
});

test('pickVendor: claude "no snapshot" treated as usable (unknown, last fallback)', () => {
  const rows = [['claude', 'no snapshot', '-']];
  assert.equal(pickVendor(rows, ['claude']), 'claude');
});

test('pickVendor: codex logged out is unusable', () => {
  const rows = [['codex', 'logged out', '?']];
  assert.equal(pickVendor(rows, ['codex']), null);
});

test('pickVendor: codex EXHAUSTED suffix is unusable', () => {
  const rows = [['codex', 'wk 40% (reset 3h) · 5h 20%  EXHAUSTED', 'gpt-6.1-sol']];
  assert.equal(pickVendor(rows, ['codex']), null);
});

test('pickVendor: codex "usage unavailable" treated as usable (unknown)', () => {
  const rows = [['codex', 'usage unavailable', 'gpt-6.1-sol']];
  assert.equal(pickVendor(rows, ['codex']), 'codex');
});

test('pickVendor: codex unusable when either bucket is 0%', () => {
  const rows = [['codex', 'wk 0% (reset 3h) · 5h 20%', 'gpt-6.1-sol']];
  assert.equal(pickVendor(rows, ['codex']), null);
  const rows2 = [['codex', 'wk 40% (reset 3h) · 5h 0%', 'gpt-6.1-sol']];
  assert.equal(pickVendor(rows2, ['codex']), null);
});

test('pickVendor: codex usable when both buckets > 0%', () => {
  const rows = [['codex', 'wk 40% (reset 3h) · 5h 20%', 'gpt-6.1-sol']];
  assert.equal(pickVendor(rows, ['codex']), 'codex');
});

test('pickVendor: codex handles unrounded fractional percentages (F2)', () => {
  // status.js does not round codex percentages: a near-zero-but-positive quota looks like
  // "wk 0.4000000000000057%" — the old \d+-only regex failed to match this at all and fell
  // through to "usable" regardless of the actual (near-zero) value.
  const usable = [['codex', 'wk 0.4000000000000057% (reset 3h) · 5h 12.5%', 'gpt-6.1-sol']];
  assert.equal(pickVendor(usable, ['codex']), 'codex');
  const zeroWk = [['codex', 'wk 0% (reset 3h) · 5h 12.5%', 'gpt-6.1-sol']];
  assert.equal(pickVendor(zeroWk, ['codex']), null);
  const zero5h = [['codex', 'wk 40.25% (reset 3h) · 5h 0.0%', 'gpt-6.1-sol']];
  assert.equal(pickVendor(zero5h, ['codex']), null);
});

test('pickVendor: agy usable when gemini bucket > 0%', () => {
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', 'gemini-3.8-flash-high']];
  assert.equal(pickVendor(rows, ['agy']), 'agy');
});

test('pickVendor: agy unusable when gemini bucket is 0%', () => {
  const rows = [['agy', 'gemini wk 0% · claude/gpt wk 10%', 'gemini-3.8-flash-high']];
  assert.equal(pickVendor(rows, ['agy']), null);
});

test('pickVendor: grok logged out / exhausted are unusable', () => {
  assert.equal(pickVendor([['grok', 'logged out', 'grok-4.5']], ['grok']), null);
  assert.equal(pickVendor([['grok', 'exhausted (402 on 2026-09-17)', 'grok-4.5']], ['grok']), null);
});

test('pickVendor: grok "ok" and "logged in · quota via --probe-grok" are usable', () => {
  assert.equal(pickVendor([['grok', 'ok', 'grok-4.5']], ['grok']), 'grok');
  assert.equal(pickVendor([['grok', 'logged in · quota via --probe-grok', 'grok-4.5']], ['grok']), 'grok');
});

test('pickVendor: cursor usable when exactly "logged in · no quota API" (unknown, no token/API unreachable)', () => {
  assert.equal(pickVendor([['cursor', 'logged in · no quota API', 'auto']], ['cursor']), 'cursor');
  assert.equal(pickVendor([['cursor', 'logged out', 'auto']], ['cursor']), null);
  assert.equal(pickVendor([['cursor', 'unavailable', 'auto']], ['cursor']), null);
  assert.equal(pickVendor([['cursor', 'missing', 'auto']], ['cursor']), null);
});

test('pickVendor: cursor real-quota row is usable when included % left > 0', () => {
  const row = 'included 85% left · resets Oct 16 (auto 85% · api 91%)';
  assert.equal(pickVendor([['cursor', row, 'auto']], ['cursor']), 'cursor');
});

test('pickVendor: cursor real-quota row is unusable at included 0% left (exhausted)', () => {
  const row = 'included 0% left · resets Oct 16 (auto 0% · api 0%)';
  assert.equal(pickVendor([['cursor', row, 'auto']], ['cursor']), null);
});

test('pickVendor: opencode usable unless missing/logged out', () => {
  assert.equal(pickVendor([['opencode', 'logged in · no quota API', 'opencode/mimo-v2.5-free']], ['opencode']), 'opencode');
  assert.equal(pickVendor([['opencode', 'missing', 'opencode/mimo-v2.5-free']], ['opencode']), null);
  assert.equal(pickVendor([['opencode', 'logged out', 'opencode/mimo-v2.5-free']], ['opencode']), null);
});

test('pickVendor: returns first usable in priority order, else null', () => {
  const rows = [
    ['agy', 'gemini wk 0% · claude/gpt wk 0%', '?'],
    ['codex', 'logged out', '?'],
    ['grok', 'ok', 'grok-4.5']
  ];
  assert.equal(pickVendor(rows, ['agy', 'codex', 'grok']), 'grok');
  assert.equal(pickVendor(rows, ['agy', 'codex']), null);
});

test('runAuto: first vendor succeeds -> one attempt, no handoff called', async () => {
  // Default priority (codex -> opencode -> claude): agy has quota too but must NOT be chosen.
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'], ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']];
  let handoffCalls = 0;
  const invokeCalls = [];
  const invoke = async (mode, vendor, tier) => { invokeCalls.push({ vendor, tier }); return { code: 0, outDir: '/out/codex-1', vendor, tier, failed: false, exhausted: false }; };
  const result = await runAuto('brief.md', { rows, invoke, handoff: async () => { handoffCalls++; } }, '');
  assert.equal(result.code, 0);
  assert.equal(result.vendor, 'codex');
  assert.deepEqual(invokeCalls, [{ vendor: 'codex', tier: 'sol' }]);
  assert.equal(result.attempts.length, 1);
  assert.equal(handoffCalls, 0);
});

test('runAuto: first exhausted -> handoff called with outDir and next vendor, two attempts', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const invokeCalls = [];
  const handoffCalls = [];
  const invoke = async (mode, vendor, tier) => {
    invokeCalls.push({ mode, vendor, tier });
    return { code: 1, outDir: '/out/agy-1', failed: true, exhausted: true, reason: 'RESOURCE_EXHAUSTED (429)' };
  };
  const handoff = async (outDir, targetVendor, tier) => {
    handoffCalls.push({ outDir, targetVendor, tier });
    return { code: 0, outDir: '/out/codex-2', failed: false, exhausted: false };
  };
  const result = await runAuto('brief.md', { rows, priority: 'agy,codex', invoke, handoff }, '');
  assert.equal(invokeCalls.length, 1);
  assert.equal(handoffCalls.length, 1);
  assert.deepEqual(handoffCalls[0], { outDir: '/out/agy-1', targetVendor: 'codex', tier: 'sol' });
  assert.equal(result.vendor, 'codex');
  assert.equal(result.code, 0);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].vendor, 'agy');
  assert.equal(result.attempts[0].exhausted, true);
  assert.equal(result.attempts[1].vendor, 'codex');
});

test('runAuto: non-quota failure does not hop', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  let handoffCalls = 0;
  const invoke = async () => ({ code: 1, outDir: '/out/agy-1', failed: true, exhausted: false, reason: 'TypeError: cannot read property of undefined' });
  const handoff = async () => { handoffCalls++; return {}; };
  const result = await runAuto('brief.md', { rows, priority: 'agy,codex', invoke, handoff }, '');
  assert.equal(handoffCalls, 0);
  assert.equal(result.vendor, 'agy');
  assert.equal(result.code, 1);
  assert.equal(result.attempts.length, 1);
});

test('runAuto: maxHops respected (stops hopping after the cap even if still exhausted)', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?'],
    ['grok', 'ok', '?'],
    ['cursor', 'logged in · no quota API', '?']
  ];
  const handoffCalls = [];
  const invoke = async () => ({ code: 1, outDir: '/out/agy-1', failed: true, exhausted: true, reason: 'quota exceeded' });
  const handoff = async (outDir, targetVendor) => {
    handoffCalls.push(targetVendor);
    return { code: 1, outDir: `/out/${targetVendor}-x`, failed: true, exhausted: true, reason: 'quota exceeded' };
  };
  const result = await runAuto('brief.md', { rows, priority: 'agy,codex,grok,cursor', maxHops: 1, invoke, handoff }, '');
  assert.equal(handoffCalls.length, 1);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.vendor, 'codex');
  assert.equal(result.code, 1);
});

test('runAuto: non-numeric --max-hops falls back to default (2), not zero hops (F3)', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const handoffCalls = [];
  const invoke = async () => ({ code: 1, outDir: '/out/agy-1', failed: true, exhausted: true, reason: 'quota exceeded' });
  const handoff = async (outDir, targetVendor) => {
    handoffCalls.push(targetVendor);
    return { code: 0, outDir: `/out/${targetVendor}-2`, failed: false, exhausted: false };
  };
  const result = await runAuto('brief.md', { rows, priority: 'agy,codex', maxHops: 'not-a-number', invoke, handoff }, '');
  assert.equal(handoffCalls.length, 1); // would be 0 if NaN maxHops silently disabled hopping
  assert.equal(result.vendor, 'codex');
  assert.equal(result.code, 0);
});

test('runAuto: always uses each vendor\'s own default tier, ignoring options.tier (F4)', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const invokeCalls = [];
  const handoffCalls = [];
  const invoke = async (mode, vendor, tier) => {
    invokeCalls.push({ vendor, tier });
    return { code: 1, outDir: '/out/agy-1', failed: true, exhausted: true, reason: 'quota exceeded' };
  };
  const handoff = async (outDir, targetVendor, tier) => {
    handoffCalls.push({ targetVendor, tier });
    return { code: 0, outDir: '/out/codex-2', failed: false, exhausted: false };
  };
  await runAuto('brief.md', { rows, priority: 'agy,codex', tier: 'opus', invoke, handoff }, '');
  assert.equal(invokeCalls[0].tier, 'flash'); // agy default, not the bogus cross-vendor "opus"
  assert.equal(handoffCalls[0].tier, 'sol'); // codex default
});

test('runAuto: nothing usable -> throws with tried list', async () => {
  const rows = [
    ['agy', 'gemini wk 0% · claude/gpt wk 0%', '?'],
    ['codex', 'logged out', '?']
  ];
  await assert.rejects(
    () => runAuto('brief.md', { rows, priority: 'agy,codex', invoke: async () => ({}), respectPolicy: false }, ''),
    /no vendor with quota; tried: agy, codex/
  );
});

test('runAuto: policy says stay on claude -> claude moved to front of priority', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['claude', 'wk 30% · 5h 12%', 'opus-5.5']
  ];
  const invokeCalls = [];
  const invoke = async (mode, vendor, tier) => {
    invokeCalls.push(vendor);
    return { code: 0, outDir: '/out/1', failed: false, exhausted: false };
  };
  const result = await runAuto('brief.md', {
    rows,
    priority: 'agy,claude',
    invoke,
    decide: () => ({ route: 'claude', reason: 'wk 30% used vs 14% of week elapsed' })
  }, '');
  assert.equal(result.vendor, 'claude');
  assert.equal(invokeCalls[0], 'claude');
});

test('runAuto: policy says external -> priority unchanged, default vendor wins', async () => {
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  const invokeCalls = [];
  const invoke = async (mode, vendor) => {
    invokeCalls.push(vendor);
    return { code: 0, outDir: '/out/1', failed: false, exhausted: false };
  };
  const result = await runAuto('brief.md', {
    rows,
    priority: 'agy,codex',
    invoke,
    decide: () => ({ route: 'external', reason: 'wk 60% used vs 14% of week elapsed' })
  }, '');
  assert.equal(result.vendor, 'agy');
  assert.equal(invokeCalls[0], 'agy');
});

test('runAuto: respectPolicy false skips the decide call entirely', async () => {
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  let decideCalled = false;
  const invoke = async (mode, vendor) => ({ code: 0, outDir: '/out/1', failed: false, exhausted: false, vendor });
  const result = await runAuto('brief.md', {
    rows,
    priority: 'agy',
    invoke,
    respectPolicy: false,
    decide: () => { decideCalled = true; return { route: 'claude' }; }
  }, '');
  assert.equal(decideCalled, false);
  assert.equal(result.vendor, 'agy');
});

test('runAuto: critical work picks CRITICAL_TIER, skips vendors with no large tier', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?'],
    ['cursor', 'logged in · no quota API', '?'],
    ['opencode', 'logged in · no quota API', '?']
  ];
  const invokeCalls = [];
  const invoke = async (mode, vendor, tier) => {
    invokeCalls.push({ vendor, tier });
    return { code: 1, outDir: '/out/1', failed: true, exhausted: true, reason: 'RESOURCE_EXHAUSTED (429)' };
  };
  const handoffCalls = [];
  const handoff = async (outDir, targetVendor, tier) => {
    handoffCalls.push({ targetVendor, tier });
    return { code: 0, outDir: '/out/2', failed: false, exhausted: false };
  };
  const result = await runAuto('brief.md', {
    rows,
    priority: 'agy,codex,cursor,opencode',
    invoke,
    handoff,
    respectPolicy: false,
    assess: () => ({ critical: true, reasons: ['--critical flag set'] })
  }, '');
  assert.equal(invokeCalls[0].vendor, 'agy');
  assert.equal(invokeCalls[0].tier, 'opus'); // CRITICAL_TIER.agy
  assert.equal(handoffCalls[0].targetVendor, 'codex');
  assert.equal(handoffCalls[0].tier, 'sol-high'); // CRITICAL_TIER.codex
  // cursor/opencode were never tried — both filtered out for having no large tier
  assert.equal(result.attempts.some(a => a.vendor === 'cursor' || a.vendor === 'opencode'), false);
});

test('runAuto: critical work with --allow-small behaves like non-critical (default tiers, no skipping)', async () => {
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  const invokeCalls = [];
  const invoke = async (mode, vendor, tier) => {
    invokeCalls.push({ vendor, tier });
    return { code: 0, outDir: '/out/1', failed: false, exhausted: false };
  };
  await runAuto('brief.md', {
    rows,
    priority: 'agy',
    invoke,
    respectPolicy: false,
    allowSmall: true,
    assess: () => ({ critical: true, reasons: ['--critical flag set'] })
  }, '');
  assert.equal(invokeCalls[0].tier, 'flash'); // DEFAULT_TIER.agy, unchanged
});

test('runAuto: non-critical work uses default tiers unchanged', async () => {
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  const invokeCalls = [];
  const invoke = async (mode, vendor, tier) => {
    invokeCalls.push({ vendor, tier });
    return { code: 0, outDir: '/out/1', failed: false, exhausted: false };
  };
  await runAuto('brief.md', {
    rows,
    priority: 'agy',
    invoke,
    respectPolicy: false,
    assess: () => ({ critical: false, reasons: [] })
  }, '');
  assert.equal(invokeCalls[0].tier, 'flash');
});

test('runAuto: suspected-only (keyword hint, not critical) prints CRITICAL? once and uses default tiers', async () => {
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  const invokeCalls = [];
  const invoke = async (mode, vendor, tier) => {
    invokeCalls.push({ vendor, tier });
    return { code: 0, outDir: '/out/1', failed: false, exhausted: false };
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runAuto('brief.md', {
      rows,
      priority: 'agy',
      invoke,
      respectPolicy: false,
      assess: () => ({ critical: false, suspected: true, reasons: [], hints: ['heuristic: keyword "deploy" in brief'] })
    }, '');
  } finally {
    console.log = originalLog;
  }
  // Default tier (no upgrade), and no hard CRITICAL line — only the advisory CRITICAL? print.
  assert.equal(invokeCalls[0].tier, 'flash');
  assert.equal(logs.filter(l => l.includes('CRITICAL?')).length, 1, JSON.stringify(logs));
  assert.ok(logs.some(l => l.includes('heuristic: keyword "deploy" in brief')), JSON.stringify(logs));
  assert.ok(!logs.some(l => /\bCRITICAL:/.test(l)), 'suspected-only must never print the hard CRITICAL: line');
});

// M2: runAuto used the REAL assessCriticality (not an injected `assess`) here on purpose — this
// is an integration check that lib/route.js's runAuto and lib/guard.js's assessCriticality
// resolve a relative --cd the same way lib/runner.js's invoke() does, since assessCriticality
// itself now does the path.resolve(), not each caller individually.
test('runAuto: a relative --cd ("." ) into a guard.paths-guarded directory resolves and picks CRITICAL_TIER, never throws (M2)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-route-guard-home-'));
  const guardedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-route-guarded-'));
  const configDir = path.join(fakeHome, '.config', 'delegates');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({ guard: { paths: [`${guardedRoot}/**`] } }));

  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedCwd = process.cwd();
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.chdir(guardedRoot);
  try {
    const rows = [['codex', 'wk 40% (reset 3h) · 5h 20%', '?']];
    const invokeCalls = [];
    const invoke = async (mode, vendor, tier) => {
      invokeCalls.push({ vendor, tier });
      return { code: 0, outDir: '/out/1', failed: false, exhausted: false };
    };
    const result = await runAuto('brief.md', { rows, priority: 'codex', invoke, respectPolicy: false, cd: '.' }, '');
    assert.equal(result.code, 0);
    assert.equal(invokeCalls.length, 1);
    assert.equal(invokeCalls[0].vendor, 'codex');
    assert.equal(invokeCalls[0].tier, 'sol-high'); // CRITICAL_TIER.codex — proves critical was detected
  } finally {
    process.chdir(savedCwd);
    if (savedHome == null) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

// F1: with no --cd at all, runAuto passes cd: '' straight through to the real assessCriticality,
// which must now default the empty cwd to process.cwd() itself (rather than each caller
// pre-resolving). Run from inside a guard.paths-guarded directory with no --cd: still detected
// critical, cursor/opencode still dropped for having no large tier, CRITICAL_TIER still picked.
test('runAuto: no --cd inside a guarded directory still resolves via process.cwd() and picks CRITICAL_TIER, drops cursor/opencode (F1)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-route-guard-home-'));
  const guardedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-route-guarded-'));
  const configDir = path.join(fakeHome, '.config', 'delegates');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({ guard: { paths: [`${guardedRoot}/**`] } }));

  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedCwd = process.cwd();
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.chdir(guardedRoot);
  try {
    const rows = [
      ['codex', 'wk 40% (reset 3h) · 5h 20%', '?'],
      ['cursor', 'logged in · no quota API', '?'],
      ['opencode', 'logged in · no quota API', '?']
    ];
    const invokeCalls = [];
    const invoke = async (mode, vendor, tier) => {
      invokeCalls.push({ vendor, tier });
      return { code: 0, outDir: '/out/1', failed: false, exhausted: false };
    };
    const result = await runAuto('brief.md', { rows, priority: 'codex,cursor,opencode', invoke, respectPolicy: false }, '');
    assert.equal(result.code, 0);
    assert.equal(invokeCalls.length, 1);
    assert.equal(invokeCalls[0].tier, 'sol-high'); // CRITICAL_TIER.codex — proves critical was detected with no --cd
    assert.equal(result.attempts.some(a => a.vendor === 'cursor' || a.vendor === 'opencode'), false);
  } finally {
    process.chdir(savedCwd);
    if (savedHome == null) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

// R6: pickVendor gains an optional opts.resolveBin (unused by every caller above and by
// lib/policy.js — pure back-compat) that excludes a vendor whose binary can't actually be
// resolved (e.g. a cursor/grok PATH identity conflict, see lib/bins.js) from ever being
// picked, instead of picking it on quota text alone and finding out only at spawn time.
test('R6: pickVendor excludes a vendor whose resolveBin resolves to no command, only when opts.resolveBin is supplied', () => {
  const rows = [
    ['cursor', 'logged in · no quota API', 'auto'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const resolveBin = vendor => (vendor === 'cursor' ? { command: null, reason: 'conflict' } : { command: `/usr/bin/${vendor}` });
  assert.equal(pickVendor(rows, ['cursor', 'codex'], { resolveBin }), 'codex');
  // Back-compat: no opts.resolveBin -> unaffected, cursor picked first as before.
  assert.equal(pickVendor(rows, ['cursor', 'codex']), 'cursor');
});

test('R6: pickVendor treats a resolveBin that throws the same as "no command" (never lets the throw escape)', () => {
  const rows = [['cursor', 'logged in · no quota API', 'auto'], ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']];
  const resolveBin = vendor => { if (vendor === 'cursor') throw new Error('boom'); return { command: `/usr/bin/${vendor}` }; };
  assert.equal(pickVendor(rows, ['cursor', 'codex'], { resolveBin }), 'codex');
});

test('isHopWorthy: exit-127-style "process exited 127"/"exited 127 before a result" failures hop even with no quota-ish text (R6)', () => {
  assert.equal(isHopWorthy({ failed: true, reason: 'grok process exited 127 with no result' }), true);
  assert.equal(isHopWorthy({ failed: true, reason: 'cursor exited 127 before a result event' }), true);
  assert.equal(isHopWorthy({ failed: true, reason: 'TypeError: cannot read property of undefined' }), false);
  assert.equal(isHopWorthy({ failed: false, reason: '' }), false);
  assert.equal(isHopWorthy({ exhausted: true }), true);
  assert.equal(isHopWorthy(null), false);
});

test('R6: runAuto hops on an exit-127-style bin-not-found failure, not just quota-text failures', async () => {
  const rows = [
    ['grok', 'ok', 'grok-4.6'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const invoke = async () => ({ code: 1, outDir: '/out/grok-1', failed: true, exhausted: false, reason: 'grok process exited 127 with no result' });
  const handoff = async (outDir, targetVendor) => ({ code: 0, outDir: `/out/${targetVendor}-2`, failed: false, exhausted: false });
  const result = await runAuto('brief.md', { rows, priority: 'grok,codex', invoke, handoff }, '');
  assert.equal(result.vendor, 'codex');
  assert.equal(result.code, 0);
});

// R6 cosmetic: an exit-127 (bin-not-found) hop was never a quota exhaustion — the hop log line
// must say "unavailable", not "exhausted", for that case (still says "exhausted" for a real
// quota hop).
test('R6: the hop log line says "unavailable" (not "exhausted") for a bin-not-found hop, and "exhausted" for a real quota hop', async () => {
  const rows = [
    ['grok', 'ok', 'grok-4.6'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const handoff = async (outDir, targetVendor) => ({ code: 0, outDir: `/out/${targetVendor}-2`, failed: false, exhausted: false });
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const invokeBinMissing = async () => ({ code: 1, outDir: '/out/grok-1', failed: true, exhausted: false, reason: 'grok process exited 127 with no result' });
    await runAuto('brief.md', { rows, priority: 'grok,codex', invoke: invokeBinMissing, handoff }, '');
    assert.ok(logs.some(l => /grok unavailable → handing off to codex/.test(l)), JSON.stringify(logs));
    assert.ok(!logs.some(l => /grok exhausted → handing off/.test(l)), JSON.stringify(logs));

    logs.length = 0;
    const invokeQuota = async () => ({ code: 1, outDir: '/out/grok-1', failed: true, exhausted: true, reason: 'grok HTTP 402' });
    await runAuto('brief.md', { rows, priority: 'grok,codex', invoke: invokeQuota, handoff }, '');
    assert.ok(logs.some(l => /grok exhausted → handing off to codex/.test(l)), JSON.stringify(logs));
  } finally {
    console.log = originalLog;
  }
});

// R5: invoke() (and handoff()) can THROW rather than return a failed result (preflight
// failure, an unresolvable binary, the critical-work guard) — a thrown error must not abort
// the whole `run auto` while another vendor in the priority list still has quota.
test('R5: runAuto skips a vendor whose invoke() throws and tries the next usable vendor instead of aborting', async () => {
  const rows = [
    ['cursor', 'logged in · no quota API', 'auto'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const invokeCalls = [];
  const invoke = async (mode, vendor) => {
    invokeCalls.push(vendor);
    if (vendor === 'cursor') throw new Error("cursor: 'agent' on PATH resolves to /opt/grok/bin/agent, which looks like grok");
    return { code: 0, outDir: '/out/codex-1', failed: false, exhausted: false };
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let result;
  try {
    result = await runAuto('brief.md', { rows, priority: 'cursor,codex', invoke, respectPolicy: false }, '');
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(invokeCalls, ['cursor', 'codex']);
  assert.equal(result.vendor, 'codex');
  assert.equal(result.code, 0);
  assert.ok(logs.some(l => /AUTO: cursor skipped —.*looks like grok/.test(l)), JSON.stringify(logs));
});

test('R5: runAuto skips a vendor whose handoff() throws (mid-hop) and tries the next usable vendor', async () => {
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['cursor', 'logged in · no quota API', 'auto'],
    ['codex', 'wk 40% (reset 3h) · 5h 20%', '?']
  ];
  const invoke = async () => ({ code: 1, outDir: '/out/agy-1', failed: true, exhausted: true, reason: 'RESOURCE_EXHAUSTED (429)' });
  const handoffCalls = [];
  const handoff = async (outDir, targetVendor) => {
    handoffCalls.push(targetVendor);
    if (targetVendor === 'cursor') throw new Error('handoff: source job was critical and cursor has no large-model tier');
    return { code: 0, outDir: `/out/${targetVendor}-2`, failed: false, exhausted: false };
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let result;
  try {
    result = await runAuto('brief.md', { rows, priority: 'agy,cursor,codex', invoke, handoff, respectPolicy: false }, '');
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(handoffCalls, ['cursor', 'codex']);
  assert.equal(result.vendor, 'codex');
  assert.equal(result.code, 0);
  assert.ok(logs.some(l => /AUTO: cursor skipped —.*no large-model tier/.test(l)), JSON.stringify(logs));
});

test('R5: runAuto surfaces a failure (never hangs/silently succeeds) when every remaining vendor throws', async () => {
  const rows = [
    ['cursor', 'logged in · no quota API', 'auto'],
    ['grok', 'ok', 'grok-4.6']
  ];
  const invoke = async (mode, vendor) => { throw new Error(`${vendor} boom`); };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await assert.rejects(
      () => runAuto('brief.md', { rows, priority: 'cursor,grok', invoke, respectPolicy: false }, ''),
      /no vendor with quota; tried: cursor, grok/
    );
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.some(l => /AUTO: cursor skipped — cursor boom/.test(l)), JSON.stringify(logs));
  assert.ok(logs.some(l => /AUTO: grok skipped — grok boom/.test(l)), JSON.stringify(logs));
});

test('F10: runAuto honors routing.json config.priority when --priority is not given (same resolver as pick); --priority still wins', async () => {
  const rows = [['codex', 'wk 40% · 5h 20%', '?'], ['opencode', 'logged in · no quota API', '?'], ['claude', 'wk 50% · 5h 10%', '?']];
  const invoke = async (mode, vendor, tier) => ({ code: 0, outDir: `/out/${vendor}`, vendor, tier, failed: false, exhausted: false });
  // config.priority puts opencode first
  const configured = await runAuto('brief.md', { rows, config: { priority: ['opencode', 'codex'] }, invoke, respectPolicy: false }, '');
  assert.equal(configured.vendor, 'opencode');
  // same via a routing.json on disk under `home`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-route-cfg-'));
  fs.mkdirSync(path.join(home, '.config', 'delegates'), { recursive: true });
  const { configPath } = require('../lib/policy');
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify({ priority: ['claude', 'codex'] }));
  const fromDisk = await runAuto('brief.md', { rows, home, invoke, respectPolicy: false }, '');
  assert.equal(fromDisk.vendor, 'claude');
  // explicit --priority beats config
  const explicit = await runAuto('brief.md', { rows, home, priority: 'codex', invoke, respectPolicy: false }, '');
  assert.equal(explicit.vendor, 'codex');
  // the shared resolver itself
  const { resolvePriority } = require('../lib/policy');
  assert.deepEqual(resolvePriority(undefined, { priority: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(resolvePriority(' x , y ', { priority: ['a'] }), ['x', 'y']);
  assert.deepEqual(resolvePriority('', null), ['codex', 'opencode', 'claude']);
});

test('F10: pick uses the shared resolver (--priority flag, else config.priority)', async () => {
  const { pick, DEFAULTS } = require('../lib/policy');
  const now = 1_700_000_000;
  const snapshot = { ts: now, five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30, resets_at: now + 6 * 86400 } };
  const rows = [['codex', 'wk 40% · 5h 20%', '?'], ['opencode', 'logged in · no quota API', '?']];
  const base = { now, snapshot, rows, home: ISOLATED_HOME, config: { ...DEFAULTS, priority: ['opencode', 'codex'] } };
  const viaConfig = await pick(base);
  assert.equal(viaConfig.route, 'external', JSON.stringify(viaConfig));
  assert.equal(viaConfig.vendor, 'opencode');
  const viaFlag = await pick({ ...base, priority: 'codex' });
  assert.equal(viaFlag.vendor, 'codex');
});

test('runAuto --self codex: the main agent\'s own vendor is dropped from the priority list', async () => {
  const calls = [];
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const result = await runAuto('brief.md', {
      self: 'codex', priority: 'codex,opencode', respectPolicy: false,
      rows: [['codex', 'wk 40% · 5h 20%', '?'], ['opencode', 'logged in · no quota API', '?']],
      assess: () => ({ critical: false, suspected: false, hints: [] }),
      resolveBin: () => ({ command: 'x' }),
      invoke: async (mode, vendor) => { calls.push(vendor); return { code: 0, outDir: '/tmp/x', exhausted: false, failed: false }; }
    }, '');
    assert.equal(result.vendor, 'opencode');
  } finally { console.log = orig; }
  assert.deepEqual(calls, ['opencode']);
});

test('review N1: runAuto --self claude reports continuing with external candidates', async () => {
  const calls = [];
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const result = await runAuto('brief.md', {
      self: 'claude', priority: 'claude,codex', respectPolicy: true,
      decide: () => ({ route: 'claude', reason: 'wk 30% used vs 14% of week elapsed' }),
      rows: [['claude', 'wk 40% · 5h 20%', '?'], ['codex', 'wk 40% · 5h 20%', '?']],
      assess: () => ({ critical: false, suspected: false, hints: [] }),
      resolveBin: () => ({ command: 'x' }),
      invoke: async (mode, vendor) => { calls.push(vendor); return { code: 0, outDir: '/tmp/x', exhausted: false, failed: false }; }
    }, '');
    assert.equal(result.vendor, 'codex');
  } finally { console.log = orig; }
  assert.deepEqual(calls, ['codex'], 'claude never spawned under --self claude');
  assert.ok(logs.includes('AUTO: policy prefers in-house; --self claude, so continuing with external candidates'), JSON.stringify(logs));
  assert.equal(logs.some(l => /stay on Claude/.test(l)), false);
});

test('F5 control: without --self claude the stay-on-claude verdict still prepends claude', async () => {
  const calls = [];
  const orig = console.log;
  console.log = () => {};
  try {
    await runAuto('brief.md', {
      priority: 'codex,claude', respectPolicy: true,
      decide: () => ({ route: 'claude', reason: 'x' }),
      rows: [['claude', 'wk 40% · 5h 20%', '?'], ['codex', 'wk 40% · 5h 20%', '?']],
      assess: () => ({ critical: false, suspected: false, hints: [] }),
      resolveBin: () => ({ command: 'x' }),
      invoke: async (mode, vendor) => { calls.push(vendor); return { code: 0, outDir: '/tmp/x', exhausted: false, failed: false }; }
    }, '');
  } finally { console.log = orig; }
  assert.deepEqual(calls, ['claude']);
});

test('F8: vendor names normalize identically for --self and priority entries (case, whitespace, antigravity -> agy)', async () => {
  const { resolvePriority, selfVendor } = require('../lib/policy');
  assert.deepEqual(resolvePriority(' Antigravity , CODEX,codex, Claude ', null), ['agy', 'codex', 'claude']);
  assert.deepEqual(resolvePriority(undefined, { priority: ['Antigravity', 'OpenCode'] }), ['agy', 'opencode']);
  for (const [input, want] of [['Antigravity', 'agy'], [' AGY ', 'agy'], ['CLAUDE', 'claude'], [undefined, '']]) assert.equal(selfVendor({ self: input }), want, String(input));
  // --self Antigravity drops an `antigravity`/`AGY` priority entry; --self CLAUDE drops claude
  const calls = [];
  const orig = console.log;
  console.log = () => {};
  try {
    await runAuto('brief.md', {
      self: 'Antigravity', priority: 'AGY,Codex', respectPolicy: false,
      rows: [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'], ['codex', 'wk 40% · 5h 20%', '?']],
      assess: () => ({ critical: false, suspected: false, hints: [] }),
      resolveBin: () => ({ command: 'x' }),
      invoke: async (mode, vendor) => { calls.push(vendor); return { code: 0, outDir: '/tmp/x', exhausted: false, failed: false }; }
    }, '');
  } finally { console.log = orig; }
  assert.deepEqual(calls, ['codex']);
});

test('review m3: a fresh cache missing a configured vendor is re-probed after priority changes', async () => {
  const { cachedRows, writeRowsCache } = require('../lib/route');
  const { configPath } = require('../lib/policy');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-config-cache-'));
  const saved = process.env.DELEGATE_CONSOLE_DIR;
  process.env.DELEGATE_CONSOLE_DIR = path.join(home, 'cache');
  try {
    const oldRows = [['codex', 'wk 40% · 5h 20%', '?']];
    writeRowsCache(oldRows);
    fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
    fs.writeFileSync(configPath(home), JSON.stringify({ priority: ['codex', 'grok'] }));
    let probes = 0;
    const newRows = [...oldRows, ['grok', 'logged in · quota via --probe-grok', '?']];
    const options = { home, probeRows: async () => { probes++; return newRows; } };
    assert.deepEqual(await cachedRows(options), newRows);
    assert.equal(probes, 1);
    assert.deepEqual(await cachedRows(options), newRows);
    assert.equal(probes, 1, 'complete cache is reused');
    writeRowsCache(oldRows);
    assert.deepEqual(await cachedRows({ ...options, priority: 'codex' }), oldRows);
    assert.equal(probes, 1, 'explicit priority controls the required vendors');
  } finally {
    if (saved == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = saved;
  }
});

test('review N2: stay-on-claude policy chooses eligible opus for yolo/critical', async () => {
  for (const flags of [{ yolo: true }, { critical: true }, { yolo: true, critical: true }, { yolo: true, critical: true, allowSmall: true }]) {
    const calls = [];
    const logs = [];
    const originalLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      const result = await runAuto('-', {
        ...flags, priority: 'grok', rows: [['claude', 'wk 40% · 5h 20%', '?'], ['grok', 'logged in', '?']],
        decide: () => ({ route: 'claude', reason: 'quota available' }),
        resolveBin: () => ({ command: 'fake' }),
        invoke: async (mode, vendor, tier) => {
          calls.push([vendor, tier]);
          assert.equal(vendor, 'claude');
          assert.equal(tier, 'opus', 'do not attempt sonnet before the frontier tier');
          return { code: 0, outDir: '/tmp/fake', failed: false };
        }
      }, 'reply OK');
      assert.equal(result.vendor, 'claude');
      assert.deepEqual(calls, [['claude', 'opus']]);
      assert.equal(logs.some(l => /claude skipped/.test(l)), false);
    } finally { console.log = originalLog; }
  }
});

test('review N2: an ineligible policy Claude candidate is skipped with a reason before invoke', async () => {
  const guard = require('../lib/guard');
  const originalEnforce = guard.enforce;
  const originalLog = console.log;
  const logs = [];
  const calls = [];
  guard.enforce = input => input.vendor === 'claude'
    ? { ok: false, message: 'claude has no eligible frontier tier', warnings: [] }
    : originalEnforce(input);
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const result = await runAuto('-', {
      priority: 'grok', rows: [['claude', 'wk 40% · 5h 20%', '?'], ['grok', 'logged in', '?']], yolo: true,
      decide: () => ({ route: 'claude', reason: 'quota available' }),
      resolveBin: () => ({ command: 'fake' }),
      invoke: async (mode, vendor) => { calls.push(vendor); return { code: 0, outDir: '/tmp/fake', failed: false }; }
    }, 'reply OK');
    assert.equal(result.vendor, 'grok');
    assert.deepEqual(calls, ['grok']);
    assert.ok(logs.some(l => /claude skipped.*no eligible frontier tier/.test(l)), JSON.stringify(logs));
  } finally {
    guard.enforce = originalEnforce;
    console.log = originalLog;
  }
});

test('F3: priority and policy Claude use one opus upgrade rule and log it', async () => {
  for (const policy of [false, true]) {
    for (const flags of [{ yolo: true }, { critical: true }, { critical: true, allowSmall: true }]) {
      const logs = [];
      const saved = console.log;
      console.log = line => logs.push(line);
      try {
        const result = await runAuto('-', {
          ...flags, priority: 'claude', rows: [['claude', 'wk 40% · 5h 20%', '?']],
          respectPolicy: policy, decide: () => ({ route: 'claude', reason: 'available' }),
          resolveBin: () => ({ command: 'fake' }),
          invoke: async (mode, vendor, tier, brief, options) => {
            assert.equal(tier, 'opus');
            const selection = require('../lib/models').resolveSelection(vendor, tier);
            const verdict = require('../lib/guard').enforce({ vendor, ...selection, critical: Boolean(flags.critical), options, mode });
            assert.equal(verdict.ok, true);
            assert.equal(Boolean(verdict.elevated), Boolean(flags.yolo));
            return { code: 0, outDir: '/tmp/fake' };
          }
        }, 'reply OK');
        assert.equal(result.vendor, 'claude');
        assert.equal(logs.filter(l => l === `AUTO: claude raised to opus (${flags.yolo ? '--yolo' : '--critical'})`).length, 1);
      } finally { console.log = saved; }
    }
  }
});

test('F6: all candidates removed by critical/yolo filters names the filtered vendors', async () => {
  for (const flags of [{ critical: true }, { yolo: true }, { critical: true, yolo: true }]) {
    await assert.rejects(runAuto('-', {
      ...flags, priority: 'cursor', rows: [['cursor', 'logged in · no quota API', '?']], respectPolicy: false,
      resolveBin: () => ({ command: 'fake' }), invoke: async () => assert.fail('must not invoke')
    }, 'reply OK'), /no eligible vendor: --critical\/--yolo filtered out cursor/);
  }
});
