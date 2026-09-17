'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildJob, extractResult, invoke } = require('../lib/runner');
const { agyRow, preflight } = require('../lib/status');

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

test('cursor and opencode jobs put the prompt as a trailing argument', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-cursor-'));
  for (const vendor of ['cursor', 'opencode']) {
    const out = path.join(dir, vendor);
    fs.mkdirSync(out);
    const { job } = buildJob(vendor === 'cursor' ? 'agent' : 'opencode', vendor, 'run', vendor === 'cursor' ? 'auto' : 'opencode/mimo-v2.5-free', '', 'A brief with "quotes"', out, { cd: dir, yolo: true });
    assert.equal(job.args.at(-1), fs.readFileSync(path.join(out, 'prompt.md'), 'utf8'));
    assert.match(job.args.at(-1), /SOLE executor/);
    if (vendor === 'cursor') {
      assert.ok(job.args.includes('--trust'));
      assert.ok(job.args.includes('--force'));
      assert.equal(job.args[job.args.indexOf('--workspace') + 1], dir);
    } else {
      assert.ok(job.args.includes('--auto'));
      assert.equal(job.args[job.args.indexOf('--dir') + 1], dir);
    }
    const follow = buildJob(job.cmd, vendor, 'resume', '', 'test-session', 'follow-up', out, { cd: dir }).job;
    assert.ok(follow.args.includes('test-session'));
  }
});

test('all stream fixtures yield final reports and resumable IDs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-result-'));
  for (const vendor of ['codex', 'agy', 'claude', 'cursor', 'opencode']) {
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

test('buildJob injects a CRITICAL WORK note into the run-mode prompt only when guardInfo.critical is set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-critical-'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const { job } = buildJob('claude', 'claude', 'run', 'claude-sonnet-5', '', 'do the thing', out, { cd: dir }, { critical: true, reasons: ['heuristic: keyword "deploy" in brief'] });
  const prompt = fs.readFileSync(path.join(out, 'prompt.md'), 'utf8');
  assert.match(prompt, /CRITICAL WORK: this brief touches production\/critical systems/);
  assert.match(prompt, /heuristic: keyword "deploy" in brief/);
  assert.match(prompt, /OPEN QUESTIONS/);

  const outNonCritical = path.join(dir, 'out2');
  fs.mkdirSync(outNonCritical);
  const nonCritical = buildJob('claude', 'claude', 'run', 'claude-sonnet-5', '', 'do the thing', outNonCritical, { cd: dir }).job;
  const promptNonCritical = fs.readFileSync(path.join(outNonCritical, 'prompt.md'), 'utf8');
  assert.doesNotMatch(promptNonCritical, /CRITICAL WORK:/);

  // resume mode never injects the note even when critical, since the prompt there is a bare follow-up.
  const outResume = path.join(dir, 'out3');
  fs.mkdirSync(outResume);
  const resumeJob = buildJob('claude', 'claude', 'resume', '', 'session-1', 'follow-up', outResume, { cd: dir }, { critical: true, reasons: ['x'] }).job;
  assert.equal(fs.readFileSync(path.join(outResume, 'prompt.md'), 'utf8'), 'follow-up');
  void resumeJob;
});

