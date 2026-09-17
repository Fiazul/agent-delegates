'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildHandoffBrief, handoff, DEFAULT_TIER } = require('../lib/handoff');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'handoff-job');

function copyFixture(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(FIXTURE_DIR)) {
    fs.copyFileSync(path.join(FIXTURE_DIR, name), path.join(dest, name));
  }
}

test('buildHandoffBrief composes original brief, failure reason, and progress evidence', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-'));
  copyFixture(jobDir);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-cwd-'));

  const brief = buildHandoffBrief({ jobDir, cwd, targetVendor: 'codex' });

  assert.match(brief, /# Continuation brief \(handed off from agy · gemini-3\.8-flash-high to codex\)/);
  assert.match(brief, /## Original brief/);
  assert.match(brief, /Fix the flaky retry test in lib\/console\.js/);
  assert.match(brief, /## Why handed off/);
  assert.match(brief, /RESOURCE_EXHAUSTED \(code 429\): Individual quota reached\. Resets in 10h0m0s\./);
  assert.match(brief, /resets in 10h0m0s/);
  assert.match(brief, /## Progress evidence/);
  assert.match(brief, /tool steps observed: 2/);
  assert.match(brief, /git status --short/);
  assert.match(brief, /not a git repository/); // cwd is a plain tmp dir, not a repo
  assert.match(brief, /## Instructions/);
  assert.match(brief, /Do NOT redo work already done/);
});

test('buildHandoffBrief falls back to inferred vendor and required --cd when meta.json is missing', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-nometa-'));
  copyFixture(jobDir);
  fs.unlinkSync(path.join(jobDir, 'meta.json'));
  fs.writeFileSync(path.join(jobDir, 'conversation_id'), 'conv-123\n');

  assert.throws(() => buildHandoffBrief({ jobDir, targetVendor: 'codex' }), /cwd unknown/);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-nometa-cwd-'));
  const brief = buildHandoffBrief({ jobDir, cwd, targetVendor: 'codex' });
  assert.match(brief, /handed off from agy · unknown to codex/);
});

test('buildHandoffBrief truncates an oversized brief with a note and stays near the cap', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-big-'));
  copyFixture(jobDir);
  const huge = `WORKER FAILED: quota\n\n${'x'.repeat(20000)}`;
  fs.writeFileSync(path.join(jobDir, 'last.md'), huge);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-big-cwd-'));

  const brief = buildHandoffBrief({ jobDir, cwd, targetVendor: 'codex' });
  assert.ok(brief.length <= 12600, `expected capped brief, got ${brief.length} chars`);
  assert.match(brief, /truncated/);
  assert.match(brief, /## Instructions/); // Instructions block survives the global cap (F1)
});

test('buildHandoffBrief keeps Why-handed-off/Progress-evidence/Instructions when brief.md is huge (F1)', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-hugebrief-'));
  copyFixture(jobDir);
  fs.writeFileSync(path.join(jobDir, 'brief.md'), 'x'.repeat(20000));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-hugebrief-cwd-'));

  const brief = buildHandoffBrief({ jobDir, cwd, targetVendor: 'codex' });
  assert.match(brief, /## Why handed off/);
  assert.match(brief, /## Progress evidence/);
  assert.match(brief, /## Instructions/);
  assert.match(brief, /Continue from the current state described above/);
});

test('handoff() builds a brief, invokes the target vendor, and writes handoff-to.txt', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-run-'));
  copyFixture(jobDir);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-run-cwd-'));
  const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
  meta.cwd = cwd;
  fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify(meta));

  let received = null;
  const stubInvoke = async (mode, vendor, tier, briefSource, options, stdinText) => {
    received = { mode, vendor, tier, briefSource, options, stdinText };
    return { code: 0, outDir: '/tmp/fake-out-dir', failed: false };
  };

  const result = await handoff(jobDir, 'codex', undefined, { invoke: stubInvoke, name: 'test-handoff' });

  assert.equal(received.mode, 'run');
  assert.equal(received.vendor, 'codex');
  assert.equal(received.tier, DEFAULT_TIER.codex);
  assert.equal(received.briefSource, '-');
  assert.match(received.stdinText, /Continuation brief/);
  assert.equal(received.options.cd, cwd);
  assert.equal(received.options.name, 'test-handoff');
  assert.equal(received.options.invoke, undefined);
  assert.equal(result.outDir, '/tmp/fake-out-dir');

  const handoffTo = fs.readFileSync(path.join(jobDir, 'handoff-to.txt'), 'utf8');
  assert.match(handoffTo, /vendor=codex/);
  assert.match(handoffTo, /outDir=\/tmp\/fake-out-dir/);
});

test('handoff() honors an explicit tier over the vendor default', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-tier-'));
  copyFixture(jobDir);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-handoff-tier-cwd-'));
  const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
  meta.cwd = cwd;
  fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify(meta));

  let received = null;
  const stubInvoke = async (mode, vendor, tier) => {
    received = { mode, vendor, tier };
    return { code: 0, outDir: '/tmp/fake-out-dir-2', failed: false };
  };

  await handoff(jobDir, 'codex', 'sol', { invoke: stubInvoke });
  assert.equal(received.tier, 'sol');
});
