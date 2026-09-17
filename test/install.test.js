'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { SKILLS, hookStub, install, installHook, uninstallHook, copyPackageToInstallHome, pkgDir, installCommandShims, removeCommandShims, isOurShim, posixBinDir } = require('../lib/install');
const { installHome } = require('../lib/util');
const { checkedSpawn, commandExists, defaultInstall, setupVendorClis, VENDORS } = require('../lib/vendor-setup');
const { main, parseOptions } = require('../bin/cli');

test('install uses HOME and creates skill links in Claude, codex, and Cursor', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.writeFileSync(path.join(fakeHome, '.bashrc'), '# test\n');
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    // No CODEX_HOME set here -> codex's skill dir must default to ~/.codex/skills, matching
    // `codex --help`'s documented default, not the old (wrong) ~/.agents/skills.
    await install({ main: 'all', skipCliInstall: true, commandExists: () => true, env: {}, log() {} });
    for (const runtime of ['.claude', '.codex', '.cursor']) for (const skill of SKILLS) {
      const target = path.join(fakeHome, runtime, 'skills', skill);
      assert.equal(fs.lstatSync(target).isSymbolicLink(), true, target);
    }
    assert.equal(fs.existsSync(path.join(fakeHome, '.agents', 'skills')), false);
    // New installs no longer touch .bashrc/.zshrc with a `delegates` alias (H3): the alias is
    // useless in non-interactive shells and every future artifact must resolve without one.
    assert.doesNotMatch(fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf8'), /alias delegates=/);
    for (const skill of SKILLS) assert.ok(fs.existsSync(path.join(fakeHome, '.codex', 'skills', skill, 'SKILL.md')));
    // Skills resolve into the copied install-home package, never the transient packageRoot().
    const skillLinkTarget = fs.readlinkSync(path.join(fakeHome, '.codex', 'skills', SKILLS[0]));
    assert.equal(path.resolve(path.dirname(path.join(fakeHome, '.codex', 'skills', SKILLS[0])), skillLinkTarget), path.join(pkgDir(fakeHome), 'skills', SKILLS[0]));
    // A POSIX command shim exists on a stable, non-transient path.
    const shim = path.join(posixBinDir(fakeHome), 'agent-delegates');
    assert.equal(fs.existsSync(shim), true);
    assert.match(fs.readFileSync(shim, 'utf8'), new RegExp(pkgDir(fakeHome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
    assert.match(settings.statusLine.command, /agent-delegates-statusline\.js/);
  } finally {
    if (oldHome == null) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  }
});

test('install: statusline and hook are on by default; --no-statusline/--no-hook opt out', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await install({ skipCliInstall: true, commandExists: () => true, log() {} });
    const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.match(settings.statusLine.command, /agent-delegates-statusline\.js/);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /agent-delegates-nudge\.js/);
    assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'agent-delegates-nudge.js')), true);
  } finally {
    if (oldHome == null) delete process.env.HOME; else process.env.HOME = oldHome;
  }
});

test('install --main codex: links only ~/.codex/skills (default CODEX_HOME), never ~/.agents/skills', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  await install({
    home: fakeHome, main: 'codex', skipCliInstall: true, commandExists: () => true, env: {}, log: line => log.push(line)
  });
  for (const skill of SKILLS) {
    assert.equal(fs.lstatSync(path.join(fakeHome, '.codex', 'skills', skill)).isSymbolicLink(), true);
  }
  assert.equal(fs.existsSync(path.join(fakeHome, '.agents', 'skills')), false);
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'skills')), false);
  assert.equal(fs.existsSync(path.join(fakeHome, '.cursor', 'skills')), false);
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'agent-delegates-nudge.js')), false);
  assert.ok(log.some(line => /Skipping statusline\/hook/.test(line)));
});

test('install --main codex: honors CODEX_HOME when set, linking there instead of ~/.codex/skills', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  await install({
    home: fakeHome, main: 'codex', skipCliInstall: true, commandExists: () => true,
    env: { CODEX_HOME: codexHome }, log() {}
  });
  for (const skill of SKILLS) {
    assert.equal(fs.lstatSync(path.join(codexHome, 'skills', skill)).isSymbolicLink(), true);
  }
  assert.equal(fs.existsSync(path.join(fakeHome, '.codex', 'skills')), false);
  assert.equal(fs.existsSync(path.join(fakeHome, '.agents', 'skills')), false);
});

test('install --uninstall: sweeps the legacy ~/.agents/skills codex dir from a pre-fix install, plus current dirs', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  // Simulate a pre-fix install: codex skill links live under the old ~/.agents/skills, pointing
  // into our own pkgDir(home) — the sweep must remove these even though nothing currently
  // installs there.
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, env: {}, log() {} });
  const legacyRoot = path.join(fakeHome, '.agents', 'skills');
  fs.mkdirSync(legacyRoot, { recursive: true });
  for (const skill of SKILLS) {
    fs.symlinkSync(path.join(pkgDir(fakeHome), 'skills', skill), path.join(legacyRoot, skill), 'dir');
  }
  await install({ home: fakeHome, uninstall: true, log() {} });
  for (const skill of SKILLS) {
    assert.equal(fs.existsSync(path.join(legacyRoot, skill)), false);
    assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'skills', skill)), false);
  }
});

test('removeManagedLink guard (via uninstall): a same-named symlink pointing outside our pkgDir is left alone', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, env: {}, log() {} });
  // Replace one managed link with a foreign symlink pointing elsewhere entirely.
  const foreignTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-skill-'));
  const linkPath = path.join(fakeHome, '.claude', 'skills', SKILLS[0]);
  fs.unlinkSync(linkPath);
  fs.symlinkSync(foreignTarget, linkPath, 'dir');
  await install({ home: fakeHome, uninstall: true, log() {} });
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(linkPath), foreignTarget);
});

test('install --main cursor: links only ~/.cursor/skills', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({ home: fakeHome, main: 'cursor', skipCliInstall: true, commandExists: () => true, log() {} });
  for (const skill of SKILLS) {
    assert.equal(fs.lstatSync(path.join(fakeHome, '.cursor', 'skills', skill)).isSymbolicLink(), true);
  }
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'skills')), false);
  assert.equal(fs.existsSync(path.join(fakeHome, '.agents', 'skills')), false);
});

test('install: invalid --main value throws', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await assert.rejects(
    () => install({ home: fakeHome, main: 'bogus', skipCliInstall: true, log() {} }),
    /--main must be one of claude, codex, cursor, all/
  );
});

test('install: main CLI missing -> clear error, exit path, nothing written', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await assert.rejects(
    () => install({ home: fakeHome, main: 'codex', skipCliInstall: true, commandExists: () => false, log() {} }),
    /Main orchestrator CLI 'codex'.*not installed/
  );
  assert.equal(fs.existsSync(path.join(fakeHome, '.agents', 'skills')), false);
});

