#!/usr/bin/env node
/*
 * Ordinary-page (reloadable) full-app sleep/wake memory + acceptance scenario.
 *
 * Scope (owned by this script): ordinary pages restored through the normal
 * `persist:webbar` Session with a per-URL explicit reloadable consent, deep-slept
 * by the reloadable production path (no readonly partitions, no readonly preload).
 *
 * This is NOT the earlier read-only experiment and NOT the navigation experiment:
 *   - every fixture page runs ordinary JavaScript,
 *   - consent is seeded per URL as `recovery.reloadableMode: true` (simulated
 *     "the user already confirmed this URL", NOT automatic approval of a live op),
 *   - the measured `before` arm only disables the reloadable sleep path through
 *     the production env switch `LYSHELL_SHELF_RELOADABLE_SLEEP=0`; the `after`
 *     arm runs the unmodified production contract.
 *
 * Parent (plain node) spawns fresh Electron processes, alternating arm order per
 * round, with isolated appData/userData/DSH_HOME and a loopback fixture server.
 * Each child drives the real shelf UI (cards / detail action / recall) and writes
 * a result JSON atomically. A final fresh process re-reads task-shelf.json.
 *
 * Usage:
 *   node scripts/shelf-memory-p0/reloadable-app.cjs [--rounds=3] [--cycles=34]
 *        [--timeout=600000] [--only=before|after] [--keep-going] [--resume=<file>]
 *   node scripts/shelf-memory-p0/reloadable-app.cjs --probe   (dev: resolve the UI
 *        presentation path once; no docs results are written)
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const ARTIFACTS = path.join(ROOT, 'tmp', 'reloadable-app')
const DOCS = path.join(ROOT, 'docs', 'shelf-memory-p0')
const DOCS_RESULTS = path.join(DOCS, 'reloadable-app-results.json')
const REPORT = path.join(ROOT, 'tmp', 'reloadable-app', 'report.md')
const READY = path.join(ROOT, 'tmp', 'reloadable-build-ready.json')

const IS_ELECTRON = !!process.versions.electron
const realNow = Date.now.bind(Date)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Virtual clock: Electron child only. The harness itself always measures with realNow().
// It is installed before `electron` / `dist/main/index.js` are required so the
// production runtime captures the patched Date.now and sees the 5 minute idle.
let virtualOffset = 0
if (IS_ELECTRON) {
  Date.now = () => realNow() + virtualOffset
}

const WEBBAR_PARTITION = 'persist:webbar'
const HOST = 'reloadable-fixture.test'
const READING_COUNT = 10
const TOTAL_ENTRIES = 12
const DEFAULT_ROUNDS = 3
const DEFAULT_CYCLES = 34
const VIRTUAL_STEP_MS = 300001
const COOKIE_NAME = 'shelf_fixture_session'
const COOKIE_VALUE = 'ok-1'
// 与实际 UI 的浏览器设置一致，避免小窗/主区交接恢复设置值后与裸 native 修改冲突。
const ZOOM_CYCLE = [1.25]

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

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
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const eq = arg.indexOf('=')
    if (eq === -1) out[arg.slice(2)] = true
    else out[arg.slice(2, eq)] = arg.slice(eq + 1)
  }
  return out
}

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walkFiles(dir, acc = []) {
  let list = []
  try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const item of list) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) walkFiles(full, acc)
    else if (item.isFile()) acc.push(full)
  }
  return acc
}

// Build signature: every production file that can change behaviour or markup.
function buildSignature() {
  const out = { electron: null, app: {}, files: {} }
  try { out.electron = require('electron/package.json').version } catch { out.electron = null }
  for (const rel of ['package.json', 'electron.vite.config.ts']) {
    const file = path.join(ROOT, rel)
    if (fs.existsSync(file)) out.app[rel] = sha256File(file)
  }
  for (const dir of ['dist/main', 'dist/preload', 'dist/renderer']) {
    for (const file of walkFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file)
      const stat = fs.statSync(file)
      out.files[rel] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: sha256File(file) }
    }
  }
  return out
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : null
}

// 实测时冻结整个 src（包括未跟踪文件和测试），dist 另独立核对。
const SHELF_SOURCE_PATHS = [
  'src',
  'scripts/shelf-memory-p0/reloadable-app.cjs',
  'package.json',
  'electron.vite.config.ts'
]

function shelfSourceSignature() {
  const files = {}
  for (const rel of SHELF_SOURCE_PATHS) {
    const full = path.join(ROOT, rel)
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      for (const file of walkFiles(full)) {
        const fileRel = path.relative(ROOT, file).replace(/\\/g, '/')
        files[fileRel] = sha256File(file)
      }
    } else if (fs.existsSync(full)) {
      files[rel] = sha256File(full)
    }
  }
  // `git diff` never shows untracked files, so a brand-new guard/helper would otherwise
  // slip past this gate. Include untracked files whose path can affect shelf behaviour.
  const untracked = (git(['ls-files', '--others', '--exclude-standard', '--', 'src']) || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((rel) => /shelf|reloadable|webbar|web-sleep|guard|browser\//i.test(rel))
  for (const rel of untracked) {
    const full = path.join(ROOT, rel)
    if (fs.existsSync(full) && fs.statSync(full).isFile()) files[rel] = sha256File(full)
  }
  const digest = crypto.createHash('sha256').update(Object.keys(files).sort().map((key) => `${key}:${files[key]}`).join('\n')).digest('hex')
  return { digest, fileCount: Object.keys(files).length, untracked: untracked.length, files }
}

function sourceSignature() {
  const head = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--porcelain', '--', 'src', 'package.json', 'electron.vite.config.ts'])
  const diff = git(['diff', '--', 'src'])
  const shelf = shelfSourceSignature()
  return {
    head,
    shelfDigest: shelf.digest,
    shelfFileCount: shelf.fileCount,
    // Informational only: the checkout is shared with unrelated concurrent work.
    treeDirty: !!status,
    statusSha: status ? crypto.createHash('sha256').update(status).digest('hex') : null,
    diffSha: diff ? crypto.createHash('sha256').update(diff).digest('hex') : null,
    status: status || ''
  }
}

/* -------------------------------------------------------------------------- */
/* Fixture pages                                                              */
/* -------------------------------------------------------------------------- */

function authBlock(hasCookie) {
  return hasCookie
    ? '<div id="auth" data-state="signed-in">signed-in</div>'
    : '<div id="auth" data-state="signed-out">signed-out</div>'
}

