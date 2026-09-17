#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { close, interrupt, runConsole } = require('../lib/console');
const { install } = require('../lib/install');
const { invoke } = require('../lib/runner');
const { status } = require('../lib/status');

const HELP = `agent-delegates — visible, reusable CLI-agent workers

Usage:
  agent-delegates install [--main claude|codex|cursor|all] [--delegates v1,v2,...] [--no-statusline] [--no-hook] [--yes] [--skip-cli-install] [--uninstall]
  agent-delegates status [--probe-grok]
  agent-delegates route-check [--json] [--self claude] [--probe]
  agent-delegates pick [--critical] [--json] [--probe]
  agent-delegates run <vendor> <tier|model> <brief-file|-> [options]
  agent-delegates run auto <brief-file|-> [--priority v1,v2,...] [--max-hops N] [options]
  agent-delegates resume <vendor> <id> <message-file|-> [--cd DIR] [--name N] [--full] [--tier T | --model M]
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
  --tier T       resume: pin this tier's model instead of the one the prior job recorded (if both --tier and --model are given, --tier wins); not valid on run — pass the model as the positional <tier|model> argument instead
  --model M      resume: pin this raw model slug instead of the one the prior job recorded (if both --tier and --model are given, --tier wins); not valid on run — pass the model as the positional <tier|model> argument instead
  --full         Codex user configuration instead of clean room
  --safe         agy accept-edits mode (default is full permission)
  --yolo         Grok/Claude/Cursor/OpenCode full permission mode
  --priority v1,v2,...  vendor try-order for 'run auto' (default agy,codex,grok,cursor,opencode,claude)
  --max-hops N   max vendor attempts for 'run auto'
  --main W       install: which CLI is the main orchestrator (claude|codex|cursor|all; default claude; a TTY asks if omitted)
  --delegates v1,v2,...  install: which delegate vendors to set up (agy,codex,grok,claude,cursor,opencode; default agy,codex,grok; a TTY asks if omitted)
  --aliases yes|no  install: add cursor-agent/grok shell aliases pointing at their resolved binaries (opt-in; a TTY asks if omitted)
  --resolve-agent-conflict yes|no  install: apply (or skip) the proposed fix when something shadows Cursor's "agent" command (Grok or an unrecognized binary resolves first on PATH; a TTY asks if omitted; default No)
  --yes          install all missing vendor CLIs without prompting
  --no-login     install: skip the interactive "log in now?" prompts (checklist only)
  --critical     mark this brief as critical work (prod/servers/live data): only large models may run it
  --allow-small  override the critical-work guard and allow a small/standard model (not recommended)
  --timeout MIN  kill the worker after MIN minutes (default 90, env DELEGATE_JOB_TIMEOUT_MIN); exit 124
  --no-preflight skip the pre-spawn login check for the vendor CLI
  --skip-cli-install  link skills without checking or installing vendor CLIs
  --no-statusline  skip installing the Claude Code statusline (installed by default)
  --no-hook      skip installing the UserPromptSubmit routing-nudge hook (installed by default)
  --no-path      install: don't offer to add the shim directory to PATH on win32 (print the instruction instead)
  --statusline/--hook  accepted for compatibility; both are already on by default (no-ops)
  --json         route-check: print one JSON line instead of a human line
  --self VENDOR  route-check: whose policy to report (only 'claude' supported for now)
  --probe        route-check/pick/run auto: force a fresh vendor-status probe instead of the cached rows
                 (route-check/pick/run auto read <console cache dir>/rows.json when younger than
                 rowsTtlMinutes, default 10; 'status' always probes and refreshes that cache)

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
  const boolean = new Set(['--ro', '--full', '--safe', '--yolo', '--statusline', '--hook', '--no-statusline', '--no-hook', '--no-path', '--uninstall', '--probe-grok', '--yes', '--skip-cli-install', '--json', '--critical', '--allow-small', '--no-preflight', '--probe', '--no-login']);
  const values = new Map([['--cd', 'cd'], ['--name', 'name'], ['--effort', 'effort'], ['--add-dir', 'addDir'], ['--priority', 'priority'], ['--max-hops', 'maxHops'], ['--self', 'self'], ['--timeout', 'timeout'], ['--main', 'main'], ['--delegates', 'delegates'], ['--aliases', 'aliases'], ['--resolve-agent-conflict', 'resolveAgentConflict'], ['--tier', 'tier'], ['--model', 'model']]);
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
    if (command === 'route-check') {
      const { options, positional } = parseOptions(argv);
      if (positional.length) return die('route-check takes no positional arguments');
      if (options.self && options.self !== 'claude') console.log(`--self ${options.self} unsupported, reports claude policy`);
      const { routeCheck, formatRouteCheck } = require('../lib/policy');
      const result = await (dependencies.routeCheck || routeCheck)(options);
      if (options.json) {
        console.log(JSON.stringify({
          route: result.route, reason: result.reason, claudeWk: result.claudeWk,
          fiveHour: result.fiveHour, elapsedPct: result.elapsedPct, stale: result.stale,
          nextVendor: result.nextVendor
        }));
      } else {
        console.log(formatRouteCheck(result));
      }
      return;
    }
    if (command === 'pick') {
      const { options, positional } = parseOptions(argv);
      if (positional.length) return die('pick takes no positional arguments');
      const { pick, formatPick } = require('../lib/policy');
      const result = await (dependencies.pick || pick)(options);
      if (options.json) console.log(JSON.stringify(result));
      else console.log(formatPick(result));
      return;
    }
    if (command === 'run' || command === 'resume') {
      const { options, positional } = parseOptions(argv);
      // L11: `auto` used to have to be the literal first token right after `run` (argv[0] checked
      // before options were even parsed), so `run --cd X auto brief.md` was rejected — flags are
      // legitimately positioned before the subcommand in every other command here. Parse options
      // first, then recognize `run auto` from the resulting positional[0] so flags can precede it.
      if (command === 'run' && positional[0] === 'auto') {
        if (positional.length !== 2) return die('run auto requires a brief file or -');
        const briefArg = positional[1];
        const input = briefArg === '-' ? await stdin() : '';
        let runAuto;
        try { ({ runAuto } = require('../lib/route')); } catch (error) { return die(`run auto unavailable: ${error.message}`); }
        const result = await (dependencies.runAuto || runAuto)(briefArg, options, input);
        process.exitCode = result.code;
        return;
      }
      if (positional.length !== 3) return die(`${command} requires vendor, ${command === 'run' ? 'tier/model' : 'id'}, and a brief file or -`);
      // m6: `--tier`/`--model` only make sense on `resume` (pinning a follow-up's model, since
      // the tier/model positional isn't available there) — `run` already takes the model as its
      // positional <tier|model> argument, so a stray `--model` on `run` must error clearly rather
      // than silently doing nothing (invoke() never even looks at options.model in run mode).
      if (command === 'run' && (options.tier || options.model)) {
        return die('--tier/--model are only valid on resume; run takes the model as its positional <tier|model> argument');
      }
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
