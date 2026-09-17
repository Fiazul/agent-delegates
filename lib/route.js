'use strict';

// Cross-vendor auto-routing: pick the first usable vendor from a priority list (judged from
// lib/status.js row text) and, on quota exhaustion, hand the job off to the next usable vendor
// via lib/handoff.js. A non-quota failure (a code bug, a bad brief) never hops — burning three
// vendors' quota chasing a bug the worker itself caused would defeat the point of routing.

const fs = require('node:fs');
const path = require('node:path');
const { homeDir, readJson, writeJson } = require('./util');
const { CRITICAL_TIER, DEFAULT_TIER } = require('./models');

const DEFAULT_PRIORITY = ['agy', 'codex', 'grok', 'cursor', 'opencode', 'claude'];
const DEFAULT_ROWS_TTL_MINUTES = 10;

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
//   codex "usage unavailable"           -> usable   (unknown)
//   grok  "logged in · quota via --probe-grok" -> usable (unknown)
//   opencode "logged in · no quota API" -> usable   (unknown)
//   agy   "usage unavailable" / no gemini bucket -> unusable (can't confirm quota left)
//   cursor "unavailable"                -> unusable (only exact "logged in · no quota API" is usable)
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
  if (text == null) return false;
  if (text === 'logged in · no quota API') return true; // no token / API unreachable -> unknown, usable
  const match = /^included (\d+)% left/.exec(text);
  if (match) return Number(match[1]) > 0; // real quota confirmed -> usable only if something's left
  return false; // 'missing' / 'logged out' / 'unavailable' -> unusable
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
    agyRow(home),
    grokRow(home, options.probeGrok),
    cursorRow(home),
    opencodeRow()
  ]);
}

// H3: `<console cache dir>/rows.json` — the same directory lib/console.js's consoleRoot() uses
// (~/.cache/delegates on POSIX, %LOCALAPPDATA%/delegates on Windows; DELEGATE_CONSOLE_DIR
// overrides both, which also gives tests free isolation from a real HOME).
function rowsCachePath() {
  const { consoleRoot } = require('./console');
  return path.join(consoleRoot(), 'rows.json');
}

function writeRowsCache(rows) {
  try { writeJson(rowsCachePath(), { ts: Date.now(), rows }); } catch { /* best-effort cache */ }
}

function readRowsCache() {
  return readJson(rowsCachePath(), null);
}

// H3: route-check/pick/run auto used to call defaultRows() — six vendor probes, several of them
// real subprocess spawns — on every single invocation, including calls that just want "should I
// stay on Claude" many times a session (the UserPromptSubmit/PreToolUse hook chain). cachedRows()
// reads the rows.json cache written by `status` (which always probes for real) when it's younger
// than `rowsTtlMinutes` (config key, default DEFAULT_ROWS_TTL_MINUTES), and only probes — via
// `options.probeRows` when injected (tests), else the real defaultRows — when the cache is
// missing, stale, or the caller passes `probe: true` (the CLI's `--probe` flag). Every probe,
// cached-path or not, refreshes the cache.
async function cachedRows(options = {}) {
  const home = options.home || homeDir();
  const probeFn = options.probeRows || defaultRows;
  if (!options.probe) {
    let ttlMinutes = options.rowsTtlMinutes;
    if (ttlMinutes == null) {
      try { ttlMinutes = require('./policy').loadConfig(home).rowsTtlMinutes; } catch { ttlMinutes = DEFAULT_ROWS_TTL_MINUTES; }
    }
    if (ttlMinutes == null) ttlMinutes = DEFAULT_ROWS_TTL_MINUTES;
    const cache = readRowsCache();
    if (cache && Number.isFinite(cache.ts) && Array.isArray(cache.rows) && (Date.now() - cache.ts) < ttlMinutes * 60000) {
      return cache.rows;
    }
  }
  const rows = await probeFn(options);
  writeRowsCache(rows);
  return rows;
}

