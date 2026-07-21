# NovaShell

智能终端软件 - SSH/Telnet/串口连接 + Python脚本 + AI辅助

## 技术栈

- Electron 28
- TypeScript 5
- React 18
- TailwindCSS
- xterm.js (终端)
- node-pty (伪终端)
- ssh2 (SSH)
- serialport (串口)

## 开发

```bash
# 安装依赖（需 node 18/20 LTS：node-pty 1.0.0 在 node 24 下无法编译，
# postinstall 仅在 18/20 上重编原生模块，其他版本自动跳过但没有可用二进制）
npm install

# 编译原生模块（仅 node 18/20 LTS）
npm run rebuild

# 开发模式
npm run dev
```

## 构建

```bash
# 类型检查
npm run typecheck

# 构建
npm run build

# 打包 Windows
npm run dist:win

# 打包 macOS
npm run dist:mac

# 打包 Linux
npm run dist:linux
```

## 目录结构

```
src/
├── main/          # 主进程
├── preload/       # 预加载脚本
├── renderer/      # 渲染进程 (React)
└── shared/        # 共享代码
```

## 功能特性

- SSH/Telnet/串口连接
- 多标签页终端
- 浮窗快速连接
- 快速命令执行
- Python脚本集成
- AI辅助 (规划中)