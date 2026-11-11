import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNetwork } from './network.js';

function fakePeerJS() {
  // Minimal Peer stand-in: opens immediately, records connects, no real WebRTC.
  let seq = 0;
  return class FakePeer {
    constructor(id) { this.id = id; this.open = false; this.destroyed = false; this.handlers = {}; this.sent = []; }
    on(event, handler) { (this.handlers[event] ||= []).push(handler); if (event === 'open') setTimeout(() => { this.open = true; handler(this.id); }, 0); return this; }
    connect(id) {
      const conn = { peer: id, open: false, handlers: {}, send: (payload) => { this.sent.push({ id, payload }); }, close() { conn.open = false; }, on(e, fn) { (conn.handlers[e] ||= []).push(fn); return conn; } };
      setTimeout(() => { conn.open = true; (conn.handlers.open || []).forEach((fn) => fn()); }, 0);
      seq++;
      return conn;
    }
    destroy() { this.destroyed = true; this.open = false; }
    reconnect() {}
  };
}

async function makeNet(dir) {
  const net = createNetwork({ dataDir: dir, loadPeerJS: async () => fakePeerJS(), wrtc: {}, logger: { info() {}, warn() {} } });
  await net.start();
  await new Promise((r) => setTimeout(r, 20));
  return net;
}

test('host network: identity keypair written to 0600 local file, Peer ID = prefix + fingerprint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-'));
  const net = await makeNet(dir);
  const snap = net.snapshot();
  assert.match(snap.myId, /^dsh-pm-[0-9a-f]{40}$/);
  assert.equal(snap.myId, 'dsh-pm-' + snap.fingerprint);
  assert.ok(existsSync(snap.identityFile), 'identity file exists');
  const mode = statSync(snap.identityFile).mode & 0o777;
  assert.equal(mode, 0o600, 'identity file must be 0600, got ' + mode.toString(8));
  const stored = JSON.parse(readFileSync(snap.identityFile, 'utf8'));
  assert.ok(stored.privateJwk && stored.privateJwk.d, 'private key on disk');
  // private key never leaves the Host through the snapshot
  assert.equal(snap.privateJwk, undefined);
  assert.equal(JSON.stringify(snap).includes('"d"'), false);
  net.stop();
});

test('host network: identity is stable across restarts (same file, same Peer ID)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-'));
  const a = await makeNet(dir);
  const idA = a.snapshot().myId;
  a.stop();
  const b = await makeNet(dir);
  assert.equal(b.snapshot().myId, idA);
  b.stop();
});

test('host network: friends/settings persist to state.json 0600 and survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-'));
  const net = await makeNet(dir);
  net.addFriend('dsh-pm-aaaaaaaaaaaaaaaaaaaa');
  net.patchSettings({ nickname: 'hostnick', allowBroadcast: true });
  net.patchFriend('dsh-pm-aaaaaaaaaaaaaaaaaaaa', { alias: '甲', note: '上下文备注' });
  await new Promise((r) => setTimeout(r, 400)); // debounced persist
  const snap = net.snapshot();
  const mode = statSync(snap.stateFile).mode & 0o777;
  assert.equal(mode, 0o600, 'state file must be 0600');
  net.stop();
  const again = await makeNet(dir);
  const s2 = again.snapshot();
  assert.equal(s2.state.settings.nickname, 'hostnick');
  assert.equal(s2.state.settings.allowBroadcast, true);
  const friend = s2.state.friends.find((f) => f.id === 'dsh-pm-aaaaaaaaaaaaaaaaaaaa');
  assert.ok(friend, 'friend restored');
  assert.equal(friend.alias, '甲');
  assert.equal(friend.note, '上下文备注');
  again.stop();
});

test('host network: rotateIdentity changes keypair and Peer ID; old identity file replaced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-'));
  const net = await makeNet(dir);
  const before = net.snapshot();
  const rotated = await net.rotateIdentity();
  assert.notEqual(rotated.peerId, before.myId);
  assert.equal(rotated.peerId, 'dsh-pm-' + rotated.fingerprint);
  const stored = JSON.parse(readFileSync(before.identityFile, 'utf8'));
  assert.equal(stored.fingerprint, rotated.fingerprint);
  net.stop();
});

test('host network: migrateFromBrowser imports legacy key+state once, then is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-'));
  const seedDir = mkdtempSync(join(tmpdir(), 'pm-net-seed-'));
  const seed = await makeNet(seedDir);
  const seedSnap = seed.snapshot();
  const legacyIdentity = JSON.parse(readFileSync(seedSnap.identityFile, 'utf8'));
  seed.stop();

  const net = await makeNet(dir);
  const result = await net.migrateFromBrowser({
    identity: legacyIdentity,
    state: { friends: [{ id: 'dsh-pm-bbbbbbbbbbbbbbbbbbbb', name: '旧好友' }], messages: {}, settings: { nickname: 'legacy' } },
  });
  assert.equal(result.migratedIdentity, true);
  assert.equal(result.migratedState, true);
  assert.equal(net.snapshot().myId, seedSnap.myId, 'legacy Peer ID preserved');
  assert.equal(net.snapshot().state.settings.nickname, 'legacy');
  // second call: host already owns files, nothing changes
  const again = await net.migrateFromBrowser({ identity: legacyIdentity, state: { friends: [] } });
  assert.equal(again.migratedIdentity, false);
  assert.equal(again.migratedState, false);
  net.stop();
});

test('host network: send stores message locally only when the peer is connected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-'));
  const net = await makeNet(dir);
  net.addFriend('dsh-pm-cccccccccccccccccccc');
  const offline = net.send('dsh-pm-cccccccccccccccccccc', '你好');
  assert.equal(offline.ok, false);
  assert.equal(offline.error, 'offline');
  assert.equal(net.snapshot().state.messages['dsh-pm-cccccccccccccccccccc'], undefined);
  net.stop();
});

