# 修复基线（2026-10-30，北京时间）

- 方案基线：a1800aeb77adfb90532007c7b282b9439c5f8d67。
- 实施基线：36739a6deb32bc45bf7dcbf29635cce9c306230c，main 的后续任务回收站提交。相关差异仅 index 退出回收接线及 shelf 仓储/测试；不回退。
- 分支：codex/complete-remediation-20261030。
- 独立 worktree：C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell。主目录未提交修改未复制。只复制方案文档。
- Windows 10.0.26200 x64；Node v24.15.0；npm 11.12.1；Electron package 固定 43.7.11。
- node_modules 通过 junction 复用主目录现有依赖，未执行 npm ci 或修改主目录依赖。原生 ABI 需要实际 Electron 探针确认。
- 方案中的 Linux 旧失败为历史资料，本轮测试由实际日志记录，不能复用旧通过数字。
- LyShell backend instance 71e667d7-28fd-4219-9d74-aa1e2c851a6d / 1793340384493，R1/R2/R3 使用三条独立新会话，任务记录只在本机控制目录中，凭据不写任务或日志。
