/* 生产 runtime/只读契约的隔离 Electron 验收；不接触用户档案和正式实例。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'tmp/deep-sleep-acceptance')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(out, { recursive: true })
if (!process.versions.electron) {
  require('esbuild').buildSync({ stdin: { contents: "export * from './src/main/browser/shelf-browser-runtime'; export * from './src/main/browser/shelf-readonly-contract'", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(out, 'runtime.cjs') })
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/preload/shelf-readonly.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(out, 'preload.js') })
  void (async () => {
    const rounds = Number(process.env.DEEP_SLEEP_ROUNDS || 3)
    for (let round = 1; round <= rounds; round++) for (const mode of process.env.DEEP_SLEEP_ONLY ? [process.env.DEEP_SLEEP_ONLY] : round === 2 ? ['after', 'before'] : ['before', 'after']) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [__filename, mode, String(round)], { cwd: root, env, windowsHide: true })
      const log = fs.createWriteStream(path.join(out, `${mode}-${round}.log`)); child.stdout.pipe(log); child.stderr.pipe(log)
      const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) }); log.end()
      assert.equal(code, 0, `${mode}/${round}: see ${out}`)
      console.log(`${mode}/${round} completed`)
    }
  })().catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const { app, BrowserWindow, webContents, session } = require('electron')
  const { ShelfBrowserRuntime, READONLY_PARTITION, initializeReadonlySession, isReadonlyGuest, isReadonlyPartition } = require(path.join(out, 'runtime.cjs'))
  const mode = process.argv[2], round = Number(process.argv[3]), profile = fs.mkdtempSync(path.join(out, 'profile-'))
  app.setPath('userData', profile)
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP shelf-fixture.test 127.0.0.1')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.on('window-all-closed', () => {})
  let clock = 1000000, host, server, timer, phase = 'startup', runtime
  const records = new Map(), pages = new Map(), samples = [], events = [], latencies = []
  let postRequests = 0
  const report = { kind: 'isolated-production-runtime', mode, round, versions: process.versions, samples, events, latencies, errors: [], sourceHashes: Object.fromEntries(['src/main/browser/shelf-browser-runtime.ts', 'src/main/browser/shelf-resource-lifecycle.ts', 'src/main/browser/shelf-readonly-contract.ts', 'src/preload/shelf-readonly.ts'].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) }
  const deadline = setTimeout(() => finish(1, new Error('Acceptance deadline')), 240000)
  function finish(code, error) {
    clearInterval(timer); clearTimeout(deadline)
    if (error) report.errors.push(error.stack)
    if (runtime) { report.stats = runtime.lifecycle.stats(); report.diagnostics = runtime.lifecycle.diagnostics() }
    fs.writeFileSync(path.join(out, `${mode}-${round}.json`), JSON.stringify(report, null, 2))
    server?.close(); app.exit(code)
  }
  const sample = () => {
    const started = performance.now(), processes = [...new Map(app.getAppMetrics().map(item => [item.pid, item])).values()]
    assert.ok(processes.every(item => Number.isFinite(item.memory.privateBytes)), 'Windows privateBytes required')
    samples.push({ phase, at: Date.now(), privateMiB: processes.reduce((sum, item) => sum + item.memory.privateBytes, 0) / 1024, processes, samplerMs: performance.now() - started })
  }
  async function until(check, message, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await sleep(20) } throw new Error(message) }
  const js = text => host.webContents.executeJavaScript(text)
  const inspect = id => runtime.request(host.webContents, { kind: 'inspect', resourceId: `tab:${id}` })
  async function create(id, url, readonlyMode = true) {
    const permit = runtime.request(host.webContents, { kind: 'permit', resourceId: `tab:${id}`, url, source: 'explicitMain', readonlyMode })
    assert.ok(permit.success && permit.permitId, JSON.stringify(permit))
    await js(`new Promise((resolve,reject)=>{const page=document.createElement('webview'); page.id=${JSON.stringify(id)};page.style.cssText='width:800px;height:500px;display:flex';page.setAttribute('partition',${JSON.stringify(permit.partition || 'fixture-dynamic')});page.setAttribute('webpreferences',${JSON.stringify(`lyshellCreatePermit=${permit.permitId}`)});page.addEventListener('did-finish-load',resolve,{once:true});page.addEventListener('did-fail-load',e=>{if(e.isMainFrame)reject(Error(e.errorDescription))});page.src=${JSON.stringify(permit.url || url)};document.body.append(page)})`)
    await until(() => inspect(id).state === 'live', 'Native handshake missing')
    runtime.bindTask(host.webContents, id, id)
    if (!records.has(id)) records.set(id, { id, revision: 1, capability: 'web', recovery: { kind: 'web', url, readonlyMode } })
    runtime.request(host.webContents, { kind: 'demand', resourceId: `tab:${id}`, main: false, shelf: false })
    return pages.get(id)
  }
  async function suspendAll() {
    clock += 300001
    await runtime.tick()
    await sleep(300)
  }
  app.whenReady().then(async () => {
    server = require('node:http').createServer((req, res) => {
      if (req.method !== 'GET') postRequests++
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (req.url === '/') return res.end('<!doctype html><title>Read-only lifecycle acceptance</title><body>')
      if (req.url === '/subframe') return res.end('<p>subframe attempt</p>')
      if (req.url === '/media') return res.end('')
      const unsafe = req.url.startsWith('/protected')
      res.end('<!doctype html><meta charset="utf-8"><title>Readonly fixture</title><h1>Local document 中文</h1><input value="draft"><input type="file"><form method="post"><button>Submit</button></form><div contenteditable>Editable attempt</div><iframe src="/subframe"></iframe><video autoplay src="/media"></video><script>window.ran=true;window.onbeforeunload=()=>false</script>' + '<p>Fixed text 0123456789 abcdef '.repeat(18000) + (unsafe ? '<script>document.querySelector("input").value="unsaved"</script>' : '') )
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://shelf-fixture.test:${server.address().port}`
    runtime = new ShelfBrowserRuntime(true, { now: () => clock, manualTick: true })
    runtime.configurePersistence({ read: id => records.get(id), save: (id, revision, metadata) => { const entry = records.get(id); assert.equal(entry.revision, revision); const next = { ...entry, revision: revision + 1, recovery: { kind: 'web', readonlyMode: true, url: metadata.url, sleep: metadata } }; fs.writeFileSync(path.join(profile, `${id}.tmp`), JSON.stringify(next)); fs.renameSync(path.join(profile, `${id}.tmp`), path.join(profile, `${id}.json`)); records.set(id, next) } })
    initializeReadonlySession(session.fromPartition(READONLY_PARTITION))
    host = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    host.webContents.on('will-attach-webview', (event, prefs, params) => {
      events.push({ event: 'will-attach', keys: Object.keys(prefs), permitKey: typeof prefs.lyshellCreatePermit, lowerPermitKey: typeof prefs.lyshellcreatepermit })
      const nativeSession = session.fromPartition(params.partition)
      if (isReadonlyPartition(params.partition)) initializeReadonlySession(nativeSession)
      if (!runtime.willAttach(host.webContents, prefs, params.src, nativeSession)) return event.preventDefault()
      prefs.sandbox = true; prefs.contextIsolation = true; prefs.nodeIntegration = false
      // 同一不可注入的 fixture preload 负责握手；动态控制不获得只读 session。
      prefs.preload = path.join(out, 'preload.js')
    })
    host.webContents.on('did-attach-webview', (_event, guest) => {
      const prefs = guest.getLastWebPreferences()
      events.push({ event: 'attached', id: guest.id, javascript: prefs.javascript, preload: prefs.preload, partition: prefs.partition, nativePermitPresent: typeof prefs.lyshellNativePermit === 'string', markerPresent: prefs.additionalArguments?.some(arg => arg.startsWith('--lyshell-shelf-permit=')) })
      guest.on('preload-error', (_event, _path, error) => events.push({ event: 'preload-error', message: error.message }))
      guest.on('console-message', detail => events.push({ event: 'console', message: detail.message?.slice(0, 300) }))
      runtime.didAttach(host.webContents, guest)
      const id = [...records.keys()].length // 只用于日志，不作为实例身份
      guest.on('ipc-message', (event, channel, ...args) => events.push({ id: guest.id, channel, at: Date.now(), ...(channel === 'shelf-browser:attach' ? { mainFrameMatches: event.senderFrame === guest.mainFrame, nonceValid: typeof args[1] === 'string' && /^[a-f0-9]{32}$/.test(args[1]), permitRecognized: runtime.permits.has(args[0]), permitState: runtime.permits.get(args[0]) ? runtime.lifecycle.inspect(runtime.permits.get(args[0]).init) : null } : {}) }))
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      guest.on('did-finish-load', () => { const url = new URL(guest.getURL()); pages.set(url.pathname.split('/').pop(), guest) })
      guest.once('destroyed', () => events.push({ event: 'destroyed', id: guest.id }))
      void id
    })
    await host.loadURL(origin)
    timer = setInterval(sample, 100)
    const urls = new Map()
    for (let index = 0; index < 10; index++) { const id = `page${index}`; const url = `${origin}/page/${id}`; urls.set(id, url); await create(id, url) }
    await create('protected', `${origin}/protected`, false)
    await create('unknown', `${origin}/unknown`, false)
    const page = pages.get('page0'); assert.ok(isReadonlyGuest(page), 'Native readonly prefs/session proof failed')
    // executeJavaScript 的隔离探针不作为保护授权，只验证原站脚本确实没有运行。
    report.contract = await page.executeJavaScript('({scriptRan:window.ran===true,inputDisabled:document.querySelector("input").disabled,frames:document.querySelector("iframe").contentDocument?.body?.textContent||null})')
    assert.equal(report.contract.scriptRan, false); assert.equal(report.contract.inputDisabled, true)
    await page.executeJavaScript('document.querySelector("form").submit();scrollTo(0,650);true')
    page.setZoomFactor(1.25)
    page.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); page.sendInputEvent({ type: 'char', keyCode: 'X' })
    assert.equal(await page.executeJavaScript('document.querySelector("input").value'), 'draft')
    await page.executeJavaScript('scrollTo(0,650);true')
    await sleep(300); assert.equal(postRequests, 0)
    phase = 'loaded'; await sleep(1500); sample()
    if (mode === 'after') await suspendAll()
    phase = 'steady'; await sleep(2000); sample()
    report.coverage = { total: 12, eligible: 10, slept: [...urls.keys()].filter(id => inspect(id).state === 'sleeping').length, protectedAlive: !pages.get('protected').isDestroyed(), unknownAlive: !pages.get('unknown').isDestroyed() }
    assert.equal(report.coverage.slept, mode === 'after' ? 10 : 0)
    assert.ok(report.coverage.protectedAlive && report.coverage.unknownAlive)
    phase = 'cycles'
    for (let cycle = 0; cycle < 100; cycle++) {
      const id = `page${cycle % 10}`, started = performance.now()
      if (mode === 'after') {
        await js(`document.getElementById(${JSON.stringify(id)})?.remove();true`)
        runtime.request(host.webContents, { kind: 'wake', resourceId: `tab:${id}`, source: 'explicitMain' })
        await create(id, urls.get(id))
        if (cycle === 0) {
          report.restoreProbe = { metadata: records.get(id).recovery.sleep, initial: await pages.get(id).executeJavaScript('scrollY'), zoom: pages.get(id).getZoomFactor() }
          const expected = records.get(id).recovery.sleep.scrollY
          assert.ok(expected > 0, 'Nonzero scroll telemetry required')
          await until(() => pages.get(id).executeJavaScript(`Math.abs(scrollY-${expected})<3`), 'Bounded scroll restore failed', 2500)
          assert.equal(pages.get(id).getZoomFactor(), 1.25)
          report.restoreMetadataVerified = true
        }
      } else { await pages.get(id).reload(); await until(() => !pages.get(id).isLoading(), 'reload failed') }
      const navigationMs = performance.now() - started
      const inputStart = performance.now()
      await pages.get(id).executeJavaScript('document.body.dataset.inputProbe="received";true')
      latencies.push({ navigationMs, inputProbeMs: performance.now() - inputStart })
      if (mode === 'after') await suspendAll()
    }
    phase = 'post-cycles'; await sleep(1500); sample()
    report.remainingGuests = webContents.getAllWebContents().filter(item => item.getType() === 'webview').length
    report.postRequests = postRequests
    assert.equal(report.remainingGuests, mode === 'after' ? 2 : 12)
    fs.writeFileSync(path.join(out, `${mode}-${round}.png`), (await host.webContents.capturePage()).toPNG())
    finish(0)
  }).catch(error => finish(1, error))
}
