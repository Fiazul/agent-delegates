'use strict';

// Tests for lib/policy.js decide()/loadConfig() — pure, literal snapshots, fixed `now`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULTS, configPath, decide, formatRouteCheck, loadConfig, routeCheck } = require('../lib/policy');

const NOW = 1789627000; // arbitrary fixed epoch seconds, close to the ts in a real snapshot

function snapshot({ ts = NOW, wk = 30, fh = 12, resetsAt } = {}) {
  return { ts, seven_day: { used_percentage: wk, resets_at: resetsAt }, five_hour: { used_percentage: fh } };
}

test('loadConfig: missing file -> defaults', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-policy-'));
  const config = loadConfig(home);
  assert.deepEqual(config, DEFAULTS);
});

test('loadConfig: partial file merges over defaults, unknown keys ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-policy-'));
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ threshold: 55, bogus: 'x' }));
  const config = loadConfig(home);
  assert.equal(config.threshold, 55);
  assert.equal(config.mode, DEFAULTS.mode);
  assert.equal(config.bogus, 'x'); // merged shallowly; harmless extra key, never read
  assert.deepEqual(config.priority, DEFAULTS.priority);
});

test('loadConfig: invalid JSON -> defaults', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-policy-'));
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadConfig(home), DEFAULTS);
});

test('decide: no snapshot -> unknown, stale', () => {
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: null });
  assert.equal(result.route, 'unknown');
  assert.equal(result.stale, true);
});

// L4: decide() called with no `config` used to fall back to loadConfig() with no `home` arg,
// which threw inside path.join(undefined, ...) before ever reaching the "fall back to defaults"
// behavior the caller presumably wanted.
test('decide: called with no config falls back to loadConfig(homeDir()) instead of throwing (L4)', () => {
  assert.doesNotThrow(() => decide({ now: NOW, snapshot: null }));
  const result = decide({ now: NOW, snapshot: null });
  assert.equal(result.route, 'unknown');
});

test('decide: snapshot older than staleMinutes -> unknown, stale', () => {
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshot({ ts: NOW - 11 * 60, resetsAt: NOW + 6 * 86400 }) });
  assert.equal(result.route, 'unknown');
  assert.equal(result.stale, true);
  assert.match(result.reason, /stale/);
});

test('decide: fixed mode, under threshold -> claude', () => {
  const config = { ...DEFAULTS, mode: 'fixed', threshold: 40 };
  const result = decide({ config, now: NOW, snapshot: snapshot({ wk: 30 }) });
  assert.equal(result.route, 'claude');
});

test('decide: fixed mode, at/over threshold -> external', () => {
  const config = { ...DEFAULTS, mode: 'fixed', threshold: 40 };
  const result = decide({ config, now: NOW, snapshot: snapshot({ wk: 40 }) });
  assert.equal(result.route, 'external');
});

test('decide: pace mode, usage within pace+slack -> claude', () => {
  // 14% of week elapsed (1 day left out of 7 -> ~85.7% elapsed... use explicit resetsAt for 1 day elapsed)
  const resetsAt = NOW + 6 * 86400; // 1 day elapsed out of 7 -> ~14.3% elapsed
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshot({ wk: 20, resetsAt }) });
  assert.equal(result.route, 'claude');
  assert.ok(result.elapsedPct > 13 && result.elapsedPct < 15, result.elapsedPct);
});

test('decide: pace mode, usage far ahead of pace -> external', () => {
  const resetsAt = NOW + 6 * 86400; // ~14.3% elapsed
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshot({ wk: 30, resetsAt }) });
  assert.equal(result.route, 'external');
  assert.match(result.reason, /vs .*elapsed/);
});

test('decide: pace mode, five_hour cap forces external even if wk pace is fine', () => {
  const resetsAt = NOW + 6 * 86400;
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshot({ wk: 10, fh: 85, resetsAt }) });
  assert.equal(result.route, 'external');
  assert.match(result.reason, /5h/);
});

test('decide: pace mode, hard cap forces external regardless of pace', () => {
  const resetsAt = NOW + 1000; // almost fully elapsed, pace would say "fine" at hardCap%
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshot({ wk: 70, resetsAt }) });
  assert.equal(result.route, 'external');
  assert.match(result.reason, /hard cap/);
});

test('decide: pace mode falls back to fixed when resets_at missing', () => {
  const config = { ...DEFAULTS, threshold: 25 };
  const result = decide({ config, now: NOW, snapshot: snapshot({ wk: 30, resetsAt: undefined }) });
  assert.equal(result.route, 'external');
  assert.match(result.reason, /fixed threshold/);
});

