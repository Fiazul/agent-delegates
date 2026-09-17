#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { close, interrupt, runConsole } = require('../lib/console');
const { install } = require('../lib/install');
const { invoke } = require('../lib/runner');
const { status } = require('../lib/status');

const HELP = `agent-delegates — visible, reusable CLI-agent workers

Usage:
  agent-delegates install [--statusline] [--yes] [--skip-cli-install] [--uninstall]
  agent-delegates status [--probe-grok]
  agent-delegates run <vendor> <tier|model> <brief-file|-> [options]
  agent-delegates run auto <brief-file|-> [--priority v1,v2,...] [--max-hops N] [options]
  agent-delegates resume <vendor> <id> <message-file|-> [--cd DIR] [--name N] [--full]
  agent-delegates handoff <job-dir> <vendor> [tier] --cd DIR [--name N] [options]
  agent-delegates interrupt <vendor|name>
  agent-delegates close <vendor|name>

Vendors: codex, agy (antigravity), grok, claude, cursor, opencode

Run options:
  --cd DIR       working directory
  --name N       reusable window name
  --ro           Codex read-only sandbox
  --effort E     model reasoning effort
  --add-dir D    extra working directory (repeatable)
  --full         Codex user configuration instead of clean room
  --safe         agy accept-edits mode (default is full permission)
  --yolo         Grok/Claude/Cursor/OpenCode full permission mode
  --priority v1,v2,...  vendor try-order for 'run auto' (default agy,codex,grok,cursor,opencode,claude)
  --max-hops N   max vendor attempts for 'run auto'
  --yes          install all missing vendor CLIs without prompting
  --skip-cli-install  link skills without checking or installing vendor CLIs

handoff builds a continuation brief from a finished job directory (brief.md, meta.json,
exit, last.md, events.jsonl, live git status) and fires it at a different vendor.
`;

function die(message) {
  if (message) console.error(message);
  console.error(HELP);
  process.exitCode = 2;
}

function parseOptions(args) {
  const options = { addDir: [] };
  const positional = [];
  const boolean = new Set(['--ro', '--full', '--safe', '--yolo', '--statusline', '--uninstall', '--probe-grok', '--yes', '--skip-cli-install']);
  const values = new Map([['--cd', 'cd'], ['--name', 'name'], ['--effort', 'effort'], ['--add-dir', 'addDir'], ['--priority', 'priority'], ['--max-hops', 'maxHops']]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (boolean.has(arg)) options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    else if (values.has(arg)) {
      if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
      const key = values.get(arg);
      if (key === 'addDir') options.addDir.push(args[++i]); else options[key] = args[++i];
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  return { options, positional };
}

async function stdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let command = argv.shift();
  if (!command && path.basename(process.argv[1] || '').startsWith('delegates')) command = 'status';
  if (!command || ['-h', '--help', 'help'].includes(command)) return console.log(HELP);
  try {
    if (command === 'install') {
      const { options, positional } = parseOptions(argv);
      if (positional.length) return die('install takes no positional arguments');
      return await (dependencies.install || install)(options);
    }
    if (command === 'status') {
      const { options, positional } = parseOptions(argv);
      if (positional.length) return die('status takes no positional arguments');
      return console.log(await status({ probeGrok: options.probeGrok }));
    }
    if (command === 'run' && argv[0] === 'auto') {
      argv.shift();
      const { options, positional } = parseOptions(argv);
      if (positional.length !== 1) return die('run auto requires a brief file or -');
      const input = positional[0] === '-' ? await stdin() : '';
      let runAuto;
      try { ({ runAuto } = require('../lib/route')); } catch (error) { return die(`run auto unavailable: ${error.message}`); }
      const result = await (dependencies.runAuto || runAuto)(positional[0], options, input);
      process.exitCode = result.code;
      return;
    }
    if (command === 'run' || command === 'resume') {
      const { options, positional } = parseOptions(argv);
      if (positional.length !== 3) return die(`${command} requires vendor, ${command === 'run' ? 'tier/model' : 'id'}, and a brief file or -`);
      const input = positional[2] === '-' ? await stdin() : '';
      const result = await invoke(command, positional[0], positional[1], positional[2], options, input);
      process.exitCode = result.code;
      return;
    }
    if (command === 'handoff') {
      const { options, positional } = parseOptions(argv);
      if (positional.length < 2 || positional.length > 3) return die('handoff requires job-dir, vendor, and optional tier');
      const [jobDir, vendor, tier] = positional;
      const { handoff } = require('../lib/handoff');
      const result = await (dependencies.handoff || handoff)(path.resolve(jobDir), vendor, tier, options);
      process.exitCode = result.code;
      return;
    }
    if (command === 'interrupt' || command === 'close') {
      if (argv.length !== 1) return die(`${command} requires a vendor or window name`);
      const name = argv[0] === 'antigravity' ? 'agy' : argv[0];
      return command === 'interrupt' ? await interrupt(name) : close(name);
    }
    if (command === '_console') {
      if (argv.length < 3) throw new Error('_console requires dir, title, and idle minutes');
      return runConsole(path.resolve(argv[0]), argv[1], Number(argv[2]), { once: argv[3] === '--once' });
    }
    return die(`unknown command '${command}'`);
  } catch (error) {
    console.error(`agent-delegates: ${error.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { HELP, main, parseOptions };