test("install --delegates agy,codex: writes routing.json priority in that order and only offers those two vendors", async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  let offeredIds = null;
  await install({
    home: fakeHome, main: 'claude', delegates: 'agy,codex', commandExists: () => true,
    setupVendorClis: async options => { offeredIds = options.vendorIds; },
    log() {}
  });
  assert.deepEqual(offeredIds, ['agy', 'codex']);
  const routingFile = path.join(fakeHome, '.config', 'delegates', 'routing.json');
  const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
  assert.deepEqual(routing.priority, ['agy', 'codex']);
});

test('install --delegates: preserves other existing keys already in routing.json', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const routingDir = path.join(fakeHome, '.config', 'delegates');
  fs.mkdirSync(routingDir, { recursive: true });
  fs.writeFileSync(path.join(routingDir, 'routing.json'), JSON.stringify({ mode: 'fixed', threshold: 55 }));

  await install({ home: fakeHome, main: 'claude', delegates: 'grok,claude', commandExists: () => true, setupVendorClis: async () => {}, log() {} });

  const routing = JSON.parse(fs.readFileSync(path.join(routingDir, 'routing.json'), 'utf8'));
  assert.equal(routing.mode, 'fixed');
  assert.equal(routing.threshold, 55);
  assert.deepEqual(routing.priority, ['grok', 'claude']);
});

test('install: non-interactive (no flags, no TTY) uses defaults (main claude, delegates agy/codex/grok) and never writes priority', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  let offeredIds = null;
  await install({
    home: fakeHome, isTTY: false, commandExists: () => true, env: { PATH: '' },
    setupVendorClis: async options => { offeredIds = options.vendorIds; },
    log: line => log.push(line)
  });
  assert.deepEqual(offeredIds, ['agy', 'codex', 'grok']);
  for (const skill of SKILLS) assert.equal(fs.lstatSync(path.join(fakeHome, '.claude', 'skills', skill)).isSymbolicLink(), true);
  // routing.json now legitimately gets created by bins resolution (lib/bins.js always resolves
  // *something* for agy/codex/grok) — what must NOT happen on the silent default path is a
  // `priority` key, since that's reserved for an explicit Q2 answer or --delegates.
  let routing = {};
  try { routing = JSON.parse(fs.readFileSync(path.join(fakeHome, '.config', 'delegates', 'routing.json'), 'utf8')); } catch {}
  assert.equal(routing.priority, undefined);
  assert.ok(log.some(line => /Non-interactive: using defaults/.test(line)));
});

test('install: TTY wizard answers Q1/Q2 via injected promptText and writes priority from Q2', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const questions = [];
  let offeredIds = null;
  await install({
    home: fakeHome, isTTY: true, commandExists: () => true, env: { PATH: '' },
    promptText: async question => {
      questions.push(question);
      if (question.includes('main orchestrator')) return '1';
      if (question.includes('Which delegates')) return '2 3';
      return '';
    },
    setupVendorClis: async options => { offeredIds = options.vendorIds; },
    log() {}
  });
  // Q1 + Q2 only — codex/grok (from Q2) never involve cursor, so the agent-conflict/alias
  // prompts (which only fire once cursor+grok are both selected) never trigger here.
  assert.equal(questions.length, 2);
  assert.deepEqual(offeredIds, ['codex', 'grok']);
  const routing = JSON.parse(fs.readFileSync(path.join(fakeHome, '.config', 'delegates', 'routing.json'), 'utf8'));
  assert.deepEqual(routing.priority, ['codex', 'grok']);
});

test('install: prints an authenticate checklist for the selected delegates', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'codex,grok', commandExists: () => true,
    setupVendorClis: async () => {}, log: line => log.push(line)
  });
  assert.ok(log.some(line => /Next: authenticate/.test(line) && line.includes('codex login') && line.includes('grok')));
});

test("install --uninstall: routing.json is left untouched", async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const routingDir = path.join(fakeHome, '.config', 'delegates');
  fs.mkdirSync(routingDir, { recursive: true });
  fs.writeFileSync(path.join(routingDir, 'routing.json'), JSON.stringify({ priority: ['claude'] }));
  await install({ home: fakeHome, uninstall: true, log() {} });
  const routing = JSON.parse(fs.readFileSync(path.join(routingDir, 'routing.json'), 'utf8'));
  assert.deepEqual(routing.priority, ['claude']);
});

// --- lib/bins.js integration (Cursor/Grok `agent` collision, resolved bins, opt-in aliases) ---
// lib/bins.js is another worker's concurrent addition; these tests inject detectAgentCollision/
// resolveBin directly rather than depending on the real module (per brief: "if lib/bins.js is
// absent at your test time, stub it via injection").

// A fixture pair simulating exactly Grok's real layout: `agent` is a symlink duplicate of
// `grok` in the same directory (safe to remove); Cursor's `agent` is its own regular launcher
// file (never touched). Both `resolveBinAsync`/`detectAgentCollision` here are still injected
// (per brief: stub via injection rather than depending on the real module), but the underlying
// files are real so findRemovableDuplicates' fs.lstatSync/realpathSync calls behave exactly as
// they would against a genuine installation.
// order: 'cursor-first' (default) puts Cursor's own `agent` first on PATH — the effective
// `agent` is correct, so this is NOT a conflict (at most a NOTE line about the shadowed Grok
// duplicate). 'grok-first' puts Grok's duplicate first — Cursor's `agent` is actually shadowed,
// which IS the real conflict `install` should warn/prompt about.
function makeAgentFixtures(order = 'cursor-first') {
  const cursorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-cursor-bin-'));
  const grokDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-grok-bin-'));
  const cursorAgent = path.join(cursorDir, 'agent');
  fs.writeFileSync(cursorAgent, '#!/bin/sh\necho cursor\n', { mode: 0o755 }); // regular file, own launcher
  const grokBin = path.join(grokDir, 'grok');
  fs.writeFileSync(grokBin, '#!/bin/sh\necho grok\n', { mode: 0o755 });
  const grokAgent = path.join(grokDir, 'agent');
  fs.symlinkSync(grokBin, grokAgent); // duplicate symlink of grok's own binary
  const cursorHit = { path: cursorAgent, realpath: cursorAgent, owner: 'cursor' };
  const grokHit = { path: grokAgent, realpath: grokBin, owner: 'grok' };
  return {
    cursorAgent, grokAgent, grokBin,
    collisions: order === 'grok-first' ? [grokHit, cursorHit] : [cursorHit, grokHit]
  };
}

function fixedResolveBin(vendor) {
  return { command: `/resolved/${vendor}`, source: 'path', verified: true };
}

test('install: cursor-only "agent" (single owner) -> no CONFLICT block, no prompt', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { cursorAgent } = makeAgentFixtures();
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => [{ path: cursorAgent, realpath: cursorAgent, owner: 'cursor' }],
    resolveBin: async vendor => fixedResolveBin(vendor),
    log: line => log.push(line)
  });
  assert.ok(!log.some(line => /CONFLICT/.test(line)));
});

test('install: grok not selected (even with two real owners on PATH) -> no prompt, but bins still written for selected vendors', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { collisions } = makeAgentFixtures();
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions, // both owners exist on PATH, but grok isn't selected
    resolveBin: async vendor => fixedResolveBin(vendor),
    log: line => log.push(line)
  });
  assert.ok(!log.some(line => /CONFLICT/.test(line)));
  const routing = JSON.parse(fs.readFileSync(path.join(fakeHome, '.config', 'delegates', 'routing.json'), 'utf8'));
  assert.equal(routing.bins.cursor, '/resolved/cursor');
});