test('decide: externalAvailable false downgrades external -> claude', () => {
  const resetsAt = NOW + 6 * 86400;
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshot({ wk: 30, resetsAt }), externalAvailable: false });
  assert.equal(result.route, 'claude');
  assert.match(result.reason, /exhausted/);
});

test('decide: externalAvailable undefined does not affect an external route', () => {
  const resetsAt = NOW + 6 * 86400;
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshot({ wk: 30, resetsAt }) });
  assert.equal(result.route, 'external');
});

test('formatRouteCheck: renders a human line with reason and next vendor', () => {
  const line = formatRouteCheck({ route: 'external', claudeWk: 30, fiveHour: 12, elapsedPct: 14.3, reason: 'wk 30% used vs 14.3% of week elapsed (+10 slack)', nextVendor: 'codex' });
  assert.match(line, /^route=external/);
  assert.match(line, /wk 30%/);
  assert.match(line, /next=codex/);
});

test('formatRouteCheck: unknown values render as ?', () => {
  const line = formatRouteCheck({ route: 'unknown', claudeWk: null, fiveHour: null, elapsedPct: null, reason: 'no snapshot', nextVendor: null });
  assert.doesNotMatch(line, /next=/);
  assert.match(line, /wk \? used/);
});

// --- 5-hour pace rule ---

function snapshotWith5h({ ts = NOW, wk = 10, wkResetsAt = NOW + 6 * 86400, fh, fhResetsAt } = {}) {
  return {
    ts,
    seven_day: { used_percentage: wk, resets_at: wkResetsAt },
    five_hour: { used_percentage: fh, resets_at: fhResetsAt }
  };
}

test('decide: 5h pace — 60% used at 1h into the 5h window -> external', () => {
  const fhResetsAt = NOW + 4 * 3600; // 1h elapsed of 5h window
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshotWith5h({ fh: 60, fhResetsAt }) });
  assert.equal(result.route, 'external');
  assert.match(result.reason, /5h 60% used vs 20% of window elapsed \(\+15 slack\)/);
});

test('decide: 5h pace — 60% used at 4h into the 5h window -> claude (weekly within pace)', () => {
  const fhResetsAt = NOW + 1 * 3600; // 4h elapsed of 5h window
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshotWith5h({ fh: 60, fhResetsAt }) });
  assert.equal(result.route, 'claude');
});

test('decide: 5h pace rule skipped entirely when five_hour.resets_at is missing', () => {
  const result = decide({ config: DEFAULTS, now: NOW, snapshot: snapshotWith5h({ fh: 99, fhResetsAt: undefined }) });
  // fiveHourCap (80) still catches it independently of the pace rule
  assert.equal(result.route, 'external');
  assert.match(result.reason, /5h cap/);
});

test('decide: slack5h is configurable', () => {
  const fhResetsAt = NOW + 4 * 3600; // 1h elapsed -> 20% elapsed
  const config = { ...DEFAULTS, slack5h: 50 };
  const result = decide({ config, now: NOW, snapshot: snapshotWith5h({ fh: 60, fhResetsAt }) });
  assert.equal(result.route, 'claude'); // 60 <= 20+50
});

// --- H3: routeCheck()/pick() row caching (<console cache dir>/rows.json) ---

async function withConsoleDir(dir, fn) {
  const old = process.env.DELEGATE_CONSOLE_DIR;
  process.env.DELEGATE_CONSOLE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (old == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old;
  }
}

test('routeCheck: a fresh rows.json cache is used and probeRows is never called (H3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-rowscache-'));
  const cachedVendorRows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify({ ts: Date.now(), rows: cachedVendorRows }));
  await withConsoleDir(dir, async () => {
    let calls = 0;
    const probeRows = async () => { calls++; return []; };
    const resetsAt = NOW + 6 * 86400;
    const result = await routeCheck({
      home: dir, config: DEFAULTS, now: NOW, snapshot: snapshot({ wk: 30, resetsAt }), probeRows
    });
    assert.equal(calls, 0, 'probeRows must not be called when the cache is fresh');
    assert.equal(result.nextVendor, 'agy', 'the cached rows (not an empty probe result) must have been used');
  });
});

test('routeCheck: a stale rows.json cache triggers one probe and rewrites the cache (H3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-rowscache-'));
  const staleTs = Date.now() - 20 * 60 * 1000; // 20m old > default 10m rowsTtlMinutes
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify({ ts: staleTs, rows: [['agy', 'gemini wk 0%', '?']] }));
  await withConsoleDir(dir, async () => {
    let calls = 0;
    const freshRows = [['codex', 'wk 40% (reset 3h) · 5h 20%', '?']];
    const probeRows = async () => { calls++; return freshRows; };
    const resetsAt = NOW + 6 * 86400;
    const result = await routeCheck({
      home: dir, config: { ...DEFAULTS, priority: ['codex', 'claude'] }, now: NOW,
      snapshot: snapshot({ wk: 30, resetsAt }), probeRows
    });
    assert.equal(calls, 1, 'a stale cache must trigger exactly one fresh probe');
    assert.equal(result.nextVendor, 'codex');
    const cacheAfter = JSON.parse(fs.readFileSync(path.join(dir, 'rows.json'), 'utf8'));
    assert.deepEqual(cacheAfter.rows, freshRows);
    assert.ok(cacheAfter.ts > staleTs);
  });
});

