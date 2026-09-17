'use strict';

const TIER_MAPS = Object.freeze({
  codex: Object.freeze({
    luna: 'gpt-5.6-luna',
    terra: 'gpt-5.6-terra',
    sol: 'gpt-5.6-sol',
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
  claude: Object.freeze({
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-5',
    opus: 'claude-opus-5'
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

// Per-vendor per-tier size class, used by lib/guard.js to refuse small models on critical work.
const TIER_CLASS = Object.freeze({
  codex: Object.freeze({ luna: 'small', terra: 'standard', sol: 'large', astra: 'large' }),
  agy: Object.freeze({ lite: 'small', flash: 'small', pro: 'standard', sonnet: 'standard', opus: 'large' }),
  grok: Object.freeze({ fast: 'small', best: 'large' }),
  claude: Object.freeze({ haiku: 'small', sonnet: 'standard', opus: 'large' }),
  cursor: Object.freeze({ auto: 'small', composer: 'standard' }),
  opencode: Object.freeze({ free: 'small', go: 'small' })
});

// The default tier `run auto`/`handoff` uses per vendor when nothing more specific is chosen —
// single source of truth (previously duplicated in lib/route.js and lib/handoff.js).
const DEFAULT_TIER = Object.freeze({
  agy: 'flash',
  codex: 'terra',
  grok: 'best',
  claude: 'sonnet',
  cursor: 'auto',
  opencode: 'free'
});

// The tier to recommend for critical work per vendor; null means the vendor has no tier that
// qualifies (e.g. opencode never gets above 'small').
const CRITICAL_TIER = Object.freeze({
  codex: 'sol',
  agy: 'opus',
  grok: 'best',
  claude: 'opus',
  cursor: null,
  opencode: null
});

// Resolve a tier name OR a raw model slug back to its size class. An unresolvable raw slug is
// 'unknown' — the guard treats 'unknown' as not-large and refused on critical work.
function tierClass(vendor, tierOrModel) {
  vendor = canonicalVendor(vendor);
  const classes = TIER_CLASS[vendor];
  if (!classes) return 'unknown';
  if (classes[tierOrModel]) return classes[tierOrModel];
  const map = TIER_MAPS[vendor] || {};
  for (const tier of Object.keys(map)) {
    if (map[tier] === tierOrModel) return classes[tier] || 'unknown';
  }
  return 'unknown';
}

function canonicalVendor(vendor) {
  return vendor === 'antigravity' ? 'agy' : vendor;
}

function resolveModel(vendor, tier) {
  vendor = canonicalVendor(vendor);
  const map = TIER_MAPS[vendor];
  if (!map) throw new Error(`unknown vendor '${vendor}'`);
  if (map[tier]) return map[tier];
  if (vendor === 'codex' && /^(gpt-|codex-)/.test(tier)) return tier;
  if (vendor === 'agy' && tier.includes('-')) return tier;
  if (vendor === 'grok' && tier.startsWith('grok-')) return tier;
  if (vendor === 'claude' && tier.startsWith('claude-')) return tier;
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

module.exports = { CRITICAL_TIER, DEFAULT_TIER, TIER_CLASS, TIER_MAPS, canonicalVendor, resolveModel, tierClass };
