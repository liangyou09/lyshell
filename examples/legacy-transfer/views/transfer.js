(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }
  var endpoint = 'http://127.0.0.1:' + window.legacyTransferPort
  var token = null
  var root = ''
  var timer = null
  var taskId = null
  var pending = false
  var lv = window.lyshellView
  function theme(value) { document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark' }
  function say(text, error) { $('state').textContent = text; $('state').dataset.error = String(!!error) }
  function hints() {
    var upload = $('direction').value === 'upload'
    $('submit').textContent = upload ? '开始上传' : '开始下载'
    $('path-help').textContent = upload ? '选择本机普通文件；不上传私钥或凭据文件。' : '目标须为新文件，且位于 ' + root + ' 目录中。'
    $('method-help').textContent = {
      tcp: '远端需要 Python 3 或 Python，且允许 SSH 端口转发。',
      python: '远端需要 Python 3 和 SSH exec；无需端口转发。',
      base64: '远端需要兼容 GNU base64 -d 的命令和 SSH exec；无需 Python。'
    }[$('method').value]
    $('shellEnterCommands').disabled = $('method').value !== 'tcp'
  }
  async function call(route, data) {
    var response = await fetch(endpoint + route, {
      method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: Object.assign(token ? { Authorization: 'Bearer ' + token } : {}, data === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20000)
    })
    var result = await response.json()
    if (!response.ok) throw new Error(result.error || '插件服务请求失败')
    return result
  }
  function render(task) {
    var active = task && (task.state === 'running' || task.state === 'cancelling')
    taskId = task ? task.id : null
    $('fields').disabled = active || pending
    hints()
    $('cancel').hidden = !active
    $('cancel').disabled = !!task && task.state === 'cancelling'
    $('progress').hidden = !task
    if (task) {
      var states = { running: '正在传输', cancelling: '正在停止传输进程…', cancelled: '传输已取消。部分文件可能保留。', completed: '传输完成', failed: '传输失败' }
      say(states[task.state] + (task.error ? '：' + task.error : ''), task.state === 'failed')
      if (task.direction === 'download' && active) $('progress').removeAttribute('value')
      else $('progress').value = task.progress
      $('bytes').textContent = new Intl.NumberFormat().format(task.transferredSize) + ' 字节' + (task.direction === 'download' && active ? ' · 接收中' : '')
    } else say('就绪。填写连接信息后开始传输。')
    clearTimeout(timer)
    if (active) timer = setTimeout(refresh, 1000)
  }
  async function refresh() {
    try { render((await call('/state')).task); $('refresh').hidden = true }
    catch (error) {
      say('无法确认任务状态：' + error.message + '。请恢复连接后刷新，勿重复提交。', true)
      $('fields').disabled = true; $('refresh').hidden = false
    }
  }
  $('transfer-form').addEventListener('submit', async function (event) {
    event.preventDefault()
    if (pending) return
    pending = true
    var previousId = taskId
    var submitError = null
    var payload = Object.fromEntries(new FormData(event.target))
    payload.port = Number(payload.port)
    $('fields').disabled = true
    say('正在提交…')
    try { await call('/submit', payload) }
    catch (error) { submitError = error; say('提交未确认：' + error.message + '。正在核对任务状态…', true) }
    finally {
      $('password').value = ''; $('passphrase').value = ''
      pending = false
      // 即使提交超时也核对原服务状态，不重发。
      await refresh()
      if (submitError && taskId === previousId && $('refresh').hidden) say(submitError.message, true)
    }
  })
  $('cancel').addEventListener('click', async function () {
    $('cancel').disabled = true
    try { await call('/cancel', { taskId: taskId }); await refresh() }
    catch (error) { say('取消结果未确认：' + error.message, true); $('refresh').hidden = false }
  })
  $('refresh').addEventListener('click', refresh)
  $('direction').addEventListener('change', hints)
  $('method').addEventListener('change', hints)
  window.addEventListener('pagehide', function () { clearTimeout(timer) })
  if (lv) {
    lv.bootstrap().then(function (data) { theme(data.theme) }).catch(function (error) { say(error.message, true) })
    lv.onEvent(function (event) { if (event.type === 'themeChanged') theme(event.theme) })
  }
  hints()
  call('/handshake').then(function (data) { token = data.token; root = data.downloadRoot; return refresh() })
    .catch(function (error) { say('插件服务不可用：' + error.message + '。请在插件管理中重新启用插件。', true) })
})()
