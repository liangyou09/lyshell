# LyShell 插件接口设计:VS Code 式 + 进程外 client 层

> 状态:实现中 · 分支 `feat/plugin-system` · Step 1 + 1.5 + Step 3 切片 A/B/C1/C2/C3/C4(数据/鉴权/host/加载激活/python runtime/管理 UI)已落地(见 §11),余 Step 2(浏览器接入)、Step 4(插件贡献点)未实现
> 目标:为 LyShell 增加插件接口,支持接入浏览器、桌面 agent、Python/Node 脚本,并允许第三方贡献新能力。

## 1. 背景与目标

LyShell 需要对接多种外部执行体:浏览器、桌面 agent、Python 脚本、Node.js 脚本。现状下这些场景缺乏统一的接入模型。

四类接入者本质上是**两种接入模式**:

- **进程外 client**:浏览器、桌面 agent、独立 Python/Node 脚本 -- 通过 HTTP/SSE API 接入,LyShell 作 server。
- **进程内插件**:LyShell 主动 spawn 的脚本,注入 host API -- 现有 `python/engine.ts` 是雏形。

参考 VS Code 扩展系统,本设计提出:**以一个 `ApiRegistry` 为枢纽,统一三种传输(HTTP/SSE、stdio MCP、in-process RPC),支撑两种插件角色(消费者 / 贡献者)。**

## 2. 现状分析

### 已有的"半成品"扩展通道

| 扩展点 | 机制 | 插件化程度 |
|---|---|---|
| 连接器 `connectors/base.ts` | `BaseConnector` 抽象类(`connect/disconnect/write/resize` + EventEmitter),4 个实现 | 接口干净,但无 registry -- `session-manager.ts:279` 硬编码 `switch(type)` |
| MCP 对外 API `mcp/http-server.ts` + `mcp-server/tools.ts` | 本地 HTTP API + stdio MCP server 两层 | 天然的外部接入通道,但路由是 `handleRequest` 里硬编码 `if/switch pathname`,工具定义是静态数组 |
| Python 脚本引擎 `python/engine.ts` | `spawn` 子进程,注入 `LYSHELL_*` env,提供 `LyShell` API | 最接近插件运行时,但 API 是占位的(`execute` 只 print 不回连主进程) |

### 阻碍

1. **缺 registry 模式**:连接器分派、MCP 路由、IPC channel 全是 switch/if 硬编码。
2. **sandbox + contextIsolation**:渲染层不能 `require` Node 插件,插件只能在 main 进程或独立子进程加载。
3. **electron-vite 打成 bundle**:in-process 动态 `require` 外部插件要处理 asar unpack;子进程插件不受此限。
4. **CORS 被拒**:`http-server.ts:385` 对 OPTIONS 预检返 403,浏览器现在进不来。
5. **token 在本地 port 文件**:浏览器沙箱读不到,需要授权握手。

## 3. 核心抽象:ApiRegistry

把"硬编码 switch"变成"可插件化"的钥匙,也是让三种传输共用一份定义的关键。一条 route = 一份能力,handler 只写一份。

```ts
// src/main/plugin/registry.ts (新增)
interface ApiRoute {
  name: string                     // 'lyshell_send_input' / 'sendInput'
  path: string                     // '/api/send-input'
  method: 'GET' | 'POST' | 'SSE'
  capabilities: Capability[]       // ['interactiveWrite'] -- 复用现有 capability 集
  inputSchema: JSONSchema
  outputSchema?: JSONSchema
  annotations?: { readOnly?, destructive?, idempotent? }
  transports?: Transport[]         // 默认全传输;标了才限定(如只暴露给 stdio-mcp)
  handler: (args, ctx: CallCtx) => Promise<result>   // in-process,只写一份
}
```

- **HTTP server** 从 registry 派生路由(替换 `http-server.ts` 里的 `if/switch pathname`)
- **stdio MCP server** 从 registry 派生 `TOOL_DEFINITIONS` + `getApiPath`(替换 `tools.ts` 静态数组 + 静态 map)
- **plugin host** 从 registry 生成 in-process API 对象
- **贡献者插件** `registry.register(route)` 后,新能力自动在三种传输上出现

```
                    ┌──────────────────────────┐
                    │   ApiRegistry (枢纽)      │
                    │   routes + capabilities   │
                    └────────────┬─────────────┘
                                 │ 统一 API 定义
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
     HTTP / SSE             stdio MCP             in-proc RPC
     (外部传输)              (外部传输)             (内部传输)
          │                      │                      │
  浏览器/桌面 agent        mcp-server              plugin host
  Python/Node 独立脚本     adapter(已有)          (Node/Python 插件)
```

## 4. 进程模型

