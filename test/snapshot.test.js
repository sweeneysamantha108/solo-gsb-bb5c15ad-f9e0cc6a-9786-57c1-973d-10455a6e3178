'use strict';

/**
 * 方案快照对比引擎 compareScenes 用例：
 *  - 同名表演者位置偏移最大值（关键帧端点凸函数精确求最大，非采样）
 *  - 碰撞对 / 禁入区间的新增、消失、时间变化
 *  - 表演者 / 禁入区增删、统一时刻轴跨时长
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

function approx(actual, expected, tol = 1e-6, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

function movingPair(opts) {
  opts = opts || {};
  return {
    duration: 12,
    performers: [
      { id: 'a', name: 'A', radius: opts.rA || 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }] },
      { id: 'b', name: 'B', radius: opts.rB || 0, keys: [{ t: 0, x: 120, y: 0 }, { t: 12, x: 0, y: 0 }] }
    ]
  };
}

test('相同场景对比：偏移为 0、无任何增删变化', () => {
  const s = core.builtinScene();
  const r = core.compareScenes(s, JSON.parse(JSON.stringify(s)));
  assert.equal(r.maxOffset, 0);
  assert.equal(r.maxOffsetT, 0);
  r.performers.forEach((p) => {
    assert.equal(p.presentA, true);
    assert.equal(p.presentB, true);
    assert.equal(p.maxOffset, 0);
  });
  assert.deepEqual(r.pairs.added, []);
  assert.deepEqual(r.pairs.removed, []);
  assert.deepEqual(r.pairs.changed, []);
  assert.deepEqual(r.obstacleIntrusions.added, []);
  assert.deepEqual(r.obstacleIntrusions.removed, []);
  assert.deepEqual(r.obstacleIntrusions.changed, []);
  assert.deepEqual(r.addedPerformers, []);
  assert.deepEqual(r.removedPerformers, []);
  assert.deepEqual(r.addedObstacles, []);
  assert.deepEqual(r.removedObstacles, []);
});

test('同名表演者位置偏移：仅首帧平移，最大偏移恰为平移量且发生在 t=0', () => {
  const s1 = movingPair();
  const s2 = JSON.parse(JSON.stringify(s1));
  // A 的首帧 x 0→30（末帧不动）：段内偏移从 30 线性减到 0，最大在 t=0
  s2.performers[0].keys[0].x = 30;
  const r = core.compareScenes(s1, s2);
  assert.equal(r.maxOffsetPerformer, 'A');
  approx(r.maxOffset, 30);
  approx(r.maxOffsetT, 0);
  const a = r.performers.find((p) => p.name === 'A');
  approx(a.maxOffset, 30);
  approx(a.maxOffsetT, 0);
  const b = r.performers.find((p) => p.name === 'B');
  assert.equal(b.maxOffset, 0);
  // 偏移降序：A 在前
  assert.equal(r.performers[0].name, 'A');
});

test('偏移最大值必在关键帧时刻（内部顶点不可能是凸函数最大）', () => {
  // A：匀速直线；B：中间关键帧使中点偏移最大
  const s1 = {
    duration: 12,
    performers: [{ id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }] }]
  };
  const s2 = {
    duration: 12,
    performers: [{ id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 6, x: 60, y: 40 }, { t: 12, x: 120, y: 0 }] }]
  };
  const r = core.compareScenes(s1, s2);
  approx(r.maxOffset, 40);
  approx(r.maxOffsetT, 6, 1e-9, '最大偏移发生在 B 的中间关键帧 t=6');
});

test('碰撞对新增：方案 1 安全、方案 2 相撞', () => {
  // 半径 0 时两人在 t=6 相切（零长度）；方案 2 半径 10 -> 有限宽度碰撞
  const s1 = movingPair({ rA: 0, rB: 0 });
  // 引擎把相切（距离=半径和）记为碰撞，因此方案 1 改用明确不碰的错峰
  s1.performers[1].keys = [{ t: 0, x: 120, y: 100 }, { t: 12, x: 0, y: 100 }];
  const s2 = movingPair({ rA: 10, rB: 10 });
  const r = core.compareScenes(s1, s2);
  assert.equal(r.pairs.added.length, 1);
  assert.deepEqual(r.pairs.added[0].names, ['A', 'B']);
  assert.ok(r.pairs.added[0].intervals.length >= 1);
  approx(r.pairs.added[0].intervals[0][0], 5, 1e-7, '半径和 20、相对速度 20 → t=5 进入');
  approx(r.pairs.added[0].intervals[0][1], 7, 1e-7);
  assert.deepEqual(r.pairs.removed, []);
  assert.deepEqual(r.pairs.changed, []);
});

test('碰撞对消失：方案 1 相撞、方案 2 安全', () => {
  const s1 = movingPair({ rA: 10, rB: 10 });
  const s2 = movingPair({ rA: 10, rB: 10 });
  s2.performers[1].keys = [{ t: 0, x: 120, y: 100 }, { t: 12, x: 0, y: 100 }];
  const r = core.compareScenes(s1, s2);
  assert.equal(r.pairs.removed.length, 1);
  assert.deepEqual(r.pairs.removed[0].names, ['A', 'B']);
  assert.deepEqual(r.pairs.added, []);
});

test('碰撞对时间变化：区间端点移动但不新增/消失', () => {
  const s1 = movingPair({ rA: 5, rB: 5 });
  const s2 = movingPair({ rA: 15, rB: 15 });
  const r = core.compareScenes(s1, s2);
  assert.deepEqual(r.pairs.added, []);
  assert.deepEqual(r.pairs.removed, []);
  assert.equal(r.pairs.changed.length, 1);
  const ch = r.pairs.changed[0];
  assert.deepEqual(ch.names, ['A', 'B']);
  assert.equal(ch.changed.length, 1);
  approx(ch.changed[0].from[0], 5.5, 1e-7);
  approx(ch.changed[0].from[1], 6.5, 1e-7);
  approx(ch.changed[0].to[0], 4.5, 1e-7);
  approx(ch.changed[0].to[1], 7.5, 1e-7);
});

test('禁入区间：矩形平移导致侵入区间整体时间变化', () => {
  const base = {
    duration: 12,
    performers: [{ id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 300 }, { t: 12, x: 1000, y: 300 }] }],
    obstacles: [{ id: 'o', name: 'BOX', x: 400, y: 240, width: 100, height: 120 }]
  };
  const s2 = JSON.parse(JSON.stringify(base));
  s2.obstacles[0].x = 600;
  const r = core.compareScenes(base, s2);
  assert.deepEqual(r.obstacleIntrusions.added, []);
  assert.deepEqual(r.obstacleIntrusions.removed, []);
  assert.equal(r.obstacleIntrusions.changed.length, 1);
  const ch = r.obstacleIntrusions.changed[0];
  assert.equal(ch.performerName, 'A');
  assert.equal(ch.obstacleName, 'BOX');
  // 区间 4.8–6.0 移到 7.2–8.4，无重叠 → 表现为旧区间消失 + 新区间新增
  approx(ch.removed[0][0], 4.8, 1e-6);
  approx(ch.removed[0][1], 6.0, 1e-6);
  approx(ch.added[0][0], 7.2, 1e-6);
  approx(ch.added[0][1], 8.4, 1e-6);
});

test('禁入区改名：旧名列入移除、新名列入新增，且不产生配对变化', () => {
  const base = {
    duration: 12,
    performers: [{ id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 300 }, { t: 12, x: 1000, y: 300 }] }],
    obstacles: [{ id: 'o', name: 'BOX', x: 400, y: 240, width: 100, height: 120 }]
  };
  const s2 = JSON.parse(JSON.stringify(base));
  s2.obstacles[0].name = 'BOX2';
  const r = core.compareScenes(base, s2);
  assert.deepEqual(r.addedObstacles, ['BOX2']);
  assert.deepEqual(r.removedObstacles, ['BOX']);
  assert.deepEqual(r.obstacleIntrusions.added, []);
  assert.deepEqual(r.obstacleIntrusions.removed, []);
});

test('表演者增删单列，且不参与碰撞对/偏移计算', () => {
  const s1 = movingPair({ rA: 0, rB: 0 });
  const s2 = JSON.parse(JSON.stringify(s1));
  s2.performers.push({
    id: 'c', name: 'C', radius: 0,
    keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 0, y: 0 }]
  });
  const r = core.compareScenes(s1, s2);
  assert.deepEqual(r.addedPerformers, ['C']);
  assert.deepEqual(r.removedPerformers, []);
  const c = r.performers.find((p) => p.name === 'C');
  assert.equal(c.presentA, false);
  assert.equal(c.presentB, true);
  assert.equal(c.maxOffset, null);
  // 新增者不构成碰撞对变化条目（A×B 两侧都有）
  assert.equal(r.pairs.added.length + r.pairs.removed.length + r.pairs.changed.length, 0);
});

test('统一时刻轴：时长不同时按 max(dA,dB) 比较，帧外静止', () => {
  const s1 = {
    duration: 10,
    performers: [{ id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] }]
  };
  const s2 = {
    duration: 12,
    performers: [{ id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }] }]
  };
  const r = core.compareScenes(s1, s2);
  assert.equal(r.duration, 12);
  assert.equal(r.durationA, 10);
  assert.equal(r.durationB, 12);
  // t≤10 两侧都在 x=t（偏移 0）；t>10 A 静止于 100、B 继续到 120，t=12 偏移 20
  approx(r.maxOffset, 20);
  approx(r.maxOffsetT, 12);
});

test('名字拼接键不碰撞：「A,BC」与「AB,C」两对独立配对', () => {
  function scene(collideFirst) {
    // 第一对 A / BC：在同一位置 -> 碰撞；第二对 AB / C：相距很远
    const near = collideFirst;
    return {
      duration: 12,
      performers: [
        { id: 'p1', name: 'A', radius: 5, keys: [{ t: 0, x: 100, y: 100 }] },
        { id: 'p2', name: 'BC', radius: 5, keys: [{ t: 0, x: near ? 101 : 500, y: 100 }] },
        { id: 'p3', name: 'AB', radius: 5, keys: [{ t: 0, x: 100, y: 500 }] },
        { id: 'p4', name: 'C', radius: 5, keys: [{ t: 0, x: near ? 500 : 101, y: 500 }] }
      ]
    };
  }
  const r = core.compareScenes(scene(true), scene(false));
  // A×BC 碰撞消失，AB×C 碰撞新增 —— 两对不得因 join('') 键碰撞而被合并/错配
  assert.deepEqual(r.pairs.removed.map((p) => p.names), [['A', 'BC']]);
  assert.deepEqual(r.pairs.added.map((p) => p.names), [['AB', 'C']]);
});

test('内置样例自对比的不变计数与含修改场景的分类一致', () => {
  const s1 = core.builtinScene();
  const r0 = core.compareScenes(s1, JSON.parse(JSON.stringify(s1)));
  // 样例有 2 个碰撞对、2 条禁入冲突（甲、乙）
  assert.equal(r0.pairs.unchangedCount, 2);
  assert.equal(r0.obstacleIntrusions.unchangedCount, 2);

  const s2 = JSON.parse(JSON.stringify(s1));
  // 把甲两帧都右移 100（整条轨迹平移）：甲×乙交点错开 -> 该碰撞消失
  s2.performers[0].keys.forEach((k) => { k.x += 100; });
  const r = core.compareScenes(s1, s2);
  assert.ok(r.maxOffset > 0);
  const removedNames = r.pairs.removed.map((p) => p.names.join('|'));
  assert.ok(removedNames.some((n) => n.includes('乙') && n.includes('甲')));
});
