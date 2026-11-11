/**
 * Host half of the peer-message bundle.
 *
 * Registers the `/api/pm-outbox` fetch route (process-global, mounted once by
 * this Host plugin). The route lets the client poll for queued P2P messages
 * and re-queue a failed item. The queue itself lives in the shared `outbox.js`
 * module so the preset-scoped `pm_send` tool and this route always agree,
 * even across preset HMR reloads.
 *
 * It also owns the P2P auto-reply pipeline:
 *   - `/api/pm-reply/request`  — browser half reports one inbound message
 *   - `/api/pm-reply/requests` — pending/manual approvals + running + recent
 *   - `/api/pm-reply/approve`  — run one parked manual request
 *   - `/api/pm-reply/reject`   — drop one parked manual request
 *   - `/api/pm-reply/catalog`  — providers/models, sessions, workspaces, modes
 *
 * The reply runner itself (`reply-runner.js`) is injected with the live DSH
 * services and enforces capability modes through both the `tools/pre-execute`
 * guard and per-session sandbox/approval events.
 */

import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isValidPeerId } from './validate.js';

export const inject = ['connection'];

// daemon 入口：与本文件同目录的 server/daemon.mjs。
const daemonEntry = fileURLToPath(new URL('./server/daemon.mjs', import.meta.url));

const ROUTES = [
  '/api/pm-net/state',
  '/api/pm-net/action',
  '/api/pm-net/migrate',
  '/api/pm-outbox',
  '/api/pm-reply/request',
  '/api/pm-reply/requests',
  '/api/pm-reply/approve',
  '/api/pm-reply/reject',
  '/api/pm-reply/catalog',
];

const NO_STORE = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: NO_STORE });
}

