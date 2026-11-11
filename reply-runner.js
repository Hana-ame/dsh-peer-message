/**
 * Host-side auto-reply runner.
 *
 * Flow: an inbound P2P message arrives in the browser half, which POSTs it to
 * `/api/pm-reply/request`. This runner either parks it for manual approval or
 * starts one agent turn in a DSH session, waits for the assistant's final text,
 * and pushes that text into the shared outbox addressed back to the sender.
 *
 * Security posture:
 * - inbound text is untrusted data, fenced by `buildReplyPrompt`;
 * - the capability mode is enforced twice: a `tools/pre-execute` guard denies
 *   disallowed tools outright, and a sandbox/approval pair is appended to the
 *   session for defense in depth;
 * - per-peer/global rate gates and the pending cap bound model spend;
 * - outgoing replies are prefixed with `[自动回复] ` and the browser half never
 *   triggers another reply for a marked message, breaking ping-pong loops.
 *
 * The module is dependency-injected so it can be unit-tested with fake Cordis
 * services; index.js wires the real ones.
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  MAX_PENDING_REPLIES,
  MAX_RECENT_REPLIES,
  buildReplyPrompt,
  coerceReplyConfig,
  createRateGate,
  decideToolCall,
  isAutoReplyText,
  isModelText,
  permissionPolicyFor,
  sanitizeInboundText,
  sanitizeReplyText,
  wrapAutoReply,
  wrapManualReply,
} from './reply-core.js';

/** How long one reply turn may run before it is abandoned. */
const DEFAULT_MAX_REPLY_MS = 180000;

