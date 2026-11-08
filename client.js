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
    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* ignore */ }
      return { friends: [], messages: {} }; // friends: [{id, name, lastMsg, unread, online}], messages: {id: [{from, text, ts}]}
    }

    function saveState(state) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) { /* ignore */ }
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
      '.pm-qr-box{padding:12px;background:#fff;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));}',
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
    ].join('');

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

    // ── 主组件 ──────────────────────────────────────────────────────────
    function PeerMessagePanel() {
      const [myId, setMyId] = React.useState('');
      const [peerStatus, setPeerStatus] = React.useState('connecting'); // connecting | online | error | closed
      const [peerError, setPeerError] = React.useState('');
      const [state, setState] = React.useState(loadState);
      const [activeFriend, setActiveFriend] = React.useState(null);
      const [search, setSearch] = React.useState('');
      const [addId, setAddId] = React.useState('');
      const [draft, setDraft] = React.useState('');
      const [showQR, setShowQR] = React.useState(false);
      const [toast, setToast] = React.useState('');
      const [peerLibLoaded, setPeerLibLoaded] = React.useState(false);
      const [conns, setConns] = React.useState({}); // id -> DataConnection
      const chatRef = React.useRef(null);

      const peerRef = React.useRef(null);
      const stateRef = React.useRef(state);
      const connsRef = React.useRef(conns);
      const activeRef = React.useRef(activeFriend);
      const myIdRef = React.useRef(myId);
      const toastTimer = React.useRef(null);

      stateRef.current = state;
      connsRef.current = conns;
      activeRef.current = activeFriend;
      myIdRef.current = myId;

      // toast
      const showToast = React.useCallback((msg) => {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 2500);
      }, []);

      // 持久化 state
      const persist = React.useCallback((updater) => {
        setState(prev => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          saveState(next);
          return next;
        });
      }, []);

      // 自动滚动到底部
      React.useEffect(() => {
        if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
      }, [state.messages, activeFriend]);

      // 加载 PeerJS
      React.useEffect(() => {
        let cancelled = false;
        loadPeerJS().then(() => {
          if (!cancelled) setPeerLibLoaded(true);
        }).catch(err => {
          if (!cancelled) {
            setPeerStatus('error');
            setPeerError(String(err?.message || err));
          }
        });
        return () => { cancelled = true; };
      }, []);

      // 初始化 Peer 连接
      React.useEffect(() => {
        if (!peerLibLoaded) return;
        let disposed = false;
        let peer = null;

        try {
          peer = new window.Peer(DEFAULT_PEER_CONFIG);
        } catch (err) {
          setPeerStatus('error');
          setPeerError(String(err?.message || err));
          return;
        }

        peerRef.current = peer;

        peer.on('open', (id) => {
          if (disposed) return;
          setMyId(id);
          setPeerStatus('online');
          // 自动连接：对之前请求但未完成的好友重试
          connsRef.current = {};
        });

        peer.on('connection', (conn) => {
          if (disposed) return;
          const remoteId = conn.peer;
          conn.on('open', () => {
            setConns(prev => ({ ...prev, [remoteId]: conn }));
            setState(prev => {
              const friends = [...prev.friends];
              const idx = friends.findIndex(f => f.id === remoteId);
              if (idx >= 0) friends[idx] = { ...friends[idx], online: true };
              else friends.push({ id: remoteId, name: shortId(remoteId), online: true, unread: 0, lastMsg: '', lastTs: Date.now() });
              const next = { ...prev, friends };
              saveState(next);
              return next;
            });
            showToast(`「${shortId(remoteId)}」请求连接已接受`);
          });
          conn.on('data', (data) => handleIncoming(remoteId, data));
          conn.on('close', () => handleClose(remoteId));
          conn.on('error', () => handleClose(remoteId));
        });

        peer.on('error', (err) => {
          if (disposed) return;
          if (err?.type === 'unavailable-id') {
            setPeerStatus('error');
            setPeerError('ID 被占用，请刷新页面重试');
          } else if (err?.type === 'peer-unavailable') {
            showToast('对方不在线，无法连接');
          } else if (err?.type === 'network' || err?.type === 'server-error') {
            setPeerStatus('error');
            setPeerError('信令服务器连接失败：' + (err?.message || err?.type));
          } else if (err?.type === 'disconnected') {
            setPeerStatus('offline');
            setPeerError('');
            if (peer && !peer.destroyed) {
              // 尝试重连
              try { peer.reconnect(); } catch (e) { /* ignore */ }
            }
          } else {
            setPeerError(err?.type || String(err?.message || err));
          }
        });

        peer.on('close', () => {
          if (!disposed) setPeerStatus('closed');
        });

        return () => {
          disposed = true;
          try { peer.destroy(); } catch (e) { /* ignore */ }
          peerRef.current = null;
        };
      }, [peerLibLoaded]);

      // 处理收到消息
      function handleIncoming(remoteId, data) {
        if (typeof data === 'string') {
          persist(prev => {
            const msgs = prev.messages[remoteId] || [];
            msgs.push({ from: 'them', text: data, ts: Date.now() });
            const friends = [...prev.friends];
            const idx = friends.findIndex(f => f.id === remoteId);
            if (idx >= 0) friends[idx] = { ...friends[idx], lastMsg: data, lastTs: Date.now(), unread: (friends[idx].unread || 0) + 1, online: true };
            const next = { ...prev, messages: { ...prev.messages, [remoteId]: msgs }, friends };
            saveState(next);
            return next;
          });
        } else if (data && typeof data === 'object') {
          // 处理握手/元数据（如昵称）
          if (data.type === 'hello' && data.name) {
            persist(prev => {
              const friends = [...prev.friends];
              const idx = friends.findIndex(f => f.id === remoteId);
              if (idx >= 0) friends[idx] = { ...friends[idx], name: data.name };
              return { ...prev, friends };
            });
          }
        }
      }

      // 处理断开
      function handleClose(remoteId) {
        setConns(prev => {
          const next = { ...prev };
          delete next[remoteId];
          return next;
        });
        setState(prev => {
          const friends = prev.friends.map(f => f.id === remoteId ? { ...f, online: false } : f);
          const next = { ...prev, friends };
          saveState(next);
          return next;
        });
        showToast(`「${shortId(remoteId)}」已离线`);
      }

      // 添加好友（连接）
      const addFriend = React.useCallback((targetId) => {
        const id = (targetId || addId).trim();
        if (!id) return;
        if (id === myIdRef.current) {
          showToast('不能添加自己');
          return;
        }
        // 先加入列表（离线状态）
        persist(prev => {
          const friends = [...prev.friends];
          const idx = friends.findIndex(f => f.id === id);
          if (idx >= 0) friends[idx] = { ...friends[idx] };
          else friends.push({ id, name: shortId(id), online: false, unread: 0, lastMsg: '', lastTs: Date.now() });
          const next = { ...prev, friends };
          saveState(next);
          return next;
        });

        // 发起连接
        const peer = peerRef.current;
        if (peer && peer.open) {
          const conn = peer.connect(id, { reliable: true });
          conn.on('open', () => {
            setConns(prev => ({ ...prev, [id]: conn }));
            setState(prev => {
              const friends = prev.friends.map(f => f.id === id ? { ...f, online: true } : f);
              const next = { ...prev, friends };
              saveState(next);
              return next;
            });
            // 发送握手
            conn.send({ type: 'hello', name: '我' });
            showToast(`已连接「${shortId(id)}」`);
          });
          conn.on('data', (data) => handleIncoming(id, data));
          conn.on('close', () => handleClose(id));
          conn.on('error', () => handleClose(id));
        } else {
          showToast('Peer 未就绪，请稍后再试');
        }
        setAddId('');
      }, [addId, persist, showToast]);

      // 发送消息
      const sendMessage = React.useCallback(() => {
        const text = draft.trim();
        const target = activeRef.current;
        if (!text || !target) return;
        const conn = connsRef.current[target];
        if (!conn || !conn.open) {
          showToast('对方不在线，无法发送');
          return;
        }
        try {
          conn.send(text);
        } catch (e) {
          showToast('发送失败：' + (e?.message || e));
          return;
        }
        persist(prev => {
          const msgs = prev.messages[target] || [];
          msgs.push({ from: 'me', text, ts: Date.now() });
          const friends = prev.friends.map(f => f.id === target ? { ...f, lastMsg: text, lastTs: Date.now() } : f);
          const next = { ...prev, messages: { ...prev.messages, [target]: msgs }, friends };
          saveState(next);
          return next;
        });
        setDraft('');
      }, [draft, persist, showToast]);

      // 投递一条 agent 队列消息：确保好友存在、连接可用，然后发送并持久化
      const deliverQueued = React.useCallback(async (item) => {
        const target = item.to;
        if (!target || !item.text) return;
        // 确保好友在列表中
        setState(prev => {
          const friends = [...prev.friends];
          const idx = friends.findIndex(f => f.id === target);
          if (idx >= 0) friends[idx] = { ...friends[idx] };
          else friends.push({ id: target, name: shortId(target), online: false, unread: 0, lastMsg: '', lastTs: Date.now() });
          const next = { ...prev, friends };
          saveState(next);
          return next;
        });
        let conn = connsRef.current[target];
        if (!conn || !conn.open) {
          const peer = peerRef.current;
          if (!peer || !peer.open) return; // 等下次轮询（peer 未就绪）
          try {
            conn = peer.connect(target, { reliable: true });
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('timeout')), 6000);
              conn.once('open', () => { clearTimeout(timer); resolve(); });
              conn.once('error', () => { clearTimeout(timer); reject(new Error('error')); });
            });
            setConns(prev => ({ ...prev, [target]: conn }));
            setState(prev => {
              const friends = prev.friends.map(f => f.id === target ? { ...f, online: true } : f);
              const next = { ...prev, friends };
              saveState(next);
              return next;
            });
            conn.on('data', (data) => handleIncoming(target, data));
            conn.on('close', () => handleClose(target));
            conn.on('error', () => handleClose(target));
          } catch (e) {
            // 连接失败：把消息放回队列（重新入队）避免丢失
            outboxPush(item);
            return;
          }
        }
        try {
          conn.send(item.text);
        } catch (e) {
          outboxPush(item);
          return;
        }
        persist(prev => {
          const msgs = prev.messages[target] || [];
          msgs.push({ from: 'me', text: item.text, ts: Date.now() });
          const friends = prev.friends.map(f => f.id === target ? { ...f, lastMsg: item.text, lastTs: Date.now() } : f);
          const next = { ...prev, messages: { ...prev.messages, [target]: msgs }, friends };
          saveState(next);
          return next;
        });
        showToast('已投递 agent 消息');
      }, [persist, showToast]);

      // 轮询 /api/pm-outbox：取回 agent 排队的 P2P 消息
      React.useEffect(() => {
        let stopped = false;
        const poll = async () => {
          if (stopped) return;
          try {
            const res = await fetch('/api/pm-outbox', { method: 'GET' });
            if (res.ok) {
              const data = await res.json();
              const items = Array.isArray(data?.items) ? data.items : [];
              for (const item of items) await deliverQueued(item);
            }
          } catch (e) { /* 静默：轮询失败下次重试 */ }
        };
        poll();
        const timer = setInterval(poll, 600);
        return () => { stopped = true; clearInterval(timer); };
      }, [deliverQueued]);

      // 复制 ID
      const copyMyId = React.useCallback(() => {
        if (!myIdRef.current) return;
        copyText(myIdRef.current).then(() => showToast('ID 已复制')).catch(() => showToast('复制失败'));
      }, [showToast]);

      // 计算过滤后的好友列表
      const filteredFriends = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        let list = state.friends;
        if (q) list = list.filter(f => (f.name || '').toLowerCase().includes(q) || (f.id || '').toLowerCase().includes(q));
        // 按最近消息时间排序（在线优先）
        return [...list].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      }, [state.friends, search]);

      // 当前活跃好友
      const active = activeFriend ? state.friends.find(f => f.id === activeFriend) : null;
      const activeMsgs = activeFriend ? (state.messages[activeFriend] || []) : [];

      // 选择好友时清未读
      const selectFriend = React.useCallback((id) => {
        setActiveFriend(id);
        persist(prev => {
          const friends = prev.friends.map(f => f.id === id ? { ...f, unread: 0 } : f);
          const next = { ...prev, friends };
          saveState(next);
          return next;
        });
      }, [persist]);

      // 删除好友
      const removeFriend = React.useCallback((id) => {
        const conn = connsRef.current[id];
        if (conn) { try { conn.close(); } catch (e) { /* ignore */ } }
        persist(prev => {
          const friends = prev.friends.filter(f => f.id !== id);
          const messages = { ...prev.messages };
          delete messages[id];
          const next = { ...prev, friends, messages };
          saveState(next);
          return next;
        });
        if (activeRef.current === id) setActiveFriend(null);
        showToast('已删除好友');
      }, [persist, showToast]);

      // 渲染二维码
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
            let svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${count*cellSize}" height="${count*cellSize}" viewBox="0 0 ${count} ${count}" shape-rendering="crispEdges">`;
            for (let r = 0; r < count; r++) {
              for (let c = 0; c < count; c++) {
                if (qr.isDark(r, c)) svgStr += `<rect x="${c}" y="${r}" width="1" height="1" fill="#000"/>`;
              }
            }
            svgStr += '</svg>';
            setSvg(svgStr);
          }).catch(() => setSvg(''));
          return () => { cancelled = true; };
        }, [value]);
        return h('div', { className: 'pm-qr-box', dangerouslySetInnerHTML: { __html: svg || '<div style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;color:#999;font-size:12px">加载中…</div>' } });
      }

      // 侧栏图标（用于 sidebar.panellist）
      // 实际由外部渲染，这里只是导出逻辑

      // ── 渲染 ──────────────────────────────────────────────────────────
      if (!peerLibLoaded) {
        return h('div', { className: 'pm-root' }, h('div', { className: 'pm-loading' }, '正在加载 PeerJS…'));
      }

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
                  onContextMenu: (e) => { e.preventDefault(); removeFriend(f.id); },
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
            h('input', { className: 'pm-add-input', placeholder: '输入好友 ID 添加', value: addId, onChange: e => setAddId(e.target.value), onKeyDown: e => { if (e.key === 'Enter') addFriend(); } }),
            h('button', { className: 'pm-add-btn', onClick: () => addFriend(), disabled: !addId.trim() || peerStatus !== 'online' }, '添加'),
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
                h('textarea', { className: 'pm-chat-textarea', placeholder: active.online ? '输入消息…' : '对方离线，消息无法送达', value: draft, onChange: e => setDraft(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }, disabled: !active.online }),
                h('button', { className: 'pm-send-btn', onClick: sendMessage, disabled: !draft.trim() || !active.online }, '发送'),
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
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: active ? 1 : 0.85 },
      },
        h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }),
        h('path', { d: 'M8 10h.01M12 10h.01M16 10h.01' }),
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

      console.log('[peer-message] client applied: panel "' + PANEL_ID + '" registered');
    }

    return { inject: ['slots'], apply };
  },
});
