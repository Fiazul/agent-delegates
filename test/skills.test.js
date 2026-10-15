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

test('delegate-codex/claude/opencode share the same domain-routing block and the same full-access rules (main-agnostic)', () => {
  const texts = ['delegate-codex', 'delegate-claude', 'delegate-opencode'].map(d => [d, fs.readFileSync(path.join(repoRoot, 'skills', d, 'SKILL.md'), 'utf8')]);
  const block = text => text.match(/### Strengths — route by domain\n\n([\s\S]*?)\n\n## /)?.[1];
  const first = block(texts[0][1]);
  assert.ok(first && /OpenCode `kimi`/.test(first) && /Claude `opus`/.test(first), 'codex skill has the strengths block');
  for (const [name, text] of texts) {
    assert.equal(block(text), first, `${name} strengths block differs`);
    assert.match(text, /## Full access \(`--yolo`\) — frontier tiers only/, name);
    assert.match(text, /Before EVERY `--yolo` launch, ask the user: "Delegating <task> to <vendor> <model> \(<tier>\) with FULL\s+access — approve\?"/, name);
    assert.match(text, /One approval covers ONE launch\. There is no standing grant\./, name);
    assert.match(text, /prod hosts, live price pushes, DB writes/, name);
    assert.match(text, /CLI cannot verify any of this/, name);
    assert.doesNotMatch(text, /orchestrator is Claude|Claude Code main|you are Claude/i, `${name} must stay main-agnostic`);
  }
  const oc = texts[2][1];
  assert.match(oc, /use ONLY when the user names OpenCode or for simple tasks/);
  assert.match(oc, /`glm` and `kimi` are frontier models/);
});

test('docs (F6/F10): README + opencode/claude skills document the explicit large-slug allowlist and that effort never changes the class', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const oc = fs.readFileSync(path.join(repoRoot, 'skills', 'delegate-opencode', 'SKILL.md'), 'utf8');
  const cl = fs.readFileSync(path.join(repoRoot, 'skills', 'delegate-claude', 'SKILL.md'), 'utf8');
  for (const text of [readme, oc]) {
    for (const slug of ['opencode-go/glm-5.3', 'opencode-go/glm-5.2', 'opencode-go/kimi-k3', 'opencode-go/kimi-k2.7-code']) assert.ok(text.includes(slug), slug);
    assert.match(text, /added to (that|the) list by hand|add its slug\s+to the list by hand/i);
  }
  assert.match(readme, /Class comes from the tier\/model only for claude, opencode and grok/);
  assert.match(oc, /`--effort` \(`--variant`\) never changes it/);
  assert.match(cl, /`--effort`\s+never changes it/);
  for (const text of [readme, oc]) assert.doesNotMatch(text, /opencode-go\/glm-\*/);
});
