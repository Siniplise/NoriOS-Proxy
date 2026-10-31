'use strict';
/* ══════════════════════════════════════════════════════════════════════════
 * nori_script.js —— 剧情「固定台词」播放器（代理侧）
 * ══════════════════════════════════════════════════════════════════════════
 * 计划：_arch/107_script_lines_plan.md
 *
 * 职责（三件事，顺序不能错）：
 *   ① 切 act（提示词版本）      POST /act                ← 她"此刻记得什么"要先对齐
 *   ② 注入记忆（逐句）          POST /nori-scriptline    ← 先注入 ⇒ 上屏那刻她已"说过"
 *   ③ 说出口（逐句）            io.pushGameLine()        ← 走语音编排，不调 LLM
 *
 * ★ 为什么顺序是 ①②③：见 107 §四。反了会让人设/记忆错位。
 *
 * ★★ 2026-10-07（记忆增量 · 计划 `_arch/131_记忆增量落地.md`）：
 *   beat 现在有两种内容，可**单独**存在，也可同时存在：
 *     · `lines[]`          —— 逐句上屏的台词（零 LLM）
 *     · `memory` / `memoryImportance` —— 写进她长期记忆的一句话 + 该记忆卡权重
 *   ⇒ **只有 `memory`、没有 `lines` 的 beat 是合法的**（= 只记不说，如 `arg.seal_released`）。
 *   ⚠ 判空必须用 `beatHasContent()`，**不能**只看 `lines.length` —— 否则纯记忆 beat
 *     会被当成"没填词"而 SKIP（`done[b.id] = -1`，且**永久不再触发**）。
 *   `memory` 原样透传给 `/nori-scriptline`；由人格侧的 `workingBlock()` 渲染成
 *   「【经历】…」（**不是**「Nori：…」—— 记忆不是她说出口的话）。
 *
 * ★ 幂等设计（与 107 的方案①不同，这里说明为什么改）：
 *   107 建议"用 pack facts 当凭证"，但**我们自定义的 fact 不会被服务端持久化**
 *   （FACTS 只是内存集 + 服务端回灌）⇒ 重启即丢 ⇒ 会重放。
 *   ⇒ 改用**独立状态文件** `nori_script_state.json`：
 *       · 零依赖、可审计、体积小（几个 id）
 *       · 重启不重放 ✓
 *       · 清档重玩时删掉它即可重放 ✓
 *   ⇒ 另加 **armedAt**：只认"本次启动之后新到的 fact"
 *      （防止首次部署时把历史 beat 一次性全补放出来）
 *
 * ★ 文件写入（2026-10-04 用户铁律 · 与 API KEY 同级）：
 *   本模块**不直接 `fs.write*`** —— 状态写盘一律走 `_safeio.safeRewrite`
 *   （先读旧 → 内存里算新 → 写 `.tmp` + rename 原子替换 + 写前自动备份）。
 *   理由见 `_arch/tools/_safeio.js` 头部：`open(p,'w')` 会**当场截断**，
 *   若右侧表达式**又去读同一文件** ⇒ **静默丢内容**（本项目已真实发生两次）。
 * ══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const http = require('http');
/* ★ 统一的安全写入通道（与 `_arch/tools/_safeio.py` 是同一件事的 Node 实现）。
 *   ⚠ **硬依赖**：找不到就让它抛 —— 宁可"剧情台词功能不启动"（代理会 catch 并告警），
 *     也**不**退回直接 fs.write 的危险写法（铁律：缺能力要显式报错，不许静默降级）。 */
const _safeio = require('./_arch/tools/_safeio.js');

const DEFAULTS = {
  linesPath: path.join(__dirname, 'nori_script_lines.json'),
  statePath: path.join(__dirname, 'nori_script_state.json'),
  personaUrl: process.env.NORI_PERSONA_URL || 'http://127.0.0.1:25503',
  tickMs: 1000,
  /* ★ 2026-10-18：「新一局」的判据 —— 这个 fact 再次到达 ⇒ 重置剧情 beat（台词每局都说）。
   *   `NORI_RUN_RESET=off` 可整体关掉（回到"一次性 beat 永久只响一次"的老行为）。 */
  runStartFact: /^(off|0|no|false)$/i.test(String(process.env.NORI_RUN_RESET || '')) ? '' : 'boot.completed',
  runResetCooldownMs: Math.max(0, Number(process.env.NORI_RUN_RESET_CD_MS || 300000)),
};

