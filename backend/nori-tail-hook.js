'use strict';
/* nori-tail-hook.js —— 「摸尾巴（对话触发）」的**唯一判据**（2026-10-16 放宽版）
 * =====================================================================
 * 为什么单独成文件：判据一旦在「代理」和「测试」里各写一遍，就会出现
 *   **测试过了、线上跑的是旧的**（本项目已有前车之鉴）⇒ 抽成模块，两边 `require` 同一份。
 *
 * ── 旧判据为什么不够（实测，19:46–19:48 三句一条都没命中）──────────────
 *   旧：/摸.{0,6}尾巴|尾巴.{0,6}摸|揉.{0,6}尾巴/
 *       ⇒ 要求「摸」与「尾巴」**同一句**且相隔 ≤6 字。
 *   ①「你的尾巴....感觉像光纤的接口」 只有"尾巴"
 *   ②「可以摸摸吗」                   只有"摸"
 *   ③「摸起来好软，感觉确实很脆弱。」  只有"摸"
 *   ⇒ 真实对话是**多轮**的：先点出"尾巴"，后面用"摸/软/接口"承接。
 *
 * ── 新判据（话题窗口）────────────────────────────────────────────────
 *   A. 本句含「尾巴」                          ⇒ 命中（原因：明说尾巴）
 *   B. 本句含**触摸动词** + 最近 5 轮「用户」消息里有「尾巴」 ⇒ 命中（原因：承接尾巴话题）
 *   C. 本句明显在说**头**（摸头/头发/脑袋…）    ⇒ **让路**（不按摸尾巴处理）
 *   ⚠ 原有两道排除**保留**：游戏回合（`response_format.type==='json_object'`）与游戏标记
 *     —— 拦了会让游戏拿到台词而不是动作 JSON，直接坏掉。
 *   ⚠ 「尾巴」单现的**残余风险**：玩家问"鱼有尾巴吗"也会命中。这是放宽**有意**接受的代价；
 *     要收紧只需把 `TAIL_TOPIC_RE` 改窄，或给 A 加前置条件（本文件的常量是唯一开关）。
 *
 * ── 只看**用户**消息做窗口 ───────────────────────────────────────────
 *   不把 assistant 消息算进去：她自己的固定台词里就有"尾巴？那是Nori的数据线…"，
 *   算进去会导致之后**任何**带"摸"的话都被反复命中。
 */

/* ① 尾巴话题词（放宽的开关就在这一行） */
const TAIL_TOPIC_RE = /尾巴/;

/* ★★ 2026-10-18：判据 A 的**长文守卫**
 *   事故（用户实测）：96 字的剧情叙述「…把她的每一块模块拆除…包括…她那条尾巴…」
 *   只在结尾顺带提到"尾巴" ⇒ 判据 A 直接命中 ⇒ **整段回复被替换成固定 3 句**
 *   （日志 `LLMROUTE ★★固定回应 why=pet-tail(明说尾巴)`），用户真正想说的内容没人回答。
 *   修法：A 拆成两种"确实在说这件事"的情形 ——
 *     · 尾巴与触摸动词**近邻**（同一句、≤8 字）⇒ 命中；
 *     · 或者整句**够短**（≤ SHORT_MSG_MAX）⇒ 命中（"你的尾巴像光纤接口"这种）。
 *   长文里只是路过提到"尾巴" ⇒ 不再拦截，交给 LLM 正常回答。 */
const TAIL_NEAR_TOUCH_RE = /(?:摸|揉|碰|搓|抚|触|戳|捏|拉|拽|扯)[^。！？\n]{0,8}尾巴|尾巴[^。！？\n]{0,8}(?:摸|揉|碰|搓|抚|触|戳|捏|拉|拽|扯)/;
const SHORT_MSG_MAX = 24;

/* ② 触摸动词 */
const TAIL_TOUCH_RE = /摸|揉|碰|搓|抚|触|戳|捏|拉|拽|扯/;

/* ③ 明显在说"头" ⇒ 让路（摸头有自己的手势通道，不该走这条）
 *   ⚠ 不能只写 `/摸头/` —— 实测「摸**摸你的**头」字面**不含**"摸头"（中间夹字）⇒ 漏判。
 *   所以写成"触摸动词 ⇄ 头"的双向近邻式。 */
const HEAD_TOPIC_RE = /头发|脑袋|脑壳|头顶|(?:摸|揉|碰|搓|抚|戳|捏).{0,3}头|头.{0,3}(?:摸|揉|碰|搓|抚|戳|捏)/;

/* ④ 往前看几轮「用户」消息 */
const CTX_TURNS = 5;

/* 游戏回合 / 游戏标记 —— 绝不能拦 */
function isGameTurn(text, bodyObj) {
  if (bodyObj && bodyObj.response_format && bodyObj.response_format.type === 'json_object') return true;
  if (/【游戏】|【当前局面】|【你可以做的合法动作/.test(String(text || ''))) return true;
  return false;
}

/* 最近 CTX_TURNS 轮**用户**消息里有没有提过"尾巴"（含本句） */
function recentUserTailTopic(messages) {
  if (!Array.isArray(messages)) return false;
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && n < CTX_TURNS; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    n++;
    if (TAIL_TOPIC_RE.test(m.content)) return true;
  }
  return false;
}

/* ★ 判据入口：命中返回**原因字符串**，未命中返回 null */
function reason(text, bodyObj) {
  text = String(text || '');
  if (!text) return null;
  if (isGameTurn(text, bodyObj)) return null;          // 游戏回合 ⇒ 绝不拦
  if (TAIL_TOPIC_RE.test(text)) {                      // A（含长文守卫）
    if (TAIL_NEAR_TOUCH_RE.test(text)) return '明说尾巴';
    if (text.replace(/\s+/g, '').length <= SHORT_MSG_MAX) return '明说尾巴';
    /* ★ 长文里只是提到"尾巴" ⇒ 不拦，继续往下判（通常在 C 或 B 处返回 null） */
  }
  if (HEAD_TOPIC_RE.test(text)) return null;           // C：在说头 ⇒ 让路
  if (!TAIL_TOUCH_RE.test(text)) return null;          // 没有触摸动作 ⇒ 不拦
  return recentUserTailTopic(bodyObj && bodyObj.messages) ? '承接尾巴话题' : null;   // B
}

module.exports = { reason, isGameTurn, recentUserTailTopic,
                   TAIL_TOPIC_RE, TAIL_TOUCH_RE, TAIL_NEAR_TOUCH_RE, SHORT_MSG_MAX, HEAD_TOPIC_RE, CTX_TURNS };
