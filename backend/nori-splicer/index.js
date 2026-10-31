'use strict';
/*
 * nori-splicer/index.js —— 拼接器：把「她该知道的」组装成一条 system 消息
 * ═══════════════════════════════════════════════════════════════════════
 * 数据流（_arch/89 §10）：
 *
 *   服务端帧 ──► hub/extract（S1 抽取 + S2 分类，已有）──► game-event
 *                                                          │
 *                                                          ▼
 *                                             render（声明式）──► 一句话
 *                                                          │
 *                                                          ▼
 *                                                    PENDING（环形缓冲）
 *                                                          │
 *   每次 LLM 调用前 ◄── buildStateText() ◄── fold（≤12 条）◄─┘
 *                     │
 *                     └─ 生命周期（nori-lifecycle.js 的 render）
 *
 * ★ 为什么每轮都要带（不是投递一次）：A2 实测 exe 的 messages 是**固定 14 条滚动窗口**
 *   ⇒ 我们 append 的 system 只活一轮 ⇒ 状态类信息必须每轮重建语境。
 *
 * 开关：NORI_SPLICE=off ⇒ buildStateText() 恒 null ⇒ 退回纯透明转发。
 */

const path = require('path');
const RENDER = require('./render');
const PENDING = require('./pending');
const FOLD = require('./fold');

const ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_SPLICE || 'on'));
const MAX = Number(process.env.NORI_SPLICE_MAX || 12);

/* 生命周期（单独模块，与 game-event 正交） */
let LIFE = null;
try { LIFE = require('../nori-lifecycle'); } catch (e) { LIFE = null; }
/* 抽取器（hub 的 S1/S2，已有 —— 这里只消费，不重复实现分类） */
let EXTRACT = null;
try { EXTRACT = require('../nori-hub/extract'); } catch (e) { EXTRACT = null; }

const GAME_SET = (LIFE && LIFE.GAME_SET) || new Set(['codenames', 'cakeduel', 'chess', 'pictionary']);

const stats = { frames: 0, units: 0, accepted: 0, rejected: 0, skipped: 0, fromCmd: 0, derived: 0, newGame: 0, unwrapped: 0 };
/* ★ 2026-10-02：「rejected 到底是哪一类」—— 只加可观测，不改行为。
 *   该计数在 N1.6 口径下应为 0（渲染表覆盖 35 类）；一旦非 0，必须能**一眼点名**
 *   是哪个 type / 哪个卡带 / 哪条来源路径，否则哨兵等于哑的。 */
const rejectedBy = Object.create(null);

/* ★ N1.7-b（2026-10-02）：chess 的**派生事件** —— 它们与 `move` 同 version，
 *   信息在 `move.details` 里都有（captured / isCheck / isCastling）。
 *   两个都渲染 = 每一步棋对她说两遍（实测：159 步棋 + 40 capture + 22 check 的重复）。 */
const DERIVED = new Set(['capture', 'check', 'castling']);

/* ★★ N1.1（2026-10-02）：**当前对局的视角上下文** —— 渲染"谁"必需。
 *
 *   为什么必须有状态（不能纯函数）：
 *     · chess 的事件只带 `by:'white'|'black'`，**谁是 Nori 只在 `game_start.playerSide` 里**
 *       （实测：`playerSide:"white"` ⇒ 他持白、你持黑）⇒ 不记住它就翻不出"你/他"
 *     · cakeduel 的事件带座位号 `0|1`，靠 `NORI_AGENT_INDEX` 翻（与 nori_game.js 同源）
 *   ⇒ 拿不到时 render 会**退回中立称谓**（白方/黑方），宁可不说归属也不说反。
 *
 *   生命周期：`game_start` 时记 `playerSide`；`cartridge_mounted`（新景）时清空。
 */
let view = { cart: '', playerSide: '' };
function resetView(cart) { view = { cart: cart || '', playerSide: '' }; }

