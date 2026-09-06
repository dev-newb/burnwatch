const { app, BrowserWindow, ipcMain, Tray, Menu, session, shell, Notification, safeStorage, nativeImage, dialog, screen } = require('electron');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const Store = require('electron-store');
const { fetchViaWindow } = require('./src/fetch-via-window');
const { JsonlHistoryStore, DAY_MS, dedupeEntries } = require('./src/history-store');
const { finiteOrNull, sampleGapLimitMs, positiveBurn, latestContiguousRun, isExplicitAuthFailure } = require('./src/usage-math');
const { recoverBounds, clearsVisibilityThreshold } = require('./src/window-bounds');
const { startOAuthCallbackServer } = require('./src/oauth-callback');
const { sanitizeHiddenSeries, sanitizeFetchOptions, migrateHiddenSeriesLabels } = require('./src/settings-validation');
const { normalizeGeminiQuota, normalizeAntigravityModels } = require('./src/provider-models');
const { googleQuotaIssue, googleConnectionStatus } = require('./src/google-connection');
const { discoverCredentialHomes, clearCredentialHomeCache } = require('./src/local-credential-sources');

const GITHUB_OWNER = 'dev-newb';
const GITHUB_REPO = 'burnwatch';

// Profile isolation (ported from upstream): --profile=<name> launches a fully
// separate instance with its own session, cookies, settings, and history.
// Must run before ANYTHING reads app.getPath('userData') — including the
// single-instance lock, so two profiles can run side by side.
const _profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (_profileArg) {
  const profileName = _profileArg.split('=')[1].replace(/[^a-zA-Z0-9_-]/g, '_');
  if (profileName) {
    app.setPath('userData', path.join(app.getPath('userData'), 'profiles', profileName));
    console.log(`[Profile] Using profile "${profileName}" -> userData: ${app.getPath('userData')}`);
  }
}

// Migration: Handle old encrypted config files from v1.7.0 and earlier
// Must happen BEFORE creating Store instance to prevent parse errors
const fs = require('fs');
const os = require('os');

// Follow Electron's final userData path, including any --profile redirect.
const configPath = path.join(app.getPath('userData'), 'config.json');
const { quarantineUnreadableConfig } = require('./src/config-migration');
quarantineUnreadableConfig(configPath);

// Non-sensitive settings storage (no encryption needed)
const store = new Store();

// Debug mode: set DEBUG_LOG=1 or pass the app-specific flag below. Electron 43
// reserves --debug for Node and exits before app startup when it is present.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--burnwatch-debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

// ---- Stored Anthropic session key (the single reader for every path) ----
// Prefers the safeStorage-encrypted copy; a legacy plaintext key from a
// pre-encryption build is adopted and re-encrypted on first read so the
// plain copy disappears. The raw key never leaves the main process.
function readStoredSessionKey() {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
        return null;
      }
    }
    const legacy = store.get('sessionKey');
    if (legacy) {
      try {
        store.set('sessionKey_encrypted', safeStorage.encryptString(legacy).toString('base64'));
        store.delete('sessionKey');
        debugLog('[Keychain] Adopted legacy plaintext session key into safeStorage');
      } catch (err) {
        debugLog('[Keychain] Legacy key adoption failed:', err.message);
      }
      return legacy;
    }
    return null;
  }
  return store.get('sessionKey') || null;
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let sessionTray = null;  // Tray icon for Session usage
let weeklyTray = null;   // Tray icon for Weekly usage
let fableTray = null;    // Tray icon for the scoped weekly limit (e.g. Fable)
let restoreTray = null;  // Generic recovery icon when minimize-to-tray has no stats badge
const _providerTrays = { codex: null, codexCli: null, gemini: null, geminiCli: null, claudeCli: null };
let isQuitting = false;

const WIDGET_WIDTH = process.platform === 'darwin' ? 590 : 560;
const WIDGET_HEIGHT = 155;
const MIN_WIDGET_WIDTH = 290;
const WIDE_PRESET_WIDTH = 900;
const PRESET_WIDTH_TOLERANCE = 12;
const HISTORY_RETENTION_DAYS = 8;
const CHART_DAYS = 7;
const MAX_HISTORY_SAMPLES = 10000; // Cap total samples to prevent unbounded growth
const OAUTH_HTTP_TIMEOUT_MS = 15000;
const historyStore = new JsonlHistoryStore({
  baseDir: path.join(path.dirname(configPath), 'usage-history-v2'),
  retentionDays: HISTORY_RETENTION_DAYS,
  maxSamples: MAX_HISTORY_SAMPLES,
  logger: (...args) => debugLog(...args)
});

function currentHistoryScope() {
  return store.get('organizationId') || 'default';
}

function getHistorySnapshot() {
  return historyStore.getCached(currentHistoryScope());
}

function orderedDisplays() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
}

// Damon's three-branch recovery spec (upstream PR #125 review): snap only a
// window straddling two live displays; leave a single-display overhang where
// the user put it; recenter only when nothing shows a substantial piece.
function recoverWindowBounds(bounds, options = {}) {
  return recoverBounds(bounds, orderedDisplays(), options);
}

function hasTrayIcon() {
  const providerTrays = typeof _providerTrays === 'object' ? Object.values(_providerTrays) : [];
  return [restoreTray, sessionTray, weeklyTray, fableTray, ...providerTrays]
    .some((tray) => tray && !tray.isDestroyed());
}

// Position-only recovery is also safe inside native focus/restore events:
// showing or focusing again there would re-enter those same event handlers.
function recoverMainWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const before = mainWindow.getBounds();
  const recovered = recoverWindowBounds(before, {
    fallbackWidth: WIDGET_WIDTH,
    fallbackHeight: WIDGET_HEIGHT
  });
  if (before.x !== recovered.x || before.y !== recovered.y
      || before.width !== recovered.width || before.height !== recovered.height) {
    debugLog('[Window] Recovering main window to visible bounds');
    mainWindow.setBounds(recovered);
    store.set('windowPosition', { x: recovered.x, y: recovered.y });
  }
}

function showMainWindowSmart() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  recoverMainWindowPosition();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Extract scoped weekly limits (e.g. Fable) from the `limits` array. The
// legacy seven_day_<model> fields arrive null for these models, so the
// array is the only source. Returns [{slug, name, percent, resetsAt}].
function getScopedWeeklyLimits(data) {
  const scoped = [];
  for (const limit of (data?.limits || [])) {
    if (limit.kind !== 'weekly_scoped' || limit.percent == null) continue;
    const name = String(limit.scope?.model?.display_name || limit.scope?.surface || 'Scoped');
    scoped.push({
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      name,
      percent: limit.percent,
      resetsAt: limit.resets_at,
      severity: limit.severity || null
    });
  }
  return scoped;
}

// ---- Claude Code (CLI) account usage ----
// Claude Code stores an OAuth token locally; api.anthropic.com's usage
// endpoint returns the same shape as the claude.ai one (limits[] included),
// so the widget can track the CLI account with no extra login.
function localCredentialHomes() {
  return discoverCredentialHomes()
    // WSL is an unambiguous CLI environment. Prefer it over Windows copies,
    // which may belong to the desktop app, while preserving Windows fallback.
    .sort((a, b) => Number(b.kind === 'wsl') - Number(a.kind === 'wsl'));
}

// Candidate credential files across every discovered home, WSL first then
// newest. UNC stats/reads against a sleeping WSL distro can wake its VM, so
// every local read below is cached briefly; the local-login rescan (and only
// it) clears the lot for an immediate re-read.
const CRED_READ_CACHE_MS = 5 * 60 * 1000;
const _credFileCache = new Map(); // relative path -> { at, files }
const _credMemos = [];
function memoizeCredentialRead(fn, ttlMs = CRED_READ_CACHE_MS) {
  let at = 0;
  let value = null;
  const wrapped = () => {
    if (at && Date.now() - at < ttlMs) return value;
    value = fn();
    at = Date.now();
    return value;
  };
  wrapped._reset = () => { at = 0; value = null; };
  _credMemos.push(wrapped);
  return wrapped;
}

function localCredentialFiles(...relativeParts) {
  const cacheKey = relativeParts.join('/');
  const cached = _credFileCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CRED_READ_CACHE_MS) {
    return cached.files.map((file) => ({ ...file }));
  }
  const files = [];
  for (const source of localCredentialHomes()) {
    const filePath = path.join(source.home, ...relativeParts);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) files.push({ ...source, filePath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  files.sort((a, b) => Number(b.kind === 'wsl') - Number(a.kind === 'wsl')
    || b.mtimeMs - a.mtimeMs);
  _credFileCache.set(cacheKey, { at: Date.now(), files });
  return files.map((file) => ({ ...file }));
}

function readClaudeCodeCredentialsUncached() {
  const candidates = [];
  for (const source of localCredentialFiles('.claude', '.credentials.json')) {
    try {
      const creds = JSON.parse(fs.readFileSync(source.filePath, 'utf-8'));
      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken) continue;
      // Use the token only while it is fresh. Deliberately NO refresh-token
      // flow: consuming a rotating refresh token could invalidate Claude Code.
      if (oauth.expiresAt && Date.now() >= oauth.expiresAt) {
        debugLog('[ClaudeCode] CLI token expired for', source.id,
          new Date(oauth.expiresAt).toISOString(), '— skipping');
        continue;
      }
      candidates.push({ ...source, accessToken: oauth.accessToken });
    } catch (err) {
      debugLog('[ClaudeCode] Could not read', source.id, 'credentials:', err.message);
    }
  }
  return candidates;
}
const readClaudeCodeCredentials = memoizeCredentialRead(readClaudeCodeCredentialsUncached);

function readClaudeCodeToken() {
  return readClaudeCodeCredentials()[0]?.accessToken || null;
}

function fetchClaudeCodeWithToken(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          debugLog('[ClaudeCode] Usage fetch failed with status', res.statusCode);
          return resolve(null);
        }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => {
      debugLog('[ClaudeCode] Usage fetch error:', err.message);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function fetchClaudeCodeUsage() {
  const candidates = readClaudeCodeCredentials();
  if (!candidates.length) return null;
  const results = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    data: await fetchClaudeCodeWithToken(candidate.accessToken)
  })));
  const selected = results.find((result) => result.data);
  if (!selected) return null;
  debugLog('[ClaudeCode] Using local credentials from', selected.candidate.id);
  return selected.data;
}

// ---- CLI vs web account comparison (Anthropic) ----
// Same account ⇔ identical limit windows: the 5h and weekly reset timestamps
// are unique to an account down to the second, so both matching means the CLI
// login and the widget's claude.ai login share one limit pool and the CLI
// rows would be pure duplication. Mode changes are debounced over two
// consecutive fetches so a stale provider cache can't flap rows in and out.
let _ccSameState = { mode: null, candidate: null, streak: 0 };
function detectClaudeCliSameAccount(data) {
  const cc = data.claude_code;
  if (!cc) return _ccSameState.mode === true; // no CLI data — rows absent anyway
  const t = (iso) => iso ? new Date(iso).getTime() : null;
  // The two endpoints stamp resets_at with sub-second jitter (computed at
  // response time), so compare with a small tolerance; different accounts'
  // windows differ by minutes to days.
  const close = (a, b) => a !== null && b !== null && Math.abs(a - b) < 5000;
  const fiveMatch = close(t(cc.five_hour?.resets_at), t(data.five_hour?.resets_at));
  const weekMatch = close(t(cc.seven_day?.resets_at), t(data.seven_day?.resets_at));
  const observed = fiveMatch && weekMatch;

  if (_ccSameState.mode === null) {
    _ccSameState.mode = observed;
  } else if (observed === _ccSameState.mode) {
    _ccSameState.candidate = null;
    _ccSameState.streak = 0;
  } else if (_ccSameState.candidate === observed) {
    if (++_ccSameState.streak >= 2) {
      _ccSameState.mode = observed;
      _ccSameState.candidate = null;
      _ccSameState.streak = 0;
    }
  } else {
    _ccSameState.candidate = observed;
    _ccSameState.streak = 1;
  }
  return _ccSameState.mode;
}

// ---- Codex (OpenAI) account usage ----
// Reads the Codex CLI's local OAuth token (~/.codex/auth.json) and queries the
// same usage endpoint the CLI polls. The stored access token is used as-is —
// never refreshed here — and when it has expired we fall back to the newest
// rate-limit snapshot embedded in the CLI's own session logs.
function readCodexAuthCandidatesUncached() {
  const candidates = [];
  for (const source of localCredentialFiles('.codex', 'auth.json')) {
    try {
      const auth = JSON.parse(fs.readFileSync(source.filePath, 'utf-8'));
      const accessToken = auth.tokens?.access_token;
      if (!accessToken) continue;
      try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
        if (payload.exp && Date.now() >= payload.exp * 1000) {
          debugLog('[Codex] Access token expired for', source.id, '— will use session snapshot');
          continue;
        }
      } catch {}
      candidates.push({
        ...source,
        accessToken,
        accountId: auth.tokens?.account_id || null
      });
    } catch (err) {
      debugLog('[Codex] Could not read', source.id, 'auth.json:', err.message);
    }
  }
  return candidates;
}
const readCodexAuthCandidates = memoizeCredentialRead(readCodexAuthCandidatesUncached);

function readCodexAuth() {
  return readCodexAuthCandidates()[0] || null;
}

// ---- CLI-account adoption (consent) ----------------------------------------
// CLI-borrowed credentials never feed the stats until the user adopts them.
// A fresh install DETECTS local CLI logins and offers them (a chip in the
// section header shows the account); clicking the offer adopts. An install
// that was already showing CLI-derived data before this feature existed is
// grandfathered in as fully adopted, so nothing vanishes on upgrade.
function cliAdoptionState() {
  const stored = store.get('settings.cliAdopted');
  if (stored && typeof stored === 'object') {
    return {
      anthropic: stored.anthropic === true,
      openai: stored.openai === true,
      google: stored.google === true
    };
  }
  const existing = !!store.get('latestUsageData');
  const seeded = { anthropic: existing, openai: existing, google: existing };
  store.set('settings.cliAdopted', seeded);
  return seeded;
}

function getCodexCliEmail() {
  try {
    const source = localCredentialFiles('.codex', 'auth.json')[0];
    if (!source) return null;
    const auth = JSON.parse(fs.readFileSync(source.filePath, 'utf-8'));
    return auth.tokens?.id_token ? (jwtClaims(auth.tokens.id_token).email || null) : null;
  } catch {
    return null;
  }
}

// Detected-but-unadopted CLI logins, for the renderer's offer chips.
// Detection is local-only (files/keychain presence + JWT email claims) —
// no network request runs for an account the user hasn't adopted.
function detectCliOffers(adopted) {
  const offers = {};
  try {
    if (!adopted.anthropic && readClaudeCodeCredentials().length) {
      offers.anthropic = { email: null, label: 'Claude Code CLI login' };
    }
    if (!adopted.openai && readCodexAuthCandidates().length) {
      offers.openai = { email: getCodexCliEmail(), label: 'codex CLI login' };
    }
    if (!adopted.google && (readGeminiCliCredsFile() || antigravityAvailable())) {
      offers.google = { email: getGeminiCliEmail(), label: 'gemini CLI login' };
    }
  } catch (err) {
    debugLog('[Adoption] offer detection failed:', err.message);
  }
  return offers;
}

function codexWindowSuffix(windowSeconds) {
  if (windowSeconds == null) return '7d';
  const hours = Math.round(windowSeconds / 3600);
  return hours >= 24 * 6 ? '7d' : `${hours}h`;
}

function codexWindowLabel(windowSeconds) {
  return `Codex (${codexWindowSuffix(windowSeconds)})`;
}

function codexWindowKey(windowSeconds, prefix) {
  const hours = windowSeconds != null ? Math.round(windowSeconds / 3600) : 0;
  return hours >= 24 * 6 ? `${prefix}_seven_day` : `${prefix}_five_hour`;
}

// Normalize the live /backend-api/wham/usage response into rows
function normalizeCodexLive(json) {
  const limits = [];
  const pw = json?.rate_limit?.primary_window;
  if (pw && pw.used_percent != null) {
    limits.push({
      key: codexWindowKey(pw.limit_window_seconds, 'primary'),
      label: codexWindowLabel(pw.limit_window_seconds),
      percent: pw.used_percent,
      resetsAt: pw.reset_at ? new Date(pw.reset_at * 1000).toISOString() : null
    });
  }
  const sw = json?.rate_limit?.secondary_window;
  if (sw && sw.used_percent != null) {
    limits.push({
      key: codexWindowKey(sw.limit_window_seconds, 'secondary'),
      label: codexWindowLabel(sw.limit_window_seconds),
      percent: sw.used_percent,
      resetsAt: sw.reset_at ? new Date(sw.reset_at * 1000).toISOString() : null
    });
  }
  // Per-feature sub-pools (e.g. GPT-5.3-Codex-Spark) — each is a genuinely
  // separate limit, so show them even at 0% like every other tracked pool
  for (const extra of (json?.additional_rate_limits || [])) {
    const w = extra?.rate_limit?.primary_window;
    if (!w || w.used_percent == null) continue;
    const name = String(extra.limit_name || 'Extra').replace(/^gpt-[\d.]+-codex-/i, '');
    limits.push({
      key: 'extra_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_seven_day',
      label: `${name} (${codexWindowSuffix(w.limit_window_seconds)})`,
      percent: w.used_percent,
      resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null
    });
  }
  // Code review has its own pool once the account has used the feature
  const crw = json?.code_review_rate_limit?.primary_window;
  if (crw && crw.used_percent != null) {
    limits.push({
      key: 'code_review_seven_day',
      label: `Code Review (${codexWindowSuffix(crw.limit_window_seconds)})`,
      percent: crw.used_percent,
      resetsAt: crw.reset_at ? new Date(crw.reset_at * 1000).toISOString() : null
    });
  }
  if (!limits.length) return null;
  const credits = json?.credits
    ? {
        balance: json.credits.balance ?? null,
        hasCredits: !!json.credits.has_credits,
        unlimited: !!json.credits.unlimited,
        approxLocal: json.credits.approx_local_messages || null,   // [min, max] range
        approxCloud: json.credits.approx_cloud_messages || null
      }
    : null;
  // OpenAI's weekly-limit reset feature: banked resets that can be spent to
  // clear a hit limit early (applicable_available_count = usable right now)
  const resetCredits = json?.rate_limit_reset_credits
    ? { available: json.rate_limit_reset_credits.available_count ?? 0, applicable: json.rate_limit_reset_credits.applicable_available_count ?? 0 }
    : null;
  return {
    source: 'live',
    limits,
    credits,
    resetCredits,
    accountId: json?.account_id || json?.user_id || null,
    email: json?.email || null
  };
}

function fetchCodexWithToken(accessToken, accountId) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'chatgpt.com',
      path: '/backend-api/wham/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
        'User-Agent': CHROME_USER_AGENT
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          debugLog('[Codex] Usage fetch failed with status', res.statusCode);
          return resolve(null);
        }
        try { resolve(normalizeCodexLive(JSON.parse(body))); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => { debugLog('[Codex] Usage error:', err.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Fallback: newest rate_limits snapshot from the Codex CLI's session logs
const CODEX_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
function readCodexSessionSnapshotFromHome(source) {
  try {
    const root = path.join(source.home, '.codex', 'sessions');
    if (!fs.existsSync(root)) return null;
    // Newest-first bounded walk over the year/month/day tree: check a few of
    // the most recent directories at each level so one empty "today" folder
    // cannot defeat the fallback.
    const PER_LEVEL = 4;
    const subDirsNewestFirst = (dir) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
          .map((d) => d.name)
          .sort((a, b) => Number(b) - Number(a))
          .slice(0, PER_LEVEL)
          .map((name) => path.join(dir, name));
      } catch { return []; }
    };
    let levelDirs = [root];
    for (let depth = 0; depth < 3; depth++) {
      const next = levelDirs.flatMap(subDirsNewestFirst);
      if (!next.length) break;
      levelDirs = next;
    }
    const files = [];
    for (const dir of levelDirs) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.jsonl')) continue;
          const p = path.join(dir, name);
          files.push({ p, m: fs.statSync(p).mtimeMs });
        }
      } catch {}
    }
    files.sort((a, b) => b.m - a.m);
    if (!files.length) return null;
    const filePath = files[0].p;
    if (Date.now() - files[0].m > CODEX_SNAPSHOT_MAX_AGE_MS) return null;

    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    const readLen = Math.min(size, 262144);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    fs.closeSync(fd);

    const lines = buf.toString('utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const event = JSON.parse(lines[i]);
        const rl = event.payload?.rate_limits || event.rate_limits;
        if (!rl) continue;
        const limits = [];
        for (const [prefix, w] of [['primary', rl.primary], ['secondary', rl.secondary]]) {
          if (!w || w.used_percent == null) continue;
          const windowSeconds = w.window_minutes != null ? w.window_minutes * 60 : null;
          limits.push({
            key: codexWindowKey(windowSeconds, prefix),
            label: codexWindowLabel(windowSeconds),
            percent: w.used_percent,
            resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null
          });
        }
        if (limits.length) {
          return {
            data: { source: 'session', asOf: event.timestamp || null, limits },
            source,
            mtimeMs: files[0].m
          };
        }
      } catch {}
    }
    return null;
  } catch (err) {
    debugLog('[Codex] Session snapshot read failed for', source.id, ':', err.message);
    return null;
  }
}

