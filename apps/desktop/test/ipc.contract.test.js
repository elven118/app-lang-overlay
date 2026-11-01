const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../../..');
const fixtures = path.join(repositoryRoot, 'shared', 'protocol', 'v1', 'fixtures');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
}

test('settings show manual position only for One Large Area and source controls only when enabled', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/overlay/overlay.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function syncSettingVisibility('), source.indexOf('function syncPanelFromSettings('));
  const elements = new Map(['setting-position-row', 'setting-width-row', 'setting-width-label', 'mode-hint'].map(id => [id, {}]));
  const sourceControls = [{ hidden: false, value: '23' }, { hidden: false, value: '#ffffff' }];
  const context = { document: { getElementById: id => elements.get(id) }, panel: { querySelectorAll: () => sourceControls } };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.syncSettingVisibility({ mode: 'one_large_area', showSource: true });
  assert.equal(elements.get('setting-position-row').hidden, false);
  assert.equal(elements.get('setting-width-label').textContent, 'Width (px)');
  assert.equal(elements.get('setting-width-row').hidden, false);
  for (const mode of ['selected_window', 'multiple_regions']) {
    context.syncSettingVisibility({ mode, showSource: false });
    assert.equal(elements.get('setting-position-row').hidden, true);
    assert.equal(elements.get('setting-width-row').hidden, mode === 'multiple_regions');
    assert.equal(elements.get('setting-width-label').textContent, 'Maximum card width (px)');
    assert.ok(sourceControls.every(control => control.hidden));
    context.syncSettingVisibility({ mode, showSource: true });
    assert.ok(sourceControls.every(control => !control.hidden));
  }
  assert.deepEqual(sourceControls.map(control => control.value), ['23', '#ffffff']);
});

test('overlay interaction is temporary and secondary displays always pass clicks through', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function setOverlayInteraction('), source.indexOf('function sendToDesktopRenderers('));
  const primary = [], secondary = [];
  const context = {
    overlayWindow: { isDestroyed: () => false, setIgnoreMouseEvents: (ignore) => primary.push(ignore) },
    secondaryOverlays: [{ isDestroyed: () => false, setIgnoreMouseEvents: (ignore) => secondary.push(ignore) }],
    saveProfile() { assert.fail('Temporary interaction must not write profile settings'); },
  };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.setOverlayInteraction(true);
  context.setOverlayInteraction(false);
  assert.deepEqual(primary, [false, true]);
  assert.deepEqual(secondary, [true, true]);
});

test('cancelling selection closes settings and restores mouse passthrough without saving a preference', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function closeRegionPickerWindows('), source.indexOf('ipcMain.handle("overlay:get-settings"'));
  const interaction = [], messages = [];
  let closed = 0;
  const context = {
    areaPickerSettings: { mode: 'multiple_regions' }, windowPicker: null,
    selectionWindows: [{ isDestroyed: () => false, close() { closed++; } }],
    overlayWindow: { isDestroyed: () => false, webContents: { send: (event) => messages.push(event) } },
    setOverlayInteraction: (enabled) => interaction.push(enabled), sendToDesktopRenderers: (event) => messages.push(event),
    saveProfile() { assert.fail('Cancel must not save settings'); },
    completeCaptureSelection: (confirmed) => { assert.equal(confirmed, false); },
  };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.closeRegionPickerWindows();
  assert.deepEqual(interaction, [false]);
  assert.ok(messages.includes('overlay:close-panel'));
  assert.equal(context.areaPickerSettings, null);
  assert.equal(context.selectionWindows.length, 0);
  assert.equal(closed, 1);
});

test('Show Source keeps false through settings normalization and profile reload in every mode', () => {
  const ts = require('typescript');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const settingsCode = source.slice(source.indexOf('const DEFAULT_SETTINGS'), source.indexOf('const profileStore'));
  const context = { process: { env: {} } };
  vm.runInNewContext(ts.transpileModule(settingsCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const display = { width: 1920, height: 1080 };
  for (const mode of ['one_large_area', 'multiple_regions', 'selected_window']) {
    for (const showSource of [false, true]) {
      const normalized = context.normalizeOverlaySettings({ mode, showSource }, display);
      assert.equal(normalized.showSource, showSource);
      const saved = JSON.parse(JSON.stringify(context.settingsForProfile(normalized)));
      assert.equal(context.normalizeOverlaySettings(saved, display).showSource, showSource);
    }
  }
  const defaultShowSource = context.normalizeOverlaySettings({}, display).showSource;
  assert.equal(typeof defaultShowSource, 'boolean');
  assert.equal(context.normalizeOverlaySettings({ showSource: 'false' }, display).showSource, defaultShowSource);
});

test('Korean and Simplified Chinese settings survive normalization and profile reload', () => {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const settingsCode = source.slice(source.indexOf('const DEFAULT_SETTINGS'), source.indexOf('const profileStore'));
  const context = { process: { env: {} } };
  require('node:vm').runInNewContext(ts.transpileModule(settingsCode, {}).outputText, context);
  const display = { width: 1920, height: 1080 };
  for (const language of ['ko', 'zh-Hans']) {
    const settings = context.normalizeOverlaySettings({ ocrLang: language, targetLanguage: language }, display);
    const saved = JSON.parse(JSON.stringify(context.settingsForProfile(settings)));
    const reloaded = context.normalizeOverlaySettings(saved, display);
    assert.equal(reloaded.ocrLang, language);
    assert.equal(reloaded.targetLanguage, language);
  }
});

test('selection preview loops over all regions on the display and removes stale outlines', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/overlay/overlay.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function syncSelectionArea('), source.indexOf('function applyPlacement('));
  const classes = new Set();
  const selectionArea = {
    children: [], replaceChildren() { this.children = []; }, append(node) { this.children.push(node); },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }
  };
  const context = {
    selectionArea, panelVisible: true, selectionPreviewVisible: false,
    viewport: { bounds: { x: -1000, y: 0, width: 1000, height: 800 } },
    document: { createElement: () => ({ style: {} }) },
    getCaptureRegion: (settings) => settings.mode === 'selected_window' ? null : settings.captureRegion,
  };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const settings = {
    mode: 'multiple_regions', captureRegions: [
      { left: -900, top: 100, width: 200, height: 80 },
      { left: -500, top: 300, width: 300, height: 120 },
      { left: 100, top: 100, width: 100, height: 80 }, // Another display.
    ]
  };
  context.syncSelectionArea(settings);
  assert.equal(selectionArea.children.length, 2);
  assert.equal(selectionArea.children[0].style.left, '100px');
  assert.equal(selectionArea.children[1].style.left, '500px');
  context.syncSelectionArea({ ...settings, captureRegions: settings.captureRegions.slice(0, 1) });
  assert.equal(selectionArea.children.length, 1);
  context.panelVisible = false;
  context.syncSelectionArea(settings);
  assert.equal(selectionArea.children.length, 0);
  assert.ok(classes.has('hidden'));
  context.selectionPreviewVisible = true; // Settings are open on another display.
  context.syncSelectionArea(settings);
  assert.equal(selectionArea.children.length, 2);
  context.syncSelectionArea({ mode: 'one_large_area', captureRegion: { left: 20, top: 30, width: 400, height: 100 } });
  assert.equal(selectionArea.children.length, 1);
  assert.equal(selectionArea.children[0].style.left, '20px');
});

test('preview settings derive every region from the canonical profile with per-display scaling', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function withCaptureRegionPreviews('), source.indexOf('function saveOverlaySettings('));
  const context = {
    process: { platform: 'win32' }, normalizeCaptureRegions: (regions) => regions || [],
    normalizeCaptureRegion: (region) => region,
    displayForCaptureRegion: (region) => ({ scaleFactor: region.left < 0 ? 2 : 1 }),
  };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const profile = {
    capture_regions: [
      { left: -1800, top: 200, width: 400, height: 160 }, { left: 100, top: 300, width: 300, height: 120 },
    ]
  };
  const result = context.withCaptureRegionPreviews({ mode: 'multiple_regions' }, profile, {});
  assert.deepEqual(JSON.parse(JSON.stringify(result.captureRegions)), [
    { left: -900, top: 100, width: 200, height: 80 }, { left: 100, top: 300, width: 300, height: 120 },
  ]);
  assert.equal(profile.capture_regions[0].left, -1800);
});

test('desktop hello advertises the server ONNX provider', () => {
  const payload = fixture('client.hello.desktop.json');
  assert.deepEqual(payload, {
    type: 'client.hello',
    protocolVersion: 1,
    clientKind: 'desktop',
    appVersion: '0.3.0',
    ocrProviders: ['server-onnx'],
  });
});

test('translation result maps directly to renderer IPC fields', () => {
  const payload = fixture('translation.result.non-japanese.json');
  assert.equal(payload.type, 'translation.result');
  assert.equal(payload.sessionId, 'desktop-a1');
  assert.equal(typeof payload.regionId, 'string');
  assert.match(payload.frameId, /^(0|[1-9][0-9]*)$/);
  assert.equal(payload.ocrProvider, 'server-onnx');
  assert.ok(Array.isArray(payload.blocks));
  assert.equal(typeof payload.combinedSourceText, 'string');
  assert.equal(typeof payload.combinedTranslatedText, 'string');
});

test('ALO1 image envelope uses a big-endian JSON header length', () => {
  const header = fixture('frame.image-header.json');
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const envelope = Buffer.concat([Buffer.from('ALO1'), length, headerBytes, jpeg]);

  assert.equal(envelope.subarray(0, 4).toString('ascii'), 'ALO1');
  assert.equal(envelope.readUInt32BE(4), headerBytes.length);
  assert.deepEqual(JSON.parse(envelope.subarray(8, 8 + headerBytes.length).toString('utf8')), header);
  assert.deepEqual(envelope.subarray(8 + headerBytes.length), jpeg);
});

test('renderers receive results through IPC and do not own WebSockets', () => {
  for (const relative of ['src/renderer/overlay/overlay.ts', 'src/renderer/transcript/transcript.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.doesNotMatch(source, /new\s+WebSocket\s*\(/);
    assert.match(source, /onTranslationResult/);
  }
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/overlay/overlay.ts'), 'utf8');
  assert.match(overlay, /onTranslationClear/);
});

test('profile store creates, persists, loads, and renames safe profiles', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-profiles-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { ProfileStore } = await import('../src/main/profile-store.ts');
  const store = new ProfileStore(directory);

  store.create('demo', { overlay_settings: { polling_ms: 900 } });
  store.setActive('demo');
  assert.deepEqual(store.list(), ['demo']);
  assert.equal(store.resolveInitial(), 'demo');
  assert.equal(store.load('demo').profile_id, 'demo');

  const renamed = store.rename('demo', 'manga');
  store.setActive(renamed);
  assert.equal(renamed, 'manga');
  assert.deepEqual(store.list(), ['manga']);
  assert.equal(store.resolveInitial(), 'manga');
  assert.equal(store.load('manga').overlay_settings.polling_ms, 900);
  assert.throws(() => store.create('../unsafe'), /cannot be used in a filename/);
  assert.throws(() => store.create('manga'), /already exists/);
});

test('profile management is exposed through typed main-process IPC', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  for (const channel of ['profile:list', 'profile:create', 'profile:load', 'profile:rename']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(["']${channel}["']`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\(["']${channel}["']`));
  }
  assert.doesNotMatch(main, /overlay:get-game-id/);
  assert.doesNotMatch(preload, /getGameId/);
});

test('legacy full-screen profiles migrate to window mode while preserving region settings', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-profile-migration-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { ProfileStore } = await import('../src/main/profile-store.ts');
  const store = new ProfileStore(directory);
  store.create('legacy', {
    full_screen_display_id: 2,
    capture_region: { left: 10, top: 20, width: 300, height: 100 },
    overlay_settings: { mode: 'full_screen', polling_ms: 900 },
  });
  const profile = store.load('legacy');
  assert.equal(profile.overlay_settings.mode, 'selected_window');
  assert.equal(profile.overlay_settings.polling_ms, 900);
  assert.equal(profile.capture_region.width, 300);
  assert.equal(profile.full_screen_display_id, undefined);
  store.save('legacy', profile);
  assert.equal(JSON.parse(fs.readFileSync(store.pathFor('legacy'))).overlay_settings.mode, 'selected_window');
});

function loadDesktopModule(relative, dependencies, globals = {}) {
  const vm = require('node:vm');
  const ts = require('typescript');
  const filename = path.join(__dirname, '..', relative);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports, Buffer, process,
    ...globals,
    __dirname: path.dirname(filename),
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      return require(name);
    },
  }, { filename });
  return module.exports;
}

function pickerHarness(multiple, regions = [], otherRegionCount = 0) {
  const elements = new Map();
  const events = new Map();
  const submissions = [];
  let start, cancelled = 0;
  function element() {
    return {
      style: {}, children: [], events: new Map(), hidden: false, disabled: false,
      append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; },
      setAttribute() { }, addEventListener(name, handler) { this.events.set(name, handler); }, closest() { return null; }
    };
  }
  loadDesktopModule('src/renderer/picker/picker.ts', {}, {
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element, body: { classList: { add() { } } }, addEventListener: (name, fn) => events.set(name, fn)
    },
    window: {
      innerWidth: 1000, innerHeight: 800, pickerApi: {
        onStartDrag: (fn) => { start = fn; }, select() { },
        async submit(value) { submissions.push(value); return { status: 'ok' }; }, async cancel() { cancelled++; },
      }
    },
  });
  start({ multiple, regions, otherRegionCount, originX: -1000, originY: -100, captureScaleFactor: 2 });
  function drag(x1, y1, x2, y2) {
    events.get('mousedown')({ button: 0, clientX: x1, clientY: y1, target: element() });
    events.get('mouseup')({ button: 0, clientX: x2, clientY: y2 });
  }
  return { elements, events, submissions, drag, cancelled: () => cancelled };
}

test('multi-region picker stages several rectangles and removals before one scaled submission', async () => {
  const initial = { left: -1800, top: 0, width: 200, height: 100 };
  const p = pickerHarness(true, [initial]);
  assert.equal(p.elements.get('saved-regions').children.length, 1);
  p.drag(300, 200, 450, 260);
  p.drag(300, 200, 450, 260); // Duplicate drags do not duplicate regions.
  assert.equal(p.submissions.length, 0);
  assert.equal(p.elements.get('saved-regions').children.length, 2);
  p.elements.get('saved-regions').children[0].children[1].events.get('click')();
  p.events.get('keydown')({ key: 'Enter', preventDefault() { } });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(p.submissions)), [[{ left: -1400, top: 200, width: 300, height: 120 }]]);
});

