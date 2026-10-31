# NOTICE

本文件列出本仓库使用的第三方组件与其归属。仓库**不包含**游戏本体、角色素材、音频与模型。

---

## 1. 游戏前端 —— MF-Dust/Nori.Web

- 项目：**Nori.Web**（本地兼容后端与前端资源）
- 仓库：https://github.com/MF-Dust/Nori.Web
- 许可：**MIT**
- 使用方式：本仓库**在运行时与之对接**（HTTP / WebSocket），**未复制其源码或资源**。
- 版本说明：本项目适配其 commit `cf77e75`（2026-09-27）的构建产物，见 README「版本与兼容性」。

> 上游后续版本改动较大（源码前端切流、presence 心跳、EdgeOne 托管、对局逻辑），
> 与本仓库的注入点不兼容；如需升级请自行核对。

---

## 2. 角色提示词 —— `Nori System Prompt V4.4`

- 位置：`frontend/shims/nori-prompt-inject.js` 中的 `CHARACTER_PROMPT` 常量（约 1 万字）
- 性质：**社区整理文本**，非本项目原创，非官方发布物。来源为公开视频/实机录屏的转写与整理，
  在 QQ 群、GitHub 等渠道广泛流传，原始作者与授权状态不明。
- 本项目立场：仅作为**本地运行的默认示例**内嵌，**不主张任何权利**，不代表原作者或官方立场。
- 移除请求：如原作者要求，请开 issue，将立即删除该文本，并改为从外部读取
  （`window.NORI_CHARACTER_PROMPT`）。

---

## 3. 依赖库

| 组件 | 许可 | 用途 |
|---|---|---|
| [ws](https://github.com/websockets/ws) | MIT | WebSocket 代理 |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-2-Clause | 国际象棋规则 |

（`npm install` 只会安装这两个包，见 `package.json`。）

---

## 4. 外部服务（不在本仓库内）

| 服务 | 用途 | 说明 |
|---|---|---|
| DeepSeek API | 对话 / 记忆 | 通过环境变量提供密钥 |
| Inworld TTS | 语音合成 | 通过环境变量提供密钥，需自备 |

---

## 5. 不包含的内容

- Nori 角色形象、Live2D 模型、配音、游戏内素材
- Nori.Web 的可执行文件（`Nori.Web.exe`）及其打包内容
- 任何真实 API Key

若你分发基于本仓库的构建，请自行确保上述内容的使用符合其原始许可。
