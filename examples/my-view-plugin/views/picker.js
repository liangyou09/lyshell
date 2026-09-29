// picker 视图逻辑：列出会话（callApi，read），点选后 closeDialog 回传结果。
// closeDialog 仅弹窗 guest 有效；结果经 dialogResult 事件送回发起 guest。
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var lv = window.lyshellView

  // 主题适配：bootstrap 返回当前明暗模式，切换时经 themeChanged 事件推送
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
  }

  window.addEventListener('DOMContentLoaded', function () {
    if (!lv) {
      $('info').textContent = 'window.lyshellView unavailable'
      return
    }
    lv.bootstrap()
      .then(function (boot) {
        applyTheme(boot.theme)
        $('info').textContent =
          boot.kind === 'dialog'
            ? 'dialog ' + boot.dialogId + ' — pick a session, or cancel'
            : 'panel mode（用 status 视图的 openDialog 按钮以弹窗打开本视图）'
      })
      .catch(function (e) {
        $('info').textContent = 'bootstrap failed: ' + (e && e.message ? e.message : e)
      })

    lv.callApi('lyshell_list_sessions', {})
      .then(function (data) {
        var sessions = (data && data.sessions) || []
        var list = $('list')
        list.textContent = ''
        if (!sessions.length) {
          list.textContent = 'no sessions'
          return
        }
        sessions.forEach(function (s) {
          var btn = document.createElement('button')
          btn.type = 'button'
          btn.textContent = s.name + ' [' + s.type + ']'
          btn.addEventListener('click', function () {
            lv.closeDialog({ picked: s.id, name: s.name })
          })
          list.appendChild(btn)
        })
      })
      .catch(function (e) {
        $('list').textContent = 'callApi failed: ' + (e && e.message ? e.message : e)
      })

    $('cancel').addEventListener('click', function () {
      lv.closeDialog(null)
    })

    lv.onEvent(function (evt) {
      if (evt.type === 'themeChanged') {
        applyTheme(evt.theme)
      }
    })
  })
})()
