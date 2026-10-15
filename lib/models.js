'use strict';

const TIER_MAPS = Object.freeze({
  // Codex policy (user decision): ONE model, gpt-6.1-sol; effort is the knob (see TIER_EFFORT).
  // gpt-6-astra only for critical 2D/3D/visual design work.
  codex: Object.freeze({
    'sol-low': 'gpt-6.1-sol',
    sol: 'gpt-6.1-sol',
    'sol-high': 'gpt-6.1-sol',
    astra: 'gpt-6-astra'
  }),
  agy: Object.freeze({
    lite: 'gemini-3.8-flash-low',
    flash: 'gemini-3.8-flash-high',
    pro: 'gemini-3.1-pro-high',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6-thinking'
  }),
  grok: Object.freeze({
    fast: 'grok-4.5',
    best: 'grok-4.6'
  }),
  // Claude policy: Sonnet 5.5 for simple/standard work, Opus 5.5 for reviews and big/hard work.
  claude: Object.freeze({
    sonnet: 'claude-sonnet-5-5',
    opus: 'claude-opus-5-5'
  }),
  cursor: Object.freeze({
    auto: 'auto',
    composer: 'composer-2.5'
  }),
  opencode: Object.freeze({
    free: 'opencode/mimo-v2.5-free',
    go: 'opencode-go/kimi-k2.7-code'
  })
});

// Vendors whose model choice is locked to the TIER_MAPS allowlist: an unknown tier name or a raw
// model slug outside the map's values is an error, never a passthrough. Other vendors keep their
// permissive raw-slug passthrough (their model lists churn, and policy doesn't cover them).
const STRICT_VENDORS = Object.freeze(['codex', 'claude']);

// Default reasoning effort per tier (codex only). Task size -> effort: simple low, standard
// medium, hard high. An explicit --effort still overrides. Vendors/tiers absent here have no
// tier-implied effort.
const TIER_EFFORT = Object.freeze({
  codex: Object.freeze({ 'sol-low': 'low', sol: 'medium', 'sol-high': 'high', astra: 'high' })
});

// Reasoning efforts a strict vendor may run (codex only). Anything outside this list -- `banana`,
// `xhigh`, `max`, `ultra` -- is an error at selection time, never passed through to the CLI.
const ALLOWED_EFFORTS = Object.freeze({ codex: Object.freeze(['low', 'medium', 'high']) });

// Codex runs ONE model (gpt-6.1-sol) whose size class is decided by the effort it actually runs at.
const SOL_EFFORT_CLASS = Object.freeze({ low: 'small', medium: 'standard', high: 'large' });

// Per-vendor per-tier size class, used by lib/guard.js to refuse small models on critical work.
const TIER_CLASS = Object.freeze({
  codex: Object.freeze({ 'sol-low': 'small', sol: 'standard', 'sol-high': 'large', astra: 'large' }),
  agy: Object.freeze({ lite: 'small', flash: 'small', pro: 'standard', sonnet: 'standard', opus: 'large' }),
  grok: Object.freeze({ fast: 'small', best: 'large' }),
  claude: Object.freeze({ sonnet: 'standard', opus: 'large' }),
  cursor: Object.freeze({ auto: 'small', composer: 'standard' }),
  opencode: Object.freeze({ free: 'small', go: 'small' })
});

// The default tier `run auto`/`handoff` uses per vendor when nothing more specific is chosen —
// single source of truth (previously duplicated in lib/route.js and lib/handoff.js).
const DEFAULT_TIER = Object.freeze({
  agy: 'flash',
  codex: 'sol',
  grok: 'best',
  claude: 'sonnet',
  cursor: 'auto',
  opencode: 'free'
});

// The tier to recommend for critical work per vendor; null means the vendor has no tier that
// qualifies (e.g. opencode never gets above 'small').
// Codex critical non-visual work gets sol at high effort; astra is only ever an explicit choice.
const CRITICAL_TIER = Object.freeze({
  codex: 'sol-high',
  agy: 'opus',
  grok: 'best',
  claude: 'opus',
  cursor: null,
  opencode: null
});

// The tier a raw model slug stands for: the vendor's DEFAULT_TIER when it uses that model (so raw
// `gpt-6.1-sol` means `sol`, medium effort, not the first map entry `sol-low`), else the first
// tier mapping to it. null when the slug is in no tier.
function tierForModel(vendor, model) {
  vendor = canonicalVendor(vendor);
  const map = TIER_MAPS[vendor] || {};
  if (map[DEFAULT_TIER[vendor]] === model) return DEFAULT_TIER[vendor];
  return Object.keys(map).find(tier => map[tier] === model) || null;
}

// Resolve a tier name OR a raw model slug back to its size class. An unresolvable raw slug is
// 'unknown' — the guard treats 'unknown' as not-large and refused on critical work.
function tierClass(vendor, tierOrModel) {
  vendor = canonicalVendor(vendor);
  const classes = TIER_CLASS[vendor];
  if (!classes) return 'unknown';
  if (classes[tierOrModel]) return classes[tierOrModel];
  const tier = tierForModel(vendor, tierOrModel);
  return tier ? (classes[tier] || 'unknown') : 'unknown';
}

// Size class of the (tier|model, effort) pair that will ACTUALLY run. For codex gpt-6.1-sol the
// effort decides the class (sol-high is large only because it implies high; `sol --effort high`
// is the same invocation, `sol-high --effort low` is small). Other vendors/tiers: the tier class.
function effectiveClass(vendor, tierOrModel, effort) {
  vendor = canonicalVendor(vendor);
  const base = tierClass(vendor, tierOrModel);
  if (vendor !== 'codex' || !effort) return base;
  const model = TIER_MAPS.codex[tierOrModel] || tierOrModel;
  if (model === TIER_MAPS.codex.sol && SOL_EFFORT_CLASS[effort]) return SOL_EFFORT_CLASS[effort];
  return base;
}