function readCodexSessionSnapshotUncached() {
  const snapshots = localCredentialHomes()
    .map(readCodexSessionSnapshotFromHome)
    .filter(Boolean)
    .sort((a, b) => Number(b.source.kind === 'wsl') - Number(a.source.kind === 'wsl')
      || b.mtimeMs - a.mtimeMs);
  const selected = snapshots[0];
  if (!selected) return null;
  debugLog('[Codex] Using session snapshot from', selected.source.id);
  return { ...selected.data, capturedAtMs: selected.mtimeMs };
}
const readCodexSessionSnapshot = memoizeCredentialRead(readCodexSessionSnapshotUncached);

// Primary = the widget's own OpenAI login; CLI creds are fallback + dual source
// ---- Banked-reset expiry via the Codex CLI's app-server -------------------
// The HTTP usage endpoint only reports HOW MANY banked resets you hold, never
// when they lapse. The CLI's app-server (JSON-RPC over stdio) answers
// account/rateLimits/read with a rateLimitResetCredits.credits[] array whose
// entries carry expiresAt — so a reset quietly expiring can be surfaced.
// OpenAI omits that array much of the time, so every caller must cope with
// null; this is strictly enrichment on top of the HTTP data.
const CODEX_APPSERVER_TTL_MS = 5 * 60 * 1000;
let _codexResetExpiryCache = { at: 0, value: null, accountEmail: null };

function resolveCodexBinary() {
  const candidates = [
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(os.homedir(), '.local/bin/codex'),
    path.join(os.homedir(), '.codex/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) { /* next */ }
  }
  return null;
}

function readCodexResetExpiry() {
  return new Promise((resolve) => {
    const bin = resolveCodexBinary();
    if (!bin) return resolve(null);
    let child;
    try {
      child = require('child_process').spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      debugLog('[Codex] app-server spawn failed:', err.message);
      return resolve(null);
    }
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 12000);
    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch (_) {} };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 1) {                       // initialize acknowledged
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          const credits = msg.result?.rateLimitResetCredits?.credits;
          if (!Array.isArray(credits) || !credits.length) return finish(null);
          // Every banked reset expires on its OWN schedule, so keep them
          // individually — one orb in the UI per credit, each with its own
          // expiry. Collapsing to a single "soonest" was lossy and ambiguous.
          const list = credits
            .filter((c) => c && (!c.status || String(c.status).toLowerCase() === 'available'))
            .map((c) => ({
              id: typeof c.id === 'string' ? c.id : null,
              status: typeof c.status === 'string' ? c.status : null,
              resetType: typeof c.resetType === 'string' ? c.resetType : null,
              title: typeof c.title === 'string' ? c.title : null,
              description: typeof c.description === 'string' ? c.description : null,
              grantedAt: Number.isFinite(c.grantedAt) && c.grantedAt > 0 ? c.grantedAt * 1000 : null,
              expiresAt: Number.isFinite(c.expiresAt) && c.expiresAt > 0 ? c.expiresAt * 1000 : null
            }))
            .sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
          return finish(list.length ? { credits: list } : null);
        }
      }
    });
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
           params: { clientInfo: { name: 'imburning', title: "I'm Burning!", version: app.getVersion() } } });
  });
}

async function codexResetExpiry(accountEmail) {
  const now = Date.now();
  if (_codexResetExpiryCache.accountEmail === accountEmail
      && now - _codexResetExpiryCache.at < CODEX_APPSERVER_TTL_MS) return _codexResetExpiryCache.value;
  const value = await readCodexResetExpiry().catch(() => null);
  _codexResetExpiryCache = { at: now, value, accountEmail };
  return value;
}

async function fetchCodexUsageBase() {
  const oauth = await getOAuthAccessToken('openai');
  // Un-adopted CLI credentials are invisible here: no fallback, no second
  // account, no session-log snapshot (that is CLI data too).
  const cliAllowed = cliAdoptionState().openai;
  const cliCandidates = cliAllowed ? readCodexAuthCandidates() : [];
  const fetchCli = () => Promise.all(cliCandidates.map(async (candidate) => {
    const fetched = await fetchCodexWithToken(candidate.accessToken, candidate.accountId);
    return {
      candidate,
      data: fetched && !fetched.accountId && candidate.accountId
        ? { ...fetched, accountId: candidate.accountId }
        : fetched
    };
  }));
  const [primary, cliResults] = await Promise.all([
    oauth ? fetchCodexWithToken(oauth.accessToken, oauth.accountId) : Promise.resolve(null),
    fetchCli()
  ]);
  let usableCliResults = cliResults.filter((result) => result.data);

  // A single blip (sleep/wake, brief network loss) used to drop straight to
  // the session-log fallback. One short retry absorbs most transients.
  if (!primary && !usableCliResults.length && cliCandidates.length) {
    debugLog('[Codex] live fetch failed for all candidates — retrying once');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    usableCliResults = (await fetchCli()).filter((result) => result.data);
  }

  // Remember when live data was last seen (persisted): the session-log
  // fallback below must never present anything OLDER than this as current.
  const markLive = () => {
    const at = store.get('codexLastLiveAt', 0);
    if (Date.now() - at > 60 * 1000) store.set('codexLastLiveAt', Date.now());
  };

  if (primary) {
    // Prefer a local account that is genuinely different from the widget's
    // desktop OAuth account. This prevents a Windows desktop auth copy from
    // masking a distinct WSL CLI login.
    const selected = usableCliResults.find((result) => result.data.accountId
      && primary.accountId && result.data.accountId !== primary.accountId);
    if (selected) debugLog('[Codex] Using local credentials from', selected.candidate.id);
    markLive();
    return {
      ...primary,
      connected: true,
      cli: selected?.data || null
    };
  }
  const selected = usableCliResults[0];
  if (selected) {
    debugLog('[Codex] Using local credentials from', selected.candidate.id);
    markLive();
    return { ...selected.data, connected: false, cli: null };
  }
  // Session-log fallback — but only when the snapshot is NEWER than the last
  // successful live fetch. A snapshot that predates data we have already
  // shown can only be staler than what the user last saw; serving it once
  // presented a 5-day-old 11% as current usage. Rejecting it here lets the
  // provider cache serve its recent last-good LIVE data instead (or show
  // the section as disconnected, which is at least honest).
  const snapshot = cliAllowed ? readCodexSessionSnapshot() : null;
  if (!snapshot) return null;
  const lastLiveAt = store.get('codexLastLiveAt', 0);
  if ((snapshot.capturedAtMs || 0) <= lastLiveAt) {
    debugLog('[Codex] session snapshot predates last live fetch — suppressed');
    return null;
  }
  return { ...snapshot, connected: false, cli: null };
}

// Enrich the HTTP data with banked-reset expiry, when the CLI can tell us.
// Purely additive: if the app-server is missing, slow, or omits the credits
// array, the usage data is returned exactly as the HTTP endpoint gave it.
async function fetchCodexUsage() {
  const data = await fetchCodexUsageBase();
  if (!data || !data.resetCredits || !cliAdoptionState().openai) return data;
  const cliEmail = String(getCodexCliEmail() || '').trim().toLowerCase();
  const accountEmail = String(data.email || '').trim().toLowerCase();
  if (!cliEmail || cliEmail !== accountEmail) return data;
  const expiry = await codexResetExpiry(accountEmail);
  if (expiry && expiry.credits?.length) {
    data.resetCredits = { ...data.resetCredits, credits: expiry.credits };
  }
  return data;
}

// ---- Gemini (Google) account usage ----
// The gemini CLI's backend exposes per-model daily quota buckets. Auth uses
// the CLI's own local OAuth credentials; Google refresh tokens do not rotate,
// so minting an access token here (exactly what the CLI does) cannot break
// the CLI's login. Nothing is written back to oauth_creds.json.
// The CLI's OAuth client id/secret are public constants shipped inside its
// npm bundle — read them from the local install rather than embedding them
// (matches whatever client the installed CLI actually uses).
let _geminiClient = null; // { id, secret } after discovery, false when unavailable
function getGeminiOAuthClient() {
  if (_geminiClient !== null) return _geminiClient || null;
  // nvm installs live under versions/node/<ver>/lib/node_modules
  const nvmVersionRoots = [];
  try {
    const versionsDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    for (const version of fs.readdirSync(versionsDir)) {
      nvmVersionRoots.push(path.join(versionsDir, version, 'lib', 'node_modules'));
    }
  } catch {}
  // Any directory matching <base>/*/lib/node_modules — covers standalone node
  // tarballs (~/.local/opt/node-v24…), fnm and volta version dirs, which a
  // fixed list can never enumerate.
  const globVersionRoots = (base, tail) => {
    const out = [];
    try {
      for (const entry of fs.readdirSync(base)) {
        const candidate = path.join(base, entry, ...tail);
        try { if (fs.statSync(candidate).isDirectory()) out.push(candidate); } catch {}
      }
    } catch {}
    return out;
  };
  const home = os.homedir();
  const npmPrefixes = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : null,
    // Homebrew — the default global root on Apple Silicon and Intel Macs
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    path.join(home, '.local', 'lib', 'node_modules'),
    path.join(home, '.local', 'opt', 'node', 'lib', 'node_modules'),
    path.join(home, '.bun', 'install', 'global', 'node_modules'),
    ...nvmVersionRoots,
    ...globVersionRoots(path.join(home, '.local', 'opt'), ['lib', 'node_modules']),
    ...globVersionRoots(path.join(home, '.local', 'share', 'fnm', 'node-versions'),
                        ['installation', 'lib', 'node_modules']),
    ...globVersionRoots(path.join(home, '.volta', 'tools', 'image', 'node'),
                        ['lib', 'node_modules'])
  ].filter(Boolean);
  for (const prefix of npmPrefixes) {
    const root = path.join(prefix, '@google', 'gemini-cli');
    try {
      if (!fs.existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') stack.push(p);
            continue;
          }
          if (!entry.name.endsWith('.js') || fs.statSync(p).size > 30e6) continue;
          const text = fs.readFileSync(p, 'utf-8');
          const m = /([0-9]{10,}-[a-z0-9]+\.apps\.googleusercontent\.com)[\s\S]{0,300}?(GOCSPX-[A-Za-z0-9_-]+)/.exec(text);
          if (m) {
            _geminiClient = { id: m[1], secret: m[2] };
            debugLog('[Gemini] OAuth client discovered from local CLI install');
            return _geminiClient;
          }
        }
      }
    } catch (err) {
      debugLog('[Gemini] CLI install scan failed:', err.message);
    }
  }
  _geminiClient = false;
  debugLog('[Gemini] gemini-cli install not found — Gemini rows unavailable');
  return null;
}
let _geminiAccessToken = { token: null, expiresAt: 0 };

// Gemini CLI credentials — the same Windows+WSL multi-home discovery as
// Claude/Codex (WSL preferred, then newest), read-only, never written back.
function readGeminiCliCredsFileUncached() {
  for (const source of localCredentialFiles('.gemini', 'oauth_creds.json')) {
    try {
      const creds = JSON.parse(fs.readFileSync(source.filePath, 'utf-8'));
      if (creds.access_token || creds.refresh_token) return { ...source, creds };
    } catch (err) {
      debugLog('[Gemini] Could not read', source.id, 'oauth_creds.json:', err.message);
    }
  }
  return null;
}
const readGeminiCliCredsFile = memoizeCredentialRead(readGeminiCliCredsFileUncached);

function hasGeminiCliCredentials() {
  return !!readGeminiCliCredsFile();
}

function getGeminiAccessToken() {
  return new Promise((resolve) => {
    try {
      const entry = readGeminiCliCredsFile();
      if (!entry) return resolve(null);
      const creds = entry.creds;
      if (creds.access_token && creds.expiry_date && creds.expiry_date - Date.now() > 60000) {
        return resolve(creds.access_token);
      }
      if (_geminiAccessToken.token && Date.now() < _geminiAccessToken.expiresAt - 60000) {
        return resolve(_geminiAccessToken.token);
      }
      if (!creds.refresh_token) return resolve(null);
      const client = getGeminiOAuthClient();
      if (!client) return resolve(null);
      const body = new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token'
      }).toString();
      const req = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.access_token) {
              debugLog('[Gemini] Token refresh failed:', res.statusCode);
              return resolve(null);
            }
            _geminiAccessToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
            resolve(json.access_token);
          } catch { resolve(null); }
        });
      });
      req.on('error', (err) => { debugLog('[Gemini] Token refresh error:', err.message); resolve(null); });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end(body);
    } catch (err) {
      debugLog('[Gemini] Could not read oauth_creds.json:', err.message);
      resolve(null);
    }
  });
}

// Gemini CLI first resolves the account's Code Assist project, then includes
// it in retrieveUserQuota. Sending an empty object succeeds but returns only a
// partial bucket set for some accounts, which can hide newly enabled models.
function postGeminiCodeAssist(token, method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'cloudcode-pa.googleapis.com',
      path: `/v1internal:${method}`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 7000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          debugLog(`[Gemini] ${method} failed with status`, res.statusCode);
        }
        try { resolve({ ...JSON.parse(data), httpStatus: res.statusCode }); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => { debugLog(`[Gemini] ${method} error:`, err.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// One row per quota bucket — Google meters each model VERSION separately, so
// collapsing buckets loses real information. Unknown/future model IDs are
// retained by normalizeGeminiQuota and appear automatically.
async function fetchGeminiWithToken(token, reportIssue = () => {}) {
  const load = await postGeminiCodeAssist(token, 'loadCodeAssist', {
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI'
    }
  });
  const project = typeof load?.cloudaicompanionProject === 'string'
    ? load.cloudaicompanionProject
    : null;
  if (!project) debugLog('[Gemini] Code Assist project unavailable; requesting fallback quota set');
  const quota = await postGeminiCodeAssist(token, 'retrieveUserQuota', project ? { project } : {});
  const normalized = normalizeGeminiQuota(quota);
  reportIssue(googleQuotaIssue(quota, !!normalized));
  return normalized;
}

let _googleOAuthQuotaState = null;
function getGoogleConnectionStatus() {
  return googleConnectionStatus(loadOAuthTokens('google'), _googleOAuthQuotaState);
}

// The gemini CLI's login email, from its stored id_token
function getGeminiCliEmail() {
  try {
    const entry = readGeminiCliCredsFile();
    return entry ? (jwtClaims(entry.creds.id_token).email || null) : null;
  } catch {
    return null;
  }
}

// Primary = the widget's own Google login; CLI creds are fallback + dual source
async function fetchGeminiUsage() {
  const oauth = await getOAuthAccessToken('google');
  let primary = oauth ? await fetchGeminiWithToken(oauth.accessToken, issue => {
    _googleOAuthQuotaState = { token: oauth.accessToken, issue };
  }) : null;
  if (primary) {
    primary.email = oauth.email || null;
  }

  const cliToken = cliAdoptionState().google ? await getGeminiAccessToken() : null;
  let cliData = cliToken ? await fetchGeminiWithToken(cliToken) : null;
  if (cliData) {
    cliData.email = getGeminiCliEmail();
  }

  if (primary) {
    const cliSame = !cliData || !cliData.email || !primary.email
      || cliData.email === primary.email;
    return { ...primary, connected: true, cli: cliSame ? null : cliData };
  }
  if (cliData) return { ...cliData, connected: false, cli: null };
  return null;
}

// ---- Antigravity (agy CLI) usage ------------------------------------------
// Antigravity's agent usage — Gemini 3.x Pro included — is metered ONLY by
// cloudcode-pa's fetchAvailableModels (with an ideType:ANTIGRAVITY marker),
// never by the plain Code Assist quota the widget's own Google login reads.
// Credentials live in the macOS keychain (svce=gemini, acct=antigravity),
// wrapped by Go's keyring lib, and the access token expires ~hourly, so we
// refresh it ourselves with the agy binary's own OAuth client. The endpoint
// is strictly rate-limited, so results are persisted as last-good and reused
// through the (frequent) 403 windows rather than blanking the section.
const ANTIGRAVITY_PLATFORM = process.platform === 'darwin' ? 'MACOS'
  : process.platform === 'win32' ? 'WINDOWS' : 'LINUX';
const ANTIGRAVITY_CLIENT_META = JSON.stringify({
  ideType: 'ANTIGRAVITY', platform: ANTIGRAVITY_PLATFORM, pluginType: 'GEMINI'
});
const ANTIGRAVITY_USER_AGENT = `antigravity-cli/1.0 (${process.platform}; ${process.arch})`;
// A floor on how often we touch this private endpoint — the normal cadence is
// the 5-minute provider cache; this only stops repeated manual refreshes from
// hammering it. Persisted last-good then covers any transient failure.
const ANTIGRAVITY_MIN_INTERVAL_MS = 60 * 1000;
const ANTIGRAVITY_LASTGOOD_MAX_MS = 24 * 60 * 60 * 1000; // trust persisted data up to a day
let _antigravityLastAttempt = 0;
let _agyClientCache = null;

function readAntigravityKeychainToken() {
  if (process.platform !== 'darwin') return null; // keychain path is macOS-only for now
  try {
    const out = require('child_process')
      .execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
        { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) return null;
    let payload = out;
    const m = /^go-keyring-base64:(.*)$/s.exec(out);
    if (m) payload = Buffer.from(m[1], 'base64').toString('utf8');
    const obj = JSON.parse(payload);
    const tk = (obj && obj.token) || obj;
    if (!tk || !tk.refresh_token) return null;
    return {
      accessToken: tk.access_token || null,
      refreshToken: tk.refresh_token,
      expiryMs: tk.expiry ? Date.parse(tk.expiry) : 0
    };
  } catch (err) {
    debugLog('[Antigravity] keychain read failed:', err.message);
    return null;
  }
}

function resolveAgyBinary() {
  const candidates = [
    path.join(os.homedir(), '.local/bin/agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    path.join(os.homedir(), '.agy/bin/agy')
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* next */ }
  }
  return null;
}

// The agy binary embeds its OAuth client id(s)/secret(s) — scan for them the
// same way the Gemini path borrows gemini-cli's client, rather than embedding.
function agyOAuthClients() {
  if (_agyClientCache) return _agyClientCache;
  const bin = resolveAgyBinary();
  if (!bin) return [];
  try {
    const text = fs.readFileSync(bin, 'latin1');
    const ids = [...new Set(text.match(/[0-9]{10,}-[a-z0-9]+\.apps\.googleusercontent\.com/g) || [])];
    const secrets = [...new Set(text.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) || [])];
    const pairs = [];
    for (const id of ids) for (const secret of secrets) pairs.push({ id, secret });
    _agyClientCache = pairs;
    return pairs;
  } catch (err) {
    debugLog('[Antigravity] client scan failed:', err.message);
    return [];
  }
}

function httpsPost(hostname, pathName, headers, body) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path: pathName, method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers }, timeout: 15000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.write(body);
    req.end();
  });
}

async function refreshAntigravityToken(refreshToken) {
  // Try the pair that worked last time first. Scanning the binary yields every
  // id crossed with every secret, and only one combination is real — without
  // this, each refresh replays the same two rejected credential attempts
  // against Google's token endpoint.
  const known = store.get('antigravityOAuthClient', null);
  const candidates = agyOAuthClients();
  if (known) {
    candidates.sort((a, b) => Number(b.id === known.id && b.secret === known.secret)
      - Number(a.id === known.id && a.secret === known.secret));
  }
  for (const { id, secret } of candidates) {
    const body = new URLSearchParams({
      client_id: id, client_secret: secret, refresh_token: refreshToken, grant_type: 'refresh_token'
    }).toString();
    const res = await httpsPost('oauth2.googleapis.com', '/token',
      { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': ANTIGRAVITY_USER_AGENT }, body);
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        if (j.access_token) {
          if (!known || known.id !== id || known.secret !== secret) {
            store.set('antigravityOAuthClient', { id, secret });
          }
          return j.access_token;
        }
      } catch (_) { /* next candidate */ }
    }
  }
  return null;
}

async function fetchAntigravityModels(accessToken) {
  // The User-Agent is load-bearing: cloudcode-pa answers 403 PERMISSION_DENIED
  // to an otherwise identical request that omits it (Node sends none by
  // default). Verified 2026-08-12 — same token, same body, UA is the only
  // difference between 403 and 200.
  const res = await httpsPost('cloudcode-pa.googleapis.com', '/v1internal:fetchAvailableModels',
    { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      'Client-Metadata': ANTIGRAVITY_CLIENT_META,
      'User-Agent': ANTIGRAVITY_USER_AGENT }, '{}');
  if (res.status !== 200) {
    debugLog('[Antigravity] fetchAvailableModels HTTP', res.status);
    return null;
  }
  try { return JSON.parse(res.body); } catch { return null; }
}

