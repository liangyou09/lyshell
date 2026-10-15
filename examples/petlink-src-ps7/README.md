# petlink-src-ps7

点击机柜轨图标，就在主区域展开一个 **PetLink 源码目录的 PowerShell 7 终端**（`D:\workspace\claude\AIPet`）。

纯声明式插件：无 `main`、无插件宿主进程。与 `examples/lyshell-src-ps7` 同一套逻辑，差异只在 `views/config.js` 的目标目录与 `lyshell-plugin.json` / 图标。

## 安装（dev 文件夹）

1. LyShell → 左侧 **插件** → **添加 dev 插件**
2. 选本文件夹（`examples/petlink-src-ps7`）
3. 勾选能力 `read` + `sessionControl` + `uiControl`（manifest 已声明）
   - `read` — `lyshell_list_sessions` 查找已有保存会话
   - `sessionControl` — `lyshell_create_session` 建保存会话
   - `uiControl` + `sessionControl` — `openTerminal` 挂终端页签
4. 勾 **安装即启用**
5. 左侧机柜轨出现 **PetLink 源码 PS7** 图标（橙色终端标）

## 用法

| 动作 | 行为 |
| --- | --- |
| 点机柜轨图标（首次） | 面板挂载并自动展开一个 PS7 终端 |
| 点机柜轨图标（切回） | 该会话尚未开在终端里则再展开一个；已开则只提示 |
| 面板内 **打开 PS7 终端** 按钮 | 无条件再开一个终端页签 |

终端固定 `pwsh`、工作目录 `D:\workspace\claude\AIPet`。需要 PowerShell 7（`pwsh`）已安装。

## 改目标目录

只改 `views/config.js`：

```js
cwd: 'D:\\workspace\\claude\\AIPet',   // PetLink（AIPet）源码目录
shell: 'pwsh',                          // pwsh / powershell / cmd / bash …
sessionName: 'PetLink 源码 PS7',        // 保存会话名（按名复用，改名会另建）
```

改完 **禁用再启用** 该插件（dev 插件不做磁盘实时监听，启用是刷新点）。

## 行为说明

- **保存会话复用**：按 `sessionName`、本地类型、shell 和工作目录精确匹配查找；找不到才 `create_session`（`connect:false` 只落盘）。同名但类型或目标不同的会话不会被复用。应用重启后再次点击仍复用同一条。
- **runtime 克隆**：`openTerminal` 每次调用建一个新的 runtime 终端页签（与在会话面板点已保存会话同一条链路）；关掉页签不影响保存项。
- **归属回收**：会话由插件创建（`ownerPluginId`），禁用/卸载插件时会被回收。想留下手动建的同名会话请改 `sessionName` 避开。
- **`userConfirmed:true`**：由「用户点图标/点按钮」这次显式动作充当。本页是固定目标的本地启动器，不是可编排 agent，目标写死在 `config.js`，且 `create_session` 本身不接受任何凭据。
- 面板保活：首次打开后常挂载，切走仅 `display:none`；「点图标就展开终端」靠 `visibilitychange` 回到可见时再次触发。

## 文件

```
lyshell-plugin.json   清单（1 个视图 + 3 项能力）
icon.svg              机柜轨图标
views/config.js       目标目录 / shell / 会话名
views/launcher.html   面板页（内联样式；CSP 禁内联脚本）
views/launcher.js     找/建会话 + openTerminal 逻辑
```