```
┌──────────────────────── Main process (Electron) ────────────────────────┐
│                                                                         │
│  session-manager ──┐                                                    │
│  connectors        │     ┌──────────────┐      ┌──────────────────┐     │
│  file/transfer     │────▶│ ApiRegistry  │◀────▶│ plugin-host mgr  │     │
│  (现有,不动)       │     │ (route 表)   │      │ (拉起/激活插件)   │     │
│                    │     └──────┬───────┘      └────────┬─────────┘     │
│                    │            │                       │ IPC/RPC       │
│                    │     ┌──────┴────────┐              │               │
│                    │     │ HTTP/SSE 127.0│      ┌───────┴────────┐      │
│                    │     │ .0.1 + token  │      │ plugin-host     │      │
│                    │     └──────┬────────┘      │ 子进程(可选)    │      │
└─────────────────────────────────┼───────────────┴────────────────┬──────┘
                                  │                                │
        ┌─────────────────────────┼────────────────┐               │
        │   进程外 clients(consumer)│               │  进程内插件(contributor)
        │                         │               │               │
  ┌─────┴─────┐  ┌────────────┐  ┌─┴────────┐   ┌──┴──────────┐  │
  │ mcp-server│  │ 浏览器      │  │ Python/  │   │ Node 插件    │  │
  │ stdio MCP │  │ (CORS+握手) │  │ Node SDK │   │ (受控 API)   │  │
  │ adapter   │  │             │  │ 独立脚本  │   │              │  │
  └───────────┘  └─────────────┘  └──────────┘   └──────────────┘  │
        │                                                            │
   PTY 内孵出的 agent 自动继承 session token ─────────────────────────┘
```

## 5. 两种插件角色

| 角色 | 做什么 | 接入方式 | 工作量 |
|---|---|---|---|
| **消费者 (consumer)** | 调用 LyShell API 完成任务(自动化脚本、agent 后端、浏览器控制终端) | 走 HTTP/SSE 或 SDK,只消费 | 几乎零新增 -- 复用现有 client 模型 |
| **贡献者 (contributor)** | 给 LyShell 加新能力(新连接协议、新命令/工具、UI 贡献) | 在 plugin host 里 `registry.register()`,反向贡献 route | 需要 host + 激活机制 |

Python/Node 自动化脚本主要是 consumer;给 LyShell 加"新连接协议""新快捷命令工具""新状态栏入口"的是 contributor。两者共用 ApiRegistry。

## 6. 插件清单(借鉴 VS Code `package.json`)

```jsonc
// lyshell-plugin.json
{
  "id": "my-rdp-connector",
  "name": "RDP Connector",
  "version": "1.0.0",
  "engines": { "lyshell": "^1.0" },
  "main": "./dist/index.js",          // contributor 入口(Node)
  "runtime": "node",                  // node | python(走 engine.ts)
  "lifecycle": "persistent",          // oneshot | persistent;省略时 node 默认 persistent,python 默认 oneshot
  "activationEvents": [
    "onCommand:rdp.connect",          // 命令触发才激活(延迟)
    "onConnectionType:rdp"            // 或:选了 rdp 协议时激活
  ],
  "capabilities": ["sessionControl"], // 声明需要的 capability
  "contributes": {
    "commands": [{ "id": "rdp.connect", "title": "Connect RDP" }],
    "connectionTypes": [{ "type": "rdp", "label": "RDP" }],
    "tools": []                       // 贡献的 MCP/HTTP 工具(自动进 registry)
  }
}
```

激活机制对齐 VS Code:声明式 `contributes` 让命令/连接类型零激活就出现在 UI 上;用户触发对应 activation event 才加载 `main`。consumer 插件没有 `main`,只有元数据(或不需清单,直接当 client)。

**lifecycle 语义**:manifest 用 `lifecycle` 显式声明单次运行还是长期运行,与 `runtime` 解耦:

| runtime | lifecycle | 执行方式 | 说明 |
|---|---|---|---|
| `node` | `persistent` (默认) | 共享 plugin-host 子进程,`activate()` 后常驻 | VS Code Extension Host 式,事件驱动 |
| `node` | `oneshot` | 每插件独立子进程,`activate()` 完成后退出 | 手动「运行」触发一次;**不随启动自跑**,`activationEvents` 被忽略 |
| `python` | `oneshot` (默认) | `engine.ts execute()`,`main.py` 跑完即退出 | **显式声明**时仅手动「运行」触发,`activationEvents` 被忽略;旧清单未声明 `lifecycle` 时兼容为启动运行一次;超时 `pythonTimeoutMs` |
| `python` | `persistent` | `engine.ts spawnScript()` 长期保持 Python 子进程 | 常驻至禁用/卸载/退出;MVP 仅 `onStartup`/`*`;`onCommand`/`onConnectionType` 事件分发待后续 |

未指定 `lifecycle` 时按 `runtime` 取默认值(`node`→`persistent`,`python`→`oneshot`)。为保持旧插件行为，**未声明 `lifecycle` 的 Python 插件保留 legacy 兼容：随 LyShell 启动运行一次**；显式 `lifecycle='oneshot'` 才采用新语义，仅在用户手动「运行」时触发一次后退出，`activationEvents`（包括 `onStartup`/`*`）不生效。`pythonTimeoutMs` 对两种 Python 单次运行均生效；需要常驻或事件驱动请用 `persistent`。

## 7. 鉴权:复用 + 加一档

复用现有 `global` / `session` token(见 `mcp/auth.ts`),新增第三档 `plugin`:

| token 档 | 谁用 | 能力来源 | 生命周期 |
|---|---|---|---|
| `global`(已有) | 浏览器/外部 agent(读 port 文件) | 用户在设置里授予的 capability 子集 | LyShell 运行期 |
| `session`(已有) | LyShell 内部 PTY 孵出的 agent | 该 PTY 会话 scope | PTY 关闭即撤销 |
| `plugin`(新增) | plugin host 里的 contributor 插件 | 清单声明 + 用户批准 | 插件启用/禁用 |