// True when an Antigravity login is present to read — gates the "auto" source.
function antigravityAvailable() {
  return !!(resolveAgyBinary() && readAntigravityKeychainToken());
}

async function fetchAntigravityUsage() {
  const persisted = store.get('antigravityLastGood', null);
  const lastGood = (persisted && Date.now() - persisted.at < ANTIGRAVITY_LASTGOOD_MAX_MS)
    ? persisted.data : null;

  // Respect the endpoint's hard rate limit: don't even attempt more than once
  // per interval — serve last-good in between.
  if (Date.now() - _antigravityLastAttempt < ANTIGRAVITY_MIN_INTERVAL_MS && lastGood) {
    return lastGood;
  }
  _antigravityLastAttempt = Date.now();

  const tok = readAntigravityKeychainToken();
  if (!tok) return lastGood;

  // Prefer the stored access token while it's clearly valid; else refresh.
  let accessToken = (tok.expiryMs && tok.expiryMs - Date.now() > 60 * 1000) ? tok.accessToken : null;
  if (!accessToken) accessToken = await refreshAntigravityToken(tok.refreshToken);
  if (!accessToken) return lastGood;

  let json = await fetchAntigravityModels(accessToken);
  // A stale stored token can still 401 even when unexpired — one refresh retry.
  if (!json && tok.accessToken === accessToken) {
    const fresh = await refreshAntigravityToken(tok.refreshToken);
    if (fresh) json = await fetchAntigravityModels(fresh);
  }
  if (!json) return lastGood; // rate-limited / transient — keep showing last-good

  const norm = normalizeAntigravityModels(json);
  if (!norm) return lastGood;
  // The Claude / GPT-OSS pools Antigravity meters are real usage on the same
  // login, so they belong in the section — but under a Google heading they are
  // surprising, so they arrive hidden and the user unhides them with the same
  // "N hidden" chip that restores any row they hid themselves.
  // Gemini pools only — the normalizer drops Antigravity's Claude and GPT-OSS
  // allowances outright, so nothing here can mix another vendor's usage into
  // the Google section or anything computed from it.
  const data = { ...norm, connected: true, email: (tok.email || null) };
  store.set('antigravityLastGood', { at: Date.now(), data });
  return data;
}

// Pick which source feeds the Google section. 'auto' prefers Antigravity when
// an agy login exists (it's the only surface that shows agent usage), and
// falls back to the classic Gemini Code Assist quota. 'gemini' and
// 'antigravity' force one; Gemini is never removed as an option.
async function fetchGoogleUsage() {
  const source = store.get('settings.googleSource', 'auto');
  // Antigravity usage rides the agy CLI's keychain credentials wholesale, so
  // the whole surface is gated on Google CLI adoption.
  const googleCliAdopted = cliAdoptionState().google;
  const wantAntigravity = googleCliAdopted
    && (source === 'antigravity' || (source === 'auto' && antigravityAvailable()));
  if (wantAntigravity) {
    const ag = await fetchAntigravityUsage();
    if (ag) return ag;
    if (source === 'antigravity') return null; // forced: don't silently fall back
  }
  return fetchGeminiUsage();
}

// ---- Official OAuth connect flows (widget-owned logins) ----
// The primary account path for OpenAI and Google: the same browser OAuth
// flows their own CLIs run (public clients, PKCE, localhost callback), but
// the tokens are OURS — stored encrypted via safeStorage, refreshed by us,
// fully disconnectable. CLI-borrowed credentials demote to a fallback and a
// second-account (dual) source.
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}

function storeOAuthTokens(provider, tokens) {
  const json = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    store.set(`oauth_${provider}_encrypted`, safeStorage.encryptString(json).toString('base64'));
    store.delete(`oauth_${provider}`);
  } else {
    store.set(`oauth_${provider}`, json);
  }
  if (provider === 'google') _googleOAuthQuotaState = null;
}

function loadOAuthTokens(provider) {
  try {
    const enc = store.get(`oauth_${provider}_encrypted`);
    if (enc && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64')));
    }
    const plain = store.get(`oauth_${provider}`);
    return plain ? JSON.parse(plain) : null;
  } catch (err) {
    debugLog(`[OAuth:${provider}] Failed to load tokens:`, err.message);
    return null;
  }
}

function clearOAuthTokens(provider) {
  store.delete(`oauth_${provider}_encrypted`);
  store.delete(`oauth_${provider}`);
  if (provider === 'google') _googleOAuthQuotaState = null;
}

function hasExternalProviderCredentials() {
  return !!(
    loadOAuthTokens('openai')
    || loadOAuthTokens('google')
    || readCodexAuth()
    || readCodexSessionSnapshot()
    || hasGeminiCliCredentials()
  );
}

function hasLocalProviderCredentials() {
  return !!(
    readCodexAuth()
    || readCodexSessionSnapshot()
    || hasGeminiCliCredentials()
  );
}

// Public OAuth client shipped inside the codex CLI binary (verified locally)
const OPENAI_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectPort: 1455,               // must match the client's registered redirect
  redirectPath: '/auth/callback',
  scope: 'openid profile email offline_access'
};

const GOOGLE_OAUTH = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirectPath: '/oauth2callback',  // installed-app clients allow any localhost port
  scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile'
};

// The provider's currently-parked sign-in flow, if any: { cancel }.
const _oauthActiveFlow = { openai: null, google: null };

async function runOAuthConnect(provider) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  let cfg, clientId, clientSecret;
  if (provider === 'openai') {
    cfg = OPENAI_OAUTH;
    clientId = cfg.clientId;
  } else if (provider === 'google') {
    const client = getGeminiOAuthClient();
    if (!client) throw new Error('gemini-cli install not found — its public OAuth client is required for the Google login');
    cfg = GOOGLE_OAUTH;
    clientId = client.id;
    clientSecret = client.secret;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  let server;
  try {
    server = await startOAuthCallbackServer({
      port: provider === 'openai' ? cfg.redirectPort : 0,
      pathName: cfg.redirectPath,
      state,
      logger: (...args) => debugLog(...args)
    });
  } catch (err) {
    // OpenAI's redirect port is fixed, so a foreign holder is a dead end the
    // user can actually act on — name it instead of parroting EADDRINUSE.
    if (provider === 'openai' && /EADDRINUSE|busy/i.test(err.message)) {
      throw new Error('Port 1455 is in use — close any pending "codex login" in a terminal or browser tab, then try again');
    }
    throw err;
  }
  const { port, resultPromise, close, cancel } = server;
  // Register so a fresh Connect click can supersede this flow while it sits
  // parked waiting for the browser (up to 5 minutes).
  _oauthActiveFlow[provider] = { cancel };
  const redirectUri = `http://localhost:${port}${cfg.redirectPath}`;

  try {
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  if (provider === 'google') {
    authParams.set('access_type', 'offline');
    authParams.set('prompt', 'consent');
  }
  try {
    await shell.openExternal(`${cfg.authorizeUrl}?${authParams.toString()}`);
  } catch (error) {
    close();
    throw error;
  }

  const callback = await resultPromise;
  try {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier
    });
    if (clientSecret) tokenBody.set('client_secret', clientSecret);
    const resp = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS)
    });
    const json = await resp.json();
    if (!json.access_token) throw new Error(`Token exchange failed (${resp.status})`);

    const claims = jwtClaims(json.id_token);
    const tokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || null,
      idToken: json.id_token || null,
      expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
      email: claims.email || null,
      accountId: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub || null
    };
    storeOAuthTokens(provider, tokens);
    _providerCache[provider === 'openai' ? 'codex' : 'gemini'] = undefined; // force refetch
    callback.complete({ ok: true });
    // Account identity (email/id) is deliberately withheld from diagnostics.
    debugLog(`[OAuth:${provider}] Connected`);
    return { email: tokens.email, accountId: tokens.accountId };
  } catch (error) {
    callback.complete({ ok: false, message: "The provider token exchange failed. Return to I'm Burning! and try again." });
    throw error;
  }
  } finally {
    if (_oauthActiveFlow[provider] && _oauthActiveFlow[provider].cancel === cancel) {
      _oauthActiveFlow[provider] = null;
    }
  }
}

// Fresh widget-owned access token, refreshing (and persisting rotations) as needed
async function getOAuthAccessToken(provider) {
  const tokens = loadOAuthTokens(provider);
  if (!tokens) return null;
  if (tokens.expiresAt && Date.now() < tokens.expiresAt - 60000) return tokens;
  if (!tokens.refreshToken) return null;

  let cfg, clientId, clientSecret;
  if (provider === 'openai') { cfg = OPENAI_OAUTH; clientId = cfg.clientId; }
  else {
    const client = getGeminiOAuthClient();
    if (!client) return null;
    cfg = GOOGLE_OAUTH; clientId = client.id; clientSecret = client.secret;
  }
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId });
    if (clientSecret) body.set('client_secret', clientSecret);
    const resp = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS)
    });
    const json = await resp.json();
    if (!json.access_token) {
      debugLog(`[OAuth:${provider}] Refresh failed (${resp.status})`);
      if (provider === 'google') {
        _googleOAuthQuotaState = { token: tokens.accessToken,
          issue: json.error === 'invalid_grant' ? 'reauth-required' : 'quota-unavailable' };
      }
      return null;
    }
    const updated = {
      ...tokens,
      accessToken: json.access_token,
      refreshToken: json.refresh_token || tokens.refreshToken, // rotation-safe: ours to keep
      idToken: json.id_token || tokens.idToken,
      expiresAt: Date.now() + (json.expires_in || 3600) * 1000
    };
    storeOAuthTokens(provider, updated);
    return updated;
  } catch (err) {
    debugLog(`[OAuth:${provider}] Refresh error:`, err.message);
    return null;
  }
}

// One flow per provider at a time, but a NEW click supersedes a parked one:
// the user who closed the browser tab (or picked the wrong account) retries
// immediately, and used to hit a silent "already in progress" dead end for the
// rest of the old flow's 5-minute window — which read as a broken button.
ipcMain.handle('oauth-connect', async (event, provider) => {
  if (_oauthActiveFlow[provider]) {
    debugLog(`[OAuth:${provider}] Superseding a parked sign-in flow`);
    _oauthActiveFlow[provider].cancel('Superseded by a new sign-in attempt');
    _oauthActiveFlow[provider] = null;
    await new Promise((r) => setTimeout(r, 200)); // let the fixed port close
  }
  try {
    const result = await runOAuthConnect(provider);
    return { ok: true, ...result };
  } catch (err) {
    debugLog(`[OAuth:${provider}] Connect failed:`, err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('oauth-disconnect', async (event, provider) => {
  clearOAuthTokens(provider);
  _providerCache[provider === 'openai' ? 'codex' : 'gemini'] = undefined;
  return { ok: true };
});

// The widget refreshes every 30s, but external provider endpoints rate-limit
// aggressive polling (429s) — cache each provider's result for 5 minutes.
const PROVIDER_CACHE_MS = 5 * 60 * 1000;
const PROVIDER_FETCH_TIMEOUT_MS = 16000;
// Serve the last-good result through transient failures, but only for a bounded
// window — past this a genuinely-removed provider's rows should disappear
// instead of lingering forever (until app restart) on a refreshed timestamp.
const PROVIDER_STALE_MAX_MS = 30 * 60 * 1000;
const _providerCache = {};

function resetLocalCredentialCaches() {
  // A local account switch changes the identity behind these caches. Keep the
  // Gemini OAuth client discovery (it belongs to the installed CLI), but drop
  // account-bound access tokens, provider results, account comparisons, and
  // the cached Windows/WSL home list so newly started distros are discovered.
  clearCredentialHomeCache();
  _credFileCache.clear();
  for (const memo of _credMemos) memo._reset();
  _geminiAccessToken = { token: null, expiresAt: 0 };
  _codexResetExpiryCache = { at: 0, value: null, accountEmail: null };
  _ccSameState = { mode: null, candidate: null, streak: 0 };
  for (const key of Object.keys(_providerCache)) delete _providerCache[key];
}

function cachedProviderFetch(key, fetchFn, { force = false } = {}) {
  const entry = _providerCache[key];
  if (!force && entry && Date.now() - entry.at < PROVIDER_CACHE_MS) return Promise.resolve(entry.data);
  const goodAt = entry?.goodAt || 0;
  // A manual refresh can represent an account switch. Never show the prior
  // account's cached values if the newly-read credentials fail.
  const serveStale = (previous) => (!force && previous && Date.now() - goodAt < PROVIDER_STALE_MAX_MS) ? previous : null;
  const fetchPromise = Promise.resolve().then(fetchFn);
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      debugLog(`[Provider:${key}] fetch exceeded ${PROVIDER_FETCH_TIMEOUT_MS}ms`);
      resolve(null);
    }, PROVIDER_FETCH_TIMEOUT_MS);
  });
  return Promise.race([fetchPromise, timeoutPromise]).then((data) => {
    clearTimeout(timeoutId);
    if (data) { _providerCache[key] = { at: Date.now(), goodAt: Date.now(), data }; return data; }
    const served = serveStale(entry?.data || null);
    _providerCache[key] = { at: Date.now(), goodAt, data: served };
    return served;
  }).catch((err) => {
    clearTimeout(timeoutId);
    // A provider blowing up must never take the whole fetch down with it
    debugLog(`[Provider:${key}] fetch threw:`, err.message);
    const served = serveStale(entry?.data || null);
    _providerCache[key] = { at: Date.now(), goodAt, data: served };
    return served;
  });
}

// ---- Alert webhook (phone-reaching alerts via ntfy or generic JSON POST) ----
function sendAlertWebhook(event, title, message) {
  const wh = store.get('settings.webhook', {});
  if (!wh.enabled || !wh.url) return;
  try {
    const target = new URL(wh.url);
    const isLocal = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLocal)) return;
    const isNtfy = /ntfy/i.test(target.hostname);
    const body = isNtfy
      ? message
      : JSON.stringify({ event, title, message, timestamp: new Date().toISOString(), source: 'claude-usage-widget' });
    const mod = target.protocol === 'http:' ? require('http') : https;
    const req = mod.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'POST',
      headers: isNtfy
        ? { 'Content-Type': 'text/plain', 'Title': title, 'Tags': 'chart_with_upwards_trend' }
        : { 'Content-Type': 'application/json' },
      timeout: 10000
    }, (res) => { res.resume(); debugLog('[Webhook]', event, '→', res.statusCode); });
    req.on('error', (err) => debugLog('[Webhook] Failed:', err.message));
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch (err) {
    debugLog('[Webhook] Bad URL or send error:', err.message);
  }
}

ipcMain.on('alert-webhook', (event, { event: alertEvent, title, message }) => {
  sendAlertWebhook(alertEvent || 'alert', title || "I'm Burning!", message || '');
});

