# LyShell 插件示例

三个最小可跑的插件 demo,演示两种 runtime 的典型用法。

| demo | runtime | 看点 |
|---|---|---|
| [my-py-plugin](./my-py-plugin) | python | **oneshot**:激活时列会话 + 对首个连着的会话演示读输出 / 发命令 |
| [my-node-plugin](./my-node-plugin) | node | **常驻**:激活时巡检 + 30s 定时器持续巡检(python 做不到) |
| [my-pet-plugin](./my-pet-plugin) | node | **路线2**:插件只当启动器,桌宠 spawn mcpServer.js 像 Claude 一样经 stdio MCP 连 LyShell,动态 tools/list |

## 安装(dev 文件夹)

1. `npm run dev` 启动 LyShell
2. 设置 -> 插件 -> **添加 dev 插件** -> 选对应 demo 文件夹
3. 勾选 manifest 声明的 capability -> 勾 **安装即启用** -> 安装
4. 看终端日志(`[my-py-plugin]` / `[my-node-plugin]`)

详见各 demo 目录内的 README。

## 当前能力边界(C4 阶段)

- ✅ `onStartup` / `*` 激活、全部 19 个 `lyshell_*` 工具(受 capability 限制)、dev 文件夹安装 / 启用 / 禁用 / 卸载
- ⏳ `onCommand` / `onConnectionType` 激活事件源未接通 -- 现在用 `onStartup`
- ⏳ `contributes` 声明式贡献 UI 未消费(commands 不进命令面板)
- ⏳ 安装来源仅 dev 文件夹(`.lyshell-plugin` zip / URL 待 C4b)
- ⏳ node 打包版 host 未 dist:win 验证 -- dev 模式可跑
