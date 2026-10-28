// 新行为验收：独立 appData、回环网页 fixture，不读取或操作用户任务。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'tmp/shelf-memory-acceptance')
fs.mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
if (!process.versions.electron) {
  void (async () => {
  const serverHits = []
  const server = require('node:http').createServer((req, res) => { serverHits.push(req.url); setTimeout(() => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><title>Local preserved fixture</title><h1>Local page fixture</h1><label>Draft <input value="draft"></label><p>中文 emoji 🐚</p>') }, 100) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
  const rounds = Number(process.env.LYSHELL_ACCEPTANCE_ROUNDS || 3)
  for (const count of [20, 100]) for (let round = 1; round <= rounds; round++) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    const child = spawn(require('electron'), [__filename, String(count), String(round), String(server.address().port)], { cwd: root, env, windowsHide: true, timeout: 120000 })
    const output = fs.createWriteStream(path.join(out, `console-${count}-${round}.txt`))
    child.stdout.pipe(output); child.stderr.pipe(output)
    const status = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
    output.end()
    fs.writeFileSync(path.join(out, `server-${count}-${round}.json`), JSON.stringify(serverHits))
    if (status !== 0) throw new Error(`验收 ${count}/${round} 失败，见 tmp/shelf-memory-acceptance`)
    console.log(`acceptance ${count}/${round} passed`)
  }
  } finally { server.close() }
  })().catch(error => { console.error(error.message); process.exitCode = 1 })
} else {
  const { app, webContents, session } = require('electron')
  const count = Number(process.argv[2]), round = Number(process.argv[3])
  assert.ok([20, 100].includes(count) && round >= 1 && round <= 3)
  const base = fs.mkdtempSync(path.join(out, `profile-${count}-${round}-`)), appData = path.join(base, 'appData')
  const userData = path.join(base, 'initial-profile'), config = path.join(appData, 'lyshell-dev/config')
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(userData)
  app.setPath('appData', appData); app.setPath('userData', userData)
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP shelf-fixture.test 127.0.0.1')
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  const started = performance.now(), report = { count, round, samples: [], errors: [], navigationRequests: 0, nativeAttaches: 0, handshakes: 0, guestLoads: [], versions: process.versions }
  let main, server, timer, finishing = false, phase = 'startup'
  const finish = code => { if (finishing) return; finishing = true; clearInterval(timer); clearTimeout(deadline); server?.close(); fs.writeFileSync(path.join(out, `run-${count}-${round}.json`), JSON.stringify(report, null, 2)); app.exit(code) }
  const deadline = setTimeout(() => { report.errors.push('Acceptance deadline'); finish(1) }, 100000)
  const sample = () => report.samples.push({ at: performance.now() - started, phase, processes: app.getAppMetrics(), main: process.memoryUsage() })
  const guests = () => webContents.getAllWebContents().filter(w => w.getType() === 'webview')
  async function until(check, message, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await sleep(50) } throw new Error(message) }
  const js = code => main.webContents.executeJavaScript(code)
  const list = () => js("window.electronAPI.taskShelfRequest({kind:'list'})")
  const shot = async name => fs.writeFileSync(path.join(out, `${name}-${count}-${round}.png`), (await main.webContents.capturePage()).toPNG())
  app.on('browser-window-created', (_event, win) => {
    if (main) return
    main = win
    // 自动化窗口可能被 Codex 遮挡；固定测试页可见性，避免把正确的离屏撤权当作队列失败。
    win.webContents.setBackgroundThrottling(false)
    win.setTitle('LyShell · isolated acceptance')
    win.webContents.on('did-attach-webview', (_event, guest) => {
      report.nativeAttaches++
      guest.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { report.guestLoads.push({ id: guest.id, event: 'failed', code, description, isMainFrame }) })
      guest.on('dom-ready', () => { report.guestLoads.push({ id: guest.id, event: 'dom-ready' }) })
      guest.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) report.navigationRequests++ })
      guest.on('ipc-message', (_event, channel) => { if (channel === 'shelf-browser:attach') report.handshakes++ })
    })
    win.webContents.once('did-finish-load', () => { void (async () => {
      win.showInactive(); win.setSize(1500, 900)
      // 测试独立 partition 不经过系统代理，固定回环 fixture 的网络路径。
      await session.fromPartition('persist:webbar').setProxy({ mode: 'direct' })
      report.proxy = 'direct (isolated profile only)'
      await until(() => js("Boolean(window.electronAPI?.taskShelfRequest && document.querySelector('.task-shelf-edge'))"), 'Shelf not mounted')
      let state = await list()
      assert.equal(state.success, true, JSON.stringify(state)); assert.equal(state.startup.status, 'ready'); assert.equal(state.entries.length, count)
      assert.ok(state.entries.every(entry => entry.archivedAt)); assert.equal(guests().length, 0)
      report.startupMs = performance.now() - started
      const bootId = state.startup.bootId
      await js("localStorage.setItem('lyshell.taskShelf.view.v1',JSON.stringify({mode:'fixed',width:620}));true")
      const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve))
      win.webContents.reload(); await reloaded
      await until(() => js("Boolean(document.querySelector('.task-shelf-policy button'))"), 'Archive view not ready')
      state = await list(); assert.equal(state.startup.bootId, bootId); assert.ok(state.entries.every(entry => entry.archivedAt))
      await js("document.querySelector('.task-shelf-edge').click();true")
      await sleep(800)
      assert.equal(await js("document.querySelectorAll('[data-shelf-card]').length"), count)
      report.archiveGuests = guests().length; assert.equal(report.archiveGuests, 0)
      await shot('archive')
      phase = 'activate-all'
      const activateAt = performance.now()
      await js("document.querySelector('.task-shelf-policy button').click();true")
      await until(async () => (await list()).entries.every(entry => !entry.archivedAt), 'Activation not persisted')
      report.activateAllMs = performance.now() - activateAt
      await until(() => guests().length === 4, 'Automatic queue did not reach its four-resident limit', 30000)
      await until(() => guests().every(guest => !guest.isLoadingMainFrame()), 'Automatic navigations did not settle', 30000)
      await sleep(300)
      report.automaticGuests = guests().length
      assert.ok(report.automaticGuests > 0 && report.automaticGuests <= 4, `Automatic guests: ${report.automaticGuests}`)
      await until(() => report.handshakes >= report.automaticGuests, 'Native attach handshake missing')
      report.afterActivation = await js("[...document.querySelectorAll('[data-shelf-card]')].map(n=>({id:n.dataset.shelfCard,top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height}))")
      assert.ok(report.afterActivation.every(card => card.height >= 40))
      await shot('tasks')
      const beforeScroll = report.navigationRequests
      await js("const s=document.querySelector('.task-shelf-grid');s.scrollTop=s.scrollHeight;true")
      await sleep(500); assert.equal(report.navigationRequests, beforeScroll)
      phase = 'static'
      await js("const select=document.querySelector('.task-shelf-policy select');select.value='none';select.dispatchEvent(new Event('change',{bubbles:true}));true")
      await sleep(400); assert.equal(guests().length, report.automaticGuests)
      const target = `fixture-${count - 1}`
      await js(`document.querySelector('[data-shelf-card="${target}"]').click();true`)
      await js("document.querySelector('.task-shelf-detail button').click();true")
      await until(() => guests().length === report.automaticGuests + 1, 'Explicit main restore did not create one guest')
      await until(async () => { const result = await js(`window.electronAPI.shelfBrowserRequest({kind:'inspect',resourceId:'saved:${target}'})`); return result.success && result.state === 'live' && result.presentationOwner === 'main' }, 'Main did not take display ownership')
      report.explicitGuests = guests().length
      const guest = guests().find(page => page.getURL().endsWith(`/fixture/${count - 1}`))
      assert.ok(guest)
      report.targetHTML = await guest.executeJavaScript("document.documentElement.outerHTML.slice(0,4096)")
      await until(() => guest.executeJavaScript("Boolean(document.querySelector('input'))"), 'Fixture input did not load')
      await until(() => js(`(()=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent==='Show current page');if(button)button.click();const page=document.querySelector('[data-webtab-wrapper="shelf-web-${target}"] webview');return page&&!page.hasAttribute('inert')})()`), 'First picture or explicit current-page action did not unlock input', 8000)
      report.mainViewport = await guest.executeJavaScript('({width:innerWidth,height:innerHeight})')
      report.mainElement = await js(`(()=>{const page=document.querySelector('[data-webtab-wrapper="shelf-web-${target}"] webview');const rect=page.getBoundingClientRect();return {width:rect.width,height:rect.height,inert:page.hasAttribute('inert')}})()`)
      assert.ok(Math.abs(report.mainViewport.width - report.mainElement.width) <= 2)
      assert.ok(Math.abs(report.mainViewport.height - report.mainElement.height) <= 2)
      await guest.executeJavaScript("document.querySelector('input').value='preserve-input 中文 🐚';true")
      const originalId = guest.id
      await js(`document.querySelector('[data-shelf-card="${target}"]').click();true`)
      assert.equal(guest.id, originalId); assert.equal(await guest.executeJavaScript("document.querySelector('input').value"), 'preserve-input 中文 🐚')
      report.reusedGuest = originalId
      phase = 'classification-latency'
      // 用无活实例的记录测纯分类 IPC；活动页标题/导航快照会合法推进 revision，不能将并发冲突误判为分类失败。
      const classificationTarget = `fixture-${count - 2}`
      report.listLatency = await js("(async()=>{const times=[];for(let i=0;i<100;i++){const at=performance.now();const r=await window.electronAPI.taskShelfRequest({kind:'list'});if(!r.success)throw Error(r.error);times.push(performance.now()-at)}return times})()")
      report.classificationLatency = await js(`(async()=>{const times=[];for(let i=0;i<100;i++){let r=await window.electronAPI.taskShelfRequest({kind:'archive',id:'${classificationTarget}',archived:true});if(!r.success)throw Error(r.error);const entry=r.entries.find(e=>e.id==='${classificationTarget}');const at=performance.now();r=await window.electronAPI.taskShelfRequest({kind:'activate',bootId:r.startup.bootId,scopeId:r.startup.scopeId,requestId:crypto.randomUUID(),items:[{taskId:entry.id,expectedRevision:entry.revision}]});if(!r.success||r.activation.moved!==1)throw Error('classification mismatch: '+JSON.stringify(r));times.push(performance.now()-at)}return times})()`)
      assert.equal(guests().length, report.explicitGuests)
      phase = 'settled'; sample()
      report.final = await list(); report.profile = path.relative(root, app.getPath('userData'))
      report.window = win.getBounds(); report.dpr = await js('devicePixelRatio')
      if (count === 100 && round === 1) {
        await js("document.documentElement.dataset.theme='rack-graphite';document.documentElement.dataset.themeMode='dark';true"); await sleep(250); await shot('dark')
        win.setSize(900, 700); await sleep(400); await shot('narrow')
      }
      finish(0)
    })().catch(error => { report.errors.push(error.stack); finish(1) }) })
  })
    const port = Number(process.argv[4]); assert.ok(port > 0 && port < 65536)
    const url = `http://shelf-fixture.test:${port}/`
    const entries = Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, resourceKey: `web:fixture-${i}`, title: `Saved webpage ${i + 1} · 中文`, createdAt: 1, updatedAt: 1, revision: 1, recovery: { kind: 'web', url: `${url}fixture/${i}` }, capability: 'web' }))
    fs.writeFileSync(path.join(config, 'task-shelf.json'), JSON.stringify({ version: 1, entries }))
    app.whenReady().then(() => { timer = setInterval(sample, 100) })
    require(path.join(root, 'dist/main/index.js'))
}
