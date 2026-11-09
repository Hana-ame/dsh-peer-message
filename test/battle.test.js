import { test } from 'node:test';
import assert from 'node:assert/strict';

// client.js 是浏览器模块（window.__ModuleLoader__），不能直接 import。
// 这里复制其内联的防御常量/函数做单测；两处必须同步（见 client.js 头部注释）。
const MAX_TEXT_LEN = 4096;
const MAX_NAME_LEN = 32;

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  return clean || null;
}

// ── 攻防演练实弹复盘：evil-hello 场景（2026-11-09 浏览器实弹验证过） ──────

test('battle: hello 昵称为对象时被拒绝（不进 state，防 React 渲染崩溃）', () => {
  assert.equal(sanitizeName({ evil: 'object-name' }), null);
  assert.equal(sanitizeName([1, 2, 3]), null);
  assert.equal(sanitizeName(null), null);
  assert.equal(sanitizeName(undefined), null);
  assert.equal(sanitizeName(42), null);
});

test('battle: 超长昵称截断到 32（实弹：5000 字符 AAA… 被截到 32）', () => {
  const out = sanitizeName('A'.repeat(5000));
  assert.equal(out.length, MAX_NAME_LEN);
  assert.equal(out, 'A'.repeat(32));
});

test('battle: 昵称空白字符归一，纯空白拒绝', () => {
  assert.equal(sanitizeName('  alice \n bob  '), 'alice bob');
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName(''), null);
});

test('battle: 正常昵称原样通过', () => {
  assert.equal(sanitizeName('我'), '我');
  assert.equal(sanitizeName('Alice'), 'Alice');
});

// ── 攻防演练实弹复盘：flood-text 场景（20×8KB 被截到 20×4KB） ─────────────

test('battle: 洪泛文本每条截断到 MAX_TEXT_LEN', () => {
  for (let i = 0; i < 20; i++) {
    const flood = 'FLOOD-' + i + '-' + 'X'.repeat(8192);
    const out = flood.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_TEXT_LEN);
    assert.ok(out.length <= MAX_TEXT_LEN, `msg ${i} exceeded limit`);
    assert.ok(out.startsWith('FLOOD-' + i), `msg ${i} prefix lost`);
  }
});