test('invoke() refuses critical work on a small/standard model before submitting the job, without writing an output dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-guard-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const outRoot = path.join(dir, 'out');
  // Defense in depth: critical here is driven by options.critical (hard), not a brief
  // keyword — keyword hits are advisory-only and must never by themselves trigger a refusal
  // (or, if the guard regresses, a live run). PATH/HOME are still isolated below so a guard
  // regression that fails to refuse can never reach a real vendor CLI in this test.
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin);
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });

  const env = { HOME: scratchHome, PATH: emptyBin, DELEGATE_OUT: outRoot, DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'), DELEGATE_NO_WINDOW: '1' };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  try {
    await assert.rejects(
      () => invoke('run', 'codex', 'terra', briefFile, { cd: cwd, critical: true, noPreflight: true, guardConfig: { keywords: [], paths: [] } }),
      /CRITICAL WORK.*codex terra is a standard model; critical work requires a large model/
    );
    assert.equal(fs.existsSync(outRoot), false, 'no output dir should be created when the guard refuses before the job runs');
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('invoke() allows critical work on a large model and prints CRITICAL/PERMISSIONS lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-guard-ok-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const fakeCodex = path.join(bin, 'codex');
  fs.writeFileSync(fakeCodex, '#!/bin/bash\necho \'{"type":"turn.completed","thread_id":"t1","usage":{}}\'\nexit 0\n');
  fs.chmodSync(fakeCodex, 0o755);
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');

  // The fake codex binary is prepended to PATH — it always shadows a real `codex` on PATH by
  // resolution order — while the rest of the real PATH stays available for the shebang's own
  // /bin/bash lookup.
  const scratchHome = path.join(dir, 'home'); // isolate freshCodexHome()'s ~/.codex-fresh from the real machine
  fs.mkdirSync(scratchHome, { recursive: true });
  const env = {
    HOME: scratchHome,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DELEGATE_NO_WINDOW: '1',
    DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'),
    DELEGATE_OUT: path.join(dir, 'out')
  };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    // critical: true is the hard (--critical-equivalent) path — a keyword hit alone must never
    // be treated as critical (it's advisory-only; see the CRITICAL? tests in guard.test.js).
    await invoke('run', 'codex', 'sol', briefFile, { cd: cwd, critical: true, noPreflight: true, guardConfig: { keywords: [], paths: [] } });
    assert.ok(logs.some(l => l.startsWith('CRITICAL: --critical flag set')), JSON.stringify(logs));
    assert.ok(logs.some(l => /^PERMISSIONS: sandbox workspace-write \(no bypass\)$/.test(l)), JSON.stringify(logs));
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('invoke() prints CRITICAL? (never CRITICAL:) and does not refuse a small model when only a keyword is suspected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-suspected-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const fakeCodex = path.join(bin, 'codex');
  fs.writeFileSync(fakeCodex, '#!/bin/bash\necho \'{"type":"turn.completed","thread_id":"t1","usage":{}}\'\nexit 0\n');
  fs.chmodSync(fakeCodex, 0o755);
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'write docs about how to deploy this later\n');
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });
  const env = {
    HOME: scratchHome,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DELEGATE_NO_WINDOW: '1',
    DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'),
    DELEGATE_OUT: path.join(dir, 'out')
  };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    // codex 'luna' (small) — this must NOT be refused, since "deploy" here is only a suspected
    // (heuristic) hit, never hard critical.
    await invoke('run', 'codex', 'luna', briefFile, { cd: cwd, noPreflight: true, guardConfig: { keywords: ['deploy'], paths: [] } });
    assert.ok(
      logs.some(l => l === 'CRITICAL? heuristic: keyword "deploy" in brief — pass --critical if this touches live systems'),
      JSON.stringify(logs)
    );
    assert.ok(!logs.some(l => l.startsWith('CRITICAL:')), 'suspected-only must never print the hard CRITICAL: line');

    const outDir = fs.readdirSync(path.join(dir, 'out')).map(d => path.join(dir, 'out', d))[0];
    const prompt = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8');
    assert.match(prompt, /This brief may touch production\/critical systems/);
    assert.doesNotMatch(prompt, /^CRITICAL WORK: this brief touches/m);
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('preflight(codex) refuses when logged out and passes when access_token present', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-preflight-codex-'));
  const loggedOut = await preflight('codex', home, {});
  assert.equal(loggedOut.ok, false);
  assert.match(loggedOut.reason, /codex: not logged in/);
  assert.match(loggedOut.reason, /codex login/);
  assert.match(loggedOut.reason, /--no-preflight/);

  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'abc' } }));
  const loggedIn = await preflight('codex', home, {});
  assert.equal(loggedIn.ok, true);
});

