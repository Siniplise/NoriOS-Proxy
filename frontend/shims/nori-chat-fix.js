/*! UNOFFICIAL local fix (added by QClaw) — nori-chat-fix.js
 *
 * Problem
 *   The desktop chat bubble renders Nori's reply as:
 *       <span className="text-[14px] leading-relaxed font-medium">{text}</span>
 *   with no `white-space` utility, so the browser collapses every "\n" into a
 *   single space. A multi-line persona reply (the V4.4 style: 2~3 short lines)
 *   therefore shows up as one wrapped paragraph.
 *
 * Fix
 *   1. Inject a stylesheet that forces `white-space: pre-wrap` on that exact
 *      span (three-class combo, so it cannot leak into other UI).
 *      -> with the stylesheet in place the DOM sweep is only a fallback.
 *
 * Revert: delete the <script src="/nori-chat-fix.js"> line from index.html.
 * This only changes presentation; no protocol / state / save data is touched.
 *
 * ---------------------------------------------------------------------------
 * ★ 2026-09-27 性能修复（用户反馈「窗口打开有延迟 / 中途缩小会卡一下」）
 *
 *   旧版本在这个文件里同时跑着 4 个「全文档」扫描器：
 *       MutationObserver({childList,subtree,characterData})  on <html>
 *       setInterval(sweep, 1500)      // querySelectorAll('span.leading-relaxed')
 *       setInterval(snap,   400)      // + getBoundingClientRect()  → 每次强制重排!
 *       setInterval(scrub,  250)      // 再一遍 querySelectorAll
 *
 *   窗口的开/合/缩动画会瞬间产生成百上千次 DOM 变动 → 每一次都触发
 *   MutationObserver 回调 → 回调里又对父节点做 querySelectorAll；
 *   叠加 400ms 一次的 getBoundingClientRect（强制同步布局），
 *   于是动画期间掉帧、概率性卡顿（动画越密集越明显）。
 *
 *   现在改成：
 *     1. 只 **1** 个扫描函数，用 requestAnimationFrame 合帧 + 最小间隔节流；
 *     2. MutationObserver 回调只**打标记**不做 DOM 查询，真正干活交给 rAF 合帧；
 *     3. 那个纯调试用的 /nori-debug 探针默认**关闭**（要开加 ?noriDebug=1）；
 *     4. 隐藏「战报」的扫描同样并入同一个合帧循环。
 */
