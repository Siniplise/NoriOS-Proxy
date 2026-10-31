'use strict';
/*
 * nori-llm-route.js —— A1/A2：exe 的 LLM 出口（`/v1/*`）显式路由 + dry-run 采集
 * ==========================================================================
 * 为什么需要（_arch/89_hub_splicer_integration.md §8 环路 R1 ★★★）
 *
 *   原版：exe（4174）直接连人格代理 25503
 *         OPENAI_BASE_URL = http://127.0.0.1:25503/v1
 *
 *   要做拼接器，必须让 exe 的 LLM 请求**先经过我们**：
 *         OPENAI_BASE_URL = http://127.0.0.1:4173/v1
 *
 *   ⚠ 但 nori_proxy.js 的兜底转发是「一切未知路径 → 4174（= exe 自己）」
 *     ⇒ 若不先拦截，`/v1/*` 会被转回 exe ⇒ **环路**（自己请求自己）
 *
 *   所以 A1 = 在兜底转发**之前**显式拦截 `/v1/*`，转到 NORI_LLM_UPSTREAM（默认 25503）。
 *   这一步**只做透明转发**，行为与 exe 直连 25503 完全一致 —— 是后续所有拼接的前提。
 *
 * 铁律
 *   1. 透明 —— 不改 body、不改 header（仅改 host）、不改状态码；stream 直接 pipe 不缓冲
 *   2. 防自环 —— 上游指向自己时**立刻拒绝**（否则无限打转）
 *   3. 可关 —— NORI_LLM_ROUTE=off（关掉后 /v1/* 回到兜底转发，即 A1 之前的状态）
 *   4. 采集默认**关** —— NORI_LLM_DUMP=on 才落 body（A2 dry-run 用）
 *
 * 环境变量
 *   NORI_LLM_ROUTE    on|off        默认 on
 *   NORI_LLM_UPSTREAM <url>         默认 http://127.0.0.1:25503
 *   NORI_LLM_DUMP     on|off        默认 off（A2 才开）
 *   NORI_LLM_DUMP_MAX <bytes>       单次落盘上限，默认 200KB
 *   NORI_LLM_LOG      <path>        默认 <此目录>/llm_route.log
 *   NORI_LLM_LOG_MAX  <bytes>       默认 8MB，超限轮转 .1
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
// ★ C5（2026-10-02）：在转发前 append 一条 system 消息，把游戏生命周期告诉她。
//   为什么是 append 而不是"发一次"：A2 实测 exe 的 messages 是**固定 14 条滚动窗口**
//   ⇒ 我们写进去的东西只活一轮 ⇒ **状态必须每轮都带**。
//   ⚠ 只 append，**绝不改 messages[0] / 最后一条 user**（§89 D5）。
const LIFE = require('./nori-lifecycle');
// ★ D1（2026-10-02）：拼接器（render / PENDING / fold 三件套，独立模块）
//   组装顺序：生命周期 + 对局记录（见 nori-splicer/index.js）。
//   开关 NORI_SPLICE=off ⇒ buildStateText() 恒 null ⇒ 退回纯透明转发。
const SPLICE = require('./nori-splicer');
// ★ D2（2026-10-02）：随请求附带结构化元数据 nori_meta（人格据此分流；NORI_META=off 可关）
const META_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_META || 'on'));

const ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_LLM_ROUTE || 'on'));
const UPSTREAM = process.env.NORI_LLM_UPSTREAM || 'http://127.0.0.1:25503';   // ★ 仅用于日志显示；实际以每次请求时的 env 为准
function upstreamUrl() { return process.env.NORI_LLM_UPSTREAM || 'http://127.0.0.1:25503'; }
const DUMP = /^(on|1|yes|true)$/i.test(String(process.env.NORI_LLM_DUMP || ''));
const DUMP_MAX = Number(process.env.NORI_LLM_DUMP_MAX || 200 * 1024);
const LOG_PATH = process.env.NORI_LLM_LOG || path.join(__dirname, 'llm_route.log');
const MAX_BYTES = Number(process.env.NORI_LLM_LOG_MAX || 8 * 1024 * 1024);
const META_TAP = Number(process.env.NORI_LLM_META_TAP || 256 * 1024);   // 只为提取元信息保留的前缀

/* ── 统计（供 /nori-llmstat 与摘要查看；A1 验收的量化证据）─────────────── */
const stats = {
  hits: 0, refusals: 0, errors: 0, spliced: 0, fixed: 0,
  byPath: Object.create(null),
  stream: 0, nonStream: 0, withMeta: 0,
  byModel: Object.create(null),
  lastAt: 0,
};

