// my-node-plugin: LyShell Node 插件 demo
//
// node runtime 的所有插件共享一个**常驻** host 子进程,适合做长驻/定时/事件驱动的活
// (python 是 oneshot,跑完即退,不能常驻)。
//
// 契约:host 在 onStartup/* 激活时调 activate(api);api.call(toolName, args) 调
// lyshell 工具,toolName 是 API_ROUTES.name(lyshell_ 前缀),返回 HTTP 响应的 data 字段。
// 日志走 console.error(stderr) -- host-mgr 只捕获 host 的 stderr 转 electron-log,
// console.log(stdout) 会丢。
//
// 本 demo:激活时巡检一次会话 + 起 30s 定时器持续巡检(展示 node 长驻);deactivate 清理。

let api
let timer

async function snapshot() {
  try {
    const { sessions } = await api.call('lyshell_list_sessions', { includeAll: true })
    const connected = sessions.filter((s) => s.status === 'connected')
    console.error(`[my-node-plugin] snapshot: ${sessions.length} total, ${connected.length} connected`)
    for (const s of connected) {
      const out = await api.call('lyshell_read_output', { sessionId: s.id, lines: 3 })
      const last = String(out.output || '').trim().split('\n').pop()
      console.error(`[my-node-plugin]   ${s.name} [${s.type}] last: ${last}`)
    }
  } catch (e) {
    console.error('[my-node-plugin] snapshot error:', e?.message || e)
  }
}

async function activate(pluginApi) {
  api = pluginApi
  console.error(`[my-node-plugin] activated (caps: ${[...api.grantedCapabilities].join(', ')})`)
  await snapshot()
  // 长驻:每 30s 巡检一次(node host 常驻,适合定时任务;python oneshot 做不到)
  timer = setInterval(snapshot, 30000)
}

function deactivate() {
  if (timer) clearInterval(timer)
  console.error('[my-node-plugin] deactivated')
}

module.exports = { activate, deactivate }