test('install: Cursor\'s "agent" resolves first, Grok\'s is a shadowed duplicate -> no CONFLICT, one NOTE line, nothing touched', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { cursorAgent, grokAgent, collisions } = makeAgentFixtures('cursor-first');
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: true, commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions,
    resolveBin: async vendor => fixedResolveBin(vendor),
    promptText: async question => {
      if (question.includes('Apply this rename')) throw new Error('must never prompt when the effective agent is already Cursor');
      return 'n'; // unrelated prompts (e.g. shell aliases) are fine
    },
    log: line => log.push(line)
  });
  assert.ok(!log.some(line => /CONFLICT/.test(line)));
  assert.ok(log.some(line => line.includes('NOTE:') && line.includes('resolves to Cursor') && line.includes(grokAgent)));
  assert.equal(fs.existsSync(grokAgent), true);
  assert.equal(fs.existsSync(cursorAgent), true);
  assert.equal(fs.existsSync(`${grokAgent}.agent-delegates-bak`), false);
});

test('install: both selected + two owners, conflict pre-existed -> CONFLICT block with "two tools" wording; decline leaves everything untouched', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { cursorAgent, grokAgent, grokBin, collisions } = makeAgentFixtures('grok-first');
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: true, commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions, // same before and after -> "pre-existed"
    resolveBin: async vendor => fixedResolveBin(vendor),
    promptText: async question => (question.includes('Apply this rename') ? 'n' : ''),
    log: line => log.push(line)
  });
  assert.ok(log.some(line => line.includes('CONFLICT: two tools on this system both provide a command named "agent"')));
  assert.ok(log.some(line => line.includes(cursorAgent) && line.includes('Cursor')));
  assert.ok(log.some(line => line.includes(grokAgent) && line.includes('Grok')));
  assert.ok(log.some(line => line.includes(`would remove: ${grokAgent}`) && line.includes(grokBin)));
  assert.ok(!log.some(line => line.includes(`would remove: ${cursorAgent}`))); // regular file: never proposed
  assert.ok(log.some(line => /Left as is\. Delegated runs are unaffected/.test(line)));
  assert.equal(fs.existsSync(grokAgent), true); // decline -> nothing moved
  assert.equal(fs.existsSync(cursorAgent), true);
  assert.equal(fs.existsSync(`${grokAgent}.agent-delegates-bak`), false);
});

test('install: accepting the prompt moves the duplicate symlink to a reversible .bak, keeps the regular file', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { cursorAgent, grokAgent, grokBin, collisions } = makeAgentFixtures('grok-first');
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: true, commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions,
    resolveBin: async vendor => fixedResolveBin(vendor),
    promptText: async question => (question.includes('Apply this rename') ? 'y' : ''),
    log() {}
  });
  assert.equal(fs.existsSync(grokAgent), false); // moved away
  const backup = `${grokAgent}.agent-delegates-bak`;
  assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.realpathSync(backup), grokBin); // reversible: still the same real binary
  assert.equal(fs.existsSync(cursorAgent), true); // regular file: untouched throughout
});

test('install: non-TTY without --resolve-agent-conflict -> prints the block, applies nothing', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { grokAgent, collisions } = makeAgentFixtures('grok-first');
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: false, commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions,
    resolveBin: async vendor => fixedResolveBin(vendor),
    log: line => log.push(line)
  });
  assert.ok(log.some(line => /CONFLICT/.test(line)));
  assert.ok(log.some(line => /would remove/.test(line)));
  assert.equal(fs.existsSync(grokAgent), true); // never applied without the flag
});

test('install: --resolve-agent-conflict yes applies non-interactively', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { grokAgent, collisions } = makeAgentFixtures('grok-first');
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: false, resolveAgentConflict: 'yes', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions,
    resolveBin: async vendor => fixedResolveBin(vendor),
    log() {}
  });
  assert.equal(fs.existsSync(grokAgent), false);
  assert.equal(fs.existsSync(`${grokAgent}.agent-delegates-bak`), true);
});

test('install: unknown-owner collision entries are never touched even when cursor+grok also present (grok shadows cursor)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { collisions } = makeAgentFixtures('grok-first');
  const unknownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-unknown-bin-'));
  const unknownBin = path.join(unknownDir, 'something-else');
  fs.writeFileSync(unknownBin, '#!/bin/sh\n', { mode: 0o755 });
  const unknownAgent = path.join(unknownDir, 'agent');
  fs.symlinkSync(unknownBin, unknownAgent);
  const allCollisions = [...collisions, { path: unknownAgent, realpath: unknownBin, owner: 'unknown' }];

  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: false, resolveAgentConflict: 'yes', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => allCollisions,
    resolveBin: async vendor => fixedResolveBin(vendor),
    log() {}
  });
  assert.equal(fs.existsSync(unknownAgent), true); // untouched regardless of --resolve-agent-conflict yes
});

// Scenario 5: an unrecognized binary shadows Cursor's `agent` — still a real conflict (Cursor's
// own `agent` isn't winning PATH resolution either way), but the proposed fix must never touch
// the unrecognized file, only Grok's own removable duplicate elsewhere in the list.
test('install: unknown owner shadows Cursor\'s agent -> CONFLICT block; unknown file is never a removal candidate', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { cursorAgent, collisions } = makeAgentFixtures('cursor-first');
  const unknownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-unknown-bin-'));
  const unknownBin = path.join(unknownDir, 'something-else');
  fs.writeFileSync(unknownBin, '#!/bin/sh\n', { mode: 0o755 });
  const unknownAgent = path.join(unknownDir, 'agent');
  fs.symlinkSync(unknownBin, unknownAgent);
  const cursorHit = collisions.find(c => c.owner === 'cursor');
  const orderedCollisions = [{ path: unknownAgent, realpath: unknownBin, owner: 'unknown' }, cursorHit];
  const log = [];

  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: false, resolveAgentConflict: 'yes', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => orderedCollisions,
    resolveBin: async vendor => fixedResolveBin(vendor),
    log: line => log.push(line)
  });
  assert.ok(log.some(line => /CONFLICT/.test(line)));
  assert.ok(!log.some(line => line.includes(`would remove: ${unknownAgent}`)));
  assert.equal(fs.existsSync(unknownAgent), true); // never touched
  assert.equal(fs.existsSync(cursorAgent), true);
});

test('install: wording is "installing <vendor> added a second agent launcher" when the conflict is new (post-install only)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { collisions } = makeAgentFixtures('grok-first');
  const cursorOnly = collisions.filter(c => c.owner === 'cursor');
  const log = [];
  let calls = 0;
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: false, commandExists: () => true,
    setupVendorClis: async () => {},
    // Before the vendor-install step: only cursor's `agent` exists. After: grok's appeared too,
    // ahead of cursor's on PATH (as if `setupVendorClis` had just installed Grok in front of it)
    // — this is what actually makes it a conflict, not merely grok's presence.
    detectAgentCollision: async () => { calls++; return calls === 1 ? cursorOnly : collisions; },
    resolveBin: async vendor => fixedResolveBin(vendor),
    log: line => log.push(line)
  });
  assert.ok(log.some(line => line.includes('CONFLICT: installing Grok added a second "agent" launcher')));
});