关键约束:**进程内插件不能比进程外 client 权限大**,统一受 capability 控制;`plugin` token 绑定插件 id + capability 子集,审计可溯源(复用现有 MCP 审计面板)。

## 8. 插件生命周期:安装 / 卸载 / 启用 / 禁用

清单(§6)描述插件"是什么";本节规定插件"怎么进来、怎么出去"。核心原则:**注册表与插件文件夹分离** -- 启用/禁用不碰文件夹,卸载才删。

### 8.1 物理形态与目录布局

插件 = 一个文件夹,含 `lyshell-plugin.json` + `dist/`(入口)+ 可选 assets。

```
{userData}/plugins/
  registry.json              ← 安装状态真相源(见 8.2)
  my-rdp-connector/          ← 用户级插件,跨会话可用
    lyshell-plugin.json
    dist/index.js
  terminal-stats/
    lyshell-plugin.json
    dist/index.js

{resourcesPath}/builtin-plugins/   ← 随 app 打包的内置插件(如未来 stdio-mcp 传输本身)
```

**dev 插件**:指向任意本地开发路径,不复制,文件变更热重载(对齐 VS Code Extension Development Host)。`registry.json` 里记 `path`(绝对)+ `dev: true`。

### 8.2 注册表:`{userData}/plugins/registry.json`

安装状态的真相源,与插件文件夹分离。启用/禁用只翻转 `enabled`,不动文件夹;卸载才删文件夹 + 移记录。

```jsonc
{
  "plugins": [
    {
      "id": "my-rdp-connector",
      "version": "1.0.0",
      "path": "my-rdp-connector",        // 相对 plugins/,或绝对路径(dev)
      "dev": false,
      "enabled": true,
      "grantedCapabilities": ["sessionControl"],  // 安装时用户批准(见 §7 plugin 档)
      "installedAt": "2026-07-15T08:00:00Z",
      "source": "local-file"             // local-file | url | builtin | dev
    }
  ]
}
```

存储对齐现有模式:新增 `storage/plugin-repository.ts`(仿 `agent-repository.ts`)管 `registry.json`;插件资产放 `{userData}/plugins/`,JSON 状态放 `registry.json`。

### 8.3 安装流程

```
来源(local-file / .lyshell-plugin 压缩包 / URL 下载)
  → 解压/复制到 {userData}/plugins/{id}/
  → 读 lyshell-plugin.json,校验:
      · engines.lyshell 版本兼容
      · capabilities 声明合法
      · (可选)签名校验
  → 展示权限请求:UI 列出插件要的 capability,用户批准   ← plugin token 授予点(§7)
  → 写 registry.json(enabled 默认 false,或按用户选择)
  → 按 activationEvents(§6)延迟激活
```

打包格式:`.lyshell-plugin` = zip,含清单 + dist + assets。**C4b 已落地**(2026-07):`adm-zip` 读 zip + `extractZipSafely` 逐 entry zip-slip 防护(拒 `../`/绝对路径/盘符/符号链接)+ `downloadZip` URL 流式下载(50MB 上限 + 跳转 + 超时);manifest 必须在 zip 根(无外层包裹,对齐 vsix)。详见 §11 C4b。

### 8.4 卸载流程(三步撤销,缺一不可)

```
1. 停止运行:plugin host 进程 kill + dispose 已激活的插件实例
2. 撤销贡献:
     · registry.unregister(pluginId)      ← 移除其贡献的 route
     · MCP 工具列表更新(API_ROUTES 投影重算,见 §9)
     · revokePluginToken(pluginId)        ← 撤销 plugin token(§7)
3. 删除:删 {userData}/plugins/{id}/ + 从 registry.json 移记录
   + 审计落盘(复用现有 MCP 审计面板)
```

**安全核心是第 2 步**:只删文件夹不撤 route/token,残留的 route 仍可被调、token 仍有效 -- 必须先撤后删。

### 8.5 启用 / 禁用 / 更新(不卸载)

- **禁用**:停进程 + 撤 route/token,但**保留文件夹和 registry 记录**(`enabled: false`)。
- **启用**:按 activationEvents 重新激活。
- **更新**:版本检查 → 重走安装流程(覆盖 dist)+ 更新 registry version;新版本新增的 capability 需用户重新批准。
- **生效方式**:install/enable/disable/uninstall 后调 `pluginHostManager.restart()`(= stop + start)使 registry 变更生效。当前为**全量重启**(kill 整个 node host + 撤全部 token + 重 spawn),对齐 VS Code「重载窗口」-- 简单且无残留状态,代价是插件多时开销偏大、快速来回切换有瞬时状态(靠 exit handler 闭包捕获保证正确性)。此为刻意取舍,增量激活(仅 python 变更不重启 node host / 经 host IPC 单独 deactivate node 插件)列为后续优化。

### 8.6 生命周期状态机

```
            安装(批准权限)
  未安装 ─────────────────► 已安装(禁用)
                               │  启用
                               ▼
                          已启用(待激活)──activation event──► 运行中
                               ▲  禁用(停+撤)                     │
                               └─────────────────────────────────┘
                               │  卸载(停+撤+删)
                               ▼
                            未安装
```

