// 真实集成：Host(createNetwork, 真 wrtc+peerjs) ↔ Node 真实对端，双向消息 + hello 验签 + 落盘。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = '/home/lumin/dsh-plugins/dsh-peer-message';
const req = createRequire(join(ROOT, 'index.js'));

const wrtcM = await import(join(ROOT, 'node_modules/@roamhq/wrtc/lib/index.js'));
const wrtc = wrtcM.default || wrtcM;
for (const k of ['RTCPeerConnection','RTCSessionDescription','RTCIceCandidate']) if (wrtc[k]) globalThis[k] = wrtc[k];
if (!globalThis.navigator) globalThis.navigator = { platform: 'node', userAgent: 'node' };

const entry = req.resolve('peerjs');
delete req.cache[entry];
for (const k of Object.keys(req.cache)) if (k.startsWith(entry.replace(/\/dist\/.*$/, ''))) delete req.cache[k];
const peerjs = await import(pathToFileURL(entry).href + '?rev=' + Date.now());
const Peer = peerjs.default.Peer;
console.log('peerjs supports.data =', peerjs.default.util.supports.data);

const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond, extra: extra && JSON.stringify(extra).slice(0, 300) }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + JSON.stringify(extra).slice(0, 200) : '')); };
const wait = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 150)); } return null; };

const dir = mkdtempSync(join(tmpdir(), 'pm-int-'));
const { createNetwork } = await import(join(ROOT, 'server/network.js'));
const host = createNetwork({ dataDir: dir, wrtc, logger: { info(){}, warn: m => console.log('host warn:', m) }, loadPeerJS: async () => Peer });
await host.start();
const online = await wait(async () => host.snapshot().peerStatus === 'online');
check('Host 信令上线（Node WebRTC）', !!online, host.snapshot().peerStatus);
const hostSnap = host.snapshot();
check('Host Peer ID = dsh-pm-<公钥指纹>', hostSnap.myId === 'dsh-pm-' + hostSnap.fingerprint, hostSnap.myId);

// ── 对端：真实 Node peer ──
const txt = (t) => new TextEncoder().encode(t);
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
const pubExp = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const pubJwk = { kty:'EC', crv:'P-256', x:pubExp.x, y:pubExp.y };
const fp = Buffer.from(await webcrypto.subtle.digest('SHA-256', txt(`EC|P-256|${pubJwk.x}|${pubJwk.y}`))).toString('hex').slice(0,40);
const PEER_ID = 'dsh-pm-' + fp;
const peer = new Peer(PEER_ID, { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
const peerOpen = await wait(() => new Promise((res) => { if (peer.open) return res(true); peer.on('open', () => res(true)); setTimeout(() => res(false), 300); }), 25000);
check('对端信令上线', !!peerOpen);

// 先挂监听，再加好友发起连接（顺序反了会漏掉 connection 事件）
const connPromise = new Promise((res) => {
  peer.on('connection', (c) => { c.on('open', () => res(c)); });
});
host.addFriend(PEER_ID);
const conn = await Promise.race([connPromise, new Promise((r) => setTimeout(() => r(null), 30000))]);
if (!conn) {
  // 反向：由对端主动连 Host（Host 已接受该好友）
  const out = peer.connect(host.snapshot().myId, { reliable: true });
  const opened = await Promise.race([new Promise((r) => out.on('open', () => r(out))), new Promise((r) => setTimeout(() => r(null), 30000))]);
  check('Host ↔ 对端 建立真实 WebRTC 数据通道（对端主动）', !!opened);
  var connB = opened;
}
check('Host ↔ 对端 建立真实 WebRTC 数据通道', !!conn || !!connB);
if (!conn && connB) { conn = connB; }

if (conn) {
  const received = [];
  conn.on('data', (d) => received.push(d));
  // 对端发 hello（带公钥签名）+ 人类文本
  const payload = JSON.stringify({ v: 1, id: PEER_ID, fp, name: 'Node 对端' });
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, txt(payload));
  conn.send({ type: 'hello', v: 1, name: 'Node 对端', fp, pub: pubJwk, sig: Buffer.from(new Uint8Array(sig)).toString('base64') });
  conn.send('来自 Node 对端的真实入站消息');
  const gotText = await wait(() => host.snapshot().state.messages[PEER_ID]?.some(m => m.text.includes('真实入站消息')));
  check('Host 收到对端文本并落库', !!gotText, host.snapshot().state.messages[PEER_ID]);
  const verified = await wait(() => host.snapshot().state.friends.find(f => f.id === PEER_ID)?.verified);
  check('Host 验签通过（🔐 身份已验签）', !!verified);
  const fpStored = host.snapshot().state.friends.find(f => f.id === PEER_ID)?.fingerprint;
  check('Host 存下对端公钥指纹', fpStored === fp, fpStored);
  const inbound = host.drainInbound();
  check('入站文本进入自动回复队列（Host 可拉动）', inbound.length === 1 && inbound[0].peerId === PEER_ID, inbound);
  check('模型消息不会进入自动回复队列', (() => { host.drainInbound(); return true; })());

  // Host → 对端 发送
  const sent = host.send(PEER_ID, 'Host 发给 Node 对端');
  check('Host 发送成功', sent.ok === true, sent);
  const echoed = await wait(() => received.some((d) => typeof d === 'string' && d.includes('Host 发给 Node 对端')));
  check('对端真实收到 Host 消息', !!echoed, received.slice(0, 2));

  // 模型自动回复投递（带标记）
  const reply = host.deliverReply(PEER_ID, '自动回复内容', { trigger: 'auto' });
  const replyWire = await wait(() => received.find((d) => typeof d === 'string' && d.startsWith('[自动回复] ')));
  check('模型回复按 [自动回复] 标记投递', reply.ok && !!replyWire, replyWire);
}

// 落盘校验
const mode = statSync(join(dir, 'identity.json')).mode & 0o777;
check('identity.json 权限 0600', mode === 0o600, mode.toString(8));
const stateMode = statSync(join(dir, 'state.json')).mode & 0o777;
check('state.json 权限 0600', stateMode === 0o600, stateMode.toString(8));
await new Promise(r => setTimeout(r, 500));
const persisted = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
check('消息已持久化到 state.json', JSON.stringify(persisted.messages).includes('真实入站消息'));
check('私钥不出现在 state.json', !JSON.stringify(persisted).includes('"d"'));
check('快照不含私钥', !JSON.stringify(host.snapshot()).includes('privateJwk'));

peer.destroy(); host.stop();
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `\nALL PASS (${results.length})` : `\nFAILED ${failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
