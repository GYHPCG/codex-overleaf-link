'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ResultActions = require('../extension/src/content/runResultActions');
const { projectRunSettlement } = require('../extension/src/shared/settlementFacts');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname,
  '../extension/src/content/runTimelineView.js'), 'utf8'), sandbox);

function harness() {
  const calls = [];
  const root = {
    buttons: {},
    querySelector(selector) { return this.buttons[selector]; },
    querySelectorAll() { return []; }
  };
  function button(selector) {
    return {
      hidden: true, disabled: false, listeners: {},
      cloneNode() { return { ...button(selector), hidden: this.hidden, disabled: this.disabled }; },
      replaceWith(next) { root.buttons[selector] = next; },
      addEventListener(type, listener) { this.listeners[type] = listener; }
    };
  }
  root.buttons['[data-run-undo]'] = button('[data-run-undo]');
  root.buttons['[data-run-accept]'] = button('[data-run-accept]');
  const view = sandbox.window.CodexOverleafRunTimelineView.create({
    RunResultActions: ResultActions.create(),
    projectRunSettlement,
    trackedChangeInFlight: new Map(),
    tr: key => key,
    undoRun: id => calls.push(id)
  });
  return {
    calls,
    render(run) {
      view.configureUndoButton(root, run);
      view.configureAcceptButton(root, run);
      return { undo: root.buttons['[data-run-undo]'], accept: root.buttons['[data-run-accept]'] };
    }
  };
}

function assetRun(type = 'overwrite-binary') {
  return { id: 'asset-run', status: 'completed',
    appliedOperations: [{ type, path: 'figures/result.png' }],
    undoOperations: [], undoBaseFiles: [], undoExpectedFiles: [], undoTrackedChanges: [] };
}

for (const type of ['binary-create', 'overwrite-binary']) {
  test(`asset-only ${type} does not advertise an unavailable Undo`, () => {
    const run = assetRun(type);
    const before = JSON.stringify(run);
    assert.equal(projectRunSettlement(run).canUndo, true, 'reproduce the permissive canonical projection');
    const { undo, accept } = harness().render(run);
    assert.equal(undo.hidden, true);
    assert.equal(accept.hidden, true);
    assert.equal(undo.listeners.click, undefined);
    assert.equal(JSON.stringify(run), before, 'rendering must not change recovery or settlement data');
  });
}

test('rehydrated asset-only recovery payload does not inherit a stale top-level Undo capability', () => {
  const run = JSON.parse(JSON.stringify({ id: 'restored', status: 'completed',
    appliedOperations: [{ type: 'edit', path: 'old.tex' }], recoveryPayload: assetRun() }));
  assert.equal(harness().render(run).undo.hidden, true);
});

test('a reused run control removes the old Undo callback when only asset evidence remains', () => {
  const h = harness();
  assert.equal(h.render({ id: 'old', undoOperations: [{ type: 'edit', path: 'main.tex' }] }).undo.hidden, false);
  const { undo } = h.render(assetRun());
  assert.equal(undo.hidden, true);
  assert.equal(undo.listeners.click, undefined);
  assert.deepEqual(h.calls, []);
});

test('mixed text and asset writes keep the existing text fallback and Undo dispatch', () => {
  const run = assetRun();
  run.appliedOperations.push({ type: 'edit', path: 'main.tex' });
  const h = harness();
  const { undo } = h.render(run);
  assert.equal(undo.hidden, false);
  assert.equal(undo.disabled, false);
  undo.listeners.click({ stopPropagation() {} });
  assert.deepEqual(h.calls, [run.id]);
});

for (const field of ['undoOperations', 'undoBaseFiles', 'undoExpectedFiles']) {
  test(`asset display filtering preserves actual ${field} recovery evidence`, () => {
    const run = assetRun();
    run[field] = [{ type: 'edit', path: 'main.tex', content: 'saved baseline' }];
    assert.equal(harness().render(run).undo.hidden, false);
  });
}

for (const status of ['pending', 'needs_review']) {
  test(`tracked ${status} keeps Accept and Undo actionable`, () => {
    const { undo, accept } = harness().render({ ...assetRun(), trackedChangeStatus: status,
      undoTrackedChanges: [{ path: 'main.tex', id: 'tracked-change' }] });
    assert.equal(undo.hidden, false);
    assert.equal(undo.disabled, false);
    assert.equal(accept.hidden, false);
    assert.equal(accept.disabled, false);
  });
}

for (const status of ['accepted', 'rejected']) {
  test(`tracked ${status} retains both disabled terminal controls`, () => {
    const { undo, accept } = harness().render({ ...assetRun(), trackedChangeStatus: status });
    assert.equal(undo.hidden, false);
    assert.equal(undo.disabled, true);
    assert.equal(accept.hidden, false);
    assert.equal(accept.disabled, true);
    assert.equal(status === 'accepted' ? accept.textContent : undo.textContent,
      status === 'accepted' ? 'runAcceptTrackedDone' : 'undoApplied');
  });
}

test('legacy Undone history and fork snapshots keep their existing presentation', () => {
  const { undo } = harness().render({ ...assetRun(), undoStatus: 'applied' });
  assert.equal(undo.hidden, false);
  assert.equal(undo.disabled, true);
  assert.equal(undo.textContent, 'undoApplied');
  const fork = harness().render({ ...assetRun(), forkSnapshot: true });
  assert.equal(fork.undo.hidden, true);
  assert.equal(fork.accept.hidden, true);
});
