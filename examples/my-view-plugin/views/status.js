// status 视图逻辑：bootstrap 握手（身份由 main 登记派生，页面不能自报）→
// callApi 只读工具 → openWebTab / openDialog 动作 → onEvent 接收弹窗结果。
// ok:true 只表示「请求被接受/页签已挂载」，不保证 SSH 最终连通或外站加载成功。
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var lv = window.lyshellView

  // 主题适配：bootstrap 返回当前明暗模式，切换时经 themeChanged 事件推送
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
  }

  function refreshSessions() {
    // callApi 仅允许 http transport 的工具；list_sessions 需要 read capability。
    // 未获授权时 main 拒绝并 reject，错误消息可直接展示。
    return lv.callApi('lyshell_list_sessions', {})
      .then(function (data) {
        var n = data && data.sessions ? data.sessions.length : 0
        $('state').textContent = 'callApi ok: ' + n + ' session(s)'
      })
      .catch(function (e) {
        $('state').textContent = 'callApi failed: ' + (e && e.message ? e.message : e)
      })
  }

  window.addEventListener('DOMContentLoaded', function () {
    if (!lv) {
      $('boot').textContent = 'window.lyshellView unavailable（guest preload 未注入？）'
      return
    }
    lv.bootstrap()
      .then(function (boot) {
        applyTheme(boot.theme)
        $('boot').textContent = boot.pluginId + ' / ' + boot.viewId + ' (' + boot.kind + ')'
      })
      .catch(function (e) {
        $('boot').textContent = 'bootstrap failed: ' + (e && e.message ? e.message : e)
      })
    void refreshSessions()

    $('open-web').addEventListener('click', function () {
      lv.openWebTab('https://example.com')
        .then(function (r) {
          $('state').textContent = r.ok ? 'openWebTab accepted（页签已挂载）' : 'openWebTab failed: ' + r.error
        })
        .catch(function (e) {
          $('state').textContent = 'openWebTab error: ' + (e && e.message ? e.message : e)
        })
    })

    $('open-dialog').addEventListener('click', function () {
      // openDialog 只能打开本插件已注册的视图；成功返回一次性 dialogId。
      lv.openDialog({ viewId: 'picker', title: 'Pick a session', width: 420, height: 340 })
        .then(function (r) {
          $('state').textContent = r.ok ? 'dialog opened: ' + r.dialogId : 'openDialog failed: ' + r.error
        })
        .catch(function (e) {
          $('state').textContent = 'openDialog error: ' + (e && e.message ? e.message : e)
        })
    })

    lv.onEvent(function (evt) {
      if (evt.type === 'dialogResult') {
        $('dialog-result').textContent = JSON.stringify(evt.result)
        void refreshSessions()
      } else if (evt.type === 'dialogCancelled') {
        $('dialog-result').textContent = 'cancelled (' + evt.reason + ')'
      } else if (evt.type === 'themeChanged') {
        applyTheme(evt.theme)
      }
    })
  })
})()
