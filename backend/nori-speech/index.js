/* nori-speech/index.js — 语音编排模块（Speech Orchestrator）
 * ══════════════════════════════════════════════════════════════════════
 *  用户需求原文（2026-10-02）：
 *  > "这个气泡显示什么，何时显示，怎么显示，在哪分段，以及 TTS 的调用，
 *  >  我想单独再做一个模块，并这个模块**可以有一个缓冲区**，
 *  >  上面下来的信息**先分段，然后逐句放出，等 TTS**。"
 *
 *  职责（**只有四件**）：
 *    ① 缓冲 —— FIFO，允许积压
 *    ② 分段 —— 由 io.split 注入（生产 = nori_proxy 的 bubblesFor，口径唯一）
 *    ③ 逐句放出 —— 一次只放一句；**上一句播完才放下一句**
 *    ④ 等回报 —— 前端 shim 播完 `POST /nori-spoken`；超时兜底
 *
 *  ★★★ 模块契约（硬约束，单测会断言）： *    本文件**不得出现**任何 TTS 供应商细节 —— 不含音频格式、采样率、音色 ID、
 *    供应商名（wav / mp3 / sample_rate / voice_id / qwen / openai / inworld …）。
 *    理由：TTS 供应商**必须可替换**（开发期用百炼，将来可能换 Inworld / OpenAI）。
 *    所有供应商细节收敛在 `/nori-tts` 那**一个端点**之后。
 *    ⇒ 本模块只关心"哪一句、什么时候放"，不关心"怎么发声"。
 *
 *  ★ 与 B-215 的关系：本模块让 B-215 **结构性消失**。
 *    B-215 = "一次发了多句、想逐句露出来"。本模块**从不一次发多句**
 *    ⇒ 不存在"要露出来的剩余内容" ⇒ 不需要 REVEAL / carrier / 进度换算。
 *
 *  依赖注入（本模块**不 require 任何东西**，无副作用，可独立测试）：
 *    io.log(text)                      日志
 *    io.emit(text, meta) -> bool       放出一句（生产 = 注入 + 进 GAME_LINES）
 *    io.split(text) -> string[]        分段（生产 = bubblesFor）
 *    io.now() -> ms                    时钟（默认 Date.now）
 *    io.estMs(text) -> ms              超时估算（默认见下方）
 *    io.on                             初始开关（默认读 NORI_SPEECH_Q）
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ★ 总开关：`NORI_SPEECH_Q=off` ⇒ 退回"整段发布"（legacy 直通，行为与改动前一致）。
 *   为什么必须有：本模块改的是**发布节奏**。若节奏出问题
 *   （例如前端没刷到新版 shim、或用户就想看整段），要能**一个环境变量退回去**。 */
const DEFAULT_OFF = /^(off|0|no|false)$/i.test(String(process.env.NORI_SPEECH_Q || ''));

/* 超时兜底估算 —— ★★ 2026-10-03 实测重新定标（原来偏小，导致超时抢跑）。
 *
 * 它必须覆盖「**从放出到真正播完**」的**全部**耗时，而不只是播放：
 *     ① shim 轮询延迟   ~0.7s（POLL_MS=700，最坏一整轮）
 *     ② **合成**        见下方 ★ 2026-10-17 新定标
 *     ③ 解码            ~0.1s
 *     ④ 播放            约 4 字/秒 ⇒ 每字 ~250ms（原取 200ms 偏快）
 *
 * ★★ 2026-10-17 二次定标（换 Inworld 之后原定标失效）：
 *   10-03 的常量是按**旧 TTS**（合成 1.2~1.4s）定的。换 Inworld 后实测
 *   （tts/tts.log，同一晚 20+ 条请求）：
 *       · 首包 first = 0.81 ~ 5.67s
 *       · 整句 total = 2.37 ~ 8.61s
 *   ⇒ 合成预算要给到 ~4s（旧值 1.4s 少了 2.6s）。
 *   **实锤**（2026-10-17 22:26，`/nori-qstat`）：
 *       9 字句 est=6000ms，而 latLast=7261ms ⇒ 超时先于播完触发
 *       → timeouts 3 / orphans 3（一一对应：迟到的回报到来时队列已空）。
 *   ⇒ EST_BASE 3500 → 5500（轮询 700 + 合成 4000 + 解码 100 + 余量 ~700）
 *     EST_MIN  6000 → 9000（9 字句真实 7.26s，留 1.7s 余量）
 *   ★ 代价：真丢回报时每句最多多等 ~3s；而 `received 8/8` 说明回报基本不丢
 *     （只是**迟到**），所以这个交换是划算的。
 *
 * ★★★ 为什么"第 1 句"是重灾区（实测 `qpart=0` 超时 32 次 : `qpart=1` 6 次）：
 *   编排模块会把**下一句**文本随本句一起发出（`qnext`）⇒ shim 在**播本句时后台预取下一句**
 *   ⇒ **第 2 句的合成（②）已被提前做掉**，所以它更容易在估算内播完；
 *   而**第 1 句没有"前一句"可依托 ⇒ 永远要现场合成** ⇒ 最坏情况就是它。
 *   ⇒ **兜底必须按最坏情况（未预取）定标**，否则第 1 句永远抢跑。
 *
 * ★ 它**仍只是兜底**：正常情况下前端播完会回报（那条路径优先）。
 * ★ 必须**偏大** —— 宁可多等，也不能在音频还在播时抢跑下一句
 *   （抢跑 = 气泡跑到语音前面，正是 B-215 的原始症状，只是换了个成因）。 */
