#!/usr/bin/env node
'use strict';

// Hook implementation, shared by two hook events:
//   - UserPromptSubmit (default, no argv[2]): fires once at the start of every prompt.
//   - PreToolUse (argv[2] === 'pre-tool'): fires before Agent/Bash tool calls, to catch a quota
//     crossing that happens mid-turn (UserPromptSubmit only checks once, at the top of the turn).
// Both modes run the same pace-based policy in lib/policy.js against the quota snapshot written
// by extras/statusline.js. Only the orchestrator sees this; workers never do (by design).
// Installed by lib/install.js's installHook() as a 3-line stub at
// ~/.claude/agent-delegates-nudge.js that requires this file by absolute path (this file itself
// stays inside the package, so its own relative requires below are safe).
//
// Fail-soft, both modes: any error prints nothing and exits 0 — a broken hook must never block
// the user, and neither mode ever sets permissionDecision to block a tool call.

function decideNow() {
  const path = require('node:path');
  const { homeDir, readJson } = require('../lib/util');
  const { loadConfig, decide } = require('../lib/policy');
  const home = homeDir();
  const config = loadConfig(home);
  const snapshot = readJson(path.join(home, '.claude', 'rate_limits.json'));
  const now = Math.floor(Date.now() / 1000);
  return decide({ snapshot, config, now });
}

function routingMessage(result, prefix = '') {
  const elapsed = result.elapsedPct == null ? '?' : Math.round(result.elapsedPct);
  return `${prefix}Claude weekly usage ${result.claudeWk}% vs ${elapsed}% of week elapsed (${result.reason}). ROUTING RULE IN FORCE: unless the user named Opus/Fable for this task, any work beyond a ~5-line edit MUST go to an external worker — run \`agent-delegates pick --json\` and follow it. Trivial questions/reads exempt.`;
}

// Returns the string to print for UserPromptSubmit, or null to print nothing. `decideFn` is
// injectable for tests.
function handleUserPromptSubmit(decideFn = decideNow) {
  const result = decideFn();
  if (result.route === 'external') {
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: routingMessage(result) } })}\n`;
  }
  if (result.route === 'unknown' && result.stale) {
    return `agent-delegates: Claude quota snapshot missing/stale (${result.reason}); run Claude Code with the delegates statusline installed to enable routing.\n`;
  }
  return null; // route === 'claude': print nothing.
}

// A Bash call only counts as an agent-delegates-relevant crossing when its command string looks
// like it's about to spawn a worker or a Claude session — not every shell command in the turn.
function commandTriggersCheck(command) {
  const text = String(command || '');
  return text.includes('agent-delegates run') || text.includes('claude ');
}

// Returns the string to print for PreToolUse, or null to print nothing. `decideFn` and
// `stdinText` are both injectable for tests; stdinText is the raw hook payload JSON.
function handlePreToolUse(stdinText, decideFn = decideNow) {
  let payload;
  try { payload = JSON.parse(stdinText); } catch { return null; }
  const toolName = payload?.tool_name;
  if (toolName !== 'Agent' && toolName !== 'Bash') return null;
  if (toolName === 'Bash' && !commandTriggersCheck(payload?.tool_input?.command)) return null;
  const result = decideFn();
  if (result.route !== 'external') return null;
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: routingMessage(result, 'Quota crossed mid-turn: ') } })}\n`;
}

// Entry point, called both when this file is run directly (`node delegate-nudge.js [pre-tool]`)
// AND from the installed stub at ~/.claude/agent-delegates-nudge.js, which does
// `require("<abs path to this file>").main(process.argv.slice(2))` — requiring a file does NOT
// re-run a `require.main === module` guard (require.main is the stub, not this file), so the
// stub must call this exported function explicitly, or the installed hook prints nothing, ever.
//
// `stdinOverride`, when a string, skips reading real process.stdin — used by tests to avoid
// spawning a real stdin-driven process for every case.
function main(argv = process.argv.slice(2), stdinOverride) {
  let ran = false;
  function runOnce(stdinText) {
    if (ran) return;
    ran = true;
    let output;
    try {
      output = argv[0] === 'pre-tool' ? handlePreToolUse(stdinText) : handleUserPromptSubmit();
    } catch { /* fail-soft */ }
    // L5: process.exit(0) called immediately after process.stdout.write() can truncate the write
    // when stdout is a pipe (Node's docs: writes to a TTY are sync, but a pipe/file write is not
    // guaranteed flushed before the process exits). Wait for the write's own completion callback
    // before exiting; when there's nothing to write, set exitCode and let the process exit
    // naturally rather than force-exiting mid-event-loop-tick.
    if (output) {
      process.stdout.write(output, () => process.exit(0));
      return;
    }
    process.exit(0); // no output: nothing to flush, safe to exit immediately (also unhangs a TTY)
  }

  if (typeof stdinOverride === 'string') {
    runOnce(stdinOverride);
    return;
  }

  try {
    let input = '';
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => runOnce(input));
    process.stdin.on('error', () => runOnce(input));
    process.stdin.resume();
    // Safety net: if stdin never emits 'end' (e.g. a TTY), don't hang the caller.
    setTimeout(() => runOnce(input), 500).unref();
  } catch {
    runOnce('');
  }
}

/* c8 ignore next -- the CLI entry point itself; handleUserPromptSubmit/handlePreToolUse/main
   above carry the actual logic and are what's unit-tested (main() is also exercised end-to-end
   by test/install.test.js, which spawns the real installed stub). */
if (require.main === module) main();

module.exports = { commandTriggersCheck, decideNow, handlePreToolUse, handleUserPromptSubmit, main, routingMessage };