/* ── 日志（独立 llm_in.log，不污染 obs.log / proxy.log）────────────────── */
let fd = null;
let written = 0;
function openLog() {
  if (fd) return;
  try { fd = fs.openSync(LOG_PATH, 'a'); written = fs.fstatSync(fd).size; } catch (e) { fd = null; }
}
function w(line) {
  try {
    openLog();
    if (!fd) return;
    if (written >= MAX_BYTES) {
      try {
        fs.closeSync(fd); fd = null;
        const bak = LOG_PATH + '.1';
        try { fs.unlinkSync(bak); } catch (e) {}
        fs.renameSync(LOG_PATH, bak);
        written = 0;
      } catch (e) { fd = null; }
      openLog();
      if (!fd) return;
    }
    const s = '[' + new Date().toISOString().slice(11, 19) + '] ' + line + '\n';
    fs.writeSync(fd, s);
    written += Buffer.byteLength(s);
  } catch (e) { stats.errors++; }
}
const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/* ── 上游地址解析（每次调用时读 env，便于实验时热改）────────────────────── */
function upstream() {
  let u = null;
  try { u = new URL(upstreamUrl()); } catch (e) {}
  if (!u) return null;
  return { host: u.hostname, port: Number(u.port) || 80, base: u.pathname.replace(/\/+$/, '') };
}

/* ── 元信息提取（不解析大 body，只读前缀）────────────────────────────── */
function metaOf(raw) {
  const m = { model: '', msgs: '', stream: '', meta: 'no' };
  if (!raw) return m;
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { j = null; }
  if (j) {
    if (j.model != null) m.model = String(j.model);
    if (Array.isArray(j.messages)) {
      m.msgs = String(j.messages.length);
      const roles = j.messages.slice(0, 4).map((x) => (x && x.role) || '?').join(',');
      m.msgs += '(' + roles + (j.messages.length > 4 ? ',…' : '') + ')';
    }
    if (j.stream != null) m.stream = j.stream ? '1' : '0';
    if (j.nori_meta) m.meta = 'yes';
    return m;
  }
  /* ★ 前缀被截断 / 非法 JSON ⇒ 正则兜底（只判 stream / model / nori_meta / 消息条数） */
  const rs = /"stream"\s*:\s*(true|false)/.exec(raw);
  if (rs) m.stream = rs[1] === 'true' ? '1' : '0';
  const rm = /"model"\s*:\s*"([^"]{0,60})"/.exec(raw);
  if (rm) m.model = rm[1];
  if (/"nori_meta"/.test(raw)) m.meta = 'yes';
  const cnt = raw.match(/"role"\s*:/g);
  if (cnt) m.msgs = '~' + cnt.length;
  return m;
}

/* ── 主入口：处理一个 /v1/* 请求 ────────────────────────────────────────
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 * @param {number}               selfPort  本代理监听端口（用于防自环）
 * @param {function}             logFn     代理的 log（复用前缀/时间戳）
 * @param {object}               [hooks]   ★ 2026-10-16：`{ onChat(text, bodyObj) → {lines,emotion,why} | null }`
 *                                         —— **对话拦截**（命中就返回固定回应，不转发上游）。
 *                                         判据由调用方给（它能看到完整请求体，从而排除"游戏回合"）。
 */
