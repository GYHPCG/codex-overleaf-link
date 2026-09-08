'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const debugLog = require('../native-host/src/debugLog');
const { getDebugLogPath } = debugLog;
const {
  syncOverleafToMirror,
  getProjectMirror,
  getMirrorStatus,
  applyFileOverlays,
  markMirrorDirty,
  patchMirrorFiles
} = require('../native-host/src/mirrorWorkspace');

let tempRoot;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-status-'));
});

test('debug log path uses USERPROFILE fallback when HOME is absent', () => {
  const userProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-log-profile-'));
  try {
    assert.equal(
      getDebugLogPath({ platform: 'darwin', env: { USERPROFILE: userProfile } }),
      path.posix.join(userProfile, '.codex-overleaf', 'native-host.log')
    );
  } finally {
    fs.rmSync(userProfile, { recursive: true, force: true });
  }
});

test('Windows debug log path uses the native host local data root', () => {
  assert.equal(
    getDebugLogPath({
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\Alice'
      }
    }),
    'C:\\Users\\Alice\\AppData\\Local\\CodexOverleaf\\native-host.log'
  );
});

test('exported LOG_PATH reflects HOME changes after module load', t => {
  if (process.platform === 'win32') {
    t.skip('HOME is not the default native host log root on Windows');
    return;
  }
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-log-dynamic-home-'));
  try {
    process.env.HOME = tempHome;

    assert.equal(
      debugLog.LOG_PATH,
      path.join(tempHome, '.codex-overleaf', 'native-host.log')
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('syncOverleafToMirror writes lastFullSyncAt to baseline', async () => {
  const before = Date.now();
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: '\\documentclass{article}' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  assert.ok(baseline.lastFullSyncAt);
  const syncTime = new Date(baseline.lastFullSyncAt).getTime();
  assert.ok(syncTime >= before);
  assert.ok(syncTime <= Date.now());
});

test('getMirrorStatus returns exists:true with correct age after sync', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'hello' }] },
    rootDir: tempRoot
  });
  const status = getMirrorStatus('test-proj', { rootDir: tempRoot });
  assert.strictEqual(status.exists, true);
  assert.strictEqual(status.fileCount, 1);
  assert.ok(status.ageMs >= 0);
  assert.ok(status.ageMs < 5000);
  assert.ok(status.baselineCapturedAt);
});

test('getMirrorStatus reports project key and full/partial sync timestamps', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { capabilities: { fullProjectSnapshot: true }, files: [{ path: 'main.tex', content: 'hello' }] },
    rootDir: tempRoot
  });
  const status = getMirrorStatus('test-proj', { rootDir: tempRoot });
  assert.equal(status.projectKey, 'test-proj');
  assert.equal(status.exists, true);
  assert.ok(status.lastFullSyncAt);
  assert.equal(status.lastPartialSyncAt || '', '');
  assert.equal(status.lastFileCount, 1);
});

test('partial sync does not update project-level freshness', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { capabilities: { fullProjectSnapshot: true }, files: [{ path: 'main.tex', content: 'full' }] },
    rootDir: tempRoot
  });
  const fullStatus = getMirrorStatus('test-proj', { rootDir: tempRoot });
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { capabilities: { fullProjectSnapshot: false }, files: [{ path: 'main.tex', content: 'partial' }] },
    rootDir: tempRoot
  });
  const partialStatus = getMirrorStatus('test-proj', { rootDir: tempRoot });
  assert.equal(partialStatus.lastFullSyncAt, fullStatus.lastFullSyncAt);
  assert.ok(partialStatus.lastPartialSyncAt);
});

test('getMirrorStatus returns exists:false for unknown project', () => {
  const status = getMirrorStatus('nonexistent', { rootDir: tempRoot });
  assert.strictEqual(status.exists, false);
  assert.strictEqual(status.fileCount, 0);
  assert.strictEqual(status.otFreshFileCount, 0);
  assert.strictEqual(status.otStaleFileCount, 0);
  assert.strictEqual(status.lastOtPatchAt, '');
  assert.strictEqual(status.lastOtErrorCode, '');
  assert.deepStrictEqual(status.otFreshFiles, []);
});

