'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonlHistoryStore, DAY_MS, scopeDirectoryName } = require('../src/history-store');

async function temporaryStore(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'burnwatch-history-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new JsonlHistoryStore({ baseDir: root, ...options });
  await store.init();
  return { root, store };
}

test('append and read preserve nulls and real zero', async (t) => {
  const now = Date.UTC(2026, 6, 20, 12);
  const { store } = await temporaryStore(t, { now: () => now });
  await store.append('org-a', { timestamp: now - 1000, session: 0, codex: null });
  await store.append('org-a', { timestamp: now, session: 5 });
  assert.deepEqual(await store.read('org-a', { refresh: true }), [
    { timestamp: now - 1000, session: 0, codex: null },
    { timestamp: now, session: 5 }
  ]);
});

test('read ignores malformed trailing JSONL records', async (t) => {
  const now = Date.UTC(2026, 6, 20, 12);
  const { root, store } = await temporaryStore(t, { now: () => now });
  const dir = path.join(root, scopeDirectoryName('org-a'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-07-20.jsonl'), `${JSON.stringify({ timestamp: now, weekly: 2 })}\n{"timestamp":`, 'utf8');
  assert.deepEqual(await store.read('org-a', { refresh: true }), [{ timestamp: now, weekly: 2 }]);
});

test('migration is idempotent and capped to newest retained samples', async (t) => {
  const now = Date.UTC(2026, 6, 20, 12);
  const { store } = await temporaryStore(t, { now: () => now, retentionDays: 8, maxSamples: 3 });
  const legacy = [
    { timestamp: now - 9 * DAY_MS, weekly: 1 },
    { timestamp: now - 3000, weekly: 2 },
    { timestamp: now - 2000, weekly: 3 },
    { timestamp: now - 1000, weekly: 4 },
    { timestamp: now, weekly: 5 }
  ];
  await store.migrate('org-a', legacy);
  await store.migrate('org-a', legacy);
  assert.deepEqual(await store.read('org-a', { refresh: true }), legacy.slice(-3));
});

test('retention prune removes expired day files off the append path', async (t) => {
  const now = Date.UTC(2026, 6, 20, 12);
  const { root, store } = await temporaryStore(t, { now: () => now, retentionDays: 8 });
  await store.append('org-a', { timestamp: now - 9 * DAY_MS, weekly: 1 }); // expired day file
  await store.append('org-a', { timestamp: now, weekly: 2 });
  const dir = path.join(root, scopeDirectoryName('org-a'));
  // Appends no longer prune inline — both files still exist
  assert.equal((await fs.readdir(dir)).length, 2);
  await store.pruneExpiredFiles('org-a');
  const remaining = await fs.readdir(dir);
  assert.deepEqual(remaining, ['2026-07-20.jsonl']);
  assert.deepEqual(await store.read('org-a', { refresh: true }), [{ timestamp: now, weekly: 2 }]);
});

test('same-timestamp entries with different content both survive dedupe', async (t) => {
  const now = Date.UTC(2026, 6, 20, 12);
  const { store } = await temporaryStore(t, { now: () => now });
  await store.append('org-a', { timestamp: now, weekly: 1 });
  await store.append('org-a', { timestamp: now, weekly: 2 });
  await store.append('org-a', { timestamp: now, weekly: 1 }); // exact duplicate — collapsed
  assert.deepEqual(await store.read('org-a', { refresh: true }), [
    { timestamp: now, weekly: 1 },
    { timestamp: now, weekly: 2 }
  ]);
});

test('organization scopes remain isolated', async (t) => {
  const now = Date.UTC(2026, 6, 20, 12);
  const { store } = await temporaryStore(t, { now: () => now });
  await store.append('org-a', { timestamp: now, weekly: 1 });
  await store.append('org-b', { timestamp: now, weekly: 2 });
  assert.equal((await store.read('org-a'))[0].weekly, 1);
  assert.equal((await store.read('org-b'))[0].weekly, 2);
});

test('replacement keeps the old files when a staged write runs out of space', async t => {
  const now = Date.now();
  const { store } = await temporaryStore(t, { now: () => now });
  const old = { timestamp: now - 1000, session: 12 };
  await store.append('org-a', old);
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).includes('.staging-') && String(file).endsWith('.jsonl')) {
      handle.writeFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    }
    return handle;
  });
  await assert.rejects(store.replace('org-a', [{ timestamp: now, session: 99 }]), /disk full/);
  assert.deepEqual(await store.read('org-a', { refresh: true }), [old]);
  assert.deepEqual(await fs.readdir(store.baseDir), [scopeDirectoryName('org-a')]);
});

