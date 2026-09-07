'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const helpers = require('../src/account-history');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const fn = name => main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];

test('history account boundaries are stable, private and separate CLI from desktop', () => {
  const account = { email: '  CLI@Example.Test ', connected: false, source: 'live', limits: [{}] };
  const a = helpers.usageAccountIdentities({ codex: { ...account, accountId: 'desktop', cli: account } });
  const b = helpers.usageAccountIdentities({ codex: { ...account, email: 'cli@example.test' } });
  assert.match(a.codex, /^[a-f0-9]{64}$/); assert.equal(a.codexCli, b.codex);
  assert.notEqual(a.codex, a.codexCli); assert.doesNotMatch(JSON.stringify(a), /example|desktop/);
  assert.deepEqual(helpers.usageAccountIdentities({ codex: { limits: [{}] } }), {});
});

test('burn history stops at switches, reconnects and legacy samples', () => {
  const rows = ['a', 'a', 'b', 'b', null, 'b', 'b'].map((id, i) => ({timestamp:i,
    accountIdentities:id ? {codex:id} : {}, codex:20}));
  assert.deepEqual(helpers.sameAccountHistory(rows, 'codex'), rows.slice(-2));
  assert.deepEqual(helpers.sameAccountHistory(rows.slice(0,5), 'codex'), []);
  assert.deepEqual(helpers.sameAccountHistory(rows.slice(0,4), 'codex'), rows.slice(2,4));
  assert.equal(helpers.sameAccountHistory(rows, 'weekly'), rows);
});

test('actual backend burn detector cannot beep on an account swap; later burn still alerts', () => {
  const now = Date.now(), sounds = [], notifications = [];
  let history = [];
  const ctx = vm.createContext({ ...helpers, _burningSeries: {}, _burnAlertAt: {}, _burnAccountIdentities: {},
    BURN_WINDOW_MS:600000, BURN_MIN_WINDOW_MS:240000, BURN_MIN_JUMP:3, BURN_FALLBACK_JUMP:8,
    BURN_COOLDOWN_MS:1800000, BURN_SETTLE_MS:2700000, BURN_COOLING_MS:480000, BURN_MAD_K:4,
    store:{ get:(_key,defaultValue)=>defaultValue, set(){} }, getHistorySnapshot:()=>history,
    sampleGapLimitMs:()=>600000, finiteOrNull:v=>Number.isFinite(v)?v:null,
    getScopedWeeklyLimits:()=>[], localDateString:()=> 'test', debugLog(){}, sendAlertWebhook(){},
    shell:{beep:()=>sounds.push('beep')}, Notification:class { constructor(opts){this.opts=opts;} show(){notifications.push(this.opts);} }
  });
  vm.runInContext(fn('median')+'\n'+fn('checkBurnAnomalies'), ctx);
  const sample = (id,pct,i) => ({ timestamp:now + i*60000, codex:pct, accountIdentities:{codex:id} });
  history = [0,1,2,3,4].map(i=>sample('cli',50+i,i));
  ctx.checkBurnAnomalies(); assert.deepEqual(sounds,[]);
  history.push(sample('desktop',100,5)); ctx.checkBurnAnomalies();
  assert.deepEqual(sounds,[]); assert.deepEqual(notifications,[]);
  history.push(sample('desktop',0,6));
  for(let i=7;i<=16;i++)history.push(sample('desktop',(i-6)*8,i));
  ctx.checkBurnAnomalies(); assert.deepEqual(sounds,['beep']);
  assert.equal(notifications.length,1);
  history.push(sample('third',95,17)); ctx.checkBurnAnomalies();
  assert.equal(ctx._burningSeries.codex.until,0); assert.equal(sounds.length,1);
});
