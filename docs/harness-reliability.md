# Harness 稳定性与恢复

2026-10-29，桥包 0.4.0，host-only 协议沿用版本 2。

## 后台归属

Harness 启动后由 LyShell 宿主持有。关闭工作台、最后一个 PetLink 租约释放、插件撤销都不会结束共享后台。PetLink 的 release 仅解绑连接；取消任务必须显式 cancel。解绑时尚未回答的 Pet 审批交回官方审批链，不自动允许；原生任务及其审批保持独立。

就绪后台非正常退出时，宿主按 1、3、10 秒有限退避恢复，五分钟内最多三次；稳定运行两分钟后才重置崩溃循环预算。Windows 必须先确认 Job 收回旧进程树。退出码 0、LyShell 正常退出、模型等待、审批等待和桥 HTTP 超时不会触发自动重启。恢复只恢复进程，从不重放任务。

进程退出时间、代际、身份、退出码/信号与固定错误分类写入主日志；不保存 stderr/provider 原文、登录 URL 或环境凭据。API 的 backend 字段区分进程存活、桥就绪、恢复等待及预算耗尽。

Windows 包裹进程退出而旧树尚未核实收回时，原 PID 及其归属令牌继续保留。自动恢复与显式 recover 都不能绕过清理阻塞；确认旧树消失后才允许启动下一代。

## 任务记录与身份

宿主把专用日志目录注入桥，桥捕获后从工具继承环境中删除。按 cwd/DSH_HOME 隔离的 userData/harness-work 记录原生 owner、会话、任务、请求指纹、执行回合与有限进度。写入使用独占临时文件、fsync、原子替换和校验和；持久化失败禁止派发新任务，损坏数据不能静默重置为空。

global 客户群使用宿主本地稳定身份，跨应用重启和认证 token 轮换恢复；旧 token 仍然失效。各终端 session 凭据保持隔离，不接管其他终端、Pet 或任意官方历史。日志不包含 HTTP token、桥密钥、登录 URL、审批 promise 或可自动重放的原始 prompt。

保留每 owner 256 条完整请求和各会话最新任务。完整终态请求被淘汰时，保留最多 10000 条去重摘要；容量耗尽或单文件达到 8 MiB 时明确拒绝，不能遗忘去重记录后重复执行。每个启动范围最多 64 owner、每 owner 最多 64 会话，输出总预算 256 条，每条最多 512 字符。

淘汰旧 attempt 时只删除仍指向该 attempt 的任务索引，不影响同一逻辑 task 的新回合。运行中日志失效会禁止新提交及 `allowed-once` 审批，但仍可取消原任务、拒绝或取消待决审批；停止结果仍以官方终态为准。

## 恢复流程

| 操作 | 行为 |
| --- | --- |
| state/targets | 不启动后台。离线仍可读取所属持久记录，identity=null、stale=true，旧身份在 lastKnownIdentity，审批为空 |
| recover | 显式恢复后台；活着的后台不会被顶掉，也不会重发任何任务 |
| resume | 核对已有副作用后，用新 requestId 和剩余工作 text 续接原 taskId/sessionId |

重建后未完任务标记 unconfirmed/recoveryRequired。只允许官方冷读中精确匹配原 turn 和序号范围的持久 turn/end 恢复终态。

resume 不直接唤醒未完的原 Agent：用官方冷 fork 封闭历史回合，再提交核对后的新指令。逻辑 taskId/sessionId 保持不变；attemptId、attempt、executionIdentity 和 executionSessionId 指明新的执行分支。官方缺少安全 fork 能力时明确返回 task/resume-unsupported，不退化成盲重放。

工作台活动登记按 attempt 区分同一逻辑任务的新旧状态，旧终态不会压住续接回合。显式导航跟随真实执行分支；后台更换 origin 时，只原位更新已打开工作台，不创建页签或抢焦点。渲染器重载后可通过只读 dsh:web:connection 对账；dsh:web:recovered 推送使用无凭据回环 URL，主进程、preload 和消费端均验证。

Pet 绑定在宿主确认 backend identity 换代后失效，旧任务保留为 interruptedTasks/outcome:unknown；旧审批不得用于新实例。暂时不可达或身份未知不会被当作换代，也不会自动重发 Pet 工作。

## 已验证的边界

- 真实独立子进程在产生一次副作用后被强杀：重建并重复原请求，不再次执行。
- 真实官方 dsh 与隔离完整 LyShell、回环模型：后台树强杀后自动恢复；模型请求数不变；显式续接只新增一次请求，并收到真实 turn/end completed。
- 整个 LyShell 退出再启动：token 轮换后离线读取原任务；显式 recover 和重复 resume 不产生模型请求；真实 MCP SDK stdio 与 HTTP 读取同一记录。
- 真实渲染器收到验证后的恢复通知；React 测试覆盖已关闭视图、焦点不变、迟到事件、渲染器重载与迟到初始快照。
- 控制服务贯穿真实回环桥的插件 revoke，保留原生回合与待审批项；单独释放 Pet 最后租约不结束宿主后台。

这些能力适用于升级后创建并持久化的任务。旧版本已经丢失的控制记录不能倒推补造。共享 dsh 进程仍共享计算资源；这里保证生命周期/权限隔离与可核对恢复，不承诺永不崩溃、自动回滚或任意外部副作用的 exactly-once。正式运行中的安装版没有被本次隔离验收替换或重启。
