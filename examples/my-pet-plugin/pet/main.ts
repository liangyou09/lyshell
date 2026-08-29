// 桌宠 Electron 主进程 -- 参考实现(路线2)
//
// 被 my-pet-plugin/main.js 经 api.spawnControlled 拉起。env 里已注入连接包:
//   LYSHELL_MCP_PORT / LYSHELL_MCP_TOKEN(本插件 token) / LYSHELL_MCP_SERVER_SCRIPT / LYSHELL_ELECTRON_EXE
//
// 本文件用这些 spawn mcpServer.js(MCP SDK StdioClientTransport),像 Claude 一样
// 经 stdio MCP 连 LyShell,持本插件 capability,动态 tools/list + tools/call。
// LyShell 工具变了,下次 listTools 自动跟上。
//
// 这是参考源码:你的桌宠是独立 Electron 应用,把「连接 LyShell」这段接到你的桌宠主进程即可。
// 依赖(桌宠自己的 package.json):electron + @modelcontextprotocol/sdk
// 编译:用你的构建链(esbuild/tsc)把本文件编成 main.js,放到插件目录 pet/main.js。

import { app, BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'path'
import { tmpdir } from 'os'

let win: BrowserWindow | null = null
let client: Client | null = null

/**
 * 用连接包 spawn mcpServer.js,经 stdio MCP 连 LyShell。
 * 没有连接包(独立启动)返回 null -> 桌宠走独立模式,无 LyShell 控制权。
 */
async function connectLyshell(): Promise<Client | null> {
  const port = process.env.LYSHELL_MCP_PORT
  const token = process.env.LYSHELL_MCP_TOKEN
  const script = process.env.LYSHELL_MCP_SERVER_SCRIPT
  const exe = process.env.LYSHELL_ELECTRON_EXE
  if (!port || !token || !script || !exe) {
    console.error('[pet] 未从 LyShell 插件启动(env 缺连接包) -> 独立运行模式,无 LyShell 控制权')
    return null
  }

  // spawn mcpServer.js:用 LyShell 的 electron.exe + ELECTRON_RUN_AS_NODE=1 当纯 Node 跑。
  // 继承 port+token(本插件 token);discoverLyshell 走 env 路径用插件 token 连上。
  // ★本进程 env 里 ELECTRON_RUN_AS_NODE 已被 spawnControlled 清掉(为了 GUI),
  //   这里给 mcpServer.js 子进程显式设回 =1。
  const transport = new StdioClientTransport({
    command: exe,
    args: [script],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
  })
  const c = new Client({ name: 'my-pet-agent', version: '0.1.0' }, { capabilities: {} })
  await c.connect(transport)
  console.error(`[pet] connected to LyShell via mcpServer (port ${port})`)
  return c
}

/** 最小 agent loop:动态拿工具清单 + 对首个连着的会话演示发命令。改成你的 agent 逻辑。 */
async function agentLoop(c: Client): Promise<void> {
  const { tools } = await c.listTools() // 动态工具清单,LyShell 工具变了自动跟上
  console.error(`[pet] ${tools.length} tools available: ${tools.map((t) => t.name).join(', ')}`)

  const r = await c.callTool({
    name: 'lyshell_list_sessions',
    arguments: { includeAll: true }
  })
  console.error('[pet] list_sessions ->', JSON.stringify(r.content).slice(0, 200))

  // 例:对首个连着的会话发命令(需 interactiveWrite capability)
  // const target = (r.content?.[0]?.json as any)?.sessions?.find((s: any) => s.status === 'connected')
  // if (target) {
  //   await c.callTool({ name: 'lyshell_send_and_wait', arguments: { sessionId: target.id, text: 'echo hi-from-pet' } })
  // }
}

app.whenReady().then(async () => {
  // 桌宠与 LyShell 用同一个 electron.exe,给独立 userData 避开单实例锁冲突。
  app.setPath('userData', join(tmpdir(), 'my-pet-plugin'))

  win = new BrowserWindow({
    width: 220,
    height: 260,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  // 你的桌宠 UI;这里用占位 data URL
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-size:64px">🐾</body>'))

  client = await connectLyshell()
  if (client) {
    agentLoop(client).catch((e) => console.error('[pet] agent error:', e))
  }
})

app.on('window-all-closed', () => {
  client?.close().catch(() => {})
  app.quit()
})