### 8.7 UI 与衔接

- **UI**:Settings 加"插件"面板(仿 VS Code Extensions 视图):列表 / 安装(选本地文件)/ 卸载 / 启用禁用 / 查看权限。入口挂在现有设置页。
- **鉴权**:复用 §7 的 `plugin` token 档(`bindPluginToken` / `revokePluginToken`)。
- **审计**:安装/卸载/权限授予复用现有 MCP 审计面板落盘。
- **进程**:卸载的"停进程"由 plugin-host mgr 负责(管 host 子程生命周期,见 §11 Step 3)。

### 8.8 取舍

- **不做中央市场**:LyShell 是本地工具,安装来源就 local-file + URL,不搞 Marketplace。
- **不做强沙箱**:插件跑独立子进程(plugin host),崩溃隔离已够;靠 capability + 用户批准 + 审计兜底,不引入 vm sandbox。
- **dev 优先**:dev 插件 + 热重载先行,降低写插件成本。

## 9. MCP 模块的演变

现状 `mcp/` 名不副实:它装着 HTTP API + auth,但这两样本是通用底座,不只服务 MCP。新架构让命名与职责对齐 -- **MCP 从"一个模块"降级为"一种传输协议"**。

```
【现状】                              【新架构】
mcp/                                  api/  (从 mcp/ 提升,公共底座)
  http-server.ts    ─────扩大────▶     registry.ts        ← 新核心
  auth.ts           ─────平移────▶     auth.ts            ← +plugin 档
  types.ts                              transport-http.ts  ← 原 http-server.ts
  destructive-check.ts ──平移─▶         transport-mcp.ts   ← 原 mcp-server/(stdio 传输)
  glob.ts            ──平移─▶           transport-rpc.ts   ← 新,plugin host 用
                                        destructive-check.ts
mcp-server/                             glob.ts
  index.ts          ──成为传输──▶     plugin/
  tools.ts          ──从registry派生▶    host.ts / manifest.ts
  http-client.ts
```

- `mcp/http-server.ts` -> `api/transport-http.ts`:提升为 HTTP/SSE 传输层,服务所有进程外 client。
- `mcp/auth.ts` -> `api/auth.ts`:提升为通用鉴权层,加 `plugin` 档。
- `mcp-server/`(stdio adapter)-> `api/transport-mcp.ts`:变成 stdio MCP 传输适配器,**不消失**,工具定义从 registry 派生。可视为内置传输:registry 里标了 `transports: ['stdio-mcp']` 的 route 才出现在 MCP 工具列表。 ✅(Step 1.5 已落地此投影:`MCP_TOOL_DEFINITIONS = API_ROUTES.filter(transports ∋ 'stdio-mcp')`,见 `@shared/api-routes.ts`。)

**渐进策略**:Step 1/1.5 已抽逻辑、不改名(文件仍留 `mcp/` 下,行为零变化),等 Step 3 做 plugin host 时再统一把 `mcp/` 重组为 `api/`。

## 10. 与现有代码的合并点

| 现有文件 | 现状 | 改造 |
|---|---|---|
| `mcp/http-server.ts` | 硬编码 `if/switch pathname`(~500-501 行) | 从 ApiRegistry 派生路由;放开 CORS(白名单 origin)+ `/api/auth/handshake` 授权端点 |
| `mcp-server/tools.ts` + `getApiPath()` | ~~静态数组 + 静态 map~~ -> 已派生(Step 1.5) | 从 `@shared/api-routes` 投影 `TOOL_DEFINITIONS` + `PATH_BY_NAME` ✅ |
| `mcp/auth.ts` | `global`/`session` 两档 | 加 `plugin` 档:`bindPluginToken(pluginId, capabilities)` |
| `python/engine.ts` | `LyShell` API 占位(execute 只 print) | 成为 plugin-host 的 Python runtime,API 走 RPC 回 main(接通 session-manager) |
| `terminal/session-manager.ts:279` | `switch(type)` 硬编码分派 | 改成 `connectorRegistry.get(type)`(连接器插件化的前置) |
| **(新)** `plugin/registry.ts` | - | ApiRegistry 核心抽象 |
| **(新)** `plugin/host.ts` | - | 插件宿主(独立子进程,对齐 VS Code 隔离模型) |
| **(新)** `plugin/manifest.ts` | - | `lyshell-plugin.json` 解析 + activation 调度 |

## 11. 落地阶段(渐进,每步可独立交付)

**Step 1 - 抽 ApiRegistry(纯重构,零行为变化)** ✅ 已完成(2026-07)
新增 `@shared/api-routes.ts` 作为路由元数据真相源(`name/path/method/capabilities/annotations`);`mcp-server/index.ts` 的 `getApiPath()` 从 `PATH_BY_NAME` 派生,消除手写静态 map;`McpCapability` 类型集中为唯一来源。
**范围调整**:http-server 路由层鉴权改 lookup(`http-server.ts` 的 `if/switch pathname` 未动)推迟到 Step 3 -- 探索后发现 HTTP 路由与 MCP 工具非 1:1(list_sessions->GET+POST、execute_command->execute+execute-stream、4 个非工具资源路由),且 schema/annotations 当时仅存 tools.ts 无实际重复,强行改 lookup 违反"零行为变更、低风险"原则。验证:typecheck/lint/test/build/build:no-mcp 全过。

