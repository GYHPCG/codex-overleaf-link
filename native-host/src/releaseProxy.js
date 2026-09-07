'use strict';

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { updateError } = require('./updateTrust');
let systemCache = { platform: '', at: 0, text: '' };

function proxyError(code, message, retryable = false) {
  return Object.assign(updateError(code, message), { retryable });
}

function bypassProxy(url, values = '') {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return String(values).split(/[,;\s]+/).some(raw => {
    if (!raw) return false;
    if (raw === '*') return true;
    if (raw === '<local>') return !host.includes('.');
    const match = raw.toLowerCase().match(/^(.*?)(?::(\d+))?$/);
    if (match[2] && match[2] !== port) return false;
    const domain = match[1].replace(/^\*?\./, '');
    return host === domain || host.endsWith('.' + domain);
  });
}

function readSystemProxy(platform) {
  if (systemCache.platform === platform && Date.now() - systemCache.at < 30000) return systemCache.text;
  let text = '';
  try {
    const command = platform === 'darwin' ? '/usr/sbin/scutil' : 'reg.exe';
    const args = platform === 'darwin' ? ['--proxy']
      : ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'];
    text = execFileSync(command, args, { encoding: 'utf8', timeout: 1000, maxBuffer: 32768,
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_error) { /* environment proxies and direct access remain available */ }
  systemCache = { platform, at: Date.now(), text };
  return text;
}

function resolveReleaseProxy(value, options = {}) {
  const url = new URL(value);
  const env = options.env || process.env;
  if (bypassProxy(url, env.NO_PROXY || env.no_proxy)) return null;
  const protocol = url.protocol === 'https:' ? 'HTTPS' : 'HTTP';
  let configured = env[protocol + '_PROXY'] || env[protocol.toLowerCase() + '_proxy'] || env.ALL_PROXY || env.all_proxy;
  let source = 'environment';
  const platform = options.platform || process.platform;
  if (!configured && ['darwin', 'win32'].includes(platform)) {
    source = 'system';
    const text = (options.systemProxy || readSystemProxy)(platform);
    if (platform === 'darwin') {
      const field = key => text.match(new RegExp('(?:^|\\n)\\s*' + key + '\\s*:\\s*([^\\n]+)'))?.[1]?.trim() || '';
      if (field(protocol + 'Enable') === '1') {
        const host = field(protocol + 'Proxy');
        const port = Number(field(protocol + 'Port'));
        if (host && Number.isInteger(port) && port > 0 && port <= 65535) {
          configured = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
        }
      }
      const exceptions = text.match(/ExceptionsList\s*:[\s\S]*?\n\s*}/)?.[0] || '';
      const values = Array.from(exceptions.matchAll(/\d+\s*:\s*([^\n]+)/g), match => match[1].trim()).join(',');
      if (bypassProxy(url, values)) return null;
    } else if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(text)) {
      const server = text.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || '';
      const exceptions = text.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i)?.[1] || '';
      if (bypassProxy(url, exceptions)) return null;
      configured = server.includes('=')
        ? server.split(';').find(part => part.toLowerCase().startsWith(protocol.toLowerCase() + '='))?.split('=').slice(1).join('=')
        : server;
      if (configured && !configured.includes('://')) configured = 'http://' + configured;
    }
  }
  if (!configured) return null;
  let proxy;
  try { proxy = new URL(configured); } catch (_error) {
    throw proxyError('update_proxy_invalid', 'The configured update proxy address is invalid.');
  }
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw proxyError('update_proxy_unsupported', 'The update proxy must use HTTP or HTTPS. SOCKS and PAC require an HTTP proxy endpoint.');
  }
  return { url: proxy.href, source };
}

function hostname(url) { return url.hostname.replace(/^\[|\]$/g, ''); }
function proxyHeaders(proxy) {
  if (!proxy.username && !proxy.password) return {};
  let credentials;
  try { credentials = decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password); }
  catch (_error) { throw proxyError('update_proxy_invalid', 'The configured proxy credentials are malformed.'); }
  return { 'Proxy-Authorization': 'Basic ' + Buffer.from(credentials).toString('base64') };
}

function tunnel(target, proxy, signal) {
  return new Promise((resolve, reject) => {
    const authority = target.hostname + ':' + (target.port || '443');
    const client = proxy.protocol === 'https:' ? https : http;
    const request = client.request({ protocol: proxy.protocol, hostname: hostname(proxy), port: proxy.port,
      method: 'CONNECT', path: authority, headers: { Host: authority, ...proxyHeaders(proxy) }, agent: false, signal });
    request.once('error', reject);
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(proxyError(response.statusCode === 407 ? 'update_proxy_auth_required' : 'update_proxy_failed',
          'The proxy refused the secure update connection (HTTP ' + response.statusCode + ').', response.statusCode >= 500));
        return;
      }
      if (signal.aborted) { socket.destroy(); reject(signal.reason); return; }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, host: hostname(target),
        servername: net.isIP(hostname(target)) ? undefined : hostname(target), ALPNProtocols: ['http/1.1'] });
      const abort = () => secure.destroy(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      secure.once('close', () => signal.removeEventListener('abort', abort));
      secure.once('error', reject);
      secure.once('secureConnect', () => resolve(secure));
    });
    request.end();
  });
}

async function proxyRequest(target, proxy, init) {
  let agent;
  if (target.protocol === 'https:') {
    const socket = await tunnel(target, proxy, init.signal);
    if (init.signal.aborted) { socket.destroy(); throw init.signal.reason; }
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
  }
  return new Promise((resolve, reject) => {
    const headers = { ...Object.fromEntries(new Headers(init.headers || {})), Host: target.host };
    const secure = target.protocol === 'https:';
    const client = secure || proxy.protocol === 'https:' ? https : http;
    const request = secure
      ? client.request(target, { method: init.method, headers, agent, signal: init.signal })
      : client.request({ protocol: proxy.protocol, hostname: hostname(proxy), port: proxy.port,
        method: init.method, path: target.href, headers: { ...headers, ...proxyHeaders(proxy) }, agent: false, signal: init.signal });
    request.once('error', error => { agent?.destroy(); reject(error); });
    request.once('response', incoming => {
      incoming.once('close', () => agent?.destroy());
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const empty = init.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
      if (empty) incoming.resume();
      const response = new Response(empty ? null : Readable.toWeb(incoming),
        { status: incoming.statusCode, statusText: incoming.statusMessage, headers });
      Object.defineProperty(response, 'url', { value: target.href });
      resolve(response);
    });
    request.end();
  });
}

async function fetchRelease(url, init, options = {}) {
  const proxy = resolveReleaseProxy(url, options);
  if (!proxy) return globalThis.fetch(url, init);
  let target = new URL(url);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await proxyRequest(target, new URL(proxy.url), init);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (response.body) await response.body.cancel();
    const next = new URL(location, target);
    if (!['http:', 'https:'].includes(next.protocol) || target.protocol === 'https:' && next.protocol !== 'https:' ||
        options.allowedHosts && !options.allowedHosts.has(next.hostname)) {
      throw proxyError('update_asset_redirect_forbidden', 'Release request redirected to an untrusted host.');
    }
    target = next;
  }
  throw proxyError('update_network_redirect_limit', 'The update request exceeded its redirect limit.');
}

module.exports = { fetchRelease, resolveReleaseProxy };
