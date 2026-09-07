'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { quarantineUnreadableConfig } = require('../src/config-migration');
const { JsonlHistoryStore } = require('../src/history-store');
const mainPath = path.join(__dirname, '../main.js');
const main = fs.readFileSync(mainPath, 'utf8');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('named profiles isolate migration and history using the final userData path', async t => {
  const dir = scratch(t);
  const primaryConfig = path.join(dir, 'config.json');
  // A named profile must not even quarantine the primary profile's old bytes.
  fs.writeFileSync(primaryConfig, 'primary encrypted config');
  const scopes = [];
  for (const profile of ['one', 'two']) {
    let userData = dir;
    const profileLogs = [];
    const ctx = vm.createContext({
      app: { getPath: () => userData, setPath: (_, value) => { userData = value; }, setAppUserModelId() {} },
      process: { argv: [`--profile=${profile}`], platform: process.platform }, path, require: createRequire(mainPath),
      console: { log: message => profileLogs.push(message) },
      JsonlHistoryStore, HISTORY_RETENTION_DAYS: 8, MAX_HISTORY_SAMPLES: 10000, debugLog() {}
    });
    const startup = main.slice(main.indexOf('// Profile isolation'), main.indexOf('// Non-sensitive settings storage'));
    const history = main.match(/const historyStore = new JsonlHistoryStore\([^]*?\n}\);/)[0];
    vm.runInContext('(function () {\n' + startup + '\n' + history + '\nglobalThis.paths = { configPath, historyStore };\n})();', ctx);
    assert.equal(ctx.paths.configPath, path.join(dir, 'profiles', profile, 'config.json'));
    assert.deepEqual(profileLogs, [`[Profile] Using profile "${profile}" -> userData: ${path.join(dir, 'profiles', profile)}`]);
    const store = ctx.paths.historyStore;
    await store.append('org', { timestamp: Date.now(), session: profile === 'one' ? 10 : 20 });
    scopes.push(store.scopeDir('org'));
    assert.equal((await store.read('org')).length, 1);
  }
  assert.notEqual(scopes[0], scopes[1]);
  assert.equal(fs.readFileSync(primaryConfig, 'utf8'), 'primary encrypted config');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'profiles']);
});

test('config recovery preserves invalid bytes and leaves valid settings untouched', t => {
  const config = path.join(scratch(t), 'config.json');
  for (const data of ['old\u0000ciphertext', '{"partial":', '[]']) {
    fs.writeFileSync(config, data);
    const backup = quarantineUnreadableConfig(config, () => {});
    assert.match(backup, /config\.json\.broken-\d+/);
    assert.equal(fs.readFileSync(backup, 'utf8'), data);
    assert.equal(fs.existsSync(config), false);
  }
  fs.writeFileSync(config, '{"setting":true}');
  assert.equal(quarantineUnreadableConfig(config), null);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"setting":true}');
});

test('an unreadable config is moved aside; a failed move never deletes it', t => {
  const config = path.join(scratch(t), 'config.json');
  fs.writeFileSync(config, 'preserve me');
  t.mock.method(fs, 'readFileSync', () => { throw new Error('read denied'); });
  const originalRename = fs.renameSync;
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('move denied'); });
  assert.throws(() => quarantineUnreadableConfig(config, () => {}), /move denied/);
  assert.equal(fs.existsSync(config), true);
  rename.mock.restore();
  assert.equal(fs.renameSync, originalRename);
  const backup = quarantineUnreadableConfig(config, () => {});
  assert.equal(fs.existsSync(backup), true);
});
