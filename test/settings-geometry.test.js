'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const functionSource = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];
const handlerSource = name => {
  const start = source.indexOf(`    elements.${name}.addEventListener('click', async () => {`);
  assert.notEqual(start, -1);
  return source.slice(start, source.indexOf('\n    });', start) + 8);
};

function classList(...initial) {
  const values = new Set(initial);
  return {
    add: value => values.add(value), remove: value => values.delete(value),
    contains: value => values.has(value),
    toggle(value, on) { if (on) values.add(value); else values.delete(value); }
  };
}

function harness(initial, promised) {
  let bounds = { x: 100, y: 120, width: initial.width, height: initial.height };
  let previous = null;
  let resizable = true;
  let queue = Promise.resolve();
  let saved;
  const calls = [];
  const handlers = {};
  const frameCallbacks = [];
  const elements = new Proxy({}, { get(target, name) {
    return target[name] ||= {
      checked: false, value: '', style: {}, classList: classList(),
      addEventListener: (event, callback) => { handlers[name] = callback; }
    };
  } });
  elements.settingsOverlay.style.display = 'none';
  elements.mainContent.style.display = initial.compact ? 'none' : 'block';
  elements.compactContent.style.display = initial.compact ? 'flex' : 'none';
  const content = { classList: classList(), style: {}, getBoundingClientRect: () => ({ height: 606 }) };
  elements.settingsOverlay.querySelector = () => content;
  const native = callback => {
    if (!promised) { callback(); return; }
    queue = queue.then(callback);
    return queue;
  };
  const ctx = vm.createContext({
    elements, isCompactMode: initial.compact, isExpanded: false,
    graphVisible: !initial.compact, graphWasVisible: initial.compact,
    latestUsageData: {}, isOpenaiExtrasOpen: true, projectionsVisible: true,
    _windowUserSized: !!initial.preset, _activePreset: initial.preset || null,
    _saveCompactTimer: null,
    warnThreshold: 75, dangerThreshold: 90,
    document: {
      body: { classList: classList(...(initial.compact ? ['compact-mode'] : [])) },
      getElementById: name => elements[name]
    },
    getComputedStyle: () => ({ getPropertyValue: name => ({
      '--settings-general-w': 560, '--settings-providers-w': 580,
      '--settings-gap': 14, '--settings-pad': 14
    })[name] }),
    // Deliberately never run a frame: native Settings must work when painting pauses.
    requestAnimationFrame: callback => frameCallbacks.push(callback),
    stopAutoUpdate() {}, startAutoUpdate() {}, fetchUsageData: async () => {},
    loadSettings: async () => { elements.compactModeToggle.checked = ctx.isCompactMode; },
    syncGraphLayoutState() {}, loadChart() {}, _saveViewState() {}, resizeWidget() {}, applySqueezeClasses() {},
    refreshTimers() {}, buildExtraRows() {}, refreshExtraTimers() {}, applyTheme() {}, applyFontColor() {},
    _chromeHeight: () => 80, _intrinsicMainContentHeight: () => 650, _bannersHeight: () => 0,
    updateCompactBars: () => ctx.window.electronAPI.resizeWindow(260),
    window: { _cachedSettings: { cliAdopted: { openai: false }, hiddenRows: ['kept'] }, electronAPI: {
      platform: 'darwin',
      settingsFit: (height, width) => native(() => {
        calls.push('fit'); previous ||= { ...bounds }; resizable = false;
        bounds = { ...bounds, height, width };
      }),
      settingsRestore: options => native(() => {
        calls.push('restore'); resizable = true;
        if (!options.reCompact && previous) bounds = previous;
        previous = null;
      }),
      setCompactMode: compact => native(() => {
        calls.push('compact');
        bounds = { ...bounds, width: compact ? 320 : 590, height: compact ? 105 : 180 };
      }),
      resizeWindow: height => native(() => { bounds.height = height; }),
      saveSettings: async settings => { saved = settings; calls.push('save'); }
    } }
  });
  Object.defineProperty(ctx.window, 'innerHeight', { get: () => bounds.height });
  for (const name of ['applyCompactMode', 'saveSettings', 'fitSettingsWindow', '_forceFitHeight']) {
    vm.runInContext(functionSource(name), ctx);
  }
  vm.runInContext(handlerSource('settingsBtn') + handlerSource('closeSettingsBtn'), ctx);
  return { ctx, elements, handlers, calls, frameCallbacks,
    bounds: () => bounds, saved: () => saved, resizable: () => resizable,
    flush: () => queue };
}

