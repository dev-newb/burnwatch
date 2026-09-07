'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { googleQuotaIssue, googleConnectionStatus } = require('../src/google-connection');
const { normalizeGeminiQuota } = require('../src/provider-models');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const tokens = { accessToken: 'private-test-token', refreshToken: 'private-refresh', email: 'test@example.test' };
const denied = { httpStatus: 403, error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SUBSCRIPTION_REQUIRED' }] } };

test('subscription rejection preserves sign-in without exposing credentials', () => {
  const status = googleConnectionStatus(tokens, { token: tokens.accessToken, issue: googleQuotaIssue(denied, false) });
  assert.deepEqual(status, { connected: true, email: tokens.email, usageIssue: 'subscription-required' });
  assert.doesNotMatch(JSON.stringify(status), /private|accessToken|refreshToken/);
  assert.equal(googleConnectionStatus(tokens, { token: 'previous-account', issue: 'reauth-required' }).connected, true);
  assert.equal(googleConnectionStatus(null, { token: tokens.accessToken, issue: 'subscription-required' }).connected, false);
});

test('quota status distinguishes missing data, access denial and expired authorization', () => {
  assert.equal(googleQuotaIssue(null, false), 'quota-unavailable');
  assert.equal(googleQuotaIssue({ buckets: [] }, false), 'quota-unavailable');
  assert.equal(googleQuotaIssue({ error: { details: 'malformed' } }, false), 'quota-unavailable');
  assert.equal(googleQuotaIssue({ httpStatus: 403 }, false), 'access-denied');
  const expired = googleQuotaIssue({ httpStatus: 401 }, false);
  assert.equal(expired, 'reauth-required');
  assert.equal(googleConnectionStatus(tokens, { token: tokens.accessToken, issue: expired }).connected, false);
  assert.equal(googleQuotaIssue({ buckets: [{}] }, true), null);
});

test('quota fetch reports a subscription failure without synthesizing usage; a later success recovers', async () => {
  let response = denied;
  let issue;
  const calls = [];
  const ctx = vm.createContext({ normalizeGeminiQuota, googleQuotaIssue, debugLog() {},
    postGeminiCodeAssist: async (token, method, payload) => {
      assert.equal(token, tokens.accessToken);
      calls.push({ method, payload });
      return method === 'loadCodeAssist' ? { allowedTiers: [{ id: 'standard-tier' }] } : response;
    }
  });
  vm.runInContext(main.match(/async function fetchGeminiWithToken\([^]*?\n}/)[0], ctx);
  assert.equal(await ctx.fetchGeminiWithToken(tokens.accessToken, value => { issue = value; }), null);
  assert.equal(issue, 'subscription-required');
  assert.equal(calls[1].method, 'retrieveUserQuota');
  assert.equal(Object.keys(calls[1].payload).length, 0);
  response = { buckets: [{ modelId: 'gemini-test', remainingFraction: 0.75 }] };
  const usage = await ctx.fetchGeminiWithToken(tokens.accessToken, value => { issue = value; });
  assert.equal(usage.limits[0].percent, 25);
  assert.equal(issue, null);
});

test('main page and Settings show signed-in quota failure and retain Disconnect', () => {
  const elements = Object.fromEntries(['connectRowGoogle', 'googleUsageStatus', 'googleLoginStatus',
    'disconnectGoogleBtn', 'settingsConnectGoogleBtn'].map(key => [key, { style: {}, classList: { remove() {} } }]));
  const ctx = vm.createContext({ elements, latestUsageData: null, credentials: null });
  vm.runInContext(renderer.match(/function syncGoogleAuthControls\([^]*?\n}/)[0], ctx);
  const connection = googleConnectionStatus(tokens, { token: tokens.accessToken, issue: 'subscription-required' });
  ctx.syncGoogleAuthControls({ googleConnection: connection });
  assert.equal(elements.connectRowGoogle.style.display, 'none');
  assert.equal(elements.settingsConnectGoogleBtn.style.display, 'none');
  assert.equal(elements.disconnectGoogleBtn.style.display, '');
  assert.match(elements.googleUsageStatus.textContent, /Signed in to Google.*subscription/);
  assert.equal(elements.googleLoginStatus.textContent, elements.googleUsageStatus.textContent);
  ctx.syncGoogleAuthControls({ googleConnection: googleConnectionStatus(null, null) });
  assert.equal(elements.connectRowGoogle.style.display, '');
  assert.equal(elements.settingsConnectGoogleBtn.style.display, '');
  assert.equal(elements.disconnectGoogleBtn.style.display, 'none');
  assert.equal(elements.googleUsageStatus.style.display, 'none');
  ctx.syncGoogleAuthControls({ gemini: { limits: [], connected: true }, googleConnection: {
    connected: false, usageIssue: 'reauth-required'
  } });
  assert.equal(elements.connectRowGoogle.style.display, '');
  assert.equal(elements.settingsConnectGoogleBtn.style.display, '');
  assert.match(elements.googleUsageStatus.textContent, /expired/);
});

test('a Google-only signed-in account with no quota still reaches the widget', async () => {
  const start = main.indexOf("ipcMain.handle('fetch-usage-data', async (event, options = {}) => {");
  const body = main.slice(main.indexOf('\n', start), main.indexOf('  // Kick off the Claude Code', start));
  const connection = googleConnectionStatus(tokens, { token: tokens.accessToken, issue: 'subscription-required' });
  const ctx = vm.createContext({
    sanitizeFetchOptions: x => x, readStoredSessionKey: () => null,
    store: { get: (key, fallback) => fallback, set() {} },
    cliAdoptionState: () => ({}), cachedProviderFetch: async () => null,
    fetchCodexUsage() {}, fetchGoogleUsage() {}, getGoogleConnectionStatus: () => connection,
    detectCliOffers: () => ({}), storeUsageHistory: async () => {}, applyAccountToggles() {},
    computeForecasts() {}, computeSessionPlans() {}, computeFrozenProviders() {},
    checkBurnAnomalies() {}, getBurningSeriesMap() {}, checkDailyDigest() {}, notifyGraphWindow() {}, updateTrayIcon() {}
  });
  vm.runInContext(`async function fetchUsage(options = {}) {${body}}`, ctx);
  const data = await ctx.fetchUsage();
  assert.equal(data.googleConnection.connected, true);
  assert.equal(data.googleConnection.usageIssue, 'subscription-required');
  assert.equal(data.gemini, undefined);
  assert.equal(data.anthropic_source, 'none');
});

test('a Google-only invalid_grant reaches both sign-in controls without discarding credentials', async () => {
  let storedTokens = { ...tokens, expiresAt: 1 };
  let refreshCalls = 0;
  const elements = Object.fromEntries(['connectRowGoogle', 'googleUsageStatus', 'googleLoginStatus',
    'disconnectGoogleBtn', 'settingsConnectGoogleBtn'].map(key => [key, {
      style: { display: 'none' }, classList: { remove() {} }
    }]));
  const ctx = vm.createContext({
    URLSearchParams, AbortSignal, Date, googleQuotaIssue, googleConnectionStatus, normalizeGeminiQuota,
    elements, latestUsageData: null, credentials: null, debugLog() {}, OAUTH_HTTP_TIMEOUT_MS: 15000,
    GOOGLE_OAUTH: { tokenUrl: 'https://tokens.invalid/google' },
    loadOAuthTokens: () => storedTokens,
    getGeminiOAuthClient: () => ({ id: 'test-client', secret: 'test-client-secret' }),
    fetch: async url => {
      assert.equal(url, 'https://tokens.invalid/google');
      refreshCalls++;
      return { status: 400, json: async () => ({ error: 'invalid_grant' }) };
    },
    storeOAuthTokens() { assert.fail('Failed refresh must not replace stored credentials'); },
    postGeminiCodeAssist() { assert.fail('Quota must not be fetched after authorization fails'); },
    sanitizeFetchOptions: x => x, readStoredSessionKey: () => null,
    store: { get: (key, fallback) => ['settings.showCodex', 'settings.showCodexCli'].includes(key) ? false : fallback, set() {} },
    cliAdoptionState: () => ({ google: false, anthropic: false }),
    cachedProviderFetch: async (_key, fetchProvider) => fetchProvider(),
    detectCliOffers: () => ({}), storeUsageHistory: async () => {}, applyAccountToggles() {},
    computeForecasts() {}, computeSessionPlans() {}, computeFrozenProviders() {}, checkBurnAnomalies() {},
    getBurningSeriesMap() {}, checkDailyDigest() {}, notifyGraphWindow() {}, updateTrayIcon() {}
  });
  vm.runInContext('let _googleOAuthQuotaState = null;', ctx);
  for (const name of ['getOAuthAccessToken', 'fetchGeminiWithToken', 'fetchGeminiUsage',
    'fetchGoogleUsage', 'getGoogleConnectionStatus']) {
    const match = main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
    assert.ok(match, name);
    vm.runInContext(match[0], ctx);
  }
  const start = main.indexOf("ipcMain.handle('fetch-usage-data', async (event, options = {}) => {");
  const body = main.slice(main.indexOf('\n', start), main.indexOf('  // Kick off the Claude Code', start));
  vm.runInContext(`async function fetchUsage(options = {}) {${body}}`, ctx);
  vm.runInContext(renderer.match(/function syncGoogleAuthControls\([^]*?\n}/)[0], ctx);

  const data = await ctx.fetchUsage();
  assert.equal(refreshCalls, 1);
  assert.equal(data.googleConnection.connected, false);
  assert.equal(data.googleConnection.usageIssue, 'reauth-required');
  assert.equal(data.gemini, undefined);
  assert.equal(storedTokens.accessToken, tokens.accessToken);
  assert.doesNotMatch(JSON.stringify(data), /private-test-token|private-refresh/);
  ctx.syncGoogleAuthControls(data);
  assert.equal(elements.connectRowGoogle.style.display, '');
  assert.equal(elements.settingsConnectGoogleBtn.style.display, '');
  assert.equal(elements.disconnectGoogleBtn.style.display, 'none');
  assert.match(elements.googleUsageStatus.textContent, /authorization has expired/);

  // A later explicit disconnect must not keep a stale reauthorization state.
  storedTokens = null;
  await assert.rejects(ctx.fetchUsage(), /Missing credentials/);
  assert.equal(ctx.getGoogleConnectionStatus().usageIssue, null);
});
