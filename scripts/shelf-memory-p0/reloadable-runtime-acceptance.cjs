/* Codex: production ordinary-page lifecycle in isolated Electron, no real app/profile. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'tmp/reloadable-runtime-acceptance')
fs.mkdirSync(out, { recursive: true })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  require('esbuild').buildSync({ stdin: { contents: "export * from './src/main/browser/shelf-browser-runtime'", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(out, 'runtime.cjs') })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: root, env, windowsHide: true })
  const log = fs.createWriteStream(path.join(out, 'console.log')); child.stdout.pipe(log); child.stderr.pipe(log)
  child.on('exit', code => { log.end(); process.exitCode = code ?? 1; console.log(`Ordinary runtime acceptance exit ${code}`) })
} else {
  const { app, BrowserWindow, session, webContents } = require('electron')
  app.on('web-contents-created', (_event, contents) => runtime?.observeGuest(contents))
  const { ShelfBrowserRuntime } = require(path.join(out, 'runtime.cjs'))
  const profile = fs.mkdtempSync(path.join(out, 'profile-'))
  app.setPath('userData', profile); app.setPath('appData', profile)
  process.env.DSH_HOME = path.join(profile, 'dsh')
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP shelf-fixture.test 127.0.0.1')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.on('window-all-closed', () => {})
  let runtime, host, server, clock = 100000, failSave = false, demandDuringSave = false
  const records = new Map(), pages = new Map()
  const report = { versions: process.versions, errors: [], events: [], cycles: [], syntheticActivation: true, virtualIdleClock: true,
    sourceSha256: Object.fromEntries(['src/main/browser/shelf-browser-runtime.ts','src/main/browser/shelf-resource-lifecycle.ts','src/main/browser/shelf-reloadable-guard.ts','src/main/browser/shelf-cancellable-close.ts'].map(file => [file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])) }
  const deadline = setTimeout(() => finish(1, Error('Acceptance deadline')), 300000)
  function finish(code, error) {
    clearTimeout(deadline); if (error) report.errors.push(error.stack)
    if (runtime) { report.stats = runtime.lifecycle.stats(); report.diagnostics = runtime.lifecycle.diagnostics() }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); server?.close(); app.exit(code)
  }
  async function until(check, message, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await delay(20) } throw Error(message) }
  const js = code => host.webContents.executeJavaScript(code)
  const inspect = id => runtime.request(host.webContents, { kind: 'inspect', resourceId: `tab:${id}` })
  const withdraw = id => runtime.request(host.webContents, { kind: 'demand', resourceId: `tab:${id}`, main: false, shelf: false })
  async function create(id, url, consent = false) {
    if (!records.has(id)) records.set(id, { id, resourceKey: `web:${id}`, title: id, capability: 'web', revision: 1, createdAt: 1, updatedAt: 1, recovery: { kind: 'web', url } })
    const granted = runtime.request(host.webContents, { kind: 'permit', resourceId: `tab:${id}`, taskId: id, url, source: 'explicitMain' })
    assert.ok(granted.success && granted.permitId, JSON.stringify(granted))
    await js(`new Promise((resolve,reject)=>{const p=document.createElement('webview');p.id=${JSON.stringify(id)};p.style.cssText='width:800px;height:500px';p.setAttribute('partition','persist:webbar');p.setAttribute('webpreferences',${JSON.stringify(`lyshellCreatePermit=${granted.permitId}`)});p.addEventListener('did-finish-load',resolve,{once:true});p.addEventListener('did-fail-load',e=>{if(e.isMainFrame&&e.errorCode!==-3)reject(Error(e.errorDescription))});p.src=${JSON.stringify(granted.url || url)};document.body.append(p)})`)
    await until(() => inspect(id).state === 'live', `native attach missing: ${id}`)
    const guest = pages.get(id); assert.ok(guest)
    assert.equal(await guest.executeJavaScript('window.scriptRan'), true, 'Ordinary page JS must remain enabled')
    // Synthetic browser activation is labelled in the evidence, not hardware input.
    await guest.executeJavaScript('void 0', true)
    assert.equal(await guest.executeJavaScript('navigator.userActivation.hasBeenActive'), true)
    if (consent) assert.ok(runtime.request(host.webContents, { kind: 'reloadPolicy', resourceId: `tab:${id}`, url, enabled: true }).success)
    runtime.bindTask(host.webContents, id, id); withdraw(id)
    return guest
  }
  async function tick() { clock += 300001; await runtime.tick(); await delay(100) }
  app.whenReady().then(async () => {
    server = require('node:http').createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/redirected' }); res.end(); return }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (req.url === '/') return res.end('<!doctype html><title>Ordinary lifecycle host</title><body>')
      const protectedPage = req.url === '/protected', edit = req.url === '/edited'
      res.end(`<!doctype html><meta charset=utf-8><h1>Ordinary scripted document</h1>${edit ? '<input value="unsaved draft">' : ''}<div style="height:6000px">Reading content</div><script>window.scriptRan=true;window.marker=Math.random();window.unloads=0;document.body.dataset.draft='unsaved';${protectedPage ? 'window.onbeforeunload=()=>{window.unloads++;return false};' : ''}</script>`)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://shelf-fixture.test:${server.address().port}`
    const ses = session.fromPartition('persist:webbar'); await ses.setProxy({ mode: 'direct' })
    await ses.cookies.set({ url: origin, name: 'fixture', value: 'synthetic', sameSite: 'lax' })
    runtime = new ShelfBrowserRuntime(true, { now: () => clock, manualTick: true, closeTimeoutMs: 3000 })
    runtime.configureReloadableSupport(ses, () => false)
    runtime.configurePersistence({ read: id => records.get(id), setReloadable: (id, url, enabled) => {
      const entry = records.get(id); assert.equal(entry.recovery.url, url)
      records.set(id, { ...entry, revision: entry.revision + 1, recovery: { kind: 'web', url, ...(enabled ? { reloadableMode: true } : {}) } })
    }, save: async (id, revision, metadata) => {
      assert.equal(records.get(id).revision, revision)
      if (failSave && id === 'ordinary') throw Error('synthetic disk failure')
      const next = { ...records.get(id), revision: revision + 1, recovery: { kind: 'web', url: metadata.url, reloadableMode: true, sleep: metadata } }
      const file = path.join(profile, `${id}.json`); fs.writeFileSync(file+'.tmp', JSON.stringify(next)); fs.renameSync(file+'.tmp',file); records.set(id,next)
      if (demandDuringSave && id === 'ordinary') runtime.request(host.webContents, { kind: 'demand', resourceId: 'tab:ordinary', main: true, shelf: false })
    } })
    host = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    host.webContents.on('will-attach-webview', (event, prefs, params) => {
      if (!runtime.willAttach(host.webContents, prefs, params.src, session.fromPartition(params.partition))) return event.preventDefault()
      delete prefs.preload; prefs.sandbox = true; prefs.contextIsolation = true; prefs.nodeIntegration = false
    })
    host.webContents.on('did-attach-webview', (_event, guest) => {
      runtime.didAttach(host.webContents, guest)
      report.events.push({ event: 'attach', id: guest.id })
      guest.on('did-finish-load', () => { if (guest.getURL().startsWith(origin)) pages.set(new URL(guest.getURL()).pathname.slice(1), guest) })
      guest.on('did-navigate', (_event, url) => {
        if (url !== 'about:blank' || pages.get('ordinary') !== guest) return
        try {
          assert.equal(runtime.isReloadableResource(host.webContents, 'ordinary', `${origin}/ordinary`), true, 'Late capture must retain the committed close contract')
          assert.ok(records.get('ordinary').recovery.sleep?.suspendOperationId)
          report.lateBlankCaptureChecks = (report.lateBlankCaptureChecks || 0) + 1
        } catch (error) { finish(1, error) }
      })
      guest.on('will-prevent-unload', () => report.events.push({ event: 'refused', id: guest.id }))
      guest.once('destroyed', () => report.events.push({ event: 'destroyed', id: guest.id }))
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    })
    await host.loadURL(origin)
    records.set('redirected', { id: 'redirected', resourceKey: 'web:redirected', title: 'redirected', capability: 'web', revision: 1, createdAt: 1, updatedAt: 1, recovery: { kind: 'web', url: `${origin}/redirect`, reloadableMode: true } })
    const redirected = await create('redirected', `${origin}/redirect`)
    assert.equal(inspect('redirected').url, `${origin}/redirected`)
    assert.equal(inspect('redirected').reloadableMode, false)
    redirected.close(); await until(() => redirected.isDestroyed(), 'redirect fixture did not close')
    await js('document.getElementById("redirected")?.remove();true')
    records.delete('redirected'); report.redirectedGuestBound = true
    let ordinary = await create('ordinary', `${origin}/ordinary`, true)
    const originalSession = ordinary.session
    const protectedPage = await create('protected', `${origin}/protected`, true)
    const unknown = await create('unknown', `${origin}/unknown`)
    const edited = await create('edited', `${origin}/edited`, true)
    const originalMarker = await protectedPage.executeJavaScript('window.marker')
    await ordinary.executeJavaScript('scrollTo(0,650);true'); ordinary.setZoomFactor(1.25)
    await delay(300)
    failSave = true; await tick(); failSave = false
    assert.equal(ordinary.isDestroyed(), false); assert.equal(ordinary.getURL(), `${origin}/ordinary`)
    report.saveFailureKeptOriginal = true
    demandDuringSave = true; await tick(); demandDuringSave = false
    assert.equal(ordinary.isDestroyed(), false); assert.equal(ordinary.getURL(), `${origin}/ordinary`)
    report.demandDuringSaveKeptOriginal = true; withdraw('ordinary')
    await tick(); await until(() => inspect('ordinary').state === 'sleeping', 'ordinary did not sleep')
    assert.equal(ordinary.isDestroyed(), true)
    assert.equal(protectedPage.isDestroyed(), false); assert.equal(await protectedPage.executeJavaScript('window.marker'), originalMarker)
    assert.equal(await protectedPage.executeJavaScript('document.body.dataset.draft'), 'unsaved')
    assert.ok(report.events.some(event => event.event === 'refused' && event.id === protectedPage.id))
    assert.equal(unknown.isDestroyed(), false); assert.equal(edited.isDestroyed(), false)
    report.protection = { nativeRefusalPreservedDocument: true, unknownKeptAlive: true, editKeptAlive: true }
    for (let cycle = 0; cycle < 100; cycle++) {
      const metadata = records.get('ordinary').recovery.sleep, started = performance.now()
      assert.equal(metadata.partition, 'persist:webbar')
      await js('document.getElementById("ordinary")?.remove();true')
      runtime.request(host.webContents, { kind: 'wake', resourceId: 'tab:ordinary', source: 'explicitMain' })
      ordinary = await create('ordinary', `${origin}/ordinary`)
      assert.equal(ordinary.session, originalSession)
      assert.equal(ordinary.getZoomFactor(), 1.25)
      await until(async () => Math.abs(await ordinary.executeJavaScript('scrollY') - metadata.scrollY) < 3, 'scroll restore failed', 2500)
      assert.ok((await ses.cookies.get({ url: origin })).some(cookie => cookie.name === 'fixture'))
      report.cycles.push({ cycle, restoreMs: performance.now() - started, partitionPreserved: true, zoomPreserved: true, scrollPreserved: true, cookiePreserved: true })
      await tick(); await until(() => inspect('ordinary').state === 'sleeping', 'repeat sleep failed')
    }
    // 关闭事务真正发出后才到的新展示需求：不创建替身，等 destroyed 后恢复。
    await js('document.getElementById("ordinary")?.remove();true')
    runtime.request(host.webContents, { kind: 'wake', resourceId: 'tab:ordinary', source: 'explicitMain' })
    ordinary = await create('ordinary', `${origin}/ordinary`)
    let demandDuringClose = false
    ordinary.once('did-start-navigation', (_event, url) => {
      if (url !== 'about:blank') return
      demandDuringClose = true
      runtime.request(host.webContents, { kind: 'demand', resourceId: 'tab:ordinary', main: true, shelf: false })
      const duplicate = runtime.request(host.webContents, { kind: 'permit', resourceId: 'tab:ordinary', taskId: 'ordinary', url: `${origin}/ordinary`, source: 'explicitMain' })
      assert.equal(duplicate.success, false, 'Closing original must retain its native slot')
    })
    await tick(); await until(() => inspect('ordinary').state === 'sleeping', 'in-flight close did not finish')
    assert.equal(demandDuringClose, true)
    assert.equal(inspect('ordinary').canRestore, true)
    assert.equal(ordinary.isDestroyed(), true)
    await js('document.getElementById("ordinary")?.remove();true')
    ordinary = await create('ordinary', `${origin}/ordinary`)
    assert.equal(ordinary.session, originalSession)
    await tick(); await until(() => inspect('ordinary').state === 'sleeping', 'post-demand restored page did not resleep')
    report.inFlightDemandRestoredOnlyAfterDestroyed = true
    report.finalGuests = webContents.getAllWebContents().filter(page => page.getType() === 'webview').length
    assert.equal(report.finalGuests, 3)
    assert.equal(runtime.lifecycle.stats().instances, 3)
    assert.ok(report.lateBlankCaptureChecks >= 100)
    finish(0)
  }).catch(error => finish(1, error))
}
