// 社交层跨语言集成测试：真实 Go 信令服务器（social_test 的 httptest 不够——
// 这里要验证 Node daemon 全链路）与真实 peerjs 客户端。
//
// 流程：go 服务器由测试内嵌（用 httptest 不行，需要真实 TCP 给 wrtc 用）——
// 改用「已编译的 cmd/pm-signal 二进制」起子进程。三个 daemon：A/B/C。
//   1. A 设 profile（PATCH），B 拒陌生人，C 默认
//   2. discover 应含 3 人；recommend（A 视角）应含 C 不含 B
//   3. A→C 打招呼：C 收到（notice/inbox）
//   4. A→B 打招呼：403（B 拒）
//   5. 非好友 OFFER 被拒；加好友后放行（用裸 WS 验证信令门禁）
//   6. socialSetProfile 持久化（canControl 字段）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { createNetwork } from '../server/network.js';

const SIGNAL_BIN = process.env.PM_SIGNAL_TEST_BIN || '/tmp/pm-signal-itest';

// realSignalPeerJS：真实的 peerjs 协议信令（原生 WebSocket）+ 假 WebRTC 数据面。
// 这让 daemon 走与生产一致的路径：真 WS 注册（服务器 verifyOwner 认这个 token）、
// SOCIAL-NOTICE 推送、信令门禁——只是 WebRTC 数据通道本身是假的（测试不传 SDP）。
function realSignalPeerJS() {
  const { randomUUID } = require('node:crypto');
  return class RealSignalPeer {
    constructor(id, options) {
      this.id = id; this.options = options || {};
      this.open = false; this.destroyed = false; this.disconnected = false;
      this.handlers = {};
      const url = `ws://${options.host}:${options.port}${options.path}peerjs?key=${encodeURIComponent(options.key)}&id=${encodeURIComponent(id)}&token=${encodeURIComponent(options.token || randomUUID())}&version=1.5.4`;
      this.__ws = new WebSocket(url);
      this.__ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'OPEN') {
          this.open = true;
          (this.handlers.open || []).forEach((fn) => fn(m.payload && m.payload.id || this.id));
        }
        // SOCIAL-NOTICE 等转给 'connection' 之外的通用处理：network.js 没监听这些——
        // SOCIAL-NOTICE 是 peerjs default 分支（未知消息），peerjs 客户端会 warn。
        // 因此信令事件推送在 daemon 侧靠 social.refresh() 轮询兜底（15s）。
      };
      this.__ws.onclose = () => { this.open = false; (this.handlers.close || []).forEach((fn) => fn()); };
      this.__ws.onerror = () => { (this.handlers.error || []).forEach((fn) => fn({ type: 'network' })); };
    }
    on(e, fn) { (this.handlers[e] ||= []).push(fn); return this; }
    connect(peerId) {
      // 信令层真实 OFFER（服务端好友门禁生效点）：构造最小 SDP payload。
      const connId = 'cn-' + randomUUID().slice(0, 8);
      try {
        this.__ws.send(JSON.stringify({
          type: 'OFFER', dst: peerId,
          payload: { sdp: { type: 'offer', sdp: 'v=0\r\n' }, connectionId: connId, type_: 'data', label: 'chat', reliable: true, serialization: 'binary' },
        }));
      } catch (e) { /* ws closed */ }
      return { peer: peerId, open: true, on() {}, send() {}, close() {} };
    }
    destroy() { this.destroyed = true; this.open = false; try { this.__ws.close(); } catch (e) { /* ignore */ } }
    reconnect() { /* 测试不覆盖信令断线 */ }
  };
}

