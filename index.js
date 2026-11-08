/**
 * Host half of the peer-message bundle.
 *
 * Registers the `/api/pm-outbox` fetch route (process-global, mounted once by
 * this Host plugin). The route lets the client poll for queued P2P messages
 * and re-queue a failed item. The queue itself lives in the shared `outbox.js`
 * module so the preset-scoped `pm_send` tool and this route always agree,
 * even across preset HMR reloads.
 *
 * The route is intentionally NOT registered from the preset scope: a fetch
 * route is tied to the connection service's lifetime (process-global), so a
 * preset-scoped registration would orphan on preset reload and conflict with
 * the next mount. Registering it here keeps it exactly once.
 */

export const inject = ['connection'];

export function apply(ctx) {
  // Clear any stale `/api/pm-outbox` route left by an earlier preset-scoped
  // registration (HMR reload orphans it because fetch routes are tied to the
  // connection service, not the caller scope). Re-register cleanly below.
  if (ctx.connection.fetchRoutes?.has('/api/pm-outbox')) {
    ctx.connection.fetchRoutes.delete('/api/pm-outbox');
  }

  ctx.connection.fetch.register({
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
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const { outbox } = await import('./outbox.js');
      const items = outbox.splice(0, outbox.length);
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}
