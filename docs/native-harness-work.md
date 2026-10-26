# LyShell 原生 Harness 对外工作接口

LyShell 可以直接接收外部任务，使用官方 DeepSeek Harness 执行，不依赖 PetLink。HTTP 和 MCP 共用同一实现、会话和任务状态。模型、工具执行和权限策略仍由官方 dsh 持有。

## 接入与授权

- HTTP：沿用 LyShell 的随机回环端口，`x-lyshell-token` 鉴权。
- `GET /api/harness/work/state`：读取当前凭据的状态，不启动后台。支持 `?sessionId=...&taskId=...` 精确定位；未知/重复查询参数返回 400。
- `POST /api/harness/work/request`：JSON 请求，见下表。
- MCP：使用现有 `mcpServer.js` 接入，新增工具 `lyshell_harness_work`，参数与 POST 完全一致。配置见 [MCP 指南](mcp-config.md)。

在 LyShell 内启动的 Agent 可以沿用注入的 `LYSHELL_MCP_PORT` / `LYSHELL_MCP_TOKEN`。外部程序需要开启现有“允许外部 MCP 客户端”，通过端口文件获取连接包；读操作要求 `allowRead`，变更同时要求 `allowLocalExecute` 和 `allowFileWrite`。`requireConfirmation` 开启时变更沿用现有确认弹窗。开关在每次请求、后台启动后和响应返回前复查；默认不扩大外部权限。

只接受 global/session 凭据。包括 `aipet` 在内的插件 host/UI 凭据以及 dshBridge 凭据都不能进入原生通道。浏览器 Origin 与预检沿用本机 API 的拒绝策略。不要把 token、后台登录 URL 或 host key 放进任务文本或日志。

## 请求

| kind | 参数 | 行为 |
| --- | --- | --- |
| `state` | `sessionId?`, `taskId?` | 精确读取任务、审批和有界输出；都省略时读取默认选中会话 |
| `targets` | 无 | 返回默认会话视图；`sessions` 同时包含本凭据所有会话各自的最新任务视图 |
| `new` | `workspace?` | 新建并选择会话；指定时必须是已存在的绝对目录，省略使用后台启动目录 |
| `select` | `sessionId` | 设置默认读取会话，不影响任何任务的执行 |
| `submit` | `sessionId`, `text`, `requestId` | 提交任务；文本非空，最多 32000 字符；requestId 非空，最多 128 字符 |
| `cancel` | `taskId`, `sessionId?` | 只停止指定运行任务；可附会话核对归属，接受停止后仍须轮询该任务的官方终态 |
| `approve` | `id`, `optionId`, `sessionId?`, `taskId?` | 只回答该审批 ID；可附任务/会话核对归属，必须使用返回的 ID 和 options |
| `disconnect` | 无 | 该凭据所有任务结束且无在途变更时解除默认会话选择与后台租约，不删除历史、不停止共享后台 |

每种请求只允许对应参数；未知字段、未知 kind、过长或缺失字段返回 400。**同一凭据不同会话可并行执行，每个会话最多一个活动任务。** submit 直接使用其 `sessionId`，无需事先 select，也不改变默认选择。新建/切换会话可以与任务执行并行；同会话的并发提交立即返回 409 `task/busy`，不排队。`accepted`、`running`、`unconfirmed` 都占用本会话；官方工作台已在该会话运行时也拒绝提交。disconnect 在任一会话任务非终态或变更在途时返回 409。

state 的两个定位字段可以单独使用，也可同时提供作归属核对。未知、其他凭据、已淘汰的 taskId 或会话/任务不匹配均返回 409 `task/not-found`，绝不退回默认会话。取消按 taskId 定位；审批按随机审批 ID 定位，附带的 taskId/sessionId 不匹配时拒绝。它们不依赖默认选择。每个请求的返回顶层描述其目标会话/任务，`selectedSessionId` 始终描述默认选择。

尚未进入官方回合的 accepted/unconfirmed 任务不能谎报已取消；先精确读取状态。状态、审批、取消和其他会话的提交不堵在慢提交之后。每个会话独立接收官方 turn/start、turn/end、工具输出和错误证据；仅该回合的官方终态能结束该任务。

响应沿用 `{success, data, error?}`。成功状态的 `data` 包含：

```json
{
  "ok": true,
  "identity": { "instanceId": "...", "instanceEpoch": 123 },
  "status": "idle",
  "selectedSessionId": "session-...",
  "sessionId": "session-...",
  "workspace": "D:\\project",
  "taskId": "...",
  "taskState": "completed",
  "task": { "taskId": "...", "sessionId": "...", "requestId": "...", "state": "completed" },
  "activeTaskIds": [],
  "sessions": [{ "sessionId": "session-...", "workspace": "D:\\project", "status": "idle", "taskId": "...", "taskState": "completed", "task": { "taskId": "...", "sessionId": "session-...", "state": "completed" }, "approvals": [], "transcript": [], "transcriptTruncated": false }],
  "approvals": [],
  "transcript": [],
  "transcriptTruncated": false
}
```

