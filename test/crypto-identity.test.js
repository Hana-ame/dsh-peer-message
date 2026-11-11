import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 本地密钥身份的核心算法在浏览器里用 WebCrypto；这里用 Node 的 webcrypto 复刻，
// 校验「Peer ID = 前缀 + 公钥指纹」以及 hello 签名/验签语义与 client.js 一致。
const crypto = webcrypto;
const PEER_ID_PREFIX = 'dsh-pm-';
const IDENTITY_FP_HEX_LEN = 40;
const HELLO_VERSION = 1;
const encoder = new TextEncoder();

const bytesToBase64 = (bytes) => Buffer.from(new Uint8Array(bytes)).toString('base64');
const base64ToBytes = (text) => new Uint8Array(Buffer.from(text, 'base64'));
function utf8Bytes(text) { return encoder.encode(text); }
async function sha256Hex(input) {
  const data = typeof input === 'string' ? utf8Bytes(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const publicKeyCanonical = (pub) => 'EC|P-256|' + pub.x + '|' + pub.y;
const helloSignPayload = (peerId, name, fingerprint) => JSON.stringify({ v: HELLO_VERSION, id: peerId, fp: fingerprint, name });
const isValidPublicKey = (pub) => !!pub && typeof pub === 'object' && pub.kty === 'EC' && pub.crv === 'P-256'
  && typeof pub.x === 'string' && pub.x.length > 8 && pub.x.length <= 200
  && typeof pub.y === 'string' && pub.y.length > 8 && pub.y.length <= 200
  && Object.keys(pub).every((k) => k === 'kty' || k === 'crv' || k === 'x' || k === 'y');
const fingerprintOfPublicKey = async (pub) => (await sha256Hex(publicKeyCanonical(pub))).slice(0, IDENTITY_FP_HEX_LEN);

async function makeIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const pubJwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
  const fingerprint = await fingerprintOfPublicKey(pubJwk);
  return { privateJwk, privateKey: pair.privateKey, pubJwk, fingerprint, peerId: PEER_ID_PREFIX + fingerprint };
}
async function buildHello(identity, name) {
  const payload = helloSignPayload(identity.peerId, name, identity.fingerprint);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, utf8Bytes(payload));
  return { type: 'hello', v: HELLO_VERSION, name, fp: identity.fingerprint, pub: identity.pubJwk, sig: bytesToBase64(signature) };
}
async function verifyHello(remoteId, data) {
  if (!data) return { ok: false, reason: 'bad-hello' };
  const hasProof = data.fp !== undefined || data.pub !== undefined || data.sig !== undefined;
  if (!hasProof) return { ok: true, verified: false, reason: 'legacy' };
  if (!isValidPublicKey(data.pub)) return { ok: false, reason: 'bad-pub' };
  if (typeof data.fp !== 'string' || typeof data.sig !== 'string' || !data.sig || data.sig.length > 200) return { ok: false, reason: 'bad-hello' };
  if (typeof data.name !== 'string' || data.name.length > 32) return { ok: false, reason: 'bad-name' };
  const fingerprint = await fingerprintOfPublicKey(data.pub);
  if (data.fp !== fingerprint || remoteId !== PEER_ID_PREFIX + fingerprint) return { ok: false, reason: 'id-mismatch' };
  const verifier = await crypto.subtle.importKey('jwk', data.pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, base64ToBytes(data.sig), utf8Bytes(helloSignPayload(remoteId, data.name, fingerprint)));
  return ok ? { ok: true, verified: true, fingerprint } : { ok: false, reason: 'bad-signature' };
}

test('crypto-identity: Peer ID 由公钥指纹派生（40 hex，合法长度/字符集）', async () => {
  const identity = await makeIdentity();
  assert.match(identity.peerId, /^dsh-pm-[0-9a-f]{40}$/);
  assert.ok(identity.peerId.length >= 16 && identity.peerId.length <= 64);
  assert.equal(identity.peerId, PEER_ID_PREFIX + identity.fingerprint);
  // 同一私钥重复导出/计算：指纹稳定
  const again = await fingerprintOfPublicKey(identity.pubJwk);
  assert.equal(again, identity.fingerprint);
  // 不同密钥 → 不同身份
  const other = await makeIdentity();
  assert.notEqual(other.peerId, identity.peerId);
});

test('crypto-identity: hello 签名可被对方用公钥验证', async () => {
  const identity = await makeIdentity();
  const hello = await buildHello(identity, '小王');
  assert.deepEqual(Object.keys(hello.pub).sort(), ['crv', 'kty', 'x', 'y']);
  const result = await verifyHello(identity.peerId, hello);
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.fingerprint, identity.fingerprint);
});

test('crypto-identity: 篡改名字/ID/签名会被拒绝', async () => {
  const identity = await makeIdentity();
  const hello = await buildHello(identity, '小王');
  assert.equal((await verifyHello(identity.peerId, { ...hello, name: '冒充者' })).reason, 'bad-signature');
  const other = await makeIdentity();
  assert.equal((await verifyHello(other.peerId, hello)).reason, 'id-mismatch');
  assert.equal((await verifyHello(identity.peerId, { ...hello, fp: '0'.repeat(40) })).reason, 'id-mismatch');
  assert.equal((await verifyHello(identity.peerId, { ...hello, sig: hello.sig.slice(0, -4) + 'AAAA' })).reason, 'bad-signature');
});

test('crypto-identity: 旧版无公钥 hello 兼容但标记未验签', async () => {
  const result = await verifyHello('dsh-pm-legacyfriend-abc123', { type: 'hello', name: '老客户端' });
  assert.deepEqual(result, { ok: true, verified: false, reason: 'legacy' });
});

test('crypto-identity: Host 侧使用同一 payload/指纹约定，且不再生成随机身份 ID', () => {
  // 身份算法现在在 Host 进程（server/network.js）里跑，文件是 0600；
  // 浏览器只读快照。两边必须沿用同一 canonical payload/指纹约定。
  const src = readFileSync(new URL('../server/network.js', import.meta.url), 'utf8');
  assert.ok(src.includes("const IDENTITY_FP_HEX_LEN = 40"));
  assert.ok(src.includes("const publicKeyCanonical = (pub) => 'EC|P-256|' + pub.x + '|' + pub.y;"));
  assert.ok(src.includes('JSON.stringify({ v: HELLO_VERSION, id: peerId, fp: fingerprint, name })'));
  assert.ok(src.includes('peerId: PEER_ID_PREFIX + fingerprint'));
  assert.ok(!src.includes('getStablePeerId()'), '仍存在随机稳定 ID 入口');
  assert.ok(!src.includes('randomPeerIdFallback'), '仍存在随机 Peer ID 兜底');
  // 私钥只允许落在 Host 本地文件，不允许回到浏览器 localStorage
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(!client.includes('crypto.subtle'), '浏览器不应再做密钥运算');
  assert.ok(!client.includes("localStorage.setItem('dsh-peer-message-identity-v1'"), '浏览器不应存私钥');
});
