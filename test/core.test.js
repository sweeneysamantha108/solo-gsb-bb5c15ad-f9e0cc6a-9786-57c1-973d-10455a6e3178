'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;

function approx(actual, expected, tol = 1e-6, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

test('正面相撞：两人相向匀速，在 t=6 接触', () => {
  const a = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }] };
  const b = { id: 'b', radius: 0, keys: [{ t: 0, x: 120, y: 0 }, { t: 12, x: 0, y: 0 }] };
  const r = core.analyzePair(a, b, T);
  assert.equal(r.collision, true);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 6, 1e-7, '进入碰撞');
  approx(r.intervals[0][1], 6, 1e-7, '离开碰撞');
  approx(r.firstContact, 6, 1e-7);
  approx(r.minDistance, 0, 1e-7);
  approx(r.minDistanceT, 6, 1e-7);
});

test('半径产生有限宽度的碰撞区间（非点接触）', () => {
  const a = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] };
  const r = core.analyzePair(a, b, T);
  assert.equal(r.collision, true);
  // 相对速度 20/s，半径和 20 -> |100-20t|<=20 -> t∈[4,6]
  approx(r.intervals[0][0], 4, 1e-7);
  approx(r.intervals[0][1], 6, 1e-7);
});

test('相切：最近距离恰好等于半径和，区间退化为单点也算碰撞', () => {
  // A 水平经过 y=10，B 静止原点；rSum=10 -> 恰在 t=5 相切
  const a = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 10 }, { t: 10, x: 100, y: 10 }] };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 50, y: 0 }] };
  const r = core.analyzePair(a, b, T);
  assert.equal(r.collision, true);
  approx(r.intervals[0][0], 5, 1e-6);
  approx(r.intervals[0][1], 5, 1e-6);
  approx(r.minDistance, 10, 1e-6);
});

test('错峰交叉：路径相交但不同时到达，不得误报', () => {
  // A 水平匀速，t=5 经过交点 (50,0)；B 竖直疾行，t≈1 经过交点后远离
  const a = { id: 'a', radius: 2, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] };
  const b = { id: 'b', radius: 2, keys: [{ t: 0, x: 50, y: -100 }, { t: 2, x: 50, y: 100 }] };
  const r = core.analyzePair(a, b, T);
  assert.equal(r.collision, false);
  assert.deepEqual(r.intervals, []);
  assert.equal(r.firstContact, null);
  // 几何路径交点距离为 0 但时刻错开，全程最近距离仍远大于半径和 4
  assert.ok(r.minDistance > 30, `最近距离应 >30，实际 ${r.minDistance}`);
});

test('相对静止持续重叠：v=0 退化解覆盖整段', () => {
  const a = { id: 'a', radius: 30, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }] };
  // B 同速平行，间距恒为 40 <= 半径和 50
  const b = { id: 'b', radius: 20, keys: [{ t: 0, x: 0, y: 40 }, { t: 12, x: 120, y: 40 }] };
  const r = core.analyzePair(a, b, T);
  assert.equal(r.collision, true);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 0, 1e-7);
  approx(r.intervals[0][1], 12, 1e-7);
  approx(r.minDistance, 40, 1e-7);
});

test('跨关键帧的碰撞区间在边界处正确合并', () => {
  // A 匀速直线（单段），B 用两个共线关键帧人为切成两段，结果应一致
  const a = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] };
  const b1 = { id: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 5, x: 50, y: 0 }, { t: 10, x: 0, y: 0 }] };
  const b2 = { id: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] };
  const r1 = core.analyzePair(a, b1, T);
  const r2 = core.analyzePair(a, b2, T);
  assert.equal(r1.intervals.length, r2.intervals.length);
  approx(r1.intervals[0][0], r2.intervals[0][0]);
  approx(r1.intervals[0][1], r2.intervals[0][1]);
});

test('关键帧之外保持静止（开场即贴近静止者）', () => {
  const a = { id: 'a', radius: 15, keys: [{ t: 3, x: 0, y: 0 }, { t: 9, x: 100, y: 0 }] };
  const b = { id: 'b', radius: 15, keys: [{ t: 0, x: 5, y: 0 }] };
  const r = core.analyzePair(a, b, T);
  // 0..3 期间 A 静止在 (0,0)，与 B 相距 5 <= 30，必然碰撞
  assert.equal(r.collision, true);
  approx(r.intervals[0][0], 0, 1e-7);
});