export function apply(ctx) {
  // Clear any stale routes left by an earlier mount (HMR reload orphans them
  // because fetch routes are tied to the connection service, not the caller
  // scope). Re-register cleanly below.
  for (const path of ROUTES) {
    if (ctx.connection.fetchRoutes?.has(path)) {
      ctx.connection.fetchRoutes.delete(path);
    }
  }

  /** @type {ReturnType<import('./reply-runner.js').createReplyRunner> | null} */
  let runner = null;

  // The reply pipeline needs Session/Agent services. They are optional at the
  // bundle level so the chat panel keeps working in compositions that mount
  // no session controller; reply routes then answer 503.
  ctx.inject(['sessionController', 'sessions'], (child) => {
    const controller = child.get('sessionController');
    const projections = child.get('sessionProjections');
    void import('./reply-runner.js?rev=20261111-note1').then(({ createReplyRunner }) => {
      if (child.fiber && child.fiber.state === 5 /* disposed */) return;
      runner = createReplyRunner({
        on: (event, handler) => child.on(event, handler),
        controller,
        projections,
        pushOutbox: (item) => {
          import('./outbox.js').then(({ pushItem }) => pushItem(item)).catch(() => {});
        },
        logger: ctx.logger,
        defaultCwd: process.cwd(),
      });
      child.effect(() => () => {
        if (runner) runner.dispose();
        runner = null;
      }, 'peer-message: reply runner disposal');
      // ── 入站 → 自动回复泵（Host 侧，无需任何浏览器标签页） ────────────
      // daemon 把人类入站文本放进 inbound 队列；这里拉取并直接交给 runner。
      // 浏览器只做展示，不再参与触发（多标签页也不会重复触发）。
      const pump = setInterval(async () => {
        if (!runner) return;
        try {
          const instance = await ensureNet();
          if (!instance) return;
          // 先看有没有待处理消息，避免每条都消耗一次 socket 往返；
          // 真正消费用 /inbound（唯一消费方，浏览器只窥视）。
          const snapshot = await instance.snapshot();
          const pending = Array.isArray(snapshot.inbound) ? snapshot.inbound : [];
          if (!pending.length) return;
          const settings = (snapshot.state && snapshot.state.settings) || {};
          const reply = settings.reply || {};
          if (reply.mode === 'off') return; // 关闭时保留在队列里，不消费
          const friends = (snapshot.state && snapshot.state.friends) || [];
          const { items } = await instance.drainInbound();
          const inbound = Array.isArray(items) ? items : [];
          for (const item of inbound) {
            if (!item || typeof item.peerId !== 'string' || typeof item.text !== 'string') continue;
            const friend = friends.find((f) => f.id === item.peerId);
            runner.request({
              peerId: item.peerId,
              peerName: friend ? (friend.alias || friend.name || '') : '',
              // 本机备注是可信上下文，正文是不可信对端文本（reply-core 会围栏）。
              peerNote: friend && typeof friend.note === 'string' ? friend.note : '',
              text: item.text,
              config: reply,
            });
          }
        } catch (error) { /* daemon 短暂不可用：下次再拉 */ }
      }, 1200);
      pump.unref?.();
      child.effect(() => () => clearInterval(pump), 'peer-message: inbound reply pump');

      ctx.logger.info?.('[peer-message] reply runner mounted');
    }).catch((error) => {
      ctx.logger.warn(`[peer-message] reply runner unavailable: ${String(error && error.message || error)}`);
    });
  });

  // Capability guard: deny disallowed tools for reply sessions. The guard only
  // matches sessions the runner has marked; every other session passes.
  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
    if (!runner) return next();
    const decision = runner.toolDecisionFor(exec);
    if (decision && decision.kind === 'deny') return decision;
    return next();
  }), 'peer-message: reply tool guard');

  // ── Host-side P2P transport ───────────────────────────────────────────────
  // 连接与身份属于一个**独立的 daemon 进程**（server/daemon.mjs），不属于 DSH
  // 进程本身。原因：DSH 热重载/重启会重建插件，旧 Peer 若留在进程里会一直占着
  // 由公钥确定的 Peer ID → 新实例一律 unavailable-id。daemon 独立存活后：
  //   - 关标签页、重启 DSH 都不掉线；
  //   - 同一身份全机器只有一个持有者（unix socket + pid 文件）；
  //   - 身份/好友/消息仍只落本地文件（0600）。
  // 本插件只做 HTTP ↔ unix socket 的转发代理。
  let net = null;
  let netReady = null;

  const dataDir = () => {
    const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
    return process.env.DSH_PEER_MESSAGE_DIR || `${home}/.dsh/peer-message`;
  };
  const sockPath = () => join(dataDir(), 'net.sock');

  // unix socket 上的极简 JSON HTTP 客户端（Node 18+ undici 支持 socketPath）。
  const daemonRequest = (method, path, payload, signal) => new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const request = httpRequest({
      socketPath: sockPath(),
      path,
      method,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      timeout: 8000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(new Error('daemon timeout')); });
    if (signal) signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
    if (body) request.write(body);
    request.end();
  });

  const spawnDaemon = () => {
    try {
      const child = spawn(process.execPath, [daemonEntry], {
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, { DSH_PEER_MESSAGE_DIR: dataDir() }),
      });
      child.unref();
      ctx.logger.info?.(`[peer-message] spawned p2p daemon (pid ${child.pid})`);
      return true;
    } catch (error) {
      ctx.logger.warn(`[peer-message] daemon spawn failed: ${String(error && error.message || error)}`);
      return false;
    }
  };

  // 等 socket 出现（daemon 启动需要几秒：生成/读取密钥 + 连信令）。
  const waitForDaemon = async (timeoutMs = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (existsSync(sockPath())) {
        try {
          const health = await daemonRequest('GET', '/health');
          if (health && health.ok) return true;
        } catch (e) { /* 还没 ready */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };

  const ensureNet = () => {
    if (netReady) return netReady;
    netReady = (async () => {
      let healthy = await waitForDaemon(1500);
      if (!healthy) {
        if (!spawnDaemon()) return null;
        healthy = await waitForDaemon(15000);
      }
      if (!healthy) {
        ctx.logger.warn('[peer-message] p2p daemon did not become ready');
        return null;
      }
      net = {
        get(field) { return field; },
        snapshot: () => daemonRequest('GET', '/state'),
        action: (payload) => daemonRequest('POST', '/action', payload),
        drainInbound: () => daemonRequest('POST', '/inbound'),
        migrate: (payload) => daemonRequest('POST', '/migrate', payload),
      };
      ctx.logger.info?.(`[peer-message] p2p daemon ready (socket ${sockPath()})`);
      return net;
    })().catch((error) => {
      ctx.logger.warn(`[peer-message] p2p daemon unavailable: ${String(error && error.message || error)}`);
      netReady = null;
      return null;
    });
    return netReady;
  };

  ensureNet();

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-net/state',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const instance = await ensureNet();
      if (!instance) return json({ ok: false, error: 'host-network-unavailable' }, 503);
      try {
        const snapshot = await instance.snapshot(request.signal);
        return json(snapshot);
      } catch (error) {
        // daemon 掉线：重置缓存，下次请求重新拉起。
        netReady = null;
        return json({ ok: false, error: 'daemon-unreachable' }, 503);
      }
    },
  }), 'peer-message: /api/pm-net/state');

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-net/action',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const instance = await ensureNet();
      if (!instance) return json({ ok: false, error: 'host-network-unavailable' }, 503);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid-json' }, 400); }
      try {
        const result = await instance.action(body, request.signal);
        return json(result);
      } catch (error) {
        netReady = null;
        return json({ ok: false, error: 'daemon-unreachable' }, 503);
      }
    },
  }), 'peer-message: /api/pm-net/action');

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-net/migrate',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const instance = await ensureNet();
      if (!instance) return json({ ok: false, error: 'host-network-unavailable' }, 503);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid-json' }, 400); }
      try {
        return json(await instance.migrate({ identity: body?.identity, state: body?.state }, request.signal));
      } catch (error) {
        netReady = null;
        return json({ ok: false, error: 'daemon-unreachable' }, 503);
      }
    },
  }), 'peer-message: /api/pm-net/migrate');

  // ── outbox route (existing behavior) ─────────────────────────────────────
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-outbox',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const item = body?.item;
          if (item && typeof item.to === 'string' && typeof item.text === 'string') {
            const { pushItem } = await import('./outbox.js');
            pushItem(item);
          }
        } catch (e) { /* ignore malformed */ }
        return json({ ok: true });
      }
      const { outbox } = await import('./outbox.js');
      const items = outbox.splice(0, outbox.length);
      return json({ items });
    },
  }), 'peer-message: /api/pm-outbox');

  // ── reply request route ──────────────────────────────────────────────────
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-reply/request',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (!runner) return json({ ok: false, error: 'reply-service-unavailable' }, 503);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid-json' }, 400); }
      const peerId = typeof body?.peerId === 'string' ? body.peerId : '';
      if (!isValidPeerId(peerId)) return json({ ok: false, error: 'invalid-peer' }, 400);
      const text = typeof body?.text === 'string' ? body.text : '';
      const result = runner.request({
        peerId,
        peerName: typeof body?.peerName === 'string' ? body.peerName : '',
        peerNote: typeof body?.peerNote === 'string' ? body.peerNote : '',
        text,
        config: body?.config,
      });
      return json({ ok: true, ...result });
    },
  }), 'peer-message: /api/pm-reply/request');

  // ── pending / running / recent list ──────────────────────────────────────
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-reply/requests',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      if (!runner) return json({ ok: false, error: 'reply-service-unavailable', pending: [], running: [], recent: [] }, 503);
      return json({ ok: true, ...runner.snapshot() });
    },
  }), 'peer-message: /api/pm-reply/requests');

  // ── manual approval / rejection ──────────────────────────────────────────
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-reply/approve',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (!runner) return json({ ok: false, error: 'reply-service-unavailable' }, 503);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid-json' }, 400); }
      const id = typeof body?.id === 'string' ? body.id.slice(0, 200) : '';
      if (!id) return json({ ok: false, error: 'missing-id' }, 400);
      const result = runner.approve(id);
      return json({ ok: result.ok, ...result }, result.ok ? 200 : 404);
    },
  }), 'peer-message: /api/pm-reply/approve');

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-reply/reject',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (!runner) return json({ ok: false, error: 'reply-service-unavailable' }, 503);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid-json' }, 400); }
      const id = typeof body?.id === 'string' ? body.id.slice(0, 200) : '';
      if (!id) return json({ ok: false, error: 'missing-id' }, 400);
      const result = runner.reject(id);
      return json({ ok: result.ok, ...result }, result.ok ? 200 : 404);
    },
  }), 'peer-message: /api/pm-reply/reject');

  // ── catalog for the settings UI ──────────────────────────────────────────
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-reply/catalog',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const controller = ctx.get('sessionController');
      if (!controller) return json({ ok: false, error: 'reply-service-unavailable' }, 503);
      let models = { groups: [], default: null, routableProviders: [] };
      try {
        models = await controller.modelCatalog();
      } catch (error) {
        ctx.logger.warn(`[peer-message] model catalog failed: ${String(error && error.message || error)}`);
      }
      let sessions = [];
      try {
        const listed = await controller.list({}, request.signal);
        sessions = (Array.isArray(listed?.items) ? listed.items : []).map((item) => ({
          sessionId: item.sessionId,
          title: typeof item.title === 'string' ? item.title : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        }));
      } catch (error) {
        ctx.logger.warn(`[peer-message] session list failed: ${String(error && error.message || error)}`);
      }
      let workspaces = [];
      try {
        const registry = ctx.get('workspaceRegistry');
        if (registry && typeof registry.list === 'function') {
          workspaces = registry.list().map((workspace) => ({
            id: workspace.id,
            title: typeof workspace.title === 'string' ? workspace.title : '',
            path: typeof workspace.path === 'string' ? workspace.path : '',
          }));
        }
      } catch (error) {
        ctx.logger.warn(`[peer-message] workspace list failed: ${String(error && error.message || error)}`);
      }
      return json({ ok: true, models, sessions, workspaces });
    },
  }), 'peer-message: /api/pm-reply/catalog');
}