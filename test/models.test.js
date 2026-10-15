'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CRITICAL_TIER, DEFAULT_TIER, TIER_CLASS, TIER_EFFORT, TIER_MAPS, allowedModels, canonicalVendor, remapModel,
  resolveModel, resolveSelection, tierClass
} = require('../lib/models');

test('tier maps cover every vendor and documented tier', () => {
  assert.deepEqual(TIER_MAPS.codex, {
    'sol-low': 'gpt-6.1-sol', sol: 'gpt-6.1-sol', 'sol-high': 'gpt-6.1-sol', astra: 'gpt-6-astra'
  });
  assert.deepEqual(TIER_MAPS.agy, {
    lite: 'gemini-3.8-flash-low', flash: 'gemini-3.8-flash-high', pro: 'gemini-3.1-pro-high',
    sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6-thinking'
  });
  assert.deepEqual(TIER_MAPS.grok, { fast: 'grok-4.5', best: 'grok-4.6' });
  assert.deepEqual(TIER_MAPS.claude, {
    sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5'
  });
  assert.deepEqual(TIER_MAPS.cursor, { auto: 'auto', composer: 'composer-2.5' });
  assert.deepEqual(TIER_MAPS.opencode, {
    free: 'opencode/mimo-v2.5-free', go: 'opencode-go/kimi-k2.7-code'
  });
  assert.equal(canonicalVendor('antigravity'), 'agy');
  assert.equal(resolveModel('agy', 'gemini-custom'), 'gemini-custom');
  assert.equal(resolveModel('cursor', 'composer-2.5-fast'), 'composer-2.5-fast');
  assert.equal(resolveModel('opencode', 'opencode/big-pickle'), 'opencode/big-pickle');
  assert.throws(() => resolveModel('codex', 'unknown'), /not allowed for codex/);
});

test('tierClass classifies every documented tier per vendor', () => {
  assert.deepEqual(TIER_CLASS.codex, { 'sol-low': 'small', sol: 'standard', 'sol-high': 'large', astra: 'large' });
  assert.deepEqual(TIER_CLASS.agy, { lite: 'small', flash: 'small', pro: 'standard', sonnet: 'standard', opus: 'large' });
  assert.deepEqual(TIER_CLASS.grok, { fast: 'small', best: 'large' });
  assert.deepEqual(TIER_CLASS.claude, { sonnet: 'standard', opus: 'large' });
  assert.deepEqual(TIER_CLASS.cursor, { auto: 'small', composer: 'standard' });
  assert.deepEqual(TIER_CLASS.opencode, { free: 'small', go: 'small' });

  for (const vendor of Object.keys(TIER_CLASS)) {
    for (const tier of Object.keys(TIER_CLASS[vendor])) {
      assert.equal(tierClass(vendor, tier), TIER_CLASS[vendor][tier]);
    }
  }

  assert.equal(tierClass('antigravity', 'flash'), 'small');
  assert.equal(tierClass('codex', 'gpt-6.1-sol'), 'standard'); // raw slug = default tier (sol, medium)
  assert.equal(tierClass('codex', 'gpt-6-astra'), 'large');
  assert.equal(tierClass('claude', 'claude-sonnet-5-5'), 'standard');
  assert.equal(tierClass('codex', 'some-unknown-slug'), 'unknown');
  assert.equal(tierClass('unknownvendor', 'x'), 'unknown');
});

test('R16: resolveModel notes an unrecognized cursor tier to stderr but still passes it through', () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(resolveModel('cursor', 'composer-2.5-fast'), 'composer-2.5-fast');
    assert.ok(errors.some(e => /unknown cursor tier 'composer-2\.5-fast'/.test(e)), JSON.stringify(errors));

    errors.length = 0;
    assert.equal(resolveModel('cursor', 'auto'), 'auto');
    assert.equal(errors.length, 0, 'known tiers must not print the note');
  } finally {
    console.error = originalError;
  }
});

test('CRITICAL_TIER names the recommended tier per vendor', () => {
  assert.deepEqual(CRITICAL_TIER, {
    codex: 'sol-high', agy: 'opus', grok: 'best', claude: 'opus', cursor: null, opencode: null
  });
});

test('model policy: removed codex/claude tiers are rejected with the allowed tiers named', () => {
  for (const tier of ['luna', 'terra', 'haiku']) {
    const vendor = tier === 'haiku' ? 'claude' : 'codex';
    assert.throws(() => resolveModel(vendor, tier), new RegExp(`'${tier}' not allowed for ${vendor}: allowed tiers .*`));
  }
  assert.throws(() => resolveModel('codex', 'luna'), /sol-low\|sol\|sol-high\|astra/);
  assert.throws(() => resolveModel('claude', 'haiku'), /allowed tiers sonnet\|opus/);
});

