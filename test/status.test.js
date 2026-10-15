'use strict';

// Tests for lib/status.js's new Cursor real-quota support (formatCursorQuota, fetchCursorUsage).
// The HTTP call goes through an injectable fetcher — no network hit here.

const assert = require('node:assert/strict');
const test = require('node:test');
const { ROW_VENDORS, fetchCursorUsage, formatCursorQuota, rowVendorIds } = require('../lib/status');

test('formatCursorQuota: success shape formats included/auto/api left + resets date', () => {
  const data = {
    billingCycleEnd: '1792129551000', // 2026-10-16T09:25:51.000Z
    planUsage: { totalPercentUsed: 14.66, autoPercentUsed: 15.19, apiPercentUsed: 9.31 }
  };
  const text = formatCursorQuota(data);
  assert.equal(text, 'included 85% left · resets Oct 16 (auto 85% · api 91%)');
});

test('formatCursorQuota: 0% left (fully exhausted) still formats, not treated as missing data', () => {
  const data = { billingCycleEnd: '1792129551000', planUsage: { totalPercentUsed: 100, autoPercentUsed: 100, apiPercentUsed: 100 } };
  assert.equal(formatCursorQuota(data), 'included 0% left · resets Oct 16 (auto 0% · api 0%)');
});

test('formatCursorQuota: missing planUsage returns null (caller falls back)', () => {
  assert.equal(formatCursorQuota({}), null);
  assert.equal(formatCursorQuota(null), null);
});

test('formatCursorQuota: no billingCycleEnd omits the resets clause', () => {
  const data = { planUsage: { totalPercentUsed: 50, autoPercentUsed: 50, apiPercentUsed: 50 } };
  assert.equal(formatCursorQuota(data), 'included 50% left (auto 50% · api 50%)');
});

test('fetchCursorUsage: passes bearer token and the Connect JSON endpoint to the fetcher', async () => {
  let seen;
  const fetcher = async (url, body, headers) => { seen = { url, body, headers }; return { ok: true }; };
  const result = await fetchCursorUsage('tok-123', fetcher);
  assert.equal(result.ok, true);
  assert.match(seen.url, /aiserver\.v1\.DashboardService\/GetCurrentPeriodUsage$/);
  assert.deepEqual(seen.body, {});
  assert.equal(seen.headers.Authorization, 'Bearer tok-123');
});

test('fetchCursorUsage: HTTP failure from the fetcher propagates (caller falls back to today\'s wording)', async () => {
  const fetcher = async () => { throw new Error('HTTP 401'); };
  await assert.rejects(() => fetchCursorUsage('tok-123', fetcher), /HTTP 401/);
});

// Status rows: claude (main) + vendors in routing.json priority; agy/grok/cursor hidden unless configured; --all shows every row.
test('rowVendorIds: claude + configured priority only; agy/grok/cursor hidden unless installed; all shows every vendor', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { configPath } = require('../lib/policy');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-status-'));
  assert.deepEqual(rowVendorIds(home), ['claude', 'codex', 'opencode'], 'defaults: codex, opencode, claude');
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify({ priority: ['codex', 'Antigravity'] }));
  assert.deepEqual(rowVendorIds(home), ['claude', 'codex', 'agy'], 'a configured delegate shows (names normalized), unconfigured opencode hidden');
  assert.deepEqual(rowVendorIds(home, { all: true }), [...ROW_VENDORS]);
  assert.deepEqual(ROW_VENDORS, ['claude', 'codex', 'agy', 'grok', 'cursor', 'opencode']);
});