test('picker cancel discards drafts and One Large Area still submits on mouse release', () => {
  const multi = pickerHarness(true);
  multi.drag(100, 100, 300, 200);
  multi.events.get('keydown')({ key: 'Escape' });
  assert.equal(multi.cancelled(), 1);
  assert.equal(multi.submissions.length, 0);
  const single = pickerHarness(false);
  single.drag(10, 10, 15, 15);
  assert.equal(single.submissions.length, 0);
  single.drag(100, 100, 300, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(single.submissions)), [{ left: -1800, top: 0, width: 400, height: 200 }]);
});

test('multi-region submit validates the sender and bounds, commits once, and preserves other screens', () => {
  const ts = require('typescript');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const normalizers = source.slice(source.indexOf('function asFiniteNumber'), source.indexOf('function normalizeCaptureRegions'));
  const handler = source.slice(source.indexOf('ipcMain.handle("picker:submit"'), source.indexOf('ipcMain.handle("picker:cancel"'));
  let submit;
  const writes = [];
  const sender = {};
  const display = { id: 1, scaleFactor: 1 };
  const win = { display, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) };
  const remote = { left: -800, top: 100, width: 200, height: 100 };
  const old = { left: 10, top: 10, width: 100, height: 100 };
  vm.runInNewContext(ts.transpileModule(normalizers + handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    process: { platform: 'darwin' },
    ipcMain: { handle: (_name, fn) => { submit = fn; } },
    BrowserWindow: { fromWebContents: (candidate) => candidate === sender ? win : null },
    selectionWindows: [win], profileId: 'test', areaPickerSettings: { mode: 'multiple_regions' },
    getOverlaySettings: () => ({ mode: 'selected_window' }),
    loadProfile: () => ({ capture_regions: [remote, old] }), normalizeCaptureRegions: (regions) => regions || [],
    displayForCaptureRegion: (r) => ({ id: r.left < 0 ? 2 : 1 }),
    saveCaptureRegion: (...args) => writes.push(args),
    completeCaptureSelection: (confirmed) => { assert.equal(confirmed, true); },
    latestTranslations: new Map(), captureBounds: new Map(), desktopCapture: { stop() { } },
    desktopStream: { refreshCapture() { } }, refreshOverlayWindowForProfile() { }, closeRegionPickerWindows() { },
    publishProfileState() { },
    profileStore: { pathFor: () => '/profiles/test.json' },
  });
  const region = { left: 200, top: 200, width: 100, height: 80 };
  assert.equal(submit({ sender: {} }, [region]).status, 'invalid');
  assert.equal(submit({ sender }, [{ ...region, width: NaN }]).status, 'invalid');
  assert.equal(submit({ sender }, [{ ...region, left: 990 }]).status, 'invalid');
  assert.equal(submit({ sender }, region).status, 'invalid');
  assert.equal(writes.length, 0);
  assert.equal(submit({ sender }, [region, region]).status, 'ok');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0][3])), [remote, region]);
  assert.equal(writes[0][4].mode, 'multiple_regions');
});

