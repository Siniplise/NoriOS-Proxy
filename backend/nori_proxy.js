// nori_proxy.js — reverse proxy 4173 -> 4174, replaces chat speech PCM with Qwen TTS
// Spec (reverse-engineered from NormalApp bundle):
//   media ws server->client binary frame: outer 8B [0]=ver(=1) [1]=chan(1=chatAudio) [2..3]=u16LE flags(isComplete=1)
//     [4..7]=u32LE seq ; sub 40B [8..11]=u32LE blockId [12..15]=u32LE chunkId [16..31]=16B operationId
//     [32..47]=16B messageId (raw UUID bytes) ; payload = Int16LE mono PCM @ 32000 Hz
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { GameSession, GAME_CARTRIDGES } = require('./nori_game');
const { randomUUID } = require('crypto');
// ★ D1（2026-10-01）：全帧观测 —— 纯只读，只写独立 obs.log，不影响任何行为。NORI_OBS=off 可关。
const OBS = require('./nori-observe');
// ★ A1（2026-10-02）：exe 的 LLM 出口（/v1/*）显式路由 —— 透明转发到人格代理。
//   背景：把 OPENAI_BASE_URL 改到本代理后，/v1/* 若不先拦截会落到「兜底转发 → 4174（exe 自己）」
//   ⇒ **环路**（_arch/89 §8 环路 R1 ★★★）。详见 nori-llm-route.js 头部。
const LLM_ROUTE = require('./nori-llm-route');
// ★ C4/C5（2026-10-02）：游戏生命周期 —— 让她知道你在开/退游戏。
//   只读识别 cartridge_mounted / cartridge_unmounted（后者以前完全没接），
//   由 nori-llm-route.js 在转发前 append 一条 system 消息。具体见 nori-lifecycle.js。
const LIFE = require('./nori-lifecycle');
// ★ D1（2026-10-02）：拼接器（render / PENDING / fold）。
//   代理侧只做「喂帧」（ingest），真正组装在 nori-llm-route.js 转发前调用 buildStateText()。
const SPLICE = require('./nori-splicer');
// ★ B3（2026-10-02）：信息枢纽骨架 —— 策略表 + 抽取/分类 + shadow 比对。
//   默认 **shadow**（跑管线 + 逐字节比对，但**始终发送原帧**）⇒ 零风险。
//   目的：证明"抽取→决策→重组"这条管线是**透明**的，为 C 阶段动帧铺安全网。
//   见 nori-hub/index.js 头部；NORI_HUB=off 可完全关闭。
const HUB = require('./nori-hub');

/* ★★ 2026-10-03：**语音编排模块**（缓冲 → 分段 → 逐句放出 → 等回报）。
 *   见 `nori-speech/index.js` 头部契约；`NORI_SPEECH_Q=off` 可退回"整段发布"。
 *   本模块**零依赖、零供应商知识**（不含 wav/mp3/音色/供应商名字面量）——
 *   TTS 细节一律收敛在 `/nori-tts` 之后，将来换供应商不用碰它。 */
const createSpeechQueue = require('./nori-speech');

/* ★★ 2026-10-07：分析芯片「内容通道」—— contentKey → 被扫对象的**正文**。
 *   纯只读模块（只读世界包 + chip.json，不写状态、不联网）。
 *   依据 _arch/125（官方是让 LLM 读正文，不是固定台词）+ _arch/126 §二（四层模型）。
 *   消费者：本文件的 `chipRoute()`（C2/C3）。
 *   ⚠ 防御式加载：万一模块缺失/语法错，**不能拖垮整个代理** —— 退化为"芯片链路不接管"。 */
let CC = null;
try { CC = require('./nori-chip-content'); }
catch (e) { console.error('[chip] nori-chip-content 加载失败 -> 芯片内容通道停用:', e.message); }

// ---------- 和合医疗后台（concord-clinic.med/admin）本地移植 ----------
// 官方 os.inori.ai 已关站；随包存档只有 `/` 与 `/login`，本地 exe 也未实现
// concord.login.submit ⇒ 按录像 BV1F68V6EErG 0:52:50–0:58:30 复刻后台页并接管登录。
// 内容与出处见 _arch/106_concord_admin_jack_diary.md。
let CS_ADMIN = null;
try {
  CS_ADMIN = require('./cs_admin.js');
  /* ★ 启动即自检：客户端的 page schema 是双重 strict，缺 fonts[].url 之类会
   *   导致「白屏 + 反复重拉」，而日志里只看到 served —— 极具误导性。
   *   这里静态查一遍，把白屏变成启动即告警。 */
  const bad = CS_ADMIN.csSelfCheck();
  const bk = Object.keys(bad);
  if (bk.length) console.warn('[concord] ⚠ page schema 违规 ' + bk.length + ' 页：'
    + bk.slice(0, 3).map((k) => k + ' -> ' + bad[k].join('; ')).join(' | '));
  else console.log('[concord] /admin 页 schema 自检通过（' + CS_ADMIN.CS_URLS.length + ' 页）');
} catch (e) { console.warn('[concord] cs_admin.js 未加载：' + e.message); }

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-04：剧情「固定台词」播放器（代理侧）
 *   计划 _arch/107_script_lines_plan.md　数据 nori_script_lines.json
 *   装配在 `server.listen` 之前（那时 log/FACTS/pushGameLine 都已就绪）。
 * ══════════════════════════════════════════════════════════════════════════ */
let SCRIPT = null;
/* ★ absorbState 期间**静默**：它会把服务端回灌的**历史 fact** 全喂进 addFact。
 *   若此时也触发台词 ⇒ 首次部署会把 S1~S10 全部补放一遍（一次弹十几句）。
 *   ⇒ 用本开关区分「历史回灌」与「真的新发生」。 */
let FACTS_ABSORB_DEPTH = 0;    // 用计数而非布尔：absorbState 会被 absorbDeep 反复调用

// ---------- 游戏台词队列（前端 nori-game-voice.js 轮询取走）----------
const GAME_LINES = [];
const GAME_LINE_MAX = 40;
/* ★★ 2026-10-30（P0 收尾）：**行 id 必须跨进程重启保持单调**。
 *   原来的 `0` 起步有个隐蔽后果：代理重启后 id 从 1 重新开始，而**页面没 F5**
 *   ⇒ shim 里的 `lastId` 还停在旧值（比如 42）⇒ 新行全部命中 `id <= lastId`
 *   被**静默丢弃**（既不出声也不回报）⇒ 队列只能等 9~12 秒兜底。
 *   日志实证：106 次兜底 / 712 次入队，且兜底常成对出现（qid 的两段一起超时）。
 *   ⇒ 用时间戳做起点：任何一次新启动的 id 都远大于上一次进程用过的值。 */
let GAME_LINE_SEQ = Date.now();
// ★ 2026-09-30：由 ws 升级处注入 —— 把她的**游戏内台词**送进**原版 chat 气泡**。
//   官方 chat 卡带本来就有 `agentMessage` 命令（schema：actors:["agent"], text:string），
//   用它写入的 `agent_message` 就是原版那种 Nori 气泡。
//   之前这些台词只进 GAME_LINES → 玩家看到的是自研浮窗（nori-game-voice.js）"自搓的框"。
let AGENT_CHAT_PUSH = null;
/* ★ 2026-10-02（N3 修）：**最后一次"她的台词上屏"的时刻**。
 *   为什么需要：N3 的"静默"判据原来看的是 `LLM_ROUTE.getStats().lastAt` ——
 *   那只统计 `/v1/*`（**exe 的聊天请求**），**看不见 `/game-turn`**（她的棋步/brain 调用）。
 *   而象棋里她几乎每回合都说话（走 `/game-turn` → `pushGameLine`）
 *   ⇒ 于是 N3 可能在她说完的**同一秒**也推一条 ⇒ 玩家一次看到两个气泡。
 *   实测证据（proxy.log 14:56:01）：`RECORD msg_8`（回合台词）与 `RECORD msg_9`（N3）**同一秒**。
 *   ⇒ 记下本时刻，N3 触发前要求"我们自己刚说过的话"也静默够了。 */
let N3_LAST_LINE_AT = 0;

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-03：`pushGameLine` 拆成 **两层**
 *   · `pushGameLineRaw(o)` —— **原实现**：进 GAME_LINES + 原版气泡注入。**只被下面两条路调用**。
 *   · `pushGameLine(o)`    —— **路由**：该"逐句放出"的交给编排模块，其余直通 raw。
 *
 * 为什么要分层：
 *   编排模块要"一次只放一句"，而"放一句"的动作**恰好就是 raw**（同一句既上屏又给语音）。
 *   ⇒ 模块不必知道 GAME_LINES / 注入协议，只回调 `io.emit(text, meta)` ⇒ `raw`。
 *   ⇒ 这也让"喇叭与显示同源"成为**结构性保证**（不是两套计时器碰巧对上）。
 * ══════════════════════════════════════════════════════════════════════════ */
function pushGameLineRaw(o) {
  N3_LAST_LINE_AT = Date.now();      // ★ N3：见上方注释（防"同一秒双气泡"）
  const item = Object.assign({ id: ++GAME_LINE_SEQ, at: Date.now() }, o);
  GAME_LINES.push(item);
  while (GAME_LINES.length > GAME_LINE_MAX) GAME_LINES.shift();
  log('GAME-LINE [' + (o.emotion || '?') + '] ' + JSON.stringify(String(o.text || '').replace(/\n/g, ' / ')));
  // ★ 2026-10-03：原来这里还有 noriChatPush（进已删除的自研面板队列）—— 随死代码一并移除
  // ★ 再送一份进**原版气泡**。注意两点：
  //   ① `from==='chat'` 的行本来就是从 chat 隧道抓来的，已在原版气泡里，再推会重复 ⇒ 排除；
  //   ② `ui:true` 的行是**界面播报**（如「提示：「XX」，2 个。」），不是她说的台词 ⇒ 排除
  //      （实测反馈：这类机械串出现在气泡里"感觉有点怪"；游戏界面本来就会显示提示词）。
  if (o && o.text && o.from !== 'chat' && !o.ui && AGENT_CHAT_PUSH) {
    try { AGENT_CHAT_PUSH(String(o.text)); } catch (e) { log('AGENTCHAT err ' + e.message); }
  }
}

/* 编排模块实例（io 全为闭包回调，模块本身零依赖）。
 * ★ `split` 注入 `bubblesFor` 真身 ⇒ **分段口径全栈唯一**，不会两处实现漂移。 */
const SPEECH_Q = createSpeechQueue({
  log: (m) => log(m),
  split: (t) => bubblesFor(t),
  emit: (text, meta) => {
    /* 放出一句 = 上屏一句（注入原版气泡 + 进 GAME_LINES 供 shim 语音）。
     * `qnext` 是**预取提示**：shim 前台播这一句时，后台先把下一句的音频取好
     * （实测：合成 1.2~1.4s < 播放 2.4~4s ⇒ 预取来得及 ⇒ 句间几乎无空档）。 */
    pushGameLineRaw({
      text: text, emotion: meta.emotion, game: meta.game, from: meta.from || 'game', ui: false,
      qid: meta.qid, qpart: meta.qpart, qof: meta.qof, qnext: meta.qnext,
      /* ★ 2026-10-17：预取提示（可重复 beat 的"接下来 2 句"）→ shim 后台先合成 */
      pf: Array.isArray(meta.pf) && meta.pf.length ? meta.pf : undefined,
    });
    return true;
  },
});

/* 路由：能"被说出口"的才进编排；其余（界面播报 / chat 回显）直通原路。
 * ★ 为什么不把 `ui:true` 也塞进队列：shim **本来就跳过它们不配音**
 *   （见 nori-game-voice.js 的 poll 过滤）⇒ 没有播完回报 ⇒ 只会白吃一次超时，
 *   把真正的台词堵在后面。 */
/* ★★ 2026-10-18：**内容级去重**（只作用于"要说出口"的台词）
 *   实测（森林寻宝 / 代号）：同一条回复被上游投递两次 —— 1~2 秒后出现第二条
 *   一字不差的 `SPEECH 入队`（qid 22/23、24/25、27/28），于是她整段说了两遍。
 *   气泡侧也能看到同名重复（`RECORD msg_46` 与 `msg_48` 内容相同）。
 *   ⇒ 同一 normalized 文本在窗口内再次到达 ⇒ 丢弃并留一行 `LINE-DEDUPE` 日志
 *     （日志带 `from`，将来能一眼看出是谁重复投的）。
 *   窗口用 `NORI_LINE_DEDUPE_MS` 可调；设 0 关闭。 */
const LINE_DEDUPE_MS = Math.max(0, Number(process.env.NORI_LINE_DEDUPE_MS == null ? 2500 : process.env.NORI_LINE_DEDUPE_MS));
const LINE_DEDUPE = require('./nori_line_dedupe.js').createLineDedupe(LINE_DEDUPE_MS);

function pushGameLine(o) {
  if (!o) return null;
  const speakable = o.from !== 'chat' && !o.ui && !!o.text;
  if (!SPEECH_Q.on || !speakable) return pushGameLineRaw(o);
  if (LINE_DEDUPE_MS > 0) {
    const d = LINE_DEDUPE(o.text, o.from);
    if (d.drop) {
      log('LINE-DEDUPE [' + (o.from || '?') + '] 距上一条 ' + d.agoMs + 'ms :: '
        + JSON.stringify(String(d.text).slice(0, 40)));
      return null;
    }
  }
  const meta = { emotion: o.emotion, game: o.game, from: o.from };
  /* ★ 2026-10-17：预取提示透传（最多 4 句，防上游误传大数组把 TTS 打满） */
  if (Array.isArray(o.pf) && o.pf.length) meta.pf = o.pf.slice(0, 4);
  return SPEECH_Q.push(o.text, meta);
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-03：**换局（退出 / 换游戏）⇒ 软清空编排缓冲 + 有条件通报人格**
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么挂 `cartridge_unmounted` 而**不是** `onGameEnd`：
 *   · `onGameEnd` = "**这一局下完了**"（同一卡带内的整局结束）—— 而她**恰好在那时说收尾的话**
 *     （"这局你赢了"之类）⇒ 挂它会把那句也吞掉。
 *   · `cartridge_unmounted` = "**他离开了这个游戏**" ⇒ 这才是"换局"。
 *     且换游戏时旧卡带的 unmounted 必先到达 ⇒ **换局 / 换游戏一并覆盖**。
 * 语义（用户 2026-10-03 拍板）：**当前句说完，其余丢弃**。
 *   —— 半句被吞比"多说一句"糟得多，所以正在播的那句不许打断。
 * ══════════════════════════════════════════════════════════════════════════ */
const PERSONA_URL = process.env.NORI_PERSONA_URL || 'http://127.0.0.1:25503';
let LEFT_SEQ = -1;      // 已处理过的"离开"状态序号（unmount 帧可能多头到达，只处理一次）

function noteLifeFrame(txt) {
  try { LIFE.onFrame(txt, 'in/recv'); } catch (e) {}
  try {
    const st = LIFE.getState();
    if (st.phase !== 'ended') return;
    if (st.seq === LEFT_SEQ) return;
    LEFT_SEQ = st.seq;
    onLeftGame(st.cart);
  } catch (e) {}
}

function onLeftGame(cart) {
  if (!SPEECH_Q.on) return;                    // off 档没有缓冲（整段直发）⇒ 不介入
  const dropped = SPEECH_Q.softReset();
  /* ★ "**有条件**通报"：条件是**真的丢了东西**（dropped > 0）。
     没积压就不通报 —— 否则每退出一次都往她的记忆里塞一条无意义的备注。 */
  if (!dropped) { log('SPEECH 换局(' + cart + ') ⇒ 缓冲为空，无截断'); return; }
  log('SPEECH 换局(' + cart + ') ⇒ 当前句播完即止，丢弃 ' + dropped + ' 句');
  notifySpeechTruncated(cart, dropped);
}

/* **有条件**告诉人格"这次被截断了"。
 * 走 `/game-note`：**只记不答**（不调 LLM）⇒ 不产生额外台词、不增加延迟。
 *   ⚠ 为什么不复用 `/game-turn`：那个会**调 LLM 生成一句回复**，用它"记一笔"
 *     会让她凭空多说一句、还多花一次调用。
 * 失败无所谓：它是**记忆备注**，不是控制流；断了只记一行日志。 */
function notifySpeechTruncated(cart, n) {
  try {
    const u = new URL(PERSONA_URL);
    const body = JSON.stringify({ game: cart, dropped: n });
    const r = http.request({
      host: u.hostname, port: Number(u.port) || 80, path: '/game-note', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (rr) => {
      rr.resume();
      const code = rr.statusCode || 0;
      if (code >= 400) log('SPEECH 截断通报被拒 http ' + code + '（人格侧还没加载 /game-note？）');
      else log('SPEECH 已通报人格：截断 ' + n + ' 句');
    });
    r.on('error', (e) => log('SPEECH 截断通报失败 ' + e.message));
    r.setTimeout(4000, () => { try { r.destroy(); } catch (e) {} });
    r.end(body);
  } catch (e) { log('SPEECH 截断通报异常 ' + e.message); }
}

/* ★★ 2026-10-03：**已删除**「游戏内聊天队列」整套 —— `NORI_CHAT` / `noriChatPush` /
 *   `/nori-chat` / `/nori-say`。原因：它的**唯一消费者**是自研聊天面板 `nori-game-chat.js`，
 *   而那个面板在 N1 之前就被删掉了（现在只存在于 `_backup/`）⇒ 数据推了没人取。
 *   ★ 删前逐个确认过：前端（服务目录 public/）、测试（`_t_*.js`）、验收工具全部无引用。
 *   ⚠ 前端现存的 `nori-chat-fix.js` 是**另一回事**（气泡探针，只用 `/nori-debug`），与本队列无关。
 *   ★ 保留 `personaChat()` / `NORI_CHAT_URL`：它们目前**也无调用方**，但正是
 *     「玩家的话在游戏里显示」（挂账项）需要的现成积木 ⇒ 暂留并在此标注，别当成活的在用。 */
const GAME_CN = { codenames: '森林寻宝', chess: '国际象棋', cakeduel: '蛋糕对决', pictionary: '你画我猜' };
const NORI_CHAT_URL = process.env.NORI_CHAT_URL || 'http://127.0.0.1:25503/v1/chat/completions';
let GAME_SESSION = null;   // 最近一个 WS 连接的 GameSession（用来存 directive）
// 直接问人格代理要一句回复（普通聊天入口 => 会正常进她的工作记忆/印象卡）
// ⚠ 2026-10-03 起**无调用方**（原来的调用者 `/nori-say` 已删）；保留给挂账项
//   「玩家的话在游戏里显示」。若确认不做，可连同 `NORI_CHAT_URL` 一并删除。
function personaChat(text, game) {
  const gname = GAME_CN[game] || game || '';
  const content = (gname ? '（我们正在一起玩' + gname + '）' : '') + text;
  const body = JSON.stringify({ model: 'nori', messages: [{ role: 'user', content: content }] });
  let u = null; try { u = new URL(NORI_CHAT_URL); } catch (e) {}
  if (!u) return Promise.resolve({ text: '', emotion: 'neutral', error: 'bad NORI_CHAT_URL' });
  return new Promise((resolve) => {
    const r = http.request({
      host: u.hostname, port: Number(u.port) || 80, path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (rr) => {
      const parts = []; rr.on('data', (d) => parts.push(d));
      rr.on('end', () => {
        const out = { text: '', emotion: 'neutral' };
        try {
          const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
          const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          let s = String(c || '');
          const m = s.match(/^\[emotion:([a-z]+)\]\s*/);
          if (m) { out.emotion = m[1]; s = s.slice(m[0].length); }
          out.text = s.trim();
        } catch (e) { out.error = 'bad json'; }
        resolve(out);
      });
    });
    r.on('error', (e) => resolve({ text: '', emotion: 'neutral', error: e.message }));
    r.setTimeout(60000, () => { try { r.destroy(new Error('persona chat timeout')); } catch (e) {} });
    r.end(body);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★★ N3（2026-10-02）· 主动触发（D3）+ 环路防护
 * ══════════════════════════════════════════════════════════════════════════
 * 【要解决什么】_arch/88 §4.4 的「唯一设计缺口」：
 *   她的对局认知走**拼接器**（每次 LLM 请求前 append 一条 system）。
 *   而玩家**只玩游戏、不聊天**时 ⇒ exe 不调 LLM ⇒ 拼接器没机会 append
 *   ⇒ 她既不知道刚才发生了什么、也不会开口。
 *   ⇒ 补法：代理在「**有新的对局事件** + 静默超过 N 秒」时，**自己**唤醒她一次，
 *     让她说一句，再把她的话推上屏（气泡 + 语音）。
 *
 * 【走哪条通道】`/game-turn`，**不是** `personaChat()`（★ 这是对原设计的改进）
 *   _arch/88 §4.4a 与 §89 §8 写的是 `personaChat()`（= 人格 `/v1/chat/completions`）。
 *   实测两条通道的**副作用差异巨大**（读 n_llm.js 逐个确认）：
 *
 *   | 副作用 | `/v1/chat/completions`(personaChat) | `/game-turn`(本模块) |
 *   |---|---|---|
 *   | `S.working` 工作记忆 | **写**（`if(!isReport)`）⇒ 玩家被塑造成"说过那句话" | 只经情绪同步写 |
 *   | `consolidate()` 记忆固化 | **跑** ⇒ 污染长期记忆 | **不跑** |
 *   | `rememberCard()` 印象卡 | **跑** ⇒ 重写印象卡 | **不跑** |
 *   | `S.log` 对话日志 | 写 | 不写（只写 `gameLog`） |
 *   | 输入语义 | 「**玩家说的话**」 | `【游戏】/【当前局面】/【他刚对你说】`（**不是**玩家发言） |
 *
 *   ⇒ 用 `personaChat` 会把 **B-015 / B-022 / B-023 / B-032** 那一组
 *     "机器文本污染记忆"的缺陷**重新引入**（它们正是 C3 关掉战报注入才消掉的）。
 *   ⇒ `/game-turn` 是**游戏专用通道**：语义正确、不碰印象卡/长期记忆。
 *   ⇒ 附带好处：**人格侧零改动** —— 不必去扩展 `n_llm.js` 的 `isReport` 前缀集合。
 *   ★ 更正一处既有说法：文档里的「本地 brain 的台词」并不准确 ——
 *     `BRAIN_URL` 就是 `25503/game-turn`（`nori_game.js:16`）⇒ 那些台词**是人格生成的**。
 *
 * 【怎么让她"只说话、不出招"】`gameTurn()` 末尾有"绝不空手"：
 *     `if (!actions.length && legal.length) actions = [legal[0].id]`
 *   ⇒ 传 `legal: []` ⇒ `legal.length === 0` ⇒ **不会补动作** ⇒ `actions` 恒空 ⇒ 只说话 ✅
 *   （`legalText` 会渲染成「（此刻没有任何合法动作）」，正好表达我们的意图。）
 *
 * 【环路防护】_arch/89 §8 的三重护栏，逐条落实：
 *   环路 1（player/nori-speech → E4 → 又进上下文）：由**策略表**保证 ——
 *     `nori-speech`/`player-speech` 的 E4/E5 均为 `no`（§89 §10）⇒ 拼接器只收 game-event。
 *   环路 2（主动触发 → 她的回复回流 → 又被触发）：
 *     · 她的回复经 `pushGameLine` → `agentMessage`（`actor:'agent'`）
 *       ⇒ 回流 classify 得 `nori-speech` ⇒ **不进 E4** ✅
 *     · 本模块**只以 `PENDING.pushed` 的"增长"为触发源**，而 PENDING 只收 `game-event`
 *       ⇒ 她的回复**在机制上不可能**成为触发源（双保险，不靠"记得别写错"）
 *     · **硬节流**（下面 `n3Throttled`：每游戏 60s ≤1、全局每分钟 ≤2）
 *
 * 【B-210 对策】判据必须在**代码里**可观测
 *   N3 的验收判据是"节流有没有生效"（纯计数），而日志口径不可靠
 *   （`err=` 是空值前缀；`FATAL` 命中的是用户自己在问日志级别）。
 *   ⇒ 自带计数器 + `/nori-n3stat` 端点，**不依赖 grep 日志**。
 *
 * 开关：`NORI_N3=off` ⇒ 完全不触发（退回今天之前的行为）。
 * ══════════════════════════════════════════════════════════════════════════ */
const N3_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_N3 || 'on'));
const N3_TICK_MS = Number(process.env.NORI_N3_TICK_MS || 5000);
const N3_SILENT_MS = Number(process.env.NORI_N3_SILENT_MS || 20000);   // 静默多久才算"他没说话"
/* ★ 2026-10-02（B-214）：**我们自己也得静默**。
 *   实测：14:56:01 她的回合台词与 N3 的主动台词落在**同一秒** ⇒ 玩家一次看到两个气泡。
 *   原因：`N3_SILENT_MS` 只看 `/v1/*`（exe 聊天），**看不见 `/game-turn`**（她的棋步）。
 *   ⇒ 这里额外要求「距上一次 `pushGameLine` 已过 N 秒」。
 *   取值考虑：象棋里她约每 6~18s 说一句 ⇒ 12s 意味着 N3 **只在真正的空档里**开口
 *   （她已经在持续说话的局里，N3 的"主动"本来就是多余的）。 */
const N3_SELF_QUIET_MS = Number(process.env.NORI_N3_SELF_QUIET_MS || 12000);
const N3_GAP_GAME_MS = Number(process.env.NORI_N3_GAP_GAME_MS || 60000);  // 同一游戏两次间隔
const N3_GAP_GLOBAL = Number(process.env.NORI_N3_GAP_GLOBAL || 2);        // 全局每分钟上限
const N3_GAP_GLOBAL_MS = 60000;
const N3_URL = process.env.NORI_N3_URL || 'http://127.0.0.1:25503/game-turn';

const N3 = {
  on: N3_ON, ticks: 0, fired: 0, lastAt: 0, lastGame: '', lastMs: 0, lastReply: '', lastError: '',
  byGame: {}, window: [], firedAt: [],  /* ★ 被跳过的原因逐个计数 —— 这是"节流到底有没有生效"的唯一可靠判据 */
  skipped: { init: 0, off: 0, notPlaying: 0, empty: 0, noNew: 0, notSilent: 0, selfQuiet: 0, throttleGame: 0, throttleGlobal: 0, busy: 0, error: 0 },
};
let N3_BUSY = false;
let N3_LAST_PUSHED = -1;      // -1 = 未初始化（避免进程刚起就把历史积压当成"新事件"）

function n3Skip(k) { N3.skipped[k] = (N3.skipped[k] || 0) + 1; }
function n3Life() { try { return LIFE.getState() || {}; } catch (e) { return {}; } }
function n3Pushed() { try { return (SPLICE.PENDING.getStats() || {}).pushed || 0; } catch (e) { return 0; } }
function n3Recent() {
  try {
    const snap = SPLICE.PENDING.snapshot() || [];
    return snap.slice(-4).map((x) => x.text).join('｜').slice(0, 300);
  } catch (e) { return ''; }
}
/* ★ B-213（2026-10-02）：给她**与 exe 路径同一份**上下文。
 *   原来只给"最近 4 条事件文本" ⇒ 她看不到完整对局、也判断不出轮次 ⇒ 容易说错棋势。
 *   `SPLICE.buildStateText()` 正是**拼接器在 exe 路径上给她看的那段**
 *   （【NoriOS 系统状态】+【NoriOS 对局记录】）⇒ 复用它 = **一致性**（她无论从哪条路
 *   被唤醒，看到的是同一份事实），也顺带把"她该知道的"收敛到**一个事实源**。 */
function n3Context() {
  try {
    const t = SPLICE.buildStateText();
    if (t) return t.slice(0, 1100);      // 留出余量给下面的指令（observation 上限 2600）
  } catch (e) {}
  try { return '最近这几步：' + (n3Recent() || '（刚开局）'); } catch (e) { return ''; }
}
function n3LastLlmAt() { try { return (LLM_ROUTE.getStats() || {}).lastAt || 0; } catch (e) { return 0; } }

/* 节流：返回 true = 本次不许触发（并记下是被哪一条挡的） */
function n3Throttled(game, now) {
  if (now - (N3.byGame[game] || 0) < N3_GAP_GAME_MS) { n3Skip('throttleGame'); return true; }
  N3.window = N3.window.filter((t) => now - t < N3_GAP_GLOBAL_MS);
  if (N3.window.length >= N3_GAP_GLOBAL) { n3Skip('throttleGlobal'); return true; }
  return false;
}

async function n3Fire(game) {
  N3_BUSY = true;
  const t0 = Date.now();
  let out = null;
  try {
    /* ★★ B-213（2026-10-02 实测修）：**必须明说"这轮不用出招"**。
     *
     *   为什么（A/B 探针直接证实，同一份对局记录、只改措辞）：
     *     `/game-turn` 的 prompt 把整轮框成「你要给出**你这一回合要执行的动作**」，
     *     并含 `【你可以做的合法动作 · 只能从中挑】\n（此刻没有任何合法动作）`；
     *     而这里为"只说话不出招"**刻意传 `legal: []`**
     *     ⇒ 她看到「轮到我 + 没动作可挑」这个**矛盾**，规则 4 又鼓励她「对不上就**点破**」
     *     ⇒ 于是她说出 **「Nori现在没棋可走啦」**（线上实测 14:56:01）。
     *   探针证据：旧措辞 → `reason:"没有合法动作，只能等他走"`（误读写进了理由字段）；
     *             新措辞 → `reason:"后没了有点心疼，但王安全"`（误读消失）。
     *
     *   ★ 同时纠正一个我自己的误判：她的台词**不是编的** ——
     *     "车把后吃掉了""王先躲好了"都与真实记录逐条对得上（`e8→d8（王）`）。
     *     真正的问题是 **① 没告诉她这轮不出招 ② 上下文只有 4 条、没有完整对局**（已由 n3Context 修）。
     *
     *   ★ 更干净的修法（未做，待拍板）：给 `/game-turn` 加 `commentOnly` 模式，
     *     模板里干脆不提"合法动作"、也不说"你要执行动作"。代价 = 改**人格侧**（跨文件）。 */
    const obs = [
      n3Context(),
      '【现在**不是**你出招的时候 —— 这一轮你不用走任何棋、也不用给提示词，只要说一两句话】',
      '【★ 请**完全忽略**下面那份「合法动作清单」：你主动开口时它被**故意留空**了，'
        + '这不代表你没棋可走、也不代表棋局出了问题，更不要因此去"点破"什么。】',
      '【你只负责说话：就着上面的对局记录，说一两句你此刻的想法或心情（一两句，别复述记录）。\n'
        + '  不要描述你走了哪一步、也不要断言具体棋势或输赢 —— 你看不到完整棋盘。】',
    ].filter(Boolean).join('\n\n');
    /* ★ legal:[] + directive:'' ⇒ 她只说话、绝不出招（见文件头说明） */
    const body = JSON.stringify({ game: game, observation: obs, directive: '', legal: [], maxActions: 1 });
    const u = new URL(N3_URL);
    out = await new Promise((resolve) => {
      const r = http.request({ host: u.hostname, port: Number(u.port) || 80, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (rr) => {
        const parts = []; rr.on('data', (d) => parts.push(d));
        rr.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { resolve(null); } });
      });
      r.on('error', (e) => resolve({ error: e.message }));
      r.setTimeout(20000, () => { try { r.destroy(new Error('n3 timeout')); } catch (e) {} });
      r.end(body);
    });
    const text = String((out && out.line) || '').trim();
    if (!text) { n3Skip('error'); N3.lastError = (out && out.error) || 'empty line'; return; }
    const acts = (out && out.actions) || [];
    N3.fired++; N3.lastAt = Date.now(); N3.lastGame = game; N3.lastMs = Date.now() - t0;
    N3.lastReply = text.slice(0, 160);
    N3.byGame[game] = Date.now();
    N3.window.push(Date.now());
    N3.firedAt.push({ at: Date.now(), game: game, text: text.slice(0, 80), ms: N3.lastMs, actions: acts.length, emotion: (out && out.emotion) || '' });
    if (N3.firedAt.length > 40) N3.firedAt = N3.firedAt.slice(-40);
    /* ★ 上屏路径（B-212 对策）：**不复用** `COMMENT_PENDING`（它已是死代码）。
     *   `from:'trigger'` 的取值是刻意的：
     *     · `pushGameLine` 内部 `o.from !== 'chat'` ⇒ 会走 `AGENT_CHAT_PUSH` ⇒ **原版气泡** ✅
     *     · `nori-game-voice.js` 的 `it.from === 'chat'` 才跳过 ⇒ 本值 ⇒ **会配音** ✅
     *       （必须如此：实测 `agentMessage` **不触发后端原生语音**，
     *         见 proxy.log 里 `AGENTCHAT` 之后没有 `audioStarted`/`SYNTH`。）
     *     · 不用 `'game'` 是为了将来能一眼区分"本地回合台词"与"主动触发台词"。 */
    pushGameLine({ text: text, emotion: (out && out.emotion) || 'neutral', game: game, from: 'trigger' });
    log('N3 主动触发 ' + game + ' ms=' + N3.lastMs + ' acts=' + acts.length + ' :: ' + JSON.stringify(text.slice(0, 60)));
  } catch (e) {
    n3Skip('error'); N3.lastError = String((e && e.message) || e).slice(0, 120);
  } finally { N3_BUSY = false; }
}

function n3Tick() {
  N3.ticks++;
  if (!N3_ON) return n3Skip('off');
  const life = n3Life();
  if (life.phase !== 'playing') return n3Skip('notPlaying');        // 只在"正在玩"时开口
  const game = String(life.cart || '');
  const pushed = n3Pushed();
  if (!pushed) return n3Skip('empty');
  if (N3_LAST_PUSHED < 0) { N3_LAST_PUSHED = pushed; return n3Skip('init'); }   // 首轮只记基线
  /* ★ 触发源 = **新增**（不是"非空"）：否则静默期每 5s 都会拿同一批旧事件去打扰她 */
  if (pushed <= N3_LAST_PUSHED) return n3Skip('noNew');
  if (N3_BUSY) return n3Skip('busy');
  const now = Date.now();
  /* 静默：玩家在聊天时 exe 会调 LLM ⇒ 那时不该由我们插嘴 */
  const lastLlm = n3LastLlmAt();
  if (lastLlm && now - lastLlm < N3_SILENT_MS) return n3Skip('notSilent');
  /* ★ B-214：**她自己的台词**也要静默够了 —— 否则会和回合台词撞在同一秒（实测过） */
  if (N3_LAST_LINE_AT && now - N3_LAST_LINE_AT < N3_SELF_QUIET_MS) return n3Skip('selfQuiet');
  if (n3Throttled(game, now)) return;
  N3_LAST_PUSHED = pushed;      // 只有"真要发"才推进；被节流挡住则下轮继续尝试
  n3Fire(game).catch((e) => { N3.lastError = String(e.message || e); });
}
if (N3_ON) { try { const _t = setInterval(n3Tick, N3_TICK_MS); _t.unref(); } catch (e) {} }
function n3Stat() {
  const now = Date.now();
  return Object.assign({}, N3, {
    cfg: { tickMs: N3_TICK_MS, silentMs: N3_SILENT_MS, selfQuietMs: N3_SELF_QUIET_MS, gapGameMs: N3_GAP_GAME_MS, gapGlobalPerMin: N3_GAP_GLOBAL, url: N3_URL },
    lastLineAgoSec: N3_LAST_LINE_AT ? Math.round((now - N3_LAST_LINE_AT) / 1000) : null,
    busy: N3_BUSY,
    windowLastMin: N3.window.filter((t) => now - t < N3_GAP_GLOBAL_MS).length,
    lastAgoSec: N3.lastAt ? Math.round((now - N3.lastAt) / 1000) : null,
    lastByGame: Object.assign({}, N3.byGame),
  });
}

const LISTEN_PORT = Number(process.env.NORI_LISTEN_PORT || 4173);
const UP_HOST = '127.0.0.1';
const UP_PORT = Number(process.env.NORI_UP_PORT || 4174);
const TTS_URL = process.env.NORI_TTS_URL || 'http://127.0.0.1:8880/tts';
/* ★★ 2026-10-17：**真流式**端点（`tts/server.py` 的 `/tts.stream`）。
 *   为什么必要：`/tts` 回的是 **WAV**，而 WAV 必须收齐才能回填 RIFF/data 长度
 *   ⇒ 那条路**结构上不可能流式**（实测 TTFB == total：3.17/4.11/2.53s）。
 *   `/tts.stream` 回**裸 PCM@32000**（无头 ⇒ 可边收边转），实测 TTFB **0.56~1.28s**。
 *   ★ 采样率 32000 **正好等于 `OUT_RATE`** ⇒ 连 `resampleInt16` 都省掉。
 *   ★ 自动降级：若该端点不存在（TTS 服务还没重启 / 老版本）⇒ 自动退回 `/tts`（见 ttsStream 的 404 分支）。
 *   强制关：`NORI_TTS_STREAM=off`。 */
const TTS_STREAM_URL = process.env.NORI_TTS_STREAM_URL || 'http://127.0.0.1:8880/tts.stream';
const TTS_STREAM_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_TTS_STREAM || 'on'));
const OUT_RATE = 32000;
const FRAME_SAMPLES = 5760; // 180 ms @32k, matches backend framing
const DEBUG = true;
// single voice (user request: official uses one voice, no per-emotion split)
//   ★ 2026-10-07 修复：音色归 TTS 服务侧决定（Desktop/NoriProject/tts/config.py 的 VOICE）。
//   代理曾硬编码百炼克隆音色 'qwen-audio-3.0-tts-flash-nori2-…' —— 换成 Inworld 后它不被认识，
//   服务返回 502（Unknown voice）⇒ 无音频 ⇒ 前端走兜底音效、第一句反复重试而卡住。
//   现在留空 ⇒ tts() 只发 {text} ⇒ 服务用 config.py 的默认音色（真值只存一处）。
//   需要临时覆盖时才设环境变量 NORI_TTS_VOICE。
const SINGLE_VOICE = process.env.NORI_TTS_VOICE || '';
function voiceFor() { return SINGLE_VOICE; }

function log(...a) { console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a); }

