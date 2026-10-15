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
  // OpenCode policy: `free` is a no-cost small model (simple tasks only, never critical, never
  // --yolo); `glm`/`kimi` are paid frontier (opencode-go) models, class large. Verified against
  // `opencode models` 2026-10-15. Raw slugs still pass through (see rawSlugClass for their class).
  opencode: Object.freeze({
    free: 'opencode/mimo-v2.6-flash-free',
    glm: 'opencode-go/glm-5.3',
    kimi: 'opencode-go/kimi-k3'
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
  opencode: Object.freeze({ free: 'small', glm: 'large', kimi: 'large' })
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
// qualifies (cursor).
// Codex critical non-visual work gets sol at high effort; astra is only ever an explicit choice.
const CRITICAL_TIER = Object.freeze({
  codex: 'sol-high',
  agy: 'opus',
  grok: 'best',
  claude: 'opus',
  cursor: null,
  opencode: 'glm'
});

function ownValue(map, key) {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

// Prefer the default tier when several effort tiers share the same model.
function tierForModel(vendor, model) {
  vendor = canonicalVendor(vendor);
  const map = ownValue(TIER_MAPS, vendor) || {};
  const defaultTier = ownValue(DEFAULT_TIER, vendor);
  if (defaultTier && ownValue(map, defaultTier) === model) return defaultTier;
  return Object.keys(map).find(tier => map[tier] === model) || null;
}

// Resolve a tier name OR a raw model slug back to its size class. An unresolvable raw slug is
// 'unknown' — the guard treats 'unknown' as not-large and refused on critical work.
function tierClass(vendor, tierOrModel) {
  vendor = canonicalVendor(vendor);
  const classes = ownValue(TIER_CLASS, vendor);
  if (!classes) return 'unknown';
  if (Object.hasOwn(classes, tierOrModel)) return classes[tierOrModel];
  return modelClass(vendor, tierOrModel);
}

function modelClass(vendor, model) {
  const tier = tierForModel(vendor, model);
  return (tier && ownValue(ownValue(TIER_CLASS, vendor), tier)) || rawSlugClass(vendor, model);
}

// Explicit allowlist of OpenCode slugs classed `large` (frontier, eligible for --critical and --yolo).
// Verified against `opencode models` 2026-10-15. NEW frontier models are NOT picked up automatically:
// a family-name pattern (glm-*, kimi-*) would silently promote a lightweight or experimental variant
// to full-access eligibility, so a new slug must be added here by hand (+ docs/tests).
const OPENCODE_LARGE_MODELS = Object.freeze([
  'opencode-go/glm-5.3',
  'opencode-go/glm-5.2',
  'opencode-go/kimi-k3',
  'opencode-go/kimi-k2.7-code'
]);

// Class of a raw model slug that is in no tier. Only opencode passes raw slugs through (non-strict),
// so only it needs a rule: any `*-free` slug is small; a slug in OPENCODE_LARGE_MODELS is large;
// every other opencode slug is standard (a model nobody classified is never large, never free: no
// --yolo, no --critical). Other vendors keep 'unknown' (the guard treats it as not-large).
function rawSlugClass(vendor, slug) {
  if (vendor !== 'opencode' || typeof slug !== 'string' || !slug.includes('/')) return 'unknown';
  if (/-free$/i.test(slug)) return 'small';
  if (OPENCODE_LARGE_MODELS.includes(slug)) return 'large';
  return 'standard';
}

// Size class of the (tier|model, effort) pair that will ACTUALLY run. For codex gpt-6.1-sol the
// effort decides the class (sol-high is large only because it implies high; `sol --effort high`
// is the same invocation, `sol-high --effort low` is small). Other vendors/tiers: the tier class.
function effectiveClass(vendor, tierOrModel, effort) {
  vendor = canonicalVendor(vendor);
  const base = tierClass(vendor, tierOrModel);
  if (vendor !== 'codex' || !effort) return base;
  const model = ownValue(TIER_MAPS.codex, tierOrModel) || tierOrModel;
  if (model === TIER_MAPS.codex.sol && Object.hasOwn(SOL_EFFORT_CLASS, effort)) return SOL_EFFORT_CLASS[effort];
  return base;
}

// Classify the spawned model, never a tier alias accidentally stored in a model field.
function selectionClass(vendor, tier, model, effort) {
  vendor = canonicalVendor(vendor);
  const base = modelClass(vendor, model);
  if (vendor !== 'codex' || model !== TIER_MAPS.codex.sol) return base;
  const implied = ownValue(TIER_MAPS.codex, tier) === model ? ownValue(TIER_EFFORT.codex, tier) : '';
  return ownValue(SOL_EFFORT_CLASS, effort || implied) || base;
}

// Every vendor's full-access mode requires a frontier (large) model/effort pair.
const YOLO_GATED = Object.freeze(['codex', 'claude', 'opencode', 'agy', 'cursor', 'grok']);
const YOLO_ELIGIBLE_TEXT = Object.freeze({
  codex: 'sol-high | sol --effort high | astra',
  claude: 'opus',
  opencode: 'glm | kimi | an allowlisted large slug',
  agy: 'opus',
  grok: 'best'
});
const YOLO_ALL_ELIGIBLE_TEXT = Object.keys(YOLO_ELIGIBLE_TEXT).map(v => `${v} ${YOLO_ELIGIBLE_TEXT[v]}`).join('; ');

function yoloGated(vendor) {
  return YOLO_GATED.includes(canonicalVendor(vendor));
}

// Pure eligibility check, shared by lib/guard.js enforce() and run auto's candidate pre-filter.
// `tier` may be a tier name or a raw model slug; `effort` is the effective effort. Returns
// { ok, reason }. Ungated vendors are always ok here.
function yoloCheck(vendor, tier, model, effort) {
  vendor = canonicalVendor(vendor);
  if (!yoloGated(vendor)) return { ok: true, reason: '' };
  const cls = selectionClass(vendor, tier, model, effort);
  if (cls === 'large') return { ok: true, reason: '' };
  const label = [tier, model].filter(Boolean).join(' / ') || 'vendor default';
  const effortNote = vendor === 'codex' && effort ? ` at effort ${effort}` : '';
  const classes = ownValue(TIER_CLASS, vendor);
  const limit = classes && Object.values(classes).includes('large')
    ? `full access is limited to frontier tiers: ${YOLO_ALL_ELIGIBLE_TEXT}`
    : `${vendor} has no frontier tier; full access is unavailable`;
  return {
    ok: false,
    reason: `--yolo (full access) refused for ${vendor} ${label}${effortNote} (${cls} class): ${limit}`
  };
}

// Throws unless `effort` is allowed for this vendor/model. Empty effort passes (tier-implied
// effort applies). astra always runs at high.
function validateEffort(vendor, model, effort) {
  vendor = canonicalVendor(vendor);
  if (effort == null || effort === '') return;
  const allowed = ownValue(ALLOWED_EFFORTS, vendor);
  if (!allowed) return;
  if (!allowed.includes(effort)) {
    throw new Error(`effort '${effort}' not allowed for ${vendor}: allowed efforts ${allowed.join('|')}`);
  }
  if (vendor === 'codex' && model === TIER_MAPS.codex.astra && effort !== 'high') {
    throw new Error(`effort '${effort}' not allowed for codex astra: astra always runs at high effort`);
  }
}

// The ONE vendor-name normalizer (lowercase, trimmed, antigravity -> agy), used by --self, priority
// entries, routing and the guard so a name can never match in one place and miss in another.
function canonicalVendor(vendor) {
  if (typeof vendor !== 'string') return vendor;
  const name = vendor.trim().toLowerCase();
  return name === 'antigravity' ? 'agy' : name;
}

// The models a strict vendor may run (the distinct values of its tier map); [] for other vendors.
function allowedModels(vendor) {
  vendor = canonicalVendor(vendor);
  if (!STRICT_VENDORS.includes(vendor)) return [];
  return [...new Set(Object.values(ownValue(TIER_MAPS, vendor)))];
}

function isAllowedModel(vendor, model) {
  return allowedModels(vendor).includes(model);
}

function strictError(vendor, input, what) {
  const map = ownValue(TIER_MAPS, vendor);
  return new Error(`${what} '${input}' not allowed for ${vendor}: allowed tiers ${Object.keys(map).join('|')}; allowed models ${allowedModels(vendor).join('|')}`);
}

// The model a strict vendor falls back to when a recorded/stale model is no longer allowed.
function policyDefaultModel(vendor) {
  vendor = canonicalVendor(vendor);
  return ownValue(ownValue(TIER_MAPS, vendor), ownValue(DEFAULT_TIER, vendor)) || '';
}

function resolveModel(vendor, tier) {
  vendor = canonicalVendor(vendor);
  const map = ownValue(TIER_MAPS, vendor);
  if (!map) throw new Error(`unknown vendor '${vendor}'`);
  if (Object.hasOwn(map, tier)) return map[tier];
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
    if (!Object.hasOwn(map, tier)) {
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
  const tier = Object.hasOwn(ownValue(TIER_MAPS, vendor), tierOrModel) ? tierOrModel : (tierForModel(vendor, model) || tierOrModel);
  validateEffort(vendor, model, explicitEffort);
  const effort = explicitEffort || ownValue(ownValue(TIER_EFFORT, vendor), tier) || '';
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
  const rule = (ownValue(REMAP_RULES, vendor) || []).find(([re]) => re.test(model));
  const tier = rule ? rule[1] : ownValue(DEFAULT_TIER, vendor);
  return { model: ownValue(ownValue(TIER_MAPS, vendor), tier), tier, remapped: true, from: model };
}

module.exports = {
  ALLOWED_EFFORTS, CRITICAL_TIER, OPENCODE_LARGE_MODELS, DEFAULT_TIER, STRICT_VENDORS, TIER_CLASS, TIER_EFFORT, TIER_MAPS, allowedModels,
  canonicalVendor, effectiveClass, isAllowedModel, policyDefaultModel, remapModel, resolveModel, resolveSelection,
  YOLO_ALL_ELIGIBLE_TEXT, YOLO_ELIGIBLE_TEXT, YOLO_GATED, rawSlugClass, tierClass, tierForModel, selectionClass, validateEffort, yoloCheck, yoloGated
};
