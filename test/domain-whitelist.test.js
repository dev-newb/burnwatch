'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { normalizeEntry, loadWhitelist, saveWhitelist, isLoginUrlAllowed, guardLoginNavigation,
  runWhitelistCommand, getWhitelistPath } = require('../src/domain-whitelist');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imburning-sso-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
test('domain validation rejects broad wildcards, URLs, IPs and malformed labels', () => {
  for (const value of ['*.com', '*', 'localhost', '127.0.0.1', 'https://sso.example.com',
    'sso.example.com:443', 'user@example.com', '-bad.example.com', 'a..com', '*.*.example.com', 'a'.repeat(64) + '.com']) {
    assert.equal(normalizeEntry(value), null, value);
  }
  assert.equal(normalizeEntry(' *.Example.COM '), '*.example.com');
});
test('saved-file validation rejects the old *.com bypass', t => {
  const base = scratch(t);
  fs.writeFileSync(getWhitelistPath(base), JSON.stringify(['*.com', null, 123, '*.Example.com', 'idp.example.org']));
  assert.deepEqual(loadWhitelist(base, () => {}), ['*.example.com', 'idp.example.org']);
  assert.equal(isLoginUrlAllowed('https://attacker.com', loadWhitelist(base, () => {})), false);
  fs.writeFileSync(getWhitelistPath(base), '{broken');
  assert.deepEqual(loadWhitelist(base, () => {}), []);
});
test('login permits exact enterprise hosts and explicit subdomains with HTTPS boundaries', () => {
  const entries = ['login.example.org', '*.example.com'];
  for (const url of ['https://claude.ai/login', 'https://accounts.google.com/login', 'https://login.example.org',
    'https://example.com', 'https://a.b.example.com']) assert.equal(isLoginUrlAllowed(url, entries), true, url);
  for (const url of ['https://evilclaude.ai', 'https://claude.ai.evil.com', 'https://sub.login.example.org',
    'http://example.com', 'file:///example.com', 'https://example.com:8443', 'https://user@example.com',
    'https://example.com.evil.org', 'javascript:alert(1)']) assert.equal(isLoginUrlAllowed(url, entries), false, url);
});
test('navigation and server redirects use the same policy with current and legacy Electron events', () => {
  const webContents = new EventEmitter();
  const win = Object.assign(new EventEmitter(), {webContents});
  guardLoginNavigation(win, ['login.example.com'], () => {});
  let titlePrevented = false;
  win.emit('page-title-updated', {preventDefault() { titlePrevented = true; }});
  assert.equal(titlePrevented, true);
  for (const name of ['will-navigate', 'will-redirect']) {
    for (const legacy of [false, true]) {
      for (const [url, expected] of [['https://login.example.com', false], ['https://attacker.com', true]]) {
        let prevented = false;
        webContents.emit(name, { ...(legacy ? {} : {url}), preventDefault() { prevented = true; } }, legacy ? url : undefined);
        assert.equal(prevented, expected);
      }
    }
  }
});
test('CLI commands edit only the global trust file and reject invalid input without replacing it', t => {
  const base = scratch(t); const log = () => {};
  assert.equal(runWhitelistCommand(['--profile=work', '--whitelist-add=login.example.com'], base, log), 0);
  const before = fs.readFileSync(getWhitelistPath(base), 'utf8');
  assert.equal(runWhitelistCommand(['--whitelist-add=*.com'], base, log), 1);
  assert.equal(fs.readFileSync(getWhitelistPath(base), 'utf8'), before);
  assert.equal(runWhitelistCommand(['--whitelist-list'], base, log), 0);
  assert.deepEqual(fs.readdirSync(base), ['domain-whitelist.json']);
  assert.equal(runWhitelistCommand(['--whitelist-remove=login.example.com'], base, log), 0);
  assert.deepEqual(loadWhitelist(base), []);
  assert.equal(runWhitelistCommand(['--profile=work'], base, log), null);
});
test('failed atomic save retains existing trust and removes its temporary file', t => {
  const base = scratch(t);
  saveWhitelist(base, ['login.example.com']);
  t.mock.method(fs, 'renameSync', () => { throw new Error('denied'); });
  assert.throws(() => saveWhitelist(base, ['different.example.org']), /denied/);
  assert.deepEqual(loadWhitelist(base), ['login.example.com']);
  assert.deepEqual(fs.readdirSync(base), ['domain-whitelist.json']);
});
