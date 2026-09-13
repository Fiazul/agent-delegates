'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SKILLS, install } = require('../lib/install');
const { checkedSpawn, commandExists, defaultInstall, setupVendorClis, VENDORS } = require('../lib/vendor-setup');
const { main, parseOptions } = require('../bin/cli');

test('install uses HOME and creates all five skill links in both runtimes', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.writeFileSync(path.join(fakeHome, '.bashrc'), '# test\n');
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    await install({ statusline: true, skipCliInstall: true, log() {} });
    for (const runtime of ['.claude', '.agents']) for (const skill of SKILLS) {
      const target = path.join(fakeHome, runtime, 'skills', skill);
      assert.equal(fs.lstatSync(target).isSymbolicLink(), true, target);
    }
    assert.match(fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf8'), /alias delegates=.*bin\/cli\.js/);
    for (const skill of SKILLS) assert.ok(fs.existsSync(path.join(fakeHome, '.agents', 'skills', skill, 'SKILL.md')));
    const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
    assert.match(settings.statusLine.command, /agent-delegates-statusline\.js/);
  } finally {
    if (oldHome == null) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  }
});

test('vendor setup prompts per missing CLI and skips declined installers', async () => {
  const log = [];
  const installs = [];
  const result = await setupVendorClis({
    commandExists: name => name === 'codex',
    prompt: async () => false,
    install: async vendor => installs.push(vendor.id),
    log: line => log.push(line),
    platform: 'linux',
    isTTY: true,
  });
  assert.deepEqual(installs, []);
  assert.equal(result.ready, false);
  assert.deepEqual(result.existing, ['codex']);
  assert.deepEqual(result.skipped, ['agy', 'grok', 'claude']);
  assert.match(log.join('\n'), /https:\/\/antigravity\.google\/cli\/install\.sh/);
});

test('vendor setup installs after an interactive yes answer', async () => {
  const installed = new Set(['agy', 'grok', 'claude']);
  const prompts = [];
  const result = await setupVendorClis({
    commandExists: name => installed.has(name),
    prompt: async question => { prompts.push(question); return true; },
    install: async vendor => installed.add(vendor.command),
    log() {}, platform: 'linux', isTTY: true,
  });
  assert.deepEqual(prompts, ['Install codex? [y/N] ']);
  assert.deepEqual(result.installed, ['codex']);
  assert.equal(result.ready, true);
});

test('vendor setup --yes installs missing CLIs and verifies them afterwards', async () => {
  const installed = new Set(['codex']);
  const result = await setupVendorClis({
    yes: true,
    commandExists: name => installed.has(name),
    install: async vendor => installed.add(vendor.command),
    log() {},
    platform: 'linux',
    isTTY: false,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.installed, ['agy', 'grok', 'claude']);
});

test('vendor setup does not install in non-TTY mode without --yes', async () => {
  const attempted = [];
  const result = await setupVendorClis({
    commandExists: () => false,
    install: async vendor => attempted.push(vendor.id),
    log() {},
    platform: 'linux',
    isTTY: false,
  });
  assert.deepEqual(attempted, []);
  assert.equal(result.ready, false);
  assert.deepEqual(result.skipped, ['codex', 'agy', 'grok', 'claude']);
});

test('vendor setup surfaces installer and post-install verification failures', async () => {
  await assert.rejects(() => setupVendorClis({
    yes: true, commandExists: () => false,
    install: async () => { throw new Error('download failed'); },
    log() {}, platform: 'linux', isTTY: false,
  }), /download failed/);
  await assert.rejects(() => setupVendorClis({
    yes: true, commandExists: () => false,
    install: async () => {},
    log() {}, platform: 'linux', isTTY: false,
  }), /not found after installation/);
});

test('Windows Grok and unsupported OS use manual guidance without an installer', async () => {
  const installed = new Set();
  const windows = await setupVendorClis({
    platform: 'win32', yes: true, commandExists: name => installed.has(name),
    install: async vendor => installed.add(vendor.command), log() {}, isTTY: false,
  });
  assert.ok(windows.skipped.includes('grok'));
  assert.deepEqual(windows.installed, ['codex', 'agy', 'claude']);
  let unsupportedInstallerCalled = false;
  const unsupported = await setupVendorClis({
    platform: 'sunos', yes: true, commandExists: () => false,
    install: async () => { unsupportedInstallerCalled = true; }, log() {}, isTTY: false,
  });
  assert.equal(unsupportedInstallerCalled, false);
  assert.deepEqual(unsupported.skipped, ['codex', 'agy', 'grok', 'claude']);
  await assert.rejects(() => defaultInstall(VENDORS[1], 'sunos'), /Unsupported OS/);
});

test('command detection scans a supplied PATH and spawn failures are surfaced', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-bin-'));
  const fixture = path.join(fixtureDir, 'fixture-cli');
  fs.writeFileSync(fixture, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(commandExists('fixture-cli', process.platform, { PATH: fixtureDir }), true);
  assert.equal(commandExists('missing-cli', process.platform, { PATH: fixtureDir }), false);
  assert.throws(() => checkedSpawn('agent-delegates-definitely-missing-command', []), /ENOENT/);
});

test('install skips CLI checks when requested and uninstall never invokes setup', async () => {
  let checks = 0;
  await install({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-')), skipCliInstall: true, setupVendorClis: async () => { checks++; }, log() {} });
  await install({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-')), uninstall: true, setupVendorClis: async () => { checks++; }, log() {} });
  assert.equal(checks, 0);
});

test('CLI awaits install and propagates an installer failure as a nonzero exit', async () => {
  const before = process.exitCode;
  process.exitCode = 0;
  await main(['install', '--yes'], { install: async () => { throw new Error('spawn failed'); } });
  assert.equal(process.exitCode, 2);
  process.exitCode = before;
});

test('install flags parse as booleans', () => {
  assert.deepEqual(parseOptions(['--yes', '--skip-cli-install']).options, { addDir: [], yes: true, skipCliInstall: true });
});

test('real readline prompt accepts yes before closing the interface', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const { setupVendorClis } = require('./lib/vendor-setup');
    const installed = new Set(['agy', 'grok', 'claude']);
    setupVendorClis({
      isTTY: true,
      commandExists: name => installed.has(name),
      install: async vendor => installed.add(vendor.id),
    }).then(result => {
      if (!result.installed.includes('codex')) process.exitCode = 1;
    }).catch(() => { process.exitCode = 2; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), input: 'yes\n', encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /codex: installed/);
});
