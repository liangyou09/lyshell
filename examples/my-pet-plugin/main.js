// my-pet-plugin: 路线2 桌宠 agent demo —— host 入口
//
// 路线2:插件只当启动器。onStartup 激活时用 api.spawnControlled 拉起桌宠进程,
// spawnControlled 把「连接包」注入桌宠 env:
//   LYSHELL_MCP_PORT / LYSHELL_MCP_TOKEN(= 本插件 token,插件代码看不到)
//   LYSHELL_MCP_SERVER_SCRIPT(mcpServer.js 绝对路径)/ LYSHELL_ELECTRON_EXE(运行它的 electron)
// 桌宠用这些 spawn mcpServer.js,像 Claude 一样经 stdio MCP 连 LyShell(持本插件 capability)。
//
// 安全:token 经 host 内部注入,本文件(插件代码)看不到 token。禁用插件 ->
//   revokePluginToken -> 桌宠的 mcpServer.js 调用即 401,控制权秒收。
//
// 桌宠入口:这里指向同目录 pet/main.js(把 pet/main.ts 编译产物放此,或改成你自己的桌宠入口)。

const { join } = require('path')

let api
let pet

async function activate(pluginApi) {
  api = pluginApi
  const petExe = join(__dirname, 'pet', 'main.js') // 桌宠入口(编译产物)
  // gui:true(默认)清掉 ELECTRON_RUN_AS_NODE,桌宠作为完整 Electron 应用有 GUI。
  // process.execPath = LyShell 的 electron.exe(host 在其下以 RUN_AS_NODE 跑)。
  pet = api.spawnControlled(process.execPath, [petExe], { gui: true })
  console.error(`[my-pet-plugin] spawned pet pid=${pet.pid}`)
  pet.on('exit', (code) => console.error(`[my-pet-plugin] pet exited code=${code}`))
}

function deactivate() {
  if (pet) pet.kill()
  console.error('[my-pet-plugin] deactivated')
}

module.exports = { activate, deactivate }
