'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn: nodeSpawn } = require('node:child_process');
const { acquireSpawnLock, interrupt, readStartedAt, releaseSpawnLock, runConsole, submitJob } = require('../lib/console');

// M3: DELEGATE_NO_WINDOW inline consoles here spawn real `_console` subprocesses. Without
// DELEGATE_QUIET their inherited stdio can land raw/ANSI console output on this test process's
// own stdout fd and corrupt the node test runner's structured reporting channel ("Unable to
// deserialize cloned data") — see lib/console.js's Mirror.write/runInline.
process.env.DELEGATE_QUIET = '1';

test('inline console executes a queued JSON job and completes the exit handshake', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-queue-'));
  const old = { root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  process.env.DELEGATE_NO_WINDOW = '1';
  const outDir = path.join(temp, 'output with spaces');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'brief.md'), 'tiny brief\n');
  try {
    const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'queued result' } });
    const command = process.platform === 'win32' ? 'cmd.exe' : 'printf';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', `echo ${event}`] : [`${event}\n`];
    const code = await submitJob('test-window', {
      cmd: command,
      args,
      cwd: temp,
      env: { DELEGATE_VENDOR: 'codex' },
      outDir,
      header: '▌ BRIEF  codex · test'
    });
    assert.equal(code, 0);
    assert.match(fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf8'), /queued result/);
    assert.match(fs.readFileSync(path.join(temp, 'consoles', 'test-window', 'console.log'), 'utf8'), /queued result/);
    assert.equal(fs.readdirSync(path.join(temp, 'consoles', 'test-window', 'done')).filter(x => x.endsWith('.job')).length, 1);
  } finally {
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
  }
});

test('submitJob times out a hung job (exit 124), consumes the cancel marker, and the window keeps serving jobs', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-timeout-'));
  const old = { root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  process.env.DELEGATE_NO_WINDOW = '1';
  const name = 'timeout-window';
  try {
    // Job 1: a command that hangs far longer than the timeout.
    const outDir1 = path.join(temp, 'out1');
    fs.mkdirSync(outDir1, { recursive: true });
    const slowCommand = process.platform === 'win32' ? 'cmd.exe' : 'sleep';
    const slowArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'ping -n 60 127.0.0.1 >NUL'] : ['30'];
    const code1 = await submitJob(name, {
      cmd: slowCommand,
      args: slowArgs,
      cwd: temp,
      env: {},
      outDir: outDir1,
      header: '▌ BRIEF  codex · slow'
    }, { timeoutMs: 500 });
    assert.equal(code1, 124, 'a hung job past its timeout must exit 124');

    // The cancel marker must be consumed (deleted), never left behind for a later job.
    const queueDir = path.join(temp, 'consoles', name, 'queue');
    const leftoverCancel = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter(f => f.endsWith('.cancel')) : [];
    assert.deepEqual(leftoverCancel, [], 'no .cancel marker should remain after it is consumed');

    // The console/window must still be usable afterwards — never left wedged by the timeout.
    const outDir2 = path.join(temp, 'out2');
    fs.mkdirSync(outDir2, { recursive: true });
    const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'still alive' } });
    const fastCommand = process.platform === 'win32' ? 'cmd.exe' : 'printf';
    const fastArgs = process.platform === 'win32' ? ['/d', '/s', '/c', `echo ${event}`] : [`${event}\n`];
    const code2 = await submitJob(name, {
      cmd: fastCommand,
      args: fastArgs,
      cwd: temp,
      env: { DELEGATE_VENDOR: 'codex' },
      outDir: outDir2,
      header: '▌ BRIEF  codex · fast'
    });
    assert.equal(code2, 0, 'the window must keep serving subsequent jobs after a timeout');
    assert.match(fs.readFileSync(path.join(outDir2, 'events.jsonl'), 'utf8'), /still alive/);
  } finally {
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
  }
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// M2 — an empty (or not-yet-written) `.started` file must never be read as deadline=epoch. -----

