const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Support = require('../extension/src/content/modelPickerSupport');
const Models = require('../extension/src/shared/models');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/modelPicker.js'), 'utf8');
const luna = { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', speedTiers: ['standard', 'fast'] };
const older = { ...luna, id: 'gpt-5.5', label: 'GPT-5.5' };
const catalog = (models, source = 'codex-cache', providerId = 'builtin') => ({ ok: true, result: { models, source, providerId, providerRevision: providerId === 'builtin' ? 0 : 1 } });

function makeSelect() {
  return {
    options: [], dataset: {}, disabled: false, _value: '',
    get value() { return this._value; },
    set value(value) { this._value = this.options.some(option => option.value === value) ? value : ''; },
    get textContent() { return ''; },
    set textContent(value) { this.options = []; this._value = ''; },
    append(option) { this.options.push(option); if (this.options.length === 1) this._value = option.value; }
  };
}

function harness(initial = {}) {
  const state = { providerId: 'builtin', model: luna.id, reasoningEffort: 'max', speedTier: 'fast', ...initial };
  const controls = { '[data-model]': makeSelect(), '[data-reasoning]': makeSelect(), '[data-speed]': makeSelect() };
  const panel = { querySelector: selector => controls[selector] || null, querySelectorAll: () => [] };
  const browserWindow = {};
  vm.runInNewContext(source, { window: browserWindow, document: { createElement: () => ({ dataset: {}, value: '', textContent: '' }) } });
  let response = catalog([luna, older]);
  const saves = [];
  const tuple = () => ({ model: controls['[data-model]'].value, reasoningEffort: controls['[data-reasoning]'].value, speedTier: controls['[data-speed]'].value });
  const picker = browserWindow.CodexOverleafModelPicker.create({
    Support, getState: () => state, getPanel: () => panel,
    tr: key => key, tx: english => english, getLocale: () => 'en',
    getProviderSelection: () => ({ providerId: state.providerId }),
    getRenderedModelEntries: () => Support.getRenderedModelEntries(panel),
    readSelectedSpeedInput: () => controls['[data-speed]'].value,
    sendBackgroundNative: () => Promise.resolve(typeof response === 'function' ? response() : response),
    persistPanelInputs: async () => { Object.assign(state, tuple()); saves.push(tuple()); }
  });
  picker.renderModelOptions([luna, older], state.model);
  return { picker, state, controls, tuple, saves, respond: value => { response = value; } };
}

test('fallback and catalog recovery preserve explicit Luna, Max and Fast without manual changes', async () => {
  const h = harness();
  const expected = h.tuple();
  h.respond(catalog(Models.FALLBACK_MODELS, 'fallback'));
  await h.picker.loadModelOptions();
  assert.deepEqual(h.tuple(), expected);
  assert.equal(h.picker.getModelDiscovery().status, 'fallback');
  h.respond(catalog([older, luna]));
  await h.picker.loadModelOptions();
  assert.deepEqual(h.tuple(), expected);
  assert.deepEqual(h.saves, [expected, expected]);
});

test('fallback also preserves effort and speed when the model exists in the old fallback list', async () => {
  const h = harness({ model: older.id });
  const expected = h.tuple();
  h.respond(catalog(Models.FALLBACK_MODELS, 'fallback'));
  await h.picker.loadModelOptions();
  assert.deepEqual(h.tuple(), expected);
});

test('an incomplete cached catalog does not silently replace a saved Built-in model', async () => {
  const h = harness();
  const expected = h.tuple();
  h.respond(catalog([older]));
  await h.picker.loadModelOptions();
  assert.deepEqual(h.tuple(), expected);
  assert.equal(h.controls['[data-model]'].options.find(option => option.value === luna.id).dataset.unverified, 'true');
});

test('unavailable catalogs disable controls without discarding the saved selection', async () => {
  const h = harness();
  const expected = h.tuple();
  h.respond({ ok: false, error: { code: 'native_disconnected', message: 'Disconnected' } });
  const result = await h.picker.loadModelOptions();
  assert.ok(result.error);
  assert.deepEqual(h.tuple(), expected);
  assert.equal(h.saves.length, 0);
  assert.ok(Object.values(h.controls).every(control => control.disabled));
  h.respond(catalog([luna]));
  await h.picker.loadModelOptions();
  assert.deepEqual(h.tuple(), expected);
  assert.ok(Object.values(h.controls).every(control => !control.disabled));
});

test('explicit provider switch selects the new provider catalog rather than carrying Luna across', async () => {
  const h = harness();
  h.respond(catalog([{ id: 'deepseek-v4-pro', label: 'DeepSeek', reasoningEfforts: ['low', 'high'], speedTiers: ['standard'] }], 'custom-provider', 'dpsk'));
  const result = await h.picker.loadModelOptions({ providerId: 'dpsk', providerRevision: 1 }, { persist: false });
  assert.equal(result.selectedModel, 'deepseek-v4-pro');
  assert.equal(h.saves.length, 0);
});

test('missing custom-provider catalog never falls back to Built-in models', async () => {
  const h = harness({ providerId: 'dpsk', model: 'deepseek-v4-pro', reasoningEffort: 'high', speedTier: 'standard' });
  h.respond(catalog([], 'custom-provider', 'dpsk'));
  const result = await h.picker.loadModelOptions({ providerId: 'dpsk', providerRevision: 1 });
  assert.ok(result.error);
  assert.equal(h.state.model, 'deepseek-v4-pro');
  assert.equal(h.saves.length, 0);
  assert.ok(h.controls['[data-model]'].disabled);
});

test('a stale model response cannot overwrite a newer completed discovery', async () => {
  const h = harness();
  let complete;
  h.respond(() => new Promise(resolve => { complete = resolve; }));
  const oldLoad = h.picker.loadModelOptions();
  h.respond(catalog([luna]));
  await h.picker.loadModelOptions();
  complete(catalog(Models.FALLBACK_MODELS, 'fallback'));
  assert.equal((await oldLoad).stale, true);
  assert.equal(h.tuple().model, luna.id);
  assert.equal(h.saves.length, 1);
});

test('direct fallback rendering preserves the explicitly selected model and controls', () => {
  const h = harness();
  const expected = h.tuple();
  h.picker.applyFallbackModelOptions(luna.id);
  assert.deepEqual(h.tuple(), expected);
});
