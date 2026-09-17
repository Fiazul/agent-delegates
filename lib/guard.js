'use strict';

// Critical-work guard: refuses small/cheap models on production-shaped work unless the user
// explicitly overrides, and surfaces which permission mode a worker actually runs with.
//
// Criticality has two tiers:
//   - critical (hard): only from --critical or a guard.paths glob match against cwd/addDir.
//     This is what enforce() actually acts on (refusing non-large tiers).
//   - suspected (heuristic): a guard.keywords hit in the brief text. This NEVER refuses
//     anything on its own — it only surfaces a "CRITICAL?" hint so a human/worker can decide
//     to re-run with --critical. Keyword matching is inherently guessable (a brief mentioning
//     "deployment docs" is not itself critical work), so treating it as a hard gate produced
//     false-positive refusals; it is now advisory only.

const fs = require('node:fs');
const path = require('node:path');
const { CRITICAL_TIER, tierClass } = require('./models');
const { configPath } = require('./util');

const DEFAULT_GUARD = Object.freeze({
  keywords: Object.freeze([
    'production', 'deploy', 'kubectl', 'ssh', 'terraform', 'ansible', 'migrate',
    'DROP TABLE', 'rm -rf', 'secrets', 'payment', 'billing', 'customer data', 'live server'
  ]),
  paths: Object.freeze([])
});

// Word-boundary regexes for keywords whose plain \b-wrapped literal would be too narrow (misses
// real inflections like "deploying"/"migrated") or too loose (a bare substring). Any keyword not
// listed here — including a caller/config-supplied custom keyword — falls back to a generic
// \b-wrapped literal match (genericKeywordRegex below), which is still word-boundary-safe.
const KEYWORD_PATTERNS = Object.freeze({
  production: /\bprod\b|\bproduction\b/i,
  deploy: /\bdeploy(ing|ment|ed|s)?\b/i,
  migrate: /\bmigrat(e|ed|ing|ion|ions)\b/i,
  migration: /\bmigrat(e|ed|ing|ion|ions)\b/i,
  kubectl: /\bkubectl\b/i,
  ssh: /\bssh\b/i,
  terraform: /\bterraform\b/i,
  ansible: /\bansible\b/i,
  'drop table': /\bdrop\s+table\b/i,
  'rm -rf': /\brm\s+-rf\b/i,
  secrets: /\bsecrets?\b/i,
  payment: /\bpayments?\b/i,
  billing: /\bbilling\b/i,
  'customer data': /\bcustomer\s+data\b/i,
  'live server': /\blive\s+server\b/i
});

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function genericKeywordRegex(keyword) {
  return new RegExp(`\\b${escapeRegExp(String(keyword).trim())}\\b`, 'i');
}

function keywordRegex(keyword) {
  return KEYWORD_PATTERNS[String(keyword).trim().toLowerCase()] || genericKeywordRegex(keyword);
}

// Loads only the `guard` key from the shared routing.json config (the same file lib/route.js
// reads for routing). Never writes the file. Missing/invalid file or key -> defaults.
function loadGuardConfig(home) {
  let raw;
  try {
    raw = fs.readFileSync(configPath(home), 'utf8');
  } catch {
    return { keywords: DEFAULT_GUARD.keywords.slice(), paths: DEFAULT_GUARD.paths.slice() };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { keywords: DEFAULT_GUARD.keywords.slice(), paths: DEFAULT_GUARD.paths.slice() };
  }
  const guard = parsed && typeof parsed === 'object' ? parsed.guard : null;
  const keywords = guard && Array.isArray(guard.keywords) ? guard.keywords : DEFAULT_GUARD.keywords.slice();
  const paths = guard && Array.isArray(guard.paths) ? guard.paths : DEFAULT_GUARD.paths.slice();
  return { keywords, paths };
}