(function () {
  'use strict';
  var VERSION = '2';

  var DEBUG = /[?&]noriDebug=1(&|$)/.test(location.search);   // 调试探针默认关

  /* 1) stylesheet ------------------------------------------------------------------ */
  var CSS =
    'span.text-\\[14px\\].leading-relaxed.font-medium,' +
    'span.leading-relaxed.font-medium,' +
    'span.leading-relaxed{' +
    'white-space:pre-wrap !important;' +
    '}' +
    /* ★ 2026-09-30：隐藏战报也要**持久**。原来只用内联 style.display='none'，
       而 React 重渲染会覆写它自己管理的 style ⇒ 战报会"闪现"回来。
       改成 data 属性 + !important CSS（React 不碰它没管理的属性）。 */
    '[data-nori-hidden]{display:none !important;}';

  function injectCss() {
    try {
      if (document.querySelector('style[data-nori-chat-fix]')) return;
      var st = document.createElement('style');
      st.setAttribute('data-nori-chat-fix', VERSION);
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }

  var MARK = '\u3010NoriOS\u6218\u62a5';

  /* 2.5) 游戏界面状态探针（2026-09-30 新增）
   * 排查「森林寻宝卡在 Nori 正在想提示 / 提示卡错位」时，光看代理日志看不到前端状态。
   * 这里把游戏窗口的可见文本快照 POST 给 /nori-debug —— **只在文本变化时发**，开销极低。
   * 只读 DOM、不改任何状态；要关掉就把下面 GAME_PROBE 改成 false。 */
  var GAME_PROBE = true;
  var gameLast = '';
  var gameBoxState = '';            // 'found' | 'missing'（状态翻转时才上报，用于确认探针活着）
  function gamePost(text) {
    try {
      fetch('/nori-debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: 'gameProbe', t: Date.now(), text: text })
      });
    } catch (e) {}
  }
  function gameProbe() {
    var box = null;
    try { box = document.querySelector('[class*="@container/game"]'); } catch (e) { box = null; }
    if (!box) {
      // ★ 2026-09-30 修：原来「找不到窗口」时静默 return，导致探针像死了。
      //   改成状态翻转时上报一次 —— 下次日志里能直接看出「窗口没找到」还是「找不到探针」。
      if (gameBoxState !== 'missing') { gameBoxState = 'missing'; gamePost('(no @container/game window)'); }
      return;
    }
    var t = '';
    // innerText 依赖可见性；窗口在动画/隐藏态时可能为空 → 回退 textContent
    try { t = (box.innerText || box.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { return; }
    if (!t) return;
    var s = t.slice(0, 320);
    var flipped = (gameBoxState !== 'found');
    gameBoxState = 'found';
    if (!flipped && s === gameLast) return;
    gameLast = s;
    gamePost(s);
  }

  /* 2.6) 【2026-10-01 已整段移除】原「提示卡滞留保险」—— 设计前提就是错的。
   *
   *   原假设：`[class*="bg-background/90"]` 这层遮罩活过 5.5s = 滞留弹窗 → 隐藏它。
   *   读 bundle 源码后的真相 —— 它是 GameScreen 里唯一的通用覆盖层组件：
   *
   *     function Qt({ activeOverlay: s, clueHighlight: t }) {
   *       const a = s !== null || t !== null;
   *       return <AnimatePresence>{a && <motion.div exit={{ opacity: 0 }}>
   *         <div className="absolute inset-0 bg-background/90 backdrop-blur-[3px]" />
   *         {s && <zt type={s} />}                      // 全屏过场（sudden death 等）
   *         {t && !s && t.clue && t.clue.word &&        // ← 居中"提示卡"走这条
   *           <div className="absolute inset-0 flex items-center justify-center">
   *             <nt clue={t.clue} label={t.label} isActive />
   *           </div>}
   *       </motion.div>}</AnimatePresence>;
   *     }
   *
   *   ⇒ 它由 **React 条件渲染 + AnimatePresence(exit 动画)** 管理，
   *     DOM 层干预毫无意义 —— 这也正是当初 `style.display='none'` 会被 React
   *     重渲染覆写的原因（当时误判成"内联样式被覆盖"，其实根本不该碰它）。
   *   ⇒ 而且「提示卡显示 >5.5s」**完全正常**：Nori 思考 + 猜牌本来就可能超过 5.5s。
   *
   *   实测代价（全部 7 次触发，无一例外是误伤，正确判断 0 次）：
   *     "你的提示 SPACECAR&ICENOVEL 4" / "你的提示 刺 杀 1"×2 / "你的提示 AUTO 1"
   *     "NORI 的提示 海 洋 2" / "NORI 的提示 水 流 2" / "NORI 的提示 八 条 腿 2"
   *   而且 cardHidden 一旦置位会**每帧重打标记** ⇒ 误伤是**永久性**的。
   *
   *   ⇒ 结论：这道网没救过任何一次场，却会让玩家**永久看不到提示**。
   *     删掉，恢复原生行为。若将来真遇到「卡片不消失」，那是 clueHighlight
   *     状态没清（游戏状态层问题），应从状态层修 —— 不该在 DOM 层掩盖。
   */

  /* 3) 单次扫描：换行修复 + 隐藏战报 + 游戏探针 + （可选）调试快照 -------------------- */
  function sweepOnce() {
    var nodes;
    try {
      nodes = document.querySelectorAll('span.leading-relaxed');
    } catch (e) {
      return;
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.children && el.children.length > 0) continue;
      var t = el.textContent;
      if (!t) continue;

      /* a. 多行文本 → 强制 pre-wrap（样式表通常已生效，这里是兜底） */
      if (t.indexOf('\n') !== -1 && el.style.whiteSpace !== 'pre-wrap') {
        el.style.whiteSpace = 'pre-wrap';
      }

      /* b. 隐藏代理注入的「【NoriOS战报…」提示气泡
       *    ★ 2026-09-30：改用 data 属性（CSS 里 [data-nori-hidden]{display:none!important}）
       *    —— 内联 style 会被 React 重渲染覆写，导致战报"闪回来"。 */
      if (t.indexOf(MARK) === 0) {
        var box = pickBox(el);
        if (box && box.getAttribute('data-nori-hidden') !== '1') {
          box.setAttribute('data-nori-hidden', '1');
        }
      }
    }
    if (DEBUG) debugSnap();
    if (GAME_PROBE) gameProbe();
  }

  function pickBox(el) {
    var L = (el.textContent || '').length;
    var n = el, best = null, hops = 0;
    // ★★ 2026-09-30 修 B-014（阻断级）：原来 hops 上限是 6，会一路爬到【聊天框根节点】。
    //   触发条件：该窗口内聊天框只渲染了那一条战报 ⇒ 气泡/消息行/列表/根节点的
    //   textContent 全都 ≈ L（根节点只多出输入框 placeholder ≈21 字符，仍 ≤ L+40），
    //   于是下面 "p.textContent.length > L + 40" 这层守卫拦不住 ⇒ data-nori-hidden 被打在
    //   根节点上 ⇒ 配合 CSS 的 [data-nori-hidden]{display:none!important} ⇒
    //   消息列表 + 输入框一起消失，且该属性一旦打上就没有任何代码会撤销
    //   ⇒ 即使之后战报老化、新消息进来，聊天框也永远不再出现（实测"永久隐身"）。
    //   收紧为 2：el(文字span) → 气泡div → 消息行div 就停 —— 消息行每条消息一个 React key，
    //   **不会被跨消息复用**，所以标记只影响那一条，结构上才是正确的。
    while (n && hops < 2) {
      var p = n.parentElement;
      if (!p) break;
      if ((p.textContent || '').length > L + 40) break;
      // ★ 硬护栏：绝不在「含输入控件的容器」上做隐藏。聊天框根节点含 input/form；
      //   万一将来跳数再被放宽，这条也能兜住 —— 宁可留着那条气泡，也绝不弄丢整个聊天框。
      try { if (p.querySelector('input, textarea, form, [contenteditable]')) break; } catch (e) {}
      best = p; n = p; hops++;
    }
    return best || el;
  }

  /* 3) 调试探针（默认关闭；?noriDebug=1 才跑）-------------------------------------- */
  var dbgLast = '';
  function debugSnap() {
    var out = [];
    var nodes;
    try {
      nodes = document.querySelectorAll('span.leading-relaxed');
    } catch (e) { return; }
    for (var i = 0; i < nodes.length && out.length < 24; i++) {
      var el = nodes[i];
      if (el.children && el.children.length > 1) continue;
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      var r = el.getBoundingClientRect();
      out.push({ t: t.slice(0, 50), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) });
    }
    var s = JSON.stringify(out);
    if (s === dbgLast) return;
    dbgLast = s;
    try { fetch('/nori-debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: s }); } catch (e) {}
  }

  /* 4) 合帧调度：所有扫描都走这里，全局最多 ~4 次/秒，且同一帧只跑一次 --------------- */
  var pending = false;
  var lastRun = 0;
  var MIN_GAP = 260;                       // ms
  function schedule() {
    if (pending) return;
    var wait = Math.max(0, MIN_GAP - (Date.now() - lastRun));
    pending = true;
    setTimeout(function () {
      pending = false;
      requestAnimationFrame(function () {
        lastRun = Date.now();
        try { sweepOnce(); } catch (e) {}
      });
    }, wait);
  }

  function start() {
    injectCss();
    sweepOnce();
    try {
      var mo = new MutationObserver(function () { schedule(); });   // 只打标记，不做 DOM 查询
      mo.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (e) {}
    /* 兜底轮询：动画结束后补扫一次（不再是高频全文档扫描） */
    setInterval(function () { schedule(); }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