test('replacement validates staged contents before touching the old directory', async t => {
  const now = Date.now();
  const { store } = await temporaryStore(t, { now: () => now });
  const old = { timestamp: now - 1000, weekly: 12 };
  await store.append('org-a', old);
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    const text = await readFile(file, ...args);
    return String(file).includes('.staging-') ? text.slice(0, -2) : text;
  });
  await assert.rejects(store.replace('org-a', [{ timestamp: now, weekly: 99 }]), /validation failed/);
  assert.deepEqual(await store.read('org-a', { refresh: true }), [old]);
});

test('a failed publication rename rolls back the complete previous history', async t => {
  const now = Date.now();
  const { store } = await temporaryStore(t, { now: () => now });
  const old = { timestamp: now - 1000, weekly: 12 };
  await store.append('org-a', old);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (String(from).includes('.staging-')) throw new Error('publish failed');
    return rename(from, to);
  });
  await assert.rejects(store.replace('org-a', [{ timestamp: now, weekly: 99 }]), /publish failed/);
  assert.deepEqual(await store.read('org-a', { refresh: true }), [old]);
  assert.deepEqual(await fs.readdir(store.baseDir), [scopeDirectoryName('org-a')]);
});

test('failed publication fsync rolls back before reporting failure', { skip: process.platform === 'win32' }, async t => {
  const now = Date.now();
  const { store } = await temporaryStore(t, { now: () => now });
  const old = { timestamp: now - 1000, weekly: 12 };
  await store.append('org-a', old);
  const rename = fs.rename;
  let published = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (String(from).includes('.staging-')) published = true;
  });
  const open = fs.open;
  let failed = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === store.baseDir && published && !failed) {
      handle.sync = async () => { failed = true; throw new Error('flush failed'); };
    }
    return handle;
  });
  await assert.rejects(store.replace('org-a', [{ timestamp: now, weekly: 99 }]), /flush failed/);
  assert.equal(failed, true);
  assert.deepEqual(await store.read('org-a', { refresh: true }), [old]);
});

test('startup recovers a crash between directory renames and keeps a completed publication', async t => {
  const now = Date.now();
  for (const published of [false, true]) {
    const { root, store } = await temporaryStore(t, { now: () => now });
    const old = { timestamp: now - 1000, weekly: 12 };
    const replacement = { timestamp: now, weekly: 99 };
    await store.append('org-a', old);
    const dir = store.scopeDir('org-a');
    await fs.rename(dir, `${dir}.previous`);
    if (published) {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, `${new Date(now).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(replacement)}\n`);
    }
    const restarted = new JsonlHistoryStore({ baseDir: root, now: () => now });
    assert.deepEqual(await restarted.read('org-a'), [published ? replacement : old]);
    const next = { timestamp: now + 1000, weekly: 45 };
    await restarted.append('org-a', next);
    assert.deepEqual(await restarted.read('org-a', { refresh: true }), [published ? replacement : old, next]);
  }
});

test('a failed rollback keeps the backup recoverable by the next read', async t => {
  const now = Date.now();
  const { store } = await temporaryStore(t, { now: () => now });
  const old = { timestamp: now - 1000, weekly: 12 };
  await store.append('org-a', old);
  const rename = fs.rename;
  const failure = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(from).includes('.staging-') || String(from).endsWith('.previous')) throw new Error('I/O failure');
    return rename(from, to);
  });
  await assert.rejects(store.replace('org-a', [{ timestamp: now, weekly: 99 }]), /replacement and rollback failed/);
  failure.mock.restore();
  assert.deepEqual(await store.read('org-a', { refresh: true }), [old]);
});

test('replacement, migration, append and disk reads serialize within one scope', async t => {
  const now = Date.now();
  const { store } = await temporaryStore(t, { now: () => now });
  const one = { timestamp: now - 2000, weekly: 1 };
  const two = { timestamp: now - 1000, weekly: 2 };
  const three = { timestamp: now, weekly: 3 };
  const replacement = store.replace('org-a', [one]);
  const migration = store.migrate('org-a', [two]);
  const append = store.append('org-a', three);
  const snapshot = store.read('org-a', { refresh: true });
  await Promise.all([replacement, migration, append]);
  assert.deepEqual(await snapshot, [one, two, three]);
  assert.deepEqual(await store.read('org-a', { refresh: true }), [one, two, three]);
});