function handle(req, res, selfPort, logFn, hooks) {
  const log = typeof logFn === 'function' ? logFn : function () {};
  const up = upstream();
  if (!up) {
    log('LLMROUTE ★NORI_LLM_UPSTREAM 非法：' + UPSTREAM);
    try { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"bad NORI_LLM_UPSTREAM"}'); } catch (e) {}
    return;
  }
  /* ★ 防自环：上游 == 自己 ⇒ 拒绝（否则请求会无限打转，R1） */
  if ((up.host === '127.0.0.1' || up.host === 'localhost' || up.host === '::1') && up.port === Number(selfPort)) {
    stats.refusals++;
    log('LLMROUTE ★★拒绝：上游指向自己（' + up.host + ':' + up.port + '）—— 会形成环路');
    w('★REFUSE self-loop ' + req.method + ' ' + req.url);
    try { res.writeHead(508, { 'content-type': 'application/json' }); res.end('{"error":"self-loop refused"}'); } catch (e) {}
    return;
  }

  const p = String(req.url || '').split('?')[0];
  const fullPath = up.base + (req.url || '/');
  stats.hits++; stats.lastAt = Date.now();
  stats.byPath[p] = (stats.byPath[p] || 0) + 1;

  /* ★ C5/D1：chat/completions 且有内容 ⇒ 走「拼接」路径（缓冲后 append 再发）。
   * 其余一切情况（含 /v1/models、无状态的 chat）**保持原来的透明 pipe**，风险面最小。
   * ★ D1：内容不再只是生命周期，而是「生命周期 + 对局记录」（由 nori-splicer 组装）。 */
  const isChat = (p === '/v1/chat/completions' || p === '/chat/completions');
  let stateText = null;
  if (isChat) { try { stateText = SPLICE.buildStateText(); } catch (e) { stateText = null; } }
  /* ★ 2026-10-16：**chat 请求一律缓冲**（对话拦截要读 messages）——
   *   原先只在 `stateText` 非空时缓冲，而"摸尾巴"发生在**平时聊天**（无游戏状态 ⇒ stateText 为 null）
   *   ⇒ 那条路会被**整个漏掉**。缓冲的只是**请求体**（~25KB），**响应仍是 `r.pipe(res)` 流式** ⇒ 无行为差异。
   *   （`stateText` 为 null 时：只缓冲、**不 append** system。） */
  if (isChat && req.method === 'POST' && (stateText || (hooks && typeof hooks.onChat === 'function'))) {
    return spliceAndSend(req, res, up, fullPath, p, stateText, log, hooks);
  }

  /* 请求前缀（提取元信息用；不阻断 pipe） */
  const tap = [];
  let tapN = 0;
  let prefix = '';
  req.on('data', (d) => {
    if (tapN < (DUMP ? DUMP_MAX : META_TAP)) {
      tap.push(d); tapN += d.length;
      if (!prefix) { try { prefix = Buffer.concat(tap).toString('utf8'); } catch (e) {} }
    }
  });

  /* 请求体收完 ⇒ 记一行（含元信息）；DUMP 开则落原文 */
  req.on('end', () => {
    const raw = prefix || (DUMP ? Buffer.concat(tap).toString('utf8') : '');
    const m = metaOf(raw);
    log('LLMROUTE -> ' + req.method + ' ' + fullPath + ' model=' + (m.model || '-')
      + ' msgs=' + (m.msgs || '-') + ' stream=' + (m.stream || '-')
      + ' nori_meta=' + m.meta + ' body=' + tapN + 'B');
    if (DUMP) {
      w('── REQ ' + req.method + ' ' + fullPath + ' model=' + (m.model || '-')
        + ' msgs=' + (m.msgs || '-') + ' stream=' + (m.stream || '-'));
      w(raw);
    }
  });

  const headers = Object.assign({}, req.headers, { host: up.host + ':' + up.port });
  const t0 = Date.now();
  const rq = http.request({ host: up.host, port: up.port, path: fullPath, method: req.method, headers: headers }, (r) => {
    let bytes = 0;
    const outTap = [];
    let outN = 0;
    const code = r.statusCode || 502;
    /* ★ 透明回传：状态码 + 原 header 原样，body 直接 pipe（SSE 不缓冲） */
    try {
      res.writeHead(code, r.headers);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
    } catch (e) {}
    r.on('data', (d) => {
      bytes += d.length;
      if (DUMP && outN < DUMP_MAX) { outN += d.length; outTap.push(d); }
    });
    r.on('end', () => {
      const m = metaOf(prefix);
      if (m.model) stats.byModel[m.model] = (stats.byModel[m.model] || 0) + 1;
      if (m.stream === '1') stats.stream++; else stats.nonStream++;
      if (m.meta === 'yes') stats.withMeta++;
      log('LLMROUTE <- ' + code + ' ' + bytes + 'B ' + (Date.now() - t0) + 'ms ' + p);
      if (DUMP) {
        w('── RESP ' + code + ' ' + bytes + 'B ' + p);
        w(Buffer.concat(outTap).toString('utf8'));
      }
    });
    r.pipe(res);
  });
  rq.on('error', (e) => {
    stats.errors++;
    log('LLMROUTE ★上游错误 ' + e.message + ' (' + up.host + ':' + up.port + ')');
    w('★ERROR ' + e.message + ' ' + req.method + ' ' + fullPath);
    try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream ' + e.message })); } catch (e2) {}
  });
  try { rq.setTimeout(0); } catch (e) {}                 // ★ 人格可能想很久，不设 idle 超时
  req.on('aborted', () => { try { rq.destroy(); } catch (e) {} });
  req.pipe(rq);                                          // ★ 请求体转发（不可提前 end）
}