test('M2: readStartedAt treats an empty/missing/garbage .started file as "not started yet", never as timestamp 0', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-m2-started-'));

  assert.equal(readStartedAt(path.join(temp, 'does-not-exist.started')), null, 'a missing file (readFileOrNull -> null -> Number(null) === 0) must not read as started');

  const emptyFile = path.join(temp, 'empty.started');
  fs.writeFileSync(emptyFile, '');
  assert.equal(readStartedAt(emptyFile), null, 'an empty file (Number("") === 0) must not read as started');

  const garbageFile = path.join(temp, 'garbage.started');
  fs.writeFileSync(garbageFile, 'not-a-number');
  assert.equal(readStartedAt(garbageFile), null, 'non-numeric content must not read as started');

  const realFile = path.join(temp, 'real.started');
  const now = Date.now();
  fs.writeFileSync(realFile, String(now));
  assert.equal(readStartedAt(realFile), now, 'a genuine timestamp must still be read correctly');
});

test('M2 (integration): a job whose .started file exists but is briefly empty is never spuriously cancelled at 124', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-m2-integration-'));
  const old = { root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  process.env.DELEGATE_NO_WINDOW = '1';
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    // A tiny timeoutMs (10ms) means submitJob's very first poll (250ms later) will already see
    // the `.started` file — under the old bug (Number(null/"") read as 0) that first poll would
    // compute deadline = 0 + 10 = long past, and cancel the job on the very next tick even though
    // it hadn't had any real run time at all. The job itself sleeps well past watchForCancel's 1s
    // poll interval so a real cancel (once sent) has time to actually land.
    const code = await submitJob('m2-integration-window', {
      cmd: 'sleep',
      args: ['5'],
      cwd: temp,
      env: { DELEGATE_VENDOR: 'codex' },
      outDir,
      header: 'm2 integration'
    }, { timeoutMs: 10 });
    // A real timeoutMs=10 SHOULD still eventually cancel this job — this asserts it does so for
    // the right reason (a real deadline once .started carries a genuine timestamp), not that it
    // never cancels at all.
    assert.equal(code, 124, 'the real (tiny) timeout must still fire once the job has actually started');
  } finally {
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
  }
});

// F6/M1(b) — the grace-timer kills a child that said it was done but never exited, but must not
// mistake a stream that's still actively producing events for a hung one. -------------------------

test('F6: a child that emits a terminal-shaped event and then hangs is grace-killed', async (t) => {
  if (process.platform === 'win32') { t.skip('relies on unix sleep/bash'); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-grace-hang-'));
  const old = {
    root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW,
    grace: process.env.DELEGATE_TERMINAL_GRACE_MS
  };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  process.env.DELEGATE_NO_WINDOW = '1';
  process.env.DELEGATE_TERMINAL_GRACE_MS = '200';
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const script = `printf '{"type":"turn.completed"}\\n'; sleep 5`;
    const before = Date.now();
    const code = await submitJob('grace-hang-window', {
      cmd: 'bash',
      args: ['-c', script],
      cwd: temp,
      env: { DELEGATE_VENDOR: 'codex' },
      outDir,
      header: 'grace hang'
    });
    assert.equal(code, 0, 'a graced kill after a terminal event reports the same code a clean exit would');
    assert.ok(Date.now() - before < 4000, 'the grace timer must kill the hung process rather than waiting out its full sleep');
    assert.match(
      fs.readFileSync(path.join(temp, 'consoles', 'grace-hang-window', 'console.log'), 'utf8'),
      /STREAM COMPLETE but process did not exit/
    );
  } finally {
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
    if (old.grace == null) delete process.env.DELEGATE_TERMINAL_GRACE_MS; else process.env.DELEGATE_TERMINAL_GRACE_MS = old.grace;
  }
});

