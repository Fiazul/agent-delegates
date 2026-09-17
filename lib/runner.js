'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalVendor, resolveModel, tierClass } = require('./models');
const { resolveBin } = require('./bins');
const { consoleDir, submitJob } = require('./console');
const { classifyFailure } = require('./failure');
const { assessCriticality, capList, enforce, loadGuardConfig, permissionMode } = require('./guard');
const { preflight } = require('./status');
const { homeDir, outputRoot, packageRoot, timestamp } = require('./util');

// Job timeout: options.timeout is minutes (CLI --timeout, wired by the orchestrator) > env
// DELEGATE_JOB_TIMEOUT_MIN > a 90-minute default. Always resolves to a number so a hung
// worker can never block the queue forever.
function resolveTimeoutMin(options) {
  if (options.timeout != null && Number.isFinite(Number(options.timeout))) return Number(options.timeout);
  if (process.env.DELEGATE_JOB_TIMEOUT_MIN != null && Number.isFinite(Number(process.env.DELEGATE_JOB_TIMEOUT_MIN))) {
    return Number(process.env.DELEGATE_JOB_TIMEOUT_MIN);
  }
  return 90;
}

function readBrief(source, stdinText) {
  if (source === '-') return stdinText;
  return fs.readFileSync(path.resolve(source), 'utf8');
}

function workerPreamble(vendor) {
  const source = fs.readFileSync(path.join(packageRoot(), 'skills', 'delegate-codex', 'worker-preamble.md'), 'utf8');
  const label = { codex: 'Codex', agy: 'Antigravity', grok: 'Grok', claude: 'Claude', cursor: 'Cursor', opencode: 'OpenCode' }[vendor];
  return source.replace('(Codex)', `(${label})`);
}

function freshCodexHome() {
  const home = homeDir();
  const fresh = path.join(home, '.codex-fresh');
  const source = path.join(home, '.codex', 'auth.json');
  const target = path.join(fresh, 'auth.json');
  fs.mkdirSync(fresh, { recursive: true });
  if (!fs.existsSync(source)) return fresh;
  try {
    if (process.platform !== 'win32' && fs.realpathSync(target) === fs.realpathSync(source)) return fresh;
  } catch {}
  try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.platform === 'win32') fs.copyFileSync(source, target);
  else fs.symlinkSync(source, target);
  return fresh;
}

function parseEvents(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch {}
  const events = [];
  try {
    const one = JSON.parse(raw);
    if (Array.isArray(one)) events.push(...one); else events.push(one);
  } catch {
    for (const line of raw.split(/\r?\n/)) {
      try { events.push(JSON.parse(line)); } catch {}
    }
  }
  return { events, raw };
}

