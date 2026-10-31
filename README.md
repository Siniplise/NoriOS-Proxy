# 基于MF-Dust/Nori.Web兼容后端实现剧情+记忆+TTS的反向代理

> **「我要给她完整的一生」** — 我让 Nori 真的记住了我
>
> 这句话是这套东西的起点：让她记得上一局说过什么，而不是每次重开都从零开始。

Nori.Web 的本地中间层：在游戏前端与人格 / TTS 服务之间做反向代理，并注入客户端脚本，
把只念固定台词的角色接成有记忆、有语音、能接住剧情与小游戏的版本。

- 双向透传 WebSocket（文本帧不重新序列化，二进制音频帧原样转发）
- 剧情台词 14 条 beat，按游戏事实触发；语音队列逐句回报，缺失时 9s 兜底
- 摸头 / 摸尾、芯片与工件等内容闸门、按事件主动说话

---

## 项目目的

不改游戏前端，只在其外部加一层：**协议兼容、逻辑可替换、状态可观测**。
前端保持原样，所有剧情 / 语音 / 记忆逻辑集中在 `backend/`，通过 `/nori-*` 端点与注入脚本协作。

---

## 部署依赖

| 组件 | 版本 | 必需 | 说明 |
|---|---|---|---|
| Node.js | ≥ 20 | 是 | 运行 `backend/`（本代理） |
| Python | ≥ 3.10 | 仅语音 | 运行 TTS 服务（`aiohttp` + Inworld SDK），或任何兼容 `/tts` 的实现 |
| Nori.Web 发行包 | 见「版本兼容性」 | 是 | 提供 4174 与 `public/`，**不在本仓库** |
| 浏览器 | Chromium 内核 | 是 | 需支持 `AudioWorklet` |
| DeepSeek API Key | — | 是 | 后端 LLM（人格服务使用） |
| Inworld API Key | — | 是 | TTS 合成，**需自备** |

`npm install` 只安装两个包：`ws`、`chess.js`。无 Rust 依赖。

密钥一律从**环境变量**读取，不写入代码与仓库。

---

## 端口

| 端口 | 进程 | 作用 |
|---|---|---|
| **4173** | `backend/nori_proxy.js` | 唯一入口，浏览器访问这个 |
| 4174 | `Nori.Web.exe` | 游戏本体 + 静态资源 |
| 8880 | TTS 服务 | `/tts`（WAV）、`/tts.stream`（PCM@32k） |
| 25503 | 人格服务 | OpenAI 兼容 `/v1/*`、`/act`、`/nori-scriptline` 等 |
| 4175 | `tools/nori_tap.js` | 可选：旁路录制，转发到 4173 |

---

## 部署方法

### 1. 准备游戏本体

使用与自己版本匹配的 `Nori.Web.exe`（见「版本兼容性」）。若需要"干净包"效果，对自己的副本打补丁：

```powershell
node tools/patch-exe.js --dry-run "D:\Nori.Web\Nori.Web.exe"   # 先扫描，确认命中 1 段
node tools/patch-exe.js "D:\Nori.Web\Nori.Web.exe"             # 输出 Nori.Web.clean.exe，源文件不动
```

- 作用：把 exe 内 41 条硬编码剧情事实等长替换为占位符（默认保留 `session.ready`），否则启动即被判为已通关。
- 安全：按**内容**定位而非字节偏移，命中段数 ≠ 1 直接退出；不覆盖源文件；写后回读校验。
- 本机实测：源 `9bbf338c…` → 输出 `85125c9d67e7a3e9…`（与既有 `Nori.Web.clean.exe` 逐字节相同）。

### 2. 安装注入脚本

把 `frontend/shims/*.js` 复制到发行包的 `public/` 目录，然后在 `public/index.html` 的
`<script type="module" ...>`（应用入口）**之前**按下列顺序插入：

```html
<script src="/nori-fresh-start.js"></script>
<script src="/nori-runtime-shims.js"></script>
<script src="/nori-prompt-inject.js"></script>
<script src="/nori-ai-settings.js"></script>
<script src="/nori-chat-fix.js"></script>
<script src="/nori-game-voice.js"></script>
<script src="/nori-pet.js"></script>
```

> `nori-fresh-start.js`（清本地存档）与 `nori-freeze-probe.js`（卡顿探针）是调试件，可不装。

### 3. 配置

