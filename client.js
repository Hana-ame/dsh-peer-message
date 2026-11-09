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
      '.pm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;border-radius:6px;font-size:14px;transition:background .15s;}',
      '.pm-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));}',
      '.pm-status-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
      '.pm-status-on{background:var(--dsw-alias-state-success-primary,#22c55e);}',
      '.pm-status-off{background:var(--dsw-alias-state-idle-primary,rgba(127,127,127,.5));}',

      '.pm-search{padding:8px 12px;}',
      '.pm-search-input{width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:12px;outline:none;}',
      '.pm-search-input:focus{border-color:var(--dsw-alias-brand-primary,inherit);}',

      '.pm-friend-list{flex:1;overflow-y:auto;padding:4px;}',
      '.pm-friend-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;transition:background .15s;}',
      '.pm-friend-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}',
      '.pm-friend-item.active{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.15));}',
      '.pm-avatar{width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;flex:none;font-size:16px;}',
      '.pm-friend-info{flex:1;min-width:0;}',
      '.pm-friend-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-friend-last{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pm-unread{min-width:18px;height:18px;border-radius:9px;background:var(--dsw-alias-state-error-primary,#ef4444);color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;padding:0 5px;flex:none;}',

      '.pm-add-friend{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));}',
      '.pm-add-input{flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:12px;outline:none;}',
      '.pm-add-btn{padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font-size:12px;font-weight:500;cursor:pointer;}',
      '.pm-add-btn:hover{opacity:.9;}',
      '.pm-add-btn:disabled{opacity:.5;cursor:not-allowed;}',

      // 右侧聊天区
      '.pm-chat{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--dsw-alias-bg-base,transparent);}',
      '.pm-chat-header{padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));display:flex;align-items:center;gap:10px;}',
      '.pm-chat-header-name{font-size:15px;font-weight:600;}',
      '.pm-chat-header-status{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);}',
      '.pm-chat-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:8px;}',
      '.pm-msg{max-width:70%;padding:8px 12px;border-radius:10px;font-size:13px;word-break:break-word;white-space:pre-wrap;}',
      '.pm-msg-mine{align-self:flex-end;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;border-bottom-right-radius:3px;}',
      '.pm-msg-theirs{align-self:flex-start;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit);border-bottom-left-radius:3px;}',
      '.pm-msg-time{font-size:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));margin-top:3px;}',
      '.pm-chat-input{padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));display:flex;gap:8px;align-items:flex-end;}',
      '.pm-chat-textarea{flex:1;min-height:40px;max-height:120px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:13px;resize:none;outline:none;font-family:inherit;}',
      '.pm-chat-textarea:focus{border-color:var(--dsw-alias-brand-primary,inherit);}',
      '.pm-send-btn{padding:8px 20px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font-size:13px;font-weight:500;cursor:pointer;}',
      '.pm-send-btn:hover{opacity:.9;}',
      '.pm-send-btn:disabled{opacity:.5;cursor:not-allowed;}',

      // 空状态
      '.pm-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--dsw-alias-label-secondary,inherit);}',
      '.pm-empty-icon{font-size:48px;opacity:.5;}',
      '.pm-empty-text{font-size:14px;}',
      '.pm-empty-hint{font-size:12px;opacity:.7;text-align:center;max-width:400px;line-height:1.6;}',

      // 二维码弹窗
      '.pm-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;}',
      '.pm-modal{background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));border-radius:12px;padding:24px;width:320px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:16px;align-items:center;}',
      '.pm-modal-title{font-size:15px;font-weight:600;}',
      '.pm-modal-close{position:absolute;top:10px;right:10px;}',
      // QR 背景/前景跟随主题：浅色=白底黑块，深色=深底浅块（反色），避免深色模式白盒刺眼。
      '.pm-qr-box{padding:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));}',
      '.pm-modal-id{font-family:monospace;font-size:12px;word-break:break-all;text-align:center;color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));padding:8px 12px;border-radius:6px;width:100%;}',
      '.pm-modal-btns{display:flex;gap:8px;width:100%;}',
      '.pm-btn{padding:6px 16px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:12px;cursor:pointer;flex:1;}',
      '.pm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}',
      '.pm-btn.primary{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent;color:#fff;}',
      '.pm-btn.primary:hover{opacity:.9;}',

      // 连接状态提示
      '.pm-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay,#1f2937);color:var(--dsw-alias-label-primary,#fff);padding:10px 20px;border-radius:8px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:2000;}',

      // 加载态
      '.pm-loading{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,inherit);font-size:14px;}',
      '.pm-peer-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;margin-top:4px;}',
      // 后台开关行：紧凑、主题色跟随。
      '.pm-toggle-row{margin-top:8px;}',
      '.pm-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}',
      '.pm-toggle input{accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer;}',
      '.pm-toggle-text{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);}',
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
      return `hsl(${hues[hash % hues.length]}, 65%, 50%)`;
    }

    function shortId(id) {
      if (!id) return '';
      return id.length > 8 ? id.slice(0, 8) : id;
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
        // 慢速后台重连：每 30s 重试不在线的好友。
        this.reconnectTimer = setInterval(() => {
          if (this.peer && this.peer.open) this.reconnectAll();
        }, 30000);
      },

      stop() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
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
      return h('div', { className: 'pm-qr-box', dangerouslySetInnerHTML: { __html: svg || '<div style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;color:#999;font-size:12px">加载中…</div>' } });
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

      const [activeFriend, setActiveFriend] = React.useState(null);
      const [search, setSearch] = React.useState('');
      const [addId, setAddId] = React.useState('');
      const [draft, setDraft] = React.useState('');
      const [showQR, setShowQR] = React.useState(false);
      const chatRef = React.useRef(null);

      // 活跃好友被删除时自动清空选择
      React.useEffect(() => {
        if (activeFriend && !state.friends.some(f => f.id === activeFriend)) setActiveFriend(null);
      }, [state.friends, activeFriend]);

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
                  onContextMenu: (e) => { e.preventDefault(); pmService.removeFriend(f.id); },
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
                h('div', {},
                  h('div', { className: 'pm-chat-header-name' }, active.name || shortId(active.id)),
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
                  peerStatus === 'online' ? '（右键好友可删除）' : '',
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
