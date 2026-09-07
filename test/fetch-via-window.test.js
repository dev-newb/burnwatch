'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('hidden-window response parsing distinguishes JSON from provider block pages', () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  let parseResponseBody;
  try {
    ({ parseResponseBody } = require('../src/fetch-via-window'));
  } finally {
    Module._load = originalLoad;
  }

  assert.deepEqual(parseResponseBody('{"ok":true}'), { ok: true });
  assert.throws(() => parseResponseBody('<html>Just a moment</html>'), /CloudflareBlocked|UnexpectedHTML/);
  assert.throws(() => parseResponseBody('not json'), /InvalidJSON/);
});

test('status-aware classification turns 401/403 into explicit auth failures', () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  let classifyFetchResult;
  try {
    ({ classifyFetchResult } = require('../src/fetch-via-window'));
  } finally {
    Module._load = originalLoad;
  }

  assert.throws(() => classifyFetchResult({ status: 401, bodyText: '{}' }), (err) => err.statusCode === 401);
  assert.throws(() => classifyFetchResult({ status: 403, bodyText: '{"error":"denied"}' }), (err) => err.statusCode === 403);
  assert.deepEqual(classifyFetchResult({ status: 200, bodyText: '{"ok":1}' }), { ok: 1 });
  assert.deepEqual(classifyFetchResult({ status: 200, bodyText: '{"message":"rate limit remaining"}' }), { message: 'rate limit remaining' });
  for (const bodyText of ['Too many requests', '{"error":{"type":"rate_limit_error","message":"Please retry later"}}']) {
    assert.throws(() => classifyFetchResult({status: 429, bodyText, retryAfter: '30'}), error =>
      error.statusCode === 429 && error.retryAfter === '30');
  }
  assert.throws(() => classifyFetchResult({status: 429, bodyText: '<html>Just a moment'}), /CloudflareBlocked/);
  assert.throws(() => classifyFetchResult({status: 200, bodyText: '{"error":{"type":"rate_limit_error","message":"Please retry later"}}'}), error => error.statusCode === 429);
  assert.throws(() => classifyFetchResult({ status: 200, bodyText: '<html>Just a moment' }), /CloudflareBlocked/);
  const { isExplicitAuthFailure } = require('../src/usage-math');
  for (const result of [
    {status:403,bodyText:'<html>Just a moment</html>'},
    {status:401,bodyText:'Enable JavaScript and cookies to continue'},
    {status:401,bodyText:'broken response'},
    {status:429,bodyText:'{"error":"rate limited"}'},
    {status:500,bodyText:'{"error":"server error"}'}
  ]) {
    assert.throws(() => classifyFetchResult(result), error => !isExplicitAuthFailure(error));
  }
});
