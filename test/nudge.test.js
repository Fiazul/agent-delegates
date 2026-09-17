'use strict';

// Tests for extras/delegate-nudge.js: pure handler functions (decideFn injected), no real
// stdin/process.exit involved — the CLI entry point itself is excluded from coverage (see the
// c8 ignore markers in the file) since it's a thin wrapper around these.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  commandTriggersCheck, handlePreToolUse, handleUserPromptSubmit, routingMessage
} = require('../extras/delegate-nudge');

const EXTERNAL = { route: 'external', reason: 'wk 60% used vs 14% of week elapsed (+10 slack)', claudeWk: 60, elapsedPct: 14 };
const CLAUDE = { route: 'claude', reason: 'wk 5% used vs 14% of week elapsed (+10 slack); within pace', claudeWk: 5, elapsedPct: 14 };
const UNKNOWN_STALE = { route: 'unknown', reason: 'Claude quota snapshot is 30m old (stale > 10m)', stale: true };

test('handleUserPromptSubmit: external -> UserPromptSubmit hookSpecificOutput mentioning pick --json', () => {
  const output = handleUserPromptSubmit(() => EXTERNAL);
  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /agent-delegates pick --json` and follow it/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Claude weekly usage 60%/);
});

test('handleUserPromptSubmit: claude -> prints nothing', () => {
  assert.equal(handleUserPromptSubmit(() => CLAUDE), null);
});

test('handleUserPromptSubmit: unknown+stale -> one-line notice, not hookSpecificOutput', () => {
  const output = handleUserPromptSubmit(() => UNKNOWN_STALE);
  assert.match(output, /^agent-delegates: Claude quota snapshot missing\/stale/);
});

test('commandTriggersCheck: matches agent-delegates run and claude invocations, not arbitrary commands', () => {
  assert.equal(commandTriggersCheck('agent-delegates run codex terra brief.md'), true);
  assert.equal(commandTriggersCheck('claude --resume abc'), true);
  assert.equal(commandTriggersCheck('ls -la'), false);
  assert.equal(commandTriggersCheck(''), false);
  assert.equal(commandTriggersCheck(undefined), false);
});

test('handlePreToolUse: Agent tool + external route -> PreToolUse output prefixed "Quota crossed mid-turn"', () => {
  const stdinText = JSON.stringify({ tool_name: 'Agent', tool_input: {} });
  const output = handlePreToolUse(stdinText, () => EXTERNAL);
  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(parsed.hookSpecificOutput.additionalContext, /^Quota crossed mid-turn: /);
});

test('handlePreToolUse: Bash tool without a triggering command -> nothing', () => {
  const stdinText = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.equal(handlePreToolUse(stdinText, () => EXTERNAL), null);
});

test('handlePreToolUse: Bash tool with "agent-delegates run" command + external route -> output', () => {
  const stdinText = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'agent-delegates run codex terra brief.md --cd /x' } });
  const output = handlePreToolUse(stdinText, () => EXTERNAL);
  assert.ok(output);
});

test('handlePreToolUse: Bash tool with "claude " command + external route -> output', () => {
  const stdinText = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'claude --print hi' } });
  const output = handlePreToolUse(stdinText, () => EXTERNAL);
  assert.ok(output);
});

test('handlePreToolUse: other tool names ignored regardless of route', () => {
  const stdinText = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } });
  assert.equal(handlePreToolUse(stdinText, () => EXTERNAL), null);
});

test('handlePreToolUse: route claude -> nothing even for Agent tool', () => {
  const stdinText = JSON.stringify({ tool_name: 'Agent' });
  assert.equal(handlePreToolUse(stdinText, () => CLAUDE), null);
});

test('handlePreToolUse: malformed stdin JSON -> nothing, never throws', () => {
  assert.equal(handlePreToolUse('not json', () => EXTERNAL), null);
});

test('routingMessage: prefix is applied verbatim', () => {
  const msg = routingMessage(EXTERNAL, 'Quota crossed mid-turn: ');
  assert.match(msg, /^Quota crossed mid-turn: Claude weekly usage 60%/);
});
