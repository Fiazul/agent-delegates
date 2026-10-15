'use strict';

// Full-access (--yolo) gate: frontier tiers only (codex sol-high / sol+effort high / astra, claude opus,
// opencode glm / kimi), on run, resume, handoff and run auto. Uses fake vendor binaries that record
// the REAL spawned args. Also: ELEVATED line + meta.json, opencode free never critical, raw-slug classes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { invoke } = require('../lib/runner');
const { enforce, permissionMode } = require('../lib/guard');
const { CRITICAL_TIER, OPENCODE_LARGE_MODELS, TIER_CLASS, TIER_MAPS, rawSlugClass, tierClass, yoloCheck } = require('../lib/models');

process.env.DELEGATE_QUIET = '1';

function withFakes(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-yolo-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const argsFile = vendor => path.join(dir, `${vendor}-args.txt`);
    const outputs = {
      codex: '{"type":"turn.completed","thread_id":"thread-1","usage":{}}',
      claude: '{"type":"result","result":"OK","session_id":"sess-1","usage":{}}',
      opencode: '{"type":"text","sessionID":"oc-1","part":{"id":"p1","text":"OK"}}'
    };
    for (const vendor of Object.keys(outputs)) {
      const file = path.join(bin, vendor);
      fs.writeFileSync(file, `#!/bin/bash\necho "$@" > "${argsFile(vendor)}"\necho '${outputs[vendor]}'\nexit 0\n`);
      fs.chmodSync(file, 0o755);
    }
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(cwd);
    const briefFile = path.join(dir, 'brief.md');
    fs.writeFileSync(briefFile, 'reply OK\n');
    const scratchHome = path.join(dir, 'home');
    fs.mkdirSync(scratchHome);
    const outRoot = path.join(dir, 'out');
    const env = { HOME: scratchHome, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DELEGATE_NO_WINDOW: '1', DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'), DELEGATE_OUT: outRoot };
    const saved = {};
    for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...a) => logs.push(a.join(' '));
    console.error = () => {};
    try {
      await fn({
        dir, cwd, briefFile, outRoot, logs,
        opts: { cd: cwd, noPreflight: true, guardConfig: { keywords: [], paths: [] } },
        spawned: vendor => fs.existsSync(argsFile(vendor)),
        args: vendor => fs.readFileSync(argsFile(vendor), 'utf8'),
        reset: () => { for (const v of Object.keys(outputs)) try { fs.unlinkSync(argsFile(v)); } catch {} logs.length = 0; },
        lastMeta: () => {
          const names = fs.readdirSync(outRoot).sort();
          return JSON.parse(fs.readFileSync(path.join(outRoot, names.at(-1), 'meta.json'), 'utf8'));
        }
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
      for (const key of Object.keys(saved)) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; }
    }
  };
}

const refusal = /--yolo \(full access\) refused for/;

test('yolo refused on ineligible tiers: codex sol/sol-low/sol-high+low-effort/raw slug, claude sonnet, opencode free/raw-free/unknown (no spawn)', withFakes(async ({ briefFile, opts, spawned, reset }) => {
  const cases = [
    ['codex', 'sol', {}], ['codex', 'sol-low', {}], ['codex', 'sol', { effort: 'medium' }], ['codex', 'sol-high', { effort: 'low' }],
    ['codex', 'gpt-6.1-sol', {}], ['claude', 'sonnet', {}], ['claude', 'claude-sonnet-5-5', {}],
    ['opencode', 'free', {}], ['opencode', 'opencode/nemotron-3-ultra-free', {}], ['opencode', 'opencode/some-unknown-model', {}]
  ];
  for (const [vendor, tier, extra] of cases) {
    reset();
    await assert.rejects(() => invoke('run', vendor, tier, briefFile, { ...opts, ...extra, yolo: true }), refusal, `${vendor} ${tier}`);
    assert.equal(spawned(vendor), false, `${vendor} ${tier} must not spawn`);
  }
}));

