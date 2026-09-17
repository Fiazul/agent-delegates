'use strict';

// Cross-vendor handoff: turn a finished (often failed/exhausted) job directory into a
// continuation brief for a different vendor, and fire that continuation as a new run.
// See CLAUDE.md gotchas: quota/auth failures are common and routine across vendors — this
// is the mechanism that lets a stuck job resume on another vendor instead of stalling.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { exists, readJson } = require('./util');
const { canonicalVendor } = require('./models');
const { parseResetHint } = require('./failure');
const runner = require('./runner');

const DEFAULT_TIER = Object.freeze({
  agy: 'flash',
  codex: 'terra',
  grok: 'best',
  claude: 'sonnet',
  cursor: 'auto',
  opencode: 'free'
});

function readFileOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

// Best-effort vendor inference when a job predates meta.json. thread_id/conversation_id are
// unique to codex/agy; session_id is shared by claude/cursor/opencode/grok so it cannot pin
// a single vendor — callers relying on that ambiguous case should pass meta or targetVendor
// context of their own.
function inferVendor(jobDir) {
  if (exists(path.join(jobDir, 'thread_id'))) return 'codex';
  if (exists(path.join(jobDir, 'conversation_id'))) return 'agy';
  if (exists(path.join(jobDir, 'session_id'))) return 'unknown (session_id is shared by claude/cursor/opencode/grok)';
  return 'unknown';
}