// ---- Session-window planner ----
// Finds the heaviest 5-hour stretch of the day from a week of history for
// each provider. For Anthropic the hint includes aligning a fresh 5h session
// window; external providers get the plain heavy-hours pattern.
function fmtPlanHour(h, timeFormat) {
  h = ((h % 24) + 24) % 24;
  if (timeFormat === '24h') return `${String(h).padStart(2, '0')}:00`;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}${ampm}`;
}

function computePlanFromSeries(history, pick, { minTotal, sessionAdvice }) {
  if (history.length < 100) return null;

  const hourly = new Array(24).fill(0);
  const maxGapMs = sampleGapLimitMs(store.get('settings.refreshInterval', '300'));
  for (let i = 1; i < history.length; i++) {
    const dt = history[i].timestamp - history[i - 1].timestamp;
    if (dt <= 0 || dt > maxGapMs) continue;
    const cur = finiteOrNull(pick(history[i]));
    const prev = finiteOrNull(pick(history[i - 1]));
    if (cur == null || prev == null) continue;
    const dv = cur - prev;
    if (dv <= 0) continue;
    hourly[new Date(history[i].timestamp).getHours()] += dv;
  }
  const total = hourly.reduce((a, b) => a + b, 0);
  if (total < minTotal) return null; // not enough burn to find a pattern

  let bestStart = 0;
  let bestSum = -1;
  for (let s = 0; s < 24; s++) {
    let sum = 0;
    for (let k = 0; k < 5; k++) sum += hourly[(s + k) % 24];
    if (sum > bestSum) { bestSum = sum; bestStart = s; }
  }
  if (bestSum < total * 0.35) return null; // usage too evenly spread — no useful peak

  const timeFormat = store.get('settings.timeFormat', '12h');
  const share = Math.round((bestSum / total) * 100);
  const range = `${fmtPlanHour(bestStart, timeFormat)}–${fmtPlanHour(bestStart + 5, timeFormat)}`;
  const text = sessionAdvice
    ? `Planner: your heaviest hours are ${range} (${share}% of burn) — start a fresh session just before ${fmtPlanHour(bestStart, timeFormat)} to cover them in one 5h window.`
    : `Planner: your heaviest hours here are ${range} (${share}% of burn).`;
  return { startHour: bestStart, text };
}

// ---- Frozen ("on ice") provider detection ----
// A provider whose limits all read 0% and whose history shows no burn for a
// long quiet stretch gets its logo frozen in ice. Anthropic is exempt — the
// widget's own login is in active use by definition, and 0% right after a
// reset would be a false positive.
const FROZEN_QUIET_MS = 72 * 60 * 60 * 1000;
const FROZEN_MIN_COVERAGE_MS = 6 * 60 * 60 * 1000;

function isProviderFrozen(limits, history, pick) {
  if (!limits || !limits.length) return false;
  if (limits.some((l) => (l.percent || 0) > 0)) return false;
  const samples = history.map((e) => ({ t: e.timestamp, v: pick(e) })).filter((s) => s.v != null);
  if (!samples.length) return false;
  if (Date.now() - samples[0].t < FROZEN_MIN_COVERAGE_MS) return false; // too little history to judge
  const quietCutoff = Date.now() - FROZEN_QUIET_MS;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t < quietCutoff) continue;
    if (samples[i].v > samples[i - 1].v) return false; // burned recently
  }
  return true;
}

function computeFrozenProviders(data) {
  const history = getHistorySnapshot();
  return {
    anthropic: false,
    openai: isProviderFrozen(data.codex?.limits, history, (e) => e.codex),
    google: isProviderFrozen(data.gemini?.limits, history, (e) => e.gemini)
  };
}

function computeSessionPlans() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const history = getHistorySnapshot().filter((e) => e.timestamp > cutoff);
  return {
    anthropic: computePlanFromSeries(history, (e) => e.session, { minTotal: 20, sessionAdvice: true }),
    openai: computePlanFromSeries(history, (e) => e.codex, { minTotal: 10, sessionAdvice: false }),
    google: computePlanFromSeries(history, (e) => e.gemini, { minTotal: 10, sessionAdvice: false })
  };
}

// ---- Daily digest ----
function localDateString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function checkDailyDigest(data) {
  if (!store.get('settings.dailyDigest', true)) return;
  const now = new Date();
  if (now.getHours() < 9) return; // fire with the first refresh after 9am
  const today = localDateString(now);
  if (store.get('digest.lastShown') === today) return;

  const history = getHistorySnapshot();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yStart = dayStart - 24 * 60 * 60 * 1000;
  const maxGapMs = sampleGapLimitMs(store.get('settings.refreshInterval', '300'));

  const burnOf = (pick) => Math.round(positiveBurn(history, pick, {
    start: yStart,
    end: dayStart,
    maxGapMs
  }));
  const weeklyBurn = burnOf((e) => e.weekly);
  const scopedSlugs = new Set();
  for (const e of history) for (const s of Object.keys(e.scoped || {})) scopedSlugs.add(s);
  const scopedParts = [...scopedSlugs].map((slug) => {
    const label = slug.charAt(0).toUpperCase() + slug.slice(1);
    return `${label} +${burnOf((e) => e.scoped?.[slug])} pts`;
  });
  const codexBurn = burnOf((e) => e.codex);
  const geminiBurn = burnOf((e) => e.gemini);
  const otherParts = [];
  if (history.some((e) => e.codex != null)) otherParts.push(`OpenAI Codex +${codexBurn} pts`);
  if (history.some((e) => e.gemini != null)) otherParts.push(`Google Gemini +${geminiBurn} pts`);

  const yesterday = localDateString(new Date(yStart));
  const anomalies = store.get(`burnAlerts_${yesterday}`, 0);

  const weeklyNow = Math.round(data.seven_day?.utilization || 0);
  let paceStr = '';
  if (data.seven_day?.resets_at) {
    const daysLeft = (new Date(data.seven_day.resets_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysLeft > 0.25) {
      paceStr = ` Stay under ~${Math.max(1, Math.floor((100 - weeklyNow) / daysLeft))} pts/day to reach the reset.`;
    }
  }

  const body = `Yesterday — Anthropic: Weekly +${weeklyBurn} pts${scopedParts.length ? ', ' + scopedParts.join(', ') : ''}`
    + `${otherParts.length ? '; ' + otherParts.join(', ') : ''}`
    + `${anomalies ? `; ${anomalies} burn alert${anomalies > 1 ? 's' : ''}` : ''}. Anthropic weekly now ${weeklyNow}%.${paceStr}`;

  store.set('digest.lastShown', today);
  try {
    new Notification({ title: "I'm Burning! daily digest", body }).show();
  } catch (err) {
    console.error('Digest notification failed:', err.message);
  }
  sendAlertWebhook('daily_digest', 'Daily usage digest', body);
}

// ---- Burn-rate forecast ----
// Least-squares slope over recent history → projected time of hitting 100%.
// Samples before the most recent value drop (a window reset) are discarded
// so a reset never poisons the slope.
const FORECAST_WINDOW_MS = 6 * 60 * 60 * 1000;
const FORECAST_MIN_SPAN_MS = 30 * 60 * 1000;
const FORECAST_MAX_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

function forecastSeries(samples, maxGapMs) {
  if (samples.length < 3) return null;
  const win = latestContiguousRun(samples, maxGapMs);
  if (win.length < 3) return null;
  const last = win[win.length - 1];
  if (last.v >= 100 || last.t - win[0].t < FORECAST_MIN_SPAN_MS) return null;

  const t0 = win[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { t, v } of win) {
    const x = (t - t0) / 3600000; // hours
    sx += x; sy += v; sxx += x * x; sxy += x * v;
  }
  const n = win.length;
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom; // percent per hour
  if (slope < 0.1) return null; // flat or falling — no meaningful forecast

  const etaMs = last.t + ((100 - last.v) / slope) * 3600000;
  if (etaMs - Date.now() > FORECAST_MAX_HORIZON_MS) return null;
  return new Date(etaMs).toISOString();
}

// Projected 100% timestamps for weekly + each scoped series, from stored history
function computeForecasts() {
  const cutoff = Date.now() - FORECAST_WINDOW_MS;
  const recent = getHistorySnapshot().filter((entry) => entry.timestamp > cutoff);
  const maxGapMs = sampleGapLimitMs(store.get('settings.refreshInterval', '300'));

  const series = (pick) => recent
    .map((entry) => ({ t: entry.timestamp, v: finiteOrNull(pick(entry)) }))
    .filter((sample) => sample.v != null);

  const forecasts = {
    session: forecastSeries(series((entry) => entry.session), maxGapMs),
    weekly: forecastSeries(series((entry) => entry.weekly), maxGapMs),
    // Anthropic per-model/surface weekly pools (present when the account has them)
    sonnet: forecastSeries(series((entry) => entry.sonnet), maxGapMs),
    opus: forecastSeries(series((entry) => entry.opus), maxGapMs),
    cowork: forecastSeries(series((entry) => entry.cowork), maxGapMs),
    design: forecastSeries(series((entry) => entry.design), maxGapMs),
    oauthApps: forecastSeries(series((entry) => entry.oauthApps), maxGapMs),
    scoped: {},
    // Cross-provider: same least-squares projection, from the per-provider
    // history series storeUsageHistory already records
    codex: forecastSeries(series((entry) => entry.codex), maxGapMs),
    gemini: forecastSeries(series((entry) => entry.gemini), maxGapMs),
    codexCli: forecastSeries(series((entry) => entry.codexCli), maxGapMs),
    geminiCli: forecastSeries(series((entry) => entry.geminiCli), maxGapMs),
    claudeCli: forecastSeries(series((entry) => entry.claudeCli), maxGapMs)
  };
  const slugs = new Set();
  for (const entry of recent) {
    for (const slug of Object.keys(entry.scoped || {})) slugs.add(slug);
  }
  for (const slug of slugs) {
    forecasts.scoped[slug] = forecastSeries(series((entry) => entry.scoped?.[slug]), maxGapMs);
  }
  return forecasts;
}

// ---- Burn-spike anomaly detection ----
// Learns the user's "normal" burn rate from history and alerts (with sound)
// when the recent window burns tokens far outside that pattern — catches
// unintended token sinks early. Baseline is robust (median + MAD of
// per-minute rates over the retention window), so occasional heavy sessions
// don't blind it, and window resets never poison it.
const BURN_WINDOW_MS = 10 * 60 * 1000;        // jump measured over this window
const BURN_MIN_WINDOW_MS = 4 * 60 * 1000;     // need at least this much data
const BURN_COOLDOWN_MS = 30 * 60 * 1000;      // one alert per series per half hour
const BURN_MIN_JUMP = 3;                      // pct points per window — absolute floor
const BURN_FALLBACK_JUMP = 8;                 // floor when too little baseline data
const BURN_MAD_K = 6;                         // sensitivity: median + K * MAD
const _burnAlertAt = {};                      // seriesKey -> last alert timestamp

// ---- Burning state (drives the on-fire bars in the renderer) ----
// A series that trips the anomaly detector is "burning" until it settles:
// its 10-min pace falls below HALF the threshold that lit it (hysteresis),
// or ten quiet minutes pass without re-qualifying. Independent of the alert
// cooldown — notifications are throttled, the flames are live state.
// Heavy use should stay visibly alight well after the spike that lit it —
// a pool hammered for an hour reads as "on fire" for the session, not for ten
// minutes. A clear stop still cools it, but over BURN_COOLING_MS rather than
// instantly, so a pause between prompts doesn't snuff the flames.
// (Distinct from BURN_COOLDOWN_MS above, which throttles notifications.)
const BURN_SETTLE_MS = 45 * 60 * 1000;
const BURN_COOLING_MS = 8 * 60 * 1000;
const _burningSeries = {};                    // seriesKey -> { until }
function getBurningSeriesMap() {
  const cutoff = Date.now();
  const burning = {};
  for (const [key, entry] of Object.entries(_burningSeries)) {
    if (entry.until > cutoff) burning[key] = true;
    else delete _burningSeries[key];
  }
  return burning;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function checkBurnAnomalies() {
  if (!store.get('settings.burnAlerts', true)) return;

  const history = getHistorySnapshot();
  if (history.length < 5) return;
  const now = history[history.length - 1].timestamp;

  // Consecutive samples are one refresh interval apart, so the max "same
  // session" pair gap must track that interval (with a 3-min floor) — a fixed
  // 3-min gap rejected every pair at the 5-min default and left the adaptive
  // median+MAD baseline permanently empty (only the crude 8% floor ever fired).
  const pairMaxGapMs = sampleGapLimitMs(store.get('settings.refreshInterval', '300'));

  // Every series names its company; Anthropic's scoped pools (Fable) are
  // called out separately from the all-models weekly pool
  const seriesList = [
    { key: 'session', label: 'Anthropic — Session', pick: (e) => e.session },
    { key: 'weekly', label: 'Anthropic — Weekly (all models)', pick: (e) => e.weekly },
    { key: 'codex', label: 'OpenAI — Codex weekly', pick: (e) => e.codex },
    { key: 'gemini', label: 'Google — Gemini daily', pick: (e) => e.gemini },
    // Dual-mode second accounts burn independently — watch them too
    { key: 'codexCli', label: 'OpenAI — Codex weekly (CLI account)', pick: (e) => e.codexCli },
    { key: 'geminiCli', label: 'Google — Gemini daily (CLI account)', pick: (e) => e.geminiCli },
    { key: 'claudeCli', label: 'Anthropic — Claude Models 7d (CLI account)', pick: (e) => e.claudeCli }
  ];
  const slugs = new Set();
  for (const entry of history) {
    for (const slug of Object.keys(entry.scoped || {})) slugs.add(slug);
  }
  for (const slug of slugs) {
    const label = slug.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    seriesList.push({ key: `scoped_${slug}`, label: `Anthropic — ${label} weekly`, pick: (e) => e.scoped?.[slug] });
  }

  for (const series of seriesList) {
    const samples = history
      .map((e) => ({ t: e.timestamp, v: finiteOrNull(series.pick(e)) }))
      .filter((s) => s.v != null);
    if (samples.length < 5) continue;

    // Current jump: oldest in-window sample → newest
    const windowSamples = samples.filter((s) => s.t >= now - BURN_WINDOW_MS);
    if (windowSamples.length < 2) continue;
    const first = windowSamples[0];
    const last = windowSamples[windowSamples.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs < BURN_MIN_WINDOW_MS) continue;
    const jump = last.v - first.v;
    if (jump < BURN_MIN_JUMP) {
      // Well below any trigger — a burning series has clearly settled
      const cooling = _burningSeries[series.key];
      if (cooling && jump < BURN_MIN_JUMP / 2) {
        cooling.until = Math.min(cooling.until, now + BURN_COOLING_MS);
      }
      continue; // negative = reset, small = normal
    }

    // Baseline: per-minute rates from consecutive pairs OLDER than the window
    const rates = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      if (samples[i].t >= now - BURN_WINDOW_MS) break;
      if (dt <= 0 || dt > pairMaxGapMs) continue;
      const dv = samples[i].v - samples[i - 1].v;
      if (dv < 0) continue; // window reset
      rates.push(dv / (dt / 60000));
    }

    const jumpRate = jump / (spanMs / 60000);
    let isAnomaly;
    let typicalJump;
    let adaptiveThreshold = null;
    if (rates.length >= 50) {
      const med = median(rates);
      const mad = median(rates.map((r) => Math.abs(r - med))) * 1.4826;
      adaptiveThreshold = med + BURN_MAD_K * Math.max(mad, 0.01);
      isAnomaly = jumpRate > adaptiveThreshold;
      typicalJump = Math.round(med * (BURN_WINDOW_MS / 60000) * 10) / 10;
    } else {
      // Not enough learned baseline yet — use a conservative absolute floor
      isAnomaly = jump >= BURN_FALLBACK_JUMP;
      typicalJump = null;
    }

    // Burning-state bookkeeping (feeds the renderer's on-fire bars)
    if (isAnomaly) {
      _burningSeries[series.key] = { until: now + BURN_SETTLE_MS };
    } else if (_burningSeries[series.key]) {
      const settled = adaptiveThreshold != null
        ? jumpRate <= adaptiveThreshold / 2
        : jump < BURN_FALLBACK_JUMP / 2;
      // Ease off rather than snap out: dropping below the hysteresis line is
      // normal mid-session (a pause to read, a slower prompt), and deleting
      // here was the main reason a hard-burning pool went cold almost at once.
      if (settled) {
        const entry = _burningSeries[series.key];
        entry.until = Math.min(entry.until, now + BURN_COOLING_MS);
      }
    }
    if (!isAnomaly) continue;

    if (_burnAlertAt[series.key] && now - _burnAlertAt[series.key] < BURN_COOLDOWN_MS) continue;
    _burnAlertAt[series.key] = now;

    const minutes = Math.round(spanMs / 60000);
    const typicalStr = typicalJump != null ? ` (typical: ~${typicalJump}% per 10 min)` : '';
    const alertBody = `${series.label} jumped ${Math.round(jump)}% in ${minutes} min${typicalStr}. Something may be eating tokens.`;
    debugLog('[BurnAlert]', series.key, `+${jump}% in ${minutes}min`, 'rate', jumpRate.toFixed(2), '%/min');
    const dateKey = `burnAlerts_${localDateString(new Date())}`;
    store.set(dateKey, store.get(dateKey, 0) + 1);
    try {
      shell.beep();
      new Notification({
        title: "I'm Burning! — unusual token burn",
        body: alertBody
      }).show();
    } catch (err) {
      console.error('Burn alert notification failed:', err.message);
    }
    sendAlertWebhook('burn_spike', 'Unusual token burn', alertBody);
  }
}

// Highest percent among a provider's pools.
function worstGeminiPercent(limits) {
  return (limits || []).reduce((worst, l) => (worst == null || l.percent > worst) ? l.percent : worst, null);
}

async function storeUsageHistory(data) {
  // OpenAI and Google remain valid history sources while Claude is logged out.
  const providerSamples = [
    data.codex?.limits?.[0]?.percent,
    worstGeminiPercent(data.gemini?.limits),
    data.codex?.cli?.limits?.[0]?.percent,
    (data.gemini?.cli?.limits || []).reduce(
      (worst, limit) => (worst == null || limit.percent > worst) ? limit.percent : worst, null)
  ];
  const hasProviderSample = providerSamples.some((value) => finiteOrNull(value) != null);
  // Skip write if the session is invalid — a live session always has resets_at timestamps.
  // Absent timestamps mean the API returned empty/zeroed data (dead session, removed device, etc.)
  if (!data.five_hour?.resets_at && !data.seven_day?.resets_at && !hasProviderSample) {
    debugLog('[History] Skipping write — no reset timestamps, likely invalid session data');
    return;
  }

  const timestamp = Date.now();

  // Record scoped weekly limits (e.g. Fable) under a slug keyed by display
  // name (same slug the renderer derives) so the chart can plot whatever
  // scopes the API sends without a per-model release.
  const scoped = {};
  for (const limit of getScopedWeeklyLimits(data)) {
    const value = finiteOrNull(limit.percent);
    if (value != null) scoped[limit.slug] = value;
  }

  // External provider samples (single percent each) power their planner hints
  const codexPct = data.codex?.limits?.[0]?.percent;
  const geminiPct = worstGeminiPercent(data.gemini?.limits);

  // Dual-mode second accounts (CLI logins on different accounts) get their
  // own history series so both pools are genuinely tracked
  const codexCliPct = data.codex?.cli?.limits?.[0]?.percent;
  const geminiCliPct = (data.gemini?.cli?.limits || []).reduce(
    (worst, l) => (worst == null || l.percent > worst) ? l.percent : worst, null);
  const claudeCliPct = (data.claude_code && data.claude_code_same_account === false)
    ? data.claude_code.seven_day?.utilization : null;

  const entry = {
    timestamp,
    session: finiteOrNull(data.five_hour?.utilization),
    weekly: finiteOrNull(data.seven_day?.utilization),
    sonnet: finiteOrNull(data.seven_day_sonnet?.utilization),
    opus: finiteOrNull(data.seven_day_opus?.utilization),
    cowork: finiteOrNull(data.seven_day_cowork?.utilization),
    design: finiteOrNull(data.seven_day_omelette?.utilization),
    oauthApps: finiteOrNull(data.seven_day_oauth_apps?.utilization),
    extraUsage: finiteOrNull(data.extra_usage?.utilization),
    ...(Object.keys(scoped).length ? { scoped } : {}),
    ...(finiteOrNull(codexPct) != null ? { codex: finiteOrNull(codexPct) } : {}),
    ...(finiteOrNull(geminiPct) != null ? { gemini: finiteOrNull(geminiPct) } : {}),
    ...(finiteOrNull(codexCliPct) != null ? { codexCli: finiteOrNull(codexCliPct) } : {}),
    ...(finiteOrNull(geminiCliPct) != null ? { geminiCli: finiteOrNull(geminiCliPct) } : {}),
    ...(finiteOrNull(claudeCliPct) != null ? { claudeCli: finiteOrNull(claudeCliPct) } : {})
  };

  await historyStore.append(currentHistoryScope(), entry);
}

async function writeHistoryMigrationBackup(legacy) {
  const backupPath = path.join(historyStore.baseDir, 'legacy-electron-store-history-backup.json');
  if (fs.existsSync(backupPath)) return backupPath;
  await fs.promises.mkdir(historyStore.baseDir, { recursive: true });
  const temporary = `${backupPath}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(legacy), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporary, backupPath);
  return backupPath;
}

async function migrateUsageHistoryStorage() {
  await historyStore.init();
  const snapshot = store.store;
  const legacy = Object.fromEntries(Object.entries(snapshot).filter(([key, value]) =>
    (key === 'usageHistory' || key.startsWith('usageHistory_')) && Array.isArray(value)));
  const legacyKeys = Object.keys(legacy);

  if (legacyKeys.length) {
    const backupPath = await writeHistoryMigrationBackup(legacy);
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * DAY_MS;
    for (const key of legacyKeys) {
      const scope = key === 'usageHistory' ? 'default' : key.slice('usageHistory_'.length);
      const expected = dedupeEntries(legacy[key])
        .filter((entry) => entry.timestamp > cutoff)
        .slice(-MAX_HISTORY_SAMPLES).length;
      const migrated = await historyStore.migrate(scope, legacy[key]);
      if (migrated.length < expected) {
        throw new Error(`History migration validation failed for ${key}: expected at least ${expected}, got ${migrated.length}`);
      }
    }

    const compactedStore = { ...snapshot };
    for (const key of legacyKeys) delete compactedStore[key];
    compactedStore.historyMigrationV2 = {
      completedAt: new Date().toISOString(),
      backupFile: path.basename(backupPath),
      migratedKeys: legacyKeys.length
    };
    // One final electron-store write removes all large legacy arrays at once.
    store.store = compactedStore;
    debugLog('[History] Migrated', legacyKeys.length, 'legacy history key(s) to JSONL storage');
  }

  await historyStore.read(currentHistoryScope(), { refresh: true });
}

function pruneStaleBurnAlertCounters() {
  const cutoff = Date.now() - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const dayCutoff = localDateString(new Date(cutoff));
  const snapshot = store.store;
  const compacted = { ...snapshot };
  let changed = false;
  for (const key of Object.keys(compacted)) {
    if (key.startsWith('burnAlerts_') && key.slice('burnAlerts_'.length) < dayCutoff) {
      delete compacted[key];
      changed = true;
    }
  }
  if (changed) store.store = compacted;
}

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// Set sessionKey as a cookie in Electron's session. The flag lets the login
// window's cookie listener ignore writes the app makes itself.
let _settingSessionCookie = false;
async function setSessionCookie(sessionKey) {
  _settingSessionCookie = true;
  try {
    await session.defaultSession.cookies.set({
      url: 'https://claude.ai',
      name: 'sessionKey',
      value: sessionKey,
      domain: '.claude.ai',
      path: '/',
      secure: true,
      httpOnly: true
    });
  } finally {
    _settingSessionCookie = false;
  }
  debugLog('sessionKey cookie set in Electron session');
}

function applyMainWindowAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const onTop = store.get('settings.alwaysOnTop', true);
  // Reassert a pinned window, but also repair an incorrectly pinned window
  // when the saved setting is off. Avoid disturbing an already-normal window.
  if (onTop || mainWindow.isAlwaysOnTop() !== onTop) {
    mainWindow.setAlwaysOnTop(onTop, 'floating');
  }
}

function createMainWindow() {
  const savedPosition = store.get('windowPosition');
  const windowOptions = {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    // Opaque + thickFrame so Windows treats us as a normal top-level window:
    // Win+Arrow and drag-to-edge Snap work, and Win11 DWM rounds the corners.
    // (transparent windows are excluded from Snap entirely)
    transparent: false,
    backgroundColor: '#16161e',
    roundedCorners: true,
    thickFrame: true,
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    resizable: true,
    maximizable: true,
    // Floor sits where the responsive ladder bottoms out — below this the
    // remaining elements would overlap
    minWidth: MIN_WIDGET_WIDTH,
    minHeight: 180,
    skipTaskbar: false,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : process.platform === 'linux' ? 'assets/logo.png' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (savedPosition) {
    const recovered = recoverWindowBounds({
      x: savedPosition.x,
      y: savedPosition.y,
      width: WIDGET_WIDTH,
      height: WIDGET_HEIGHT
    }, {
      fallbackWidth: WIDGET_WIDTH,
      fallbackHeight: WIDGET_HEIGHT
    });
    windowOptions.x = recovered.x;
    windowOptions.y = recovered.y;
    if (savedPosition.x !== recovered.x || savedPosition.y !== recovered.y) {
      store.set('windowPosition', { x: recovered.x, y: recovered.y });
    }
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('src/renderer/index.html');

  if (DEBUG) {
    mainWindow.webContents.on('console-message', (details) => {
      debugLog(`[Renderer:${details.level ?? 'log'}]`, details.message,
        details.sourceId ? `(${details.sourceId}:${details.lineNumber || 0})` : '');
    });
  }
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Renderer] Process exited:', details.reason, details.exitCode);
  });

  // Re-announce a downloaded update once the renderer is actually listening
  mainWindow.webContents.on('did-finish-load', sendUpdateReady);

  // Tell the renderer when the window is user-sized (snapped / hand-resized)
  // so it can apply its squeeze classes — and only then, which keeps the
  // auto-height loop from ever reacting to its own compression.
  let resizeNotifyTimer = null;
  mainWindow.on('resize', () => {
    if (resizeNotifyTimer) clearTimeout(resizeNotifyTimer);
    resizeNotifyTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-user-sized', windowIsUserSized());
      }
    }, 80);
  });

  let positionSaveTimer = null;
  mainWindow.on('move', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      // The window can be destroyed between the move and this debounce firing
      // (close without a tray icon) — getBounds on it then throws.
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const position = mainWindow.getBounds();
      store.set('windowPosition', { x: position.x, y: position.y });
    }, 300);
  });

  // One native close gate covers the custom button, Alt+F4, and taskbar
  // close. Hiding is safe only when a live tray icon can restore the app.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (hasTrayIcon()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // A native taskbar/Dock restore or focus bypasses our tray and activate
  // handlers. Recover after monitor changes through those paths as well.
  mainWindow.on('restore', recoverMainWindowPosition);
  mainWindow.on('focus', recoverMainWindowPosition);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ---- Detachable graph window ----
