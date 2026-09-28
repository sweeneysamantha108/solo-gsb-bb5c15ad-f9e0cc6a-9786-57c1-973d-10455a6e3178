'use strict';

/**
 * 风险叠加时间轴（buildRiskTimeline）引擎用例：
 *  - 复用碰撞 / 禁入区侵入 / 区域超员三类分析区间，合成按时间排序、
 *    互不重叠的风险段；
 *  - 同刻开始与结束统一结算：不产生零长度风险段、不产生零长度空窗；
 *  - 相切点 / 零长度碰撞区间整体舍弃；
 *  - 生效风险来源变化或涉及人员变化立即分段（来源不变、人员更换也拆段）；
 *  - 段内来源按类型（碰撞→禁入侵入→区域超员）与出现次序排列，
 *    涉及人员按场景内表演者次序去重；
 *  - analyzeScene 的 riskTimeline 装配、空场景与旧调用兼容；
 *  - 内置样例数值与稠密采样逐点一致（实现本身是端点扫描）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;
const EPS = 1e-6;

function approx(actual, expected, tol = 1e-6, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

// 水平横穿者：x=10t、y=50，矩形 [40,60]×[40,60] → 圆心严格在内部 t∈(4,6)
function crosser(id, name, y) {
  return {
    id: id, name: name || id, radius: 0,
    keys: [
      { t: 0, x: 0, y: y == null ? 50 : y },
      { t: T, x: 120, y: y == null ? 50 : y }
    ]
  };
}

// 校验段列表：按起点严格升序、互不重叠（允许同刻首尾相接）、无零长度段
function assertNonOverlapping(segs) {
  for (let i = 0; i < segs.length; i++) {
    assert.ok(segs[i].end - segs[i].start > 1e-7, `第 ${i} 段必须有正持续时间`);
    assert.ok(segs[i].sources.length > 0, `第 ${i} 段至少一个风险来源`);
    if (i > 0) {
      assert.ok(segs[i].start >= segs[i - 1].end - EPS,
        `段必须互不重叠：${segs[i - 1].end} <= ${segs[i].start}`);
    }
  }
}

test('风险时间轴：无任何风险时为空', () => {
  const scene = {
    duration: T,
    performers: [crosser('a', '甲', 0), crosser('b', '乙', 200)],
    obstacles: [{ id: 'o1', name: '区', x: 40, y: 40, width: 20, height: 20 }],
    capacityZones: []
  };
  const a = core.analyzeScene(scene);
  assert.deepEqual(a.riskTimeline, []);
});

test('风险时间轴：单碰撞区间即一段，来源/人员正确', () => {
  const a = { id: 'a', name: '甲', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] };
  const b = { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] };
  const tl = core.buildRiskTimeline(core.analyzeScene({ duration: T, performers: [a, b] }), [a, b], T);
  assert.equal(tl.length, 1);
  approx(tl[0].start, 4, 1e-7);
  approx(tl[0].end, 6, 1e-7);
  assert.equal(tl[0].sources.length, 1);
  assert.equal(tl[0].sources[0].type, 'collision');
  assert.deepEqual(tl[0].members.map((m) => m.id), ['a', 'b'], '人员按场景次序');
});

test('风险时间轴：相切零长度碰撞区间整体舍弃', () => {
  // A 水平经过 y=10，B 静止 (50,0)、r=10 → 仅 t=5 相切（零长度区间）
  const a = { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 0, y: 10 }, { t: 10, x: 100, y: 10 }] };
  const b = { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 50, y: 0 }] };
  const an = core.analyzeScene({ duration: T, performers: [a, b] });
  assert.equal(an.pairs[0].collision, true, '底层仍报告相切碰撞');
  assert.equal(an.pairs[0].intervals.length, 1);
  approx(an.pairs[0].intervals[0][0], an.pairs[0].intervals[0][1], 1e-6);
  assert.deepEqual(an.riskTimeline, [], '零长度段不进入风险时间轴');
});

test('风险时间轴：相邻碰撞首尾相接 → 两段（来源或人员未变，按各自区间成段）', () => {
  // 一对给出 [4,6]，另一对给出 [6,8]：在 t=6 统一结算，前后各成一段且相接不重叠
  // 构造：甲乙 [4,6]（半径 10 相向），甲丙静止贴近在 [6,8]——更直接地用两对解析结果手工组装
  const an = {
    pairs: [
      { collision: true, aId: 'a', bId: 'b', aName: '甲', bName: '乙', intervals: [[4, 6]] },
      { collision: true, aId: 'a', bId: 'c', aName: '甲', bName: '丙', intervals: [[6, 8]] }
    ],
    obstacleConflicts: [],
    capacityResults: []
  };
  const tl = core.buildRiskTimeline(an, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], T);
  assert.equal(tl.length, 2);
  approx(tl[0].start, 4); approx(tl[0].end, 6);
  approx(tl[1].start, 6); approx(tl[1].end, 8);
  assertNonOverlapping(tl);
  assert.deepEqual(tl[0].members.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(tl[1].members.map((m) => m.id), ['a', 'c']);
});

test('风险时间轴：同刻开始与结束统一结算——不产生零长度空窗与零长度风险段', () => {
  // 碰撞 [4,6] 与侵入 [6,8]：t=6 同刻一结束一开始 → 直接相接两段
  const an = {
    pairs: [
      { collision: true, aId: 'a', bId: 'b', aName: '甲', bName: '乙', intervals: [[4, 6]] }
    ],
    obstacleConflicts: [
      { conflict: true, performerId: 'a', performerName: '甲', obstacleId: 'o1', obstacleName: '区',
        intervals: [[6, 8]] }
    ],
    capacityResults: []
  };
  const tl = core.buildRiskTimeline(an, [{ id: 'a' }, { id: 'b' }], T);
  assert.equal(tl.length, 2);
  assertNonOverlapping(tl);
  approx(tl[0].end, 6); approx(tl[1].start, 6);
  assert.equal(tl[0].sources[0].type, 'collision');
  assert.equal(tl[1].sources[0].type, 'obstacle');
});

test('风险时间轴：同刻一进一出互相抵消（人员、来源均复原）不产生瞬时段', () => {
  // 碰撞 [4,8] 持续；禁入来源 A [4,6]、禁入来源 B [6,8]——t=6 仅禁入来源换人，
  // 碰撞来源一直生效，因此 t=6 前后是两段（禁入来源变化）；
  // 再叠加一个恰在 t=6 的零长度侵入（角点相切），不得再插入零长度段
  const an = {
    pairs: [
      { collision: true, aId: 'a', bId: 'b', aName: '甲', bName: '乙', intervals: [[4, 8]] }
    ],
    obstacleConflicts: [
      { conflict: true, performerId: 'a', performerName: '甲', obstacleId: 'o1', obstacleName: '区一',
        intervals: [[4, 6]] },
      { conflict: true, performerId: 'b', performerName: '乙', obstacleId: 'o1', obstacleName: '区一',
        intervals: [[6, 8]] },
      // 零长度角点相切：舍弃
      { conflict: true, performerId: 'a', performerName: '甲', obstacleId: 'o2', obstacleName: '角点',
        intervals: [[6, 6]] }
    ],
    capacityResults: []
  };
  const tl = core.buildRiskTimeline(an, [{ id: 'a' }, { id: 'b' }], T);
  assert.equal(tl.length, 2);
  assertNonOverlapping(tl);
  approx(tl[0].start, 4); approx(tl[0].end, 6);
  approx(tl[1].start, 6); approx(tl[1].end, 8);
  assert.equal(tl[0].sources.length, 2);
  assert.equal(tl[1].sources.length, 2);
  assert.ok(!tl.some((s) => s.sources.some((x) => x.label === '角点')), '零长度来源不得出现');
});

test('风险时间轴：叠加区间合成——重叠期合并为同一段且来源并列', () => {
  // 碰撞 [3,7]；侵入 [5,9]；超员（名单 a,b）[5,7]：
  // [3,5) 碰撞；[5,7] 三者；[7,9) 仅侵入 → 共三段
  const an = {
    pairs: [
      { collision: true, aId: 'a', bId: 'b', aName: '甲', bName: '乙', intervals: [[3, 7]] }
    ],
    obstacleConflicts: [
      { conflict: true, performerId: 'a', performerName: '甲', obstacleId: 'o1', obstacleName: '区',
        intervals: [[5, 9]] }
    ],
    capacityResults: [
      { zoneId: 'z1', zoneName: '限员区', limit: 1, intervals: [
        { start: 5, end: 7, count: 2, members: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] }
      ] }
    ]
  };
  const tl = core.buildRiskTimeline(an, [{ id: 'a' }, { id: 'b' }], T);
  assertNonOverlapping(tl);
  assert.equal(tl.length, 3);
  approx(tl[0].start, 3); approx(tl[0].end, 5);
  approx(tl[1].start, 5); approx(tl[1].end, 7);
  approx(tl[2].start, 7); approx(tl[2].end, 9);
  assert.deepEqual(tl[0].sources.map((s) => s.type), ['collision']);
  assert.deepEqual(tl[1].sources.map((s) => s.type), ['collision', 'obstacle', 'capacity'],
    '段内来源按 碰撞→禁入侵入→区域超员 排列');
  assert.deepEqual(tl[2].sources.map((s) => s.type), ['obstacle']);
  assert.deepEqual(tl[1].members.map((m) => m.id), ['a', 'b']);
});

test('风险时间轴：涉及人员变化立即分段——同限员区同刻换名单', () => {
  // 限员区上限 1：[4,6] 超员名单 {甲}（甲在乙走），[6,8] 超员名单 {乙}（乙在甲走，
  // 同刻一进一出底层不产生超员，故这里构造两个分离状态 [4,6]、[8,10]；
  // 再单独验证 [4,6]{甲,乙}→[6,8]{甲,丙} 的名单变化分段）。
  const an = {
    pairs: [],
    obstacleConflicts: [],
    capacityResults: [
      { zoneId: 'z1', zoneName: '区', limit: 1, intervals: [
        { start: 4, end: 6, count: 2, members: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] },
        { start: 6, end: 8, count: 2, members: [{ id: 'a', name: '甲' }, { id: 'c', name: '丙' }] }
      ] }
    ]
  };
  const tl = core.buildRiskTimeline(an, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], T);
  assertNonOverlapping(tl);
  assert.equal(tl.length, 2);
  approx(tl[0].start, 4); approx(tl[0].end, 6);
  approx(tl[1].start, 6); approx(tl[1].end, 8);
  assert.deepEqual(tl[0].members.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(tl[1].members.map((m) => m.id), ['a', 'c']);
  // 来源都是同一限员区的超员（但已是两个名单状态）
  assert.equal(tl[0].sources.length, 1);
  assert.equal(tl[1].sources.length, 1);
  assert.equal(tl[0].sources[0].label, tl[1].sources[0].label);
});

test('风险时间轴：涉及人员并集跨来源去重、按场景次序', () => {
  // 碰撞 a×c，侵入 b：并集为 a,b,c（场景次序），碰撞来源自身人员 a,c
  const an = {
    pairs: [
      { collision: true, aId: 'c', bId: 'a', aName: '丙', bName: '甲', intervals: [[2, 5]] }
    ],
    obstacleConflicts: [
      { conflict: true, performerId: 'b', performerName: '乙', obstacleId: 'o', obstacleName: '区',
        intervals: [[2, 5]] }
    ],
    capacityResults: []
  };
  const tl = core.buildRiskTimeline(an, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], T);
  assert.equal(tl.length, 1);
  assert.deepEqual(tl[0].members.map((m) => m.id), ['a', 'b', 'c'], '并集按场景次序去重');
  assert.deepEqual(tl[0].sources[0].members.map((m) => m.id), ['a', 'c'],
    '来源内人员同样重排为场景次序');
});

test('风险时间轴：t=0 开始与 T 结束的风险段正确成段', () => {
  const an = {
    pairs: [
      { collision: true, aId: 'a', bId: 'b', aName: '甲', bName: '乙', intervals: [[0, T]] }
    ],
    obstacleConflicts: [],
    capacityResults: []
  };
  const tl = core.buildRiskTimeline(an, [{ id: 'a' }, { id: 'b' }], T);
  assert.equal(tl.length, 1);
  approx(tl[0].start, 0);
  approx(tl[0].end, T);
});

test('风险时间轴：buildRiskTimeline 独立调用缺省参数兼容', () => {
  const tl = core.buildRiskTimeline({ pairs: [], obstacleConflicts: [], capacityResults: [] }, null, T);
  assert.deepEqual(tl, []);
  assert.throws(() => core.buildRiskTimeline({}, [], 0), /duration/);
});

test('风险时间轴：内置样例段互不重叠且端点与三类区间一致', () => {
  const an = core.analyzeScene(core.builtinScene());
  assert.ok(an.riskTimeline.length >= 3, '样例应合成多段风险');
  assertNonOverlapping(an.riskTimeline);

  // 收集三类底层区间端点；每个风险段边界必须能在底层端点中找到
  const endpoints = new Set();
  an.pairs.forEach((p) => p.intervals.forEach((iv) => { endpoints.add(iv[0]); endpoints.add(iv[1]); }));
  an.obstacleConflicts.forEach((e) => e.intervals.forEach((iv) => { endpoints.add(iv[0]); endpoints.add(iv[1]); }));
  an.capacityResults.forEach((r) => r.intervals.forEach((iv) => { endpoints.add(iv.start); endpoints.add(iv.end); }));
  an.riskTimeline.forEach((s) => {
    assert.ok([...endpoints].some((t) => Math.abs(t - s.start) < 1e-5), `起点 ${s.start} 应为底层端点`);
    assert.ok([...endpoints].some((t) => Math.abs(t - s.end) < 1e-5) || Math.abs(s.end - an.duration) < 1e-5,
      `终点 ${s.end} 应为底层端点或时长末端`);
  });

  // 样例中央限员区唯一超员状态约 [5.18,6.82]（与甲乙碰撞重叠处会被进一步分段，
  // 但含 capacity 来源的首段起点 ≈5.18、末段终点 ≈6.82）
  const capSegs = an.riskTimeline.filter((s) => s.sources.some((x) => x.type === 'capacity'));
  assert.ok(capSegs.length >= 1, '样例应出现区域超员风险段');
  approx(capSegs[0].start, 5.18, 0.02);
  approx(capSegs[capSegs.length - 1].end, 6.82, 0.02);
});

test('风险时间轴：稠密采样——每段恰好等于"生效来源集合 + 涉及人员"恒定的区间', () => {
  // 用真实 analyzeScene 的三类结果交叉验证：扫描线结果 vs 逐点来源签名
  const zone = { id: 'z1', name: '限员区', x: 40, y: 40, width: 20, height: 20, limit: 1 };
  const scene = {
    duration: T,
    performers: [
      crosser('a', '甲', 50),     // 区内 t∈(4,6)
      crosser('b', '乙', 50),     // 区内 t∈(4,6) → 超员
      { id: 'c', name: '丙', radius: 8, keys: [ // 与甲在 t≈5 附近碰撞
        { t: 0, x: 60, y: 0 }, { t: 10, x: 40, y: 100 }
      ] }
    ],
    obstacles: [{ id: 'o1', name: '禁入区', x: 46, y: 46, width: 8, height: 8 }],
    capacityZones: [zone]
  };
  const an = core.analyzeScene(scene);
  assertNonOverlapping(an.riskTimeline);

  function pointSig(t) {
    const keys = [];
    const members = new Set();
    an.pairs.forEach((p) => {
      if (p.collision && p.intervals.some((iv) => t > iv[0] + EPS && t < iv[1] - EPS)) {
        keys.push('collision ' + [p.aId, p.bId].sort().join('|'));
        members.add(p.aId); members.add(p.bId);
      }
    });
    an.obstacleConflicts.forEach((e) => {
      if (e.conflict && e.intervals.some((iv) => t > iv[0] + EPS && t < iv[1] - EPS)) {
        keys.push('obstacle ' + e.performerId + '|' + e.obstacleId);
        members.add(e.performerId);
      }
    });
    an.capacityResults.forEach((r) => {
      r.intervals.forEach((iv, idx) => {
        if (t > iv.start + EPS && t < iv.end - EPS) {
          keys.push('capacity ' + r.zoneId + '|' + idx);
          iv.members.forEach((m) => members.add(m.id));
        }
      });
    });
    keys.sort();
    return { sig: keys.join(';'), members: [...members].sort().join('|'), empty: keys.length === 0 };
  }

  // 用"来源数量 + 人员签名"对照扫描线段落
  function pointCounts(t) {
    const p = pointSig(t);
    return { count: p.sig ? p.sig.split(';').length : 0, members: p.members };
  }

  const samples = 1000;
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * T;
    const activeSeg = an.riskTimeline.find((s) => t > s.start + EPS && t < s.end - EPS);
    const pc = pointCounts(t);
    if (activeSeg) {
      assert.equal(pc.count, activeSeg.sources.length,
        `t=${t.toFixed(3)} 来源数量：点 ${pc.count}，段 ${activeSeg.sources.length}`);
      assert.equal(pc.members, activeSeg.members.map((m) => m.id).sort().join('|'),
        `t=${t.toFixed(3)} 涉及人员一致`);
      assert.ok(pc.count > 0);
    } else if (![...an.riskTimeline].some((s) => Math.abs(t - s.start) < 2e-3 || Math.abs(t - s.end) < 2e-3)) {
      // 不在任何段端点邻域内：必须无风险
      assert.equal(pc.count, 0, `t=${t.toFixed(3)} 落在段外却有生效风险`);
    }
  }
});