test('the refusal message names the eligible tiers', withFakes(async ({ briefFile, opts }) => {
  await assert.rejects(() => invoke('run', 'codex', 'sol', briefFile, { ...opts, yolo: true }),
    /codex sol-high \| sol --effort high \| astra; claude opus; opencode glm \| kimi/);
}));

test('yolo refused on resume (recorded/default tier ineligible; explicit --tier sol-low) and handoff and run auto', withFakes(async ({ dir, briefFile, opts, cwd, spawned, reset, logs }) => {
  // resume: no recorded model -> policy default sol (standard) -> refused
  await assert.rejects(() => invoke('resume', 'codex', 'thread-x', briefFile, { ...opts, yolo: true }), refusal);
  await assert.rejects(() => invoke('resume', 'codex', 'thread-x', briefFile, { ...opts, yolo: true, tier: 'sol-low' }), refusal);
  await assert.rejects(() => invoke('resume', 'claude', 'sess-x', briefFile, { ...opts, yolo: true, tier: 'sonnet' }), refusal);
  await assert.rejects(() => invoke('resume', 'opencode', 'oc-x', briefFile, { ...opts, yolo: true, tier: 'free' }), refusal);
  assert.equal(spawned('codex') || spawned('claude') || spawned('opencode'), false);

  // handoff: default tier of the target (codex sol / claude sonnet / opencode free) is ineligible
  const { handoff } = require('../lib/handoff');
  const jobDir = path.join(dir, 'prior');
  fs.mkdirSync(jobDir);
  fs.writeFileSync(path.join(jobDir, 'brief.md'), 'orig\n');
  fs.writeFileSync(path.join(jobDir, 'last.md'), 'WORKER FAILED: quota\n');
  fs.writeFileSync(path.join(jobDir, 'exit'), '1');
  fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify({ vendor: 'agy', model: 'gemini-3.8-flash-high', cwd }));
  for (const target of ['codex', 'claude', 'opencode']) {
    await assert.rejects(() => handoff(jobDir, target, undefined, { ...opts, yolo: true }), refusal, target);
  }
  assert.equal(spawned('codex') || spawned('claude') || spawned('opencode'), false);

  // run auto: every candidate's default tier is ineligible -> each skipped with an AUTO line, nothing spawns
  const { runAuto } = require('../lib/route');
  reset();
  const rows = [['codex', 'wk 40% · 5h 20%', '?'], ['opencode', 'logged in · no quota API', '?'], ['claude', 'wk 40% · 5h 20%', '?']];
  await assert.rejects(() => runAuto(briefFile, { ...opts, rows, priority: 'codex,opencode,claude', yolo: true, respectPolicy: false, home: path.join(dir, 'home') }, ''), /no vendor with quota and an eligible full-access tier/);
  for (const v of ['codex', 'opencode', 'claude']) assert.ok(logs.some(l => l.startsWith(`AUTO: ${v} skipped — --yolo (full access) refused`)), `${v}: ${JSON.stringify(logs)}`);
  assert.equal(spawned('codex') || spawned('claude') || spawned('opencode'), false);
}));

test('run auto --yolo --critical routes opencode to its critical tier glm and runs it elevated', withFakes(async ({ dir, briefFile, opts, args, logs }) => {
  const { runAuto } = require('../lib/route');
  const rows = [['opencode', 'logged in · no quota API', '?']];
  await runAuto(briefFile, { ...opts, rows, priority: 'opencode', yolo: true, critical: true, respectPolicy: false, home: path.join(dir, 'home') }, '');
  assert.match(args('opencode'), /(^| )-m opencode-go\/glm-5\.3( |$)/);
  assert.match(args('opencode'), /--auto/);
  assert.ok(logs.some(l => l.startsWith('ELEVATED: vendor=opencode tier=glm')), JSON.stringify(logs));
}));