test('M1(b): further parsed events after the first terminal-shaped event re-arm the grace timer instead of killing a still-producing stream', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-grace-rearm-'));
  const old = {
    root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW,
    grace: process.env.DELEGATE_TERMINAL_GRACE_MS
  };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  process.env.DELEGATE_NO_WINDOW = '1';
  process.env.DELEGATE_TERMINAL_GRACE_MS = '300';
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const marker = path.join(temp, 'ran-to-completion');
  try {
    // First line is terminal-shaped (codex turn.completed) at t=0, then 3 more real events land
    // over 600ms (200ms apart) — each one must cancel/re-arm the 300ms grace window rather than
    // the process getting killed ~300ms after the FIRST one while it's still actively producing.
    const script = [
      `printf '{"type":"turn.completed"}\\n'`,
      'sleep 0.2',
      `printf '{"type":"item.completed","item":{"type":"agent_message","text":"chunk1"}}\\n'`,
      'sleep 0.2',
      `printf '{"type":"item.completed","item":{"type":"agent_message","text":"chunk2"}}\\n'`,
      'sleep 0.2',
      `printf '{"type":"item.completed","item":{"type":"agent_message","text":"final chunk"}}\\n'`,
      `touch ${shellQuoteForBash(marker)}`
    ].join('; ');
    const code = await submitJob('grace-rearm-window', {
      cmd: 'bash',
      args: ['-c', script],
      cwd: temp,
      env: { DELEGATE_VENDOR: 'codex' },
      outDir,
      header: 'grace rearm'
    });
    assert.equal(code, 0);
    assert.ok(fs.existsSync(marker), 'the process must have run to its own natural completion, not been grace-killed mid-stream');
    assert.match(fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf8'), /final chunk/);
  } finally {
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
    if (old.grace == null) delete process.env.DELEGATE_TERMINAL_GRACE_MS; else process.env.DELEGATE_TERMINAL_GRACE_MS = old.grace;
  }
});

// m8 — DELEGATE_TERMINAL_GRACE_MS=0 must disable the grace-kill entirely. ---------------------

test('m8: DELEGATE_TERMINAL_GRACE_MS=0 disables the grace-kill (a terminal event followed by a slow-exiting process is never killed)', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-grace-disabled-'));
  const old = {
    root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW,
    grace: process.env.DELEGATE_TERMINAL_GRACE_MS
  };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  process.env.DELEGATE_NO_WINDOW = '1';
  process.env.DELEGATE_TERMINAL_GRACE_MS = '0';
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    // Emits the terminal event immediately, then takes 500ms to actually exit on its own — with
    // the grace-kill disabled this must be allowed to run to its own natural (clean) exit.
    const script = `printf '{"type":"turn.completed"}\\n'; sleep 0.5`;
    const code = await submitJob('grace-disabled-window', {
      cmd: 'bash',
      args: ['-c', script],
      cwd: temp,
      env: { DELEGATE_VENDOR: 'codex' },
      outDir,
      header: 'grace disabled'
    });
    assert.equal(code, 0);
    assert.doesNotMatch(
      fs.readFileSync(path.join(temp, 'consoles', 'grace-disabled-window', 'console.log'), 'utf8'),
      /STREAM COMPLETE but process did not exit/
    );
  } finally {
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
    if (old.grace == null) delete process.env.DELEGATE_TERMINAL_GRACE_MS; else process.env.DELEGATE_TERMINAL_GRACE_MS = old.grace;
  }
});

