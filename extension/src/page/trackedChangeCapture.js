(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafTrackedChangeCapture = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create(deps = {}) {
    const { collectElements, compact, delay, getActiveFilePath, readActiveEditorText,
      isInsideCodexPanel, normalizeSafeProjectPath, readNodeSignalText } = deps;
    const now = deps.now || (() => Date.now());
    const limit = 1200;
    const fingerprint = text => {
      let a = 2166136261, b = 5381;
      const value = String(text ?? '');
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        a = Math.imul(a ^ code, 16777619) >>> 0;
        b = (Math.imul(b, 33) ^ code) >>> 0;
      }
      return value.length + ':' + a.toString(16) + ':' + b.toString(16);
    };
    const explicitId = node => {
      for (const attr of ['data-change-id', 'data-review-id', 'data-track-change-id', 'data-ol-change-id']) {
        const value = node.getAttribute?.(attr);
        if (value) return String(value);
      }
      const value = node.getAttribute?.('data-id') || node.getAttribute?.('id') || '';
      return value && /(?:ol-cm-change|review-panel-entry-change|track-change|review-change)/i.test(node.className || '') ? String(value) : '';
    };
    const marker = node => Boolean(node && !isInsideCodexPanel?.(node)
      && (explicitId(node) || /(?:^|\s)(?:ol-cm-change(?:-\w+)?|review-panel-entry-change|track-change|review-change[\w-]*)(?:\s|$)/i.test(node.className || '')));
    function collectTrackedChangeNodes() {
      const selector = [
        '[data-change-id]', '[data-review-id]', '[data-track-change-id]',
        '[data-ol-change-id]', '.ol-cm-change', '.review-panel-entry-change',
        '[class*="track-change" i]', '[class*="review-change" i]'
      ].join(',');
      return Array.from(new Set(collectElements(selector, limit))).filter(marker);
    }
    function trackedChangeRefFromNode(node, fallbackPath = '') {
      const id = explicitId(node);
      const path = normalizeSafeProjectPath(node.getAttribute?.('data-path')
        || node.getAttribute?.('data-file-path') || node.getAttribute?.('data-doc-path') || fallbackPath);
      const rawPosition = node.getAttribute?.('data-pos');
      const position = rawPosition !== null && rawPosition !== undefined && rawPosition !== ''
        && Number.isSafeInteger(Number(rawPosition)) && Number(rawPosition) >= 0 ? Number(rawPosition) : null;
      const parts = Array.from(node.querySelectorAll?.('.review-panel-expandable-content') || [])
        .map(part => part.textContent || '');
      const body = parts.length ? JSON.stringify(parts)
        : (node.querySelector?.('.review-panel-change-body')?.textContent || node.textContent || '');
      const author = node.querySelector?.('.review-panel-entry-user')?.textContent || '';
      const kind = /(?:delete|change-d)(?:\s|$)/.test(node.className || '') ? 'delete' : 'insert';
      const legacyKey = 'sig:' + compact(readNodeSignalText(node), 180);
      return {
        key: id ? 'id:' + id : position !== null
          ? 'pos:' + position + ':' + kind + ':' + fingerprint(body + '\0' + author)
          : legacyKey,
        id, path, label: compact(readNodeSignalText(node), 180)
      };
    }
    function collectTrackedChangeRefsForPaths(paths = []) {
      const allowed = new Set(paths.filter(Boolean));
      const active = getActiveFilePath();
      return collectTrackedChangeNodes().map(node => trackedChangeRefFromNode(node, active))
        .filter(ref => ref.key && (!allowed.size || !ref.path || allowed.has(ref.path)));
    }
    // Overleaf rangesDataField holds the complete ledger, not viewport DOM.
    // Adapter boundary: CodeMirror's internal values layout is shape-checked.
    // https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/ranges.ts
    function readNativeSnapshot(path, pinnedDocId = '') {
      const unavailable = reason => ({ supported: true, source: 'native', ready: false, reason, refs: [] });
      try {
        const state = deps.getCodeMirrorEditorView?.()?.state;
        if (!Array.isArray(state?.values) || typeof deps.getTrackedChangeDocumentId !== 'function') return { supported: false };
        const nativeDocId = pinnedDocId || deps.getTrackedChangeDocumentId(path);
        if (!nativeDocId || state.values.length > 2048) return unavailable('native_document_unavailable');
        const entries = state.values.filter(value => value && typeof value === 'object'
          && Object.prototype.hasOwnProperty.call(value, 'ranges')
          && Object.prototype.hasOwnProperty.call(value, 'threads')
          && value.ranges?.docId === nativeDocId
          && Array.isArray(value.ranges.changes) && Array.isArray(value.ranges.comments));
        if (entries.length !== 1) return unavailable('native_ledger_not_ready');
        const changes = entries[0].ranges.changes;
        const text = state.doc.toString();
        if (changes.length >= limit || !Number.isSafeInteger(state.doc.length) || state.doc.length !== text.length)
          return unavailable('native_ledger_limit_or_length');
        const refs = [], seen = new Set();
        for (const change of changes) {
          const id = change?.id, op = change?.op;
          if (typeof id !== 'string' || !id || id.length > 256 || !Number.isSafeInteger(op?.p)
            || op.p < 0 || op.p > text.length) return unavailable('native_change_invalid');
          const insertion = typeof op.i === 'string', deletion = typeof op.d === 'string';
          if (insertion === deletion) return unavailable('native_change_invalid');
          const changedText = insertion ? op.i : op.d;
          if (!changedText.length) continue;
          const from = op.p, to = insertion ? from + changedText.length : from;
          if (to > text.length || (insertion && text.slice(from, to) !== changedText))
            return unavailable('native_ledger_stale');
          const kind = insertion ? 'insert' : 'delete', textHash = fingerprint(changedText);
          const key = 'native:' + JSON.stringify([id, kind, from, to, textHash]);
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push({ key, id, path, source: 'native', from, to, kind, textHash,
            textLength: changedText.length, label: kind + ' at ' + from });
        }
        const acceptByIdSupported = changes.every(change => !Object.prototype.hasOwnProperty.call(change, 'snapshotRange')
          && !/^change-(?:insert|delete)-\d+$/.test(change.id));
        return { supported: true, source: 'native', ready: true, nativeDocId, refs, acceptByIdSupported };
      } catch (_error) { return unavailable('native_ledger_unavailable'); }
    }
    function prepareTrackedChangeCapture(path) {
      const snapshot = readNativeSnapshot(path);
      return snapshot.supported ? snapshot
        : { source: 'dom', ready: true, refs: collectTrackedChangeRefsForPaths([path]) };
    }
    function getTrackedChangeCaptureStatus() {
      const snapshot = prepareTrackedChangeCapture(getActiveFilePath());
      return { adapter: 'cm-ranges-v1', source: snapshot.source, ready: snapshot.ready,
        count: snapshot.refs.length, docId: snapshot.nativeDocId || '', reason: snapshot.reason || '' };
    }
    function prepareUntrackedUndo(path) {
      const snapshot = readNativeSnapshot(path);
      return { ...snapshot, ok: snapshot.ready === true && snapshot.refs.length === 0, unrelated: [],
        reason: snapshot.ready ? (snapshot.refs.length ? 'native_untracked_undo_pending_changes' : '')
          : snapshot.reason || 'native_review_unavailable' };
    }
    function prepareTrackedChangeReview(path, refs = []) {
      const snapshot = readNativeSnapshot(path);
      const blocked = reason => ({ ...snapshot, ok: false, reason });
      if (!snapshot.ready) return blocked(snapshot.reason || 'native_review_unavailable');
      const targets = refs.filter(ref => ref.path === path), ids = new Set(targets.map(ref => ref.id));
      let expected;
      try {
        expected = targets.map(ref => {
          if (!ref.key.startsWith('native:') || ref.key.length > 1024) throw new Error('identity');
          const tuple = JSON.parse(ref.key.slice(7));
          if (!Array.isArray(tuple) || tuple.length !== 5 || !ref.id || tuple[0] !== ref.id
            || !['insert', 'delete'].includes(tuple[1]) || typeof tuple[4] !== 'string'
            || !Number.isSafeInteger(tuple[2]) || !Number.isSafeInteger(tuple[3])
            || tuple[2] < 0 || tuple[3] < tuple[2]) throw new Error('identity');
          return JSON.stringify([tuple[0], tuple[1], tuple[4]]);
        }).sort();
      } catch (_error) { return blocked('native_review_identity_unavailable'); }
      // All fragments sharing an ID must be owned, including after a split or merge.
      const current = snapshot.refs.filter(ref => ids.has(ref.id))
        .map(ref => JSON.stringify([ref.id, ref.kind, ref.textHash])).sort();
      if (!targets.length || JSON.stringify(expected) !== JSON.stringify(current))
        return blocked('native_review_scope_changed');
      return { ...snapshot, ok: true, targets, ids: [...ids],
        unrelated: snapshot.refs.filter(ref => !ids.has(ref.id)) };
    }
    function nativeOwned(ref, capture) {
      if (ref.source !== 'native' || !Number.isSafeInteger(ref.from) || !Number.isSafeInteger(ref.to)) return false;
      if (ref.kind === 'delete') return capture.ranges.some(range => ref.from >= range.start && ref.from <= range.end
        && ref.textLength === range.removedLength && ref.textHash === range.removedHash && range.removedLength > 0);
      let covered = ref.from;
      for (const range of capture.ranges) {
        if (range.end < covered) continue;
        if (range.start > covered) break;
        covered = Math.max(covered, range.end);
        if (covered >= ref.to) return ref.to > ref.from;
      }
      return false;
    }
    const identity = ref => (ref.path || '') + '\0' + ref.key;
    function diff(before, after) {
      const seen = new Set(before.map(identity));
      return after.filter(ref => {
        const key = identity(ref);
        if (!ref.key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    function rangesFor(operation, beforeContent, postContent) {
      const patches = Array.isArray(operation.patches) && operation.patches.length
        ? operation.patches
        : [{ from: 0, to: beforeContent.length, insert: postContent }];
      let delta = 0;
      return patches.map(patch => {
        const range = { from: patch.from, to: patch.to,
          start: patch.from + delta, end: patch.from + delta + String(patch.insert ?? '').length,
          removedLength: patch.to - patch.from, removedHash: fingerprint(beforeContent.slice(patch.from, patch.to)) };
        delta += String(patch.insert ?? '').length - (patch.to - patch.from);
        return range;
      });
    }
    function shiftedBaseline(before, ranges) {
      let overlap = false;
      const refs = before.map(ref => {
        const match = /^pos:(\d+):/.exec(ref.key);
        if (!match) return ref;
        const pos = Number(match[1]);
        let delta = 0;
        for (const range of ranges) {
          if (pos >= range.from && pos < range.to) overlap = true;
          if (pos >= range.to) delta += (range.end - range.start) - (range.to - range.from);
        }
        return { ...ref, key: ref.key.replace(/^pos:\d+:/, 'pos:' + (pos + delta) + ':') };
      });
      return { refs, overlap };
    }
    function allowedRef(ref, capture) {
      if (ref.path !== capture.path) return false;
      if (capture.source === 'native') return nativeOwned(ref, capture);
      const match = /^pos:(\d+):/.exec(ref.key);
      if (match) return capture.ranges.some(range =>
        Number(match[1]) >= range.start && Number(match[1]) <= range.end);
      // Stable native IDs can be compared with the fixed pre-write baseline.
      // Text-only viewport signatures are retained for legacy lookup, but are
      // insufficient to assign a new task ownership after a delayed capture.
      return Boolean(ref.id);
    }
    function scopeCovered(refs, capture) {
      if (capture.source === 'native') return capture.ranges.every(range => refs.some(ref =>
        ref.from <= range.end && ref.to >= range.start));
      const positioned = refs.filter(ref => /^pos:\d+:/.test(ref.key));
      if (refs.some(ref => ref.id)) return true;
      return capture.ranges.every(range => positioned.some(ref => {
        const pos = Number(/^pos:(\d+):/.exec(ref.key)[1]);
        return pos >= range.start && pos <= range.end;
      }));
    }
    async function waitForTrackedChangeDiff(before, paths, options = {}) {
      const waitMs = Math.max(0, Number(options.waitMs ?? 5000));
      const intervalMs = Math.max(1, Number(options.intervalMs ?? 180));
      const stableMs = Math.max(0, Number(options.stableMs ?? 500));
      const start = now(), deadline = start + waitMs;
      const found = new Map();
      const native = options.capture?.source === 'native', beforeIds = new Set(before.map(ref => ref.id));
      let lastSnapshotReady = true, sourceReason = '';
      let lastChange = start, signature = '', polls = 0, afterCount = 0, filtered = 0;
      let reason = 'capture_timeout';
      while (now() <= deadline) {
        if (options.guard && !options.guard()) { reason = 'capture_context_changed'; break; }
        const snapshot = options.readSnapshot ? options.readSnapshot() : { ready: true, refs: collectTrackedChangeRefsForPaths(paths) };
        lastSnapshotReady = snapshot.ready === true; sourceReason = snapshot.reason || '';
        const after = lastSnapshotReady ? snapshot.refs : [];
        if (native) found.clear();
        polls++; afterCount = after.length;
        const candidates = native ? after.filter(ref => !beforeIds.has(ref.id)) : diff(before, after);
        for (const ref of candidates) {
          if (options.capture && !allowedRef(ref, options.capture)) { filtered++; continue; }
          found.set(identity(ref), ref);
        }
        const nextSignature = after.map(ref => native ? ref.key : identity(ref)).sort().join('\n');
        if (nextSignature !== signature) { signature = nextSignature; lastChange = now(); }
        if (options.stopOnFirst && found.size) { reason = 'observed'; break; }
        if (now() >= deadline) break;
        await delay(Math.min(intervalMs, deadline - now()));
      }
      const trackedChanges = Array.from(found.values());
      if (lastSnapshotReady && reason !== 'capture_context_changed' && trackedChanges.length
        && now() - lastChange >= stableMs
        && (!options.capture || scopeCovered(trackedChanges, options.capture))
        && afterCount < limit) reason = 'observed';
      return {
        ok: reason === 'observed' || options.stopOnFirst === true,
        trackedChanges, reason, waitMs,
        diagnostics: { beforeCount: before.length, afterCount, capturedCount: trackedChanges.length,
          filteredCount: filtered, polls, elapsedMs: Math.max(0, now() - start), reason,
          source: options.capture?.source || 'dom', sourceReason }
      };
    }
    async function captureTrackedWrite({ trackedBefore, captureBaseline, operation, beforeContent, postContent, runProjectId }) {
      if (beforeContent === postContent) return { trackedChanges: [], capture: null };
      const ranges = rangesFor(operation, beforeContent, postContent);
      const baseline = shiftedBaseline(trackedBefore, ranges);
      const startedAt = now();
      const capture = {
        version: 1, path: operation.path, runProjectId, startedAt, expiresAt: startedAt + 35000,
        expected: fingerprint(postContent), ranges, source: captureBaseline?.source || 'dom',
        nativeDocId: captureBaseline?.nativeDocId || '',
        before: baseline.refs.map(({ key, id, path }) => ({ key, id, path })),
        refs: [], state: 'pending', reason: ''
      };
      if (captureBaseline && !captureBaseline.ready) {
        capture.state = 'needs_review'; capture.reason = captureBaseline.reason || 'capture_baseline_unavailable';
        return { trackedChanges: [], capture };
      }
      if (baseline.overlap || trackedBefore.length >= limit) {
        capture.state = 'needs_review';
        capture.reason = baseline.overlap ? 'preexisting_change_overlap' : 'capture_baseline_limit';
        return { trackedChanges: [], capture };
      }
      return observe(capture, postContent, 5000);
    }
    function validCapture(capture) {
      return capture?.version === 1 && typeof capture.path === 'string'
        && capture.path === normalizeSafeProjectPath(capture.path)
        && Boolean(capture.path) && typeof capture.expected === 'string'
        && Number.isFinite(capture.expiresAt) && Number.isFinite(capture.startedAt)
        && capture.expiresAt > capture.startedAt && capture.expiresAt - capture.startedAt <= 35000
        && Array.isArray(capture.before) && capture.before.length < limit
        && capture.before.every(ref => ref && typeof ref.key === 'string' && ref.path === capture.path)
        && [undefined, 'dom', 'native'].includes(capture.source)
        && (capture.source !== 'native' || (typeof capture.nativeDocId === 'string' && capture.nativeDocId
          && capture.before.every(ref => typeof ref.id === 'string' && ref.id)))
        && Array.isArray(capture.ranges) && capture.ranges.length > 0 && capture.ranges.length <= 1000
        && capture.ranges.every(r => Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end)
          && r.start >= 0 && r.end >= r.start);
    }
    async function observe(input, expectedContent, waitMs) {
      const capture = JSON.parse(JSON.stringify(input));
      if (!validCapture(capture) || typeof expectedContent !== 'string'
        || fingerprint(expectedContent) !== capture.expected) {
        return { ok: false, trackedChanges: [], capture: { ...capture, state: 'needs_review', reason: 'capture_invalid_baseline' } };
      }
      if (now() >= capture.expiresAt) {
        return { ok: false, trackedChanges: [], capture: { ...capture, state: 'needs_review', reason: 'capture_expired' } };
      }
      if (getActiveFilePath() !== capture.path) {
        return { ok: false, trackedChanges: [], capture: { ...capture, state: 'pending', reason: 'capture_view_not_active' } };
      }
      const guard = () => getActiveFilePath() === capture.path && readActiveEditorText() === expectedContent
        && (!deps.getProjectId || deps.getProjectId() === capture.runProjectId);
      const result = await waitForTrackedChangeDiff(capture.before, [capture.path], {
        waitMs: Math.min(waitMs, capture.expiresAt - now()), intervalMs: 180, stableMs: 500, capture, guard,
        readSnapshot: capture.source === 'native' ? () => readNativeSnapshot(capture.path, capture.nativeDocId) : null
      });
      capture.refs = result.trackedChanges;
      capture.diagnostics = result.diagnostics;
      capture.reason = result.reason;
      capture.state = result.reason === 'observed' ? 'observed'
        : result.reason === 'capture_context_changed' ? 'needs_review' : 'pending';
      if (now() >= capture.expiresAt && capture.state === 'pending') capture.state = 'needs_review';
      return { ok: capture.state === 'observed', trackedChanges: capture.state === 'observed' ? capture.refs : [], capture };
    }
    async function reconcileTrackedChangeCapture(params = {}) {
      const blocked = deps.checkWritebackRunProjectId?.(params);
      if (blocked) return blocked;
      if (params.capture?.runProjectId !== params.runProjectId) {
        return { ok: false, code: 'capture_project_mismatch', trackedChanges: [] };
      }
      return observe(params.capture, params.expectedContent, 1200);
    }
    return { collectTrackedChangeNodes, trackedChangeRefFromNode, collectTrackedChangeRefsForPaths,
      waitForTrackedChangeDiff, prepareTrackedChangeCapture, prepareTrackedChangeReview, prepareUntrackedUndo, getTrackedChangeCaptureStatus, captureTrackedWrite, reconcileTrackedChangeCapture };
  }
  return { create };
});
