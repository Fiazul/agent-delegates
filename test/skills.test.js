'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');
const templatePath = path.join(repoRoot, 'skills', 'delegate-codex', 'brief-template.md');

test('brief-template.md exists and has the required headings', () => {
  const text = fs.readFileSync(templatePath, 'utf8');
  for (const heading of ['## Goal', '## Scope', '## Acceptance criteria', '## Report format']) {
    assert.ok(text.includes(heading), `brief-template.md missing heading: ${heading}`);
  }
});

test('every delegate-*/SKILL.md points to brief-template.md', () => {
  const skillsDir = path.join(repoRoot, 'skills');
  const delegateDirs = fs.readdirSync(skillsDir).filter(name => name.startsWith('delegate-'));
  assert.ok(delegateDirs.length > 0, 'expected at least one delegate-* skill directory');
  for (const dir of delegateDirs) {
    const skillFile = path.join(skillsDir, dir, 'SKILL.md');
    const text = fs.readFileSync(skillFile, 'utf8');
    assert.ok(text.includes('brief-template.md'), `${dir}/SKILL.md does not mention brief-template.md`);
  }
});
