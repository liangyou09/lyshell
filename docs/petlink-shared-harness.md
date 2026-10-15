# PetLink 共享 Harness 后台（v3）

2026-10-14 当前 checkout 实现：受控 PetLink 插件与 LyShell **共用一个可用官方 Harness 后台**。Pet 详情复用 LyShell 主区域同一官方工作台页签；工作台可以正常输入、新建会话、操作历史及官方配置。整实例独占、Web 只读和会话隔离方案均已作废，不实现两端互占仲裁。

## 使用与生命周期

在 LyShell 安装并启用 manifest ID 为 `aipet` 的 PetLink 插件，插件真实宿主通过 `spawnControlled` 启动连接器并注入自身 host token。连接器把有效凭据交给空闲 Pet；它验证真实服务端状态后才使用托管通道。普通 HTTP/MCP 发现或共用 DSH_HOME 不会启用托管。

LyShell 复用已有兼容 Web 实例，不存在时按需启动一个。Pet 模式不再启动本地 ACP 后台；cwd、变量组、DSH_HOME、worktree 与执行配置归 LyShell。Pet 当前任务的原生工具审批在 Pet 回答，其他 Web 回合继续官方审批链，不默认允许工具。

Pet 显式详情动作先挂载主区域页签，再等待官方导航回执，用本次 requestId/revision 的真实 ack 确认落地。共享状态由无界面轮询维护：held/releasing 时页签名为 `dsh & petlink`，释放后恢复原名称；工作台顶部不再显示状态条或“回到 Pet 任务会话”按钮，返回任务通过 Pet 的显式详情入口完成。轮询失败保留最后成功读取的状态，不把缓存快照当作新状态。用户浏览推进 revision，陈旧导航请求作废；重复推送不抢回已浏览位置，单页签不会因重复详情重载或重启后台。

关闭详情页签只 detach，任务继续。普通推送和轮询尊重关闭记录；Pet 再次显式请求详情时，携带独立的 `reopen` 标记重建页签，已有页签则聚焦，后台继续复用。IPC 的普通 `force` 补发不清除关闭记录，避免重开链路递归或自动弹回。Pet release、插件撤销和正常退出释放 Pet 自身绑定，不杀共享后台。LyShell 正常退出回收其 owned 进程树。托管 holder 存在时显式 `dsh:web:open` 走复用路径，异工作区/启动配置冲突会明确拒绝，避免重开中断后台。该进程保护不限制官方 Web 的任务输入和配置功能。

两端沿用官方 agent loop。同一会话上的同时提交、停止与配置修改按官方行为处理，当前不保证区分所有并发回合副作用。Pet 仍验证 sessionId/taskId/epoch/approvalId，防止陈旧 Pet 请求误作用到新任务。

断线保留已知进度，报明确错误，不自动 fallback 或重发未知 submit。恢复先读取权威快照；原任务已接受则继续跟踪，未知结果仍不允许盲重发。禁用/卸载撤销 host token 和 Pet 未决审批；重新启用通过新连接器交接新凭据。强杀或持续不可达不保证即时 release。

## 协议、凭据和兼容

- 桥协议 2，包版本 0.3.0。`resources/dsh-bridge` 随 LyShell 位于 asar 外；运行期 owned patch 经 `dsh web --patch <abs> --port 0 --no-open` 加载，不改官方 dsh 包或用户 profile。
- `/api/exclusive-control` 与 `Exclusive*` 是历史保留名字，实际语义是 Pet 任务绑定。所有相位的 `readOnly=false`，viewer `gatedPaths=[]`。历史 gate/approval-decision 路由常量未注册，`LYSHELL_EXCLUSIVE_*` 未注入；保留的 dshBridge token API 当前没有生产 bind 调用。
- Pet HTTP 变更/事件/详情要求已启用 `aipet` 的真实 host token（`x-lyshell-token`）。global/session/UI/其他插件不能冒充。已鉴权 snapshot 读面包含有界工作输出，不匿名开放，也不授予任务写权限。
- 主进程桥用独立随机 `x-lyshell-harness-key`。桥从 spawn env 捕获后立即删除环境键；官方工具子进程不继承。token/key 不进入状态、日志、模型、URL 或用户设置。
- viewer 同源端点先通过官方登录及来源检查，再签发独立 HttpOnly cookie，按 viewer 身份认领导航。Pet 外部详情回包不含官方工作台 URL/登录凭据。
- submit accepted 不等于 completed；终态来自官方 turn/end。事件窗口外返回 gap，用快照恢复。有限 requestId 缓存不提供跨重启 exactly-once。

本机 S6/S7 对已安装的 `@deepseek-ai/dsh@0.2.0-rc.2` 验证；未实测所有其他版本或真实旧包。缺桥/协议不匹配明确 `instance/no-bridge`，不自动重启用户在用的后台，也不改装官方包。

## 升级步骤

1. 任务空闲后正常退出旧 Pet 与 LyShell，保存官方历史，保留正式配置及 DSH_HOME。
2. 同时使用包含当前托管通道的 Pet 构建与协议 2 桥的 LyShell 构建。确认 `resources/dsh-bridge/{index.mjs,client.js,package.json}` 在 asar 外，Pet `lyshell-plugin` 指向当前安装路径。
3. 在 LyShell 重新启用插件，获得新连接器及 host token。不能只更新插件脚本而仍运行旧 Pet 主进程。
4. 核对一个后台、重复详情同页签、Web 输入/新建/历史、Pet 原生审批。单独启动 Pet 应仍 local，即使 LyShell 外部 HTTP 已启用或共用 DSH_HOME。

本次只交付 checkout 代码与文档，未安装、打包或替换正式实例。最终证据保存在相邻 AIPet checkout 的 `artifacts/lyshell-harness-host/S7-report.md`，详列真实完整应用与 fixture 的各自验证边界；不宣称线上模型故障已修复。
