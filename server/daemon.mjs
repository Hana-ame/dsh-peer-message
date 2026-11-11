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
// 关键：不能盲目 rm 掉已有 socket（那会让两个 daemon 同时持有同一 Peer ID →
// 互相 unavailable-id）。先探活：活着的 daemon 直接让位；只有确认是残留
// socket（连不上）才清理。
{
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

  // 1) 进程级：pid 文件里的那个进程还活着吗？（比 socket 探活更可靠）
  if (existsSync(pidPath)) {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      let running = false;
      try { process.kill(pid, 0); running = true; } catch (e) { running = e.code === 'EPERM'; }
      if (running) {
        log(`another daemon (pid ${pid}) owns this data dir; exiting to keep a single holder`);
        try { net.stop(); } catch (e) { /* ignore */ }
        process.exit(0);
      }
    }
  }
  // 2) socket 级：pid 文件丢失但 daemon 还在跑的情况
  if (existsSync(sockPath) && await healthProbe()) {
    log('another daemon answers on this socket; exiting to keep a single holder');
    try { net.stop(); } catch (e) { /* ignore */ }
    process.exit(0);
  }
  if (existsSync(sockPath)) {
    log('removing stale socket', sockPath);
    try { rmSync(sockPath); } catch (e) { /* ignore */ }
  }
  writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
}

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
    if (request.method === 'POST' && path === '/inbound') {
      // 唯一消费入口：由 Host 的自动回复泵调用。
      return send(response, 200, { ok: true, items: net.drainInbound() });
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
      let result;
      switch (action) {
        case 'send': result = net.send(body?.id, body?.text); break;
        case 'addFriend': result = net.addFriend(body?.id); break;
        case 'removeFriend': result = net.removeFriend(body?.id); break;
        case 'markRead': result = net.markRead(body?.id); break;
        case 'patchFriend': result = net.patchFriend(body?.id, body?.patch || {}); break;
        case 'patchSettings': result = net.patchSettings(body?.patch || {}); break;
        case 'retryPeer': result = net.retryPeer(); break;
        case 'rotateIdentity': result = await net.rotateIdentity(); break;
        default: return send(response, 400, { ok: false, error: 'unknown-action' });
      }
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
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => log('uncaught', String(error && error.stack || error)));
process.on('unhandledRejection', (error) => log('unhandled', String(error && error.stack || error)));
