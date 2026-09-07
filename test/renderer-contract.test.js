'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const repoDir = path.join(__dirname, '..');

test('compact accounts use ribbons instead of terminal cursors', () => {
  const source = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.match(source, /compact-ribbon/);
  assert.doesNotMatch(source, /labelEl\.textContent = p\.code \+ \(p\.cli \? '_' : ''\);/);
});

test('both charts preserve gaps and persist stable series identifiers', () => {
  for (const name of ['app.js', 'graph.js']) {
    const source = fs.readFileSync(path.join(rendererDir, name), 'utf8');
    assert.match(source, /spanGaps: false/);
    assert.match(source, /seriesId/);
    assert.doesNotMatch(source, /y:\s*pick\(e\)\s*\|\|\s*0/);
  }
});

test('sandboxed preload stays self-contained and strictly sanitizes fetch options', () => {
  const source = fs.readFileSync(path.join(repoDir, 'preload.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\/src\//);
  assert.match(source, /value\.forceExtended === true/);
  assert.match(source, /value\.forceProviders === true/);
  assert.match(source, /value\.refreshLocalCredentials === true/);
  assert.doesNotMatch(source, /\.\.\.value/);
});

test('wide layout keeps the requested graph and toolbar control placement', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');

  assert.match(html, /title-caption[\s\S]*id="minimizeBtn"[\s\S]*id="wideBtn"/);
  assert.match(html, /toolbar-group-play[\s\S]*toolbar-spacer[\s\S]*toolbar-group-utility/);
  assert.match(css, /\.psychic-btn\s*\{[\s\S]*bottom:\s*6px;[\s\S]*right:\s*10px;/);
  assert.match(css, /\.graph-popout-btn\s*\{[\s\S]*top:\s*6px;[\s\S]*right:\s*8px;/);
  assert.match(css, /body\.landscape \.graph-section\s*\{[\s\S]*align-self:\s*stretch;/);
  assert.doesNotMatch(app, /elements\.(?:settingsBtn|refreshBtn|graphBtn)\.style\.display = 'none';/);
});

test('Claude login lives in Settings and follows fresh credential state', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');

  assert.doesNotMatch(html, /Connect to Claude\.ai/);
  assert.match(html, /id="anthropicLoginStatus">Not connected</);
  assert.match(html, /id="logoutBtn"[^>]*>Log In</);
  assert.match(app, /async function loadSettings\(\)[\s\S]*credentials = await window\.electronAPI\.getCredentials\(\);[\s\S]*syncAnthropicAuthControls\(\);/);
  assert.match(app, /elements\.logoutBtn\.textContent = connected \? 'Log Out' : 'Log In';/);
});

test('second toolbar provides a dedicated forced rescan for local CLI accounts', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');

  assert.match(html, /toolbar-group-utility[\s\S]*id="refreshBtn"[\s\S]*id="refreshLocalLoginsBtn"[\s\S]*id="graphBtn"[\s\S]*id="settingsBtn"/);
  assert.doesNotMatch(html, /settings-account-refresh/);
  assert.match(app, /async function refreshLocalLogins\(\)[\s\S]*getCredentials\(\)[\s\S]*localProviderCredentialsAvailable[\s\S]*refreshLocalCredentials: true/);
  assert.doesNotMatch(app, /button\.textContent = 'Refresh local logins'/);
});

test('local credential rescan clears account-bound provider caches', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');

  assert.match(main, /function resetLocalCredentialCaches\(\)[\s\S]*clearCredentialHomeCache\(\)[\s\S]*_geminiAccessToken = \{ token: null, expiresAt: 0 \};[\s\S]*_ccSameState = \{ mode: null, candidate: null, streak: 0 \};[\s\S]*delete _providerCache\[key\]/);
  assert.match(main, /options\.refreshLocalCredentials === true\) resetLocalCredentialCaches\(\)/);
  assert.match(main, /localProviderCredentialsAvailable: claudeCliAvailable \|\| hasLocalProviderCredentials\(\)/);
});

test('Claude and Codex local login discovery includes WSL and avoids desktop-account masking', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');

  assert.match(main, /require\('\.\/src\/local-credential-sources'\)/);
  assert.match(main, /localCredentialFiles\('\.claude', '\.credentials\.json'\)/);
  assert.match(main, /localCredentialFiles\('\.codex', 'auth\.json'\)/);
  assert.match(main, /Number\(b\.kind === 'wsl'\) - Number\(a\.kind === 'wsl'\)/);
  assert.match(main, /usableCliResults\.find\([\s\S]*result\.data\.accountId !== primary\.accountId/);
  assert.match(main, /path\.join\(source\.home, '\.codex', 'sessions'\)/);
});

