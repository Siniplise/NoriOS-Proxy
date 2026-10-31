# NoriWeb Origin

Nori.Web 的**本地中间层代理**。夹在游戏前端与人格 / TTS 服务之间，  
负责把"只会念固定台词的角色"接成有记忆、有语音、能接住剧情的版本。

> 非官方、非商业。角色与素材版权归原作者。  
> 游戏前端来自第三方开源项目 [MF-Dust/Nori.Web](https://github.com/MF-Dust/Nori.Web)（MIT），  
> **本仓库不包含也不分发它的代码与素材**，只包含我们自己的中间层与客户端注入脚本。

---

## ⚠ 版本与兼容性（重要）

本仓库的注入脚本与中间层是**针对某一个具体的 Nori.Web 构建**写的，不是通用适配层。

| 项          | 我们适配的版本                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| 发行包        | `Nori.Web-windows-x86_64`（Nuitka standalone，Python 3.13.15）                              |
| exe 构建时间   | **2026-08-29**（`Nori.Web.exe`，约 71.3 MB）                                                 |
| 主前端 bundle | **`NormalApp-Cn6agT0F.js`**（3,356,207 B，2026-09-27）                                      |
| **对应上游 commit** | **`cf77e75`（2026-09-27）** |

**这个 commit 是怎么定出来的**（不是猜的）：拿发行包里两个**未被我们改动**的文件算 git blob 哈希，与上游历史逐个比对：

| 文件 | 本地 blob | 上游 `cf77e75` 的 blob | 结果 |
|---|---|---|---|
| `README.md` | `fe7537c78d5f7beb…` | `fe7537c78d5f7beb…` | 一致 |
| `public/asset-manifest.json` | `43a220ae781d0e4f…` | `43a220ae781d0e4f…` | 一致 |

`asset-manifest.json` 是**构建产物**（含 `"version":"e386223aa1a3d379"`），它能对上，说明静态资源就是那次构建出来的；master 上的同名文件已经变了（`75541ef5…`，45,083 B）。

> 唯一对不上的是 `backend/data/live_world_pack.json`：本地 11,564,829 B，上游 11,687,582 B。
> 那是**我们后来自己替换成"干净包 / 第一天包"**造成的，属预期差异，不作为版本依据。

**上游已经往前走了，而且不兼容。** 2026-10 之后的主要变化：

- `7de55fc` 把本地启动切到**源码前端**（`frontend-src/` 重新构建），入口不再是旧的 `public/index.html`
- `7ba54b4` 新增 **presence 心跳**（`POST /api/presence`）与在线人数
- `66f8777` / `94db866` 引入 **EdgeOne 静态资源托管**与相关环境变量
- `5742aa47` 改了多人对局：对手昵称、回合计时、掉线宽限

⇒ 这些改动会动到我们依赖的**页面结构、注入时机与部分协议字段**。  
**请勿直接把新版 `Nori.Web.exe` 换进来** —— 注入脚本会静默失效（表现为：没语音、摸不到头、台词不触发）。  
要升级，需要按新版重新核对 `frontend/shims/` 里的选择器与钩子，再改中间层。

### 我们用的不是原版 exe

我们自己**打过补丁**，但**不能分发**修改后的 exe（那是别人的产物）。  
所以仓库只提供补丁脚本，让你对**你自己的合法副本**做同样的操作 —— 见下一节。

---

## 打补丁（exe 由你自己准备）

```bash
# 先扫描：确认你的 exe 是我们的版本（必须恰好命中 1 段）
node tools/patch-exe.js --dry-run "D:\Nori.Web\Nori.Web.exe"

# 正式打补丁：默认输出到同目录的 Nori.Web.clean.exe（原文件不动）
node tools/patch-exe.js "D:\Nori.Web\Nori.Web.exe"

# 想改输出名 / 多保留几条内置事实
node tools/patch-exe.js "D:\Nori.Web\Nori.Web.exe" "D:\Nori.Web\Nori.Web.patched.exe"
NORI_KEEP_FACTS=session.ready,boot.completed node tools/patch-exe.js "..."
```

**它做什么**：exe 里硬编码了 41 条剧情事实常量，启动即被判定为"已通关"，  
干净包/第一天包因此推不动。脚本把这 41 条**等长替换**成占位符（默认保留  
`session.ready`，冷开场要用），不生成、不修改任何其它内容。

**它怎么保证安全**：

- 先按**内容**定位那 41 条常量的连续区段（间隔 1~8 字节），**必须恰好命中一次**；  
  版本不对 ⇒ 直接退出，不会写出半残文件。
- 默认**不覆盖**源 exe，输出到新文件；已存在则拒绝（除非 `--force`）。
- 写后回读校验：该替换的必须是占位符，该保留的必须原样。

**版本自证**（我们这边实测）：

```
src  Nori.Web.exe        71,296,512 B  sha256 9bbf338c32acdfa9…
run  65171783..65172595  812 B
dst  Nori.Web.clean.exe  71,296,512 B  sha256 85125c9d67e7a3e9…
```

你用同一份原版跑，输出应当**逐字节相同**（sha256 一致）。不一致就说明 exe 版本不同，别硬来。

> 只对你自己的合法副本打补丁；**不要分发**打好的 exe。

---

## 它做了什么

| 能力   | 说明                                            |
| ---- | --------------------------------------------- |
| 帧中转  | WS 双向透传；文本帧不重新序列化，二进制音频帧原样过                   |
| 聊天拦截 | `/v1/*` 出口可被局部接管（固定台词），游戏回合（`json_object`）永不拦 |
| 剧情台词 | 14 条 beat，由游戏 fact 触发；一次性 / 可重复两套语义           |
| 语音编排 | 串行队列 + 逐句回报 + 9s 兜底；支持整段 WAV 与分块 PCM 两条路      |
| 摸头   | `/nori-touch` + 四类过场闸门（冷开场 / 黑化 / 回忆 / 倒下）    |
| 内容闸门 | 芯片、邮件、信号、工件等"何时可见"的规则                         |
| 主动触发 | 按游戏事件让她主动说一句（带节流与互斥）                          |

---

## 运行环境

| 组件          | 版本          | 是否必需   | 说明                                                  |
| ----------- | ----------- | ------ | --------------------------------------------------- |
| **Node.js** | ≥ 20        | 必需     | 本代理（`backend/`）；人格服务同样跑在 Node                       |
| **Python**  | ≥ 3.10      | 仅语音时需要 | TTS 服务（`aiohttp` + Inworld SDK），也可换成任意兼容 `/tts` 的实现 |
| 游戏本体        | —           | 必需     | Nori.Web 发行包（`Nori.Web.exe`），**不在本仓库**              |
| 浏览器         | Chromium 内核 | 必需     | 需支持 `AudioWorklet`（Chrome / Edge 均可）                |

无 Rust 依赖。`npm install` 只装两个包：`ws`、`chess.js`。

---

## 模型与外部服务

| 用途      | 供应商             | 说明                                       |
| ------- | --------------- | ---------------------------------------- |
| 对话 / 记忆 | **DeepSeek**    | OpenAI 兼容接口，作为后端 LLM                     |
| 语音合成    | **Inworld TTS** | **需自备 API Key**；也可换成任何返回 WAV / PCM 的 TTS |

密钥一律从**环境变量**读取，代码里不出现明文，也不写入仓库。

---

## 起栈

按顺序起四个进程（前两个取决于你自己的部署方式）：

```powershell
# 1) TTS 服务  → 8880      （自备 Inworld Key；或任意兼容 /tts 的实现）
# 2) 人格服务  → 25503     （后端 LLM = DeepSeek）
# 3) 游戏本体  → 4174
Nori.Web.exe

# 4) 本代理    → 4173
npm start
#   或（Windows，后台、只重启这一个）
scripts\n_guard_bg.bat
```

浏览器打开 `http://127.0.0.1:4173`。

验证：

```powershell
node --check backend/nori_proxy.js
curl --noproxy "*" http://127.0.0.1:4173/nori-lifestat   # 返回 JSON 即就绪
curl --noproxy "*" http://127.0.0.1:4173/nori-qstat      # 语音队列健康度
```

---

## 关栈

```powershell
# 只关代理
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1

# 关整栈（按端口杀 LISTENING 的进程）
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -Ports 4173,8880,25503

# 先看看会杀谁（只列出 PID，不执行）
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -Ports 4173,8880,25503 -WhatIf
```

> 只动**占用这些端口 LISTENING** 的进程，不按名字批量杀。

---

## 清除记忆

分两种，别搞混：

| 想清掉                             | 怎么做                          | 影响                               |
| ------------------------------- | ---------------------------- | -------------------------------- |
| **她的记忆**（记忆卡 / 事实 / 情感图 / 工作记忆） | `scripts\reset-memory.ps1`   | 人格侧 `/reset` 重建，**种子记忆自动重装**（不丢） |
| **剧情进度**（哪些 beat 说过了）           | 同上脚本的第 5 步；或 `-KeepStory` 跳过 | 台词可以重说一遍，记忆卡不会重复写                |

```powershell
# 先干跑看看
powershell -ExecutionPolicy Bypass -File scripts\reset-memory.ps1 -DryRun

# 正式清（备份 + 清记忆 + 重置剧情进度）
powershell -ExecutionPolicy Bypass -File scripts\reset-memory.ps1

# 只清记忆、保留剧情进度
powershell -ExecutionPolicy Bypass -File scripts\reset-memory.ps1 -KeepStory
```

清完**重启代理**（`scripts\n_guard_bg.bat`），再刷新页面。

---

## 脚本速查

| 脚本                         | 作用                                         | 用法                                                                                               |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `scripts\n_guard_bg.bat`   | **后台**重启 4173（先杀掉占用该端口的旧进程，再 `start /min`） | 双击，或命令行直接跑；日志在 `backend\llm_route.log` / `obs.log`                                               |
| `scripts\n_guard.bat`      | **前台**启动 4173（Ctrl+C 结束）                   | 适合调试看实时输出                                                                                        |
| `scripts\stop.ps1`         | 按端口停进程                                     | `-Ports 4173,8880,25503` · `-WhatIf`                                                             |
| `scripts\reset-memory.ps1` | 清人格记忆（保留种子）+ 重置剧情进度                        | `-DryRun` · `-KeepStory` · `-PersonaUrl`                                                         |
| `tools\nori_tap.js`        | 旁路录制器：抓一次会话做回归基准                           | `node tools/nori_tap.js --listen 4175 --up 127.0.0.1:4173`，然后浏览器改访问 4175；产物在 `recordings/<时间戳>/` |
| `tools\patch-exe.js`       | 给**你自己的** exe 打补丁（不分发 exe）                 | `--dry-run` 先扫描 · 默认输出 `Nori.Web.clean.exe` · `NORI_KEEP_FACTS=` 多保留几条                           |
| `npm start`                | 前台启动代理                                     | 等价于 `node backend/nori_proxy.js`                                                                 |

---

## 目录

```
backend/            代理本体（nori_proxy.js 为入口）与它的全部依赖模块
  nori-splicer/     帧拼接/折叠
  nori-hub/         帧分类与策略
  nori-speech/      语音队列编排
  _arch/tools/      _safeio（安全写文件）
  data/             可选数据文件（不进仓库，见该目录 README）
frontend/shims/     注入到游戏页面的 8 个脚本（摸头 / 台词语音 / 设置 / 探针 …）
tools/              nori_tap.js（录制器）· patch-exe.js（给自备 exe 打补丁）
scripts/            n_guard.bat / n_guard_bg.bat / stop.ps1 / reset-memory.ps1
```

---

## 主要端点

| 方法   | 路径                     | 用途                                        |
| ---- | ---------------------- | ----------------------------------------- |
| GET  | `/nori-line`           | 取待说话队列（**破坏性**：取走即清空）                     |
| POST | `/nori-spoken`         | 播放回报 `{qid,qpart}`；`skip` 表示主动跳过          |
| POST | `/nori-tts[?stream=1]` | 整段 WAV / 分块 PCM                           |
| POST | `/nori-touch`          | 摸头 `{part:'head'\|'tail'}`，可能返回 `blocked` |
| GET  | `/nori-lifestat`       | 生命周期快照（含 `petGate`）                       |
| GET  | `/nori-qstat`          | 语音队列健康度（`timeouts` / `stale` / `skipped`） |
| POST | `/v1/chat/completions` | LLM 出口（OpenAI 兼容）                         |

---

## 客户端开关（浏览器控制台）

```js
NoriGameVoice.streamMode()        // 'off' | 'on' | 'auto'
NoriGameVoice.streamMode('off')   // 全走整段（TTS 供应商慢时用它）
NoriGameVoice.streamMode('on')    // 全走流式
NoriPet.why()                     // 摸头判定诊断
```

`streamMode` 存在 `localStorage`，刷新后仍生效。

---

## 许可与第三方声明

- 本仓库代码的许可待定（作者保留后续选择）。
- **不重分发**游戏本体、角色素材、音频与模型；使用前请自行取得合法来源。
- 游戏前端为 [MF-Dust/Nori.Web](https://github.com/MF-Dust/Nori.Web)，遵循其 MIT 许可；  
  本仓库只在运行时与它对接，**未包含其源码或资源**。
- `frontend/shims/` 内的脚本为本项目自研，注入页面运行时生效。

### 关于内嵌的角色提示词（请先读这一段）

`frontend/shims/nori-prompt-inject.js` 第 16 行的 `CHARACTER_PROMPT` 共 **9,385 字**，由两部分组成：

| 部分 | 体量 | 来源 |
|---|---|---|
| `Nori System Prompt V4.4` 正文 | **8,977 字**（95.6%） | **社区整理文本** —— 非本项目原创、非官方发布 |
| 末尾「本地运行接口约束」6 条 | **408 字**（4.4%） | **本项目自己写的** |

**前半部分（V4.4 正文）**：由社区从公开视频与实机录屏转写整理，在 QQ 群 / GitHub 等处广泛流传，
原作者与授权状态已难以追溯。本项目只把它当作**本地运行的默认值**内嵌，方便开箱即用；
**不主张对它的任何权利**，也不代表原作者或任何官方立场。
若你是该文本的作者、希望它不在此处出现：请开 issue，我会立刻移除，改成留空模板。

**后半部分（接口约束）**：情绪标签协议（`[emotion:xxx]`）、禁用 Markdown、单轮对话边界等，
都是为了让 V4.4 能跑在这条本地链路上而追加的，**本项目原创**，可随意删改。

**除这一段之外，仓库里没有别的第三方提示词。** `backend/nori_script_lines.json`（台词表）、
`README` / `NOTICE.md`、代码注释，均为本项目自行编写。
本项目其它提示词（标准记忆、人格拆分文件、游戏规则等）**不在本仓库内**，需自备。

想换成自己的提示词：直接替换该文件第 16 行的整个 `CHARACTER_PROMPT` 字符串（改完 F5 生效）。

- 其余第三方组件与归属见 [NOTICE.md](NOTICE.md)。