/* ── C5：拼接路径（缓冲 → append 一条 system → 转发）──────────────────
 * 铁律：
 *   · **只 append**，绝不改 messages[0] / 最后一条 user（§89 D5）
 *   · 解析失败 ⇒ **原样发送**（绝不吞掉请求）
 *   · 重算 content-length；删掉 transfer-encoding（否则冲突）
 */
function spliceAndSend(req, res, up, fullPath, p, stateText, log, hooks) {
  const chunks = [];
  let n = 0;
  req.on('data', (d) => { chunks.push(d); n += d.length; });
  req.on('end', () => {
    const orig = Buffer.concat(chunks).toString('utf8');
    let body = orig;
    let spliced = false;
    let buffered = false;   // ★ 2026-10-16：走了"缓冲"路径（≠ 是否 append 了 system）
    let metaSent = null;                       // ★ D2：本次真正发出的元数据（用于日志）
    try {
      const j = JSON.parse(orig);
      if (j && Array.isArray(j.messages) && j.messages.length) {
        /* ★★ 2026-10-16：**对话拦截** —— 命中就用固定回应直接答，**不转发上游**。
         *   为什么必须"不转发"：像"摸尾巴"这种，玩家的那句话本身也会走 LLM
         *   ⇒ 会变成"她自由发挥一句 + 固定台词又一句"的重复。
         *   判据完全交给调用方（`hooks.onChat`）：只有它能看到完整请求体，
         *   从而排除"游戏回合"（那些请求 `response_format.type === 'json_object'`，
         *   返回固定台词会让游戏解析失败）。 */
        if (hooks && typeof hooks.onChat === 'function') {
          try {
            const lastUser = [...j.messages].reverse().find((m) => m && m.role === 'user');
            const txt = (lastUser && typeof lastUser.content === 'string') ? lastUser.content : '';
            if (txt) {
              const hit = hooks.onChat(txt, j);
              if (hit && Array.isArray(hit.lines) && hit.lines.length) {
                return sendFixed(res, hit, p, log);
              }
            }
          } catch (e) {
            log('LLMROUTE ★拦截钩子异常：' + e.message + '（按未命中处理，继续转发）');
          }
        }
        /* ★ 2026-10-16：`stateText` 可能为 **null**（平时聊天、无游戏状态）——
         *   那时只**缓冲不 append**：拦截需要看 messages，
         *   但绝不能塞一条 `content: null` 上去（上游会 400）。 */
        if (stateText) {
          j.messages.push({ role: 'system', content: stateText });   // ★ 唯一的改动：末尾追加
          spliced = true;
        }
        /* ★★ D2（2026-10-02）：附带**结构化元数据**，让"这段文本是什么"不再靠前缀猜。
         *   人格侧双读：优先 nori_meta，读不到才回退到文本前缀（向后兼容）。
         *   ⚠ 这个字段**不会到达上游大模型** —— 人格的 buildPrompt() 完全重建 messages
         *     （只取最后一条 user 文本），所以 nori_meta 是"本地私有信道"。 */
        if (META_ON) { try { metaSent = SPLICE.meta(); j.nori_meta = metaSent; } catch (e) {} }
        body = JSON.stringify(j);
        buffered = true;
        if (spliced) stats.spliced++;
      }
    } catch (e) { /* 解析失败 ⇒ 原样发 */ }

    const headers = Object.assign({}, req.headers, { host: up.host + ':' + up.port });
    delete headers['transfer-encoding'];
    headers['content-length'] = Buffer.byteLength(body);

    const t0 = Date.now();
    const rq = http.request({ host: up.host, port: up.port, path: fullPath, method: req.method, headers }, (r) => {
      let bytes = 0;
      const code = r.statusCode || 502;
      try { res.writeHead(code, r.headers); } catch (e) {}
      r.on('data', (d) => { bytes += d.length; });
      r.on('end', () => {
        log('LLMROUTE <- ' + code + ' ' + bytes + 'B ' + (Date.now() - t0) + 'ms ' + p + (spliced ? ' [spliced]' : ''));
      });
      r.pipe(res);
    });
    rq.on('error', (e) => {
      stats.errors++;
      log('LLMROUTE ★上游错误 ' + e.message + ' (' + up.host + ':' + up.port + ')');
      try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream ' + e.message })); } catch (e2) {}
    });
    try { rq.setTimeout(0); } catch (e) {}
    rq.end(body);

    if (spliced) {
      log('LLMROUTE ✚SPLICE append system ' + stateText.length + ' chars (body ' + n + '→' + Buffer.byteLength(body) + 'B)'
        + (metaSent ? ' meta seq=' + metaSent.seq + ' delta=' + metaSent.delta + ' kinds=' + (metaSent.kinds || []).join(',') : ''));
      w('── SPLICE append 1 system (' + stateText.length + ' chars)\n' + stateText);
    } else if (buffered) {
      /* ★ 2026-10-16：缓冲但没 append —— 平时聊天（`stateText` 为 null）走这条，
       *   纯粹是为了让**对话拦截**能读到 messages。 */
      log('LLMROUTE ⟲BUFFERED（无状态可 append；仅用于对话拦截检测）body=' + n + 'B');
      w('── BUFFERED (no state appended)');
    } else {
      w('── SPLICE skipped (body parse failed or no messages)');
    }
  });
}

