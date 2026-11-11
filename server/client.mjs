/**
 * Daemon 客户端：把 `<dataDir>/net.sock` 上的 JSON-over-HTTP 包装成一个对象。
 *
 * 除了给 DSH 的 /api/pm-net/* 代理使用，也可以被脚本、其它进程、将来的前端
 * 直接 import——这样「怎么调 daemon」只有一处实现，不会再出现各脚本各写一套
 * 半成品（之前测试脚本绕过 API 直接改 state.json 就污染过真实数据）。
 *
 * 用法：
 *   const net = createDaemonClient('/home/you/.dsh/peer-message');
 *   await net.state();                      // 快照
 *   await net.addFriend('dsh-pm-...');
 *   await net.deliver(to, text, { trigger: 'auto' });
 *   await net.call('patchSettings', { patch: { reply: { mode: 'off' } } });
 */

import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 20000;

export function createDaemonClient(dataDir, options = {}) {
  const sockPath = join(dataDir, 'net.sock');
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  function callRaw(method, path, payload, signal) {
    return new Promise((resolve, reject) => {
      const body = payload === undefined || payload === null ? null : JSON.stringify(payload);
      const request = httpRequest({
        socketPath: sockPath,
        path,
        method,
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
        timeout,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try { resolve(JSON.parse(text || '{}')); } catch (error) { reject(new Error(`daemon invalid json: ${text.slice(0, 120)}`)); }
        });
      });
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('daemon timeout')));
      if (signal) signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
      if (body) request.write(body);
      request.end();
    });
  }

  return {
    dataDir,
    sockPath,
    /** 原始调用，用于新增端点时先跑通再接方法。 */
    callRaw,
    health: () => callRaw('GET', '/health'),
    /** 自描述：有哪些端点、哪些 action、字段是什么。 */
    api: () => callRaw('GET', '/api'),
    state: (signal) => callRaw('GET', '/state', undefined, signal),
    drainInbound: () => callRaw('POST', '/inbound'),
    migrate: (payload) => callRaw('POST', '/migrate', payload),

    /** 通用 action 调用。name 必须在 GET /api 的 actions 列表里。 */
    call: (action, fields = {}) => callRaw('POST', '/action', Object.assign({ action }, fields)),
    send: (id, text, trigger) => callRaw('POST', '/action', { action: 'send', id, text, trigger }),
    addFriend: (id) => callRaw('POST', '/action', { action: 'addFriend', id }),
    removeFriend: (id) => callRaw('POST', '/action', { action: 'removeFriend', id }),
    markRead: (id) => callRaw('POST', '/action', { action: 'markRead', id }),
    patchFriend: (id, patch) => callRaw('POST', '/action', { action: 'patchFriend', id, patch }),
    patchSettings: (patch) => callRaw('POST', '/action', { action: 'patchSettings', patch }),
    retryPeer: () => callRaw('POST', '/action', { action: 'retryPeer' }),
    rotateIdentity: () => callRaw('POST', '/action', { action: 'rotateIdentity' }),
    /** 模型/agent 出站消息（自动回复、pm_send）。 */
    deliver: (to, text, meta) => callRaw('POST', '/deliver', { to, text, meta }),
  };
}
