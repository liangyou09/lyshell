# 本地 Web SSH 插件

在本机启动网页 SSH 网关，从 LyShell 网页页签或普通浏览器连接服务器。插件使用真实 SSH 交互 shell，支持 ANSI / vim / top、终端尺寸调整、密码或私钥认证。

## 安装与打开

1. LyShell → 设置 → 插件 → 从 ZIP 导入，选择 `dist/web-ssh-0.1.0.zip`。
2. 授予 `uiControl`，启用插件。
3. 点击侧栏 **Web SSH**，再点「打开网页终端」。输入服务器、端口、用户名及认证信息。
4. 通过可信渠道核对服务器 SHA256 指纹，一致时点击「一致，继续连接」。只信任本次连接，不自动保存信任。

`uiControl` 用于注册入口并打开网页；SSH 网关运行在 Node 插件自身，不读取 LyShell 已保存的密码或 MCP 凭据。服务监听 `0.0.0.0` 随机端口，即全部 IPv4 网卡。本机使用侧栏显示的 `http://127.0.0.1:端口`；其他设备使用 `http://运行插件的电脑IP:端口`，并确保防火墙允许访问该端口。允许的访问地址在服务启动时取自本机网卡，网卡地址变化后需重新启用插件。

当前网页通道使用 HTTP，跨设备访问时凭据会经网络传输，请在可信网络中使用。

在 LyShell 网页中，可展开底部「网页终端」，点选并绑定 xterm 终端后载入已有快捷命令或脚本。插件网页自身也提供「命令 / 脚本输入」，支持保留缩进的逐行执行、行间隔和停止后续行。

## 独立启动

解压 ZIP 后，在该目录运行（Node.js 22.12 或更高版本）：

```powershell
node standalone.js
```

终端会打印 `http://127.0.0.1:随机端口` 和监听地址；局域网设备将地址中的 `127.0.0.1` 换成运行服务的电脑 IP。按 Ctrl+C 停止，并回收 SSH 连接。ZIP 已包含 JavaScript 依赖，不需要额外安装包。

## 从源码打包

在 LyShell 仓库根目录运行：

```powershell
npm --prefix examples/web-ssh ci --ignore-scripts
node examples/web-ssh/build.mjs
```

输出为 `examples/web-ssh/dist/web-ssh-0.1.0.zip`。仓库根目录需要已安装自身开发依赖（esbuild、adm-zip、xterm）。也可在构建后从插件页添加 dev 插件，选择 `examples/web-ssh` 文件夹。

## 断线与输入

- 网页通道断线时 SSH 最多保留 60 秒；在相同浏览器会话中按输出序号恢复。输出缓存最多 1 MiB，丢失的旧输出会明确提示。
- 不排队或重放断线期间的输入。恢复后先检查终端状态，避免重复执行。
- 同一 SSH 连接重新交换密钥时，仅沿用本次已确认的同一指纹；主机密钥变化立即停止连接。
- SSH 写入积压超过 1 MiB 时停止连接，防止远端不再读取时输入持续占用内存。已发送的内容仍可能执行，重新连接前请检查远端状态，避免重复发送。
- 逐行执行只控制输入间隔，不等待每条命令结束。「停止后续行」不能撤回已发送的命令；需要停止远端进程时在终端操作。
- 认证信息不保存到磁盘、URL 或日志。刷新页面可以恢复仍存活的同浏览器会话；关闭/禁用插件会关闭网关及其 SSH 连接。
- 使用密码及 UTF-8 文本私钥文件，支持私钥口令。不接入本机 SSH agent、堡垒机多跳或 SSH keyboard-interactive / 二次验证。

## 验证

```powershell
npm --prefix examples/web-ssh run typecheck
npx tsc -p examples/web-ssh/web/tsconfig.json
npx vitest run examples/web-ssh/server.test.ts
```

测试采用本地隔离 SSH fixture，不连接用户的真实服务器。第三方依赖许可包含在 ZIP 的 `THIRD_PARTY_LICENSES.txt`。