test('model policy: raw --model outside the allowlist is rejected for codex and claude', () => {
  for (const slug of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-custom', 'codex-mini', 'gpt-6.1-sol-fast']) {
    assert.throws(() => resolveModel('codex', slug), /not allowed for codex/, slug);
  }
  for (const slug of ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-custom']) {
    assert.throws(() => resolveModel('claude', slug), /not allowed for claude/, slug);
  }
  assert.equal(resolveModel('codex', 'gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(resolveModel('codex', 'gpt-6-astra'), 'gpt-6-astra');
  assert.equal(resolveModel('claude', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(resolveModel('claude', 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.deepEqual(allowedModels('codex'), ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.deepEqual(allowedModels('claude'), ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('model policy: codex is one model (sol) with effort per tier; astra only by explicit tier', () => {
  assert.deepEqual(TIER_EFFORT.codex, { 'sol-low': 'low', sol: 'medium', 'sol-high': 'high', astra: 'high' });
  assert.deepEqual(resolveSelection('codex', 'sol-low'), { tier: 'sol-low', model: 'gpt-6.1-sol', effort: 'low' });
  assert.deepEqual(resolveSelection('codex', 'sol'), { tier: 'sol', model: 'gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(resolveSelection('codex', 'sol-high'), { tier: 'sol-high', model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(resolveSelection('codex', 'astra'), { tier: 'astra', model: 'gpt-6-astra', effort: 'high' });
  // explicit --effort wins; raw slug maps to its default tier
  assert.equal(resolveSelection('codex', 'sol', 'low').effort, 'low');
  assert.deepEqual(resolveSelection('codex', 'gpt-6.1-sol'), { tier: 'sol', model: 'gpt-6.1-sol', effort: 'medium' });
  // nothing but astra is ever a non-sol codex model; no default/critical tier is astra
  assert.notEqual(DEFAULT_TIER.codex, 'astra');
  assert.notEqual(CRITICAL_TIER.codex, 'astra');
  assert.deepEqual(Object.values(TIER_MAPS.codex).filter(m => m !== 'gpt-6.1-sol'), ['gpt-6-astra']);
  // claude: no tier-implied effort
  assert.equal(resolveSelection('claude', 'sonnet').effort, '');
  assert.equal(DEFAULT_TIER.claude, 'sonnet');
  assert.equal(CRITICAL_TIER.claude, 'opus');
});

test('model policy: remapModel maps stale/removed recorded models to the allowed tier of the same size class, leaves allowed ones', () => {
  assert.deepEqual(remapModel('codex', 'gpt-5.6-luna'), { model: 'gpt-6.1-sol', tier: 'sol-low', remapped: true, from: 'gpt-5.6-luna' });
  assert.deepEqual(remapModel('codex', 'gpt-5.6-terra'), { model: 'gpt-6.1-sol', tier: 'sol', remapped: true, from: 'gpt-5.6-terra' });
  assert.deepEqual(remapModel('codex', 'gpt-5.6-sol'), { model: 'gpt-6.1-sol', tier: 'sol-high', remapped: true, from: 'gpt-5.6-sol' });
  assert.deepEqual(remapModel('codex', 'gpt-5.6-astra'), { model: 'gpt-6.1-sol', tier: 'sol-high', remapped: true, from: 'gpt-5.6-astra' });
  assert.deepEqual(remapModel('codex', 'gpt-mystery'), { model: 'gpt-6.1-sol', tier: 'sol', remapped: true, from: 'gpt-mystery' });
  assert.deepEqual(remapModel('claude', 'claude-opus-5'), { model: 'claude-opus-5-5', tier: 'opus', remapped: true, from: 'claude-opus-5' });
  assert.deepEqual(remapModel('claude', 'claude-opus-4-1-20250805'), { model: 'claude-opus-5-5', tier: 'opus', remapped: true, from: 'claude-opus-4-1-20250805' });
  assert.deepEqual(remapModel('claude', 'claude-haiku-4-5-20251001'), { model: 'claude-sonnet-5-5', tier: 'sonnet', remapped: true, from: 'claude-haiku-4-5-20251001' });
  assert.deepEqual(remapModel('claude', 'claude-sonnet-4-6'), { model: 'claude-sonnet-5-5', tier: 'sonnet', remapped: true, from: 'claude-sonnet-4-6' });
  assert.deepEqual(remapModel('codex', 'gpt-6-astra'), { model: 'gpt-6-astra', remapped: false });
  assert.deepEqual(remapModel('claude', 'claude-opus-5-5'), { model: 'claude-opus-5-5', remapped: false });
  assert.deepEqual(remapModel('opencode', 'whatever/x'), { model: 'whatever/x', remapped: false });
});

test('model policy: codex effort allowlist (low|medium|high); astra only at high', () => {
  for (const bad of ['banana', 'xhigh', 'max', 'ultra', 'HIGH', 'minimal']) {
    assert.throws(() => resolveSelection('codex', 'sol', bad), /effort '.*' not allowed for codex: allowed efforts low\|medium\|high/, bad);
  }
  for (const ok of ['low', 'medium', 'high']) assert.equal(resolveSelection('codex', 'sol', ok).effort, ok);
  assert.equal(resolveSelection('codex', 'astra', 'high').effort, 'high');
  assert.throws(() => resolveSelection('codex', 'astra', 'low'), /astra always runs at high effort/);
  assert.throws(() => resolveSelection('codex', 'astra', 'medium'), /astra always runs at high effort/);
  // other vendors keep their own effort vocabulary (not our allowlist)
  assert.equal(resolveSelection('claude', 'opus', 'max').effort, 'max');
});

test('model policy: effectiveClass uses the effective effort for codex sol (large only at high); other vendors unchanged', () => {
  const { effectiveClass } = require('../lib/models');
  assert.equal(effectiveClass('codex', 'sol-high', 'low'), 'small');
  assert.equal(effectiveClass('codex', 'sol-high', 'medium'), 'standard');
  assert.equal(effectiveClass('codex', 'sol', 'high'), 'large');
  assert.equal(effectiveClass('codex', 'sol-low', 'high'), 'large');
  assert.equal(effectiveClass('codex', 'gpt-6.1-sol', 'high'), 'large');
  assert.equal(effectiveClass('codex', 'sol-high'), 'large');
  assert.equal(effectiveClass('codex', 'astra', 'high'), 'large');
  assert.equal(effectiveClass('claude', 'opus', 'low'), 'large');
});
