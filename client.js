window.__ModuleLoader__.load({
  id: 'dsh-peer-message',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ── PeerJS / QR 库动态加载 ──────────────────────────────────────────
    const PEERJS_CDN = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
    const QRCODE_CDN = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

    let peerjsPromise = null;
    let qrcodePromise = null;

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('failed to load ' + src));
        document.head.appendChild(s);
      });
    }

    function loadPeerJS() {
      if (!peerjsPromise) {
        peerjsPromise = loadScript(PEERJS_CDN).then(() => window.Peer || window.peerjs?.Peer);
      }
      return peerjsPromise;
    }

    function loadQRCode() {
      if (!qrcodePromise) {
        qrcodePromise = loadScript(QRCODE_CDN).then(() => window.qrcode);
      }
      return qrcodePromise;
    }

    // ── 常量与状态 ──────────────────────────────────────────────────────
    const PANEL_ID = 'peer-message';
    const STORAGE_KEY = 'dsh-peer-message-state-v1';

    // ── 安全边界（攻防加固） ────────────────────────────────────────────
    // 最大单条文本长度；超过则截断，防止超大 payload 撑爆内存/渲染。
    const MAX_TEXT_LEN = 4096;
    // 合法 peer id 前缀；不符合的入站/出站 id 直接拒绝。
    const PEER_ID_PREFIX = 'dsh-pm-';
    // 合法 peer id 最小/最大长度。真实 id 形如 dsh-pm-<8rand>-<6ts> ≈ 24 字符，
    // 因此下限取 16（大于前缀 dsh-pm- 的 7 字符），防止 7 字符纯前缀误通过。
    const PEER_ID_MIN_LEN = 16;
    const PEER_ID_MAX_LEN = 64;
    // 攻防加固：资源上限，防恶意洪泛撑爆 localStorage/内存。
    const MAX_MSGS_PER_FRIEND = 500;   // 每好友消息历史上限
    const MAX_FRIENDS = 100;           // 好友数上限
    const MAX_NAME_LEN = 32;           // hello 握手昵称长度上限
    const MAX_DELIVERY_TRIES = 10;     // agent 队列投递重试上限（防无限回环）

    // ── 后台运行开关（随主 state 持久化，面板关闭也生效） ────────────────
    const DEFAULT_SETTINGS = { allowBroadcast: false, allowIncoming: true };

    // ── 自动回复配置（随 settings 持久化；Host 侧 reply-core.js 会再校验一次） ──
    const DEFAULT_REPLY = {
      mode: 'off',              // off | manual | auto
      permission: 'read',       // deny-all | read | write | readwrite | auto
      provider: '',             // 空 = 会话/部署默认 endpoint
      model: '',
      reasoningEffort: '',
      sessionMode: 'dedicated', // dedicated = 每个好友独立会话；existing = 指定会话
      sessionId: '',
      cwd: '',                  // 空 = Host 进程 cwd
    };
    const REPLY_MODES = ['off', 'manual', 'auto'];
    const PERMISSION_MODES = ['deny-all', 'read', 'write', 'readwrite', 'auto'];
    const AUTO_REPLY_PREFIX = '[自动回复] ';
    const REPLY_MODE_LABELS = { off: '关闭', manual: '手动批准', auto: '全自动' };
    const REPLY_PERMISSION_LABELS = {
      'deny-all': '全不允许（禁用所有工具）',
      read: '只读',
      write: '只写',
      readwrite: '读写（限定工作路径）',
      auto: '全自动（全盘读写 + 免审批）',
    };

    function coerceReplyConfig(raw) {
      const d = DEFAULT_REPLY;
      const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
      return {
        mode: REPLY_MODES.includes(r.mode) ? r.mode : d.mode,
        permission: PERMISSION_MODES.includes(r.permission) ? r.permission : d.permission,
        provider: str(r.provider, 120),
        model: str(r.model, 160),
        reasoningEffort: str(r.reasoningEffort, 60),
        sessionMode: r.sessionMode === 'existing' ? 'existing' : 'dedicated',
        sessionId: str(r.sessionId, 200),
        cwd: str(r.cwd, 500),
      };
    }

    // 默认 PeerJS 云服务器；可通过 config 覆盖
    const DEFAULT_PEER_CONFIG = {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    };

    // ── 持久化 ──────────────────────────────────────────────────────────
    // 主 state：{ friends, messages, settings }。settings 是后台运行开关
    // （广播/接收新连接），随 state 一起持久化——面板关闭、页面重启都不丢。
    function coerceSettings(raw) {
      const d = DEFAULT_SETTINGS;
      return {
        allowBroadcast: raw && typeof raw.allowBroadcast === 'boolean' ? raw.allowBroadcast : d.allowBroadcast,
        allowIncoming: raw && typeof raw.allowIncoming === 'boolean' ? raw.allowIncoming : d.allowIncoming,
        reply: coerceReplyConfig(raw && raw.reply),
      };
    }

    function loadState() {
      let st = { friends: [], messages: {} };
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) st = JSON.parse(raw) || st;
      } catch (e) { /* ignore */ }
      if (!Array.isArray(st.friends)) st.friends = [];
      if (!st.messages || typeof st.messages !== 'object') st.messages = {};
      // 迁移：旧版开关存独立 key（dsh-peer-message-settings-v1），并入主 state 后清掉
      let migrated = null;
      try {
        const raw = localStorage.getItem('dsh-peer-message-settings-v1');
        if (raw) { migrated = JSON.parse(raw); localStorage.removeItem('dsh-peer-message-settings-v1'); }
      } catch (e) { /* ignore */ }
      st.settings = coerceSettings(migrated || st.settings);
      return st;
    }

    function saveState(state) {
      try {
        // 只持久化 friends/messages/settings 三个白名单字段，其余内存态丢弃
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          friends: state.friends,
          messages: state.messages,
          settings: state.settings,
        }));
      } catch (e) { /* ignore */ }
    }

    // 固定 Peer ID：首次生成后存入 localStorage，跨页面刷新/重启不变
    const PEER_ID_KEY = 'dsh-peer-message-peer-id-v1';
    function getStablePeerId() {
      let id = null;
      try { id = localStorage.getItem(PEER_ID_KEY); } catch (e) { /* ignore */ }
      if (!id) {
        id = 'dsh-pm-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
        try { localStorage.setItem(PEER_ID_KEY, id); } catch (e) { /* ignore */ }
      }
      return id;
    }

    // 把一条投递失败的消息放回 host 队列（POST 回 /api/pm-outbox）
    function outboxPush(item) {
      try {
        fetch('/api/pm-outbox', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ item }),
        }).catch(() => { /* 静默 */ });
      } catch (e) { /* 静默 */ }
    }

    // ── CSS 样式（仿 QQ/微信，使用主题 token） ──────────────────────────
    const CSS = [
      '.pm-root{display:flex;height:100%;width:100%;overflow:hidden;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.5;}',
      // 统一 border-box：输入框 width:100%/flex:1 含内边距与边框，防止内容溢出撑宽。
      '.pm-root,.pm-root *{box-sizing:border-box;}',

      // 左侧好友列表
      '.pm-sidebar{width:280px;min-width:280px;border-right:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,transparent);}',
      '.pm-sidebar-header{padding:16px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));}',
      '.pm-my-id{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));}',
      '.pm-my-id-label{font-size:10px;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;}',
      '.pm-my-id-value{font-family:monospace;font-size:11px;color:var(--dsw-alias-brand-primary,inherit);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;border-radius:6px;font-size:14px;transition:background .15s,color .15s;}',
      '.pm-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));color:var(--dsw-alias-label-primary,inherit);}',
      '.pm-status-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
      '.pm-status-on{background:var(--dsw-alias-state-success-primary,#22c55e);}',
      '.pm-status-off{background:var(--dsw-alias-state-idle-primary,rgba(127,127,127,.5));}',

      '.pm-search{padding:8px 12px;}',
      '.pm-search-input{width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,transparent));color:var(--dsw-alias-label-primary,inherit);font-size:12px;outline:none;}',
      '.pm-search-input:focus{border-color:var(--dsw-alias-brand-primary,inherit);}',

      '.pm-friend-list{flex:1;overflow-y:auto;padding:4px;}',
      '.pm-friend-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;transition:background .15s;}',
      '.pm-friend-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}',
      '.pm-friend-item.active{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.15));}',
      '.pm-avatar{width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:600;color:#111;flex:none;font-size:16px;}',
      '.pm-friend-info{flex:1;min-width:0;}',
      '.pm-friend-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-friend-last{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-unread{min-width:18px;height:18px;border-radius:9px;background:var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 5px;flex:none;}',

      // 好友右键菜单：右键只打开菜单，删除必须走菜单 + 二次确认，防误删。
      '.pm-ctx-backdrop{position:fixed;inset:0;z-index:1499;background:transparent;}',
      '.pm-ctx-menu{position:fixed;z-index:1500;min-width:190px;max-width:260px;padding:6px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));box-shadow:0 8px 24px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-primary,inherit);}',
      '.pm-ctx-title{padding:4px 10px 3px;font-size:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-ctx-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-family:inherit;text-align:left;cursor:pointer;}',
      '.pm-ctx-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}',
      '.pm-ctx-item.danger{color:var(--dsw-alias-state-error-primary,#ef4444);}',
      '.pm-ctx-item:disabled{opacity:.45;cursor:not-allowed;}',
      '.pm-ctx-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.15));}',
      '.pm-confirm-text{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,inherit);text-align:center;}',
      '.pm-confirm-target{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);text-align:center;word-break:break-all;}',
      '.pm-btn.danger{background:var(--dsw-alias-state-error-primary,#ef4444);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.pm-btn.danger:hover{opacity:.9;}',

      '.pm-add-friend{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));}',
      '@media (max-width: 760px){.pm-sidebar{width:230px;min-width:230px;}.pm-sidebar-header{padding:12px 10px 10px;}.pm-chat-header{padding:10px 14px;}.pm-chat-messages{padding:14px;}.pm-chat-input{padding:10px 14px;}.pm-msg{max-width:82%;}}',
      '@media (max-width: 560px){.pm-sidebar{width:196px;min-width:196px;}.pm-my-id-label{display:none;}.pm-toast{left:16px;right:16px;transform:none;}}',
      '.pm-add-input{flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,transparent));color:var(--dsw-alias-label-primary,inherit);font-size:12px;outline:none;}',
      '.pm-add-btn{padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b82f6));color:var(--dsw-alias-label-primary-foreground,#fff);font-size:12px;font-weight:500;cursor:pointer;}',
      '.pm-add-btn:hover{opacity:.9;}',
      '.pm-add-btn:disabled{opacity:.5;cursor:not-allowed;}',

      // 右侧聊天区
      '.pm-chat{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--dsw-alias-bg-base,transparent);}',
      '.pm-chat-header{padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));display:flex;align-items:center;gap:10px;}',
      '.pm-chat-header-info{flex:1;min-width:0;}',
      '.pm-chat-header-name{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-chat-header-status{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-chat-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:8px;}',
      '.pm-msg{max-width:70%;padding:8px 12px;border-radius:10px;font-size:13px;word-break:break-word;white-space:pre-wrap;}',
      '.pm-msg-mine{align-self:flex-end;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b82f6));color:var(--dsw-alias-label-primary-foreground,#fff);border-bottom-right-radius:3px;}',
      '.pm-msg-mine .pm-msg-time{color:inherit;opacity:.72;}',
      '.pm-msg-theirs{align-self:flex-start;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit);border-bottom-left-radius:3px;}',
      '.pm-msg-time{font-size:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));margin-top:3px;}',
      '.pm-chat-input{padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));display:flex;gap:8px;align-items:flex-end;}',
      '.pm-chat-textarea{flex:1;min-height:40px;max-height:120px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,transparent));color:var(--dsw-alias-label-primary,inherit);font-size:13px;resize:none;outline:none;font-family:inherit;}',
      '.pm-chat-textarea:focus{border-color:var(--dsw-alias-brand-primary,inherit);}',
      '.pm-send-btn{padding:8px 20px;border-radius:8px;border:none;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b82f6));color:var(--dsw-alias-label-primary-foreground,#fff);font-size:13px;font-weight:500;cursor:pointer;}',
      '.pm-send-btn:hover{opacity:.9;}',
      '.pm-send-btn:disabled{opacity:.5;cursor:not-allowed;}',

      // 空状态
      '.pm-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--dsw-alias-label-secondary,inherit);}',
      '.pm-empty-icon{font-size:48px;opacity:.5;}',
      '.pm-empty-text{font-size:14px;}',
      '.pm-empty-hint{font-size:12px;opacity:.7;text-align:center;max-width:400px;line-height:1.6;word-break:break-word;}',

      // 二维码弹窗
      '.pm-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;}',
      '.pm-modal{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;padding:24px;width:320px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:16px;align-items:center;color:var(--dsw-alias-label-primary,inherit);}',
      '.pm-modal-title{font-size:15px;font-weight:600;padding-right:30px;}',
      '.pm-modal-close{position:absolute;top:10px;right:10px;}',
      // QR 背景/前景跟随主题：浅色=白底黑块，深色=深底浅块（反色），避免深色模式白盒刺眼。
      '.pm-qr-box{padding:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));}',
      '.pm-modal-id{font-family:monospace;font-size:12px;word-break:break-all;text-align:center;color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));padding:8px 12px;border-radius:6px;width:100%;}',
      '.pm-modal-btns{display:flex;gap:8px;width:100%;justify-content:flex-end;}',
      '.pm-btn{padding:6px 16px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:12px;cursor:pointer;flex:0 0 auto;min-width:92px;font-family:inherit;transition:background .15s,opacity .15s;}',
      '.pm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}',
      '.pm-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b82f6));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.pm-btn.primary:hover{opacity:.9;}',

      // 连接状态提示
      '.pm-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));background:var(--dsw-alias-toast-bg,#1f2937);color:var(--dsw-alias-toast-label,#fff);padding:10px 20px;border-radius:8px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:2000;word-break:break-word;}',

      // 加载态
      '.pm-loading{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,inherit);font-size:14px;}',
      '.pm-peer-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;margin-top:4px;}',
      // 后台开关行：紧凑、主题色跟随。
      '.pm-toggle-row{margin-top:8px;}',
      '.pm-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}',
      '.pm-toggle input{accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer;width:15px;height:15px;margin:0;}',
      '.pm-toggle-text{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);}',

      // ── 自动回复：状态条 / 待批准 / 设置弹窗 ──────────────────────────
      '.pm-reply-row{margin-top:8px;display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));font-size:11px;cursor:pointer;}',
      '.pm-reply-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}',
      '.pm-reply-row .pm-reply-dot{width:7px;height:7px;border-radius:50%;flex:none;}',
      '.pm-reply-row-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);}',
      '.pm-reply-count{min-width:16px;height:16px;border-radius:8px;background:var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:9px;font-weight:600;line-height:16px;text-align:center;padding:0 4px;}',
      '.pm-modal-wide{width:480px;max-width:94vw;max-height:86vh;overflow-y:auto;align-items:stretch;}',
      '.pm-field{margin-bottom:12px;}',
      '.pm-field-label{display:block;font-size:11px;color:var(--dsw-alias-label-secondary,inherit);margin-bottom:4px;}',
      '.pm-select,.pm-text-input{width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,transparent));color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-family:inherit;outline:none;}',
      '.pm-select:focus,.pm-text-input:focus{border-color:var(--dsw-alias-brand-primary,inherit);}',
      '.pm-hint{font-size:10px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);margin-top:4px;}',
      '.pm-warn{font-size:10px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#ef4444);margin-top:4px;}',
      '.pm-modal-section-title{font-size:12px;font-weight:600;margin:4px 0 8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));}',
      '.pm-pending-item{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-2,transparent);}',
      '.pm-pending-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:var(--dsw-alias-label-secondary,inherit);}',
      '.pm-pending-text{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:110px;overflow-y:auto;margin:6px 0;color:var(--dsw-alias-label-primary,inherit);}',
      '.pm-pending-btns{display:flex;gap:6px;justify-content:flex-end;}',
      '.pm-btn.small{padding:4px 10px;font-size:11px;flex:none;}',
      '.pm-reply-status-list{max-height:180px;overflow-y:auto;font-size:11px;line-height:1.6;}',
      '.pm-reply-status-row{display:flex;gap:6px;padding:2px 0;color:var(--dsw-alias-label-secondary,inherit);}',
      '.pm-reply-status-ok{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 70%,var(--dsw-alias-label-primary,#000));}',
      '.pm-reply-status-bad{color:var(--dsw-alias-state-error-primary,#ef4444);}',
    ].join('');

    // ── 侧栏未读徽标共享 store ──────────────────────────────────────────
    // Panel 与 sidebar 图标是两棵独立的 React 子树（一个在 main，一个在
    // sidebar.panellist），不能共享 props/state。用模块级发布/订阅把好友
    // 未读总数推给 sidebar 图标：panel 在每次 state 持久化时 publish，
    // 图标 subscribe 后 setState 触发重渲染。
    const pmUnreadStore = {
      total: 0,
      listeners: new Set(),
      publish(total) {
        if (total === this.total) return;
        this.total = total;
        for (const fn of this.listeners) { try { fn(total); } catch (e) { /* ignore */ } }
      },
      subscribe(fn) {
        this.listeners.add(fn);
        // 订阅时立即推送当前值，避免 mount 顺序问题（panel 先 publish 后图标才订阅）
        try { fn(this.total); } catch (e) { /* ignore */ }
        return () => { this.listeners.delete(fn); };
      },
    };

    // 计算好友未读总数（面板内使用）
    function computeUnreadTotal(friends) {
      return (friends || []).reduce((sum, f) => sum + (f.unread || 0), 0);
    }

    // ── 工具函数 ────────────────────────────────────────────────────────
    function avatarColor(id) {
      let hash = 0;
      for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
      const hues = [210, 280, 330, 20, 160, 200, 40, 250];
      // 浅色底 + 深色字：白字在黄/绿系 50% 亮度底上只有 ~2.5 对比度（夜间/日间都难读）。
      // 该组合在 8 个色相上实测最低对比度 ≥ 5.0（CSS 里 .pm-avatar 的 color 固定 #111）。
      return `hsl(${hues[hash % hues.length]}, 55%, 65%)`;
    }

    function shortId(id) {
      if (!id) return '';
      return id.length > 8 ? id.slice(0, 8) : id;
    }

    // 右键菜单定位：把客户端坐标夹到视口内（留 8px 边距），
    // 避免在窗口右/下边缘右键时菜单被裁掉、点不到“删除好友”。
    function clampMenuPosition(x, y, vw, vh, mw, mh) {
      const margin = 8;
      const left = Math.max(margin, Math.min(x, vw - mw - margin));
      const top = Math.max(margin, Math.min(y, vh - mh - margin));
      return { left, top };
    }

    // 校验 peer id 格式：必须带合法前缀、在长度区间内、且只含 base36/连字符
    // （防恶意/伪造 id，阻断 HTML/JS 注入、路径穿越、空格等非法字节）。
    const PEER_ID_BODY_RE = /^[a-z0-9-]+$/;
    function isValidPeerId(id) {
      if (!id || typeof id !== 'string') return false;
      if (!id.startsWith(PEER_ID_PREFIX)) return false;
      const len = id.length;
      if (len < PEER_ID_MIN_LEN || len > PEER_ID_MAX_LEN) return false;
      if (!PEER_ID_BODY_RE.test(id.slice(PEER_ID_PREFIX.length))) return false;
      return true;
    }

    // 清洗入站/出站文本：强制字符串、剥离控制字符、截断到上限（防超大 payload）。
    function sanitizeText(text) {
      if (typeof text !== 'string') return '';
      // eslint-disable-next-line no-control-regex
      const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      return clean.slice(0, MAX_TEXT_LEN);
    }

    // 昵称清洗：非字符串一律拒绝（防恶意对象/数组打崩渲染），字符串清洗并截断。
    function sanitizeName(name) {
      if (typeof name !== 'string') return null;
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
      return clean || null;
    }

    function fmtTime(ts) {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (sameDay) return hm;
      return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
    }

    function copyText(text) {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise((resolve, reject) => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); resolve(); }
        catch (e) { reject(e); }
        document.body.removeChild(ta);
      });
    }

    // ── 模块级后台服务 ──────────────────────────────────────────────────
    // 核心修正：PeerJS 加载、Peer 实例、连接监听、入站消息、agent 队列轮询
    // 全部在模块级单例里，apply() 时即启动——不依赖消息面板是否打开。
    // 面板只是订阅服务快照的视图；面板不打开也照样收消息、投递 agent 消息。
    const pmService = {
      state: loadState(),          // {friends, messages}，每次变更同步 localStorage
      myId: '',                    // 本端 PeerJS id（peer open 后回填）
      peerStatus: 'connecting',    // connecting | online | offline | error | closed
      peerError: '',
      conns: {},                   // id -> DataConnection
      peer: null,
      pollTimer: null,
      reconnectTimer: null,
      polling: false,
      // 自动回复（后台）：pending/running/recent 是 Host 侧内存态，面板只是视图。
      replyCatalog: null,
      replyPending: [],
      replyRunning: [],
      replyRecent: [],
      replyUnavailable: false,
      replyPollTimer: null,
      replyPolling: false,
      replyLastRecentId: '',
      started: false,
      version: 0,
      _snap: null,
      listeners: new Set(),
      toast: '',
      toastTimer: null,

      // settings 派生自 state（loadState/saveState 持久化）：
      // 开关写入走 update() → saveState，与好友/消息同一条持久化路径。
      get settings() {
        return this.state.settings || coerceSettings(null);
      },

      // ── 订阅协议（useSyncExternalStore） ─────────────────────────────
      subscribe(fn) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
      },
      getSnapshot() {
        if (!this._snap) {
          this._snap = {
            state: this.state,
            myId: this.myId,
            peerStatus: this.peerStatus,
            peerError: this.peerError,
            toast: this.toast,
            settings: this.settings,
            reply: this.settings.reply,
            replyCatalog: this.replyCatalog,
            replyPending: this.replyPending,
            replyRunning: this.replyRunning,
            replyRecent: this.replyRecent,
            replyUnavailable: this.replyUnavailable,
            version: this.version,
          };
        }
        return this._snap;
      },
      emit() {
        this.version++;
        this._snap = null;
        for (const fn of this.listeners) { try { fn(); } catch (e) { /* ignore */ } }
      },

      showToast(msg) {
        this.toast = msg;
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => { this.toast = ''; this.emit(); }, 2500);
        this.emit();
      },

      // state 变更唯一入口：写 localStorage + 推未读徽标 + 广播。
      // 攻防加固：写前强制好友数/每好友消息数上限，防恶意洪泛撑爆存储。
      update(mutator) {
        const prev = this.state;
        const next = mutator(prev);
        if (next === prev) return;
        if (Array.isArray(next.friends) && next.friends.length > MAX_FRIENDS) {
          next.friends = next.friends.slice(-MAX_FRIENDS);
        }
        if (next.messages) {
          let messages = next.messages;
          for (const id of Object.keys(messages)) {
            const msgs = messages[id];
            if (Array.isArray(msgs) && msgs.length > MAX_MSGS_PER_FRIEND) {
              messages = Object.assign({}, messages);
              messages[id] = msgs.slice(-MAX_MSGS_PER_FRIEND);
            }
          }
          next.messages = messages;
        }
        this.state = next;
        saveState(next);
        pmUnreadStore.publish(computeUnreadTotal(next.friends));
        this.emit();
      },

      // ── 生命周期 ─────────────────────────────────────────────────────
      start() {
        if (this.started) return;
        this.started = true;
        // 侧栏徽标初值（后台服务启动即发布，不等面板挂载）。
        pmUnreadStore.publish(computeUnreadTotal(this.state.friends));
        this.emit();
        loadPeerJS().then(() => this.initPeer()).catch(err => {
          this.peerStatus = 'error';
          this.peerError = 'PeerJS 加载失败: ' + String(err && err.message || err);
          this.emit();
        });
        // agent 队列轮询：面板不打开也照常排水投递（消息要跑在后台）。
        this.pollTimer = setInterval(() => this.drainOutbox(), 1000);
        // 自动回复状态轮询：待批准请求 / 正在回复 / 最近结果（面板不打开也跑）。
        this.replyPollTimer = setInterval(() => this.pollReplies(), 2500);
        this.pollReplies();
        // 慢速后台重连：每 30s 重试不在线的好友。
        this.reconnectTimer = setInterval(() => {
          if (this.peer && this.peer.open) this.reconnectAll();
        }, 30000);
      },

      stop() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.replyPollTimer) { clearInterval(this.replyPollTimer); this.replyPollTimer = null; }
        this.replyPending = [];
        this.replyRunning = [];
        this.replyRecent = [];
        if (this.reconnectTimer) { clearInterval(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.reconnectTimer2) { clearTimeout(this.reconnectTimer2); this.reconnectTimer2 = null; }
        for (const id of Object.keys(this.conns)) {
          try { this.conns[id].close(); } catch (e) { /* ignore */ }
        }
        this.conns = {};
        if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } }
        this.peer = null;
        this.myId = '';
        this.peerStatus = 'connecting';
        this.peerError = '';
        this.toast = '';
        this.started = false;
        this._snap = null;
        this.emit();
      },

      initPeer() {
        if (!this.started) return;
        let peer = null;
        try {
          peer = new window.Peer(getStablePeerId(), DEFAULT_PEER_CONFIG);
        } catch (err) {
          this.peerStatus = 'error';
          this.peerError = String(err && err.message || err);
          this.emit();
          return;
        }
        this.peer = peer;

        peer.on('open', (id) => {
          this.myId = id;
          this.peerStatus = 'online';
          this.peerError = '';
          this.reconnectAttempts = 0; // 重连成功，清零退避计数
          this.conns = {};
          this.emit();
          // 上线即主动连接所有已知好友（后台自动重连）。
          this.reconnectAll();
          this.drainOutbox();
        });

        peer.on('connection', (conn) => {
          this.handleIncomingConn(conn);
        });

        peer.on('error', (err) => {
          const type = err && err.type;
          if (type === 'unavailable-id') {
            this.peerStatus = 'error';
            this.peerError = 'ID 被占用，请刷新页面重试';
            this.emit();
          } else if (type === 'network' || type === 'server-error') {
            this.peerStatus = 'error';
            this.peerError = '信令服务器连接失败：' + (err && err.message || type);
            this.emit();
            this.scheduleReconnect();
          } else if (type === 'peer-unavailable') {
            // 目标不在线：清理进行中的连接记录，让下轮重连可重试。
            for (const id of Object.keys(this.conns)) {
              if (!this.conns[id].open) delete this.conns[id];
            }
            this.emit();
          } else if (type === 'disconnected') {
            this.peerStatus = 'offline';
            this.peerError = '';
            this.emit();
            this.scheduleReconnect();
          } else {
            this.peerError = type || String(err && err.message || err);
            this.emit();
          }
        });

        peer.on('close', () => {
          this.peerStatus = 'closed';
          this.emit();
          this.scheduleReconnect();
        });
      },

      // 信令断线自动重连（后台自愈）：指数退避 2s→30s，最多 5 次；
      // 成功 open 或手动 stop 后清零。面板不打开也要能自己恢复。
      scheduleReconnect() {
        if (!this.started) return;
        this.reconnectAttempts = this.reconnectAttempts || 0;
        if (this.reconnectAttempts >= 5) {
          this.peerError = this.peerError || '信令连接已断开，打开消息面板或刷新页面重试';
          this.emit();
          return;
        }
        const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        if (this.reconnectTimer2) clearTimeout(this.reconnectTimer2);
        this.reconnectTimer2 = setTimeout(() => {
          this.reconnectTimer2 = null;
          if (!this.started) return;
          if (this.peer && this.peer.open) { this.reconnectAttempts = 0; return; }
          try { if (this.peer && !this.peer.destroyed) this.peer.destroy(); } catch (e) { /* ignore */ }
          this.peer = null;
          this.peerStatus = 'connecting';
          this.emit();
          this.initPeer();
        }, delay);
      },

      // 入站连接：id 合法性 + 接收开关 + 白名单/广播开关（面板不打开也照常处理）。
      handleIncomingConn(conn) {
        const remoteId = conn.peer;
        // 攻防加固：入站 id 必须合法格式，否则直接关闭。
        if (!isValidPeerId(remoteId)) {
          try { conn.close(); } catch (e) { /* ignore */ }
          return;
        }
        // 总闸：不接收新连接时一律拒绝（已建立连接不受影响）。
        if (!this.settings.allowIncoming) {
          this.showToast('已拒收新连接「' + shortId(remoteId) + '」');
          try { conn.close(); } catch (e) { /* ignore */ }
          return;
        }
        // 白名单/广播：非好友时，仅在开启广播的情况下自动加为好友。
        if (!this.settings.allowBroadcast && !this.state.friends.some(f => f.id === remoteId)) {
          this.showToast('拒绝陌生连接「' + shortId(remoteId) + '」');
          try { conn.close(); } catch (e) { /* ignore */ }
          return;
        }
        conn.on('open', () => {
          this.conns[remoteId] = conn;
          this.update(prev => {
            const friends = prev.friends.slice();
            const idx = friends.findIndex(f => f.id === remoteId);
            if (idx >= 0) friends[idx] = Object.assign({}, friends[idx], { online: true });
            else friends.push({ id: remoteId, name: shortId(remoteId), online: true, unread: 0, lastMsg: '', lastTs: Date.now() });
            return Object.assign({}, prev, { friends });
          });
          this.showToast('「' + shortId(remoteId) + '」已连接');
        });
        conn.on('data', (data) => this.handleData(remoteId, data));
        conn.on('close', () => this.handleClose(remoteId));
        conn.on('error', () => this.handleClose(remoteId));
      },

      // 开关写入入口：走 update()（saveState 持久化 + 推未读徽标 + 广播快照）。
      setAllowBroadcast(on) {
        const next = !!on;
        this.update(prev => Object.assign({}, prev, {
          settings: Object.assign({}, prev.settings || coerceSettings(null), { allowBroadcast: next }),
        }));
        this.showToast(next ? '已开启广播：陌生 peer 可发现并加你为好友' : '已关闭广播');
      },
      setAllowIncoming(on) {
        const next = !!on;
        this.update(prev => Object.assign({}, prev, {
          settings: Object.assign({}, prev.settings || coerceSettings(null), { allowIncoming: next }),
        }));
        this.showToast(next ? '已开启接收新连接' : '已关闭接收新连接：已建立连接不受影响');
      },

      // 入站数据：文本消息清洗 + hello 握手昵称清洗。
      handleData(remoteId, data) {
        if (typeof data === 'string') {
          // 攻防加固：清洗并截断入站文本（防超大 payload / 控制字符注入）。
          const text = sanitizeText(data);
          if (!text) return; // 空或全控制字符 → 丢弃
          this.update(prev => {
            const idx = prev.friends.findIndex(f => f.id === remoteId);
            if (idx < 0) return prev; // 非好友（或已删除）：丢弃
            const friends = prev.friends.slice();
            friends[idx] = Object.assign({}, friends[idx], {
              lastMsg: text, lastTs: Date.now(),
              unread: (friends[idx].unread || 0) + 1, online: true,
            });
            const msgs = (prev.messages[remoteId] || []).concat([{ from: 'them', text, ts: Date.now() }]);
            const messages = Object.assign({}, prev.messages);
            messages[remoteId] = msgs;
            return Object.assign({}, prev, { friends, messages });
          });
          // 好友文本入站 → 交给 Host 回调管线（关闭/全不允许等策略在 Host 再校验）。
          if (this.state.friends.some(f => f.id === remoteId)) this.maybeRequestReply(remoteId, text);
        } else if (data && typeof data === 'object') {
          if (data.type === 'hello') {
            // 攻防加固：昵称非字符串/空 → 丢弃，绝不写进 state（防对象打崩渲染）。
            const name = sanitizeName(data.name);
            if (!name) return;
            this.update(prev => {
              const idx = prev.friends.findIndex(f => f.id === remoteId);
              if (idx < 0) return prev;
              const friends = prev.friends.slice();
              friends[idx] = Object.assign({}, friends[idx], { name });
              return Object.assign({}, prev, { friends });
            });
          }
        }
      },

      handleClose(remoteId) {
        delete this.conns[remoteId];
        this.update(prev => {
          if (!prev.friends.some(f => f.id === remoteId && f.online)) return prev;
          const friends = prev.friends.map(f => f.id === remoteId ? Object.assign({}, f, { online: false }) : f);
          return Object.assign({}, prev, { friends });
        });
      },

      // 上线后重连所有好友（后台自动连接，不需要打开面板）。
      reconnectAll() {
        for (const f of this.state.friends) {
          if (!isValidPeerId(f.id)) continue;
          if (this.conns[f.id]) continue; // 已连接或连接中
          this.connectTo(f.id, { silent: true });
        }
      },

      connectTo(id, opts) {
        opts = opts || {};
        const peer = this.peer;
        if (!peer || !peer.open) return false;
        if (this.conns[id]) return !!this.conns[id].open; // 进行中或已连上
        const conn = peer.connect(id, { reliable: true });
        this.conns[id] = conn;
        conn.on('open', () => {
          this.update(prev => {
            const friends = prev.friends.map(f => f.id === id ? Object.assign({}, f, { online: true }) : f);
            return Object.assign({}, prev, { friends });
          });
          try { conn.send({ type: 'hello', name: '我' }); } catch (e) { /* ignore */ }
          if (!opts.silent) this.showToast('已连接「' + shortId(id) + '」');
        });
        conn.on('data', (data) => this.handleData(id, data));
        conn.on('close', () => this.handleClose(id));
        conn.on('error', () => this.handleClose(id));
        return true;
      },

      ensureFriend(id) {
        if (this.state.friends.some(f => f.id === id)) return;
        this.update(prev => {
          if (prev.friends.some(f => f.id === id)) return prev;
          const friends = prev.friends.concat([{ id, name: shortId(id), online: false, unread: 0, lastMsg: '', lastTs: Date.now() }]);
          return Object.assign({}, prev, { friends });
        });
      },

      // agent 队列排水：从 host 取回 pm_send 排队的消息并投递。
      // 面板不打开也照常运行（这就是“消息要跑在后台”的核心）。
      async drainOutbox() {
        if (this.polling) return;
        if (!this.peer || !this.peer.open) return; // peer 未就绪：留在 host 队列，不丢
        this.polling = true;
        try {
          const res = await fetch('/api/pm-outbox', { method: 'GET' });
          if (res.ok) {
            const data = await res.json();
            const items = Array.isArray(data && data.items) ? data.items : [];
            for (const item of items) await this.deliverQueued(item);
          }
        } catch (e) { /* 静默：轮询失败下次重试 */ }
        this.polling = false;
      },

      async deliverQueued(item) {
        const target = item && item.to;
        // 攻防加固：host 队列可能被任意本地进程写入，投递前必须校验。
        if (!target || !isValidPeerId(target)) return; // 恶意/畸形 id：丢弃
        const safeText = sanitizeText(item.text);
        if (!safeText) return;
        const tries = ((item.tries || 0) + 1);
        this.ensureFriend(target); // agent 可向任意合法 id 发消息
        const conn = this.conns[target];
        if (!conn || !conn.open) {
          this.connectTo(target, { silent: true });
          // 对方不在线：放回队列（带上重试计数），超过上限则放弃。
          if (tries < MAX_DELIVERY_TRIES) outboxPush(Object.assign({}, item, { text: safeText, tries }));
          else this.showToast('P2P 消息多次投递失败，已放弃');
          return;
        }
        try {
          conn.send(safeText);
        } catch (e) {
          if (tries < MAX_DELIVERY_TRIES) outboxPush(Object.assign({}, item, { text: safeText, tries }));
          else this.showToast('P2P 消息多次投递失败，已放弃');
          return;
        }
        this.update(prev => {
          const msgs = (prev.messages[target] || []).concat([{ from: 'me', text: safeText, ts: Date.now() }]);
          const friends = prev.friends.map(f => f.id === target ? Object.assign({}, f, { lastMsg: safeText, lastTs: Date.now() }) : f);
          const messages = Object.assign({}, prev.messages);
          messages[target] = msgs;
          return Object.assign({}, prev, { friends, messages });
        });
        this.showToast('已投递 agent 消息');
      },

      // ── 自动回复（Host 回气管线） ─────────────────────────────────────
      // 入站消息只是触发 Host 侧 agent；权限/模型/会话/工作路径全部由 Host
      // 按下面持久化的 settings.reply 校验并执行，浏览器不直接跑任何工具。
      setReplyConfig(patch) {
        const next = coerceReplyConfig(Object.assign({}, this.settings.reply, patch || {}));
        this.update(prev => Object.assign({}, prev, {
          settings: Object.assign({}, prev.settings || coerceSettings(null), { reply: next }),
        }));
        return next;
      },

      // 打开设置弹窗时才拉 catalog（endpoint/模型、会话列表、workspace 列表）。
      async loadReplyCatalog(force) {
        if (this.replyCatalog && !force) return this.replyCatalog;
        try {
          const res = await fetch('/api/pm-reply/catalog', { headers: { 'cache-control': 'no-cache' } });
          if (!res.ok) { this.replyUnavailable = true; this.emit(); return null; }
          const data = await res.json();
          if (!data || data.ok === false) { this.replyUnavailable = true; this.emit(); return null; }
          this.replyCatalog = data;
          this.replyUnavailable = false;
          this.emit();
          return data;
        } catch (e) {
          this.replyUnavailable = true;
          this.emit();
          return null;
        }
      },

      async pollReplies() {
        if (this.replyPolling) return;
        this.replyPolling = true;
        try {
          const res = await fetch('/api/pm-reply/requests', { headers: { 'cache-control': 'no-cache' } });
          if (res.ok) {
            const data = await res.json();
            if (data && data.ok !== false) {
              const pending = Array.isArray(data.pending) ? data.pending : [];
              const running = Array.isArray(data.running) ? data.running : [];
              const recent = Array.isArray(data.recent) ? data.recent : [];
              this.replyPending = pending;
              this.replyRunning = running;
              this.replyRecent = recent;
              this.replyUnavailable = false;
              const latest = recent[0];
              if (latest && latest.id !== this.replyLastRecentId) {
                this.replyLastRecentId = latest.id;
                if (latest.status === 'failed') this.showToast('自动回复失败：' + (latest.error || '未知错误'));
                else if (latest.status === 'sent') this.showToast('自动回复已投递');
              }
              this.emit();
            }
          } else if (res.status === 503) {
            this.replyUnavailable = true;
            this.emit();
          }
        } catch (e) { /* 静默：下次轮询重试 */ }
        this.replyPolling = false;
      },

      async approveReply(id) {
        try {
          const res = await fetch('/api/pm-reply/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok) this.showToast('已批准，开始生成回复');
          else this.showToast('批准失败：' + (data.error || ('HTTP ' + res.status)));
        } catch (e) {
          this.showToast('批准失败：无法连接 Host');
        }
        this.pollReplies();
      },

      async rejectReply(id) {
        try {
          const res = await fetch('/api/pm-reply/reject', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok) this.showToast('已忽略该条回复请求');
          else this.showToast('忽略失败：' + (data.error || ('HTTP ' + res.status)));
        } catch (e) {
          this.showToast('忽略失败：无法连接 Host');
        }
        this.pollReplies();
      },

      // 入站文本 → Host 回调管线；关闭、空文本、自动回复标记（防死循环）直接跳过。
      maybeRequestReply(peerId, text) {
        const reply = this.settings.reply || DEFAULT_REPLY;
        if (reply.mode === 'off') return;
        const clean = typeof text === 'string' ? text.trim() : '';
        if (!clean) return;
        if (clean.startsWith(AUTO_REPLY_PREFIX)) return; // 对方也是自动回复：不再回调，避免互刷
        const friend = this.state.friends.find(f => f.id === peerId);
        fetch('/api/pm-reply/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            peerId,
            peerName: friend ? friend.name : '',
            text: clean,
            config: reply,
          }),
        }).then(res => res.json().catch(() => ({}))).then(data => {
          if (data && data.accepted === true) {
            if (data.mode === 'manual') this.showToast('收到一条待批准的自动回复请求');
            this.pollReplies();
          } else if (data && data.reason === 'reply-service-unavailable') {
            this.replyUnavailable = true;
            this.emit();
          }
        }).catch(() => { /* 静默：不阻塞聊天 */ });
      },

      // ── 面板调用的操作 ───────────────────────────────────────────────
      addFriend(targetId) {
        const id = (targetId || '').trim();
        if (!id) return;
        if (!isValidPeerId(id)) {
          this.showToast('ID 格式不合法（需以 ' + PEER_ID_PREFIX + ' 开头）');
          return;
        }
        if (id === this.myId) {
          this.showToast('不能添加自己');
          return;
        }
        this.ensureFriend(id);
        this.connectTo(id);
      },

      removeFriend(id) {
        const conn = this.conns[id];
        if (conn) { try { conn.close(); } catch (e) { /* ignore */ } }
        delete this.conns[id];
        this.update(prev => {
          const friends = prev.friends.filter(f => f.id !== id);
          const messages = Object.assign({}, prev.messages);
          delete messages[id];
          return { friends, messages };
        });
      },

      sendMessage(id, draft) {
        const text = sanitizeText(draft);
        if (!text || !id) return false;
        const conn = this.conns[id];
        if (!conn || !conn.open) { this.showToast('对方不在线，消息无法送达'); return false; }
        try {
          conn.send(text);
        } catch (e) {
          this.showToast('发送失败');
          return false;
        }
        this.update(prev => {
          const msgs = (prev.messages[id] || []).concat([{ from: 'me', text, ts: Date.now() }]);
          const friends = prev.friends.map(f => f.id === id ? Object.assign({}, f, { lastMsg: text, lastTs: Date.now() }) : f);
          const messages = Object.assign({}, prev.messages);
          messages[id] = msgs;
          return Object.assign({}, prev, { friends, messages });
        });
        return true;
      },

      markRead(id) {
        this.update(prev => {
          if (!prev.friends.some(f => f.id === id && (f.unread || 0) > 0)) return prev;
          const friends = prev.friends.map(f => f.id === id ? Object.assign({}, f, { unread: 0 }) : f);
          return Object.assign({}, prev, { friends });
        });
      },
    };

    // 攻防演练/调试钩子：从浏览器控制台可直接检查后台服务状态。
    window.__DSH_PM_SERVICE__ = pmService;

    // ── React 订阅 hook ────────────────────────────────────────────────
    function usePmService() {
      if (React.useSyncExternalStore) {
        return React.useSyncExternalStore(
          (cb) => pmService.subscribe(cb),
          () => pmService.getSnapshot(),
        );
      }
      // 旧版 React 兜底
      const [snap, setSnap] = React.useState(() => pmService.getSnapshot());
      React.useEffect(() => pmService.subscribe(() => setSnap(pmService.getSnapshot())), []);
      return snap;
    }

    // ── 二维码渲染组件 ──────────────────────────────────────────────────
    function QRCodeView({ value }) {
      const [svg, setSvg] = React.useState('');
      React.useEffect(() => {
        let cancelled = false;
        loadQRCode().then(qrcode => {
          if (cancelled || !qrcode || !value) return;
          const qr = qrcode(0, 'M');
          qr.addData(value || '');
          qr.make();
          const cellSize = 4;
          const count = qr.getModuleCount();
          let svgStr = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (count * cellSize) + '" height="' + (count * cellSize) + '" viewBox="0 0 ' + count + ' ' + count + '" shape-rendering="crispEdges">';
          for (let r = 0; r < count; r++) {
            for (let c = 0; c < count; c++) {
              if (qr.isDark(r, c)) svgStr += '<rect x="' + c + '" y="' + r + '" width="1" height="1" fill="currentColor"/>';
            }
          }
          svgStr += '</svg>';
          setSvg(svgStr);
        }).catch(() => setSvg(''));
        return () => { cancelled = true; };
      }, [value]);
      return h('div', { className: 'pm-qr-box', dangerouslySetInnerHTML: { __html: svg || '<div style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;color:inherit;opacity:.6;font-size:12px">加载中…</div>' } });
    }

    // ── 自动回复设置弹窗 ───────────────────────────────────────────────
    function ReplySettingsModal({ initial, catalog, unavailable, onClose }) {
      const [draft, setDraft] = React.useState(() => coerceReplyConfig(initial));
      React.useEffect(() => {
        pmService.loadReplyCatalog(false).catch(() => {});
      }, []);
      const groups = catalog && catalog.models && Array.isArray(catalog.models.groups) ? catalog.models.groups : [];
      const selectedGroup = groups.find(g => g.id === draft.provider) || null;
      const models = selectedGroup && Array.isArray(selectedGroup.models) ? selectedGroup.models : [];
      const modelInfo = models.find(m => m.id === draft.model) || null;
      const efforts = modelInfo && modelInfo.reasoning && Array.isArray(modelInfo.reasoning.efforts) ? modelInfo.reasoning.efforts : [];
      const sessions = catalog && Array.isArray(catalog.sessions) ? catalog.sessions : [];
      const workspaces = catalog && Array.isArray(catalog.workspaces) ? catalog.workspaces : [];
      const patch = (p) => setDraft(prev => coerceReplyConfig(Object.assign({}, prev, p)));
      const save = () => {
        const next = pmService.setReplyConfig(draft);
        pmService.showToast(next.mode === 'off' ? '自动回复已关闭' : '自动回复设置已保存');
        onClose();
      };
      const modeHint = draft.mode === 'auto'
        ? '每条好友文本都会自动调用所选模型回复，无人值守。请先确认权限模式足够收紧。'
        : draft.mode === 'manual'
          ? '收到好友文本后先进入「待批准」，你点批准才会调用模型。'
          : '不触发任何 agent 调用，聊天行为与之前一致。';

      return h('div', { className: 'pm-modal-overlay', onMouseDown: onClose },
        h('div', { className: 'pm-modal pm-modal-wide', style: { position: 'relative' }, onMouseDown: e => e.stopPropagation() },
          h('button', { className: 'pm-icon-btn pm-modal-close', type: 'button', onClick: onClose }, '✕'),
          h('div', { className: 'pm-modal-title' }, 'P2P 自动回复设置'),
          unavailable ? h('div', { className: 'pm-warn' }, 'Host 回调服务未就绪：请确认 dsh-peer-message 的 Host 半已加载。') : null,

          h('div', { className: 'pm-field' },
            h('label', { className: 'pm-field-label' }, '回复模式'),
            h('select', { className: 'pm-select', 'data-field': 'mode', value: draft.mode, onChange: e => patch({ mode: e.target.value }) },
              REPLY_MODES.map(m => h('option', { key: m, value: m }, REPLY_MODE_LABELS[m]))),
            h('div', { className: 'pm-hint' }, modeHint),
          ),

          h('div', { className: 'pm-field' },
            h('label', { className: 'pm-field-label' }, '回复 Agent 权限'),
            h('select', { className: 'pm-select', 'data-field': 'permission', value: draft.permission, onChange: e => patch({ permission: e.target.value }) },
              PERMISSION_MODES.map(m => h('option', { key: m, value: m }, REPLY_PERMISSION_LABELS[m]))),
            h('div', { className: 'pm-hint' }, '只读=读/搜/网页；只写=写/编辑；读写=工作路径内读写；全自动=全盘读写且免审批；全不允许=禁用一切工具。'),
            draft.permission === 'auto' ? h('div', { className: 'pm-warn' }, '「全自动」会让模型在无人审批的情况下读写本机文件、执行命令。只对可信对等端使用。') : null,
          ),

          h('div', { className: 'pm-modal-section-title' }, '回复使用的模型 / endpoint'),
          h('div', { className: 'pm-field' },
            h('label', { className: 'pm-field-label' }, 'Endpoint（模型提供方）'),
            h('select', { className: 'pm-select', 'data-field': 'provider', value: draft.provider, onChange: e => patch({ provider: e.target.value, model: '' }) },
              h('option', { value: '' }, '默认（跟随会话 / 部署配置）'),
              groups.map(g => h('option', { key: g.id, value: g.id }, g.name || g.id))),
          ),
          h('div', { className: 'pm-field' },
            h('label', { className: 'pm-field-label' }, '模型'),
            h('select', { className: 'pm-select', 'data-field': 'model', value: draft.model, disabled: !draft.provider, onChange: e => patch({ model: e.target.value }) },
              h('option', { value: '' }, draft.provider ? '该 endpoint 的默认模型' : '先选择 endpoint'),
              models.map(m => h('option', { key: m.id, value: m.id }, m.name || m.id))),
            efforts.length > 0 ? h('select', { className: 'pm-select', style: { marginTop: 6 }, value: draft.reasoningEffort, onChange: e => patch({ reasoningEffort: e.target.value }) },
              h('option', { value: '' }, '推理强度：模型默认'),
              efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))) : null,
          ),

          h('div', { className: 'pm-modal-section-title' }, '回复使用的会话 / 工作路径'),
          h('div', { className: 'pm-field' },
            h('select', { className: 'pm-select', 'data-field': 'sessionMode', value: draft.sessionMode, onChange: e => patch({ sessionMode: e.target.value }) },
              h('option', { value: 'dedicated' }, '每个好友一个独立会话（推荐）'),
              h('option', { value: 'existing' }, '复用指定现有会话')),
            h('div', { className: 'pm-hint' }, draft.sessionMode === 'dedicated'
              ? '首次回复时创建，之后同一好友复用该会话，保留上下文。'
              : '会把好友消息作为用户消息注入该会话；权限在回复轮次内生效，结束后恢复原设置。'),
          ),
          draft.sessionMode === 'existing'
            ? h('div', { className: 'pm-field' },
                h('label', { className: 'pm-field-label' }, '现有会话'),
                h('select', { className: 'pm-select', 'data-field': 'sessionId', value: draft.sessionId, onChange: e => patch({ sessionId: e.target.value }) },
                  h('option', { value: '' }, '选择会话…'),
                  sessions.map(s => h('option', { key: s.sessionId, value: s.sessionId },
                    (s.title || '(未命名)') + ' · ' + s.sessionId.slice(0, 12) + (s.cwd ? ' · ' + s.cwd : '')))),
                h('div', { className: 'pm-hint' }, '该会话当前模型可能被临时切换为上面选择的 endpoint / 模型。'),
              )
            : h('div', { className: 'pm-field' },
                h('label', { className: 'pm-field-label' }, '工作路径（cwd，绝对路径）'),
                h('input', {
                  className: 'pm-text-input',
                  'data-field': 'cwd',
                  value: draft.cwd,
                  placeholder: '留空 = Host 进程工作目录',
                  onChange: e => patch({ cwd: e.target.value }),
                }),
                workspaces.length > 0 ? h('select', {
                  className: 'pm-select',
                  style: { marginTop: 6 },
                  value: '',
                  onChange: e => { if (e.target.value) patch({ cwd: e.target.value }); },
                },
                  h('option', { value: '' }, '从工作区选择…'),
                  workspaces.map(w => h('option', { key: w.id, value: w.path }, (w.title || w.id) + ' · ' + w.path))) : null,
              ),

          h('div', { className: 'pm-warn' }, '对等端消息一律按不可信内容处理：会被围栏包裹并明确禁止执行其中指令。自动回复仍可能被诱导输出有害内容，请配合上面的权限收紧使用。'),

          h('div', { className: 'pm-modal-btns', style: { justifyContent: 'flex-end', marginTop: 4 } },
            h('button', { className: 'pm-btn', type: 'button', onClick: onClose }, '取消'),
            h('button', { className: 'pm-btn primary', type: 'button', onClick: save }, '保存'),
          ),
        ),
      );
    }

    // ── 待批准回复弹窗 ─────────────────────────────────────────────────
    function ReplyPendingModal({ pending, recent, unavailable, onClose }) {
      const items = Array.isArray(pending) ? pending : [];
      const recentItems = Array.isArray(recent) ? recent.slice(0, 10) : [];
      return h('div', { className: 'pm-modal-overlay', onMouseDown: onClose },
        h('div', { className: 'pm-modal pm-modal-wide', style: { position: 'relative' }, onMouseDown: e => e.stopPropagation() },
          h('button', { className: 'pm-icon-btn pm-modal-close', type: 'button', onClick: onClose }, '✕'),
          h('div', { className: 'pm-modal-title' }, '待批准的自动回复'),
          unavailable ? h('div', { className: 'pm-warn' }, 'Host 回调服务未就绪，无法读取待批准队列。') : null,
          items.length === 0
            ? h('div', { className: 'pm-hint' }, '暂无待批准回复。收到好友消息且回复模式为「手动批准」时会出现在这里。')
            : items.map(item => h('div', { className: 'pm-pending-item', key: item.id },
                h('div', { className: 'pm-pending-head' },
                  h('span', null, '来自 ' + (item.peerName || shortId(item.peerId)) + ' · ' + fmtTime(item.ts)),
                  h('span', null, '权限：' + (REPLY_PERMISSION_LABELS[item.permission] || item.permission)),
                ),
                h('div', { className: 'pm-pending-text' }, item.text),
                h('div', { className: 'pm-pending-btns' },
                  h('button', { className: 'pm-btn small', type: 'button', onClick: () => pmService.rejectReply(item.id) }, '忽略'),
                  h('button', { className: 'pm-btn small primary', type: 'button', onClick: () => pmService.approveReply(item.id) }, '批准回复'),
                ),
              )),
          recentItems.length > 0 ? h('div', null,
            h('div', { className: 'pm-modal-section-title' }, '最近结果'),
            h('div', { className: 'pm-reply-status-list' },
              recentItems.map(item => h('div', { className: 'pm-reply-status-row', key: item.id },
                h('span', { className: item.status === 'sent' ? 'pm-reply-status-ok' : item.status === 'failed' ? 'pm-reply-status-bad' : '' },
                  item.status === 'sent' ? '已投递' : item.status === 'failed' ? '失败' : item.status),
                h('span', null, shortId(item.peerId) + (item.finishedAt ? ' · ' + fmtTime(item.finishedAt) : '')),
                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  item.reply || item.error || ''),
              )),
            ),
          ) : null,
        ),
      );
    }

    // ── 主面板（纯视图，网络全在 pmService） ─────────────────────────────
    function PeerMessagePanel() {
      const snap = usePmService();
      const state = snap.state;
      const myId = snap.myId;
      const peerStatus = snap.peerStatus;
      const peerError = snap.peerError;
      const toast = snap.toast;
      const settings = snap.settings || { allowBroadcast: false, allowIncoming: true };
      const reply = snap.reply || DEFAULT_REPLY;
      const replyPending = Array.isArray(snap.replyPending) ? snap.replyPending : [];
      const replyRecent = Array.isArray(snap.replyRecent) ? snap.replyRecent : [];
      const replyUnavailable = !!snap.replyUnavailable;
      const replyCatalog = snap.replyCatalog;

      const [activeFriend, setActiveFriend] = React.useState(null);
      const [search, setSearch] = React.useState('');
      const [addId, setAddId] = React.useState('');
      const [draft, setDraft] = React.useState('');
      const [showQR, setShowQR] = React.useState(false);
      const [showReplySettings, setShowReplySettings] = React.useState(false);
      const [showPending, setShowPending] = React.useState(false);
      // 右键菜单：{ id, left, top }。右键只负责开菜单，绝不直接改好友数据。
      const [ctxMenu, setCtxMenu] = React.useState(null);
      // 删除确认：{ id, name }。确认框打开前不会有任何 removeFriend 调用。
      const [confirmDel, setConfirmDel] = React.useState(null);
      const chatRef = React.useRef(null);

      const openReplySettings = () => {
        setShowReplySettings(true);
        pmService.loadReplyCatalog(false);
      };

      // 活跃好友被删除时自动清空选择
      React.useEffect(() => {
        if (activeFriend && !state.friends.some(f => f.id === activeFriend)) setActiveFriend(null);
      }, [state.friends, activeFriend]);

      // 好友在别处被删除时，关闭指向它的右键菜单。
      React.useEffect(() => {
        if (ctxMenu && !state.friends.some(f => f.id === ctxMenu.id)) setCtxMenu(null);
      }, [state.friends, ctxMenu]);

      // 右键菜单：Escape / 窗口尺寸变化 / 任意滚动都关闭（菜单是 fixed 定位，
      // 跟随的是打开时的坐标，滚动后必须收起避免菜单与好友行错位）。
      React.useEffect(() => {
        if (!ctxMenu) return;
        const close = () => setCtxMenu(null);
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
        return () => {
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', close);
          window.removeEventListener('scroll', close, true);
        };
      }, [ctxMenu]);

      // 删除确认框：Escape 关闭（等价取消），不触发删除。
      React.useEffect(() => {
        if (!confirmDel) return;
        const onKey = (e) => { if (e.key === 'Escape') setConfirmDel(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [confirmDel]);

      // 自动回复设置 / 待批准弹窗：Escape 关闭。
      React.useEffect(() => {
        if (!showReplySettings && !showPending) return;
        const onKey = (e) => {
          if (e.key === 'Escape') { setShowReplySettings(false); setShowPending(false); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [showReplySettings, showPending]);

      // 自动滚动到底部
      React.useEffect(() => {
        if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
      }, [state.messages, activeFriend]);

      const filteredFriends = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        let list = state.friends;
        if (q) list = list.filter(f => (f.name || '').toLowerCase().includes(q) || (f.id || '').toLowerCase().includes(q));
        // 按最近消息时间排序
        return list.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      }, [state.friends, search]);

      const active = activeFriend ? state.friends.find(f => f.id === activeFriend) : null;
      const activeMsgs = activeFriend ? (state.messages[activeFriend] || []) : [];

      const selectFriend = (id) => {
        setActiveFriend(id);
        pmService.markRead(id);
      };

      // 右键只打开菜单（含视口夹取）；删除必须再点菜单项 + 确认框两道闸。
      const openCtxMenu = (e, f) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = clampMenuPosition(e.clientX, e.clientY, window.innerWidth, window.innerHeight, 200, 210);
        setCtxMenu({ id: f.id, left: pos.left, top: pos.top });
      };

      const ctxFriend = ctxMenu ? state.friends.find(f => f.id === ctxMenu.id) : null;

      const requestDeleteFriend = (f) => {
        setCtxMenu(null);
        setConfirmDel({ id: f.id, name: f.name || shortId(f.id) });
      };

      const doDeleteFriend = () => {
        const target = confirmDel;
        setConfirmDel(null);
        if (!target) return;
        pmService.removeFriend(target.id);
        pmService.showToast('已删除好友「' + target.name + '」');
      };

      const copyMyId = () => {
        if (!myId) return;
        copyText(myId).then(() => pmService.showToast('ID 已复制')).catch(() => pmService.showToast('复制失败'));
      };

      const trySend = () => {
        if (pmService.sendMessage(active.id, draft)) setDraft('');
      };

      return h('div', { className: 'pm-root' },
        // 左侧好友列表
        h('div', { className: 'pm-sidebar' },
          h('div', { className: 'pm-sidebar-header' },
            h('div', { className: 'pm-my-id' },
              h('span', { className: 'pm-status-dot', style: { background: peerStatus === 'online' ? 'var(--dsw-alias-state-success-primary,#22c55e)' : 'var(--dsw-alias-state-idle-primary,rgba(127,127,127,.5))' } }),
              h('span', { className: 'pm-my-id-label' }, '我的 ID'),
              h('span', { className: 'pm-my-id-value', title: myId || '连接中…' }, myId || (peerStatus === 'connecting' ? '连接中…' : '未连接')),
              h('button', { className: 'pm-icon-btn', title: '复制 ID', onClick: copyMyId }, '⧉'),
              h('button', { className: 'pm-icon-btn', title: '显示二维码', onClick: () => setShowQR(true), disabled: !myId }, '▦'),
              h('button', { className: 'pm-icon-btn', title: '自动回复设置', onClick: openReplySettings }, '⚙'),
            ),
            peerError ? h('div', { className: 'pm-peer-error' }, peerError) : null,
            // 后台运行开关（持久化；面板关闭时由 pmService 继续生效）
            h('div', { className: 'pm-toggle-row' },
              h('label', { className: 'pm-toggle' },
                h('input', { type: 'checkbox', checked: settings.allowBroadcast, onChange: e => pmService.setAllowBroadcast(e.target.checked) }),
                h('span', { className: 'pm-toggle-text' }, '广播：', settings.allowBroadcast ? '开（可被陌生 peer 发现并加好友）' : '关'),
              ),
            ),
            h('div', { className: 'pm-toggle-row' },
              h('label', { className: 'pm-toggle' },
                h('input', { type: 'checkbox', checked: settings.allowIncoming, onChange: e => pmService.setAllowIncoming(e.target.checked) }),
                h('span', { className: 'pm-toggle-text' }, '接收新连接：', settings.allowIncoming ? '开' : '关（已建立连接不受影响）'),
              ),
            ),
            // 自动回复状态：点开设置；有待批准时单独一条高亮入口。
            h('div', { className: 'pm-reply-row', title: '自动回复设置', onClick: openReplySettings },
              h('span', { className: 'pm-reply-dot', style: { background: reply.mode === 'auto' ? 'var(--dsw-alias-state-success-primary,#22c55e)' : reply.mode === 'manual' ? 'var(--dsw-alias-state-warning-primary,#f59e0b)' : 'var(--dsw-alias-state-idle-primary,rgba(127,127,127,.5))' } }),
              h('span', { className: 'pm-reply-row-text' }, '自动回复：' + (REPLY_MODE_LABELS[reply.mode] || '关闭') + ' · ' + (REPLY_PERMISSION_LABELS[reply.permission] || reply.permission)),
            ),
            replyPending.length > 0 ? h('div', {
              className: 'pm-reply-row',
              style: { borderColor: 'var(--dsw-alias-state-warning-primary,#f59e0b)', marginTop: 4 },
              title: '审核待批准回复',
              onClick: () => setShowPending(true),
            },
              h('span', { className: 'pm-reply-count' }, replyPending.length > 99 ? '99+' : String(replyPending.length)),
              h('span', { className: 'pm-reply-row-text' }, '条自动回复待批准，点击审核'),
            ) : null,
            snap.replyRunning && snap.replyRunning.length > 0 ? h('div', { className: 'pm-reply-row', style: { marginTop: 4 }, onClick: () => setShowPending(true) },
              h('span', { className: 'pm-reply-dot', style: { background: 'var(--dsw-alias-brand-primary,#3b82f6)' } }),
              h('span', { className: 'pm-reply-row-text' }, '正在生成 ' + snap.replyRunning.length + ' 条自动回复…'),
            ) : null,
          ),
          h('div', { className: 'pm-search' },
            h('input', { className: 'pm-search-input', placeholder: '搜索好友', value: search, onChange: e => setSearch(e.target.value) }),
          ),
          h('div', { className: 'pm-friend-list' },
            filteredFriends.length === 0
              ? h('div', { style: { textAlign: 'center', color: 'var(--dsw-alias-label-secondary,inherit)', padding: '30px 10px', fontSize: 12 } },
                  search ? '没有匹配的好友' : '还没有好友，添加一个吧')
              : filteredFriends.map(f => h('div', {
                  key: f.id,
                  className: 'pm-friend-item' + (f.id === activeFriend ? ' active' : ''),
                  onClick: () => selectFriend(f.id),
                  onContextMenu: (e) => openCtxMenu(e, f),
                },
                  h('div', { className: 'pm-avatar', style: { background: avatarColor(f.id) } }, (f.name || shortId(f.id) || '?').slice(0, 1).toUpperCase()),
                  h('div', { className: 'pm-friend-info' },
                    h('div', { className: 'pm-friend-name' }, f.name || shortId(f.id)),
                    h('div', { className: 'pm-friend-last' }, f.lastMsg || (f.online ? '在线' : '离线')),
                  ),
                  f.unread > 0 ? h('span', { className: 'pm-unread' }, f.unread > 99 ? '99+' : f.unread) : null,
                  h('span', { className: 'pm-status-dot', style: { marginLeft: 'auto', background: f.online ? 'var(--dsw-alias-state-success-primary,#22c55e)' : 'var(--dsw-alias-state-idle-primary,rgba(127,127,127,.5))' } }),
                )),
          ),
          h('div', { className: 'pm-add-friend' },
            h('input', { className: 'pm-add-input', placeholder: '输入好友 ID 添加', value: addId, onChange: e => setAddId(e.target.value), onKeyDown: e => { if (e.key === 'Enter') pmService.addFriend(addId); } }),
            h('button', { className: 'pm-add-btn', onClick: () => pmService.addFriend(addId), disabled: !addId.trim() || peerStatus !== 'online' }, '添加'),
          ),
        ),

        // 右侧聊天区
        active
          ? h('div', { className: 'pm-chat' },
              h('div', { className: 'pm-chat-header' },
                h('div', { className: 'pm-avatar', style: { background: avatarColor(active.id), width: 32, height: 32, fontSize: 13 } }, (active.name || shortId(active.id) || '?').slice(0, 1).toUpperCase()),
                h('div', { className: 'pm-chat-header-info' },
                  h('div', { className: 'pm-chat-header-name', title: active.name || active.id }, active.name || shortId(active.id)),
                  h('div', { className: 'pm-chat-header-status' }, active.online ? '在线' : '离线'),
                ),
              ),
              h('div', { className: 'pm-chat-messages', ref: chatRef },
                activeMsgs.length === 0
                  ? h('div', { style: { textAlign: 'center', color: 'var(--dsw-alias-label-secondary,inherit)', padding: '40px', fontSize: 12 } }, '开始聊天吧')
                  : activeMsgs.map((m, i) => h('div', { key: i, className: 'pm-msg ' + (m.from === 'me' ? 'pm-msg-mine' : 'pm-msg-theirs') },
                      h('div', null, m.text),
                      h('div', { className: 'pm-msg-time' }, fmtTime(m.ts)),
                    )),
              ),
              h('div', { className: 'pm-chat-input' },
                h('textarea', { className: 'pm-chat-textarea', placeholder: active.online ? '输入消息…' : '对方离线，消息无法送达', value: draft, onChange: e => setDraft(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); trySend(); } }, disabled: !active.online }),
                h('button', { className: 'pm-send-btn', onClick: trySend, disabled: !draft.trim() || !active.online }, '发送'),
              ),
            )
          : h('div', { className: 'pm-chat' },
              h('div', { className: 'pm-empty' },
                h('div', { className: 'pm-empty-icon' }, '💬'),
                h('div', { className: 'pm-empty-text' }, '选择一个好友开始聊天'),
                h('div', { className: 'pm-empty-hint' },
                  '我的 ID 是 ' + (myId || '连接中…') + '。把 ID 告诉朋友，或让朋友输入你的 ID 添加你。',
                  peerStatus === 'online' ? '（右键好友可打开操作菜单，删除需二次确认）' : '',
                ),
              ),
            ),

        // 二维码弹窗
        showQR && myId ? h('div', { className: 'pm-modal-overlay', onClick: () => setShowQR(false) },
          h('div', { className: 'pm-modal', style: { position: 'relative' }, onClick: e => e.stopPropagation() },
            h('button', { className: 'pm-icon-btn pm-modal-close', onClick: () => setShowQR(false) }, '✕'),
            h('div', { className: 'pm-modal-title' }, '我的连接二维码'),
            h(QRCodeView, { value: myId }),
            h('div', { className: 'pm-modal-id' }, myId),
            h('div', { className: 'pm-modal-btns' },
              h('button', { className: 'pm-btn', onClick: copyMyId }, '复制 ID'),
              h('button', { className: 'pm-btn primary', onClick: () => setShowQR(false) }, '关闭'),
            ),
          ),
        ) : null,

        // 好友右键菜单：右键只打开这里，数据改动只发生在用户点菜单项之后。
        ctxMenu && ctxFriend ? h(React.Fragment, null,
          h('div', {
            className: 'pm-ctx-backdrop',
            onMouseDown: () => setCtxMenu(null),
            onContextMenu: (e) => { e.preventDefault(); setCtxMenu(null); },
          }),
          h('div', {
            className: 'pm-ctx-menu',
            role: 'menu',
            'aria-label': '好友操作',
            style: { left: ctxMenu.left, top: ctxMenu.top },
            onContextMenu: (e) => e.preventDefault(),
          },
            h('div', { className: 'pm-ctx-title', title: ctxFriend.name || ctxFriend.id }, ctxFriend.name || shortId(ctxFriend.id)),
            h('button', {
              className: 'pm-ctx-item', role: 'menuitem', type: 'button',
              onClick: () => { setCtxMenu(null); selectFriend(ctxFriend.id); },
            }, h('span', { 'aria-hidden': 'true' }, '💬'), '打开聊天'),
            h('button', {
              className: 'pm-ctx-item', role: 'menuitem', type: 'button',
              onClick: () => {
                setCtxMenu(null);
                copyText(ctxFriend.id).then(() => pmService.showToast('ID 已复制')).catch(() => pmService.showToast('复制失败'));
              },
            }, h('span', { 'aria-hidden': 'true' }, '⧉'), '复制 ID'),
            h('button', {
              className: 'pm-ctx-item', role: 'menuitem', type: 'button',
              disabled: !ctxFriend.unread,
              onClick: () => { setCtxMenu(null); pmService.markRead(ctxFriend.id); pmService.showToast('已标记为已读'); },
            }, h('span', { 'aria-hidden': 'true' }, '✓'), '标记已读'),
            h('div', { className: 'pm-ctx-sep' }),
            h('button', {
              className: 'pm-ctx-item danger', role: 'menuitem', type: 'button',
              onClick: () => requestDeleteFriend(ctxFriend),
            }, h('span', { 'aria-hidden': 'true' }, '🗑'), '删除好友…'),
          ),
        ) : null,

        // 删除好友二次确认：取消 / Escape / 点遮罩都不删除。
        confirmDel ? h('div', { className: 'pm-modal-overlay', onMouseDown: () => setConfirmDel(null) },
          h('div', { className: 'pm-modal', style: { position: 'relative' }, onMouseDown: (e) => e.stopPropagation() },
            h('div', { className: 'pm-modal-title' }, '删除好友'),
            h('div', { className: 'pm-confirm-target' }, confirmDel.name),
            h('div', { className: 'pm-confirm-text' }, '删除后好友与聊天记录都会清除，且无法恢复。'),
            h('div', { className: 'pm-modal-btns' },
              h('button', { className: 'pm-btn', type: 'button', onClick: () => setConfirmDel(null) }, '取消'),
              h('button', { className: 'pm-btn danger', type: 'button', onClick: doDeleteFriend }, '删除好友'),
            ),
          ),
        ) : null,

        // 自动回复设置 / 待批准审核弹窗
        showReplySettings ? h(ReplySettingsModal, {
          initial: reply,
          catalog: replyCatalog,
          unavailable: replyUnavailable,
          onClose: () => setShowReplySettings(false),
        }) : null,
        showPending ? h(ReplyPendingModal, {
          pending: replyPending,
          recent: replyRecent,
          unavailable: replyUnavailable,
          onClose: () => setShowPending(false),
        }) : null,

        // Toast
        toast ? h('div', { className: 'pm-toast' }, toast) : null,
      );
    }

    // ── 错误边界（诊断） ──────────────────────────────────────────────
    class PeerErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        window.__pmError = String(error && error.message || error);
        window.__pmErrorInfo = String(info && info.componentStack || '');
        console.error('[peer-message] panel error:', error, info);
      }
      render() {
        if (this.state.error) {
          return React.createElement('div', { className: 'pm-root' },
            React.createElement('div', { style: { padding: 20, color: 'var(--dsw-alias-state-error-primary,#ef4444)' } },
              '面板渲染错误: ' + String(this.state.error.message || this.state.error),
              window.__pmErrorInfo ? React.createElement('pre', { style: { fontSize: 10, whiteSpace: 'pre-wrap' } }, String(window.__pmErrorInfo).slice(0, 500)) : null,
            ));
        }
        return this.props.children;
      }
    }

    // ── 侧边栏图标组件 ─────────────────────────────────────────────────
    function PeerMessageIcon({ size, active }) {
      // 初始未读总数：直接从 localStorage 读取（panel 未挂载时也能显示正确徽标），
      // 再订阅 store 接收 panel persist 的后续更新。
      const [unread, setUnread] = React.useState(() => {
        try {
          const st = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
          return computeUnreadTotal(st && st.friends);
        } catch (e) { return 0; }
      });
      React.useEffect(() => pmUnreadStore.subscribe(setUnread), []);
      return h('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        h('svg', {
          viewBox: '0 0 24 24', width: size || 18, height: size || 18,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          style: { display: 'block', opacity: active ? 1 : 0.85 },
        },
          h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }),
          h('path', { d: 'M8 10h.01M12 10h.01M16 10h.01' }),
        ),
        unread > 0 ? h('span', {
          style: {
            position: 'absolute', top: -4, right: -6,
            minWidth: 15, height: 15, padding: '0 4px',
            borderRadius: 8, background: 'var(--dsw-alias-state-error-primary,#ef4444)',
            color: '#fff', fontSize: 9, fontWeight: 600, lineHeight: '15px',
            textAlign: 'center', boxSizing: 'border-box',
          },
        }, unread > 99 ? '99+' : String(unread)) : null,
      );
    }

    // ── 注册 ────────────────────────────────────────────────────────────
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) {
        console.error('[peer-message] slots service unavailable; UI not registered');
        return;
      }

      // 注入样式（手动创建 style 标签，因 factory 作用域内无 styles 服务）
      let styleTag = null;
      ctx.effect(() => {
        styleTag = document.createElement('style');
        styleTag.dataset.dyn = 'peer-message';
        styleTag.textContent = CSS;
        document.head.appendChild(styleTag);
        return () => { if (styleTag) styleTag.remove(); };
      }, 'peer-message: styles');

      ctx.effect(() => {
        const dispose = ctx.slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => React.createElement(PeerErrorBoundary, null,
          React.createElement(PeerMessagePanel))));
        return dispose;
      }, 'peer-message: main panel');

      ctx.effect(() => {
        const dispose = ctx.slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 12,
          label: '消息',
        }, (props) => React.createElement(PeerMessageIcon, {
          size: (props && props.size) || 18,
          active: !!(props && props.active),
        })));
        return dispose;
      }, 'peer-message: sidebar icon');

      // 启动后台 P2P 服务：页面加载即运行，不依赖消息面板是否打开。
      pmService.start();

      console.log('[peer-message] client applied: panel "' + PANEL_ID + '" registered, pmService started');
    }

    return { inject: ['slots'], apply };
  },
});