test('install: wording is "two tools ... already" when the conflict existed before this run', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { collisions } = makeAgentFixtures('grok-first');
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: false, commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions, // identical before and after -> pre-existed
    resolveBin: async vendor => fixedResolveBin(vendor),
    log: line => log.push(line)
  });
  assert.ok(log.some(line => line.includes('CONFLICT: two tools on this system both provide a command named "agent"')));
});

test('install: an existing bins.<vendor> pointing at a file that still exists is preserved, not re-resolved', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const routingDir = path.join(fakeHome, '.config', 'delegates');
  fs.mkdirSync(routingDir, { recursive: true });
  const keptPath = path.join(fakeHome, 'kept-cursor-binary');
  fs.writeFileSync(keptPath, '#!/bin/sh\n');
  fs.writeFileSync(path.join(routingDir, 'routing.json'), JSON.stringify({ bins: { cursor: keptPath } }));

  const resolveBinCalls = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => [],
    resolveBin: async vendor => { resolveBinCalls.push(vendor); return fixedResolveBin(vendor); },
    log() {}
  });
  assert.ok(!resolveBinCalls.includes('cursor')); // preserved, never re-resolved
  assert.ok(resolveBinCalls.includes('grok'));
  const routing = JSON.parse(fs.readFileSync(path.join(routingDir, 'routing.json'), 'utf8'));
  assert.equal(routing.bins.cursor, keptPath); // untouched
  assert.equal(routing.bins.grok, '/resolved/grok');
});

test('install: bin aliases are written only when explicitly opted in (--aliases yes)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.writeFileSync(path.join(fakeHome, '.bashrc'), '# test\n');

  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => [],
    resolveBin: async vendor => fixedResolveBin(vendor),
    log() {}
  });
  let bashrc = fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf8');
  assert.doesNotMatch(bashrc, /alias cursor-agent=/);
  assert.doesNotMatch(bashrc, /alias grok=/);

  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', aliases: 'yes', commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => [],
    resolveBin: async vendor => fixedResolveBin(vendor),
    log() {}
  });
  bashrc = fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf8');
  assert.match(bashrc, /# agent-delegates\nalias cursor-agent=/);
  assert.match(bashrc, /# agent-delegates\nalias grok=/);

  await install({ home: fakeHome, uninstall: true, log() {} });
  bashrc = fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf8');
  assert.doesNotMatch(bashrc, /alias cursor-agent=/);
  assert.doesNotMatch(bashrc, /alias grok=/);
});

// M4: appendBinAliases must be idempotent — re-running `install --aliases yes` (e.g. after a
// bins.cursor/bins.grok path changes) used to append a second duplicate pair of alias lines
// instead of replacing the first.
test('install: --aliases yes twice leaves exactly one alias pair, not a duplicate (M4)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.writeFileSync(path.join(fakeHome, '.bashrc'), '# test\n');

  for (let i = 0; i < 2; i++) {
    await install({
      home: fakeHome, main: 'claude', delegates: 'cursor,grok', aliases: 'yes', commandExists: () => true,
      setupVendorClis: async () => {},
      detectAgentCollision: async () => [],
      resolveBin: async vendor => fixedResolveBin(vendor),
      log() {}
    });
  }
  const bashrc = fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf8');
  const cursorMatches = bashrc.match(/alias cursor-agent=/g) || [];
  const grokMatches = bashrc.match(/alias grok=/g) || [];
  assert.equal(cursorMatches.length, 1, `expected exactly one cursor-agent alias, got ${cursorMatches.length}`);
  assert.equal(grokMatches.length, 1, `expected exactly one grok alias, got ${grokMatches.length}`);
  const markerMatches = bashrc.match(/# agent-delegates/g) || [];
  assert.equal(markerMatches.length, 2, `expected exactly one marker per alias (2 total), got ${markerMatches.length}`);
});

// L3: resolveBin's `config` param is the bins MAP itself (vendor -> path), not the whole
// routing.json object. Passing the whole object made every `bins[vendor]` lookup inside
// resolveBin look for e.g. wholeConfig.grok (never set) instead of wholeConfig.bins.grok, so an
// existing (even stale/unverified) routing.json override was silently ignored in favor of a
// fresh PATH lookup — using the REAL lib/bins.js here (no resolveBin override) so the bug in the
// actual call site would have been caught.
test('install: an existing (stale) bins.grok config override is honored over a real PATH match (L3)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const routingDir = path.join(fakeHome, '.config', 'delegates');
  fs.mkdirSync(routingDir, { recursive: true });
  const staleConfiguredPath = path.join(fakeHome, 'stale-grok-path-does-not-exist');
  fs.writeFileSync(path.join(routingDir, 'routing.json'), JSON.stringify({ bins: { grok: staleConfiguredPath } }));

  // A REAL grok binary also sits on PATH — if the config override is ignored (the L3 bug), this
  // is what resolveBin would wrongly return instead.
  const pathGrokDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-real-grok-bin-'));
  fs.writeFileSync(path.join(pathGrokDir, 'grok'), '#!/bin/sh\necho grok\n', { mode: 0o755 });

  await install({
    home: fakeHome, main: 'claude', delegates: 'grok', commandExists: () => true,
    setupVendorClis: async () => {}, env: { PATH: pathGrokDir },
    log() {}
  });
  const routing = JSON.parse(fs.readFileSync(path.join(routingDir, 'routing.json'), 'utf8'));
  assert.equal(routing.bins.grok, staleConfiguredPath, 'the configured override must win over a PATH match');
});

test('install: with the real lib/bins.js and no PATH matches, still succeeds and writes bare-name bins', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({
    home: fakeHome, main: 'claude', delegates: 'agy', commandExists: () => true, env: { PATH: '' },
    setupVendorClis: async () => {}, log() {}
  });
  const routing = JSON.parse(fs.readFileSync(path.join(fakeHome, '.config', 'delegates', 'routing.json'), 'utf8'));
  assert.equal(routing.bins.agy, 'agy'); // no PATH match -> falls back to the bare command name
});

// H1: Cursor's real command is `cursor-agent`, not the bare `agent` MAIN_COMMAND/vendor-setup
// used to hardcode. `--main cursor`'s "is it installed" check now goes through the real
// lib/bins.js resolveBin (no override injected here) so it agrees with every other cursor
// resolution path, including a well-known-dir/env/config override — not just a literal PATH hit.
test('install --main cursor: succeeds with only cursor-agent on PATH (real lib/bins.js, H1)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-cursor-only-bin-'));
  fs.writeFileSync(path.join(binDir, 'cursor-agent'), '#!/bin/sh\necho cursor\n', { mode: 0o755 });

  await assert.doesNotReject(() => install({
    home: fakeHome, main: 'cursor', skipCliInstall: true, env: { PATH: binDir },
    log() {}
  }));
});

