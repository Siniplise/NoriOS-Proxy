/* nori-freeze-probe.js —— 蛋糕对决「质疑后停滞」常驻探针 v3（我们的 shim，不改官方 bundle）
 * ══════════════════════════════════════════════════════════════════════════
 *  ★ 版本演进（每一步都是实测踩出来的）：
 *   v1 ✗ 用「任何帧静默 18s」判冻结 ⇒ **永不触发**（`pong` 每 10s 就来一次）
 *      ✗ recentIn/Out 仅 25 条环形 ⇒ 事发帧被冲掉
 *   v2 ✓ 改用 fence 配对；每条 transition/fence 流式上报
 *      ✗ 判据仍错：`(t-lastAutoAt)>60000` 冷却 + 要求「最近还有新帧」
 *        ⇒ **真冻死时 transition 全停 ⇒ 条件永远为假 ⇒ 再也不上报**（实测踩到）
 *   v3 ✓ 改用 **per-cartridge pending 年龄**（见 ⑤ 节），与「还有没有新帧」无关，可递进重复上报
 *
 *  ★ 抓什么：
 *      ① setTimeout/setInterval 的创建 + 是否触发 + 是否被 clear
 *      ② WebSocket 收发的每一帧；★ 单独跟踪 fence 配对
 *      ③ console.error/warn + unhandledrejection + window.onerror
 *      ④ ★ 停滞判定：某卡带收到 transition 后 >STALL_MS 仍未发 fence ⇒ 自动上报
 *
 *  ★ 安全性：全部 hook try/catch；只读观测、不改游戏状态；上报失败静默；
 *            去掉 index.html 里那一行 script 即完全还原。
 *
 *  手动：`__NORI_DUMP()` 立即上报；`__NORI_FENCE()` 看 fence 配对与 pending。
 */
