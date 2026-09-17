'use strict';

// Cross-vendor auto-routing: pick the first usable vendor from a priority list (judged from
// lib/status.js row text) and, on quota exhaustion, hand the job off to the next usable vendor
// via lib/handoff.js. A non-quota failure (a code bug, a bad brief) never hops — burning three
// vendors' quota chasing a bug the worker itself caused would defeat the point of routing.

const { homeDir } = require('./util');

const DEFAULT_PRIORITY = ['agy', 'codex', 'grok', 'cursor', 'opencode', 'claude'];

const DEFAULT_TIER = Object.freeze({
  agy: 'flash',
  codex: 'terra',
  grok: 'best',
  claude: 'sonnet',
  cursor: 'auto',
  opencode: 'free'
});

// Quota-ish failure text — separate from lib/failure.js's classifier (which judges a single
// vendor's raw event stream); this one judges a top-level invoke() result to decide whether to
// hop at all.
const QUOTA_TEXT_RE = /quota|exhaust|rate.?limit|\b429\b|\b402\b|usage limit|spend limit|session limit|weekly limit|credit balance/i;

function findRow(rows, vendor) {
  const name = vendor === 'antigravity' ? 'agy' : vendor;
  return (rows || []).find(row => row && row[0] === name);
}

// Unknown-quota policy: when a vendor's row text doesn't confirm 0%, treat it as usable
// (optimistic — falls off the priority list quickly on a real failure) EXCEPT where the row
// text itself means "could not determine, don't trust it" (agy/cursor). Per vendor:
//   codex "usage unavailable"    -> usable   (unknown)
//   grok  "unknown (--probe-grok)" -> usable (unknown)
//   opencode "unknown"           -> usable   (unknown)
//   agy   "usage unavailable" / no gemini bucket -> unusable (can't confirm quota left)
//   cursor "unavailable"         -> unusable (only exact "ok" is usable)
function isClaudeUsable(text) {
  if (text == null) return false;
  const match = /wk (\d+)%/.exec(text);
  if (!match) return true; // "no snapshot" = unknown -> usable, it's the last fallback
  return Number(match[1]) > 0;
}

function isCodexUsable(text) {
  if (text == null) return false;
  if (text === 'logged out') return false;
  if (/EXHAUSTED/.test(text)) return false;
  if (text === 'usage unavailable') return true; // unknown -> usable
  // codex reports raw (unrounded) percentages, e.g. "wk 0.4000000000000057%" -- match a
  // decimal, not just digits, or a fractional-but-still-positive quota reads as 0% and the
  // vendor falls through as usable when it actually has quota left (or vice versa near 0).
  const match = /wk ([\d.]+)%.*5h ([\d.]+)%/.exec(text);
  if (!match) return true; // unrecognized shape -> unknown, usable
  return Number(match[1]) > 0 && Number(match[2]) > 0;
}

function isAgyUsable(text) {
  if (text == null) return false;
  // Default tier for agy is flash (a Gemini tier) -> the gemini bucket is the one that gates
  // it. The claude/gpt bucket only matters for sonnet/opus tiers, which pickVendor does not
  // choose between here (see brief: "for auto default tier flash use the gemini bucket").
  const match = /gemini wk (\d+)%/.exec(text);
  if (!match) return false; // no gemini bucket reported -> can't confirm quota
  return Number(match[1]) > 0;
}

function isGrokUsable(text) {
  if (text == null) return false;
  const lower = text.toLowerCase();
  if (lower.includes('logged out')) return false;
  if (lower.includes('exhausted')) return false;
  return true;
}

function isCursorUsable(text) {
  return text === 'ok';
}

function isOpencodeUsable(text) {
  if (text == null) return false;
  if (text === 'missing') return false;
  if (text === 'logged out') return false;
  return true;
}

const USABLE_CHECKS = Object.freeze({
  claude: isClaudeUsable,
  codex: isCodexUsable,
  agy: isAgyUsable,
  grok: isGrokUsable,
  cursor: isCursorUsable,
  opencode: isOpencodeUsable
});

function pickVendor(rows, priority) {
  const order = priority && priority.length ? priority : DEFAULT_PRIORITY;
  for (const vendorInput of order) {
    const vendor = vendorInput === 'antigravity' ? 'agy' : vendorInput;
    const check = USABLE_CHECKS[vendor];
    if (!check) continue;
    const row = findRow(rows, vendor);
    if (!row) continue;
    if (check(row[1])) return vendor;
  }
  return null;
}

function isQuotaFailure(result) {
  if (!result) return false;
  if (result.exhausted) return true;
  return Boolean(result.failed) && QUOTA_TEXT_RE.test(result.reason || '');
}

async function defaultRows(options = {}) {
  const { claudeRow, codexRow, agyRow, grokRow, cursorRow, opencodeRow } = require('./status');
  const home = options.home || homeDir();
  return Promise.all([
    Promise.resolve(claudeRow(home)),
    codexRow(home),
    agyRow(),
    grokRow(home, options.probeGrok),
    cursorRow(),
    opencodeRow()
  ]);
}

async function runAuto(briefSource, options = {}, stdinText = '') {
  const priority = options.priority
    ? String(options.priority).split(',').map(v => v.trim()).filter(Boolean)
    : DEFAULT_PRIORITY.slice();
  const maxHopsInput = Number(options.maxHops);
  const maxHops = options.maxHops != null && Number.isFinite(maxHopsInput) && maxHopsInput >= 0 ? maxHopsInput : 2;
  const rows = options.rows || await defaultRows(options);
  // Required lazily: lib/handoff.js may not exist yet while this module is developed
  // alongside it, and the real invoke should only be pulled in when actually needed.
  const invoke = options.invoke || require('./runner').invoke;

  let remaining = priority.slice();
  let vendor = pickVendor(rows, remaining);
  if (!vendor) throw new Error(`no vendor with quota; tried: ${priority.join(', ')}`);

  // Always each vendor's own default tier — options.tier is unreachable from the CLI (`run
  // auto` has no per-vendor tier flag, since the vendor itself isn't known until pickVendor
  // runs) and would be wrong on a hop anyway (a tier name from one vendor's tier map means
  // nothing on another vendor).
  let result = await invoke('run', vendor, DEFAULT_TIER[vendor], briefSource, options, stdinText);
  const attempts = [{ vendor, outDir: result.outDir, code: result.code, exhausted: Boolean(result.exhausted) }];

  let hops = 0;
  while (isQuotaFailure(result) && hops < maxHops) {
    remaining = remaining.filter(v => v !== vendor && v !== (vendor === 'agy' ? 'antigravity' : vendor));
    const next = pickVendor(rows, remaining);
    if (!next) break; // nothing left to hop to; return the last (exhausted) result
    console.log(`AUTO: ${vendor} exhausted → handing off to ${next}`);
    const nextTier = DEFAULT_TIER[next];
    const handoffFn = options.handoff || require('./handoff').handoff;
    result = await handoffFn(result.outDir, next, nextTier, options);
    attempts.push({ vendor: next, outDir: result.outDir, code: result.code, exhausted: Boolean(result.exhausted) });
    vendor = next;
    hops++;
  }

  return { code: result.code, vendor, outDir: result.outDir, attempts };
}

module.exports = { DEFAULT_PRIORITY, DEFAULT_TIER, isQuotaFailure, pickVendor, runAuto };
