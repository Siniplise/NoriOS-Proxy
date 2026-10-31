# backend/data —— 可选数据文件（不进仓库）

这些文件属于**游戏 / 人格侧的数据**，不随本仓库分发。缺哪个，就只是少了对应功能，
启动时会有一行 `ENOENT` 日志提示路径 —— 不是崩溃。

| 文件 | 被谁用 | 少了会怎样 |
|---|---|---|
| `live_world_pack.json` | `nori_proxy.js`（工件事实 / 文件元数据）、`nori-chip-content.js` | 工件的读写事实、芯片内容拿不到 |
| `chip.json` | `nori-chip-content.js` | 芯片内容通道为空 |
| `game.md` | `nori-lifecycle.js` | 玩游戏时不会把规则带进人格上下文 |
| `public/`（目录） | `nori_proxy.js` | 附件/文件大小校正关闭（`/webAssets` 资源取不到） |

也可以不用这个目录，直接用环境变量指到别处：

```
NORI_PACK_PATH=...
NORI_CHIP_PATH=...
NORI_GAME_RULES_PATH=...
NORI_ASSET_ROOT=...
```
