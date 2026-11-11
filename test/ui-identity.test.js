import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 身份/传输的所有权已从浏览器移到 Host 进程：
//   - 私钥、Peer ID、好友/消息/设置 → server/network.js（0600 本地文件）
//   - client.js 只剩视图：轮询快照 + POST 操作
// 这里同时守卫两侧接线，防止有人把权威状态又搬回 localStorage。
const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const NET = readFileSync(new URL('../server/network.js', import.meta.url), 'utf8');
const HOST = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function slice(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  assert.ok(a >= 0, 'missing marker: ' + start);
  assert.ok(b > a, 'missing end marker: ' + end);
  return src.slice(a, b);
}

// ── 显示名称 ────────────────────────────────────────────────────────────────

test('identity: 昵称持久化在 Host state.settings.nickname 且长度受控', () => {
  assert.ok(NET.includes("const DEFAULT_SETTINGS = { allowBroadcast: false, allowIncoming: true, nickname: '' }"));
  assert.ok(NET.includes('function sanitizeName(name)'));
  assert.ok(NET.includes('slice(0, MAX_NAME_LEN)'), '昵称未截断');
  const patch = slice(NET, 'patchSettings(patch) {', 'retryPeer() {');
  assert.ok(patch.includes("if (typeof patch.nickname === 'string')"), 'Host 未接收昵称');
  assert.ok(patch.includes('sendHello(conn)'), '改昵称后未重发 hello');
});

test('identity: 显示名留空回退 Peer ID 前缀，不再写死“我”', () => {
  assert.ok(NET.includes('sanitizeName(net.state.settings.nickname) || net.myId.slice(0, 8)'));
  assert.ok(CLIENT.includes('function shortId(id)'));
  assert.ok(!CLIENT.includes("name: '我'"), '仍存在写死的 name: 我');
});

test('identity: hello 携带公钥+指纹+签名，Host 侧双向发送', () => {
  const build = slice(NET, 'async function buildHello() {', 'async function verifyHello(remoteId, data) {');
  assert.ok(build.includes('fp: net.identity.fingerprint'), 'hello 缺少指纹');
  assert.ok(build.includes('pub: net.identity.pubJwk'), 'hello 缺少公钥');
  assert.ok(build.includes('sig: b64(signature)'), 'hello 缺少签名');
  assert.ok(build.includes("webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }"), 'hello 未用私钥签名');
  const incoming = slice(NET, 'function handleIncoming(conn) {', 'async function handleData(remoteId, data) {');
  assert.ok(incoming.includes('sendHello(conn)'), '入站连接未回发 hello');
  const connect = slice(NET, 'function connectTo(id) {', 'function reconnectAll() {');
  assert.ok(connect.includes('sendHello(conn)'), '主动连接未发 hello');
});

test('identity: 校验失败会断开连接，ID/公钥不匹配或签名无效都拒绝', () => {
  const verify = slice(NET, 'async function verifyHello(remoteId, data) {', '// ── 状态操作');
  assert.ok(verify.includes("reason: 'id-mismatch'"));
  assert.ok(verify.includes("reason: 'bad-signature'"));
  assert.ok(verify.includes('remoteId !== PEER_ID_PREFIX + fingerprint'));
  assert.ok(verify.includes("webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }"));
  const handler = slice(NET, 'async function handleData(remoteId, data) {', 'function connectTo(id) {');
  assert.ok(handler.includes('if (!verified.ok)'), '验签失败未处理');
  assert.ok(handler.includes('conn.close()'), '验签失败未断开连接');
  assert.ok(handler.includes('patch.pubKey = verified.pubKey'));
  assert.ok(handler.includes('verified: !!verified.verified'));
  assert.ok(!handler.includes('patch.alias'), 'hello 不应写本地备注 alias');
});

// ── 好友备注名 ──────────────────────────────────────────────────────────────

test('identity: 备注名优先级 alias > name > Peer ID 前缀', () => {
  const display = slice(CLIENT, 'function displayName(friend) {', 'function clampMenuPosition(');
  assert.ok(display.includes('friend.alias || friend.name || shortId(friend.id)'));
});

