# R6 终端订阅范围实施记录

日期：2026-10-30（北京时间）。Worktree：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`。基线 HEAD：`36739a6deb32bc45bf7dcbf29635cce9c306230c`；下列验证针对实施中的未提交工作区，不代表最终集成提交。

## 改动

- `TerminalView.tsx` 将 terminal store 的两个 action 分别按 selector 订阅，将 session store 缩小为实际消费的 status、MCP lock、连接类型和主机/端口/串口展示字段，以 `useShallow` 比较这些 primitive。连接错误展示仍保留原默认值。另以 memo 保持连接信息引用稳定，不因控制锁变化重复装连接状态监听。
- 普通状态更新会保留未命中 session 引用，但 `syncSessionsFromBackend` 会重建所有 entry/config，因此不能仅按整个 session 对象选择。字段投影避免改写 store 或深比较整个配置。
- `TerminalView.search.test.tsx` 新增 1、10、30 实例的真实组件 React Profiler 回归：更新后台 session 活动/cwd、注册无关终端，以及通过真实 `syncSessionsFromBackend` 将一个后台会话改名，检查提交数不增、实例不替换、结果监听不重复；当前 session MCP 锁改变仍更新输入门控。
- 未改 xterm 创建/复用/dispose、IME 补丁、输出 ACK、控制权处理或 effect 生命周期。

## 验证

环境：Windows x64，Node v24.15.0、npm 11.12.1，复用原 checkout 的根依赖。

| 执行 | 实际结果 | 证据 |
| --- | --- | --- |
| 原始搜索测试与 proc 测试基线 | 2 文件，132 项通过，退出 0（其中搜索 14 项） | `r6-r7-baseline-extra.log` |
| 对旧广泛订阅实现运行新增 Profiler 回归 | 搜索 17 项中新增 3 项失败，14 项通过，退出 1 | `r6-selector-before.log` |
| selector 修复后运行搜索测试 | 17 项通过，退出 0 | `r6-selector.log`、`r6-r7-targeted.log` |
| 最终字段投影 + 真实后端同步、搜索/ACK/shelf 宿主集合 | 4 文件全部通过，退出 0 | `r6-selector-final.log` |
| R6/R7 拥有的 TypeScript 文件 ESLint | 退出 0；0 error、11 个 TerminalView 既有 warning | `r6-r7-lint.log` |

Profiler 观测：1/10/30 实例中，无关更新后旧实现的每个实例累计提交数均由 1 增为 3；新实现保持 1。当前 session 锁更新只有该实例继续提交。这里测量的是 jsdom 中真实组件的 React commit，不是 GPU/FPS 或真实终端绘制性能。

## 未验证

中文 IME、多屏 DPI、真实窗口分屏/页签搜索/shelf 激活、实际输入与控制权交接需要主代理人工验收；本工作者未操作 GUI。最终合并后需由主代理重复必要的全局验证并亲自审查所有改动。本工作者没有提交、推送或进行代码审查。
