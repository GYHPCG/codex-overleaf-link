const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadObserverFactory() {
  return require('../extension/src/page/overleafRealtimeObserver');
}

function createHarness(options = {}) {
  const Observer = loadObserverFactory();
  const listeners = [];
  const removals = [];
  let activePath = options.activePath ?? 'main.tex';
  let editorText = options.editorText ?? 'hello';
  let readError = options.readError || null;
  let now = options.now ?? Date.parse('2026-05-05T00:00:00.000Z');
  let dispatchCount = 0;
  let socketHookCount = 0;
  const normalizeCalls = [];

  const defaultDocument = {
    addEventListener(type, handler, optionsArg) {
      listeners.push({ type, handler, options: optionsArg });
    },
    removeEventListener(type, handler, optionsArg) {
      removals.push({ type, handler, options: optionsArg });
    }
  };
  const document = Object.prototype.hasOwnProperty.call(options, 'document')
    ? options.document
    : defaultDocument;
  const window = options.window || {
    overleaf: {
      realtime: {
        socket: {
          on() {
            socketHookCount += 1;
          }
        },
        sourceText: 'SECRET_SOURCE_BODY'
      },
      editor: {
        doc: {
          text: 'SECRET_EDITOR_TEXT'
        }
      }
    },
    Overleaf: {
      SocketIoConnection: {},
      sourceText: 'SECRET_OVERLEAF_TEXT'
    },
    _ide: {
      project: {
        docs: []
      },
      collab: {
        channel: {}
      }
    },
    OL: {
      eventBus: {}
    }
  };
  const editorView = options.editorView || {
    state: {
      doc: {
        toString() {
          return editorText;
        }
      }
    },
    dispatch() {
      dispatchCount += 1;
    }
  };
  const deps = {
    document,
    window,
    otText: {
      normalizeObservedTextEvent(input) {
        normalizeCalls.push(input);
        return {
          ok: true,
          path: input.path,
          previousContent: input.previousContent,
          nextContent: input.nextContent,
          baseHash: `base:${input.previousContent.length}`,
          nextHash: `next:${input.nextContent.length}`,
          ops: [{ p: input.previousContent.length, i: input.nextContent.slice(input.previousContent.length) }],
          observedAt: input.observedAt,
          observedVersion: null,
          source: input.source
        };
      },
      applyTextOps() {
        throw new Error('observer must not apply text operations');
      }
    },
    getActiveFilePath() {
      return activePath;
    },
    readActiveEditorText() {
      if (readError) {
        throw readError;
      }
      return editorText;
    },
    getCodeMirrorEditorView() {
      return editorView;
    },
    collectDocRecords() {
      return [
        {
          path: 'main.tex',
          id: 'doc-1',
          content: 'SECRET_DOC_RECORD_TEXT'
        }
      ];
    },
    now() {
      if (typeof now === 'function') {
        return now();
      }
      return now;
    }
  };

  return {
    document,
    get dispatchCount() {
      return dispatchCount;
    },
    fireEvent(type, event = { target: {} }) {
      const listener = listeners.find(item => item.type === type);
      assert.ok(listener, `${type} listener should be registered`);
      listener.handler(event);
    },
    fireInput(event = { target: {} }) {
      const listener = listeners.find(item => item.type === 'input');
      assert.ok(listener, 'input listener should be registered');
      listener.handler(event);
    },
    get normalizeCalls() {
      return normalizeCalls;
    },
    observer: Observer.create(deps),
    removals,
    setActivePath(value) {
      activePath = value;
    },
    setEditorText(value) {
      editorText = value;
    },
    setReadError(value) {
      readError = value;
    },
    setNow(value) {
      now = value;
    },
    get socketHookCount() {
      return socketHookCount;
    },
    listeners
  };
}

test('start initializes active editor state and queues an event for same-file input changes', () => {
  const harness = createHarness();

  const startStatus = harness.observer.start({ projectId: 'project-123' });

  assert.equal(startStatus.status, 'observing');
  assert.equal(startStatus.state, 'observing');
  assert.equal(startStatus.running, true);
  assert.equal(startStatus.strategy, 'active-editor');
  assert.equal(startStatus.activePath, 'main.tex');
  assert.equal(startStatus.queuedEventCount, 0);
  const inputListener = harness.listeners.find(listener => listener.type === 'input');
  assert.ok(inputListener);
  assert.equal(inputListener.options, true);

  harness.fireInput();
  assert.equal(harness.normalizeCalls.length, 0, 'unchanged input must not queue empty operations');

  harness.setEditorText('hello world');
  harness.fireInput();

  assert.equal(harness.normalizeCalls.length, 0, 'normalization is deferred until drain');
  assert.equal(harness.observer.getStatus().queuedEventCount, 1);
  harness.observer.drainEvents();
  assert.deepEqual(harness.normalizeCalls, [
    {
      path: 'main.tex',
      previousContent: 'hello',
      nextContent: 'hello world',
      observedAt: '2026-05-05T00:00:00.000Z',
      source: 'active-editor'
    }
  ]);
  assert.equal(harness.observer.getStatus().queuedEventCount, 0);
  assert.equal(harness.observer.getStatus().lastEventAt, '2026-05-05T00:00:00.000Z');
});

