'use strict';
/*
 * nori-hub/index.js —— 枢纽管线（S1→S7）+ shadow 模式
 * ==========================================================================
 * 本文件是 B3 的载体。三档模式（`NORI_HUB`）：
 *
 *   off     完全不介入（= 今天之前的行文，一行都不跑）
 *   shadow  ★ B3 默认：**跑完整管线 + 逐字节比对**，但**始终发送原帧**
 *           ⇒ 既证明"管线是透明的"，又保证**零风险**（原帧永远是出站的那个）
 *   on      真正应用决策（C 阶段才用；现在不启用）
 *
 * 为什么 shadow 用"比对但不替换"而不是"全 pass 后替换"（§86 §7 G2 的原方案）
 *   "策略全 pass ⇒ 应用后应逐字节不变"是一种**推断**；
 *   而"我压根不替换，只比对"是**构造性保证**。
 *   ⇒ B3 的目的是"证明重组不破坏帧"，用后者更硬：
 *     它把"改坏了"从"可能出现的事故"变成"日志里的一行告警"。
 *
 * 铁律
 *   1. off/shadow 下**绝不修改任何帧**（shadow 里的 apply 只写副本）
 *   2. 异常一律吞掉（`try/catch`）—— 观测层**绝不允许**影响主链路
 *   3. 每条决策都留 `reason`（可解释）
 */

const policy = require('./policy');
const { extractUnits, hitLinePaths } = require('./extract');

const MODE = String(process.env.NORI_HUB || 'shadow').toLowerCase();
const ON = MODE !== 'off';
const SHADOW = MODE === 'shadow';
const ACTIVE = MODE === 'on';

const LOG = !/^(off|0|no|false)$/i.test(String(process.env.NORI_HUB_LOG || 'on'));

/* ── 统计（供只读端点查看）──────────────────────────────────────────── */
const stats = {
  mode: MODE,
  frames: 0,          // 过管线的帧
  withUnits: 0,       // 产出过单元的帧
  units: 0,
  byKind: Object.create(null),
  byRoute: Object.create(null),   // 命中的"能写 lines"路径
  mismatches: 0,      // ★ shadow 下"应用后会变"的次数（>0 就是有 bug）
  errors: 0,
  firstMismatch: null,
  startedAt: Date.now(),
};

/* ── 深拷贝（只用于 shadow 的 apply 副本）──────────────────────────────── */
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ── S7：应用（★ 当前实现 = 恒等；C 阶段在这里按决策改写）────────────────
 * 现在**故意不实现任何改写** —— B3 只验证"管线透明"。
 * 返回值：{ out, changed, changes:[{index,kind,outlets,reason}] }
 */
function apply(frame, units, decisions) {
  const out = clone(frame);
  const changes = [];
  /* B3 阶段：不做任何实际改写。
   * C 阶段会在这里按 decision.outlets 执行：
   *   · E1=false 且 writesLines ⇒ 从 /lines 中**精确删除该条**（★ 绝不整帧丢弃）
   *   · E1=false 且是 cmd/event ⇒ 按 T4 的教训逐条补过滤
   * 现在留空 ⇒ apply 恒等 ⇒ shadow 比对必然 0 差异。
   */
  return { out, changed: changes.length > 0, changes };
}

/**
 * 主入口：处理一帧（★ 只读，除返回值外无副作用）
 * @param {object|string} frame
 * @param {'in'|'out'} dir
 * @returns {{units:Array, decisions:Array, changed:boolean, out:object, routes:string[]}|null}
 */
function runFrame(frame, dir) {
  if (!ON) return null;
  try {
    stats.frames++;
    let j = frame;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { stats.errors++; return null; } }
    if (!j || typeof j !== 'object') return null;

    /* S1 提取 + S2 分类 */
    const units = extractUnits(j, dir);
    /* S3~S5 决策 */
    const decisions = units.map((u) => {
      const d = policy.decide(u);
      stats.byKind[u.kind] = (stats.byKind[u.kind] || 0) + 1;
      return d;
    });
    if (units.length) stats.withUnits++;
    stats.units += units.length;

    const routes = hitLinePaths(units);
    for (const r of routes) stats.byRoute[r] = (stats.byRoute[r] || 0) + 1;

    /* S6 隔离（C 阶段：白名单 drop+log）—— B3 阶段只统计，不拦截 */

    /* S7 应用 */
    const { out, changed, changes } = apply(j, units, decisions);

    /* ★ shadow 的核心：比对。任何差异都是 bug（因为 apply 现在恒等） */
    if (SHADOW) {
      const a = JSON.stringify(j);
      const b = JSON.stringify(out);
      if (a !== b) {
        stats.mismatches++;
        if (stats.mismatches === 1) {
          /* ★ 只告警一次（避免刷屏）——但统计计数会一直涨，且能从 /nori-hubstat 看到 */
          stats.firstMismatch = { cart: j.cartridgeId || '', type: j.type || '', dir, aLen: a.length, bLen: b.length };
          if (LOG) {
            try {
              console.log('★★★ HUB shadow 检出差异（B3 失败信号）'
                + ' dir=' + dir + ' type=' + (j.type || '-') + ' cart=' + (j.cartridgeId || '-')
                + ' len ' + a.length + '→' + b.length + '  ⇒ 管线不再透明，请查 nori-hub/');
            } catch (e) {}
          }
        }
      }
    }

    return { units, decisions, changed, changes, out, routes };
  } catch (e) {
    stats.errors++;
    return null;
  }
}

/* ── 一行摘要（shadow 告警用）──────────────────────────────────────────
 * @returns {string|null} 仅在"值得说"的时候返回（避免刷屏）
 */
function shadowNote(result, dir) {
  if (!SHADOW || !result) return null;
  const kinds = {};
  for (const u of result.units) kinds[u.kind] = (kinds[u.kind] || 0) + 1;
  const parts = Object.entries(kinds).map(([k, v]) => k + ':' + v).join(' ');
  if (!parts) return null;
  return 'HUB ' + dir + ' units=' + result.units.length + ' {' + parts + '}'
    + (result.routes.length ? ' routes=' + result.routes.join(',') : '');
}

function getStats() {
  return JSON.parse(JSON.stringify(stats));
}

/* ── 策略表 vs 现行代码的差异（B1 验收：一眼看还有哪些洞）──────────────── */
function gaps() { return policy.currentGaps(); }

module.exports = {
  process: runFrame, runFrame, apply, getStats, gaps, shadowNote,
  MODE, ON, SHADOW, ACTIVE, LOG,
  // 便于单测/工具直接取用
  policy, extract: require('./extract'),
};
