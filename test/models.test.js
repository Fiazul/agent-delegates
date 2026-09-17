'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CRITICAL_TIER, TIER_CLASS, TIER_MAPS, canonicalVendor, resolveModel, tierClass } = require('../lib/models');

test('tier maps cover every vendor and documented tier', () => {
  assert.deepEqual(TIER_MAPS.codex, {
    luna: 'gpt-5.6-luna', terra: 'gpt-5.6-terra', sol: 'gpt-5.6-sol', astra: 'gpt-6-astra'
  });
  assert.deepEqual(TIER_MAPS.agy, {
    lite: 'gemini-3.8-flash-low', flash: 'gemini-3.8-flash-high', pro: 'gemini-3.1-pro-high',
    sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6-thinking'
  });
  assert.deepEqual(TIER_MAPS.grok, { fast: 'grok-4.5', best: 'grok-4.6' });
  assert.deepEqual(TIER_MAPS.claude, {
    haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5'
  });
  assert.deepEqual(TIER_MAPS.cursor, { auto: 'auto', composer: 'composer-2.5' });
  assert.deepEqual(TIER_MAPS.opencode, {
    free: 'opencode/mimo-v2.5-free', go: 'opencode-go/kimi-k2.7-code'
  });
  assert.equal(canonicalVendor('antigravity'), 'agy');
  assert.equal(resolveModel('agy', 'gemini-custom'), 'gemini-custom');
  assert.equal(resolveModel('cursor', 'composer-2.5-fast'), 'composer-2.5-fast');
  assert.equal(resolveModel('opencode', 'opencode/big-pickle'), 'opencode/big-pickle');
  assert.throws(() => resolveModel('codex', 'unknown'), /unknown codex tier/);
});

test('tierClass classifies every documented tier per vendor', () => {
  assert.deepEqual(TIER_CLASS.codex, { luna: 'small', terra: 'standard', sol: 'large', astra: 'large' });
  assert.deepEqual(TIER_CLASS.agy, { lite: 'small', flash: 'small', pro: 'standard', sonnet: 'standard', opus: 'large' });
  assert.deepEqual(TIER_CLASS.grok, { fast: 'small', best: 'large' });
  assert.deepEqual(TIER_CLASS.claude, { haiku: 'small', sonnet: 'standard', opus: 'large' });
  assert.deepEqual(TIER_CLASS.cursor, { auto: 'small', composer: 'standard' });
  assert.deepEqual(TIER_CLASS.opencode, { free: 'small', go: 'small' });

  for (const vendor of Object.keys(TIER_CLASS)) {
    for (const tier of Object.keys(TIER_CLASS[vendor])) {
      assert.equal(tierClass(vendor, tier), TIER_CLASS[vendor][tier]);
    }
  }

  assert.equal(tierClass('antigravity', 'flash'), 'small');
  assert.equal(tierClass('codex', 'gpt-5.6-sol'), 'large');
  assert.equal(tierClass('claude', 'claude-sonnet-5'), 'standard');
  assert.equal(tierClass('codex', 'some-unknown-slug'), 'unknown');
  assert.equal(tierClass('unknownvendor', 'x'), 'unknown');
});

test('CRITICAL_TIER names the recommended tier per vendor', () => {
  assert.deepEqual(CRITICAL_TIER, {
    codex: 'sol', agy: 'opus', grok: 'best', claude: 'opus', cursor: null, opencode: null
  });
});
