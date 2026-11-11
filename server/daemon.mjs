/**
 * Detached P2P host daemon.
 *
 * Owns the identity keypair, the friends/messages/settings state and the
 * PeerJS/WebRTC connection in its **own** Node process, independent of the DSH
 * web process:
 *
 *   - closing the browser tab does not drop the peer;
 *   - restarting / HMR-reloading DSH does not drop or duplicate the peer (a
 *     reloaded plugin used to leave an orphan Peer behind that kept holding the
 *     deterministic Peer ID, which surfaced as `unavailable-id`);
 *   - exactly one process can hold the key-derived Peer ID, by construction.
 *
 * Transport to DSH: a unix domain socket (`<dataDir>/net.sock`, mode 0600) with
 * a tiny JSON HTTP protocol. Files stay local: `identity.json` / `state.json`
 * in the same directory, mode 0600.
 *
 * Run standalone:  node server/daemon.mjs
 * Environment:     DSH_PEER_MESSAGE_DIR  (default ~/.dsh/peer-message)
 */

import { webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNetwork } from './network.js';

const dataDir = process.env.DSH_PEER_MESSAGE_DIR || join(homedir(), '.dsh', 'peer-message');
const sockPath = join(dataDir, 'net.sock');
const pidPath = join(dataDir, 'net.pid');
const logPath = join(dataDir, 'net.log');

mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.join(' ');
  try { writeFileSync(logPath, line + '\n', { flag: 'a', mode: 0o600 }); } catch (e) { /* ignore */ }
  console.log(line);
}

// ── WebRTC 全局必须在 peerjs 首次求值之前就位 ────────────────────────────
const require = createRequire(import.meta.url);
let wrtc = {};
try {
  const wrtcModule = await import('@roamhq/wrtc');
  wrtc = wrtcModule.default || wrtcModule;
  for (const key of ['RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate']) {
    if (wrtc[key] && !globalThis[key]) globalThis[key] = wrtc[key];
  }
  if (!globalThis.navigator) globalThis.navigator = { platform: 'node', userAgent: 'node' };
} catch (error) {
  log('wrtc load failed:', String(error && error.message || error));
  process.exit(1);
}

/**
 * peerjs 是 CJS：`util.supports` 在模块首次求值时探测 data channel 并缓存。
 * 若该模块在本进程被求值过早（supports.data=false）就会永久抛
 * browser-incompatible，因此清掉 require 缓存后再求值，并强校验结果。
 */
async function loadPeer() {
  let entry = null;
  try { entry = require.resolve('peerjs'); } catch (e) { entry = null; }
  if (entry) {
    delete require.cache[entry];
    const pkgRoot = entry.replace(/\/dist\/.*$/, '');
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(pkgRoot)) delete require.cache[key];
    }
  }
  const spec = entry ? pathToFileURL(entry).href + '?rev=' + Date.now() : 'peerjs';
  const module = await import(spec);
  const util = (module.default && module.default.util) || module.util;
  const Peer = (module.default && module.default.Peer) || module.default || module.Peer;
  if (util && util.supports && !util.supports.data) {
    throw new Error('peerjs util.supports.data=false：@roamhq/wrtc 未生效');
  }
  return Peer;
}

const Peer = await loadPeer();
log('daemon starting, data dir', dataDir);

const net = createNetwork({
  dataDir,
  wrtc,
  logger: { info: (...a) => log(...a), warn: (...a) => log('WARN', ...a) },
  loadPeerJS: async () => Peer,
});
await net.start();
log('network started; Peer ID =', net.snapshot().myId);

// ── 单实例保护：同一个 dataDir 只允许一个 daemon ─────────────────────────
// 关键教训：绝不能盲删已有 socket/pid。页面（1s 轮询）会并发触发自动拉起，
// 多个 daemon 若都通过检查再各自 listen，就会向 PeerJS 注册同一个 Peer ID，
// 后启动的挤掉先启动的，而被挤掉的那个仍在云端保留登记 → 永久 unavailable-id。
// 因此这里用 **O_EXCL 原子创建** 锁文件抢占所有权，天然没有竞态窗口：
// 只有一个进程能建成，其余直接退出；锁里记录 pid 用于识别残留锁。
const lockPath = join(dataDir, 'net.lock');

