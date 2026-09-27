'use strict';

/**
 * HTTP 接口测试：/api/analyze 接受含关键帧半径 r 的场景并返回规整后的场景；
 * /api/sample 返回的样例携带关键帧半径。使用 server 导出的 express app，零额外依赖。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server/index.js');

const server = app.listen(0);
after(() => server.close());
const PORT = server.address().port;

function postAnalyze(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/analyze',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    }).on('error', reject);
  });
}

const baseScene = (aKeys) => ({
  duration: 10,
  performers: [
    {
      id: 'a', name: '甲', radius: 10,
      keys: aKeys || [{ t: 0, x: 70, y: 0, r: 10 }, { t: 4, x: 70, y: 0, r: 50 }]
    },
    {
      id: 'b', name: '乙', radius: 10,
      keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }]
    }
  ]
});

test('POST /api/analyze：接受关键帧 r 并按可变半径解析（首碰 t=2.5）', async () => {
  const r = await postAnalyze(baseScene());
  assert.equal(r.status, 200);
  assert.equal(r.json.pairCount, 1);
  const pair = r.json.pairs[0];
  assert.equal(pair.collision, true);
  assert.ok(Math.abs(pair.firstContact - 2.5) < 1e-6);
  assert.ok(Math.abs(pair.radiusSumMin - 20) < 1e-9);
  assert.ok(Math.abs(pair.radiusSumMax - 60) < 1e-9);
});

test('POST /api/analyze：返回最小安全余量 minMargin/minMarginT，pairs 按余量升序', async () => {
  const r = await postAnalyze(baseScene());
  assert.equal(r.status, 200);
  const pair = r.json.pairs[0];
  // 甲静止 x=70（r 10→50），乙 r=10 从 0→100：
  // t=7 时距离为 0、半径和恒 60 → 最小安全余量 = −60 @ t=7
  assert.ok(Math.abs(pair.minMargin - (-60)) < 1e-6, `minMargin 应为 -60，实际 ${pair.minMargin}`);
  assert.ok(Math.abs(pair.minMarginT - 7) < 1e-6, `minMarginT 应为 7，实际 ${pair.minMarginT}`);
  // 场景级字段与首对一致
  assert.ok(Math.abs(r.json.minMargin - pair.minMargin) < 1e-12);
  assert.ok(Math.abs(r.json.minMarginT - pair.minMarginT) < 1e-12);
  assert.deepEqual(r.json.minMarginPair, [pair.aId, pair.bId]);
  // 升序
  for (let i = 1; i < r.json.pairs.length; i++) {
    assert.ok(r.json.pairs[i].minMargin >= r.json.pairs[i - 1].minMargin);
  }
});

test('POST /api/analyze：多对场景 pairs 严格按最小安全余量升序', async () => {
  const s = await getJson('/api/sample');
  const r = await postAnalyze({ duration: s.json.duration, performers: s.json.performers });
  assert.equal(r.status, 200);
  assert.equal(r.json.pairCount, 6);
  r.json.pairs.forEach((p) => {
    assert.ok(typeof p.minMargin === 'number' && isFinite(p.minMargin), '每对都带有限 minMargin');
    assert.ok(typeof p.minMarginT === 'number' && isFinite(p.minMarginT), '每对都带有限 minMarginT');
    assert.equal(p.collision, p.minMargin <= 1e-9, '余量 ≤ 0 ⟺ 碰撞');
  });
  for (let i = 1; i < r.json.pairs.length; i++) {
    assert.ok(
      r.json.pairs[i].minMargin >= r.json.pairs[i - 1].minMargin - 1e-12,
      'pairs 按余量升序'
    );
  }
  assert.ok(Math.abs(r.json.minMargin - r.json.pairs[0].minMargin) < 1e-12);
});

test('POST /api/analyze：返回的 scene 中缺省 r 被解析为继承值，显式 r 原样保留', async () => {
  const r = await postAnalyze(baseScene());
  assert.equal(r.status, 200);
  assert.ok(r.json.scene, '响应包含规整后的 scene');
  const [a, b] = r.json.scene.performers;
  assert.equal(a.keys[0].r, 10);
  assert.equal(a.keys[1].r, 50);
  // 乙的关键帧未设置 r -> 全部解析为其当前半径 10
  assert.deepEqual(b.keys.map((k) => k.r), [10, 10]);
});

test('POST /api/analyze：固定半径旧数据（无 r 字段）继续兼容', async () => {
  const old = {
    duration: 10,
    performers: [
      { name: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { name: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  };
  const r = await postAnalyze(old);
  assert.equal(r.status, 200);
  const pair = r.json.pairs[0];
  assert.ok(Math.abs(pair.intervals[0][0] - 4) < 1e-7);
  assert.ok(Math.abs(pair.intervals[0][1] - 6) < 1e-7);
});

test('POST /api/analyze：非法关键帧半径被拒绝', async () => {
  const bad = baseScene([{ t: 0, x: 70, y: 0, r: -5 }]);
  const r = await postAnalyze(bad);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /安全半径/);
});

test('GET /api/sample：样例含关键帧半径且可直接回传分析', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  const p3 = s.json.performers.find((p) => p.id === 'p3');
  assert.equal(p3.keys[2].r, 60);
  const r = await postAnalyze({ duration: s.json.duration, performers: s.json.performers });
  assert.equal(r.status, 200);
  assert.equal(r.json.pairCount, 6);
});

test('GET /healthz 正常', async () => {
  const r = await getJson('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

// ---------- 舞台禁入矩形 ----------

test('POST /api/analyze：接受 obstacles 并返回规整后的 obstacles 与 obstacleConflicts', async () => {
  const body = {
    duration: 10,
    obstacles: [
      { name: '高台', x: 40, y: 40, width: 20, height: 20 },
      { id: 'z9', x: 0, y: 0, width: 30, height: 30 }
    ],
    performers: [
      { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
      { id: 'b', name: '乙', radius: 0, keys: [{ t: 0, x: 0, y: 200 }, { t: 10, x: 100, y: 200 }] }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  // 顶层与 scene 内均带规整后的 obstacles
  assert.ok(Array.isArray(r.json.obstacles));
  assert.equal(r.json.obstacles.length, 2);
  assert.deepEqual(r.json.scene.obstacles, r.json.obstacles);
  assert.ok(r.json.obstacles[0].id, '缺省 id 自动补全');
  assert.equal(r.json.obstacles[0].name, '高台');
  assert.equal(r.json.obstacles[1].id, 'z9', '显式 id 保留');
  assert.equal(r.json.obstacles[1].name, '禁入区 2', '缺省 name 补序号');

  // 每人 × 每矩形 = 4 条；甲横穿矩形 1（t∈[4,6]），其余安全
  assert.equal(r.json.obstacleConflicts.length, 4);
  const hit = r.json.obstacleConflicts.find(
    (e) => e.performerId === 'a' && e.obstacleId === r.json.obstacles[0].id);
  assert.equal(hit.conflict, true);
  assert.ok(Math.abs(hit.intervals[0][0] - 4) < 1e-9);
  assert.ok(Math.abs(hit.intervals[0][1] - 6) < 1e-9);
  assert.ok(Math.abs(hit.firstEntry - 4) < 1e-9);
  const safeOnes = r.json.obstacleConflicts.filter((e) => !e.conflict);
  assert.equal(safeOnes.length, 3);
  // 冲突项排在前且按首入升序
  assert.equal(r.json.obstacleConflicts[0].conflict, true);
  assert.ok(Math.abs(r.json.firstObstacleEntry - 4) < 1e-9);
  assert.deepEqual(r.json.firstObstacleConflict, ['a', r.json.obstacles[0].id]);
});

test('POST /api/analyze：无 obstacles 的旧请求保持兼容（空数组与 null 场景字段）', async () => {
  const r = await postAnalyze({
    duration: 10,
    performers: [
      { name: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { name: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.obstacles, []);
  assert.deepEqual(r.json.obstacleConflicts, []);
  assert.equal(r.json.firstObstacleEntry, null);
  assert.equal(r.json.firstObstacleConflict, null);
  assert.deepEqual(r.json.scene.obstacles, []);
});

test('POST /api/analyze：非法 obstacles（尺寸/字段）返回 400', async () => {
  const base = {
    duration: 10,
    performers: [
      { name: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { name: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  };
  const badWidth = Object.assign({ obstacles: [{ x: 0, y: 0, width: -1, height: 10 }] }, base);
  let r = await postAnalyze(badWidth);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /禁入矩形/);

  const badCoord = Object.assign({ obstacles: [{ x: 'nope', y: 0, width: 1, height: 1 }] }, base);
  r = await postAnalyze(badCoord);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /禁入矩形/);

  const notArray = Object.assign({ obstacles: {} }, base);
  r = await postAnalyze(notArray);
  assert.equal(r.status, 400);
});

test('GET /api/sample：样例携带中央禁入矩形，回传分析得甲、乙侵入', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.obstacles) && s.json.obstacles.length === 1);
  const ob = s.json.obstacles[0];
  ['id', 'name', 'x', 'y', 'width', 'height'].forEach((f) => assert.ok(ob[f] !== undefined));
  const r = await postAnalyze({
    duration: s.json.duration,
    performers: s.json.performers,
    obstacles: s.json.obstacles
  });
  assert.equal(r.status, 200);
  const who = r.json.obstacleConflicts
    .filter((e) => e.conflict)
    .map((e) => e.performerId)
    .sort();
  assert.deepEqual(who, ['p1', 'p2'], '仅横穿者甲、乙侵入中央禁入区');
});

// ---------- 入场口令 cues ----------

test('POST /api/analyze：接受 cues 并返回 cueResults（触发/错过/前序未完成）', async () => {
  const body = {
    duration: 10,
    performers: [
      {
        id: 'a', name: '甲', radius: 5,
        keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }],
        cues: [
          { x: 40, y: 40, width: 20, height: 20, winStart: 4, winEnd: 6 },
          { x: 40, y: 40, width: 20, height: 20, winStart: 6, winEnd: 8 },
          { x: 40, y: 40, width: 20, height: 20, winStart: 8, winEnd: 10 }
        ]
      },
      { id: 'b', name: '乙', radius: 1, keys: [{ t: 0, x: 200, y: 0 }] }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.cueResults));
  assert.equal(r.json.cueResults.length, 1, '无口令者不出现在 cueResults');
  const cr = r.json.cueResults[0];
  assert.equal(cr.performerId, 'a');
  assert.deepEqual(cr.results.map((x) => x.status), ['triggered', 'missed', 'blocked']);
  // 圆心 x=40 -> t=4，窗 [4,6] 含端点，触发
  assert.ok(Math.abs(cr.results[0].triggerT - 4) < 1e-9);
  assert.ok(Array.isArray(cr.results[0].entries));
  assert.ok(Math.abs(cr.results[0].entries[0] - 4) < 1e-9);

  // 规整后的 scene 中口令保留（时窗、id 补全）
  const a = r.json.scene.performers[0];
  assert.equal(a.cues.length, 3);
  a.cues.forEach((c) => {
    ['id', 'x', 'y', 'width', 'height', 'winStart', 'winEnd'].forEach((f) => assert.ok(c[f] !== undefined));
  });
  assert.deepEqual(r.json.scene.performers[1].cues, []);
});

test('POST /api/analyze：cues 缺省时窗补 [0,duration]、非法字段返回 400', async () => {
  const ok = await postAnalyze({
    duration: 10,
    performers: [
      { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }],
        cues: [{ x: 40, y: 40, width: 20, height: 20 }] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 0, y: 0 }] }
    ]
  });
  assert.equal(ok.status, 200);
  const c = ok.json.scene.performers[0].cues[0];
  assert.equal(c.winStart, 0);
  assert.equal(c.winEnd, 10);

  const base = {
    duration: 10,
    performers: [
      { id: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  };
  const badField = JSON.parse(JSON.stringify(base));
  badField.performers[0].cues = [{ x: 'nope', y: 0, width: 1, height: 1 }];
  let r = await postAnalyze(badField);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /入场口令/);

  const badType = JSON.parse(JSON.stringify(base));
  badType.performers[0].cues = {};
  r = await postAnalyze(badType);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cues 必须为数组/);

  const badWidth = JSON.parse(JSON.stringify(base));
  badWidth.performers[0].cues = [{ x: 0, y: 0, width: -2, height: 1 }];
  r = await postAnalyze(badWidth);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /width 不能为负/);
});

test('GET /api/sample：样例携带入场口令且分析结果为甲三态链路、乙触发', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  const counts = s.json.performers.map((p) => (p.cues || []).length);
  assert.deepEqual(counts.slice(0, 2), [3, 1]);
  const r = await postAnalyze({
    duration: s.json.duration,
    performers: s.json.performers,
    obstacles: s.json.obstacles
  });
  assert.equal(r.status, 200);
  const jia = r.json.cueResults.find((e) => e.performerId === 'p1');
  assert.deepEqual(jia.results.map((x) => x.status), ['triggered', 'missed', 'blocked']);
  const yi = r.json.cueResults.find((e) => e.performerId === 'p2');
  assert.equal(yi.results[0].status, 'triggered');
});

// ---------- 道具交接 handoffs ----------

test('POST /api/analyze：接受 handoffs 并返回 handoffResults（区间与起始时窗）', async () => {
  const body = {
    duration: 12,
    performers: [
      { id: 'a', name: '甲', radius: 5, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 120, y: 50 }] },
      { id: 'b', name: '乙', radius: 5, keys: [{ t: 0, x: 120, y: 50 }, { t: 12, x: 0, y: 50 }] }
    ],
    handoffs: [
      { aId: 'a', bId: 'b', x: 40, y: 40, width: 40, height: 20, reach: 40, minDuration: 1.5 }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.handoffs));
  assert.equal(r.json.handoffs.length, 1);
  assert.ok(r.json.handoffs[0].id, '缺省 id 自动补全');
  assert.deepEqual(r.json.scene.handoffs, r.json.handoffs, 'scene 内与顶层一致');

  assert.equal(r.json.handoffResults.length, 1);
  const res = r.json.handoffResults[0];
  assert.equal(res.valid, true);
  assert.equal(res.feasible, true);
  assert.equal(res.aName, '甲');
  assert.equal(res.bName, '乙');
  // 两人停留交集 [4,8]，间距 |20t-120|≤40 恒满足；时窗 [4, 8-1.5]=[4,6.5]
  assert.equal(res.intervals.length, 1);
  assert.ok(Math.abs(res.intervals[0][0] - 4) < 1e-9);
  assert.ok(Math.abs(res.intervals[0][1] - 8) < 1e-9);
  assert.equal(res.windows.length, 1);
  assert.ok(Math.abs(res.windows[0][0] - 4) < 1e-9);
  assert.ok(Math.abs(res.windows[0][1] - 6.5) < 1e-9);
});

test('POST /api/analyze：handoffs 触达切割与持续不足（区间在但无窗口）', async () => {
  const body = {
    duration: 12,
    performers: [
      { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 120, y: 50 }] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 120, y: 50 }, { t: 12, x: 0, y: 50 }] }
    ],
    handoffs: [
      { id: 'h1', aId: 'a', bId: 'b', x: 40, y: 40, width: 40, height: 20, reach: 20, minDuration: 1 },
      { id: 'h2', aId: 'a', bId: 'b', x: 40, y: 40, width: 40, height: 20, reach: 40, minDuration: 5 }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  const [h1, h2] = r.json.handoffResults;
  // reach=20：间距 |20t-120|≤20 → [5,7]，时窗 [5,6]
  assert.ok(Math.abs(h1.intervals[0][0] - 5) < 1e-9);
  assert.ok(Math.abs(h1.intervals[0][1] - 7) < 1e-9);
  assert.ok(Math.abs(h1.windows[0][1] - 6) < 1e-9);
  // 区间 [4,8] 长度 4 < d=5：无窗口
  assert.equal(h2.intervals.length, 1);
  assert.equal(h2.windows.length, 0);
  assert.equal(h2.feasible, false);
});

test('POST /api/analyze：非法 handoffs 返回 400', async () => {
  const base = {
    duration: 10,
    performers: [
      { id: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  };
  const handoff = { aId: 'a', bId: 'b', x: 0, y: 0, width: 10, height: 10, reach: 5, minDuration: 1 };

  const notArray = Object.assign({ handoffs: {} }, base);
  let r = await postAnalyze(notArray);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /handoffs 必须为数组/);

  const badDuration = Object.assign({}, base, {
    handoffs: [Object.assign({}, handoff, { minDuration: 0 })]
  });
  r = await postAnalyze(badDuration);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /minDuration 必须为正数/);

  const badReach = Object.assign({}, base, {
    handoffs: [Object.assign({}, handoff, { reach: -1 })]
  });
  r = await postAnalyze(badReach);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /reach 不能为负/);

  const badField = Object.assign({}, base, {
    handoffs: [Object.assign({}, handoff, { x: 'nope' })]
  });
  r = await postAnalyze(badField);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /交接/);
});

test('POST /api/analyze：无 handoffs 的旧请求保持兼容（空数组）', async () => {
  const r = await postAnalyze({
    duration: 10,
    performers: [
      { name: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { name: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.handoffs, []);
  assert.deepEqual(r.json.handoffResults, []);
  assert.deepEqual(r.json.scene.handoffs, []);
});

test('GET /api/sample：样例携带交接配置，回传分析得可交接区间与起始时窗', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.handoffs));
  assert.equal(s.json.handoffs.length, 1);
  const h = s.json.handoffs[0];
  ['id', 'aId', 'bId', 'x', 'y', 'width', 'height', 'reach', 'minDuration']
    .forEach((f) => assert.ok(h[f] !== undefined, `样例交接含字段 ${f}`));

  const r = await postAnalyze({
    duration: s.json.duration,
    performers: s.json.performers,
    obstacles: s.json.obstacles,
    handoffs: s.json.handoffs
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.handoffResults.length, 1);
  const res = r.json.handoffResults[0];
  assert.equal(res.feasible, true);
  // 甲×乙中央交接：区间 ≈[5.18,6.82]，时窗 ≈[5.18,6.32]
  assert.ok(Math.abs(res.intervals[0][0] - 4560 / 880) < 1e-9);
  assert.ok(Math.abs(res.intervals[0][1] - 6000 / 880) < 1e-9);
  assert.ok(Math.abs(res.windows[0][0] - 4560 / 880) < 1e-9);
  assert.ok(Math.abs(res.windows[0][1] - (6000 / 880 - 0.5)) < 1e-9);
});

// ---------- 区域限员 capacityZones ----------

test('POST /api/analyze：接受 capacityZones 并返回 capacityResults（超员段/名单/峰值）', async () => {
  const body = {
    duration: 12,
    performers: [
      { id: 'a', name: '甲', radius: 5, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 120, y: 50 }] },
      { id: 'b', name: '乙', radius: 5, keys: [{ t: 0, x: 120, y: 50 }, { t: 12, x: 0, y: 50 }] }
    ],
    capacityZones: [
      { name: '台口', x: 40, y: 40, width: 40, height: 20, limit: 1 },
      { id: 'z9', x: 0, y: 0, width: 30, height: 30, limit: 2 }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.capacityZones));
  assert.equal(r.json.capacityZones.length, 2);
  assert.deepEqual(r.json.scene.capacityZones, r.json.capacityZones);
  assert.ok(/^z/.test(r.json.capacityZones[0].id), '缺省 id 自动补全');
  assert.equal(r.json.capacityZones[0].name, '台口');
  assert.equal(r.json.capacityZones[1].id, 'z9', '显式 id 保留');
  assert.equal(r.json.capacityZones[1].name, '限员区 2', '缺省 name 补序号');

  assert.equal(r.json.capacityResults.length, 2);
  const hit = r.json.capacityResults[0];
  assert.equal(hit.zoneId, r.json.capacityZones[0].id);
  assert.equal(hit.limit, 1);
  assert.equal(hit.overcrowded, true);
  assert.equal(hit.intervals.length, 1);
  // 两人圆心在 x∈(40,80) 内：t∈(4,8)
  assert.ok(Math.abs(hit.intervals[0].start - 4) < 1e-9);
  assert.ok(Math.abs(hit.intervals[0].end - 8) < 1e-9);
  assert.equal(hit.intervals[0].count, 2);
  assert.deepEqual(hit.intervals[0].members.map((m) => m.id), ['a', 'b']);
  assert.equal(hit.peak, 2);
  assert.ok(Math.abs(hit.firstStart - 4) < 1e-9);
  // 角落区域无人进入：不超员、峰值 0
  const empty = r.json.capacityResults[1];
  assert.equal(empty.overcrowded, false);
  assert.deepEqual(empty.intervals, []);
  assert.equal(empty.peak, 0);
  assert.equal(empty.firstStart, null);
});

test('POST /api/analyze：同刻进出不产生零长度超员段，安全区结果不超员', async () => {
  // 甲开场在内部 t=5 离开；乙 t=5 进入并停留到收场；上限 1 → 从不超员
  const body = {
    duration: 10,
    performers: [
      { id: 'a', name: '甲', radius: 0, keys: [
        { t: 0, x: 50, y: 50 }, { t: 5, x: 40, y: 50 }, { t: 10, x: 40, y: 50 }
      ] },
      { id: 'b', name: '乙', radius: 0, keys: [
        { t: 0, x: 40, y: 50 }, { t: 5, x: 40, y: 50 }, { t: 10, x: 50, y: 50 }
      ] }
    ],
    capacityZones: [{ x: 40, y: 40, width: 20, height: 20, limit: 1 }]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  const res = r.json.capacityResults[0];
  assert.equal(res.overcrowded, false);
  assert.deepEqual(res.intervals, []);
  assert.equal(res.peak, 1, '峰值仍统计正持续状态');
});

test('POST /api/analyze：非法 capacityZones（limit / 尺寸 / 类型）返回 400', async () => {
  const base = {
    duration: 10,
    performers: [
      { id: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  };
  const zone = { x: 0, y: 0, width: 10, height: 10, limit: 1 };

  let r = await postAnalyze(Object.assign({}, base, { capacityZones: [Object.assign({}, zone, { limit: 0 })] }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /人数上限/);

  r = await postAnalyze(Object.assign({}, base, { capacityZones: [Object.assign({}, zone, { limit: 1.5 })] }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /正整数/);

  r = await postAnalyze(Object.assign({}, base, { capacityZones: [Object.assign({}, zone, { limit: 'x' })] }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /限员区域/);

  r = await postAnalyze(Object.assign({}, base, { capacityZones: [Object.assign({}, zone, { width: -1 })] }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /width 不能为负/);

  r = await postAnalyze(Object.assign({}, base, { capacityZones: {} }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /capacityZones 必须为数组/);
});

test('POST /api/analyze：无 capacityZones 的旧请求保持兼容（空数组）', async () => {
  const r = await postAnalyze({
    duration: 10,
    performers: [
      { name: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { name: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.capacityZones, []);
  assert.deepEqual(r.json.capacityResults, []);
  assert.deepEqual(r.json.scene.capacityZones, []);
});

test('GET /api/sample：样例携带限员区域，回传分析得超员段与峰值', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.capacityZones));
  assert.equal(s.json.capacityZones.length, 1);
  ['id', 'name', 'x', 'y', 'width', 'height', 'limit'].forEach((f) =>
    assert.ok(s.json.capacityZones[0][f] !== undefined, `样例限员区含字段 ${f}`));

  const r = await postAnalyze({
    duration: s.json.duration,
    performers: s.json.performers,
    obstacles: s.json.obstacles,
    handoffs: s.json.handoffs,
    capacityZones: s.json.capacityZones
  });
  assert.equal(r.status, 200);
  const z = r.json.capacityResults[0];
  assert.equal(z.limit, 1);
  assert.equal(z.intervals.length, 1);
  assert.equal(z.intervals[0].count, 2);
  assert.equal(z.peak, 2);
  assert.deepEqual(z.intervals[0].members.map((m) => m.id), ['p1', 'p2']);
});
