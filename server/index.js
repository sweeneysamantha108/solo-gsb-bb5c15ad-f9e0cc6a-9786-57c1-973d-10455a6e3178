'use strict';

const path = require('path');
const express = require('express');
const core = require('../public/core.js');

const app = express();
app.use(express.json({ limit: '256kb' }));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: 0
}));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

/** 内置交叉样例（含关键帧安全半径），前端启动时加载 */
app.get('/api/sample', (_req, res) => {
  res.json(core.builtinScene());
});

/**
 * 把入参场景规整为 API 出参形式：每个关键帧都带显式半径 r
 * （缺省继承的帧解析为表演者当前 radius），禁入矩形经坐标/尺寸规整，
 * 交接配置经同一规整（缺省 id 补全、尺寸/触达钳非负、最短持续必须为正），
 * 限员区域经同一规整（缺省 id 补全、尺寸钳非负、人数上限为正整数），
 * 便于集成方直接消费。
 */
function resolveScene(duration, performers, obstacles, handoffs, capacityZones) {
  return {
    duration: duration,
    obstacles: core.normalizeObstacles(obstacles),
    handoffs: core.normalizeHandoffs(handoffs, duration),
    capacityZones: core.normalizeCapacityZones(capacityZones),
    performers: performers.map((p) => {
      const base = Math.max(0, Number(p.radius) || 0);
      const ks = core.normalizeKeys(p.keys, base);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        radius: base,
        keys: ks.map((k) => ({
          t: k.t,
          x: k.x,
          y: k.y,
          r: k.r === null ? base : k.r
        })),
        cues: core.normalizeCues(p.cues, duration)
      };
    })
  };
}

/**
 * 场景碰撞分析（与前端同一份解析引擎，便于集成/校验）。
 * body: {
 *   duration,
 *   performers:[{name?,radius,keys:[{t,x,y,r?}],cues?:[{x,y,width,height,winStart,winEnd}]}],
 *   obstacles?:[{id?,name?,x,y,width,height}],   // 舞台禁入矩形（可空/缺省）
 *   handoffs?:[{id?,aId,bId,x,y,width,height,reach,minDuration}]  // 道具交接（可空/缺省）
 *   capacityZones?:[{id?,name?,x,y,width,height,limit}] // 区域限员（正整数上限，可空/缺省）
 * }
 * 关键帧 r 为可选安全半径（开伞/展开道具），缺省继承表演者 radius。
 * cues 为按顺序排列的入场口令（入口矩形 + 允许进入时窗，时窗缺省为
 * [0,duration]），引擎按圆心从矩形外严格进入的时刻核对，返回
 * cueResults（triggered/missed/blocked）。
 * handoffs 为道具交接配置：aId/bId 引用表演者 id，交接区为轴对齐矩形，
 * reach 为最大圆心触达距离，minDuration(d>0) 为最短持续秒数；返回
 * handoffResults——两人圆心同时严格位于交接区内部且间距≤reach 的
 * 连续区间（贴边停留与仅瞬时触达不计），以及每段满足 b-a≥d 时给出的
 * 起始时窗 [a, b-d]。
 * capacityZones 为区域限员配置：轴对齐矩形 + 正整数人数上限 limit；
 * 返回 capacityResults——只统计圆心严格位于内部者的超员（count>limit）
 * 连续时间段（贴边、瞬时触角、零宽高区域不计；同刻进出一并处理、不
 * 产生零长度段；跨关键帧连续停留合并，同一人同次停留只计一次；名单
 * 变化即分段），段内给出区间、人数与人员名单，另附全程峰值人数。
 * riskTimeline 复用上述碰撞 / 禁入区侵入 / 区域超员三类区间，合成为
 * 按时间排序、互不重叠的风险段（同刻开始与结束统一结算、舍弃零长度
 * 段、生效风险来源或涉及人员变化即分段），每段给出起止时刻、来源
 * （类型 + 标签 + 来源内人员）与涉及人员并集，供前端侧栏展示与跳转。
 * 每对返回精确碰撞区间与最小安全余量 minMargin/minMarginT
 * （distance(t)-(rA+rB) 的连续全局最小值及发生时刻），pairs 按余量升序；
 * obstacleConflicts 为每位表演者 × 每个禁入矩形的精确侵入区间，按首次
 * 进入时刻升序；场景级另附 minMargin/minMarginT/minMarginPair 与
 * firstObstacleEntry/firstObstacleConflict。旧请求（无 obstacles/cues/
 * handoffs/capacityZones）完全兼容。
 */
