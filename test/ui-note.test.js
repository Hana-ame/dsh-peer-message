import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 好友备注：本机持久化 + 注入自动回复上下文（可信上下文，不混入不可信正文）。
const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const RUNNER = readFileSync(new URL('../reply-runner.js', import.meta.url), 'utf8');
const CORE = readFileSync(new URL('../reply-core.js', import.meta.url), 'utf8');
const HOST = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const NET = readFileSync(new URL('../server/network.js', import.meta.url), 'utf8');

function slice(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  assert.ok(a >= 0, 'missing: ' + start);
  assert.ok(b > a, 'missing end: ' + end);
  return src.slice(a, b);
}

test('note: 备注字段随好友持久化，新建好友带空 note', () => {
  assert.ok(CLIENT.includes('MAX_NOTE_LEN = 500'));
  assert.ok(CLIENT.includes('setFriendNote(id, raw)'));
  assert.ok(CLIENT.includes('setFriendProfile(id, aliasRaw, noteRaw)'));
  // 新好友由 Host 侧 upsertFriend 初始化 alias/note，浏览器只渲染。
  assert.ok(NET.includes("alias: '', note: ''"), 'Host 新好友未初始化 note');
});

test('note: 备注弹窗同时编辑显示名与上下文备注', () => {
  assert.ok(CLIENT.includes("'好友备注'"));
  assert.ok(CLIENT.includes('显示备注名（本机显示用）'));
  assert.ok(CLIENT.includes('备注内容（注入自动回复上下文）'));
  assert.ok(CLIENT.includes('pm-note-input'));
  assert.ok(CLIENT.includes('maxLength: MAX_NOTE_LEN'));
  assert.ok(CLIENT.includes('pmService.setFriendProfile(editFriend.id'));
  assert.ok(CLIENT.includes('可信的本机上下文'), '弹窗缺少注入说明');
});

test('note: 有备注的好友在列表显示 📝 标记', () => {
  assert.ok(CLIENT.includes("f.note ? h('span', { className: 'pm-friend-note'"));
  assert.ok(CLIENT.includes("title: '好友备注（注入自动回复上下文）：'"));
});

test('note: 自动回复请求把备注一并发给 Host', () => {
  const block = slice(CLIENT, 'maybeRequestReply(peerId, text) {', 'async postReplyControl(kind, id) {');
  assert.ok(block.includes('peerNote: friend && typeof friend.note'), '请求未携带 peerNote');
});

test('note: Host 路由接收 peerNote 并注入 reply prompt', () => {
  assert.ok(HOST.includes('peerNote: typeof body?.peerNote'));
  assert.ok(RUNNER.includes('peerNote: sanitizePeerNote(input && input.peerNote)'));
  assert.ok(RUNNER.includes('peerNote: record.peerNote'));
  assert.ok(RUNNER.includes('peerNote: record.peerNote,'), 'buildReplyPrompt 未接备注');
  assert.ok(CORE.includes('export function sanitizePeerNote'));
  assert.ok(CORE.includes('MAX_PEER_NOTE'));
});

test('note: 待批准队列/弹窗显示本机备注', () => {
  assert.ok(RUNNER.includes('peerNote: record.peerNote,'), 'pending 快照未包含备注');
  assert.ok(CLIENT.includes("item.peerNote ? h('div', { className: 'pm-pending-note' }"));
});

test('note: 备注作为可信块放在不可信正文之前，且围栏被转义', () => {
  const core = slice(CORE, 'export function buildReplyPrompt(input) {', 'export function createRateGate');
  assert.ok(core.includes("'<peer_note>'"));
  assert.ok(core.includes('本机用户为该好友维护的备注'));
  assert.ok(core.indexOf('</peer_note>') < core.indexOf('<incoming_p2p_message>'), '备注应在正文之前');
  assert.ok(core.includes("defangFenceTags(note"), '备注围栏未转义');
});