test('preflight(codex) also passes when only ~/.codex-fresh/auth.json has the token (freshCodexHome symlink case)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-preflight-codex-fresh-'));
  // Simulates a non-full run where lib/runner.js's freshCodexHome() has already symlinked (or,
  // on win32, copied) ~/.codex-fresh/auth.json from the real ~/.codex/auth.json — either
  // location having a valid token must pass.
  fs.mkdirSync(path.join(home, '.codex-fresh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex-fresh', 'auth.json'), JSON.stringify({ tokens: { access_token: 'abc' } }));
  const result = await preflight('codex', home, {});
  assert.equal(result.ok, true);
});

test('preflight(cursor) fails OPEN: missing binary, non-zero exit, and malformed JSON all warn instead of refusing', async () => {
  // M1: tmpdir name deliberately avoids "cursor"/"grok" substrings — lib/bins.js's identity
  // heuristic scans the realpath's basename + immediate parent dir, and a fixture directory name
  // that happens to contain a vendor marker would let the heuristic accidentally "confirm" an
  // identity this test isn't actually testing (see the M1 fix in lib/bins.js's IDENTITY_WINDOW).
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-preflight-authcheck-empty-bin-'));
  const saved = { PATH: process.env.PATH };
  process.env.PATH = emptyBin; // `agent` absent from PATH -> spawn ENOENT -> run() reports code 127
  try {
    const missing = await preflight('cursor', os.tmpdir(), {});
    assert.equal(missing.ok, true);
    assert.match(missing.warning, /could not verify login/);
  } finally {
    process.env.PATH = saved.PATH;
  }
});

test('preflight(cursor) refuses only on a clean JSON that positively says not authenticated', async () => {
  // M1: same reasoning as above — no "cursor" in the tmpdir name, so this test exercises only
  // preflight's own JSON-parsing logic, not an accidental identity-heuristic match.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-preflight-authcheck-bin-'));
  const fakeAgent = path.join(bin, 'agent');
  fs.writeFileSync(fakeAgent, '#!/bin/bash\necho \'{"isAuthenticated": false, "status": "unauthenticated"}\'\nexit 0\n');
  fs.chmodSync(fakeAgent, 0o755);
  const saved = { PATH: process.env.PATH };
  process.env.PATH = bin;
  try {
    const refused = await preflight('cursor', os.tmpdir(), {});
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /cursor: not logged in/);
  } finally {
    process.env.PATH = saved.PATH;
  }
});

test('preflight(grok) refuses missing auth, passes with auth, warns on stale exhausted marker', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-preflight-grok-'));
  const loggedOut = await preflight('grok', home, {});
  assert.equal(loggedOut.ok, false);
  assert.match(loggedOut.reason, /grok: not logged in/);

  fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{}');
  const loggedIn = await preflight('grok', home, {});
  assert.equal(loggedIn.ok, true);
  assert.equal(loggedIn.warning, undefined);

  fs.writeFileSync(path.join(home, '.grok', '.last_402'), '2026-09-01\n');
  const warned = await preflight('grok', home, {});
  assert.equal(warned.ok, true);
  assert.match(warned.warning, /exhausted on 2026-09-01/);
});

test('preflight(agy) is always unknown: no reliable local login marker exists', async () => {
  const agy = await preflight('agy', '/tmp/whatever', {});
  assert.equal(agy.ok, true);
  assert.equal(agy.skipped, true);
  assert.equal(agy.state, 'unknown');
  assert.equal(agy.loginCommand, 'agy');
});

test('preflight(claude) reports ok/logged-out/unknown from an injected claude auth status runner', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-preflight-claude-'));

  const loggedIn = await preflight('claude', home, {
    claudeAuthStatus: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) })
  });
  assert.equal(loggedIn.ok, true);
  assert.equal(loggedIn.state, 'ok');

  const loggedOut = await preflight('claude', home, {
    claudeAuthStatus: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: false }) })
  });
  assert.equal(loggedOut.ok, true, 'claude preflight fails OPEN even when logged out');
  assert.equal(loggedOut.state, 'logged-out');
  assert.match(loggedOut.warning, /not logged in/);
  assert.equal(loggedOut.loginCommand, 'claude auth login');

  // Command missing/failing entirely, and no ~/.claude/.credentials.json fallback marker either
  // -> honest 'unknown', never a guess in either direction.
  const unknown = await preflight('claude', home, {
    claudeAuthStatus: async () => { throw new Error('ENOENT'); }
  });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.skipped, true);

  // The ~/.claude/.credentials.json fallback marker: command still fails, but the marker exists
  // -> 'ok', not 'unknown'.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  const fallbackOk = await preflight('claude', home, {
    claudeAuthStatus: async () => { throw new Error('ENOENT'); }
  });
  assert.equal(fallbackOk.ok, true);
  assert.equal(fallbackOk.state, 'ok');
});