// A second BrowserWindow that renders the usage chart on its own, fed history
// + latest usage over IPC, with its own always-on-top pin and saved bounds.
let graphWindow = null;

function createGraphWindow() {
  if (graphWindow && !graphWindow.isDestroyed()) { graphWindow.focus(); return; }
  const saved = store.get('graphWindowBounds') || {};
  const onTop = store.get('settings.graphAlwaysOnTop', true);
  const recovered = recoverWindowBounds({
    x: saved.x,
    y: saved.y,
    width: saved.width || 660,
    height: saved.height || 400
  }, {
    fallbackWidth: 660,
    fallbackHeight: 400
  });
  graphWindow = new BrowserWindow({
    width: recovered.width,
    height: recovered.height,
    x: recovered.x,
    y: recovered.y,
    backgroundColor: '#16161e',
    alwaysOnTop: onTop,
    minWidth: 360,
    minHeight: 240,
    autoHideMenuBar: true,
    title: "I'm Burning! — Graph",
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : process.platform === 'linux' ? 'assets/logo.png' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  graphWindow.removeMenu();
  if (onTop) graphWindow.setAlwaysOnTop(true, 'floating');
  graphWindow.loadFile('src/renderer/graph.html');

  let saveT = null;
  const saveBounds = () => {
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(() => {
      if (graphWindow && !graphWindow.isDestroyed()) store.set('graphWindowBounds', graphWindow.getBounds());
    }, 300);
  };
  graphWindow.on('move', saveBounds);
  graphWindow.on('resize', saveBounds);
  graphWindow.on('closed', () => {
    graphWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('graph-window-closed');
  });
}

// Ping the detached graph window (if open) after each fetch so it re-pulls
// history + latest usage and re-renders.
function notifyGraphWindow() {
  if (graphWindow && !graphWindow.isDestroyed()) graphWindow.webContents.send('usage-updated');
}

/**
 * Determine background color based on thresholds
 * @param {number} percent
 * @param {object} defaultColor - {r, g, b} used below the warn threshold
 */
function getBackgroundColor(percent, defaultColor, warnThreshold, dangerThreshold) {
  if (percent >= dangerThreshold) {
    // Red #ef4444
    return { r: 239, g: 68, b: 68 };
  } else if (percent >= warnThreshold) {
    // Amber/Orange #f59e0b
    return { r: 245, g: 158, b: 11 };
  }
  return defaultColor;
}

// ---- Tray icon colours (customizable in Settings) ----
const DEFAULT_TRAY_COLORS = {
  // One colour family per company so all three are tellable at a glance:
  // Anthropic = blue (Weekly white / Session black numbers), Fable = red,
  // OpenAI = their green, Google = their yellow
  session: { bg: '#3b82f6', text: '#000000' },
  weekly:  { bg: '#3b82f6', text: '#ffffff' },
  fable:   { bg: '#ef4444', text: '#000000' },
  codex:   { bg: '#10a37f', text: '#ffffff' },
  gemini:  { bg: '#f4b400', text: '#000000' }
};
const DEFAULT_TRAY_OUTLINE = { enabled: true, color: '#facc15' };

// Alert sounds. path === null means "use the bundled default"; anything else
// is an absolute path the user picked. Volume is 0..1.
const DEFAULT_SOUNDS = {
  reset: { enabled: true, path: null, volume: 0.85 },
  burn: { enabled: true, path: null, volume: 0.85 },
  banked: { enabled: true, path: null, volume: 0.85 },
  wall: { enabled: true, path: null, volume: 0.85 }
};
function sanitizeSounds(value) {
  const out = {};
  for (const key of ['reset', 'burn', 'banked', 'wall']) {
    const v = (value && typeof value === 'object' && value[key]) || {};
    const vol = Number(v.volume);
    out[key] = {
      enabled: v.enabled !== false,
      path: typeof v.path === 'string' && v.path.trim() ? v.path : null,
      volume: Number.isFinite(vol) ? Math.min(Math.max(vol, 0), 1) : DEFAULT_SOUNDS[key].volume
    };
  }
  return out;
}

function hexToRgb(hex, fallback = { r: 0, g: 0, b: 0 }) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return fallback;
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Resolve saved tray colour settings (hex strings) into rgb objects
function getTrayColorSettings() {
  const savedColors = store.get('settings.trayColors', {});
  const savedOutline = store.get('settings.trayOutline', {});
  const resolve = (key) => ({
    bg: hexToRgb(savedColors[key]?.bg, hexToRgb(DEFAULT_TRAY_COLORS[key].bg)),
    text: { ...hexToRgb(savedColors[key]?.text, hexToRgb(DEFAULT_TRAY_COLORS[key].text)), a: 255 }
  });
  return {
    session: resolve('session'),
    weekly: resolve('weekly'),
    fable: resolve('fable'),
    codex: resolve('codex'),
    gemini: resolve('gemini'),
    outline: {
      enabled: savedOutline.enabled !== false,
      color: hexToRgb(savedOutline.color, hexToRgb(DEFAULT_TRAY_OUTLINE.color))
    }
  };
}

// API-reported severity ("normal" | "warning" | "critical") for a limits[] kind
function getLimitSeverity(data, kind) {
  const limit = (data?.limits || []).find((l) => l.kind === kind);
  return limit?.severity || null;
}

function isElevatedSeverity(severity) {
  return !!severity && severity !== 'normal';
}

// 2px border drawn inside the icon edge, used to flag API-critical limits
function drawIconOutline(buffer, width, height, color) {
  const T = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < T || y < T || x >= width - T || y >= height - T) {
        const offset = (y * width + x) * 4;
        buffer[offset] = color.b;
        buffer[offset + 1] = color.g;
        buffer[offset + 2] = color.r;
        buffer[offset + 3] = 255;
      }
    }
  }
}

/**
 * Bold 8x11 bitmap font for numbers 0-9 (2-pixel strokes for bold look)
 * Each number is represented as an array of 11 rows, each row is 8 bits
 */
const BITMAP_FONT = {
  '0': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '1': [
    0b00011000,
    0b00111000,
    0b01111000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b01111110,
    0b01111110
  ],
  '2': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00011100,
    0b00111000,
    0b01110000,
    0b11100000,
    0b11111111,
    0b11111111
  ],
  '3': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00111100,
    0b00000110,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '4': [
    0b00000110,
    0b00001110,
    0b00011110,
    0b00110110,
    0b01100110,
    0b11111111,
    0b11111111,
    0b00000110,
    0b00000110,
    0b00000110,
    0b00000110
  ],
  '5': [
    0b11111111,
    0b11111111,
    0b11000000,
    0b11000000,
    0b11111100,
    0b00000110,
    0b00000011,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '6': [
    0b00111100,
    0b01111110,
    0b11100000,
    0b11000000,
    0b11111100,
    0b11100110,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '7': [
    0b11111111,
    0b11111111,
    0b00000011,
    0b00000110,
    0b00001100,
    0b00011000,
    0b00110000,
    0b00110000,
    0b01100000,
    0b01100000,
    0b01100000
  ],
  '8': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b01111110,
    0b00111100,
    0b01111110,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '9': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b01111111,
    0b00111111,
    0b00000011,
    0b00000111,
    0b01111110,
    0b00111100
  ]
};

/**
 * Narrow 6x11 bitmap font for 3-digit numbers (100%)
 * Bold version to match
 */
const BITMAP_FONT_NARROW = {
  '0': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '1': [
    0b001100,
    0b011100,
    0b111100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b111111,
    0b111111
  ],
  '2': [
    0b011110,
    0b111111,
    0b110011,
    0b000011,
    0b000110,
    0b001100,
    0b011000,
    0b110000,
    0b110000,
    0b111111,
    0b111111
  ],
  '3': [
    0b011110,
    0b111111,
    0b110011,
    0b000011,
    0b001110,
    0b001110,
    0b000011,
    0b000011,
    0b110011,
    0b111111,
    0b011110
  ],
  '4': [
    0b000110,
    0b001110,
    0b011110,
    0b110110,
    0b110110,
    0b111111,
    0b111111,
    0b000110,
    0b000110,
    0b000110,
    0b000110
  ],
  '5': [
    0b111111,
    0b111111,
    0b110000,
    0b110000,
    0b111110,
    0b111111,
    0b000011,
    0b000011,
    0b110011,
    0b111111,
    0b011110
  ],
  '6': [
    0b011110,
    0b111111,
    0b110011,
    0b110000,
    0b111110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '7': [
    0b111111,
    0b111111,
    0b000011,
    0b000110,
    0b000110,
    0b001100,
    0b001100,
    0b011000,
    0b011000,
    0b011000,
    0b011000
  ],
  '8': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b011110,
    0b011110,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '9': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011111,
    0b000011,
    0b110011,
    0b111111,
    0b011110
  ]
};

/**
 * Draw a crisp bitmap character at position (x, y) in the buffer
 */
function drawChar(buffer, width, height, char, x, y, color, useNarrow = false) {
  const bitmap = useNarrow ? BITMAP_FONT_NARROW[char] : BITMAP_FONT[char];
  if (!bitmap) return useNarrow ? 6 : 8;
  
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const maxCol = useNarrow ? 5 : 7;
  
  for (let row = 0; row < charHeight; row++) {
    for (let col = 0; col < charWidth; col++) {
      if (bitmap[row] & (1 << (maxCol - col))) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = color.b;
          buffer[offset + 1] = color.g;
          buffer[offset + 2] = color.r;
          buffer[offset + 3] = color.a;
        }
      }
    }
  }
  return charWidth;
}

/**
 * Generate a single percentage badge icon with colored background and bitmap text
 * @param {number} percent - Usage percentage (0-100)
 * @param {object} bgColor - Background color {r, g, b}
 * @param {object} [textColor] - Text color {r, g, b, a}, defaults to white
 * @param {object|null} [outlineColor] - Border color {r, g, b} for critical limits
 * @returns {NativeImage} Generated tray icon
 */
function generatePercentageIcon(percent, bgColor, textColor = { r: 255, g: 255, b: 255, a: 255 }, outlineColor = null) {
  const width = 20;  // Back to 20x20
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Draw filled square background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = bgColor.b;
      buffer[offset + 1] = bgColor.g;
      buffer[offset + 2] = bgColor.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw text (white unless a custom color was passed)
  const percentText = Math.round(percent).toString();

  // Use narrow font for 3-digit numbers (100%)
  const useNarrow = percentText.length >= 3;
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const gap = percentText.length >= 3 ? 0 : 1; // 1px gap for 1-2 digits, no gap for 100
  const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
  let startX = Math.floor((width - totalWidth) / 2);
  const startY = Math.floor((height - charHeight) / 2);
  
  // Draw each digit
  for (let i = 0; i < percentText.length; i++) {
    drawChar(buffer, width, height, percentText[i], startX, startY, textColor, useNarrow);
    startX += charWidth + gap;
  }

  if (outlineColor) drawIconOutline(buffer, width, height, outlineColor);

  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Second-account (CLI login) badge — "terminal cursor" style: the number
 * sits slightly high and a fat cursor dash blinks-in-spirit along the
 * bottom-right, like "61_". At >=99% the number becomes the X, cursor kept.
 */
function generateCliIcon(percent, bgColor, textColor = { r: 255, g: 255, b: 255, a: 255 }, outlineColor = null) {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = bgColor.b;
      buffer[offset + 1] = bgColor.g;
      buffer[offset + 2] = bgColor.r;
      buffer[offset + 3] = 255;
    }
  }

  const setPx = (px, py) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const offset = (py * width + px) * 4;
    buffer[offset] = textColor.b;
    buffer[offset + 1] = textColor.g;
    buffer[offset + 2] = textColor.r;
    buffer[offset + 3] = textColor.a;
  };

  if (percent >= 99) {
    for (let i = 0; i < 10; i++) {
      for (let d = 0; d < 2; d++) {
        setPx(4 + i + d, 3 + i);
        setPx(13 - i + d, 3 + i);
      }
    }
  } else {
    const percentText = Math.max(0, Math.round(percent)).toString();
    const useNarrow = percentText.length >= 3;
    const charWidth = useNarrow ? 6 : 8;
    const gap = useNarrow ? 0 : 1;
    const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
    let startX = Math.max(0, Math.floor((width - totalWidth) / 2));
    for (let i = 0; i < percentText.length; i++) {
      drawChar(buffer, width, height, percentText[i], startX, 2, textColor, useNarrow);
      startX += charWidth + gap;
    }
  }

  // The cursor: a long fat dash hugging the bottom-right
  for (let y = 16; y <= 18; y++) {
    for (let x = 9; x <= 18; x++) setPx(x, y);
  }

  if (outlineColor) drawIconOutline(buffer, width, height, outlineColor);

  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Generate an X icon for 99-100% usage (maxed out)
 * @param {object} [bgColor] - Background color {r, g, b}, defaults to #dc3545
 * @param {object} [xColor] - X color {r, g, b, a}, defaults to white
 * @param {object|null} [outlineColor] - Border color {r, g, b} for critical limits
 * @returns {NativeImage} Generated X tray icon
 */
function generateRedXIcon(bgColor = { r: 220, g: 53, b: 69 }, xColor = { r: 255, g: 255, b: 255, a: 255 }, outlineColor = null) {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);

  // Filled background
  const red = bgColor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = red.b;
      buffer[offset + 1] = red.g;
      buffer[offset + 2] = red.r;
      buffer[offset + 3] = 255;
    }
  }

  // Draw X (2 pixel thick lines)
  const white = xColor;
  
  // Diagonal line from top-left to bottom-right
  for (let i = 0; i < 11; i++) {
    const x1 = 5 + i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  // Diagonal line from top-right to bottom-left
  for (let i = 0; i < 11; i++) {
    const x1 = 15 - i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }

  if (outlineColor) drawIconOutline(buffer, width, height, outlineColor);

  return nativeImage.createFromBuffer(buffer, { width, height });
}



function isMainWindowShownOnScreen() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return false;
  // Same visibility threshold as recoverBounds, so the tray toggle and the
  // recovery paths agree on what "shown" means: a substantial piece visible
  // on at least one display.
  const bounds = mainWindow.getBounds();
  return orderedDisplays().some((display) =>
    clearsVisibilityThreshold(bounds, display.workArea || display.bounds, 80, 32));
}

function trayStaticIconPath() {
  return path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : process.platform === 'linux' ? 'assets/tray-icon-linux.png' : 'assets/tray-icon.png');
}

// Show/hide the widget when a stats tray icon is left-clicked
function attachTrayToggleClick(tray) {
  tray.on('click', () => {
    if (isMainWindowShownOnScreen()) mainWindow.hide();
    else showMainWindowSmart();
  });
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
      {
        label: 'Show Widget',
        click: () => showMainWindowSmart()
      },
      {
        label: 'Refresh',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('refresh-usage');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Log Out',
        click: async () => {
          await clearAnthropicLogin();
          if (mainWindow) {
            mainWindow.webContents.send('session-expired');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          app.quit();
        }
      }
  ]);
}

// One shared Anthropic logout — used by the tray menu and the Settings
// action, so neither path can miss a stored copy (the old tray handler once
// forgot sessionKey_encrypted and resurrected dead sessions).
async function clearAnthropicLogin() {
  store.delete('sessionKey');
  store.delete('sessionKey_encrypted');
  store.delete('organizationId');
  store.delete('organizations');
  _anthropicEmailCache = null; // don't carry one account's email into the next
  // Clear all Claude.ai cookies and session storage so nothing lingers
  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  for (const cookie of cookies) {
    await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
  }
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'sessionstorage', 'cachestorage'],
    origin: 'https://claude.ai'
  });
}

function hasUsageTrayIcon() {
  return [sessionTray, weeklyTray, fableTray, ...Object.values(_providerTrays)]
    .some((tray) => tray && !tray.isDestroyed());
}

function destroyRestoreTray() {
  if (!restoreTray || restoreTray.isDestroyed()) {
    restoreTray = null;
    return;
  }
  try {
    restoreTray.removeAllListeners();
    restoreTray.setContextMenu(null);
    restoreTray.setToolTip('');
    if (process.platform === 'linux') restoreTray.setImage(nativeImage.createEmpty());
    restoreTray.destroy();
  } catch (_) {}
  restoreTray = null;
}

function syncRestoreTray() {
  const needed = store.get('settings.minimizeToTray', false) && !hasUsageTrayIcon();
  if (!needed) {
    destroyRestoreTray();
    return;
  }
  if (restoreTray && !restoreTray.isDestroyed()) return;
  try {
    restoreTray = new Tray(trayStaticIconPath());
    restoreTray.setToolTip("I'm Burning!");
    restoreTray.setContextMenu(buildTrayContextMenu());
    attachTrayToggleClick(restoreTray);
  } catch (error) {
    restoreTray = null;
    console.error('Failed to create restore tray:', error);
  }
}

function createTray() {
  // Respect the tray stats setting even when createTray is called from generic refresh paths.
  if (!store.get('settings.showTrayStats', false)) {
    destroyStatsTrays(); // stats trays only — leave provider trays to their own settings
    return;
  }

  // Rebuild from a clean state if only one of the two stats tray icons survived.
  const hasSessionTray = sessionTray && !sessionTray.isDestroyed();
  const hasWeeklyTray = weeklyTray && !weeklyTray.isDestroyed();
  if (hasSessionTray && hasWeeklyTray) return;
  if (hasSessionTray || hasWeeklyTray) destroyStatsTrays(); // don't nuke provider trays synced just before

  try {
    const staticIconPath = trayStaticIconPath();

    // Create Session tray icon FIRST (leftmost — mirrors the app's row order)
    sessionTray = new Tray(staticIconPath);
    sessionTray.setToolTip('Session Usage');

    // Create Weekly tray icon SECOND (to its right)
    weeklyTray = new Tray(staticIconPath);
    weeklyTray.setToolTip('Weekly Usage');

    const contextMenu = buildTrayContextMenu();
    sessionTray.setContextMenu(contextMenu);
    weeklyTray.setContextMenu(contextMenu);

    attachTrayToggleClick(weeklyTray);
    attachTrayToggleClick(sessionTray);
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

/**
 * Create/update or destroy the scoped-weekly (Fable) tray icon.
 * Red background with a black number, unlike the threshold-coloured
 * session/weekly icons. Exists only while tray stats are enabled AND the
 * API reports a scoped weekly limit.
 * @param {object|null} scopedLimit - {name, percent, resetsAt} or null
 * @param {string|null} [forecastAt] - projected 100% ISO timestamp, if any
 */
function syncFableTray(scopedLimit, forecastAt = null) {
  if (!scopedLimit || !store.get('settings.showTrayStats', false)) {
    if (fableTray && !fableTray.isDestroyed()) {
      try {
        fableTray.removeAllListeners();
        fableTray.setContextMenu(null);
        fableTray.setToolTip('');
        if (process.platform === 'linux') fableTray.setImage(nativeImage.createEmpty());
        fableTray.destroy();
      } catch (_) {}
    }
    fableTray = null;
    return;
  }

  try {
    if (!fableTray || fableTray.isDestroyed()) {
      fableTray = new Tray(trayStaticIconPath());
      fableTray.setContextMenu(buildTrayContextMenu());
      attachTrayToggleClick(fableTray);
    }

    const colors = getTrayColorSettings();
    const outline = colors.outline.enabled && isElevatedSeverity(scopedLimit.severity)
      ? colors.outline.color
      : null;
    // X on the badge when maxed out, otherwise the number
    fableTray.setImage(scopedLimit.percent >= 99
      ? generateRedXIcon(colors.fable.bg, colors.fable.text, outline)
      : generatePercentageIcon(scopedLimit.percent, colors.fable.bg, colors.fable.text, outline));

    const timeFormat = store.get('settings.timeFormat', '12h');
    let tooltip = `${scopedLimit.name} (weekly): ${Math.round(scopedLimit.percent)}%`;
    const resetTime = formatResetTime(scopedLimit.resetsAt, timeFormat, true);
    if (resetTime) {
      tooltip += `\nResets: ${resetTime}`;
    }
    const forecastTime = formatResetTime(forecastAt, timeFormat, true);
    if (forecastTime && scopedLimit.percent < 99) {
      tooltip += `\nAt current pace, 100% by ${forecastTime}`;
    }
    fableTray.setToolTip(tooltip);
    debugLog('[Tray] Scoped tray updated:', scopedLimit.name, scopedLimit.percent + '%');
  } catch (error) {
    console.error('Failed to update Fable tray icon:', error);
  }
}

function destroyTrayIcons() {
  // Centralized tray cleanup keeps Linux appindicator hosts from showing stale icons.
  const trays = [restoreTray, sessionTray, weeklyTray, fableTray, ...Object.values(_providerTrays)];
  restoreTray = null;
  sessionTray = null;
  weeklyTray = null;
  fableTray = null;
  for (const key of Object.keys(_providerTrays)) _providerTrays[key] = null;

  for (const tray of trays) {
    if (!tray || tray.isDestroyed()) continue;

    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');

      // On Linux, some appindicator hosts repaint stale tray entries lazily.
      // Clearing the image before destroy gives the host an explicit update.
      if (process.platform === 'linux') {
        tray.setImage(nativeImage.createEmpty());
      }
    } catch (error) {
      console.error('Failed to clear tray icon:', error);
    }

    try {
      tray.destroy();
    } catch (error) {
      console.error('Failed to destroy tray icon:', error);
    }
  }
}

// Tear down ONLY the Anthropic stats trays (session/weekly/fable), leaving the
// independent OpenAI/Google provider trays alone — they follow their own
// trayOpenai/trayGoogle settings and must not be collateral damage.
function destroyStatsTrays() {
  const trays = [sessionTray, weeklyTray, fableTray];
  sessionTray = null;
  weeklyTray = null;
  fableTray = null;
  for (const tray of trays) {
    if (!tray || tray.isDestroyed()) continue;
    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');
      if (process.platform === 'linux') tray.setImage(nativeImage.createEmpty());
    } catch (_) {}
    try { tray.destroy(); } catch (_) {}
  }
}