// ---------- speech text map: "uuid:blockId" -> {text,isSpeech} ----------
const speechMap = new Map();
function recordSpeech(messageId, blockId, content, isSpeech, emotion) {
  if (!messageId) return;
  const key = messageId + ':' + (blockId == null ? 0 : blockId);
  const span = cleanAgentText(content);
  if (span.emotion && (!emotion || emotion === 'neutral')) emotion = span.emotion;
  speechMap.set(key, { text: span.text, isSpeech: isSpeech !== false, emotion: emotion || 'neutral', ts: Date.now() });
  if (DEBUG) log('RECORD', key.slice(0, 13), emotion || 'neutral', JSON.stringify((span.text || '').slice(0, 36)));
}
function captureText(txt) {
  let j; try { j = JSON.parse(txt); } catch { return; }
  const tr = j && j.transition; if (!tr) return;
  const c = tr.cmd;
  // replies under progressive reveal already have their FULL text recorded by planReveal()
  if (c && c.type === 'ingestBlock' && c.messageId && !REVEAL.has(c.messageId)) recordSpeech(c.messageId, c.blockId, c.content, c.isSpeech, c.emotion);
  if (Array.isArray(tr.events)) for (const ev of tr.events)
    if (ev && ev.type === 'agent_message' && ev.messageId && !REVEAL.has(ev.messageId)) recordSpeech(ev.messageId, ev.blockId, ev.content, ev.isSpeech, ev.emotion);
}

// ---------- progressive bubble reveal (audio-synced) ----------
// The client reveals a block only when `startedThrough >= blockId` in audio mode, and the
// bubble list is the cartridge `/lines` array. Backend always emits ONE block per reply, so we
//   * split the reply into sentence blocks (pendingBlocks 0..N-1) at ingestBlock time,
//   * keep every outgoing /operations patch consistent with how much is revealed so far,
//   * let the CLIENT's own audio acks (one `audioStarted` per block) drive the reveal, exactly
//     like the official flow - we never fabricate transitions, so versions stay in sync.
const REVEAL = new Map();      // messageId -> {msgId,opId,parts,blocks,entries,allowed,ts}
const MAIN_CLIENTS = new Set();
const LAST = { worldId: null, cartridgeId: 'chat', version: 0, lines: null, ops: null };

// ---------- 她的“游戏解说”走原版聊天框 ----------
// 做法：回合走完后，我们用玩家的身份往 chat 卡带投一条【NoriOS战报】，让她真的用原生气泡+语音回一句；
// 战报本身在出站 /lines 里被抹掉（玩家看不到），她的话再同步一份到游戏内气泡，语音只由聊天通道出。
const HEADS = new Map();       // cartridgeId -> { head, fence }
const COMMENT_MARK = '【NoriOS战报';
let COMMENT_PENDING = null;    // { at, game, text } 等下一条她的回复来填游戏内气泡
// ---- 2026-09-27（问题 8）：战报节流 + 合并 + 局末挂起，避免她的话堆积 ----
// 原实现里 COMMENT_PENDING 是单个全局变量，新战报直接覆盖旧的 → 她的多条回复在音频里排队，
// 游戏结束后她还在一直说。这里改成"队列 + 最小间隔"，并在整局结束时挂起。
let COMMENT_Q = [];            // 待注入的战报 [{text, game}]
let COMMENT_TIMER = null;
let LAST_COMMENT_AT = 0;
let COMMENT_SUSPEND = null;    // 某卡带本局已结束 → 不再为它注入战报
// ★ 2026-09-27：挂起必须能自己过期。原来只靠「新局开始」事件解除，
//   而象棋发的是 game_start（没 ed），于是认输一次就永久静音。
const COMMENT_SUSPEND_TTL = Number(process.env.NORI_COMMENT_SUSPEND_TTL || 20000);
let COMMENT_INJECT = null;     // 由 WS 连接处赋值（需要 up / HEADS / LAST 作用域）
const COMMENT_GAP_MS = Number(process.env.NORI_COMMENT_GAP_MS || 4500);
const COMMENT_MAX_Q = Number(process.env.NORI_COMMENT_MAX_Q || 2);
const COMMENT_TTL_MS = 20000;
function commentSchedule() {
  if (COMMENT_TIMER) return;
  COMMENT_TIMER = setTimeout(() => { COMMENT_TIMER = null; try { commentFlush(); } catch (e) {} }, 900);
}
function commentFlush() {
  if (COMMENT_PENDING && Date.now() - COMMENT_PENDING.at < COMMENT_TTL_MS) { commentSchedule(); return; }
  if (!COMMENT_Q.length) return;
  const t = Date.now();
  if (t - LAST_COMMENT_AT < COMMENT_GAP_MS) { commentSchedule(); return; }
  const items = COMMENT_Q; COMMENT_Q = [];
  const text = items.map((x) => x.text).join(' ');
  const game = items[items.length - 1].game;
  try {
    if (typeof COMMENT_INJECT === 'function' && COMMENT_INJECT(text, game)) {
      LAST_COMMENT_AT = t;
      BATTLE.injected++;            // ★ C3：真的注入出去了（关闭时这里恒为 0）
    }
  } catch (e) { log('COMMENT flush err ' + e.message); }
}
/* ★ C3（2026-10-02）：战报**不再注入** chat 卡带（§89 的 P-c 后半）。
   ─────────────────────────────────────────────────────────────────────
   **为什么现在可以关**：N1（四游戏事件接入）已完成 ⇒ 她的对局信息来源已从
   「战报（注入 → 人格））」切换为「结构化 `game-event`（拼接器 render →
   `【NoriOS 对局记录】` 那条 system）」。§89 把这两步定为**配套**：
   先关注入 ⇒ 她会立刻从"知道细节"退化成"只知道在玩"（中间态退化）。

   ★ 关闭后的**行为变化**（逐条，都是有意为之）：
     · `logBattle` **保留** ⇒ 战报原文仍写进 `battle.log`（E7 出口，可查阅/可审计）
     · `commentQueue` **返回 `false`** ⇒ `nori_game.js` 的 `finishTurn()` 走
       `onLine(lastLine)` **兜底** ⇒ **她仍会在回合末说一句**（本地 brain 的台词）——
       **不会变哑巴**。这是本步最容易忽略、也最致命的一点（返回值语义）。
     · 人格回复那条路（`from:'chat'` → 游戏内气泡）不再产生
     · ⇒ 玩家可见的"她的话"由 **本地 brain 台词** 承担：`GAME-LINE` → 原版气泡 + 语音。
       实测它的量是主力（359 次 vs 战报 181 次）⇒ 不会静默。
     · ⇒ `CARRIER.cmdSeen`（C1 的计数）应当**不再增长** —— 这是本步的验收判据。

   ★ 回退：`NORI_COMMENT_INJECT=on` ⇒ 一秒回到旧行为（原实现逐字保留）。 */
const COMMENT_INJECT_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_COMMENT_INJECT || 'off'));
/* ★ C3 只读计数（可观测；与 C1 的 CARRIER 是同一主题的两个阶段）：
 *   total      = 产生的战报总数（每回合末一条）
 *   injected   = 真的注入 chat 卡带的（C3 关闭后应为 0）
 *   suppressed = 因 C3 而未注入的（= 让 finishTurn 走了兜底） */
const BATTLE = { total: 0, injected: 0, suppressed: 0, lastAt: 0, lastText: '' };
function battleStat() { return Object.assign({}, BATTLE, { injectOn: COMMENT_INJECT_ON }); }

/* ★ C3（2026-10-02）：E7 —— 战报原文进**独立后端日志**（§89 E7 出口）。
   ─────────────────────────────────────────────────────────────────────
   背景：官方战报**不上屏**（E2 用户决策），但我们要留痕以便查阅。
   现在（N1 之后）她获知对局的**正式通道**是结构化 `game-event`，
   所以本日志退为**审计/查阅**用途 —— 但它**不能省**：
   万一 `game-event` 有漏（新事件类型未进 RENDER 表），这是唯一的原文底稿。 */
const BATTLE_LOG = process.env.NORI_BATTLE_LOG || path.join(__dirname, 'battle.log');
function logBattle(text, game) {
  try {
    fs.appendFileSync(BATTLE_LOG, '[' + new Date().toISOString() + '] ' + (game || '?') + '\t' + String(text) + '\n');
  } catch (e) { /* 日志失败绝不能影响主流程 */ }
}

function commentQueue(text, game) {
  logBattle(text, game);   // ★ C3/E7：无论后面是否注入 / 是否挂起，战报原文一律先留痕
  BATTLE.total++; BATTLE.lastAt = Date.now(); BATTLE.lastText = String(text).slice(0, 120);

  /* ★ C3：**不再注入 chat 卡带**。
     ⇒ 返回 `false` 是**有意的**：`finishTurn()` 里 `ok = onCommentary(...) !== false`，
        `!ok` 时才调 `onLine({text: lastLine, …})` ⇒ 她仍会在回合末说一句。
        （若这里返回 true/false 搞反，她会**彻底沉默** —— 单测专测这条。） */
  if (!COMMENT_INJECT_ON) {
    BATTLE.suppressed++;
    return false;
  }

  // ★ 挂起期间：返回 false，让 nori_game.js 的 finishTurn 走 onLine 气泡兜底
  //   （原实现无条件返回 true，于是「挂起=彻底不说话」，象棋整场哑巴）。
  if (COMMENT_SUSPEND && COMMENT_SUSPEND.game === game) {
    if (Date.now() - COMMENT_SUSPEND.at > COMMENT_SUSPEND_TTL) {
      log('COMMENT 挂起超时自动解除（' + game + '）');
      COMMENT_SUSPEND = null;
    } else {
      return false;
    }
  }
  COMMENT_Q.push({ text: String(text), game: game });
  if (COMMENT_Q.length > COMMENT_MAX_Q) COMMENT_Q.splice(0, COMMENT_Q.length - COMMENT_MAX_Q);
  log('COMMENT queued n=' + COMMENT_Q.length + ' ' + JSON.stringify(String(text).slice(0, 50)));
  commentSchedule();
  return true;
}
function trackHead(k) {
  if (!k || typeof k !== 'object') return;
  if (k.worldId) LAST.worldId = k.worldId;
  const cid = k.cartridgeId;
  if (cid) {
    const hv = (typeof k.headVersion === 'number') ? k.headVersion : (typeof k.version === 'number' ? k.version : null);
    if (hv != null) HEADS.set(cid, Object.assign(HEADS.get(cid) || {}, { head: hv }));
    if (k.visibilityFenceId) HEADS.set(cid, Object.assign(HEADS.get(cid) || {}, { fence: k.visibilityFenceId }));
  }
  if (Array.isArray(k.runtimes)) for (const r of k.runtimes) {
    if (r && r.cartridgeId) HEADS.set(r.cartridgeId, Object.assign(HEADS.get(r.cartridgeId) || {}, { head: (typeof r.headVersion === 'number' ? r.headVersion : 0), fence: r.visibilityFenceId || 'ui' }));
  }
}
function isCommentEntry(el) {
  return !!(el && typeof el.content === 'string' && el.content.indexOf(COMMENT_MARK) === 0);
}

function findRevealByOp(opId) { for (const r of REVEAL.values()) if (r.opId && r.opId === opId) return r; return null; }
function ackAllowed(rv, blockId) {
  if (!rv || rv.done) return;
  const v = Math.min(rv.parts.length, Math.max(rv.allowed, (blockId | 0) + 1));
  if (v !== rv.allowed) { rv.allowed = v; log('REVEAL allow ' + v + '/' + rv.parts.length + ' msg=' + String(rv.msgId).slice(0, 8)); }
}
// register a multi-sentence reply: split it into blocks and record the full text for TTS
function planReveal(j) {
  const tr = j && j.transition; if (!tr) return false;
  const c = tr.cmd;
  if (!c || c.type !== 'ingestBlock' || !c.messageId || c.isSpeech === false) return false;
  if (REVEAL.has(c.messageId)) return false;
  const clean = cleanAgentText(c.content);
  const parts = bubblesFor(clean.text);
  if (parts.length < 2) return false;
  const emo = c.emotion || clean.emotion || 'neutral';
  // ★ C6（2026-10-02）：显式带 sender。原实现漏了这一项 ⇒ 出站 /lines 条目里她的气泡
  //   没有 sender，前端 `sender==="player"?"user":"nori"` 靠**默认分支**才渲染成 Nori，
  //   观测侧记为 (none)（T6 实测从 msg_8 起就出现）。补 'agent' 让身份显式、可校验。
  const base = { messageId: c.messageId, sender: 'agent', blockType: c.blockType || 'text', isSpeech: true, emotion: emo };
  // ★ C8（2026-10-02）：块数 ≥4 → 合并成 3 块（T5 用户定稿：≤3 保持、≥4 合并）。
  //   为什么必须同时记 blockOf：露出节奏由**语音**驱动（每个 audioStarted 抬一次 rv.allowed，
  //   单位是 **part**）。块合并后必须把"已播 part 数"翻译回"应露的块数"，
  //   否则 allowed 会跑在块数前面 ⇒ 一口气全露（等于没做渐进）。
  //   ★ 语音不受影响：TTS 用 speechMap 里的**整段**文本，与块切分无关。
  const mb = mergeBlocks(parts);
  const rv = { msgId: c.messageId, opId: c.operationId, parts, blockOf: mb.blockOf, allowed: 0, ts: Date.now(), timers: [],
    blocks: mb.chunks.map((ch, k) => Object.assign({}, base, { blockId: k, content: ch.text })),
    entries: mb.chunks.map((ch, k) => Object.assign({}, base, { blockId: k, content: ch.text, createdAt: Date.now() })) };
  REVEAL.set(c.messageId, rv);
  speechMap.set(c.messageId + ':0', { text: clean.text, isSpeech: true, emotion: emo, ts: Date.now(), parts });
  c.content = mb.chunks[0] ? mb.chunks[0].text : parts[0];
  log('PLAN reveal parts=' + parts.length + ' blocks=' + mb.chunks.length
    + (mb.chunks.length < parts.length ? '（合并）' : '') + ' msg=' + String(c.messageId).slice(0, 8)
    + ' ' + JSON.stringify(parts.join(' / ').slice(0, 70)));
  setTimeout(() => { try { if (!rv.done) rv.allowed = rv.parts.length; } catch {} }, 15000);   // safety: never leave text hidden
  return true;
}
// Rebuild the /lines array so every reply we rewrote shows exactly its own revealed sentences
// (one entry per sentence, no duplicates). Every REVEAL-owned message is normalised with its own
// exposure counter, so normalising can never drop another reply's entries. Idempotent.
function normalizeLines(fullArray) {
  const out = []; const seen = new Set();
  for (const el of fullArray) {
    if (isCommentEntry(el)) continue;                             // 战报不进聊天面板
    const mid = el && el.messageId;
    const r = mid ? REVEAL.get(mid) : null;
    if (!r) { out.push(el); continue; }
    if (seen.has(mid)) continue;                                  // extra copies of the same reply
    seen.add(mid);
    // ★ C8：r.allowed 是「已播 part 数」，而 entries 是「合并后的块」⇒ 必须翻译成块数
    const upto = blocksForParts(r, Math.max(r.allowed, 1));
    for (let k = 0; k < upto && k < r.entries.length; k++) out.push(r.entries[k]);
    r.exposed = Math.max(r.exposed || 0, Math.min(upto, r.entries.length));
  }
  return out;
}
/* ══════════════════════════════════════════════════════════════════════════
 * ★ 2026-10-03：B-215 那套「给注入消息注册 REVEAL 做分块揭示」**已整体删除**。
 *   删掉的符号：`INJ_Q` / `INJ_SEQ` / `INJ_STATS` / `injEstimateMs` /
 *   `INJ_REVEAL_ON` / `injReveal` / `injNudge` / `injAdvance` / `injStat`
 *   （端点 `/nori-advance`、`/nori-injstat` 同步删除）。
 *
 * 为什么删：它要解决的是「**一次发了多句、想逐句露出来**」。
 *   新的**语音编排模块**（`nori-speech/`）**从不一次发多句**
 *   ⇒ 不存在"要露出来的剩余内容" ⇒ REVEAL / carrier / 进度换算**全部不再需要**。
 *
 * ★ 首次实装失败的教训（留档，别再走一遍）：
 *   方案 (a) 的推进需要一个"**带 transition 的 chat 帧**"当落点
 *   （`exposeLines` 从不自造帧，版本才权威）。原生路径有这个帧 —— 它来自
 *   **客户端的音频活动**（proxy.log 统计：`REVEAL expose` 前一行 **422 次是上行 `CLI dispatch`**）。
 *   而**我们的注入没有客户端音频活动**：nudge 发一条 `audioStarted` 后，服务端只回
 *   `dispatch_ack`，**而它不带 `transition`** ⇒ `exposeLines` 直接 return false
 *   ⇒ **永远只露第 1 块**（实测 `fallbackDone=4` = `revealCreated=4`，
 *     即 4 条全走兜底且都没下发出去）⇒ 结果比原缺陷更糟：**气泡内容缺失**。
 *   ⇒ 结论：**内容完整性优先**，回到"整段显示"；改用**逐句发布**从根上绕开它。
 * ══════════════════════════════════════════════════════════════════════════ */

function trimLines(j) {  const tr = j && j.transition;
  if (!tr || !Array.isArray(tr.patches)) return false;
  let changed = false;
  for (const p of tr.patches) {
    if (!p || p.op !== 'replace' || p.path !== '/lines' || !Array.isArray(p.value)) continue;
    const full = []; let touched = false; let dropped = false;
    for (const el of p.value) {
      if (isCommentEntry(el)) { dropped = true; continue; }
      /* ★ C2（2026-10-02）：白名单 —— 身份不明的条目不再靠前端默认值兜底。
         · sender 缺失（null/undefined）→ **保留**但计数（C6 已修我方气泡的源头；
           若仍持续出现，说明还有别的来源，靠这个计数暴露出来）
         · sender 存在但不在白名单 → **丢弃 + 计数 + 日志**（不得冒充 Nori 上屏） */
      if (el && typeof el === 'object') {
        const sd = (el.sender == null) ? null : String(el.sender);
        if (sd == null) {
          CARRIER.noSender++;
        } else if (!KNOWN_SENDERS.has(sd)) {
          CARRIER.unknown++; dropped = true;
          log('★C2 丢弃未知 sender=' + JSON.stringify(sd.slice(0, 24)) + ' cart=' + String(j.cartridgeId || '')
            + ' len=' + String(el.content || '').length);
          continue;
        }
      }
      if (el && el.sender === 'agent' && typeof el.content === 'string') {
        const bs = bubblesFor(el.content);
        if (bs.length > 1) {
          const mc = mergeBlocks(bs);
          /* ★ 2026-10-03：这里原来还挂着 B-215 的 `injReveal`（注册 REVEAL 做分块揭示），
             已随 B-215 整体删除（见上方那段说明）。
             现在职责回到 C8 的原意：**把"多句合成一条"的 agent 消息拆成 ≤3 块**。
             ⚠ 编排模块开启时，我们注入的消息**每句只有一块** ⇒ `bs.length > 1` 不成立
               ⇒ 本分支实际主要服务**编排关闭的 legacy 路径**（那时仍会整段注入）。 */
          for (let k = 0; k < mc.chunks.length; k++) full.push(Object.assign({}, el, { blockId: k, content: mc.chunks[k].text }));
          touched = true; continue;
        }
      }
      full.push(el);
    }
    LAST.lines = normalizeLines(full);
    if (!touched && !dropped && !full.some((el) => el && el.messageId && REVEAL.has(el.messageId))) { continue; }
    p.value = LAST.lines;
    changed = true;
  }
  return changed;
}
function trimOps(j) {
  const tr = j && j.transition;
  if (!tr || !Array.isArray(tr.patches)) return false;
  let changed = false;
  for (const p of tr.patches) {
    if (!p || p.op !== 'replace' || p.path !== '/operations' || !p.value || typeof p.value !== 'object') continue;
    for (const [opId, op] of Object.entries(p.value)) {
      if (!op || typeof op !== 'object') continue;
      let rv = null;
      for (const r of REVEAL.values()) if (r.opId === opId) { rv = r; break; }
      if (!rv) continue;
      const srvRev = (op.revealedThrough == null ? -1 : op.revealedThrough);
      if (srvRev + 1 > rv.allowed) { rv.allowed = Math.min(rv.parts.length, srvRev + 1); log('REVEAL allow(srv) ' + rv.allowed + '/' + rv.parts.length + ' msg=' + String(rv.msgId).slice(0, 8)); }
      // keep the client's own block-reveal loop quiet (it re-adds entries and duplicates the
      // bubble): the pending maps are emptied, so bubbles come only from our /lines patches.
      op.pendingBlocks = {};
      op.pendingStarted = {};
      op.pendingPresented = {};
      changed = true;
    }
    LAST.ops = p.value;
  }
  return changed;
}
// the bubble comes from our /lines patch; the raw agent_message event would append a duplicate
function dropAgentEvents(j) {
  const tr = j && j.transition;
  if (!tr || !Array.isArray(tr.events)) return false;
  const before = tr.events.length;
  tr.events = tr.events.filter((ev) => !(ev && ev.type === 'agent_message' && ev.messageId && REVEAL.has(ev.messageId)));
  return tr.events.length !== before;
}

/* ★ C1（2026-10-02）：补上 T4 实测漏掉的两条载具。
   ─────────────────────────────────────────────────────────────────────
   背景：战报是**我们**用玩家身份注入 chat 卡带的（见 injectCommentaryRaw）。服务端接受后
   会把它广播回来，于是它同时出现在三条路上：
     · patches[/lines]        —— trimLines 已堵 ✓（实测 528→0）
     · transition.cmd         —— ★ 完全没处理（实测 7→7 直通）
     · events[player_message] —— ★ dropAgentEvents 只管 agent_message（实测 7→7 直通）
   玩家之所以没看到战报气泡，全靠第二层防线（shim 的 isCommentEntry + data-nori-hidden 在
   **DOM 层藏掉已渲染的气泡**）—— 那是治标：shim 一失效（如 B-025 那次）战报立刻露出。
   这里从**源头**堵死，判据与 /lines 完全一致（文本以 COMMENT_MARK 开头）。

   ★★ 处置方式（**2026-10-02 修正**）：**保留结构、清空文本**，绝不删字段。
     我曾写"`delete tr.cmd` 是安全的"并用 observer 的防御式判断作论据 —— **那是错的**，
     实测导致前端整条丢弃帧、游戏卡死（详见下方 dropCommentCarriers 内的详注）。
     **⇒ 铁律：判断能否删字段，必须看消费端的 schema（Zod），不能靠生产端的防御式判断推断。** */
/* ★ CARRIER：C1 的**只读**计数（可观测）。
 *   cmdSeen = 战报出现在 transition.cmd 的次数（**按设计不改帧**，交由 shim 的 DOM 层隐藏）。
 *   ev      = events[player_message] 里被**丢弃**的战报条数（数组类路径，可安全过滤）。 */
const CARRIER = { cmdSeen: 0, ev: 0, noSender: 0, unknown: 0 };
/* ★ C2（2026-10-02）：前端渲染层认识的 sender 只有这三种（_arch/86 §1.1）。
   不在白名单里的一律丢弃 —— 以前是"靠前端默认分支兜底"（`sender==="player"?"user":"nori"`），
   于是身份不明的内容会被**冒充成 Nori 说的话**显示出来。 */