// Converts a glob with '*' (any run of chars except path separator) and '**' (any run of chars
// including separators) into a RegExp anchored to the whole string. A trailing '/**' (the
// idiomatic "this dir and everything under it" guard.paths pattern) is special-cased to also
// match the bare directory itself with no trailing slash — a plain '/**' -> '/.*' regex requires
// at least a slash after the prefix, so cwd === the guarded root exactly (no trailing segment)
// would silently NOT match, which is exactly the case that most needs to match.
function globToRegExp(glob, caseInsensitive) {
  const trailingDoubleStar = glob.endsWith('/**');
  const base = trailingDoubleStar ? glob.slice(0, -3) : glob;
  let out = '';
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    if (ch === '*') {
      if (base[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/\\\\]*';
      }
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  if (trailingDoubleStar) out += '(?:/.*)?';
  return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
}

// Backslashes are normalized to forward slashes unconditionally (not just on win32) so a
// guard.paths entry authored with Windows-style separators still matches a Windows cwd/addDir
// even if this process itself is somehow not reporting win32 (and it's a no-op for ordinary
// POSIX paths, which essentially never contain a literal backslash). Case-insensitivity stays
// win32-only — POSIX filesystems are case-sensitive.
function pathMatches(glob, candidate) {
  if (!candidate) return false;
  const caseInsensitive = process.platform === 'win32';
  const normCandidate = String(candidate).replace(/\\/g, '/');
  const normGlob = String(glob).replace(/\\/g, '/');
  try {
    return globToRegExp(normGlob, caseInsensitive).test(normCandidate);
  } catch {
    return false;
  }
}

function keywordMatches(keyword, text) {
  return keywordRegex(keyword).test(text);
}

// Caps a list to `max` entries, appending a single "+N more" summary entry when truncated.
// Used everywhere a reasons/hints list gets embedded in a message or worker prompt, so a
// pathological guard config (dozens of keywords) can never blow up a refusal message or a
// worker's prompt.
function capList(list, max = 5) {
  if (!list || list.length <= max) return list || [];
  return [...list.slice(0, max), `+${list.length - max} more`];
}

// assessCriticality: `critical` (hard) comes ONLY from --critical or a guard.paths glob match —
// this is what enforce() acts on. `suspected` (heuristic) comes from guard.keywords hits in the
// brief text — advisory only, surfaced as `hints`, never a refusal on its own.
function assessCriticality({ brief = '', cwd = '', addDir = [], options = {}, config } = {}) {
  const guard = config || DEFAULT_GUARD;
  const reasons = [];
  const hints = [];

  if (options.critical) reasons.push('--critical flag set');

  // Resolve cwd/addDir to absolute paths once, here, so a relative --add-dir (or a relative cwd)
  // is judged against guard.paths the same way regardless of caller — lib/runner.js's invoke()
  // and lib/route.js's runAuto() both call this function and must agree on the verdict for the
  // same inputs; resolving only in one of them let a relative path slip past the guard in the
  // other.
  const candidates = [cwd || process.cwd(), ...(addDir || [])].filter(Boolean).map(candidate => path.resolve(candidate));
  for (const glob of guard.paths || []) {
    for (const candidate of candidates) {
      if (pathMatches(glob, candidate)) {
        reasons.push(`path "${candidate}" matches guard path "${glob}"`);
      }
    }
  }

  const text = String(brief || '');
  for (const keyword of guard.keywords || []) {
    if (keywordMatches(keyword, text)) {
      hints.push(`heuristic: keyword "${String(keyword).trim()}" in brief`);
    }
  }

  return { critical: reasons.length > 0, suspected: hints.length > 0, reasons, hints };
}

function permissionMode(vendor, options = {}) {
  if (vendor === 'codex') {
    return `sandbox ${options.ro ? 'read-only' : 'workspace-write'} (no bypass)`;
  }
  if (vendor === 'agy') {
    return options.safe ? 'accept-edits' : 'FULL BYPASS (--dangerously-skip-permissions; pass --safe to restrict)';
  }
  if (options.yolo) return 'FULL BYPASS (--yolo)';
  if (vendor === 'claude') return 'acceptEdits';
  if (vendor === 'cursor') return 'trust workspace, no --force';
  if (vendor === 'grok') return 'approval prompts';
  if (vendor === 'opencode') return 'default approvals';
  return 'unknown';
}

const BYPASS_WARNING_SUFFIX = 'the worker can run destructive commands — consider --safe (agy) or omitting --yolo';

function bypassWarning(vendor) {
  return `critical work with full bypass permissions on ${vendor}; ${BYPASS_WARNING_SUFFIX}`;
}

// On critical (hard) work only a 'large'-class model may run. Standard and small tiers are both
// refused (a mid-tier model must not make decisions on a production system), and an unresolvable
// raw model slug ('unknown') is treated as not-large and refused on critical work — a typo in a
// model slug must never bypass the guard by accident. Suspected-only (heuristic) work never
// refuses here; see runner.js for the advisory "CRITICAL?" print.
function enforce({ vendor, tier, model, critical, reasons = [], options = {}, mode } = {}) {
  const warnings = [];
  const mode_ = permissionMode(vendor, options);

  const cls = tierClass(vendor, model || tier);

  // resume never refuses — the recorded model is reused unless --tier/--model pins another — but
  // it must still WARN when the follow-up brief reassesses as critical on a small/standard
  // model, so a human watching the console sees it rather than the guard silently going quiet
  // just because this is a follow-up turn.
  if (mode === 'resume') {
    if (critical && cls !== 'large') {
      // m3: `tier` on a resume call is actually the thread/session id (invoke() passes
      // `tierOrId`, not a tier name) — printing it here read like "codex a1b2c3-thread-id is a
      // small model", which is nonsense. Print the resolved model instead. Also reworded: resume
      // --tier/--model now exists (resolveResumeModel), so the model CAN be pinned on a resumed
      // thread — it just wasn't done here, rather than "can't change".
      warnings.push(`CRITICAL WORK on resume (${capList(reasons, 5).join('; ')}): ${vendor} ${model || 'vendor default'} is a ${cls} model; pass --tier/--model to pin a large model on this resumed thread instead.`);
    }
    if (critical && /BYPASS/.test(mode_)) warnings.push(bypassWarning(vendor));
    return { ok: true, message: '', warnings };
  }

  if (critical) {
    if (cls !== 'large' && !options.allowSmall) {
      const suggestion = CRITICAL_TIER[vendor] || 'a vendor with a large tier (codex sol/astra, agy opus, claude opus, grok best)';
      return {
        ok: false,
        message: `CRITICAL WORK (${capList(reasons, 5).join('; ')}): ${vendor} ${tier} is a ${cls} model; critical work requires a large model. Use ${suggestion} or pass --allow-small to override (not recommended).`,
        warnings
      };
    }
    // R12: --allow-small is a deliberate, risky override — it must never silently pass. Only
    // fires when the override actually mattered (cls !== 'large'); a large model on critical
    // work needed no override, so no warning is owed there.
    if (cls !== 'large' && options.allowSmall) {
      warnings.push(`--allow-small override in effect: critical work (${capList(reasons, 5).join('; ')}) running on ${vendor} ${tier}, a ${cls} model.`);
    }
    if (/BYPASS/.test(mode_)) warnings.push(bypassWarning(vendor));
  }

  return { ok: true, message: '', warnings };
}

module.exports = {
  DEFAULT_GUARD, assessCriticality, capList, configPath, enforce, globToRegExp, keywordRegex,
  loadGuardConfig, pathMatches, permissionMode
};
