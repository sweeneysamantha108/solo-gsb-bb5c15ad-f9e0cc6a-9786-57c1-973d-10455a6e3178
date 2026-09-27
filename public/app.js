'use strict';

/* global CollisionCore */

(function () {
  var Core = CollisionCore;
  var WORLD_W = 1000;
  var WORLD_H = 600;
  var COLORS = ['#ef4444', '#38bdf8', '#22c55e', '#facc15', '#a78bfa', '#fb923c', '#f472b6', '#2dd4bf'];
  var KEY_HIT_PX = 9;      // 走位点命中半径（屏幕像素）
  var TICK_HIT_PX = 7;     // 时间轴时刻柄命中半径
  var NEW_OBS_SIZE = 120;  // 单击画布新增禁入矩形的默认边长
  var NEW_ZONE_SIZE = 120; // 单击画布新增限员矩形的默认边长
  var ZONE_LIMIT_DEFAULT = 2; // 新增限员区域的默认人数上限

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  var tooltip = document.getElementById('tooltip');

  // ---------- 全局状态 ----------
  var state = {
    duration: 12,
    performers: [],
    obstacles: [],
    handoffs: [],
    capacityZones: [],
    selectedPid: null,
    selectedKey: null,      // {pid, index}
    selectedObstacleId: null,
    selectedZoneId: null,
    addObstacleMode: false, // 下一次在画布拖出/单击投放禁入矩形
    addZoneMode: false,     // 下一次在画布拖出/单击投放限员矩形
    time: 0,
    playing: false,
    speed: 1,
    analysis: null,
    activePairKey: null,    // 结果面板选中的双人对
    drag: null              // 画布/时间轴拖拽上下文
  };

  function uid() {
    return 'p' + Math.random().toString(36).slice(2, 8);
  }

  function cueId() {
    return 'c' + Math.random().toString(36).slice(2, 8);
  }

  function getPerformer(pid) {
    return state.performers.find(function (p) { return p.id === pid; }) || null;
  }

  function getObstacle(oid) {
    return state.obstacles.find(function (o) { return o.id === oid; }) || null;
  }

  function getZone(zid) {
    return state.capacityZones.find(function (z) { return z.id === zid; }) || null;
  }

  // ---------- 场景装载 ----------
  function loadScene(scene, opts) {
    opts = opts || {};
    state.duration = Number(scene.duration) || 12;
    state.performers = (scene.performers || []).map(function (p, i) {
      return {
        id: p.id || uid(),
        name: p.name || '表演者' + (i + 1),
        color: p.color || COLORS[i % COLORS.length],
        radius: clampRadius(Number(p.radius)),
        keys: (p.keys || []).map(function (k) {
          var hasR = k.r !== undefined && k.r !== null && k.r !== '' && isFinite(Number(k.r));
          return {
            t: Number(k.t),
            x: Number(k.x),
            y: Number(k.y),
            // 缺省安全半径：null 表示继承表演者当前半径
            r: hasR ? clampRadius(Number(k.r)) : null
          };
        }),
        // 入场口令经引擎同一规整（缺省时窗补 [0,duration]、端点倒置交换、缺省 id 补全）
        cues: Core.normalizeCues(p.cues, state.duration).map(function (c) {
          c.x = Math.round(c.x);
          c.y = Math.round(c.y);
          c.width = Math.round(c.width);
          c.height = Math.round(c.height);
          c.winStart = Math.round(c.winStart * 100) / 100;
          c.winEnd = Math.round(c.winEnd * 100) / 100;
          return c;
        })
      };
    });
    // 禁入矩形经引擎同一规整（坐标/尺寸钳制、缺省 id/name 补全）
    state.obstacles = Core.normalizeObstacles(scene.obstacles).map(function (o) {
      o.x = Math.round(o.x);
      o.y = Math.round(o.y);
      o.width = Math.round(o.width);
      o.height = Math.round(o.height);
      return o;
    });
    // 道具交接经引擎同一规整（缺省 id 补全、尺寸/触达钳非负、最短持续必须为正）
    state.handoffs = Core.normalizeHandoffs(scene.handoffs, state.duration).map(function (h) {
      h.x = Math.round(h.x);
      h.y = Math.round(h.y);
      h.width = Math.round(h.width);
      h.height = Math.round(h.height);
      h.reach = Math.round(h.reach * 10) / 10;
      h.minDuration = Math.round(h.minDuration * 100) / 100;
      return h;
    });
    // 区域限员经引擎同一规整（缺省 id/name 补全、尺寸钳非负、上限取正整数）
    state.capacityZones = Core.normalizeCapacityZones(scene.capacityZones).map(function (z) {
      z.x = Math.round(z.x);
      z.y = Math.round(z.y);
      z.width = Math.round(z.width);
      z.height = Math.round(z.height);
      return z;
    });
    state.selectedPid = state.performers[0] ? state.performers[0].id : null;
    state.selectedKey = null;
    state.selectedObstacleId = null;
    state.selectedZoneId = null;
    state.activePairKey = null;
    setAddObstacleMode(false);
    setAddZoneMode(false);
    state.time = opts.keepTime ? Math.min(state.time, state.duration) : 0;
    state.playing = false;
    document.getElementById('duration-input').value = state.duration;
    recompute();
    renderPerformers();
    renderZones();
    renderTimelineStatic();
    draw();
  }

  function clampRadius(r) {
    if (!isFinite(r) || r < 0) return 20;
    return Math.min(150, Math.round(r * 10) / 10);
  }

  // 关键帧生效安全半径：缺省（null）继承表演者当前半径
  function keyRadius(p, k) {
    return k && k.r !== null && k.r !== undefined ? k.r : p.radius;
  }

  // 取得当前选中关键帧对象（拖动/删帧可能使索引失效）
  function getSelectedKey() {
    if (!state.selectedKey) return null;
    var p = getPerformer(state.selectedKey.pid);
    if (!p) return null;
    var k = p.keys[state.selectedKey.index];
    return k ? { p: p, k: k, index: state.selectedKey.index } : null;
  }

  // ---------- 重算（拖动后立即调用） ----------
  function recompute() {
    state.analysis = Core.analyzeScene({
      duration: state.duration,
      performers: state.performers,
      obstacles: state.obstacles,
      handoffs: state.handoffs,
      capacityZones: state.capacityZones
    });
    renderSummary();
    renderPairs();
    renderObstacleResults();
    renderCueResults();
    renderHandoffResults();
    renderZoneResults();
    renderTimelineDanger();
    updatePlayhead();
    refreshSnapshotDiff(); // 编辑场景后立即刷新方案对比
  }

  // ---------- 坐标换算 ----------
  function view() {
    var rect = canvas.getBoundingClientRect();
    return {
      sx: rect.width / WORLD_W,
      sy: rect.height / WORLD_H,
      rect: rect
    };
  }
  function toWorld(clientX, clientY) {
    var v = view();
    return {
      x: (clientX - v.rect.left) / v.sx,
      y: (clientY - v.rect.top) / v.sy
    };
  }

  // ---------- 命中检测 ----------
  function hitTestObstacle(wx, wy) {
    // 后画的（列表末尾）在上层，优先命中
    for (var i = state.obstacles.length - 1; i >= 0; i--) {
      var o = state.obstacles[i];
      if (wx >= o.x && wx <= o.x + o.width && wy >= o.y && wy <= o.y + o.height) {
        return o;
      }
    }
    return null;
  }

  function hitTestZone(wx, wy) {
    // 限员区与禁入区分开命中；后加的在上层
    for (var i = state.capacityZones.length - 1; i >= 0; i--) {
      var z = state.capacityZones[i];
      if (wx >= z.x && wx <= z.x + z.width && wy >= z.y && wy <= z.y + z.height) {
        return z;
      }
    }
    return null;
  }

  function hitTestKey(wx, wy) {
    var v = view();
    var tolX = KEY_HIT_PX / v.sx;
    var tolY = KEY_HIT_PX / v.sy;
    // 先选中的人优先，其余从上层往下
    var order = state.performers.slice().reverse();
    if (state.selectedPid) {
      order.sort(function (a, b) {
        return (b.id === state.selectedPid ? 1 : 0) - (a.id === state.selectedPid ? 1 : 0);
      });
    }
    for (var pi = 0; pi < order.length; pi++) {
      var p = order[pi];
      for (var i = p.keys.length - 1; i >= 0; i--) {
        var k = p.keys[i];
        if (Math.abs(k.x - wx) <= tolX && Math.abs(k.y - wy) <= tolY) {
          return { pid: p.id, index: i };
        }
      }
    }
    return null;
  }

  // ---------- 画布交互 ----------
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var w = toWorld(e.clientX, e.clientY);

    // 禁入区新增模式：拖出矩形（单击则投放默认尺寸）
    if (state.addObstacleMode) {
      state.drag = {
        type: 'obs-new',
        x0: w.x,
        y0: w.y,
        x1: w.x,
        y1: w.y,
        moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 限员区新增模式：拖出矩形（单击则投放默认尺寸）
    if (state.addZoneMode) {
      state.drag = {
        type: 'zone-new',
        x0: w.x,
        y0: w.y,
        x1: w.x,
        y1: w.y,
        moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    var hitZone = hitTestZone(w.x, w.y);
    if (hitZone) {
      state.selectedZoneId = hitZone.id;
      state.selectedObstacleId = null;
      state.selectedKey = null;
      state.drag = {
        type: 'zone',
        zid: hitZone.id,
        offX: w.x - hitZone.x,
        offY: w.y - hitZone.y,
        moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      renderZones();
      draw();
      return;
    }

    var hitObs = hitTestObstacle(w.x, w.y);
    if (hitObs) {
      state.selectedObstacleId = hitObs.id;
      state.selectedZoneId = null;
      state.selectedKey = null;
      state.drag = {
        type: 'obstacle',
        oid: hitObs.id,
        offX: w.x - hitObs.x,
        offY: w.y - hitObs.y,
        moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      renderPerformers();
      draw();
      return;
    }

    var hit = hitTestKey(w.x, w.y);
    if (hit) {
      state.selectedPid = hit.pid;
      state.selectedKey = { pid: hit.pid, index: hit.index };
      state.selectedObstacleId = null;
      state.selectedZoneId = null;
      var p = getPerformer(hit.pid);
      state.drag = {
        type: 'key',
        pid: hit.pid,
        index: hit.index,
        moved: false,
        startKey: Object.assign({}, p.keys[hit.index])
      };
      canvas.setPointerCapture(e.pointerId);
      renderPerformers();
      draw();
    } else if (state.selectedPid) {
      // 空白按下：准备新增走位点（pointerup 未移动则加入）
      state.selectedObstacleId = null;
      state.selectedZoneId = null;
      state.drag = { type: 'new', x: w.x, y: w.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      draw();
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    var w = toWorld(e.clientX, e.clientY);
    var v = view();

    if (state.drag && state.drag.type === 'obs-new') {
      if (Math.abs(w.x - state.drag.x0) * v.sx > 4 || Math.abs(w.y - state.drag.y0) * v.sy > 4) {
        state.drag.moved = true;
      }
      state.drag.x1 = w.x;
      state.drag.y1 = w.y;
      draw();
      return;
    }

    if (state.drag && state.drag.type === 'zone-new') {
      if (Math.abs(w.x - state.drag.x0) * v.sx > 4 || Math.abs(w.y - state.drag.y0) * v.sy > 4) {
        state.drag.moved = true;
      }
      state.drag.x1 = w.x;
      state.drag.y1 = w.y;
      draw();
      return;
    }

    if (state.drag && state.drag.type === 'zone') {
      var z = getZone(state.drag.zid);
      if (!z) return;
      state.drag.moved = true;
      z.x = clamp(Math.round(w.x - state.drag.offX), 0, Math.max(0, WORLD_W - z.width));
      z.y = clamp(Math.round(w.y - state.drag.offY), 0, Math.max(0, WORLD_H - z.height));
      recompute();
      renderZones();
      draw();
      return;
    }

    if (state.drag && state.drag.type === 'obstacle') {
      var o = getObstacle(state.drag.oid);
      if (!o) return;
      state.drag.moved = true;
      o.x = clamp(Math.round(w.x - state.drag.offX), 0, Math.max(0, WORLD_W - o.width));
      o.y = clamp(Math.round(w.y - state.drag.offY), 0, Math.max(0, WORLD_H - o.height));
      recompute();
      draw();
      return;
    }

    if (state.drag && state.drag.type === 'key') {
      state.drag.moved = true;
      var perf = getPerformer(state.drag.pid);
      var key = perf.keys[state.drag.index];
      key.x = clamp(Math.round(w.x), 0, WORLD_W);
      key.y = clamp(Math.round(w.y), 0, WORLD_H);
      recompute();
      draw();
      showTooltip(e, perf, key);
      return;
    }

    if (state.drag && state.drag.type === 'new') {
      if (Math.abs(w.x - state.drag.x) * v.sx > 4 || Math.abs(w.y - state.drag.y) * v.sy > 4) {
        state.drag.moved = true;
      }
      return;
    }

    // 悬停命中提示
    if (state.addObstacleMode || state.addZoneMode) {
      canvas.style.cursor = 'crosshair';
      tooltip.hidden = true;
      return;
    }
    var hoverZone = hitTestZone(w.x, w.y);
    var hoverObs = hitTestObstacle(w.x, w.y);
    var hover = hitTestKey(w.x, w.y);
    if (hoverZone) {
      canvas.style.cursor = 'move';
      var zover = currentCapacityState(state.time)[hoverZone.id];
      var zlabel = hoverZone.name + ' · 限员矩形 (' + Math.round(hoverZone.x) + ', ' +
        Math.round(hoverZone.y) + ') ' + Math.round(hoverZone.width) + '×' + Math.round(hoverZone.height) +
        ' · 上限 ' + hoverZone.limit +
        (zover ? ' · 当前 ' + zover.count + ' 人' + (zover.over ? '（超员）' : '') : ' · 拖动移位 · 右键删除');
      tooltip.hidden = false;
      tooltip.textContent = zlabel;
      positionTooltip(e);
    } else if (hoverObs) {
      canvas.style.cursor = 'move';
      var intruders = currentObstacleIntruders(state.time)[hoverObs.id];
      tooltip.hidden = false;
      tooltip.textContent = hoverObs.name + ' · 禁入矩形 (' + Math.round(hoverObs.x) + ', ' +
        Math.round(hoverObs.y) + ') ' + Math.round(hoverObs.width) + '×' + Math.round(hoverObs.height) +
        (intruders ? ' · 当前侵入 ' + intruders : ' · 拖动移位 · 右键删除');
      positionTooltip(e);
    } else if (hover) {
      canvas.style.cursor = 'grab';
      var hp = getPerformer(hover.pid);
      var hk = hp.keys[hover.index];
      showTooltip(e, hp, hk);
    } else {
      canvas.style.cursor = state.selectedPid ? 'crosshair' : 'default';
      tooltip.hidden = true;
    }
  });

  function positionTooltip(e) {
    var wrapRect = canvas.parentElement.getBoundingClientRect();
    tooltip.style.left = (e.clientX - wrapRect.left) + 'px';
    tooltip.style.top = (e.clientY - wrapRect.top) + 'px';
  }

  canvas.addEventListener('pointerup', function (e) {
    if (!state.drag) return;
    var drag = state.drag;
    if (drag.type === 'obs-new') {
      var w2 = toWorld(e.clientX, e.clientY);
      if (drag.moved) {
        addObstacleRect(drag.x0, drag.y0, w2.x, w2.y);
      } else {
        // 单击：以落点附近为左上角投放默认尺寸矩形（自动收回画布内）
        addObstacleRect(w2.x, w2.y, w2.x + NEW_OBS_SIZE, w2.y + NEW_OBS_SIZE);
      }
    } else if (drag.type === 'zone-new') {
      var wz = toWorld(e.clientX, e.clientY);
      if (drag.moved) {
        addZoneRect(drag.x0, drag.y0, wz.x, wz.y);
      } else {
        // 单击：以落点为中心投放默认尺寸限员矩形（自动收回画布内）
        addZoneRect(wz.x - NEW_ZONE_SIZE / 2, wz.y - NEW_ZONE_SIZE / 2,
          wz.x + NEW_ZONE_SIZE / 2, wz.y + NEW_ZONE_SIZE / 2);
      }
    } else if (drag.type === 'new' && !drag.moved && state.selectedPid) {
      var w3 = toWorld(e.clientX, e.clientY);
      addKey(state.selectedPid, state.time, w3.x, w3.y);
    }
    if (drag.type === 'key') {
      tooltip.hidden = true;
    }
    state.drag = null;
    renderTimelineStatic();
    draw();
  });

  canvas.addEventListener('pointerleave', function () {
    if (!state.drag) tooltip.hidden = true;
  });

  // 双击空白：在当前播放时刻为选中者加帧（与单击新增并存，双击更直观）
  canvas.addEventListener('dblclick', function (e) {
    if (state.addObstacleMode || state.addZoneMode || !state.selectedPid) return;
    var w = toWorld(e.clientX, e.clientY);
    if (hitTestZone(w.x, w.y)) return;
    if (hitTestObstacle(w.x, w.y)) return;
    if (hitTestKey(w.x, w.y)) return;
    addKey(state.selectedPid, state.time, w.x, w.y);
  });

  // 右键圆点：删除该走位点（每人保留至少 1 帧）；右键矩形：删除对应区域
  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var w = toWorld(e.clientX, e.clientY);
    var hitZoneRect = hitTestZone(w.x, w.y);
    if (hitZoneRect) {
      removeZone(hitZoneRect.id);
      return;
    }
    var hitObs = hitTestObstacle(w.x, w.y);
    if (hitObs) {
      removeObstacle(hitObs.id);
      return;
    }
    var hit = hitTestKey(w.x, w.y);
    if (hit) {
      removeKey(hit.pid, hit.index);
    }
  });

  function showTooltip(e, p, k) {
    tooltip.hidden = false;
    var custom = k.r !== null && k.r !== undefined;
    tooltip.textContent = p.name + ' · t=' + k.t.toFixed(1) + 's · (' +
      Math.round(k.x) + ', ' + Math.round(k.y) + ') · 安全半径 ' + keyRadius(p, k) +
      (custom ? '（关键帧）' : '（继承 ' + p.radius + '）');
    positionTooltip(e);
  }

  function addKey(pid, t, x, y) {
    var p = getPerformer(pid);
    if (!p) return;
    var tt = clamp(Math.round(t * 10) / 10, 0, state.duration);
    var xx = clamp(Math.round(x), 0, WORLD_W);
    var yy = clamp(Math.round(y), 0, WORLD_H);

    // 同时刻已存在则移动该帧（保留其安全半径设置）
    var existing = p.keys.findIndex(function (k) { return Math.abs(k.t - tt) < 1e-6; });
    if (existing >= 0) {
      p.keys[existing].x = xx;
      p.keys[existing].y = yy;
      state.selectedKey = { pid: pid, index: existing };
    } else {
      p.keys.push({ t: tt, x: xx, y: yy, r: null });
      p.keys.sort(function (a, b) { return a.t - b.t; });
      state.selectedKey = { pid: pid, index: p.keys.findIndex(function (k) { return Math.abs(k.t - tt) < 1e-6; }) };
    }
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  function removeKey(pid, index) {
    var p = getPerformer(pid);
    if (!p || p.keys.length <= 1) return;
    p.keys.splice(index, 1);
    state.selectedKey = null;
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  // ---------- 选中关键帧：安全半径编辑 ----------
  var keyEditorEl = document.getElementById('key-editor');
  var keInfoEl = document.getElementById('ke-info');
  var keRadiusInput = document.getElementById('ke-radius');
  var keHintEl = document.getElementById('ke-hint');
  var keClearBtn = document.getElementById('ke-clear');

  // 每次重绘同步编辑面板（输入聚焦时不覆盖正在键入的数值）
  function renderKeyEditor() {
    var sel = getSelectedKey();
    if (!sel) {
      keyEditorEl.hidden = true;
      return;
    }
    keyEditorEl.hidden = false;
    var p = sel.p;
    var k = sel.k;
    keInfoEl.textContent = p.name + ' · t=' + k.t.toFixed(1) +
      's · (' + Math.round(k.x) + ', ' + Math.round(k.y) + ')';
    var custom = k.r !== null && k.r !== undefined;
    if (document.activeElement !== keRadiusInput) {
      keRadiusInput.value = custom ? k.r : '';
    }
    keRadiusInput.placeholder = String(p.radius);
    keHintEl.textContent = custom
      ? '本帧占用范围，与相邻关键帧线性插值'
      : '留空 = 继承表演者当前半径 ' + p.radius;
    keClearBtn.disabled = !custom;
  }

  function afterKeyRadiusEdit() {
    recompute();          // 立即刷新碰撞区间
    renderTimelineStatic();
    draw();               // 画布实时呈现新范围
  }

  function commitKeyRadius(live) {
    var sel = getSelectedKey();
    if (!sel) return;
    var raw = String(keRadiusInput.value).trim();
    if (raw === '') {
      // 实时输入时空串不打断键入；失焦提交时恢复继承
      if (!live) {
        sel.k.r = null;
        afterKeyRadiusEdit();
      }
      return;
    }
    var v = Number(raw);
    if (isFinite(v) && v >= 0) {
      sel.k.r = clampRadius(v);
      afterKeyRadiusEdit();
    }
  }

  keRadiusInput.addEventListener('input', function () { commitKeyRadius(true); });
  keRadiusInput.addEventListener('change', function () {
    commitKeyRadius(false);
    var sel = getSelectedKey();
    if (sel && sel.k.r !== null && sel.k.r !== undefined) keRadiusInput.value = sel.k.r;
  });
  keClearBtn.addEventListener('click', function () {
    var sel = getSelectedKey();
    if (!sel) return;
    sel.k.r = null;
    afterKeyRadiusEdit();
  });

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // ---------- 禁入矩形：新增 / 删除 / 编辑 ----------
  var btnObstacle = document.getElementById('btn-obstacle');
  var obstacleEditorEl = document.getElementById('obstacle-editor');
  var oeInfoEl = document.getElementById('oe-info');
  var oeNameInput = document.getElementById('oe-name');
  var oeWidthInput = document.getElementById('oe-width');
  var oeHeightInput = document.getElementById('oe-height');
  var oeDeleteBtn = document.getElementById('oe-delete');

  function setAddObstacleMode(on) {
    state.addObstacleMode = !!on;
    btnObstacle.classList.toggle('active', state.addObstacleMode);
    btnObstacle.textContent = state.addObstacleMode ? '✕ 取消禁入区' : '＋ 禁入区';
    canvas.style.cursor = state.addObstacleMode ? 'crosshair' : '';
    if (on && state.addZoneMode) setAddZoneMode(false);
  }

  btnObstacle.addEventListener('click', function () {
    setAddObstacleMode(!state.addObstacleMode);
  });

  function addObstacleRect(x0, y0, x1, y1) {
    var x = clamp(Math.round(Math.min(x0, x1)), 0, WORLD_W);
    var y = clamp(Math.round(Math.min(y0, y1)), 0, WORLD_H);
    var right = clamp(Math.round(Math.max(x0, x1)), 0, WORLD_W);
    var bottom = clamp(Math.round(Math.max(y0, y1)), 0, WORLD_H);
    var width = right - x;
    var height = bottom - y;
    // 单击或极小拖框：视为默认尺寸，以落点为中心收回画布内
    if (width < 4 || height < 4) {
      width = NEW_OBS_SIZE;
      height = NEW_OBS_SIZE;
      x = clamp(x - Math.round(NEW_OBS_SIZE / 2), 0, WORLD_W - width);
      y = clamp(y - Math.round(NEW_OBS_SIZE / 2), 0, WORLD_H - height);
    }
    var normalized = Core.normalizeObstacles([{ x: x, y: y, width: width, height: height }])[0];
    state.obstacles.push(normalized);
    state.selectedObstacleId = normalized.id;
    state.selectedKey = null;
    setAddObstacleMode(false);
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  function removeObstacle(oid) {
    state.obstacles = state.obstacles.filter(function (o) { return o.id !== oid; });
    if (state.selectedObstacleId === oid) state.selectedObstacleId = null;
    recompute();
    renderTimelineStatic();
    draw();
  }

  function getSelectedObstacle() {
    if (!state.selectedObstacleId) return null;
    return getObstacle(state.selectedObstacleId);
  }

  function renderObstacleEditor() {
    var o = getSelectedObstacle();
    if (!o) {
      obstacleEditorEl.hidden = true;
      return;
    }
    obstacleEditorEl.hidden = false;
    oeInfoEl.textContent = o.name + ' · (' + Math.round(o.x) + ', ' + Math.round(o.y) + ')';
    if (document.activeElement !== oeNameInput) oeNameInput.value = o.name;
    if (document.activeElement !== oeWidthInput) oeWidthInput.value = Math.round(o.width);
    if (document.activeElement !== oeHeightInput) oeHeightInput.value = Math.round(o.height);
  }

  oeNameInput.addEventListener('change', function () {
    var o = getSelectedObstacle();
    if (!o) return;
    o.name = oeNameInput.value.trim() || o.name;
    recompute();
    draw();
  });
  oeNameInput.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

  function commitObstacleSize() {
    var o = getSelectedObstacle();
    if (!o) return;
    var w = Number(oeWidthInput.value);
    var h = Number(oeHeightInput.value);
    // 只提交正在编辑的那一维；留空/非法的一维保持原值
    if (isFinite(w) && w >= 0 && oeWidthInput.value !== '') {
      o.width = clamp(Math.round(w), 0, WORLD_W);
    }
    if (isFinite(h) && h >= 0 && oeHeightInput.value !== '') {
      o.height = clamp(Math.round(h), 0, WORLD_H);
    }
    o.x = clamp(o.x, 0, Math.max(0, WORLD_W - o.width));
    o.y = clamp(o.y, 0, Math.max(0, WORLD_H - o.height));
    recompute();
    draw();
  }
  oeWidthInput.addEventListener('change', commitObstacleSize);
  oeHeightInput.addEventListener('change', commitObstacleSize);
  oeDeleteBtn.addEventListener('click', function () {
    if (state.selectedObstacleId) removeObstacle(state.selectedObstacleId);
  });

  // ---------- 区域限员：新增 / 删除 / 编辑 ----------
  var btnZone = document.getElementById('btn-zone');
  var zoneEditorEl = document.getElementById('zone-editor');
  var zeInfoEl = document.getElementById('ze-info');
  var zeNameInput = document.getElementById('ze-name');
  var zeXInput = document.getElementById('ze-x');
  var zeYInput = document.getElementById('ze-y');
  var zeWidthInput = document.getElementById('ze-width');
  var zeHeightInput = document.getElementById('ze-height');
  var zeLimitInput = document.getElementById('ze-limit');
  var zeDeleteBtn = document.getElementById('ze-delete');

  function setAddZoneMode(on) {
    state.addZoneMode = !!on;
    btnZone.classList.toggle('active', state.addZoneMode);
    btnZone.textContent = state.addZoneMode ? '✕ 取消限员区' : '＋ 限员区';
    canvas.style.cursor = state.addZoneMode ? 'crosshair' : '';
    if (on && state.addObstacleMode) setAddObstacleMode(false);
  }

  btnZone.addEventListener('click', function () {
    setAddZoneMode(!state.addZoneMode);
  });

  // 由画布两对角点新增限员矩形（坐标取整、收回画布内；过小拖框视为单击）
  function addZoneRect(x0, y0, x1, y1) {
    var x = clamp(Math.round(Math.min(x0, x1)), 0, WORLD_W);
    var y = clamp(Math.round(Math.min(y0, y1)), 0, WORLD_H);
    var right = clamp(Math.round(Math.max(x0, x1)), 0, WORLD_W);
    var bottom = clamp(Math.round(Math.max(y0, y1)), 0, WORLD_H);
    var width = right - x;
    var height = bottom - y;
    // 极小拖框：视为默认尺寸，以落点为中心收回画布内
    if (width < 4 || height < 4) {
      width = NEW_ZONE_SIZE;
      height = NEW_ZONE_SIZE;
      x = clamp(x - Math.round(NEW_ZONE_SIZE / 2), 0, WORLD_W - width);
      y = clamp(y - Math.round(NEW_ZONE_SIZE / 2), 0, WORLD_H - height);
    }
    var normalized = Core.normalizeCapacityZones([{
      x: x, y: y, width: width, height: height, limit: ZONE_LIMIT_DEFAULT
    }])[0];
    state.capacityZones.push(normalized);
    state.selectedZoneId = normalized.id;
    state.selectedObstacleId = null;
    state.selectedKey = null;
    setAddZoneMode(false);
    zoneAfterStructuralChange();
  }

  function addZoneDefault() {
    // 面板按钮：在舞台中央附近投放默认尺寸（略微错开避免完全重叠）
    var n = state.capacityZones.length;
    var size = NEW_ZONE_SIZE;
    var x = clamp(Math.round((WORLD_W - size) / 2 + (n % 4) * 24 - 36), 0, WORLD_W - size);
    var y = clamp(Math.round((WORLD_H - size) / 2 + (n % 4) * 24 - 36), 0, WORLD_H - size);
    var normalized = Core.normalizeCapacityZones([{
      x: x, y: y, width: size, height: size, limit: ZONE_LIMIT_DEFAULT
    }])[0];
    state.capacityZones.push(normalized);
    state.selectedZoneId = normalized.id;
    state.selectedObstacleId = null;
    state.selectedKey = null;
    zoneAfterStructuralChange();
  }

  function removeZone(zid) {
    state.capacityZones = state.capacityZones.filter(function (z) { return z.id !== zid; });
    if (state.selectedZoneId === zid) state.selectedZoneId = null;
    zoneAfterStructuralChange();
  }

  function zoneAfterStructuralChange() {
    recompute();
    renderZones();
    draw();
  }

  function getSelectedZone() {
    if (!state.selectedZoneId) return null;
    return getZone(state.selectedZoneId);
  }

  function renderZoneEditor() {
    var z = getSelectedZone();
    if (!z) {
      zoneEditorEl.hidden = true;
      return;
    }
    zoneEditorEl.hidden = false;
    zeInfoEl.textContent = z.name + ' · (' + Math.round(z.x) + ', ' + Math.round(z.y) + ')';
    if (document.activeElement !== zeNameInput) zeNameInput.value = z.name;
    if (document.activeElement !== zeXInput) zeXInput.value = Math.round(z.x);
    if (document.activeElement !== zeYInput) zeYInput.value = Math.round(z.y);
    if (document.activeElement !== zeWidthInput) zeWidthInput.value = Math.round(z.width);
    if (document.activeElement !== zeHeightInput) zeHeightInput.value = Math.round(z.height);
    if (document.activeElement !== zeLimitInput) zeLimitInput.value = z.limit;
  }

  function commitZoneGeometry() {
    var z = getSelectedZone();
    if (!z) return;
    var fields = [
      [zeXInput, 'x'], [zeYInput, 'y'],
      [zeWidthInput, 'width'], [zeHeightInput, 'height']
    ];
    // 只提交正在编辑的字段；留空/非法的字段保持原值
    fields.forEach(function (pair) {
      var input = pair[0];
      var field = pair[1];
      if (input.value === '') return;
      var v = Number(input.value);
      if (!isFinite(v) || v < 0) return;
      v = Math.round(v);
      if (field === 'x') z.x = clamp(v, 0, Math.max(0, WORLD_W - z.width));
      else if (field === 'y') z.y = clamp(v, 0, Math.max(0, WORLD_H - z.height));
      else if (field === 'width') z.width = clamp(v, 0, Math.max(0, WORLD_W - z.x));
      else z.height = clamp(v, 0, Math.max(0, WORLD_H - z.y));
    });
    // 再次规整兜底（保留已生成 id 与 limit）
    state.capacityZones = Core.normalizeCapacityZones(state.capacityZones);
    recompute();
    renderZones();
    draw();
  }

  [zeXInput, zeYInput, zeWidthInput, zeHeightInput].forEach(function (input) {
    input.addEventListener('change', commitZoneGeometry);
  });

  zeLimitInput.addEventListener('change', function () {
    var z = getSelectedZone();
    if (!z) return;
    var v = Number(zeLimitInput.value);
    if (isFinite(v) && v >= 1 && Math.floor(v) === v) {
      z.limit = Math.min(999, Math.floor(v));
      state.capacityZones = Core.normalizeCapacityZones(state.capacityZones);
      recompute();
      renderZones();
      draw();
    } else {
      // 非正整数：回退显示为当前有效值
      zeLimitInput.value = z.limit;
    }
  });

  zeNameInput.addEventListener('change', function () {
    var z = getSelectedZone();
    if (!z) return;
    z.name = zeNameInput.value.trim() || z.name;
    state.capacityZones = Core.normalizeCapacityZones(state.capacityZones);
    recompute();
    renderZones();
    draw();
  });
  zeNameInput.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

  function zoneRowEl(zid) {
    return zoneListEl.querySelector('.zone-row[data-zid="' + zid + '"]') || null;
  }

  // 行内数字输入按出现顺序为 x/y/宽/高/上限，取第 5 个即人数上限
  function zoneLimitInput(rowEl) {
    var nums = rowEl.querySelectorAll('input[type="number"]');
    return nums.length >= 5 ? nums[4] : null;
  }

  zeDeleteBtn.addEventListener('click', function () {
    if (state.selectedZoneId) removeZone(state.selectedZoneId);
  });

  // ---------- 入场口令面板（随表演者选中切换） ----------
  var cuePanelHeadNameEl = document.getElementById('cue-performer-name');
  var cueListEl = document.getElementById('cue-list');
  var cueEmptyEl = document.getElementById('cue-empty');
  var cueAddBtn = document.getElementById('btn-cue-add');
  var CUE_NEW_SIZE = 100; // 新增入口矩形的默认边长

  function cueAfterStructuralChange() {
    recompute();
    renderCues();
    draw();
  }

  // 新增入口：以当前选中者在当前播放时刻的圆心为中心放默认尺寸矩形，
  // 时窗缺省 [0, 总时长]（边界自动收回画布内）
  function addCue() {
    var p = getPerformer(state.selectedPid);
    if (!p) return;
    var st = Core.stateAt(p.keys, state.time, p.radius);
    var size = CUE_NEW_SIZE;
    var x = clamp(Math.round(st.x - size / 2), 0, Math.max(0, WORLD_W - size));
    var y = clamp(Math.round(st.y - size / 2), 0, Math.max(0, WORLD_H - size));
    var normalized = Core.normalizeCues([{
      x: x, y: y, width: size, height: size,
      winStart: 0, winEnd: state.duration
    }], state.duration)[0];
    p.cues = p.cues || [];
    p.cues.push(normalized);
    cueAfterStructuralChange();
  }

  function removeCue(cid) {
    var p = getPerformer(state.selectedPid);
    if (!p) return;
    p.cues = (p.cues || []).filter(function (c) { return c.id !== cid; });
    cueAfterStructuralChange();
  }

  function moveCue(cid, delta) {
    var p = getPerformer(state.selectedPid);
    if (!p) return;
    var i = p.cues.findIndex(function (c) { return c.id === cid; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= p.cues.length) return;
    var tmp = p.cues[i];
    p.cues[i] = p.cues[j];
    p.cues[j] = tmp;
    cueAfterStructuralChange();
  }

  function commitCueEdit(cid, field, rawValue) {
    var p = getPerformer(state.selectedPid);
    if (!p) return;
    var cue = (p.cues || []).find(function (c) { return c.id === cid; });
    if (!cue) return;
    var v = Number(rawValue);
    if (rawValue === '' || !isFinite(v)) return; // 输入中间态/非法：保留原值
    if (field === 'x') {
      cue.x = clamp(Math.round(v), 0, Math.max(0, WORLD_W - cue.width));
    } else if (field === 'y') {
      cue.y = clamp(Math.round(v), 0, Math.max(0, WORLD_H - cue.height));
    } else if (field === 'width') {
      cue.width = clamp(Math.round(v), 0, Math.max(0, WORLD_W - cue.x));
    } else if (field === 'height') {
      cue.height = clamp(Math.round(v), 0, Math.max(0, WORLD_H - cue.y));
    } else if (field === 'winStart' || field === 'winEnd') {
      cue[field] = clamp(Math.round(v * 100) / 100, 0, state.duration);
    }
    // 再次规整以兜底（时窗倒置交换、id 保留）
    p.cues = Core.normalizeCues(p.cues, state.duration);
    recompute();
    draw();
  }

  function cueResultByCid(p, cid) {
    if (!state.analysis) return null;
    var entry = state.analysis.cueResults.find(function (e) { return e.performerId === p.id; });
    if (!entry) return null;
    return entry.results.find(function (r) { return r.cue.id === cid; }) || null;
  }

  // 已触发结果：点击实际触发时刻跳转播放头
  cueListEl.addEventListener('click', function (e) {
    var jumpEl = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('.cue-jump') : null;
    if (jumpEl) {
      var t = Number(jumpEl.getAttribute('data-t'));
      if (isFinite(t)) seek(t);
    }
  });

  function bindCueInput(input, cid, field) {
    input.addEventListener('change', function () {
      commitCueEdit(cid, field, input.value);
      // 规整可能交换了时窗端点：整行重建以显示规整后的值
      renderCues();
    });
  }

  function numInput(value, cid, field, opts) {
    opts = opts || {};
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'cue-num' + (opts.wide ? ' cue-num-wide' : '');
    input.value = value;
    input.step = opts.step || '1';
    if (opts.min !== undefined) input.min = opts.min;
    if (opts.max !== undefined) input.max = opts.max;
    bindCueInput(input, cid, field);
    return input;
  }

  function renderCues() {
    var p = getPerformer(state.selectedPid);
    if (!p) {
      document.getElementById('panel-cues').hidden = true;
      return;
    }
    document.getElementById('panel-cues').hidden = false;
    cuePanelHeadNameEl.textContent = p.name;
    cuePanelHeadNameEl.style.color = p.color;
    cueAddBtn.disabled = false;

    cueListEl.innerHTML = '';
    if (!p.cues || !p.cues.length) {
      cueEmptyEl.hidden = false;
      cueEmptyEl.textContent = '尚无入口口令：点「＋ 新入口」在「' + p.name +
        '」当前圆心处投放一个入口矩形，再逐项改坐标 / 尺寸 / 允许进入时窗。';
      return;
    }
    cueEmptyEl.hidden = true;

    p.cues.forEach(function (cue, i) {
      var row = document.createElement('div');
      row.className = 'cue-row';
      row.dataset.cid = cue.id;

      var head = document.createElement('div');
      head.className = 'cue-row-head';
      var ord = document.createElement('span');
      ord.className = 'cue-ord';
      ord.textContent = cueOrdinal(i + 1);
      var status = document.createElement('span');
      status.className = 'cue-status';

      var moveWrap = document.createElement('span');
      moveWrap.className = 'cue-move';
      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'btn btn-mini cue-nav';
      up.textContent = '↑';
      up.title = '前移（提前执行顺序）';
      up.disabled = i === 0;
      up.addEventListener('click', function (e) { e.stopPropagation(); moveCue(cue.id, -1); });
      var down = document.createElement('button');
      down.type = 'button';
      down.className = 'btn btn-mini cue-nav';
      down.textContent = '↓';
      down.title = '后移（延后执行顺序）';
      down.disabled = i === p.cues.length - 1;
      down.addEventListener('click', function (e) { e.stopPropagation(); moveCue(cue.id, 1); });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-mini cue-del-btn';
      del.textContent = '✕';
      del.title = '删除该入口口令';
      del.addEventListener('click', function (e) { e.stopPropagation(); removeCue(cue.id); });
      moveWrap.appendChild(up);
      moveWrap.appendChild(down);
      moveWrap.appendChild(del);

      head.appendChild(ord);
      head.appendChild(status);
      head.appendChild(moveWrap);

      var fields = document.createElement('div');
      fields.className = 'cue-fields';
      var geo = document.createElement('span');
      geo.className = 'cue-field-group';
      geo.appendChild(label('x'));
      geo.appendChild(numInput(Math.round(cue.x), cue.id, 'x'));
      geo.appendChild(label('y'));
      geo.appendChild(numInput(Math.round(cue.y), cue.id, 'y'));
      geo.appendChild(label('宽'));
      geo.appendChild(numInput(Math.round(cue.width), cue.id, 'width'));
      geo.appendChild(label('高'));
      geo.appendChild(numInput(Math.round(cue.height), cue.id, 'height'));
      var win = document.createElement('span');
      win.className = 'cue-field-group';
      win.appendChild(label('时窗'));
      win.appendChild(numInput(cue.winStart, cue.id, 'winStart', { step: '0.1', min: 0, max: state.duration, wide: true }));
      win.appendChild(document.createTextNode('–'));
      win.appendChild(numInput(cue.winEnd, cue.id, 'winEnd', { step: '0.1', min: 0, max: state.duration, wide: true }));
      win.appendChild(document.createTextNode('s'));
      fields.appendChild(geo);
      fields.appendChild(win);

      row.appendChild(head);
      row.appendChild(fields);
      cueListEl.appendChild(row);
    });
    updateCueStatuses(p);
  }

  function label(text) {
    var el = document.createElement('span');
    el.className = 'cue-label';
    el.textContent = text;
    return el;
  }

  function statusText(res) {
    var actual = res.entries.length
      ? '（实际进入 ' + res.entries.map(function (t) { return fmt(t); }).join(' / ') + 's）'
      : '（全程未进入）';
    if (res.status === 'triggered') {
      return {
        cls: 'cue-status-triggered',
        html: '✓ 已触发 @ <span class="cue-jump" data-t="' + res.triggerT +
          '" title="点击跳转播放头到触发时刻">' + fmt(res.triggerT) + ' s</span>'
      };
    }
    if (res.status === 'missed') {
      return { cls: 'cue-status-missed', html: '✕ 错过时窗' + actual };
    }
    return { cls: 'cue-status-blocked', html: '⛒ 前序未完成' + actual };
  }

  // 只更新状态徽标行（编辑数字时无需整列表重建，避免打断输入）
  function updateCueStatuses(p) {
    if (!p) return;
    Array.prototype.forEach.call(cueListEl.querySelectorAll('.cue-row'), function (row) {
      var res = cueResultByCid(p, row.dataset.cid);
      var statusEl = row.querySelector('.cue-status');
      row.classList.remove('cue-triggered', 'cue-missed', 'cue-blocked');
      if (!res) {
        statusEl.className = 'cue-status';
        statusEl.textContent = '';
        return;
      }
      var st = statusText(res);
      statusEl.className = 'cue-status ' + st.cls;
      statusEl.innerHTML = st.html;
      row.classList.add(
        res.status === 'triggered' ? 'cue-triggered'
          : res.status === 'missed' ? 'cue-missed' : 'cue-blocked'
      );
    });
  }

  // 编辑走位/半径/矩形等外部变更后，由 recompute 调用刷新口令状态文字与颜色
  function renderCueResults() {
    var p = getPerformer(state.selectedPid);
    if (p) updateCueStatuses(p);
  }

  cueAddBtn.addEventListener('click', addCue);

  // ---------- 道具交接面板 ----------
  var handoffListEl = document.getElementById('handoff-list');
  var handoffEmptyEl = document.getElementById('handoff-empty');
  var handoffAddBtn = document.getElementById('btn-handoff-add');
  var HANDOFF_NEW_SIZE = 120;     // 新增交接区的默认边长
  var HANDOFF_NEW_REACH = 60;     // 新增交接的默认触达距离
  var HANDOFF_NEW_DURATION = 1;   // 新增交接的默认最短持续秒数

  function handoffAfterStructuralChange() {
    recompute();
    renderHandoffs();
    draw();
  }

  // 新增交接：默认取当前选中者与下一名表演者，交接区以两人当前圆心
  // 中点为中心放默认尺寸（边界自动收回画布内）
  function addHandoff() {
    if (state.performers.length < 2) return;
    var a = getPerformer(state.selectedPid) || state.performers[0];
    var b = state.performers.filter(function (p) { return p.id !== a.id; })[0];
    if (!b) return;
    var sa = Core.stateAt(a.keys, state.time, a.radius);
    var sb = Core.stateAt(b.keys, state.time, b.radius);
    var size = HANDOFF_NEW_SIZE;
    var x = clamp(Math.round((sa.x + sb.x) / 2 - size / 2), 0, Math.max(0, WORLD_W - size));
    var y = clamp(Math.round((sa.y + sb.y) / 2 - size / 2), 0, Math.max(0, WORLD_H - size));
    var normalized = Core.normalizeHandoffs([{
      aId: a.id,
      bId: b.id,
      x: x,
      y: y,
      width: size,
      height: size,
      reach: HANDOFF_NEW_REACH,
      minDuration: HANDOFF_NEW_DURATION
    }], state.duration)[0];
    state.handoffs.push(normalized);
    handoffAfterStructuralChange();
  }

  function removeHandoff(hid) {
    state.handoffs = state.handoffs.filter(function (h) { return h.id !== hid; });
    handoffAfterStructuralChange();
  }

  function commitHandoffEdit(hid, field, rawValue) {
    var h = state.handoffs.find(function (x) { return x.id === hid; });
    if (!h) return;
    if (field === 'aId' || field === 'bId') {
      h[field] = rawValue;
    } else {
      var v = Number(rawValue);
      if (rawValue === '' || !isFinite(v)) return; // 输入中间态/非法：保留原值
      if (field === 'x') {
        h.x = clamp(Math.round(v), 0, Math.max(0, WORLD_W - h.width));
      } else if (field === 'y') {
        h.y = clamp(Math.round(v), 0, Math.max(0, WORLD_H - h.height));
      } else if (field === 'width') {
        h.width = clamp(Math.round(v), 0, Math.max(0, WORLD_W - h.x));
      } else if (field === 'height') {
        h.height = clamp(Math.round(v), 0, Math.max(0, WORLD_H - h.y));
      } else if (field === 'reach') {
        h.reach = clamp(Math.round(v * 10) / 10, 0, 1000);
      } else if (field === 'minDuration') {
        var d = Math.round(v * 100) / 100;
        if (!(d > 0)) return; // 最短持续秒数必须为正
        h.minDuration = d;
      }
    }
    // 再次规整以兜底（尺寸/触达钳非负、id 保留；aId===bId 由分析层标记无效）
    state.handoffs = Core.normalizeHandoffs(state.handoffs, state.duration);
    recompute();
    renderHandoffs();
    draw();
  }

  function handoffResultById(hid) {
    if (!state.analysis) return null;
    return state.analysis.handoffResults.find(function (r) { return r.handoffId === hid; }) || null;
  }

  // 点击起始时窗芯片：播放头跳到时窗起点（事件委托）
  handoffListEl.addEventListener('click', function (e) {
    var el = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('.handoff-win-chip') : null;
    if (!el || !handoffListEl.contains(el)) return;
    var t = Number(el.getAttribute('data-t'));
    if (isFinite(t)) seek(t);
  });

  function handoffPerformerSelect(h, field) {
    var sel = document.createElement('select');
    sel.className = 'handoff-select';
    state.performers.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.value = h[field];
    if (sel.value !== h[field]) {
      // 引用的表演者已不在场景中：保留原值便于诊断
      var missing = document.createElement('option');
      missing.value = h[field];
      missing.textContent = h[field] + '（已删除）';
      sel.appendChild(missing);
      sel.value = h[field];
    }
    sel.addEventListener('change', function () {
      commitHandoffEdit(h.id, field, sel.value);
    });
    return sel;
  }

  function handoffNumInput(h, field, opts) {
    opts = opts || {};
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'cue-num' + (opts.wide ? ' cue-num-wide' : '');
    input.value = h[field];
    input.step = opts.step || '1';
    if (opts.min !== undefined) input.min = opts.min;
    input.addEventListener('change', function () {
      commitHandoffEdit(h.id, field, input.value);
    });
    return input;
  }

  // 单项交接的结果区内容（可交接区间 + 起始时窗）
  function handoffResultHtml(h, res) {
    if (!res) return '<span class="handoff-warn">—</span>';
    if (!res.valid) {
      return '<span class="handoff-warn">请选择两名不同且存在的表演者</span>';
    }
    if (!res.intervals.length) {
      return '<span class="handoff-warn">全程不同时满足「同处交接区内部 · 间距 ≤ 触达距离」</span>';
    }
    var ivHtml = res.intervals.map(function (iv) {
      return '<span class="iv-chip handoff-iv-chip">' + fmt(iv[0]) + '–' + fmt(iv[1]) + ' s</span>';
    }).join('');
    var winHtml;
    if (res.windows.length) {
      winHtml = res.windows.map(function (w) {
        return '<span class="handoff-win-chip" data-t="' + w[0] +
          '" title="点击跳转播放头到时窗起点 ' + fmt(w[0]) + ' s">' +
          fmt(w[0]) + '–' + fmt(w[1]) + ' s</span>';
      }).join('');
    } else {
      winHtml = '<span class="handoff-warn">区间均不足 ' + fmt(h.minDuration, 2) +
        ' s，无可交接时窗</span>';
    }
    return '<div class="handoff-result-line">可交接区间 ' + ivHtml + '</div>' +
      '<div class="handoff-result-line">起始时窗（持续 ≥ ' + fmt(h.minDuration, 2) +
      ' s）' + winHtml + '</div>';
  }

  // 只更新结果区（拖动走位等高频重算时不重建输入框，避免打断编辑）
  function renderHandoffResults() {
    Array.prototype.forEach.call(handoffListEl.querySelectorAll('.handoff-row'), function (row) {
      var h = state.handoffs.find(function (x) { return x.id === row.dataset.hid; });
      var resultEl = row.querySelector('.handoff-result');
      if (!h || !resultEl) return;
      var res = handoffResultById(h.id);
      resultEl.innerHTML = handoffResultHtml(h, res);
      row.classList.toggle('feasible', !!(res && res.feasible));
    });
  }

  function renderHandoffs() {
    handoffListEl.innerHTML = '';
    if (!state.handoffs.length) {
      handoffEmptyEl.hidden = false;
      handoffEmptyEl.textContent = '尚无交接：点「＋ 新增交接」，再选择两名表演者、' +
        '轴对齐交接区、最大圆心触达距离与最短持续秒数 d。';
      return;
    }
    handoffEmptyEl.hidden = true;

    state.handoffs.forEach(function (h) {
      var row = document.createElement('div');
      row.className = 'handoff-row';
      row.dataset.hid = h.id;

      var head = document.createElement('div');
      head.className = 'handoff-row-head';
      head.appendChild(handoffPerformerSelect(h, 'aId'));
      var times = document.createElement('span');
      times.className = 'handoff-x';
      times.textContent = '×';
      head.appendChild(times);
      head.appendChild(handoffPerformerSelect(h, 'bId'));
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-mini handoff-del';
      del.textContent = '✕';
      del.title = '删除该交接';
      del.addEventListener('click', function () { removeHandoff(h.id); });
      head.appendChild(del);
      row.appendChild(head);

      var fields = document.createElement('div');
      fields.className = 'cue-fields';
      var geo = document.createElement('span');
      geo.className = 'cue-field-group';
      geo.appendChild(label('x'));
      geo.appendChild(handoffNumInput(h, 'x'));
      geo.appendChild(label('y'));
      geo.appendChild(handoffNumInput(h, 'y'));
      geo.appendChild(label('宽'));
      geo.appendChild(handoffNumInput(h, 'width'));
      geo.appendChild(label('高'));
      geo.appendChild(handoffNumInput(h, 'height'));
      var cond = document.createElement('span');
      cond.className = 'cue-field-group';
      cond.appendChild(label('触达'));
      cond.appendChild(handoffNumInput(h, 'reach', { min: 0 }));
      cond.appendChild(label('持续≥'));
      cond.appendChild(handoffNumInput(h, 'minDuration', { step: '0.1', min: 0.1, wide: true }));
      cond.appendChild(document.createTextNode('s'));
      fields.appendChild(geo);
      fields.appendChild(cond);
      row.appendChild(fields);

      var result = document.createElement('div');
      result.className = 'handoff-result';
      row.appendChild(result);

      handoffListEl.appendChild(row);
    });
    renderHandoffResults();
  }

  handoffAddBtn.addEventListener('click', addHandoff);

  // ---------- 区域限员面板 ----------
  var zoneListEl = document.getElementById('zone-list');
  var zoneEmptyEl = document.getElementById('zone-empty');
  var zoneAddBtn = document.getElementById('btn-zone-add');

  function capacityResultById(zid) {
    if (!state.analysis) return null;
    return state.analysis.capacityResults.find(function (r) { return r.zoneId === zid; }) || null;
  }

  // 时刻 t 各限员区的在册状态：{ zoneId: { count, members, over } }（供画布与悬停）
  function currentCapacityState(t) {
    var map = {};
    if (!state.analysis) return map;
    state.analysis.capacityResults.forEach(function (r) {
      // 以成员圆心位置重新做严格内部判定：状态段端点（边界时刻）不计在册，
      // 与引擎"圆心严格在内部"的口径保持一致
      var members = state.performers.filter(function (p) {
        var z = getZone(r.zoneId);
        if (!z || !(z.width > 0 && z.height > 0)) return false;
        var st = Core.stateAt(p.keys, t, p.radius);
        return st.x > z.x + Core.EPS && st.x < z.x + z.width - Core.EPS &&
          st.y > z.y + Core.EPS && st.y < z.y + z.height - Core.EPS;
      }).map(function (p) { return { id: p.id, name: p.name }; });
      var z = getZone(r.zoneId);
      map[r.zoneId] = {
        count: members.length,
        members: members,
        over: !!z && members.length > z.limit
      };
    });
    return map;
  }

  function zoneResultHtml(z, res) {
    if (!res) return '<span class="zone-warn">—</span>';
    if (!(z.width > 0 && z.height > 0)) {
      return '<span class="zone-warn">零宽 / 零高区域没有内部，永不统计</span>';
    }
    var html = '<div class="zone-result-line zone-peak">全程峰值 <b>' + res.peak +
      ' 人</b>' + (res.peakT !== null ? '（自 ' + fmt(res.peakT) + ' s 起）' : '') +
      ' · 上限 ' + z.limit + ' 人</div>';
    if (res.peakMembers.length) {
      html += '<div class="zone-result-line">峰值名单 ' +
        res.peakMembers.map(function (m) {
          return '<span class="zone-member-tag">' + escapeHtml(m.name) + '</span>';
        }).join('') + '</div>';
    }
    if (!res.intervals.length) {
      html += '<div class="zone-result-line"><span class="zone-ok">全程未超员</span></div>';
      return html;
    }
    html += '<div class="zone-result-line">超员时段 ' + res.intervals.length + ' 段：</div>';
    res.intervals.forEach(function (iv) {
      html += '<div class="zone-result-line">' +
        '<span class="zone-over-chip" data-t="' + iv.start +
        '" title="点击跳转播放头到超员起点 ' + fmt(iv.start) + ' s">' +
        fmt(iv.start) + '–' + fmt(iv.end) + ' s</span>' +
        '<b>' + iv.count + ' 人</b>（超 ' + (iv.count - z.limit) + '）：' +
        '<span class="zone-members">' +
        iv.members.map(function (m) {
          var p = getPerformer(m.id);
          return '<span class="zone-member-tag" style="' +
            (p ? 'border-color:' + p.color + '66;color:' + p.color + ';' : '') + '">' +
            escapeHtml(m.name) + '</span>';
        }).join('') +
        '</span></div>';
    });
    return html;
  }

  // 只更新结果区（拖动走位等高频重算时不重建输入框，避免打断编辑）
  function renderZoneResults() {
    Array.prototype.forEach.call(zoneListEl.querySelectorAll('.zone-row'), function (row) {
      var z = state.capacityZones.find(function (x) { return x.id === row.dataset.zid; });
      var resultEl = row.querySelector('.zone-result');
      if (!z || !resultEl) return;
      var res = capacityResultById(z.id);
      resultEl.innerHTML = zoneResultHtml(z, res);
      row.classList.toggle('over', !!(res && res.overcrowded));
      row.classList.toggle('degenerate', !(z.width > 0 && z.height > 0));
    });
  }

  function renderZones() {
    zoneListEl.innerHTML = '';
    if (!state.capacityZones.length) {
      zoneEmptyEl.hidden = false;
      zoneEmptyEl.textContent = '尚无限员区域：点「＋ 新增限员区」（或顶部「＋ 限员区」在画布拖框），' +
        '再逐项改坐标 / 非负宽高 / 正整数人数上限。';
      return;
    }
    zoneEmptyEl.hidden = true;

    state.capacityZones.forEach(function (z) {
      var row = document.createElement('div');
      row.className = 'zone-row';
      row.dataset.zid = z.id;

      var head = document.createElement('div');
      head.className = 'zone-row-head';
      var name = document.createElement('input');
      name.type = 'text';
      name.className = 'zone-name-input';
      name.value = z.name;
      name.title = '限员区域名称';
      name.addEventListener('change', function () {
        z.name = name.value.trim() || z.name;
        state.capacityZones = Core.normalizeCapacityZones(state.capacityZones);
        recompute();
        renderZones();
        draw();
      });
      name.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      head.appendChild(name);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-mini zone-del';
      del.textContent = '✕';
      del.title = '删除该限员区域';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeZone(z.id);
      });
      head.appendChild(del);
      row.appendChild(head);

      var fields = document.createElement('div');
      fields.className = 'cue-fields';
      var geo = document.createElement('span');
      geo.className = 'cue-field-group';
      geo.appendChild(label('x'));
      geo.appendChild(zoneNumInput(z, 'x'));
      geo.appendChild(label('y'));
      geo.appendChild(zoneNumInput(z, 'y'));
      geo.appendChild(label('宽'));
      geo.appendChild(zoneNumInput(z, 'width'));
      geo.appendChild(label('高'));
      geo.appendChild(zoneNumInput(z, 'height'));
      var cap = document.createElement('span');
      cap.className = 'cue-field-group';
      cap.appendChild(label('上限'));
      cap.appendChild(zoneNumInput(z, 'limit', { min: 1, wide: true }));
      cap.appendChild(document.createTextNode('人'));
      fields.appendChild(geo);
      fields.appendChild(cap);
      row.appendChild(fields);

      var result = document.createElement('div');
      result.className = 'zone-result';
      row.appendChild(result);

      row.addEventListener('click', function () {
        state.selectedZoneId = z.id;
        state.selectedObstacleId = null;
        state.selectedKey = null;
        // 只切换选中样式，不重建列表（避免抹掉本次点击事件中的目标节点）
        markSelectedZoneRows();
        draw();
      });

      zoneListEl.appendChild(row);
    });
    renderZoneResults();
    markSelectedZoneRows();
  }

  function markSelectedZoneRows() {
    Array.prototype.forEach.call(zoneListEl.querySelectorAll('.zone-row'), function (row) {
      row.classList.toggle('selected', row.dataset.zid === state.selectedZoneId);
    });
  }

  function zoneNumInput(z, field, opts) {
    opts = opts || {};
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'cue-num' + (opts.wide ? ' cue-num-wide' : '');
    input.value = z[field];
    input.step = '1';
    if (opts.min !== undefined) input.min = opts.min;
    input.addEventListener('change', function () {
      commitZoneField(z.id, field, input.value);
    });
    input.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    return input;
  }

  function commitZoneField(zid, field, rawValue) {
    var z = state.capacityZones.find(function (x) { return x.id === zid; });
    if (!z) return;
    if (rawValue === '') return; // 输入中间态：保留原值
    var v = Number(rawValue);
    if (!isFinite(v)) return;
    if (field === 'x') {
      z.x = clamp(Math.round(v), 0, Math.max(0, WORLD_W - z.width));
    } else if (field === 'y') {
      z.y = clamp(Math.round(v), 0, Math.max(0, WORLD_H - z.height));
    } else if (field === 'width') {
      if (v < 0) return;
      z.width = clamp(Math.round(v), 0, Math.max(0, WORLD_W - z.x));
    } else if (field === 'height') {
      if (v < 0) return;
      z.height = clamp(Math.round(v), 0, Math.max(0, WORLD_H - z.y));
    } else if (field === 'limit') {
      if (!(v >= 1) || Math.floor(v) !== v) {
        // 非正整数人数上限：回退显示为当前有效值（保持事件循环内输入框仍在文档中）
        setTimeout(function () {
          var rowEl = zoneRowEl(zid);
          var input = rowEl ? zoneLimitInput(rowEl) : null;
          if (input) input.value = z.limit;
        }, 0);
        return;
      }
      z.limit = Math.min(999, Math.floor(v));
    }
    state.capacityZones = Core.normalizeCapacityZones(state.capacityZones);
    recompute();
    renderZones();
    draw();
  }

  // 点击超员时段芯片：播放头跳到超员起点（事件委托；芯片点击后继续冒泡到
  // 行仅做选中，不影响跳转）
  zoneListEl.addEventListener('click', function (e) {
    var el = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('.zone-over-chip') : null;
    if (!el || !zoneListEl.contains(el)) return;
    var t = Number(el.getAttribute('data-t'));
    if (isFinite(t)) seek(t);
  });

  // 行内输入框点击不应触发行选中
  Array.prototype.forEach.call(zoneListEl.querySelectorAll('input'), function (input) {
    input.addEventListener('click', function (e) { e.stopPropagation(); });
  });

  zoneAddBtn.addEventListener('click', function () {
    addZoneDefault();
  });

  // ---------- 画布绘制 ----------
  function draw() {
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);
    drawGrid();

    var t = state.time;
    var dangerIds = currentDangerIds(t);
    var obsIntrude = currentObstacleIntruders(t);
    Object.keys(obsIntrude).forEach(function (oid) {
      obsIntrude[oid].forEach(function (pid) { dangerIds[pid] = true; });
    });
    var capState = currentCapacityState(t);
    Object.keys(capState).forEach(function (zid) {
      capState[zid].members.forEach(function (m) {
        if (capState[zid].over) dangerIds[m.id] = true;
      });
    });

    // 路径折线
    state.performers.forEach(function (p) {
      drawPath(p, dangerIds[p.id]);
    });

    // 选中者各关键帧的安全半径盘（开伞/道具占用范围）
    state.performers.forEach(function (p) {
      if (p.id === state.selectedPid) drawKeyRadii(p);
    });

    // 危险区间内：先画碰撞连线与红色半径盘
    drawCollisionLinks(t);

    // 禁入矩形（在关键帧圆点之下、身体盘之下）
    state.obstacles.forEach(function (o) {
      drawObstacle(o, obsIntrude[o.id]);
    });
    drawObstacleDraft();

    // 道具交接区（紫色虚线框，当前处于可交接区间时高亮并连线双方）
    drawHandoffs(t);

    // 区域限员矩形（青色虚线框，当前超员时变红并列出在册人员）
    state.capacityZones.forEach(function (z) {
      drawCapacityZone(z, capState[z.id]);
    });
    drawZoneDraft();

    // 入场口令矩形：只画当前选中表演者（边框颜色 = 触发状态）
    state.performers.forEach(function (p) {
      if (p.id === state.selectedPid) drawCues(p);
    });

    // 关键帧圆点
    state.performers.forEach(function (p) {
      drawKeys(p);
    });

    // 当前身体位置（半径为关键帧半径线性插值后的实时安全半径）
    state.performers.forEach(function (p) {
      var st = Core.stateAt(p.keys, t, p.radius);
      drawBody(p, st, dangerIds[p.id]);
    });

    renderKeyEditor();
    renderObstacleEditor();
    renderZoneEditor();
    updateObstacleResultActive(t);
  }

  function drawGrid() {
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0; x <= WORLD_W; x += 50) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, WORLD_H);
    }
    for (var y = 0; y <= WORLD_H; y += 50) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(WORLD_W, y + 0.5);
    }
    ctx.stroke();

    // 舞台边框
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, WORLD_W - 2, WORLD_H - 2);
  }

  function dim(color, alpha) {
    // #rrggbb -> rgba
    var n = parseInt(color.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function drawPath(p, danger) {
    if (p.keys.length === 0) return;
    var ks = Core.normalizeKeys(p.keys);
    var isSel = p.id === state.selectedPid;
    ctx.strokeStyle = dim(p.color, isSel ? 0.95 : 0.5);
    ctx.lineWidth = isSel ? 3 : 2;
    ctx.setLineDash(isSel ? [] : [7, 6]);
    ctx.beginPath();
    ks.forEach(function (k, i) {
      if (i === 0) ctx.moveTo(k.x, k.y);
      else ctx.lineTo(k.x, k.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // 已经走过的轨迹加亮
    if (ks.length >= 2) {
      ctx.strokeStyle = dim(p.color, 0.28);
      ctx.lineWidth = isSel ? 7 : 5;
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < ks.length - 1; i++) {
        var a = ks[i], b = ks[i + 1];
        if (t_between(state.time, a.t, b.t)) {
          var cur = Core.positionAt(ks, state.time);
          if (!started) { ctx.moveTo(a.x, a.y); started = true; }
          ctx.lineTo(cur.x, cur.y);
        } else if (b.t <= state.time) {
          if (!started) { ctx.moveTo(a.x, a.y); started = true; }
          ctx.lineTo(b.x, b.y);
        }
      }
      ctx.stroke();
    }
    if (danger) {
      ctx.strokeStyle = 'rgba(248,81,73,0.9)';
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.beginPath();
      ks.forEach(function (k, i) {
        if (i === 0) ctx.moveTo(k.x, k.y);
        else ctx.lineTo(k.x, k.y);
      });
      ctx.stroke();
    }
  }

  function t_between(t, a, b) {
    return t >= a && t <= b;
  }

  // 选中表演者各关键帧的安全半径盘：自定义半径实线标注，继承半径虚线淡显
  function drawKeyRadii(p) {
    p.keys.forEach(function (k, i) {
      var custom = k.r !== null && k.r !== undefined;
      var rr = keyRadius(p, k);
      var selected = state.selectedKey &&
        state.selectedKey.pid === p.id && state.selectedKey.index === i;
      ctx.beginPath();
      ctx.arc(k.x, k.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = dim(p.color, custom ? (selected ? 0.14 : 0.08) : 0.04);
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = custom
        ? dim(p.color, selected ? 0.95 : 0.6)
        : 'rgba(255,255,255,0.18)';
      ctx.setLineDash(custom ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  function drawKeys(p) {
    var isSel = p.id === state.selectedPid;
    p.keys.forEach(function (k, i) {
      var selected = state.selectedKey &&
        state.selectedKey.pid === p.id && state.selectedKey.index === i;
      ctx.beginPath();
      ctx.arc(k.x, k.y, selected ? 8 : (isSel ? 6.5 : 5), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.7)';
      ctx.stroke();

      // 时刻标签（选中者）；自定义安全半径附加标注
      if (isSel) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(230,237,243,0.85)';
        var label = k.t.toFixed(1) + 's';
        if (k.r !== null && k.r !== undefined) label += ' r' + k.r;
        ctx.fillText(label, k.x + 9, k.y - 8);
      }
    });
  }

  function drawBody(p, st, danger) {
    var r = st.r;
    // 身体安全半径盘（播放时随关键帧半径线性张开/收拢）
    ctx.beginPath();
    ctx.arc(st.x, st.y, r, 0, Math.PI * 2);
    ctx.fillStyle = dim(p.color, danger ? 0.32 : 0.16);
    ctx.fill();
    ctx.lineWidth = danger ? 3 : 2;
    ctx.strokeStyle = danger ? '#f85149' : dim(p.color, 0.9);
    ctx.stroke();

    // 圆心
    ctx.beginPath();
    ctx.arc(st.x, st.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = '#0a0d12';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 名牌
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = danger ? '#ff8f8a' : 'rgba(230,237,243,0.95)';
    ctx.fillText(p.name, st.x + r + 6, st.y - r - 4);
  }

  function currentDangerIds(t) {
    var map = {};
    if (!state.analysis) return map;
    state.analysis.pairs.forEach(function (pair) {
      if (!pair.collision) return;
      if (Core.isPerformerInCollision(pair, pair.aId, t)) {
        map[pair.aId] = true;
        map[pair.bId] = true;
      }
    });
    return map;
  }

  // 时刻 t 各禁入矩形的当前侵入者：{ obstacleId: [performerId...] }
  function currentObstacleIntruders(t) {
    var map = {};
    if (!state.analysis) return map;
    state.analysis.obstacleConflicts.forEach(function (entry) {
      if (Core.isPerformerInObstacle(entry, entry.performerId, t)) {
        (map[entry.obstacleId] = map[entry.obstacleId] || []).push(entry.performerId);
      }
    });
    return map;
  }

  // ---------- 禁入矩形绘制 ----------
  function drawObstacle(o, intruderIds) {
    var intruding = intruderIds && intruderIds.length > 0;
    var selected = o.id === state.selectedObstacleId;
    ctx.save();
    ctx.fillStyle = intruding ? 'rgba(248,81,73,0.20)' : 'rgba(139,152,165,0.13)';
    ctx.fillRect(o.x, o.y, o.width, o.height);

    // 斜纹（禁入语义）
    ctx.save();
    ctx.beginPath();
    ctx.rect(o.x, o.y, o.width, o.height);
    ctx.clip();
    ctx.strokeStyle = intruding ? 'rgba(248,81,73,0.28)' : 'rgba(139,152,165,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    for (var d = -o.height; d < o.width; d += 16) {
      ctx.beginPath();
      ctx.moveTo(o.x + d, o.y);
      ctx.lineTo(o.x + d + o.height, o.y + o.height);
      ctx.stroke();
    }
    ctx.restore();

    ctx.setLineDash(intruding ? [] : [8, 5]);
    ctx.lineWidth = intruding ? 3 : (selected ? 2.5 : 2);
    ctx.strokeStyle = intruding ? '#f85149' : (selected ? '#58a6ff' : 'rgba(190,200,212,0.75)');
    ctx.strokeRect(o.x + 0.5, o.y + 0.5, Math.max(0, o.width - 1), Math.max(0, o.height - 1));
    ctx.setLineDash([]);

    // 名称与当前侵入标注
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = intruding ? '#ff8f8a' : 'rgba(230,237,243,0.9)';
    var label = o.name;
    ctx.fillText(label, o.x + 8, o.y + 18);
    if (intruding) {
      var names = intruderIds.map(function (pid) {
        var p = getPerformer(pid);
        return p ? p.name : pid;
      }).join('、');
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#ffb3ae';
      ctx.fillText('⚠ 侵入：' + names, o.x + 8, o.y + o.height - 8);
    }
    ctx.restore();
  }

  // 新增禁入区拖框预览
  function drawObstacleDraft() {
    if (!state.drag || state.drag.type !== 'obs-new') return;
    var d = state.drag;
    var x = Math.min(d.x0, d.x1);
    var y = Math.min(d.y0, d.y1);
    var w = Math.abs(d.x1 - d.x0);
    var h = Math.abs(d.y1 - d.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(88,166,255,0.14)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---------- 区域限员矩形绘制 ----------
  function drawCapacityZone(z, cap) {
    var over = !!(cap && cap.over);
    var selected = z.id === state.selectedZoneId;
    var degenerate = !(z.width > 0 && z.height > 0);
    ctx.save();
    ctx.fillStyle = over ? 'rgba(248,81,73,0.20)'
      : (cap && cap.count > 0) ? 'rgba(45,212,191,0.12)' : 'rgba(45,212,191,0.06)';
    ctx.fillRect(z.x, z.y, z.width, z.height);

    ctx.setLineDash(over ? [] : [8, 5]);
    ctx.lineWidth = over ? 3 : (selected ? 2.5 : 1.5);
    ctx.strokeStyle = over ? '#f85149'
      : selected ? '#5eead4' : 'rgba(45,212,191,0.8)';
    ctx.strokeRect(z.x + 0.5, z.y + 0.5, Math.max(0, z.width - 1), Math.max(0, z.height - 1));
    ctx.setLineDash([]);

    // 名称与上限 / 当前人数
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = over ? '#ff8f8a' : '#99f6e4';
    var label = '▦ ' + z.name + ' · 上限 ' + z.limit +
      (cap ? ' · 当前 ' + cap.count + ' 人' : '');
    ctx.fillText(label, z.x + 8, z.y + 18);
    if (degenerate) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#e3b341';
      ctx.fillText('⚠ 零宽/高：没有内部，永不统计', z.x + 8, z.y + (z.height > 20 ? z.height - 8 : 34));
    } else if (over) {
      var names = cap.members.map(function (m) {
        var p = getPerformer(m.id);
        return p ? p.name : m.name;
      }).join('、');
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#ffb3ae';
      ctx.fillText('⚠ 超员 ' + cap.count + '（限 ' + z.limit + '）：' + names,
        z.x + 8, z.y + z.height - 8);
    }
    ctx.restore();
  }

  // 新增限员区拖框预览
  function drawZoneDraft() {
    if (!state.drag || state.drag.type !== 'zone-new') return;
    var d = state.drag;
    var x = Math.min(d.x0, d.x1);
    var y = Math.min(d.y0, d.y1);
    var w = Math.abs(d.x1 - d.x0);
    var h = Math.abs(d.y1 - d.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(45,212,191,0.14)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---------- 道具交接区绘制 ----------
  function drawHandoffs(t) {
    if (!state.handoffs.length) return;
    var results = {};
    if (state.analysis) {
      state.analysis.handoffResults.forEach(function (r) { results[r.handoffId] = r; });
    }
    state.handoffs.forEach(function (h) {
      var res = results[h.id];
      var active = !!(res && Core.isHandoffActive(res, t));
      ctx.save();
      // 交接区矩形：淡紫填充 + 紫色虚线边框（与禁入区斜纹、口令状态色区分）
      ctx.fillStyle = active ? 'rgba(192,132,252,0.18)' : 'rgba(192,132,252,0.07)';
      ctx.fillRect(h.x, h.y, h.width, h.height);
      ctx.strokeStyle = active ? '#d8b4fe' : 'rgba(192,132,252,0.75)';
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(h.x + 0.5, h.y + 0.5, Math.max(0, h.width - 1), Math.max(0, h.height - 1));
      ctx.setLineDash([]);

      // 标签：双方名字 + 触达/持续参数；激活时标注
      var pa = getPerformer(h.aId);
      var pb = getPerformer(h.bId);
      var labelText = '⇄ 交接 ' + (pa ? pa.name : h.aId) + '×' + (pb ? pb.name : h.bId);
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillStyle = active ? '#e9d5ff' : 'rgba(216,180,254,0.85)';
      ctx.fillText(labelText, h.x + 6, h.y + h.height - 8);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText('触达 ' + h.reach + ' · 持续≥' + h.minDuration + 's' +
        (active ? ' · 交接窗口内' : ''), h.x + 6, h.y + 14);

      // 当前处于可交接区间：用紫色虚线连接双方圆心并标注实时间距
      if (active && pa && pb) {
        var sa = Core.stateAt(pa.keys, t, pa.radius);
        var sb = Core.stateAt(pb.keys, t, pb.radius);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.strokeStyle = 'rgba(216,180,254,0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        var d = Math.hypot(sa.x - sb.x, sa.y - sb.y);
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillStyle = '#e9d5ff';
        ctx.fillText('间距 ' + d.toFixed(1) + ' / 触达 ' + h.reach,
          (sa.x + sb.x) / 2 + 6, (sa.y + sb.y) / 2 - 6);
      }
      ctx.restore();
    });
  }

  // ---------- 入场口令绘制（只画选中者） ----------
  var CUE_COLORS = {
    triggered: '#3fb950',
    missed: '#f85149',
    blocked: '#d29922'
  };

  function cueStatusMap(p) {
    var map = {};
    if (!state.analysis) return map;
    var entry = state.analysis.cueResults.find(function (e) { return e.performerId === p.id; });
    if (entry) {
      entry.results.forEach(function (r) { map[r.cue.id] = r; });
    }
    return map;
  }

  function drawCues(p) {
    if (!p.cues || !p.cues.length) return;
    var statuses = cueStatusMap(p);
    p.cues.forEach(function (cue, i) {
      var res = statuses[cue.id];
      var color = res ? CUE_COLORS[res.status] : '#8b98a5';
      ctx.save();
      // 入口矩形：淡填充 + 状态色实线边框（与禁入区斜纹区分）
      ctx.fillStyle = res && res.status === 'triggered' ? 'rgba(63,185,80,0.10)'
        : res && res.status === 'missed' ? 'rgba(248,81,73,0.09)'
        : res && res.status === 'blocked' ? 'rgba(210,153,34,0.09)'
        : 'rgba(139,152,165,0.08)';
      ctx.fillRect(cue.x, cue.y, cue.width, cue.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([9, 5]);
      ctx.strokeRect(cue.x + 0.5, cue.y + 0.5, Math.max(0, cue.width - 1), Math.max(0, cue.height - 1));
      ctx.setLineDash([]);

      // 左上角序号徽标
      ctx.font = 'bold 10px system-ui, sans-serif';
      var tag = cueOrdinal(i + 1);
      var tw = ctx.measureText(tag).width + 9;
      ctx.fillStyle = color;
      ctx.fillRect(cue.x, cue.y, tw, 14);
      ctx.fillStyle = '#0a0d12';
      ctx.fillText(tag, cue.x + 4.5, cue.y + 10.5);

      // 已触发：在实际进入位置画状态色圆点
      if (res && res.status === 'triggered' && res.triggerT !== null) {
        var pos = Core.positionAt(Core.normalizeKeys(p.keys), res.triggerT);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0a0d12';
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  function cueOrdinal(n) {
    // ①…⑳ 足够口令数量；超出退回数字
    var circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
      '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
    return n >= 1 && n <= circled.length ? circled[n - 1] : '#' + n;
  }

  function drawCollisionLinks(t) {
    if (!state.analysis) return;
    state.analysis.pairs.forEach(function (pair) {
      if (!Core.isPerformerInCollision(pair, pair.aId, t)) return;
      var pa = getPerformer(pair.aId);
      var pb = getPerformer(pair.bId);
      if (!pa || !pb) return;
      var paSt = Core.stateAt(pa.keys, t, pa.radius);
      var pbSt = Core.stateAt(pb.keys, t, pb.radius);
      ctx.beginPath();
      ctx.moveTo(paSt.x, paSt.y);
      ctx.lineTo(pbSt.x, pbSt.y);
      ctx.strokeStyle = 'rgba(248,81,73,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      var d = Math.hypot(paSt.x - pbSt.x, paSt.y - pbSt.y);
      var gap = d - paSt.r - pbSt.r;
      var mx = (paSt.x + pbSt.x) / 2;
      var my = (paSt.y + pbSt.y) / 2;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillStyle = '#ff8f8a';
      ctx.fillText('间距 ' + d.toFixed(1) + ' / 半径和 ' + (paSt.r + pbSt.r).toFixed(0) +
        '（侵入 ' + Math.max(0, -gap).toFixed(1) + '）', mx + 6, my - 6);
    });
  }

  // ---------- 表演者侧栏 ----------
  function renderPerformers() {
    var box = document.getElementById('performers');
    box.innerHTML = '';
    state.performers.forEach(function (p, idx) {
      var row = document.createElement('div');
      row.className = 'performer-item' + (p.id === state.selectedPid ? ' selected' : '');

      var dot = document.createElement('span');
      dot.className = 'performer-dot';
      dot.style.background = p.color;

      var name = document.createElement('input');
      name.className = 'performer-name';
      name.value = p.name;
      name.addEventListener('change', function () {
        p.name = name.value.trim() || ('表演者' + (idx + 1));
        recompute();
        renderPairs();
      });
      name.addEventListener('click', function (e) { e.stopPropagation(); });
      name.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

      var radiusWrap = document.createElement('span');
      radiusWrap.style.display = 'flex';
      radiusWrap.style.alignItems = 'center';
      radiusWrap.style.gap = '3px';
      var rInput = document.createElement('input');
      rInput.className = 'performer-radius';
      rInput.type = 'number';
      rInput.min = '0';
      rInput.max = '150';
      rInput.step = '1';
      rInput.value = p.radius;
      rInput.title = '身体半径（世界单位）';
      rInput.addEventListener('change', function () {
        p.radius = clampRadius(Number(rInput.value));
        rInput.value = p.radius;
        recompute();
        renderTimelineStatic();
        draw();
      });
      rInput.addEventListener('click', function (e) { e.stopPropagation(); });
      rInput.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      radiusWrap.appendChild(rInput);

      var del = document.createElement('button');
      del.className = 'performer-del';
      del.textContent = '✕';
      del.title = '删除该表演者（至少保留 2 人）';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removePerformer(p.id);
      });

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(radiusWrap);
      row.appendChild(del);
      row.addEventListener('click', function () {
        state.selectedPid = p.id;
        state.selectedKey = null;
        state.selectedZoneId = null;
        state.selectedObstacleId = null;
        renderPerformers();
        renderTimelineStatic();
        draw();
      });
      box.appendChild(row);
    });

    document.getElementById('btn-add').disabled = state.performers.length >= 8;
    renderCues();
    renderHandoffs();
    renderZones();
  }

  function addPerformer() {
    if (state.performers.length >= 8) return;
    var idx = state.performers.length;
    var np = {
      id: uid(),
      name: '表演者' + (idx + 1),
      color: COLORS[idx % COLORS.length],
      radius: 20,
      cues: [],
      keys: [
        { t: 0, x: 80 + idx * 60, y: 80 + idx * 40, r: null },
        { t: state.duration, x: WORLD_W - 80 - idx * 40, y: WORLD_H - 80 - idx * 30, r: null }
      ]
    };
    state.performers.push(np);
    state.selectedPid = np.id;
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  function removePerformer(pid) {
    if (state.performers.length <= 2) return;
    state.performers = state.performers.filter(function (p) { return p.id !== pid; });
    // 引用该表演者的交接一并移除
    state.handoffs = state.handoffs.filter(function (h) {
      return h.aId !== pid && h.bId !== pid;
    });
    if (state.selectedPid === pid) {
      state.selectedPid = state.performers[0].id;
      state.selectedKey = null;
    }
    state.activePairKey = null;
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  // ---------- 摘要与逐对结果 ----------
  function fmt(v, d) {
    return (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d);
  }

  function pairKey(pair) {
    return pair.aId + '|' + pair.bId;
  }

  function renderSummary() {
    var a = state.analysis;
    var firstEl = document.getElementById('sum-first');
    var firstWho = document.getElementById('sum-first-who');
    var minEl = document.getElementById('sum-min');
    var minWho = document.getElementById('sum-min-who');
    var marginEl = document.getElementById('sum-margin');
    var marginWho = document.getElementById('sum-margin-who');

    if (a.firstContact === null) {
      firstEl.textContent = '无碰撞';
      firstEl.className = 'ok';
      firstWho.textContent = '—';
    } else {
      firstEl.textContent = fmt(a.firstContact) + ' s';
      firstEl.className = 'danger';
      var fp = a.pairs.find(function (p) {
        return p.aId === a.firstContactPair[0] && p.bId === a.firstContactPair[1];
      });
      firstWho.textContent = fp ? fp.aName + ' × ' + fp.bName : '—';
      firstWho.style.color = 'var(--danger)';
    }

    minEl.textContent = fmt(a.minDistance) + ' 单位';
    minEl.className = a.firstContact !== null ? 'danger' : 'ok';
    var cp = a.pairs.find(function (p) {
      return p.aId === a.minDistancePair[0] && p.bId === a.minDistancePair[1];
    });
    minWho.textContent = (cp ? cp.aName + ' × ' + cp.bName + ' @ ' + fmt(a.minDistanceT) + 's' : '—');

    // 全局最小安全余量：distance(t) - (rA+rB) 的连续最小值（≤0 即存在碰撞）
    marginEl.textContent = fmt(a.minMargin) + ' 单位';
    marginEl.className = a.minMargin !== null && a.minMargin <= 0 ? 'danger' : 'ok';
    var mp = a.minMarginPair && a.pairs.find(function (p) {
      return p.aId === a.minMarginPair[0] && p.bId === a.minMarginPair[1];
    });
    marginWho.textContent = mp ? mp.aName + ' × ' + mp.bName + ' @ ' + fmt(a.minMarginT) + 's' : '—';
    marginWho.style.color = a.minMargin !== null && a.minMargin <= 0 ? 'var(--danger)' : '';
  }

  function renderPairs() {
    var box = document.getElementById('pairs');
    box.innerHTML = '';
    if (!state.analysis) return;

    // 与核心引擎 / /api/analyze 同一顺序：按最小安全余量升序（越小越危险）
    var ordered = state.analysis.pairs.slice().sort(function (a, b) {
      return a.minMargin - b.minMargin;
    });

    function radiusSumText(pair) {
      if (Math.abs(pair.radiusSumMax - pair.radiusSumMin) < 1e-6) {
        return '半径和 ' + fmt(pair.radiusSum, 0);
      }
      return '半径和 ' + fmt(pair.radiusSumMin, 0) + '～' + fmt(pair.radiusSumMax, 0);
    }

    // 最小安全余量 + 可点击的发生时刻（点击跳转播放头）
    function marginHtml(pair) {
      return '最小余量 <b>' + fmt(pair.minMargin) + '</b> @ ' +
        '<span class="t-jump" data-t="' + pair.minMarginT + '" title="点击跳转播放头到该时刻">' +
        fmt(pair.minMarginT) + ' s</span>';
    }

    ordered.forEach(function (pair) {
      var pa = getPerformer(pair.aId);
      var pb = getPerformer(pair.bId);
      var row = document.createElement('div');
      row.className = 'pair-row' + (pair.collision ? ' danger' : ' safe');
      if (state.activePairKey === pairKey(pair)) row.classList.add('selected');

      var badge = document.createElement('div');
      badge.className = 'pair-badge';
      badge.innerHTML =
        '<span class="mini-dot" style="background:' + pa.color + '"></span>' +
        escapeHtml(pa.name) +
        '<span style="color:var(--text-dim)">×</span>' +
        '<span class="mini-dot" style="background:' + pb.color + '"></span>' +
        escapeHtml(pb.name);

      var status = document.createElement('div');
      status.className = 'pair-status';
      if (pair.collision) {
        var chips = pair.intervals.map(function (iv) {
          return '<span class="iv-chip">' + fmt(iv[0]) + ' – ' + fmt(iv[1]) + ' s</span>';
        }).join('');
        status.innerHTML =
          '<b>碰撞</b> · 首碰 <b>' + fmt(pair.firstContact) + '</b> s · 共 ' +
          pair.intervals.length + ' 段' +
          '<div class="interval-chips">' + chips + '</div>' +
          marginHtml(pair) +
          ' · 最小间距 <b>' + fmt(pair.minDistance) + '</b> @ ' + fmt(pair.minDistanceT) + 's · ' + radiusSumText(pair);
      } else {
        status.innerHTML =
          '<b>安全</b> · ' + marginHtml(pair) +
          ' · 最小间距 <b>' + fmt(pair.minDistance) + '</b> @ ' +
          fmt(pair.minDistanceT) + 's（' + radiusSumText(pair) + '）';
      }

      row.appendChild(badge);
      row.appendChild(status);
      // 点击最小余量时刻：播放头跳转到该时刻并刷新画布
      Array.prototype.forEach.call(row.querySelectorAll('.t-jump'), function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          seek(Number(el.getAttribute('data-t')));
        });
      });
      row.addEventListener('click', function () {
        state.activePairKey = state.activePairKey === pairKey(pair) ? null : pairKey(pair);
        renderPairs();
      });
      box.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 禁入区侵入结果 ----------
  function renderObstacleResults() {
    var panel = document.getElementById('panel-obstacles');
    var box = document.getElementById('obstacle-results');
    box.innerHTML = '';
    if (!state.analysis || !state.obstacles.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    state.analysis.obstacleConflicts.forEach(function (entry) {
      var p = getPerformer(entry.performerId);
      var row = document.createElement('div');
      row.className = 'obs-row ' + (entry.conflict ? 'danger' : 'safe');
      row.dataset.pid = entry.performerId;
      row.dataset.oid = entry.obstacleId;

      var badge = document.createElement('div');
      badge.className = 'pair-badge';
      badge.innerHTML =
        '<span class="mini-dot" style="background:' + (p ? p.color : '#888') + '"></span>' +
        escapeHtml(entry.performerName) +
        '<span style="color:var(--text-dim)">▣</span>' +
        '<span class="obs-name">' + escapeHtml(entry.obstacleName) + '</span>';

      var status = document.createElement('div');
      status.className = 'pair-status';
      if (entry.conflict) {
        var chips = entry.intervals.map(function (iv) {
          return '<span class="iv-chip obs-chip t-jump" data-t="' + iv[0] +
            '" title="点击跳到进入时刻 ' + fmt(iv[0]) + 's">' +
            fmt(iv[0]) + ' – ' + fmt(iv[1]) + ' s</span>';
        }).join('');
        status.innerHTML =
          '<b>侵入</b> · 首次进入 <span class="t-jump" data-t="' + entry.firstEntry +
          '" title="点击跳到进入时刻"><b>' + fmt(entry.firstEntry) + '</b> s</span> · 共 ' +
          entry.intervals.length + ' 段' +
          '<div class="interval-chips">' + chips + '</div>';
      } else {
        status.innerHTML = '<b>安全</b> · 轨迹与实时半径全程不进入该禁入区';
      }

      row.appendChild(badge);
      row.appendChild(status);
      // 点击整行（含区间/首入时刻）跳到首次进入时刻
      if (entry.conflict) {
        row.addEventListener('click', function () {
          seek(entry.firstEntry);
        });
      }
      box.appendChild(row);
    });
    updateObstacleResultActive(state.time);
  }

  // 播放头移动时高亮当前正在侵入的结果行
  function updateObstacleResultActive(t) {
    if (!state.analysis) return;
    var box = document.getElementById('obstacle-results');
    state.analysis.obstacleConflicts.forEach(function (entry) {
      var row = box.querySelector(
        '.obs-row[data-pid="' + entry.performerId + '"][data-oid="' + entry.obstacleId + '"]');
      if (!row) return;
      row.classList.toggle('active-now', Core.isPerformerInObstacle(entry, entry.performerId, t));
    });
  }

  // ---------- 时间轴 ----------
  var timelineEl = document.getElementById('timeline');
  var lanesEl = document.getElementById('timeline-lanes');
  var rulerEl = document.getElementById('timeline-ruler');
  var playheadEl = document.getElementById('playhead');

  function tToX(t, laneWidth) {
    return (t / state.duration) * laneWidth;
  }
  function xToT(x, laneWidth) {
    return clamp(x / laneWidth * state.duration, 0, state.duration);
  }
  function laneWidth() {
    return lanesEl.clientWidth || 1;
  }

  function renderTimelineStatic() {
    // 刻度
    rulerEl.innerHTML = '';
    var step = state.duration <= 15 ? 1 : state.duration <= 30 ? 2 : state.duration <= 60 ? 5 : 10;
    for (var tt = 0; tt <= state.duration + 1e-6; tt += step) {
      (function (t) {
        var tick = document.createElement('span');
        tick.className = 'tick';
        tick.textContent = t;
        tick.style.left = (t / state.duration * 100) + '%';
        rulerEl.appendChild(tick);
      })(Math.round(tt * 10) / 10);
    }

    // 每人一条泳道（关键帧时刻柄）
    lanesEl.innerHTML = '';
    state.performers.forEach(function (p) {
      var lane = document.createElement('div');
      lane.className = 'tl-lane';
      lane.dataset.pid = p.id;

      p.keys.forEach(function (k, i) {
        var dot = document.createElement('div');
        dot.className = 'tl-key';
        if (k.r !== null && k.r !== undefined) dot.classList.add('custom');
        dot.style.background = p.color;
        dot.style.left = (k.t / state.duration * 100) + '%';
        if (state.selectedKey && state.selectedKey.pid === p.id && state.selectedKey.index === i) {
          dot.classList.add('selected');
        }
        var custom = k.r !== null && k.r !== undefined;
        dot.title = p.name + ' t=' + k.t.toFixed(1) + 's（拖动改时刻）' +
          (custom ? ' · 安全半径 ' + k.r : ' · 半径继承 ' + p.radius);
        dot.addEventListener('pointerdown', function (e) {
          e.stopPropagation();
          state.selectedPid = p.id;
          state.selectedKey = { pid: p.id, index: i };
          renderPerformers();
          draw();
          state.drag = {
            type: 'tick',
            pid: p.id,
            index: i,
            moved: false
          };
          dot.setPointerCapture(e.pointerId);
        });
        lane.appendChild(dot);
      });
      lanesEl.appendChild(lane);
    });

    renderTimelineDanger();
    updatePlayhead();
  }

  function renderTimelineDanger() {
    // 移除旧危险条再按分析结果重绘
    Array.prototype.forEach.call(lanesEl.querySelectorAll('.tl-danger'), function (el) {
      el.remove();
    });
    if (!state.analysis) return;
    var lw = laneWidth();

    state.analysis.pairs.forEach(function (pair) {
      if (!pair.collision) return;
      var laneA = lanesEl.querySelector('.tl-lane[data-pid="' + pair.aId + '"]');
      var laneB = lanesEl.querySelector('.tl-lane[data-pid="' + pair.bId + '"]');
      [laneA, laneB].forEach(function (lane) {
        if (!lane) return;
        pair.intervals.forEach(function (iv) {
          var bar = document.createElement('div');
          bar.className = 'tl-danger';
          bar.style.left = tToX(iv[0], lw) + 'px';
          bar.style.width = Math.max(2, tToX(iv[1] - iv[0], lw)) + 'px';
          bar.title = pair.aName + ' × ' + pair.bName + ' 碰撞 ' + iv[0].toFixed(2) + '–' + iv[1].toFixed(2) + 's';
          lane.appendChild(bar);
        });
      });
    });

    // 禁入矩形侵入：当事人泳道叠加琥珀色条（点击跳到进入时刻）
    state.analysis.obstacleConflicts.forEach(function (entry) {
      if (!entry.conflict) return;
      var lane = lanesEl.querySelector('.tl-lane[data-pid="' + entry.performerId + '"]');
      if (!lane) return;
      entry.intervals.forEach(function (iv) {
        var bar = document.createElement('div');
        bar.className = 'tl-danger tl-obstacle t-jump';
        bar.style.left = tToX(iv[0], lw) + 'px';
        bar.style.width = Math.max(2, tToX(iv[1] - iv[0], lw)) + 'px';
        bar.title = entry.performerName + ' 侵入「' + entry.obstacleName + '」' +
          iv[0].toFixed(2) + '–' + iv[1].toFixed(2) + 's（点击跳到进入时刻）';
        bar.addEventListener('click', function (e) {
          e.stopPropagation();
          seek(iv[0]);
        });
        lane.appendChild(bar);
      });
    });
  }

  // 时间轴：拖动时刻柄 / 点击定位播放头
  timelineEl.addEventListener('pointermove', function (e) {
    if (!state.drag || state.drag.type !== 'tick') return;
    var rect = lanesEl.getBoundingClientRect();
    var t = xToT(e.clientX - rect.left, laneWidth());
    var p = getPerformer(state.drag.pid);
    var key = p.keys[state.drag.index];
    var newT = clamp(Math.round(t * 10) / 10, 0, state.duration);
    // 不允许与同表演者另一帧同时刻（交换会乱序）
    var clash = p.keys.some(function (k, i) {
      return i !== state.drag.index && Math.abs(k.t - newT) < 1e-6;
    });
    if (!clash && newT !== key.t) {
      key.t = newT;
      p.keys.sort(function (a, b) { return a.t - b.t; });
      state.drag.index = p.keys.indexOf(key);
      state.selectedKey = { pid: p.id, index: state.drag.index };
      state.drag.moved = true;
      recompute();
      renderTimelineStatic();
    }
  });

  document.addEventListener('pointerup', function (e) {
    if (state.drag && state.drag.type === 'tick') {
      state.drag = null;
    }
  });

  timelineEl.addEventListener('click', function (e) {
    // 点在时刻柄上不处理（它已 stopPropagation）
    var rect = lanesEl.getBoundingClientRect();
    if (e.clientY < rect.top - 22 || e.clientY > rect.bottom + 4) return;
    var t = xToT(e.clientX - rect.left, laneWidth());
    seek(t);
  });

  function updatePlayhead() {
    var lw = laneWidth();
    var tlRect = timelineEl.getBoundingClientRect();
    var laneRect = lanesEl.getBoundingClientRect();
    var xInLane = tToX(state.time, lw);
    playheadEl.style.left = (laneRect.left - tlRect.left + xInLane) + 'px';
    document.getElementById('time-input').value = Math.round(state.time * 100) / 100;
  }

  // ---------- 播放 ----------
  var playBtn = document.getElementById('btn-play');
  var rafId = null;
  var lastTs = 0;

  function setPlaying(v) {
    state.playing = v;
    playBtn.textContent = v ? '⏸ 暂停' : '▶ 播放';
    if (v) {
      if (state.time >= state.duration - 1e-6) state.time = 0;
      lastTs = 0;
      rafId = requestAnimationFrame(tick);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function tick(ts) {
    if (!state.playing) return;
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    state.time += dt * state.speed;
    if (state.time >= state.duration) {
      state.time = state.duration;
      updatePlayhead();
      draw();
      setPlaying(false);
      return;
    }
    updatePlayhead();
    draw();
    rafId = requestAnimationFrame(tick);
  }

  function seek(t) {
    state.time = clamp(Number(t), 0, state.duration);
    updatePlayhead();
    draw();
  }

  playBtn.addEventListener('click', function () {
    setPlaying(!state.playing);
  });
  document.getElementById('btn-stop').addEventListener('click', function () {
    setPlaying(false);
    seek(0);
  });
  document.getElementById('time-input').addEventListener('change', function () {
    setPlaying(false);
    seek(Number(this.value) || 0);
  });

  // 摘要"最小安全余量"行：点击跳转播放头到全局最小余量发生时刻
  document.getElementById('sum-margin-row').addEventListener('click', function () {
    if (state.analysis && state.analysis.minMarginT !== null && state.analysis.minMarginT !== undefined) {
      seek(state.analysis.minMarginT);
    }
  });

  document.querySelectorAll('.speed-group .btn-mini').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.speed = Number(btn.dataset.speed);
      document.querySelectorAll('.speed-group .btn-mini').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
    });
  });

  // ---------- 顶部 / 侧栏按钮 ----------
  document.getElementById('btn-add').addEventListener('click', addPerformer);

  document.getElementById('btn-sample').addEventListener('click', function () {
    fetchSample();
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    state.performers.forEach(function (p) {
      p.keys = [{ t: 0, x: p.keys[0] ? p.keys[0].x : 100, y: p.keys[0] ? p.keys[0].y : 100, r: null }];
    });
    state.time = 0;
    state.activePairKey = null;
    recompute();
    renderTimelineStatic();
    draw();
  });

  document.getElementById('duration-input').addEventListener('change', function () {
    var d = Number(this.value);
    if (!(d > 0) || d > 120) {
      this.value = state.duration;
      return;
    }
    state.duration = d;
    // 截断越界关键帧
    state.performers.forEach(function (p) {
      p.keys = p.keys.filter(function (k) { return k.t <= d; });
      if (!p.keys.length) p.keys = [{ t: 0, x: 100, y: 100, r: null }];
      // 口令时窗钳到新时长（端点倒置自动交换）
      if (p.cues && p.cues.length) p.cues = Core.normalizeCues(p.cues, d);
      // 保证每人末帧覆盖新时长（静态延长）
    });
    state.time = Math.min(state.time, d);
    document.getElementById('duration-readout').textContent = d.toFixed(1);
    recompute();
    renderCues();
    renderTimelineStatic();
    draw();
  });

  // 键盘：空格播放/暂停，Delete 删选中帧/矩形，Esc 退出新增模式
  window.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.code === 'Escape' && state.addZoneMode) {
      setAddZoneMode(false);
      state.drag = null;
      draw();
    } else if (e.code === 'Escape' && state.addObstacleMode) {
      setAddObstacleMode(false);
      state.drag = null;
      draw();
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && state.selectedZoneId) {
      removeZone(state.selectedZoneId);
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && state.selectedObstacleId) {
      removeObstacle(state.selectedObstacleId);
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && state.selectedKey) {
      removeKey(state.selectedKey.pid, state.selectedKey.index);
    }
  });

  // 尺寸变化时重绘危险条与播放头
  window.addEventListener('resize', function () {
    renderTimelineDanger();
    updatePlayhead();
    draw();
  });

  // ---------- 方案快照（localStorage 持久化，最多 8 个） ----------
  var SNAP_KEY = 'trajectory-collision-stage.snapshots.v1';
  var SNAP_LIMIT = 8;
  var CURRENT_OPT = '__current__';

  var snapSaveBtn = document.getElementById('btn-snap-save');
  var snapNameInput = document.getElementById('snap-name');
  var snapListEl = document.getElementById('snap-list');
  var snapHeadEl = document.getElementById('snap-head');
  var snapSelectA = document.getElementById('snap-select-a');
  var snapSelectB = document.getElementById('snap-select-b');
  var snapDiffEl = document.getElementById('snap-diff');
  var snapStatusEl = document.getElementById('snap-status');
  var snapStatusTimer = null;

  // 深拷贝当前场景（状态中的 performer/obstacle/handoff/zone 均为纯数据）
  function serializeScene() {
    return JSON.parse(JSON.stringify({
      duration: state.duration,
      performers: state.performers,
      obstacles: state.obstacles,
      handoffs: state.handoffs,
      capacityZones: state.capacityZones
    }));
  }

  function loadSnapshots() {
    try {
      var raw = window.localStorage.getItem(SNAP_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.list)) return [];
      // 越限只保留最近 8 个
      return parsed.list.slice(0, SNAP_LIMIT);
    } catch (err) {
      return [];
    }
  }

  function persistSnapshots(list) {
    try {
      window.localStorage.setItem(SNAP_KEY, JSON.stringify({
        version: 1,
        selectA: snapSelectA.value || CURRENT_OPT,
        selectB: snapSelectB.value || CURRENT_OPT,
        list: list
      }));
    } catch (err) {
      showSnapStatus('浏览器存储不可用，快照未能持久化', 'warn');
    }
  }

  function readStoredSelection() {
    try {
      var raw = window.localStorage.getItem(SNAP_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed || {};
    } catch (err) {
      return {};
    }
  }

  var snapshots = loadSnapshots();
  var stored = readStoredSelection();

  function snapId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function formatTime(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function getSnapshot(id) {
    return snapshots.find(function (s) { return s.id === id; }) || null;
  }

  function showSnapStatus(text, kind) {
    snapStatusEl.hidden = false;
    snapStatusEl.textContent = text;
    snapStatusEl.className = 'snap-status ' + (kind || 'ok');
    if (snapStatusTimer) clearTimeout(snapStatusTimer);
    snapStatusTimer = setTimeout(function () { snapStatusEl.hidden = true; }, 2600);
  }

  function saveSnapshot() {
    var name = snapNameInput.value.trim();
    if (!name) {
      showSnapStatus('请先填写快照名称（同名快照将被覆盖）', 'warn');
      snapNameInput.focus();
      return;
    }
    var existed = snapshots.find(function (s) { return s.name === name; });
    if (existed) {
      existed.scene = serializeScene();
      existed.createdAt = Date.now();
      // 覆盖后置顶（视为最新版本）
      snapshots = snapshots.filter(function (s) { return s.id !== existed.id; });
      snapshots.unshift(existed);
      showSnapStatus('已覆盖同名快照「' + name + '」', 'ok');
    } else {
      if (snapshots.length >= SNAP_LIMIT) {
        showSnapStatus('最多保留 ' + SNAP_LIMIT + ' 个快照：请删除或使用同名覆盖', 'warn');
        return;
      }
      snapshots.unshift({ id: snapId(), name: name, scene: serializeScene(), createdAt: Date.now() });
      showSnapStatus('已保存快照「' + name + '」', 'ok');
    }
    snapNameInput.value = '';
    var newId = snapshots[0].id;
    var autoSelectB = !existed && snapshots.length === 1;
    persistSnapshots(snapshots);
    renderSnapshotPanel(); // 先重建 <option>，再设置选中值
    if (autoSelectB) {
      // 首个快照：方案 2 默认取该快照，便于立即与当前场景对比
      snapSelectB.value = newId;
    }
    persistSnapshots(snapshots);
    refreshSnapshotDiff();
  }

  function deleteSnapshot(id) {
    var s = getSnapshot(id);
    snapshots = snapshots.filter(function (x) { return x.id !== id; });
    if (snapSelectA.value === id) snapSelectA.value = CURRENT_OPT;
    if (snapSelectB.value === id) snapSelectB.value = CURRENT_OPT;
    persistSnapshots(snapshots);
    renderSnapshotPanel();
    refreshSnapshotDiff();
    if (s) showSnapStatus('已删除快照「' + s.name + '」', 'ok');
  }

  function overwriteSnapshot(id) {
    var s = getSnapshot(id);
    if (!s) return;
    s.scene = serializeScene();
    s.createdAt = Date.now();
    persistSnapshots(snapshots);
    renderSnapshotPanel();
    refreshSnapshotDiff();
    showSnapStatus('已用当前场景覆盖快照「' + s.name + '」', 'ok');
  }

  function loadSnapshotScene(id) {
    var s = getSnapshot(id);
    if (!s) return;
    loadScene(s.scene);
    renderSnapshotPanel(); // loadScene 不影响快照，但同步选中态高亮
    showSnapStatus('已载入快照「' + s.name + '」（可继续编辑，不会改动快照本身）', 'ok');
  }

  function renderSnapshotPanel() {
    snapHeadEl.textContent = '方案快照（' + snapshots.length + '/' + SNAP_LIMIT + ' · 存于本机浏览器）';
    snapSaveBtn.disabled = false; // 同名覆盖始终允许；满额时在保存处提示
    snapNameInput.maxLength = 24;

    // 快照列表
    snapListEl.innerHTML = '';
    if (!snapshots.length) {
      var empty = document.createElement('div');
      empty.className = 'snap-empty';
      empty.textContent = '尚无快照：命名后点击「存为快照」，同名自动覆盖。';
      snapListEl.appendChild(empty);
    } else {
      snapshots.forEach(function (s) {
        var row = document.createElement('div');
        row.className = 'snap-item';
        var np = s.scene.performers ? s.scene.performers.length : 0;
        var no = s.scene.obstacles ? s.scene.obstacles.length : 0;
        var nh = s.scene.handoffs ? s.scene.handoffs.length : 0;
        var nz = s.scene.capacityZones ? s.scene.capacityZones.length : 0;

        var nameEl = document.createElement('span');
        nameEl.className = 'snap-item-name';
        nameEl.textContent = s.name;
        nameEl.title = s.name;

        var meta = document.createElement('span');
        meta.className = 'snap-item-meta';
        meta.textContent = s.scene.duration + 's · ' + np + '人' + (no ? ' · ' + no + '禁入' : '') +
          (nh ? ' · ' + nh + '交接' : '') + (nz ? ' · ' + nz + '限员' : '') + ' · ' + formatTime(s.createdAt);

        var loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'snap-load';
        loadBtn.textContent = '载入';
        loadBtn.title = '把该快照载入舞台（不会修改快照）';
        loadBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          loadSnapshotScene(s.id);
        });

        var ovBtn = document.createElement('button');
        ovBtn.type = 'button';
        ovBtn.className = 'snap-overwrite';
        ovBtn.textContent = '覆盖';
        ovBtn.title = '用当前场景覆盖该快照';
        ovBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          overwriteSnapshot(s.id);
        });

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'snap-del';
        delBtn.textContent = '✕';
        delBtn.title = '删除该快照';
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          deleteSnapshot(s.id);
        });

        row.appendChild(nameEl);
        row.appendChild(meta);
        row.appendChild(loadBtn);
        row.appendChild(ovBtn);
        row.appendChild(delBtn);
        snapListEl.appendChild(row);
      });
    }

    // 两个对比选择器（都可选取"当前场景"）
    [snapSelectA, snapSelectB].forEach(function (sel) {
      var prev = sel.value;
      sel.innerHTML = '';
      var cur = document.createElement('option');
      cur.value = CURRENT_OPT;
      cur.textContent = '● 当前场景（实时）';
      sel.appendChild(cur);
      snapshots.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = '📷 ' + s.name;
        sel.appendChild(opt);
      });
      sel.value = snapshots.some(function (s) { return s.id === prev; }) || prev === CURRENT_OPT
        ? prev
        : CURRENT_OPT;
    });
  }

  function resolveCompareScene(value) {
    if (value === CURRENT_OPT || value === '') {
      return { label: '当前场景', scene: serializeScene(), live: true };
    }
    var s = getSnapshot(value);
    return s ? { label: s.name, scene: s.scene, live: false } : null;
  }

  // 对比结果内任意时刻跳转（事件委托）
  snapDiffEl.addEventListener('click', function (e) {
    var el = e.target && typeof e.target.closest === 'function' ? e.target.closest('.t-jump') : null;
    if (!el || !snapDiffEl.contains(el)) return;
    var t = Number(el.getAttribute('data-t'));
    if (isFinite(t)) seek(t);
  });

  function ivChip(iv, cls) {
    return '<span class="diff-iv ' + cls + ' t-jump" data-t="' + iv[0] +
      '" title="点击跳转到 ' + fmt(iv[0]) + 's">' +
      fmt(iv[0]) + '–' + fmt(iv[1]) + ' s</span>';
  }

  function diffRowsHtml(items, kind, makeTitle) {
    if (!items.length) return '';
    var tagText = kind === 'added' ? '新增' : kind === 'removed' ? '消失' : '时间变化';
    return items.map(function (it) {
      var html = '<div class="diff-row">' +
        '<span class="diff-tag ' + kind + '">' + tagText + '</span>' + makeTitle(it);
      if (kind === 'added' || kind === 'removed') {
        var jumpIv = it.intervals[0];
        html += '<div class="diff-ivs">' +
          (kind === 'added'
            ? it.intervals.map(function (iv) { return ivChip(iv, 'new'); }).join('')
            : it.intervals.map(function (iv) { return ivChip(iv, 'old'); }).join('')) +
          (jumpIv ? ' <span class="t-jump" data-t="' + jumpIv[0] + '" title="点击跳转到该时刻">→ 跳转 ' +
            fmt(jumpIv[0]) + 's</span>' : '') +
          '</div>';
      } else {
        // 时间变化：旧区间（红）→ 新区间（绿）
        var firstJump = null;
        html += '<div class="diff-ivs">';
        if (it.removed.length) {
          html += it.removed.map(function (iv) { return ivChip(iv, 'old'); }).join('');
          if (!firstJump) firstJump = it.removed[0];
        }
        if (it.changed.length) {
          html += it.changed.map(function (c) {
            if (!firstJump) firstJump = c.from;
            return ivChip(c.from, 'old') + '<span class="diff-arrow">→</span>' + ivChip(c.to, 'new');
          }).join('');
        }
        if (it.added.length) {
          html += it.added.map(function (iv) { return ivChip(iv, 'new'); }).join('');
          if (!firstJump) firstJump = it.added[0];
        }
        if (firstJump) {
          html += ' <span class="t-jump" data-t="' + firstJump[0] +
            '" title="点击跳转到该时刻">→ 跳转 ' + fmt(firstJump[0]) + 's</span>';
        }
        html += '</div>';
      }
      return html + '</div>';
    }).join('');
  }

  function refreshSnapshotDiff() {
    if (snapshots.length === 0 &&
        snapSelectA.value === CURRENT_OPT && snapSelectB.value === CURRENT_OPT) {
      snapDiffEl.innerHTML = '<div class="diff-empty">保存至少一个快照后，选择两个方案即可对比：位置偏移最大值、碰撞对与禁入区间的新增 / 消失 / 时间变化。</div>';
      return;
    }
    var a = resolveCompareScene(snapSelectA.value);
    var b = resolveCompareScene(snapSelectB.value);
    if (!a || !b) {
      snapDiffEl.innerHTML = '<div class="diff-empty">所选快照已不存在，请重新选择。</div>';
      return;
    }
    if (snapSelectA.value === snapSelectB.value) {
      snapDiffEl.innerHTML = '<div class="diff-empty">两个选择相同：把其中一个选为另一快照（或当前场景）后开始对比。</div>';
      return;
    }

    var d;
    try {
      d = Core.compareScenes(a.scene, b.scene);
    } catch (err) {
      snapDiffEl.innerHTML = '<div class="diff-empty">对比失败：' + escapeHtml(err.message) + '</div>';
      return;
    }

    var html = '';
    if (Math.abs(d.durationA - d.durationB) > 1e-9) {
      html += '<div class="diff-duration">总时长 ' + fmt(d.durationA, 1) + 's → ' +
        fmt(d.durationB, 1) + 's，统一时刻轴 0～' + fmt(d.duration, 1) + 's（帧外按末位静止）</div>';
    } else {
      html += '<div class="diff-duration">统一时刻轴 0～' + fmt(d.duration, 1) + 's</div>';
    }

    // —— 同名表演者位置偏移 ——
    var common = d.performers.filter(function (p) { return p.maxOffset !== null; });
    var onlyA = d.performers.filter(function (p) { return !p.presentB; });
    var onlyB = d.performers.filter(function (p) { return !p.presentA; });
    html += '<div class="diff-section"><div class="diff-section-head">同名表演者位置偏移' +
      '<span class="count">（线性插值 · 取统一时刻轴上的精确最大值）</span></div>';
    if (d.maxOffset === null) {
      html += '<div class="diff-empty">两方案没有同名表演者。</div>';
    } else {
      html += '<div class="diff-row diff-max-row">全局最大偏移 <b>' + fmt(d.maxOffset) +
        '</b> 单位 · ' + escapeHtml(d.maxOffsetPerformer) +
        ' @ <span class="t-jump" data-t="' + d.maxOffsetT + '" title="点击跳转到该时刻"><b>' +
        fmt(d.maxOffsetT) + ' s</b></span></div>';
      common.forEach(function (p) {
        if (p.name === d.maxOffsetPerformer && Math.abs(p.maxOffset - d.maxOffset) < 1e-9) return;
        html += '<div class="diff-row">' + escapeHtml(p.name) + '：偏移 <b>' + fmt(p.maxOffset) +
          '</b> 单位 @ <span class="t-jump" data-t="' + p.maxOffsetT +
          '" title="点击跳转到该时刻">' + fmt(p.maxOffsetT) + ' s</span></div>';
      });
    }
    if (onlyA.length || onlyB.length) {
      html += '<div class="diff-perf-only">';
      if (onlyB.length) html += '方案 2 新增表演者：' + onlyB.map(function (p) { return escapeHtml(p.name); }).join('、');
      if (onlyA.length) html += (onlyB.length ? '；' : '') + '方案 2 已移除：' +
        onlyA.map(function (p) { return escapeHtml(p.name); }).join('、');
      html += '</div>';
    }
    html += '</div>';

    // —— 碰撞对 ——
    var pr = d.pairs;
    var prChanged = pr.added.length + pr.removed.length + pr.changed.length;
    html += '<div class="diff-section"><div class="diff-section-head">碰撞对变化' +
      '<span class="count">（' + prChanged + ' 项变化' +
      (pr.unchangedCount ? ' · ' + pr.unchangedCount + ' 对区间不变' : '') + '）</span></div>';
    if (!prChanged) {
      html += '<div class="diff-empty">两方案的碰撞区间完全一致（无碰撞或区间未变）。</div>';
    } else {
      var pairTitle = function (it) {
        return escapeHtml(it.names[0]) + ' <span style="color:var(--text-dim)">×</span> ' + escapeHtml(it.names[1]);
      };
      html += diffRowsHtml(pr.added, 'added', pairTitle);
      html += diffRowsHtml(pr.removed, 'removed', pairTitle);
      html += diffRowsHtml(pr.changed, 'changed', pairTitle);
    }
    html += '</div>';

    // —— 禁入区间 ——
    var ob = d.obstacleIntrusions;
    var obChanged = ob.added.length + ob.removed.length + ob.changed.length;
    html += '<div class="diff-section"><div class="diff-section-head">禁入区间变化' +
      '<span class="count">（表演者 × 禁入区 · ' + obChanged + ' 项变化' +
      (ob.unchangedCount ? ' · ' + ob.unchangedCount + ' 项不变' : '') + '）</span></div>';
    if (!obChanged && !d.addedObstacles.length && !d.removedObstacles.length) {
      html += '<div class="diff-empty">两方案的禁入区间完全一致。</div>';
    } else {
      var obsTitle = function (it) {
        return escapeHtml(it.performerName) + ' <span style="color:var(--text-dim)">▣</span> ' + escapeHtml(it.obstacleName);
      };
      html += diffRowsHtml(ob.added, 'added', obsTitle);
      html += diffRowsHtml(ob.removed, 'removed', obsTitle);
      html += diffRowsHtml(ob.changed, 'changed', obsTitle);
    }
    if (d.addedObstacles.length || d.removedObstacles.length) {
      html += '<div class="diff-perf-only">';
      if (d.addedObstacles.length) html += '方案 2 新增禁入区：' + d.addedObstacles.map(escapeHtml).join('、');
      if (d.removedObstacles.length) html += (d.addedObstacles.length ? '；' : '') + '方案 2 已删除禁入区：' +
        d.removedObstacles.map(escapeHtml).join('、');
      html += '</div>';
    }
    html += '</div>';

    snapDiffEl.innerHTML = html;
  }

  snapSaveBtn.addEventListener('click', saveSnapshot);
  snapNameInput.addEventListener('keydown', function (e) {
    if (e.code === 'Enter') {
      e.preventDefault();
      saveSnapshot();
    }
  });
  snapSelectA.addEventListener('change', function () {
    persistSnapshots(snapshots);
    refreshSnapshotDiff();
  });
  snapSelectB.addEventListener('change', function () {
    persistSnapshots(snapshots);
    refreshSnapshotDiff();
  });

  // ---------- 启动 ----------
  function fetchSample() {
    fetch('/api/sample')
      .then(function (r) { return r.json(); })
      .then(function (scene) {
        loadScene(scene);
      })
      .catch(function () {
        // 离线打开 file:// 等情况：直接用内置同一份样例
        loadScene(Core.builtinScene());
      });
  }

  document.getElementById('duration-readout').textContent = state.duration.toFixed(1);
  renderSnapshotPanel();
  // 恢复上次选择的对比方案（已删除快照等失效值由 renderSnapshotPanel 钳为"当前场景"）
  [['selectA', snapSelectA], ['selectB', snapSelectB]].forEach(function (pair) {
    var key = pair[0];
    var sel = pair[1];
    if (stored[key] && (stored[key] === CURRENT_OPT || getSnapshot(stored[key]))) {
      sel.value = stored[key];
    }
  });
  refreshSnapshotDiff();
  fetchSample();
})();
