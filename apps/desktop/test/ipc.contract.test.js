const test = require('node:test');
const assert = require('node:assert/strict');

function validateSubtitle(payload) {
  assert.equal(payload.type, 'subtitle');
  assert.equal(typeof payload.profile, 'string');
  assert.equal(typeof payload.timestamp, 'number');
  assert.equal(typeof payload.source_text, 'string');
  assert.ok(payload.translated_text === null || typeof payload.translated_text === 'string');
  assert.equal(typeof payload.lang_src, 'string');
  assert.equal(typeof payload.lang_dst, 'string');
  assert.equal(typeof payload.dedupe_key, 'string');
  assert.equal(typeof payload.hide_after_ms, 'number');
}

test('subtitle contract', () => {
  const payload = {
    type: 'subtitle',
    profile: 'demo',
    timestamp: 1770000000.25,
    source_text: 'Hello',
    translated_text: '你好',
    lang_src: 'en',
    lang_dst: 'zh-Hant',
    dedupe_key: 'abc123',
    hide_after_ms: 2300
  };
  validateSubtitle(payload);
});

test('subtitle_hide contract', () => {
  const payload = {
    type: 'subtitle_hide',
    profile: 'demo',
    timestamp: 1770000002.0,
    reason: 'timeout'
  };
  assert.equal(payload.type, 'subtitle_hide');
  assert.equal(typeof payload.profile, 'string');
  assert.equal(typeof payload.timestamp, 'number');
  assert.equal(typeof payload.reason, 'string');
});
