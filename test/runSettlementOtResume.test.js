const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const start = source.indexOf('      const settledView = currentRunView;');
const end = source.indexOf('\n    }\n  }\n\n  async function runSkillInstallerTask', start);
assert.ok(start >= 0 && end > start, 'the actual run-finally body must be available');
const finallyBody = source.slice(start, end);

for (const scenario of ['normal', 'ot-error', 'disabled', 'cancelled']) {
  test('real run settlement persists and releases ownership before OT resume: ' + scenario, async () => {
    const calls = [];
    const view = { recordId: 'run', sessionId: 'session', nativeRequestId: 'request',
      terminalStatus: scenario === 'cancelled' ? 'cancelled' : 'completed' };
    const context = {
      currentRunView: view, runCancellationRequested: scenario === 'cancelled', runCancellationController: {},
      findRunRecord: () => ({ status: view.terminalStatus }),
      setRunning: () => calls.push('not-running'),
      nativeChannel: { clearActiveRequest: () => calls.push('clear-request') },
      stopRunElapsedTick() {},
      async flushQueuedSaveState() {
        assert.equal(context.currentRunView, view, 'terminal persistence retains the original view');
        calls.push('persist');
      },
      activeTurnControl: {
        release(id) { assert.equal(id, 'request'); calls.push('release'); },
        async acknowledge() { calls.push('acknowledge'); }
      },
      isExperimentalOtEnabled: () => scenario !== 'disabled',
      async resumeOtWarmMirror() {
        assert.equal(context.currentRunView, null);
        assert.equal(context.runCancellationController, null);
        assert.ok(calls.includes('persist') && calls.includes('release'));
        calls.push('resume');
        if (scenario === 'ot-error') throw new Error('observer unavailable');
      },
      updateOtStatusDisplay(status) { assert.equal(status, 'unavailable'); calls.push('ot-unavailable'); },
      runQueueScheduler: { async afterSettlement(settlement) {
        assert.equal(settlement.status, view.terminalStatus);
        assert.equal(settlement.continueQueue, scenario === 'cancelled');
        calls.push('queue');
      } }
    };
    const finalize = vm.runInNewContext('(async () => {' + finallyBody + '\n})', context);
    await finalize();
    assert.ok(calls.includes('acknowledge') && calls.includes('queue'));
    assert.equal(calls.includes('resume'), scenario !== 'disabled');
    assert.equal(calls.includes('ot-unavailable'), scenario === 'ot-error');
    assert.equal(context.currentRunView, null);
  });
}