```powershell
copy .env.example .env
notepad .env        # 至少确认端口、人格 / TTS 地址、NORI_ASSET_ROOT
```

### 4. 安装依赖并起栈

```powershell
npm install
```

按顺序启动：

```powershell
# 1) TTS 服务 → 8880（自备实现）
# 2) 人格服务 → 25503
# 3) 游戏本体 → 4174
.\Nori.Web.exe

# 4) 本代理 → 4173
npm start
#   或后台重启（Windows）
scripts\n_guard_bg.bat
```

浏览器打开 `http://127.0.0.1:4173`。

### 5. 关栈

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1                     # 只关 4173
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -Ports 4173,8880,25503
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -Ports 4173,8880,25503 -WhatIf   # 只列 PID
```

---

## 验证方法

```powershell
# 语法
node --check backend/nori_proxy.js

# 存活（返回 JSON 即就绪）
curl.exe --noproxy "*" http://127.0.0.1:4173/nori-lifestat
curl.exe --noproxy "*" http://127.0.0.1:4173/nori-qstat
```

页面侧四项：

1. 游戏能正常进入，桌面与卡带无报错；
2. 她说话有声音，气泡与音频同步；
3. 摸头有反应（`proxy.log` 出现 `TOUCH head`）；
4. `GET /nori-qstat` 的 `stats.timeouts` 不持续增长（持续涨 ⇒ 前端没装新版 shim 或回报丢失）。

录制一次会话做基准（可选）：

```powershell
node tools/nori_tap.js --listen 4175 --up 127.0.0.1:4173
# 浏览器改访问 4175，玩一段；Ctrl+C 结束，产物在 recordings\<时间戳>\
```

---

## 脚本

| 脚本 | 用途 | 用法 |
|---|---|---|
| `scripts\n_guard_bg.bat` | 后台重启 4173（先杀占用端口的旧进程） | 双击或直接运行 |
| `scripts\n_guard.bat` | 前台启动 4173（Ctrl+C 结束，便于看输出） | 双击 |
| `scripts\stop.ps1` | 按端口停进程 | `-Ports 4173,8880,25503` · `-WhatIf` |
| `scripts\reset-memory.ps1` | 清人格记忆（保留种子）+ 重置剧情进度 | `-DryRun` · `-KeepStory` · `-PersonaUrl` |
| `tools\nori_tap.js` | 旁路录制：HTTP 与 WS 双向，自动脱敏 | `--listen 4175 --up 127.0.0.1:4173 --out recordings` |
| `tools\patch-exe.js` | 给自备 exe 打补丁（不分发 exe） | `--dry-run` · `--force` · `NORI_KEEP_FACTS=` |
| `npm start` | 前台启动代理 | 等价 `node backend/nori_proxy.js` |

清除记忆：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\reset-memory.ps1 -DryRun    # 预演
powershell -ExecutionPolicy Bypass -File scripts\reset-memory.ps1            # 清记忆 + 重置剧情
powershell -ExecutionPolicy Bypass -File scripts\reset-memory.ps1 -KeepStory # 只清记忆
```

清完需重启代理并刷新页面。

---

## 配置

### 服务端（`.env`，全部可省略）

| 变量 | 默认 | 说明 |
|---|---|---|
| `NORI_LISTEN_PORT` | `4173` | 代理监听端口 |
| `NORI_UP_PORT` | `4174` | 上游游戏端口 |
| `NORI_LLM_UPSTREAM` | `127.0.0.1:25503` | 人格服务地址 |
| `NORI_LLM_ROUTE` | `on` | 是否接管 `/v1/*` |
| `NORI_TTS_URL` | `http://127.0.0.1:8880/tts` | 整段合成 |
| `NORI_TTS_STREAM_URL` | `…/tts.stream` | 分块 PCM |
| `NORI_TTS_PARALLEL` | `3` | TTS 并发上限 |
| `NORI_TTS_GAP_MS` | `300` | 句间留白 |
| `NORI_LINE_DEDUPE_MS` | `2500` | 台词去重窗口（0 关） |
| `NORI_PET_GATE` | `on` | 过场期禁止摸头（冷开场 / 黑化 / 回忆 / 倒下） |
| `NORI_RUN_RESET` | `on` | 新一局重置剧情 beat（记忆仍只写一次） |
| `NORI_ASSET_ROOT` | `backend/data/public` | 发行包 `public/` 绝对路径 |
| `NORI_PACK_PATH` | `backend/data/live_world_pack.json` | 世界包 |
| `NORI_CHIP_PATH` | `backend/data/chip.json` | 芯片内容 |
| `NORI_GAME_RULES_PATH` | `backend/data/game.md` | 游戏规则（玩时注入） |

