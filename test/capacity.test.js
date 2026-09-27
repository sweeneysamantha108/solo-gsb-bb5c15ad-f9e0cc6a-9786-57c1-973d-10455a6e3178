'use strict';

/**
 * 区域限员（capacity zones）引擎用例：
 *  - 只统计圆心严格位于矩形内部者：贴边、瞬时触角、零宽高区域不计；
 *  - 同刻进出一并处理，不产生零长度超员段；
 *  - 跨关键帧相接的连续停留合并，同一人同次停留只计一次；
 *  - 名单变化即分段；全程峰值只计有正持续时间的状态；
 *  - 起点即在内部、开场/收场单点状态、往返多次进入；
 *  - normalizeCapacityZones 规整（正整数上限、缺省 id/name、非法项过滤）；
 *  - analyzeScene 的 capacityResults 装配及旧场景（无 capacityZones）兼容；
 *  - 内置样例数值；
 *  - 与稠密采样在随机轨迹上逐点一致（实现本身解析）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;
const ZONE = { id: 'z', name: '限员区', x: 40, y: 40, width: 20, height: 20 };

function approx(actual, expected, tol = 1e-7, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

// 水平横穿者：x=10t、y=50，矩形 [40,60]×[40,60] → 圆心在内部 t∈(4,6)
function crosser(id, name, y) {
  return {
    id: id, name: name || id, radius: 0,
    keys: [{ t: 0, x: 0, y: y == null ? 50 : y }, { t: T, x: 120, y: y == null ? 50 : y }]
  };
}

test('限员区：单横穿者不超员（上限 1），峰值 1 且超员段为空', () => {
  const r = core.analyzeCapacityZone(
    Object.assign({ limit: 1 }, ZONE), [crosser('a', '甲')], T);
  assert.equal(r.overcrowded, false);
  assert.deepEqual(r.intervals, []);
  assert.equal(r.firstStart, null);
  assert.equal(r.peak, 1);
  approx(r.peakT, 4, 1e-9, '峰值状态自 t=4 起');
  assert.deepEqual(r.peakMembers.map((m) => m.id), ['a']);
});

test('限员区：两人同时横穿，重叠段 (4,6) 超员（上限 1），段内名单为两人', () => {
  const r = core.analyzeCapacityZone(
    Object.assign({ limit: 1 }, ZONE), [crosser('a', '甲'), crosser('b', '乙')], T);
  assert.equal(r.overcrowded, true);
  assert.equal(r.intervals.length, 1);
  const iv = r.intervals[0];
  approx(iv.start, 4, 1e-9);
  approx(iv.end, 6, 1e-9);
  assert.equal(iv.count, 2);
  assert.deepEqual(iv.members.map((m) => m.id), ['a', 'b'], '名单按场景内表演者次序');
  approx(r.firstStart, 4, 1e-9);
  assert.equal(r.peak, 2);
  approx(r.peakT, 4, 1e-9);
});

test('限员区：上限 2 时两人重叠不超员，峰值仍为 2', () => {
  const r = core.analyzeCapacityZone(
    Object.assign({ limit: 2 }, ZONE), [crosser('a'), crosser('b')], T);
  assert.equal(r.overcrowded, false);
  assert.deepEqual(r.intervals, []);
  assert.equal(r.peak, 2);
});

test('限员区：圆心贴边（沿 y=40 边界）全程不计，峰值 0', () => {
  const r = core.analyzeCapacityZone(
    Object.assign({ limit: 1 }, ZONE), [crosser('a', '甲', 40)], T);
  assert.equal(r.overcrowded, false);
  assert.deepEqual(r.intervals, []);
  assert.equal(r.peak, 0, '贴边者从不在册');
  assert.equal(r.peakT, null);
  assert.deepEqual(r.peakMembers, []);
});

test('限员区：仅瞬时触角（穿过角点，圆心从不进入内部）不计', () => {
  // 沿对角线 y=x 经过左下角点 (40,40) 后离开矩形同侧：x=10t 在 t=4 触角点，
  // 之后 x>40 且 y>40 反而进入内部——改用沿 y=40 的水平线已覆盖贴边；
  // 这里取从角点擦出的轨迹：直线 y=80-x，经过右上角 (60,60)? 代入 x=20,y=60 →
  // 真正只触角点：轨迹 y=40-(x-40)=80-x，t∈[3.5,4.5] 之间考察是否进入
  const p = {
    id: 'a', name: '甲', radius: 0,
    keys: [{ t: 0, x: 30, y: 50 }, { t: 10, x: 50, y: 30 }] // y=80-x：t=4 时 (40,40) 角点
  };
  // t<4 时 x<40、y>40；t>4 时 x>40、y<40：圆心从不在 (40,60)×(40,60) 内部
  const r = core.analyzeCapacityZone(Object.assign({ limit: 1 }, ZONE), [p], 10);
  assert.equal(r.peak, 0, '仅抵角点瞬时触角不计');
  assert.deepEqual(r.intervals, []);
});

test('限员区：零宽 / 零高退化区域没有内部，永不统计', () => {
  const inside = { id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] };
  const r1 = core.analyzeCapacityZone({ id: 'z', x: 40, y: 40, width: 0, height: 20, limit: 1 }, [inside], T);
  assert.equal(r1.peak, 0);
  assert.deepEqual(r1.intervals, []);
  const r2 = core.analyzeCapacityZone({ id: 'z', x: 40, y: 40, width: 20, height: 0, limit: 1 }, [inside], T);
  assert.equal(r2.peak, 0);
});

test('限员区：同刻一进一出一并处理，不产生瞬时超员或零长度段', () => {
  // 甲开场在内部、t=5 经左边界离开（停留 (0,5)）；乙开场在左边界上（贴边
  // 不计），t=5 后进入内部（停留 (5,10)）。上限 1：任意正持续时刻恰有 1 人
  const ps = [
    { id: 'a', name: '甲', radius: 0, keys: [
      { t: 0, x: 50, y: 50 }, { t: 5, x: 40, y: 50 }, { t: T, x: 40, y: 50 }
    ] }, // x=50-2t，t=5 到左边界 40，停留 (0,5)
    { id: 'b', name: '乙', radius: 0, keys: [
      { t: 0, x: 40, y: 50 }, { t: 5, x: 40, y: 50 }, { t: T, x: 68, y: 50 }
    ] } // t≥5 起 x=40+4(t-5)，t=10 到 68→进入 40 于 t=5，离开 60 于 t=10，停留 (5,10)
  ];
  const r = core.analyzeCapacityZone(Object.assign({ limit: 1 }, ZONE), ps, T);
  assert.deepEqual(r.intervals, [], '同刻交换不产生超员段');
  assert.equal(r.peak, 1);
});

test('限员区：同刻两进（开场即在内部）按 2 人正持续状态计，不产生零长度段', () => {
  const ps = [
    { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 50, y: 50 }, { t: T, x: 50, y: 50 }] },
    { id: 'b', name: '乙', radius: 0, keys: [{ t: 0, x: 55, y: 50 }, { t: T, x: 55, y: 50 }] }
  ];
  const r = core.analyzeCapacityZone(Object.assign({ limit: 1 }, ZONE), ps, T);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0].start, 0, 1e-9);
  approx(r.intervals[0].end, T, 1e-9);
  assert.equal(r.intervals[0].count, 2);
});

test('限员区：收场时单点进入（最后一刻才到边界）不产生零长度段', () => {
  // 甲 (0,50)->(40,50) 在 t=T 恰好到左边界（贴边，无内部长度）；
  // 乙全程静止在内部，上限 2 → 不超员，峰值 1
  const ps = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: T, x: 40, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ];
  const r = core.analyzeCapacityZone(Object.assign({ limit: 2 }, ZONE), ps, T);
  assert.deepEqual(r.intervals, []);
  assert.equal(r.peak, 1);
});

test('限员区：名单变化即分段（即使人数不变也拆段）', () => {
  // 上限 1；乙 t=8 离场、t=9 折返重新进入（两段独立停留）：
  //   甲停留 (0,8)；乙停留 (2,8) 与 (9,12)；丙停留 (5,10)
  // 状态：[0,2){甲}=1；[2,5){甲,乙}=2；[5,8){甲,乙,丙}=3；[8,9){丙}=1；
  //       [9,10){乙,丙}=2；[10,12){乙}=1
  const K = (arr) => arr.map(([t, x]) => ({ t, x, y: 50 }));
  const ps = [
    { id: 'a', name: '甲', radius: 0, keys: K([[0, 50], [7, 50], [8, 40], [12, 40]]) },
    { id: 'b', name: '乙', radius: 0, keys: K(
      [[0, 40], [2, 40], [3, 50], [7, 50], [8, 60], [9, 60], [10, 40], [11, 50], [12, 50]]) },
    { id: 'c', name: '丙', radius: 0, keys: K([[0, 40], [5, 40], [6, 50], [9, 50], [10, 60], [12, 60]]) }
  ];
  const r = core.analyzeCapacityZone(Object.assign({ limit: 1 }, ZONE), ps, T);
  assert.equal(r.intervals.length, 3, '名单变化即分段：3 个超员段');
  approx(r.intervals[0].start, 2, 1e-9);
  approx(r.intervals[0].end, 5, 1e-9);
  assert.equal(r.intervals[0].count, 2);
  assert.deepEqual(r.intervals[0].members.map((m) => m.id), ['a', 'b']);
  approx(r.intervals[1].start, 5, 1e-9);
  approx(r.intervals[1].end, 8, 1e-9);
  assert.equal(r.intervals[1].count, 3);
  assert.deepEqual(r.intervals[1].members.map((m) => m.id), ['a', 'b', 'c']);
  approx(r.intervals[2].start, 9, 1e-9);
  approx(r.intervals[2].end, 10, 1e-9);
  assert.equal(r.intervals[2].count, 2);
  assert.deepEqual(r.intervals[2].members.map((m) => m.id), ['b', 'c'],
    '甲已离场、乙折返重新进入后：名单为乙、丙');
  assert.equal(r.peak, 3);
  approx(r.peakT, 5, 1e-9);
});

test('限员区：同一人同一次停留只计一次（关键帧在区内切段不重复计数）', () => {
  // 匀速横穿但用共线关键帧人为切成三段，与单段轨迹结果一致
  const p1 = { id: 'a', radius: 0, keys: [
    { t: 0, x: 0, y: 50 }, { t: 5, x: 50, y: 50 }, { t: T, x: 120, y: 50 }
  ] };
  const p2 = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: T, x: 120, y: 50 }] };
  const r1 = core.analyzeCapacityZone(Object.assign({ limit: 1 }, ZONE), [p1], T);
  const r2 = core.analyzeCapacityZone(Object.assign({ limit: 1 }, ZONE), [p2], T);
  assert.equal(r1.peak, r2.peak);
  approx(r1.peakT, r2.peakT, 1e-9);
  assert.equal(r1.intervals.length, r2.intervals.length);
});

test('限员区：一人往返多次进入产生多次停留，各自参与超员统计', () => {
  // 甲往返 x=20t（t≤6）、240-20t（t>6）：进入 x=40 于 t=2、离开 x=60 于 t=3，
  // 折返后重新进入 x=60 于 t=9、离开 x=40 于 t=10 → 停留 (2,3)、(9,10)；
  // 乙静止在区内。上限 1 → 两个超员段
  const ps = [
    { id: 'a', name: '甲', radius: 0, keys: [
      { t: 0, x: 0, y: 50 }, { t: 6, x: 120, y: 50 }, { t: 12, x: 0, y: 50 }
    ] },
    { id: 'b', name: '乙', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ];
  const r = core.analyzeCapacityZone(Object.assign({ limit: 1 }, ZONE), ps, T);
  assert.equal(r.intervals.length, 2);
  approx(r.intervals[0].start, 2, 1e-9);
  approx(r.intervals[0].end, 3, 1e-9);
  approx(r.intervals[1].start, 9, 1e-9);
  approx(r.intervals[1].end, 10, 1e-9);
  r.intervals.forEach((iv) => {
    assert.equal(iv.count, 2);
    assert.deepEqual(iv.members.map((m) => m.id), ['a', 'b']);
  });
  assert.equal(r.peak, 2);
});

test('normalizeCapacityZones：正整数上限（小数向下取整）、缺省 id/name、非法项过滤', () => {
  const list = core.normalizeCapacityZones([
    { name: '台口', x: 1, y: 2, width: 30, height: 40, limit: 3 },
    { x: 0, y: 0, width: 10, height: 10, limit: 2.9 },   // 小数向下取整为 2
    { x: 0, y: 0, width: 10, height: 10, limit: 0 },     // 非正：丢弃
    { x: 0, y: 0, width: 10, height: 10, limit: -2 },    // 负：丢弃
    { x: 0, y: 0, width: 10, height: 10 },               // 缺 limit：丢弃
    { x: 'x', y: 0, width: 10, height: 10, limit: 1 },   // 非法坐标：丢弃
    null
  ]);
  assert.equal(list.length, 2);
  assert.ok(/^z/.test(list[0].id), '缺省 id 自动生成');
  assert.equal(list[0].name, '台口');
  assert.equal(list[0].limit, 3);
  assert.equal(list[1].limit, 2, '小数向下取整');
  assert.equal(list[1].name, '限员区 2');
  assert.deepEqual(core.normalizeCapacityZones(null), []);
});

test('normalizeCapacityZones：幂等（二次规整保留已生成 id 与数值）', () => {
  const once = core.normalizeCapacityZones([{ x: 1, y: 2, width: 3, height: 4, limit: 5 }]);
  const twice = core.normalizeCapacityZones(once);
  assert.deepEqual(twice, once);
});

test('analyzeScene：capacityResults 每个限员区一条；旧场景（无 capacityZones）为空数组', () => {
  const scene = core.builtinScene();
  const r = core.analyzeScene(scene);
  assert.equal(r.capacityZones.length, 1);
  assert.equal(r.capacityResults.length, 1);

  const old = core.analyzeScene({ duration: T, performers: scene.performers });
  assert.deepEqual(old.capacityZones, []);
  assert.deepEqual(old.capacityResults, []);
});

test('内置样例：中央限员区上限 1，唯一超员段 ≈[5.18,6.82]、峰值 2（甲、乙）', () => {
  const r = core.analyzeScene(core.builtinScene());
  const z = r.capacityResults[0];
  assert.equal(z.zoneId, 'z1');
  assert.equal(z.limit, 1);
  assert.equal(z.overcrowded, true);
  assert.equal(z.intervals.length, 1);
  approx(z.intervals[0].start, 4560 / 880, 1e-9);
  approx(z.intervals[0].end, 6000 / 880, 1e-9);
  assert.equal(z.intervals[0].count, 2);
  assert.deepEqual(z.intervals[0].members.map((m) => m.id), ['p1', 'p2']);
  assert.equal(z.peak, 2);
  approx(z.peakT, 4560 / 880, 1e-9);
  assert.deepEqual(z.peakMembers.map((m) => m.id), ['p1', 'p2']);
});

test('isCapacityOverAt：超员段内为真、段外与零容差端点一致', () => {
  const r = core.analyzeScene(core.builtinScene()).capacityResults[0];
  assert.equal(core.isCapacityOverAt(r, 6), true);
  assert.equal(core.isCapacityOverAt(r, 4), false);
  assert.equal(core.isCapacityOverAt(null, 6), false);
});

test('限员区：与稠密采样在随机分段轨迹 / 矩形 / 上限上逐点一致（实现解析）', () => {
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260927);
  function rc() { return Math.round(rnd() * 120) - 10; }

  for (let trial = 0; trial < 40; trial++) {
    const n = 2 + Math.floor(rnd() * 3); // 2~4 人
    const performers = [];
    for (let pi = 0; pi < n; pi++) {
      const nk = 1 + Math.floor(rnd() * 3);
      const keys = [];
      for (let i = 0; i <= nk; i++) {
        keys.push({
          t: Math.round((T * i) / nk * 10) / 10,
          x: rc() + 40,
          y: rc() + 40
        });
      }
      performers.push({ id: 'p' + pi, name: 'P' + pi, radius: 0, keys });
    }
    const zone = {
      id: 'z',
      x: rc() + 20,
      y: rc() + 20,
      width: 10 + rnd() * 90,
      height: 10 + rnd() * 90,
      limit: 1 + Math.floor(rnd() * 2)
    };
    const X1 = zone.x + zone.width;
    const Y1 = zone.y + zone.height;
    const r = core.analyzeCapacityZone(zone, performers, T);
    // 引擎跨关键帧合并按 ~1e-6 容差（与 mergeIntervals 一致），真值判定同口径
    const B_EPS = 2e-6;

    function truth(t) {
      const members = [];
      performers.forEach((p) => {
        const pos = core.positionAt(core.normalizeKeys(p.keys), t);
        if (pos.x > zone.x + B_EPS && pos.x < X1 - B_EPS &&
            pos.y > zone.y + B_EPS && pos.y < Y1 - B_EPS) {
          members.push(p.id);
        }
      });
      return { count: members.length, over: members.length > zone.limit, members };
    }

    // 超员段端点必为某人进入/离开矩形边界的时刻；稠密网格恰落在端点时，
    // 圆心在边界上（开区间判定为不在），跳过这些零测时刻
    function atEndpoint(t) {
      return r.intervals.some((iv) =>
        Math.abs(t - iv.start) <= B_EPS || Math.abs(t - iv.end) <= B_EPS);
    }
    for (let i = 0; i <= 4000; i++) {
      const t = (T * i) / 4000;
      const seg = r.intervals.find((iv) => t >= iv.start - B_EPS && t <= iv.end + B_EPS);
      const truthState = truth(t);
      if (!seg) {
        assert.equal(truthState.over, false, `trial${trial} t=${t} 超员但未落入任何超员段`);
      } else if (atEndpoint(t)) {
        continue; // 恰落在超员段端点：边界时刻在册与否按开区间可为假
      } else {
        assert.equal(truthState.over, true, `trial${trial} t=${t} 段内应为超员`);
        assert.equal(truthState.count, seg.count, `trial${trial} t=${t} 人数不一致`);
        assert.deepEqual(truthState.members, seg.members.map((m) => m.id),
          `trial${trial} t=${t} 名单不一致`);
      }
    }

    // 峰值：扫描全部超员/非超员恒定状态的中点取最大在册数
    const times = [0];
    performers.forEach((p) => {
      core.rectangleStayIntervals(p, zone, T).forEach((iv) => { times.push(iv[0], iv[1]); });
    });
    times.push(T);
    times.sort((a, b) => a - b);
    let samplePeak = 0;
    for (let i = 0; i < times.length - 1; i++) {
      if (times[i + 1] - times[i] <= 1e-7) continue;
      const mid = (times[i] + times[i + 1]) / 2;
      samplePeak = Math.max(samplePeak, truth(mid).count);
    }
    assert.equal(r.peak, samplePeak, `trial${trial} 峰值人数不一致`);
  }
});
