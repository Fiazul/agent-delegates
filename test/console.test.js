'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runConsole, submitJob } = require('../lib/console');

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
