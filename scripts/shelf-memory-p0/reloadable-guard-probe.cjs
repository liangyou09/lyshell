#!/usr/bin/env node
/*
 * 独立探针 fixture：在真实 Electron 43 里执行可重载闸门（reloadable guard）的注入脚本与快照逻辑。
 *
 * 边界：
 * - 只启动本脚本自己的 Electron 子进程，使用 tmp/ 下全新的 appData / userData / sessionData；
 * - 只监听 127.0.0.1 的 loopback fixture server，并用 host-resolver-rules 把 shelf-fixture.test 指到 127.0.0.1；
 * - 不启动 LyShell、不读用户配置、不加载 dist/main、不接生产连接、不修改任何源码或测试；
 * - 不提交、不推送、不调用外部模型或后端。
 *
 * 用法（Node 侧编排）：node scripts/shelf-memory-p0/reloadable-guard-probe.cjs
 * 该脚本会：用 esbuild 把 src/main/browser/shelf-reloadable-guard.ts 打包到 tmp/，再 spawn Electron 跑真实用例。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const outDir = path.join(root, 'tmp/reloadable-guard-probe')
const resultsPath = path.join(root, 'docs/shelf-memory-p0/reloadable-guard-probe-results.json')
const bundlePath = path.join(outDir, 'guard-bundle.cjs')
const HOST = 'shelf-fixture.test'
const sourceFiles = {
  guard: path.join(root, 'src/main/browser/shelf-reloadable-guard.ts'),
  contract: path.join(root, 'src/main/browser/shelf-readonly-contract.ts'),
  taskShelf: path.join(root, 'src/shared/task-shelf.ts'),
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const hashesOf = () => Object.fromEntries(Object.entries(sourceFiles).map(([key, file]) => [key, sha256(file)]))

// ---------------------------------------------------------------------------
// Node 侧编排：打包当前源码 -> spawn 真实 Electron -> 汇总 hash 与结果
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  fs.mkdirSync(outDir, { recursive: true })
  const hashesBefore = hashesOf()

  const esbuild = require('esbuild')
  esbuild.buildSync({
    entryPoints: [sourceFiles.guard],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: bundlePath,
    logLevel: 'warning',
    // buildSync 不允许 plugins；用 esbuild alias 复现 tsconfig 的 @shared/* 映射。
    alias: { '@shared': path.join(root, 'src/shared') },
  })
  const bundleSha = sha256(bundlePath)
  const bundleSize = fs.statSync(bundlePath).size

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'
  env.PROBE_META = JSON.stringify({
    hashesBefore,
    bundleSha,
    bundleSize,
    startedAt: new Date().toISOString(),
  })
  env.PROBE_OUT_DIR = outDir
  env.PROBE_RESULTS_PATH = resultsPath

  const startedMs = Date.now()
  const child = spawnSync(require('electron'), [__filename], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 240000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const durationMs = Date.now() - startedMs
  fs.writeFileSync(path.join(outDir, 'electron-stdout.txt'), child.stdout || '')
  fs.writeFileSync(path.join(outDir, 'electron-stderr.txt'), child.stderr || '')

  const hashesAfter = hashesOf()
  const stable = Object.keys(hashesBefore).every((key) => hashesBefore[key] === hashesAfter[key])

  let report
  try {
    report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
  } catch (error) {
    report = {
      schema: 1,
      kind: 'reloadable-guard-real-electron-probe',
      cases: [],
      errors: ['无法读取 Electron 子进程结果: ' + String((error && error.message) || error)],
    }
  }
  report.durationMs = durationMs
  report.commands = {
    probe: 'node scripts/shelf-memory-p0/reloadable-guard-probe.cjs',
    electronChild: 'electron scripts/shelf-memory-p0/reloadable-guard-probe.cjs（由编排进程 spawn，非 dist/main）',
    bundle: 'esbuild.buildSync(src/main/browser/shelf-reloadable-guard.ts -> tmp/reloadable-guard-probe/guard-bundle.cjs, platform=node, external=electron)',
    rerun: 'node scripts/shelf-memory-p0/reloadable-guard-probe.cjs',
  }
  report.runtime = {
    ...(report.runtime || {}),
    electronFromPackage: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0] && os.cpus()[0].model,
    hostResolver: `host-resolver-rules: MAP ${HOST} 127.0.0.1`,
  }
  report.sourceStability = {
    exercisedSourceHash: hashesBefore.guard,
    hashesBefore,
    hashesAfter,
    stableDuringProbe: stable,
    bundleSha256: bundleSha,
    bundleSize,
    bundleBuiltFromSourceHash: hashesBefore.guard,
    note: stable
      ? '探针运行期间源文件未变化，exercised 内容即 bundle 时的源码'
      : '探针运行期间源文件发生变化：exercised 内容是 bundle 时的那个 hash，不是当前文件',
  }
  report.exit = {
    status: child.status,
    signal: child.signal,
    error: child.error ? String(child.error.message) : null,
  }
  fs.writeFileSync(resultsPath, JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(outDir, 'raw-results.json'), JSON.stringify(report, null, 2))

  const summary = report.summary || {}
  console.log(
    JSON.stringify(
      {
        exit: report.exit,
        durationMs,
        sourceStability: { stableDuringProbe: stable, exercisedSourceHash: hashesBefore.guard },
        summary,
      },
      null,
      2
    )
  )
  process.exit(child.status === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Electron 侧：真实 webContents + 真实 persist:webbar Session + loopback fixture
// ---------------------------------------------------------------------------
const { app, BrowserWindow } = require('electron')
const http = require('node:http')

const meta = JSON.parse(process.env.PROBE_META || '{}')
const probeOutDir = process.env.PROBE_OUT_DIR || outDir
const probeResultsPath = process.env.PROBE_RESULTS_PATH || resultsPath

const appData = path.join(probeOutDir, 'appData')
const userData = path.join(probeOutDir, 'userData')
const sessionData = path.join(probeOutDir, 'sessionData')
for (const dir of [appData, userData, sessionData]) fs.mkdirSync(dir, { recursive: true })
app.setPath('appData', appData)
app.setPath('userData', userData)
app.setPath('sessionData', sessionData)
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${HOST} 127.0.0.1`)
app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

const report = {
  schema: 1,
  kind: 'reloadable-guard-real-electron-probe',
  status: 'running',
  startedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  versions: process.versions,
  runtime: {
    appData: path.relative(root, appData),
    userData: path.relative(root, userData),
    sessionData: path.relative(root, sessionData),
    isolatedProfile: true,
    network: { bind: '127.0.0.1', hostOverride: `${HOST} -> 127.0.0.1`, externalCalls: 'none by design' },
  },
  apiObservations: {},
  rounds: [],
  cases: [],
  checks: [],
  errors: [],
  limitations: [
    '未测试媒体自动播放：Electron/Chromium 自动播放策略在无用户手势下不稳定，避免把不支持当成通过。',
    '激活使用合成手势（executeJavaScript(userGesture:true) / sendInputEvent），不是真实硬件输入。',
    '文件上传未经过系统文件选择框（无法在无 UI 交互下完成）；用 File/Blob 的 PUT 请求与 <input type=file> 存在性分别覆盖。',
    '下载用例只观察 will-download 与 latch，不验证落盘内容。',
  ],
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withTimeout(promise, ms, fallbackValue) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// loopback fixture pages
// ---------------------------------------------------------------------------
function pageHtml(pathname) {
  const shell = (title, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
  switch (pathname) {
    case '/clean':
      return shell('clean', '<h1>clean fixture</h1><p>plain text</p><script>window.__probeRan=1;window.__heapMarker="alive"</script>')
    case '/clean2':
      return shell('clean2', '<h1>clean fixture two</h1><p>plain text</p><script>window.__probeRan=1;window.__clean2=1</script>')
    case '/cookies':
      // 不在 HTML 里写 __heapMarker：它必须由主进程在加载后写入 page heap，reload 后消失才能证明 heap 丢失。
      return shell('cookies', '<h1>cookie fixture</h1><p>cookie</p><script>window.__probeRan=1</script>')
    case '/control-flash':
      return shell(
        'control-flash',
        '<h1>control flash</h1><script>window.__probeRan=1;setTimeout(function(){var input=document.createElement("input");input.type="text";document.body.appendChild(input);window.__controlAdded=1;setTimeout(function(){input.remove();window.__controlRemoved=1},400)},800)</script>'
      )
    case '/iframe':
      return shell('iframe', '<h1>iframe fixture</h1><iframe src="/clean" width="200" height="80"></iframe><script>window.__probeRan=1</script>')
    case '/file':
      return shell('file', '<h1>file input</h1><input type="file" id="probe-file"><script>window.__probeRan=1</script>')
    case '/post':
      return shell(
        'post',
        '<h1>post fixture</h1><script>window.__probeRan=1;fetch("/post-target",{method:"POST",body:"probe"}).then(function(){window.__postDone=1},function(){window.__postDone=-1})</script>'
      )
    case '/upload':
      return shell(
        'upload',
        '<h1>upload fixture</h1><input type="file"><script>window.__probeRan=1;var fd=new FormData();fd.append("file",new Blob(["probe"]),"probe.bin");fetch("/post-target",{method:"PUT",body:fd}).then(function(){window.__uploadDone=1},function(){window.__uploadDone=-1})</script>'
      )
    case '/pending':
      return shell(
        'pending',
        '<h1>pending fixture</h1><script>window.__probeRan=1;window.__pendingStarted=1;fetch("/slow").then(function(){window.__pendingDone=1},function(){})</script>'
      )
    case '/input-events':
      return shell(
        'input-events',
        '<h1>input fixture</h1><script>window.__probeRan=1;window.__events=[];["keydown","beforeinput","input"].forEach(function(type){document.addEventListener(type,function(event){window.__events.push({type:type,prevented:event.defaultPrevented===true})},true)})</script>'
      )
    case '/tall':
      return shell(
        'tall',
        '<h1>tall fixture</h1><div style="height:4000px;background:linear-gradient(#fff,#ddd)">tall</div><script>window.__probeRan=1</script>'
      )
    case '/download':
      return shell('download', '<h1>download fixture</h1><script>window.__probeRan=1</script>')
    default:
      return shell('fixture', '<h1>fixture</h1><script>window.__probeRan=1</script>')
  }
}

function startServer() {
  const access = []
  const held = []
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0]
    const entry = { method: req.method, path: name, host: req.headers.host, at: Date.now(), status: null }
    access.push(entry)
    res.on('finish', () => {
      entry.status = res.statusCode
    })
    if (name === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    if (name === '/slow') {
      // 故意不响应：制造 pending GET。
      held.push(res)
      return
    }
    if (name === '/post-target') {
      res.writeHead(204)
      res.end()
      return
    }
    if (name === '/download-file') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="probe.bin"',
      })
      res.end('probe')
      return
    }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    if (name === '/cookies') headers['Set-Cookie'] = 'probe_session=ok; Path=/; Max-Age=600; SameSite=Lax'
    res.writeHead(200, headers)
    res.end(pageHtml(name))
  })
  return { server, access, held }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let win = null
let wc = null
let ses = null
let guard = null
let guardModule = null
let origin = null
let accessLog = []
let heldResponses = []
let downloadEvents = 0
let finished = false
let lastLatchCodes = []

function writeReport() {
  report.durationMs = Date.now() - (report.startedAtMs || Date.now())
  try {
    fs.mkdirSync(path.dirname(probeResultsPath), { recursive: true })
    fs.writeFileSync(probeResultsPath, JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(probeOutDir, 'raw-results.json'), JSON.stringify(report, null, 2))
  } catch (error) {
    console.error('write report failed', error)
  }
}

function finish(code) {
  if (finished) return
  finished = true
  report.status = code === 0 ? 'completed' : 'failed'
  report.finishedAt = new Date().toISOString()
  report.summary = summarize()
  writeReport()
  for (const res of heldResponses) {
    try {
      res.destroy()
    } catch {
      // ignore
    }
  }
  try {
    if (win && !win.isDestroyed()) win.destroy()
  } catch {
    // ignore
  }
  setTimeout(() => app.exit(code), 50)
}

function summarize() {
  const cases = report.cases
  const failed = cases.filter((item) => item.pass !== true)
  const checks = cases.flatMap((item) =>
    Object.entries(item.checks || {}).map(([name, value]) => ({ case: item.name, round: item.round, check: name, pass: value === true }))
  )
  report.checks = checks
  return {
    rounds: report.rounds.length,
    cases: cases.length,
    passed: cases.length - failed.length,
    failed: failed.length,
    failedCases: failed.map((item) => ({ round: item.round, name: item.name, checks: item.checks, error: item.error || null })),
    checks: { total: checks.length, passed: checks.filter((c) => c.pass).length },
    decisions: cases.reduce((acc, item) => {
      const key = (item.finalSnapshot && item.finalSnapshot.decision) || 'none'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {}),
    sourceHash: meta.hashesBefore && meta.hashesBefore.guard,
    bundleSha: meta.bundleSha,
    errors: report.errors,
  }
}

async function guardSnapshot() {
  // 快照依赖 renderer 的 isolated world；若 renderer 卡住，用超时把它降级成 unknown 观测而不是挂死探针。
  const snapshot = await withTimeout(guard.snapshot(), 6000, {
    decision: 'unknown',
    reasonCodes: ['harness-timeout'],
    harnessTimeout: true,
  })
  return snapshot
}

async function iso(code, userGesture) {
  const result = await withTimeout(
    wc.executeJavaScriptInIsolatedWorld(1005, [{ code }], userGesture === true),
    6000,
    '__ISOLATED_TIMEOUT__'
  )
  if (result === '__ISOLATED_TIMEOUT__') throw new Error('executeJavaScriptInIsolatedWorld 超时')
  return result
}

async function js(code) {
  return wc.executeJavaScript(code)
}

async function pageFlag(name) {
  try {
    return await js(`String(window[${JSON.stringify(name)}])`)
  } catch (error) {
    return `error:${String((error && error.message) || error)}`
  }
}

async function pageJson(expr) {
  try {
    return JSON.parse(await js(`JSON.stringify(${expr})`))
  } catch (error) {
    return { error: String((error && error.message) || error) }
  }
}

async function waitForFlag(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await pageFlag(name)
    if (value !== 'undefined' && !String(value).startsWith('error:')) return value
    await sleep(80)
  }
  return 'timeout'
}

async function activate(reason) {
  const trials = []
  const probeActivation = async () => {
    const raw = await iso(
      'JSON.stringify({ has: !!navigator.userActivation, active: navigator.userActivation ? navigator.userActivation.hasBeenActive === true : null, transient: navigator.userActivation ? navigator.userActivation.isActive === true : null })'
    )
    try {
      return JSON.parse(raw)
    } catch {
      return { raw: String(raw) }
    }
  }
  const attempt = async (label, action) => {
    let error = null
    try {
      await action()
    } catch (thrown) {
      error = String((thrown && thrown.message) || thrown)
    }
    await sleep(120)
    const evidence = await probeActivation()
    const snapshot = await guardSnapshot()
    const observed = evidence.active === true
    trials.push({
      label,
      synthetic: true,
      hardwareInput: false,
      error,
      isolatedWorldUserActivation: evidence,
      snapshot: { decision: snapshot.decision, reasonCodes: snapshot.reasonCodes },
      activationObserved: observed,
    })
    return observed
  }

  if (await attempt('executeJavaScriptInIsolatedWorld:userGesture=true', () => iso('void 0', true))) return { ok: true, method: 'executeJavaScriptInIsolatedWorld:userGesture', reason, trials }
  if (await attempt('executeJavaScript:userGesture=true(mainWorld)', () => js('void 0', true))) return { ok: true, method: 'executeJavaScript:userGesture', reason, trials }
  if (
    await attempt('sendInputEvent:mouse-down+up(hidden-window)', async () => {
      wc.focus()
      wc.sendInputEvent({ type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: 30, y: 30, button: 'left', clickCount: 1 })
    })
  )
    return { ok: true, method: 'sendInputEvent:mouse', reason, trials }
  if (
    await attempt('showInactive+sendInputEvent:mouse', async () => {
      win.showInactive()
      await sleep(150)
      wc.focus()
      wc.sendInputEvent({ type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: 30, y: 30, button: 'left', clickCount: 1 })
    })
  )
    return { ok: true, method: 'showInactive+sendInputEvent:mouse', reason, trials }
  return { ok: false, method: null, reason, trials }
}

async function loadPage(pathname) {
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no webContents' }
  const url = origin + pathname
  const loaded = new Promise((resolve) => {
    const onFinish = () => {
      cleanup()
      resolve({ ok: true, url: wc.getURL() })
    }
    const onFail = (_event, code, desc, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return
      cleanup()
      resolve({ ok: false, code, desc, validatedURL })
    }
    const cleanup = () => {
      try {
        wc.removeListener('did-finish-load', onFinish)
        wc.removeListener('did-fail-load', onFail)
      } catch {
        // ignore
      }
    }
    wc.on('did-finish-load', onFinish)
    wc.on('did-fail-load', onFail)
    wc.loadURL(url).catch((error) => {
      cleanup()
      resolve({ ok: false, error: String((error && error.message) || error) })
    })
  })
  const result = await withTimeout(loaded, 10000, { ok: false, timeout: true, url })
  await sleep(250)
  return { ...result, requested: url }
}

async function reloadPage() {
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no webContents' }
  const reloaded = new Promise((resolve) => {
    const onFinish = () => {
      cleanup()
      resolve({ ok: true, url: wc.getURL() })
    }
    const cleanup = () => {
      try {
        wc.removeListener('did-finish-load', onFinish)
      } catch {
        // ignore
      }
    }
    wc.on('did-finish-load', onFinish)
    wc.reload()
    setTimeout(() => {
      cleanup()
      resolve({ ok: false, timeout: true })
    }, 10000)
  })
  const result = await withTimeout(reloaded, 10000, { ok: false, timeout: true })
  await sleep(300)
  return result
}

async function snapshotRecord(label, options) {
  const opts = options || {}
  const attempts = []
  for (let index = 0; index < (opts.retries || 1); index += 1) {
    if (index > 0) await sleep(opts.retryDelayMs || 250)
    const snapshot = await guardSnapshot()
    attempts.push(snapshot)
    if (snapshot.decision === 'safe') break
  }
  const final = attempts[attempts.length - 1]
  lastLatchCodes = (final && final.reasonCodes) || []
  return { label, attempts, final }
}

function check(name, value, note) {
  return { name, value: value === true, note: note || null }
}

function evalChecks(checks) {
  return checks.every((item) => item.value === true)
}

async function caseCleanNoActivation(round) {
  // 上一用例的 latch 码必须在这次完整导航后消失；先取快照再比较会丢掉“上一个用例”的值。
  const previousLatch = lastLatchCodes.slice()
  const nav = await loadPage('/clean')
  const stale = await snapshotRecord('clean-before-activation')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.timeout ? 'timeout' : nav.error || nav.desc || null),
    check('not-safe-without-activation', stale.final.decision !== 'safe', `decision=${stale.final.decision}`),
    check('no-user-activation-code', stale.final.reasonCodes.includes('no-user-activation')),
    check('previous-latch-cleared', previousLatch.every((code) => !stale.final.reasonCodes.includes(code)), `previous=${JSON.stringify(previousLatch)} now=${JSON.stringify(stale.final.reasonCodes)}`),
    check('page-javascript-ran', (await pageFlag('__probeRan')) === '1'),
  ]
  return {
    name: 'clean-no-activation',
    expected: 'blocked:no-user-activation（导航后旧 latch 必须消失）',
    nav,
    snapshots: stale.attempts,
    finalSnapshot: stale.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseCleanWithActivation(round) {
  const nav = await loadPage('/clean')
  const activation = await activate('positive-clean')
  const first = await snapshotRecord('clean-safe', { retries: 3 })
  const second = await snapshotRecord('clean-safe-repeat', { retries: 3 })
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('activation-observed', activation.ok === true, activation.method),
    check('safe', first.final.decision === 'safe', `decision=${first.final.decision} codes=${JSON.stringify(first.final.reasonCodes)}`),
    check('nonce-present', /^[a-f0-9]{32}$/.test(first.final.documentNonce || '')),
    check('nonce-stable-across-snapshots', first.final.documentNonce === second.final.documentNonce),
    check('scroll-bounded', typeof first.final.scrollY === 'number' && first.final.scrollY >= 0),
    check('url-echoed', first.final.url === origin + '/clean', `url=${first.final.url}`),
    check('page-javascript-ran', (await pageFlag('__probeRan')) === '1'),
  ]
  return {
    name: 'clean-with-activation',
    expected: 'safe（合成激活后），nonce 在重复快照间稳定',
    nav,
    activation,
    snapshots: [...first.attempts, ...second.attempts],
    finalSnapshot: first.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseSameUrlReload(round) {
  const nav = await loadPage('/cookies')
  const beforeActivation = await snapshotRecord('cookies-before-activation')
  const activation = await activate('reload-before')
  const before = await snapshotRecord('cookies-safe', { retries: 3 })
  // 由主进程写入当前 page heap：reload 后新文档不继承，才能作为“heap 丢失”的证据。
  await js('window.__heapMarker = "alive"')
  const cookiesBefore = await ses.cookies.get({ url: origin + '/cookies' })
  const heapBefore = await pageFlag('__heapMarker')

  const reloadResult = await reloadPage()

  const heapAfter = await pageFlag('__heapMarker')
  const cookiesAfter = await ses.cookies.get({ url: origin + '/cookies' })
  const afterReloadNoActivation = await snapshotRecord('cookies-after-reload')
  const activationAfter = await activate('reload-after')
  const after = await snapshotRecord('cookies-after-reload-safe', { retries: 3 })
  const getLogs = accessLog.filter((entry) => entry.method === 'GET' && entry.path === '/cookies')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('reload-same-url', reloadResult.ok === true && after.final.url === origin + '/cookies', `url=${after.final.url}`),
    check('without-activation-not-safe', beforeActivation.final.decision !== 'safe'),
    check('activation-observed', activation.ok === true, activation.method),
    check('safe-before-reload', before.final.decision === 'safe', `decision=${before.final.decision}`),
    check('cookie-present-before', cookiesBefore.length > 0, `count=${cookiesBefore.length}`),
    check('cookie-preserved-after-reload', cookiesAfter.length > 0, `count=${cookiesAfter.length}`),
    check('heap-marker-before', heapBefore === 'alive', `value=${heapBefore}`),
    check('heap-lost-after-reload', heapAfter === 'undefined', `value=${heapAfter}`),
    check('activation-reset-after-reload', afterReloadNoActivation.final.decision !== 'safe'),
    check('re-activation-observed', activationAfter.ok === true, activationAfter.method),
    check('safe-after-reload', after.final.decision === 'safe', `decision=${after.final.decision}`),
    check('nonce-rotated-after-reload', before.final.documentNonce !== after.final.documentNonce),
    check('complete-get-network', getLogs.filter((entry) => entry.status === 200).length >= 2, `GET /cookies count=${getLogs.length}`),
  ]
  return {
    name: 'same-url-get-reload',
    expected: '同一 URL GET reload：cookie 保留（仅布尔）、JS heap 丢失、activation 重置、nonce 轮换、网络 200',
    nav,
    activation,
    activationAfter,
    reloadResult,
    cookies: {
      beforeCount: cookiesBefore.length,
      afterCount: cookiesAfter.length,
      namesRecorded: false,
    },
    heap: { before: heapBefore, after: heapAfter },
    snapshots: [...before.attempts, ...afterReloadNoActivation.attempts, ...after.attempts],
    finalSnapshot: after.final,
    network: getLogs,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseNavigationRotatesNonce(round, baselineNonce) {
  const nav = await loadPage('/clean2')
  const activation = await activate('nav-nonce')
  const snapshot = await snapshotRecord('clean2-safe', { retries: 3 })
  const frames = wc.mainFrame ? wc.mainFrame.framesInSubtree : null
  const frameShape = {
    present: !!wc.mainFrame,
    isArray: Array.isArray(frames),
    length: Array.isArray(frames) ? frames.length : null,
    firstIsMainFrame: Array.isArray(frames) ? frames[0] === wc.mainFrame : null,
    elementTypes: Array.isArray(frames) ? frames.map((frame) => (frame && frame.constructor ? frame.constructor.name : typeof frame)) : null,
  }
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('activation-observed', activation.ok === true, activation.method),
    check('safe', snapshot.final.decision === 'safe', `decision=${snapshot.final.decision} codes=${JSON.stringify(snapshot.final.reasonCodes)}`),
    check('nonce-rotated-by-navigation', Boolean(baselineNonce) && snapshot.final.documentNonce !== baselineNonce),
    check('url-is-new-document', snapshot.final.url === origin + '/clean2'),
    check('single-main-frame', frameShape.isArray === true && frameShape.length === 1 && frameShape.firstIsMainFrame === true),
  ]
  report.apiObservations.framesInSubtree = report.apiObservations.framesInSubtree || frameShape
  return {
    name: 'navigation-rotates-nonce',
    expected: '真实导航换新 nonce；单主框架',
    nav,
    activation,
    snapshots: snapshot.attempts,
    finalSnapshot: snapshot.final,
    framesInSubtree: frameShape,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseControlAddedRemoved(round) {
  const nav = await loadPage('/control-flash')
  const activation = await activate('control-flash')
  const first = await snapshotRecord('control-before-add', { retries: 3 })
  const added = await waitForFlag('__controlAdded', 3000)
  const removed = await waitForFlag('__controlRemoved', 4000)
  const after = await snapshotRecord('control-after-remove')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('activation-observed', activation.ok === true, activation.method),
    check('safe-before-control', first.final.decision === 'safe', `decision=${first.final.decision}`),
    check('control-added', added === '1', `__controlAdded=${added}`),
    check('control-removed', removed === '1', `__controlRemoved=${removed}`),
    check('no-control-in-dom-now', (await pageJson('[document.querySelectorAll("input,textarea,select").length]'))[0] === 0),
    check('blocked-after-removal', after.final.decision === 'blocked', `decision=${after.final.decision}`),
    check('editable-control-code', after.final.reasonCodes.includes('editable-control')),
  ]
  return {
    name: 'control-added-then-removed',
    expected: '控件出现过即 latch；移除后仍 blocked（latch 直到下一次完整导航）',
    nav,
    activation,
    snapshots: [...first.attempts, ...after.attempts],
    finalSnapshot: after.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseFileInput(round) {
  const nav = await loadPage('/file')
  const activation = await activate('file-input')
  const snapshot = await snapshotRecord('file-input-blocked')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('blocked', snapshot.final.decision === 'blocked', `decision=${snapshot.final.decision}`),
    check('editable-control-code', snapshot.final.reasonCodes.includes('editable-control')),
  ]
  return {
    name: 'file-input-present',
    expected: 'blocked:editable-control（不打开选择框）',
    nav,
    activation,
    snapshots: snapshot.attempts,
    finalSnapshot: snapshot.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseIframe(round) {
  const nav = await loadPage('/iframe')
  await sleep(400)
  const activation = await activate('iframe')
  const snapshot = await snapshotRecord('iframe-blocked', { retries: 2 })
  const frames = wc.mainFrame ? wc.mainFrame.framesInSubtree : null
  const shape = {
    isArray: Array.isArray(frames),
    length: Array.isArray(frames) ? frames.length : null,
    elementTypes: Array.isArray(frames) ? frames.map((frame) => (frame && frame.constructor ? frame.constructor.name : typeof frame)) : null,
  }
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('frames-in-subtree-greater-than-one', shape.isArray === true && shape.length > 1, `length=${shape.length}`),
    check('not-safe', snapshot.final.decision !== 'safe', `decision=${snapshot.final.decision}`),
    check('subframe-code', snapshot.final.reasonCodes.includes('subframe-present'), JSON.stringify(snapshot.final.reasonCodes)),
  ]
  report.apiObservations.iframeFramesInSubtree = shape
  return {
    name: 'iframe-present',
    expected: 'framesInSubtree>1 => blocked:subframe-present',
    nav,
    activation,
    snapshots: snapshot.attempts,
    finalSnapshot: snapshot.final,
    framesInSubtree: shape,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function casePost(round) {
  const nav = await loadPage('/post')
  const done = await waitForFlag('__postDone', 3000)
  const activation = await activate('post')
  const snapshot = await snapshotRecord('post-blocked')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('post-completed', done === '1', `__postDone=${done}`),
    check('blocked', snapshot.final.decision === 'blocked', `decision=${snapshot.final.decision}`),
    check('non-get-code', snapshot.final.reasonCodes.includes('non-get-request'), JSON.stringify(snapshot.final.reasonCodes)),
  ]
  return {
    name: 'post-request-observed',
    expected: 'blocked:non-get-request（观察，不取消请求）',
    nav,
    activation,
    snapshots: snapshot.attempts,
    finalSnapshot: snapshot.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function casePendingGet(round) {
  const nav = await loadPage('/pending')
  const started = await waitForFlag('__pendingStarted', 2000)
  await sleep(400)
  const snapshot = await snapshotRecord('pending-get')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('fetch-started', started === '1', `__pendingStarted=${started}`),
    check('blocked', snapshot.final.decision === 'blocked', `decision=${snapshot.final.decision}`),
    check('request-pending-code', snapshot.final.reasonCodes.includes('request-pending'), JSON.stringify(snapshot.final.reasonCodes)),
  ]
  return {
    name: 'pending-get',
    expected: 'blocked:request-pending（未完成请求）',
    nav,
    snapshots: snapshot.attempts,
    finalSnapshot: snapshot.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseBlockDuringSnapshot(round) {
  const nav = await loadPage('/clean')
  const activation = await activate('block-race')
  const before = await snapshotRecord('block-race-before', { retries: 2 })
  const pending = guardSnapshot()
  guard.block('user-timeout')
  const during = await pending
  const after = await snapshotRecord('block-race-after')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('safe-before-block', before.final.decision === 'safe', `decision=${before.final.decision}`),
    check('in-flight-not-safe', during.decision === 'blocked', `decision=${during.decision}`),
    check('explicit-code-visible', during.reasonCodes.includes('user-timeout') || after.final.reasonCodes.includes('user-timeout'), JSON.stringify({ during: during.reasonCodes, after: after.final.reasonCodes })),
    check('blocked-after', after.final.decision === 'blocked'),
  ]
  return {
    name: 'explicit-block-during-snapshot',
    expected: '在途快照不能被旧文档干净回包覆盖；显式 block 保留',
    nav,
    activation,
    snapshots: [...before.attempts, during, ...after.attempts],
    finalSnapshot: after.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseInputNotPrevented(round) {
  const nav = await loadPage('/input-events')
  const activation = await activate('input-case')
  win.showInactive()
  await sleep(150)
  wc.focus()
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
  wc.sendInputEvent({ type: 'char', keyCode: 'A' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
  await sleep(250)
  const events = await pageJson('window.__events || []')
  const snapshot = await snapshotRecord('input-blocked')
  const prevented = Array.isArray(events) ? events.filter((event) => event && event.prevented === true) : []
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('activation-observed', activation.ok === true, activation.method),
    check('page-received-key-events', Array.isArray(events) && events.length > 0, `events=${JSON.stringify(events)}`),
    check('guard-did-not-prevent-default', prevented.length === 0, `prevented=${JSON.stringify(prevented)}`),
    check('page-javascript-still-ran', (await pageFlag('__probeRan')) === '1'),
    check('blocked-after-key', snapshot.final.decision === 'blocked', `decision=${snapshot.final.decision}`),
    check('key-input-code', snapshot.final.reasonCodes.includes('key-input'), JSON.stringify(snapshot.final.reasonCodes)),
  ]
  return {
    name: 'input-not-prevented',
    expected: '键盘输入仍送达网页且 defaultPrevented=false；闸门只观察并 latch key-input',
    nav,
    activation,
    pageEvents: events,
    snapshots: snapshot.attempts,
    finalSnapshot: snapshot.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseDebuggerAttach(round) {
  const nav = await loadPage('/clean')
  const activation = await activate('debugger')
  const before = await snapshotRecord('debugger-before', { retries: 2 })
  let attachError = null
  try {
    wc.debugger.attach('1.3')
  } catch (error) {
    attachError = String((error && error.message) || error)
  }
  await sleep(200)
  const attachedSnapshot = await snapshotRecord('debugger-attached')
  const isAttached = wc.debugger.isAttached()
  try {
    wc.debugger.detach()
  } catch {
    // ignore
  }
  await sleep(150)
  const afterDetach = await snapshotRecord('debugger-detached')
  const cleared = await loadPage('/clean')
  const activationAfter = await activate('debugger-cleared')
  const recovered = await snapshotRecord('debugger-cleared-safe', { retries: 3 })
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('safe-before-debugger', before.final.decision === 'safe', `decision=${before.final.decision}`),
    check('attach-worked', attachError === null && isAttached === true, attachError || `isAttached=${isAttached}`),
    check('blocked-while-attached', attachedSnapshot.final.decision !== 'safe' && attachedSnapshot.final.reasonCodes.includes('devtools-open'), JSON.stringify(attachedSnapshot.final)),
    check('latch-survives-detach', afterDetach.final.decision !== 'safe', `decision=${afterDetach.final.decision}`),
    check('navigation-clears-latch', cleared.ok === true && recovered.final.decision === 'safe', `decision=${recovered.final.decision} codes=${JSON.stringify(recovered.final.reasonCodes)}`),
  ]
  report.apiObservations.debugger = {
    hasDebugger: !!wc.debugger,
    isAttached: typeof wc.debugger.isAttached === 'function' ? isAttached : null,
    attachError,
  }
  return {
    name: 'debugger-attached',
    expected: 'debugger attach => 当前导航永久 blocked:devtools-open；下一次完整导航才清除',
    nav,
    activation,
    activationAfter,
    snapshots: [...before.attempts, ...attachedSnapshot.attempts, ...afterDetach.attempts, ...recovered.attempts],
    finalSnapshot: attachedSnapshot.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseDownload(round) {
  const nav = await loadPage('/download')
  const activation = await activate('download')
  const beforeDownload = downloadEvents
  const navigated = await withTimeout(
    wc.loadURL(origin + '/download-file').then(() => ({ ok: true })).catch((error) => ({ ok: false, error: String((error && error.message) || error) })),
    5000,
    { ok: false, timeout: true }
  )
  await sleep(600)
  const snapshot = await snapshotRecord('download-blocked')
  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('download-triggered', downloadEvents > beforeDownload, `downloadEvents=${downloadEvents}`),
    check('not-safe', snapshot.final.decision !== 'safe', `decision=${snapshot.final.decision}`),
    check('download-code', snapshot.final.reasonCodes.includes('download'), JSON.stringify(snapshot.final.reasonCodes)),
  ]
  return {
    name: 'download-observed',
    expected: 'will-download => latch blocked:download',
    nav,
    activation,
    navigated,
    snapshots: snapshot.attempts,
    finalSnapshot: snapshot.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function caseScrollRestore(round) {
  const nav = await loadPage('/tall')
  const activation = await activate('restore-top')
  const top = await snapshotRecord('tall-top', { retries: 3 })
  await js('window.scrollTo(0, 900)')
  await sleep(300)
  const scrolled = await snapshotRecord('tall-scrolled')
  const scrolledPosition = await pageJson('({ y: window.scrollY })')

  const reloadResult = await reloadPage()
  const activationAfter = await activate('restore-after-reload')
  // Chromium 自身会在 reload 后恢复滚动位置；先显式归零，才能证明恢复动作来自 guard。
  await js('window.scrollTo(0, 0)')
  await sleep(300)
  const fresh = await snapshotRecord('tall-reloaded', { retries: 3 })
  const freshPosition = await pageJson('({ y: window.scrollY })')

  // 旧文档 nonce 的恢复必须对新文档无效（不能移动后来的文档）。
  const stale = await withTimeout(
    guard.restoreScroll(scrolled.final.documentNonce, 900).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: String((error && error.message) || error) })),
    5000,
    { ok: false, timeout: true }
  )
  await sleep(300)
  const afterStale = await pageJson('({ y: window.scrollY })')

  const current = await withTimeout(
    guard.restoreScroll(fresh.final.documentNonce, 900).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: String((error && error.message) || error) })),
    5000,
    { ok: false, timeout: true }
  )
  await sleep(400)
  const afterRestore = await pageJson('({ y: window.scrollY })')
  const finalSnapshot = await snapshotRecord('tall-restored')

  const checks = [
    check('navigation-completed', nav.ok === true, nav.error || nav.desc || null),
    check('activation-observed', activation.ok === true, activation.method),
    check('safe-at-top', top.final.decision === 'safe', `decision=${top.final.decision}`),
    check('programmatic-scroll-applied', scrolledPosition && scrolledPosition.y >= 800, JSON.stringify(scrolledPosition)),
    check('snapshot-sees-scroll', typeof scrolled.final.scrollY === 'number' && scrolled.final.scrollY >= 800, `scrollY=${scrolled.final.scrollY}`),
    check('reload-completed', reloadResult.ok === true, reloadResult.error || null),
    check('nonce-rotated-after-reload', fresh.final.documentNonce !== scrolled.final.documentNonce),
    check('reloaded-doc-reset-to-top', freshPosition && freshPosition.y <= 1, JSON.stringify(freshPosition)),
    check('stale-nonce-no-op', afterStale && freshPosition && afterStale.y === freshPosition.y, `fresh=${JSON.stringify(freshPosition)} afterStale=${JSON.stringify(afterStale)}`),
    check('restore-converged', afterRestore && Math.abs(afterRestore.y - 900) <= 2, JSON.stringify(afterRestore)),
    check('safe-after-restore', finalSnapshot.final.decision === 'safe', `decision=${finalSnapshot.final.decision} codes=${JSON.stringify(finalSnapshot.final.reasonCodes)}`),
    check('snapshot-scroll-matches', Math.abs((finalSnapshot.final.scrollY || 0) - 900) <= 2, `scrollY=${finalSnapshot.final.scrollY}`),
  ]
  return {
    name: 'scroll-restore',
    expected: '真实文档滚动可被快照观测；reload 后旧 nonce 恢复无效，新 nonce 恢复到原位置（±2px）',
    nav,
    activation,
    activationAfter,
    reloadResult,
    positions: {
      scrolled: scrolledPosition,
      reloadedAfterReset: freshPosition,
      afterStaleNonceRestore: afterStale,
      afterRestore,
      snapshotScrollY: finalSnapshot.final.scrollY,
    },
    snapshots: [...top.attempts, ...scrolled.attempts, ...fresh.attempts, ...finalSnapshot.attempts],
    finalSnapshot: finalSnapshot.final,
    checks: Object.fromEntries(checks.map((item) => [item.name, item.value])),
    details: checks,
    pass: evalChecks(checks),
  }
}

async function runRound(round) {
  const entries = []
  const order = [
    ['clean-no-activation', caseCleanNoActivation],
    ['clean-with-activation', caseCleanWithActivation],
    ['same-url-get-reload', caseSameUrlReload],
    ['navigation-rotates-nonce', caseNavigationRotatesNonce],
    ['control-added-then-removed', caseControlAddedRemoved],
    ['file-input-present', caseFileInput],
    ['iframe-present', caseIframe],
    ['post-request-observed', casePost],
    ['pending-get', casePendingGet],
    ['explicit-block-during-snapshot', caseBlockDuringSnapshot],
    ['input-not-prevented', caseInputNotPrevented],
    ['scroll-restore', caseScrollRestore],
    ['debugger-attached', caseDebuggerAttach],
    ['download-observed', caseDownload],
  ]
  let baselineNonce = null
  for (const [name, fn] of order) {
    const startedAt = Date.now()
    let result
    try {
      if (name === 'navigation-rotates-nonce') result = await fn(round, baselineNonce)
      else result = await fn(round)
    } catch (error) {
      result = {
        name,
        expected: 'case',
        checks: {},
        error: String((error && error.stack) || error),
        pass: false,
        finalSnapshot: null,
      }
      report.errors.push({ round, case: name, error: String((error && error.message) || error) })
    }
    result.round = round
    result.durationMs = Date.now() - startedAt
    if (name === 'clean-with-activation' && result.finalSnapshot && result.finalSnapshot.decision === 'safe') {
      baselineNonce = result.finalSnapshot.documentNonce
    }
    if (result.finalSnapshot && Array.isArray(result.finalSnapshot.reasonCodes)) lastLatchCodes = result.finalSnapshot.reasonCodes
    entries.push(result)
    report.cases.push(result)
    console.log(`[round ${round}] ${name} ${result.pass ? 'PASS' : 'FAIL'} ${result.durationMs}ms`)
  }
  report.rounds.push({ round, at: new Date().toISOString(), cases: entries.map((item) => ({ name: item.name, pass: item.pass, durationMs: item.durationMs })) })
}

async function apiObservations() {
  const frames = wc.mainFrame ? wc.mainFrame.framesInSubtree : null
  const serviceWorkers = ses.serviceWorkers
  let workerShape = { hasServiceWorkers: !!serviceWorkers, typeOfGetAllRunning: typeof (serviceWorkers && serviceWorkers.getAllRunning) }
  try {
    const returned = serviceWorkers.getAllRunning()
    if (returned && typeof returned.then === 'function') {
      const resolved = await withTimeout(returned, 1500, '__timeout__')
      workerShape = { ...workerShape, returnKind: 'thenable', resolvedKeys: resolved === '__timeout__' ? null : Object.keys(resolved || {}).length }
    } else {
      workerShape = { ...workerShape, returnKind: 'plain', keys: Object.keys(returned || {}).length, prototype: returned && returned.constructor ? returned.constructor.name : typeof returned }
    }
  } catch (error) {
    workerShape = { ...workerShape, error: String((error && error.message) || error) }
  }
  report.apiObservations.serviceWorkers = workerShape
  report.apiObservations.mainFrame = {
    present: !!wc.mainFrame,
    framesIsArray: Array.isArray(frames),
    framesLength: Array.isArray(frames) ? frames.length : null,
    firstIsMainFrame: Array.isArray(frames) ? frames[0] === wc.mainFrame : null,
    processId: wc.mainFrame ? wc.mainFrame.processId : null,
    routingId: wc.mainFrame ? wc.mainFrame.routingId : null,
  }
  report.apiObservations.session = {
    partition: wc.session === require('electron').session.fromPartition('persist:webbar') ? 'persist:webbar' : 'other',
    sameInstance: wc.session === ses,
    isPersistent: typeof ses.isPersistent === 'function' ? ses.isPersistent() : null,
    readonly: false,
  }
  report.apiObservations.inject = {
    isolatedWorldId: 1005,
    hasExecuteJavaScriptInIsolatedWorld: typeof wc.executeJavaScriptInIsolatedWorld === 'function',
    userGestureParamSupported: true,
  }
}

async function isolatedWorldGlobals() {
  report.apiObservations.inject = report.apiObservations.inject || { isolatedWorldId: 1005 }
  try {
    const raw = await iso(
      'JSON.stringify({ userActivation: !!navigator.userActivation, readyState: document.readyState, top: window.top === window, isolatedGlobalMarker: typeof globalThis.__lyshellReloadableV1 })'
    )
    report.apiObservations.inject.isolatedWorldGlobals = JSON.parse(raw)
  } catch (error) {
    report.apiObservations.inject.isolatedWorldGlobals = { error: String((error && error.message) || error) }
  }
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    report.errors.push('watchdog: 探针超过 170 秒未完成')
    finish(4)
  }, 170000)
  try {
    const { server, access, held } = startServer()
    heldResponses = held
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://${HOST}:${server.address().port}`
    accessLog = access
    report.origin = origin
    report.serverPort = server.address().port

    win = new BrowserWindow({
      show: false,
      x: -2400,
      y: -2400,
      width: 900,
      height: 700,
      webPreferences: {
        partition: 'persist:webbar',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    })
    wc = win.webContents
    ses = wc.session
    ses.on('will-download', (_event, item) => {
      downloadEvents += 1
      try {
        item.cancel()
      } catch {
        // ignore
      }
    })

    guardModule = require(process.env.PROBE_BUNDLE || bundlePath)
    report.guardModule = {
      provider: guardModule.RELOADABLE_PROVIDER,
      exports: Object.keys(guardModule).sort(),
      bundlePath: path.relative(root, bundlePath),
      bundleSha: meta.bundleSha,
      bundledSourceHash: meta.hashesBefore && meta.hashesBefore.guard,
    }
    guardModule.initializeReloadableSession(ses)
    guard = new guardModule.ReloadablePageGuard(wc, ses)

    const initial = await loadPage('/clean')
    report.initialLoad = { ok: initial.ok, url: initial.url, requested: initial.requested }
    await sleep(300)
    await apiObservations()
    await isolatedWorldGlobals()

    for (let round = 1; round <= 3; round += 1) {
      await runRound(round)
    }

    clearTimeout(watchdog)
    finish(0)
  } catch (error) {
    clearTimeout(watchdog)
    report.errors.push(String((error && error.stack) || error))
    finish(3)
  }
})

if (process.versions.electron) {
  process.on('uncaughtException', (error) => {
    report.errors.push('uncaughtException: ' + String((error && error.stack) || error))
    finish(5)
  })
  process.on('unhandledRejection', (error) => {
    report.errors.push('unhandledRejection: ' + String((error && error.stack) || error))
  })
}
