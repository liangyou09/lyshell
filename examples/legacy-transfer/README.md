# 传统文件传输插件

内置文件管理器现在只使用 SFTP。本插件独立提供退出内置管理器的 EXEC 传输能力，不参与自动回退，也不修改现有 SSH 终端或连接设置。

## 构建与安装

在 LyShell 源码根目录运行：

```powershell
node examples/legacy-transfer/build.mjs
```

在 LyShell「设置 → 插件」中选择本地 ZIP，安装 `examples/legacy-transfer/dist/legacy-transfer-1.0.0.zip`，核对并批准声明的权限后启用。安装包已包含纯 JS SSH 实现，用户机器无需 Node/npm、Python 或额外依赖；Python 仅用于远端。也可构建后通过开发目录安装 `examples/legacy-transfer`。不要从尚未构建的源码目录直接安装。

启用后左侧出现「传统文件传输」视图。端口随机分配，服务只监听本机，禁用/卸载会停止 Worker 和回环服务。重新启用后重新打开视图。没有后台定时传输。

## 使用

1. 填写 SSH 地址、端口、用户名，使用密码或本机私钥文件（二选一）；加密私钥填写口令。连接独立于 LyShell 保存的会话，不导出宿主密码或复用宿主令牌。
2. 从服务器管理员获取并核实 SSH 主机公钥 SHA256 指纹。管理员可运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`。多主机密钥服务器须提供当前协商密钥的指纹。插件强制核对指纹，不接受未知/不匹配密钥。
3. 选择上传/下载、传输方式和两端完整文件路径。本地路径为本机绝对路径；远端为 POSIX 绝对路径。只传普通文件，目录请先打包。
4. 点击开始。面板显示已传字节、上传百分比及终态。下载不知道完整大小时显示接收进度。取消会等待本地 Worker 退出后显示「已取消」。关闭面板不取消传输，重新打开可恢复状态；禁用插件会取消。

| 方式 | 远端依赖 | 说明 |
| --- | --- | --- |
| Python TCP / SSH 隧道 | Python 3（命令名 python3 或 python）、SSH direct-tcpip 转发 | 从原内置 Worker 提取的引擎。远端仅监听 127.0.0.1，使用随机单次握手，文件走加密 SSH 隧道。支持原有 shell 进入命令及 3 秒等待。 |
| Python 流 / SSH exec | Python 3、exec 通道 | 替代旧常驻 JSON/base64 Python Agent，直接通过 SSH 流传文件，无固定脚本、无端口转发。 |
| Base64 / SSH exec | POSIX shell、GNU 兼容 `base64 -d`、exec 通道 | 将原 shell Base64 传输提取为流实现，按编码边界分块，支持二进制与空文件，无需 Python。 |

没有隐式回退。某种方式不可用时任务失败，用户可处理依赖后选择另一种方式。进入命令只支持 TCP；进入容器后，SSH 隧道的 127.0.0.1 必须能到达该容器监听环境，隔离网络需用户自行配置。

上传覆盖指定远端文件；请核对路径。下载只接受 `~/Downloads/LyShell-legacy/` 下的新文件名，拒绝覆盖现有文件和路径逃逸。上传拒绝 `.ssh` 等敏感文件及指向它们的符号链接；私钥路径仅用于 SSH 认证。密码、口令和私钥内容仅留内存，不写入配置、任务状态或日志。30 分钟为任务总时限，TCP 引擎另有按文件大小计算的时限。

失败/取消可能留下部分文件，插件保留它们供检查，不谎报回滚。远端 exec/TCP 脚本的关闭依赖服务器对 SSH 断开的处理；TCP 接收端有超时和退出清理，取消不保证撤回已写字节。重试请另选本地文件名，或检查并手动清理部分文件。

## 权限与边界

清单声明 `read`（本地文件/私钥认证读取）、`execute`（远端 exec/shell）、`fileWrite`（本机下载及远端上传、运行时端口文件）、`localExecute`（Worker 执行）和 `uiControl`（注册视图）。Node 插件是受信本地代码，这些授权不是 Node 的 OS 沙箱；安装前应核对来源与代码。拒绝任一权限不会启动服务。

回环服务仅接受 `lyshell-plugin://legacy-transfer` 精确来源；握手返回内存随机凭据，后续通过 Authorization 头访问。普通网页、无来源请求、错误凭据均拒绝。`connection.js` 仅保存随机端口，不保存凭据。插件不增加宿主传输路由、MCP 工具或内置文件管理器选项。

源码位于 `src/`，构建脚本将运行时代码与依赖打包为 `main.js`、`worker.js`，并附第三方许可证。`transfer.test.ts` 与 `integration.test.ts` 覆盖校验、编码分块、服务隔离、取消及真实 SSH 传输。
