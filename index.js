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

import { isValidPeerId } from './validate.js';

export const inject = ['connection'];

const ROUTES = [
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
    void import('./reply-runner.js?rev=20261111-origin2').then(({ createReplyRunner }) => {
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