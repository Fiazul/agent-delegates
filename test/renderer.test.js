'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventRenderer } = require('../lib/renderer');

function render(vendor) {
  const file = path.join(__dirname, 'fixtures', `${vendor}.jsonl`);
  const renderer = new EventRenderer(vendor, { cwd: '/tmp/project', color: false });
  return fs.readFileSync(file, 'utf8').trim().split('\n').flatMap(line => renderer.line(line)).join('\n');
}

test('codex renderer shows commands, edits, narrative, and usage', () => {
  const output = render('codex');
  assert.match(output, /\$ npm test/);
  assert.match(output, /edit lib\/a\.js/);
  assert.match(output, /worker says\nDONE/);
  assert.match(output, /tokens: in 10 · out 3/);
});

test('agy renderer shows tools, streaming narrative, and result', () => {
  const output = render('agy');
  assert.match(output, /reading a\.js/);
  assert.match(output, /Working\./);
  assert.match(output, /RESULT\nDONE/);
});

test('claude renderer shows text, tool input, result snippets, and final result', () => {
  const output = render('claude');
  assert.match(output, /Checking\./);
  assert.match(output, /Read \{"file_path":"a\.js"\}/);
  assert.match(output, /file text/);
  assert.match(output, /RESULT\nDONE/);
});

test('cursor renderer mirrors Claude-style stream events', () => {
  const output = render('cursor');
  assert.match(output, /cursor session started/);
  assert.match(output, /Checking\./);
  assert.match(output, /Read \{"path":"a\.js"\}/);
  assert.match(output, /RESULT\nDONE/);
});

test('opencode renderer shows text and step finish', () => {
  const output = render('opencode');
  assert.match(output, /opencode · opencode-session-1/);
  assert.match(output, /^DONE$/m);
  assert.match(output, /RESULT/);
});
