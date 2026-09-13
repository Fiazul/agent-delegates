'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SKILLS, install } = require('../lib/install');

test('install uses HOME and creates all five skill links in both runtimes', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.writeFileSync(path.join(fakeHome, '.bashrc'), '# test\n');
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    install({ statusline: true, log() {} });
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
