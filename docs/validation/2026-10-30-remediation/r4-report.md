# R4 依赖收敛实施记录

- 工作区：C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell
- 分支：codex/complete-remediation-20261030
- 实施基线 HEAD：36739a6deb32bc45bf7dcbf29635cce9c306230c（并行工作区，验证未将其他工作包未提交改动排除）
- 日期：2026-10-30，北京时间
- 模式：实施和验证；未进行代码审查、未委派、未提交或推送。

## 已实施

1. 新增 events/application-notifications.ts，移出可信窗口广播和会话/控制锁/工作台详情通知。仅向未销毁且 applicationCallers.isTrusted 的 WebContents 发送；旧 handlers 导出 re-export 兼容。
2. 新增 mcp/client-config.ts。buildMcpClientConfig 接收显式路径和可执行文件输入；运行时适配在调用时读取 Electron 路径与配置，保留 JSON、TOML、Windows 转义、ELECTRON_RUN_AS_NODE 与独立 Node 回退。
3. host-mgr/view-bridge 改依赖轻量 http-port。另抽取 mcp/session-policy.ts，避免 view-actions 为名单判定再次导入 HTTP server；保留 saved/runtime 解析排名、当前设置读取及原双身份名单语义。
4. 新增 storage/paths.ts，保留 getConfigDir 惰性缓存与目录创建；repository 兼容导出，secret-store 不再依赖综合 repository。
5. 新增 renderer/commands/doc-action-contract.ts；inventory 和 MarkdownDoc 消费该常量，doc-actions 保留 re-export，文档清单不再加载动作链。
6. 新增 scripts/check-architecture-boundaries.cjs，以 TypeScript AST 解析 import/export、type-only、别名和 require；字面量 dynamic import 单列且加入运行时环检查，计算式 dynamic import 单列为静态分析局限。检查 shared/renderer/服务边界、secret-store 反向依赖，以及全生产源码运行时强连通分量。
7. 更新现有 mocks，并补配置、通知、名单和门禁回归。HTTP 共用文件由主代理根据 tmp/remediation-r4-http.json 局部接线，未直接覆盖 HTTP/index 文件。

## 变更文件

新增：

- src/main/events/application-notifications.ts / .test.ts
- src/main/mcp/client-config.ts / .test.ts
- src/main/mcp/session-policy.ts / .test.ts
- src/main/storage/paths.ts
- src/renderer/commands/doc-action-contract.ts
- scripts/check-architecture-boundaries.cjs / .test.ts

调整：

- src/main/ipc/handlers.ts（仅通知与配置 imports/声明提取区域）
- src/main/mcp/exclusive-routes.ts / .test.ts
- src/main/plugin/host-mgr.ts、host-mgr.restart.test.ts、view-bridge.ts、view-actions.ts / .test.ts
- src/main/storage/repository.ts、secret-store.ts
- src/renderer/commands/doc-actions.ts、inventory.ts
- src/renderer/components/DocPanel/MarkdownDoc.tsx

## 实际验证

证据日志记录命令、开始/结束 ISO 时间、基线 HEAD、stdout/stderr 和退出码：

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| AST 依赖门禁 | 464 源文件，0 违规，0 运行时环（含 dynamic 字面量），0 静态环；21 个 dynamic imports 单列；退出 0 | r4-boundaries.log |
| 定向回归 | 14 文件、166 项通过；退出 0 | r4-contracts.log |
| renderer/preload/shared 类型检查 | 通过，退出 0 | r4-typecheck-renderer.log |
| node/main 类型检查 | 退出 2；当时仅并行接线中的 index flushSync 与 HTTP 未用 import/execSync/STATUS_RANK 错误；已通知各负责人。R4 自有源码/测试错误已修正 | r4-typecheck-node.log |

定向回归包括配置、通知、名单、AST 门禁、插件动作/宿主重启、exclusive routes、清单/文档动作、repository、secret-store、secret-ref 优先级和本地秘密保护。

## 待最终集成验证

- 主代理修复 HTTP/index 接线后需要重新通过整仓 typecheck；上述失败没有算作通过。
- 门禁须由 R7 在 package script/CI 中接入（已向负责人交接）。
- Session/Plugin 应用服务若出现新入口共用需求，应继续复用现有 resources/release 事实源和 deps 注入；本轮没有另造注册表或改变授权模型。Command/Observation 业务服务由 R1/R3 工作包独立实施并由主代理组合。
- 本工作包未进行 GUI、安装器或硬件验收；静态无环不等于生命周期运行验收。
