'use strict';

function retryAfterMs(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const delay = /^\d+(\.\d+)?$/.test(text)
    ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : null;
}

// Keep server cooldowns across refreshes, including when a Retry-After is too
// long to wait inside one refresh. Never retry authentication or transport errors.
function createRateLimitRetry({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random, maxAttempts = 3, maxWaitMs = 15000 } = {}) {
  const cooldowns = new Map();
  return async function retry(key, request) {
    for (const [url, state] of cooldowns) {
      if (state.until <= now()) cooldowns.delete(url);
    }
    let waited = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const cooldown = cooldowns.get(key);
      if (cooldown) {
        const delay = Math.max(0, cooldown.until - now());
        if (waited + delay > maxWaitMs) throw cooldown.error;
        if (delay) { await sleep(delay); waited += delay; }
      }
      try {
        const result = await request();
        cooldowns.delete(key);
        return result;
      } catch (error) {
        if (error.statusCode !== 429) { cooldowns.delete(key); throw error; }
        const serverDelay = retryAfterMs(error.retryAfter, now());
        // A zero/expired Retry-After still gets a small backoff to avoid a loop.
        const delay = Math.max(serverDelay ?? 0, 2000 * 2 ** attempt + Math.floor(random() * 500));
        error.retryAt = now() + delay;
        cooldowns.set(key, { until: error.retryAt, error });
        if (attempt === maxAttempts - 1) throw error;
      }
    }
  };
}

module.exports = { createRateLimitRetry, retryAfterMs };