test('routeCheck: --probe forces a fresh probe even with a fresh cache present (H3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-rowscache-'));
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify({ ts: Date.now(), rows: [['agy', 'gemini wk 0%', '?']] }));
  await withConsoleDir(dir, async () => {
    let calls = 0;
    const freshRows = [['codex', 'wk 40% (reset 3h) · 5h 20%', '?']];
    const probeRows = async () => { calls++; return freshRows; };
    const resetsAt = NOW + 6 * 86400;
    const result = await routeCheck({
      home: dir, config: { ...DEFAULTS, priority: ['codex', 'claude'] }, now: NOW,
      snapshot: snapshot({ wk: 30, resetsAt }), probeRows, probe: true
    });
    assert.equal(calls, 1, '--probe must force a fresh probe regardless of cache freshness');
    assert.equal(result.nextVendor, 'codex');
  });
});

// N5: a rows.json cache that's corrupt (not valid JSON) or wrong-shape (parses but `rows`
// isn't an array) must never throw out of routeCheck — it must fall back to a fresh probe, same
// as a missing/stale cache.
test('routeCheck: corrupt rows.json ("not json{{{") falls back to probing without throwing (N5)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-rowscache-'));
  fs.writeFileSync(path.join(dir, 'rows.json'), 'not json{{{');
  await withConsoleDir(dir, async () => {
    let calls = 0;
    const freshRows = [['codex', 'wk 40% (reset 3h) · 5h 20%', '?']];
    const probeRows = async () => { calls++; return freshRows; };
    const resetsAt = NOW + 6 * 86400;
    const result = await routeCheck({
      home: dir, config: { ...DEFAULTS, priority: ['codex', 'claude'] }, now: NOW,
      snapshot: snapshot({ wk: 30, resetsAt }), probeRows
    });
    assert.equal(calls, 1, 'corrupt cache must trigger exactly one fresh probe');
    assert.equal(result.nextVendor, 'codex');
  });
});

test('routeCheck: wrong-shape rows.json ({"ts":123,"rows":"x"}) falls back to probing without throwing (N5)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-rowscache-'));
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify({ ts: 123, rows: 'x' }));
  await withConsoleDir(dir, async () => {
    let calls = 0;
    const freshRows = [['codex', 'wk 40% (reset 3h) · 5h 20%', '?']];
    const probeRows = async () => { calls++; return freshRows; };
    const resetsAt = NOW + 6 * 86400;
    const result = await routeCheck({
      home: dir, config: { ...DEFAULTS, priority: ['codex', 'claude'] }, now: NOW,
      snapshot: snapshot({ wk: 30, resetsAt }), probeRows
    });
    assert.equal(calls, 1, 'wrong-shape cache must trigger exactly one fresh probe');
    assert.equal(result.nextVendor, 'codex');
  });
});

// --- pick() ---

const { pick, formatPick } = require('../lib/policy');

test('pick: route claude when policy says stay on claude', async () => {
  const resetsAt = NOW + 6 * 86400;
  const result = await pick({ now: NOW, config: DEFAULTS, snapshot: snapshot({ wk: 10, resetsAt }), externalAvailable: undefined, rows: [] });
  assert.equal(result.route, 'claude');
  assert.match(result.suggest, /Claude subagent/);
});

test('pick: route unknown when snapshot missing', async () => {
  const result = await pick({ now: NOW, config: DEFAULTS, snapshot: null, rows: [] });
  assert.equal(result.route, 'unknown');
  assert.match(result.suggest, /Claude subagent/);
});

test('pick: route external picks vendor+tier via DEFAULT_TIER', async () => {
  const resetsAt = NOW + 6 * 86400;
  const rows = [['agy', 'gemini wk 45% · claude/gpt wk 10%', '?']];
  const result = await pick({
    now: NOW, config: DEFAULTS, snapshot: snapshot({ wk: 30, resetsAt }), rows
  });
  assert.equal(result.route, 'external');
  assert.equal(result.vendor, 'agy');
  assert.equal(result.tier, 'flash');
  assert.equal(result.critical, false);
  assert.match(result.command, /agent-delegates run agy flash BRIEF\.md --cd <dir>$/);
});