test('analyzeScene：4 人产生 6 对，首次碰撞与全局最小间距正确', () => {
  const scene = core.builtinScene();
  const r = core.analyzeScene(scene);
  assert.equal(r.pairCount, 6);
  const colliding = r.pairs.filter((p) => p.collision);
  const names = colliding.map((p) => `${p.aId}-${p.bId}`).sort();
  assert.deepEqual(names, ['p1-p2', 'p3-p4']);

  const p12 = r.pairs.find((p) => p.aId === 'p1' && p.bId === 'p2');
  approx(p12.firstContact, 5.53, 0.02, '甲乙首碰时刻');
  approx(p12.minDistance, 0, 1e-6, '甲乙最小间距');
  approx(p12.minDistanceT, 6, 1e-6, '甲乙最小间距时刻');
  approx(p12.intervals[0][0], 5.53, 0.02);
  approx(p12.intervals[0][1], 6.47, 0.02);

  const p34 = r.pairs.find((p) => p.aId === 'p3' && p.bId === 'p4');
  assert.equal(p34.collision, true);
  approx(p34.firstContact, 2.60, 0.02, '丙丁首碰时刻');
  approx(p34.lastRelease, 12, 1e-6, '丙丁持续到收场');
  assert.ok(p34.minDistance < 40, '丙丁最近间距应小于半径和 40');

  // 几何相交但错峰的组合不得误报
  for (const id of ['p1-p3', 'p2-p3', 'p1-p4', 'p2-p4']) {
    const [x, y] = id.split('-');
    const p = r.pairs.find((q) => q.aId === x && q.bId === y);
    assert.equal(p.collision, false, `${id} 不应碰撞`);
  }

  approx(r.firstContact, p34.firstContact, 1e-6);
  approx(r.minDistance, 0, 1e-6);
});

test('positionAt 线性插值与端点静止', () => {
  const keys = core.normalizeKeys([{ t: 2, x: 0, y: 0 }, { t: 6, x: 40, y: 20 }]);
  assert.deepEqual(core.positionAt(keys, 0), { x: 0, y: 0 });
  const mid = core.positionAt(keys, 4);
  approx(mid.x, 20, 1e-9);
  approx(mid.y, 10, 1e-9);
  assert.deepEqual(core.positionAt(keys, 9), { x: 40, y: 20 });
});

test('radiusAt：缺省继承表演者半径，相邻关键帧线性插值，首尾之外保持端点值', () => {
  const keys = core.normalizeKeys([
    { t: 0, x: 0, y: 0 },          // 缺省 -> 继承 20
    { t: 4, x: 0, y: 0, r: 60 },
    { t: 8, x: 0, y: 0, r: 40 }
  ], 20);
  approx(core.radiusAt(keys, -1, 20), 20, 1e-9, '首帧之前保持首帧（继承）值');
  approx(core.radiusAt(keys, 0, 20), 20, 1e-9);
  approx(core.radiusAt(keys, 2, 20), 40, 1e-9, '段内线性插值');
  approx(core.radiusAt(keys, 4, 20), 60, 1e-9);
  approx(core.radiusAt(keys, 6, 20), 50, 1e-9);
  approx(core.radiusAt(keys, 8, 20), 40, 1e-9);
  approx(core.radiusAt(keys, 12, 20), 40, 1e-9, '末帧之后保持末帧值');

  const st = core.stateAt([{ t: 0, x: 10, y: 0 }, { t: 10, x: 90, y: 0, r: 40 }], 5, 20);
  approx(st.x, 50, 1e-9);
  approx(st.r, 30, 1e-9, 'stateAt 同步插值位置与半径');
});

test('可变半径：张开道具提前进入碰撞（半径和线性增大，解析二次式）', () => {
  // B 沿 x 轴匀速从 0 走到 100（r=10）；A 静止在 x=70，
  // t∈[0,4] 安全半径 10→50，之后保持 50
  const a = {
    id: 'a', radius: 10,
    keys: [{ t: 0, x: 70, y: 0, r: 10 }, { t: 4, x: 70, y: 0, r: 50 }]
  };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] };
  const r = core.analyzePair(a, b, 10);
  assert.equal(r.collision, true);
  // 张开段：间距 70-10t，半径和 20+10t → 相等时 70-10t=20+10t → t=2.5
  approx(r.firstContact, 2.5, 1e-7, '张开导致首碰 t=2.5');
  // t≥4 后半径和恒 60、间距持续缩小；穿过中心后在 70-10t=-60 → t=13 才脱离（窗外）
  approx(r.lastRelease, 10, 1e-7, '窗内始终重叠到收场');
  // 几何最小间距仍为 0（半径无关）
  approx(r.minDistance, 0, 1e-7);
  // 半径和极值：20（起始）～60
  approx(r.radiusSumMin, 20, 1e-9);
  approx(r.radiusSumMax, 60, 1e-9);
});

