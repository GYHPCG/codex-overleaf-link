const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const test = require('node:test');
const Controller = require('../extension/src/content/otWarmMirrorController');
const Observer = require('../extension/src/page/overleafRealtimeObserver');

function createHarness(options = {}) {
  let state = { experimentalOtByProject: { example: true } };
  let content = 'Original text';
  let projectId = 'example';
  let busy = false;
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const document = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const observer = Observer.create({ document, window, getActiveFilePath: () => 'main.tex',
    readActiveEditorText: () => content });
  const context = vm.createContext({ window, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/otWarmMirror.js'), 'utf8'), context);
  const mirror = window.CodexOverleafOtWarmMirror.create({
    otWarmMirrorController: Controller,
    getState: () => state, setState: next => { state = next; },
    getCurrentProjectId: () => projectId, getPanel: () => null,
    getCurrentRunView: () => busy ? {} : null, tr: key => key,
    updateProbeStatusOtSuffix() {}, saveStateSoon() {},
    callPageBridge: async method => JSON.parse(JSON.stringify(
      method === 'startOtObserver' ? observer.start()
        : method === 'stopOtObserver' ? observer.stop()
          : method === 'drainOtEvents' ? { ok: true, events: observer.drainEvents() }
            : observer.getStatus()
    )),
    ...options
  });
  return { mirror, observer, timers, listeners, setContent(value) { content = value; },
    setBusy(value) { busy = value; },
    setProject(value) { projectId = value; state.experimentalOtByProject[value] = true; },
    async runTimer(delay) {
      const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'expected a scheduled OT timer with delay ' + delay);
      timers.delete(entry[0]); entry[1].callback();
      await new Promise(setImmediate);
    }
  };
}

test('OT startup accepts the actual JSON page-bridge response and starts polling', async () => {
  const { mirror, timers } = createHarness();
  await mirror.syncOtWarmMirrorController();
  assert.equal(mirror.getCurrentOtStatus(), 'observing');
  assert.equal(timers.size, 1);
  await mirror.pauseOtWarmMirror('running');
  assert.equal(timers.size, 0);
});

test('an unavailable editor read cannot become an empty-file OT deletion', () => {
  const { observer, listeners, setContent } = createHarness();
  observer.start();
  setContent(undefined);
  listeners.get('input')();
  assert.equal(observer.getStatus().state, 'unavailable');
  assert.equal(observer.drainEvents().length, 0);
});

test('known empty editor text remains a valid observed edit', () => {
  const { observer, listeners, setContent } = createHarness();
  observer.start();
  setContent('');
  listeners.get('input')();
  assert.equal(observer.getStatus().state, 'observing');
  assert.equal(observer.drainEvents()[0].nextContent, '');
});

test('old OT freshness cannot authorize warm reuse indefinitely', () => {
  const result = Controller.canUseOtWarmStart({ enabled: true, focusFiles: ['main.tex'],
    mirrorStatus: { exists: true, otFreshFiles: [{ path: 'main.tex', state: 'fresh', lastPatchAt: '2000-01-01T00:00:00.000Z' }] }
  });
  assert.equal(result.ok, false);
});

test('focused OT warm reuse verifies current content and carries fresh overlays', async () => {
  let snapshots = 0;
  const { mirror } = createHarness({
    getMirrorFreshness: async () => ({ exists: true, otFreshFiles: [{ path: 'main.tex', state: 'fresh', lastPatchAt: new Date().toISOString() }] }),
    mirrorHealth: { classifyMirrorHealth: () => ({ reusable: false }) },
    callPageBridge: async method => {
      assert.equal(method, 'getProjectSnapshot');
      snapshots += 1;
      return { files: [{ path: 'main.tex', content: 'new collaborator content' }] };
    },
    buildSnapshotFileOverlays: project => project.files,
    normalizeSnapshotPath: value => value
  });
  const result = await mirror.resolveWarmRunStart({ focusFiles: ['main.tex'], mode: 'ask' });
  assert.equal(snapshots, 1);
  assert.equal(result.otWarmStart, true);
  assert.equal(result.fileOverlays[0].content, 'new collaborator content');
});

test('real page events reach the Native mirror in order without claiming a full sync', async t => {
  const { handleRequest } = require('../native-host/src/taskRunner');
  const { getMirrorStatus, getProjectMirror } = require('../native-host/src/mirrorWorkspace');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-ot-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: root };
  await handleRequest({ id: 'baseline', method: 'mirror.sync', params: { projectId: 'example', project: {
    capabilities: { fullProjectSnapshot: true }, files: [{ path: 'main.tex', content: 'Original text' }]
  } } }, env);
  const before = getMirrorStatus('example', { rootDir: root });
  const requests = [];
  const fixture = createHarness({ sendBackgroundNative: async request => {
    requests.push(request.method);
    return handleRequest({ id: 'ot-patch', ...request }, env);
  } });
  await fixture.mirror.syncOtWarmMirrorController();
  fixture.setContent('First edit'); fixture.listeners.get('input')();
  fixture.setContent('Second edit'); fixture.listeners.get('input')();
  await fixture.runTimer(0);
  await fixture.runTimer(500);
  const after = getMirrorStatus('example', { rootDir: root });
  const mirror = getProjectMirror('example', { rootDir: root });
  assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'Second edit');
  assert.deepEqual(requests, ['mirror.patchFiles']);
  assert.equal(after.lastFullSyncAt, before.lastFullSyncAt);
  assert.equal(after.otFreshFileCount, 1);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'observing');
  await fixture.mirror.pauseOtWarmMirror('running');
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.listeners.has('input'), false);
});

test('an old project patch result cannot overwrite the next project status', async () => {
  let finish;
  const fixture = createHarness({ sendBackgroundNative: () => new Promise(resolve => { finish = resolve; }) });
  await fixture.mirror.syncOtWarmMirrorController();
  fixture.setContent('first project edit'); fixture.listeners.get('input')();
  await fixture.runTimer(0); await fixture.runTimer(500);
  assert.equal(typeof finish, 'function');
  fixture.setProject('second');
  await fixture.mirror.syncOtWarmMirrorController();
  finish({ ok: false, error: { code: 'project_locked' } });
  await new Promise(setImmediate);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'observing');
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastErrorCode, '');
});

test('paused or disabled observation cannot continue polling', async () => {
  const fixture = createHarness();
  fixture.setBusy(true);
  await fixture.mirror.syncOtWarmMirrorController();
  assert.equal(fixture.timers.size, 0);
  fixture.setBusy(false);
  await fixture.mirror.resumeOtWarmMirror();
  assert.equal(fixture.timers.size, 1);
  fixture.mirror.setExperimentalOtEnabledForProject('example', false);
  await fixture.mirror.syncOtWarmMirrorController();
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'off');
});
