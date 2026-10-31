# NoriWeb Origin

Nori.Web 的**本地中间层代理**。夹在游戏前端（4174）与人格 / TTS 服务之间，
负责把"只会念固定台词的角色"接成有记忆、有语音、能接住剧情的版本。

> 非官方、非商业。角色与素材版权归原作者；游戏前端来自第三方开源项目
> [MF-Dust/Nori.Web](https://github.com/MF-Dust/Nori.Web)（MIT）。
> 本仓库只包含**我们自己的中间层代码与客户端注入脚本**。

---

## 它做了什么

| 能力 | 说明 |
|---|---|
| 帧中转 | WS 双向透传；文本帧不重新序列化，二进制音频帧原样过 |
| 聊天拦截 | `/v1/*` 出口可被局部接管（固定台词），游戏回合（`json_object`）永不拦 |
| 剧情台词 | 14 条 beat，由游戏 fact 触发；一次性 / 可重复两套语义 |
| 语音编排 | 串行队列 + 逐句回报 + 9s 兜底；支持整段 WAV 与分块 PCM 两条路 |
| 摸头 | `/nori-touch` + 四类过场闸门（冷开场 / 黑化 / 回忆 / 倒下） |
| 内容闸门 | 芯片、邮件、信号、工件等"何时可见"的规则 |
| 主动触发 | 按游戏事件让她主动说一句（带节流与互斥） |

---

## 目录

```
backend/            代理本体（nori_proxy.js 为入口）与它的全部依赖模块
  nori-splicer/     帧拼接/折叠
  nori-hub/         帧分类与策略
  nori-speech/      语音队列编排
  _arch/tools/      _safeio（安全写文件）
frontend/shims/     注入到游戏页面的 8 个脚本（摸头 / 台词语音 / 设置 / 探针 …）
tools/nori_tap.js   旁路录制器（抓一次会话，做回归基准）
scripts/            启动脚本
```

---

## 需要什么

- **Node.js ≥ 20**
- 一份 Nori.Web 发行包（`Nori.Web.exe`，不在本仓库）
- 一个**人格服务**（OpenAI 兼容 + `/act` `/nori-scriptline` 等端点）
- 一个 **TTS 服务**（`/tts` 返回 WAV，`/tts.stream` 返回裸 PCM@32k）

---

## 跑起来

```bash
cp .env.example .env      # 按需改端口与路径
npm install
npm start                 # 监听 4173，转发到 4174
```

启动顺序：TTS → 人格 → 游戏本体(4174) → 本代理(4173) → 浏览器访问 `127.0.0.1:4173`。

---

## 主要端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/nori-line` | 取待说话队列（**破坏性**：取走即清空） |
| POST | `/nori-spoken` | 播放回报 `{qid,qpart}`；`skip` 表示主动跳过 |
| POST | `/nori-tts[?stream=1]` | 整段 WAV / 分块 PCM |
| POST | `/nori-touch` | 摸头 `{part:'head'|'tail'}`，可能返回 `blocked` |
| GET | `/nori-lifestat` | 生命周期快照（含 `petGate`） |
| GET | `/nori-qstat` | 语音队列健康度（`timeouts` / `stale` / `skipped`） |
| POST | `/v1/chat/completions` | LLM 出口（OpenAI 兼容） |

---

## 客户端开关（控制台）

```js
NoriGameVoice.streamMode()        // 'off' | 'on' | 'auto'
NoriGameVoice.streamMode('off')   // 全走整段（TTS 供应商慢时用它）
NoriGameVoice.streamMode('on')    // 全走流式
NoriPet.why()                     // 摸头判定诊断
```

`streamMode` 存在 `localStorage`，刷新后仍生效。

---

## 密钥与隐私

- **仓库里没有任何真实密钥**：`.env`、`_local_key.txt`、`*_key.txt` 均被 `.gitignore` 排除。
- 代码只从环境变量读密钥；缺失时显式报错，不静默降级。
- `tools/nori_tap.js` 会**自动脱敏**再落盘（`authorization`/`cookie` 头丢弃，
  JSON 里的 `*key*/*token*/*secret*` 替换为 `***`）。

---

## 许可

本仓库代码的许可待定（作者保留）。第三方组件与素材遵循其各自许可。