test('Codex CLI credits and banked resets render beside the CLI account in every wide mode', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

  assert.match(app, /appendCodexCreditsRow\(data\.codex\?\.cli, 'codex_cli_row_credits', elements\.openaiCliRows/);
  assert.match(app, /appendCodexResetsRow\(data\.codex\?\.cli, 'codex_cli_row_resets', elements\.openaiCliRows/);
  assert.match(app, /cliCredits = hiddenRows\.codex_cli_row_credits \? null : creditInfo\(d\.cli\.credits\)/);
  assert.match(app, /cliResets = hiddenRows\.codex_cli_row_resets \? null : resetInfo\(d\.cli\.resetCredits\)/);
  assert.match(app, /info\.kind === 'summary'[\s\S]*dual-special-value/);
  assert.match(css, /\.dual-pair\.special\s*\{[\s\S]*grid-template-columns: 1fr;/);
});

test('Gemini quota discovery uses the CLI account project and preserves fallback behavior', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');

  assert.match(main, /postGeminiCodeAssist\(token, 'loadCodeAssist',[\s\S]*pluginType: 'GEMINI'/);
  assert.match(main, /load\?\.cloudaicompanionProject[\s\S]*postGeminiCodeAssist\(token, 'retrieveUserQuota', project \? \{ project \} : \{\}\)/);
  assert.match(main, /const normalized = normalizeGeminiQuota\(quota\);/);
});

test('window presets remain user-sized and enforce the narrow-layout floor', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');

  assert.match(main, /const MIN_WIDGET_WIDTH = 290;/);
  assert.match(main, /minWidth: MIN_WIDGET_WIDTH/);
  assert.match(main, /setMinimumSize\(MIN_WIDGET_WIDTH,/);
  assert.match(main, /if \(_activeWindowPreset !== null\) return true;/);
  assert.match(main, /_activeWindowPreset = preset;[\s\S]*mainWindow\.setBounds\(\{ x, y, width, height \}\);/);
  assert.match(main, /preset === 'reset'[\s\S]*_activeWindowPreset = null;/);
});

test('hidden charts collapse preset height without surrendering manual resize', () => {
  const preload = fs.readFileSync(path.join(repoDir, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

  assert.match(app, /classList\.toggle\('graph-off', !_graphIsInline\(\)\)/);
  assert.match(app, /_forceFitHeight\(\{ fitPreset: true, intrinsic: true \}\)/);
  assert.match(css, /body\.landscape\.graph-off:not\(\.compact-mode\) \.content\s*\{[\s\S]*grid-template-rows: auto;/);
  assert.match(preload, /resizeWindow: \(height, force, fitPreset, userAction\)/);
  assert.match(main, /explicitPresetFit = fitPreset === true && _activeWindowPreset !== null/);
  // Direct user actions (graph toggle, burn, hide) may adopt the new content
  // height even in a hand-sized window; background refits never may.
  assert.match(main, /const explicitUserAction = userAction === true;/);
  assert.match(main, /if \(windowIsUserSized\(\) && !explicitPresetFit && !explicitUserAction\) return;/);
});

test('ultra-wide provider columns restore full dual-account rows', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

  assert.match(app, /classList\.toggle\('dual-compact', landscape && eff < 450\)/);
  assert.match(css, /body\.landscape\.dual-compact \.section-body\.has-dual \.dual-table/);
  assert.doesNotMatch(css, /body\.landscape \.section-body\.has-dual \.dual-table/);
  assert.doesNotMatch(css, /body\.landscape #sgGoogleCli \.usage-label/);
  assert.match(css, /body\.landscape\.vh-short\.dual-compact \.dual-table > \.dual-head:nth-child\(2\)[\s\S]*display: none;/);
});

test('collapsed landscape CLI groups become terminal buttons and release preset-owned width', () => {
  const preload = fs.readFileSync(path.join(repoDir, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

  assert.match(preload, /fitLandscapeWidth: \(width\) => ipcRenderer\.send\('fit-landscape-width', Number\(width\) \|\| 0\)/);
  assert.match(main, /ipcMain\.on\('fit-landscape-width'[\s\S]*Math\.abs\(bounds\.width - _managedPresetWidth\) > PRESET_WIDTH_TOLERANCE[\s\S]*_managedPresetWidth = null/);
  // Collapsed columns get a fixed narrow width; the window shrinks to fit them
  assert.match(app, /function syncLandscapeCliWidth\(\)[\s\S]*COLLAPSED_COL_W[\s\S]*fitLandscapeWidth\(Math\.max\(786, target\)\)/);
  assert.match(app, /if \(!hidden\) \{[\s\S]*table\.classList\.remove\('hide-cli'\)[\s\S]*syncLandscapeCliWidth\(\)/);
  assert.match(css, /body\.landscape \.dual-table\.hide-cli \.dual-row,[\s\S]*grid-template-columns: minmax\(42px, 46px\) minmax\(0, 1fr\) 24px;/);
  assert.match(css, /\.dual-table\.hide-cli \.dual-pill::after\s*\{[\s\S]*content: '>_';/);
});

test('diagnostic launch avoids the Electron-reserved debug flag', () => {
  const source = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  assert.match(source, /process\.argv\.includes\('--burnwatch-debug'\)/);
  assert.doesNotMatch(source, /process\.argv\.includes\('--debug'\)/);
});

test('the session key never crosses into the renderer', () => {
  const preload = fs.readFileSync(path.join(repoDir, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  // The old key-carrying IPC surface is gone; login state is all that crosses.
  assert.doesNotMatch(preload, /save-credentials|validate-session-key|detect-session-key/);
  assert.match(preload, /anthropicLogin: \(\) => ipcRenderer\.invoke\('anthropic-login'\)/);
  assert.match(main, /loggedIn: !!readStoredSessionKey\(\)/);
  // Diagnostics never print any part of the key or OAuth account identity.
  assert.doesNotMatch(main, /sessionKey\.substring/);
  assert.doesNotMatch(main, /Connected as`, tokens\.email/);
});

test('sort-by-usage is whitelisted on both sides and wired in the renderer', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.match(main, /sortByUsage: store\.get\('settings\.sortByUsage', false\)/);
  assert.match(main, /store\.set\('settings\.sortByUsage', settings\.sortByUsage === true\)/);
  assert.match(app, /function _sortRowsByUsage\(\)/);
  assert.match(html, /id="sortByUsageToggle"/);
});

test('the compact chevron ghost is fully gone (markup, styles, wiring)', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  for (const source of [app, html, css]) {
    assert.doesNotMatch(source, /compact-(collapse|expand)-btn|compactCollapseBtn|compactExpandBtn/);
  }
});

test('burn-detector fire is wired end to end in the pool colour', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  // main tracks burning state with settle hysteresis and ships it in the snapshot
  assert.match(main, /function getBurningSeriesMap\(\)/);
  assert.match(main, /data\.burningSeries = getBurningSeriesMap\(\);/);
  assert.match(main, /BURN_SETTLE_MS/);
  // renderer maps series onto rows and tints the flame from the bar's colour
  assert.match(app, /function computeBurningRowKeys\(data\)/);
  assert.match(app, /_burningRowKeys = computeBurningRowKeys\(data\);/);
  assert.match(app, /--fire-col/);
  // CSS: heat underlay on full and compact bars, and the live pixel-fire loop
  // that actually burns them
  assert.match(css, /\.progress-fill\.on-fire:not\(\.maxed\),\s*\.compact-bar-fill\.on-fire:not\(\.maxed\)/);
  assert.match(css, /\.ambient-fire/);
  // The orbs' flame is the pixel engine, never a CSS tongue: a gradient read
  // as a glow, and with animations off it sat frozen on top of the circle,
  // making a round orb look deformed. No-pizazz drops the fire layer whole.
  assert.doesNotMatch(css, /\.reset-dot::(before|after)/);
  assert.match(css, /body\.no-pizazz \.reset-dot \.fx/);
  assert.match(app, /function _tickElementFire/);
  assert.match(app, /_spawnPixelFlame\(layer, _rnd\(0, width\), _rnd\(240, 460\), Math\.random\(\) < 0\.1, palette\)/);
  // Flame style: persisted on both sides, both engines present, and switched
  // by CLICKING a burning bar (not a Settings control)
  assert.match(main, /flameStyle: store\.get\('settings\.flameStyle', 'classic'\)/);
  assert.match(main, /settings\.flameStyle === 'particle' \? 'particle' : 'classic'/);
  assert.match(app, /function _spawnFireParticle/);
  assert.match(app, /_saveSettingsPatch\(\{ flameStyle: next \}\)/);
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="flameStyle"/);
});

test('flame palette accepts every colour form its callers pass', () => {
  const src = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const start = src.indexOf('function _toHex(');
  const end = src.indexOf('// Chunky flame sprite');
  assert.ok(start > 0 && end > start, 'palette helpers not found');
  const block = 'const _paletteCache = new Map();\n' + src.slice(start, end);
  const palette = new Function(block + '\nreturn _firePalette;')();
  // Full-view bars pass a hex...
  assert.equal(palette('#d946ef').mid, '#d946ef');
  // ...and an inline style read back yields rgb(), which used to be rejected
  // outright, silently painting every compact flame the default orange.
  assert.equal(palette('rgb(217, 70, 239)').mid, '#d946ef');
  assert.equal(palette('#e0916f').mid, palette('rgb(224, 145, 111)').mid);
  // Genuine nonsense still falls back rather than throwing.
  assert.equal(palette('not-a-colour').mid, '#ff922b');
});

test('compact bars hand the flame the colour they were painted', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.match(app, /fill\.style\.setProperty\('--fire-col', barCol\)/);
  assert.doesNotMatch(app, /setProperty\('--fire-col', fill\.style\.background\)/);
});

test('a dormant provider ices its letters, not a block around the logo', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  // The sheen is clipped to a duplicate of the wordmark, so it rides the
  // glyphs; that duplicate comes from data-ice on each section name.
  assert.match(css, /content: attr\(data-ice\)/);
  assert.match(css, /-webkit-background-clip: text/);
  for (const brand of ['Anthropic', 'OpenAI', 'Google']) {
    assert.match(html, new RegExp(`data-ice="${brand}"`));
  }
  // No pane of ice in front of the logo any more.
  assert.doesNotMatch(css, /half-melted/);
  // Thawing must not blank .brand-openai, whose letters ARE a clipped
  // gradient over color:transparent — killing the background hides them.
  const thaw = css.slice(css.indexOf('body.no-pizazz .section-header.frozen'));
  assert.doesNotMatch(thaw.slice(0, 400), /background: none/);
});

test('compact mode shows the OpenAI reset bank as orbs', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(app, /orbs: Math\.min\(compactResets\.available, 12\)/);
  assert.match(app, /row\.classList\.add\('compact-orbs'\)/);
  assert.match(css, /\.compact-row\.compact-orbs \.reset-dots/);
});

test('a hard-burning pool stays alight well past the spike', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  assert.match(main, /const BURN_SETTLE_MS = 45 \* 60 \* 1000;/);
  // A quiet window trims the burn to a cooldown rather than deleting it
  // outright, so a pause between prompts doesn't snuff the flames.
  assert.match(main, /cooling\.until = Math\.min\(cooling\.until, now \+ BURN_COOLING_MS\)/);
  assert.doesNotMatch(main, /delete _burningSeries\[series\.key\];/);
});

test('blueprint toolbar: dashed plans, and the clown is class-driven SVG', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  // Every toolbar icon carries a dashed construction layer; no sprite <img>s left
  assert.match(html, /class="bpg"/);
  assert.doesNotMatch(html, /press-up\.png|clown-happy\.png/);
  // Jail/press state is class toggling now, not src swapping
  assert.match(app, /btn\.classList\.toggle\('jailed', !on\)/);
  assert.match(app, /pressBtn\.classList\.toggle\('pressed', compact\)/);
  assert.doesNotMatch(app, /clown-jail\.png|press-down\.png/);
  // The jailing animation must survive no-pizazz: the global transition kill
  // is !important, so the clown rules need their own !important to outrank it
  assert.match(css, /body\.no-pizazz \.clown-cage \{ transition:[^}]+!important/);
});

test('settings window fits all content and restores the prior window', () => {
  const main = fs.readFileSync(path.join(repoDir, 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(repoDir, 'preload.js'), 'utf8');
  assert.match(main, /ipcMain\.on\('settings-fit'/);
  assert.match(main, /ipcMain\.on\('settings-restore'/);
  assert.match(main, /mainWindow\.setResizable\(false\)/);
  assert.match(preload, /settingsFit:/);
  assert.match(preload, /settingsRestore:/);
  assert.match(app, /function fitSettingsWindow/);
});

test('no-pizazz keeps functional spinners alive and reaches the detached graph', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const graphHtml = fs.readFileSync(path.join(rendererDir, 'graph.html'), 'utf8');
  const graphJs = fs.readFileSync(path.join(rendererDir, 'graph.js'), 'utf8');
  assert.match(css, /body\.no-pizazz \.spinner \{\s*animation: spin 1s linear infinite !important;/);
  assert.match(graphHtml, /body\.no-pizazz \*/);
  assert.match(graphJs, /classList\.toggle\('no-pizazz', pizazzOff\)/);
});
