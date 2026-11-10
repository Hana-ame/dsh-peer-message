# dsh-peer-message

A global P2P messaging plugin for the DeepSeek Harness (DSH) Web UI. It adds a
WeChat/QQ-style chat panel that connects two DSH Web tabs over **PeerJS**, so a
user can discover a friend by **string peer ID** or by **QR code** and exchange
messages in real time. It also ships an **agent preset** (`Peer Chat`) that lets
a session's agent send P2P messages through the `pm_send` tool, alongside
`web_search` and `web_fetch`.

## Features

- **Global chat panel** — a sidebar icon opens a friend list with avatars,
  nicknames, last-message previews, and unread-count badges.
- **QQ / WeChat style** — chat bubbles, message input, friend management.
- **Safe friend management** — right-clicking a friend opens an action menu
  (open chat / copy ID / mark as read / delete). Deleting needs a second
  confirmation, so a stray right-click can never wipe a friend and its history.
- **PeerJS connectivity** — two DSH Web tabs (or two machines) exchange
  messages directly over the PeerJS cloud signaling server.
- **Discovery by string ID** — share your peer ID and add a friend by typing
  theirs.
- **Discovery by QR code** — render your peer ID as a QR code for another
  device to scan; accept an incoming connection.
- **Unread-count badges** — each friend row shows the number of unread messages.
- **Night-mode compatible** — the UI styles use `--dsw-alias-*` design tokens,
  so it adapts to the active DSH theme (light/dark).
- **Stable peer ID** — the peer ID is persisted in `localStorage` and reused
  across page reloads, so a restart of the DSH Web process does not change it.
- **Agent `pm_send` tool** — a `Peer Chat` agent preset exposes `pm_send`
  (queue a P2P message to a peer), `web_search`, and `web_fetch`, with the
  global tools (`bash`, `fs`, `browser_*`, `plugin_manager`, …) hidden.

## Friend management

Right-click a friend row to open its action menu:

- **打开聊天** — select the friend and jump to the conversation.
- **复制 ID** — copy the friend's peer ID to the clipboard.
- **标记已读** — clear that friend's unread badge (disabled when already read).
- **删除好友…** — opens a confirmation dialog; the friend and its message
  history are only removed after you confirm.

`Escape`, clicking outside, resizing, or scrolling closes the menu without
changing any data; `Escape` or **取消** dismisses the delete dialog. The menu is
anchored at the pointer and clamped to the viewport, so right-clicking near the
bottom-right corner still leaves every menu item clickable.

## Installation

This is a DSH bundle. From a DSH Web profile:

```bash
# add the dependency
npm install --save /path/to/dsh-peer-message
```

Then enable the bundle `dsh-peer-message` and the preset bundle
`dsh-peer-preset` in the DSH plugin manager, or declare the preset's plugin:

```yaml
# dsh-peer-preset/cordis.patch.yml
- insert:
    - id: preset-peer
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: peer
        name: Peer Chat
        description: Web search, web fetch, and P2P chat only.
        order: 20
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a peer-chat assistant with web search and P2P messaging. Use web_search/web_fetch for research, and pm_send to message a friend peer.
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: peer-tool
            name: 'file:///abs/path/dsh-peer-message/tool.js?rev=1'
```

## How it works

```
 agent (pm_send)          client poll (600ms)          PeerJS
  ┌──────────┐  push  ┌──────────────────┐  GET   ┌────────────┐
  │ tool.js  ├───────►│ /api/pm-outbox   ├───────►│  outbox.js │
  └──────────┘        │ (Host index.js)  │        └─────┬──────┘
                      └──────────────────┘              │ deliver over PeerJS
                                                        ▼
                                                friend's DSH Web tab
```

- `tool.js` (preset plugin) registers the `pm_send` tool. When an agent calls
  it, the message is pushed into the shared `outbox.js` queue.
- `index.js` (Host plugin) registers the `GET/POST /api/pm-outbox` fetch route.
  The client polls it every 600 ms to drain queued messages and re-queue any
  delivery failure.
- `client.js` (client plugin) owns the chat panel UI, PeerJS connectivity, and
  localStorage persistence.

The fetch route lives in the Host plugin (not the preset) because a fetch route
is process-global; keeping it in the preset would orphan it across preset HMR
reloads.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host plugin — registers `/api/pm-outbox` fetch route |
| `tool.js` | Preset plugin — `pm_send` tool + tool-surface restriction |
| `client.js` | Client plugin — chat panel UI, PeerJS, persistence |
| `outbox.js` | Shared outbound queue module |
| `validate.js` | Shared peer-ID / text validation and sanitization |
| `locale/en.json`, `locale/zh.json` | UI strings |
| `cordis.patch.yml` | Bundle patch (declares the `peer-message` Host row) |

## Development

```bash
npm test   # runs test/*.test.js
```

## License

MIT