**Step 1.5 - MCP 传输投影(纯重构,零行为变化)** ✅ 已完成(2026-07)
`api-routes.ts` 升级为完整真相源(加 `transports`/`title`/`description`/`inputSchema`/`outputSchema` + `TransportKind`/`McpToolDefinition` 类型,迁入 tools.ts 的 19 条 schema 与子片段);`tools.ts` 退化为 `MCP_TOOL_DEFINITIONS = API_ROUTES.filter(r => r.transports.includes('stdio-mcp'))` 的纯投影(1047 -> 73 行)。**MCP 在代码上字面体现为"一种传输"**(见 §9)。投影只 pick MCP 标准字段,路由元数据不泄露给客户端。验证同上全过。**迁移契约经 `src/main/mcp-server/tools.test.ts` 12 条不变量测试锁住**(纯逻辑无 IO):TOOL_DEFINITIONS 与 MCP_TOOL_DEFINITIONS 逐字段相等、API_ROUTES[stdio-mcp] 与投影双向一一对应、投影字段与源路由同引用(防迁移中 schema 被复制改写)、不泄露 path/method/capabilities/transports、PATH_BY_NAME 覆盖全部 name、19 个 lyshell_ 工具名齐全(防静默删除)、14 旧名别名映射正确 + 4 个 HIDDEN 名(execute/stream 新旧名)。此前迁移零回归测试,现补齐。

**Step 2 - 浏览器/agent 接入(consumer 层)**
auth.ts 加 `plugin` 档 token ✅(随 Step 3 切片 B 落地:`TokenKind` 加 `'plugin'`、`bindPluginToken`/`revokePluginToken`、http-server `authorizeMcpOperation` plugin 路径);http-server 放开 CORS(白名单)+ 授权握手端点(浏览器 UI 点"允许"换一次性 token)⏳ 未做。出 TypeScript SDK 核心包,Python/Node 适配。此时浏览器、桌面 agent、独立脚本全部可用。

**Step 3 - plugin host(contributor 雏形)**
起独立 Node 子进程(复用 mcp-server 的 `LyShellHttpClient` 连回 main HTTP,main 经 env 注入 port + per-plugin token),加载 `lyshell-plugin.json`,实现 activation events,给插件受控 API 对象。把 `python/engine.ts` 接进来作为 Python runtime,接通占位的 `execute/send/wait_for`。