/**
 * Format reset time for tray tooltip
 * @param {string} resetsAt - ISO timestamp string
 * @param {string} timeFormat - '12h' or '24h'
 * @param {boolean} includeDate - Whether to include the date (for weekly resets)
 * @returns {string} Formatted time string
 */
function formatResetTime(resetsAt, timeFormat, includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  
  const formatTime = () => {
    if (timeFormat === '24h') {
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${hours}:${minutes} ${ampm}`;
    }
  };
  
  if (includeDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[date.getMonth()];
    const dayNum = date.getDate();
    return `${monthStr} ${dayNum}, ${formatTime()}`;
  } else {
    return formatTime();
  }
}

// ---- External provider tray icons (OpenAI / Google sections) ----
// Independent of the Anthropic tray setting: each provider section's
// checkbox controls its own badge.
function syncProviderTray(name, enabled, badge) {
  let tray = _providerTrays[name];
  if (!enabled || !badge) {
    if (tray && !tray.isDestroyed()) {
      try {
        tray.removeAllListeners();
        tray.setContextMenu(null);
        tray.setToolTip('');
        if (process.platform === 'linux') tray.setImage(nativeImage.createEmpty());
        tray.destroy();
      } catch (_) {}
    }
    _providerTrays[name] = null;
    return;
  }

  try {
    if (!tray || tray.isDestroyed()) {
      tray = new Tray(trayStaticIconPath());
      tray.setContextMenu(buildTrayContextMenu());
      attachTrayToggleClick(tray);
      _providerTrays[name] = tray;
    }
    const dangerThreshold = store.get('settings.dangerThreshold', 90);
    const colors = getTrayColorSettings();
    const outline = colors.outline.enabled && badge.percent >= dangerThreshold
      ? colors.outline.color : null;
    tray.setImage(badge.cli
      ? generateCliIcon(badge.percent, badge.bg, badge.text, outline)
      : (badge.percent >= 99
        ? generateRedXIcon(badge.bg, badge.text, outline)
        : generatePercentageIcon(badge.percent, badge.bg, badge.text, outline)));
    const timeFormat = store.get('settings.timeFormat', '12h');
    let tooltip = `${badge.label}: ${Math.round(badge.percent)}%`;
    const resetTime = formatResetTime(badge.resetsAt, timeFormat, true);
    if (resetTime) tooltip += `\nResets: ${resetTime}`;
    const forecastTime = formatResetTime(badge.forecastAt, timeFormat, true);
    if (forecastTime && badge.percent < 99) tooltip += `\nAt current pace, 100% by ${forecastTime}`;
    tray.setToolTip(tooltip);
  } catch (error) {
    console.error(`Failed to update ${name} tray icon:`, error);
  }
}

function syncExternalProviderTrays(usageData) {
  const colors = getTrayColorSettings();
  const fc = usageData?.forecasts || {};
  const worstOf = (limits) => (limits || []).reduce((worst, l) => (!worst || l.percent > worst.percent) ? l : worst, null);

  const trayOpenai = store.get('settings.trayOpenai', false);
  const codexLimit = usageData?.codex?.limits?.[0] || null;
  syncProviderTray('codex', trayOpenai, codexLimit && {
    percent: codexLimit.percent,
    label: 'OpenAI — ' + codexLimit.label,
    resetsAt: codexLimit.resetsAt,
    forecastAt: fc.codex,
    bg: colors.codex.bg,
    text: colors.codex.text
  });
  // Second account (codex CLI logged into a different account): same colours,
  // squeezed number + vertical CLI letters
  const codexCliLimit = usageData?.codex?.cli?.limits?.[0] || null;
  syncProviderTray('codexCli', trayOpenai, codexCliLimit && {
    percent: codexCliLimit.percent,
    label: 'OpenAI — ' + codexCliLimit.label + ' (CLI account)',
    resetsAt: codexCliLimit.resetsAt,
    forecastAt: fc.codexCli,
    bg: colors.codex.bg,
    text: colors.codex.text,
    cli: true
  });

  const trayGoogle = store.get('settings.trayGoogle', false);
  const worstGemini = worstOf(usageData?.gemini?.limits);
  syncProviderTray('gemini', trayGoogle, worstGemini && {
    percent: worstGemini.percent,
    label: 'Google — ' + worstGemini.label,
    resetsAt: worstGemini.resetsAt,
    forecastAt: fc.gemini,
    bg: colors.gemini.bg,
    text: colors.gemini.text
  });
  const worstGeminiCli = worstOf(usageData?.gemini?.cli?.limits);
  syncProviderTray('geminiCli', trayGoogle, worstGeminiCli && {
    percent: worstGeminiCli.percent,
    label: 'Google — ' + worstGeminiCli.label + ' (CLI account)',
    resetsAt: worstGeminiCli.resetsAt,
    forecastAt: fc.geminiCli,
    bg: colors.gemini.bg,
    text: colors.gemini.text,
    cli: true
  });

  // Anthropic second account (claude CLI differs from the primary login):
  // weekly percent on the Anthropic weekly colours, CLI-badged
  const cc = usageData?.claude_code_same_account === false ? usageData?.claude_code : null;
  const ccWeekly = cc?.seven_day?.utilization != null ? cc.seven_day : null;
  syncProviderTray('claudeCli', store.get('settings.showTrayStats', false), ccWeekly && {
    percent: ccWeekly.utilization,
    label: 'Anthropic — Weekly (CLI account)',
    resetsAt: ccWeekly.resets_at,
    bg: colors.weekly.bg,
    text: colors.weekly.text,
    cli: true
  });
}

/**
 * Update tray icons with current usage data
 * @param {Object} usageData - Usage data object containing session and weekly percentages
 */
function updateTrayIcon(usageData) {
  // Provider badges are governed by their own section checkboxes,
  // independent of the Anthropic tray setting below
  syncExternalProviderTrays(usageData);

  const showTrayStats = store.get('settings.showTrayStats', false);
  
  if (!showTrayStats) {
    destroyStatsTrays();
    syncRestoreTray();
    return;
  }

  // Recreate tray icons if they were destroyed
  if (!sessionTray || sessionTray.isDestroyed() || !weeklyTray || weeklyTray.isDestroyed()) {
    createTray();
  }

  // Scoped weekly tray (e.g. Fable): shown while the API reports one
  const scopedLimit = getScopedWeeklyLimits(usageData)[0] || null;
  syncFableTray(scopedLimit, scopedLimit ? usageData?.forecasts?.scoped?.[scopedLimit.slug] : null);

  if ((!sessionTray || sessionTray.isDestroyed()) && (!weeklyTray || weeklyTray.isDestroyed())) {
    syncRestoreTray();
    return;
  }

  // Get threshold settings and time format
  const warnThreshold = store.get('settings.warnThreshold', 75);
  const dangerThreshold = store.get('settings.dangerThreshold', 90);
  const timeFormat = store.get('settings.timeFormat', '12h');
  const colors = getTrayColorSettings();

  // Outline flags API-elevated severity when enabled in settings
  const outlineFor = (severity) =>
    colors.outline.enabled && isElevatedSeverity(severity) ? colors.outline.color : null;

  // Extract percentages and reset times from usage data. `null` means the
  // API reported nothing for that pool — the badge falls back to the neutral
  // robot icon instead of pretending "0".
  const sessionPercent = finiteOrNull(usageData?.five_hour?.utilization);
  const sessionResetsAt = usageData?.five_hour?.resets_at;
  const weeklyPercent = finiteOrNull(usageData?.seven_day?.utilization);
  const weeklyResetsAt = usageData?.seven_day?.resets_at;
  const sessionOutline = outlineFor(getLimitSeverity(usageData, 'session'));
  const weeklyOutline = outlineFor(getLimitSeverity(usageData, 'weekly_all'));

  try {
    // Generate Weekly icon (blue background) - LEFT position
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      if (weeklyPercent == null) {
        weeklyTray.setImage(trayStaticIconPath());
        weeklyTray.setToolTip('Claude Models (7d): no data');
      } else {
        let weeklyIcon;
        if (weeklyPercent >= 99) {
          weeklyIcon = generateRedXIcon(undefined, undefined, weeklyOutline);
        } else {
          const weeklyColor = getBackgroundColor(weeklyPercent, colors.weekly.bg, warnThreshold, dangerThreshold);
          weeklyIcon = generatePercentageIcon(weeklyPercent, weeklyColor, colors.weekly.text, weeklyOutline);
        }
        weeklyTray.setImage(weeklyIcon);
        let weeklyTooltip = `Claude Models (7d): ${Math.round(weeklyPercent)}%`;
        const weeklyResetTime = formatResetTime(weeklyResetsAt, timeFormat, true);
        if (weeklyResetTime) {
          weeklyTooltip += `\nResets: ${weeklyResetTime}`;
        }
        const weeklyForecastTime = formatResetTime(usageData?.forecasts?.weekly, timeFormat, true);
        if (weeklyForecastTime && weeklyPercent < 99) {
          weeklyTooltip += `\nAt current pace, 100% by ${weeklyForecastTime}`;
        }
        weeklyTray.setToolTip(weeklyTooltip);
      }
    }

    // Generate Session icon (purple background) - RIGHT position
    if (sessionTray && !sessionTray.isDestroyed()) {
      if (sessionPercent == null) {
        sessionTray.setImage(trayStaticIconPath());
        sessionTray.setToolTip('Claude Session (5h): no data');
      } else {
        let sessionIcon;
        if (sessionPercent >= 99) {
          sessionIcon = generateRedXIcon(undefined, undefined, sessionOutline);
        } else {
          const sessionColor = getBackgroundColor(sessionPercent, colors.session.bg, warnThreshold, dangerThreshold);
          sessionIcon = generatePercentageIcon(sessionPercent, sessionColor, colors.session.text, sessionOutline);
        }
        sessionTray.setImage(sessionIcon);
        let sessionTooltip = `Claude Session (5h): ${Math.round(sessionPercent)}%`;
        const sessionResetTime = formatResetTime(sessionResetsAt, timeFormat, false);
        if (sessionResetTime) {
          sessionTooltip += `\nResets: ${sessionResetTime}`;
        }
        sessionTray.setToolTip(sessionTooltip);
      }
    }
  } catch (error) {
    console.error('Failed to update tray icons:', error);
  }
  syncRestoreTray();
}


// IPC Handlers
// SECURITY: the renderer receives login STATE only — never the session key.
// Everything that needs the raw key (login, validation, fetching) stays in
// the main process.
ipcMain.handle('get-credentials', () => {
  const claudeCliAvailable = !!readClaudeCodeToken();
  return {
    loggedIn: !!readStoredSessionKey(),
    organizationId: store.get('organizationId'),
    organizations: store.get('organizations', []),
    // A fresh claude CLI login can power the Anthropic section with no
    // claude.ai web login ("via CLI login" fallback)
    cliFallbackAvailable: claudeCliAvailable,
    localProviderCredentialsAvailable: claudeCliAvailable || hasLocalProviderCredentials(),
    // OpenAI/Codex and Google/Gemini credentials remain useful even when the
    // user deliberately logs out of Claude.
    providerFallbackAvailable: hasExternalProviderCredentials(),
    googleConnection: getGoogleConnectionStatus(),
    // Lets Settings warn when tokens would sit unencrypted on disk
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  };
});

// Main-internal: persist a validated login. Not an IPC surface — the
// renderer triggers 'anthropic-login' and never handles the key itself.
async function saveAnthropicCredentials(sessionKey, organizationId, organizations) {
  // Store session key in OS keychain if available
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(sessionKey);
    store.set('sessionKey_encrypted', encrypted.toString('base64'));
    store.delete('sessionKey'); // Remove legacy plain storage
  } else {
    // Fallback: plain storage
    store.set('sessionKey', sessionKey);
  }
  if (organizationId) {
    store.set('organizationId', organizationId);
    await historyStore.read(organizationId, { refresh: true });
  }
  // Persist the org list so the Teams/Personal selector survives a restart
  // (previously dropped here, so the dropdown only ever appeared right after login)
  if (Array.isArray(organizations)) {
    store.set('organizations', organizations);
  }
  // Also set cookie in Electron session for window-based fetching
  await setSessionCookie(sessionKey);
}

// Switch the tracked organization — the renderer sends the org id only.
ipcMain.handle('set-organization', async (event, orgId) => {
  const id = String(orgId || '').trim();
  const known = store.get('organizations', []);
  if (!id || (known.length && !known.some((org) => org.id === id))) return false;
  store.set('organizationId', id);
  await historyStore.read(id, { refresh: true });
  return true;
});

ipcMain.handle('delete-credentials', async () => {
  await clearAnthropicLogin();
  return true;
});

// Validate a sessionKey by fetching org ID via hidden BrowserWindow.
// Main-internal (called by the 'anthropic-login' flow). Never log any part
// of the key itself — length only.
async function validateSessionKey(sessionKey) {
  debugLog('Validating session key (length ' + String(sessionKey || '').length + ')');
  try {
    // Set the cookie in Electron's session first
    await setSessionCookie(sessionKey);

    // Fetch organizations using hidden BrowserWindow (bypasses Cloudflare)
    const data = await fetchViaWindow('https://claude.ai/api/organizations');

    if (data && Array.isArray(data) && data.length > 0) {
      // Filter to orgs with 'chat' capability (excludes API-only orgs)
      const chatOrgs = data.filter(org => 
        org.capabilities && org.capabilities.includes('chat')
      );

      if (chatOrgs.length === 0) {
        return { success: false, error: 'No chat-enabled organizations found' };
      }

      // Prioritize Teams org if present, otherwise use first chat org
      const defaultOrg = chatOrgs.find(org => org.raven_type === 'team') || chatOrgs[0];
      const orgId = defaultOrg.uuid || defaultOrg.id;
      
      debugLog(`Session key validated, found ${chatOrgs.length} chat org(s), default org ID:`, orgId);
      
      return { 
        success: true, 
        organizationId: orgId,
        organizations: chatOrgs.map(org => ({
          id: org.uuid || org.id,
          name: org.name,
          isTeam: org.raven_type === 'team'
        }))
      };
    }

    // Check if it's an error response
    if (data && data.error) {
      return { success: false, error: data.error.message || data.error };
    }

    return { success: false, error: 'No organization found' };
  } catch (error) {
    console.error('Session key validation failed:', error.message);
    // Clean up the invalid cookie
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
    return { success: false, error: error.message };
  }
}

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    if (process.platform === 'darwin') {
      mainWindow.minimize();
    } else {
      const minimizeToTray = store.get('settings.minimizeToTray', false);
      if (minimizeToTray) syncRestoreTray();
      if (minimizeToTray && hasTrayIcon()) {
        mainWindow.hide();
      } else {
        mainWindow.minimize();
      }
    }
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// While the window is snapped (Win+Arrow / drag-to-edge) or hand-resized —
// width OR height differing from the last size we set ourselves — stop
// fighting the shell over geometry. Un-snapping restores the pre-snap bounds
// (our own size), which re-enables auto-sizing.
let _expectedWidth = WIDGET_WIDTH;
let _lastSetHeight = null;
let _activeWindowPreset = null;
let _managedPresetWidth = null;

function windowIsUserSized() {
  if (!mainWindow) return false;
  // A named preset owns its geometry until the user toggles it off. This is
  // especially important for the tall preset: on shorter displays its clamped
  // height can happen to resemble the last auto-fit height, which previously
  // made the renderer re-enter auto-fit and fight every vertical resize.
  if (_activeWindowPreset !== null) return true;
  if (mainWindow.isMaximized()) return true;
  const [cw, ch] = mainWindow.getContentSize();
  if (Math.abs(cw - _expectedWidth) > 24) return true;
  return _lastSetHeight != null && Math.abs(ch - _lastSetHeight) > 24;
}

// Landscape needs a taller floor: below ~340px the three columns and their
// planners would crush (compact mode exists for smaller footprints)
ipcMain.on('set-min-height', (event, h) => {
  if (mainWindow) mainWindow.setMinimumSize(MIN_WIDGET_WIDTH, Math.max(120, Math.round(h)));
});

ipcMain.on('resize-window', (event, height, force, fitPreset, userAction) => {
  if (!mainWindow) return;
  const setFittedContentSize = (width, requestedHeight) => {
    const bounds = mainWindow.getBounds();
    const [, currentContentHeight] = mainWindow.getContentSize();
    const frameHeight = Math.max(0, bounds.height - currentContentHeight);
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const safeHeight = Math.max(80, Math.min(Math.round(requestedHeight), workArea.height - frameHeight));
    mainWindow.setContentSize(width, safeHeight);
    const fitted = mainWindow.getBounds();
    const x = Math.min(Math.max(fitted.x, workArea.x), workArea.x + workArea.width - fitted.width);
    const y = Math.min(Math.max(fitted.y, workArea.y), workArea.y + workArea.height - fitted.height);
    if (x !== fitted.x || y !== fitted.y) mainWindow.setPosition(x, y);
  };
  if (force) {
    // BACKGROUND refits must never collapse a hand-sized window out from
    // under the user — but a direct click (graph toggle, subgroup burn,
    // row hide) is the user asking for the content change, so it may adopt
    // the new content height even in a hand-sized window (width is kept).
    const explicitPresetFit = fitPreset === true && _activeWindowPreset !== null;
    const explicitUserAction = userAction === true;
    if (windowIsUserSized() && !explicitPresetFit && !explicitUserAction) return;
    const [cw] = mainWindow.getContentSize();
    setFittedContentSize(cw, height);
    // Record the ACTUAL height after the OS clamps to the minimum, not the
    // requested one — otherwise windowIsUserSized() sees a phantom gap and
    // freezes future auto-fits (e.g. compact mode stuck at the 180px floor)
    _lastSetHeight = mainWindow.getContentSize()[1];
    return;
  }
  if (!windowIsUserSized()) {
    setFittedContentSize(_expectedWidth, height);
    _lastSetHeight = mainWindow.getContentSize()[1];
  }
});

// The wide preset owns its default width until the user deliberately drags
// the window. When every second-account cluster is hidden, reclaim the unused
// columns; revealing one restores the normal preset width. A mismatched
// current width means the user resized it, so stop managing width until the
// wide preset is explicitly chosen again.
// The renderer computes the exact width the wide layout needs given which CLI
// clusters are collapsed (each collapsed column is a fixed narrow width, the
// rest flex), and passes it here. 0 restores the full wide preset. Only acts
// while the wide preset still owns the width (a manual drag releases it).
ipcMain.on('fit-landscape-width', (event, targetWidth) => {
  if (!mainWindow || _activeWindowPreset !== 'wide' || _managedPresetWidth == null) return;
  const bounds = mainWindow.getBounds();
  if (Math.abs(bounds.width - _managedPresetWidth) > PRESET_WIDTH_TOLERANCE) {
    _managedPresetWidth = null;
    return;
  }
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const requested = (typeof targetWidth === 'number' && targetWidth > 0)
    ? Math.max(MIN_WIDGET_WIDTH, Math.round(targetWidth))
    : WIDE_PRESET_WIDTH;
  const width = Math.min(requested, workArea.width);
  if (Math.abs(width - bounds.width) < 2) { _managedPresetWidth = width; return; }
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  mainWindow.setBounds({ x, y: bounds.y, width, height: bounds.height });
  _managedPresetWidth = mainWindow.getBounds().width;
});

// Per-account tracking toggles, applied AFTER the (cached) provider fetch so
// flipping them takes effect immediately. "Desktop account" (showCodex /
// showGemini) covers the account signed into the widget; turning it off
// demotes the CLI login to the tracked source (grey "via CLI login" chip),
// exactly like the fetchers' own no-OAuth fallback. "CLI account"
// (showCodexCli / showGeminiCli) strips the second-account rows/badges.
// In via-CLI-login mode (connected=false) both toggles are no-ops for the
// primary — there is no desktop account being tracked to hide.
function applyAccountToggles(data) {
  const filt = (obj, showDesktop, showCli) => {
    if (!obj) return obj;
    // Antigravity is one login with no desktop/CLI split — the two account
    // toggles have nothing to select between, so they leave it alone.
    if (obj.source === 'antigravity') return obj;
    let out = obj;
    if (!showCli && out.cli) out = { ...out, cli: null };
    if (!showDesktop && out.connected) {
      out = out.cli ? { ...out.cli, connected: false, cli: null } : null;
    }
    return out;
  };
  const codex = filt(data.codex, store.get('settings.showCodex', true), store.get('settings.showCodexCli', true));
  if (codex) data.codex = codex; else delete data.codex;
  const gemini = filt(data.gemini, store.get('settings.showGemini', true), store.get('settings.showGeminiCli', true));
  if (gemini) data.gemini = gemini; else delete data.gemini;
  return data;
}

ipcMain.handle('get-window-position', () => {
  if (mainWindow) {
    return mainWindow.getBounds();
  }
  return null;
});

ipcMain.handle('set-window-position', (event, { x, y }) => {
  if (mainWindow) {
    mainWindow.setPosition(x, y);
    return true;
  }
  return false;
});

ipcMain.on('open-external', (event, url) => {
  // Trust boundary enforcement: duplicate allowlist check in main process
  const allowedDomains = ['claude.ai', 'github.com', 'paypal.me', 'buymeacoffee.com'];
  try {
    const parsedUrl = new URL(url);
    const isAllowed = allowedDomains.some(domain => 
      parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
    );
    if (isAllowed) {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked openExternal call to disallowed domain: ${parsedUrl.hostname}`);
    }
  } catch (err) {
    console.warn(`[Security] Blocked openExternal call with invalid URL: ${url}`);
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-usage-history', async () => {
  const history = await historyStore.read(currentHistoryScope());
  const cutoff = Date.now() - (CHART_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((entry) => entry.timestamp > cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
});

// Let the user swap either alert sound for a file of their own.
ipcMain.handle('pick-sound-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Choose an alert sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'flac'] }]
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: res.filePaths[0], name: path.basename(res.filePaths[0]) };
});