(function () {
  'use strict';
  if (window.__NORI_FREEZE_PROBE) return;

  const RECV = 'http://127.0.0.1:4180/report';
  const STREAM = 'http://127.0.0.1:4180/stream';
  const now = () => Date.now();
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n || 260);
  const stackOf = (skip) => {
    try {
      return (new Error().stack || '').split('\n')
        .slice(skip || 2, (skip || 2) + 6).map((s) => s.trim()).join(' | ');
    } catch (e) { return ''; }
  };
  const typeOf = (s) => {
    const m = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(String(s || ''));
    return m ? m[1] : '';
  };
  const cartOf = (s) => {
    const m = /"cartridgeId"\s*:\s*"([^"]+)"/.exec(String(s || ''));
    return m ? m[1] : '';
  };
  const verOf = (s) => {
    const m = /"version"\s*:\s*(\d+)/.exec(String(s || ''));
    return m ? Number(m[1]) : null;
  };

  const P = {
    t0: now(), href: location.href,
    timers: [],
    warns: [], errs: [], rej: [], onerr: [],
    ws: { count: 0, inCount: 0, outCount: 0, lastInAt: 0, lastOutAt: 0, inLog: [], outLog: [] },
    // ★ fence 配对：服务端推 head(transition) ⇒ 客户端应回 fence
    fence: {
      lastFenceOutAt: 0, lastFenceOutVersion: null, lastFenceOutCart: null,
      lastTransitionInAt: 0, lastTransitionVer: null, lastTransitionCart: null,
      transitionsInCount: 0, fencesOutCount: 0,
      fencesByCart: {},          // cart -> 累计 fence-out 次数（用来判定哪些卡带"本该发 fence"）
      pending: {},               // ★ cart -> {ver, since, lastReportedAge}「已收到但还没 fence」
      pairs: [],                 // {cart, ver, inAt, outAt, lagMs}
      trace: [],                 // 最近 60 条 transition / fence 事件（带时间、cart、ver）
      stallEpisodes: 0,          // ★ 本次会话累计的"停滞事件"次数
    },
    reports: [],
    lastAutoAt: 0,
  };
  window.__NORI_FREEZE_PROBE = P;

  /* ══════════ ① 定时器 ══════════ */
  try {
    const _st = window.setTimeout, _si = window.setInterval;
    const _ct = window.clearTimeout, _ci = window.clearInterval;
    const byId = new Map();
    window.setTimeout = function (fn, ms) {
      let rec = null;
      try {
        rec = { kind: 'to', ms: ms, at: now(), stack: stackOf(2), fired: false };
        P.timers.push(rec);
        if (P.timers.length > 4000) P.timers.shift();
      } catch (e) {}
      const wrapped = (typeof fn === 'function' && rec) ? function () {
        try { rec.fired = true; rec.firedAt = now(); } catch (e) {}
        return fn.apply(this, arguments);
      } : fn;
      const id = _st.call(this, wrapped, ms);
      try { if (rec) { rec.id = id; byId.set(id, rec); } } catch (e) {}
      return id;
    };
    window.setInterval = function (fn, ms) {
      let rec = null;
      try {
        rec = { kind: 'iv', ms: ms, at: now(), stack: stackOf(2), fired: false, ticks: 0 };
        P.timers.push(rec);
        if (P.timers.length > 4000) P.timers.shift();
      } catch (e) {}
      const wrapped = (typeof fn === 'function' && rec) ? function () {
        try { rec.fired = true; rec.ticks = (rec.ticks || 0) + 1; rec.firedAt = now(); } catch (e) {}
        return fn.apply(this, arguments);
      } : fn;
      const id = _si.call(this, wrapped, ms);
      try { if (rec) { rec.id = id; byId.set(id, rec); } } catch (e) {}
      return id;
    };
    window.clearTimeout = function (id) {
      try { const r = byId.get(id); if (r) { r.cleared = true; r.clearedAt = now(); } } catch (e) {}
      return _ct.call(this, id);
    };
    window.clearInterval = function (id) {
      try { const r = byId.get(id); if (r) { r.cleared = true; r.clearedAt = now(); } } catch (e) {}
      return _ci.call(this, id);
    };
  } catch (e) {}

  /* ══════════ ② WebSocket：收发 + fence 配对 ══════════ */
  function stream(kind, obj) {
    try {
      fetch(STREAM, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ kind: kind, at: new Date().toISOString(), ms: now() }, obj)),
      }).catch(function () {});
    } catch (e) {}
  }
  function onFrameIn(headLen, head) {
    const ty = typeOf(head);
    if (ty === 'runtime_transition') {
      const cart = cartOf(head), ver = verOf(head);
      P.fence.transitionsInCount++;
      P.fence.lastTransitionInAt = now(); P.fence.lastTransitionVer = ver; P.fence.lastTransitionCart = cart;
      // ★ 记录「已收到、尚未 fence」：只更新 ver，**不重置 since**（since=最早那个未 fence 的版本）
      if (cart) {
        const pg = P.fence.pending[cart];
        if (!pg) P.fence.pending[cart] = { ver: ver, since: now(), lastReportedAge: 0, reported: false };
        else if (ver != null && (pg.ver == null || ver > pg.ver)) pg.ver = ver;
      }
      P.fence.trace.push({ t: now(), dir: 'in', ty: ty, cart: cart, ver: ver });
      if (P.fence.trace.length > 60) P.fence.trace.shift();
      stream('transition-in', { cart: cart, ver: ver, len: headLen });
    } else if (ty === 'visibility_fence_advanced') {
      stream('fence-advanced-in', { cart: cartOf(head), ver: verOf(head) });
    }
  }
  function onFrameOut(head) {
    const ty = typeOf(head);
    if (ty === 'advance_visibility_fence') {
      const cart = cartOf(head), ver = verOf(head);
      P.fence.fencesOutCount++;
      P.fence.lastFenceOutAt = now(); P.fence.lastFenceOutVersion = ver; P.fence.lastFenceOutCart = cart;
      if (cart) P.fence.fencesByCart[cart] = (P.fence.fencesByCart[cart] || 0) + 1;
      // ★ 清 pending：fence 的版本 >= 待推进版本 ⇒ 这个卡带追平了
      if (cart && P.fence.pending[cart] && (ver == null || P.fence.pending[cart].ver == null || ver >= P.fence.pending[cart].ver)) {
        const pg = P.fence.pending[cart];
        if (pg.since) {
          P.fence.pairs.push({ cart: cart, ver: ver, outAt: now(), lagMs: now() - pg.since });
          if (P.fence.pairs.length > 60) P.fence.pairs.shift();
        }
        delete P.fence.pending[cart];
      }
      P.fence.trace.push({ t: now(), dir: 'out', ty: ty, cart: cart, ver: ver });
      if (P.fence.trace.length > 60) P.fence.trace.shift();
      stream('fence-out', { cart: cart, ver: ver });
    }
  }
  try {
    const OWS = window.WebSocket;
    if (OWS) {
      function WrappedWS(url, protocols) {
        const ws = (protocols === undefined) ? new OWS(url) : new OWS(url, protocols);
        try {
          P.ws.count++;
          P.ws.url = clip(String(url), 120);
          ws.addEventListener('message', function (ev) {
            try {
              P.ws.inCount++; P.ws.lastInAt = now();
              const d = ev && ev.data;
              const head = typeof d === 'string' ? d : '(binary)';
              P.ws.inLog.push({ at: now(), len: (d && d.length) || 0, head: clip(head, 400) });
              if (P.ws.inLog.length > 400) P.ws.inLog.shift();
              if (typeof d === 'string') onFrameIn(d.length, d);
            } catch (e) {}
          });
          ws.addEventListener('open', function () { try { P.ws.openedAt = now(); P.ws.lastInst = ws; } catch (e) {} });
          ws.addEventListener('close', function () { try { P.ws.closedAt = now(); } catch (e) {} });
          try { P.ws.lastInst = ws; } catch (e) {}
          const _send = ws.send.bind(ws);
          ws.send = function (d) {
            try {
              P.ws.outCount++; P.ws.lastOutAt = now();
              const head = typeof d === 'string' ? d : '(binary)';
              P.ws.outLog.push({ at: now(), head: clip(head, 400) });
              if (P.ws.outLog.length > 400) P.ws.outLog.shift();
              if (typeof d === 'string') onFrameOut(d);
            } catch (e) {}
            return _send(d);
          };
        } catch (e) {}
        return ws;
      }
      WrappedWS.prototype = OWS.prototype;
      try { Object.setPrototypeOf(WrappedWS, OWS); } catch (e) {}
      try { window.WebSocket = WrappedWS; } catch (e) {}
    }
  } catch (e) {}

  /* ══════════ ③ 异常与前端自诊断 ══════════ */
  try {
    window.addEventListener('unhandledrejection', function (e) {
      try {
        const r = e && e.reason;
        const msg = clip((r && (r.message || r)) || '(unknown)', 400);
        P.rej.push({ at: now(), msg: msg, stack: clip(r && r.stack, 600) });
        if (P.rej.length > 60) P.rej.shift();
        stream('unhandled-rejection', { msg: msg });
      } catch (er) {}
    });
    window.addEventListener('error', function (e) {
      try {
        P.onerr.push({ at: now(), msg: clip(e && e.message, 300), src: clip(e && e.filename, 120), line: e && e.lineno });
        if (P.onerr.length > 60) P.onerr.shift();
      } catch (er) {}
    });
    const _ce = console.error, _cw = console.warn;
    console.error = function () {
      try {
        const msg = clip(Array.prototype.map.call(arguments, String).join(' '), 400);
        P.errs.push({ at: now(), msg: msg }); if (P.errs.length > 80) P.errs.shift();
        stream('console-error', { msg: msg });
      } catch (e) {}
      return _ce.apply(console, arguments);
    };
    console.warn = function () {
      try {
        const msg = clip(Array.prototype.map.call(arguments, String).join(' '), 400);
        P.warns.push({ at: now(), msg: msg }); if (P.warns.length > 80) P.warns.shift();
        if (/Watchdog|error|fail|Missing screen/i.test(msg)) stream('console-warn', { msg: msg });
      } catch (e) {}
      return _cw.apply(console, arguments);
    };
  } catch (e) {}

  /* ══════════ ④ 上报 ══════════ */
  function pendingView(t) {
    const out = {};
    for (const c in P.fence.pending) {
      const pg = P.fence.pending[c];
      out[c] = { ver: pg.ver, ageSec: Math.round((t - pg.since) / 1000) };
    }
    return out;
  }
  function snapshot(why, extra) {
    const t = now();
    const unfired = P.timers.filter(function (r) {
      return r.kind === 'to' && !r.fired && !r.cleared && r.ms >= 300 && (t - r.at) > (r.ms + 3000);
    }).slice(-40).map(function (r) {
      return { ms: r.ms, waitedMs: t - r.at, stack: r.stack };
    });
    return {
      why: why, extra: extra || null,
      at: new Date().toISOString(),
      uptimeSec: Math.round((t - P.t0) / 1000),
      ws: {
        count: P.ws.count, url: P.ws.url,
        inCount: P.ws.inCount, outCount: P.ws.outCount,
        inIdleSec: Math.round((t - (P.ws.lastInAt || P.t0)) / 1000),
        outIdleSec: Math.round((t - (P.ws.lastOutAt || P.t0)) / 1000),
        secondsSinceOpen: P.ws.openedAt ? Math.round((t - P.ws.openedAt) / 1000) : null,
      },
      fence: Object.assign({}, P.fence, {
        pending: pendingView(t),
        sinceLastFenceOutSec: P.fence.lastFenceOutAt ? Math.round((t - P.fence.lastFenceOutAt) / 1000) : null,
        sinceLastTransitionInSec: P.fence.lastTransitionInAt ? Math.round((t - P.fence.lastTransitionInAt) / 1000) : null,
        trace: P.fence.trace.slice(-40),
        pairs: P.fence.pairs.slice(-20),
      }),
      recentIn: P.ws.inLog.slice(-40),
      recentOut: P.ws.outLog.slice(-40),
      lastTimers: P.timers.slice(-80),
      unfiredTimers: unfired,
      warnCount: P.warns.length, errCount: P.errs.length, rejCount: P.rej.length, onerrCount: P.onerr.length,
      warns: P.warns.slice(-25), errs: P.errs.slice(-25),
      rej: P.rej.slice(-15), onerr: P.onerr.slice(-15),
    };
  }

  function report(why, extra) {
    const snap = snapshot(why, extra);
    P.reports.push({ at: snap.at, why: why });
    try {
      fetch(RECV, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snap),
      }).then(function () { P.sentOk = (P.sentOk || 0) + 1; }).catch(function () { P.sentFail = (P.sentFail || 0) + 1; });
    } catch (e) { P.sentFail = (P.sentFail || 0) + 1; }
    return snap;
  }
  window.__NORI_DUMP = function () { return report('manual'); };

  /* ══════════ ★ 实验性修复：补发缺失的 advance_visibility_fence ══════════
   *  背景：实测链条**已跑完**（定时器全触发）却仍不发 fence ⇒ 怀疑被前端
   *  `e <= this.visibleVersion` 守卫跳过、或走到了一条不发的分支。
   *  本函数**绕过前端**，直接用当前 WebSocket 把那一帧补发出去。
   *
   *  两种结果都有价值：
   *    · 解冻 ⇒ 坐实"就是缺这一帧" ⇒ 可做成常驻自动补发（真正修复）
   *    · 仍冻 ⇒ 卡点在更下游 ⇒ 停手，回落 F5 兜底
   *
   *  只读安全：只在**你手动调用**时发一帧；不 auto 发；刷新即回滚。
   */
  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0, v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }
  window.__NORI_RESEND = function (cart) {
    const ws = P.ws.lastInst;
    if (!ws || ws.readyState !== 1) { console.warn('[NORI-FREEZE] 没有可用的 WebSocket'); return 'no-ws'; }
    const targets = [];
    if (cart) targets.push({ cart: cart, ver: (P.fence.pending[cart] || {}).ver });
    else for (const c in P.fence.pending) targets.push({ cart: c, ver: P.fence.pending[c].ver });
    if (!targets.length) { console.warn('[NORI-FREEZE] 没有 pending 的卡带'); return 'no-pending'; }
    const sent = [];
    for (const t of targets) {
      if (t.ver == null) continue;
      const frame = {
        type: 'advance_visibility_fence',
        cartridgeId: t.cart,
        visibilityFenceId: 'ui',
        version: t.ver,
        requestId: uuid(),
      };
      try {
        ws.send(JSON.stringify(frame));
        sent.push(t.cart + ' v' + t.ver);
        stream('fence-resend-out', { cart: t.cart, ver: t.ver });
      } catch (e) { console.warn('[NORI-FREEZE] 补发失败', e && e.message); }
    }
    console.warn('[NORI-FREEZE] ★ 已手动补发 fence：' + (sent.join('、') || '（无）')
      + '。看游戏是否解冻，然后打 __NORI_FENCE() 确认 pending 是否清掉。');
    return sent;
  };

  window.__NORI_FENCE = function () {
    const f = P.fence, t = now();
    const rows = {};
    for (const c in f.pending) rows['pending:' + c] = 'v' + f.pending[c].ver + '  已 ' + Math.round((t - f.pending[c].since) / 1000) + 's 未 fence';
    console.table(Object.assign({
      收transition次数: f.transitionsInCount,
      发fence次数: f.fencesOutCount,
      按卡带: JSON.stringify(f.fencesByCart),
      最近transition: (f.lastTransitionCart || '-') + ' v' + f.lastTransitionVer,
      最近fence: (f.lastFenceOutCart || '-') + ' v' + f.lastFenceOutVersion,
      '距上次fence(秒)': f.lastFenceOutAt ? Math.round((t - f.lastFenceOutAt) / 1000) : null,
      停滞次数: f.stallEpisodes,
      自动重载开关: autoreloadOn() ? '开' : '关',
      自动重载次数: f.reloadCount || 0,
    }, rows));
    console.log('[NORI-FREEZE] trace（最近 40 条）', f.trace.slice(-40));
    return f;
  };

  /* ══════════ ★ 自动重载（可选，默认关）══════════
   *  背景：补发 fence 的实验**已证无效** —— 实测服务端**早已发出** fence-advanced
   *        （22:09:48.310），客户端仍冻住 ⇒ 阻塞点在**客户端内部**，我们够不到。
   *  结论：不从我们这层修。改用**已验证有效的兜底**：用户实测 **F5 即可恢复**。
   *  ⇒ 停滞时**自动重载页面**（等效 F5），把"永久冻住"变成"2 秒自愈"。
   *
   *  开关：`__NORI_SET_AUTORELOAD(true)` / `(false)`（写入 localStorage，刷新后仍生效）
   *  保护：同一段停滞只触发 1 次；全局最小间隔 25 秒（防重载风暴）；默认【关】。
   */
  function autoreloadOn() {
    try {
      if (window.__NORI_AUTORELOAD === true) return true;
      if (window.__NORI_AUTORELOAD === false) return false;
      return localStorage.getItem('nori_autoreload') === '1';
    } catch (e) { return false; }
  }
  window.__NORI_SET_AUTORELOAD = function (v) {
    try { localStorage.setItem('nori_autoreload', v ? '1' : '0'); } catch (e) {}
    window.__NORI_AUTORELOAD = !!v;
    console.warn('[NORI-FREEZE] 自动重载 = ' + (v ? '开' : '关') + '（已持久化）');
    return !!v;
  };
  function maybeReload(cart, ver, age) {
    if (!autoreloadOn()) return false;
    let last = 0;
    try { last = Number(sessionStorage.getItem('nori_last_reload') || 0); } catch (e) {}
    if (Date.now() - last < 25000) return false;          // 防重载风暴
    try { sessionStorage.setItem('nori_last_reload', String(Date.now())); } catch (e) {}
    P.fence.reloadCount = (P.fence.reloadCount || 0) + 1;
    stream('auto-reload', { cart: cart, ver: ver, ageSec: age, n: P.fence.reloadCount });
    console.warn('[NORI-FREEZE] ★ 停滞 ' + age + 's ⇒ 自动重载页面以恢复（等效 F5）');
    try { location.reload(); } catch (e) {}
    return true;
  }

  /* ══════════ ⑤ 停滞判定（v3：per-cartridge pending 年龄）══════════
   *  v2 的两个致命缺陷（实测踩到）：
   *    ✗ `(t - lastAutoAt) > 60000` 60 秒冷却 ⇒ 真卡死（发生在上报后 6 秒）被压掉
   *    ✗ `(t - lastTransitionInAt) < FREEZE_MS` 要求"最近还有新帧"
   *      ⇒ 一旦彻底冻死（transition 全停）这个条件**永远为假** ⇒ **再也不会上报**
   *      ⇒ 恰好把最该报的"完全冻死"排除了
   *  v3 改用 **per-cartridge pending 年龄**：
   *    · 收到 transition 且该卡带尚未 fence ⇒ 记 pending（只更新 ver，**不重置 since**）
   *    · fence 到齐 ⇒ 清 pending
   *    · pending.since 的年龄超阈值 ⇒ 上报（**与"还有没有新帧"无关**）
   *    · 递进上报：8s / +20s / +20s…；恢复后再停滞会重新报 ⇒ 不再漏报
   *  只对"本该发 fence 的卡带"判定（曾发过 fence，或名为 cakeduel），避免 chat 误报。
   */
  const STALL_MS = 8000;            // pending 年龄超过它 ⇒ 判定停滞
  const REPEAT_STEP_MS = 20000;     // 同一段停滞里，年龄每增长这么多再报一次
  const CART_WHITELIST = { cakeduel: true };
  function isFenceCart(cart) {
    return !!cart && (CART_WHITELIST[cart] || (P.fence.fencesByCart[cart] || 0) > 0);
  }
  try {
    setInterval(function () {
      try {
        const t = now();
        for (const cart in P.fence.pending) {
          const pg = P.fence.pending[cart];
          if (!isFenceCart(cart)) continue;                 // 不管不 fence 的卡带
          const age = t - pg.since;
          if (age < STALL_MS) continue;                     // 还在正常范围内（实测正常 lag 最长 ~4.5s）
          // ★ 首次只受 STALL_MS 约束；之后每再涨 REPEAT_STEP_MS 才重复上报
          if (pg.reported && (age - pg.lastReportedAge) < REPEAT_STEP_MS) continue;
          pg.reported = true;
          pg.lastReportedAge = age;
          P.fence.stallEpisodes++;
          P.lastAutoAt = t;
          const sec = Math.round(age / 1000);
          console.warn('[NORI-FREEZE] ★ 卡带 ' + cart + ' 已 ' + sec + 's 未推进 fence（v' + pg.ver
            + '）⇒ 停滞，自动上报第 ' + P.fence.stallEpisodes + ' 次');
          stream('fence-stall', { cart: cart, ver: pg.ver, ageSec: sec, episode: P.fence.stallEpisodes });
          report('auto-fence-stall', { cart: cart, ver: pg.ver, pendingAgeMs: age, episode: P.fence.stallEpisodes });
          // ★ 可选兜底：自动重载（默认关；__NORI_SET_AUTORELOAD(true) 打开）
          if (autoreloadOn() && !pg.reloadTried) {
            pg.reloadTried = true;
            if (maybeReload(cart, pg.ver, sec)) return;      // 挺继续循环（反正要重载了）
          }
        }
      } catch (e) {}
    }, 2000);
  } catch (e) {}

  console.log('[NORI-FREEZE] 探针已装：停滞检测（某卡带收到 transition 后 >' + (STALL_MS / 1000)
    + 's 未发 fence ⇒ 自动上报，与"还有没有新帧"无关）'
    + '；手动 __NORI_DUMP() / __NORI_FENCE()；兜底开关 __NORI_SET_AUTORELOAD(true)');
})();