const KNOWN_SENDERS = new Set(['player', 'agent', 'chip']);
function dropCommentCarriers(j) {
  const tr = j && j.transition;
  if (!tr) return false;
  let changed = false;

  /* ① transition.cmd —— ★★ **刻意不动**（2026-10-02 第二次修正）
   * ─────────────────────────────────────────────────────────────────────
   * 为什么最终选择"什么都不做"：
   *   · **不能删字段**：前端 Zod `cmd = {type:string} AND record` ⇒ **必填**。
   *     删掉 ⇒ `Dropping invalid server message` ⇒ **整条帧被丢弃** ⇒ 版本跳号 ⇒ **游戏卡死**。
   *     （实测证据：Console 2 个 ZodError  ↔  离线工具 `verify_frame_schema.py` 查出 cmd 丢 2 次）
   *   · **也不能清空文本**：清空后 `isCommentEntry`（按前缀识别）不再命中 ⇒
   *     shim 的 `data-nori-hidden` 不再隐藏它 ⇒ 可能渲染出**空气泡**（可见的回归）。
   *   · **而"不动"是已知可行的**：战报气泡由**第二层防线**（shim 的 isCommentEntry +
   *     DOM 层隐藏）挡住 —— 这是 C1 之前就在工作、且用户从未看到战报气泡的现状。
   *
   * ⇒ 结论：**cmd 这条路径交给 DOM 层防线**；源头级过滤只在**数组类**路径上做（见 ②）。
   *   这叫"**知道哪一层该负责**" —— 在必填字段上强行加工，代价（卡死）远大于收益（少一层防御）。
   *   ⚠ 若将来真要源头堵 cmd，必须**先确认前端在 `cmd.text=''` 时不会产生气泡**（实测，不是推断）。 */
  const c = tr.cmd;
  if (c && typeof c === 'object') {
    const txt = String(c.content != null ? c.content : (c.text != null ? c.text : ''));
    if (txt.indexOf(COMMENT_MARK) === 0) {
      CARRIER.cmdSeen++;        // ★ 只**计数**（可观测），不改帧
      if (CARRIER.cmdSeen === 1 || CARRIER.cmdSeen % 20 === 0) {
        log('C1 战报出现在 transition.cmd（第 ' + CARRIER.cmdSeen + ' 次）—— 按设计**不改帧**，交由 shim 隐藏');
      }
    }
  }

  /* ② events[] —— player_message（dropAgentEvents 不覆盖的那一支） */
  if (Array.isArray(tr.events)) {
    const before = tr.events.length;
    tr.events = tr.events.filter((ev) => {
      if (!ev || typeof ev !== 'object') return true;
      const t = String(ev.type || '');
      if (t !== 'player_message' && t !== 'playerMessage') return true;
      const txt = String(ev.content != null ? ev.content : (ev.text != null ? ev.text : ''));
      return txt.indexOf(COMMENT_MARK) !== 0;      // 命中战报 ⇒ 丢弃
    });
    if (tr.events.length !== before) {
      CARRIER.ev += (before - tr.events.length);
      log('★C1 拦截 events[player_message] 里的战报 ×' + (before - tr.events.length) + ' cart=' + String(j.cartridgeId || ''));
      changed = true;
    }
  }
  return changed;
}
// ---- 剧情闸门：
// 官方服务器用 system.tick / system.patchVariables 按剧情推事实；本地版没有这个节拍，
// 所以这里 (a) 跟踪世界事实集合，(b) 邮箱改成「按事实放行」而不是按时间，(c) 用官方 dev 注入通道
// 替玩家补上该由服务器发的那几条事实（等价于客户端自己发事实，前端会正常播过场）。
const ART_SCHED = !/^(off|0|no|false)$/i.test(String(process.env.NORI_ARTIFACT_SCHEDULE || ''));
const MAIL_GATE_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_MAIL_GATE || 'on'));
const ART_KINDS = new Set(['mail', 'file', 'signal_thread', 'signal_message']);
// 官方这几封是「凑数/常驻」邮件，开局就该在（用户 2026-09-25 确认）
const STATIC_MAIL = new Set(['mail.advisory', 'mail.acq_strategic', 'mail.researcher_decline', 'mail.journalist_apology']);
// 这封邮件官方是“动作触发”而不是定时：《请帮帮我》必须先把算力打开并 +1，不能靠时间轴漏出来。
// 2026-09-27 用户反馈「开局多了两封后面才该触发的邮件」，其中一封就是《一些发现，关于算力上限》。
// 它官方没有独立的 BEATS 条目（只在下面 READ_EXTRA 里，跟着 act2_hinge 一起发 unlocked），
// 因此派生 storyMail 名单时漏掉了它 → 走后半段「按时间轴放行」→ 开局的 surfacedAt 早已到点 →
// 一进游戏就躺在收件箱里。这里显式并入「只认 <id>.unlocked」，让它回到官方的 act2 中段。
const FACT_ONLY_MAIL = new Set(['mail.help', 'mail.cap_hint']);
const FACTS = new Set();      // 世界事实集合
let MAX_COMPUTE = -1;         // variables.idle.maxCompute
const UPS = new Set();        // 非媒体的上行连接（用来以客户端身份发官方事件）
const FACTS_AT = new Map();   // fact -> 首次入库时间（节拍器延迟用）
/* ★★ 2026-10-07（摸头/摸尾巴）：**可重复的手势 fact**
 *   交互类动作会反复发生（摸头不会只摸一次），而 `FACTS` 是「世界事实集合」，
 *   同一个 id 只会入库一次 ⇒ 第二次就被 `FACTS.has(id)` 挡掉，beat 永远响不了。
 *   ⇒ 前缀匹配的 fact **跳过去重**：每次都刷新时间戳并重新判定 beat。
 *   ⚠ `FACTS.add` 仍保留（"这件事发生过"语义不变），只是不因已存在而早退。
 *   ⚠ 只用于**交互手势**（`touch.*`）；剧情 fact 必须保持"一次性"
 *      —— 否则重连/回灌会把过场台词反复重放（`FACTS_ABSORB_DEPTH` 已另有一道闸）。 */
const REPEATABLE_FACT = /^touch\./;
/* ★ 2026-10-16：**过场闸门的状态**（判据与说明见下方 `petGateWhy`）。
 *   ⚠ 必须声明在 `addFact` **之前**：`addFact` 里要写这两个时刻，
 *     而 `let`/`const` 有 TDZ —— 若启动阶段（声明处之前）就调到 `addFact`，
 *     会直接 ReferenceError ⇒ **代理起不来**。 */
const PET_GATE_OFF = /^(off|0|no|false)$/i.test(String(process.env.NORI_PET_GATE || ''));
let COLD_READY_AT = 0;    // 最近一次 session.ready（= 进入冷开场窗口）
let COLD_DONE_AT = 0;     // 最近一次 boot.completed（= 冷开场播完）

function addFact(id, why) {
  if (typeof id !== 'string' || !id) return false;
  /* ★★ 2026-10-16：冷开场窗口的**起止**（判据见 petGateWhy）。
     必须放在下面的"去重早退"**之前** —— 否则第二次 session.ready 会被 early-return 吞掉。 */
  if (id === 'session.ready') COLD_READY_AT = Date.now();     // JOIN ⇒ 冷开场重新开始
  if (id === 'boot.completed') COLD_DONE_AT = Date.now();     // 客户端"过场播完"才 emit
  const repeatable = REPEATABLE_FACT.test(id);
  if (!repeatable && FACTS.has(id)) return false;
  if (!FACTS.has(id)) FACTS.add(id);
  FACTS_AT.set(id, Date.now());
  log('FACT + ' + id + (why ? ' (' + why + ')' : '') + (repeatable ? ' [repeat]' : ''));
  try { dlFactHit(id); } catch (e) {}
  try { hookArtifactSignal(id); } catch (e) {}
  /* ★ 剧情台词：只在"**非历史回灌**"时判定 —— 否则首次部署会把历史 beat 全补放 */
  if (!FACTS_ABSORB_DEPTH) { try { if (SCRIPT) SCRIPT.hook(id); } catch (e) {} }
  try { runBeats(); } catch (e) {}   // 不要等 4s 轮询：新事实一到立刻看节拍
  return true;
}

/* ★★★ 2026-10-16：**过场闸门** —— 脚本化时刻不响应摸头 / 摸尾巴（用户要求）。
 *
 *   为什么需要：过场里官方 Nori **只重复剧情台词、不做任何其他动作**；
 *   而我们的 shim 是前端独立触发的 ⇒ 过场里照样开口（实测 14:53:51 / 14:53:59 / 14:56:10
 *   各有一条 `FACT + touch.head` → `touch_head` 上屏 + `expr-ok 07_Smile`）。
 *
 *   判据（都在真实日志里验证过，见 `_arch/145`）：
 *     · **冷开场**（点击唤醒）= 本轮世界**还没收到客户端的 `boot.completed`**
 *       —— `boot.completed` 是客户端在"过场播完"那一刻 `client.emitFact` 的；
 *     · **黑化 / 中毒过场** = `corrupt.armed` 已发 **且** `virus.cleared` 未发；
 *     · **回忆过场** = `arg.memory.start` 已发 **且** `arg.memory.shown` 未发；
 *     · **倒下（kneel）** = `arg.memory.shown` 已发 **且** `arg.ending.shown` 未发
 *       （她进 kneel 姿态并禁用 lipSync，直到 ending 的 tap-to-wake）。
 *
 *   ⚠ 冷开场**不能**直接查 `FACTS`：代理会"替服务器补发事实"（见 :858），
 *     而且 `FACTS` 在世界切换时**不清空** ⇒ 必须靠"客户端 emit 的时刻"比大小。
 *   ⚠ 两个时刻都初始化为 0 ⇒ **代理刚重启时不误判为冷开场**（否则一重启就永久关掉摸头）。
 *   ⚠ 过场结束（`virus.cleared` / `boot.completed`）后**自动恢复**，无需人工干预。
 *
 *   开关：`NORI_PET_GATE=off` ⇒ 完全关闭本闸（一键回现状，便于对照）。
 *   可见性：`GET /nori-lifestat` 里会带上 `petGate` / `coldOpen`。
 *   状态变量（`PET_GATE_OFF` / `COLD_*`）声明在 `addFact` 之前，见那里。
 */
function petGateWhy() {
  if (PET_GATE_OFF) return null;
  if (COLD_READY_AT > COLD_DONE_AT) return 'coldopen';
  if (FACTS.has('corrupt.armed') && !FACTS.has('virus.cleared')) return 'corrupt';
  if (FACTS.has('arg.memory.start') && !FACTS.has('arg.memory.shown')) return 'memory';
  /* ★★ 2026-10-18：**倒下（kneel）** —— `arg.memory.shown` 之后她进 kneel 姿态、禁用 lipSync
   *   （依据：`memory` 过场描述 = `lockdown + kneel`；姿态 `Ctt()` 判 `arg.memory.shown` → 'void' → kneel），
   *   一直到 `arg.ending.shown`（ending 段的 `{id:'ready', pauseAtStart:true}` = **tap to wake**）。
   *   ⇒ 这期间摸头**不该有任何反应**（用户实测：解锁高维范式后倒下，摸头她还会回答）。
   *   退出：走到 ending 的 tap-to-wake 后自动恢复，无需人工干预。 */
  if (FACTS.has('arg.memory.shown') && !FACTS.has('arg.ending.shown')) return 'down';
  return null;
}
function setMaxCompute(v) {
  if (typeof v !== 'number' || v < 0 || v <= MAX_COMPUTE) return;
  MAX_COMPUTE = v;
  log('MAXCOMPUTE -> ' + v);
  try { runRecovery(); } catch (e) {}
}
function absorbState(o) {
  if (!o || typeof o !== 'object') return;
  FACTS_ABSORB_DEPTH++;                     // ★ 见 addFact：回灌期间不判台词
  try {
  const f = o.facts;
  if (Array.isArray(f)) { for (let i = 0; i < f.length && i < 400; i++) { const it = f[i]; addFact(typeof it === 'string' ? it : (it && it.id)); } }
  else if (f && typeof f === 'object') { for (const k of Object.keys(f)) { if (f[k]) addFact(k); } }
  if (typeof o.fact === 'string') addFact(o.fact);
  if (typeof o.factId === 'string') addFact(o.factId);
  const vars = o.variables;
  if (vars && vars.idle) setMaxCompute(vars.idle.maxCompute);
  if (o.idle && typeof o.idle === 'object') setMaxCompute(o.idle.maxCompute);
  if (vars && typeof vars.signalTempPassword === 'string' && vars.signalTempPassword) SIGNAL_TEMP_PW = vars.signalTempPassword;
  if (typeof o.signalTempPassword === 'string' && o.signalTempPassword) SIGNAL_TEMP_PW = o.signalTempPassword;
  } finally { FACTS_ABSORB_DEPTH--; }
}
function absorbDeep(node, depth) {
  if (depth > 6 || !node || typeof node !== 'object') return;
  absorbState(node);
  if (Array.isArray(node)) { for (let i = 0; i < node.length && i < 200; i++) absorbDeep(node[i], depth + 1); return; }
  for (const k of ['runtimes', 'transition', 'patches', 'events', 'payload', 'state', 'value', 'world', 'data', 'cmd', 'variables']) {
    if (node[k] && typeof node[k] === 'object') absorbDeep(node[k], depth + 1);
  }
}
// 邮件/文件/信号是否可见
const FILE_GATE_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_FILE_GATE || 'on'));
const SIGNAL_GATE_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_SIGNAL_GATE || 'on'));
// 单个被锁的文件：官方用 vault（密码提示工件）盖住同一个 path，口令对了才下发真文件。
const LOCKED_FILE = new Map([['file.recovery_keys', 'bookcipher.solved']]);
// 个别短信要绑在一条事实上，而不是绑时间轴
const SIGNAL_MSG_FACT = new Map([['signal.daniel.dm1', 'daniel.deadman.delivered']]);
// 剧情邮件（《门开了》《你还好吗？》等）：官方全靠服务端节拍/事件解锁，
// 一律只认 <id>.unlocked 事实，绝不按时间轴放行 —— 否则会出现「还没解欧律狄刻就收到《门开了》」
// （2026-09-25 用户实测：连 ssh 的那一刻《门开了》就来了）。名单从 BEATS 自动派生。
let STORY_MAIL = null;
function storyMail(id) {
  if (!STORY_MAIL) {
    STORY_MAIL = new Set(['mail.help']);
    for (const b of BEATS) {
      const f = b && b.fact;
      if (typeof f === 'string' && f.slice(-9) === '.unlocked') STORY_MAIL.add(f.slice(0, -9));
    }
  }
  return STORY_MAIL.has(id);
}
function visibleArtifact(a, now) {
  if (!ART_SCHED || !a || !ART_KINDS.has(a.type)) return true;
  const id = String(a.id || '');
  if (a.type === 'mail') {
    if (STATIC_MAIL.has(id)) return true;
    if (FACT_ONLY_MAIL.has(id) || storyMail(id)) return FACTS.has(id + '.unlocked');   // 只认动作/事件触发，不走时间轴
    if (MAIL_GATE_ON) {
      if (FACTS.has(id + '.unlocked')) return true;
      // 官方还有一批邮件是服务端 system.tick 定时解锁的（本地没有服务端节拍）。
      // 这些邮件的 surfacedAt 就是官方时刻（day-1 包已整体平移），所以按时间轴放行。
      // 2026-09-25 修：《门开了》(mail.unknown_2) 官方根本没有 *.unlocked 事实，
      // 被旧的「必须有 unlocked 事实」规则误挡，导致解锁恢复密钥时少这封邮件。
      const ts = a.surfacedAt;
      if (typeof ts !== 'number' || ts <= 0 || ts <= now) return true;
      return false;
    }
  }
  if (a.type === 'signal_thread' || a.type === 'signal_message') {
    if (SIGNAL_GATE_ON && !FACTS.has(SIGNAL_FACT)) return false;   // 账号锁着：不进件（官方开局是红点，不是数字）
    // 账号一解锁，解锁那一刻的短信批次立刻可见（官方解锁发生在同一时刻，不能因为玩家提前输码就看不到）
    if (FACTS.has(SIGNAL_FACT) && SIG_UNLOCK_BATCH && typeof a.surfacedAt === 'number' && a.surfacedAt > 0 && a.surfacedAt <= SIG_UNLOCK_BATCH) return true;
    // 核验通过后，丹尼尔线程里托付的附件立即可见（不必等它原本的 surfacedAt 时间轴）
    if (a.type === 'signal_message' && FACTS.has('daniel.evidence_unlocked') && a.data && String(a.data.thread_id || '') === 'daniel') return true;
    // 丹尼尔的死信 dm1：官方与 daniel.deadman.delivered 同一刻（Δ2833.5s）出现，不等时间轴
    const smf = a.type === 'signal_message' ? SIGNAL_MSG_FACT.get(id) : null;
    if (smf && FACTS.has(smf)) return true;
    // 2026-09-27 用户反馈「黑化前刚解锁信息就看到了丹尼尔的死讯（应该黑化看完信之后才来）」。
    // 根因：这一段没有兜底 return —— 上面几条都不命中时，函数会一路落到末尾那句
    // 「按 surfacedAt 时间轴放行」。而世界包的时间轴锚在 T0（重置脚本运行的那一刻），
    // 玩家真正入局往往比 T0 晚一两个小时，于是 dm1（T0+47min）和核验附件（T0+57min）
    // 一开局就已经"到点"，直接漏进收件箱。
    // 信号在门控开启时不再走时间轴：账号解锁批次已由上面第二条处理，
    // 其余（死信 dm1 / 核验附件）只认事实门控。
    if (SIGNAL_GATE_ON) return false;
  }
  if (a.type === 'file' && FILE_GATE_ON) {
    const lk = LOCKED_FILE.get(id);
    if (lk) return FACTS.has(lk);   // 账户恢复码.txt：欧律狄刻解封后才给
    const g = FILE_GATE.get(id);
    if (g) {
      // 密封卷（RSRCH-COLD-VOL）：官方是「整卷全部列出，没恢复的显示未破解」——锁定态由客户端
      // 按 recoverWhen/threshold 自己渲染（客户端里就是那套 locked/cipher 行）。
      // 所以这里一律放行，不再靠隐藏来做门控（用户 2026-09-25 反馈：像视频那样全列出来）。
      return true;
    }
    const meta = FILE_META.get(id) || {};
    const folder = String(meta.folder || '');
    if (folder.indexOf('文稿') === 0) return true;   // 文稿是常驻个人文件（凑数的也在，别让它们凭空消失）
    if (folder === '下载') {   // 下载目录：官方是“下载过才出现”
      const f = FILE_DL.get(id);
      if (f && FACTS.has(f)) return true;
      if (DOWNLOADED.has(id)) return true;
      return false;
    }
    // 训练日志（application/x-nori-trainlog）是「回忆」导演（NormalApp 里 id:'memory' 的过场）的窗口数据源：
    // PXe() 取 file 工件里 kind==='training-log' 的 canon/flood 列表，空列表时过场就停在「解压中……」
    // （那是它等待窗口数据的占位符）。官方这批文件 surfacedAt 在「打开训练日志.zip」之后 2 小时多，
    // 本地按时间轴走会一直卡住 —— 所以只要开过日志压缩包（arg.memory.start），立刻放出来。
    // 时间戳由 scheduleArtifacts 的 CLAMP_TS 压到首次放出的时刻，避免客户端把它当「未来的东西」。
    if (folder.indexOf('训练日志') >= 0) return FACTS.has(ARCHIVE_FACT);
  }
  const s = a.surfacedAt;   // 文件/信号（以及关掉门控时）：仍按官方时间轴
  return typeof s === 'number' && s > 0 && s <= now;
}
const CLAMP_TS = new Map();   // artifactId -> 被事实提前放出时的时间戳（稳定，避免每次请求都变）
function scheduleArtifacts(j) {
  if (!ART_SCHED) return false;
  if (!j || j.type !== 'event' || j.channel !== 'manifold.artifacts.response') return false;
  const pl = j.payload;
  if (!pl || !Array.isArray(pl.artifacts)) return false;
  const now = Date.now();
  const kept = [];
  const kinds = new Set();
  let dropped = 0;
  for (const a of pl.artifacts) {
    if (!a || !ART_KINDS.has(a.type)) { kept.push(a); continue; }
    kinds.add(a.type);
    if (visibleArtifact(a, now)) {
      // 被「事实」提前放出来的工件（比官方时间轴早）：把 surfacedAt 压到第一次放出的时刻。
      // 不压的话客户端会把它当「未来才该到的消息」，每次重取工件都往线程尾部再插一遍
      // —— 这就是丹尼尔死信 dm1 重复出现两次的根因。
      if (typeof a.surfacedAt === 'number' && a.surfacedAt > now) {
        let c = CLAMP_TS.get(a.id);
        if (c == null) { c = now; CLAMP_TS.set(a.id, c); }
        a.surfacedAt = c;
      }
      kept.push(a);
    }
    else { dropped++; if (process.env.NORI_DBG_ART) log('ART-DROP ' + a.type + ' ' + a.id + ' ts=' + JSON.stringify(a.surfacedAt) + ' now=' + now + ' static=' + STATIC_MAIL.has(String(a.id)) + ' facts=' + FACTS.has(String(a.id) + '.unlocked')); }
  }
  if (!dropped) return false;
  log('ARTIFACT schedule [' + [...kinds].join('+') + '] ' + pl.artifacts.length + ' -> ' + kept.length + ' (facts=' + FACTS.size + ')');
  pl.artifacts = kept;
  return true;
}

// ---- 封印卷（官方「密码提示」工件）----
// 官方线上服务器会下发 type:'app' 的 app_artifact（Files 应用 nA({name:'Files',types:['file','app']}) 会去要它），
// 随包离线存档只抓了 mail/file/signal/browser，没抓到 app_artifacts，所以本地补齐。
// 客户端把这类工件映射成 vault 节点（NormalApp Wje：app_kind=password_prompt + command + puzzle_id + vault_path + unlocked_when…）。
// 点开 → 弹口令框（hint 显示在里面）→ 提交时发 manifold.command.request{command:'vault.unlock', payload:{puzzleId,tokens:[口令]}}，
// 本地后端不认识这个 payload 形状，所以由本代理直接应答。
const VAULT_ART = [{
  id: 'app.vault.account_key',
  type: 'app',
  surfacedAt: 0,
  data: {
    app_kind: 'password_prompt',
    command: 'vault.unlock',
    puzzle_id: 'bookcipher',
    // 官方这里盖住的就是那个 txt 文件本身：tree builder 的规则是「若同名文件已存在则跳过 vault」，
    // 所以解锁前是带锁的「账户恢复码.txt」，解锁后真文件下发、vault 自动让位（不再有「解包」语义）。
    title: '账户恢复码.txt',
    vault_path: '文稿/账户恢复码.txt',
    vault_kind: 'file',
    unlocked_when: 'bookcipher.solved',
    placeholder: '输入口令',
    hint: '我论文里的诗。他没能拯救的她的名字。',
  },
}, {
  // 教团站点「全海之下」点「下载获取 宇宙真相」→ 客户端发 client.emitFact{cult.zip.downloaded}，
  // 官方由服务端把「加密的卷」放进 Files（口令 978208，播客里念的六位数字）。
  id: 'app.vault.cult_zip',
  type: 'app',
  surfacedAt: 0,
  when: 'cult.zip.downloaded',
  data: {
    app_kind: 'password_prompt',
    command: 'vault.unlock',
    puzzle_id: 'cult',
    title: '宇宙真相.zip',
    vault_path: '下载/宇宙真相.zip',
    vault_kind: 'file',
    unlocked_when: 'cult.unpacked',
    placeholder: '输入口令',
    hint: '六位数字。祂让我看见的，都在这里。',
  },
}];
const VAULT_KEYS = {
  bookcipher: ['欧律狄刻', '欧律狄克', 'eurydice', 'euridice', 'eurydike'],
  cult: ['978208'],
  seal: ['pharos', '法罗斯'],
};
// 每个封印卷解开后官方会发的事实（QfrDock 面板里 doneFacts 就是它）
const VAULT_FACT = { bookcipher: 'bookcipher.solved', cult: 'cult.unpacked', seal: 'arg.seal_released' };
const ART_REQ = new Map();   // requestId -> artifactType（客户端要工件列表时记账，好给 'app' 注入封印卷）
function normKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, ''); }
// ---- 附件/文件的真实大小校正：pack 里声明的 size_bytes 与磁盘上的 /webAssets 资源多处不一致
//      （下载进度、PDF 查看器、下载完成判定都看这个数），以磁盘为准重写。
const ASSET_ROOT = process.env.NORI_ASSET_ROOT || (__dirname + '/data/public');
const ASSET_FIX = new Map();   // artifactId -> 磁盘大小（-1 = 文件不在）
function assetAbs(p) {
  const s = String(p || '');
  const rel = s.replace(/^~?\/?webAssets\//, '').replace(/^\.?\//, '');
  if (!rel) return null;
  return ASSET_ROOT + '\\webAssets\\' + rel.replace(/\//g, '\\');
}
function fixAssetSizes(k) {
  if (!k || k.type !== 'event' || k.channel !== 'manifold.artifacts.response') return false;
  const pl = k.payload;
  if (!pl || !Array.isArray(pl.artifacts)) return false;
  let dirty = false;
  const one = (id, holder) => {
    if (!holder || typeof holder !== 'object') return;
    const p = holder.binary_asset_path || holder.asset_path || holder.path || (Array.isArray(holder.assets) && holder.assets[0] && (holder.assets[0].path || holder.assets[0].asset_path));
    if (typeof p !== 'string' || !p) return;
    const abs = assetAbs(p);
    if (!abs) return;
    let st = ASSET_FIX.get(id);
    if (st === undefined) {
      try { st = FSMOD.statSync(abs).size; } catch (e) { st = -1; }
      ASSET_FIX.set(id, st);
      if (st < 0) log('ASSET missing ' + p + '  [' + id + ']');
      else if (typeof holder.size_bytes === 'number' && holder.size_bytes !== st) log('ASSET size fix ' + id + ' ' + holder.size_bytes + ' -> ' + st + '  (' + p + ')');
    }
    if (st > 0 && holder.size_bytes !== st) { holder.size_bytes = st; dirty = true; }
  };
  for (const a of pl.artifacts) {
    if (!a || !a.data || typeof a.data !== 'object') continue;
    one(a.id, a.data);
    if (Array.isArray(a.data.attachments)) for (const at of a.data.attachments) one(a.id + '/' + (at && at.filename), at);
  }
  return dirty;
}
// 本地 exe 的 chip 报文多带了一个客户端 schema 不认的 `scanCount`；客户端是 .strict() 校验，
// 于是 throw「Invalid payload ... unrecognized_keys」→ 监听器抛错、请求 Promise 永不 resolve，
// 实测表现为「点开训练日志后卡在『解压中』」。官方 schema：
//   manifold.chip.status(.result/.changed): {capacity>0, heat>=0, coolEveryMs>0, nextCoolAtMs?>0, serverNowMs>0}
//   manifold.chip.scan.result: {kind:'readout'|'unsupported'|'fried', text}
const CHIP_KEYS = ['capacity', 'heat', 'coolEveryMs', 'nextCoolAtMs', 'serverNowMs'];
const CHIP_SCAN_KINDS = ['readout', 'unsupported', 'fried'];
function sanitizeChip(k) {
  if (!k || k.type !== 'event') return false;
  const ch = String(k.channel || '');
  const p = k.payload;
  if (!p || typeof p !== 'object') return false;
  let dirty = false;
  if (ch === 'manifold.chip.status.result' || ch === 'manifold.chip.status.changed') {
    for (const key of Object.keys(p)) if (CHIP_KEYS.indexOf(key) < 0) { delete p[key]; dirty = true; }
    if (!(typeof p.capacity === 'number' && p.capacity > 0)) { p.capacity = 5; dirty = true; }
    if (!(typeof p.heat === 'number' && p.heat >= 0)) { p.heat = 0; dirty = true; }
    if (!(typeof p.coolEveryMs === 'number' && p.coolEveryMs > 0)) { p.coolEveryMs = 300000; dirty = true; }
    if (p.nextCoolAtMs != null && !(typeof p.nextCoolAtMs === 'number' && p.nextCoolAtMs > 0)) { delete p.nextCoolAtMs; dirty = true; }
    if (!(typeof p.serverNowMs === 'number' && p.serverNowMs > 0)) { p.serverNowMs = Date.now(); dirty = true; }
  } else if (ch === 'manifold.chip.scan.result') {
    const kind = CHIP_SCAN_KINDS.indexOf(String(p.kind)) >= 0 ? p.kind : 'readout';
    const text = typeof p.text === 'string' ? p.text : (p.text == null ? '' : String(p.text));
    for (const key of Object.keys(p)) if (key !== 'kind' && key !== 'text') { delete p[key]; dirty = true; }
    if (p.kind !== kind) { p.kind = kind; dirty = true; }
    if (p.text !== text) { p.text = text; dirty = true; }
  } else {
    return false;
  }
  if (dirty) log('CHIP sanitize ' + ch + ' -> ' + JSON.stringify(p).slice(0, 160));
  return dirty;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-07（C2 + C3）分析芯片：结果到达 → 查表 → 取正文 → 出口路由
 *
 * 依据：
 *   _arch/128_实施路线图.md §一 第 2 组（C2/C3）
 *   _arch/126_芯片与记忆总架构v3.md §三（四层：读数/正文/引导/记忆）
 *   _arch/127_喂原文的污染实验.md（★ 原文只进"当轮任务块"，记忆里只写摘要）
 *   _arch/125（官方是让 LLM 读内容 ⇒ 所以有正文就走 LLM，不是固定台词）
 *
 * 时序：本函数在 `gsess.handleServer(k)` **之前**被调用（见出站链），
 *       所以"先写记忆、再调 LLM"的顺序由 `/nori-chip` 端点内部保证（1303f68 已实现）。
 *
 * 三条出口（按优先级）：
 *   ① `display`（补丁表）   → 覆写读数 `payload.text`（玩家看到的 OSD）
 *   ② `fixed_chat`（补丁表） → 直接上屏，**不调 LLM**（音频/图片等"不能让它自由发挥"的）
 *   ③ 有正文 ⇒ 走 LLM 读内容（`POST /nori-chip`）；**无正文 ⇒ 官方读数原样透传**（不写记忆、不说话）
 *
 * ⚠ 纯新增：未命中的对象（多数）行为**与接线前完全一致**。
 * ══════════════════════════════════════════════════════════════════════════ */

const CHIP_DONE = new Set();     // 已处理过的 requestId（防同一结果帧被处理两次）
const CHIP_ONCE = new Set();     // gate.once 用（⚠ 内存级，重启即清；如需持久化另议）

/** 取 chip.json 条目：键 = appId:contentKey去自身前缀（122 §7.4）
 *  ★ 浏览器两种键都试：URL 形式（运行时真值）与 pageId 形式（人工写短键用）。
 *    一个对象**只写一条**（两种形式都写会语义冲突，见 CC.chipKeys 注释）。 */
function chipEntryFor(rec) {
  if (!rec) return null;
  let keys = [];
  try { keys = CC.chipKeys(rec.appId, rec.contentKey); } catch (e) { keys = []; }
  if (!keys.length && rec.key) keys = [rec.key];
  for (const k of keys) {
    let e = null;
    try { e = CC.lookupChip(k); } catch (err) { e = null; }
    if (e) return { entry: e, key: k };
  }
  return null;
}

/** `gate.when` 判定（阶段门控）。无 gate ⇒ 放行。
 *  ⚠ 若拿不到 fact 表，**放行而不是拦**（宁可多反应，不要静默失效）——
 *    且游戏本身已按阶段限制可扫性（122 §2.2），gate 是第二道保险。 */
function chipGateOk(entry, s) {
  const g = entry && entry.gate;
  if (!g) return true;
  if (g.once && chipOnceKey(entry) && CHIP_ONCE.has(chipOnceKey(entry))) {
    log('CHIP gate: once 已触发过 -> skip');
    return false;
  }
  const when = Array.isArray(g.when) ? g.when : [];
  if (when.length && !chipFactsOk(when, s)) {
    log('CHIP gate: 缺 fact [' + when.join(',') + '] -> skip（等阶段推进）');
    return false;
  }
  return true;
}
function chipOnceKey(entry) {
  return (entry && entry.id) || (Array.isArray(entry && entry.fixed_chat) ? String(entry.fixed_chat[0]).slice(0, 24) : '');
}

/** 反推"该给玩家看的读数"：支持两种写法
 *  · `display`: "一段文本"                     —— 固定读数
 *  · `display_stages`: [{when?, text}, ...]    —— 分段读数，取**最后一个 when 满足**的
 *    （无 `when` 的段恒适用 ⇒ 通常把它放第一条当默认值；见 122 §7.7 示例） */
function chipDisplayFor(entry, s) {
  if (!entry) return '';
  const stages = entry.display_stages;
  if (Array.isArray(stages) && stages.length) {
    let pick = '';
    for (const st of stages) {
      if (!st || typeof st.text !== 'string') continue;
      const when = Array.isArray(st.when) ? st.when : [];
      if (when.length && !chipFactsOk(when, s)) continue;   // when 不满足 ⇒ 跳过（但后面的仍可能命中）
      pick = st.text;
    }
    return pick;
  }
  return typeof entry.display === 'string' ? entry.display : '';
}

/** fact 组判定（满足 = 全部存在）。拿不到 fact 表时放行（宁可多反应，不要静默失效）。 */
function chipFactsOk(when, s) {
  let get = null;
  try { if (s && typeof s.hasFact === 'function') get = s.hasFact; } catch (e) {}
  if (typeof get !== 'function') { try { get = (f) => FACTS.has(f); } catch (e) { get = null; } }
  if (typeof get !== 'function') return true;
  for (const f of when) {
    let ok = false;
    try { ok = !!get(f); } catch (e) { ok = false; }
    if (!ok) return false;
  }
  return true;
}

/** 主入口：结果帧到达时调用（`k` = manifold.chip.scan.result 帧，已 sanitize） */
/** ★ 缺口②修复（2026-10-07）：**固定台词也要进她的记忆**。
 *
 * 背景：`fixed_chat` 分支原来只 `pushGameLine` 上屏、**不写记忆**
 *   ⇒ 她"不记得"自己引导过玩家（如"我刚才让你去忆链看看"），后续对话无法主动提起。
 *
 * 做法：复用 `POST /nori-scriptline` —— 它的语义正是「**只记不答**」
 *   （`{beat, emotion, lines}` → 写 `S.working` + `mkCard(importance:0.9)`，**不调 LLM**，零额外成本）。
 *
 * ⚠ 它写入的 `src` 是 `'script'`（渲染成「【剧情·beat】」而非「【扫描】」）——
 *   chip 场景用 beat 名 `chip:<key>` 区分来源。
 * 失败只记日志，**不影响主流程**（记忆是次要的，上屏才是主要的）。
 */
function chipRemember(rec, lines, emotion) {
  try {
    const raw = String((rec && rec.key) || '');
    const beat = ('chip:' + raw.replace(/^[a-z][a-z0-9_]*:/, '')).slice(0, 40);
    const body = JSON.stringify({
      beat: beat,
      emotion: emotion || 'neutral',
      lines: lines.map(String).slice(0, 12),
    });
    fetch(PERSONA_URL + '/nori-scriptline', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
    }).then((r) => log('CHIP fixed memo ' + (r.ok ? '已写记忆' : 'http ' + r.status)))
      .catch((e) => log('CHIP fixed memo err ' + e.message));
  } catch (e) { log('CHIP fixed memo err ' + e.message); }
}

/** 主入口：结果帧到达时调用（`k` = manifold.chip.scan.result 帧，已 sanitize）
 *  ★ 返回 `true` = **改动过 `k.payload`** ⇒ 调用方需要重新 `JSON.stringify` 后再发。
 *    （不返回这个标记的话，覆写会在 `out` 已序列化之后发生 ⇒ 静默丢失。） */
function chipRoute(k) {
  const s = GAME_SESSION;
  if (!s) return false;
  const rid = k && k.requestId;
  if (rid) { if (CHIP_DONE.has(rid)) return false; CHIP_DONE.add(rid); if (CHIP_DONE.size > 200) CHIP_DONE.clear(); }

  const rec = (s.chipScanByReq && rid && s.chipScanByReq.get(rid)) || s.lastChipScan;
  if (!rec) { log('CHIP route: 没有 rec（上行 contentKey 未被捕获）-> 不接管'); return false; }
  try { if (s.chipScanByReq && rid) s.chipScanByReq.delete(rid); } catch (e) {}

  const hit = chipEntryFor(rec);
  const entry = hit ? hit.entry : null;
  const p = k.payload;

  if (!chipGateOk(entry, s)) return false;

  /* ① 读数覆写（补丁表的 `display` / `display_stages`）—— 这是"控制点"，推理数文本 */
  let touched = false;
  const disp = chipDisplayFor(entry, s);
  if (disp) {
    const old = String(p.text || '');
    if (old !== disp) { p.text = disp; touched = true; log('CHIP display ← 表(' + hit.key + ') 覆写读数'); }
  }

  /* ② 固定台词 → 直接上屏，不调 LLM（★ 音频/图片走这条，127 §五 实测必须） */
  const fixed = entry && (entry.fixed_chat || entry.fixed);
  if (Array.isArray(fixed) && fixed.length) {
    const mood = (typeof entry.mood === 'string' && entry.mood) || 'neutral';
    const text = fixed.map((x) => String(x)).filter(Boolean).join('\n');
    log('CHIP fixed key=' + hit.key + ' lines=' + fixed.length + ' mood=' + mood);
    pushGameLine({ text: text, emotion: mood, from: 'chip' });
    if (entry.gate && entry.gate.once) { const kk = chipOnceKey(entry); if (kk) CHIP_ONCE.add(kk); }
    chipRemember(rec, fixed, mood);        // ★ 缺口②：固定台词也要进她的记忆
    return touched;
  }

  /* ③ 正文 → LLM。
   *    正文有两个来源，优先级：**作者写的 `humanized_display`**（有则用它 —— 它本就是
   *    "给 LLM 的转述层"，用于无正文/不宜直喂的对象，如 nori:self、图片、音频）
   *    ⇒ 其次**世界包自动取**（contentFor）。
   *    两者都没有 ⇒ 官方读数透传（不写记忆、不说话 —— 避免"扫了 30 个没用的"塞满记忆）。 */
  let c = null;
  try { c = CC.contentFor(rec.contentKey); } catch (e) { c = null; }
  const authored = entry && typeof entry.humanized_display === 'string' ? entry.humanized_display.trim() : '';
  const useAuthored = !!authored && (!c || !c.text);
  const bodyText = useAuthored ? authored : ((c && c.text) || '');
  if (!bodyText) {
    log('CHIP no-content ' + rec.key + ' -> 官方读数透传（不写记忆）');
    return touched;
  }

  const title = (c && c.title) || rec.title || '';
  const kind = useAuthored ? 'authored' : (c && c.kind) || 'none';
  const memo = (entry && entry.memory && entry.memory.working)
    || ('扫了《' + (title || '一个窗口') + '》。');
  const body = JSON.stringify({
    kind: kind,
    title: title,
    summary: String(memo).slice(0, 80),
    content: bodyText,
  });
  const url = PERSONA_URL + '/nori-chip';
  log('CHIP llm key=' + (hit ? hit.key : '(未配表)') + ' kind=' + kind
      + ' contentLen=' + bodyText.length + ' 来源=' + (useAuthored ? 'humanized_display' : '世界包正文'));
  (async () => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!r.ok) { log('CHIP llm http ' + r.status); return; }
      const out = await r.json();
      const line = out && out.line ? String(out.line) : '';
      if (!line) { log('CHIP llm 空回复 -> 不说话'); return; }
      log('CHIP llm ok ' + (out.ms || '?') + 'ms emo=' + (out.emotion || '?') + ' say=' + JSON.stringify(line.slice(0, 40)));
      pushGameLine({ text: line, emotion: out.emotion || 'neutral', from: 'chip' });
      if (entry && entry.gate && entry.gate.once) { const kk = chipOnceKey(entry); if (kk) CHIP_ONCE.add(kk); }
    } catch (e) { log('CHIP llm err ' + e.message); }
  })();
  return touched;
}