function shellQuoteForBash(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

test('a queued-behind job is not cancelled while waiting; its timeout window starts when it begins executing', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-queue-order-'));
  const old = { root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  delete process.env.DELEGATE_NO_WINDOW; // drive a single persistent runConsole() ourselves below
  const name = 'queue-order-window';
  const directory = path.join(temp, 'consoles', name);
  const consolePromise = runConsole(directory, name, 10, {});
  try {
    const pidFile = path.join(directory, 'pid');
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await wait(20);
    assert.ok(fs.existsSync(pidFile), 'runConsole should have come up');

    // Job B occupies the consumer for ~1s before job A even starts — queued directly (not via
    // submitJob, which would spawn its own consumer/window) so both share this one consumer.
    const outDirB = path.join(temp, 'outB');
    fs.mkdirSync(outDirB, { recursive: true });
    const queueDir = path.join(directory, 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    const idB = `${Date.now()}-000-b`;
    const jobB = { id: idB, cmd: 'sleep', args: ['1'], cwd: temp, env: {}, outDir: outDirB, header: 'B' };
    fs.writeFileSync(path.join(queueDir, `${idB}.job.tmp`), JSON.stringify(jobB));
    fs.renameSync(path.join(queueDir, `${idB}.job.tmp`), path.join(queueDir, `${idB}.job`));
    await wait(50); // ensure B's filename sorts before A's

    // Job A: quick (300ms) once it actually runs, submitted with a short 500ms timeout. Under
    // the OLD (broken) behavior — deadline = submission time + timeoutMs — this would already
    // be overdue by the time A starts (it waits behind B's ~1s) and get wrongly cancelled.
    const outDirA = path.join(temp, 'outA');
    fs.mkdirSync(outDirA, { recursive: true });
    const codeA = await submitJob(name, {
      cmd: 'bash',
      args: ['-c', 'sleep 0.3; printf \'{"type":"item.completed","item":{"type":"agent_message","text":"A done"}}\\n\''],
      cwd: temp,
      env: { DELEGATE_VENDOR: 'codex' },
      outDir: outDirA,
      header: 'A'
    }, { timeoutMs: 500 });

    assert.equal(codeA, 0, 'A must complete normally — its timeout window starts when it begins executing, not when queued');
    assert.match(fs.readFileSync(path.join(outDirA, 'events.jsonl'), 'utf8'), /A done/);

    // No leftover .cancel/.started markers for A (submitJob's own wait loop cleans these up as
    // a backstop). Job B was queued directly, bypassing submitJob, purely so this test could
    // drive a single shared consumer — its `${idB}.started` marker has no submitJob waiter to
    // clean it up and is expected test scaffolding residue, not a product-level leak.
    const leftovers = fs.readdirSync(queueDir).filter(f => f.endsWith('.cancel') || (f.endsWith('.started') && !f.startsWith(idB)));
    assert.deepEqual(leftovers, [], `no leftover markers expected, got: ${JSON.stringify(leftovers)}`);
  } finally {
    fs.writeFileSync(path.join(directory, 'stop'), '');
    await consolePromise;
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
  }
});

// F1 — no signal handling; Ctrl-C orphans the vendor CLI. -----------------------------------

test('F1: SIGTERM delivered to the console process kills its running worker instead of orphaning it', async (t) => {
  if (process.platform === 'win32') { t.skip('unix process-group signal semantics'); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-sigterm-'));
  const directory = path.join(temp, 'consoles', 'sigterm-window');
  fs.mkdirSync(path.join(directory, 'queue'), { recursive: true });
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const id = `${Date.now()}-sigterm`;
  const job = { id, cmd: 'sleep', args: ['5'], cwd: temp, env: {}, outDir, header: 'sigterm job' };
  fs.writeFileSync(path.join(directory, 'queue', `${id}.job`), JSON.stringify(job));

  const script = `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'console.js'))})` +
    `.runConsole(${JSON.stringify(directory)}, 'sigterm-window', 10, { once: true }).then(() => process.exit(0));`;
  const consoleProcess = nodeSpawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  try {
    const currentPidFile = path.join(directory, 'current.pid');
    let workerPid = null;
    for (let i = 0; i < 100 && !workerPid; i++) {
      await wait(50);
      const raw = fs.existsSync(currentPidFile) ? fs.readFileSync(currentPidFile, 'utf8') : null;
      if (raw) { try { workerPid = JSON.parse(raw).pid; } catch {} }
    }
    assert.ok(workerPid, 'the worker (sleep 5) should have started and recorded its pid in current.pid');
    assert.doesNotThrow(() => process.kill(workerPid, 0), 'worker should be alive before the signal');

    const exited = new Promise(resolve => consoleProcess.once('exit', (code, signal) => resolve({ code, signal })));
    consoleProcess.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 143, 'the console process must exit with the conventional 128+SIGTERM code');

    for (let i = 0; i < 20; i++) {
      try { process.kill(workerPid, 0); } catch { break; }
      await wait(50);
    }
    assert.throws(() => process.kill(workerPid, 0), 'the worker must not survive the console being SIGTERM-ed (no orphan)');
  } finally {
    try { consoleProcess.kill('SIGKILL'); } catch {}
  }
});

// F2 — rename outside try/catch + finally unlinks a shared pid file. -------------------------

// F2/m1: a rename failure claiming a queued job is only ever "not our job to run, move on"
// when the source file is genuinely gone (a sibling console really did win the race) — the mock
// below actually removes the source before throwing ENOENT, the same as a real winning sibling's
// renameSync would leave behind. A second, still-queued job (untouched by the race) must still
// get claimed and run normally afterwards, proving the console doesn't crash OR get stuck.
test('F2/m1: a genuine rename race (ENOENT, source really gone) is skipped without crashing; the console moves on to the next queued job', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-rename-race-'));
  const directory = path.join(temp, 'consoles', 'rename-race-window');
  fs.mkdirSync(path.join(directory, 'queue'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'done'), { recursive: true });
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stolenId = `${Date.now()}-rename-race-stolen`;
  const wonId = `${Date.now()}-rename-race-won`;
  const command = process.platform === 'win32' ? 'cmd.exe' : 'true';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'exit 0'] : [];
  const stolenJobFile = path.join(directory, 'queue', `${stolenId}.job`);
  fs.writeFileSync(stolenJobFile, JSON.stringify({ id: stolenId, cmd: command, args, cwd: temp, env: {}, outDir, header: 'stolen' }));
  fs.writeFileSync(path.join(directory, 'queue', `${wonId}.job`), JSON.stringify({ id: wonId, cmd: command, args, cwd: temp, env: {}, outDir, header: 'won' }));

  const realRename = fs.renameSync;
  let intercepted = false;
  fs.renameSync = (src, dest) => {
    if (!intercepted && String(src).includes(`${stolenId}.job`)) {
      intercepted = true;
      // A real winning sibling would have already moved this file away — simulate that (not
      // just a bare throw with the source untouched, which is a DIFFERENT, non-race ENOENT case
      // covered by the m1 test below).
      try { fs.unlinkSync(src); } catch {}
      const error = new Error('simulated race: another console already claimed this job');
      error.code = 'ENOENT';
      throw error;
    }
    return realRename(src, dest);
  };
  try {
    await runConsole(directory, 'rename-race-window', 10, { once: true });
  } finally {
    fs.renameSync = realRename;
  }

  assert.ok(intercepted, 'the simulated rename race must actually have been exercised');
  assert.ok(!fs.existsSync(stolenJobFile), 'the "stolen" job stays gone — it was never ours to run');
  assert.equal(
    fs.readdirSync(path.join(directory, 'done')).filter(f => f.endsWith('.job')).length, 1,
    'the second, untouched job must still be claimed and run normally'
  );
  assert.ok(fs.existsSync(path.join(directory, 'queue', `${wonId}.exit`)), 'the second job must complete');
});

