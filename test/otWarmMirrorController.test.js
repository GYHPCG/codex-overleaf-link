const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Controller = require('../extension/src/content/otWarmMirrorController');

test('exports positive OT warm mirror timing and batch constants', () => {
  assert.ok(Number.isInteger(Controller.OT_POLL_INTERVAL_MS));
  assert.ok(Controller.OT_POLL_INTERVAL_MS > 0);
  assert.ok(Number.isInteger(Controller.OT_PATCH_DEBOUNCE_MS));
  assert.ok(Controller.OT_PATCH_DEBOUNCE_MS > 0);
  assert.ok(Number.isInteger(Controller.OT_MAX_PATCH_BATCH));
  assert.ok(Controller.OT_MAX_PATCH_BATCH > 0);
});

test('exposes the controller as a browser global when CommonJS is unavailable', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/otWarmMirrorController.js'),
    'utf8'
  );
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.runInNewContext(source, sandbox, { filename: 'otWarmMirrorController.js' });

  assert.equal(
    typeof sandbox.CodexOverleafOtWarmMirrorController.buildPatchFilesRequest,
    'function'
  );
});

test('normalizes Overleaf focus paths and deduplicates normalized lists', () => {
  assert.equal(Controller.normalizePath('  @file:\\sections\\intro.tex  '), 'sections/intro.tex');
  assert.equal(Controller.normalizePath('@file: /main.tex'), 'main.tex');
  assert.equal(Controller.normalizePath('/a//b///c.tex'), 'a/b/c.tex');
  assert.equal(Controller.normalizePath(null), '');

  assert.deepEqual(
    Controller.normalizePaths([
      ' @file:/main.tex ',
      'main.tex',
      '\\sections\\intro.tex',
      '/sections/intro.tex',
      '',
      null
    ]),
    ['main.tex', 'sections/intro.tex']
  );
});

test('buildPatchFilesRequest sends only native patch fields for valid OT events', () => {
  const request = Controller.buildPatchFilesRequest({
    projectId: 'project-123',
    events: [
      {
        path: '@file:/main.tex',
        baseHash: ' base-hash ',
        nextHash: 'next-hash',
        previousContent: 'old',
        nextContent: 'new',
        ops: [{ retain: 1 }],
        observedVersion: 42,
        observedAt: '2026-05-05T00:00:00.000Z',
        source: 'page-bridge',
        diagnostic: 'do not forward'
      },
      { path: '', baseHash: 'base-hash', nextContent: 'skip' },
      { path: '../outside.tex', baseHash: 'base-hash', nextContent: 'skip' },
      { path: 'a/../b.tex', baseHash: 'base-hash', nextContent: 'skip' },
      { path: 'a/./b.tex', baseHash: 'base-hash', nextContent: 'skip' },
      { path: 'empty-base.tex', baseHash: '', nextContent: 'skip' },
      { path: 'blank-base.tex', baseHash: '   ', nextContent: 'skip' },
      { path: 'missing-content.tex', baseHash: 'base-hash' },
      { path: 'non-string-content.tex', baseHash: 'base-hash', nextContent: Buffer.from('skip') }
    ]
  });

  assert.deepEqual(request, {
    method: 'mirror.patchFiles',
    params: {
      projectId: 'project-123',
      source: 'ot',
      files: [
        {
          path: 'main.tex',
          baseHash: 'base-hash',
          nextContent: 'new',
          observedVersion: 42,
          observedAt: '2026-05-05T00:00:00.000Z'
        }
      ]
    }
  });
});

test('buildPatchFilesRequest can carry native compatibility evidence for background run gates', () => {
  const request = Controller.buildPatchFilesRequest({
    projectId: 'project-123',
    nativeCompatibility: {
      status: 'ok',
      extensionVersion: '0.4.0'
    },
    events: [
      {
        path: 'main.tex',
        baseHash: 'base-hash',
        nextContent: 'new'
      }
    ]
  });

  assert.deepEqual(request.params.nativeCompatibility, {
    status: 'ok',
    extensionVersion: '0.4.0'
  });
});

test('controller does not duplicate native compatibility policy', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/otWarmMirrorController.js'),
    'utf8'
  );

  assert.equal(Controller.isNativePatchFilesAllowed, undefined);
  assert.doesNotMatch(source, /isNativePatchFilesAllowed/);
  assert.doesNotMatch(source, /isNativeMethodAllowed\('mirror\.patchFiles'/);
});

