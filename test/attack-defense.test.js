import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pushItem, outbox } from '../outbox.js';
import {
  isValidPeerId,
  sanitizeText,
  PEER_ID_PREFIX,
  MAX_TEXT_LEN,
} from '../validate.js';
import { apply as applyTool, DENY_GLOBAL } from '../tool.js';

// ── 攻防演练：恶意 peer ID ────────────────────────────────────────────────

test('attack: rejects peer IDs containing HTML/JS injection payloads', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    "' OR '1'='1",
    'dsh-pm-"><img onerror=alert(1)>',
    'dsh-pm-`;alert(1)`',
    'dsh-pm-${alert(1)}',
    'dsh-pm-..%2f..%2fetc%2fpasswd',
    'dsh-pm-__proto__',
    'dsh-pm-CONSTRUCTOR', // uppercase not in legal charset
    'dsh-pm-constructor\x00', // NUL byte
  ];
  for (const p of payloads) {
    assert.equal(isValidPeerId(p), false, `should reject: ${p}`);
  }
});

test('attack: rejects peer IDs with illegal characters or path traversal', () => {
  const bad = [
    'dsh-pm-abc def-123456',   // space
    'dsh-pm-abc/def-123456',   // slash
    'dsh-pm-abc\\def-123456',  // backslash
    'dsh-pm-abc?def-123456',   // query
    'dsh-pm-abc#def-123456',   // fragment
    'dsh-pm-abc.def-123456',   // dot (not in legal charset)
    'dsh-pm-abc:def-123456',   // colon
    'dsh-pm-abcde',           // too short (12 chars, below MIN_LEN 16)
    'dsh-pm-' + 'x'.repeat(1000), // excessively long
  ];
  for (const p of bad) {
    assert.equal(isValidPeerId(p), false, `should reject: ${p}`);
  }
});

test('attack: rejects IDs that do not start with the legal prefix', () => {
  assert.equal(isValidPeerId('Dsh-pm-abcdef-123456'), false);
  assert.equal(isValidPeerId('dsh_pm_abcdef-123456'), false);
  assert.equal(isValidPeerId('xsh-pm-abcdef-123456'), false);
  assert.equal(isValidPeerId('dsh-pm-abcdef-123456 '), false); // trailing space
  assert.equal(isValidPeerId(' dsh-pm-abcdef-123456'), false); // leading space
});

// ── 攻防演练：XSS / 控制字符 / 超长注入 ──────────────────────────────────────

test('attack: sanitizeText neutralizes control chars and NUL in message bodies', () => {
  const attacks = [
    ['\u0000<script>alert(1)</script>', '<script>alert(1)</script>'],
    ['hello\u0000world', 'helloworld'],
    ['a\u0001\u0002\u0003b', 'ab'],
    ['\u001b[31mred\u001b[0m', '[31mred[0m'], // ANSI escape removed
    ['tab\tnewline\nret\r', 'tab\tnewline\nret\r'], // format chars preserved
  ];
  for (const [input, expected] of attacks) {
    assert.equal(sanitizeText(input), expected, `for input: ${JSON.stringify(input)}`);
  }
});

test('attack: sanitizeText strips nulls embedded in a long XSS payload', () => {
  const payload = 'x\u0000'.repeat(MAX_TEXT_LEN);
  const out = sanitizeText(payload);
  assert.ok(out.length <= MAX_TEXT_LEN);
  assert.ok(!out.includes('\u0000'));
});

test('attack: sanitizeText truncates an oversized payload to MAX_TEXT_LEN', () => {
  const out = sanitizeText('<script>alert(1)</script>'.repeat(10000));
  assert.equal(out.length, MAX_TEXT_LEN);
});

test('attack: sanitizeText rejects non-string inputs (type confusion)', () => {
  for (const v of [null, undefined, 42, {}, [], true, Symbol('x')]) {
    assert.equal(sanitizeText(v), '');
  }
});

// ── 攻防演练：pm_send 工具加固 ─────────────────────────────────────────────

function capturePmSend() {
  let registered = null;
  const ctx = {
    tools: {
      register(def) { registered = def; },
      restrict() { /* no-op */ },
    },
  };
  applyTool(ctx);
  assert.ok(registered, 'pm_send tool should be registered');
  return registered;
}

test('attack: pm_send rejects an invalid/malicious recipient', async () => {
  const tool = capturePmSend();
  const result = await tool.execute({
    to: '<img onerror=alert(1)>',
    text: 'hi',
  });
  assert.equal(result.queued, false);
  assert.equal(result.messageId, '');
});

test('attack: pm_send rejects a non-string recipient', async () => {
  const tool = capturePmSend();
  for (const to of [null, undefined, 123, {}, [], 'dsh-pm-']) {
    const r = await tool.execute({ to, text: 'hi' });
    assert.equal(r.queued, false, `should reject to=${String(to)}`);
  }
});

test('attack: pm_send sanitizes text and truncates oversized payload', async () => {
  const tool = capturePmSend();
  outbox.length = 0;
  const r = await tool.execute({
    to: 'dsh-pm-aaaabbbb-cccccc',
    text: '<script>alert(1)</script>' + 'x'.repeat(MAX_TEXT_LEN + 10),
  });
  assert.equal(r.queued, true);
  assert.equal(outbox.length, 1);
  assert.ok(outbox[0].text.length <= MAX_TEXT_LEN);
  assert.ok(!outbox[0].text.includes('\u0000'));
});

test('attack: pm_send rejects empty text after sanitize', async () => {
  const tool = capturePmSend();
  const r = await tool.execute({ to: 'dsh-pm-aaaabbbb-cccccc', text: '\u0000' });
  assert.equal(r.queued, false);
});

test('defense: DENY_GLOBAL covers all browser and inject globals', () => {
  const browserTools = [
    'browser_open', 'browser_navigate', 'browser_click', 'browser_type',
    'browser_select', 'browser_screenshot', 'browser_eval', 'browser_get_html',
    'browser_get_text', 'browser_wait', 'browser_close', 'browser_install',
  ];
  const injectTools = ['inject_context_read', 'inject_deliver', 'inject_user_inputs'];
  for (const t of [...browserTools, ...injectTools]) {
    assert.ok(DENY_GLOBAL.includes(t), `DENY_GLOBAL should include ${t}`);
  }
  // Must NOT deny the preset's own scoped tools (kept visible).
  assert.ok(!DENY_GLOBAL.includes('pm_send'));
  assert.ok(!DENY_GLOBAL.includes('web_search'));
  assert.ok(!DENY_GLOBAL.includes('web_fetch'));
});

// ── 攻防演练：outbox 队列 ──────────────────────────────────────────────────

test('attack: pushItem accepts only string id/to/text and sanitizes nothing itself', () => {
  // pushItem is a thin queue; validation happens upstream (validate.js / pm_send).
  // It must at least tolerate malicious text without throwing.
  outbox.length = 0;
  assert.doesNotThrow(() => pushItem({
    id: 'm-x',
    to: 'dsh-pm-aaaabbbb-cccccc',
    text: '<script>alert(1)</script>',
  }));
  assert.equal(outbox.length, 1);
});
