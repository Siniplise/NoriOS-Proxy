'use strict';
/*
 * nori-lifecycle.js —— C4+C5：游戏生命周期 → 让她知道
 * ==========================================================================
 * 背景（实测证据）
 *   1. `cartridge_mounted` / `cartridge_unmounted` **一直由服务端发出**（T3 + 2026-10-02 复测）
 *      payload 极简：`{"type":"cartridge_unmounted","worldId":"…","cartridgeId":"codenames"}`
 *   2. 但 `nori_proxy.js` **只处理了 mount**（打 `GAME mount cid=…` 日志），
 *      **unmounted 完全没接** ⇒ 她不知道你退出了
 *   3. ★★ A2 实测：exe 给 LLM 的 `messages` 是**固定 14 条的滚动窗口**
 *      ⇒ 我们 append 的消息**只活一轮**，下一轮被挤掉
 *      ⇒ **状态类信息必须【每轮都带】**（这不是妥协，是因为滚动窗口决定的正确做法）
 *
 * 设计
 *   · 本模块**只读**（不改任何帧），维护一个极小的状态机
 *   · 两个方向的使用方：
 *       - `nori_proxy.js`      喂帧：`onFrame(obj)`
 *       - `nori-llm-route.js`  取文本：`render()`  → 追加为一条 system 消息
 *   · 同进程内 require 同一实例 ⇒ 天然共享状态（无需 IPC）
 *
 * 状态机
 *   idle ──mounted──► playing(cart, since) ──unmounted──► ended(cart, since, until=now+TTL)
 *                                                              │  TTL 到期
 *                                                              └──► idle
 *   · `playing` 无 TTL（他还在玩）
 *   · `ended` 有 TTL（默认 10 分钟）—— 过后她就"不再记得"他退出了，
 *     否则一周后聊天时她还会以为他刚退出游戏
 *
 * 铁律
 *   1. **只读** —— 绝不修改、阻断、延迟任何帧
 *   2. **可关** —— `NORI_LIFE=off` ⇒ `render()` 恒返回 null（行为回到今天之前）
 *   3. **不改 `messages[0]`** —— 调用方只 append（§89 D5）
 *
 * 环境变量
 *   NORI_LIFE      on|off   默认 on
 *   NORI_LIFE_TTL  <ms>     ended 状态保留时长，默认 600000（10 分钟）
 */

const fs = require('fs');

const ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_LIFE || 'on'));
const TTL_MS = Number(process.env.NORI_LIFE_TTL || 10 * 60 * 1000);

/* ── 游戏规则（game.md）：**只在玩的时候带** ────────────────────────────
 * ★ 2026-10-07（M3「脱离 V4.4」）：V4.4 把游戏机制**常驻**；"脱离"之后，
 *   她不该在没玩游戏的时候还背着一份规则 ⇒ 挂到 `playing` 分支。
 * ★ 为什么挂在 lifecycle 而不是别的模块：`nori-llm-route.js` 的 `spliceAndSend`
 *   每轮 append 一条 system，而 exe 的 messages 是滚动窗口（§89 实测）
 *   ⇒ **状态必须每轮都带** ⇒ 放这里天然"玩时带、退出停"，退出后不需要额外撤销。
 * ★ 只切出**当前卡带那一节**（+通用注意）：4.8KB → ≈1.2KB。
 *   切不出（标题被改）⇒ **退化为整份**，绝不让她"手里没规则"。
 * 环境变量
 *   NORI_GAMERULES       on|off  默认 on
 *   NORI_GAME_RULES_PATH <path>  默认 persona/prompts/public/game.md
 */
const RULES_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_GAMERULES || 'on'));
const RULES_PATH = process.env.NORI_GAME_RULES_PATH
  || (__dirname + '/data/game.md');
const SECTION_FOR = { codenames: '森林寻宝', chess: '国际象棋', cakeduel: '蛋糕对决', pictionary: '你画我猜' };

let RULES_ALL = '';     // 整份（切节失败时的退化）
let RULES_HEAD = '';    // 第一个 `## ` 之前（标题 + 引导语）
let RULES_SEC = {};     // '一、森林寻宝' → 正文

