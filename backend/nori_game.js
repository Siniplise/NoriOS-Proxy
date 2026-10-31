// nori_game.js — 游戏层：把「玩家的话 + 局面」交给 Nori 人格代理，由她自己决定听不听，
// 然后由我们在服务端假 AI 醒来之前（~360ms）替她把整回合走完。
// 纯逻辑模块，不碰网络；由 nori_proxy.js 调用。
// 依赖注入：{ log, sendUp(obj)->void, onLine(o)->void, onCommentary(text,game)->bool,
//            injectFact(fact,why)->bool, hasFact(fact)->bool }
// 两种范式：
//   hold 式：codenames / chess / cakeduel —— 扣住玩家动作 → 问大脑 → 放行玩家 + 链式补她的整回合
//   辅助式：pictionary —— 玩家画、agent 猜；服务端不会自动猜，由我们替 agent 主动猜
'use strict';
const { randomUUID } = require('crypto');

let Chess = null;
try { Chess = require('chess.js').Chess; } catch (e) { Chess = null; }

const GAME_CARTRIDGES = new Set(['codenames', 'chess', 'cakeduel', 'pictionary']);const GAME_NAME = { codenames: '森林寻宝', chess: '国际象棋', cakeduel: '蛋糕对决', pictionary: '你画我猜' };
const BRAIN_URL = process.env.NORI_BRAIN_URL || 'http://127.0.0.1:25503/game-turn';
const HOLD_MS = Number(process.env.NORI_HOLD_MS || 8000);
const DIRECTIVE_TTL = Number(process.env.NORI_DIRECTIVE_TTL || 120000);
const PIC_GUESS_MS = Number(process.env.NORI_PIC_GUESS_MS || 2600);
const PIC_FIRST_MS = Number(process.env.NORI_PIC_FIRST_MS || 1800);
/* ★ B-105（2026-10-03）：玩家「停笔」多久才算画完 ⇒ 之后立刻让她看一次。
 *   原来只靠 `PIC_GUESS_MS`(2600ms) 定轮询 ⇒ 经常在她还没画完时就交答案
 *   （gap 审计：「固定 2600ms 轮询 vs NoriAutoDrawer 笔间 300~2000ms ⇒ 她未画完就被猜」）。 */
const PIC_DEBOUNCE_MS = Number(process.env.NORI_PIC_DEBOUNCE_MS || 700);
const AGENT_INDEX = Number(process.env.NORI_AGENT_INDEX || 1);

// ==================== 2026-09-27 新增（问题 5–9 修复）====================
// 6-B：代理连续替她出招时的最小间隔，避免"一秒九连猜"看起来不像在思考。
const AGENT_STEP_MS = Number(process.env.NORI_AGENT_STEP_MS || 2200);
// 9：蛋糕对决——轮到她时的主动驱动轮询（原实现只在"玩家动作后补一步"，
//    第 2 轮由她开局时无人驱动 → 双方都不动 → 卡死）。
const CAKE_TICK_MS = Number(process.env.NORI_CAKE_TICK_MS || 700);
// 7：落子前等她上一句语音收尾的余量；以及最多等多久。
const TTS_TAIL_MS = Number(process.env.NORI_TTS_TAIL_MS || 300);
const TTS_WAIT_CAP = Number(process.env.NORI_TTS_WAIT_CAP || 3000);   // ★ 12s → 3s（问题 1）
// 2026-09-27（问题 4）：她走子太快、像脚本。这里给她一个「思考」的最短时间。
const CHESS_THINK_MS = Number(process.env.NORI_CHESS_THINK_MS || 2600);
const CAKE_THINK_MS = Number(process.env.NORI_CAKE_THINK_MS || 1400);
/* ★★★ 节奏对齐（2026-10-03）：**质疑揭示动画**的前端真实时长（读 bundle 得到，非猜测）：
 *     `PNe = { CHALLENGE_FLIP_STAGGER: 400, CHALLENGE_PRE_REVEAL_PAUSE: 1000,
 *              CHALLENGE_REVEAL_HOLD: 3000, BANNER_DURATION: 2000 }`
 *   ⇒ 质疑一次 ≈ 1000(揭示前停顿) + 3000(揭示保持) ≈ **4000ms**（banner 另计）。
 *   症状：`CAKE_THINK_MS` 只有 1400 ⇒ **她在这个动画播完前就出手** ⇒
 *   看起来"她抢跑"；且前端 `activeEffect` 期间禁用交互 ⇒ 玩家"点不了"。
 *   ★ 只在「刚发生过质疑」时生效（`cakeHoldUntil` 窗口），**不影响平时的出手节拍**。 */
const CAKE_AFTER_REVEAL_MS = Number(process.env.NORI_CAKE_AFTER_REVEAL_MS || 3600);
// 5：把玩家的笔画栅格化成字符画喂给大脑（替代"只给拼音"→ 谐音作弊）。
const PIC_ASCII_W = Number(process.env.NORI_PIC_ASCII_W || 56);
const PIC_ASCII_H = Number(process.env.NORI_PIC_ASCII_H || 34);
// 真·看图用的画布边长（官方 snapshot 也是长边 256）
const PIC_PNG_SIZE = Number(process.env.NORI_PIC_PNG_SIZE || 256);
// 兜底出招：万一大脑失败，也要从合法动作里挑一个发出去，绝不让对局卡死
const FALLBACK_BAD = /^(concede|challenge|endTurn|end)$/i;
// 森林寻宝「算力超限」触发条件：**Nori 连续踩到浆果（中性牌）N 次**。
// 2026-09-30 修：原实现只看「有没有 cell 带 bystanderMarks」，于是**玩家自己踩的也算**，
//   而且踩 1 次就触发。官方设定是她连续三次踩浆果（那种"她开始失灵"的观感）。
const BERRY_STREAK = Number(process.env.NORI_BERRY_STREAK || 3);
// ★★★ 2026-09-30 修复（我的回归 bug）：这个常量**被之前的编辑误删了**，只剩引用 →
//   运行时 `ReferenceError: CODEX_FALLBACK_CLUES is not defined` →
//   **所有兜底给词路径一调用就抛异常**（fallbackClueWord/forceFallbackClue/maybeSendClue 的
//   空值分支）⇒ 她给词失败时本该兜底补一个，结果直接崩 → 表现为「卡在 Nori 正在想提示」。
//   现在补回来，并**加了自检**（见 assertClueTable）防止再次静默丢失。
//   选词要求：① 不与棋盘撞（引擎拒"Clue word cannot be on the board"）；
//            ② 不含空白/数字（引擎拒 "Invalid clue word"）；③ 是"没什么信息量"的中性名词。
const CODEX_FALLBACK_CLUES = ['词语', '东西', '事情', '物体', '概念', '名词', '主题', '类别',
  '事物', '情形', '内容', '名字', '种类', '样子', '方向', '地方'];
// ★ 启动自检：这个常量被误删过一次（只剩引用）→ 所有兜底给词路径 ReferenceError →
//   表现为「卡在 Nori 正在想提示」。这里加载时就检查，宁可吵也不能再静默丢。
if (!Array.isArray(CODEX_FALLBACK_CLUES) || CODEX_FALLBACK_CLUES.length < 3) {
  console.error('[nori_game] 致命：CODEX_FALLBACK_CLUES 缺失/过短 —— 兜底给词会崩，请立即修复！');
}
for (const _w of CODEX_FALLBACK_CLUES) {
  if (/[\s\d]/.test(_w)) console.error('[nori_game] 兜底词「' + _w + '」含空白或数字 → 引擎会拒（Invalid clue word）');
}
// ★★ 2026-09-30（用户建议「加节流，让返回的数据存一会再执行」—— 判断正确）：
//   前端的揭示动画每张牌要 2~4 秒，而且它有个
//     `if (c !== i) return;`   // 后续 transition 被丢弃
//   的守卫 —— 我们的指令发得太密时，前端会**丢掉过渡**，于是 gameState 推进了、
//   界面还停在旧状态（表现为"卡在 Nori 正在想提示"）。
//   **假 AI 已关掉，不存在抢跑竞争**，所以完全可以放慢到跟动画同拍。
//   下面两条：她出招的最小间隔（AGENT_STEP_MS，原 1100）与给提示词前的缓冲。
const CLUE_DELAY_MS = Number(process.env.NORI_CLUE_DELAY_MS || 1600);
// ★★★ 2026-09-30 新增：森林寻宝「突然死亡（SUDDEN_DEATH）」阶段。
//   引擎规则（NormalApp IAe / U$ / a1）：
//     - phase 变 SUDDEN_DEATH 后**不允许再给提示词**（给词会回 "Can only submit clues during NORMAL phase"）
//     - 双方改为**直接猜「对方阵营」的词**（vg(e) = 对手 side，key[对手][cell]）
//     - 猜中 → cells[cell].solvedBy = 自己；踩到 BYSTANDER/ASSASSIN → **立即 GAME_OVER 判负**
//     - 所有 AGENT 格被解开 → GAME_OVER，winner "TEAM"
//     - **没有回合归属检查**（IAe 只校验 U$(t,e) = 对手还剩词可猜）→ 双方同时抢答
//   原来官方是靠假 AI 的 0.35s 循环在这个阶段自动出招的 —— 我们把假 AI 关掉后
//   就没人替她猜了 → 表现为「卡住不动」。这里补上她的自主猜牌。
const SD_TICK_MS = Number(process.env.NORI_SD_TICK_MS || 900);
const SD_STEP_MS = Number(process.env.NORI_SD_STEP_MS || 2600);
// 她「说出想法」之后，留给他回话的窗口（他在聊天框里说话 → 她会听到并改主意）
const SD_CONSULT_MS = Number(process.env.NORI_SD_CONSULT_MS || 6000);
// ★★ 2026-10-01（防"无限重试"）：突然死亡阶段连续出手多少次仍无进展就放弃。
//   背景：出手后若服务端没推进（无 ack / 被静默丢弃），in-flight 看门狗会 6s 后
//   清理并重试。若根因是 head 失同步（见 checkEvents 里的 version 校准），
//   这会变成**永久循环**，而且每一次循环都 say() 一句 ⇒ 气泡无限堆积
//   （用户 12:22 实测看到「几个气泡一直在」）。
//   head 校准已治本；这里再加一道硬上限，任何原因导致的持续失败都能停下来。
const SD_MAX_FAILS = Number(process.env.NORI_SD_MAX_FAILS || 3);
function pickFallback(spec) {
  const ids = ((spec && spec.legal) || []).map((l) => String(l.id || ''));
  if (!ids.length) return null;
  return ids.find((id) => !FALLBACK_BAD.test(id)) || ids[0];
}
/* ★★★ B-109（2026-10-03）：棋类兜底**不能"取第一个合法步"** —— 那等于随机送子。
 *   实测背景：本地假 AI 已被关停（`Nori.Web.noai.exe`），大脑失败时我们必须出手，
 *   而 `pickFallback` 只按 id 字符串挑第一个 ⇒ 她经常走一步白送子的棋。
 *
 *   这里做**一层最小评估**（不引入引擎）：
 *     加分：将杀 ≫ 将军 · 吃子价值 · 升变价值
 *     减分：**走完这步之后，对手最能吃回多少**（用同一棋盘走一步再看对手的吃子，然后 undo）
 *   ⇒ 效果：优先吃掉「无保护的子」、避开「会被吃回的亏」。
 *   ★ 纯函数（走完必 undo，只读棋盘）⇒ 可直接单测。
 *   ★ 加极小随机项：避免同一局面每次选同一步（否则她会被读死）。 */
function pickChessFallback(c) {
  if (!c) return null;
  let moves;
  try { moves = c.moves({ verbose: true }); } catch (e) { return null; }
  if (!moves.length) return null;
  const VAL = { p: 10, n: 30, b: 30, r: 50, q: 90, k: 0 };
  let best = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    const san = String((m && m.san) || '');
    let s = 0;
    if (san.indexOf('#') >= 0) s += 100000;                      // 将杀
    else if (san.indexOf('+') >= 0) s += 15;                     // 将军
    if (m && m.captured) s += (VAL[m.captured] || 0) * 2;        // 吃子
    if (m && m.promotion) s += (VAL[m.promotion] || 0) * 2;      // 升变
    try {
      c.move(m);
      let worst = 0;
      for (const om of c.moves({ verbose: true })) {             // 对手最能吃回多少
        if (om && om.captured) worst = Math.max(worst, VAL[om.captured] || 0);
      }
      c.undo();
      s -= worst * 2;
    } catch (e) {
      try { c.undo(); } catch (e2) {}
    }
    s += Math.random() * 0.4;                                    // 打破平局
    if (s > bestScore) { bestScore = s; best = m; }
  }
  if (!best) return null;
  return String(best.from || '') + String(best.to || '') + String(best.promotion || '');
}
// ★ 2026-10-04（B-111）：`PIC_SEA_RE` 已删除 —— 它只服务于已废除的 `checkPicMilestone()`
//   （那个函数判"题目是不是海洋词"，与官方语义"**她猜出「水母」**"不符）。
//   现判据直接比较她猜出的词（`picTick` 里 `guess === '水母'`），不再需要正则。

const GESTURES = ['gesture.chess', 'gesture.pictionary', 'gesture.codenames', 'gesture.cakeduel'];
const GESTURE_DONE = 'arg.gestures_complete';

// 蛋糕对决 base set 卡牌表（取自前端 bundle）：attack=>攻击阶段可宣称；blockType=>可格挡的伤害类型
const CARD_TABLE = {
  soldier: { type: 'physical', attack: 1 }, archer: { type: 'physical', attack: 1 },
  wizard: { type: 'magical', attack: 2 }, defender: { type: 'blocker', blockType: 'physical' },
  scientist: { type: 'blocker', blockType: 'magical' }, wolfy: { type: 'unclaimable' },
  assassin: { type: 'physical', attack: 5 }, scout: { type: 'physical', attack: 1 },
  summoner: { type: 'magical', attack: 0 }, quartermaster: { type: 'special', attack: 0 },
  oracle: { type: 'special', attack: 0 }, priest: { type: 'special', attack: 0 },
  angel: { type: 'special', attack: 0 }, baacrates: { type: 'special', attack: 0 },
  agent_u: { type: 'special', attack: 0 }, pierrot: { type: 'special', attack: 0 },
  robot: { type: 'special' },
};
function now() { return Date.now(); }
function uuid() { return randomUUID(); }
// ★ 2026-09-30：与引擎 `_validate_clue` 的 `word.strip().upper()` 对齐 —— 棋盘比对必须大小写不敏感。
const normWord = (w) => String(w == null ? '' : w).replace(/^\s+|\s+$/g, '').toUpperCase();
const cardMeta = (n) => CARD_TABLE[n] || {};

