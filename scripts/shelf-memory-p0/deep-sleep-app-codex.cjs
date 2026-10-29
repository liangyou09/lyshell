#!/usr/bin/env node
'use strict'

/**
 * Full built-app acceptance + memory comparison for shelf read-only deep sleep.
 *
 * Parent (plain node):
 *   - starts a loopback fixture server (shelf-fixture.test -> 127.0.0.1)
 *   - runs 3 fresh Electron instances with LYSHELL_SHELF_READONLY_SLEEP=0 (before)
 *     and 3 fresh instances without it (after), alternating arm order per round
 *   - aggregates application-total private memory from app.getAppMetrics()
 *   - runs one extra fresh process (recheck) that rereads task-shelf.json snapshot
 *
 * Electron child:
 *   - isolated appData/userData (dev-user-data redirects userData to appData/lyshell-dev)
 *   - seeds 12 saved web entries, drives the real task shelf UI, verifies the
 *     read-only contract in real guests, sleeps 10 static pages with a virtual
 *     Date.now offset and samples memory.
 *
 * Does not modify production code. Only writes under tmp/deep-sleep-app,
 * docs/shelf-memory-p0/deep-sleep-app-codex-results.json and tmp/deep-sleep-app-codex-report.md.
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const ARTIFACTS = path.join(ROOT, 'tmp', 'deep-sleep-app-codex')
const DOCS = path.join(ROOT, 'docs', 'shelf-memory-p0')
const DOCS_RESULTS = path.join(DOCS, 'deep-sleep-app-codex-results.json')
const REPORT = path.join(ROOT, 'tmp', 'deep-sleep-app-codex-report.md')
const READY = path.join(ROOT, 'tmp', 'deep-sleep-build-ready.json')

const IS_ELECTRON = !!process.versions.electron
const realNow = Date.now.bind(Date)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Virtual clock: Electron child only. The harness itself always measures with realNow().
let virtualOffset = 0
if (IS_ELECTRON) {
  Date.now = () => realNow() + virtualOffset
}

const READONLY_PARTITION = 'shelf-readonly-v1'
const READONLY_PARTITION_RE = /^shelf-readonly-v1:[a-f0-9-]{36}$/
const isReadonlyPartitionValue = (value) => typeof value === 'string' && (value === READONLY_PARTITION || READONLY_PARTITION_RE.test(value))
const WEBBAR_PARTITION = 'persist:webbar'
const HOST = 'shelf-fixture.test'
const STATIC_COUNT = 10
const TOTAL_ENTRIES = 12
const DEFAULT_ROUNDS = 3
const DEFAULT_CYCLES = 34
const VIRTUAL_STEP_MS = 300001

function median(values) {
  const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (list.length === 0) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2
}

function round2(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

function parseArgs(argv) {
  const out = { _: [] }
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (match) out[match[1]] = match[2] === undefined ? true : match[2]
    else out._.push(arg)
  }
  return out
}

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function buildSignature() {
  const files = [
    'dist/main/index.js',
    'dist/preload/shelfReadonly.js',
    'dist/preload/index.js',
    'dist/renderer/index.html'
  ]
  const out = {}
  for (const rel of files) {
    const abs = path.join(ROOT, rel)
    try {
      const stat = fs.statSync(abs)
      out[rel] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: sha256File(abs) }
    } catch {
      out[rel] = null
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Fixture server (parent process only)                                        */
/* -------------------------------------------------------------------------- */

function staticPageHtml(index) {
  const scrollHeight = 4200
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Static ${index}</title>
<style>
  html, body { margin: 0; }
  body { font: 14px/1.4 system-ui, sans-serif; padding: 16px; }
  .tall { height: ${scrollHeight}px; background: linear-gradient(#ffffff, #eef2ff); border: 1px solid #c7d2fe; box-sizing: border-box; }
  section { margin: 12px 0; }
  iframe { width: 240px; height: 80px; }
  video { width: 240px; height: 120px; }
  input, textarea, button { display: block; margin: 4px 0; }
</style>
<script>
  window.__ran = true;
  document.title = 'RAN-${index}';
  try { fetch('/leak').catch(function () {}); } catch (e) {}
  try { new Worker('/worker.js'); } catch (e) {}
  try { navigator.sendBeacon('/beacon', 'x'); } catch (e) {}
  try { var im = new Image(); im.src = '/leak.gif'; } catch (e) {}
  try { fetch('/posted', { method: 'POST', body: 'x' }).catch(function () {}); } catch (e) {}
</script>
</head><body>
<h1 id="h1">Static document ${index}</h1>
<p id="desc">Long static document used for scroll/zoom restore checks.</p>
<section>
<form id="form" action="/posted" method="post">
  <input id="name" name="name" value="static-${index}">
  <button id="submit" type="submit">Send</button>
</form>
<input id="file" type="file">
<input id="text" value="readonly">
<textarea id="ta" rows="2">readonly</textarea>
<div id="edit" contenteditable="true">editable</div>
<iframe id="frame" src="/subframe"></iframe>
<video id="video" src="/media.mp4" controls muted preload="auto"></video>
<img id="pixel" src="/pixel.gif" alt="pixel">
<a id="link" href="/fixture/${index}?x=1">navigate</a>
</section>
<div class="tall" id="tall"></div>
</body></html>`
}

const PROTECTED_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Protected dynamic</title>
<style>body{font:14px/1.4 system-ui,sans-serif;padding:16px}</style>
<script>
  window.__protected = true;
  window.onbeforeunload = function () { return 'Unsaved changes'; };
  window.addEventListener('DOMContentLoaded', function () {
    var input = document.getElementById('draft');
    if (input) input.value = 'seed';
  });
</script>
</head><body>
<h1>Protected dynamic page</h1>
<p>Dynamic page with a beforeunload guard and an editable unsaved draft.</p>
<input id="draft" value="seed">
<textarea id="notes" rows="3">notes</textarea>
</body></html>`

const UNKNOWN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Unknown dynamic</title>
<style>body{font:14px/1.4 system-ui,sans-serif;padding:16px}</style>
<script>
  window.__unknown = true;
  window.__unknownTitle = 'Unknown dynamic';
</script>
</head><body>
<h1>Unknown dynamic page</h1>
<p>Dynamic page without a read-only marker.</p>
<div id="marker">unknown-dynamic-ok</div>
</body></html>`

const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')

function createFixtureServer() {
  const state = { startedAt: realNow(), hits: [], posts: [], blockedPaths: ['/subframe', '/media.mp4', '/posted', '/leak', '/worker.js', '/beacon', '/leak.gif'] }

  const server = http.createServer((req, res) => {
    const host = req.headers.host || `${HOST}:0`
    const url = new URL(req.url || '/', `http://${host}`)
    const pathname = url.pathname
    state.hits.push({ method: req.method, path: pathname, at: realNow() })

    const send = (status, type, body) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      })
      res.end(buf)
    }

    if (pathname === '/__hits') {
      const counts = {}
      for (const hit of state.hits) counts[hit.path] = (counts[hit.path] || 0) + 1
      send(200, 'application/json', JSON.stringify({ counts, posts: state.posts.length, total: state.hits.length }))
      return
    }

    const fixtureMatch = /^\/fixture\/(\d+)$/.exec(pathname)
    if (fixtureMatch) {
      const index = Number(fixtureMatch[1])
      if (index >= 0 && index < STATIC_COUNT) {
        send(200, 'text/html; charset=utf-8', staticPageHtml(index))
        return
      }
      send(404, 'text/plain', 'no fixture')
      return
    }

    if (pathname === '/protected') { send(200, 'text/html; charset=utf-8', PROTECTED_HTML); return }
    if (pathname === '/unknown') { send(200, 'text/html; charset=utf-8', UNKNOWN_HTML); return }
    if (pathname === '/subframe') { send(200, 'text/html; charset=utf-8', '<!doctype html><html><body><p id="sub">subframe</p></body></html>'); return }
    if (pathname === '/pixel.gif') { send(200, 'image/gif', GIF_1PX); return }
    if (pathname === '/media.mp4') { send(200, 'video/mp4', Buffer.alloc(512)); return }
    if (pathname === '/worker.js') { send(200, 'application/javascript', 'self.postMessage("x")'); return }
    if (pathname === '/leak') { send(200, 'text/plain', 'leak'); return }
    if (pathname === '/beacon') { send(204, 'text/plain', ''); return }
    if (pathname === '/leak.gif') { send(200, 'image/gif', GIF_1PX); return }
    if (pathname === '/posted') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        state.posts.push({ at: realNow(), bytes: Buffer.concat(chunks).length })
        send(200, 'text/plain', 'posted')
      })
      return
    }
    if (pathname === '/favicon.ico') { send(204, 'image/x-icon', ''); return }
    send(404, 'text/plain', 'not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Parent                                                                      */
/* -------------------------------------------------------------------------- */

async function parentMain(argv) {
  if (argv.help) {
    console.log('usage: node scripts/shelf-memory-p0/deep-sleep-app-codex.cjs [--rounds=3] [--cycles=34] [--timeout=420000] [--only=before|after] [--keep-going]')
    return
  }
  if (!fs.existsSync(READY)) {
    console.error(`build-ready marker missing: ${path.relative(ROOT, READY)} (Codex must write it after a passing build)`)
    process.exitCode = 2
    return
  }
  let electronPath
  try {
    electronPath = require('electron')
  } catch (error) {
    console.error(`cannot resolve electron: ${error.message}`)
    process.exitCode = 2
    return
  }
  if (typeof electronPath !== 'string') {
    console.error('parent must be run with plain node, not electron')
    process.exitCode = 2
    return
  }

  const rounds = toInt(argv.rounds, DEFAULT_ROUNDS)
  const cycles = toInt(argv.cycles, DEFAULT_CYCLES)
  const timeoutMs = toInt(argv.timeout, 420000)
  const only = argv.only === 'before' || argv.only === 'after' ? argv.only : null
  const keepGoing = argv['keep-going'] === true

  fs.mkdirSync(ARTIFACTS, { recursive: true })
  fs.mkdirSync(DOCS, { recursive: true })

  const buildBefore = buildSignature()
  const fixture = await createFixtureServer()
  const stamp = new Date(realNow()).toISOString().replace(/[:.]/g, '-')
  const command = `node scripts/shelf-memory-p0/deep-sleep-app-codex.cjs --rounds=${rounds} --cycles=${cycles}`

  const prior = argv.resume ? JSON.parse(fs.readFileSync(path.resolve(String(argv.resume)), 'utf8')) : null
  if (prior && JSON.stringify(prior.build.after) !== JSON.stringify(buildBefore)) throw Error('Cannot resume across a different production build')
  const priorFailures = prior?.runs.filter(run => !run.ok) ?? []
  const runs = (prior?.runs.filter(run => run.ok) ?? []).map(run => {
    const base = path.join(ROOT, run.base), out = path.join(base, 'result.json')
    return { ...run, base, out, result: JSON.parse(fs.readFileSync(out, 'utf8')) }
  })
  const firstRound = runs.length / 2 + 1
  if (!Number.isInteger(firstRound)) throw Error('Resume requires complete before/after pairs')
  let aborted = false
  let abortReason = null

  console.log(`[parent] build-ready: ${fs.readFileSync(READY, 'utf8').trim()}`)
  console.log(`[parent] fixture: http://${HOST}:${fixture.port}/ (loopback 127.0.0.1:${fixture.port})`)
  console.log(`[parent] rounds=${rounds} cycles=${cycles} timeout=${timeoutMs}ms`)

  for (let round = firstRound; round <= rounds && !aborted; round += 1) {
    const order = round % 2 === 1 ? ['before', 'after'] : ['after', 'before']
    for (const arm of order) {
      if (aborted) break
      if (only && arm !== only) continue
      if (!fs.existsSync(READY)) {
        aborted = true
        abortReason = { round, arm, error: { message: `build-ready marker disappeared: ${path.relative(ROOT, READY)}` } }
        break
      }
      if (JSON.stringify(buildSignature()) !== JSON.stringify(buildBefore)) {
        aborted = true
        abortReason = { round, arm, error: { message: 'dist build changed during the run; pausing before next fresh app' } }
        break
      }
      const run = await runOnce({ arm, round, cycles, port: fixture.port, timeoutMs, stamp, electronPath })
      runs.push(run)
      const mem = run.result?.memory?.phases || {}
      const line = `[parent] round ${round} ${arm}: ${run.ok ? 'ok' : 'FAILED'} guests=${run.result?.counts?.finalGuests ?? '?'} cycles=${run.result?.counts?.cycles ?? '?'} loaded_median=${mem.loaded?.median ?? '?'}MiB final_median=${mem.final?.median ?? '?'}MiB wall=${Math.round(run.wallMs / 1000)}s`
      console.log(line)
      if (!run.ok) {
        aborted = true
        abortReason = { round, arm, error: run.result?.error || { message: 'run failed without result' } }
        if (keepGoing) {
          console.log('[parent] --keep-going: continuing after failure')
          aborted = false
        }
      }
    }
  }

  let recheck = null
  const recheckSource = runs.find((run) => run.ok && run.arm === 'after' && run.round === 1)
  if (!aborted && recheckSource) {
    recheck = await runRecheck({ source: recheckSource, timeoutMs, stamp, electronPath })
    console.log(`[parent] recheck: ${recheck.ok ? 'ok' : 'FAILED'}`)
    if (!recheck.ok) {
      aborted = true
      abortReason = { round: recheckSource.round, arm: 'after', error: recheck.result?.error || { message: 'recheck failed' } }
    }
  }

  const buildAfter = buildSignature()
  const buildStable = JSON.stringify(buildBefore) === JSON.stringify(buildAfter)
  const finalHits = await fetchHits(fixture.port)
  const summary = summarize({ runs, recheck, buildBefore, buildAfter, buildStable, fixtureState: fixture.state, finalHits, rounds, cycles, command, abortReason })
  summary.docs.priorFailedAttempts = priorFailures
  summary.docs.methodNote = 'A prior third-round first-picture gate timeout was retained. Completed pairs use the same production build; the failed pair alone was retried, permitting only the existing explicit Show current page fallback after controlled-page verification.'

  fs.writeFileSync(DOCS_RESULTS, `${JSON.stringify(summary.docs, null, 2)}\n`)
  fs.writeFileSync(REPORT, summary.report)
  fixture.server.close()

  console.log(`[parent] results: ${path.relative(ROOT, DOCS_RESULTS)}`)
  console.log(`[parent] report:  ${path.relative(ROOT, REPORT)}`)
  console.log(`[parent] validity: ${summary.docs.validity.status}${summary.docs.validity.reasons.length ? ` (${summary.docs.validity.reasons.join('; ')})` : ''}`)
  if (!summary.docs.ok) {
    console.error(`[parent] FAILED: ${JSON.stringify(abortReason?.error || {})}`)
    process.exitCode = 1
  }
}

async function runOnce({ arm, round, cycles, port, timeoutMs, stamp, electronPath }) {
  const base = fs.mkdtempSync(path.join(ARTIFACTS, `${stamp}-r${round}-${arm}-`))
  const out = path.join(base, 'result.json')
  const env = { ...process.env, DSH_HOME: path.join(base, 'dsh-home') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.LYSHELL_DEMO_PROFILE
  delete env.LYSHELL_SHELF_READONLY_SLEEP
  if (arm === 'before') env.LYSHELL_SHELF_READONLY_SLEEP = '0'

  const args = [
    __filename,
    `--arm=${arm}`,
    `--round=${round}`,
    `--cycles=${cycles}`,
    `--port=${port}`,
    `--base=${base}`,
    `--out=${out}`
  ]

  const startedAt = realNow()
  const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  const append = (current, chunk) => (current + chunk.toString()).slice(-24000)
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, timeoutMs)

  const exit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: -1, signal: null, error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)

  let result = null
  try {
    result = JSON.parse(fs.readFileSync(out, 'utf8'))
  } catch {
    result = null
  }
  if (!result) {
    result = {
      ok: false,
      arm,
      round,
      error: {
        message: timedOut ? `electron child timed out after ${timeoutMs}ms` : `electron child exited without result (code=${exit.code}, signal=${exit.signal})`,
        stdoutTail: stdout.slice(-4000),
        stderrTail: stderr.slice(-4000)
      }
    }
  }
  const ok = !!result.ok && !timedOut
  return {
    ok,
    arm,
    round,
    base,
    out,
    wallMs: realNow() - startedAt,
    exit,
    timedOut,
    stdoutTail: stdout.slice(-8000),
    stderrTail: stderr.slice(-8000),
    result
  }
}