for (const promised of [false, true]) {
  for (const initial of [
    { name: 'normal', width: 590, height: 770, compact: false },
    { name: 'wide', width: 900, height: 600, compact: false, preset: 'wide' },
    { name: 'tall', width: 590, height: 1150, compact: false, preset: 'tall' },
    { name: 'hand-sized', width: 750, height: 850, compact: false, preset: 'manual' },
    { name: 'compact', width: 320, height: 260, compact: true }
  ]) {
    for (const selected of [false, true]) {
      test(`Settings ${promised ? 'promised' : 'sent'} bridge: ${initial.name} to ${selected ? 'compact' : 'normal'}`, async () => {
        const h = harness(initial, promised);
        const before = { ...h.bounds() };
        await h.handlers.settingsBtn();
        assert.equal(h.bounds().width, 1184, 'Settings fits without waiting for animation frames');
        assert.equal(h.resizable(), false);
        assert.equal(h.calls.includes('compact'), false, 'Opening preserves the original mode and bounds');

        h.elements.compactModeToggle.checked = selected;
        await h.handlers.closeSettingsBtn();
        await h.flush();
        assert.equal(h.ctx.isCompactMode, selected);
        assert.equal(h.saved().compactMode, selected);
        assert.equal(h.ctx.document.body.classList.contains('compact-mode'), selected);
        assert.equal(h.elements.mainContent.style.display, selected ? 'none' : 'block');
        assert.equal(h.resizable(), true);
        assert.equal(h.saved().cliAdopted.openai, false);
        assert.deepEqual(h.saved().hiddenRows, ['kept']);
        if (selected === initial.compact) {
          assert.deepEqual(h.bounds(), before, 'An unchanged mode restores exact geometry');
          assert.equal(h.ctx._activePreset, initial.preset || null);
        } else {
          assert.equal(h.ctx._activePreset, null, 'Changing mode releases the old preset');
          assert.equal(h.ctx._windowUserSized, false);
          assert.equal(h.bounds().width, selected ? 320 : 590);
          assert.equal(h.bounds().height, selected ? 260 : 740, 'The new mode fits its content');
          assert.ok(h.calls.indexOf('compact') < h.calls.indexOf('save'));
          assert.ok(h.calls.indexOf('save') < h.calls.indexOf('restore'));
        }

        const after = { ...h.bounds() };
        await h.handlers.settingsBtn();
        await h.handlers.closeSettingsBtn();
        await h.flush();
        assert.deepEqual(h.bounds(), after, 'Repeated Settings restores the new geometry');
      });
    }
  }
}

test('Settings resize cannot replace the dashboard layout, minimum height, or preset', () => {
  const h = harness({ compact: false, width: 900, height: 600, preset: 'wide' }, true);
  const calls = [];
  h.elements.settingsOverlay.style.display = 'flex';
  h.ctx.window.innerWidth = 1184;
  h.ctx.window.electronAPI.setMinHeight = height => calls.push(height);
  h.ctx.document.body.classList.toggle = () => calls.push('layout');
  vm.runInContext(functionSource('applySqueezeClasses'), h.ctx);
  h.ctx.applySqueezeClasses();
  assert.deepEqual(calls, [], 'The Settings panel must not raise the compact minimum to 340px');

  let onSize;
  h.ctx.window.electronAPI.onWindowUserSized = callback => { onSize = callback; };
  const start = source.indexOf('if (window.electronAPI.onWindowUserSized) {');
  const end = source.indexOf("window.addEventListener('resize', applySqueezeClasses);", start);
  vm.runInContext(source.slice(start, end), h.ctx);
  onSize(false);
  assert.equal(h.ctx._activePreset, 'wide');
  assert.equal(h.ctx._windowUserSized, true);
  assert.deepEqual(calls, []);
});

test('Compact layout keeps the lower native minimum supplied by compact mode', () => {
  const h = harness({ compact: true, width: 320, height: 105 }, false);
  const heights = [];
  h.ctx.window.innerWidth = 1184; // a delayed resize event during the transition
  h.ctx._windowUserSized = true;
  h.ctx.window.electronAPI.setMinHeight = height => heights.push(height);
  h.ctx.document.body.style = { setProperty() {} };
  h.ctx.document.getElementById = () => null;
  h.ctx.applyLabelMode = () => {};
  vm.runInContext(functionSource('applySqueezeClasses'), h.ctx);
  h.ctx.applySqueezeClasses();
  assert.deepEqual(heights, []);
  assert.equal(h.ctx.document.body.classList.contains('landscape'), false);
});

test('A delayed view save and an older compact toggle cannot undo the final mode', async () => {
  const h = harness({ compact: true, width: 320, height: 315 }, true);
  h.ctx.window._cachedSettings.compactMode = true;
  h.ctx._saveCompactTimer = 7;
  const canceled = [];
  let saveView;
  h.ctx.clearTimeout = timer => canceled.push(timer);
  h.ctx.setTimeout = callback => { saveView = callback; return 8; };
  h.ctx.appInitializing = false;
  vm.runInContext('let _saveViewStateTimer = null;\n' + functionSource('_saveViewState'), h.ctx);
  const resizing = h.ctx.applyCompactMode(false);
  assert.equal(h.ctx.window._cachedSettings.compactMode, false);
  assert.deepEqual(canceled, [7]);
  await saveView(); // run before the outstanding native resize/save finishes
  await resizing;
  assert.equal(h.saved().compactMode, false);
  assert.equal(h.saved().graphVisible, true);
});