test('install --main cursor: no commandExists override and no cursor-agent anywhere -> clear "not installed" error (H1)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-empty-bin-'));
  await assert.rejects(
    () => install({ home: fakeHome, main: 'cursor', skipCliInstall: true, env: { PATH: emptyBin }, log() {} }),
    /Main orchestrator CLI 'cursor-agent' \(--main cursor\) is not installed/
  );
});

// H1: with only Grok's `agent` on PATH (no cursor-agent anywhere), vendor-setup's "does cursor
// exist" check must refuse to treat Grok's binary as Cursor — it must report cursor-agent
// missing, exactly like `--main cursor`'s check does via the same resolveBin path.
test('install --delegates cursor: only Grok\'s agent on PATH -> vendor setup reports cursor-agent missing, not found (H1)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const grokBinDir = path.join(fakeHome, '.grok-fixture', 'bin');
  const grokReal = path.join(fakeHome, '.grok-fixture', 'downloads', 'grok-1.0.24-linux-x86_64');
  fs.mkdirSync(path.dirname(grokReal), { recursive: true });
  fs.writeFileSync(grokReal, '#!/bin/sh\necho grok\n', { mode: 0o755 });
  fs.mkdirSync(grokBinDir, { recursive: true });
  fs.symlinkSync(grokReal, path.join(grokBinDir, 'agent'));
  fs.symlinkSync(grokReal, path.join(grokBinDir, 'grok'));

  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor', env: { PATH: grokBinDir },
    log: line => log.push(line)
  });
  assert.ok(log.some(line => /cursor-agent: missing\./.test(line)), JSON.stringify(log));
  assert.ok(!log.some(line => /cursor-agent: found\./.test(line)));
});

test('installHook: fresh install adds our hook entry, stub requires package by absolute path', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  installHook(fakeHome, line => log.push(line));
  const stub = fs.readFileSync(path.join(fakeHome, '.claude', 'agent-delegates-nudge.js'), 'utf8');
  assert.match(stub, /require\(.*extras[\\/]delegate-nudge\.js.*\)/);
  const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Agent|Bash');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /agent-delegates-nudge\.js" pre-tool$/);
});

test('installHook: existing unrelated UserPromptSubmit hook survives', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    otherKey: 'keep-me',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo unrelated-hook' }] }] }
  }));
  installHook(fakeHome, () => {});
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.otherKey, 'keep-me');
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.ok(settings.hooks.UserPromptSubmit.some(e => e.hooks[0].command === 'echo unrelated-hook'));
  assert.ok(settings.hooks.UserPromptSubmit.some(e => /agent-delegates-nudge\.js/.test(e.hooks[0].command)));
});

test('installHook: existing unrelated PreToolUse hook survives', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo unrelated-pretool' }] }] }
  }));
  installHook(fakeHome, () => {});
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.ok(settings.hooks.PreToolUse.some(e => e.hooks[0].command === 'echo unrelated-pretool'));
  assert.ok(settings.hooks.PreToolUse.some(e => /agent-delegates-nudge\.js" pre-tool$/.test(e.hooks[0].command)));
});

// H2: the stub used to `require(implPath).main(...)` with no try/catch — a stale/missing
// implPath (npx cache pruned, or a package upgrade removed the file) surfaced as an uncaught
// MODULE_NOT_FOUND stack trace on stderr, breaking the "fail-soft, never blocks the user"
// contract every other layer of this hook already honors.
test('hookStub: a missing impl path exits 0 with no stderr stack (H2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-hookstub-'));
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, hookStub(path.join(dir, 'does-not-exist.js')));
  const result = spawnSync(process.execPath, [stub], { encoding: 'utf8', timeout: 5000, input: '' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr.trim(), '');
});

// H2: the hook stub used to require extras/delegate-nudge.js straight out of the installed npm
// package — npx's package cache can be pruned between runs, breaking every future invocation.
// installHook now copies the impl file plus its small lib/ closure into
// ~/.claude/agent-delegates-nudge/, self-contained like the statusline copy.
test('installHook: copies a self-contained impl + lib/ closure into ~/.claude/agent-delegates-nudge/ (H2)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  installHook(fakeHome, () => {});
  const nudgeDir = path.join(fakeHome, '.claude', 'agent-delegates-nudge');
  const implCopy = path.join(nudgeDir, 'extras', 'delegate-nudge.js');
  assert.equal(fs.existsSync(implCopy), true);
  assert.equal(fs.existsSync(path.join(nudgeDir, 'lib', 'util.js')), true);
  assert.equal(fs.existsSync(path.join(nudgeDir, 'lib', 'policy.js')), true);
  const stub = fs.readFileSync(path.join(fakeHome, '.claude', 'agent-delegates-nudge.js'), 'utf8');
  assert.match(stub, new RegExp(implCopy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // The copy is self-contained: it must run correctly even with the real package's own
  // extras/lib deleted from require's resolution path — simplest proof is that the copy's own
  // relative requires resolve inside the copy directory, which existsSync above already showed;
  // exercise it end-to-end too.
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(fakeHome, '.claude', 'rate_limits.json'), JSON.stringify({
    ts: now, seven_day: { used_percentage: 60, resets_at: now + 6 * 86400 }, five_hour: { used_percentage: 5, resets_at: now + 4 * 3600 }
  }));
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  const stubPath = path.join(fakeHome, '.claude', 'agent-delegates-nudge.js');
  const run = spawnSync(process.execPath, [stubPath], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout.trim());
  assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

// H2: uninstallHook must remove the copy directory it created, not just the tiny stub file.
test('uninstallHook: removes the ~/.claude/agent-delegates-nudge/ copy directory too (H2)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  installHook(fakeHome, () => {});
  const nudgeDir = path.join(fakeHome, '.claude', 'agent-delegates-nudge');
  assert.equal(fs.existsSync(nudgeDir), true);
  uninstallHook(fakeHome, () => {});
  assert.equal(fs.existsSync(nudgeDir), false);
});

test('installHook: second install is idempotent (no duplicate entries, either hook)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  installHook(fakeHome, () => {});
  installHook(fakeHome, () => {});
  const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 1);
});

test('uninstallHook: removes only our entries (both hook types) and the stub file, keeps unrelated hooks', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo unrelated-hook' }] }],
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo unrelated-pretool' }] }]
    }
  }));
  installHook(fakeHome, () => {});
  uninstallHook(fakeHome, () => {});
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'echo unrelated-hook');
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo unrelated-pretool');
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'agent-delegates-nudge.js')), false);
});

test('uninstallHook: a merged entry (ours + someone else\'s command in the same hooks[] array) keeps the other command', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  installHook(fakeHome, () => {});
  // Simulate a third party (or the user) merging another command into OUR entry's hooks[] array,
  // rather than adding a separate top-level entry.
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: 'echo merged-in-command' });
  fs.writeFileSync(settingsFile, JSON.stringify(settings));

  uninstallHook(fakeHome, () => {});

  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(after.hooks.UserPromptSubmit.length, 1); // entry survives: it still has one hook
  assert.equal(after.hooks.UserPromptSubmit[0].hooks.length, 1);
  assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, 'echo merged-in-command');
});

