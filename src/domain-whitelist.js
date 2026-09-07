'use strict';
const fs = require('fs');
const path = require('path');
const { isIP } = require('net');
const { writeAtomicJson } = require('./atomic-json');

const LOGIN_DOMAINS = ['claude.ai', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com'];
const getWhitelistPath = base => path.join(base, 'domain-whitelist.json');

// Use exactly the same validation for CLI input, saved files, and matching.
// Wildcards cover the named domain and its subdomains; plain entries are exact.
function normalizeEntry(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  const host = value.startsWith('*.') ? value.slice(2) : value;
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || isIP(host) || !/[a-z]/.test(labels.at(-1))) return null;
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return value;
}

function loadWhitelist(base, log = console.warn) {
  try {
    const entries = JSON.parse(fs.readFileSync(getWhitelistPath(base), 'utf8'));
    if (!Array.isArray(entries)) throw new Error('Expected a JSON array of hostnames');
    const valid = entries.map(normalizeEntry).filter(Boolean);
    if (valid.length !== entries.length) log('[SSO] Ignored invalid saved domains');
    return [...new Set(valid)];
  } catch (error) {
    if (error.code !== 'ENOENT') log(`[SSO] Could not read trusted domains: ${error.message}`);
    return [];
  }
}

function saveWhitelist(base, entries) {
  if (!Array.isArray(entries) || entries.some(entry => !normalizeEntry(entry))) throw new Error('Invalid trusted domain');
  writeAtomicJson(getWhitelistPath(base), [...new Set(entries.map(normalizeEntry))]);
}

function entryMatches(hostname, entry) {
  const valid = normalizeEntry(entry);
  if (!valid) return false;
  const base = valid.startsWith('*.') ? valid.slice(2) : valid;
  return hostname === base || (valid.startsWith('*.') && hostname.endsWith('.' + base));
}

function isLoginUrlAllowed(raw, entries = []) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return LOGIN_DOMAINS.some(domain => entryMatches(url.hostname, '*.' + domain))
      || entries.some(entry => entryMatches(url.hostname, entry));
  } catch { return false; }
}

function guardLoginNavigation(win, entries, log = console.warn) {
  // Keep the main-process URL title; a remote page must not replace it.
  win.on('page-title-updated', event => event.preventDefault());
  const guard = (event, legacyUrl) => {
    const url = event.url || legacyUrl;
    if (!isLoginUrlAllowed(url, entries)) {
      event.preventDefault();
      log('[SSO] Blocked navigation outside trusted HTTPS login domains');
    }
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
}

// Returns an exit status when a management command was requested, otherwise null.
function runWhitelistCommand(argv, base, log = console.log) {
  const commands = argv.filter(arg => /^--whitelist-(add=|remove=|list$)/.test(arg));
  if (!commands.length) return null;
  try {
    if (commands.length !== 1) throw new Error('Use one --whitelist-add, --whitelist-remove, or --whitelist-list command');
    const command = commands[0];
    const entries = loadWhitelist(base, log);
    if (command === '--whitelist-list') {
      log(`Built-in login domains: ${LOGIN_DOMAINS.join(', ')} (including subdomains)`);
      log(`Additional trusted domains (${getWhitelistPath(base)}): ${entries.join(', ') || '(none)'}`);
    } else {
      const value = normalizeEntry(command.slice(command.indexOf('=') + 1));
      if (!value) throw new Error('Expected a hostname such as login.example.com or *.example.com');
      const updated = command.startsWith('--whitelist-add=') ? [...entries, value] : entries.filter(entry => entry !== value);
      saveWhitelist(base, updated);
      log(`Saved trusted domains to ${getWhitelistPath(base)}; applies when the next login window opens`);
    }
    return 0;
  } catch (error) { log(`[SSO] ${error.message}`); return 1; }
}

module.exports = { normalizeEntry, loadWhitelist, saveWhitelist, entryMatches, isLoginUrlAllowed,
  guardLoginNavigation, runWhitelistCommand, getWhitelistPath };
