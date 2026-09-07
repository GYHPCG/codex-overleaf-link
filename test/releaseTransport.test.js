const assert = require('node:assert/strict');
const test = require('node:test');
const { requestRelease } = require('../native-host/src/releaseTransport');
const URL = 'https://github.com/Ghqqqq/codex-overleaf-link/releases/download/v2.3.6/test.bin';

test('body stalls are aborted and a fresh download can succeed', async () => {
  let attempts = 0;
  let cancelled = 0;
  const result = await requestRelease(URL, { timeoutMs: 15, totalTimeoutMs: 1000, delayMs: 0,
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(new ReadableStream({ cancel() { cancelled += 1; } }))
        : new Response('complete');
    }
  });
  assert.equal(result.bytes.toString(), 'complete');
  assert.equal(attempts, 2);
  assert.equal(cancelled, 1);
});

test('stream size enforcement cancels an oversized body without retrying it', async () => {
  let cancelled = 0;
  let attempts = 0;
  await assert.rejects(requestRelease(URL, { limit: 3, delayMs: 0,
    fetch: async () => {
      attempts += 1;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('too large')); },
        cancel() { cancelled += 1; }
      }));
    }
  }), { code: 'update_download_limit' });
  assert.equal(attempts, 1);
  assert.equal(cancelled, 1);
});

test('server failures retry but not-found and certificate failures stop immediately', async () => {
  let attempts = 0;
  const result = await requestRelease(URL, { delayMs: 0, fetch: async () => {
    attempts += 1;
    return attempts === 1 ? new Response('', { status: 503 }) : new Response('ok');
  } });
  assert.equal(result.bytes.toString(), 'ok');
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(requestRelease(URL, { delayMs: 0, fetch: async () => {
    attempts += 1;
    return new Response('', { status: 404 });
  } }), { code: 'update_asset_http_error' });
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(requestRelease(URL, { delayMs: 0, fetch: async () => {
    attempts += 1;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('private secret'), { code: 'CERT_HAS_EXPIRED' }) });
  } }), error => error.code === 'update_network_certificate' && !error.message.includes('private secret'));
  assert.equal(attempts, 1);
});

test('one operation deadline bounds all attempts including an unresponsive fetch', async () => {
  let attempts = 0;
  const start = Date.now();
  await assert.rejects(requestRelease(URL, { timeoutMs: 20, totalTimeoutMs: 35, delayMs: 0,
    fetch: () => { attempts += 1; return new Promise(() => {}); }
  }), { code: 'update_network_timeout' });
  assert.ok(attempts <= 2);
  assert.ok(Date.now() - start < 500);
});

test('explicit cancellation does not retry or expose the underlying error message', async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(requestRelease(URL, { signal: controller.signal, delayMs: 0, fetch: async () => {
    attempts += 1;
    controller.abort(new Error('private proxy credential'));
    throw controller.signal.reason;
  } }), error => error.code === 'update_network_cancelled' && !error.message.includes('private proxy credential'));
  assert.equal(attempts, 1);
});

test('native transport errors use stable public codes while preserving a safe diagnostic reason', async () => {
  await assert.rejects(requestRelease(URL, { maxAttempts: 1, fetch: async () => {
    throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
  } }), error => error.code === 'update_network_failed' && error.network.reason === 'ECONNRESET');
});