// N2: once filtering empties an event's hooks[] array entirely, uninstallHook must delete that
// event key rather than leaving `"UserPromptSubmit": []` / `"PreToolUse": []` behind; and once
// every event key is gone, `hooks` itself must be deleted too — no empty-array/empty-object
// clutter left in settings.json.
test('uninstallHook: empties both event arrays -> both keys and hooks itself are deleted (N2)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  installHook(fakeHome, () => {});

  uninstallHook(fakeHome, () => {});

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.hooks, undefined, 'hooks object must be deleted once empty');
});

test('uninstallHook: one event empties out (deleted) while the other keeps an unrelated entry (N2)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo unrelated-pretool' }] }]
    }
  }));
  installHook(fakeHome, () => {});

  uninstallHook(fakeHome, () => {});

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit, undefined, 'emptied event key must be deleted, not left as []');
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo unrelated-pretool');
});

test('installStatusline/installHook: malformed settings.json throws a clear error before writing anything', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, '{not valid json');

  assert.throws(() => installHook(fakeHome, () => {}), /~\/\.claude\/settings\.json is not valid JSON.*--no-statusline --no-hook/);
  // Nothing should have been written: settings.json itself untouched, no stub written.
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{not valid json');
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'agent-delegates-nudge.js')), false);

  const { installStatusline } = require('../lib/install');
  assert.throws(() => installStatusline(fakeHome, () => {}), /~\/\.claude\/settings\.json is not valid JSON/);
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'agent-delegates-statusline.js')), false);
});

test('installHook: warns (but never removes) a legacy delegate-nudge.sh fixed-40% hook', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  const settingsFile = path.join(fakeHome, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/delegate-nudge.sh' }] }] }
  }));

  const log = [];
  installHook(fakeHome, line => log.push(line));

  assert.ok(log.some(line => /WARNING: legacy delegate-nudge\.sh hook found/.test(line)));
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  // Never removed automatically — both the legacy entry and our new one are present.
  assert.ok(settings.hooks.UserPromptSubmit.some(e => e.hooks[0].command.includes('delegate-nudge.sh')));
  assert.ok(settings.hooks.UserPromptSubmit.some(e => e.hooks[0].command.includes('agent-delegates-nudge.js')));
});

test('installHook: no legacy-hook warning when none is present', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  installHook(fakeHome, line => log.push(line));
  assert.ok(!log.some(line => /legacy delegate-nudge\.sh/.test(line)));
});

function forcedSnapshot(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    ts: now,
    seven_day: { used_percentage: 95, resets_at: now + 6 * 86400 },
    five_hour: { used_percentage: 5, resets_at: now + 4 * 3600 },
    ...overrides
  });
}

test('B1: the real installed stub, spawned as a process, prints hookSpecificOutput when route is external', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  installHook(fakeHome, () => {});
  const stub = path.join(fakeHome, '.claude', 'agent-delegates-nudge.js');
  fs.writeFileSync(path.join(fakeHome, '.claude', 'rate_limits.json'), forcedSnapshot());
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };

  const ups = spawnSync(process.execPath, [stub], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(ups.status, 0, ups.stderr);
  const upsPayload = JSON.parse(ups.stdout.trim());
  assert.equal(upsPayload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(upsPayload.hookSpecificOutput.additionalContext, /pick --json/);

  const pre = spawnSync(process.execPath, [stub, 'pre-tool'], {
    env, encoding: 'utf8', timeout: 10000, input: JSON.stringify({ tool_name: 'Agent' })
  });
  assert.equal(pre.status, 0, pre.stderr);
  const prePayload = JSON.parse(pre.stdout.trim());
  assert.equal(prePayload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(prePayload.hookSpecificOutput.additionalContext, /^Quota crossed mid-turn: /);
});

test('B1: the real installed stub prints nothing when route is claude', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  installHook(fakeHome, () => {});
  const stub = path.join(fakeHome, '.claude', 'agent-delegates-nudge.js');
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(fakeHome, '.claude', 'rate_limits.json'), forcedSnapshot({
    seven_day: { used_percentage: 1, resets_at: now + 6 * 86400 },
    five_hour: { used_percentage: 1, resets_at: now + 4 * 3600 }
  }));
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };

  const ups = spawnSync(process.execPath, [stub], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(ups.status, 0, ups.stderr);
  assert.equal(ups.stdout.trim(), '');

  const pre = spawnSync(process.execPath, [stub, 'pre-tool'], {
    env, encoding: 'utf8', timeout: 10000, input: JSON.stringify({ tool_name: 'Agent' })
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout.trim(), '');
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
  assert.deepEqual(result.skipped, ['agy', 'grok', 'claude', 'cursor', 'opencode']);
  assert.match(log.join('\n'), /https:\/\/antigravity\.google\/cli\/install\.sh/);
});

