'use strict';

/**
 * 风险叠加时间轴（risk timeline）引擎用例：
 *  - 复用碰撞 / 禁入区侵入 / 区域超员三类分析区间；
 *  - 合成为按时间排序、互不重叠、正持续的风险段；
 *  - 同刻开始与结束统一结算（不产生瞬时段）；
 *  - 舍弃零长度段（相切点 / 开场收场单点）；
 *  - 生效风险来源或涉及人员变化即分段（来源同刻交换、人员名单变化）；
 *  - analyzeScene 装配 riskTimeline 及旧场景兼容；
 *  - 内置样例分段结构；
 *  - 与稠密采样在随机场景上逐刻核对（段覆盖性、来源集合、人员并集）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;
const RECT = { id: 'q', name: '中央区', x: 40, y: 40, width: 20, height: 20 };

function approx(actual, expected, tol = 1e-7, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

function typeCounts(seg) {
  const m = {};
  seg.sources.forEach((s) => { m[s.type] = (m[s.type] || 0) + 1; });
  return m;
}

test('风险轴：单碰撞区间合成单段，人员为碰撞双方', () => {
  // 两人水平对穿：甲 x=10t、乙 x=120−10t；半径 10 → 距离≤20 即 t∈[5,7]
  const ps = [
    { id: 'a', name: '甲', radius: 10, keys: [{ t: 0, x: 0, y: 50 }, { t: T, x: 120, y: 50 }] },
    { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 120, y: 50 }, { t: T, x: 0, y: 50 }] }
  ];
  const r = core.analyzeScene({ duration: T, performers: ps });
  assert.equal(r.riskTimeline.length, 1);
  const seg = r.riskTimeline[0];
  approx(seg.start, 5, 1e-9);
  approx(seg.end, 7, 1e-9);
  assert.equal(seg.sources.length, 1);
  assert.equal(seg.sources[0].type, 'collision');
  assert.deepEqual(seg.memberIds, ['a', 'b']);
});

test('风险轴：碰撞/侵入/超员同刻开始统一结算为同一三来源段', () => {
  // 甲静止在矩形中心 (50,50) 半径 0：圆心全程严格在矩形内 →
  //   侵入（半径 0 即圆心进入）[0,12]，超员名单恒含甲；
  // 乙 x=10t、y=50、半径 10：圆心严格在内 (4,6)，
  //   圆与膨胀边界相交 [3,7]，与甲距离 |10t−50|≤10 → 碰撞 [4,6]；
  // 上限 1：两人同时在内的 (4,6) 即超员段。
  // 故 [4,6] 同刻开始/结束地同时含 碰撞+侵入×2+超员（3 类来源）。
  const ps = [
    { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] },
    { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 0, y: 50 }, { t: T, x: 120, y: 50 }] }
  ];
  const r = core.analyzeScene({
    duration: T,
    performers: ps,
    obstacles: [RECT],
    capacityZones: [Object.assign({ limit: 1 }, RECT)]
  });
  const tl = r.riskTimeline;

  // 结构性质：互不重叠、正持续、按开始升序
  for (let i = 0; i < tl.length; i++) {
    assert.ok(tl[i].end > tl[i].start, '所有段正持续');
    if (i > 0) {
      assert.ok(tl[i].start >= tl[i - 1].end - 1e-9, '段互不重叠');
      assert.ok(tl[i].start >= tl[i - 1].start - 1e-9, '按开始升序');
    }
  }

  // 期望五段：[0,3) 甲侵入；[3,4) 两人侵入；[4,6] 碰撞+两侵入+超员；
  //          [6,7) 两人侵入；[7,12] 甲侵入
  approx(tl[0].start, 0, 1e-9);
  const boundStarts = tl.map((s) => +s.start.toFixed(6));
  [0, 3, 4, 6, 7].forEach((bt) => {
    assert.ok(boundStarts.some((x) => Math.abs(x - bt) < 1e-6), '存在自 ' + bt + ' 开始的段');
  });

  const mid = tl.find((s) => Math.abs(s.start - 4) < 1e-6 && Math.abs(s.end - 6) < 1e-6);
  assert.ok(mid, '存在 [4,6] 三来源段');
  const counts = typeCounts(mid);
  assert.equal(counts.collision, 1);
  assert.equal(counts.obstacle, 2);
  assert.equal(counts.capacity, 1);
  assert.deepEqual(mid.memberIds, ['a', 'b']);
});

test('风险轴：同刻一始一终统一结算，不产生瞬时段（来源同刻交接）', () => {
  // 甲 x=10t、乙静止 x=80，半径均 10；禁入矩形 [80,130]×[40,60]：
  //  - 碰撞：|10t−80|≤20 → [6,10]；
  //  - 乙（圆心在边界 80 上）半径盘与矩形相交：全程 [0,12]；
  //  - 甲圆心进入 80 于 t=8（边界，开区间不计），圆与膨胀边界相交
  //    自 x=70（t=7）起：侵入 [7,12]。
  // 关键：t=10 处碰撞结束（乙仍侵入），来源集合变化即分段；
  // t=6 碰撞开始与既有侵入并存——全程不存在零长度段。
  const ps = [
    { id: 'a', name: '甲', radius: 10, keys: [{ t: 0, x: 0, y: 50 }, { t: T, x: 120, y: 50 }] },
    { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 80, y: 50 }] }
  ];
  const r = core.analyzeScene({
    duration: T,
    performers: ps,
    obstacles: [{ id: 'o', name: '右侧禁入区', x: 80, y: 40, width: 50, height: 20 }]
  });
  const tl = r.riskTimeline;
  tl.forEach((s) => assert.ok(s.end - s.start > 1e-7, '无零长度段'));

  // 段边界恰为 0 / 6 / 7 / 10（10 处碰撞终、侵入仍在：立即分段，无瞬时缝）
  const boundStarts = tl.map((s) => +s.start.toFixed(6));
  [0, 6, 7, 10].forEach((bt) => {
    assert.ok(boundStarts.some((x) => Math.abs(x - bt) < 1e-6), '来源变化点 ' + bt + ' 处分段');
  });
  // t=10 的段：仅侵入（碰撞已同刻结束），人员仍含两人
  const after10 = tl.find((s) => Math.abs(s.start - 10) < 1e-6);
  assert.ok(after10, '存在自 10 开始的段');
  assert.ok(!after10.sources.some((src) => src.type === 'collision'), 't=10 碰撞已结束');
  assert.ok(after10.sources.some((src) => src.type === 'obstacle'), '侵入仍生效');
  assert.deepEqual(after10.memberIds, ['a', 'b']);
});

test('风险轴：相切零长度碰撞 / 角点侵入不计入风险轴', () => {
  // 两人半径 0 对穿于 t=6 在 (60,50) 相遇：距离恰 0 → 零长度"碰撞"点
  const ps = [
    { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: T, x: 120, y: 50 }] },
    { id: 'b', name: '乙', radius: 0, keys: [{ t: 0, x: 120, y: 50 }, { t: T, x: 0, y: 50 }] }
  ];
  const pair = core.analyzePair(ps[0], ps[1], T);
  assert.ok(pair.collision, '引擎仍记录零长度相切区间');
  assert.equal(pair.intervals.length, 1);
  approx(pair.intervals[0][0], pair.intervals[0][1], 1e-9, '相切为零长度点');
  const r1 = core.analyzeScene({ duration: T, performers: ps });
  assert.deepEqual(r1.riskTimeline, [], '零长度相切不出现在风险轴');

  // 禁入矩形角点相切：半径 0 轨迹 y=80−x 擦过角点 (40,40) 于 t=4，不进入
  const scene2 = {
    duration: 10,
    performers: [
      { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'c', name: '丙', radius: 0, keys: [{ t: 0, x: 30, y: 50 }, { t: 10, x: 50, y: 30 }] }
    ],
    obstacles: [{ id: 'o', name: '禁入区', x: 40, y: 40, width: 20, height: 20 }]
  };
  const r2 = core.analyzeScene(scene2);
  const positive = r2.obstacleConflicts
    .filter((e) => e.conflict)
    .filter((e) => e.intervals.some((iv) => iv[1] - iv[0] > 1e-7));
  assert.deepEqual(positive, [], '角点相切只有零长度点');
  assert.deepEqual(r2.riskTimeline, [], '风险轴不含角点相切');
});

test('风险轴：生效人员变化即分段（同刻换人、人数不变也拆段）', () => {
  // 限员区上限 2（不超员）：甲圆心停留 (0,5)、乙停留 (5,10)，同刻一进
  // 一出。另取一个与限员区同框的禁入矩形但半径 0，侵入等价于圆心严格
  // 在内：甲侵入 (0,5)、乙侵入 (5,10)。同刻交换、生效人员变化 →
  // 两段正持续风险段（而非一段或零长度段）。
  const ps = [
    { id: 'a', name: '甲', radius: 0, keys: [
      { t: 0, x: 50, y: 50 }, { t: 5, x: 40, y: 50 }, { t: T, x: 0, y: 50 }
    ] },
    { id: 'b', name: '乙', radius: 0, keys: [
      { t: 0, x: 0, y: 50 }, { t: 5, x: 40, y: 50 }, { t: T, x: 68, y: 50 }
    ] }
  ];
  const r = core.analyzeScene({
    duration: T, performers: ps,
    obstacles: [RECT],
    capacityZones: [Object.assign({ limit: 2 }, RECT)]
  });
  const tl = r.riskTimeline;
  assert.equal(tl.length, 2, '同刻换人分为两段（均仅侵入，不超员）');
  approx(tl[0].start, 0, 1e-9);
  approx(tl[0].end, 5, 1e-9);
  approx(tl[1].start, 5, 1e-9);
  approx(tl[1].end, 10, 1e-9);
  assert.deepEqual(tl[0].memberIds, ['a']);
  assert.deepEqual(tl[1].memberIds, ['b']);
  assert.ok(tl.every((s) => s.sources.every((src) => src.type === 'obstacle')),
    '上限 2 时两人轮换不构成超员');
});

test('风险轴：段内来源按 碰撞→侵入→超员 稳定排序，人员按场景次序去重', () => {
  const r = core.analyzeScene(core.builtinScene());
  const seg = r.riskTimeline.find((s) => {
    const c = typeCounts(s);
    return c.collision >= 1 && c.obstacle >= 1 && c.capacity >= 1;
  });
  assert.ok(seg, '内置样例存在三来源叠加段');
  const order = seg.sources.map((s) => s.type);
  const rank = { collision: 0, obstacle: 1, capacity: 2 };
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank[order[i - 1]] <= rank[order[i]], '段内来源按类型排序');
  }
  const ids = seg.memberIds;
  assert.deepEqual(ids, Array.from(new Set(ids)), '人员去重');
  const sorted = ids.slice().sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
  assert.deepEqual(ids, sorted, '按场景内表演者次序');
});

test('风险轴：analyzeScene 装配字段；无任何风险时为空数组', () => {
  const r = core.analyzeScene(core.builtinScene());
  assert.ok(Array.isArray(r.riskTimeline));
  r.riskTimeline.forEach((s) => {
    assert.ok(isFinite(s.start) && isFinite(s.end));
    assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
    assert.ok(Array.isArray(s.memberIds) && Array.isArray(s.members));
    assert.equal(s.memberIds.length, s.members.length);
  });

  // 两人全程静止且相距很远、无矩形：无风险
  const safe = core.analyzeScene({
    duration: T,
    performers: [
      { id: 'a', name: '甲', radius: 5, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', name: '乙', radius: 5, keys: [{ t: 0, x: 500, y: 500 }] }
    ]
  });
  assert.deepEqual(safe.riskTimeline, []);

  // 旧场景（无 obstacles / capacityZones）也带字段
  const old = core.analyzeScene({
    duration: T,
    performers: core.builtinScene().performers
  });
  assert.ok(Array.isArray(old.riskTimeline));
});

test('内置样例：风险段覆盖既有碰撞/侵入/超员区间，边界数值与分段数正确', () => {
  const r = core.analyzeScene(core.builtinScene());
  const tl = r.riskTimeline;

  // 丙×丁碰撞自 ≈2.6036 起；乙侵入 ≈4.1538；甲侵入 ≈4.9091；
  // 超员 ≈[5.1818,6.8182]；甲乙碰撞 ≈[5.5304,6.4696]；甲侵入止 ≈7.0909；
  // 乙侵入止 ≈7.8462；丙丁碰撞止 12 → 共 9 段
  assert.equal(tl.length, 9);
  approx(tl[0].start, 2.6036, 1e-3, '首段自丙丁碰撞');
  approx(tl[tl.length - 1].end, 12, 1e-9, '末段止于时长');

  // 所有正长度源区间的中点都必须被含该类型来源的风险段覆盖
  function covered(type, start, end) {
    const mid = (start + end) / 2;
    const seg = tl.find((s) => mid > s.start + 1e-6 && mid < s.end - 1e-6);
    assert.ok(seg, type + ' [' + start + ',' + end + '] 中点未被任何风险段覆盖');
    assert.ok(seg.sources.some((src) => src.type === type), type + ' 段缺少该类型来源');
  }
  r.pairs.filter((p) => p.collision).forEach((p) => {
    p.intervals.forEach((iv) => {
      if (iv[1] - iv[0] > 1e-7) covered('collision', iv[0], iv[1]);
    });
  });
  r.obstacleConflicts.filter((e) => e.conflict).forEach((e) => {
    e.intervals.forEach((iv) => {
      if (iv[1] - iv[0] > 1e-7) covered('obstacle', iv[0], iv[1]);
    });
  });
  r.capacityResults.forEach((z) => {
    z.intervals.forEach((iv) => covered('capacity', iv.start, iv.end));
  });

  // 反方向：每个风险段中点必须真有至少一个生效来源（与原分析一致）
  tl.forEach((seg) => {
    const t = (seg.start + seg.end) / 2;
    let active = false;
    r.pairs.forEach((pair) => {
      if (pair.intervals.some((iv) => iv[1] - iv[0] > 1e-7 &&
        t > iv[0] + 1e-6 && t < iv[1] - 1e-6)) active = true;
    });
    r.obstacleConflicts.forEach((e) => {
      if (e.intervals.some((iv) => iv[1] - iv[0] > 1e-7 &&
        t > iv[0] + 1e-6 && t < iv[1] - 1e-6)) active = true;
    });
    r.capacityResults.forEach((z) => { if (core.isCapacityOverAt(z, t)) active = true; });
    assert.ok(active, '段 ' + seg.start + ' 中点应有生效风险来源');
  });
});

test('风险轴：随机场景下与逐刻真值核对（覆盖、类型来源、人员并集）', () => {
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260928);
  function rc() { return Math.round(rnd() * 120) - 10; }
  const B_EPS = 2e-6;

  for (let trial = 0; trial < 40; trial++) {
    const n = 2 + Math.floor(rnd() * 3);
    const performers = [];
    for (let pi = 0; pi < n; pi++) {
      const nk = 1 + Math.floor(rnd() * 3);
      const keys = [];
      for (let i = 0; i <= nk; i++) {
        keys.push({ t: Math.round((T * i) / nk * 10) / 10, x: rc() + 40, y: rc() + 40 });
      }
      performers.push({ id: 'p' + pi, name: 'P' + pi, radius: rnd() * 25, keys });
    }
    const obstacles = [];
    const capacityZones = [];
    for (let k = 0; k < 2; k++) {
      const rect = {
        name: 'R' + k,
        x: rc() + 20, y: rc() + 20,
        width: 10 + rnd() * 90, height: 10 + rnd() * 90
      };
      obstacles.push(Object.assign({ id: 'ob' + k }, rect));
      capacityZones.push(Object.assign({ id: 'z' + k, limit: 1 + Math.floor(rnd() * 2) }, rect));
    }
    const r = core.analyzeScene({ duration: T, performers, obstacles, capacityZones });
    const tl = r.riskTimeline;

    for (let i = 0; i < tl.length; i++) {
      assert.ok(tl[i].end - tl[i].start > 1e-7, 'trial' + trial + ' 正持续');
      if (i > 0) assert.ok(tl[i].start >= tl[i - 1].end - B_EPS, 'trial' + trial + ' 不重叠');
    }

    // 真值：只统计正长度区间（零长度相切不算），与风险轴口径一致
    function truthAt(t) {
      const flags = { collision: false, obstacle: false, capacity: false };
      const members = {};
      r.pairs.forEach((pair) => {
        const hit = pair.intervals.some((iv) => iv[1] - iv[0] > 1e-7 &&
          t > iv[0] + B_EPS && t < iv[1] - B_EPS);
        if (hit) {
          flags.collision = true;
          members[pair.aId] = true;
          members[pair.bId] = true;
        }
      });
      r.obstacleConflicts.forEach((e) => {
        const hit = e.intervals.some((iv) => iv[1] - iv[0] > 1e-7 &&
          t > iv[0] + B_EPS && t < iv[1] - B_EPS);
        if (hit) {
          flags.obstacle = true;
          members[e.performerId] = true;
        }
      });
      r.capacityResults.forEach((z) => {
        if (core.isCapacityOverAt(z, t)) {
          flags.capacity = true;
          z.intervals.forEach((iv) => {
            if (t > iv.start - B_EPS && t < iv.end + B_EPS) {
              iv.members.forEach((m) => { members[m.id] = true; });
            }
          });
        }
      });
      return { flags: flags, members: Object.keys(members).sort() };
    }

    for (let i = 0; i <= 4000; i++) {
      const t = (T * i) / 4000;
      const atEnd = tl.some((s) => Math.abs(t - s.start) <= B_EPS || Math.abs(t - s.end) <= B_EPS);
      if (atEnd) continue; // 端点开区间口径，跳过零测时刻
      const seg = tl.find((s) => t > s.start - B_EPS && t < s.end + B_EPS);
      const truth = truthAt(t);
      const any = truth.flags.collision || truth.flags.obstacle || truth.flags.capacity;
      if (any) {
        assert.ok(seg, `trial${trial} t=${t} 有风险但无段覆盖`);
        ['collision', 'obstacle', 'capacity'].forEach((tp) => {
          assert.equal(seg.sources.some((src) => src.type === tp), truth.flags[tp],
            `trial${trial} t=${t} 类型 ${tp} 不一致`);
        });
        assert.deepEqual(seg.memberIds.slice().sort(), truth.members,
          `trial${trial} t=${t} 涉及人员不一致`);
      } else {
        assert.equal(seg, undefined, `trial${trial} t=${t} 无风险却落在风险段内`);
      }
    }
  }
});
