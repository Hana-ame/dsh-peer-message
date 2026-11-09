import { test } from 'node:test';
import assert from 'node:assert/strict';

// client.js 是浏览器模块，开关读写逻辑在此复刻（须与 client.js 同步，见其头部注释）。
const SETTINGS_KEY = 'dsh-peer-message-settings-v1';
const DEFAULT_SETTINGS = { allowBroadcast: false, allowIncoming: true };

function loadSettings(raw) {
  try {
    if (raw) {
      const s = JSON.parse(raw);
      return {
        allowBroadcast: typeof s.allowBroadcast === 'boolean' ? s.allowBroadcast : DEFAULT_SETTINGS.allowBroadcast,
        allowIncoming: typeof s.allowIncoming === 'boolean' ? s.allowIncoming : DEFAULT_SETTINGS.allowIncoming,
      };
    }
  } catch (e) { /* ignore */ }
  return Object.assign({}, DEFAULT_SETTINGS);
}

// ── 后台开关（广播 / 接收新连接） ─────────────────────────────────────────

test('toggle: 默认广播关、接收开（安全缺省）', () => {
  assert.deepEqual(loadSettings(null), { allowBroadcast: false, allowIncoming: true });
  assert.deepEqual(loadSettings(undefined), { allowBroadcast: false, allowIncoming: true });
});

test('toggle: 正常持久化值往返', () => {
  assert.deepEqual(loadSettings('{"allowBroadcast":true,"allowIncoming":false}'), { allowBroadcast: true, allowIncoming: false });
});

test('toggle: 非法/缺失字段回退默认（防 localStorage 篡改打崩）', () => {
  // 字段缺失
  assert.deepEqual(loadSettings('{}'), { allowBroadcast: false, allowIncoming: true });
  // 类型错误
  assert.deepEqual(loadSettings('{"allowBroadcast":"yes","allowIncoming":1}'), { allowBroadcast: false, allowIncoming: true });
  // 垃圾 JSON
  assert.deepEqual(loadSettings('not-json{{'), { allowBroadcast: false, allowIncoming: true });
  // 攻击者写对象/数组
  assert.deepEqual(loadSettings('{"allowBroadcast":[],"allowIncoming":{}}'), { allowBroadcast: false, allowIncoming: true });
});

test('toggle: 判定矩阵——入站连接三层闸', () => {
  // 复刻 handleIncomingConn 的判定顺序（id 合法性已由其他测试覆盖）：
  //   1) allowIncoming=false → 一律拒（陌生/好友都拒）
  //   2) allowIncoming=true 且 allowBroadcast=false → 仅好友
  //   3) allowIncoming=true 且 allowBroadcast=true → 好友+陌生
  const decide = (settings, isFriend) => {
    if (!settings.allowIncoming) return 'reject';
    if (!settings.allowBroadcast && !isFriend) return 'reject';
    return 'accept';
  };
  assert.equal(decide(loadSettings(null), false), 'reject');                 // 默认拒陌生
  assert.equal(decide(loadSettings(null), true), 'accept');                 // 默认收好友
  assert.equal(decide(loadSettings('{"allowBroadcast":true}'), false), 'accept');   // 广播开→收陌生
  assert.equal(decide(loadSettings('{"allowIncoming":false}'), true), 'reject');   // 总闸关→好友也拒
  assert.equal(decide(loadSettings('{"allowBroadcast":true,"allowIncoming":false}'), false), 'reject'); // 总闸优先
});
