// 启动当前工作区构建的完整应用；所有档案和合成任务限于 tmp。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const out = path.join(root, 'tmp/shelf-memory-p0/app')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(out, { recursive: true })

if (!process.versions.electron) {
  if (!fs.existsSync(path.join(root, 'dist/main/index.js'))) throw new Error('先在本 worktree 运行 npm run build')
  for (const count of [20, 100]) for (let round = 1; round <= 3; round++) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    const result = spawnSync(require('electron'), [__filename, String(count), String(round)], { cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
    fs.writeFileSync(path.join(out, `run-${count}-${round}.txt`), (result.stdout || '') + (result.stderr || ''))
    if (result.status !== 0) throw new Error(`app fixture ${count}/${round} failed; inspect tmp/shelf-memory-p0/app logs`)
    console.log(`app fixture ${count}/${round} complete`)
  }
} else {
  const { app, BrowserWindow, webContents } = require('electron')
  const assert = require('node:assert/strict')
  const count = Number(process.argv[2]), round = Number(process.argv[3])
  assert.ok([20, 100].includes(count) && [1, 2, 3].includes(round))
  const base = fs.mkdtempSync(path.join(out, `profile-${count}-${round}-`))
  const appData = path.join(base, 'appData'), userData = path.join(base, 'empty-userData')
  const config = path.join(appData, 'lyshell-dev/config')
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(userData)
  app.setPath('appData', appData); app.setPath('userData', userData)
  const entries = Array.from({ length: count }, (_, i) => ({ id: `p0-${i}`, resourceKey: `web:p0-${i}`, title: `P0 saved fixture ${i}`, createdAt: 1, updatedAt: 1, revision: 1, recovery: { kind: 'web', url: 'https://example.invalid/fixture' }, capability: 'web', ...(i % 2 ? { archivedAt: 1 } : {}) }))
  fs.writeFileSync(path.join(config, 'task-shelf.json'), JSON.stringify({ version: 1, entries }))
  const started = performance.now()
  const report = { kind: 'isolated-full-app-existing-api', count, round, versions: process.versions, samples: [], errors: [] }
  let main, timer, phase = 'startup', finishing = false
  const finish = code => {
    if (finishing) return; finishing = true; clearInterval(timer); clearTimeout(deadline)
    fs.writeFileSync(path.join(out, `run-${count}-${round}.json`), JSON.stringify(report, null, 2))
    app.exit(code)
  }
  const deadline = setTimeout(() => { report.errors.push('app probe timed out'); finish(1) }, 60000)
  const sample = () => report.samples.push({ at: performance.now(), phase, processes: [...new Map(app.getAppMetrics().map(p => [p.pid, p])).values()], main: process.memoryUsage() })
  app.on('browser-window-created', (_event, win) => {
    if (main) return
    main = win
    if (process.env.LYSHELL_P0_SCREENSHOT !== '1') win.on('show', () => win.hide())
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        report.loadedMs = performance.now() - started
        if (process.env.LYSHELL_P0_SCREENSHOT === '1') { win.setTitle('LyShell · isolated shelf QA'); win.showInactive() }
        assert.equal(path.resolve(app.getPath('userData')), path.resolve(appData, 'lyshell-dev'))
        // 自动化不导航任何保存地址，不调用 restore，不创建终端或提交任务。
        for (let i = 0; i < 100; i++) {
          const ready = await win.webContents.executeJavaScript("Boolean(window.electronAPI?.taskShelfRequest && document.querySelector('.task-shelf-edge'))")
          if (ready) break
          if (i === 99) throw new Error('task shelf not ready')
          await sleep(50)
        }
        report.shelfMountedMs = performance.now() - started
        phase = 'shelf-open'
        await win.webContents.executeJavaScript("document.querySelector('.task-shelf-edge').click(); true")
        await sleep(1000); sample()
        if (process.env.LYSHELL_P0_SCREENSHOT === '1') {
          const image = await win.webContents.capturePage(undefined, { stayHidden: true })
          fs.writeFileSync(path.join(out, `ui-${count}-${round}.png`), image.toPNG())
        }
        report.cards = await win.webContents.executeJavaScript("document.querySelectorAll('.task-shelf-tile:not(.is-empty)').length")
        phase = 'list-ipc'
        report.list = await win.webContents.executeJavaScript(`(async()=>{const times=[];for(let i=0;i<100;i++){const start=performance.now();const r=await window.electronAPI.taskShelfRequest({kind:'list'});if(!r.success||r.entries.length!==${count})throw Error('list mismatch');times.push(performance.now()-start)}return times})()`)
        phase = 'classification-ipc'
        report.classification = await win.webContents.executeJavaScript("(async()=>{const times=[];for(let i=0;i<100;i++){const start=performance.now();const r=await window.electronAPI.taskShelfRequest({kind:'archive',id:'p0-0',archived:i%2===0});if(!r.success)throw Error(r.error);times.push(performance.now()-start)}return times})()")
        phase = 'settled'; await sleep(1000); sample()
        report.guests = webContents.getAllWebContents().filter(w => w.getType() === 'webview').length
        assert.equal(report.guests, 0)
        assert.equal(report.list.length, 100); assert.equal(report.classification.length, 100)
        report.profile = path.relative(root, app.getPath('userData'))
        report.window = win.getBounds()
        report.devicePixelRatio = await win.webContents.executeJavaScript('window.devicePixelRatio')
        finish(0)
      })().catch(error => { report.errors.push(error.stack); finish(1) })
    })
  })
  app.whenReady().then(() => { sample(); timer = setInterval(sample, 100) })
  require(path.join(root, 'dist/main/index.js'))
}
