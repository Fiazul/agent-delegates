'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exists, homeDir, packageRoot, readJson, shellQuote, timestamp, writeJson } = require('./util');
const { VENDORS, commandExists, setupVendorClis } = require('./vendor-setup');

const MAIN_CHOICES = Object.freeze(['claude', 'codex', 'cursor', 'all']);
const ALIAS_NAME = { cursor: 'cursor-agent', grok: 'grok' };
const MAIN_COMMAND = Object.freeze({ claude: 'claude', codex: 'codex', cursor: 'cursor-agent' });
const MAIN_SKILL_DIR = Object.freeze({ claude: '.claude', codex: '.agents', cursor: '.cursor' });
const DELEGATE_MENU = Object.freeze({ 1: 'agy', 2: 'codex', 3: 'grok', 4: 'claude', 5: 'cursor', 6: 'opencode' });
const DELEGATE_IDS = Object.freeze(['agy', 'codex', 'grok', 'claude', 'cursor', 'opencode']);
const DEFAULT_DELEGATES = Object.freeze(['agy', 'codex', 'grok']);

async function defaultTextPrompt(question) {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let settled = false;
    const finish = answer => { if (!settled) { settled = true; resolve(String(answer || '').trim()); } };
    rl.on('close', () => finish(''));
    rl.on('SIGINT', () => { rl.close(); finish(''); });
    rl.question(question, answer => { finish(answer); rl.close(); });
  });
}

const SKILLS = ['delegate-codex', 'delegate-antigravity', 'delegate-grok', 'delegate-claude', 'delegate-cursor', 'delegate-opencode', 'delegates'];

// Parses settings.json once, up front, before any file (stub, statusline copy, settings.json
// itself) gets written — a malformed existing file must fail loudly and immediately, not after
// some other artifact has already been written and left the install half-done. Missing file ->
// {} (nothing to preserve). Malformed JSON -> a clear, actionable Error.
function readSettingsOrThrow(settingsFile) {
  if (!exists(settingsFile)) return {};
  const raw = fs.readFileSync(settingsFile, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('~/.claude/settings.json is not valid JSON — fix it or pass --no-statusline --no-hook');
  }
}

// If the user still has the old fixed-40%-rule bash hook (~/.claude/delegate-nudge.sh, from
// before this pace-based Node hook existed) wired into UserPromptSubmit, its fixed threshold
// will contradict the new pace-based one. Warn, but never touch or remove it automatically —
// that file and its settings.json entry belong to the user, not to this installer.
function warnLegacyHook(settings, log) {
  const list = settings.hooks?.UserPromptSubmit;
  if (!Array.isArray(list)) return;
  const hasLegacy = list.some(entry => Array.isArray(entry?.hooks) &&
    entry.hooks.some(h => typeof h?.command === 'string' && h.command.includes('delegate-nudge.sh')));
  if (hasLegacy) {
    log('WARNING: legacy delegate-nudge.sh hook found in settings.json — it uses a fixed 40% rule and will contradict the pace-based hook; remove it');
  }
}

function removeManagedLink(target, log) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { return; }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    log(`removed ${target}`);
  }
}