test('yolo allowed + real spawned args: codex sol-high, sol --effort high, astra (--critical) -> -s danger-full-access', withFakes(async ({ briefFile, opts, args, reset, logs, lastMeta }) => {
  for (const [tier, extra] of [['sol-high', {}], ['sol', { effort: 'high' }], ['astra', { critical: true }]]) {
    reset();
    await invoke('run', 'codex', tier, briefFile, { ...opts, ...extra, yolo: true });
    const a = args('codex');
    assert.match(a, /(^| )-s danger-full-access( |$)/, `${tier}: ${a}`);
    assert.doesNotMatch(a, /workspace-write|read-only|dangerously-bypass/);
    assert.match(a, /model_reasoning_effort=high/);
    assert.ok(logs.some(l => /^ELEVATED: vendor=codex tier=\S+ model=gpt-6/.test(l) && /effort=high/.test(l) && /danger-full-access/.test(l)), JSON.stringify(logs));
    assert.ok(logs.some(l => l.startsWith('PERMISSIONS: FULL ACCESS')), JSON.stringify(logs));
    assert.equal(lastMeta().elevated, true);
  }
}));

test('yolo allowed: claude opus -> --dangerously-skip-permissions; opencode glm and kimi -> --auto', withFakes(async ({ briefFile, opts, args, reset, logs, lastMeta }) => {
  await invoke('run', 'claude', 'opus', briefFile, { ...opts, yolo: true });
  assert.match(args('claude'), /--dangerously-skip-permissions/);
  assert.doesNotMatch(args('claude'), /acceptEdits/);
  assert.ok(logs.some(l => /^ELEVATED: vendor=claude tier=opus model=claude-opus-5-5 .*--dangerously-skip-permissions/.test(l)), JSON.stringify(logs));
  assert.equal(lastMeta().elevated, true);
  for (const tier of ['glm', 'kimi']) {
    reset();
    await invoke('run', 'opencode', tier, briefFile, { ...opts, yolo: true });
    assert.match(args('opencode'), new RegExp(`-m ${TIER_MAPS.opencode[tier].replace(/[.]/g, '\\.')}`));
    assert.match(args('opencode'), /--auto/);
    assert.ok(logs.some(l => new RegExp(`^ELEVATED: vendor=opencode tier=${tier} model=${TIER_MAPS.opencode[tier]} effort=default mode=--auto`).test(l)), JSON.stringify(logs));
    assert.equal(lastMeta().elevated, true);
  }
  // raw frontier opencode slug is large too
  reset();
  await invoke('run', 'opencode', 'opencode-go/kimi-k2.7-code', briefFile, { ...opts, yolo: true });
  assert.match(args('opencode'), /-m opencode-go\/kimi-k2\.7-code/);
  assert.match(args('opencode'), /--auto/);
  assert.ok(logs.some(l => /^ELEVATED: vendor=opencode tier=\S+ model=opencode-go\/kimi-k2\.7-code effort=default mode=--auto$/.test(l)), JSON.stringify(logs));
  const meta = lastMeta();
  assert.equal(meta.elevated, true);
  assert.equal(meta.model, 'opencode-go/kimi-k2.7-code');
  assert.equal(meta.tierClass, 'large');
}));

test('resume with yolo on a frontier tier: codex sol-high pins sandbox_mode=danger-full-access (also under --full)', withFakes(async ({ briefFile, opts, args, reset, logs }) => {
  await invoke('resume', 'codex', 'thread-1', briefFile, { ...opts, yolo: true, tier: 'sol-high' });
  assert.match(args('codex'), /-c sandbox_mode=danger-full-access/);
  assert.ok(logs.some(l => l.startsWith('ELEVATED: vendor=codex')), JSON.stringify(logs));
  reset();
  await invoke('resume', 'codex', 'thread-1', briefFile, { ...opts, yolo: true, tier: 'sol-high', full: true });
  assert.match(args('codex'), /-c sandbox_mode=danger-full-access/);
  reset();
  await invoke('resume', 'claude', 'sess-1', briefFile, { ...opts, yolo: true, tier: 'opus' });
  assert.match(args('claude'), /--dangerously-skip-permissions/);
}));

