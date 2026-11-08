/**
 * Preset plugin for the peer-message chat tool.
 *
 * Mounted by the peer preset inside the preset's standing scope. Registers the
 * `pm_send` tool (queues an outbound P2P message into the shared `outbox.js`
 * queue) and restricts the agent's inherited global tool surface so only the
 * preset's own scoped tools (web_search, web_fetch, pm_send) stay visible.
 *
 * The `/api/pm-outbox` fetch route is registered by the HOST plugin
 * (`index.js`), NOT here. A fetch route is process-global (tied to the
 * connection service), so a preset-scoped registration would orphan on reload
 * and conflict with the next mount. The route and this tool agree on the queue
 * through the shared `outbox.js` module.
 */

import { pushItem } from './outbox.js';

export const inject = ['tools'];

/**
 * Host-global tools a peer-chat agent must not see. These are inherited from
 * the Host plane (registered once by Host plugins, visible to every preset);
 * `restrict` can only deny inherited names, never a scope's own registrations.
 *
 * The actual inherited set (reported by `tools.restrict()` as "known global
 * tools") is: browser_* (11), inject_* (3), web_fetch, web_search. We deny the
 * browser automation and main-session review-injection tools; we keep
 * web_search/web_fetch because the user wants web research in this preset.
 * cordis_inspect_* / plugin_manager / read_image are NOT inherited globals
 * (denying them throws "unknown global tool"), so they are omitted. bash/fs/...
 * are preset-plane and never appear because the peer preset does not declare
 * them. The agent-team / schedule tools are registered in the agent's OWN
 * layer and cannot be removed by `restrict` (an architectural limit).
 */
const DENY_GLOBAL = [
  // Browser automation (dsh-browser, Host plane).
  'browser_open', 'browser_navigate', 'browser_click', 'browser_type',
  'browser_select', 'browser_screenshot', 'browser_eval', 'browser_get_html',
  'browser_get_text', 'browser_wait', 'browser_close', 'browser_install',
  // Main-session review injection (Host plane).
  'inject_context_read', 'inject_deliver', 'inject_user_inputs',
];

export function apply(ctx) {
  // Tool: agent queues a P2P message for delivery over PeerJS.
  ctx.tools.register({
    name: 'pm_send',
    description:
      'Send a P2P chat message to a friend peer by their peer ID. The message is queued and delivered when a connected browser tab of this DSH UI reaches that peer over PeerJS. Use the peer-message panel to discover peer IDs.',
    parameters: {
      to: {
        type: 'string',
        required: true,
        description: 'Recipient peer ID (from the peer-message panel).',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Message body to send.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['queued'],
        properties: {
          queued: { type: 'boolean' },
          messageId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.queued
            ? `P2P message queued for delivery to peer ${_args.to}`
            : 'P2P message queue failed',
        },
      ],
    },
    async execute(args) {
      const messageId =
        'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      pushItem({ id: messageId, to: args.to, text: args.text });
      return { queued: true, messageId };
    },
  });

  // Deny every inherited Host-global tool; keep only the preset scope's own
  // registrations (web_search, web_fetch, pm_send).
  ctx.tools.restrict({ deny: DENY_GLOBAL });
}
