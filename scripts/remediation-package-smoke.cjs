'use strict'
// 普通 Node 包装器。只启动本次隔离 packaged exe，不修改 app.asar 或使用开发 dist 回退。
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const packageRoot = process.argv[2] ? path.resolve(root, process.argv[2])
  : path.join(root, 'tmp', 'remediation-package', 'win-unpacked')
const executable = path.join(packageRoot, 'LyShell.exe')
const asar = path.join(packageRoot, 'resources', 'app.asar')
const evidence = path.join(root, 'tmp', 'remediation-package-smoke')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function boundedWait(promise, ms, message) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}
const normalize = value => path.resolve(value).toLowerCase()
function assert(value, message) { if (!value) throw new Error(message) }
function sanitize(text) {
  return String(text).split(/\r?\n/).map(line => /token|secret|password|authorization|api.?key/i.test(line) ? '[credential-related diagnostic redacted]' : line.replace(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/g, '[inspector endpoint redacted]')).join('\n')
}
function inside(base, target) { const relative = path.relative(normalize(base), normalize(target)); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }
async function vacantPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
class Inspector {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.onPaused = () => {}
    socket.addEventListener('message', event => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.method === 'Debugger.paused') this.onPaused(message.params)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id); clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(entry.method + ': ' + message.error.message))
      else entry.resolve(message.result)
    })
    socket.addEventListener('close', () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Inspector disconnected')) }; this.pending.clear() })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector WebSocket did not open')), 3000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector WebSocket failed')) }, { once: true })
    })
    return new Inspector(socket)
  }
  call(method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' deadline exceeded')) }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, timeoutMs = 5000, awaitPromise = true) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
    if (result.exceptionDetails) throw new Error('Inspector evaluation: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    return result.result?.value
  }
  close() { this.socket.close() }
}
// 以下函数只作为源码发送到已核对 PID 的 packaged 主进程，不在包装器中执行。
function bootstrap(key, profile, folders, asarPath) {
  const module = process.getBuiltinModule('node:module')
  if (!module?.createRequire) throw new Error('Main inspector has no createRequire builtin')
  const require = module.createRequire(asarPath + '/package.json')
  const { app } = require('electron')
  if (!app || app.isPackaged !== true) throw new Error('Inspector did not resolve the actual packaged Electron app')
  if (globalThis[key]) throw new Error('Smoke state already exists')
  app.setPath('userData', profile)
  for (const [name, directory] of Object.entries(folders)) app.setPath(name, directory)
  const state = { app, require, windows: [], rendererGone: false, monitorErrors: [] }
  globalThis[key] = state
  app.on('browser-window-created', (_event, window) => {
    state.windows.push(window)
    window.hide()
    window.on('show', () => window.hide())
    window.webContents.on('render-process-gone', () => { state.rendererGone = true })
  })
  process.on('uncaughtExceptionMonitor', error => { state.monitorErrors.push({ name: error?.name, code: error?.code }) })
  return { pid: process.pid, isPackaged: app.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath, profileIsolationMethod: 'pre-startup actual app.setPath' }
}
function readiness(key) {
  const state = globalThis[key]
  const windows = state.windows.filter(window => !window.isDestroyed())
  return { ready: state.app.isReady(), packaged: state.app.isPackaged, appPath: state.app.getAppPath(), userData: state.app.getPath('userData'), sessionData: state.app.getPath('sessionData'), rendererGone: state.rendererGone, monitorErrors: state.monitorErrors,
    windows: windows.map(window => ({ url: window.webContents.getURL(), loading: window.webContents.isLoadingMainFrame(), visible: window.isVisible() })) }
}
function dependencyProbe(key) {
  const require = globalThis[key].require
  const loaded = []
  for (const name of ['electron-log', 'node-pty', 'koffi', 'serialport', 'ssh2']) {
    require(name)
    loaded.push(name)
  }
  return { loaded }
}
async function rendererProbe(key) {
  const state = globalThis[key]
  const window = state.windows.find(window => !window.isDestroyed() && window.webContents.getURL().replace(/\\/g, '/').includes('/app.asar/dist/renderer/index.html') && !window.webContents.isLoadingMainFrame())
  if (!window) throw new Error('Packaged renderer did not finish loading')
  const preferences = window.webContents.getLastWebPreferences()
  if (!preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration) throw new Error('Packaged renderer isolation changed')
  const api = await window.webContents.executeJavaScript('(async () => { const api = window.electronAPI; if (!api || typeof api.listSessions !== "function") return { available: false }; const sessions = await api.listSessions(); return { available: true, sessionsReadable: Array.isArray(sessions), count: Array.isArray(sessions) ? sessions.length : null } })()')
  if (!api.available || !api.sessionsReadable) throw new Error('Packaged preload API was not usable')
  return { rendererUrl: window.webContents.getURL(), hidden: !window.isVisible(), rendererIsolation: true, preload: api }
}
async function workerProbe(key) {
  const require = globalThis[key].require
  const { Worker } = require('node:worker_threads')
  const path = require('node:path')
  const fs = require('node:fs')
  const workerPath = path.join(process.resourcesPath, 'app.asar', 'dist', 'main', 'patternWorker.js')
  if (!fs.existsSync(workerPath)) throw new Error('Packaged asar patternWorker.js is missing')
  // 此探针的主进程在 inspector 下，Worker 不继承仅用于 QA 的初始断点参数。
  const worker = new Worker(workerPath, { execArgv: [] })
  let exited = false, heartbeat, heartbeats = 0, hostileReturned = false
  worker.once('exit', () => { exited = true })
  const message = (predicate, ms = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Asar Worker response deadline exceeded')), ms)
    const receive = value => { if (predicate(value)) done(null, value) }
    const error = value => done(value)
    function done(failure, value) { clearTimeout(timer); worker.off('message', receive); worker.off('error', error); if (failure) reject(failure); else resolve(value) }
    worker.on('message', receive); worker.once('error', error)
  })
  const bounded = async (promise, ms) => {
    let timer
    try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Asar Worker termination deadline exceeded')), ms) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    await message(value => value.type === 'ready' && value.protocol === 1)
    const literal = message(value => value.jobId === 'package-literal' && value.generation === 1)
    worker.postMessage({ type: 'match', jobId: 'package-literal', generation: 1, pattern: '字面[', mode: 'literal', inputs: ['前字面[后'] })
    if (!(await literal).matched) throw new Error('Asar Worker literal match failed')
    const invalid = message(value => value.jobId === 'package-invalid' && value.generation === 1)
    worker.postMessage({ type: 'compile', jobId: 'package-invalid', generation: 1, pattern: '[', mode: 'regex' })
    const failure = await invalid
    if (failure.type !== 'error' || failure.reason !== 'INVALID_PATTERN') throw new Error('Asar Worker invalid regex contract failed')
    const observe = value => { if (value.jobId === 'package-backtracking' && value.generation === 1) hostileReturned = true }
    worker.on('message', observe)
    heartbeat = setInterval(() => heartbeats++, 5)
    worker.postMessage({ type: 'match', jobId: 'package-backtracking', generation: 1, pattern: '^(a+)+$', mode: 'regex', inputs: ['a'.repeat(28) + '!'] })
    await new Promise(resolve => setTimeout(resolve, 100))
    const exitCode = await bounded(worker.terminate(), 2000)
    worker.off('message', observe)
    if (!Number.isInteger(exitCode) || !exited || heartbeats < 1 || hostileReturned) throw new Error('Asar Worker interruption or main-loop heartbeat failed')
    return { workerPath, protocol: 1, literal: true, invalidRegex: true, highBacktrackingInterrupted: true, terminateExitCode: exitCode, heartbeats }
  } finally { clearInterval(heartbeat); if (!exited) await bounded(worker.terminate(), 2000) }
}
async function main() {
  const commonGit = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
  const originalRoot = path.dirname(path.resolve(root, commonGit))
  const actualPackage = fs.realpathSync(packageRoot)
  assert([root, originalRoot].some(workspace => inside(path.join(workspace, 'tmp'), actualPackage)), 'QA package must resolve inside a repository workspace tmp directory')
  assert(process.platform === 'win32' && typeof WebSocket === 'function', 'Use Windows with ordinary Node 24+ and its built-in WebSocket')
  assert(!process.versions.electron, 'Use ordinary Node for the independent external watchdog')
  assert(fs.existsSync(executable) && fs.existsSync(asar), 'The unpacked Windows package must already exist')
  fs.mkdirSync(evidence, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(evidence, 'run-'))
  const profile = path.join(runDir, 'profile')
  // 空私有 HOME 没有 Windows Known Folder 注册；明确提供应用可能读取的标准目录。
  const folders = Object.fromEntries(['sessionData', 'appData', 'home', 'temp', 'logs', 'crashDumps',
    'desktop', 'documents', 'downloads', 'music', 'pictures', 'videos', 'recent'].map(name => [name, path.join(profile, name)]))
  for (const directory of [profile, ...Object.values(folders)]) fs.mkdirSync(directory, { recursive: true })
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (['systemroot', 'windir', 'comspec', 'path', 'pathext', 'processor_architecture'].includes(key.toLowerCase())) env[key] = value
  Object.assign(env, { LYSHELL_DEMO_PROFILE: profile, APPDATA: folders.appData, LOCALAPPDATA: folders.appData, USERPROFILE: folders.home, HOME: folders.home, TEMP: folders.temp, TMP: folders.temp, ELECTRON_ENABLE_LOGGING: '1' })
  const port = await vacantPort()
  const key = '__lyshellPackageSmoke_' + randomUUID().replace(/-/g, '')
  let stage = 'spawn', rpc, exited = false, stopping = false, timedOut = false, cleanup, pauseError, childError
  const logs = { stdout: '', stderr: '' }
  const report = { ok: false, startedAt: new Date().toISOString(), executable, asar, profile, runDir }
  const child = spawn(executable, ['--inspect-brk=127.0.0.1:' + port, '--user-data-dir=' + profile, '--demo-stage', '--enable-logging=stderr'], { cwd: packageRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise(resolve => { child.once('exit', () => { exited = true }); child.once('close', (code, signal) => resolve({ code, signal })) })
  child.once('error', error => { childError = error.code || 'spawn failed' })
  const killOwned = () => {
    if (stopping || exited || !Number.isSafeInteger(child.pid)) return
    stopping = true
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000, encoding: 'utf8' })
    cleanup = { targetPid: child.pid, taskkillExitCode: result.status, errorCode: result.error?.code }
    if (!exited) { try { child.kill() } catch { /* 未确认状态会保留在报告。 */ } }
  }
  const watchdog = setTimeout(() => { timedOut = true; killOwned(); rpc?.close() }, 30000)
  for (const name of ['stdout', 'stderr']) child[name].on('data', buffer => {
    if (Buffer.byteLength(logs[name]) + buffer.length > 64 * 1024) { childError = 'bounded diagnostic log exceeded'; killOwned(); return }
    logs[name] += buffer.toString('utf8')
  })
  const evaluate = (fn, ...args) => rpc.evaluate('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')', 7000, fn.constructor.name === 'AsyncFunction')
  try {
    stage = 'inspector-discovery'
    let endpoint
    const discoveryDeadline = Date.now() + 5000
    while (!endpoint && Date.now() < discoveryDeadline && !exited && !timedOut) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(500), redirect: 'error' })
        const targets = await response.json()
        endpoint = targets.find(target => typeof target.webSocketDebuggerUrl === 'string')?.webSocketDebuggerUrl
      } catch { /* 仅在 inspector 启动窗口内等待，不改端口或连接其他实例。 */ }
      if (!endpoint) await delay(50)
    }
    assert(endpoint, 'Owned packaged inspector did not become available')
    const address = new URL(endpoint)
    assert(address.protocol === 'ws:' && address.hostname === '127.0.0.1' && Number(address.port) === port, 'Inspector endpoint escaped the owned loopback port')
    rpc = await Inspector.connect(endpoint)
    await rpc.call('Runtime.enable')
    let paused = false, allowResume = false, resuming = false, pausedFrame
    const resume = () => {
      if (!allowResume || !paused || resuming) return
      paused = false; resuming = true
      void rpc.call('Debugger.resume').catch(error => { pauseError = error }).finally(() => { resuming = false })
    }
    rpc.onPaused = params => { pausedFrame = params.callFrames[0]?.callFrameId; paused = true; resume() }
    await rpc.call('Debugger.enable')
    // 初始 inspector 尚在等待客户端，先推进至用户入口的第一行断点才能 evaluate。
    await rpc.call('Runtime.runIfWaitingForDebugger')
    const pauseDeadline = Date.now() + 3000
    while (!paused && Date.now() < pauseDeadline && !exited) await delay(10)
    assert(paused && pausedFrame, 'Packaged main did not pause before its first user statement')
    const evaluatePaused = async expression => {
      const reply = await rpc.call('Debugger.evaluateOnCallFrame', { callFrameId: pausedFrame, expression, returnByValue: true })
      if (reply.exceptionDetails) throw new Error('Paused main evaluation: ' + (reply.exceptionDetails.exception?.description || reply.exceptionDetails.text))
      return reply.result?.value
    }
    assert(await evaluatePaused('process.pid') === child.pid, 'Inspector belongs to a different process; no injection performed')
    stage = 'pre-startup-isolation'
    report.bootstrap = await evaluatePaused('(' + bootstrap.toString() + ')(' + [key, profile, folders, asar].map(value => JSON.stringify(value)).join(',') + ')')
    assert(normalize(report.bootstrap.execPath) === normalize(executable), 'Unexpected packaged executable identity')
    allowResume = true
    resume()
    stage = 'packaged-ready'
    const readyDeadline = Date.now() + 10000
    let state
    while (Date.now() < readyDeadline && !exited && !timedOut) {
      if (pauseError) throw pauseError
      state = await evaluate(readiness, key)
      if (state.ready && state.windows.some(window => window.url.includes('/app.asar/dist/renderer/index.html') && !window.loading)) break
      await delay(100)
    }
    assert(state?.ready && state.windows.some(window => window.url.includes('/app.asar/dist/renderer/index.html') && !window.loading), 'Packaged application or renderer did not become ready')
    assert(state.packaged && normalize(state.appPath) === normalize(asar), 'Application did not run from the packaged app.asar')
    assert(inside(profile, state.userData) && inside(profile, state.sessionData), 'Application profile escaped the isolated smoke directory')
    assert(!state.rendererGone && !state.monitorErrors.length && state.windows.every(window => !window.visible), 'Packaged startup crashed or displayed a window')
    report.app = state
    stage = 'packaged-preload'
    report.renderer = await evaluate(rendererProbe, key)
    assert(report.renderer.hidden, 'Packaged renderer window was not hidden')
    stage = 'packaged-dependencies'
    report.dependencies = await evaluate(dependencyProbe, key)
    stage = 'asar-worker'
    report.worker = await evaluate(workerProbe, key)
    stage = 'normal-quit'
    report.quitAcknowledged = await rpc.evaluate('(() => { const state = globalThis[' + JSON.stringify(key) + ']; state.app.quit(); return true })()', 5000, false)
    rpc.close(); rpc = undefined
    report.exit = await boundedWait(closed, 10000, 'Packaged app normal exit deadline exceeded')
    assert(report.quitAcknowledged && report.exit.code === 0 && !timedOut && !childError, 'Packaged app did not finish a confirmed normal exit 0')
    report.ok = true
  } catch (error) {
    report.error = { stage, message: sanitize(error?.message || error).slice(0, 1024) }
    killOwned(); rpc?.close()
    report.exit = await Promise.race([closed, delay(4000).then(() => ({ code: null, signal: null, unconfirmed: true }))])
  } finally {
    clearTimeout(watchdog)
    report.endedAt = new Date().toISOString(); report.timedOut = timedOut; report.cleanup = cleanup; report.childError = childError
    for (const name of ['stdout', 'stderr']) fs.writeFileSync(path.join(runDir, name + '.log'), sanitize(logs[name]))
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(evidence, 'latest-result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ok: report.ok, stage, report: path.join(runDir, 'result.json'), exitCode: report.exit?.code, timedOut }))
  }
  return report.ok ? 0 : 1
}
if (require.main === module) main().then(code => { process.exitCode = code }, error => { console.error(sanitize(error?.message || error)); process.exitCode = 1 })