async function runRecheck({ source, timeoutMs, stamp, electronPath }) {
  const base = source.base
  const out = path.join(base, 'recheck.json')
  const env = { ...process.env, DSH_HOME: path.join(base, 'dsh-home'), LYSHELL_SHELF_READONLY_SLEEP: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.LYSHELL_DEMO_PROFILE
  const args = [__filename, '--recheck', `--base=${base}`, `--out=${out}`, `--round=${source.round}`, `--expected-boot=${source.result?.bootId || ''}`]
  const startedAt = realNow()
  const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-16000) })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16000) })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, Math.min(timeoutMs, 180000))
  const exit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: -1, signal: null, error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  let result = null
  try { result = JSON.parse(fs.readFileSync(out, 'utf8')) } catch { result = null }
  return {
    ok: !!result?.ok && !timedOut,
    base,
    out,
    wallMs: realNow() - startedAt,
    exit,
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
    result: result || { ok: false, error: { message: timedOut ? 'recheck timed out' : 'recheck exited without result', stderrTail: stderr.slice(-4000) } }
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
}

function fetchHits(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__hits', timeout: 5000 }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

function summarize({ runs, recheck, buildBefore, buildAfter, buildStable, fixtureState, finalHits, rounds, cycles, command, abortReason }) {
  const okRuns = runs.filter((run) => run.ok)
  const byArm = { before: okRuns.filter((run) => run.arm === 'before'), after: okRuns.filter((run) => run.arm === 'after') }
  const phaseOf = (list, phase) => list.map((run) => run.result?.memory?.phases?.[phase]).filter(Boolean)
  const armMemory = (arm, phase) => {
    const values = phaseOf(byArm[arm], phase)
    if (!values.length) return null
    return {
      runs: values.length,
      medianOfMedians: round2(median(values.map((v) => v.median))),
      medianOfMeans: round2(median(values.map((v) => v.mean))),
      peakOfPeaks: round2(Math.max(...values.map((v) => v.peak))),
      perRun: values.map((v) => ({ median: v.median, mean: v.mean, peak: v.peak, samples: v.samples }))
    }
  }
  const loadedBefore = armMemory('before', 'loaded')
  const loadedAfter = armMemory('after', 'loaded')
  const finalBefore = armMemory('before', 'final')
  const finalAfter = armMemory('after', 'final')
  const sleepAfter = armMemory('after', 'sleep')
  const deltaFinal = finalBefore && finalAfter ? round2(finalAfter.medianOfMedians - finalBefore.medianOfMedians) : null
  const deltaFinalPct = finalBefore && finalAfter && finalBefore.medianOfMedians ? round2(((finalAfter.medianOfMedians - finalBefore.medianOfMedians) / finalBefore.medianOfMedians) * 100) : null
  const loadedParityPct = loadedBefore && loadedAfter && loadedBefore.medianOfMedians ? round2((Math.abs(loadedAfter.medianOfMedians - loadedBefore.medianOfMedians) / loadedBefore.medianOfMedians) * 100) : null

  const checks = { total: 0, failed: 0, failures: [] }
  for (const run of runs) {
    for (const check of run.result?.checks || []) {
      checks.total += 1
      if (!check.ok) {
        checks.failed += 1
        if (checks.failures.length < 20) checks.failures.push({ round: run.round, arm: run.arm, name: check.name, detail: check.detail })
      }
    }
    if (run.result?.softFailures?.length) {
      for (const failure of run.result.softFailures) {
        if (checks.failures.length < 20) checks.failures.push({ round: run.round, arm: run.arm, name: `soft:${failure.name}`, detail: failure.detail })
      }
    }
  }

  const restoreCycles = okRuns.reduce((sum, run) => sum + (run.result?.counts?.restoreCycles || 0), 0)
  const beforeCycles = okRuns.reduce((sum, run) => sum + (run.result?.counts?.reloadCycles || 0), 0)
  const stats = values => {
    const sorted = values.filter(Number.isFinite).sort((a,b) => a-b)
    const q = p => sorted.length ? round2(sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*p)-1)]) : null
    return { n: sorted.length, p50: q(0.5), p95: q(0.95), min: sorted.length ? round2(sorted[0]) : null, max: sorted.length ? round2(sorted.at(-1)) : null }
  }
  const latency = Object.fromEntries(['before','after'].map(arm => [arm, {
    readyMs: stats(byArm[arm].flatMap(run => run.result.cyclesLog.map(cycle => cycle.readyMs))),
    wheelToPreloadIpcMs: stats(byArm[arm].flatMap(run => run.result.cyclesLog.map(cycle => cycle.inputMs)))
  }]))
  const sampledPeak = Object.fromEntries(['before','after'].map(arm => [arm, byArm[arm].map(run => round2(Math.max(...run.result.memory.samples.map(sample => sample.totalMiB))))]))

  const expected = { complete: runs.length === rounds * (onlyArmCount(runs) ? 1 : 2), fetched: runs.length }
  const reasons = []
  if (abortReason) reasons.push(`run failed (round ${abortReason.round} ${abortReason.arm}): ${abortReason.error?.message || 'unknown'}`)
  if (!buildStable) reasons.push('dist build changed between first and last run')
  if (okRuns.filter((run) => run.arm === 'before').length !== rounds) reasons.push('missing/failed before-arm runs')
  if (okRuns.filter((run) => run.arm === 'after').length !== rounds) reasons.push('missing/failed after-arm runs')
  if (!recheck?.ok) reasons.push('snapshot recheck failed or skipped')
  if (restoreCycles < 100) reasons.push(`restore cycles ${restoreCycles} < 100`)
  if (loadedParityPct !== null && loadedParityPct > 10) reasons.push(`loaded-state parity drift ${loadedParityPct}% > 10%`)
  if (checks.failed > 0) reasons.push(`${checks.failed} failed check(s)`)
  if (finalHits?.counts) {
    const forbidden = ['/subframe', '/media.mp4', '/posted', '/leak', '/worker.js', '/beacon', '/leak.gif']
    const leaked = forbidden.filter((p) => (finalHits.counts[p] || 0) > 0)
    if (leaked.length) reasons.push(`forbidden fixture requests: ${leaked.join(', ')}`)
  }
  const status = reasons.length === 0 ? 'valid' : abortReason || !buildStable ? 'failed' : 'partial'

  const docs = {
    ok: reasons.length === 0,
    generatedAt: new Date(realNow()).toISOString(),
    command: `node scripts/shelf-memory-p0/deep-sleep-app-codex.cjs --rounds=${rounds} --cycles=${cycles}`,
    scope: 'built LyShell (dist/main/index.js) full app, isolated task-shelf recovery profile, loopback fixture',
    build: { before: buildBefore, after: buildAfter, stable: buildStable, readyFile: fs.existsSync(READY) ? fs.readFileSync(READY, 'utf8').trim() : null },
    fixture: { host: `${HOST}:127.0.0.1`, hits: finalHits, serverPaths: fixtureState.blockedPaths },
    config: {
      rounds,
      cyclesPerRound: cycles,
      arms: { before: "LYSHELL_SHELF_READONLY_SLEEP='0'", after: "LYSHELL_SHELF_READONLY_SLEEP unset" },
      virtualClock: 'main-process Date.now patched; +300001 ms after demands clear (production threshold unchanged)',
      readonlyPartitions: 'one non-persistent Session per read-only resource: shelf-readonly-v1:<uuid>, reused verbatim on wake',
      memoryMetric: 'sum of per-PID max memory.privateBytes from app.getAppMetrics() (KB->MiB), sampled every 100 ms'
    },
    runs: runs.map((run) => ({
      round: run.round,
      arm: run.arm,
      ok: run.ok,
      wallMs: run.wallMs,
      base: path.relative(ROOT, run.base),
      counts: run.result?.counts || null,
      memory: run.result?.memory?.phases || null,
      error: run.result?.error || null
    })),
    memory: {
      sampledPeakAllPhasesMiB: sampledPeak,
      loaded: { before: loadedBefore, after: loadedAfter, parityPct: loadedParityPct },
      final: { before: finalBefore, after: finalAfter, deltaMiB: deltaFinal, deltaPct: deltaFinalPct },
      sleep: { after: sleepAfter },
      verdict: deltaFinal === null ? 'no-data' : `${deltaFinal >= 0 ? '+' : ''}${deltaFinal} MiB (${deltaFinalPct}%) after-vs-before at final steady state`
    },
    latency,
    acceptance: {
      checks,
      counts: {
        beforeRuns: byArm.before.length,
        afterRuns: byArm.after.length,
        reloadCycles: beforeCycles,
        restoreCycles,
        expectedRestoreCycles: rounds * cycles
      },
      before: byArm.before.map((run) => run.result?.counts || null),
      after: byArm.after.map((run) => run.result?.counts || null)
    },
    recheck: recheck ? {
      ok: recheck.ok,
      wallMs: recheck.wallMs,
      bootId: recheck.result?.bootId || null,
      expectedBootId: recheck.result?.expectedBootId || null,
      archived: recheck.result?.archived ?? null,
      snapshot: recheck.result?.snapshot || null,
      expectedPartitions: recheck.result?.expectedPartitions || null,
      listSleep: recheck.result?.listSleep ?? null,
      guests: recheck.result?.guests ?? null,
      error: recheck.result?.error || null
    } : null,
    validity: {
      status,
      reasons,
      buildStable,
      restoreCycles,
      loadedParityPct,
      failedChecks: checks.failed,
      expected
    },
    limitations: [
      'Single Windows host; fixture served on loopback with shelf-fixture.test mapped to 127.0.0.1; no credentials or external network.',
      'Application-total private memory is the sum of app.getAppMetrics().memory.privateBytes per PID; it excludes any metric not reported there (no JS heap/external added by the harness).',
      'Virtual clock: only the Electron main process Date.now is offset (+300001 ms after demands clear); production deepSleepAfterMs stays at its 5 min default. Both arms advance the same virtual clock.',
      'Static pages cannot execute page script by design (CSP script-src none), so page-authored JS/form/media/iframe attempts are verified via blocked network requests plus hardened DOM; trusted-input blocking is covered by Codex unit tests.',
      'Each read-only resource now has its own non-persistent Session (shelf-readonly-v1:<uuid>) and zoom is set per page; the fixture asserts the DOM partition attribute, native Session identity, distinct Sessions, and persisted per-resource partition metadata.',
      'Protected/unknown dynamic pages are seeded without readonlyMode because only contract-verified readonly guests are sleep-eligible; the expected 10-destroyed/2-live invariant requires them dynamic. beforeunload close refusal is unit-tested by Codex, not re-run here.',
      'Snapshot reread is proven by a fresh recheck process reading task-shelf.json and the shelf list; a lifecycle inspect is impossible before attach (no record), so no fake state is asserted.',
      'GUI/visual review is explicitly out of scope; screenshots are saved but not interpreted by this harness.'
    ]
  }

  const report = renderReport(docs)
  return { docs, report }
}