无任务时相关字段为 null。无后台时读操作返回 `status: 'offline'` 和明确的未知结果恢复提示；变更不会伪装成功。提交回执另含 `accepted` 与 `acceptedTaskId`。新提交、重复请求回执的顶层 `taskId` 都描述该次请求自己的任务；`sessions` 各行描述该会话的最新任务，两者可能不同。旧调用方的无参数 state 仍读取默认选中会话，但并行调用方必须携带接收回执中的 taskId 轮询，不能根据默认会话或另一次提交推断完成。`activeTaskIds` 列出本凭据全部非终态任务。disconnect 保留可查询的任务历史，无参数回执仍可包含最近一次任务而 sessionId 为 null。

requestId 在整个凭据内唯一；相同 requestId 必须对应相同 sessionId 与文本，否则返回 400。重复请求绝不再次发往官方后台，包括结果未知的提交。缓存仅淘汰终态请求，活动/未知请求不会被淘汰；过期 requestId 的去重不再保证，不能据此恢复未知任务。

审批包含官方提供的 `callId`（若有），可与 `transcript` 中 `tool-call` / `tool-result` 的同名字段关联，核对具体工具参数后再决定；并行调用同一工具时不要仅按 `toolName` 匹配。输出被截断而无法核对操作时，不应猜测批准。

## 调用示例

PowerShell 中使用进程已获得的连接包；示例不显示 token：

```powershell
$workUrl = "http://127.0.0.1:$env:LYSHELL_MCP_PORT/api/harness/work/request"
$workHeaders = @{ 'x-lyshell-token' = $env:LYSHELL_MCP_TOKEN }
function Invoke-HarnessWork($request) {
  $jsonBytes = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress))
  Invoke-RestMethod -Uri $workUrl -Method Post -Headers $workHeaders `
    -ContentType 'application/json; charset=utf-8' -Body $jsonBytes
}