test('applyFileOverlays writes content to workspace', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  await applyFileOverlays({
    projectId: 'test-proj',
    overlays: [{ path: 'main.tex', content: 'new content', hash: 'abc123' }],
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const content = fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8');
  assert.strictEqual(content, 'new content');
});

test('applyFileOverlays updates per-file baseline but not lastFullSyncAt', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old' }] },
    rootDir: tempRoot
  });
  const statusBefore = getMirrorStatus('test-proj', { rootDir: tempRoot });

  await applyFileOverlays({
    projectId: 'test-proj',
    overlays: [{ path: 'main.tex', content: 'new', hash: 'xyz' }],
    rootDir: tempRoot
  });

  const statusAfter = getMirrorStatus('test-proj', { rootDir: tempRoot });
  assert.strictEqual(statusAfter.baselineCapturedAt, statusBefore.baselineCapturedAt);

  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entry = baseline.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entry.content, 'new');
  assert.strictEqual(entry.hash, 'xyz');
});

test('applyFileOverlays can add a new file without affecting others', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'hello' }] },
    rootDir: tempRoot
  });
  await applyFileOverlays({
    projectId: 'test-proj',
    overlays: [{ path: 'refs.bib', content: '@article{foo}' }],
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'hello');
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'refs.bib'), 'utf8'), '@article{foo}');
});

test('patchMirrorFiles applies verified text patch without updating lastFullSyncAt', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryBefore = baselineBefore.files.find(f => f.path === 'main.tex');

  const result = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    source: 'ot',
    files: [{
      path: 'main.tex',
      baseHash: entryBefore.hash,
      nextContent: 'patched content',
      observedVersion: 12
    }]
  });

  assert.strictEqual(result.appliedCount, 1);
  assert.strictEqual(result.skippedCount, 0);
  assert.deepStrictEqual(result.appliedFiles.map(file => file.path), ['main.tex']);
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'patched content');

  const baselineAfter = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  assert.strictEqual(baselineAfter.lastFullSyncAt, baselineBefore.lastFullSyncAt);
  assert.strictEqual(baselineAfter.capturedAt, baselineBefore.capturedAt);
  assert.ok(baselineAfter.lastOtPatchAt);
  assert.strictEqual(baselineAfter.lastOtErrorCode, '');

  const entryAfter = baselineAfter.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entryAfter.content, 'patched content');
  assert.notStrictEqual(entryAfter.hash, entryBefore.hash);
  assert.deepStrictEqual(entryAfter.freshness, {
    source: 'ot',
    state: 'fresh',
    lastFullSyncAt: baselineBefore.lastFullSyncAt,
    lastPatchAt: baselineAfter.lastOtPatchAt,
    observedAt: baselineAfter.lastOtPatchAt,
    observedVersion: 12
  });
});

test('patchMirrorFiles treats replayed applied patch as idempotent success', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryBefore = baselineBefore.files.find(f => f.path === 'main.tex');
  const patch = {
    path: 'main.tex',
    baseHash: entryBefore.hash,
    nextContent: 'patched content',
    observedVersion: 12
  };

  const firstResult = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    source: 'ot',
    files: [patch]
  });
  assert.strictEqual(firstResult.appliedCount, 1);
  assert.strictEqual(firstResult.skippedCount, 0);

  const baselineAfterFirst = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryAfterFirst = baselineAfterFirst.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entryAfterFirst.content, 'patched content');
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'patched content');

  const replayResult = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    source: 'ot',
    files: [patch]
  });

  assert.strictEqual(replayResult.appliedCount, 1);
  assert.strictEqual(replayResult.skippedCount, 0);
  assert.deepStrictEqual(replayResult.skippedFiles, []);
  assert.deepStrictEqual(replayResult.appliedFiles.map(file => ({
    path: file.path,
    hash: file.hash,
    idempotent: file.idempotent
  })), [{
    path: 'main.tex',
    hash: entryAfterFirst.hash,
    idempotent: true
  }]);
  assert.strictEqual(JSON.stringify(replayResult).includes('patched content'), false);
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'patched content');

  const baselineAfterReplay = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  assert.deepStrictEqual(baselineAfterReplay, baselineAfterFirst);
});

