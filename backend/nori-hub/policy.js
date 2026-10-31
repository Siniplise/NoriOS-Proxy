'use strict';
/*
 * nori-hub/policy.js —— 枢纽策略表（★ 唯一事实源）
 * ==========================================================================
 * 为什么要有这个文件（§86 §5 / §87 §3）
 *   现在"哪条信息走哪条路"散在 nori_proxy.js 的三个函数里
 *   （`trimLines` / `trimOps` / `dropAgentEvents`）——
 *   它们是**去重/裁剪**打补丁，**不是**按来源决策的闸门。
 *   ⇒ 同一个"意图"被拆成三处实现，改一处忘一处（T4 实测：战报只堵了 1/3 条路）。
 *   本文件把**意图**集中：
 *       · 这份表 = 我们"想要"的行为
 *       · `CURRENT` = 现行代码"实际"的行为（B1 的验收基准）
 *       · 两者逐条对比 ⇒ 差异就是 C 阶段要补的洞
 *
 * 铁律
 *   1. 本文件**纯数据 + 纯函数**，不 require 任何运行时模块（可单测、可离线跑）
 *   2. 每条策略都要能说出"对应现行代码的哪一行"（`CURRENT` 里的 `impl`）
 *   3. 未知一律保守：**不阻断、但必须记录**（`onUnknown:'pass+log'`）
 *
 * 本文件**只做决策**，不碰帧。改写/重组在 index.js 的 apply()。
 */

/* ── 内容分类学（kind）──────────────────────────────────────────────────
 * 六类 + 未知。设计依据：§85 §4.1 统一信封、§89 §10 整合策略表。
 */
const KINDS = [
  'player-speech',    // 玩家真说的话
  'nori-speech',      // 她的话（聊天回复 / 游戏台词）
  'game-event',       // 结构化对局事件（谁提示了什么、谁猜中什么）
  'game-report',      // 机器生成的战报原文（自然语言，伪装成玩家）
  'game-lifecycle',   // 开/退游戏
  'system-notice',    // 系统/剧情通知（邮件、signal…）
  'unknown',          // 白名单之外的一切
];

/* ── 出口（E1~E8）───────────────────────────────────────────────────────
 * ★ 无 E9 —— OSD 是分析芯片专属（2026-10-02 用户更正，见 §89 §12.1）
 */
const OUTLETS = {
  E1: '聊天气泡（/lines）',
  E2: '游戏气泡（GAME_LINES 浮窗）',
  E3: '语音（TTS）',
  E4: '投递匣（PENDING → 拼接进 LLM 请求）',
  E5: '游戏上下文（GameSession）',
  E6: '丢弃',
  E7: '后端日志',
  E8: 'obs.log（D1 观测器）',
};

/* ── ★ 策略表：我们"想要"的行为 ───────────────────────────────────────── */
const POLICY = {
  /* 玩家真说的话：原版气泡（右侧）+ 完整记忆。
   * ★ 不进 E4 —— 它本来就在 LLM 请求的 messages 里（投递即重复，§89 环路 1） */
  'player-speech': {
    E1: true, side: 'right', E2: false, E3: false,
    E4: false, E5: true, E6: false, E7: true,
    remember: 'full',     // 进印象卡 + 记忆卡 + 工作记忆（只有玩家真说算）
  },
  /* 她的话：原版气泡（左侧）+ 语音 + fact 记忆。
   * ★ 不进 E4 —— 同上（已在 messages 里） */
  'nori-speech': {
    E1: true, side: 'left', E2: false, E3: true,
    E4: false, E5: false, E6: false, E7: true,
    remember: 'fact',     // 只记客观事实，不记因果解释（§87 §3）
  },
  /* 结构化对局事件：不显示，只给她（E4）+ 游戏上下文 */
  'game-event': {
    E1: false, E2: false, E3: false,
    E4: true, E5: true, E6: false, E7: true,
    remember: 'fact',
  },
  /* 战报原文：★ 不进聊天框、不进 E4 —— 只进后端日志（用户 E2 决策） */
  'game-report': {
    E1: false, E2: false, E3: false,
    E4: false, E5: false, E6: false, E7: true,
    remember: 'none',
  },
  /* 开/退游戏：★ 不上屏（主屏只允许两类）—— 价值全在 E4（她知道） */
  'game-lifecycle': {
    E1: false, E2: false, E3: true,
    E4: true, E5: true, E6: false, E7: true,
    remember: 'fact',
  },
  /* 系统/剧情通知：同样不上屏，投给她 */
  'system-notice': {
    E1: false, E2: false, E3: false,
    E4: true, E5: false, E6: false, E7: true,
    remember: 'fact',
  },
  /* 未知：白名单之外 —— 丢弃（气泡路径）+ 记录 */
  'unknown': {
    E1: false, E2: false, E3: false,
    E4: false, E5: false, E6: true, E7: true,
    remember: 'none',
    onUnknown: 'drop+log',   // ★ 白名单语义（§87 F5）
  },
};

/* ── ★ 现行代码"实际"行为（B1 验收基准 · 只读参考，不被执行）────────────
 * 每条写明对应的实现位置。C 阶段改造时，逐条把这栏改成`null`（= 已由策略表接管）。
 */
