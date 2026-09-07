(function initOverleafRealtimeObserver(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.CodexOverleafRealtimeObserver = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function overleafRealtimeObserverFactory(root) {
  'use strict';

  const STRATEGY_ACTIVE_EDITOR = 'active-editor';
  const CHANNEL_ROOT_NAMES = ['overleaf', 'Overleaf', '_ide', 'OL'];
  const BASELINE_REFRESH_EVENT_TYPES = ['click', 'focusin', 'change'];
  const CHANNEL_KEY_PATTERN = /socket|websocket|channel|realtime|collab|share|ot|doc|editor|connection|event|broadcast|presence/i;
  const SENSITIVE_KEY_PATTERN = /^(content|previousContent|nextContent|text|body|raw|rawContent|source|sourceText)$/i;

  function create(deps = {}) {
    const pageWindow = deps.window || getDefaultWindow();
    const pageDocument = Object.prototype.hasOwnProperty.call(deps, 'document')
      ? deps.document
      : getDefaultDocument();
    const events = [];
    let activePath = '';
    let lastContent = '';
    let running = false;
    let listenersAttached = false;
    let statusName = 'off';
    let statusReason = '';
    let lastEventAt = null;
    let lastErrorCode = '';
    let channelCandidates = [];

    function start(_params = {}) {
      clearQueuedEvents();
      channelCandidates = collectChannelCandidates(pageWindow);
      if (!canAttachDocumentListeners()) {
        running = false;
        markUnavailable('missing_document');
        return getStatus();
      }

      running = true;
      refreshActiveBaseline();
      attachDocumentListeners();
      return getStatus();
    }

    function stop() {
      detachDocumentListeners();
      clearQueuedEvents();
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
        lastEventAt,
        lastErrorCode,
        channelCandidates: cloneChannelCandidates(channelCandidates)
      };
      if (statusName === 'unavailable' && statusReason) {
        status.reason = statusReason;
      }
      return status;
    }

    function drainEvents() {
      const drained = events.slice();
      clearQueuedEvents();
      return drained;
    }

    function clearQueuedEvents() {
      events.length = 0;
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
        markUnavailable(textResult.reason);
        return false;
      }

      activePath = pathResult.path;
      lastContent = textResult.text;
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
        markUnavailable(textResult.reason);
        return;
      }

      activePath = pathResult.path;
      lastContent = textResult.text;
      markObserving();
    }

    function handleEditorInput() {
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
        markUnavailable(textResult.reason);
        return;
      }

      const nextContent = textResult.text;
      if (pathResult.path !== activePath) {
        // Fallback for file switches that were not preceded by a selection/focus event.
        activePath = pathResult.path;
        lastContent = nextContent;
        markObserving();
        return;
      }

      if (nextContent === lastContent) {
        markObserving();
        return;
      }

      const observedAt = resolveObservedAt();
      const otText = resolveOtText(deps, pageWindow, root);
      if (!otText || typeof otText.normalizeObservedTextEvent !== 'function') {
        markUnavailable('missing_ot_text');
        return;
      }

      const event = otText.normalizeObservedTextEvent({
        path: activePath,
        previousContent: lastContent,
        nextContent,
        observedAt,
        source: STRATEGY_ACTIVE_EDITOR
      });
      if (event && event.ok === true) {
        const queuedEvent = sanitizeObservedEvent(event);
        events.push(queuedEvent);
        lastEventAt = queuedEvent.observedAt || observedAt;
        markObserving();
      } else {
        lastErrorCode = event?.reason || 'normalize_observed_text_event_failed';
      }
      lastContent = nextContent;
    }

    function handleActivePathUnavailable(reason) {
      if (reason === 'missing_active_path') {
        activePath = '';
        lastContent = '';
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
        return {
          ok: true,
          text
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
      .replace(/\s+/g, ' ')
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
    collectChannelCandidates,
    create
  };
});
