'use strict';

const os = require('node:os');
const path = require('node:path');
const {
  getNativeHostManifestPath,
  getWindowsRegistryMetadata
} = require('./manifest');

function getNativeHostPlatform(options = {}) {
  return options.platform || process.platform;
}

function getCodexOverleafHome(options = {}) {
  const platform = getNativeHostPlatform(options);
  if (platform === 'win32') {
    return path.win32.join(getWindowsLocalAppData(options), 'CodexOverleaf');
  }
  if (platform === 'darwin' || platform === 'linux') {
    return path.posix.join(getHomeDir(options), '.codex-overleaf');
  }
  throwUnsupportedPlatform(platform);
}

function getDefaultRuntimeRoot(options = {}) {
  const platformPath = getPathModule(options);
  return platformPath.join(getCodexOverleafHome(options), 'native-host-runtime');
}

function getDefaultManagedRoot(options = {}) {
  const platformPath = getPathModule(options);
  return platformPath.join(getCodexOverleafHome(options), 'managed');
}

function getDefaultManagedExtensionRoot(options = {}) {
  return getPathModule(options).join(getDefaultManagedRoot(options), 'extension');
}

function getDefaultManagedNativeRoot(options = {}) {
  return getPathModule(options).join(getDefaultManagedRoot(options), 'native');
}

function getDefaultBridgePath(options = {}) {
  const platformPath = getPathModule(options);
  const bridgeName = getNativeHostPlatform(options) === 'win32'
    ? 'codex-overleaf-cstcloud-bridge.cmd'
    : 'codex-overleaf-cstcloud-bridge';
  return platformPath.join(getCodexOverleafHome(options), bridgeName);
}

function getNativeHostRegistrationTarget(options = {}) {
  const platform = getNativeHostPlatform(options);
  const browser = getNativeHostBrowser(options);
  const manifestPath = getNativeHostManifestPath({ ...options, platform, browser });

  if (platform === 'darwin' || platform === 'linux') {
    return {
      kind: 'file',
      browser,
      manifestPath
    };
  }

  if (platform === 'win32') {
    const metadata = getWindowsRegistryMetadata({ ...options, browser });
    return {
      kind: 'registry',
      browser: metadata.browser,
      root: metadata.root,
      registryKey: metadata.registryKey,
      manifestPath: metadata.manifestPath
    };
  }

  throwUnsupportedPlatform(platform);
}

function getNativeManifestPath(options = {}) {
  const platform = getNativeHostPlatform(options);
  const browser = getNativeHostBrowser(options);
  return getNativeHostManifestPath({ ...options, platform, browser });
}

function getNativeHostBrowser(options) {
  const browser = options.browser || 'chrome';
  return browser === 'auto' ? 'chrome' : browser;
}

function getHomeDir(options) {
  const env = options.env || process.env;
  if (getNativeHostPlatform(options) === 'win32') {
    return options.homeDir || env.USERPROFILE || env.HOME || os.homedir();
  }
  return options.homeDir || env.HOME || env.USERPROFILE || os.homedir();
}

function getWindowsLocalAppData(options) {
  const env = options.env || process.env;
  if (env.LOCALAPPDATA) {
    return env.LOCALAPPDATA;
  }
  return path.win32.join(getHomeDir(options), 'AppData', 'Local');
}

function getPathModule(options) {
  return getNativeHostPlatform(options) === 'win32' ? path.win32 : path.posix;
}

function throwUnsupportedPlatform(platform) {
  throw new Error(`Unsupported native host platform: ${platform}`);
}

function throwUnsupportedBrowser(platform, browser) {
  throw new Error(`Unsupported native host browser for ${platform}: ${browser}`);
}

module.exports = {
  getCodexOverleafHome,
  getDefaultBridgePath,
  getDefaultManagedExtensionRoot,
  getDefaultManagedNativeRoot,
  getDefaultManagedRoot,
  getDefaultRuntimeRoot,
  getHomeDir,
  getNativeHostPlatform,
  getNativeHostRegistrationTarget,
  getNativeManifestPath
};