const CURRENT = {
  /* 入站（服务端 → 客户端）*/
  in: {
    'patch./lines': {
      action: '按 sender 分类 + 剔战报 + 切块 + REVEAL 归一化',
      impl: 'nori_proxy.js trimLines() / normalizeLines()',
      drops: ['game-report'],                     // isCommentEntry
      splits: ['nori-speech'],                    // bubblesFor >1 → 多 blockId
      rewrites: ['nori-speech'],                  // REVEAL 归一化（按揭示进度裁剪）
      allowsSenders: ['player', 'agent'],         // 隐含白名单（isCommentEntry 只认前缀）
      onUnknown: 'pass（★ 现状是放行，不是丢弃）',
    },
    'patch./operations': {
      action: '按 REVEAL 的 opId 校准揭示进度 + 清空 pending*',
      impl: 'nori_proxy.js trimOps()',
      drops: [], splits: [], rewrites: ['nori-speech'],
      onUnknown: 'pass',
    },
    'cmd.ingestBlock': {
      action: '登记 REVEAL（切块）',
      impl: 'nori_proxy.js planReveal()',
      drops: [], splits: ['nori-speech'], rewrites: [],
      onUnknown: 'pass',
    },
    'cmd.agentMessage': {
      action: '★ 现状：不处理（原版气泡通道）',
      impl: '（无）',
      drops: [], splits: [], rewrites: [],
      onUnknown: 'pass',
    },
    'cmd.playerMessage': {
      action: '★ C1（2026-10-02）已补：战报（content/text 以 COMMENT_MARK 开头）⇒ 整条命令移除',
      impl: 'nori_proxy.js dropCommentCarriers()',
      drops: ['战报'], splits: [], rewrites: [],
      onUnknown: 'pass',
      note: '★ N1.7（2026-10-02）实测补充：本表的 `cmd.*` 还会**误捕游戏命令回显** —— '
        + '游戏卡带的 `transition.cmd` 带的是**客户端指令的回显**（`move`/`submitGuess`/`startGame`/`play`…），'
        + '而 classify 的 `GAME_CARTS` 兜底会把它们判成 `game-event`（分类上说得通：它确实与对局有关）。'
        + '**处置放在消费者而不是分类器**：`nori-splicer/index.js` 只消费 `from!=="cmd"` 的单元'
        + '（对局事实由 `transition.events` 描述）—— 与 §89 的 L2「出口级幂等」同思路。'
        + '⇒ 因此 `byKind["game-event"]` **包含**命令回显，读数时要知道这一点（`stats.fromCmd` 是它的大小）。',
    },
    'events[agent_message]': {
      action: '去重（已在 REVEAL 里的丢掉）—— 注意这是**去重**不是安全过滤',
      impl: 'nori_proxy.js dropAgentEvents()',
      drops: [], splits: [], rewrites: [],
      onUnknown: 'pass',
    },
    'events[player_message]': {
      action: '★ C1（2026-10-02）已补：战报（content/text 以 COMMENT_MARK 开头）⇒ 丢弃',
      impl: 'nori_proxy.js dropCommentCarriers()',
      drops: ['战报'], splits: [], rewrites: [],
      onUnknown: 'pass',
    },
  },
  /* 出站（客户端 → 服务端）*/
  out: {
    'dispatch.playerMessage': {
      action: '玩家真发言',
      impl: 'nori_proxy.js WS upgrade 里的 CLI dispatch 分支',
      origin: 'player',
      note: '★ C3（2026-10-02）：**"含我们注入的战报"这一情形已消除** —— '
        + '`NORI_COMMENT_INJECT` 默认 off ⇒ 不再用玩家身份注入战报（`BATTLE.injected` 恒 0）。'
        + '⇒ 本路径现在只剩**玩家真发言**，语义单一、不再需要靠前缀区分。'
        + '（`nori_proxy.js` 的 `isCommentEntry` 前缀识别**保留**，但已从"必要"退为**防御层** —— '
        + '防止历史帧/回退开关时再现伪装。）',
    },
    'dispatch.agentMessage': {
      action: '我们代她发（原版气泡）',
      impl: 'nori_proxy.js AGENT_CHAT_PUSH',
      origin: 'agent',
    },
    '_default': { action: '透传', origin: 'unknown', onUnknown: 'pass+log' },
  },
};

/* ── 判据：是不是战报（复刻 nori_proxy.js 的 isCommentEntry）───────────── */
const COMMENT_MARK = '【NoriOS战报';
function isReport(text) {
  return typeof text === 'string' && text.indexOf(COMMENT_MARK) === 0;
}

/* ── 决策：unit → Decision（纯函数，无副作用）────────────────────────── */
/**
 * @param {{kind:string, from:string, type:string, dir:string, writesLines?:boolean}} unit
 * @returns {{kind:string, outlets:object, drop:boolean, reason:string}}
 */
function decide(unit) {
  const kind = (unit && unit.kind) || 'unknown';
  const p = POLICY[kind] || POLICY.unknown;
  const outlets = { E1: !!p.E1, E2: !!p.E2, E3: !!p.E3, E4: !!p.E4, E5: !!p.E5, E6: !!p.E6, E7: !!p.E7, E8: true };
  return {
    kind,
    outlets,
    drop: outlets.E6,
    remember: p.remember || 'none',
    side: p.side || null,
    onUnknown: p.onUnknown || null,
    /* ★ reason 必须可解释（§86 §3.2）—— 出问题时不用猜 */
    reason: kind + '/' + (unit && unit.from) + '/' + (unit && unit.type)
      + ' → E' + Object.keys(outlets).filter((k) => outlets[k]).join(',E'),
  };
}

/* ── 给 B1 验收用：策略表 vs 现行代码 的差异清单 ──────────────────────── */
function currentGaps() {
  const gaps = [];
  for (const dir of ['in', 'out']) {
    for (const [route, v] of Object.entries(CURRENT[dir] || {})) {
      if (v && v.gap) gaps.push(dir + '.' + route + ' :: ' + v.gap);
    }
  }
  return gaps;
}

module.exports = {
  KINDS, OUTLETS, POLICY, CURRENT, COMMENT_MARK,
  isReport, decide, currentGaps,
};
