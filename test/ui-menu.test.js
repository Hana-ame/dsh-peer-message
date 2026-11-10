import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// client.js 是浏览器模块（window.__ModuleLoader__），不能直接 import；
// 这里做两件事：
//   1) 静态回归守卫——右键/删除路径一旦退回“右键直接删”就红。
//   2) 复刻 clampMenuPosition 做边界单测（两处必须同步，同 validate/toggle 测试约定）。
const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const LINES = SRC.split('\n');

// ── 复刻 client.js 的 clampMenuPosition ─────────────────────────────────────
function clampMenuPosition(x, y, vw, vh, mw, mh) {
  const margin = 8;
  const left = Math.max(margin, Math.min(x, vw - mw - margin));
  const top = Math.max(margin, Math.min(y, vh - mh - margin));
  return { left, top };
}

test('ui-menu: 视口内右键，菜单定位保持光标坐标', () => {
  assert.deepEqual(clampMenuPosition(300, 240, 1280, 800, 200, 210), { left: 300, top: 240 });
});

test('ui-menu: 右/下边缘右键，菜单被夹回视口内（不裁切删除项）', () => {
  // 1280x800 视口、200x210 菜单：右下极限 = 1280-200-8 / 800-210-8
  assert.deepEqual(clampMenuPosition(1279, 799, 1280, 800, 200, 210), { left: 1072, top: 582 });
  // 负坐标（少见的合成事件）也不越左/上边界
  assert.deepEqual(clampMenuPosition(-20, -20, 1280, 800, 200, 210), { left: 8, top: 8 });
});

test('ui-menu: 小视口下菜单仍保留 8px 边距（不出现负坐标）', () => {
  const pos = clampMenuPosition(50, 50, 320, 240, 200, 210);
  assert.ok(pos.left >= 8);
  assert.ok(pos.top >= 8);
});

test('ui-menu: 好友行右键只打开菜单，不再直接调用 removeFriend（防误删回归）', () => {
  const handler = LINES.find(line => line.includes('onContextMenu: (e) => openCtxMenu(e, f)'));
  assert.ok(handler, '好友行的 onContextMenu 应调用 openCtxMenu');
  const direct = LINES.filter(line => line.includes('onContextMenu') && line.includes('removeFriend'));
  assert.equal(direct.length, 0, 'onContextMenu 行里不应出现 removeFriend: ' + direct.join(' | '));
});

test('ui-menu: removeFriend 的唯一调用点是确认框里的 doDeleteFriend', () => {
  const calls = LINES.filter(line => line.includes('pmService.removeFriend('));
  assert.equal(calls.length, 1, 'removeFriend 只能有一个调用点，实际: ' + calls.join(' | '));
  // 该调用点必须在 doDeleteFriend 函数体内
  const callIdx = LINES.findIndex(line => line.includes('pmService.removeFriend('));
  const fnIdx = LINES.findIndex(line => line.includes('const doDeleteFriend'));
  assert.ok(fnIdx >= 0 && callIdx > fnIdx, 'removeFriend 调用必须在 doDeleteFriend 之后');
});

test('ui-menu: 删除前有二次确认弹窗与取消路径', () => {
  assert.ok(SRC.includes('const [confirmDel, setConfirmDel] = React.useState(null)'), '缺少删除确认 state');
  assert.ok(SRC.includes('删除后好友与聊天记录都会清除'), '缺少确认框文案');
  assert.ok(SRC.includes('onClick: doDeleteFriend'), '确认框缺少“删除好友”按钮');
  // 取消按钮不能走删除
  const cancelLine = LINES.find(line => line.includes("'取消'"));
  assert.ok(cancelLine, '缺少取消按钮');
  assert.ok(!cancelLine.includes('doDeleteFriend'), '取消按钮不能触发删除');
});

test('ui-menu: 菜单支持 Escape / 外层点击关闭', () => {
  assert.ok(SRC.includes("e.key === 'Escape'"), '缺少 Escape 关闭');
  assert.ok(SRC.includes('pm-ctx-backdrop') && SRC.includes("onMouseDown: () => setCtxMenu(null)"), '缺少点击外部关闭');
});