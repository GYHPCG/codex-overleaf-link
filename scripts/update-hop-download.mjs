import fs from 'node:fs';
import transport from '../native-host/src/releaseTransport.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export async function downloadReleaseAsset(tag, name, target, options = {}) {
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const repository = options.repository || 'Ghqqqq/codex-overleaf-link';
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
  const result = await transport.requestRelease(url, {
    fetch: options.fetchImpl, timeoutMs, maxAttempts, delayMs,
    totalTimeoutMs: timeoutMs * maxAttempts + delayMs * maxAttempts * maxAttempts,
    limit: MAX_ASSET_BYTES, stage: 'release_hop',
    allowedHosts: new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
  });
  fs.writeFileSync(target, result.bytes);
}