/* 按 `## ` 二级标题切节；首个标题之前的内容归 head。
 * ★ 标题行**保留在节正文里** —— 与"整份注入"时的形态一致（否则她看到的文本
 *   少了「一、森林寻宝」这类分类头，而整份注入时是有的 ⇒ 两种路径形态不一致）。 */
function splitSections(md) {
  const secs = {};
  const head = [];
  let cur = null;
  let buf = [];
  for (const l of String(md).split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    if (m) {
      if (cur) secs[cur] = buf.join('\n').trim();
      cur = m[1]; buf = [l];              // ★ 标题行入正文
    } else if (cur) {
      buf.push(l);
    } else {
      head.push(l);
    }
  }
  if (cur) secs[cur] = buf.join('\n').trim();
  return { head: head.join('\n').trim(), secs };
}

function loadRules() {
  if (!RULES_ON) { RULES_ALL = ''; RULES_HEAD = ''; RULES_SEC = {}; return false; }
  try {
    const raw = fs.readFileSync(RULES_PATH, 'utf8');
    const { head, secs } = splitSections(raw);
    RULES_ALL = String(raw).trim();
    RULES_HEAD = head;
    RULES_SEC = secs;
    return true;
  } catch (e) {
    RULES_ALL = ''; RULES_HEAD = ''; RULES_SEC = {};
    try { console.log('[LIFE] ★★ 游戏规则加载失败（' + RULES_PATH + '）：' + e.message); } catch (e2) {}
    return false;
  }
}
loadRules();

/* 组装给她的规则文本；未知卡带 / 切不出 ⇒ 整份 */
function rulesText(cart) {
  if (!RULES_ALL) return '';
  let body = RULES_ALL;
  const name = SECTION_FOR[String(cart || '')];
  if (name) {
    const key = Object.keys(RULES_SEC).find((k) => k.indexOf(name) >= 0);
    if (key) {
      const common = Object.keys(RULES_SEC).find((k) => k.indexOf('通用') >= 0);
      body = [RULES_HEAD, RULES_SEC[key], common ? RULES_SEC[common] : '']
        .filter(Boolean).join('\n\n');
    }
  }
  return [
    '【游戏规则｜只给你这一局要玩的那部分，退出就不用记了】',
    body,
  ].join('\n');
}

/* 与 nori_proxy.js 的 GAME_CN 保持一致（那边也有，独立模块不跨依赖） */
const GAME_CN = {
  codenames: '森林寻宝',
  chess: '国际象棋',
  cakeduel: '蛋糕对决',
  pictionary: '你画我猜',
};
function cnGame(id) { return GAME_CN[id] || id || '某个游戏'; }

/* ── 游戏白名单 ─────────────────────────────────────────────────────────
 * ★ 只有这些卡带算"在玩游戏"。其余（chat / manifold.web / …）是基础设施，
 *   开机就会 mount ⇒ 若不排除，会把"桌面"误报成"在玩游戏"。
 *   可用 `NORI_LIFE_GAMES=codenames,chess` 覆盖（便于将来加新游戏）。
 */
const GAME_SET = new Set(
  (process.env.NORI_LIFE_GAMES
    ? String(process.env.NORI_LIFE_GAMES).split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(GAME_CN))
);
function isGameCart(id) { return !!id && GAME_SET.has(String(id)); }

/* ── 状态（唯一一份，进程内共享）────────────────────────────────────────── */
const state = {
  phase: 'idle',        // idle | playing | ended
  cart: null,           // 'codenames' | ...
  since: 0,             // playing 开始时刻 / ended 的对应开局时刻
  until: 0,             // ended 的过期时刻（0 = 不过期）
  mountedAt: 0,
  endedAt: 0,
  seq: 0,               // 状态变更序号（便于日志/去重）
};

/* 仅在 phase 真正变化时自增，避免同一次事件被重复记（mount 帧可能多个方向到达） */
let lastLog = '';

