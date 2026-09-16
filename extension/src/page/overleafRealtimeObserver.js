(function initOverleafRealtimeObserver(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    if (typeof root.CodexOverleafRealtimeObserver?.dispose === 'function') {
      root.CodexOverleafRealtimeObserver.dispose();
    }
    root.CodexOverleafRealtimeObserver = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function overleafRealtimeObserverFactory(root) {
  'use strict';

  const STRATEGY_ACTIVE_EDITOR = 'active-editor';
  const CHANNEL_ROOT_NAMES = ['overleaf', 'Overleaf', '_ide', 'OL'];
  const BASELINE_REFRESH_EVENT_TYPES = ['click', 'focusin', 'change'];
  const CHANNEL_KEY_PATTERN = /socket|websocket|channel|realtime|collab|share|ot|doc|editor|connection|event|broadcast|presence/i;
  const SENSITIVE_KEY_PATTERN = /^(content|previousContent|nextContent|text|body|raw|rawContent|source|sourceText)$/i;
  const LIMITS = Object.freeze({ maxFileBytes: 1024 * 1024, maxEvents: 64, maxQueuedBytes: 4 * 1024 * 1024 });
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const ownedObservers = new WeakMap();

  function create(deps = {}) {
    const documentRef = Object.prototype.hasOwnProperty.call(deps, 'document')
      ? deps.document
      : getDefaultDocument();
    dispose(documentRef);
    const observer = createObserver(deps);
    if (documentRef && ['object', 'function'].includes(typeof documentRef)) {
      ownedObservers.set(documentRef, observer);
    }
    return observer;
  }

  function dispose(documentRef = getDefaultDocument()) {
    if (!documentRef || !['object', 'function'].includes(typeof documentRef)) return;
    const previous = ownedObservers.get(documentRef);
    if (!previous) return;
    try {
      previous.stop();
    } finally {
      ownedObservers.delete(documentRef);
    }
  }

  function createObserver(deps = {}) {
    const pageWindow = deps.window || getDefaultWindow();
    const pageDocument = Object.prototype.hasOwnProperty.call(deps, 'document')
      ? deps.document
      : getDefaultDocument();
    const events = [];
    let activePath = '';
    let lastContent = '';
    let baselineByteCount = 0;
    let queuedTextBytes = 0;
    let coalescedEventCount = 0;
    let running = false;
    let listenersAttached = false;
    let statusName = 'off';
    let statusReason = '';
    let lastEventAt = null;
    let lastErrorCode = '';
    let channelCandidates = [];

    function start(_params = {}) {
      clearQueuedEvents();
      coalescedEventCount = 0;
      channelCandidates = collectChannelCandidates(pageWindow);
      if (!canAttachDocumentListeners()) {
        running = false;
        markUnavailable('missing_document');
        return getStatus();
      }

      running = true;
      refreshActiveBaseline();
      // The editor may mount after the page bridge. Keep the read-only
      // observer alive until its first file identity is available.
      if (statusName === 'unavailable' && lastErrorCode === 'missing_active_path') statusName = 'starting';
      if (running) attachDocumentListeners();
      return getStatus();
    }

    function stop() {
      detachDocumentListeners();
      clearQueuedEvents();
      lastContent = '';
      baselineByteCount = 0;
      running = false;
      statusName = 'off';
      statusReason = '';
      return getStatus();
    }

    function getStatus() {
      const status = {
        status: statusName,
        state: statusName,
        running,
        strategy: STRATEGY_ACTIVE_EDITOR,
        activePath,
        queuedEventCount: events.length,
        queuedTextBytes,
        baselineByteCount,
        coalescedEventCount,
        lastEventAt,
        lastErrorCode,
        channelCandidates: cloneChannelCandidates(channelCandidates)
      };
      if ((statusName === 'unavailable' || statusName === 'starting') && statusReason) {
        status.reason = statusReason;
      }
      return status;
    }

    function drainEvents() {
      // Capture-phase input can precede the editor transaction; paste, undo
      // and collaboration updates may dispatch no DOM input at all. The
      // existing bounded poll samples committed text before draining.
      if (running) handleEditorInput();
      const drained = events.slice();
      clearQueuedEvents();
      if (!drained.length) return [];
      const otText = resolveOtText(deps, pageWindow, root);
      if (typeof otText?.normalizeObservedTextEvent !== 'function') {
        stopObservation('missing_ot_text');
        return [];
      }
      const normalized = [];
      for (const pending of drained) {
        let event;
        const { previousBytes, nextBytes, ...input } = pending;
        try { event = otText.normalizeObservedTextEvent(input); } catch (_error) { /* fail closed below */ }
        if (!event || event.ok !== true) {
          stopObservation(event?.reason || 'normalize_observed_text_event_failed');
          return [];
        }
        normalized.push(sanitizeObservedEvent(event));
      }
      return normalized;
    }

    function clearQueuedEvents() {
      events.length = 0;
      queuedTextBytes = 0;
    }

    function stopObservation(reason) {
      stop();
      markUnavailable(reason);
    }

    function queueObservedChange(event, previousBytes, nextBytes) {
      const tail = events[events.length - 1];
      const merge = tail?.path === event.path && tail.nextContent === event.previousContent;
      const pending = { ...event, previousContent: merge ? tail.previousContent : event.previousContent,
        previousBytes: merge ? tail.previousBytes : previousBytes, nextBytes };
      const remainingBytes = queuedTextBytes - (merge ? tail.previousBytes + tail.nextBytes : 0);
      const noChange = pending.previousContent === pending.nextContent;
      const nextLength = events.length - (merge ? 1 : 0) + (noChange ? 0 : 1);
      const nextTotal = remainingBytes + (noChange ? 0 : pending.previousBytes + pending.nextBytes);
      if (nextLength > LIMITS.maxEvents || nextTotal > LIMITS.maxQueuedBytes) {
        stopObservation('ot_queue_limit');
        return false;
      }
      if (merge) { events.pop(); coalescedEventCount += 1; }
      if (!noChange) events.push(pending);
      queuedTextBytes = nextTotal;
      lastEventAt = event.observedAt;
      return true;
    }

    function canAttachDocumentListeners() {
      return Boolean(pageDocument && typeof pageDocument.addEventListener === 'function');
    }

    function attachDocumentListeners() {
      if (listenersAttached) {
        return true;
      }
      pageDocument.addEventListener('input', handleEditorInput, true);
      for (const type of BASELINE_REFRESH_EVENT_TYPES) {
        pageDocument.addEventListener(type, handleBaselineRefreshEvent, true);
      }
      listenersAttached = true;
      return true;
    }

    function detachDocumentListeners() {
      if (!listenersAttached || !pageDocument || typeof pageDocument.removeEventListener !== 'function') {
        listenersAttached = false;
        return;
      }
      pageDocument.removeEventListener('input', handleEditorInput, true);
      for (const type of BASELINE_REFRESH_EVENT_TYPES) {
        pageDocument.removeEventListener(type, handleBaselineRefreshEvent, true);
      }
      listenersAttached = false;
    }

    function refreshActiveBaseline() {
      const pathResult = readActivePath();
      if (!pathResult.ok) {
        handleActivePathUnavailable(pathResult.reason);
        return false;
      }

      const textResult = readEditorText();
      if (!textResult.ok) {
        if (textResult.reason === 'ot_file_limit') stopObservation(textResult.reason);
        else markUnavailable(textResult.reason);
        return false;
      }

      activePath = pathResult.path;
      lastContent = textResult.text;
      baselineByteCount = textResult.bytes;
      markObserving();
      return true;
    }

    function handleBaselineRefreshEvent() {
      if (!running) {
        return;
      }

      const pathResult = readActivePath();
      if (!pathResult.ok) {
        handleActivePathUnavailable(pathResult.reason);
        return;
      }
      if (pathResult.path === activePath) {
        return;
      }

      const textResult = readEditorText();
      if (!textResult.ok) {
        if (textResult.reason === 'ot_file_limit') stopObservation(textResult.reason);
        else markUnavailable(textResult.reason);
        return;
      }

      activePath = pathResult.path;
      lastContent = textResult.text;
      baselineByteCount = textResult.bytes;
      markObserving();
    }

    function handleEditorInput(inputEvent) {
      if (inputEvent?.target?.closest?.('#codex-overleaf-panel')) return;
      if (!running) {
        return;
      }

      const pathResult = readActivePath();
      if (!pathResult.ok) {
        handleActivePathUnavailable(pathResult.reason);
        return;
      }

      const textResult = readEditorText();
      if (!textResult.ok) {
        if (textResult.reason === 'ot_file_limit') stopObservation(textResult.reason);
        else markUnavailable(textResult.reason);
        return;
      }

      const nextContent = textResult.text;
      if (pathResult.path !== activePath) {
        // Fallback for file switches that were not preceded by a selection/focus event.
        activePath = pathResult.path;
        lastContent = nextContent;
        baselineByteCount = textResult.bytes;
        markObserving();
        return;
      }

      if (nextContent === lastContent) {
        markObserving();
        return;
      }

      const observedAt = resolveObservedAt();
      const queued = queueObservedChange({
        path: activePath,
        previousContent: lastContent,
        nextContent,
        observedAt,
        source: STRATEGY_ACTIVE_EDITOR
      }, baselineByteCount, textResult.bytes);
      if (queued) {
        lastContent = nextContent;
        baselineByteCount = textResult.bytes;
        markObserving();
      }
    }

    function handleActivePathUnavailable(reason) {
      if (reason === 'missing_active_path') {
        activePath = '';
        lastContent = '';
        baselineByteCount = 0;
      }
      markUnavailable(reason);
    }

    function readActivePath() {
      if (typeof deps.getActiveFilePath !== 'function') {
        return {
          ok: false,
          reason: 'missing_active_path'
        };
      }
      try {
        const path = normalizePath(deps.getActiveFilePath());
        if (!path) {
          return {
            ok: false,
            reason: 'missing_active_path'
          };
        }
        return {
          ok: true,
          path
        };
      } catch (_error) {
        return {
          ok: false,
          reason: 'read_active_path_failed'
        };
      }
    }

    function readEditorText() {
      if (typeof deps.readActiveEditorText !== 'function') {
        return {
          ok: false,
          reason: 'missing_editor_reader'
        };
      }
      try {
        const text = deps.readActiveEditorText();
        if (typeof text !== 'string') {
          return { ok: false, reason: 'missing_editor_content' };
        }
        const bytes = text.length > LIMITS.maxFileBytes ? LIMITS.maxFileBytes + 1
          : encoder ? encoder.encode(text).byteLength : text.length * 3;
        if (bytes > LIMITS.maxFileBytes) return { ok: false, reason: 'ot_file_limit' };
        return {
          ok: true,
          text,
          bytes
        };
      } catch (_error) {
        return {
          ok: false,
          reason: 'read_active_editor_failed'
        };
      }
    }

    function resolveObservedAt() {
      let value;
      try {
        value = typeof deps.now === 'function' ? deps.now() : Date.now();
      } catch (_error) {
        value = Date.now();
      }
      return validDateToIso(value) || validDateToIso(Date.now()) || new Date().toISOString();
    }

    function markObserving() {
      statusName = 'observing';
      statusReason = '';
      lastErrorCode = '';
    }

    function markUnavailable(reason) {
      statusName = 'unavailable';
      statusReason = reason;
      lastErrorCode = reason;
    }

    return {
      drainEvents,
      getStatus,
      start,
      stop
    };
  }

  function collectChannelCandidates(pageWindow) {
    if (!pageWindow || typeof pageWindow !== 'object') {
      return [];
    }

    const candidates = [];
    for (const rootName of CHANNEL_ROOT_NAMES) {
      const descriptor = getDescriptor(pageWindow, rootName);
      const value = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined;
      if (!isInspectableObject(value)) {
        continue;
      }

      const keyPaths = collectCandidateKeyPaths(value);
      if (keyPaths.length) {
        candidates.push({
          root: rootName,
          keyPaths
        });
      }
    }
    return candidates;
  }

  function collectCandidateKeyPaths(value) {
    const seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    const keyPaths = [];
    walk(value, '', 0);
    return Array.from(new Set(keyPaths)).slice(0, 80);

    function walk(current, prefix, depth) {
      if (!isInspectableObject(current) || depth > 2) {
        return;
      }
      if (seen) {
        if (seen.has(current)) {
          return;
        }
        seen.add(current);
      }
      const descriptors = getDescriptors(current);
      if (isDomLikeDescriptorMap(descriptors)) {
        return;
      }

      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        const keyPath = prefix ? `${prefix}.${key}` : key;
        if (isChannelCandidateKey(key)) {
          keyPaths.push(keyPath);
        }
        if (depth < 2 && descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          walk(descriptor.value, keyPath, depth + 1);
        }
      }
    }
  }

  function isChannelCandidateKey(key) {
    return key.length <= 80
      && !SENSITIVE_KEY_PATTERN.test(key)
      && CHANNEL_KEY_PATTERN.test(key);
  }

  function getDescriptor(value, key) {
    try {
      return Object.getOwnPropertyDescriptor(value, key) || null;
    } catch (_error) {
      return null;
    }
  }

  function getDescriptors(value) {
    try {
      return Object.getOwnPropertyDescriptors(value);
    } catch (_error) {
      return {};
    }
  }

  function cloneChannelCandidates(candidates) {
    return candidates.map(candidate => ({
      root: candidate.root,
      keyPaths: candidate.keyPaths.slice()
    }));
  }

  function isInspectableObject(value) {
    return Boolean(value && typeof value === 'object');
  }

  function isDomLikeDescriptorMap(descriptors) {
    return isDomMarkerDescriptor(descriptors.nodeType)
      || isDomMarkerDescriptor(descriptors.ownerDocument)
      || isDomFunctionDescriptor(descriptors.querySelectorAll)
      || isDomFunctionDescriptor(descriptors.addEventListener);
  }

  function isDomMarkerDescriptor(descriptor) {
    if (!descriptor) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return true;
    }
    return Boolean(descriptor.value);
  }

  function isDomFunctionDescriptor(descriptor) {
    if (!descriptor) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return true;
    }
    return typeof descriptor.value === 'function';
  }

  function sanitizeObservedEvent(event) {
    return {
      path: event.path,
      baseHash: event.baseHash,
      nextHash: event.nextHash,
      nextContent: event.nextContent,
      ops: Array.isArray(event.ops) ? event.ops.map(cloneTextOp) : [],
      observedAt: event.observedAt,
      observedVersion: event.observedVersion ?? null,
      source: event.source
    };
  }

  function cloneTextOp(op) {
    return op && typeof op === 'object' && !Array.isArray(op)
      ? { ...op }
      : op;
  }

  function validDateToIso(value) {
    try {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    } catch (_error) {
      return null;
    }
  }

  function normalizePath(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '');
  }

  function getDefaultWindow() {
    if (typeof window !== 'undefined') {
      return window;
    }
    return root || {};
  }

  function getDefaultDocument() {
    if (typeof document !== 'undefined') {
      return document;
    }
    return null;
  }

  function resolveOtText(deps, pageWindow, rootObject) {
    if (deps.otText) {
      return deps.otText;
    }
    if (pageWindow?.CodexOverleafOtText) {
      return pageWindow.CodexOverleafOtText;
    }
    if (rootObject?.CodexOverleafOtText) {
      return rootObject.CodexOverleafOtText;
    }
    if (typeof require === 'function') {
      try {
        return require('../shared/otText');
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  return {
    LIMITS,
    collectChannelCandidates,
    create,
    dispose
  };
});