function cap(text, max, label) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${label} truncated, ${s.length - max} more chars]`;
}

function gitEvidence(cwd) {
  try {
    const status = execFileSync('git', ['-C', cwd, 'status', '--short'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const diffStat = execFileSync('git', ['-C', cwd, 'diff', '--stat', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, status: status.trim(), diffStat: diffStat.trim() };
  } catch (error) {
    const line = String(error.message || error).split(/\r?\n/)[0];
    return { ok: false, note: `not a git repository (or git unavailable) at ${cwd}: ${line}` };
  }
}

// Cheap, vendor-agnostic pass over parsed events: a tool-step count, any assistant/response
// text found under the shapes each vendor actually uses (see lib/runner.js extractResult),
// and file-looking paths lifted straight out of the serialized event (tool-call args, diffs,
// etc). Not a precise per-vendor parser — just enough signal for a continuation brief.
function summarizeEvents(events) {
  let toolSteps = 0;
  const messages = [];
  const files = new Set();
  const FILE_RE = /(?:^|[\s"'`(])((?:\.{1,2}\/)?[\w.-]+\/[\w./-]+\.[a-zA-Z0-9]{1,10})(?=[\s"'`),:;]|$)/g;
  for (const event of events) {
    let blob = '';
    try { blob = JSON.stringify(event); } catch { blob = ''; }
    if (event.step_update?.step_type === 'tool' || event.item?.type === 'function_call' ||
        event.type === 'tool_use' || event.type === 'function_call' || /"(tool_use|tool_call|function_call)"/i.test(blob)) {
      toolSteps++;
    }
    const contentText = Array.isArray(event.message?.content)
      ? event.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
      : '';
    const text = event.item?.text || event.result?.response || event.result?.text || event.part?.text ||
      contentText || (typeof event.text === 'string' ? event.text : '') ||
      (typeof event.response === 'string' ? event.response : '');
    if (text && String(text).trim()) messages.push(String(text).trim());
    let match;
    while ((match = FILE_RE.exec(blob))) files.add(match[1]);
  }
  return { toolSteps, messages, files: [...files].slice(0, 15) };
}

function buildHandoffBrief({ jobDir, cwd: cwdArg, targetVendor }) {
  const meta = readJson(path.join(jobDir, 'meta.json'));
  const vendor = meta?.vendor || inferVendor(jobDir);
  const model = meta?.model || 'unknown';
  const cwd = cwdArg || meta?.cwd;
  if (!cwd) throw new Error(`buildHandoffBrief: cwd unknown for ${jobDir} (no meta.json — pass cwd)`);

  const originalBrief = cap(readFileOr(path.join(jobDir, 'brief.md'), '(brief.md missing)').trim(), 6000, 'original brief');
  const exitCode = readFileOr(path.join(jobDir, 'exit'), '').trim() || 'unknown';
  const lastMessage = readFileOr(path.join(jobDir, 'last.md'), '(last.md missing)');
  const { events } = runner.parseEvents(path.join(jobDir, 'events.jsonl'));
  const { toolSteps, messages, files } = summarizeEvents(events);
  const reasonMatch = /^WORKER FAILED:\s*(.+)$/m.exec(lastMessage);
  const reason = reasonMatch ? reasonMatch[1] : null;
  // Prefer whatever the worker left after its own failure banner (real, often long, progress
  // text); fall back to text pulled out of events.jsonl when last.md carries no banner/body.
  const bannerLine = reasonMatch ? reasonMatch[0] : null;
  const lastBody = bannerLine ? lastMessage.slice(lastMessage.indexOf(bannerLine) + bannerLine.length).trim() : lastMessage.trim();
  const assistantText = cap(lastBody || messages.join('\n---\n'), 1500, 'assistant messages');

  const resetHint = reason ? parseResetHint(reason) : null;
  const git = gitEvidence(cwd);

  const lines = [];
  lines.push(`# Continuation brief (handed off from ${vendor} · ${model} to ${targetVendor})`);
  lines.push('');
  lines.push('## Original brief');
  lines.push(originalBrief);
  lines.push('');
  lines.push('## Why handed off');
  lines.push(`exit=${exitCode}`);
  lines.push(reason
    ? `WORKER FAILED: ${reason}${resetHint ? ` (resets in ${resetHint})` : ''}`
    : '(no WORKER FAILED banner found in last.md — handed off for another reason, e.g. manual escalation)');
  lines.push('');
  lines.push('## Progress evidence');
  lines.push(`tool steps observed: ${toolSteps}`);
  if (files.length) lines.push(`files mentioned in tool calls (best-effort): ${files.join(', ')}`);
  lines.push('### git status --short');
  lines.push(git.ok ? cap(git.status || '(clean)', 2000, 'git status') : git.note);
  if (git.ok) {
    lines.push('### git diff --stat');
    lines.push(cap(git.diffStat || '(no diff)', 3000, 'diff --stat'));
  }
  lines.push('### last worker message');
  lines.push(assistantText || '(no assistant text extracted)');

  // The Instructions block is appended AFTER the global cap below (F1) so it can never be
  // truncated away — every other section already has its own per-field cap above, so the
  // global cap is now a backstop, not the thing doing the real truncation work.
  const instructions = [
    '',
    '## Instructions',
    'Continue from the current state described above. Do NOT redo work already done — verify existing changes first (read the files, run tests) before making more changes. Same acceptance criteria as the original brief apply. Use the same report format the original brief required.'
  ].join('\n');

  return `${cap(lines.join('\n'), 12000, 'brief')}\n${instructions}`;
}

async function handoff(jobDir, targetVendor, tier, options = {}) {
  const { invoke: invokeOverride, ...restOptions } = options;
  const meta = readJson(path.join(jobDir, 'meta.json'));
  const cwd = restOptions.cd || meta?.cwd;
  if (!cwd) throw new Error(`handoff: cwd unknown for ${jobDir} — pass --cd`);
  const brief = buildHandoffBrief({ jobDir, cwd, targetVendor });
  const chosenTier = tier || DEFAULT_TIER[canonicalVendor(targetVendor)];
  const invokeFn = invokeOverride || runner.invoke;
  const result = await invokeFn('run', targetVendor, chosenTier, '-', { ...restOptions, cd: cwd }, brief);
  fs.writeFileSync(path.join(jobDir, 'handoff-to.txt'), `vendor=${targetVendor}\noutDir=${result.outDir}\n`);
  return result;
}

module.exports = { buildHandoffBrief, handoff, DEFAULT_TIER };
