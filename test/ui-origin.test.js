import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 「模型决定的回复」vs「人决定的回复」不能只靠文本前缀：这里守卫来源标记的
// 解析、入站/出站落库字段、以及 UI 徽标接线。
const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const RUNNER = readFileSync(new URL('../reply-runner.js', import.meta.url), 'utf8');
const TOOL = readFileSync(new URL('../tool.js', import.meta.url), 'utf8');

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  assert.ok(start >= 0, 'missing marker: ' + startMarker);
  assert.ok(end > start, 'missing end marker: ' + endMarker);
  return src.slice(start, end);
}

const AUTO_REPLY_PREFIX = '[自动回复] ';
const AI_AGENT_PREFIX = '[AI] ';
const MANUAL_APPROVAL_MARKER = '[人工批准] ';
const MODEL_TEXT_PREFIXES = [
  { prefix: AUTO_REPLY_PREFIX, trigger: 'auto' },
  { prefix: AI_AGENT_PREFIX, trigger: 'agent' },
];

// 复刻 client.js 的分类器（与 reply-core.modelTextInfo 语义一致）
function modelTextInfo(text) {
  if (typeof text !== 'string') return { isModel: false, trigger: 'human', display: '' };
  const leading = text.length - text.trimStart().length;
  const body = text.slice(leading);
  for (const { prefix, trigger } of MODEL_TEXT_PREFIXES) {
    if (!body.startsWith(prefix)) continue;
    const rest = body.slice(prefix.length).trim();
    if (trigger === 'auto' && rest.startsWith(MANUAL_APPROVAL_MARKER)) {
      return { isModel: true, trigger: 'manual', display: rest.slice(MANUAL_APPROVAL_MARKER.length).trim() };
    }
    return { isModel: true, trigger, display: rest };
  }
  return { isModel: false, trigger: 'human', display: text };
}

test('origin: 三类标记语义——人类无标记 / 自动回复 / Agent', () => {
  assert.deepEqual(modelTextInfo('我手打的消息'), { isModel: false, trigger: 'human', display: '我手打的消息' });
  assert.deepEqual(modelTextInfo(AUTO_REPLY_PREFIX + '模型回复'), { isModel: true, trigger: 'auto', display: '模型回复' });
  assert.deepEqual(modelTextInfo(AI_AGENT_PREFIX + 'Agent 结果'), { isModel: true, trigger: 'agent', display: 'Agent 结果' });
  assert.deepEqual(modelTextInfo(AUTO_REPLY_PREFIX + MANUAL_APPROVAL_MARKER + '已批准'), { isModel: true, trigger: 'manual', display: '已批准' });
});

test('origin: 客户端不再把 [自动回复] 前缀当正文重复显示', () => {
  const handler = slice(CLIENT, 'handleData(remoteId, data) {', "} else if (data && typeof data === 'object') {");
  assert.ok(handler.includes('modelTextInfo(text)'), '入站未解析来源标记');
  assert.ok(handler.includes('const display = info.isModel ? info.display : text'), '未剥离标记');
  assert.ok(handler.includes("const origin = info.isModel ? 'model' : 'human'"), '未计算来源');
  assert.ok(handler.includes("origin, trigger: info.trigger"), '消息未落 origin/trigger 字段');
  assert.ok(handler.includes('lastOrigin: origin') && handler.includes('lastTrigger: info.trigger'));
});

test('origin: 出站队列按 meta 区分自动/人工批准/Agent，并给旧队列项补 [AI]', () => {
  const deliver = slice(CLIENT, 'async deliverQueued(item) {', '// ── 自动回复（Host 回气管线）');
  assert.ok(deliver.includes("meta.origin === 'model' || info.isModel || meta.origin === undefined"), '缺省应视为模型来源');
  assert.ok(deliver.includes("meta.trigger === 'manual' || meta.trigger === 'auto' || meta.trigger === 'agent'"));
  assert.ok(deliver.includes('AI_AGENT_PREFIX + rawText'), '旧队列项未补 AI 标记');
  assert.ok(deliver.includes("origin: isModel ? 'model' : 'human', trigger"));
  assert.ok(deliver.includes('lastOrigin') && deliver.includes('lastTrigger'));
  assert.ok(deliver.includes('已投递自动回复') && deliver.includes('已投递已批准的回复'));
});

test('origin: 人类发送的消息被标记为 human', () => {
  const send = slice(CLIENT, 'sendMessage(id, draft) {', 'markRead(id) {');
  assert.ok(send.includes("origin: 'human', trigger: 'human'"), '人类消息缺少 human 来源');
  assert.ok(send.includes("lastOrigin: 'human'"));
});

test('origin: 模型标记消息不会再次触发自动回复（防 AI 互刷）', () => {
  const req = slice(CLIENT, 'maybeRequestReply(peerId, text) {', '// ── 面板调用的操作');
  assert.ok(req.includes('isModelText(clean)'), '循环守卫未覆盖 [AI] 标记');
  assert.ok(!req.includes('startsWith(AUTO_REPLY_PREFIX)'), '仍只识别旧的自动回复前缀');
});

test('origin: UI 渲染 AI 徽标，并按触发方式细分文案', () => {
  assert.ok(CLIENT.includes('function originLabel(trigger, from)'));
  assert.ok(CLIENT.includes("'AI · 你已批准'") && CLIENT.includes("'AI · 自动回复'") && CLIENT.includes("'AI · Agent 发送'"));
  assert.ok(CLIENT.includes("m.origin === 'model' ? h('div', { className: 'pm-msg-origin' }"));
  assert.ok(CLIENT.includes('originLabel(m.trigger, m.from)'));
  assert.ok(CLIENT.includes("f.lastOrigin === 'model' ? 'AI｜' : ''"), '好友列表最近消息未标 AI');
  assert.ok(CLIENT.includes("'AI · 模型生成 · 待批准'"), '待批准项未标 AI');
});

test('origin: Host runner 给 outbox 写入 origin/trigger/meta', () => {
  assert.ok(RUNNER.includes("trigger: config.mode === 'auto' ? 'auto' : 'manual'"), '未记录 auto/manual 触发');
  assert.ok(RUNNER.includes("origin: 'model'"), 'outbox 缺少 model 来源');
  assert.ok(RUNNER.includes("trigger: record.trigger === 'manual' ? 'manual' : 'auto'"));
  assert.ok(RUNNER.includes('isModelText(text)'), 'Host 未拒绝带模型标记的消息');
});

test('origin: pm_send 工具消息标记为 model/agent', () => {
  assert.ok(TOOL.includes("meta: { origin: 'model', trigger: 'agent' }"));
});