test('可变半径：单帧张开再收拢，碰撞区间在同段精确起止（两点根）', () => {
  // B 从 100 走到 0（r=10）；A 静止原点，半径在 t∈[2,6] 由 10 线性升到 90
  const a = {
    id: 'a', radius: 10,
    keys: [{ t: 2, x: 0, y: 0, r: 10 }, { t: 6, x: 0, y: 0, r: 90 }]
  };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] };
  const r = core.analyzePair(a, b, 10);
  assert.equal(r.collision, true);
  // 张开段 t∈[2,6]：间距 100-10t，rA=20t-30，半径和 20t-20
  //   相等：100-10t=20t-20 → t=4 接触
  approx(r.intervals[0][0], 4, 1e-7, '张开段接触 t=4');
  // t≥6 后半径和恒 100，间距继续缩小；脱离需 100-10t=-100 → t=20（窗外）
  approx(r.intervals[r.intervals.length - 1][1], 10, 1e-7);
});

test('可变半径：相对静止下仅靠张开道具产生精确进入时刻', () => {
  // 两人完全静止，相距 30；A 半径 10 在 t∈[2,6] 线性升到 50，B 恒 10
  const a = {
    id: 'a', radius: 10,
    keys: [{ t: 0, x: 0, y: 0, r: 10 }, { t: 2, x: 0, y: 0, r: 10 }, { t: 6, x: 0, y: 0, r: 50 }]
  };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 30, y: 0 }] };
  const r = core.analyzePair(a, b, 8);
  assert.equal(r.collision, true);
  // 半径和 = 20 + 10(t-2) = 10t（t∈[2,6]），等于 30 时 t=3
  approx(r.firstContact, 3, 1e-7);
  approx(r.intervals[0][0], 3, 1e-7);
  // t≥6 半径和 60 > 30，持续碰撞到窗末
  approx(r.lastRelease, 8, 1e-7);
  // 最小几何间距不受半径影响：恒为 30
  approx(r.minDistance, 30, 1e-7);
});

test('半径快速张开（二次式首项系数为负）：先碰后随合拢脱离', () => {
  // 一人匀速离开但半径张开更快：|v|² - d² < 0 分支
  // B 从 x=0 以 10/s 向 +x（r=0）；A 静止 x=0，r: 0→80 在 t∈[0,4]
  const a = {
    id: 'a', radius: 0,
    keys: [{ t: 0, x: 0, y: 0, r: 0 }, { t: 4, x: 0, y: 0, r: 80 }]
  };
  const b = { id: 'b', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 8, x: 80, y: 0 }] };
  const r = core.analyzePair(a, b, 8);
  // t∈[0,4]：间距 10t，半径和 20t → 10t ≤ 20t 恒成立（t=0 重合）
  // t∈[4,8]：间距 10t，半径和恒 80 → 10t ≤ 80 → t ≤ 8（t=8 相切脱离）
  assert.equal(r.collision, true);
  approx(r.firstContact, 0, 1e-7);
  approx(r.lastRelease, 8, 1e-7, 't=8 恰好相切');
});

test('未设置关键帧半径时与固定半径结果完全一致（向后兼容）', () => {
  const a1 = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] };
  const a2 = {
    id: 'a', radius: 10,
    keys: [{ t: 0, x: 0, y: 0, r: 10 }, { t: 10, x: 100, y: 0, r: 10 }]
  };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] };
  const r1 = core.analyzePair(a1, b, T);
  const r2 = core.analyzePair(a2, b, T);
  assert.equal(r1.intervals.length, r2.intervals.length);
  approx(r1.intervals[0][0], r2.intervals[0][0]);
  approx(r1.intervals[0][1], r2.intervals[0][1]);
  approx(r1.minDistance, r2.minDistance);
  approx(r2.radiusSumMin, 20, 1e-9);
  approx(r2.radiusSumMax, 20, 1e-9);
});