$created = Invoke-HarnessWork @{ kind = 'new'; workspace = 'D:\project' }
$sessionId = $created.data.sessionId
$receipt = Invoke-HarnessWork @{
  kind = 'submit'; sessionId = $sessionId
  requestId = [Guid]::NewGuid().ToString(); text = '检查项目的构建错误并修复，报告改动和验证结果。'
}
$taskId = $receipt.data.acceptedTaskId
Invoke-HarnessWork @{ kind = 'state'; sessionId = $sessionId; taskId = $taskId }
# 可在同一凭据下 new 另一个会话并提交；两个会话分别按自己的 taskId 跟踪。
# 按返回的真实审批字段操作；optionId 必须来自该审批的 options：
# Invoke-HarnessWork @{ kind = 'approve'; id = $approval.id; sessionId = $sessionId; taskId = $taskId; optionId = 'rejected' }
# Invoke-HarnessWork @{ kind = 'cancel'; taskId = $taskId }
```

MCP 调用示例：`lyshell_harness_work({"kind":"new","workspace":"D:\\project"})`，随后用返回的 sessionId 调用 submit。建议约每 4 秒按 `{kind:"state",sessionId,taskId:acceptedTaskId}` 轮询；只有同一实例、同一会话、同一 taskId 的 `taskState: 'completed'` 才算完成。`cancelled` / `failed` / `unconfirmed` / `offline` 都不能作为成功。

submit 的 HTTP 超时、桥失败或断线可能发生在官方已接单之后。先读权威状态，禁止自动重发。桥会把提交抛错保留为 `unconfirmed`，后续官方 turn/start、turn/end 可恢复已知状态。错误响应不代表任务一定没有执行。

## 与 PetLink 共存

- 使用现有 dsh 后台和 LyShell 的启动配置/变量组；不另占 `31517`，不连接 PetLink 工作 API，不改宠物插件文件或官方用户 profile。
- 原生 owner 根据调用方凭据派生，任务/审批/输出独立于 Pet 的 binding/epoch。不能读取或选择 Pet、Web 历史或另一凭据的会话。Pet 控制面也不能选择或提交原生通道创建的会话。
- **隔离单位是凭据。** 共用同一个 global token 的外部程序视为同一调用方；不同终端的 session token 各自隔离。
- Pet release、禁用或卸载只清理 Pet 自己的绑定；原生 holder 独立保留。原生 disconnect 不释放 Pet，不杀共享后台。正常退出 LyShell 会回收整个后台。
- 不自动跳转或聚焦官方工作台，不修改 Pet 详情导航；可由用户在现有官方工作台查看历史。

## 边界与验证

控制状态和凭据归属只保留在当前后台内存中；后台或 LyShell 重启后不承诺恢复原生控制权，也不提供跨重启 exactly-once。官方历史仍由 dsh 保存，但本接口不接管旧历史。每凭据最多 64 个会话（故最多 64 个活动任务）、256 个 requestId，另保留各会话最新任务；最多 64 个凭据。历史 taskId 超出保留范围时明确 not-found；不要自动重发。每凭据所有会话/历史合计最多 256 条输出，每条 512 字符，128 个待审批；顶层与 sessions 行仅返回所属任务的输出，淘汰/截断会显式标注。需要完整结果时让任务写入工作目录文件。

连接持有后台租约，空闲后应调用 disconnect。任务运行或结果未确认时不会通过 disconnect 强制取消。后台共用官方配置和计算资源；用户主动在官方工作台操作该会话仍沿用官方行为。

初版验收使用隔离 LyShell 档案、独立 DSH_HOME、已安装官方 dsh `0.2.0-rc.2` 与回环模型 fixture，验证真实 HTTP 提交/结果/停止、真实 MCP SDK stdio 调用、凭据拒绝与插件生命周期隔离。桥回归覆盖原生/Pet 并行、审批隔离、重复请求和未知提交恢复。未调用付费模型，未替换或重启正式实例。

2026-10-15 复审验证结果：类型检查和构建通过；全量 152 个测试文件通过、1 个跳过，2249 项通过、5 项跳过（使用 `--testTimeout=15000`；初次默认超时的两个 worktree 用例单独复跑也通过）。修改文件 ESLint 为 0 错误、38 个既有 `no-explicit-any` 警告；`git diff --check` 通过。隔离 HTTP/MCP 验收通过，另验证了 32000 个需 JSON 转义字符的提交、超 1MiB 合法状态响应及审批调用关联。本次所有代码与差异由 Codex 亲自检查，PetLink 只协助撰写了文档初稿。隔离验收脚本和结果位于本 checkout 的 `tmp/native-work-*`（QA 文件，不随发布打包）。

## 多会话并行实现与兼容性（2026-10-26）

- 官方 dsh 0.2.1-rc.2 的 `sessionController.prompt` 按 sessionId 解析独立 Agent，再调用该 Agent 的 followup；没有凭据级或全局 turn 锁。LyShell 不修改官方 Agent 调度或权限策略。
- 桥内从凭据单任务改为凭据 → 会话 → 任务记录；去重、审批和输出总预算仍在凭据内。宿主移除覆盖整个凭据的长提交队列，仅保留变更计数与 disconnect 互斥，防止释放其他在途请求的租约。
- `sessions` 从目录行扩展为各会话最新任务的完整视图，保留原有 sessionId/workspace。工作台活动面板兼容旧桥，同时在新桥上逐会话更新状态，审批前按会话和任务 fresh read。
- 新桥顶层 `revision` 是当前凭据在同一后台内生成快照的递增序号；精确读和重复提交回执也使用同一序列。主进程据此丢弃迟到快照，避免并行响应乱序删除新会话、清空审批或回退同毫秒创建的新任务；后台换代后重新建立序列。
- 新增/切换可以在运行中执行，是与原先凭据级 busy 行为的有意变化。无选择变化的单会话调用方式继续有效。重复旧请求现在返回它自己的任务视图，避免将最新结果混同为旧结果。
- 断线只表示结果未知；重新连接同一后台后按 identity/sessionId/taskId 恢复读取。后台换代丢失原生控制权，旧 taskId/审批不会映射到新任务，不承诺跨重启恢复或 exactly-once。

2026-10-26 验证结果：类型检查、隔离输出目录的构建、git diff --check 通过；修改的 TypeScript 文件 ESLint 为 0 错误、38 个已有 http-server.ts 的 no-explicit-any 警告。Harness 与共享契约回归 32 文件、591 项通过（含 11 项专门的同凭据并发测试）。全量首轮 285 文件通过、3 文件失败、1 文件跳过，3597 项通过、5 项失败、5 项跳过；失败涉及 SSH 传输连接重置、通知子进程限时、命令屏 DOM 等待，降低并发复跑这 3 文件的 45 项全部通过。随后新增的缓存/容量边界测试也通过，未修改无关测试以绕过失败。

隔离真实 HTTP/MCP 验收使用当前安装官方 dsh `0.2.1-rc.2`、独立 LyShell 档案和 DSH_HOME、本地回环模型 fixture，观察到同一凭据两个官方模型流同时保持 running。验证了同会话 busy、运行中新建/选择、精确 GET/POST/MCP 查询、单独取消后另一会话继续运行、新回合完成、历史查询，以及真实审批的任务/会话匹配和拒绝。没有批准或执行 fixture 请求的工具，没有调用付费模型，没有重启/改变正式实例。脚本、隔离构建和报告位于 `tmp/native-work-parallel/`（QA 文件，不随发布打包）；所有改动均由 Codex 亲自审查。
