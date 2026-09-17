'use strict';

// Tests for lib/route.js: pickVendor() (pure, judged from literal lib/status.js row text) and
// runAuto() (quota-exhaustion-only hop logic, invoke/handoff injected so no live vendor calls).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pickVendor, runAuto } = require('../lib/route');

test('pickVendor: claude usable with wk N% > 0', () => {
  const rows = [['claude', 'wk 42% · 5h 88%', 'fable-5.1 opus-5 sonnet-5 haiku-4.5']];
  assert.equal(pickVendor(rows, ['claude']), 'claude');
});

test('pickVendor: claude unusable at wk 0%', () => {
  const rows = [['claude', 'wk 0% · 5h 12%', 'fable-5.1']];
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
  const rows = [['codex', 'wk 40% (reset 3h) · 5h 20%  EXHAUSTED', 'gpt-5.6-terra']];
  assert.equal(pickVendor(rows, ['codex']), null);
});

test('pickVendor: codex "usage unavailable" treated as usable (unknown)', () => {
  const rows = [['codex', 'usage unavailable', 'gpt-5.6-terra']];
  assert.equal(pickVendor(rows, ['codex']), 'codex');
});

test('pickVendor: codex unusable when either bucket is 0%', () => {
  const rows = [['codex', 'wk 0% (reset 3h) · 5h 20%', 'gpt-5.6-terra']];
  assert.equal(pickVendor(rows, ['codex']), null);
  const rows2 = [['codex', 'wk 40% (reset 3h) · 5h 0%', 'gpt-5.6-terra']];
  assert.equal(pickVendor(rows2, ['codex']), null);
});

test('pickVendor: codex usable when both buckets > 0%', () => {
  const rows = [['codex', 'wk 40% (reset 3h) · 5h 20%', 'gpt-5.6-terra']];
  assert.equal(pickVendor(rows, ['codex']), 'codex');
});

test('pickVendor: codex handles unrounded fractional percentages (F2)', () => {
  // status.js does not round codex percentages: a near-zero-but-positive quota looks like
  // "wk 0.4000000000000057%" — the old \d+-only regex failed to match this at all and fell
  // through to "usable" regardless of the actual (near-zero) value.
  const usable = [['codex', 'wk 0.4000000000000057% (reset 3h) · 5h 12.5%', 'gpt-5.6-terra']];
  assert.equal(pickVendor(usable, ['codex']), 'codex');
  const zeroWk = [['codex', 'wk 0% (reset 3h) · 5h 12.5%', 'gpt-5.6-terra']];
  assert.equal(pickVendor(zeroWk, ['codex']), null);
  const zero5h = [['codex', 'wk 40.25% (reset 3h) · 5h 0.0%', 'gpt-5.6-terra']];
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
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  let handoffCalls = 0;
  const invoke = async (mode, vendor, tier) => ({ code: 0, outDir: '/out/agy-1', vendor, tier, failed: false, exhausted: false });
  const result = await runAuto('brief.md', { rows, invoke, handoff: async () => { handoffCalls++; } }, '');
  assert.equal(result.code, 0);
  assert.equal(result.vendor, 'agy');
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
  assert.deepEqual(handoffCalls[0], { outDir: '/out/agy-1', targetVendor: 'codex', tier: 'terra' });
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
  assert.equal(handoffCalls[0].tier, 'terra'); // codex default
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
    ['claude', 'wk 30% · 5h 12%', 'fable-5.1']
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
  assert.equal(handoffCalls[0].tier, 'sol'); // CRITICAL_TIER.codex
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
    assert.equal(invokeCalls[0].tier, 'sol'); // CRITICAL_TIER.codex — proves critical was detected
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
    assert.equal(invokeCalls[0].tier, 'sol'); // CRITICAL_TIER.codex — proves critical was detected with no --cd
    assert.equal(result.attempts.some(a => a.vendor === 'cursor' || a.vendor === 'opencode'), false);
  } finally {
    process.chdir(savedCwd);
    if (savedHome == null) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});