function createScriptPlayer(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const log = o.log || (() => {});
  const hasFact = o.hasFact || (() => false);
  const factAt = o.factAt || (() => 0);
  const pushGameLine = o.pushGameLine || (() => {});

  let beats = [];
  let done = {};          // id -> ts（-1 = 因 lines 与 memory 都为空而跳过）
  let armedAt = 0;
  let timer = null;
  const pending = new Map();   // id -> { beat, fact, at }
  const fired = new Set();     // 本次进程内已发起的（防重入）

  /* ★ 2026-10-07：beat 的"有内容"判据 —— 台词 **或** 记忆，任一即可（纯记忆 beat 合法）。
   *   全模块**唯一**判空入口（hook / fire / arm / status 都用它）：
   *   漏改任何一处 ⇒ 纯记忆 beat 被 SKIP 并写 `done=-1` ⇒ **永久不再触发**。 */
  function beatHasContent(b) {
    if (!b) return false;
    if (Array.isArray(b.lines) && b.lines.some((s) => typeof s === 'string' && s.trim())) return true;
    return typeof b.memory === 'string' && !!b.memory.trim();
  }

  /* ── 读写文件（全部经 _safeio；本模块不直接碰 fs）──────────────────── */
  function loadLines() {
    try {
      const raw = JSON.parse(_safeio.readText(o.linesPath, { default: '' }));
      const arr = Array.isArray(raw) ? raw : (raw && raw.beats);
      beats = (Array.isArray(arr) ? arr : []).filter((b) => b && b.id && Array.isArray(b.when));
      log('SCRIPT 台词表已载入 ' + beats.length + ' 个 beat');
      return beats.length;
    } catch (e) {
      beats = [];
      log('SCRIPT 台词表读取失败：' + e.message);
      return 0;
    }
  }
  function loadState() {
    const raw = _safeio.readText(o.statePath, { default: '' });
    try { done = JSON.parse(raw) || {}; } catch (e) { done = {}; }
    if (typeof done !== 'object' || !done || Array.isArray(done)) done = {};
  }
  /* ★ 状态写盘：走 `_safeio.safeRewrite`（用户铁律）
   *   · transform **不读任何文件** —— 内容全部来自内存 `done`
   *     ⇒ 与"先读后写"在结构上就分开了，不可能自读自写
   *   · transform 里自校验：写坏了下次启动 state 就全丢（JSON.parse 兜一道）
   *   · backup:true ⇒ `<path>.bak`（`*.bak` 已在 .gitignore 里，不入库） */
  function saveState() {
    try {
      _safeio.safeRewrite(o.statePath, () => {
        const text = JSON.stringify(done, null, 2) + '\n';
        JSON.parse(text);                     // 自校验：写出去的东西必须读得回来
        return text;
      }, { backup: true, label: 'nori_script_state.json' });
    } catch (e) { log('SCRIPT 状态写盘失败：' + e.message); }
  }

  /* ── HTTP：POST 给人格侧（只记不答，不调 LLM） ─────────────────────── */
  function postPersona(p, bodyObj, cb) {
    let u;
    try { u = new URL(o.personaUrl); } catch (e) { cb && cb(e); return; }
    const body = JSON.stringify(bodyObj || {});
    let req;
    try {
      req = http.request({
        host: u.hostname, port: Number(u.port) || 80, path: p, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (rr) => {
        let buf = '';
        rr.on('data', (c) => { buf += c; if (buf.length > 4e4) rr.destroy(); });
        rr.on('end', () => {
          const code = rr.statusCode || 0;
          if (code >= 400) log('SCRIPT ' + p + ' 被拒 http ' + code);
          cb && cb(null, code, buf);
        });
      });
      req.on('error', (e) => { log('SCRIPT ' + p + ' 失败 ' + e.message); cb && cb(e); });
      req.setTimeout(5000, () => { try { req.destroy(); } catch (e) {} });
      req.end(body);
    } catch (e) { log('SCRIPT ' + p + ' 异常 ' + e.message); cb && cb(e); }
  }

  /* ── 命中判定：新到的 fact 是否触发某个 beat ───────────────────────── */
  /* ★★ 2026-10-18：**新一局 ⇒ 重置剧情 beat**
   *   问题（用户实测）：重玩到 `virus.cleared` 时 `s4_after_d2` 不响 —— 因为它是
   *     "一次性 beat"，`done` 里还留着 10-07 那次的时间戳 ⇒ `hook()` 直接跳过。
   *   ⇒ 每次 `boot.completed`（开机）视为新的一局：清掉**非 repeatable** 的 `done`
   *     与进程内 `fired`，让剧情台词每局都能说一遍。
   *   ★★ **记忆仍然只写第一次**：`resetStory()` 会给"已放过的旧 beat"补一个
   *     `@mem:` 标记（= 当年那次已经写过卡），`resolvePayload()` 据此把重玩标成
   *     `transient` ⇒ 只上屏、不再建记忆卡。
   *   ★ 冷却：避免一次页内重连把剧情连放几遍（默认 5 分钟，`NORI_RUN_RESET` 可关）。 */
  let lastResetAt = 0;
  function resetStory(force) {
    const now = Date.now();
    const cd = Math.max(0, Number(o.runResetCooldownMs) || 0);
    if (!force && now - lastResetAt < cd) return 0;
    let n = 0;
    for (const b of beats) {
      if (b.repeatable) continue;
      const was = done[b.id];
      if (was === undefined) continue;
      if (was === -1) continue;                       // 因"没填词"跳过的：保持跳过
      if (done['@mem:' + b.id] === undefined) done['@mem:' + b.id] = was;   // 老记录 ⇒ 视为已写过
      delete done[b.id];
      fired.delete(b.id);
      n++;
    }
    lastResetAt = now;
    if (n) { saveState(); log('SCRIPT 新一局：重置 ' + n + ' 条剧情 beat（记忆仍只写第一次）'); }
    return n;
  }

  function hook(factId) {
    if (!factId || !armedAt) return;
    if ((factAt(factId) || 0) < armedAt) return;   // 启动前的历史 fact 不补放
    /* ★ 2026-10-18：开机 = 新的一局 ⇒ 先重置剧情 beat，再走命中判定
     *   （顺序很重要：先重置，同一次 boot.completed 才能把 s1_desktop 放出来） */
    if (o.runStartFact && factId === o.runStartFact) resetStory(false);
    for (const b of beats) {
      /* ★ 2026-10-07（摸头/摸尾巴）：`repeatable` 的 beat **不走"一次性"闸门** ——
       *   手势类交互可反复触发（谁会只摸一次头？），而 `done`/`fired` 都会让它只响一次。
       *   ⚠ 仍保留 `beatHasContent()` 的 SKIP 判空（但 repeatable 不写 `done=-1`）。 */
      if (!b.repeatable) {
        if (fired.has(b.id)) continue;
        if (done[b.id] !== undefined && done[b.id] !== -1) continue;  // 已放过
      }
      if (!b.when || b.when.indexOf(factId) < 0) continue;
      if (!beatHasContent(b)) {
        log('SCRIPT SKIP ' + b.id + '（' + (b.label || '') + '）lines 与 memory 都为空，等填词');
        if (!b.repeatable) { done[b.id] = -1; saveState(); }
        continue;
      }
      pending.set(b.id, { beat: b, fact: factId, at: Date.now() });
      log('SCRIPT 命中 ' + b.id + '（' + (b.label || '') + '）← ' + factId);
    }
  }

  /* ── ★★ 2026-10-16：**一次触发该说什么 / 要不要写记忆**（唯一判定入口）────────
   *   两个调用方**必须共用**这一份 —— 否则"首次写记忆 / 轮换 / transient"会在两处各写一遍、
   *   迟早不一致（本项目已多次踩"同语义多出口"）：
   *     · `fire(entry)`      —— fact 触发（beat 播放器自己上屏）
   *     · `sayInstead(id)`   —— **对话触发**（上屏由调用方负责，如 LLM 响应通道）
   *
   *   三条语义：
   *     ① `pick: n` ⇒ 每次取 n 条、**按触发次数轮换起点**（V4.4：摸头回应「可轮换，不要每次都一样」）
   *     ② **记忆只写第一次**（否则重复动作会无限写卡 —— 同 `121 B4` 的纪律）
   *     ③ `transient` = **非首次** ⇒ 下游**完全不写记忆**（人格侧不再用台词兜底建卡）
   *   ★ 计数/标记用保留前缀键 `@turn:` / `@mem:` / `@once:`，**不破坏 state 的扁平结构**；
   *     `@mem` 要兼容旧 state，否则升级代码后重启会误判"首次"、又写一张卡。
   */
  function resolvePayload(b) {
    const all = (b.lines || []).filter((s) => typeof s === 'string' && s.trim());
    const TURN_KEY = '@turn:' + b.id;
    const MEM_KEY = '@mem:' + b.id;
    const ONCE_KEY = '@once:' + b.id;
    let lines = all;
    let transient = false;
    /* ★ 2026-10-17：**预取提示** —— 可重复 beat 的轮换顺序是确定的（`off = turn % n`），
     *   所以"接下来会说哪 2 句"可以精确预计算。把它随台词一起交给下游，
     *   shim 会在后台先把音频合成好 ⇒ **第二次起零等待出声**（摸头就是这种场景）。
     *   ★ 只在 `repeatable && pick>0 && 句数 > pick` 时给（否则轮换没有意义）。 */
    let pf = [];
    if (b.repeatable) {
      /* ★ 兼容老的 state：`@mem` 存在（记忆已写过）也算"已见过" ——
       *   否则升级代码后重启，`@once` 是新增键 ⇒ 会被误判成"首次"⇒ 又建一张卡。 */
      if (done[ONCE_KEY] || done[MEM_KEY]) transient = true;   // 非首次
      else done[ONCE_KEY] = Date.now();                        // 首次
      const pick = Math.max(0, Number(b.pick) || 0);
      if (pick > 0 && all.length > pick) {
        const n = Math.max(0, Number(done[TURN_KEY]) || 0);
        const off = n % all.length;
        lines = [];
        for (let i = 0; i < pick; i++) lines.push(all[(off + i) % all.length]);
        /* ★ 预取提示：从**本次之后**的位置继续取 2 句（去重、去空） */
        for (let k = 0; k < 2 && all.length > pick; k++) {
          const t2 = all[(off + pick + k) % all.length];
          if (t2 && pf.indexOf(t2) < 0 && lines.indexOf(t2) < 0) pf.push(t2);
        }
        done[TURN_KEY] = n + 1;
      }
    } else if (done[MEM_KEY]) {
      /* ★ 2026-10-18：**剧情 beat 重玩** —— `@mem` 存在说明当年那局已写过卡
       *   ⇒ 标 transient（只上屏、不建卡），配合 `resetStory()` 的"台词每局都说"。 */
      transient = true;
    }
    /* ★ 2026-10-07：记忆增量 —— 没有台词、只有 memory 也照常触发（只记不说）。
     * ★ 2026-10-18：去重判据从"仅 repeatable"放宽到**全部 beat** —— 剧情 beat 重玩时
     *   台词照说，但记忆卡**永远只写第一次**（否则每局都多一张卡）。 */
    let memory = (typeof b.memory === 'string' && b.memory.trim()) ? b.memory.trim() : '';
    if (memory) {
      if (done[MEM_KEY]) memory = '';            // 已写过 ⇒ 不重复写卡
      else done[MEM_KEY] = Date.now();           // 乐观标记（写卡失败也好过反复写）
    }
    return { lines: lines, memory: memory, transient: transient, turn: Number(done[TURN_KEY]) || 0, pf: pf };
  }

  /* ── ★★ 2026-10-16：**对话触发的固定台词**（不上屏，由调用方上屏）────────────
   *   用途：玩家在聊天里说"摸尾巴"⇒ 她的回答用 V4.4 的固定 3 句，
   *   而不是让 LLM 自由发挥；同时避免"LLM 回一句 + beat 又上屏一句"的重复。
   *   ⚠ **上屏不在这里做** —— 这里只做两件事：① 写记忆/working（走 `/nori-scriptline`）
   *     ② 把"这次该说哪几句"返回给调用方。
   *   ⚠ 发 `transient`（非首次）⇒ 人格侧**不写记忆、不进 working**。
   */
  function sayInstead(beatId) {
    const b = beats.find((x) => x.id === beatId);
    if (!b || !beatHasContent(b)) return null;
    const { lines, memory, transient } = resolvePayload(b);
    if (!lines.length) return null;
    saveState();
    const act = Number(b.act) || 0;
    postPersona('/nori-scriptline', {
      beat: b.id, act: act, emotion: b.emotion || 'neutral', lines: lines,
      memory: memory, importance: b.memoryImportance, transient: transient,
    }, () => {});
    log('SCRIPT 对话触发 ' + b.id + ' lines=' + lines.length + ' mem=' + (memory ? memory.length : 0)
      + (transient ? ' TRANSIENT(不写记忆)' : ' FIRST(写记忆)') + ' [上屏交给调用方]');
    return { lines: lines, emotion: b.emotion || 'neutral', transient: transient };
  }

  /* ── 触发：逐句 上屏（不调 LLM） ───────────────────────────────────── */
  function fire(entry) {
    const b = entry.beat;
    /* ★ 2026-10-16：判定收敛到 `resolvePayload()`（与 `sayInstead` 共用） */
    const { lines, memory, transient, turn, pf } = resolvePayload(b);

    if (!lines.length && !memory) return;
    if (!b.repeatable) {
      fired.add(b.id);
      done[b.id] = Date.now();
    }
    saveState();                                 // 轮换计数 / 记忆标记 / done 一并落盘

    const act = Number(b.act) || 0;
    const gap = Math.max(0, Number(b.lineGapMs) || 0);

    log('SCRIPT beat=' + b.id + ' act=' + act + ' lines=' + lines.length
      + ' mem=' + (memory ? memory.length : 0) + ' ← ' + entry.fact
      + (b.repeatable ? ' [repeatable turn=' + turn
        + (transient ? ' TRANSIENT(只上屏)' : ' FIRST(写记忆)') + ']' : ''));

    /* ③ 说出口：逐句，间隔 lineGapMs（0 = 交给语音队列串行） */
    const say = () => {
      lines.forEach((text, i) => {
        const emit = () => {
          try {
            /* ★ 2026-10-17：`pf`（下一轮会说的 2 句）挂在**最后一句**上 ——
             *   太早带会让预取与本 beat 的合成抢 TTS 并发；放在最后一句，等本 beat
             *   全部上屏后 shim 才开始后台预取，正好赶上玩家下一次摸头。 */
            const o = { text: text, emotion: b.emotion || 'neutral', game: null, from: 'script', ui: false };
            if (i === lines.length - 1 && pf && pf.length) o.pf = pf;
            pushGameLine(o);
            log('SCRIPT 上屏 ' + b.id + ' ' + (i + 1) + '/' + lines.length
              + (o.pf ? ' [pf ' + o.pf.length + ']' : ''));
          } catch (e) { log('SCRIPT 上屏失败 ' + e.message); }
        };
        if (gap > 0 && i > 0) { const t = setTimeout(emit, gap * i); if (t.unref) t.unref(); }
        else emit();
      });
    };

    /* ② 注入记忆（先于上屏）—— ★ 带 `memory` / `importance`：人格侧据此写「长期记忆卡」
     *    （纯记忆 beat 走这条时 `lines` 为空 ⇒ 那里只写记忆、不上屏）
     *    ★ `transient` = 可重复 beat 的后续触发 ⇒ 人格侧**只上屏、不写任何记忆** */
    const inject = () => {
      postPersona('/nori-scriptline', {
        beat: b.id, act: act, emotion: b.emotion || 'neutral', lines: lines,
        memory: memory, importance: b.memoryImportance, transient: transient,
      }, () => say());
    };

    /* ① 切 act（最先） */
    if (act > 0) postPersona('/act', { act: act }, () => inject());
    else inject();
  }

  /* ── 定时：等 sentinel / 等延时 ────────────────────────────────────── */
  function tick() {
    if (!pending.size) return;
    const now = Date.now();
    for (const [id, e] of Array.from(pending.entries())) {
      const after = e.beat.after || {};
      const sent = after.sentinel;
      if (sent) {
        if (hasFact(sent)) { pending.delete(id); fire(e); }
        continue;
      }
      const wait = Math.max(0, Number(after.delayMs) || 0);
      const base = factAt(e.fact) || e.at;
      if (now - base >= wait) { pending.delete(id); fire(e); }
    }
  }

  /* ── 生命周期 ─────────────────────────────────────────────────────── */
  function arm() {
    loadLines();
    loadState();
    /* 填词后复活：曾因"lines 与 memory 都为空"跳过的，若现在有内容了就清掉跳过标记 */
    for (const b of beats) {
      if (done[b.id] === -1 && beatHasContent(b)) {
        log('SCRIPT 复活 ' + b.id + '（已填词 ' + ((b.lines || []).length) + ' 句'
          + (b.memory ? ' + 记忆' : '') + '）');
        delete done[b.id];
      }
    }
    armedAt = Date.now();
    saveState();
    if (!timer) { timer = setInterval(() => { try { tick(); } catch (e) {} }, o.tickMs); if (timer.unref) timer.unref(); }
    log('SCRIPT 已就绪 beats=' + beats.length + ' 待填词=' + beats.filter((b) => !beatHasContent(b)).length);
    return beats.length;
  }
  function reload() { loadLines(); return beats.length; }

  function status() {
    const isInternal = (k) => k.charCodeAt(0) === 64;   // '@' = 轮换计数 / 记忆标记（内部键）
    return {
      armedAt: armedAt, beats: beats.length,
      done: Object.keys(done).filter((k) => !isInternal(k)).length,
      pending: Array.from(pending.keys()),
      todo: beats.filter((b) => !beatHasContent(b)).map((b) => b.id),
      repeatable: beats.filter((b) => b.repeatable).map((b) => b.id),
    };
  }

  return { arm, reload, hook, tick, status, postPersona, sayInstead, resetStory, _beats: () => beats, _done: () => done };
}

module.exports = createScriptPlayer;
module.exports.createScriptPlayer = createScriptPlayer;