function appendAlias(home, uninstall, log) {
  if (process.platform === 'win32') return;
  for (const filename of ['.bashrc', '.zshrc']) {
    const file = path.join(home, filename);
    if (!exists(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.split(/\r?\n/).filter(line => !/^\s*alias delegates=/.test(line));
    if (uninstall) {
      if (lines.join('\n') !== original) fs.writeFileSync(file, lines.join('\n'));
      continue;
    }
    if (lines.length && lines.at(-1) !== '') lines.push('');
    const command = [process.execPath, path.join(packageRoot(), 'bin', 'cli.js'), 'status'].map(shellQuote).join(' ');
    lines.push('alias delegates=' + shellQuote(command));
    fs.writeFileSync(file, lines.join('\n'));
    log(`alias added to ~/${filename}`);
  }
}

// Opt-in alias lines for cursor-agent/grok, each preceded by a recognizable '# agent-delegates'
// marker so uninstall can remove exactly these lines (and nothing the user wrote themselves) —
// same append/uninstall shape as appendAlias() above, just marker-guarded since these are two
// separate alias names rather than one fixed 'delegates' name.
// M4: idempotent — a second call (e.g. a re-run of `install`) must not pile up a second
// duplicate pair of alias lines. removeBinAliases()'s own marker-guarded filter is reused here
// as the de-dup mechanism: strip any agent-delegates-managed alias lines first, then append the
// current set fresh, so re-running always leaves exactly one pair per resolved binary.
function appendBinAliases(home, bins, log) {
  if (process.platform === 'win32') return;
  const wanted = [];
  if (bins?.cursor) wanted.push(['cursor-agent', bins.cursor]);
  if (bins?.grok) wanted.push(['grok', bins.grok]);
  if (!wanted.length) return;
  removeBinAliases(home, () => {}); // silent: this is de-dup housekeeping, not a user-facing removal
  for (const filename of ['.bashrc', '.zshrc']) {
    const file = path.join(home, filename);
    if (!exists(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    if (lines.length && lines.at(-1) !== '') lines.push('');
    for (const [name, target] of wanted) {
      lines.push('# agent-delegates');
      lines.push(`alias ${name}=${shellQuote(target)}`);
    }
    fs.writeFileSync(file, lines.join('\n'));
    log(`aliases added to ~/${filename}: ${wanted.map(w => w[0]).join(', ')}`);
  }
}

function removeBinAliases(home, log) {
  if (process.platform === 'win32') return;
  for (const filename of ['.bashrc', '.zshrc']) {
    const file = path.join(home, filename);
    if (!exists(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const kept = [];
    let removed = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '# agent-delegates' && /^alias (cursor-agent|grok)=/.test(lines[i + 1] || '')) {
        i++; // skip the marker and the alias line together
        removed = true;
        continue;
      }
      kept.push(lines[i]);
    }
    if (removed) {
      fs.writeFileSync(file, kept.join('\n'));
      log(`removed agent-delegates aliases from ~/${filename}`);
    }
  }
}

// lib/bins.js (resolveBin/detectAgentCollision) is owned by another worker landing concurrently
// — require it lazily and tolerate its absence so this file keeps working before/without it.
// Tests inject options.detectAgentCollision/options.resolveBin directly instead of relying on
// the real module.
function loadBinsModule(options) {
  if (options.detectAgentCollision || options.resolveBin) {
    return { detectAgentCollision: options.detectAgentCollision, resolveBin: options.resolveBin };
  }
  try {
    return require('./bins');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

// Only these two owners are ever candidates for removal; an 'unknown' (or any other) owner is
// never touched, no matter what its realpath looks like.
const CANONICAL_NAME = Object.freeze({ cursor: 'cursor-agent', grok: 'grok' });

// A collision entry is a safe-to-remove duplicate only when: its owner is cursor or grok, the
// `agent` entry itself is a SYMLINK (never a regular file — that could be the vendor's actual
// binary), and that symlink's realpath is reachable under the vendor's canonical name in the
// SAME directory (e.g. .grok/bin/agent -> .grok/bin/grok). Anything else (regular file, no
// matching canonical name, realpath lookup failure, unknown owner) is left alone.
function findRemovableDuplicates(collisions) {
  const removable = [];
  for (const c of collisions || []) {
    if (!c || (c.owner !== 'cursor' && c.owner !== 'grok')) continue;
    let stat;
    try { stat = fs.lstatSync(c.path); } catch { continue; }
    if (!stat.isSymbolicLink()) continue;
    const canonicalPath = path.join(path.dirname(c.path), CANONICAL_NAME[c.owner]);
    if (canonicalPath === c.path) continue;
    let canonicalReal, entryReal;
    try {
      canonicalReal = fs.realpathSync(canonicalPath);
      entryReal = fs.realpathSync(c.path);
    } catch { continue; }
    if (canonicalReal === entryReal) removable.push({ ...c, canonicalPath });
  }
  return removable;
}

// Reversible: renames the duplicate symlink aside rather than deleting it outright.
function applyAgentConflictResolution(removable, log) {
  for (const item of removable) {
    const backup = `${item.path}.agent-delegates-bak`;
    try {
      fs.renameSync(item.path, backup);
      log(`moved ${item.path} -> ${backup} (reversible: rename it back to restore it)`);
    } catch (error) {
      log(`could not move ${item.path}: ${error.message}`);
    }
  }
}

// Mirrors lib/bins.js's assessAgentConflict, but works off an already-fetched, ordered hits
// array instead of live env detection — install.js's tests (and the pre-install snapshot taken
// before setupVendorClis runs) inject/capture `detectAgentCollision` results directly. Category
// fix: "conflict" means "the effective `agent` (PATH order, first hit) is wrong", not "two owners
// exist somewhere on PATH". If Cursor's own `agent` wins PATH resolution, or Cursor never
// provides one at all among these hits, there is nothing to warn about — no matter how many other
// `agent` launchers exist further down.
function deriveAgentConflict(hits) {
  const list = hits || [];
  const effective = list.length ? list[0] : null;
  const cursorOwned = list.some(c => c.owner === 'cursor');
  const conflict = cursorOwned && !!effective && effective.owner !== 'cursor';
  return { effective, cursorOwned, conflict };
}

// Cursor and Grok both installing a launcher literally named `agent` is a real footgun for the
// user's own shell (whichever comes first on PATH silently wins) — but agent-delegates itself
// never calls the bare `agent` name (it resolves cursor-agent/grok explicitly), so this is purely
// advisory for the user, never a hard blocker. Default answer is always No; nothing is ever
// deleted, only renamed aside (reversible). Only called when deriveAgentConflict(collisions) is
// actually true (Cursor's own `agent` is being shadowed) — a harmless second launcher behind a
// correctly-resolving Cursor `agent` gets at most a single NOTE line from the caller instead.
async function handleAgentConflict(options, collisions, preOwners, preExisted, isTTY, promptText, log) {
  const removable = findRemovableDuplicates(collisions);

  // Wording depends on whether the collision already existed before this install run touched
  // anything, or whether installing Cursor/Grok just now is what created it.
  let headline = 'CONFLICT: two tools on this system both provide a command named "agent"';
  if (!preExisted) {
    const owners = new Set(collisions.map(c => c.owner));
    const newlyAdded = ['cursor', 'grok'].find(owner => owners.has(owner) && !preOwners.has(owner));
    if (newlyAdded) headline = `CONFLICT: installing ${newlyAdded === 'cursor' ? 'Cursor' : 'Grok'} added a second "agent" launcher`;
  }

  log('');
  log(`▌ ${headline}`);
  for (const c of collisions) {
    const label = c.owner === 'cursor' ? 'Cursor (cursor-agent)' : c.owner === 'grok' ? 'Grok (grok)' : 'unknown';
    log(`▌   ${c.path}  → ${label}`);
  }
  log('▌ Whichever comes first on PATH wins, so "agent -p" may launch the wrong tool.');
  log('▌ agent-delegates itself is safe: it calls cursor-agent and grok directly.');
  if (removable.length) {
    log('▌ Proposed fix for your shell: keep "cursor-agent" for Cursor and "grok" for Grok, and remove the duplicate "agent" launcher(s) — they are plain symlinks to the same binaries, nothing is uninstalled.');
    for (const item of removable) log(`▌   would remove: ${item.path}  (duplicate of ${item.canonicalPath})`);
  }
  log('');

  if (!removable.length) return; // nothing safe to offer; the block above is informational only

  let apply = options.resolveAgentConflict;
  if (apply == null) {
    if (isTTY) {
      const answer = await promptText('Apply this rename now? [y/N] ');
      apply = /^y(es)?$/i.test(String(answer).trim()) ? 'yes' : 'no';
    } else {
      apply = 'no'; // non-TTY without the flag: print the block above and do nothing
    }
  }

  if (String(apply).toLowerCase() === 'yes') applyAgentConflictResolution(removable, log);
  else log('Left as is. Delegated runs are unaffected; for your shell prefer "cursor-agent" and "grok" explicitly.');
}

// Cursor and Grok both ship a binary literally named `agent` — detect the PATH collision (via
// lib/bins.js, when present) and resolve+persist each selected vendor's actual binary path into
// routing.json's `bins` so lib/runner.js can call the right one unambiguously. Opt-in shell
// aliases (cursor-agent/grok) are a separate, purely cosmetic convenience for the user's own
// terminal — agent-delegates itself never depends on them.
async function setupBinsAndAliases(options, home, delegateIds, main, isTTY, promptText, log, preInstallCollisions) {
  const binsModule = loadBinsModule(options);
  if (!binsModule) return; // lib/bins.js not available yet; nothing to resolve/write

  const detectAgentCollision = binsModule.detectAgentCollision;
  const resolveBin = binsModule.resolveBin;
  const env = options.env || process.env;

  // The conflict prompt only ever makes sense when the user actually has both tools in play:
  // cursor (selected as a delegate, or chosen as --main) AND grok (grok is never a --main
  // choice, so only ever via delegates) selected. Bins are still resolved/written for every
  // selected vendor below regardless — this gate is only for the interactive/loud block.
  const cursorInvolved = delegateIds.includes('cursor') || main === 'cursor';
  const grokInvolved = delegateIds.includes('grok');
  if (cursorInvolved && grokInvolved && detectAgentCollision) {
    const collisions = (await detectAgentCollision({ env })) || [];
    const { effective, conflict } = deriveAgentConflict(collisions);
    if (conflict) {
      const preHits = preInstallCollisions || [];
      const preOwners = new Set(preHits.map(c => c.owner));
      const preExisted = deriveAgentConflict(preHits).conflict;
      await handleAgentConflict(options, collisions, preOwners, preExisted, isTTY, promptText, log);
    } else if (effective && effective.owner === 'cursor') {
      // No conflict — Cursor's own `agent` already wins PATH resolution. A shadowed Grok
      // duplicate further down is harmless (agent-delegates always calls `grok` directly, never
      // bare `agent`), but worth exactly one plain line so the user knows it's there and why
      // it's fine — never the loud block, never a prompt.
      const shadowedGrok = collisions.filter(c => c !== effective && c.owner === 'grok');
      if (shadowedGrok.length) {
        log(`NOTE: "agent" resolves to Cursor; Grok's duplicate launcher at ${shadowedGrok.map(c => c.path).join(', ')} is shadowed and harmless.`);
      }
    }
  }

  if (!resolveBin) return;
  const { loadConfig, saveConfig } = require('./policy');
  const config = loadConfig(home);
  const existingBins = config.bins && typeof config.bins === 'object' ? config.bins : {};
  const nextBins = { ...existingBins };
  let changed = false;
  const needsAlias = []; // cursor/grok whose canonical command is NOT already reachable by name on PATH
  for (const id of delegateIds) {
    const existingPath = existingBins[id];
    if (existingPath && exists(existingPath)) continue; // never overwrite a still-valid entry
    // L3: resolveBin's `config` param is the bins MAP itself (vendor -> path), not the whole
    // routing.json object — passing the whole config here made every `bins[vendor]` lookup
    // inside resolveBin look for e.g. config.cursor (never set) instead of config.bins.cursor,
    // so an existing routing.json override was silently ignored and a fresh PATH lookup ran
    // every time.
    const resolved = await resolveBin(id, { home, env, config: existingBins });
    if (resolved && resolved.command) {
      nextBins[id] = resolved.command;
      changed = true;
      // An alias only helps when the shell cannot already type the canonical name.
      // source 'path:cursor-agent' / 'path:grok' means it already can -> nothing to offer.
      if ((id === 'cursor' || id === 'grok') && resolved.source !== `path:${ALIAS_NAME[id]}`) needsAlias.push(id);
    }
  }
  if (changed) {
    saveConfig(home, { bins: nextBins });
    log(`routing.json bins updated: ${Object.keys(nextBins).join(', ')}`);
  }

  let wantsAliases = options.aliases;
  if (wantsAliases == null && isTTY && !options.yes && needsAlias.length > 0) {
    const answer = await promptText('Add shell aliases cursor-agent / grok pointing at the resolved binaries? [y/N] ');
    wantsAliases = /^y(es)?$/i.test(String(answer).trim()) ? 'yes' : 'no';
  }
  if (String(wantsAliases).toLowerCase() === 'yes') appendBinAliases(home, nextBins, log);
}

function installStatusline(home, log) {
  const claudeDir = path.join(home, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  const settings = readSettingsOrThrow(settingsFile); // throws before anything below is written

  fs.mkdirSync(claudeDir, { recursive: true });
  const source = path.join(packageRoot(), 'extras', 'statusline.js');
  const target = path.join(claudeDir, 'agent-delegates-statusline.js');
  fs.copyFileSync(source, target);
  try { fs.chmodSync(target, 0o755); } catch {}

  const old = typeof settings.statusLine?.command === 'string' ? settings.statusLine.command : '';
  const command = `node "${target.replace(/"/g, '\\"')}"`;
  if (old && old !== command) writeJson(path.join(claudeDir, 'delegate-statusline.json'), { downstream: old });
  settings.statusLine = { type: 'command', command };
  if (exists(settingsFile) && old !== command) fs.copyFileSync(settingsFile, settingsFile + '.bak-' + timestamp());
  writeJson(settingsFile, settings);
  log(`statusline installed at ${target}`);
  log(`Claude statusLine command: ${command}`);
}

function hookStub(implPath) {
  // B1 fix: requiring the impl module alone does nothing — its `if (require.main === module)`
  // guard never fires because `require.main` is this stub, not the required file. The stub must
  // call the exported main() explicitly.
  //
  // H2 fix: the require()+main() call is wrapped in try/catch so a stale/missing implPath (the
  // copy under ~/.claude/agent-delegates-nudge/ got deleted, or points at a package version that
  // moved/removed the file) can never surface as an uncaught-exception stack trace on stderr —
  // this hook must be fail-soft the same way its own internals already are, and must never set
  // permissionDecision either way.
  return `#!/usr/bin/env node\n'use strict';\ntry {\n  require(${JSON.stringify(implPath)}).main(process.argv.slice(2));\n} catch (e) {\n  process.exit(0);\n}\n`;
}

// H2: the hook stub used to require extras/delegate-nudge.js straight out of the installed npm
// package (packageRoot()). npx's package cache can be pruned between runs, silently breaking
// every future hook invocation until the next `agent-delegates install`. Instead, copy the impl
// file plus the small, self-contained slice of lib/ it actually needs into
// ~/.claude/agent-delegates-nudge/ — mirroring the package's own extras/ + lib/ layout so the
// impl file's existing relative requires ('../lib/util', '../lib/policy') resolve unchanged.
// delegate-nudge.js's own module-level requires are only 'node:path' plus those two lib files
// (policy.js in turn only needs node:path + util.js at module-eval time — its heavier route.js
// dependency is a lazy, in-function require() that decide()/loadConfig() never reach), so this
// closure is small and stable; it is NOT "too entangled" to copy.
const NUDGE_COPY_FILES = Object.freeze([
  ['extras/delegate-nudge.js', ['extras', 'delegate-nudge.js']],
  ['lib/util.js', ['lib', 'util.js']],
  ['lib/policy.js', ['lib', 'policy.js']]
]);

function nudgeCopyDir(home) {
  return path.join(home, '.claude', 'agent-delegates-nudge');
}

function installNudgeCopy(home) {
  const targetRoot = nudgeCopyDir(home);
  for (const [src, destParts] of NUDGE_COPY_FILES) {
    const dest = path.join(targetRoot, ...destParts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(packageRoot(), src), dest);
  }
  return path.join(targetRoot, 'extras', 'delegate-nudge.js');
}

function hookCommandMatches(command) {
  return typeof command === 'string' && command.includes('agent-delegates-nudge.js');
}

// Adds one hook entry to settings.hooks[eventName] (creating the array if needed), skipping if
// an entry whose command already contains 'agent-delegates-nudge.js' with the same trailing
// arg (e.g. both plain, or both 'pre-tool') is already present. Returns true if it added one.
function addHookEntry(settings, eventName, entry) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const list = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  settings.hooks[eventName] = list;
  const command = entry.hooks[0].command;
  const already = list.some(existing => Array.isArray(existing?.hooks) && existing.hooks.some(h => h?.command === command));
  if (already) return false;
  list.push(entry);
  return true;
}

function installHook(home, log) {
  const claudeDir = path.join(home, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  const settings = readSettingsOrThrow(settingsFile); // throws before the stub is written
  warnLegacyHook(settings, log);

  fs.mkdirSync(claudeDir, { recursive: true });
  const implPath = installNudgeCopy(home);
  const target = path.join(claudeDir, 'agent-delegates-nudge.js');
  fs.writeFileSync(target, hookStub(implPath));
  try { fs.chmodSync(target, 0o755); } catch {}

  const promptCommand = `node "${target.replace(/"/g, '\\"')}"`;
  const preToolCommand = `node "${target.replace(/"/g, '\\"')}" pre-tool`;

  const addedPrompt = addHookEntry(settings, 'UserPromptSubmit', { hooks: [{ type: 'command', command: promptCommand }] });
  const addedPreTool = addHookEntry(settings, 'PreToolUse', { matcher: 'Agent|Bash', hooks: [{ type: 'command', command: preToolCommand }] });

  if (!addedPrompt && !addedPreTool) {
    log('hook already installed (skipped)');
    return;
  }
  if (exists(settingsFile)) fs.copyFileSync(settingsFile, settingsFile + '.bak-' + timestamp());
  writeJson(settingsFile, settings);
  if (addedPrompt) log(`hook installed at ${target}`);
  if (addedPreTool) log(`PreToolUse hook installed at ${target} (mid-turn quota check)`);
}

function uninstallHook(home, log) {
  const claudeDir = path.join(home, '.claude');
  const target = path.join(claudeDir, 'agent-delegates-nudge.js');
  if (exists(target)) {
    fs.unlinkSync(target);
    log(`removed ${target}`);
  }
  const nudgeDir = nudgeCopyDir(home);
  if (exists(nudgeDir)) {
    fs.rmSync(nudgeDir, { recursive: true, force: true });
    log(`removed ${nudgeDir}`);
  }
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!exists(settingsFile)) return;
  const settings = readSettingsOrThrow(settingsFile);
  let changed = false;
  // Filter at the inner hooks[] level, not the entry level: an entry can be a merge of several
  // hook commands (ours plus someone else's, or ours for both event args), so dropping the
  // whole entry because ANY of its inner commands is ours would silently delete unrelated
  // commands that happened to share the entry. Only drop the entry itself once its hooks[]
  // array is empty.
  for (const eventName of ['UserPromptSubmit', 'PreToolUse']) {
    const list = settings.hooks?.[eventName];
    if (!Array.isArray(list)) continue;
    let removedAny = false;
    const filtered = list
      .map(entry => {
        if (!Array.isArray(entry?.hooks)) return entry;
        const before = entry.hooks.length;
        const hooks = entry.hooks.filter(h => !hookCommandMatches(h?.command));
        if (hooks.length !== before) removedAny = true;
        return { ...entry, hooks };
      })
      .filter(entry => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);
    if (removedAny) {
      if (filtered.length > 0) settings.hooks[eventName] = filtered;
      else delete settings.hooks[eventName];
      changed = true;
    }
  }
  if (!changed) return;
  // N2: an uninstall that empties out UserPromptSubmit/PreToolUse must not leave behind an
  // empty array (or an empty `hooks` object once every event key is gone) — that's dead clutter
  // in settings.json a person or a later install has to notice and clean up by hand.
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  fs.copyFileSync(settingsFile, settingsFile + '.bak-' + timestamp());
  writeJson(settingsFile, settings);
  log('hook removed from settings.json');
}

// Q1: which CLI is the main orchestrator (default 'claude'). Resolves --main, or prompts in a
// TTY, or falls back silently to the default when neither applies (non-interactive, no flag).
async function resolveMain(options, promptText, isTTY, log) {
  if (options.main) {
    const main = String(options.main).toLowerCase();
    if (!MAIN_CHOICES.includes(main)) throw new Error(`--main must be one of ${MAIN_CHOICES.join(', ')} (got '${options.main}')`);
    return main;
  }
  if (isTTY && !options.yes) {
    const answer = await promptText('Which CLI is your main orchestrator? [1] Claude Code [2] Codex [3] Cursor [4] all (default 1): ');
    return { '1': 'claude', '2': 'codex', '3': 'cursor', '4': 'all' }[answer] || 'claude';
  }
  return 'claude';
}

// Q2: which delegate vendors to set up (default agy,codex,grok). Returns { ids, explicit } —
// `explicit` gates whether routing.json's `priority` gets written (see install() below): only
// an actual --delegates flag or an actual TTY answer to Q2 counts, never the silent
// non-interactive fallback.
async function resolveDelegates(options, promptText, isTTY) {
  if (options.delegates != null) {
    const ids = String(options.delegates).split(',').map(s => s.trim()).filter(Boolean).filter(id => DELEGATE_IDS.includes(id));
    return { ids: ids.length ? ids : DEFAULT_DELEGATES.slice(), explicit: true };
  }
  if (isTTY && !options.yes) {
    const answer = await promptText('Which delegates do you want? [1] Antigravity [2] Codex [3] Grok [4] Claude [5] Cursor [6] OpenCode — space-separated numbers (default: 1 2 3): ');
    const numbers = answer.split(/[\s,]+/).filter(Boolean);
    const ids = numbers.map(n => DELEGATE_MENU[n]).filter(Boolean);
    return { ids: ids.length ? [...new Set(ids)] : DEFAULT_DELEGATES.slice(), explicit: true };
  }
  return { ids: DEFAULT_DELEGATES.slice(), explicit: false };
}

async function install(options = {}) {
  const log = options.log || console.log;
  const home = options.home || homeDir();
  const sourceRoot = path.join(packageRoot(), 'skills');
  const allTargets = [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills'), path.join(home, '.cursor', 'skills')];
  const ts = timestamp();

  if (options.uninstall) {
    // Uninstall always sweeps all three skill dirs (we don't track which --main was used to
    // install), and never touches routing.json — that file is the user's own config.
    for (const root of allTargets) for (const skill of SKILLS) removeManagedLink(path.join(root, skill), log);
    appendAlias(home, true, log);
    removeBinAliases(home, log);
    uninstallHook(home, log);
    log('aliases removed');
    return;
  }

  const isTTY = options.isTTY == null ? Boolean(process.stdin.isTTY && process.stdout.isTTY) : options.isTTY;
  const promptText = options.promptText || defaultTextPrompt;

  const main = await resolveMain(options, promptText, isTTY, log);
  const { ids: delegateIds, explicit: delegatesExplicit } = await resolveDelegates(options, promptText, isTTY);

  if (!isTTY && options.main == null && options.delegates == null) {
    log(`Non-interactive: using defaults (--main claude, --delegates ${DEFAULT_DELEGATES.join(',')}). Pass --main/--delegates, or run in a terminal to answer the setup questions.`);
  }

  // The main orchestrator CLI itself must already exist — this tool links skills and wires
  // hooks/statusline for it, it doesn't install a fresh IDE/CLI. 'all' has no single command to
  // check (skills go to all three dirs regardless of what's actually installed).
  if (main !== 'all') {
    const mainCommand = MAIN_COMMAND[main];
    // H1: same reasoning as vendor-setup.js's cursorExists — a plain PATH lookup for
    // 'cursor-agent' would miss a routing.json bins.cursor override or the well-known versions/
    // layout, and a bare `agent` on PATH might actually be Grok's. Route through resolveBin so
    // `--main cursor`'s "is it installed" check agrees with every other cursor resolution path.
    // Only applies when the caller hasn't already supplied an explicit commandExists override.
    let mainFound;
    if (options.commandExists) {
      mainFound = options.commandExists(mainCommand);
    } else if (main === 'cursor') {
      const binsModule = loadBinsModule(options);
      const resolveBinFn = binsModule && binsModule.resolveBin;
      if (resolveBinFn) {
        const resolved = await resolveBinFn('cursor', { home, env: options.env || process.env });
        mainFound = Boolean(resolved && resolved.command && resolved.verified);
      } else {
        mainFound = commandExists(mainCommand, options.platform || process.platform);
      }
    } else {
      mainFound = commandExists(mainCommand, options.platform || process.platform);
    }
    if (!mainFound) {
      throw new Error(`Main orchestrator CLI '${mainCommand}' (--main ${main}) is not installed. Install it first, then re-run 'agent-delegates install'.`);
    }
  }

  const targets = main === 'all' ? allTargets : [path.join(home, MAIN_SKILL_DIR[main], 'skills')];

  for (const root of targets) {
    fs.mkdirSync(root, { recursive: true });
    for (const skill of SKILLS) {
      const source = path.join(sourceRoot, skill);
      const target = path.join(root, skill);
      let stat = null;
      try { stat = fs.lstatSync(target); } catch {}
      if (stat && !stat.isSymbolicLink()) {
        const backup = `${target}.bak-${ts}`;
        fs.renameSync(target, backup);
        log(`backed up ${target} -> ${path.basename(backup)}`);
      } else if (stat) {
        fs.unlinkSync(target);
      }
      try {
        fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
        log(`linked ${target}`);
      } catch (error) {
        if (process.platform !== 'win32') throw error;
        fs.cpSync(source, target, { recursive: true });
        log(`note: junction unavailable; copied ${target} (re-run install after package updates)`);
      }
    }
  }
  appendAlias(home, false, log);

  // Statusline and the routing-nudge hooks are Claude Code features (settings.json, the
  // statusLine setting, UserPromptSubmit/PreToolUse hooks) — they mean nothing for a Codex or
  // Cursor main, so only wire them when Claude Code is (one of) the main(s).
  if (main === 'claude' || main === 'all') {
    if (!options.noStatusline) installStatusline(home, log);
    if (!options.noHook) installHook(home, log);
  } else {
    log(`Skipping statusline/hook: they're Claude Code features and --main ${main} was chosen. Run 'agent-delegates install --main claude' (or --main all) to also enable them for Claude Code.`);
  }

  // Snapshot the `agent`-collision state BEFORE the vendor CLI install step, so the conflict
  // block afterward can say whether installing Cursor/Grok just NOW created the collision, or
  // whether it already existed. Only worth taking when both cursor and grok are actually in
  // play — same gate setupBinsAndAliases uses for the block itself.
  const cursorInvolved = delegateIds.includes('cursor') || main === 'cursor';
  const grokInvolved = delegateIds.includes('grok');
  let preInstallCollisions = null;
  if (cursorInvolved && grokInvolved) {
    const binsModuleEarly = loadBinsModule(options);
    if (binsModuleEarly?.detectAgentCollision) {
      preInstallCollisions = (await binsModuleEarly.detectAgentCollision({ env: options.env || process.env })) || [];
    }
  }

  let vendorSetupResult = null;
  if (options.skipCliInstall) {
    log('CLI installation checks skipped (--skip-cli-install).');
  } else {
    vendorSetupResult = await (options.setupVendorClis || setupVendorClis)({
      yes: options.yes,
      log,
      commandExists: options.commandExists,
      install: options.vendorInstall,
      prompt: options.prompt,
      isTTY,
      platform: options.platform,
      vendorIds: delegateIds,
      // H1: setupVendorClis' cursorExists() fallback (used when no commandExists override is
      // given) resolves cursor through lib/bins.js's resolveBin, which needs the caller's own
      // env/home to see a test's (or a real caller's) fixture PATH/routing.json rather than
      // silently falling back to the real process.env/OS home.
      env: options.env,
      home,
      noLogin: options.noLogin,
      // The same per-vendor login check `run` uses (lib/status.js's preflight), so "found" and
      // "installed" report an honest ok/logged-out/unknown instead of a blanket "unverified".
      preflight: options.preflight || require('./status').preflight,
    });
  }

  // Only write `priority` when Q2/--delegates was actually answered — an unattended default
  // run must never clobber a `priority` the user already set by hand in routing.json.
  if (delegatesExplicit) {
    const { saveConfig } = require('./policy');
    saveConfig(home, { priority: delegateIds });
    log(`routing.json priority set to: ${delegateIds.join(', ')}`);
  }

  await setupBinsAndAliases(options, home, delegateIds, main, isTTY, promptText, log, preInstallCollisions);

  // authNeeded (populated by the real setupVendorClis, above) names only the vendors that ended
  // up 'logged-out' or 'unknown' after the found/installed auth check (and any login attempt).
  // Fall back to listing every selected delegate when that data isn't available — e.g. a test
  // double for setupVendorClis that returns nothing, or --skip-cli-install — so this line never
  // silently goes missing just because the check itself didn't run.
  const authNeededIds = (vendorSetupResult && Array.isArray(vendorSetupResult.authNeeded))
    ? delegateIds.filter(id => vendorSetupResult.authNeeded.includes(id))
    : delegateIds;
  const authCommands = authNeededIds.map(id => VENDORS.find(v => v.id === id)?.auth).filter(Boolean);
  if (authCommands.length) log(`Next: authenticate — ${authCommands.join(', ')}`);

  log('Skills configured. Check CLI availability with: agent-delegates status');
}

module.exports = { SKILLS, hookStub, install, installHook, installStatusline, uninstallHook };
