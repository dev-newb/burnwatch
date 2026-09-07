'use strict';
const path = require('path');
const { spawn } = require('child_process');

function xwaylandArgs({ platform, env, argv }) {
  if (platform !== 'linux' || !argv.includes('--xwayland-tray')) return null;
  if (env.XDG_SESSION_TYPE !== 'wayland' && !env.WAYLAND_DISPLAY) return null;
  // Honor explicit platform choices and prevent relaunch loops.
  if (argv.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))) return null;
  if (argv.some(arg => /^--whitelist-/.test(arg) || ['--reset-aumid', '--reset-taskbar-identity'].includes(arg))) return null;
  return argv.slice(1).concat('--ozone-platform=x11');
}

function startWithLinuxCompatibility({ app, start, platform = process.platform, env = process.env,
  argv = process.argv, spawnChild = spawn, log = console.warn }) {
  const args = xwaylandArgs({platform, env, argv});
  if (!args) { start(); return; }
  if (!env.DISPLAY) {
    log('[Linux] Xwayland compatibility requested but DISPLAY is unavailable; starting normally');
    start(); return;
  }
  if (!env.APPIMAGE) {
    try {
      app.relaunch({args});
    } catch (error) {
      log(`[Linux] Could not relaunch in Xwayland: ${error.message}`);
      start(); return;
    }
    app.exit(0);
    return;
  }
  // Re-execute the original AppImage, whose runtime creates a fresh mount.
  // An Electron relaunch helper inside the old mount can disappear on exit.
  if (!path.isAbsolute(env.APPIMAGE)) {
    log('[Linux] APPIMAGE is not an absolute path; starting normally');
    start(); return;
  }
  const childEnv = {...env};
  delete childEnv.APPIMAGE;
  delete childEnv.APPDIR;
  delete childEnv.ARGV0;
  let handedOff = false;
  const fallback = error => {
    if (handedOff) return;
    handedOff = true;
    log(`[Linux] Could not start Xwayland AppImage: ${error.message}; starting normally`);
    start();
  };
  try {
    const child = spawnChild(env.APPIMAGE, args, {detached: true, stdio: 'ignore', env: childEnv});
    child.once('error', fallback);
    child.once('spawn', () => {
      if (handedOff) return;
      handedOff = true;
      child.unref();
      app.exit(0);
    });
  } catch (error) { fallback(error); }
}
module.exports = { xwaylandArgs, startWithLinuxCompatibility };