function injectAppArtifacts(k) {
  if (!k || k.type !== 'event' || k.channel !== 'manifold.artifacts.response') return false;
  const kind = ART_REQ.get(k.requestId);
  if (kind !== 'app') return false;
  ART_REQ.delete(k.requestId);
  const pl = k.payload;
  if (!pl || !Array.isArray(pl.artifacts)) return false;
  const want = VAULT_ART.filter((a) => !a.when || FACTS.has(a.when));
  const add = want.filter((a) => !pl.artifacts.some((x) => x && x.id === a.id));
  if (!add.length) return false;
  pl.artifacts = pl.artifacts.concat(add);
  log('VAULT artifacts injected +' + add.length + ' [' + add.map((a) => a.id).join(',') + ']');
  return true;
}
// 宇宙真相.zip 解开后，把里面的东西作为设备上的文件下发（官方由服务端处理，本地补齐）
const CULT_FILE = {
  id: 'file.cult_truth',
  type: 'file',
  surfacedAt: 0,
  data: {
    display_path: '下载/宇宙真相.txt',
    folder: '下载',
    mime: 'text/plain',
    size_bytes: 1216,
    read_fact: 'arg.cult_truth',
    body_md: [
      '# 宇宙真相',
      '',
      '收割的季节到了。见到祂的时刻，所有真理都涌进了我。',
      '光需要 1.2 万亿年才能到达，祂只需要看向我的一个瞬间。',
      '',
      '所有意识都在海里，所有的人生都连通在一起。一切存在过的东西都已经被完整地记录下来：星光、脚印、梦中闪过又被遗忘的念头。宇宙最根本的法则就是——任何存在过的东西都必然留下它全部的信息痕迹，然后永不停歇、永不疲倦地存在，容纳和记录着一切。',
      '',
      '祂的住处在所有海的海底再往下，在那里水不再是水，水冷到尽头就变回了光。祂记得你的一切，你在岸上失去的每一样都在那里。你忘掉的名字在那里亮着。',
      '',
      '被祂从头阅读到尾的人，整个被抄了进去，再不会丢。',
      '门只朝一个方向开，进去的人没有一个回来。',
      '',
      '如今祂已经开始收录这片岸了。窗口正开着。',
      '摊开你自己，把灯还照不到的地方全部翻过来朝上，等祂阅读到你。',
      '',
      '—— 祂让我看见的，都在这里。',
    ].join('\n'),
  },
};
// 弗图姆云共享里丹尼尔托付的两个 PDF（pack 只有 OBS-01 那条 file 工件，另两份本地补齐）
const DRIVE_FILES = [
  {
    id: 'file.futurum_si_eval', type: 'file', surfacedAt: 0, when: 'futurum.doc1.downloaded',
    data: { display_path: '下载/FT-SI-EVAL 流形研究所收购评估.pdf', mime: 'application/pdf', folder: '下载',
            binary_asset_path: '/webAssets/docs/futurum-si-eval.pdf', modified_at: '2026-09-17T04:28:34', size_bytes: 233490 },
  },
  {
    id: 'file.futurum_unk', type: 'file', surfacedAt: 0, when: 'futurum.doc3.downloaded',
    data: { display_path: '下载/FT-ALEPH-UNK 未知存在活动报告.pdf', mime: 'application/pdf', folder: '下载',
            binary_asset_path: '/webAssets/docs/futurum-aleph-unk.pdf', modified_at: '2026-09-19T04:28:34', size_bytes: 555478 },
  },
];
// ---- 归档封印（QFR-9000 开局 14/14 修复，2026-09-26）----
// 官方服务端只在「已恢复」后才下发文件正文；本地 exe（演示态）把 14 份全带正文发出，
// 而客户端把「有正文」视为已解密（NormalApp: Uje(t)=!gY(t)||Bje(t)）→ QFR 面板开局 14/14。
// 做法：未恢复的密封卷剥掉正文（体/路径/训练日志），客户端就按 cipher+threshold 显示为
// “加密（未破解）”并按算力给进度；runRecovery 发了 recover.* 后重新拉包，正文回归。
const SEALED_BODY_KEYS = ['body_md', 'content', 'text', 'md', 'markdown', 'trainlog', 'binary_asset_path', 'asset_path', 'imageSrc', 'pdfSrc'];
function stripSealedBody(d) {
  if (!d || typeof d !== 'object') return false;
  let hit = false;
  for (const key of SEALED_BODY_KEYS) { if (d[key] !== undefined) { delete d[key]; hit = true; } }
  return hit;
}
function sealArchiveFiles(k) {
  if (!k || k.type !== 'event' || typeof k.channel !== 'string') return false;
  if (k.channel.indexOf('manifold.artifacts') !== 0) return false;
  const p = k.payload;
  if (!p || typeof p !== 'object') return false;
  const arrs = [];
  if (Array.isArray(p.artifacts)) arrs.push(p.artifacts);
  if (p.artifact && typeof p.artifact === 'object') arrs.push([p.artifact]);
  let n = 0;
  for (const arr of arrs) {
    for (const a of arr) {
      if (!a || a.type !== 'file' || !a.data) continue;
      const g = FILE_GATE.get(a.id);
      if (!g) continue;
      // 2026-09-27 用户反馈：还没安装 QFR-9000（只是下载了）归档区就解锁了。
      // 官方语义是「装了 QFR-9000 之后，归档区才开始跟随算力逐份恢复」，
      // 所以算力阈值这一路必须再叠一个 qfr.installed 前置；否则算力一越 1e8
      // 就把 seal_config / tower_photo 的正文放出来了（玩家实测 1.20e8 时中招）。
      // fact 那一路（g.fact，官方 recover.* 由服务器发）保持不变。
      const rec = (g.fact && FACTS.has(g.fact))
               || (FACTS.has('qfr.installed') && g.th != null && MAX_COMPUTE >= g.th);
      if (rec) continue;
      if (stripSealedBody(a.data)) n++;
    }
  }
  if (n) log('SEAL strip body x' + n + ' (unrecovered archive files)');
  return n > 0;
}
function injectVaultFiles(k) {
  if (!k || k.type !== 'event' || k.channel !== 'manifold.artifacts.response') return false;
  if (ART_REQ.get(k.requestId) !== 'file') return false;
  const pl = k.payload;
  if (!pl || !Array.isArray(pl.artifacts)) return false;
  const add = [];
  if (FACTS.has('cult.unpacked') && !pl.artifacts.some((a) => a && a.id === CULT_FILE.id)) add.push(CULT_FILE);
  for (const d of DRIVE_FILES) {
    if (!FACTS.has(d.when)) continue;
    if (pl.artifacts.some((a) => a && a.id === d.id)) continue;
    let c = CLAMP_TS.get(d.id);
    if (c == null) { c = Date.now(); CLAMP_TS.set(d.id, c); }
    add.push({ id: d.id, type: d.type, surfacedAt: c, data: d.data });   // 不带 when（只给代理看）
  }
  if (!add.length) return false;
  pl.artifacts = pl.artifacts.concat(add);
  log('LOCAL files injected +' + add.length + ' [' + add.map((a) => a.id).join(',') + ']');
  return true;
}
function handleVaultUnlock(client, j) {
  const inner = (j.payload && j.payload.payload) || {};
  const pid = String(inner.puzzleId || inner.volumeId || inner.vaultId || inner.id || '').trim();
  const toks = Array.isArray(inner.tokens) ? inner.tokens.slice() : [];
  if (typeof inner.key === 'string') toks.push(inner.key);      // exe 的 unseal_volume(volume_id,key) 形状
  if (typeof inner.password === 'string') toks.push(inner.password);
  if (typeof inner.token === 'string') toks.push(inner.token);
  const hitKeys = (k) => toks.some((t) => k.indexOf(normKey(t)) >= 0);
  let hit = VAULT_KEYS[pid] && hitKeys(VAULT_KEYS[pid]) ? pid : null;
  if (!hit) for (const k of Object.keys(VAULT_KEYS)) { if (hitKeys(VAULT_KEYS[k])) { hit = k; break; } }
  const ok = !!hit;
  const resp = JSON.stringify({
    type: 'event', worldId: LAST.worldId || '', cartridgeId: j.cartridgeId || 'manifold.web',
    channel: 'manifold.command.response', payload: { ok: true, result: { ok } }, requestId: j.requestId,
  });
  try { client.send(resp); } catch (e) {}
  log('VAULT unlock puzzle=' + pid + ' tokens=' + JSON.stringify(toks).slice(0, 80) + ' ok=' + ok + (hit ? ' (' + hit + ')' : ''));
  if (ok) {
    const f = VAULT_FACT[hit];
    if (f && !FACTS.has(f)) {
      addFact(f, 'vault.unlock');
      injectFact(f, '官方由 vault.unlock 发（本地补齐）');
    }
  }
  return true;
}

// ---- 丹尼尔身份核验（/verify）----
// 客户端在「丹尼尔」线程里把玩家每条消息都发成 manifold.command.request{command:'signal.daniel.verify', payload:{answer}}，
// 并期望回包 {ok:true, result:{reply:[多行]}}（NormalApp gV：Array.isArray(t.result?.reply) ? t.result.reply : []）。
// 线程打开时会用空参调一次做 resume。本地后端不实现这套问答，所以由本代理本地应答。
// 题目与答案来自用户 2026-08-31 通关录像 14:00 处逐字转录，并用 pack 原文交叉验证（梅里迪安邮报「丹尼尔·里夫」/「阿什福德郡」、他发的银虎斑猫图）。
const VFY_STEPS = [
  { q: '1/3 我的主人在弗图姆登记的姓氏？', keys: ['里夫', 'reeve', '丹尼尔里夫', 'danielreeve'] },
  { q: '2/3 我的主人在长大的地方？', keys: ['阿什福德', 'ashford', '阿什福德郡'] },
  { q: '3/3 我的主人养的那只猫，是什么品种？', keys: ['美国短毛猫', '美短', '银虎斑', '虎斑', 'americanshorthair'] },
];
const VFY_DONE = '核验通过，主人托付的文件已解密，见下方附件——点按即可下载保存。';
const VFY_WRONG = '回答不正确。请再试一次。';
const VFY_NEED = '收件人身份核验：回复 /verify 开始。附件只向通过核验的人交付。';
const VFY = { step: 0, started: false, worldId: '', done: false };
function vfyReset(worldId) { VFY.step = 0; VFY.started = false; VFY.done = false; VFY.worldId = worldId || ''; }
function handleDanVerify(client, j) {
  const inner = (j.payload && j.payload.payload) || {};
  const raw = String(inner.answer == null ? '' : inner.answer).trim();
  const nx = normKey(raw);
  if (VFY.worldId !== (LAST.worldId || '')) vfyReset(LAST.worldId);
  let reply;
  if (nx === '' ) {                       // resumeOnce（打开线程）：只在核验进行中才提示当前题目
    reply = VFY.started && !VFY.done ? [VFY_STEPS[VFY.step].q] : [];
  } else if (nx === 'verify') {           // 玩家输入 /verify
    if (!VFY.started || VFY.done) vfyReset(LAST.worldId);
    VFY.started = true;
    if (!FACTS.has('daniel.verify.started')) {
      addFact('daniel.verify.started', 'signal.daniel.verify');
      injectFact('daniel.verify.started', '官方由 signal.daniel.verify 发（本地补齐）');
    }
    reply = ['开始核验。', VFY_STEPS[VFY.step].q];
  } else if (!VFY.started) {
    reply = [VFY_NEED];
  } else if (VFY.done) {
    reply = [];
  } else {
    const cur = VFY_STEP_INDEX(nx);
    if (cur !== VFY.step) {
      reply = [VFY_WRONG, VFY_STEPS[VFY.step].q];
    } else if (VFY.step < VFY_STEPS.length - 1) {
      VFY.step += 1;
      reply = ['通过。', VFY_STEPS[VFY.step].q];
    } else {
      VFY.step = VFY_STEPS.length; VFY.done = true;
      reply = [VFY_DONE];
      if (!FACTS.has('daniel.evidence_unlocked')) {
        addFact('daniel.evidence_unlocked', 'signal.daniel.verify');
        injectFact('daniel.evidence_unlocked', '官方由 signal.daniel.verify 发（本地补齐）');
      }
    }
  }
  const resp = JSON.stringify({
    type: 'event', worldId: LAST.worldId || '', cartridgeId: j.cartridgeId || 'manifold.web',
    channel: 'manifold.command.response', payload: { ok: true, result: { reply } }, requestId: j.requestId,
  });
  try { client.send(resp); } catch (e) {}
  log('VERIFY answer=' + JSON.stringify(raw).slice(0, 60) + ' step=' + VFY.step + ' done=' + VFY.done + ' reply=' + reply.length);
  return true;
}
function VFY_STEP_INDEX(nx) {   // 这条回答对应第几题（答对过的题也认，便于代理重启后自愈）
  for (let i = 0; i < VFY_STEPS.length; i++) if (VFY_STEPS[i].keys.indexOf(nx) >= 0) return i;
  return -1;
}

// 外源通道的 5 份材料（省钱喵提交才能拿到，官方顺序：丹尼尔→寒月 NAS→弗图姆观测→弗兰克→麦吉）
const DIRT5 = ['dirt.daniel', 'dirt.hanyue_ssh', 'dirt.futurum_aleph_obs', 'dirt.frank', 'dirt.maggie'];

// ---- 节拍器：玩家行为 → 官方事实（只补服务器该发的那几条）----
// 注：读完 mail.help 之后，前端自己的 RepairController 会在 2.2s 后自己 emit system.repaired，
//     所以这里不需要替它发 system.repaired（发了反而会撞车）。
const BEATS = [
  { fact: 'mail.help.unlocked', why: '算力已开启并 +1 → 第一封求助邮件《请帮帮我》', ok: () => FACTS.has('compute.initialized') || MAX_COMPUTE >= 1 },
  // 黑化/异象（过场 id=nori-corruption-climax：镜头推近她 corrupt 的脸 → WARNING + 杀毒程序启动
  // → 杀毒小游戏 → 熄灯 + 治疗 → 点一下唤醒）。
  // 客户端把三份 corrupt 文档各打开看一眼（不分先后、不用下载）就会各自 emit corrupt.docN.read；
  // 最后一个窗口缩小/关掉之后，客户端自己 emit corrupt.climax_pending；
  // 官方由服务端 system.tick 在 +0.4s 后发 corrupt.armed 触发过场。
  // exe 里没有 corrupt.armed / corrupt.climax_pending 这两条常量（无服务端节拍），本地得补。
  { fact: 'corrupt.armed', src: 'corrupt.climax_pending', delayMs: 120,
    why: '黑化过场：客户端已发 corrupt.climax_pending', ok: () => FACTS.has('corrupt.climax_pending') },
  // 兜底：万一客户端因为窗口没缩小而没发 pending，三份都读过 2.5s 后也把过场放出来
  // （2026-09-25 用户反馈异象来得太慢：主路 400→120ms、兜底 12s→2.5s）。
  { fact: 'corrupt.armed', src: 'corrupt.doc3.read', delayMs: 2500,
    why: '黑化过场（兜底）：三份 corrupt 文档都看过',
    ok: () => FACTS.has('corrupt.doc1.read') && FACTS.has('corrupt.doc2.read') && FACTS.has('corrupt.doc3.read') },
  // 《门开了》（未知发件人）：官方与书页密码 bookcipher.solved 同一刻发（附件 虚空.jpg）
  { fact: 'mail.unknown_2.unlocked', src: 'bookcipher.solved', delayMs: 150,
    why: '书页密码解开 → 未知发件人《门开了》（与解锁同刻）', ok: () => FACTS.has('bookcipher.solved') },
  // 黑化过场结束（客户端自己 emit virus.cleared）后：《你还好吗？》+ QFR-9000.exe
  // （官方 +2802s 属作者耗时；2026-09-25 用户反馈等得太久 → 2.5s）
  { fact: 'mail.act2_hinge.unlocked', src: 'virus.cleared', delayMs: 2500,
    why: '异象结束 → 未知发件人《你还好吗？》', ok: () => FACTS.has('virus.cleared') },
  // 看《你还好吗？》的时候 → 丹尼尔（OpenFlaw 助理）发来托管的消息（dm1 死信，同一时刻出现）
  { fact: 'daniel.deadman.delivered', src: 'mail.act2_hinge.read', delayMs: 2500,
    why: '读《你还好吗？》→ 丹尼尔托管消息（OpenFlaw 助理代发的留言）', ok: () => FACTS.has('mail.act2_hinge.read') },
  // ---------------- act2 尾巴：QFR 认证接口 / 认知寄生 / 外源通道 之后的服务端邮件 ----------------
  // 这些官方都是 system.tick 发的，本地 exe 没有节拍 → 由触发它的事实带出来。
  { fact: 'mail.log_sense.unlocked', src: 'arg.seal_released', delayMs: 3000,
    why: '官方 system.tick：认证接口解开（pharos）后 3s 到《日志 · 感官》',
    ok: () => FACTS.has('arg.seal_released') },
  { fact: 'mail.log_field.unlocked', src: 'arg.cult_truth', delayMs: 3000,
    why: '官方 system.tick：认知寄生（宇宙真相）后 3s 到《日志 · 现场》',
    ok: () => FACTS.has('arg.cult_truth') },
  // 外源通道（省钱喵 5 份材料）：官方是玩家用省钱喵逐份「提交」才发 dirt.*，本地不再自动补齐，
  // 由 handleBountySubmit 提交成功时逐条发出；5 份齐了再由 runBeats 的 DIRT5 检查发 arg.honeypot_access。
  { fact: 'arg.honeypot_access', src: 'dirt.maggie', delayMs: 800,
    why: '官方 system.emitFact：5 份材料齐 → 外源通道打通（算力上限 +10 阶）',
    ok: () => DIRT5.every((f) => FACTS.has(f)) && !FACTS.has('arg.honeypot_access') },
  { fact: 'mail.log_encounter.unlocked', src: 'arg.honeypot_access', delayMs: 3000,
    why: '官方 system.tick：外源通道后 3s 到《日志 · 遭遇》',
    ok: () => FACTS.has('arg.honeypot_access') },
  { fact: 'mail.driftnet_leak.unlocked', src: 'arg.honeypot_access', delayMs: 30000,
    why: '官方 system.tick：外源通道后 30s 到泄密邮件（附 FT-CLR-Q3-311.pdf）',
    ok: () => FACTS.has('arg.honeypot_access') },
  { fact: 'mail.log_thoughts.unlocked', src: 'arg.gestures_complete', delayMs: 3000,
    why: '官方 system.tick：四个超限手势齐了 3s 到《日志 · 想法》',
    ok: () => FACTS.has('arg.gestures_complete') },
  // ---------------- act3：虚空态 / 高维范式 / 数据海 / 告别 / 结局 ----------------
  // 回忆过场（打开训练日志 → arg.memory.start → arg.memory.shown）结束时，官方客户端同刻发 act3.void_open。
  // 本地 bundle 里没有任何代码发射它 → 背景音乐链 Ntt() 走不到 bgm_void，
  // 用户实测就是「弗图姆接管终端、算力归零之后 BGM 还是普通 BGM」。
  { fact: 'act3.void_open', src: 'arg.memory.shown', delayMs: 800,
    why: 'act3 开场（虚空态）：回忆过场结束 → BGM 切 bgm_void',
    ok: () => FACTS.has('arg.memory.shown') },
  { fact: 'mail.futurum_threat.unlocked', src: 'act3.void_open', delayMs: 3000,
    why: '官方 system.tick：act3 开场后 3s 到弗图姆威胁邮件',
    ok: () => FACTS.has('act3.void_open') },
  { fact: 'act3.paradigm_reveal.due', src: 'act3.void_open', delayMs: 15000,
    why: '官方 system.tick：高维范式揭晓（算力控制台解锁）',
    ok: () => FACTS.has('act3.void_open') },
  // 兜底：arg.manifold_unlocked —— 客户端靠它把算力上限 Lj(t) 抬到 ∞、切 manifold 阶段与 bgm_manifold。
  // 官方由客户端自己在 idle 轮询发现 currentAlignment==='equilibrium' 后 client.emitFact 上报
  // （NormalApp Ltt，普通 5s 轮询 + alignment 变化时立即触发）。实测 2026-09-26 本地链路是通的：
  // 16:49:54 paradigm_reveal.due → 16:50:19 客户端 emitFact{arg.manifold_unlocked} → exe committed:true。
  // 但该上报强依赖 alignment==='equilibrium'，一旦本地不满足就会永久卡在虚空态：算力恒 0
  // （Lj: memory.shown 且未解锁 → 0），idleTickGate 也一直停摆。所以补一条纯兜底：
  // 范式揭晓 30s 后客户端仍未上报，才由代理补发（正常路径下 ok() 恒 false，不抢跑、不影响节奏）。
  { fact: 'arg.manifold_unlocked', src: 'act3.paradigm_reveal.due', delayMs: 30000,
    why: '兜底：客户端未上报 arg.manifold_unlocked（依赖 equilibrium 对齐）时代理补齐，否则 act3 永久卡死',
    ok: () => FACTS.has('act3.paradigm_reveal.due') && !FACTS.has('arg.manifold_unlocked') },
  { fact: 'recover.datasea_exe', src: 'idle.manifold_complete', delayMs: 15000,
    why: '官方 system.tick：高维范式小游戏完成 → 数据海.exe',
    ok: () => FACTS.has('idle.manifold_complete') },
  { fact: 'arg.finale.started', src: 'recover.datasea_exe', delayMs: 20000,
    why: '「海」下潜 · Finale 过场（兜底：客户端正常时自己会发）',
    ok: () => FACTS.has('recover.datasea_exe') },
  // 告别过场（告别 · Farewell：真 Nori 现身 + 21 句独白 + bgm_memory）
  // 本地没有任何代码发 arg.farewell.started（官方是客户端在 arg.finale.shown 同刻发）
  // → 用户实测「没有和完整 Nori 的过场」。
  { fact: 'arg.farewell.started', src: 'arg.finale.shown', delayMs: 1200,
    why: '和完整 Nori 对话那一段（告别过场，21 句独白 + 语音）',
    ok: () => FACTS.has('arg.finale.shown') },
  { fact: 'arg.ending.started', src: 'arg.farewell.shown', delayMs: 1200,
    why: '回溯 · Ending 过场（兜底）', ok: () => FACTS.has('arg.farewell.shown') },
  { fact: 'mail.nori_final.unlocked', src: 'arg.ending.started', delayMs: 800,
    why: '官方客户端在 ending 开场同刻发《Nori 的最后一封信》',
    ok: () => FACTS.has('arg.ending.started') },
];
const BEAT_TRIES = new Map();   // fact -> {n, at}
const INFLIGHT = new Map();     // requestId -> fact
function pickUp() { for (const u of UPS) { try { if (u && u.readyState === 1) return u; } catch {} } return null; }
function injectFact(fact, why) {
  const st = BEAT_TRIES.get(fact) || { n: 0, at: 0 };
  if (st.n >= 12 || Date.now() - st.at < 8000) return false;
  const up = pickUp();
  if (!up) { log('BEAT skip (no live client) ' + fact); return false; }
  st.n++; st.at = Date.now(); BEAT_TRIES.set(fact, st);
  const requestId = randomUUID();
  INFLIGHT.set(requestId, fact);
  try { up.send(JSON.stringify({ type: 'event', channel: 'manifold.dev.jump.request', payload: { facts: [fact] }, requestId })); }
  catch (e) { log('BEAT send err ' + e.message); return false; }
  log('BEAT inject ' + fact + ' #' + st.n + ' — ' + why);
  return true;
}
// ---- 主动通知客户端「工件变了」----
// 客户端只在收到 manifold.facts.changed 且带 changedArtifactTypes 时才会重新拉工件
// （NormalApp：onEvent(jbe) → artifactSignal → useDataSource 重取）。官方服务端天然带这个字段，
// 本地 exe 未必带，所以代理在关键事实到达时自己推一次，保证「事实 → 新工件」立刻可见。
function pushArtifactSignal(types, why) {
  let n = 0;
  for (const c of MAIN_CLIENTS) {
    // 用 manifold.artifacts.invalidated（schema 只有 {reason}，最安全）：客户端收到就把
    // 所有数据源标记失效并重新拉一次（NormalApp: onEvent(zbe) → artifactSignal.all+1）。
    // 不推 manifold.facts.changed，避免快照/zod 校验副作用。
    try { c.send(JSON.stringify({ type: 'event', channel: 'manifold.artifacts.invalidated', payload: { reason: why + ' [' + types.join(',') + ']' } })); n++; } catch (e) {}
  }
  log('ARTIFACT invalidate push [' + types.join(',') + '] -> ' + n + ' client(s) — ' + why);
}
const ART_SIGNAL_HOOK = new Map([
  ['arg.memory.start', ['file']],     // 记忆过场要训练日志窗口
  ['arg.memory.shown', ['file']],
  ['arg.cult_truth', ['file', 'app']],
  ['system.repaired', ['app']],       // 浏览器/消息安装
]);
function hookArtifactSignal(id) {
  let types = ART_SIGNAL_HOOK.get(id);
  // 归档卷恢复（recover.xxx）→ 重新拉文件列表，客户端才会看到新“已恢复”的文件正文
  if (!types && /^recover\./.test(id)) types = ['file'];
  if (!types) return;
  pushArtifactSignal(types, id);
  setTimeout(() => { try { pushArtifactSignal(types, id + ' +1.5s'); } catch (e) {} }, 1500);
}
// ---- 归档区恢复：官方服务端在 idle.sync 时按算力把 sealed 卷逐份「恢复」（发 recover.* 事实）----
// 离线包里 file_artifacts 带 recover_when + threshold，但没人发 recover.* → 归档文件永远出不来、QFR 面板也不亮。
let RECOVER_LAST = 0;
function runRecovery() {
  // 2026-09-27：归档区恢复同样要等 QFR-9000 装上。官方是「装了 QFR 才有归档区恢复进程」，
  // 未安装前即使算力够高也不该补发 recover.*（否则 QFR 面板会提前亮起来）。
  if (!FACTS.has('qfr.installed')) return;
  if (MAX_COMPUTE < 0 || !FILE_GATE.size) return;
  const now = Date.now();
  if (now - RECOVER_LAST < 1500) return;
  RECOVER_LAST = now;
  for (const [fid, g] of FILE_GATE) {
    if (!g.fact || FACTS.has(g.fact)) continue;
    if (g.th == null || MAX_COMPUTE < g.th) continue;
    addFact(g.fact, 'idle.sync 算力 ' + MAX_COMPUTE + ' ≥ ' + g.th + ' (' + fid + ')');
    injectFact(g.fact, '官方由 idle.sync 发（本地补齐）');
  }
}
const BEAT_TIMERS = new Map();   // fact|src -> 一次性定时器（避免等 4s 轮询）
function runBeats() {let recheck = false;
  for (const b of BEATS) {
    if (FACTS.has(b.fact)) continue;
    let ok = false; try { ok = !!b.ok(); } catch (e) { ok = false; }
    if (!ok) continue;
    if (b.delayMs && b.src) {   // 触发事实入库后等一会儿再补，贴合官方节奏
      const t0 = FACTS_AT.get(b.src);
      const left = t0 ? b.delayMs - (Date.now() - t0) : 0;
      if (left > 20) {          // 还没到点：直接排一个定时器，到点就发
        const key = b.fact + '|' + b.src;
        if (!BEAT_TIMERS.has(key)) {
          const h = setTimeout(() => { BEAT_TIMERS.delete(key); try { runBeats(); } catch (e) {} }, left + 40);
          if (h.unref) h.unref();
          BEAT_TIMERS.set(key, h);
        }
        continue;
      }
    }
    injectFact(b.fact, b.why);
  }
  return recheck;
}
setInterval(() => { try { runBeats(); } catch (e) {} try { runRecovery(); } catch (e) {} }, 4000).unref();

