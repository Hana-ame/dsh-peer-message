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

/**
 * 信令服务器配置。
 *
 * **默认走自建信令 `https://signal.moonchan.xyz/`**（api-pack 的 pm-signal，
 * peerjs 1.5.4 线协议兼容；nginx 反代 + CF 橙云已部署实测）。
 * 用户裁定（2026-11-20）：message 插件默认就用自己的信令，不再依赖
 * 0.peerjs.com 云端——自建信令同 Peer ID 新连接直接顶掉旧的、15s 无心跳
 * 即释放 ID，unavailable-id 风暴的土壤（旧登记残留 35 分钟）整体消失。
 *
 * 覆盖方式：
 *   PM_SIGNAL_URL=https://signal.moonchan.xyz/   # 改默认（任何 http(s)://…/ 均可）
 *   PM_SIGNAL_URL=cloud                          # 特殊值：显式回落 PeerJS 云端
 *   PM_SIGNAL_KEY                                # 客户端 key（默认 peerjs）
 */
const DEFAULT_SIGNAL_URL = 'https://signal.moonchan.xyz/';

function signalingOptions(logger) {
  let raw = typeof process.env.PM_SIGNAL_URL === 'string' ? process.env.PM_SIGNAL_URL.trim() : '';
  if (raw === 'cloud') return null; // 显式要求云端
  if (!raw) raw = DEFAULT_SIGNAL_URL; // 未设置 → 默认自建信令
  try {
    const url = new URL(raw);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = url.port ? Number(url.port) : (secure ? 443 : 80);
    const rawPath = url.pathname && url.pathname !== '' ? url.pathname : '/';
    return {
      secure,
      host: url.hostname,
      port,
      // peerjs 会把 path 拼成 `${path}peerjs`，必须保证以 / 结尾。
      path: rawPath.endsWith('/') ? rawPath : rawPath + '/',
      key: url.searchParams.get('key') || process.env.PM_SIGNAL_KEY || 'peerjs',
    };
  } catch (error) {
    // 解析失败不回落云端：按裁定保住「默认就是自建信令」，由 initPeer 重试兜底。
    logger.warn?.(`[peer-message] PM_SIGNAL_URL 解析失败（${String(error && error.message || error)}），使用默认 ${DEFAULT_SIGNAL_URL}`);
    try {
      return { secure: true, host: new URL(DEFAULT_SIGNAL_URL).hostname, port: 443, path: '/', key: 'peerjs' };
    } catch {
      return null;
    }
  }
}


