'use strict';
/*
 * nori-hub/extract.js —— S1 提取 + S2 分类（帧 → 内容单元）
 * ==========================================================================
 * 职责（§86 §3.2 的核心模型）
 *   ① 抽取：把一帧**枚举**成若干「内容单元」（ContentUnit）
 *   ② 分类：给每个单元贴上 kind
 *
 * ★★★ 本文件最重要的设计原则：**枚举全部路径，绝不只取"主路径"**
 *   为什么（T4 的血泪）：战报同时出现在 3 条路径上
 *       · `patches[/lines]`   ⇒ 我们堵住了（trimLines）
 *       · `transition.cmd`    ⇒ ❌ 完全没处理（实测 7→7 直通）
 *       · `transition.events` ⇒ ❌ 也没处理（实测 7→7 直通）
 *   结论：**"协议自带的多路径数据结构，必须枚举全部路径逐条过滤。只堵一条 ≠ 堵住。"**
 *   ⇒ 所以本文件的 extract 必须把**所有**能承载内容的路径都产出为单元，
 *     让策略表对每一条独立决策。**漏一条 = 漏一个洞。**
 *
 * 铁律
 *   1. **纯函数** —— 不改传入的帧（只读）
 *   2. **只读 `type`/`transition`/`cartridgeId` 等已知字段**，不做猜测
 *   3. 结构化字段原样带出（`payload`），供 E4 投递时渲染
 */

const { isReport } = require('./policy');

/* ── 帧类型 → 方向（谁能写 lines 的路径表，见 §86 §1.2）─────────────────── */
const LINE_CMDS = new Set(['playerMessage', 'agentMessage', 'ingestBlock', 'audioStarted', 'audioDone', 'setPresentationMode']);
const LINE_EVENTS = new Set(['player_message', 'agent_message']);

/* ── 能写 lines 的 7 条路径（§86 §1.2 逆向结论，用作覆盖度自检）────────── */
const LINE_PATHS = [
  'patch./lines',
  'cmd.playerMessage',
  'cmd.agentMessage',
  'cmd.ingestBlock',
  'cmd.audioStarted',
  'cmd.audioDone',
  'events.player_message',
  'events.agent_message',
];

/* ── 游戏卡带（与 nori-lifecycle 的白名单一致）──────────────────────────── */
const GAME_CARTS = new Set(['codenames', 'chess', 'cakeduel', 'pictionary']);

/* ── 帧**自身**就是内容类型（没有 transition）────────────────────────────
 * ★ 2026-10-02 单测抓到的漏：`cartridge_mounted/unmounted`、`world_joined`、`open_media`
 *   这些帧**没有 `transition`**，内容直接在**帧顶层**。
 *   只枚举 patches/cmd/events 会把它们全部漏掉（抽取出 []）——
 *   与 T4「只堵一条路 ≠ 堵住」是**同一类错误**：
 *   路径清单必须包括「帧自身」这一条。
 */
const SELF_CARRY_TYPES = new Set([
  'cartridge_mounted', 'cartridge_mounted_ack',
  'cartridge_unmounted', 'cartridge_unmounted_ack',
  'world_joined', 'world_left',
  'open_media', 'close_media',
  'open_my_web_world',
]);

/* ── 工具 ─────────────────────────────────────────────────────────────── */
const txt = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

/**
 * S2 分类：单元 → kind（★ 只依赖"来源路径 + 内容特征"，不做语义猜测）
 * @param {object} u 半成品单元（from/type/path/cartridgeId/dir/text/...）
 * @returns {string} kind
 */