test('changing capture mode closes settings and releases interaction before requesting selection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/overlay/overlay.ts'), 'utf8');
  const body = source.slice(source.indexOf('async function persistFromPanel('), source.indexOf('async function togglePanel('));
  const ts = require('typescript');
  for (const mode of ['selected_window', 'one_large_area', 'multiple_regions']) {
    const calls = [];
    const next = { mode };
    let finishClosing;
    const context = {
      settings: { mode: mode === 'selected_window' ? 'one_large_area' : 'selected_window' },
      parsePanelSettings: () => next,
      togglePanel: (visible) => { calls.push(['panel', visible]); return new Promise(resolve => { finishClosing = resolve; }); },
      hide: () => calls.push(['hide-hint']),
      syncSettingVisibility() {},
      persistSettings: async (settings) => { calls.push(['select', settings.mode]); context.settings = settings; },
    };
    require('node:vm').runInNewContext(ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    const pending = context.persistFromPanel();
    assert.deepEqual(calls, [['panel', false]]);
    finishClosing();
    await pending;
    assert.deepEqual(calls, [['panel', false], ['hide-hint'], ['select', mode]]);
    calls.length = 0;
    context.settings.mode = mode;
    await context.persistFromPanel();
    assert.deepEqual(calls, [['select', mode]]);
  }
});

test('mode selection cancellation and failure reopen previous settings; confirmation keeps them closed', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/overlay/overlay.ts'), 'utf8');
  const body = source.slice(source.indexOf('async function persistFromPanel('), source.indexOf('async function togglePanel('));
  const ts = require('typescript');
  for (const outcome of ['confirmed', 'cancelled', 'failed']) {
    const previous = { mode: 'one_large_area' };
    const next = { mode: 'multiple_regions' };
    const panels = [], errors = [];
    const context = {
      settings: previous, parsePanelSettings: () => next,
      togglePanel: async visible => panels.push(visible), hide() {}, syncSettingVisibility() {},
      persistSettings: async () => {
        if (outcome === 'failed') throw new Error('Selection unavailable');
        context.settings = outcome === 'confirmed' ? next : previous;
      },
      window: { overlayApi: { getSettings: async () => previous } },
      setStyle() {}, syncPanelFromSettings() {}, console: { error: (...args) => errors.push(args) },
    };
    require('node:vm').runInNewContext(ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    await context.persistFromPanel();
    assert.deepEqual(panels, outcome === 'confirmed' ? [false] : [false, true]);
    assert.equal(context.settings.mode, outcome === 'confirmed' ? next.mode : previous.mode);
    assert.equal(errors.length, outcome === 'failed' ? 1 : 0);
  }
});

test('every capture mode change waits for confirmation or cancellation before returning settings', async () => {
  const ts = require('typescript');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const handler = source.slice(source.indexOf('ipcMain.handle("overlay:save-settings"'), source.indexOf('ipcMain.handle("profile:get-active"'));
  for (const before of ['selected_window', 'one_large_area', 'multiple_regions']) {
    for (const after of ['selected_window', 'one_large_area', 'multiple_regions']) {
      if (before === after) continue;
      let save, opened;
      const persisted = { mode: before };
      const context = {
        profileId: 'test', ipcMain: { handle: (_name, fn) => { save = fn; } },
        captureSelectionComplete: null,
        getOverlaySettings: () => persisted,
        openRegionPickerWindows: async (settings) => { opened = settings; },
        toggleOverlayPanel() { },
        saveOverlaySettings() { assert.fail('Mode must not persist before selection'); },
      };
      vm.runInNewContext(ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
      const payload = { mode: after };
      let settled = false;
      const cancelled = save({}, payload).then(result => { settled = true; return result; });
      assert.equal(opened, payload);
      assert.equal(persisted.mode, before);
      await Promise.resolve();
      assert.equal(settled, false);
      context.captureSelectionComplete(false);
      assert.equal(await cancelled, persisted);
      const confirmed = save({}, payload);
      persisted.mode = after; // Native target confirmation saves the profile.
      context.captureSelectionComplete(true);
      assert.equal(await confirmed, persisted);
      assert.equal(persisted.mode, after);
    }
  }
});

test('selection completion settles once so backend errors cannot roll back a confirmed mode', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const body = source.slice(source.indexOf('function completeCaptureSelection('), source.indexOf('function closeRegionPickerWindows('));
  const outcomes = [];
  const context = { captureSelectionComplete: confirmed => outcomes.push(confirmed) };
  const ts = require('typescript');
  require('node:vm').runInNewContext(ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  context.completeCaptureSelection(true);
  context.completeCaptureSelection(false);
  assert.deepEqual(outcomes, [true]);
  assert.equal(context.captureSelectionComplete, null);
});

test('multiple-region images form one card while selected-window images retain individual blocks', () => {
  const { overlayCards } = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {});
  const result = {
    ...fixture('translation.result.non-japanese.json'), regionId: 'region-2',
    combinedSourceText: 'First\nSecond', combinedTranslatedText: '一\n二', blocks: [
      { id: 'second', text: 'Second', translatedText: '二', readingOrder: 1, bounds: { x: .1, y: .5, width: .3, height: .1 } },
      { id: 'first', text: 'First', translatedText: '一', readingOrder: 0, bounds: { x: .1, y: .1, width: .3, height: .1 } },
    ]
  };
  const grouped = overlayCards(result, 'multiple_regions');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].text, 'First\nSecond');
  assert.equal(grouped[0].translatedText, '一\n二');
  assert.deepEqual(JSON.parse(JSON.stringify(grouped[0].bounds)), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(Array.from(overlayCards(result, 'selected_window'), (card) => card.id), ['first', 'second']);
  assert.equal(result.blocks.length, 2);
});

test('combined-region cards preserve readings in order and fall back when source text differs', () => {
  const { overlayCards } = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {});
  const segments = [{ text: '\u6f22\u5b57', reading: '\u304b\u3093\u3058' }];
  const result = {
    regionId: 'region', combinedSourceText: '\u6f22\u5b57\nkana', combinedTranslatedText: 'Translation',
    blocks: [
      { text: 'kana', readingOrder: 1, sourceReadingSegments: null },
      { text: '\u6f22\u5b57', readingOrder: 0, sourceReadingSegments: segments },
    ],
  };
  const card = overlayCards(result, 'multiple_regions')[0];
  assert.deepEqual(JSON.parse(JSON.stringify(card.sourceReadingSegments)), [
    ...segments, { text: '\n', reading: null }, { text: 'kana', reading: null },
  ]);
  assert.equal(overlayCards({ ...result, combinedSourceText: 'Different source' }, 'multiple_regions')[0].sourceReadingSegments, null);
});

