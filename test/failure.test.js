'use strict';

// Fixture-driven tests for the shared failure classifier (lib/failure.js) and its wiring
// into extractResult (lib/runner.js). Covers the defect category: a worker fails in a
// vendor-specific way (quota, rate limit, auth expiry, max turns, turn.failed, stderr-only
// error) and the launcher must report exit 1 / a WORKER FAILED last.md, not exit 0 / empty.
//
// Fixture provenance: see test/fixtures/README.md for the full real-vs-synthetic list.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyFailure } = require('../lib/failure');
const { extractResult, invoke } = require('../lib/runner');

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('classifyFailure flags agy quota exhaustion with reset hint', () => {
  const raw = loadFixture('agy-quota-exhausted.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('agy', { events, raw, stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.equal(result.exhausted, true);
  assert.equal(result.resetHint, '144h14m57s');
  assert.match(result.reason, /RESOURCE_EXHAUSTED/);
});

test('classifyFailure flags codex turn.failed with reset hint', () => {
  const raw = loadFixture('codex-turn-failed.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('codex', { events, raw, stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.equal(result.exhausted, true);
  assert.equal(result.resetHint, '3h12m');
});

test('classifyFailure does not flag codex transient reconnect notices', () => {
  const events = [{ type: 'error', message: 'Reconnecting... 1/5' }, { type: 'item.completed', item: { type: 'agent_message', text: 'DONE' } }];
  const result = classifyFailure('codex', { events, raw: '', stderr: '', exitCode: 0, text: 'DONE' });
  assert.equal(result.failed, false);
});

test('classifyFailure flags claude result.is_error with error subtype', () => {
  const raw = loadFixture('claude-error.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('claude', { events, raw, stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.match(result.reason, /error_during_execution/);
});

test('classifyFailure flags cursor non-zero exit with no result event', () => {
  const raw = loadFixture('cursor-error.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('cursor', { events, raw, stderr: '', exitCode: 1, text: '' });
  assert.equal(result.failed, true);
  assert.match(result.reason, /exited 1 before a result event/);
});

test('classifyFailure flags opencode APIError with 429 as exhausted', () => {
  const raw = loadFixture('opencode-error.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('opencode', { events, raw, stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.equal(result.exhausted, true);
  assert.match(result.reason, /Rate limit exceeded/);
});

test('classifyFailure flags grok 402 as exhausted', () => {
  const raw = loadFixture('grok-402.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('grok', { events, raw, stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.equal(result.exhausted, true);
});

test('classifyFailure flags a bare stderr error: line with empty text, any vendor', () => {
  const result = classifyFailure('claude', { events: [], raw: '', stderr: 'error: something broke\n', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.match(result.reason, /something broke/);
});

// F3: reason must never be the whole stderr blob — only the matching line, truncated.
test('classifyFailure truncates a long matching stderr line and never uses the whole stderr blob', () => {
  const noise = 'irrelevant debug noise\n'.repeat(50);
  const longLine = `error: ${'x'.repeat(500)}`;
  const stderr = `${noise}${longLine}\n${noise}`;
  const result = classifyFailure('claude', { events: [], raw: '', stderr, exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.ok(result.reason.length <= 301, `reason should be truncated, got length ${result.reason.length}`);
  assert.ok(!result.reason.includes('irrelevant debug noise'), 'reason must not include unrelated stderr lines');
});

// F2: a mid-stream retryable error followed by a terminal success is not a failure.
test('classifyFailure does not flag codex mid-stream error followed by turn.completed', () => {
  const raw = loadFixture('codex-transient-error-then-success.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('codex', { events, raw, stderr: '', exitCode: 0, text: 'DONE' });
  assert.equal(result.failed, false);
});

test('classifyFailure does not flag opencode retryable APIError followed by text + step_finish stop', () => {
  const raw = loadFixture('opencode-transient-error-then-success.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('opencode', { events, raw, stderr: '', exitCode: 0, text: 'DONE' });
  assert.equal(result.failed, false);
});

test('classifyFailure still flags codex turn.failed even if it were followed by other events (unconditionally fatal)', () => {
  const events = [
    { type: 'turn.failed', error: { message: 'usage limit reached' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } },
    { type: 'turn.completed', usage: {} }
  ];
  const result = classifyFailure('codex', { events, raw: '', stderr: '', exitCode: 0, text: 'partial' });
  assert.equal(result.failed, true);
  assert.match(result.reason, /usage limit reached/);
});

test('classifyFailure still flags a real (non-recovered) opencode/grok/codex error with no later success', () => {
  const codexResult = classifyFailure('codex', { events: [{ type: 'error', message: 'fatal: disk full' }], raw: '', stderr: '', exitCode: 0, text: '' });
  assert.equal(codexResult.failed, true);
  const opencodeResult = classifyFailure('opencode', {
    events: [{ type: 'error', error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429 } } }],
    raw: '', stderr: '', exitCode: 0, text: ''
  });
  assert.equal(opencodeResult.failed, true);
});

// F4: claude/cursor use event.result as reason only when is_error is true; otherwise the subtype label.
test('classifyFailure uses the subtype label as reason when subtype is error-shaped but is_error is not set', () => {
  const events = [{ type: 'result', subtype: 'error_max_turns', session_id: 'x' }];
  const result = classifyFailure('claude', { events, raw: '', stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.match(result.reason, /subtype=error_max_turns/);
});

test('classifyFailure uses event.result as reason when is_error is true and result text is present', () => {
  const events = [{ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'boom', session_id: 'x' }];
  const result = classifyFailure('claude', { events, raw: '', stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.match(result.reason, /boom/);
});

// F5: grok 402 needs actual error context — a successful answer that merely mentions "402" text
// must not be flagged as quota exhaustion.
test('classifyFailure does not flag a successful grok answer that mentions 402 in its own text', () => {
  const raw = loadFixture('grok-success-mentions-402.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('grok', { events, raw, stderr: '', exitCode: 0, text: 'The HTTP 402 status code means Payment Required.' });
  assert.equal(result.failed, false);
  assert.equal(result.exhausted, false);
});

test('extractResult writes WORKER FAILED to last.md and sets exit-worthy failed=true per vendor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-failure-'));
  const fixtures = {
    agy: 'agy-quota-exhausted.jsonl',
    codex: 'codex-turn-failed.jsonl',
    claude: 'claude-error.jsonl',
    cursor: 'cursor-error.jsonl',
    opencode: 'opencode-error.jsonl',
    grok: 'grok-402.jsonl'
  };
  for (const [vendor, fixture] of Object.entries(fixtures)) {
    const outDir = path.join(dir, vendor);
    fs.mkdirSync(outDir);
    fs.copyFileSync(path.join(__dirname, 'fixtures', fixture), path.join(outDir, 'events.jsonl'));
    const exitCode = vendor === 'cursor' ? 1 : 0;
    const result = extractResult(vendor, outDir, { exitCode, stderr: '' });
    assert.equal(result.failed, true, `${vendor} should be failed`);
    const lastMd = fs.readFileSync(path.join(outDir, 'last.md'), 'utf8');
    assert.match(lastMd, /^WORKER FAILED:/, `${vendor} last.md should start with WORKER FAILED`);
    assert.equal(lastMd.trim(), result.text);
  }
});

test('classifyFailure leaves successful fixtures unfailed (regression guard)', () => {
  for (const vendor of ['codex', 'agy', 'claude', 'cursor', 'opencode', 'grok']) {
    const raw = loadFixture(`${vendor}.jsonl`);
    const events = raw.trim().split('\n').map(line => JSON.parse(line));
    const result = classifyFailure(vendor, { events, raw, stderr: '', exitCode: 0, text: 'DONE' });
    assert.equal(result.failed, false, `${vendor} success fixture should not be flagged failed`);
  }
});

// F7: success with empty text (e.g. exit 0, no stderr, no events at all) must not be flagged.
test('classifyFailure does not flag success with empty text when nothing else signals failure', () => {
  for (const vendor of ['codex', 'agy', 'claude', 'cursor', 'opencode', 'grok']) {
    const result = classifyFailure(vendor, { events: [], raw: '', stderr: '', exitCode: 0, text: '' });
    assert.equal(result.failed, false, `${vendor} should not be failed on bare empty/success input`);
  }
});

// F1: on failure, codex's own last.md body is preserved under the WORKER FAILED banner, and on
// success a pre-existing codex last.md is left completely untouched.
test('extractResult preserves an existing codex last.md body under the WORKER FAILED banner on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-codex-lastmd-fail-'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'codex-turn-failed.jsonl'), path.join(dir, 'events.jsonl'));
  fs.writeFileSync(path.join(dir, 'last.md'), 'Ran npm test, 12/12 passed. Edited lib/a.js.\n');
  const result = extractResult('codex', dir, { exitCode: 0, stderr: '' });
  assert.equal(result.failed, true);
  const lastMd = fs.readFileSync(path.join(dir, 'last.md'), 'utf8');
  assert.match(lastMd, /^WORKER FAILED:/);
  assert.match(lastMd, /Ran npm test, 12\/12 passed\. Edited lib\/a\.js\./);
  assert.equal(result.text, lastMd.trim());
});

test('extractResult leaves an existing codex last.md completely untouched on success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-codex-lastmd-ok-'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'codex.jsonl'), path.join(dir, 'events.jsonl'));
  const original = 'Ran npm test, 2/2 passed.\n';
  fs.writeFileSync(path.join(dir, 'last.md'), original);
  const before = fs.statSync(path.join(dir, 'last.md')).mtimeMs;
  const result = extractResult('codex', dir, { exitCode: 0, stderr: '' });
  assert.equal(result.failed, false);
  const after = fs.readFileSync(path.join(dir, 'last.md'), 'utf8');
  assert.equal(after, original, 'last.md content must be byte-for-byte untouched');
  assert.equal(fs.statSync(path.join(dir, 'last.md')).mtimeMs, before, 'last.md must not be rewritten (mtime unchanged)');
  assert.equal(result.text, original.trim());
});

// N1: codex turn.failed with no pre-existing -o file (codex crashed before writing one) must
// still surface whatever agent_message text streamed before the failure, under the banner.
test('extractResult keeps the streamed agent_message body when codex fails with no pre-existing last.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-codex-lastmd-nofile-'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'codex-turn-failed-with-partial-text.jsonl'), path.join(dir, 'events.jsonl'));
  assert.ok(!fs.existsSync(path.join(dir, 'last.md')), 'no last.md should exist before extractResult runs');
  const result = extractResult('codex', dir, { exitCode: 0, stderr: '' });
  assert.equal(result.failed, true);
  const lastMd = fs.readFileSync(path.join(dir, 'last.md'), 'utf8');
  assert.match(lastMd, /^WORKER FAILED: usage limit reached/);
  assert.match(lastMd, /Edited lib\/a\.js, ran npm test \(2\/2 passed\) before the turn failed\./);
  assert.equal(result.text, lastMd.trim());
});

// N2: a transient mid-stream error's message must not overwrite a later, definitive
// turn.failed reason.
test('classifyFailure keeps the turn.failed reason even after a prior transient error event', () => {
  const events = [
    { type: 'error', message: 'transient blip' },
    { type: 'turn.failed', error: { message: 'usage limit reached, resets in 5h' } }
  ];
  const result = classifyFailure('codex', { events, raw: '', stderr: '', exitCode: 0, text: '' });
  assert.equal(result.failed, true);
  assert.match(result.reason, /usage limit reached/);
  assert.ok(!/transient blip/.test(result.reason), 'transient error message must not leak into the reason');
});

// N3: the grok 402 regex only ever inspects an error event's own message or stderr — never the
// answer text — so it must still fire even when some partial answer text came through too.
test('classifyFailure flags grok 402 in stderr as exhausted even with partial result text', () => {
  const events = [{ type: 'result', result: 'partial answer before the CLI reported the error' }];
  const result = classifyFailure('grok', {
    events,
    raw: JSON.stringify(events[0]),
    stderr: 'API error (status 402): quota exceeded',
    exitCode: 0,
    text: 'partial answer before the CLI reported the error'
  });
  assert.equal(result.failed, true);
  assert.equal(result.exhausted, true);
});

test('classifyFailure still does not flag a successful grok answer that only mentions 402 in its own text (regression)', () => {
  const raw = loadFixture('grok-success-mentions-402.jsonl');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = classifyFailure('grok', { events, raw, stderr: '', exitCode: 0, text: 'The HTTP 402 status code means Payment Required.' });
  assert.equal(result.failed, false);
  assert.equal(result.exhausted, false);
});

// F7: invoke()-level test — a fake `grok` binary on PATH emits a 402-shaped success-exit-code
// stream; invoke() must still write exit=1, print the generalized EXHAUSTED reroute line, and
// stamp .last_402 under a scratch HOME (never the real one).
test('invoke() classifies a fake grok 402 response as failed, writes exit=1, and stamps .last_402', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-grok-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const fakeGrok = path.join(bin, 'grok');
  fs.writeFileSync(fakeGrok, '#!/usr/bin/env bash\necho \'{"type":"result","result":"","error":"HTTP 402 (Payment Required): weekly budget exhausted"}\'\nexit 0\n');
  fs.chmodSync(fakeGrok, 0o755);
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');

  const env = {
    HOME: scratchHome,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DELEGATE_NO_WINDOW: '1',
    DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'),
    DELEGATE_OUT: path.join(dir, 'out')
  };
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  Object.assign(process.env, env);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const result = await invoke('run', 'grok', 'fast', briefFile, { cd: cwd });
    assert.equal(result.failed, true);
    assert.equal(result.exhausted, true);
    const exitFileContent = fs.readFileSync(path.join(result.outDir, 'exit'), 'utf8');
    assert.equal(exitFileContent, '1');
    assert.ok(logs.some(l => /^GROK EXHAUSTED — reroute to /.test(l)), `expected a GROK EXHAUSTED line, got: ${JSON.stringify(logs)}`);
    const marker = path.join(scratchHome, '.grok', '.last_402');
    assert.ok(fs.existsSync(marker), '.last_402 marker should be written under the scratch HOME');
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
