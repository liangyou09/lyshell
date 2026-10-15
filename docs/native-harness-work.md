# LyShell 原生 Harness 对外工作接口

LyShell 可以直接接收外部任务，使用官方 DeepSeek Harness 执行，不依赖 PetLink。HTTP 和 MCP 共用同一实现、会话和任务状态。模型、工具执行和权限策略仍由官方 dsh 持有。

## 接入与授权

- HTTP：沿用 LyShell 的随机回环端口，`x-lyshell-token` 鉴权。
- `GET /api/harness/work/state`：读取当前凭据的状态，不启动后台。
- `POST /api/harness/work/request`：JSON 请求，见下表。
- MCP：使用现有 `mcpServer.js` 接入，新增工具 `lyshell_harness_work`，参数与 POST 完全一致。配置见 [MCP 指南](mcp-config.md)。

在 LyShell 内启动的 Agent 可以沿用注入的 `LYSHELL_MCP_PORT` / `LYSHELL_MCP_TOKEN`。外部程序需要开启现有“允许外部 MCP 客户端”，通过端口文件获取连接包；读操作要求 `allowRead`，变更同时要求 `allowLocalExecute` 和 `allowFileWrite`。`requireConfirmation` 开启时变更沿用现有确认弹窗。开关在每次请求、后台启动后和响应返回前复查；默认不扩大外部权限。

只接受 global/session 凭据。包括 `aipet` 在内的插件 host/UI 凭据以及 dshBridge 凭据都不能进入原生通道。浏览器 Origin 与预检沿用本机 API 的拒绝策略。不要把 token、后台登录 URL 或 host key 放进任务文本或日志。

## 请求

| kind | 参数 | 行为 |
| --- | --- | --- |
| `state` | 无 | 当前任务、审批和有界输出 |
| `targets` | 无 | 同样返回状态，其中 `sessions` 是本凭据在当前后台创建的会话 |
| `new` | `workspace?` | 新建并选择会话；指定时必须是已存在的绝对目录，省略使用后台启动目录 |
| `select` | `sessionId` | 选择本凭据创建的会话 |
| `submit` | `sessionId`, `text`, `requestId` | 提交任务；文本非空，最多 32000 字符；requestId 非空，最多 128 字符 |
| `cancel` | `taskId` | 停止当前运行的对应任务；接受停止后仍须轮询官方终态 |
| `approve` | `id`, `optionId` | 回答当前待处理审批；只使用状态中返回的 ID 和 options |
| `disconnect` | 无 | 空闲时解除当前会话选择与后台租约，不删除历史、不停止共享后台 |

每种请求只允许对应参数；未知字段、未知 kind、过长或缺失字段返回 400。任务非终态时禁止新建、切换、断开或提交另一任务，返回 409。尚未进入官方回合的 accepted/unconfirmed 任务不能谎报已取消；先读状态。审批和状态读取不堵在提交队列后。

响应沿用 `{success, data, error?}`。成功状态的 `data` 包含：

```json
{
  "ok": true,
  "identity": { "instanceId": "...", "instanceEpoch": 123 },
  "status": "idle",
  "sessionId": "session-...",
  "workspace": "D:\\project",
  "taskId": "...",
  "taskState": "completed",
  "task": { "taskId": "...", "sessionId": "...", "requestId": "...", "state": "completed" },
  "sessions": [{ "sessionId": "session-...", "workspace": "D:\\project" }],
  "approvals": [],
  "transcript": [],
  "transcriptTruncated": false
}
```

无任务时相关字段为 null。无后台时读操作返回 `status: 'offline'` 和明确的未知结果恢复提示；变更不会伪装成功。提交回执另含 `accepted` 与 `acceptedTaskId`；`taskId` 始终描述当前任务。重复旧请求的 `acceptedTaskId` 可能与当前任务不同，不能把当前任务结果当成旧请求的结果。

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
Invoke-HarnessWork @{ kind = 'state' }
# 按返回的真实审批字段操作；optionId 必须来自该审批的 options：
# Invoke-HarnessWork @{ kind = 'approve'; id = $approval.id; optionId = 'rejected' }
# Invoke-HarnessWork @{ kind = 'cancel'; taskId = $taskId }
```

MCP 调用示例：`lyshell_harness_work({"kind":"new","workspace":"D:\\project"})`，随后用返回的 sessionId 调用 submit。建议约每 4 秒轮询 state；只有同一实例、同一 taskId 的 `taskState: 'completed'` 才算完成。`cancelled` / `failed` / `unconfirmed` / `offline` 都不能作为成功。

submit 的 HTTP 超时、桥失败或断线可能发生在官方已接单之后。先读权威状态，禁止自动重发。桥会把提交抛错保留为 `unconfirmed`，后续官方 turn/start、turn/end 可恢复已知状态。错误响应不代表任务一定没有执行。

## 与 PetLink 共存

- 使用现有 dsh 后台和 LyShell 的启动配置/变量组；不另占 `31517`，不连接 PetLink 工作 API，不改宠物插件文件或官方用户 profile。
- 原生 owner 根据调用方凭据派生，任务/审批/输出独立于 Pet 的 binding/epoch。不能读取或选择 Pet、Web 历史或另一凭据的会话。Pet 控制面也不能选择或提交原生通道创建的会话。
- **隔离单位是凭据。** 共用同一个 global token 的外部程序视为同一调用方；不同终端的 session token 各自隔离。
- Pet release、禁用或卸载只清理 Pet 自己的绑定；原生 holder 独立保留。原生 disconnect 不释放 Pet，不杀共享后台。正常退出 LyShell 会回收整个后台。
- 不自动跳转或聚焦官方工作台，不修改 Pet 详情导航；可由用户在现有官方工作台查看历史。

## 边界与验证

控制状态和凭据归属只保留在当前后台内存中；后台或 LyShell 重启后不承诺恢复原生控制权，也不提供跨重启 exactly-once。官方历史仍由 dsh 保存，但本接口不接管旧历史。每凭据最多 64 个会话、最近 256 个 requestId；最多 64 个凭据。最近输出最多 256 条、每条 512 字符，截断会显式标注。需要完整结果时让任务写入工作目录文件。

连接持有后台租约，空闲后应调用 disconnect。任务运行或结果未确认时不会通过 disconnect 强制取消。后台共用官方配置和计算资源；用户主动在官方工作台操作该会话仍沿用官方行为。

本次使用隔离 LyShell 档案、独立 DSH_HOME、已安装官方 dsh `0.2.0-rc.2` 与回环模型 fixture，验证真实 HTTP 提交/结果/停止、真实 MCP SDK stdio 调用、凭据拒绝与插件生命周期隔离。桥回归覆盖原生/Pet 并行、审批隔离、重复请求和未知提交恢复。未调用付费模型，未替换或重启正式实例。

2026-10-15 复审验证结果：类型检查和构建通过；全量 152 个测试文件通过、1 个跳过，2249 项通过、5 项跳过（使用 `--testTimeout=15000`；初次默认超时的两个 worktree 用例单独复跑也通过）。修改文件 ESLint 为 0 错误、38 个既有 `no-explicit-any` 警告；`git diff --check` 通过。隔离 HTTP/MCP 验收通过，另验证了 32000 个需 JSON 转义字符的提交、超 1MiB 合法状态响应及审批调用关联。本次所有代码与差异由 Codex 亲自检查，PetLink 只协助撰写了文档初稿。隔离验收脚本和结果位于本 checkout 的 `tmp/native-work-*`（QA 文件，不随发布打包）。
