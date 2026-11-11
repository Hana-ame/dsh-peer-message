/**
 * Host-side P2P transport (Node WebRTC).
 *
 * The browser must not own the messaging identity or the WebRTC connection:
 * - the ECDSA P-256 identity keypair is kept in a local file (mode 0600);
 * - friends / messages / settings are persisted to a local JSON file;
 * - the PeerJS connection runs in the Host process through `@roamhq/wrtc`, so a
 *   closed tab no longer takes the peer offline and two tabs can never race for
 *   the same Peer ID.
 *
 * The browser half is a pure view: it polls `/api/pm-net/state` and posts
 * actions. All validation (peer IDs, text caps, allowBroadcast/allowIncoming
 * gates, hello signature verification) happens here, not in the page.
 */

import { webcrypto, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PEER_ID_PREFIX = 'dsh-pm-';
const IDENTITY_FP_HEX_LEN = 40;
const HELLO_VERSION = 1;
const MAX_NAME_LEN = 32;
const MAX_TEXT_LEN = 4096;
const MAX_NOTE_LEN = 500;
const MAX_MSGS_PER_FRIEND = 500;
const MAX_FRIENDS = 100;
const MAX_REPLY_OUTPUT = 2000;
const AUTO_REPLY_PREFIX = '[自动回复] ';
const AI_AGENT_PREFIX = '[AI] ';
const MANUAL_APPROVAL_MARKER = '[人工批准] ';
const PUB_KEY_MAX_LEN = 200;
const HELLO_SIG_MAX_LEN = 200;
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];

const DEFAULT_SETTINGS = { allowBroadcast: false, allowIncoming: true, nickname: '' };
const DEFAULT_REPLY = {
  mode: 'off', permission: 'read', provider: '', model: '', reasoningEffort: '',
  sessionMode: 'dedicated', sessionId: '', cwd: '',
};

const utf8 = (text) => new TextEncoder().encode(text);
const b64 = (bytes) => Buffer.from(new Uint8Array(bytes)).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

function sanitizeText(text, max = MAX_TEXT_LEN) {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}
function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  return clean || null;
}
function sanitizeNote(note) {
  return sanitizeText(typeof note === 'string' ? note : '', MAX_NOTE_LEN).trim();
}
function isValidPeerId(id) {
  if (typeof id !== 'string') return false;
  if (!id.startsWith(PEER_ID_PREFIX)) return false;
  if (id.length < 16 || id.length > 64) return false;
  return /^[a-z0-9-]+$/.test(id);
}
function isValidPublicKey(pub) {
  return !!pub && typeof pub === 'object' && pub.kty === 'EC' && pub.crv === 'P-256'
    && typeof pub.x === 'string' && pub.x.length > 8 && pub.x.length <= PUB_KEY_MAX_LEN
    && typeof pub.y === 'string' && pub.y.length > 8 && pub.y.length <= PUB_KEY_MAX_LEN
    && Object.keys(pub).every((k) => k === 'kty' || k === 'crv' || k === 'x' || k === 'y');
}
const publicKeyCanonical = (pub) => 'EC|P-256|' + pub.x + '|' + pub.y;
const helloPayload = (peerId, name, fingerprint) => JSON.stringify({ v: HELLO_VERSION, id: peerId, fp: fingerprint, name });

async function sha256Hex(input) {
  const digest = await webcrypto.subtle.digest('SHA-256', typeof input === 'string' ? utf8(input) : input);
  return Buffer.from(new Uint8Array(digest)).toString('hex');
}
const fingerprintOf = async (pub) => (await sha256Hex(publicKeyCanonical(pub))).slice(0, IDENTITY_FP_HEX_LEN);

