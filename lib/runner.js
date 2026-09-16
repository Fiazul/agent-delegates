'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalVendor, resolveModel } = require('./models');
const { consoleDir, submitJob } = require('./console');
const { homeDir, outputRoot, packageRoot, timestamp } = require('./util');

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

function extractResult(vendor, outDir) {
  const { events, raw } = parseEvents(path.join(outDir, 'events.jsonl'));
  let id = '';
  let usage = null;
  let text = '';
  let toolSteps = 0;
  let failed = false;
  for (const event of events) {
    if (vendor === 'codex') {
      id ||= event.thread_id || '';
      if (event.type === 'turn.completed') usage = event.usage || usage;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text || text;
      if (event.type === 'error' || event.item?.type === 'error') failed = true;
    } else if (vendor === 'agy') {
      id ||= event.conversation_id || event.init?.conversation_id || '';
      if (event.event === 'step_update' && event.step_update?.step_type === 'tool' && event.step_update?.state === 'ACTIVE') toolSteps++;
      if (event.event === 'result' || event.type === 'result' || event.response != null) {
        const result = event.result || event;
        text = result.response || result.text || text;
        usage = result.usage || usage;
      }
      if (event.type === 'error') failed = true;
    } else if (vendor === 'claude' || vendor === 'cursor') {
      id ||= event.session_id || '';
      if (event.type === 'result') {
        text = event.result || text;
        usage = event.usage || usage;
        failed ||= Boolean(event.is_error);
      }
      if (!text && event.type === 'assistant') {
        text = (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('') || text;
      }
    } else if (vendor === 'opencode') {
      id ||= event.sessionID || event.part?.sessionID || '';
      if (event.type === 'text' && event.part?.text) text = event.part.text;
      if (event.type === 'step_finish' && event.part) {
        usage = event.part.tokens || usage;
        if (event.part.reason && event.part.reason !== 'stop' && event.part.reason !== 'tool-calls') failed = true;
      }
      if (event.type === 'error') {
        failed = true;
        text = text || `WORKER FAILED: ${event.message || event.error?.message || JSON.stringify(event)}`;
      }
    } else if (vendor === 'grok') {
      id ||= event.session_id || event.sessionId || event.session?.id || '';
      usage = event.usage || usage;
      failed ||= event.type === 'error' || Boolean(event.error);
      const value = event.result || event.response || event.text;
      if (value != null) text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      if (failed && !text) text = `WORKER FAILED: ${event.message || event.error?.message || 'unknown error'}`;
    }
  }
  if (vendor === 'grok' && raw.includes('402')) failed = true;
  const lastFile = path.join(outDir, 'last.md');
  if (vendor === 'codex' && fs.existsSync(lastFile)) text = fs.readFileSync(lastFile, 'utf8').trim() || text;
  else fs.writeFileSync(lastFile, `${String(text || '').trim()}\n`);
  return { failed, id, raw, text: String(text || '').trim(), toolSteps, usage };
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

function buildJob(command, vendor, mode, model, id, brief, outDir, options) {
  const cwd = path.resolve(options.cd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error(`not a directory: ${cwd}`);
  const prompt = mode === 'run' ? `${workerPreamble(vendor).trim()}\n\n${vendor === 'agy' ? `WORKING DIRECTORY: ${cwd} — every relative path in the brief is relative to this absolute path. Never write into your own scratch/brain directories.\n\n` : ''}${brief}` : brief;
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
  const model = mode === 'run' ? resolveModel(vendor, tierOrId) : '';
  const id = mode === 'resume' ? tierOrId : '';
  const brief = readBrief(briefSource, stdinText);
  const name = options.name || vendor;
  consoleDir(name);
  const outDir = makeOutput(name);
  console.log(`out=${outDir}`);
  const commands = { codex: 'codex', agy: 'agy', grok: 'grok', claude: 'claude', cursor: 'agent', opencode: 'opencode' };
  const { detail, job } = buildJob(commands[vendor], vendor, mode, model, id, brief, outDir, options);
  console.log(detail);
  let code = await submitJob(name, job);
  const result = extractResult(vendor, outDir);
  const stderr = fs.readFileSync(path.join(outDir, 'stderr.log'), 'utf8');
  const exhausted = vendor === 'grok' && /\b402\b/.test(result.raw + stderr);
  if (exhausted) result.failed = true;
  if (result.failed) code = 1;
  fs.writeFileSync(path.join(outDir, 'exit'), String(code));
  const idField = { codex: 'thread_id', agy: 'conversation_id', grok: 'session_id', claude: 'session_id', cursor: 'session_id', opencode: 'session_id' }[vendor];
  fs.writeFileSync(path.join(outDir, idField), result.id);
  if (exhausted) {
    const marker = path.join(homeDir(), '.grok', '.last_402');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString().slice(0, 10)}\n`);
    console.log('GROK EXHAUSTED (402) — reroute to agy/codex');
  }
  const tools = vendor === 'agy' ? ` tool_steps=${result.toolSteps}` : '';
  console.log(`exit=${code} ${idField}=${result.id}${tools}`);
  console.log(`usage=${result.usage == null ? 'null' : JSON.stringify(result.usage)}`);
  const open = vendor === 'codex' ? `CODEX_HOME=${job.env.CODEX_HOME} codex resume ${result.id}`
    : vendor === 'agy' ? `agy --conversation ${result.id}`
      : vendor === 'grok' ? `grok --resume ${result.id}`
        : vendor === 'cursor' ? `agent --resume ${result.id}`
          : vendor === 'opencode' ? `opencode run --session ${result.id}`
            : `claude --resume ${result.id}`;
  console.log(`open=${open}`);
  console.log(`--- last message (${path.join(outDir, 'last.md')}) ---`);
  if (result.text) console.log(result.text);
  return { code, outDir, ...result };
}

module.exports = { buildJob, extractResult, freshCodexHome, invoke, parseEvents, readBrief };
