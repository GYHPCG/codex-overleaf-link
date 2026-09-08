(function initRunScrollLayout(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafModuleRegistry.define('RunScrollLayout', [], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function runScrollLayoutFactory() {
  'use strict';

  const READING_ANCHORS = '.run-final-answer p, .run-final-answer li, .run-final-answer pre, .run-final-answer h1, .run-final-answer h2, .run-final-answer h3, .run-stream p, .run-stream li, .run-stream pre, [data-run-task], [data-run-status]';

  function create({ getScroller, onLayoutChange, isFollowing = () => true, window: host = globalThis } = {}) {
    let current = null;
    let resizeObserver = null;
    let mutationObserver = null;
    let anchor = null;
    let extent = '';

    function measure() { return current ? `${current.scrollHeight}:${current.clientHeight}` : ''; }

    function captureAnchor(force = false) {
      if (!current || isFollowing()) { anchor = null; return; }
      // A layout-induced scroll can arrive before ResizeObserver. Keep the
      // pre-layout anchor until notify has compensated its displacement.
      if (!force && extent !== measure()) return;
      const bounds = current.getBoundingClientRect?.();
      if (!bounds) return;
      const nodes = current.querySelectorAll?.(READING_ANCHORS) || [];
      anchor = null;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
          anchor = { node, offset: rect.top - bounds.top };
          break;
        }
      }
    }

    function restoreAnchor() {
      if (isFollowing() || !anchor || !current.contains?.(anchor.node)) return;
      const rect = anchor.node.getBoundingClientRect();
      if (!rect.height) return;
      const delta = rect.top - current.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) > 0.5) current.scrollTop += delta;
    }

    function snapshot() {
      captureAnchor();
      const run = anchor?.node.closest?.('[data-run-id]');
      return { scrollTop: current?.scrollTop || 0, runId: run?.dataset?.runId || '',
        index: run ? Array.from(run.querySelectorAll(READING_ANCHORS)).indexOf(anchor.node) : -1,
        offset: anchor?.offset || 0 };
    }

    function restore(reading) {
      if (!current || !reading) return;
      current.scrollTop = reading.scrollTop;
      // History repaint replaces nodes. Rebind by run identity and paragraph
      // position; a missing anchor falls back to the saved scroll offset.
      const run = Array.from(current.querySelectorAll?.('[data-run-id]') || [])
        .find(node => node.dataset.runId === reading.runId);
      const node = run?.querySelectorAll(READING_ANCHORS)[reading.index];
      anchor = node ? { node, offset: reading.offset } : null;
      restoreAnchor();
      extent = measure();
      captureAnchor(true);
    }

    function dispose() {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;
      current = null;
      anchor = null;
      extent = '';
    }

    function notify() {
      if (!current) return;
      const active = getScroller();
      if (active !== current) {
        bind(active);
        return;
      }
      restoreAnchor();
      extent = measure();
      onLayoutChange(current);
      captureAnchor(true);
    }

    function bind(scroller) {
      if (scroller === current) return;
      dispose();
      if (!scroller || typeof host.ResizeObserver !== 'function') return;
      current = scroller;
      extent = measure();
      captureAnchor(true);
      resizeObserver = new host.ResizeObserver(notify);
      resizeObserver.observe(scroller);
      // Observe run-sized children, rather than every streaming text node.
      for (const child of scroller.children || []) resizeObserver.observe(child);
      if (typeof host.MutationObserver === 'function') {
        mutationObserver = new host.MutationObserver(records => {
          if (current !== scroller) return;
          for (const record of records) {
            for (const node of record.removedNodes) {
              if (node.nodeType === 1) resizeObserver.unobserve(node);
            }
            for (const node of record.addedNodes) {
              if (node.nodeType === 1) resizeObserver.observe(node);
            }
          }
          notify();
        });
        mutationObserver.observe(scroller, { childList: true });
      }
    }

    return Object.freeze({ bind, dispose, captureAnchor, snapshot, restore });
  }

  return Object.freeze({ create });
});
