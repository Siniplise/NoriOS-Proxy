/* nori-chip-content.js — 分析芯片「内容通道」：contentKey → 被扫对象的**正文**
 *
 * 依据：
 *   _arch/126_芯片与记忆总架构v3.md §二（四层模型 / 正文层）
 *   _arch/125_芯片是LLM读内容而非固定台词.md（结论：官方是让 LLM 读正文）
 *   _arch/127_喂原文的污染实验.md（实测：原文只进**当轮任务块**，记忆里只写摘要）
 *
 * 【性质】**纯只读** —— 只读 live_world_pack.json 与 persona/chip.json，
 *   不写任何状态、不改任何帧、不联网。可安全 require。
 *
 * 【覆盖】实测 457/483 = 95% 的可扫对象能取到正文（其余 26 条是图片/可执行/终端/虚拟根）。
 *
 * ══════ 三条实测约束（改之前必须先读）══════
 *   1. **训练日志在 `data.trainlog.items[].t`，不是 `data.body_md`**
 *      —— 用 body_md 会取到空串（125 初期就踩过这个坑）
 *   2. **网页原始 HTML p50 = 24 637 字符，剥标签后 p50 只有 240**
 *      —— 那 24K 几乎全是框架样板；必须 strip 再截断，否则 token 爆炸
 *   3. **截断阈值 3000，不是 8000**
 *      —— 127 §九实测：8000 字会让 LLM input 从 6.2K 涨到 11.2K；
 *         而训练日志只有 141~574 字，3000 已覆盖 99% 场景
 * ══════════════════════════════════════════
 */
'use strict';
const fs = require('fs');

const PACK_PATH = process.env.NORI_PACK_PATH
  || (__dirname + '/data/live_world_pack.json');
const CHIP_PATH = process.env.NORI_CHIP_PATH
  || (__dirname + '/data/chip.json');
const CAP = Math.max(200, Number(process.env.NORI_CHIP_CAP || 3000));

/* ★★ 2026-10-07 实测修正（重要）：
 *   浏览器的 contentKey 不是 `page:<pageId>`，而是 **`page:<完整URL>`**！
 *   真实抓包：`page:https://meridianpost.com/article/vertumn-aleph-launch`
 *   （此前 122 的 `page:${envelopeId}` 假设是错的。）
 *   ⇒ byPage 必须**同时注册 id 与 url 两个键**（以及 aliases，其值就是 URL），
 *     否则「扫网页」全部取不到正文 —— 而网页占可扫对象的 359/483。
 *   实测：359 页的 `data.url` 全唯一，且与客户端发来的 URL **逐字相同** ⇒ 直接查，无需归一化。 */
let byPage = null;   // pageId 或 URL(均去 page: 前缀) -> { text, title, pageId }
let urlToId = null;  // URL -> pageId（供 chipKeys 反推 id 形式）
let byFile = null;   // fileId(去 file:/vault: 前缀) -> { text, title }
let byMail = null;   // mailId(去 mail: 前缀) -> { text, title }
let byThread = null; // threadId -> { text, title }
let CHIP = null;     // chip.json 的 chip 表
let built = false;
let lastErr = '';

