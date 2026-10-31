'use strict';
/*
 * nori-splicer/render.js —— 声明式渲染器：结构化 payload → 她能读懂的句子
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么必须是「表」而不是 if/else 拼串（_arch/89 §5.1）：
 *   · 可单测 —— 输入 payload ⇒ 断言输出文案
 *   · 可改   —— 改文案不动逻辑
 *   · 可审计 —— 一眼看出她到底会"读到"什么
 *
 * ★★ 铁律 1：render **只把事实说成句子**，绝不加入因果解释。
 *   ❌「我猜它是因为蒸汽一直在闪」← 这是 line 编造的因果，会污染长期记忆
 *       （B-013/B-015 的成因；§85 §4.2「只记客观结果」）
 *   ✅「我猜了「国王」—— 猜中了你的词」
 *
 * ★★ 铁律 2：**字段拿不准就不用**（宁缺勿错）。
 *   只渲染「在 proxy.log 里亲眼见过」的字段；没见过的字段一律不猜。
 *   遇到**完全未知的事件类型** ⇒ 返回 null（让 `stats.rejected` 增长）。
 *   **rejected 是"覆盖率哨兵"，不是错误** —— 它归零只应靠"补表项"，绝不该靠
 *   兜底文案把它冲掉（否则将来引擎新增事件时我们会静默失明）。
 *
 * 视角约定（★ 极易写错，单测有覆盖）：
 *   所有文案都是**直接对她说**的：
 *     · codenames/pictionary 的事件已带语义字段 —— `agent`/`player` ⇒「你」，
 *       `counterpart` ⇒「他」（与官方 `who is who` 一致，见 nori_game.js:689
 *       「A=玩家 B=Nori」）
 *     · chess 的事件用 `by:'white'|'black'` ⇒ **必须靠 `game_start.playerSide`
 *       才能翻译成你我**（实测：`playerSide:"white"` ⇒ 他持白、你持黑）
 *     · cakeduel 的事件用座位号 `0|1` ⇒ **必须靠 `NORI_AGENT_INDEX`**（默认 1，
 *       与 nori_game.js:21 的常量**同源**，见 `ACTIVE` 注释）
 *   ⇒ 拿不到上下文时**退回中立称谓**（白方/黑方、玩家 0/1），宁可不说归属，也不说反。
 */

/* 游戏 id → 中文名。与 nori-lifecycle.js 的 GAME_CN 保持一致（那边是权威）。 */
let GAME_CN = { codenames: '森林寻宝', cakeduel: '蛋糕对决', chess: '国际象棋', pictionary: '你画我猜' };
try {
  const L = require('../nori-lifecycle');
  if (L && L.GAME_CN) GAME_CN = L.GAME_CN;
} catch (e) { /* 独立加载时用本地副本 */ }

/* ── 视角：谁是"你"（=Nori），谁是"他"（=玩家）──────────────────────────── */

/* ★ `SKIP`：渲染表项返回它 ⇒ 表示「这一条**有意不渲染**」。
 *   与「未覆盖（返回 null）」**必须分开**：
 *     · null  ⇒ 我们不认识这个事件 ⇒ `stats.rejected` 增长（覆盖率哨兵，要补表）
 *     · SKIP  ⇒ 我们认识、但这一局里由别的事件说得更好 ⇒ `stats.skipped` 增长（设计如此）
 *   混在一起的后果：要么哨兵被"有意的跳过"稀释，要么被逼着说出冗余甚至矛盾的话。 */
const SKIP = false;

const BY_SEMANTIC = {
  agent: '你',          // codenames：她
  counterpart: '他',    // codenames：玩家
  player: '他',         // pictionary：`player` 是打字猜词的人（玩家）
  you: '他',            // 兼容（若有）
};

/* ★ cakeduel 的座位号：与 nori_game.js:21 `NORI_AGENT_INDEX` **同源**（同一环境变量）
 *   ⇒ 两边永远一致，不会各说各话。默认 1（实测：`players[AGENT_INDEX]` 是她的座位）。 */