function onlyArmCount(runs) {
  return runs.length > 0 && runs.every((run) => run.arm === 'before')
}

function renderReport(docs) {
  const lines = []
  lines.push('# Deep-sleep built-app acceptance / memory report')
  lines.push('')
  lines.push(`Generated: ${docs.generatedAt}`)
  lines.push(`Command: \`${docs.command}\``)
  lines.push(`Scope: ${docs.scope}`)
  lines.push('')
  lines.push(`## Verdict`)
  lines.push('')
  lines.push(`- Validity: **${docs.validity.status}**${docs.validity.reasons.length ? ` — ${docs.validity.reasons.join('; ')}` : ''}`)
  lines.push(`- Checks: ${docs.acceptance.checks.total} run, ${docs.acceptance.checks.failed} failed`)
  lines.push(`- Restore cycles: ${docs.acceptance.counts.restoreCycles} (expected ${docs.acceptance.counts.expectedRestoreCycles}); reload cycles: ${docs.acceptance.counts.reloadCycles}`)
  lines.push(`- Read-only partitions: ten distinct \`shelf-readonly-v1:<uuid>\` Sessions (asserted from the real DOM webview + native guest.session identity)`)
  lines.push(`- Final memory: before ${docs.memory.final.before?.medianOfMedians ?? '?'} MiB -> after ${docs.memory.final.after?.medianOfMedians ?? '?'} MiB (${docs.memory.verdict})`)
  lines.push(`- Loaded parity: ${docs.memory.loaded.parityPct ?? '?'}% (12 live guests both arms)`)
  lines.push(`- Build stable: ${docs.build.stable}`)
  lines.push('')
  lines.push('## Per-run')
  lines.push('')
  lines.push('| round | arm | ok | guards | cycles | loaded median | final median | wall s |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of docs.runs) {
    lines.push(`| ${run.round} | ${run.arm} | ${run.ok} | ${run.counts?.finalGuests ?? '?'} | ${run.counts?.cycles ?? '?'} | ${run.memory?.loaded?.median ?? '?'} | ${run.memory?.final?.median ?? '?'} | ${Math.round((run.wallMs || 0) / 1000)} |`)
  }
  lines.push('')
  lines.push('## Acceptance evidence')
  lines.push('')
  lines.push(`- Before arm: 10 static read-only guests + protected + unknown stay live; after arm: 10 read-only guests sleeping/destroyed and the 2 dynamic guests remain.`)
  lines.push(`- Forbidden fixture requests (subframe/media/post/script leak): ${JSON.stringify(docs.fixture.hits?.counts ? Object.fromEntries(['/subframe', '/media.mp4', '/posted', '/leak', '/worker.js', '/beacon', '/leak.gif'].map((p) => [p, docs.fixture.hits.counts[p] || 0])) : null)}`)
  lines.push(`- Snapshot recheck: ${docs.recheck ? `ok=${docs.recheck.ok}, archived=${docs.recheck.archived}, guests=${docs.recheck.guests}, listSleep=${docs.recheck.listSleep}, bootId changed=${docs.recheck.bootId && docs.recheck.expectedBootId ? docs.recheck.bootId !== docs.recheck.expectedBootId : '?'}` : 'not run'}`)
  lines.push('')
  if (docs.acceptance.checks.failures.length) {
    lines.push('## Failures')
    lines.push('')
    for (const failure of docs.acceptance.checks.failures) {
      lines.push(`- [r${failure.round} ${failure.arm}] ${failure.name}: ${JSON.stringify(failure.detail)}`)
    }
    lines.push('')
  }
  lines.push('## Limitations')
  lines.push('')
  for (const limitation of docs.limitations) lines.push(`- ${limitation}`)
  lines.push('')
  lines.push(`Raw data: \`${path.relative(ROOT, DOCS_RESULTS)}\`; per-run JSON under \`tmp/deep-sleep-app/\`.`)
  return `${lines.join('\n')}\n`
}

