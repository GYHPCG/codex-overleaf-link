const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'),
  'utf8'
);

test('writeback orchestrator initializes injected settlement dependencies in strict mode', () => {
  const windowObject = {};
  new Function('window', source)(windowObject);

  const onMirrorRefreshSettled = () => {};
  const writebackSettlement = {};
  let orchestrator;

  assert.doesNotThrow(() => {
    orchestrator = windowObject.CodexOverleafWritebackOrchestrator.create({
      onMirrorRefreshSettled,
      writebackSettlement
    });
  });
  assert.equal(typeof orchestrator.applySyncChangesToOverleaf, 'function');
  assert.equal(typeof orchestrator.resolveCompileLogContext, 'function');
});

test('governance-only rejection remains visible in the completion report', async () => {
  const windowObject = {};
  new Function('window', source)(windowObject);

  const operation = { type: 'edit', path: 'example/test2.tex' };
  const skippedEntry = {
    operation,
    result: {
      ok: false,
      code: 'governance_blocked',
      reason: 'Project governance marked this path read-only, so Codex did not write it.'
    }
  };
  let completionReport = null;

  const orchestrator = windowObject.CodexOverleafWritebackOrchestrator.create({
    tr: key => key,
    tx: english => english,
    appendRunEvent() {},
    appendChangeSummary() {},
    appendCompletionReport(input) {
      completionReport = input;
    },
    appendApplyResult() {},
    getState: () => ({ mode: 'auto', requireReviewing: true }),
    getAssistantAnswerForCurrentRun: () => 'Local edit completed.',
    cleanFinalAnswer: value => value,
    buildSyncApplyOperations: () => [operation],
    partitionUnsafeProjectPathOperations: operations => ({ safe: operations, skipped: [] }),
    evaluateGovernedOperations: () => ({
      allowed: [],
      blocked: [{ operation, reason: 'readonly' }]
    }),
    buildGovernanceSkippedApplyResult: () => ({
      ok: false,
      applied: [],
      skipped: [skippedEntry]
    }),
    getSkippedEntries: result => result.skipped,
    filterSyncChangesByOperations: () => [],
    formatWritebackSkippedNextStep: result => result.skipped.length
      ? 'Nothing was written in this run. Review the skipped reasons, fix them, and retry.'
      : '',
    summarizeOperationForAudit: () => ({ path: operation.path }),
    buildAuditSummaryFromApply: input => input,
    writebackSettlement: { settle: input => input }
  });

  const outcome = await orchestrator.applySyncChangesToOverleaf(
    [{ type: 'edit', path: operation.path }],
    {},
    { mode: 'auto', assistantMessage: 'Local edit completed.' }
  );

  assert.equal(outcome.hasSkippedOperations, true);
  assert.equal(completionReport.applyResults.length, 1);
  assert.deepEqual(completionReport.applyResults[0].skipped, [skippedEntry]);
  assert.equal(completionReport.unchangedReason, skippedEntry.result.reason);
  assert.match(completionReport.nextStep, /Review the skipped reasons/);
});

for (const saveState of ['verified_saved', 'verified_quiet', 'unknown_timeout', 'unavailable']) {
  test(`writeback completion respects save evidence: ${saveState}`, async () => {
    const windowObject = {};
    new Function('window', source)(windowObject);
    const operation = { type: 'edit', path: 'main.tex' };
    const applied = { ok: true, applied: [{ operation, result: { ok: true } }], skipped: [] };
    let report;
    let summary;
    let confirms = 0;
    let undoRecorded = false;
    const orchestrator = windowObject.CodexOverleafWritebackOrchestrator.create({
      tr: key => key, tx: english => english,
      getState: () => ({ mode: 'auto', requireReviewing: false }),
      getCurrentRunView: () => ({ runProjectId: 'project' }),
      getCurrentProjectId: () => 'project',
      cleanFinalAnswer: value => value,
      getAssistantAnswerForCurrentRun: () => 'Edited successfully.',
      buildSyncApplyOperations: () => [operation],
      partitionUnsafeProjectPathOperations: operations => ({ safe: operations, skipped: [] }),
      evaluateGovernedOperations: operations => ({ allowed: operations, blocked: [] }),
      confirmBinaryOperations: async operations => ({ operations, skipped: [] }),
      ensureReviewingBeforeWrite: async () => ({ ok: true }),
      assetTransferBroker: { applyOperations: async () => applied },
      mergeApplyResultSkipped: result => result,
      appendRunEvent() {}, appendOperationsPreview() {}, appendApplyResult() {},
      renderReadOnlyDiffReview() {},
      getSkippedEntries: result => result.skipped,
      hasApplyResultEntries: result => result.applied.length > 0,
      getAppliedSyncChanges: changes => changes,
      getAppliedOperationPaths: () => ['main.tex'],
      recordUndoFromApply: () => { undoRecorded = true; },
      callPageBridge: async method => {
        assert.equal(method, 'waitForSaveState');
        return { ok: saveState === 'verified_saved', state: saveState };
      },
      sendBackgroundNative: async request => {
        assert.equal(request.method, 'mirror.confirmWriteback');
        confirms += 1;
        return { ok: true, result: { ok: true } };
      },
      appendChangeSummary: value => { summary = value; return value.notes; },
      appendCompletionReport: value => { report = value; },
      hasSkippedApplyOperations: () => false,
      buildAuditSummaryFromApply: input => input,
      writebackSettlement: { settle: input => input }
    });
    const outcome = await orchestrator.applySyncChangesToOverleaf([{ path: 'main.tex' }], {},
      { mode: 'auto', assistantMessage: 'Edited successfully.', autoRecompile: false });
    await orchestrator.getPendingMirrorRefresh();
    assert.equal(undoRecorded, true, 'written changes retain their undo checkpoint');
    const verified = saveState === 'verified_saved';
    assert.equal(outcome.hasUnverifiedSave, !verified);
    assert.equal(report.status, verified ? 'completed' : 'failed');
    assert.equal(confirms, verified ? 1 : 0, 'unverified saves cannot confirm the local mirror');
    if (!verified) {
      assert.equal(outcome.hasSkippedOperations, true);
      assert.equal(outcome.audit.resultStatus, 'failed');
      assert.match(summary.notes, /Synchronization is incomplete/);
      assert.match(report.conclusion, /could not confirm they were saved/);
      assert.match(report.nextStep, /Avoid resubmitting/);
    }
  });
}