const AGENT_INDEX = (() => {
  const n = Number(process.env.NORI_AGENT_INDEX);
  return Number.isFinite(n) ? n : 1;
})();

/* chess 的 side 中文（拿不到 playerSide 时的中立表达） */
const SIDE_CN = { white: '白方', black: '黑方' };

/* 国际象棋棋子（标准代数记号 p/n/b/r/q/k） */
const PIECE_CN = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };

/**
 * 把「谁」翻译成对她的称呼。
 * @param {*} v  'agent'|'counterpart'|'player'|'white'|'black'|0|1
 * @param {{playerSide?:string, agentIndex?:number}} ctx
 */
function who(v, ctx) {
  ctx = ctx || {};
  if (v == null) return '有人';
  const s = String(v);
  if (BY_SEMANTIC[s]) return BY_SEMANTIC[s];
  /* chess：white/black ⇒ 靠 playerSide 翻；不知道该 side 时保持中立（绝不说反） */
  if (s === 'white' || s === 'black') {
    const ps = ctx.playerSide;
    if (ps === 'white' || ps === 'black') return s === ps ? '他' : '你';
    return SIDE_CN[s];
  }
  /* cakeduel：座位号 0/1 */
  if (s === '0' || s === '1') {
    const ai = (ctx.agentIndex != null) ? ctx.agentIndex : AGENT_INDEX;
    return (Number(s) === ai) ? '你' : '他';
  }
  return s;   // 未知形态原样输出（不编造）
}

/** 座位号 → 她的称呼（cakeduel 的 player/attackerIndex/winner 都是座位号） */
function seat(v, ctx) {
  ctx = ctx || {};
  const ai = (ctx.agentIndex != null) ? ctx.agentIndex : AGENT_INDEX;
  if (typeof v === 'number') return v === ai ? '你' : '他';
  return who(v, ctx);
}

/** 蛋糕数（按座位号索引的数组）→ 「他 3 / 你 4」 */
function cakesText(arr, ctx) {
  if (!Array.isArray(arr) || arr.length < 2) return '';
  ctx = ctx || {};
  const ai = (ctx.agentIndex != null) ? ctx.agentIndex : AGENT_INDEX;
  const me = arr[ai], him = arr[1 - ai];
  if (typeof me !== 'number' || typeof him !== 'number') return '';
  return '（剩：他 ' + him + ' / 你 ' + me + '）';
}

function pieceName(p) { return PIECE_CN[p] || (p ? String(p) : '棋子'); }

/** 「兵 d2→d4」/「车 f5」*/
function pieceAt(o) {
  if (!o || typeof o !== 'object') return '';
  return pieceName(o.piece) + (o.square ? ' ' + o.square : '');
}

function game(e) { return GAME_CN[e.game] || e.game || '那个游戏'; }

