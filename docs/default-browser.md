# 默认浏览器注册

LyShell 可以在 Windows 上注册为 HTTP/HTTPS 的候选默认浏览器，但**不会**修改
`UserChoice`，也不会在启动时自动抢占默认应用。最终是否设为默认，始终由用户在
Windows 设置中确认。

## 入口

- 安装版：安装完成后即写入注册项，无需打开应用。
- 便携版：打开 LyShell 的 **设置 → 浏览器 → 基础 → 默认浏览器**，点击
  “设为默认浏览器”后才会注册；随后自动打开 Windows 的默认应用设置页。
- 开发模式（未打包）不显示可注册状态，点击也会被拒绝，不会写入 `electron.exe`。

`ms-settings:defaultapps?registeredAppUser=LyShell` 只会打开设置页并定位到
LyShell；选择动作必须由用户自己完成，应用不会代替用户点击。

> 不同 Windows 版本的设置层级略有差异：Windows 11 通常为“设置 → 应用 →
> 默认应用 → LyShell”，Windows 10 为“设置 → 应用 → 默认应用 → Web 浏览器”。

## 注册内容

所有写入都在当前用户 `HKCU` 下，安装器与便携版使用同一组位置：

| 位置 | 作用 |
| --- | --- |
| `HKCU\Software\RegisteredApplications\LyShell` | 让 LyShell 出现在“默认应用”列表，值为相对 HKCU 的 `Software\Clients\StartMenuInternet\LyShell\Capabilities`（不带 `HKCU\` 前缀） |
| `HKCU\Software\Clients\StartMenuInternet\LyShell` | 客户端显示名、图标与启动命令 |
| `...\StartMenuInternet\LyShell\DefaultIcon`、`...\Classes\LyShellURL\DefaultIcon` | 两个 **DefaultIcon 子键的默认值**，形如 `"<LyShell.exe>",0`；父键上名为 `DefaultIcon` 的值不会被系统读取 |
| `...\LyShell\Capabilities` | `ApplicationName` / `ApplicationDescription` / `ApplicationIcon` |
| `...\Capabilities\URLAssociations\http`、`https` | 都指向 `LyShellURL` |
| `HKCU\Software\Classes\LyShellURL` | 仅声明 URL 协议的 ProgID（`URL Protocol` 为空值） |
| `...\LyShellURL\shell\open\command` | `"<LyShell.exe>" --open-url "%1"` |

约束：

- 只注册 HTTP/HTTPS，不声明 `.html` 等本地文件类型，也不写
  `FileAssociations`，因此 LyShell 不会出现在“按文件类型选择应用”中。
- 不写 `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\*\UserChoice`。
- 安装器以当前用户身份写入（即使选择全用户安装，默认浏览器注册仍在 `HKCU`，
  因为 UserChoice 本身是按用户保存的）。
- 命令中的可执行文件路径整体加引号，因此带空格或中文的安装路径也能正确启动；
  URL 通过专用参数 `--open-url` 传入，与资源管理器菜单的 `--open-directory` 区分。
- 写入通过无 shell 的 `execFile` 调用 `reg.exe`，隐藏窗口并设置 5 秒超时，路径中的
  `&`、`|` 等字符不会被命令解释器解析；Node 以 UTF-16 传递参数，中文路径不会丢失。
- 读取改用 WinAPI `RegGetValueW`（koffi 绑定 `advapi32.dll`），因为 `reg.exe` 的
  输出是控制台代码页（中文系统为 CP936），按 UTF-8 解码会破坏中文路径。缺失的键或
  值返回 `null`；拒绝访问、类型不是 `REG_SZ`、其它 Win32 错误都会抛出，不会被伪装成
  “尚未注册”。koffi/advapi32 只在真正需要读取时加载。

## 默认状态判定

`getDefaultBrowserStatus()` 返回 `DefaultBrowserStatus`：

| 字段 | 含义 |
| --- | --- |
| `supported` | 仅 Windows 为 `true` |
| `registered` | 当前安装路径已完成 HTTP/HTTPS 注册 |
| `isDefault` | HTTP 与 HTTPS 的 `UserChoice` 都指向 `LyShellURL`，且注册命令属于当前路径 |
| `canRegister` | Windows 且 `app.isPackaged` |

开发模式（未打包）下 `getStatus()` 不读取系统注册表，直接返回
`supported: true, registered: false, isDefault: false, canRegister: false`，
避免权限或注册表异常掩盖“开发版不可注册”的说明。

判定会同时读取 `UserChoice\http` 和 `UserChoice\https`（只读），并核对
`LyShellURL\shell\open\command` 指向当前实例的启动文件。仅凭 ProgID 存在会被
视为“未注册/未默认”，避免重装或换路径后错误显示“已是默认浏览器”。
说明、图标、客户端命令等注册项缺失，以及打开命令丢失 URL 参数时，也会提示重新注册。

系统传入的 HTTP/HTTPS 链接会在新网页标签中打开，覆盖首次启动与已运行时的二次启动。
首次启动先排队，界面与隐私配置就绪后认领；只接受完整网页地址，不接受文件协议、脚本或带用户名密码的地址。
设置页从 Windows 返回时会重新检测，打开系统设置本身不会被当作已设为默认。

`requestDefaultBrowser()` 的写入是串行的：并发点击不会交叉写入；写入顺序为
ProgID/客户端/能力项在前，`RegisteredApplications` 在最后，Windows 的默认应用
列表不会看到能力项缺失的半成品。若当前路径已经完整注册，则跳过重写，但仍会打开
设置页让用户完成选择。

便携版的“当前路径”取 `PORTABLE_EXECUTABLE_FILE`（electron-builder 便携包装器
设置），因此注册的是便携 EXE 本身，而不是解压后的临时目录。

## 生效时机

- 安装或重新打包安装后，重新打开“设置 → 应用 → 默认应用”即可看到 LyShell。
- 便携版移动目录后，旧的注册仍指向旧路径，需要在新位置重新点击“设为默认浏览器”。
- 已设为默认后，Windows 可能仍显示旧的“推荐”状态；以 `UserChoice` 为准，
  可在设置页重新选择一次。

## 卸载与升级

卸载安装版时会先核对 `LyShellURL` 与 `StartMenuInternet\LyShell` 的启动命令：

- 仍指向本次安装目录：删除 LyShell 的 ProgID、StartMenuInternet 客户端以及
  `RegisteredApplications\LyShell`。
- 已被便携版改写到其它路径：保留全部注册，不误删便携版。

升级安装会在 `customInstall` 中重写同一组值，因此升级后无需再次点击按钮。
`docs` 中的入口与 `tmp/` 下的验证脚本不属于运行时依赖。

## 相关代码

- `src/shared/default-browser.ts`：状态接口与共享常量。
- `src/main/browser/default-browser.ts`：注册、状态判定、设置页跳转。
- `scripts/installer.nsh`：安装/卸载宏。
- `scripts/default-browser.test.ts`：安装器契约测试。

## 已知限制

- Windows 不会为第三方应用自动切换默认浏览器；即使注册成功，也必须由用户在
  设置页选择。
- 老版本 Windows 10 可能忽略 `registeredAppUser` 参数，只打开默认应用首页。
- 同一台机器上安装版与便携版共用同一个注册名，最后注册的一方生效；卸载会按
  命令路径保护另一方。