test('source readings render as safe ruby nodes with plain kana and a fallback for mismatched text', () => {
  const element = (tag) => ({
    tag, style: {}, dataset: {}, children: [],
    append(...nodes) { this.children.push(...nodes); },
    remove() { },
  });
  const { BlockOverlays } = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {}, {
    document: { createElement: element, createTextNode: (text) => ({ textContent: text }) },
    ResizeObserver: class { observe() { } unobserve() { } },
    clearTimeout() { },
  });
  const container = element('div');
  const layer = new BlockOverlays(container);
  const block = {
    id: 'a', text: '\u6f22\u5b57\u306f<script>', translatedText: 'Translation', readingOrder: 0,
    sourceReadingSegments: [
      { text: '\u6f22\u5b57', reading: '\u304b\u3093\u3058' },
      { text: '\u306f<script>', reading: null },
    ],
  };
  layer.show({ regionId: 'region', sessionId: 'session', frameId: '1', blocks: [block] });
  const source = container.children[0].children[0];
  assert.equal(source.children[0].tag, 'ruby');
  assert.equal(source.children[0].children[0].textContent, '\u6f22\u5b57');
  assert.equal(source.children[0].children[1].tag, 'rt');
  assert.equal(source.children[0].children[1].textContent, '\u304b\u3093\u3058');
  assert.equal(source.children[1].textContent, '\u306f<script>');
  layer.show({ regionId: 'region', sessionId: 'session', frameId: '2', blocks: [{ ...block, text: 'Different source' }] });
  assert.equal(container.children[1].children[0].textContent, 'Different source');
});

test('selected-window cards preserve source blocks without falling back to combined translations', () => {
  const { overlayCards } = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {});
  const result = {
    ...fixture('translation.result.non-japanese.json'), regionId: 'window-1',
    combinedSourceText: 'First\nSecond', combinedTranslatedText: 'Combined translation', blocks: [
      { id: 'first', text: 'First', translatedText: '', readingOrder: 0, bounds: { x: .25, y: .125, width: .25, height: .125 } },
      { id: 'second', text: 'Second', translatedText: '', readingOrder: 1, bounds: { x: .125, y: .5, width: .5, height: .125 } },
    ]
  };
  const cards = overlayCards(result, 'selected_window');
  assert.deepEqual(JSON.parse(JSON.stringify(cards)), result.blocks);
  const emptyBlocks = overlayCards({ ...result, blocks: [] }, 'selected_window');
  assert.equal(emptyBlocks.length, 0);
});

test('confirmed area selection persists its pending mode and settings with the selected rectangles', () => {
  const ts = require('typescript');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function saveCaptureRegion('), source.indexOf('function setOverlayInteraction('));
  for (const mode of ['one_large_area', 'multiple_regions']) {
    const profile = { overlay_settings: { mode: 'selected_window' } };
    const pending = { mode, sourceFontSize: 23, placement: { free: { x: 0, y: 0 }, above: { gapY: 0, xShift: 0 } } };
    const region = { left: 200, top: 150, width: 200, height: 100 };
    let writes = 0;
    const context = {
      process: { platform: 'darwin' }, loadProfile: () => profile,
      screen: { getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 100, y: 50, width: 1000, height: 800 } }) },
      normalizeOverlaySettings: (settings) => settings, settingsForProfile: (settings) => settings,
      saveProfile: () => { writes++; },
    };
    vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    context.saveCaptureRegion('test', region, { x: 100, y: 50 }, mode === 'multiple_regions' ? [region] : undefined, pending);
    assert.equal(writes, 1);
    assert.equal(profile.overlay_settings.mode, mode);
    assert.equal(profile.overlay_settings.sourceFontSize, 23);
    assert.equal(profile.overlay_settings.captureRegion.left, 100);
    if (mode === 'multiple_regions') assert.deepEqual(profile.capture_regions, [region]);
  }
});

function captureWithStreams(ScreenStream, platform = process.platform) {
  const { DesktopCapture } = loadDesktopModule('src/main/capture.ts', {
    './mac-display-capture': { MacDisplayCapture: ScreenStream },
    './window-bounds': { readWindowBounds: async () => undefined },
    './screen-stream': { ScreenStream, captureWorkerPage: () => 'worker.html' },
    './protocol': { MAX_IMAGE_BYTES: 4 * 1024 * 1024 },
  }, { process: { platform } });
  return new DesktopCapture();
}

test('macOS area capture uses native exclusion while selected windows keep Electron capture', async () => {
  for (const platform of ['darwin', 'win32']) {
    const sources = [];
    class ElectronStream {
      constructor(_display, _page, windowId) { sources.push({ kind: 'electron', windowId }); }
      async capture() { return { getSize: () => ({ width: 800, height: 600 }), toJPEG: () => Buffer.from('frame') }; }
      dispose() { }
    }
    class NativeCapture extends ElectronStream {
      constructor(display, exclusions) {
        super(display);
        sources[sources.length - 1] = { kind: 'native', ids: exclusions() };
      }
    }
    const { DesktopCapture } = loadDesktopModule('src/main/capture.ts', {
      './screen-stream': { ScreenStream: ElectronStream, captureWorkerPage: () => 'worker.html' },
      './mac-display-capture': { MacDisplayCapture: NativeCapture },
      './window-bounds': { readWindowBounds: async () => undefined },
      './protocol': { MAX_IMAGE_BYTES: 4 * 1024 * 1024 },
    }, { process: { platform } });
    const capture = new DesktopCapture(undefined, undefined, () => ['42', '43']);
    const display = { id: 2, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 };
    await capture.capture([{ regionId: 'area', display },
    { regionId: 'window', display, windowSource: { id: 'window:99:0', name: 'Reader' } }]);
    assert.equal(sources[0].kind, platform === 'darwin' ? 'native' : 'electron');
    if (platform === 'darwin') assert.deepEqual(Array.from(sources[0].ids), ['42', '43']);
    assert.equal(sources[1].kind, 'electron');
    assert.equal(sources[1].windowId, 'window:99:0');
    capture.stop();
  }
});

test('native capture passes Retina dimensions and current overlay IDs without saving images', async () => {
  const calls = [];
  let ids = ['42'];
  const { MacDisplayCapture } = loadDesktopModule('src/main/mac-display-capture.ts', {
    'node:child_process': {
      execFile(binary, args, options, callback) {
        calls.push({ binary, args, options });
        queueMicrotask(() => callback(null, Buffer.from('PNG bytes'), Buffer.alloc(0)));
        return { kill() { } };
      }
    },
    electron: { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) } },
  });
  const capture = new MacDisplayCapture({ id: 7, scaleFactor: 2, bounds: { width: 1200, height: 800 } }, () => ids);
  await capture.capture();
  ids = ['43', '44'];
  await capture.capture();
  assert.deepEqual(Array.from(calls[0].args), ['7', '2400', '1600', '42']);
  assert.deepEqual(Array.from(calls[1].args), ['7', '2400', '1600', '43,44']);
  assert.equal(calls[0].binary, path.join(path.dirname(path.join(__dirname, '../src/main/mac-display-capture.ts')), 'native/macos/display-capture'));
  assert.equal(calls[0].options.encoding, 'buffer');
  capture.dispose();
  await assert.rejects(capture.capture(), /stopped/);
});

