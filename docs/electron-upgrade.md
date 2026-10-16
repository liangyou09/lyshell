# Electron 43 升级

运行时锁定为 Electron 43.7.11（Chromium 150.0.7871.250、Node.js 24.21.0），
采用仍受支持的 43 稳定分支。Electron 44 的剪贴板重构不纳入本次迁移。
版本依据：[官方发行记录](https://releases.electronjs.org/release/v43.7.11)。

## 开发与安装

开发机使用 Node.js 22.12 或更高版本。关闭使用当前工作目录 Electron 二进制的进程后执行：

```powershell
npm ci
npm run typecheck
npm run test -- --testTimeout=15000
npm run build
```

`npm ci` 的 postinstall 与 `npm run rebuild` 先在锁定的 Electron 运行时中验证依赖官方
提供的 Node-API 预编译模块；缺失或不兼容时使用 `@electron/rebuild` 编译，失败会中断安装。
`npm run rebuild -- --force` 可显式从源码重建（Windows 需 VS C++ 工具链及 Spectre 库）。node-pty 更新为 1.1.0
（Node-API），移除旧版 NAN / ConPTY 私有构建流程。打包继续复用安装阶段生成的原生模块。

## 接口迁移

- 原生文件拖放通过宿主 preload 的 `webUtils.getPathForFile` 取得路径；文件上传和文档拖放
  不再读取 Electron 32 已移除的 `File.path`。此方法只暴露给受信任的宿主界面，未新增 IPC 通道。
- 网页与插件客体的 `console-message` 使用事件对象中的 `level`、`message`、`lineNumber`
  和 `sourceId`；仅转发 `warning` 与 `error`，保留限速与截长。
- 插件视图的崩溃恢复监听 `render-process-gone`，替换 Electron 29 已移除的 `crashed`，
  异常退出后仍可提示错误并通过重试重建客体。
- 保持 sandbox、contextIsolation、webSecurity 以及客体导航与插件权限边界。

接口依据：[Electron 迁移说明](https://www.electronjs.org/docs/latest/breaking-changes)。

## 验收范围

除类型检查、单元测试与构建外，应在新运行时验证本地 PTY 的启动/输出/退出、串口枚举、
Koffi 加载、sandboxed preload 的原生文件路径解析，以及 webview 的导航和页面样式。
OpenCode Go 的网页与 CSS 快照可用来离线复核图标尺寸，排除网络波动对样式兼容验证的影响。
最终还应检查打包后的启动与原生模块加载。

### 2026-10-16 Windows x64 验证

- 工作目录的类型检查与生产构建通过；159 个测试文件通过，1 个跳过，2285 项通过、5 项跳过。
- 全量测试曾遇到测试进程意外退出；降低并发后的完整重跑无错误。
- Electron 43.7.11 的实际运行时验证通过：PTY 输出及退出、主动关闭 PTY、串口枚举、
  Koffi 调用，以及 sandboxed preload 对原生文件输入的路径解析。
- webview 前后导航保留同一客体实例；`console-message` 事件的新字段读取正常。
- 实际连接拒绝后显示恢复提示；服务启动后重试成功。主动使插件客体崩溃后，错误提示与
  重试重建均通过；安装脚本的预编译校验、源码重建与失败退出路径有回归测试覆盖。
- 同一份 OpenCode Go 网页/CSS 快照恢复正常布局，模型图标宽度均为 28px。
- Windows 独立构建启动日志正常；打包后的 PTY、串口与 Koffi 加载和调用通过。
- 验证使用独立 userData，未修改用户连接、凭据、插件权限或正式后台配置。

Windows 的强制源码编译需要额外安装 Visual Studio Spectre 库；本机缺少该组件，
本次使用并验证了依赖官方随包提供的 Node-API 预编译模块，未降低编译安全选项。

旧实例运行时仍使用已经载入的内核；更改依赖或生成新包不会升级该进程。
独立目录验证通过后，退出旧实例并启动新构建才会生效。不要在文件锁错误后强删运行中的二进制。