/* ── N1.1：解开 `engine` 包裹（蛋糕对决的核心）────────────────────────────
 * cakeduel 的事件长这样（实测）：
 *   {"type":"engine","event":{"type":"bout_started",…},"version":1,"index":2}
 * ⇒ 真实类型嵌在 `event` 里 ⇒ 不解包的话渲染表永远命中不了 'engine'。
 *
 * ★ 三个必须遵守的细节（写在 _arch/91_roadmap.md N1.1）：
 *   ① **把外层 version/index 合并进内层** —— `PENDING.keyOf()` 靠 `payload.version`
 *      做幂等键；丢掉外层版本号 ⇒ 内层 index 每轮从 0 开始 ⇒ 两局之间会误判为重复。
 *   ② 只解**一层**（`engine.event` 里若是 engine 就不再解 —— 防意外死循环）
 *   ③ 解包后**换掉 unit.type**，让 fold 的按类型计数显示真实类型（否则摘要写"engine 87 次"）
 *   （与 nori_game.js:931 既有的 unwrapEngine() 同一策略）
 */
function unwrap(u) {
  const p = u && u.payload;
  if (!p || u.type !== 'engine') return u;
  const inner = p.event;
  if (!inner || typeof inner !== 'object' || !inner.type) return u;
  const merged = Object.assign({}, inner);
  if (merged.version == null && p.version != null) merged.version = p.version;
  if (merged.index == null && p.index != null) merged.index = p.index;
  stats.unwrapped++;
  return Object.assign({}, u, { type: String(inner.type), payload: merged });
}

/* ★ D2（2026-10-02）：本次 LLM 请求**之前**新入匣的事件（= 增量）。
 *   用途：人格侧据此往"工作记忆"里写一条**摘要**（而不是把 12 条全塞进去把对话挤掉）。
 *   meta() 被调用一次就清空 —— 因为它是"自上次请求以来"的语义。 */
let sinceLast = [];
let seq = 0;

/* ── 投递（由 nori_proxy.js 在 in/recv 调用）────────────────────────── */
/**
 * 从一帧里提出 game-event 并投递
 * @param {object} frame
 * @returns {number} 实际入队条数
 */
