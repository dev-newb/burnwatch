'use strict';

const crypto = require('node:crypto');
const PROVIDER_SERIES = ['codex', 'codexCli', 'gemini', 'geminiCli'];

// History needs an account boundary, not another copy of an email address.
function usageAccountIdentities(data) {
  const accounts = { codex: data.codex, codexCli: data.codex?.cli,
    gemini: data.gemini, geminiCli: data.gemini?.cli };
  const identities = {};
  for (const [key, account] of Object.entries(accounts)) {
    const id = account?.accountId || String(account?.email || '').trim().toLowerCase();
    if (!id || !account.limits?.length) continue;
    identities[key] = crypto.createHash('sha256')
      .update(JSON.stringify([id, !!account.connected, account.source || ''])).digest('hex');
  }
  return identities;
}

function sameAccountHistory(history, key) {
  if (!PROVIDER_SERIES.includes(key)) return history;
  const id = history.at(-1)?.accountIdentities?.[key];
  // Legacy or unidentified samples cannot establish an account's burn rate.
  if (!id) return [];
  let start = history.length - 1;
  while (start > 0 && history[start - 1].accountIdentities?.[key] === id) start--;
  return history.slice(start);
}

module.exports = { PROVIDER_SERIES, usageAccountIdentities, sameAccountHistory };