test('non-yolo runs are unchanged: no ELEVATED line, elevated=false in meta, codex stays workspace-write', withFakes(async ({ briefFile, opts, args, logs, lastMeta }) => {
  await invoke('run', 'codex', 'sol', briefFile, { ...opts });
  assert.match(args('codex'), /-s workspace-write/);
  assert.equal(logs.some(l => l.startsWith('ELEVATED:')), false);
  assert.equal(lastMeta().elevated, false);
}));

test('codex --yolo with --ro is refused (contradiction)', withFakes(async ({ briefFile, opts, spawned }) => {
  await assert.rejects(() => invoke('run', 'codex', 'sol-high', briefFile, { ...opts, yolo: true, ro: true }), /--yolo .* and --ro .* contradict/);
  assert.equal(spawned('codex'), false);
}));

test('agy/grok/cursor yolo behaviour is not gated (unchanged)', () => {
  for (const [vendor, tier, model] of [['grok', 'fast', 'grok-4.5'], ['cursor', 'auto', 'auto'], ['agy', 'lite', 'gemini-3.8-flash-low']]) {
    assert.deepEqual(yoloCheck(vendor, tier, model, ''), { ok: true, reason: '' });
    const verdict = enforce({ vendor, tier, model, critical: false, options: { yolo: true }, mode: 'run' });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.elevated, false);
  }
});

test('enforce: yolo eligibility + permissionMode text per vendor', () => {
  assert.equal(permissionMode('codex', { yolo: true }), 'FULL ACCESS (sandbox danger-full-access via --yolo)');
  assert.equal(enforce({ vendor: 'codex', tier: 'sol-high', model: 'gpt-6.1-sol', effort: 'high', options: { yolo: true }, mode: 'run' }).elevated, true);
  assert.equal(enforce({ vendor: 'codex', tier: 'sol', model: 'gpt-6.1-sol', effort: 'low', options: { yolo: true }, mode: 'run' }).ok, false);
  assert.equal(enforce({ vendor: 'claude', tier: 'opus', model: 'claude-opus-5-5', options: { yolo: true }, mode: 'run' }).elevated, true);
  assert.equal(enforce({ vendor: 'claude', tier: 'sonnet', model: 'claude-sonnet-5-5', options: { yolo: true }, mode: 'run' }).ok, false);
});

test('opencode free + --critical is refused even with --allow-small (run); glm/kimi critical fine', withFakes(async ({ briefFile, opts, spawned, reset }) => {
  await assert.rejects(() => invoke('run', 'opencode', 'free', briefFile, { ...opts, critical: true }), /CRITICAL WORK/);
  await assert.rejects(() => invoke('run', 'opencode', 'free', briefFile, { ...opts, critical: true, allowSmall: true }), /--allow-small does not override this/);
  await assert.rejects(() => invoke('run', 'opencode', 'opencode/mimo-v2.6-flash-free', briefFile, { ...opts, critical: true, allowSmall: true }), /--allow-small does not override this/);
  assert.equal(spawned('opencode'), false);
  await invoke('run', 'opencode', 'glm', briefFile, { ...opts, critical: true });
  assert.equal(spawned('opencode'), true);
}));

test('opencode critical run auto and handoff pick glm (never free)', withFakes(async ({ dir, briefFile, opts, cwd, args, reset }) => {
  assert.equal(CRITICAL_TIER.opencode, 'glm');
  const { runAuto } = require('../lib/route');
  await runAuto(briefFile, { ...opts, rows: [['opencode', 'logged in · no quota API', '?']], priority: 'opencode', critical: true, respectPolicy: false, home: path.join(dir, 'home') }, '');
  assert.match(args('opencode'), /-m opencode-go\/glm-5\.3/);
  reset();
  const { handoff } = require('../lib/handoff');
  const jobDir = path.join(dir, 'prior');
  fs.mkdirSync(jobDir);
  fs.writeFileSync(path.join(jobDir, 'brief.md'), 'orig\n');
  fs.writeFileSync(path.join(jobDir, 'last.md'), 'WORKER FAILED: quota\n');
  fs.writeFileSync(path.join(jobDir, 'exit'), '1');
  fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify({ vendor: 'agy', model: 'gemini-3.8-flash-high', cwd, critical: true }));
  await handoff(jobDir, 'opencode', undefined, { ...opts });
  assert.match(args('opencode'), /-m opencode-go\/glm-5\.3/);
  const { pick } = require('../lib/policy');
  // F12: no .catch / conditional -- pick must route external to opencode glm, or this test fails.
  const NOW = 1789627000;
  const result = await pick({
    critical: true, now: NOW, rows: [['opencode', 'logged in · no quota API', '?']], priority: 'opencode',
    config: { ...require('../lib/policy').DEFAULTS, priority: ['opencode'] },
    snapshot: { ts: NOW, seven_day: { used_percentage: 30, resets_at: NOW + 6 * 86400 }, five_hour: { used_percentage: 12 } },
    home: path.join(dir, 'home')
  });
  assert.equal(result.route, 'external', JSON.stringify(result));
  assert.equal(result.vendor, 'opencode');
  assert.equal(result.tier, 'glm');
}));