test('patchMirrorFiles skips base hash mismatch and unsafe path', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });

  const result = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [
      { path: 'main.tex', baseHash: 'wrong-hash', nextContent: 'should not write' },
      { path: '../outside.tex', nextContent: 'unsafe' }
    ]
  });

  assert.strictEqual(result.appliedCount, 0);
  assert.deepStrictEqual(result.skippedFiles.map(file => [file.path, file.reason]), [
    ['main.tex', 'base_hash_mismatch'],
    ['../outside.tex', 'unsafe_path']
  ]);
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'old content');

  const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entry = baseline.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entry.content, 'old content');
  assert.strictEqual(baseline.lastOtErrorCode, 'unsafe_path');
});

test('patchMirrorFiles requires a non-empty matching base hash', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });

  const result = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [
      { path: 'main.tex', nextContent: 'missing base hash' },
      { path: 'main.tex', baseHash: '', nextContent: 'empty base hash' },
      { path: 'main.tex', baseHash: 123, nextContent: 'non-string base hash' }
    ]
  });

  assert.strictEqual(result.appliedCount, 0);
  assert.deepStrictEqual(result.skippedFiles.map(file => [file.path, file.reason]), [
    ['main.tex', 'missing_base_hash'],
    ['main.tex', 'missing_base_hash'],
    ['main.tex', 'missing_base_hash']
  ]);
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'old content');

  const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entry = baseline.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entry.content, 'old content');
  assert.strictEqual(baseline.lastOtErrorCode, 'missing_base_hash');
});

test('patchMirrorFiles skips when mirror has an explicit dirty marker', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryBefore = baselineBefore.files.find(f => f.path === 'main.tex');
  markMirrorDirty({ projectId: 'test-proj', rootDir: tempRoot, reason: 'local_dirty' });

  const result = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [{
      path: 'main.tex',
      baseHash: entryBefore.hash,
      nextContent: 'should not clean dirty mirror'
    }]
  });

  assert.strictEqual(result.appliedCount, 0);
  assert.deepStrictEqual(result.skippedFiles.map(file => [file.path, file.reason]), [
    ['main.tex', 'dirty_mirror']
  ]);
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'old content');

  const baselineAfter = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryAfter = baselineAfter.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entryAfter.content, 'old content');
  assert.strictEqual(baselineAfter.dirty, true);
  assert.strictEqual(baselineAfter.lastOtErrorCode, 'dirty_mirror');
});

test('patchMirrorFiles skips when workspace content no longer matches baseline', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryBefore = baselineBefore.files.find(f => f.path === 'main.tex');
  fs.writeFileSync(path.join(mirror.workspacePath, 'main.tex'), 'local dirty edit', 'utf8');

  const result = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [{
      path: 'main.tex',
      baseHash: entryBefore.hash,
      nextContent: 'should not clean mismatch'
    }]
  });

  assert.strictEqual(result.appliedCount, 0);
  assert.deepStrictEqual(result.skippedFiles.map(file => [file.path, file.reason]), [
    ['main.tex', 'workspace_mismatch']
  ]);
  assert.strictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'local dirty edit');

  const baselineAfter = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryAfter = baselineAfter.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entryAfter.content, 'old content');
  assert.strictEqual(baselineAfter.lastOtErrorCode, 'workspace_mismatch');
});

test('patchMirrorFiles refuses symlinked workspace parents before writing', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'sections/main.tex', content: 'old content' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryBefore = baselineBefore.files.find(f => f.path === 'sections/main.tex');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-status-outside-'));
  fs.rmSync(path.join(mirror.workspacePath, 'sections'), { recursive: true, force: true });
  fs.symlinkSync(outsideDir, path.join(mirror.workspacePath, 'sections'), 'dir');

  const result = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [{
      path: 'sections/main.tex',
      baseHash: entryBefore.hash,
      nextContent: 'should not escape workspace'
    }]
  });

  assert.strictEqual(result.appliedCount, 0);
  assert.deepStrictEqual(result.skippedFiles.map(file => [file.path, file.reason]), [
    ['sections/main.tex', 'unsafe_path']
  ]);
  assert.strictEqual(fs.existsSync(path.join(outsideDir, 'main.tex')), false);

  const baselineAfter = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entryAfter = baselineAfter.files.find(f => f.path === 'sections/main.tex');
  assert.strictEqual(entryAfter.content, 'old content');
  assert.strictEqual(baselineAfter.lastOtErrorCode, 'unsafe_path');
});