test('收拢道具在半径线性减小段精确脱离碰撞', () => {
  // 两人完全静止，相距 30；A 半径在 t∈[2,6] 由 50 线性收到 10，B 恒 10
  const a = {
    id: 'a', radius: 10,
    keys: [{ t: 0, x: 0, y: 0, r: 50 }, { t: 2, x: 0, y: 0, r: 50 }, { t: 6, x: 0, y: 0, r: 10 }]
  };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 30, y: 0 }] };
  const r = core.analyzePair(a, b, 8);
  assert.equal(r.collision, true);
  // t<2 半径和 60 ≥ 30 全程碰撞；收拢段半径和 = 60-10(t-2) = 80-10t
  // 等于 30 时 t=5 脱离，之后半径和 20 < 30 安全
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 0, 1e-7);
  approx(r.intervals[0][1], 5, 1e-7);
});

test('跨关键帧半径分段：张开段进入与关键帧处相切合并', () => {
  // A 静止原点；t∈[0,4] r 10→50，t∈[4,8] r 50→10；B 以 10/s 从 100 走向 0（r=10）
  const a = {
    id: 'a', radius: 10,
    keys: [
      { t: 0, x: 0, y: 0, r: 10 },
      { t: 4, x: 0, y: 0, r: 50 },
      { t: 8, x: 0, y: 0, r: 10 }
    ]
  };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] };
  const r = core.analyzePair(a, b, 10);
  assert.equal(r.collision, true);
  // 张开段：间距 100-10t，半径和 20+10t，相等时 t=4（恰在关键帧处相切进入）
  // 合拢段半径和 100-10t，与间距恒等，整段重叠；t≥8 后半径和 20、间距继续缩小，
  // 在 t∈[8,10] 内间距 ≤20 → 直到 t=10。两段在 t=4 相接，合并为单一区间
  assert.equal(r.intervals.length, 1, '段边界相接区间应合并为一段');
  approx(r.intervals[0][0], 4, 1e-6);
  approx(r.intervals[0][1], 10, 1e-6);
});

test('内置样例含关键帧半径且不改变原有碰撞结论', () => {
  const s = core.builtinScene();
  const p3 = s.performers.find((p) => p.id === 'p3');
  assert.equal(p3.keys[2].r, 60, '丙 t=8 帧携带展开半径 60');
  const r = core.analyzeScene(s);
  const p13 = r.pairs.find((p) => p.aId === 'p1' && p.bId === 'p3');
  const p23 = r.pairs.find((p) => p.aId === 'p2' && p.bId === 'p3');
  assert.equal(p13.collision, false, '展开后与甲仍安全');
  assert.equal(p23.collision, false, '展开后与乙仍安全');
  const p34 = r.pairs.find((p) => p.aId === 'p3' && p.bId === 'p4');
  assert.equal(p34.collision, true);
  approx(p34.firstContact, 2.60, 0.02);
});

// ---------- 最小安全余量 minMargin = min_t (distance(t) - (rA+rB)) ----------

test('最小安全余量：相对静止且半径恒定，余量恒为 dist − 半径和', () => {
  // 两人同速平行，间距恒 40，半径和恒 50 → 余量恒 −10（相对静止退化）
  const a = { id: 'a', radius: 30, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }] };
  const b = { id: 'b', radius: 20, keys: [{ t: 0, x: 0, y: 40 }, { t: 12, x: 120, y: 40 }] };
  const r = core.analyzePair(a, b, T);
  approx(r.minMargin, -10, 1e-7, '余量 = 40 − 50');
  assert.ok(r.minMarginT >= 0 && r.minMarginT <= 12, '发生时刻在窗内');
  assert.equal(r.collision, true, '余量 ≤ 0 ⟺ 碰撞');
});

test('最小安全余量：距离为零的正面相撞，余量 = −半径和 @ 相遇时刻', () => {
  const a = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }] };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 120, y: 0 }, { t: 12, x: 0, y: 0 }] };
  const r = core.analyzePair(a, b, T);
  approx(r.minMargin, -20, 1e-7, 't=6 距离为 0，余量 = −20');
  approx(r.minMarginT, 6, 1e-7);
});

test('最小安全余量：安全对余量为正，等于最近间距 − 半径和（半径恒定）', () => {
  // A 沿 y=30 水平经过，B 静止原点；rSum=20 → 余量 = 30 − 20 = 10 @ t=5
  const a = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 30 }, { t: 10, x: 100, y: 30 }] };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 50, y: 0 }] };
  const r = core.analyzePair(a, b, T);
  assert.equal(r.collision, false);
  approx(r.minMargin, 10, 1e-6);
  approx(r.minMarginT, 5, 1e-6);
});