test('vendor setup installs after an interactive yes answer', async () => {
  const installed = new Set(['agy', 'grok', 'claude', 'cursor-agent', 'opencode']); // H1: cursor's real command name
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
  assert.deepEqual(result.installed, ['agy', 'grok', 'claude', 'cursor', 'opencode']);
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
  assert.deepEqual(result.skipped, ['codex', 'agy', 'grok', 'claude', 'cursor', 'opencode']);
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

test('vendor setup: auth check wording for ok / logged-out / unknown states, from an injected preflight', async () => {
  const log = [];
  const result = await setupVendorClis({
    commandExists: () => true,
    prompt: async () => false,
    log: line => log.push(line),
    platform: 'linux',
    isTTY: false,
    vendorIds: ['codex', 'grok', 'agy'],
    preflight: async vendor => {
      if (vendor === 'codex') return { ok: true, state: 'ok' };
      if (vendor === 'grok') return { ok: false, state: 'logged-out', loginCommand: 'grok login' };
      return { ok: true, skipped: true, state: 'unknown', loginCommand: 'agy' };
    },
  });
  assert.ok(log.some(line => line === 'codex: found, logged in.'), JSON.stringify(log));
  assert.ok(log.some(line => line === "grok: found, NOT logged in — run 'grok login'."), JSON.stringify(log));
  assert.ok(log.some(line => line === "agy: found; login status could not be verified — run 'agy' if a job fails with an auth error."), JSON.stringify(log));
  assert.deepEqual(result.authNeeded.sort(), ['agy', 'grok']);
});

test('vendor setup: non-TTY never prompts to log in, even when logged-out', async () => {
  const log = [];
  const prompted = [];
  const result = await setupVendorClis({
    commandExists: () => true,
    prompt: async question => { prompted.push(question); return true; },
    log: line => log.push(line),
    platform: 'linux',
    isTTY: false,
    vendorIds: ['codex'],
    preflight: async () => ({ ok: false, state: 'logged-out', loginCommand: 'codex login' }),
    loginSpawn: async () => { throw new Error('must never spawn a login in non-TTY mode'); },
  });
  assert.deepEqual(prompted, []);
  assert.deepEqual(result.authNeeded, ['codex']);
});

test('vendor setup: TTY logged-out prompts "Log in now?" and spawns the login command on yes', async () => {
  const log = [];
  const prompted = [];
  const spawned = [];
  let checkCount = 0;
  const result = await setupVendorClis({
    commandExists: () => true,
    prompt: async question => { prompted.push(question); return true; },
    log: line => log.push(line),
    platform: 'linux',
    isTTY: true,
    vendorIds: ['codex'],
    preflight: async () => {
      checkCount++;
      // First check (found): logged-out. Second check (after the login spawn): ok.
      return checkCount === 1
        ? { ok: false, state: 'logged-out', loginCommand: 'codex login' }
        : { ok: true, state: 'ok' };
    },
    loginSpawn: async (command, args) => { spawned.push([command, ...args]); },
  });
  assert.deepEqual(prompted, ['Log in to codex now? [Y/n] ']);
  assert.deepEqual(spawned, [['codex', 'login']]);
  assert.ok(log.some(line => line === "codex: found, NOT logged in — run 'codex login'."));
  assert.ok(log.some(line => line === 'codex: re-checked, logged in.'), JSON.stringify(log));
  assert.deepEqual(result.authNeeded, []); // re-check came back 'ok' -> no longer needs attention
});

test('vendor setup: TTY logged-out prompt answered "no" never spawns a login', async () => {
  const spawned = [];
  const result = await setupVendorClis({
    commandExists: () => true,
    prompt: async () => false,
    log() {},
    platform: 'linux',
    isTTY: true,
    vendorIds: ['codex'],
    preflight: async () => ({ ok: false, state: 'logged-out', loginCommand: 'codex login' }),
    loginSpawn: async (command, args) => { spawned.push([command, ...args]); },
  });
  assert.deepEqual(spawned, []);
  assert.deepEqual(result.authNeeded, ['codex']);
});

test('vendor setup: --yes never triggers the interactive login prompt (unattended install)', async () => {
  const prompted = [];
  const spawned = [];
  const result = await setupVendorClis({
    commandExists: () => true,
    yes: true,
    prompt: async question => { prompted.push(question); return true; },
    log() {},
    platform: 'linux',
    isTTY: true,
    vendorIds: ['codex'],
    preflight: async () => ({ ok: false, state: 'logged-out', loginCommand: 'codex login' }),
    loginSpawn: async (command, args) => { spawned.push([command, ...args]); },
  });
  assert.deepEqual(prompted, []);
  assert.deepEqual(spawned, []);
  assert.deepEqual(result.authNeeded, ['codex']);
});

test('vendor setup: --no-login skips the prompt even in a TTY, checklist only', async () => {
  const prompted = [];
  const spawned = [];
  const result = await setupVendorClis({
    commandExists: () => true,
    noLogin: true,
    prompt: async question => { prompted.push(question); return true; },
    log() {},
    platform: 'linux',
    isTTY: true,
    vendorIds: ['codex'],
    preflight: async () => ({ ok: false, state: 'logged-out', loginCommand: 'codex login' }),
    loginSpawn: async (command, args) => { spawned.push([command, ...args]); },
  });
  assert.deepEqual(prompted, []);
  assert.deepEqual(spawned, []);
  assert.deepEqual(result.authNeeded, ['codex']);
});

test('vendor setup: no preflight injected -> defaults to "unknown" for every found/installed vendor, no real check', async () => {
  const log = [];
  const result = await setupVendorClis({
    commandExists: () => true,
    log: line => log.push(line),
    platform: 'linux',
    isTTY: false,
    vendorIds: ['codex'],
  });
  assert.ok(log.some(line => /login status could not be verified/.test(line)), JSON.stringify(log));
  assert.deepEqual(result.authNeeded, ['codex']);
});

test('install: "Next: authenticate" line lists only vendors setupVendorClis reports as still needing attention', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'codex,grok', commandExists: () => true,
    setupVendorClis: async () => ({ existing: ['codex', 'grok'], installed: [], skipped: [], ready: true, authNeeded: ['grok'] }),
    log: line => log.push(line)
  });
  assert.ok(log.some(line => line === 'Next: authenticate — grok'), JSON.stringify(log));
});

test('install: "Next: authenticate" line is omitted once every selected vendor reports ok', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'codex,grok', commandExists: () => true,
    setupVendorClis: async () => ({ existing: ['codex', 'grok'], installed: [], skipped: [], ready: true, authNeeded: [] }),
    log: line => log.push(line)
  });
  assert.ok(!log.some(line => /Next: authenticate/.test(line)), JSON.stringify(log));
});

test('Windows Grok/OpenCode and unsupported OS use manual guidance without an installer', async () => {
  const installed = new Set();
  const windows = await setupVendorClis({
    platform: 'win32', yes: true, commandExists: name => installed.has(name),
    install: async vendor => installed.add(vendor.command), log() {}, isTTY: false,
  });
  assert.ok(windows.skipped.includes('grok'));
  assert.ok(windows.skipped.includes('opencode'));
  assert.deepEqual(windows.installed, ['codex', 'agy', 'claude', 'cursor']);
  let unsupportedInstallerCalled = false;
  const unsupported = await setupVendorClis({
    platform: 'sunos', yes: true, commandExists: () => false,
    install: async () => { unsupportedInstallerCalled = true; }, log() {}, isTTY: false,
  });
  assert.equal(unsupportedInstallerCalled, false);
  assert.deepEqual(unsupported.skipped, ['codex', 'agy', 'grok', 'claude', 'cursor', 'opencode']);
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
  await install({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-')), skipCliInstall: true, commandExists: () => true, setupVendorClis: async () => { checks++; }, log() {} });
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

// L11: `run auto` used to require `auto` to be the literal first token right after `run`, before
// any flags — `run --cd X auto brief.md` was rejected with the generic "run requires vendor,
// tier/model, and a brief file" error since `--cd`/`X` consumed the first two positionals.
test('main: "run auto" is recognized even when flags precede it (L11)', async () => {
  const calls = [];
  const runAuto = async (briefSource, options) => {
    calls.push({ briefSource, options });
    return { code: 0 };
  };
  const before = process.exitCode;
  await main(['run', '--cd', '/some/dir', 'auto', 'brief.md'], { runAuto });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].briefSource, 'brief.md');
  assert.equal(calls[0].options.cd, '/some/dir');
  assert.equal(process.exitCode, 0);
  process.exitCode = before;
});

test('main: "run auto brief.md" (auto first, no flags) still works (L11 regression guard)', async () => {
  const calls = [];
  const runAuto = async briefSource => { calls.push(briefSource); return { code: 0 }; };
  const before = process.exitCode;
  await main(['run', 'auto', 'brief.md'], { runAuto });
  assert.deepEqual(calls, ['brief.md']);
  process.exitCode = before;
});

test('main: "run auto" with the wrong number of positionals still reports a clear error (L11)', async () => {
  const before = process.exitCode;
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await main(['run', 'auto'], {});
  } finally {
    console.error = originalError;
  }
  assert.equal(process.exitCode, 2);
  assert.ok(errors.some(l => /run auto requires a brief file or -/.test(l)));
  process.exitCode = before;
});

test('real readline prompt accepts yes before closing the interface', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const { setupVendorClis } = require('./lib/vendor-setup');
    const installed = new Set(['agy', 'grok', 'claude', 'cursor-agent', 'opencode']); // H1: cursor's real command name
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

// Alias prompt gate: aliases only help when the canonical name is NOT already reachable on PATH.
// Reproduced live 2026-09-17: cursor-agent and grok both on PATH, install still asked to add aliases.
test('install: alias prompt is skipped when cursor-agent and grok already resolve by name on PATH', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { collisions } = makeAgentFixtures('cursor-first');
  const asked = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: true, commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions,
    resolveBin: async vendor => ({ command: `/resolved/${vendor}`, source: vendor === 'cursor' ? 'path:cursor-agent' : 'path:grok', verified: true }),
    promptText: async question => { asked.push(question); return 'n'; },
    log: () => {}
  });
  assert.ok(!asked.some(q => /shell aliases/.test(q)), `alias prompt must not appear, got: ${asked.join(' | ')}`);
  assert.equal(fs.existsSync(path.join(fakeHome, '.bashrc')) && fs.readFileSync(path.join(fakeHome, '.bashrc'), 'utf8').includes('alias cursor-agent='), false);
});