function readLockPid() {
  try { return Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10) || 0; } catch (e) { return 0; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const healthProbe = async (attempts = 3) => {
  for (let i = 0; i < attempts; i += 1) {
    const alive = await new Promise((resolve) => {
      const probe = httpRequest({ socketPath: sockPath, path: '/health', method: 'GET', timeout: 2000 }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(body).ok === true); } catch (e) { resolve(false); }
        });
      });
      probe.on('error', () => resolve(false));
      probe.on('timeout', () => { probe.destroy(); resolve(false); });
      probe.end();
    });
    if (alive) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

let ownsLock = false;
for (let attempt = 0; attempt < 50 && !ownsLock; attempt += 1) {
  try {
    // wx = O_CREAT|O_EXCL：原子；失败说明别人先建了锁。
    writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    ownsLock = true;
    break;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const otherPid = readLockPid();
    if (pidAlive(otherPid)) {
      log(`another daemon (pid ${otherPid}) holds the lock; exiting to keep a single holder`);
      try { net.stop(); } catch (e) { /* ignore */ }
      process.exit(0);
    }
    // 锁指向已死进程：确认没有活 daemon 应答后再清理（防 pid 复用误判）。
    if (await healthProbe(1)) {
      log('a live daemon answers on the socket; exiting to keep a single holder');
      try { net.stop(); } catch (e) { /* ignore */ }
      process.exit(0);
    }
    log(`removing stale lock (pid ${otherPid || 'unknown'} is not running)`);
    try { rmSync(lockPath); } catch (e) { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (!ownsLock) {
  log('could not acquire the single-holder lock; exiting');
  try { net.stop(); } catch (e) { /* ignore */ }
  process.exit(0);
}

// 拿到锁之后才清理残留 socket 并写 pid：此时已无竞争者。
if (existsSync(sockPath)) {
  try { rmSync(sockPath); } catch (e) { /* ignore */ }
}
writeFileSync(pidPath, String(process.pid), { mode: 0o600 });

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const send = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
};

/**
 * 全部可调用的 action。既是实现，也是 GET /api 的自描述来源——
 * 调用方（Host 代理、脚本、将来的其它前端）不需要再猜有哪些操作。
 */
const ACTIONS = {
  send: (net, body) => net.send(body?.id, body?.text, body?.trigger),
  addFriend: (net, body) => net.addFriend(body?.id),
  removeFriend: (net, body) => net.removeFriend(body?.id),
  markRead: (net, body) => net.markRead(body?.id),
  patchFriend: (net, body) => net.patchFriend(body?.id, body?.patch || {}),
  patchSettings: (net, body) => net.patchSettings(body?.patch || {}),
  retryPeer: (net) => net.retryPeer(),
  rotateIdentity: (net) => net.rotateIdentity(),
};

const API_DOC = {
    ok: true,
    transport: 'unix socket, JSON over HTTP (mode 0600)',
    endpoints: {
      'GET  /health': 'daemon liveness + pid + peer id',
      'GET  /state': 'full snapshot (identity metadata, friends, messages, settings, inbound peek)',
      'POST /action': 'run one action from `actions`, returns { ok, result, snapshot }',
      'POST /deliver': 'deliver a model/agent message: { to, text, meta:{origin,trigger,model} }',
      'POST /inbound': 'consume the inbound human-message queue',
      'POST /migrate': 'one-shot import of legacy browser state/identity',
      'GET  /api': 'this document',
    },
    actions: Object.keys(ACTIONS),
    fields: {
      friend: ['id', 'name', 'alias', 'note', 'online', 'verified', 'fingerprint', 'unread', 'lastMsg', 'lastTs', 'lastOrigin', 'lastTrigger'],
      message: ['from', 'text', 'ts', 'origin', 'trigger'],
      settings: ['allowBroadcast', 'allowIncoming', 'nickname', 'reply'],
      reply: ['mode', 'permission', 'provider', 'model', 'reasoningEffort', 'sessionMode', 'sessionId', 'cwd'],
    },
    notes: [
      'Peer ID is derived from the identity public key and never randomized.',
      'verified/fingerprint are only ever written by a successful hello signature check (patchFriend cannot set them).',
      'send trigger: "human" (normal) or "human-reply" (a person answering instead of the model).',
      'deliver meta.trigger: "auto" | "manual" | "agent".',
    ],
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://daemon');
    const path = url.pathname;
    if (request.method === 'GET' && path === '/state') {
      // 只窥视不消费：HMR/多标签页各自轮询时不能互相抢走待处理消息。
      const snapshot = net.snapshot();
      snapshot.inbound = net.peekInbound();
      return send(response, 200, snapshot);
    }
    if (request.method === 'POST' && path === '/deliver') {
      // 自动回复 / agent 出站消息的唯一投递入口。必须在 daemon 侧投递：
      // 消息要进 state.json 并真的发出去，而不是停在 DSH 进程的 outbox 数组里
      // （之前 /api/pm-outbox 只 push 不排水，回复 = 永远显示不出来）。
      const raw = await readBody(request);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return send(response, 400, { ok: false, error: 'invalid-json' }); }
      const result = net.deliverReply(body?.to, body?.text, body?.meta || {});
      return send(response, result.ok ? 200 : 200, Object.assign({ ok: true }, result));
    }
    if (request.method === 'POST' && path === '/inbound') {
      // 唯一消费入口：由 Host 的自动回复泵调用。
      return send(response, 200, { ok: true, items: net.drainInbound() });
    }
    if (request.method === 'GET' && path === '/api') {
      return send(response, 200, API_DOC);
    }
    if (request.method === 'GET' && path === '/health') {
      return send(response, 200, { ok: true, pid: process.pid, version: net.version, myId: net.snapshot().myId });
    }
    if (request.method === 'POST' && (path === '/action' || path === '/migrate')) {
      const raw = await readBody(request);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return send(response, 400, { ok: false, error: 'invalid-json' }); }
      if (path === '/migrate') {
        const result = await net.migrateFromBrowser({ identity: body?.identity, state: body?.state });
        return send(response, 200, Object.assign({ ok: true }, result, { snapshot: net.snapshot() }));
      }
      const action = typeof body.action === 'string' ? body.action : '';
      const handler = ACTIONS[action];
      if (!handler) {
        return send(response, 400, {
          ok: false,
          error: 'unknown-action',
          action,
          available: Object.keys(ACTIONS),
        });
      }
      const result = await handler(net, body);
      return send(response, 200, Object.assign({ ok: true }, result, { snapshot: net.snapshot() }));
    }
    return send(response, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    log('request failed:', String(error && error.message || error));
    try { send(response, 500, { ok: false, error: 'daemon-error' }); } catch (e) { /* ignore */ }
  }
});

server.listen(sockPath, () => {
  try { chmodSync(sockPath, 0o600); } catch (e) { /* ignore */ }
  log('listening on', sockPath);
});

const shutdown = (signal) => {
  log('shutting down (' + signal + ')');
  try { net.stop(); } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  try { if (existsSync(sockPath)) rmSync(sockPath); } catch (e) { /* ignore */ }
  try { if (existsSync(pidPath)) rmSync(pidPath); } catch (e) { /* ignore */ }
  // 释放单持有锁（只在确实写入本进程 pid 时删除，避免误删别人的锁）
  try { if (readLockPid() === process.pid && existsSync(lockPath)) rmSync(lockPath); } catch (e) { /* ignore */ }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => log('uncaught', String(error && error.stack || error)));
process.on('unhandledRejection', (error) => log('unhandled', String(error && error.stack || error)));