// m1: an ENOENT from renameSync where the source file is still actually present (some other
// cause — e.g. the `done` directory itself vanishing) is NOT a race and must rethrow rather than
// being silently swallowed into an infinite continue/busy-spin retrying the same still-queued job.
test('m1: an ENOENT rename failure with the source file still present is rethrown, not silently retried forever', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-rename-nonrace-'));
  const directory = path.join(temp, 'consoles', 'rename-nonrace-window');
  fs.mkdirSync(path.join(directory, 'queue'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'done'), { recursive: true });
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const id = `${Date.now()}-rename-nonrace`;
  fs.writeFileSync(path.join(directory, 'queue', `${id}.job`), JSON.stringify({ id, cmd: 'true', args: [], cwd: temp, env: {}, outDir, header: 'nonrace' }));

  const realRename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (String(src).includes(`${id}.job`)) {
      // Source is deliberately left in place — this ENOENT is NOT "someone else claimed it".
      const error = new Error('simulated non-race ENOENT (e.g. done dir vanished)');
      error.code = 'ENOENT';
      throw error;
    }
    return realRename(src, dest);
  };
  try {
    await assert.rejects(
      runConsole(directory, 'rename-nonrace-window', 10, { once: true }),
      /simulated non-race ENOENT/
    );
  } finally {
    fs.renameSync = realRename;
  }
});

