'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { createRequire } = require('module');
const mainPath = path.join(__dirname, '../main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const localRequire = createRequire(mainPath);

test('management commands exit before migration, stores, locks or windows can affect an account', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'imburning-startup-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, 'old encrypted settings must remain untouched');
  for (const [argv, platform] of [
    [['--profile=work', '--whitelist-add=login.example.com'], 'darwin'],
    [['--profile=work', '--reset-aumid'], 'win32'],
    [['--profile=personal', '--reset-aumid'], 'darwin']
  ]) {
    let userData = base; const exits = [];
    const app = {getPath: () => userData, setPath: (_, value) => {userData = value;}, exit: code => exits.push(code)};
    const ctx = vm.createContext({process: {argv, platform}, console: {log() {}, warn() {}},
      require: name => {
        if (name === 'electron') return {app};
        if (name === 'electron-store') return class {constructor() {throw new Error('Store must not open');}};
        return localRequire(name);
      }});
    vm.runInContext('(function () {\n' + source + '\n})();', ctx);
    assert.deepEqual(exits, [0]);
    assert.equal(fs.readFileSync(config, 'utf8'), 'old encrypted settings must remain untouched');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'domain-whitelist.json'), 'utf8')), ['login.example.com']);
  assert.ok(fs.existsSync(path.join(base, 'profiles/work/aumid-override.json')));
  assert.equal(fs.existsSync(path.join(base, 'profiles/personal')), false);
  assert.deepEqual(fs.readdirSync(base).sort(), ['config.json', 'domain-whitelist.json', 'profiles']);
});

test('packaged startup works when electron-builder removes build metadata', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'imburning-packaged-startup-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const metadata = {...localRequire('./package.json')};
  delete metadata.build;
  const exits = [];
  const ctx = vm.createContext({process: {argv: ['--whitelist-list'], platform: 'darwin'},
    console: {log() {}, warn() {}}, require: name => {
      if (name === 'electron') return {app: {getPath: () => base, exit: code => exits.push(code)}};
      if (name === './package.json') return metadata;
      if (name === 'electron-store') return class {constructor() {throw new Error('No stores during this startup probe');}};
      return localRequire(name);
    }});
  vm.runInContext('(function () {\n' + source + '\n})();', ctx);
  assert.deepEqual(exits, [0]);
  const releaseSource = source.match(/const GITHUB_OWNER = [^]*?const GITHUB_REPO = [^;]+;/)[0];
  const release = vm.runInNewContext(releaseSource + '\n({owner:GITHUB_OWNER, repo:GITHUB_REPO})');
  const {owner, repo} = localRequire('./package.json').build.publish[0];
  assert.deepEqual({...release}, {owner, repo});
});
