'use strict';
/*
 * nori-observe.js —— D1 全帧观测（★ 纯只读：绝不修改任何帧）
 * ============================================================
 * 目的：回答「会不会有我们漏掉的信息进入 chat.lines 导致气泡意外显示」。
 *      在此之前，nori_proxy.js 只记录 dispatch_ack / error 两种帧，
 *      所有携带 ingestBlock / agent_message / /lines patch 的帧【全无日志】。
 *
 * 设计铁律
 *   1. 只读 —— 不修改、不返回、不阻断任何帧（全部 try/catch 吞掉异常）
 *   2. 独立日志 —— 写 obs.log，不污染 proxy.log
 *   3. 可关闭 —— NORI_OBS=off
 *   4. 有界 —— 超过 NORI_OBS_MAX 字节自动轮转一次
 *
 * 环境变量
 *   NORI_OBS          on|off        默认 on
 *   NORI_OBS_VERBOSE  1             连"无关帧"也记（默认只记可能写 lines 的）
 *   NORI_OBS_LOG      <path>        默认 <此文件目录>/obs.log
 *   NORI_OBS_MAX      <bytes>       默认 8MB
 */

const fs = require('fs');
const path = require('path');

const ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_OBS || 'on'));
const VERBOSE = /^(on|1|yes|true)$/i.test(String(process.env.NORI_OBS_VERBOSE || ''));
const LOG_PATH = process.env.NORI_OBS_LOG || path.join(__dirname, 'obs.log');
const MAX_BYTES = Number(process.env.NORI_OBS_MAX || 8 * 1024 * 1024);

/* ── 从 bundle 逆出的「能写 chat.lines」的路径（见 _arch/86 §1.2）────────── */
const LINE_CMDS = new Set([
  'playerMessage', 'agentMessage', 'ingestBlock',
  'audioStarted', 'audioDone', 'setPresentationMode',
]);
const LINE_EVENTS = new Set(['player_message', 'agent_message']);
/* 前端渲染层认识的 sender 只有三种（_arch/86 §1.1） */
const KNOWN_SENDERS = new Set(['player', 'agent', 'chip']);

/* ★ 2026-10-02 补：**生命周期帧必须单独记明细**
 *   缺口（A2 实测暴露）：这些帧以前只进 byType 计数，而摘要又只打印 count 前 12 名
 *   ⇒ 小计数的类型被**截断隐藏** ⇒ 事后无法回答"某次退出到底有没有信号"。
 *   ★ 这正是 C4（接 cartridge_unmounted）需要的可见性。
 */
const LIFECYCLE_TYPES = new Set([
  'cartridge_mounted', 'cartridge_mounted_ack', 'cartridge_unmounted',
  'cartridge_unmounted_ack',
  'world_joined', 'world_left', 'open_media', 'close_media',
  'visibility_fence_advanced',   // 只记「变化」，不记每次（量大）
]);

/* ── 内部状态 ───────────────────────────────────────────────────────── */
/* ★ 2026-10-01 修：原来只按 cartridgeId 建键 ⇒ in/recv 与 in/send 互相覆盖，
   Δ 计数完全失真。改为按「卡带 + 流向/阶段」分别记，recv 与 send 各自算差分。 */
const linesByKey = new Map();       // `${cartridgeId}|${dir}/${stage}` -> 上一次的 lines
const stats = {
  frames: 0, interesting: 0, linesWrite: 0, unknownSender: 0, noSender: 0, errors: 0,
  byType: Object.create(null),
  bySender: Object.create(null),    // 所有见过的 sender 值 → 次数（★ 白名单原料）
  startedAt: Date.now(),
};
const recentUnknown = [];           // 最近若干条未知 sender（用于摘要去重）

/* ── 日志 ─────────────────────────────────────────────────────────── */
let fd = null;
let written = 0;
function openLog() {
  if (fd) return;
  try { fd = fs.openSync(LOG_PATH, 'a'); written = fs.fstatSync(fd).size; } catch (e) { fd = null; }
}
function rotateIfNeeded() {
  if (written < MAX_BYTES) return;
  try {
    fs.closeSync(fd); fd = null;
    const bak = LOG_PATH + '.1';
    try { fs.unlinkSync(bak); } catch (e) {}
    fs.renameSync(LOG_PATH, bak);
    written = 0;
  } catch (e) { fd = null; }
  openLog();
}
function w(line) {
  if (!ON) return;
  try {
    openLog();
    if (!fd) return;
    rotateIfNeeded();
    if (!fd) return;
    const s = '[' + new Date().toISOString().slice(11, 19) + '] ' + line + '\n';
    fs.writeSync(fd, s);
    written += Buffer.byteLength(s);
  } catch (e) { stats.errors++; }
}

