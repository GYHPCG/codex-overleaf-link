const assert = require('node:assert/strict');
const test = require('node:test');
const Controller = require('../extension/src/content/otWarmMirrorController');
const Text = require('../extension/src/shared/otText');

function event(path, before, after, observedAt = new Date().toISOString()) {
  return { path, baseHash: Text.hashText(before), nextHash: Text.hashText(after), nextContent: after, observedAt };
}

test('only continuous adjacent edits are coalesced and net-zero changes disappear', () => {
  const first = event('main.tex', 'a', 'ab');
  const second = event('main.tex', 'ab', 'abc');
  const merged = Controller.queuePatchEvents([], [first, second]);
  assert.equal(merged.queue.length, 1);
  assert.equal(merged.queue[0].baseHash, first.baseHash);
  assert.equal(merged.queue[0].nextContent, 'abc');
  assert.equal(Controller.queuePatchEvents(merged.queue, [event('main.tex', 'abc', 'a')]).queue.length, 0);
  const discontinuous = Controller.queuePatchEvents([], [first, event('main.tex', 'other baseline', 'new')]);
  assert.equal(discontinuous.queue.length, 2);
});

test('pending and outgoing batches are bounded by bytes as well as event count', () => {
  const content = 'x'.repeat(900 * 1024);
  const events = Array.from({ length: 3 }, (_, i) => event('file-' + i + '.tex', '', content));
  const queued = Controller.queuePatchEvents([], events);
  assert.equal(queued.ok, true);
  assert.ok(queued.bytes <= Controller.OT_MAX_PENDING_BYTES);
  const batch = Controller.takePatchBatch(queued.queue);
  assert.equal(batch.length, 2);
  assert.equal(queued.queue.length, 1);
  assert.equal(Controller.queuePatchEvents([], [...events, ...events.map((e, i) => ({ ...e, path: 'extra-' + i + '.tex' }))]).reason, 'ot_queue_limit');
});

test('UTF-8 file size and observation age are enforced before enqueueing', () => {
  assert.equal(Controller.queuePatchEvents([], [event('main.tex', '', '\u4e2d'.repeat(350000))]).reason, 'ot_file_limit');
  assert.equal(Controller.queuePatchEvents([], [event('main.tex', 'a', 'b', new Date(Date.now() - 31000).toISOString())]).reason, 'ot_event_expired');
});

test('receipt validation requires every requested path, hash and a recent observation', () => {
  const input = event('main.tex', 'a', 'b');
  const result = { appliedCount: 1, appliedFiles: [{ path: input.path, hash: input.nextHash }], skippedCount: 0 };
  assert.equal(Controller.validatePatchReceipt([input], result).ok, true);
  assert.equal(Controller.validatePatchReceipt([input], { ...result, appliedFiles: [{ path: 'other.tex', hash: input.nextHash }] }).ok, false);
  assert.equal(Controller.validatePatchReceipt([input], { ...result, appliedFiles: [{ path: input.path, hash: 'wrong' }] }).ok, false);
  assert.equal(Controller.validatePatchReceipt([{ ...input, observedAt: '2000-01-01T00:00:00.000Z' }], result).reason, 'ot_event_expired');
});