test('drainEvents returns queued events and empties the queue', () => {
  const harness = createHarness();
  harness.observer.start({ projectId: 'project-123' });
  harness.setEditorText('hello world');
  harness.fireInput();

  const events = harness.observer.drainEvents();

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    path: 'main.tex',
    baseHash: 'base:5',
    nextHash: 'next:11',
    nextContent: 'hello world',
    ops: [{ p: 5, i: ' world' }],
    observedAt: '2026-05-05T00:00:00.000Z',
    observedVersion: null,
    source: 'active-editor'
  });
  assert.equal(Object.prototype.hasOwnProperty.call(events[0], 'previousContent'), false);
  assert.deepEqual(harness.observer.drainEvents(), []);
  assert.equal(harness.observer.getStatus().queuedEventCount, 0);
});

test('start and stop clear pending events so stale edits cannot cross projects', () => {
  const stopped = createHarness();
  stopped.observer.start({ projectId: 'project_a' });
  stopped.setEditorText('project a edit');
  stopped.fireInput();

  assert.equal(stopped.observer.getStatus().queuedEventCount, 1);

  const stopStatus = stopped.observer.stop();
  assert.equal(stopStatus.queuedEventCount, 0);

  stopped.setEditorText('project b baseline');
  const restartStatus = stopped.observer.start({ projectId: 'project_b' });

  assert.equal(restartStatus.queuedEventCount, 0);
  assert.deepEqual(stopped.observer.drainEvents(), []);

  const restarted = createHarness();
  restarted.observer.start({ projectId: 'project_a' });
  restarted.setEditorText('project a edit');
  restarted.fireInput();

  assert.equal(restarted.observer.getStatus().queuedEventCount, 1);

  const startStatus = restarted.observer.start({ projectId: 'project_b' });

  assert.equal(startStatus.queuedEventCount, 0);
  assert.deepEqual(restarted.observer.drainEvents(), []);
});

test('direct input switch adopts new active file as baseline when no selection event was observed', () => {
  const harness = createHarness();
  harness.observer.start({ projectId: 'project-123' });

  harness.setActivePath('sections/intro.tex');
  harness.setEditorText('intro baseline');
  harness.fireInput();

  assert.equal(harness.observer.getStatus().activePath, 'sections/intro.tex');
  assert.equal(harness.observer.getStatus().queuedEventCount, 0);
  assert.equal(harness.normalizeCalls.length, 0);

  harness.setEditorText('intro baseline plus edit');
  harness.fireInput();

  harness.observer.drainEvents();
  assert.equal(harness.normalizeCalls.length, 1);
  assert.equal(harness.normalizeCalls[0].path, 'sections/intro.tex');
  assert.equal(harness.normalizeCalls[0].previousContent, 'intro baseline');
  assert.equal(harness.normalizeCalls[0].nextContent, 'intro baseline plus edit');
});

test('selection events refresh active baseline so the first typed edit in a new file is queued', () => {
  const harness = createHarness();
  harness.observer.start({ projectId: 'project-123' });

  harness.setActivePath('sections/intro.tex');
  harness.setEditorText('intro baseline');
  harness.fireEvent('focusin');

  assert.equal(harness.observer.getStatus().activePath, 'sections/intro.tex');
  assert.equal(harness.observer.getStatus().queuedEventCount, 0);
  assert.equal(harness.normalizeCalls.length, 0);

  harness.setEditorText('intro baseline plus edit');
  harness.fireInput();

  const events = harness.observer.drainEvents();
  assert.equal(harness.normalizeCalls.length, 1);
  assert.equal(harness.normalizeCalls[0].path, 'sections/intro.tex');
  assert.equal(harness.normalizeCalls[0].previousContent, 'intro baseline');
  assert.equal(harness.normalizeCalls[0].nextContent, 'intro baseline plus edit');
  assert.equal(events[0].path, 'sections/intro.tex');
});

test('editor read failures do not queue deletion events or reset the baseline', () => {
  const harness = createHarness();
  harness.observer.start({ projectId: 'project-123' });

  harness.setReadError(new Error('editor unavailable'));
  harness.fireInput();

  assert.equal(harness.observer.getStatus().status, 'unavailable');
  assert.equal(harness.observer.getStatus().reason, 'read_active_editor_failed');
  assert.equal(harness.normalizeCalls.length, 0);
  assert.deepEqual(harness.observer.drainEvents(), []);

  harness.setReadError(null);
  harness.setEditorText('hello world');
  harness.fireInput();

  harness.observer.drainEvents();
  assert.equal(harness.normalizeCalls.length, 1);
  assert.equal(harness.normalizeCalls[0].previousContent, 'hello');
  assert.equal(harness.normalizeCalls[0].nextContent, 'hello world');
});