function ingest(frame) {
  if (!ON) return 0;
  /* 与 HUB.process / LIFE.onFrame 的调用约定一致：**字符串或对象都收** */
  if (typeof frame === 'string') {
    try { frame = JSON.parse(frame); } catch (e) { return 0; }
  }
  if (!frame || typeof frame !== 'object') return 0;
  stats.frames++;

  /* 新开一局 ⇒ 清掉上一局的记录与幂等键（否则两局的事件会混在一起）+ 重置视角 */
  if (frame.type === 'cartridge_mounted' && GAME_SET.has(frame.cartridgeId)) {
    PENDING.reset();
    resetView(frame.cartridgeId);
    stats.newGame++;
  }

  if (!EXTRACT) return 0;
  let units = [];
  try { units = EXTRACT.extractUnits(frame, 'in'); } catch (e) { return 0; }

  /* ★★★ N1.7-a（2026-10-02 实测修复）：**`transition.cmd` 是「命令回显」，不是「对局事件」。**
   *
   *   一步棋在入站帧里会出现**两次**：
   *     · `transition.cmd    = {type:'move',from:'d2',to:'d4'}`      ← 客户端指令的回显（**没有 `by`**）
   *     · `transition.events = [{type:'move',by:'white',details:…}]` ← 服务端描述"发生了什么"
   *   两者都当 game-event 的后果（N1 上线后实测）：
   *     ① 渲染出 **"有人走了 d2→d4。"** —— 无名句（cmd 没有 `by`）且与真实事件**完全重复**；
   *     ② `submitGuess`/`startGame`/`resign`/`play`/`submitStrokeBatch`… 这些 cmd 类型不在 RENDER 表
   *        ⇒ **`rejected` 被刷到 98** ⇒ **覆盖率哨兵失效**（引擎将来新增事件我就分辨不出来了）。
   *   （取证：`GAME agent -> {"type":"move","from":"g8","to":"f6"}` —— 命令**无 by**，而所有
   *    `GAME ev` 事件**都有 by** ⇒ 那句"有人走了"只可能来自 cmd 路径。）
   *
   *   ⇒ **只消费"结果"（events），不消费"指令回显"（cmd）** —— 与 §89 的 L2「出口级幂等」同思路：
   *     同一个动作的两种表示，由**消费者**决定用哪一个。
   *   ⚠ 只排除 `from === 'cmd'`（**不做白名单**）—— 给将来的 `self` / 新路径留余地。 */
  const moveVers = new Set();
  for (const u of units) {
    if (u.type === 'move' && u.payload && u.payload.version != null) moveVers.add(String(u.payload.version));
  }

  let n = 0;
  for (let u of units) {
    stats.units++;
    if (u.kind !== 'game-event') continue;                       // 只消费 game-event（其余由各自出口处理）
    if (u.cartridgeId && !GAME_SET.has(u.cartridgeId)) continue; // 只认游戏卡带
    if (u.from === 'cmd') { stats.fromCmd++; continue; }         // ★ N1.7-a：命令回显（见上）

    u = unwrap(u);                                               // ★ N1.1：解开 cakeduel 的 engine 包裹

    /* ★ N1.7-b：派生事件去重 —— 只在**同帧内**按 version 判定。
     *   配对不成立（帧被拆开、或该版本没有 move）⇒ 自动退回原行为，**不会漏信息**。 */
    if (DERIVED.has(u.type) && u.payload && u.payload.version != null
      && moveVers.has(String(u.payload.version))) { stats.derived++; continue; }

    /* ★ N1.1：维护视角上下文（必须在 render 之前 —— 同帧后续事件要用它翻"谁"） */
    if (u.cartridgeId) view.cart = u.cartridgeId;
    if (u.type === 'game_start') {
      PENDING.onNewGame();                                       // 新局 ⇒ 幂等键重来
      const ps = u.payload && u.payload.playerSide;
      if (ps === 'white' || ps === 'black') view.playerSide = ps; // chess 的阵营（实测只在 game_start 里给）
    }

    const text = RENDER.render(u, view);                         // ★ N1.1：把视角传进去
    /* ★ 三分支（与 render 的返回值一一对应）：
     *   false ⇒ 有意跳过（设计如此，例如 chess 的 game_outcome 由 game_over 代言）
     *   null  ⇒ 未覆盖（我们不认识这个事件）⇒ rejected 增长（覆盖率哨兵）
     *   string⇒ 正常入匣 */
    if (text === RENDER.SKIP) { stats.skipped++; continue; }
    if (!text) {
      stats.rejected++;
      /* ★ 点名：type + 来源路径 + 卡带（含第一次出现的样本，便于复现） */
      const key = u.type + ' [from=' + (u.from || '?') + ' cart=' + (u.cartridgeId || '?') + ']';
      const r = rejectedBy[key] || (rejectedBy[key] = { n: 0, firstAt: Date.now(), sample: null });
      r.n++;
      if (!r.sample) { try { r.sample = JSON.stringify(u.payload).slice(0, 300); } catch (e) { r.sample = '(无法序列化)'; } }
      continue;
    }
    if (PENDING.push(u, text)) { n++; stats.accepted++; sinceLast.push({ type: u.type, text, game: u.cartridgeId }); }
  }
  return n;
}

/* ── 组装（由 nori-llm-route.js 在转发前调用）───────────────────────── */
/**
 * 产出要 append 的那条 system 文本；无内容时返回 null（⇒ 调用方走透明转发）
 * @returns {string|null}
 */
function buildStateText() {
  if (!ON) return null;
  const parts = [];

  /* ① 生命周期：在玩什么 / 刚退出（每轮都带） */
  let life = null;
  try { if (LIFE) life = LIFE.render(); } catch (e) { life = null; }
  if (life) parts.push(life);

  /* ② 对局记录：最近 max 条（经折叠） */
  let folded = [];
  try { folded = FOLD.fold(PENDING.snapshot(), MAX); } catch (e) { folded = []; }
  if (folded.length) {
    const body = folded.map((x) => '· ' + x.text).join('\n');
    parts.push([
      '【NoriOS 对局记录｜这类消息不是他打的字】',
      '· 下面是你们这一局的记录，从早到晚。你可以自然地把它当成已经知道的事。',
      '· ★ 他要是问起对局，你说得出具体内容（谁给了什么提示、谁猜了哪个词、结果怎样）——',
      '  需要的时候就用，但**不要逐条复述、不要念这个列表**，也不要提"系统""记录"这类词。',
      body,
    ].join('\n'));
  }

  if (!parts.length) return null;
  return parts.join('\n\n');
}

