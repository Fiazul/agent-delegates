#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let value;
  try { value = JSON.parse(input); } catch { return; }
  const base = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const claudeDir = path.join(base, '.claude');
  const target = path.join(claudeDir, 'rate_limits.json');
  const temp = `${target}.tmp`;
  const snapshot = {
    ts: Math.floor(Date.now() / 1000),
    model: value.model?.display_name,
    five_hour: value.rate_limits?.five_hour,
    seven_day: value.rate_limits?.seven_day
  };
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(snapshot));
    fs.renameSync(temp, target);
  } catch {}

  let downstream = '';
  try { downstream = JSON.parse(fs.readFileSync(path.join(claudeDir, 'delegate-statusline.json'), 'utf8')).downstream || ''; } catch {}
  if (downstream) {
    const result = spawnSync(downstream, { shell: true, input, encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    return;
  }
  const left = used => Number.isFinite(Number(used)) ? `${100 - Math.trunc(Number(used))}% left` : '?';
  process.stdout.write(`${snapshot.model || ''} │ wk ${left(snapshot.seven_day?.used_percentage)} · 5h ${left(snapshot.five_hour?.used_percentage)}`);
});