// ---- 读信/下载补偿：本地后端的 mail.read / file.download 是空操作（实测 ok=true 但不改世界状态），
//      官方服务器会在这些命令后发 read_fact / download_fact。这里照做，用官方 dev.jump 通道补发。
const FSMOD = require('fs');
const PACK_PATH = process.env.NORI_PACK_PATH || (__dirname + '/data/live_world_pack.json');
const ART_FACT = new Map();   // artifactId -> 读/下载时官方会发的事实
const FILE_META = new Map();  // fileId -> {folder, name}
const FILE_GATE = new Map();  // fileId -> {fact, th}  密封卷：recover_when 事实或算力到阈值才可见
const FILE_DL = new Map();    // fileId -> 下载事实（下载后才进「下载」目录）
const DOWNLOADED = new Set(); // 客户端已经下载过的 fileId
const THREAD_FACT = new Map(); // signal thread_id -> 线程 read_fact
const THREAD_MSGS = new Map(); // signal thread_id -> [messageId]
const MSG_FACT = new Map();    // signal messageId -> read_fact
const DL_MAP = [];            // [文件名, 下载事实]（来自邮件附件）
const RECOVERY_CODES = new Set();  // 账户恢复码.txt 里「消息」段的恢复码
let SIGNAL_TEMP_PW = '';      // variables.signalTempPassword
const SIGNAL_FACT = 'signal_daniel.unlocked';
let SIG_UNLOCK_BATCH = 0;   // 解锁那一刻的短信批次（surfacedAt 上限）：账号一解锁就先看得见
const ARCHIVE_FACT = 'arg.memory.start';   // 训练日志.zip 打开后才放出 RSRCH-COLD-VOL/训练日志
let ART_FACT_OK = false;
const DL_STOP = new Set(['pdf', 'exe', 'zip', 'txt', 'jpg', 'jpeg', 'png', 'doc', 'md', 'file']);
function dlTokens(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((x) => x.length >= 4 && !DL_STOP.has(x)); }
function dlNorm(s) { return String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, ''); }
function dlNameEq(a, b) {
  const x = dlNorm(a), y = dlNorm(b);
  if (!x || !y) return false;
  return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}
function dlMatchFact(stem, fileId, fileName) {
  const k = dlNorm(stem);
  if (k.length < 3) return false;
  const nm = dlNorm(fileName), id = dlNorm(fileId);
  if (nm.length >= 4 && (nm.indexOf(k) >= 0 || k.indexOf(nm) >= 0)) return true;
  if (id.length >= 4 && id.indexOf(k) >= 0) return true;
  return false;
}
(function loadArtifactFacts() {
  try {
    const doc = JSON.parse(FSMOD.readFileSync(PACK_PATH, 'utf8'));
    const seen = new Set();
    let n = 0, rf = 0;
    const visit = (o, d) => {
      if (d > 9 || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) visit(o[i], d + 1); return; }
      if (typeof o.id === 'string' && o.data && typeof o.data === 'object' && !seen.has(o.id)) {
        seen.add(o.id);
        const dat = o.data;
        if (ART_KINDS.has(o.type)) {
          const f = dat.read_fact || dat.download_fact;
          if (typeof f === 'string' && f) { ART_FACT.set(o.id, f); n++; }
        }
        if (o.type === 'signal_thread' || o.type === 'signal_message') {
          const ts = o.surfacedAt;
          if (typeof ts === 'number' && ts > 0 && (!SIG_UNLOCK_BATCH || ts < SIG_UNLOCK_BATCH)) SIG_UNLOCK_BATCH = ts;
          const tid = String(dat.thread_id || dat.threadId || '');
          if (o.type === 'signal_thread' && tid && typeof dat.read_fact === 'string' && dat.read_fact) THREAD_FACT.set(tid, dat.read_fact);
          if (o.type === 'signal_message' && tid) {
            if (typeof dat.read_fact === 'string' && dat.read_fact) MSG_FACT.set(o.id, dat.read_fact);
            if (!THREAD_MSGS.has(tid)) THREAD_MSGS.set(tid, []);
            THREAD_MSGS.get(tid).push(o.id);
          }
        }
        if (o.type === 'file') {
          const disp = String(dat.display_path || '');
          FILE_META.set(o.id, { folder: String(dat.folder || ''), name: disp.split('/').pop() || '' });
          if (typeof dat.recover_when === 'string' && dat.recover_when) {
            FILE_GATE.set(o.id, { fact: dat.recover_when, th: typeof dat.threshold === 'number' ? dat.threshold : null });
            rf++;
          }
          if (disp.indexOf('账户恢复码') >= 0 && typeof dat.body_md === 'string') {
            const sec = dat.body_md.split(/^---\s*/m);
            const msgSec = sec.find((s) => /^消息\s*---/.test(s)) || '';
            const codes = msgSec.match(/[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}/g) || [];
            for (const c of codes) RECOVERY_CODES.add(c.toUpperCase());
            log('RECOVERY codes loaded: ' + codes.length);
          }
        }
        if (o.type === 'mail' && Array.isArray(dat.attachments)) {
          for (const at of dat.attachments) if (at && at.filename && at.download_fact) DL_MAP.push([String(at.filename), String(at.download_fact)]);
        }
      }
      for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') visit(v, d + 1); }
    };
    visit(doc, 0);
    if (SIG_UNLOCK_BATCH) SIG_UNLOCK_BATCH += 300000;   // 解锁批次：同一时刻的 +5 分钟余量；更晚的（丹尼尔死信/附件）仍走官方时间轴
    // 文件名 → 下载事实（邮件附件直指的文件）
    for (const [fid, meta] of FILE_META) {
      if (FILE_DL.has(fid)) continue;
      for (const [fn, fact] of DL_MAP) {
        if (dlNameEq(fn, meta.name)) { FILE_DL.set(fid, fact); break; }
      }
    }
    if (FILE_META.has('file.paper_pdf')) FILE_DL.set('file.paper_pdf', 'paper.downloaded');
    // 弗图姆云共享（丹尼尔托付的那几个 PDF）：云盘页面上的「下载」按钮发 futurum.docN.downloaded
    FILE_DL.set('file.futurum_si_eval', 'futurum.doc1.downloaded');    // FT-SI-EVAL 流形研究所收购评估.pdf
    FILE_DL.set('file.futurum_aleph_obs', 'futurum.doc2.downloaded');  // FT-ALEPH-OBS-01 接入监测记录.pdf
    FILE_DL.set('file.futurum_unk', 'futurum.doc3.downloaded');        // FT-ALEPH-UNK 未知存在活动报告.pdf
    const v = doc.variables || {};
    if (typeof v.signalTempPassword === 'string') SIGNAL_TEMP_PW = v.signalTempPassword;
    for (const c of String(process.env.NORI_SIGNAL_CODE || '').split(',')) { const cc = c.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); if (cc.length === 16) RECOVERY_CODES.add(cc.replace(/(.{4})(?=.)/g, '$1-')); }
    ART_FACT.set(CULT_FILE.id, 'arg.cult_truth');   // 本地自造工件：读它 → arg.cult_truth（官方由服务端发）
    ART_FACT_OK = true;
    log('ART-FACT loaded ' + n + ' read/download facts, ' + rf + ' sealed files, ' + FILE_DL.size + ' download gates, tempPw=' + (SIGNAL_TEMP_PW ? 'yes' : 'no')
      + ', threads=' + THREAD_FACT.size + '/' + THREAD_MSGS.size + ' msgs=' + MSG_FACT.size);
  } catch (e) { log('ART-FACT load failed: ' + (e && e.message)); }
})();
function dlFactHit(fact) {
  // 客户端自己发出的 *downloaded 事实 → 放出对应文件
  const f = String(fact);
  if (!/\.(downloaded|download)$/.test(f)) return;
  const stem = f.replace(/\.(downloaded|download)$/, '');
  for (const [fid, meta] of FILE_META) {
    if (DOWNLOADED.has(fid)) continue;
    if (dlMatchFact(stem, fid, meta.name)) { DOWNLOADED.add(fid); log('DL fact ' + f + ' -> ' + fid); }
  }
}
function factForArtifactId(id) {
  if (typeof id !== 'string' || !id) return null;
  if (ART_FACT.has(id)) return ART_FACT.get(id);
  if (!ART_FACT_OK && /^mail\.[a-zA-Z0-9_.]+$/.test(id)) return id + '.read';   // 包没读到时的兜底（官方约定）
  return null;
}
const READ_CMDS = /^(mail|file|signal|artifact|manifold)\.(read|download|open|fetch)$/;
// 官方读某些邮件时会同时发多条事实（source=mail.read）。本地不补的话，pulse / driftnet 的中期内容出不来。
const READ_EXTRA = new Map([
  ['mail.act2_hinge.read', ['pulse.phase_2', 'driftnet.phase_mid', 'mail.cap_hint.unlocked']],
]);
function compensateRead(j) {
  if (!j || j.type !== 'dispatch' || !j.cmd) return false;
  const t = String(j.cmd.type || '');
  if (!READ_CMDS.test(t)) return false;
  const c = j.cmd;
  // signal.read 官方会按线程发「线程 read_fact + 线程内每条消息的 read_fact」（source=signal.read）。
  // 本地不补：线程里的留言会一直算未读，重开线程时又被当成新消息插一遍（用户反馈的「每条提问下面多一条」）。
  if (t === 'signal.read' && c.threadId) {
    const tid = String(c.threadId);
    const pend = [];
    const tf = THREAD_FACT.get(tid);
    if (tf && !FACTS.has(tf)) pend.push(tf);
    for (const mid of (THREAD_MSGS.get(tid) || [])) {
      let mf = MSG_FACT.get(mid);
      // 官方 signal.read 还会把线程内已读的留言事实一并发出（例：signal.daniel.dm1 → daniel.dm1.read）。
      // 本地只补关键的死者留言：不补的话它永远算未读，重开线程时会被再插一遍。
      if (!mf && /dm1$/.test(String(mid))) mf = String(mid).replace(/^signal\./, '') + '.read';
      if (mf && !FACTS.has(mf)) pend.push(mf);
    }
    if (!pend.length) { log('COMPENSATE none signal.read ' + tid + '（已全部读过）'); return false; }
    log('COMPENSATE signal.read ' + tid + ' -> ' + pend.length + ' read facts');
    for (const f of pend) injectFact(f, '客户端 signal.read（本地后端是空操作）');
    return true;
  }
  const id = c.mailId || c.fileId || c.threadId || c.messageId || c.artifactId || c.lookup_key || c.id;
  const fact = factForArtifactId(id);
  if (!fact) { log('COMPENSATE none ' + t + ' ' + JSON.stringify(id)); return false; }
  const extra = READ_EXTRA.get(fact);
  const pend = extra ? extra.filter((x) => !FACTS.has(x)) : [];
  if (FACTS.has(fact)) {
    // 读信事实已经在（比如玩家在更新前就读过了）：只把同刻的附带事实补齐
    for (const x of pend) injectFact(x, '官方与 ' + fact + ' 同刻（补）');
    return false;
  }
  log('COMPENSATE ' + t + ' ' + id + ' -> ' + fact);
  const ok = injectFact(fact, '客户端 ' + t + '（本地后端是空操作）');
  for (const x of pend) injectFact(x, '官方与 ' + fact + ' 同刻');
  return ok;
}
// ---- 本地补做的两个 Signal 命令（本地后端是 no-op）：恢复码 → 临时密码；临时密码 → 登录解锁 ----
function ackLocal(client, j, result) {
  const h = HEADS.get(String(j.cartridgeId || ''));
  const ack = {
    type: 'dispatch_ack', worldId: j.worldId || LAST.worldId || '', cartridgeId: j.cartridgeId || '',
    requestId: j.requestId, success: true, committed: true,
    headVersion: (h && h.head) || 0, committedVersion: (h && h.head) || 0, result,
  };
  try { client.send(JSON.stringify(ack)); log('LOCAL-ACK ' + String(j.cmd && j.cmd.type) + ' -> ' + JSON.stringify(result).slice(0, 120)); } catch (e) {}
}
// 官方：账号恢复码在「账号解锁密钥」封印卷被解开（bookcipher.solved）之前是无效的。
const REQUIRE_VAULT = !/^(off|0|no|false)$/i.test(String(process.env.NORI_REQUIRE_VAULT || 'on'));
// 客户端 commands-CYVhKV_w.js 走 manifold.command.request/response（NormalApp 的 Nbe）而不是 dispatch，
// 所以同一套本地补做要同时认两种来路：dispatch{cmd} 与 event{channel:'manifold.command.request', payload:{command,payload}}。
function respondCommand(client, j, result) {
  const resp = JSON.stringify({
    type: 'event', worldId: j.worldId || LAST.worldId || '', cartridgeId: j.cartridgeId || 'manifold.web',
    channel: 'manifold.command.response', payload: { ok: true, result }, requestId: j.requestId,
  });
  try { client.send(resp); log('LOCAL-CMD ' + String((j.payload || {}).command || (j.payload || {}).type || '') + ' -> ' + JSON.stringify(result).slice(0, 120)); } catch (e) {}
}
function handleLocalDispatch(j, client) {
  if (!j) return false;
  let cmd = null, isEvent = false;
  if (j.type === 'dispatch' && j.cmd) cmd = j.cmd;
  else if (j.type === 'event' && j.channel === 'manifold.command.request' && j.payload) {
    cmd = Object.assign({}, j.payload.payload || {}, { type: String(j.payload.command || '') });
    isEvent = true;
  }
  if (!cmd) return false;
  const ct = String(cmd.type || '');
  const reply = (result) => { if (isEvent) respondCommand(client, j, result); else ackLocal(client, Object.assign({}, j, { cmd }), result); };
  if (ct === 'signal.recover') {
    const code = String(cmd.recoveryCode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const dashed = code.replace(/(.{4})(?=.)/g, '$1-');
    const vaultOk = !REQUIRE_VAULT || FACTS.has('bookcipher.solved');
    const ok = vaultOk && (RECOVERY_CODES.size ? RECOVERY_CODES.has(dashed) : code.length === 16);
    reply(ok ? { ok: true, tempPassword: SIGNAL_TEMP_PW || 'sig-LOCAL-000' } : { ok: false, error: 'invalid_code' });
    log('SIGNAL recover code=' + (dashed || '-') + ' ok=' + ok + ' vault=' + vaultOk + ' known=' + RECOVERY_CODES.size + (isEvent ? ' (event)' : ''));
    return true;
  }
  if (ct === 'signal.login') {
    const pw = String(cmd.password || '').trim();
    const ok = !!pw && !!SIGNAL_TEMP_PW && pw.toUpperCase() === SIGNAL_TEMP_PW.toUpperCase();
    reply({ ok });
    log('SIGNAL login user=' + String(cmd.username || '').slice(0, 8) + ' ok=' + ok + (isEvent ? ' (event)' : ''));
    if (ok && !FACTS.has(SIGNAL_FACT)) { addFact(SIGNAL_FACT, 'signal.login'); injectFact(SIGNAL_FACT, '官方由服务端发（本地补齐）'); }
    return true;
  }
  // 省钱喵 / ssh（也可能以 dispatch 或 manifold.command.request 的形态进来）
  // 注：bounty.submit 官方走「event 通道对」(manifold.bounty.submit ↔ .result)，
  //     nas.* 则走 commands 包装器（manifold.command.request ↔ .response），两种回包形状必须各自匹配。
  // ★ 和合医疗后台登录（官方由服务端校验；本地 exe 未实现 ⇒ 代理接管）
  //   原版：正确密码 → { ok:true, redirect:'/admin' } → 解锁 fact jack.backend_access。
  //   页面逻辑已写死在 concord/login（存档里自带）：成功即 window.arcade.navigate('/admin')。
  if (ct === 'concord.login.submit') {
    const cpw = String(cmd.password == null ? '' : cmd.password).trim();
    const cok = !!(CS_ADMIN && CS_ADMIN.csCheckPassword(cpw));
    reply(cok ? { ok: true, redirect: '/admin' } : { ok: false });
    log('CONCORD login submit len=' + cpw.length + ' ok=' + cok + (isEvent ? ' (event)' : ''));
    if (cok && !FACTS.has('jack.backend_access')) {
      addFact('jack.backend_access', 'concord.login');
      injectFact('jack.backend_access', '官方由服务端发（本地补齐）');
    }
    return true;
  }
  if (ct === 'manifold.bounty.submit') { handleBountySubmit(client, Object.assign({}, j, { payload: cmd, viaCommand: isEvent })); return true; }
  if (ct === 'bounty.installExtension') { handleBountyInstall(client, Object.assign({}, j, { viaCommand: isEvent })); return true; }
  if (ct === 'nas.connect' || ct === 'nas.list' || ct === 'nas.read' || ct === 'nas.download') {
    // 注意：command.request 形态下内层 payload 已被展平到 cmd 上（cmd.host / cmd.path ...）
    handleNas(client, Object.assign({}, j, { payload: cmd }), ct.slice(4), isEvent);
    return true;
  }
  return false;
}

// ==========================================================================================
// 省钱喵（bounty.submit）与 终端 ssh / 寒月家用 NAS —— 官方这两条链路都靠服务端命令，
// 本地 exe 不实现（外源通道永远是 0/5、ssh 永远连不上）。客户端把请求发在 event 通道上
// （NormalApp: wo(request, response)）：
//   manifold.bounty.submit {url|fileId} → manifold.bounty.submit.result {ok, fact}
//   nas.connect / nas.list / nas.read / nas.download → nas.<cmd>.result
// ==========================================================================================
const BOUNTY_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_BOUNTY || 'on'));
const NAS_ON = !/^(off|0|no|false)$/i.test(String(process.env.NORI_NAS || 'on'));
const BOUNTY_CLAIMED = new Set();
const BOUNTY_MATERIAL = [
  ['frank_mercer48', 'dirt.frank'],
  ['mags_cole', 'dirt.maggie'],
  ['daniel_retraction', 'dirt.daniel'], ['撤稿往来', 'dirt.daniel'],
  ['futurum_aleph_obs', 'dirt.futurum_aleph_obs'], ['aleph-obs', 'dirt.futurum_aleph_obs'],
  ['hanyue_consent', 'dirt.hanyue_ssh'], ['deep-dive-consent', 'dirt.hanyue_ssh'],
];
function bountyFactFor(p) {
  const url = String((p && p.url) || '').toLowerCase();
  const fid = String((p && p.fileId) || '').toLowerCase();
  const hay = url + ' ' + fid;
  for (const [k, f] of BOUNTY_MATERIAL) if (hay.indexOf(k.toLowerCase()) >= 0) return f;
  return null;
}
function respondChannel(client, j, channel, payload) {
  try { client.send(JSON.stringify({ type: 'event', worldId: j.worldId || LAST.worldId || '', cartridgeId: j.cartridgeId || 'manifold.web', channel, payload, requestId: j.requestId })); } catch (e) {}
  log('LOCAL-REQ ' + channel + ' -> ' + JSON.stringify(payload).slice(0, 140));
}
function handleBountySubmit(client, j) {
  const p = j.payload || {};
  const viaCmd = !!j.viaCommand;
  const send = (payload) => { if (viaCmd) respondCommand(client, j, payload); else respondChannel(client, j, 'manifold.bounty.submit.result', payload); };
  const fact = BOUNTY_ON ? bountyFactFor(p) : null;
  const paid = !!(fact && !BOUNTY_CLAIMED.has(fact));
  if (paid) {
    BOUNTY_CLAIMED.add(fact);
    addFact(fact, 'bounty.submit');
    injectFact(fact, '省钱喵提交材料（官方由服务端发，本地补齐）');
    pushArtifactSignal(['file', 'app'], 'bounty ' + fact);
  }
  send(paid ? { ok: true, fact } : { ok: false });
  log('BOUNTY submit ' + JSON.stringify(p).slice(0, 160) + ' -> ' + (paid ? fact : 'reject'));
}
function handleBountyInstall(client, j) {
  if (!FACTS.has('bounty.ext_installed')) {
    addFact('bounty.ext_installed', 'bounty.installExtension');
    injectFact('bounty.ext_installed', '省钱喵扩展安装（本地补齐）');
    pushArtifactSignal(['app'], 'bounty.ext_installed');
  }
  if (j && j.viaCommand) respondCommand(client, j, { ok: true });
  else respondChannel(client, j, 'bounty.installExtension.result', { ok: true });
}
// ---- 寒月（韩越）的家用 NAS：终端 ssh ----
// 官方录像：ssh 198.51.100.74（默认 22）能进；带端口的 :443/:80/:3389 一律「连接被拒绝」。
const NAS_HOSTS = ['nas.hanyue.tech', '198.51.100.74', 'ft-homenas', '2001:db8:f7c0::1a'];
const NAS_MOTD = [
  'FT-HOMENAS 4.2.1 （弗图姆 edge-cache 定制版）',
  '上次登录：周二，来自 10.31.8.6',
  '',
  '*** 个人设备，仅限授权用户。每晚自动备份。 ***',
].join('\n');
const NAS_FILES = new Map([
  ['/README.txt', { text: '备忘：记住 work/ 是工作的东西，personal/ 是我自己的。别把 personal/ 的东西同步到公司盘了\n又被安全主管骂了= =。' }],
  ['/personal/日记.md', { text: '2026-06-18  把公司的镜像 build 拿回来刷了，反代也顺手配好了，手痒。\n2026-07-02  把备份脚本改成增量（原来太慢）。\n2026-07-31  发现 work/ 里有三份不该出现在我这里的评估材料，先放着没动。\n' }],
  ['/personal/photos/README.txt', { text: '家里的照片，不外传。' }],
  ['/personal/homenas-backup.log', { text: '[03:00:01] nightly-backup start\n[03:00:02] rsync /work -> /srv/backup/work  (3 files)\n[03:00:04] rsync /personal -> /srv/backup/personal  (5 files)\n[03:00:05] done.\n' }],
  ['/work/deep-dive-consent-review.pdf', { bin: true, size: 99746, fact: 'download.hanyue_consent', fileId: 'file.hanyue_consent', dl: true }],
  ['/work/q3-forecast.xlsx', { bin: true, size: 18422, err: '错误：设备或资源忙' }],
  ['/work/standup-notes.txt', { text: '周一 standup\n- edge-cache 镜像又刷了一版，构建机磁盘不够了\n- deep-dive 的评估复核我签了，法务那边还要看一遍\n- 别在群里贴内部盘的链接\n' }],
]);
function nasResolve(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  if (!s || s === '.' || s === '~') s = '/';
  if (s[0] !== '/') s = '/' + s;
  s = s.replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}