test('native capture surfaces failures and cancels in-flight work on dispose', async () => {
  let finish;
  let killed = false;
  const { MacDisplayCapture } = loadDesktopModule('src/main/mac-display-capture.ts', {
    'node:child_process': {
      execFile(_binary, _args, _options, callback) {
        finish = callback;
        return { kill() { killed = true; finish(new Error('stopped'), Buffer.alloc(0), Buffer.from('capture cancelled')); } };
      }
    }, electron: {},
  });
  const capture = new MacDisplayCapture({ id: 7, scaleFactor: 1, bounds: { width: 800, height: 600 } }, () => []);
  const pending = capture.capture();
  capture.dispose();
  await assert.rejects(pending, /Display 7: capture cancelled/);
  assert.equal(killed, true);
});

test('Windows overlay protection is enabled before the window is shown', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function createOverlayWindow('), source.indexOf('function createControlWindow('));
  const calls = [];
  class Window {
    constructor(options) {
      assert.equal(options.show, false);
      assert.equal(options.webPreferences.backgroundThrottling, false);
      this.webContents = { on() { } };
    }
    setContentProtection(value) { calls.push(['protect', value]); }
    show() { calls.push(['show']); }
    setVisibleOnAllWorkspaces() { }
    loadFile() { }
    setIgnoreMouseEvents() { }
  }
  const context = {
    BrowserWindow: Window, process: { platform: 'win32' },
    profileId: 'test', loadProfile: () => ({}), getTargetDisplay: () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    path, __dirname: '/dist',
  };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.createOverlayWindow();
  assert.deepEqual(calls, [['protect', true], ['show']]);
});

test('translation visibility restores native overlay z-order without focusing or covering the picker', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const body = source.slice(source.indexOf('function restoreOverlayVisibility('), source.indexOf('function publishTranslation('));
  const calls = [];
  const window = (label, visible) => ({ isDestroyed: () => false, isVisible: () => visible,
    showInactive: () => calls.push([label, 'show-inactive']), moveTop: () => calls.push([label, 'move-top']),
    setAlwaysOnTop: (value, level) => calls.push([label, 'always-on-top', value, level]),
    focus() { assert.fail('Translation must not take keyboard focus'); } });
  const context = { overlayWindow: window('primary', false), secondaryOverlays: [window('secondary', true)],
    selectionWindows: [], windowPicker: null };
  const ts = require('typescript');
  require('node:vm').runInNewContext(ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  context.restoreOverlayVisibility();
  assert.deepEqual(calls, [['primary', 'show-inactive'], ['primary', 'move-top'], ['primary', 'always-on-top', true, 'screen-saver'],
    ['secondary', 'move-top'], ['secondary', 'always-on-top', true, 'screen-saver']]);
  calls.length = 0;
  context.selectionWindows = [{}];
  context.restoreOverlayVisibility();
  context.selectionWindows = [];
  context.windowPicker = {};
  context.restoreOverlayVisibility();
  assert.deepEqual(calls, []);
  assert.match(source.slice(source.indexOf('function publishTranslation('), source.indexOf('function publishCaptureBounds(')), /restoreOverlayVisibility\(\)/);
});

test('block placement prefers below, flips above, and clamps to the display work area', () => {
  const { placeBlock, projectBlock } = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {});
  const area = { x: 0, y: 25, width: 3840, height: 2135 };
  const position = placeBlock({ x: 2797, y: 12, width: 202, height: 44 }, { width: 300, height: 100 }, area);
  assert.equal(position.x, 2797);
  assert.equal(position.y, 56);
  const bottom = placeBlock({ x: 3800, y: 2100, width: 30, height: 40 }, { width: 300, height: 100 }, area);
  assert.equal(bottom.x, 3540);
  assert.equal(bottom.y, 2000);
  const oversized = placeBlock({ x: -20, y: 10, width: 20, height: 30 }, { width: 4000, height: 2200 }, area);
  assert.equal(oversized.x, 0);
  assert.equal(oversized.y, 25);
  const projected = projectBlock({ x: 0.25, y: 0.1, width: 0.5, height: 0.2 },
    { x: -1000, y: -100, width: 800, height: 600 });
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), { x: -800, y: -40, width: 400, height: 120 });
});

test('block cards preserve other regions, reject stale frames, and clear only the matching region', () => {
  const timers = new Map();
  let nextTimer = 0;
  function element() {
    return {
      style: {}, dataset: {}, children: [], hidden: false,
      append(...nodes) { this.children.push(...nodes); },
      remove() { this.removed = true; }, getBoundingClientRect: () => ({ width: 240, height: 80 })
    };
  }
  const { BlockOverlays } = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {}, {
    document: { createElement: element },
    ResizeObserver: class { observe() { } unobserve() { } },
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  const container = element();
  const layer = new BlockOverlays(container);
  layer.configure({ width: 500, autoHideMs: 1000 }, {
    bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 },
  });
  const makeResult = (regionId, frameId) => ({
    ...fixture('translation.result.non-japanese.json'),
    sessionId: 'session', regionId, frameId, captureBounds: { x: 0, y: 0, width: 1000, height: 800 },
    blocks: [{
      id: 'a', text: '<script>source</script>', translatedText: 'Translation', readingOrder: 0,
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }
    }],
  });
  const active = () => container.children.filter((node) => !node.removed);
  layer.show(makeResult('region-1', '1'));
  layer.show(makeResult('region-2', '2'));
  assert.equal(active().length, 2);
  assert.equal(active()[0].style.top, '160px');
  assert.equal(active()[0].children[0].textContent, '<script>source</script>');
  assert.equal(active()[0].children[1].textContent, 'Translation');
  timers.get(1)();
  assert.equal(active()[0].hidden, true);
  assert.equal(active()[1].hidden, false);
  layer.show(makeResult('region-1', '3'));
  assert.equal(active().length, 2);
  assert.equal(active()[1].hidden, false);
  layer.show(makeResult('region-1', '2'));
  assert.equal(active().length, 2);
  layer.clear('region-1', 'wrong-session', '4');
  layer.clear('region-1', 'session', '2');
  assert.equal(active().length, 2);
  layer.clear('region-1', 'session', '3');
  assert.equal(active().length, 1);
  assert.equal(active()[0].dataset.regionId, 'region-2');
  layer.move('region-2', { x: 100, y: 100, width: 1000, height: 800 });
  assert.equal(active()[0].style.left, '200px');
  assert.equal(active()[0].style.top, '260px');
  layer.configure({ mode: 'multiple_regions', width: 50, autoHideMs: 1000 }, {
    bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 },
  });
  layer.show({ ...makeResult('region-2', '4'), captureBounds: { x: 100, y: 100, width: 320, height: 200 } });
  assert.equal(active()[0].style.width, '320px');
  layer.move('region-2', { x: 100, y: 100, width: 480, height: 200 });
  assert.equal(active()[0].style.width, '480px');
  layer.move('region-2', { x: 0, y: 100, width: 1200, height: 200 });
  assert.equal(active()[0].style.width, '1000px');
});

test('cards with no visible text hide their background and react to Show Source changes', () => {
  const element = () => ({
    style: {}, dataset: {}, children: [],
    append(...nodes) { this.children.push(...nodes); },
    remove() { }, getBoundingClientRect: () => ({ width: 100, height: 30 })
  });
  const { BlockOverlays } = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {}, {
    document: { createElement: element },
    ResizeObserver: class { observe() { } unobserve() { } }, clearTimeout() { },
  });
  const container = element();
  const layer = new BlockOverlays(container);
  const settings = {
    mode: 'selected_window', showSource: false, sourceFontSize: 12, translatedFontSize: 12,
    width: 400, autoHideMs: -1
  };
  const viewport = { bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 800 } };
  layer.configure(settings, viewport);
  layer.show({
    ...fixture('translation.result.non-japanese.json'), regionId: 'window-1',
    captureBounds: viewport.bounds, combinedTranslatedText: 'Visible translation', blocks: [
      { id: 'source-only', text: 'Source', translatedText: '', readingOrder: 0, bounds: { x: .1, y: .1, width: .2, height: .1 } },
      { id: 'empty', text: ' \n ', translatedText: '\t\n', readingOrder: 1, bounds: { x: .1, y: .3, width: .2, height: .1 } },
      { id: 'translated', text: '', translatedText: '\nVisible translation\n', readingOrder: 2, bounds: { x: .1, y: .5, width: .2, height: .1 } },
    ]
  });
  assert.deepEqual(container.children.map(node => node.style.display), ['none', 'none', '']);
  assert.equal(container.children[1].children[0].textContent, '');
  assert.equal(container.children[1].children[1].textContent, '');
  assert.equal(container.children[2].children[1].textContent, 'Visible translation');
  layer.configure({ ...settings, showSource: true }, viewport);
  assert.deepEqual(container.children.map(node => node.style.display), ['', 'none', '']);
  layer.configure({ ...settings, translatedFontSize: 0 }, viewport);
  assert.deepEqual(container.children.map(node => node.style.display), ['none', 'none', 'none']);
});