test('buildPatchFilesRequest omits non-primitive OT metadata', () => {
  const request = Controller.buildPatchFilesRequest({
    projectId: 'project-123',
    events: [
      {
        path: 'main.tex',
        baseHash: 'base-hash',
        nextContent: 'new',
        observedVersion: ['version', { previousContent: 'raw text' }],
        observedAt: { source: 'page', previousContent: 'raw text' }
      },
      {
        path: 'appendix.tex',
        baseHash: 'base-hash-2',
        nextContent: 'new 2',
        observedVersion: () => 42,
        observedAt: Symbol('not-json')
      },
      {
        path: 'valid-metadata.tex',
        baseHash: 'base-hash-3',
        nextContent: 'new 3',
        observedVersion: 44,
        observedAt: true
      }
    ]
  });

  assert.deepEqual(request.params.files, [
    {
      path: 'main.tex',
      baseHash: 'base-hash',
      nextContent: 'new'
    },
    {
      path: 'appendix.tex',
      baseHash: 'base-hash-2',
      nextContent: 'new 2'
    },
    {
      path: 'valid-metadata.tex',
      baseHash: 'base-hash-3',
      nextContent: 'new 3',
      observedVersion: 44,
      observedAt: true
    }
  ]);
});

test('buildPatchFilesRequest caps patch batches while preserving order', () => {
  const events = Array.from({ length: Controller.OT_MAX_PATCH_BATCH + 3 }, (_, index) => ({
    path: `file-${index}.tex`,
    baseHash: `hash-${index}`,
    nextContent: `content-${index}`
  }));

  const request = Controller.buildPatchFilesRequest({ projectId: 'batch-project', events });

  assert.equal(request.params.files.length, Controller.OT_MAX_PATCH_BATCH);
  assert.deepEqual(
    request.params.files.map(file => file.path),
    events.slice(0, Controller.OT_MAX_PATCH_BATCH).map(event => event.path)
  );
  assert.deepEqual(
    request.params.files.map(file => file.baseHash),
    events.slice(0, Controller.OT_MAX_PATCH_BATCH).map(event => event.baseHash)
  );
});

test('shouldPauseOtWarmMirror pauses during local mutation and run states', () => {
  for (const state of ['running', 'writing', 'undoing', 'compiling']) {
    assert.deepEqual(Controller.shouldPauseOtWarmMirror(state), {
      pause: true,
      reason: state
    });
  }

  assert.deepEqual(Controller.shouldPauseOtWarmMirror('idle'), { pause: false });
  assert.deepEqual(Controller.shouldPauseOtWarmMirror(), { pause: false });
});

test('canUseOtWarmStart reports explicit blocker reasons before checking coverage', () => {
  assert.deepEqual(Controller.canUseOtWarmStart({
    enabled: false,
    focusFiles: ['main.tex'],
    mirrorStatus: { exists: true, otFreshFiles: [{ path: 'main.tex', state: 'fresh', lastPatchAt: new Date().toISOString() }] }
  }), {
    ok: false,
    reason: 'disabled'
  });

  assert.deepEqual(Controller.canUseOtWarmStart({
    enabled: true,
    focusFiles: ['main.tex'],
    mirrorStatus: null
  }), {
    ok: false,
    reason: 'mirror_missing'
  });

  assert.deepEqual(Controller.canUseOtWarmStart({
    enabled: true,
    focusFiles: [' ', null],
    mirrorStatus: { exists: true, otFreshFiles: [] }
  }), {
    ok: false,
    reason: 'no_focus_files'
  });
});

test('canUseOtWarmStart only allows normalized focused files covered by fresh OT entries', () => {
  assert.deepEqual(Controller.canUseOtWarmStart({
    enabled: true,
    focusFiles: ['@file:/main.tex', '\\sections\\intro.tex', 'main.tex'],
    mirrorStatus: {
      exists: true,
      otFreshFiles: [
        { path: 'main.tex', state: 'fresh', lastPatchAt: new Date().toISOString() },
        { path: 'sections/intro.tex', state: 'fresh', lastPatchAt: new Date().toISOString() },
        { path: 'stale.tex', state: 'stale' }
      ]
    }
  }), {
    ok: true,
    reason: 'ot_focus_fresh',
    focusFiles: ['main.tex', 'sections/intro.tex'],
    restrictToFocusFiles: true
  });

  assert.deepEqual(Controller.canUseOtWarmStart({
    enabled: true,
    focusFiles: ['main.tex', 'stale.tex'],
    mirrorStatus: {
      exists: true,
      otFreshFiles: [
        { path: 'main.tex', state: 'fresh', lastPatchAt: new Date().toISOString() },
        { path: 'stale.tex', state: 'stale' }
      ]
    }
  }), {
    ok: false,
    reason: 'missing_ot_fresh_focus'
  });

  assert.deepEqual(Controller.canUseOtWarmStart({
    enabled: true,
    focusFiles: ['main.tex'],
    mirrorStatus: {
      exists: true,
      otFreshFileCount: 1,
      otStaleFileCount: 0,
      otFreshFiles: []
    }
  }), {
    ok: false,
    reason: 'missing_ot_fresh_focus'
  });
});