function modelTextInfo(text) {
  if (typeof text !== 'string') return { isModel: false, trigger: 'human', display: '' };
  const leading = text.length - text.trimStart().length;
  const body = text.slice(leading);
  if (body.startsWith(AUTO_REPLY_PREFIX)) {
    const rest = body.slice(AUTO_REPLY_PREFIX.length).trim();
    if (rest.startsWith(MANUAL_APPROVAL_MARKER)) {
      return { isModel: true, trigger: 'manual', display: rest.slice(MANUAL_APPROVAL_MARKER.length).trim() };
    }
    return { isModel: true, trigger: 'auto', display: rest };
  }
  if (body.startsWith(AI_AGENT_PREFIX)) return { isModel: true, trigger: 'agent', display: body.slice(AI_AGENT_PREFIX.length).trim() };
  return { isModel: false, trigger: 'human', display: text };
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch (e) { /* best effort */ }
}

/**
 * @param {{
 *   dataDir: string,
 *   loadPeerJS: () => Promise<any>,
 *   wrtc: any,
 *   logger?: {info: Function, warn: Function},
 *   maxReplyMs?: number,
 * }} options
 */
// 进程级单例：同进程里重复挂载插件（HMR/热重载/多个 profile 行）必须复用同一个
// Host 传输，否则两个 Peer 会抢同一个 Peer ID（→ unavailable-id）并把连接搞坏。
// 用 Symbol.for 挂在 globalThis 上，跨模块实例（?rev= 不同）也能看到同一份。
const SINGLETON_ROOT = Symbol.for('dsh-peer-message.host-network');