test('install: alias prompt appears when a binary resolved only via a well-known dir (not by name on PATH)', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const { collisions } = makeAgentFixtures('cursor-first');
  const asked = [];
  await install({
    home: fakeHome, main: 'claude', delegates: 'cursor,grok', isTTY: true, commandExists: () => true,
    setupVendorClis: async () => {},
    detectAgentCollision: async () => collisions,
    resolveBin: async vendor => ({ command: `/resolved/${vendor}`, source: vendor === 'grok' ? 'well-known:~/.grok/bin/grok' : 'path:cursor-agent', verified: true }),
    promptText: async question => { asked.push(question); return 'n'; },
    log: () => {}
  });
  assert.ok(asked.some(q => /shell aliases/.test(q)), 'alias prompt expected when grok is not reachable by name');
});

// H3: install must never leave behind an artifact pointing at the transient location it happened
// to run from (an npx cache dir) — everything resolves through a stable, copied install home
// instead, and a real shim (not a bashrc alias, useless non-interactively) lands on PATH.
test('H3: install copies the package into the install home with the expected top-level entries', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({ home: fakeHome, main: 'all', skipCliInstall: true, commandExists: () => true, log() {} });
  const dest = pkgDir(fakeHome);
  for (const entry of ['bin', 'lib', 'skills', 'extras', 'package.json', 'README.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(dest, entry)), `${entry} missing from copied install home`);
  }
  assert.ok(fs.existsSync(path.join(dest, 'bin', 'cli.js')));
});

test('H3: skill symlinks resolve into the install home copy, not the running packageRoot()', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, log() {} });
  for (const skill of SKILLS) {
    const link = path.join(fakeHome, '.claude', 'skills', skill);
    const target = fs.readlinkSync(link);
    const resolved = path.resolve(path.dirname(link), target);
    assert.equal(resolved, path.join(pkgDir(fakeHome), 'skills', skill));
  }
});

test('H3: POSIX shim is a real executable pointing at the copied cli.js, not the running package', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, log() {} });
  for (const name of ['agent-delegates', 'delegates']) {
    const shim = path.join(posixBinDir(fakeHome), name);
    const content = fs.readFileSync(shim, 'utf8');
    assert.match(content, /agent-delegates shim/);
    assert.match(content, new RegExp(path.join(pkgDir(fakeHome), 'bin', 'cli.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const mode = fs.statSync(shim).mode & 0o777;
    assert.equal(mode & 0o111, 0o111, `${shim} is not executable (mode ${mode.toString(8)})`);
  }
});

test('H3: a foreign file at the shim path is never overwritten, and is reported', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const binDir = posixBinDir(fakeHome);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'agent-delegates'), '#!/bin/sh\necho not ours\n');
  const log = [];
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, log: l => log.push(l) });
  assert.equal(fs.readFileSync(path.join(binDir, 'agent-delegates'), 'utf8'), '#!/bin/sh\necho not ours\n');
  assert.ok(log.some(l => /WARNING/.test(l) && /agent-delegates/.test(l)), 'expected a warning about the foreign file');
  // The sibling 'delegates' name is unaffected and still gets our shim.
  assert.match(fs.readFileSync(path.join(binDir, 'delegates'), 'utf8'), /agent-delegates shim/);
});

test('H3: PATH-missing note is printed when the shim directory is not on PATH', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  await install({
    home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true,
    env: { PATH: '/usr/bin' }, log: l => log.push(l)
  });
  assert.ok(log.some(l => /is not on your PATH/.test(l)));
  assert.ok(log.some(l => /export PATH=/.test(l)));
});

test('H3: install summary reports the shim as available when its directory is already on PATH', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  const log = [];
  await install({
    home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true,
    env: { PATH: `${posixBinDir(fakeHome)}:/usr/bin` }, log: l => log.push(l)
  });
  assert.ok(log.some(l => /^Command available: agent-delegates \(shim at/.test(l)));
  assert.ok(!log.some(l => /is not on your PATH/.test(l)));
});

test('H3: uninstall removes the shim and the copied install home, but leaves a foreign shim alone', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, log() {} });
  const binDir = posixBinDir(fakeHome);
  // Replace one of the two shims with a foreign file after install, to prove uninstall spares it.
  fs.writeFileSync(path.join(binDir, 'delegates'), '#!/bin/sh\necho mine\n');
  await install({ home: fakeHome, uninstall: true, log() {} });
  assert.equal(fs.existsSync(path.join(binDir, 'agent-delegates')), false);
  assert.equal(fs.readFileSync(path.join(binDir, 'delegates'), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(fs.existsSync(pkgDir(fakeHome)), false);
});

test('H3: re-running install is idempotent — copy is replaced, exactly one shim per name', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, log() {} });
  const dest = pkgDir(fakeHome);
  // Plant a stale marker file that a real package copy would never contain, to prove the second
  // install's fresh-replace (rm -rf then copy) actually happened rather than merging on top.
  fs.writeFileSync(path.join(dest, 'STALE_MARKER'), 'x');
  await install({ home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true, log() {} });
  assert.equal(fs.existsSync(path.join(dest, 'STALE_MARKER')), false);
  const binDir = posixBinDir(fakeHome);
  assert.equal(fs.readdirSync(binDir).filter(n => n === 'agent-delegates').length, 1);
  assert.equal(fs.readdirSync(binDir).filter(n => n === 'delegates').length, 1);
});

test('H3: win32 shim content points at the copied cli.js via an injected platform', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-home-'));
    const log = [];
    await install({
      home: fakeHome, main: 'claude', skipCliInstall: true, commandExists: () => true,
      env: { LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'), Path: 'C:\\Windows' },
      spawnSetx: () => ({ status: 0 }),
      log: l => log.push(l)
    });
    const binDir = path.join(installHome(fakeHome), 'bin');
    const shim = path.join(binDir, 'agent-delegates.cmd');
    const content = fs.readFileSync(shim, 'utf8');
    assert.match(content, /^@echo off\r\n/);
    assert.match(content, /agent-delegates shim/);
    assert.match(content, new RegExp(path.join(pkgDir(fakeHome), 'bin', 'cli.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