app.post('/api/analyze', (req, res) => {
  try {
    const scene = req.body || {};
    const duration = Number(scene.duration);
    const performers = Array.isArray(scene.performers) ? scene.performers : [];
    const rawObstacles = scene.obstacles;
    const rawHandoffs = scene.handoffs;
    const rawCapacityZones = scene.capacityZones;

    if (!(duration > 0) || !isFinite(duration)) {
      return res.status(400).json({ error: 'duration 必须为正数（秒）' });
    }
    if (performers.length < 2 || performers.length > 8) {
      return res.status(400).json({ error: '表演者人数需为 2～8 人' });
    }
    if (rawObstacles !== undefined && rawObstacles !== null && !Array.isArray(rawObstacles)) {
      return res.status(400).json({ error: 'obstacles 必须为数组' });
    }
    if (rawHandoffs !== undefined && rawHandoffs !== null && !Array.isArray(rawHandoffs)) {
      return res.status(400).json({ error: 'handoffs 必须为数组' });
    }
    if (rawCapacityZones !== undefined && rawCapacityZones !== null && !Array.isArray(rawCapacityZones)) {
      return res.status(400).json({ error: 'capacityZones 必须为数组' });
    }

    performers.forEach((p, idx) => {
      if (!Array.isArray(p.keys) || p.keys.length === 0) {
        throw new Error(`第 ${idx + 1} 人至少需要 1 个走位点`);
      }
      if (!(Number(p.radius) >= 0) || !isFinite(Number(p.radius))) {
        throw new Error(`第 ${idx + 1} 人身体半径需为非负数`);
      }
      p.keys.forEach((k, ki) => {
        ['t', 'x', 'y'].forEach((f) => {
          if (!isFinite(Number(k[f]))) {
            throw new Error(`第 ${idx + 1} 人存在非法走位点（${f} 非数字）`);
          }
        });
        if (Number(k.t) < 0 || Number(k.t) > duration) {
          throw new Error(`第 ${idx + 1} 人存在超出 [0, ${duration}] 的时刻`);
        }
        if (k.r !== undefined && k.r !== null && k.r !== '') {
          if (!isFinite(Number(k.r)) || Number(k.r) < 0) {
            throw new Error(`第 ${idx + 1} 人第 ${ki + 1} 个关键帧安全半径需为非负数`);
          }
        }
      });
      // 入场口令入参校验（缺省/空数组直接跳过）；非法项由引擎规整时丢弃，
      // 这里仅对显式给出但字段类型错误的请求报 400
      if (p.cues !== undefined && p.cues !== null && !Array.isArray(p.cues)) {
        throw new Error(`第 ${idx + 1} 人的入场口令 cues 必须为数组`);
      }
      (p.cues || []).forEach((c, ci) => {
        if (!c || typeof c !== 'object') {
          throw new Error(`第 ${idx + 1} 人第 ${ci + 1} 条入场口令格式非法`);
        }
        ['x', 'y', 'width', 'height', 'winStart', 'winEnd'].forEach((f) => {
          if (c[f] !== undefined && c[f] !== null && c[f] !== '' && !isFinite(Number(c[f]))) {
            throw new Error(`第 ${idx + 1} 人第 ${ci + 1} 条入场口令的 ${f} 必须为数字`);
          }
        });
        if (isFinite(Number(c.width)) && Number(c.width) < 0) {
          throw new Error(`第 ${idx + 1} 人第 ${ci + 1} 条入场口令的 width 不能为负`);
        }
        if (isFinite(Number(c.height)) && Number(c.height) < 0) {
          throw new Error(`第 ${idx + 1} 人第 ${ci + 1} 条入场口令的 height 不能为负`);
        }
      });
    });

    // 禁入矩形入参校验（缺省/空数组直接跳过，保持旧请求兼容）
    (rawObstacles || []).forEach((o, idx) => {
      if (!o || typeof o !== 'object') {
        throw new Error(`第 ${idx + 1} 个禁入矩形格式非法`);
      }
      ['x', 'y', 'width', 'height'].forEach((f) => {
        if (!isFinite(Number(o[f]))) {
          throw new Error(`第 ${idx + 1} 个禁入矩形的 ${f} 必须为有限数`);
        }
      });
      if (Number(o.width) < 0 || Number(o.height) < 0) {
        throw new Error(`第 ${idx + 1} 个禁入矩形的 width/height 不能为负`);
      }
    });

    // 道具交接入参校验（缺省/空数组直接跳过，保持旧请求兼容）；
    // 缺省字段由引擎规整时丢弃/补全，这里仅对显式给出但非法的字段报 400
    (rawHandoffs || []).forEach((h, idx) => {
      if (!h || typeof h !== 'object') {
        throw new Error(`第 ${idx + 1} 项交接格式非法`);
      }
      ['aId', 'bId'].forEach((f) => {
        const v = h[f];
        if (v !== undefined && v !== null && v !== '' &&
            typeof v !== 'string' && typeof v !== 'number') {
          throw new Error(`第 ${idx + 1} 项交接的 ${f} 必须为字符串`);
        }
      });
      ['x', 'y', 'width', 'height', 'reach', 'minDuration'].forEach((f) => {
        if (h[f] !== undefined && h[f] !== null && h[f] !== '' && !isFinite(Number(h[f]))) {
          throw new Error(`第 ${idx + 1} 项交接的 ${f} 必须为数字`);
        }
      });
      if (isFinite(Number(h.width)) && Number(h.width) < 0) {
        throw new Error(`第 ${idx + 1} 项交接的 width 不能为负`);
      }
      if (isFinite(Number(h.height)) && Number(h.height) < 0) {
        throw new Error(`第 ${idx + 1} 项交接的 height 不能为负`);
      }
      if (isFinite(Number(h.reach)) && Number(h.reach) < 0) {
        throw new Error(`第 ${idx + 1} 项交接的 reach 不能为负`);
      }
      if (isFinite(Number(h.minDuration)) && Number(h.minDuration) <= 0) {
        throw new Error(`第 ${idx + 1} 项交接的 minDuration 必须为正数`);
      }
    });

    // 区域限员入参校验（缺省/空数组直接跳过，保持旧请求兼容）；
    // 缺省字段由引擎规整时丢弃/补全，这里仅对显式给出但非法的字段报 400
    (rawCapacityZones || []).forEach((z, idx) => {
      if (!z || typeof z !== 'object') {
        throw new Error(`第 ${idx + 1} 个限员区域格式非法`);
      }
      ['x', 'y', 'width', 'height', 'limit'].forEach((f) => {
        if (z[f] !== undefined && z[f] !== null && z[f] !== '' && !isFinite(Number(z[f]))) {
          throw new Error(`第 ${idx + 1} 个限员区域的 ${f} 必须为数字`);
        }
      });
      if (isFinite(Number(z.width)) && Number(z.width) < 0) {
        throw new Error(`第 ${idx + 1} 个限员区域的 width 不能为负`);
      }
      if (isFinite(Number(z.height)) && Number(z.height) < 0) {
        throw new Error(`第 ${idx + 1} 个限员区域的 height 不能为负`);
      }
      if (z.limit !== undefined && z.limit !== null && z.limit !== '') {
        const lim = Number(z.limit);
        if (!isFinite(lim) || lim <= 0 || Math.floor(lim) !== lim) {
          throw new Error(`第 ${idx + 1} 个限员区域的人数上限 limit 必须为正整数`);
        }
      } else {
        throw new Error(`第 ${idx + 1} 个限员区域缺少人数上限 limit（正整数）`);
      }
    });

    const obstacles = core.normalizeObstacles(rawObstacles);
    const handoffs = core.normalizeHandoffs(rawHandoffs, duration);
    const capacityZones = core.normalizeCapacityZones(rawCapacityZones);
    const result = core.analyzeScene({ duration, performers, obstacles, handoffs, capacityZones });
    res.json(Object.assign(
      { scene: resolveScene(duration, performers, obstacles, handoffs, capacityZones) },
      result
    ));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 兜底返回首页（仅根路径；其余静态资源缺失正常 404）
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`走位轨迹碰撞排练台已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