test("F2: an exiting console only deletes the shared pid file if it still names itself (doesn't clobber a live survivor)", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-pid-owner-'));
  const directory = path.join(temp, 'consoles', 'pid-owner-window');
  const consolePromise = runConsole(directory, 'pid-owner-window', 10, {});
  const pidFile = path.join(directory, 'pid');
  try {
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await wait(20);
    assert.ok(fs.existsSync(pidFile), 'runConsole should have come up');
    assert.equal(fs.readFileSync(pidFile, 'utf8'), String(process.pid), 'sanity: it recorded its own pid');

    // Simulate a newer/sibling console instance having reclaimed the shared pid file while this
    // one is mid-shutdown — this is exactly the state a crashed rename-race loser (F2's other
    // half) could leave behind before this fix's ownership check.
    fs.writeFileSync(pidFile, '999999999');
    fs.writeFileSync(path.join(directory, 'stop'), '');
    await consolePromise;

    assert.equal(
      fs.readFileSync(pidFile, 'utf8'), '999999999',
      "the survivor's pid must not be deleted by a console that no longer owns the file"
    );
  } finally {
    try { fs.unlinkSync(path.join(directory, 'stop')); } catch {}
  }
});

// F3 — TOCTOU double window. ------------------------------------------------------------------

test('F3: acquireSpawnLock is mutually exclusive (O_EXCL) and a stale lock is cleared for the next caller', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-spawn-lock-'));
  const directory = path.join(temp, 'lock-window');
  fs.mkdirSync(directory, { recursive: true });

  assert.equal(acquireSpawnLock(directory), true, 'first acquire should succeed');
  assert.equal(acquireSpawnLock(directory), false, 'a second concurrent acquire must fail while the lock is held');
  releaseSpawnLock(directory);
  assert.equal(acquireSpawnLock(directory), true, 'acquire should succeed again once released');
  releaseSpawnLock(directory);

  // A lock left behind by a crash (never released) must not wedge every future submission.
  const lockFile = path.join(directory, 'spawn.lock');
  fs.closeSync(fs.openSync(lockFile, 'wx'));
  const old = new Date(Date.now() - 31000);
  fs.utimesSync(lockFile, old, old);
  assert.equal(acquireSpawnLock(directory), true, 'a stale (>30s) lock must be cleared and reacquired');
  releaseSpawnLock(directory);
});

test('F3: runConsole refuses to start when a live pid file already names a different, live process', async (t) => {
  if (process.platform === 'win32') { t.skip('uses a unix stand-in process'); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-refuse-start-'));
  const directory = path.join(temp, 'consoles', 'refuse-start-window');
  fs.mkdirSync(directory, { recursive: true });
  const other = nodeSpawn('sleep', ['5'], { stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      other.once('spawn', resolve);
      other.once('error', reject);
    });
    const pidFile = path.join(directory, 'pid');
    fs.writeFileSync(pidFile, String(other.pid));

    const before = Date.now();
    await runConsole(directory, 'refuse-start-window', 10, {});
    assert.ok(Date.now() - before < 2000, 'runConsole must return promptly instead of looping when another live owner holds the pid');
    assert.equal(fs.readFileSync(pidFile, 'utf8'), String(other.pid), 'the pid file must be left untouched, still naming the live owner');
  } finally {
    try { other.kill('SIGKILL'); } catch {}
  }
});

// B1 — runConsole's F3 refusal must never gate the one-shot inline (`--once`) case: two
// concurrent DELEGATE_NO_WINDOW=1 submitJob calls for the same window each spawn their own
// `--once` inline console, and each one observing the other's still-live pid file must NOT
// refuse to start (spawnWindow — the persistent-window path — never passes --once, so a real
// persistent console is unaffected by this). ---------------------------------------------------

