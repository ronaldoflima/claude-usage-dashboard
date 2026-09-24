// Rendering smoke tests with a minimal DOM: not a substitute for visual review.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const initialView of ['both', 'claude', 'codex']) test(`${initialView}: saved view, rendering and provider-scoped sync`, async () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: id === 'syncInterval' ? '0' : '', innerHTML: '', textContent: '', dataset: {},
      listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; },
      setAttribute() {}, parentElement: { querySelector() { return null; } },
      insertAdjacentHTML() {}, classList: { toggle() {}, remove() {} },
    });
    return nodes.get(id);
  }
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) node(match[1]);
  const document = {
    getElementById(id) { assert.ok(nodes.has(id), `Missing HTML id ${id}`); return node(id); },
    createElement() { return { set textContent(s) { this.innerHTML = String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;'); } }; },
    createTreeWalker() { return { nextNode() { return false; } }; },
    querySelectorAll() { return []; }, documentElement: {}, body: { dataset: {} },
  };
  const now = Date.now();
  const reset = new Date(now + 3 * 86400000).toISOString();
  const totals = { total_tokens: 120, fresh_tokens: 40, input_tokens: 20, output_tokens: 20,
    cache_read_tokens: 80, cache_creation_tokens: 0, thinking_tokens: 10, sessions: 1, messages: 1 };
  const row = { ...totals, model: 'test-model', session_id: 'test-session', project: '<script>', cwd: '/tmp/demo', bucket_ms: now - 60000 };
  const profile = { ok: true, lookback_days: 90, sample_hours: 100,
    weekly: { slots: Array(168).fill(1 / 168), timezone: 'UTC', reset_weekday: 0, reset_hour: 0, business_days_share: 71.4 } };
  const usage = { ok: true, totals, timeline: [row], models: [row], sessions: [row], profile,
    range: { start_ms: now - 18000000, end_ms: now }, coverage: { last_event_ms: now } };
  const limits = { ok: true, source: 'codex_app_server', fetched_at: new Date(now).toISOString(),
    limits: [{ key: 'codex:secondary', label: 'codex', bucket: 'codex', kind: 'weekly_all',
      window_minutes: 10080, utilization: 40, resets_at: reset }] };
  const requests = [];
  const saved = new Map([['providerView', initialView]]);
  let gate = null;
  const context = vm.createContext({ document, NodeFilter: { SHOW_TEXT: 4 }, Intl, Date, console,
    localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } }, setInterval() {}, clearInterval() {},
    fetch: async url => {
      requests.push(url);
      if (gate) await gate;
      const response = url.includes('limits') ? limits : url.includes('profile') ? profile
        : url.includes('snapshots') ? { ok: true, claude: [], codex: [] } : usage;
      return { json: async () => response };
    },
  });
  for (const name of ['i18n.js', 'pace-profile.js', 'providers.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static', name), 'utf8'), context, { filename: name });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.body.dataset.providerView, initialView);
  if (initialView === 'claude') assert.ok(requests.every(url => !url.includes('/api/codex/')));
  if (initialView === 'codex') assert.ok(requests.every(url => !/^\/api\/(dashboard|limits|profile)/.test(url)));
  assert.ok(requests.every(url => !url.includes('sync=1') && !url.includes('force=1')));
  await node('providerView').listeners.change({ target: { value: 'both' } });
  assert.match(node('codexLimits').innerHTML, /40.0%/);
  assert.match(node('limits').innerHTML, /40%/);
  assert.equal(vm.runInContext('paceFor({...state.codex.limits.limits[0], utilization: 0}, state.codex.activity.profile, state.codex.limits.fetched_at).projectedMs', context), null);
  assert.match(node('codexCurve').innerHTML, /<svg/);
  assert.match(node('providerActivity').innerHTML, /Claude/);
  assert.match(node('providerActivity').innerHTML, /Codex/);
  assert.ok(!node('codexSessions').innerHTML.includes('<script>'));
  node('language').listeners.change({ target: { value: 'pt-BR' } });
  node('paceMode').listeners.change({ target: { value: 'equal_weekdays' } });
  assert.match(node('codexLimits').innerHTML, /Seg–sex equilibrado/);
  for (const [id, element] of nodes) assert.ok(!/NaN|undefined/.test(element.innerHTML), id);
  vm.runInContext('state.codex = { activity: {ok: false}, limits: {ok: false} }; renderProviders()', context);
  assert.match(node('codexLimits').innerHTML, /indisponível/);
  assert.match(node('limits').innerHTML, /40%/);
  for (const provider of ['claude', 'codex', 'both']) {
    requests.length = 0;
    await node('providerView').listeners.change({ target: { value: provider } });
    assert.equal(saved.get('providerView'), provider);
    assert.equal(document.body.dataset.providerView, provider);
    assert.ok(requests.every(url => !url.includes('sync=1') && !url.includes('force=1')));
    requests.length = 0;
    await vm.runInContext('load(null, true, true)', context);
    if (provider === 'claude') {
      assert.ok(requests.every(url => !url.includes('/api/codex/')));
      assert.equal(node('providerBrand').textContent, 'CLAUDE CODE · LOCAL');
      assert.equal(node('claudeCurveEyebrow').textContent, 'RITMO SEMANAL');
      assert.equal(node('claudeActivityEyebrow').textContent, 'ATIVIDADE LOCAL');
    }
    if (provider === 'codex') assert.ok(requests.every(url => !/^\/api\/(dashboard|limits|profile)/.test(url)));
    assert.ok(requests.some(url => url.includes('force=1')));
  }
  // A selection made during an in-flight sync is queued as a cache-only read.
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const pending = vm.runInContext('load(null, true)', context);
  node('providerView').listeners.change({ target: { value: 'codex' } });
  requests.length = 0;
  gate = null; release();
  await pending;
  assert.equal(document.body.dataset.providerView, 'codex');
  assert.ok(requests.every(url => !url.includes('sync=1') && !url.includes('force=1')));
  assert.ok(requests.every(url => !/^\/api\/(dashboard|limits|profile)/.test(url)));
});