function errorMessage(error) {
  if (error && typeof error.message === 'string') return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function pickAgent(resolved) {
  if (resolved && resolved.error) throw resolved.error;
  if (resolved && resolved.agent) return resolved.agent;
  throw new Error('无法解析回复会话的 Agent');
}

/**
 * @param {{
 *   on: (event: string, handler: (...args: any[]) => void) => (() => void),
 *   controller: {create: Function, resolveAgent: Function, selectModel: Function, prompt: Function},
 *   projections?: {snapshot: Function},
 *   pushOutbox: (item: {id: string, to: string, text: string, ts: number}) => void,
 *   logger?: {warn: Function},
 *   defaultCwd: string,
 *   maxReplyMs?: number,
 *   maxPending?: number,
 *   maxRecent?: number,
 *   now?: () => number,
 *   uuid?: () => string,
 * }} deps
 */
export function createReplyRunner(deps) {
  if (typeof deps.on !== 'function' || !deps.controller || typeof deps.pushOutbox !== 'function') {
    throw new Error('reply-runner: on/controller/pushOutbox dependencies are required');
  }
  const emit = deps.on;
  const now = deps.now || (() => Date.now());
  const uuid = deps.uuid || (() => randomUUID());
  const maxReplyMs = Number.isFinite(deps.maxReplyMs) ? deps.maxReplyMs : DEFAULT_MAX_REPLY_MS;
  const maxPending = Number.isFinite(deps.maxPending) ? deps.maxPending : MAX_PENDING_REPLIES;
  const maxRecent = Number.isFinite(deps.maxRecent) ? deps.maxRecent : MAX_RECENT_REPLIES;
  const logger = deps.logger || { warn() {} };

  /** id -> parked request awaiting a human decision */
  const pending = new Map();
  /** runId -> in-flight run */
  const running = new Map();
  /** newest-first finished runs */
  let recent = [];
  /** peerId -> dedicated session id */
  const peerSessions = new Map();
  /** sessionId -> tool family enforced by the pre-execute guard */
  const sessionTools = new Map();
  const rate = createRateGate(deps.rateOptions);
  let disposed = false;

  function remember(entry) {
    recent = [entry, ...recent].slice(0, maxRecent);
  }

  /** Append the capability pair to a session log (idempotent per run). */
  function appendPolicy(session, policy) {
    session.append('sandbox/mode', { mode: policy.sandbox });
    session.append('approval/policy', { policy: policy.approval });
  }

  /** Best-effort read of the session's previous capability pair. */
  function readKnobs(session) {
    if (!deps.projections || typeof deps.projections.snapshot !== 'function') return null;
    try {
      const snap = deps.projections.snapshot(session, ['sandboxMode', 'permissions']);
      const values = (snap && snap.values) || {};
      const sandbox = values.sandboxMode || (values.permissions && values.permissions.sandbox) || null;
      const approval = (values.permissions && values.permissions.approval) || null;
      return {
        sandbox: sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access' ? sandbox : null,
        approval: approval === 'ask' || approval === 'never' ? approval : null,
      };
    } catch (error) {
      logger.warn(`p2p-reply: could not read previous session policy: ${errorMessage(error)}`);
      return null;
    }
  }

  function restoreKnobs(session, knobs) {
    if (!knobs) return;
    try {
      if (knobs.sandbox) session.append('sandbox/mode', { mode: knobs.sandbox });
      if (knobs.approval) session.append('approval/policy', { policy: knobs.approval });
    } catch (error) {
      logger.warn(`p2p-reply: could not restore session policy: ${errorMessage(error)}`);
    }
  }

  /**
   * Resolve or create the session that will answer one peer.
   * @returns {Promise<{sessionId: string, session: any, owned: boolean}>}
   */
  async function ensureSession(record) {
    const cfg = record.config;
    if (cfg.sessionMode === 'existing') {
      if (!cfg.sessionId) throw new Error('回复配置选择「现有会话」，但没有指定会话');
      if (cfg.sessionId.startsWith('session-') === false && cfg.sessionId.length < 8) throw new Error('现有会话 ID 不合法');
      const resolved = await deps.controller.resolveAgent(cfg.sessionId);
      const agent = pickAgent(resolved);
      return { sessionId: cfg.sessionId, session: agent.session, owned: false };
    }
    const cached = peerSessions.get(record.peerId);
    if (cached) {
      try {
        const resolved = await deps.controller.resolveAgent(cached);
        const agent = pickAgent(resolved);
        return { sessionId: cached, session: agent.session, owned: true };
      } catch (error) {
        logger.warn(`p2p-reply: cached session ${cached} is gone: ${errorMessage(error)}`);
        peerSessions.delete(record.peerId);
      }
    }
    if (cfg.cwd && !isAbsolute(cfg.cwd)) throw new Error('工作路径必须是绝对路径（例如 /home/user/project）');
    const created = await deps.controller.create({ cwd: cfg.cwd || deps.defaultCwd });
    if (!created || typeof created.sessionId !== 'string') throw new Error('创建回复会话失败');
    peerSessions.set(record.peerId, created.sessionId);
    const resolved = await deps.controller.resolveAgent(created.sessionId);
    const agent = pickAgent(resolved);
    return { sessionId: created.sessionId, session: agent.session, owned: true };
  }

  /**
   * Ask the session agent to answer, collecting the last assistant text of the
   * turn our prompt opened. Resolves on `turn/end` for that exact turn.
   * @returns {Promise<string>}
   */
  function promptAndCollect(sessionId, promptText, requestId) {
    return new Promise((resolve, reject) => {
      let turn = null;
      let lastText = '';
      let settled = false;
      let timer;
      let off = () => {};

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { off(); } catch (error_) { logger.warn(`p2p-reply: event unsubscribe failed: ${errorMessage(error_)}`); }
        if (error) reject(error);
        else resolve(value);
      };

      off = emit('session/event', (session, event) => {
        if (settled || !session || session.id !== sessionId) return;
        const type = event && event.type;
        const data = event && event.data;
        if (type === 'turn/start') {
          if (turn === null) turn = data.turn;
          return;
        }
        if (type === 'assistant/message' && turn !== null && data && data.turn === turn) {
          const content = (data.message && Array.isArray(data.message.content)) ? data.message.content : [];
          const text = content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim();
          if (text) lastText = text;
          return;
        }
        if (type === 'turn/end' && turn !== null && data && data.turn === turn) {
          finish(lastText ? null : new Error('模型没有生成可发送的回复'), lastText);
        }
      });

      timer = setTimeout(() => finish(new Error(`自动回复超时（${Math.round(maxReplyMs / 1000)}s）`)), maxReplyMs);

      Promise.resolve()
        .then(() => deps.controller.prompt({
          sessionId,
          content: [{ type: 'text', text: promptText }],
          requestId,
          mode: 'queue',
        }, new AbortController().signal))
        .catch((error) => finish(error));
    });
  }

  async function run(record) {
    const runId = 'reply-' + uuid();
    const entry = {
      id: runId,
      requestId: record.id,
      peerId: record.peerId,
      status: 'running',
      startedAt: now(),
      text: record.text.slice(0, 500),
      config: record.config,
    };
    running.set(runId, entry);
    let session = null;
    let restore = null;
    try {
      session = await ensureSession(record);
      if (disposed) throw new Error('插件已卸载，取消自动回复');
      entry.sessionId = session.sessionId;
      const policy = permissionPolicyFor(record.config.permission);
      sessionTools.set(session.sessionId, policy.tools);
      if (!session.owned) restore = readKnobs(session.session);
      appendPolicy(session.session, policy);

      if (record.config.provider && record.config.model) {
        await deps.controller.selectModel({
          sessionId: session.sessionId,
          provider: record.config.provider,
          model: record.config.model,
          ...(record.config.reasoningEffort ? { reasoningEffort: record.config.reasoningEffort } : {}),
        });
      }

      const promptText = buildReplyPrompt({
        peerId: record.peerId,
        peerName: record.peerName,
        text: record.text,
      });
      const replyText = await promptAndCollect(session.sessionId, promptText, 'pm-reply-' + uuid());
      const clean = sanitizeReplyText(replyText);
      if (!clean) throw new Error('模型没有生成可发送的回复');
      // 人工批准 vs 自动决定在 wire 上也区分：前者多一个 [人工批准] 内层标记。
      const outgoing = record.trigger === 'manual' ? wrapManualReply(clean) : wrapAutoReply(clean);
      if (disposed) throw new Error('插件已卸载，取消自动回复');
      deps.pushOutbox({
        id: 'pm-auto-' + uuid(),
        to: record.peerId,
        text: outgoing,
        ts: now(),
        // origin/trigger 让浏览器端区分「模型自动决定」与「人工批准后发送」；
        // text 仍带 [自动回复] 标记，对方也能据此判定为 AI 消息。
        meta: {
          origin: 'model',
          trigger: record.trigger === 'manual' ? 'manual' : 'auto',
          model: record.config.model || '',
        },
      });
      entry.status = 'sent';
      entry.reply = outgoing;
      entry.finishedAt = now();
      remember(entry);
    } catch (error) {
      entry.status = 'failed';
      entry.error = errorMessage(error);
      entry.finishedAt = now();
      remember(entry);
      logger.warn(`p2p-reply: run ${runId} failed: ${errorMessage(error)}`);
      if (error && typeof error.stack === 'string') logger.warn(`p2p-reply: stack: ${error.stack.slice(0, 1800)}`);
    } finally {
      running.delete(runId);
      if (session && !session.owned) restoreKnobs(session.session, restore);
      if (session && session.owned && disposed) {
        // Dedicated sessions keep their capability pair; nothing to restore.
      }
    }
    return entry;
  }

  return {
    /**
     * Accept one inbound message. Manual mode parks it; auto mode starts a run.
     * @param {{peerId: string, peerName?: string, text: string, config: unknown}} input
     * @returns {{accepted: boolean, reason?: string, mode?: 'manual'|'auto', pendingId?: string, requestId?: string, pendingCount?: number, retryAfterMs?: number}}
     */
    request(input) {
      if (disposed) return { accepted: false, reason: 'disposed' };
      const config = coerceReplyConfig(input && input.config);
      if (config.mode === 'off') return { accepted: false, reason: 'off' };
      const text = sanitizeInboundText(input && input.text);
      if (!text) return { accepted: false, reason: 'empty' };
      if (isModelText(text)) return { accepted: false, reason: 'model-marker' };
      const peerId = typeof (input && input.peerId) === 'string' ? input.peerId.trim() : '';
      if (!peerId) return { accepted: false, reason: 'bad-peer' };
      const gate = rate.check(peerId, now());
      if (!gate.ok) return { accepted: false, reason: gate.reason, retryAfterMs: gate.retryAfterMs };

      const record = {
        id: 'req-' + uuid(),
        peerId,
        peerName: typeof input.peerName === 'string' ? input.peerName.slice(0, 80) : '',
        text,
        config,
        // auto 模式由模型直接决定；manual 由人批准后才运行。
        trigger: config.mode === 'auto' ? 'auto' : 'manual',
        ts: now(),
      };

      if (config.mode === 'manual') {
        if (pending.size >= maxPending) return { accepted: false, reason: 'pending-full' };
        pending.set(record.id, record);
        return { accepted: true, mode: 'manual', pendingId: record.id, pendingCount: pending.size };
      }

      run(record);
      return { accepted: true, mode: 'auto', requestId: record.id };
    },

    /** Approve one parked manual request and start its reply run. */
    approve(pendingId) {
      const record = pending.get(pendingId);
      if (!record) return { ok: false, error: 'pending-not-found' };
      pending.delete(pendingId);
      run(record);
      return { ok: true, requestId: record.id };
    },

    /** Drop one parked manual request. */
    reject(pendingId) {
      if (!pending.has(pendingId)) return { ok: false, error: 'pending-not-found' };
      pending.delete(pendingId);
      return { ok: true };
    },

    /** Drop every parked manual request. */
    rejectAll() {
      const count = pending.size;
      pending.clear();
      return { ok: true, removed: count };
    },

    /** Client-facing view; never includes session objects. */
    snapshot() {
      return {
        pending: [...pending.values()].map((record) => ({
          id: record.id,
          peerId: record.peerId,
          peerName: record.peerName,
          text: record.text,
          ts: record.ts,
          permission: record.config.permission,
          sessionMode: record.config.sessionMode,
        })),
        running: [...running.values()].map((entry) => ({
          id: entry.id,
          peerId: entry.peerId,
          status: entry.status,
          sessionId: entry.sessionId,
          startedAt: entry.startedAt,
        })),
        recent: recent.map((entry) => ({
          id: entry.id,
          peerId: entry.peerId,
          status: entry.status,
          sessionId: entry.sessionId,
          reply: entry.reply,
          error: entry.error,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        })),
      };
    },

    /**
     * `tools/pre-execute` decision for reply sessions, or undefined when the
     * call belongs to an unrelated session.
     */
    toolDecisionFor(exec) {
      const sessionId = exec && exec.agent && exec.agent.session && exec.agent.session.id;
      if (!sessionId) return undefined;
      const tools = sessionTools.get(sessionId);
      if (tools === undefined) return undefined;
      const name = exec && typeof exec.name === 'string' ? exec.name : 'unknown';
      if (tools === 'all') return undefined;
      const decision = decideToolCall(tools, name);
      return decision && decision.kind === 'deny' ? decision : undefined;
    },

    /** Dispose in-memory state; in-flight runs finish but cannot enqueue. */
    dispose() {
      disposed = true;
      pending.clear();
      sessionTools.clear();
    },
  };
}