const EST_PER_CHAR = 250;     // 中文 TTS ≈ 4 字/秒
const EST_BASE = 5500;        // 轮询 700 + 合成 4000 + 解码 100 + 余量 ~700（2026-10-17 Inworld 定标）
const EST_MIN = 9000;         // 短句也要留够"轮询 + 合成"（9 字句实测 7.26s）

function defaultEst(text) {
  return Math.max(EST_MIN, String(text || '').length * EST_PER_CHAR + EST_BASE);
}

/* 分段兜底实现 —— **与 nori_proxy.js 的 `bubblesFor()` 同口径**。
 * 生产环境由 `io.split` 注入真身（避免两处实现漂移）；
 * 这里保留一份是为了模块**能独立运行/被单测直接驱动**。
 * ★ 单测里有一条断言：`defaultSplit` 与注入的 `bubblesFor` 在样本上**结果一致**。 */
function defaultSplit(text) {
  const out = [];
  for (const raw of String(text || '').split(/\n+/)) {
    const l = raw.trim(); if (!l) continue;
    if (l.length <= 28) { out.push(l); continue; }
    for (const s of l.split(/(?<=[。！？!?])/).map((x) => x.trim())) if (s) out.push(s);
  }
  return out;
}

function createSpeechQueue(io) {
  io = io || {};
  const log = typeof io.log === 'function' ? io.log : function () {};
  const emit = typeof io.emit === 'function' ? io.emit : function () { return false; };
  const split = typeof io.split === 'function' ? io.split : defaultSplit;
  const now = typeof io.now === 'function' ? io.now : function () { return Date.now(); };
  const estMs = typeof io.estMs === 'function' ? io.estMs : defaultEst;

  let on = (io.on == null) ? !DEFAULT_OFF : !!io.on;

  const queue = [];        // [{ qid, parts:[], i, emotion, game, from, ui, at }]
  let current = null;      // { qid, qpart, text, at, item }
  let timer = null;        // 当前句的超时兜底
  /* ★★ 2026-10-30：`qid` 也必须**跨进程重启保持唯一**（与 GAME_LINE_SEQ 同一类问题）。
   *   原来从 0 起：代理重启后 qid 又变回 1，而**页面没 F5**、上一轮还有迟到的回报在路上
   *   ⇒ `{qid:1}` 会把新的一轮 qid=1 误推进（`stats.stale` 抓不全，`latMax` 还会出现
   *   2.6 小时的假值 —— 就是拿旧时刻算出来的）。
   *   ⇒ 用时间戳做起点：新进程的 qid 永远大于任何旧值，迟到的回报自然被 `stale` 拦下。 */
  let seq = Date.now();
  let lastAt = 0, lastError = '';
  /* ★★ 观测用：**放出记录表**（`"qid:qpart"` → 放出时刻）。
   *   为什么不能只存"最近一次"：迟到回报到来时，"最近一次"**已经被下一句覆盖**了
   *   —— 而**迟到恰恰是"估算偏小"的唯一证据**，最该被记到。
   *   ⇒ 存一小段历史，按 `qid+qpart` 回查。（单测 ⑳ 抓出过这个缺陷。） */
  const emitLog = new Map();
  const EMIT_LOG_MAX = 16;
  function rememberEmit(qid, qpart, at) {
    emitLog.set(qid + ':' + qpart, at);
    while (emitLog.size > EMIT_LOG_MAX) {
      const k = emitLog.keys().next().value;
      if (k === undefined) break;
      emitLog.delete(k);
    }
  }

  const stats = {
    pushed: 0,      // 进过缓冲的**条**（不是句）
    spoken: 0,      // 放出的**句**
    received: 0,    // 收到的播完回报
    timeouts: 0,    // 超时兜底次数（>0 说明回报链路有问题）
    fails: 0,       // emit 抛错
    drops: 0,       // 空文本 / 分段为空被丢弃
    stale: 0,       // 迟到的回报（已推进过，或被超时抢先）
    orphans: 0,     // 没有在播却收到回报
    skipped: 0,     // ★ 前端主动跳过（ui/chat/stale-id）⇒ 队列立刻推进，不算超时
    legacy: 0,      // off 直通的条数
    truncated: 0,   // ★ 软清空时**被丢弃的句数**（换局/退出游戏造成）
    /* ★★ 端到端延迟（放出 → 收到回报的真实毫秒数）。
     *   用途：**核验 `estMs` 定标准不准**。判据：
     *     `latMaxMs` 明显 > `cfg.estMs` 对应值 ⇒ 估算仍偏小 ⇒ 会继续超时抢跑；
     *     `latMaxMs` 远小于估算 ⇒ 可以调小（让"真没回报"时少等）。
     *   ★ 含**及时**与**迟到**两种回报（迟到的更值得看，所以不排除）。 */
    latN: 0, latSum: 0, latMax: 0, latLast: -1,
  };

  function clearTimer() {
    if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
  }

  /* 推进一格：把当前句标记为完成，清超时，放下一句。 */
  function advance() {
    clearTimer();
    if (!current) return;
    current.item.i = current.qpart + 1;
    current = null;
    pump();
  }

  function onTimeout() {
    timer = null;
    if (!current) return;
    stats.timeouts++;
    log('SPEECH 超时兜底（未收到播完回报）qid=' + current.qid + ' qpart=' + current.qpart
      + ' 等 ' + (now() - current.at) + 'ms');
    advance();
  }

  function pump() {
    if (current) return;                       // 一次只放一句：**这就是"等 TTS"的实现**
    /* 出队：parts 已全部放完的整条 */
    while (queue.length && queue[0].i >= queue[0].parts.length) queue.shift();
    if (!queue.length) return;
    const it = queue[0];
    const qpart = it.i;
    const text = it.parts[qpart];
    const next = it.parts[qpart + 1] || '';
    current = { qid: it.id, qpart: qpart, text: text, at: now(), item: it };
    rememberEmit(it.id, qpart, current.at);   // ★ 观测：见 emitLog 的说明
    const ms = estMs(text);
    timer = setTimeout(onTimeout, ms);
    try { if (timer.unref) timer.unref(); } catch (e) {}
    stats.spoken++;
    lastAt = now();
    const meta = {
      qid: it.id, qpart: qpart, qof: it.parts.length, qnext: next,
      emotion: it.emotion || 'neutral', game: it.game || '', from: it.from || '',
      ui: false,                                // 进过编排的都是"要说的"，天然非界面播报
    };
    /* ★ 2026-10-17：预取提示只在**这条的最后一句**下传 —— 让 shim 等本 beat 全部
     *   上屏后再去后台合成，避免和当前句抢 TTS 并发。 */
    if (it.pf && it.pf.length && qpart >= it.parts.length - 1) meta.pf = it.pf;
    let ok = false;
    try { ok = emit(text, meta) !== false; } catch (e) {
      ok = false; stats.fails++; lastError = e.message || String(e);
      log('SPEECH emit err ' + lastError);
    }
    if (!ok) {
      /* 没放出去 = 既没显示也没声音 ⇒ 等回报毫无意义，直接推进（记 fails）。 */
      stats.fails++; lastError = lastError || 'emit returned false';
      advance();
    }
  }

  /* 上层信息进来（生产：nori_proxy 的 pushGameLine 路由到这里）。
   * meta: { emotion, game, from } —— 只带**展示相关**字段，不带任何 TTS 细节。 */
  function push(text, meta) {
    meta = meta || {};
    const t = String(text == null ? '' : text).trim();
    if (!on) { stats.legacy++; try { return emit(t, meta); } catch (e) { return null; } }
    if (!t) { stats.drops++; return null; }
    let parts = [];
    try { parts = split(t) || []; } catch (e) { lastError = e.message; parts = []; }
    if (!parts.length) { stats.drops++; return null; }
    const item = { id: ++seq, parts: parts, i: 0, at: now(),
      emotion: meta.emotion || 'neutral', game: meta.game || '', from: meta.from || '', ui: false };
    /* ★ 2026-10-17：**预取提示**（可重复 beat 的"接下来 2 句"）—— 与 qnext 不同：
     *   qnext 是"同一条消息的下一句"，pf 是"下一次触发可能说的句子"（跨条）。
     *   只在最后一句放出时下传，见 pump()。 */
    if (Array.isArray(meta.pf) && meta.pf.length) item.pf = meta.pf.slice(0, 4);
    queue.push(item);
    stats.pushed++;
    log('SPEECH 入队 qid=' + item.id + ' 句数=' + parts.length + ' 队列=' + queue.length
      + ' from=' + (item.from || '?')
      + ' :: ' + JSON.stringify(t.slice(0, 40)));
    pump();
    return item.id;
  }

  /* 前端 shim 播完一句来报。**必须带 qpart**：否则超时抢先推进后，
   * 那条迟到的回报会把下一句也误推进（`stale` 计数就是为此存在）。 */
  function report(qid, qpart) {
    stats.received++;
    /* ★ 观测：算出这次回报的**端到端延迟** —— 按 `qid+qpart` 回查放出时刻。
     *   用回查而不是 `current`：超时抢跑时 `current` 已经是下一句，
     *   而"迟到"正是最该被记录的那种（它证明 `estMs` 偏小）。 */
    const at = emitLog.get(Number(qid) + ':' + Number(qpart));
    if (at != null) {
      const ms = now() - at;
      stats.latN++; stats.latSum += ms; stats.latLast = ms;
      if (ms > stats.latMax) stats.latMax = ms;
    }
    if (!current) { stats.orphans++; return false; }
    if (qid != null && qid !== '' && Number(qid) !== current.qid) { stats.stale++; return false; }
    if (qpart != null && qpart !== '' && Number(qpart) !== current.qpart) { stats.stale++; return false; }
    advance();
    return true;
  }

  function getState() {
    const st = Object.assign({}, stats);
    return {
      on: on,
      queue: queue.length,
      current: current ? {
        qid: current.qid, qpart: current.qpart,
        of: current.item.parts.length,
        text: String(current.text || '').slice(0, 60),
        waitingMs: now() - current.at,
        estMs: estMs(current.text),      // ★ 这句的兜底时长（方便与 latMaxMs 对照）
      } : null,
      stats: st,
      /* ★ 端到端延迟摘要 —— **核验兜底定标**用（详见 stats.latN 的说明） */
      lat: { n: st.latN, avgMs: st.latN ? Math.round(st.latSum / st.latN) : 0, maxMs: st.latMax, lastMs: st.latLast },
      cfg: { estPerChar: EST_PER_CHAR, estBase: EST_BASE, estMin: EST_MIN,
        estSample: { '10字': defaultEst('一二三四五六七八九十'), '25字': defaultEst('一二三四五六七八九十一二三四五六七八九十一二三四五') } },
      lastAt: lastAt, lastError: lastError,
    };
  }

  /* 清空（换局 / 重连 / 测试）。stats 保留 —— 它是观测面，不该被清掉。 */
  function reset() {
    clearTimer();
    current = null;
    queue.length = 0;
    return true;
  }

  /* ★★ 软清空（2026-10-03，用户拍板）——**换局 / 退出游戏**时用：
   *     · **正在播的那一句照常播完**（不许半句被吞）
   *     · 缓冲里**排队的全部丢弃**
   *   返回**被丢弃的句数**（0 = 本来就没积压 ⇒ 调用方据此决定要不要对外通报，
   *   这就是"**有条件**告诉人格"里的那个条件）。
   *   ★ 为什么不做成硬清空：她可能正说到一半。半句被吞比"多说一句"糟得多。 */
  function softReset() {
    let dropped = 0;
    for (const it of queue) {
      /* ★ 必须把"**正在播的那一句**"算作已放出，否则会多算 1 句。
       *   注意 `it.i` 只在 advance() 里自增，而**当前句在 emit 时还没自增**
       *   ⇒ 队首若正是 current.item，它的第 `i` 句已经在播了，不能再计入"待丢"。
       *   （这个 off-by-one 是单测抓出来的：期望丢 4 句、实际报 5。） */
      const released = it.i + ((current && current.item === it) ? 1 : 0);
      dropped += Math.max(0, it.parts.length - released);
    }
    queue.length = 0;
    if (dropped) {
      stats.truncated += dropped;
      log('SPEECH 软清空：丢弃缓冲中的 ' + dropped + ' 句（当前句仍会播完）');
    }
    return dropped;
  }

  return {
    push: push, report: report, getState: getState, reset: reset, softReset: softReset,
    /* ★ 2026-10-30：前端跳过的计数（只用于观测，推进动作由 report() 完成） */
    noteSkip: (why) => { stats.skipped++; stats.lastSkipWhy = String(why || ''); },
    get on() { return on; },
    setOn(v) { on = !!v; return on; },
  };
}

createSpeechQueue.defaultSplit = defaultSplit;
createSpeechQueue.defaultEst = defaultEst;
createSpeechQueue.DEFAULT_OFF = DEFAULT_OFF;

module.exports = createSpeechQueue;