test('identity: 备注入口把 alias 写进 Host 并持久化', () => {
  const setter = slice(CLIENT, 'async setFriendProfile(id, aliasRaw, noteRaw) {', 'async retryPeer() {');
  assert.ok(setter.includes('patch.alias = alias'));
  assert.ok(setter.includes("this.postAction('patchFriend'"), '备注未写给 Host');
  const hostPatch = slice(NET, 'patchFriend(id, patch) {', 'patchSettings(patch) {');
  assert.ok(hostPatch.includes('friend.alias'));
});

// ── 密钥身份：Host 本地文件 ─────────────────────────────────────────────────

test('identity: 私钥/Peer ID 在 Host 侧，落在 0600 本地文件（不是 localStorage）', () => {
  assert.ok(NET.includes("const identityPath = join(dataDir, 'identity.json')"));
  assert.ok(NET.includes("const statePath = join(dataDir, 'state.json')"));
  assert.ok(NET.includes('writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })'), '写入未用 0600');
  assert.ok(NET.includes('chmodSync(path, 0o600)'), '缺少 0600 兜底');
  assert.ok(NET.includes('peerId: PEER_ID_PREFIX + fingerprint'));
  assert.ok(NET.includes('const IDENTITY_FP_HEX_LEN = 40'));
  assert.ok(NET.includes("const publicKeyCanonical = (pub) => 'EC|P-256|' + pub.x + '|' + pub.y;"));
  assert.ok(NET.includes('JSON.stringify({ v: HELLO_VERSION, id: peerId, fp: fingerprint, name })'));
  const snap = slice(NET, 'snapshot() {', 'send(id, text) {');
  assert.ok(!snap.includes('privateJwk'), '快照泄露私钥');
  // 浏览器端不再生成/使用密钥（唯一例外：一次性读取旧 localStorage 交给 Host 迁移）
  assert.ok(!CLIENT.includes('crypto.subtle'), '浏览器仍在做密钥运算');
  assert.ok(!CLIENT.includes('async function generateIdentity'), '浏览器仍在生成密钥');
  assert.ok(!CLIENT.includes("const IDENTITY_KEY = 'dsh-peer-message-identity-v1'"), '浏览器仍在存身份');
});

test('identity: 浏览器只轮询 Host 快照并 POST 操作（视图层）', () => {
  assert.ok(CLIENT.includes("const API_STATE = '/api/pm-net/state'"));
  assert.ok(CLIENT.includes("const API_ACTION = '/api/pm-net/action'"));
  assert.ok(CLIENT.includes('async postAction(action, payload)'));
  assert.ok(CLIENT.includes('async pollHost()'));
  assert.ok(CLIENT.includes('this.pollTimer = setInterval(() => this.pollHost(), 1000)'));
  // 连接在独立 daemon 进程：关标签页、重启 DSH 都不掉线
  assert.ok(HOST.includes("new URL('./server/daemon.mjs', import.meta.url)"), 'Host 未指向 daemon 入口');
  assert.ok(HOST.includes("socketPath: sockPath()"), 'Host 未通过 unix socket 访问 daemon');
  assert.ok(HOST.includes('spawnDaemon'), '缺少 daemon 按需启动');
  const DAEMON = readFileSync(new URL('../server/daemon.mjs', import.meta.url), 'utf8');
  assert.ok(DAEMON.includes('createNetwork({'), 'daemon 未创建传输');
  assert.ok(DAEMON.includes("server.listen(sockPath"), 'daemon 未监听 unix socket');
  assert.ok(DAEMON.includes("chmodSync(sockPath, 0o600)"), 'socket 权限不是 0600');
  assert.ok(HOST.includes("path: '/api/pm-net/state'"));
  assert.ok(HOST.includes("path: '/api/pm-net/action'"));
  assert.ok(!CLIENT.includes('new window.Peer'), '浏览器仍在自建 PeerJS 连接');
  assert.ok(!CLIENT.includes('BroadcastChannel'), '单连接协调已由 Host 承担，不应保留标签页选主');
});

test('identity: 身份文件首次生成后稳定，重启不变 Peer ID', () => {
  assert.ok(NET.includes('async function loadOrCreateIdentity()'));
  assert.ok(NET.includes('if (existsSync(identityPath))'), '未优先复用已有身份文件');
  assert.ok(NET.includes("logger.warn('[peer-message] identity file malformed; regenerating')"));
});