/* ── ★ 渲染表（唯一事实源）────────────────────────────────────────────── */
const RENDER = {
  /* ═══ 森林寻宝 / codenames ═══ */
  clue: (e, c) => `${who(e.by, c)}给的提示是「${e.word}」${e.count ? '，' + e.count + ' 个' : ''}。`,
  guess: (e, c) => `${who(e.by, c)}猜了「${e.word}」—— ${RESULT_CN[e.result] || (e.result ? String(e.result) : '结果不明')}。`,
  turn_end: (e, c) => `这一轮结束了${e.correctGuesses ? '（本轮猜中 ' + e.correctGuesses + ' 个）' : ''}`
    + (e.reason && e.reason !== 'voluntary' ? '（' + (REASON_CN[e.reason] || e.reason) + '）' : '') + '。',
  /* `card_reveal` 的 `cell` 是牌堆里的格子编号（实测 0~24），
   * ★ 它不是"第几张"这种人能理解的东西 ⇒ **只说她能理解的部分：谁翻的**。 */
  card_reveal: (e, c) => `${who(e.by, c)}翻开了一张牌。`,
  agent_turn: (e, c) => (e.action === 'clue' ? '轮到你给提示了。' : (e.action ? `等待（${e.action}）。` : null)),
  sudden_death: () => '进入「突然死亡」阶段：从此不能再给提示，只能靠猜。',

  /* ═══ 你画我猜 / pictionary ═══ */
  guess_submitted: (e, c) => `${who(e.by, c)}猜了「${e.text}」—— ${e.correct ? '对了' : '不对'}。`,
  round_solved: (e, c) => `「${e.word}」被猜出来了`
    + (typeof e.elapsedMs === 'number' ? '（用了 ' + Math.max(1, Math.round(e.elapsedMs / 1000)) + ' 秒）' : '') + '。',
  round_skipped: (e, c) => `${who(e.by, c)}跳过了这一回合。`,
  round_started: (e, c) => '新的一轮开始了。',
  session_started: () => '（你画我猜）开始了。',

  /* ═══ 国际象棋 / chess ═══
   * ★★ `move` 是**权威事件** —— 实测它的 `details` 已包含该步的全部事实：
   *      {"type":"move","by":"black","details":{
   *         "move":{"piece":"r","from":"a8","to":"a7"},
   *         "san":"Rxa7", "captured":"q",
   *         "isCheck":false,"isCheckmate":false,"isStalemate":false,
   *         "isCastling":false,"isEnPassant":false,"isPromotion":false,
   *         "madeAtMs":…,"durationMs":6993}, "version":31,"index":0}
   *   而同 version 的 `capture`(index 1) / `check` / `castling` 只是它的**派生视图**：
   *      {"type":"capture","by":"black","from":{"piece":"r","square":"a8"},
   *       "captured":{"piece":"q","square":"a7"},"version":31,"index":1}
   *   ⇒ 一次棋步本来会被说两遍。**去重在 `index.js` 的 ingest 里做**（同帧同 version 判定），
   *     这里只需把 `move` 说得完整 —— 即使派生事件因故没被去重，也只是多一句，不会丢信息。
   *
   *   ⚠ `isStalemate`/`isEnPassant`/`isPromotion` 我**没用** ——
   *     它们在实测样本里**全是 false**，我没有见过 true 的样子（铁律 2：拿不准就不用）。
   *     `captured` / `isCheck` / `isCheckmate` / `isCastling` 都实测见过真值。 */
  move: (e, c) => {
    const d = e.details || {};
    const mv = d.move || {};
    const pc = mv.piece || d.piece || e.piece;
    const from = mv.from || e.from;
    const to = mv.to || e.to;
    let s = `${who(e.by, c)}走了${from && to ? ' ' + from + '→' + to : '一步'}（${pieceName(pc)}）`;
    if (d.captured) s += '，吃掉' + pieceName(d.captured);
    /* 易位：`to` 在 g 列 = 王翼、c 列 = 后翼（标准棋规）—— 派生事件里才有 `side`，但那个事件会被去重 */
    if (d.isCastling) s += '（王车易位·' + (to && String(to)[0] === 'g' ? '王翼' : '后翼') + '）';
    if (d.isCheckmate) s += '，将死';
    else if (d.isCheck) s += '，将军';
    return s + '。';
  },
  capture: (e, c) => {
    const atk = pieceAt(e.from), def = pieceAt(e.captured);
    if (!def) return `${who(e.by, c)}吃了一个子。`;
    return atk ? `${who(e.by, c)}用${atk} 吃了${def}。` : `${who(e.by, c)}吃了${def}。`;
  },
  check: (e, c) => `${who(e.by, c)}用${e.from ? pieceAt(e.from) + ' ' : '一子'}将了军。`,
  castling: (e, c) => `${who(e.by, c)}王车易位（${e.side === 'queenside' ? '后翼' : (e.side === 'kingside' ? '王翼' : (e.side || '?'))}）。`,
  request_takeback: (e, c) => `${who(e.side, c)}请求悔棋。`,

  /* ═══ 蛋糕对决 / cakeduel（全部经 `engine` 包裹，见 index.js 的解包）═══
   * ★ 这里的 `player`/`attackerIndex`/`winner` 都是**座位号 0/1**
   *   ⇒ 一律走 seat()（靠 NORI_AGENT_INDEX 翻成你我） */
  bout_started: (e, c) => `新一轮开始，${seat(e.attackerIndex, c)}先出手。${cakesText(e.cakesAfter, c)}`,
  bout_ended: (e, c) => `这一轮结束${e.winner != null ? '，' + seat(e.winner, c) + '拿下了' : ''}。`,
  cakes_transferred: (e, c) => `蛋糕转移了：${seat(e.from, c)}→${seat(e.to, c)}`
    + (typeof e.amount === 'number' ? '，' + e.amount + ' 个' : '') + '。' + cakesText(e.cakesAfter, c),
  claim_made: (e, c) => `${seat(e.player, c)}宣称打出「${e.claim}」`
    + (e.pile === 'attack_pile' ? '（进攻）' : (e.pile === 'block_pile' ? '（格挡）' : (e.pile ? '（' + e.pile + '）' : ''))) + '。',
  card_drawn: (e, c) => `${seat(e.player, c)}摸了 ${Array.isArray(e.cardIds) ? e.cardIds.length : '?'} 张牌`
    + (e.zone ? '（' + e.zone + '）' : '') + '。',
  card_discarded: (e) => `弃掉了 ${Array.isArray(e.cardIds) ? e.cardIds.length : '?'} 张牌`
    + (e.zone ? '（' + e.zone + '）' : '') + '。',
  /* ★ `phase` 的取值（attack/block/review/pick）**没有权威中文**来自官方 ⇒ 按铁律 2
   *   不硬翻规则语义，只陈述"轮到谁、进入哪个阶段"（用英文原词，她自己认得出）。 */
  phase_changed: (e, c) => `${seat(e.player, c)}进入「${e.phase}」阶段。`,
  pass_made: (e, c) => `${seat(e.player, c)}过了。`,
  deck_shuffled: () => '牌堆洗过了。',
  /* cakeduel 自己的开局事件（与 codenames/chess 的 `game_start` 不同名） */
  game_started: () => '新的一局开始了。',
  /* ★ 质疑（实测字段）：{challenger:0|1, claimedCard:'defender'|'wizard',
   *   success:bool, revealedCards:[{cardId,cardName}]}
   *   `claimedCard` 是**卡牌代号**（soldier/archer/wizard/defender…）——我们没有官方中文译名
   *   ⇒ 按铁律 2 保留原词（她自己认得出牌名），只把 challenger 翻成你我。 */
  challenge_made: (e, c) => `${seat(e.challenger, c)}质疑了「${e.claimedCard}」`
    + (e.success === true ? '—— 质疑成功。' : (e.success === false ? '—— 质疑失败。' : '。')),
  /* cakeduel 自己的结束事件（与 codenames/chess 的 `game_over` 不同） */
  game_ended: (e, c) => `这一局结束了，${seat(e.winner, c)}赢了。`,

  /* ═══ 通用：阶段 / 结局（三个游戏共用）═══ */
  game_start: (e, c) => '新的一局开始了'
    + (e.difficulty && e.difficulty !== 'normal' ? '（难度 ' + e.difficulty + '）' : '') + '。',
  game_over: (e, c) => {
    /* chess：有 winner + playerSide ⇒ 能精确说"谁赢了" */
    if (e.winner === 'white' || e.winner === 'black') {
      return `这一局结束了，${who(e.winner, c)}赢了`
        + (e.result ? '（' + (RESULT_CN[e.result] || e.result) + '）' : '') + '。';
    }
    /* codenames：winner 是 'assassin'/'bystander' 这类**牌面性质**，不是人 ⇒ 不说是谁赢 */
    return '这一局结束了。';
  },
  /* ★ `outcome` 的视角**因游戏而异** —— 实测证据：
   *     · codenames `{outcome:'loss',reason:'assassin'}` ⇒「我们队输了」（她与玩家**同队**）
   *     · chess     `{outcome:'win', reason:'checkmate'}` 与同局 `game_over{winner:'white',playerSide:'white'}`
   *       ⇒ `win` 是**玩家视角**（白方=玩家赢了）
   *   ⇒ 直接套用「你们赢了」会说出**自相矛盾**的话（"他赢了（将死）" + "你们赢了（被将死）"）。
   *
   *   ★ 处置：**谁已经把胜负说清楚了，就让谁说** ——
   *     · chess（`game_over` 有 winner+playerSide）⇒ 本事件**有意跳过**（见下方 SKIP）
   *     · cakeduel（`game_ended` 有 winner）⇒ 同样跳过
   *     · codenames（`game_over.winner` 只是牌面性质 assassin/bystander，说不出是谁赢）
   *       ⇒ **保留它**，这是 codenames 唯一的结局来源
   */
  game_outcome: (e, c) => {
    const g = String(e.game || '');
    if (g === 'chess' || g === 'cakeduel') return SKIP;
    const oc = String(e.outcome || '');
    const base = OUTCOME_CN[oc] || (oc ? oc : '分出结果了');
    return base + (e.reason ? '（' + (REASON_CN[e.reason] || e.reason) + '）' : '') + '。';
  },
};