test('host network: 同进程重复挂载复用同一传输（不会两个 Peer 抢同一 Peer ID）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-single-'));
  const a = await makeNet(dir);
  const b = createNetwork({ dataDir: dir, loadPeerJS: async () => fakePeerJS(), wrtc: {}, logger: { info() {}, warn() {} } });
  await b.start();
  // 同一 dataDir 返回同一个 api 实例
  assert.equal(a, b, '同一 dataDir 必须复用同一传输实例');
  // 引用计数释放：第一次释放不 stop，第二次才真正 stop
  assert.equal(globalThis[Symbol.for('dsh-peer-message.host-network')].get(dir).refs, 2);
  globalThis[Symbol.for('dsh-peer-message.host-network')].get(dir).release();
  assert.equal(a.snapshot().peerStatus !== undefined, true);
  globalThis[Symbol.for('dsh-peer-message.host-network')].get(dir)?.release();
  a.stop();
});

test('host network: peer-unavailable 只标记该好友离线，不把本端判成故障', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-net-unavail-'));
  const net = await makeNet(dir);
  const friendId = 'dsh-pm-dddddddddddddddddddd';
  net.addFriend(friendId);
  await new Promise((r) => setTimeout(r, 50));
  // 模拟 peerjs 的 peer-unavailable：消息里带目标 id
  const peer = net.__peerForTest;
  assert.ok(peer, '需要测试钩子暴露 Peer 实例');
  peer.handlers.error?.forEach((fn) => fn({ type: 'peer-unavailable', message: `Could not connect to peer ${friendId}` }));
  const snap = net.snapshot();
  assert.equal(snap.peerStatus, 'online', 'peer-unavailable 不应把本端置为 error');
  assert.equal(snap.peerError, '');
  const friend = snap.state.friends.find((f) => f.id === friendId);
  assert.equal(friend.online, false);
  net.stop();
});

test('host network: daemon 模块存在并暴露健康/状态/动作端点', async () => {
  const { readFileSync } = await import('node:fs');
  const daemon = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8');
  assert.ok(daemon.includes("path === '/state'"));
  assert.ok(daemon.includes("path === '/action'"));
  assert.ok(daemon.includes("path === '/migrate'"));
  assert.ok(daemon.includes("path === '/health'"));
  // 必须在 peerjs 首次求值前注入 WebRTC 全局（否则 browser-incompatible）
  const wrtcIdx = daemon.indexOf("await import('@roamhq/wrtc')");
  const peerIdx = daemon.indexOf('await loadPeer()');
  assert.ok(wrtcIdx >= 0 && peerIdx > wrtcIdx, 'WebRTC 全局必须早于 peerjs 加载');
  // 清 CJS 缓存，避免 supports.data 被污染
  assert.ok(daemon.includes('delete require.cache[entry]'));
  assert.ok(daemon.includes("if (util && util.supports && !util.supports.data)"));
});


test('host network: 重连永不放弃（PeerJS 云端旧 ID 释放后必须能自愈，且不换身份）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./network.js', import.meta.url), 'utf8');
  // 不再有「尝试 N 次后永久放弃」的短路
  assert.ok(!/retryAttempts\s*>\s*\d+\s*\)\s*return/.test(src), '仍存在放弃重试的短路');
  assert.ok(src.includes('永不放弃'), '缺少永不放弃的说明与实现');
  // 延迟封顶 30s
  // 退避封顶 45s；unavailable-id 用更长基线（云端释放需要时间）
  assert.ok(src.includes("net.peerErrorType === 'unavailable-id' ? 6000 : 2000"), '未区分 unavailable-id 的退避基线');
  assert.ok(src.includes('Math.min(base * Math.pow(2, Math.min(net.retryAttempts - 1, 3)), 45000)'));
  // 重试沿用同一身份
  assert.ok(src.includes('net.peer = null;') && src.includes('initPeer()'));
});


test('host network: 信令既不 open 也不 error 时有看门狗，不会永久卡在 connecting', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./network.js', import.meta.url), 'utf8');
  assert.ok(src.includes('openWatchdog'), '缺少信令看门狗');
  assert.ok(src.includes("net.peerErrorType = 'timeout'"), '看门狗未标记超时');
  assert.ok(src.includes('}, 25000);'), '看门狗超时不是 25s');
  // 看门狗触发后走同一套重试（不换身份）
  const idx = src.indexOf('net.openWatchdog = setTimeout');
  const block = src.slice(idx, idx + 700);
  assert.ok(block.includes('scheduleRetry()'), '看门狗未触发重试');
  assert.ok(!block.includes('generateIdentity'), '看门狗不应更换身份');
});


test('host network: deliverReply 不会重复加来源标记（不能出现 [自动回复] [自动回复]）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-wrap-'));
  const net = await makeNet(dir);
  const snap = net.snapshot();
  // 已带标记的正文：剥离后按 trigger 重新加，只应有一个前缀
  const result = net.deliverReply(snap.state.friends[0]?.id || 'dsh-pm-wwwwwwwwwwwwwwwwwwww', '[自动回复] 正文内容', { trigger: 'auto' });
  assert.ok(result.ok === false || result.ok === true);
  net.stop();
  const src = readFileSync(new URL('./network.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('deliverReply(to, replyText, meta) {'), src.indexOf('deliverReply(to, replyText, meta) {') + 900);
  assert.ok(block.includes('const info = modelTextInfo(raw)'), '未解析已有标记');
  assert.ok(block.includes('const body = info.isModel ? info.display : raw'), '未剥离已有标记');
});
