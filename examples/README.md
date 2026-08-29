# LyShell 插件示例 · Example Plugins

一组最小可跑的插件 demo，演示两种 runtime（Python / Node.js）的典型用法。
*A set of minimal, runnable plugin demos covering the two runtimes (Python / Node.js).*

### 入门模板 · Starter Templates

| demo | runtime | 生命周期 lifecycle | 看点 highlights |
|---|---|---|---|
| [my-py-plugin](./my-py-plugin) | python | oneshot | 一次性脚本：列会话 + 对首个连着会话演示读输出 / 发命令。*One-shot script: list sessions, then read output / send a command to the first connected session.* |
| [my-py-persistent-plugin](./my-py-persistent-plugin) | python | persistent | Python 长驻：每 5s 巡检会话数。*Long-running Python: polls session count every 5s.* |
| [my-node-plugin](./my-node-plugin) | node | persistent | Node 常驻：巡检 + 30s 定时器（共享 host）。*Long-running Node: polling plus a 30s timer (shared host).* |
| [my-pet-plugin](./my-pet-plugin) | node | persistent | 插件只当启动器：桌宠作为独立 MCP 客户端，像 Claude 一样经 stdio MCP 连 LyShell。*The plugin is only a launcher; the desktop pet connects to LyShell over stdio MCP as an independent MCP client, just like Claude.* |

### 多终端盲文动画（terminal art）· Multi-terminal Braille Animation

这些 demo 通过 heredoc 把 `render.py` 投递到已连接的 SSH 会话，在远端终端放盲文点阵动画。
*These demos push `render.py` through a heredoc into connected SSH sessions and play a braille dot-matrix animation in the remote terminal.*

| demo | 看点 highlights |
|---|---|
| [braille-wave](./braille-wave) | 盲文波浪动画。*Braille wave animation.* |
| [braille-punch](./braille-punch) | 第一人称 3D 出拳（透视 + 屏震 + 粒子）。*First-person 3D punch (perspective + screen shake + particles).* |
| [braille-bomb](./braille-bomb) | 多终端盲文爆炸。*Multi-terminal braille explosion.* |
| [braille-rhythm](./braille-rhythm) | 多终端盲文节奏。*Multi-terminal braille rhythm.* |
| [braille-wall](./braille-wall) | 多终端盲文墙。*Multi-terminal braille wall.* |
| [braille-zongzhu](./braille-zongzhu) | 盲文点阵角色动画（顶肩 / 运球）。*Braille dot-matrix character animation (shoulder strike / basketball).* |

## 安装 · Installation

这些 demo 是文件夹形式，用 **dev 插件**方式安装；也可以打包成 `.lyshell-plugin` zip 后走 ZIP/URL 安装。
*These demos ship as folders, installed as **dev plugins**; they can also be packaged into a `.lyshell-plugin` zip for ZIP/URL install.*

**dev 文件夹安装 · Dev-folder install：**

1. 启动 LyShell 应用。*Launch the LyShell app.*
2. 设置 → 插件 → **添加 dev 插件** → 选对应 demo 文件夹。*Settings → Plugins → **Add dev plugin** → pick the demo folder.*
3. 勾选 manifest 声明的 capability → 勾 **安装即启用** → 安装。*Tick the capabilities declared in the manifest → tick **Enable on install** → install.*
4. 查看插件日志（`[my-py-plugin]` / `[my-node-plugin]` 等前缀）。*Check the plugin log (`[my-py-plugin]` / `[my-node-plugin]` prefixes).*

**ZIP 安装 · ZIP install**：插件页 → 从 ZIP 导入 → 选 `.lyshell-plugin` / `.zip` 文件。*Plugins page → Import from ZIP → pick a `.lyshell-plugin` / `.zip` file.*
**URL 安装 · URL install**：插件页 → 从 URL 安装 → 填入 zip 下载地址。*Plugins page → Install from URL → paste the zip download URL.*

带 README 的 demo 见各自目录内的 README。*See each demo's own directory for a dedicated README.*

## 当前支持范围 · Current Scope

- ✅ `onStartup` / `*` 激活、全部 19 个 `lyshell_*` 工具（受 capability 限制）、dev 文件夹 / ZIP / URL 安装、启用 / 禁用 / 卸载。*`onStartup` / `*` activation, all 19 `lyshell_*` tools (capability-gated), dev-folder / ZIP / URL install, enable / disable / uninstall.*
- ⏳ `onCommand` / `onConnectionType` 激活事件源未接通 — 现在用 `onStartup`。*`onCommand` / `onConnectionType` activation sources not wired — use `onStartup` for now.*
- ⏳ `contributes` 声明式贡献 UI 未消费（commands 不进命令面板）。*`contributes` declarative UI not consumed (commands don't appear in the command palette).*
- ⏳ node 插件在打包版（release）中尚未充分验证 — dev 模式可跑。*Node plugins not fully verified in the packaged (release) build — they run in dev mode.*