test('one-large-area results render readings in the combined subtitle', () => {
  const element = (tag) => ({
    tag, children: [], append(...nodes) { this.children.push(...nodes); },
  });
  const helpers = loadDesktopModule('src/renderer/overlay/block-overlays.ts', {}, {
    document: { createElement: element, createTextNode: (text) => ({ textContent: text }) },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/overlay/overlay.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function showResult('), source.indexOf('async function copyCurrentText('));
  const sourceEl = element('div');
  let shown, placed = false;
  const context = {
    settings: { mode: 'one_large_area', autoHideMs: -1 }, sourceEl,
    overlayCards: helpers.overlayCards, renderSource: helpers.renderSource,
    show: (...args) => { shown = args; sourceEl.textContent = args[0]; },
    applyPlacement: () => { placed = true; },
  };
  require('node:vm').runInNewContext(require('typescript').transpileModule(fn, {}).outputText, context);
  context.showResult({
    regionId: 'region', combinedSourceText: '\u6f22\u5b57', combinedTranslatedText: 'Kanji',
    blocks: [{ text: '\u6f22\u5b57', readingOrder: 0,
      sourceReadingSegments: [{ text: '\u6f22\u5b57', reading: '\u304b\u3093\u3058' }] }],
  });
  assert.deepEqual(shown, ['\u6f22\u5b57', 'Kanji', -1]);
  assert.equal(sourceEl.children[0].tag, 'ruby');
  assert.equal(sourceEl.children[0].children[1].textContent, '\u304b\u3093\u3058');
  assert.equal(placed, true);
});

test('combined subtitle hides its background when source is off and translation is whitespace', () => {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/overlay/overlay.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function show('), source.indexOf('function showResult('));
  const context = {
    latestSourceText: '', latestTranslatedText: '',
    sourceEl: {}, translatedEl: {}, box: { style: {}, classList: { remove() { }, add() { } } },
    settings: { showSource: false, sourceFontSize: 12, translatedFontSize: 12 },
    hideTimer: undefined, clearTimeout() { }, applyPlacement() { },
  };
  require('node:vm').runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.show('Source', ' \n ', -1);
  assert.equal(context.box.style.display, 'none');
  assert.equal(context.translatedEl.textContent, '');
  context.show('Source', '\nTranslation\n', -1);
  assert.equal(context.box.style.display, '');
  assert.equal(context.translatedEl.textContent, 'Translation');
  context.settings.showSource = true;
  context.show('Source', '', -1);
  assert.equal(context.box.style.display, '');
});

for (const platform of ['darwin', 'win32']) {
test(`cropped frame geometry projects into global logical coordinates on ${platform}`, async () => {
  const scale = platform === 'win32' ? 2 : 1;
  const cropped = { getSize: () => ({ width: 400, height: 200 }), toJPEG: () => Buffer.from('crop') };
  let cropBounds;
  const capture = captureWithStreams(class {
    async capture() {
      return { getSize: () => ({ width: 2000, height: 1600 }), crop: (bounds) => { cropBounds = bounds; return cropped; } };
    }
    dispose() { }
  }, platform);
  const frames = await capture.capture([{
    regionId: 'region-1', display: { id: 2, scaleFactor: 2, bounds: { x: -1000, y: 0, width: 1000, height: 800 } },
    region: { left: -800 * scale, top: 100 * scale, width: 200 * scale, height: 100 * scale },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(cropBounds)), { x: 400, y: 200, width: 400, height: 200 });
  assert.deepEqual(JSON.parse(JSON.stringify(frames[0].geometry.screenBoundsDip)), { x: -800, y: 100, width: 200, height: 100 });
  capture.stop();
});
}

test('hover selection picks the frontmost window and handles negative monitor coordinates', () => {
  const { windowAtPoint } = loadDesktopModule('src/main/window-picker.ts', {
    electron: {}, './window-metadata': loadDesktopModule('src/main/window-metadata.ts', {}),
  });
  const front = { id: 10, name: 'Front', bounds: { x: -900, y: -100, width: 400, height: 300 } };
  const back = { id: 20, name: 'Back', bounds: { x: -1000, y: -200, width: 900, height: 600 } };
  assert.equal(windowAtPoint([front, back], { x: -700, y: 0 }), front);
  assert.equal(windowAtPoint([front, back], { x: -500, y: 0 }), back);
  assert.equal(windowAtPoint([front, back], { x: 100, y: 0 }), undefined);
});

for (const platform of ['darwin', 'win32']) {
  test(`hover picker validates IPC, scales native bounds, and releases resources on ${platform}`, async () => {
    const { EventEmitter } = require('node:events');
    const handlers = new Map();
    const pickers = [];
    const helper = new EventEmitter();
    helper.stderr = new EventEmitter();
    helper.stdout = {};
    helper.kill = () => { helper.killed = true; helper.emit('exit'); };
    const lines = new EventEmitter();
    lines.close = () => { lines.closed = true; };
    let point = { x: -500, y: 50 };
    let intervalCleared = false;
    let selected;
    class Picker extends EventEmitter {
      constructor(options) {
        super();
        this.bounds = options;
        this.webContents = new EventEmitter();
        this.webContents.isLoadingMainFrame = () => false;
        this.webContents.send = () => { };
        pickers.push(this);
      }
      setAlwaysOnTop() { }
      setVisibleOnAllWorkspaces() { }
      async loadFile() { }
      show() { }
      focus() { }
      getBounds() { return this.bounds; }
      isDestroyed() { return !!this.destroyed; }
      destroy() { this.destroyed = true; this.emit('closed'); }
    }
    const { HoverWindowPicker } = loadDesktopModule('src/main/window-picker.ts', {
      './window-metadata': loadDesktopModule('src/main/window-metadata.ts', {}, { process: { platform, pid: process.pid } }),
      'node:child_process': {
        spawn: (binary, args, options) => {
          assert.equal(options.windowsHide, true);
          if (platform === 'win32') {
            assert.equal(binary, 'powershell.exe');
            assert.ok(args.includes('-ExcludedProcessId'));
            assert.equal(args.at(-1), String(process.pid));
          } else assert.deepEqual(Array.from(args), [String(process.pid)]);
          return helper;
        }
      },
      'node:readline': { createInterface: () => lines },
      electron: {
        BrowserWindow: Picker,
        ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) },
        screen: {
          screenToDipRect: (_window, bounds) => Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value / 1.25])),
          getCursorScreenPoint: () => point, getAllDisplays: () => [
            { bounds: { x: -1000, y: 0, width: 1000, height: 800 } },
            { bounds: { x: 0, y: 0, width: 1000, height: 800 } },
          ]
        },
      },
    }, {
      process: { platform, pid: process.pid },
      setInterval: () => 123, clearInterval: (id) => { intervalCleared = id === 123; },
    });
    const picker = new HoverWindowPicker('/dist', async (id) => { selected = id; });
    await picker.start();
    const scale = platform === 'win32' ? 1.25 : 1;
    lines.emit('line', JSON.stringify([{
      id: 42, name: 'Book', bounds: {
        x: -600 * scale, y: 20 * scale, width: 300 * scale, height: 500 * scale,
      }
    }]));
    const event = { sender: pickers[0].webContents };
    const state = handlers.get('window-picker:state')(event);
    assert.equal(state.name, 'Book');
    assert.deepEqual(JSON.parse(JSON.stringify(state.bounds)), { x: 400, y: 20, width: 300, height: 500 });
    assert.throws(() => handlers.get('window-picker:state')({ sender: {} }), /not active/);
    assert.equal(await handlers.get('window-picker:select')({ sender: {} }), false);
    assert.equal(await handlers.get('window-picker:select')(event, 'arbitrary-source-id'), true);
    assert.equal(selected, 42);
    point = { x: 999, y: 799 };
    assert.equal(await handlers.get('window-picker:select')(event), false);
    handlers.get('window-picker:cancel')(event);
    assert.equal(helper.killed, true);
    assert.equal(lines.closed, true);
    assert.equal(intervalCleared, true);
    assert.equal(handlers.size, 0);
    assert.ok(pickers.every((win) => win.destroyed));
    picker.dispose(); // Idempotent, including after the helper's exit event.
  });
}

test('Windows window bounds use the same native window ID and convert physical pixels to DIP', async () => {
  const { readWindowBounds } = loadDesktopModule('src/main/window-bounds.ts', {
    'node:util': {
      promisify: (fn) => (...args) => new Promise((resolve, reject) => {
        fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      })
    },
    './window-metadata': loadDesktopModule('src/main/window-metadata.ts', {}, { process: { platform: 'win32', pid: 123 } }),
    electron: {
      screen: {
        screenToDipRect: (window, rect) => {
          assert.equal(window, null);
          return Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value / 1.25]));
        }
      }
    },
    'node:child_process': {
      execFile(binary, args, options, callback) {
        assert.equal(binary, 'powershell.exe');
        assert.equal(args.at(-1), '-Once');
        assert.equal(options.windowsHide, true);
        callback(null, JSON.stringify([{ id: 42, bounds: { x: -750, y: 25, width: 375, height: 625 } }]), '');
      }
    },
  }, { process: { platform: 'win32', pid: 123 } });
  assert.deepEqual(JSON.parse(JSON.stringify(await readWindowBounds('window:42:0'))), { x: -600, y: 20, width: 300, height: 500 });
  assert.equal(await readWindowBounds('window:99:0'), undefined);
});