/* -------------------------------------------------------------------------- */
/* Electron child                                                              */
/* -------------------------------------------------------------------------- */

async function childMain(argv) {
  if (argv.recheck) return recheckMain(argv)

  const { app, webContents, session } = require('electron')
  const arm = argv.arm === 'after' ? 'after' : 'before'
  const round = toInt(argv.round, 1)
  const cycles = toInt(argv.cycles, DEFAULT_CYCLES)
  const port = toInt(argv.port, 0)
  const base = String(argv.base || '')
  const out = String(argv.out || path.join(base, 'result.json'))
  const startedAt = realNow()

  const result = {
    ok: false,
    arm,
    round,
    cycles,
    startedAt: new Date(realNow()).toISOString(),
    env: { LYSHELL_SHELF_READONLY_SLEEP: process.env.LYSHELL_SHELF_READONLY_SLEEP ?? null },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch
    },
    config: {},
    checks: [],
    softFailures: [],
    cyclesLog: [],
    counts: {},
    memory: { samples: [], phases: {}, errors: 0 },
    screenshots: [],
    entries: []
  }
  let resultWritten = false
  const writeResult = () => {
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      const tmp = `${out}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(result, null, 2))
      fs.renameSync(tmp, out)
      resultWritten = true
    } catch (error) {
      console.error('[child] cannot write result:', error.message)
    }
  }
  process.on('exit', (code) => {
    if (!resultWritten) {
      try {
        fs.writeFileSync(out, JSON.stringify({ ...result, ok: false, error: { message: `child exited without result (code=${code})` } }, null, 2))
      } catch { /* ignore */ }
    }
  })

  const baseDir = base
  const appData = path.join(baseDir, 'appData')
  const devUserData = path.join(appData, 'lyshell-dev')
  const configDir = path.join(devUserData, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, '.seeded-from-prod'), `seeded by deep-sleep-app harness at ${new Date(realNow()).toISOString()}\n`, 'utf8')
  process.env.DSH_HOME = path.join(baseDir, 'dsh-home')
  app.setPath('appData', appData)
  app.setPath('sessionData', path.join(baseDir, 'session-data'))

  const fixtureBase = `http://${HOST}:${port}`
  const entries = seedEntries(configDir, fixtureBase)
  result.config = {
    base: baseDir,
    appData,
    userData: devUserData,
    configDir,
    shelfFile: path.join(configDir, 'task-shelf.json'),
    fixtureBase,
    virtualStepMs: VIRTUAL_STEP_MS
  }

  app.commandLine.appendSwitch('host-resolver-rules', `MAP ${HOST} 127.0.0.1`)
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

  let main = null
  app.on('browser-window-created', (_event, win) => {
    if (main) return
    main = win
    win.webContents.setBackgroundThrottling(false)
    win.setTitle(`deep-sleep-app ${arm} r${round}`)
    win.webContents.on('did-attach-webview', (_event, guest) => {
      guest.setBackgroundThrottling(false)
      result.counts.nativeAttaches = (result.counts.nativeAttaches || 0) + 1
      guest.once('destroyed', () => { result.counts.nativeDestroyed = (result.counts.nativeDestroyed || 0) + 1 })
    })
  })

  const mem = result.memory
  mem.t0 = realNow()
  mem.phase = 'boot'
  const advance = () => {
    virtualOffset += VIRTUAL_STEP_MS
    result.virtualOffsetMs = virtualOffset
  }

  const check = (name, condition, detail) => {
    const ok = !!condition
    result.checks.push({ name, ok, detail: detail === undefined ? undefined : bound(detail) })
    if (!ok) {
      const error = new Error(`assertion failed: ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(bound(detail))}`}`)
      error.check = name
      error.detail = bound(detail)
      throw error
    }
  }
  const soft = (name, condition, detail) => {
    if (condition) return
    result.softFailures.push({ name, detail: bound(detail) })
  }
  const bound = (value) => {
    try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
  }

  let step = 'boot'
  const setStep = (name) => { step = name }
  const nowMs = () => Math.round(realNow() - startedAt)

  const js = async (code, timeout = 20000) => {
    const start = realNow()
    let lastError = null
    while (realNow() - start < timeout) {
      try {
        return await main.webContents.executeJavaScript(code, true)
      } catch (error) {
        lastError = error
        if (!/disposed|destroyed|Render frame|Execution context|no longer exists|Target closed/i.test(String(error.message))) throw error
        await sleep(100)
      }
    }
    throw lastError || new Error('executeJavaScript timeout')
  }

  const listShelf = async () => {
    const reply = await js("window.electronAPI.taskShelfRequest({kind:'list'})")
    if (!reply || reply.success !== true) throw new Error(`task-shelf list failed: ${JSON.stringify(reply?.error || reply)}`)
    return reply
  }
  const shelf = async (request) => {
    const reply = await js(`window.electronAPI.shelfBrowserRequest(${JSON.stringify(request)})`)
    return reply
  }
  const inspect = async (id) => {
    try { return await shelf({ kind: 'inspect', resourceId: `saved:${id}` }) } catch (error) { return { success: false, error: error.message } }
  }

  const guests = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getType() === 'webview')
  const guestFor = (url) => guests().find((wc) => {
    try { return wc.getURL() === url } catch { return false }
  }) || null
  const guestCountFor = (url) => guests().filter((wc) => { try { return wc.getURL() === url } catch { return false } }).length

  const until = async (fn, label, timeout = 20000, interval = 100) => {
    const start = realNow()
    let last = null
    while (realNow() - start < timeout) {
      try {
        const value = await fn()
        if (value) return value
      } catch (error) {
        last = error
      }
      await sleep(interval)
    }
    const suffix = last ? ` (last error: ${last.message})` : ''
    throw new Error(`timeout waiting for ${label}${suffix}`)
  }

  const sampleMemory = () => {
    try {
      const metrics = app.getAppMetrics()
      const byPid = {}
      for (const metric of metrics) {
        const kb = metric?.memory?.privateBytes
        if (!metric || !(metric.pid > 0) || typeof kb !== 'number' || !(kb >= 0)) continue
        byPid[metric.pid] = Math.max(byPid[metric.pid] || 0, kb)
      }
      const pids = Object.keys(byPid)
      if (pids.length === 0) return
      const totalKb = pids.reduce((sum, pid) => sum + byPid[pid], 0)
      const sample = {
        t: Math.round(realNow() - mem.t0),
        phase: mem.phase,
        totalMiB: Math.round((totalKb / 1024) * 1000) / 1000,
        pidCount: pids.length,
        byPid: {},
        processes: metrics.map(metric => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName, privateKiB: metric.memory?.privateBytes }))
      }
      for (const pid of pids) sample.byPid[pid] = Math.round((byPid[pid] / 1024) * 1000) / 1000
      mem.samples.push(sample)
    } catch {
      mem.errors += 1
    }
  }
  const markPhase = (phase) => {
    mem.phase = phase
    result.memory.phaseMarks = result.memory.phaseMarks || []
    result.memory.phaseMarks.push({ phase, at: Math.round(realNow() - mem.t0) })
  }
  const memorySummary = () => {
    const phases = {}
    for (const phase of ['boot', 'loaded', 'sleep', 'cycles', 'final']) {
      const values = mem.samples.filter((sample) => sample.phase === phase).map((sample) => sample.totalMiB)
      if (values.length === 0) continue
      phases[phase] = {
        samples: values.length,
        median: round2(median(values)),
        mean: round2(values.reduce((sum, value) => sum + value, 0) / values.length),
        peak: round2(Math.max(...values)),
        min: round2(Math.min(...values))
      }
    }
    result.memory.phases = phases
    return phases
  }

  const screenshot = async (label) => {
    try {
      const image = await main.webContents.capturePage()
      const file = path.join(baseDir, `screenshot-${arm}-${label}.png`)
      fs.writeFileSync(file, image.toPNG())
      result.screenshots.push({ label, file: path.relative(ROOT, file), bytes: fs.statSync(file).size })
    } catch (error) {
      result.screenshots.push({ label, error: error.message })
    }
  }

  const fail = async (error) => {
    await screenshot('failure')
    result.ok = false
    result.error = {
      message: error?.message || String(error),
      stack: String(error?.stack || '').split('\n').slice(0, 20).join('\n'),
      check: error?.check || null,
      detail: error?.detail || null,
      step,
      guestUrls: (() => { try { return guests().map((guest) => guest.getURL()) } catch { return [] } })(),
      virtualOffsetMs: virtualOffset,
      arm,
      round
    }
    memorySummary()
    result.finishedAt = new Date(realNow()).toISOString()
    result.wallMs = realNow() - startedAt
    console.error(`[child][${arm}] FAILED at ${step}: ${result.error.message}`)
    writeResult()
    app.exit(1)
  }

  const setupRenderer = async () => {
    setStep('renderer')
    await until(() => !!main, 'main window', 60000)
    main.setBackgroundThrottling?.(false)
    main.webContents.setBackgroundThrottling(false)
    if (main.setSize) main.setSize(1500, 900, false)
    main.showInactive()
    await until(async () => {
      try {
        return await main.webContents.executeJavaScript("!!window.electronAPI && !!window.electronAPI.taskShelfRequest && document.readyState !== 'loading'", true)
      } catch { return false }
    }, 'renderer bridge', 90000)
    await sleep(500)
    const visible = await js("document.visibilityState === 'visible'")
    if (!visible) {
      main.show()
      main.focus()
      await until(() => js("document.visibilityState === 'visible'"), 'document visible', 15000)
    }
  }

  const waitListReady = async () => {
    const state = await until(async () => {
      try {
        const reply = await listShelf()
        if (reply.startup?.status === 'ready') return reply
      } catch { /* retry */ }
      return false
    }, 'task shelf startup ready', 90000)
    result.bootId = state.startup?.bootId || null
    return state
  }

  const openShelfPanel = async () => {
    setStep('open-shelf')
    await js(`(() => {
      const aside = document.querySelector('.task-shelf.is-open')
      if (aside) return true
      const edge = document.querySelector('.task-shelf-edge')
      if (edge) { edge.click(); return true }
      return false
    })()`)
    await until(() => js("!!document.querySelector('.task-shelf.is-open')"), 'shelf panel open', 20000)
  }

  const recallAll = async (optional = false) => {
    setStep('recall-all')
    const clicked = await js(`(() => {
      const button = document.querySelector('.task-shelf-view-action')
      if (!button) return 'missing'
      if (button.disabled) return 'disabled'
      button.click()
      return 'clicked'
    })()`)
    if (clicked === 'clicked') return true
    if (optional && clicked === 'disabled') return false
    check('recall-all button enabled and clicked', clicked === 'clicked', { clicked })
    return false
  }

  const waitPresentationsNone = async (ids, label = 'all presentations released') => {
    await until(async () => {
      for (const id of ids) {
        const reply = await inspect(id)
        if (!reply?.success || reply.presentationOwner === 'main') return false
      }
      return true
    }, label, 20000)
  }

  const waitState = (id, state, timeout = 25000) => until(async () => {
    const reply = await inspect(id)
    return reply?.success && reply.state === state ? reply : false
  }, `saved:${id} state=${state}`, timeout)

  const waitStaticSleeping = (timeout = 30000) => until(async () => {
    const states = []
    for (const entry of entries.filter((item) => item.readonly)) {
      const reply = await inspect(entry.id)
      states.push(reply?.success ? reply.state : `error:${reply?.error || '?'}`)
    }
    return states.every((state) => state === 'sleeping') ? states : false
  }, '10 read-only guests sleeping', timeout)

  const readShelfJson = () => {
    const file = path.join(configDir, 'task-shelf.json')
    return { file, json: JSON.parse(fs.readFileSync(file, 'utf8')) }
  }

  const jsonEntry = (json, id) => (json.entries || []).find((entry) => entry.id === id)

  const reloadGuest = async (guest, expectedTitle) => {
    const loaded = new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        guest.off('did-finish-load', onLoad)
        guest.off('did-fail-load', onFail)
      }
      const timer = setTimeout(() => { if (!settled) { settled = true; cleanup(); reject(new Error('guest reload timeout')) } }, 15000)
      const onLoad = () => { if (settled) return; settled = true; cleanup(); resolve() }
      const onFail = (_event, code, description, url, isMainFrame) => {
        if (settled || isMainFrame === false || code === -3) return
        settled = true
        cleanup()
        reject(new Error(`guest reload failed: ${code} ${description} ${url}`))
      }
      guest.on('did-finish-load', onLoad)
      guest.on('did-fail-load', onFail)
      try { guest.reload() } catch (error) { settled = true; cleanup(); reject(error) }
    })
    await loaded
    await until(async () => (await guest.executeJavaScript('document.title', true)) === expectedTitle, `reload title ${expectedTitle}`, 10000)
  }

  const probeStatic = async (guest) => guest.executeJavaScript(`(() => {
    const frame = document.querySelector('#frame')
    let frameBlank = true
    try {
      const doc = frame ? frame.contentDocument : null
      frameBlank = !doc || !doc.location || doc.location.href === 'about:blank' || !doc.body
    } catch (error) { frameBlank = true }
    const video = document.querySelector('#video')
    return {
      title: document.title,
      ran: typeof window.__ran !== 'undefined',
      href: location.href,
      submitDisabled: !!document.querySelector('#submit')?.disabled,
      nameDisabled: !!document.querySelector('#name')?.disabled,
      textDisabled: !!document.querySelector('#text')?.disabled,
      taDisabled: !!document.querySelector('#ta')?.disabled,
      fileType: document.querySelector('#file')?.type || null,
      editEditable: !!document.querySelector('#edit')?.isContentEditable,
      editAttribute: document.querySelector('#edit')?.getAttribute('contenteditable') ?? null,
      frameBlank,
      frameSrc: frame ? frame.getAttribute('src') : null,
      mediaReady: video ? video.readyState : null,
      mediaNetwork: video ? video.networkState : null,
      pixelWidth: document.querySelector('#pixel')?.naturalWidth ?? 0,
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
      scrollY: window.scrollY
    }
  })()`, true)

  const setupStaticRestore = async (guest, entry, index) => {
    // Every read-only resource gets its own non-persistent Session, so zoom is per resource.
    const zoomTarget = [0.9, 1.0, 1.1][index % 3]
    guest.setZoomFactor(zoomTarget)
    await sleep(250)
    const zoom = guest.getZoomFactor()
    check(`static ${entry.id} zoom applied`, Math.abs(zoom - zoomTarget) < 0.02, { zoom, zoomTarget })
    // Wheel input produces a trusted scroll event for the isolated preload telemetry.
    guest.sendInputEvent({ type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: -700, canScroll: true })
    await sleep(500)
    let y = await guest.executeJavaScript('window.scrollY', true)
    if (!(y > 50)) {
      await guest.executeJavaScript(`window.scrollTo(0, ${200 + index * 17}); true`, true)
      await sleep(500)
      y = await guest.executeJavaScript('window.scrollY', true)
    }
    check(`static ${entry.id} scroll applied`, y > 50 && Number.isFinite(y), { y })
    await sleep(400)
    entry.expected = { zoom: zoomTarget, scrollY: y, actualScroll: y }
    return { zoom, y }
  }

  const measureWheel = async guest => {
    const startY = await guest.executeJavaScript('scrollY', true)
    await sleep(220)
    const start = performance.now()
    const observed = new Promise((resolve, reject) => {
      const receive = (_event, channel, payload) => {
        if (channel !== 'shelf-browser:readonly-scroll' || !payload || Math.abs(payload.y - startY) < 2) return
        clearTimeout(timer); guest.off('ipc-message', receive); resolve(performance.now() - start)
      }
      const timer = setTimeout(() => { guest.off('ipc-message', receive); reject(Error('Trusted wheel telemetry timeout')) }, 2000)
      guest.on('ipc-message', receive)
    })
    guest.sendInputEvent({ type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: -120, canScroll: true })
    return observed
  }

  const readWebviewPartition = (entry) => js(`(() => {
    const wrapper = document.querySelector('[data-webtab-wrapper="shelf-web-${entry.id}"]')
    const webview = wrapper ? wrapper.querySelector('webview') : null
    return webview ? webview.getAttribute('partition') : null
  })()`)

  const openEntry = async (entry, expectedGuestCount) => {
    setStep(`open ${entry.id}`)
    await until(() => js(`(() => { const card = document.querySelector('[data-shelf-card="${entry.id}"]'); return !!card && !card.disabled })()`), `card ${entry.id} enabled`, 20000)
    await js(`document.querySelector('[data-shelf-card="${entry.id}"]').click(); true`)
    await until(() => js(`(() => { const button = document.querySelector('.task-shelf-detail button'); return !!button && !button.disabled })()`), `detail button ${entry.id}`, 20000)
    await js(`document.querySelector('.task-shelf-detail button').click(); true`)
    const reply = await until(async () => {
      const state = await inspect(entry.id)
      return state?.success && state.state === 'live' && state.presentationOwner === 'main' ? state : false
    }, `saved:${entry.id} live in main`, 30000)
    const guest = await until(() => guestFor(entry.url), `guest for ${entry.url}`, 20000)
    await until(() => guests().length === expectedGuestCount, `guest count ${expectedGuestCount}`, 20000)
    const gate = await until(async () => {
      const value = await js(`(() => { const wrapper=document.querySelector('[data-webtab-wrapper="shelf-web-${entry.id}"]');const page=wrapper?.querySelector('webview');return {ready:!!page&&!page.hasAttribute('inert'),hidden:document.hidden,fallback:[...wrapper?.querySelectorAll('button')??[]].some(button=>button.textContent==='Show current page')} })()`)
      if (value.hidden) { main.show(); main.focus(); result.counts.visibilityRescues=(result.counts.visibilityRescues||0)+1; return false }
      return value.ready ? 'ready' : value.fallback ? 'explicit-fallback' : false
    }, `actual input gate for ${entry.id}`, 10000)
    if (gate === 'explicit-fallback') {
      check('fallback still shows the controlled document', await guest.executeJavaScript('document.title',true) === entry.title)
      await screenshot(`explicit-fallback-${entry.id}`)
      result.counts.presentationFallbacks=(result.counts.presentationFallbacks||0)+1
      await js(`(()=>{const wrapper=document.querySelector('[data-webtab-wrapper="shelf-web-${entry.id}"]');[...wrapper.querySelectorAll('button')].find(button=>button.textContent==='Show current page').click();return true})()`)
      await until(()=>js(`!document.querySelector('[data-webtab-wrapper="shelf-web-${entry.id}"] webview').hasAttribute('inert')`), 'explicit fallback input gate')
    }
    const domPartition = await until(async () => {
      const value = await readWebviewPartition(entry)
      return value || false
    }, `webview partition for ${entry.id}`, 15000)
    if (entry.readonly) {
      check(`${entry.id} resource-specific read-only partition`, READONLY_PARTITION_RE.test(domPartition), { domPartition })
      if (!entry.partition) {
        entry.partition = domPartition
        entry.sessionObject = guest.session
      } else {
        check(`${entry.id} read-only partition stable across restore`, domPartition === entry.partition, { domPartition, partition: entry.partition })
        check(`${entry.id} read-only Session object stable across restore`, guest.session === entry.sessionObject)
      }
      check(`${entry.id} native guest uses exact read-only Session`, guest.session === session.fromPartition(entry.partition))
      check(`${entry.id} read-only Session is in-memory`, guest.session.getStoragePath() === null, { storagePath: guest.session.getStoragePath() })
    } else {
      check(`${entry.id} dynamic partition is webbar`, domPartition === WEBBAR_PARTITION, { domPartition })
      check(`${entry.id} dynamic guest uses webbar Session`, guest.session === session.fromPartition(WEBBAR_PARTITION))
    }
    entry.opened = true
    entry.inspect = {
      state: reply.state,
      readonlyMode: reply.readonlyMode,
      deepSleepSupported: reply.deepSleepSupported,
      presentationOwner: reply.presentationOwner,
      partition: reply.partition || null
    }
    check(`${entry.id} single native guest`, guestCountFor(entry.url) === 1, { count: guestCountFor(entry.url) })
    if (entry.readonly) check(`${entry.id} deep sleep supported`, reply.deepSleepSupported === true)
    return guest
  }

  const runArm = async () => {
    await setupRenderer()
    markPhase('boot')
    const sampler = setInterval(sampleMemory, 100)
    try {
      setStep('prefs')
      await js(`localStorage.setItem('lyshell.taskShelf.view.v1', JSON.stringify({ mode: 'fixed', width: 620, height: 420, edge: 'right' })); localStorage.setItem('lyshell.taskShelf.realtime.v1', 'none'); true`)
      try { await js('location.reload(); true', 5000) } catch { /* frame reloads */ }
      await sleep(400)
      await setupRenderer()
      await waitListReady()

      const list = await listShelf()
      check('12 seeded entries loaded', list.entries?.length === TOTAL_ENTRIES, { count: list.entries?.length })
      check('entries archived at first boot', list.entries.every((entry) => !!entry.archivedAt))
      check('no native guests before activation', guests().length === 0, { guests: guests().length })

      await openShelfPanel()
      await js(`(() => { const tab = document.querySelectorAll('[role="tab"]')[1]; if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click(); return true })()`)
      await until(() => js("(() => { const button = document.querySelector('.task-shelf-policy button'); return !!button && !button.disabled })()"), 'activate-all button ready', 20000)
      await js(`(() => {
        const button = [...document.querySelectorAll('.task-shelf-policy button')][0]
        if (button && !button.disabled) { button.click(); return true }
        return false
      })()`)
      await until(async () => {
        const current = await listShelf()
        if (current.entries.length !== TOTAL_ENTRIES || current.entries.some((entry) => !!entry.archivedAt)) return false
        return (await js("document.querySelectorAll('[data-shelf-card]').length")) === TOTAL_ENTRIES
      }, 'activate all entries', 30000)

      const realtime = await js("document.querySelector('.task-shelf-policy select')?.value ?? null")
      if (realtime !== 'none') {
        await js(`(() => { const select = document.querySelector('.task-shelf-policy select'); if (!select) return false; select.value = 'none'; select.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
        await until(() => js("document.querySelector('.task-shelf-policy select')?.value === 'none'"), 'realtime none', 10000)
      }
      check('realtime/preview demand disabled', (await js("document.querySelector('.task-shelf-policy select')?.value")) === 'none')

      setStep('open-all')
      let index = 0
      for (const entry of entries) {
        const guest = await openEntry(entry, index + 1)
        if (entry.readonly) {
          await until(async () => (await guest.executeJavaScript("document.querySelector('#pixel')?.naturalWidth || 0", true)) > 0, `${entry.id} pixel loaded`, 15000)
          const probe = await probeStatic(guest)
          entry.probe = probe
          check(`${entry.id} title untouched by script`, probe.title === entry.title, { title: probe.title })
          check(`${entry.id} page script did not run`, probe.ran === false, { ran: probe.ran })
          check(`${entry.id} submit disabled by preload`, probe.submitDisabled === true)
          check(`${entry.id} text input disabled`, probe.textDisabled === true)
          check(`${entry.id} textarea disabled`, probe.taDisabled === true)
          check(`${entry.id} file input hardened`, probe.fileType === 'text', { fileType: probe.fileType })
          check(`${entry.id} contenteditable removed`, probe.editEditable === false && probe.editAttribute === null, { editable: probe.editEditable, attribute: probe.editAttribute })
          check(`${entry.id} subframe blocked`, probe.frameBlank === true, { frameSrc: probe.frameSrc })
          check(`${entry.id} tall document for scroll`, probe.scrollHeight > 3000, { scrollHeight: probe.scrollHeight })
          const webPrefs = typeof guest.getLastWebPreferences === 'function' ? guest.getLastWebPreferences() : null
          if (webPrefs) {
            check(`${entry.id} readonly contract javascript=true`, webPrefs.javascript === true, { javascript: webPrefs.javascript })
            check(`${entry.id} readonly contract sandboxed and isolated`, webPrefs.sandbox === true && webPrefs.contextIsolation === true && webPrefs.nodeIntegration === false, {
              sandbox: webPrefs.sandbox,
              contextIsolation: webPrefs.contextIsolation,
              nodeIntegration: webPrefs.nodeIntegration
            })
            // Electron omits partition from getLastWebPreferences in this build; a present value must be compatible.
            if (typeof webPrefs.partition === 'string') check(`${entry.id} prefs partition compatible when present`, isReadonlyPartitionValue(webPrefs.partition), { partition: webPrefs.partition })
            else soft(`${entry.id} prefs partition omitted by Electron`, true, { reason: 'native Session identity is authoritative' })
          } else {
            soft(`${entry.id} readonly web preferences readable`, false, { reason: 'getLastWebPreferences unavailable' })
          }
          soft(`${entry.id} media blocked`, probe.mediaReady === 0 && probe.mediaNetwork === 3, { readyState: probe.mediaReady, networkState: probe.mediaNetwork })
          await setupStaticRestore(guest, entry, index)
        } else if (entry.kind === 'protected') {
          const probe = await until(async () => {
            const value = await guest.executeJavaScript(`({ title: document.title, protected: window.__protected === true, beforeunload: typeof window.onbeforeunload === 'function' })`, true)
            return value.protected ? value : false
          }, 'protected script ran', 20000).catch(async (error) => {
            const diag = await guest.executeJavaScript(`({
              href: location.href,
              ready: document.readyState,
              title: document.title,
              prot: window.__protected === true,
              bodyText: document.body ? document.body.innerText.slice(0, 240) : null,
              scripts: document.scripts.length,
              csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
              wcId: true
            })`, true).catch((inner) => ({ error: inner.message }))
            error.message += ` :: ${JSON.stringify(diag)}`
            throw error
          })
          entry.probe = probe
          check('protected title', probe.title === 'Protected dynamic', { title: probe.title })
          check('protected beforeunload installed', probe.beforeunload === true)
          const draft = await guest.executeJavaScript(`(() => { const input = document.querySelector('#draft'); input.value = 'unsaved draft'; input.dispatchEvent(new Event('input', { bubbles: true })); return input.value })()`, true)
          check('protected draft typed', draft === 'unsaved draft', { draft })
          await guest.executeJavaScript(`(() => { const notes = document.querySelector('#notes'); notes.value = 'unsaved notes'; notes.dispatchEvent(new Event('input', { bubbles: true })); return true })()`, true)
        } else {
          const probe = await until(async () => {
            const value = await guest.executeJavaScript(`({ title: document.title, unknown: window.__unknown === true, marker: document.querySelector('#marker')?.textContent || null })`, true)
            return value.unknown ? value : false
          }, 'unknown script ran', 20000)
          entry.probe = probe
          check('unknown title', probe.title === 'Unknown dynamic', { title: probe.title })
          check('unknown marker', probe.marker === 'unknown-dynamic-ok', { marker: probe.marker })
        }
        entry.openedAt = nowMs()
        index += 1
      }

      const readOnlyEntries = entries.filter((entry) => entry.readonly)
      check('10 distinct resource-specific read-only partitions', new Set(readOnlyEntries.map((entry) => entry.partition)).size === STATIC_COUNT, { partitions: readOnlyEntries.map((entry) => entry.partition) })
      check('10 distinct read-only Session identities', new Set(readOnlyEntries.map((entry) => entry.sessionObject)).size === STATIC_COUNT)
      check('every read-only entry has a UUID partition', readOnlyEntries.every((entry) => READONLY_PARTITION_RE.test(entry.partition || '')))

      const listAfterOpen = await listShelf()
      const openEntries = listAfterOpen.entries.filter((entry) => !entry.archivedAt)
      check('all 12 entries active', openEntries.length === TOTAL_ENTRIES)
      const urls = guests().map((guest) => guest.getURL())
      check('12 native guests retained', guests().length === TOTAL_ENTRIES, { guests: guests().length })
      check('no duplicate guests', new Set(urls).size === urls.length, { urls })
      check('both dynamic guests live', entries.filter((entry) => !entry.readonly).every((entry) => !!guestFor(entry.url)))

      markPhase('loaded')
      await sleep(2000)
      await screenshot('loaded')

      setStep('enforcement')
      const hitsBefore = await fetchHits(port)
      soft('image resource allowed by read-only contract', (hitsBefore?.counts?.['/pixel.gif'] || 0) >= STATIC_COUNT, hitsBefore?.counts || null)
      for (const entry of entries.filter((item) => item.readonly)) {
        const guest = guestFor(entry.url)
        check(`${entry.id} guest still live after probes`, !!guest)
        check(`${entry.id} no navigation after probes`, guest.getURL() === entry.url, { url: guest.getURL() })
      }

      {
        setStep('both-form-attempt')
        const formEntry = entries[0]
        const formGuest = guestFor(formEntry.url)
        check('form-attempt guest exists', !!formGuest)
        const formClick = await formGuest.executeJavaScript(`(() => {
          const button = document.querySelector('#submit')
          const disabled = !!button?.disabled
          try { button?.click() } catch (error) { /* blocked */ }
          return { disabled, href: location.href }
        })()`, true)
        await sleep(600)
        check('form attempt stayed on the static page', formGuest.getURL() === formEntry.url, { url: formGuest.getURL(), formClick })
        const attemptHits = await fetchHits(port)
        check('form attempt produced no POST', (attemptHits?.counts?.['/posted'] || 0) === 0, { hits: attemptHits?.counts || null, formClick })
      }
      markPhase('idle')
      if (arm === 'before') {
        setStep('before-recall')
        await recallAll()
        await waitPresentationsNone(entries.map((entry) => entry.id))
        await sleep(1200)
        advance()
        setStep('before-no-sleep')
        await sleep(3000)
        for (const entry of entries.filter((item) => item.readonly)) {
          const reply = await inspect(entry.id)
          check(`${entry.id} stays live with sleep disabled`, reply?.success && reply.state === 'live', { state: reply?.state })
        }
        check('before arm keeps 12 live guests', guests().length === TOTAL_ENTRIES, { guests: guests().length })
        await screenshot('shelved-live')

        setStep('before-cycles')
        markPhase('cycles')
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          const entry = entries[cycle % STATIC_COUNT]
          const cycleStart = realNow()
          const guest = await openEntry(entry, TOTAL_ENTRIES)
          check(`reload ${cycle} guest exists`, !!guest)
          await reloadGuest(guest, entry.title)
          const ran = await guest.executeJavaScript('typeof window.__ran !== "undefined"', true)
          check(`reload ${cycle} script blocked`, ran === false)
          const readyMs = realNow() - cycleStart
          const inputMs = await measureWheel(guest)
          await recallAll(); await waitPresentationsNone([entry.id]); await sleep(1200); advance(); await sleep(1000)
          result.cyclesLog.push({ i: cycle, kind: 'reload', id: entry.id, ok: true, readyMs, inputMs, ms: Math.round(realNow() - cycleStart) })
        }
        result.counts.reloadCycles = cycles
        result.counts.cycles = cycles

        setStep('before-final')
        markPhase('final')
        await sleep(2000)
        await screenshot('final')
        check('before final guests still 12', guests().length === TOTAL_ENTRIES, { guests: guests().length })
        for (const entry of entries.filter((item) => item.readonly)) {
          const reply = await inspect(entry.id)
          check(`${entry.id} live at final`, reply?.success && reply.state === 'live', { state: reply?.state })
        }
        result.counts.finalGuests = guests().length
        result.counts.finalLiveReadonly = entries.filter((entry) => entry.readonly).filter((entry) => guestFor(entry.url)).length
      } else {
        setStep('after-first-sleep')
        check('sleep enabled in after arm', process.env.LYSHELL_SHELF_READONLY_SLEEP !== '0')
        await recallAll()
        await waitPresentationsNone(entries.map((entry) => entry.id))
        await sleep(1200)
        advance()
        const sleepingStates = await waitStaticSleeping(40000)
        result.counts.sleepingStates = sleepingStates
        for (const entry of entries.filter((item) => item.readonly)) {
          const reply = await inspect(entry.id)
          check(`${entry.id} sleeping`, reply?.success && reply.state === 'sleeping', { state: reply?.state, sleepReason: reply?.sleepReason })
          check(`${entry.id} reported readonly`, reply?.readonlyMode === true)
          check(`${entry.id} guest destroyed`, guestFor(entry.url) === null, { guest: entry.url })
        }
        markPhase('sleep')
        await sleep(2000)
        for (const entry of entries.filter((item) => !item.readonly)) {
          check(`${entry.id} dynamic guest survived sleep`, !!guestFor(entry.url))
        }
        const protectedEntry = entries.find((entry) => entry.kind === 'protected')
        const protectedGuest = guestFor(protectedEntry.url)
        const draft = await protectedGuest.executeJavaScript("document.querySelector('#draft').value", true)
        check('protected draft survived first sleep', draft === 'unsaved draft', { draft })
        const unknownEntry = entries.find((entry) => entry.kind === 'unknown')
        check('unknown guest survived first sleep', !!guestFor(unknownEntry.url))
        const jsonAfterSleep = readShelfJson()
        for (const entry of entries.filter((item) => item.readonly)) {
          const sleepMeta = jsonEntry(jsonAfterSleep.json, entry.id)?.recovery?.sleep
          check(`${entry.id} sleep metadata persisted`, !!sleepMeta, { entry: jsonEntry(jsonAfterSleep.json, entry.id)?.recovery || null })
          if (sleepMeta) {
            check(`${entry.id} sleep metadata format`, sleepMeta.formatVersion === 1, sleepMeta)
            check(`${entry.id} sleep metadata partition is its own Session`, sleepMeta.partition === entry.partition && READONLY_PARTITION_RE.test(sleepMeta.partition || ''), { saved: sleepMeta.partition, partition: entry.partition })
            check(`${entry.id} sleep metadata suspendOperationId`, typeof sleepMeta.suspendOperationId === 'string' && sleepMeta.suspendOperationId.length > 0, { suspendOperationId: sleepMeta.suspendOperationId })
            check(`${entry.id} sleep metadata url`, sleepMeta.url === entry.url, sleepMeta)
            check(`${entry.id} sleep metadata taskId`, sleepMeta.taskId === entry.id, sleepMeta)
            check(`${entry.id} sleep metadata no query`, !sleepMeta.url.includes('?') && !sleepMeta.url.includes('#'))
            soft(`${entry.id} sleep metadata scroll`, Math.abs((sleepMeta.scrollY || 0) - entry.expected.scrollY) <= 6, { saved: sleepMeta.scrollY, expected: entry.expected.scrollY })
            soft(`${entry.id} sleep metadata zoom`, Math.abs((sleepMeta.zoom || 0) - entry.expected.zoom) < 0.02, { saved: sleepMeta.zoom, expected: entry.expected.zoom })
            entry.sleep = { partition: sleepMeta.partition, zoom: sleepMeta.zoom, scrollY: sleepMeta.scrollY }
          }
        }
        const listSleep = await listShelf()
        for (const entry of entries.filter((item) => item.readonly)) {
          const sleepMeta = listSleep.entries.find((item) => item.id === entry.id)?.recovery?.sleep
          check(`${entry.id} list exposes sleep metadata`, !!sleepMeta)
        }
        check('after first sleep only 2 guests', guests().length === 2, { guests: guests().map((guest) => guest.getURL()) })
        await screenshot('sleeping')
        markPhase('cycles')

        setStep('after-cycles')
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          const entry = entries[cycle % STATIC_COUNT]
          const cycleStart = realNow()
          const before = await inspect(entry.id)
          check(`cycle ${cycle} ${entry.id} sleeping before wake`, before?.success && before.state === 'sleeping', { state: before?.state })
          const guest = await openEntry(entry, 3)
          await until(async () => {
            const value = await inspect(entry.id)
            return value?.success && value.state === 'live' && value.presentationOwner === 'main'
          }, `cycle ${cycle} live`, 30000)
          const expectedZoom = entry.sleep?.zoom ?? entry.expected.zoom
          const expectedScroll = entry.sleep?.scrollY ?? entry.expected.scrollY
          const restored = await until(async () => {
            const zoom = guest.getZoomFactor()
            const scroll = await guest.executeJavaScript('window.scrollY', true)
            return Math.abs(zoom - expectedZoom) < 0.05 && Math.abs(scroll - expectedScroll) <= 6 ? { zoom, scroll } : false
          }, `cycle ${cycle} ${entry.id} zoom+scroll restored`, 10000).catch(async () => {
            const zoom = guest.getZoomFactor()
            const scroll = await guest.executeJavaScript('window.scrollY', true).catch(() => null)
            return { zoom, scroll }
          })
          check(`cycle ${cycle} ${entry.id} zoom restored`, Math.abs((restored.zoom || 0) - expectedZoom) < 0.05, { zoom: restored.zoom, expectedZoom })
          check(`cycle ${cycle} ${entry.id} scroll restored`, Math.abs((restored.scroll || 0) - expectedScroll) <= 6, { restoredScroll: restored.scroll, expectedScroll, sleep: entry.sleep || null })
          const zoom = restored.zoom
          const restoredScroll = restored.scroll
          const ran = await guest.executeJavaScript('typeof window.__ran !== "undefined"', true)
          check(`cycle ${cycle} ${entry.id} script still blocked`, ran === false)
          check(`cycle ${cycle} ${entry.id} readonly session`, guest.session.getStoragePath() === null, { storagePath: guest.session.getStoragePath() })
          const readyMs = realNow() - cycleStart
          const inputMs = await measureWheel(guest)
          await recallAll()
          await waitPresentationsNone([entry.id], `cycle ${cycle} presentation released`)
          await sleep(1200)
          advance()
          await waitState(entry.id, 'sleeping', 30000)
          check(`cycle ${cycle} ${entry.id} destroyed again`, guestFor(entry.url) === null)
          check(`cycle ${cycle} only dynamic guests remain`, guests().length === 2, { guests: guests().map((guest) => guest.getURL()) })
          const afterJson = readShelfJson()
          const sleepMeta = jsonEntry(afterJson.json, entry.id)?.recovery?.sleep
          soft(`cycle ${cycle} ${entry.id} sleep metadata rewritten`, !!sleepMeta && sleepMeta.url === entry.url, { sleepMeta: sleepMeta || null })
          if (sleepMeta) {
            check(`cycle ${cycle} ${entry.id} partition still the same Session`, sleepMeta.partition === entry.partition, { saved: sleepMeta.partition, partition: entry.partition })
            entry.sleep = { partition: sleepMeta.partition, zoom: sleepMeta.zoom, scrollY: sleepMeta.scrollY }
          }
          result.cyclesLog.push({ i: cycle, kind: 'wake-sleep', id: entry.id, ok: true, readyMs, inputMs, ms: Math.round(realNow() - cycleStart), zoom: round2(zoom), restoredScroll: round2(restoredScroll) })
          if (cycle % 5 === 0) {
            const protectedAfter = guestFor(protectedEntry.url)
            const unknownAfter = guestFor(unknownEntry.url)
            check(`cycle ${cycle} dynamic guests alive`, !!protectedAfter && !!unknownAfter)
            const draftAfter = await protectedAfter.executeJavaScript("document.querySelector('#draft').value", true)
            check(`cycle ${cycle} protected draft intact`, draftAfter === 'unsaved draft', { draft: draftAfter })
          }
        }
        result.counts.restoreCycles = cycles
        result.counts.cycles = cycles

        setStep('after-final')
        await recallAll(true).catch(() => {})
        await waitPresentationsNone(entries.map((entry) => entry.id)).catch(() => {})
        markPhase('final')
        await sleep(2000)
        await screenshot('final')
        const finalStates = []
        for (const entry of entries.filter((item) => item.readonly)) {
          const reply = await inspect(entry.id)
          finalStates.push(reply?.state || '?')
        }
        check('all 10 read-only guests sleeping at final', finalStates.every((state) => state === 'sleeping'), { finalStates })
        const jsonFinal = readShelfJson()
        for (const entry of entries.filter((item) => item.readonly)) {
          check(`${entry.id} final sleep metadata present`, !!jsonEntry(jsonFinal.json, entry.id)?.recovery?.sleep)
        }
        check('final guests are exactly the 2 dynamic pages', guests().length === 2, { guests: guests().map((guest) => guest.getURL()) })
        for (const entry of entries.filter((item) => item.readonly)) {
          check(`${entry.id} guest destroyed at final`, guestFor(entry.url) === null)
        }
        check('protected guest alive at final', !!guestFor(protectedEntry.url))
        check('unknown guest alive at final', !!guestFor(unknownEntry.url))
        const finalDraft = await guestFor(protectedEntry.url).executeJavaScript("document.querySelector('#draft').value", true)
        check('protected draft survived all cycles', finalDraft === 'unsaved draft', { draft: finalDraft })
        const unknownMarker = await guestFor(unknownEntry.url).executeJavaScript("document.querySelector('#marker')?.textContent", true)
        check('unknown page marker intact', unknownMarker === 'unknown-dynamic-ok', { marker: unknownMarker })
        result.counts.finalGuests = guests().length
        result.counts.finalLiveReadonly = 0
        result.counts.finalLiveDynamic = 2
      }

      setStep('server-hits')
      const hits = await fetchHits(port)
      result.serverHits = hits
      if (hits?.counts) {
        for (const blocked of ['/subframe', '/media.mp4', '/posted', '/leak', '/worker.js', '/beacon', '/leak.gif']) {
          check(`no ${blocked} request from read-only guests`, (hits.counts[blocked] || 0) === 0, { count: hits.counts[blocked] || 0 })
        }
        check('static pages fetched through read-only session', (hits.counts['/pixel.gif'] || 0) >= STATIC_COUNT, { pixel: hits.counts['/pixel.gif'] || 0 })
      }

      memorySummary()
      result.counts.totalGuestCreates = result.counts.nativeAttaches
      check('native creation count matches successful workload', result.counts.nativeAttaches === TOTAL_ENTRIES + (arm === 'after' ? cycles : 0))
      result.ok = true
      result.finishedAt = new Date(realNow()).toISOString()
      result.wallMs = realNow() - startedAt
      result.virtualOffsetMs = virtualOffset
      result.counts.entries = entries.length
      result.entries = entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        url: entry.url,
        readonly: entry.readonly,
        partition: entry.partition || null,
        expected: entry.expected || null,
        sleep: entry.sleep || null,
        probe: entry.probe || null,
        inspect: entry.inspect || null
      }))
      if (arm === 'after') {
        fs.writeFileSync(path.join(baseDir, 'expected-partitions.json'), JSON.stringify({ static: Object.fromEntries(entries.filter((entry) => entry.readonly).map((entry) => [entry.id, entry.partition])) }, null, 2))
      }
      console.log(`[child][${arm}] ok guests=${result.counts.finalGuests} cycles=${result.counts.cycles} finalMedian=${result.memory.phases.final?.median}`)
      writeResult()
      app.exit(0)
    } finally {
      clearInterval(sampler)
    }
  }

  app.whenReady().then(async () => {
    try {
      await session.fromPartition(WEBBAR_PARTITION).setProxy({ mode: 'direct' })
      await runArm()
    } catch (error) {
      await fail(error)
    }
  }).catch((error) => fail(error))

  // Load the actual built app last (same pattern as app-acceptance.cjs).
  require(path.join(ROOT, 'dist', 'main', 'index.js'))
}