/* ── ★★ D2：结构化元数据（随请求体一起给人格）────────────────────────────
 * 为什么必须结构化（而不是让人格靠文本前缀猜）：
 *   · 前缀识别是 **B-013/B-015 的老毛病** —— 格式一变就失效（实测已踩）：
 *     人格的 `HUB_MARK='【NoriOS 系统状态'` 只认生命周期那段，
 *     若某轮只有"对局记录"（无生命周期）⇒ `indexOf` 失败 ⇒ **整条被丢弃**。
 *   · 结构化还让**分流**成为可能：知道 kinds 才能决定"哪些进记忆、哪些只进 prompt"。
 * 保留文本前缀只作**回退**（人格侧双读），见 n_llm.js 的 pickHubMeta()。
 */
function meta(peek) {
  const snap = PENDING.snapshot();
  const counts = {};
  const games = {};
  for (const x of snap) { counts[x.type] = (counts[x.type] || 0) + 1; if (x.game) games[x.game] = 1; }

  const kinds = [];
  let life = null;
  try { life = LIFE ? LIFE.getState() : null; } catch (e) { life = null; }
  if (life && life.phase !== 'idle') kinds.push('game-lifecycle');
  if (snap.length) kinds.push('game-event');

  /* ★ brief：**取对局记录的最后 3 条**（不是 sinceLast）——
   *   原因（2026-10-02 实测修）：原先用 `sinceLast.slice(-3)`，而 sinceLast 是
   *   "自上次 meta() 以来新增"的缓冲，**游戏事件与聊天请求的时刻是错开的** ⇒
   *   玩家到聊天框说话时 delta 经常为 0 ⇒ brief 为空 ⇒ **人格侧永远不写工作记忆**
   *   （实测 totals.working=0）。改成取自快照 ⇒ 任何时候都有内容。 */
  const brief = snap.slice(-3).map((x) => x.text).join('｜').slice(0, 140);
  const m = {
    v: 1,
    seq: 0,                         // ← 由下方分支赋值（**不能**写 ++seq：peek 也会加，序号虚涨）
    ts: Date.now(),
    n: snap.length,                 // 本次请求带了几条对局记录
    delta: sinceLast.length,        // 自上次请求以来新增几条
    kinds,
    counts,
    brief,
    games: Object.keys(games),
  };
  /* ★ peek=true 时**不消费** sinceLast —— 只读端点绝不能有副作用
   *   （否则调一次 /nori-splicestat，下一轮人格就收不到 brief 了）。
   *   ★ 也不能让 peek 推进序号（第一版写 `seq: ++seq` ⇒ 序号虚涨 + peek 也递增）。 */
  if (!peek) { m.seq = ++seq; sinceLast = []; } else { m.seq = seq + 1; }
  return m;
}

/* ── 只读状态（端点用）──────────────────────────────────────────────── */
function getState() {
  const pend = PENDING.getStats();
  const folded = FOLD.fold(PENDING.snapshot(), MAX);
  return {
    on: ON, max: MAX,
    /* ★ N1.1：当前视角（渲染"谁"的依据）—— 一眼看出 chess 阵营有没有被记住 */
    view: { cart: view.cart, playerSide: view.playerSide, agentIndex: RENDER.AGENT_INDEX },
    lifecycle: (() => { try { return LIFE ? LIFE.getState() : null; } catch (e) { return null; } })(),
    pending: pend,
    willSend: folded.map((x) => ({ type: x.type, text: x.text })),
    metaPreview: (() => { try { return meta(true); } catch (e) { return null; } })(),
    preview: (() => { try { return buildStateText(); } catch (e) { return null; } })(),
    stats: Object.assign({}, stats, { fold: { in: pend.size, out: folded.length }, rejectedBy: rejectedBy }),
  };
}

function reset() { PENDING.reset(); sinceLast = []; resetView(''); }

module.exports = {
  ingest, buildStateText, meta, getState, reset, unwrap,
  ON, MAX, PENDING, FOLD, RENDER,
};
