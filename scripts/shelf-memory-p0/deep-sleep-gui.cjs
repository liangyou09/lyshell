/* Codex 的完整应用 GUI/恢复接线验收，隔离用户档案；图像由 Codex 亲自检查。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'tmp/deep-sleep-gui')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(out, { recursive: true })
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: root, env, windowsHide: true })
  const log = fs.createWriteStream(path.join(out, 'console.log')); child.stdout.pipe(log); child.stderr.pipe(log)
  child.on('exit', code => { log.end(); process.exitCode = code ?? 1; console.log(`GUI acceptance exit ${code}`) })
} else {
  const { app, webContents, session } = require('electron')
  const base = fs.mkdtempSync(path.join(out, 'profile-')), appData = path.join(base, 'appData'), config = path.join(appData, 'lyshell-dev/config')
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(path.join(base, 'userData'))
  // 与完整应用对照一致，仅隔离测试档案直连本机 fixture。
  fs.writeFileSync(path.join(config, 'browser-settings.json'), JSON.stringify({ homePage:'',searchEngine:'bing',zoomFactor:1,rememberHistory:true,restoreTabs:false,restoreMini:true,savePasswords:false,proxyMode:'direct',proxyServer:'',proxyBypass:'<local>',permissions:{camera:'deny',microphone:'deny',notifications:'deny',geolocation:'deny',clipboard:'deny'} }))
  process.env.DSH_HOME = path.join(base, 'dsh'); fs.mkdirSync(process.env.DSH_HOME)
  app.setPath('appData', appData); app.setPath('userData', path.join(base, 'userData'))
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP shelf-fixture.test 127.0.0.1')
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  let offset = 0, main, server
  const realNow = Date.now; Date.now = () => realNow() + offset
  const report = { errors: [], events: [], versions: process.versions, virtualIdleClock: true }
  const deadline = setTimeout(() => finish(1, Error('GUI deadline')), 120000)
  function finish(code, error) { clearTimeout(deadline); if (error) report.errors.push(error.stack); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); server?.close(); app.exit(code) }
  async function until(check, message, ms = 20000) { const end = realNow() + ms; while (realNow() < end) { if (await check()) return; await sleep(50) } throw Error(message) }
  const js = text => main.webContents.executeJavaScript(text)
  const state = () => js("window.electronAPI.shelfBrowserRequest({kind:'inspect',resourceId:'saved:readonly'})")
  app.on('browser-window-created', (_event, win) => {
    if (main) return
    main = win; win.webContents.setBackgroundThrottling(false)
    win.webContents.on('did-attach-webview', (_e, guest) => { report.events.push({ event: 'attached', id: guest.id }); guest.once('destroyed', () => report.events.push({ event: 'destroyed', id: guest.id })) })
    win.webContents.once('did-finish-load', () => { void (async () => {
      win.showInactive(); win.setSize(1280, 800)
      await until(() => js('!!document.querySelector(".task-shelf-edge")'), 'shelf not ready')
      await js("localStorage.setItem('lyshell.taskShelf.view.v1',JSON.stringify({mode:'fixed',width:420}));localStorage.setItem('lyshell.taskShelf.realtime.v1','none');true")
      const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded
      await until(() => js('!!document.querySelector(".task-shelf-policy button")'), 'archive not ready')
      await js("document.querySelector('.task-shelf-edge').click();document.querySelector('.task-shelf-policy button').click();true")
      await until(() => js("!!document.querySelector('[data-shelf-card=readonly]') && !!document.querySelector('.task-shelf-detail button')"), 'task activation not ready')
      await js("document.querySelector('[data-shelf-card=readonly]').click();document.querySelector('.task-shelf-detail button').click();true")
      await until(async () => (await state()).state === 'live', 'readonly did not attach')
      await until(() => js("[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('Read-only copy:'))"), 'readonly status missing')
      await sleep(700)
      fs.writeFileSync(path.join(out, 'readonly-main.png'), (await win.webContents.capturePage()).toPNG())
      const first = webContents.getAllWebContents().find(w => w.getType() === 'webview')
      report.contract = await first.executeJavaScript('({ran:window.ran===true,disabled:document.querySelector("input").disabled})')
      assert.deepEqual(report.contract, { ran: false, disabled: true })
      await js("document.querySelector('[aria-label=\"Recall all tasks\"]').click();true")
      await until(async () => (await state()).presentationOwner === 'none', 'recall did not withdraw demand')
      offset += 300001
      await until(async () => (await state()).state === 'sleeping', 'production timer did not sleep')
      await sleep(1100)
      assert.equal(first.isDestroyed(), true)
      report.sleeping = await state()
      fs.writeFileSync(path.join(out, 'sleeping.png'), (await win.webContents.capturePage()).toPNG())
      await js("document.querySelector('[data-shelf-card=readonly]').click();document.querySelector('.task-shelf-detail button').click();true")
      await until(async () => (await state()).state === 'live' && webContents.getAllWebContents().some(w => w.getType() === 'webview' && w.id !== first.id), 'sleeping page did not restore')
      report.restored = await state()
      const restored = webContents.getAllWebContents().filter(w => w.getType() === 'webview')
      assert.equal(restored.length, 1)
      assert.equal(restored[0].session, session.fromPartition(JSON.parse(fs.readFileSync(path.join(config, 'task-shelf.json'),'utf8')).entries[0].recovery.sleep.partition))
      report.saved = JSON.parse(fs.readFileSync(path.join(config, 'task-shelf.json'), 'utf8'))
      assert.equal(report.saved.entries[0].recovery.readonlyMode, true)
      assert.ok(report.saved.entries[0].recovery.sleep?.suspendOperationId)
      await sleep(500); fs.writeFileSync(path.join(out, 'restored-main.png'), (await win.webContents.capturePage()).toPNG())
      finish(0)
    })().catch(error => finish(1, error)) })
  })
  server = require('node:http').createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset=utf-8><title>Read-only document</title><h1>Local read-only document</h1><p>Scripts and editing are disabled in this copy.</p><input value=draft><script>window.ran=true</script><div style="height:3000px">Scroll content 中文</div>') })
  server.listen(0, '127.0.0.1', () => {
    const url = `http://shelf-fixture.test:${server.address().port}/read`
    fs.writeFileSync(path.join(config, 'task-shelf.json'), JSON.stringify({ version: 1, entries: [{ id: 'readonly', resourceKey: 'web:readonly', title: 'Read-only document', createdAt: 1, updatedAt: 1, revision: 1, capability: 'web', recovery: { kind: 'web', url, readonlyMode: true } }] }))
    require(path.join(root, 'dist/main/index.js'))
  })
}
