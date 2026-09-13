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
