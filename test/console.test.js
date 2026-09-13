'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { submitJob } = require('../lib/console');

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
