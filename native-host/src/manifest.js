'use strict';

const os = require('node:os');
const path = require('node:path');

const HOST_NAME = 'com.codex.overleaf.cstcloud';
const HOST_DESCRIPTION = 'Codex Overleaf Link CSTCloud local bridge';
const DEFAULT_CHROME_EXTENSION_ID = 'baebbifpfkkmbomoioanolpnjmfhpbad';

const MACOS_MANIFEST_DIRS = {
  chrome: 'Library/Application Support/Google/Chrome/NativeMessagingHosts',
  chromium: 'Library/Application Support/Chromium/NativeMessagingHosts'
};

const LINUX_MANIFEST_DIRS = {
  chrome: '.config/google-chrome/NativeMessagingHosts',
  chromium: '.config/chromium/NativeMessagingHosts'
};

const WINDOWS_REGISTRY_PATHS = {
  chrome: 'Software\\Google\\Chrome\\NativeMessagingHosts',
  chromium: 'Software\\Chromium\\NativeMessagingHosts'
};

function validateExtensionId(extensionId) {
  return typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId);
}

const validateChromeExtensionId = validateExtensionId;

function buildAllowedOrigin(extensionId) {
  if (!validateExtensionId(extensionId)) {
    throw new Error(`Invalid Chrome extension id: ${extensionId}`);
  }
  return `chrome-extension://${extensionId}/`;
}

function buildHostManifest({ extensionId, extensionIds, bridgePath, platform = process.platform }) {
  const ids = normalizeExtensionIds(extensionIds || [extensionId]);
  if (!ids.length) {
    throw new Error(`Invalid Chrome extension id: ${extensionId}`);
  }
  if (!bridgePath || !isAbsolutePathForPlatform(bridgePath, platform)) {
    throw new Error('Native bridge path must be absolute');
  }

  return {
    name: HOST_NAME,
    description: HOST_DESCRIPTION,
    path: bridgePath,
    type: 'stdio',
    allowed_origins: ids.map(buildAllowedOrigin)
  };
}

function normalizeExtensionIds(extensionIds) {
  const seen = new Set();
  const ids = [];
  for (const value of Array.isArray(extensionIds) ? extensionIds : [extensionIds]) {
    const id = typeof value === 'string' ? value : '';
    if (!id || seen.has(id)) {
      continue;
    }
    if (!validateExtensionId(id)) {
      throw new Error(`Invalid Chrome extension id: ${id}`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isAbsolutePathForPlatform(targetPath, platform = process.platform) {
  if (platform === 'win32') {
    return path.win32.isAbsolute(targetPath);
  }
  if (platform === 'darwin' || platform === 'linux') {
    return path.posix.isAbsolute(targetPath);
  }
  return path.isAbsolute(targetPath);
}

function getNativeHostManifestPath(options = {}) {
  const platform = options.platform || process.platform;
  const browser = normalizeBrowser(options.browser || 'chrome');

  if (platform === 'darwin') {
    const manifestDir = MACOS_MANIFEST_DIRS[browser];
    if (!manifestDir) {
      throwUnsupportedBrowser(platform, browser);
    }
    return requireAbsolutePath(
      path.posix.join(getHomeDir(options), manifestDir, `${HOST_NAME}.json`),
      platform
    );
  }

  if (platform === 'linux') {
    const manifestDir = LINUX_MANIFEST_DIRS[browser];
    if (!manifestDir) {
      throwUnsupportedBrowser(platform, browser);
    }
    return requireAbsolutePath(
      path.posix.join(getHomeDir(options), manifestDir, `${HOST_NAME}.json`),
      platform
    );
  }

  if (platform === 'win32') {
    return requireAbsolutePath(
      path.win32.join(
        getWindowsLocalAppData(options),
        'codex-overleaf',
        'native-messaging-hosts',
        `${HOST_NAME}.json`
      ),
      platform
    );
  }

  throwUnsupportedPlatform(platform);
}

function getChromeNativeHostManifestPath(options = {}) {
  return getNativeHostManifestPath({
    ...options,
    platform: 'darwin',
    browser: 'chrome'
  });
}

function getWindowsRegistryMetadata(options = {}) {
  const browser = normalizeBrowser(options.browser || 'chrome');
  const registryPath = WINDOWS_REGISTRY_PATHS[browser];
  if (!registryPath) {
    throwUnsupportedBrowser('win32', browser);
  }

  const registryKey = `HKCU\\${registryPath}\\${HOST_NAME}`;
  const manifestPath = getNativeHostManifestPath({
    ...options,
    platform: 'win32',
    browser
  });
  const quotedRegistryKey = quoteWindowsCommandArg(registryKey);
  const quotedManifestPath = quoteWindowsCommandArg(manifestPath);

  return {
    kind: 'registry',
    browser,
    root: 'HKCU',
    registryPath,
    registryKey,
    manifestPath,
    quotedRegistryKey,
    quotedManifestPath,
    addArgs: ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
    deleteArgs: ['delete', registryKey, '/f'],
    addCommand: `reg.exe add ${quotedRegistryKey} /ve /t REG_SZ /d ${quotedManifestPath} /f`,
    deleteCommand: `reg.exe delete ${quotedRegistryKey} /f`
  };
}

function normalizeBrowser(browser) {
  if (!browser || browser === 'auto') {
    return 'chrome';
  }
  if (browser === 'chrome' || browser === 'chromium') {
    return browser;
  }
  return browser;
}

function getHomeDir(options = {}) {
  const env = options.env || process.env;
  if (options.homeDir) {
    return options.homeDir;
  }
  return env.HOME || env.USERPROFILE || os.homedir();
}

function getWindowsLocalAppData(options = {}) {
  const env = options.env || process.env;
  if (env.LOCALAPPDATA) {
    return env.LOCALAPPDATA;
  }
  const homeDir = options.homeDir || env.USERPROFILE || env.HOME || os.homedir();
  return path.win32.join(homeDir, 'AppData', 'Local');
}

function requireAbsolutePath(targetPath, platform) {
  if (!isAbsolutePathForPlatform(targetPath, platform)) {
    throw new Error(`Native host manifest path must be absolute: ${targetPath}`);
  }
  return targetPath;
}

function quoteWindowsCommandArg(value) {
  const text = String(value);
  if (/["\r\n]/.test(text)) {
    throw new Error('Windows registry command argument contains an unsafe character');
  }
  return `"${text}"`;
}

function throwUnsupportedPlatform(platform) {
  throw new Error(`Unsupported native host platform: ${platform}`);
}

function throwUnsupportedBrowser(platform, browser) {
  throw new Error(`Unsupported native host browser for ${platform}: ${browser}`);
}

module.exports = {
  DEFAULT_CHROME_EXTENSION_ID,
  HOST_DESCRIPTION,
  HOST_NAME,
  buildAllowedOrigin,
  buildHostManifest,
  getChromeNativeHostManifestPath,
  getNativeHostManifestPath,
  getWindowsRegistryMetadata,
  normalizeExtensionIds,
  validateChromeExtensionId,
  validateExtensionId
};