/* ══════════════════ HTML 剥离 ══════════════════ */
const BLOCK_TAGS = /<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/header|\/footer)\s*\/?>/gi;
function stripHtml(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(BLOCK_TAGS, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#0?39;/g, "'")
       .replace(/&hellip;/gi, '...')
       .replace(/&mdash;/gi, '—');
  t = t.replace(/[ \t\u3000]+/g, ' ');
  t = t.replace(/\n[ \t]+/g, '\n');
  t = t.replace(/\n{2,}/g, '\n');
  return t.trim();
}

/* ══════════════════ 各实体的正文字段（★ 约束 1） ══════════════════ */
function fileBody(d) {
  // 训练日志：items[].t 拼接（**不是 body_md**）
  if (d.trainlog) {
    const it = d.trainlog && (Array.isArray(d.trainlog) ? d.trainlog : d.trainlog.items);
    if (Array.isArray(it)) {
      const s = it.map((x) => String((x && x.t) || '')).filter(Boolean).join('\n');
      if (s) return s;
    }
  }
  for (const k of ['body_md', 'body', 'text', 'content', 'content_md', 'body_text']) {
    if (d[k]) return String(d[k]);
  }
  return '';
}

/* ══════════════════ 建索引（启动一次；★ 不要每帧重读 22 MB） ══════════════════ */
function build() {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  byPage = new Map(); byFile = new Map(); byMail = new Map(); byThread = new Map();
  urlToId = new Map();

  for (const p of (pack.browser_pages || [])) {
    const d = p.data || {};
    const raw = d.body_html || d.body_md || d.body || '';
    const entry = {
      text: stripHtml(raw),
      title: String(d.title || p.key || p.id),
      pageId: String(p.id),
    };
    /* ★ 注册三个键：pageId · data.url（运行时真值）· aliases（值同为 URL） */
    byPage.set(String(p.id), entry);
    const url = String(d.url || '');
    if (url) { byPage.set(url, entry); urlToId.set(url, String(p.id)); }
    for (const a of (p.aliases || [])) {
      const s = String(a || '');
      if (s && !byPage.has(s)) { byPage.set(s, entry); if (!urlToId.has(s)) urlToId.set(s, String(p.id)); }
    }
  }

  for (const f of (pack.file_artifacts || [])) {
    const d = f.data || {};
    let txt = fileBody(d);
    if (txt && /<[a-z][\s\S]*>/i.test(txt)) txt = stripHtml(txt);   // 个别 body_md 里带 HTML
    byFile.set(String(f.id), { text: txt, title: String(d.display_path || d.title || f.id) });
  }

  for (const m of (pack.mail_artifacts || [])) {
    const d = m.data || {};
    let txt = d.body_md || d.body || d.text || '';
    if (txt && /<[a-z][\s\S]*>/i.test(txt)) txt = stripHtml(txt);
    byMail.set(String(m.id), { text: String(txt), title: String(d.subject || d.title || m.id) });
  }

  // 会话：把同一 thread 的所有消息按时间合并
  for (const key of Object.keys(pack)) {
    if (!/signal.*artifact/i.test(key)) continue;
    for (const s of (pack[key] || [])) {
      const d = s.data || {};
      const tid = d.thread_id != null ? String(d.thread_id)
                : (s.id != null && /^[a-z_]+$/i.test(String(s.id)) ? String(s.id) : '');
      const body = String(d.body_md || d.body || d.text || '');
      if (!body) continue;
      const cur = byThread.get(tid) || { text: '', title: String(d.sender_name || tid), parts: [] };
      cur.parts.push(body);
      byThread.set(tid, cur);
      byThread.get(tid).text = cur.parts.join('\n');
    }
  }
  for (const [k, v] of byThread) { delete v.parts; }

  return { pages: urlToId.size, files: byFile.size, mails: byMail.size, threads: byThread.size };
}

function loadChip() {
  try {
    const j = JSON.parse(fs.readFileSync(CHIP_PATH, 'utf8'));
    CHIP = (j && j.chip) ? j.chip : {};
  } catch (e) { CHIP = {}; lastErr = 'chip.json: ' + e.message; }
  return Object.keys(CHIP).length;
}

function ensure() {
  if (built) return true;
  try { build(); loadChip(); built = true; }
  catch (e) { lastErr = String(e && e.message || e); return false; }
  return true;
}

/* ══════════════════ 主入口 ══════════════════ */

/* contentKey 的前缀 → 去哪个索引查。
 * ★ 兼容两种形式：
 *   ① **真实 contentKey**（客户端原始值）：`page:` / `file:` / `vault:` / `mail:` / `signal:`
 *   ② **chip.json 的 key 去掉 appId 后**：`preview:file.x` 去 appId 剩 `file.x`，
 *      但若调用方误传整键 `preview:file.x`，前缀是 preview —— 也让它命中（同一份文件）
 * ⇒ 两边都工作，避免"传错形式就静默取不到"这种最难查的 bug。 */
const FAMILY = {
  page: 'page', browsers: 'page', browser: 'page',
  file: 'file', vault: 'file', files: 'file', preview: 'file',
  mail: 'mail', mails: 'mail',
  signal: 'signal', signals: 'signal',
};
const KIND_OF = { page: 'html', file: 'file', mail: 'mail', signal: 'signal' };

/** contentKey → { text, title, kind, truncated }
 *  contentKey 是**客户端原始值**（带自身命名空间），如：
 *    page:browser.xxx · file:file.xxx · vault:app.cult · mail:mail.xxx · signal:daniel
 *  ⚠ chip.json 的键是 `appId:rest`（如 `preview:file.x`）—— 那个用 lookupChip 查 */
function contentFor(contentKey) {
  const none = { text: '', title: '', kind: 'none', truncated: false };
  if (!ensure()) return none;
  const ck = String(contentKey || '');
  if (!ck) return none;

  const m = ck.match(/^([a-z][a-z0-9_]*):([\s\S]*)$/);
  if (!m) return none;
  const ns = m[1], rest = m[2];
  const IDX = { page: byPage, file: byFile, mail: byMail, signal: byThread };
  let hit = null, kind = 'none';

  const fam = FAMILY[ns];
  if (fam) { hit = IDX[fam].get(rest); kind = KIND_OF[fam]; }
  else {
    // ★ 未知前缀（nori: / app: / device: 或畸形）→ 全索引兜底；全落空则确认为"无正文"
    for (const f of ['file', 'page', 'mail', 'signal']) {
      const h = IDX[f].get(rest);
      if (h && h.text) { hit = h; kind = KIND_OF[f]; break; }
    }
  }

  if (!hit || !hit.text) return { text: '', title: (hit && hit.title) || '', kind: 'none', truncated: false };

  const tr = hit.text.length > CAP;
  return {
    text: tr ? hit.text.slice(0, CAP) : hit.text,
    title: hit.title,
    kind,                     // 'html' | 'file' | 'mail' | 'signal'
    truncated: tr,
  };
}

/** chip.json 查表（键 = appId:contentKey去自身前缀，见 126 §6.3） */
function lookupChip(key) {
  if (!ensure()) return null;
  return (CHIP && CHIP[String(key)]) || null;
}

/** URL 或 pageId → pageId（供 chipKeys 生成"id 形式"的备用键） */
function pageIdFor(x) {
  if (!ensure()) return '';
  const s = String(x || '');
  if (!s) return '';
  if (urlToId.has(s)) return urlToId.get(s);
  const e = byPage.get(s);
  return (e && e.pageId) || '';
}

/** 运行时 rec(appId, contentKey) → chip.json 的**候选键数组**（索引 0 是主键）
 *
 * 【为什么需要两个候选键】真实 contentKey 是客户端原值：
 *   · 浏览器 = `page:<完整URL>`（★ 实测，不是 pageId）
 *   · 文件/邮件/会话 = `file:` / `mail:` / `signal:` + id
 * chip.json 的键规则是 `appId:contentKey去自身前缀` ⇒ 浏览器会得到
 *   `browser:https://meridianpost.com/…`（很长，但**零转换、绝对准确**）。
 * 人工写表时用短的 id 形式更舒服（`browser:browser.meridian_post…`），
 * 所以这里**两种都给**，查表时按顺序尝试（见 nori_proxy 的 routeChip）。
 *
 * ⚠ 一个对象**只写一条**（别两种形式都写）—— 否则同一对象两套内容，语义会冲突。 */
function chipKeys(appId, contentKey) {
  const app = String(appId || '');
  const ck = String(contentKey || '');
  const out = [];
  const push = (k) => { if (k && out.indexOf(k) < 0) out.push(k); };
  const m = ck.match(/^([a-z][a-z0-9_]*):([\s\S]*)$/);
  if (!m) { push(app ? app + ':' + ck : ck); return out; }
  const ns = m[1], rest = m[2];
  push(app ? app + ':' + rest : ck);           // ① 主键 = appId + 去自身前缀（运行时真值）
  if (ns === 'page') {
    const pid = pageIdFor(rest);               // ② 备用 = appId + pageId（人工写短键用）
    if (pid && pid !== rest) push(app ? app + ':' + pid : pid);
  }
  return out;
}

/** 自测用：覆盖率与体量统计（传 _chip_index.json 的 items；不传则报错信息） */
function stats(items) {
  if (!ensure()) return { error: lastErr };
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { total: 0, note: 'items 为空或未传（需要 _chip_index.json 的 items 数组）' };
  const out = { total: list.length, has: 0, none: 0, truncated: 0, byKind: {}, samples: [] };
  for (const it of list) {
    const r = contentFor(it.contentKey);
    if (r.text) {
      out.has++;
      out.byKind[r.kind] = (out.byKind[r.kind] || 0) + 1;
      if (r.truncated) out.truncated++;
    } else { out.none++; }
  }
  return out;
}

function reload() { built = false; byPage = byFile = byMail = byThread = urlToId = null; CHIP = null; return ensure(); }
function info() {
  return {
    built, lastErr,
    pack: PACK_PATH, chip: CHIP_PATH, cap: CAP,
    sizes: built ? { pages: urlToId.size, files: byFile.size, mails: byMail.size, threads: byThread.size, chip: Object.keys(CHIP || {}).length } : null,
  };
}

module.exports = { contentFor, lookupChip, chipKeys, pageIdFor, stats, reload, info, stripHtml };
