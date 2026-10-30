# 独立 Codex 复审与回归记录（2026-10-30）

本会话主 Codex 亲自审查了基线 36739a6deb32bc45bf7dcbf29635cce9c306230c 至交接 HEAD 092162f22e1e4e92686b3244f3ed8b057730659e 的全部生产代码差异、受影响测试与构建/验证脚本，并亲自修复、复审后续差异。当前没有已确认且未处理的可操作代码问题。此结论不覆盖下述尚未实测的平台与设备边界。

工作树固定为 C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell，分支 codex/complete-remediation-20261030。初始工作树干净。绑定工具因旧会话所有权拒绝绑定，所有写入和验证均显式使用该路径；原目录的用户改动未修改、暂存或提交。部分只读审查通过共享 Git 对象库读取固定提交，没有用原目录工作区源码代替修复分支。

## 确认并修复的问题

| 问题 | 原行为与修复 | 回归证据 |
| --- | --- | --- |
| P1 输入取消晚于参数检查时仍可派发 | sendAndWait 无 pattern 时忽略预取消；控制权/输入队列 await 后、分片之间也未复核 signal。现在在入口、控制权复核及每片派发前检查取消；已发送部分仍返回 OUTCOME_UNKNOWN / reconcile-first | 新增 4 项回归，修复前全部失败；修复后所在两文件共 47 项通过 |
| P1 致命诊断泄漏结构化凭据 | 带引号的 JSON 键、转义值、Basic 凭据，以及截断在带空格引号值内部的文本没有完整脱敏。现在整体处理这些形态，同时保持先限长再脱敏 | 新增 2 项回归，修复前全部失败；修复后 47 项通过，真实致命退出用例保留 |
| P2 旧截图回包在新导航后仍返回图片 | renderer 忽略旧 snapshot 却仍返回对应旧 image。现在拒绝低于当前 revision 的 capture 回包 | 新增 1 项回归修复前失败，修复后浏览器宿主 5 文件 30 项通过 |
| P2 隔离测试看门狗在 POSIX 调用 taskkill | 原看门狗无平台分支，也未处理终止工具错误。现在 POSIX 使用本次独立进程组，Windows 使用 taskkill 并观察错误；退出未确认会有界失败 | 新增真实挂起探针回归；本机匹配池/隔离测试 23 项通过。POSIX 路径尚未在本机实跑 |

POSIX 根进程结束但后台组仍存活时保留 unconfirmed 的既有保守策略未改；未通过归还未关闭资源的名额来使测试通过。F01–F08、输入 fence/generation、未知结果不重放、renderer sandbox/contextIsolation 与秘密存储保护均保留。所有审查及视觉判断由本会话主 Codex 完成；验证代理和 LyShell 原生 Harness 只执行测试/构建并提供证据。

## 最终验证

全部 7 个源码/测试文件的差异 SHA256 为 55a9ac064b8c20b0e70f15612ced054cae6502573576f70bc3d15ff0b909a27b；稳定全量、最终构建和真实运行烟测使用同一差异。精确命令、时间、退出码与源码文件 SHA256 见 [元数据](codex-review-results.json)。

| 检查 | 实际结果 |
| --- | --- |
| 根 Vitest（默认 timeout，max/minWorkers=1） | 430 文件通过、1 文件既有跳过；5481 项通过、8 项既有跳过，退出 0 |
| 本次 7 文件 ESLint | 退出 0，无错误或警告 |
| Renderer / Main 类型检查 | 均退出 0 |
| 架构门禁 | 488 源文件，0 违反、0 运行时/静态循环 |
| Node 测试 / 独立 Web SSH | 25 / 22 项通过；Web SSH 类型检查通过；这些相关源文件后续未改 |
| 最终构建 | 退出 0，main/preload/renderer 共 87 个产物；原生任务的同一 backend/session/task/attempt 权威 completed 已核实 |
| Electron 43.7.11 / ABI 148 | PTY、serialport、Koffi 实际加载通过 |
| Windows Job | 中文双流与真实退出码 7；超时后根/子/孙 PID 均确认消失；预取消无副作用 marker |
| 真实应用与 Worker | renderer sandbox/contextIsolation 保持，可信 preload 可用；字面/非法模式及高回溯中断、心跳、正常退出通过，0 未确认清理步骤 |
| 只读原生浏览器 | 导航、捕获、detach/destroy 通过，主 Codex 已看图；正常退出 0，0 未确认步骤 |

原始本地日志保存在该工作树 tmp/codex-review-validation/：before-fix-regressions、after-fix-regressions、before-fix-browser、after-fix-browser、stable-*、harness-final-build 与各 *-smoke。它们不随本次提交保存；必要的结果元数据已收录到上面的 JSON。

两轮不能作为最终通过证据的运行均保留：初次并发 2 的测试进程以 Windows 原生 0xC0000409 退出，无完整总结；下一轮跨越截图回归新增与实现修复的时间窗，得到 5480 通过 / 1 失败 / 8 跳过。未隐藏失败、删除测试、放宽断言或加长全局 timeout；代码稳定后的完整重跑才作为最终依据。最初原生崩溃尚未确定唯一原因。

## 交付边界

跨平台 CI、正式安装器安装/升级、物理串口/真实网络、IME/DPI/覆盖层与长时混合压力仍未实测；详见 [剩余验收](remaining.md)。本次没有重做正式安装包；先前实际 asar 烟测属于历史交接证据，本次新证据来自最终构建目录。对照 webview 仍被既有附着安全策略阻断，内存比较未完成，不据此声称内存收益。

推送目标在提交前再次核实：lyshell 的 fetch/push URL 均为 https://github.com/liangyou09/lyshell.git，仅推送 codex/complete-remediation-20261030 分支；不推 main、不 force、不改 remote URL。本报告和修复同一提交，提交与推送后的本地/远端 SHA 一致性由本会话最终回执记录。