export function createNetwork(options) {
  const { dataDir, loadPeerJS, wrtc, logger = console } = options;
  // 单例按 dataDir 区分：同一进程 + 同一数据目录 = 同一个传输。
  const registry = globalThis[SINGLETON_ROOT] || (globalThis[SINGLETON_ROOT] = new Map());
  const existing = registry.get(dataDir);
  if (existing && typeof existing.acquire === 'function') {
    existing.acquire();
    return existing.api;
  }
  const identityPath = join(dataDir, 'identity.json');
  const statePath = join(dataDir, 'state.json');
  const files = { identityPath, statePath, dataDir };

  const net = {
    files,
    peer: null,
    myId: '',
    peerStatus: 'connecting',
    peerError: '',
    peerErrorType: '',
    identity: null,
    conns: new Map(),
    state: null,
    version: 0,
    started: false,
    persistTimer: null,
    // 入站人类文本队列：Host 侧拉动触发自动回复（无标签页也生效）。
    inbound: [],
    // unavailable-id 首次出现时间戳：>60s 说明是云端旧登记而非本机多进程。
    sinceUnavailable: 0,
    openWatchdog: null,
    // 文件是否由本次启动新建：只有「自动生成」的身份/状态才允许被旧
    // localStorage 迁移覆盖，已经有真实文件时绝不覆盖。
    identityAutoGenerated: false,
    stateFileExisted: false,
  };

  // ── 本地文件：身份 + 状态 ─────────────────────────────────────────────
  async function loadOrCreateIdentity() {
    if (existsSync(identityPath)) {
      try {
        const stored = JSON.parse(readFileSync(identityPath, 'utf8'));
        if (stored && stored.privateJwk && isValidPublicKey(stored.pubJwk)) {
          const fingerprint = await fingerprintOf(stored.pubJwk);
          const privateKey = await webcrypto.subtle.importKey('jwk', stored.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
          return { secured: true, privateJwk: stored.privateJwk, privateKey, pubJwk: stored.pubJwk, fingerprint, peerId: PEER_ID_PREFIX + fingerprint };
        }
        logger.warn('[peer-message] identity file malformed; regenerating');
      } catch (error) {
        logger.warn(`[peer-message] identity file unreadable: ${String(error && error.message || error)}`);
      }
    }
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
    const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    const pubJwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
    const fingerprint = await fingerprintOf(pubJwk);
    const identity = { v: 1, privateJwk, pubJwk, fingerprint, peerId: PEER_ID_PREFIX + fingerprint, createdAt: Date.now() };
    atomicWriteJson(identityPath, identity);
    net.identityAutoGenerated = true;
    logger.info(`[peer-message] generated local identity file ${identityPath} (mode 0600)`);
    return { secured: true, ...identity, privateKey: pair.privateKey };
  }

  function loadStateFile() {
    const base = { version: 1, friends: [], messages: {}, settings: { ...DEFAULT_SETTINGS, reply: { ...DEFAULT_REPLY } } };
    if (!existsSync(statePath)) return base;
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'));
      const friends = Array.isArray(raw.friends) ? raw.friends.filter((f) => f && isValidPeerId(f.id)).slice(-MAX_FRIENDS) : [];
      const messages = {};
      if (raw.messages && typeof raw.messages === 'object') {
        for (const [id, list] of Object.entries(raw.messages)) {
          if (!isValidPeerId(id) || !Array.isArray(list)) continue;
          messages[id] = list.filter((m) => m && typeof m.text === 'string').slice(-MAX_MSGS_PER_FRIEND);
        }
      }
      const settings = Object.assign({}, base.settings, raw.settings || {});
      settings.reply = Object.assign({}, DEFAULT_REPLY, (raw.settings && raw.settings.reply) || {});
      return { version: 1, friends, messages, settings };
    } catch (error) {
      logger.warn(`[peer-message] state file unreadable, starting empty: ${String(error && error.message || error)}`);
      return base;
    }
  }

  function persistSoon() {
    if (net.persistTimer) return;
    net.persistTimer = setTimeout(() => {
      net.persistTimer = null;
      try { atomicWriteJson(statePath, net.state); } catch (error) {
        logger.warn(`[peer-message] state persist failed: ${String(error && error.message || error)}`);
      }
    }, 150);
  }

  function touch() {
    net.version += 1;
    net.state.version = net.version;
    persistSoon();
  }

  // ── 身份证明 ──────────────────────────────────────────────────────────
  async function buildHello() {
    const name = sanitizeName(net.state.settings.nickname) || net.myId.slice(0, 8);
    const payload = helloPayload(net.myId, name, net.identity.fingerprint);
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, net.identity.privateKey, utf8(payload));
    return { type: 'hello', v: HELLO_VERSION, name, fp: net.identity.fingerprint, pub: net.identity.pubJwk, sig: b64(signature) };
  }

  async function verifyHello(remoteId, data) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'bad-hello' };
    const hasProof = data.fp !== undefined || data.pub !== undefined || data.sig !== undefined;
    if (!hasProof) return { ok: true, verified: false, reason: 'legacy' };
    if (!isValidPublicKey(data.pub)) return { ok: false, reason: 'bad-pub' };
    if (typeof data.fp !== 'string' || typeof data.sig !== 'string' || !data.sig || data.sig.length > HELLO_SIG_MAX_LEN) return { ok: false, reason: 'bad-hello' };
    if (typeof data.name !== 'string' || data.name.length > MAX_NAME_LEN) return { ok: false, reason: 'bad-name' };
    const fingerprint = await fingerprintOf(data.pub);
    if (data.fp !== fingerprint || remoteId !== PEER_ID_PREFIX + fingerprint) return { ok: false, reason: 'id-mismatch' };
    let verifier;
    try {
      verifier = await webcrypto.subtle.importKey('jwk', data.pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch (e) { return { ok: false, reason: 'bad-pub' }; }
    let ok = false;
    try {
      ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, unb64(data.sig), utf8(helloPayload(remoteId, data.name, fingerprint)));
    } catch (e) { ok = false; }
    return ok ? { ok: true, verified: true, fingerprint, pubKey: data.pub, name: data.name } : { ok: false, reason: 'bad-signature' };
  }

  // ── 状态操作（Host 权威） ─────────────────────────────────────────────
  function findFriend(id) { return net.state.friends.find((f) => f.id === id); }

  function upsertFriend(id, patch) {
    let friend = findFriend(id);
    if (!friend) {
      friend = { id, name: id.slice(0, 8), alias: '', note: '', online: false, unread: 0, lastMsg: '', lastTs: Date.now(), verified: false, fingerprint: '' };
      net.state.friends.push(friend);
      if (net.state.friends.length > MAX_FRIENDS) net.state.friends = net.state.friends.slice(-MAX_FRIENDS);
    }
    Object.assign(friend, patch);
    return friend;
  }

  function appendMessage(id, message) {
    const list = (net.state.messages[id] || []).concat([message]).slice(-MAX_MSGS_PER_FRIEND);
    net.state.messages[id] = list;
    return list;
  }

  function pushToPeer(id, payload) {
    const conn = net.conns.get(id);
    if (!conn || !conn.open) return false;
    try { conn.send(payload); return true; } catch (e) { return false; }
  }

  function sendHello(conn) {
    buildHello().then((hello) => { try { if (conn.open) conn.send(hello); } catch (e) { /* ignore */ } }).catch(() => {});
  }

  function handleIncoming(conn) {
    const remoteId = conn.peer;
    if (!isValidPeerId(remoteId)) { try { conn.close(); } catch (e) { /* ignore */ } return; }
    const settings = net.state.settings;
    if (!settings.allowIncoming) { try { conn.close(); } catch (e) { /* ignore */ } return; }
    if (!settings.allowBroadcast && !findFriend(remoteId)) { try { conn.close(); } catch (e) { /* ignore */ } return; }
    conn.on('open', () => {
      net.conns.set(remoteId, conn);
      upsertFriend(remoteId, { online: true });
      touch();
      sendHello(conn);
    });
    conn.on('data', (data) => handleData(remoteId, data));
    conn.on('close', () => {
      net.conns.delete(remoteId);
      const friend = findFriend(remoteId);
      if (friend) { friend.online = false; touch(); }
    });
    conn.on('error', () => {
      net.conns.delete(remoteId);
      const friend = findFriend(remoteId);
      if (friend) { friend.online = false; touch(); }
    });
  }

  async function handleData(remoteId, data) {
    if (typeof data === 'string') {
      const text = sanitizeText(data);
      if (!text) return;
      const info = modelTextInfo(text);
      const display = info.isModel ? info.display : text;
      const origin = info.isModel ? 'model' : 'human';
      const friend = upsertFriend(remoteId, {
        lastMsg: display, lastTs: Date.now(), unread: (findFriend(remoteId)?.unread || 0) + 1, online: true,
        lastOrigin: origin, lastTrigger: info.trigger,
      });
      appendMessage(remoteId, { from: 'them', text: display, ts: Date.now(), origin, trigger: info.trigger });
      if (!info.isModel) {
        net.inbound.push({ peerId: remoteId, text: display, ts: Date.now() });
        if (net.inbound.length > 100) net.inbound = net.inbound.slice(-100);
      }
      touch();
      void friend;
      return;
    }
    if (data && typeof data === 'object' && data.type === 'hello') {
      const verified = await verifyHello(remoteId, data);
      const friend = findFriend(remoteId);
      if (!verified.ok) {
        if (friend) { friend.verified = false; friend.verifyError = verified.reason; friend.online = false; touch(); }
        try { const conn = net.conns.get(remoteId); if (conn) conn.close(); } catch (e) { /* ignore */ }
        net.conns.delete(remoteId);
        return;
      }
      const patch = { verified: !!verified.verified };
      if (verified.fingerprint) { patch.fingerprint = verified.fingerprint; patch.pubKey = verified.pubKey; }
      if (verified.name) patch.name = verified.name;
      upsertFriend(remoteId, patch);
      touch();
    }
  }

  function connectTo(id) {
    if (!net.peer || !net.peer.open || !isValidPeerId(id)) return false;
    if (net.conns.has(id)) return !!net.conns.get(id).open;
    const conn = net.peer.connect(id, { reliable: true });
    net.conns.set(id, conn);
    conn.on('open', () => { upsertFriend(id, { online: true }); touch(); sendHello(conn); });
    conn.on('data', (data) => handleData(id, data));
    conn.on('close', () => { net.conns.delete(id); const f = findFriend(id); if (f) { f.online = false; touch(); } });
    conn.on('error', () => { net.conns.delete(id); const f = findFriend(id); if (f) { f.online = false; touch(); } });
    return true;
  }

  function reconnectAll() {
    for (const friend of net.state.friends) if (!net.conns.has(friend.id)) connectTo(friend.id);
  }

  function scheduleRetry() {
    if (!net.started) return;
    net.retryAttempts = (net.retryAttempts || 0) + 1;
    // 永不放弃：PeerJS 云端的旧 Peer ID 会在服务端超时后释放（强杀进程时尤其如此），
    // 延迟封顶 30s 持续重试同一身份/同一 Peer ID。绝不因此生成新 ID。
    const delay = Math.min(2000 * Math.pow(2, Math.min(net.retryAttempts - 1, 4)), 30000);
    if (net.retryTimer) clearTimeout(net.retryTimer);
    net.retryTimer = setTimeout(() => {
      net.retryTimer = null;
      if (!net.started) return;
      if (net.peer && net.peer.open) { net.retryAttempts = 0; return; }
      if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
      net.peer = null;
      net.peerStatus = 'connecting';
      net.peerError = '';
      net.peerErrorType = '';
      touch();
      initPeer().catch(() => {});
    }, delay);
    net.retryTimer.unref?.();
  }

  async function initPeer() {
    if (!net.started) return;
    const Peer = await loadPeerJS();
    const peer = new Peer(net.myId, { debug: 0, config: { iceServers: STUN } });
    net.peer = peer;
    peer.on('open', (id) => {
      if (net.openWatchdog) { clearTimeout(net.openWatchdog); net.openWatchdog = null; }
      net.myId = id;
      net.peerStatus = 'online';
      net.peerError = '';
      net.peerErrorType = '';
      net.retryAttempts = 0;
      net.sinceUnavailable = 0;
      touch();
      reconnectAll();
    });
    // 信令可能既不 open 也不 error（代理/云端半挂），否则会永久卡在 connecting。
    // 25s 内没 open 就当作失败，走同一套退避重试（仍用同一身份/同一 Peer ID）。
    if (net.openWatchdog) clearTimeout(net.openWatchdog);
    net.openWatchdog = setTimeout(() => {
      net.openWatchdog = null;
      if (!net.started || (net.peer && net.peer.open)) return;
      net.peerStatus = 'error';
      net.peerErrorType = 'timeout';
      net.peerError = '信令连接超时（25s 未建立）：正在用同一身份、同一 Peer ID 重试。';
      touch();
      if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
      net.peer = null;
      scheduleRetry();
    }, 25000);
    net.openWatchdog.unref?.();
    peer.on('connection', handleIncoming);
    peer.on('error', (error) => {
      const type = error && error.type;
      // peer-unavailable 表示「这个好友现在不在线」，不是本端连接故障：
      // 只把该好友标成离线，保持 peerStatus=online，避免整机看起来挂了。
      if (type === 'peer-unavailable') {
        const match = /Could not connect to peer (.+)$/.exec(String(error && error.message || ''));
        const offlineId = match && match[1];
        if (offlineId) {
          const friend = findFriend(offlineId);
          if (friend && friend.online) { friend.online = false; touch(); }
          net.conns.delete(offlineId);
        }
        return;
      }
      net.peerErrorType = type || '';
      if (type === 'unavailable-id') {
        // 区分「本机另一个 daemon 占着」与「云端旧登记尚未释放」：
        // 前者需要用户关掉多余进程；后者只能等 PeerJS 释放，或换一个身份。
        net.sinceUnavailable = net.sinceUnavailable || Date.now();
        const stuckSec = Math.round((Date.now() - net.sinceUnavailable) / 1000);
        net.peerError = stuckSec >= 60
          ? 'Peer ID 被占用超过 ' + stuckSec + 's：本机没有其他 daemon 在占（已确认单实例），说明 PeerJS 云端仍保留着这个 ID 的旧登记（强杀进程后常见）。正在持续用同一身份重试；若长时间不恢复，可在「身份密钥」里轮换身份（会换 Peer ID，好友需重新添加）。'
          : 'Peer ID 被占用：这个 ID 由你的公钥唯一派生，不会随机更换。正在用同一身份重试（通常几十秒内自动恢复）；若确认本机开了多个 dsh 进程，关掉多余的即可。';
      } else {
        net.sinceUnavailable = 0;
      }
      if (type !== 'unavailable-id') {
        net.peerError = (type === 'network' || type === 'server-error')
          ? '信令服务器连接失败：' + String(error && error.message || type)
          : String(type || (error && error.message) || error);
      }
      net.peerStatus = 'error';
      touch();
      // 信令类故障自愈：指数退避重建同一 Peer ID（不换身份）。
      // unavailable-id 也要退避重连：最常见原因是同一进程里上一次挂载（HMR/插件重载）
      // 的 Peer 还没完全释放，稍等片刻即可拿回同一 Peer ID（不换身份）。
      if (type !== 'invalid-id' && type !== 'invalid-key') scheduleRetry();
    });
    peer.on('close', () => { net.peerStatus = 'offline'; touch(); });
    peer.on('disconnected', () => { net.peerStatus = 'offline'; touch(); try { peer.reconnect(); } catch (e) { /* ignore */ } });
  }

  const api = {
    files,
    /** 测试钩子：暴露底层 Peer 以便模拟 peerjs 错误事件。 */
    get __peerForTest() { return net.peer; },
    get version() { return net.version; },

    async start() {
      if (net.started) return;
      net.started = true;
      net.identity = await loadOrCreateIdentity();
      net.myId = net.identity.peerId;
      net.stateFileExisted = existsSync(statePath);
      net.state = loadStateFile();
      net.version = net.state.version || 1;
      atomicWriteJson(statePath, net.state);
      try {
        await initPeer();
      } catch (error) {
        net.peerStatus = 'error';
        net.peerError = 'PeerJS/WebRTC 初始化失败: ' + String(error && error.message || error);
        touch();
      }
    },

    /** 真正停掉传输（只应由最后一个挂载点调用）。 */
    stop() {
      net.started = false;
      if (net.retryTimer) { clearTimeout(net.retryTimer); net.retryTimer = null; }
      if (net.openWatchdog) { clearTimeout(net.openWatchdog); net.openWatchdog = null; }
      if (net.persistTimer) { clearTimeout(net.persistTimer); net.persistTimer = null; }
      try { atomicWriteJson(statePath, net.state); } catch (e) { /* ignore */ }
      for (const conn of net.conns.values()) { try { conn.close(); } catch (e) { /* ignore */ } }
      net.conns.clear();
      if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
      net.peer = null;
    },

    /** Client-facing snapshot; secrets (private key) are never included. */
    snapshot() {
      return {
        ok: true,
        version: net.version,
        myId: net.myId,
        peerStatus: net.peerStatus,
        peerError: net.peerError,
        peerErrorType: net.peerErrorType,
        secured: !!(net.identity && net.identity.secured),
        fingerprint: net.identity ? net.identity.fingerprint : '',
        identityFile: identityPath,
        stateFile: statePath,
        state: net.state,
      };
    },

    /**
     * Send a human-authored message. `trigger` is `human` for a normal chat
     * message and `human-reply` when a person writes the reply themselves
     * (e.g. in the pending-approval dialog instead of letting the model answer).
     * Human replies are NOT wrapped in any model marker on the wire: they are
     * genuinely written by a human, so peers must not treat them as AI.
     */
    send(id, text, trigger) {
      const clean = sanitizeText(text);
      if (!isValidPeerId(id) || !clean) return { ok: false, error: 'invalid-input' };
      const kind = trigger === 'human-reply' ? 'human-reply' : 'human';
      const conn = net.conns.get(id);
      if (!conn || !conn.open) { connectTo(id); return { ok: false, error: 'offline' }; }
      try {
        conn.send(clean);
      } catch (e) { return { ok: false, error: 'send-failed' }; }
      upsertFriend(id, { lastMsg: clean, lastTs: Date.now(), lastOrigin: 'human', lastTrigger: kind });
      appendMessage(id, { from: 'me', text: clean, ts: Date.now(), origin: 'human', trigger: kind });
      touch();
      return { ok: true };
    },

    addFriend(id) {
      if (!isValidPeerId(id)) return { ok: false, error: 'invalid-peer' };
      if (id === net.myId) return { ok: false, error: 'self' };
      upsertFriend(id, {});
      touch();
      connectTo(id);
      return { ok: true };
    },

    removeFriend(id) {
      if (!isValidPeerId(id)) return { ok: false, error: 'invalid-peer' };
      const conn = net.conns.get(id);
      if (conn) { try { conn.close(); } catch (e) { /* ignore */ } }
      net.conns.delete(id);
      net.state.friends = net.state.friends.filter((f) => f.id !== id);
      delete net.state.messages[id];
      touch();
      return { ok: true };
    },

    markRead(id) {
      const friend = findFriend(id);
      if (!friend || !friend.unread) return { ok: true };
      friend.unread = 0;
      touch();
      return { ok: true };
    },

    patchFriend(id, patch) {
      const friend = findFriend(id);
      if (!friend) return { ok: false, error: 'not-found' };
      if (typeof patch.alias === 'string') friend.alias = (sanitizeName(patch.alias) || '');
      if (typeof patch.note === 'string') friend.note = sanitizeNote(patch.note);
      touch();
      return { ok: true };
    },

    patchSettings(patch) {
      if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid' };
      const settings = net.state.settings;
      if (typeof patch.allowBroadcast === 'boolean') settings.allowBroadcast = patch.allowBroadcast;
      if (typeof patch.allowIncoming === 'boolean') settings.allowIncoming = patch.allowIncoming;
      if (typeof patch.nickname === 'string') {
        const name = sanitizeName(patch.nickname);
        if (patch.nickname.trim() && !name) return { ok: false, error: 'invalid-nickname' };
        settings.nickname = name || '';
        for (const conn of net.conns.values()) sendHello(conn);
      }
      if (patch.reply && typeof patch.reply === 'object') {
        settings.reply = Object.assign({}, settings.reply, patch.reply);
      }
      touch();
      return { ok: true };
    },

    retryPeer() {
      // 用同一身份密钥、同一 Peer ID 强制重建连接：绝不换身份、不随机换 ID。
      if (!net.identity || !net.identity.peerId) return { ok: false, error: 'identity-missing' };
      net.myId = net.identity.peerId;
      if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
      net.peer = null;
      net.conns.clear();
      net.peerStatus = 'connecting';
      net.peerError = '';
      net.peerErrorType = '';
      touch();
      initPeer().catch(() => {});
      return { ok: true };
    },

    /** Model auto-reply / agent outbox delivery, unchanged wire markers. */
    deliverReply(to, replyText, meta) {
      const clean = sanitizeText(replyText, MAX_REPLY_OUTPUT);
      if (!isValidPeerId(to) || !clean) return { ok: false, error: 'invalid' };
      const trigger = meta && (meta.trigger === 'manual' || meta.trigger === 'auto' || meta.trigger === 'agent') ? meta.trigger : 'auto';
      const wire = trigger === 'manual'
        ? AUTO_REPLY_PREFIX + MANUAL_APPROVAL_MARKER + clean
        : trigger === 'agent' ? AI_AGENT_PREFIX + clean : AUTO_REPLY_PREFIX + clean;
      const conn = net.conns.get(to);
      if (!conn || !conn.open) { connectTo(to); return { ok: false, error: 'offline' }; }
      try { conn.send(wire); } catch (e) { return { ok: false, error: 'send-failed' }; }
      upsertFriend(to, { lastMsg: clean, lastTs: Date.now(), lastOrigin: 'model', lastTrigger: trigger });
      appendMessage(to, { from: 'me', text: clean, ts: Date.now(), origin: 'model', trigger });
      touch();
      return { ok: true };
    },

    hasConn(id) { const conn = net.conns.get(id); return !!(conn && conn.open); },

    /** Which peers are currently connected (daemon-side outbox routing). */
    connectedIds() { return [...net.conns.entries()].filter(([, c]) => c && c.open).map(([id]) => id); },

    /** Peek inbound human messages without consuming them. */
    peekInbound() { return net.inbound.slice(); },

    /** Pull inbound human messages (Host-side auto-reply trigger). */
    drainInbound() {
      const items = net.inbound;
      net.inbound = [];
      return items;
    },

    /** Rotate the identity keypair (new identity = new Peer ID). */
    async rotateIdentity() {
      const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
      const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
      const pubJwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
      const fingerprint = await fingerprintOf(pubJwk);
      const identity = { v: 1, privateJwk, pubJwk, fingerprint, peerId: PEER_ID_PREFIX + fingerprint, createdAt: Date.now() };
      atomicWriteJson(identityPath, identity);
      net.identity = { secured: true, ...identity, privateKey: pair.privateKey };
      net.myId = identity.peerId;
      if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
      for (const conn of net.conns.values()) { try { conn.close(); } catch (e) { /* ignore */ } }
      net.conns.clear();
      net.peer = null;
      net.peerStatus = 'connecting';
      net.peerError = '';
      net.peerErrorType = '';
      touch();
      initPeer().catch(() => {});
      logger.info('[peer-message] identity rotated; friends must re-add the new Peer ID');
      return { ok: true, peerId: identity.peerId, fingerprint };
    },

    /**
     * One-shot migration of legacy browser localStorage (state + private key) into
     * the Host files. Only applies when the Host has no identity yet.
     */
    async migrateFromBrowser(input) {
      const legacy = input && typeof input === 'object' ? input : {};
      let migratedIdentity = false;
      let migratedState = false;
      // 只有身份是本次启动自动生成的（即 Host 之前没有身份文件）才接受迁移，
      // 避免覆盖用户已经存在的 Host 身份。
      const canImportIdentity = net.identityAutoGenerated && !existsSync(identityPath + '.migrated')
        && legacy.identity && legacy.identity.privateJwk && isValidPublicKey(legacy.identity.pubJwk);
      if (canImportIdentity) {
        try {
          const fingerprint = await fingerprintOf(legacy.identity.pubJwk);
          const privateKey = await webcrypto.subtle.importKey('jwk', legacy.identity.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
          const identity = {
            v: 1,
            privateJwk: legacy.identity.privateJwk,
            pubJwk: legacy.identity.pubJwk,
            fingerprint,
            peerId: PEER_ID_PREFIX + fingerprint,
            createdAt: typeof legacy.identity.createdAt === 'number' ? legacy.identity.createdAt : Date.now(),
          };
          atomicWriteJson(identityPath, identity);
          net.identity = { secured: true, ...identity, privateKey };
          net.myId = identity.peerId;
          net.identityAutoGenerated = false; // 迁移后身份已由旧数据接管
          migratedIdentity = true;
          if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
          net.peer = null;
          net.peerStatus = 'connecting';
          initPeer().catch(() => {});
        } catch (error) {
          logger.warn(`[peer-message] legacy identity import failed: ${String(error && error.message || error)}`);
        }
      }
      const canImportState = !net.stateFileExisted && legacy.state && Array.isArray(legacy.state.friends);
      if (canImportState) {
        try {
          const settings = Object.assign({ ...DEFAULT_SETTINGS, reply: { ...DEFAULT_REPLY } }, legacy.state.settings || {});
          settings.reply = Object.assign({ ...DEFAULT_REPLY }, (legacy.state.settings && legacy.state.settings.reply) || {});
          net.state = {
            version: 1,
            friends: legacy.state.friends.filter((f) => f && isValidPeerId(f.id)).slice(-MAX_FRIENDS),
            messages: typeof legacy.state.messages === 'object' && legacy.state.messages ? legacy.state.messages : {},
            settings,
          };
          touch();
          net.stateFileExisted = true;
          migratedState = true;
          reconnectAll();
        } catch (error) {
          logger.warn(`[peer-message] legacy state import failed: ${String(error && error.message || error)}`);
        }
      }
      return { migratedIdentity, migratedState };
    },
  };

  // 引用计数：多个挂载点共享一个传输，最后一个释放时才真正 stop。
  const singleton = {
    api,
    refs: 1,
    acquire() { singleton.refs += 1; },
    release() {
      singleton.refs -= 1;
      if (singleton.refs > 0) return false;
      api.stop();
      if (registry.get(dataDir) === singleton) registry.delete(dataDir);
      return true;
    },
  };
  registry.set(dataDir, singleton);
  return api;
}