// Custom sounds live outside the bundle, so hand the renderer the bytes as a
// data: URL rather than opening the CSP up to arbitrary file: reads.
ipcMain.handle('read-sound-file', async (event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'No file' };
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: 'Not a file' };
    if (stat.size > 8 * 1024 * 1024) return { ok: false, error: 'File is larger than 8 MB' };
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg',
                   '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[ext];
    if (!mime) return { ok: false, error: 'Unsupported audio format' };
    const buf = await fs.promises.readFile(filePath);
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Export the usage history to a CSV or JSON file the user chooses. This is a
// user-initiated local file save (dialog), never a network upload.
ipcMain.handle('export-history', async (event, format) => {
  const history = (await historyStore.read(currentHistoryScope())).slice().sort((a, b) => a.timestamp - b.timestamp);
  if (!history.length) return { ok: false, error: 'No usage history recorded yet.' };

  const stamp = new Date(history[history.length - 1].timestamp);
  const dateTag = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`;
  const ext = format === 'json' ? 'json' : 'csv';
  const res = await dialog.showSaveDialog(mainWindow || undefined, {
    title: "Export I'm Burning! usage history",
    defaultPath: `burnwatch-usage-${dateTag}.${ext}`,
    filters: [ext === 'json' ? { name: 'JSON', extensions: ['json'] } : { name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };

  try {
    if (ext === 'json') {
      fs.writeFileSync(res.filePath, JSON.stringify(history, null, 2));
    } else {
      // Union of all keys across entries (scoped is a nested map — flatten it)
      const flat = history.map((e) => {
        const { scoped, ...rest } = e;
        const row = { ...rest };
        for (const k of Object.keys(scoped || {})) row['scoped_' + k] = scoped[k];
        row.timestamp_iso = new Date(e.timestamp).toISOString();
        return row;
      });
      const cols = Array.from(flat.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set()));
      const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
      const csv = [cols.join(','), ...flat.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
      fs.writeFileSync(res.filePath, csv);
    }
    return { ok: true, path: res.filePath, count: history.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Show a native OS desktop notification (Windows toast, macOS NC, Linux libnotify)
// Adopt (or drop) a detected CLI login as a tracked account. The renderer
// refreshes with forceProviders afterwards; clearing the credential caches
// here makes that refresh actually re-read the local files.
// Window bounds round-trip for the Settings tall-mode dance: a hand-sized
// landscape window is captured before Settings forces tall, and restored
// exactly on close.
ipcMain.handle('get-window-bounds', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return mainWindow.getBounds();
});
ipcMain.handle('set-window-bounds', (event, b) => {
  if (!mainWindow || mainWindow.isDestroyed() || !b) return false;
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : undefined);
  mainWindow.setBounds({ x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height) });
  return true;
});

ipcMain.handle('set-cli-adopted', (event, provider, adopted) => {
  if (!['anthropic', 'openai', 'google'].includes(provider)) return { ok: false };
  const state = cliAdoptionState();
  state[provider] = adopted === true;
  store.set('settings.cliAdopted', state);
  resetLocalCredentialCaches();
  return { ok: true, state };
});

ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.show();
  }
});

// Resize window for compact vs normal mode
// Compact: 320px wide (was 290 — "I'm Burning!" needs the extra room in the
// title bar), normal: WIDGET_WIDTH. Height stays managed by renderer.
ipcMain.on('set-compact-mode', (event, compact) => {
  if (mainWindow) {
    _activeWindowPreset = null;
    _managedPresetWidth = null;
    const bounds = mainWindow.getBounds();
    const width = compact ? 320 : WIDGET_WIDTH;
    _expectedWidth = width;
    // Lower the height floor for compact so its short window is actually
    // reachable (otherwise the 180px portrait minimum clamps it and leaves
    // empty space); restore the normal floor on exit. The renderer's
    // updateCompactBars then fits the exact pool count.
    mainWindow.setMinimumSize(MIN_WIDGET_WIDTH, compact ? 80 : 180);
    // Compact view grows by one slim row per scoped weekly limit (e.g. Fable)
    const scopedCount = compact
      ? getScopedWeeklyLimits(store.get('latestUsageData') || {}).length
      : 0;
    const height = compact ? 105 + (scopedCount * 26) : WIDGET_HEIGHT;
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
    _lastSetHeight = mainWindow.getContentSize()[1];
  }
});

// ---- Settings window fit/restore ----
// While Settings is open the window grows to show EVERY setting and is not
// user-resizable; closing restores exactly the window the user had before.
// We size directly (not through the resize-window IPC) so the auto-fit
// trackers are left untouched — the restored bounds then line up with them.
let _preSettingsBounds = null;
ipcMain.on('settings-fit', (event, contentHeight, contentWidth) => {
  if (!mainWindow) return;
  if (!_preSettingsBounds) _preSettingsBounds = mainWindow.getBounds();
  mainWindow.setResizable(false);
  const bounds = mainWindow.getBounds();
  const [cw, curContentH] = mainWindow.getContentSize();
  const frame = Math.max(0, bounds.height - curContentH);
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const h = Math.max(200, Math.min(Math.round(contentHeight), workArea.height - frame));
  // Settings is a wide panel: it asks for its width too (0 = keep).
  const w = contentWidth > 0
    ? Math.max(290, Math.min(Math.round(contentWidth), workArea.width))
    : cw;
  mainWindow.setContentSize(w, h);
  const fitted = mainWindow.getBounds();
  const x = Math.min(Math.max(fitted.x, workArea.x), workArea.x + workArea.width - fitted.width);
  const y = Math.min(Math.max(fitted.y, workArea.y), workArea.y + workArea.height - fitted.height);
  if (x !== fitted.x || y !== fitted.y) mainWindow.setPosition(x, y);
});
ipcMain.on('settings-restore', (event, options = {}) => {
  if (!mainWindow) return;
  mainWindow.setResizable(true);
  // reCompact: the settings were opened from compact mode — the caller
  // re-enters compact itself, so don't restore the pre-compact bounds.
  if (!options.reCompact && _preSettingsBounds) mainWindow.setBounds(_preSettingsBounds);
  _preSettingsBounds = null;
});

// Wide / tall preset layouts. We deliberately do NOT touch _expectedWidth /
// _lastSetHeight here: leaving them at the widget defaults makes
// windowIsUserSized() report true, which is exactly what engages the
// renderer's landscape (wide) / tall reflow. The debounced 'resize' listener
// then broadcasts window-user-sized and the layout re-flows smoothly.
ipcMain.on('apply-window-preset', (event, preset) => {
  if (!mainWindow) return;
  const { screen } = require('electron');
  const b = mainWindow.getBounds();
  if (preset === 'reset') {
    // Return to the default auto-sized widget: restore the size trackers so
    // windowIsUserSized() reports false and the renderer resumes auto-height.
    _expectedWidth = WIDGET_WIDTH;
    _activeWindowPreset = null;
    _managedPresetWidth = null;
    mainWindow.setBounds({ x: b.x, y: b.y, width: WIDGET_WIDTH, height: WIDGET_HEIGHT });
    _lastSetHeight = mainWindow.getContentSize()[1];
    return;
  }
  let width, height;
  if (preset === 'wide') { width = WIDE_PRESET_WIDTH; height = 600; }
  else if (preset === 'tall') { width = WIDGET_WIDTH; height = 1150; }
  else return;
  _activeWindowPreset = preset;
  // Clamp to the current display's work area so a tall window can't run off
  // the bottom of the screen, and keep it fully on-screen.
  const wa = screen.getDisplayMatching(b).workArea;
  width = Math.min(width, wa.width);
  height = Math.min(height, wa.height);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  mainWindow.setBounds({ x, y, width, height });
  _managedPresetWidth = preset === 'wide' ? mainWindow.getBounds().width : null;
});

// ---- Detachable graph window IPC ----
ipcMain.on('open-graph-window', () => createGraphWindow());
ipcMain.on('close-graph-window', () => { if (graphWindow && !graphWindow.isDestroyed()) graphWindow.close(); });
ipcMain.handle('is-graph-window-open', () => !!(graphWindow && !graphWindow.isDestroyed()));
ipcMain.handle('get-latest-usage', () => store.get('latestUsageData', null));
ipcMain.on('graph-set-always-on-top', (event, flag) => {
  store.set('settings.graphAlwaysOnTop', !!flag);
  if (graphWindow && !graphWindow.isDestroyed()) graphWindow.setAlwaysOnTop(!!flag, 'floating');
});
ipcMain.handle('graph-get-always-on-top', () => store.get('settings.graphAlwaysOnTop', true));

// Settings handlers
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    theme: store.get('settings.theme', 'dark'),
    warnThreshold: store.get('settings.warnThreshold', 75),
    dangerThreshold: store.get('settings.dangerThreshold', 90),
    timeFormat: store.get('settings.timeFormat', '12h'),
    weeklyDateFormat: store.get('settings.weeklyDateFormat', 'date'),
    usageAlerts: store.get('settings.usageAlerts', true),
    compactMode: store.get('settings.compactMode', false),
    refreshInterval: store.get('settings.refreshInterval', '300'),
    graphVisible: store.get('settings.graphVisible', false),
    expandedOpen: store.get('settings.expandedOpen', true),
    openaiExtrasOpen: store.get('settings.openaiExtrasOpen', true),
    projectionsOn: store.get('settings.projectionsOn', true),
    showTrayStats: store.get('settings.showTrayStats', false),
    showClaudeCode: store.get('settings.showClaudeCode', true),
    trayColors: { ...DEFAULT_TRAY_COLORS, ...store.get('settings.trayColors', {}) },
    trayOutline: { ...DEFAULT_TRAY_OUTLINE, ...store.get('settings.trayOutline', {}) },
    burnAlerts: store.get('settings.burnAlerts', true),
    fontColor: store.get('settings.fontColor', { enabled: false, color: '#e0e0e0' }),
    webhook: store.get('settings.webhook', { enabled: false, url: '' }),
    dailyDigest: store.get('settings.dailyDigest', true),
    showCodex: store.get('settings.showCodex', true),
    showCodexCli: store.get('settings.showCodexCli', true),
    showGemini: store.get('settings.showGemini', true),
    showGeminiCli: store.get('settings.showGeminiCli', true),
    googleSource: store.get('settings.googleSource', 'auto'),
    trayOpenai: store.get('settings.trayOpenai', false),
    trayGoogle: store.get('settings.trayGoogle', false),
    sectionCollapsed: store.get('settings.sectionCollapsed', {}),
    subgroupHidden: store.get('settings.subgroupHidden', {}),
    pizazz: store.get('settings.pizazz', true),
    sortByUsage: store.get('settings.sortByUsage', false),
    hideAccountEmails: store.get('settings.hideAccountEmails', false),
    cliAdopted: cliAdoptionState(),
    hiddenProviders: store.get('settings.hiddenProviders', {}),
    flameStyle: store.get('settings.flameStyle', 'classic'),
    sounds: { ...DEFAULT_SOUNDS, ...store.get('settings.sounds', {}) },
    hiddenRows: store.get('settings.hiddenRows', {}),
    chartHiddenSeries: sanitizeHiddenSeries(store.get('settings.chartHiddenSeries', {}))
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  debugLog('[Settings] save-settings received:', JSON.stringify({
    trayOpenai: settings.trayOpenai, trayGoogle: settings.trayGoogle,
    sectionCollapsed: settings.sectionCollapsed, showTrayStats: settings.showTrayStats
  }));
  // Chart-relevant snapshot BEFORE the writes — the chart windows get pinged
  // only when one of these actually changed. (Previously every row-hide /
  // pizazz / subgroup patch triggered a full chart rebuild in both windows.)
  const chartRelevantSnapshot = () => JSON.stringify({
    theme: store.get('settings.theme', 'dark'),
    timeFormat: store.get('settings.timeFormat', '12h'),
    projectionsOn: store.get('settings.projectionsOn', true),
    chartHiddenSeries: store.get('settings.chartHiddenSeries', {})
  });
  const chartBefore = chartRelevantSnapshot();
  const supportsLoginItems = process.platform !== 'linux';
  const autoStart = supportsLoginItems ? settings.autoStart : false;

  store.set('settings.autoStart', autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.theme', settings.theme);
  store.set('settings.warnThreshold', settings.warnThreshold);
  store.set('settings.dangerThreshold', settings.dangerThreshold);
  store.set('settings.timeFormat', settings.timeFormat);
  store.set('settings.weeklyDateFormat', settings.weeklyDateFormat);
  store.set('settings.usageAlerts', settings.usageAlerts);
  store.set('settings.compactMode', settings.compactMode);
  store.set('settings.refreshInterval', settings.refreshInterval);
  store.set('settings.graphVisible', settings.graphVisible);
  store.set('settings.expandedOpen', settings.expandedOpen);
  if (settings.openaiExtrasOpen !== undefined) store.set('settings.openaiExtrasOpen', settings.openaiExtrasOpen !== false);
  if (settings.projectionsOn !== undefined) store.set('settings.projectionsOn', settings.projectionsOn !== false);
  store.set('settings.showTrayStats', settings.showTrayStats);
  store.set('settings.showClaudeCode', settings.showClaudeCode !== false);
  if (settings.trayColors) store.set('settings.trayColors', settings.trayColors);
  if (settings.trayOutline) store.set('settings.trayOutline', settings.trayOutline);
  store.set('settings.burnAlerts', settings.burnAlerts !== false);
  if (settings.fontColor) store.set('settings.fontColor', settings.fontColor);
  if (settings.webhook) store.set('settings.webhook', settings.webhook);
  store.set('settings.dailyDigest', settings.dailyDigest !== false);
  store.set('settings.showCodex', settings.showCodex !== false);
  store.set('settings.showCodexCli', settings.showCodexCli !== false);
  store.set('settings.showGemini', settings.showGemini !== false);
  store.set('settings.showGeminiCli', settings.showGeminiCli !== false);
  if (settings.googleSource !== undefined) {
    const src = ['auto', 'antigravity', 'gemini'].includes(settings.googleSource) ? settings.googleSource : 'auto';
    if (src !== store.get('settings.googleSource', 'auto')) {
      // Switching source invalidates both the provider cache and the rate-limit
      // backoff — the user expects the new surface to appear on the next tick.
      _antigravityLastAttempt = 0;
      delete _providerCache.gemini;
    }
    store.set('settings.googleSource', src);
  }
  if (settings.trayOpenai !== undefined) store.set('settings.trayOpenai', settings.trayOpenai === true);
  if (settings.trayGoogle !== undefined) store.set('settings.trayGoogle', settings.trayGoogle === true);
  if (settings.sectionCollapsed !== undefined) store.set('settings.sectionCollapsed', settings.sectionCollapsed || {});
  if (settings.subgroupHidden !== undefined) store.set('settings.subgroupHidden', settings.subgroupHidden || {});
  if (settings.pizazz !== undefined) store.set('settings.pizazz', settings.pizazz !== false);
  if (settings.sortByUsage !== undefined) store.set('settings.sortByUsage', settings.sortByUsage === true);
  if (settings.hideAccountEmails !== undefined) store.set('settings.hideAccountEmails', settings.hideAccountEmails === true);
  if (settings.hiddenProviders !== undefined && typeof settings.hiddenProviders === 'object') {
    const clean = {};
    for (const p of ['anthropic', 'openai', 'google']) clean[p] = settings.hiddenProviders[p] === true;
    store.set('settings.hiddenProviders', clean);
  }
  if (settings.flameStyle !== undefined) store.set('settings.flameStyle', settings.flameStyle === 'particle' ? 'particle' : 'classic');
  if (settings.sounds !== undefined) store.set('settings.sounds', sanitizeSounds(settings.sounds));
  if (settings.hiddenRows !== undefined) store.set('settings.hiddenRows', settings.hiddenRows || {});
  if (settings.chartHiddenSeries !== undefined) {
    store.set('settings.chartHiddenSeries', sanitizeHiddenSeries(settings.chartHiddenSeries));
  }

  const isPortable = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;

  // openAtLogin is not supported on Linux — Electron silently ignores it.
  // Skip the call entirely to avoid misleading behaviour.
  // Also skip for portable builds — autorun via registry is unreliable when the
  // exe path changes with each version. Users should use shell:startup instead.
  if (supportsLoginItems && !isPortable) {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      ...(process.platform !== 'darwin' && { path: app.getPath('exe') })
    });
  }

  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (settings.minimizeToTray) { app.dock.hide(); } else { app.dock.show(); }
    } else {
      mainWindow.setSkipTaskbar(settings.minimizeToTray);
    }
    applyMainWindowAlwaysOnTop();
  }
  if (chartRelevantSnapshot() !== chartBefore) {
    if (graphWindow && !graphWindow.isDestroyed()) {
      graphWindow.webContents.send('graph-settings-updated');
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('graph-settings-updated');
    }
  }

  if (!settings.showTrayStats) {
    // Turn off ONLY the Anthropic stats trays; OpenAI/Google badges follow
    // their own trayOpenai/trayGoogle settings — re-sync so they stay put.
    destroyStatsTrays();
    syncExternalProviderTrays(store.get('latestUsageData') || {});
  } else {
    // Refresh tray icons immediately with new threshold settings
    const latestUsageData = store.get('latestUsageData');
    if (latestUsageData) {
      updateTrayIcon(latestUsageData);
    } else {
      // Create empty tray icons now; the next usage refresh will draw the stats.
      createTray();
    }
  }
  syncRestoreTray();

  return true;
});

// Open a visible BrowserWindow for the user to log in to Claude.ai.
//
// Why we don't embed login directly in the app:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins.
// Instead, we open a standalone browser window, let the user authenticate
// normally, then capture the sessionKey cookie once login completes.
// Do NOT attempt to "fix" this back to an embedded login without verifying
// that Claude.ai/Cloudflare no longer blocks it.
//
// SECURITY: Navigation is restricted to trusted domains (claude.ai and OAuth
// providers) to prevent phishing attacks. Popup windows are blocked. Current
// URL is displayed in the window title bar for transparency.
// Main-internal: the captured key goes straight to validation + storage and
// never crosses into the widget renderer.
async function detectSessionKeyViaWindow() {
  // Clear any leftover sessionKey cookie
  try {
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) { /* ignore */ }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Claude Login - https://claude.ai/login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let resolved = false;

    // Security: restrict navigation to trusted domains only
    const allowedLoginDomains = [
      'claude.ai',
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com'
    ];

    loginWin.webContents.on('will-navigate', (event, url) => {
      try {
        const hostname = new URL(url).hostname;
        const isAllowed = allowedLoginDomains.some(domain =>
          hostname === domain || hostname.endsWith('.' + domain)
        );
        if (!isAllowed) {
          event.preventDefault();
          console.warn('[Security] Blocked login navigation to untrusted domain:', url);
        } else {
          // Update title bar to show current URL (read-only)
          loginWin.setTitle(`Claude Login - ${url}`);
        }
      } catch (err) {
        event.preventDefault();
        console.warn('[Security] Blocked login navigation with invalid URL:', url);
      }
    });

    // Update title on OAuth redirects and in-page navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    loginWin.webContents.on('did-navigate-in-page', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    // Security: block popup windows from login page
    loginWin.webContents.setWindowOpenHandler(() => {
      console.warn('[Security] Blocked popup window attempt from login page');
      return { action: 'deny' };
    });

    // Listen for sessionKey cookie being set after login. Cookies the app
    // writes itself (setSessionCookie during a background refresh) must not
    // complete the login with a stale key.
    const onCookieChanged = (event, cookie, cause, removed) => {
      if (_settingSessionCookie) return;
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        resolved = true;
        session.defaultSession.cookies.removeListener('changed', onCookieChanged);
        loginWin.close();
        resolve({ success: true, sessionKey: cookie.value });
      }
    };

    session.defaultSession.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' });
      }
    });

    loginWin.loadURL('https://claude.ai/login');
  });
}

// The complete Claude.ai login flow, kept entirely in the main process: the
// visible login window captures the cookie, the key is validated and stored
// (encrypted when possible), and only login STATE returns to the renderer.
let _anthropicLoginInFlight = false;
ipcMain.handle('anthropic-login', async () => {
  if (_anthropicLoginInFlight) {
    return { success: false, error: 'A sign-in is already in progress' };
  }
  _anthropicLoginInFlight = true;
  try {
    const detected = await detectSessionKeyViaWindow();
    if (!detected.success) return { success: false, error: detected.error || 'Login failed' };
    const validation = await validateSessionKey(detected.sessionKey);
    if (!validation.success) return { success: false, error: validation.error || 'Session invalid' };
    await saveAnthropicCredentials(detected.sessionKey, validation.organizationId, validation.organizations || []);
    return {
      success: true,
      organizationId: validation.organizationId,
      organizations: validation.organizations || []
    };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    _anthropicLoginInFlight = false;
  }
});

// ---- Auto-update (electron-updater) ----
// Downloads new fork releases in the background and applies them silently —
// no installer wizard. Renderer gets 'update-downloaded' and offers a
// one-click restart; otherwise the update applies on next quit.
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (err) {
  debugLog('[AutoUpdate] electron-updater unavailable:', err.message);
}

// On fast connections the download can finish before the renderer has
// registered its listener, so the ready signal is re-sent on every
// did-finish-load (createMainWindow wires this up).
let _downloadedUpdateVersion = null;
function sendUpdateReady() {
  if (_downloadedUpdateVersion && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-downloaded', _downloadedUpdateVersion);
  }
}

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  // Portable builds can't self-replace their exe — they keep the banner+link flow
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    debugLog('[AutoUpdate] Downloaded', info.version);
    _downloadedUpdateVersion = info.version;
    sendUpdateReady();
  });
  autoUpdater.on('error', (err) => debugLog('[AutoUpdate] Error:', err.message));

  const check = () => autoUpdater.checkForUpdates().catch((err) => debugLog('[AutoUpdate] Check failed:', err.message));
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

ipcMain.on('install-update', () => {
  if (autoUpdater) {
    // silent install, relaunch when done
    autoUpdater.quitAndInstall(true, true);
  }
});

// --- macOS self-update ------------------------------------------------------
// There are no signed Mac builds, so electron-updater cannot apply an update on
// darwin (Squirrel.Mac requires a matching code signature). macOS installs are
// instead built from source by tools/mac/install.sh, which records the clone
// path in ~/.burnwatch-repo. When that marker points at a real checkout we can
// offer the same one-click update the Windows banner has: quit, rebuild,
// replace the bundle, relaunch.
function macUpdateScript() {
  if (process.platform !== 'darwin') return null;
  try {
    const marker = path.join(os.homedir(), '.burnwatch-repo');
    if (!fs.existsSync(marker)) return null;
    const repo = fs.readFileSync(marker, 'utf8').trim();
    if (!repo) return null;
    const script = path.join(repo, 'tools', 'mac', 'update.sh');
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

ipcMain.on('run-mac-update', () => {
  const script = macUpdateScript();
  if (!script) return;
  try {
    const { spawn } = require('child_process');
    // detached + unref: the rebuild has to outlive the app it is replacing.
    // The script waits for us to exit, swaps the bundle, then relaunches.
    const child = spawn('/bin/bash', [script], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(script)
    });
    child.unref();
    debugLog('[MacUpdate] Rebuild spawned; quitting so the bundle can be replaced');
    // Give the child a moment to be fully handed off before we go away.
    setTimeout(() => app.quit(), 300);
  } catch (e) {
    debugLog('[MacUpdate] Could not start updater:', e.message);
  }
});

// Check GitHub releases for a newer version
ipcMain.handle('check-for-update', () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'claude-usage-widget',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          // Non-200 (rate limit 403, transient 5xx, etc.) is a FAILED check,
          // not "up to date" — flag it so the renderer can retry rather than
          // silently give up until the next scheduled poll.
          if (res.statusCode !== 200) {
            resolve({ hasUpdate: false, version: null, error: true });
            return;
          }
          const data = JSON.parse(body);
          const tag = (data.tag_name || '').replace(/^v/, '');
          const current = app.getVersion();
          if (tag && isNewerVersion(tag, current)) {
            // canSelfUpdate: darwin build-from-source install that can apply
            // the update itself, so the banner offers "update" not "download".
            resolve({ hasUpdate: true, version: tag, canSelfUpdate: !!macUpdateScript() });
          } else {
            resolve({ hasUpdate: false, version: null });
          }
        } catch {
          resolve({ hasUpdate: false, version: null, error: true });
        }
      });
    });

    req.on('error', () => resolve({ hasUpdate: false, version: null, error: true }));
    req.on('timeout', () => { req.destroy(); resolve({ hasUpdate: false, version: null, error: true }); });
    req.end();
  });
});

function isNewerVersion(remote, local) {
  try {
    const parseVersion = (ver) => {
      const [mainVer, preRelease] = ver.split('-');
      const parts = mainVer.split('.').map(Number);
      return {
        major: parts[0] || 0,
        minor: parts[1] || 0,
        patch: parts[2] || 0,
        preRelease: preRelease || null
      };
    };

    const r = parseVersion(remote);
    const l = parseVersion(local);

    // Never notify about pre-release versions (rc, beta, alpha, etc.)
    if (r.preRelease !== null) return false;

    // Compare major.minor.patch
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;

    // Same version numbers — notify if local is a pre-release and remote is stable
    // e.g. local=1.7.5-rc.1, remote=1.7.5 → user should be told stable is out
    return l.preRelease !== null;
  } catch { return false; }
}

// ---- Degraded-session tracking ----
// Only explicit 401/403s wipe credentials (transient Cloudflare/HTML blocks
// must not). But a session that is genuinely dead behind an HTML block would
// otherwise retry silently forever with stale rows — so after a few
// consecutive failures the renderer shows a quiet non-destructive banner.
let _anthropicFailStreak = 0;
const ANTHROPIC_DEGRADED_AFTER = 3;
function noteAnthropicFetchOutcome(ok) {
  _anthropicFailStreak = ok ? 0 : _anthropicFailStreak + 1;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('anthropic-fetch-degraded', _anthropicFailStreak >= ANTHROPIC_DEGRADED_AFTER);
  }
}

// The account email shown under the Anthropic header. Rides the same
// Cloudflare-bypassing hidden window as the usage fetch, and is cached for the
// session so it costs one request, not one per refresh. Mirrors the Tauri
// build's account_email (which reads the same claude.ai/api/account shape).
let _anthropicEmailCache = null;
async function fetchAnthropicEmail() {
  if (_anthropicEmailCache) return _anthropicEmailCache;
  try {
    const acct = await fetchViaWindow('https://claude.ai/api/account', { timeoutMs: 10000 });
    const email = acct?.email_address || acct?.email
      || acct?.account?.email_address || acct?.account?.email || null;
    if (email) _anthropicEmailCache = email;
    return email;
  } catch (error) {
    debugLog('Anthropic email fetch failed:', error?.message || error);
    return null;
  }
}

ipcMain.handle('fetch-usage-data', async (event, options = {}) => {
  options = sanitizeFetchOptions(options);
  if (options.refreshLocalCredentials === true) resetLocalCredentialCaches();
  const providerFetchOptions = { force: options.forceProviders === true };
  const sessionKey = readStoredSessionKey();
  const organizationId = store.get('organizationId');
  const cliAdopted = cliAdoptionState();

  if (!sessionKey || !organizationId) {
    // Anthropic CLI fallback: no claude.ai login, but the claude CLI's local
    // credentials can power the section — same pattern as OpenAI/Google
    // ("via CLI login"). Extra Usage / credits need the web login and are
    // simply absent in this mode.
    const [cc, codexF, geminiF] = await Promise.all([
      (cliAdopted.anthropic && readClaudeCodeToken())
        ? cachedProviderFetch('claude_code', fetchClaudeCodeUsage, providerFetchOptions)
        : Promise.resolve(null),
      (store.get('settings.showCodex', true) || store.get('settings.showCodexCli', true))
        ? cachedProviderFetch('codex', fetchCodexUsage, providerFetchOptions)
        : Promise.resolve(null),
      (store.get('settings.showGemini', true) || store.get('settings.showGeminiCli', true))
        ? cachedProviderFetch('gemini', fetchGoogleUsage, providerFetchOptions)
        : Promise.resolve(null)
    ]);
    const hasClaudeUsage = !!(cc && (cc.five_hour?.resets_at || cc.seven_day?.resets_at));
    const offers = detectCliOffers(cliAdopted);
    const googleConnection = getGoogleConnectionStatus();
    if (!hasClaudeUsage && !codexF && !geminiF && !Object.keys(offers).length && !googleConnection.connected) {
      throw new Error('Missing credentials');
    }
    const data = {
      five_hour: hasClaudeUsage ? cc.five_hour : null,
      seven_day: hasClaudeUsage ? cc.seven_day : null,
      limits: hasClaudeUsage ? (cc.limits || []) : [],
      anthropic_source: hasClaudeUsage ? 'cli' : 'none',
      claude_code_same_account: hasClaudeUsage,
      googleConnection
    };
    if (codexF) data.codex = codexF;
    if (geminiF) data.gemini = geminiF;
    data.offers = offers;
    // History records the UNFILTERED accounts: the visibility toggles are a
    // display choice and must never change which account a series records.
    await storeUsageHistory(data); // no organizationId → default history scope
    applyAccountToggles(data);
    data.forecasts = computeForecasts();
    data.sessionPlans = computeSessionPlans();
    data.frozenProviders = computeFrozenProviders(data);
    checkBurnAnomalies();
    data.burningSeries = getBurningSeriesMap();
    checkDailyDigest(data);
    store.set('latestUsageData', data);
    notifyGraphWindow();
    updateTrayIcon(data);
    return data;
  }

  // Kick off the Claude Code (CLI) and Codex account fetches concurrently
  // with the claude.ai one; each resolves to null on any failure.
  const claudeCodePromise = (store.get('settings.showClaudeCode', true) && cliAdopted.anthropic)
    ? cachedProviderFetch('claude_code', fetchClaudeCodeUsage, providerFetchOptions)
    : Promise.resolve(null);
  const codexPromise = (store.get('settings.showCodex', true) || store.get('settings.showCodexCli', true))
    ? cachedProviderFetch('codex', fetchCodexUsage, providerFetchOptions)
    : Promise.resolve(null);
  const geminiPromise = (store.get('settings.showGemini', true) || store.get('settings.showGeminiCli', true))
    ? cachedProviderFetch('gemini', fetchGoogleUsage, providerFetchOptions)
    : Promise.resolve(null);

  // Ensure cookie is set
  await setSessionCookie(sessionKey);

  // Conditional API polling: Only fetch overage/prepaid if the expand panel is open
  // or if compact mode is disabled (normal mode). This reduces API calls when the
  // user won't see the extra usage data anyway.
  // If forceExtended is passed (e.g., when user clicks expand), use that instead of saved setting
  const expandedOpen = typeof options.forceExtended === 'boolean'
    ? options.forceExtended
    : store.get('settings.expandedOpen', true);
  const shouldFetchExtended = expandedOpen;

  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;
  const overageUrl = `https://claude.ai/api/organizations/${organizationId}/overage_spend_limit`;
  const prepaidUrl = `https://claude.ai/api/organizations/${organizationId}/prepaid/credits`;

  // Fetch mandatory usage by itself so optional credits endpoints can never
  // suppress valid usage data or enter the credential-expiry path.
  let data;
  try {
    data = await fetchViaWindow(usageUrl);
  } catch (error) {
    debugLog('API request failed:', error.message);
    if (isExplicitAuthFailure(error)) {
      noteAnthropicFetchOutcome(true); // renderer switches to login state — banner off
      store.delete('sessionKey');
      store.delete('sessionKey_encrypted');
      store.delete('organizationId');
      if (mainWindow) mainWindow.webContents.send('session-expired');
      throw new Error('SessionExpired');
    }
    // Cloudflare, HTML, timeouts, and network failures are transient. Keep
    // credentials so the next scheduled refresh can recover automatically —
    // but count the streak so a persistent block surfaces a banner.
    noteAnthropicFetchOutcome(false);
    throw error;
  }

  if (isExplicitAuthFailure(data)) {
    noteAnthropicFetchOutcome(true);
    store.delete('sessionKey');
    store.delete('sessionKey_encrypted');
    store.delete('organizationId');
    if (mainWindow) mainWindow.webContents.send('session-expired');
    throw new Error('SessionExpired');
  }
  noteAnthropicFetchOutcome(true);

  // Label the Anthropic section with the signed-in account's email (cached).
  const anthropicEmail = await fetchAnthropicEmail();
  if (anthropicEmail) data.anthropic_email = anthropicEmail;

  let overageResult = { status: 'skipped', reason: 'UI panel not visible' };
  let prepaidResult = { status: 'skipped', reason: 'UI panel not visible' };
  if (shouldFetchExtended) {
    debugLog('[Conditional Polling] Fetching extended data (overage + prepaid) - panel is visible');
    [overageResult, prepaidResult] = await Promise.allSettled([
      fetchViaWindow(overageUrl, { timeoutMs: 10000 }),
      fetchViaWindow(prepaidUrl, { timeoutMs: 10000 })
    ]);
  } else {
    debugLog('[Conditional Polling] Skipping extended data - panel not visible');
  }

  // Merge overage spending data into data.extra_usage
  if (overageResult.status === 'fulfilled' && overageResult.value) {
    const overage = overageResult.value;
    const limit = overage.monthly_credit_limit ?? overage.spend_limit_amount_cents;
    const used = overage.used_credits ?? overage.balance_cents;
    const enabled = overage.is_enabled !== undefined ? overage.is_enabled : (limit != null);

    if (enabled && typeof limit === 'number' && limit > 0 && typeof used === 'number') {
      data.extra_usage = {
        utilization: (used / limit) * 100,
        resets_at: null,
        used_cents: used,
        limit_cents: limit,
        is_enabled: true,
        currency: overage.currency || 'USD',
      };
    } else if (!enabled) {
      // Extra usage is off — still pass the flag so the renderer can show status
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.is_enabled = false;
      data.extra_usage.currency = overage.currency || 'USD';
    }
  } else {
    debugLog('Overage fetch skipped or failed:', overageResult.reason?.message || 'no data');
  }

  // Merge prepaid balance into data.extra_usage
  if (prepaidResult.status === 'fulfilled' && prepaidResult.value) {
    const prepaid = prepaidResult.value;
    if (typeof prepaid.amount === 'number') {
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.balance_cents = prepaid.amount;
      // Use prepaid currency if overage didn't already set one
      if (!data.extra_usage.currency && prepaid.currency) {
        data.extra_usage.currency = prepaid.currency;
      }
    }
  } else {
    debugLog('Prepaid fetch skipped or failed:', prepaidResult.reason?.message || 'no data');
  }

  // Attach the Claude Code (CLI) account usage, if available. A live account
  // always carries resets_at timestamps — anything else is a dead session.
  const claudeCode = await claudeCodePromise;
  if (claudeCode && (claudeCode.five_hour?.resets_at || claudeCode.seven_day?.resets_at)) {
    data.claude_code = claudeCode;
  }
  // Merged mode: CLI login matches the web login — CLI rows would duplicate
  data.claude_code_same_account = detectClaudeCliSameAccount(data);
  const codex = await codexPromise;
  if (codex) data.codex = codex;
  const gemini = await geminiPromise;
  if (gemini) data.gemini = gemini;
  data.googleConnection = getGoogleConnectionStatus();
  data.offers = detectCliOffers(cliAdopted);

  // History records the UNFILTERED accounts: the visibility toggles are a
  // display choice and must never change which account a series records
  // (previously, hiding the desktop account silently spliced the CLI
  // account's numbers into the desktop account's series).
  await storeUsageHistory(data);
  applyAccountToggles(data);

  // Burn-rate forecasts, anomaly check, planner, digest — after the new sample lands
  data.forecasts = computeForecasts();
  data.sessionPlans = computeSessionPlans();
  data.frozenProviders = computeFrozenProviders(data);
  checkBurnAnomalies();
  data.burningSeries = getBurningSeriesMap();
  checkDailyDigest(data);

  // Store latest usage data for settings refresh
  store.set('latestUsageData', data);
  notifyGraphWindow();

  // Update tray icon with current usage data
  updateTrayIcon(data);

  // Re-assert always-on-top after hidden BrowserWindows from fetchViaWindow
  // are destroyed — creating/destroying BrowserWindows can temporarily disrupt
  // the main window's z-order on some OS/window manager combinations.
  applyMainWindowAlwaysOnTop();
  if (graphWindow && !graphWindow.isDestroyed() && store.get('settings.graphAlwaysOnTop', true)) {
    graphWindow.setAlwaysOnTop(true, 'floating');
  }

  return data;
});

