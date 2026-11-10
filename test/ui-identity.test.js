import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// client.js 是浏览器模块（window.__ModuleLoader__），这里做静态接线守卫：
// 显示名称（hello 双向）、好友备注、Peer ID 占用恢复都不能在后续重构里被悄悄改坏。
const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const LINES = SRC.split('\n');

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker);
  assert.ok(start >= 0, 'missing marker: ' + startMarker);
  assert.ok(end > start, 'missing end marker: ' + endMarker);
  return SRC.slice(start, end);
}

// ── 显示名称 ────────────────────────────────────────────────────────────────

test('identity: 昵称持久化在 settings.nickname 且长度受控', () => {
  assert.ok(SRC.includes('const DEFAULT_SETTINGS = { allowBroadcast: false, allowIncoming: true, nickname: \'\' }'));
  const settings = slice('function coerceSettings(raw)', 'function loadState()');
  assert.ok(settings.includes('nickname:'), 'coerceSettings 缺少 nickname');
  assert.ok(settings.includes('MAX_NAME_LEN') && settings.includes('slice(0, MAX_NAME_LEN)'), 'nickname 未截断');
});

test('identity: 显示名留空回退 ID 前缀，不再写死“我”', () => {
  const getter = slice('getNickname() {', '// 双向 hello');
  assert.ok(getter.includes('sanitizeName(this.settings.nickname)'));
  assert.ok(getter.includes('shortId(this.myId)'));
  assert.ok(!SRC.includes("name: '我'"), '仍存在写死的 name: 我');
});

test('identity: hello 双向发送（主动连接 + 入站连接都发）', () => {
  const sendHello = slice('sendHello(conn) {', 'broadcastHello() {');
  assert.ok(sendHello.includes("type: 'hello'") && sendHello.includes('name: this.getNickname()'));
  const connect = slice('connectTo(id, opts) {', 'ensureFriend(id) {');
  assert.ok(connect.includes('this.sendHello(conn)'), '主动连接未发 hello');
  const incoming = slice('handleIncomingConn(conn) {', 'conn.on(\'data\'');
  assert.ok(incoming.includes('this.sendHello(conn)'), '入站连接未回发 hello');
});

test('identity: 修改显示名会持久化并广播 hello', () => {
  const setter = slice('setNickname(raw) {', '// 好友备注名');
  assert.ok(setter.includes('settings: Object.assign({}, prev.settings'));
  assert.ok(setter.includes('nickname: clean'));
  assert.ok(setter.includes('this.broadcastHello()'));
  assert.ok(setter.includes('sanitizeName'));
});

test('identity: hello 只更新对方昵称 name，不覆盖本地备注 alias', () => {
  const hello = slice("if (data.type === 'hello') {", '      handleClose(remoteId) {');
  assert.ok(hello.includes('{ name }'), 'hello 未写 name');
  assert.ok(!hello.includes('alias'), 'hello 不应写 alias');
});

// ── 好友备注名 ──────────────────────────────────────────────────────────────

test('identity: 备注名优先级 alias > name > ID 前缀', () => {
  const display = slice('function displayName(friend) {', 'function fmtTime(ts) {');
  const order = display.indexOf('friend.alias || friend.name || shortId(friend.id)');
  assert.ok(order >= 0, 'displayName 优先级错误: ' + display.slice(0, 200));
});

test('identity: 配置入口写入 friend.alias 并持久化', () => {
  const setter = slice('setFriendAlias(id, raw) {', '// ── Peer ID 占用恢复');
  assert.ok(setter.includes('alias'));
  assert.ok(setter.includes('friends[idx] = Object.assign({}, friends[idx], { alias })'));
});

test('identity: 好友列表/搜索/聊天标题/右键菜单都用 displayName', () => {
  assert.ok(SRC.includes('.filter(f => (displayName(f)).toLowerCase().includes(q)'), '搜索未用 displayName');
  assert.ok(SRC.includes("h('div', { className: 'pm-friend-name', title:"), '好友名未用备注');
  assert.ok(SRC.includes('displayName(f)'));
  assert.ok(SRC.includes("h('div', { className: 'pm-chat-header-name'"), '聊天标题缺失');
  assert.ok(SRC.includes('displayName(active)'));
  assert.ok(SRC.includes("'✎'), '设置备注名…'"), '右键菜单缺少备注入口');
});

// ── Peer ID 占用 / 重置 ─────────────────────────────────────────────────────

test('identity: unavailable-id 提示可操作（重试 / 重置），不再只说刷新页面', () => {
  const branch = slice("if (type === 'unavailable-id') {", "} else if (type === 'network'");
  assert.ok(branch.includes('其他 DSH 标签页'));
  assert.ok(branch.includes('重试连接') && branch.includes('重置 ID'));
  assert.ok(!branch.includes('请刷新页面重试'));
  assert.ok(SRC.includes("peerErrorType === 'unavailable-id'"), 'UI 未按错误类型显示重置按钮');
});

test('identity: 重试连接沿用固定 ID，重置 ID 写入 localStorage 并重连', () => {
  const retry = slice('retryPeer() {', 'resetPeerId() {');
  assert.ok(retry.includes('this.initPeer()'));
  assert.ok(retry.includes('this.peerErrorType'));
  const reset = slice('resetPeerId() {', '// 入站数据');
  assert.ok(reset.includes('generatePeerId()'));
  assert.ok(reset.includes('localStorage.setItem(PEER_ID_KEY, nextId)'));
  assert.ok(reset.includes('this.retryPeer()'));
  assert.ok(SRC.includes("className: 'pm-link-btn'"));
  assert.ok(SRC.includes("title: '重置 Peer ID（生成新 ID）'"));
});

test('identity: 重置 ID 有二次确认与风险说明', () => {
  assert.ok(SRC.includes('showResetId'));
  assert.ok(SRC.includes('旧好友仍保留在列表，但对方需要重新添加你的新 ID'));
  assert.ok(SRC.includes("onClick: () => { pmService.resetPeerId(); setShowResetId(false); }"));
});

test('identity: 昵称/备注/重置 ID 弹窗支持 Escape 关闭', () => {
  const effect = slice('// 自动回复设置 / 待批准 / 昵称 / 备注 / 重置 ID 弹窗：Escape 关闭。', '// 自动滚动到底部');
  for (const state of ['showNickname', 'renameFriend', 'showResetId']) {
    assert.ok(effect.includes(state), 'Escape 处理缺少 ' + state);
  }
});