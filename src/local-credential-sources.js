'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const WSL_COMMAND_TIMEOUT_MS = 3000;
// Utility distros (Docker Desktop plumbing and friends) never hold user CLI
// logins, and probing them cold-boots their VMs — skip them outright.
const UTILITY_DISTRO_PATTERN = /^(docker-desktop|rancher-desktop|podman-machine)/i;
// Discovery is deliberately sticky: `wsl.exe -d <distro> printenv` BOOTS a
// stopped distro, so the scan runs once and is refreshed only by an explicit
// clearCredentialHomeCache() (app start / the local-login rescan button).
let cachedHomes = null;

function decodeWslListOutput(stdout) {
  if (!stdout) return '';
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (!buffer.length) return '';
  const zeroBytes = [...buffer.subarray(0, Math.min(buffer.length, 128))]
    .filter((byte) => byte === 0).length;
  const encoding = zeroBytes >= 2 ? 'utf16le' : 'utf8';
  return buffer.toString(encoding).replace(/^\uFEFF/, '').replace(/\0/g, '');
}

function parseWslDistros(stdout) {
  return decodeWslListOutput(stdout)
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name && !/[\\/\0]/.test(name));
}

function linuxHomeToUnc(distro, linuxHome) {
  const cleanHome = String(linuxHome || '').trim();
  if (!distro || /[\\/\0]/.test(distro)) return null;
  if (!cleanHome.startsWith('/') || cleanHome.includes('\0')) return null;
  const parts = cleanHome.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  return `\\\\wsl.localhost\\${distro}\\${parts.join('\\')}`;
}

function discoverWslHomes({ spawnSyncImpl = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const listed = spawnSyncImpl('wsl.exe', ['--list', '--quiet'], {
    encoding: null,
    windowsHide: true,
    timeout: WSL_COMMAND_TIMEOUT_MS
  });
  if (listed.error || listed.status !== 0) return [];

  const homes = [];
  for (const distro of parseWslDistros(listed.stdout)) {
    if (UTILITY_DISTRO_PATTERN.test(distro)) continue;
    const result = spawnSyncImpl('wsl.exe', ['-d', distro, '--', 'printenv', 'HOME'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WSL_COMMAND_TIMEOUT_MS
    });
    if (result.error || result.status !== 0) continue;
    const home = linuxHomeToUnc(distro, result.stdout);
    if (home) homes.push({ id: `wsl:${distro}`, kind: 'wsl', distro, home });
  }
  return homes;
}

function discoverCredentialHomes({
  force = false,
  homedir,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  pathImpl = path
} = {}) {
  const localHome = homedir || require('os').homedir();
  const mayUseCache = !force && !homedir && platform === process.platform
    && spawnSyncImpl === spawnSync && pathImpl === path;
  if (mayUseCache && cachedHomes) {
    return cachedHomes.map((entry) => ({ ...entry }));
  }

  const homes = [
    { id: 'windows', kind: platform === 'win32' ? 'windows' : 'local', home: pathImpl.resolve(localHome) },
    ...discoverWslHomes({ spawnSyncImpl, platform })
  ];
  if (mayUseCache) {
    cachedHomes = homes;
  }
  return homes.map((entry) => ({ ...entry }));
}

function clearCredentialHomeCache() {
  cachedHomes = null;
}

module.exports = {
  decodeWslListOutput,
  parseWslDistros,
  linuxHomeToUnc,
  discoverWslHomes,
  discoverCredentialHomes,
  clearCredentialHomeCache,
  UTILITY_DISTRO_PATTERN
};