test('getMirrorStatus reports OT fresh file paths without file content', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: {
      files: [
        { path: 'main.tex', content: 'old main' },
        { path: 'refs.bib', content: '@article{old}' }
      ]
    },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const mainEntry = baselineBefore.files.find(f => f.path === 'main.tex');

  await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [{ path: 'main.tex', baseHash: mainEntry.hash, nextContent: 'fresh main', observedVersion: 13 }]
  });

  const status = getMirrorStatus('test-proj', { rootDir: tempRoot });
  assert.strictEqual(status.otFreshFileCount, 1);
  assert.strictEqual(status.otStaleFileCount, 1);
  assert.ok(status.lastOtPatchAt);
  assert.strictEqual(status.lastOtErrorCode, '');
  assert.deepStrictEqual(status.otFreshFiles.map(file => file.path), ['main.tex']);
  assert.strictEqual(status.otFreshFiles[0].observedVersion, 13);
  assert.strictEqual(Object.hasOwn(status.otFreshFiles[0], 'content'), false);
  assert.strictEqual(JSON.stringify(status).includes('fresh main'), false);
  assert.strictEqual(JSON.stringify(status).includes('@article{old}'), false);
});

test('getMirrorStatus returns OT safe defaults for dirty mirrors', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'main.tex', content: 'old main' }] },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const mainEntry = baselineBefore.files.find(f => f.path === 'main.tex');

  await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [{ path: 'main.tex', baseHash: mainEntry.hash, nextContent: 'fresh main', observedVersion: 13 }]
  });
  markMirrorDirty({ projectId: 'test-proj', rootDir: tempRoot, reason: 'local_dirty' });

  const status = getMirrorStatus('test-proj', { rootDir: tempRoot });
  assert.strictEqual(status.exists, false);
  assert.strictEqual(status.dirty, true);
  assert.strictEqual(status.otFreshFileCount, 0);
  assert.strictEqual(status.otStaleFileCount, 0);
  assert.ok(status.lastOtPatchAt);
  assert.deepStrictEqual(status.otFreshFiles, []);
  assert.strictEqual(JSON.stringify(status).includes('fresh main'), false);
});

test('patchMirrorFiles skips binary files, missing baselines, and missing content', async () => {
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: {
      files: [
        { path: 'main.tex', content: 'old content' },
        { path: 'Figure/plot.pdf', contentBase64: Buffer.from([0, 1, 2]).toString('base64') }
      ]
    },
    rootDir: tempRoot
  });
  const mirror = getProjectMirror('test-proj', { rootDir: tempRoot });
  const baselineBefore = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const mainEntry = baselineBefore.files.find(f => f.path === 'main.tex');
  const binaryEntry = baselineBefore.files.find(f => f.path === 'Figure/plot.pdf');

  const result = await patchMirrorFiles({
    projectId: 'test-proj',
    rootDir: tempRoot,
    files: [
      { path: 'missing.tex', baseHash: 'missing-hash', nextContent: 'new file' },
      { path: 'Figure/plot.pdf', baseHash: binaryEntry.hash, nextContent: 'not really pdf' },
      { path: 'main.tex', baseHash: mainEntry.hash }
    ]
  });

  assert.strictEqual(result.appliedCount, 0);
  assert.deepStrictEqual(result.skippedFiles.map(file => [file.path, file.reason]), [
    ['missing.tex', 'missing_baseline'],
    ['Figure/plot.pdf', 'not_text'],
    ['main.tex', 'missing_content']
  ]);
  assert.deepStrictEqual(fs.readFileSync(path.join(mirror.workspacePath, 'Figure/plot.pdf')), Buffer.from([0, 1, 2]));

  const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entry = baseline.files.find(f => f.path === 'main.tex');
  assert.strictEqual(entry.content, 'old content');
  assert.strictEqual(baseline.lastOtErrorCode, 'missing_content');
});

test('handleRequest mirror.status returns status for known project', async () => {
  const { handleRequest } = require('../native-host/src/taskRunner');
  await syncOverleafToMirror({
    projectId: 'test-proj',
    project: { files: [{ path: 'a.tex', content: 'x' }] },
    rootDir: tempRoot
  });
  const response = await handleRequest(
    { id: 'req1', method: 'mirror.status', params: { projectId: 'test-proj' } },
    { CODEX_OVERLEAF_MIRROR_ROOT: tempRoot }
  );
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.result.exists, true);
  assert.strictEqual(response.result.fileCount, 1);
});