// Ordinary reading page: no editable controls, no custom elements, no iframe,
// no media, no POST, no subresources. Ordinary JavaScript MUST run.
function readingPageHtml(index, hasCookie) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Reading ${index}</title>
<style>
  html, body { margin: 0; }
  body { font: 15px/1.55 Georgia, serif; padding: 24px; width: 360px; color: #111; background: #fff; }
  h1 { font-size: 26px; }
  .tall { height: 4100px; background: linear-gradient(#ffffff, #eef2ff); border: 1px solid #c7d2fe; box-sizing: border-box; }
  button { font: inherit; padding: 4px 10px; }
</style>
<script>
  window.__scriptRan = true;
  window.__readingIndex = ${index};
  window.__docNonce = Math.random().toString(36).slice(2);
  document.addEventListener('DOMContentLoaded', function () {
    var proof = document.createElement('div');
    proof.id = 'js-proof';
    proof.textContent = 'js-ok';
    document.body.appendChild(proof);
    document.body.dataset.ready = '1';
    // Session proof is read client-side from document.cookie: the synthetic login is
    // the same persist:webbar Session cookie surviving reload/sleep/restore.
    var authed = document.cookie.split(';').some(function (part) { return part.trim().indexOf('${COOKIE_NAME}=') === 0; });
    var auth = document.getElementById('auth');
    if (auth) {
      auth.textContent = authed ? 'signed-in' : 'signed-out';
      auth.setAttribute('data-state', authed ? 'signed-in' : 'signed-out');
    }
    window.__authVisible = authed;
    window.__cookiePresent = authed;
  });
</script>
</head><body>
<h1 id="heading">Reading page ${index}</h1>
<p id="lead">Ordinary scripted reading page for the reloadable full-app scenario.</p>
${authBlock(hasCookie)}
<section id="content">
  <p>Paragraph one of the reading fixture. The article is long enough to scroll.</p>
  <p>Paragraph two. Nothing here is editable and no custom element is defined.</p>
  <button id="cta" type="button">Bookmark</button>
</section>
<div class="tall" id="tall"></div>
</body></html>`
}

// Protected page: no editable controls (so the guard reaches the native close
// refusal), an armed beforeunload, a JS-only unsaved draft and random markers.
function protectedPageHtml(hasCookie) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Protected unsaved page</title>
<style>
  html, body { margin: 0; }
  body { font: 15px/1.55 Georgia, serif; padding: 24px; }
  .tall { height: 3600px; background: linear-gradient(#fff, #fef3c7); border: 1px solid #fcd34d; box-sizing: border-box; }
</style>
<script>
  window.__protected = true;
  window.__draftToken = 'draft-' + Math.random().toString(36).slice(2);
  window.__markerToken = 'marker-' + Math.random().toString(36).slice(2);
  window.onbeforeunload = function () { return 'Unsaved changes'; };
  document.addEventListener('DOMContentLoaded', function () {
    document.body.dataset.departureGuard = 'armed';
    document.body.dataset.draft = window.__draftToken;
    var marker = document.createElement('div');
    marker.id = 'marker';
    marker.textContent = window.__markerToken;
    document.body.appendChild(marker);
    window.__authVisible = !!document.getElementById('auth') && document.getElementById('auth').textContent === 'signed-in';
  });
</script>
</head><body>
<h1 id="heading">Protected unsaved page</h1>
<p>An unsaved draft lives only in page JavaScript; closing this page must be refused natively.</p>
${authBlock(hasCookie)}
<div class="tall" id="tall"></div>
</body></html>`
}

// Unknown page: ordinary page WITHOUT reloadable consent.
function unknownPageHtml(hasCookie) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Unknown page</title>
<style>
  html, body { margin: 0; }
  body { font: 15px/1.55 Georgia, serif; padding: 24px; }
  .tall { height: 2600px; background: linear-gradient(#fff, #e0f2fe); border: 1px solid #7dd3fc; box-sizing: border-box; }
</style>
<script>
  window.__unknown = true;
  window.__unknownToken = 'unknown-' + Math.random().toString(36).slice(2);
  document.addEventListener('DOMContentLoaded', function () {
    var marker = document.createElement('div');
    marker.id = 'marker';
    marker.textContent = 'unknown-live-ok';
    document.body.appendChild(marker);
  });
</script>
</head><body>
<h1 id="heading">Unknown page</h1>
<p>An ordinary page that never received reloadable consent.</p>
${authBlock(hasCookie)}
<div class="tall" id="tall"></div>
</body></html>`
}

function createFixtureServer() {
  const state = {
    startedAt: realNow(),
    hits: [],
    posts: 0,
    forbidden: [],
    // Paths a correct ordinary-page restore must never request again.
    replaySensitive: ['/posted']
  }

  const server = http.createServer((req, res) => {
    const host = req.headers.host || `${HOST}:0`
    const url = new URL(req.url || '/', `http://${host}`)
    const pathname = url.pathname
    state.hits.push({ method: req.method, path: pathname, search: url.search || '', at: realNow() })
    if (req.method === 'POST') state.forbidden.push({ path: pathname, method: req.method, at: realNow() })

    const cookieHeader = String(req.headers.cookie || '')
    const hasCookie = cookieHeader.split(';').some((part) => part.trim() === `${COOKIE_NAME}=${COOKIE_VALUE}`)
    const send = (status, type, body, extraHeaders) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      const headers = {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      }
      if (extraHeaders) Object.assign(headers, extraHeaders)
      res.writeHead(status, headers)
      res.end(buf)
    }
    const sessionCookie = { 'Set-Cookie': `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; SameSite=Lax` }

    if (pathname === '/__hits') {
      const counts = {}
      for (const hit of state.hits) counts[hit.path] = (counts[hit.path] || 0) + 1
      send(200, 'application/json', JSON.stringify({ counts, posts: state.posts, forbidden: state.forbidden.length, total: state.hits.length }))
      return
    }

    const readingMatch = /^\/reading\/(\d+)$/.exec(pathname)
    if (readingMatch) {
      const index = Number(readingMatch[1])
      if (index >= 1 && index <= READING_COUNT) {
        send(200, 'text/html; charset=utf-8', readingPageHtml(index, hasCookie), sessionCookie)
        return
      }
      send(404, 'text/plain', 'no fixture')
      return
    }

    if (pathname === '/protected') { send(200, 'text/html; charset=utf-8', protectedPageHtml(hasCookie), sessionCookie); return }
    if (pathname === '/unknown') { send(200, 'text/html; charset=utf-8', unknownPageHtml(hasCookie), sessionCookie); return }
    if (pathname === '/posted') {
      state.posts += 1
      send(200, 'text/plain', 'posted')
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
/* Parent                                                                     */
/* -------------------------------------------------------------------------- */

async function parentMain(argv) {
  if (argv.help) {
    console.log('usage: node scripts/shelf-memory-p0/reloadable-app.cjs [--rounds=3] [--cycles=34] [--timeout=600000] [--only=before|after] [--keep-going] [--resume=<file>]')
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

  fs.mkdirSync(ARTIFACTS, { recursive: true })
  fs.mkdirSync(DOCS, { recursive: true })

  if (argv.probe) {
    const probeArm = argv.arm === 'before' ? 'before' : 'after'
    const probeFixture = await createFixtureServer()
    const base = fs.mkdtempSync(path.join(ARTIFACTS, `probe-${new Date(realNow()).toISOString().replace(/[:.]/g, '-')}-`))
    const run = await runOnce({ arm: probeArm, round: 0, cycles: 0, port: probeFixture.port, timeoutMs: 300000, stamp: 'probe', electronPath, base, probe: true })
    probeFixture.server.close()
    console.log(`[parent] probe(${probeArm}): ${run.ok ? 'ok' : 'FAILED'} -> ${path.relative(ROOT, run.out)}`)
    if (run.result?.counts?.probePresentation) console.log(`[parent] probe presentation: ${JSON.stringify(run.result.counts.probePresentation)}`)
    if (!run.ok) console.error(JSON.stringify(run.result?.error || {}, null, 2))
    process.exitCode = run.ok ? 0 : 1
    return
  }

  if (!fs.existsSync(READY)) {
    console.error(`build-ready marker missing: ${path.relative(ROOT, READY)} (the build owner must publish ready:true)`)
    process.exitCode = 2
    return
  }
  const readyDoc = JSON.parse(fs.readFileSync(READY, 'utf8'))
  if (readyDoc.ready !== true) {
    console.error(`build-ready marker is not ready: ${JSON.stringify(readyDoc)}`)
    process.exitCode = 2
    return
  }

  const rounds = toInt(argv.rounds, DEFAULT_ROUNDS)
  const cycles = toInt(argv.cycles, DEFAULT_CYCLES)
  const timeoutMs = toInt(argv.timeout, 600000)
  const only = argv.only === 'before' || argv.only === 'after' ? argv.only : null
  const keepGoing = argv['keep-going'] === true

  const buildBefore = buildSignature()
  const sourceBefore = sourceSignature()
  const fixture = await createFixtureServer()
  const stamp = new Date(realNow()).toISOString().replace(/[:.]/g, '-')
  const command = `node scripts/shelf-memory-p0/reloadable-app.cjs --rounds=${rounds} --cycles=${cycles}`

  const prior = argv.resume ? JSON.parse(fs.readFileSync(path.resolve(String(argv.resume)), 'utf8')) : null
  if (prior && JSON.stringify(prior.build?.after?.files) !== JSON.stringify(buildBefore.files)) {
    throw new Error('Cannot resume across a different production build')
  }

  const runs = []
  const sourceTreeDrift = []
  let aborted = false
  let abortReason = null

  console.log(`[parent] build-ready: ${fs.readFileSync(READY, 'utf8').trim()}`)
  console.log(`[parent] fixture: http://${HOST}:${fixture.port}/ (loopback 127.0.0.1:${fixture.port})`)
  console.log(`[parent] rounds=${rounds} cycles=${cycles} timeout=${timeoutMs}ms`)

  for (let round = 1; round <= rounds && !aborted; round += 1) {
    const order = round % 2 === 1 ? ['before', 'after'] : ['after', 'before']
    for (const arm of order) {
      if (aborted) break
      if (only && arm !== only) continue
      if (!fs.existsSync(READY)) {
        aborted = true
        abortReason = { round, arm, error: { message: `build-ready marker disappeared: ${path.relative(ROOT, READY)}` } }
        break
      }
      let readyNow = null
      try { readyNow = JSON.parse(fs.readFileSync(READY, 'utf8')) } catch { readyNow = null }
      if (!readyNow || readyNow.ready !== true) {
        aborted = true
        abortReason = { round, arm, error: { message: 'build-ready marker is no longer ready:true; pausing before the next fresh app', marker: readyNow } }
        break
      }
      if (JSON.stringify(buildSignature()) !== JSON.stringify(buildBefore)) {
        aborted = true
        abortReason = { round, arm, error: { message: 'dist build changed during the run; pausing before the next fresh app' } }
        break
      }
      const sourceNow = sourceSignature()
      if (sourceNow.head !== sourceBefore.head || sourceNow.shelfDigest !== sourceBefore.shelfDigest) {
        aborted = true
        abortReason = { round, arm, error: { message: 'shelf production source changed during the run; pausing before the next fresh app' } }
        break
      }
      if (sourceNow.statusSha !== sourceBefore.statusSha) {
        sourceTreeDrift.push({ round, arm, at: new Date(realNow()).toISOString() })
        console.log('[parent] note: unrelated working-tree files changed concurrently (dist build unchanged)')
      }
      const run = await runOnce({ arm, round, cycles, port: fixture.port, timeoutMs, stamp, electronPath })
      runs.push(run)
      const mem = run.result?.memory?.phases || {}
      console.log(`[parent] round ${round} ${arm}: ${run.ok ? 'ok' : 'FAILED'} path=${run.result?.counts?.presentationPath || '?'} guests=${run.result?.counts?.finalGuests ?? '?'} loaded_median=${mem.loaded?.median ?? '?'}MiB sleep_median=${mem.sleep?.median ?? '?'}MiB final_median=${mem.final?.median ?? '?'}MiB wall=${Math.round(run.wallMs / 1000)}s`)
      if (!run.ok) {
        aborted = true
        abortReason = { round, arm, error: run.result?.error || { message: 'run failed without a result' } }
        if (keepGoing) {
          console.log('[parent] --keep-going: continuing after the failure')
          aborted = false
        }
      }
    }
  }

  const rechecks = []
  if (!aborted) {
    for (const source of runs.filter((run) => run.ok && run.arm === 'after')) {
      const recheck = await runRecheck({ source, timeoutMs, stamp, electronPath })
      rechecks.push(recheck)
      console.log(`[parent] recheck round ${source.round}: ${recheck.ok ? 'ok' : 'FAILED'}`)
      if (!recheck.ok) {
        abortReason = { round: source.round, arm: 'after', error: recheck.result?.error || { message: 'recheck failed' } }
        break
      }
    }
  }

  const buildAfter = buildSignature()
  const sourceAfter = sourceSignature()
  const buildStable = JSON.stringify(buildBefore) === JSON.stringify(buildAfter)
  const sourceStable = sourceBefore.head === sourceAfter.head && sourceBefore.shelfDigest === sourceAfter.shelfDigest
  const finalHits = await fetchHits(fixture.port)
  const summary = summarize({
    runs,
    rechecks,
    buildBefore,
    buildAfter,
    buildStable,
    sourceBefore,
    sourceAfter,
    sourceStable,
    sourceTreeDrift,
    fixtureState: fixture.state,
    finalHits,
    rounds,
    cycles,
    command,
    abortReason
  })

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

async function runOnce({ arm, round, cycles, port, timeoutMs, stamp, electronPath, base: providedBase, probe }) {
  const base = providedBase || fs.mkdtempSync(path.join(ARTIFACTS, `${stamp}-r${round}-${arm}-`))
  const out = path.join(base, 'result.json')
  const env = { ...process.env, DSH_HOME: path.join(base, 'dsh-home') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.LYSHELL_DEMO_PROFILE
  delete env.LYSHELL_SHELF_READONLY_SLEEP
  delete env.LYSHELL_SHELF_RELOADABLE_SLEEP
  if (arm === 'before') env.LYSHELL_SHELF_RELOADABLE_SLEEP = '0'

  const args = [
    __filename,
    `--arm=${arm}`,
    `--round=${round}`,
    `--cycles=${cycles}`,
    `--port=${port}`,
    `--base=${base}`,
    `--out=${out}`
  ]
  if (probe) args.push('--probe-child')

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
    result = { ok: false, error: { message: `no readable result (code=${exit.code}, timedOut=${timedOut})`, stdout, stderr } }
  }
  if (timedOut) {
    result.ok = false
    result.error = { message: `child exceeded ${timeoutMs}ms and was killed`, previous: result.error || null }
  }
  // A child must also exit cleanly: a result payload claiming ok is not enough.
  if (!timedOut && exit.code !== 0) {
    result.ok = false
    result.error = { message: `child exited with code ${exit.code}`, signal: exit.signal || null, previous: result.error || null }
  }
  if (!result.ok && !result.error) result.error = { message: 'child failed without an error payload' }
  if (!result.ok) {
    result.stdout = stdout
    result.stderr = stderr
  }
  return { arm, round, ok: !!result.ok, exit, timedOut, base: path.relative(ROOT, base), out, wallMs: realNow() - startedAt, result }
}

async function runRecheck({ source, timeoutMs, stamp, electronPath }) {
  const base = path.join(ROOT, source.base)
  const out = path.join(base, 'recheck.json')
  const env = { ...process.env, DSH_HOME: path.join(base, 'dsh-home') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.LYSHELL_DEMO_PROFILE
  delete env.LYSHELL_SHELF_READONLY_SLEEP
  delete env.LYSHELL_SHELF_RELOADABLE_SLEEP

  const args = [__filename, '--recheck', `--base=${base}`, `--out=${out}`, `--round=${source.round}`, `--expected-boot=${source.result?.bootId || ''}`]
  const startedAt = realNow()
  const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-24000) })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-24000) })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, Math.min(timeoutMs, 180000))
  const exit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: -1, signal: null, error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)

  let result = null
  try { result = JSON.parse(fs.readFileSync(out, 'utf8')) } catch {
    result = { ok: false, error: { message: `no readable recheck result (code=${exit.code}, timedOut=${timedOut})`, stdout, stderr } }
  }
  if (timedOut) {
    result.ok = false
    result.error = { message: `recheck exceeded timeout and was killed`, previous: result.error || null }
  }
  if (!timedOut && exit.code !== 0) {
    result.ok = false
    result.error = { message: `recheck exited with code ${exit.code}`, signal: exit.signal || null, previous: result.error || null }
  }
  if (!result.ok) {
    result.stdout = stdout
    result.stderr = stderr
  }
  return { round: source.round, ok: !!result.ok, exit, timedOut, base: source.base, out, wallMs: realNow() - startedAt, result }
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
}

