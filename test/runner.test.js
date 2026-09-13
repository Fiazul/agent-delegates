'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildJob, extractResult } = require('../lib/runner');

test('vendor jobs preserve prompts and paths with spaces as individual arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates job '));
  for (const vendor of ['agy', 'grok', 'claude']) {
    const out = path.join(dir, vendor);
    fs.mkdirSync(out);
    const { job } = buildJob(vendor, vendor, 'run', 'sample-model', '', 'A brief with "quotes" and $literal', out, { cd: dir });
    assert.equal(job.cwd, dir);
    assert.equal(job.args[job.args.indexOf('-p') + 1], fs.readFileSync(path.join(out, 'prompt.md'), 'utf8'));
    assert.match(job.args[job.args.indexOf('-p') + 1], /SOLE executor/);
    if (vendor === 'agy') {
      assert.equal(job.args.at(-2), '-p');
      assert.match(job.args.at(-1), /WORKING DIRECTORY:/);
    }
    if (vendor === 'claude') assert.ok(job.args.includes('acceptEdits'));
    const follow = buildJob(vendor, vendor, 'resume', '', 'test-session', 'follow-up', out, { cd: dir }).job;
    assert.ok(follow.args.includes('test-session'));
    assert.equal(fs.readFileSync(path.join(out, 'prompt.md'), 'utf8'), 'follow-up');
  }
});

test('all stream fixtures yield final reports and resumable IDs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-result-'));
  for (const vendor of ['codex', 'agy', 'claude']) {
    fs.copyFileSync(path.join(__dirname, 'fixtures', vendor + '.jsonl'), path.join(dir, 'events.jsonl'));
    try { fs.unlinkSync(path.join(dir, 'last.md')); } catch {}
    const result = extractResult(vendor, dir);
    assert.ok(result.id);
    assert.equal(result.text, 'DONE');
    assert.equal(result.failed, false);
    assert.ok(fs.existsSync(path.join(dir, 'last.md')));
  }
});

test('Grok JSON worker errors fail even when the process returned success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-grok-error-'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'error', message: 'HTTP 402 exhausted' }));
  const result = extractResult('grok', dir);
  assert.equal(result.failed, true);
  assert.match(result.text, /WORKER FAILED/);
});
