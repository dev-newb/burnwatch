'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { configureWindowsIdentity, defaultIdentity } = require('../src/windows-identity');

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'imburning-taskbar-'));
  t.after(() => fs.rmSync(userData, {recursive: true, force: true}));
  const applied = [];
  return { applied, options: {app: {setAppUserModelId: id => applied.push(id)}, userData,
    platform: 'win32', argv: [], log() {}} };
}
test('default identity matches packaging and profile identities are stable and bounded', () => {
  assert.equal(defaultIdentity(''), require('../package.json').build.appId);
  assert.equal(defaultIdentity('work'), defaultIdentity('work'));
  assert.notEqual(defaultIdentity('work'), defaultIdentity('personal'));
  assert.ok(defaultIdentity('x'.repeat(500)).length < 80);
});
test('reset persists only the selected profile and is applied on its next launch', t => {
  const f = fixture(t); const options = {...f.options, profile: 'work', userData: path.join(f.options.userData, 'profiles', 'work')};
  assert.equal(configureWindowsIdentity({...options, argv: ['--reset-aumid']}), 0);
  assert.deepEqual(f.applied, []);
  configureWindowsIdentity(options);
  const first = f.applied.at(-1);
  assert.ok(first.startsWith(defaultIdentity('work') + '.reset.'));
  configureWindowsIdentity(options);
  assert.equal(f.applied.at(-1), first);
  configureWindowsIdentity({...options, argv: ['--reset-taskbar-identity']});
  configureWindowsIdentity(options);
  assert.notEqual(f.applied.at(-1), first);
  configureWindowsIdentity(f.options);
  assert.equal(f.applied.at(-1), defaultIdentity(''));
  assert.deepEqual(fs.readdirSync(f.options.userData), ['profiles']);
});
test('malformed or unrelated overrides fall back without deleting the saved bytes', t => {
  const f = fixture(t); const file = path.join(f.options.userData, 'aumid-override.json');
  for (const data of ['broken', '{"aumid":"other.application"}', JSON.stringify({aumid: defaultIdentity('') + '.reset.' + 'a'.repeat(130)})]) {
    fs.writeFileSync(file, data);
    configureWindowsIdentity(f.options);
    assert.equal(f.applied.at(-1), defaultIdentity(''));
    assert.equal(fs.readFileSync(file, 'utf8'), data);
  }
});
test('reset on non-Windows systems exits without writing or invoking Windows APIs', t => {
  const f = fixture(t);
  assert.equal(configureWindowsIdentity({...f.options, platform: 'darwin', argv: ['--reset-aumid']}), 0);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(fs.readdirSync(f.options.userData), []);
});
test('failed reset returns failure and preserves the previous override', t => {
  const f = fixture(t);
  configureWindowsIdentity({...f.options, argv: ['--reset-aumid']});
  const file = path.join(f.options.userData, 'aumid-override.json');
  const before = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('denied'); });
  assert.equal(configureWindowsIdentity({...f.options, argv: ['--reset-aumid']}), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
