# Electron 下载镜像

打包命令（`npm run pack`、`npm run dist:win` 等）由 electron-builder 自动读取根目录的
`electron-builder.env`，使用其中的 Electron 和构建工具二进制镜像。已有的同名环境变量优先，
可以在 CI 或当前终端覆盖默认地址。

`.npmrc` 只保留 npm 支持的配置。不要将 `electron_mirror` 或
`electron_builder_binaries_mirror` 写回其中；新版 npm 会对这些键及其传递到子进程的
`npm_config_*` 变量发出 Unknown config 告警。

## 首次安装依赖

Electron 自身的 npm 安装脚本不会读取 `electron-builder.env`。如果首次 `npm install`
也需要通过镜像下载 Electron，在同一个 PowerShell 窗口中执行：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm install
```

其他 shell 使用其原生的环境变量设置语法。未设置时，Electron 安装脚本使用默认下载源。
项目自定义的 `scripts/postinstall.cjs` 和原生模块编译流程保持不变。
