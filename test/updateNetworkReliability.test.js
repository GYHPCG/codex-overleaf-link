const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkForUpdate } = require('../native-host/src/updateManager');

test('the installed update checker recovers a transient connection failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-update-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { nativeRoot: root, extensionRoot: root, updatesRoot: root, managed: true };
  fs.writeFileSync(path.join(root, 'active-version'), '2.3.5');
  let attempts = 0;
  const result = await checkForUpdate(context, { currentVersion: '2.3.5' }, {
    network: { maxAttempts: 3, delayMs: 0 },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connection timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
        });
      }
      return {
        ok: true, status: 200,
        url: 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v2.3.5',
        headers: new Headers()
      };
    }
  });
  assert.equal(result.reason, 'up_to_date');
  assert.equal(attempts, 2);
});