// Throws unless `effort` is allowed for this vendor/model. Empty effort passes (tier-implied
// effort applies). astra always runs at high.
function validateEffort(vendor, model, effort) {
  vendor = canonicalVendor(vendor);
  if (effort == null || effort === '') return;
  const allowed = ALLOWED_EFFORTS[vendor];
  if (!allowed) return;
  if (!allowed.includes(effort)) {
    throw new Error(`effort '${effort}' not allowed for ${vendor}: allowed efforts ${allowed.join('|')}`);
  }
  if (vendor === 'codex' && model === TIER_MAPS.codex.astra && effort !== 'high') {
    throw new Error(`effort '${effort}' not allowed for codex astra: astra always runs at high effort`);
  }
}

function canonicalVendor(vendor) {
  return vendor === 'antigravity' ? 'agy' : vendor;
}

// The models a strict vendor may run (the distinct values of its tier map); [] for other vendors.
function allowedModels(vendor) {
  vendor = canonicalVendor(vendor);
  if (!STRICT_VENDORS.includes(vendor)) return [];
  return [...new Set(Object.values(TIER_MAPS[vendor]))];
}

function isAllowedModel(vendor, model) {
  return allowedModels(vendor).includes(model);
}

function strictError(vendor, input, what) {
  const map = TIER_MAPS[vendor];
  return new Error(`${what} '${input}' not allowed for ${vendor}: allowed tiers ${Object.keys(map).join('|')}; allowed models ${allowedModels(vendor).join('|')}`);
}

// The model a strict vendor falls back to when a recorded/stale model is no longer allowed.
function policyDefaultModel(vendor) {
  vendor = canonicalVendor(vendor);
  return TIER_MAPS[vendor] ? TIER_MAPS[vendor][DEFAULT_TIER[vendor]] : '';
}

function resolveModel(vendor, tier) {
  vendor = canonicalVendor(vendor);
  const map = TIER_MAPS[vendor];
  if (!map) throw new Error(`unknown vendor '${vendor}'`);
  if (Object.prototype.hasOwnProperty.call(map, tier)) return map[tier];
  if (STRICT_VENDORS.includes(vendor)) {
    // Strict vendors: only the allowlisted models themselves pass as raw slugs. No prefix
    // passthrough (gpt-*/codex-*/claude-*), so removed/stale slugs and typos fail loudly here.
    if (isAllowedModel(vendor, tier)) return tier;
    throw strictError(vendor, tier, 'tier/model');
  }
  if (vendor === 'agy' && tier.includes('-')) return tier;
  if (vendor === 'grok' && tier.startsWith('grok-')) return tier;
  if (vendor === 'cursor' && tier) {
    // Cursor's model list changes often and this codebase doesn't try to keep a full enum of
    // it — any non-empty string is passed through as a raw model id. That permissiveness is
    // intentional, but a caller who mistyped a tier name (or used a tier from another vendor)
    // deserves a visible one-line note rather than silent pass-through.
    if (!Object.prototype.hasOwnProperty.call(map, tier)) {
      console.error(`note: unknown cursor tier '${tier}', passing through as model id`);
    }
    return tier;
  }
  if (vendor === 'opencode' && tier.includes('/')) return tier;
  throw new Error(`unknown ${vendor} tier '${tier}' (${Object.keys(map).join('|')})`);
}

// Full selection for a run: { tier, model, effort }. `tierOrModel` may be a tier name or an
// allowlisted raw slug (-> its default tier). effort = explicit override, else the tier-implied
// effort (codex), else '' (vendor default).
function resolveSelection(vendor, tierOrModel, explicitEffort) {
  vendor = canonicalVendor(vendor);
  const model = resolveModel(vendor, tierOrModel);
  const tier = Object.prototype.hasOwnProperty.call(TIER_MAPS[vendor], tierOrModel) ? tierOrModel : (tierForModel(vendor, model) || tierOrModel);
  validateEffort(vendor, model, explicitEffort);
  const effort = explicitEffort || (TIER_EFFORT[vendor] && TIER_EFFORT[vendor][tier]) || '';
  return { tier, model, effort };
}

// Resume remap: a recorded model that is no longer allowed (removed tier, stale slug) maps to the
// allowed tier of the SAME size class, never silently up or down: claude opus-class -> opus,
// sonnet/haiku -> sonnet; codex luna -> sol-low, terra -> sol, sol/astra-class (large) -> sol-high,
// anything else -> the policy default tier. Non-strict vendors pass through untouched.
const REMAP_RULES = Object.freeze({
  claude: Object.freeze([[/opus/i, 'opus'], [/./, 'sonnet']]),
  codex: Object.freeze([[/luna/i, 'sol-low'], [/terra/i, 'sol'], [/sol|astra/i, 'sol-high']])
});

function remapModel(vendor, model) {
  vendor = canonicalVendor(vendor);
  if (!STRICT_VENDORS.includes(vendor) || !model || isAllowedModel(vendor, model)) return { model, remapped: false };
  const rule = (REMAP_RULES[vendor] || []).find(([re]) => re.test(model));
  const tier = rule ? rule[1] : DEFAULT_TIER[vendor];
  return { model: TIER_MAPS[vendor][tier], tier, remapped: true, from: model };
}

module.exports = {
  ALLOWED_EFFORTS, CRITICAL_TIER, DEFAULT_TIER, STRICT_VENDORS, TIER_CLASS, TIER_EFFORT, TIER_MAPS, allowedModels,
  canonicalVendor, effectiveClass, isAllowedModel, policyDefaultModel, remapModel, resolveModel, resolveSelection,
  tierClass, tierForModel, validateEffort
};
