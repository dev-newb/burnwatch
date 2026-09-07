'use strict';
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { writeAtomicJson } = require('./atomic-json');
const APP_ID = require('../package.json').build.appId;

function defaultIdentity(profile) {
  return profile ? `${APP_ID}.profile.${createHash('sha256').update(profile).digest('hex').slice(0, 16)}` : APP_ID;
}

function configureWindowsIdentity({ app, argv, userData, profile = '', platform = process.platform, log = console.log }) {
  const reset = argv.includes('--reset-aumid') || argv.includes('--reset-taskbar-identity');
  if (platform !== 'win32') {
    if (reset) log('[Taskbar] Identity reset is only needed on Windows');
    return reset ? 0 : null;
  }
  const base = defaultIdentity(profile);
  const file = path.join(userData, 'aumid-override.json');
  if (reset) {
    try {
      writeAtomicJson(file, { aumid: `${base}.reset.${randomUUID()}` });
      log('[Taskbar] Saved a new identity for this profile. Close and reopen the app, then unpin and repin its taskbar icon');
      return 0;
    } catch (error) { log(`[Taskbar] Could not reset identity: ${error.message}`); return 1; }
  }
  let identity = base;
  try {
    const { aumid } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof aumid === 'string' && aumid.startsWith(base + '.reset.') && aumid.length <= 128
      && /^[a-zA-Z0-9.-]+$/.test(aumid)) identity = aumid;
    else log('[Taskbar] Ignored invalid saved identity');
  } catch (error) {
    if (error.code !== 'ENOENT') log(`[Taskbar] Could not read saved identity: ${error.message}`);
  }
  app.setAppUserModelId(identity);
  return null;
}
module.exports = { configureWindowsIdentity, defaultIdentity };
