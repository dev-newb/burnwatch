'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

function scopeDirectoryName(scope) {
  return crypto.createHash('sha256').update(String(scope || 'default')).digest('hex').slice(0, 32);
}

function dayName(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function validEntry(entry) {
  return !!entry && typeof entry === 'object' && Number.isFinite(entry.timestamp);
}

async function syncDirectory(dir) {
  // Windows does not expose directory fsync through Node. Individual files
  // are still flushed before the rename on every platform.
  if (process.platform === 'win32') return;
  const handle = await fsp.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function dedupeEntries(entries) {
  // Bucket by timestamp so the expensive JSON comparison only runs for the
  // rare colliding samples instead of stringifying every retained entry on
  // every append.
  const byTimestamp = new Map();
  for (const entry of entries) {
    if (!validEntry(entry)) continue;
    const bucket = byTimestamp.get(entry.timestamp);
    if (!bucket) {
      byTimestamp.set(entry.timestamp, [entry]);
      continue;
    }
    const json = JSON.stringify(entry);
    if (!bucket.some((existing) => JSON.stringify(existing) === json)) bucket.push(entry);
  }
  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, bucket]) => bucket);
}

class JsonlHistoryStore {
  constructor({ baseDir, retentionDays = 8, maxSamples = 10000, now = () => Date.now(), logger = () => {} }) {
    if (!baseDir) throw new Error('History baseDir is required');
    this.baseDir = baseDir;
    this.retentionDays = retentionDays;
    this.maxSamples = maxSamples;
    this.now = now;
    this.logger = logger;
    this.cache = new Map();
    this.queues = new Map();
  }

  async init() {
    await fsp.mkdir(this.baseDir, { recursive: true });
  }

  scopeDir(scope) {
    return path.join(this.baseDir, scopeDirectoryName(scope));
  }

  _retain(entries) {
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    return dedupeEntries(entries)
      .filter((entry) => entry.timestamp > cutoff)
      .slice(-this.maxSamples);
  }

  getCached(scope) {
    return this.cache.get(String(scope || 'default')) || [];
  }

  _enqueue(scope, work) {
    const key = String(scope || 'default');
    const operation = (this.queues.get(key) || Promise.resolve()).then(work);
    this.queues.set(key, operation.catch(() => {}));
    return operation;
  }

  async _recoverScope(scope) {
    const dir = this.scopeDir(scope);
    try {
      await fsp.access(dir);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // A crash between the two renames leaves the complete old directory here.
    try {
      await fsp.rename(`${dir}.previous`, dir);
      await syncDirectory(this.baseDir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async read(scope, { refresh = false } = {}) {
    return this._enqueue(scope, () => this._read(scope, { refresh }));
  }

  async _read(scope, { refresh = false } = {}) {
    const cacheKey = String(scope || 'default');
    if (!refresh && this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    await this.init();
    await this._recoverScope(scope);
    const dir = this.scopeDir(scope);
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const entries = [];
    for (const file of files) {
      let text;
      try {
        text = await fsp.readFile(path.join(dir, file), 'utf8');
      } catch (error) {
        this.logger('[History] Failed to read', file, error.message);
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (validEntry(entry)) entries.push(entry);
        } catch (error) {
          this.logger('[History] Ignoring malformed JSONL record in', file, error.message);
        }
      }
    }

    const retained = this._retain(entries);
    this.cache.set(cacheKey, retained);
    // No inline pruning: file retention belongs to the owner's scheduled
    // pruneExpiredFiles() calls, never to the read/append hot paths.
    return retained;
  }

  async append(scope, entry) {
    if (!validEntry(entry)) throw new Error('History entry requires a finite timestamp');
    const cacheKey = String(scope || 'default');
    return this._enqueue(scope, async () => {
      await this.init();
      await this._recoverScope(scope);
      const dir = this.scopeDir(scope);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.appendFile(path.join(dir, `${dayName(entry.timestamp)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
      const current = this.cache.has(cacheKey) ? this.cache.get(cacheKey) : await this._read(scope);
      const retained = this._retain([...current, entry]);
      this.cache.set(cacheKey, retained);
      // Deliberately NO pruneExpiredFiles here: file retention runs on the
      // owner's schedule (startup + a timer), off the awaited refresh path.
      return retained;
    });
  }

  async replace(scope, entries) {
    return this._enqueue(scope, () => this._replace(scope, entries));
  }

  async _replace(scope, entries) {
    await this.init();
    await this._recoverScope(scope);
    const dir = this.scopeDir(scope);
    const backup = `${dir}.previous`;
    const retained = this._retain(entries);
    const grouped = new Map();
    for (const entry of retained) {
      const day = dayName(entry.timestamp);
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day).push(entry);
    }

    const staging = await fsp.mkdtemp(`${dir}.staging-`);
    let backedUp = false;
    let published = false;
    let cleanupStaging = true;
    try {
      for (const [day, dayEntries] of grouped) {
        const target = path.join(staging, `${day}.jsonl`);
        const body = `${dayEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
        const file = await fsp.open(target, 'wx', 0o600);
        try {
          await file.writeFile(body, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        if (await fsp.readFile(target, 'utf8') !== body) {
          throw new Error(`History replacement validation failed for ${day}`);
        }
      }
      await syncDirectory(staging);
      // The live directory is still intact while the replacement is written,
      // flushed and checked. Only an older completed backup may be removed.
      await fsp.rm(backup, { recursive: true, force: true });
      try {
        await fsp.rename(dir, backup);
        backedUp = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await syncDirectory(this.baseDir);
      await fsp.rename(staging, dir);
      published = true;
      await syncDirectory(this.baseDir);
    } catch (error) {
      this.cache.delete(String(scope || 'default'));
      if (backedUp) {
        try {
          if (published) await fsp.rename(dir, staging);
          await fsp.rename(backup, dir);
          await syncDirectory(this.baseDir);
        } catch (rollbackError) {
          // Keep both recoverable copies if even rollback encounters an I/O
          // failure. The next disk operation restores .previous if needed.
          cleanupStaging = false;
          throw new AggregateError([error, rollbackError], 'History replacement and rollback failed');
        }
      }
      throw error;
    } finally {
      if (cleanupStaging) await fsp.rm(staging, { recursive: true, force: true })
        .catch(error => this.logger('[History] Staging cleanup failed:', error.message));
    }
    this.cache.set(String(scope || 'default'), retained);
    await fsp.rm(backup, { recursive: true, force: true })
      .catch(error => this.logger('[History] Backup cleanup failed:', error.message));
    return retained;
  }

  async migrate(scope, legacyEntries) {
    return this._enqueue(scope, async () => {
      const existing = await this._read(scope, { refresh: true });
      return this._replace(scope, [...existing, ...(legacyEntries || [])]);
    });
  }

  async pruneExpiredFiles(scope) {
    return this._enqueue(scope, () => this._pruneExpiredFiles(scope));
  }

  async _pruneExpiredFiles(scope) {
    await this._recoverScope(scope);
    const dir = this.scopeDir(scope);
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const cutoffDay = dayName(this.now() - this.retentionDays * DAY_MS);
    for (const file of files) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (match && match[1] < cutoffDay) await fsp.unlink(path.join(dir, file));
    }
  }
}

module.exports = {
  DAY_MS,
  JsonlHistoryStore,
  scopeDirectoryName,
  dayName,
  validEntry,
  dedupeEntries
};
