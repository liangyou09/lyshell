// 源码 PS7 终端启动器逻辑（两个 src-ps7 插件共用同一份，差异全在 config.js）。
//
// 流程：点机柜轨图标 → 面板可见（首次挂载 / 切回）→ 找/建保存会话 → openTerminal。
//   1. list_sessions(includeAll, search) 按 sessionName 精确匹配找保存项（应用重启后
//      页面重载也要能找到上次建的那条，避免每次点图标都往侧栏堆一条同名会话）。
//   2. 找不到才 create_session(type=local, connect:false) 建保存项；userConfirmed
//      由「用户点图标 / 点按钮」这次显式动作充当 —— 本页是固定目标的启动器，
//      不是可编排的 agent，目标路径写死在 config.js。
//   3. openTerminal(sessionId) → main 核对授权 → renderer 以 runtime 克隆连接并
//      挂到活动分屏（每次调用一个新终端页签）。
//   自动触发时若该会话已开在终端里（inTerminal）则跳过，避免反复点图标堆页签；
//   「打开 PS7 终端」按钮始终再开一个。
//
// 保活语义：面板首次打开后常挂载，切走仅 display:none。visibilitychange 回到
// visible 即再次触发 —— 这就是「点图标就展开终端」的重复入口。
// 领头分号：与 config.js 是两次独立 <script> 解析，但防御性隔断，避免任何拼接场景 ASI 粘连。
;(function () {
  'use strict'

  var cfg = window.LAUNCHER_CONFIG
  var lv = window.lyshellView
  var $ = function (id) { return document.getElementById(id) }
  var statusEl = $('status')
  var busy = false
  var lastFire = 0

  function setStatus(text, isErr) {
    statusEl.textContent = text
    statusEl.className = isErr ? 'err' : ''
  }

  function errMsg(e) {
    return (e && e.message) ? e.message : String(e)
  }

  /** 按 sessionName 精确查找保存会话（search 是子串匹配，这里再按名精确收窄） */
  function findSaved() {
    return lv.callApi('lyshell_list_sessions', { includeAll: true, search: cfg.sessionName, limit: 100 })
      .then(function (data) {
        var list = (data && data.sessions) || []
        for (var i = 0; i < list.length; i++) {
          if (list[i].name === cfg.sessionName && list[i].type === 'local' &&
              list[i].shell === cfg.shell && list[i].cwd === cfg.cwd) return list[i]
        }
        return null
      })
  }

  /** 建保存项（connect:false —— 只落盘，不连；连接交给 openTerminal 的 runtime 克隆） */
  function createSaved() {
    return lv.callApi('lyshell_create_session', {
      type: 'local',
      name: cfg.sessionName,
      local: { shell: cfg.shell, cwd: cfg.cwd },
      tags: cfg.tags,
      summary: cfg.summary,
      connect: false,
      userConfirmed: true
    }).then(function (data) {
      return { id: data && data.sessionId, name: cfg.sessionName, inTerminal: false }
    })
  }

  /**
   * @param {boolean} force true=无条件再开一个终端页签（按钮）；false=已开则跳过（自动）
   */
  function openPs7(force) {
    if (!lv) return Promise.resolve()
    if (busy) return Promise.resolve()
    busy = true
    $('open').disabled = true
    setStatus('正在展开终端…')
    return findSaved()
      .then(function (saved) { return saved || createSaved() })
      .then(function (saved) {
        if (!saved || !saved.id) throw new Error('未能创建会话')
        if (!force && saved.inTerminal) {
          setStatus('终端已在主区域打开（再点按钮可另开一个）。')
          return
        }
        return lv.openTerminal(saved.id).then(function (r) {
          if (r && r.ok) setStatus('已展开 ' + cfg.shell + ' 终端 → ' + cfg.cwd)
          else setStatus('打开失败: ' + (r && r.error ? r.error : 'unknown'), true)
        })
      })
      .catch(function (e) { setStatus('错误: ' + errMsg(e), true) })
      .then(function () {
        busy = false
        $('open').disabled = false
      })
  }

  /** 自动触发（可见时）：800ms 防抖，挡掉首载 DOMContentLoaded 与 visibilitychange 的双发 */
  function autoFire() {
    var now = Date.now()
    if (now - lastFire < 800) return
    lastFire = now
    void openPs7(false)
  }

  window.addEventListener('DOMContentLoaded', function () {
    var c = cfg || {}
    $('title').textContent = c.sessionName || '源码 PS7'
    $('path').textContent = (c.cwd || '–') + '  ·  ' + (c.shell || 'pwsh')
    if (!lv) {
      setStatus('window.lyshellView 不可用（guest preload 未注入？）', true)
      return
    }
    lv.bootstrap()
      .then(function (boot) {
        document.documentElement.dataset.theme = boot.theme === 'light' ? 'light' : 'dark'
      })
      .catch(function () { /* 主题失败不挡开会话 */ })

    $('open').addEventListener('click', function () { void openPs7(true) })

    // 面板保活：切走 hidden / 切回 visible。回到可见 = 用户又点了一次图标。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') autoFire()
    })

    lv.onEvent(function (evt) {
      if (evt.type === 'themeChanged') {
        document.documentElement.dataset.theme = evt.theme === 'light' ? 'light' : 'dark'
      }
    })

    autoFire()
  })
})()