function classify(u) {
  const dir = u.dir;
  const type = u.type;

  /* ── 生命周期优先（它有独立类型，不与其他混淆）── */
  if (type === 'cartridge_mounted' || type === 'cartridge_unmounted'
    || type === 'cartridge_mounted_ack' || type === 'cartridge_unmounted_ack') return 'game-lifecycle';
  if (type === 'world_joined' || type === 'world_left') return 'game-lifecycle';
  if (type === 'open_media' || type === 'close_media') return 'system-notice';

  /* ── 战报：★ 内容特征优先于"身份" ──
   * 战报伪装成 actor:'player'，所以**不能靠 actor 判断**，必须看内容前缀。
   * （这正是 B-013/B-015 的成因：靠文本前缀猜来源；C 阶段会改成结构化标记） */
  const t = u.text || '';
  if (isReport(t)) return 'game-report';

  /* ── 其余按"路径 + 身份"分 ── */
  if (dir === 'out') {
    // 出站：客户端 → 服务端
    if (type === 'playerMessage') return 'player-speech';
    if (type === 'agentMessage') return 'nori-speech';
    return 'unknown';
  }

  // 入站：服务端 → 客户端
  /* ★ `/lines` 的条目没有自己的 type，身份在 `sender` 上（§86 §1.1） */
  if (type === '/lines') {
    if (u.sender === 'player') return 'player-speech';
    if (u.sender === 'agent') return 'nori-speech';
    if (u.sender === 'chip') return 'system-notice';   // 分析芯片（本地，不进服务端）
    if (u.sender == null) return 'nori-speech';        // ★ 现状：前端把无 sender 的当 nori 渲染
    return 'unknown';
  }
  const isChat = !u.cartridgeId || u.cartridgeId === 'chat';
  if (type === 'player_message' || type === 'playerMessage') return 'player-speech';
  if (type === 'agent_message' || type === 'agentMessage') return 'nori-speech';
  if (type === 'ingestBlock') return 'nori-speech';         // 由 /lines 承载（E1 由 /lines 出）
  if (type === 'audioStarted' || type === 'audioDone' || type === 'setPresentationMode') return 'system-notice';
  if (type === 'guess' || type === 'card_reveal' || type === 'game_start' || type === 'turn_end') return 'game-event';
  /* ★ 2026-10-02 修（`stats.rejected` 非 0）：
   *   原来这里只写 `GAME_CARTS.has(u.cartridgeId)` ⇒ **"只要卡带是游戏卡带，它的一切都算对局事件"**
   *   ⇒ 游戏卡带帧里的**非事件路径**（`from:'patch'` 的任意 path、`from:'self'` 的其它帧）
   *     也被判成 game-event，送进 `nori-splicer` 的渲染表；渲染表只认
   *     `transition.events` 里的类型名 ⇒ 查不到 ⇒ 返回 null ⇒ 计入 `stats.rejected`
   *   ⇒ **覆盖率哨兵被污染**（将来引擎真加新事件时分不清新旧）。
   *
   *   ⚠ 必须**保留 `cmd`**：N1.7-a 刻意让"命令回显"也进 game-event 通道，
   *     再由消费者（`nori-splicer/index.js`）排除并计 `fromCmd` ——
   *     这是"新 cmd 类型告警"的可见性来源（`render_coverage.js` 的接管检查依赖它）。
   *     收窄掉 cmd 会让 fromCmd 恒 0、哨兵变哑（`_t_splicer.js` 已抓到这次回归）。
   *   ⇒ 只收窄到「事件 + 命令回显」，把 patch/self 之类的**非事件路径**请出对局通道。 */
  if ((u.from === 'event' || u.from === 'cmd') && GAME_CARTS.has(u.cartridgeId)) return 'game-event';
  if (!isChat) return 'system-notice';
  return 'unknown';
}

/**
 * S1 提取：一帧 → ContentUnit[]
 * ★ 枚举全部路径（见文件头"最重要的设计原则"）
 * @param {object|string} frame
 * @param {'in'|'out'} dir
 * @returns {Array<object>} ContentUnit[]
 */