test('最小安全余量：可变半径下驻点落在段内（凸函数唯一驻点，非采样）', () => {
  // A 静止原点，r: 0→8 于 t∈[0,4]（半径和变化率 d=+2）；
  // B 以 10/s 从 (-30,40) 走到 (10,40)，r=0
  const a = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 0, r: 0 }, { t: 4, x: 0, y: 0, r: 8 }] };
  const b = { id: 'b', radius: 0, keys: [{ t: 0, x: -30, y: 40 }, { t: 4, x: 10, y: 40 }] };
  const r = core.analyzePair(a, b, 4);
  // u=(-30,40), v=(10,0)：v2=100, uv=-300, cross2=2500*100-300²=160000
  // t* = (300 + 2·√(160000/96))/100 ≈ 3.8165 ∈ (0,4)
  const ts = (300 + 2 * Math.sqrt(160000 / 96)) / 100;
  const expect = Math.hypot(-30 + 10 * ts, 40) - 2 * ts;
  approx(r.minMarginT, ts, 1e-7, '驻点时刻');
  approx(r.minMargin, expect, 1e-7, '驻点处余量');
  approx(r.minMargin, 33.19, 0.01);
  assert.equal(r.collision, false, '余量 > 0 ⟺ 安全');
});

test('最小安全余量：相对静止 + 半径张开，余量线性递减在端点取最小', () => {
  // 两人完全静止相距 30；A 半径 t∈[2,6] 由 10 升到 50，B 恒 10
  const a = {
    id: 'a', radius: 10,
    keys: [{ t: 0, x: 0, y: 0, r: 10 }, { t: 2, x: 0, y: 0, r: 10 }, { t: 6, x: 0, y: 0, r: 50 }]
  };
  const b = { id: 'b', radius: 10, keys: [{ t: 0, x: 30, y: 0 }] };
  const r = core.analyzePair(a, b, 8);
  // t≥6 半径和恒 60 → 余量恒 30−60 = −30（平台段）
  approx(r.minMargin, -30, 1e-7);
  assert.ok(r.minMarginT >= 6 - 1e-9 && r.minMarginT <= 8, '最小余量出现在张开后的平台段');
});

test('最小安全余量：距离为零且相对静止（两人全程重合）', () => {
  const a = { id: 'a', radius: 10, keys: [{ t: 0, x: 5, y: 5 }] };
  const b = { id: 'b', radius: 15, keys: [{ t: 0, x: 5, y: 5 }] };
  const r = core.analyzePair(a, b, 8);
  approx(r.minDistance, 0, 1e-9);
  approx(r.minMargin, -25, 1e-9, '余量恒为 −(10+15)');
  assert.equal(r.collision, true);
});

test('最小安全余量：与细采样对照且与碰撞判定一致（实现本身不采样）', () => {
  const scenes = [
    core.builtinScene(),
    {
      duration: 10,
      performers: [
        { id: 'a', radius: 10, keys: [{ t: 0, x: 70, y: 0, r: 10 }, { t: 4, x: 70, y: 0, r: 50 }] },
        { id: 'b', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] }
      ]
    },
    {
      duration: 8,
      performers: [
        { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 0, r: 0 }, { t: 4, x: 0, y: 0, r: 80 }] },
        { id: 'b', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 8, x: 80, y: 0 }] }
      ]
    },
    {
      duration: 12,
      performers: [
        { id: 'a', radius: 5, keys: [{ t: 1, x: 0, y: 0 }, { t: 5, x: 200, y: 100 }, { t: 11, x: 40, y: 300 }] },
        { id: 'b', radius: 25, keys: [{ t: 0, x: 300, y: 200, r: 40 }, { t: 12, x: 100, y: 100, r: 5 }] }
      ]
    }
  ];
  scenes.forEach((scene, si) => {
    const r = core.analyzeScene(scene);
    r.pairs.forEach((pair) => {
      const pa = scene.performers.find((p) => p.id === pair.aId);
      const pb = scene.performers.find((p) => p.id === pair.bId);
      let best = Infinity;
      for (let i = 0; i <= 20000; i++) {
        const t = (scene.duration * i) / 20000;
        const sa = core.stateAt(pa.keys, t, pa.radius);
        const sb = core.stateAt(pb.keys, t, pb.radius);
        const m = Math.hypot(sa.x - sb.x, sa.y - sb.y) - sa.r - sb.r;
        if (m < best) best = m;
      }
      assert.ok(
        pair.minMargin <= best + 1e-9,
        `场景${si} 对 ${pair.aId}-${pair.bId}：解析余量 ${pair.minMargin} 不应大于采样最小值 ${best}`
      );
      approx(pair.minMargin, best, 2e-2, `场景${si} 对 ${pair.aId}-${pair.bId} 解析余量≈采样最小值`);
      assert.equal(
        pair.collision, pair.minMargin <= 1e-9,
        `场景${si} 对 ${pair.aId}-${pair.bId}：余量 ≤ 0 ⟺ 碰撞`
      );
    });
  });
});