function setPhase(p, cart, extra) {
  const changed = (state.phase !== p) || (state.cart !== cart);
  state.phase = p;
  state.cart = cart;
  if (changed) state.seq++;
  if (extra) Object.assign(state, extra);
  return changed;
}

/* ── 主入口：喂一帧（只读）────────────────────────────────────────────── */
/**
 * @param {object|string} frame  一帧（对象或 JSON 字符串）
 * @param {string} [dir]         方向标记（仅用于日志）
 * @returns {boolean}            是否识别为生命周期帧
 */
function onFrame(frame, dir) {
  if (!ON) return false;
  let j = frame;
  try {
    if (typeof j === 'string') j = JSON.parse(j);
  } catch (e) { return false; }
  if (!j || typeof j !== 'object') return false;

  const t = String(j.type || '');
  const cart = j.cartridgeId ? String(j.cartridgeId) : '';

  /* ★★ 2026-10-02 修（实测暴露的真 bug）：
   *   开机/刷新时 `manifold.web`、`chat` 等**基础设施卡带也会 mount**，
   *   实测日志：`[LIFE] mounted manifold.web` / `[LIFE] mounted chat`。
   *   若不过滤 ⇒ 她会被告知「他现在正和你一起玩『chat』」—— 荒谬。
   *   （用户第一次 V2 侥幸没显形：因为 codenames 恰好是最后一个 mount。）
   *   ⇒ **只认真正的游戏卡带**（白名单 = GAME_CN 的键，可用 NORI_LIFE_GAMES 覆盖）。
   */
  if (!isGameCart(cart)) return false;

  /* ① 进入游戏 */
  if (t === 'cartridge_mounted' && cart) {
    const now = Date.now();
    const changed = setPhase('playing', cart, { since: now, mountedAt: now, until: 0, endedAt: 0 });
    if (changed) {
      const line = '[LIFE] mounted ' + cart + ' (' + cnGame(cart) + ') ' + (dir || '');
      if (line !== lastLog) { lastLog = line; try { console.log(line); } catch (e) {} }
    }
    return true;
  }

  /* ② 退出游戏 —— ★ 这就是今天之前【完全没接】的那条 */
  if (t === 'cartridge_unmounted' && cart) {
    const now = Date.now();
    const wasPlaying = state.phase === 'playing' && state.cart === cart;
    const changed = setPhase('ended', cart, {
      endedAt: now,
      until: now + TTL_MS,
      // 若之前的 playing 不是这个卡带（异常情况），就按"不知道何时开始"处理
      since: wasPlaying ? state.since : 0,
    });
    if (changed) {
      const played = wasPlaying && state.since ? Math.round((now - state.since) / 1000) + 's' : '?';
      const line = '[LIFE] unmounted ' + cart + ' (' + cnGame(cart) + ') played=' + played + ' ' + (dir || '');
      if (line !== lastLog) { lastLog = line; try { console.log(line); } catch (e) {} }
    }
    return true;
  }

  return false;
}

/* ── 给 LLM 的渲染（append 一条 system）──────────────────────────────── */
/**
 * ★ TTL 到期 → 忘掉（`ended` 只是"他刚退出"的短时记忆，过后不该再挂着）。
 * 抽成函数是因为 **getState() 也必须先走这一步** ——
 * 原来只在 render() 里做，而 getState() 是先读 state.phase、**再**调 render()
 * ⇒ 端点会一直显示 `phase:"ended"` + `endedTtlLeftSec:0`（自相矛盾，读的人会以为没生效）。
 * 2026-10-02 实测发现：`endedAgoSec:702 / endedTtlLeftSec:0 / phase:"ended"`。
 */
function sweep(now) {
  if (state.phase === 'ended' && state.until && now >= state.until) {
    setPhase('idle', null, { since: 0, until: 0, endedAt: 0, mountedAt: 0 });   // TTL 到期 → 忘掉
  }
}

/**
 * 返回要追加的提示文本；无需追加时返回 null。
 * ★ 铁律：调用方**只 append**，绝不修改 messages[0] 或最后一条 user。
 */
