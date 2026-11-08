import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pushItem, outbox } from '../outbox.js';
import {
  isValidPeerId,
  sanitizeText,
  PEER_ID_PREFIX,
  PEER_ID_MIN_LEN,
  PEER_ID_MAX_LEN,
  MAX_TEXT_LEN,
} from '../validate.js';

// ── validate.js ────────────────────────────────────────────────────────────

test('isValidPeerId rejects non-strings and empty values', () => {
  assert.equal(isValidPeerId(null), false);
  assert.equal(isValidPeerId(undefined), false);
  assert.equal(isValidPeerId(''), false);
  assert.equal(isValidPeerId(12345), false);
  assert.equal(isValidPeerId({}), false);
});

test('isValidPeerId rejects a bare prefix and wrong-length IDs', () => {
  // 'dsh-pm-' is only 7 chars — below the 16-char minimum.
  assert.equal(isValidPeerId(PEER_ID_PREFIX), false);
  assert.equal(isValidPeerId(PEER_ID_PREFIX + 'abc'), false);
  // Too short even with prefix.
  assert.equal(isValidPeerId(PEER_ID_PREFIX + 'x'.repeat(PEER_ID_MIN_LEN - PEER_ID_PREFIX.length - 1)), false);
  // Too long.
  assert.equal(isValidPeerId(PEER_ID_PREFIX + 'x'.repeat(PEER_ID_MAX_LEN - PEER_ID_PREFIX.length + 1)), false);
});

test('isValidPeerId rejects IDs without the legal prefix', () => {
  assert.equal(isValidPeerId('other-prefix-abcdef-123456'), false);
  assert.equal(isValidPeerId('dsh-pm-'.toUpperCase() + 'abcdef'), false);
});

test('isValidPeerId accepts well-formed IDs', () => {
  // A realistic ID: dsh-pm-<8 rand base36>-<6 ts base36> ≈ 24 chars.
  const good = 'dsh-pm-' + 'a1b2c3d4' + '-' + 'mw7v3o';
  assert.equal(isValidPeerId(good), true);
  assert.equal(isValidPeerId('dsh-pm-' + 'x'.repeat(PEER_ID_MIN_LEN - PEER_ID_PREFIX.length)), true);
  assert.equal(isValidPeerId('dsh-pm-' + 'x'.repeat(PEER_ID_MAX_LEN - PEER_ID_PREFIX.length)), true);
});

test('sanitizeText coerces non-strings to empty', () => {
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText(42), '');
  assert.equal(sanitizeText({}), '');
  assert.equal(sanitizeText(['a']), '');
});

test('sanitizeText strips control characters', () => {
  assert.equal(sanitizeText('hi\u0000there'), 'hithere');
  assert.equal(sanitizeText('a\u001bb\u001fc'), 'abc');
  assert.equal(sanitizeText('line\u007fbreak'), 'linebreak');
  // Tab, LF, CR are printable/format and preserved.
  assert.equal(sanitizeText('a\tb\nc\rd'), 'a\tb\nc\rd');
});

test('sanitizeText truncates to MAX_TEXT_LEN', () => {
  const long = 'x'.repeat(MAX_TEXT_LEN + 100);
  const out = sanitizeText(long);
  assert.equal(out.length, MAX_TEXT_LEN);
});

// ── outbox.js ──────────────────────────────────────────────────────────────

test('pushItem appends with defaults and a timestamp', () => {
  outbox.length = 0;
  pushItem({ id: 'm-1', to: 'dsh-pm-aaaabbbb-cccccc', text: 'hello' });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, 'm-1');
  assert.equal(outbox[0].to, 'dsh-pm-aaaabbbb-cccccc');
  assert.equal(outbox[0].text, 'hello');
  assert.equal(typeof outbox[0].ts, 'number');
});

test('pushItem preserves a caller-supplied timestamp', () => {
  outbox.length = 0;
  pushItem({ id: 'm-2', to: 'dsh-pm-aaaabbbb-cccccc', text: 'x', ts: 12345 });
  assert.equal(outbox[0].ts, 12345);
});
