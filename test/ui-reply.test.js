import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// client.js 是浏览器模块（window.__ModuleLoader__），不能直接 import。
// 这里做两件事：
//   1) 复刻客户端侧 coerceReplyConfig，守住与 reply-core.js 相同的默认/回退语义；
//   2) 静态守卫自动回复接线（POST 路由、循环标记、待批准审批、设置字段）。
const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const LINES = SRC.split('\n');

const DEFAULT_REPLY = {
  mode: 'off', permission: 'read', provider: '', model: '', reasoningEffort: '',
  sessionMode: 'dedicated', sessionId: '', cwd: '',
};
const REPLY_MODES = ['off', 'manual', 'auto'];
const PERMISSION_MODES = ['deny-all', 'read', 'write', 'readwrite', 'auto'];
const AUTO_REPLY_PREFIX = '[自动回复] ';

function coerceReplyConfig(raw) {
  const d = DEFAULT_REPLY;
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  return {
    mode: REPLY_MODES.includes(r.mode) ? r.mode : d.mode,
    permission: PERMISSION_MODES.includes(r.permission) ? r.permission : d.permission,
    provider: str(r.provider, 120),
    model: str(r.model, 160),
    reasoningEffort: str(r.reasoningEffort, 60),
    sessionMode: r.sessionMode === 'existing' ? 'existing' : 'dedicated',
    sessionId: str(r.sessionId, 200),
    cwd: str(r.cwd, 500),
  };
}

test('client-reply: 默认关闭 + 只读（与 Host reply-core 一致）', () => {
  assert.deepEqual(coerceReplyConfig(null), DEFAULT_REPLY);
  assert.deepEqual(coerceReplyConfig('garbage'), DEFAULT_REPLY);
  assert.deepEqual(coerceReplyConfig({ mode: 'root', permission: 'god' }), DEFAULT_REPLY);
  // 客户端默认值必须与 Host 端 DEFAULT_REPLY_CONFIG 逐字段一致
  const host = readFileSync(new URL('../reply-core.js', import.meta.url), 'utf8');
  for (const field of Object.keys(DEFAULT_REPLY)) {
    assert.ok(host.includes(`${field}:`), 'reply-core.js 缺少字段 ' + field);
  }
});

test('client-reply: 合法配置保留/裁剪', () => {
  const cfg = coerceReplyConfig({
    mode: 'manual', permission: 'readwrite', provider: '  codearts ', model: 'deepseek-v4.1-flash-1017',
    sessionMode: 'existing', sessionId: 'session-x', cwd: '/tmp/x',
  });
  assert.equal(cfg.mode, 'manual');
  assert.equal(cfg.permission, 'readwrite');
  assert.equal(cfg.provider, 'codearts');
  assert.equal(cfg.sessionMode, 'existing');
  assert.equal(coerceReplyConfig({ provider: 'p'.repeat(300) }).provider.length, 120);
  assert.equal(coerceReplyConfig({ cwd: 'c'.repeat(800) }).cwd.length, 500);
});

test('client-reply: 入站消息会 POST 到 Host 回调路由并携带持久化配置', () => {
  assert.ok(SRC.includes("fetch('/api/pm-reply/request'"), '缺少 /api/pm-reply/request 调用');
  const block = SRC.slice(SRC.indexOf('maybeRequestReply(peerId, text)'), SRC.indexOf('// ── 面板调用的操作'));
  assert.ok(block.includes('config: reply'), '请求未携带 settings.reply');
  assert.ok(block.includes('peerId') && block.includes('peerName'));
});

test('client-reply: 自动回复标记不会再次触发回调（防互刷循环）', () => {
  assert.ok(SRC.includes('AUTO_REPLY_PREFIX = '), '缺少 AUTO_REPLY_PREFIX 常量');
  const block = SRC.slice(SRC.indexOf('maybeRequestReply(peerId, text)'), SRC.indexOf('// ── 面板调用的操作'));
  assert.ok(block.includes('isModelText(clean)'), '缺少模型标记守卫（防 AI 互刷）');
  assert.ok(block.includes("if (reply.mode === 'off') return;"), '关闭模式必须直接跳过');
});

test('client-reply: 待批准/忽略走 Host 路由并刷新列表', () => {
  assert.ok(SRC.includes("fetch('/api/pm-reply/approve'") && SRC.includes("fetch('/api/pm-reply/reject'"));
  assert.ok(SRC.includes("fetch('/api/pm-reply/requests'"), '缺少待批准轮询');
  assert.ok(SRC.includes('approveReply(') && SRC.includes('rejectReply('));
});

test('client-reply: 设置弹窗覆盖模式/权限/endpoint/模型/会话/cwd 字段', () => {
  for (const field of ['mode', 'permission', 'provider', 'model', 'sessionMode', 'sessionId', 'cwd']) {
    assert.ok(SRC.includes(`'data-field': '${field}'`), '缺少字段 ' + field);
  }
  for (const mode of REPLY_MODES) assert.ok(SRC.includes(`'${mode}'`), '缺少模式 ' + mode);
  for (const permission of PERMISSION_MODES) assert.ok(SRC.includes(`'${permission}'`), '缺少权限 ' + permission);
});

test('client-reply: 配置写入主 state 的 settings.reply（随 saveState 持久化）', () => {
  assert.ok(SRC.includes('setReplyConfig(patch)'), '缺少 setReplyConfig');
  assert.ok(/settings:\s*Object\.assign\(\{\}, prev\.settings[^}]*\{ reply: next \}/.test(SRC), 'setReplyConfig 未写入 settings.reply');
  // saveState 白名单必须包含 settings（reply 才能持久化）
  assert.ok(SRC.includes('settings: state.settings,'), 'saveState 未包含 settings');
});

test('client-reply: 浏览器不直接执行工具/模型调用（全部交给 Host）', () => {
  // 浏览器端只允许 fetch 自有 /api/pm-reply/* 与 /api/pm-outbox；不允许出现 child_process/eval 之类执行面。
  assert.ok(!SRC.includes('child_process'));
  assert.ok(!SRC.includes('remote.session'));
  const replyFetches = [...SRC.matchAll(/fetch\('(\/api\/[^']+)'/g)].map((match) => match[1]);
  for (const path of replyFetches) {
    assert.ok(path.startsWith('/api/pm-reply/') || path === '/api/pm-outbox', '意外的 fetch 目标 ' + path);
  }
});