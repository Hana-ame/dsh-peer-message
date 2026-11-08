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
 * Queue one outbound message.
 * @param {{id:string,to:string,text:string,ts?:number}} item
 */
export function pushItem(item) {
  outbox.push({
    id: item.id,
    to: item.to,
    text: item.text,
    ts: item.ts ?? Date.now(),
  });
}
