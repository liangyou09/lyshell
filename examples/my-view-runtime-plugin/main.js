// my-view-runtime-plugin: LyShell Node 常驻插件 + 运行时视图注册 demo
//
// 契约：host 在 onStartup/* 激活时调 activate(api)；api.registerView(def) 动态注册
// 一个机柜轨视图（需要 uiControl 授权 + persistent 生命周期，host token 专有路由）。
//
// 视图来源有两路，同插件合计最多 8 个、ID 不得冲突（冲突注册直接拒绝，不覆盖）：
//   - 声明式：lyshell-plugin.json 的 contributes.views（dashboard / picker）——
//     插件启用即存在，随启用/禁用出现/消失；
//   - 运行时：activate() 里 api.registerView()（launcher）——仅本插件进程期间有效；
//     插件禁用/卸载或 host 退出（含异常退出）即被清除，LyShell 重启后由 activate
//     重新注册（所以本示例用 activationEvents: ["onStartup"] 保证启动即注册）。
//
// 日志走 console.error(stderr)（host 捕获转 electron-log）；console.log 会丢。

let api

async function activate(pluginApi) {
  api = pluginApi
  console.error(`[my-view-runtime-plugin] activated (caps: ${api.grantedCapabilities.join(', ')})`)

  // 运行时注册：校验（字段/路径/文件存在/真实路径包围）在 main 侧统一完成，
  // 失败抛错（4xx 语义消息）。重复注册同一 ID 会失败 —— activate 重放时先注销再注册，
  // 或按下面这样捕获错误降级为告警（声明式视图不受影响）。
  try {
    await api.registerView({
      id: 'launcher',
      title: 'Launcher',
      icon: 'icon.svg',
      entry: 'views/launcher.html'
    })
    console.error('[my-view-runtime-plugin] runtime view "launcher" registered')
  } catch (e) {
    console.error('[my-view-runtime-plugin] registerView failed:', e?.message || e)
  }

  // 照常可用 call()（SDK 工具调用）—— 与视图页面的 callApi 走同一套 HTTP 路由鉴权
  try {
    const { sessions } = await api.call('lyshell_list_sessions', {})
    console.error(`[my-view-runtime-plugin] ${sessions.length} session(s) at activate`)
  } catch (e) {
    console.error('[my-view-runtime-plugin] list_sessions error:', e?.message || e)
  }
}

function deactivate() {
  // 运行时视图不必在此注销：插件进程退出即自动清除（注销可用 api.unregisterView('launcher')）
  console.error('[my-view-runtime-plugin] deactivated (runtime views die with this process)')
}

module.exports = { activate, deactivate }
