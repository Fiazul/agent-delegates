'use strict';

// m6: `--tier`/`--model` only make sense on `resume` — invoke() never even looks at
// options.model in `run` mode (the model comes from the positional <tier|model> arg instead), so
// a stray `--model`/`--tier` on `run` silently did nothing. bin/cli.js's `main()` must now error
// clearly rather than pretend to accept it.

const assert = require('node:assert/strict');
const test = require('node:test');
const { main } = require('../bin/cli');

async function runMain(argv) {
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  process.exitCode = undefined;
  try {
    await main(argv, {});
    return { exitCode: process.exitCode, errors };
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

test('m6: `run --model X` errors clearly instead of silently ignoring --model', async () => {
  const { exitCode, errors } = await runMain(['run', '--model', 'gpt-custom', 'codex', 'terra', '/tmp/does-not-matter.md']);
  assert.equal(exitCode, 2);
  assert.ok(errors.some(e => /--tier\/--model are only valid on resume/.test(e)), JSON.stringify(errors));
});

test('m6: `run --tier X` (in addition to the positional tier/model) also errors clearly', async () => {
  const { exitCode, errors } = await runMain(['run', '--tier', 'sol', 'codex', 'terra', '/tmp/does-not-matter.md']);
  assert.equal(exitCode, 2);
  assert.ok(errors.some(e => /--tier\/--model are only valid on resume/.test(e)), JSON.stringify(errors));
});

test('m6: the help text documents that --tier wins over --model when both are given on resume', () => {
  const { HELP } = require('../bin/cli');
  assert.match(HELP, /--tier wins/);
});