test('B1: two concurrent DELEGATE_NO_WINDOW inline submitJob calls on the same window both complete (neither refuses on the other\'s live pid)', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-inline-concurrent-'));
  const old = { root: process.env.DELEGATE_CONSOLE_DIR, inline: process.env.DELEGATE_NO_WINDOW };
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  process.env.DELEGATE_NO_WINDOW = '1';
  const name = 'inline-concurrent-window';
  try {
    const makeJob = (label) => {
      const outDir = path.join(temp, `out-${label}`);
      fs.mkdirSync(outDir, { recursive: true });
      const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `result ${label}` } });
      return {
        outDir,
        promise: submitJob(name, {
          cmd: 'bash',
          args: ['-c', `sleep 0.2; printf '${event}\\n'`],
          cwd: temp,
          env: { DELEGATE_VENDOR: 'codex' },
          outDir,
          header: `▌ BRIEF  codex · ${label}`
        })
      };
    };
    const a = makeJob('a');
    const b = makeJob('b');
    const [codeA, codeB] = await Promise.all([a.promise, b.promise]);
    assert.equal(codeA, 0, 'job A must complete rather than throwing "inline console died before completing job"');
    assert.equal(codeB, 0, 'job B must complete rather than throwing "inline console died before completing job"');
    assert.match(fs.readFileSync(path.join(a.outDir, 'events.jsonl'), 'utf8'), /result a/);
    assert.match(fs.readFileSync(path.join(b.outDir, 'events.jsonl'), 'utf8'), /result b/);
  } finally {
    if (old.root == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old.root;
    if (old.inline == null) delete process.env.DELEGATE_NO_WINDOW; else process.env.DELEGATE_NO_WINDOW = old.inline;
  }
});

// F4 — interrupt can kill an unrelated process group. ------------------------------------------

test('F4: interrupt refuses to signal a current.pid whose recorded command no longer matches the live process', async (t) => {
  if (process.platform !== 'linux') { t.skip('ownership verification is only implemented via /proc on Linux'); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-interrupt-stale-'));
  const old = process.env.DELEGATE_CONSOLE_DIR;
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  const directory = path.join(temp, 'consoles', 'interrupt-stale-window');
  fs.mkdirSync(directory, { recursive: true });
  const other = nodeSpawn('sleep', ['5'], { detached: true, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      other.once('spawn', resolve);
      other.once('error', reject);
    });
    // Recorded cmd deliberately does not match the actual `sleep` process — simulates current.pid
    // being stale (job already finished, pid since reused by an unrelated process).
    fs.writeFileSync(path.join(directory, 'current.pid'), JSON.stringify({ pid: other.pid, startedAt: Date.now(), cmd: 'totally-unrelated-binary-xyz' }));

    await interrupt('interrupt-stale-window');
    assert.doesNotThrow(() => process.kill(other.pid, 0), 'interrupt must not kill a process whose cmdline does not match the recorded cmd');
  } finally {
    try { process.kill(-other.pid, 'SIGKILL'); } catch {}
    if (old == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old;
  }
});

test('F4: interrupt still kills the legitimate current job when current.pid matches the live process', async (t) => {
  if (process.platform === 'win32') { t.skip('unix process-group signal semantics'); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-interrupt-legit-'));
  const old = process.env.DELEGATE_CONSOLE_DIR;
  process.env.DELEGATE_CONSOLE_DIR = path.join(temp, 'consoles');
  const directory = path.join(temp, 'consoles', 'interrupt-legit-window');
  fs.mkdirSync(directory, { recursive: true });
  const child = nodeSpawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    fs.writeFileSync(path.join(directory, 'current.pid'), JSON.stringify({ pid: child.pid, startedAt: Date.now(), cmd: 'sleep' }));

    await interrupt('interrupt-legit-window');

    let dead = false;
    for (let i = 0; i < 40; i++) {
      try { process.kill(child.pid, 0); } catch { dead = true; break; }
      await wait(50);
    }
    assert.ok(dead, 'interrupt must still kill the legitimate, matching current job');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    if (old == null) delete process.env.DELEGATE_CONSOLE_DIR; else process.env.DELEGATE_CONSOLE_DIR = old;
  }
});
