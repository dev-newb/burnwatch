/**
 * fetch-via-window.js
 *
 * Fetches JSON from claude.ai through a hidden BrowserWindow.
 *
 * Why this exists:
 * Claude.ai (Cloudflare) blocks Electron's plain net/fetch fingerprints, but
 * a real Chromium page context riding the session cookies passes. Until
 * v2.1.1 every request spawned a fresh hidden BrowserWindow — an entire
 * renderer process per endpoint, several times per refresh cycle. This
 * version parks ONE reusable hidden window on a cheap claude.ai page and
 * runs in-page fetch() calls inside it:
 *   - ~90% less process churn (and none of the z-order disruption the old
 *     window spawning caused),
 *   - real HTTP status codes, so 401/403 becomes an explicit AuthFailure
 *     instead of a body-shape guess,
 *   - self-healing: any wedged/blocked/crashed state discards the window
 *     and the next call starts clean.
 */
const { BrowserWindow } = require('electron');

/**
 * Known error signatures returned when Claude.ai blocks or changes behaviour.
 * If the extracted body matches one of these patterns we throw a specific error
 * so callers can react (e.g. prompt re-login).
 */
const BLOCKED_SIGNATURES = [
  { pattern: 'Just a moment', error: 'CloudflareBlocked' },
  { pattern: 'Enable JavaScript and cookies to continue', error: 'CloudflareChallenge' },
  { pattern: '<html', error: 'UnexpectedHTML' },
];

/**
 * Parse and validate response body text
 * @param {string} bodyText - Raw body text from the page
 * @returns {Object} Parsed JSON data
 * @throws {Error} If blocked signatures detected or JSON parsing fails
 */
function parseResponseBody(bodyText) {
  // Detect known block/failure signatures before attempting JSON parse.
  // This provides explicit errors when Claude.ai modifies their API or CSP.
  for (const sig of BLOCKED_SIGNATURES) {
    if (bodyText.includes(sig.pattern)) {
      throw new Error(`${sig.error}: ${bodyText.substring(0, 200)}`);
    }
  }

  try {
    return JSON.parse(bodyText);
  } catch (parseErr) {
    throw new Error('InvalidJSON: ' + bodyText.substring(0, 200));
  }
}

/**
 * Status-aware classification for in-page fetch results. JSON 401/403 throw an
 * error carrying statusCode so isExplicitAuthFailure() can recognize a dead
 * session without guessing from the body shape.
 * @param {{status: number, bodyText: string}} result
 */
function classifyFetchResult(result) {
  const status = Number(result?.status);
  // A challenge page or malformed body does not establish an expired login.
  const data = parseResponseBody(String(result?.bodyText ?? ''));
  if (status === 401 || status === 403) {
    const error = new Error(`AuthFailure: HTTP ${status}`);
    error.statusCode = status;
    throw error;
  }
  if (!(status >= 200 && status < 300)) throw new Error(`HTTPFailure: HTTP ${status}`);
  return data;
}

// The parked page: cheap, same-origin, and rarely challenged. If Cloudflare
// does challenge an API fetch, the window is discarded and rebuilt on the
// next call (see fetchViaWindow).
const ANCHOR_URL = 'https://claude.ai/robots.txt';
const IDLE_TEARDOWN_MS = 10 * 60 * 1000;

let _win = null;
let _winReady = null;
let _idleTimer = null;

function destroyFetchWindow() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const win = _win;
  _win = null;
  _winReady = null;
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch {}
  }
}

function _scheduleIdleTeardown() {
  if (_idleTimer) clearTimeout(_idleTimer);
  // Free the renderer process after a quiet stretch; recreated on demand.
  _idleTimer = setTimeout(destroyFetchWindow, IDLE_TEARDOWN_MS);
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

function _ensureWindow(timeoutMs) {
  if (_win && !_win.isDestroyed() && _winReady) return _winReady;

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.webContents.on('render-process-gone', () => {
    if (_win === win) destroyFetchWindow();
  });
  win.on('closed', () => {
    if (_win === win) { _win = null; _winReady = null; }
  });

  _win = win;
  _winReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      destroyFetchWindow();
      reject(new Error('Request timeout'));
    }, timeoutMs);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(win);
    });
    win.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
      clearTimeout(timer);
      destroyFetchWindow();
      reject(new Error(`LoadFailed: ${errorCode} ${errorDescription}`));
    });
    win.loadURL(ANCHOR_URL);
  });
  return _winReady;
}

/**
 * Fetch a URL in the shared hidden window's page context.
 * @param {string} url - URL to fetch (claude.ai origin)
 * @param {Object} options - Options object
 * @param {number} options.timeoutMs - Request timeout in milliseconds (default: 30000)
 * @returns {Promise<Object>} Parsed JSON response
 */
async function fetchViaWindow(url, { timeoutMs = 30000 } = {}) {
  const win = await _ensureWindow(timeoutMs);
  _scheduleIdleTeardown();

  const script = `
    (async () => {
      const res = await fetch(${JSON.stringify(url)}, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      const bodyText = await res.text();
      return { status: res.status, bodyText };
    })()
  `;

  let result;
  try {
    result = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), timeoutMs))
    ]);
  } catch (err) {
    // A wedged or navigated-away window is worthless — discard it so the
    // next call starts from a clean navigation.
    destroyFetchWindow();
    throw err;
  }

  try {
    return classifyFetchResult(result);
  } catch (err) {
    // A Cloudflare block means the parked page lost its clearance; rebuild
    // rather than reuse. (UnexpectedHTML/InvalidJSON keep the window — those
    // are usually endpoint-shaped problems, not session-shaped ones.)
    if (/^(CloudflareBlocked|CloudflareChallenge)/.test(err.message)) destroyFetchWindow();
    throw err;
  }
}

module.exports = { fetchViaWindow, parseResponseBody, classifyFetchResult, destroyFetchWindow };