/* ── 表外的共享词典（放这里是为了让上表读起来只剩"句子"）──────────────── */
const RESULT_CN = {  agent: '猜中了你的词',
  counterpart: '猜中了他的词',
  bystander: '猜错了，那是无关的词',
  assassin: '踩到了刺客 —— 这一局直接输了',
  resigned: '对方认输',
  checkmate: '将死',
};

const REASON_CN = {
  voluntary: '主动结束',
  bystander: '猜到了无关词',
  assassin: '猜到刺客',
  resigned: '认输',
  checkmate: '被将死',
  outOfTokens: '提示词用完了',
};

const OUTCOME_CN = { win: '你们赢了', loss: '你们输了', draw: '平局' };

const ROLES_CN = { drawer: '画的人', guesser: '猜的人' };

/**
 * 渲染一个内容单元 → 一句话
 * @param {{type:string, payload:object, cartridgeId:string}} unit
 * @param {{playerSide?:string, agentIndex?:number}} [ctx] 视角上下文（游戏级，由 index.js 维护）
 * @returns {string|null|false}
 *   · string 渲染成功
 *   · null   **未覆盖**（不认识这个类型）⇒ 调用方计入 `rejected`（覆盖率哨兵）
 *   · false  **有意跳过**（认识，但这条不该说）⇒ 调用方计入 `skipped`
 */
function render(unit, ctx) {
  if (!unit || !unit.payload) return null;
  const t = String(unit.type || unit.payload.type || '');
  const f = RENDER[t];
  if (!f) return null;                    // ★ 未知类型 ⇒ null（rejected 哨兵，见铁律 2）
  const e = Object.assign({ game: unit.cartridgeId }, unit.payload);
  const c = Object.assign({ agentIndex: AGENT_INDEX }, ctx || {});
  let s = null;
  try { s = f(e, c); } catch (err) { return null; }
  if (s === SKIP) return SKIP;            // ★ 有意跳过：透传，不算未覆盖
  return s ? String(s).slice(0, 200) : null;
}

/* 覆盖度自检用（离线工具/单测都读它） */
function knownTypes() { return Object.keys(RENDER); }

module.exports = {
  render, RENDER, knownTypes, SKIP,
  GAME_CN, BY_SEMANTIC, SIDE_CN, PIECE_CN,
  RESULT_CN, REASON_CN, OUTCOME_CN, ROLES_CN,
  who, seat, pieceName, AGENT_INDEX,
};