function render() {
  if (!ON) return null;
  const now = Date.now();

  sweep(now);

  if (state.phase === 'playing') {
    const mins = state.mountedAt ? Math.floor((now - state.mountedAt) / 60000) : 0;
    const howLong = mins <= 0 ? '刚开始' : ('已经玩了大约 ' + mins + ' 分钟');
    const parts = [
      '【NoriOS 系统状态｜这类消息不是他打的字】',
      '· 他现在正和你一起玩「' + cnGame(state.cart) + '」，' + howLong + '。',
      '· 你可以自然地把它当成正在发生的事（比如聊聊局面、开个小玩笑），',
      '  但不要机械复述这条提示，也不要说"收到系统通知"之类的话。',
    ];
    const r = rulesText(state.cart);      // ★ 只在 playing 带；ended / idle 一律不带
    if (r) parts.push(r);
    return parts.join('\n');
  }

  if (state.phase === 'ended') {
    const played = (state.since && state.endedAt)
      ? Math.round((state.endedAt - state.since) / 1000)
      : 0;
    const ago = Math.round((now - state.endedAt) / 1000);
    const agoStr = ago < 60 ? '刚刚' : ('大约 ' + Math.round(ago / 60) + ' 分钟前');
    return [
      '【NoriOS 系统状态｜这类消息不是他打的字】',
      '· 他' + agoStr + '退出了「' + cnGame(state.cart) + '」' + (played > 30 ? '（这局玩了大约 ' + Math.round(played / 60) + ' 分钟）' : '') + '。',
      '· 他还没说为什么退出。你可以关心一下、问问怎么不玩了，或者约他再玩；',
      '  也可以什么都不提。但不要机械复述这条提示，也不要说"收到系统通知"。',
    ].join('\n');
  }

  return null;
}

/* ── 只读状态（给 /nori-lifestat）────────────────────────────────────── */
function getState() {
  const now = Date.now();
  sweep(now);                   // ★ 先让 TTL 生效，否则 phase 会永远停在 "ended"（见 sweep 的注释）
  return {
    on: ON, ttlSec: Math.round(TTL_MS / 1000),
    phase: state.phase, cart: state.cart, seq: state.seq,
    playingSec: state.phase === 'playing' && state.mountedAt ? Math.round((now - state.mountedAt) / 1000) : 0,
    endedAgoSec: state.phase === 'ended' && state.endedAt ? Math.round((now - state.endedAt) / 1000) : 0,
    endedTtlLeftSec: state.phase === 'ended' && state.until ? Math.max(0, Math.round((state.until - now) / 1000)) : 0,
    preview: render(),          // 现在会 append 什么（便于你直接看）
  };
}

/* ── 代理重启后的状态恢复 ───────────────────────────────────────────────
 * 问题：状态在内存里 ⇒ **代理重启就丢**（错过 mount 帧，phase 停在 idle）。
 *      我每次调试都会重启代理，若不恢复，用户正在玩的局就"看不见"了。
 * 做法：调用方（nori_proxy.js）在**转发 LLM 请求前**告诉我
 *      `GAME_SESSION.cartridgeId`（它一直知道当前游戏）。
 *      只在 `phase==='idle'` 且是游戏卡带时才补一次 mount。
 * ★ 只在 idle 补 —— 绝不覆盖真实状态（否则会把 ended 打回 playing）。
 */
function hydrate(cart) {
  if (!ON) return false;
  if (!isGameCart(cart)) return false;
  if (state.phase !== 'idle') return false;
  const now = Date.now();
  setPhase('playing', String(cart), { since: now, mountedAt: now, until: 0, endedAt: 0 });
  try { console.log('[LIFE] hydrate from GameSession: ' + cart + ' (' + cnGame(cart) + ')'); } catch (e) {}
  return true;
}

/* ── 强制重置（测试用；也可给"重置记忆"流程用）──────────────────────── */
function reset() {
  setPhase('idle', null, { since: 0, until: 0, endedAt: 0, mountedAt: 0 });
}

module.exports = { onFrame, render, getState, reset, hydrate, isGameCart, ON, TTL_MS, GAME_CN, GAME_SET, cnGame };
