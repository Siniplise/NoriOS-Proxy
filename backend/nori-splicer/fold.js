'use strict';
/*
 * nori-splicer/fold.js —— 折叠：PENDING 太长时必须压缩
 * ═══════════════════════════════════════════════════════════════════════
 * 场景（_arch/89 §5.2）：玩家玩一小时不说话 ⇒ PENDING 积压 60 条 ⇒ 一次性塞进 prompt
 *   ⇒ ① 上下文被游戏事件淹没 ② prompt 变长 ③ 她的回复会"复述事件列表"
 *
 * ★ 这是**语义级折叠**（不是帧级合并）：
 *   保留首（开局语境）+ 尾（当前局面），中间压成**一条摘要**。
 *
 * ★★ 摘要里**只统计客观次数**，绝不编造因果（与 render.js 同一条铁律）。
 *    ✅「他给了 6 个提示；你们猜了 9 次，中了 5 次」
 *    ❌「你们势均力敌」← 这是评价，不是事实
 */

/* 摘要里出现的动作 → 中文（只用于聚合计数） */
const ACT_CN = { clue: '给提示', guess: '猜词', turn_end: '轮次结束', card_reveal: '翻牌' };

/**
 * 把 mid 段聚合成一句话
 * @param {Array} mid
 * @returns {{k:string, kind:string, text:string, folded:number}}
 */
function summarize(mid) {
  if (!mid || !mid.length) return null;
  const byType = {};
  let guessHit = 0, guessAll = 0;
  for (const x of mid) {
    const t = x.type || '?';
    byType[t] = (byType[t] || 0) + 1;
    if (t === 'guess') {
      guessAll++;
      if (x.payload && x.payload.result === 'agent') guessHit++;
    }
  }
  const bits = [];
  /* ★ "猜词 X 次（中 Y 次）"必须连在一起 —— 否则会读成"给提示 16 次其中猜中 33 次"（实测撞到） */
  if (guessAll) bits.push('猜词 ' + guessAll + ' 次（中 ' + guessHit + ' 次）');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    if (t === 'guess') continue;                 // 已处理
    if (bits.length >= 3) break;
    bits.push((ACT_CN[t] || t) + ' ' + n + ' 次');
  }
  return {
    k: '__fold__',
    kind: 'summary',
    type: '__fold__',
    folded: mid.length,
    text: '（中间省略了 ' + mid.length + ' 条对局记录：' + bits.join('，') + '）',
  };
}

/**
 * 折叠到 max 条以内
 * @param {Array} list   快照（有序，旧 → 新）
 * @param {number} max   上限（默认 12）
 * @returns {Array}
 */
function fold(list, max) {
  max = Number(max) || 12;
  const arr = Array.isArray(list) ? list : [];
  if (arr.length <= max) return arr;

  /* ★ 空间太小时不做"首尾保留 + 摘要"（否则 2+1+1=4 > max 会**超出上限**）。
   *   单测抓到的真 bug：max=3 时返回了 4 条。 */
  if (max <= 3) return arr.slice(-max);

  const headN = 2;                    // 最早的 2 条 = 开局语境
  const tailN = Math.max(1, max - headN - 1);   // 其余给最新（留 1 条给摘要）
  const head = arr.slice(0, headN);
  const tail = arr.slice(arr.length - tailN);
  const mid = arr.slice(headN, arr.length - tailN);

  const sum = summarize(mid);
  return sum ? head.concat([sum], tail) : head.concat(tail);
}

module.exports = { fold, summarize };