test('identity: unavailable-id 提示说明 Host 侧单持有，不再随机换 ID', () => {
  const err = slice(NET, "peer.on('error', (error) => {", "peer.on('close'");
  assert.ok(err.includes("type === 'unavailable-id'"));
  assert.ok(err.includes('Peer ID 被占用'));
  assert.ok(err.includes('后台连接只应由一个 DSH 持有'), '未解释 Host 单持有');
  assert.ok(!err.includes('随机'), '占用修复不应引入随机 Peer ID');
  assert.ok(CLIENT.includes("onClick: () => pmService.retryPeer() }, '重试连接'"));
  assert.ok(CLIENT.includes("onClick: () => setShowIdentity(true) }, '身份密钥'"));
  assert.ok(!CLIENT.includes('重置 Peer ID'), '仍存在随机重置入口');
});

test('identity: 重试连接沿用同一身份/同一 Peer ID', () => {
  const retry = slice(NET, 'retryPeer() {', 'deliverReply(to, replyText, meta) {');
  assert.ok(retry.includes('net.identity.peerId') || retry.includes('net.myId'));
  assert.ok(retry.includes('initPeer()'));
  assert.ok(retry.includes("net.peerError = ''"));
});

test('identity: 轮换身份=Host 重新生成密钥并重连，UI 有明确二次入口', () => {
  const rotate = slice(NET, 'async rotateIdentity() {', 'async migrateFromBrowser(input) {');
  assert.ok(rotate.includes("webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }"));
  assert.ok(rotate.includes('atomicWriteJson(identityPath, identity)'), '新密钥未落盘');
  assert.ok(rotate.includes('initPeer()'), '轮换后未重连');
  assert.ok(rotate.includes('friends must re-add'));
  assert.ok(CLIENT.includes('async regenerateIdentity()'));
  assert.ok(CLIENT.includes("'已轮换身份密钥，新 Peer ID：'"));
  assert.ok(CLIENT.includes("title: '身份密钥：查看公钥指纹 / 更换密钥身份'"));
  assert.ok(CLIENT.includes('公钥指纹（用于核对身份）'));
  assert.ok(CLIENT.includes('轮换身份密钥（会更换身份与 Peer ID）'));
});

test('identity: 旧 localStorage 数据一次性迁移进 Host 文件，不覆盖已有身份', () => {
  assert.ok(CLIENT.includes('async migrateLegacyStorage()'));
  assert.ok(CLIENT.includes("const LEGACY_STATE_KEY = 'dsh-peer-message-state-v1'"));
  assert.ok(CLIENT.includes("const LEGACY_MIGRATED_KEY = 'dsh-peer-message-host-migrated-v1'"));
  assert.ok(CLIENT.includes('localStorage.removeItem(LEGACY_IDENTITY_KEY)'), '迁移后未清理旧私钥');
  assert.ok(NET.includes('async migrateFromBrowser(input)'));
  assert.ok(NET.includes('net.identityAutoGenerated'), '缺少「不覆盖已有 Host 身份」的判断');
  assert.ok(NET.includes('!net.stateFileExisted'), '缺少「不覆盖已有 state 文件」的判断');
  assert.ok(HOST.includes("path: '/api/pm-net/migrate'"));
});

test('identity: 身份在侧栏/图标/聊天头/二维码里持续表达（不只是弹窗）', () => {
  assert.ok(CLIENT.includes('const pmIdentityStore = {'));
  assert.ok(CLIENT.includes("className: 'pm-identity-row'"));
  assert.ok(CLIENT.includes("'身份已启用 · 指纹 ' + shortFingerprint(identityFingerprint)"));
  assert.ok(CLIENT.includes('pmIdentityStore.subscribe(setIdentity)'));
  assert.ok(CLIENT.includes("title: '密钥身份已启用 · 指纹 ' + identity.fingerprint"));
  assert.ok(CLIENT.includes("className: 'pm-modal-fp'"));
  assert.ok(CLIENT.includes('function shortFingerprint(fingerprint)'));
  // 指纹来自 Host 快照，浏览器自己算不出来
  assert.ok(CLIENT.includes("this.identity = { secured: !!snap.secured, fingerprint: snap.fingerprint || '', peerId: snap.myId || '' }"));
});

test('identity: 连接状态由 Host 持有并广播给所有标签页', () => {
  assert.ok(CLIENT.includes("role: 'host'"));
  assert.ok(CLIENT.includes('🔗 连接由 DSH Host 持有 · 关标签页不掉线'));
  assert.ok(CLIENT.includes('async pollHost()'));
});
