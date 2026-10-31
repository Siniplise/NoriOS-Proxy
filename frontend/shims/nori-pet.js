/*! UNOFFICIAL local add-on (added by WorkBuddy) — nori-pet.js
 *
 * 功能：**点 Nori 的头 = 摸头**
 *   · 命中 ⇒ POST http://127.0.0.1:4173/nori-touch  {"part":"head"}
 *   · 代理侧收到后触发 `touch_head` beat（V4.4 的 11 条摸头回应，每次轮换 1 条；首次写记忆）
 *   · 若代理未运行 ⇒ fetch 失败被吞掉，**不影响游戏**
 *
 * 为什么需要这个文件（2026-10-16 查证）：
 *   游戏本体**没有**摸头交互 —— Live2D 的 `HitAreas: []`（模型无命中区）、
 *   `obs.log` 无任何触摸帧、发行包无 pat/head 类音效与 UI。
 *   唯一相关的是"扫描模式"里的窗口覆盖层（`zIndex = SCAN_OVERLAY`，只在选窗口时挂载），
 *   而**平时点立绘是完全无行为的** ⇒ 所以"平时点立绘"这块是空的，可以安全地挂摸头。
 *
 * ★ 怎么知道"立绘在屏幕哪里"（这是本文件唯一有技术含量的地方）
 *   立绘画在 WebGL canvas 里，DOM 里查不到它。
 *   但**游戏自己算过**：扫描模式里那个可点窗口 div 的 left/top/width/height
 *   就是 `Uet()` 用 `model.getPartsBounds(...)` + `modelToCanvasUV()` 算出的立绘可见区域。
 *   ⇒ 本 shim **不自己复算**（那需要 bundle 内部的 model 句柄，普通 script 拿不到），
 *     而是**在玩家进扫描模式时"偷学"那个 rect**，存 localStorage，之后平时点击用它判定。
 *   ⚠ 所以：**玩家至少进过一次扫描模式**后，摸头才会生效（宁缺勿错，不靠猜坐标）。
 *   ⚠ 窗口尺寸变化 ⇒ 学到的坐标失效 ⇒ 下次进扫描模式自动重学。
 *
 * 严格不干扰游戏：
 *   · 只 **读** DOM，不改任何游戏状态、不发游戏协议帧。
 *   · **绝不** preventDefault / stopPropagation（游戏自己的点击照常）。
 *   · 扫描模式下**直接让路**（那时点立绘 = 选窗口来扫描，不能抢）。
 *   · 点在按钮/链接/输入框上时让路。
 *
 * 卸载：删掉 index.html 里的 <script src="/nori-pet.js"> 这一行即可（其余零副作用）。
 *
 * ★ v2（2026-10-16 晚）：加**可观测性** —— 原因见下
 *   本 shim 有个「静默前置条件」：坐标要靠进一次扫描模式偷学 ⇒ **没学到时它完全静默**。
 *   而本项目**服务端不记录静态请求** ⇒ 连"shim 有没有加载"都查不出来。
 *   结果 2026-10-16 连着两次「点头没反应」，我只能把整条链从头查到尾。
 *   ⇒ v2 做三件事（**不改任何触发判据**）：
 *     ① 把 `load` / `learned` / `miss(理由)` 上报到代理 `/nori-pet`（只写日志）
 *     ② 加 `MutationObserver`：选窗口的覆盖层一出现就立刻学（不再只靠 1 秒轮询）
 *     ③ 未校准时给玩家一句**看得见**的提示（每页一次、7 秒自动消失、不挡点击）
 *
 * ★ v3（2026-10-16 晚，同一次排查的第二刀）：修**两处会静默失败的地方**
 *   ① 地址改成**相对路径**（原先是 `http://127.0.0.1:4173/...`）
 *      —— 页面若不是从 `127.0.0.1:4173` 打开（例如 `localhost:4173`，**host 不同即跨源**），
 *         POST + `application/json` 会触发 **预检**，而端点答不了 OPTIONS ⇒ **请求被拦**。
 *      本项目其他 shim 用的都是相对路径（`/nori-line`、`/nori-debug`）。
 *   ② `fire()` 不再只 `.catch(()=>{})` —— **成功/失败都上报**
 *      （原先"被拦 / 代理没起 / 非 200"三种情况全都表现为静默）。
 *   ③ `miss` 带上**点击坐标**与当前区域，事后能判断"点在哪、离立绘多远"。
 *
 * ★★★ v4（2026-10-16 晚，**真正的根因**）：**拖拽也算摸头**
 *   用户明确：「实际摸头是在头部区域**拖拽**」。而 v1~v3 把「位移 > 8px」一律当拖拽**丢掉**
 *   ⇒ **用户真正的摸头动作被整条丢掉，而且完全静默** —— 这才是「怎么都没反应」的真因。
 *   现在：`pointermove` 里一旦拖动且（按下点**或**当前点）在头部区域 ⇒ **即时触发**；
 *        触发过就标记 `fired`，抬手时不再重复；两次触发之间有 `COOLDOWN_MS` 节流。
 *        （`pointerup` 保留兜底：万一 `pointermove` 被漏收）
 *
 * ★★★ v5（2026-10-16 20:33 用户定）：**摸头的手感规则**
 *   ① 摸不足 1.5 秒 ⇒ **不说话**；② 超过 1.5 秒 ⇒ 说一次；
 *   ③ 之后继续摸 ⇒ **每 8 秒一次**；停手 1.5 秒 ⇒ 这一轮结束。
 *   ⇒ 实现上从“按下就触发”改成**按一轮计时**（参见下方 `PAT_*` 常量与时钟）。
 *
 * ★★★ v6（2026-10-16 用户指出）：**不再依赖“扫描模式”学坐标 —— 没样本时直接“算”**
 *   用户原话：「现在还是靠扫描学的吗，不能算吗？
 *   这样这个摸头就依赖分析芯片了，在解锁之前没法使用。」
 *   ⇒ 完全正确：靠扫描学 ⇒ 摸头被“分析芯片”卡住。
 *   现在：从实测到的 rect 拟合出几何公式（见 `FIT` / `computeRect()`），
 *   **从没有样本过也能直接算一个可用的出来**；
 *   一旦真的学到样本，**样本优先**（它是精确值）。
 *
 * ★★★ v7（2026-10-16）：**给摸头加表情**
 *   app 的 `agentMessage` 只接收 `text`，生成的 line 无 `isSpeech`/`emotion`
 *   ⇒ 表情引擎（需 `sender==='agent' && isSpeech && emotion`）**永远不会被触发**。
 *   改从**模型**下手：情绪→表达式名，直接给 L2D 模型加表情；
 *   模型靠遍历 React fiber 拿到，拿不到就静默降级。
 */
