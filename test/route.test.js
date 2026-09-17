'use strict';

// Tests for lib/route.js: pickVendor() (pure, judged from literal lib/status.js row text) and
// runAuto() (quota-exhaustion-only hop logic, invoke/handoff injected so no live vendor calls).

const assert = require('node:assert/strict');
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

test('pickVendor: grok "ok" and "unknown (--probe-grok)" are usable', () => {
  assert.equal(pickVendor([['grok', 'ok', 'grok-4.5']], ['grok']), 'grok');
  assert.equal(pickVendor([['grok', 'unknown (--probe-grok)', 'grok-4.5']], ['grok']), 'grok');
});

test('pickVendor: cursor usable only when exactly "ok"', () => {
  assert.equal(pickVendor([['cursor', 'ok', 'auto']], ['cursor']), 'cursor');
  assert.equal(pickVendor([['cursor', 'logged out', 'auto']], ['cursor']), null);
  assert.equal(pickVendor([['cursor', 'unavailable', 'auto']], ['cursor']), null);
  assert.equal(pickVendor([['cursor', 'missing', 'auto']], ['cursor']), null);
});

test('pickVendor: opencode usable unless missing/logged out', () => {
  assert.equal(pickVendor([['opencode', 'unknown', 'opencode/mimo-v2.5-free']], ['opencode']), 'opencode');
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
    ['cursor', 'ok', '?']
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
    () => runAuto('brief.md', { rows, priority: 'agy,codex', invoke: async () => ({}) }, ''),
    /no vendor with quota; tried: agy, codex/
  );
});
