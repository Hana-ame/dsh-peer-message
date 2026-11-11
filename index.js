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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isValidPeerId } from './validate.js';
import { createDaemonClient } from './server/client.mjs';

export const inject = ['connection'];

// daemon 入口：与本文件同目录的 server/daemon.mjs。
const daemonEntry = fileURLToPath(new URL('./server/daemon.mjs', import.meta.url));

const ROUTES = [
  '/api/pm-net/state',
  '/api/pm-net/action',
  '/api/pm-net/api',
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
        // 自动回复/agent 出站：直接投给 daemon 并由它落库 + 发送。
        // 之前只是 push 进 outbox.js 的数组，而那个数组在「浏览器不再负责排水」
        // 之后已经没人消费 → runner 报 sent，界面却什么都没有。
        pushOutbox: (item) => {
          if (!item || typeof item.to !== 'string' || typeof item.text !== 'string') return;
          ensureNet().then((instance) => {
            if (!instance) return;
            return instance.deliver(item.to, item.text, item.meta || {});
          }).then((result) => {
            if (result && result.ok === false && result.error === 'offline') {
              ctx.logger.warn(`[peer-message] reply to ${item.to} skipped: peer offline`);
            }
          }).catch((error) => {
            ctx.logger.warn(`[peer-message] reply delivery failed: ${String(error && error.message || error)}`);
          });
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
  // 统一走 server/client.mjs：同一份客户端给脚本/其它进程复用，
  // 避免各脚本各自实现一套（曾因此绕过 API 直接改 state.json）。
  // 超时 20s：信令重连期间 snapshot 可能较慢，过短会误判掉线并重开 daemon。
  let daemonClient = null;
  const getClient = () => {
    if (!daemonClient) daemonClient = createDaemonClient(dataDir(), { timeout: 20000 });
    return daemonClient;
  };
  const daemonRequest = (method, path, payload, signal) => getClient().callRaw(method, path, payload, signal);

  // 只有「socket 不存在/拒绝连接」才算真的没有 daemon；超时不算。
  const isConnRefused = (error) => {
    const code = error && (error.code || error.errno);
    const message = String((error && error.message) || '');
    return code === 'ENOENT' || code === 'ECONNREFUSED' || /ENOENT|ECONNREFUSED/.test(message);
  };

  // 锁文件或存活 pid 存在 = 已有 daemon 在启动/运行，绝不能另起一个。
  const daemonStarting = () => {
    const dir = dataDir();
    const lockFile = join(dir, 'net.lock');
    const pidFile = join(dir, 'net.pid');
    for (const file of [lockFile, pidFile]) {
      try {
        if (!existsSync(file)) continue;
        const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'EPERM') return true; }
        }
      } catch (e) { /* ignore */ }
    }
    return false;
  };

  // 拉起节流：同一进程内 30s 最多拉起一次，避免页面轮询把 spawn 放大成风暴。
  let lastSpawnAt = 0;
  const SPAWN_MIN_INTERVAL_MS = 30000;

  const spawnDaemon = () => {
    const now = Date.now();
    if (now - lastSpawnAt < SPAWN_MIN_INTERVAL_MS) return true; // 视为已在拉起中
    lastSpawnAt = now;
    // 跨进程 spawn 互斥：DSH 可能有多个进程（旧实例、多 profile），而页面轮询
    // 会各自触发 spawn。用 O_EXCL 的启动锁保证全机器同一时刻只有一个 spawner，
    // 否则多个 daemon 同时向 PeerJS 注册同一 Peer ID，互相踢下线。
    const dir = dataDir();
    const spawnLock = join(dir, 'spawn.lock');
    try {
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(spawnLock, String(process.pid), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') {
          // 别人刚在拉起：等它把自己的锁变成 daemon 的 net.lock 即可。
          try {
            const other = Number.parseInt(readFileSync(spawnLock, 'utf8').trim(), 10);
            if (Number.isInteger(other) && other > 0) { process.kill(other, 0); }
            ctx.logger.info?.('[peer-message] another process is spawning the daemon; waiting');
          } catch (e) { /* 持有者已退出：清理后继续 */ try { rmSync(spawnLock); } catch (e2) { /* ignore */ } }
          return true;
        }
        throw error;
      }
      // 锁会在 daemon 建立 net.lock 后由这里释放（或超时自动清理）。
      setTimeout(() => { try { rmSync(spawnLock); } catch (e) { /* ignore */ } }, 60000).unref?.();
    } catch (error) {
      ctx.logger.warn(`[peer-message] spawn lock failed: ${String(error && error.message || error)}`);
    }
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
      // 先给可能正在启动/正在重连的 daemon 足够时间：冷启动要生成/读取密钥并
      // 建立信令，1.5s 远远不够。过短会导致「以为没有 daemon → 再 spawn 一个」，
      // 两个 daemon 抢同一 Peer ID，正是长期 unavailable-id 的根因。
      let healthy = await waitForDaemon(6000);
      if (!healthy && daemonStarting()) {
        // 锁/pid 存在说明已有 daemon 在启动或运行中：等它，不要另起。
        ctx.logger.info?.('[peer-message] p2p daemon already starting; waiting for it');
        healthy = await waitForDaemon(30000);
      }
      if (!healthy) {
        if (!spawnDaemon()) return null;
        healthy = await waitForDaemon(45000);
      }
      if (!healthy) {
        ctx.logger.warn('[peer-message] p2p daemon did not become ready');
        return null;
      }
      const client = getClient();
      net = {
        snapshot: (signal) => client.state(signal),
        action: (payload, signal) => client.callRaw('POST', '/action', payload, signal),
        drainInbound: () => client.drainInbound(),
        deliver: (to, text, meta) => client.deliver(to, text, meta),
        migrate: (payload, signal) => client.callRaw('POST', '/migrate', payload, signal),
        api: () => client.api(),
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
        // 只有确认「连不上」才允许下次重新拉起；超时/繁忙绝不重启 daemon，
        // 否则会不断新起进程抢同一 Peer ID。这里只是把本次请求降级返回。
        if (isConnRefused(error)) netReady = null;
        return json({ ok: false, error: 'daemon-busy', retry: true }, 503);
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
        if (isConnRefused(error)) netReady = null;
        return json({ ok: false, error: 'daemon-busy', retry: true }, 503);
      }
    },
  }), 'peer-message: /api/pm-net/action');

  // 自描述：调用方/脚本不必猜 daemon 支持哪些 action。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/pm-net/api',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const instance = await ensureNet();
      if (!instance) return json({ ok: false, error: 'host-network-unavailable' }, 503);
      try { return json(await instance.api()); } catch (error) {
        if (isConnRefused(error)) netReady = null;
        return json({ ok: false, error: 'daemon-busy', retry: true }, 503);
      }
    },
  }), 'peer-message: /api/pm-net/api');

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
        if (isConnRefused(error)) netReady = null;
        return json({ ok: false, error: 'daemon-busy', retry: true }, 503);
      }
    },
  }), 'peer-message: /api/pm-net/migrate');

  // ── outbox route (existing behavior) ─────────────────────────────────────
  // 常驻排水：pm_send 工具只往 outbox.js 里 push，没人 GET 就不会发出去。
  // 这里每秒主动投给 daemon（关掉所有标签页也照常投递）。
  const outboxTimer = setInterval(async () => {
    try {
      const { outbox } = await import('./outbox.js');
      if (!outbox.length) return;
      const instance = await ensureNet();
      if (!instance) return; // daemon 不可用：留在队列，不丢
      const items = outbox.splice(0, outbox.length);
      const failed = [];
      for (const item of items) {
        if (!item || typeof item.to !== 'string' || typeof item.text !== 'string') continue;
        try {
          const result = await instance.deliver(item.to, item.text, item.meta || {});
          if (result && result.ok === false) failed.push(item);
        } catch (e) { failed.push(item); }
      }
      if (failed.length) {
        const { pushItem } = await import('./outbox.js');
        for (const item of failed) pushItem(item);
      }
    } catch (e) { /* 下次再试 */ }
  }, 1000);
  outboxTimer.unref?.();
  ctx.effect(() => () => clearInterval(outboxTimer), 'peer-message: outbox drain');

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
      // GET 也要把队列真正投递出去：pm_send 写入的 agent 消息同样不能只躺在
      // 数组里。先投给 daemon，投递失败的项才回传给调用方。
      const { outbox } = await import('./outbox.js');
      const items = outbox.splice(0, outbox.length);
      const instance = await ensureNet();
      if (!instance) return json({ items }); // daemon 不可用：交回调用方，不丢
      const failed = [];
      for (const item of items) {
        if (!item || typeof item.to !== 'string' || typeof item.text !== 'string') continue;
        try {
          const result = await instance.deliver(item.to, item.text, item.meta || {});
          if (result && result.ok === false) failed.push(item);
        } catch (e) {
          failed.push(item);
        }
      }
      return json({ items: failed });
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