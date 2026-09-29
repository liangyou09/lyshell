// launcher 视图逻辑：openWebTab（uiControl）与 openDialog（uiControl，目标限本插件视图）。
// 并发弹窗互不串扰：结果/取消按 dialogId 送达发起 guest。
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
      $('boot').textContent = 'window.lyshellView unavailable'
      return
    }
    lv.bootstrap()
      .then(function (boot) {
        applyTheme(boot.theme)
        $('boot').textContent = boot.pluginId + ' / ' + boot.viewId + ' (' + boot.kind + ', source=' + boot.source + ')'
      })
      .catch(function (e) {
        $('boot').textContent = 'bootstrap failed: ' + (e && e.message ? e.message : e)
      })

    $('open-web').addEventListener('click', function () {
      lv.openWebTab('https://example.com').then(function (r) {
        $('state').textContent = r.ok ? 'openWebTab accepted' : 'openWebTab failed: ' + r.error
      })
    })

    $('open-dialog').addEventListener('click', function () {
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
      } else if (evt.type === 'dialogCancelled') {
        $('dialog-result').textContent = 'cancelled (' + evt.reason + ')'
      } else if (evt.type === 'themeChanged') {
        applyTheme(evt.theme)
      }
    })
  })
})()
