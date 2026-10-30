// 在独立 profile 的真实 Electron 主进程中加载构建产物；不连接用户会话或模型。
const { app } = require('electron')
const { Worker } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const candidate = process.env.LYSHELL_SMOKE_APP_ROOT || root
const evidence = path.join(root, 'tmp/remediation-smoke')
fs.mkdirSync(evidence, { recursive: true })
const profile = fs.mkdtempSync(path.join(evidence, 'profile-'))
process.env.LYSHELL_DEMO_PROFILE = profile
delete process.env.ELECTRON_RENDERER_URL
if (!process.argv.includes('--demo-stage')) process.argv.push('--demo-stage')
const resultPath = path.join(evidence, 'electron-result.json')
let finished = false
const workers = new Set()
function finish(result) {
  if (finished) return
  finished = true
  fs.writeFileSync(resultPath, JSON.stringify({ ...result, platform: process.platform, electron: process.versions.electron, node: process.versions.node }, null, 2))
  app.quit()
}
function nextMessage(worker, predicate, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Worker message deadline exceeded')), ms)
    const message = value => { if (predicate(value)) done(null, value) }
    const onError = value => done(value)
    function done(error, value) {
      clearTimeout(timer)
      worker.off('message', message)
      worker.off('error', onError)
      if (error) reject(error); else resolve(value)
    }
    worker.on('message', message)
    worker.once('error', onError)
  })
}
async function workerChecks() {
  const worker = new Worker(path.join(candidate, 'dist/main/patternWorker.js'))
  workers.add(worker)
  try {
    await nextMessage(worker, value => value.type === 'ready' && value.protocol === 1)
    const matched = nextMessage(worker, value => value.jobId === 'literal' && value.generation === 1)
    worker.postMessage({ type: 'match', jobId: 'literal', generation: 1, pattern: 'literal[', mode: 'literal', inputs: ['prefix literal[ suffix'] })
    if (!(await matched).matched) throw new Error('Built Worker literal match failed')
    const invalid = nextMessage(worker, value => value.jobId === 'invalid' && value.generation === 1)
    worker.postMessage({ type: 'compile', jobId: 'invalid', generation: 1, pattern: '[', mode: 'regex' })
    const failure = await invalid
    if (failure.type !== 'error' || failure.reason !== 'INVALID_PATTERN') throw new Error('Built Worker invalid-pattern contract failed')
    let heartbeats = 0
    const heartbeat = setInterval(() => heartbeats++, 5)
    let hostileJobReturned = false
    const observe = message => { if (message.jobId === 'backtracking' && message.generation === 1) hostileJobReturned = true }
    worker.on('message', observe)
    worker.postMessage({ type: 'match', jobId: 'backtracking', generation: 1, pattern: '^(a+)+$', mode: 'regex', inputs: ['a'.repeat(28) + '!'] })
    await new Promise(resolve => setTimeout(resolve, 100))
    const exited = await worker.terminate()
    clearInterval(heartbeat)
    worker.off('message', observe)
    if (!Number.isInteger(exited) || heartbeats < 1) throw new Error('Worker termination/main-loop responsiveness failed')
    return { builtWorkerLoaded: true, literalMatch: true, invalidPattern: true,
      workerExitConfirmed: true, hostileRegexInterrupted: !hostileJobReturned, heartbeats }
  } finally {
    await worker.terminate()
    workers.delete(worker)
  }
}
setTimeout(() => finish({ ok: false, error: 'Smoke deadline exceeded' }), 30000).unref()
let started = false
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    if (started || !window.webContents.getURL().includes('/dist/renderer/index.html')) return
    started = true
    setImmediate(async () => {
      try {
        const preferences = window.webContents.getLastWebPreferences()
        if (!preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration) throw new Error('Renderer isolation changed')
        const sessionsReadable = await window.webContents.executeJavaScript('window.electronAPI.listSessions().then(Array.isArray)')
        if (!sessionsReadable) throw new Error('Trusted preload read failed')
        const checks = await workerChecks()
        finish({ ok: true, checks: { ...checks, rendererIsolation: true, trustedPreload: true }, shutdownRequested: true })
      } catch (error) {
        for (const worker of workers) await worker.terminate()
        finish({ ok: false, error: String(error?.stack || error) })
      }
    })
  })
})
require(path.join(candidate, 'dist/main/index.js'))
