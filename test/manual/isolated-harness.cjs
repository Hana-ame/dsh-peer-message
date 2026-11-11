// 手工 GUI 验证用 harness（不在 npm test 里跑：需要运行中的 DSH + Playwright）。
//
// 为什么需要它：这些脚本以前直接调用生产的 /api/pm-net/action，会把测试用的
// 假好友（dsh-pm-layoutNN-abcdef 等）写进真实的 state.json。那份脏数据在 daemon
// 启动时被无限制地并发拨号，几十个 peer-unavailable 把信令连接打掉，继而引发
// unavailable-id 自锁——真实故障的起点就在测试污染。
//
// 用法：把一个页面的 fetch 包装成内存态，所有 /api/pm-net/* 读写都落在
// sessionStorage，生产 daemon 完全不受影响。
// 测试脚本共享的隔离环境：用 fetch 拦截把 /api/pm-net/* 全部变成内存态，
// 永不写入生产 daemon 的 state.json。
const { chromium } = require('/home/lumin/.dsh/plugins/dsh-browser/node_modules/playwright-core');
const fs = require('fs');

function isolatedInitScript() {
  return `
    (() => {
      const originalFetch = window.fetch.bind(window);
      const SNAP_KEY = '__PM_TEST_SNAPSHOT__';
      const load = () => {
        try { return JSON.parse(sessionStorage.getItem(SNAP_KEY) || 'null'); } catch (e) { return null; }
      };
      const save = (s) => { try { sessionStorage.setItem(SNAP_KEY, JSON.stringify(s)); } catch (e) {} };
      const baseSnapshot = (base) => {
        const existing = load();
        if (existing) return existing;
        const init = Object.assign({}, base, {
          version: 1, peerStatus: 'online', peerError: '', peerErrorType: '',
          secured: true, fingerprint: base.fingerprint || 'e'.repeat(40), inbound: [],
          state: Object.assign({ version: 1, friends: [], messages: {},
            settings: { allowBroadcast: false, allowIncoming: true, nickname: '',
              reply: { mode: 'off', permission: 'read', provider: '', model: '', reasoningEffort: '', sessionMode: 'dedicated', sessionId: '', cwd: '' } } }, base.state || {}),
        });
        save(init);
        return init;
      };
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/pm-net/state')) {
          const res = await originalFetch(input, init);
          let base = {}; try { base = await res.json(); } catch (e) {}
          return new Response(JSON.stringify(baseSnapshot(base)), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/pm-net/action')) {
          let body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
          const snap = baseSnapshot({});
          const now = Date.now();
          const act = body.action;
          if (act === 'addFriend' && typeof body.id === 'string') {
            if (!snap.state.friends.some((f) => f.id === body.id)) {
              snap.state.friends.push({ id: body.id, name: body.id.slice(0, 8), alias: '', note: '', online: true, unread: 0, lastMsg: '', lastTs: now, verified: false, fingerprint: '' });
              snap.state.messages[body.id] = snap.state.messages[body.id] || [];
              snap.version += 1; save(snap);
            }
          } else if (act === 'patchFriend' && typeof body.id === 'string') {
            const f = snap.state.friends.find((x) => x.id === body.id);
            if (f && body.patch) { Object.assign(f, body.patch); snap.version += 1; save(snap); }
          } else if (act === 'patchSettings' && body.patch) {
            Object.assign(snap.state.settings, body.patch); snap.version += 1; save(snap);
          } else if (act === 'send') {
            const list = snap.state.messages[body.id] = snap.state.messages[body.id] || [];
            list.push({ from: 'me', text: body.text, ts: now, origin: 'human', trigger: body.trigger || 'human' });
            snap.version += 1; save(snap);
          } else if (act === 'removeFriend' && typeof body.id === 'string') {
            snap.state.friends = snap.state.friends.filter((f) => f.id !== body.id);
            snap.version += 1; save(snap);
          }
          return new Response(JSON.stringify({ ok: true, snapshot: snap }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return originalFetch(input, init);
      };
    })();
  `;
}

async function newIsolatedPage(url, opts) {
  const o = opts || {};
  const browser = await chromium.launch({ executablePath: '/home/lumin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 900 }, colorScheme: o.theme || 'dark' });
  await context.addInitScript(isolatedInitScript());
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__DSH_PM_SERVICE__, null, { timeout: 30000 });
  return { browser, context, page };
}

const token = () => fs.readFileSync('/tmp/dsh-token.txt', 'utf8').trim();
const url = () => 'http://127.0.0.1:3080/?token=' + token();

module.exports = { newIsolatedPage, url, token };