function extractResult(vendor, outDir, extra = {}) {
  const { exitCode = 0, stderr = '', timeoutMin } = extra;
  const { events, raw } = parseEvents(path.join(outDir, 'events.jsonl'));
  let id = '';
  let usage = null;
  let text = '';
  let toolSteps = 0;
  for (const event of events) {
    if (vendor === 'codex') {
      id ||= event.thread_id || '';
      if (event.type === 'turn.completed') usage = event.usage || usage;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text || text;
    } else if (vendor === 'agy') {
      id ||= event.conversation_id || event.init?.conversation_id || '';
      if (event.event === 'step_update' && event.step_update?.step_type === 'tool' && event.step_update?.state === 'ACTIVE') toolSteps++;
      if (event.event === 'result' || event.type === 'result' || event.response != null) {
        const result = event.result || event;
        text = result.response || result.text || text;
        usage = result.usage || usage;
      }
    } else if (vendor === 'claude' || vendor === 'cursor') {
      id ||= event.session_id || '';
      if (event.type === 'result') {
        text = event.result || text;
        usage = event.usage || usage;
      }
      if (!text && event.type === 'assistant') {
        text = (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('') || text;
      }
    } else if (vendor === 'opencode') {
      id ||= event.sessionID || event.part?.sessionID || '';
      if (event.type === 'text' && event.part?.text) text = event.part.text;
      if (event.type === 'step_finish' && event.part) usage = event.part.tokens || usage;
    } else if (vendor === 'grok') {
      id ||= event.session_id || event.sessionId || event.session?.id || '';
      usage = event.usage || usage;
      const value = event.result || event.response || event.text;
      if (value != null) text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }
  }
  text = String(text || '').trim();
  const classification = classifyFailure(vendor, { events, raw, stderr, exitCode, text, timeoutMin });
  const lastFile = path.join(outDir, 'last.md');
  // Codex writes its own last.md via `-o` before this runs. On success that file is
  // authoritative (untouched below); on failure its body is preserved under the banner rather
  // than overwritten (F1) — a worker that made real progress before failing shouldn't have
  // that progress silently discarded.
  const codexOwnText = vendor === 'codex' && fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : '';
  if (classification.failed) {
    let banner = `WORKER FAILED: ${classification.reason}`;
    if (classification.resetHint && !new RegExp(`resets?\\s+in\\s+${classification.resetHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(classification.reason)) {
      banner += ` (resets in ${classification.resetHint})`;
    }
    const body = vendor === 'codex' ? (codexOwnText || text) : text;
    text = body ? `${banner}\n\n${body}` : banner;
    fs.writeFileSync(lastFile, `${text}\n`);
  } else if (vendor === 'codex') {
    if (codexOwnText) text = codexOwnText; // codex's own file is authoritative; left untouched on disk
    else fs.writeFileSync(lastFile, `${text}\n`); // no codex-written file yet — create one
  } else {
    fs.writeFileSync(lastFile, `${text}\n`);
  }
  return { ...classification, id, raw, text, toolSteps, usage };
}

function makeOutput(name) {
  const outDir = path.join(outputRoot(), `${name}-${timestamp()}`);
  fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

function writeInput(outDir, brief, prompt) {
  fs.writeFileSync(path.join(outDir, 'brief.md'), brief);
  fs.writeFileSync(path.join(outDir, 'prompt.md'), prompt);
}

function buildJob(command, vendor, mode, model, id, brief, outDir, options, guardInfo = {}) {
  const cwd = path.resolve(options.cd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error(`not a directory: ${cwd}`);
  // Hard critical (options.critical / a guard.paths glob match) gets the strong note; a
  // suspected-only brief (a keyword hint, never a refusal on its own) gets a softened version —
  // it's a guess, not a confirmed critical-work brief.
  let criticalNote = '';
  if (mode === 'run' && guardInfo.critical) {
    criticalNote = `CRITICAL WORK: this brief touches production/critical systems (${capList(guardInfo.reasons || [], 5).join('; ')}). Prefer read-only investigation; before ANY irreversible action (delete, migrate, deploy, restart, rotate keys, write to live data) stop and list it under OPEN QUESTIONS unless the brief explicitly authorises that exact action.\n\n`;
  } else if (mode === 'run' && guardInfo.suspected) {
    criticalNote = `This brief may touch production/critical systems (${capList(guardInfo.hints || [], 5).join('; ')} — heuristic guess, not confirmed). Investigate read-only first; before ANY irreversible action (delete, migrate, deploy, restart, rotate keys, write to live data) stop and list it under OPEN QUESTIONS unless the brief explicitly authorises that exact action.\n\n`;
  }
  const prompt = mode === 'run' ? `${workerPreamble(vendor).trim()}\n\n${criticalNote}${vendor === 'agy' ? `WORKING DIRECTORY: ${cwd} — every relative path in the brief is relative to this absolute path. Never write into your own scratch/brain directories.\n\n` : ''}${brief}` : brief;
  writeInput(outDir, brief, prompt);
  const env = { DELEGATE_VENDOR: vendor };
  const args = [];
  let detail = '';

  if (vendor === 'codex') {
    const full = Boolean(options.full);
    const codexHome = full ? (process.env.CODEX_HOME || path.join(homeDir(), '.codex')) : freshCodexHome();
    env.CODEX_HOME = codexHome;
    env.DELEGATE_STDIN_FILE = path.join(outDir, mode === 'run' ? 'prompt.md' : 'brief.md');
    const clean = full ? [] : ['--disable', 'plugins', '--disable', 'recommended_plugins', '--disable', 'image_generation', '--disable', 'goals', '--disable', 'memories'];
    if (mode === 'run') {
      const sandbox = options.ro ? 'read-only' : 'workspace-write';
      args.push('exec', '--skip-git-repo-check', '--color', 'never', '--json', '-c', 'model_reasoning_summary=detailed', ...clean,
        '-C', cwd, '-s', sandbox, '-m', model, '-c', `model_reasoning_effort=${options.effort || 'medium'}`);
      for (const extra of options.addDir || []) args.push('--add-dir', path.resolve(extra));
      args.push('-o', path.join(outDir, 'last.md'), '-');
      detail = `model=${model} effort=${options.effort || 'medium'} sandbox=${sandbox} cd=${cwd}`;
    } else {
      args.push('exec', 'resume', '--skip-git-repo-check', '--json', '-c', 'model_reasoning_summary=detailed', ...clean,
        '-o', path.join(outDir, 'last.md'), id, '-');
      detail = `thread=${id} cd=${cwd}`;
    }
  } else if (vendor === 'agy') {
    const permission = options.safe ? ['--mode', 'accept-edits'] : ['--dangerously-skip-permissions'];
    if (mode === 'run') args.push('--model', model);
    else args.push('--conversation', id);
    args.push(...permission);
    for (const extra of [...(options.addDir || []), cwd]) args.push('--add-dir', path.resolve(extra));
    args.push('--disable-slash-commands', '--print-timeout', '60m', '--output-format', 'stream-json', '-p', prompt);
    detail = mode === 'run' ? `model=${model} perm=${permission.join(' ')} cd=${cwd}` : `conversation=${id} cd=${cwd}`;
  } else if (vendor === 'grok') {
    args.push('--cwd', cwd, '--output-format', 'json');
    if (options.yolo) args.push('--always-approve');
    if (options.effort) args.push('--effort', options.effort);
    if (mode === 'run') args.push('-m', model);
    else args.push('--resume', id);
    args.push('-p', prompt);
    detail = mode === 'run' ? `model=${model} cd=${cwd} yolo=${options.yolo ? 1 : 0}` : `session=${id} cd=${cwd}`;
  } else if (vendor === 'claude') {
    args.push('-p', prompt, '--output-format', 'stream-json', '--verbose');
    if (mode === 'run') args.push('--model', model);
    else args.push('--resume', id);
    if (options.yolo) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'acceptEdits');
    if (options.effort) args.push('--effort', options.effort);
    for (const extra of options.addDir || []) args.push('--add-dir', path.resolve(extra));
    detail = mode === 'run' ? `model=${model} cd=${cwd} permission=${options.yolo ? 'bypass' : 'acceptEdits'}` : `session=${id} cd=${cwd}`;
  } else if (vendor === 'cursor') {
    args.push('-p', '--output-format', 'stream-json', '--trust', '--workspace', cwd);
    if (mode === 'run') args.push('--model', model);
    else args.push('--resume', id);
    if (options.yolo) args.push('--force');
    args.push(prompt);
    detail = mode === 'run' ? `model=${model} cd=${cwd} yolo=${options.yolo ? 1 : 0}` : `session=${id} cd=${cwd}`;
  } else if (vendor === 'opencode') {
    args.push('run', '--format', 'json', '--dir', cwd);
    if (mode === 'run') args.push('-m', model);
    else args.push('--session', id);
    if (options.yolo) args.push('--auto');
    args.push(prompt);
    detail = mode === 'run' ? `model=${model} cd=${cwd} yolo=${options.yolo ? 1 : 0}` : `session=${id} cd=${cwd}`;
  }

  const label = vendor === 'agy' ? 'antigravity' : vendor;
  const header = mode === 'run' ? `▌ BRIEF  ${label} · ${model}` : `▌ FOLLOW-UP  ${label} · same ${vendor === 'codex' ? 'thread' : vendor === 'agy' ? 'conversation' : 'session'}`;
  return { detail, job: { cmd: command, args, cwd, env, outDir, header } };
}

async function invoke(mode, vendorInput, tierOrId, briefSource, options = {}, stdinText = '') {
  const vendor = canonicalVendor(vendorInput);
  if (!['codex', 'agy', 'grok', 'claude', 'cursor', 'opencode'].includes(vendor)) throw new Error(`unknown vendor '${vendorInput}'`);

  // Pre-spawn login check: a run against a logged-out/missing vendor CLI must never be
  // submitted (it would otherwise wedge a job on an interactive login prompt). Skipped on
  // resume (the thread already authenticated once) and via --no-preflight (options.noPreflight).
  if (mode !== 'resume' && !options.noPreflight) {
    const preflightFn = options.preflight || preflight;
    const result = await preflightFn(vendor, homeDir(), options);
    if (result && result.ok === false) throw new Error(result.reason);
    if (result && result.warning) console.log(`WARNING: ${result.warning}`);
  }

  const model = mode === 'run' ? resolveModel(vendor, tierOrId) : '';
  const id = mode === 'resume' ? tierOrId : '';
  const brief = readBrief(briefSource, stdinText);

  const guardConfig = options.guardConfig || loadGuardConfig(homeDir());
  const { critical, suspected, reasons, hints } = assessCriticality({ brief, cwd: options.cd || '', addDir: options.addDir || [], options, config: guardConfig });
  const mode_ = permissionMode(vendor, options);
  const verdict = enforce({ vendor, tier: tierOrId, model, critical, reasons, options, mode });
  if (!verdict.ok) throw new Error(verdict.message);

  // Some vendors (cursor, grok) are invoked by a bare command name another tool can shadow via
  // PATH order (Cursor and Grok's own installers both put an `agent` on disk) — resolveBin is
  // the single place that decides which real binary a vendor name means, and refuses to guess
  // wrong for that pair rather than silently launching the wrong vendor. Resolved (and, on
  // failure, thrown) before any output dir exists — same as the guard/preflight checks above.
  const bin = resolveBin(vendor, { home: homeDir(), env: process.env, config: options.binsConfig });
  if (!bin.command) throw new Error(bin.reason);

  const name = options.name || vendor;
  consoleDir(name);
  const outDir = makeOutput(name);
  console.log(`out=${outDir}`);
  console.log(`PERMISSIONS: ${mode_}`);
  if (critical) console.log(`CRITICAL: ${capList(reasons, 5).join('; ')}`);
  else if (suspected) {
    for (const hint of capList(hints, 5)) console.log(`CRITICAL? ${hint} — pass --critical if this touches live systems`);
  }
  for (const warning of verdict.warnings) console.log(`WARNING: ${warning}`);
  // L6: an unverified resolution (bin.verified === false, e.g. a bare `agent` PATH hit whose
  // identity couldn't be confirmed as cursor/grok) must be visibly flagged in the run's own
  // output, not just silently used — this is the one line an operator watching the console
  // actually sees before the job starts.
  console.log(`BIN: ${bin.command} (${bin.source})${bin.verified === false ? ' [unverified]' : ''}`);
  const { detail, job } = buildJob(bin.command, vendor, mode, model, id, brief, outDir, options, { critical, suspected, reasons, hints });
  const metaFile = path.join(outDir, 'meta.json');
  // Best effort: a meta.json write must never fail the run — it exists for handoff/tooling,
  // not for the job itself. `id` is omitted at start-of-run (unknown until the job produces
  // one) and filled in below once known, rather than persisting a misleading "".
  try {
    const meta = { vendor, model, mode, cwd: job.cwd, startedAt: new Date().toISOString(), critical, permissionMode: mode_, tierClass: tierClass(vendor, model || tierOrId) };
    if (mode === 'resume') meta.id = id;
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {}
  console.log(detail);
  const timeoutMin = resolveTimeoutMin(options);
  let code = await submitJob(name, job, { timeoutMs: timeoutMin * 60000 });
  let stderr = '';
  try { stderr = fs.readFileSync(path.join(outDir, 'stderr.log'), 'utf8'); } catch {}
  const result = extractResult(vendor, outDir, { exitCode: code, stderr, timeoutMin });
  // 124 (job timeout) must survive as-is — collapsing it to a generic 1 would make a timed-out
  // job indistinguishable from any other failure to a caller/script branching on exit code.
  if (result.failed && code !== 124) code = 1;
  fs.writeFileSync(path.join(outDir, 'exit'), String(code));
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.id = result.id;
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {}
  const idField = { codex: 'thread_id', agy: 'conversation_id', grok: 'session_id', claude: 'session_id', cursor: 'session_id', opencode: 'session_id' }[vendor];
  fs.writeFileSync(path.join(outDir, idField), result.id);
  if (result.exhausted) {
    if (vendor === 'grok') {
      const marker = path.join(homeDir(), '.grok', '.last_402');
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${new Date().toISOString().slice(0, 10)}\n`);
    }
    const label = vendor === 'agy' ? 'antigravity' : vendor;
    const reroute = ['codex', 'agy', 'grok', 'claude', 'cursor', 'opencode'].filter(v => v !== vendor).join('/');
    console.log(`${label.toUpperCase()} EXHAUSTED — reroute to ${reroute}`);
  }
  const tools = vendor === 'agy' ? ` tool_steps=${result.toolSteps}` : '';
  console.log(`exit=${code} ${idField}=${result.id}${tools}`);
  console.log(`usage=${result.usage == null ? 'null' : JSON.stringify(result.usage)}`);
  // Use the same resolved binary here as the actual run — a hardcoded 'agent'/'grok' literal
  // would print a resume hint that reopens the wrong vendor if bin.command resolved elsewhere.
  const open = vendor === 'codex' ? `CODEX_HOME=${job.env.CODEX_HOME} ${bin.command} resume ${result.id}`
    : vendor === 'agy' ? `${bin.command} --conversation ${result.id}`
      : vendor === 'grok' ? `${bin.command} --resume ${result.id}`
        : vendor === 'cursor' ? `${bin.command} --resume ${result.id}`
          : vendor === 'opencode' ? `${bin.command} run --session ${result.id}`
            : `${bin.command} --resume ${result.id}`;
  console.log(`open=${open}`);
  console.log(`--- last message (${path.join(outDir, 'last.md')}) ---`);
  if (result.text) console.log(result.text);
  return { code, outDir, ...result };
}

module.exports = { buildJob, extractResult, freshCodexHome, invoke, parseEvents, readBrief };
