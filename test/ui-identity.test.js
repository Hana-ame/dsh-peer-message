import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// client.js 是浏览器模块（window.__ModuleLoader__），这里做静态接线守卫：
// 显示名称（hello 双向）、好友备注、密钥身份（公钥指纹 Peer ID / 验签 / 轮换）。
const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker);
  assert.ok(start >= 0, 'missing marker: ' + startMarker);
  assert.ok(end > start, 'missing end marker: ' + endMarker);
  return SRC.slice(start, end);
}

// ── 显示名称 ────────────────────────────────────────────────────────────────

test('identity: 昵称持久化在 settings.nickname 且长度受控', () => {
  assert.ok(SRC.includes("const DEFAULT_SETTINGS = { allowBroadcast: false, allowIncoming: true, nickname: '' }"));
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

test('identity: hello 双向发送，且携带公钥+指纹+签名', () => {
  const sendHello = slice('async sendHello(conn) {', 'broadcastHello() {');
  assert.ok(sendHello.includes('buildHello(identity, this.getNickname())'), 'hello 未走密钥签名');
  assert.ok(sendHello.includes('await this.ensureIdentity()'));
  const connect = slice('connectTo(id, opts) {', 'ensureFriend(id) {');
  assert.ok(connect.includes('this.sendHello(conn)'), '主动连接未发 hello');
  const incoming = slice('handleIncomingConn(conn) {', "conn.on('data'");
  assert.ok(incoming.includes('this.sendHello(conn)'), '入站连接未回发 hello');
  const build = slice('async function buildHello(identity, name) {', '// 校验 hello');
  assert.ok(build.includes('fp: identity.fingerprint') && build.includes('pub: identity.pubJwk') && build.includes('sig:'));
});

test('identity: 修改显示名会持久化并广播 hello', () => {
  const setter = slice('setNickname(raw) {', '// 好友备注名');
  assert.ok(setter.includes('settings: Object.assign({}, prev.settings'));
  assert.ok(setter.includes('nickname: clean'));
  assert.ok(setter.includes('this.broadcastHello()'));
  assert.ok(setter.includes('sanitizeName'));
});

test('identity: hello 校验通过后写入 name/verified/公钥，不覆盖本地备注 alias', () => {
  const hello = slice('async handleHello(remoteId, data) {', 'handleClose(remoteId) {');
  assert.ok(hello.includes('verifyHello(remoteId, data)'), '未验签');
  assert.ok(hello.includes('patch.name = name'));
  assert.ok(hello.includes('verified: !!verified.verified'));
  assert.ok(hello.includes('patch.pubKey = verified.pubKey'));
  assert.ok(!hello.includes('alias'), 'hello 不应写 alias');
});

// ── 好友备注名 ──────────────────────────────────────────────────────────────

test('identity: 备注名优先级 alias > name > ID 前缀', () => {
  const display = slice('function displayName(friend) {', 'function fmtTime(ts) {');
  assert.ok(display.includes('friend.alias || friend.name || shortId(friend.id)'));
});

test('identity: 配置入口写入 friend.alias 并持久化', () => {
  const setter = slice('setFriendAlias(id, raw) {', '// 好友备注（注入自动回复上下文');
  assert.ok(setter.includes('alias'));
  assert.ok(setter.includes('friends[idx] = Object.assign({}, friends[idx], { alias })'));
});

test('identity: 好友列表/搜索/聊天标题/右键菜单都用 displayName', () => {
  assert.ok(SRC.includes('.filter(f => (displayName(f)).toLowerCase().includes(q)'), '搜索未用 displayName');
  assert.ok(SRC.includes("h('div', { className: 'pm-friend-name', title:"), '好友名未用备注');
  assert.ok(SRC.includes('displayName(f)'));
  assert.ok(SRC.includes('displayName(active)'));
  assert.ok(SRC.includes("'✎'), '编辑备注…'"), '右键菜单缺少备注入口');
});

// ── 密钥身份 ────────────────────────────────────────────────────────────────

test('identity: Peer ID 由公钥指纹派生，密钥持久化在本机', () => {
  assert.ok(SRC.includes("const IDENTITY_KEY = 'dsh-peer-message-identity-v1'"));
  assert.ok(SRC.includes('const IDENTITY_FP_HEX_LEN = 40'));
  assert.ok(SRC.includes('peerId: PEER_ID_PREFIX + fingerprint'));
  assert.ok(SRC.includes("const IDENTITY_ALGORITHM = 'ECDSA P-256 / SHA-256'"));
  assert.ok(SRC.includes('persistIdentity(identity)'));
  assert.ok(!SRC.includes('getStablePeerId()'), '仍存在随机稳定 ID 入口');
  assert.ok(!SRC.includes('resetPeerId()'), '旧随机 ID 重置入口仍存在');
});

test('identity: 身份先于 Peer 就绪；非安全上下文回退随机 ID 并提示', () => {
  const startBlock = slice('// 身份先于 Peer 就绪', '// agent 队列轮询');
  assert.ok(startBlock.includes('this.ensureIdentity()'));
  assert.ok(startBlock.includes('this.identity.peerId'));
  assert.ok(SRC.includes('当前页面不是安全上下文'));
  assert.ok(SRC.includes('secured: false'));
});

test('identity: 校验失败会断开连接，ID/公钥不匹配或签名无效都拒绝', () => {
  const verify = slice('async function verifyHello(remoteId, data) {', '// ── 侧栏未读徽标');
  assert.ok(verify.includes("reason: 'id-mismatch'"));
  assert.ok(verify.includes("reason: 'bad-signature'"));
  assert.ok(verify.includes('remoteId !== PEER_ID_PREFIX + fingerprint'));
  const handle = slice('async handleHello(remoteId, data) {', 'handleClose(remoteId) {');
  assert.ok(handle.includes('身份校验失败'));
  assert.ok(handle.includes('conn.close()'));
});

test('identity: unavailable-id 提示说明「ID 由公钥派生」，提供重试/身份密钥入口', () => {
  const branch = slice("if (type === 'unavailable-id') {", "} else if (type === 'network'");
  assert.ok(branch.includes('Peer ID 被占用'));
  assert.ok(branch.includes('公钥指纹唯一派生') && branch.includes('不会随机更换'));
  assert.ok(branch.includes('多个标签页已自动选一个持有连接'));
  assert.ok(branch.includes('重试连接'));
  assert.ok(SRC.includes("onClick: () => setShowIdentity(true) }, '身份密钥'"));
  assert.ok(branch.includes('强制重建连接'));
  assert.ok(!branch.includes('请刷新页面重试'));
  assert.ok(SRC.includes("peerErrorType === 'unavailable-id'"));
});

test('identity: 重试连接沿用同一密钥身份，不再随机生成 ID', () => {
  const retry = slice('retryPeer() {', 'async regenerateIdentity() {');
  assert.ok(retry.includes('this.identity.peerId'));
  assert.ok(retry.includes('this.initPeer()'));
  assert.ok(retry.includes('同一身份密钥重连'));
});

test('identity: 新身份=重新生成密钥对并持久化，UI 有身份密钥入口', () => {
  const region = slice('async regenerateIdentity() {', '// 入站数据');
  assert.ok(region.includes('generateIdentity()'));
  assert.ok(region.includes('persistIdentity(next)'));
  assert.ok(region.includes('this.retryPeer()'));
  assert.ok(SRC.includes('身份密钥'));
  assert.ok(SRC.includes("title: '身份密钥：查看公钥指纹 / 更换密钥身份'"));
  assert.ok(SRC.includes('公钥指纹（用于核对身份）'));
  assert.ok(SRC.includes('轮换身份密钥（会更换身份与 Peer ID）'));
  assert.ok(SRC.includes('已轮换身份密钥'));
});

test('identity: 生成新身份有二次确认与私钥/身份变化风险说明', () => {
  assert.ok(SRC.includes('showIdentity'));
  assert.ok(SRC.includes('window.confirm('));
  assert.ok(SRC.includes('Peer ID 会变化，好友需要重新添加你'));
  assert.ok(SRC.includes('私钥只保存在本机 localStorage'));
  assert.ok(SRC.includes('旧好友仍在列表但需要重新添加你'));
});

test('identity: 好友已验签显示 🔐，聊天状态区分已验签/未验签', () => {
  assert.ok(SRC.includes("f.verified ? h('span', { className: 'pm-verified-badge'"));
  assert.ok(SRC.includes("active.verified ? '在线 · 身份已验签'"));
  assert.ok(SRC.includes("在线 · 未验签"));
  assert.ok(SRC.includes("· 指纹 ' + shortFingerprint(active.fingerprint)"));
});

test('identity: 昵称/备注/身份密钥弹窗支持 Escape 关闭', () => {
  const effect = slice('// 自动回复设置 / 待批准 / 昵称 / 备注 / 身份密钥弹窗：Escape 关闭。', '// 自动滚动到底部');
  for (const state of ['showNickname', 'editFriend', 'showIdentity']) {
    assert.ok(effect.includes(state), 'Escape 处理缺少 ' + state);
  }
});


test('identity: 术语统一——只有 Peer ID 一个词，不再混用「身份 ID/我的 ID/重置 ID」', () => {
  for (const banned of ['身份 ID', '我的 ID', '复制 ID', '好友 ID', '重置 ID', '固定 ID']) {
    assert.ok(!SRC.includes(banned), '仍存在混用术语: ' + banned);
  }
  // 关系说明必须出现在身份密钥弹窗，明确「Peer ID = 公钥指纹派生」
  assert.ok(SRC.includes('Peer ID = 由公钥指纹算出的网络标识'));
  assert.ok(SRC.includes('私钥不变，Peer ID 就不变'));
});


test('identity: 身份在侧栏/图标/聊天头/二维码里持续表达（不只是弹窗）', () => {
  // 模块级身份 store + 侧栏常驻行
  assert.ok(SRC.includes('const pmIdentityStore = {'));
  assert.ok(SRC.includes("className: 'pm-identity-row'"));
  assert.ok(SRC.includes("'身份已启用 · 指纹 ' + shortFingerprint(identityFingerprint)"));
  // 面板未打开时侧栏图标也显示 🔐
  assert.ok(SRC.includes("pmIdentityStore.subscribe(setIdentity)"));
  assert.ok(SRC.includes("title: '密钥身份已启用 · 指纹 ' + identity.fingerprint"));
  // 二维码弹窗也展示公钥指纹
  assert.ok(SRC.includes("className: 'pm-modal-fp'"));
  // 指纹短形式可复现
  assert.ok(SRC.includes('function shortFingerprint(fingerprint)'));
});


test('identity: 多标签页单连接持有——Web Locks 选主 + BroadcastChannel 转发，不随机换 Peer ID', () => {
  assert.ok(SRC.includes("const NETWORK_LOCK_NAME = 'dsh-peer-message-network-owner'"));
  assert.ok(SRC.includes('navigator.locks.request(NETWORK_LOCK_NAME'));
  assert.ok(SRC.includes("const NET_CHANNEL_NAME = 'dsh-peer-message-net-v1'"));
  assert.ok(SRC.includes('new BroadcastChannel(NET_CHANNEL_NAME)'));
  assert.ok(SRC.includes("this.role = 'leader'") && SRC.includes("this.role = 'follower'"));
  // follower 镜像 leader 写入的 localStorage 状态
  assert.ok(SRC.includes("event.key !== STORAGE_KEY"));
  assert.ok(SRC.includes('this.state = loadState();'));
  // follower 把用户操作转发给 leader，不自己写 state
  assert.ok(SRC.includes("forwardAction('send'") || SRC.includes("forwardAction('addFriend'"));
  assert.ok(SRC.includes('executeForwardedAction(msg)'));
  // 只有 leader 创建 Peer / 排水 agent outbox / 触发自动回复
  assert.ok(SRC.includes("if (this.role !== 'leader') return;"));
  // 占用错误框不再提供随机重置按钮
  assert.ok(!SRC.includes("setShowResetPeerId"));
  assert.ok(!SRC.includes("'重置 Peer ID'"));
  assert.ok(SRC.includes('连接由本标签页持有') && SRC.includes('连接由其他标签页持有'));
});