**切片进度**:
- ✅ 切片 A(数据层,2026-07):`@shared/plugin-types.ts`(manifest + `validateManifest` + `PluginRegistryEntry` + `PluginSpec`)+ `plugin-repository.ts`(registry.json 原子落盘)+ 13 测试。
- ✅ 切片 B(鉴权层,2026-07):`auth.ts` 加 plugin token 档 + `http-server.ts` `authorizeMcpOperation` plugin 路径(按 `grantedCapabilities`,不受 `allowExternalMcpClients`/`settings.allow*` 约束)+ 7 测试。plugin token 此前为 dead code,切片 C1 起 host 调用。
- ✅ 切片 C1(host 骨架,2026-07):`electron.vite.config.ts` 加 `pluginHost` 子进程 bundle 入口(disableMcp 排除);`plugin-host/index.ts` 子进程入口(`child_process.fork` + `ELECTRON_RUN_AS_NODE`,回连 HTTP + healthCheck + 打印 specs + 等 SIGTERM);`plugin/host-mgr.ts` 主进程 mgr(per-plugin `bindPluginToken` + spawn + stop 撤 token);`mcp-noop/auth.ts` 补 stub 保 build:no-mcp 兼容。验证:typecheck / lint(0 err) / test(63) / build(`pluginHost.js` 2KB + 共享 `http-client` chunk) / build:no-mcp 全过。**管道打通,但未加载插件 main / 未激活**(C2)。
- ✅ 切片 C2(加载/激活,2026-07):`@shared/plugin-api.ts`(`LyShellPluginApi` + `PluginModule` 契约)+ `plugin-host/api.ts`(`createPluginApi`:per-plugin `LyShellHttpClient` + 候选级 capability gate + `:id` 路径替换,与 mcp-server 特殊分支对齐)+ `plugin-host/index.ts` 读 manifest -> `require(main)` -> `activate(api)`,`onStartup`/`*` 立即激活、`onCommand`/`onConnectionType` 标记 pending、退出 best-effort `deactivate`。新增 `vitest.config.ts`(配 `@shared`/`@main`/`@` alias,此前不存在因现有测试都用相对路径)+ 7 测试。验证:typecheck / lint(0 err) / test(70) / build / build:no-mcp 全过。**插件 `main` 现在真正被执行**;已端到端实测通过(造 dev-echo 插件;顺带修复 C1 的 `fork` IPC bug -> 改 `spawn(process.execPath)`:fork 强制 stdio 含 IPC 通道,本 host 无需父子 IPC;实测验证 registry→manifest→bindPluginToken→spawn→回连 HTTP→require→activate→`api.call('lyshell_list_sessions')` 返回真实会话 + capability gate 拒越权调用 全链路)。**审查修复**:(1) token 改经 IPC(`child.send`)下发不落 env -- 原 `LYSHELL_PLUGIN_SPECS` env 含所有插件 token,插件 `process.env` 可窃取他插件 token 越权(§7);IPC 后 host 内存持有 + api 对象不暴露 token,实测 `env LYSHELL_PLUGIN_SPECS=<undefined>`。(2) host 脚本路径改 `app.isPackaged` 分支(对齐 `getMcpServerScriptPath`);`dist:win` + asar 探针实测 `ELECTRON_RUN_AS_NODE` 可读 asar 内脚本 ✅,顺带发现并修复 host/mcpServer 打包路径 `'app'`->`'app.asar'` bug(打包后 app 在 resources/app.asar,旧路径 ENOENT 致打包版 node 插件 host / MCP server 静默起不来)。(3) `isRunning` 用 `exitCode`/`signalCode` 判活;healthCheck 注释修正(token 实际未参与 `/api/health` 鉴权)。
- ✅ 切片 C3(python runtime,2026-07):`python/engine.ts` 的 `LYSHELL_API` 占位(`execute/send/wait_for` 只 print)接通为真实 HTTP 回连 -- 标准库 `urllib` POST `127.0.0.1:{LYSHELL_MCP_PORT}`,header `X-LyShell-Token=LYSHELL_PLUGIN_TOKEN`,解包 `{success,data,error}`(`success:false` 抛 `LyShellError`);补 `send_and_wait`/`read_output`/`list_sessions`;缺 token/port 抛错(裸脚本引擎未注入 token 时不可用)。`host-mgr.ts` 加 python 分支:收集 python 插件 -> `bindPluginToken` -> `pythonEngine.execute(mainCode,{env:port+token+pluginId+pluginDir,cwd:pluginDir})` fire-and-forget 激活;抽 `spawnNodeHost`/`activatePython`,`activePluginIds` 覆盖 node+python 供 stop 统一撤 token。**进程模型**:python 插件 oneshot 脚本(`main.py` 经 `execute()` 前置注入 `LYSHELL_API`,`lyshell` 全局可用);每插件独立 python 子进程 -> token 落 env 安全(单插件单进程无兄弟插件可窃,不同于 node host 多插件共享进程需 IPC 下发 token)。python 为 oneshot 模型(onStartup/* = 启动跑一次而非常驻,长驻/事件驱动需 node 运行时);超时经 manifest.pythonTimeoutMs 可配(默认 120s、上限 600s)。验证:typecheck / lint(0 err) / test(70) / build / build:no-mcp 全过。**端到端实测**:造 dev-py-echo 插件(runtime:python,main.py 调 `lyshell.list_sessions(includeAll=True)`),dev server 启动 -> host-mgr bindPluginToken(dev-py-echo,read)-> activatePython -> python `main.py` 用 **plugin token** 回连 HTTP -> http-server plugin 路径(`capabilities.includes('read')`)放行 -> 返回 46 真实会话,381ms exit 0,审计入库。另隔离实测 `LYSHELL_API`(源码直抽)用 global token 打真服务器同样返回 46 会话,证 HTTP 契约/header/响应解包正确。
- ✅ 切片 C4(IPC + 插件管理 UI,2026-07):dev 文件夹安装 + 全生命周期(启用/禁用/卸载/list)+ Settings「插件」页签 + 审计复用。**安装来源 = dev 文件夹**(用户确认;`.lyshell-plugin` zip + URL 留下一切片,需加 zip 依赖 + zip-slip 防护)。后端四件套:`@shared/plugin-types.ts` 加 `PluginListItem`/`PluginInstallDevRequest`/`PluginPickResult` 视图类型;`handlers.ts` 加 `plugin:list`/`plugin:pick-folder`(`dialog.showOpenDialog` 选目录 -> `validateManifest`)/`plugin:install-dev`(upsert `{dev:true,path:绝对,source:'dev'}`,grantedCapabilities 强制 ∩ manifest.capabilities 防越权)/`plugin:enable`/`plugin:disable`/`plugin:uninstall`(§8.4 三步撤销:remove -> restart -> 非dev删文件夹;dev 不删源码树);`preload/index.ts` 加 `PLUGIN_*` 通道 + bridge。生命周期变更经 `pluginHostManager.restart()` 生效。`host-mgr.ts` 加 `restart()`(=stop+start),**顺带修 exit/error handler 闭包 bug**:旧 child 异步退出时 `if (this.child === child) this.child = null` 判当前,否则 restart 间会误 null 掉已重新 spawn 的新 host。前端:`stores/plugin-store.ts`(Zustand,镜像 locale/theme-store 形态,写操作后自动 `load()`)+ `components/Layout/PluginPanel.tsx`(添加 dev 插件按钮 -> 选文件夹 -> 权限确认卡 -> 安装;列表:开关/卸载二次确认/runtime+dev 徽标/capability 标签[granted=amber,declared=划线])+ `MainWindow.tsx` settingsTab 加 `'plugin'` 页签(grid 同格重叠 `invisible` 切换,对齐 terminal/mcp)+ i18n。审计复用 `mcpAuditRepository.append(operation='plugin:install/enable/disable/uninstall')`,现有 MCP 审计面板可见。**安全**:dev 卸载只删记录不删源文件夹;grantedCapabilities ⊆ manifest.capabilities(交集);folder picker 走原生 dialog(renderer 不可注入任意路径)+ isAbsolute 校验。验证:typecheck / lint(0 err) / test(70) / build / build:no-mcp 全过。**端到端待手动点测**:安装/启用/禁用/卸载为 UI 驱动(renderer->main IPC),需在 dev server Settings 插件页签手动走一遍(造 dev-py-echo -> 安装 -> 启用看 host 激活 -> 禁用/卸载 -> 审计面板核对)。

**第二轮审查修复**:(1) no-mcp 构建下插件页签静默失效 -- 插件能装进 registry 但 `start()` 经 `getMcpHttpPort()=null` 短路永不激活,用户"装了没反应"。修:把 `__DISABLE_MCP__` define 也加到 renderer(electron.vite.config.ts),MainWindow `SETTINGS_TABS` 据此在 no-mcp 构建隐藏 plugin 页签(经 vite define + minify 消除分支),从入口杜绝困惑。(2) `createPluginApi` GET 路由丢弃额外参数 -- `:id` 分支算了 `rest` 但 `client.get(path)` 不带 query,未来 GET 路由加查询参数会被静默丢。修:GET 时把剩余参数(`buildQuery` 仅展平原始值,跳过 undefined/对象)拼成 query string;当前唯一 GET 路由 read_session_notes 无额外参数,行为不变。新增 1 测试锁定。**已确认的非问题(取舍/未来)**:python oneshot `stop()` 不主动 kill(靠 token 撤销 401 自退,长 sleep 滞留至 pythonTimeoutMs,§6 oneshot 模型);`restart()` 全量重启(§8.5 刻意取舍,增量留 TODO);卸载 `fs.rmSync` 的 zip-slip 防护**已随 C4b 落地**:`assertUnderBase` 删前断言 pluginDir ⊆ pluginsDir(纵深防御),解压根因防护在 `extractZipSafely` 逐 entry 校验。

**切片 C4b(zip + URL 安装,2026-07)**:补齐 C4 安装故事的 zip/URL 来源。新增 `src/main/plugin/install-zip.ts`:`readManifestFromZip`(读 zip **根** manifest 不解压,供预览权限卡)、`extractZipSafely`(逐 entry zip-slip 防护 + 自写 safe path,不信任库拼接)、`assertSafeEntryName`(entry 名校验,导出供单测)、`downloadZip`(http/https 流式,≤5 跳转,50MB 上限 Content-Length 预检 + 运行字节计数,30s 超时,仅 http/https 协议)、`assertUnderBase`(路径包含断言)、`cleanupDownloadsDir`(退出清理临时下载)。IPC 三件套:`plugin:pick-file`(dialog 选 .lyshell-plugin/.zip -> 读根 manifest 不解压)/`plugin:fetch-url`(下载到 `{pluginsDir}/.downloads/<uuid>.zip` -> 读根 manifest 预览)/`plugin:install-zip`(清旧 dest[assertUnderBase]->`extractZipSafely`->落盘复验 manifest->`upsert({dev:false,path:id 相对,source})`->restart->审计;url 源消费后删临时文件);`plugin:uninstall` 的 `fs.rmSync` 前 +`assertUnderBase` 兜底。`preload`/`plugin-store`/`PluginPanel` 三入口(+ Dev / 文件 / URL),URL 内联输入 + Fetch,权限卡加来源徽标,安装按来源走 `installDev`/`installZip`。`main/index.ts` will-quit 调 `cleanupDownloadsDir`。zip 库选 `adm-zip`(可读单 entry 预览 + 逐 entry 自控校验 + 测试可现造恶意 zip;纯 JS bundle 进 main,无 externalize)。**安全**:zip-slip 两道防护(解压根因 `extractZipSafely` 逐 entry 校验 + 卸载纵深 `assertUnderBase`);manifest 必须在 zip 根;URL 仅 http/https + 大小上限防 SSRF/耗尽;grantedCapabilities ⊆ manifest.capabilities(交集);dev 卸载仍只删记录不删源文件夹。验证:typecheck / lint(0 err)/ test(+21 = 全套绿)/ build / build:no-mcp(adm-zip 正确 bundle,no-mcp 页签仍隐藏)全过。**端到端待手动点测**:造 .lyshell-plugin zip(根 manifest + dist)-> 文件安装 -> 启用 -> 卸载;URL 安装同;造含 `../` 恶意 zip 验证被拒。

**审查硬化(4 项)**:① 取消 URL 安装即时删临时文件(`plugin:cancel-download` + `safeDeleteDownload`,assertUnderBase 兜底防越界),不再累积到退出;② 本地 zip 大小上限(`assertZipFileSize` 守 `readManifestFromZip`/`extractZipSafely`,防 `new AdmZip` 全量载入 + `entry.getData()` 全量解压耗尽内存);③ registry 记录改用落盘后权威 `onDisk.manifest` 构建(非预览副本)+ id 一致性防御;④ 下载 `req.on('error')` 经 hoisted `settled` 守卫,与 fail/done 一致防重复 settle。

**审查硬化(第二轮 3 项)**:⑤ 覆盖安装改 staging + 原子换入(`atomicSwapPlugin`):解压/复验只动 `.staging-{id}` 兄弟目录,成功后才 `destDir->trash` + `staging->destDir` 原子换入,失败则旧版本经 trash 回滚 -- 修复"更新失败毁掉旧版本、registry 指向空目录致插件静默不加载";⑥ main 入口预检(声明 `main` 但 zip 内缺失 -> 警告 `[main missing]`,不阻断,镜像 dev-install 宽松);⑦ 下载跳转禁 loopback/link-local 主机(`isLoopbackOrLinkLocalHost`:127.0.0.0/8、::1、localhost、169.254.0.0/16、fe80::/10;防 redirect SSRF 探测 `127.0.0.1:{mcpPort}`/云元数据;私有网段 10/172.16/192.168 放行供 LAN 托管)。

**审查硬化(第三轮 1 项)**:⑧ `manifest.main` 入口包围:`isUnsafeRelativePath`(共享于 `@shared/plugin-types`,与 `assertSafeEntryName` 同源)在 `validateManifest` 拒 `..`/绝对/盘符 `main` -- 安装时即拒并 surfaced 到权限卡;node host(`plugin-host/index.ts`)与 python host(`host-mgr.ts`)在 require/readFileSync 前对 `spec.main`/`manifest.main` 再兜底校验。此前 `main` 仅类型检查,一个 zip 可带良性可审 `dist/main.js` 却令 manifest `main` 指向他处 -- "用户审阅的 zip 内容即所执行"这一信任假设被打破(C4b 引入不可信 zip/URL 来源后 newly exploitable)。两 host 均重读 manifest 经 `validateManifest`,故安装时拦截自动传导至加载时,host 兜底为防御纵深。

**审查硬化(第四轮 1 项)**:⑨ zip-bomb / 解压无上限:`entry.getData()` 先 `Buffer.alloc(header.size)`(声明尺寸)再整块解压入内存,无解压上限 -- deflate 压缩比可达 ~1000:1,50MB 压缩包可解出数十 GB 致 OOM/卡死;两处均中招:`extractZipSafely`(解压)与 `readManifestFromZip`(预览阶段,用户确认前 -- 一个命名为 `lyshell-plugin.json` 的解压炸弹在点"Fetch"预览时即 OOM)。修:流式解压替代两处 `getData()` -- `makeDecompressionSource`(method 0 STORED 用 `Readable` 单块推送 / method 8 DEFLATED 用 `createInflateRaw` 接 `getCompressedData()` 的 raw deflate),`writeEntryCapped`(写文件)/`readEntryBytesCapped`(读清单)逐块字节计数 + CRC32 校验(CRC 实现与 `adm-zip util/utils.js` 完全一致,保留原 `getData` 的 `crc32OK` 完整性语义)。三道闸:(a) **声明尺寸预检** -- 解压前对 `entry.header.size` 求和,单条 > 200MB 或总和 > 500MB 即拒(诚实 zip-bomb 快速失败,不碰盘/不分配);(b) **流式字节计数回退** -- 谎报 header(声明小、实际大)绕过预检时,流式解压累计超 200MB/条或 500MB 总量即中止(最难绕过);(c) **清单 1MB 上限**(`readEntryBytesCapped`)。另:拒加密条目(`getData` 需口令,流式不处理)与未知压缩法(对齐 adm-zip `UNKNOWN_METHOD`),保留原行为。`ZipBombError` 新增;`readManifestFromZip` 改 async(压缩侧仍受 50MB `assertZipFileSize` 约束,流式只约束解压侧);`handlers.ts` 解压 catch 映射 `ZipBombError` -> `zip-bomb 拒绝: ...`。验证:typecheck / lint(0 err)/ test(+6 = 139)/ build / build:no-mcp 全过。

**Step 4 - 插件贡献点**
插件 `registry.register()` 贡献新 route,自动出现在 HTTP/stdio-MCP/in-proc 三路上。声明式 UI 贡献(命令、连接类型、快速命令、状态栏入口)按需加。连接器插件化(session-manager switch -> connectorRegistry)在这里落地。

**最小可验证里程碑**:Step 1 + Step 2 的浏览器 CORS/握手。做完即有"浏览器能控制 LyShell 终端"的 demo,且底层已是插件化架构。

## 12. 取舍与风险

- **plugin host:独立子进程 vs in-proc vm**。推荐独立子进程(对齐 VS Code,崩溃隔离),代价是 IPC 开销。in-proc vm 仅用于受信任的内置插件。
- **asar 打包**:in-process 插件 `require` 外部模块要 `asar.unpack`;进程外 client 和独立子进程不受影响。Step 3 用子进程正好绕开。
- **mcp-server 子进程模式可复用**:它已是"独立进程 + discoverLyshell + http-client"的范例,plugin host 直接抄这套接入模式。
- **API 契约稳定性**:一旦 Step 4 开放,ApiRoute 定义就是公开契约,需版本化(`engines.lyshell`)和 deprecation 机制(现有 `ALIAS_TO_NEW` 是该思路雏形)。
- **不照搬 VS Code 的市场信任模型**:LyShell 是本地工具,走 capability + 用户批准,而非"装了就信"。
- **卸载必须三步撤销**(§8.4):停进程 -> 撤 route/token -> 删文件夹。只删文件夹会留下可被调用的残留 route 和有效 token,是安全漏洞。
