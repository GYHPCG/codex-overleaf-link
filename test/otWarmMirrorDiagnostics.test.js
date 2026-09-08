const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Controller = require('../extension/src/content/otWarmMirrorController');
const I18n = require('../extension/src/shared/i18n');

function create(failureActive) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsController.js'), 'utf8'), { window });
  return window.CodexOverleafDiagnosticsController.create({
    tr: key => I18n.t('en', key), tx: en => en,
    isExperimentalOtEnabled: () => false,
    getOtWarmMirrorState: () => ({ failureActive,
      lastFailure: { code: 'ot_bridge_unavailable', phase: 'start', at: 1000 } }),
    otWarmMirrorController: Controller,
    callPageBridge: () => { throw new Error('disabled diagnostics must not start a live probe'); },
    getMirrorFreshness: () => { throw new Error('disabled diagnostics must not read project files'); }
  });
}

test('an ordinary disabled OT mirror remains a healthy no-probe state', async () => {
  const result = await create(false).inspectOtWarmMirrorDiagnostics({ collectOnly: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.technical, '');
});

test('automatic disable after failed startup preserves actionable failure diagnostics', async () => {
  const result = await create(true).inspectOtWarmMirrorDiagnostics({ collectOnly: true });
  assert.equal(result.status, 'warning');
  assert.match(result.summary, /reload/i);
  assert.match(result.technical, /ot_bridge_unavailable/);
  assert.match(result.technical, /start/);
});
