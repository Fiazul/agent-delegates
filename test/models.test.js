'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TIER_MAPS, canonicalVendor, resolveModel } = require('../lib/models');

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
  assert.equal(canonicalVendor('antigravity'), 'agy');
  assert.equal(resolveModel('agy', 'gemini-custom'), 'gemini-custom');
  assert.throws(() => resolveModel('codex', 'unknown'), /unknown codex tier/);
});
