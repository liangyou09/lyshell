/* Codex 的普通页完整应用 GUI 验收；隔离档案预设测试同意，不自动回答真实审批。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'tmp/reloadable-gui')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(out, { recursive: true })
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: root, env, windowsHide: true })
  const log = fs.createWriteStream(path.join(out, 'console.log')); child.stdout.pipe(log); child.stderr.pipe(log)
  child.on('exit', code => { log.end(); process.exitCode = code ?? 1; console.log(`Ordinary GUI acceptance exit ${code}`) })
} else {
  const { app, webContents, session, dialog } = require('electron')
  const base = fs.mkdtempSync(path.join(out, 'profile-')), appData = path.join(base, 'appData'), config = path.join(appData, 'lyshell-dev/config')
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(path.join(base, 'userData'))
  // 与完整应用对照一致，仅隔离测试档案直连本机 fixture。
  fs.writeFileSync(path.join(config, 'browser-settings.json'), JSON.stringify({ homePage:'',searchEngine:'bing',zoomFactor:1,rememberHistory:true,restoreTabs:false,restoreMini:true,savePasswords:false,proxyMode:'direct',proxyServer:'',proxyBypass:'<local>',permissions:{camera:'deny',microphone:'deny',notifications:'deny',geolocation:'deny',clipboard:'deny'} }))
  process.env.DSH_HOME = path.join(base, 'dsh'); fs.mkdirSync(process.env.DSH_HOME)
  app.setPath('appData', appData); app.setPath('userData', path.join(base, 'userData'))
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP shelf-fixture.test 127.0.0.1')
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  let offset = 0, main, server, fixtureUrl, simulatedDialogResponse = 0
  const realNow = Date.now; Date.now = () => realNow() + offset
  const report = { errors: [], events: [], versions: process.versions, virtualIdleClock: true, seededFixtureConsent: true, syntheticActivation: true, simulatedLocalDialog: true, confirmationRequests: [] }
  report.buildSha256 = Object.fromEntries(['dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html', ...fs.readdirSync(path.join(root, 'dist/renderer/assets')).filter(file => /^index-.*\.js$/.test(file)).map(file => 'dist/renderer/assets/' + file)].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
  const originalDialog = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = (...args) => {
    const options = args[args.length - 1]
    if (options.title === 'Allow this page to reload after idling?' && options.message === fixtureUrl) {
      report.confirmationRequests.push({ buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId, simulatedResponse: simulatedDialogResponse })
      return Promise.resolve({ response: simulatedDialogResponse, checkboxChecked: false })
    }
    return originalDialog(...args)
  }
  const deadline = setTimeout(() => finish(1, Error('GUI deadline')), 120000)
  function finish(code, error) { clearTimeout(deadline); if (error) report.errors.push(error.stack); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); server?.close(); app.exit(code) }
  async function until(check, message, ms = 20000) { const end = realNow() + ms; while (realNow() < end) { if (await check()) return; await sleep(50) } throw Error(message) }
  const js = text => main.webContents.executeJavaScript(text)
  const state = () => js("window.electronAPI.shelfBrowserRequest({kind:'inspect',resourceId:'saved:ordinary'})")
  async function openShelf() {
    await until(() => js("!!document.querySelector('.task-shelf-edge') && !!document.querySelector('.task-shelf')"), 'shelf not mounted after reload')
    await js("document.querySelector('.task-shelf-edge').click();true")
    await until(() => js("document.querySelector('.task-shelf').getAttribute('aria-hidden')==='false' && !document.querySelector('.task-shelf').hasAttribute('inert')"), 'shelf panel not visible')
  }
  async function openOrdinaryMain() {
    report.step = 'open shelf'
    await openShelf()
    report.step = 'select ordinary card'
    await until(() => js("(()=>{const b=document.querySelector('[data-shelf-card=ordinary]');if(!b||b.disabled)return false;b.click();return true})()"), 'ordinary card not ready')
    report.step = 'expand ordinary to main'
    await until(() => js("!!document.querySelector('[data-shelf-entry=ordinary] .task-shelf-main-button:not(:disabled)')"), 'expand-to-main action not ready')
    await js("document.querySelector('[data-shelf-entry=ordinary] .task-shelf-main-button').click();true")
    await until(async () => (await state()).presentationOwner === 'main', 'main presentation demand missing')
    report.step = 'select static shelf policy'
    await js("(()=>{document.querySelector('.task-shelf-options-toggle').click();const select=document.querySelector('.task-shelf-options-panel select');select.value='none';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
  }
  app.on('browser-window-created', (_event, win) => {
    if (main) return
    if (!path.resolve(app.getPath('userData')).startsWith(path.resolve(base) + path.sep)) return finish(1, Error('Fixture userData isolation mismatch'))
    main = win; win.webContents.setBackgroundThrottling(false)
    win.webContents.on('console-message', detail => { if (detail.level === 'error' || detail.level === 3) { report.rendererErrors ??= []; if (report.rendererErrors.length < 20) report.rendererErrors.push(detail.message?.slice(0,500)) } })
    win.webContents.on('did-attach-webview', (_e, guest) => {
      report.events.push({ event: 'attached', id: guest.id })
      guest.once('destroyed', () => report.events.push({ event: 'destroyed', id: guest.id }))
      const nativeClose = guest.close.bind(guest)
      guest.close = (...args) => {
        if (guest.getURL() !== 'about:blank' || report.lateBlankCapturePersisted) { nativeClose(...args); return }
        // 仅延迟本fixture的最终native close，强制把真实IPC收纳安排在blank提交和destroyed之间。
        void (async () => {
          const result = await js(`window.electronAPI.taskShelfRequest(${JSON.stringify({ kind: 'capture', entryId: 'ordinary', resource: { kind: 'web', id: 'shelf-web-ordinary', url: fixtureUrl, title: 'Ordinary document', post: false } })})`)
          assert.equal(result.success, true)
          assert.equal(result.entry.recovery.reloadableMode, true)
          assert.ok(result.entry.recovery.sleep?.suspendOperationId)
          report.lateBlankCapturePersisted = true
          nativeClose(...args)
        })().catch(error => finish(1, error))
      }
    })
    win.webContents.once('did-finish-load', () => { void (async () => {
      win.showInactive(); win.setSize(1280, 800)
      await until(() => js('!!document.querySelector(".task-shelf-edge")'), 'shelf not ready')
      await js("localStorage.setItem('lyshell.taskShelf.view.v1',JSON.stringify({mode:'fixed',width:420}));localStorage.setItem('lyshell.taskShelf.realtime.v1','none');true")
      const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded
      report.stage = 'activate archive'
      await openShelf()
      await until(() => js("[...document.querySelectorAll('.task-shelf [role=tab]')].some(e=>e.textContent.startsWith('Archive'))"), 'Archive tab unavailable')
      await js("[...document.querySelectorAll('.task-shelf [role=tab]')].find(e=>e.textContent.startsWith('Archive')).click();true")
      await until(() => js("!!document.querySelector('[aria-label=\"Activate all\"]:not(:disabled)')"), 'archive action not ready')
      await js("document.querySelector('[aria-label=\"Activate all\"]').click();true")
      await until(() => js("!!document.querySelector('[data-shelf-card=ordinary]:not(:disabled)')"), 'task activation not ready')
      await openOrdinaryMain()
      await until(async () => (await state()).state === 'live', 'readonly did not attach')
      await until(() => js("[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('Idle reload allowed'))"), 'readonly status missing')
      await sleep(700)
      fs.writeFileSync(path.join(out, 'readonly-main.png'), (await win.webContents.capturePage()).toPNG())
      const first = webContents.getAllWebContents().find(w => w.getType() === 'webview')
      await first.executeJavaScript('void 0', true)
      await first.executeJavaScript('scrollTo(0,650);true')
      first.setZoomFactor(1.25)
      report.contract = await first.executeJavaScript('({ran:window.ran===true})')
      assert.deepEqual(report.contract, { ran: true })
      await js("document.querySelector('[aria-label=\"Recall all tasks\"]').click();true")
      await until(async () => (await state()).presentationOwner === 'none', 'recall did not withdraw demand')
      offset += 300001
      await until(async () => (await state()).state === 'sleeping', 'production timer did not sleep')
      await sleep(1100)
      assert.equal(first.isDestroyed(), true)
      report.sleeping = await state()
      assert.equal(report.lateBlankCapturePersisted, true)
      fs.writeFileSync(path.join(out, 'sleeping.png'), (await win.webContents.capturePage()).toPNG())
      report.stage = 'restore main'
      await openOrdinaryMain()
      await until(async () => (await state()).state === 'live' && webContents.getAllWebContents().some(w => w.getType() === 'webview' && w.id !== first.id), 'sleeping page did not restore')
      report.restored = await state()
      const restored = webContents.getAllWebContents().filter(w => w.getType() === 'webview')
      assert.equal(restored.length, 1)
      await until(async () => restored[0].getZoomFactor() === 1.25 && Math.abs(await restored[0].executeJavaScript('scrollY') - 650) < 3, 'ordinary zoom/scroll restore missing')
      assert.equal(restored[0].session, session.fromPartition(JSON.parse(fs.readFileSync(path.join(config, 'task-shelf.json'),'utf8')).entries[0].recovery.sleep.partition))
      report.saved = JSON.parse(fs.readFileSync(path.join(config, 'task-shelf.json'), 'utf8'))
      assert.equal(report.saved.entries[0].recovery.reloadableMode, true)
      assert.ok(report.saved.entries[0].recovery.sleep?.suspendOperationId)
      await sleep(500); fs.writeFileSync(path.join(out, 'restored-main.png'), (await win.webContents.capturePage()).toPNG())
      const webLabel = require(path.join(root, 'src/renderer/locales/en.json')).nav.web
      await js(`(()=>{const button=[...document.querySelectorAll('button[title]')].find(b=>b.title===${JSON.stringify(webLabel)});if(!button)throw Error('Browser navigation entry missing');button.click();return true})()`)
      await until(() => js("!!document.querySelector('[title=\"More actions\"]')"), 'browser menu missing')
      await js("document.querySelector('[title=\"More actions\"]').click();true")
      await until(() => js("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Keep this page running')"), 'policy revoke menu missing')
      await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Keep this page running').click();true")
      await until(async () => (await state()).reloadableMode === false, 'policy revoke not committed')
      report.afterRevoke = JSON.parse(fs.readFileSync(path.join(config, 'task-shelf.json'), 'utf8'))
      assert.equal(report.afterRevoke.entries[0].recovery.reloadableMode, undefined)
      assert.equal(report.afterRevoke.entries[0].recovery.sleep, undefined)
      await js("document.querySelector('[aria-label=\"Recall all tasks\"]').click();true")
      await until(async () => (await state()).presentationOwner === 'none', 'revoke recall demand not withdrawn')
      offset += 300001; await sleep(1300)
      assert.equal(restored[0].isDestroyed(), false)
      assert.equal((await state()).state, 'live')
      report.uiRevokeKeptAlive = true
      report.stage = 'actual UI and main IPC consent decisions (dialog choices simulated)'
      await openOrdinaryMain()
      const chooseReload = async () => {
        await js("document.querySelector('[title=\"More actions\"]').click();true")
        await until(() => js("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Allow idle reload…')"), 'Allow idle reload action missing')
        await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Allow idle reload…').click();true")
      }
      await chooseReload()
      await until(() => report.confirmationRequests.length === 1, 'native cancel choice not reached')
      await sleep(100)
      assert.equal((await state()).reloadableMode, false)
      simulatedDialogResponse = 1
      await chooseReload()
      await until(async () => (await state()).reloadableMode === true, 'native allow choice did not persist consent')
      assert.equal(report.confirmationRequests.length, 2)
      assert.equal(report.confirmationRequests[0].defaultId, 0)
      assert.equal(report.confirmationRequests[0].cancelId, 0)
      assert.equal(JSON.parse(fs.readFileSync(path.join(config, 'task-shelf.json'), 'utf8')).entries[0].recovery.reloadableMode, true)
      report.actualUiAndMainConsentChecked = true
      finish(0)
    })().catch(async error => {
      report.nativeFailure = await state().catch(e => ({ error: e.message }))
      report.shelfFailure = await js("window.electronAPI.taskShelfRequest({kind:'list'})").catch(e => ({ error: e.message }))
      report.domFailure = await js("({text:document.body.innerText.slice(0,3000),tabs:[...document.querySelectorAll('[role=tab]')].map(e=>e.textContent),classes:[...document.querySelectorAll('[class*=task-shelf]')].map(e=>e.className).slice(0,20)})").catch(e => ({ error: e.message }))
      fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG())
      finish(1, error)
    }) })
  })
  server = require('node:http').createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset=utf-8><title>Ordinary document</title><h1>Local scripted document</h1><p>Original Session and page scripts remain enabled.</p><script>window.ran=true</script><div style="height:6000px;background:linear-gradient(#fff,#e8edf4)"><p style="padding-top:600px">Restored reading position 中文</p></div>') })
  server.listen(0, '127.0.0.1', () => {
    const url = `http://shelf-fixture.test:${server.address().port}/read`
    fixtureUrl = url
    fs.writeFileSync(path.join(config, 'task-shelf.json'), JSON.stringify({ version: 1, entries: [{ id: 'ordinary', resourceKey: 'web:ordinary', title: 'Ordinary document', createdAt: 1, updatedAt: 1, revision: 1, capability: 'web', recovery: { kind: 'web', url, reloadableMode: true } }] }))
    require(path.join(root, 'dist/main/index.js'))
  })
}