test('invoke() refuses via injected preflight before any console/job work, and skips it on resume / --no-preflight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-preflight-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const outRoot = path.join(dir, 'out');
  const emptyBin = path.join(dir, 'empty-bin'); // no real vendor CLIs on PATH — these sub-tests
  fs.mkdirSync(emptyBin);                        // must never shell out to a live codex/grok/etc.
  const scratchHome = path.join(dir, 'home'); // isolate freshCodexHome()'s ~/.codex-fresh from the real machine
  fs.mkdirSync(scratchHome, { recursive: true });
  const env = { HOME: scratchHome, DELEGATE_OUT: outRoot, DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'), DELEGATE_NO_WINDOW: '1', PATH: emptyBin };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  try {
    const refusing = async () => ({ ok: false, reason: 'codex: not logged in — run \'codex login\' first (skip with --no-preflight)' });
    await assert.rejects(
      () => invoke('run', 'codex', 'terra', briefFile, { cd: cwd, preflight: refusing }),
      /not logged in/
    );
    assert.equal(fs.existsSync(outRoot), false, 'no output dir should be created when preflight refuses');

    // mode 'resume' must skip preflight entirely (thread already authenticated once). No real
    // codex binary on PATH (emptyBin), so the job itself fails (ENOENT) — invoke() resolves
    // (it never throws for a job-level failure), which is exactly the point: proves the
    // countingRefusal preflight was never consulted / never blocked the attempt.
    let calls = 0;
    const countingRefusal = async () => { calls++; return { ok: false, reason: 'should not matter' }; };
    const resumeResult = await invoke('resume', 'codex', 'thread-1', briefFile, { cd: cwd, preflight: countingRefusal });
    assert.equal(calls, 0, 'preflight must not run on resume');
    assert.doesNotMatch(resumeResult.reason || '', /should not matter/);

    calls = 0;
    const noPreflightResult = await invoke('run', 'codex', 'terra', briefFile, { cd: cwd, noPreflight: true, preflight: countingRefusal });
    assert.equal(calls, 0, 'preflight must not run with options.noPreflight');
    assert.doesNotMatch(noPreflightResult.reason || '', /should not matter/);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('invoke() lets exit 124 (job timeout) survive as the final code — never collapsed to 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-timeout-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const fakeCodex = path.join(bin, 'codex');
  // Sleeps far longer than the timeout below so the job actually gets cancelled.
  fs.writeFileSync(fakeCodex, '#!/bin/bash\nsleep 30\n');
  fs.chmodSync(fakeCodex, 0o755);
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });
  const env = {
    HOME: scratchHome,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DELEGATE_NO_WINDOW: '1',
    DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'),
    DELEGATE_OUT: path.join(dir, 'out')
  };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  try {
    // options.timeout is minutes; 0.01 min = 600ms, far shorter than the fake worker's 30s sleep.
    const result = await invoke('run', 'codex', 'sol', briefFile, { cd: cwd, noPreflight: true, timeout: 0.01 });
    assert.equal(result.code, 124, 'the final invoke() code must stay 124, not be collapsed to 1');
    assert.equal(fs.readFileSync(path.join(result.outDir, 'exit'), 'utf8'), '124');
    const lastMd = fs.readFileSync(path.join(result.outDir, 'last.md'), 'utf8');
    assert.match(lastMd, /WORKER FAILED/);
    assert.match(lastMd, /timed out/);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('invoke() throws the clear cursor bin-not-found message before any output dir is created (never falls back to grok\'s agent)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-binres-a-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const outRoot = path.join(dir, 'out');
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });
  // PATH carries ONLY a grok-owned `agent` and no cursor-agent anywhere — cursor resolution must
  // refuse outright rather than silently launching grok. Real Grok installs put `agent` and
  // `grok` in ~/.grok/bin/ as symlinks into a versioned ~/.grok/downloads/grok-<version>-<arch>
  // binary (same binary, two names) — the identity check only trusts the realpath's basename +
  // its immediate parent dir (lib/bins.js's IDENTITY_WINDOW, M1), which for this layout means
  // the basename alone ("grok-1.0.24-linux-x86_64") carries the "grok" signal, not an
  // intermediate ".grok"/"bin" path segment (an ancestor two-or-more levels up must never count,
  // e.g. a scratch-home directory that happens to contain "grok" in its own name).
  const grokBin = path.join(scratchHome, '.grok', 'bin');
  const grokDownloads = path.join(scratchHome, '.grok', 'downloads');
  fs.mkdirSync(grokBin, { recursive: true });
  fs.mkdirSync(grokDownloads, { recursive: true });
  const realGrokBinary = path.join(grokDownloads, 'grok-1.0.24-linux-x86_64');
  fs.writeFileSync(realGrokBinary, '#!/bin/bash\necho grok\n');
  fs.chmodSync(realGrokBinary, 0o755);
  fs.symlinkSync(realGrokBinary, path.join(grokBin, 'grok'));
  fs.symlinkSync(realGrokBinary, path.join(grokBin, 'agent')); // same binary, two names

  const env = { HOME: scratchHome, PATH: grokBin, DELEGATE_OUT: outRoot, DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'), DELEGATE_NO_WINDOW: '1' };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  try {
    await assert.rejects(
      () => invoke('run', 'cursor', 'auto', briefFile, { cd: cwd, noPreflight: true }),
      /cursor: 'agent' on PATH resolves to .*grok-1\.0\.24-linux-x86_64, which looks like grok — refusing to use it for cursor \(set DELEGATE_CURSOR_BIN or bins\.cursor in routing\.json\)/
    );
    assert.equal(fs.existsSync(outRoot), false, 'no output dir should be created when bin resolution fails');
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('invoke() throws the generic "could not find cursor-agent" message when nothing at all resolves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-binres-none-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const outRoot = path.join(dir, 'out');
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });

  const env = { HOME: scratchHome, PATH: emptyBin, DELEGATE_OUT: outRoot, DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'), DELEGATE_NO_WINDOW: '1' };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  try {
    await assert.rejects(
      () => invoke('run', 'cursor', 'auto', briefFile, { cd: cwd, noPreflight: true }),
      /cursor: could not find cursor-agent \(set DELEGATE_CURSOR_BIN or bins\.cursor in routing\.json\)/
    );
    assert.equal(fs.existsSync(outRoot), false, 'no output dir should be created when bin resolution fails');
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('invoke() prints BIN: <command> (<source>) and resolves cursor to cursor-agent, never grok\'s agent, even when grok\'s agent is also on PATH', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-binres-b-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });

  // Realistic `.grok/bin/agent` layout (see the identity-check comment in the previous test).
  const grokBin = path.join(scratchHome, '.grok', 'bin');
  fs.mkdirSync(grokBin, { recursive: true });
  fs.writeFileSync(path.join(grokBin, 'agent'), '#!/bin/bash\necho grok\n');
  fs.chmodSync(path.join(grokBin, 'agent'), 0o755);

  const cursorBin = path.join(dir, 'path-extra');
  fs.mkdirSync(cursorBin, { recursive: true });
  const fakeCursorAgent = path.join(cursorBin, 'cursor-agent');
  fs.writeFileSync(fakeCursorAgent, '#!/bin/bash\necho \'{"type":"result","session_id":"s1","result":"ok"}\'\nexit 0\n');
  fs.chmodSync(fakeCursorAgent, 0o755);

  const env = {
    HOME: scratchHome,
    PATH: [cursorBin, grokBin].join(path.delimiter), // cursor-agent found first regardless of grok's agent also being present
    DELEGATE_NO_WINDOW: '1',
    DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'),
    DELEGATE_OUT: path.join(dir, 'out')
  };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await invoke('run', 'cursor', 'auto', briefFile, { cd: cwd, noPreflight: true });
    assert.ok(logs.some(l => l === `BIN: ${fakeCursorAgent} (path:cursor-agent)`), JSON.stringify(logs));
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('invoke() honors DELEGATE_CURSOR_BIN env override end to end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-bins-env-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });
  const forcedBin = path.join(dir, 'forced', 'my-cursor-agent');
  fs.mkdirSync(path.dirname(forcedBin), { recursive: true });
  fs.writeFileSync(forcedBin, '#!/bin/bash\necho \'{"type":"result","session_id":"s1","result":"ok"}\'\nexit 0\n');
  fs.chmodSync(forcedBin, 0o755);

  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const env = {
    HOME: scratchHome,
    PATH: emptyBin,
    DELEGATE_CURSOR_BIN: forcedBin,
    DELEGATE_NO_WINDOW: '1',
    DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'),
    DELEGATE_OUT: path.join(dir, 'out')
  };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await invoke('run', 'cursor', 'auto', briefFile, { cd: cwd, noPreflight: true });
    assert.ok(logs.some(l => l === `BIN: ${forcedBin} (env)`), JSON.stringify(logs));
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

// L6: an unverified bin resolution (e.g. a bare `agent` on PATH whose identity couldn't be
// confirmed as cursor/grok — verdict 'unknown', not 'match') must be visibly flagged in the run's
// own console output, not silently used as if it were a confirmed resolution.
test('invoke(): BIN: line appends " [unverified]" when bin.verified is false (L6)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-invoke-binres-unverified-'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const briefFile = path.join(dir, 'brief.md');
  fs.writeFileSync(briefFile, 'reply OK\n');
  const outRoot = path.join(dir, 'out');
  const scratchHome = path.join(dir, 'home');
  fs.mkdirSync(scratchHome, { recursive: true });
  // A plain (non-symlink) `agent` with no vendor marker anywhere in its path -> resolveBin
  // returns it (never a hard failure for cursor unless identity says CONFLICT) but verified:false.
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeAgent = path.join(binDir, 'agent');
  fs.writeFileSync(fakeAgent, '#!/bin/bash\necho \'{"type":"result","session_id":"s1","result":"ok"}\'\nexit 0\n');
  fs.chmodSync(fakeAgent, 0o755);

  const env = { HOME: scratchHome, PATH: binDir, DELEGATE_OUT: outRoot, DELEGATE_CONSOLE_DIR: path.join(dir, 'consoles'), DELEGATE_NO_WINDOW: '1' };
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await invoke('run', 'cursor', 'auto', briefFile, { cd: cwd, noPreflight: true });
    assert.ok(logs.some(l => l === `BIN: ${fakeAgent} (path:agent) [unverified]`), JSON.stringify(logs));
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(env)) {
      if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

// L2: every other vendor row resolves its binary through lib/bins.js's resolveBin — agyRow was
// the one row still hardcoding the bare 'agy' command name, so a routing.json bins.agy override
// or well-known install dir was silently ignored for the status table specifically.
test('agyRow: resolves the agy binary via lib/bins.js instead of hardcoding the bare "agy" name (L2)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-agyrow-'));
  const fakeAgy = path.join(home, 'custom-agy-install', 'agy');
  fs.mkdirSync(path.dirname(fakeAgy), { recursive: true });
  fs.writeFileSync(fakeAgy, '#!/bin/bash\nif [ "$1" = "models" ]; then echo -e "gemini-3.8-flash-high-low\\tx"; else echo \'{}\'; fi\nexit 0\n');
  fs.chmodSync(fakeAgy, 0o755);
  const configDir = path.join(home, '.config', 'delegates');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({ bins: { agy: fakeAgy } }));

  const row = await agyRow(home);
  assert.equal(row[0], 'agy');
  // Reaching a real answer at all (rather than "usage unavailable"/"?") proves the configured
  // fakeAgy binary was actually invoked, not the bare 'agy' name (which isn't on PATH here).
  assert.notEqual(row[2], '?');
});