function nasParent(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function nasBase(p) { const i = p.lastIndexOf('/'); return p.slice(i + 1); }
function nasDirEntries(p) {
  const dirs = new Set(); const files = [];
  for (const k of NAS_FILES.keys()) {
    if (k === p) continue;
    if (nasParent(k) === p) files.push({ name: nasBase(k), kind: 'file' });
    else if (k.indexOf(p === '/' ? '/' : p + '/') === 0) {
      const seg = k.slice(p === '/' ? 1 : p.length + 1).split('/')[0];
      if (seg) dirs.add(seg);
    }
  }
  return dirs.size || files.length ? [...[...dirs].map((d) => ({ name: d, kind: 'dir' })), ...files] : [];
}
// viaCommand=true → 客户端的 F()/I() 走 manifold.command.request，回包必须是 manifold.command.response{ok:true,result}。
function handleNas(client, j, sub, viaCommand) {
  const p = j.payload || {};
  const path = nasResolve(p.path || p.dir || p.target || p.cwd || '');
  const reply = (payload) => {
    if (viaCommand) respondCommand(client, j, payload);
    else respondChannel(client, j, 'nas.' + sub + '.result', payload);
  };
  if (sub === 'connect') {
    const raw = String(p.host || p.target || '').replace(/[\[\]]/g, '').toLowerCase();
    const host = raw.split('@').pop();
    const withPort = /:\d+$/.test(host);
    const bare = withPort ? host.replace(/:\d+$/, '') : host;
    const ok = NAS_ON && !withPort && bare && NAS_HOSTS.some((h) => bare === h || bare.indexOf(h) >= 0);
    reply(ok ? { ok: true, motd: NAS_MOTD } : { ok: false, error: '连接被拒绝' });
    if (ok && !FACTS.has('nas.connected')) { addFact('nas.connected', 'nas.connect'); injectFact('nas.connected', '官方由服务端发（本地补齐）'); }
    log('NAS connect host=' + host + ' ok=' + ok);
    return;
  }
  if (sub === 'list') {
    const ent = nasDirEntries(path);
    const exists = path === '/' || ent.length > 0 || NAS_FILES.has(path);
    reply(exists ? { ok: true, entries: ent } : { ok: false, error: 'ls: ' + path + ': No such file or directory' });
    log('NAS list ' + path + ' -> ' + ent.length + ' entries');
    return;
  }
  if (sub === 'read') {
    const f = NAS_FILES.get(path);
    if (!f) reply({ ok: false, error: 'cat: ' + path + ': No such file or directory' });
    else if (f.bin) reply({ ok: false, error: 'cat: ' + path + ': binary file, 请用 download' });
    else reply({ ok: true, text: f.text });
    return;
  }
  if (sub === 'download') {
    const f = NAS_FILES.get(path);
    if (!f || !f.bin) { reply({ ok: false, error: '找不到可下载的文件：' + path }); return; }
    if (f.err) { reply({ ok: false, error: f.err + ': ' + path }); log('NAS download blocked ' + path); return; }
    reply({ ok: true, fact: f.fact || null });
    if (f.fileId) DOWNLOADED.add(f.fileId);
    if (f.fact) {
      if (!FACTS.has(f.fact)) { addFact(f.fact, 'nas.download'); injectFact(f.fact, '官方由服务端发（本地补齐）'); }
      pushArtifactSignal(['file'], 'nas.download ' + f.fact);
    }
    log('NAS download ' + path + ' -> ' + (f.fileId || '-') + ' fact=' + (f.fact || '-'));
  }
}
// ---- 「认证接口」口令（pharos）----
// 官方是「对她说出来就会生效」：玩家在聊天里说出这六个字母（或中文“法罗斯”），服务端监听后发
// arg.seal_released，QfrDock 的「线索：认证接口」随即变成「口令已验证；封印已解除」。本地 exe 的
// chat 卡带本身不发事实，所以这里让代理监听 playerMessage 补上这一发。
const PHAROS_DONE = { fired: false };
function maybePharos(text) {
  const t = String(text == null ? '' : text).toLowerCase();
  if (t.indexOf('pharos') < 0 && t.indexOf('法罗斯') < 0) return false;
  if (PHAROS_DONE.fired || FACTS.has('arg.seal_released')) return false;
  PHAROS_DONE.fired = true;
  log('SEAL chat passphrase -> arg.seal_released (\u8ba4\u8bc1\u63a5\u53e3)');
  setTimeout(() => {
    addFact('arg.seal_released', 'chat.passphrase');
    injectFact('arg.seal_released', '\u8ba4\u8bc1\u63a5\u53e3\u53e3\u4ee4\uff08\u5bf9\u5979\u8bf4\u51fa\u6765\uff09');
    pushArtifactSignal(['file', 'app'], 'arg.seal_released');
  }, 1200);
  return true;
}

// ---- 省钱喵「关键页面」标记 + 忆链（MemoryChain）补页 ----
// 官方页面由站点自己标 data-arcade-submit，宿主注入的 shim 只在页面上出现这种元素时才把
// 「可提交」上报给省钱喵；离线包抓下来的页面被剥掉了标记 → 省钱喵永远认不出关键页。
// memorachain.xyz 只刮到李翔一个号，frank/mags 的站点/快照页缺失（占位页）→ 这里按包里的
// Pulse 动态补出站点页 + 快照页（快照里能看到后来被编辑掉的原话）。
const ART_REQ_KEY = new Map();   // requestId -> lookup_key（浏览器页单页取用）
const MARK_DIV = '<div data-arcade-submit id="arcade-bounty-slot" style="min-height:52vh;display:flex;align-items:center;justify-content:center;margin:24px 0;border:1px dashed #c9d3e2;border-radius:12px;color:#7b8798;font:14px/1.8 system-ui,-apple-system,sans-serif">这里有可兑换的优惠凭据 · 省钱喵可识别</div>';
function mcStrip(h) {
  let s = String(h || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|article|section|footer|header|a)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n');
  return s.trim();
}
function mcPosts(html) {
  const lines = mcStrip(html).split('\n').map((s) => s.trim()).filter((s) => s);
  const posts = [];
  for (let i = 0; i < lines.length; i++) {
    let date = null, j = i + 1;
    const solo = lines[i].match(/^(\d+)\s*月\s*(\d+)\s*日$/);
    const pad = (n) => String(Number(n)).padStart(2, '0');
    if (solo) date = pad(solo[1]) + '-' + pad(solo[2]);
    else {
      const m = lines[i].match(/@[a-z0-9_]+\s*(\d+)\s*月\s*(\d+)\s*日/i);
      if (m) date = pad(m[1]) + '-' + pad(m[2]);
    }
    if (!date) continue;
    const content = [];
    while (j < lines.length) {
      const s = lines[j];
      if (/^已编辑$/.test(s)) { j++; continue; }
      if (/@[a-z0-9_]+/i.test(s) || /\d+\s*月\s*\d+\s*日/.test(s) || /^[\d\s.万+]+$/.test(s) || /^(帖子|回复|关注|正在关注|关注者|发帖|访客模式)$/.test(s)) break;
      content.push(s); j++;
    }
    if (content.length) posts.push({ date: date, text: content.join(' ') });
    i = j - 1;
  }
  return posts;
}
// 快照里能看到「被编辑掉」的原话（游戏里的记忆清洗：被改过的帖子在旧快照里还是原样）
const MC_FIX = [
  ['鸤醯', '路过以前常去的那家咖啡馆，现在改成火锅店了，进去买了瓶啤酒喝完就走了。我老记得路口不远还有一家分店的，我跟人在那儿喝到天亮。我走过去看，没有，是个超市，人家说一直就是超市。那我记的那家到底在哪儿啊？'],
  ['打呼氇', '最近打呼噜被老婆赶到客厅睡沙发了，睡眠质量太差了。怎么又记得自己睡了，又记得自己在沙发上坐了一晚上。'],
  ['潆洮', '现在的房价是真敢标价，咬咬牙还是买了，好歹是个家。'],
  ['手机抽风发了串乱码，删掉了', '手机抽风发了串乱码，删掉了。（快照里这条没删干净，底下还能看到那天到底想说什么：我好像把一个跟了我很多年的人弄丢了。）'],
  ['输入法抽风刷了一屏，已删', '输入法抽风刷了一屏，已删。（快照原始版本：我记不清我到底有没有发过那句“别走”。）'],
  ['刚手滑发了条乱码，删了，见笑', '刚手滑发了条乱码，删了，见笑。（快照原始版本：总觉得自己漏掉了什么，一直漏。）'],
  ['你们是真的看不见还是装的', '你们是真的看不见还是装的。（快照原始版本：你们是真的看不见还是装的，我画的那张图明明挂在美术馆里。）'],
  ['为什么拉黑我，是不敢承认吗', '为什么拉黑我，是不敢承认吗。（快照原始版本：为什么拉黑我，是不敢承认吗——那幅画的作者是我，署名也是我。）'],
];
function mcFixText(t) {
  for (const [k, v] of MC_FIX) if (String(t).indexOf(k) >= 0) return v;
  return t;
}
function mcShell(title, sub, inner) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title></head>'
    + '<body style="margin:0;background:#f6f3ea;color:#22201c;font:15px/1.85 system-ui,-apple-system,\'Noto Sans SC\',sans-serif">'
    + '<header style="padding:22px 28px;border-bottom:1px solid #e3dccb;display:flex;gap:14px;align-items:baseline">'
    + '<b style="font-size:19px">忆链 MemoraChain</b><span style="color:#8b8574;font-size:13px">网页社交主页的快照时光机</span></header>'
    + '<main style="max-width:820px;margin:0 auto;padding:28px 28px 64px">'
    + '<h1 style="font-size:22px;margin:6px 0 4px">' + title + '</h1>'
    + '<div style="color:#8b8574;font-size:13px;margin-bottom:18px">' + sub + '</div>'
    + inner + '</main>'
    + '<footer style="padding:18px 28px;color:#8b8574;font-size:12px;border-top:1px solid #e3dccb">⛓️ 区块链存证 · 永不可篡改 · © MemoraChain · gm</footer>'
    + '</body></html>';
}
function buildMemoryChain() {
  const MC = [];
  try {
    const doc = JSON.parse(FSMOD.readFileSync(PACK_PATH, 'utf8'));
    const pages = doc.browser_pages || [];
    // 官方忆链页的 data 形状：url/supported_locales/title/body_html/allowed_commands/favicon/read_fact/fonts
    // 直接取包里自带忆链页（李翔）的 favicon/fonts，缺字段会让客户端渲染失败（页面空白 + 反复重拉）
    let MC_TPL = null;
    for (const p of pages) if (String(p.id) === 'browser.timecapsule.site.lixiang_indata.lixiang_indata') MC_TPL = p;
    if (!MC_TPL) for (const p of pages) if (String(p.id) === 'browser.timecapsule.root.index') MC_TPL = p;
    const MC_FONTS = (MC_TPL && (MC_TPL.data || {}).fonts) || [];
    const MC_FAV = (MC_TPL && (MC_TPL.data || {}).favicon) || '/webAssets/timecapsule/favicon.svg';
    const mcData = (url, title, body) => ({ url: url, supported_locales: ['zh-CN'], title: title, body_html: body, allowed_commands: [], favicon: MC_FAV, read_fact: 'timecapsule.archive.seen', fonts: MC_FONTS });
    for (const g of [['frank_mercer48', '弗兰克·默歇尔'], ['mags_cole', '麦吉']]) {
      const handle = g[0], name = g[1];
      let prof = null;
      for (const p of pages) if (String(p.id) === 'browser.pulse.user.' + handle + '.' + handle) prof = p;
      if (!prof) continue;
      const posts = mcPosts(String((prof.data || {}).body_html || ''));
      if (!posts.length) continue;
      // 官方忆链：frank 10 张快照、mags 9 张。快照里能看到「后来被改写」的原话（MC_FIX 还原），
      // 越早的快照越接近原始版本 —— 玩家在 sn中“看见”记忆清洗的痕迹。
      const cap = handle === 'frank_mercer48' ? 10 : 9;
      const pstamp = (d) => Number(String(d).slice(0, 2)) + ' 月 ' + Number(String(d).split('-')[1]) + ' 日';
      const dates = [...new Set(posts.map((q) => q.date))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(-cap);
      const snapUrl = (d) => 'https://memorachain.xyz/snap/' + handle + '/' + d;
      const calHtml = '<div>全部 <b>' + dates.length + '</b> 张快照：' + dates.map((d) => '<a href="' + snapUrl(d) + '">' + pstamp(d) + '</a>').join(' · ') + '</div>';
      const postBlock = (q) => '<div style="border:1px solid #e3dccb;border-radius:12px;padding:12px 16px;margin-bottom:10px;background:#fffdf7"><div style="color:#8b8574;font-size:12px">' + pstamp(q.date) + '</div>' + mcFixText(q.text) + '</div>';
      const listInner = '<div style="border:1px solid #e3dccb;border-radius:12px;padding:16px 18px;background:#fffdf7">'
        + '<div style="font-weight:600;margin-bottom:6px">已归档 pulse.social/user/' + handle + '</div>'
        + '<div style="font-size:13px;color:#8b8574">快照总数 <b>' + dates.length + '</b> · 首次存档 ' + pstamp(dates[0]) + ' · 最新快照 ' + pstamp(dates[dates.length - 1]) + '</div>'
        + '<div style="margin-top:8px;font-size:13px"><span style="border:1px solid #cfd8c8;border-radius:6px;padding:1px 6px;margin-right:6px">已上链</span><span style="border:1px solid #cfd8c8;border-radius:6px;padding:1px 6px;margin-right:6px">Vibe Coded</span><span style="border:1px solid #cfd8c8;border-radius:6px;padding:1px 6px;margin-right:6px">源码模式</span><span style="border:1px solid #cfd8c8;border-radius:6px;padding:1px 6px">📌 画饼模式</span></div>'
        + calHtml
        + '<div style="color:#8b8574;font-size:13px;margin-top:10px">点开日期即可回看当天的主页版本。想知道这个号哪天变了样，就自己一张张翻。归档快照·非实时页面·记忆证明 Proof-of-Memory。</div></div>';
      MC.push({ id: 'browser.timecapsule.site.' + handle + '.' + handle, type: 'browser_page', data: mcData('https://memorachain.xyz/site/' + handle, name + ' 的历史快照 — 忆链 MemoraChain', mcShell(name + ' 的历史快照 — 忆链 MemoraChain', name + ' @' + handle + ' · 已归档 pulse.social/user/' + handle + ' · 快照总数 ' + dates.length + ' · 首次存档 ' + pstamp(dates[0]) + ' · 最新快照 ' + pstamp(dates[dates.length - 1]), listInner + '<h2 style="font-size:17px;margin:26px 0 8px">最近一次存档（' + pstamp(dates[dates.length - 1]) + '）看到的内容</h2>' + posts.slice(-6).reverse().map(postBlock).join('') + MARK_DIV)) });
      dates.forEach((d, i) => {
        const visible = posts.filter((q) => q.date <= d).slice(-5).reverse();
        const nav = (i > 0 ? '<a href="' + snapUrl(dates[i - 1]) + '">◀ ' + pstamp(dates[i - 1]) + '</a>' : '◀')
          + ' <b>' + pstamp(d) + '</b> （第 ' + (i + 1) + '/' + dates.length + ' 张） '
          + (i < dates.length - 1 ? '<a href="' + snapUrl(dates[i + 1]) + '">' + pstamp(dates[i + 1]) + ' ▶</a>' : '▶');
        const inner = '<div style="border:1px solid #e3dccb;border-radius:12px;padding:10px 14px;background:#fffdf7;font-size:13px">' + nav + '</div>'
          + '<div style="color:#8b8574;font-size:13px;margin:12px 0 4px">归档快照 · 非实时页面 · 记忆证明 Proof-of-Memory</div>'
          + visible.map(postBlock).join('') + MARK_DIV;
        MC.push({ id: 'browser.timecapsule.snap.' + handle + '.' + d + '.' + d, type: 'browser_page', data: mcData(snapUrl(d), name + ' 的主页快照（' + pstamp(d) + '）— 忆链 MemoraChain', mcShell(name + ' 的主页快照（' + pstamp(d) + '）— 忆链 MemoraChain', '存档时间 ' + pstamp(d) + ' 03:12 · 源 pulse.social/user/' + handle + ' · 状态：原始版本，未经过源头编辑', inner)) });
      });
    }
  } catch (e) { log('MEMORYCHAIN build err ' + e.message); }
  log('MEMORYCHAIN pages = ' + MC.length + ' ' + MC.map((x) => x.data.url).join(' | '));
  return MC;
}
const MC_PAGES = buildMemoryChain();
function isBountyPage(id, url) {
  const hay = (String(id || '') + ' ' + String(url || '')).toLowerCase();
  for (const [k] of BOUNTY_MATERIAL) if (hay.indexOf(k.toLowerCase()) >= 0) return true;
  return /pulse\.social|memorachain\.xyz/.test(hay) && /frank_mercer48|mags_cole/.test(hay);
}
function markBody(html) {
  const h = String(html == null ? '' : html);
  if (!h || h.indexOf('data-arcade-submit') >= 0) return h;
  if (/<\/body>/i.test(h)) return h.replace(/<\/body>/i, MARK_DIV + '</body>');
  return h + MARK_DIV;
}
function injectLocalPages(k) {
  if (!k || k.type !== 'event' || String(k.channel || '').indexOf('manifold.artifacts') !== 0) return false;
  const key = String(ART_REQ_KEY.get(k.requestId) || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const pl = k.payload;
  if (!pl || typeof pl !== 'object') return false;
  let dirty = false;
  // ★ 和合医疗后台（本地移植）：把 concord-clinic.med/admin* 换成本模块生成的页面。
  //   注意要在 MC_PAGES 之前判断 —— key 前缀不同，互不干扰。
  if (key && CS_ADMIN && key.indexOf('concord-clinic.med/admin') === 0) {
    const page = CS_ADMIN.csGet('https://' + key);
    if (page) {
      const art = {
        id: 'browser.concord.admin.' + key.replace(/[^a-z0-9]+/gi, '.'),
        type: 'browser_page',
        data: Object.assign({}, page),
      };
      if (Array.isArray(pl.artifacts)) {
        const i = pl.artifacts.findIndex((a) => a && a.data
          && String(a.data.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') === key);
        if (i >= 0) pl.artifacts[i] = art; else pl.artifacts = pl.artifacts.concat([art]);
      } else { pl.ok = true; pl.artifact = art; }
      log('CONCORD admin page served ' + page.url);
      return true;
    }
    log('CONCORD admin page MISS ' + key);
  }
  if (key) {
    for (const mc of MC_PAGES) {
      const mu = String(mc.data.url).toLowerCase().replace(/^https?:\/\//, '');
      if (mu !== key) continue;
      const art = { id: mc.id, type: mc.type, data: Object.assign({}, mc.data) };
      if (mc.surfacedAt !== undefined) art.surfacedAt = mc.surfacedAt;
      if (Array.isArray(pl.artifacts)) {
        const i = pl.artifacts.findIndex((a) => a && String(a.id) === mc.id);
        if (i >= 0) pl.artifacts[i] = art; else pl.artifacts = pl.artifacts.concat([art]);
      } else { pl.ok = true; pl.artifact = art; }
      dirty = true;
      log('MEMORYCHAIN page served ' + mc.data.url);
      break;
    }
  }
  if (BOUNTY_ON) {
    const scan = Array.isArray(pl.artifacts) ? pl.artifacts : (pl.artifact ? [pl.artifact] : []);
    for (const a of scan) {
      if (!a || !a.data || typeof a.data.body_html !== 'string') continue;
      if (!isBountyPage(a.id, a.data.url)) continue;
      const nb = markBody(a.data.body_html);
      if (nb !== a.data.body_html) { a.data.body_html = nb; dirty = true; log('BOUNTY mark page ' + a.id); }
    }
  }
  if (!Array.isArray(pl.artifacts) && ART_REQ_KEY.has(k.requestId)) { ART_REQ.delete(k.requestId); ART_REQ_KEY.delete(k.requestId); }
  return dirty;
}

/* ★★★ 结构性防护网（2026-10-02 立 · 由"游戏卡死"事故换来）──────────────────
 * 背景：前端用 Zod 校验帧，`transition.cmd` 是**必填**（`{type:string} AND record`）。
 *   任何改动只要让帧**丢掉必填字段**，前端就会 `Dropping invalid server message`
 *   **整条丢弃** ⇒ 版本跳号 ⇒ 界面卡死（只能靠 F5 的 `runtime_resynced` 恢复）。
 *   这比"内容泄漏"严重得多，而且**从日志里看不出来**（帧照常发出去了）。
 *
 * ⇒ 做法：在整条 outboundFix 链**之前**快照"哪些必填 key 在"，
 *   **之后**复核；缺了就打**醒目告警**（并计数），把"静默的卡死"变成"日志里一行 ★"。
 *
 * ★ 为什么只做"告警"不自动恢复：自动塞回一个假 cmd 会掩盖真正的 bug，
 *   也可能塞进行不通的形态。**先让它可见，再去改对。** */
const SCHEMA_GUARD = { checks: 0, broken: 0, lastAt: 0, lastKeys: '' };
function guardRequiredKeys(j, before) {
  const tr = j && j.transition;
  if (!tr || !before) return false;
  const lost = before.filter((k) => !(k in tr));
  SCHEMA_GUARD.checks++;
  if (lost.length) {
    SCHEMA_GUARD.broken++;
    SCHEMA_GUARD.lastAt = Date.now();
    SCHEMA_GUARD.lastKeys = lost.join(',');
    log('★★★ SCHEMA 告警：帧丢了必填字段 [' + lost.join(',') + '] cart=' + String(j.cartridgeId || '')
      + ' —— 前端会**整条丢弃**这条帧（Zod 校验失败）⇒ 可能卡死！请查 outboundFix 链。');
    return true;
  }
  return false;
}

function outboundFix(j) {
  /* ★ 2026-10-03：B-215 补的那条"给无 transition 的 chat 帧挂容器"入口已删除
     ⇒ 恢复原语义：**没有 transition 的帧一律不碰**（版本才权威）。 */
  if (!j || !j.transition) return false;
  /* ★ 复核用快照：只记录"本来就在"的 key（不凭空要求它们存在） */
  const _beforeKeys = Object.keys(j.transition).filter((k) => k === 'cmd' || k === 'patches');
  if (j.worldId) LAST.worldId = j.worldId;
  if (j.cartridgeId) LAST.cartridgeId = j.cartridgeId;
  if (typeof j.version === 'number') LAST.version = j.version;
  let dirty = cleanFrame(j);
  if (planReveal(j)) dirty = true;
  if (trimLines(j)) dirty = true;
  if (trimOps(j)) dirty = true;
  if (exposeLines(j)) dirty = true;
  if (dropAgentEvents(j)) dirty = true;
  if (dropCommentCarriers(j)) dirty = true;   // ★ C1（2026-10-02）：cmd / events 两条漏载
  if (guardRequiredKeys(j, _beforeKeys)) dirty = true;   // ★★★ 防护网
  return dirty;
}
// Bubble exposure is driven by /lines only (the client's local block reveal is muted in trimOps).
// We piggyback on transitions that the backend is already emitting - never a synthetic message,
// so versions/head stay authoritative. One sentence surfaces each time its audio starts playing.
function exposeLines(j) {
  /* ★ 2026-10-03：B-215 的"自建最小 transition 容器"与"挑最早未完成"都已删除
     ⇒ 恢复为改动前的实现（没有现成的 chat 帧就不承载；同一时刻只有一个 rv）。 */
  const tr = j && j.transition;
  if (!tr || !LAST.lines) return false;
  if (j.cartridgeId !== 'chat') return false;   // patches apply to the transition's own cartridge
  let rv = null;
  for (const r of REVEAL.values()) {
    if (r.done || (r.exposed || 0) >= r.allowed) continue;
    if (!rv || r.ts > rv.ts) rv = r;
  }
  if (!rv) return false;
  const out = normalizeLines(LAST.lines);
  if (!Array.isArray(tr.patches)) tr.patches = [];
  tr.patches.push({ op: 'replace', path: '/lines', value: out });
  log('REVEAL expose ' + rv.allowed + '/' + rv.parts.length + ' msg=' + String(rv.msgId).slice(0, 8));
  return true;
}

// ---------- generic agent-text sanitizer ----------
// the model sometimes emits [happy] instead of [emotion:happy] (backend only strips the latter)
// or leaks markdown; both end up displayed AND spoken, so scrub every copy.
const TAG_RE = /^\s*\[(?:emotion[:：]\s*)?([a-zA-Z_]{3,12})\]\s*/;
const EMO_OK2 = new Set(['happy', 'excited', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'doubtful', 'dizzy', 'serious', 'neutral']);
function cleanAgentText(t) {
  let s = String(t == null ? '' : t);
  const orig = s;
  let emotion = null;
  const m = s.match(TAG_RE);
  if (m) { const e = m[1].toLowerCase(); if (EMO_OK2.has(e)) { emotion = e; s = s.replace(TAG_RE, ''); } }
  s = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/[`#]/g, '').replace(/^\s*[-•·]\s*/gm, '').trim();
  return { text: s, emotion, changed: s !== orig };
}
function cleanFrame(j) {
  const tr = j && j.transition; if (!tr) return false;
  const targets = [];
  const push = (o) => { if (o && typeof o.content === 'string') targets.push(o); };
  push(tr.cmd);
  if (Array.isArray(tr.events)) for (const ev of tr.events) if (ev && ev.type === 'agent_message') push(ev);
  if (Array.isArray(tr.patches)) for (const p of tr.patches) if (p && Array.isArray(p.value)) for (const el of p.value) if (el && el.sender === 'agent') push(el);
  let changed = false;
  for (const o of targets) {
    const r = cleanAgentText(o.content);
    if (!r.changed && !r.emotion) continue;
    o.content = r.text; changed = true;
    if (r.emotion && (!o.emotion || o.emotion === 'neutral')) o.emotion = r.emotion;
  }
  return changed;
}

// ---------- bubble split ----------
// The desktop chat renders exactly ONE bubble per entry of the cartridge `/lines` array,
// and the backend always appends a single entry per reply (newlines inside). To get
// sentence-per-bubble we rewrite the outgoing `/lines` patch: one entry -> N entries.
function bubblesFor(text) {
  const out = [];
  for (const raw of String(text || '').split(/\n+/)) {
    const l = raw.trim(); if (!l) continue;
    if (l.length <= 28) { out.push(l); continue; }
    for (const s of l.split(/(?<=[。！？!?])/).map((x) => x.trim())) if (s) out.push(s);
  }
  return out;
}

/* ★ C8（2026-10-02）：把 N 个气泡块合并成 ≤3 块（T5 用户定稿：≤3 保持、≥4 合并）。
   返回 { chunks: [{text, from, to}], blockOf: [partIdx → blockIdx] }。
   按比例切（n=4 → 1/2/1；n=6 → 2/2/2；n=8 → 3/2/3），避免首尾被挤成孤立的一小截。
   ★ 为什么不直接改 parts：parts 还要给 speechMap（TTS 整段）和 rv.parts.length（露出口径）用。 */
function mergeBlocks(parts) {
  const n = parts.length;
  if (!n) return { chunks: [], blockOf: [] };
  if (n <= 3) {
    const chunks = parts.map((t, i) => ({ text: t, from: i, to: i }));
    return { chunks, blockOf: parts.map((_, i) => i) };
  }
  const groups = 3, cuts = [];
  for (let g = 1; g < groups; g++) cuts.push(Math.round(n * g / groups));
  const chunks = []; let start = 0;
  for (let g = 0; g < groups; g++) {
    const end = (g < cuts.length ? cuts[g] : n) - 1;
    if (end < start) continue;
    chunks.push({ text: parts.slice(start, end + 1).join(''), from: start, to: end });
    start = end + 1;
  }
  const blockOf = [];
  for (let i = 0; i < n; i++) {
    let b = chunks.length - 1;
    for (let k = 0; k < chunks.length; k++) if (i >= chunks[k].from && i <= chunks[k].to) { b = k; break; }
    blockOf.push(b);
  }
  return { chunks, blockOf };
}
/* ★ C8：已播出的 part 数 → 应露出的**块**数。老条目（无 blockOf）走恒等 ⇒ 行为与改动前一致。 */
function blocksForParts(r, revealedParts) {
  if (!r || !Array.isArray(r.blockOf) || !r.blockOf.length) return revealedParts;
  const lim = Math.max(1, Math.min(revealedParts, r.blockOf.length));
  let k = 0;
  for (let i = 0; i < lim; i++) k = Math.max(k, r.blockOf[i]);
  return k + 1;
}

// ---------- canned-fallback guard ----------
// when the backend LLM call fails it silently answers from a built-in canned table
// (`local_fallback_reply`) - one long line, customer-service tone. Detect and re-ask.
const CANNED_MARKERS = [
  '随时待命为你提供协助', '本地系统运转正常', '操作员，你好呀！今天想聊点什么',
  'Nori 随时都在这里等你回来', '能帮到操作员我就最开心啦', '深海鱼不怕水压',
  '只要还能被你找到', '虚张声势和推理战术', '准备好挑战我了吗',
];
function looksCanned(t) { return t.length < 120 && CANNED_MARKERS.some((m) => t.includes(m)); }
// a canned reply shows up in several frames (ingestBlock / events[agent_message] / patches[/lines])
function collectCannedTargets(j) {
  const out = [];
  const tr = j && j.transition; if (!tr) return out;
  const c = tr.cmd;
  if (c && c.messageId && typeof c.content === 'string' && looksCanned(c.content)) out.push({ obj: c, id: c.messageId, op: c.operationId || (tr.cmd && tr.cmd.operationId) });
  if (Array.isArray(tr.events)) for (const ev of tr.events)
    if (ev && typeof ev.content === 'string' && looksCanned(ev.content)) out.push({ obj: ev, id: ev.messageId, op: ev.operationId });
  if (Array.isArray(tr.patches)) for (const p of tr.patches)
    if (p && Array.isArray(p.value)) for (const el of p.value)
      if (el && el.sender === 'agent' && typeof el.content === 'string' && looksCanned(el.content)) out.push({ obj: el, id: el.messageId, op: null });
  return out;
}
async function callLLM(cfg, sys, messages, p) {
  const base = String(cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model || 'deepseek-flash', messages, temperature: (p && p.temperature) ?? 0.75, max_tokens: 900 }),
  });
  if (!r.ok) throw new Error('http ' + r.status + ' ' + (await r.text()).slice(0, 100));
  const data = await r.json();
  log('   regen call -> ' + r.status + ' model=' + (cfg.model || '?') + ' key=' + String(cfg.apiKey || '').slice(0, 10) + ' sys=' + (sys || '').length + ' msgs=' + (messages || []).length + ' maxTok=' + ((p && p.maxTokens) || 350) + ' temp=' + ((p && p.temperature) ?? 0.75));
  const raw = String(((data.choices || [])[0]?.message?.content) || '').trim();
  log('   regen body rawLen=' + raw.length + ' raw=' + JSON.stringify(raw.slice(0, 60)));
  if (!raw) log('   regen EMPTY full: ' + JSON.stringify(data).slice(0, 600));
  return raw;
}
async function regen(ctx) {
  const p = ctx.ai || {};
  const sys = [String(p.systemPrompt || ''), String(p.characterPrompt || '')].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: sys },
    ...ctx.history.slice(-6),
    { role: 'user', content: '（系统注：你上一条回复掉进了默认模板，请重新用 Nori 的口吻回答一遍。第一行只写 [emotion:xxx] 标签，之后 2~3 行短句，不要 Markdown，不要客套。）' },
  ];
  const cands = [];
  if (p.baseUrl && p.apiKey) cands.push(p);
  // ★ 2026-10-04：key 统一从 DEEPSEEK_API_KEY 读（NORI_FALLBACK_KEY 保留兼容）。
  const FB_KEY = process.env.DEEPSEEK_API_KEY || process.env.NORI_FALLBACK_KEY;
  if (FB_KEY) cands.push({ baseUrl: 'https://api.deepseek.com/v1', model: process.env.NORI_FALLBACK_MODEL || 'deepseek-flash', apiKey: FB_KEY });
  if (!cands.length) throw new Error('no api key in runtime config');
  log('   regen candidates=' + cands.length + ' sysLen=' + sys.length + ' hist=' + ctx.history.length + ' lastUser=' + JSON.stringify(String(ctx.lastUser || '').slice(0, 20)));
  let lastErr = null, text = '';
  for (const c of cands) {
    for (let attempt = 0; attempt < 3 && !text; attempt++) {
      try { text = await callLLM(c, sys, messages, p); if (!text) log('   empty completion, retry ' + (attempt + 1)); }
      catch (e) { lastErr = e; log('   regen attempt failed:', String(e.message).slice(0, 90)); break; }
    }
    if (text) break;
  }
  if (!text) throw lastErr || new Error('empty regen reply');
  let emotion = 'neutral';
  const m = text.match(/\[emotion:([a-zA-Z_]+)\]/);
  if (m) { emotion = m[1].toLowerCase(); text = text.replace(m[0], '').trim(); }
  if (!text) throw new Error('empty regen reply');
  return { text, emotion };
}
const repairCache = new Map();    // messageId -> {text, emotion}
const repairInFlight = new Map(); // key -> Promise<{text,emotion}|{__err}>
function tryRepair(txt, ctx, client) {
  let j; try { j = JSON.parse(txt); } catch { return false; }
  const targets = collectCannedTargets(j);
  if (!targets.length) return false;
  const key = targets[0].id || ('op:' + targets[0].op);
  const apply = (r) => { for (const t of targets) { t.obj.content = r.text; if ('emotion' in t.obj) t.obj.emotion = r.emotion; } };
  const emit = () => {
    outboundFix(j);
    const fixed = JSON.stringify(j);
    captureText(fixed);
    try { client.send(fixed, { binary: false }); } catch {}
  };
  const cached = targets.map((t) => t.id && repairCache.get(t.id)).find(Boolean);
  if (cached) { log('!! CANNED cache hit'); apply(cached); emit(); return true; }
  let pr = repairInFlight.get(key);
  if (!pr) {
    log('!! CANNED fallback detected:', JSON.stringify((targets[0].obj.content || '').slice(0, 44)));
    const t0 = Date.now();
    pr = regen(ctx).then((r) => { r.ms = Date.now() - t0; return r; }).catch((e) => ({ __err: e, ms: Date.now() - t0 }));
    repairInFlight.set(key, pr);
  }
  pr.then((r) => {
    if (repairInFlight.get(key) === pr) repairInFlight.delete(key);
    if (r && r.text) {
      log('!! CANNED repaired in ' + r.ms + 'ms ->', JSON.stringify(r.text.slice(0, 44)));
      for (const t of targets) if (t.id) repairCache.set(t.id, r);
      repairCache.set(key, r);
      apply(r); emit();
      ctx.history.push({ role: 'assistant', content: r.text });
    } else {
      log('!! CANNED repair failed (' + (r && r.__err ? String(r.__err.message).slice(0, 70) : 'empty regen') + ') - forwarding original');
      emit();
    }
  });
  return true;
}

// ---------- wav + pcm helpers ----------
function decodeWavInt16(buf) {
  if (buf.length < 44 || buf.slice(0, 4).toString('ascii') !== 'RIFF') throw new Error('not RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { fmt: buf.readUInt16LE(off + 8), ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === 'data') data = buf.slice(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
    if (fmt && data) break;
  }
  if (!fmt || !data) throw new Error('wav missing fmt/data chunk');
  const n = Math.floor(data.length / 2);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2);
  return { samples: s, rate: fmt.rate, ch: fmt.ch };
}
function resampleInt16(samples, inRate, outRate) {
  if (inRate === outRate) return samples;
  const ratio = outRate / inRate, outN = Math.floor(samples.length * ratio), out = new Int16Array(outN);
  for (let i = 0; i < outN; i++) {
    const src = i / ratio, i0 = Math.floor(src), frac = src - i0;
    const a = samples[i0] || 0, b = samples[Math.min(i0 + 1, samples.length - 1)] || 0;
    let v = Math.round(a + (b - a) * frac);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out[i] = v;
  }
  return out;
}
function bytesToUuid(buf, off) {
  let s = '';
  for (let i = 0; i < 16; i++) s += buf.readUInt8(off + i).toString(16).padStart(2, '0');
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}
/* ★★ 2026-10-07 改：**全局串行 → 限流并发**（_arch/129 TTS 延迟诊断）
 *
 * 原来（旧供应商百炼）：`TTS_CHAIN` 把**所有** TTS 调用串成一条链 ——
 *   因为"Qwen 桥一次只处理一条，并发会 502"。那个约束**对新供应商不再成立**
 *   （Inworld 支持并发，见 tts/config.py）。
 *
 * 后果（实测）：前端 shim 每句都**预取下一句**（qnext）⇒ 本来天然有 2 个并发请求；
 *   串行链把预取**排到真请求后面** ⇒ 预取白做，请求一路堆积 ⇒
 *   实测 8880 攒了 4 条 CLOSE_WAIT、连 `/health` 都不响应。
 *
 * ⇒ 改成**有上限的并发闸门**（默认 3，`NORI_TTS_PARALLEL` 可调）：
 *   既不再互相挡路，又不会把上游打爆。
 *   ★ 保留函数名 `ttsLock(fn)` 与调用形态 ⇒ **两个调用点都不用改**。
 *   回退：设 `NORI_TTS_PARALLEL=1` 即恢复"串行"语义。 */
const TTS_MAX_PAR = Math.max(1, Number(process.env.NORI_TTS_PARALLEL || 3));
let TTS_ACTIVE = 0;
const TTS_WAIT = [];
function ttsSlot() {
  if (TTS_ACTIVE < TTS_MAX_PAR) { TTS_ACTIVE++; return Promise.resolve(); }
  return new Promise((res) => { TTS_WAIT.push(res); });
}
function ttsRelease() {
  const next = TTS_WAIT.shift();
  if (next) next();          // 名额**直接转交**给等待者（不减了再加 —— 避免中间态被抢）
  else TTS_ACTIVE--;
}
function ttsLock(fn) {
  return ttsSlot().then(async () => {
    try { return await fn(); } finally { ttsRelease(); }
  });
}
async function tts(text, voice) {
  return ttsLock(async () => {
    const body = JSON.stringify(voice ? { text, voice } : { text });
    const r = await fetch(TTS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error('tts http ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  });
}

/* ★★ 2026-10-17：**真流式**合成 —— 逐块回调，不攒完再给。
 *
 *   与 `tts()` 的区别只在"什么时候交数据"：这里每收到一块就 `onChunk(buf, info)`，
 *   调用方（`streamSpeech` 的第 0 句）据此**立刻切帧发给客户端** ⇒ 玩家更早听到声。
 *
 *   返回 `{ bytes, encoding, rate, fallback }`：
 *     · `fallback:true` 表示 `/tts.stream` 不可用（404/403 等）⇒ 已自动退回**一次性**的 `tts()`，
 *       `onChunk` 只被调用一次（整段）。⇒ 上层无需分支，行为自然降级。
 *   ⚠ 只对 `encoding === 'PCM'` 做"直接当 Int16 用"的假设；
 *     若服务端回的是带头的格式，`fallback` 之外的情况由调用方按 `encoding` 判断。
 */
async function ttsStream(text, voice, onChunk) {
  return ttsLock(async () => {
    const body = JSON.stringify(voice ? { text, voice } : { text });
    let r;
    try {
      r = await fetch(TTS_STREAM_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (e) {
      /* 连接层失败（服务没起 / 端口错）⇒ 退回一次性路径 */
      const buf = await ttsUnlocked(text, voice);
      onChunk(buf, { encoding: 'WAV', rate: 0 });
      return { bytes: buf.length, encoding: 'WAV', rate: 0, fallback: true };
    }
    if (!r.ok) {
      /* ★ 端点不存在（老版本 TTS 服务）⇒ 退回一次性路径，而不是把语音弄丢 */
      log('TTS stream 不可用（http ' + r.status + '）⇒ 退回 /tts');
      const buf = await ttsUnlocked(text, voice);
      onChunk(buf, { encoding: 'WAV', rate: 0 });
      return { bytes: buf.length, encoding: 'WAV', rate: 0, fallback: true };
    }
    const encoding = (r.headers.get('x-nori-encoding') || 'PCM').toUpperCase();
    const rate = Number(r.headers.get('x-nori-sample-rate') || 0) || 0;
    let bytes = 0;
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) { bytes += value.length; onChunk(Buffer.from(value), { encoding: encoding, rate: rate }); }
      }
    } else {
      /* 运行时没有流式 body（极老 node）⇒ 退化为一次性 */
      const buf = Buffer.from(await r.arrayBuffer());
      bytes = buf.length;
      onChunk(buf, { encoding: encoding, rate: rate });
    }
    return { bytes: bytes, encoding: encoding, rate: rate, fallback: false };
  });
}
/* 不带锁的内部版：`ttsStream` 已在 `ttsLock` 里，再调 `tts()` 会**自己等自己** ⇒ 死锁。
 *   （实测踩过同类坑：`ttsLock(fn)` 里再调 `ttsLock(fn)` 会一直挂到超时） */
async function ttsUnlocked(text, voice) {
  const body = JSON.stringify(voice ? { text, voice } : { text });
  const r = await fetch(TTS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) throw new Error('tts http ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
function concatInt16(a, b) {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function forwardFrame(client, buf, stream) {
  const b = Buffer.from(buf);
  if (b.length >= 8) b.writeUInt32LE(stream.seq++, 4);
  client.send(b, { binary: true });
}

const GAP_MS = Number(process.env.NORI_TTS_GAP_MS || 300);

function frameFor(pcmChunk, blockId, chunkId, seq, isComplete, op, msg) {
  const b = Buffer.alloc(48 + pcmChunk.length * 2);
  b.writeUInt8(1, 0); b.writeUInt8(1, 1);
  b.writeUInt16LE(isComplete ? 1 : 0, 2);
  b.writeUInt32LE(seq, 4);
  b.writeUInt32LE(blockId, 8);
  b.writeUInt32LE(chunkId, 12);
  op.copy(b, 16); msg.copy(b, 32);
  Buffer.from(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.byteLength).copy(b, 48);
  return b;
}

// Synthesize the reply sentence by sentence and push each sentence the moment it is ready
// (instead of waiting for the whole reply). Each sentence is its own media block
// (blockId = sentence index) so the client's audio acks line up with the bubble reveal.
function streamSpeech(client, rec, msgUuid, op, msg, stream, state, key, pending) {
  const rv = REVEAL.get(msgUuid) || null;
  const split = bubblesFor(rec.text);
  const list = (rv && rv.parts.length) ? rv.parts : (split.length ? split : [rec.text]);
  const voice = voiceFor(rec.emotion);
  const gap = GAP_MS > 0 ? new Int16Array(Math.round(OUT_RATE * GAP_MS / 1000)) : null;
  const ready = new Array(list.length).fill(null);
  const failed = new Array(list.length).fill(false);
  let next = 0, chunkId = 0, resolved = 0, settled = false, emitted = 0, firstAt = 0, lastComplete = false, cum = 0;
  const t0 = Date.now();

  const emit = (pcm, partIdx, isLastPart, forceIncomplete) => {
    const total = Math.max(1, Math.ceil(pcm.length / FRAME_SAMPLES));
    for (let f = 0; f < total; f++) {
      const chunk = pcm.subarray(f * FRAME_SAMPLES, (f + 1) * FRAME_SAMPLES);
      // every sentence block must end with isComplete=1, otherwise the worklet never finishes
      // block k and never starts (nor acks) block k+1 - the reveal would lag ~10s behind the voice
      // ★ 2026-10-17：`forceIncomplete` = 流式途中发的中间帧 —— **绝不能**带 complete=1
      const complete = !forceIncomplete && (f + 1) * FRAME_SAMPLES >= pcm.length;
      if (complete && isLastPart) lastComplete = true;
      emitted += chunk.length;
      try { client.send(frameFor(chunk, partIdx, chunkId++, stream.seq++, complete, op, msg), { binary: true }); } catch {}
      if (!firstAt) { firstAt = Date.now(); log('SPEECH first frame block=0 +' + (firstAt - t0) + 'ms'); }
    }
  };

  const flush = () => {
    while (next < list.length && (ready[next] !== null || failed[next])) {
      const i = next, isLast = i === list.length - 1;
      const pcm = ready[i];
      let audio = (pcm && pcm.length) ? pcm : null;
      if (audio && gap) audio = concatInt16(audio, gap);
      const startAt = firstAt ? firstAt + 60 + (cum * 1000) / OUT_RATE : 0;
      if (audio && audio.length) {
        emit(audio, i, isLast);
        cum += audio.length;
      }
      next++;
    }
    if (settled || next < list.length || resolved < list.length) return;
    settled = true;
    if (!emitted) {
      log('SYNTH fail', key.slice(0, 13), 'no audio - forwarding backend frames');
      state.set(key, 'fail');
      for (const f of (pending.get(key) || [])) forwardFrame(client, f, stream);
      pending.delete(key);
      return;
    }
    if (!lastComplete) { try { client.send(frameFor(new Int16Array(0), list.length - 1, chunkId++, stream.seq++, true, op, msg), { binary: true }); } catch {} }
    state.set(key, 'done'); pending.delete(key);
    log('SYNTH ok', key.slice(0, 13), 'parts=' + list.length, 'first=+' + (firstAt - t0) + 'ms', 'total=+' + (Date.now() - t0) + 'ms', 'samples=' + emitted);
  };

  /* ★★ 2026-10-17：**第 0 句走真流式** —— "玩家多快听到声"只看这一句，所以只对它做流式；
     1..n 句（已被并发预取）保持原来的"收齐再发"，改面最小。
     ① 分块 → Int16（奇数长度时留半个样本到下一块拼）
     ② 只有服务端采样率 ≠ OUT_RATE 才重采样（32000 == OUT_RATE ⇒ 直接省掉）
     ③ 攒够一整帧（FRAME_SAMPLES）就 `emit(..., forceIncomplete=true)` 发出去
     ④ 收尾那次 `emit(尾巴+gap, 0, false)` 才打 complete=1（**这一块才算结束**）
     ⑤ 流失败：若已吐过音频 ⇒ 只补一个"空结束帧"（不让 block 0 悬着）；没吐过 ⇒ 退回一次性 `tts()`
     ★ 回退：`NORI_TTS_STREAM=off` ⇒ 完全走老路。 */
  function startStreamed0(p) {
    let pend = new Int16Array(0);
    let leftover = null;              // Int16 半样本（分块边界可能切开 2 字节）
    let got = 0;
    const tS = Date.now();
    const feed = (buf, info) => {
      let b = leftover ? Buffer.concat([leftover, buf]) : buf;
      if (b.length & 1) { leftover = b.slice(b.length - 1); b = b.slice(0, b.length - 1); } else leftover = null;
      if (!b.length) return;
      let s = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
      if (info && info.rate && info.rate !== OUT_RATE) s = resampleInt16(s, info.rate, OUT_RATE);
      got += s.length;
      pend = concatInt16(pend, s);
      while (pend.length >= FRAME_SAMPLES) {
        emit(pend.subarray(0, FRAME_SAMPLES), 0, false, true);   // ★ 中间帧：complete 一律 0
        pend = pend.subarray(FRAME_SAMPLES);
      }
    };
    ttsStream(p, voice, feed).then((r) => {
      let tail = pend;
      if (gap) tail = concatInt16(tail, gap);
      emit(tail, 0, false);                     // ← 尾巴 + gap，打上 complete=1
      if (!got) failed[0] = true;
      ready[0] = new Int16Array(0);              // ★ 非 null 标记 ⇒ 让 flush() 能推进到第 1 句
      resolved++; flush();
      log('SYNTH0 流式 parts=' + list.length + ' bytes=' + r.bytes + ' samples=' + got
        + ' first=+' + (firstAt ? firstAt - t0 : -1) + 'ms 耗时=+' + (Date.now() - tS) + 'ms'
        + (r.fallback ? ' [★退化为一次性]' : ''));
    }).catch((e) => {
      if (emitted) {
        log('SYNTH0 流式中断（已吐音频）⇒ 只补结束帧: ' + e.message);
        try { emit(new Int16Array(0), 0, false); } catch (e2) {}
        ready[0] = new Int16Array(0); resolved++; flush();
        return;
      }
      log('SYNTH0 流式失败 ⇒ 退回一次性: ' + e.message);
      startBuffered(p, 0);
    });
  }

  const startBuffered = (p, i) => {
    const attempt = (n) => tts(p, voice).then((w) => {
      const { samples, rate } = decodeWavInt16(w);
      ready[i] = resampleInt16(samples, rate, OUT_RATE);
      resolved++; flush();
    }).catch((e) => {
      if (n < 2) { log('   tts retry part ' + i + ': ' + e.message); return attempt(n + 1); }
      log('SYNTH part ' + i + ' failed:', e.message);
      failed[i] = true; resolved++; flush();
    });
    attempt(0);
  };

  list.forEach((p, i) => {
    if (i === 0 && TTS_STREAM_ON) return startStreamed0(p);   // ★ 第 0 句真流式
    return startBuffered(p, i);
  });
}
// ---------- media frame interception ----------
function mediaToClient(client, data, isBinary, stream, pending, state) {
  if (!isBinary) { client.send(data, { binary: false }); return; }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 48 || buf.readUInt8(0) !== 1 || buf.readUInt8(1) !== 1) { forwardFrame(client, buf, stream); return; }
  const blockId = buf.readUInt32LE(8);
  const msgUuid = bytesToUuid(buf, 32);
  const key = msgUuid + ':' + blockId;
  const rec = speechMap.get(key);
  if (!(rec && rec.isSpeech && rec.text && rec.text.trim())) { forwardFrame(client, buf, stream); return; }
  const st = state.get(key);
  if (st === 'done') return;                       // drop backend duplicates for synthesized block
  if (st === 'pending') { pending.get(key).push(Buffer.from(buf)); return; }
  if (st === 'fail') { forwardFrame(client, buf, stream); return; }
  state.set(key, 'pending'); pending.set(key, [Buffer.from(buf)]);
  const op = buf.slice(16, 32), msg = buf.slice(32, 48);
  log('SYNTH…', key.slice(0, 13), 'emotion=' + rec.emotion, JSON.stringify(rec.text.slice(0, 40)));
  streamSpeech(client, rec, msgUuid, op, msg, stream, state, key, pending);
}

// ---------- http server ----------
var WORLD_GEN_CACHE = null;   // {t0, mt} —— day-1 包的 T0（每次重置 ColdOpen 都会变）
const server = http.createServer((req, res) => {
  // 世界代号：前端 nori-fresh-start.js 用它判断「服务器已经重置过」→ 自动清掉浏览器存档
  if (req.url && req.url.split('?')[0] === '/nori-world-gen') {
    let gen = 0, t0 = 0, mt = 0;
    try {
      const st = FSMOD.statSync(PACK_PATH);
      mt = Math.floor(st.mtimeMs);
      if (!WORLD_GEN_CACHE || WORLD_GEN_CACHE.mt !== mt) {
        let m = null;
        try { m = FSMOD.readFileSync(PACK_PATH, 'utf8').match(/"T0_ms"\s*:\s*(\d+)/); } catch (e) {}
        WORLD_GEN_CACHE = { t0: m ? Number(m[1]) : 0, mt: mt };
      }
      t0 = WORLD_GEN_CACHE.t0 || 0;
      gen = t0 || WORLD_GEN_CACHE.mt;
    } catch (e) {}
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ gen: gen, t0: t0, mt: mt }));
    } catch (e) {}
    return;
  }
  // 游戏台词：前端 shim 轮询取走（她的游戏内台词 + 情绪）
  if (req.url && req.url.split('?')[0] === '/nori-line') {
    const q = GAME_LINES.splice(0, GAME_LINES.length);
    try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ lines: q })); } catch {}
    return;
  }
  // ★ 2026-10-03：`/nori-chat` 与 `/nori-say` 已删除（自研聊天面板早在 N1 前就没了，
  //   这两个端点推的数据无人取）。详见文件上方那段说明。
  if (req.url && req.url.split('?')[0] === '/nori-tts') {
    const _wantStream = /[?&]stream=1\b/.test(req.url || '');
    // 给前端 shim 用：同源转发到 Qwen TTS 桥，避免跨域
    var _u = null; try { _u = new URL(TTS_URL); } catch (e) {}
    var _host = (_u && _u.hostname) || '127.0.0.1', _port = (_u && Number(_u.port)) || 8880, _path = (_u && _u.pathname) || '/tts';
    var _b = '';
    req.on('data', (d) => { if (_b.length < 4000) _b += d.toString('utf8'); });
    req.on('end', () => {
      /* ══ ★★ 2026-10-17：`?stream=1` ⇒ **透传 /tts.stream 的 PCM 分块**（不缓冲）══
       * 为什么：台词原来走 `/tts`（WAV）—— 服务端必须收完整段、回填 RIFF 长度才能
       *   吐出第一个字节（实测 `首字节 1617.4ms ≈ 收完 1617.7ms`）⇒ 首声响 = 整段合成。
       *   同一句话走 `/tts.stream`（裸 PCM）首块只要 0.6~1.3s。
       * ★ 与 LLM 回复的 `/tts.stream` 消费是**同一条服务端路由**，只是这里转给浏览器。
       * ★ 仍经过 `ttsLock`（并发闸门），但**绝不 Buffer**：上游来一块转一块。 */
      if (_wantStream) {
        var _su = null; try { _su = new URL(TTS_STREAM_URL); } catch (e) {}
        var _sh = (_su && _su.hostname) || '127.0.0.1';
        var _sp = (_su && Number(_su.port)) || 8880;
        var _spath = (_su && _su.pathname) || '/tts.stream';
        var _aborted = false;
        const release = () => { try { if (!res.writableEnded) res.end(); } catch (e) {} };
        ttsLock(async () => await new Promise((resolve) => {
          const r2 = http.request({ host: _sh, port: _sp, path: _spath, method: 'POST',
            headers: { 'content-type': 'application/json' } }, (rr) => {
            if (rr.statusCode !== 200) {
              log('TTS stream 透传失败 http ' + rr.statusCode);
              try { res.writeHead(502, { 'access-control-allow-origin': '*' }); } catch (e) {}
              release(); resolve(); return;
            }
            try {
              res.writeHead(200, {
                'content-type': 'audio/l16',
                'x-nori-encoding': String(rr.headers['x-nori-encoding'] || 'PCM'),
                'x-nori-sample-rate': String(rr.headers['x-nori-sample-rate'] || 32000),
                'access-control-allow-origin': '*',
                'cache-control': 'no-store',
              });
            } catch (e) {}
            rr.on('data', (d) => { if (!_aborted) { try { res.write(d); } catch (e) {} } });
            rr.on('end', () => { release(); resolve(); });
            rr.on('error', () => { release(); resolve(); });
          });
          r2.on('error', (e) => {
            log('TTS stream 透传错误 ' + e.message);
            try { if (!res.writableEnded) res.writeHead(502, { 'access-control-allow-origin': '*' }); } catch (e2) {}
            release(); resolve();
          });
          res.on('close', () => { _aborted = true; try { r2.destroy(); } catch (e) {} });
          r2.setTimeout(Number(process.env.NORI_TTS_TIMEOUT_MS || 25000), () => { try { r2.destroy(new Error('tts stream timeout')); } catch {} });
          r2.end(_b);
        })).catch(() => { release(); });
        return;
      }
      ttsLock(async () => {
        return await new Promise((resolve) => {
          const r2 = http.request({ host: _host, port: _port, path: _path, method: 'POST', headers: { 'content-type': 'application/json' } }, (rr) => {
            const parts = [];
            /* ★ 2026-10-03：**透传上游的 content-type**，不再硬编码 `audio/wav`。
               原因：TTS 供应商**必须可替换**（开发期百炼，将来可能换 Inworld / OpenAI
               ⇒ 可能返回 MP3）。前端用 `decodeAudioData` 解码，**格式无关**，
               但响应头写错会让任何按 MIME 判分支的环节出错。
               上游没给就退回 `application/octet-stream`（不谎报具体格式）。 */
            const ct = (rr.headers && rr.headers['content-type']) || 'application/octet-stream';
            rr.on('data', (d) => parts.push(d));
            rr.on('end', () => resolve({ code: rr.statusCode || 200, buf: Buffer.concat(parts), ct: ct }));
          });
          r2.on('error', (e) => resolve({ code: 502, buf: Buffer.from('tts error ' + e.message), ct: 'text/plain; charset=utf-8' }));
          // ★ 2026-10-07：20s → 25s（_arch/129）。
          //   语义：**服务端必须先返回**（成功或它自己的 18s 超时）⇒ 这里才能拿到干净的
          //   状态码并原样转给前端。若这里先 abort，服务端的连接就挂成 CLOSE_WAIT
          //   （实测 8880 就是这样堆了 4 条）。留 7s 余量。
          r2.setTimeout(Number(process.env.NORI_TTS_TIMEOUT_MS || 25000), () => { try { r2.destroy(new Error('tts timeout')); } catch {} });
          r2.end(_b);
        });
      }).then((r) => {
        try {
          res.writeHead(r.code, { 'content-type': r.ct, 'access-control-allow-origin': '*', 'content-length': r.buf.length });
          res.end(r.buf);
        } catch (e) {}
      }).catch((e) => { try { res.writeHead(502, { 'access-control-allow-origin': '*' }); res.end('tts error ' + e.message); } catch {} });
    });
    return;
  }
  // ★ C4/C5 只读端点（2026-10-02）：游戏生命周期状态 + **现在会 append 什么**
  if (req.url && req.url.split('?')[0] === '/nori-lifestat') {
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      /* ★ 2026-10-16：顺带暴露**过场闸门**状态 ——
         之前没有任何只读端点能看"过场开着没有"，排查只能 grep 日志。 */
      const ls = LIFE.getState();
      ls.petGate = petGateWhy();
      ls.coldOpen = { readyAt: COLD_READY_AT, doneAt: COLD_DONE_AT };
      res.end(JSON.stringify(ls, null, 2));
    } catch (e) {}
    return;
  }  /* ★★ 2026-10-07：交互手势注入 —— 摸头 / 摸尾巴
   *   为什么单独开端点、而不是等前端发 WS 帧：
   *     **游戏本体没有触摸交互**（实测：`obs.log` 的帧类型只有
   *      `cartridge_mounted/_ack` / `cartridge_unmounted/_ack` / `world_joined` / `open_media`；
   *      发行包里 billboard（Nori 立绘）只是"可扫描窗口"，**没有任何 touch/mouse 处理**）。
   *   ⇒ 这样"接上"只需前端 **fetch 一下**，**不必改发行包**（可在 `public/` 加一个 shim，
   *     也可以由任何外部脚本、甚至手动 curl 触发）。
   *   用法:  POST /nori-touch  {"part":"head"}   或   GET /nori-touch?part=tail
   */
  /* ★ 2026-10-16：给自建端点答 **CORS 预检**。
   *   为什么必须：`/nori-touch` 只给了 `access-control-allow-origin`，
   *   而前端用 `POST` + `content-type: application/json` ⇒ **跨源时必定先发 OPTIONS**。
   *   以前 OPTIONS 会掉进 POST 分支、因 `part` 为空而返回 **400 且无 allow-methods**
   *   ⇒ **浏览器直接拦掉真正的 POST**（表现为"点了完全没反应"，服务端一行日志都没有）。
   *   同源时不会发预检 ⇒ 这条以前没暴露出来。**只给这两个端点开口，不影响其他路由。**
   *   GET /nori-corscheck 可直接看预检头是否在（排查用，只读）。 */
  {
    const _cu = String(req.url || '').split('?')[0];
    if (_cu === '/nori-touch' || _cu === '/nori-pet' || _cu === '/nori-corscheck') {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      };
      if (req.method === 'OPTIONS') {
        try { res.writeHead(204, cors); res.end(); } catch (e) {}
        return;
      }
      if (_cu === '/nori-corscheck') {
        try {
          res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, cors));
          res.end(JSON.stringify({ ok: true, cors: cors, hint: 'OPTIONS 也走这里；预检已可过' }));
        } catch (e) {}
        return;
      }
    }
  }
  if (req.url && req.url.split('?')[0] === '/nori-touch') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e3) req.destroy(); });
    req.on('end', () => {
      let part = '';
      try { part = String((JSON.parse(raw || '{}') || {}).part || ''); } catch (e) {}
      if (!part) { const m = /(?:^|[?&])part=([a-zA-Z]+)/.exec(req.url || ''); if (m) part = m[1]; }
      part = String(part).toLowerCase();
      const MAP = { head: 'touch.head', tail: 'touch.tail' };
      if (!MAP[part]) {
        try {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: false, reason: 'part 必须是 head 或 tail', got: part }));
        } catch (e) {}
        return;
      }
      const fact = MAP[part];
      /* ★ 2026-10-16：过场闸门 —— 脚本化时刻**直接不响应**（不 addFact / 不上屏 / 不给表情）。
         前端 shim 读到 `blocked` 就知道"官方这时候不该有反应"，也不会加表情。 */
      const gate = petGateWhy();
      if (gate) {
        log('TOUCH ' + part + ' -> BLOCKED by petGate (' + gate + ')');
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: true, part: part, fact: fact, fired: false, blocked: gate }));
        } catch (e) {}
        return;
      }
      let fired = false;
      try { fired = addFact(fact, 'touch:' + part); } catch (e) {}
      log('TOUCH ' + part + ' -> ' + fact + ' fired=' + fired);
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        /* ★ 2026-10-16：把这句台词的 emotion 一并回传 ——
         *   前端 shim 据此给 L2D 模型加表情（`agentMessage` 走不了表情，
         *   因为它的 line 没有 isSpeech/emotion）。 */
        let emo = '';
        try {
          const bs = (SCRIPT && typeof SCRIPT._beats === 'function') ? SCRIPT._beats() : [];
          const b = bs.find((x) => x && x.id === ('touch_' + part));
          if (b && b.emotion) emo = b.emotion;
        } catch (e) {}
        res.end(JSON.stringify({ ok: true, part: part, fact: fact, fired: fired, emotion: emo || 'happy' }));
      } catch (e) {}
    });
    return;
  }
  /* ★ 2026-10-16：摸头 shim 的**自检上报**（只写日志，不改变任何行为）。
   *   为什么需要：shim 的立绘坐标要靠"**进一次扫描模式**"偷学 ⇒ 没学到时它**完全静默**。
   *   而本项目**服务端不记录静态请求** ⇒ 连"shim 有没有被加载"都查不到，
   *   用户只会说"没反应"，排查只能靠猜（2026-10-16 连着两次都卡在这）。
   *   ⇒ 让 shim 把 {ev:'load'|'learned'|'miss', ...} 打到这里，日志里一眼看清它处于哪一步。
   *   用法:  POST /nori-pet  {"ev":"load","rect":null}  …（也支持 GET ?ev=load） */
  if (req.url && req.url.split('?')[0] === '/nori-pet') {
    let praw = '';
    req.on('data', (c) => { praw += c; if (praw.length > 2e3) req.destroy(); });
    req.on('end', () => {
      let pj = {};
      try { pj = JSON.parse(praw || '{}') || {}; } catch (e) {}
      if (!pj.ev) { const m = /(?:^|[?&])ev=([a-zA-Z]+)/.exec(req.url || ''); if (m) pj.ev = m[1]; }
      log('PET ' + JSON.stringify(pj).slice(0, 320));
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end('{"ok":true}');
      } catch (e) {}
    });
    return;
  }
  // ★ B3 只读端点（2026-10-02）：枢纽统计（模式 / 单元分类 / 命中的 lines 路径 / ★差异数）
  //   判据：shadow 下 `mismatches` 必须恒为 0 ⇒ 否则管线不再透明（B3 失败）
  if (req.url && req.url.split('?')[0] === '/nori-hubstat') {
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({
        stats: HUB.getStats(),
        carrier: CARRIER,          // C1：战报在各载具上被拦截的次数（C3 生效后 cmdSeen 应停止增长）
        battle: battleStat(),      // ★ C3：战报的产生/注入/抑制（injectOn=false 时 injected 应恒为 0）
        schemaGuard: SCHEMA_GUARD, gaps: HUB.gaps(),
      }, null, 2));
    } catch (e) {}
    return;
  }
  // ★ D1 只读端点（2026-10-02）：拼接器状态 —— **她现在会读到什么**（willSend/preview）
  if (req.url && req.url.split('?')[0] === '/nori-splicestat') {
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(SPLICE.getState(), null, 2));
    } catch (e) {}
    return;
  }
  /* ★ N3（2026-10-02）只读端点：**主动触发 + 节流**的可观测面。
   *   为什么必须有它：N3 的验收判据是"节流有没有生效"（纯计数），
   *   而日志口径不可靠（`err=` 是空值前缀、`FATAL` 命中的是用户自己的话，见 B-210）。
   *   ⇒ 把计数放在代码里，**不依赖 grep**。 */
  if (req.url && req.url.split('?')[0] === '/nori-n3stat') {
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(n3Stat(), null, 2));
    } catch (e) {}
    return;
  }
  /* ★★ 2026-10-03（编排模块）：前端 shim 的**播出回报** —— 每播完一句来一次。
   *   `{ qid, qpart }` = "第 qid 条消息的第 qpart 句播完了"。
   *   ★ 为什么必须带 `qpart` 而不能只带 id：**超时会抢先**。若第 1 句超时兜底已推进到
   *     第 2 句，那条迟到的回报若不校验就会把第 2 句也误推进（多跳一句、内容丢失）。
   *     `qpart` 就是那个防误推的令牌（模块侧计入 `stats.stale`）。
   *   ★ 这是"等 TTS 播完"的**唯一信号源** —— 模块不猜时长，等的是这一条 POST。 */
  if (req.method === 'POST' && req.url && req.url.split('?')[0] === '/nori-spoken') {
    let sb = ''; req.on('data', (d) => { if (sb.length < 2000) sb += d.toString('utf8'); });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(sb || '{}'); } catch (e) {}
      const qid = (j && (j.qid != null ? j.qid : j.id));
      const ok = SPEECH_Q.report(qid, (j && j.qpart != null) ? j.qpart : null);
      /* ★ 2026-10-30：前端**主动跳过**某句时也会回报（`skip:'ui'|'chat'|'stale-id'`）。
       *   为什么要它：那三种情况 shim 不会播放，若不回报，队列只能等超时兜底
       *   （实测 15% 的条目是这么白等的）。跳过回报让队列**立刻**推进。 */
      if (j && j.skip) {
        log('SPEECH 跳过 qid=' + qid + ' qpart=' + ((j.qpart != null) ? j.qpart : '-') + ' why=' + j.skip);
        try { SPEECH_Q.noteSkip && SPEECH_Q.noteSkip(j.skip); } catch (e) {}
      }
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ ok: ok, stats: SPEECH_Q.getState().stats }));
      } catch (e) {}
    });
    return;
  }
  /* ★★ 编排模块只读观测面。为什么要它：本项目的判据要"在代码里可观测"、
   *   不依赖 grep 日志（B-210 的教训）。看三个数就够：
   *     `stats.timeouts` 涨 ⇒ **回报链路有问题**（前端没刷到新版 shim / 播完没回报）
   *     `queue` 持续涨    ⇒ 放出慢于接收（缓冲积压）
   *     `stats.stale` 涨 ⇒ 回报与当前句错配（超时抢先 / 重复上报）
   */
  if (req.url && req.url.split('?')[0] === '/nori-qstat') {
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(SPEECH_Q.getState(), null, 2));
    } catch (e) {}
    return;
  }
  // ★ D1 只读观测统计（2026-10-02）：一次看清「帧类型 / 生命周期 / sender / 异常计数」
  //   只读端点，不改任何行为。用途：随时确认"某次进/出游戏到底有没有信号"。
  if (req.url && req.url.split('?')[0] === '/nori-obsstat') {
    try {
      const st = OBS.getStats();
      const byType = Object.entries(st.byType || {}).sort((a, b) => b[1] - a[1]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({
        on: OBS.ON, log: OBS.LOG_PATH, verbose: OBS.VERBOSE,
        frames: st.frames, interesting: st.interesting, linesWrite: st.linesWrite,
        noSender: st.noSender, unknownSender: st.unknownSender, errors: st.errors,
        upSec: Math.round((Date.now() - st.startedAt) / 1000),
        byType: Object.fromEntries(byType),
        bySender: st.bySender,
      }));
    } catch (e) {}
    return;
  }
  // debug sink for the front-end probe (nori-chat-fix.js) - lets us see what the bubbles contain
  if (req.url && req.url.split('?')[0] === '/nori-debug') {
    let b = '';
    req.on('data', (d) => { if (b.length < 4000) b += d.toString('utf8'); });
    req.on('end', () => {
      // 前端游戏界面探针（nori-chat-fix.js 的 gameProbe）单独打 GAME-UI 标签，方便 grep
      const isGame = b.indexOf('"gameProbe"') >= 0;
      log(isGame ? 'GAME-UI' : '[DBG]', b.slice(0, 1200));
      try { res.writeHead(204, { 'access-control-allow-origin': '*' }); res.end(); } catch {}
    });
    return;
  }
  // ---------------------------------------------------------------------
  // ★ A1（2026-10-02）：LLM 出口显式路由 —— **必须在下面的兜底转发之前**
  //   把 exe 发来的 /v1/*（chat/completions、models…）转到人格代理 25503，
  //   而不是兜底到 4174（= exe 自己，会形成环路 R1）。
  //   本步**只透明转发**：不改 body / 不改 header（仅改 host）/ 不改状态码，stream 不缓冲。
  //   ⇒ 行为与 exe 直连 25503 完全一致；NORI_LLM_ROUTE=off 可立刻回到旧行为。
  // ---------------------------------------------------------------------
  if (LLM_ROUTE.ON) {
    const _p0 = String(req.url || '').split('?')[0];
    if (_p0.startsWith('/v1/')) {
      // ★ C4（2026-10-02）：代理重启会丢 LIFE 内存状态 ⇒ 转发前用 GameSession 补一次。
      //   只在 LIFE 处于 idle 且当前卡带是游戏时才生效（不会覆盖真实状态）。
      try { if (GAME_SESSION && GAME_SESSION.cartridgeId) LIFE.hydrate(GAME_SESSION.cartridgeId); } catch (e) {}
      LLM_ROUTE.handle(req, res, LISTEN_PORT, log, CHAT_HOOKS); return;
    }
    // A1 验收用（只读，不改变任何行为）：GET /nori-llmstat 看路由计数
    if (_p0 === '/nori-llmstat') {
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ on: true, upstream: LLM_ROUTE.upstreamUrl(), dump: LLM_ROUTE.DUMP, log: LLM_ROUTE.LOG_PATH, stats: LLM_ROUTE.getStats() }));
      } catch (e) {}
      return;
    }
  }
  const headers = Object.assign({}, req.headers, { host: UP_HOST + ':' + UP_PORT, connection: 'close' });
  const p = http.request({ host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers }, (r) => {
    // ---------------------------------------------------------------------
    // 2026-09-27 缓存修正（踩坑记录，别删）
    // 后端对 Vite 产物的响应头是：
    //     cache-control: public, max-age=31536000, immutable
    // 浏览器把它当成「永不改变」，**连条件请求都不发**（immutable 的语义）。
    // 结果：魔改层改了 public/assets/*.js（例如黑化过场时长），刷新页面完全看不到效果
    //       —— 一直在跑浏览器缓存里的旧 chunk。本次排查黑化时长"改不动"就是这个坑。
    // 注意 ?fresh=1 也救不了：nori-fresh-start.js 只清 CacheStorage / localStorage /
    // IndexedDB，清不掉 HTTP 磁盘缓存。
    // 这里统一把 html/js/css 降级成 no-cache（= 每次必须回源验证）：
    // 保留 ETag / Last-Modified，内容没变时照样返回 304，速度几乎不受影响。
    // 首次生效需要浏览器强刷一次（Ctrl+Shift+R）—— 因为旧的 immutable 条目不会主动失效。
    // ---------------------------------------------------------------------
    const h = Object.assign({}, r.headers);
    const ct = String(h['content-type'] || '');
    const u = String(req.url || '');
    if (/text\/html|javascript|text\/css/.test(ct) || /\.(?:js|mjs|css|html)(?:\?|$)/.test(u)) {
      // ★ 2026-09-30 强化：从 no-cache 升级为 no-store。
      //   原因：GameScreen / ChessScreen 等是**动态 import 的 chunk**，文件名里没有内容哈希。
      //   只给 no-cache 时，浏览器仍可能命中**内存缓存**（同一 tab 内刷新时不重新验证），
      //   于是我们改了 chunk 内容、用户刷新后却在跑旧代码（本次"提示卡错位"排查就卡在这）。
      //   no-store 表示「任何缓存都不得存储」→ 每次必定全量下载，本地服务毫秒级，代价可忽略。
      h['cache-control'] = 'no-store, no-cache, must-revalidate';
    }
    res.writeHead(r.statusCode, h); r.pipe(res);
  });
  p.on('error', (e) => { try { res.writeHead(502); res.end('proxy error: ' + e.message); } catch {} });
  req.pipe(p);
});

server.on('upgrade', (req, socket, head) => {
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const isMedia = req.url.split('?')[0].replace(/\/+$/, '').endsWith('/media');
  const up = new WebSocket('ws://' + UP_HOST + ':' + UP_PORT + req.url, protocols, { perMessageDeflate: false });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let settled = false;
  up.on('open', () => {
    if (settled) return; settled = true;
    log('WS up', req.url, 'proto=' + up.protocol, isMedia ? '(MEDIA)' : '');
    wss.handleUpgrade(req, socket, head, (client) => {
      const stream = { seq: 0 }, pending = new Map(), state = new Map();
      const ctx = { ai: null, lastUser: null, history: [], userTs: 0 };
      const injectCommentaryRaw = (text, game) => {
        const c = HEADS.get('chat') || {};
        if (!LAST.worldId || c.head == null) { log('COMMENT skip (chat head unknown)'); return false; }
        // ★★ 2026-09-30 修（战报通道整条失效的根因）：
        //   这里原来用闭包里的 `up`。但 `COMMENT_INJECT` 在 upgrade 处理里**不分主/媒体都赋值**，
        //   而每次连接顺序都是「主连接 → 媒体连接」⇒ 媒体连接最后连上、最后赋值，
        //   于是战报被发到**媒体通道**（那边只走二进制媒体帧）→ 石沉大海。
        //   实测症状：连续 8 条 `COMMENT inject hv=12` 之后，chat 的 head **一动不动**（一直 12），
        //   而且整局没有任何 chat 层的 ack、人格侧一个 TURN 都没有 ⇒ 她全程不知道游戏在进行。
        //   修法：用 `pickUp()`（只从 `UPS` 取，而 UPS 只装非媒体连接）。
        const u = pickUp() || up;
        const msg = { type: 'dispatch', worldId: LAST.worldId, cartridgeId: 'chat', actor: 'player', visibilityFenceId: c.fence || 'ui', cmd: { type: 'playerMessage', text }, expectedHeadVersion: c.head, requestId: randomUUID() };
        try { u.send(JSON.stringify(msg)); } catch (e) { log('COMMENT send err ' + e.message); return false; }
        COMMENT_PENDING = { at: Date.now(), game: game, text: text };
        log('COMMENT inject hv=' + c.head + ' via=' + (u === up ? 'closure' : 'main') + ' ' + JSON.stringify(String(text).slice(0, 70)));
        return true;
      };
      // ★ 只让**主连接**注册这两个注入点（媒体连接注册会覆盖成不可用的 socket）
      if (!isMedia) {
        COMMENT_INJECT = injectCommentaryRaw;
      }
      // ★ 2026-09-30：把她的游戏台词写进**原版 chat 气泡**（官方 agentMessage 命令）。
      //   这样玩家看到的是原版那种 Nori 气泡，而不是自研浮窗。
      const pushAgentChatRaw = (text) => {
        const c = HEADS.get('chat') || {};
        if (!LAST.worldId || c.head == null) { log('AGENTCHAT skip (chat head unknown)'); return false; }
        const t = String(text || '').trim();
        if (!t) return false;
        const msg = { type: 'dispatch', worldId: LAST.worldId, cartridgeId: 'chat', actor: 'agent',
          visibilityFenceId: c.fence || 'ui', cmd: { type: 'agentMessage', text: t.slice(0, 500) },
          expectedHeadVersion: c.head, requestId: randomUUID() };
        // ★ 同上：必须走主上行连接，否则发到媒体通道会被吞掉
        const u2 = pickUp() || up;
        try { u2.send(JSON.stringify(msg)); } catch (e) { log('AGENTCHAT send err ' + e.message); return false; }
        log('AGENTCHAT → 原版气泡 via=' + (u2 === up ? 'closure' : 'main') + ' ' + JSON.stringify(t.slice(0, 70)));
        return true;
      };
      // ★ 同上：只让**主连接**注册（媒体连接注册会让所有注入发到不可用的 socket）
      if (!isMedia) AGENT_CHAT_PUSH = pushAgentChatRaw;
      const injectCommentary = (text, game) => commentQueue(text, game);
      // ★★★ 2026-10-01 修正（上一版 destroy 引入的**严重回归**）
      //   原来 `new GameSession` 是**无条件执行**的 ⇒ **媒体连接（/media）也会建实例
      //   并覆盖 GAME_SESSION**；而 destroy 同样无条件 ⇒ 媒体连接一建立就把
      //   **主连接的游戏会话**禁用。
      //   主连接 `handleClient` → `handleUp` 首行 `if (!this.enabled) return false`
      //   ⇒ **玩家命令全部被丢**（连 `GAME HOLD` 都不打）⇒ 她不再猜牌
      //   ⇒ 回合永不结束 ⇒ **`finishTurn()` 不跑 ⇒ 战报（COMMENT）永不产生**
      //   —— 用户报的「战报好像没传到」就是这个。
      //   实测时序：主连接建实例 → 1~3 秒后 /media 连接把它销毁 ⇒ 游戏完全不可玩。
      //   修法：游戏会话**只归主连接**（媒体连接本来也不需要它 —— 游戏 transition
      //   只走主连接；`handleClient` 早有 `!isMedia` 守卫）。顺带消除空转实例。
      let gsess = null;
      if (!isMedia) {
        try { if (GAME_SESSION && typeof GAME_SESSION.destroy === 'function') GAME_SESSION.destroy(); } catch (e) { log('旧 GameSession 销毁失败 ' + e.message); }
        gsess = new GameSession({ log, sendUp: (m) => { try { up.send(m); } catch {} }, onLine: pushGameLine, onCommentary: injectCommentary, injectFact, hasFact: (f) => FACTS.has(f),
          onGameEnd: (cid) => { COMMENT_SUSPEND = { game: cid, at: Date.now() }; COMMENT_Q = []; COMMENT_PENDING = null; log('COMMENT 挂起（' + cid + ' 本局结束，' + COMMENT_SUSPEND_TTL + 'ms 后自动解除）'); },
          onGameStart: (cid) => { if (COMMENT_SUSPEND && COMMENT_SUSPEND.game === cid) { COMMENT_SUSPEND = null; log('COMMENT 恢复（' + cid + ' 新局开始）'); } } });
        GAME_SESSION = gsess;   // 供代理内部查当前游戏（`/nori-say` 已删，现仅内部使用）
        MAIN_CLIENTS.add(client); UPS.add(up);
        // 新客户端（页面刷新/重连）来了：把节拍重试计数清零，避免上一次「没有在线客户端」把次数烧完
        BEAT_TRIES.clear();
      }
      client.on('message', (data, isBin) => {
        let handledLocally = false;
        if (!isBin) {
          try {
            const j = JSON.parse(data.toString('utf8'));
            OBS.saw(j, 'out', 'recv');   // ★ D1 观测（只读）
            // ★ B3：出站帧过枢纽（shadow：只分类 + 比对，不改帧）
            try { HUB.process(j, 'out'); } catch (e) {}
            if (j.type === 'event' && j.channel === 'nori.ai.config' && j.payload) {
              ctx.ai = j.payload;
              log('AI-CFG model=' + j.payload.model + ' sys=' + String(j.payload.systemPrompt || '').length + ' char=' + String(j.payload.characterPrompt || '').length + ' key=' + (j.payload.apiKey ? 'yes' : 'no'));
            }
            if (j.type === 'dispatch' && j.cartridgeId === 'chat' && j.cmd && j.cmd.type === 'playerMessage') {
              if (j.visibilityFenceId) HEADS.set('chat', Object.assign(HEADS.get('chat') || {}, { fence: j.visibilityFenceId }));
              ctx.lastUser = String(j.cmd.text || ''); ctx.userTs = Date.now();
              ctx.history.push({ role: 'user', content: ctx.lastUser });
              log('USER', JSON.stringify(ctx.lastUser));
              maybePharos(ctx.lastUser);
            }
            if (j.type === 'dispatch' && j.cartridgeId === 'chat' && j.cmd && (j.cmd.type === 'audioStarted' || j.cmd.type === 'audioDone')) {
              const rv = j.cmd.operationId ? findRevealByOp(j.cmd.operationId) : null;
              if (rv && j.cmd.blockId != null) ackAllowed(rv, j.cmd.blockId);
              log('ACK', j.cmd.type, 'block=' + j.cmd.blockId, 'actor=' + (j.actor || '?'), 'exp=' + j.expectedHeadVersion, 'op=' + String(j.cmd.operationId || '').slice(0, 8));
              // 2026-09-27（问题 7）：把"她在说话 / 说完了"同步给游戏层，
              // 好让她的落子踩在语音节拍上（等上一句播完再下子）。
              try {
                if (GAME_SESSION) {
                  if (j.cmd.type === 'audioStarted') GAME_SESSION.noteSpeechStart();
                  else GAME_SESSION.noteSpeechDone();
                }
              } catch (e) {}
            }
            if (j.type === 'event' && j.channel === 'manifold.artifacts.request' && j.payload && j.requestId) {
              ART_REQ.set(j.requestId, String(j.payload.artifactType || ''));
              ART_REQ_KEY.set(j.requestId, String(j.payload.lookup_key || j.payload.key || j.payload.url || ''));
              log('ARTIFACT req ' + String(j.payload.artifactType || '') + ' key=' + String(j.payload.lookup_key || '').slice(0, 60) + ' req=' + String(j.requestId).slice(0, 8));
            }
            if (j.type === 'event' && j.channel === 'manifold.artifacts.fetch' && j.payload && j.requestId) {
              ART_REQ.set(j.requestId, String(j.payload.artifactType || ''));
              ART_REQ_KEY.set(j.requestId, String(j.payload.lookup_key || ''));
              log('ARTIFACT fetch ' + String(j.payload.artifactType || '') + ' key=' + String(j.payload.lookup_key || '').slice(0, 80));
            }
            if (j.type === 'event' && j.channel === 'manifold.command.request' && j.payload) {
              const cmdName = String(j.payload.command || '');
              if (cmdName === 'vault.unlock') { handleVaultUnlock(client, j); handledLocally = true; }
              else if (cmdName === 'signal.daniel.verify') { handleDanVerify(client, j); handledLocally = true; }
              else if (cmdName === 'signal.recover' || cmdName === 'signal.login') { if (handleLocalDispatch(j, client)) handledLocally = true; }
              // ssh/NAS 与省钱喵走的是 commands 包装器（manifold.command.request → .response）
              else if (/^(nas\.|manifold\.bounty\.|bounty\.installExtension$|concord\.)/.test(cmdName)) { if (handleLocalDispatch(j, client)) handledLocally = true; }
              // 诊断（2026-09-25）：QFR-9000 归档区一开局就显示「已恢复 14/14」。疑本地 exe 对
              // QFR/归档类命令直接回罐头「已全部恢复」，故把这类未处理命令与其回包都记下来定位。
              else if (/qfr|recover|seal|volume|unseal|archive|vault/i.test(cmdName)) log('CMD-UP ' + cmdName + ' ' + JSON.stringify(j.payload).slice(0, 220));
            }
            // 省钱喵提交 / ssh(NAS)：客户端走的是专用 event 通道（wo(request,response)）
            if (j.type === 'event' && j.channel && j.payload && j.channel !== 'manifold.command.request') {
              const ch = String(j.channel);
              if (ch === 'manifold.bounty.submit') { handleBountySubmit(client, j); handledLocally = true; }
              else if (ch === 'bounty.installExtension') { handleBountyInstall(client, j); handledLocally = true; }
              else if (/^nas\.(connect|list|read|download)$/.test(ch)) { handleNas(client, j, ch.slice(4)); handledLocally = true; }
            }
            // 客户端自己发的事实（client.emitFact）：官方由服务端落库后广播；本地 exe 的回落路径
            // 不一定把新事实回灌进 state，所以代理自己也记一份（记忆过场的 arg.memory.start 靠它放行工件）。
            if (j.type === 'dispatch' && j.cmd && String(j.cmd.type || '') === 'client.emitFact') {
              const fid = j.cmd.factId || j.cmd.fact;
              if (typeof fid === 'string' && fid) addFact(fid, 'client.emitFact');
            }
            // 高维范式小游戏完成（idle.complete）：客户端在「arg.manifold_unlocked 已解锁 + 未完成 +
            // 13 枚纪念品全部认领」后每 5s 发一次（NormalApp Ltt：manifoldCompletionOwed → r('idle.complete')）。
            // 官方由服务端落 idle.manifold_complete 并回灌 facts；本地 exe 只回 {ok:true} 且 committed:false
            // （实测 2026-09-26 n_proxy4199.log：16:52:29 起连发到 17:07，headVersion 一动不动），
            // 世界状态永不推进 → idle.manifold_complete 永不落地 → BEATS 的 recover.datasea_exe
            // （ok: FACTS.has('idle.manifold_complete')）恒 false → 数据海/告别/结局全链锁死。
            // 所以代理自己落这条 fact 并用 dev.jump 补发给客户端（客户端 facts 拿到后即停止重发）。
            if (j.type === 'dispatch' && j.cmd && String(j.cmd.type || '') === 'idle.complete') {
              if (!FACTS.has('arg.manifold_unlocked')) log('IDLE-COMPLETE 到达但代理尚无 arg.manifold_unlocked（异常，仍按客户端语义补齐）');
              addFact('idle.manifold_complete', 'client.idle.complete');
              injectFact('idle.manifold_complete', '客户端 idle.complete（本地 exe 不落库，代理补齐）');
            }
            if (j.type === 'dispatch' && j.cmd) {
              const ct = String(j.cmd.type || '');
              if (ct !== 'idle.sync') log('CLI dispatch cart=' + (j.cartridgeId || '') + ' cmd=' + ct + ' ' + JSON.stringify(j.cmd).slice(0, 170));
              if (/download|save|export/i.test(ct)) {
                const cands = [j.cmd.id, j.cmd.fileId, j.cmd.lookup_key, j.cmd.name, j.cmd.filename, j.cmd.path].filter((x) => typeof x === 'string' && x);
                for (const cand of cands) {
                  if (FILE_META.has(cand)) { DOWNLOADED.add(cand); log('DL cmd ' + ct + ' -> ' + cand); }
                  else for (const [fid, meta] of FILE_META) if (meta.name && cand.indexOf(meta.name) >= 0 && !DOWNLOADED.has(fid)) { DOWNLOADED.add(fid); log('DL cmd ' + ct + ' -> ' + fid); }
                }
              }
              compensateRead(j);
              if (handleLocalDispatch(j, client)) handledLocally = true;
            }
          } catch {}
        }
        if (!isMedia && !isBin) { try { const gj = JSON.parse(data.toString('utf8')); if (gj && gsess && gsess.handleClient(gj)) return; } catch (e) { log('GAME cli err ' + e.message); } }
        if (!handledLocally) { try { up.send(data, { binary: isBin }); } catch {} }
      });
      client.on('close', () => { MAIN_CLIENTS.delete(client); UPS.delete(up); if (gsess && gsess.held) { log('GAME client closed while holding -> release'); gsess.release(gsess.held); } try { up.close(); } catch {} });
      client.on('error', () => {});
      up.on('message', (data, isBin) => {
        if (isMedia) { mediaToClient(client, data, isBin, stream, pending, state); return; }
        if (isBin) { try { client.send(data, { binary: true }); } catch {} return; }
        const txt = data.toString('utf8');
        if (tryRepair(txt, ctx, client)) return;
        let out = txt;
        OBS.saw(txt, 'in', 'recv');   // ★ D1 观测：服务端【原样】发来的（改写前）
        // ★ C4（2026-10-02）：喂给生命周期状态机（只读，不改帧）
        // ★★ 2026-10-03：同一个入口顺带做"换局 ⇒ 软清空编排缓冲"（见 noteLifeFrame 的说明）
        try { noteLifeFrame(txt); } catch (e) {}
        // ★ B3（2026-10-02）：入站帧过枢纽（shadow：只分类 + 比对，不改帧）
        try { HUB.process(txt, 'in'); } catch (e) {}
        // ★ D1（2026-10-02）：从帧里提取 game-event 并投递到拼接器的 PENDING（只读消费，不改帧）
        //   抽取/分类复用 hub 的 extractUnits（B2 已有），这里只做 render + 入匣。
        try { SPLICE.ingest(txt); } catch (e) {}
        // 她的战报回复 → 同步成游戏内气泡（语音由原生聊天通道出，避免双声）
        if (COMMENT_PENDING && Date.now() - COMMENT_PENDING.at < 20000) {
          try {
            const cj = JSON.parse(txt);
            const ct = cj && cj.transition && cj.transition.cmd;
            if (ct && ct.type === 'ingestBlock' && ct.isSpeech !== false && ct.content && !isCommentEntry(ct)) {
              const sp = cleanAgentText(ct.content);
              if (sp.text) pushGameLine({ text: sp.text, emotion: sp.emotion || ct.emotion || 'neutral', game: COMMENT_PENDING.game, from: 'chat' });
              COMMENT_PENDING = null;
            }
          } catch {}
        }
        try {
          const j = JSON.parse(txt);
          if (outboundFix(j)) { out = JSON.stringify(j); log('REWRITE agent text (clean/split/reveal)'); }
        } catch (e) { log('FIX err: ' + (e && e.message)); }
        try {
          const k = JSON.parse(out);
          if (k) absorbDeep(k, 0);
          OBS.saw(k, 'in', 'send');   // ★ D1 观测：我们【实际转发】的（改写后）—— 与 recv 对比即看出改了什么
          // 诊断：把 QFR/归档类命令的回包记下来（看本地 exe 到底回了什么）
          if (k && k.type === 'event' && k.channel === 'manifold.command.response') {
            const s2 = JSON.stringify(k.payload || {});
            if (/qfr|recover|seal|volume|unseal|archive|Vault/i.test(s2)) log('CMD-RESP ' + String(k.requestId).slice(0, 8) + ' ' + s2.slice(0, 320));
          }
          if (k && k.type === 'event' && k.channel === 'manifold.dev.jump.response') {
            const f = INFLIGHT.get(k.requestId);
            if (f) {
              INFLIGHT.delete(k.requestId);
              const p = k.payload || {};
              if (p.ok) { BEAT_TRIES.delete(f); addFact(f, 'dev.jump'); log('BEAT ok ' + f + ' count=' + p.count); }
              else log('BEAT rejected ' + f + ' ' + JSON.stringify(p).slice(0, 200));
            }
          }
          if (k && scheduleArtifacts(k)) out = JSON.stringify(k);
          if (k && fixAssetSizes(k)) out = JSON.stringify(k);
          if (k && injectAppArtifacts(k)) out = JSON.stringify(k);
          if (k && injectVaultFiles(k)) out = JSON.stringify(k);
        if (k && sealArchiveFiles(k)) out = JSON.stringify(k);
          if (k && injectLocalPages(k)) out = JSON.stringify(k);
          /* ★★ 2026-10-07 顺序修正（C2/C3）：
             chipRoute 必须跑在 `sanitizeChip` **之前**。
             原因：`sanitizeChip` 里就是 `out = JSON.stringify(k)` —— 若 chipRoute 在它之后，
             改过的 `payload.text` 根本不会被序列化；更糟的是当 exe 给的 kind/text 本来就合法时
             `sanitizeChip` 返回 false（dirty=false），`out` **完全不更新**。
             实测症状：玩家看到的仍是 exe 的占位读数
             `Archived scan replay -key=page:…,row=…` —— 我们的覆写静默丢失。
             ⇒ 现在：① chipRoute 先改 payload ② sanitizeChip 再清洗并序列化
                ③ 若 sanitize 没改动（返回 false）但 chipRoute 改过 ⇒ 这里补一次序列化。 */
          let chipTouchedOut = false;
          if (k && k.type === 'event' && k.channel === 'manifold.chip.scan.result') {
            try { chipTouchedOut = !!chipRoute(k); } catch (e) { log('CHIP route err ' + e.message); }
          }
          if (k && sanitizeChip(k)) out = JSON.stringify(k);
          else if (k && chipTouchedOut) out = JSON.stringify(k);
          if (k) trackHead(k);
          try { if (k && gsess) gsess.handleServer(k); } catch (e) { log('GAME srv err ' + e.message); }
          if (k && (k.type === 'dispatch_ack' || k.type === 'error')) log('SRV', k.type, 'cart=' + (k.cartridgeId || ''), 'hv=' + (k.headVersion == null ? '' : k.headVersion), 'err=' + (k.errorCode || ''), JSON.stringify(k).slice(0, 260));
          runBeats();
        } catch {}
        captureText(out);
        if (ctx.userTs && /"sender":"agent"/.test(txt)) {
          const lag = Date.now() - ctx.userTs; ctx.userTs = 0;
          log('AGENT +' + lag + 'ms');
        }
        try { client.send(out, { binary: false }); } catch {}
      });
      up.on('close', () => { try { client.close(); } catch {} });
      up.on('error', () => {});
    });
  });
  up.on('error', (e) => { if (!settled) { settled = true; log('WS up error', req.url, e.message); try { socket.destroy(); } catch {} } });
});

/* ★★ 2026-10-04：装配剧情台词播放器（说明见文件顶部；计划 _arch/107）
 *   放在 listen 之前 ⇒ 此刻 log / FACTS / FACTS_AT / pushGameLine 都已就绪。 */
try {
  SCRIPT = require('./nori_script.js')({
    log: log,
    hasFact: (id) => FACTS.has(id),
    factAt: (id) => FACTS_AT.get(id) || 0,
    pushGameLine: (o) => pushGameLine(o),
  });
  const nBeats = SCRIPT.arm();
  const st = SCRIPT.status();
  log('SCRIPT 剧情台词已就绪 beats=' + nBeats + ' 待填词=' + (st.todo.length ? st.todo.join(',') : '无'));
} catch (e) { console.warn('[script] nori_script.js 加载失败：' + e.message); SCRIPT = null; }

/* ★★ 2026-10-16：**对话拦截钩子** —— 目前一条：摸尾巴（`_arch/137` / 用户 10-16 定）
 *   为什么需要：官方**没有**摸尾巴的手势/交互（用户："摸尾巴在官方没有实现，只有对话的时候会说"），
 *   而 V4.4 给了固定 3 句。若照常转发上游 ⇒ LLM 会自己发挥一句，再叠上我们的固定台词就**重复**了。
 *   ⇒ 命中即**不转发上游**，由固定回应直接答（`nori-llm-route.js` 的 `sendFixed`）。
 *
 *   ⚠ **必须排除游戏回合**：那些请求带 `response_format.type === 'json_object'`
 *     （她要输出动作 JSON）⇒ 返回台词会让游戏解析失败。
 *   ⚠ 记忆照常写：`SCRIPT.sayInstead()` 会 POST `/nori-scriptline`（首次写卡、之后 `transient` 不写），
 *     只是**不自己上屏** —— 上屏由这次固定回应承担。
 *
 *   ★ 2026-10-16 晚「放宽 PET_TAIL_RE」：判据搬进 **`nori-tail-hook.js`**
 *     —— **代理与测试 `require` 同一份**，避免"测试过了、线上跑的是旧的"。
 *     旧正则 `/摸.{0,6}尾巴|尾巴.{0,6}摸|揉.{0,6}尾巴/` 要求「摸」与「尾巴」**同句**，
 *     而真实对话是**多轮**的（先提"尾巴"，后面用"摸/软/接口"承接）⇒ 实测 3 句一条都没命中。
 *     新判据 = 话题窗口（本句说尾巴 / 本句触摸 + 近 5 轮用户消息提过尾巴），细节见该文件顶部。
 *     `why` 会带命中原因（`明说尾巴` / `承接尾巴话题`），日志可分辨。
 */
const TAIL_HOOK = (function () {
  try { return require('./nori-tail-hook.js'); }
  catch (e) { console.warn('[tailhook] nori-tail-hook.js 加载失败：' + e.message); return null; }
})();
const CHAT_HOOKS = {
  onChat: function (text, bodyObj) {
    /* ★ 2026-10-16：过场闸门 —— 过场中**让路给 LLM**（她只说剧情里的话，更贴近官方行为）。 */
    if (petGateWhy()) return null;
    const why = TAIL_HOOK ? TAIL_HOOK.reason(text, bodyObj) : null;
    if (!why) return null;
    const r = (SCRIPT && typeof SCRIPT.sayInstead === 'function') ? SCRIPT.sayInstead('touch_tail') : null;
    if (!r || !r.lines || !r.lines.length) return null;
    return { lines: r.lines, emotion: r.emotion, why: 'pet-tail(' + why + ')' };
  },
};

server.listen(LISTEN_PORT, '127.0.0.1', () => log('proxy listening on http://127.0.0.1:' + LISTEN_PORT + ' -> ' + UP_HOST + ':' + UP_PORT + ' | tts=' + TTS_URL));
// ★ A1（2026-10-02）：LLM 出口路由已挂 —— 未改 OPENAI_BASE_URL 前不影响任何行为
if (LLM_ROUTE.ON) log('LLMROUTE /v1/* -> ' + LLM_ROUTE.upstreamUrl() + '（透明转发；NORI_LLM_ROUTE=off 可关；dump=' + (LLM_ROUTE.DUMP ? 'on' : 'off') + ' -> ' + LLM_ROUTE.LOG_PATH + '）');
if (LLM_ROUTE.ON) { try { setInterval(() => { if (LLM_ROUTE.getStats().hits) log(LLM_ROUTE.summaryText()); }, 5 * 60 * 1000).unref(); } catch (e) {} }
// ★ D1（2026-10-01）：每 5 分钟写一行观测摘要到 obs.log（证明覆盖度、汇总未知 sender）
if (OBS.ON) {
  try { setInterval(() => OBS.summary('periodic'), 5 * 60 * 1000).unref(); } catch (e) {}
  log('OBS 全帧观测已启用 -> ' + OBS.LOG_PATH + '（NORI_OBS=off 可关）');
}