// App lifecycle
app.whenReady().then(async () => {
  setupAutoUpdate();

  // Restore session cookie if we have stored credentials
  const sessionKey = readStoredSessionKey();
  if (sessionKey) {
    await setSessionCookie(sessionKey);
  }

  // One-time translation of legacy chart-legend keys (v2.1.1 stored labels;
  // the charts now key visibility by stable series id).
  const storedHiddenSeries = store.get('settings.chartHiddenSeries');
  if (storedHiddenSeries && Object.keys(storedHiddenSeries).some((key) => !String(key).includes(':'))) {
    store.set('settings.chartHiddenSeries', migrateHiddenSeriesLabels(storedHiddenSeries));
    debugLog('[Settings] Migrated legacy chartHiddenSeries label keys to series ids');
  }

  // History migration must never take the app down with it: any failure here
  // (disk, validation) degrades to "history unavailable this run", not
  // "no window, no tray, invisible process holding the instance lock".
  try {
    await migrateUsageHistoryStorage();
  } catch (err) {
    console.error('[History] Migration failed — continuing without it, legacy data left untouched:', err.message);
  }
  try {
    pruneStaleBurnAlertCounters();
  } catch (err) {
    debugLog('[Startup] Burn-alert counter pruning failed:', err.message);
  }

  createMainWindow();
  // Avoid creating temporary tray icons during startup when tray stats are disabled.
  if (store.get('settings.showTrayStats', false)) {
    createTray();
  }

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (minimizeToTray) app.dock.hide();
    } else {
      if (minimizeToTray) mainWindow.setSkipTaskbar(true);
    }
    applyMainWindowAlwaysOnTop();
  }
  syncRestoreTray();

  // Periodic always-on-top re-assertion to recover from z-order disruptions
  // (window manager shortcuts, alt-tab, other apps asserting topmost). The
  // old per-request hidden fetch windows were the main disruptor; with the
  // persistent fetch window a 30s cadence is plenty.
  setInterval(() => {
    applyMainWindowAlwaysOnTop();
    // Re-assert the detached graph AFTER the widget so a pinned graph window
    // isn't repeatedly covered by the widget's topmost re-assertion.
    if (graphWindow && !graphWindow.isDestroyed() && store.get('settings.graphAlwaysOnTop', true)) {
      graphWindow.setAlwaysOnTop(true, 'floating');
    }
  }, 30000);

  // History file retention runs off the fetch path: once at startup, then
  // twice a day. (Appends no longer prune inline.)
  const pruneHistoryFiles = () => {
    historyStore.pruneExpiredFiles(currentHistoryScope())
      .catch((err) => debugLog('[History] Retention prune failed:', err.message));
  };
  pruneHistoryFiles();
  setInterval(pruneHistoryFiles, 12 * 60 * 60 * 1000);
}).catch((err) => {
  console.error('[Startup] Initialization error:', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (!hasTrayIcon()) app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  showMainWindowSmart();
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindowSmart();
  });
}