(function () {
  'use strict';
  var VERSION = '10';
  /* ★ v3：**一律用相对路径** —— 同源，永远不受"页面是从 localhost 还是 127.0.0.1 打开"影响。
   *   为什么改（2026-10-16 晚）：v2 硬编码 `http://127.0.0.1:4173/...`，
   *   一旦页面来源不是它（例如 `localhost:4173` —— **host 不同即跨源**），
   *   `mode:'cors'` + `content-type: application/json` 会**触发预检**，
   *   而 `/nori-touch` 答不了 OPTIONS（实测 400，且无 allow-methods）⇒ **POST 被浏览器拦掉**，
   *   再被 `.catch()` 吞掉 ⇒ 表现为"点了完全没反应"，服务端一行日志都没有。
   *   ★ 本项目其他 shim（`nori-game-voice.js` 的 `/nori-line`、`nori-chat-fix.js` 的 `/nori-debug`）
   *     用的都是相对路径 —— 相对路径才是这个项目的既有惯例。 */
  var ENDPOINT = '/nori-touch';
  var REPORT = '/nori-pet';            // 自检上报（见文件头「可观测」）
  var LS_KEY = 'nori.pet.rect.v1';
  var CK_KEY = 'nori_pet_rect';        // ★ v4.1：**cookie 备份** —— 见下方「为什么需要」

  /* ── ★ v4.1：坐标的存取（localStorage + cookie 双份）──────────────────────
   * 为什么需要 cookie 这一份：本项目的 `nori-fresh-start.js` 在"世界代号变了"时会
   * `localStorage.clear()` + `sessionStorage.clear()` + 清 IndexedDB/CacheStorage，然后自动重载。
   * ⇒ 只存 localStorage 的话，**每次世界重置都会把我的坐标一起清掉**
   *   （2026-10-16 实测：`PET {"ev":"load","learned":false,"cached":false}` 就是这么来的）。
   * cookie **不在它的清理范围内** ⇒ 存一份兜底，重置后仍然可用。
   * ⚠ cookie 走同源（path=/），只在本机有意义，不含任何隐私。 */
  function saveRect(r) {
    var s = JSON.stringify(r);
    try { localStorage.setItem(LS_KEY, s); } catch (e) {}
    try { document.cookie = CK_KEY + '=' + encodeURIComponent(s) + ';path=/;max-age=2592000'; } catch (e) {}
  }
  function loadRect() {
    try { var v = localStorage.getItem(LS_KEY); if (v) return JSON.parse(v); } catch (e) {}
    try {
      var m = new RegExp('(?:^|; )' + CK_KEY + '=([^;]*)').exec(document.cookie || '');
      if (m) return JSON.parse(decodeURIComponent(m[1]));
    } catch (e) {}
    return null;
  }
  /* ══ ★★★ v6：**没样本时“算”一个立绘区域**（不依赖分析芯片）══
   *   拟合依据：同一台机器上实测到的两个 rect（都是游戏自己用
   *   `getPartsBounds`+`modelToCanvasUV` 算出的精确值）：
   *     vh=991 → {x:776, y:103, w:337, h:752}
   *     vh=935 → {x:786, y: 97, w:320, h:711}
   *   发现它就是「**按视口高度等比缩放 + 水平居中（略偏）**」：
   *     h ≈ 0.7596·vh   w ≈ 0.449·h   y ≈ 0.1040·vh   cx ≈ vw/2 − 15
   *   ⇒ 回代两个样本误差 ≤ 4px；而头部区域高约 0.25·vh（≈240px）⇒ 余量充足。
   *   ★ 优先级：有真实样本 ⇒ 用样本；从来没有过样本 ⇒ 用公式。
   *     这样“解锁分析芯片之前”也能摸头；学到样本后会自动变得精确。
   * ══════════════════════════════════════════════════════════════════════ */
  var FIT = { H_PER_VH: 0.7596, W_PER_H: 0.449, Y_PER_VH: 0.1040, CX_OFF: -15 };
  function computeRect() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var h = Math.round(FIT.H_PER_VH * vh);
    var w = Math.round(FIT.W_PER_H * h);
    var cx = vw / 2 + FIT.CX_OFF;
    return { x: Math.round(cx - w / 2), y: Math.round(FIT.Y_PER_VH * vh),
             w: w, h: h, vw: vw, vh: vh, at: Date.now(), v: VERSION, computed: true };
  }
  /* 视口变了：以“画面中心为锚等比缩放”把旧 rect 校正到新视口（变化过大则 null） */
  function scaleRect(old, vw, vh) {
    if (!old || !(old.vh > 0)) return null;
    if (old.vw === vw && old.vh === vh) return null;
    var k = vh / old.vh;
    if (!(k > 0.6 && k < 1.6)) return null;
    var w2 = Math.round(old.w * k), h2 = Math.round(old.h * k);
    var cx = (old.x + old.w / 2 - old.vw / 2) * k + vw / 2;
    var cy = (old.y + old.h / 2 - old.vh / 2) * k + vh / 2;
    return { x: Math.round(cx - w2 / 2), y: Math.round(cy - h2 / 2), w: w2, h: h2,
             vw: vw, vh: vh, at: Date.now(), v: VERSION,
             approx: true, computed: !!old.computed };
  }

  var TARGET_SEL = '[data-chip-target="nori:billboard"]';
  var HEAD_FRACTION = 1 / 3;   // 立绘**上部 1/3** 算"头部"（身体下部点了不算）
  var MOVE_TOL = 8;            // 按下→抬起位移超过 8px 视为拖拽/滑动，不算点击
  var LEARN_MS = 1000;

  var RECT = loadRect();                 // ★ v4.1：localStorage 优先，cookie 兜底
  if (RECT) {                            // 有真实样本 ⇒ 用它（视口不符先按比例校正）
    var _scaled = scaleRect(RECT, window.innerWidth, window.innerHeight);
    if (_scaled) RECT = _scaled;
  } else {                               // ★ v6：从来没有过样本 ⇒ **直接算**（不依赖分析芯片）
    RECT = computeRect();
    beacon('rect-computed', { rect: RECT, why: 'no-sample' });
  }

  function log() {
    try {
      var a = ['[nori-pet]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, a);
    } catch (e) {}
  }

  /* ── ★ v2：自检上报 ───────────────────────────────────────────────────────
   * 为什么要这个：本 shim 的坐标靠"进一次扫描模式"偷学 ⇒ **没学到时它完全静默**，
   * 而服务端**不记录静态请求** ⇒ 连"shim 有没有加载"都看不出来（2026-10-16 卡了两次）。
   * ⇒ 把 load / learned / miss 三种事件打给代理（`/nori-pet` 只写日志、不改行为）。
   * ⚠ 代理没起时会 404 ⇒ 被 `.catch` 吞掉，不影响游戏。 */
  var _missT = {};
  function beacon(ev, extra) {
    try {
      var body = { ev: ev, v: VERSION, learned: !!RECT };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k]; } }
      log('上报 ' + ev, body);
      fetch(REPORT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        mode: 'cors',
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }
  /* 同一个理由 3 秒内只报一次（避免连点刷屏）；`pos` 带上点击坐标与当前区域，
   *  便于事后判断"到底点在哪、离立绘多远"。 */
  function miss(why, pos) {
    var now = Date.now();
    if (_missT[why] && now - _missT[why] < 3000) return;
    _missT[why] = now;
    beacon('miss', { why: why, pos: pos || null, rect: RECT || null });
  }

  /* ── 学习：扫描模式里那个 div 的 rect，就是游戏算出的立绘可见区域 ────────── */
  /* ★ v3.1：**抖动容差** —— 这个是实测出来的：`Uet()` 用的是 `getPartsBounds`（模型当前姿态的
   *   可见边界），而模型**一直在呼吸/待机摆动** ⇒ 那个 rect **每帧都在变**（实测同一秒内
   *   w 在 336~390 之间抖）。
   *   原来的写法是"只要 x/y/w/h 有一点不同就重存 + 重上报" ⇒ **每秒刷一条 `learned`**，
   *   12 秒刷 19 条（2026-10-16 实测），把日志淹了。
   *   ⇒ 现在：小幅变化**静默跟随**（RECT 照常更新，命中判定更准），**只有"首次 / 变化超过
   *     24px / 视口尺寸变了"才上报**。 */
  function sameish(a, b) {
    return !!a && !!b && Math.abs(a.x - b.x) <= 24 && Math.abs(a.y - b.y) <= 24
      && Math.abs(a.w - b.w) <= 24 && Math.abs(a.h - b.h) <= 24
      && a.vw === b.vw && a.vh === b.vh;
  }

  function learn() {
    var el = document.querySelector(TARGET_SEL);
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width < 40 || r.height < 40) { miss('rect-too-small'); return false; }   // 明显异常不记
    var next = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
                 vw: window.innerWidth, vh: window.innerHeight, at: Date.now(), v: VERSION };
    if (sameish(RECT, next)) { RECT = next; return true; }   // 只抖动 ⇒ 静默跟随，不刷日志
    RECT = next;
    saveRect(RECT);                               // ★ v4.1：localStorage + cookie 双写
    log('学到立绘区域', RECT);
    beacon('learned', { rect: RECT });            // ★ 学到/显著变化才上报（这条一出，摸头就能用了）
    return true;
  }

  learn();                                        // ★ v2：加载时试学一次（覆盖层通常不在 ⇒ 学不到）
  beacon('load', { cached: !!RECT, src: RECT ? (RECT.computed ? 'computed' : 'sample') : 'none' });             //   上报 `learned`(v2 自动带) ⇒ 未校准 / 用上次坐标

  try { setInterval(learn, LEARN_MS); } catch (e) {}
  /* ★ v2：除了每秒轮询，再挂一个 MutationObserver —— 选窗口的覆盖层是**条件挂载**的，
   *   只靠 1 秒轮询可能整段错过（玩家进去又立刻退出）⇒ 这里一出现就立刻学。 */
  try {
    var _lq = false, _mo = new MutationObserver(function () {
      if (_lq) return;
      _lq = true;
      setTimeout(function () { _lq = false; learn(); }, 60);
    });
    _mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  /* ── ★ v2：没校准时给用户一句**看得见**的提示 ───────────────────────────────
   * 为什么必须有：没学到坐标时本 shim 是**完全静默**的 ⇒ 玩家只会以为"摸了没反应"
   *   （2026-10-16 两次都栽在这）。只在未校准、且每页只提示一次，7 秒后自动消失，
   *   `pointer-events:none` 保证不挡任何点击。 */
  var HINTED = false;
  function hint() {
    if (HINTED) return;
    HINTED = true;
    try {
      var d = document.createElement('div');
      d.setAttribute('data-nori-pet-hint', '1');
      d.textContent = '摸头好像没摸到：点一次「分析芯片」让窗口列表出现再关掉，就能校准坐标';
      d.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);'
        + 'z-index:2147483647;pointer-events:none;max-width:78vw;text-align:center;'
        + 'background:rgba(18,18,26,.88);color:#e9e9f2;border:1px solid rgba(255,255,255,.16);'
        + 'border-radius:10px;padding:8px 14px;'
        + 'font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif';
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function () { try { d.parentNode.removeChild(d); } catch (e) {} }, 7000);
    } catch (e) {}
  }
  /* v6：RECT 现在总有值（算的或样本）⇒ 不再自动弹“未校准”提示；
   * 只在“用公式估算”且连续摸不到时才提一句（见 maybeHintEstimate） */

  /* ★★★ v4.1：视口变了 ⇒ **按比例校正**，不要直接丢掉。
   *   为什么改（2026-10-16 浏览器里实测到的）：这台机器的视口高度在 **991 → 935 → 994** 之间变过几次
   *   （换地址/工具条/缩放都会变）。v2~v4 的写法是"尺寸一变就 `RECT = null`"
   *   ⇒ **此后 shim 完全静默，直到玩家再进一次扫描模式**
   *   （实测：12:26:53 `rect-invalidated` → 12:27:18 点头 `miss no-rect` —— 就这么白丢了一次）。
   *   现在：以"**立绘随视口等比缩放 + 画面中心为锚**"做近似校正（头部区域占 rect 的 1/3，
   *   几百 px 的余量足以吸收几 % 的误差）；只有变化过大（<0.6 倍或 >1.6 倍）才作废重学。 */
  window.addEventListener('resize', function () {
    if (!RECT) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    if (RECT.vw === vw && RECT.vh === vh) return;
    var old = RECT, next = scaleRect(old, vw, vh);
    if (next) {
      RECT = next;
      if (!RECT.computed) saveRect(RECT);      // 只持久化“样本”（公式值随时可重算）
      log('视口变了，按比例校正立绘区域', RECT);
      beacon('rect-adjusted', { old: old, next: next });
    } else {
      RECT = computeRect();                    // ★ v6：不空着 —— 直接用公式给个可用值
      log('视口变化过大，改用公式重算', RECT);
      beacon('rect-computed', { rect: RECT, why: 'huge-resize' });
    }
  });

  /* ── 让路判据 ─────────────────────────────────────────────────────────── */
  function inScanMode() {
    try { return !!document.querySelector('[data-chip-target]'); } catch (e) { return false; }
  }
  function onInteractive(el) {
    try {
      return !!(el && el.closest &&
        el.closest('button, a, input, textarea, select, label, [role="button"], [contenteditable="true"]'));
    } catch (e) { return false; }
  }

  /* ── 触发 ─────────────────────────────────────────────────────────────── */
  function fire(part) {
    log('摸头 → ' + part);
    /* ★ v3：**发出去也要能看见结果** —— v2 只 `.catch(function(){})`，
     *   于是"请求被拦 / 代理没起 / 返回非 200"三种情况**全都表现为静默**
     *   （2026-10-16 晚就是这么卡住的）。现在成功/失败都上报。 */
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ part: part }),
      }).then(function (r) {
        if (r && r.ok) {
          beacon('fire-ok', { part: part, status: r.status });
          /* ★ v7：代理会在响应里回传这句台词的 emotion ⇒ 据此给模型加表情 */
          try { r.json().then(function (j) { applyExpression(j && j.emotion); }); } catch (e) {}
        } else beacon('fire-failed', { part: part, status: (r && r.status) || 0 });
      }).catch(function (e) {
        beacon('fire-failed', { part: part, err: String((e && e.message) || e) });
      });
    } catch (e) {
      beacon('fire-failed', { part: part, err: String((e && e.message) || e) });
    }
  }

  /* ══ ★★★ v7：给摸头**加表情** ══════════════════════════════
   *   为什么不能走原有的台词通道（2026-10-16 在 bundle 里查实）：
   *   app 的 `agentMessage` 命令 **schema 里只有 `text`**，
   *   它生成的 chat line 既没有 `isSpeech` 也没有 `emotion`；
   *   而表情引擎的命中条件是 **`sender==='agent' && isSpeech && emotion`**
   *   ⇒ **走 `agentMessage` 的台词永远不会有表情**（chip 播报同理）。
   *
   *   所以直接从**模型**下手：把情绪映射成表达式名，直接给 L2D 模型加表情。
   *   · 表达式名与 app 的 `L8e`/`ni` 一致（happy→07_Smile 等）
   *   · 模型对象**没有全局句柄**，靠**遍历 React fiber** 拿到
   *   · 拿不到就**静默降级**（只上报一次，不报错、不影响任何其他功能）
   * ══════════════════════════════════════════════════════════════════════ */
  var EMO2EXPR = {
    happy: '07_Smile', excited: '01_KiraKira', sad: '08_Tears', angry: '03_Angry',
    fearful: '11_Disgust', disgusted: '11_Disgust', surprised: '14_Surprised',
    doubtful: '11_Disgust', dizzy: '02_Dizzy', serious: '12_Serious', neutral: null
  };
  var EXPR_SECS = 2.5;
  var _model = null, _modelTried = 0, _lastExpr = null, _exprBeamed = false;

  function looksLikeModel(o) {
    try {
      return !!o && typeof o === 'object' && typeof o.addExpression === 'function'
        && (typeof o.startMotion === 'function' || typeof o.setIdleSequence === 'function'
            || typeof o.setTemporaryExpression === 'function');
    } catch (e) { return false; }
  }
  function scanFiber(f) {
    var i, k, v;
    var cands = [f.memoizedProps, f.memoizedState];
    for (i = 0; i < cands.length; i++) {
      v = cands[i];
      if (looksLikeModel(v)) return v;
      if (v && typeof v === 'object' && !v.next) {
        for (k in v) { if (Object.prototype.hasOwnProperty.call(v, k) && looksLikeModel(v[k])) return v[k]; }
      }
    }
    var h = f.memoizedState, n = 0;
    while (h && typeof h === 'object' && n++ < 80) {
      if (looksLikeModel(h.memoizedState)) return h.memoizedState;
      h = h.next;
    }
    return null;
  }
  /* 从 canvas 上的 React fiber 往上走，找挂过 L2D 模型的组件 */
  function findModelInReact() {
    var els = [];
    try { els = document.querySelectorAll('canvas'); } catch (e) { els = []; }
    if (!els || !els.length) { try { els = [document.getElementById('root')]; } catch (e) {} }
    for (var i = 0; i < (els ? els.length : 0); i++) {
      var el = els[i]; if (!el) continue;
      var key = null, ks = Object.keys(el);
      for (var j = 0; j < ks.length; j++) { if (ks[j].indexOf('__reactFiber') === 0) { key = ks[j]; break; } }
      if (!key) continue;
      var f = el[key], hops = 0;
      while (f && hops++ < 60) {
        var hit = scanFiber(f);
        if (hit) return hit;
        f = f.return;
      }
    }
    return null;
  }
  function getModel() {
    if (_model) return _model;
    var now = Date.now();
    if (now - _modelTried < 2000) return null;      // 找不到也别每次摸头都遍历一遍
    _modelTried = now;
    _model = findModelInReact();
    if (_model) log('拿到 L2D 模型（用于加表情）');
    return _model;
  }
  /* 情绪 ⇒ 表情；失败一律静默降级 */
  function applyExpression(emotion) {
    if (!emotion) return false;
    var name = EMO2EXPR[emotion];
    if (!name) return false;
    var m = getModel();
    if (!m) {
      if (!_exprBeamed) { _exprBeamed = true; beacon('expr-none', { emotion: emotion, why: 'model-not-found' }); }
      return false;
    }
    try {
      if (typeof m.setTemporaryExpression === 'function') {
        m.setTemporaryExpression(name, EXPR_SECS);   // 自带"过一会儿撤掉"
      } else {
        if (_lastExpr && _lastExpr !== name && typeof m.removeExpression === 'function') m.removeExpression(_lastExpr);
        m.addExpression(name);
        _lastExpr = name;
        setTimeout(function () {
          try { m.removeExpression(name); } catch (e) {}
          if (_lastExpr === name) _lastExpr = null;
        }, EXPR_SECS * 1000);
      }
      beacon('expr-ok', { emotion: emotion, expr: name });
      return true;
    } catch (e) {
      beacon('expr-failed', { emotion: emotion, err: String((e && e.message) || e) });
      return false;
    }
  }

  /* ══ ★★★ v9：命中判据 **改走游戏自己的 L2D 判定**（用户 2026-10-16 23:0x 要求）══════
   *
   *  为什么废弃坐标判定（用户实测）：
   *    虚拟应用窗口挡住立绘时，右下角会冒出一个小 Nori ⇒ 立绘位置/形态变了，
   *    而我们"偷学"的 rect 还指着屏幕中央 ⇒ **在中央空白处点一下也会触发摸头**。
   *    ⇒ 坐标判定在"立绘被挡 / 被替换成小 Nori"时**必然误判**。
   *
   *  ★ 正解：**本地这套（= MF-Dust 版）自己就有一整套摸头系统**，
   *    代码在 `public/assets/NormalApp-*.js`。
   *
   *  ⚠⚠ 来源分级与叫法（项目里"官方"栽过两次；用户 2026-10-17 定名）：
   *    · **本地这一整套（exe + `public/assets/*.js`）叫「MF-Dust 版」**，**不要说"官方"**；
   *      而且本项目的**魔改层改过 `public/assets/*.js`** ⇒ 只能说"MF-Dust 版 bundle 里是这样"；
   *    · `github.com/MF-Dust/Nori.Web` 叫「**MF-Dust 仓库**」，
   *      它的 `frontend-src/live2d/head-pat-input.ts` 是**从历史 bundle 恢复/改写**的版本
   *      （该仓库自称"社区兼容项目，非官方发行版"）⇒ **C 级**，只作**设计参考**；
   *    · **只有 `os.inori.ai` 的发布物**、以及**用户在真机上看到的行为**，才可以说"官方"。
   *    ⇒ 一句话：**本项目前端层面没有"官方源码"这回事**。
   *
   *  MF-Dust 版里那套的要点：
   *      · 闸门：`!active && idleState==='idle'` ⇒ **有应用窗口活动时不响应**（正合我们要的规则）
   *      · 命中：`hitTestParts(zC,…)` + `getPartsBounds(WC)` 的「头顶带」⇒ **真 L2D 部件**，不是屏幕矩形
   *      · ★★ 它的**判定入口是「事件目标」**：
   *          `const o = e.target.closest('[data-nori-pat-surface]'); if (!o || …) 不算`
   *        ⇒ **天然尊重 z-order**：有东西压在上面 ⇒ 事件目标不是 pat-surface ⇒ 它根本不判定。
   *
   *  ⚠⚠ v8 的两个错（2026-10-17 00:2x 用户实测发现，本版修正）：
   *    ① v8 用"页面上有没有 `cursor:grab`"当命中信号 —— 而那个 cursor 是**粘的**：
   *       MF-Dust 版只在 `pointermove` 时设/清，指针离开后不一定清掉 ⇒ 轮询到一次就等于"永远悬停" ⇒
   *       **点哪都算摸头**（实测日志：`PET {"ev":"official-hit","sig":"hover","mode":"official"}`）。
   *    ② v8 在"事件目标"模式下**删掉了 v7 原有的"分析模式让路"**。
   *    ⇒ 本版：**判据回到「事件目标」**（与 MF-Dust 版里的实现同款）+ **恢复分析模式让路**；
   *      `[data-nori-pat-cursor-shield]` 只作**加强信号**（它只在 MF-Dust 版真正 armed 时存在）。
   *
   *  回退：`window.NORI_PET_MODE='rect'` ⇒ 退回旧的坐标判定（对照/排错用）。
   *  ═══════════════════════════════════════════════════════════════════════════════ */
  var USE_RECT = /^rect$/i.test(String(window.NORI_PET_MODE || '').toLowerCase());
  /* 游戏 armed 的 DOM 影子（只在"真的在摸"时存在，不粘） */
  function shieldOn() {
    try { return !!document.querySelector('[data-nori-pat-cursor-shield]'); } catch (e) { return false; }
  }
  /* ★ 事件目标是否落在 MF-Dust 版的 pat-surface 上 —— 就是那句 `e.target.closest(...)` */
  function patSurfaceOf(e) {
    try {
      var t = e && e.target;
      if (!t || typeof t.closest !== 'function') return null;
      return t.closest('[data-nori-pat-surface]');
    } catch (x) { return null; }
  }
  /* ★★ 2026-10-18：**DOM 里到底有没有 pat-surface**（带 400ms 缓存，pointermove 高频调用）
   *   为什么需要它：进卡带（森林寻宝 / 代号 / 蛋糕对决…）后桌面那层 `fixed inset-0` 的
   *   pat-surface 会被**卸载** ⇒ `patSurfaceOf()` 永远 null ⇒ 第 ① 道门永远 false
   *   ⇒ 游戏界面里摸头彻底失效（用户 2026-10-18 实测）。
   *   ⇒ 只有在"**一个都没有**"时才跳过第 ① 道门；桌面上照旧尊重 z-order。 */
  var _psAt = 0, _psHas = false;
  function hasPatSurface() {
    var now = Date.now();
    if (now - _psAt < 400) return _psHas;
    _psAt = now;
    try { _psHas = !!document.querySelector('[data-nori-pat-surface]'); } catch (e) { _psHas = false; }
    return _psHas;
  }
  /* ══ ★★ v10：补上官方判定的**另一半** —— 「摸到了她」= 真 L2D 命中 ══════════════
   *
   *  v9 的错（用户 2026-10-17 00:33 实测：「摸右上角空白区域照样触发」）：
   *    只判了 `e.target` 在 pat-surface 上 —— 但 MF-Dust 版有**全屏**的 pat-surface
   *    （桌面层 `fixed inset-0`，`zIndex: DESKTOP`）⇒ **桌面上随便点哪都是 pat-surface** ⇒ 全屏都算摸头。
   *
   *  MF-Dust 版真正的判定是**两条同时成立**（`M8e`）：
   *      ① `e.target.closest('[data-nori-pat-surface]')`          ← 尊重 z-order（有窗口压住就不算）
   *      ② `Ly(model, x, y)` = `hitTestParts(zC,…)` + 头顶带      ← **真的摸到了她的头**
   *    v9 只做了 ①，漏了 ②。
   *
   *  参数取值（**MF-Dust 仓库** `frontend-src/live2d/head-pat.ts` 的默认调参，**C 级，仅作参考**）：
   *      `skullTopBand: 0.6`（头顶带的上界比例）· `leashHeadWidths: 0.75`
   *    ⚠ 仓库与本地 bundle **版本不同** ⇒ 这两个值按"合理默认"用，可被 `window.NORI_PAT_*` 覆盖。
   * ═══════════════════════════════════════════════════════════════ */
  var ZC = ['Part', 'Part3', 'Part5', 'Part6', 'Part7', 'Part8', 'Part9', 'Part42', 'Part43', 'Part44', 'Part61'];
  var WC = ['Part9'];                                                    // 头部部件
  var SKULL_BAND = Number(window.NORI_PAT_SKULL_BAND || 0.6);
  var _degradeBeamed = false;
  /* ★ 首选"**实时**的立绘框"：MF-Dust 版那个立在立绘上的 pat-surface（带 `data-live2d-input-ignore`）
   *   是**每帧**按 `getPartsBounds` 重算位置的 ⇒ 比我们"偷学/拟合"的 RECT **永远不过期**。
   *   ⚠ 只在尺寸合理时采用（防拿错元素）；否则退回 RECT。 */
  function livePatRect() {
    try {
      var el = document.querySelector('[data-nori-pat-surface][data-live2d-input-ignore]');
      if (el) {
        var r = el.getBoundingClientRect();
        if (r && r.width >= 50 && r.height >= 100) return r;
      }
    } catch (e) {}
    return null;
  }
  /* 「摸到她」判定：返回 true/false；**拿不到模型时返回 null**（交给调用方决定怎么退化） */
  function modelHeadHit(x, y) {
    var m = null;
    try { m = getModel(); } catch (e) {}
    if (!m || typeof m.hitTestParts !== 'function'
      || typeof m.getPartsBounds !== 'function' || typeof m.canvasUVToModel !== 'function') return null;
    /* ★ UV 空间的来源，优先实时的那个框 */
    var box = livePatRect();
    var bx, by, bw, bh;
    if (box) { bx = box.left; by = box.top; bw = box.width; bh = box.height; }
    else if (RECT && RECT.w && RECT.h) { bx = RECT.x; by = RECT.y; bw = RECT.w; bh = RECT.h; }
    else return null;
    var uv = null;
    try { uv = m.canvasUVToModel((x - bx) / bw, (y - by) / bh); } catch (e) { return false; }
    if (!uv) return false;
    var inside = false;
    try { inside = !!m.hitTestParts(ZC, uv.x, uv.y); } catch (e) { return false; }
    if (!inside) return false;                                           // ★ 空白处 ⇒ 这里就 false 了
    var b = null;
    try { b = m.getPartsBounds(WC); } catch (e) { return false; }
    if (!b) return false;
    var band = b.top - (b.top - b.bottom) * SKULL_BAND;                  // 与 MF-Dust 版同款公式
    return uv.y >= band;                                                 // 落在"头顶带"里才算摸头
  }
  /* 拿不到模型时的**保守退化**：只认"立绘上部 1/3"（v7 的老规则）——
     ★ 绝不能退化成"哪都算"（那正是 v9 的 bug）。 */
  function rectTopThird(x, y) {
    return !!RECT && x >= RECT.x && x <= RECT.x + RECT.w
      && y >= RECT.y && y <= RECT.y + RECT.h * HEAD_FRACTION;
  }
  /* 统一命中入口 */
  /* ★★ 2026-10-18（实测定案）：**默认不再要求"事件目标在 pat-surface 上"**。
   *   诊断证据（用户 02:0x 在森林寻宝内 `NoriPet.why()`）：
   *     · 游戏里 `hasSurface:true`（官方那层 `fixed inset-0` 是**常驻**的）
   *     · 但事件目标是**游戏窗口** ⇒ `not-on-surface` ⇒ 摸头全灭
   *     · `NoriPet.surfaceGate(false)` 后立刻能摸（pat-say → fire-ok → expr-ok）
   *   ⇒ 那道 z-order 门对"游戏里摸头"是致命阻塞，收益（防止隔着窗口摸）远小于代价。
   *   保留开关：`window.NORI_PET_SURFACE_GATE='on'` 或 `NoriPet.surfaceGate(true)` 可恢复。
   *   ★ 真正的"是否摸到她"仍由第 ② 道门（L2D `hitTestParts` + 头顶带）把关，
   *     所以不会退化成 v9 那种"点哪都算"。 */
  var IGNORE_SURFACE = !/^(on|1|true)$/i.test(String(window.NORI_PET_SURFACE_GATE || ''));
  var _lastReject = '', _lastRejectAt = 0;
  function reject(why) {
    _lastReject = why;
    var now = Date.now();
    if (now - _lastRejectAt > 3000) {          // 3s 节流，别刷爆日志
      _lastRejectAt = now;
      var m = false;
      try { m = !!getModel(); } catch (e) {}
      beacon('pat-reject', {
        why: why, hasSurface: hasPatSurface(), scan: inScanMode(), model: m,
        rect: !!RECT, liveRect: !!livePatRect(),
      });
    }
    return false;
  }
  function inHead(x, y, e) {
    if (USE_RECT) return rectTopThird(x, y);
    if (inScanMode()) return reject('scan-mode');     // ★ 分析模式一律让路
    /* ★★ 2026-10-18：第 ① 道门（必须在 pat-surface 上）只在**DOM 里确实有 pat-surface**时生效。
     *   卡带里那层被卸载 ⇒ hasPatSurface()=false ⇒ 跳过 ①，直接走 ②（真 L2D 头部命中）
     *   ⇒ 游戏界面里也能摸头。桌面上 hasPatSurface()=true ⇒ 行为与之前完全一致。
     *   ★ 实测（2026-10-18 02:0x）：游戏里仍摸不了 ⇒ 那层**其实还在**（官方 `fixed inset-0`），
     *     只是事件目标是游戏窗口、不在 surface 内。可用 `NoriPet.surfaceGate(false)` 现场对照。 */
    if (!patSurfaceOf(e) && !IGNORE_SURFACE && hasPatSurface()) return reject('not-on-surface');
    if (shieldOn()) return true;           // MF-Dust 版已 armed（它已经过了 ②）⇒ 确实在摸
    var hit = modelHeadHit(x, y);
    if (hit === null) {                    // 拿不到模型 ⇒ 退化 + 只报一次
      if (!_degradeBeamed) { _degradeBeamed = true; beacon('pat-degrade', { why: 'no-model-or-rect' }); }
      return rectTopThird(x, y);
    }
    return hit ? true : reject('no-head-hit');
  }
  function inRect(x, y, e) {
    if (USE_RECT) return !!RECT && x >= RECT.x && x <= RECT.x + RECT.w && y >= RECT.y && y <= RECT.y + RECT.h;
    return inHead(x, y, e);
  }

  /* ══ ★★★ v5：**摸头的手感规则**（用户 2026-10-16 20:33 定）════════════════
   *   ① 摸头**不足 1.5 秒** ⇒ **不说话**（被摸一下不必每次都开口）
   *   ② 持续摸**超过 1.5 秒** ⇒ 说一次
   *   ③ 之后**继续摸** ⇒ **每 8 秒**说一次
   *
   * 实现：**把"按下就触发"改成"按一轮计时"**
   *   · 头部区域只要有"摸"的动作（**按下、拖动都算**）⇒ 维持**这一轮** `pat` 并刷新 `lastAt`；
   *   · 一个 250ms 的**时钟**统一决定何时真的开口（`nextAt`）；
   *   · 超过 `PAT_IDLE_MS` 没有动作 ⇒ **这一轮结束**（再摸要重新等满 3 秒）。
   *   ⇒ 单击 / 快速划过都**不会**说话 —— 这正是用户要的。
   *   ★ 开口与"抬手"无关：**抬手不结束这一轮**（连续轻拍是最常见的"持续摸头"形态）。
   * ══════════════════════════════════════════════════════════════════════ */
  var PAT_HOLD_MS = 1500;     // ① 摸够 1.5 秒才开口（2026-10-16 用户：3 秒太长）
  var PAT_REPEAT_MS = 8000;   // ③ 之后每 8 秒一次
  /* ★ 2026-10-17 修复：原来也是 1500，**与 PAT_HOLD_MS 撞车** —— 时钟 250ms 一跳，
   *   而回调里"停手结束"的判定排在"开口"之前 ⇒ 正好 1.5s 停手时这一轮被判 idle
   *   结束，永远等不到开口（日志实锤：heldMs 1504/1509/1556/1692/1695/1742 全是 said=0）。
   *   ⇒ 把"停手"宽限提到 2500，让开口**必定**先发生；顺带更符合手感（抬手不打断这一轮）。 */
  var PAT_IDLE_MS = 2500;     // 超过这么久没有"摸"的动作 ⇒ 这一轮结束
  var pat = null;             // { startedAt, lastAt, nextAt, n }

  function patTouch() {       // 记一次"摸"（只维持这一轮，**不直接开口**）
    var now = Date.now();
    if (!pat) {
      pat = { startedAt: now, lastAt: now, nextAt: now + PAT_HOLD_MS, n: 0 };
      log('摸头·开始（满 ' + PAT_HOLD_MS + 'ms 才开口）');
      beacon('pat-start');
    }
    pat.lastAt = now;
  }
  function patEnd(why) {
    if (!pat) return;
    var held = Date.now() - pat.startedAt;
    if (held >= 1000) beacon('pat-end', { heldMs: held, said: pat.n, why: why });
    log('摸头·结束 held=' + held + 'ms said=' + pat.n + '（' + why + '）');
    pat = null;
  }

  try {
    setInterval(function () {
      if (!pat) return;
      var now = Date.now();
      if (USE_RECT && (inScanMode() || !RECT)) { patEnd('let-way'); return; }   // 旧坐标模式需要 rect
      if (!USE_RECT && inScanMode()) { patEnd('scan-mode'); return; }           // ★ v9：分析模式 ⇒ 这一轮结束
      if (now - pat.lastAt > PAT_IDLE_MS) { patEnd('idle'); return; }  // 停手 ⇒ 这一轮结束
      if (now < pat.nextAt) return;
      pat.n++;
      pat.nextAt = now + PAT_REPEAT_MS;
      log('摸头·开口 #' + pat.n + '（已持续 ' + (now - pat.startedAt) + 'ms）');
      beacon('pat-say', { n: pat.n, heldMs: now - pat.startedAt });
      fire('head');
    }, 250);
  } catch (e) {}

  /* 只有“公式估算”时才可能需要校准；连续两次摸在区域外 ⇒ 提一句 */
  var _outMiss = 0;
  function maybeHintEstimate() {
    if (!RECT || !RECT.computed) return;
    if (++_outMiss !== 2) return;
    hint();
  }

  var downAt = null;
  window.addEventListener('pointerdown', function (e) {
    downAt = { x: e.clientX, y: e.clientY, b: e.button };
    if (e.button !== undefined && e.button !== 0) return;              // 只认左键
    if (USE_RECT && inScanMode()) return;                              // 旧模式：选窗口 ⇒ 让路
    if (inHead(e.clientX, e.clientY, e)) {                             // ★ v9：**从事件目标判**（游戏同款）
      if (!pat) beacon('pat-hit', { sig: shieldOn() ? 'shield' : 'surface', mode: USE_RECT ? 'rect' : 'surface' });
      patTouch();
    }
  }, true);

  /* ★ v9：「事件目标」模式下**从事件目标判**（不再看位移阈值，也不再轮询 cursor）；
     v4 那套"拖到头部也算"只在旧坐标模式里保留。 */
  window.addEventListener('pointermove', function (e) {
    var d = downAt;
    if (!d) return;
    if (d.b !== undefined && d.b !== 0) return;
    if (!USE_RECT) { if (inHead(e.clientX, e.clientY, e)) patTouch(); return; }
    if (inScanMode()) return;
    if (!RECT) return;
    var x = e.clientX, y = e.clientY;
    if (Math.abs(x - d.x) <= MOVE_TOL && Math.abs(y - d.y) <= MOVE_TOL) return;   // 还没到"拖动"的程度
    if (inHead(d.x, d.y, e) || inHead(x, y, e)) patTouch();             // ★ 按下点在头部、或拖到头部
  }, true);

  window.addEventListener('pointerup', function (e) {
    var d = downAt; downAt = null;
    if (!USE_RECT) return;          // ★ v8/v9：「事件目标」模式不做坐标诊断（那些 miss 只对旧 rect 模式有意义）
    var x = e.clientX, y = e.clientY;
    var P = { x: x, y: y };
    /* ★ v5：抬手**不结束这一轮**（连续轻拍是"持续摸头"的常见形态 ⇒ 交给 PAT_IDLE_MS 断句）。
     *   这里只做**诊断上报**：点/拖到哪、为什么没算"摸头"。 */
    if (!d) { if (inRect(x, y, e)) miss('no-pointerdown', P); return; }
    if (d.b !== undefined && d.b !== 0) { if (inRect(x, y, e)) miss('non-left-button', P); return; }   // 只认左键
    var moved = Math.abs(x - d.x) > MOVE_TOL || Math.abs(y - d.y) > MOVE_TOL;
    if (inScanMode()) { miss('scan-mode', P); return; }                            // 选窗口模式 ⇒ 让路
    if (!RECT) { miss('no-rect', P); hint(); return; }                             // 还没学到区域 ⇒ 不猜
    if (!inRect(x, y, e) && !inRect(d.x, d.y, e)) { miss('x-outside', P); maybeHintEstimate(); return; }
    if (moved) { if (!inHead(x, y, e) && !inHead(d.x, d.y, e)) miss('drag-outside-head', P); return; }
    if (y < RECT.y) { miss('y-above', P); return; }
    if (y > RECT.y + RECT.h * HEAD_FRACTION) { miss('y-below-head', P); return; }   // 点/拖在身体上
    if (onInteractive(document.elementFromPoint(x, y))) { miss('on-interactive', P); return; }
    /* 落在头部 ⇒ 已在 pointerdown / pointermove 里计入这一轮；**开不开口由时钟决定** */
  }, true);

  /* ★★ 2026-10-18：**调试口**（卡带里摸不了头时用来定位是哪道门挡的）
   *   `NoriPet.why()`              查看当前判定环境 + 最近一次拒绝原因
   *   `NoriPet.surfaceGate(false)` 现场关掉"必须在 pat-surface 上"那道门（不刷新也能试）
   *   `NoriPet.surfaceGate(true)`  恢复
   *   ★ 拒绝原因同时会以 `pat-reject` 上报（3s 节流）⇒ `proxy.log` 里直接能看。 */
  try {
    window.NoriPet = {
      surfaceGate: function (on) {
        IGNORE_SURFACE = !on;
        return IGNORE_SURFACE
          ? 'surfaceGate OFF（不再要求事件目标在 pat-surface 上）'
          : 'surfaceGate ON（恢复 z-order 判定）';
      },
      why: function () {
        var m = null;
        try { m = !!getModel(); } catch (e) {}
        return {
          version: VERSION, useRect: USE_RECT, ignoreSurface: IGNORE_SURFACE,
          hasSurface: hasPatSurface(), scanMode: inScanMode(), model: m,
          rect: RECT || null, liveRect: !!livePatRect(),
          lastReject: _lastReject || '(never)',
          lastRejectAgoMs: _lastRejectAt ? (Date.now() - _lastRejectAt) : -1,
          patting: !!pat, said: pat ? pat.n : 0,
        };
      },
    };
  } catch (e) {}

  log('已启用（v' + VERSION + '，命中=' + (USE_RECT ? '旧坐标(rect)' : 'MF-Dust版 pat-surface（事件目标）') + '）');
})();
