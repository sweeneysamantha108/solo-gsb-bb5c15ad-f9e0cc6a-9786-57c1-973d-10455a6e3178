'use strict';

/**
 * 道具交接时窗（handoffs）引擎用例：
 *  - 两人圆心同处交接区（严格内部）且间距 ≤ 触达距离的连续区间；
 *  - 触达距离切割、贴边停留不计、仅瞬时触达（零长度）不计；
 *  - 跨关键帧相接区间合并、多次停留多段、退化交接区无结果；
 *  - 起始时窗 [a, b-d]：b-a≥d 才给出（等号给单点时窗）；
 *  - aId===bId / 表演者缺失 → valid=false；
 *  - normalizeHandoffs 规整与缺省字段处理；
 *  - analyzeScene 的 handoffResults 装配及旧场景（无 handoffs）兼容；
 *  - 内置样例数值；
 *  - 与稠密采样在随机轨迹上逐点一致（实现本身解析）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;

function approx(actual, expected, tol = 1e-7, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

function assertIv(list, expected, tol = 1e-9) {
  assert.equal(list.length, expected.length, `区间数应为 ${expected.length}，实际 ${list.length}`);
  list.forEach((iv, i) => {
    approx(iv[0], expected[i][0], tol, `第 ${i + 1} 段起点`);
    approx(iv[1], expected[i][1], tol, `第 ${i + 1} 段终点`);
  });
}

// 甲：x=10t 向右；乙：x=120-10t 向左（y 恒为 50）
function crossScene(over) {
  const scene = {
    duration: T,
    performers: [
      { id: 'a', name: '甲', radius: 5, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 120, y: 50 }] },
      { id: 'b', name: '乙', radius: 5, keys: [{ t: 0, x: 120, y: 50 }, { t: 12, x: 0, y: 50 }] }
    ]
  };
  scene.handoffs = [Object.assign({
    id: 'h', aId: 'a', bId: 'b',
    x: 40, y: 40, width: 40, height: 20, reach: 40, minDuration: 1.5
  }, over || {})];
  return scene;
}

function firstResult(scene) {
  return core.analyzeScene(scene).handoffResults[0];
}

test('交接区间：两人横穿同一交接区且全程可触达，区间=停留交集 [4,8]，时窗 [4,6.5]', () => {
  // 甲 x=10t、乙 x=120-10t；矩形 x∈(40,80) → 两人停留均为 t∈(4,8)
  // 间距 |20t-120|≤40 → t∈[4,8]，整个交集窗满足；b-a=4 ≥ d=1.5 → [4, 6.5]
  const r = firstResult(crossScene());
  assert.equal(r.valid, true);
  assert.equal(r.feasible, true);
  assertIv(r.intervals, [[4, 8]]);
  assertIv(r.windows, [[4, 6.5]]);
  assert.equal(r.aName, '甲');
  assert.equal(r.bName, '乙');
  assert.equal(r.handoffId, 'h');
});

test('交接区间：触达距离切割——reach=20 把区间缩为 [5,7]，时窗 [5,6]', () => {
  // |20t-120|≤20 → t∈[5,7]
  const r = firstResult(crossScene({ reach: 20, minDuration: 1 }));
  assertIv(r.intervals, [[5, 7]]);
  assertIv(r.windows, [[5, 6]]);
});

test('交接区间：仅瞬时触达（reach=0，t=6 单一点）不计任何区间', () => {
  const r = firstResult(crossScene({ reach: 0, minDuration: 0.1 }));
  assertIv(r.intervals, []);
  assertIv(r.windows, []);
  assert.equal(r.feasible, false);
});

test('交接区间：贴边停留（甲圆心恒在矩形边界 y=40）不计', () => {
  const scene = crossScene();
  scene.performers[0].keys = [{ t: 0, x: 0, y: 40 }, { t: 12, x: 120, y: 40 }];
  const r = firstResult(scene);
  assertIv(r.intervals, []);
  assertIv(r.windows, []);
});

test('起始时窗：区间不足 d 时无窗口；b-a 恰等于 d 给单点时窗 [a,a]', () => {
  // 区间 [4,8] 长度 4
  let r = firstResult(crossScene({ minDuration: 5 }));
  assertIv(r.intervals, [[4, 8]]); // 可交接区间仍给出
  assertIv(r.windows, []); // 最短持续 5 > 4，无可用时窗
  assert.equal(r.feasible, false);

  r = firstResult(crossScene({ minDuration: 4 }));
  assertIv(r.windows, [[4, 4]]); // 等号包含：起始时窗退化为单点 4
  assert.equal(r.feasible, true);
});

test('交接区间：跨关键帧相接（同一直线被关键帧切分）合并为一段 [4,8]', () => {
  const scene = crossScene();
  scene.performers[0].keys = [
    { t: 0, x: 0, y: 50 }, { t: 6, x: 60, y: 50 }, { t: 12, x: 120, y: 50 }
  ];
  scene.performers[1].keys = [
    { t: 0, x: 120, y: 50 }, { t: 5, x: 70, y: 50 }, { t: 12, x: 0, y: 50 }
  ];
  const r = firstResult(scene);
  assertIv(r.intervals, [[4, 8]]);
  assert.equal(r.intervals.length, 1, '跨关键帧相接区间合并为一段');
  assertIv(r.windows, [[4, 6.5]]);
});

test('交接区间：一方往返多次进入，另一方静止在区内 → 多段区间与多个时窗', () => {
  // 甲往返：x=20t（t≤6）、x=240-20t（t>6）；矩形 x∈(40,80) → 停留 (2,4)、(8,10)
  // 乙静止 (60,50) 全程在区内；甲在区内时与乙间距 ≤20 < reach=30 恒满足
  const scene = {
    duration: T,
    performers: [
      { id: 'a', radius: 0, keys: [
        { t: 0, x: 0, y: 50 }, { t: 6, x: 120, y: 50 }, { t: 12, x: 0, y: 50 }
      ] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 60, y: 50 }] }
    ],
    handoffs: [{
      aId: 'a', bId: 'b', x: 40, y: 40, width: 40, height: 20, reach: 30, minDuration: 1
    }]
  };
  const r = firstResult(scene);
  assertIv(r.intervals, [[2, 4], [8, 10]]);
  assertIv(r.windows, [[2, 3], [8, 9]]);
});

test('交接区间：起点两人即在区内静止，区间从 0 开始', () => {
  const scene = {
    duration: 10,
    performers: [
      { id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 55, y: 50 }] }
    ],
    handoffs: [{
      aId: 'a', bId: 'b', x: 40, y: 40, width: 40, height: 20, reach: 10, minDuration: 2
    }]
  };
  const r = firstResult(scene);
  assertIv(r.intervals, [[0, 10]]);
  assertIv(r.windows, [[0, 8]]);
});

test('交接区间：退化交接区（0 宽 / 0 高）没有内部，永不满足', () => {
  assertIv(firstResult(crossScene({ width: 0 })).intervals, []);
  assertIv(firstResult(crossScene({ height: 0 })).windows, []);
});

test('交接区间：aId===bId 或表演者不存在 → valid=false 且无区间', () => {
  const scene1 = crossScene();
  scene1.handoffs[0].bId = 'a';
  const r1 = firstResult(scene1);
  assert.equal(r1.valid, false);
  assertIv(r1.intervals, []);

  const scene2 = crossScene();
  scene2.handoffs[0].bId = 'ghost';
  const r2 = firstResult(scene2);
  assert.equal(r2.valid, false);
  assertIv(r2.intervals, []);
});

test('rectangleStayIntervals：横穿停留区间为 [4.8,7.2]，与入场时刻同源', () => {
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] };
  const rect = { x: 40, y: 40, width: 20, height: 20 };
  const stays = core.rectangleStayIntervals(p, rect, T);
  assertIv(stays, [[4.8, 7.2]], 1e-9);
  // 进入时刻即停留段起点
  assert.deepEqual(core.rectangleEntryTimes(p, rect, T), [stays[0][0]]);
});

test('normalizeHandoffs：缺省 id 补全、数字 id 转字符串、负尺寸/触达钳零', () => {
  const list = core.normalizeHandoffs([
    { aId: 1, bId: 2, x: 10, y: 20, width: -5, height: 30, reach: -3, minDuration: 2 }
  ], 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].aId, '1');
  assert.equal(list[0].bId, '2');
  assert.ok(/^h/.test(list[0].id), '缺省 id 自动生成');
  assert.equal(list[0].width, 0);
  assert.equal(list[0].reach, 0);
});

test('normalizeHandoffs：minDuration≤0、缺表演者、非法字段、非对象均被过滤', () => {
  const list = core.normalizeHandoffs([
    { aId: 'a', bId: 'b', x: 0, y: 0, width: 10, height: 10, reach: 5, minDuration: 0 },
    { aId: 'a', bId: 'b', x: 0, y: 0, width: 10, height: 10, reach: 5, minDuration: -1 },
    { aId: 'a', x: 0, y: 0, width: 10, height: 10, reach: 5, minDuration: 1 },
    { aId: 'a', bId: 'b', x: 'x', y: 0, width: 10, height: 10, reach: 5, minDuration: 1 },
    null
  ], 10);
  assert.deepEqual(list, []);
  assert.deepEqual(core.normalizeHandoffs(null, 10), []);
});

test('normalizeHandoffs：幂等（二次规整保留已生成 id 与数值）', () => {
  const once = core.normalizeHandoffs([
    { aId: 'a', bId: 'b', x: 1, y: 2, width: 3, height: 4, reach: 5, minDuration: 6 }
  ], 10);
  const twice = core.normalizeHandoffs(once, 10);
  assert.deepEqual(twice, once);
});

test('analyzeScene：handoffResults 每项配置一条；旧场景（无 handoffs）为空数组', () => {
  const scene = crossScene();
  scene.handoffs.push({
    aId: 'a', bId: 'b', x: 0, y: 0, width: 10, height: 10, reach: 1, minDuration: 1
  });
  const r = core.analyzeScene(scene);
  assert.equal(r.handoffs.length, 2);
  assert.equal(r.handoffResults.length, 2);
  assert.equal(r.handoffResults[1].feasible, false, '交接区在 (0,0) 两人永不进入');

  const old = core.analyzeScene({ duration: T, performers: scene.performers });
  assert.deepEqual(old.handoffs, []);
  assert.deepEqual(old.handoffResults, []);
});

test('内置样例：甲×乙中央交接，区间 ≈[5.18,6.82]、起始时窗 ≈[5.18,6.32]', () => {
  const s = core.builtinScene();
  assert.equal(s.handoffs.length, 1);
  const r = core.analyzeScene(s);
  const h = r.handoffResults[0];
  assert.equal(h.feasible, true);
  assertIv(h.intervals, [[4560 / 880, 6000 / 880]], 1e-9);
  assertIv(h.windows, [[4560 / 880, 6000 / 880 - 0.5]], 1e-9);
  assert.equal(h.aId, 'p1');
  assert.equal(h.bId, 'p2');
});

test('isHandoffActive：区间内为真、区间外为假', () => {
  const r = firstResult(crossScene());
  assert.equal(core.isHandoffActive(r, 5), true);
  assert.equal(core.isHandoffActive(r, 4), true, '含进入端点');
  assert.equal(core.isHandoffActive(r, 8), true, '含离开端点');
  assert.equal(core.isHandoffActive(r, 3.9), false);
  assert.equal(core.isHandoffActive(r, 8.2), false);
  assert.equal(core.isHandoffActive(null, 5), false);
});

test('交接区间：与稠密采样在随机分段轨迹 / 矩形 / 触达距离上逐点一致（实现解析）', () => {
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
    const mkPerformer = () => {
      const nk = 1 + Math.floor(rnd() * 3);
      const keys = [];
      for (let i = 0; i <= nk; i++) {
        keys.push({
          t: Math.round((T * i) / nk * 10) / 10,
          x: rc() + 40,
          y: rc() + 40
        });
      }
      return { id: 'p', radius: Math.round(rnd() * 10), keys };
    };
    const pa = mkPerformer();
    const pb = mkPerformer();
    pb.id = 'q';
    const rect = {
      x: rc() + 20,
      y: rc() + 20,
      width: 20 + rnd() * 80,
      height: 20 + rnd() * 80
    };
    const reach = 20 + rnd() * 60;
    const r = core.analyzeHandoff(
      { id: 'h', aId: 'p', bId: 'q', reach: reach, minDuration: 0.1 + rnd() * 2,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      pa, pb, T
    );
    const X1 = rect.x + rect.width;
    const Y1 = rect.y + rect.height;
    function truth(t) {
      const sa = core.stateAt(pa.keys, t, pa.radius);
      const sb = core.stateAt(pb.keys, t, pb.radius);
      const inA = sa.x > rect.x && sa.x < X1 && sa.y > rect.y && sa.y < Y1;
      const inB = sb.x > rect.x && sb.x < X1 && sb.y > rect.y && sb.y < Y1;
      return inA && inB && Math.hypot(sa.x - sb.x, sa.y - sb.y) <= reach + 1e-8;
    }
    // 区间自由端点（未被 [0,T] 钳制）必须恰在进入/离开边界上：
    // 要么在矩形边界上（某一坐标在内、另一坐标在边），要么间距恰等于触达距离
    for (let i = 0; i <= 4000; i++) {
      const t = (T * i) / 4000;
      const pred = r.intervals.some((iv) => t >= iv[0] - 1e-8 && t <= iv[1] + 1e-8);
      assert.equal(pred, truth(t), `trial${trial} t=${t} 交接状态不一致`);
    }
    // 每个时窗确实来自对应可交接区间且窗口点都在区间内
    r.windows.forEach((w, i) => {
      assert.ok(r.intervals.some((iv) => w[0] >= iv[0] - 1e-8 && w[1] <= iv[1] - 1e-8 + 1e-7),
        `trial${trial} 时窗 ${i} 超出可交接区间`);
    });
  }
});
