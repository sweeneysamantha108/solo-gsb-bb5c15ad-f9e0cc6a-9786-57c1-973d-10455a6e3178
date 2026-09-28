/**
 * 碰撞解析引擎（浏览器 / Node 通用，零依赖）
 *
 * 模型：每位表演者的运动是由关键帧定义的分段直线函数 p(t)。
 * 相邻关键帧之间位置随时间线性插值；关键帧之外（全局起止之间）保持静止。
 *
 * 关键帧可携带可选安全半径 r（表现开伞、展开道具等占用范围变化）：
 *  - 未设置（缺省/null）时继承表演者当前身体半径；
 *  - 相邻关键帧之间半径与位置同步线性插值；首尾之外保持端点值。
 *
 * 对任意两人 A、B，在两人各自同一段分段线性区间内，相对位置与半径和
 * 都是时间 t 的一次函数：
 *
 *     r(t) = pA(t) - pB(t) = u + v t
 *     R(t) = RA(t) + RB(t) = c + d t          （c、d 为常数，R(t) ≥ 0）
 *
 * 碰撞条件 |r(t)| ≤ R(t) 平方后是关于 t 的一般二次不等式：
 *
 *     (|v|² - d²) t² + 2(u·v - c d) t + |u|² - c² ≤ 0
 *
 * 二次项系数可正可负（半径快速张开时为负），统一按求根公式精确求解并
 * 钳制到重叠时间窗；再合并跨段相邻区间。全程没有任何离散帧抽样——
 * 解出的就是碰撞发生的精确时间区间。
 *
 * 此外对每一对连续求"最小安全余量"及其发生时刻：
 *
 *     m(t) = |r(t)| - R(t) = sqrt(q(t)) - (c + d t)，q(t) = |u + v t|²
 *
 * sqrt(q) 是凸函数、R 是线性函数，故 m 在段内恒为凸函数：全局最小只可能
 * 落在段端点，或 |v| > |d| 时唯一的驻点
 *
 *     t* = (-u·v + d·sqrt((|u|²|v|² - (u·v)²) / (|v|² - d²))) / |v|²
 *
 * 退化情形由同一公式/分支覆盖：相对静止（v = 0）或半径变化比相对运动快
 * （|v| ≤ |d|）时 m 单调，最小在端点；相对轨迹过原点（|u×v| = 0，距离
 * 可为零）时驻点即 |r| = 0 的尖点。同样全程解析，不做任何时间采样。
 *
 * ---------- 舞台禁入矩形（obstacles） ----------
 *
 * 场景可携带若干轴对齐矩形 obstacles（{id,name,x,y,width,height}）。
 * 表演者仍视为半径 r(t) 的圆，侵入条件为圆与矩形膨胀边界相交：
 *
 *     dist(p(t), R) ≤ r(t)，
 *     dist(p,R)² = clamp(x − [X0,X1])² + clamp(y − [Y0,Y1])²
 *
 * 即圆心在内部/四条边外带状区/四个角点象限共 3×3 区域中分别表现为
 * 线性、单坐标二次、双坐标二次。对每段 p(t)=u+v t、r(t)=c+d t，
 * 按四条边界线 X0/X1/Y0/Y1 与该段的交点把时间窗切成若干子段，
 * 每个子段内最近点投影恒为同一形式（常数或一个坐标的仿射函数）：
 *
 *     qx(t) = ax·ux + bx·vx·t + cx，qy(t) 同式（ax,bx∈{0,1}，cx∈{−X1,0,−X0}）
 *
 * 于是 qx²+qy² ≤ (c+dt)² 仍是关于 t 的一般二次不等式，直接复用
 * solveQuadraticLE 精确求解（含角点相切重根 = 零长度区间）。
 * 子段区间经 mergeIntervals 合并：从矩形内部起步（t=0 即在内）得
 * 以 0 为起点的区间，跨关键帧/跨子段的相接区间自动合并。
 *
 * ---------- 入场口令（entry cues） ----------
 *
 * 每位表演者可携带按顺序排列的入口矩形口令 cues（{x,y,width,height,
 * winStart,winEnd}）。核对对象是**圆心轨迹**本身（与半径无关）：对每条
 * 分段直线，求 x、y 两个仿射坐标严格落在 (X0,X1)、(Y0,Y1) 开区间内的
 * 时刻交，再合并跨关键帧的相接停留，得到全部进入时刻——起点在矩形内按
 * t=0 进入，仅抵达边界/角点（贴边）与退化矩形（0 宽/高）不计进入。
 * 之后按口令顺序贪心匹配时窗内严格递增、且不与同矩形前一口令共用同一次
 * 停留的最早进入时刻；未触发项分别记为"错过时窗"（missed）与
 * "前序未完成"（blocked）。
 *
 * ---------- 道具交接时窗（handoffs） ----------
 *
 * 场景可携带若干交接配置 handoffs：
 *   { id, aId, bId, x, y, width, height, reach, minDuration }
 * 一项交接表示：两名表演者的**圆心**同时严格位于轴对齐交接区内部
 * （与入场口令同一开区间判定，贴边停留不计），且圆心间距不超过触达距离
 * reach 的连续时间段，即为可交接区间；跨关键帧相接的区间合并为一段，
 * 端点取进入/离开的极限时刻，仅瞬时触达（零长度区间）不计。每段
 * [a,b] 若 b-a ≥ minDuration（d>0），给出起始时窗 [a, b-d]：交接开始
 * 时刻落在该时窗内，即可在区间内完成一次持续 d 秒的交接。
 *
 * 求法：分别对两人求圆心停留区间（复用入场口令的开区间逻辑与合并），
 * 取交集窗；窗内两人相对位置仍是分段一次函数，|u+vt|² ≤ reach² 是首项
 * 系数非负的二次不等式，复用 solveQuadraticLE 精确求解；全部子区间经
 * mergeIntervals 合并。全程解析，不做任何离散帧抽样。
 *
 * ---------- 区域限员（capacity zones） ----------
 *
 * 场景还可携带若干限员区域 capacityZones：
 *   { id, name, x, y, width, height, limit }
 * limit 必须为正整数人数上限；width/height 非负（0 宽/高的退化区域没有
 * 内部，永不统计）。对每位表演者复用圆心**严格位于矩形内部**的停留区间
 * （与入场口令同一开区间判定：贴边、瞬时触角、零宽高区域一律不计；
 * 跨关键帧相接的停留已合并，同一次停留同一人只计一次），把全部进入
 * （+1）/离开（−1）时刻汇总为事件流做扫描线：
 *
 *   - 同一时刻（含跨段解析产生的浮点同级误差）的进出事件先合并为一组、
 *     一并应用，组与组之间在册名单恒定——因此同刻一进一出不会产生瞬时
 *     超员状态，也不生成零长度超员段；开场/收场的单点状态同样不计；
 *   - 每个正持续时间的恒定状态即一段，名单一旦变化即另起一段，只保留
 *     人数 > limit 的超员段，段内给出人数与人员名单（按场景内表演者
 *     次序）；全程峰值人数只在有正持续时间的状态中取。
 *
 * 全程解析（停留区间端点由仿射开区间解出），不做任何离散帧抽样。
 *
 * ---------- 风险叠加时间轴（risk overlay timeline） ----------
 *
 * buildRiskTimeline 复用上述三类分析区间（双人碰撞、表演者×禁入区侵入、
 * 限员区超员状态），不重做几何计算：每个正持续区间产生一对进入/离开
 * 事件（零长度相切点/瞬时触角整体舍弃），事件按时刻排序后做扫描线——
 * 同一时刻的开始与结束归组统一结算（不产生零长度空窗/瞬时段），相邻
 * 事件组之间"生效来源集合 + 涉及人员并集"恒定即一个风险段，来源或
 * 人员变化立即分段；段按起点升序、互不重叠，段内来源按碰撞→禁入侵入
 * →区域超员排列，人员按场景次序去重。浏览器侧栏与 /api/analyze 共用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CollisionCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;          // 数值零容差
  var MERGE_EPS = 1e-6;    // 区间合并基础间隙（秒）
  var MERGE_REL = 1e-9;    // 区间合并相对余量（跨段端点为各自钳制结果，随时间尺度放大）

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  /**
   * 规整关键帧：按 t 排序、去除重复时刻（保留后者）。
   * 可选安全半径 r：非有限值（缺省/null/NaN）归一化为 null，表示继承
   * 表演者当前半径；有限值钳为非负数。
   * baseRadius: 调用方提供的继承半径（仅做规范化，不写入缺省帧）。
   * 返回 [{t, x, y, r}, ...]（r 为非负数或 null）
   */
  function normalizeKeys(keys, baseRadius) {
    var list = (keys || [])
      .map(function (k) {
        var kr = k.r;
        var hasR = kr !== null && kr !== undefined && kr !== '' && isFinite(Number(kr));
        return {
          t: Number(k.t),
          x: Number(k.x),
          y: Number(k.y),
          r: hasR ? Math.max(0, Number(kr)) : null
        };
      })
      .filter(function (k) {
        return isFinite(k.t) && isFinite(k.x) && isFinite(k.y);
      })
      .sort(function (a, b) {
        return a.t - b.t;
      });

    var out = [];
    list.forEach(function (k) {
      if (out.length && Math.abs(out[out.length - 1].t - k.t) < EPS) {
        out[out.length - 1] = k;
      } else {
        out.push(k);
      }
    });
    return out;
  }

  /** 取关键帧在时刻 t 的生效安全半径（缺省帧继承 baseRadius，段内线性插值，首尾之外保持端点值）。 */
  function radiusAt(keys, t, baseRadius) {
    var rb = Math.max(0, Number(baseRadius) || 0);
    if (!keys.length) return rb;

    function kr(k) {
      return k.r === null || k.r === undefined ? rb : k.r;
    }

    var first = keys[0];
    var last = keys[keys.length - 1];
    if (t <= first.t) return kr(first);
    if (t >= last.t) return kr(last);
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i];
      var b = keys[i + 1];
      if (t >= a.t && t <= b.t) {
        var f = (t - a.t) / (b.t - a.t);
        return kr(a) + (kr(b) - kr(a)) * f;
      }
    }
    return kr(last);
  }

  /** 时刻 t 在已规整关键帧上的精确位置（段外保持静止）。 */
  function positionAt(keys, t) {
    if (!keys.length) return { x: 0, y: 0 };
    if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y };
    var last = keys[keys.length - 1];
    if (t >= last.t) return { x: last.x, y: last.y };
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i];
      var b = keys[i + 1];
      if (t >= a.t && t <= b.t) {
        var f = (t - a.t) / (b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f
        };
      }
    }
    return { x: last.x, y: last.y };
  }

  /** 一次取得时刻 t 的位置与生效半径（避免前端重复规整关键帧）。 */
  function stateAt(keys, t, baseRadius) {
    var ks = normalizeKeys(keys, baseRadius);
    var pos = positionAt(ks, t);
    return { x: pos.x, y: pos.y, r: radiusAt(ks, t, baseRadius) };
  }

  /**
   * 把表演者在 [0, duration] 上展开为活动段。
   * 每段位置与半径都是时间的一次函数：
   *     p(t) = (x0 + vx*t, y0 + vy*t)
   *     R(t) = r0 + vr*t
   * t ∈ [t0, t1]。关键帧之外位置静止，半径保持端点值。
   * baseRadius 为表演者当前身体半径，缺省关键帧半径继承它。
   */
  function buildSegments(keys, duration, baseRadius) {
    var rb = Math.max(0, Number(baseRadius) || 0);
    var ks = normalizeKeys(keys, rb);
    var durationNum = Number(duration);
    if (!(durationNum > 0)) {
      throw new Error('duration 必须为正数');
    }
    var T = durationNum;
    var segs = [];

    function effectiveR(k) {
      return k.r === null || k.r === undefined ? rb : k.r;
    }

    function addLinear(t0, t1, p0, p1, r0v, r1v) {
      if (t1 - t0 < EPS) return;
      var dt = t1 - t0;
      var vx = (p1.x - p0.x) / dt;
      var vy = (p1.y - p0.y) / dt;
      var vr = (r1v - r0v) / dt;
      // 以绝对时刻表示 p(t) = x0 + vx*t，故 x0 是 t=0 截距（p0 - v*t0）
      segs.push({
        t0: t0,
        t1: t1,
        x0: p0.x - vx * t0,
        y0: p0.y - vy * t0,
        vx: vx,
        vy: vy,
        r0: r0v - vr * t0,
        vr: vr
      });
    }

    if (ks.length === 0) {
      addLinear(0, T, { x: 0, y: 0 }, { x: 0, y: 0 }, rb, rb);
      return segs;
    }

    var first = ks[0];
    var last = ks[ks.length - 1];

    // 首帧之前：静止在首帧位置，半径保持首帧值
    if (first.t > 0) {
      addLinear(0, Math.min(first.t, T), first, first, effectiveR(first), effectiveR(first));
    }
    // 关键帧之间：位置直线运动，半径同步线性插值
    for (var i = 0; i < ks.length - 1; i++) {
      var a = ks[i];
      var b = ks[i + 1];
      var t0 = Math.max(0, a.t);
      var t1 = Math.min(T, b.t);
      if (t1 > t0) addLinear(t0, t1, a, b, effectiveR(a), effectiveR(b));
    }
    // 末帧之后：静止在末帧位置，半径保持末帧值
    if (last.t < T) {
      addLinear(Math.max(0, last.t), T, last, last, effectiveR(last), effectiveR(last));
    }
    if (!segs.length) {
      // 只有一个关键帧且恰好在边界等退化情况
      addLinear(0, T, first, first, effectiveR(first), effectiveR(first));
    }
    return segs;
  }

  function mergeIntervals(intervals) {
    if (!intervals.length) return [];
    var sorted = intervals
      .filter(function (iv) {
        return iv[1] >= iv[0];
      })
      .sort(function (a, b) {
        return a[0] - b[0];
      });
    var out = [sorted[0].slice()];
    for (var i = 1; i < sorted.length; i++) {
      var cur = sorted[i];
      var top = out[out.length - 1];
      // 跨关键帧边界两侧各自求根/钳制，允许与时刻尺度成比例的浮点间隙
      var tol = MERGE_EPS + MERGE_REL * Math.max(Math.abs(top[1]), Math.abs(cur[0]), 1);
      if (cur[0] <= top[1] + tol) {
        top[1] = Math.max(top[1], cur[1]);
      } else {
        out.push(cur.slice());
      }
    }
    return out;
  }

  /**
   * 精确求解一般二次不等式 A t² + B t + C ≤ 0 在 [lo, hi] 内的解集。
   * A 可正可负可为零（半径快速张开时 A = |v|² - d² 可能为负）。
   * 返回零、一或两个区间（A<0 时解集向两端开口，钳制后最多两段）。
   * 相切（重根）记为零长度区间。
   */
  function solveQuadraticLE(A, B, C, lo, hi) {
    if (Math.abs(A) < EPS) {
      // 退化为一次（或常数）不等式 B t + C ≤ 0
      if (Math.abs(B) < EPS) {
        if (C <= EPS) return [[lo, hi]];
        return [];
      }
      var root = -C / B;
      if (B > 0) {
        // t ≤ root
        if (root < lo - EPS) return [];
        return [[lo, Math.min(hi, root)]];
      }
      // B < 0：t ≥ root
      if (root > hi + EPS) return [];
      return [[Math.max(lo, root), hi]];
    }

    var disc = B * B - 4 * A * C;
    if (disc < -EPS) {
      // 无实根：全程同号
      if (A < 0) return [[lo, hi]]; // 开口向下、顶点仍 < 0？由 disc<0 知恒负
      return [];                    // 开口向上，恒正
    }
    if (disc < 0) disc = 0;
    var sq = Math.sqrt(disc);
    var t1 = (-B - sq) / (2 * A);
    var t2 = (-B + sq) / (2 * A);
    if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }

    if (A > 0) {
      // 开口向上：≤0 部分在两根之间
      var l = Math.max(lo, t1);
      var h = Math.min(hi, t2);
      if (h >= l - EPS) return [[l, h]];
      return [];
    }
    // 开口向下：≤0 部分在两根之外 → 钳制后最多两段
    var out = [];
    if (lo <= t1 + EPS) out.push([lo, Math.min(hi, t1)]);
    if (hi >= t2 - EPS) out.push([Math.max(lo, t2), hi]);
    return out;
  }

  /**
   * 两人在同一时间窗 [lo, hi] 内各自线性运动、半径各自线性变化，
   * 精确求碰撞时间区间。同时更新最小几何间距、半径和极值与
   * 最小安全余量（m(t) = |r(t)| - R(t)）追踪对象。
   */
  function analyzeOverlap(sA, sB, lo, hi, minRef, rangeRef, marginRef) {
    // 相对运动 r(t) = u + v t
    var ux = sA.x0 - sB.x0;
    var uy = sA.y0 - sB.y0;
    var vx = sA.vx - sB.vx;
    var vy = sA.vy - sB.vy;

    // 半径和 R(t) = c + d t（段内插值，恒非负）
    var c = sA.r0 + sB.r0;
    var d = sA.vr + sB.vr;

    // 半径和极值（线性：在端点取极值）
    var rLo = c + d * lo;
    var rHi = c + d * hi;
    if (rLo < rangeRef.min) rangeRef.min = rLo;
    if (rHi < rangeRef.min) rangeRef.min = rHi;
    if (rLo > rangeRef.max) rangeRef.max = rLo;
    if (rHi > rangeRef.max) rangeRef.max = rHi;

    var v2 = vx * vx + vy * vy;
    var u2 = ux * ux + uy * uy;
    var uv = ux * vx + uy * vy;

    // —— 最小几何间距（抛物线 |r(t)|^2 的顶点/端点比较，与半径无关）——
    var tDist;
    if (v2 < EPS) {
      tDist = lo; // 相对静止，距离恒定，任取端点
    } else {
      var tv = -uv / v2;
      tDist = clamp(tv, lo, hi);
    }
    var dxm = ux + vx * tDist;
    var dym = uy + vy * tDist;
    var dm = Math.sqrt(dxm * dxm + dym * dym);
    if (dm < minRef.dist) {
      minRef.dist = dm;
      minRef.t = tDist;
    }

    // —— 最小安全余量 m(t) = |r(t)| - R(t)：凸函数，候选点只有端点与唯一驻点 ——
    // 驻点存在条件 |v| > |d|（否则 m 单调，端点取最小）；
    // cross2 = |u×v|² = 0 时驻点即距离为零的尖点，同一公式覆盖。
    var dd = d * d;
    var mcands = [lo, hi];
    if (v2 - dd > EPS) {
      var cross2 = u2 * v2 - uv * uv;
      if (cross2 < 0) cross2 = 0; // 浮点误差钳制（理论值 ≥ 0）
      var ts = (-uv + d * Math.sqrt(cross2 / (v2 - dd))) / v2;
      if (ts > lo && ts < hi) mcands.push(ts);
    }
    for (var ci = 0; ci < mcands.length; ci++) {
      var tm = mcands[ci];
      var mx = ux + vx * tm;
      var my = uy + vy * tm;
      var mg = Math.sqrt(mx * mx + my * my) - (c + d * tm);
      if (mg < marginRef.margin) {
        marginRef.margin = mg;
        marginRef.t = tm;
      }
    }

    // —— 碰撞区间 |r(t)| ≤ R(t) 的解析解 ——
    // |u + v t|² ≤ (c + d t)² ⇔ A t² + B t + C ≤ 0
    var A = v2 - d * d;
    var B = 2 * (uv - c * d);
    var C = u2 - c * c;

    var hits = solveQuadraticLE(A, B, C, lo, hi);
    // 钳制端点到实际窗（开口向下分支已钳制，这里统一保证精度）
    for (var i = 0; i < hits.length; i++) {
      hits[i][0] = clamp(hits[i][0], lo, hi);
      hits[i][1] = clamp(hits[i][1], lo, hi);
    }
    return hits;
  }

  /**
   * 分析一对表演者。
   * performer: { id?, name?, radius, keys:[{t,x,y,r?}...] }
   * 关键帧 r 缺省时继承表演者 radius。
   * 返回 {
   *   aId,bId,aName,bName, radiusSum, radiusSumMin, radiusSumMax,
   *   intervals:[[t0,t1],...],     // 合并后的精确碰撞区间
   *   minDistance, minDistanceT,   // 最小几何间距（与半径无关）及时刻
   *   minMargin, minMarginT,       // 最小安全余量 distance-(rA+rB) 及发生时刻
   *   firstContact,                // 首次碰撞时刻（无则 null）
   *   lastRelease
   * }
   */
  function analyzePair(pa, pb, duration) {
    var rA = Math.max(0, Number(pa.radius) || 0);
    var rB = Math.max(0, Number(pb.radius) || 0);
    var rSumBase = rA + rB;

    var segsA = buildSegments(pa.keys, duration, rA);
    var segsB = buildSegments(pb.keys, duration, rB);

    var raw = [];
    var minRef = { dist: Infinity, t: 0 };
    var rangeRef = { min: Infinity, max: -Infinity };
    var marginRef = { margin: Infinity, t: 0 };

    var i = 0;
    var j = 0;
    while (i < segsA.length && j < segsB.length) {
      var a = segsA[i];
      var b = segsB[j];
      var lo = Math.max(a.t0, b.t0);
      var hi = Math.min(a.t1, b.t1);
      if (hi - lo > EPS) {
        var found = analyzeOverlap(a, b, lo, hi, minRef, rangeRef, marginRef);
        for (var k = 0; k < found.length; k++) raw.push(found[k]);
      }
      if (a.t1 < b.t1 - EPS) i++;
      else if (b.t1 < a.t1 - EPS) j++;
      else { i++; j++; }
    }

    var intervals = mergeIntervals(raw);
    if (!isFinite(minRef.dist)) {
      minRef = { dist: 0, t: 0 };
    }
    if (!isFinite(rangeRef.min)) {
      rangeRef = { min: rSumBase, max: rSumBase };
    }
    if (!isFinite(marginRef.margin)) {
      // 不可达（buildSegments 恒覆盖 [0, duration]），兜底保持字段有限
      marginRef = { margin: -rSumBase, t: 0 };
    }

    return {
      aId: pa.id,
      bId: pb.id,
      aName: pa.name || pa.id,
      bName: pb.name || pb.id,
      radiusSum: rSumBase,
      radiusSumMin: rangeRef.min,
      radiusSumMax: rangeRef.max,
      intervals: intervals,
      minDistance: minRef.dist,
      minDistanceT: minRef.t,
      minMargin: marginRef.margin,
      minMarginT: marginRef.t,
      firstContact: intervals.length ? intervals[0][0] : null,
      lastRelease: intervals.length ? intervals[intervals.length - 1][1] : null,
      collision: intervals.length > 0
    };
  }

  /**
   * 分析整个场景：枚举全部 C(n,2) 双人组合，并对每位表演者 × 每个
   * 禁入矩形连续求侵入区间。
   * scene: { duration, performers:[performer...], obstacles?:[obstacle...] }
   * pairs 按最小安全余量升序（余量越小越危险，碰撞对自然排在安全对之前）。
   * obstacleConflicts 按首次进入时刻升序（无侵入项排在其后），
   * 另附场景级首次侵入 firstObstacleEntry 及其当事人/禁入区。
   * cueResults 为每位携带入场口令的表演者一条有序触发核对结果
   * （triggered / missed / blocked）。
   * handoffs 为规整后的交接配置，handoffResults 每项给出两人同处
   * 交接区且间距≤触达距离的连续区间与起始时窗。
   * capacityZones 为规整后的区域限员配置，capacityResults 每项给出
   * 按圆心严格在内部统计的超员时间段（名单变化即分段）与全程峰值人数。
   * riskTimeline 为三类风险（碰撞/禁入区侵入/区域超员）合成为按时间
   * 排序、互不重叠、同刻统一结算的风险段（来源或人员变化即分段）。
   */
  function analyzeScene(scene) {
    var duration = Number(scene.duration);
    if (!(duration > 0)) throw new Error('duration 必须为正数');
    var ps = scene.performers || [];
    var obstacles = normalizeObstacles(scene.obstacles);
    var pairs = [];
    for (var i = 0; i < ps.length; i++) {
      for (var j = i + 1; j < ps.length; j++) {
        pairs.push(analyzePair(ps[i], ps[j], duration));
      }
    }

    // 禁入矩形：每位表演者 × 每个矩形一条结果
    var obstacleConflicts = [];
    for (var oi = 0; oi < obstacles.length; oi++) {
      for (var pi = 0; pi < ps.length; pi++) {
        obstacleConflicts.push(analyzeObstacle(ps[pi], obstacles[oi], duration));
      }
    }
    var firstObstacle = null;
    obstacleConflicts.forEach(function (e) {
      if (e.conflict && (!firstObstacle || e.firstEntry < firstObstacle.firstEntry)) {
        firstObstacle = e;
      }
    });
    obstacleConflicts.sort(function (a, b) {
      if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
      if (a.conflict) {
        if (Math.abs(a.firstEntry - b.firstEntry) > EPS) return a.firstEntry - b.firstEntry;
      }
      // 同首入时刻或均无侵入：按矩形、当事人次序稳定排列
      if (a.obstacleId !== b.obstacleId) return a.obstacleId < b.obstacleId ? -1 : 1;
      if (a.performerId !== b.performerId) return a.performerId < b.performerId ? -1 : 1;
      return 0;
    });

    var collisions = pairs.filter(function (p) {
      return p.collision;
    });
    var firstPair = null;
    collisions.forEach(function (p) {
      if (!firstPair || p.firstContact < firstPair.firstContact) firstPair = p;
    });
    var closestPair = null;
    pairs.forEach(function (p) {
      if (!closestPair || p.minDistance < closestPair.minDistance) closestPair = p;
    });
    var marginPair = null;
    pairs.forEach(function (p) {
      if (!marginPair || p.minMargin < marginPair.minMargin) marginPair = p;
    });

    // 统一按最小安全余量升序返回（前端逐对列表与 /api/analyze 同一顺序）
    pairs.sort(function (a, b) {
      return a.minMargin - b.minMargin;
    });

    // 入场口令：每位携带口令的表演者一条 {performerId,performerName,results}
    var cueResults = [];
    ps.forEach(function (p) {
      var results = evaluateCues(p, duration);
      if (results.length) {
        cueResults.push({
          performerId: p.id,
          performerName: p.name || p.id,
          results: results
        });
      }
    });

    // 道具交接：每项配置一条可交接区间与起始时窗结果
    var handoffs = normalizeHandoffs(scene.handoffs, duration);
    var handoffResults = handoffs.map(function (h) {
      var pa = null;
      var pb = null;
      for (var pi = 0; pi < ps.length; pi++) {
        if (pa === null && String(ps[pi].id) === h.aId) pa = ps[pi];
        if (pb === null && String(ps[pi].id) === h.bId) pb = ps[pi];
      }
      return analyzeHandoff(h, pa, pb, duration);
    });

    // 区域限员：每个限员区一条超员时间段与全程峰值结果
    var capacityZones = normalizeCapacityZones(scene.capacityZones);
    var capacityResults = capacityZones.map(function (z) {
      return analyzeCapacityZone(z, ps, duration);
    });

    // 风险叠加时间轴：复用碰撞 / 禁入区侵入 / 区域超员三类区间，
    // 合成为按时间排序、互不重叠、同刻统一结算的风险段
    var riskTimeline = buildRiskTimeline(
      { pairs: pairs, obstacleConflicts: obstacleConflicts, capacityResults: capacityResults },
      ps,
      duration
    );

    return {
      duration: duration,
      pairCount: pairs.length,
      pairs: pairs,
      obstacles: obstacles,
      obstacleConflicts: obstacleConflicts,
      cueResults: cueResults,
      handoffs: handoffs,
      handoffResults: handoffResults,
      capacityZones: capacityZones,
      capacityResults: capacityResults,
      riskTimeline: riskTimeline,
      firstObstacleEntry: firstObstacle ? firstObstacle.firstEntry : null,
      firstObstacleConflict: firstObstacle
        ? [firstObstacle.performerId, firstObstacle.obstacleId]
        : null,
      firstContact: firstPair ? firstPair.firstContact : null,
      firstContactPair: firstPair
        ? [firstPair.aId, firstPair.bId]
        : null,
      minDistance: closestPair ? closestPair.minDistance : null,
      minDistanceT: closestPair ? closestPair.minDistanceT : null,
      minDistancePair: closestPair
        ? [closestPair.aId, closestPair.bId]
        : null,
      minMargin: marginPair ? marginPair.minMargin : null,
      minMarginT: marginPair ? marginPair.minMarginT : null,
      minMarginPair: marginPair
        ? [marginPair.aId, marginPair.bId]
        : null
    };
  }

  /** 查询某表演者在时刻 t 是否处于某碰撞区间内（供画布高亮）。 */
  function isPerformerInCollision(pair, performerId, t) {
    if (!pair || !pair.collision) return false;
    if (pair.aId !== performerId && pair.bId !== performerId) return false;
    for (var i = 0; i < pair.intervals.length; i++) {
      var iv = pair.intervals[i];
      if (t + EPS >= iv[0] && t - EPS <= iv[1]) return true;
    }
    return false;
  }

  // ---------- 舞台禁入矩形 ----------

  var OBS_ID_PREFIX = 'o';

  function nextObstacleId(existing) {
    var used = {};
    (existing || []).forEach(function (o) { used[o.id] = true; });
    var id;
    do {
      id = OBS_ID_PREFIX + Math.random().toString(36).slice(2, 8);
    } while (used[id]);
    return id;
  }

  /**
   * 规整禁入矩形：坐标/尺寸解析为有限数；width、height 钳为非负
   * （允许 0 宽/高的退化矩形——分别退化为线段/点，分析器同样覆盖）。
   * 缺省 id 时按 o1、o2… 生成；缺省 name 用"禁入区 N"。
   * 返回 [{id,name,x,y,width,height}]
   */
  function normalizeObstacles(obstacles) {
    var list = Array.isArray(obstacles) ? obstacles : [];
    var out = [];
    list.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var x = Number(raw.x);
      var y = Number(raw.y);
      var w = Number(raw.width);
      var h = Number(raw.height);
      if (![x, y, w, h].every(isFinite)) return;
      var id = (raw.id === null || raw.id === undefined || raw.id === '')
        ? nextObstacleId(out)
        : String(raw.id);
      var index = out.length + 1;
      var name = (raw.name === null || raw.name === undefined || String(raw.name).trim() === '')
        ? '禁入区 ' + index
        : String(raw.name);
      out.push({
        id: id,
        name: name,
        x: x,
        y: y,
        width: Math.max(0, w),
        height: Math.max(0, h)
      });
    });
    return out;
  }

  /**
   * 计算单个表演者对单个轴对齐禁入矩形的连续侵入时间区间。
   * performer 与 analyzePair 入参同形（关键帧 r 缺省继承 radius）。
   * 返回 {
   *   performerId, performerName, obstacleId, obstacleName,
   *   intervals:[[t0,t1],...],   // 已合并的精确侵入区间（相切为零长度点）
   *   conflict,                  // intervals 是否非空
   *   firstEntry, lastExit       // 首次进入 / 最后离开（无侵入为 null）
   * }
   */
  function analyzeObstacle(performer, obstacle, duration) {
    var durationNum = Number(duration);
    if (!(durationNum > 0)) {
      throw new Error('duration 必须为正数');
    }
    var baseR = Math.max(0, Number(performer.radius) || 0);
    var segs = buildSegments(performer.keys, durationNum, baseR);

    var X0 = obstacle.x;
    var Y0 = obstacle.y;
    var X1 = obstacle.x + obstacle.width;
    var Y1 = obstacle.y + obstacle.height;

    var raw = [];
    segs.forEach(function (s) {
      // 以四条边界线与本线段轨迹的交点切割时间窗；子段内最近点投影形式恒定
      var cuts = [s.t0, s.t1];
      var axes = [
        { u: s.x0, v: s.vx, b0: X0, b1: X1 },
        { u: s.y0, v: s.vy, b0: Y0, b1: Y1 }
      ];
      axes.forEach(function (ax) {
        if (Math.abs(ax.v) < EPS) return;
        [ax.b0, ax.b1].forEach(function (b) {
          var tc = (b - ax.u) / ax.v;
          if (tc > s.t0 + EPS && tc < s.t1 - EPS) cuts.push(tc);
        });
      });
      cuts.sort(function (a, b) { return a - b; });

      for (var ci = 0; ci < cuts.length - 1; ci++) {
        var lo = cuts[ci];
        var hi = cuts[ci + 1];
        if (hi - lo < EPS) continue;
        var mid = (lo + hi) / 2;
        var qx, qy;
        var xm = s.x0 + s.vx * mid;
        var ym = s.y0 + s.vy * mid;
        if (xm >= X0 && xm <= X1) qx = { u: 0, v: 0 };
        else qx = { u: s.x0 - (xm < X0 ? X0 : X1), v: s.vx };
        if (ym >= Y0 && ym <= Y1) qy = { u: 0, v: 0 };
        else qy = { u: s.y0 - (ym < Y0 ? Y0 : Y1), v: s.vy };

        // |最近点偏移|² = (qx.u+qx.v·t)² + (qy.u+qy.v·t)² ≤ (s.r0+s.vr·t)²
        var vx2 = qx.v * qx.v;
        var vy2 = qy.v * qy.v;
        var A = vx2 + vy2 - s.vr * s.vr;
        var B = 2 * (qx.u * qx.v + qy.u * qy.v - s.r0 * s.vr);
        var C = qx.u * qx.u + qy.u * qy.u - s.r0 * s.r0;

        var hits = solveQuadraticLE(A, B, C, lo, hi);
        for (var i = 0; i < hits.length; i++) {
          hits[i][0] = clamp(hits[i][0], lo, hi);
          hits[i][1] = clamp(hits[i][1], lo, hi);
          raw.push(hits[i]);
        }
      }
    });

    var intervals = mergeIntervals(raw);
    return {
      performerId: performer.id,
      performerName: performer.name || performer.id,
      obstacleId: obstacle.id,
      obstacleName: obstacle.name,
      intervals: intervals,
      conflict: intervals.length > 0,
      firstEntry: intervals.length ? intervals[0][0] : null,
      lastExit: intervals.length ? intervals[intervals.length - 1][1] : null
    };
  }

  /** 查询某表演者在时刻 t 是否侵入任一（或指定）禁入矩形（供画布高亮）。 */
  function isPerformerInObstacle(entry, performerId, t) {
    if (!entry || entry.performerId !== performerId || !entry.conflict) return false;
    for (var i = 0; i < entry.intervals.length; i++) {
      var iv = entry.intervals[i];
      if (t + EPS >= iv[0] && t - EPS <= iv[1]) return true;
    }
    return false;
  }

  // ---------- 入场口令（entry cues） ----------
  //
  // 每位表演者可携带按顺序排列的"入场口令" cues：
  //   { id, x, y, width, height, winStart, winEnd }
  // 每条口令给定一个轴对齐矩形入口与允许进入的时间窗 [winStart, winEnd]。
  // 核对对象是表演者的**圆心轨迹**（与身体/安全半径无关）：
  //   - 圆心从矩形外进入矩形**内部**的时刻记为一次进入。矩形内部按开区间
  //     X0<x<X1、Y0<y<Y1 判定，因此沿边擦边、仅抵达边界/角点（贴边）一律
  //     不计进入；穿过角点进入内部则在角点时刻计入；
  //   - t=0 时圆心已在矩形内部，按 0 秒进入；
  //   - 对分段直线轨迹逐段求两个坐标开区间的交，再合并跨关键帧的相接停留，
  //     得到全部"停留段"，每段起点即一个进入时刻；
  //   - 按口令顺序匹配：触发时刻必须严格递增、落在时窗内（含端点），且同一
  //     矩形的同一次停留至多触发一条口令；前一条口令未完成后，其后各项标记
  //     为"前序未完成"；前序均完成但窗内（及其后）无有效进入的项标记为
  //     "错过时窗"。

  var CUE_ID_PREFIX = 'c';
  var CUE_EPS = 1e-7; // 时窗包含 / 触发时刻严格递增判定容差（秒）

  function nextCueId(existing) {
    var used = {};
    (existing || []).forEach(function (c) { used[c.id] = true; });
    var id;
    do {
      id = CUE_ID_PREFIX + Math.random().toString(36).slice(2, 8);
    } while (used[id]);
    return id;
  }

  /**
   * 规整入场口令：坐标/尺寸解析为有限数，width/height 钳为非负（0 宽/高的
   * 退化矩形没有内部，永远无法触发）；时间窗钳到 [0,duration]，端点倒置时
   * 自动交换；缺省 id 自动生成。返回顺序与入参一致的新数组。
   */
  function normalizeCues(cues, duration) {
    var T = Number(duration);
    if (!(T > 0)) throw new Error('duration 必须为正数');
    var list = Array.isArray(cues) ? cues : [];
    var out = [];
    list.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var x = Number(raw.x);
      var y = Number(raw.y);
      var w = Number(raw.width);
      var h = Number(raw.height);
      if (![x, y, w, h].every(isFinite)) return;
      var ws = Number(raw.winStart);
      var we = Number(raw.winEnd);
      ws = isFinite(ws) ? clamp(ws, 0, T) : 0;
      we = isFinite(we) ? clamp(we, 0, T) : T;
      if (ws > we) { var tmp = ws; ws = we; we = tmp; }
      var id = (raw.id === null || raw.id === undefined || raw.id === '')
        ? nextCueId(out)
        : String(raw.id);
      out.push({
        id: id,
        x: x,
        y: y,
        width: Math.max(0, w),
        height: Math.max(0, h),
        winStart: ws,
        winEnd: we
      });
    });
    return out;
  }

  /**
   * 求单个仿射坐标 u+v·t 在段窗 [t0,t1] 内严格落在 (lo,hi) 内的时刻区间。
   * 端点为开区间（贴边不计），返回 [a,b]（a<b）或 null。
   */
  function axisOpenInterval(u, v, lo, hi, t0, t1) {
    var a, b;
    if (Math.abs(v) < EPS) {
      // 常数坐标：严格位于边界之间，整段在内；恰在边界上 = 贴边，不计
      if (u > lo + EPS && u < hi - EPS) return [t0, t1];
      return null;
    }
    var tl = (lo - u) / v;
    var th = (hi - u) / v;
    if (tl > th) { var tmp = tl; tl = th; th = tmp; }
    // (tl, th) ∩ [t0, t1]：穿过边界的时刻本身保留为区间端点（进入时刻）
    a = Math.max(tl, t0);
    b = Math.min(th, t1);
    if (b > a + EPS) return [a, b];
    return null;
  }

  /**
   * 对已展开的活动段求圆心严格位于矩形 (X0,Y0)-(X1,Y1) 内部的停留区间：
   * 每段取 x、y 两个坐标开区间的交（矩形内部 = 两开区间之交），再把跨
   * 关键帧相接的停留合并。端点为穿越边界的极限时刻。
   */
  function stayIntervalsFromSegments(segs, X0, Y0, X1, Y1) {
    var raw = [];
    segs.forEach(function (s) {
      var ix = axisOpenInterval(s.x0, s.vx, X0, X1, s.t0, s.t1);
      if (!ix) return;
      var iy = axisOpenInterval(s.y0, s.vy, Y0, Y1, s.t0, s.t1);
      if (!iy) return;
      var lo = Math.max(ix[0], iy[0]);
      var hi = Math.min(ix[1], iy[1]);
      if (hi > lo + EPS) raw.push([lo, hi]);
    });
    return mergeIntervals(raw);
  }

  /**
   * 对分段直线圆心轨迹求严格位于某轴对齐矩形内部的全部停留区间
   * （[[a,b], ...]，已合并跨关键帧相接的停留）：
   *   - 首段 t0=0 已在内部 → 首个停留段以 0 开始；
   *   - 仅在边界/角点相切（无内部长度）→ 无结果；
   *   - 退化矩形（width=0 或 height=0）无内部 → 无结果。
   */
  function rectangleStayIntervals(performer, rect, duration) {
    var durationNum = Number(duration);
    if (!(durationNum > 0)) throw new Error('duration 必须为正数');
    var X0 = rect.x;
    var Y0 = rect.y;
    var X1 = rect.x + rect.width;
    var Y1 = rect.y + rect.height;
    if (!(X1 > X0) || !(Y1 > Y0)) return []; // 退化矩形没有内部

    var baseR = Math.max(0, Number(performer.radius) || 0);
    var segs = buildSegments(performer.keys, durationNum, baseR);
    return stayIntervalsFromSegments(segs, X0, Y0, X1, Y1).map(function (iv) {
      return [clamp(iv[0], 0, durationNum), clamp(iv[1], 0, durationNum)];
    });
  }

  /**
   * 对分段直线圆心轨迹求进入某轴对齐矩形内部的全部时刻（严格进入）。
   * 每个合并停留段的起点即一个进入时刻（语义详见 rectangleStayIntervals）。
   * 返回严格递增的时刻数组。
   */
  function rectangleEntryTimes(performer, cue, duration) {
    return rectangleStayIntervals(performer, cue, duration).map(function (iv) {
      return iv[0];
    });
  }

  /**
   * 按口令顺序评估一位表演者的全部入场口令。
   * 返回每项：
   *   { index, cue, status:'triggered'|'missed'|'blocked',
   *     triggerT,    // 已触发的进入时刻（未触发为 null）
   *     entries }    // 该入口矩形的全部圆心进入时刻（供诊断展示）
   * 规则：前序口令全部完成时本项才可触发；在严格晚于上一触发时刻、未被
   * 同一矩形同次停留占用、且落在时窗 [winStart,winEnd]（含端点）的进入中
   * 取最早者；否则记 missed（错过时窗），其后各项记 blocked（前序未完成）。
   */
  function evaluateCues(performer, duration) {
    var durationNum = Number(duration);
    if (!(durationNum > 0)) throw new Error('duration 必须为正数');
    var cues = normalizeCues(performer && performer.cues, durationNum);
    var chainBroken = false;
    var prevTrigger = null;
    var usedStays = {}; // 矩形签名 -> 已占用停留的进入时刻列表

    return cues.map(function (cue, i) {
      var sig = [cue.x, cue.y, cue.width, cue.height].join('|');
      var entries = rectangleEntryTimes(performer, cue, durationNum);
      var status;
      var triggerT = null;

      if (!chainBroken) {
        for (var k = 0; k < entries.length; k++) {
          var e = entries[k];
          // 触发时刻严格递增
          if (prevTrigger !== null && !(e > prevTrigger + CUE_EPS)) continue;
          // 时窗含端点
          if (e + CUE_EPS < cue.winStart || e - CUE_EPS > cue.winEnd) continue;
          // 同一次停留只能计一次（按矩形签名区分）
          if (usedStays[sig] && usedStays[sig].indexOf(e) >= 0) continue;
          triggerT = e;
          break;
        }
        if (triggerT !== null) {
          status = 'triggered';
          prevTrigger = triggerT;
          (usedStays[sig] = usedStays[sig] || []).push(triggerT);
        } else {
          status = 'missed';
          chainBroken = true;
        }
      } else {
        status = 'blocked';
      }

      return { index: i, cue: cue, status: status, triggerT: triggerT, entries: entries };
    });
  }

  // ---------- 道具交接时窗（handoffs） ----------
  //
  // 每项交接配置 { id, aId, bId, x, y, width, height, reach, minDuration }：
  // 两名表演者的圆心同时严格位于轴对齐交接区内部（开区间判定，贴边停留
  // 不计），且圆心间距 ≤ reach 的连续时间段即为可交接区间；跨关键帧相接
  // 的区间合并为一段，端点取进入/离开的极限时刻，仅瞬时触达（零长度
  // 区间）不计。每段 [a,b] 若 b-a ≥ minDuration（d>0），给出起始时窗
  // [a, b-d]。

  var HANDOFF_ID_PREFIX = 'h';
  var HANDOFF_EPS = 1e-7; // 最短持续秒数判定容差（秒）

  function nextHandoffId(existing) {
    var used = {};
    (existing || []).forEach(function (h) { used[h.id] = true; });
    var id;
    do {
      id = HANDOFF_ID_PREFIX + Math.random().toString(36).slice(2, 8);
    } while (used[id]);
    return id;
  }

  /**
   * 规整交接配置：aId/bId 必须为非空字符串（数字自动转字符串），缺省
   * id 自动生成；坐标/尺寸/触达距离解析为有限数，width/height/reach 钳
   * 为非负（0 宽/高的退化交接区没有内部，永不满足）；最短持续秒数
   * minDuration 必须为正有限数，否则该项被丢弃。返回顺序与入参一致。
   */
  function normalizeHandoffs(handoffs, duration) {
    var T = Number(duration);
    if (!(T > 0)) throw new Error('duration 必须为正数');
    var list = Array.isArray(handoffs) ? handoffs : [];
    var out = [];
    list.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var aId = (raw.aId === null || raw.aId === undefined) ? '' : String(raw.aId);
      var bId = (raw.bId === null || raw.bId === undefined) ? '' : String(raw.bId);
      if (!aId || !bId) return; // 必须指定两名表演者
      var x = Number(raw.x);
      var y = Number(raw.y);
      var w = Number(raw.width);
      var h = Number(raw.height);
      var reach = Number(raw.reach);
      var d = Number(raw.minDuration);
      if (![x, y, w, h, reach, d].every(isFinite)) return;
      if (!(d > 0)) return; // 最短持续秒数必须为正
      var id = (raw.id === null || raw.id === undefined || raw.id === '')
        ? nextHandoffId(out)
        : String(raw.id);
      out.push({
        id: id,
        aId: aId,
        bId: bId,
        x: x,
        y: y,
        width: Math.max(0, w),
        height: Math.max(0, h),
        reach: Math.max(0, reach),
        minDuration: d
      });
    });
    return out;
  }

  /** 两个已排序、互不重叠的区间列表的交集（升序）。 */
  function intersectIntervalLists(listA, listB) {
    var out = [];
    var i = 0;
    var j = 0;
    while (i < listA.length && j < listB.length) {
      var lo = Math.max(listA[i][0], listB[j][0]);
      var hi = Math.min(listA[i][1], listB[j][1]);
      if (hi > lo + EPS) out.push([lo, hi]);
      if (listA[i][1] < listB[j][1]) i++;
      else j++;
    }
    return out;
  }

  /**
   * 计算一项交接：两人圆心同时严格位于交接区内部且间距 ≤ reach 的
   * 连续区间，以及满足最短持续 minDuration 的起始时窗。
   * handoff 为 normalizeHandoffs 规整后的配置；pa/pb 为按 aId/bId 解析
   * 出的表演者对象（缺失或 aId===bId 时 valid=false，结果为空）。
   * 返回 {
   *   handoffId, handoff, aId, bId, aName, bName, valid,
   *   intervals: [[a,b],...],  // 可交接区间（已合并、已去零长度）
   *   windows: [[s,e],...],    // 起始时窗 [a, b-d]（仅 b-a≥d 的段）
   *   feasible                 // windows 是否非空
   * }
   */
  function analyzeHandoff(handoff, pa, pb, duration) {
    var durationNum = Number(duration);
    if (!(durationNum > 0)) throw new Error('duration 必须为正数');
    var valid = !!pa && !!pb && handoff.aId !== handoff.bId;
    var result = {
      handoffId: handoff.id,
      handoff: handoff,
      aId: handoff.aId,
      bId: handoff.bId,
      aName: pa ? (pa.name || pa.id) : handoff.aId,
      bName: pb ? (pb.name || pb.id) : handoff.bId,
      valid: valid,
      intervals: [],
      windows: [],
      feasible: false
    };
    if (!valid) return result;

    var X0 = handoff.x;
    var Y0 = handoff.y;
    var X1 = handoff.x + handoff.width;
    var Y1 = handoff.y + handoff.height;
    if (!(X1 > X0) || !(Y1 > Y0)) return result; // 退化交接区没有内部

    var segsA = buildSegments(pa.keys, durationNum, Math.max(0, Number(pa.radius) || 0));
    var segsB = buildSegments(pb.keys, durationNum, Math.max(0, Number(pb.radius) || 0));
    // 两人各自圆心严格位于交接区内部的停留区间，取交集窗
    var overlaps = intersectIntervalLists(
      stayIntervalsFromSegments(segsA, X0, Y0, X1, Y1),
      stayIntervalsFromSegments(segsB, X0, Y0, X1, Y1)
    );

    // 交集窗内两人相对位置仍是分段一次函数：|u+vt|² ≤ reach²
    // （首项系数 |v|² ≥ 0，解集恒为单区间，复用同一求根器）
    var reach = handoff.reach;
    var raw = [];
    overlaps.forEach(function (ov) {
      var i = 0;
      var j = 0;
      while (i < segsA.length && j < segsB.length) {
        var sa = segsA[i];
        var sb = segsB[j];
        var lo = Math.max(ov[0], sa.t0, sb.t0);
        var hi = Math.min(ov[1], sa.t1, sb.t1);
        if (hi - lo > EPS) {
          var ux = sa.x0 - sb.x0;
          var uy = sa.y0 - sb.y0;
          var vx = sa.vx - sb.vx;
          var vy = sa.vy - sb.vy;
          var hits = solveQuadraticLE(
            vx * vx + vy * vy,
            2 * (ux * vx + uy * vy),
            ux * ux + uy * uy - reach * reach,
            lo, hi
          );
          for (var k = 0; k < hits.length; k++) {
            hits[k][0] = clamp(hits[k][0], lo, hi);
            hits[k][1] = clamp(hits[k][1], lo, hi);
            raw.push(hits[k]);
          }
        }
        if (sa.t1 < sb.t1 - EPS) i++;
        else if (sb.t1 < sa.t1 - EPS) j++;
        else { i++; j++; }
      }
    });

    // 合并跨关键帧相接区间；仅瞬时触达（零长度）不计
    var intervals = mergeIntervals(raw).filter(function (iv) {
      return iv[1] - iv[0] > EPS;
    });
    var d = handoff.minDuration;
    var windows = [];
    intervals.forEach(function (iv) {
      if (iv[1] - iv[0] >= d - HANDOFF_EPS) {
        windows.push([iv[0], Math.max(iv[0], iv[1] - d)]);
      }
    });

    result.intervals = intervals;
    result.windows = windows;
    result.feasible = windows.length > 0;
    return result;
  }

  /** 查询时刻 t 是否处于某交接结果的可交接区间内（供画布高亮）。 */
  function isHandoffActive(result, t) {
    if (!result || !result.intervals) return false;
    for (var i = 0; i < result.intervals.length; i++) {
      var iv = result.intervals[i];
      if (t + EPS >= iv[0] && t - EPS <= iv[1]) return true;
    }
    return false;
  }

  // ---------- 区域限员（capacity zones） ----------
  //
  // 每个限员区 { id, name, x, y, width, height, limit }：轴对齐矩形 +
  // 正整数人数上限。统计对象是各位表演者的**圆心**：只有圆心严格位于
  // 矩形内部（开区间判定，贴边、仅瞬时触角、0 宽/高退化区域均不计），
  // 跨关键帧相接的连续停留合并为一次（同一人同一次停留只计一次）。
  // 对所有人的停留区间汇总进入(+1)/离开(-1)事件后做扫描线：同刻事件
  // 一并应用（同刻进出不产生瞬时超员、不产生零长度段），名单恒定且有
  // 正持续时间的区间才成段；只保留人数 > limit 的段，名单变化即分段；
  // 全程峰值只在有正持续时间的状态上取。全程解析，零采样。

  var ZONE_ID_PREFIX = 'z';
  var ZONE_EPS = 1e-7;   // 同刻进出事件归组 / 正持续时间判定容差（秒）

  function nextZoneId(existing) {
    var used = {};
    (existing || []).forEach(function (z) { used[z.id] = true; });
    var id;
    do {
      id = ZONE_ID_PREFIX + Math.random().toString(36).slice(2, 8);
    } while (used[id]);
    return id;
  }

  /**
   * 规整限员区域：坐标/尺寸解析为有限数，width/height 钳为非负（0 宽/高
   * 的退化区域没有内部，分析时永不统计）；limit 必须为正整数（有限、
   * >0，小数向下取整），否则该项丢弃；缺省 id 自动生成，缺省 name 用
   * "限员区 N"。返回顺序与入参一致的新数组。
   */
  function normalizeCapacityZones(zones) {
    var list = Array.isArray(zones) ? zones : [];
    var out = [];
    list.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var x = Number(raw.x);
      var y = Number(raw.y);
      var w = Number(raw.width);
      var h = Number(raw.height);
      var limit = Number(raw.limit);
      if (![x, y, w, h].every(isFinite)) return;
      if (!(isFinite(limit) && limit > 0)) return;
      limit = Math.floor(limit);
      if (limit < 1) return;
      var id = (raw.id === null || raw.id === undefined || raw.id === '')
        ? nextZoneId(out)
        : String(raw.id);
      var index = out.length + 1;
      var name = (raw.name === null || raw.name === undefined || String(raw.name).trim() === '')
        ? '限员区 ' + index
        : String(raw.name);
      out.push({
        id: id,
        name: name,
        x: x,
        y: y,
        width: Math.max(0, w),
        height: Math.max(0, h),
        limit: limit
      });
    });
    return out;
  }

  /**
   * 计算单个限员区域的全部在册状态与超员时间段。
   * zone 为 normalizeCapacityZones 规整后的配置；performers 为场景演员。
   * 返回 {
   *   zoneId, zoneName, limit,
   *   intervals: [{ start, end, count, members:[{id,name}] }],  // 超员段（正持续、count>limit，按开始升序）
   *   overcrowded,              // intervals 是否非空
   *   firstStart,               // 首个超员段起点（无则 null）
   *   peak,                     // 全程峰值人数（只计有正持续时间的状态）
   *   peakT,                    // 峰值状态的开始时刻（无正持续状态为 null）
   *   peakMembers               // 峰值状态名单（无则空数组）
   * }
   */
  function analyzeCapacityZone(zone, performers, duration) {
    var durationNum = Number(duration);
    if (!(durationNum > 0)) throw new Error('duration 必须为正数');
    var limit = zone.limit;
    var result = {
      zoneId: zone.id,
      zoneName: zone.name,
      limit: limit,
      intervals: [],
      overcrowded: false,
      firstStart: null,
      peak: 0,
      peakT: null,
      peakMembers: []
    };

    // 收集全部进入(+1)/离开(-1)事件：每人各自的圆心停留区间（已合并
    // 跨关键帧相接的停留），同一次停留同一人自然只产生一对事件
    var events = [];
    (performers || []).forEach(function (p) {
      var stays = rectangleStayIntervals(p, zone, durationNum);
      stays.forEach(function (iv) {
        events.push({ t: iv[0], delta: 1, performer: p });
        events.push({ t: iv[1], delta: -1, performer: p });
      });
    });
    events.sort(function (a, b) {
      return a.t - b.t || (b.delta - a.delta); // 时刻相同仅为稳定次序，仍按组一并应用
    });

    var present = {}; // performerId -> { id, name }
    var segStart = 0;
    var segMembers = [];

    function memberList() {
      // 名单按场景内表演者次序给出，便于稳定展示与断言
      var list = [];
      (performers || []).forEach(function (p) {
        if (present[p.id]) list.push({ id: p.id, name: p.name || p.id });
      });
      return list;
    }

    // 关闭 [segStart, t) 状态：只统计有正持续时间的恒定状态
    function closeSegment(t) {
      if (t - segStart > ZONE_EPS) {
        var members = segMembers;
        var count = members.length;
        if (count > limit) {
          result.intervals.push({
            start: segStart,
            end: t,
            count: count,
            members: members.map(function (m) { return { id: m.id, name: m.name }; })
          });
        }
        if (count > result.peak) {
          result.peak = count;
          result.peakT = segStart;
          result.peakMembers = members.map(function (m) { return { id: m.id, name: m.name }; });
        }
      }
    }

    var i = 0;
    while (i < events.length) {
      var t = events[i].t;
      // 前一组状态在 [segStart, t) 上恒定（开场即进入的事件在 t=0，
      // closeSegment(0) 为零持续、自动跳过）
      closeSegment(t);
      // 同一时刻的全部进出（含跨段解析的浮点同级端点）一并应用：
      // 一进一出互相抵消，不产生瞬时超员也不产生零长度段
      var j = i;
      while (j < events.length &&
             Math.abs(events[j].t - t) <= ZONE_EPS + MERGE_REL * Math.max(Math.abs(t), 1)) {
        var ev = events[j];
        if (ev.delta > 0) {
          if (!present[ev.performer.id]) {
            present[ev.performer.id] = { id: ev.performer.id, name: ev.performer.name || ev.performer.id };
          }
        } else {
          delete present[ev.performer.id];
        }
        j++;
      }
      segStart = t;
      segMembers = memberList();
      i = j;
    }
    closeSegment(durationNum); // 收场前最后一个恒定状态（零持续自动跳过）

    result.overcrowded = result.intervals.length > 0;
    result.firstStart = result.intervals.length ? result.intervals[0].start : null;
    return result;
  }

  /** 查询时刻 t 某限员结果是否处于超员段内（供画布高亮）。 */
  function isCapacityOverAt(result, t) {
    if (!result || !result.intervals) return false;
    for (var i = 0; i < result.intervals.length; i++) {
      var iv = result.intervals[i];
      if (t + EPS >= iv.start && t - EPS <= iv.end) return true;
    }
    return false;
  }

  // ---------- 风险叠加时间轴（risk overlay timeline） ----------
  //
  // 复用三类既有分析区间——双人**碰撞**（pairs[].intervals）、
  // **禁入区侵入**（obstacleConflicts[].intervals）与**区域超员**
  // （capacityResults[].intervals，名单变化已由扫描线分段）——把全部生效
  // 风险投影到统一时刻轴，用 +1/−1 事件扫描线合成为**按时间排序、互不
  // 重叠**的风险段：
  //
  //   - 每个风险来源（一对碰撞 / 一人×一禁入区 / 一个限员区超员状态）
  //     的每个正持续区间产生一对进入(+1)/离开(−1)事件；**零长度区间
  //     （相切点/瞬时触角）整体舍弃**，既不成段也不切割其它风险；
  //   - 同一时刻（含跨解析浮点同级误差）的开始与结束事件归为一组、
  //     **统一结算**：不产生零长度风险段，也不产生零长度空窗；
  //   - 相邻事件组之间"生效风险来源集合 + 涉及人员并集"恒定，即一段；
  //     **生效风险来源变化或涉及人员变化立即分段**（来源不变而仅人员
  //     名单变化同样分段，如限员区两人组换为另两人）；
  //   - 风险为空的时段不产生任何段；段按起点升序，段内来源按类型
  //     （碰撞→禁入侵入→区域超员）与首次出现次序排列，涉及人员按
  //     场景内表演者次序去重排列。
  //
  // 全程只做区间端点事件归并（无离散帧抽样）；浏览器侧栏与
  // POST /api/analyze 返回同一份结果。

  var RISK_EPS = 1e-7; // 同刻事件归组 / 正持续段判定容差（秒）
  var RISK_KEY_SEP = '';
  var RISK_TYPE_RANK = { collision: 0, obstacle: 1, capacity: 2 };

  /** 按场景内表演者次序对人员去重排序（缺 performers 时退化为按 id 排序）。 */
  function orderRiskMembers(members, performers) {
    var indexMap = {};
    (performers || []).forEach(function (p, i) {
      indexMap[String(p.id)] = i;
    });
    var seen = {};
    var out = [];
    members.forEach(function (m) {
      var id = String(m.id);
      if (seen[id]) return;
      seen[id] = true;
      out.push({ id: m.id, name: m.name || String(m.id), _idx: indexMap[id] });
    });
    out.sort(function (a, b) {
      var ia = a._idx === undefined ? Infinity : a._idx;
      var ib = b._idx === undefined ? Infinity : b._idx;
      if (ia !== ib) return ia - ib;
      return String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0);
    });
    return out.map(function (m) { return { id: m.id, name: m.name }; });
  }

  /**
   * 把三类风险分析结果合成为互不重叠的风险叠加时间轴。
   * analysis: { pairs?, obstacleConflicts?, capacityResults? }（analyzeScene
   *           返回对象的子集即可，便于直接传入完整分析结果）；
   * performers: 场景表演者（提供人员次序，可缺省）；
   * duration: 场景总时长（事件端点钳到 [0,duration]）。
   * 返回 [{
   *   start, end,
   *   sources: [{ type:'collision'|'obstacle'|'capacity', typeLabel, label,
   *               members:[{id,name}] }],
   *   members: [{id,name}]   // 段内全部来源涉及人员的并集（去重、按场景次序）
   * }]，按 start 升序、互不重叠；无任何风险时为 []。
   */
  function buildRiskTimeline(analysis, performers, duration) {
    var T = Number(duration);
    if (!(T > 0)) throw new Error('duration 必须为正数');
    analysis = analysis || {};
    var events = [];
    var seq = 0;

    function addSource(type, typeLabel, key, label, members, intervals) {
      if (!intervals || !intervals.length) return;
      var src = {
        type: type,
        typeLabel: typeLabel,
        key: type + RISK_KEY_SEP + key,
        label: label,
        members: orderRiskMembers(members, performers),
        seq: seq++
      };
      intervals.forEach(function (iv) {
        var a = clamp(Number(iv[0]), 0, T);
        var b = clamp(Number(iv[1]), 0, T);
        // 舍弃零长度段（相切点/瞬时触角）：不产生事件，也不切割其它风险
        if (!(b - a > RISK_EPS)) return;
        events.push({ t: a, delta: 1, src: src });
        events.push({ t: b, delta: -1, src: src });
      });
    }

    // 碰撞：每一对（仅 collision=true）的合并碰撞区间；零长度相切点舍弃
    (analysis.pairs || []).forEach(function (pair) {
      if (!pair.collision) return;
      var ids = [String(pair.aId), String(pair.bId)].sort();
      addSource(
        'collision', '碰撞',
        'c' + RISK_KEY_SEP + ids.join(RISK_KEY_SEP),
        (pair.aName || pair.aId) + ' × ' + (pair.bName || pair.bId),
        [
          { id: pair.aId, name: pair.aName || pair.aId },
          { id: pair.bId, name: pair.bName || pair.bId }
        ],
        pair.intervals
      );
    });

    // 禁入区侵入：每位表演者 × 每个矩形的连续侵入区间；零长度角点相切舍弃
    (analysis.obstacleConflicts || []).forEach(function (entry) {
      if (!entry.conflict) return;
      addSource(
        'obstacle', '禁入侵入',
        'o' + RISK_KEY_SEP + entry.performerId + RISK_KEY_SEP + entry.obstacleId,
        entry.obstacleName,
        [{ id: entry.performerId, name: entry.performerName || entry.performerId }],
        entry.intervals
      );
    });

    // 区域超员：analyzeCapacityZone 已按名单变化分段、剔除零长度段，
    // 同一限员区的相邻超员状态名单不同 → 用段序号区分来源 key，
    // 使"来源或人员变化即分段"在统一扫描线里自然成立
    (analysis.capacityResults || []).forEach(function (res) {
      res.intervals.forEach(function (iv, idx) {
        addSource(
          'capacity', '区域超员',
          'z' + RISK_KEY_SEP + res.zoneId + RISK_KEY_SEP + idx,
          res.zoneName + '（' + iv.count + ' 人）',
          iv.members.map(function (m) { return { id: m.id, name: m.name || m.id }; }),
          [[iv.start, iv.end]]
        );
      });
    });

    events.sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      if (a.delta !== b.delta) return b.delta - a.delta; // 同刻先开始后结束（稳定次序，组内仍统一应用）
      return a.src.key < b.src.key ? -1 : (a.src.key > b.src.key ? 1 : 0);
    });

    var active = {}; // src.key -> src
    var segments = [];
    var segStart = null;
    var segSnapshot = null;

    function snapshot() {
      var keys = Object.keys(active).sort();
      if (!keys.length) return null;
      var sources = keys.map(function (k) { return active[k]; });
      sources.sort(function (x, y) {
        if (x.type !== y.type) return RISK_TYPE_RANK[x.type] - RISK_TYPE_RANK[y.type];
        if (x.seq !== y.seq) return x.seq - y.seq;
        return x.label < y.label ? -1 : (x.label > y.label ? 1 : 0);
      });
      var union = [];
      sources.forEach(function (s) {
        s.members.forEach(function (m) { union.push(m); });
      });
      return {
        keysSig: keys.join(RISK_KEY_SEP),
        sources: sources.map(function (s) {
          return { type: s.type, typeLabel: s.typeLabel, label: s.label, members: s.members };
        }),
        members: orderRiskMembers(union, performers)
      };
    }

    function closeAt(t) {
      if (segStart === null || segSnapshot === null) return;
      // 仅保留正持续时间段（统一结算下的零长段/空窗自动丢弃）
      if (t - segStart > RISK_EPS) {
        segments.push({
          start: segStart,
          end: t,
          sources: segSnapshot.sources,
          members: segSnapshot.members
        });
      }
      segStart = null;
      segSnapshot = null;
    }

    var i = 0;
    while (i < events.length) {
      var t = events[i].t;
      // 同刻事件（含跨解析浮点同级误差）归为一组
      var j = i;
      while (j < events.length &&
             Math.abs(events[j].t - t) <= RISK_EPS + MERGE_REL * Math.max(Math.abs(t), 1)) {
        j++;
      }
      // 结算组前状态：上一段 [segStart, t) 恒定
      closeAt(t);
      // 统一应用整组开始/结束（同刻一进一出不在中间产生瞬时状态）
      for (var k = i; k < j; k++) {
        var ev = events[k];
        if (ev.delta > 0) active[ev.src.key] = ev.src;
        else delete active[ev.src.key];
      }
      // 结算组后状态非空才另起一段
      var after = snapshot();
      if (after) {
        segStart = t;
        segSnapshot = after;
      }
      i = j;
    }
    closeAt(T); // 收场：钳制端点/持续到末时刻的风险段

    return segments;
  }

  /** 查询时刻 t 是否落在某风险叠加段内（供侧栏行高亮）。 */
  function isRiskSegmentActive(seg, t) {
    if (!seg) return false;
    return t + RISK_EPS >= seg.start && t - RISK_EPS <= seg.end;
  }

  // ---------- 方案快照：两场景对比 ----------

  var DIFF_EPS = 1e-6;   // 区间端点"时间变化"判定容差（秒）
  var DIFF_KEY_SEP = '\u0001'; // 名字配对键分隔符（正常名字中不会出现）

  function performerNameMap(performers) {
    // 同名配对：重名时以后出现者为准（UI 侧名称由用户自行区分）
    var map = {};
    (performers || []).forEach(function (p) {
      map[String(p.name || p.id)] = p;
    });
    return map;
  }

  function performerNames(performers) {
    var seen = {};
    var out = [];
    (performers || []).forEach(function (p) {
      var n = String(p.name || p.id);
      if (!seen[n]) { seen[n] = true; out.push(n); }
    });
    return out;
  }

  /**
   * 在统一时刻轴上求同一表演者两套关键帧的位置偏移模
   *     Δ(t) = |pA(t) − pB(t)|
   * 最大值。两侧位置在相邻关键帧间都是 t 的一次函数，故差值仍为一次、
   * 其模为凸函数——每段最大值必在段端点，只需考察双方关键帧时刻
   * （含 0 与两侧时长）的并集即可精确得到全局最大，不做时间采样。
   * 帧外按段外静止语义保持末帧位置（与 buildSegments 一致）。
   */
  function maxPositionOffset(pa, pb, durationA, durationB) {
    var ksA = normalizeKeys(pa.keys);
    var ksB = normalizeKeys(pb.keys);
    var T = Math.max(durationA, durationB);
    var times = [0, durationA, durationB, T];
    ksA.forEach(function (k) { if (k.t >= -EPS && k.t <= T + EPS) times.push(Math.max(0, k.t)); });
    ksB.forEach(function (k) { if (k.t >= -EPS && k.t <= T + EPS) times.push(Math.max(0, k.t)); });
    times.sort(function (a, b) { return a - b; });

    var best = -1;
    var bestT = 0;
    var prev = null;
    for (var i = 0; i < times.length; i++) {
      var t = times[i];
      if (prev !== null && t - prev < EPS) continue;
      prev = t;
      var qa = positionAt(ksA, t);
      var qb = positionAt(ksB, t);
      var off = Math.sqrt((qa.x - qb.x) * (qa.x - qb.x) + (qa.y - qb.y) * (qa.y - qb.y));
      if (off > best + EPS) { best = off; bestT = t; }
    }
    if (best < 0) best = 0;
    return { maxOffset: best, maxOffsetT: bestT };
  }

  function intervalsEqual(a, b) {
    var tol = DIFF_EPS + MERGE_REL * Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), 1);
    return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  }

  /**
   * 两组已合并区间的差分：按最大时间重叠贪心配对
   * （零长度相切区间与包含它的区间也可配对）。
   * 返回 { added:新方案独有, removed:旧方案独有,
   *        changed:[{from:[a,b], to:[a',b']}]（端点变化）}。
   */
  function diffIntervalLists(oldIv, newIv) {
    var used = oldIv.map(function () { return false; });
    var added = [];
    var changed = [];

    newIv.forEach(function (nv) {
      var bi = -1;
      var bestOv = -Infinity;
      for (var i = 0; i < oldIv.length; i++) {
        if (used[i]) continue;
        var ov = Math.min(oldIv[i][1], nv[1]) - Math.max(oldIv[i][0], nv[0]);
        // ov≥-EPS 即可配：含端点相接（零长度相切点落在另一区间上）
        if (ov >= -DIFF_EPS && ov > bestOv) { bestOv = ov; bi = i; }
      }
      if (bi < 0) {
        added.push(nv.slice());
        return;
      }
      used[bi] = true;
      if (!intervalsEqual(oldIv[bi], nv)) {
        changed.push({ from: oldIv[bi].slice(), to: nv.slice() });
      }
    });

    var removed = [];
    for (var j = 0; j < oldIv.length; j++) {
      if (!used[j]) removed.push(oldIv[j].slice());
    }
    return { added: added, removed: removed, changed: changed };
  }

  function firstIvStart(list) {
    return list && list.length ? list[0][0] : Infinity;
  }

  /**
   * 方案快照对比（浏览器/Node 通用，零依赖）。
   * sceneA 为基准方案（方案 1），sceneB 为新方案（方案 2）：
   *  - 同名表演者关键帧在统一时刻轴 [0, max(dA,dB)] 上线性插值，
   *    逐人给位置偏移最大值与发生时刻，并给全局最大；
   *  - 碰撞对按两人名字配对，分 added（仅方案 2 碰撞）/ removed
   *    （仅方案 1 碰撞）/ changed（都碰撞但区间端点变化）；
   *  - 禁入区间按 表演者名 × 矩形名 配对，分类同上；
   *  - 表演者、矩形本身的增删单列。
   * 返回：
   * { duration, durationA, durationB,
   *   performers:[{name,presentA,presentB,maxOffset,maxOffsetT}]（偏移降序），
   *   maxOffset/maxOffsetT/maxOffsetPerformer,
   *   pairs:{added,removed,changed,unchangedCount},
   *   obstacleIntrusions:{added,removed,changed,unchangedCount},
   *   addedPerformers,removedPerformers,addedObstacles,removedObstacles }
   */
  function compareScenes(sceneA, sceneB) {
    var dA = Number(sceneA && sceneA.duration);
    var dB = Number(sceneB && sceneB.duration);
    if (!(dA > 0) || !(dB > 0)) throw new Error('duration 必须为正数');
    var T = Math.max(dA, dB);

    var perfA = sceneA.performers || [];
    var perfB = sceneB.performers || [];
    var mapA = performerNameMap(perfA);
    var mapB = performerNameMap(perfB);

    var namesA = performerNames(perfA);
    var namesB = performerNames(perfB);
    var nameSetA = {}; namesA.forEach(function (n) { nameSetA[n] = true; });
    var nameSetB = {}; namesB.forEach(function (n) { nameSetB[n] = true; });
    var allNames = namesA.slice();
    namesB.forEach(function (n) { if (!nameSetA[n]) allNames.push(n); });

    var performerDiffs = [];
    allNames.forEach(function (name) {
      var inA = !!mapA[name];
      var inB = !!mapB[name];
      if (inA && inB) {
        var mo = maxPositionOffset(mapA[name], mapB[name], dA, dB);
        performerDiffs.push({
          name: name, presentA: true, presentB: true,
          maxOffset: mo.maxOffset, maxOffsetT: mo.maxOffsetT
        });
      } else {
        performerDiffs.push({
          name: name, presentA: inA, presentB: inB,
          maxOffset: null, maxOffsetT: null
        });
      }
    });
    // 双方共有者按偏移降序（并列按名字稳定），仅单侧存在者附后
    performerDiffs.sort(function (x, y) {
      if (x.maxOffset === null && y.maxOffset === null) return x.name < y.name ? -1 : (x.name > y.name ? 1 : 0);
      if (x.maxOffset === null) return 1;
      if (y.maxOffset === null) return -1;
      if (Math.abs(y.maxOffset - x.maxOffset) > EPS) return y.maxOffset - x.maxOffset;
      if (Math.abs(y.maxOffsetT - x.maxOffsetT) > EPS) return x.maxOffsetT - y.maxOffsetT;
      return x.name < y.name ? -1 : (x.name > y.name ? 1 : 0);
    });
    var common = performerDiffs.filter(function (d) { return d.maxOffset !== null; });
    var globalMax = common.length ? common[0] : null;

    // —— 碰撞对差分（按双方表演者名字配对）——
    var anA = analyzeScene({ duration: dA, performers: perfA, obstacles: sceneA.obstacles });
    var anB = analyzeScene({ duration: dB, performers: perfB, obstacles: sceneB.obstacles });

    function pairIndex(analysis) {
      var map = {};
      analysis.pairs.forEach(function (p) {
        var key = [p.aName, p.bName].sort().join(DIFF_KEY_SEP);
        map[key] = p;
      });
      return map;
    }

    var piA = pairIndex(anA);
    var piB = pairIndex(anB);
    var pairKeys = Object.keys(piA);
    Object.keys(piB).forEach(function (k) { if (piA[k] === undefined) pairKeys.push(k); });
    pairKeys.sort();

    var pairs = { added: [], removed: [], changed: [], unchangedCount: 0 };
    pairKeys.forEach(function (key) {
      var pa = piA[key];
      var pb = piB[key];
      if (!pa || !pb) return; // 有一方缺该表演者：随 addedPerformers 列出
      var names = key.split(DIFF_KEY_SEP);
      if (pa.collision && pb.collision) {
        var dc = diffIntervalLists(pa.intervals, pb.intervals);
        if (!dc.added.length && !dc.removed.length && !dc.changed.length) {
          pairs.unchangedCount++;
        } else {
          pairs.changed.push(Object.assign({ names: names }, dc));
        }
      } else if (pb.collision) {
        pairs.added.push({ names: names, intervals: pb.intervals.map(function (iv) { return iv.slice(); }) });
      } else if (pa.collision) {
        pairs.removed.push({ names: names, intervals: pa.intervals.map(function (iv) { return iv.slice(); }) });
      }
    });
    pairs.added.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    pairs.removed.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    pairs.changed.sort(function (a, b) {
      return firstIvStart(flatNew(a)) - firstIvStart(flatNew(b));
    });
    function flatNew(c) {
      if (c.added.length) return c.added[0];
      if (c.changed.length) return c.changed[0].to;
      return c.removed.length ? c.removed[0] : [Infinity, Infinity];
    }

    // —— 禁入区间差分（表演者名 × 矩形名）——
    function obstacleIndex(analysis) {
      var map = {};
      analysis.obstacleConflicts.forEach(function (e) {
        map[e.performerName + DIFF_KEY_SEP + e.obstacleName] = e;
      });
      return map;
    }
    var oiA = obstacleIndex(anA);
    var oiB = obstacleIndex(anB);
    var oKeys = Object.keys(oiA);
    Object.keys(oiB).forEach(function (k) { if (oiA[k] === undefined) oKeys.push(k); });
    oKeys.sort();

    var obsNamesA = {};
    normalizeObstacles(sceneA.obstacles).forEach(function (o) { obsNamesA[o.name] = true; });
    var obsNamesB = {};
    normalizeObstacles(sceneB.obstacles).forEach(function (o) { obsNamesB[o.name] = true; });

    var obsDiff = { added: [], removed: [], changed: [], unchangedCount: 0 };
    oKeys.forEach(function (key) {
      var ea = oiA[key];
      var eb = oiB[key];
      if (!ea || !eb) return; // 表演者或矩形仅单侧存在：随增删名单列出
      var parts = key.split(DIFF_KEY_SEP);
      var item = { performerName: parts[0], obstacleName: parts[1] };
      if (ea.conflict && eb.conflict) {
        var dc = diffIntervalLists(ea.intervals, eb.intervals);
        if (!dc.added.length && !dc.removed.length && !dc.changed.length) {
          obsDiff.unchangedCount++;
        } else {
          obsDiff.changed.push(Object.assign({}, item, dc));
        }
      } else if (eb.conflict) {
        obsDiff.added.push(Object.assign({}, item, { intervals: eb.intervals.map(function (iv) { return iv.slice(); }) }));
      } else if (ea.conflict) {
        obsDiff.removed.push(Object.assign({}, item, { intervals: ea.intervals.map(function (iv) { return iv.slice(); }) }));
      }
    });
    obsDiff.added.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    obsDiff.removed.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    obsDiff.changed.sort(function (a, b) { return firstIvStart(flatNew(a)) - firstIvStart(flatNew(b)); });

    return {
      duration: T,
      durationA: dA,
      durationB: dB,
      performers: performerDiffs,
      maxOffset: globalMax ? globalMax.maxOffset : null,
      maxOffsetT: globalMax ? globalMax.maxOffsetT : null,
      maxOffsetPerformer: globalMax ? globalMax.name : null,
      pairs: pairs,
      obstacleIntrusions: obsDiff,
      addedPerformers: namesB.filter(function (n) { return !nameSetA[n]; }),
      removedPerformers: namesA.filter(function (n) { return !nameSetB[n]; }),
      addedObstacles: Object.keys(obsNamesB).filter(function (n) { return !obsNamesA[n]; }).sort(),
      removedObstacles: Object.keys(obsNamesA).filter(function (n) { return !obsNamesB[n]; }).sort()
    };
  }

  /**
   * 内置交叉样例（4 人，时长 12s，世界 1000×600）：
   *  - 甲（水平横穿）与乙（竖直纵穿）路径十字交叉，在 t=6 同时到达交点 -> 相撞
   *  - 丙为错峰折线，几何路径与甲/乙相交但到达时刻错开 -> 不撞；
   *    t=8 关键帧安全半径 20→60，表现到位后展开道具（占用范围线性张开），
   *    张开段与各路径仍保持安全间距
   *  - 丁起初与丙分离，约 t=2.6 起追上丙并保持贴近 -> 持续碰撞（相对静止退化段）
   *  - 中央禁入矩形覆盖十字交点：甲、乙按实时安全半径先后进入（演示禁入区分析），
   *    丙、丁错峰折线从对角掠过，不侵入
   *  - 另附**入场口令**样例：甲对中央入口矩形有三条连续口令（t≈5.18 触发、
   *    错过 6～8s 时窗、第三项前序未完成），乙有一条 4.5～5s 时窗口令
   *    （t≈4.62 触发）；口令核对只看圆心，沿边擦边不计。
   *  - 另附一项**道具交接**：甲×乙、中央交接区（与禁入区同框，语义不同），
   *    触达距离 80、最短持续 0.5s；两人圆心同时严格在区内且间距≤80 的
   *    区间约为 [5.18, 6.82]，给出起始时窗 [5.18, 6.32]。
   *  - 另附一个**区域限员**：中央限员区（与交接区同框，语义不同）上限
   *    1 人；甲、乙圆心同时在内部的约 [5.18, 6.82] 为唯一超员段，
   *    峰值 2 人，丙、丁从不进入。
   */
  function builtinScene() {
    return {
      duration: 12,
      world: { width: 1000, height: 600 },
      obstacles: [
        { id: 'o1', name: '中央禁入区', x: 440, y: 240, width: 120, height: 120 }
      ],
      handoffs: [
        {
          id: 'h1',
          aId: 'p1',
          bId: 'p2',
          x: 440,
          y: 240,
          width: 120,
          height: 120,
          reach: 80,
          minDuration: 0.5
        }
      ],
      // 中央区域限员 1 人：甲（横贯）与乙（纵穿）圆心同时严格位于
      // (440,560)×(240,360) 内的时段约为 t∈[5.18, 6.82]，构成唯一超员段，
      // 全程峰值 2 人；丙、丁的错峰折线圆心从不进入该区域内部。
      capacityZones: [
        { id: 'z1', name: '中央限员区', x: 440, y: 240, width: 120, height: 120, limit: 1 }
      ],
      performers: [
        {
          id: 'p1',
          name: '甲·横贯',
          color: '#ef4444',
          radius: 20,
          cues: [
            { id: 'c1', x: 440, y: 240, width: 120, height: 120, winStart: 4, winEnd: 6 },
            { id: 'c2', x: 440, y: 240, width: 120, height: 120, winStart: 6, winEnd: 8 },
            { id: 'c3', x: 440, y: 240, width: 120, height: 120, winStart: 8, winEnd: 12 }
          ],
          keys: [
            { t: 0, x: 60, y: 300 },
            { t: 12, x: 940, y: 300 }
          ]
        },
        {
          id: 'p2',
          name: '乙·纵穿',
          color: '#38bdf8',
          radius: 20,
          cues: [
            { id: 'c4', x: 440, y: 240, width: 120, height: 120, winStart: 4.5, winEnd: 5 }
          ],
          keys: [
            { t: 0, x: 500, y: 40 },
            { t: 12, x: 500, y: 560 }
          ]
        },
        {
          id: 'p3',
          name: '丙·错峰展伞',
          color: '#22c55e',
          radius: 20,
          keys: [
            { t: 0, x: 60, y: 540 },
            { t: 4, x: 500, y: 60 },
            { t: 8, x: 940, y: 540, r: 60 }
          ]
        },
        {
          id: 'p4',
          name: '丁·跟进',
          color: '#facc15',
          radius: 20,
          keys: [
            { t: 0, x: 160, y: 540 },
            { t: 4, x: 500, y: 90 },
            { t: 8, x: 940, y: 570 }
          ]
        }
      ]
    };
  }

  return {
    EPS: EPS,
    normalizeKeys: normalizeKeys,
    positionAt: positionAt,
    radiusAt: radiusAt,
    stateAt: stateAt,
    buildSegments: buildSegments,
    solveQuadraticLE: solveQuadraticLE,
    analyzePair: analyzePair,
    analyzeScene: analyzeScene,
    isPerformerInCollision: isPerformerInCollision,
    normalizeObstacles: normalizeObstacles,
    analyzeObstacle: analyzeObstacle,
    isPerformerInObstacle: isPerformerInObstacle,
    normalizeCues: normalizeCues,
    rectangleEntryTimes: rectangleEntryTimes,
    rectangleStayIntervals: rectangleStayIntervals,
    evaluateCues: evaluateCues,
    normalizeHandoffs: normalizeHandoffs,
    analyzeHandoff: analyzeHandoff,
    isHandoffActive: isHandoffActive,
    normalizeCapacityZones: normalizeCapacityZones,
    analyzeCapacityZone: analyzeCapacityZone,
    isCapacityOverAt: isCapacityOverAt,
    buildRiskTimeline: buildRiskTimeline,
    isRiskSegmentActive: isRiskSegmentActive,
    compareScenes: compareScenes,
    builtinScene: builtinScene
  };
});
