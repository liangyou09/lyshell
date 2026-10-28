/* 独立 fixture 探针；不启动 LyShell，不读取用户配置，不接生产连接。 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'tmp/shelf-memory-p0/electron')

if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true })
  require('esbuild').buildSync({ stdin: { contents: `
    import { Terminal } from '@xterm/xterm';
    import { captureShelfWebFrame } from './src/renderer/components/Layout/task-shelf-web-frame';
    window.fixtureTerminals=[];
    window.setupTerminals=async n=>{for(let i=0;i<n;i++){
      const box=document.createElement('div');box.style.cssText='width:800px;height:300px';document.body.append(box);
      const t=new Terminal({cols:100,rows:24,scrollback:10000});t.open(box);
      await new Promise(resolve=>t.write(('\\x1b[32mfixture 中文 😀\\x1b[0m\\r\\n').repeat(10000),resolve));
      window.fixtureTerminals.push(t);
    }};
    window.captureFixture=captureShelfWebFrame;
    window.clearTerminals=()=>{window.fixtureTerminals.forEach(t=>t.dispose());window.fixtureTerminals=[]};
  `, resolveDir: root }, bundle: true, platform: 'browser', outfile: path.join(output, 'renderer.js') })
  for (let round = 1; round <= 3; round++) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [__filename, String(round)], { cwd: root, env, encoding: 'utf8', timeout: 240000, windowsHide: true, maxBuffer: 1024 * 1024 })
    fs.writeFileSync(path.join(output, `round-${round}.stderr.txt`), result.stderr || '')
    if (result.status !== 0) throw new Error(`Electron round ${round} failed: ${result.error?.message || result.stderr}`)
    console.log(`Electron round ${round} complete`)
  }
} else {
  const { app, BrowserWindow, webContents, screen } = require('electron')
  const http = require('node:http')
  const assert = require('node:assert/strict')
  const round = Number(process.argv[2])
  const profile = fs.mkdtempSync(path.join(output, `profile-${round}-`))
  app.setPath('userData', profile)
  app.on('window-all-closed', () => {})
  const report = { schema: 1, round, kind: 'isolated-component-fixture', versions: process.versions, platform: process.platform, cpu: os.cpus()[0]?.model, totalMemory: os.totalmem(), samples: [], scenes: [], probes: {}, errors: [] }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  let host, server, timer, phase = 'startup'
  const progress = setInterval(() => fs.writeFileSync(path.join(output, `progress-${round}.json`), JSON.stringify({ phase, samples: report.samples.length })), 1000)
  const sample = () => {
    const started = performance.now()
    const processes = [...new Map(app.getAppMetrics().map(m => [m.pid, m])).values()]
    report.samples.push({ at: Date.now(), phase, processes, main: process.memoryUsage(), samplerMs: performance.now() - started })
  }
  const js = code => host.webContents.executeJavaScript(code)
  const finish = code => {
    clearInterval(timer); clearInterval(progress)
    fs.writeFileSync(path.join(output, `round-${round}.json`), JSON.stringify(report, null, 2))
    if (host && !host.isDestroyed()) host.destroy()
    server?.close()
    app.exit(code)
  }
  app.whenReady().then(async () => {
    report.display = screen.getPrimaryDisplay()
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/renderer.js' ? 'text/javascript' : 'text/html; charset=utf-8')
      if (req.url === '/renderer.js') return res.end(fs.readFileSync(path.join(output, 'renderer.js')))
      if (req.url === '/') return res.end('<!doctype html><title>P0 isolated fixture</title><script src="/renderer.js"></script><main id="cards"></main>')
      // 页面只产生本机合成内容，不以页面消息授权销毁。
      res.end('<!doctype html><title>Controlled P0 page</title><h1>Local fixture 中文 😀</h1><form><input name="draft" value="unsaved fixture"><input type="file"></form><video controls></video><div style="height:2000px">scroll fixture</div>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    host = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    host.webContents.on('will-attach-webview', (event, prefs, params) => {
      if (!params.src.startsWith(origin + '/page')) return event.preventDefault()
      prefs.nodeIntegration = false; prefs.contextIsolation = true; prefs.sandbox = true
      delete prefs.preload
    })
    await host.loadURL(origin)
    sample(); timer = setInterval(sample, 100)
    for (const count of [1, 10, 30]) {
      phase = `web-${count}`
      await js(`Promise.all(Array.from({length:${count}-document.querySelectorAll('webview').length},(_,i)=>new Promise((resolve,reject)=>{
        const p=document.createElement('webview');p.setAttribute('partition','p0-fixture');p.style.cssText='width:960px;height:600px;display:flex';
        p.addEventListener('did-finish-load',resolve,{once:true});p.addEventListener('did-fail-load',reject,{once:true});
        p.src=${JSON.stringify(origin + '/page')};document.body.append(p);
      })))`)
      await sleep(1500); sample()
      report.scenes.push({ phase, guests: webContents.getAllWebContents().filter(w => w.getType() === 'webview').length })
    }
    phase = 'capture'
    report.probes.capture = await js(`window.captureFixture(document.querySelector('webview')).then(f=>({width:f.width,height:f.height,encodedCharacters:f.image?.length||0}))`)
    const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview')
    try {
      const image = await guest.capturePage(undefined, { stayHidden: true })
      report.probes.stayHiddenCapture = { size: image.getSize(), empty: image.isEmpty(), hostVisible: host.isVisible() }
      fs.writeFileSync(path.join(output, `round-${round}.png`), image.resize({ width: 640 }).toPNG())
    } catch (error) { report.probes.stayHiddenCapture = { error: error.message, hostVisible: host.isVisible() } }
    phase = 'protected-close'
    let prevented = false
    guest.on('will-prevent-unload', () => { prevented = true })
    await guest.executeJavaScript('window.onbeforeunload=()=>false; true')
    guest.close({ waitForBeforeUnload: true })
    await sleep(400)
    report.probes.beforeUnload = { prevented, survived: !guest.isDestroyed() }
    if (!guest.isDestroyed()) {
      await guest.executeJavaScript('window.onbeforeunload=null')
      let destroyed = false; guest.once('destroyed', () => { destroyed = true })
      guest.close({ waitForBeforeUnload: true }); await sleep(400)
      report.probes.close = { destroyed, isDestroyed: guest.isDestroyed() }
      assert.ok(destroyed && guest.isDestroyed())
    }
    await js(`document.querySelectorAll('webview').forEach(p=>p.remove())`)
    phase = 'closed-guests'; await sleep(1500); sample()
    for (const count of [1, 10, 30]) {
      phase = `xterm-${count}`
      await js(`window.setupTerminals(${count}-window.fixtureTerminals.length)`)
      await sleep(1000); sample()
      report.scenes.push({ phase, terminals: count, scrollback: 10000, columns: 100, rows: 24 })
    }
    for (const count of [20, 100]) {
      phase = `metadata-cards-${count}`
      await js(`document.getElementById('cards').replaceChildren(...Array.from({length:${count}},(_,i)=>{const el=document.createElement('article');el.textContent='Saved metadata fixture '+i;return el}))`)
      await sleep(500); sample()
    }
    phase = 'disposed'; await js('window.clearTerminals()'); await sleep(1000); sample()
    report.probes.remainingGuests = webContents.getAllWebContents().filter(w => w.getType() === 'webview').length
    assert.equal(report.probes.remainingGuests, 0)
    finish(0)
  }).catch(error => { report.errors.push(error.stack); finish(1) })
}