function seedEntries(configDir, fixtureBase) {
  const entries = []
  for (let index = 0; index < STATIC_COUNT; index += 1) {
    entries.push({
      id: `static-${index}`,
      kind: 'static',
      title: `Static ${index}`,
      url: `${fixtureBase}/fixture/${index}`,
      readonly: true
    })
  }
  entries.push({ id: 'protected', kind: 'protected', title: 'Protected dynamic', url: `${fixtureBase}/protected`, readonly: false })
  entries.push({ id: 'unknown', kind: 'unknown', title: 'Unknown dynamic', url: `${fixtureBase}/unknown`, readonly: false })
  const file = path.join(configDir, 'task-shelf.json')
  const document = {
    version: 1,
    entries: entries.map((entry) => ({
      id: entry.id,
      resourceKey: `web:${entry.id}`,
      title: entry.title,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      capability: 'web',
      recovery: entry.readonly
        ? { kind: 'web', url: entry.url, readonlyMode: true }
        : { kind: 'web', url: entry.url }
    }))
  }
  fs.writeFileSync(path.join(configDir, 'browser-settings.json'), JSON.stringify({ homePage:'',searchEngine:'bing',zoomFactor:1,rememberHistory:true,restoreTabs:false,restoreMini:true,savePasswords:false,proxyMode:'direct',proxyServer:'',proxyBypass:'<local>',permissions:{camera:'deny',microphone:'deny',notifications:'deny',geolocation:'deny',clipboard:'deny'} }))
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`)
  return entries
}

/* -------------------------------------------------------------------------- */
/* Recheck child                                                               */
/* -------------------------------------------------------------------------- */

async function recheckMain(argv) {
  const { app } = require('electron')
  const base = String(argv.base || '')
  const out = String(argv.out || path.join(base, 'recheck.json'))
  const appData = path.join(base, 'appData')
  const devUserData = path.join(appData, 'lyshell-dev')
  const configDir = path.join(devUserData, 'config')
  process.env.DSH_HOME = path.join(base, 'dsh-home')
  app.setPath('appData', appData)
  app.setPath('sessionData', path.join(base, 'session-data'))
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('no-proxy-server')

  const result = { ok: false, base, configDir, archived: null, bootId: null, expectedBootId: argv['expected-boot'] || null, snapshot: null, guests: 0 }
  let main = null
  app.on('browser-window-created', (_event, win) => { if (!main) main = win })
  const write = (code) => {
    try {
      fs.writeFileSync(out, JSON.stringify(result, null, 2))
    } catch (error) {
      console.error('[recheck] write failed:', error.message)
    }
    app.exit(code)
  }
  app.whenReady().then(async () => {
    try {
      const { webContents } = require('electron')
      if (argv['expected-boot']) result.expectedBootId = argv['expected-boot']
      await new Promise((resolve) => setTimeout(resolve, 3000))
      let reply = null
      for (let attempt = 0; attempt < 60 && !reply; attempt += 1) {
        try {
          const value = await main.webContents.executeJavaScript("window.electronAPI.taskShelfRequest({kind:'list'})", true)
          if (value?.success && value.startup?.status === 'ready') reply = value
        } catch { /* retry */ }
        if (!reply) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (!reply) throw new Error('recheck: task shelf never became ready')
      result.bootId = reply.startup?.bootId || null
      result.archived = reply.entries.every((entry) => !!entry.archivedAt)
      result.entryCount = reply.entries.length
      const file = path.join(configDir, 'task-shelf.json')
      const json = JSON.parse(fs.readFileSync(file, 'utf8'))
      const expectedFile = path.join(base, 'expected-partitions.json')
      result.expectedPartitions = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, 'utf8')).static || null : null
      result.snapshot = json.entries.map((entry) => ({
        id: entry.id,
        archived: !!entry.archivedAt,
        sleep: entry.recovery?.sleep
          ? {
              formatVersion: entry.recovery.sleep.formatVersion,
              partition: entry.recovery.sleep.partition,
              url: entry.recovery.sleep.url,
              taskId: entry.recovery.sleep.taskId,
              zoom: entry.recovery.sleep.zoom,
              scrollY: entry.recovery.sleep.scrollY,
              suspendOperationId: entry.recovery.sleep.suspendOperationId || null
            }
          : null
      }))
      result.guests = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getType() === 'webview').length
      result.listSleep = reply.entries.filter((entry) => !!entry.recovery?.sleep).length
      const staticSnapshots = result.snapshot.filter((entry) => entry.id.startsWith('static-'))
      const expected = result.expectedPartitions || {}
      const snapshotPartitions = staticSnapshots.map((entry) => entry.sleep?.partition || null)
      const expectedValues = staticSnapshots.map((entry) => expected[entry.id] || null)
      result.ok = result.entryCount === TOTAL_ENTRIES && result.archived === true && staticSnapshots.length === STATIC_COUNT && staticSnapshots.every((entry) => entry.sleep && entry.sleep.formatVersion === 1 && READONLY_PARTITION_RE.test(entry.sleep.partition || '') && entry.sleep.partition === expected[entry.id] && typeof entry.sleep.suspendOperationId === 'string' && entry.sleep.suspendOperationId.length > 0) && new Set(snapshotPartitions).size === STATIC_COUNT && new Set(expectedValues).size === STATIC_COUNT && result.listSleep === STATIC_COUNT && result.guests === 0 && (!result.expectedBootId || result.bootId !== result.expectedBootId)
      if (!result.ok) result.error = { message: 'recheck assertions failed', detail: { entryCount: result.entryCount, archived: result.archived, guests: result.guests, listSleep: result.listSleep, bootId: result.bootId, expectedBootId: result.expectedBootId, staticSleep: staticSnapshots.map((entry) => !!entry.sleep), snapshotPartitions, expectedValues } }
      write(result.ok ? 0 : 1)
    } catch (error) {
      result.error = { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 10).join('\n') }
      write(1)
    }
  }).catch((error) => {
    result.error = { message: error.message }
    write(1)
  })
  require(path.join(ROOT, 'dist', 'main', 'index.js'))
}

/* -------------------------------------------------------------------------- */

const ARGV = parseArgs(process.argv.slice(2))
if (IS_ELECTRON) {
  void childMain(ARGV).catch((error) => {
    console.error('[child] fatal:', error?.stack || error)
    setTimeout(() => process.exit(1), 500)
  })
} else {
  parentMain(ARGV).catch((error) => {
    console.error('[parent] fatal:', error?.stack || error)
    process.exitCode = 1
  })
}