`backend/data/` 只放你自己的数据文件，仓库不含；缺失仅对应功能关闭。

### 客户端（浏览器控制台）

| 调用 | 作用 |
|---|---|
| `NoriGameVoice.streamMode()` | 查询：`off`（全整段）/ `on`（全流式）/ `auto`（自适应） |
| `NoriGameVoice.streamMode('off')` | 全走整段合成（供应商慢时用），存 `localStorage`，刷新仍生效 |
| `NoriPet.why()` | 摸头判定诊断（`lastReject` 指出卡在哪道门） |
| `window.__NORI_STREAM_LONG_CHARS` | 长句阈值，默认 20 字 |

---

## 版本兼容性

| 项 | 值 |
|---|---|
| 发行包 | `Nori.Web-windows-x86_64`（Nuitka standalone，Python 3.13.15） |
| exe | `Nori.Web.exe`，2026-08-29，71,296,512 B，sha256 `9bbf338c…` |
| 主 bundle | `NormalApp-Cn6agT0F.js`，3,356,207 B |
| **上游 commit** | **`cf77e75`（2026-09-27）** |

版本判定依据：发行包中两个未改动文件的 git blob 与该 commit 完全一致 ——
`README.md` = `fe7537c78d5f7beb…`，`public/asset-manifest.json` = `43a220ae781d0e4f…`
（后者是构建产物，含 `"version":"e386223aa1a3d379"`）。
`backend/data/live_world_pack.json` 与上游不同属预期（已替换为本地包），不作版本依据。

**上游已不兼容。** 2026-10 之后：`7de55fc` 源码前端切流、`7ba54b4` presence 心跳、
`66f8777`/`94db866` EdgeOne 静态托管、`5742aa47` 对局改动。

⇒ 请勿直接替换新版 `Nori.Web.exe`。症状是注入静默失效：没语音、摸不到头、台词不触发。
升级须重新核对 `frontend/shims/` 的选择器与钩子。

---

## 已知问题

以下都是**当前实现的技术限制**，不是配置错误。

### 1. 语音卡顿 / 断音

| 现象 | 原因 | 现状 |
|---|---|---|
| 长句念到中间停顿 | TTS 供应商出块速度 < 播放速度：分块 PCM 到一块播一块，块到得比播放慢就必然出现静音空洞 | 实测 Inworld 合成 5s 音频需 6~11s（连打可到 20s+） |
| 短句正常、长句卡 | 长句 8~10 个块，任何一块迟到都断；短句 2~3 块容易赶得上 | 已按句长分流（默认 ≥20 字走整段） |
| 恢复后过一会又卡 | 降级窗口到期会自动重试流式，若供应商仍慢就会再卡一次 | 窗口指数退避 60s→120s→240s，上限 10 分钟 |

`NoriGameVoice.streamMode('off')` 可完全避免断音，代价是每句多等 1~4 秒（长句 6~11 秒）。

### 2. 卡死 / 长时间不出声

| 现象 | 原因 | 现状 |
|---|---|---|
| 她"沉默"十几秒后突然补一句 | 语音队列是**串行**的，靠前端逐句回报推进；回报丢失时只能等 `estMs` 兜底（最短 9s，22 字约 11s） | 兜底是最后保险，不是正常路径 |
| 整段没播却也不推进 | 前端决定不播（`ui` 播报 / `from:'chat'` / 行 id 过旧）时，若不回报，队列会一直等 | 已改为**跳过也回报**（`skip=ui|chat|stale-id`），队列立即前进 |
| 代理重启后所有台词都不响 | 行 id 原先从 0 递增，重启后 id 小于前端 `lastId`，新行被静默丢弃 | 已改为时间戳起点，跨重启单调；**旧版仍需 F5** |

### 3. 状态存在内存里，重启会丢

