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

test('pushItem preserves validated meta and drops unknown fields', () => {
  outbox.length = 0;
  pushItem({ id: 'm-3', to: 'dsh-pm-aaaabbbb-cccccc', text: 'x', meta: { origin: 'model', trigger: 'manual', model: 'm1', evil: 'ignored' } });
  assert.deepEqual(outbox[0].meta, { origin: 'model', trigger: 'manual', model: 'm1' });
  outbox.length = 0;
  pushItem({ id: 'm-4', to: 'dsh-pm-aaaabbbb-cccccc', text: 'y', meta: 'evil' });
  assert.equal(outbox[0].meta, undefined);
});

test('pushItem preserves a caller-supplied timestamp', () => {
  outbox.length = 0;
  pushItem({ id: 'm-2', to: 'dsh-pm-aaaabbbb-cccccc', text: 'x', ts: 12345 });
  assert.equal(outbox[0].ts, 12345);
});

test('ensureNet: 失败后必须清掉缓存，daemon 后起也能恢复（不能永久 host-network-unavailable）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = src.indexOf('const ensureNet = () => {');
  const block = src.slice(start, start + 2400);
  // 失败路径（resolve null）必须重置 netReady，否则后续请求永远拿到已解析的 null
  assert.ok(block.includes('if (!value) netReady = null'), '缺少「resolve null 时清缓存」');
  assert.ok(block.includes('.catch((error) =>'), '缺少异常分支');
  assert.ok(block.includes('netReady = null;\n        return null;'), '异常分支未清缓存');
  // 预热调用存在（冷启动主动拉起）
  assert.ok(src.includes('\n  ensureNet();'), '缺少启动预热');
});

test('spawnDaemon: 残留 spawn.lock 必须按年龄清理（pid 被复用会死锁）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = src.indexOf('const spawnDaemon = () => {');
  const block = src.slice(start, start + 3000);
  // 必须有年龄判定
  assert.ok(block.includes('SPAWN_LOCK_STALE_MS'), '缺少 spawn.lock 年龄常量');
  assert.ok(block.includes('statSync(spawnLock)'), '未读取锁文件年龄');
  assert.ok(block.includes('mtimeMs'), '未比较 mtime');
  // 过期必须清理并重入（否则永远 return true 不 spawn）
  assert.ok(block.includes('return spawnDaemon()'), '过期锁未重入抢锁');
  assert.ok(block.includes('removing stale spawn lock'), '缺少残留锁清理日志');
  // statSync 必须真的被 import
  assert.ok(src.includes('statSync'), 'statSync 未导入');
});

test('friend session control: 默认禁止，未授权好友的控制请求被丢弃', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/network.js', import.meta.url), 'utf8');
  // 1) friend 默认 canControlSession=false
  assert.ok(src.includes('canControlSession: false'), 'friend 默认值应 false');
  // 2) control-request 处理必须先查权限
  const block = src.slice(src.indexOf("data.type === 'control-request'"), src.indexOf("data.type === 'SOCIAL-NOTICE'"));
  assert.ok(block.includes("ctrlFriend.canControlSession !== true"), '缺少权限校验');
  assert.ok(block.includes('未授权'), '缺少未授权拒绝日志');
  // 3) 未授权时直接 return，不入队
  const beforePush = block.slice(0, block.indexOf('net.controlRequests.push'));
  assert.ok(beforePush.includes('return'), '未授权路径必须提前 return');
  // 4) patchFriend 可设置该权限（本人操作）
  assert.ok(src.includes("friend.canControlSession = patch.canControlSession"), 'patchFriend 未支持该字段');
  // 5) daemon 暴露入口
  const dm = readFileSync(new URL('../server/daemon.mjs', import.meta.url), 'utf8');
  for (const a of ['controlRequests', 'clearControlRequests', 'requestControl']) {
    assert.ok(dm.includes(`${a}:`), `daemon 缺 action ${a}`);
  }
  assert.ok(dm.includes('snapshot.controlRequests'), '/state 未附 controlRequests');
});

test('friend session control: 授权后才入队（逻辑顺序验证）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/network.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("data.type === 'control-request'"), src.indexOf("data.type === 'SOCIAL-NOTICE'"));
  const guardIdx = block.indexOf('canControlSession !== true');
  const pushIdx = block.indexOf('net.controlRequests.push');
  assert.ok(guardIdx > 0 && pushIdx > guardIdx, '权限检查必须在入队之前');
});
