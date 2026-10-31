/* nori-game-voice.js — UNOFFICIAL local shim (added by QClaw)
 *
 * 游戏窗口里 Nori 的台词：**语音**（走本地反代 /nori-tts -> Qwen）。
 * 数据来自本地反代 4173 的 /nori-line（每 ~700ms 轮询取一次她刚说的话）。
 * 她的话由「人格代理 + 游戏接管层」生成，不是官方后端发的。
 * 还原方法：删掉 index.html 里引用本文件的那一行即可，本文件可留可删。
 *
 * ══ ★ 2026-10-02（C3 补）：SPEAK 由 false 改回 **true** ══
 *
 * 为什么改（这是"旧决策的前提失效"）：
 *   原注释写「语音交给原版聊天通道出（她的台词是走 chat 卡带生成的，那里自带声音）」
 *   —— 那个前提建立在「我们用玩家身份注入战报 ⇒ 唤醒人格 ⇒ 人格回复走 chat 卡带里
 *   带原生语音的管线」。**C3 已停用战报注入**（§89 的 P-c，`NORI_COMMENT_INJECT=off`），
 *   ⇒ 人格不再被游戏唤醒 ⇒ **游戏里的台词失去原生语音**。
 *   而她的游戏台词现在来自**本地 brain**（走 `agentMessage` → 原版气泡），
 *   这条通道**后端不合成音频** ⇒ 打开 SPEAK 是我们自己的第二条（也是唯一）语音路径。
 *
 * 轮询项的三个来源（★ 过滤规则就在 `poll()` 里，改动前先读那段注释）：
 *   `from:'game'` 且 `ui` 假   ⇒ **她的台词** ⇒ 配音 ✅
 *   `ui:true`                 ⇒ 界面播报（「提示：「出游」，3 个。」）⇒ **跳过**（不是她说的）
 *   `from:'chat'`             ⇒ 人格的话，原生通道已出声 ⇒ **跳过**（避免双声）
 *
 * ══ ★ 2026-10-02（口型修复）：让游戏里的嘴跟着我们的语音动 ══
 *   症状：游戏里 TTS 有声，但 L2D 的嘴不动；桌面正常。
 *   原因：桌面语音走原版的 `pcm-player-processor`（AudioWorklet），它**自己算振幅**并
 *        持续上报；本 shim 用自己的 AudioContext + BufferSource 播放，**绕过了那个 worklet**
 *        ⇒ 没人上报振幅 ⇒ L2D 的 lipSync 读到恒 0 ⇒ 嘴闭着。
 *   修法：包一层 AudioWorkletNode 抓住那个节点，接管其**主线程** port.onmessage，
 *        把持续上报的 `amplitude` 值换成我们边播边测的 RMS。
 *   ★ **完全不碰音频路径** —— 只改写一条消息里的一个数字。详见下方注释。
 *
 * ══ ★★ 2026-10-03（语音编排模块）：本 shim 的**新职责** ══
 *   "逐句发布"改由代理侧模块负责（`nori-speech/`）。本 shim 只做两件**新增**的事：
 *     ① **播出回报** —— 播完一句 ⇒ `POST /nori-spoken {qid, qpart}`
 *        这是模块"放下一句"的**唯一时钟**：它不猜时长，只在收到本条后才推进。
 *     ② **预取** —— 模块随每句给了 `qnext`（下一句文本）⇒ 本 shim 在
 *        前台播这一句时，后台把下一句音频取好并缓存 ⇒ 句间几乎没有空档。
 *   播放 / 口型 / 三条过滤规则**一律不变**。
 *   ★ 已删除：B-215 的 `makeProgressReporter`（按字数估算"露到第几块"）——
 *     那套随"逐句发布"一起退役（现在每句独立成条，不需要进度换算）。
 *
 * ══ ★★ 2026-10-17（接进原生语音链）：台词与 LLM 对话同一条声道 ══
 *   症状：游戏台词（本 shim 出）和 LLM 对话（原版管线出）听感不同，像两个人。
 *   原因：本 shim 用**自己的 AudioContext → destination** 直出，绕过游戏混音器；
 *         LLM 对话走 worklet → corruptionFx → (panner) → voice 轨道（空间化/轨道
 *         音量/效果都在那条链上）⇒ 同一个音色、两条链路，听感自然不同。
 *   修法（零侵入，不改 bundle）：部署 bundle 的 SpeechTrack.connectWorklet() 里有
 *         this.workletNode.connect(this.corruptionFx.input)
 *         ⇒ 包一层 AudioNode.prototype.connect，认出 source === speechNode 的那次
 *         connect，把目标（corruptionFx.input = 原生语音链入口）记下来；
 *         播放时把 BufferSource 接到它 ⇒ 台词与 LLM 对话走**同一条链**。
 *   ★ 故意**不走** worklet 端口投喂（bundle 自带 playBuffer/postChunk 那条路）：
 *     那会带出 block_started/block_finished 事件，operationId 对不上，
 *     会污染聊天气泡的揭示状态机。接音频节点是纯路由，零状态副作用。
 *   ★ 口型机制不变：analyser 测 RMS → ampTap 改写 worklet 振幅消息（照旧）。
 *   ★ 拿不到入口 / 原版 ctx 没在跑 ⇒ 自动退回原来的直出路径（与旧版一致）。
 */