test('raw slug classes: any -free is small; ONLY allowlisted opencode-go slugs are large; everything else standard (F6)', () => {
  assert.equal(tierClass('opencode', 'opencode/nemotron-3-ultra-free'), 'small');
  assert.equal(tierClass('opencode', 'opencode-go/step-5-preview-free'), 'small');
  assert.equal(tierClass('opencode', 'opencode-go/glm-5.2'), 'large');
  assert.equal(tierClass('opencode', 'opencode-go/kimi-k2.7-code'), 'large');
  assert.equal(tierClass('opencode', 'opencode/some-paid-model'), 'standard');
  assert.equal(tierClass('opencode', 'opencode-go/glm-5.3-flash'), 'standard');
  // family-name look-alikes that are NOT on the allowlist stay standard (no yolo, no critical)
  for (const slug of ['opencode-go/glm-9', 'opencode-go/kimi-k4', 'opencode-go/glm-5.3-air', 'opencode-go/kimi-k3-mini', 'opencode-go/qwen3.8-max', 'opencode-go/deepseek-v4-pro']) {
    assert.equal(tierClass('opencode', slug), 'standard', slug);
    assert.equal(yoloCheck('opencode', slug, slug, '').ok, false, slug);
  }
  for (const slug of OPENCODE_LARGE_MODELS) assert.equal(tierClass('opencode', slug), 'large', slug);
  assert.deepEqual([...OPENCODE_LARGE_MODELS].sort(), ['opencode-go/glm-5.2', 'opencode-go/glm-5.3', 'opencode-go/kimi-k2.7-code', 'opencode-go/kimi-k3']);
  // every large tier maps to an allowlisted slug
  for (const [tier, cls] of Object.entries(TIER_CLASS.opencode)) if (cls === 'large') assert.ok(OPENCODE_LARGE_MODELS.includes(TIER_MAPS.opencode[tier]), tier);
  assert.equal(rawSlugClass('codex', 'whatever/x'), 'unknown');
});

