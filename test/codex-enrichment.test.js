'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const source = name => main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];

test('reset-credit enrichment requires CLI consent and a matching nonempty account email', async () => {
  for (const [adopted, cliEmail, email, expected] of [
    [false, 'one@example.test', 'one@example.test', 0],
    [true, 'one@example.test', 'two@example.test', 0],
    [true, null, null, 0],
    [true, 'one@example.test', null, 0],
    [true, '  ONE@example.test ', 'one@example.test', 1]
  ]) {
    let reads = 0;
    const data = { email, resetCredits: { available: 2 } };
    const ctx = vm.createContext({
      fetchCodexUsageBase: async () => data,
      cliAdoptionState: () => ({ openai: adopted }),
      getCodexCliEmail: () => { assert.equal(adopted, true); return cliEmail; },
      codexResetExpiry: async account => {
        assert.equal(account, 'one@example.test');
        reads++;
        return { credits: [{ expiresAt: 123 }] };
      }
    });
    vm.runInContext(source('fetchCodexUsage'), ctx);
    assert.equal(await ctx.fetchCodexUsage(), data);
    assert.equal(reads, expected);
    assert.equal(data.resetCredits.credits?.length || 0, expected);
  }
});

test('reset-credit cache is scoped by account and cleared with local credentials', async () => {
  let reads = 0;
  const ctx = vm.createContext({
    CODEX_APPSERVER_TTL_MS: 300000,
    _codexResetExpiryCache: { at: 0, value: null, accountEmail: null },
    readCodexResetExpiry: async () => ({ credits: [{ id: ++reads }] }),
    clearCredentialHomeCache() {}, _credFileCache: new Map(), _credMemos: [],
    _geminiAccessToken: {}, _ccSameState: {}, _providerCache: {}
  });
  vm.runInContext(source('codexResetExpiry') + '\n' + source('resetLocalCredentialCaches'), ctx);
  assert.equal((await ctx.codexResetExpiry('one')).credits[0].id, 1);
  assert.equal((await ctx.codexResetExpiry('one')).credits[0].id, 1);
  assert.equal((await ctx.codexResetExpiry('two')).credits[0].id, 2);
  ctx.resetLocalCredentialCaches();
  assert.equal((await ctx.codexResetExpiry('two')).credits[0].id, 3);
});

test('Codex usage retains the email and account ID of each matching login candidate', async () => {
  let oauth = { accessToken: 'desktop', accountId: 'desk-id', email: 'desk@example.test' };
  const ctx = vm.createContext({
    getOAuthAccessToken: async () => oauth, cliAdoptionState: () => ({ openai: true }),
    readCodexAuthCandidates: () => [
      { id: 'local', accessToken: 'local', accountId: 'desk-id', email: 'desk@example.test' },
      { id: 'wsl', accessToken: 'wsl', accountId: 'cli-id', email: 'cli@example.test' }
    ],
    fetchCodexWithToken: async () => ({ limits: [{ percent: 50 }], email: null, accountId: null }),
    store: { get: () => Date.now(), set() {} }, debugLog() {}
  });
  vm.runInContext(source('fetchCodexUsageBase'), ctx);
  let data = await ctx.fetchCodexUsageBase();
  assert.equal(data.email, 'desk@example.test'); assert.equal(data.accountId, 'desk-id');
  assert.equal(data.cli.email, 'cli@example.test'); assert.equal(data.cli.accountId, 'cli-id');
  oauth = null; data = await ctx.fetchCodexUsageBase();
  assert.equal(data.connected, false); assert.equal(data.email, 'desk@example.test');
});

test('CLI email is decoded from its own id token without requiring the usage endpoint', () => {
  const token = email => 'header.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.sig';
  const ctx = vm.createContext({ Buffer, Date,
    localCredentialFiles: () => [{ id: 'one', filePath: 'one' }, { id: 'two', filePath: 'two' }],
    fs: { readFileSync: name => JSON.stringify({ tokens: { access_token: 'opaque', id_token: token(name + '@example.test') } }) },
    jwtClaims: t => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()), debugLog() {}
  });
  vm.runInContext(source('readCodexAuthCandidatesUncached'), ctx);
  const candidates = ctx.readCodexAuthCandidatesUncached();
  assert.equal(candidates[0].email, 'one@example.test'); assert.equal(candidates[1].email, 'two@example.test');
});
