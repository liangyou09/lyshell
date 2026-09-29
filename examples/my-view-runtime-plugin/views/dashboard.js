// dashboard 视图逻辑：callApi 列会话（read）→ 每会话一个 openTerminal 按钮
// （uiControl + sessionControl，main 校验真实 saved 会话与 MCP 名单后才派发）。
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var lv = window.lyshellView

  // 主题适配：bootstrap 返回当前明暗模式，切换时经 themeChanged 事件推送
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
  }

  function say(text) {
    $('state').textContent = text
  }

  window.addEventListener('DOMContentLoaded', function () {
    if (!lv) {
      say('window.lyshellView unavailable（guest preload 未注入？）')
      return
    }
    lv.bootstrap().then(function (boot) {
      applyTheme(boot.theme)
      document.querySelector('h3').textContent = 'Dashboard（' + boot.pluginId + ' / ' + boot.viewId + '）'
    })

    lv.callApi('lyshell_list_sessions', {})
      .then(function (data) {
        var sessions = (data && data.sessions) || []
        var ul = $('sessions')
        ul.textContent = ''
        if (!sessions.length) {
          say('no sessions（先在会话面板保存/建立会话）')
          return
        }
        say(sessions.length + ' session(s)：点名字开终端页签（openTerminal）')
        sessions.forEach(function (s) {
          var li = document.createElement('li')
          var btn = document.createElement('button')
          btn.type = 'button'
          btn.textContent = s.name + ' [' + s.type + ']'
          btn.addEventListener('click', function () {
            lv.openTerminal(s.id).then(function (r) {
              // ok:true = 终端页签已创建并开始连接；不保证 SSH 最终连通
              say(r.ok ? 'openTerminal accepted: ' + s.name : 'openTerminal failed: ' + r.error)
            })
          })
          li.appendChild(btn)
          ul.appendChild(li)
        })
      })
      .catch(function (e) {
        say('callApi failed: ' + (e && e.message ? e.message : e))
      })

    $('open-doc').addEventListener('click', function () {
      var p = $('doc-path').value.trim()
      if (!p) {
        say('input a local doc path first (.md/.html/.txt)')
        return
      }
      lv.openDoc(p).then(function (r) {
        say(r.ok ? 'openDoc accepted: ' + p : 'openDoc failed: ' + r.error)
      })
    })

    lv.onEvent(function (evt) {
      if (evt.type === 'themeChanged') {
        applyTheme(evt.theme)
      }
    })
  })
})()