// ── 社交层（自建信令服务器的发现/推荐/profile/好友/打招呼）──────────────
// 仅当走自建信令（signal 非 null）时启用；PeerJS 云端没有这些 API。
// 周期轮询 + 事件推送（SOCIAL-NOTICE 经信令 WS）双通道，daemon 是唯一权威。
function createSocialHub({ signal, logger, getState, touch, getMyToken, addFriendLike }) {
  if (!signal) return null; // 云端模式：社交层不可用
  const base = `${signal.secure ? 'https' : 'http'}://${signal.host}:${signal.port}${signal.path}`;
  const headers = () => ({ 'x-peer-id': net0.myId, 'x-peer-token': getMyToken() });
  let net0; // 延迟绑定（net 对象在 createNetwork 里构造）
  const bind = (n) => { net0 = n; };
  let timer = null;
  let socialCache = { people: [], recommended: [], greetings: [], friends: [] };

  async function call(method, path, body) {
    const opts = { method, headers: { ...headers(), 'content-type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(base + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: res.status, data });
    return data;
  }

  // 连接 URL 上的 profile（服务端 onConnect 读取）。改动后重连生效。
  function profileQuery() {
    const state = getState();
    const s = state.settings || {};
    const prof = {
      name: s.nickname || '',
      bio: s.bio || '',
      tags: s.tags || '',
      allowGreet: s.allowGreet !== false,
      canControl: s.canControl === true,
    };
    return '&profile=' + encodeURIComponent(JSON.stringify(prof));
  }

  // 好友/打招呼事件：信令 WS 收到 SOCIAL-NOTICE 时由 handleSignalNotice 转进来。
  function onNotice(fromId, payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.event === 'greet') {
      socialCache.greetings.push({ from: fromId, text: String(payload.text || ''), at: Date.now() });
      touch();
    } else if (payload.event === 'friend-added') {
      addFriendLike(fromId); // 对端加我为好友 → 本地也加（对等模型）
      touch();
    } else if (payload.event === 'friend-removed') {
      const st = getState();
      st.friends = (st.friends || []).filter((f) => f.id !== fromId);
      delete (st.messages || {})[fromId];
      touch();
    }
  }

  async function refresh() {
    try {
      const [disc, rec, box] = await Promise.all([
        call('GET', 'discover').catch(() => null),
        call('GET', 'recommend').catch(() => null),
        call('GET', 'greetings').catch(() => null),
      ]);
      if (disc && disc.ok) socialCache.people = disc.people || [];
      if (rec && rec.ok) socialCache.recommended = rec.recommended || [];
      // 收件箱兜底：WS 推送（SOCIAL-NOTICE）可能被 peerjs 客户端丢弃（它的
      // default 分支只 warn 未知消息），所以每次 refresh 都拉一次 /greetings
      // （服务器 drain 语义：取走即清）。重复消息由 onNotice 与这里合并去重。
      if (box && box.ok && Array.isArray(box.greetings)) {
        for (const g of box.greetings) {
          const dup = socialCache.greetings.some((x) => x.from === g.from && x.text === g.text);
          if (!dup) socialCache.greetings.push({ from: g.from, text: g.text, at: Date.parse(g.at) || Date.now() });
        }
        touch();
      }
      const me = getState();
      const onlineIds = new Set(socialCache.people.map((p) => p.peerId));
      // 好友列表：以服务端为准合并（服务器记的是对等关系）。
      try {
        const fl = await call('GET', 'friends');
        if (fl && fl.ok && Array.isArray(fl.friends)) {
          socialCache.friends = fl.friends;
        }
      } catch (e) { /* 服务器无好友或未启用：保持本地 */ }
      touch();
    } catch (error) {
      logger.warn?.(`[peer-message] social refresh failed: ${String(error && error.message || error)}`);
    }
  }

  // greet：陌生人打招呼（服务端收件箱，在线即时推）。
  async function greet(to, text) {
    await call('POST', 'greet', { to, text: String(text || '').slice(0, 200) });
    await refresh();
  }

  // setProfile：改自己的档案（重连后随 URL 广播）。
  async function setProfile(patch) {
    const s = getState().settings || {};
    const next = { ...s, ...patch };
    await call('PATCH', 'profile', {
      name: next.nickname || '',
      bio: next.bio || '',
      tags: next.tags || '',
      allowGreet: next.allowGreet !== false,
      canControl: next.canControl === true,
    });
    await refresh();
  }

  // addFriend：本地 + 服务端双侧登记（信令门禁放行 OFFER）。
  async function serverAddFriend(otherId) {
    try {
      await call('POST', `friends/${otherId}`);
      await refresh();
    } catch (error) {
      logger.warn?.(`[peer-message] server addFriend failed: ${String(error && error.message || error)}`);
    }
  }

  async function serverRemoveFriend(otherId) {
    try {
      await call('DELETE', `friends/${otherId}`);
      await refresh();
    } catch (error) {
      logger.warn?.(`[peer-message] server removeFriend failed: ${String(error && error.message || error)}`);
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void refresh(); }, 15000);
    timer.unref?.();
    void refresh();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function snapshot() {
    return {
      available: true,
      people: socialCache.people,
      recommended: socialCache.recommended,
      greetings: socialCache.greetings,
      friends: socialCache.friends,
    };
  }
  return { bind, onNotice, refresh, greet, setProfile, serverAddFriend, serverRemoveFriend, profileQuery, start, stop, snapshot };
}

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
  const { dataDir, loadPeerJS, wrtc, logger = console } = options; // options.signal 由调用方传入（见 daemon.mjs）
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

  // 社交层：自建信令才有（signal 非 null）。需要 net.myId/token，故先构造再 bind。
  const signalOpt = options.signal || signalingOptions(logger);
  const social = createSocialHub({
    signal: signalOpt,
    logger,
    getState: () => net.state,
    touch: () => touch(),
    getMyToken: () => (net.identity && net.identity.token) || '',
    addFriendLike: (id) => { upsertFriend(id, {}); connectTo(id); },
  });

  const net = {
    files,
    peer: null,
    myId: '',
    peerStatus: 'connecting',
    peerError: '',
    peerErrorType: '',
    // 进入错误态的时间戳：UI 据此决定「中性等待提示」还是「红色冲突框」。
    peerErrorSince: 0,
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
    // 接管环检测：open 后很快又掉线的次数（≥3 说明另一处同 token 复制体在互相接管）。
    lastOpenAt: 0,
    takeoverHints: 0,
    openWatchdog: null,
    peerInitBusy: false,
    // 自建信令配置（PM_SIGNAL_URL）；null = 用 PeerJS 云端默认值。
    signal: signalOpt,
    // 文件是否由本次启动新建：只有「自动生成」的身份/状态才允许被旧
    // localStorage 迁移覆盖，已经有真实文件时绝不覆盖。
    identityAutoGenerated: false,
    stateFileExisted: false,
  };

  // ── 本地文件：身份 + 状态 ─────────────────────────────────────────────
  // 身份 v2 = v1 + 持久化信令 token。PeerJS 云端的占用判定（webSocketServer）：
  //   ID 已被登记时比较 token —— token 相同 → 新 socket 直接接管旧登记；
  //   token 不同 → 回 ID-TAKEN（客户端表现为 unavailable-id）。
  // 旧版每次 new Peer 都生成随机 token，于是自己断网/重启留下的云端旧登记
  // 会把自己挡在门外，重试多少轮都拿不回（35 分钟以上的 unavailable-id 风暴）。
  // 持久化同一个 token 后：断网、daemon 重启、整机重启留下的旧登记都能瞬间接管，
  // 「动不动就冲突」在机制上消失。
  function newSessionToken() { return randomUUID(); }

  function isValidToken(token) {
    return typeof token === 'string' && token.length >= 8 && token.length <= 200;
  }

  async function loadOrCreateIdentity() {
    if (existsSync(identityPath)) {
      try {
        const stored = JSON.parse(readFileSync(identityPath, 'utf8'));
        if (stored && stored.privateJwk && isValidPublicKey(stored.pubJwk)) {
          const fingerprint = await fingerprintOf(stored.pubJwk);
          const privateKey = await webcrypto.subtle.importKey('jwk', stored.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
          let token = isValidToken(stored.token) ? stored.token : '';
          if (!token) {
            // v1 → v2 就地升级：补写 token（只补一次，之后稳定复用）。
            token = newSessionToken();
            try {
              atomicWriteJson(identityPath, Object.assign({}, stored, { v: 2, token }));
              logger.info('[peer-message] identity upgraded to v2: persistent signaling token written');
            } catch (error) {
              logger.warn(`[peer-message] identity v2 upgrade write failed: ${String(error && error.message || error)}`);
            }
          }
          return { secured: true, privateJwk: stored.privateJwk, privateKey, pubJwk: stored.pubJwk, fingerprint, peerId: PEER_ID_PREFIX + fingerprint, token };
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
    const identity = { v: 2, privateJwk, pubJwk, fingerprint, peerId: PEER_ID_PREFIX + fingerprint, token: newSessionToken(), createdAt: Date.now() };
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
      friend = { id, name: id.slice(0, 8), alias: '', note: '', online: false, unread: 0, lastMsg: '', lastTs: Date.now(), verified: false, fingerprint: '', lastHumanOutAt: 0 };
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
    if (data && typeof data === 'object' && data.type === 'SOCIAL-NOTICE') {
      // 服务端社交事件（打招呼/好友变更）经信令 WS 推送：转给社交层处理。
      if (social) social.onNotice(remoteId, data.payload);
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

  /**
   * Reconnect to offline friends, strictly paced.
   *
   * A burst of simultaneous connects is what broke signaling: with many stale
   * friend ids in the list, every failed connect fires peer-unavailable and the
   * server eventually dropped us ("Lost connection to server"), after which the
   * daemon's own rebuild hit the still-registered ID -> unavailable-id, forever.
   * So: only really-online-known friends, at most `RECONNECT_BATCH` at a time,
   * spaced out, and never while signaling is not open.
   */
  const RECONNECT_BATCH = 3;
  const RECONNECT_GAP_MS = 1500;
  function reconnectAll() {
    if (!net.peer || !net.peer.open) return;
    // 只给「确认在线过」的好友拨号（online === true）。历史脏数据（测试用假 id）
    // 的 online 为 undefined，绝不能拿来拨号：一次打开会打出几十个
    // peer-unavailable，直接把信令连接打掉。
    const targets = net.state.friends
      .filter((f) => f && !net.conns.has(f.id) && f.online === true)
      .slice(0, RECONNECT_BATCH);
    targets.forEach((friend, index) => {
      const timer = setTimeout(() => {
        if (!net.started || !net.peer || !net.peer.open) return;
        if (net.conns.has(friend.id)) return;
        connectTo(friend.id);
      }, index * RECONNECT_GAP_MS);
      timer.unref?.();
    });
  }

  function scheduleRetry(reason) {
    if (!net.started) return;
    net.retryAttempts = (net.retryAttempts || 0) + 1;
    // 永不放弃：持续用同一身份、同一 Peer ID、同一 token 恢复。身份 v2 之后
    // token 持久化，自己的旧登记靠接管拿回（见 loadOrCreateIdentity 的说明），
    // unavailable-id 只剩「他方不同 token 持有」一种真冲突——那种情况密集重试
    // 没有意义，退避到最长 120s 一轮即可。
    const base = reason === 'unavailable-id' ? 8000 : 2000;
    const cap = reason === 'unavailable-id' ? 120000 : 45000;
    const delay = Math.min(base * Math.pow(2, Math.min(net.retryAttempts - 1, 4)), cap);
    if (net.retryTimer) clearTimeout(net.retryTimer);
    net.retryTimer = setTimeout(() => {
      net.retryTimer = null;
      if (!net.started) return;
      if (net.peer && net.peer.open) { net.retryAttempts = 0; return; }
      recoverOnce();
    }, delay);
    net.retryTimer.unref?.();
  }

  // 单次恢复：优先 peer.reconnect()（同一 Peer 实例、同一 token，云端直接把
  // 旧登记移交给新 socket，最轻最快）；实例不可用才销毁重建——重建携带同一
  // 持久 token，同样瞬间接管。绝不在收到错误时立刻 destroy+随机 token 新建，
  // 那曾把每次普通断网放大成 35 分钟以上的自我占用风暴。
  function recoverOnce() {
    if (!net.started) return;
    const peer = net.peer;
    if (peer && peer.open) { net.retryAttempts = 0; return; }
    if (peer && !peer.destroyed && peer.disconnected) {
      try {
        peer.reconnect(); // 同 token 会话接管
        armOpenWatchdog();
        return;
      } catch (e) { /* reconnect 不适用：落到重建 */ }
    }
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
    net.peer = null;
    net.peerStatus = 'connecting';
    touch();
    initPeer().catch(() => {});
  }

  // 信令可能既不 open 也不 error（代理/云端半挂）：25s 内没 open 就当作失败，
  // 销毁后以同一身份、同一 token 重建（仍是接管，不是抢号）。
  function armOpenWatchdog() {
    if (net.openWatchdog) clearTimeout(net.openWatchdog);
    net.openWatchdog = setTimeout(() => {
      net.openWatchdog = null;
      if (!net.started || (net.peer && net.peer.open)) return;
      net.peerStatus = 'error';
      net.peerErrorType = 'timeout';
      net.peerErrorSince = net.peerErrorSince || Date.now();
      net.peerError = '信令连接超时（25s 未建立）：正在用同一身份、同一 Peer ID 重试。';
      touch();
      if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } }
      net.peer = null;
      scheduleRetry('timeout');
    }, 25000);
    net.openWatchdog.unref?.();
  }

  async function initPeer() {
    if (!net.started) return;
    // 互斥必须是「同步占位」：调用点都在同一 tick 里，若等到 await 之后才置位，
    // 多个调用会同时通过检查 → 同时 new Peer（日志里 creating Peer 连续两条）。
    if (net.peerInitBusy) return;
    net.peerInitBusy = true;
    try {
      await initPeerInner();
    } catch (error) {
      net.peerInitBusy = false;
      throw error;
    }
    // 连接建立或彻底失败后由事件回调/下面的兜底释放；这里给一个保守的兜底。
    setTimeout(() => { net.peerInitBusy = false; }, 3000).unref?.();
  }

  async function initPeerInner() {
    if (!net.started) return;
    // 已有存活连接就不重建（避免重复注册同一 ID）。
    if (net.peer && net.peer.open) return;
    if (net.peer) { try { net.peer.destroy(); } catch (e) { /* ignore */ } net.peer = null; }
    const Peer = await loadPeerJS();
    logger.info?.(`[peer-message] creating Peer with id=${net.myId}`);
    // 同一持久 token：断网/重启留下的云端旧登记被直接接管（token 相同云端即移交）。
    const peer = new Peer(net.myId, {
      debug: 0,
      config: { iceServers: STUN },
      // 自建信令（可选）：PM_SIGNAL_URL 存在时覆盖 host/port/path/key/secure，
      // 否则沿用 peerjs 默认的 0.peerjs.com。
      ...(net.signal ? net.signal : {}),
      ...(net.identity && isValidToken(net.identity.token) ? { token: net.identity.token } : {}),
    });
    // profile 同步：peerjs 1.5.4 的 WS URL 不支持附加 query（Socket._baseUrl 固定
    // 拼 `path + "peerjs?key="`），因此档案在 peer open 后立即经 HTTP PATCH /profile
    // 推送（social.setProfile），服务端 onConnect 先落默认档案、PATCH 覆盖。
    net.peer = peer;
    peer.on('open', (id) => {
      if (net.openWatchdog) { clearTimeout(net.openWatchdog); net.openWatchdog = null; }
      net.peerInitBusy = false; // open 即初始化完成，释放互斥（否则 3s 兜底窗口内重启卡死）
      net.myId = id;
      net.peerStatus = 'online';
      net.peerError = '';
      net.peerErrorType = '';
      net.peerErrorSince = 0;
      net.retryAttempts = 0;
      net.sinceUnavailable = 0;
      net.lastOpenAt = Date.now();
      // 稳定在线 60s 后清除接管环计数（偶发断线不误报「另一处在运行」）。
      const openMark = net.lastOpenAt;
      setTimeout(() => { if (net.lastOpenAt === openMark && net.peerStatus === 'online') net.takeoverHints = 0; }, 60000).unref?.();
      touch();
      reconnectAll();
      // open 后立即把档案推给信令服务器（PUT 语义的 PATCH /profile）+ 拉一次发现列表。
      if (social) {
        const st = net.state;
        void social.setProfile({
          name: st.settings && st.settings.nickname,
          bio: st.settings && st.settings.bio,
          tags: st.settings && st.settings.tags,
          allowGreet: !st.settings || st.settings.allowGreet !== false,
          canControl: !!(st.settings && st.settings.canControl),
        }).catch(() => {});
        void social.refresh().catch(() => {});
      }
    });
    armOpenWatchdog();
    peer.on('connection', handleIncoming);
    peer.on('error', (error) => {
      const type = error && error.type;
      logger.info?.(`[peer-message] peer error: type=${type} msg=${String(error && error.message || '').slice(0, 160)}`);
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
      net.peerErrorSince = net.peerErrorSince || Date.now();
      if (type === 'unavailable-id') {
        // token 持久化之后，ID-TAKEN 只剩两类真因：
        //   1) 另一台机器/容器在用同一份 identity.json（token 相同→互相接管循环，
        //      见下方 takeoverHints 检测；token 不同→稳定互斥）；
        //   2) PeerJS 云端还留着升级前（随机 token 时代）的旧登记，等它释放（最迟
        //      约 40 分钟，只发生一次）。
        net.sinceUnavailable = net.sinceUnavailable || Date.now();
        const stuckSec = Math.round((Date.now() - net.sinceUnavailable) / 1000);
        net.peerError = stuckSec >= 120
          ? 'Peer ID 持续被占用（' + stuckSec + 's）：占用者持有的会话 token 与本机不同。这个 ID 由你的公钥派生，很可能是另一台机器/容器在用同一份身份文件运行，或是云端还留着升级前的旧登记（最迟约 40 分钟自动释放）。正在用同一身份持续重试，绝不换 ID；确认有另一处在运行就关掉它，否则可在「身份密钥」里轮换身份（好友需重新添加）。'
          : 'Peer ID 暂时被占用：正在用同一身份重试接管（通常几十秒内自动恢复），不会随机更换 ID。';
      } else {
        net.sinceUnavailable = 0;
        net.peerError = (type === 'network' || type === 'server-error')
          ? '信令服务器连接失败：' + String(error && error.message || type)
          : String(type || (error && error.message) || error);
      }
      net.peerStatus = 'error';
      touch();
      // 接管环检测：open 后 20s 内又出错/掉线，反复 ≥3 次 = 另一处同 token
      // 复制体在互相把对方顶下线（典型：身份文件被复制到第二台机器/容器）。
      if (net.lastOpenAt && Date.now() - net.lastOpenAt < 20000) net.takeoverHints += 1;
      if (net.takeoverHints >= 3 && net.peerErrorType !== 'identity-elsewhere') {
        net.peerErrorType = 'identity-elsewhere';
        net.peerError = '检测到同一身份在另一处运行：两边正在互相把对方挤下线。请只保留一处运行（关掉另一处的 dsh / 容器），或在「身份密钥」里轮换身份。';
        touch();
      }
      // 永不放弃：信令类错误统一走恢复（reconnect 优先、同 token 重建兜底）。
      // invalid-id/invalid-key/browser-incompatible/ssl 是不可重试的配置错误。
      if (!['invalid-id', 'invalid-key', 'browser-incompatible', 'ssl-unavailable'].includes(type)) scheduleRetry(type);
    });
    peer.on('close', () => { net.peerStatus = 'offline'; touch(); });
    peer.on('disconnected', () => {
      if (!net.started) return;
      net.peerStatus = 'connecting';
      touch();
      if (net.lastOpenAt && Date.now() - net.lastOpenAt < 20000) net.takeoverHints += 1;
      scheduleRetry('network');
    });
  }

  const api = {
    files,
    /** 测试钩子：暴露底层 Peer 以便模拟 peerjs 错误事件。 */
    get __peerForTest() { return net.peer; },
    get version() { return net.version; },

    async start() {
      if (net.started) return;
      net.started = true;
      if (social) { social.bind(net); social.start(); }
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
      if (social) social.stop();
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
        peerErrorSince: net.peerErrorSince,
        // 当前信令目标（null = PeerJS 云端），前端/脚本据此显示「连接经哪条信令」。
        signalUrl: net.signal ? `${net.signal.secure ? 'wss' : 'ws'}://${net.signal.host}:${net.signal.port}${net.signal.path}` : '',
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
      // lastHumanOutAt：人工出站时间戳。自动回复管线据此做 supersede——
      // 人在模型生成/待批准期间已经自己回复了，模型草稿就不再发（防双向冲突）。
      upsertFriend(id, { lastMsg: clean, lastTs: Date.now(), lastOrigin: 'human', lastTrigger: kind, lastHumanOutAt: Date.now() });
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
      // 自建信令的服务端好友登记（信令门禁只放行好友间的 OFFER）。
      if (social) { void social.serverAddFriend(id); }
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
      // 同步断开服务端好友关系（信令门禁随即关闭）。
      if (social) { void social.serverRemoveFriend(id); }
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
      const raw = typeof replyText === 'string' ? replyText : '';
      // reply-runner / pm_send 已经按来源加过一次标记（[自动回复]/[自动回复]
      // [人工批准]/[AI]）。这里必须先把已有标记剥掉再按 trigger 重新加，
      // 否则对端会看到 `[自动回复] [自动回复] …` 这种重复前缀。
      const info = modelTextInfo(raw);
      const body = info.isModel ? info.display : raw;
      const clean = sanitizeText(body, MAX_REPLY_OUTPUT);
      if (!isValidPeerId(to) || !clean) return { ok: false, error: 'invalid' };
      const trigger = meta && (meta.trigger === 'manual' || meta.trigger === 'auto' || meta.trigger === 'agent')
        ? meta.trigger
        : (info.isModel ? info.trigger : 'auto');
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

    /** 社交层（自建信令才有）：发现/推荐/profile/打招呼/好友同步。 */
    social() {
      if (!social) return { available: false, people: [], recommended: [], greetings: [], friends: [] };
      return social.snapshot();
    },
    async socialGreet(to, text) {
      if (!social) return { ok: false, error: 'social-unavailable' };
      try { await social.greet(to, text); return { ok: true }; }
      catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
    async socialSetProfile(patch) {
      if (!social) return { ok: false, error: 'social-unavailable' };
      try {
        await social.setProfile(patch);
        const st = net.state; const se = st.settings = st.settings || {};
        if (typeof patch.nickname === 'string') se.nickname = patch.nickname;
        if (typeof patch.bio === 'string') se.bio = patch.bio;
        if (typeof patch.tags === 'string') se.tags = patch.tags;
        if (typeof patch.allowGreet === 'boolean') se.allowGreet = patch.allowGreet;
        if (typeof patch.canControl === 'boolean') se.canControl = patch.canControl;
        touch();
        return { ok: true };
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
    async socialRefresh() {
      if (!social) return { ok: false, error: 'social-unavailable' };
      await social.refresh();
      return { ok: true, ...social.snapshot() };
    },
    /** 服务端好友登记（信令门禁放行 OFFER 的前提）。addFriend 调它，也可手动。 */
    async socialServerAddFriend(id) {
      if (!social) return { ok: true, skipped: true };
      await social.serverAddFriend(id);
      return { ok: true };
    },
    async socialServerRemoveFriend(id) {
      if (!social) return { ok: true, skipped: true };
      await social.serverRemoveFriend(id);
      return { ok: true };
    },

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
      const identity = { v: 2, privateJwk, pubJwk, fingerprint, peerId: PEER_ID_PREFIX + fingerprint, token: newSessionToken(), createdAt: Date.now() };
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
            v: 2,
            privateJwk: legacy.identity.privateJwk,
            pubJwk: legacy.identity.pubJwk,
            fingerprint,
            peerId: PEER_ID_PREFIX + fingerprint,
            token: isValidToken(legacy.identity.token) ? legacy.identity.token : newSessionToken(),
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
