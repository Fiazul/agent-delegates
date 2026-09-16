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
  if (vendor === 'cursor' && tier) return tier;
  if (vendor === 'opencode' && tier.includes('/')) return tier;
  throw new Error(`unknown ${vendor} tier '${tier}' (${Object.keys(map).join('|')})`);
}

module.exports = { TIER_MAPS, canonicalVendor, resolveModel };