test('analyzeScene：pairs 按最小安全余量升序，场景级 minMargin 与首对一致', () => {
  const r = core.analyzeScene(core.builtinScene());
  for (let i = 1; i < r.pairs.length; i++) {
    assert.ok(
      r.pairs[i].minMargin >= r.pairs[i - 1].minMargin - 1e-12,
      `第 ${i} 对余量 ${r.pairs[i].minMargin} 应 ≥ 前一对 ${r.pairs[i - 1].minMargin}`
    );
  }
  approx(r.minMargin, r.pairs[0].minMargin, 1e-12, '场景级最小余量 = 首对余量');
  approx(r.minMarginT, r.pairs[0].minMarginT, 1e-12);
  assert.deepEqual(r.minMarginPair, [r.pairs[0].aId, r.pairs[0].bId]);
  // 碰撞对余量 ≤ 0 < 安全对余量，故碰撞对全部排在安全对之前
  const firstSafe = r.pairs.findIndex((p) => !p.collision);
  assert.ok(r.pairs.slice(0, firstSafe === -1 ? r.pairs.length : firstSafe).every((p) => p.collision));
});

// ---------- 舞台禁入矩形 obstacles ----------

const OB = { id: 'o1', name: '禁入区', x: 40, y: 40, width: 20, height: 20 };

test('禁入矩形：零半径直线横穿，区间恰为边界交点（不采样）', () => {
  // 沿 y=50 从 x=0 走到 x=100（t=0..10），矩形 [40,60]×[40,60]
  const p = { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] };
  const r = core.analyzeObstacle(p, OB, T);
  assert.equal(r.conflict, true);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 4, 1e-9, '左边进入 t=4');
  approx(r.intervals[0][1], 6, 1e-9, '右边离开 t=6');
  approx(r.firstEntry, 4, 1e-9);
  approx(r.lastExit, 6, 1e-9);
  assert.equal(r.performerId, 'a');
  assert.equal(r.obstacleId, 'o1');
});

test('禁入矩形：安全半径膨胀后提前进入、延后离开（单坐标二次）', () => {
  // 同轨迹、半径 10：|x-50| 方向进入点 x=30 -> t=3
  const p = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] };
  const r = core.analyzeObstacle(p, OB, T);
  approx(r.intervals[0][0], 3, 1e-9);
  approx(r.intervals[0][1], 7, 1e-9);
});

test('禁入矩形：从矩形内部起步，区间以 t=0 开始', () => {
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }, { t: 10, x: 150, y: 50 }] };
  const r = core.analyzeObstacle(p, OB, T);
  assert.equal(r.conflict, true);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 0, 1e-9, '开场即在矩形内');
  approx(r.intervals[0][1], 1, 1e-9, 'x=50+10t 越右边界 60 于 t=1');

  // 全程待在内部
  const stay = core.analyzeObstacle({ id: 'b', radius: 5, keys: [{ t: 0, x: 50, y: 50 }] }, OB, T);
  approx(stay.intervals[0][0], 0, 1e-9);
  approx(stay.intervals[0][1], 12, 1e-9);
});

test('禁入矩形：仅角点相切记为零长度侵入区间（最近点为双坐标）', () => {
  // 斜穿 x+y=140，距右上角 (60,60) 最近；半径 10√2 恰在垂足 (50+? ) 相切一次
  // 轨迹 (20,120)->(120,20)，到 (60,60) 的垂足在线上且严格位于角象限
  const rr = 10 * Math.SQRT2;
  const p = { id: 'a', radius: rr, keys: [{ t: 0, x: 20, y: 120 }, { t: 10, x: 120, y: 20 }] };
  const r = core.analyzeObstacle(p, OB, T);
  assert.equal(r.conflict, true, '零长度相切也算侵入');
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], r.intervals[0][1], 1e-9, '相切为零长度点');
  approx(r.intervals[0][0], 5, 1e-9, 't=5 经过垂足');
  // 半径略小则不接触
  const near = core.analyzeObstacle(
    { id: 'a2', radius: rr - 1e-6, keys: p.keys }, OB, T);
  assert.equal(near.conflict, false, '角点距离大于半径不得误报');
});

