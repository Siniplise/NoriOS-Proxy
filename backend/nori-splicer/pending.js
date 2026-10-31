'use strict';
/*
 * nori-splicer/pending.js —— E4「投递匣」（PENDING）
 * ═══════════════════════════════════════════════════════════════════════
 * 这里取代了原来 nori_proxy.js 里的 `COMMENT_Q`（战报队列）。
 * 区别（_arch/89 §5 / §6）：
 *   · 承载的是**已分类的 Envelope**（带 kind），不是裸字符串
 *   · 幂等靠**协议自带的 id**（cartridgeId+version+index），**绝不用 Date.now()**
 *     —— 实测：游戏事件自带 `version`/`index`，天然唯一且跨路径稳定
 *
 * ★★★ 关键设计：**不 drain**（与 _arch/89 早期草稿相反，且这是对的）
 *   原因来自 A2 的实测：exe 每轮自己重建**固定 14 条** messages ⇒
 *   我们 append 的 system **只活一轮**。若"投递后就移除"，下一轮她就忘了在玩什么。
 *   ⇒ **状态类信息必须每轮都带**（这是滚动窗口决定的正确做法，不是妥协）。
 *   所以 PENDING 是**环形缓冲**：保留最近 N 条，每轮取最近 max 条（经 fold 压缩）。
 *
 * 「出口级幂等」在这里的含义是：**同一条事件不得因重试/多路径而被记两次**，
 * 由 `keyOf()` 的协议 id 保证。
 */

const MAX_KEEP = Number(process.env.NORI_SPLICE_KEEP || 60);      // 环形缓冲上限
const TTL_MS = Number(process.env.NORI_SPLICE_TTL || 30 * 60 * 1000);  // 30 分钟
const MAX_SEEN = Number(process.env.NORI_SPLICE_SEEN || 2000);    // 幂等键表上限

const list = [];          // [{k, kind, game, type, text, ts, payload}]
const seen = new Set();
const seenFifo = [];

const stats = { pushed: 0, dup: 0, expired: 0, trimmed: 0, resets: 0 };

/* ── 幂等键：**协议自带 id**，不用时间戳 ──────────────────────────────── */
function keyOf(u) {
  const p = (u && u.payload) || {};
  const v = (p.version != null) ? p.version : (u && u.version != null ? u.version : '?');
  const i = (p.index != null) ? p.index : '?';
  return [u && u.cartridgeId || '', u && u.type || '', v, i].join('|');
}

function rememberSeen(k) {
  seen.add(k);
  seenFifo.push(k);
  while (seenFifo.length > MAX_SEEN) {
    const old = seenFifo.shift();
    seen.delete(old);
  }
}

function sweep(now) {
  // TTL 清理（她不需要很久以前的对局事件）
  while (list.length && now - list[0].ts > TTL_MS) { list.shift(); stats.expired++; }
  // 环形上限
  while (list.length > MAX_KEEP) { list.shift(); stats.trimmed++; }
}

/**
 * 投递一条（已渲染好的）内容
 * @param {{cartridgeId:string, type:string, kind:string, payload:object}} unit
 * @param {string} text  渲染后的句子（render() 的结果）
 * @returns {boolean} 是否真的入队（false = 重复被忽略）
 */
function push(unit, text) {
  if (!unit || !text) return false;
  const now = Date.now();
  const k = keyOf(unit);
  if (seen.has(k)) { stats.dup++; return false; }
  rememberSeen(k);
  list.push({
    k, ts: now,
    kind: unit.kind || 'game-event',
    game: unit.cartridgeId || '',
    type: unit.type || '',
    text: String(text).slice(0, 200),
    payload: unit.payload || null,
  });
  stats.pushed++;
  sweep(now);
  return true;
}

/** 快照（**不移除** —— 见文件头"不 drain"） */
function snapshot() {
  sweep(Date.now());
  return list.slice();
}

/** 新局开始 ⇒ 清掉幂等键（version/index 会从头计数，否则新局事件会被误判为重复） */
function onNewGame() {
  seen.clear();
  seenFifo.length = 0;
  stats.resets++;
}

/** 完全清空（测试 / 重置用） */
function reset() {
  list.length = 0;
  seen.clear();
  seenFifo.length = 0;
}

function getStats() {
  return Object.assign({ size: list.length, maxKeep: MAX_KEEP, ttlSec: Math.round(TTL_MS / 1000) }, stats);
}

module.exports = { push, snapshot, onNewGame, reset, getStats, keyOf, MAX_KEEP, TTL_MS };