function extractUnits(frame, dir) {
  let j = frame;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { return []; } }
  if (!j || typeof j !== 'object') return [];

  const out = [];
  const cid = j.cartridgeId ? String(j.cartridgeId) : '';
  const base = {
    frameType: String(j.type || ''),
    cartridgeId: cid,
    worldId: j.worldId ? String(j.worldId) : '',
    actor: j.actor ? String(j.actor) : null,
    dir,
  };
  const push = (o) => {
    const u = Object.assign({}, base, o);
    u.kind = classify(u);
    out.push(u);
  };

  const tr = j.transition;

  /* ⓪ ★ 帧自身承载内容（生命周期 / 世界 / 媒体）—— 无 transition 的帧会走这里
   *    若不处理，`cartridge_unmounted` 这类帧会被抽成 []（单测抓到的漏） */
  if (SELF_CARRY_TYPES.has(base.frameType) && !tr) {
    push({
      from: 'self', type: base.frameType, writesLines: false,
      text: '',
      payload: j,                       // ★ 整帧作 payload（含 worldId/cartridgeId/runtimes…）
      messageId: j.requestId || null,
    });
  }

  /* ① patches（★ 最隐蔽：op:'replace' 可整数组替换）*/
  if (tr && Array.isArray(tr.patches)) {
    for (const p of tr.patches) {
      if (!p || !p.path) continue;
      if (p.path === '/lines') {
        const arr = Array.isArray(p.value) ? p.value : [];
        // ★ 每个 entry 单独成单元 —— 策略要能逐条决定（现状是整数组一起处理）
        for (let i = 0; i < arr.length; i++) {
          const el = arr[i] || {};
          const content = el.content != null ? el.content : (el.text != null ? el.text : '');
          push({
            from: 'patch', path: '/lines', type: '/lines', index: i,
            sender: el.sender != null ? String(el.sender) : null,
            messageId: el.messageId || el.id || null,
            blockId: el.blockId == null ? null : el.blockId,
            isSpeech: el.isSpeech !== false,
            text: txt(content),
            payload: el,
            writesLines: true,
          });
        }
        // 空数组也要产出一个单元（表示"清空"这个动作），否则会漏掉整帧语义
        if (!arr.length) push({ from: 'patch', path: '/lines', type: '/lines', index: -1, text: '', payload: p, writesLines: true, empty: true });
      } else if (p.path === '/operations') {
        push({ from: 'patch', path: '/operations', type: '/operations', text: '', payload: p, writesLines: false });
      } else {
        push({ from: 'patch', path: p.path, type: p.path, text: '', payload: p, writesLines: false });
      }
    }
  }

  /* ② transition.cmd（★ 单条命令 —— 战报在这条路上直通，T4 发现的洞）*/
  if (tr && tr.cmd && tr.cmd.type) {
    const c = tr.cmd;
    const ct = String(c.type);
    push({
      from: 'cmd', type: ct, writesLines: LINE_CMDS.has(ct),
      messageId: c.messageId || null,
      blockId: c.blockId == null ? null : c.blockId,
      operationId: c.operationId || null,
      isSpeech: c.isSpeech !== false,
      text: txt(c.content != null ? c.content : (c.text != null ? c.text : '')),
      payload: c,
    });
  }

  /* ③ transition.events（★ 数组 —— 战报在这条路上也直通）*/
  if (tr && Array.isArray(tr.events)) {
    for (let i = 0; i < tr.events.length; i++) {
      const ev = tr.events[i];
      if (!ev || !ev.type) continue;
      const et = String(ev.type);
      push({
        from: 'event', type: et, index: i, writesLines: LINE_EVENTS.has(et),
        sender: ev.sender != null ? String(ev.sender) : null,
        messageId: ev.messageId || null,
        blockId: ev.blockId == null ? null : ev.blockId,
        isSpeech: ev.isSpeech !== false,
        text: txt(ev.content != null ? ev.content : (ev.text != null ? ev.text : '')),
        payload: ev,
      });
    }
  }

  /* ④ 出站：客户端命令（玩家真发言 / 我们注入的）*/
  if (dir === 'out' && j.type === 'dispatch' && j.cmd && j.cmd.type) {
    const c = j.cmd;
    push({
      from: 'dispatch', type: String(c.type), writesLines: LINE_CMDS.has(String(c.type)),
      messageId: c.messageId || null,
      text: txt(c.text != null ? c.text : (c.content != null ? c.content : '')),
      payload: c,
    });
  }

  return out;
}

/* ── 覆盖度自检：这一帧走过了哪几条"能写 lines"的路径 ────────────────────
 * 用途：确认我们没有漏路径（T4 的教训）。返回命中的路径键。
 */
function hitLinePaths(units) {
  const hit = new Set();
  for (const u of units) {
    if (u.from === 'patch' && u.path === '/lines') hit.add('patch./lines');
    else if (u.from === 'cmd') { if (LINE_CMDS.has(u.type)) hit.add('cmd.' + u.type); }
    else if (u.from === 'event') { if (LINE_EVENTS.has(u.type)) hit.add('events.' + u.type); }
  }
  return [...hit].sort();
}

module.exports = {
  extractUnits, classify, hitLinePaths,
  LINE_CMDS, LINE_EVENTS, LINE_PATHS, GAME_CARTS,
};
