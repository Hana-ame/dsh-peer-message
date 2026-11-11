import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 「模型决定的回复」vs「人决定的回复」不能只靠文本前缀：这里守卫来源标记的
// 解析、入站/出站落库字段、以及 UI 徽标接线。
const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const NET = readFileSync(new URL('../server/network.js', import.meta.url), 'utf8');
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
  // 入站解析现在在 Host（server/network.js），浏览器只渲染快照里的 origin/trigger。
  const handler = slice(NET, 'async function handleData(remoteId, data) {', "if (data && typeof data === 'object' && data.type === 'hello') {");
  assert.ok(handler.includes('modelTextInfo(text)'), '入站未解析来源标记');
  assert.ok(handler.includes('const display = info.isModel ? info.display : text'), '未剥离标记');
  assert.ok(handler.includes("const origin = info.isModel ? 'model' : 'human'"), '未计算来源');
  assert.ok(handler.includes("origin, trigger: info.trigger"), '消息未落 origin/trigger 字段');
  assert.ok(handler.includes('lastOrigin: origin') && handler.includes('lastTrigger: info.trigger'));
  // 现在每条消息都带来源徽标（人/AI 都标），不再是只给 model 渲染。
  assert.ok(CLIENT.includes("h('div', { className: 'pm-msg-origin' + (isHumanOrigin(m.trigger) ? ' pm-origin-human' : ' pm-origin-ai') }"), 'UI 未渲染来源徽标');
});

test('origin: 出站投递在 Host 侧按 trigger 写回标记与来源', () => {
  const deliver = slice(NET, 'deliverReply(to, replyText, meta) {', 'hasConn(id) {');
  assert.ok(deliver.includes("meta.trigger === 'manual' || meta.trigger === 'auto' || meta.trigger === 'agent'"), '缺省 trigger 未归一');
  assert.ok(deliver.includes('AUTO_REPLY_PREFIX + MANUAL_APPROVAL_MARKER + clean'), '人工批准未加标记');
  assert.ok(deliver.includes('AI_AGENT_PREFIX + clean'), 'Agent 消息未加标记');
  assert.ok(deliver.includes('AUTO_REPLY_PREFIX + clean'), '自动回复未加标记');
  assert.ok(deliver.includes("lastOrigin: 'model', lastTrigger: trigger"));
  assert.ok(deliver.includes("appendMessage(to, { from: 'me'"), '投递未落库');
});

test('origin: 人类发送的消息被标记为 human', () => {
  const send = slice(NET, 'send(id, text, trigger) {', 'addFriend(id) {');
  assert.ok(send.includes("lastOrigin: 'human'"), '人类消息缺少 human 来源');
  assert.ok(send.includes("const kind = trigger === 'human-reply' ? 'human-reply' : 'human'"), '未区分人工回复');
  assert.ok(send.includes("origin: 'human', trigger: kind"), '未落 human 来源/触发方式');
  // 浏览器发消息只 POST 给 Host，不自己拼来源（trigger 由 Host 归一）
  assert.ok(CLIENT.includes("this.postAction('send', { id, text, trigger: trigger === 'human-reply' ? 'human-reply' : 'human' })"));
});

test('origin: 模型标记消息不会再次触发自动回复（防 AI 互刷）', () => {
  // Host 侧入站就拒绝模型文本入队，浏览器侧触发前再守一次。
  assert.ok(NET.includes('if (!info.isModel) {'), 'Host 未过滤模型消息');
  assert.ok(NET.includes('net.inbound.push'), 'Host 未把人类入站文本交给回复管线');
  const req = slice(CLIENT, 'maybeRequestReply(peerId, text) {', 'async postReplyControl(kind, id) {');
  assert.ok(req.includes('isModelText(clean)'), '循环守卫未覆盖 [AI] 标记');
  assert.ok(!req.includes('startsWith(AUTO_REPLY_PREFIX)'), '仍只识别旧的自动回复前缀');
});

test('origin: UI 渲染 AI 徽标，并按触发方式细分文案', () => {
  assert.ok(CLIENT.includes('function originLabel(trigger, from)'));
  assert.ok(CLIENT.includes("'AI · 你已批准'") && CLIENT.includes("'AI · 自动回复'") && CLIENT.includes("'AI · Agent 发送'"));
  // 所有消息都渲来源徽标：👤 人工 / AI 模型
  assert.ok(CLIENT.includes("h('div', { className: 'pm-msg-origin' + (isHumanOrigin(m.trigger) ? ' pm-origin-human' : ' pm-origin-ai') }"));
  assert.ok(CLIENT.includes("'人工 · 你回复'") && CLIENT.includes("'人工 · 对方回复'"), '未区分人工回复文案');
  assert.ok(CLIENT.includes('function originIcon(trigger)') && CLIENT.includes('function isHumanOrigin(trigger)'));
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

test('origin: 人可以直接人工回复（待批准弹窗内写回复替代模型草稿）', () => {
  // 服务层：人工回复走独立方法，trigger=human-reply
  assert.ok(CLIENT.includes('async sendHumanMessage(id, draft, trigger)'), '缺少人工回复发送方法');
  assert.ok(CLIENT.includes("trigger: trigger === 'human-reply' ? 'human-reply' : 'human'"));
  // 待批准弹窗内可写人工回复
  assert.ok(CLIENT.includes("className: 'pm-pending-human'"), '待批准弹窗缺少人工回复区');
  assert.ok(CLIENT.includes("placeholder: '输入你要说的话…'"));
  assert.ok(CLIENT.includes("'发送人工回复'"), '缺少发送人工回复按钮');
  // 发送后丢弃模型草稿并提示
  assert.ok(CLIENT.includes('pmService.rejectReply(item.id)'), '人工回复后未丢弃模型草稿');
  assert.ok(CLIENT.includes("'已发送人工回复（模型草稿已丢弃）'"));
  // Host 侧对人工回复不做任何模型标记（对端看到真人消息）
  assert.ok(NET.includes("const kind = trigger === 'human-reply' ? 'human-reply' : 'human'"));
  assert.ok(NET.includes('conn.send(clean);'), '人工回复不应加模型标记');
  assert.ok(!NET.includes("kind === 'human-reply' ? wrap"), '人工回复被错误套用模型标记');
  // 明确的来源文案：人 vs AI
  assert.ok(CLIENT.includes("'人工 · 你'") && CLIENT.includes("'人工 · 对方'"));
});