test('window picker startup failures dispose resources and report an error without rejecting', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const start = source.indexOf('async function openRegionPickerWindows(');
  const body = source.slice(start, source.indexOf('  areaPickerSettings = captureSettings;', start)) + '\n}';
  const statuses = [];
  let disposed = false;
  const context = {
    __dirname: '/dist', windowPicker: null,
    closeRegionPickerWindows() { },
    HoverWindowPicker: class {
      async start() { throw new Error('Native helper unavailable'); }
      dispose() { disposed = true; }
    },
    publishStreamStatus: (status) => statuses.push(status),
    console: { error() { } },
  };
  const ts = require('typescript');
  require('node:vm').runInNewContext(ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  await context.openRegionPickerWindows({ mode: 'selected_window' });
  assert.equal(disposed, true);
  assert.equal(context.windowPicker, null);
  assert.equal(statuses[0].state, 'error');
  assert.match(statuses[0].message, /Native helper unavailable/);
});

test('a new capture session uploads while an old mode sample is pending and ignores its late completion', async () => {
  const { EventEmitter } = require('node:events');
  const sockets = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { super(); sockets.push(this); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const timers = new Map();
  let timerId = 0, samples = 0, finishOld, finishNew;
  const settings = { backendUrl: 'ws://127.0.0.1:8765/v1/stream', backendToken: '', polling_ms: 900,
    mode: 'one_large_area', ocrLang: 'en', targetLanguage: 'zh-Hant' };
  const { DesktopStream } = loadDesktopModule('src/main/backend-client.ts', {
    ws: Socket,
    './protocol': { parseServerMessage: JSON.parse, encodeImageEnvelope: header => Buffer.from(JSON.stringify(header)) },
  }, {
    URL,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const stream = new DesktopStream({ appVersion: 'test', getSettings: () => settings,
    captureFrames: () => {
      samples++;
      if (samples === 1) return new Promise(resolve => { finishOld = resolve; });
      return new Promise(resolve => { finishNew = resolve; });
    }, onStatus() {}, onResult() {}, onClear() {},
  });
  stream.start();
  const oldSession = stream.sessionId;
  stream.handleMessage({ type: 'session.state', sessionId: oldSession, paused: false });
  stream.clearCaptureTimer();
  const oldCapture = stream.captureOnce();
  settings.mode = 'multiple_regions';
  stream.refreshCapture();
  const newSession = stream.sessionId;
  assert.notEqual(newSession, oldSession);
  stream.handleMessage({ type: 'session.state', sessionId: newSession, paused: false });
  stream.clearCaptureTimer();
  const newCapture = stream.captureOnce();
  assert.equal(samples, 2);
  const frame = { regionId: 'region-1', width: 100, height: 50, jpeg: Buffer.from('frame') };
  const scheduledBeforeOldCompletion = [...timers.entries()];
  finishOld([frame]);
  await oldCapture;
  assert.equal(stream.captureRunningSession, newSession);
  assert.deepEqual([...timers.entries()], scheduledBeforeOldCompletion);
  await stream.captureOnce();
  assert.equal(samples, 2); // Old completion did not unlock the new sample.
  finishNew([frame]);
  await newCapture;
  const uploads = sockets[1].sent.filter(Buffer.isBuffer).map(data => JSON.parse(data.toString()));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].sessionId, newSession);
  assert.equal(sockets[0].sent.filter(Buffer.isBuffer).length, 0);
  assert.equal(stream.captureRunningSession, null);
  stream.stop();
});

test('stopping capture discards late old-mode frames without suppressing the new target', async () => {
  let samples = 0, finishOld;
  const image = { getSize: () => ({ width: 100, height: 50 }), toJPEG: () => Buffer.from('same-text') };
  const capture = captureWithStreams(class {
    async capture() {
      if (++samples === 1) return new Promise(resolve => { finishOld = resolve; });
      return image;
    }
    dispose() {}
  });
  const target = [{ regionId: 'region-1', display: { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 100, height: 50 } } }];
  const old = capture.capture(target);
  capture.stop();
  assert.equal((await capture.capture(target)).length, 1);
  finishOld(image);
  assert.equal((await old).length, 0);
  assert.equal((await capture.capture(target)).length, 1);
  capture.stop();
});

test('capture reuses one stream, samples fresh frames, and releases it on stop', async () => {
  let started = 0;
  let sampled = 0;
  let disposed = 0;
  const capture = captureWithStreams(class {
    constructor() { started += 1; }
    async capture() {
      sampled += 1;
      return {
        getSize: () => ({ width: 1920, height: 1080 }),
        toJPEG: () => Buffer.from(`fresh-jpeg-${sampled}`),
      };
    }
    dispose() { disposed += 1; }
  });
  const targets = [{
    regionId: 'screen-2',
    display: { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
  }];
  const frames = await capture.capture(targets);
  const nextFrames = await capture.capture(targets);
  assert.equal(started, 1);
  assert.equal(sampled, 2);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].jpeg.toString(), 'fresh-jpeg-1');
  assert.equal(nextFrames[0].jpeg.toString(), 'fresh-jpeg-2');
  assert.equal(frames[0].geometry.displayId, 2);
  capture.stop();
  assert.equal(disposed, 1);
  await capture.capture(targets);
  assert.equal(started, 2);
  await capture.capture([]);
  assert.equal(disposed, 2);
});