test('pick: critical work uses CRITICAL_TIER and skips vendors with no large tier', async () => {
  const resetsAt = NOW + 6 * 86400;
  const rows = [
    ['agy', 'gemini wk 45% · claude/gpt wk 10%', '?'],
    ['cursor', 'logged in · no quota API', '?']
  ];
  const result = await pick({
    now: NOW, config: { ...DEFAULTS, priority: ['cursor', 'agy', 'codex', 'grok', 'opencode', 'claude'] },
    snapshot: snapshot({ wk: 30, resetsAt }), rows, critical: true
  });
  assert.equal(result.route, 'external');
  assert.equal(result.vendor, 'agy'); // cursor skipped: CRITICAL_TIER.cursor is null
  assert.equal(result.tier, 'opus');
  assert.equal(result.critical, true);
  assert.match(result.command, /--critical$/);
});

test('pick: routeCheck itself downgrades to claude when literally no vendor has quota (non-critical)', async () => {
  // pick()'s "none" outcome is reachable when a non-large-tier vendor has quota but critical
  // filtering rules it out (see next test) — when NOTHING at all has quota, routeCheck's own
  // externalAvailable check already downgrades external -> claude before pick() runs its
  // critical filter, so this case surfaces as route "claude", not "none".
  const resetsAt = NOW + 6 * 86400;
  const rows = [['agy', 'gemini wk 0% · claude/gpt wk 0%', '?']];
  const result = await pick({ now: NOW, config: DEFAULTS, snapshot: snapshot({ wk: 30, resetsAt }), rows });
  assert.equal(result.route, 'claude');
  assert.match(result.suggest, /Claude subagent/);
});

test('pick: critical work with only small-tier vendors usable -> route none', async () => {
  const resetsAt = NOW + 6 * 86400;
  const rows = [['cursor', 'logged in · no quota API', '?']];
  const result = await pick({
    now: NOW, config: { ...DEFAULTS, priority: ['cursor', 'claude'] },
    snapshot: snapshot({ wk: 30, resetsAt }), rows, critical: true
  });
  assert.equal(result.route, 'none');
});

test('formatPick: external result renders vendor/tier/command', () => {
  const line = formatPick({ route: 'external', vendor: 'codex', tier: 'sol', critical: true, reason: 'wk 60% used', command: 'agent-delegates run codex sol BRIEF.md --cd <dir> --critical' });
  assert.match(line, /vendor=codex tier=sol/);
  assert.match(line, /--critical/);
});

test('formatPick: claude/unknown/none result renders suggest', () => {
  const line = formatPick({ route: 'none', reason: 'x', suggest: 'Claude subagent via the Agent tool (e.g. a Sonnet worker; Opus for review)' });
  assert.match(line, /route=none/);
  assert.match(line, /suggest: Claude subagent/);
});

// --- NIT: 1-decimal rounding of claudeWk/fiveHour/elapsedPct in output and reasons ---

test('decide: claudeWk, fiveHour, elapsedPct are rounded to 1 decimal in the returned object', () => {
  const resetsAt = NOW + Math.round(6.37 * 86400); // produces a non-round elapsedPct
  const result = decide({
    config: DEFAULTS, now: NOW,
    snapshot: { ts: NOW, seven_day: { used_percentage: 30.4444, resets_at: resetsAt }, five_hour: { used_percentage: 12.666 } }
  });
  assert.equal(result.claudeWk, 30.4);
  assert.equal(result.fiveHour, 12.7);
  assert.equal(Math.round(result.elapsedPct * 10) / 10, result.elapsedPct); // already 1-decimal
});

test('decide: reason text uses the rounded values, not full-precision ones', () => {
  const resetsAt = NOW + 6 * 86400;
  const result = decide({
    config: DEFAULTS, now: NOW,
    snapshot: { ts: NOW, seven_day: { used_percentage: 30.4444, resets_at: resetsAt }, five_hour: { used_percentage: 5 } }
  });
  assert.equal(result.route, 'external');
  assert.match(result.reason, /wk 30\.4% used/);
  assert.doesNotMatch(result.reason, /30\.4444/);
});

test('SUGGEST_CLAUDE wording is generic (no private agent-type names)', () => {
  const result1 = require('../lib/policy');
  // exercised indirectly via pick()'s suggest field, already covered above; this just guards the
  // exact wording contract (no "sonnet5-worker"/"opus5-reviewer" style internal names).
  return result1.pick({ now: NOW, config: DEFAULTS, snapshot: null, rows: [] }).then(result => {
    assert.doesNotMatch(result.suggest, /sonnet5-worker|opus5-reviewer/);
    assert.match(result.suggest, /Agent tool/);
  });
});