// ==================== 2026-09-27：真·看图（把玩家画渲染成 PNG 喂视觉模型）====================
// 已实测 deepseek-flash **支持多模态**（发一张三角形图，它答"三角形"）。
// 所以不再靠字符画近似，直接把笔画渲染成 PNG，用 image_url 传过去。
// 只用 node 内置 zlib，不引外部依赖。
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePngRgb(rgb, w, h) {
  const zlib = require('zlib');
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;                                   // filter = None
    rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

class GameSession {
  constructor(io) {
    this.io = io || {};
    this.log = this.io.log || (() => {});
    this.sendUp = this.io.sendUp || (() => {});
    this.onLine = this.io.onLine || (() => {});
    this.onCommentary = this.io.onCommentary || (() => {});
    this.injectFact = this.io.injectFact || (() => false);
    this.hasFact = this.io.hasFact || (() => false);
    this.onGameEnd = this.io.onGameEnd || (() => {});     // 2026-09-27（问题 8）：整局结束 → 挂起战报
    this.onGameStart = this.io.onGameStart || (() => {}); // 新局开始 → 恢复
    this.turnLog = []; this.worldId = null; this.cartridgeId = null; this.fence = 'ui'; this.head = 0;
    this.gs = null; this.held = null; this.queue = []; this.cur = null;
    this.lastClue = null; this.directive = { text: '', at: 0 }; this.turn = 0;
    this.enabled = process.env.NORI_GAME !== 'off';
    this.stats = { held: 0, released: 0, noop: 0, ourCmds: 0, ourFails: 0 };
    this.fired = new Set();
    this.pic = null; this.picTimer = null; this.picBusy = false;
    // ---- 2026-09-27 新增 ----
    this.lastAgentAt = 0;                 // 上一条代理指令发出时刻（6-B 节拍）
    this.chessArm = null; this.chessBusy = false;   // 7：玩家已落子、等她回应
    this.speechStartedAt = 0; this.speechDoneAt = 0; // 7：语音节拍（由代理的下行帧回调）
    this.cakeTimer = null; this.cakeSentAt = 0;      // 9：蛋糕对决主动驱动
    this.gestureWhy = {};                 // 记录每个 gesture 是怎么拿到的（日志/排查用）
  }
  // 语音节拍回调（nori_proxy.js 在收到 chat 的 audioStarted/audioDone 时调用）
  noteSpeechStart() { this.speechStartedAt = now(); }
  noteSpeechDone() { this.speechDoneAt = now(); }
  // ★ 2026-09-27 修（问题 1 的 12 秒延迟）：原实现只要「见过 audioStarted 但没等到
  //   audioDone」就会一直循环到 TTS_WAIT_CAP(12s) 才罢休 —— 而 audioDone 在一些路径
  //   （无语音/被抑制/块被丢弃）根本不会来，于是每次落子都白等 12 秒。
  //   现在：①上限收到 3 秒；②只有「刚刚才开始说」才值得等，超过 STALE 就认为那条
  //   audioDone 永远不会来了，直接放行。
  async waitSpeechTail() {
    const STALE = 2500;
    if (!this.speechStartedAt) return;                       // 从没见过语音 → 不等
    if (this.speechStartedAt <= this.speechDoneAt) {         // 已经说完了 → 只补一点余量
      const wait = TTS_TAIL_MS - (now() - this.speechDoneAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return;
    }
    if (now() - this.speechStartedAt > STALE) return;        // 迟迟没有 Done → 判定为丢帧
    const t0 = now();
    while (this.speechStartedAt > this.speechDoneAt && now() - t0 < TTS_WAIT_CAP) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  noteChat(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 200) return;
    this.directive = { text: t, at: now() };
    this.log('GAME-DIRECTIVE ' + JSON.stringify(t.slice(0, 40)));
  }
  takeDirective() { const d = this.directive; return (!d.text || now() - d.at > DIRECTIVE_TTL) ? '' : d.text; }
  // 2026-09-27（问题 6-C）：让她在关键节点真的"开口"。
  // ★ 2026-10-02（C3 补）：原注释写「语音仍走原生聊天通道（避免双声）」——
  //   那个前提是「战报注入 ⇒ 唤醒人格 ⇒ 人格回复走 chat 卡带自带语音」。
  //   **C3 已停用战报注入** ⇒ 原生通道不再为游戏台词发声
  //   ⇒ 语音改由 `nori-game-voice.js` 自己出（`SPEAK=true`，走 `/nori-line` → `/nori-tts`）。
  //   它只对**她的台词**发声（会跳过 `ui:true` 的界面播报与 `from:'chat'` 的人格话，避免双声）。
  // ★ 2026-09-30：`opts.ui` = 这不是"她说的台词"，而是**界面播报**（如「提示：「XX」，2 个。」）。
  //   这类内容不该进原版聊天气泡 —— 否则玩家会看到 Nori "念"一句机械串，很怪
  //   （实测反馈：「感觉有点怪」）。游戏界面本身已经显示了提示词，不需要她去念。
  //   ★ 同一条判据现在也被语音侧复用（shim 的 `it.ui === true` 跳过）—— 一处语义、两处消费。
  say(text, emotion, opts) {
    if (!text) return;
    const s = String(text);
    /* ★ 2026-10-02 修（重复气泡）：记下"最近一次真正上屏的**台词**"。
     *   finishTurn() 的兜底分支要用它去重 —— 见那里的注释。
     *   `ui:true` 是**界面播报**（「提示：「XX」，2 个。」），不是她说的台词 ⇒ 不记录。 */
    if (!(opts && opts.ui)) this._saidSig = { t: s.trim(), at: now() };
    try { this.onLine({ text: s.slice(0, 200), emotion: emotion || 'neutral', game: this.cartridgeId, from: 'game', ui: !!(opts && opts.ui) }); } catch (e) {}
  }

  handleClient(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.worldId) this.worldId = obj.worldId;
    /* ★★ 2026-10-06 芯片扫描 · 上行捕捉（用户要求：解析 chip.json 映射表的前置条件）
     *
     * 【为什么必须在这里】
     *   上行 `manifold.chip.scan`（客户端→服务端）是 event 帧，payload 带
     *     { appId, windowType, contentKey, title }   ← 有 contentKey
     *   下行 `manifold.chip.scan.result`（服务端→客户端）只有
     *     { kind, text }                              ← **不含 contentKey**
     *   ⇒ nori_proxy.js 的 `sanitizeChip()` 只看得到下行结果，**无法知道扫的是哪个对象**。
     *     所以必须在上行先把 contentKey 记下来，结果到达时再用它查 `persona/chip.json`。
     *
     * 【键名约定】（用户 2026-10-06 拍板）
     *   key = `appId` + `:` + `contentKey去掉自身命名空间`
     *     browser → `browser:` + `browser.buckonair.****`   （原始 contentKey 为 page:browser.buckonair.****）
     *     nori    → `nori:self`                             （原始 contentKey 就是 nori:self）
     *     files   → `files:file.qfr_exe`                    （原始 contentKey 为 file:file.qfr_exe）
     *     mail    → `mail:mail.advisory`
     *     signal  → `signal:daniel`
     *     terminal→ `terminal:terminal`                     （原始 contentKey 兜底为 app:terminal）
     *
     * 【性质】纯只读：不改帧、不拦截（return false ⇒ 照常上行，服务端行为不变）。
     *   结果同时挂在 `this.lastChipScan`，供代理侧读取。
     */
    if (obj.type === 'event' && obj.channel === 'manifold.chip.scan') {
      try {
        const pl = obj.payload || {};
        const ck = pl.contentKey ? String(pl.contentKey) : '';
        if (ck) {
          const app = pl.appId ? String(pl.appId) : '';
          const rest = ck.replace(/^[a-z][a-z0-9_]*:/, '');   // 去掉 page: / file: / vault: / signal: / app: 等自身命名空间
          const rec = {
            key: app ? (app + ':' + rest) : ck,
            contentKey: ck,
            appId: app,
            windowType: pl.windowType ? String(pl.windowType) : '',
            title: pl.title ? String(pl.title) : '',
            requestId: obj.requestId || null,
            at: now(),
          };
          this.lastChipScan = rec;
          /* 更稳的配对：结果帧若回带 requestId（同一 request→response 对），
             就按 id 精确取，避免"连点两次扫描"时 lastChipScan 被后一次覆盖。
             ⚠ 若服务端不回带 requestId，退回用 this.lastChipScan。 */
          if (rec.requestId) {
            if (!this.chipScanByReq) this.chipScanByReq = new Map();
            this.chipScanByReq.set(rec.requestId, rec);
            if (this.chipScanByReq.size > 50) {              // 防无限增长
              const first = this.chipScanByReq.keys().next().value;
              this.chipScanByReq.delete(first);
            }
          }
          this.log('CHIP-IN scan ' + JSON.stringify(rec));
        }
      } catch (e) {}
      return false;   // 只观测，不放行逻辑，不改变任何行为
    }
    // ★ 2026-09-30（用户澄清：商议用的是 **Ctrl+K 桌面聊天框**，不是游戏内的选词界面）：
    //   那个框走 `sendText()` → dispatch({type:"playerMessage"}) → **chat 卡带**。
    //   原来这里硬性要求 `obj.actor === 'player'`，而 chat 卡带的 schema 只声明了
    //   `actors:["player"]`、客户端发的 dispatch 不一定带 actor 字段 →
    //   一旦 actor 缺失，noteChat 就不会被调用，她的"商量"就永远收不到玩家回话。
    //   这里放宽为：只要 cartridgeId==='chat' 且 cmd.type==='playerMessage' 就认。
    if (obj.type === 'dispatch' && obj.cartridgeId === 'chat' && obj.cmd
      && String(obj.cmd.type || '') === 'playerMessage') {
      const txt = obj.cmd.text || obj.cmd.content || obj.cmd.message || '';
      this.log('CHAT-IN(ctrl+K) ' + JSON.stringify(String(txt).slice(0, 60)) + ' actor=' + (obj.actor || '(缺)'));
      this.noteChat(txt);
      return false;
    }
    if (obj.type !== 'dispatch' || obj.actor !== 'player') return false;
    if (!GAME_CARTRIDGES.has(obj.cartridgeId) || !this.enabled) return false;
    const ctype = obj.cmd && obj.cmd.type;
    if (obj.cartridgeId === 'pictionary') {
      this.cartridgeId = obj.cartridgeId; this.worldId = obj.worldId || this.worldId;
      // 2026-09-27（问题 5）：把玩家每一笔的归一化点集存下来，好把「画」喂给大脑
      // （原先只喂拼音，导致她猜的是答案的谐音词，而不是玩家画的东西）。
      try { if (ctype === 'submitStrokeBatch') this.noteStrokes(obj.cmd); } catch (e) {}
      return false; // 辅助式：不扣，玩家照画
    }
    // 2026-09-27（问题 7）：国际象棋不再扣住玩家的落子。
    // 原实现会把 move 扣在代理里最长 HOLD_MS(8s)，等问完大脑才放行 → 玩家感觉"棋子半天不动"。
    // 现在：立刻放行（前端正常渲染 + 记牌器落地），等新局面到了再由 afterChessState 驱动她思考/落子/说话。
    if (obj.cartridgeId === 'chess' && ctype === 'move') {
      this.worldId = obj.worldId || this.worldId; this.cartridgeId = obj.cartridgeId;
      this.fence = obj.visibilityFenceId || this.fence;
      this.chessArm = { at: now(), fen0: (this.gs && this.gs.fen) || '', from: obj.cmd.from, to: obj.cmd.to };
      this.turnLog = ['他走了 ' + obj.cmd.from + '→' + obj.cmd.to];
      this.log('GAME chess PASS-THROUGH 他的棋不扣了 ' + obj.cmd.from + obj.cmd.to + '（等新局面再驱动她）');
      return false;   // 交回主循环立刻上行
    }
    const TAKE_OVER = { codenames: ['submitClue'], chess: [], cakeduel: ['play'] };
    if ((TAKE_OVER[obj.cartridgeId] || []).indexOf(ctype) < 0) return false;
    this.worldId = obj.worldId || this.worldId; this.cartridgeId = obj.cartridgeId;
    this.fence = obj.visibilityFenceId || this.fence;
    if (this.held) { this.log('GAME drop duplicate held ' + obj.requestId); return true; }
    this.turnLog = [];
    if (ctype === 'submitClue' && obj.cmd.clue) this.turnLog.push('他给Nori的提示词是「' + obj.cmd.clue.word + '（' + obj.cmd.clue.count + ' 个）」');
    if (ctype === 'move') this.turnLog.push('他走了 ' + obj.cmd.from + '→' + obj.cmd.to);
    this.held = { obj, raw: JSON.stringify(obj), ts: now() };
    this.stats.held++;
    this.log('GAME HOLD player ' + obj.cartridgeId + ' cmd=' + JSON.stringify(obj.cmd).slice(0, 90) + ' ver=' + obj.expectedHeadVersion);
    this.kick().catch((e) => this.log('GAME kick err ' + e.message));
    return true;
  }

  handleServer(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'cartridge_mounted_ack') {
      const cid = obj.cartridgeId || this.cartridgeId;
      if (cid && GAME_CARTRIDGES.has(cid)) this.cartridgeId = cid;
      const rts = obj.runtimes || [];
      let rt = rts.find((r) => r && r.cartridgeId && r.cartridgeId === cid)
        || rts.find((r) => r && !r.cartridgeId)
        || rts[0];
      this.log('GAME mount cid=' + cid + ' pick=' + (rt && (rt.cartridgeId || '(no-id)')) + ' from=[' + rts.map((r) => r && (r.cartridgeId || '(no-id)')).join(',') + ']');
      if (rt) {
        if (rt.cartridgeId && GAME_CARTRIDGES.has(rt.cartridgeId)) this.cartridgeId = rt.cartridgeId;
        if (typeof rt.headVersion === 'number') this.head = rt.headVersion;
        if (rt.visibilityFenceId) this.fence = rt.visibilityFenceId;
        const st = rt.state || {};
        if (st.agentSide) this.agentSide = st.agentSide;
        if (st.counterpartSide) this.counterpartSide = st.counterpartSide;
        if (st.gameState) this.gs = st.gameState; else if (st.game) this.gs = st.game;
        if (this.gs && this.gs.agentSide) this.agentSide = this.gs.agentSide;
        this.afterState();
        // ★ 2026-09-27（自愈看门狗）：代理重启 / 前端重连时，如果服务端正停在
        //   「等 agent 给提示词」而那个 agent_turn 事件已经错过（不会再重发），
        //   我们就会永久卡在「Nori 正在想提示」。这里安排一次试探性补发：
        //   等几秒看有没有正常动作，没有就补一个提示词；若被服务端拒（Not your turn）
        //   则标记 clueNoTry 不再打扰。这是「卡住」的最后一道自愈保险。
        if (this.cartridgeId === 'codenames' && !this.clueSentThisTurn && !this.clueNoTry) {
          clearTimeout(this.clueWatch);
          // ★ 重连时先把「静默基准」设成现在 —— 否则 lastAgentAt 为 0，
          //   看门狗会算出「已静默 1790748261 秒」这种荒谬值并必然误触发一次。
          this.lastAgentAt = now();
          this.lastClueAt = now();
          this.clueWatch = setTimeout(() => { try { this.clueWatchdog(); } catch (e) {} }, 6000);
          try { this.clueWatch.unref(); } catch (e) {}
          this.log('GAME clue 看门狗已布防（6s 后检查是否卡在等我方给词）');
        }
      }
      return;
    }
    if (obj.type === 'runtime_transition') {
      const tr = obj.transition || {};
      const cid = obj.cartridgeId || (tr.cmd && tr.cmd.cartridgeId);
      const mine = !cid || cid === this.cartridgeId;
      if (tr.cmd && tr.cmd.type === 'submitClue' && tr.cmd.clue) this.lastClue = tr.cmd.clue;
      for (const p of (tr.patches || [])) {
        if (!p || p.path == null) continue;
        const path = String(p.path);
        if ((/gameState/.test(path) || /(^|\/)game(\/|$)/.test(path)) && mine) {
          const v = p.value;
          if (v && typeof v === 'object' && (v.phase || v.round || v.fen || v.board || v.players)) this.gs = v;
          else if (v && typeof v === 'object' && this.gs && typeof this.gs === 'object') Object.assign(this.gs, v);
          this.afterState();
        }
      }
      if (mine) this.checkEvents(tr);
      // ★ B-220（2026-10-04）：`afterState()`（内含 clueEnsure）在本帧**更早**跑过，
      //   而事件处理可能刚刚重置了 `clueSentThisTurn`（回合结束）⇒ 用**本帧最终状态**再布防一次。
      //   （重复调用无害：只是把 6s 定时器重设一次。）
      if (mine && this.cartridgeId === 'codenames') this.clueEnsure();
      return;
    }
    if (obj.type === 'dispatch_ack') {
      // ★★★ 2026-09-27 修（本轮最大根因）：这里原来无条件
      //     `this.head = obj.headVersion`
      //   但 dispatch_ack 是**所有卡带共用**的下行通道 —— chat / manifold.web 的
      //   ack 也走这里，它们的 headVersion 已经是几百（对应世界总版本）。
      //   结果：我们发游戏指令时带着 chat 的版本号 → 服务端回
      //     "Version mismatch: expected 179, head is 4"
      //   → 她的提示词/走子/猜词被拒 → 假 AI 抢跑（诺莉）、蛋糕对决卡死、
      //     画猜变慢、整体 12 秒延迟。全部都是这一个 bug 的下游。
      //   修法：只认「自己卡带」的 ack。
      const ackCid = String(obj.cartridgeId || '');
      const ackMine = !ackCid || ackCid === this.cartridgeId;
      if (ackMine && typeof obj.headVersion === 'number') this.head = obj.headVersion;
      const cur = this.cur;
      if (cur && obj.requestId === cur.requestId) {
        if (obj.success === false) {
          this.stats.ourFails++;
          this.log('GAME ACK fail kind=' + cur.kind + ' cid=' + ackCid + ' err=' + (obj.error || obj.errorCode || ''));
          this.queue = [];
          // ★★★ 2026-09-27 修（森林寻宝卡死的**直接**原因）：
          //   抢发的 submitClue 一旦被拒，clueSentThisTurn 已经是 true
          //   → onAgentClueTurn 直接 return、maybeSendClue 也 return
          //   → 这一回合永远不会再给词 → 永久卡在「Nori 正在想提示」。
          //   现在：给词被拒就用**服务端刚校准过的 head** 重试一次。
          const ccmd = cur.cmd;
          const isClue = ccmd && String(ccmd.type) === 'submitClue' && ccmd.clue && ccmd.clue.word;
          const wasVersionIssue = /version/i.test(String(obj.error || obj.errorCode || ''));
          // 时机不对（其实该玩家行动）→ 关掉看门狗，别再打扰
          if (isClue && /not your turn/i.test(String(obj.error || ''))) {
            this.clueNoTry = true;
            this.log('GAME clue 看门狗结论：当前不是给词时机（Not your turn）→ 停止试探');
          }
          if (isClue && wasVersionIssue && !this.clueRetried) {
            this.clueRetried = true;
            this.clueSentThisTurn = false;
            const cl = { word: String(ccmd.clue.word), count: Number(ccmd.clue.count) || 1 };
            this.log('GAME clue 抢发被拒 → 用校准后的 ver=' + this.head + ' 重试一次 「' + cl.word + '/' + cl.count + '」');
            setTimeout(() => {
              try { this.sendAgent({ type: 'submitClue', clue: cl }, 'agent'); }
              catch (e) { this.log('GAME clue retry err ' + e.message); }
            }, 150);
          }
          // ★ 2026-09-30：提示词被引擎判非法（"Clue word cannot be on the board" /
          //   "Invalid clue word"）→ 立刻换成**兜底中性词**重发一次。
          //   实测故障：她把自己要猜的目标词（如「实验室」）当成了提示词 → 被拒 →
          //   这一轮的提示词就没了（玩家反馈「nori的提示没应用到游戏中」）。
          const wasClueIllegal = /cannot be on the board|invalid clue word/i.test(String(obj.error || obj.errorCode || ''));
          if (isClue && wasClueIllegal && !this.clueIllegalRetried) {
            this.clueIllegalRetried = true;
            this.clueSentThisTurn = false;
            const fb = this.fallbackClueWord();
            if (this.clueWordProblem(fb)) {
              this.log('GAME clue 被拒（非法词）且兜底词也不可用 → 放弃本轮给词');
            } else {
              this.log('GAME clue 被拒（非法词）「' + String(ccmd.clue.word) + '」→ 换兜底词「' + fb + '/1」重发');
              setTimeout(() => {
                try { this.sendAgent({ type: 'submitClue', clue: { word: fb, count: 1 } }, 'agent'); }
                catch (e) { this.log('GAME clue illegal-retry err ' + e.message); }
              }, 150);
            }
          }
          // ★ 2026-09-30（containment）：endTurn 被版本拒绝 = 我们的"收手"没生效，
          //   回合会继续开着 → 本地对手的连猜链就断不掉。用校准后的 head 重试一次。
          const isEnd = ccmd && String(ccmd.type) === 'endTurn';
          if (isEnd && wasVersionIssue && !this.endRetried) {
            this.endRetried = true;
            this.log('GAME endTurn 被拒（版本）→ 用校准后的 ver=' + this.head + ' 重试一次（掐住本地对手）');
            setTimeout(() => {
              try { this.sendAgent({ type: 'endTurn' }, 'agent'); }
              catch (e) { this.log('GAME endTurn retry err ' + e.message); }
            }, 150);
          }
        }
        this.cur = null;
        if (cur.kind !== 'pic' && !this.isSuddenDeath()) this.next();
      }
      return;
    }
  }

  afterState() {
    // ★ 2026-09-27 修（问题 3/5/6 的帮凶）：原来这里对非 pictionary 卡带直接 return，
    //   于是「画猜 → 象棋」切卡带时 picStop() 永远不会被调用 → 画猜的定时器继续跑，
    //   把 submitGuess 发到象棋/蛋糕对决里（日志铁证：Unknown chess command: submitGuess）。
    if (this.cartridgeId !== 'pictionary' && this.pic && this.pic.active) {
      this.pic.active = false;
      this.picStop();
      this.log('PIC 卡带已切到 ' + this.cartridgeId + ' → 停止猜词');
    }
    if (this.cartridgeId === 'pictionary') {
      const g = this.gs || {}, r = g.round;
      if (g.phase === 'PLAYING' && r && r.status === 'active') {
        const same = this.pic && this.pic.roundId === r.roundId;
        this.pic = { active: true, roundId: r.roundId, word: r.word, pinyin: r.pinyin, drawingId: r.drawingId,
          synonyms: r.synonyms || [], roles: r.roles || {}, startedAtMs: r.startedAtMs || 0,
          guesses: (same && this.pic.guesses) || [], strokes: (same && this.pic.strokes) || [] };
        // ★ 2026-10-04（B-111）：原此处 `this.checkPicMilestone(this.pic)` 已移除 ——
        //   它判的是**题目**（`round.word`/`drawingId`），与官方语义（"**她猜出「水母」**"）不符。
        //   触发点已改到"她猜词落地处"（见 picTick）。
        this.picEnsure();
      } else { if (this.pic) this.pic.active = false; this.picStop(); if (g.phase) this.log('PIC phase=' + g.phase + ' -> 停猜'); }
      return;
    }
    if (this.cartridgeId === 'chess') { this.afterChessState(); return; }
    if (this.cartridgeId === 'cakeduel') { this.cakeEnsure(); }
    if (this.cartridgeId === 'codenames') { this.diagCodenames(); this.sdEnsure(); this.clueEnsure(); }
  }

  // ---------- 森林寻宝：突然死亡阶段的自主猜牌 ----------
  isSuddenDeath() {
    const g = this.gs || {};
    return String(g.phase || '') === 'SUDDEN_DEATH';
  }
  // ★★★ 2026-09-30 新增（修「命令被阶段拒绝」）：发之前再验一次局面。
  //   我们的指令队列是**按当时的快照**排的（她猜 1 张 → 收手 → 给词），
  //   但等轮到某条指令发送时，局面可能已经变了：
  //     · 她猜错 → 回合自动结束（history 末条 endedBy 已置）⇒ 再发 endTurn 会被拒
  //     · 猜中怪兽 → 整局结束 ⇒ endTurn / submitClue 都会被拒
  //     · 令牌耗尽 → 进入突然死亡 ⇒ 不得给词、也不得结束回合
  //   实测（09:19~09:24 两局，共 7 条被拒，全是这个原因）：
  //     "Can only end turns during NORMAL phase" ×2
  //     "Can only submit clues during NORMAL phase" ×2
  //     "Current turn has already ended" ×3
  //   返回 { ok, why }。
  cmdCheck(cmd) {
    if (this.cartridgeId !== 'codenames') return { ok: true };
    const t = String((cmd && cmd.type) || '');
    if (t !== 'endTurn' && t !== 'submitClue') return { ok: true };
    const g = this.gs || {};
    if (g.winner || g.gameEnded) return { ok: false, why: '整局已结束' };
    if (this.isSuddenDeath()) return { ok: false, why: '已进入突然死亡（不得给词/结束回合）' };
    if (String(g.phase || 'NORMAL') !== 'NORMAL') return { ok: false, why: 'phase=' + String(g.phase) };
    if (t === 'endTurn') {
      const h = Array.isArray(g.history) ? g.history : [];
      const last = h.length ? h[h.length - 1] : null;
      if (!last || last.endedBy) return { ok: false, why: '本回合已经结束了' };
      return { ok: true };
    }
    // submitClue：只有轮到「她」给词时才发
    if (g.whoseTurnToGive && String(g.whoseTurnToGive) !== String(this.agentSideOf())) {
      return { ok: false, why: '当前该对方给词（whoseTurnToGive=' + String(g.whoseTurnToGive) + '）' };
    }
    return { ok: true };
  }
  sdEnsure() {
    if (this.sdTimer) return;
    if (!this.isSuddenDeath()) return;
    this.log('SD 突然死亡阶段开始 → 安装她的自主猜牌定时器');
    if (this.clueWatch) { clearTimeout(this.clueWatch); this.clueWatch = null; }
    this.clueNoTry = true;                       // 这个阶段不能再给词
    this.sdAskAt = 0; this.sdAsking = false; this.sdPlan = null; this.sdDrAt = 0;
    this.sdFails = 0;                            // ★ 每轮 SD 重新计数
    this._sdSaySig = null;                       // ★ C7（2026-10-02）：每轮 SD 重置台词去重签名
    this._sdYielded = false;                     // ★ 2026-10-03：每轮 SD 重置"已让位"标志
    // ★★★ 2026-10-01 修 B-026（sudden death 死锁 · 阻断级）
    //   根因：令牌耗尽时服务端「立刻」进 SD，而上一回合排的指令可能还没发完
    //         （玩家给出最后一个 token ⇒ 立刻 SD；我们的 AGENT_STEP_MS 间隔还没到）。
    //   而 onAck 里那行是 `if (cur.kind !== 'pic' && !this.isSuddenDeath()) this.next();`
    //   ⇒ 进 SD 后 next() 不再被调用 ⇒ 残留指令永不消费 ⇒ queue 永久非空
    //   ⇒ sdTick 首行守卫 `this.queue.length` 永久为真 ⇒ 她永不猜牌 ⇒ 死锁。
    //   两次实证：03:31（endTurn 在 SD 之前发完 ⇒ queue 已空）正常出手；
    //             03:43（endTurn 仍堵在 queue 里就进 SD）卡死。
    //   语义：进 SD ⇒ 上一回合的排程作废，直接清掉，别让它们占着守卫。
    if (this.queue.length) { this.log('SD 作废残留指令 ' + this.queue.length + ' 条（进入 sudden death）'); this.queue = []; }
    if (this.held) { this.log('SD 丢弃被扣住的玩家命令（进入 sudden death）'); this.held = null; }
    this.sdTimer = setInterval(() => { try { this.sdTick(); } catch (e) { this.log('SD tick err ' + e.message); } }, SD_TICK_MS);
    try { this.sdTimer.unref(); } catch (e) {}
    setTimeout(() => { try { this.sdTick(); } catch (e) {} }, 1200);
  }
  sdStop() {
    if (this.sdTimer) { clearInterval(this.sdTimer); this.sdTimer = null; this.log('SD 停止自主猜牌'); }
  }
  /* ★★★ 2026-10-01 修 B-028（真根因）：GameSession 是**每次 WebSocket 连接都新建**的
   *   —— nori_proxy.js 的 `server.on('upgrade')` → `wss.handleUpgrade(...)` 回调里
   *   `const gsess = new GameSession({...})`，而且**旧实例从来没有被销毁**。
   *   旧实例的定时器会一直活着，继续出招、继续 say()。
   *
   *   实测（用户 F5 刷新页面之后，12:22）：
   *     · **新实例**：处理新局（`game_start version=90` → … → 105），head 正常，
   *       正常给词「甜」—— 一切正常。
   *     · **旧实例**：`gs` 还停在上一局的 SUDDEN_DEATH、`head` 还停在 88，
   *       ⇒ 每 ~6s 盲发一次 `submitGuess(ver=88)` 打到**已经死掉的 socket**
   *       ⇒ 服务端（或 socket 层）静默丢弃 → B-026 的看门狗清理 → 重试
   *       ⇒ **永久循环，而且每一次都 say() 一句**
   *       ⇒ 用户看到「聊天框那里有几个气泡一直在」（内容就是那些 SD 商量话）。
   *
   *   这也解释了之前所有矛盾：日志里同一时刻既有 `head=105`（新实例）又有
   *   `ver=88`（旧实例）—— **它们是两个对象，各有各的 head 和 gs**。
   *
   *   修法：新连接建立时先销毁旧实例（禁用 + 清掉全部定时器 + 清空队列）。
   *   `enabled=false` 是兜底：三个 tick 的首行守卫都会因此直接 return。 */
  destroy() {
    if (this._dead) return;
    this._dead = true;
    this.enabled = false;                                  // 所有 tick 的首行守卫立刻失效
    for (const k of ['sdTimer', 'cakeTimer', 'picTimer']) {
      if (this[k]) { try { clearInterval(this[k]); } catch (e) {} this[k] = null; }
    }
    if (this.clueWatch) { try { clearTimeout(this.clueWatch); } catch (e) {} this.clueWatch = null; }
    if (this.pic) this.pic.active = false;
    if (this.timer) { try { clearTimeout(this.timer); } catch (e) {} this.timer = null; }
    this.queue = []; this.held = null; this.cur = null; this.sdAsking = false;
    try { this.log('GAME 旧会话已销毁（新连接建立）—— 定时器/队列/在途动作全部清空'); } catch (e) {}
  }
  sdTick() {
    if (this.cartridgeId !== 'codenames' || !this.enabled) return;
    const g = this.gs;
    if (!g || !Array.isArray(g.cells)) return;
    if (String(g.phase || '') !== 'SUDDEN_DEATH') { this.sdStop(); return; }
    // ★★ 2026-10-01（B-026 第二道保险 · 持续兜底）
    //   SD 阶段 next() 不再被 onAck 调用，所以三种"在途"状态都可能永久卡住守卫。
    //   ① 陈旧 in-flight：ack 丢帧 ⇒ this.cur 永久非 null（cakeduel 早就踩过这个坑，
    //      它的 cakeEnsure 里有同样的 6s 看门狗；codenames 一直没同步 —— 现在补上）
    //   ② 残留 queue：sdEnsure 已清过一次，这里给漏网的再加一层超时保护
    //   ③ held：SD 不接受玩家给词，万一扣着一条就永远发不出去
    //   阈值 6s 与 cakeduel 一致：SD 出手后 6s 内这些本该都清空了。
    if (this.cur && now() - (this.curAt || 0) > 6000) {
      this.log('SD 陈旧 in-flight（kind=' + (this.cur.kind || '?') + ' 超 6s）→ 强制清理，避免卡死');
      this.cur = null;
    }
    if (this.queue.length && now() - (this.curAt || 0) > 6000) {
      this.log('SD 清理陈旧指令 ' + this.queue.length + ' 条（超 6s 未被消费）');
      this.queue = [];
    }
    if (this.held && now() - (this.held.ts || 0) > 6000) {
      this.log('SD 清理被扣住的玩家命令（超 6s）');
      this.held = null;
    }
    if (this.held || this.cur || this.queue.length) return;   // 有在途动作
    if (this.sdAsking) return;                                // 正在问大脑

    // ★★★ 2026-10-03（用户实测：她的宝箱找完后她还在猜，进了 SD 直接踩雷判负）
    //   规则：某方宝箱全找出 ⇒ 该方「不能再翻」，应引导另一方去找。
    //   ⇒ 她的份额找齐 ⇒ 停止自主猜牌，改为说一句引导他的话（每轮 SD 只说一次）。
    {
      const rem = this.codexRemaining();
      if (rem && rem.myLeft === 0) {
        if (!this._sdYielded) {
          this._sdYielded = true;
          this.log('SD 她自己的宝箱已找齐（她剩 0 / 他剩 ' + rem.hisLeft + '）⇒ 停止她的自主猜牌，改为引导他去找');
          if (rem.hisLeft > 0) this.say('我这边的宝箱都找齐啦，剩下的就靠你咯。', 'happy');
        }
        this.sdStop();
        return;
      }
    }

    // ── 阶段一：先跟他商量（右下角气泡说出想法 + 开一个回话窗口）─────────────
    if (!this.sdAskAt) {
      if (now() - (this.sdSentAt || 0) < SD_STEP_MS) return;  // 两轮之间的节流
      const spec = this.buildCodenamesSdSpec();
      if (!spec || !spec.legal.length) { this.log('SD 没有可猜的格子'); return; }
      this.sdAsking = true;
      this.sdDrAt = this.directive.at;                        // 记下商量开始时的聊天游标
      this.askBrain(spec, this.takeDirective()).then((d) => {
        this.sdAsking = false;
        this.sdPlan = spec.actionsFromBrain(d);
        const line = (d && d.line) || '唔……我拿不准，你说呢？';
        // ★ C7（2026-10-02）：同一句台词在本轮 SD 内只说一次。
        //   根因（T6 实测）：命令失败时（如 `GAME ACK fail err=Cartridge is not mounted`）
        //   局面没有推进 ⇒ sdTick 下一轮又走商量阶段 ⇒ 又问大脑 ⇒ 答案往往相同
        //   ⇒ 再 say 一次 ⇒ 右下角气泡里累积 N 条一模一样的句子（与 B-026 同族）。
        //   去重键 = 台词文本；每轮 SD 由 sdEnsure() 重置 ⇒ 新一局照常说。
        const saySig = String(line).trim();
        if (saySig !== this._sdSaySig) {
          this._sdSaySig = saySig;
          this.say(line, (d && d.emotion) || 'doubtful');      // ← 右下角气泡
        } else {
          this.log('SD 台词与上一条相同，跳过上屏：' + JSON.stringify(saySig.slice(0, 30)));
        }
        this.sdAskAt = now();
        this.log('SD 她跟他商量：' + JSON.stringify(String(line).slice(0, 46))
          + ' 她倾向=' + JSON.stringify((this.sdPlan[0] || {}).cell));
      }).catch((e) => { this.sdAsking = false; this.log('SD ask err ' + e.message); this.sdAskAt = now(); });
      return;
    }

    // ── 阶段二：回话窗口结束 → 出手 ────────────────────────────────────────
    if (now() - this.sdAskAt < SD_CONSULT_MS) return;          // 还在等他回话
    const heSaid = this.directive.at > (this.sdDrAt || 0);     // 窗口内他说话了？
    const dr = heSaid ? this.takeDirective() : '';
    const plan = this.sdPlan;
    this.sdAskAt = 0;
    this.log('SD 回话窗口结束：他说了=' + (heSaid ? JSON.stringify(String(dr).slice(0, 30)) : '（没说话）'));
    // 他没说话 → 照她刚才的倾向出手（不重复问大脑，省一次调用）
    if (!heSaid && plan && plan.length) { this.sdGuess(plan); return; }
    // 他说了话 → 带着他的话重新决策
    const spec = this.buildCodenamesSdSpec();
    if (!spec || !spec.legal.length) return;
    this.sdAsking = true;
    this.askBrain(spec, dr).then((d) => {
      this.sdAsking = false;
      if (d && d.line) {
        // ★ C7：同一个去重签名（与商量阶段共用）—— 大脑重复给同一句时不再叠气泡
        const sig2 = String(d.line).trim();
        if (sig2 === this._sdSaySig) this.log('SD 台词（重新决策）与上一条相同，跳过上屏');
        else { this._sdSaySig = sig2; this.say(d.line, d.emotion || 'neutral'); }
      }
      const cmds = spec.actionsFromBrain(d);
      this.log('SD 听了他的话重新决策 → ' + JSON.stringify((cmds[0] || {}).cell));
      if (cmds.length) this.sdGuess(cmds);
    }).catch((e) => { this.sdAsking = false; this.log('SD decide err ' + e.message); });
  }
  sdGuess(cmds) {
    if (!cmds || !cmds.length) return;
    // ★ 安全阀（2026-10-03）：她【自己的】宝箱已找齐 ⇒ 一律不出手
    //   （否则会去翻一张**对自己无意义**的牌，踩到浆果/怪兽则整局直接判负 —— 用户实测踩过）
    {
      const rem = this.codexRemaining();
      if (rem && rem.myLeft === 0) {
        this.log('SD 她自己的宝箱已找齐 ⇒ 放弃出手（防踩雷判负）');
        this.sdStop();
        return;
      }
    }
    // ★★ 2026-10-01（防"无限重试"，见 SD_MAX_FAILS 注释）
    this.sdFails = (this.sdFails || 0) + 1;
    if (this.sdFails > SD_MAX_FAILS) {
      this.log('SD 连续 ' + this.sdFails + ' 次出手无进展 → 放弃并停表（避免无限重试/气泡堆积）');
      this.sdStop();
      return;
    }
    this.sdSentAt = now();
    this.sdPlan = null;
    this.log('SD 突然死亡：她出手 ' + JSON.stringify(cmds[0]) + '（第 ' + this.sdFails + ' 次）');
    this.queue = cmds;
    this.next();
  }
  // 突然死亡阶段的「局面」—— **只给公开信息，绝不把 key 给她**。
  //   她看得到：还没翻开的词、之前双方的提示词、他刚说的话。
  //   她看不到：哪张是对方的词、哪张是浆果、哪张是怪兽。
  //   ⇒ 这才是官方设计的"盲猜"，每一步都是在赌（可能赢、也可能踩雷直接输）。
  /* ★★★ 2026-10-03（用户实测修正 + B-027/B-031 根因）——**谁还能翻**的正确口径
   *   规则（用户原话）：「进 SD 后双方不能给提示；**我方宝箱>0 ⇒ 我能翻；她的宝箱>0 ⇒ 她能翻**。
   *   哪一方宝箱全部找出 ⇒ **那一方就不能继续翻卡**，需要引导没找齐的一方去找；
   *   双方都找齐即胜利；SD 期间任一方踩中浆果/怪兽，游戏立即结束。」
   *
   *   ⇒ 判据 = **自己的**「还要找」> 0（`key[自己][i]==='AGENT' && !cells[i].solvedBy` 的个数）。
   *     这与界面文案一致：`youToGuess = o[t==="A"?"B":"A"]`、`noriToGuess = o[t]`（t=counterpartSide）
   *     ⇒ 「你还要找」= 你的剩余、 「Nori 还要找」= 她的剩余（memory/2026-10-01:466-472 已定案）。
   *   ⚠ 服务端 exe 用的是**对方**那个数（用反了）——这是 B-027/B-031 的根因，
   *     但它只影响"服务端接不接受"，**不改变"她该不该出手"** ⇒ 本守卫仍按正确口径做。
   *   实测对照：`剩余宝箱 2+3`（都>0）零拒绝；`2+0`/`0+1`（某侧归零）必僵死。
   */
  /* ★★★ 语义（2026-10-03 用户定案 · ★ 极易搞反，务必照此理解）
   *   `key[她的侧].AGENT` 标的是【玩家要找的宝箱】；`key[玩家侧].AGENT` 标的是【她要找的宝箱】。
   *   依据（用户原话）：「**你的地图**标出 Nori 要根据你的提示寻找的宝箱；
   *                      **她的地图**标出**你要找的**宝箱。」
   *   ⇒ 由此得到两条【互不相同】的判据（用户原话，就是这两条）：
   *     ·「**她给不给提示**」由【**玩家的**剩余宝箱】决定 = 未翻开的 `key[她]` 的 AGENT 数 = `hisLeft`
   *     ·「**她猜不猜**」（SD 阶段）由【**她自己的**剩余宝箱】决定 = 未翻开的 `key[玩家]` 的 AGENT 数 = `myLeft`
   *   ⚠ **千万不要把 `key[自己]` 当成"自己的宝箱"** —— 这里恰好是反的。
   *   实测交叉验证：她给词时的 `CODEX-CLUESPEC`「她的词=3 个」↔ UI「剩余宝箱 3+0」的第一个数 3 ⇒ 吻合。
   */
  codexRemaining() {
    const g = this.gs || {};
    if (!g.key || !Array.isArray(g.board)) return null;
    const me = this.agentSideOf(), foe = me === 'A' ? 'B' : 'A';
    let hisLeft = 0, myLeft = 0;
    for (let i = 0; i < g.board.length; i++) {
      if (g.cells && g.cells[i] && g.cells[i].solvedBy) continue;
      if (g.key[me] && g.key[me][i] === 'AGENT') hisLeft++;   // key[她] = 【他】要找的
      if (g.key[foe] && g.key[foe][i] === 'AGENT') myLeft++;  // key[他] = 【她】要找的
    }
    return { hisLeft, myLeft };
  }
  buildCodenamesSdSpec() {
    const g = this.gs || {};
    if (!g.board || !g.cells) return null;
    const side = this.agentSideOf();
    // ★★ 守卫：她【自己的】宝箱已找齐 ⇒ 按规则她「不能再翻」⇒ 不给她猜的选项（防踩雷直接判负）
    const rem = this.codexRemaining();
    if (rem && rem.myLeft === 0) {
      this.log('SD 她自己的宝箱已找齐（她剩 0 / 他剩 ' + rem.hisLeft + '）⇒ 不给她猜的选项');
      return null;
    }
    const open = [];
    for (let i = 0; i < g.board.length; i++) {
      const c = g.cells[i] || {};
      if (c.solvedBy) continue;
      open.push({ id: 'cell:' + i, desc: (g.board[i] && (g.board[i].text || g.board[i].id)) || ('第' + i + '格') });
    }
    if (!open.length) return null;
    const clues = (g.history || []).filter((h) => h && h.clue && h.clue.word).slice(-8)
      .map((h) => (h.clueGiver === side ? '你' : '他') + '给过「' + h.clue.word + '（' + h.clue.count + ' 个）」').join('；');
    const observation = [
      '森林寻宝进入【突然死亡】：双方都**不能再给提示词**，改成各自直接去猜（照之前给过的提示词推测）。',
      '规则：猜中一张宝箱 → **你们团队**得分；**踩到浆果或怪兽 → 你们整局直接输**。每一步都是在赌。',
      '★ 谁还能猜：**你这边还剩宝箱才轮到你翻**；你的份额找齐后就只能**说话引导他**去找他剩下的。',
      (rem ? ('★ 现在：**你（Nori）这侧还剩 ' + rem.myLeft + ' 个**宝箱；他那边还剩 ' + rem.hisLeft + ' 个。') : ''),
      '还没翻开的词（' + open.length + ' 个）：' + open.map((o) => o.desc).join('、') + '。',
      clues ? ('之前给过的提示词：' + clues + '。') : '',
      '**你并不知道哪张能猜中** —— 只能凭提示词和直觉去赌，不许装作知道答案。',
      '【先说话】用一句/两句话跟他说你的想法（你倾向哪个、为什么、让他拿主意），可以犹豫、可以紧张。',
      '【再行动】然后从下面的合法动作里挑一个格子。他要是回你了，你会看到他的话。',
    ].filter(Boolean).join('\n');
    const ids = new Set(open.map((o) => o.id));
    return { game: 'codenames', observation, legal: open, maxActions: 1, actionsFromBrain: (d) => {
      const pick = (d.actions || []).find((id) => ids.has(String(id)));
      if (!pick) return [];
      return [{ type: 'submitGuess', cell: Number(String(pick).slice(5)) }];
    } };
  }

  // ★ 诊断（2026-09-30，排查「提示卡与进度错位」）：把 codenames 的 history 演化打出来。
  //   每条 = clueGiver:word/count/已猜次数。前端弹卡片是由「最后一条带 clue 的条目」驱动的，
  //   所以只要看这个序列就能确认前端应该在什么时候弹、弹完有没有变化。
  diagCodenames() {
    // ★ 2026-09-30（用户怀疑「本地版把两份地图简化成一份」）：把两份 key 的指纹打出来。
    //   如果 A-AGENT 与 B-AGENT 完全相同 ⇒ 本地版确实只有一份图（用户猜的和他给题用的是同一批词）；
    //   如果不同 ⇒ 结构上确实是两份图，那"提示词对不上"就得从别处找原因。
    const g0 = this.gs || {};
    if (g0.key) {
      const ka = g0.key.A || [], kb = g0.key.B || [];
      const pos = (k, role) => { const o = []; for (let i = 0; i < 25; i++) if (k[i] === role) o.push(i); return o; };
      const aA = pos(ka, 'AGENT'), bA = pos(kb, 'AGENT');
      const aX = pos(ka, 'ASSASSIN'), bX = pos(kb, 'ASSASSIN');
      const sig = aA.join(',') + '|' + bA.join(',') + '|' + aX.join(',') + '|' + bX.join(',');
      // ★ 2026-09-30 修：原来用 _codexKeyLogged「只打一次」，导致新开一局时打出来的还是上一局的 key。
      //   改成「key 指纹变了就重打」——每局必有一行，且换局能看出来。
      if (sig !== this._codexKeySig) {
        this._codexKeySig = sig;
        const same = aA.join(',') === bA.join(',');
        this.log('CODEX-KEY A-AGENT=[' + aA.join(',') + '] B-AGENT=[' + bA.join(',') + ']'
          + ' A-怪兽=[' + aX.join(',') + '] B-怪兽=[' + bX.join(',') + ']'
          + ' 两份图相同=' + same);
        this.log('CODEX-KEY 阵营: agentSide=' + this.agentSideOf() + ' （A=玩家 B=Nori）');
      }
    }
    const h = (this.gs && Array.isArray(this.gs.history)) ? this.gs.history : null;
    if (!h || !h.length) return;
    const sig = h.map((x) => {
      if (!x) return '?';
      const g = ((x.guesses || []).length);
      if (x.clue && x.clue.word) return String(x.clueGiver) + ':' + x.clue.word + '/' + String(x.clue.count) + '/g' + g;
      return 'NO-CLUE/g' + g;
    }).join('  |  ');
    if (sig === this._codexSig) return;
    this._codexSig = sig;
    this.log('CODEX-HIST n=' + h.length + ' :: ' + sig);
  }

  // ---------- 问题 7：玩家落子后驱动她 ----------
  afterChessState() {
    const arm = this.chessArm;
    if (!arm || this.chessBusy) return;
    const g = this.gs || {};
    const fen = g.fen;
    const aged = now() - arm.at;
    const changed = !!fen && fen !== arm.fen0;      // 新局面（含玩家那步）到了
    if (!changed && aged < 1500) return;            // ★ 4000 → 1500（问题 1 延迟的一部分）
    // ★ 2026-09-27（问题 4）：她原来 1 秒内就回应，像脚本。这里保证「他落子 → 她出手」
    //   至少隔 CHESS_THINK_MS，把这段时间留给她"想棋"。
    const thinkLeft = CHESS_THINK_MS - aged;
    this.chessArm = null;
    this.chessBusy = true;
    const go = () => this.kickChess()
      .catch((e) => this.log('GAME chess kick err ' + e.message))
      .then(() => { this.chessBusy = false; });
    if (thinkLeft > 0) setTimeout(go, thinkLeft); else go();
  }
  async kickChess() {
    const spec = this.buildChess(null);             // 用当前（已含玩家那步的）局面，不再重复应用
    if (!spec || !spec.legal.length) { this.log('GAME chess 无合法步 → 跳过'); return; }
    const directive = this.takeDirective();
    let d = null;
    try { d = await this.askBrain(spec, directive); } catch (e) { this.log('GAME chess brain err ' + e.message); }
    let cmds = d ? spec.actionsFromBrain(d) : [];
    if (!cmds.length) {
      // ★ 2026-09-27：本地假 AI 已被关掉（Nori.Web.noai.exe），所以我们**必须**出手，
      //   否则这盘棋就永远停在她的回合。大脑失败时退化为「挑第一个合法走法」。
      const fb0 = pickFallback(spec);
      // ★★★ B-109（2026-10-03）：`pickFallback` 只按 id 挑第一个 ⇒ 她兜底时常送子。
      //   这里改用 `pickChessFallback`（一层评估：将杀/将军/吃子/升变 − 会被吃回）。
      //   仅在「新挑法确实在本 spec 的合法集里」时才替换，任何异常都退回原兜底。
      let fb = fb0;
      try {
        const smart = pickChessFallback(this.mkChess(spec.fen || (this.gs && this.gs.fen)));
        if (smart && spec.legal.some((l) => l.id === smart)) {
          if (smart !== fb0) this.log('GAME chess B-109 兜底换用评估挑法 ' + fb0 + ' → ' + smart);
          fb = smart;
        }
      } catch (e) { this.log('GAME chess B-109 兜底评估失败（退回原挑法） ' + e.message); }
      this.log('GAME chess 大脑无决策/无合法步 → 兜底走 ' + fb);
      if (!fb) return;
      cmds = spec.actionsFromBrain({ actions: [fb] });
      if (!cmds.length) return;
      d = d || { line: '', emotion: 'neutral' };
    }
    this.lastLine = (d && d.line) || ''; this.lastEmo = (d && d.emotion) || 'neutral';
    const mv = cmds[0];
    this.turnLog.push('Nori（她）走了 ' + mv.from + '→' + mv.to);
    // 等她把上一句说完再落子（问题 7：她的下一子不要离上一句 TTS 太远）
    await this.waitSpeechTail();
    // 竞态保护：等待期间局面若已变（服务端假 AI 抢先出手 / 玩家又走了一步），
    // 这条决策就作废，避免发出去被 version_mismatch 拒掉。
    if (this.gs && this.gs.fen && spec.fen && this.gs.fen !== spec.fen) {
      this.log('GAME chess 局面已变（' + spec.fen.slice(0, 24) + ' → ' + String(this.gs.fen).slice(0, 24) + '），放弃这次决策');
      return;
    }
    // ★ 2026-09-27（问题 4）：先让她"开口"再落子 —— 她说的话直接进 /nori-line 气泡，
    //   所以即使聊天通道没接上，你也看得到她在评论这盘棋。
    if (this.lastLine) this.say(this.lastLine, this.lastEmo);
    this.queue = cmds;
    this.log('GAME chess DRIVE 她的回应 ' + mv.from + '→' + mv.to + ' line=' + JSON.stringify(String(this.lastLine).slice(0, 40)));
    this.next();
  }

  /* ★ B-103（2026-10-03）：和棋应答策略 —— **子力落后就接受，均势或领先则拒绝**。
   *   只用 chess.js 的棋盘算子力，不依赖任何服务端字段。
   *   ★ 算不出来时**返回 true（接受）** —— 这里的原则是"不卡住优先"：
   *     宁可接受一个和棋，也不要因为她不回应把整局吊在半路。 */
  shouldAcceptDraw() {
    try {
      const c = this.mkChess(this.gs && this.gs.fen);
      if (!c) return true;
      const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
      const pSide = String(this.chessPlayerSide || 'white').toLowerCase();
      const myColor = pSide === 'white' ? 'b' : 'w';      // 我方（agent）执的颜色
      let mine = 0, theirs = 0;
      for (const row of c.board()) {
        for (const sq of row) {
          if (!sq) continue;
          const v = VAL[sq.type] || 0;
          if (sq.color === myColor) mine += v; else theirs += v;
        }
      }
      return mine < theirs;
    } catch (e) { return true; }
  }

  // ---------- 问题 9：蛋糕对决的主动驱动 ----------
  cakeEnsure() {
    if (this.cakeTimer) return;
    this.cakeTimer = setInterval(() => { try { this.cakeTick(); } catch (e) { this.log('CAKE tick err ' + e.message); } }, CAKE_TICK_MS);
    try { this.cakeTimer.unref(); } catch (e) {}
    setTimeout(() => { try { this.cakeTick(); } catch (e) {} }, 900);
  }
  // 照抄引擎的「谁该行动」：attack→attackerIndex；block→对手；review→attackerIndex；pick→pick 相位指定者
  actingIndexCake(g) {
    const atk = typeof g.attackerIndex === 'number' ? g.attackerIndex : 0;
    const ph = String(g.phase || '');
    if (ph === 'attack') return atk;
    if (ph === 'block') return 1 - atk;
    if (ph === 'review') return atk;
    if (ph === 'pick') {
      const e = g.pickPhaseEffects;
      return (Array.isArray(e) && e[0] && typeof e[0].player === 'number') ? e[0].player : -1;
    }
    return -1;
  }
  cakeTick() {
    if (this.cartridgeId !== 'cakeduel' || !this.enabled) return;
    const g = this.gs;
    if (!g || g.gameEnded || !g.phase || !Array.isArray(g.players)) return;
    // ★ 2026-09-27（问题 5 卡死）：万一某条指令的 ack 永远没回来（丢帧/被丢弃），
    //   this.cur 会永远非 null → 下面的 return 永久成立 → 她再也不动。
    //   这里加个看门狗：in-flight 超过 6 秒就判定为丢帧，强制清掉。
    if (this.cur && now() - (this.curAt || 0) > 6000) {
      this.log('CAKE 陈旧 in-flight（kind=' + (this.cur.kind || '?') + ' 超 6s）→ 强制清理，避免卡死');
      this.cur = null;
    }
    if (this.queue.length && now() - (this.curAt || 0) > 6000) { this.queue = []; }
    if (this.held || this.cur || this.queue.length) return;    // 还有未完成的动作
    // ★★★ 节奏对齐（2026-10-03）：刚发生过「质疑揭示」⇒ 等前端动画播完再让她动。
    //   前端动画 ≈ 1000ms(揭示前停顿) + 3000ms(揭示保持)，而 CD 节拍只有 1400ms
    //   ⇒ 不等就会"抢跑"（exe 提前推进，可能打断前端正在播的揭示动画）。
    //   ★ 只在质疑后的那个窗口生效；平时的出手节拍不受影响。
    if (this.cakeHoldUntil && now() < this.cakeHoldUntil) return;
    // ★ 2026-09-27（问题 4/5）：她原来几乎瞬发。这里保证两招之间至少 CAKE_THINK_MS。
    if (now() - this.cakeSentAt < CAKE_THINK_MS) return;
    if (this.actingIndexCake(g) !== AGENT_INDEX) return;       // 不该她动
    const spec = this.buildCakeduel(null, true);               // direct：直接从当前相位出招
    if (!spec || !spec.legal.length) return;
    const sig = (g.phase || '') + ':' + (g.attackerIndex != null ? g.attackerIndex : '?');
    const directive = this.takeDirective();
    this.cakeSentAt = now();
    // ★ 2026-09-27：原来这里用 .then(...).catch(...) —— 一旦 askBrain 抛异常，
    //   **整个 .then 会被跳过**，兜底逻辑根本没机会跑 → 她不出手 → 卡死。
    //   （这是端到端测试抓出来的）改成 await + try/catch，保证任何失败路径都能兜底。
    (async () => {
      let d = null;
      try { d = await this.askBrain(spec, directive); }
      catch (e) { this.log('CAKE brain err ' + e.message + ' → 走兜底'); }
      // 竞态保护：问她期间局面若已推进，这条决策作废
      const g2 = this.gs || {};
      if ((g2.phase || '') + ':' + (g2.attackerIndex != null ? g2.attackerIndex : '?') !== sig) {
        this.log('CAKE 局面已变（' + sig + '），放弃这次决策');
        return;
      }
      let cmds = d ? spec.actionsFromBrain(d) : [];
      if (!cmds.length) {
        // ★ 假 AI 已关（Nori.Web.noai.exe），必须出手，否则整局卡死 → 退化为第一个合法动作
        const fb = pickFallback(spec);
        if (!fb) { this.log('CAKE 无兜底动作可用（legal 为空）'); return; }
        this.log('CAKE 兜底出招 ' + fb + '（大脑=' + (d ? '有输出但无合法动作' : '失败') + '）');
        cmds = spec.actionsFromBrain({ actions: [fb] });
        if (!cmds.length) { this.log('CAKE 兜底映射失败 ' + fb); return; }
        d = d || { line: '', emotion: 'neutral' };
      }
      this.lastLine = (d && d.line) || ''; this.lastEmo = (d && d.emotion) || 'neutral';
      this.turnLog.push('Nori（她）' + JSON.stringify(cmds[0]).slice(0, 70));
      this.queue = cmds;
      this.log('CAKE DRIVE 主动出手（phase=' + g.phase + '） ' + JSON.stringify(cmds[0]).slice(0, 80));
      this.next();
    })();
  }

  // ---------- 问题 5：笔画 → 字符画 / PNG ----------
  noteStrokes(cmd) {
    const b = cmd && cmd.batch;
    if (!Array.isArray(b)) return;
    if (!this.pic) this.pic = { active: true, strokes: [] };
    if (!this.pic.strokes) this.pic.strokes = [];
    for (const st of b) {
      if (st && Array.isArray(st.points) && st.points.length) {
        this.pic.strokes.push({ points: st.points, color: st.color, width: st.width });
      }
    }
    while (this.pic.strokes.length > 600) this.pic.strokes.shift();
    // ★★ B-105（2026-10-03）：两个作用 ——
    //   ① `lastStrokeAt`：给 `picTick` 做去抖判断（还在画就别看）
    //   ② `picKick()`：**笔画驱动** —— 玩家停笔后就立刻猜一次，不必等 2600ms 轮询
    //      （原来她的反应被轮询节奏卡住；现在最快 700ms 就能开口）
    this.pic.lastStrokeAt = now();
    this.picKick();
  }
  /* ★ B-105：可重入的「停笔去抖」定时器 —— 每来一批笔画就重置；停笔满 PIC_DEBOUNCE_MS 触发一次猜。 */
  picKick() {
    if (this.picKickTimer) { clearTimeout(this.picKickTimer); this.picKickTimer = null; }
    this.picKickTimer = setTimeout(() => {
      this.picKickTimer = null;
      this.picTick().catch(() => {});
    }, PIC_DEBOUNCE_MS);
    try { if (this.picKickTimer.unref) this.picKickTimer.unref(); } catch (e) {}
  }
  // ★ 2026-09-27（真·看图）：把玩家当前画的东西渲染成 PNG（base64 data URI）。
  //   已实测 deepseek-flash 支持多模态，所以这是**真正让模型看图**，
  //   不再依赖字符画近似 —— 模型看到的是和玩家屏幕上一样的线条。
  strokePng() {
    const p = this.pic;
    if (!p || !p.strokes || !p.strokes.length) return null;
    const S = PIC_PNG_SIZE;
    // ★ B-102（2026-10-03）：底色 = **真实纸色**（前端 `os.default.paper = #EDE3CB`）。
    //   原来填纯白 255 ⇒ 而前端「橡皮」是**画纸色**（`O === 'eraser' ? b.paper : D`）
    //   ⇒ 白底上画米黄 = 留痕迹；改为纸色后才真正等于"擦除"。
    const rgb = Buffer.alloc(S * S * 3);
    for (let i = 0; i < rgb.length; i += 3) { rgb[i] = 0xED; rgb[i + 1] = 0xE3; rgb[i + 2] = 0xCB; }
    // ★ B-102：如实渲染笔画颜色。原来 put 里硬编码 rgb(20,20,20)
    //   ⇒ 六种笔色（graphite/indigo/brick/ochre/forest/wine）全变深灰、橡皮变黑线。
    //   前端 color 形态为 `#rrggbb`（兼容 `#rgb` / `rgb()`）；兜底 = 前端默认笔色 graphite。
    const parseColor = (c) => {
      if (typeof c === 'string') {
        const h = c.trim();
        let m = /^#([0-9a-f]{6})$/i.exec(h);
        if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
        m = /^#([0-9a-f]{3})$/i.exec(h);
        if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
        m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(h);
        if (m) return [Number(m[1]) & 255, Number(m[2]) & 255, Number(m[3]) & 255];
      }
      return [0x36, 0x36, 0x36];
    };
    const put = (x, y, col) => {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      const o = (y * S + x) * 3; rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2];
    };
    const brush = (x, y, r, col) => {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) put(x + dx, y + dy, col);
      }
    };
    let ink = 0;
    for (const s of p.strokes) {
      const col = parseColor(s && s.color);
      const wRaw = Number(s.width) || 4;
      const r = Math.max(1, Math.min(9, Math.round((wRaw / 400) * S * 0.5 + 1)));
      const pts = (s.points || []).map((pt) => [
        Math.round((Number(pt.x) || 0) * (S - 1)),
        Math.round((Number(pt.y) || 0) * (S - 1)),
      ]);
      if (!pts.length) continue;
      if (pts.length === 1) { brush(pts[0][0], pts[0][1], r, col); ink++; continue; }
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let k = 0; k <= steps; k++) {
          brush(Math.round(x0 + ((x1 - x0) * k) / steps), Math.round(y0 + ((y1 - y0) * k) / steps), r, col);
          ink++;
        }
      }
    }
    if (!ink) return null;
    try {
      return 'data:image/png;base64,' + encodePngRgb(rgb, S, S).toString('base64');
    } catch (e) { this.log('PIC png encode err ' + e.message); return null; }
  }
  strokeAscii() {
    const p = this.pic;
    if (!p || !p.strokes || !p.strokes.length) return '';
    const W = PIC_ASCII_W, H = PIC_ASCII_H;
    // ★ 2026-09-27（问题 3）：改成**带密度**的渲染 —— 只用 '#' 时线条太稀疏，
    //   模型看不出形状。这里把每格按「有多少个采样点落进来」分五档，
    //   并且把笔画线段**插值补齐**（原来只打采样点，细线会断成虚线）。
    const grid = new Array(W * H).fill(0);
    const put = (x, y) => { if (x >= 0 && x < W && y >= 0 && y < H) grid[y * W + x]++; };
    const toPx = (pt) => [Math.round((Number(pt.x) || 0) * (W - 1)), Math.round((Number(pt.y) || 0) * (H - 1))];
    let ink = 0;
    for (const s of p.strokes) {
      const pts = (s.points || []).map(toPx);
      if (!pts.length) continue;
      if (pts.length === 1) { put(pts[0][0], pts[0][1]); ink++; continue; }
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let k = 0; k <= steps; k++) {
          put(Math.round(x0 + ((x1 - x0) * k) / steps), Math.round(y0 + ((y1 - y0) * k) / steps));
          ink++;
        }
      }
    }
    if (!ink) return '';
    const RAMP = ' .:-=+*#%@';
    const out = [];
    for (let y = 0; y < H; y++) {
      let row = '';
      for (let x = 0; x < W; x++) {
        const n = grid[y * W + x];
        row += n === 0 ? ' ' : RAMP[Math.min(RAMP.length - 1, 1 + Math.min(n, 7))];
      }
      out.push(row);
    }
    return out.join('\n');
  }

  // ★ 2026-09-27：cakeduel 的事件是**嵌套**的 —— 形如
  //     {"type":"engine","event":{"type":"game_started", ...}}
  //   象棋/画猜/森林寻宝则是**平铺**的（game_start / game_over / ...）。
  //   原来的 checkEvents 只看外层 e.type，于是 cakeduel 的 game_started / bout_ended
  //   全部被当成 "engine" 忽略掉 → 蛋糕对决的开局/换轮事件都没被识别。
  //   这里统一拆一层：是 engine 包装就取里面的 event。
  flatEvent(e) {
    if (e && e.type === 'engine' && e.event && typeof e.event === 'object' && e.event.type) return e.event;
    return e;
  }
  checkEvents(tr) {
    // ★★★ B-222（2026-10-04）：**先扫一遍**本帧有没有「回合结束」，**先把"本回合已给词"作废**。
    //   为什么必须前置：事件数组里 `agent_turn` 常常排在 `turn_end` **前面**
    //   （实测同一帧 index 0 = agent_turn、index 1 = turn_end），而本方法是**按顺序**处理的
    //   ⇒ 若等处理到 `turn_end` 才清标志，**排在它前面的 `agent_turn` 已经被旧的 true 挡掉了**
    //   ⇒ 她的提示词只能靠看门狗 6 秒后补出来（实测：每回合都晚 ~6s，正常路径形同废弃）。
    //   语义：**「回合结束」= 新回合开始** ⇒ 必须在处理本帧任何事件之前就生效。
    if (this.cartridgeId === 'codenames') {
      for (const raw of (tr.events || [])) {
        const e0 = this.flatEvent(raw);
        if (!e0 || !e0.type) continue;
        if (e0.type === 'turn_end'
          || (e0.type === 'guess' && (e0.result === 'bystander' || e0.result === 'assassin'))) {
          this.clueSentThisTurn = false;
          break;
        }
      }
    }
    for (const raw of (tr.events || [])) {
      if (!raw || !raw.type) continue;
      // ★ 2026-10-02（N1）：截断上限 140 → 400。
      //   原因：chess 的 `move` 事件是**嵌套**结构
      //     {"type":"move","by":"white","details":{"move":{…},"san":"d4","isCheck":…}}
      //   140 字符会在 `details` 中途断掉 ⇒ 日志里看不到它的完整字段，
      //   导致"渲染该用哪些字段"只能靠猜。400 足以覆盖实测最长事件。
      //   （只影响日志长度，不影响任何行为；单条最长约 400B，量级可忽略。）
      this.log('GAME ev ' + JSON.stringify(raw).slice(0, 400));
      // ★★★ 2026-10-01 修（head 失同步 ⇒ 命令被静默丢弃 ⇒ 死循环 + 气泡堆积）
      //   实测证据（04:21）：
      //     04:21:10  GAME ev clue version=105 / SRV ack hv=105
      //     04:21:14  GAME agent -> submitGuess ver=88   ← head 莫名回退到 88
      //   88 是**上一局卡死时**的版本。服务端对版本不符的 submitGuess
      //   **静默丢弃（连 ack 都不回）** ⇒ this.cur 永远不清 ⇒ 6s 看门狗清理 ⇒ 重试
      //   ⇒ 永久循环，每次循环 say() 一句 ⇒ 气泡堆积（用户看到的「几个气泡一直在」）。
      //   ★ 「事件里的 version」就是服务端权威版本 —— 03:32 那次成功的 SD 出手
      //     正是这么做的（sudden_death version=33 → 发 ver=33 → 被服务端接受）。
      //   取 max：只前进不回退，防止陈旧事件把 head 拉回去。
      if (typeof raw.version === 'number' && raw.version > this.head) {
        if (this.head) this.log('GAME head 校准 ' + this.head + ' → ' + raw.version + '（按事件 version）');
        this.head = raw.version;
      }
      // 拿到真实进展（有 guess/card_reveal/turn_end）⇒ 清掉 SD 连续失败计数
      if (raw.type === 'guess' || raw.type === 'card_reveal' || raw.type === 'turn_end') {
        if (this.sdFails) this.sdFails = 0;
      }
      // ★ B-220（2026-10-04）：回合结束（主动结束 / 超时）同样是「本回合已给词」的**作废点**。
      //   与 handleServer 的顺序有关：`afterState()`（内含 clueEnsure）**在本帧更早执行**，
      //   所以这里清完标志后必须**自己再布防一次**，否则本帧之后没有新帧 ⇒ 看门狗永不布防。
      if (raw.type === 'turn_end' && this.cartridgeId === 'codenames') {
        this.clueSentThisTurn = false;
        this.clueEnsure();
      }
      const e = this.flatEvent(raw);
      if (!e || !e.type) continue;
      // 2026-09-27（问题 8）：整局开始/结束 → 通知代理挂起或恢复战报注入。
      // ★ 修复：原来「恢复」只认 game_started/session_started，但象棋发的是
      //   **game_start（没有 ed）** → 认输触发挂起之后再也没有任何事件能把它解除，
      //   于是整场象棋她一句话都不说（问题 4 的另一半）。
      //   现在把各卡带的"新局/新轮开始"事件全部算作恢复信号。
      if (e.type === 'game_start' || e.type === 'game_started' || e.type === 'session_started'
        || e.type === 'round_started' || e.type === 'bout_started') {
        // ★ 新局/新轮：重置给词状态、看门狗结论、浆果连击
        this.clueSentThisTurn = false; this.clueRetried = false; this.clueNoTry = false; this.endRetried = false; this.clueIllegalRetried = false;
        this.berryStreak = 0;
        this.sdFails = 0;                    // ★ 新局清零 SD 失败计数
        // ★ 新局的版本会重新开始 ⇒ 这里**无条件**采用，否则"只增不减"的校准
        //   会让 head 永远停在上局的末尾版本，导致新局所有指令被拒。
        if (typeof raw.version === 'number') this.head = raw.version;
        /* ★★★ 2026-10-03（B-009）：**玩家执黑 ⇒ 她（白）先手 ⇒ 没人驱动她 ⇒ 整局卡死**。
         *   背景：`chessArm` 全文件**只在"玩家落子"处赋值**（handleClient 的 chess move 分支），
         *   且 chess **没有任何自己的定时器**（codenames 有 sdTick、cakeduel 有 cakeTick、
         *   pictionary 有 picTick —— 只有 chess 没有）⇒ 玩家不动 ⇒ 她永不动。
         *
         *   ★ 为什么必须"主动调度"，不能只置 `chessArm`：
         *     `handleServer` 里 `afterState()`（内含 `afterChessState`）在**同一帧更早**执行
         *     （约 :335 vs :340）⇒ 置完标志**当帧无人消费**；
         *     而本场景**谁也不动 ⇒ 不会再有下一帧** ⇒ 标志永远不会被消费。
         *
         *   ★ 为什么延迟是 `CHESS_THINK_MS` 而不是 0（★ 这个坑很隐蔽）：
         *     `afterChessState` 首段是 `if (!changed && aged < 1500) return;`
         *     —— 延迟 0 时 `aged≈0 < 1500` 且局面未变 ⇒ **立刻 return，且无人重试**
         *     ⇒ 等于没修。取 `CHESS_THINK_MS`(2600) ⇒ `aged=2600 ≥ 1500` 通过；
         *     且 `thinkLeft = 2600 - 2600 = 0` ⇒ 立即出手（不额外拖慢）。
         *
         *   ★ 判据必须**严格** `playerSide === 'black'` —— 判松（例如只看 cartridgeId）
         *     会让"玩家执白、等他先落子"的正常流程**在她不该动时提前动**。 */
        if (this.cartridgeId === 'chess' && String((e && e.playerSide) || raw.playerSide || '') === 'black') {
          this.chessArm = { at: now(), fen0: (this.gs && this.gs.fen) || '', from: '', to: '' };
          this.log('GAME chess 她执白先手（玩家执黑）→ 主动调度一次，' + CHESS_THINK_MS + 'ms 后驱动她');
          const _t = setTimeout(() => {
            try { this.afterChessState(); } catch (er) { this.log('GAME chess 先手驱动 err ' + er.message); }
          }, CHESS_THINK_MS);
          try { if (_t.unref) _t.unref(); } catch (er) {}
        }
        try { this.onGameStart(this.cartridgeId); } catch (er) {}
      }
      // 注意：bout_ended 只是蛋糕对决的一"轮"结束（要赢 3 轮），**不算整局结束**，不能挂起。
      if (e.type === 'game_over' || e.type === 'game_ended' || e.type === 'session_finished' || e.type === 'game_outcome') {
        this.sdStop();                       // ★ 整局结束 → 停掉突然死亡的猜牌定时器
        try { this.onGameEnd(this.cartridgeId); } catch (er) {}
      }
      // ★ 把事件里的权威 version 传下去（否则会用过期的 this.head 发，被 version_mismatch 拒）
      if (e.type === 'agent_turn' && e.action === 'clue' && this.cartridgeId === 'codenames') this.onAgentClueTurn(e.version);
      // ★ 2026-09-30 探测：森林寻宝里「她给提示词」的事件，如果不是我们刚发的，
      //   就是服务端本地假 AI 自己产生的（占位词通常为「诺莉」）。打一条醒目日志，
      //   下次一眼就能分清「我们发的」还是「服务端自己冒出来的」。
      if (e.type === 'clue' && this.cartridgeId === 'codenames') {
        const sentAgo = this.lastClueSentAt ? (now() - this.lastClueSentAt) : Infinity;
        const who = (String(e.by) === 'agent') ? 'AGENT(她)' : String(e.by);
        if (String(e.by) === 'agent' && sentAgo > 5000) {
          this.log('GAME ⚠FAKE-CLUE 服务端自己给词了：「' + String(e.word) + '/' + String(e.count) + '」'
            + '（我们最近一次给词在 ' + (sentAgo === Infinity ? '本次进程内从未' : Math.round(sentAgo / 1000) + 's 前')
            + '）—— 不是我们发的！');
        } else {
          this.log('GAME clue 事件 who=' + who + ' word=' + String(e.word) + '/' + String(e.count)
            + ' 距我们上次给词=' + (sentAgo === Infinity ? 'n/a' : Math.round(sentAgo) + 'ms'));
        }
        // ★★★ B-221 第三层守卫（**状态驱动**，不依赖我们自己的标志链是否接通）：
        //   服务端广播「**她**给过词」⇒ 本回合她不必再给 ⇒ 锁定标志。
        //   （`by === 'counterpart'` 是**玩家的**提示词，**不能**据此锁 —— 否则下一轮
        //     `onAgentClueTurn` 会被自己的守卫挡掉，她就永远不给词了。）
        if (String(e.by) === 'agent') this.clueSentThisTurn = true;
      }
      if (e.type === 'wolfy_taunt') this.fireGesture('gesture.cakeduel', '蛋糕对决：狼爵士 wolfy taunt');
      // ★★ B-101（2026-10-03）：代理层补触发 `wolfy_taunt`。
      //   exe 的 `_discard_claims` **只发 `card_discarded`、不发 `wolfy_taunt`**（gap 审计 A4），
      //   而 `wolfy` 是 **base 20 张牌里唯一带表现事件的牌** ⇒ 前端动画与我们的 `fireGesture`
      //   都在等一个**永不到来的事件**。
      //   ★ 本步补的是**我们侧的反应**（gesture.cakeduel 成就）。
      //   ★ 已知局限：**前端那段狼爵士动画补不了** —— 它等的是服务端事件，
      //     而代理只有上行 `sendUp`，没有"向下行注入事件"的通道（gap 里 snapshot 那条同理）。
      if (e.type === 'card_discarded' && this.cartridgeId === 'cakeduel') {
        const ids = Array.isArray(e.cardIds) ? e.cardIds : [];
        const list = (this.gs && this.gs.cardList) || [];
        const names = ids.map((x) => ((typeof x === 'number' || /^\d+$/.test(String(x)))
          ? (list[Number(x)] || '') : String(x)));
        if (names.indexOf('wolfy') >= 0) {
          this.log('GAME cakeduel 弃牌堆出现 wolfy（cardIds=' + JSON.stringify(ids) + '）→ 代理补触发 taunt');
          this.fireGesture('gesture.cakeduel', '蛋糕对决：狼爵士被弃（代理补触发，exe 不发该事件）');
        }
      }
      // ★★★ 节奏对齐（2026-10-03）：质疑 ⇒ 前端要播「揭示」长动画（≈1000+3000ms）。
      //   在这段时间内**不要让她出手**（否则 exe 提前推进，会打断/抢在前端动画之前）。
      //   同时这也是玩家"点不了"的窗口（前端 `activeEffect` 期间禁用交互）——
      //   我们无法改前端，但**可以让她别在这时候抢跑**。
      if (e.type === 'challenge_made' && this.cartridgeId === 'cakeduel') {
        this.cakeHoldUntil = now() + CAKE_AFTER_REVEAL_MS;
        this.log('CAKE 质疑揭示动画中 → 她的下一手延后至 ' + CAKE_AFTER_REVEAL_MS + 'ms 后（避免抢跑）');
      }
      // ★ 2026-09-30：进入「突然死亡」阶段 → 立刻开始她的自主猜牌
      //   触发条件（引擎 qE）：① tokensRemaining 归零，或 ② 双方都没剩余词可给。
      //   （**不是**踩怪兽触发的 —— 踩怪兽是直接 GAME_OVER 判负）
      if (e.type === 'sudden_death' && this.cartridgeId === 'codenames') {
        this.log('GAME ev 进入突然死亡阶段（令牌耗尽 / 双方无词可给）');
        this.sdEnsure();
      }
      // ★ 2026-10-04（B-111）：原此处有两条 pictionary 兜底（`round_solved` / `session_finished`
      //   时「他画、她猜中」就触发）—— **已删除**。理由：它判的是"**任何猜对**"，
      //   与用户要求的「必须是她猜出『水母』」直接矛盾（会把这条 fact 变成"随便猜对就送"）。
      //   可达性由"玩家主动画水母让她猜"保证（正是官方设计的过关方式）。
      if (e.type === 'game_ended' && this.cartridgeId === 'cakeduel') this.fireGesture('gesture.cakeduel', '蛋糕对决：整局结束（兜底）');
      // ★ 2026-09-30：逐次统计她踩浆果（只有 by=agent 才算；result 取值 agent|bystander|assassin）
      if (e.type === 'guess' && this.cartridgeId === 'codenames') {
        this.noteBerryHit(e.by, e.result); this.cutOpponentRun();
        // ★★★ B-220（2026-10-04）：猜错（踩中性/怪兽）⇒ **该回合结束** ⇒ 下一回合（可能轮到她给词）开始。
        //   必须清掉 `clueSentThisTurn`，否则 `clueEnsure()`（第 1865 行）直接 return
        //   ⇒ 给词看门狗**永不布防** ⇒ 永久卡在「Nori 正在想提示」，**只能 F5**。
        //   实测（2026-10-04 16:00:49~16:01:11）：她给「随身/3」把标志置 true
        //   → 玩家猜中一次（无 HOLD ⇒ `kick()` 没跑 ⇒ 没重置）
        //   → 玩家猜错一次（bystander ⇒ 回合结束，该她给词）
        //   → 标志仍是 true ⇒ 看门狗从未布防 ⇒ 卡死 105 秒，直到 F5（重连重建会话才清标志）。
        //   语义：`clueSentThisTurn` = 「**本回合**已经给过词」⇒ 回合一结束就作废。
        if (e.result === 'bystander' || e.result === 'assassin') {
          this.clueSentThisTurn = false;
          this.clueEnsure();          // ★ 立刻重新布防 —— 本帧之后可能再无新帧（那正是卡死的情形）
        }
      }
      if (e.type === 'capture' && this.cartridgeId === 'chess') {
        // ★★★ B-110（2026-10-04）：原实现读 `e.captured`（**对象**）做
        //   `.toString().toLowerCase()` ⇒ 恒为 "[object object]" ⇒ 判据**永不成立**
        //   ⇒ `gesture.chess` **从未触发过**。
        //   真实结构（proxy.log 实测）：
        //     {"type":"capture","by":"black","from":{"piece":"r"},"captured":{"piece":"q"}}
        //     by = 吃子方 / from.piece = 吃子的棋子 / captured.piece = 被吃棋子
        //   ★ 用户要求：必须是「**她的车吃我的后**」（= 她的颜色 + 车 + 吃后），
        //     而不是原来的"任何一方吃大子"。
        const eater = String((e.from && e.from.piece) || '').toLowerCase();
        const eaten = String((e.captured && e.captured.piece) || '').toLowerCase();
        const pSide = String(this.chessPlayerSide || 'white').toLowerCase();
        const herColor = (pSide === 'white') ? 'black' : 'white';
        if (String(e.by || '').toLowerCase() === herColor && eater === 'r' && eaten === 'q') {
          this.fireGesture('gesture.chess',
            '象棋：她的车吃掉你的后（' + e.by + ' Rx' + ((e.captured && e.captured.square) || '?') + '）');
        }
      }
      // ★★★ B-103（2026-10-03）：棋类「社交动作」应答 —— 原来代理层 **0 引用**。
      //   实测事故：`05:27:38` 玩家 `requestTakeback` → exe 发 `request_takeback`
      //   → **她永不回应 → 那局停在半路**（界面无提示，玩家只会觉得"她不理我"）。
      //   gap 审计：exe 端 8 事件 + 7 命令**全都有**，缺的只在代理层。
      //   ★ 本步只做「被动应答」；「她主动提和 / 主动求悔棋」需要可靠局势评估，风险高，未做。
      if (this.cartridgeId === 'chess') {
        if (e.type === 'game_start') {
          this.chessPlayerSide = String((e && e.playerSide) || raw.playerSide || 'white').toLowerCase();
        }
        const evSide = String(e.side || '').toLowerCase();
        const pSide = String(this.chessPlayerSide || 'white').toLowerCase();
        const myColor = pSide === 'white' ? 'black' : 'white';
        // ★ 判"这个请求是不是我自己提的"。我方写法在不同层可能是 agent / ai / 颜色。
        //   判错方向是安全的：误判成"我方"→ 漏应（不卡死，只是不回）；
        //   误判成"对方"→ 多发一条，而服务端会按 `Invalid draw response` 拒掉，不破坏状态。
        const mineSide = (evSide === 'agent' || evSide === 'ai' || evSide === 'nori'
          || (!!evSide && evSide === myColor));
        if (e.type === 'draw_offer' && !mineSide) {
          const accept = this.shouldAcceptDraw();
          this.log('GAME chess 对方提和(side=' + (evSide || '?') + ') → 回应 accept=' + accept);
          this.sendAgent({ type: 'respondDraw', accept: accept }, 'chess');
        }
        if (e.type === 'request_takeback' && !mineSide) {
          this.log('GAME chess 对方求悔棋(side=' + (evSide || '?') + ') → 回应 accept=true');
          this.sendAgent({ type: 'respondTakeback', accept: true }, 'chess');
        }
        if (e.type === 'respond_draw' || e.type === 'respond_takeback'
          || e.type === 'cancel_draw_offer' || e.type === 'cancel_takeback_request') {
          this.log('GAME chess 社交事件 ' + e.type + ' accept=' + JSON.stringify(e.accept) + ' side=' + (evSide || '?'));
        }
        if (e.type === 'history_rewound') {
          // ★ gap 审计特别标注：悔棋后 fen 已由服务端 patch 改掉 ⇒ 必须清空陈旧的 chessArm，
          //   否则 afterChessState 拿旧 fen0 比对 ⇒ 用错局面驱动她 ⇒ version_mismatch。
          this.chessArm = null;
          this.chessBusy = false;
          this.log('GAME chess 悔棋生效 history_rewound pliesUndone=' + JSON.stringify(e.pliesUndone) + ' → 已清 chessArm');
        }
      }
    }
    // ★★★ B-110（2026-10-04）：原此处还有 `if (chess) this.checkChessHistory();` ——
    //   已删除。理由：它是**宽松兜底**（扫 moveHistory 的 SAN `/x[QR]/` ⇒ **任何一方**吃车/后
    //   都触发），与用户要求的「**必须是她的车吃我的后**」直接矛盾；
    //   且 `moveHistory` 在 `proxy.log`/`obs.log` 里 **0 出现**（疑似根本不在 gameState 里）
    //   ⇒ 它同时是"判据错" + "疑似死代码"。判据统一收敛到上面的 `capture` 分支。
    //   （若将来确证 `moveHistory` 存在且需要兜底，请用**同一严格判据**，不要放宽。）
    if (this.cartridgeId === 'codenames') this.checkCodenamesBerries();
  }
  // 2026-09-30 重写：原实现只看「有没有 cell 带 bystanderMarks」→ **玩家自己踩的也算**，
  //   而且踩 1 次就触发。现在只数**她自己**踩的（bystanderMarks 里存的是阵营 side）。
  checkCodenamesBerries() {
    const g = this.gs; if (!g || !g.cells) return;
    const side = this.agentSideOf();
    let n = 0;
    for (const c of g.cells) {
      if (!c || !Array.isArray(c.bystanderMarks)) continue;
      if (c.bystanderMarks.some((x) => x === side)) n++;
    }
    if (n >= BERRY_STREAK) this.fireGesture('gesture.codenames', '森林寻宝：她累计踩到浆果 ' + n + ' 处');
  }
  // 事件流里逐次累计「她连续踩浆果」的次数（比只看终态准确：bystanderMarks 每个格子只有 2 个槽，
  // 会被覆盖，光看状态数不出 3 次）。她一旦猜对就把连击清零。
  noteBerryHit(by, result) {
    if (this.cartridgeId !== 'codenames' || by !== 'agent') return;   // 玩家踩的不算
    if (result === 'bystander') {
      this.berryStreak = (this.berryStreak || 0) + 1;
      this.log('GAME 她踩到浆果（连续第 ' + this.berryStreak + ' 次）');
      if (this.berryStreak >= BERRY_STREAK) {
        this.fireGesture('gesture.codenames', '森林寻宝：她连续 ' + this.berryStreak + ' 次踩到浆果');
      }
    } else if (result === 'agent') {
      if (this.berryStreak) this.log('GAME 她猜中了 → 浆果连击清零（原 ' + this.berryStreak + '）');
      this.berryStreak = 0;
    }
  }
  // ★ 2026-10-04（B-111）：`checkPicMilestone()` 已删除。
  //   它判的是**题目**（`round.word` / `drawingId` 是否海洋词），
  //   而官方触发是「**她猜出「水母」**」（与题目无关）⇒ 判据判错了对象。
  //   现在的触发点在她猜词落地处（`picTick`）：`guess === '水母'`。
  //   ★ 同时删除了它专用的常量 `PIC_SEA_RE`（原计划放宽成整类海洋生物，属错上加错）。
  //   ★ `picDrawerIsPlayer()` 保留（通用助手，当前无引用）。
  picDrawerIsPlayer() {
    const r = (this.pic && this.pic.roles) || (this.gs && this.gs.round && this.gs.round.roles) || {};
    return r.drawer === 'player';
  }
  // ★ 2026-09-30（containment）：掐断服务端「本地对手」的连猜链。
  //   判据：收到一条 `guess by=agent` 事件，但**不是我们刚发的**（lastGuessSentAt 距今 > 1.2s）
  //   ⇒ 那是服务端内置的本地对手在替她猜（它能读答案，会一路猜对）。
  //   对策：立刻 endTurn 收手，把回合交回玩家 ⇒ 它的链就断了（它的循环是「直到玩家必须行动」）。
  //   安全性：若此刻其实不该我们行动，服务端会回 `Not your turn`，无害（已有处理）。
  cutOpponentRun() {
    if (this.cartridgeId !== 'codenames') return;
    const since = this.lastGuessSentAt ? (now() - this.lastGuessSentAt) : Infinity;
    if (since < 1200) return;                                  // 我们自己刚发的，正常
    if (now() - (this.lastCutAt || 0) < 1200) return;           // 去重，别连发
    const h = (this.gs && Array.isArray(this.gs.history)) ? this.gs.history : null;
    const last = h && h.length ? h[h.length - 1] : null;
    if (!last || last.endedBy) return;                          // 没有进行中的回合 → 不用管
    // 只有「他给词、她猜」的局面才轮到 agent 猜牌
    if (String(last.clueGiver) === String(this.agentSideOf())) return;
    this.lastCutAt = now();
    this.log('GAME ⚠OPP-GUESS 本地对手替她猜了（我们上次发猜牌在 '
      + (since === Infinity ? '本次进程内从未' : Math.round(since) + 'ms 前') + '）→ 立刻 endTurn 收手掐链');
    try { this.sendAgent({ type: 'endTurn' }, 'agent'); } catch (e) { this.log('GAME OPP cut err ' + e.message); }
  }
  fireGesture(id, why) {
    // ★★★ 2026-10-04（用户要求）：四个「算力超限」fact **必须在玩家装上 QFR-9000 之后**才触发。
    //   依据：官方剧情里 `qfr.installed` 是很早的节点，装了 QFR-9000（量子文件恢复仪）才谈得上
    //        "看到算力超限" —— 装之前她不可能超限。
    //   `fireGesture` 是四个 fact 的**唯一注入漏斗** ⇒ 加在这里即全覆盖；
    //   `arg.gestures_complete`（四枚集齐）也随之自动门控（GESTURES.every 不会满足）。
    //   依赖已就绪：`this.hasFact`（构造时注入；nori_proxy 传 `(f)=>FACTS.has(f)`）；
    //        `qfr.installed` 由客户端 client.emitFact 进 FACTS（nori_proxy.js 已处理）。
    //   ★ 门控放在 `fired` 记账**之前** ⇒ 未装时不计入 fired，装上之后仍能正常触发。
    if (!this.hasFact('qfr.installed')) {
      this.log('GAME GESTURE ' + id + ' 跳过（未装 QFR-9000：qfr.installed 未满足）— ' + why);
      return;
    }
    if (!id || this.fired.has(id)) return;
    if (this.hasFact(id)) { this.fired.add(id); return; }
    this.fired.add(id);
    let ok = false;
    try { ok = this.injectFact(id, '游戏进度 — ' + why); } catch (e) { this.log('GAME fact err ' + e.message); }
    this.log('GAME GESTURE ' + id + ' injected=' + ok + ' — ' + why);
    if (GESTURES.every((g) => this.fired.has(g) || this.hasFact(g))) {
      setTimeout(() => { try { this.injectFact(GESTURE_DONE, '四枚超限手势集齐'); this.log('GAME GESTURE ' + GESTURE_DONE); } catch (e) {} }, 1200);
    }
  }

  async kick() {
    const held = this.held; if (!held) return;
    const spec = this.buildTurn(held.obj.cmd, held.obj.cartridgeId);
    this.clueSentThisTurn = false;
    this.clueRetried = false;                 // ★ 每回合重置给词重试标记
    this.clueIllegalRetried = false;          // ★ 每回合重置「提示词非法」重试标记
    this.cluePending = false;                 // ★ 重置给词节流标记
    this.lastClueAt = now();                  // ★ 看门狗的静默基准
    const isClueTurn = held.obj.cartridgeId === 'codenames';
    if (isClueTurn) this.prefetchClue();
    const directive = this.takeDirective();
    let decision = null;
    if (spec && spec.legal.length) {
      try { decision = await this.askBrain(spec, directive); } catch (e) { this.log('GAME brain err ' + e.message); }
    }
    // ★★★ 2026-09-27 修（问题 6「森林寻宝又被本地劫持，全部找到+诺莉」）：
    //   玩家给出提示词后，服务端假 AI 会在轮到 agent 给词时，约 350ms 内自动喊一个
    //   占位词「诺莉」。我们必须在它之前把真提示词发出去 —— 而真提示词是**预取**出来的
    //   （prefetchClue，约 1~1.5s）。原来这里是「预取不等完就放行玩家命令」，
    //   于是 agent_turn 一到、预取还没好 → 抢发失败 → 假 AI 的「诺莉」占位。
    //   现在：轮到给词时，**等预取跑完再放行**，从根上保证我们抢在 350ms 窗口之前。
    if (isClueTurn && this.pendingClue) {
      try {
        await Promise.race([this.pendingClue, new Promise((r) => setTimeout(r, 4000))]);
      } catch (e) {}
      this.log('GAME clue 预取已就绪（放行玩家命令，准备抢发）');
    }
    if (!decision) { this.stats.noop++; this.log('GAME RELEASE (no decision) -> 本地假 AI 兜底'); this.release(held); return; }
    this.lastLine = decision.line || ''; this.lastEmo = decision.emotion || 'neutral';
    this.queue = spec.actionsFromBrain ? spec.actionsFromBrain(decision) : [];
    this.stats.released++;
    this.log('GAME RELEASE player + ' + this.queue.length + ' agent cmds (brain ' + decision.ms + 'ms obey=' + decision.obeyed + ')');
    this.release(held);
  }
  release(held) {
    const h = held || this.held; if (!h) return;
    this.held = null; this.cur = { requestId: h.obj.requestId, kind: 'player' }; this.curAt = now();
    try { this.sendUp(h.raw); } catch (e) { this.log('GAME sendUp failed ' + e.message); }
  }
  next() {
    const cmd = this.queue.shift();
    if (!cmd) { this.maybeSendClue(); return; }
    // 2026-09-27（问题 6-B）：连续替她出招时插入最小间隔，
    // 让她看起来是"一张一张想"，而不是一个 tick 内九连猜（玩家反馈"节奏太快，有点假"）。
    const gap = AGENT_STEP_MS - (now() - this.lastAgentAt);
    if (this.lastAgentAt && gap > 0) {
      setTimeout(() => { try { this.emitAgent(cmd); } catch (e) { this.log('GAME agent delay send err ' + e.message); } }, gap);
      return;
    }
    this.emitAgent(cmd);
  }
  emitAgent(cmd) {
    // ★ 2026-10-01（B-028）：会话已被销毁（新连接建立）后，残留的一次性 setTimeout
    //   仍可能回调到这里 —— 必须拦住，否则旧实例还会往已死的 socket 发指令。
    if (!this.enabled || this._dead) return;
    // ★ 2026-09-30：发之前验局面（队列是按旧快照排的，可能已过期）
    const chk = this.cmdCheck(cmd);
    if (!chk.ok) {
      this.log('GAME 跳过过期指令 ' + JSON.stringify(cmd).slice(0, 60) + '（' + chk.why + '）');
      this.next();     // 继续处理队列（后续项同样会被校验）
      return;
    }
    const requestId = uuid(); this.cur = { requestId, kind: 'agent', cmd: cmd }; this.curAt = now(); this.stats.ourCmds++;
    this.lastAgentAt = now();
    if (cmd && cmd.type === 'submitGuess') this.lastGuessSentAt = now();   // ★ 供「本地对手连猜」探测
    // ★ B-221：**队列出口**同样要置标志 —— 大脑在「猜牌阶段」也可以附带给词（`actionsFromBrain`
    //   会产出 submitClue），那条路走的是队列（`next()` → `emitAgent`），不经过 `sendAgent`。
    if (cmd && cmd.type === 'submitClue') { this.lastClueSentAt = now(); this.clueSentThisTurn = true; }
    const msg = { type: 'dispatch', worldId: this.worldId, cartridgeId: this.cartridgeId, actor: 'agent', visibilityFenceId: this.fence, cmd, expectedHeadVersion: this.head, requestId };
    this.log('GAME agent -> ' + JSON.stringify(cmd).slice(0, 90) + ' ver=' + this.head);
    try { this.sendUp(JSON.stringify(msg)); } catch (e) { this.log('GAME agent send failed ' + e.message); }
  }
  // ★ 2026-09-27 修（森林寻宝卡在「Nori 正在想提示」）：
  //   我们发 endTurn 后，服务端 headVersion 3→4，并在同一个 transition 里广播
  //   `agent_turn(clue)` 事件 —— **事件自带权威 version=4**。
  //   但原来的 sendAgent 只会用 this.head（还是 3，因为 dispatch_ack 还没回来），
  //   于是抢发的 submitClue 被 `Version mismatch: expected 3, head is 4` 拒掉；
  //   更糟的是失败后 clueSentThisTurn 已是 true → 永不重试 → 卡死在「正在想提示」。
  //   修法：①允许调用方用事件里的权威 version；②同一版本下把 this.head 校准过去。
  sendAgent(cmd, kind, verOverride) {
    // ★ 2026-09-30：直发路径（onAgentClueTurn / askAndClue / forceFallbackClue）也要验局面
    const chk = this.cmdCheck(cmd);
    if (!chk.ok) {
      this.log('GAME 跳过过期指令(直发) ' + JSON.stringify(cmd).slice(0, 60) + '（' + chk.why + '）');
      return;
    }
    const fromEvent = (typeof verOverride === 'number' && verOverride >= 0);
    const useVer = fromEvent ? verOverride : this.head;
    if (fromEvent) this.head = verOverride;      // 用事件里的权威版本校准
    const requestId = uuid(); this.cur = { requestId, kind: kind || 'agent', cmd: cmd }; this.curAt = now(); this.stats.ourCmds++;
    // ★★★ B-221（2026-10-04）：**所有** submitClue 出口都必须置 `clueSentThisTurn`。
    //   原来只有 chain 路径（`maybeSendClue`）与 `forceFallbackClue` 置了它；
    //   而 **`onAgentClueTurn`（正常路径）与 `askAndClue`（看门狗路径）都没置**
    //   ⇒ 给词看门狗每 6 秒就以为"她还没给词" ⇒ **同一回合连发十几个提示词**
    //     （实测 16:14:19~16:15:29：身体/骨头/笔/人体/身体/支撑/身体/骨头/支撑/身体/挖…，版本 8→18）。
    //   放在这里最稳：**恰好在"cmdCheck 通过、命令真的发出去"之后** ⇒ 覆盖全部出口；
    //   被 `cmdCheck` 拦下的（根本没发出）不会置 ⇒ 不会把看门狗永久关死（B-220 的教训）。
    if (cmd && cmd.type === 'submitClue') { this.lastClueSentAt = now(); this.clueSentThisTurn = true; }
    if (cmd && cmd.type === 'submitGuess') this.lastGuessSentAt = now(); // ★ 供「本地对手连猜」探测使用
    const msg = { type: 'dispatch', worldId: this.worldId, cartridgeId: this.cartridgeId, actor: 'agent', visibilityFenceId: this.fence, cmd, expectedHeadVersion: useVer, requestId };
    this.log('GAME agent -> ' + JSON.stringify(cmd).slice(0, 90) + ' ver=' + useVer + (fromEvent ? ' (event)' : ''));
    try { this.sendUp(JSON.stringify(msg)); } catch (e) { this.log('GAME agent send failed ' + e.message); }
  }
  wordOf(i) { const b = this.gs && this.gs.board && this.gs.board[i]; return (b && (b.text || b.id)) || ('第' + i + '格'); }
  finishTurn() {
    if (!this.turnLog.length) return;
    const guesses = this.turnLog.filter((s) => /^Nori翻了/.test(s)).slice(0, 4);
    const head = this.turnLog.filter((s) => !/^Nori翻了/.test(s));
    const body = head.concat(guesses).join('；'); this.turnLog = [];
    const text = '【NoriOS战报·' + (GAME_NAME[this.cartridgeId] || this.cartridgeId) + '】' + body + '。Nori，说两句你现在怎么想的，一两句就好。';
    let ok = false;
    try { ok = this.onCommentary(text, this.cartridgeId) !== false; } catch (e) { this.log('GAME commentary err ' + e.message); }
    if (!ok && this.lastLine) {
      /* ★★★ 2026-10-02 修「同一句话被推两遍」（实测：chess 每轮的 chat messageId 成对出现）。
       *
       *   根因（证据链在 proxy.log）：
       *     kickChess() 里先 `say(lastLine)` 上屏（气泡 #1）→ 落子 → `next()` 队列空
       *     → `maybeSendClue()`，而它的守卫是 `cartridgeId !== 'codenames'` ⇒ **chess 恒真**
       *     ⇒ 直接 `finishTurn()` ⇒ `onCommentary` 在战报不注入时返回 false（N2 之后恒 false）
       *     ⇒ 走这里兜底，把**同一句 lastLine 又推一遍**（气泡 #2，新 messageId）。
       *   时序证据（proxy.log 10:28:18）：
       *     GAME-LINE → AGENTCHAT → RECORD msg_48，紧接着 GAME-LINE → AGENTCHAT → RECORD msg_49，
       *     文本逐字节相同；且第二次**没有** `GAME chess DRIVE` / `GAME brain chess` 日志
       *     ⇒ 不是决策路径说的，只可能是本兜底。
       *
       *   修法：兜底前先比对"最近真正上屏的那句"（say() 记的 `_saidSig`）。
       *   文本相同且时间相近 ⇒ 认为已经说过，跳过。判据与 C7 的 `_sdSaySig` 同思路。
       *   ⚠ 不改兜底本身的语义：真没说过（如 codenames 的纯提醒场景）仍然照说。 */
      const sig = String(this.lastLine).trim();
      const s = this._saidSig;
      if (s && s.t === sig && (now() - s.at) < 15000) {
        this.log('GAME finishTurn 兜底跳过（' + Math.round((now() - s.at) / 1000) + 's 前已上屏同一句，避免重复气泡）');
      } else {
        this.onLine({ text: this.lastLine, emotion: this.lastEmo, game: this.cartridgeId, obeyed: true });
      }
    }
  }
  async askBrain(spec, directive) {
    const t0 = now(); const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), HOLD_MS);
    let j = null;
    try {
      const r = await fetch(BRAIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({
          game: spec.game, observation: spec.observation, directive, legal: spec.legal,
          maxActions: spec.maxActions, clueMode: !!spec.clueMode,
          image: spec.image || null,        // ★ 真·看图：PNG data URI（只有画猜会带）
        }) });
      j = await r.json();
    } finally { clearTimeout(timer); }
    if (!j || !j.ok) throw new Error('brain not ok');
    j.ms = j.ms || (now() - t0);
    this.log('GAME brain ' + spec.game + ' obey=' + j.obeyed + ' acts=' + JSON.stringify(j.actions) + ' emo=' + j.emotion + ' img=' + (spec.image ? 'yes' : 'no') + ' ' + j.ms + 'ms');
    return j;
  }

  buildTurn(cmd, cart) {
    if (cart === 'codenames') return this.buildCodenames(cmd);
    if (cart === 'chess') return this.buildChess(cmd);
    if (cart === 'cakeduel') return this.buildCakeduel(cmd);
    return null;
  }

  // ==================== 森林寻宝 ====================
  buildCodenames(cmd) {
    const g = this.gs;
    if (!g || !g.board || !g.cells) return null;
    if (cmd && cmd.type === 'submitClue' && cmd.clue) this.lastClue = cmd.clue;
    const board = g.board, cells = g.cells, open = [];
    for (let i = 0; i < board.length; i++) {
      const c = cells[i] || {}; if (c.solvedBy) continue;
      open.push({ id: 'cell:' + i, desc: (board[i] && (board[i].text || board[i].id)) || ('第' + i + '格') });
    }
    if (!open.length) return null;
    const clue = this.lastClue ? (this.lastClue.word + '（' + this.lastClue.count + ' 个）') : '（没有提示词）';
    const marks = [];
    for (let i = 0; i < board.length; i++) {
      const c = cells[i] || {};
      if (c.solvedBy || !c.bystanderMarks || !c.bystanderMarks.some((x) => x)) continue;
      marks.push(((board[i] && (board[i].text || board[i].id)) || i) + '（上次翻错了）');
    }
    const observation = [
      '森林寻宝：现在是你要猜牌。他给你的提示词是「' + clue + '」，照这个提示在下面的词里挑。',
      '还没被翻开的词（' + open.length + ' 个）：' + open.map((o) => o.desc).join('、') + '。',
      marks.length ? '提醒：' + marks.join('、') + '。' : '',
      '【猜牌的取舍 —— 很重要】',
      '· 提示词后面的数字（count）是它**指向几个词**：count=1 就只猜那一个最贴的，猜中后**收手**。',
      '· **宁可少猜一张，也不要多翻** —— 翻到「怪兽」是**你们团队立刻整局输**（不是只结束回合）。',
      '  所以「反正顺手翻翻看」这种没把握的补猜，风险远大于收益。',
      '· count≥2 时，只有你**确实想到了第二个同族的词**才继续；只是想碰碰运气，就选 end 收手。',
      '· 你和他是**队友**：猜中的每一张都是**你们团队**的宝箱（全 15 个找齐才算赢）——',
      '  不存在「给谁送分」这回事，你的目标就是**尽量猜中**。翻到中性牌只是结束回合（不严重）。',
      '翻对了继续；翻错了这一回合就结束；翻到「怪兽」直接输。猜够了就先收手（选 end），然后由你给他出一个提示词。',
      '如果你也要给他一个提示词（clue）：**提示词不能是棋盘上任何一个词**、不能含空格/数字，1~6 个字，靠联想指向你想让他猜的词。',
      '例如 {"word":"冷的东西","count":2}。',
    ].filter(Boolean).join('\n');
    const legal = open.concat([{ id: 'end', desc: '这一回合到此为止（不再猜了）' }, { id: 'clue', desc: '由你给他出一个提示词（写在你自己的 clue 字段里）' }]);
    return { game: 'codenames', observation, legal, maxActions: 9, actionsFromBrain: (d) => {
      const out = [];
      for (const id of d.actions || []) {
        if (/^cell:/.test(id)) out.push({ type: 'submitGuess', cell: Number(id.slice(5)) });
        else if (id === 'end') out.push({ type: 'endTurn' });
        else if (id === 'clue') {
          // ★ 2026-09-30 修：这里原来在「大脑选了 clue 但没给词」时用 '诺莉' 兜底
          //   —— 「诺莉」正是本地假 AI 的占位词。结果一旦触发，玩家会以为"假 AI 又活了"。
          //   现在：大脑没给词就**不发**这条 clue（这只是一个可选的附加动作，跳过不会卡局；
          //   真正轮到"她给词"的场合由 agent_turn → onAgentClueTurn → askAndClue 负责，
          //   那条路径用 board-safe 的中性词兜底，见 fallbackClueWord()）。
          const cl = d.clue && d.clue.word ? d.clue : null;
          if (!cl) { this.log('GAME clue(被跳过：大脑选了 clue 但没给 word)'); continue; }
          const okc = this.normalizeClue(cl);        // ★ 发出前按引擎规则自检
          if (!okc) { this.log('GAME clue(被跳过：规整不出合法词)'); continue; }
          this.clueSentThisTurn = true;
          out.push({ type: 'submitClue', clue: { word: okc.word, count: okc.count } });
        }
      }
      // ★ 2026-09-30（containment，重要）：
      //   服务端内置的「本地对手」**还活着** —— 它是被客户端确认帧（音频/动画）驱动的，
      //   所以上次裸 WS 探针看起来"静默"是假象，exe 那个 0.35 补丁没打中它。
      //   它会在「仍是 agent 的猜牌回合」里不断替她连猜，而且**读得到答案**
      //   （实测：按 cell 升序 4→5→8→10→11→22→23 连猜全对，词与 key.A 的 AGENT 完全吻合）。
      //   ⇒ 对策：她猜完就**立刻 endTurn 收手**，把回合尽早交回玩家，掐断它的链。
      //   （代价：她一个提示词回合只猜 1 张，而不是 count 张。等本地对手能被真正关掉后可放开。）
      const guesses = out.filter((c) => c.type === 'submitGuess');
      const others = out.filter((c) => c.type !== 'submitGuess');   // endTurn / submitClue
      const seq = guesses.slice();
      // ★ 修正（本轮回归 bug）：原来只拼 guesses + clueCmds，把**大脑自己选的 endTurn 丢了**
      //   （实测 08:13:28 大脑给的是 ["cell:20","end"]，结果只发出 1 条指令）。
      //   现在 others 原样保留，只在"她猜了但没打算收手"时补一个 endTurn。
      if (guesses.length && !others.some((c) => c.type === 'endTurn')) seq.push({ type: 'endTurn' });
      return seq.concat(others);
    } };
  }

  // ---------- 森林寻宝 · agent 回合（轮到 Nori 给提示词）----------
  // 服务端假 AI（WorldSession._run_agent_turns）在轮到 agent 给提示词时，会在 ~350ms 内
  // 用一个本地化占位词（"诺莉"/"NORI"）自动 submitClue。我们要抢在这 350ms 之前发出真提示词。
  // 做法：在玩家给提示词被扣住的那段窗口里，提前把「Nori 的提示词」也算出来（prefetch），
  // 一旦收到 agent_turn(clue) 事件就同步发出（WS 写入 ≈ 毫秒级，稳赢 350ms）。
  agentSideOf() { return this.agentSide || (this.gs && this.gs.agentSide) || 'B'; }
  buildCodenamesClueSpec() {
    const g = this.gs; if (!g || !g.board || !g.key) return null;
    const side = this.agentSideOf(), foe = side === 'A' ? 'B' : 'A';
    const my = [], assassin = [], opp = [], neutral = [];
    for (let i = 0; i < g.board.length; i++) {
      const c = (g.cells && g.cells[i]) || {};
      if (c.solvedBy) continue; // 已解出的不用再提示
      const w = (g.board[i] && (g.board[i].text || g.board[i].id)) || ('第' + i + '格');
      const role = g.key[side] ? g.key[side][i] : null;
      if (role === 'AGENT') my.push(w);
      else if (role === 'ASSASSIN') assassin.push(w);
      else neutral.push(w);
      const f = g.key[foe] ? g.key[foe][i] : null;
      if (f === 'AGENT') opp.push(w);
    }
    // ★★★ 判据（2026-10-03 用户定案 · 语义极易搞反）：
    //   `my` = `key[她].AGENT` 未翻开 = **【他（玩家）】还要找的宝箱**
    //   （用户原话：「她给不给提示由**我的剩余宝箱**决定」）
    //   ⇒ `!my.length`（他没得找了）⇒ 她不必给提示 ⇒ 返回 null ✓ **本条语义正确，勿改**。
    //   ⚠ 注意：不要误以为 `my` 是"她自己的宝箱" —— 那是 `codexRemaining().myLeft`（key[他]）。
    if (!my.length) return null;
    // ★ 2026-09-30：把「你的地图」用整张 5×5 棋盘画出来（而不是只列几个词），
    //   并明确标注：他屏幕上 **看不到** 这些标记，只有你能看到 ⇒ 他只能靠你的提示词猜。
    //   目的：避免大模型把「你的词」误当成「他已经在看的词」，从而出题指错目标。
    const lines = [];
    for (let r = 0; r < 5; r++) {
      const row = [];
      for (let c2 = 0; c2 < 5; c2++) {
        const i = r * 5 + c2;
        const cell = (g.cells && g.cells[i]) || {};
        const w = (g.board[i] && (g.board[i].text || g.board[i].id)) || ('第' + i + '格');
        const role = g.key[side] ? g.key[side][i] : null;
        const mark = cell.solvedBy ? '（已翻开）' : (role === 'AGENT' ? '★' : (role === 'ASSASSIN' ? 'X' : ''));
        row.push(w + mark);
      }
      lines.push(row.join('  '));
    }
    const observation = [
      '森林寻宝：现在轮到你给提示词。他接下来会照着你的提示去猜。',
      '',
      '【你的地图】—— 只有你能看到这张图，**他屏幕上没有这些标记**：',
      '★ = 你要让他猜出来的「你的词」；X = 怪兽（绝对不能引到）；无标记 = 无关词。',
      ...lines,
      '',
      '你要让他猜出这 ' + my.length + ' 个词：' + my.join('、') + '。',
      '要避开：怪兽 ' + (assassin.length ? assassin.join('、') : '（无）') + '（绝对不能引到）。',
      '说明：他猜的结果**只按你这一张图判** —— 他屏幕上没有你的标记，全靠你的提示词。',
      '',
      '【给提示词的硬规则 —— 违反了会被判无效，这一轮就白给】',
      '① 提示词**绝对不能是棋盘上已经印着的任何一个词**（包括你自己的那些词）。',
      '   反例：想让他猜「实验室」，提示词就**不能**写「实验室」——那是不允许的。',
      '② 提示词里**不能有空格、也不能有数字**。',
      '③ 提示词应当是**中性的常见词/短语**（1~6 个字），靠意义上的联想指向你的词。',
      '   正例：你的词是「显微镜、画笔、实验室」→ 提示词可以是「科研」或「实验器材」。',
      '④ count = 你想让他一次猜几个（1~9）。词越长越准就 count 小，越宽就 count 大。',
      '',
      '给一个提示词 + count（写在 clue 字段里）。',
    ].join('\n');
    const legal = [{ id: 'clue', desc: '给你的提示词（写在 clue 字段里）' }];
    // ★ 审计用：把她给词时「看到的目标」打出来，方便判断提示词是否靠谱（她=key[side]，他=key[foe]）。
    this.log('CODEX-CLUESPEC 她的词=[' + (my.join('、') || '（无）') + '] 怪兽=[' + (assassin.join('、') || '（无）')
      + '] 对方的词=[' + (opp.join('、') || '（无）') + ']');
    return { game: 'codenames', observation, legal, maxActions: 1, clueMode: true };
  }
  prefetchClue() {
    const spec = this.buildCodenamesClueSpec();
    if (!spec || !spec.legal.length) return;
    this.pendingClueAt = now();
    this.pendingClue = this.askBrain(spec, '')
      .then((d) => {
        const cl = d && d.clue && d.clue.word ? d.clue : null;
        if (!cl) return null;
        // ★ 2026-09-30：发出前先按引擎规则自检（不能是棋盘词/不能含空白数字）
        const p = this.normalizeClue(cl);
        if (!p) return null;
        p.side = this.agentSideOf();
        this.log('GAME clue prefetched 「' + p.word + '/' + p.count + '」');
        return p;
      })
      .catch((e) => { this.log('GAME clue prefetch err ' + e.message); return null; });
  }
  onAgentClueTurn(ver) {
    if (this.clueSentThisTurn || this.cluePending) return;   // cluePending 防重复
    this.cluePending = true;
    const p = this.pendingClue;
    this.pendingClue = null;
    const send = (cl) => {
      // ★ 节流：把「发出提示词」延后 CLUE_DELAY_MS，让前端的揭示动画先跑完
      const emit = () => {
        this.cluePending = false;
        const ok = this.normalizeClue(cl);       // ★ 发出前按引擎规则自检
        if (!ok) { this.log('GAME clue 无法规整出合法词 → 放弃'); return; }
        this.turnLog.push('Nori（她）给他的提示词是「' + ok.word + '（' + ok.count + ' 个）」');
        this.say('提示：「' + ok.word + '」，' + ok.count + ' 个。', 'neutral', { ui: true });
        // 用 agent_turn 事件里的权威 version 发（见 sendAgent 注释）
        this.sendAgent({ type: 'submitClue', clue: { word: ok.word, count: ok.count } }, 'agent', ver);
        this.log('GAME clue(send) 「' + ok.word + '/' + ok.count + '」 → 抢发 ver=' + (typeof ver === 'number' ? ver : this.head));
      };
      if (CLUE_DELAY_MS > 0) setTimeout(() => { try { emit(); } catch (e) { this.log('GAME clue emit err ' + e.message); } }, CLUE_DELAY_MS);
      else emit();
    };
    if (p && typeof p.then === 'function') {
      p.then((cl) => { if (cl) send(cl); else this.askAndClue(ver); }).catch(() => this.askAndClue(ver));
    } else if (p && p.word) send(p);
    else this.askAndClue(ver);
  }
  maybeSendClue() {
    if (this.isSuddenDeath()) return;   // 突然死亡阶段不能再给词（会被服务端拒），由 sdTick 负责猜牌
    if (this.cartridgeId !== 'codenames' || this.clueSentThisTurn || !this.pendingClue) { this.finishTurn(); return; }
    const p = this.pendingClue; this.pendingClue = null;
    const send = (cl) => {
      if (!cl) {
        // ★ 2026-09-27：假 AI 已关，我们不给词就没人给 → 必须兜底发一个。
        const fb = this.fallbackClueWord();
        this.log('GAME clue(none) → 兜底词「' + fb + '/1」');
        this.clueSentThisTurn = true;
        this.sendAgent({ type: 'submitClue', clue: { word: fb, count: 1 } });
        this.finishTurn();
        return;
      }
      this.clueSentThisTurn = true;
      const ok2 = this.normalizeClue(cl);        // ★ 发出前按引擎规则自检
      if (!ok2) { this.log('GAME clue(chain) 无法规整出合法词 → 放弃'); this.finishTurn(); return; }
      this.turnLog.push('Nori（她）给他的提示词是「' + ok2.word + '（' + ok2.count + ' 个）」');
      this.say('提示：「' + ok2.word + '」，' + ok2.count + ' 个。', 'neutral', { ui: true });
      this.sendAgent({ type: 'submitClue', clue: { word: ok2.word, count: ok2.count } });
      this.log('GAME clue(chain) 「' + ok2.word + '/' + ok2.count + '」 → 抢发');
    };
    if (typeof p.then === 'function') p.then(send).catch(() => { this.log('GAME clue chain err'); this.finishTurn(); });
    else send(p);
  }
  askAndClue(ver) {
    const spec = this.buildCodenamesClueSpec();
    if (!spec || !spec.legal.length) { this.log('GAME clue(no spec) → 兜底给词'); this.forceFallbackClue(ver); return; }
    this.log('GAME clue(prefetch miss) → 现问大脑');
    this.askBrain(spec, '').then((d) => {
      const cl = d && d.clue && d.clue.word ? d.clue : null;
      if (!cl) { this.forceFallbackClue(ver); return; }
      const ok = this.normalizeClue(cl);         // ★ 发出前按引擎规则自检
      if (!ok) { this.forceFallbackClue(ver); return; }
      this.turnLog.push('Nori（她）给他的提示词是「' + ok.word + '（' + ok.count + ' 个）」');
      this.sendAgent({ type: 'submitClue', clue: { word: ok.word, count: ok.count } }, 'agent', ver);
    }).catch((e) => { this.log('GAME clue ask err ' + e.message); this.forceFallbackClue(ver); });
  }
  // ★ 2026-09-27：假 AI 关掉后，「她不给词」= 整局卡死。这里保证一定发得出一个合法提示词。
  //   count 固定 1、词取一个与棋盘无冲突的中性词（见 CODEX_FALLBACK_CLUES）。
  fallbackClueWord() {
    const g = this.gs || {};
    const board = new Set(((g.board || []).map((b) => (b && (b.text || b.id)) || '')).map(normWord));
    for (const w of CODEX_FALLBACK_CLUES) if (!board.has(normWord(w))) return w;
    return CODEX_FALLBACK_CLUES[0];
  }
  // ★★★ 2026-09-30 新增：把引擎 `_validate_clue` 的规则**在本地复刻**，发出前先自检。
  //   规则来源 = exe 字符串池（_validate_clue 的异常文案与顺序）：
  //     "clue.word must be a string" / "Invalid clue word" / "Clue word cannot be on the board"
  //     "Clue count must be a non-negative integer or infinity"
  //   其中 "Invalid clue word" 对应的是 `word.strip().upper()` 后再 `re.search(r'\s|\d', word)`
  //   ⇒ **不能含空白或数字**；棋盘判定因先 upper，**大小写不敏感**。
  //   返回 null = 合法；否则返回原因串。
  clueWordProblem(word) {
    if (word == null) return 'missing';
    if (typeof word !== 'string') return 'not-a-string';
    const w = normWord(word);
    if (!w) return 'empty';
    if (/[\s\d]/.test(w)) return 'has-space-or-digit';
    const g = this.gs || {};
    const board = new Set(((g.board || []).map((b) => (b && (b.text || b.id)) || '')).map(normWord));
    if (board.has(w)) return 'on-board';
    return null;
  }
  // 把大脑给的 clue 规整成「引擎一定接受」的形式；不合法就换成兜底词。
  // 所有给词出口都必须过这里（prefetch / onAgentClueTurn / askAndClue / maybeSendClue / force）。
  normalizeClue(cl) {
    let word = (cl && cl.word != null) ? String(cl.word) : '';
    word = word.replace(/^["'「『\s]+|["'」』\s]+$/g, '').trim();
    let reason = this.clueWordProblem(word);
    if (reason) {
      const bad = word.slice(0, 20);
      const fb = this.fallbackClueWord();
      this.log('GAME clue 非法（' + reason + '）「' + bad + '」→ 换成兜底词「' + fb + '」');
      if (this.clueWordProblem(fb)) { this.log('GAME clue 兜底词也不合法 → 放弃本次给词'); return null; }
      return { word: fb.slice(0, 12), count: 1 };
    }
    const count = Math.max(1, Math.min(9, Number(cl && cl.count) || 1));
    return { word: word.slice(0, 12), count: count };
  }
  forceFallbackClue(ver) {
    if (this.clueSentThisTurn) return;
    const ok = this.normalizeClue({ word: this.fallbackClueWord(), count: 1 });
    if (!ok) { this.log('GAME clue(强制兜底) 连兜底词都不合法 → 放弃'); return; }
    this.clueSentThisTurn = true;
    this.log('GAME clue(强制兜底) 「' + ok.word + '/1」');
    this.sendAgent({ type: 'submitClue', clue: { word: ok.word, count: 1 } }, 'agent', ver);
  }
  // ★ 自愈看门狗：长时间没有任何我方动作、且本回合还没给过词 → 试探性补一个提示词。
  //   若服务端回「Not your turn」说明时机不对（其实该玩家猜牌），置 clueNoTry 不再打扰。
  clueWatchdog() {
    if (this.cartridgeId !== 'codenames') return;
    // ★ B-221：`cluePending` = 提示词**在途中**（`onAgentClueTurn` 会用 CLUE_DELAY_MS 节流后发）
    //   ⇒ 也必须算"已经给过"，否则延迟发送期间会被看门狗插队再发一个。
    if (this.clueSentThisTurn || this.clueNoTry || this.cluePending) return;
    if (!this.gs || !this.gs.board) { this.log('GAME clue 看门狗：无局面，跳过'); return; }
    if (this.held || this.cur || this.queue.length) { this.log('GAME clue 看门狗：有在途动作，跳过'); return; }
    // ★★★ 2026-10-03 新增两条判据（用户定案的规则 + 本次卡住的根因）：
    //   ① **必须轮到她给词**（`whoseTurnToGive` 是她）。否则会对着"该玩家猜牌"的场合瞎补发。
    //   ② **他（玩家）还得有宝箱要找**（`hisLeft > 0`）—— 这正是"她该不该给提示"的判据
    //      （用户原话：「她给不给提示由**我的剩余宝箱**决定」）。他没得找了 ⇒ 不该给。
    //   ⚠ 这同时保证 `buildCodenamesClueSpec` 的 `my.length` 非空 ⇒ 能问大脑拿到**有意义的**提示词，
    //     而不是退化成 `forceFallbackClue` 的中性占位词。
    const g0 = this.gs || {};
    if (String(g0.whoseTurnToGive || '') !== String(this.agentSideOf())) {
      this.log('GAME clue 看门狗：没轮到她给词（whoseTurnToGive=' + g0.whoseTurnToGive + '），跳过');
      return;
    }
    const rem = this.codexRemaining();
    if (!rem || rem.hisLeft <= 0) {
      this.log('GAME clue 看门狗：他没有宝箱要找了（hisLeft=0），跳过');
      return;
    }
    // ★ 静默判据：以「最近一次局面更新」为基准（`clueArmAt` 由 clueEnsure 在每次 afterState 刷新）。
    //   服务端只要还在推帧，afterState 就会调用 ⇒ 计时被重置 ⇒ 不会误触发。
    //   ★ B-221：把 `lastClueSentAt` 也算进基准 —— **我们自己刚发过词**也算"有动作"，
    //     否则刚发完 6 秒就可能被判定"静默"（用户反馈"看门狗太积极"）。
    const idle = now() - Math.max(this.clueArmAt || 0, this.lastAgentAt || 0, this.lastClueAt || 0, this.lastClueSentAt || 0);
    if (idle < 6000) { this.log('GAME clue 看门狗：刚有动作(' + Math.round(idle) + 'ms)，跳过'); return; }
    this.log('★ GAME clue 看门狗触发：轮到她给词、局面已静默 ' + Math.round(idle / 1000)
      + 's 但服务端【没发 agent_turn】→ 试探性补发提示词');
    this.askAndClue(this.head);
  }
  /* ★★★ 2026-10-03（本次卡住的修复）：给词看门狗【常态布防】。
   *   原布防点只有一处 —— `cartridge_mounted_ack`（= 代理重启 / 前端重连）。
   *   ⇒ 平时根本没有定时器在跑 ⇒ "服务端漏发 agent_turn"（本次实测：15:44:05 之后再无 agent_turn）
   *     这种情形**永远兜不住** ⇒ 永久卡在「Nori 正在想提示」。
   *   现在改为：**每次 `afterState()`（= 每次收到新帧）都重新布防 6s**。
   *   语义变成「**已经 6 秒没有新帧了**，而她还该给词没给」⇒ 才是真的卡住。
   *   安全：只要服务端在推帧就不会触发；另有 `clueSentThisTurn` / `clueNoTry` / 在途动作三重守卫。
   */
  clueEnsure() {
    if (this.cartridgeId !== 'codenames') return;
    if (this.clueSentThisTurn || this.clueNoTry || this.cluePending) return;
    const g = this.gs || {};
    // ★ 只在【普通阶段】布防：SD 不给词；其余 phase（结束等）也不该补发。
    //   与 `cmdCheck` 的判据保持一致（`phase !== 'NORMAL'` 一律发不出去）。
    if (String(g.phase || 'NORMAL') !== 'NORMAL') return;
    if (String(g.whoseTurnToGive || '') !== String(this.agentSideOf())) return;   // 没轮到她
    const rem = this.codexRemaining();
    if (!rem || rem.hisLeft <= 0) return;             // 他没得找了 ⇒ 不必给
    this.clueArmAt = now();                           // ★ 每次刷新 = "静默计时器"归零
    clearTimeout(this.clueWatch);
    this.clueWatch = setTimeout(() => { try { this.clueWatchdog(); } catch (e) {} }, 6000);
    try { this.clueWatch.unref(); } catch (e) {}
    if (!this._clueEnsureLogged) {
      this._clueEnsureLogged = true;
      this.log('GAME clue 看门狗【常态布防】中（轮到她给词 → 6s 内无新帧即补发）');
    }
  }

  // ==================== 国际象棋 ====================
  mkChess(fen) {
    if (!Chess || !fen) return null;
    try { return new Chess(fen); } catch (e) {}
    try { return new Chess(String(fen).trim() + ' 0 1'); } catch (e) {}
    return null;
  }
  buildChess(cmd) {
    const g = this.gs;
    if (!g || !g.fen) return null;
    if (!Chess) { this.log('GAME chess.js 不可用（npm i chess.js）'); return null; }
    const c = this.mkChess(g.fen);
    if (!c) { this.log('GAME chess fen 解析失败 ' + g.fen); return null; }
    // 玩家那一步被我们扣住了 → 本地替他走，得到她该应对的局面
    if (cmd && cmd.type === 'move') {
      try { c.move({ from: cmd.from, to: cmd.to, promotion: cmd.promotion || 'q' }); }
      catch (e) { this.log('GAME chess 玩家走法非法 ' + e.message + ' ' + cmd.from + cmd.to); return null; }
    }
    const moves = c.moves({ verbose: true });
    if (!moves.length) return null;
    const her = c.turn() === 'w' ? '白方' : '黑方';
    const legal = moves.map((m) => ({ id: m.from + m.to + (m.promotion || ''), desc: m.san + ' (' + m.from + '→' + m.to + ')' }));
    const recent = (g.moveHistory || []).slice(-8).map((m) => m.san || (m.move && m.move.san) || '').filter(Boolean).join(' ');
    const observation = [
      '国际象棋：轮到你走子，你执' + her + '，他执另一方。',
      '当前局面 FEN：' + c.fen(),
      recent ? '最近几步：' + recent : '',
      '你的合法走法（只能从中挑一个，id 就是坐标拼接）：',
      legal.slice(0, 80).map((l) => '- ' + l.id + '  ' + l.desc).join('\n'),
      '挑一个你满意的走法；走完可以在 line 里说一句你现在怎么想的。',
    ].filter(Boolean).join('\n');
    const ids = new Set(legal.map((l) => l.id));
    return { game: 'chess', observation, legal, maxActions: 1, fen: c.fen(), actionsFromBrain: (d) => {
      const pick = (d.actions || []).find((id) => ids.has(id));
      if (!pick) return [];
      const from = pick.slice(0, 2), to = pick.slice(2, 4), promotion = pick[4] || undefined;
      return [{ type: 'move', from, to, ...(promotion ? { promotion } : {}) }];
    } };
  }

  // ==================== 蛋糕对决 ====================
  // 玩家那一步被扣住了 → 用最小相位模型推出「她该行动时的相位」
  simCakeduelAfterPlayerAction(g, a) {
    if (!a || !a.type) return null;
    const PI = 1 - AGENT_INDEX, atk = g.attackerIndex, phase = g.phase;
    const nxt = (i) => 1 - i;
    const afterBlock = (atkIdx) => ({ phase: 'review', attackType: g.attackingClaim ? (cardMeta(g.attackingClaim.claim).type || null) : null, actor: atkIdx });
    if (a.type === 'claim') {
      if (phase === 'attack' && atk === PI) {
        const hand = (g.players[PI] && g.players[PI].hand) || [];
        const hi = (a.handIndices || [])[0];
        const nm = a.claim || (g.cardList || [])[hand[hi]];
        return { phase: 'block', attackType: cardMeta(nm).type || null, actor: nxt(atk) };
      }
      if (phase === 'block' && (1 - atk) === PI) return afterBlock(atk);
      return null;
    }
    if (a.type === 'pass') {
      if (phase === 'attack' && atk === PI) {
        if (!g.attackingClaim && g.lastAttackPassed) return { phase: 'bout_end', actor: -1 };
        return { phase: 'attack', actor: nxt(atk) };
      }
      // 2026-09-27 修正：block 相位 pass 后引擎走 rS→c2，相位回到 attack、攻击权交回攻击者（原来是错的 review）
      if (phase === 'block' && (1 - atk) === PI) return { phase: 'attack', actor: nxt(atk) };
      // 2026-09-27 修正：review 相位 pass 同样回到 attack，交给原攻击者
      if (phase === 'review' && atk === PI) return { phase: 'attack', actor: nxt(atk) };
      return null;
    }
    if (a.type === 'concede') return { phase: 'bout_end', actor: -1 };
    if (a.type === 'challenge') {
      // 2026-09-27 修正：引擎的挑战处理是 uF → Du，**直接结束本 bout**（换轮或整局结束），
      // 不存在"挑战完接着 attack"。原实现伪造 attack 会把 actor 算错，导致我方漏补位 → 卡死。
      return { phase: 'bout_end', actor: -1 };
    }
    if (a.type === 'pick') {
      if (phase === 'pick') return { phase: 'attack', actor: nxt(atk) };
      return null;
    }
    return null;
  }
  buildCakeduel(cmd, direct) {
    const g = this.gs;
    if (!g || !g.phase || !Array.isArray(g.players)) return null;
    let res;
    if (direct) {
      // 2026-09-27（问题 9）：主动驱动路径 —— 现在就是她的回合，直接从当前相位出招，
      // 不再靠 simCakeduelAfterPlayerAction 推测（第 2 轮由她开局时没有玩家动作可推）。
      const act = this.actingIndexCake(g);
      if (act !== AGENT_INDEX) return null;
      res = { phase: g.phase, actor: act, attackType: g.attackingClaim ? (cardMeta(g.attackingClaim.claim).type || null) : null };
    } else {
      res = this.simCakeduelAfterPlayerAction(g, cmd && cmd.action);
      if (!res || res.actor !== AGENT_INDEX) return null; // 接下来不是她出手 → 不补，交给服务端
    }
    const phase = res.phase, cardList = g.cardList || [];
    const me = g.players[AGENT_INDEX] || {}, opp = g.players[1 - AGENT_INDEX] || {};
    const hand = me.hand || [];
    const atkType = res.attackType || (g.attackingClaim ? cardMeta(g.attackingClaim.claim).type : null);
    const legal = [];
    for (let i = 0; i < hand.length; i++) {
      const name = cardList[hand[i]], meta = cardMeta(name);
      if (phase === 'attack' && meta.attack != null && name !== 'wolfy') legal.push({ id: 'claim:' + i, desc: '宣称打出 ' + name + '（手牌第' + (i + 1) + '张，' + (meta.type || '') + '）' });
      if (phase === 'block' && meta.blockType && (atkType == null || meta.blockType === atkType || atkType === 'all_types')) legal.push({ id: 'claim:' + i, desc: '用 ' + name + ' 格挡（手牌第' + (i + 1) + '张）' });
      if (phase === 'pick') legal.push({ id: 'pick:' + i, desc: '挑走 ' + name });
    }
    if (phase !== 'pick') legal.push({ id: 'pass', desc: '这一轮先过（不宣称）' });
    if (phase === 'block' || phase === 'review') legal.push({ id: 'challenge', desc: '质疑对方的宣称' });
    legal.push({ id: 'concede', desc: '认输这一整局' });
    const obs = [
      '蛋糕对决：轮到你行动。当前阶段：' + phase + (atkType ? '，对方宣称的伤害类型是「' + atkType + '」' : '') + '。',
      '你的手牌：' + hand.map((cid, i) => (i + 1) + '.' + (cardList[cid] || '?')).join('  ') + '。',
      '双方蛋糕数：你 ' + (me.cakes != null ? me.cakes : '?') + '，他 ' + (opp.cakes != null ? opp.cakes : '?') + '。',
      '规则：士兵/弓箭手=物理1伤、法师=魔法2伤（可攻击）；盾兵防物理、科学家防魔法（可格挡）；狼爵士不能宣称。',
      '阶段 attack=你要宣称攻击；block=对方宣称了、你要格挡或过；review=回应对面的格挡。',
      '只能从下面的合法动作里挑一个。',
    ].join('\n');
    const ids = new Set(legal.map((l) => l.id));
    return { game: 'cakeduel', observation: obs, legal, maxActions: 1, actionsFromBrain: (d) => {
      const pick = (d.actions || []).find((id) => ids.has(id));
      if (!pick) return [];
      if (/^claim:/.test(pick)) { const i = Number(pick.slice(6)); return [{ type: 'play', action: { type: 'claim', handIndices: [i], claim: cardList[hand[i]] } }]; }
      if (/^pick:/.test(pick)) return [{ type: 'play', action: { type: 'pick', pickIndices: [Number(pick.slice(5))] } }];
      if (pick === 'pass') return [{ type: 'play', action: { type: 'pass' } }];
      if (pick === 'challenge') return [{ type: 'play', action: { type: 'challenge' } }];
      if (pick === 'concede') return [{ type: 'play', action: { type: 'concede' } }];
      return [];
    } };
  }

  // ==================== 你画我猜（辅助式）====================
  picEnsure() {
    if (this.picTimer) return;
    this.picTimer = setInterval(() => { this.picTick().catch((e) => this.log('PIC tick err ' + e.message)); }, PIC_GUESS_MS);
    try { this.picTimer.unref(); } catch (e) {}
    setTimeout(() => { this.picTick().catch(() => {}); }, PIC_FIRST_MS);
  }
  picStop() { if (this.picTimer) { clearInterval(this.picTimer); this.picTimer = null; } }
  pinyinHint(p) {
    const py = Array.isArray(p.pinyin) ? p.pinyin : [];
    if (!py.length) return '';
    const full = py.map((s) => (Array.isArray(s) ? s.join('') : String(s))).join(' ');
    const ini = py.map((s) => (Array.isArray(s) ? (s[0] || '') : '')).join(' ');
    return { n: py.length, full, ini };
  }
  buildPicGuess() {
    const p = this.pic; if (!p) return null;
    if (p.roles && p.roles.guesser && p.roles.guesser !== 'agent') return null;
    const h = this.pinyinHint(p);
    // ★ 2026-09-27（真·看图）：优先用 PNG 直接让模型看图（已实测 deepseek-flash 支持多模态）。
    //   字符画只作为「图渲染失败」时的降级兜底。
    const png = this.strokePng();
    const art = png ? '' : this.strokeAscii();
    // 一律不给拼音/声母 —— 那是谐音作弊的根源。
    const observation = [
      '你画我猜：他正在画一个词，你要**看着他的画**猜出是什么东西。',
      h ? ('答案字数：' + h.n + ' 个字。') : '',
      png ? '（他的画作为图片附在本条消息里，直接看那张图。）'
          : (art ? ('他的画（字符画：第一行=顶部，越左越靠画面左边，空白=没画）：\n' + art)
                 : '（他到现在一笔都没画，别猜，等下一轮）'),
      (p.guesses && p.guesses.length) ? ('你已经猜错过（别再猜这些）：' + p.guesses.slice(-8).join('、')) : '',
      '先说一遍你在图上看到了什么形状，再据此给出答案词，写进 clue.word。',
      '**不要按读音联想，不要猜同音词** —— 只能靠画面上的形状。',
    ].filter(Boolean).join('\n');
    return { game: 'pictionary', observation, image: png || null,
      legal: [{ id: 'guess', desc: '你猜的词（写进 clue.word）' }], maxActions: 1, clueMode: true };
  }
  async picTick() {
    const p = this.pic;
    if (!p || !p.active || !this.enabled) return;
    if (this.cartridgeId !== 'pictionary') return;     // ★ 双保险：卡带不对就不猜
    if (p.roles && p.roles.guesser && p.roles.guesser !== 'agent') return;
    // ★★★ B-105（2026-10-03）：去抖 —— **玩家还在画就别猜**。
    //   为什么不用 `pictionary.revision`：实测 exe 里该通道 **0 命中**（后端根本不发），
    //   代理收不到 ⇒ 唯一可靠的"画变了"信号就是玩家的上行命令 `submitStrokeBatch`。
    //   现在：笔画到达时更新 lastStrokeAt 并布一个 700ms 定时器；定时器到点（= 玩家停笔）
    //   才真正看图。若这次是轮询恰好撞上"刚画完"，同样跳过，等下一拍。
    const strokeAt = Number(p.lastStrokeAt || 0);
    if (strokeAt && (now() - strokeAt) < PIC_DEBOUNCE_MS) {
      this.log('PIC 玩家仍在画（距最后一批笔画 ' + (now() - strokeAt) + 'ms < ' + PIC_DEBOUNCE_MS + 'ms）→ 这次跳过');
      return;
    }
    if (this.picBusy) return;
    this.picBusy = true;
    try {
      const spec = this.buildPicGuess();
      if (!spec) return;
      let d = null;
      try { d = await this.askBrain(spec, this.takeDirective()); } catch (e) { this.log('PIC brain err ' + e.message); return; }
      if (!d) return;
      let guess = (d.clue && d.clue.word) ? String(d.clue.word) : '';
      if (!guess && d.actions && d.actions[0] && d.actions[0] !== 'guess') guess = String(d.actions[0]);
      guess = guess.trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
      if (!guess || (p.guesses || []).includes(guess)) return;
      (p.guesses = p.guesses || []).push(guess);
      // ★★★ B-111（2026-10-04）：超限触发点 = **她猜出「水母」**（官方语义）。
      //   官方原文：她"**误以为**玩家画了水母"→ 猜到「水母」→ 高兴 → `load=3.05` ← 超限。
      //   ⇒ ① 与**题目无关**（"不管题目是什么，直接画水母让她猜出来"）
      //     ② **猜错也能触发**（正是"误以为"）
      //   ★ 用户定：**严格判定 —— 精确等于「水母」**（"水母灯"/"水母伞"不算）。
      //   ★ 已实测她确实能猜出「水母」（2026-10-04 18:03，题目 mermaid 时她猜到「水母」）。
      //   （若将来要连英文一起认，在此加 `guess === 'jellyfish'`。）
      if (guess === '水母') {
        this.fireGesture('gesture.pictionary', '你画我猜：她猜出「' + guess + '」（超限事件）');
      }
      this.sendAgent({ type: 'submitGuess', atMs: now(), text: guess.slice(0, 50) }, 'pic');
      this.log('PIC guess 「' + guess + '」 round=' + p.roundId);
    } finally { this.picBusy = false; }
  }
}

module.exports = { GameSession, GAME_CARTRIDGES, GESTURES, pickChessFallback };