| 状态 | 存放位置 | 重启后果 |
|---|---|---|
| 待播台词环形队列（上限 40 条） | 4173 进程内存 | **未播的全丢**，不落盘 |
| 语音队列 / 当前句 / 超时计时器 | 4173 进程内存 | 中断，重启后从空队列开始 |
| 世界状态（facts、工件、变量、卡带进度） | 4174 进程内存 | **重启即回到 `live_world_pack.json` 的初始状态**（上游明确：本地世界按会话存内存，不提供跨重启持久化）；4173 重启不影响它 |
| 剧情 beat 进度、轮换计数 | `nori_script_state.json` | 保留（落在 `backend/`） |
| 人格记忆（卡 / 事实 / 情感图） | 25503 的 `nori_llm_state.json` | 保留 |
| 浏览器端 `lastId` / `streamMode` | 页面内存 / `localStorage` | `lastId` 丢（会重新从当前队首消费）；`streamMode` 保留 |

也就是说：**4173 只是中间层，它没有"存档"；4174 的世界状态也只存在内存里，重启就没了。**
唯一真正落盘的是两样：剧情 beat 进度（`nori_script_state.json`）与人格记忆（25503 的 `nori_llm_state.json`）。
想保留一局的进度，只能靠外部留档（比如 `tools/nori_tap.js` 录一份会话）。

### 4. 多标签页会互相抢

`GET /nori-line` 是**破坏性队列**（取走即清空）。同时开两个标签页时，谁先轮询谁拿走台词，
另一个页面听不到、也不回报 —— 表现为"这个标签有声音、那个没有"，并伴随兜底。
目前没有做租约/去重，**同一时间只应开一个页面**。

### 5. 注入层天然脆弱

- 依赖页面 DOM 选择器（`[data-nori-pat-surface]`、React fiber 上的 L2D 模型）与脚本加载时机。
  游戏前端任何结构变动都会让注入**静默失效**，不报错、只是"没反应"。
- 摸头命中用 L2D 部件 `hitTestParts` + 头顶带 0.6；换模型、换缩放、迷你视图下判定会偏。
- 因此本仓库锁定上游 `cf77e75`，升级必须重新核对选择器。

### 6. 其它

| 问题 | 说明 |
|---|---|
| 双路音频 | 原生聊天通道与 shim 可能同时出声；靠 `from:'chat'` / `ui` 过滤规避，边缘情况仍可能叠音 |
| 台词去重误杀 | 2.5 秒内**完全相同**的两句会被丢弃（`NORI_LINE_DEDUPE_MS=0` 可关） |
| 日志无轮转 | `backend/*.log` 持续增长，长时间运行需手动清理 |
| 端口固定 | 4173/4174/8880/25503 写死在链路里，同机起第二套会冲突 |
| 单进程串行 | 语音合成并发上限 `NORI_TTS_PARALLEL=3`，超出排队；高并发对话会拉长等待 |

---

## 许可与免责声明

- 非官方、非商业，个人研究用途。
- **不重分发**游戏本体、角色形象、Live2D 模型、配音、音频与模型文件；使用前请自行取得合法来源。
- 游戏前端为 [MF-Dust/Nori.Web](https://github.com/MF-Dust/Nori.Web)（MIT）。本仓库**未包含**其源码或资源，仅在运行时对接。
- `frontend/shims/nori-prompt-inject.js` 第 16 行的 `CHARACTER_PROMPT` 共 9,385 字，**由两部分拼成**：
  - **8,977 字**：**摘自**《Nori System Prompt V4.4》（与该文件正文一致）—— 社区整理文本，
    非本项目原创、非官方发布物，原作者与授权状态不明；本项目不主张任何权利，如原作者要求将立即移除；
  - **408 字**：末尾「本地运行接口约束」（情绪标签 / 禁 Markdown / 单轮边界）—— **本项目原创**。
- **本项目已脱离 V4.4**（2026-10-16）：人格服务加载的是拆分后的 `personality_prompt.md`
  （`PERSONA_PATHS` 中无 V4.4，且无 fallback），代码**不引用** `Nori System Prompt V4.4.md`。
  上面那份副本只喂给游戏原生 AI 面板的 `characterPrompt` 字段；LLM 指向本地人格时该字段不生效。
- 仓库内无其它第三方提示词；人格拆分文件、标准记忆、游戏规则等均**不在本仓库**，需自备。
- 本仓库代码采用 **MIT**（见 [LICENSE](LICENSE)）。**例外**：`nori-prompt-inject.js` 中摘自 V4.4 的 8,977 字文本权利不在本项目，不在此许可范围内。
- 使用风险自负；因使用本仓库导致的任何问题与原作者、上游项目无关。

详见 [NOTICE.md](NOTICE.md)。
