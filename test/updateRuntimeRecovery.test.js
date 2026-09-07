const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');

async function harness(options = {}) {
  const key = 'codex-overleaf-managed-update-state-v1';
  const data = { [key]: { state: 'failed', currentVersion: '2.3.5', latestVersion: '2.3.6',
    code: 'update_network_failed', message: 'old failure' }, ...(options.data || {}) };
  let listener;
  let reloads = 0;
  const status = options.status || { managed: true, activeVersion: '2.3.6', runtimeVersion: '2.3.5',
    installedAligned: true, transaction: null, authorization: null };
  const context = { URL, crypto, Date, setTimeout, clearTimeout, console,
    chrome: {
      runtime: { id: 'fixture', getManifest: () => ({ version: options.version || '2.3.5' }),
        getURL: value => 'chrome-extension://fixture/' + value,
        onMessage: { addListener(value) { listener = value; } }, reload() { reloads += 1; } },
      storage: {
        local: { async get(keys) { const result = {}; for (const item of Array.isArray(keys) ? keys : [keys]) result[item] = data[item]; return structuredClone(result); },
          async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; } },
        session: { async get(key) { return { [key]: true }; }, async set() {} },
        onChanged: { addListener() {} }
      },
      alarms: { create() {}, async clear() {}, onAlarm: { addListener() {} } },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      tabs: { async query() { return [{ id: 1, url: 'https://www.overleaf.com/project/example' }]; },
        async sendMessage(_id, message) { return message.type === 'codex-overleaf/update-idle-probe'
          ? { idle: options.busy !== true, blockers: options.busy ? ['run_active'] : [] } : {}; },
        async reload() {} }
    }
  };
  const sandbox = vm.createContext(context);
  for (const file of ['extension/bootstrap/updateStatus.js', 'extension/src/shared/managedUpdateProjection.js',
    'extension/src/shared/updateConsent.js', 'extension/src/shared/updateRevocationIntent.js',
    'extension/src/shared/updateRuntimeIdentity.js', 'extension/src/backgroundUpdateCoordinator.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
  }
  sandbox.CodexOverleafUpdateCoordinator.init({ nativeBridge: {
    getPendingState: () => ({ executionRequests: 0 }),
    async requestInternal(request) { return { ok: true, result: request.method === 'update.status'
      ? status : request.method === 'update.canApply' ? { idle: true, blockers: [] } : {} }; }
  } });
  await new Promise(setImmediate);
  return { data, reloads: () => reloads,
    send(type) { return new Promise(resolve => {
      const handled = listener({ type }, { id: 'fixture', url: 'https://www.overleaf.com/project/example' }, resolve);
      if (!handled) resolve({ ok: false, error: { code: 'unhandled_action' } });
    }); }
  };
}

test('the real coordinator projects manual installation as awaiting restart', async () => {
  const fixture = await harness();
  const response = await fixture.send('codex-overleaf/consent-update-get-state');
  assert.equal(response.result.state.state, 'reload_required');
  assert.equal(response.result.runtime.installedVersion, '2.3.6');
  assert.equal(response.result.showPanel, true);
});

test('the real reload action preserves the saved-and-idle guard', async () => {
  const fixture = await harness({ busy: true });
  const response = await fixture.send('codex-overleaf/consent-update-reload');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'update_reload_busy');
  assert.equal(fixture.reloads(), 0);
});

test('an idle verified installation can restart and records only Overleaf tabs', async () => {
  const fixture = await harness();
  const response = await fixture.send('codex-overleaf/consent-update-reload');
  assert.equal(response.ok, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fixture.reloads(), 1);
  assert.deepEqual(fixture.data['codex-overleaf-manual-runtime-reload-v1'], { targetVersion: '2.3.6', tabIds: [1] });
});

test('matching running versions retire only an obsolete failed update', async () => {
  const fixture = await harness({ version: '2.3.6', status: { managed: true, activeVersion: '2.3.6',
    runtimeVersion: '2.3.6', installedAligned: true, transaction: null, authorization: null } });
  const response = await fixture.send('codex-overleaf/consent-update-get-state');
  assert.equal(response.result.state.state, 'idle');
  assert.equal(response.result.state.code, '');
});
