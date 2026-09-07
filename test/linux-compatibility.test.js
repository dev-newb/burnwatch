'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { xwaylandArgs, startWithLinuxCompatibility } = require('../src/linux-compatibility');
const options = {platform: 'linux', env: {XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0'},
  argv: ['/mounted/imburning', '--profile=work', '--xwayland-tray']};

test('Xwayland is opt-in, respects explicit platform flags and never loops', () => {
  assert.deepEqual(xwaylandArgs(options), ['--profile=work', '--xwayland-tray', '--ozone-platform=x11']);
  for (const overrides of [{platform: 'darwin'}, {env: {XDG_SESSION_TYPE: 'x11'}},
    {argv: ['/app', '--profile=work']}, {argv: [...options.argv, '--ozone-platform=x11']},
    {argv: [...options.argv, '--ozone-platform', 'wayland']}, {argv: [...options.argv, '--whitelist-list']}]) {
    assert.equal(xwaylandArgs({...options, ...overrides}), null);
  }
});

function fixture(overrides = {}) {
  const calls = []; const child = new EventEmitter();
  child.unref = () => calls.push('unref');
  const config = {...options,
    app: {exit: code => calls.push(['exit', code]), relaunch: value => calls.push(['relaunch', value])},
    start: () => calls.push('start'), log() {},
    spawnChild: (...args) => { calls.push(['spawn', ...args]); return child; }, ...overrides};
  return {calls, child, config};
}

test('non-AppImage relaunch preserves the profile and exits only after scheduling', () => {
  const f = fixture();
  startWithLinuxCompatibility(f.config);
  assert.deepEqual(f.calls, [['relaunch', {args: options.argv.slice(1).concat('--ozone-platform=x11')}], ['exit', 0]]);
});
test('AppImage handoff uses the original image and waits for spawn before quitting', () => {
  const f = fixture({env: {...options.env, APPIMAGE: '/home/user/My App.AppImage', APPDIR: '/mounted', ARGV0: '/mounted/app'}});
  startWithLinuxCompatibility(f.config);
  assert.equal(f.calls.length, 1);
  const [, executable, args, spawnOptions] = f.calls[0];
  assert.equal(executable, '/home/user/My App.AppImage');
  assert.deepEqual(args, ['--profile=work', '--xwayland-tray', '--ozone-platform=x11']);
  assert.equal(spawnOptions.env.APPDIR, undefined);
  assert.equal(spawnOptions.env.APPIMAGE, undefined);
  assert.equal(spawnOptions.detached, true);
  f.child.emit('spawn');
  assert.deepEqual(f.calls.slice(1), ['unref', ['exit', 0]]);
  assert.equal(xwaylandArgs({...options, argv: [executable, ...args]}), null);
});
test('failed AppImage spawn resumes the current app exactly once, without quitting', () => {
  const f = fixture({env: {...options.env, APPIMAGE: '/missing/App.AppImage'}});
  startWithLinuxCompatibility(f.config);
  f.child.emit('error', new Error('ENOENT'));
  f.child.emit('spawn');
  assert.deepEqual(f.calls.slice(1), ['start']);
});
test('synchronous relaunch or spawn failures also resume normal startup', () => {
  for (const appimage of [false, true]) {
    const f = fixture({env: {...options.env, ...(appimage ? {APPIMAGE: '/App.AppImage'} : {})}});
    f.config.spawnChild = () => {throw new Error('denied');};
    f.config.app.relaunch = () => {throw new Error('denied');};
    startWithLinuxCompatibility(f.config);
    assert.deepEqual(f.calls, ['start']);
  }
});
test('missing Xwayland or an invalid AppImage path starts normally', () => {
  for (const env of [{XDG_SESSION_TYPE: 'wayland'}, {...options.env, APPIMAGE: 'relative.AppImage'}]) {
    const f = fixture({env}); startWithLinuxCompatibility(f.config);
    assert.deepEqual(f.calls, ['start']);
  }
});
