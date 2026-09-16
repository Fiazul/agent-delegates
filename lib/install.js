'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exists, homeDir, packageRoot, readJson, shellQuote, timestamp, writeJson } = require('./util');
const { setupVendorClis } = require('./vendor-setup');

const SKILLS = ['delegate-codex', 'delegate-antigravity', 'delegate-grok', 'delegate-claude', 'delegate-cursor', 'delegate-opencode', 'delegates'];

function removeManagedLink(target, log) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { return; }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    log(`removed ${target}`);
  }
}

function appendAlias(home, uninstall, log) {
  if (process.platform === 'win32') return;
  for (const filename of ['.bashrc', '.zshrc']) {
    const file = path.join(home, filename);
    if (!exists(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.split(/\r?\n/).filter(line => !/^\s*alias delegates=/.test(line));
    if (uninstall) {
      if (lines.join('\n') !== original) fs.writeFileSync(file, lines.join('\n'));
      continue;
    }
    if (lines.length && lines.at(-1) !== '') lines.push('');
    const command = [process.execPath, path.join(packageRoot(), 'bin', 'cli.js'), 'status'].map(shellQuote).join(' ');
    lines.push('alias delegates=' + shellQuote(command));
    fs.writeFileSync(file, lines.join('\n'));
    log(`alias added to ~/${filename}`);
  }
}

function installStatusline(home, log) {
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const source = path.join(packageRoot(), 'extras', 'statusline.js');
  const target = path.join(claudeDir, 'agent-delegates-statusline.js');
  fs.copyFileSync(source, target);
  try { fs.chmodSync(target, 0o755); } catch {}

  const settingsFile = path.join(claudeDir, 'settings.json');
  const settings = exists(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  const old = typeof settings.statusLine?.command === 'string' ? settings.statusLine.command : '';
  const command = `node "${target.replace(/"/g, '\\"')}"`;
  if (old && old !== command) writeJson(path.join(claudeDir, 'delegate-statusline.json'), { downstream: old });
  settings.statusLine = { type: 'command', command };
  if (exists(settingsFile) && old !== command) fs.copyFileSync(settingsFile, settingsFile + '.bak-' + timestamp());
  writeJson(settingsFile, settings);
  log(`statusline installed at ${target}`);
  log(`Claude statusLine command: ${command}`);
}

async function install(options = {}) {
  const log = options.log || console.log;
  const home = options.home || homeDir();
  const sourceRoot = path.join(packageRoot(), 'skills');
  const targets = [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills'), path.join(home, '.cursor', 'skills')];
  const ts = timestamp();

  if (options.uninstall) {
    for (const root of targets) for (const skill of SKILLS) removeManagedLink(path.join(root, skill), log);
    appendAlias(home, true, log);
    log('aliases removed');
    return;
  }

  for (const root of targets) {
    fs.mkdirSync(root, { recursive: true });
    for (const skill of SKILLS) {
      const source = path.join(sourceRoot, skill);
      const target = path.join(root, skill);
      let stat = null;
      try { stat = fs.lstatSync(target); } catch {}
      if (stat && !stat.isSymbolicLink()) {
        const backup = `${target}.bak-${ts}`;
        fs.renameSync(target, backup);
        log(`backed up ${target} -> ${path.basename(backup)}`);
      } else if (stat) {
        fs.unlinkSync(target);
      }
      try {
        fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
        log(`linked ${target}`);
      } catch (error) {
        if (process.platform !== 'win32') throw error;
        fs.cpSync(source, target, { recursive: true });
        log(`note: junction unavailable; copied ${target} (re-run install after package updates)`);
      }
    }
  }
  appendAlias(home, false, log);
  if (options.statusline) installStatusline(home, log);
  if (options.skipCliInstall) log('CLI installation checks skipped (--skip-cli-install).');
  else await (options.setupVendorClis || setupVendorClis)({
    yes: options.yes,
    log,
    commandExists: options.commandExists,
    install: options.vendorInstall,
    prompt: options.prompt,
    isTTY: options.isTTY,
    platform: options.platform,
  });
  log('Skills configured. Check CLI availability with: agent-delegates status');
}

module.exports = { SKILLS, install, installStatusline };
