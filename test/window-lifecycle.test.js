'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { recoverBounds, clearsVisibilityThreshold } = require('../src/window-bounds');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const MAIN = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const SIDE = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1040 } };

function harness(displays = [MAIN], settings = {}) {
  const saved = new Map(Object.entries(settings));
  const timers = new Map();
  let nextTimer = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.alwaysOnTop = options.alwaysOnTop;
      this.pinCalls = [];
      this.bounds = { x: 100, y: 100, width: options.width, height: options.height };
      this.visible = true;
      this.minimized = false;
      this.destroyed = false;
      this.moves = [];
      this.focusCalls = 0;
      this.showCalls = 0;
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
    }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    getBounds() { assert.equal(this.destroyed, false, 'destroyed windows cannot be read'); return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; this.moves.push({ ...bounds }); }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.emit('restore'); }
    show() { this.showCalls++; this.visible = true; }
    hide() { this.visible = false; }
    isAlwaysOnTop() { return this.alwaysOnTop; }
    setAlwaysOnTop(value) { this.alwaysOnTop = value; this.pinCalls.push(value); }
    focus() { this.focusCalls++; this.emit('focus'); }
  }
  const ctx = vm.createContext({
    mainWindow: null, BrowserWindow: Window, path, __dirname: path.join(__dirname, '..'),
    process: { platform: 'win32', env: {} },
    WIDGET_WIDTH: 590, WIDGET_HEIGHT: 155, MIN_WIDGET_WIDTH: 290,
    DEBUG: false, debugLog() {}, sendUpdateReady() {}, windowIsUserSized: () => false,
    screen: { getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays },
    recoverBounds, clearsVisibilityThreshold,
    store: { get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback, set: (key, value) => saved.set(key, value) },
    isQuitting: false, restoreTray: null, sessionTray: null, weeklyTray: null, fableTray: null,
    _providerTrays: {},
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  });
  for (const name of ['orderedDisplays', 'recoverWindowBounds', 'hasTrayIcon',
    'recoverMainWindowPosition', 'showMainWindowSmart', 'createMainWindow',
    'isMainWindowShownOnScreen', 'attachTrayToggleClick', 'applyMainWindowAlwaysOnTop']) {
    const match = source.match(new RegExp(`function ${name}\\([^]*?\\n}`));
    if (match) vm.runInContext(match[0], ctx);
  }
  vm.runInContext('createMainWindow()', ctx);
  return { ctx, window: ctx.mainWindow, saved, timers };
}

test('window is created at the saved pin level, including before startup finishes', () => {
  assert.equal(harness().window.alwaysOnTop, true);
  assert.equal(harness([MAIN], { 'settings.alwaysOnTop': false }).window.alwaysOnTop, false);
  assert.equal(harness([MAIN], { 'settings.alwaysOnTop': true }).window.alwaysOnTop, true);
});

test('pin recovery also repairs a stale topmost window when the preference is off', () => {
  const h = harness([MAIN], { 'settings.alwaysOnTop': false });
  h.window.alwaysOnTop = true;
  h.ctx.applyMainWindowAlwaysOnTop();
  assert.equal(h.window.alwaysOnTop, false);
  h.ctx.applyMainWindowAlwaysOnTop();
  assert.deepEqual(h.window.pinCalls, [false]);
  h.saved.set('settings.alwaysOnTop', true);
  h.ctx.applyMainWindowAlwaysOnTop();
  assert.equal(h.window.alwaysOnTop, true);
  h.window.destroyed = true;
  assert.doesNotThrow(() => h.ctx.applyMainWindowAlwaysOnTop());
});

for (const event of ['focus', 'restore']) {
  for (const scenario of [
    { name: 'disconnected monitor', displays: [MAIN],
      before: { x: 5000, y: 3000, width: 590, height: 400 },
      after: { x: 665, y: 320, width: 590, height: 400 } },
    { name: 'straddling two displays', displays: [MAIN, SIDE],
      before: { x: 1700, y: 50, width: 590, height: 400 },
      after: { x: 1920, y: 50, width: 590, height: 400 } },
    { name: 'intentional single-display overhang', displays: [MAIN],
      before: { x: -300, y: 50, width: 590, height: 400 },
      after: { x: -300, y: 50, width: 590, height: 400 } }
  ]) {
    test(`native ${event}: ${scenario.name}`, () => {
      const h = harness(scenario.displays);
      h.window.bounds = { ...scenario.before };
      h.window.emit(event);
      assert.deepEqual(h.window.bounds, scenario.after);
      const moved = scenario.before.x !== scenario.after.x || scenario.before.y !== scenario.after.y;
      assert.equal(h.window.moves.length, moved ? 1 : 0);
      if (moved) assert.deepEqual({ ...h.saved.get('windowPosition') }, { x: scenario.after.x, y: scenario.after.y });
      assert.equal(h.window.focusCalls, 0, 'native recovery must not focus recursively');
      assert.equal(h.window.showCalls, 0, 'native recovery only repairs position');
    });
  }

  test(`late ${event} after close does not read a destroyed window`, () => {
    const h = harness();
    h.window.destroyed = true;
    assert.doesNotThrow(() => h.window.emit(event));
    assert.equal(h.saved.size, 0);
  });
}

test('tray click restores an off-screen minimized window once, then toggles it', () => {
  const h = harness();
  h.window.bounds = { x: 5000, y: 3000, width: 590, height: 400 };
  h.window.minimized = true;
  h.window.visible = false;
  const tray = new EventEmitter();
  h.ctx.attachTrayToggleClick(tray);
  tray.emit('click');
  assert.equal(h.window.minimized, false);
  assert.equal(h.window.visible, true);
  assert.equal(h.window.focusCalls, 1);
  assert.equal(h.window.moves.length, 1);
  assert.deepEqual(h.window.bounds, { x: 665, y: 320, width: 590, height: 400 });
  tray.emit('click');
  assert.equal(h.window.visible, false);
  tray.emit('click');
  assert.equal(h.window.visible, true);
  assert.equal(h.window.focusCalls, 2);
  assert.equal(h.window.moves.length, 1, 'repeated restore keeps the recovered position');
});

test('a delayed move-save after destruction is ignored', () => {
  const h = harness();
  h.window.emit('move');
  h.window.destroyed = true;
  for (const callback of h.timers.values()) assert.doesNotThrow(callback);
  assert.equal(h.saved.size, 0);
});

for (const trayPresent of [false, true]) {
  for (const quitting of [false, true]) {
    test(`close keeps its current policy: tray=${trayPresent}, quitting=${quitting}`, () => {
      const h = harness();
      if (trayPresent) h.ctx._providerTrays.codex = { isDestroyed: () => false };
      h.ctx.isQuitting = quitting;
      let prevented = false;
      h.window.emit('close', { preventDefault() { prevented = true; } });
      assert.equal(prevented, trayPresent && !quitting);
      assert.equal(h.window.visible, !(trayPresent && !quitting));
    });
  }
}
