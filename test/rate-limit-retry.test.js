'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimitRetry, retryAfterMs } = require('../src/rate-limit-retry');

function fixture() {
  let time = Date.parse('2026-09-06T12:00:00Z');
  const waits = [];
  return { waits, now: () => time, advance: ms => { time += ms; }, retry: createRateLimitRetry({
    now: () => time, random: () => 0, sleep: async ms => { waits.push(ms); time += ms; }
  }) };
}
const limited = retryAfter => Object.assign(new Error('RateLimited: HTTP 429'), { statusCode: 429, retryAfter });

test('429 retries back off and return a later success', async () => {
  const f = fixture(); let attempts = 0;
  assert.equal(await f.retry('usage', async () => { if (++attempts < 3) throw limited(); return 42; }), 42);
  assert.deepEqual(f.waits, [2000, 4000]);
  assert.equal(attempts, 3);
});
test('Retry-After supports seconds and HTTP dates', async () => {
  const f = fixture(); let attempts = 0;
  const date = new Date(f.now() + 7000).toUTCString();
  assert.equal(retryAfterMs('6', f.now()), 6000);
  assert.equal(retryAfterMs(date, f.now()), 7000);
  assert.equal(retryAfterMs('garbage', f.now()), null);
  assert.equal(await f.retry('usage', async () => { if (!attempts++) throw limited(date); return 'ok'; }), 'ok');
  assert.deepEqual(f.waits, [7000]);
});
test('long cooldowns survive refreshes without sending another request early', async () => {
  const f = fixture(); let attempts = 0;
  const request = async () => { attempts++; throw limited('120'); };
  await assert.rejects(f.retry('usage', request), e => e.statusCode === 429);
  f.advance(15000);
  await assert.rejects(f.retry('usage', request), e => e.statusCode === 429);
  assert.equal(attempts, 1);
  assert.deepEqual(f.waits, []);
  assert.equal(await f.retry('credits', async () => 'independent'), 'independent');
  f.advance(105000);
  assert.equal(await f.retry('usage', async () => 'recovered'), 'recovered');
});
test('persistent 429s have bounded attempts and keep their final cooldown', async () => {
  const f = fixture(); let attempts = 0;
  await assert.rejects(f.retry('usage', async () => { attempts++; throw limited(); }), /RateLimited/);
  assert.equal(attempts, 3);
  assert.deepEqual(f.waits, [2000, 4000]);
  await f.retry('usage', async () => 'ok');
  assert.deepEqual(f.waits, [2000, 4000, 8000]);
});
test('authentication, challenge, invalid JSON and transport errors are not retried', async () => {
  for (const error of [Object.assign(new Error('AuthFailure'), {statusCode: 401}),
    new Error('CloudflareBlocked'), new Error('InvalidJSON'), new Error('Request timeout')]) {
    const f = fixture(); let attempts = 0;
    await assert.rejects(f.retry('usage', async () => { attempts++; throw error; }), e => e === error);
    assert.equal(attempts, 1);
    assert.deepEqual(f.waits, []);
  }
});