/* ── 工具 ─────────────────────────────────────────────────────────── */
const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function lineBrief(el) {
  if (!el || typeof el !== 'object') return '(non-object)';
  const txt = el.content != null ? el.content : (el.text != null ? el.text : '');
  return 'sender=' + (el.sender || '(none)')
    + ' id=' + one(el.messageId || el.id, 16)
    + ' sp=' + (el.isSpeech === false ? '0' : '1')
    + ' len=' + String(txt).length
    + ' "' + one(txt, 70) + '"';
}

function diffLines(key, next) {
  const prev = linesByKey.get(key) || [];
  linesByKey.set(key, next);
  const prevIds = new Set();
  for (const e of prev) if (e && e.id != null) prevIds.add(String(e.id));
  const added = [], removed = [];
  for (const e of next) if (e && !prevIds.has(String(e.id))) added.push(e);
  const nextIds = new Set();
  for (const e of next) if (e && e.id != null) nextIds.add(String(e.id));
  for (const e of prev) if (e && !nextIds.has(String(e.id))) removed.push(e);
  return { added, removed, prevLen: prev.length, nextLen: next.length };
}

/* ★ 行构成直方图 —— 一眼看出「这一帧要往聊天框放什么身份的内容」 */
function composition(arr) {
  const h = Object.create(null);
  let noSender = 0;
  for (const e of arr) {
    const s = (e && e.sender != null) ? String(e.sender) : '(none)';
    if (s === '(none)') noSender++;
    h[s] = (h[s] || 0) + 1;
    stats.bySender[s] = (stats.bySender[s] || 0) + 1;
  }
  const parts = Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v);
  return { text: '{' + parts.join(' ') + '}', noSender };
}

/* ── 主入口：观察一帧（obj 可为字符串或已解析对象）─────────────────── */
function saw(input, dir, stage) {
  if (!ON) return;
  try {
    stats.frames++;
    let j = input;
    if (typeof j === 'string') {
      if (j.length > 400000) return;              // 超大帧跳过（避免卡顿）
      try { j = JSON.parse(j); } catch (e) { return; }
    }
    if (!j || typeof j !== 'object') return;

    const tag = dir + '/' + stage;
    const t = String(j.type || '');
    const cid = String(j.cartridgeId || '');
    stats.byType[t || '(none)'] = (stats.byType[t || '(none)'] || 0) + 1;

    const tr = j.transition;
    let interesting = false;
    const notes = [];

    /* ⓿ ★ 生命周期帧（2026-10-02 补）—— 单独立一行，不依赖 byType 摘要
     *   目的：回答「某次进/出游戏到底有没有信号」。以前只计数 ⇒ 被摘要截断隐藏。
     *   visibility_fence_advanced 量大，**只在计数跨越整数关口时记一次**（见下）。
     */
    if (LIFECYCLE_TYPES.has(t)) {
      if (t === 'visibility_fence_advanced') {
        const n = stats.byType[t];
        if (n === 1 || n % 200 === 0) {          // 首次 + 每 200 次记一行
          interesting = true;
          notes.push('LIFECYCLE ' + t + ' n=' + n);
        }
      } else {
        interesting = true;
        const keys = Object.keys(j).filter((k) => k !== 'type' && k !== 'transition');
        let payload = '';
        try {
          const p = j.cartridge || j.payload || j.data || (keys.length ? j : null);
          if (p) payload = JSON.stringify(p).slice(0, 300);
        } catch (e) {}
        notes.push('★★LIFECYCLE ' + t + ' cart=' + (cid || '-')
          + ' actor=' + (j.actor || '-') + ' reqId=' + one(j.requestId, 12)
          + ' keys=[' + keys.join(',') + ']');
        if (payload) notes.push('   payload ' + payload);
      }
    }

    /* ① patches —— ★ 最隐蔽：op:'replace' 可整数组替换 */
    if (tr && Array.isArray(tr.patches)) {
      for (const p of tr.patches) {
        if (!p || !p.path) continue;
        if (p.path === '/lines') {
          interesting = true; stats.linesWrite++;
          const v = Array.isArray(p.value) ? p.value : [];
          const d = diffLines(cid + '|' + tag, v);
          const comp = composition(v);
          notes.push('patch /lines op=' + p.op + ' n=' + v.length
            + ' Δ+' + d.added.length + '/-' + d.removed.length
            + ' 构成' + comp.text);
          for (const el of d.added) {
            notes.push('   +LINE ' + lineBrief(el));
            if (el && el.sender == null) {
              stats.noSender++;
              notes.push('   ★★NO_SENDER ' + lineBrief(el) + ' ← 前端会默认渲染成 Nori 气泡');
            } else if (el && !KNOWN_SENDERS.has(String(el.sender))) {
              stats.unknownSender++;
              recentUnknown.push({ cid, sender: el.sender, text: one(el.content || el.text, 60) });
              notes.push('   ★★UNKNOWN_SENDER ' + lineBrief(el));
            }
          }
          for (const el of d.removed) notes.push('   -LINE ' + lineBrief(el));
        } else if (p.path === '/operations') {
          interesting = true;
          const keys = (p.value && typeof p.value === 'object') ? Object.keys(p.value) : [];
          notes.push('patch /operations n=' + keys.length + ' op=' + p.op);
        } else if (VERBOSE) {
          notes.push('patch ' + p.path + ' op=' + p.op);
        }
      }
    }

    /* ② cmd —— 单条命令 */
    if (tr && tr.cmd && tr.cmd.type) {
      const ct = String(tr.cmd.type);
      if (LINE_CMDS.has(ct)) {
        interesting = true;
        if (ct === 'ingestBlock') stats.linesWrite++;
        notes.push('cmd ' + ct + ' op=' + one(tr.cmd.operationId, 10)
          + ' blk=' + tr.cmd.blockId + ' sp=' + (tr.cmd.isSpeech === false ? '0' : '1')
          + ' "' + one(tr.cmd.content || tr.cmd.text, 70) + '"');
      } else if (VERBOSE) {
        notes.push('cmd ' + ct);
      }
    }

    /* ③ events —— 事件数组 */
    if (tr && Array.isArray(tr.events)) {
      for (const ev of tr.events) {
        if (!ev || !ev.type) continue;
        const et = String(ev.type);
        if (LINE_EVENTS.has(et)) {
          interesting = true;
          notes.push('ev ' + et + ' msg=' + one(ev.messageId, 16)
            + ' "' + one(ev.content, 70) + '"');
        } else if (VERBOSE) {
          notes.push('ev ' + et);
        }
      }
    }

    /* ④ 出站：客户端命令（含玩家真发言 / 我们注入的）*/
    if (dir === 'out' && t === 'dispatch' && j.cmd && j.cmd.type) {
      const ct = String(j.cmd.type);
      interesting = true;
      const isInject = /【NoriOS战报/.test(String(j.cmd.text || ''));
      notes.push('CLI cmd=' + ct + ' cart=' + cid + ' actor=' + (j.actor || '?')
        + ' len=' + String(j.cmd.text || j.cmd.content || '').length
        + (isInject ? ' ★INJECT' : '')
        + ' "' + one(j.cmd.text || j.cmd.content, 70) + '"');
    }

    if (interesting) {
      stats.interesting++;
      w('OBS ' + tag.padEnd(9) + ' ' + (t || '-').padEnd(20) + ' cart=' + (cid || '-').padEnd(12) + ' | ' + notes.join(' | '));
    } else if (VERBOSE) {
      w('OBS ' + tag.padEnd(9) + ' ' + (t || '-'));
    }
  } catch (e) {
    stats.errors++;
    try { w('OBS ERR ' + dir + '/' + stage + ' ' + e.message); } catch (e2) {}
  }
}