test('invalid observed timestamps fall back to Date.now without throwing', () => {
  const originalDateNow = Date.now;
  Date.now = () => Date.parse('2026-05-05T01:02:03.000Z');
  try {
    const outOfRange = createHarness({ now: Number.MAX_VALUE });
    outOfRange.observer.start({ projectId: 'project-123' });
    outOfRange.setEditorText('hello world');

    assert.doesNotThrow(() => outOfRange.fireInput());
    outOfRange.observer.drainEvents();
    assert.equal(outOfRange.normalizeCalls[0].observedAt, '2026-05-05T01:02:03.000Z');

    const throwingClock = createHarness({
      now() {
        throw new Error('clock unavailable');
      }
    });
    throwingClock.observer.start({ projectId: 'project-123' });
    throwingClock.setEditorText('hello world');

    assert.doesNotThrow(() => throwingClock.fireInput());
    throwingClock.observer.drainEvents();
    assert.equal(throwingClock.normalizeCalls[0].observedAt, '2026-05-05T01:02:03.000Z');
  } finally {
    Date.now = originalDateNow;
  }
});

test('missing active path reports unavailable status with a stable reason', () => {
  const harness = createHarness({ activePath: '' });

  const status = harness.observer.start({ projectId: 'project-123' });

  assert.equal(status.status, 'unavailable');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.running, true);
  assert.equal(status.reason, 'missing_active_path');
  assert.equal(status.lastErrorCode, 'missing_active_path');
  assert.equal(status.activePath, '');
});

test('missing document reports unavailable status without running', () => {
  const harness = createHarness({ document: null });

  const status = harness.observer.start({ projectId: 'project-123' });

  assert.equal(status.status, 'unavailable');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.running, false);
  assert.equal(status.reason, 'missing_document');
  assert.equal(status.lastErrorCode, 'missing_document');
  assert.equal(status.queuedEventCount, 0);
  assert.equal(harness.listeners.length, 0);
});

test('observer remains read-only and diagnostics expose only channel key names', () => {
  const harness = createHarness();

  harness.observer.start({ projectId: 'project-123' });
  harness.setEditorText('hello world');
  harness.fireInput();

  assert.equal(harness.dispatchCount, 0);
  assert.equal(harness.socketHookCount, 0);

  const status = harness.observer.getStatus();
  const candidateKeys = status.channelCandidates.flatMap(candidate =>
    candidate.keyPaths.map(keyPath => `${candidate.root}:${keyPath}`)
  );
  assert.ok(candidateKeys.includes('overleaf:realtime'));
  assert.ok(candidateKeys.includes('overleaf:realtime.socket'));
  assert.ok(candidateKeys.includes('overleaf:editor.doc'));
  assert.ok(candidateKeys.includes('Overleaf:SocketIoConnection'));
  assert.ok(candidateKeys.includes('_ide:collab.channel'));
  assert.ok(candidateKeys.includes('OL:eventBus'));
  assert.doesNotMatch(JSON.stringify(status.channelCandidates), /SECRET_/);
});

test('channel diagnostics do not invoke page-owned DOM marker getters', () => {
  const Observer = loadObserverFactory();
  let getterCallCount = 0;
  const domLike = {};
  Object.defineProperty(domLike, 'nodeType', {
    enumerable: true,
    get() {
      getterCallCount += 1;
      return 1;
    }
  });
  Object.defineProperty(domLike, 'socket', {
    enumerable: true,
    value: {}
  });

  const candidates = Observer.collectChannelCandidates({
    overleaf: {
      editor: domLike,
      realtime: {
        socket: {}
      }
    }
  });
  const candidateKeys = candidates.flatMap(candidate =>
    candidate.keyPaths.map(keyPath => `${candidate.root}:${keyPath}`)
  );

  assert.equal(getterCallCount, 0);
  assert.ok(candidateKeys.includes('overleaf:realtime.socket'));
  assert.equal(candidateKeys.includes('overleaf:editor.socket'), false);
});

test('stop removes the active-editor input listener and returns off status', () => {
  const harness = createHarness();
  harness.observer.start({ projectId: 'project-123' });

  const status = harness.observer.stop();

  assert.deepEqual(harness.removals.map(removal => removal.type), ['input', 'click', 'focusin', 'change']);
  assert.ok(harness.removals.every(removal => removal.options === true));
  assert.equal(status.status, 'off');
  assert.equal(status.state, 'off');
  assert.equal(status.running, false);
});

test('exposes a browser global and CommonJS factory', () => {
  const Observer = loadObserverFactory();
  assert.equal(typeof Observer.create, 'function');

  const source = fs.readFileSync(
    path.join(__dirname, '../extension/src/page/overleafRealtimeObserver.js'),
    'utf8'
  );
  const context = {};
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context);

  assert.equal(typeof context.CodexOverleafRealtimeObserver.create, 'function');
});
