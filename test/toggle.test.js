import { test } from 'node:test';
import assert from 'node:assert/strict';

// client.js 是浏览器模块（window.__ModuleLoader__），开关读写逻辑在此复刻；
// 与 client.js 的 loadState/coerceSettings 必须同步（见其头部注释）。
const DEFAULT_SETTINGS = { allowBroadcast: false, allowIncoming: true };

function coerceSettings(raw) {
  const d = DEFAULT_SETTINGS;
  return {
    allowBroadcast: raw && typeof raw.allowBroadcast === 'boolean' ? raw.allowBroadcast : d.allowBroadcast,
    allowIncoming: raw && typeof raw.allowIncoming === 'boolean' ? raw.allowIncoming : d.allowIncoming,
  };
}

// 复刻 loadState 的 settings 解析（含旧独立 key 迁移语义）：
// st.settings = coerceSettings(migrated || st.settings)
function resolveStateSettings(stSettings, migrated) {
  return coerceSettings(migrated || stSettings);
}

// ── 后台开关（广播 / 接收新连接）───────────────────────────────────────────

test('toggle: 默认广播关、接收开（安全缺省）', () => {
  assert.deepEqual(resolveStateSettings(null, null), { allowBroadcast: false, allowIncoming: true });
  assert.deepEqual(resolveStateSettings(undefined, undefined), { allowBroadcast: false, allowIncoming: true });
});

test('toggle: 正常持久化值往返', () => {
  assert.deepEqual(
    resolveStateSettings({ allowBroadcast: true, allowIncoming: false }, null),
    { allowBroadcast: true, allowIncoming: false }
  );
});

test('toggle: state.settings 非法字段回退默认（防 localStorage 篡改打崩）', () => {
  assert.deepEqual(resolveStateSettings({}, null), { allowBroadcast: false, allowIncoming: true });
  assert.deepEqual(
    resolveStateSettings({ allowBroadcast: 'yes', allowIncoming: 1 }, null),
    { allowBroadcast: false, allowIncoming: true }
  );
  assert.deepEqual(
    resolveStateSettings({ allowBroadcast: [], allowIncoming: {} }, null),
    { allowBroadcast: false, allowIncoming: true }
  );
  assert.deepEqual(resolveStateSettings('not-an-object', null), { allowBroadcast: false, allowIncoming: true });
});

test('toggle: 旧独立 key（settings-v1）迁移优先于 state 内值', () => {
  // 旧版存了广播=true；主 state 里没有 settings → 迁移值生效
  assert.deepEqual(
    resolveStateSettings(null, { allowBroadcast: true, allowIncoming: false }),
    { allowBroadcast: true, allowIncoming: false }
  );
  // 迁移值本身非法 → 回退默认
  assert.deepEqual(
    resolveStateSettings(null, { allowBroadcast: 'evil' }),
    { allowBroadcast: false, allowIncoming: true }
  );
});

test('toggle: 判定矩阵——入站连接三层闸', () => {
  // 复刻 handleIncomingConn 判定顺序（id 合法性由其他测试覆盖）：
  //   1) allowIncoming=false → 一律拒（陌生/好友都拒，已建立连接不受影响）
  //   2) allowIncoming=true 且 allowBroadcast=false → 仅好友
  //   3) allowIncoming=true 且 allowBroadcast=true → 好友+陌生
  const decide = (settings, isFriend) => {
    if (!settings.allowIncoming) return 'reject';
    if (!settings.allowBroadcast && !isFriend) return 'reject';
    return 'accept';
  };
  assert.equal(decide(DEFAULT_SETTINGS, false), 'reject');                          // 默认拒陌生
  assert.equal(decide(DEFAULT_SETTINGS, true), 'accept');                          // 默认收好友
  assert.equal(decide({ allowBroadcast: true, allowIncoming: true }, false), 'accept');   // 广播开→收陌生
  assert.equal(decide({ allowBroadcast: false, allowIncoming: false }, true), 'reject');   // 总闸关→好友也拒
  assert.equal(decide({ allowBroadcast: true, allowIncoming: false }, false), 'reject');  // 总闸优先于广播
});

test('toggle: setter 经 update() 写入 state.settings 并保留其他字段', () => {
  // 复刻 setAllowBroadcast 的 mutator 语义
  const prev = { friends: [{ id: 'dsh-pm-aaaabbbb-cccc' }], messages: {}, settings: DEFAULT_SETTINGS };
  const next = Object.assign({}, prev, {
    settings: Object.assign({}, prev.settings || coerceSettings(null), { allowBroadcast: true }),
  });
  assert.deepEqual(next.settings, { allowBroadcast: true, allowIncoming: true });
  assert.equal(next.friends.length, 1);   // friends 保留
  assert.deepEqual(next.messages, {});    // messages 保留
  // settings 缺失的旧 state 也能安全写入
  const prev2 = { friends: [], messages: {} };
  const next2 = Object.assign({}, prev2, {
    settings: Object.assign({}, prev2.settings || coerceSettings(null), { allowIncoming: false }),
  });
  assert.deepEqual(next2.settings, { allowBroadcast: false, allowIncoming: false });
});