function fetchHits(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__hits', timeout: 5000 }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

/* -------------------------------------------------------------------------- */
/* Electron child                                                             */
/* -------------------------------------------------------------------------- */

async function childMain(argv) {
  const { app, webContents, session } = require('electron')
  const arm = argv.arm === 'after' ? 'after' : 'before'
  const round = toInt(argv.round, 1)
  const cycles = toInt(argv.cycles, DEFAULT_CYCLES)
  const probeChild = argv['probe-child'] === true
  const port = toInt(argv.port, 0)
  const base = String(argv.base || '')
  const out = String(argv.out || path.join(base, 'result.json'))
  const startedAt = realNow()

  const result = {
    ok: false,
    arm,
    round,
    cycles,
    probe: probeChild,
    startedAt: new Date(realNow()).toISOString(),
    env: {
      LYSHELL_SHELF_RELOADABLE_SLEEP: process.env.LYSHELL_SHELF_RELOADABLE_SLEEP ?? null,
      LYSHELL_SHELF_READONLY_SLEEP: process.env.LYSHELL_SHELF_READONLY_SLEEP ?? null,
      LYSHELL_SHELF_BROWSER_LIFECYCLE: process.env.LYSHELL_SHELF_BROWSER_LIFECYCLE ?? null
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch
    },
    config: {},
    checks: [],
    softFailures: [],
    cyclesLog: [],
    latency: [],
    failureAttempts: [],
    counts: {},
    memory: { samples: [], phases: {}, errors: 0, samplerCostMs: [] },
    screenshots: [],
    entries: [],
    notes: []
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
  fs.writeFileSync(path.join(configDir, '.seeded-from-prod'), `seeded by reloadable-app harness at ${new Date(realNow()).toISOString()}\n`, 'utf8')
  process.env.DSH_HOME = path.join(baseDir, 'dsh-home')
  app.setPath('appData', appData)
  app.setPath('sessionData', path.join(baseDir, 'session-data'))
  // Keep every persisted path inside the per-child temp profile: the fixture must
  // never read or write the operator's real LyShell profile.
  app.setPath('userData', devUserData)

  const fixtureBase = `http://${HOST}:${port}`
  const entries = seedEntries(configDir, fixtureBase)
  result.config = {
    base: baseDir,
    appData,
    userData: devUserData,
    configDir,
    shelfFile: path.join(configDir, 'task-shelf.json'),
    fixtureBase,
    partition: WEBBAR_PARTITION,
    virtualStepMs: VIRTUAL_STEP_MS,
    consent: 'seeded recovery.reloadableMode=true per reading/protected URL (simulated prior explicit user confirmation)'
  }

  app.commandLine.appendSwitch('host-resolver-rules', `MAP ${HOST} 127.0.0.1`)
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

  let main = null
  const observedUnloadPrevented = []
  app.on('browser-window-created', (_event, win) => {
    if (main) return
    const resolvedProfile = path.resolve(app.getPath('userData'))
    if (!resolvedProfile.startsWith(path.resolve(baseDir) + path.sep)) {
      result.isolationFailure = { userData: resolvedProfile, base: path.resolve(baseDir) }
      writeResult()
      app.exit(1)
      return
    }
    main = win
    win.webContents.setBackgroundThrottling(false)
    win.setTitle(`reloadable-app ${arm} r${round}`)
    win.webContents.on('did-attach-webview', (_event, guest) => {
      guest.setBackgroundThrottling(false)
      result.counts.nativeAttaches = (result.counts.nativeAttaches || 0) + 1
      guest.once('destroyed', () => { result.counts.nativeDestroyed = (result.counts.nativeDestroyed || 0) + 1 })
      // Observation only: never call event.preventDefault() here.
      guest.on('will-prevent-unload', () => {
        result.counts.willPreventUnload = (result.counts.willPreventUnload || 0) + 1
        let url = null
        try { url = guest.getURL() } catch { /* ignore */ }
        observedUnloadPrevented.push({ url, at: Math.round(realNow() - startedAt) })
      })
    })
  })

  const mem = result.memory
  mem.t0 = realNow()
  mem.phase = 'boot'
  const advance = () => {
    virtualOffset += VIRTUAL_STEP_MS
    result.virtualOffsetMs = virtualOffset
  }

  const bound = (value) => {
    try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
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
  const shelf = async (request) => js(`window.electronAPI.shelfBrowserRequest(${JSON.stringify(request)})`)
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
    const t = Math.round(realNow() - mem.t0)
    const started = realNow()
    try {
      const metrics = app.getAppMetrics()
      const cost = realNow() - started
      mem.samplerCostMs.push(cost)
      const byPid = {}
      const byType = {}
      const processRows = []
      for (const metric of metrics) {
        const kb = metric?.memory?.privateBytes
        if (!metric || !(metric.pid > 0) || typeof kb !== 'number' || !Number.isFinite(kb) || !(kb >= 0)) continue
        byPid[metric.pid] = Math.max(byPid[metric.pid] || 0, kb)
        byType[metric.type || 'unknown'] = (byType[metric.type || 'unknown'] || 0) + kb
        processRows.push({ pid: metric.pid, type: metric.type || 'unknown', privateKiB: Math.round(kb) })
      }
      const pids = Object.keys(byPid)
      if (pids.length === 0) return
      const totalKb = pids.reduce((sum, pid) => sum + byPid[pid], 0)
      const sample = {
        t,
        phase: mem.phase,
        costMs: Math.round(cost * 100) / 100,
        totalMiB: Math.round((totalKb / 1024) * 1000) / 1000,
        pidCount: pids.length,
        byPidMiB: {},
        byTypeMiB: {},
        processes: processRows
      }
      for (const pid of pids) sample.byPidMiB[pid] = Math.round((byPid[pid] / 1024) * 1000) / 1000
      for (const type of Object.keys(byType)) sample.byTypeMiB[type] = Math.round((byType[type] / 1024) * 1000) / 1000
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
  const summarizeMemory = () => {
    const phases = {}
    for (const phase of ['boot', 'loaded', 'transition', 'sleep', 'cycles', 'final']) {
      const windowSamples = mem.samples.filter((sample) => sample.phase === phase)
      const values = windowSamples.map((sample) => sample.totalMiB)
      if (values.length === 0) continue
      phases[phase] = {
        samples: values.length,
        median: round2(median(values)),
        mean: round2(values.reduce((sum, value) => sum + value, 0) / values.length),
        peak: round2(Math.max(...values)),
        min: round2(Math.min(...values)),
        pidMedian: round2(median(windowSamples.map((sample) => sample.pidCount))),
        typeMedianMiB: medianByType(windowSamples)
      }
    }
    result.memory.phases = phases
    result.memory.samplerCostMedianMs = round2(median(mem.samplerCostMs))
    result.memory.samplerCostMaxMs = round2(mem.samplerCostMs.length ? Math.max(...mem.samplerCostMs) : null)
    return phases
  }
  const medianByType = (windowSamples) => {
    const types = new Set()
    for (const sample of windowSamples) for (const type of Object.keys(sample.byTypeMiB)) types.add(type)
    const out = {}
    for (const type of types) out[type] = round2(median(windowSamples.map((sample) => sample.byTypeMiB[type]).filter((value) => typeof value === 'number')))
    return out
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
    result.nativeFailureStates = {}
    for (const entry of entries) result.nativeFailureStates[entry.id] = await inspect(entry.id)
    await screenshot('failure')
    result.ok = false
    result.error = {
      message: error?.message || String(error),
      stack: String(error?.stack || '').split('\n').slice(0, 20).join('\n'),
      check: error?.check || null,
      detail: error?.detail || null,
      step,
      presentationDiagnostics: result.presentationDiagnostics || null,
      guestUrls: (() => { try { return guests().map((guest) => guest.getURL()) } catch { return [] } })(),
      virtualOffsetMs: virtualOffset,
      arm,
      round
    }
    summarizeMemory()
    mem.phase = 'stopped'
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

  // Current build: the panel is an <aside class="task-shelf"> that must report
  // aria-hidden="false" (not merely lack an inert flag) to be a real presentation frame.
  const panelOpen = () => js(`(() => {
    const shelf = document.querySelector('.task-shelf')
    if (!shelf) return false
    return shelf.getAttribute('aria-hidden') === 'false' && !shelf.hasAttribute('inert')
  })()`)
  const openShelfPanel = async () => {
    setStep('open-shelf')
    // React must be mounted after the renderer reload before the edge is clickable.
    await until(() => js("!!document.querySelector('.task-shelf-edge') && !!document.querySelector('.task-shelf')"), 'task shelf mounted', 30000)
    if (!(await panelOpen())) {
      await js(`(() => { const edge = document.querySelector('.task-shelf-edge'); if (!edge) return false; edge.click(); return true })()`)
    }
    await until(() => panelOpen(), 'shelf panel visible (aria-hidden=false)', 20000)
  }
  const closeShelfPanel = async () => {
    if (!(await panelOpen().catch(() => false))) return false
    await js(`(() => { const collapse = document.querySelector('.task-shelf-collapse'); if (!collapse) throw Error('Collapse action missing'); collapse.click(); return true })()`)
    await until(async () => !(await panelOpen().catch(() => true)), 'shelf panel hidden', 10000)
    return !(await panelOpen().catch(() => false))
  }

  // Semantic tabs: the current build labels them; the archived view is the one whose
  // label starts with "Archive" (falling back to the second tab).
  const archiveTabIndex = () => js(`(() => {
    const tabs = [...document.querySelectorAll('.task-shelf [role="tab"]')]
    const found = tabs.findIndex((tab) => (tab.textContent || '').trim().toLowerCase().startsWith('archive'))
    return found >= 0 ? found : (tabs.length > 1 ? 1 : -1)
  })()`)
  const showTab = async (index) => {
    await js(`(() => {
      const tabs = [...document.querySelectorAll('.task-shelf [role="tab"]')]
      const tab = tabs[${index}]
      if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click()
      return tabs.length
    })()`)
    await sleep(300)
  }
  const showArchiveTab = async () => {
    const index = await archiveTabIndex()
    if (index < 0) throw new Error('archive tab not found')
    await showTab(index)
    return index
  }

  // Activate every saved entry through the real Archive-tab action, then return to the
  // Tasks tab so cards expose their expand-to-main action. Used by probe and full runs.
  const activateAll = async () => {
    await openShelfPanel()
    await showArchiveTab()
    await until(() => js("!!document.querySelector('[aria-label=\"Activate all\"]:not(:disabled)')"), 'activate-all action ready', 20000)
    await js("(() => { const button = document.querySelector('[aria-label=\"Activate all\"]'); if (button && !button.disabled) { button.click(); return true } return false })()")
    await until(async () => {
      const current = await listShelf()
      if (current.entries.length !== TOTAL_ENTRIES || current.entries.some((entry) => !!entry.archivedAt)) return false
      return (await js("document.querySelectorAll('[data-shelf-card]').length")) === TOTAL_ENTRIES
    }, 'activate all entries', 30000)
    await showTab(0)
  }

  const recallAll = async (optional = false) => {
    const clicked = await js(`(() => {
      const button = document.querySelector('[aria-label="Recall all tasks"]')
      if (!button) return 'missing'
      if (button.disabled) return 'disabled'
      button.click()
      return 'clicked'
    })()`)
    if (clicked === 'clicked') return true
    if (optional) return false
    check('recall-all button enabled and clicked', clicked === 'clicked', { clicked })
    return false
  }

  const selectCard = async (id) => {
    await until(() => js(`(() => { const card = document.querySelector('[data-shelf-card="${id}"]'); return !!card && !card.disabled })()`), `card ${id} selectable`, 20000)
    await js(`(() => { const card = document.querySelector('[data-shelf-card="${id}"]'); card.click(); return true })()`)
    await sleep(350)
  }

  // Static policy lives in the options panel popover: toggle the panel, then fire a
  // bubbling change. "none" removes live shelf display demand so the page can idle.
  const setRealtime = async (mode) => {
    // React renders the options panel asynchronously: click the toggle, wait for the
    // select to exist, and only then set the value (a same-tick click+query is racy).
    const toggleState = await js(`(() => {
      if (document.querySelector('.task-shelf-options-panel select')) return 'open'
      const toggle = document.querySelector('.task-shelf-options-toggle')
      if (!toggle) return 'missing-toggle'
      toggle.click()
      return 'clicked'
    })()`)
    if (toggleState === 'missing-toggle') return false
    const present = await until(() => js("!!document.querySelector('.task-shelf-options-panel select')"), 'realtime select mounted', 8000).then(() => true).catch(() => false)
    if (!present) return false
    const changed = await js(`(() => {
      const select = document.querySelector('.task-shelf-options-panel select')
      if (!select) return 'missing-panel'
      select.value = ${JSON.stringify(mode)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return select.value
    })()`)
    if (changed !== mode) return false
    return until(() => js(`document.querySelector('.task-shelf-options-panel select')?.value === ${JSON.stringify(mode)}`), `realtime ${mode}`, 8000).then(() => true).catch(() => false)
  }

  // Renderer-side surface map: which shelf overlay wrapper is presented, and is it
  // interactive (the production input gate for ordinary pages)?
  const surfaceMap = () => js(`(() => {
    return [...document.querySelectorAll('[data-webtab-wrapper]')].map((wrapper) => {
      const view = wrapper.querySelector('webview')
      const rect = wrapper.getBoundingClientRect()
      return {
        id: wrapper.getAttribute('data-webtab-wrapper'),
        shelfNative: wrapper.getAttribute('data-shelf-native'),
        hasWebview: !!view,
        inert: wrapper.hasAttribute('inert') || !!view?.hasAttribute('inert'),
        x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)
      }
    })
  })()`)

  const gateFor = async (id) => {
    const rows = await surfaceMap().catch(() => [])
    const pick = rows.find((row) => row.id === `shelf-web-${id}`) || null
    const ok = !!pick && pick.hasWebview && !pick.inert && pick.w > 200 && pick.h > 100
    return { ok, pick, rows }
  }

  const waitPresented = async (id, timeout) => {
    let explicitFallback = false
    const entry = entries.find(item => item.id === id)
    return until(async () => {
      const reply = await inspect(id)
      if (!reply?.success || reply.state !== 'live') return false
      const owner = reply.presentationOwner
      if (owner !== 'main') return false
      const guest = guestFor(entry.url)
      if (!guest) return false
      const document = await guest.executeJavaScript('({title:document.title,ready:document.readyState})', false)
      if (document.title !== entry.title || document.ready !== 'complete') return false
      const gate = await gateFor(id)
      // 切换小窗/主区会推进 demandRevision，使 main 的旧几何回执失效。
      // 这里核对实际 webview 的输入闸门；不能把请求的 owner 或 wrapper 当成输入就绪。
      if (!gate.ok) {
        const hasFallback = await js(`(() => {const wrapper=document.querySelector('[data-webtab-wrapper="shelf-web-${id}"]');return [...wrapper?.querySelectorAll('button')??[]].some(button=>button.textContent==='Show current page')})()`)
        if (hasFallback && !explicitFallback) {
          explicitFallback = true
          await screenshot(`explicit-first-picture-${id}`)
          result.counts.explicitFirstPictureFallback = (result.counts.explicitFirstPictureFallback || 0) + 1
          result.notes.push(`Explicit Show current page after verified native URL/title: ${id} at ${nowMs()}ms`)
          await js(`(() => {const wrapper=document.querySelector('[data-webtab-wrapper="shelf-web-${id}"]');[...wrapper.querySelectorAll('button')].find(button=>button.textContent==='Show current page').click();return true})()`)
        }
        return false
      }
      return { owner, gate, nativePresentationReadyAtDemand: reply.presentationReady }
    }, `presented saved:${id}`, timeout)
  }

  // Ordinary-page presentation in the current build is a two-step real UI action:
  // click the saved card (opens its task window and selects it), then click the
  // "Expand to main workspace" action inside that entry, and wait for the native
  // presentationOwner === 'main'. No runtime-only mock and no hidden fallback.
  let presentationCandidate = null

  const ensureCard = async (id) => {
    const hasCard = () => js(`!!document.querySelector('[data-shelf-card="${id}"]')`)
    if (await hasCard()) return
    await openShelfPanel()
    await showArchiveTab()
    await until(() => js("!!document.querySelector('[aria-label=\"Activate all\"]:not(:disabled)')"), 'archive activate-all ready', 20000)
    await js("(() => { const b = document.querySelector('[aria-label=\"Activate all\"]'); if (b && !b.disabled) { b.click(); return true } return false })()")
    await until(hasCard, `card ${id} mounted`, 20000)
  }

  const clickMainButton = async (id) => {
    await until(() => js(`(() => { const b = document.querySelector('[data-shelf-entry="${id}"] .task-shelf-main-button'); return !!b && !b.disabled })()`), `expand-to-main action for ${id}`, 15000)
    await js(`(() => { const b = document.querySelector('[data-shelf-entry="${id}"] .task-shelf-main-button'); b.click(); return true })()`)
  }

  const diagnostics = async () => {
    const dom = await js(`(() => {
      const shelf = document.querySelector('.task-shelf')
      const select = document.querySelector('.task-shelf-options-panel select')
      const wrappers = [...document.querySelectorAll('[data-webtab-wrapper]')].map((wrapper) => ({
        id: wrapper.getAttribute('data-webtab-wrapper'),
        hasWebview: !!wrapper.querySelector('webview'),
        inert: wrapper.hasAttribute('inert'),
        h: Math.round(wrapper.getBoundingClientRect().height)
      }))
      return {
        shelfPresent: !!shelf,
        shelfAriaHidden: shelf ? shelf.getAttribute('aria-hidden') : null,
        shelfClasses: shelf ? shelf.className : null,
        tabs: [...document.querySelectorAll('.task-shelf [role="tab"]')].map((tab) => ({ text: tab.textContent, selected: tab.getAttribute('aria-selected') })),
        cards: document.querySelectorAll('[data-shelf-card]').length,
        entryButtons: [...document.querySelectorAll('[data-shelf-entry]')].map((row) => ({
          id: row.getAttribute('data-shelf-entry'),
          actions: [...row.querySelectorAll('button')].map((button) => ({ text: (button.textContent || '').slice(0, 60), label: button.getAttribute('aria-label'), disabled: button.disabled }))
        })),
        ariaLabels: [...document.querySelectorAll('.task-shelf [aria-label]')].map((node) => node.getAttribute('aria-label')),
        policyValue: select ? select.value : null,
        wrappers
      }
    })()`).catch((error) => ({ error: error.message }))
    const inspects = {}
    for (const entry of entries) inspects[entry.id] = await inspect(entry.id)
    return { dom, inspects, attempts: result.failureAttempts.slice(-6) }
  }

  const presentEntry = async (entry, options = {}) => {
    const timeout = options.timeout || 20000
    const start = realNow()
    const attempts = []
    await openShelfPanel()
    const candidate = presentationCandidate || 'main-button'
    try {
      await ensureCard(entry.id)
      await selectCard(entry.id)
      await clickMainButton(entry.id)
      const info = await waitPresented(entry.id, timeout)
      const presented = await waitPresented(entry.id, 5000)
      if (!presentationCandidate) {
        presentationCandidate = candidate
        result.counts.presentationPath = candidate
        result.notes.push(`presentation path resolved: ${candidate} (owner ${presented.owner})`)
      }
      result.counts['presentation_' + candidate] = (result.counts['presentation_' + candidate] || 0) + 1
      result.counts['presentationOwner_' + (presented.owner || 'unknown')] = (result.counts['presentationOwner_' + (presented.owner || 'unknown')] || 0) + 1
      const policy = await setRealtime('none')
      if (!policy) throw new Error(`static demand withdrawal could not be verified (realtime select did not settle to none)`)
      result.counts.staticPolicySet = (result.counts.staticPolicySet || 0) + 1
      return { ...info, ...presented, candidate, latencyMs: Math.round(realNow() - start) }
    } catch (error) {
      attempts.push({ candidate, message: error.message })
      result.failureAttempts.push({ entry: entry.id, candidate, message: error.message, at: nowMs() })
    }
    result.presentationDiagnostics = await diagnostics()
    await screenshot(`presentation-failed-${entry.id}`)
    const error = new Error(`no ordinary-page presentation for saved:${entry.id} (${JSON.stringify(attempts)})`)
    error.check = 'ordinary page presentation reached'
    error.detail = { attempts, diagnostics: result.presentationDiagnostics }
    throw error
  }

  const releasePresentations = async (ids, label) => {
    await recallAll(true)
    await closeShelfPanel()
    await until(async () => {
      for (const id of ids) {
        const reply = await inspect(id)
        if (!reply?.success) return false
        const owner = reply.presentationOwner
        if (owner && owner !== 'none') return false
      }
      return true
    }, label || 'all presentations released', 30000)
    // 等 React/布局交接后的需求版本稳定，再推进测试时钟；迟到的展示需求必须重新计时。
    await until(async () => {
      const before = await Promise.all(ids.map(id => inspect(id)))
      if (before.some(reply => !reply?.success || reply.presentationOwner !== 'none')) return false
      await sleep(300)
      const after = await Promise.all(ids.map(id => inspect(id)))
      return after.every((reply, index) => reply?.success && reply.presentationOwner === 'none' && reply.token?.demandRevision === before[index].token?.demandRevision)
    }, 'no-demand revisions stable after UI handoff', 10000)
  }

  // Guard prerequisite: navigator.userActivation.hasBeenActive must be true before a
  // candidate may sleep. A hidden window cannot gain hardware activation, so the
  // fixture seeds it with a test-scoped userGesture executeJavaScript and then VERIFIES
  // the sticky flag; the mechanism is labelled synthetic userGesture (not hardware
  // input). If the synthetic gesture alone cannot latch it, one trusted input event is
  // tried next and the working mechanism is recorded; neither working is a hard failure.
  // Sticky user activation prerequisite. The *read* must never use executeJavaScript's
  // userGesture flag (that would create the very activation it reports); only the explicit
  // synthetic activation call passes true, and every synthetic path is labelled as such.
  const ensureActivation = async (guest, entry) => {
    const read = () => guest.executeJavaScript('navigator.userActivation.hasBeenActive === true', false)
    if (await read()) return { synthetic: false, mechanism: 'already-active', source: 'observed' }
    await guest.executeJavaScript('void 0', true)
    await sleep(120)
    if (await read()) {
      result.counts.syntheticGestures = (result.counts.syntheticGestures || 0) + 1
      return { synthetic: true, mechanism: 'executeJavaScript-userGesture', source: 'fixture-synthetic' }
    }
    guest.sendInputEvent({ type: 'mouseDown', x: 120, y: 160, button: 'left', clickCount: 1 })
    guest.sendInputEvent({ type: 'mouseUp', x: 120, y: 160, button: 'left', clickCount: 1 })
    await until(read, `user activation for ${entry.id}`, 8000)
    result.counts.trustedActivationEvents = (result.counts.trustedActivationEvents || 0) + 1
    return { synthetic: true, mechanism: 'guest-sendInputEvent-software', source: 'fixture-software-input' }
  }

  const readingProbe = (guest) => guest.executeJavaScript(`(() => ({
    title: document.title,
    scriptRan: window.__scriptRan === true,
    index: typeof window.__readingIndex === 'number' ? window.__readingIndex : null,
    proof: document.getElementById('js-proof')?.textContent || null,
    auth: document.getElementById('auth')?.textContent || null,
    authState: document.getElementById('auth')?.getAttribute('data-state') || null,
    cookiePresent: window.__cookiePresent === true,
    authVisible: window.__authVisible === true,
    ready: document.readyState,
    scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
    scrollY: window.scrollY,
    zoom: null
  }))()`, true)

  const verifyReading = async (entry, guest, label) => {
    const probe = await until(async () => {
      const value = await readingProbe(guest)
      return value.scriptRan && value.proof === 'js-ok' && value.ready === 'complete' ? value : false
    }, `${label} reading content ready`, 20000)
    const zoom = guest.getZoomFactor()
    probe.zoom = zoom
    const ok = probe.title === entry.title &&
      probe.scriptRan === true &&
      probe.proof === 'js-ok' &&
      probe.auth === 'signed-in' &&
      probe.cookiePresent === true &&
      probe.scrollHeight > 2000
    if (!ok) {
      const error = new Error(`${label} ordinary content mismatch :: ${JSON.stringify(probe)}`)
      error.check = `${label} ordinary content`
      error.detail = probe
      throw error
    }
    result.counts.sessionProofs = (result.counts.sessionProofs || 0) + 1
    return probe
  }

  const setRestoreState = async (guest, index, label) => {
    const zoomTarget = ZOOM_CYCLE[index % ZOOM_CYCLE.length]
    guest.setZoomFactor(zoomTarget)
    await sleep(200)
    const zoom = guest.getZoomFactor()
    const targetY = 640 + ((index * 233) % 2400)
    await guest.executeJavaScript(`window.scrollTo(0, ${targetY}); true`, true)
    await sleep(250)
    const y = await guest.executeJavaScript('window.scrollY', true)
    if (!(y > 50)) throw new Error(`${label} restitution scroll failed :: y=${y}`)
    return { zoom, zoomTarget, scrollY: y }
  }

  // Latency: trusted native wheel input, observed through a page scroll listener that
  // only latches a REAL movement (observation polling overhead included and reported).
  const measureWheel = async (entry, guest, gate) => {
    const overallStartedAt = realNow()
    if (!gate?.pick) throw new Error(`no presented surface rect for ${entry.id}`)
    const rect = gate.pick
    // The wheel test only needs a trustworthy scrollable position; restored scroll
    // was already verified above, and the sleep snapshot is rewritten afterwards.
    const currentY = await guest.executeJavaScript('window.scrollY', true)
    if (!(currentY > 60 && currentY < 1500)) {
      await guest.executeJavaScript('window.scrollTo(0, 500); true', true)
      await sleep(200)
    }
    const installProbe = () => guest.executeJavaScript(`(() => {
      window.__wheelProbe = null
      window.__wheelStart = window.scrollY
      if (!window.__wheelListener) {
        window.__wheelListener = true
        window.addEventListener('scroll', function () {
          if (window.__wheelProbe === null && Math.abs(window.scrollY - window.__wheelStart) > 2) {
            window.__wheelProbe = { y: window.scrollY, at: performance.now() }
          }
        }, { passive: true })
      }
      return true
    })()`, true)
    const waitMoved = (ms) => until(async () => {
      const value = await guest.executeJavaScript('window.__wheelProbe', true)
      return value && Number.isFinite(value.y) ? value : false
    }, `wheel scroll observed ${entry.id}`, ms, 25)
    // One attempt = install probe -> read start -> send trusted wheel -> observe a REAL
    // movement. Latency is measured per successful attempt only, so a failed probe
    // attempt can never inflate the reported number.
    const attempt = async (label, ms, send) => {
      await installProbe()
      const startY = await guest.executeJavaScript('window.scrollY', true)
      const startedAt = realNow()
      send()
      const observed = await waitMoved(ms).catch(() => null)
      if (!observed) return null
      const latencyMs = Math.round((realNow() - startedAt) * 10) / 10
      return { latencyMs, observer: label, startY, endY: observed.y, at: observed.at }
    }

    const tried = []
    let wheel = await attempt('main-window-input', 1500, () => {
      main.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: Math.round(rect.x + Math.min(rect.w / 2, 300)),
        y: Math.round(rect.y + Math.min(rect.h / 2, 240)),
        deltaX: 0,
        deltaY: 240,
        canScroll: true
      })
    })
    tried.push('main-window-input')
    if (!wheel) {
      // Bounded fallback: webContents-level trusted wheel delivered straight to the page
      // (still a native input event, still not an OS hardware event). Labelled.
      wheel = await attempt('guest-input-event-fallback', 2500, () => {
        guest.sendInputEvent({ type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: 240, canScroll: true })
        setTimeout(() => { try { guest.sendInputEvent({ type: 'mouseWheel', x: 220, y: 320, deltaX: 0, deltaY: 120, canScroll: true }) } catch { /* ignore */ } }, 40)
      })
      tried.push('guest-input-event-fallback')
    }
    if (!wheel) {
      // Last bounded attempt from a mid-document position (a page pinned at a limit
      // cannot prove wheel->scroll latency).
      await guest.executeJavaScript('window.scrollTo(0, 300); true', true)
      await sleep(150)
      wheel = await attempt('guest-input-event-fallback-retry', 2500, () => {
        guest.sendInputEvent({ type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: 240, canScroll: true })
      })
      tried.push('guest-input-event-fallback-retry')
    }
    if (!wheel) throw new Error(`wheel did not scroll ${entry.id} after bounded attempts ${JSON.stringify(tried)}`)
    if (Math.abs(wheel.endY - wheel.startY) <= 2) throw new Error(`wheel scroll did not move ${entry.id} :: ${JSON.stringify(wheel)}`)
    result.counts.wheelObserver = result.counts.wheelObserver || {}
    result.counts.wheelObserver[wheel.observer] = (result.counts.wheelObserver[wheel.observer] || 0) + 1
    wheel.attemptLatencyMs = wheel.latencyMs
    wheel.latencyMs = Math.round((realNow() - overallStartedAt) * 10) / 10
    wheel.attempts = tried
    return wheel
  }

  const reloadGuest = async (guest, expectedTitle) => {
    const loaded = new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        guest.off('did-finish-load', onLoad)
        guest.off('did-fail-load', onFail)
      }
      const timer = setTimeout(() => { if (!settled) { settled = true; cleanup(); reject(new Error('guest reload timeout')) } }, 20000)
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
    await until(async () => (await guest.executeJavaScript('document.title', true)) === expectedTitle, `reload title ${expectedTitle}`, 15000)
  }

  const readShelfJson = () => {
    const file = path.join(configDir, 'task-shelf.json')
    return { file, json: JSON.parse(fs.readFileSync(file, 'utf8')) }
  }
  const jsonEntry = (json, id) => (json.entries || []).find((entry) => entry.id === id) || null

  const sleepMeta = (id) => {
    const entry = jsonEntry(readShelfJson().json, id)
    // v1 持久化把休眠元数据写在 recovery.sleep 下（旧实现曾读取 entry.sleep）。
    const sleep = entry?.recovery?.sleep || entry?.sleep || null
    return sleep ? {
      formatVersion: sleep.formatVersion,
      partition: sleep.partition,
      suspendOperationId: sleep.suspendOperationId,
      url: sleep.url,
      method: sleep.method,
      zoom: sleep.zoom,
      scrollY: sleep.scrollY,
      taskId: sleep.taskId,
      resourceId: sleep.resourceId,
      recordedAt: sleep.recordedAt,
      recoveryKind: entry?.recovery?.kind || null,
      reloadableMode: entry?.recovery?.reloadableMode === true
    } : null
  }

  const waitState = (id, state, timeout = 30000) => until(async () => {
    const reply = await inspect(id)
    return reply?.success && reply.state === state ? reply : false
  }, `saved:${id} state=${state}`, timeout)

  /* ------------------------------------------------------------------ */
  /* Seeding                                                            */
  /* ------------------------------------------------------------------ */

  result.entries = entries.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, url: entry.url }))

  /* ------------------------------------------------------------------ */
  /* Flow                                                               */
  /* ------------------------------------------------------------------ */

  const run = async () => {
    await setupRenderer()
    // Deterministic shelf view: wide enough for previews (>=360) and pinned right.
    setStep('view-prefs')
    await js(`(() => {
      localStorage.setItem('lyshell.taskShelf.view.v1', JSON.stringify({ mode: 'fixed', width: 620, height: 420, edge: 'right' }))
      localStorage.setItem('lyshell.taskShelf.realtime.v1', 'tasks')
      return true
    })()`)
    await js('setTimeout(function () { location.reload() }, 0); true').catch(() => {})
    await sleep(1500)
    await setupRenderer()
    const list = await waitListReady()
    check('12 seeded entries loaded', list.entries?.length === TOTAL_ENTRIES, { count: list.entries?.length })
    check('entries archived at first boot', list.entries.every((entry) => !!entry.archivedAt))
    check('no native guests before activation', guests().length === 0, { guests: guests().length })
    check('arm environment contract', arm === 'after'
      ? process.env.LYSHELL_SHELF_RELOADABLE_SLEEP !== '0'
      : process.env.LYSHELL_SHELF_RELOADABLE_SLEEP === '0', { arm, env: result.env })

    const seededConsent = {}
    for (const entry of entries) seededConsent[entry.id] = entry.consent
    result.counts.seededConsent = seededConsent

    if (probeChild) {
      // Pre-flight: exercise one full cycle (present -> content -> activation -> wheel ->
      // reload -> restore state -> release -> idle sleep) without writing docs results.
      setStep('probe')
      await activateAll()
      const first = entries[0]
      const presented = await presentEntry(first, { timeout: 20000 })
      // Guest arrival is asynchronous in this build: record a bounded timeline instead of
      // assuming the webview is already navigated when the overlay is committed.
      const timeline = []
      let guest = guestFor(first.url)
      for (let attempt = 0; attempt < 40 && !guest; attempt += 1) {
        const reply = await inspect(first.id)
        timeline.push({
          ms: attempt * 500,
          guests: guests().map((item) => { try { return item.getURL() } catch { return '<destroyed>' } }),
          state: reply?.state || null,
          owner: reply?.presentationOwner || null,
          restore: reply?.restoreStatus || null,
          gate: (await gateFor(first.id).catch(() => null))?.ok ?? null
        })
        await sleep(500)
        guest = guestFor(first.url)
      }
      if (!guest) {
        result.counts.probePresentation = { candidate: presented.candidate, owner: presented.owner, timeline, presentationDiagnostics: await diagnostics() }
        await screenshot('probe-no-guest')
        result.ok = false
        result.error = { message: 'probe: no native guest after presentation (see timeline)', step: 'probe', presented }
        writeResult()
        app.exit(1)
        return
      }
      result.counts.probeGuestTimeline = timeline
      if (!guest) throw new Error('probe: no native guest')
      const probe = await verifyReading(first, guest, 'probe content')
      const activation = await ensureActivation(guest, first)
      const gate = await gateFor(first.id)
      if (!gate.ok) throw new Error(`probe: input gate not ready ${JSON.stringify(gate.pick)}`)
      const wheel = await measureWheel(first, guest, gate)
      await reloadGuest(guest, first.title)
      const afterReload = await verifyReading(first, guest, 'probe reload')
      const reloadActivation = await ensureActivation(guest, first)
      const state = await setRestoreState(guest, 0, first.id)
      await releasePresentations([first.id], 'probe presentation released')
      advance()
      // after arm: the release + idle window must put the page to sleep.
      // before arm: LYSHELL_SHELF_RELOADABLE_SLEEP=0, so the same sequence must leave it live.
      const expectSleep = arm === 'after'
      const settled = await waitState(first.id, expectSleep ? 'sleeping' : 'live', 45000).catch(() => null)
      result.presentationDiagnostics = await diagnostics()
      result.counts.probePresentation = {
        candidate: presented.candidate,
        owner: presented.owner,
        guest: true,
        arm,
        expectSleep,
        probe,
        afterReload,
        activation,
        reloadActivation,
        wheel,
        state,
        slept: settled?.state === 'sleeping',
        sleepState: settled?.state || null,
        guests: guests().length,
        meta: sleepMeta(first.id)
      }
      const probeOk = expectSleep ? settled?.state === 'sleeping' && guests().length === 0 : settled?.state === 'live' && guests().length === 1
      result.ok = probeOk
      result.finishedAt = new Date(realNow()).toISOString()
      writeResult()
      app.exit(probeOk ? 0 : 1)
      return
    }

    setStep('activate')
    await activateAll()

    setStep('open-all')
    markPhase('boot')
    await sleep(1200)
    let openIndex = 0
    for (const entry of entries) {
      const presented = await presentEntry(entry)
      const guest = guestFor(entry.url)
      if (!guest) throw new Error(`no native guest after presenting ${entry.id}`)
      check(`${entry.id} presented in main or shelf surface`, !!presented.owner && presented.gate.ok, { owner: presented.owner, gate: presented.gate.pick })
      const activation = await ensureActivation(guest, entry)
      if (entry.kind === 'reading') {
        const probe = await verifyReading(entry, guest, entry.id)
        entry.probe = probe
        check(`${entry.id} ordinary JavaScript ran`, probe.scriptRan === true && probe.proof === 'js-ok')
        check(`${entry.id} session cookie login proof`, probe.auth === 'signed-in' && probe.cookiePresent === true, { auth: probe.auth, cookiePresent: probe.cookiePresent })
        const state = await setRestoreState(guest, openIndex, entry.id)
        check(`${entry.id} zoom applied`, Math.abs(state.zoom - state.zoomTarget) < 0.02, state)
        check(`${entry.id} scroll applied`, state.scrollY > 50, state)
        entry.expected = state
      } else if (entry.kind === 'protected') {
        const probe = await until(async () => {
          const value = await guest.executeJavaScript(`({
            title: document.title,
            protected: window.__protected === true,
            beforeunload: typeof window.onbeforeunload === 'function',
            guard: document.body?.dataset?.departureGuard || null,
            draft: window.__draftToken || null,
            bodyDraft: document.body?.dataset?.draft || null,
            marker: document.getElementById('marker')?.textContent || null
          })`, true)
          return value.protected ? value : false
        }, 'protected script ran', 20000)
        check('protected title', probe.title === 'Protected unsaved page', { title: probe.title })
        check('protected beforeunload armed', probe.beforeunload === true)
        check('protected departure guard armed', probe.guard === 'armed', { guard: probe.guard })
        check('protected unsaved draft present', !!probe.draft && probe.draft === probe.bodyDraft, { draft: probe.draft, bodyDraft: probe.bodyDraft })
        check('protected marker present', !!probe.marker, { marker: probe.marker })
        entry.probe = probe
      } else {
        const probe = await until(async () => {
          const value = await guest.executeJavaScript(`({
            title: document.title,
            unknown: window.__unknown === true,
            token: window.__unknownToken || null,
            marker: document.getElementById('marker')?.textContent || null
          })`, true)
          return value.unknown ? value : false
        }, 'unknown script ran', 20000)
        check('unknown title', probe.title === 'Unknown page', { title: probe.title })
        check('unknown marker', probe.marker === 'unknown-live-ok', { marker: probe.marker })
        entry.probe = probe
      }
      entry.openedAt = nowMs()
      entry.activationSynthetic = activation.synthetic
      openIndex += 1
    }

    const allUrls = guests().map((guest) => { try { return guest.getURL() } catch { return null } })
    check('12 native guests retained', guests().length === TOTAL_ENTRIES, { guests: guests().length })
    check('no duplicate guests', new Set(allUrls).size === allUrls.length, { urls: allUrls })
    check('all guests on the ordinary webbar partition', guests().every((guest) => {
      try { return guest.session === session.fromPartition(WEBBAR_PARTITION) } catch { return false }
    }))
    check('consent seeded only for reading/protected URLs', entries.filter((entry) => entry.consent).length === READING_COUNT + 1)

    markPhase('loaded')
    await sleep(3000)

    const readingEntries = entries.filter((entry) => entry.kind === 'reading')
    const allIds = entries.map((entry) => entry.id)

    setStep('initial-release')
    markPhase('transition')
    await releasePresentations(allIds, 'all presentations released before idle')
    advance()
    await sleep(2500)

    if (arm === 'after') {
      setStep('initial-sleep')
      const sleepingStates = await until(async () => {
        const states = []
        for (const entry of readingEntries) {
          const reply = await inspect(entry.id)
          states.push(reply?.success ? reply.state : `error:${reply?.error || '?'}`)
        }
        return states.every((state) => state === 'sleeping') ? states : false
      }, '10 reading entries sleeping', 45000)
      result.counts.initialSleepStates = sleepingStates
      await until(() => guestCountFor(entries[0].url) === 0, 'reading guests destroyed', 20000)
      result.counts.initialGuests = guests().length
      check('after initial sleep: 12 readonly-free candidates destroyed, 2 pages live', guests().length === 2, { guests: guests().length, urls: guests().map((guest) => guest.getURL()) })
      for (const entry of entries) {
        const meta = sleepMeta(entry.id)
        if (entry.kind === 'reading') {
          check(`${entry.id} sleep metadata committed`, !!meta, { meta })
          check(`${entry.id} sleep metadata contract`, meta.formatVersion === 1 && meta.partition === WEBBAR_PARTITION && typeof meta.suspendOperationId === 'string' && meta.url === entry.url && meta.taskId === entry.id && Number.isFinite(meta.zoom) && Number.isFinite(meta.scrollY) && meta.zoom > 0 && meta.scrollY > 50, meta)
          check(`${entry.id} recovery keeps web+reloadable identity`, meta.recoveryKind === 'web' && meta.reloadableMode === true, { recoveryKind: meta.recoveryKind, reloadableMode: meta.reloadableMode })
          check(`${entry.id} sleep metadata has no query/hash`, !/[?#]/.test(String(meta.url || '')), { url: meta.url })
          check(`${entry.id} sleep metadata keeps zoom`, Math.abs(meta.zoom - entry.expected.zoom) < 0.02, { metaZoom: meta.zoom, expected: entry.expected.zoom })
          check(`${entry.id} sleep metadata keeps scroll`, Math.abs(meta.scrollY - entry.expected.scrollY) <= 6, { metaScroll: meta.scrollY, expected: entry.expected.scrollY })
        } else if (entry.kind === 'protected') {
          // Saved snapshot may exist even though the native close was refused.
          entry.protectedSnapshot = meta
          entry.protectedState = (await inspect(entry.id))?.state || null
          check('protected close refused natively', (result.counts.willPreventUnload || 0) >= 1 && observedUnloadPrevented.some((item) => String(item.url || '') === entry.url), { willPreventUnload: result.counts.willPreventUnload || 0, observed: observedUnloadPrevented })
          check('protected page is NOT classified as sleeping', entry.protectedState === 'live', { state: entry.protectedState })
          check('protected guest still alive after refusal', !!guestFor(entry.url))
          const alive = await guestFor(entry.url).executeJavaScript(`({ draft: window.__draftToken, bodyDraft: document.body?.dataset?.draft, marker: document.getElementById('marker')?.textContent, title: document.title })`, true)
          check('protected draft/marker unchanged after refusal', alive.draft === entry.probe.draft && alive.bodyDraft === entry.probe.draft && alive.marker === entry.probe.marker, { before: { draft: entry.probe.draft, marker: entry.probe.marker }, after: alive })
          entry.protectedSnapshotClassification = meta ? 'snapshot-saved-close-refused' : 'snapshot-rolled-back-close-refused'
          result.counts.protectedSnapshotClassification = entry.protectedSnapshotClassification
        } else {
          check('unknown page has no reloadable consent', !meta, { meta })
          check('unknown page remains live', (await inspect(entry.id))?.state === 'live' && !!guestFor(entry.url))
        }
      }
      markPhase('sleep')
      await sleep(3000)
    } else {
      setStep('initial-stay-live')
      await sleep(3000)
      const states = []
      for (const entry of entries) {
        const reply = await inspect(entry.id)
        states.push(reply?.success ? reply.state : `error:${reply?.error || '?'}`)
      }
      result.counts.initialStayLiveStates = states
      check('before arm: sleep path disabled keeps all 12 pages live', states.every((state) => state === 'live'), { states })
      check('before arm: 12 guests retained without reloadable sleep', guests().length === TOTAL_ENTRIES, { guests: guests().length })
      markPhase('sleep')
      await sleep(3000)
    }

    setStep('cycles')
    markPhase('cycles')
    for (let index = 0; index < cycles; index += 1) {
      const entry = readingEntries[index % readingEntries.length]
      const cycleStart = realNow()

      if (arm === 'after') {
        await waitState(entry.id, 'sleeping', 30000)
        const preMeta = sleepMeta(entry.id)
        if (!preMeta) throw new Error(`no sleep metadata before wake ${entry.id}`)
        entry.preWakeMeta = preMeta
      }

      const presented = await presentEntry(entry, { timeout: 20000 })
      const guest = guestFor(entry.url)
      if (!guest) throw new Error(`no native guest for ${entry.id} in cycle ${index}`)
      const navigationStarted = realNow()
      // 每组每循环恰好一次 GET 导航：before 重载活页，after 已从睡眠重新创建/加载。
      if (arm === 'before') await reloadGuest(guest, entry.title)
      const navigationMs = realNow() - navigationStarted
      const probe = await verifyReading(entry, guest, `${entry.id} cycle ${index}`)
      const activation = await ensureActivation(guest, entry)

      let restored = null
      if (arm === 'after') {
        const meta = entry.preWakeMeta
        // Hard acceptance: the restored view must match the saved contract (zoom <= 0.05,
        // scroll <= 6px) within a bounded settle window, before any test input is sent.
        const settled = await until(async () => {
          const zoom = guest.getZoomFactor()
          const scrollY = await guest.executeJavaScript('window.scrollY', false)
          return Math.abs(zoom - meta.zoom) <= 0.05 && Math.abs(scrollY - meta.scrollY) <= 6 ? { zoom, scrollY } : false
        }, `restored view for ${entry.id}`, 4000).catch(() => null)
        restored = settled || {
          zoom: guest.getZoomFactor(),
          scrollY: await guest.executeJavaScript('window.scrollY', false)
        }
        if (!(restored.zoom > 0)) throw new Error(`restored zoom not positive ${entry.id} :: ${restored.zoom}`)
        if (!(restored.scrollY > 50)) throw new Error(`restored scroll not nonzero ${entry.id} :: ${restored.scrollY}`)
        restored.zoomDelta = Math.round((restored.zoom - meta.zoom) * 1000) / 1000
        restored.scrollDelta = Math.round(restored.scrollY - meta.scrollY)
        restored.settled = !!settled
        check(`cycle ${index} restored zoom matches saved zoom ${entry.id}`, Math.abs(restored.zoomDelta) <= 0.05, { zoom: restored.zoom, metaZoom: meta.zoom, delta: restored.zoomDelta, settled: restored.settled })
        check(`cycle ${index} restored scroll matches saved scroll ${entry.id}`, Math.abs(restored.scrollDelta) <= 6, { scrollY: restored.scrollY, metaScrollY: meta.scrollY, delta: restored.scrollDelta, settled: restored.settled })
      }
      const readyMs = Math.round(realNow() - cycleStart)

      const gate = await gateFor(entry.id)
      if (!gate.ok) throw new Error(`input gate not ready ${entry.id} :: ${JSON.stringify(gate.pick)}`)
      const wheel = await measureWheel(entry, guest, gate)

      const afterReload = probe
      const reloadActivation = await ensureActivation(guest, entry)
      const state = await setRestoreState(guest, index, entry.id)

      const record = {
        index,
        entry: entry.id,
        arm,
        readyMs,
        navigationMs,
        navigationKind: arm === 'before' ? 'reload' : 'restore',
        wheelMs: wheel.latencyMs,
        wheelObserver: wheel.observer,
        wheelStartY: wheel.startY,
        wheelEndY: wheel.endY,
        contentVerified: true,
        scriptRan: probe.scriptRan,
        auth: probe.auth,
        restored,
        reload: { title: afterReload.title, scriptRan: afterReload.scriptRan, auth: afterReload.auth },
        zoom: state.zoom,
        scrollY: state.scrollY,
        activationSynthetic: activation.synthetic || reloadActivation.synthetic,
        presentation: presented.candidate,
        presentationOwner: presented.owner,
        at: nowMs()
      }
      result.cyclesLog.push(record)
      result.latency.push({ round, cycle: index, entry: entry.id, arm, readyMs, wheelMs: wheel.latencyMs, wheelObserver: wheel.observer, presentation: presented.candidate })

      setStep(`cycle-${index}-release`)
      await releasePresentations(allIds, `cycle ${index} presentations released`)
      advance()

      if (arm === 'after') {
        const stateAfter = await waitState(entry.id, 'sleeping', 30000)
        if (!stateAfter) throw new Error(`candidate did not sleep again ${entry.id}`)
        await until(() => guestCountFor(entry.url) === 0, `cycle ${index} guest destroyed`, 20000)
        const meta = sleepMeta(entry.id)
        if (!meta) throw new Error(`cycle ${index} missing rewritten sleep metadata ${entry.id}`)
        record.sleepRewrite = { suspendOperationId: meta.suspendOperationId, zoom: meta.zoom, scrollY: meta.scrollY, revision: stateAfter.revision }
        if (meta.suspendOperationId === entry.preWakeMeta.suspendOperationId) throw new Error(`cycle ${index} suspend operation id not rewritten ${entry.id}`)
        const liveReadings = guests().filter((item) => readingEntries.some((reading) => reading.url === item.getURL()))
        if (liveReadings.length !== 0) throw new Error(`cycle ${index} live reading guests after sleep: ${liveReadings.length}`)
        if (guests().length !== 2) throw new Error(`cycle ${index} expected 2 live pages, got ${guests().length}`)
        record.sleepConfirmed = true
      } else {
        const reply = await inspect(entry.id)
        if (!reply?.success || reply.state !== 'live') throw new Error(`cycle ${index} before arm page not live: ${JSON.stringify(reply)}`)
        if (guests().length !== TOTAL_ENTRIES) throw new Error(`cycle ${index} before arm guest count ${guests().length}`)
        record.stayLive = true
      }
      await sleep(400)
      console.log(`[cycle] ${arm}#${round} ${index + 1}/${cycles} ${entry.id} done`)
    }
    result.counts.cycles = cycles
    result.counts.restoreCycles = arm === 'after' ? cycles : 0
    result.counts.reloadCycles = arm === 'before' ? cycles : 0

    // Final steady state
    setStep('final')
    markPhase('final')
    if (arm === 'after') {
      const sleepingNow = []
      for (const entry of readingEntries) {
        const reply = await inspect(entry.id)
        sleepingNow.push(reply?.state || 'error')
      }
      check('final: 10 reading pages sleeping', sleepingNow.every((state) => state === 'sleeping'), { sleepingNow })
      check('final: 2 live pages (protected + unknown)', guests().length === 2, { guests: guests().length, urls: guests().map((guest) => guest.getURL()) })
      for (const entry of entries) {
        const reply = await inspect(entry.id)
        if (entry.kind !== 'reading') check(`final: ${entry.id} stays live`, reply?.state === 'live', { state: reply?.state })
      }
      const finalShelf = await listShelf()
      check('final: shelf keeps 12 entries', finalShelf.entries.length === TOTAL_ENTRIES)
      check('final: shelf entries keep their titles', finalShelf.entries.every((entry) => !!entry.title))
      const json = readShelfJson().json
      const operations = new Set()
      for (const entry of readingEntries) {
        const meta = sleepMeta(entry.id)
        if (!meta) throw new Error(`final: missing snapshot for ${entry.id}`)
        operations.add(meta.suspendOperationId)
        if (meta.formatVersion !== 1 || meta.partition !== WEBBAR_PARTITION || !meta.url || /[?#]/.test(meta.url)) {
          throw new Error(`final: bad snapshot contract ${entry.id} :: ${JSON.stringify(meta)}`)
        }
      }
      check('final: 10 distinct sleep transactions', operations.size === READING_COUNT, { operations: operations.size })
      check('final: task-shelf document keeps 12 entries', (json.entries || []).length === TOTAL_ENTRIES)
      const protectedMeta = sleepMeta('protected')
      result.counts.finalProtectedSnapshot = !!protectedMeta
      if (protectedMeta) result.counts.protectedSnapshotClassification = 'snapshot-saved-close-refused'
      const protectedGuest = guestFor(entries.find((entry) => entry.id === 'protected').url)
      check('final: protected page still live with draft', !!protectedGuest)
      const alive = await protectedGuest.executeJavaScript(`({ draft: window.__draftToken, marker: document.getElementById('marker')?.textContent })`, true)
      check('final: protected draft retained across the whole run', alive.draft === entries.find((entry) => entry.id === 'protected').probe.draft && !!alive.marker)
      const unknownGuest = guestFor(entries.find((entry) => entry.id === 'unknown').url)
      check('final: unknown page still live', !!unknownGuest)
      result.counts.finalGuests = guests().length
    } else {
      const states = []
      for (const entry of entries) {
        const reply = await inspect(entry.id)
        states.push(reply?.state || 'error')
      }
      check('before final: all 12 pages still live', states.every((state) => state === 'live'), { states })
      check('before final: 12 guests retained', guests().length === TOTAL_ENTRIES, { guests: guests().length })
      check('before final: no sleep metadata written', !sleepMeta('reading-1'), { meta: sleepMeta('reading-1') })
      result.counts.finalGuests = guests().length
    }
    await sleep(3000)

    setStep('counts')
    check('native attach count', arm === 'after' ? (result.counts.nativeAttaches || 0) === TOTAL_ENTRIES + cycles : (result.counts.nativeAttaches || 0) === TOTAL_ENTRIES, { attaches: result.counts.nativeAttaches, destroys: result.counts.nativeDestroyed })
    if (arm === 'after') {
      check('native destroy count', (result.counts.nativeDestroyed || 0) === (TOTAL_ENTRIES - 2) + cycles, { destroys: result.counts.nativeDestroyed })
      check('native close refusal observed at least once', (result.counts.willPreventUnload || 0) >= 1, { willPreventUnload: result.counts.willPreventUnload })
    } else {
      check('before arm: no reloadable close attempted', (result.counts.nativeDestroyed || 0) === 0, { destroys: result.counts.nativeDestroyed })
    }
    check('latency sample count', result.latency.length === cycles, { samples: result.latency.length })

    result.ok = true
    summarizeMemory()
    mem.phase = 'done'
    clearInterval(sampler)
    result.counts.finalGuestUrls = (() => { try { return guests().map((guest) => guest.getURL()) } catch { return [] } })()
    result.finishedAt = new Date(realNow()).toISOString()
    result.wallMs = realNow() - startedAt
    writeResult()
    app.exit(0)
  }

  // The app bundle registers privileged custom schemes at module load, so it must be
  // required BEFORE app ready; proxy/sampler setup is chained on the first ready tick.
  const sampler = setInterval(sampleMemory, 100)
  markPhase('boot')
  const readySetup = app.whenReady().then(async () => {
    session.fromPartition(WEBBAR_PARTITION).setProxy({ mode: 'direct' })
    return true
  })
  try {
    // Load the actual built app (same pattern as the other full-app fixtures).
    require(path.join(ROOT, 'dist', 'main', 'index.js'))
  } catch (error) {
    await fail(error)
    return
  }
  await readySetup
  run().catch((error) => fail(error))
}

/* -------------------------------------------------------------------------- */
/* Recheck child                                                              */
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
  app.setPath('userData', devUserData)
  app.setPath('sessionData', path.join(base, 'session-data'))
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('no-proxy-server')

  const result = {
    ok: false,
    base,
    configDir,
    bootId: null,
    expectedBootId: argv['expected-boot'] || null,
    entries: null,
    archived: 0,
    sleepMetadata: 0,
    guests: 0,
    listSleep: 0,
    checks: []
  }
  let main = null
  app.on('browser-window-created', (_event, win) => { if (!main) main = win })
  const write = () => {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const tmp = `${out}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2))
    fs.renameSync(tmp, out)
  }
  const check = (name, condition, detail) => {
    result.checks.push({ name, ok: !!condition, detail })
    if (!condition) throw Object.assign(new Error(`assertion failed: ${name}`), { check: name, detail })
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  try {
    // The production bundle registers privileged schemes at module load, so it must be
    // required before app ready — and after every isolation path (appData/userData/
    // sessionData/DSH_HOME/partition proxy) is in place.
    require(path.join(ROOT, 'dist', 'main', 'index.js'))
    await new Promise((resolve) => app.whenReady().then(resolve))
    check('recheck: isolated userData', app.getPath('userData') === devUserData, { userData: app.getPath('userData'), expected: devUserData })
    await sleep(1500)
    let wc = null
    for (let attempt = 0; attempt < 600; attempt += 1) {
      wc = main ? main.webContents : null
      if (wc && !wc.isDestroyed()) {
        try {
          const ok = await wc.executeJavaScript("!!window.electronAPI && !!window.electronAPI.taskShelfRequest && document.readyState !== 'loading'", true)
          if (ok) break
        } catch { /* retry */ }
      }
      await sleep(150)
    }
    let reply = null
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        const value = await wc.executeJavaScript("window.electronAPI.taskShelfRequest({kind:'list'})", true)
        if (value && value.success === true && value.startup?.status === 'ready') { reply = value; break }
      } catch { /* retry */ }
      await sleep(150)
    }
    if (!reply) throw new Error('task shelf never became ready in the recheck boot')
    result.bootId = reply.startup.bootId || null
    const webContents = require('electron').webContents
    result.guests = webContents.getAllWebContents().filter((item) => !item.isDestroyed() && item.getType() === 'webview').length
    const json = JSON.parse(fs.readFileSync(path.join(configDir, 'task-shelf.json'), 'utf8'))
    result.entries = (json.entries || []).map((entry) => ({
      id: entry.id,
      archived: !!entry.archivedAt,
      revision: entry.revision,
      recoveryKind: entry.recovery?.kind || null,
      reloadableMode: entry.recovery?.reloadableMode === true,
      // Sleep metadata lives in recovery.sleep (schema: ShelfWebSleep); there is no
      // top-level entry.sleep field in the v1 repository format.
      hasSleep: !!entry.recovery?.sleep,
      sleep: entry.recovery?.sleep ? {
        formatVersion: entry.recovery.sleep.formatVersion,
        partition: entry.recovery.sleep.partition,
        suspendOperationId: entry.recovery.sleep.suspendOperationId,
        url: entry.recovery.sleep.url,
        zoom: entry.recovery.sleep.zoom,
        scrollY: entry.recovery.sleep.scrollY,
        taskId: entry.recovery.sleep.taskId,
        resourceId: entry.recovery.sleep.resourceId,
        recordedAt: entry.recovery.sleep.recordedAt
      } : null
    }))
    result.archived = result.entries.filter((entry) => entry.archived).length
    result.sleepMetadata = result.entries.filter((entry) => entry.hasSleep).length
    result.listSleep = reply.entries.filter((entry) => !!entry.recovery?.sleep).length
    result.entryCount = reply.entries.length

    check('recheck: fresh boot id', result.bootId && result.bootId !== result.expectedBootId, { bootId: result.bootId, expected: result.expectedBootId })
    check('recheck: 12 entries reread', result.entryCount === TOTAL_ENTRIES, { entryCount: result.entryCount })
    check('recheck: all entries archived after restart', result.archived === TOTAL_ENTRIES, { archived: result.archived })
    check('recheck: no native guests after restart', result.guests === 0, { guests: result.guests })
    check('recheck: 10 reading snapshots readable from disk', result.entries.filter((entry) => entry.id.startsWith('reading-') && entry.hasSleep).length === READING_COUNT, { sleeps: result.entries.filter((entry) => entry.hasSleep).map((entry) => entry.id) })
    for (const entry of result.entries.filter((item) => item.id.startsWith('reading-'))) {
      check(`recheck: ${entry.id} snapshot contract`, entry.hasSleep && entry.recoveryKind === 'web' && entry.reloadableMode === true && entry.sleep.formatVersion === 1 && entry.sleep.partition === WEBBAR_PARTITION && typeof entry.sleep.suspendOperationId === 'string' && entry.sleep.taskId === entry.id && Number.isFinite(entry.sleep.zoom) && Number.isFinite(entry.sleep.scrollY) && entry.sleep.zoom > 0 && entry.sleep.scrollY > 50 && !/[?#]/.test(String(entry.sleep.url || '')), entry.sleep)
    }
    check('recheck: distinct sleep transactions', new Set(result.entries.filter((entry) => entry.hasSleep).map((entry) => entry.sleep.suspendOperationId)).size === result.entries.filter((entry) => entry.hasSleep).length)
    result.ok = true
  } catch (error) {
    result.ok = false
    result.error = { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 12).join('\n') }
  }
  write()
  app.exit(result.ok ? 0 : 1)
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

function seedEntries(configDir, fixtureBase) {
  const entries = []
  for (let index = 1; index <= READING_COUNT; index += 1) {
    entries.push({
      id: `reading-${index}`,
      kind: 'reading',
      title: `Reading ${index}`,
      url: `${fixtureBase}/reading/${index}`,
      consent: true
    })
  }
  entries.push({ id: 'protected', kind: 'protected', title: 'Protected unsaved page', url: `${fixtureBase}/protected`, consent: true })
  entries.push({ id: 'unknown', kind: 'unknown', title: 'Unknown page', url: `${fixtureBase}/unknown`, consent: false })

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
      recovery: entry.consent
        ? { kind: 'web', url: entry.url, reloadableMode: true }
        : { kind: 'web', url: entry.url }
    }))
  }
  fs.writeFileSync(path.join(configDir, 'browser-settings.json'), JSON.stringify({
    homePage: '',
    searchEngine: 'bing',
    zoomFactor: 1.25,
    rememberHistory: true,
    restoreTabs: false,
    restoreMini: true,
    savePasswords: false,
    proxyMode: 'direct',
    proxyServer: '',
    proxyBypass: '<local>',
    permissions: { camera: 'deny', microphone: 'deny', notifications: 'deny', geolocation: 'deny', clipboard: 'deny' }
  }))
  fs.writeFileSync(path.join(configDir, 'task-shelf.json'), `${JSON.stringify(document, null, 2)}\n`)
  return entries
}

/* -------------------------------------------------------------------------- */
/* Summary + report                                                           */
/* -------------------------------------------------------------------------- */

function trimRun(run) {
  const result = run.result || {}
  return {
    arm: run.arm,
    round: run.round,
    ok: run.ok,
    base: run.base,
    wallMs: run.wallMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    error: result.error || null,
    env: result.env,
    versions: result.versions,
    config: result.config,
    checks: result.checks || [],
    softFailures: result.softFailures || [],
    counts: result.counts || {},
    memory: {
      phases: result.memory?.phases || {},
      phaseMarks: result.memory?.phaseMarks || [],
      sampleCount: result.memory?.samples?.length || 0,
      samplerCostMedianMs: result.memory?.samplerCostMedianMs ?? null,
      samplerCostMaxMs: result.memory?.samplerCostMaxMs ?? null,
      errors: result.memory?.errors ?? null
    },
    latency: result.latency || [],
    cycles: (result.cyclesLog || []).map((cycle) => ({
      index: cycle.index,
      entry: cycle.entry,
      readyMs: cycle.readyMs,
      wheelMs: cycle.wheelMs,
      wheelObserver: cycle.wheelObserver,
      restored: cycle.restored || null,
      zoom: cycle.zoom,
      scrollY: cycle.scrollY,
      activationSynthetic: cycle.activationSynthetic,
      presentation: cycle.presentation,
      presentationOwner: cycle.presentationOwner,
      sleepRewrite: cycle.sleepRewrite || null,
      sleepConfirmed: !!cycle.sleepConfirmed,
      stayLive: !!cycle.stayLive
    })),
    failureAttempts: result.failureAttempts || [],
    screenshots: result.screenshots || [],
    notes: result.notes || [],
    bootId: result.bootId || null
  }
}

function summarize(context) {
  const { runs, rechecks, buildBefore, buildAfter, buildStable, sourceBefore, sourceAfter, sourceStable, sourceTreeDrift, fixtureState, finalHits, rounds, cycles, command, abortReason } = context
  const okRuns = runs.filter((run) => run.ok)
  const byArm = { before: okRuns.filter((run) => run.arm === 'before'), after: okRuns.filter((run) => run.arm === 'after') }

  const armMemory = (arm, phase) => {
    const values = byArm[arm].map((run) => run.result?.memory?.phases?.[phase]).filter(Boolean)
    if (values.length === 0) return null
    return {
      rounds: values.length,
      perRoundMedianMiB: values.map((value) => value.median),
      perRoundPeakMiB: values.map((value) => value.peak),
      medianOfMedians: round2(median(values.map((value) => value.median))),
      medianOfMeans: round2(median(values.map((value) => value.mean))),
      peakOfPeaks: round2(Math.max(...values.map((value) => value.peak))),
      samplesPerRound: values.map((value) => value.samples),
      pidMedian: round2(median(values.map((value) => value.pidMedian).filter((value) => typeof value === 'number'))),
      typeMedianMiB: (() => {
        const types = new Set()
        for (const value of values) for (const type of Object.keys(value.typeMedianMiB || {})) types.add(type)
        const out = {}
        for (const type of types) out[type] = round2(median(values.map((value) => value.typeMedianMiB?.[type]).filter((item) => typeof item === 'number')))
        return out
      })()
    }
  }

  const phases = ['boot', 'loaded', 'transition', 'sleep', 'cycles', 'final']
  const memory = {}
  for (const arm of ['before', 'after']) {
    memory[arm] = {}
    for (const phase of phases) memory[arm][phase] = armMemory(arm, phase)
  }

  const delta = (phase) => {
    const before = memory.before[phase]
    const after = memory.after[phase]
    if (!before || !after) return null
    return {
      phase,
      beforeMiB: before.medianOfMedians,
      afterMiB: after.medianOfMedians,
      deltaMiB: round2(after.medianOfMedians - before.medianOfMedians),
      deltaPct: before.medianOfMedians ? round2(((after.medianOfMedians - before.medianOfMedians) / before.medianOfMedians) * 100) : null
    }
  }
  const deltas = phases.map((phase) => delta(phase)).filter(Boolean)

  const latencyStats = (values) => {
    const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).slice().sort((a, b) => a - b)
    if (list.length === 0) return null
    const at = (p) => list[Math.min(list.length - 1, Math.max(0, Math.round((p / 100) * (list.length - 1))))]
    return { n: list.length, p50: round2(median(list)), p95: round2(at(95)), min: round2(list[0]), max: round2(at(100)) }
  }
  const latency = {}
  for (const arm of ['before', 'after']) {
    const samples = byArm[arm].flatMap((run) => run.result?.latency || [])
    latency[arm] = {
      samples: samples.length,
      readyMs: latencyStats(samples.map((sample) => sample.readyMs)),
      wheelMs: latencyStats(samples.map((sample) => sample.wheelMs)),
      observers: samples.reduce((acc, sample) => { acc[sample.wheelObserver] = (acc[sample.wheelObserver] || 0) + 1; return acc }, {}),
      definition: {
        readyMs: 'cycle start (real clock) -> page presented through the real shelf UI, live, content+session verified, input gate interactive, activation checked',
        wheelMs: 'full software wheel scenario including setup, failed main-window attempt, fallback/retry and 25ms polling -> observed movement; not hardware latency',
        wheelDelivery: 'attempt order: main-window webContents.sendInputEvent -> guest webContents.sendInputEvent (two ticks) -> scroll reset + guest tick. The recorded observer counts show which delivery actually reached the page; the main-window wheel does not reach a webview guest in this build, so samples are dominated by guest-level software input',
        excluded: 'no read-only scroll IPC exists in ordinary mode and none is fabricated; keyboard/IME/OS-hardware input latency is NOT claimed'
      }
    }
  }

  const checks = { total: 0, failed: 0, failures: [] }
  for (const run of okRuns) {
    for (const check of run.result?.checks || []) {
      checks.total += 1
      if (!check.ok) {
        checks.failed += 1
        checks.failures.push({ arm: run.arm, round: run.round, ...check })
      }
    }
  }

  const recheckList = rechecks.map((recheck) => ({
    round: recheck.round,
    ok: recheck.ok,
    base: recheck.base,
    archived: recheck.result?.archived ?? null,
    entries: recheck.result?.entryCount ?? null,
    sleepMetadata: recheck.result?.sleepMetadata ?? null,
    listSleep: recheck.result?.listSleep ?? null,
    guests: recheck.result?.guests ?? null,
    bootId: recheck.result?.bootId ?? null,
    expectedBootId: recheck.result?.expectedBootId ?? null,
    error: recheck.result?.error || null,
    perEntry: recheck.result?.entries || null
  }))

  // Observed peak of the steady phases (loaded/sleep/cycles/final) and, separately, the
  // all-phase peak that includes boot, both taken from the 100ms raw sample peaks so no
  // phase exception can hide a higher start-up footprint.
  const peakOf = (list, phasesToScan = ['loaded', 'sleep', 'cycles', 'final']) => {
    const peaks = []
    for (const run of list) {
      const phases = run.result?.memory?.phases || {}
      for (const phase of phasesToScan) {
        const value = phases[phase]?.peak
        if (typeof value === 'number' && Number.isFinite(value)) peaks.push(value)
      }
    }
    return peaks.length ? round2(Math.max(...peaks)) : null
  }

  const totalRestoreCycles = okRuns.reduce((sum, run) => sum + (run.result?.counts?.restoreCycles || 0), 0)
  const totalReloadCycles = okRuns.reduce((sum, run) => sum + (run.result?.counts?.reloadCycles || 0), 0)
  const forbidden = (finalHits?.forbidden || 0) + (fixtureState?.forbidden?.length || 0)

  const reasons = []
  if (!buildStable) reasons.push('dist build changed between the first and last fresh app')
  if (!sourceStable) reasons.push('production source changed during the run')
  if (abortReason) reasons.push(`run aborted: ${abortReason.error?.message || 'unknown'}`)
  if (byArm.before.length !== rounds) reasons.push(`expected ${rounds} before runs, got ${byArm.before.length}`)
  if (byArm.after.length !== rounds) reasons.push(`expected ${rounds} after runs, got ${byArm.after.length}`)
  if (rechecks.length !== rounds || rechecks.some((recheck) => !recheck.ok)) reasons.push('fresh-restart recheck incomplete or failed')
  if (totalRestoreCycles < rounds * cycles) reasons.push(`wake cycles below budget: ${totalRestoreCycles}/${rounds * cycles}`)
  if (totalReloadCycles < rounds * cycles) reasons.push(`reload cycles below budget: ${totalReloadCycles}/${rounds * cycles}`)
  if (checks.failed > 0) reasons.push(`${checks.failed} failed checks`)
  if (forbidden > 0) reasons.push(`${forbidden} forbidden fixture requests (POST)`)
  if (rounds !== DEFAULT_ROUNDS || cycles !== DEFAULT_CYCLES) reasons.push(`non-default budget rounds=${rounds} cycles=${cycles}`)

  const status = reasons.length === 0 ? 'valid' : (!buildStable || !sourceStable || abortReason) ? 'failed' : 'partial'
  const docs = {
    ok: status === 'valid',
    generatedAt: new Date(realNow()).toISOString(),
    scenario: 'ordinary-page reloadable full-app sleep/wake memory + acceptance',
    command,
    validity: { status, reasons },
    build: {
      electron: buildBefore.electron,
      before: { app: buildBefore.app, files: buildBefore.files },
      after: { app: buildAfter.app, files: buildAfter.files },
      stable: buildStable
    },
    source: {
      before: { head: sourceBefore.head, shelfDigest: sourceBefore.shelfDigest, shelfFileCount: sourceBefore.shelfFileCount, treeDirty: sourceBefore.treeDirty, statusSha: sourceBefore.statusSha, diffSha: sourceBefore.diffSha },
      after: { head: sourceAfter.head, shelfDigest: sourceAfter.shelfDigest, shelfFileCount: sourceAfter.shelfFileCount, treeDirty: sourceAfter.treeDirty, statusSha: sourceAfter.statusSha, diffSha: sourceAfter.diffSha },
      stable: sourceStable,
      shelfGate: 'equal HEAD and SHA256 of every file in src (tracked and untracked), this fixture, package.json and electron.vite.config.ts',
      concurrentTreeEdits: (sourceTreeDrift || []).length,
      note: 'treeDirty records an uncommitted working tree; the checkout is shared with unrelated concurrent work, so whole-tree drift is reported but not gated. The dist hashes are the authoritative identity of the app under measurement and are verified unchanged before every fresh app.'
    },
    versions: okRuns[0]?.result?.versions || null,
    arms: {
      before: { env: { LYSHELL_SHELF_RELOADABLE_SLEEP: '0' }, description: 'reloadable sleep path disabled; ordinary pages stay live and are reloaded once per cycle' },
      after: { env: { LYSHELL_SHELF_RELOADABLE_SLEEP: null }, description: 'production contract: idle ordinary pages deep-sleep and wake with restored scroll/zoom/session' }
    },
    budget: { rounds, cyclesPerRound: cycles, expectedWakeCycles: rounds * cycles, wakeCycles: totalRestoreCycles, reloadCycles: totalReloadCycles },
    memory: {
      method: {
        source: 'app.getAppMetrics()',
        field: 'memory.privateBytes (KiB) -> MiB (/1024)',
        aggregation: 'per sample: max privateBytes per PID, summed over PIDs; Windows private bytes include Browser/Tab/GPU/Utility/Zygote/service processes',
        excluded: 'no JS heap totals, no external/working-set arithmetic',
        intervalMs: 100,
        phases: 'boot includes startup/open-all; loaded is3s with12 live pages; transition is demand withdrawal/idle/verification, not steady; sleep is3s after checks; cycles includes the whole navigation/input loop; final is3s steady. Same windows and budget in both arms.',
        samplerCostMedianMs: round2(median(okRuns.map((run) => run.result?.memory?.samplerCostMedianMs).filter((value) => typeof value === 'number'))),
        guestCountsAreAcceptanceOnly: true
      },
      phases,
      byArm: memory,
      deltas,
      observedPeaks: {
        // peak of the steady phases (boot excluded), matching the phase medians below
        steadyExcludingBoot: { before: peakOf(byArm.before), after: peakOf(byArm.after) },
        // absolute observed peak over EVERY phase including boot
        allPhasesIncludingBoot: { before: peakOf(byArm.before, phases), after: peakOf(byArm.after, phases) }
      },
      rawSamples: 'full 100ms per-PID raw samples stay in each run directory (result.json); the run list below points at them'
    },
    latency,
    checks,
    runs: runs.map(trimRun),
    recheck: { method: 'fresh Electron process boot, same appData, rereads task-shelf.json and the shelf list', results: recheckList },
    fixture: {
      host: HOST,
      partition: WEBBAR_PARTITION,
      hitCounts: finalHits?.counts || null,
      totalHits: finalHits?.total || null,
      forbiddenPosts: forbidden,
      pages: [
        { path: '/reading/1..10', kind: 'reading', description: 'ordinary pages, ordinary JS, tall content, session cookie login proof, per-URL seeded reloadable consent' },
        { path: '/protected', kind: 'protected', description: 'armed beforeunload + JS-only unsaved draft, seeded consent, native close refusal expected' },
        { path: '/unknown', kind: 'unknown', description: 'ordinary page without consent: must stay live' }
      ],
      consentNote: 'recovery.reloadableMode=true simulates prior per-URL consent. Codex GUI checks exercise actual menu/main IPC with fixture-scoped dialog responses simulated; no real user operation is auto-approved.'
    },
    limitations: [
      'Synthetic activation: a hidden window cannot gain hardware user activation, so a page that is not already active is activated with a test-scoped executeJavaScript(\'void 0\', true) after a no-gesture read, and then re-read without a gesture to verify navigator.userActivation.hasBeenActive===true. Every synthetic path is labelled synthetic/software, never hardware input.',
      'Software wheel timings include failed host delivery and labelled guest delivery/retries, setup and25ms polling. They are fixture scenario timings, not keyboard/IME/OS hardware latency.',
      'Reading fixtures use fixed-width layout and browser zoom1.25. Responsive real pages can reflow between task and main view, altering pixel scroll offsets; scroll restoration is best-effort.',
      'Memory is Windows private bytes only, summed over the app process tree; it is a process-level proxy, not a per-page attribution.',
      'Explicit consent plus the reloadable safe-snapshot guard block many real sites; results cover the ordinary fixture contract only, not universal real-site coverage.',
      'The protected page may persist sleep metadata even though its native close was refused; such a record is classified separately and never counted as a sleeping page.',
      'Real UI consent/dialog handling is covered by the owner GUI checks (actual menu + main IPC exercised with a fixture-scoped native dialog stub); this scenario exercises the real shelf UI presentation/release path and reads seeded per-URL consent only.',
      'Sleep metadata on disk (ShelfWebSleep v1) has no method field; GET is an enforced contract invariant rather than a persisted property, so no on-disk method assertion is made.',
      'Source identity hashes every src file and this fixture; dist hashes independently identify the exercised build.'
    ],
    methodNote: 'Same build,12 ordinary pages, fixed layout and browser zoom1.25, alternating fresh-process order. Each cycle does exactly one GET navigation: before reloads the retained guest; after creates/loads the sleeping counterpart. Both verify content/session/actual input gate, software wheel, zoom/nonzero scroll. The sole feature switch is LYSHELL_SHELF_RELOADABLE_SLEEP=0 in before.',
    abortReason,
    rawRunDirs: runs.map((run) => run.base)
  }

  return { docs, report: renderReport(docs) }
}

function renderReport(docs) {
  const lines = []
  lines.push('# Reloadable ordinary-page full-app scenario')
  lines.push('')
  lines.push(`Generated: ${docs.generatedAt}`)
  lines.push('')
  lines.push(`Status: **${docs.validity.status}**${docs.validity.reasons.length ? ` — ${docs.validity.reasons.join('; ')}` : ''}`)
  lines.push('')
  lines.push('## Method')
  lines.push('')
  lines.push(`- ${docs.methodNote}`)
  lines.push(`- 12 ordinary pages: 10 reading (seeded consent), 1 protected (seeded consent, armed beforeunload), 1 unknown (no consent)`)
  lines.push(`- 3 fresh-process before/after pairs, ${docs.budget.cyclesPerRound} cycles per round, ${docs.budget.wakeCycles} wake cycles, ${docs.budget.reloadCycles} reload cycles`)
  lines.push(`- Memory: ${docs.memory.method.source} ${docs.memory.method.field}, 100ms sampling`)
  lines.push('')
  lines.push('## Memory (MiB, median of round medians)')
  lines.push('')
  lines.push('| phase | before | after | delta | delta% |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const delta of docs.memory.deltas) {
    lines.push(`| ${delta.phase} | ${delta.beforeMiB} | ${delta.afterMiB} | ${delta.deltaMiB} | ${delta.deltaPct}% |`)
  }
  lines.push('')
  lines.push(`Observed peak (steady phases, boot excluded): before ${docs.memory.observedPeaks.steadyExcludingBoot.before} MiB, after ${docs.memory.observedPeaks.steadyExcludingBoot.after} MiB`)
  lines.push(`Observed peak (all phases, boot included): before ${docs.memory.observedPeaks.allPhasesIncludingBoot.before} MiB, after ${docs.memory.observedPeaks.allPhasesIncludingBoot.after} MiB`)
  lines.push('')
  lines.push('## Cycles per round')
  lines.push('')
  lines.push('| arm | round | loaded | sleep | cycles | final | ready p50 | wheel p50 | paths |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of docs.runs.filter((item) => item.ok)) {
    const phases = run.memory.phases
    const paths = Object.keys(run.counts || {}).filter((key) => key.startsWith('presentation_')).map((key) => `${key.replace('presentation_', '')}:${run.counts[key]}`).join(', ')
    const ready = run.latency.map((sample) => sample.readyMs)
    const wheel = run.latency.map((sample) => sample.wheelMs)
    lines.push(`| ${run.arm} | ${run.round} | ${phases.loaded?.median ?? '-'} | ${phases.sleep?.median ?? '-'} | ${phases.cycles?.median ?? '-'} | ${phases.final?.median ?? '-'} | ${round2(median(ready)) ?? '-'} | ${round2(median(wheel)) ?? '-'} | ${paths} |`)
  }
  lines.push('')
  lines.push('## Acceptance')
  lines.push('')
  lines.push(`- checks: ${docs.checks.total} total, ${docs.checks.failed} failed`)
  lines.push(`- wake cycles: ${docs.budget.wakeCycles} (budget ${docs.budget.expectedWakeCycles})`)
  lines.push(`- reload cycles: ${docs.budget.reloadCycles}`)
  lines.push(`- forbidden fixture requests (POST): ${docs.fixture.forbiddenPosts}`)
  lines.push(`- native attach/destroy per run: ${docs.runs.filter((run) => run.ok).map((run) => `${run.arm}#${run.round}=${run.counts.nativeAttaches ?? '?'}/${run.counts.nativeDestroyed ?? '?'}`).join(', ')}`)
  lines.push(`- protected snapshot classification: ${docs.runs.map((run) => run.counts?.protectedSnapshotClassification).filter(Boolean).join(', ') || 'n/a'}`)
  lines.push('')
  lines.push('## Fresh-restart recheck')
  lines.push('')
  for (const recheck of docs.recheck.results) {
    lines.push(`- round ${recheck.round}: ${recheck.ok ? 'ok' : 'FAILED'} archived=${recheck.archived}/${recheck.entries} sleepMetadata=${recheck.sleepMetadata} listSleep=${recheck.listSleep} guests=${recheck.guests}${recheck.error ? ` error=${recheck.error.message}` : ''}`)
  }
  lines.push('')
  if (docs.checks.failures.length) {
    lines.push('## Failures')
    lines.push('')
    for (const failure of docs.checks.failures) lines.push(`- ${failure.name} (${failure.arm} r${failure.round}) ${JSON.stringify(failure.detail)}`)
    lines.push('')
  }
  if (docs.abortReason) {
    lines.push('## Abort')
    lines.push('')
    lines.push(`- ${docs.abortReason.error?.message || 'unknown'}`)
    lines.push('')
  }
  lines.push('## Limitations')
  lines.push('')
  for (const item of docs.limitations) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Raw artifacts')
  lines.push('')
  for (const dir of docs.rawRunDirs) lines.push(`- ${dir}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

const argv = parseArgs(process.argv.slice(2))
if (argv.recheck) {
  recheckMain(argv).catch((error) => {
    console.error('recheck crashed:', error)
    process.exit(1)
  })
} else if (IS_ELECTRON) {
  childMain(argv).catch((error) => {
    console.error('[child] crashed:', error)
    process.exit(1)
  })
} else {
  parentMain(argv).catch((error) => {
    console.error('[parent] crashed:', error)
    process.exit(1)
  })
}
