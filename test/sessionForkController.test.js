'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const SessionState = require('../extension/src/shared/sessionState');
const { create } = require('../extension/src/content/sessionForkController');

test('fork copies history through the selected turn and strips executable lifecycle payloads', async () => {
  let state = SessionState.normalizePanelState({
    sessions: [SessionState.createSession({
      title: 'Paper review', codexThreadId: 'thread-source',
      runs: [
        { id: 'run-1', task: 'one', status: 'completed', codexTurnId: 'turn-1', undoOperations: [{ type: 'edit' }] },
        { id: 'run-2', task: 'two', status: 'completed', codexTurnId: 'turn-2', undoTrackedChanges: [{ id: 'track' }] },
        { id: 'run-3', task: 'three', status: 'completed', codexTurnId: 'turn-3' }
      ]
    })]
  });
  const controller = create({
    SessionState,
    getState: () => state,
    setState: next => { state = next; },
    sendBackgroundNative: async request => ({ ok: true, result: { threadId: 'thread-forked', lastTurnId: request.params.lastTurnId } }),
    saveState: async () => {},
    applyStateToPanel: () => {},
    showPluginToast: () => {},
    tr: (key, values = {}) => key === 'forkSessionTitle' ? `${values.title} (fork)` : key
  });
  const forked = await controller.forkRunFromNode('run-2');
  assert.equal(forked.codexThreadId, 'thread-forked');
  assert.equal(forked.runs.length, 2);
  assert.equal(forked.runs.every(run => run.forkSnapshot), true);
  assert.deepEqual(forked.runs[0].undoOperations, []);
  assert.deepEqual(forked.runs[1].undoTrackedChanges, []);
  assert.equal(forked.forkedFromRunId, 'run-2');
});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const StorageDb = require('../extension/src/shared/storageDb');
const ActiveTurnControl = require('../extension/src/content/activeTurnControl');

function originRun(overrides = {}) {
  return { id: 'origin-run', task: 'Origin', status: 'completed',
    codexThreadId: 'thread-original', codexTurnId: 'turn-original', ...overrides };
}
function forkHarness(run = originRun(), send) {
  let state = { sessions: [{ id: 'source-session', title: 'QA',
    codexThreadId: 'thread-after-provider-switch', runs: [run] }] };
  const requests = [];
  const notices = [];
  const controller = create({
    SessionState, getState: () => state, setState: next => { state = next; },
    sendBackgroundNative: async request => {
      requests.push(request);
      return send ? send(request) : { ok: true, result: { threadId: 'fork-thread' } };
    },
    saveState: async () => {}, applyStateToPanel() {},
    showPluginToast: (message, options) => notices.push({ message, ...options }),
    tr: key => key
  });
  return { controller, requests, notices, getState: () => state };
}

test('Fork uses the selected run thread after the session provider changes', async () => {
  const h = forkHarness();
  await h.controller.forkRunFromNode('origin-run');
  assert.equal(h.requests[0].params.threadId, 'thread-original');
  assert.equal(h.requests[0].params.lastTurnId, 'turn-original');
});

test('run origin survives panel normalization and both storage projections', () => {
  const session = SessionState.createSession({
    id: 'source-session', title: 'QA', codexThreadId: 'thread-current',
    runs: [originRun()]
  });
  const state = SessionState.normalizePanelState({
    sessions: [session], activeSessionId: session.id
  });
  assert.equal(state.sessions[0].runs[0].codexThreadId, 'thread-original');
  const compact = SessionState.prepareStateForStorage(state);
  assert.equal(compact.sessions[0].runs[0].codexThreadId, 'thread-original');
  const stored = StorageDb.buildSessionRecord({ ...session, projectId: 'qa-project' });
  assert.equal(stored.runs[0].codexThreadId, 'thread-original');
  const restored = SessionState.normalizePanelState({
    sessions: [stored], activeSessionId: stored.id
  });
  assert.equal(restored.sessions[0].runs[0].codexThreadId, 'thread-original');
});

test('IndexedDB compaction independently preserves the run origin', () => {
  const stored = StorageDb.buildSessionRecord({
    id: 'qa-session', projectId: 'qa-project', runs: [originRun()]
  });
  assert.equal(stored.runs[0].codexThreadId, 'thread-original');
});

