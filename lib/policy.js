'use strict';

// Pace-based routing policy: decides whether the orchestrator should route non-trivial work to
// an external vendor or stay on Claude, based on a rate_limits.json snapshot (written by
// extras/statusline.js) and a small config file. Pure and unit-tested with literal snapshots and
// a fixed `now` — no filesystem or vendor calls happen inside decide().

const path = require('node:path');
const { configPath, homeDir, readJson } = require('./util');

const DEFAULTS = Object.freeze({
  mode: 'pace',
  threshold: 40,
  slack: 10,
  slack5h: 15,
  fiveHourCap: 80,
  hardCap: 70,
  staleMinutes: 10,
  // H3: how long a cached vendor-status probe (lib/route.js's rows.json cache) stays fresh
  // before route-check/pick/run auto re-probe instead of reading it.
  rowsTtlMinutes: 10,
  priority: ['agy', 'codex', 'grok', 'cursor', 'opencode', 'claude']
});

const WEEK_SECONDS = 7 * 86400;
const FIVE_HOUR_SECONDS = 5 * 3600;

function loadConfig(home) {
  const raw = readJson(configPath(home), null);
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!Array.isArray(merged.priority) || !merged.priority.length) merged.priority = DEFAULTS.priority.slice();
  return merged;
}

// Shared config-write helper (used by lib/install.js's setup wizard to persist a chosen
// `priority`). Reads the raw file as-is (not merged over DEFAULTS — this must never bake the
// full default object into the user's file), shallow-merges `patch` over it, and writes back
// with the directory created as needed. Preserves every other key untouched.
function saveConfig(home, patch) {
  const fs = require('node:fs');
  const file = configPath(home);
  let existing = readJson(file, null);
  if (!existing || typeof existing !== 'object') existing = {};
  const merged = { ...existing, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function round1(value) {
  return value == null ? value : Math.round(value * 10) / 10;
}

function applyExternalAvailability(result, externalAvailable) {
  if (result.route === 'external' && externalAvailable === false) {
    return { ...result, route: 'claude', reason: 'external vendors exhausted; stay on Claude' };
  }
  return result;
}

// decide({ snapshot, config, now, externalAvailable }) -> { route, reason, claudeWk, fiveHour, elapsedPct, stale }
function decide(args = {}) {
  // L4: loadConfig(home) needs a home dir — calling it with none passed `undefined` into
  // path.join() inside configPath(), throwing before decide() ever got a chance to fall back to
  // defaults. homeDir() is the same default every other caller in this file already uses.
  const config = args.config || loadConfig(homeDir());
  const now = args.now != null ? args.now : Math.floor(Date.now() / 1000);
  const { snapshot, externalAvailable } = args;

  if (!snapshot || typeof snapshot.ts !== 'number') {
    return applyExternalAvailability({
      route: 'unknown',
      reason: 'no Claude quota snapshot',
      claudeWk: null,
      fiveHour: null,
      elapsedPct: null,
      stale: true
    }, externalAvailable);
  }

  const staleMinutes = config.staleMinutes != null ? config.staleMinutes : DEFAULTS.staleMinutes;
  const ageSeconds = now - snapshot.ts;
  // Raw (full-precision) values drive every comparison below; `claudeWk`/`fiveHour` (rounded to
  // 1 decimal) are what's returned and interpolated into reason text — a rounding difference of
  // a few hundredths of a percent must never flip a route decision.
  const claudeWkRaw = Number.isFinite(Number(snapshot.seven_day?.used_percentage)) ? Number(snapshot.seven_day.used_percentage) : null;
  const fiveHourRaw = Number.isFinite(Number(snapshot.five_hour?.used_percentage)) ? Number(snapshot.five_hour.used_percentage) : null;
  const claudeWk = round1(claudeWkRaw);
  const fiveHour = round1(fiveHourRaw);

  if (ageSeconds > staleMinutes * 60) {
    const ageMinutes = Math.round(ageSeconds / 60);
    return applyExternalAvailability({
      route: 'unknown',
      reason: `Claude quota snapshot is ${ageMinutes}m old (stale > ${staleMinutes}m)`,
      claudeWk,
      fiveHour,
      elapsedPct: null,
      stale: true
    }, externalAvailable);
  }

  let mode = config.mode === 'fixed' ? 'fixed' : 'pace';
  let elapsedPctRaw = null;
  const resetsAt = snapshot.seven_day?.resets_at;

  if (mode === 'pace') {
    if (typeof resetsAt === 'number') {
      const secondsLeft = resetsAt - now;
      elapsedPctRaw = clamp(100 * (1 - secondsLeft / WEEK_SECONDS), 0, 100);
    } else {
      mode = 'fixed'; // no resets_at to compute pace against -> fall back
    }
  }
  const elapsedPct = round1(elapsedPctRaw);

  if (mode === 'fixed') {
    const threshold = config.threshold != null ? config.threshold : DEFAULTS.threshold;
    const route = claudeWkRaw != null && claudeWkRaw >= threshold ? 'external' : 'claude';
    return applyExternalAvailability({
      route,
      reason: `wk ${claudeWk}% used ${route === 'external' ? '>=' : '<'} fixed threshold ${threshold}%`,
      claudeWk,
      fiveHour,
      elapsedPct: null,
      stale: false
    }, externalAvailable);
  }

  // pace mode
  const slack = config.slack != null ? config.slack : DEFAULTS.slack;
  const slack5h = config.slack5h != null ? config.slack5h : DEFAULTS.slack5h;
  const fiveHourCap = config.fiveHourCap != null ? config.fiveHourCap : DEFAULTS.fiveHourCap;
  const hardCap = config.hardCap != null ? config.hardCap : DEFAULTS.hardCap;

  let fiveHourElapsedPctRaw = null;
  const fiveHourResetsAt = snapshot.five_hour?.resets_at;
  if (typeof fiveHourResetsAt === 'number') {
    const secondsLeft5h = fiveHourResetsAt - now;
    fiveHourElapsedPctRaw = clamp(100 * (1 - secondsLeft5h / FIVE_HOUR_SECONDS), 0, 100);
  }

  if (claudeWkRaw != null && claudeWkRaw >= hardCap) {
    return applyExternalAvailability({
      route: 'external', reason: `wk ${claudeWk}% used >= hard cap ${hardCap}%`, claudeWk, fiveHour, elapsedPct, stale: false
    }, externalAvailable);
  }
  if (fiveHourRaw != null && fiveHourRaw >= fiveHourCap) {
    return applyExternalAvailability({
      route: 'external', reason: `5h ${fiveHour}% used >= 5h cap ${fiveHourCap}%`, claudeWk, fiveHour, elapsedPct, stale: false
    }, externalAvailable);
  }
  // 5h pace rule mirrors the weekly one, over the 5-hour window; skipped entirely when
  // five_hour.resets_at isn't in the snapshot (nothing to compute elapsed% against).
  if (fiveHourRaw != null && fiveHourElapsedPctRaw != null && fiveHourRaw > fiveHourElapsedPctRaw + slack5h) {
    return applyExternalAvailability({
      route: 'external',
      reason: `5h ${fiveHour}% used vs ${round1(fiveHourElapsedPctRaw)}% of window elapsed (+${slack5h} slack)`,
      claudeWk, fiveHour, elapsedPct, stale: false
    }, externalAvailable);
  }
  if (claudeWkRaw != null && claudeWkRaw > elapsedPctRaw + slack) {
    return applyExternalAvailability({
      route: 'external',
      reason: `wk ${claudeWk}% used vs ${elapsedPct}% of week elapsed (+${slack} slack)`,
      claudeWk, fiveHour, elapsedPct, stale: false
    }, externalAvailable);
  }
  return applyExternalAvailability({
    route: 'claude',
    reason: `wk ${claudeWk}% used vs ${elapsedPct}% of week elapsed (+${slack} slack); within pace`,
    claudeWk, fiveHour, elapsedPct, stale: false
  }, externalAvailable);
}

// route-check orchestration: loads config + snapshot from home, computes externalAvailable via
// lib/route.js pickVendor over status rows excluding claude, and runs decide(). Injectable
// (options.config/options.snapshot/options.rows/options.now/options.externalAvailable) for tests.
async function routeCheck(options = {}) {
  const home = options.home || homeDir();
  const config = options.config || loadConfig(home);
  const snapshot = options.snapshot !== undefined
    ? options.snapshot
    : readJson(path.join(home, '.claude', 'rate_limits.json'));
  const now = options.now != null ? options.now : Math.floor(Date.now() / 1000);

  let rows = options.rows;
  let externalAvailable = options.externalAvailable;
  const { pickVendor, cachedRows } = require('./route');
  const extPriority = (config.priority || DEFAULTS.priority).filter(v => v !== 'claude');

  if (externalAvailable === undefined) {
    if (rows === undefined) {
      // H3: cachedRows reads <console cache dir>/rows.json when fresh instead of re-probing all
      // six vendors on every route-check call; options.probe (the CLI's --probe flag) forces a
      // real probe, and options.probeRows lets tests inject a counting stub in place of the real
      // defaultRows prober.
      try {
        rows = await cachedRows({ home, probe: options.probe, rowsTtlMinutes: config.rowsTtlMinutes, probeRows: options.probeRows });
      } catch { rows = undefined; }
    }
    if (rows !== undefined) externalAvailable = Boolean(pickVendor(rows, extPriority));
  }

  const result = decide({ snapshot, config, now, externalAvailable });
  let nextVendor = null;
  if (rows !== undefined) nextVendor = pickVendor(rows, extPriority);
  return { ...result, nextVendor };
}

const SUGGEST_CLAUDE = 'Claude subagent via the Agent tool (e.g. a Sonnet worker; Opus for review)';

// pick({ critical, ...routeCheck-style injection }) -> the one-line pre-spawn decision. Runs
// routeCheck(); when it says stay on Claude (or the snapshot is unknown/stale), says so and
// suggests a Claude subagent. When it says external, picks the actual vendor+tier to use
// (critical work is filtered to vendors with a CRITICAL_TIER and uses that tier; otherwise each
// vendor's DEFAULT_TIER) and hands back the exact `run` command. If no external vendor is
// actually usable (e.g. everything's exhausted, or critical work has nothing left standing
// after filtering to large-tier vendors), downgrades to route "none" and suggests Claude too.
async function pick(options = {}) {
  const { pickVendor, cachedRows } = require('./route');
  const { CRITICAL_TIER, DEFAULT_TIER } = require('./models');

  const critical = Boolean(options.critical);
  const home = options.home || homeDir();
  const config = options.config || loadConfig(home);

  let rows = options.rows;
  if (rows === undefined && options.externalAvailable === undefined) {
    try {
      rows = await cachedRows({ home, probe: options.probe, rowsTtlMinutes: config.rowsTtlMinutes, probeRows: options.probeRows });
    } catch { rows = undefined; }
  }

  const result = await routeCheck({ ...options, home, config, rows });

  if (result.route === 'claude' || result.route === 'unknown') {
    return { route: result.route, reason: result.reason, suggest: SUGGEST_CLAUDE };
  }

  // route === 'external'
  let priority = (config.priority || DEFAULTS.priority).filter(v => v !== 'claude');
  if (critical) priority = priority.filter(v => CRITICAL_TIER[v] != null);
  // pickVendor treats an empty array as "no priority given" and falls back to its own default
  // order — guard against that here so an all-filtered-out critical priority correctly means
  // "nothing usable", not "search everything again".
  const vendor = rows !== undefined && priority.length ? pickVendor(rows, priority) : null;

  if (!vendor) {
    return { route: 'none', reason: 'all external vendors exhausted or logged out; stay on Claude', suggest: SUGGEST_CLAUDE };
  }

  const tier = critical ? CRITICAL_TIER[vendor] : DEFAULT_TIER[vendor];
  const command = `agent-delegates run ${vendor} ${tier} BRIEF.md --cd <dir>${critical ? ' --critical' : ''}`;
  return { route: 'external', vendor, tier, critical, reason: result.reason, command };
}

function formatPick(result) {
  if (result.route === 'external') {
    return `pick: route=external  vendor=${result.vendor} tier=${result.tier}${result.critical ? ' (critical)' : ''}  reason: ${result.reason}  → ${result.command}`;
  }
  return `pick: route=${result.route}  reason: ${result.reason}  suggest: ${result.suggest}`;
}

function formatRouteCheck(result) {
  const wk = result.claudeWk == null ? '?' : `${result.claudeWk}%`;
  const fh = result.fiveHour == null ? '?' : `${result.fiveHour}%`;
  const elapsed = result.elapsedPct == null ? '?' : `${round1(result.elapsedPct)}%`;
  const next = result.nextVendor ? `  next=${result.nextVendor}` : '';
  return `route=${result.route}  wk ${wk} used · 5h ${fh} · ${elapsed} of week elapsed · reason: ${result.reason}${next}`;
}

module.exports = { DEFAULTS, configPath, decide, formatPick, formatRouteCheck, loadConfig, pick, routeCheck, saveConfig };
