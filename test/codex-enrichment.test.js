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