/* ── 摘要（可周期性调用）────────────────────────────────────────────── */
function summary(why) {
  if (!ON) return;
  try {
    const up = Math.round((Date.now() - stats.startedAt) / 1000);
    const byType = Object.entries(stats.byType)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, v]) => k + '=' + v).join(' ');
    w('OBS ==== SUMMARY (' + (why || 'periodic') + ') 运行 ' + up + 's'
      + ' frames=' + stats.frames
      + ' interesting=' + stats.interesting
      + ' linesWrite=' + stats.linesWrite
      + ' ★noSender=' + stats.noSender
      + ' ★unknownSender=' + stats.unknownSender
      + ' err=' + stats.errors);
    if (byType) w('OBS      byType: ' + byType);
    /* ★ 2026-10-02 补：生命周期计数**单独一行**（避免被上面 top-12 截断藏掉） */
    const lc = [...LIFECYCLE_TYPES]
      .map((k) => [k, stats.byType[k] || 0])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => k + '=' + v).join(' ');
    w('OBS      ★LIFECYCLE: ' + (lc || '(none)'));
    const byS = Object.entries(stats.bySender).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => k + '=' + v).join(' ');
    if (byS) w('OBS      ★所有出现过的 sender: ' + byS);
    if (recentUnknown.length) {
      const seen = new Set();
      const uniq = [];
      for (const u of recentUnknown) {
        const k = String(u.sender) + '|' + u.text.slice(0, 30);
        if (seen.has(k)) continue;
        seen.add(k); uniq.push(u);
        if (uniq.length >= 8) break;
      }
      for (const u of uniq) w('OBS      ★unknown sender=' + u.sender + ' cart=' + u.cid + ' "' + u.text + '"');
      recentUnknown.length = 0;
    }
  } catch (e) { stats.errors++; }
}

function getStats() { return JSON.parse(JSON.stringify(stats)); }

module.exports = { saw, summary, getStats, ON, VERBOSE, LOG_PATH };