test('live turn binding saves a paired thread and turn identity on the real run record', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
  const declaration = source.match(/  function bindActiveTurn\(detail = \{\}, journalSeq = 0\) \{[\s\S]*?\n  \}/);
  assert.ok(declaration);
  const record = { id: 'origin-run' };
  const session = {};
  const bind = vm.runInNewContext(declaration[0] + '\n bindActiveTurn;', {
    currentRunView: { recordId: record.id, sessionId: 'qa-session' },
    findRunRecord: () => record,
    updateSessionById: (_id, patch) => Object.assign(session, patch),
    renderPendingInputs() {}, saveState: async () => {}
  });
  bind({ threadId: 'thread-original', turnId: 'turn-original' }, 4);
  assert.equal(record.codexThreadId, 'thread-original');
  assert.equal(record.codexTurnId, 'turn-original');
  assert.equal(session.codexThreadId, 'thread-original');
});

test('recovered turn bindings retain their per-run origin', async () => {
  const record = { id: 'origin-run', status: 'completed', events: [] };
  const session = { id: 'qa-session', runs: [record] };
  const control = ActiveTurnControl.create({ chrome: { runtime: {
    sendMessage: async () => ({ ok: true, journals: [{
      terminal: true, sessionId: session.id, clientRunId: record.id,
      requestId: 'request-origin', events: [{ sequence: 1, event: {
        type: 'codex.turn.bound',
        detail: { threadId: 'thread-original', turnId: 'turn-original' }
      } }]
    }] })
  } } });
  await control.recoverJournals({ projectKey: 'qa-project', findSession: () => session });
  assert.equal(record.codexThreadId, 'thread-original');
  assert.equal(record.codexTurnId, 'turn-original');
  control.destroy();
});

test('transport rejection surfaces a sticky failure instead of disappearing in the button handler', async () => {
  const error = Object.assign(new Error('Native fork request failed'), { code: 'native_fork_failed' });
  const h = forkHarness(originRun(), async () => { throw error; });
  const before = h.getState();
  await assert.rejects(h.controller.forkRunFromNode('origin-run'), { code: error.code });
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].message, error.message);
  assert.equal(h.notices[0].status, 'failed');
  assert.equal(h.notices[0].sticky, true);
  assert.equal(h.getState(), before);
});

test('older interrupted records use their recorded draft thread before a changed session thread', async () => {
  const h = forkHarness(originRun({
    codexThreadId: '',
    interruptedDraft: { threadId: 'thread-draft', turnId: 'turn-original' }
  }));
  await h.controller.forkRunFromNode('origin-run');
  assert.equal(h.requests[0].params.threadId, 'thread-draft');
});

test('a run with a saved origin can fork immediately after the session thread is reset', async () => {
  const h = forkHarness();
  h.getState().sessions[0].codexThreadId = '';
  await h.controller.forkRunFromNode('origin-run');
  assert.equal(h.requests[0].params.threadId, 'thread-original');
});

test('legacy runs without an origin retain the existing session-thread fallback', async () => {
  const h = forkHarness(originRun({ codexThreadId: '' }));
  await h.controller.forkRunFromNode('origin-run');
  assert.equal(h.requests[0].params.threadId, 'thread-after-provider-switch');
});

test('an interrupted draft from a different turn cannot supply a fork origin', async () => {
  const h = forkHarness(originRun({
    codexThreadId: '',
    interruptedDraft: { threadId: 'unrelated-thread', turnId: 'different-turn' }
  }));
  await h.controller.forkRunFromNode('origin-run');
  assert.equal(h.requests[0].params.threadId, 'thread-after-provider-switch');
});

for (const turnId of [undefined, '', null]) {
  test(`legacy Fork with ${String(turnId)} turn identity reports unavailable without dispatch`, async () => {
    const h = forkHarness(originRun({ codexThreadId: '', codexTurnId: turnId }));
    const before = h.getState();
    await assert.rejects(h.controller.forkRunFromNode('origin-run'), { code: 'session_fork_unavailable' });
    assert.equal(h.requests.length, 0);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].status, 'failed');
    assert.equal(h.notices[0].sticky, true);
    assert.equal(h.getState(), before);
  });
}