test('different selected windows on the same display use separate streams and window geometry', async () => {
  const started = [];
  const capture = captureWithStreams(class {
    constructor(_display, _page, sourceId) { this.sourceId = sourceId; started.push(sourceId); }
    async capture() {
      return { getSize: () => ({ width: 800, height: 600 }), toJPEG: () => Buffer.from(this.sourceId) };
    }
    dispose() { }
  });
  const display = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
  const frames = await capture.capture([
    { regionId: 'a', display, windowSource: { id: 'window:41:0', name: 'Book A' } },
    { regionId: 'b', display, windowSource: { id: 'window:42:0', name: 'Book B' } },
  ]);
  assert.deepEqual(started, ['window:41:0', 'window:42:0']);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].geometry.sourceKind, 'window');
  assert.equal(frames[0].geometry.windowId, 'window:41:0');
  assert.equal(frames[1].geometry.windowId, 'window:42:0');
  assert.equal(frames[0].geometry.displayBoundsDip, undefined);
  capture.stop();
});

function screenStreamHarness(sources, failure, { snapshots = [], now = () => Date.now(), windowSourceId } = {}) {
  let handler;
  let enumerationCount = 0;
  let selectedSource;
  let destroyed = false;
  const captureSession = { setDisplayMediaRequestHandler(next) { handler = next; } };
  class Worker {
    constructor() {
      this.webContents = {
        mainFrame: {}, session: captureSession,
        isDestroyed: () => destroyed,
        setWindowOpenHandler() { }, on() { },
        executeJavaScript: async (script) => {
          if (failure) return { ok: false, ...failure };
          if (script.includes('.start(')) {
            return new Promise((resolve) => handler({
              frame: this.webContents.mainFrame, videoRequested: true, audioRequested: false,
            }, (streams) => {
              selectedSource = streams.video;
              if (streams.video) resolve({ ok: true });
              else resolve({ ok: false, name: 'NotAllowedError', message: 'Selected display was not granted' });
            }));
          } else return { ok: true, value: snapshots.length ? snapshots.shift() : 'data:image/png;base64,frame' };
        },
      };
    }
    isDestroyed() { return destroyed; }
    async loadFile() { }
    destroy() { destroyed = true; }
  }
  const { ScreenStream } = loadDesktopModule('src/main/screen-stream.ts', {
    electron: {
      BrowserWindow: Worker,
      session: { fromPartition: () => captureSession },
      desktopCapturer: {
        async getSources(options) {
          assert.deepEqual({ ...options.thumbnailSize }, { width: 0, height: 0 });
          assert.deepEqual([...options.types], windowSourceId ? ['window'] : ['screen']);
          enumerationCount += 1;
          return sources;
        }
      },
      nativeImage: { createFromDataURL: () => ({ isEmpty: () => false }) },
    },
  }, { Date: { now } });
  return {
    stream: new ScreenStream({ id: 2, bounds: { width: 1920, height: 1080 }, scaleFactor: 2 }, 'worker.html', windowSourceId),
    state: () => ({ enumerationCount, selectedSource, destroyed }),
  };
}

test('screen stream selects the exact display once without accessing preview thumbnails', async () => {
  const sources = [
    { id: 'screen:1:0', display_id: '1' },
    { id: 'screen:2:0', display_id: '2' },
  ];
  const { stream, state } = screenStreamHarness(sources);
  await stream.capture();
  await stream.capture();
  assert.equal(state().enumerationCount, 1);
  assert.equal(state().selectedSource, sources[1]);
  stream.dispose();
  assert.equal(state().destroyed, true);
});

test('window capture grants the chosen window ID and reuses its stream', async () => {
  const sources = [{ id: 'window:41:0' }, { id: 'window:42:0' }];
  const { stream, state } = screenStreamHarness(sources, undefined, { windowSourceId: 'window:42:0' });
  await stream.capture();
  await stream.capture();
  assert.equal(state().selectedSource, sources[1]);
  assert.equal(state().enumerationCount, 1);
  stream.dispose();
});

test('a missing selected window never falls back to another available window', async () => {
  const { stream, state } = screenStreamHarness([{ id: 'window:41:0', display_id: '2' }], undefined, { windowSourceId: 'window:42:0' });
  await assert.rejects(stream.capture(), /Selected window.*NotAllowedError/);
  assert.equal(state().selectedSource, undefined);
  stream.dispose();
});

test('screen stream refuses another monitor when the selected display is missing', async () => {
  const { stream, state } = screenStreamHarness([{ id: 'screen:1:0', display_id: '1' }]);
  await assert.rejects(stream.capture(), /Selected display was not granted/);
  assert.equal(state().selectedSource, undefined);
  stream.dispose();
});

test('screen stream preserves the worker error name, message, display and stage', async () => {
  const { stream } = screenStreamHarness([], { name: 'NotReadableError', message: 'Could not start video source' });
  await assert.rejects(stream.capture(), /Display 2 capture start failed: NotReadableError: Could not start video source/);
  stream.dispose();
});

test('screen stream keeps its connection through temporary frame gaps', async () => {
  const { stream, state } = screenStreamHarness([{ id: 'screen:2:0', display_id: '2' }], undefined, {
    snapshots: [null, null, 'data:image/png;base64,frame'],
  });
  assert.equal(await stream.capture(), null);
  assert.equal(await stream.capture(), null);
  assert.ok(await stream.capture());
  assert.equal(state().enumerationCount, 1);
  assert.equal(state().destroyed, false);
  stream.dispose();
});

test('screen stream reports a prolonged frame gap instead of waiting forever', async () => {
  let now = 0;
  const { stream } = screenStreamHarness([{ id: 'screen:2:0', display_id: '2' }], undefined, {
    snapshots: [null, null, null], now: () => now,
  });
  assert.equal(await stream.capture(), null);
  now = 14999;
  assert.equal(await stream.capture(), null);
  now = 15000;
  await assert.rejects(stream.capture(), /no usable video frame for 15 seconds/);
  stream.dispose();
});

test('capture worker skips muted/not-ready video but rejects an ended track', async () => {
  const window = { addEventListener() { } };
  const track = { readyState: 'live', muted: true, stop() { } };
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0, async play() { } };
  const canvas = { getContext: () => ({ drawImage() { } }), toDataURL: () => 'data:image/png;base64,frame' };
  loadDesktopModule('src/renderer/capture/capture.ts', {}, {
    window, setTimeout, clearTimeout,
    document: { body: { append() { } }, createElement: (tag) => tag === 'video' ? video : canvas },
    navigator: { mediaDevices: { async getDisplayMedia() { return { getVideoTracks: () => [track], getTracks: () => [track] }; } } },
  });
  await window.screenCapture.start({ width: 1920, height: 1080 });
  assert.equal(window.screenCapture.snapshot(), null);
  track.muted = false;
  assert.equal(window.screenCapture.snapshot(), null);
  Object.assign(video, { readyState: 2, videoWidth: 1920, videoHeight: 1080 });
  assert.equal(window.screenCapture.snapshot(), 'data:image/png;base64,frame');
  track.readyState = 'ended';
  assert.throws(() => window.screenCapture.snapshot(), /Screen stream has ended/);
});

test('temporary frame gaps produce no upload and do not dispose the display stream', async () => {
  let samples = 0;
  let disposed = 0;
  let started = 0;
  const capture = captureWithStreams(class {
    constructor() { started += 1; }
    async capture() {
      if (++samples === 1) return null;
      return { getSize: () => ({ width: 1920, height: 1080 }), toJPEG: () => Buffer.from('fresh-frame') };
    }
    dispose() { disposed += 1; }
  });
  const targets = [{ regionId: 'screen-2', display: { id: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } }];
  assert.equal((await capture.capture(targets)).length, 0);
  assert.equal((await capture.capture(targets)).length, 1);
  assert.equal(started, 1);
  assert.equal(disposed, 0);
  capture.stop();
});

test('a failed stream is disposed and its actual error is reported', async () => {
  let started = 0;
  let disposed = 0;
  const capture = captureWithStreams(class {
    constructor() { started += 1; }
    async capture() { throw new Error('Screen stream has ended'); }
    dispose() { disposed += 1; }
  });
  const targets = [{
    regionId: 'screen-2',
    display: { id: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  }];
  await assert.rejects(capture.capture(targets), /Screen stream has ended/);
  await assert.rejects(capture.capture(targets), /Screen stream has ended/);
  assert.equal(started, 2);
  assert.equal(disposed, 2);
});