test('stale opencode slug mimo-v2.5-free and the old `go` tier are gone', () => {
  assert.equal(Object.values(TIER_MAPS.opencode).some(m => /mimo-v2\.5/.test(m)), false);
  assert.equal('go' in TIER_MAPS.opencode, false);
  assert.equal(TIER_MAPS.opencode.free, 'opencode/mimo-v2.6-flash-free');
  const { DEFAULT_TIER } = require('../lib/models');
  assert.equal(DEFAULT_TIER.opencode, 'free');
  for (const file of ['lib/models.js', 'lib/status.js', 'skills/delegate-opencode/SKILL.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /mimo-v2\.5/, file);
  }
});


// ---- resume of RECORDED threads, astra, --full, handoff, run auto effort, opencode no-record ----

// Writes a prior job dir for `vendor` thread `id` the way invoke() records it (meta.json + id file).
const ID_FILE = { codex: 'thread_id', claude: 'session_id', opencode: 'session_id' };
function record(outRoot, vendor, id, meta) {
  const dir = path.join(outRoot, `0rec-${vendor}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ID_FILE[vendor]), id);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ vendor, startedAt: '2026-10-15T00:00:00.000Z', ...meta }));
}

test('resume --yolo of a RECORDED thread: allowed only when the recorded model/effort is frontier (codex, claude, opencode)', withFakes(async ({ outRoot, briefFile, opts, args, spawned, reset, logs, lastMeta }) => {
  // allowed: codex sol-high recorded (high effort), claude opus, opencode glm slug / allowlisted raw slug
  record(outRoot, 'codex', 'thr-high', { model: 'gpt-6.1-sol', tier: 'sol-high', effort: 'high' });
  await invoke('resume', 'codex', 'thr-high', briefFile, { ...opts, yolo: true });
  assert.match(args('codex'), /-c sandbox_mode=danger-full-access/);
  assert.match(args('codex'), /model_reasoning_effort=high/);
  assert.equal(lastMeta().elevated, true);
  record(outRoot, 'claude', 'sess-opus', { model: 'claude-opus-5-5', tier: 'opus' });
  reset();
  await invoke('resume', 'claude', 'sess-opus', briefFile, { ...opts, yolo: true });
  assert.match(args('claude'), /--dangerously-skip-permissions/);
  record(outRoot, 'opencode', 'oc-glm', { model: 'opencode-go/glm-5.3', tier: 'glm' });
  reset();
  await invoke('resume', 'opencode', 'oc-glm', briefFile, { ...opts, yolo: true });
  assert.match(args('opencode'), /--auto/);
  assert.match(args('opencode'), /-m opencode-go\/glm-5\.3/);
  record(outRoot, 'opencode', 'oc-raw', { model: 'opencode-go/kimi-k2.7-code', tier: '' });
  reset();
  await invoke('resume', 'opencode', 'oc-raw', briefFile, { ...opts, yolo: true });
  assert.match(args('opencode'), /--auto/);

  // refused: recorded ineligible models, nothing spawns
  record(outRoot, 'codex', 'thr-std', { model: 'gpt-6.1-sol', tier: 'sol', effort: 'medium' });
  record(outRoot, 'claude', 'sess-sonnet', { model: 'claude-sonnet-5-5', tier: 'sonnet' });
  record(outRoot, 'opencode', 'oc-free', { model: 'opencode/mimo-v2.6-flash-free', tier: 'free' });
  record(outRoot, 'opencode', 'oc-flash', { model: 'opencode-go/glm-5.3-flash', tier: '' });
  record(outRoot, 'opencode', 'oc-lookalike', { model: 'opencode-go/glm-9', tier: '' });
  for (const [vendor, id] of [['codex', 'thr-std'], ['claude', 'sess-sonnet'], ['opencode', 'oc-free'], ['opencode', 'oc-flash'], ['opencode', 'oc-lookalike']]) {
    reset();
    await assert.rejects(() => invoke('resume', vendor, id, briefFile, { ...opts, yolo: true }), refusal, `${vendor} ${id}`);
    assert.equal(spawned(vendor), false, `${vendor} ${id} must not spawn`);
  }
}));

test('F9: the ELEVATED mode= text shows the REAL flag per path (run -s, resume -c sandbox_mode=)', withFakes(async ({ briefFile, opts, reset, logs }) => {
  await invoke('run', 'codex', 'sol-high', briefFile, { ...opts, yolo: true });
  const runLine = logs.find(l => l.startsWith('ELEVATED: vendor=codex'));
  assert.match(runLine, /mode=-s danger-full-access$/, runLine);
  reset();
  await invoke('resume', 'codex', 'thread-1', briefFile, { ...opts, yolo: true, tier: 'sol-high' });
  const resumeLine = logs.find(l => l.startsWith('ELEVATED: vendor=codex'));
  assert.match(resumeLine, /mode=-c sandbox_mode=danger-full-access$/, resumeLine);
}));

test('F1: codex resume --full WITHOUT --yolo still pins sandbox_mode (never inherits user config); PERMISSIONS line matches', withFakes(async ({ outRoot, briefFile, opts, args, reset, logs }) => {
  record(outRoot, 'codex', 'thr-1', { model: 'gpt-6.1-sol', tier: 'sol', effort: 'medium' });
  await invoke('resume', 'codex', 'thr-1', briefFile, { ...opts, full: true });
  let a = args('codex');
  assert.match(a, /-c sandbox_mode=workspace-write/);
  assert.doesNotMatch(a, /--ignore-user-config/);
  assert.doesNotMatch(a, /danger-full-access/);
  assert.ok(logs.some(l => l === 'PERMISSIONS: sandbox workspace-write (no bypass)'), JSON.stringify(logs));
  assert.ok(logs.some(l => /sandbox=workspace-write/.test(l) && !/unpinned/.test(l)), JSON.stringify(logs));
  reset();
  await invoke('resume', 'codex', 'thr-1', briefFile, { ...opts, full: true, ro: true });
  a = args('codex');
  assert.match(a, /-c sandbox_mode=read-only/);
  assert.ok(logs.some(l => l === 'PERMISSIONS: sandbox read-only (no bypass)'), JSON.stringify(logs));
  // a non-full resume still pins it AND drops user config
  reset();
  await invoke('resume', 'codex', 'thr-1', briefFile, { ...opts });
  assert.match(args('codex'), /-c sandbox_mode=workspace-write.*--ignore-user-config/);
}));

test('F2: astra needs --critical on EVERY launch that elevates it, including resume of a recorded astra thread', withFakes(async ({ outRoot, briefFile, opts, args, spawned, reset, logs }) => {
  record(outRoot, 'codex', 'thr-astra', { model: 'gpt-6-astra', tier: 'astra', effort: 'high' });
  const astraRefusal = /codex astra \(gpt-6-astra\) is reserved for critical/;
  // elevated resume without --critical: refused, no spawn
  await assert.rejects(() => invoke('resume', 'codex', 'thr-astra', briefFile, { ...opts, yolo: true }), astraRefusal);
  assert.equal(spawned('codex'), false);
  // same resume with --critical: allowed and elevated
  await invoke('resume', 'codex', 'thr-astra', briefFile, { ...opts, yolo: true, critical: true });
  assert.match(args('codex'), /-c sandbox_mode=danger-full-access/);
  assert.match(args('codex'), /model=gpt-6-astra/);
  assert.ok(logs.some(l => l.startsWith('ELEVATED: vendor=codex tier=astra')), JSON.stringify(logs));
  // a PLAIN resume of the recorded astra thread (no --yolo) is still let through (thread already admitted)
  reset();
  await invoke('resume', 'codex', 'thr-astra', briefFile, { ...opts });
  assert.equal(spawned('codex'), true);
  assert.doesNotMatch(args('codex'), /danger-full-access/);
  // explicitly pinning astra on resume still needs --critical
  reset();
  await assert.rejects(() => invoke('resume', 'codex', 'thr-other', briefFile, { ...opts, tier: 'astra' }), astraRefusal);
  // fresh run: astra --yolo without --critical refused
  await assert.rejects(() => invoke('run', 'codex', 'astra', briefFile, { ...opts, yolo: true }), astraRefusal);
}));

test('F3/F4: opencode resume with NO recorded model: --yolo refused, --critical refused (even with --allow-small); a session id that equals a tier name is never read as a tier', withFakes(async ({ briefFile, opts, args, spawned, reset }) => {
  // session id literally named like a large tier: the old `tier: tierName || tierOrId` read it as 'glm' (large)
  for (const id of ['glm', 'kimi', 'oc-unknown']) {
    reset();
    await assert.rejects(() => invoke('resume', 'opencode', id, briefFile, { ...opts, yolo: true }), refusal, `yolo ${id}`);
    await assert.rejects(() => invoke('resume', 'opencode', id, briefFile, { ...opts, critical: true }), /CRITICAL WORK .*unrecognised\/unrecorded model; critical work on OpenCode requires a large model/, `critical ${id}`);
    await assert.rejects(() => invoke('resume', 'opencode', id, briefFile, { ...opts, critical: true, allowSmall: true }), /--allow-small does not override this/, `critical+allowSmall ${id}`);
    assert.equal(spawned('opencode'), false, `${id} must not spawn`);
  }
  // the same leak for claude/codex session ids named like a large tier: policy default (standard) applies
  for (const [vendor, id] of [['claude', 'opus'], ['codex', 'sol-high'], ['codex', 'astra']]) {
    await assert.rejects(() => invoke('resume', vendor, id, briefFile, { ...opts, yolo: true }), refusal, `${vendor} ${id}`);
    assert.equal(spawned(vendor), false);
  }
  // a plain, non-critical, non-yolo resume with no record is still allowed (no -m pinned: vendor default)
  reset();
  await invoke('resume', 'opencode', 'oc-unknown', briefFile, { ...opts });
  assert.equal(spawned('opencode'), true);
  assert.doesNotMatch(args('opencode'), / -m /);
  // pinning a large tier on resume satisfies critical
  reset();
  await invoke('resume', 'opencode', 'oc-unknown', briefFile, { ...opts, critical: true, tier: 'glm' });
  assert.match(args('opencode'), /-m opencode-go\/glm-5\.3/);
}));

test('positive elevated handoff: frontier tier + --yolo spawns elevated (codex sol-high, claude opus, opencode glm)', withFakes(async ({ dir, briefFile, opts, cwd, args, reset, logs, lastMeta }) => {
  const { handoff } = require('../lib/handoff');
  const jobDir = path.join(dir, 'prior');
  fs.mkdirSync(jobDir);
  fs.writeFileSync(path.join(jobDir, 'brief.md'), 'orig\n');
  fs.writeFileSync(path.join(jobDir, 'last.md'), 'WORKER FAILED: quota\n');
  fs.writeFileSync(path.join(jobDir, 'exit'), '1');
  fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify({ vendor: 'agy', model: 'gemini-3.8-flash-high', cwd }));
  for (const [target, tier, argRe, vendorLine] of [
    ['codex', 'sol-high', /-s danger-full-access/, 'codex'],
    ['claude', 'opus', /--dangerously-skip-permissions/, 'claude'],
    ['opencode', 'glm', /--auto/, 'opencode']
  ]) {
    reset();
    await handoff(jobDir, target, tier, { ...opts, yolo: true });
    assert.match(args(target), argRe, target);
    assert.ok(logs.some(l => l.startsWith(`ELEVATED: vendor=${vendorLine} tier=${tier}`)), JSON.stringify(logs));
    assert.equal(lastMeta().elevated, true);
  }
}));

test('run auto --yolo --effort high: codex (default tier sol) becomes eligible and is spawned elevated at high effort', withFakes(async ({ dir, briefFile, opts, args, logs, lastMeta }) => {
  const { runAuto } = require('../lib/route');
  const rows = [['codex', 'wk 40% · 5h 20%', '?']];
  const result = await runAuto(briefFile, { ...opts, rows, priority: 'codex', yolo: true, effort: 'high', respectPolicy: false, home: path.join(dir, 'home') }, '');
  assert.equal(result.vendor, 'codex');
  const a = args('codex');
  assert.match(a, /-s danger-full-access/);
  assert.match(a, /model_reasoning_effort=high/);
  assert.match(a, /-m gpt-6\.1-sol/);
  assert.ok(logs.some(l => /^ELEVATED: vendor=codex tier=sol model=gpt-6\.1-sol effort=high mode=-s danger-full-access$/.test(l)), JSON.stringify(logs));
  assert.equal(lastMeta().elevated, true);
}));

test('run auto --yolo without --effort: codex sol (medium) is skipped', withFakes(async ({ dir, briefFile, opts, spawned, logs }) => {
  const { runAuto } = require('../lib/route');
  await assert.rejects(() => runAuto(briefFile, { ...opts, rows: [['codex', 'wk 40% · 5h 20%', '?']], priority: 'codex', yolo: true, respectPolicy: false, home: path.join(dir, 'home') }, ''), /no vendor with quota and an eligible full-access tier/);
  assert.equal(spawned('codex'), false);
}));
