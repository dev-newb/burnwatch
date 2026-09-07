'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const fn = name => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];
function harness() {
  const sounds = [], notifications = [];
  const ctx = vm.createContext({
    Date, Set, Map, credentials: {}, EXTRA_ROW_CONFIG: {},
    window: { _cachedSettings: { usageAlerts: true }, electronAPI: {
      showNotification: (...args) => notifications.push(args), sendAlertWebhook() {}
    } },
    playAlertSound: kind => sounds.push(kind), formatResetsAt: () => 'later',
    warnThreshold: 80, dangerThreshold: 90
  });
  vm.runInContext(`let _alertAccounts = {}, _prevBurningKeys = new Set(), _burnWatchSeeded = false;
    let _resetWatch = null, _resetBank = null, _blockedKeys = null, isFirstDataLoad = true;
    const EARLY_RESET_FROM = 5, EARLY_RESET_TO = 1, alertFired = {};\n` +
    ['alertAccountIdentities', 'alertPoolAccount', 'resetAccountAlertBaseline', 'checkAccountAlerts',
      'computeBurningRowKeys', 'checkBurnSpikeSound', 'resetWatchPools', 'checkEarlyResets',
      'seedAlertFlags', 'checkUsageAlerts'].map(fn).join('\n'), ctx);
  return { ctx, sounds, notifications, feed: data => ctx.checkAccountAlerts(data),
    clear() { sounds.length = 0; notifications.length = 0; } };
}
const account = (id, percent, available = 0, connected = false) => ({ accountId: id, connected,
  source: 'live', email: id + '@example.test', resetCredits: { available },
  limits: [{ key: 'primary_seven_day', label: 'Codex (7d)', percent,
    resetsAt: new Date(Date.now() + 86400000).toISOString() }] });

test('connecting desktop after CLI silently seeds existing bank, exhaustion and burning state', () => {
  const h = harness();
  h.feed({ codex: account('cli', 56) });
  const data = { codex: { ...account('desktop', 100, 3, true), cli: account('cli', 56) }, burningSeries: { codex: true } };
  h.feed(data); h.feed(data);
  assert.deepEqual(h.sounds, []); assert.deepEqual(h.notifications, []);
  h.feed({ ...data, codex: { ...data.codex, resetCredits: { available: 4 } } });
  assert.deepEqual(h.sounds, ['banked']);
});

test('account swaps cannot produce reset, wall, banked or available catchup alerts', () => {
  for (const [from, to] of [[account('a', 100, 0), account('b', 0, 3)],
    [account('a', 30, 0), account('b', 100, 3)]]) {
    const h = harness(); h.feed({ codex: from }); h.feed({ codex: to });
    assert.deepEqual(h.sounds, []); assert.deepEqual(h.notifications, []);
  }
});

test('same-account transitions still announce banked resets, early resets, walls and recovery', () => {
  const h = harness();
  h.feed({ codex: account('a', 56, 0) });
  h.feed({ codex: account('a', 100, 0) });
  assert.deepEqual(h.sounds, ['wall']); assert.equal(h.notifications.length, 1);
  h.clear(); h.feed({ codex: account('a', 0, 0) });
  assert.deepEqual(h.sounds, ['reset']); assert.match(h.notifications[0][1], /available again/);
  h.clear(); h.feed({ codex: account('a', 0, 1) });
  assert.deepEqual(h.sounds, ['banked']);
});

test('disconnects, missing data, delayed first quotas and re-adoption are quiet', () => {
  for (const missing of [{}, { codex: { ...account('a', 0), limits: [] } }]) {
    const h = harness(); h.feed({ codex: account('a', 100, 0) });
    h.feed(missing); h.feed({ codex: account('a', 0, 3), burningSeries: { codex: true } });
    assert.deepEqual(h.sounds, []); assert.deepEqual(h.notifications, []);
  }
  const h = harness(); h.feed({ codex: account('a', 50, 0) });
  h.ctx.resetAccountAlertBaseline('openai');
  h.feed({ codex: account('a', 100, 3) });
  assert.deepEqual(h.sounds, []); assert.deepEqual(h.notifications, []);
});

test('connecting another provider leaves existing account alerts active', () => {
  const h = harness(); h.feed({ codex: account('a', 55, 0) });
  h.ctx.resetAccountAlertBaseline('google');
  h.feed({ codex: account('a', 100, 0), gemini: account('g', 100), burningSeries: { gemini: true } });
  assert.deepEqual(h.sounds, ['wall']); assert.equal(h.notifications.length, 1);
});

test('CLI account switches are quiet without muting a continuing desktop account', () => {
  const h = harness();
  h.feed({ codex: { ...account('desktop', 50, 0, true), cli: account('cli-a', 50) } });
  h.feed({ codex: { ...account('desktop', 100, 0, true), cli: account('cli-b', 100) } });
  assert.deepEqual(h.sounds, ['wall']); assert.equal(h.notifications.length, 1);
  assert.doesNotMatch(h.notifications[0][0], /CLI/);
});

test('Claude account changes seed threshold notifications and sound baselines', () => {
  const h = harness();
  const claude = (email, pct) => ({ anthropic_email: email, anthropic_source: 'web',
    five_hour: { utilization: pct, resets_at: new Date(Date.now() + 86400000).toISOString() } });
  h.feed(claude('a@example.test', 30)); h.feed(claude('b@example.test', 100));
  assert.deepEqual(h.sounds, []); assert.deepEqual(h.notifications, []);
});

test('second-account emails are visible, use textContent, hide and clear with account settings', () => {
  const elements = {};
  for (const id of ['emailAnthropic', 'emailOpenai', 'emailGoogle', 'emailOpenaiCli', 'emailGoogleCli']) {
    const text = { textContent: '' };
    elements[id] = { style: {}, textContent: '', title: '', querySelector: () => text };
  }
  const ctx = vm.createContext({ document: { getElementById: id => elements[id] }, window: { _cachedSettings: {} } });
  vm.runInContext(fn('renderAccountEmails'), ctx);
  const data = { codex: { email: 'desktop@example.test', cli: { email: '<cli@example.test>' } } };
  ctx.renderAccountEmails(data);
  assert.equal(elements.emailOpenaiCli.textContent, '<cli@example.test>');
  assert.equal(elements.emailOpenaiCli.style.display, '');
  assert.equal(elements.emailOpenai.querySelector().textContent, 'desktop@example.test');
  ctx.window._cachedSettings.hideAccountEmails = true; ctx.renderAccountEmails(data);
  assert.equal(elements.emailOpenaiCli.style.display, 'none');
  assert.equal(elements.emailOpenaiCli.textContent, ''); assert.equal(elements.emailOpenaiCli.title, '');
  ctx.window._cachedSettings.hideAccountEmails = false; ctx.renderAccountEmails({});
  assert.equal(elements.emailOpenaiCli.style.display, 'none');
});