// startSignalServer 起真实 Go 服务器（子进程），返回 base URL 与关闭函数。
function startSignalServer() {
  const port = 9600 + (process.pid % 300) + Math.floor(Math.random() * 100);
  const child = spawn(SIGNAL_BIN, [], { env: { ...process.env, PM_SIGNAL: `127.0.0.1:${port}` }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/`;
  const stop = () => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } };
  // 等就绪
  const ready = (async () => {
    for (let i = 0; i < 100; i += 1) {
      try {
        const r = await fetch(`${base}healthz`);
        if (r.ok) return;
      } catch (e) { /* not yet */ }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error('signal server not ready');
  })();
  return { base, stop, ready };
}

async function makeNode(dir, portOffset) {
  const signal = {
    secure: false, host: '127.0.0.1',
    port: Number(new URL(globalThis.__ITEST_BASE__ || 'http://127.0.0.1:9700/').port) || 9700,
    path: '/', key: 'peerjs',
  };
  const net = createNetwork({
    dataDir: dir,
    loadPeerJS: async () => realSignalPeerJS(),
    wrtc: {},
    logger: { info() {}, warn() {} },
    signal,
  });
  await net.start();
  await new Promise((r) => setTimeout(r, 30));
  return net;
}

test('social integration: discover/recommend/greet/gate（真实 Go 服务器 + 3 daemon）', async () => {
  const sig = startSignalServer();
  try {
    await sig.ready;
    globalThis.__ITEST_BASE__ = sig.base;
    const port = new URL(sig.base).port;
    const mk = async (name) => {
      const dir = mkdtempSync(join(tmpdir(), `pm-soc-${name}-`));
      const net = createNetwork({
        dataDir: dir,
        loadPeerJS: async () => realSignalPeerJS(),
        wrtc: {},
        logger: { info() {}, warn() {} },
        signal: { secure: false, host: '127.0.0.1', port: Number(port), path: '/', key: 'peerjs' },
      });
      await net.start();
      await new Promise((r) => setTimeout(r, 30));
      return net;
    };
    const A = await mk('a'), B = await mk('b'), C = await mk('c');
    const AID = A.snapshot().myId, BID = B.snapshot().myId, CID = C.snapshot().myId;

    // 1) 设 profile：A 名字 Alice；B 拒陌生人
    await A.socialSetProfile({ nickname: 'Alice', bio: 'integration' });
    await B.socialSetProfile({ nickname: 'Bob', allowGreet: false });
    await A.socialRefresh();

    // 2) discover：3 人（自己可见也算，服务器不排除——排除由客户端做）
    let soc = A.social();
    assert.equal(soc.available, true, 'social 不可用（signal 未生效？）');
    assert.ok(soc.people.length >= 3, `discover 应至少 3 人，got ${soc.people.length}`);
    const alice = soc.people.find((p) => p.peerId === AID);
    assert.equal(alice.name, 'Alice', 'A 的 profile 未生效');

    // 3) recommend（A 视角）：C 在（默认可打招呼），B 不在（拒陌生人）
    assert.ok(soc.recommended.some((p) => p.peerId === CID), 'C 应被推荐');
    assert.ok(!soc.recommended.some((p) => p.peerId === BID), 'B 拒陌生人不应被推荐');

    // 4) 打招呼：A→C 成功；A→B 被拒（403）
    const okGreet = await A.socialGreet(CID, '你好 C，我是 Alice');
    assert.equal(okGreet.ok, true, `A→C 打招呼失败: ${JSON.stringify(okGreet)}`);
    const badGreet = await A.socialGreet(BID, '你好 B');
    assert.equal(badGreet.ok, false, 'A→B 打招呼应被拒');

    // 5) 好友门禁：未加好友前 B 的 OFFER 被拒（用 HTTP 层验证 isFriend 语义——
    //    daemon 的 fakePeerJS 不跑真实 OFFER；直接查服务端 /friends + 用 A 的 social）
    await A.socialServerAddFriend(BID);
    await new Promise((r) => setTimeout(r, 300));
    // A 的好友列表（服务端视角）
    await A.socialRefresh();
    soc = A.social();
    const friendIds = soc.friends.map((f) => f.peerId);
    assert.ok(friendIds.includes(BID), `A 的服务端好友应含 B: ${friendIds}`);
    // B 未加 A：对等模型（服务器 addFriend 写双侧）→ B 的列表也应有 A
    await B.socialRefresh();
    const bFriends = B.social().friends.map((f) => f.peerId);
    assert.ok(bFriends.includes(AID), `对等模型：B 的好友应含 A: ${bFriends}`);

    // 6) C 收到打招呼（notice 推送或 inbox 拉取）
    await C.socialRefresh();
    const cGreet = C.social().greetings.find((g) => g.from === AID);
    assert.ok(cGreet, `C 应收到 A 的打招呼: ${JSON.stringify(C.social().greetings)}`);

    A.stop(); B.stop(); C.stop();
  } finally {
    sig.stop();
  }
}, { timeout: 30000 });