/* ── ★★ 2026-10-16：拦截命中 ⇒ **固定回应**（不转发上游）──────────────────
 *   格式**照抄人格侧**（`n_llm.js` 的正常返回）：非流式 OpenAI JSON。
 *   实测依据：exe 的 chat 请求 `stream=0` 占 **644 / 675**；而 `n_llm.js` 本身
 *   无论 `stream` 都返回非流式 ⇒ 跟着它走，行为一致、风险最低。
 *   ★ `[emotion:xxx]` 标签**要带上**（与人格侧一致，前端负责剥）。
 */
function sendFixed(res, hit, p, log) {
  const content = (hit.emotion ? '[emotion:' + hit.emotion + ']\n' : '') + hit.lines.join('\n');
  const body = JSON.stringify({
    id: 'chatcmpl-nori-fixed', object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: 'nori-fixed',
    choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }],
    usage: {},
  });
  try {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  } catch (e) {}
  stats.fixed++;
  log('LLMROUTE ★★固定回应 ' + p + ' lines=' + hit.lines.length + ' why=' + (hit.why || '-'));
  w('── FIXED REPLY (' + (hit.why || '-') + ')\n' + content);
}

/* ── 摘要（供代理周期性打印；A1 验收用）────────────────────────────────── */
function summaryText() {
  const byPath = Object.entries(stats.byPath).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(' ');
  const byModel = Object.entries(stats.byModel).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(' ');
  return 'LLMROUTE sum hits=' + stats.hits
    + ' stream=' + stats.stream + ' nonstream=' + stats.nonStream
    + ' meta=' + stats.withMeta + ' spliced=' + stats.spliced
    + ' refuse=' + stats.refusals + ' err=' + stats.errors
    + (byPath ? ' | path: ' + byPath : '')
    + (byModel ? ' | model: ' + byModel : '');
}
function getStats() { return JSON.parse(JSON.stringify(stats)); }

module.exports = { handle, ON, DUMP, UPSTREAM, upstreamUrl, LOG_PATH, summaryText, getStats };