test('禁入矩形：沿边外等距线擦边（投影落在边上）给有限相切宽度', () => {
  // 水平 y=70、r=10：与顶边 y=60 的膨胀边界处处相切 -> 一段连续接触
  const p = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 70 }, { t: 10, x: 100, y: 70 }] };
  const r = core.analyzeObstacle(p, OB, T);
  assert.equal(r.conflict, true);
  approx(r.intervals[0][0], 4, 1e-9);
  approx(r.intervals[0][1], 6, 1e-9);
});

test('禁入矩形：半径随时间变化，静止者张开到接触、收拢脱离', () => {
  // 静止 (50,70)，距顶边 10；r:0@0 ->20@4，之后保持 20
  const grow = {
    id: 'a', radius: 0,
    keys: [{ t: 0, x: 50, y: 70, r: 0 }, { t: 4, x: 50, y: 70, r: 20 }]
  };
  const r1 = core.analyzeObstacle(grow, OB, 8);
  assert.equal(r1.conflict, true);
  approx(r1.intervals[0][0], 2, 1e-9, 'r=5t 达到 10 时 t=2 进入');
  approx(r1.intervals[0][1], 8, 1e-9, '张开后持续侵入到窗末');

  // 收拢：r:20@2 ->0@6，接触脱离于 r=10 -> t=4
  const shrink = {
    id: 'a', radius: 0,
    keys: [{ t: 0, x: 50, y: 70, r: 20 }, { t: 2, x: 50, y: 70, r: 20 }, { t: 6, x: 50, y: 70, r: 0 }]
  };
  const r2 = core.analyzeObstacle(shrink, OB, 8);
  approx(r2.intervals[0][0], 0, 1e-9);
  approx(r2.intervals[0][1], 4, 1e-9, '收拢到 r=10 时 t=4 脱离');
});

test('禁入矩形：跨关键帧的相接侵入区间合并为单段', () => {
  // 用共线关键帧人为切段：匀速 y=50 横穿，与单段轨迹结果一致
  const p1 = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 5, x: 50, y: 50 }, { t: 10, x: 100, y: 50 }] };
  const p2 = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] };
  const r1 = core.analyzeObstacle(p1, OB, T);
  const r2 = core.analyzeObstacle(p2, OB, T);
  assert.equal(r1.intervals.length, 1);
  assert.equal(r2.intervals.length, 1);
  approx(r1.intervals[0][0], r2.intervals[0][0], 1e-9);
  approx(r1.intervals[0][1], r2.intervals[0][1], 1e-9);
});

test('禁入矩形：无冲突路径（含几何穿过但时刻/距离安全）', () => {
  // y=75、r=10 全程距矩形 ≥15
  const p = { id: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 75 }, { t: 10, x: 100, y: 75 }] };
  const r = core.analyzeObstacle(p, OB, T);
  assert.equal(r.conflict, false);
  assert.deepEqual(r.intervals, []);
  assert.equal(r.firstEntry, null);
  assert.equal(r.lastExit, null);
});