(function () {
  if (window.__noriGameVoice) return;
  window.__noriGameVoice = true;

  var POLL_MS = 700;      // 取话间隔（★ 这是"最长等多久"的上限，见 kickPoll 的注释）
  var SHOW_MS = 9000;     // 气泡停留时间
  // 原版聊天框/原生气泡现在自己能显示她的台词了（走 chat 卡带 → 原生气泡），
  // 这里默认不再显示自研浮动气泡，避免和原版重叠（2026-09-25 用户反馈）。
  // 想恢复自研气泡：把 SHOW 改成 true。
  var SHOW = false;
  // ★ 2026-10-02（C3 补）：**打开语音** —— 游戏台词的唯一发声路径（详见文件头）。
  var SPEAK = true;
  var EMOTION_COLOR = {
    happy: 'rgba(122,226,180,.55)', excited: 'rgba(255,214,120,.6)',
    sad: 'rgba(130,170,235,.55)', angry: 'rgba(255,130,130,.55)',
    fearful: 'rgba(180,150,255,.55)', disgusted: 'rgba(180,200,120,.5)',
    surprised: 'rgba(255,180,240,.6)', doubtful: 'rgba(150,200,255,.5)',
    dizzy: 'rgba(200,180,255,.5)', serious: 'rgba(200,220,240,.5)',
    neutral: 'rgba(120,200,255,.4)'
  };

  var queue = [], playing = false, root = null, ctx = null, lastId = 0;

  /* ══════════════ ★ 2026-10-02：L2D 口型（lip sync）驱动 ══════════════
   *
   * 为什么需要（读原版 bundle 得到的完整链路）：
   *   原版音频中枢 `Lt` 的语音模块用 `pcm-player-processor` 这个 AudioWorklet 播放
   *   后端流式 PCM。**该 worklet 自己算振幅**，且**持续上报**（每 3 个 process 量子一次）：
   *       if (frameCount % 3 === 0) port.postMessage({ type:'amplitude', value: RMS })
   *   主线程收到后写进 `speech.amplitudeRef.current`；而 L2D 的 lipSync 模块
   *       iR({ getAmplitude: () => Lt.speech.getAmplitude() })
   *   挂在**包裹整个应用**的舞台 `j8e` 上（桌面和游戏是**同一个** L2D）
   *   ⇒ `getAmplitude() = min(1, RMS × 14)` 就是 `ParamMouthOpenY` 的输入。
   *
   * 我们怎么做：
   *   ① 在应用初始化**之前**包一层 `AudioWorkletNode`，只抓住名为
   *      `pcm-player-processor` 的那个节点（其余 worklet 原样放过）；
   *   ② 应用给它赋过 `port.onmessage` 之后，接管那个处理器：
   *      **振幅消息**的 `value` 换成我们实测的 RMS，**其余消息一律原样透传**
   *      （block_started / block_finished / tts_complete / diag 都不动 ⇒ 零副作用）；
   *   ③ 我们播放时 `ampValue` 是数字 ⇒ 每一条振幅消息都被改写 ⇒ 嘴跟着我们动；
   *      不播放时 `ampValue = null` ⇒ 透传原版的值（空闲时为 0）⇒ 她的嘴恢复原状。
   *
   * ★ 为什么不走别的路：
   *   · `speech.setSimulatedRawAmplitude()` 才是设计好的注入位，但它是 **ESM 导出**
   *     （`bnt as dF`，React hook），普通 `<script>` 拿不到，原版也没暴露成全局。
   *   · 直接把 PCM 塞进 worklet 不可行：worklet 只播「带 messageId+blockId 的块」，
   *     伪造这些 id 会触发 block_started/finished ⇒ 给服务端发 audioStarted/audioDone，
   *     那是协议副作用（明确不碰）。
   *   · 本方案只改一条消息里的一个数字 ⇒ 可随时失效、零风险。
   */
  var speechNode = null, ampTap = null, ampOrig = null, ampValue = null;

  /* ★★ 2026-10-03：**纯观测**（不改任何行为）—— 用于定位"游戏里嘴不动"。
   *   为什么需要：`state()` 原来只给 `{node,tapped,amp}`，信息不足 ——
   *   `tapped:true` 只能说明"我们装过 tap"，**不能说明**：
   *     ① tap 现在**还在不在位**（应用若重新 init，`port.onmessage` 会被换成新的原版 handler）
   *     ② worklet **到底有没有在发** amplitude 消息（节点若不活跃，我们就无从改写）
   *     ③ 我们**改写了多少条**（= 实际生效次数）
   *   ⇒ 这四项能一次性把"是没消息 / 没改写 / 没振幅 / 原版侧不看"区分开。 */
  var obs = {
    plays: 0,        // speak() 进入次数
    anOk: 0,         // analyser 创建成功次数
    anFail: 0,       // analyser 创建失败次数（会退回"无口型"路径）
    ticks: 0,        // rAF 计量回调总次数
    ampMsgs: 0,      // ★ worklet 发来的 amplitude 消息**总条数**
    ampRewrites: 0,  // ★ 其中被我们**改写**的条数（ampValue != null 时）
    ampPeak: 0,      // 历史最大 RMS
    ampPeakCur: 0,   // 本条播放期间最大 RMS
    tickCur: 0,      // ★ 本条播放期间的 tick 数（0 而 playing=true ⇒ tick 没跑）
    ampNZ: 0,        // ★ 测到**有效振幅**（>0.005）的 tick 次数 —— 区分"写的都是 0"与"根本没写"
    tickErr: 0,      // tick 里抛错次数（抛错 ⇒ 设不到 ampValue）
    lastTickAt: 0,   // ★ 最近一次 tick 的时刻（state() 里换算成 lastTickAgoMs）
    ampForced: 0,    // forceAmp 生效次数（调试实验用）
    /* ★★ 关键判据（用于钉死"carrier 死掉"这个假设）：
     *   `ampMsgsCur` = 本条播放期间 worklet 发来的消息数。
     *   若播放中它 ≈ 0 ⇒ **worklet 已停**（很可能 `Lt.init` 失败过 ⇒ `cleanup()` 关掉了 ctx
     *   ⇒ 我们抓到的 `speechNode` 成了**死节点**）⇒ 我们的改写无处落地 ⇒ 嘴不动。
     *   而 `node/tapped/live` 三个标志**都还是 true**（指向的是那个死对象）—— 这正是观测盲区。 */
    ampMsgsCur: 0,   // ★ 本条播放期间的 worklet 消息数
    rewriteCur: 0,   // ★ 本条播放期间成功改写的条数
    /* ★★★ 2026-10-03：**最可能的真凶** —— 原版 AudioContext 被挂起。
     *   为什么它能解释全部现象：
     *     · 我们的 TTS 用**自己 new 的** AudioContext ⇒ 独立 ⇒ **照响**
     *     · 表情/呼吸走 rAF ⇒ 不依赖音频 ⇒ **正常**
     *     · 只有口型 **搭原版 worklet 的消息流** ⇒ ctx 一挂起 worklet 就停
     *       ⇒ 我们的改写无处落地 ⇒ **只有嘴不动**
     *     · Chrome 会在音频空闲时**自动挂起 AudioContext**，而原版的恢复挂在
     *       **用户手势**上（`installAutoUnlock`）⇒ 取决于你棋局中间有没有点/按 ⇒ **表现成"随机"**
     *   ⇒ 观测这三个字段：播放开始/进行时原版 ctx 是什么状态、我们恢复过几次。 */
    origCtxState: '',      // ★ 最近一次读到的**原版 ctx** 状态（running / suspended / closed）
    origCtxResumed: 0,     // ★ 我们替原版 ctx 恢复过几次（suspended ⇒ resume）
    origCtxAfter: '',      // ★ resume 之后的状态（验证恢复是否成功）
    origCtxNoHandle: 0,    // 拿不到原版 ctx 的次数
    lastDur: 0,      // 最近一次 audio.duration
    lastWdMs: 0,     // 最近一次看门狗时长
    /* ★ 2026-10-17：原生语音链路由观测 */
    voiceInCaptured: 0,  // voiceIn 被捕获/更新的次数（connectWorklet 重连也会计）
    voiceNative: 0,      // 走原生链播放的次数（corruptionFx.input）
    voiceFallback: 0,    // 退回自己 ctx 直出的次数
    pfPrefetch: 0,       // ★ 2026-10-17：跨条预取发出的条数（should ≈ 摸头次数 × 2）
  };

  /* ══════════ ★★★ 原版 AudioContext 的句柄 + 「挂起即恢复」══════════
   * 句柄从哪来：`AudioWorkletNode` 实例自带 `.context` —— 我们包装构造函数时
   *   已经拿到了那个节点，顺手把它的 ctx 记下来即可（零侵入，不碰任何原版逻辑）。
   *
   * 为什么要恢复：我们的口型信号**必须搭原版 worklet 的消息流**才能送达
   *   （我们改写的是它的 `port.onmessage` 里的 amplitude 值）。
   *   而 Chrome 会在音频空闲时自动 suspend 那个 ctx ⇒ worklet 停 ⇒ 信号送不出去。
   *   原版自己的恢复只挂在**用户手势**上 ⇒ 你不动鼠标/键盘，它就一直是挂着的。
   *
   * ★ 这条恢复**只做一件事**：把 `suspended` 的原版 ctx 恢复成 `running`。
   *   不新建、不改参数、不动音频路径；`closed`（已被销毁）时不做任何尝试。
   * ⚠ 若将来原版有意挂起（`intentionallySuspended`，当前**无调用点**），
   *   可把 `RESUME_ORIG_CTX` 置 false 关掉这条行为。 */
  var origCtx = null, RESUME_ORIG_CTX = true;

  function ensureOrigCtxRunning() {
    if (!origCtx) { obs.origCtxNoHandle++; return 'no-handle'; }
    var st;
    try { st = origCtx.state; } catch (e) { return 'err'; }
    obs.origCtxState = st;
    if (st === 'running') return 'running';
    if (st !== 'suspended') return st;              // closed 等 ⇒ 不做任何尝试
    if (!RESUME_ORIG_CTX) return 'suspended(off)';
    obs.origCtxResumed++;
    try {
      var p = origCtx.resume();                     // ★ 唯一的行为改动
      if (p && p.then) p.then(function () { try { obs.origCtxAfter = origCtx.state; } catch (e) {} }).catch(function () { obs.origCtxAfter = 'reject'; });
    } catch (e) { obs.origCtxAfter = 'throw'; }
    return 'resuming';
  }

  /* ★ 调试用：强制振幅。用来**直接判定"我们的改写有没有被原版消费"** ——
   *   若 forceAmp(0.9) 能让嘴大幅张开 ⇒ 改写链路是通的，问题在"我们没写出值"；
   *   若嘴纹丝不动 ⇒ 值被别的东西覆盖（如 simulatedRawAmplitude），另查。 */
  var forceVal = null, forceTimer = 0;
  function forceAmp(v, ms) {
    if (forceTimer) { try { clearTimeout(forceTimer); } catch (e) {} forceTimer = 0; }
    if (v === null || v === undefined) { forceVal = null; return 'forceAmp off'; }
    forceVal = Math.max(0, Math.min(1, Number(v) || 0));
    forceTimer = setTimeout(function () { forceVal = null; forceTimer = 0; }, ms || 3000);
    return 'forceAmp ' + forceVal + ' @ ' + (ms || 3000) + 'ms';
  }
  function ampLive() {
    try { return !!(speechNode && speechNode.port && ampTap && speechNode.port.onmessage === ampTap); }
    catch (e) { return false; }
  }

  (function captureSpeechWorklet() {
    var Orig = window.AudioWorkletNode;
    if (!Orig) return;
    var Wrapped = function (c, name, opts) {
      var n = new Orig(c, name, opts);
      try {
        if (String(name) === 'pcm-player-processor') {
          speechNode = n;
          /* ★ 顺手记下**原版音频上下文**：`AudioWorkletNode.context` 就是它。
           *   （参数 `c` 也可用，但 `.context` 是节点自己的真身，更可靠。） */
          origCtx = (n && n.context) || c || null;
        }
      } catch (e) {}
      return n;
    };
    Wrapped.prototype = Orig.prototype;                 // 保住 instanceof
    try { Object.setPrototypeOf(Wrapped, Orig); } catch (e) {}
    try { window.AudioWorkletNode = Wrapped; } catch (e) {}
  })();

  /* ══════════ ★ 2026-10-17：捕获原生语音链入口（corruptionFx.input） ══════════
   * 部署 bundle（NormalApp-*.js）的 SpeechTrack.connectWorklet() 里：
   *     this.workletNode.connect(this.corruptionFx.input)
   * workletNode 就是上面抓到的 speechNode ⇒ 包一层 AudioNode.prototype.connect，
   * 认出 source === speechNode 的那次 connect，把它的目标记为 voiceIn。
   * 这正是 LLM 对话音频的必经入口（下游：corruptionFx → panner → voice 轨道）。
   * · connectWorklet 可能重跑（重连）⇒ 每次都刷新 voiceIn（目标变了才计数）。
   * · 包的是 prototype 方法，所有音频节点共用 —— 只加一个身份判断，开销可忽略。
   * · 拿不到 ⇒ voiceIn 保持 null ⇒ speak() 自动走旧的直出路径。 */
  var voiceIn = null, voiceInAt = 0, voiceForceDirect = false;
  (function captureVoiceEntry() {
    if (!window.AudioNode || !AudioNode.prototype || typeof AudioNode.prototype.connect !== 'function') return;
    var OrigConnect = AudioNode.prototype.connect;
    var WrappedConnect = function (dest) {
      try {
        if (voiceIn !== dest && speechNode && this === speechNode && dest) {
          voiceIn = dest; voiceInAt = Date.now();
          obs.voiceInCaptured++;
        }
      } catch (e) {}
      return OrigConnect.apply(this, arguments);
    };
    try {
      Object.defineProperty(AudioNode.prototype, 'connect',
        { value: WrappedConnect, writable: true, configurable: true });
    } catch (e) {}
  })();

  /* 接管振幅。必须等应用 init（它给 port.onmessage 赋过值）之后才能装；
   * 装不上的话每轮 poll 会再试（见 poll 末尾）。 */
  function ensureAmpTap() {
    if (!speechNode) return false;
    var port = speechNode.port;
    if (!port) return false;
    if (port.onmessage === ampTap && ampTap) return true;   // 已接管
    var cur = port.onmessage;
    if (typeof cur !== 'function') return false;            // 应用还没 init
    ampOrig = cur;                                          // 记住原版处理器（应用若换过就重记）
    ampTap = function (ev) {
      try {
        var d = ev && ev.data;
        if (d && d.type === 'amplitude') {
          obs.ampMsgs++; obs.ampMsgsCur++;                  // ★ 观测：worklet 有没有在发
          if (forceVal !== null && ampValue === null) { d.value = forceVal; obs.ampForced++; }
          else if (ampValue !== null) { d.value = ampValue; obs.ampRewrites++; obs.rewriteCur++; }   // ★ 行为不变
        }
      } catch (e) {}
      return ampOrig.call(port, ev);                        // 其余原样透传
    };
    port.onmessage = ampTap;
    console.log('[nori-game-voice] 已接管语音振幅 → L2D 口型');
    return true;
  }

  function rootEl() {
    if (root && document.body && document.body.contains(root)) return root;
    if (!document.body) return null;
    root = document.createElement('div');
    root.id = 'nori-game-voice-root';
    root.style.cssText = 'position:fixed;right:18px;bottom:72px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none;';
    document.body.appendChild(root);
    return root;
  }

  function showBubble(text, emotion) {
    var box = rootEl(); if (!box) return null;
    var b = document.createElement('div');
    b.style.cssText = [
      'max-width:min(46vw,380px)', 'white-space:pre-wrap', 'word-break:break-word',
      'background:rgba(11,19,36,.93)', 'border:1px solid ' + (EMOTION_COLOR[emotion] || EMOTION_COLOR.neutral),
      'border-radius:14px', 'padding:10px 14px', 'color:#e3f2ff', 'font-size:14px', 'line-height:1.6',
      'box-shadow:0 10px 30px rgba(0,0,0,.5)', 'backdrop-filter:blur(6px)',
      'transition:opacity .3s ease, transform .3s ease', 'opacity:0', 'transform:translateY(8px)'
    ].join(';');
    var nm = document.createElement('div');
    nm.textContent = 'Nori';
    nm.style.cssText = 'font-size:11px;letter-spacing:.12em;color:#7fd2ff;margin-bottom:4px;opacity:.85';
    var tx = document.createElement('div');
    tx.textContent = String(text || '');
    b.appendChild(nm); b.appendChild(tx);
    box.appendChild(b);
    requestAnimationFrame(function () { b.style.opacity = '1'; b.style.transform = 'translateY(0)'; });
    var hide = function () {
      b.style.opacity = '0'; b.style.transform = 'translateY(6px)';
      setTimeout(function () { try { b.remove(); } catch (e) {} }, 400);
    };
    setTimeout(hide, SHOW_MS);
    return b;
  }

  function audioCtx() {
    if (!ctx) { var C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  /* ══════════════ ★ 2026-10-03：编排模块的「播出回报」+「预取」 ══════════════
   *
   * 【播出回报 —— 这是"逐句"的唯一时钟】
   *   代理侧编排模块**一次只放一句**，且**上一句播完才放下一句**。
   *   它怎么知道"播完了"？—— **不知道，是这里主动告诉它**：
   *       本文件播完一句 ⇒ POST /nori-spoken { qid, qpart } ⇒ 模块推进 ⇒ 放下一句
   *   ★ `qpart` 必须带上：万一模块那边超时兜底抢先推进了，这条迟到的回报
   *     会被它识别为 stale 丢弃（否则会多跳一句、内容丢失）。
   *   ★ 四种结局**都要回报**（成功 / 播放启动失败 / 取音频失败 / 没有 AudioContext），
   *     否则模块只能干等超时 ⇒ 体验变慢（而超时兜底本该只是"保险"）。
   */
  function reportSpoken(item, skipWhy) {
    if (!item || !item.qid || item.__reported) return;   // 幂等：每条只报一次
    item.__reported = true;
    /* ★★ 2026-10-30：`skipWhy` = 这句**我不会播**（ui 播报 / chat 原生已出声 / id 过旧）。
     *   以前这三种情况直接 `continue`，等于"取走了但不回报" ⇒ 队列只能等 9~12s 兜底
     *   （实测 106/712 ≈ 15% 的条目是这么白等的）。带上 skip 让队列**立刻**推进。 */
    var body = { qid: item.qid, qpart: item.qpart };
    if (skipWhy) body.skip = skipWhy;
    try {
      fetch('/nori-spoken', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function () {
        /* ★★ 关键：**代理处理完这条回报时，已经把下一句放进 `/nori-line` 了**
         *   （模块收到回报 ⇒ advance ⇒ pump ⇒ emit ⇒ pushGameLineRaw）
         *   ⇒ 此刻立刻补拉一次，**不必再等下一轮轮询**。
         *   实测：原来"上一句播完 → 下一句开口"要等 ~350ms（最坏 700ms）——
         *   用户原话"会在上一句说完后等了一会才说第二句"，就是这一段。
         *   ⚠ 必须放在**这个 then 里**（/nori-spoken 已返回）才有效；
         *     放在 onended 里会跑在代理处理之前 ⇒ 拉到空 ⇒ 白等一轮。 */
        kickPoll();
      }).catch(function () {});
    } catch (e) {}
  }

  /* ══════════════ ★ 2026-10-03：预取（让句间几乎没有空档） ══════════════
   * 实测：单句**合成**耗时 1.2~1.4s，而**播放**时长 2.4~4.0s ⇒ 播放 > 合成
   * ⇒ 在"前台播这一句"的时间里，完全来得及把**下一句**取好。
   * 模块会把下一句文本随本句一起发来（`item.qnext`），这里就顺手取回来缓存。
   *
   * ★ 缓存的是**解码后的 AudioBuffer**，不是 ArrayBuffer —— 因为
   *   `decodeAudioData` 会 **detach** 传入的 ArrayBuffer，缓存原始字节会导致
   *   第二次解码失败（同一个 key 只能解一次）。AudioBuffer 可以反复播放。
   * ★ 用 Promise 做缓存 ⇒ 并发请求同一个 key 只会真正发一次。
   */
  var audioCache = {}, CACHE_MAX = 24;

  function getAudio(text) {
    var c = audioCtx(); if (!c) return Promise.reject(new Error('no AudioContext'));
    var key = String(text == null ? '' : text);
    var hit = audioCache[key];
    if (hit) return hit;
    var p = fetch('/nori-tts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: key })
    }).then(function (r) {
      if (!r.ok) throw new Error('tts http ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      if (buf.byteLength < 200) throw new Error('tts empty');
      return c.decodeAudioData(buf);
    });
    audioCache[key] = p;
    /* 失败**不留在缓存里** —— 否则这个 key 会被一个失败的 Promise 永久毒住 */
    p.catch(function () { try { delete audioCache[key]; } catch (e) {} });
    var keys = Object.keys(audioCache);
    while (keys.length > CACHE_MAX) { try { delete audioCache[keys.shift()]; } catch (e) {} }
    return p;
  }

  /* 后台预取下一句（失败了无所谓：真播到它时会重新取一次） */
  function prefetch(text) {
    if (!text) return;
    try { getAudio(text).catch(function () {}); } catch (e) {}
  }

  /* ══════════ ★★ 2026-10-17：台词真流式（边收 PCM 边播） ══════════
   * 为什么：`/tts`（WAV）要收完整段、回填 RIFF 长度才能发第一个字节
   *   （实测 首字节 1617.4ms ≈ 收完 1617.7ms）⇒ 首声响 = 整段合成；
   *   同一句话走 `/tts.stream`（裸 PCM@32k）首块只要 0.6~1.3s。
   * 做法：把 PCM16 切成 AudioBuffer，依次排在 ctx 时间轴上播；所有块共用一个
   *   analyser → voiceIn ⇒ 口型与声道跟整段路径完全一致。
   * 失败语义：**吐过音频** ⇒ 正常收尾（不重播）；**一块都没吐** ⇒ 返回 false，
   *   调用方退回整段路径（宁可慢，不可哑）。
   * 开关：`window.__NORI_BEAT_STREAM = 'off'`（刷新后生效）。
   */
  var STREAM_URL = '/nori-tts?stream=1';
  var STREAM_RATE = 32000;
  var STREAM_ON = !/^(off|0|no|false)$/i.test(String(window.__NORI_BEAT_STREAM == null ? 'on' : window.__NORI_BEAT_STREAM));

  /* ══════════ ★★ 2026-10-30（第三轮）：**流式总开关**（持久化）══════════
   * 背景：Inworld 现在"合成慢于播放"（5s 音频要 6~11s，连打后到 20~28s），
   *   流式无论怎么调都会断。用户要求：**先全部走整段**，等供应商恢复再切回。
   *
   * 三档（存 localStorage，刷新后仍有效）：
   *   'off'  一直整段（默认，当前策略）—— 慢 1~4s，但绝对不断
   *   'on'   一直流式 —— 供应商正常时用它
   *   'auto' 自适应 —— 卡了自动降级、好了自动恢复（10-30 前两轮做的逻辑）
   *
   * 切换（控制台，立即生效，无需刷新）：
   *   NoriGameVoice.streamMode('on')     // 回流式
   *   NoriGameVoice.streamMode('auto')   // 自适应
   *   NoriGameVoice.streamMode('off')    // 全整段
   */
  var STREAM_MODE_KEY = 'nori.streamMode';
  var STREAM_MODE = (function () {
    var m = '';
    try { m = String(localStorage.getItem(STREAM_MODE_KEY) || '').toLowerCase(); } catch (e) {}
    if (m !== 'on' && m !== 'off' && m !== 'auto') {
      /* 没有存过 ⇒ 兼容老的 `__NORI_BEAT_STREAM`；都没有就按当前策略：整段 */
      m = window.__NORI_BEAT_STREAM == null ? 'off' : (STREAM_ON ? 'auto' : 'off');
    }
    return m;
  })();
  function setStreamMode(m) {
    m = String(m || '').toLowerCase();
    if (m !== 'on' && m !== 'off' && m !== 'auto') return STREAM_MODE;
    STREAM_MODE = m;
    try { localStorage.setItem(STREAM_MODE_KEY, m); } catch (e) {}
    return STREAM_MODE;
  }
  /* 这句是否允许走流式（唯一判定入口） */
  function streamAllowed(len) {
    if (STREAM_MODE === 'off') return false;
    if (STREAM_MODE === 'on') return STREAM_ON;
    return STREAM_ON && !streamUnfit(len);      // auto：自适应
  }

  /* ══════════ ★★ 2026-10-30：流式**自适应降级** ══════════
   * 背景：Inworld 今日实测"合成慢于播放"（5s 音频要 6~11s 才收完，连打后到 20~28s）
   *   ⇒ 边收边播必然断音。前端排程没问题（数据在 SDK 出口就已经晚了）。
   *
   * 判据：`push()` 里如果算出的落点 `t` 明显晚于 `nextAt`（= 上一块放完了这一块还没到），
   *   就是**欠载**。连续 `STREAM_STREAK` 次（且每次 > `STREAM_MIN_MS`）⇒ 判定"现在流不动了"，
   *   接下来 `STREAM_DEGRADE_MS` 内的句子**改走整段合成**（慢 1~2s，但绝不中断）。
   *   窗口过后自动再试流式 —— 供应商恢复就自己回到流式，不需要刷新。
   *
   * 开关：`window.__NORI_STREAM_DEGRADE_MS`（默认 60000，0 = 永不降级）
   *      `window.__NORI_STREAM_DEGRADE_MIN`（单次欠载阈值，默认 80ms）
   */
  var STREAM_MIN_MS = Number(window.__NORI_STREAM_DEGRADE_MIN || 80);
  var STREAM_DEGRADE_MS = (function () {
    var v = window.__NORI_STREAM_DEGRADE_MS;
    return (v == null) ? 60000 : Math.max(0, Number(v) || 0);
  })();
  /* ★★ 2026-10-30（第二轮）：**长句单独判**
   *   实测：短句（≤12 字）两三个块就到齐，流式没问题；长句 8~10 个块，
   *   供应商只要慢一点就**必断**（块数越多越没救）。
   *   ⇒ 一旦出现过降级，阈值以上的句子**直接走整段**，不再试探；
   *     只有"长句也流得干净"时才算真恢复（把 hits 清零）。 */
  var STREAM_LONG_CHARS = Number(window.__NORI_STREAM_LONG_CHARS || 20);
  var STREAM_RETRY_REMEMBER_MS = 600000;      // 10 分钟内记得"长句流不动"
  var STREAM_STREAK = 2;
  var degrade = { until: 0, underruns: 0, streak: 0, lastMs: 0, hits: 0, lastHitAt: 0 };

  function noteUnderrun(ms) {
    if (!(ms > 0) || ms < STREAM_MIN_MS) return;
    degrade.underruns++;
    degrade.lastMs = Math.round(ms);
    degrade.streak++;
    if (degrade.streak >= STREAM_STREAK && STREAM_DEGRADE_MS > 0) {
      degrade.hits++;
      degrade.lastHitAt = Date.now();
      /* 退避：1 分钟 → 2 → 4 → 最多 10 分钟（别每 60s 就让玩家再听一次卡顿） */
      var win = Math.min(STREAM_RETRY_REMEMBER_MS, STREAM_DEGRADE_MS * Math.pow(2, degrade.hits - 1));
      degrade.until = Date.now() + win;
      degrade.streak = 0;
    }
  }
  function degradedNow() { return STREAM_DEGRADE_MS > 0 && Date.now() < degrade.until; }
  /* 这句能不能用流式：短句可以试；长句在"最近流不动过"的窗口内直接判不合用 */
  function streamUnfit(len) {
    if (degradedNow()) return true;
    if (len >= STREAM_LONG_CHARS && degrade.hits > 0 &&
        (Date.now() - degrade.lastHitAt) < STREAM_RETRY_REMEMBER_MS) return true;
    return false;
  }

  function speakStream(item, c, nativeRoute) {
    return new Promise(function (res) {
      var an = null, f32 = null, raf = 0, wd = 0, finished = false;
      var dest = (nativeRoute && voiceIn) ? voiceIn : null;
      try {
        an = c.createAnalyser(); an.fftSize = 512; f32 = new Float32Array(an.fftSize);
        try { an.connect(dest || c.destination); } catch (e6) { dest = null; an.connect(c.destination); }
      } catch (e) { an = null; }
      if (an) { obs.anOk++; } else { obs.anFail++; }

      function stopMeter() {
        if (raf) { try { cancelAnimationFrame(raf); } catch (e2) {} raf = 0; }
        if (wd) { try { clearTimeout(wd); } catch (e2) {} wd = 0; }
        ampValue = null;                       // ★ 交还原版 ⇒ 空闲时嘴自然闭合
      }
      var _u0 = degrade.underruns;             // ★ 本句开始时的欠载计数（用于"这句很顺"时清零连击）
      function finish() {                      // 正常收尾（播完 / 超时兜底）
        if (finished) return;
        finished = true;
        /* 这一句全程没欠载 ⇒ 连击清零（避免"很久以前抖过两次"一直压着降级）
         * ★ 更硬的恢复信号：**长句也流得干净** ⇒ 认为供应商缓过来了，把 hits 也清零
         *   （短句干净不算数 —— 短句本来就容易过）。 */
        if (degrade.underruns === _u0) {
          degrade.streak = 0;
          if (String((item && item.text) || '').length >= STREAM_LONG_CHARS) {
            degrade.hits = 0;
            degrade.until = 0;
          }
        }
        stopMeter(); reportSpoken(item); res(true);
      }
      function bail() {                        // 一块都没出声 ⇒ 交给调用方退回整段
        if (finished) return;
        finished = true;
        stopMeter(); res(false);
      }

      var nextAt = 0, live = 0, got = 0, streamDone = false, leftover = null;

      function push(pcm) {
        if (!pcm || !pcm.length) return;
        var firstChunk = (got === 0);
        got += pcm.length;
        var buf, src, t;
        try {
          buf = c.createBuffer(1, pcm.length, STREAM_RATE);
          var ch = buf.getChannelData(0);
          for (var i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
          src = c.createBufferSource();
          src.buffer = buf;
          src.connect(an || dest || c.destination);
          t = Math.max(nextAt, c.currentTime + 0.06);   // 60ms 起步余量，避免"排到过去"
          /* ★ 欠载判据：该排的位置已经过去了 ⇒ 上一块放完、这一块才到 ⇒ 中间必有静音。
           *   首块不算（nextAt=0，本来就该从"现在"开始）。 */
          if (!firstChunk && t > nextAt + 0.005) noteUnderrun((t - nextAt) * 1000);
          src.start(t);
        } catch (e) { return; }
        nextAt = t + pcm.length / STREAM_RATE;          // ★ 时长按 **PCM 自己的采样率** 算
        live++;
        src.onended = function () { live--; if (streamDone && live <= 0) finish(); };
      }

      if (an) {
        ensureAmpTap();
        var tick = function () {
          if (!ampTap) ensureAmpTap();
          try {
            an.getFloatTimeDomainData(f32);
            var s = 0;
            for (var i = 0; i < f32.length; i++) s += f32[i] * f32[i];
            ampValue = Math.min(1, Math.sqrt(s / f32.length));
            obs.ticks++; obs.tickCur++; obs.lastTickAt = Date.now();
            if (ampValue > 0.005) obs.ampNZ++;
            if (ampValue > obs.ampPeakCur) obs.ampPeakCur = ampValue;
            if (ampValue > obs.ampPeak) obs.ampPeak = ampValue;
            ensureOrigCtxRunning();
          } catch (e3) { obs.tickErr = (obs.tickErr || 0) + 1; }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }
      /* 看门狗：流卡住时也不能让嘴卡住 / 队列永久堵住 */
      wd = setTimeout(function () { if (got > 0) finish(); else bail(); }, 25000);

      /* ★★ 2026-10-30：**流式路径也要做 `pf` 跨条预取**。
       *   原来 `pf` 只写在 `speakBuffered()` 里（那里音频已在手里 ⇒ 开播即取不抢并发）。
       *   台词改走流式后，**首次触发的句子都走本函数** ⇒ `pf` 从来没被预取过
       *   （实测：`pfPrefetch` 只在缓存命中的那条分支才增长）。
       *   时机：等**最后一块收完**（本句合成结束、TTS 槽位空出来）再取 ——
       *     此时播放还剩大半段，正好当预取窗口，又不会和本句抢并发。 */
      var pfFired = false;
      function prefetchPf() {
        if (pfFired) return;
        pfFired = true;
        if (!SPEAK || !item || !item.pf || !item.pf.length) return;
        obs.pfPrefetch += item.pf.length;
        for (var pi = 0; pi < item.pf.length; pi++) prefetch(item.pf[pi]);
      }

      var text = String((item && item.text) || '');
      fetch(STREAM_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text })
      }).then(function (r) {
        if (!r.ok) throw new Error('stream http ' + r.status);
        if (!r.body || typeof r.body.getReader !== 'function') throw new Error('no stream body');
        var reader = r.body.getReader();
        function pump() {
          return reader.read().then(function (v) {
            if (v.done) {
              streamDone = true;
              prefetchPf();                       // ★ 合成结束、槽位空出 ⇒ 现在做跨条预取
              if (live <= 0) finish();
              return;
            }
            var u8 = v.value || new Uint8Array(0);
            var b = u8;
            if (leftover && leftover.length) {
              b = new Uint8Array(leftover.length + u8.length);
              b.set(leftover, 0); b.set(u8, leftover.length);
            }
            leftover = null;
            if (b.length & 1) { leftover = b.slice(b.length - 1); b = b.slice(0, b.length - 1); }
            if (b.length) push(new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1));
            return pump();
          });
        }
        return pump();
      }).catch(function (e) {
        console.warn('[nori-game-voice] 流式失败:', e && e.message);
        if (got > 0) { streamDone = true; if (live <= 0) finish(); return; }
        bail();
      });
    });
  }

  function speak(item) {
    obs.plays++; obs.ampPeakCur = 0; obs.tickCur = 0;      // ★ 观测（行为不变）
    obs.ampMsgsCur = 0; obs.rewriteCur = 0;                // ★ 本条播放的 carrier 覆盖度
    /* ★★★ 播放前先确保**原版 ctx 在跑** —— 我们改写的 value 要落到它的 amplitudeRef 上，
     *   必须搭它的 worklet 消息流；ctx 一挂起 worklet 就停，信号就送不出去（嘴不动）。 */
    ensureOrigCtxRunning();
    /* ★★ 2026-10-17：优先走**游戏原生语音链** —— voiceIn（corruptionFx.input）拿得到
     *   且原版 ctx 在跑 ⇒ 用**原版 ctx** 播（BufferSource 接 voiceIn）⇒ 台词与 LLM
     *   对话走同一条 corruptionFx → panner → voice 轨道，听感一致。
     *   拿不到 / 没在跑 ⇒ 退回自己的 ctx 直出（与旧版行为完全一致）。
     *   （getAudio 解码进自己 ctx 的 AudioBuffer 可以跨 ctx 赋给原版 ctx 的
     *     BufferSource —— 采样率不同时浏览器自动重采样，无需重解。） */
    var c = null, nativeRoute = false;
    if (voiceIn && origCtx && !voiceForceDirect) {
      ensureOrigCtxRunning();
      if (origCtx.state === 'running') { c = origCtx; nativeRoute = true; }
    }
    if (!c) c = audioCtx();
    if (nativeRoute) obs.voiceNative++; else obs.voiceFallback++;
    /* ★ 没有 AudioContext ⇒ 也要回报，否则模块干等超时 */
    if (!c) { reportSpoken(item); return Promise.reject(new Error('no AudioContext')); }
    /* ★★ 2026-10-17：**缓存命中 ⇒ 走整段**（预取已备好，瞬间出声）；
     *   否则优先**真流式**（首块 0.6~1.3s，而整段 WAV 要等全部合成完）。
     * ★★ 2026-10-30：如果刚判定"流不动"（连续欠载）⇒ **临时改走整段**，
     *   等 `degrade.until` 过期再自动试回流式。见上方 noteUnderrun 的说明。 */
    var _text = String((item && item.text) || '');
    if (!audioCache[_text] && streamAllowed(_text.length)) {
      return speakStream(item, c, nativeRoute).then(function (okPlayed) {
        if (okPlayed) return true;
        console.warn('[nori-game-voice] 流式未出声 ⇒ 退回整段');
        return speakBuffered(item, c, nativeRoute);
      });
    }
    return speakBuffered(item, c, nativeRoute);
  }

  /* 整段路径（**原实现，逻辑未改**）：取整段 WAV → decodeAudioData → 一个 BufferSource 播完 */
  function speakBuffered(item, c, nativeRoute) {
    /* ★ 走 getAudio ⇒ 优先命中**预取缓存**（`qnext` 已提前取好）⇒ 句间几乎没有空档 */
    return getAudio(item && item.text).then(function (audio) {
      return new Promise(function (res) {
        var src = c.createBufferSource();
        src.buffer = audio;
        /* ★ 口型：输出串一个 analyser，边播边测 RMS 喂给上面的振幅接管。
         *   RMS 口径与原版 worklet **完全一致**：sqrt(Σx²/n)，0..1。
         *   analyser 是透传节点，音频不变。 */
        var an = null, f32 = null, raf = 0, wd = 0;
        /* ★ 2026-10-17：原生链时把 analyser 接到 voiceIn（corruptionFx.input），
         *   而不是 c.destination —— 音频走到游戏混音器的 voice 轨道。
         *   ★ 双重兜底：voiceIn 若已失效（SpeechTrack 重建过）connect 会抛，
         *     此时改接 destination，至少还有声（只是回到旧听感）。 */
        var dest = (nativeRoute && voiceIn) ? voiceIn : null;
        try {
          an = c.createAnalyser(); an.fftSize = 512; f32 = new Float32Array(an.fftSize);
          src.connect(an);
          try { an.connect(dest || c.destination); }
          catch (e6) { dest = null; an.connect(c.destination); }
        } catch (e) { an = null; }
        if (an) { obs.anOk++; } else { obs.anFail++; }    // ★ 观测
        if (!an) {                                      // 兜底：退回原路径（只是没口型）
          try { src.connect(dest || c.destination); }
          catch (e7) { try { src.connect(c.destination); } catch (e8) {} }
        }
        var stopMeter = function () {
          if (raf) { try { cancelAnimationFrame(raf); } catch (e2) {} raf = 0; }
          if (wd) { try { clearTimeout(wd); } catch (e2) {} wd = 0; }
          ampValue = null;                              // ★ 交还原版 ⇒ 空闲时嘴自然闭合
        };
        if (an) {
          ensureAmpTap();                               // 早装一次（应用通常已 init）
          var tick = function () {
            if (!ampTap) ensureAmpTap();                // 应用 init 可能更晚，持续补
            try {
              an.getFloatTimeDomainData(f32);
              var s = 0;
              for (var i = 0; i < f32.length; i++) s += f32[i] * f32[i];
              ampValue = Math.min(1, Math.sqrt(s / f32.length));
              obs.ticks++; obs.tickCur++; obs.lastTickAt = Date.now();   // ★ 观测
              if (ampValue > 0.005) obs.ampNZ++;                        // ★ 有效振幅计数
              if (ampValue > obs.ampPeakCur) obs.ampPeakCur = ampValue;
              if (ampValue > obs.ampPeak) obs.ampPeak = ampValue;
              /* ★ 每帧都盯（只是读一个属性，成本可忽略）：
               *   Chrome 可能在音频空闲时把原版 ctx 挂起，那样 worklet 会停、
               *   我们的改写就送不出去（而 TTS 照响 ⇒ 只剩嘴不动）。
               *   实测发现"播放中 worklet 的消息数"只有连续运行时的 ~38%，
               *   像是 ctx 在**快速开关** ⇒ 必须每帧采样才抓得住（原来每 30 帧太粗）。 */
              ensureOrigCtxRunning();
            } catch (e3) { obs.tickErr = (obs.tickErr || 0) + 1; }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        }
        /* ★ 看门狗：万一 onended 没触发（上下文被挂起/被中断），也必须把 ampValue 交还，
         *   否则嘴会「卡在张开」。只清口型信号，不改播放语义。 */
        /* ★ 观测：把 duration / 看门狗时长记下来（**计算式与原实现完全一致**）。
         *   WAV 头是**流式占位**（≈2GB），实测 Chrome 不采信它、按实际数据得 3.28s ⇒ 目前正常。
         *   但记下来是有用的：万一将来换 TTS 后 duration 变成 Infinity，
         *   `setTimeout(fn, Infinity)` 会被 ToInt32 转成 0 ⇒ 立即 stopMeter ⇒ 嘴不动。 */
        if (an) {
          obs.lastDur = (audio && audio.duration) || 0;
          obs.lastWdMs = Math.max(3000, ((audio && audio.duration) || 4) * 1000 + 1500);
          wd = setTimeout(stopMeter, obs.lastWdMs);
        }
        /* ★★ 播完 = "可以放下一句了"的唯一信号 ⇒ 必须回报（模块在等它） */
        src.onended = function () { stopMeter(); reportSpoken(item); res(true); };
        try {
          src.start();
          /* ★★ 2026-10-17：`pf` 预取放在**开播瞬间**（不是播完）——
           *   此刻本句的合成早已完成（音频就在手里），TTS 正好空闲 ⇒ 不抢并发；
           *   而播完再取只剩"播放时长"这点余量，长句（23 字≈5.7s）往往来不及。
           *   实测：把预取从播完改到开播，下一句的合成窗口从 ~3s 扩大到 ~9s。 */
          if (SPEAK && item && item.pf && item.pf.length) {
            obs.pfPrefetch += item.pf.length;
            for (var pi2 = 0; pi2 < item.pf.length; pi2++) prefetch(item.pf[pi2]);
          }
        } catch (e) { stopMeter(); reportSpoken(item); res(false); }
      });
    });
  }

  function pump() {
    if (playing || !queue.length) return;
    playing = true;
    var item = queue.shift();
    if (SHOW) showBubble(item.text, item.emotion);
    /* ★ 不开语音 ⇒ 立刻回报：**我们不会播，就永远不会有 onended**
     *   ⇒ 不报的话模块只能白等一次超时，把后面的句子全堵慢。 */
    if (!SPEAK) { reportSpoken(item); playing = false; setTimeout(pump, 200); return; }
    speak(item).catch(function (e) {
      console.warn('[nori-game-voice] tts failed:', e && e.message);
      reportSpoken(item);          // ★ 取音频 / 解码失败也要回报（幂等，成功路径已报过则跳过）
    }).then(function () {
      playing = false;
      /* ★ `pf` 预取已移到 speak() 的"开播瞬间"（见那里的注释）——
       *   那里 TTS 已空闲且离下一次触发更远。这里不再重复。 */
      setTimeout(pump, 120);
    });
  }

  /* ══════════════ ★ 2026-10-03：轮询调度（可被"踢一脚"） ══════════════
   * 为什么需要：轮询是**固定间隔**的，所以"下一句已经就绪了"这件事，
   *   前端最多要等 POLL_MS 才知道。用户能感觉到这个停顿。
   * ⇒ 把定时器**存起来**，允许在"确定有新内容"时**取消等待、立刻拉一次**。
   * ★ `kickPoll()` 只在"刚收到 /nori-spoken 的成功响应"时调用 ——
   *   那一刻代理**一定**已经把下一句放好了 ⇒ 这次拉**必定**有收获，不打空枪。
   *   （这是它比"单纯把 POLL_MS 调小"更好的地方：不在空闲时增加请求。） */
  var pollTimer = 0, polling = false;
  function schedulePoll(ms) {
    if (pollTimer) { try { clearTimeout(pollTimer); } catch (e) {} pollTimer = 0; }
    pollTimer = setTimeout(poll, ms);
  }
  /* 踢一脚 = 取消等待、立刻拉一次。
   * ★ 若此刻已有一次轮询在飞（`polling`），**不并发** —— 直接返回，
   *   否则两个 /nori-line 会交错消费同一条破坏性队列（`splice` 取走）。
   *   丢一次 kick 只是回到原来的间隔行为，不会出错。 */
  function kickPoll() { if (polling) return; schedulePoll(0); }

  function poll() {
    if (polling) return;
    polling = true;
    fetch('/nori-line', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var list = (j && j.lines) || [];
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it || !it.text) continue;
        /* ★ 2026-10-30：三种"取走但不播"的情况必须**回报 skip**，否则队列干等超时 */
        var skipWhy = null;
        if (it.id && it.id <= lastId) skipWhy = 'stale-id';   // 去重（重启后 id 复位时最容易命中）
        if (it.id) lastId = it.id;
        /* ★★ 2026-10-02（C3 补）：**只对她的台词发声** —— 三条过滤都必须留
         *   `/nori-line` 返回的是 **全部** `GAME_LINES`（不过滤），里面有三种东西：
         *     ① `ui:true`     界面播报（「提示：「出游」，3 个。」「轮到你给提示了。」）
         *                     —— 不是她说的 ⇒ **配音会让玩家听见 Nori 念机械串**（很怪）
         *     ② `from:'chat'` 人格的话（原生聊天通道已为它出声）⇒ 配音 = **双声**
         *     ③ 其余          = 本地 brain 的台词（`from:'game'`）⇒ ★ **这才是要配音的**
         *   ⚠ `lastId` 必须在过滤**之前**推进，否则同一项会被反复取出（队列空转）。 */
        if (!skipWhy && it.ui === true) skipWhy = 'ui';
        if (!skipWhy && it.from === 'chat') skipWhy = 'chat';
        if (skipWhy) { reportSpoken(it, skipWhy); continue; }
        queue.push(it);
        /* ★ 预取：编排模块随本句一起给了下一句文本（`qnext`）
         *   ⇒ 趁"前台正在播这一句"的时间，后台把下一句的音频取好
         *   ⇒ 实测播放 2.4~4.0s > 合成 1.2~1.4s，所以取完还富余。 */
        if (SPEAK && it.qnext) prefetch(it.qnext);
      }
      pump();
      ensureAmpTap();   // ★ 应用 init 可能晚于首轮轮询：每轮补装一次（已装则是空操作）
    }).catch(function () {}).then(function () { polling = false; schedulePoll(POLL_MS); });
  }

  // 首次交互时解锁音频
  ['pointerdown', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function once() {
      audioCtx();
      window.removeEventListener(ev, once);
    }, { once: true });
  });

  /* ══════════ ★★★ 手势 ⇒ 顺手把**原版 ctx** 也恢复一下 ══════════
   * 为什么必须挂手势：Chrome 的 `AudioContext.resume()` 在**没有用户手势**时会被拒绝。
   *   原版自己也只把恢复挂在手势上（`installAutoUnlock`，事件列表 pointerdown/up、
   *   touchend、keydown、click）⇒ 这正是"嘴时好时坏"的来源：
   *   **你棋局中间点过鼠标就会好，一直不动就一直不好。**
   * 我们这条监听**不是** `once` —— 因为 ctx 每次被挂起后，都需要新的手势才能恢复。
   * 成本：每次点击只读一次 `ctx.state`（running 时立即 return），可忽略。 */
  ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'].forEach(function (ev) {
    try { window.addEventListener(ev, function () { ensureOrigCtxRunning(); }, { passive: true }); } catch (e) {}
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { schedulePoll(800); });
  else schedulePoll(800);

  // 调试入口
  window.NoriGameVoice = {
    say: function (text, emotion) { queue.push({ text: text, emotion: emotion || 'neutral' }); pump(); },
    state: function () {
      return { queue: queue.length, playing: playing, lastId: lastId, speak: SPEAK, show: SHOW,
        cache: Object.keys(audioCache).length,
        mouth: {
          node: !!speechNode,
          tapped: !!ampTap,
          live: ampLive(),                  // ★ tap 现在**还在不在位**（应用重 init 会换掉它）
          amp: ampValue
        },
        /* ★ 2026-10-17：台词走哪条声道（排查"听感不一样"就看这里）
         *   in=true    已捕获原生链入口（corruptionFx.input）
         *   native/fallback 累计次数：native>0 表示台词已接进游戏混音器 */
        voice: {
          in: !!voiceIn,
          capturedAt: voiceInAt,
          mode: voiceForceDirect ? 'direct(forced)' : (voiceIn ? 'native' : 'native(unready→fallback)'),
          native: obs.voiceNative,
          fallback: obs.voiceFallback,
          captured: obs.voiceInCaptured,
          pfPrefetch: obs.pfPrefetch      // ★ 跨条预取发出条数（摸头场景 ≈ 次数 × 2）
        },
        obs: (function () {
          var o = Object.assign({}, obs);
          o.lastTickAgoMs = obs.lastTickAt ? (Date.now() - obs.lastTickAt) : -1;
          delete o.lastTickAt;
          try { o.ctxState = (ctx && ctx.state) || 'none'; } catch (e) { o.ctxState = 'err'; }
          /* ★ 原版 ctx 的**实时**状态（不是"最近读到"的那个） —— 排查时最想看的就这个 */
          try { o.origCtxNow = origCtx ? origCtx.state : 'no-handle'; } catch (e) { o.origCtxNow = 'err'; }
          /* ★ 2026-10-30：流式降级观测 —— 卡顿时看这三个数就够 */
          o.underruns = degrade.underruns;          // 欠载次数（>0 说明流没跟上播放）
          o.underrunLastMs = degrade.lastMs;
          o.degradeHits = degrade.hits;             // 触发降级的次数
          o.degraded = degradedNow();               // 当前是否处于"改走整段"窗口
          o.degradedForMs = degradedNow() ? (degrade.until - Date.now()) : 0;
          o.longChars = STREAM_LONG_CHARS;         // 长句阈值（超过就算"长句"）
          o.degradeHitsAll = degrade.hits;         // 累计触发次数（恢复会清零）
          o.lastHitAgoMs = degrade.lastHitAt ? (Date.now() - degrade.lastHitAt) : -1;
          o.streamMode = STREAM_MODE;              // off(全整段) / on(全流式) / auto(自适应)
          return o;
        })() };
    },
    forceAmp: forceAmp,
    /* ★ 2026-10-17：原生语音链路由（排查/应急用）
     *   'native'  强制走游戏混音器（未捕获到入口时仍会退直出）
     *   'direct'  强制退回旧的直出路径（听感旧版、但免受链路变动影响）
     *   无参     查询当前状态 */
    voiceRoute: function (mode) {
      if (mode === 'direct') { voiceForceDirect = true; return 'direct (forced)'; }
      if (mode === 'native') { voiceForceDirect = false; return voiceIn ? 'native (ready)' : 'native (not captured yet → fallback)'; }
      return voiceForceDirect ? 'direct (forced)' : (voiceIn ? 'native' : 'native (not captured yet → fallback)');
    },
    /* ★ 手动确保原版 ctx 在跑（排查/应急用）：返回读到的状态 */
    resumeOrigCtx: function () { return ensureOrigCtxRunning(); },
    /* ★★ 2026-10-30：流式总开关（持久化到 localStorage，刷新后仍生效）
     *   streamMode()        查询
     *   streamMode('off')   全走整段（当前策略：Inworld 太慢）
     *   streamMode('on')    全走流式（供应商恢复后）
     *   streamMode('auto')  自适应（卡了降级、好了恢复） */
    streamMode: function (m) { return (m == null) ? STREAM_MODE : setStreamMode(m); },
    obsReset: function () { for (var k in obs) { if (typeof obs[k] === 'number') obs[k] = 0; } return true; }
  };
})();
