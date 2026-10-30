const { app, webContents } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const root = path.resolve(__dirname, '..')
const evidence = path.join(root, 'tmp/browser-host-smoke')
fs.mkdirSync(evidence, { recursive: true })
process.env.LYSHELL_DEMO_PROFILE = fs.mkdtempSync(path.join(evidence, 'profile-'))
process.env.LYSHELL_READONLY_VIEW_PILOT = '1'
delete process.env.ELECTRON_RENDERER_URL
process.argv.push('--demo-stage')
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><style>body{font:20px sans-serif;padding:48px;color:#17332f;background:#edf3ef}h1{font-size:42px}a{color:#176b50}</style><h1>LyShell 只读宿主验证</h1><p>页面 ' + (req.url === '/second' ? '二' : '一') + '</p><a href="/second">第二页</a><form method="post"><input placeholder="只读保护"><button>提交</button></form>')
})
const listening = new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
let finished = false
const report = { platform: process.platform, electron: process.versions.electron, checks: {}, memory: {} }
function finish(error) {
  if (finished) return
  finished = true
  report.ok = !error
  if (error) report.error = String(error.stack || error)
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  fixture.close()
  app.quit()
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const metrics = () => app.getAppMetrics().map(item => ({ type: item.type, workingSetSize: item.memory.workingSetSize, peakWorkingSetSize: item.memory.peakWorkingSetSize }))
setTimeout(() => finish(new Error('Browser host smoke deadline exceeded')), 30000).unref()
let started = false
app.on('browser-window-created', (_event, win) => {
  win.hide()
  win.webContents.once('did-finish-load', () => {
    if (started || !win.webContents.getURL().includes('/dist/renderer/index.html')) return
    started = true
    setImmediate(async () => {
      try {
        await listening
        const url = `http://127.0.0.1:${fixture.address().port}`
        const call = request => win.webContents.executeJavaScript(`window.electronAPI.browserHostRequest(${JSON.stringify(request)})`)
        const requireSuccess = value => { if (!value.success) throw Error(JSON.stringify(value)); return value }
        const caps = requireSuccess(await call({ kind: 'capabilities' }))
        if (!caps.pilotEnabled) throw Error('Pilot was not enabled in the isolated process')
        report.memory.baseline = metrics()
        const created = requireSuccess(await call({ kind: 'create-readonly-pilot', url }))
        const host = created.snapshot.handle
        for (const request of [{ kind: 'attach' }, { kind: 'bounds', bounds: { x: 0, y: 0, width: 800, height: 480 } }, { kind: 'visibility', visible: true }, { kind: 'focus' }]) requireSuccess(await call({ ...request, host }))
        const first = requireSuccess(await call({ kind: 'inspect', host })).snapshot
        if (!first.readonly || first.protection !== 'safe' || first.phase !== 'attached') throw Error('Readonly/attachment evidence missing')
        requireSuccess(await call({ kind: 'navigate', host, url: url + '/second' }))
        requireSuccess(await call({ kind: 'back', host }))
        await delay(150)
        requireSuccess(await call({ kind: 'forward', host }))
        await delay(150)
        const captureReply = await call({ kind: 'capture', host })
        if (!captureReply.success) {
          const page = webContents.getAllWebContents().find(page => page.getURL().startsWith(url))
          if (page) {
            try { await page.capturePage(undefined, { stayHidden: true }); report.captureProbe = 'optional-rectangle accepted' }
            catch (error) { report.captureProbe = error.message }
            try { report.captureWithoutOptions = (await page.capturePage()).getSize() }
            catch (error) { report.captureWithoutOptions = error.message }
          }
        }
        const capture = requireSuccess(captureReply)
        if (!capture.image.startsWith('data:image/png;base64,')) throw Error('Missing PNG preview')
        fs.writeFileSync(path.join(evidence, 'readonly-pilot.png'), Buffer.from(capture.image.split(',')[1], 'base64'))
        report.memory.nativeView = metrics()
        requireSuccess(await call({ kind: 'visibility', host, visible: false }))
        const closed = requireSuccess(await call({ kind: 'close', host })).snapshot
        if (closed.phase !== 'closed') throw Error('Native close not confirmed')
        report.checks = { trustedPreload: true, readonlyProtection: true, navigation: true, capture: true, detachAndDestroyConfirmed: true }
        await delay(200)
        report.memory.afterNativeClose = metrics()
        try {
          const guestId = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const page=document.createElement('webview');page.id='remediation-webview-comparison';page.style='width:800px;height:480px;position:fixed;left:0;top:0';page.src=${JSON.stringify(url)};page.addEventListener('did-finish-load',()=>resolve(page.getWebContentsId()),{once:true});page.addEventListener('did-fail-load',()=>reject(new Error('Comparison webview failed')),{once:true});document.body.append(page);setTimeout(()=>reject(new Error('Comparison webview deadline exceeded')),5000)})`)
          await delay(200)
          report.memory.webview = metrics()
          await win.webContents.executeJavaScript("document.getElementById('remediation-webview-comparison').remove()")
          const deadline = Date.now() + 2000
          while (webContents.fromId(guestId) && Date.now() < deadline) await delay(25)
          report.checks.webviewDestroyed = !webContents.fromId(guestId)
          if (!report.checks.webviewDestroyed) throw Error('Comparison webview close unconfirmed')
        } catch (error) { report.comparisonUnverified = error.message }
        finish()
      } catch (error) { finish(error) }
    })
  })
})
require(path.join(process.env.LYSHELL_QA_APP_ROOT || root, 'dist/main/index.js'))
