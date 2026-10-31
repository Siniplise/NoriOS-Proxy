/* nori_line_dedupe.js —— 台词内容级去重（纯函数、可单测）
 *
 * 背景（2026-10-18 用户实测）：森林寻宝 / 代号里，上游把同一条回复投递两次
 *   ⇒ 1~2 秒后出现第二条一字不差的 `SPEECH 入队`（qid 22/23、24/25、27/28）
 *   ⇒ 她整段说了两遍；气泡侧也能看到同名重复（msg_46 与 msg_48）。
 *
 * 语义：同一 normalized 文本（空白折叠 + 去首尾）在 windowMs 内再次到达 ⇒ 丢弃。
 *   · 只用于"要说出口"的台词（`pushGameLine` 里 speakable 才调）
 *   · windowMs=0 ⇒ 关闭（返回永不 drop）
 *   · 归一化很关键：上游两次投递可能只在空白/换行上有差异
 */
'use strict';

function normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function createLineDedupe(windowMs) {
  const win = Math.max(0, Number(windowMs) || 0);
  let last = '';
  let at = 0;
  /* 返回 {drop:boolean, agoMs?:number, text?:string} —— 纯判定，不做 IO */
  return function check(text, from, now) {
    const norm = normalize(text);
    if (!norm || win <= 0) return { drop: false };
    const ms = (now == null) ? Date.now() : Number(now);
    if (norm === last && ms - at < win) {
      return { drop: true, agoMs: ms - at, text: norm, from: from || '' };
    }
    last = norm;
    at = ms;
    return { drop: false };
  };
}

module.exports = { createLineDedupe: createLineDedupe, normalize: normalize };
