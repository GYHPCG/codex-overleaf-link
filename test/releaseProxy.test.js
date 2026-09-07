const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { requestRelease } = require('../native-host/src/releaseTransport');
const { resolveReleaseProxy } = require('../native-host/src/releaseProxy');

test('explicit proxies take precedence and NO_PROXY matches host boundaries', () => {
  const options = { platform: 'darwin', env: { HTTPS_PROXY: 'http://localhost:7890', NO_PROXY: '.example.org' },
    systemProxy: () => { throw new Error('explicit environment must win'); } };
  assert.equal(resolveReleaseProxy('https://github.com/file', options).url, 'http://localhost:7890/');
  assert.equal(resolveReleaseProxy('https://sub.example.org/file', options), null);
  assert.ok(resolveReleaseProxy('https://notexample.org/file', options));
});

test('macOS and Windows system proxy settings are read without changing them', () => {
  const mac = resolveReleaseProxy('https://github.com/file', { env: {}, platform: 'darwin',
    systemProxy: () => 'HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\n' });
  assert.equal(mac.url, 'http://127.0.0.1:7890/');
  assert.equal(mac.source, 'system');
  const win = resolveReleaseProxy('https://github.com/file', { env: {}, platform: 'win32',
    systemProxy: () => 'ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    http=proxy.local:80;https=proxy.local:8080\n' });
  assert.equal(win.url, 'http://proxy.local:8080/');
});

test('unsupported explicit proxy schemes fail with credential-free guidance', () => {
  assert.throws(() => resolveReleaseProxy('https://github.com/file', {
    env: { HTTPS_PROXY: 'socks5://private-user:private-password@localhost:7890' }, platform: 'linux'
  }), error => error.code === 'update_proxy_unsupported' && !error.message.includes('private-'));
});

async function server(t, handler) {
  const proxy = http.createServer(handler);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  return proxy;
}

test('the production transport downloads through the configured HTTP proxy', async t => {
  let target;
  const proxy = await server(t, (request, response) => {
    target = request.url;
    response.end('through proxy');
  });
  const result = await requestRelease('http://updates.invalid/file', {
    env: { HTTP_PROXY: 'http://127.0.0.1:' + proxy.address().port }, platform: 'linux',
    timeoutMs: 1000, maxAttempts: 1
  });
  assert.equal(target, 'http://updates.invalid/file');
  assert.equal(result.bytes.toString(), 'through proxy');
});

test('proxy authentication refusal stops an HTTPS tunnel without leaking credentials', async t => {
  const proxy = await server(t);
  let attempts = 0;
  proxy.on('connect', (_request, socket) => {
    attempts += 1;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  await assert.rejects(requestRelease('https://github.com/file', {
    env: { HTTPS_PROXY: 'http://private-user:private-password@127.0.0.1:' + proxy.address().port }, platform: 'linux',
    timeoutMs: 1000, delayMs: 0
  }), error => error.code === 'update_proxy_auth_required' && !error.message.includes('private-'));
  assert.equal(attempts, 1);
});