test('禁入矩形：与密集采样在多种随机化轨迹上完全一致（实现本身解析）', () => {
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260921);
  function rc() { return Math.round(rnd() * 120) - 10; }
  for (let trial = 0; trial < 40; trial++) {
    const ob = { id: 'o', x: rc() + 20, y: rc() + 20, width: 20 + rnd() * 80, height: 20 + rnd() * 80 };
    const nk = 1 + Math.floor(rnd() * 3);
    const keys = [];
    for (let i = 0; i <= nk; i++) {
      keys.push({
        t: Math.round((T * i) / nk * 10) / 10,
        x: rc() + 40, y: rc() + 40,
        r: rnd() < 0.5 ? null : Math.round(rnd() * 45)
      });
    }
    const performer = { id: 'a', radius: Math.round(rnd() * 25), keys };
    const res = core.analyzeObstacle(performer, ob, T);
    const X1 = ob.x + ob.width, Y1 = ob.y + ob.height;
    function truth(t) {
      const st = core.stateAt(performer.keys, t, performer.radius);
      const cx = Math.max(ob.x, Math.min(X1, st.x));
      const cy = Math.max(ob.y, Math.min(Y1, st.y));
      return Math.hypot(st.x - cx, st.y - cy) <= st.r + 1e-8;
    }
    // 区间自由端点（未被 [0,T] 钳制）必须恰在接触边界上
    res.intervals.forEach((iv) => {
      iv.forEach((t, k) => {
        if ((k === 0 && t <= 1e-9) || (k === 1 && t >= T - 1e-9)) return;
        const st = core.stateAt(performer.keys, t, performer.radius);
        const cx = Math.max(ob.x, Math.min(X1, st.x));
        const cy = Math.max(ob.y, Math.min(Y1, st.y));
        const d = Math.hypot(st.x - cx, st.y - cy);
        assert.ok(Math.abs(d - st.r) < 1e-5,
          `trial${trial} 端点 t=${t} 应在边界：d=${d}, r=${st.r}`);
      });
    });
    // 稠密采样逐一比对布尔侵入状态
    for (let i = 0; i <= 4000; i++) {
      const t = (T * i) / 4000;
      const pred = res.intervals.some((iv) => t >= iv[0] - 1e-8 && t <= iv[1] + 1e-8);
      assert.equal(pred, truth(t), `trial${trial} t=${t} 侵入状态不一致`);
    }
  }
});

test('normalizeObstacles：缺省 id/name、非法项过滤、负尺寸钳零', () => {
  const list = core.normalizeObstacles([
    { name: 'A', x: 1, y: 2, width: 30, height: 40 },
    { x: 0, y: 0, width: -5, height: 10 },
    { x: NaN, y: 0, width: 1, height: 1 },
    null
  ]);
  assert.equal(list.length, 2, '非法对象被过滤');
  assert.ok(list[0].id, '缺省 id 自动生成');
  assert.equal(list[0].name, 'A');
  assert.equal(list[1].name, '禁入区 2', '缺省名称带序号');
  assert.equal(list[1].width, 0, '负宽度钳为 0');
  // 退化矩形（0 宽）仍可分析：退化为线段
  const r = core.analyzeObstacle(
    { id: 'a', radius: 5, keys: [{ t: 0, x: 0, y: 5 }, { t: 10, x: 10, y: 5 }] },
    list[1], T);
  assert.equal(r.conflict, true);
});

test('analyzeScene：obstacleConflicts 为每人×每矩形，按首次进入升序且含场景级字段', () => {
  const scene = core.builtinScene();
  const r = core.analyzeScene(scene);
  assert.equal(r.obstacles.length, 1);
  assert.equal(r.obstacleConflicts.length, 4);
  const conflicts = r.obstacleConflicts.filter((e) => e.conflict);
  assert.deepEqual(conflicts.map((e) => e.performerId), ['p2', 'p1'], '首入升序：乙 4.15 < 甲 4.91');
  const safe = r.obstacleConflicts.filter((e) => !e.conflict).map((e) => e.performerId).sort();
  assert.deepEqual(safe, ['p3', 'p4'], '丙丁错峰折线不侵入中央禁入区');
  for (let i = 1; i < conflicts.length; i++) {
    assert.ok(conflicts[i].firstEntry >= conflicts[i - 1].firstEntry - 1e-12);
  }
  approx(r.firstObstacleEntry, conflicts[0].firstEntry, 1e-12);
  assert.deepEqual(r.firstObstacleConflict, ['p2', 'o1']);

  // 无 obstacles 旧场景完全兼容：字段为空数组/null
  const old = core.analyzeScene({ duration: T, performers: scene.performers });
  assert.deepEqual(old.obstacles, []);
  assert.deepEqual(old.obstacleConflicts, []);
  assert.equal(old.firstObstacleEntry, null);
  assert.equal(old.firstObstacleConflict, null);
});

test('禁入矩形高亮查询 isPerformerInObstacle 容差与指定矩形一致', () => {
  const entry = {
    performerId: 'a', obstacleId: 'o', conflict: true,
    intervals: [[2, 4], [6, 6]]
  };
  assert.equal(core.isPerformerInObstacle(entry, 'a', 3), true);
  assert.equal(core.isPerformerInObstacle(entry, 'a', 6), true, '零长度相切点可被查到');
  assert.equal(core.isPerformerInObstacle(entry, 'a', 5), false);
  assert.equal(core.isPerformerInObstacle(entry, 'b', 3), false);
});
