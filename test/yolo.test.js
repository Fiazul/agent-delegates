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
const { CRITICAL_TIER, TIER_MAPS, rawSlugClass, tierClass, yoloCheck } = require('../lib/models');

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
  assert.match(args('opencode'), /--auto/);
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
  await assert.rejects(() => invoke('run', 'opencode', 'free', briefFile, { ...opts, critical: true, allowSmall: true }), /never runs on OpenCode free models/);
  await assert.rejects(() => invoke('run', 'opencode', 'opencode/mimo-v2.6-flash-free', briefFile, { ...opts, critical: true, allowSmall: true }), /never runs on OpenCode free models/);
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
  const result = await pick({ critical: true, rows: [['opencode', 'logged in · no quota API', '?']], externalAvailable: true, priority: 'opencode', config: { priority: ['opencode'] }, home: path.join(dir, 'home') }).catch(() => null);
  if (result && result.route === 'external') assert.equal(result.tier, 'glm');
}));

test('raw slug classes: any -free is small; opencode-go glm/kimi large; other unknown standard; flash glm standard', () => {
  assert.equal(tierClass('opencode', 'opencode/nemotron-3-ultra-free'), 'small');
  assert.equal(tierClass('opencode', 'opencode-go/step-5-preview-free'), 'small');
  assert.equal(tierClass('opencode', 'opencode-go/glm-5.2'), 'large');
  assert.equal(tierClass('opencode', 'opencode-go/kimi-k2.7-code'), 'large');
  assert.equal(tierClass('opencode', 'opencode/some-paid-model'), 'standard');
  assert.equal(tierClass('opencode', 'opencode-go/glm-5.3-flash'), 'standard');
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
