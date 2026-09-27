'use strict';

/**
 * 前端冒烟测试：jsdom + Canvas 2D 桩加载 core.js / app.js，
 * 模拟拖动画布走位点、增删表演者、改半径、时间轴跳转，
 * 断言重算结果与 DOM 同步。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const core = require('../public/core.js');

const PUBLIC = path.join(__dirname, '..', 'public');

function makeCtx() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      switch (prop) {
        case 'createLinearGradient': return () => gradient;
        case 'measureText': return () => ({ width: 10 });
        default:
          if (prop in t) return t[prop];
          return typeof prop === 'string' ? noop : undefined;
      }
    },
    set(t, prop, val) { t[prop] = val; return true; }
  });
}

async function boot() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  window.HTMLCanvasElement.prototype.getContext = () => makeCtx();
  window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0
  });
  window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.setPointerCapture = () => {};

  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve(core.builtinScene()) });

  const origGet = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'timeline-lanes') {
      return { left: 14, top: 40, width: 972, height: 88, right: 986, bottom: 128, x: 14, y: 40 };
    }
    if (this.id === 'timeline') {
      return { left: 0, top: 0, width: 1000, height: 140, right: 1000, bottom: 140, x: 0, y: 0 };
    }
    if (this.tagName === 'CANVAS') {
      return { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0 };
    }
    return origGet.call(this);
  };
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.id === 'timeline-lanes' ? 972 : 100; }
  });

  window.eval(fs.readFileSync(path.join(PUBLIC, 'core.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'));
  await new Promise((r) => setTimeout(r, 40));
  return dom;
}

test('启动：载入 4 人样例，摘要与 6 对结果正确渲染', async () => {
  const dom = await boot();
  const doc = dom.window.document;

  assert.equal(doc.querySelectorAll('.performer-item').length, 4);
  assert.equal(doc.querySelectorAll('.pair-row').length, 6);
  assert.match(doc.getElementById('sum-first').textContent, /2\.60\s*s/);
  assert.match(doc.getElementById('sum-min').textContent, /0\.00/);
  assert.match(doc.getElementById('sum-first-who').textContent, /丙[\s\S]*丁/);
  assert.ok(doc.querySelectorAll('.tl-danger').length >= 2, '时间轴应渲染危险区间条');
  assert.equal(doc.querySelectorAll('.tl-key').length, 10, '4 人共 10 个关键帧时刻柄');

  // 碰撞对排在前、安全对在后
  assert.ok(doc.querySelectorAll('.pair-row.danger').length >= 2);
  dom.window.close();
});

test('拖动画布走位点后立即重算：把乙两帧移到 x=300，错峰消除甲乙碰撞', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    const ev = new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    });
    canvas.dispatchEvent(ev);
  }
  // p2 初始选中者是 p1；先点中 p2 首帧 (500,40) 并拖到 (300,40)
  pointer('pointerdown', 500, 40);
  pointer('pointermove', 300, 40);
  pointer('pointerup', 300, 40);
  // 末帧 (500,560) -> (300,560)
  pointer('pointerdown', 500, 560);
  pointer('pointermove', 300, 560);
  pointer('pointerup', 300, 560);
  await new Promise((r) => setTimeout(r, 10));

  // 乙沿 x=300 纵走：路径仍几何交叉，但到达 (300,300) 时 t≈3.98，
  // 甲此时只走到 x≈329，错峰约 101.75 单位 —— 解析判定安全
  const rows = [...doc.querySelectorAll('.pair-row')].map((r) => r.textContent);
  const jiaYi = rows.find((t) => t.includes('甲') && t.includes('乙'));
  assert.match(jiaYi, /安全/);
  assert.match(jiaYi, /101\.75/);
  dom.window.close();
});

test('增加表演者与修改半径：8 人上限、C(n,2) 对实时更新', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  doc.getElementById('btn-add').click();
  assert.equal(doc.querySelectorAll('.performer-item').length, 5);
  assert.equal(doc.querySelectorAll('.pair-row').length, 10);

  for (let i = 0; i < 3; i++) doc.getElementById('btn-add').click();
  assert.equal(doc.querySelectorAll('.performer-item').length, 8);
  assert.equal(doc.getElementById('btn-add').disabled, true);
  assert.equal(doc.querySelectorAll('.pair-row').length, 28);

  // 改半径（当前选中的是新加的第 8 人）
  const rInput = doc.querySelector('.performer-item.selected .performer-radius');
  rInput.value = '100';
  rInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(doc.querySelectorAll('.pair-row').length, 28);
  // 半径 100 与最近路径几乎必然碰撞：危险对数量增加
  assert.ok(doc.querySelectorAll('.pair-row.danger').length >= 3);
  dom.window.close();
});

test('时间轴点击跳转 & 人数下限 2', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  const tl = doc.getElementById('timeline');
  const rect = doc.getElementById('timeline-lanes').getBoundingClientRect();
  tl.dispatchEvent(new window.MouseEvent('click', {
    bubbles: true, clientX: rect.left + 972 * 0.5, clientY: rect.top + 5
  }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv - 6) < 0.15, `播放时刻应≈6，实际 ${tv}`);

  const dels = doc.querySelectorAll('.performer-del');
  dels[3].click();
  dels[2].click();
  assert.equal(doc.querySelectorAll('.performer-item').length, 2);
  assert.equal(doc.querySelectorAll('.pair-row').length, 1);

  doc.querySelector('.performer-del').click();
  assert.equal(doc.querySelectorAll('.performer-item').length, 2, '必须保留至少 2 人');
  dom.window.close();
});

test('修改总时长后关键帧截断并重算', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  const dInput = doc.getElementById('duration-input');
  dInput.value = '5';
  dInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(doc.getElementById('duration-readout').textContent, '5.0');
  // 原样例 t>5 的帧被截断：p1 剩 1 帧(0)，p2 剩 1 帧(0)，p3 剩 2 帧(0,4)，p4 剩 2 帧(0,4)
  assert.equal(doc.querySelectorAll('.tl-key').length, 6);
  // 仍有结果输出
  assert.equal(doc.querySelectorAll('.pair-row').length, 6);
  dom.window.close();
});

test('选中关键帧可编辑安全半径：设置、实时碰撞、清除后继承', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  const editor = doc.getElementById('key-editor');
  const rInput = doc.getElementById('ke-radius');
  const clearBtn = doc.getElementById('ke-clear');

  // 未选中关键帧：编辑器隐藏
  assert.equal(editor.hidden, true);

  // 选中甲首帧 (60,300)
  pointer('pointerdown', 60, 300);
  pointer('pointerup', 60, 300);
  assert.equal(editor.hidden, false, '选中关键帧后出现半径编辑条');
  assert.match(doc.getElementById('ke-info').textContent, /甲/);
  assert.equal(rInput.placeholder, '20', '占位符为继承半径 20');
  assert.equal(clearBtn.disabled, true, '继承状态下清除按钮禁用');

  // 初始甲×丙安全（错峰）；把甲首帧半径设为 150，张开后在 t≈2 前即覆盖丙
  rInput.value = '150';
  rInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(clearBtn.disabled, false);

  let rows = [...doc.querySelectorAll('.pair-row')].map((r) => r.textContent);
  let jiaBing = rows.find((t) => t.includes('甲') && t.includes('丙'));
  assert.match(jiaBing, /碰撞/, '甲首帧张开 150 后应与丙产生碰撞区间');
  assert.match(jiaBing, /半径和 80～170/, '半径和范围应反映关键帧半径');

  // 对应时间轴时刻柄出现自定义半径标记（样例中丙 t=8 帧自带 1 个）
  assert.ok(doc.querySelectorAll('.tl-key.custom').length >= 2, '时间轴标记自定义半径帧');

  // 清除半径恢复继承，碰撞消失；自定义标记数回到样例自带的 1 个
  clearBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(clearBtn.disabled, true);
  assert.equal(doc.querySelectorAll('.tl-key.custom').length, 1);
  rows = [...doc.querySelectorAll('.pair-row')].map((r) => r.textContent);
  jiaBing = rows.find((t) => t.includes('甲') && t.includes('丙'));
  assert.match(jiaBing, /安全/, '恢复继承后甲丙重新安全');
  dom.window.close();
});

test('播放时当前安全半径随关键帧插值实时呈现（stateAt）', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  // 选中丙 t=8 帧 (940,540)（样例自带 r=60）并确认编辑器读回 60
  pointer('pointerdown', 940, 540);
  pointer('pointerup', 940, 540);
  assert.equal(doc.getElementById('ke-radius').value, '60', '样例关键帧半径应读回 60');

  // 引擎层插值：t=6 位于丙 4->8 帧之间，半径 20->60 线性 -> 40
  const st = window.CollisionCore.stateAt(
    [{ t: 4, x: 500, y: 60 }, { t: 8, x: 940, y: 540, r: 60 }], 6, 20);
  assert.ok(Math.abs(st.r - 40) < 1e-9, `t=6 插值半径应为 40，实际 ${st.r}`);
  dom.window.close();
});

test('最小安全余量：摘要展示、逐对升序、点击余量时刻跳转播放头', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  const analysis = core.analyzeScene(core.builtinScene());

  // 摘要：全局最小安全余量与当事人
  const sumMargin = doc.getElementById('sum-margin').textContent;
  assert.ok(
    sumMargin.includes(analysis.minMargin.toFixed(2)),
    `摘要最小余量「${sumMargin}」应含 ${analysis.minMargin.toFixed(2)}`
  );
  assert.match(doc.getElementById('sum-margin-who').textContent, /@\s*-?[\d.]+\s*s/);

  // 逐对列表：按最小安全余量升序，与引擎/API 同一顺序
  const rows = [...doc.querySelectorAll('.pair-row')];
  assert.equal(rows.length, 6);
  rows.forEach((row, i) => {
    const pair = analysis.pairs[i];
    assert.ok(
      row.textContent.includes(pair.aName) && row.textContent.includes(pair.bName),
      `第 ${i} 行应为 ${pair.aName}×${pair.bName}（余量 ${pair.minMargin.toFixed(2)}）`
    );
    assert.ok(row.textContent.includes('最小余量'), '每行展示最小安全余量');
    assert.ok(row.querySelector('.t-jump'), '每行余量时刻可点击');
    if (i > 0) {
      assert.ok(pair.minMargin >= analysis.pairs[i - 1].minMargin - 1e-12, '余量升序');
    }
  });

  // 点击首对（余量最小）的余量时刻：播放头跳转到该时刻并刷新画布
  const first = analysis.pairs[0];
  rows[0].querySelector('.t-jump').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(
    Math.abs(tv - first.minMarginT) < 0.01,
    `播放头应跳到 ${first.minMarginT}，实际 ${tv}`
  );
  assert.ok(doc.getElementById('playhead').style.left, '播放头位置已刷新');

  // 点击摘要余量行：跳转到全局最小余量时刻
  doc.getElementById('time-input').value = '0';
  doc.getElementById('sum-margin-row').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv2 = Number(doc.getElementById('time-input').value);
  assert.ok(
    Math.abs(tv2 - analysis.minMarginT) < 0.01,
    `摘要点击应跳到 ${analysis.minMarginT}，实际 ${tv2}`
  );
  dom.window.close();
});

test('禁入区：启动即渲染中央矩形、侵入结果按首入排序且当前侵入高亮', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 面板可见，4 名表演者 × 1 矩形 = 4 行；侵入行在前（乙、甲），安全行在后
  const panel = doc.getElementById('panel-obstacles');
  assert.equal(panel.hidden, false);
  const rows = [...panel.querySelectorAll('.obs-row')];
  assert.equal(rows.length, 4);
  const order = rows.map((r) => ({
    pid: r.dataset.pid,
    danger: r.classList.contains('danger')
  }));
  assert.deepEqual(order.slice(0, 2).map((o) => o.pid), ['p2', 'p1'], '按首次进入升序');
  assert.ok(order.slice(0, 2).every((o) => o.danger));
  assert.deepEqual(order.slice(2).map((o) => o.pid).sort(), ['p3', 'p4']);

  // 首行展示首次进入时刻与侵入区间芯片，均标记可点击
  assert.match(rows[0].textContent, /首次进入/);
  assert.ok(rows[0].querySelectorAll('.obs-chip').length >= 1);

  // t=5 时乙(4.15~7.85)、甲(4.91~7.09)都在侵入：两行 active-now
  const timeInput = doc.getElementById('time-input');
  timeInput.value = '5';
  timeInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const active = [...panel.querySelectorAll('.obs-row.active-now')].map((r) => r.dataset.pid).sort();
  assert.deepEqual(active, ['p1', 'p2'], 't=5 甲乙高亮为当前侵入');

  // 时间轴当事人泳道出现琥珀色禁入条
  assert.ok(doc.querySelectorAll('.tl-obstacle').length >= 2, '时间轴渲染禁入侵入条');
  dom.window.close();
});

test('禁入区：点击侵入结果跳到进入时刻', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  const rows = [...doc.querySelectorAll('#panel-obstacles .obs-row.danger')];
  const p2Row = rows.find((r) => r.dataset.pid === 'p2');
  const expected = Number(p2Row.querySelector('.t-jump[data-t]').getAttribute('data-t'));
  p2Row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv - expected) < 0.01, `播放头应跳到 ${expected}，实际 ${tv}`);

  // 点区间芯片同样跳转
  const chip = p2Row.querySelector('.obs-chip');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv3 = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv3 - expected) < 0.01);
  dom.window.close();
});

test('禁入区：画布拖出新矩形、拖动移位、编辑尺寸、右键删除并重算', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y, button = 0) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button
    }));
  }

  // 进入新增模式后在空白角落拖一个 80×80 矩形（避开既有走位点与中央矩形）
  const addBtn = doc.getElementById('btn-obstacle');
  addBtn.click();
  assert.match(addBtn.textContent, /取消/);
  pointer('pointerdown', 30, 460);
  pointer('pointermove', 120, 560);
  pointer('pointerup', 120, 560);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(addBtn.textContent, /＋/, '提交后自动退出新增模式');

  // 矩形数 1 -> 2；结果行 4 -> 8
  const analysis = window.CollisionCore;
  assert.ok(analysis, '引擎可用');
  let rows = [...doc.querySelectorAll('#panel-obstacles .obs-row')];
  assert.equal(rows.length, 8, '每人 × 2 矩形');

  // 新矩形被选中，出现编辑条；改为更宽尺寸后重算
  const editor = doc.getElementById('obstacle-editor');
  assert.equal(editor.hidden, false, '新增后选中并显示矩形编辑条');
  const wInput = doc.getElementById('oe-width');
  wInput.value = '300';
  wInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  rows = [...doc.querySelectorAll('#panel-obstacles .obs-row')];
  assert.equal(rows.length, 8);
  assert.ok(rows.some((r) => r.classList.contains('danger')), '加宽后覆盖部分轨迹产生侵入');

  // 拖动矩形（命中区域内部），位置改变后保持选中
  pointer('pointerdown', 40, 470);
  pointer('pointermove', 60, 490);
  pointer('pointerup', 60, 490);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(editor.hidden, false);

  // 右键删除（矩形已随拖动平移到 50,480 起），矩形回到 1 个、结果行 4 行
  pointer('contextmenu', 90, 510, 2);
  await new Promise((r) => setTimeout(r, 10));
  rows = [...doc.querySelectorAll('#panel-obstacles .obs-row')];
  assert.equal(rows.length, 4);
  assert.equal(editor.hidden, true, '删除后编辑条隐藏');
  dom.window.close();
});

test('禁入区：单击画布投放默认尺寸矩形，Esc 取消新增模式', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');
  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  const addBtn = doc.getElementById('btn-obstacle');
  addBtn.click();
  // Esc 取消，不产生矩形
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  assert.match(addBtn.textContent, /＋/);
  let rows = [...doc.querySelectorAll('#panel-obstacles .obs-row')];
  assert.equal(rows.length, 4);

  // 重新进入模式，空白处单击（无拖动）投放默认尺寸
  addBtn.click();
  pointer('pointerdown', 820, 80);
  pointer('pointerup', 820, 80);
  await new Promise((r) => setTimeout(r, 10));
  rows = [...doc.querySelectorAll('#panel-obstacles .obs-row')];
  assert.equal(rows.length, 8);
  dom.window.close();
});

test('方案快照：保存（首个自动选为方案 2）、列表计数与 localStorage 持久化', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 初始：0/8，有空态提示，对比区为引导文案
  assert.match(doc.getElementById('snap-head').textContent, /0\/8/);
  assert.ok(doc.querySelector('.snap-empty'));
  assert.match(doc.getElementById('snap-diff').textContent, /保存至少一个快照/);

  const nameInput = doc.getElementById('snap-name');
  nameInput.value = '初稿';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 10));

  assert.match(doc.getElementById('snap-head').textContent, /1\/8/);
  assert.equal(doc.querySelectorAll('.snap-item').length, 1);
  // 首个快照自动进入方案 2 槽位，立即与"当前场景"对比
  assert.notEqual(doc.getElementById('snap-select-b').value, '__current__');
  assert.match(doc.getElementById('snap-diff').textContent, /全局最大偏移/);
  // 状态提示
  assert.match(doc.getElementById('snap-status').textContent, /已保存快照/);

  // 已写入 localStorage（结构含 version/selectA/selectB/list）
  const stored = JSON.parse(window.localStorage.getItem('trajectory-collision-stage.snapshots.v1'));
  assert.equal(stored.version, 1);
  assert.equal(stored.list.length, 1);
  assert.equal(stored.list[0].name, '初稿');
  assert.equal(stored.list[0].scene.performers.length, 4);
  assert.equal(stored.list[0].scene.obstacles.length, 1);

  // 不填名称：给出警告且不新增
  nameInput.value = '';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-item').length, 1);
  assert.match(doc.getElementById('snap-status').textContent, /请先填写快照名称/);
  dom.window.close();
});

test('方案快照：同名覆盖不新增、异名最多 8 个', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const nameInput = doc.getElementById('snap-name');

  nameInput.value = 'v1';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));

  // 同名覆盖：仍为 1 个，场景内容被更新
  nameInput.value = 'v1';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-item').length, 1);
  assert.match(doc.getElementById('snap-status').textContent, /已覆盖同名快照/);

  for (let i = 2; i <= 8; i++) {
    nameInput.value = 'v' + i;
    doc.getElementById('btn-snap-save').click();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(doc.querySelectorAll('.snap-item').length, 8);

  // 第 9 个异名快照被拒绝并提示
  nameInput.value = 'v9';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-item').length, 8);
  assert.match(doc.getElementById('snap-status').textContent, /最多保留 8 个/);

  // 同名覆盖在满额时仍允许
  nameInput.value = 'v1';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-item').length, 8);
  dom.window.close();
});

test('方案快照：删除快照、行内覆盖按钮、载入快照', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const nameInput = doc.getElementById('snap-name');

  nameInput.value = '甲案';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));

  // 行内覆盖
  const item = doc.querySelector('.snap-item');
  item.querySelector('.snap-overwrite').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.match(doc.getElementById('snap-status').textContent, /覆盖快照/);

  // 改动舞台后载入快照：回到快照场景（4 人）
  doc.getElementById('btn-add').click();
  assert.equal(doc.querySelectorAll('.performer-item').length, 5);
  item.querySelector('.snap-load').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(doc.querySelectorAll('.performer-item').length, 4, '载入快照恢复为 4 人');
  assert.match(doc.getElementById('snap-status').textContent, /已载入快照/);

  // 删除
  item.querySelector('.snap-del').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-item').length, 0);
  assert.match(doc.getElementById('snap-head').textContent, /0\/8/);
  // 对比槽位回到"当前场景"，引导文案恢复
  assert.equal(doc.getElementById('snap-select-b').value, '__current__');
  assert.match(doc.getElementById('snap-diff').textContent, /保存至少一个快照/);
  const stored = JSON.parse(window.localStorage.getItem('trajectory-collision-stage.snapshots.v1'));
  assert.equal(stored.list.length, 0);
  dom.window.close();
});

test('方案快照：编辑场景立即刷新对比，点击结果时刻跳转播放头', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  doc.getElementById('snap-name').value = '初稿';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 10));
  const diffEl = doc.getElementById('snap-diff');

  // 刚保存（场景未改）：偏移为 0
  assert.match(diffEl.textContent, /全局最大偏移\s*0\.00/);

  // 拖动甲首帧 (60,300) -> (160,300)：对比立即更新（无需重新选择）
  pointer('pointerdown', 60, 300);
  pointer('pointermove', 160, 300);
  pointer('pointerup', 160, 300);
  await new Promise((r) => setTimeout(r, 10));

  assert.match(diffEl.textContent, /全局最大偏移\s*100\.00/);
  // 碰撞对变化区块出现"新增/消失/时间变化"之一
  const sections = [...diffEl.querySelectorAll('.diff-section')];
  assert.equal(sections.length, 3, '偏移 / 碰撞对 / 禁入区 三个区块');
  assert.match(sections[1].textContent, /碰撞对变化/);
  assert.match(sections[2].textContent, /禁入区间变化/);

  // 点击全局最大偏移时刻：播放头跳到该时刻（t=0）
  const maxJump = diffEl.querySelector('.diff-max-row .t-jump');
  assert.ok(maxJump);
  maxJump.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(Number(doc.getElementById('time-input').value), 0);

  // 点击碰撞对区块中的某个时刻跳转元素
  doc.getElementById('time-input').value = '9';
  doc.getElementById('time-input').dispatchEvent(new window.Event('change', { bubbles: true }));
  const pairJump = sections[1].querySelector('.t-jump');
  const expected = Number(pairJump.getAttribute('data-t'));
  pairJump.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv - expected) < 0.01, `播放头应跳到 ${expected}，实际 ${tv}`);
  dom.window.close();
});

test('方案快照：两个槽位都选快照时按快照内容对比，相同选择给出提示', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const nameInput = doc.getElementById('snap-name');
  const selA = doc.getElementById('snap-select-a');
  const selB = doc.getElementById('snap-select-b');

  nameInput.value = 's1';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));
  const id1 = selB.value;
  nameInput.value = 's2';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-item').length, 2);

  // 两槽位选同一快照：提示文案，不计算
  selA.value = id1;
  selA.dispatchEvent(new window.Event('change', { bubbles: true }));
  selB.value = id1;
  selB.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(doc.getElementById('snap-diff').textContent, /两个选择相同/);

  // 改为两个不同快照：恢复正常对比（快照未改动 → 偏移为 0）
  const id2 = [...selB.options].map((o) => o.value).find((v) => v !== id1 && v !== '__current__');
  selB.value = id2;
  selB.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(doc.getElementById('snap-diff').textContent, /全局最大偏移\s*0\.00/);
  dom.window.close();
});

// ---------- 入场口令 ----------

test('入场口令：启动即渲染面板与样例口令，三态状态文字与触发跳转正确', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 默认选中甲（p1）：面板可见、标题为甲、3 条口令行（触发/错过/前序未完成）
  const panel = doc.getElementById('panel-cues');
  assert.equal(panel.hidden, false);
  assert.match(doc.getElementById('cue-performer-name').textContent, /甲/);
  let rows = [...panel.querySelectorAll('.cue-row')];
  assert.equal(rows.length, 3);
  assert.ok(rows[0].classList.contains('cue-triggered'));
  assert.ok(rows[1].classList.contains('cue-missed'));
  assert.ok(rows[2].classList.contains('cue-blocked'));
  assert.match(rows[0].textContent, /已触发/);
  assert.match(rows[1].textContent, /错过时窗/);
  assert.match(rows[2].textContent, /前序未完成/);
  // 错过行展示实际进入时刻供诊断
  assert.match(rows[1].textContent, /实际进入\s*5\.18/);

  // 点击已触发时刻跳转播放头
  const jump = rows[0].querySelector('.cue-jump');
  assert.ok(jump, '已触发行含可点击时刻');
  const expected = Number(jump.getAttribute('data-t'));
  jump.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv - expected) < 0.01, `播放头应跳到 ${expected}，实际 ${tv}`);

  // 切换到乙（p2）：1 条口令且已触发；切到丙：空态
  doc.querySelectorAll('.performer-item')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  rows = [...panel.querySelectorAll('.cue-row')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].classList.contains('cue-triggered'));

  doc.querySelectorAll('.performer-item')[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('cue-empty').hidden, false);
  assert.equal(panel.querySelectorAll('.cue-row').length, 0);
  dom.window.close();
});

test('入场口令：新增默认入口、编辑时窗即时重算、删除与排序按钮', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  // 选中丙（无口令），把播放头放到 t=0（圆心 (60,540)），新增一个入口
  doc.querySelectorAll('.performer-item')[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const addBtn = doc.getElementById('btn-cue-add');
  addBtn.click();
  let rows = [...doc.querySelectorAll('.cue-row')];
  assert.equal(rows.length, 1);
  // 默认时窗 0–12、尺寸 100×100，起点已在内部 -> 0s 触发
  assert.ok(rows[0].classList.contains('cue-triggered'));
  assert.match(rows[0].querySelector('.cue-status').textContent, /0\.00\s*s/);

  // 编辑时窗为 2–4（起点在 t=0 进入，窗外）-> 错过时窗，立即重算
  const winInputs = rows[0].querySelectorAll('input[type="number"]');
  // 输入顺序：x,y,宽,高,winStart,winEnd
  winInputs[4].value = '2';
  winInputs[4].dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  rows = [...doc.querySelectorAll('.cue-row')];
  assert.ok(rows[0].classList.contains('cue-missed'), '0s 进入落在窗外应错过');

  // 再新增一条：第一条错过 -> 第二条前序未完成（同矩形同次停留也不可再用）
  addBtn.click();
  await new Promise((r) => setTimeout(r, 5));
  rows = [...doc.querySelectorAll('.cue-row')];
  assert.equal(rows.length, 2);
  assert.ok(rows[1].classList.contains('cue-blocked'));

  // ↑ 把第二条上移：顺序交换——新第一条默认窗 [0,12] 在 0s 触发，
  // 新第二条（窗 2–4，进入已被同次停留占用且窗外）错过
  rows[1].querySelector('.cue-nav').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  rows = [...doc.querySelectorAll('.cue-row')];
  assert.ok(rows[0].classList.contains('cue-triggered'));
  assert.ok(rows[1].classList.contains('cue-missed'));

  // 删除第 1 行，回到 1 行（窗 2–4，错过）
  rows[0].querySelector('.cue-del-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  rows = [...doc.querySelectorAll('.cue-row')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].classList.contains('cue-missed'));
  dom.window.close();
});

test('入场口令：编辑走位即时重算状态，且随快照保存并在载入时恢复', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  // 选中乙（1 条窗 [4.5,5] 的口令，t≈4.62 触发）
  doc.querySelectorAll('.performer-item')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  let row = doc.querySelector('.cue-row');
  assert.ok(row.classList.contains('cue-triggered'));

  // 拖动乙首帧 (500,40) -> (300,40)：新路径 x=300 不再经过中央矩形 -> 立即错过
  pointer('pointerdown', 500, 40);
  pointer('pointermove', 300, 40);
  pointer('pointerup', 300, 40);
  await new Promise((r) => setTimeout(r, 10));
  row = doc.querySelector('.cue-row');
  assert.ok(row.classList.contains('cue-missed'), '轨迹不再进入矩形应立即重算为错过');
  assert.match(row.textContent, /全程未进入/);

  // 存快照：scene.performers 中乙的 cues 已持久化
  doc.getElementById('snap-name').value = '口令案';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 10));
  const stored = JSON.parse(window.localStorage.getItem('trajectory-collision-stage.snapshots.v1'));
  const yi = stored.list[0].scene.performers.find((p) => p.id === 'p2');
  assert.equal(yi.cues.length, 1);
  assert.equal(yi.cues[0].winStart, 4.5);
  assert.equal(yi.cues[0].winEnd, 5);

  // 恢复样例（乙路径复原），再载入快照：口令与状态一并恢复为修改后场景
  doc.getElementById('btn-sample') ? null : null;
  doc.querySelector('.snap-item .snap-load').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  // 载入快照后选中者重置为首位，重新选中乙核对
  doc.querySelectorAll('.performer-item')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  row = doc.querySelector('.cue-row');
  assert.ok(row, '载入快照后口令恢复');
  assert.ok(row.classList.contains('cue-missed'), '载入恢复拖帧后的错过状态');
  assert.equal(doc.querySelectorAll('.cue-row').length, 1);
  dom.window.close();
});

// ---------- 道具交接 ----------

test('道具交接：启动即渲染样例交接，区间与时窗芯片正确，点击时窗跳转播放头', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 样例自带 1 项交接（甲×乙、中央交接区、触达 80、持续 0.5s）
  const rows = [...doc.querySelectorAll('.handoff-row')];
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row.classList.contains('feasible'), '样例交接可行，行标记 feasible');

  // 头部两个表演者下拉：甲 × 乙
  const selects = row.querySelectorAll('.handoff-select');
  assert.equal(selects.length, 2);
  assert.equal(selects[0].value, 'p1');
  assert.equal(selects[1].value, 'p2');

  // 可交接区间 ≈[5.18,6.82]，起始时窗 ≈[5.18,6.32]（持续 0.5s）
  const ivChip = row.querySelector('.handoff-iv-chip');
  assert.ok(ivChip, '展示可交接区间芯片');
  assert.match(ivChip.textContent, /5\.18–6\.82\s*s/);
  const winChip = row.querySelector('.handoff-win-chip');
  assert.ok(winChip, '展示起始时窗芯片');
  assert.match(winChip.textContent, /5\.18–6\.32\s*s/);

  // 点击时窗：播放头跳到时窗起点
  const expected = Number(winChip.getAttribute('data-t'));
  assert.ok(Math.abs(expected - 4560 / 880) < 1e-6, `时窗起点应≈5.1818，实际 ${expected}`);
  winChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv - 5.18) < 0.01, `播放头应跳到 5.18，实际 ${tv}`);
  dom.window.close();
});

test('道具交接：新增交接、编辑交接区即时重算、删除', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 初始 1 行（样例）；新增后 2 行：默认 甲×乙、交接区在两人当前圆心中点
  doc.getElementById('btn-handoff-add').click();
  await new Promise((r) => setTimeout(r, 5));
  let rows = [...doc.querySelectorAll('.handoff-row')];
  assert.equal(rows.length, 2);
  const newRow = rows[1];
  const selects = newRow.querySelectorAll('.handoff-select');
  assert.equal(selects[0].value, 'p1', '默认甲方为当前选中者');
  assert.equal(selects[1].value, 'p2', '默认乙方为下一名表演者');
  // 默认交接区在两人 t=0 圆心中点 (280,170) 附近，两人均不在内 -> 无满足区间
  assert.match(newRow.querySelector('.handoff-result').textContent, /全程不同时满足/);

  // 编辑交接区到中央 (440,240)：立即重算，出现可交接区间与起始时窗
  function rowInputs(row) {
    return [...row.querySelectorAll('input[type="number"]')];
  }
  // 输入顺序：x, y, 宽, 高, 触达, 持续
  rowInputs(newRow)[0].value = '440';
  rowInputs(newRow)[0].dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  const yInput = rowInputs(doc.querySelectorAll('.handoff-row')[1])[1];
  yInput.value = '240';
  yInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));

  const updated = doc.querySelectorAll('.handoff-row')[1];
  assert.match(updated.querySelector('.handoff-result').textContent, /可交接区间/);
  assert.ok(updated.querySelector('.handoff-win-chip'), '编辑参数后即时给出起始时窗');

  // 删除新增行，回到样例的 1 行
  updated.querySelector('.handoff-del').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  rows = [...doc.querySelectorAll('.handoff-row')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].querySelector('.handoff-win-chip'), '样例交接不受影响');
  dom.window.close();
});

test('道具交接：拖走位即时重算，且配置随快照保存并在载入时恢复', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  // 初始：样例交接有起始时窗
  assert.ok(doc.querySelector('.handoff-row .handoff-win-chip'));

  // 拖动乙首帧 (500,40) -> (300,40)：乙不再经过中央交接区 -> 立即无满足区间
  pointer('pointerdown', 500, 40);
  pointer('pointermove', 300, 40);
  pointer('pointerup', 300, 40);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(doc.querySelector('.handoff-row .handoff-result').textContent, /全程不同时满足/);
  assert.ok(!doc.querySelector('.handoff-row .handoff-win-chip'), '时窗芯片消失');

  // 存快照：交接配置（甲×乙、触达 80、持续 0.5）随场景持久化
  doc.getElementById('snap-name').value = '交接案';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 10));
  const stored = JSON.parse(window.localStorage.getItem('trajectory-collision-stage.snapshots.v1'));
  assert.equal(stored.list[0].scene.handoffs.length, 1);
  const sh = stored.list[0].scene.handoffs[0];
  assert.equal(sh.aId, 'p1');
  assert.equal(sh.bId, 'p2');
  assert.equal(sh.reach, 80);
  assert.equal(sh.minDuration, 0.5);

  // 重置样例：交接恢复为有时窗；再载入快照：恢复拖动后的"全程不同时满足"
  doc.getElementById('btn-sample').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(doc.querySelector('.handoff-row .handoff-win-chip'), '重置样例后时窗恢复');

  doc.querySelector('.snap-item .snap-load').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const rows = [...doc.querySelectorAll('.handoff-row')];
  assert.equal(rows.length, 1, '载入快照后交接配置恢复');
  assert.match(rows[0].querySelector('.handoff-result').textContent, /全程不同时满足/,
    '载入恢复拖帧后的交接结果');
  dom.window.close();
});

// ---------- 区域限员 ----------

test('区域限员：启动即渲染样例限员区，超员段/人数/名单/峰值正确，点击起点跳转', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 样例自带 1 个中央限员区（上限 1），行标记超员
  const rows = [...doc.querySelectorAll('.zone-row')];
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row.classList.contains('over'), '样例限员区超员，行标记 over');

  const text = row.querySelector('.zone-result').textContent;
  assert.match(text, /全程峰值\s*2\s*人/);
  assert.match(text, /上限\s*1\s*人/);
  assert.match(text, /超员时段\s*1\s*段/);
  assert.match(text, /2 人（超 1）/);
  // 名单含甲、乙
  const tags = [...row.querySelectorAll('.zone-member-tag')].map((el) => el.textContent);
  assert.ok(tags.some((t) => t.includes('甲')), '名单含甲');
  assert.ok(tags.some((t) => t.includes('乙')), '名单含乙');

  // 超员芯片 ≈[5.18,6.82]
  const chip = row.querySelector('.zone-over-chip');
  assert.ok(chip, '展示可点击的超员区间芯片');
  assert.match(chip.textContent, /5\.18–6\.82\s*s/);
  const expected = Number(chip.getAttribute('data-t'));
  assert.ok(Math.abs(expected - 4560 / 880) < 1e-6);

  // 点击芯片：播放头跳到超员起点
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv - 5.18) < 0.01, `播放头应跳到 5.18，实际 ${tv}`);

  // 选中限员区后画布下方出现青色编辑条
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('zone-editor').hidden, false);
  assert.equal(doc.getElementById('ze-limit').value, '1');
  dom.window.close();
});

test('区域限员：新增/编辑（坐标、非负宽高、正整数上限）即时重算，删除', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 新增一个默认区（落在舞台中央偏移处，默认上限 2：即便有人经过也不超员）
  doc.getElementById('btn-zone-add').click();
  await new Promise((r) => setTimeout(r, 5));
  let rows = [...doc.querySelectorAll('.zone-row')];
  assert.equal(rows.length, 2);
  const newRow = rows[1];
  assert.match(newRow.querySelector('.zone-result').textContent, /全程未超员/);
  assert.equal(newRow.classList.contains('over'), false);

  function rowInputs(row) {
    return [...row.querySelectorAll('input[type="number"]')];
  }
  // 输入顺序：x, y, 宽, 高, 上限
  const setInput = (idx, val) => {
    const inp = rowInputs(doc.querySelectorAll('.zone-row')[1])[idx];
    inp.value = String(val);
    inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  // 移到中央 (440,240) 120×120 并把上限设为 1：甲乙横穿即超员
  setInput(0, 440);
  setInput(1, 240);
  setInput(2, 120);
  setInput(3, 120);
  setInput(4, 1);
  await new Promise((r) => setTimeout(r, 5));

  let updated = doc.querySelectorAll('.zone-row')[1];
  assert.match(updated.querySelector('.zone-result').textContent, /超员时段\s*1\s*段/);
  assert.ok(updated.querySelector('.zone-over-chip'), '编辑后即时给出超员段');
  assert.ok(updated.classList.contains('over'));

  // 上限改为 3：不再超员（峰值 2），行的 over 标记移除
  setInput(4, 3);
  await new Promise((r) => setTimeout(r, 5));
  updated = doc.querySelectorAll('.zone-row')[1];
  assert.match(updated.querySelector('.zone-result').textContent, /全程未超员/);
  assert.ok(!updated.classList.contains('over'));

  // 非正整数上限被拒绝（恢复为 3）
  const limitInput = rowInputs(updated)[4];
  limitInput.value = '0';
  limitInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(rowInputs(doc.querySelectorAll('.zone-row')[1])[4].value, '3');

  // 零宽：退化为无内部区域，给出永不统计提示
  const wInput = rowInputs(doc.querySelectorAll('.zone-row')[1])[2];
  wInput.value = '0';
  wInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  updated = doc.querySelectorAll('.zone-row')[1];
  assert.match(updated.querySelector('.zone-result').textContent, /零宽 \/ 零高/);
  assert.ok(updated.classList.contains('degenerate'));

  // 删除新增行，回到样例 1 行
  doc.querySelectorAll('.zone-row')[1].querySelector('.zone-del')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  rows = [...doc.querySelectorAll('.zone-row')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].querySelector('.zone-over-chip'), '样例限员区不受影响');
  dom.window.close();
});

test('区域限员：画布拖出、移位、右键删除；拖走位即时重算', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }

  // 顶部按钮进入新增模式后在画布上拖出一个覆盖中央的矩形
  doc.getElementById('btn-zone').click();
  pointer('pointerdown', 440, 240);
  pointer('pointermove', 560, 360);
  pointer('pointerup', 560, 360);
  await new Promise((r) => setTimeout(r, 10));
  // 新增区（中央 120×120、默认上限 2）与样例区（上限 1）共存：2 行
  let rows = [...doc.querySelectorAll('.zone-row')];
  assert.equal(rows.length, 2);
  // 默认上限 2：甲乙峰值 2，不超员
  const added = rows[1];
  assert.match(added.querySelector('.zone-result').textContent, /全程未超员/);
  assert.match(added.querySelector('.zone-result').textContent, /全程峰值\s*2\s*人/);

  // 拖动该矩形（命中其内部，例如 (500,300)）向右平移一点：即时重算且不报错
  pointer('pointerdown', 500, 300);
  pointer('pointermove', 540, 300);
  pointer('pointerup', 540, 300);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(doc.querySelectorAll('.zone-row').length, 2);

  // 右键删除新矩形：回到 1 行
  canvas.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 540, clientY: 300, button: 2
  }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(doc.querySelectorAll('.zone-row').length, 1);

  // 拖走位：把乙两帧移到 x=300，不再经过中央限员区 → 样例超员段消失
  pointer('pointerdown', 500, 40);
  pointer('pointermove', 300, 40);
  pointer('pointerup', 300, 40);
  pointer('pointerdown', 500, 560);
  pointer('pointermove', 300, 560);
  pointer('pointerup', 300, 560);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(doc.querySelector('.zone-row .zone-result').textContent, /全程未超员/);
  assert.ok(!doc.querySelector('.zone-row .zone-over-chip'), '超员芯片消失');
  dom.window.close();
});

test('区域限员：配置随快照保存并在载入时恢复', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 编辑样例区上限为 3：不再超员
  const limitInput = [...doc.querySelectorAll('.zone-row')[0].querySelectorAll('input[type="number"]')][4];
  limitInput.value = '3';
  limitInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  assert.match(doc.querySelector('.zone-row .zone-result').textContent, /全程未超员/);

  doc.getElementById('snap-name').value = '限员案';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 10));
  const stored = JSON.parse(window.localStorage.getItem('trajectory-collision-stage.snapshots.v1'));
  assert.equal(stored.list[0].scene.capacityZones.length, 1);
  assert.equal(stored.list[0].scene.capacityZones[0].limit, 3);

  // 重置样例恢复上限 1（超员），载入快照后恢复为上限 3（不超员）
  doc.getElementById('btn-sample').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(doc.querySelector('.zone-row .zone-over-chip'), '重置样例后超员恢复');
  doc.querySelector('.snap-item .snap-load').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const rows = [...doc.querySelectorAll('.zone-row')];
  assert.equal(rows.length, 1, '载入快照后限员配置恢复');
  assert.match(rows[0].querySelector('.zone-result').textContent, /全程未超员/);
  assert.equal([...rows[0].querySelectorAll('input[type="number"]')][4].value, '3');
  dom.window.close();
});
