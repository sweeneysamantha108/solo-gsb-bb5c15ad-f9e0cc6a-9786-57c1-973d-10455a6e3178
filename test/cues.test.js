'use strict';

/**
 * 入场口令（entry cues）引擎用例：
 *  - rectangleEntryTimes：圆心严格进入矩形内部（起点在内按 t=0、贴边不计、
 *    角点穿过计入、退化矩形无进入、跨关键帧合并、多次进入）；
 *  - evaluateCues：时窗含端点、触发时刻严格递增、同一次停留只计一次、
 *    错过时窗 / 前序未完成链路语义；
 *  - normalizeCues：缺省时窗、端点倒置交换、非法项过滤；
 *  - analyzeScene：cueResults 只含携带口令者；
 *  - 与稠密采样在随机轨迹上逐点一致。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;
const RECT = { x: 40, y: 40, width: 20, height: 20 };

function approx(actual, expected, tol = 1e-7, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

function cue(over) {
  return Object.assign({ id: 'c', x: 40, y: 40, width: 20, height: 20, winStart: 0, winEnd: T }, over || {});
}

// 起点 (0,50) 以速度 100/12 水平横穿：圆心在 x∈(40,60) 内即进入
const crosser = () => ({ id: 'a', radius: 99, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] });

test('入场时刻：水平横穿，进入时刻只看圆心（与半径无关）', () => {
  const times = core.rectangleEntryTimes(crosser(), cue(), T);
  assert.equal(times.length, 1);
  approx(times[0], 4.8, 1e-9, 'x=40 对应 t=4.8');
  // 半径 99 与半径 0 的进入时刻一致（核对圆心而非膨胀边界）
  const zero = core.rectangleEntryTimes(
    { id: 'b', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] }, cue(), T);
  approx(zero[0], times[0], 1e-12);
});

test('入场时刻：起点已在矩形内部按 0 秒进入', () => {
  const p = { id: 'a', radius: 5, keys: [{ t: 0, x: 50, y: 50 }, { t: 12, x: 100, y: 50 }] };
  const times = core.rectangleEntryTimes(p, cue(), T);
  assert.deepEqual(times, [0]);
});

test('入场时刻：全程静止在矩形内部只有一次 0 秒进入', () => {
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] };
  assert.deepEqual(core.rectangleEntryTimes(p, cue(), T), [0]);
});

test('入场时刻：沿边擦边（圆心恒在边界 y=40）不计进入', () => {
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 40 }, { t: 12, x: 100, y: 40 }] };
  assert.deepEqual(core.rectangleEntryTimes(p, cue(), T), []);
});

test('入场时刻：仅抵达角点（V 形折返）不计进入', () => {
  // (30,50)->(50,30) 直线 x+y=80，内部要求 x>40 且 y>40 ⇒ x∈(40,40) 为空，
  // 仅在 (40,40) 角点相触
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 30, y: 50 }, { t: 6, x: 50, y: 30 }] };
  assert.deepEqual(core.rectangleEntryTimes(p, cue(), T), []);
});

test('入场时刻：穿过角点进入内部，在角点时刻计入', () => {
  // (0,0)->(100,100) 对角线，x=y∈(40,60) 为内部；经过角点 (40,40) 后进入
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 0 }, { t: 12, x: 100, y: 100 }] };
  const times = core.rectangleEntryTimes(p, cue(), T);
  assert.equal(times.length, 1);
  approx(times[0], 4.8, 1e-9);
});

test('入场时刻：从边界起步随即进入，进入时刻为该边界时刻', () => {
  // t=0 圆心恰在 x=40 边上，随后进入 -> t=0 计入
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 40, y: 50 }, { t: 12, x: 100, y: 50 }] };
  assert.deepEqual(core.rectangleEntryTimes(p, cue(), T), [0]);
});

test('入场时刻：退化矩形（0 宽 / 0 高）没有内部，永不触发', () => {
  const p = crosser();
  assert.deepEqual(core.rectangleEntryTimes(p, cue({ width: 0 }), T), []);
  assert.deepEqual(core.rectangleEntryTimes(p, cue({ height: 0 }), T), []);
});

test('入场时刻：分段往返两次进入，返回两个严格递增时刻', () => {
  const p = { id: 'a', radius: 0, keys: [
    { t: 0, x: 0, y: 50 }, { t: 4, x: 100, y: 50 }, { t: 8, x: 0, y: 50 }
  ] };
  const times = core.rectangleEntryTimes(p, cue(), T);
  assert.equal(times.length, 2);
  approx(times[0], 1.6, 1e-9);
  approx(times[1], 5.6, 1e-9);
  assert.ok(times[1] > times[0]);
});

test('入场时刻：跨关键帧的相接停留合并为一次进入', () => {
  // 单段匀速（t=4.8 进入）vs 在内部点 (50,50) 切两段，结果一致
  const one = { id: 'a', radius: 0, keys: [
    { t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }
  ] };
  const two = { id: 'b', radius: 0, keys: [
    { t: 0, x: 0, y: 50 }, { t: 6, x: 50, y: 50 }, { t: 12, x: 100, y: 50 }
  ] };
  const t1 = core.rectangleEntryTimes(one, cue(), T);
  const t2 = core.rectangleEntryTimes(two, cue(), T);
  assert.deepEqual(t1, t2);
  approx(t2[0], 4.8, 1e-9);
});

test('入场时刻：与稠密采样在随机分段轨迹上逐点一致', () => {
  for (let trial = 0; trial < 40; trial++) {
    const n = 2 + Math.floor(Math.random() * 4);
    const keys = [];
    for (let i = 0; i < n; i++) {
      keys.push({
        t: (T * i) / (n - 1),
        x: Math.random() * 120 - 10,
        y: Math.random() * 120 - 10
      });
    }
    const p = { id: 'a', radius: Math.random() * 30, keys: keys };
    const rc = {
      x: 10 + Math.random() * 60,
      y: 10 + Math.random() * 60,
      width: Math.random() * 50,
      height: Math.random() * 50
    };
    const entries = core.rectangleEntryTimes(p, Object.assign(cue(), rc), T);

    // 采样：在内部指示由 false→true（含 t=0 即在内部）的时刻近旁必有一个解析进入
    const inside = (t) => {
      const s = core.stateAt(keys, t, p.radius);
      return s.x > rc.x && s.x < rc.x + rc.width && s.y > rc.y && s.y < rc.y + rc.height;
    };
    const STEP = 0.002;
    let prev = inside(0);
    let sampledEntries = prev ? [0] : [];
    for (let t = STEP; t <= T + 1e-9; t += STEP) {
      const cur = inside(t);
      if (cur && !prev) sampledEntries.push(t);
      prev = cur;
    }
    assert.equal(entries.length, sampledEntries.length,
      `trial ${trial}: 进入次数 ${entries.length} vs 采样 ${sampledEntries.length}`);
    entries.forEach((e, i) => {
      assert.ok(Math.abs(e - sampledEntries[i]) < STEP * 2,
        `trial ${trial}: 进入时刻 ${e} vs 采样 ${sampledEntries[i]}`);
    });
  }
});

// ---------- evaluateCues：顺序匹配语义 ----------

test('evaluateCues：窗内进入触发并给出 triggerT；窗外错过', () => {
  const p = crosser();
  p.cues = [cue({ id: 'a', winStart: 4, winEnd: 6 }), cue({ id: 'b', winStart: 6, winEnd: 8 })];
  const r = core.evaluateCues(p, T);
  assert.equal(r[0].status, 'triggered');
  approx(r[0].triggerT, 4.8, 1e-9);
  assert.equal(r[1].status, 'missed');
  assert.equal(r[1].triggerT, null);
});

test('evaluateCues：时窗含端点（进入时刻恰为窗边界仍触发）', () => {
  const p = crosser();
  p.cues = [cue({ winStart: 4.8, winEnd: 4.8 })];
  const r = core.evaluateCues(p, T);
  assert.equal(r[0].status, 'triggered');
  approx(r[0].triggerT, 4.8, 1e-9);
});

test('evaluateCues：触发时刻严格递增，早于上一触发的进入不可再用', () => {
  // 第二次进入 t=5.6；第一条口令取进入 1.6，第二条时窗 [0,5.5] 只覆盖 1.6（已用）
  const p = { id: 'a', radius: 0, keys: [
    { t: 0, x: 0, y: 50 }, { t: 4, x: 100, y: 50 }, { t: 8, x: 0, y: 50 }
  ] };
  p.cues = [
    cue({ id: 'a', winStart: 0, winEnd: 12 }),
    cue({ id: 'b', winStart: 0, winEnd: 5.5 })
  ];
  const r = core.evaluateCues(p, T);
  assert.equal(r[0].status, 'triggered');
  approx(r[0].triggerT, 1.6, 1e-9);
  assert.equal(r[1].status, 'missed', '更晚时窗内没有严格更晚的进入');
});

test('evaluateCues：同一次停留只能计一次（两条口令共用同一次进入）', () => {
  const p = crosser();
  p.cues = [cue({ id: 'a', winStart: 0, winEnd: 12 }), cue({ id: 'b', winStart: 0, winEnd: 12 })];
  const r = core.evaluateCues(p, T);
  assert.equal(r[0].status, 'triggered');
  assert.equal(r[1].status, 'missed', '同次停留不能重复计数');
});

test('evaluateCues：两次停留可依次触发两条口令', () => {
  const p = { id: 'a', radius: 0, keys: [
    { t: 0, x: 0, y: 50 }, { t: 4, x: 100, y: 50 }, { t: 8, x: 0, y: 50 }
  ] };
  p.cues = [
    cue({ id: 'a', winStart: 0, winEnd: 12 }),
    cue({ id: 'b', winStart: 0, winEnd: 12 })
  ];
  const r = core.evaluateCues(p, T);
  assert.equal(r[0].status, 'triggered');
  approx(r[0].triggerT, 1.6, 1e-9);
  assert.equal(r[1].status, 'triggered');
  approx(r[1].triggerT, 5.6, 1e-9);
});

test('evaluateCues：错过时窗后其后各项记为前序未完成', () => {
  const p = crosser();
  p.cues = [
    cue({ id: 'a', winStart: 0, winEnd: 1 }),    // 进入 4.8 不在窗内 -> missed
    cue({ id: 'b', winStart: 4, winEnd: 6 }),    // 本可触发但链路已断 -> blocked
    cue({ id: 'c', winStart: 0, winEnd: 12 })    // blocked
  ];
  const r = core.evaluateCues(p, T);
  assert.deepEqual(r.map((x) => x.status), ['missed', 'blocked', 'blocked']);
});

test('evaluateCues：不同入口矩形互不占用停留，各自按时窗触发', () => {
  // 同一直线先后穿过两个不同矩形
  const p = { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] };
  p.cues = [
    cue({ id: 'a', x: 10, y: 40, width: 10, height: 20, winStart: 0, winEnd: 12 }),
    cue({ id: 'b', x: 60, y: 40, width: 10, height: 20, winStart: 0, winEnd: 12 })
  ];
  const r = core.evaluateCues(p, T);
  assert.equal(r[0].status, 'triggered');
  approx(r[0].triggerT, 1.2, 1e-9, '进入 x∈(10,20)');
  assert.equal(r[1].status, 'triggered');
  approx(r[1].triggerT, 7.2, 1e-9, '进入 x∈(60,70)');
});

test('evaluateCues：未触发结果携带全部进入时刻用于诊断', () => {
  const p = crosser();
  p.cues = [cue({ winStart: 0, winEnd: 1 })];
  const r = core.evaluateCues(p, T);
  assert.equal(r[0].status, 'missed');
  assert.equal(r[0].entries.length, 1);
  approx(r[0].entries[0], 4.8, 1e-9);
});

// ---------- normalizeCues ----------

test('normalizeCues：缺省时窗补 [0,duration]、端点倒置交换、缺省 id 补全', () => {
  const list = core.normalizeCues([
    { x: 1, y: 2, width: 3, height: 4, winStart: 9, winEnd: 2 },
    { x: 0, y: 0, width: -5, height: 0 }
  ], 10);
  assert.equal(list.length, 2);
  assert.equal(list[0].winStart, 2);
  assert.equal(list[0].winEnd, 9);
  assert.ok(list[0].id, '缺省 id 自动生成');
  assert.equal(list[1].winStart, 0);
  assert.equal(list[1].winEnd, 10);
  assert.equal(list[1].width, 0, '负宽钳零');
});

test('normalizeCues：非法项过滤，非数组/空安全返回', () => {
  assert.deepEqual(core.normalizeCues(null, 10), []);
  const list = core.normalizeCues([
    null,
    { x: 'x', y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 1, height: 1 }
  ], 10);
  assert.equal(list.length, 1);
});

test('analyzeScene：cueResults 只包含携带口令的表演者，内置样例含甲三项链路', () => {
  const s = core.builtinScene();
  const a = core.analyzeScene(s);
  const ids = a.cueResults.map((e) => e.performerId).sort();
  assert.deepEqual(ids, ['p1', 'p2']);
  const jia = a.cueResults.find((e) => e.performerId === 'p1');
  assert.deepEqual(jia.results.map((r) => r.status), ['triggered', 'missed', 'blocked']);
  approx(jia.results[0].triggerT, 5.18181818, 1e-6);
  const yi = a.cueResults.find((e) => e.performerId === 'p2');
  assert.equal(yi.results[0].status, 'triggered');
  approx(yi.results[0].triggerT, 4.61538462, 1e-6);

  // 无口令场景：空数组
  const old = core.analyzeScene({ duration: 10, performers: [
    { id: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
    { id: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
  ] });
  assert.deepEqual(old.cueResults, []);
});