async function runAuto(briefSource, options = {}, stdinText = '') {
  let priority = options.priority
    ? String(options.priority).split(',').map(v => v.trim()).filter(Boolean)
    : DEFAULT_PRIORITY.slice();

  const maxHopsInput = Number(options.maxHops);
  const maxHops = options.maxHops != null && Number.isFinite(maxHopsInput) && maxHopsInput >= 0 ? maxHopsInput : 2;
  const rows = options.rows || await cachedRows(options);

  // Criticality is assessed once up front (not per-hop): the brief text and cwd/addDir don't
  // change across hops, so the verdict wouldn't either. Best-effort read: a failure here (e.g. a
  // test brief path that doesn't exist) must not crash routing before invoke() gets a chance to
  // read the real brief itself and fail with a clear error there.
  let briefText = '';
  if (briefSource === '-') briefText = stdinText;
  else { try { briefText = fs.readFileSync(briefSource, 'utf8'); } catch { briefText = ''; } }
  const { assessCriticality, capList, loadGuardConfig } = require('./guard');
  const assess = options.assess || assessCriticality;
  const { critical, suspected, hints } = assess({
    brief: briefText,
    cwd: options.cd || '',
    addDir: options.addDir || [],
    options,
    config: loadGuardConfig(homeDir())
  });

  // Only hard critical (--critical / a guard.paths glob) drives the tier upgrade + cursor/
  // opencode skip. Suspected-only (a keyword hint) is advisory: print it once and route with
  // each vendor's normal default tier — a heuristic guess must never silently change which
  // model class or vendors get used.
  if (suspected && !critical) {
    for (const hint of capList(hints, 5)) console.log(`AUTO: CRITICAL? ${hint} — pass --critical if this touches live systems`);
  }

  let tierFor = vendor => DEFAULT_TIER[vendor];
  if (critical) {
    if (options.allowSmall) {
      console.log('AUTO: critical work, --allow-small given');
    } else {
      const skipped = priority.filter(v => CRITICAL_TIER[v === 'antigravity' ? 'agy' : v] == null);
      if (skipped.length) console.log(`AUTO: critical work — large models only; skipping ${skipped.join(', ')}`);
      priority = priority.filter(v => CRITICAL_TIER[v === 'antigravity' ? 'agy' : v] != null);
      tierFor = vendor => CRITICAL_TIER[vendor];
    }
  }

  if (options.respectPolicy !== false) {
    // options.decide (tests): a sync/async fn returning {route, reason, ...} directly.
    // Default (production): the full routeCheck IO path, fed the rows already fetched above so
    // this doesn't refetch vendor status a second time.
    const decideFn = options.decide || (() => require('./policy').routeCheck({ rows }));
    const decision = await decideFn();
    if (decision && decision.route === 'claude') {
      priority = ['claude', ...priority.filter(v => v !== 'claude')];
      console.log(`AUTO: policy says stay on Claude (${decision.reason})`);
    }
  }

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
  let result = await invoke('run', vendor, tierFor(vendor), briefSource, options, stdinText);
  const attempts = [{ vendor, outDir: result.outDir, code: result.code, exhausted: Boolean(result.exhausted) }];

  let hops = 0;
  while (isQuotaFailure(result) && hops < maxHops) {
    remaining = remaining.filter(v => v !== vendor && v !== (vendor === 'agy' ? 'antigravity' : vendor));
    const next = pickVendor(rows, remaining);
    if (!next) break; // nothing left to hop to; return the last (exhausted) result
    console.log(`AUTO: ${vendor} exhausted → handing off to ${next}`);
    const nextTier = tierFor(next);
    const handoffFn = options.handoff || require('./handoff').handoff;
    result = await handoffFn(result.outDir, next, nextTier, { ...options, critical });
    attempts.push({ vendor: next, outDir: result.outDir, code: result.code, exhausted: Boolean(result.exhausted) });
    vendor = next;
    hops++;
  }

  return { code: result.code, vendor, outDir: result.outDir, attempts };
}

module.exports = {
  DEFAULT_PRIORITY, DEFAULT_ROWS_TTL_MINUTES, DEFAULT_TIER, cachedRows, defaultRows,
  isQuotaFailure, pickVendor, readRowsCache, rowsCachePath, runAuto, writeRowsCache
};
