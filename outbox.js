/**
 * Shared outbound P2P message queue.
 *
 * Both the Host route (`index.js`) and the preset tool (`tool.js`) import this
 * single module. Because it is loaded without a `?rev=` cache-bust, Node keeps
 * one module instance, so `pushItem` (called by `pm_send`) and the route's
 * GET drain (called by the client poll) always see the same queue — even when
 * the preset tool is reloaded via HMR.
 */

/** @type {{id:string,to:string,text:string,ts:number}[]} */
export const outbox = [];

/**
 * Queue one outbound message. `meta` (if present) is whitelisted so the client
 * can distinguish model auto-replies, human-approved replies and pm_send agent
 * messages without parsing text alone.
 * @param {{id:string,to:string,text:string,ts?:number,meta?:{origin?:string,trigger?:string,model?:string}}} item
 */
export function pushItem(item) {
  const meta = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta) ? item.meta : null;
  outbox.push({
    id: item.id,
    to: item.to,
    text: item.text,
    ts: item.ts ?? Date.now(),
    ...meta ? {
      meta: {
        ...typeof meta.origin === 'string' ? { origin: meta.origin } : {},
        ...typeof meta.trigger === 'string' ? { trigger: meta.trigger } : {},
        ...typeof meta.model === 'string' ? { model: meta.model } : {},
      },
    } : {},
  });
}
