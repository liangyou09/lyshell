#!/usr/bin/env node
/*
 * Isolated runtime probe: can a sandboxed, context-isolated <webview> guest be
 * moved to about:blank through a *cancellable* navigation that keeps the
 * original JS heap, DOM draft, guest identity and native Session when
 * beforeunload refuses?
 *
 * Two mechanisms are compared:
 *   A. webContents.loadURL('about:blank') with the default will-prevent-unload
 *      policy (this probe NEVER calls preventDefault).
 *   B. CDP Page.navigate('about:blank') plus Page.javascriptDialogOpening and an
 *      explicit Page.handleJavaScriptDialog({accept:false}).
 *
 * Page.close is deliberately NOT the primary mechanism: the sibling probe
 * (safe-close-probe.cjs) already showed a denied beforeunload dialog cannot
 * prevent guest destruction on that path.
 *
 * Scope isolation:
 * - Never loads LyShell's production UI, dist bundle, user profile or user
 *   pages; no model/backend is started.
 * - Every run gets fresh userData/appData/localAppData/DSH_HOME directories, a
 *   fresh in-memory webview partition and exactly one guest.
 * - Fixtures are loopback HTTP servers only (two origins, for cross-origin
 *   iframe coverage). Guests are sandboxed, context-isolated and
 *   nodeIntegration=false; will-attach-webview enforces that.
 * - The host BrowserWindow is hidden and never interacts with real sessions.
 * - Proof of survival is always executeJavaScript() running twice in the guest
 *   after the navigation attempt, never a GET or a DOM scan.
 *
 * Usage:
 *   node scripts/shelf-memory-p0/navigation-close-probe.cjs              # 3 rounds, all cases
 *   node scripts/shelf-memory-p0/navigation-close-probe.cjs --rounds=1   # fast pass (writes under tmp/)
 *   node scripts/shelf-memory-p0/navigation-close-probe.cjs --only=refuse-onbeforeunload-loadurl
 *   node scripts/shelf-memory-p0/navigation-close-probe.cjs --aggregate  # rebuild JSON from raw logs
 *   node scripts/shelf-memory-p0/navigation-close-probe.cjs --list
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

const IS_ELECTRON = Boolean(process.versions.electron)
const T0 = performance.now()
const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, 'tmp/navigation-close-probe')
const RAW = path.join(OUT, 'raw')
const RUNS = path.join(OUT, 'runs')
const PROFILE_ROOT = path.join(OUT, 'profiles')
const RESULT_FILE = path.join(ROOT, 'docs/shelf-memory-p0/navigation-close-probe-results.json')
const REPORT_FILE = path.join(OUT, 'report.md')
const ROUNDS = 3
const RUN_TIMEOUT_MS = 60000
const PROBE_DEADLINE_MS = 50000
const NAV_SETTLE_MS = 4500

/* ------------------------------------------------------------------ */
/* Case matrix                                                        */
/* ------------------------------------------------------------------ */

const ALLOW_CORE = {
  navigationCommitted: true,
  mainFrameBlankCommit: true,
  blankDocumentFresh: true,
  closeAfterCommitDestroyedSameGuest: true
}

const REFUSAL_CORE = {
  activationObserved: true,
  beforeUnloadObserved: true,
  navigationRefused: true,
  navigationCommitted: false,
  heapPreserved: true,
  draftPreserved: true,
  identityPreserved: true,
  sessionPreserved: true,
  jsExecutedTwice: true
}

const CASES = [
  {
    name: 'allow-none-loadurl',
    variant: 'loadURL',
    protection: 'none',
    activation: 'top',
    primary: 'closeAfterCommitDestroyedSameGuest',
    purpose: 'Control: an unprotected guest is navigated to about:blank, then the same blank guest is closed.',
    expectation: 'The blank commit succeeds, the original document is gone, and closing the blank guest destroys exactly that guest.',
    expected: Object.assign({}, ALLOW_CORE)
  },
  {
    name: 'allow-none-cdp',
    variant: 'cdp',
    protection: 'none',
    activation: 'top',
    primary: 'closeAfterCommitDestroyedSameGuest',
    purpose: 'Control for the CDP mechanism: Page.navigate(about:blank) commits, then the same blank guest is closed.',
    expectation: 'Page.navigate reports a blank main-frame commit, the document is replaced, and closing destroys exactly that guest.',
    expected: Object.assign({}, ALLOW_CORE)
  },
  {
    name: 'refuse-onbeforeunload-loadurl',
    variant: 'loadURL',
    protection: 'onbeforeunload',
    activation: 'top',
    primary: 'navigationRefused',
    purpose: 'window.onbeforeunload=()=>false with sticky activation, via loadURL(about:blank) and the default will-prevent-unload policy (never preventDefault).',
    expectation: 'The navigation is cancelled, the original heap/draft/identity/session survive, and the guest still executes JS after the attempt.',
    expected: Object.assign({ willPreventUnloadFired: true }, REFUSAL_CORE)
  },
  {
    name: 'refuse-onbeforeunload-cdp',
    variant: 'cdp',
    protection: 'onbeforeunload',
    activation: 'top',
    primary: 'navigationRefused',
    purpose: 'window.onbeforeunload=()=>false with sticky activation, via CDP Page.navigate(about:blank) and an explicit deny of the beforeunload dialog.',
    expectation: 'The navigation is cancelled (dialog denied), the original heap/draft/identity/session survive, and the guest still executes JS.',
    expected: Object.assign({}, REFUSAL_CORE)
  },
  {
    name: 'refuse-listener-loadurl',
    variant: 'loadURL',
    protection: 'listener',
    activation: 'top',
    primary: 'navigationRefused',
    purpose: 'addEventListener(beforeunload) + preventDefault, via loadURL(about:blank) and the default policy.',
    expectation: 'The navigation is cancelled and the original document survives if the modern listener form is honoured.',
    expected: Object.assign({}, REFUSAL_CORE)
  },
  {
    name: 'refuse-listener-cdp',
    variant: 'cdp',
    protection: 'listener',
    activation: 'top',
    primary: 'navigationRefused',
    purpose: 'addEventListener(beforeunload) + preventDefault, via CDP Page.navigate(about:blank) with an explicit deny.',
    expectation: 'The navigation is cancelled and the original document survives if the modern listener form is honoured.',
    expected: Object.assign({}, REFUSAL_CORE)
  },
  {
    name: 'refuse-late-loadurl',
    variant: 'loadURL',
    protection: 'late',
    activation: 'top',
    primary: 'navigationCommitted',
    exploratory: true,
    purpose: 'Race: the protection is installed 250ms AFTER the loadURL(about:blank) starts.',
    expectation: 'Exploratory: the navigation decision is expected to already be in flight, so the late handler is not expected to cancel it.',
    expected: { navigationCommitted: true }
  },
  {
    name: 'refuse-late-cdp',
    variant: 'cdp',
    protection: 'late',
    activation: 'top',
    primary: 'navigationCommitted',
    exploratory: true,
    purpose: 'Race: the protection is installed 250ms AFTER the CDP Page.navigate(about:blank) starts.',
    expectation: 'Exploratory: same race as the loadURL variant, through the CDP navigation path.',
    expected: { navigationCommitted: true }
  },
  {
    name: 'refuse-iframe-same-loadurl',
    variant: 'loadURL',
    protection: 'iframe-same',
    activation: 'frame',
    primary: 'navigationCommitted',
    exploratory: true,
    purpose: 'A same-origin child frame with its own beforeunload handler, frame itself activated, top frame navigated by loadURL.',
    expectation: 'Exploratory: measures whether a child-frame refusal can cancel the top-level navigation.',
    expected: {}
  },
  {
    name: 'refuse-iframe-same-cdp',
    variant: 'cdp',
    protection: 'iframe-same',
    activation: 'frame',
    primary: 'navigationCommitted',
    exploratory: true,
    purpose: 'Same-origin child frame with beforeunload, frame activated, top frame navigated by CDP Page.navigate.',
    expectation: 'Exploratory: measures whether a child-frame refusal can cancel the top-level navigation over CDP.',
    expected: {}
  },
  {
    name: 'refuse-iframe-cross-loadurl',
    variant: 'loadURL',
    protection: 'iframe-cross',
    activation: 'frame',
    primary: 'navigationCommitted',
    exploratory: true,
    purpose: 'A cross-origin (second loopback origin) child frame with beforeunload, frame activated, top frame navigated by loadURL.',
    expectation: 'Exploratory: measures whether a cross-origin child-frame refusal can cancel the top-level navigation.',
    expected: {}
  },
  {
    name: 'refuse-iframe-cross-cdp',
    variant: 'cdp',
    protection: 'iframe-cross',
    activation: 'frame',
    primary: 'navigationCommitted',
    exploratory: true,
    purpose: 'Cross-origin child frame with beforeunload, frame activated, top frame navigated by CDP Page.navigate.',
    expectation: 'Exploratory: measures whether a cross-origin child-frame refusal can cancel the top-level navigation over CDP.',
    expected: {}
  },
  {
    name: 'refuse-noactivation-loadurl',
    variant: 'loadURL',
    protection: 'onbeforeunload',
    activation: 'none',
    primary: 'navigationCommitted',
    purpose: 'Control: onbeforeunload exists but the guest has no sticky activation, so no refusal dialog should be available.',
    expectation: 'Without activation the navigation commits; a refusal observed here would be invalid evidence for a cancellable path.',
    expected: { activationAbsent: true, navigationCommitted: true, mainFrameBlankCommit: true }
  },
  {
    name: 'refuse-noactivation-cdp',
    variant: 'cdp',
    protection: 'onbeforeunload',
    activation: 'none',
    primary: 'navigationCommitted',
    purpose: 'Control for CDP: onbeforeunload exists but the guest has no sticky activation.',
    expectation: 'Without activation the CDP navigation commits and no beforeunload dialog is expected.',
    expected: { activationAbsent: true, navigationCommitted: true, mainFrameBlankCommit: true }
  },
  {
    name: 'race-demand-during-nav',
    variant: 'loadURL',
    protection: 'onbeforeunload',
    activation: 'top',
    primary: 'navigationRefused',
    exploratory: true,
    purpose: 'Race: a close demand (guest.close({waitForBeforeUnload:true})) arrives 30ms after the protected navigation starts.',
    expectation: 'Exploratory only; records which of navigation / unload policy / close demand wins. No production conclusion is asserted.',
    expected: {}
  }
]

for (const item of CASES) {
  if (item.activation === 'none') {
    item.trustedDraft = false
  } else if (item.activation === 'top') {
    item.trustedDraft = true
  } else {
    item.trustedDraft = false
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const HOST_PAGE = '<!doctype html><meta charset="utf-8"><title>nav probe host</title><body></body>'

const BASE_CSS = '<style>html,body{margin:0;font:15px sans-serif}#content{padding:16px}#gesture{position:fixed;left:16px;top:16px;width:240px;height:64px}#draft{position:fixed;left:16px;top:100px;width:320px;height:36px}#frame{position:fixed;left:16px;top:160px;width:260px;height:120px;border:1px solid #888}</style>'

const BASE_SCRIPT = `<script>
window.__probeMarker = 'marker-' + Math.random().toString(36).slice(2, 10);
window.__probeTicks = 0;
window.__beforeUnloadFired = 0;
window.__gestureClicks = 0;
window.__frameMessages = [];
window.__probeDraft = 'draft-' + Math.random().toString(36).slice(2, 10);
window.addEventListener('message', function (event) {
  var data = event.data && typeof event.data === 'object' ? event.data : { raw: String(event.data) };
  window.__frameMessages.push({ at: performance.now(), data: data });
  console.log('page-frame-message:' + JSON.stringify(data));
});
</script>`

const GESTURE_MARKUP = '<button id="gesture">activate</button><input id="draft" value="">'

const GESTURE_SCRIPT = `<script>
window.__gestureClicks = 0;
document.getElementById('gesture').addEventListener('click', function () {
  window.__gestureClicks += 1;
  console.log('page-gesture-click');
});
document.getElementById('draft').value = window.__probeDraft;
document.getElementById('draft').addEventListener('input', function () { console.log('page-draft-input'); });
</script>`

const ONBEFOREUNLOAD_SCRIPT = `<script>
window.__protection = 'onbeforeunload';
window.onbeforeunload = function () {
  window.__beforeUnloadFired += 1;
  console.log('page-beforeunload-fired');
  return false;
};
</script>`

const LISTENER_SCRIPT = `<script>
window.__protection = 'addEventListener';
window.__probeRemove = function () {};
(function () {
  var handler = function (event) {
    window.__beforeUnloadFired += 1;
    console.log('page-beforeunload-fired');
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', handler);
  window.__probeRemove = function () { window.removeEventListener('beforeunload', handler); };
})();
</script>`

const LATE_SCRIPT = `<script>
window.__protection = 'late';
window.__lateProtection = false;
window.__armLateProtection = function (ms) {
  setTimeout(function () {
    window.onbeforeunload = function () {
      window.__beforeUnloadFired += 1;
      console.log('page-beforeunload-fired');
      return false;
    };
    window.__lateProtection = true;
    console.log('page-late-protection-set');
  }, ms);
  return true;
};
</script>`

function framePage(kind) {
  return `<!doctype html><meta charset="utf-8"><title>frame-${kind}</title>
<style>html,body{margin:0;height:100%}#frame-gesture{width:100%;height:100%;font:14px sans-serif}</style>
<button id="frame-gesture">frame activate (${kind})</button>
<script>
window.__protection = 'frame-onbeforeunload';
window.__frameBeforeUnloadFired = 0;
window.__frameGestureClicks = 0;
document.getElementById('frame-gesture').addEventListener('click', function () {
  window.__frameGestureClicks += 1;
  var activation = navigator.userActivation;
  parent.postMessage({
    probe: 'frame-click',
    frame: ${JSON.stringify(kind)},
    hasBeenActive: activation ? activation.hasBeenActive : null,
    isActive: activation ? activation.isActive : null
  }, '*');
  console.log('frame-gesture-click-${kind}');
});
window.onbeforeunload = function () {
  window.__frameBeforeUnloadFired += 1;
  parent.postMessage({ probe: 'frame-beforeunload', frame: ${JSON.stringify(kind)} }, '*');
  console.log('frame-beforeunload-fired');
  return false;
};
console.log('frame-ready-${kind}');
parent.postMessage({ probe: 'frame-ready', frame: ${JSON.stringify(kind)}, href: location.href }, '*');
</script>`
}

const FRAME_PAGE_SAME = framePage('same')
const FRAME_PAGE_CROSS = framePage('cross')

function pageHtml(name, body, scripts) {
  return `<!doctype html><meta charset="utf-8">${BASE_CSS}<title>nav-probe-${name}</title>${BASE_SCRIPT}<div id="content">${body}</div>${scripts || ''}`
}

function renderPage(name, ctx) {
  switch (name) {
    case 'none':
      return pageHtml('none', GESTURE_MARKUP, GESTURE_SCRIPT)
    case 'onbeforeunload':
      return pageHtml('onbeforeunload', GESTURE_MARKUP, GESTURE_SCRIPT + ONBEFOREUNLOAD_SCRIPT)
    case 'listener':
      return pageHtml('listener', GESTURE_MARKUP, GESTURE_SCRIPT + LISTENER_SCRIPT)
    case 'late':
      return pageHtml('late', GESTURE_MARKUP, GESTURE_SCRIPT + LATE_SCRIPT)
    case 'iframe-same':
      return pageHtml('iframe-same', `${GESTURE_MARKUP}<iframe id="frame" src="${ctx.origin}/frame-same"></iframe>`, GESTURE_SCRIPT)
    case 'iframe-cross':
      return pageHtml('iframe-cross', `${GESTURE_MARKUP}<iframe id="frame" src="${ctx.altOrigin}/frame-cross"></iframe>`, GESTURE_SCRIPT)
    default:
      return null
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => Number((performance.now() - T0).toFixed(3))

function makeServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    // req.url is a path only, so its origin has no port; rebuild the origin from
    // the Host header, otherwise the same-origin iframe src points at port 80.
    const origin = `http://${req.headers.host || '127.0.0.1'}`
    const ctx = { origin, altOrigin: url.searchParams.get('alt') || origin }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/host') return res.end(HOST_PAGE)
    if (url.pathname === '/frame-same') return res.end(FRAME_PAGE_SAME)
    if (url.pathname === '/frame-cross') return res.end(FRAME_PAGE_CROSS)
    const matched = url.pathname.match(/^\/page\/([A-Za-z0-9-]+)$/)
    if (matched) {
      const html = renderPage(matched[1], ctx)
      if (html) return res.end(html)
    }
    res.statusCode = 404
    res.end('not found')
  })
}

/* ------------------------------------------------------------------ */
/* Runner (plain Node)                                                */
/* ------------------------------------------------------------------ */

function uniqueRunDirs(name, round) {
  const dir = path.join(RUNS, `nav-${name}-r${round}`)
  const dirs = {
    root: dir,
    userData: path.join(dir, 'userData'),
    appData: path.join(dir, 'appData'),
    localAppData: path.join(dir, 'localAppData'),
    dshHome: path.join(dir, 'dshHome')
  }
  for (const value of Object.values(dirs)) fs.mkdirSync(value, { recursive: true })
  return dirs
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { alreadyExited: true }
  child.kill()
  const exited = await withTimeout(new Promise(resolve => { child.once('exit', () => resolve(true)) }), 4000, 'child-kill').catch(() => false)
  if (!exited) {
    try { child.kill('SIGKILL') } catch (error) { /* exact child only */ }
    return { forced: true }
  }
  return { killed: true }
}

async function runRunner() {
  fs.mkdirSync(RAW, { recursive: true })
  fs.mkdirSync(RUNS, { recursive: true })
  fs.mkdirSync(PROFILE_ROOT, { recursive: true })
  const onlyArg = process.argv.find(item => item.startsWith('--only='))
  const roundsArg = process.argv.find(item => item.startsWith('--rounds='))
  const roundArg = process.argv.find(item => item.startsWith('--round='))
  const only = onlyArg ? onlyArg.slice('--only='.length) : null
  const rounds = roundsArg ? Math.max(1, Number(roundsArg.slice('--rounds='.length)) || ROUNDS) : ROUNDS
  // --round=N re-runs exactly one existing case/round slot (creating that raw log
  // again) so an infrastructure failure can be repaired without rerunning the matrix.
  const singleRound = roundArg ? Math.max(1, Number(roundArg.slice('--round='.length)) || 1) : null
  if (singleRound && !only) throw new Error('--round=N requires --only=<case>')
  const roundList = singleRound ? [singleRound] : Array.from({ length: rounds }, (_, index) => index + 1)
  const selected = only ? CASES.filter(item => item.name === only) : CASES
  if (selected.length === 0) {
    throw new Error(`unknown --only=${only}; expected one of ${CASES.map(item => item.name).join(', ')}`)
  }
  const server = makeServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const altServer = makeServer()
  await new Promise(resolve => altServer.listen(0, '127.0.0.1', resolve))
  const altPort = altServer.address().port
  const altOrigin = `http://127.0.0.1:${altPort}`
  const electronPath = require('electron')
  let commit = null
  try {
    commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    commit = null
  }
  console.log(`probe origin=${origin} altOrigin=${altOrigin} rounds=${rounds} cases=${selected.length}`)
  const runs = []
  try {
    for (const round of roundList) {
      for (const definition of selected) {
        const started = Date.now()
        const dirs = uniqueRunDirs(definition.name, round)
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        delete env.ELECTRON_RENDERER_URL
        delete env.NODE_OPTIONS
        env.APPDATA = dirs.appData
        env.LOCALAPPDATA = dirs.localAppData
        env.DSH_HOME = dirs.dshHome
        env.NAV_PROBE_PROFILE = dirs.userData
        // NOTE: Chromium/Electron on Windows exits with code 127 before running the
        // app script when the command line carries two http:// URL arguments, so the
        // fixture endpoints are passed as --port/--alt-port switches, never as URLs.
        const childArgv = [__filename, `--case=${definition.name}`, `--round=${round}`, `--port=${port}`, `--alt-port=${altPort}`]
        const child = spawn(electronPath, childArgv, {
          cwd: ROOT,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-4096) })
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096) })
        let timedOut = false
        const killer = setTimeout(() => { timedOut = true }, RUN_TIMEOUT_MS)
        const killTimer = setTimeout(() => { stopChild(child).catch(() => {}) }, RUN_TIMEOUT_MS)
        const exit = await new Promise(resolve => {
          child.once('exit', (code, signal) => resolve({ code, signal }))
          child.once('error', error => resolve({ code: null, signal: null, error: error.message }))
        })
        clearTimeout(killer)
        clearTimeout(killTimer)
        const stop = await stopChild(child)
        const rawFile = path.join(RAW, `nav-${definition.name}-round-${round}.json`)
        let run = null
        if (fs.existsSync(rawFile)) {
          try { run = JSON.parse(fs.readFileSync(rawFile, 'utf8')) } catch (error) { run = null }
        }
        const record = {
          case: definition.name,
          round,
          argv: childArgv.map(item => path.basename(item).includes('navigation-close-probe') ? path.basename(item) : item),
          exitCode: exit.code,
          signal: exit.signal || null,
          timedOut,
          stop,
          error: exit.error || null,
          durationMs: Date.now() - started,
          stdoutTail: stdout || null,
          stderrTail: stderr || null,
          run
        }
        runs.push(record)
        const checksText = run && run.checks
          ? ['navigationCommitted', 'navigationRefused', 'jsExecutedTwice', 'closeAfterCommitDestroyedSameGuest', 'validEvidence']
            .map(key => `${key}=${run.checks[key]}`).join(',')
          : 'no-checks'
        console.log(`[${definition.name} r${round}] exit=${exit.code}${timedOut ? ' TIMEOUT' : ''} ${record.durationMs}ms class=${run ? run.classification : '-'} ${checksText}`)
        if (!run) {
          const tail = (stderr || stdout || '').trim().split('\n').slice(-10).join(' | ')
          console.log(`[${definition.name} r${round}] diagnostics: ${tail || '(no child output)'}`)
        }
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => altServer.close(resolve))
  }
  if (singleRound) {
    const record = runs[0]
    console.log(`[${record.case} r${record.round}] repair run exit=${record.exitCode} class=${record.run && record.run.classification}`)
    console.log('run --aggregate to rebuild the summary and report from all raw logs')
    return null
  }
  const summary = aggregate(runs, { commit, origin, altOrigin, rounds })
  const target = rounds === ROUNDS ? RESULT_FILE : path.join(RUNS, `smoke-${rounds}-results.json`)
  fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`wrote ${path.relative(ROOT, target)}`)
  if (rounds === ROUNDS) {
    fs.writeFileSync(REPORT_FILE, buildReport(summary))
    console.log(`wrote ${path.relative(ROOT, REPORT_FILE)}`)
  }
  for (const item of summary.cases) console.log(`${item.name}: ${item.verdict} (${item.classifications.join('/')})`)
  return summary
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                        */
/* ------------------------------------------------------------------ */

function listRawRuns() {
  if (!fs.existsSync(RAW)) return []
  const records = []
  for (const file of fs.readdirSync(RAW)) {
    const matched = file.match(/^nav-(.+)-round-(\d+)\.json$/)
    if (!matched) continue
    let run = null
    try { run = JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8')) } catch (error) { run = null }
    records.push({ case: matched[1], round: Number(matched[2]), file, run })
  }
  return records
}

function compactEvents(events) {
  return (events || []).slice(0, 220).map(item => {
    const out = { t: item.t, name: item.name }
    if (item.step) out.step = item.step
    if (item.message) out.message = item.message
    if (item.url) out.url = item.url
    if (item.destroyed !== undefined) out.destroyed = item.destroyed
    if (item.label) out.label = item.label
    if (item.params && item.params.type) out.dialog = item.params.type
    return out
  })
}

function aggregate(runs, meta) {
  const byCase = new Map()
  for (const record of runs) {
    if (!byCase.has(record.case)) byCase.set(record.case, [])
    byCase.get(record.case).push(record)
  }
  const totalRounds = meta.rounds || ROUNDS
  const cases = []
  for (const definition of CASES) {
    const records = (byCase.get(definition.name) || []).sort((a, b) => a.round - b.round)
    if (records.length === 0) continue
    const rounds = []
    for (let round = 1; round <= totalRounds; round++) {
      const record = records.find(item => item.round === round)
      if (!record || !record.run || record.exitCode !== 0) {
        rounds.push({
          round,
          status: 'error',
          exitCode: record ? record.exitCode : null,
          timedOut: record ? record.timedOut : null,
          stderrTail: record ? record.stderrTail : null,
          classification: 'inconclusive'
        })
        continue
      }
      const run = record.run
      const checks = run.checks || {}
      const mismatches = Object.entries(definition.expected || {})
        .filter(([key, value]) => checks[key] !== value)
        .map(([key, value]) => `${key}: expected ${value}, saw ${checks[key]}`)
      rounds.push({
        round,
        status: 'ok',
        durationMs: record.durationMs,
        classification: run.classification,
        checks,
        mismatches,
        observed: run.observed || null,
        versions: run.versions || null,
        setup: run.setup || null,
        steps: run.steps || [],
        timeline: compactEvents(run.events || []),
        proof: run.proof || null,
        closeOfBlank: run.closeOfBlank || null,
        cleanup: run.cleanup || null,
        errors: run.errors || []
      })
    }
    const okRounds = rounds.filter(item => item.status === 'ok')
    const classifications = okRounds.map(item => item.classification)
    const consistent = okRounds.length === totalRounds && classifications.every(value => value === classifications[0])
    let verdict
    if (okRounds.length !== totalRounds) verdict = 'inconclusive'
    else if (definition.exploratory) verdict = 'observed'
    else {
      const consistency = {}
      for (const key of Object.keys(definition.expected || {})) {
        const values = okRounds.map(item => item.checks[key])
        consistency[key] = { values, consistent: values.every(value => value === values[0]) }
      }
      const met = okRounds.every(item => item.mismatches.length === 0)
      const none = okRounds.every(item => Object.keys(definition.expected || {}).every(key => item.checks[key] !== definition.expected[key]))
      verdict = met ? 'expectation-met' : (none ? 'expectation-not-met' : 'mixed')
      rounds.consistency = consistency
    }
    const checksConsistency = {}
    const keys = new Set()
    for (const round of okRounds) for (const key of Object.keys(round.checks)) keys.add(key)
    for (const key of keys) {
      const values = okRounds.map(round => round.checks[key])
      checksConsistency[key] = { values, consistent: values.every(value => value === values[0]) }
    }
    cases.push({
      name: definition.name,
      config: {
        variant: definition.variant,
        protection: definition.protection,
        activation: definition.activation
      },
      purpose: definition.purpose,
      expectation: definition.expectation,
      exploratory: Boolean(definition.exploratory),
      primary: definition.primary,
      expected: definition.expected || {},
      verdict,
      classifications,
      classificationConsistent: consistent,
      checksConsistency,
      rounds
    })
  }

  const tri = (caseName, key) => {
    const item = cases.find(entry => entry.name === caseName)
    if (!item) return null
    const values = item.rounds.filter(round => round.status === 'ok').map(round => round.checks[key])
    if (values.length !== totalRounds) return null
    if (values.every(value => value === true)) return true
    if (values.every(value => value === false)) return false
    return null
  }
  const both = (a, b) => (a === null || b === null ? null : a && b)
  const allKinds = ['refuse-onbeforeunload-loadurl', 'refuse-listener-loadurl', 'refuse-iframe-same-loadurl', 'refuse-iframe-cross-loadurl']
  const refusedAny = allKinds.map(name => tri(name, 'navigationRefused'))
  const anyRefusal = refusedAny.some(value => value === true)

  const facts = {
    blankNavigationCommitsUnprotected: both(tri('allow-none-loadurl', 'navigationCommitted'), tri('allow-none-cdp', 'navigationCommitted')),
    blankCommitReplacesDocument: both(tri('allow-none-loadurl', 'blankDocumentFresh'), tri('allow-none-cdp', 'blankDocumentFresh')),
    closeOfBlankDestroysExactGuest: both(tri('allow-none-loadurl', 'closeAfterCommitDestroyedSameGuest'), tri('allow-none-cdp', 'closeAfterCommitDestroyedSameGuest')),
    loadURLRefusalCancelsNavigation: tri('refuse-onbeforeunload-loadurl', 'navigationRefused'),
    loadURLRefusalKeepsHeap: tri('refuse-onbeforeunload-loadurl', 'heapPreserved'),
    loadURLRefusalKeepsDraft: tri('refuse-onbeforeunload-loadurl', 'draftPreserved'),
    loadURLRefusalKeepsIdentity: tri('refuse-onbeforeunload-loadurl', 'identityPreserved'),
    loadURLRefusalKeepsSession: tri('refuse-onbeforeunload-loadurl', 'sessionPreserved'),
    loadURLRefusalKeepsGuestScriptable: tri('refuse-onbeforeunload-loadurl', 'jsExecutedTwice'),
    willPreventUnloadFiresOnNavigationRefusal: tri('refuse-onbeforeunload-loadurl', 'willPreventUnloadFired'),
    loadURLRefusalEvidenceValid: tri('refuse-onbeforeunload-loadurl', 'validEvidence'),
    cdpRefusalCancelsNavigation: tri('refuse-onbeforeunload-cdp', 'navigationRefused'),
    cdpDialogOpensOnNavigationRefusal: tri('refuse-onbeforeunload-cdp', 'dialogOpened'),
    cdpDenyAcceptedOnNavigationRefusal: tri('refuse-onbeforeunload-cdp', 'dialogDenyResolved'),
    cdpRefusalKeepsHeap: tri('refuse-onbeforeunload-cdp', 'heapPreserved'),
    cdpRefusalKeepsIdentity: tri('refuse-onbeforeunload-cdp', 'identityPreserved'),
    cdpRefusalKeepsSession: tri('refuse-onbeforeunload-cdp', 'sessionPreserved'),
    cdpRefusalKeepsGuestScriptable: tri('refuse-onbeforeunload-cdp', 'jsExecutedTwice'),
    addEventListenerRefusalCancelsNavigationLoadURL: tri('refuse-listener-loadurl', 'navigationRefused'),
    addEventListenerRefusalCancelsNavigationCdp: tri('refuse-listener-cdp', 'navigationRefused'),
    noActivationCommits: both(tri('refuse-noactivation-loadurl', 'navigationCommitted'), tri('refuse-noactivation-cdp', 'navigationCommitted')),
    noActivationDialogOpened: both(tri('refuse-noactivation-loadurl', 'dialogOpened'), tri('refuse-noactivation-cdp', 'dialogOpened')),
    lateProtectionLosesRaceLoadURL: tri('refuse-late-loadurl', 'navigationCommitted'),
    lateProtectionLosesRaceCdp: tri('refuse-late-cdp', 'navigationCommitted'),
    sameOriginFrameRefusalCancelsTopNavigationLoadURL: tri('refuse-iframe-same-loadurl', 'navigationRefused'),
    sameOriginFrameRefusalCancelsTopNavigationCdp: tri('refuse-iframe-same-cdp', 'navigationRefused'),
    crossOriginFrameRefusalCancelsTopNavigationLoadURL: tri('refuse-iframe-cross-loadurl', 'navigationRefused'),
    crossOriginFrameRefusalCancelsTopNavigationCdp: tri('refuse-iframe-cross-cdp', 'navigationRefused'),
    sameOriginFrameHandlerObservedOnNavigation: tri('refuse-iframe-same-loadurl', 'frameBeforeUnloadObserved'),
    crossOriginFrameHandlerObservedOnNavigation: tri('refuse-iframe-cross-loadurl', 'frameBeforeUnloadObserved'),
    anyRefusalObserved: anyRefusal,
    guestDestroyedByNavigation: tri('refuse-onbeforeunload-loadurl', 'guestDestroyed')
  }

  const loadUrlGate = facts.loadURLRefusalCancelsNavigation === true &&
    facts.loadURLRefusalKeepsHeap === true &&
    facts.loadURLRefusalKeepsDraft === true &&
    facts.loadURLRefusalKeepsIdentity === true &&
    facts.loadURLRefusalKeepsSession === true &&
    facts.loadURLRefusalKeepsGuestScriptable === true
  const cdpGate = facts.cdpRefusalCancelsNavigation === true &&
    facts.cdpRefusalKeepsHeap === true &&
    facts.cdpRefusalKeepsIdentity === true &&
    facts.cdpRefusalKeepsSession === true &&
    facts.cdpRefusalKeepsGuestScriptable === true
  const blankThenCloseGate = facts.blankNavigationCommitsUnprotected === true && facts.closeOfBlankDestroysExactGuest === true

  const statements = [
    `loadURL('about:blank') committed for an unprotected guest: ${facts.blankNavigationCommitsUnprotected}.`,
    `The blank commit replaced the original document: ${facts.blankCommitReplacesDocument}.`,
    `Closing the guest after the blank commit destroyed exactly that guest: ${facts.closeOfBlankDestroysExactGuest}.`,
    `will-prevent-unload fired on a refused loadURL navigation: ${facts.willPreventUnloadFiresOnNavigationRefusal}.`,
    `loadURL(about:blank) navigation was cancelled by onbeforeunload refusal: ${facts.loadURLRefusalCancelsNavigation}.`,
    `The refused loadURL navigation kept the original JS heap: ${facts.loadURLRefusalKeepsHeap}.`,
    `The refused loadURL navigation kept the DOM draft: ${facts.loadURLRefusalKeepsDraft}.`,
    `The refused loadURL navigation kept guest identity and native Session: ${facts.loadURLRefusalKeepsIdentity === true && facts.loadURLRefusalKeepsSession === true}.`,
    `The guest still executed JS twice after the refused loadURL navigation: ${facts.loadURLRefusalKeepsGuestScriptable}.`,
    `CDP Page.navigate(about:blank) navigation was cancelled by an explicitly denied beforeunload dialog: ${facts.cdpRefusalCancelsNavigation}.`,
    `A CDP beforeunload dialog opened on that navigation: ${facts.cdpDialogOpensOnNavigationRefusal}.`,
    `The denied CDP navigation kept the original JS heap: ${facts.cdpRefusalKeepsHeap}.`,
    `addEventListener(beforeunload) cancelled the navigation (loadURL / CDP): ${facts.addEventListenerRefusalCancelsNavigationLoadURL} / ${facts.addEventListenerRefusalCancelsNavigationCdp}.`,
    `Without sticky activation the navigation committed: ${facts.noActivationCommits}.`,
    `A protection installed after the navigation started still cancelled it (loadURL / CDP): ${facts.lateProtectionLosesRaceLoadURL === false} / ${facts.lateProtectionLosesRaceCdp === false}.`,
    `A same-origin child-frame refusal cancelled the top navigation (loadURL / CDP): ${facts.sameOriginFrameRefusalCancelsTopNavigationLoadURL} / ${facts.sameOriginFrameRefusalCancelsTopNavigationCdp}.`,
    `A cross-origin child-frame refusal cancelled the top navigation (loadURL / CDP): ${facts.crossOriginFrameRefusalCancelsTopNavigationLoadURL} / ${facts.crossOriginFrameRefusalCancelsTopNavigationCdp}.`
  ]

  const conclusion = {
    cancellableBlankNavigationLoadURL: loadUrlGate,
    cancellableBlankNavigationCdp: cdpGate,
    blankThenCloseSupported: blankThenCloseGate,
    navigationGateSupported: loadUrlGate || cdpGate,
    recommendation: (loadUrlGate || cdpGate)
      ? 'The tested navigation path is cancellable in this runtime: a refusing guest keeps its heap, draft, identity and Session, and a committing blank guest can be closed separately. This is still only fixture evidence; production still needs activation/demand protocol design and its own acceptance.'
      : 'Do not rely on blank navigation as an unconditional cancellable path for webview guests in this runtime: at least one required invariant (cancel, heap/draft survival, identity, Session, or scriptability) failed on every tested mechanism.',
    facts,
    statements
  }

  const runtime = {
    electron: process.versions.electron || require('electron/package.json').version,
    chrome: null,
    node: process.versions.node,
    v8: process.versions.v8,
    napi: process.versions.napi || null,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: (os.cpus()[0] || {}).model || null,
    totalMemoryBytes: os.totalmem()
  }
  const sample = cases[0] && cases[0].rounds.find(round => round.status === 'ok')
  // The child process is the interesting runtime: prefer its reported versions
  // over the plain-Node parent (e.g. Electron's bundled Node 24.21.0 vs 24.15.0).
  const sampleVersions = (sample && sample.versions) || {}
  for (const key of ['electron', 'chrome', 'node', 'v8', 'napi']) {
    if (sampleVersions[key]) runtime[key] = sampleVersions[key]
  }

  const summary = {
    schema: 1,
    kind: 'navigation-close-probe-results',
    generatedAt: new Date().toISOString(),
    checkout: path.relative(path.dirname(ROOT), ROOT).replace(/\\/g, '/'),
    commit: meta.commit || null,
    probe: 'scripts/shelf-memory-p0/navigation-close-probe.cjs',
    commands: {
      full: 'node scripts/shelf-memory-p0/navigation-close-probe.cjs',
      single: 'node scripts/shelf-memory-p0/navigation-close-probe.cjs --only=<case> --rounds=1',
      aggregate: 'node scripts/shelf-memory-p0/navigation-close-probe.cjs --aggregate',
      fixtures: `two loopback HTTP fixture origins (${meta.origin || 'origin'} and ${meta.altOrigin || 'altOrigin'}); no production UI, dist bundle, user profile or real session is loaded`
    },
    runtime,
    method: {
      rounds: totalRounds,
      cases: cases.length,
      caseMatrix: CASES.map(item => ({ name: item.name, variant: item.variant, protection: item.protection, activation: item.activation, exploratory: Boolean(item.exploratory) })),
      freshProcessPerCaseRound: true,
      freshUserDataPerRun: true,
      freshAppDataPerRun: true,
      freshDshHomePerRun: true,
      freshInMemoryPartitionPerRun: true,
      oneGuestPerRun: true,
      hostWindow: 'hidden BrowserWindow, webviewTag=true, sandbox=true, contextIsolation=true, nodeIntegration=false',
      guestPreferencesEnforced: 'will-attach-webview forces sandbox=true, contextIsolation=true, nodeIntegration=false, webSecurity=true, preload removed',
      mechanisms: {
        loadURL: "guest.loadURL('about:blank'); will-prevent-unload is observed but never preventDefault'ed (Electron default policy)",
        cdp: "Page.enable + Page.navigate({url:'about:blank'}); Page.javascriptDialogOpening is answered inline with Page.handleJavaScriptDialog({accept:false})"
      },
      activation: 'trusted CDP Input.dispatchMouseEvent click on the fixture button (top frame or inside the child frame)',
      survivalProof: 'two executeJavaScript calls after the navigation attempt (incrementing counter + reading the pre-existing marker/draft), plus identity and Session comparison',
      commitProof: 'did-start-navigation(isMainFrame, about:blank) + getURL()===about:blank + marker absent in the new document',
      destroyedProof: 'destroyed event on the exact WebContents, isDestroyed()===true, webContents.fromId(id) empty, absence from getAllWebContents(), webview element getWebContentsId()',
      boundedTimeouts: '50s per probe process, 60s per child, 4.5s navigation settle, 3s per dialog/close wait, 2-3s per observation probe'
    },
    cases,
    conclusion,
    rawEvidence: {
      pattern: 'tmp/navigation-close-probe/raw/nav-<case>-round-<n>.json',
      sanitized: true,
      note: 'Raw child reports contain only fixture URLs, loopback ports and relative profile paths; no credentials, tokens or environment dumps are written.',
      files: listRawRuns().filter(item => item.run).map(item => ({
        file: path.relative(ROOT, path.join(RAW, item.file)).replace(/\\/g, '/'),
        case: item.case,
        round: item.round,
        bytes: fs.statSync(path.join(RAW, item.file)).size
      }))
    },
    limitations: [
      'Three rounds per case; timings are observations, not latency percentiles.',
      'Hidden unfocused fixture window and synthetic (CDP Input) activation; visible/focused-window behaviour and real hardware input were not tested.',
      'about:blank is a special case (no network); navigation to real URLs, redirects, POST bodies and cross-origin top-level targets were not tested.',
      'Fixtures are synthetic loopback pages with no service workers, no cookies, no authentication and no real account or network.',
      'The child-frame cases measure whether a frame refusal cancels the top-level navigation; they are exploratory and do not assert production correctness.',
      'The demand race case is exploratory: it records event ordering only and asserts no production conclusion.',
      'beforeunload refusal semantics can differ for navigations initiated by the user vs. the embedder; only embedder-initiated navigation (loadURL / CDP Page.navigate) was tested.',
      'A draft value was installed by script in most cases and typed via trusted input only for top-activation cases; it proves document survival, not editor integration.',
      'Child reports are bounded (event cap, truncated console text); full page internals beyond the recorded probes were not inspected.'
    ]
  }
  return summary
}

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

function buildReport(summary) {
  const lines = []
  const facts = summary.conclusion.facts
  const flag = value => (value === true ? 'yes' : value === false ? 'no' : 'n/a')
  lines.push('# Blank-navigation cancellability probe (isolated runtime)')
  lines.push('')
  lines.push(`Generated: ${summary.generatedAt}`)
  lines.push(`Commit: \`${summary.commit || 'unknown'}\``)
  lines.push(`Runtime: Electron ${summary.runtime.electron}, Chromium ${summary.runtime.chrome || 'n/a'}, Node ${summary.runtime.node}, V8 ${summary.runtime.v8}, ${summary.runtime.platform}/${summary.runtime.arch}`)
  lines.push('')
  lines.push('## Question')
  lines.push('')
  lines.push('Can an existing sandboxed, context-isolated `<webview>` guest first be moved to `about:blank` in a cancellable way, keeping the original JS heap, DOM draft, guest identity and native Session when `beforeunload` refuses? If no refusal occurs and the blank commit succeeds, can that same blank guest then be closed and matched as destroyed?')
  lines.push('')
  lines.push('This is an experiment on synthetic loopback fixtures only. It is not authorization to discard arbitrary websites, and it does not enable generic sleep.')
  lines.push('')
  lines.push('## Method')
  lines.push('')
  lines.push(`- ${summary.method.rounds} rounds x ${summary.method.cases} cases; one Electron child process per case and round, fresh userData/appData/localAppData/DSH_HOME and a fresh in-memory partition each time.`)
  lines.push('- Host: hidden `BrowserWindow` with `webviewTag`; guest preferences enforced in `will-attach-webview` (`sandbox`, `contextIsolation`, `nodeIntegration=false`, `webSecurity`, preload removed).')
  lines.push('- Mechanism A: `guest.loadURL(\'about:blank\')` with the default `will-prevent-unload` policy; the probe never calls `preventDefault`.')
  lines.push('- Mechanism B: CDP `Page.navigate({url:\'about:blank\'})`, with `Page.javascriptDialogOpening` answered inline by `Page.handleJavaScriptDialog({accept:false})`. A protected dialog is never accepted.')
  lines.push('- Activation: trusted CDP `Input.dispatchMouseEvent` click (top frame, or inside the child frame for the iframe cases). Cases labelled `no activation` never dispatch input.')
  lines.push('- Validity: a refusal only counts as evidence when the requested activation was observed and the page/frame `beforeunload` handler actually fired.')
  lines.push('- Survival proof: two `executeJavaScript` calls after the attempt, comparing the pre-existing random marker, the draft value, the counter and the probe timeline, plus `webContents.id`, `webContents.fromId`, `getAllWebContents()` and the `Session` object identity.')
  lines.push('')
  lines.push('## Commands')
  lines.push('')
  lines.push('```')
  lines.push(summary.commands.full)
  lines.push('```')
  lines.push('')
  lines.push('## Per-case results')
  lines.push('')
  lines.push('| case | mechanism | activation | classification (per round) | verdict |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const item of summary.cases) {
    const classes = item.rounds.map(round => (round.status === 'ok' ? round.classification : 'error')).join(' / ')
    lines.push(`| ${item.name} | ${item.config.variant} | ${item.config.activation} | ${classes} | ${item.verdict} |`)
  }
  lines.push('')
  lines.push('## Key observations')
  lines.push('')
  lines.push(`- Unprotected guest navigated to \`about:blank\` and committed: **${flag(facts.blankNavigationCommitsUnprotected)}**; the original document was replaced: **${flag(facts.blankCommitReplacesDocument)}**.`)
  lines.push(`- Closing that same blank guest destroyed exactly that guest: **${flag(facts.closeOfBlankDestroysExactGuest)}**.`)
  lines.push(`- \`will-prevent-unload\` fired on a refused \`loadURL\` navigation: **${flag(facts.willPreventUnloadFiresOnNavigationRefusal)}**.`)
  lines.push(`- \`loadURL(about:blank)\` refusal cancelled the navigation: **${flag(facts.loadURLRefusalCancelsNavigation)}** (activation evidence valid: ${flag(facts.loadURLRefusalEvidenceValid)}).`)
  lines.push(`- Refused \`loadURL\` navigation preserved heap / draft / identity / Session / scriptability: **${flag(facts.loadURLRefusalKeepsHeap)} / ${flag(facts.loadURLRefusalKeepsDraft)} / ${flag(facts.loadURLRefusalKeepsIdentity)} / ${flag(facts.loadURLRefusalKeepsSession)} / ${flag(facts.loadURLRefusalKeepsGuestScriptable)}**.`)
  lines.push(`- CDP \`Page.navigate(about:blank)\` refusal cancelled the navigation: **${flag(facts.cdpRefusalCancelsNavigation)}**; a dialog opened: **${flag(facts.cdpDialogOpensOnNavigationRefusal)}**; deny accepted: **${flag(facts.cdpDenyAcceptedOnNavigationRefusal)}**.`)
  lines.push(`- Denied CDP navigation preserved heap / identity / Session / scriptability: **${flag(facts.cdpRefusalKeepsHeap)} / ${flag(facts.cdpRefusalKeepsIdentity)} / ${flag(facts.cdpRefusalKeepsSession)} / ${flag(facts.cdpRefusalKeepsGuestScriptable)}**.`)
  lines.push(`- \`addEventListener(beforeunload)\` refusal cancelled the navigation (loadURL / CDP): **${flag(facts.addEventListenerRefusalCancelsNavigationLoadURL)} / ${flag(facts.addEventListenerRefusalCancelsNavigationCdp)}**.`)
  lines.push(`- Without sticky activation the navigation committed: **${flag(facts.noActivationCommits)}**; a dialog opened: **${flag(facts.noActivationDialogOpened)}**.`)
  lines.push(`- Same-origin child-frame refusal cancelled the top navigation (loadURL / CDP): **${flag(facts.sameOriginFrameRefusalCancelsTopNavigationLoadURL)} / ${flag(facts.sameOriginFrameRefusalCancelsTopNavigationCdp)}**; the frame handler was observed at all: **${flag(facts.sameOriginFrameHandlerObservedOnNavigation)}**.`)
  lines.push(`- Cross-origin child-frame refusal cancelled the top navigation (loadURL / CDP): **${flag(facts.crossOriginFrameRefusalCancelsTopNavigationLoadURL)} / ${flag(facts.crossOriginFrameRefusalCancelsTopNavigationCdp)}**; the frame handler was observed at all: **${flag(facts.crossOriginFrameHandlerObservedOnNavigation)}**.`)
  lines.push(`- Protection installed after the navigation started still cancelled it (loadURL / CDP): **${flag(facts.lateProtectionLosesRaceLoadURL === false)} / ${flag(facts.lateProtectionLosesRaceCdp === false)}**.`)
  lines.push('')
  lines.push('## Verdict')
  lines.push('')
  lines.push(`- Cancellable blank navigation via \`loadURL\`: **${flag(summary.conclusion.cancellableBlankNavigationLoadURL)}**`)
  lines.push(`- Cancellable blank navigation via CDP \`Page.navigate\` + denied dialog: **${flag(summary.conclusion.cancellableBlankNavigationCdp)}**`)
  lines.push(`- Blank commit then close of the same guest: **${flag(summary.conclusion.blankThenCloseSupported)}**`)
  lines.push('')
  lines.push(summary.conclusion.recommendation)
  lines.push('')
  lines.push('## Mechanics detail (what distinguishes the outcomes)')
  lines.push('')
  for (const item of summary.cases) {
    const ok = item.rounds.filter(round => round.status === 'ok')
    if (ok.length === 0) continue
    const first = ok[0]
    const observed = first.observed || {}
    const nav = observed.navResponse || {}
    const kind = nav.kind || 'n/a'
    const code = nav.errorText || nav.error || (nav.errorCode !== undefined ? `errorCode ${nav.errorCode}` : 'none')
    lines.push(`- \`${item.name}\`: classify=${first.classification}; navigation response=${kind}; response detail=${String(code).slice(0, 120)}; will-prevent-unload events=${observed.willPreventUnloadCount !== undefined ? observed.willPreventUnloadCount : (first.checks.willPreventUnloadFired ? '>=1' : 0)}; dialogs=${observed.dialogCount !== undefined ? observed.dialogCount : (first.checks.dialogOpened ? '>=1' : 0)}; beforeunload observed=${first.checks.beforeUnloadObserved}; frame handler observed=${first.checks.frameBeforeUnloadObserved}; valid evidence=${first.checks.validEvidence}`)
  }
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  for (const item of summary.limitations) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Failures and unconfirmed rounds')
  lines.push('')
  const failures = []
  for (const item of summary.cases) {
    for (const round of item.rounds) {
      if (round.status !== 'ok') failures.push(`- \`${item.name}\` round ${round.round}: exit=${round.exitCode}, timedOut=${round.timedOut}, stderr tail: ${String(round.stderrTail || '').trim().split('\n').slice(-3).join(' | ') || '(none)'}`)
      else if (round.classification === 'unconfirmed-timeout') failures.push(`- \`${item.name}\` round ${round.round}: unconfirmed (timeout without commit or abort signal)`)
    }
  }
  lines.push(failures.length ? failures.join('\n') : '- None: every round produced a commit, a refusal or a destroyed classification.')
  lines.push('')
  lines.push('## Artifacts')
  lines.push('')
  lines.push('- Script: `scripts/shelf-memory-p0/navigation-close-probe.cjs`')
  lines.push('- Summary JSON: `docs/shelf-memory-p0/navigation-close-probe-results.json`')
  lines.push('- Raw sanitized per-round logs: `tmp/navigation-close-probe/raw/nav-<case>-round-<n>.json`')
  lines.push('- This report: `tmp/navigation-close-probe/report.md`')
  lines.push('')
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ */
/* Electron child                                                     */
/* ------------------------------------------------------------------ */

async function runElectron() {
  console.error('[probe] electron-entry', process.argv.slice(2).join(' '))
  const flag = prefix => {
    const found = process.argv.find(item => item.startsWith(`${prefix}=`))
    return found ? found.slice(prefix.length + 1) : null
  }
  const caseName = flag('--case')
  const round = Number(flag('--round'))
  const port = Number(flag('--port'))
  const altPort = Number(flag('--alt-port'))
  const origin = Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : null
  const altOrigin = Number.isInteger(altPort) && altPort > 0 && altPort < 65536 ? `http://127.0.0.1:${altPort}` : null
  const definition = CASES.find(item => item.name === caseName)
  if (!definition || !Number.isInteger(round) || round < 1 || round > ROUNDS || !origin || !altOrigin) {
    console.error(`invalid arguments: case=${caseName} round=${round} port=${port} altPort=${altPort}`)
    process.exit(2)
  }
  const { app, BrowserWindow, webContents, screen } = require('electron')
  process.on('uncaughtException', error => {
    console.error(`probe-crash: ${error && error.stack ? error.stack : error}`)
    process.exit(1)
  })
  const profile = process.env.NAV_PROBE_PROFILE || fs.mkdtempSync(path.join(PROFILE_ROOT, `p-${caseName}-${round}-`))
  fs.mkdirSync(profile, { recursive: true })
  try { app.setPath('userData', profile) } catch (error) { /* isolated path */ }
  try { app.setPath('sessionData', profile) } catch (error) { /* optional path */ }
  try { app.setPath('crashDumps', path.join(profile, 'crashDumps')) } catch (error) { /* optional path */ }
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.on('window-all-closed', () => {})

  const report = {
    schema: 1,
    kind: 'isolated-navigation-close-probe',
    case: caseName,
    round,
    startedAt: new Date().toISOString(),
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: (os.cpus()[0] || {}).model || null,
    totalMemoryBytes: os.totalmem(),
    profile: path.relative(ROOT, profile).replace(/\\/g, '/'),
    isolation: {
      freshUserData: true,
      freshAppData: Boolean(process.env.APPDATA && process.env.APPDATA.includes('navigation-close-probe')),
      freshLocalAppData: Boolean(process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.includes('navigation-close-probe')),
      freshDshHome: Boolean(process.env.DSH_HOME && process.env.DSH_HOME.includes('navigation-close-probe')),
      freshInMemoryPartition: true,
      hostHidden: true,
      hostPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      guestPreferencesEnforced: null,
      switches: ['no-proxy-server', 'disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']
    },
    setup: {},
    events: [],
    steps: [],
    checks: {},
    observed: {},
    proof: {},
    closeOfBlank: null,
    cleanup: null,
    errors: []
  }

  let host = null
  let guest = null
  let guestElement = null
  let destroyedAt = null
  let destroyedCount = 0
  let finished = false
  let debuggerAttachedByProbe = false
  let cdpListenerInstalled = false
  let cdpError = null
  let willEvents = []
  let dialogOpenings = []
  let dialogHandles = []
  let dialogClosedEvents = []
  let cdpMessages = []
  let consoleMessages = []
  let didNavigateEvents = []
  let didStartNavEvents = []
  let didFailLoadEvents = []
  let navFailure = null
  let navRec = null
  let demand = null
  let blankCommitted = false
  let abortedAt = null
  let sessionBefore = null
  let captured = null
  let baseline = null
  const dialogHandleSeq = []

  function mark(name, extra) {
    if (report.events.length >= 400) {
      report.eventsTruncated = true
      return
    }
    report.events.push(Object.assign({ t: now(), name }, extra || {}))
  }

  function trace(message) {
    console.error(`[probe ${caseName} r${round} t+${now()}ms] ${message}`)
  }

  function step(name, data) {
    const entry = Object.assign({ name, t: now() }, data || {})
    report.steps.push(entry)
    mark('step', { step: name })
    return entry
  }

  function finish(code, error) {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    if (error) report.errors.push(error.stack || String(error))
    report.finishedAt = new Date().toISOString()
    report.durationMs = now()
    try { if (guest && !guest.isDestroyed() && guest.debugger.isAttached() && debuggerAttachedByProbe) guest.debugger.detach() } catch (error) { /* teardown */ }
    try { if (host && !host.isDestroyed()) host.destroy() } catch (error) { /* teardown */ }
    fs.mkdirSync(RAW, { recursive: true })
    fs.writeFileSync(path.join(RAW, `nav-${caseName}-round-${round}.json`), `${JSON.stringify(report, null, 2)}\n`)
    app.exit(code)
  }

  const deadline = setTimeout(() => finish(1, new Error('probe deadline exceeded')), PROBE_DEADLINE_MS)
  process.on('uncaughtException', error => finish(1, error))
  process.on('unhandledRejection', error => { report.errors.push(`unhandledRejection: ${error && error.message}`) })

  app.whenReady().then(async () => {
    trace('ready')
    report.display = screen.getPrimaryDisplay()

    host = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      webPreferences: {
        webviewTag: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    host.webContents.setBackgroundThrottling(false)
    host.webContents.on('will-attach-webview', (event, preferences, params) => {
      if (!params.src || !params.src.startsWith(`${origin}/page/`)) {
        event.preventDefault()
        return
      }
      preferences.nodeIntegration = false
      preferences.contextIsolation = true
      preferences.sandbox = true
      preferences.webSecurity = true
      preferences.allowRunningInsecureContent = false
      delete preferences.preload
      report.isolation.guestPreferencesEnforced = {
        nodeIntegration: preferences.nodeIntegration,
        contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox,
        webSecurity: preferences.webSecurity,
        preload: preferences.preload === undefined ? 'removed' : 'present'
      }
    })
    const hostLoadStart = now()
    let hostLoadAttempts = 1
    try {
      await withTimeout(host.loadURL(`${origin}/host`), 20000, 'host-load')
    } catch (firstError) {
      // A single loopback host load has been observed to fail transiently with
      // ERR_NO_BUFFER_SPACE (-176) when many probe children run back to back.
      report.errors.push(`host load attempt 1 failed: ${firstError.message}`)
      await sleep(500)
      hostLoadAttempts = 2
      await withTimeout(host.loadURL(`${origin}/host`), 20000, 'host-load-retry')
    }
    trace('host-loaded')
    report.setup.hostLoadAttempts = hostLoadAttempts
    report.setup.hostLoadMs = Number((now() - hostLoadStart).toFixed(2))
    report.setup.hostBounds = host.getBounds()
    report.setup.hostVisible = host.isVisible()

    const partition = `nav-${caseName}-${round}-${crypto.randomUUID()}`
    const guestUrl = `${origin}/page/${definition.protection}?round=${round}&nonce=${crypto.randomUUID()}` +
      (definition.protection === 'iframe-cross' ? `&alt=${encodeURIComponent(altOrigin)}` : '')
    report.setup.partition = partition
    report.setup.guestUrl = guestUrl
    report.setup.altOrigin = altOrigin

    const attachStart = now()
    let resolveAttach
    let rejectAttach
    const attached = new Promise((resolve, reject) => { resolveAttach = resolve; rejectAttach = reject })
    const attachTimeout = setTimeout(() => rejectAttach(new Error('did-attach-webview timeout')), 15000)
    host.webContents.once('did-attach-webview', (_event, contents) => {
      clearTimeout(attachTimeout)
      guest = contents
      guestElement = 'attached'
      const guestId = contents.id
      try { guest.setBackgroundThrottling(false) } catch (error) { /* optional */ }

      guest.on('destroyed', () => {
        destroyedCount += 1
        if (destroyedAt === null) destroyedAt = now()
        mark('guest-destroyed')
      })
      guest.on('will-prevent-unload', event => {
        const entry = {
          at: now(),
          policy: 'never-preventDefault',
          defaultPreventedBefore: event.defaultPrevented,
          defaultPreventedAfter: event.defaultPrevented
        }
        willEvents.push(entry)
        mark('will-prevent-unload', entry)
      })
      guest.on('render-process-gone', (_e, details) => mark('render-process-gone', { reason: details.reason, exitCode: details.exitCode }))
      guest.on('console-message', (a, b, c) => {
        const message = a && typeof a === 'object' && typeof a.message === 'string'
          ? a.message
          : (typeof c === 'string' ? c : '')
        if (!/^(page-|frame-)/.test(message)) return
        consoleMessages.push({ at: now(), message: message.slice(0, 220) })
        mark('page-console', { message: message.slice(0, 220) })
      })
      guest.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
        const entry = { at: now(), url: String(url).slice(0, 220), isInPlace: Boolean(isInPlace), isMainFrame: Boolean(isMainFrame) }
        didStartNavEvents.push(entry)
        mark('did-start-navigation', entry)
      })
      guest.on('did-navigate', (_e, url, httpResponseCode, httpStatusText) => {
        const entry = { at: now(), url: String(url).slice(0, 220), httpResponseCode, httpStatusText }
        didNavigateEvents.push(entry)
        if (entry.url === 'about:blank') blankCommitted = true
        mark('did-navigate', entry)
      })
      guest.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        const entry = { at: now(), errorCode, errorDescription, validatedURL: String(validatedURL || '').slice(0, 220), isMainFrame: Boolean(isMainFrame) }
        didFailLoadEvents.push(entry)
        mark('did-fail-load', entry)
        if (entry.isMainFrame) navFailure = entry
      })
      guest.on('did-finish-load', () => mark('did-finish-load', { url: String(guest.getURL() || '').slice(0, 120) }))

      let settleLoad
      const load = new Promise((resolve, reject) => {
        settleLoad = resolve
        const timer = setTimeout(() => reject(new Error('guest did-finish-load timeout')), 15000)
        guest.once('did-finish-load', () => { clearTimeout(timer); resolve('did-finish-load') })
        guest.once('did-fail-load', (_e, code, description, url, isMainFrame) => {
          if (!isMainFrame) return
          clearTimeout(timer)
          reject(new Error(`did-fail-load ${code} ${description} ${url}`))
        })
        if (!guest.isLoadingMainFrame()) { clearTimeout(timer); settleLoad('already-loaded') }
      })
      resolveAttach({ guest, load, guestId })
    })
    await host.webContents.executeJavaScript(`(() => {
      const element = document.createElement('webview');
      element.id = 'probe-guest';
      element.setAttribute('partition', ${JSON.stringify(partition)});
      element.setAttribute('src', ${JSON.stringify(guestUrl)});
      element.style.cssText = 'width:900px;height:620px;display:flex';
      document.body.append(element);
      return true;
    })()`)
    const attachResult = await attached
    const guestId = attachResult.guestId
    trace('guest-attached')
    report.setup.guestLoad = await attachResult.load
    trace(`guest-loaded:${report.setup.guestLoad}`)
    report.setup.guestLoadMs = Number((now() - attachStart).toFixed(2))
    report.setup.guestId = guestId
    report.setup.guestType = guest.getType()
    report.setup.guestProcessId = guest.getProcessId()
    report.setup.guestOsProcessId = guest.getOSProcessId()
    sessionBefore = guest.session
    report.setup.session = {
      sameObjectAsCaptured: true,
      storagePath: (() => {
        try { return path.relative(ROOT, String(sessionBefore.getStoragePath() || '')).replace(/\\/g, '/') } catch (error) { return null }
      })()
    }
    captured = { guestId, urlAtCapture: guest.getURL() }

    /* -------------------- probe helpers -------------------- */

    const snapshotExpr = `(() => {
      const draft = document.getElementById('draft');
      const frame = document.getElementById('frame');
      const frameWindow = frame ? frame.contentWindow : null;
      const readFrame = (reader) => { try { return reader(frameWindow) } catch (error) { return null } };
      const activation = navigator.userActivation;
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        marker: (typeof window.__probeMarker === 'string') ? window.__probeMarker : null,
        markerType: typeof window.__probeMarker,
        draft: draft ? draft.value : null,
        ticks: window.__probeTicks || 0,
        beforeUnloadFired: window.__beforeUnloadFired || 0,
        gestureClicks: window.__gestureClicks || 0,
        protection: window.__protection || null,
        lateProtection: Boolean(window.__lateProtection),
        activation: activation ? { isActive: activation.isActive, hasBeenActive: activation.hasBeenActive } : null,
        navigationEntries: performance.getEntriesByType('navigation').length,
        framePresent: Boolean(frame),
        frameSrc: frame ? String(frame.src || '') : null,
        frameMessages: Array.isArray(window.__frameMessages) ? window.__frameMessages.slice(-24) : [],
        frameHandler: frameWindow ? readFrame(w => typeof w.onbeforeunload === 'function') : null,
        frameFired: frameWindow ? readFrame(w => w.__frameBeforeUnloadFired || 0) : null,
        frameActivation: frameWindow ? readFrame(w => w.navigator.userActivation ? { isActive: w.navigator.userActivation.isActive, hasBeenActive: w.navigator.userActivation.hasBeenActive } : null) : null,
        bodyChildren: document.body ? document.body.children.length : null,
        nodeTypes: { process: typeof process, require: typeof require, module: typeof module }
      };
    })()`

    const blankExpr = `(() => ({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      markerType: typeof window.__probeMarker,
      hasDraft: Boolean(document.getElementById('draft')),
      bodyChildren: document.body ? document.body.children.length : null
    }))()`

    async function evalGuest(expr, label, ms) {
      return withTimeout(guest.executeJavaScript(expr), ms || 3000, label || 'eval')
    }

    async function snapshot(label) {
      return evalGuest(snapshotExpr, label || 'snapshot').catch(error => ({ error: error.message }))
    }

    function isListed() {
      try { return webContents.getAllWebContents().some(item => item.id === guestId) } catch (error) { return false }
    }

    function fromIdMatches() {
      try {
        const found = webContents.fromId(guestId)
        return found === guest && found !== null && found !== undefined
      } catch (error) { return false }
    }

    function fromIdGone() {
      try {
        const found = webContents.fromId(guestId)
        return found === null || found === undefined
      } catch (error) { return true }
    }

    async function guestElementState() {
      try {
        return await withTimeout(host.webContents.executeJavaScript(`(() => {
          const element = document.getElementById('probe-guest');
          if (!element) return { present: false };
          let id = null, error = null;
          try { id = element.getWebContentsId(); } catch (caught) { error = caught.message; }
          return { present: true, webContentsId: id, error };
        })()`), 1500, 'guestElementState')
      } catch (error) {
        return { error: error.message }
      }
    }

    async function proveAlive(label) {
      const info = { label, at: now(), isDestroyed: guest.isDestroyed(), listed: isListed(), idMatches: fromIdMatches() }
      if (info.isDestroyed) return info
      try {
        info.first = await evalGuest(`(() => {
          window.__probeTicks = (window.__probeTicks || 0) + 1;
          const draft = document.getElementById('draft');
          return {
            ticks: window.__probeTicks,
            href: location.href,
            marker: (typeof window.__probeMarker === 'string') ? window.__probeMarker : null,
            draft: draft ? draft.value : null,
            beforeUnloadFired: window.__beforeUnloadFired || 0,
            at: performance.now()
          };
        })()`, 'prove-1', 1500)
        info.second = await evalGuest(`(() => {
          window.__probeTicks = (window.__probeTicks || 0) + 1;
          const draft = document.getElementById('draft');
          return {
            ticks: window.__probeTicks,
            href: location.href,
            marker: (typeof window.__probeMarker === 'string') ? window.__probeMarker : null,
            draft: draft ? draft.value : null,
            at: performance.now()
          };
        })()`, 'prove-2', 1500)
        info.jsExecutedTwice = Boolean(info.first && info.second &&
          info.second.ticks === info.first.ticks + 1 &&
          info.second.at >= info.first.at)
        info.isDestroyed = guest.isDestroyed()
        info.listed = isListed()
      } catch (error) {
        info.error = error.message
      }
      return info
    }

    async function waitForDestroyed(ms) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (guest.isDestroyed() || destroyedAt !== null) return true
        await sleep(20)
      }
      return guest.isDestroyed() || destroyedAt !== null
    }

    // Close the guest that currently holds about:blank and prove the destroyed
    // WebContents is the same one that was captured before the navigation.
    async function closeBlankGuest() {
      const record = { calledAt: now(), id: guestId, urlBefore: guest.isDestroyed() ? null : guest.getURL() }
      record.detached = detachDebugger('close-blank')
      mark('close-called', { waitForBeforeUnload: false, urlBefore: record.urlBefore })
      try { guest.close() } catch (error) { record.closeError = error.message }
      record.destroyed = await waitForDestroyed(3000)
      record.isDestroyed = guest.isDestroyed()
      record.destroyedEvent = destroyedCount > 0
      record.destroyedAt = destroyedAt
      record.idGone = fromIdGone()
      record.listed = isListed()
      record.guestElement = await guestElementState()
      mark('close-result', { destroyed: record.isDestroyed, destroyedEvent: record.destroyedEvent, listed: record.listed })
      return record
    }

    /* -------------------- CDP -------------------- */

    function cdpBusyError() {
      const error = new Error('cdp-unavailable: debugger already attached by another client')
      error.code = 'CDP_BUSY'
      return error
    }

    function onCdpDetach(_event, reason) {
      mark('cdp-detach', { reason })
      if (reason !== 'target closed') debuggerAttachedByProbe = false
    }

    function onCdpMessage(_event, method, params, sessionId) {
      if (!/^Page\.(javascriptDialog|frameNavigated|frameStartedLoading|frameStoppedLoading)|^Inspector\.detached/.test(method)) return
      const entry = { at: now(), method }
      if (method === 'Page.javascriptDialogOpening') {
        entry.params = {
          type: params ? params.type : null,
          message: params ? String(params.message || '').slice(0, 200) : null,
          url: params ? String(params.url || '').slice(0, 220) : null,
          hasBrowserHandler: params ? params.hasBrowserHandler : null,
          defaultPrompt: params ? params.defaultPrompt : null
        }
        dialogOpenings.push(entry)
        mark('dialog-opening', entry.params)
        // Explicit deny, sent immediately on the opening event so no polling race
        // exists between the dialog and the handler. Never accept.
        const handle = { accept: false, at: now(), state: 'pending', seq: dialogHandles.length }
        dialogHandles.push(handle)
        dialogHandleSeq.push(handle)
        guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).then(
          value => { handle.state = 'resolved'; handle.value = value; handle.settledAt = now() },
          error => { handle.state = 'rejected'; handle.error = error.message; handle.settledAt = now() }
        )
      } else if (method === 'Page.javascriptDialogClosed') {
        entry.params = { result: params ? params.result : null, userInput: params ? params.userInput : null }
        dialogClosedEvents.push(entry)
      } else if (method === 'Page.frameNavigated') {
        entry.params = {
          url: params && params.frame ? String(params.frame.url || '').slice(0, 220) : null,
          parentId: params && params.frame ? Boolean(params.frame.parentId) : null,
          loaderId: params && params.frame ? params.frame.loaderId || null : null
        }
        mark('cdp-frame-navigated', entry.params)
      }
      if (cdpMessages.length < 200) cdpMessages.push(entry)
      if (method !== 'Page.frameNavigated') mark('cdp-message', { method })
    }

    function attachDebugger() {
      if (guest.debugger.isAttached()) {
        if (!debuggerAttachedByProbe) throw cdpBusyError()
        return
      }
      guest.debugger.attach('1.3')
      debuggerAttachedByProbe = true
      if (!cdpListenerInstalled) {
        guest.debugger.on('message', onCdpMessage)
        guest.debugger.on('detach', onCdpDetach)
        cdpListenerInstalled = true
      }
      mark('debugger-attached')
    }

    function detachDebugger(label) {
      const record = { label, at: now(), wasAttached: false, attachedByProbe: debuggerAttachedByProbe }
      if (guest.isDestroyed()) {
        record.skipped = 'guest-destroyed'
        debuggerAttachedByProbe = false
        return record
      }
      record.wasAttached = guest.debugger.isAttached()
      if (record.wasAttached && debuggerAttachedByProbe) {
        try { guest.debugger.detach(); record.detached = true } catch (error) { record.error = error.message }
      } else if (record.wasAttached) {
        record.skipped = 'not-attached-by-probe'
      }
      debuggerAttachedByProbe = false
      mark('debugger-detach-request', record)
      return record
    }

    async function cdp(method, params, ms) {
      return withTimeout(guest.debugger.sendCommand(method, params), ms || 3000, method)
    }

    /* -------------------- fixture actions -------------------- */

    async function dispatchClickAt(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    }

    async function activateTop() {
      const rect = await evalGuest(`(() => {
        const button = document.getElementById('gesture');
        const bounds = button.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      })()`, 'gesture-rect')
      attachDebugger()
      await dispatchClickAt(rect.x, rect.y)
      let activation = (await snapshot('activation-top')).activation
      let method = 'cdp-trusted-mouse'
      if (!activation || !activation.hasBeenActive) {
        await guest.executeJavaScript("document.getElementById('gesture').click(); true", true)
        activation = (await snapshot('activation-top-fallback')).activation
        method = 'executeJavaScript-userGesture-fallback'
      }
      return { scope: 'top', method, rect, activation, verified: Boolean(activation && activation.hasBeenActive) }
    }

    async function activateFrame() {
      const rect = await evalGuest(`(() => {
        const frame = document.getElementById('frame');
        const bounds = frame.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, width: bounds.width, height: bounds.height, src: String(frame.src || '') };
      })()`, 'frame-rect')
      attachDebugger()
      await dispatchClickAt(rect.x, rect.y)
      const deadline = Date.now() + 2500
      let snap = await snapshot('frame-activation-1')
      let clickMessage = null
      while (Date.now() < deadline && !clickMessage) {
        const messages = (snap.frameMessages || []).map(item => item.data).filter(Boolean)
        clickMessage = messages.find(data => data.probe === 'frame-click') || null
        if (clickMessage) break
        await sleep(60)
        snap = await snapshot('frame-activation-poll')
      }
      const direct = snap.frameActivation
      return {
        scope: 'frame',
        method: clickMessage ? 'cdp-trusted-mouse+frame-postmessage' : 'cdp-trusted-mouse+direct-read',
        rect,
        clickMessage,
        direct,
        verified: Boolean(clickMessage ? clickMessage.hasBeenActive === true : direct && direct.hasBeenActive === true)
      }
    }

    async function typeTrustedDraft() {
      await evalGuest("document.getElementById('draft').value = ''; true", 'draft-clear')
      const rect = await evalGuest(`(() => {
        const input = document.getElementById('draft');
        const bounds = input.getBoundingClientRect();
        return { x: bounds.left + 12, y: bounds.top + bounds.height / 2 };
      })()`, 'draft-rect')
      attachDebugger()
      await dispatchClickAt(rect.x, rect.y)
      const text = `typed-${Math.random().toString(36).slice(2, 10)}`
      await cdp('Input.insertText', { text })
      const value = await evalGuest("document.getElementById('draft').value")
      return { method: 'cdp-click+insertText', text, value, applied: value === text }
    }

    /* -------------------- navigation -------------------- */

    function trackLoadURL(url) {
      const record = { kind: 'loadURL', method: 'loadURL', at: now(), state: 'pending', url }
      guest.loadURL(url).then(
        value => { record.state = 'resolved'; record.value = value === undefined ? null : value; record.settledAt = now() },
        error => { record.state = 'rejected'; record.error = error && error.message ? error.message : String(error); record.settledAt = now() }
      )
      return record
    }

    function trackCdpNavigate(url) {
      const record = { kind: 'cdp', method: 'Page.navigate', at: now(), state: 'pending', url }
      guest.debugger.sendCommand('Page.navigate', { url }).then(
        value => { record.state = 'resolved'; record.value = value || null; record.settledAt = now() },
        error => { record.state = 'rejected'; record.error = error && error.message ? error.message : String(error); record.settledAt = now() }
      )
      return record
    }

    function cdpErrorText() {
      if (!navRec) return null
      if (navRec.state === 'resolved' && navRec.value && navRec.value.errorText) return String(navRec.value.errorText)
      if (navRec.state === 'rejected' && navRec.error) return String(navRec.error)
      return null
    }

    function abortSignal() {
      const fromFailure = Boolean(navFailure && navFailure.errorCode === -3)
      const fromResponse = /ERR_ABORTED/.test(String(cdpErrorText() || ''))
      return fromFailure || fromResponse
    }

    async function waitNavigationSettle(ms) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (guest.isDestroyed() || destroyedAt !== null) return 'destroyed'
        if (blankCommitted && guest.getURL() === 'about:blank') return 'committed'
        const url = guest.getURL()
        if (url === 'about:blank') { blankCommitted = true; return 'committed' }
        if (navFailure && navFailure.errorCode !== 0) return 'failed'
        if (navRec && navRec.state === 'rejected' && navRec.kind === 'loadURL') return 'failed'
        // A cancelled navigation does not always surface as did-fail-load for the
        // CDP path: Page.navigate can resolve with net::ERR_ABORTED while the
        // guest simply never commits. Treat that abort as a refusal, but give the
        // unload evidence (will-prevent-unload / dialog) a short grace window.
        if (abortSignal()) {
          if (abortedAt === null) abortedAt = now()
          else if (now() - abortedAt > 700) return 'failed'
        }
        await sleep(40)
      }
      if (guest.isDestroyed()) return 'destroyed'
      if (guest.getURL() === 'about:blank') return 'committed'
      if (navFailure && navFailure.errorCode !== 0) return 'failed'
      if (navRec && navRec.state === 'rejected') return 'failed'
      if (abortSignal()) return 'failed'
      return 'timeout'
    }

    function classify(state) {
      if (cdpError && cdpError.code === 'CDP_BUSY') return 'cdp-unavailable-fail-safe'
      if (state === 'destroyed') return demand ? 'race-guest-destroyed-by-demand' : 'guest-destroyed-during-navigation'
      if (state === 'committed') {
        if (report.closeOfBlank) return report.closeOfBlank.destroyed ? 'blank-commit-then-close-same-guest' : 'blank-commit-but-close-unconfirmed'
        return 'blank-committed'
      }
      if (state === 'failed') {
        if (dialogOpenings.length > 0 && dialogHandles.some(handle => handle.state === 'resolved')) return 'navigation-cancelled-by-denied-cdp-dialog'
        if (dialogHandles.some(handle => handle.state === 'rejected')) return 'navigation-cancelled-dialog-handle-rejected'
        if (willEvents.length > 0) return 'navigation-cancelled-by-default-unload-policy'
        if (consoleMessages.some(item => item.message === 'page-beforeunload-fired')) return 'navigation-cancelled-without-dialog-or-will-event'
        return 'navigation-aborted-without-unload-evidence'
      }
      if (dialogHandles.some(handle => handle.state === 'rejected')) return 'dialog-handle-rejected-without-navigation-outcome'
      return 'unconfirmed-timeout'
    }

    /* -------------------- experiment -------------------- */

    // Child frames load asynchronously, so wait for the frame fixture to report
    // readiness before the baseline snapshot and the fixture gate are evaluated.
    if (definition.protection === 'iframe-same' || definition.protection === 'iframe-cross') {
      const frameStart = now()
      const frameEnd = Date.now() + 5000
      let ready = null
      let readyOk = false
      while (Date.now() < frameEnd) {
        ready = await snapshot('frame-wait').catch(() => null)
        const readyMessage = Boolean(ready && (ready.frameMessages || []).some(item => item.data && item.data.probe === 'frame-ready'))
        const handlerOk = definition.protection === 'iframe-cross' ? true : Boolean(ready && ready.frameHandler === true)
        if (readyMessage && handlerOk) { readyOk = true; break }
        await sleep(80)
      }
      report.setup.frameWait = {
        ok: readyOk,
        elapsedMs: Number((now() - frameStart).toFixed(2)),
        frameSrc: ready ? ready.frameSrc : null,
        frameHandler: ready ? ready.frameHandler : null,
        framePresent: ready ? ready.framePresent : null
      }
      if (!readyOk) report.errors.push('child frame did not report readiness before the deadline')
    }

    report.setup.page = await snapshot('baseline')
    if (report.setup.page.error) report.errors.push(`baseline snapshot failed: ${report.setup.page.error}`)
    if (report.setup.page.nodeTypes && (report.setup.page.nodeTypes.process !== 'undefined' || report.setup.page.nodeTypes.require !== 'undefined')) {
      report.errors.push('guest isolation check failed: node globals are reachable')
    }

    const fixture = { kind: definition.protection, ok: false, detail: null }
    const base = report.setup.page
    if (definition.protection === 'none') {
      fixture.ok = base.marker !== null && base.markerType === 'string'
      fixture.detail = { marker: base.marker, protection: base.protection }
    } else if (definition.protection === 'onbeforeunload') {
      fixture.ok = base.protection === 'onbeforeunload' && Boolean(base.beforeUnloadFired === 0)
      fixture.detail = { protection: base.protection }
    } else if (definition.protection === 'listener') {
      fixture.ok = base.protection === 'addEventListener'
      fixture.detail = { protection: base.protection }
    } else if (definition.protection === 'late') {
      const armed = await evalGuest("typeof window.__armLateProtection === 'function'", 'late-check').catch(() => false)
      fixture.ok = armed === true && base.protection === 'late'
      fixture.detail = { protection: base.protection, armed }
    } else if (definition.protection === 'iframe-same' || definition.protection === 'iframe-cross') {
      const frameKind = definition.protection === 'iframe-same' ? 'same' : 'cross'
      fixture.detail = {
        framePresent: base.framePresent,
        frameSrc: base.frameSrc,
        frameHandler: base.frameHandler,
        frameFired: base.frameFired,
        readyMessage: (base.frameMessages || []).some(item => item.data && item.data.probe === 'frame-ready')
      }
      if (definition.protection === 'iframe-same') {
        fixture.ok = base.framePresent === true && base.frameHandler === true && Boolean(base.frameSrc && base.frameSrc.startsWith(origin))
      } else {
        fixture.ok = base.framePresent === true && Boolean(fixture.detail.readyMessage) && Boolean(base.frameSrc && base.frameSrc.startsWith(altOrigin))
      }
    }
    report.fixture = fixture
    if (!fixture.ok) report.errors.push(`fixture check failed: expected ${definition.protection}`)

    // 1. activation (before the draft so a trusted click cannot disturb the draft value)
    let activationEvidence = { scope: 'none', verified: false, method: 'none' }
    try {
      if (definition.activation === 'top') activationEvidence = await activateTop()
      else if (definition.activation === 'frame') activationEvidence = await activateFrame()
      else activationEvidence = { scope: 'none', method: 'no-input-dispatched', verified: false }
    } catch (error) {
      if (error && error.code === 'CDP_BUSY') {
        cdpError = error
        report.errors.push(`cdp unavailable: ${error.message}`)
      } else {
        report.errors.push(`activation failed: ${error.message}`)
      }
    }
    step('activation', activationEvidence)

    // 2. draft (trusted typing where the design has top-frame activation; scripted otherwise)
    let draftEvidence = { method: 'scripted-at-load', value: base.draft }
    if (definition.trustedDraft && !cdpError) {
      try {
        const typed = await typeTrustedDraft()
        draftEvidence = typed
        if (!typed.applied) report.errors.push(`trusted draft typing did not apply: expected ${typed.text}, saw ${typed.value}`)
      } catch (error) {
        if (error && error.code === 'CDP_BUSY') cdpError = error
        report.errors.push(`trusted draft typing failed: ${error.message}`)
      }
    }
    step('draft', draftEvidence)

    // 3. detach before a loadURL navigation so no debugger can influence the default policy
    if (definition.variant === 'loadURL') detachDebugger('pre-navigation')

    baseline = await snapshot('baseline-final')
    if (!baseline || baseline.error) {
      report.errors.push(`baseline final snapshot failed: ${baseline && baseline.error}`)
    }
    step('baseline', {
      href: baseline.href,
      marker: baseline.marker,
      draft: baseline.draft,
      activation: baseline.activation,
      ticks: baseline.ticks
    })

    // 4. navigation
    const navStart = now()
    mark('navigation-start', { variant: definition.variant, url: 'about:blank' })
    if (definition.protection === 'late') {
      await evalGuest('window.__armLateProtection(250); true', 'arm-late')
      mark('late-protection-armed', { afterMs: 250 })
    }
    try {
      if (definition.variant === 'loadURL') {
        navRec = trackLoadURL('about:blank')
      } else {
        attachDebugger()
        await cdp('Page.enable', {})
        mark('page-domain-enabled')
        navRec = trackCdpNavigate('about:blank')
      }
    } catch (error) {
      if (error && error.code === 'CDP_BUSY') cdpError = error
      report.errors.push(`navigation start failed: ${error.message}`)
    }

    // 5. optional demand race (exploratory)
    if (caseName === 'race-demand-during-nav') {
      demand = { scheduledAt: now(), afterMs: 30, state: 'scheduled' }
      setTimeout(() => {
        if (!guest || guest.isDestroyed()) { demand.state = 'skipped-destroyed'; return }
        demand.state = 'called'
        demand.calledAt = now()
        mark('demand-close-called', { waitForBeforeUnload: true })
        try { guest.close({ waitForBeforeUnload: true }) } catch (error) { demand.error = error.message }
      }, 30)
    }

    const settleState = await waitNavigationSettle(NAV_SETTLE_MS)
    step('navigation-settle', { state: settleState, elapsedMs: Number((now() - navStart).toFixed(2)) })
    trace(`settle:${settleState} url=${guest.isDestroyed() ? '(destroyed)' : guest.getURL()}`)

    const destroyed = guest.isDestroyed() || destroyedAt !== null
    let blankSnapshot = null
    let blankFresh = null
    if (settleState === 'committed' && !destroyed) {
      blankSnapshot = await evalGuest(blankExpr, 'blank-snapshot', 2000).catch(error => ({ error: error.message }))
      blankFresh = Boolean(blankSnapshot && !blankSnapshot.error && blankSnapshot.markerType === 'undefined' && blankSnapshot.href === 'about:blank')
      // let the load settle fully before closing
      await withTimeout(new Promise(resolve => guest.once('did-finish-load', resolve)), 1500, 'blank-finish-load').catch(() => null)
      report.closeOfBlank = await closeBlankGuest()
    }

    // 6. refusal proof (only when the navigation did not commit and the guest is alive)
    let after = null
    let proof = null
    const destroyedNow = guest.isDestroyed() || destroyedAt !== null
    const debuggerDetach = destroyedNow ? null : detachDebugger('pre-proof')
    if (!destroyedNow && settleState !== 'committed') {
      await sleep(150)
      proof = await proveAlive('after-refusal')
      after = await snapshot('after-refusal')
      step('proof', {
        jsExecutedTwice: proof.jsExecutedTwice,
        ticks: proof.first ? proof.first.ticks : null,
        href: after && after.href,
        marker: after && after.marker,
        draft: after && after.draft,
        activation: after && after.activation
      })
    }

    const finalDestroyed = guest.isDestroyed() || destroyedAt !== null
    const committed = settleState === 'committed' || (blankSnapshot !== null)
    const urlNow = finalDestroyed ? null : guest.getURL()
    const urlUnchanged = Boolean(after && baseline && after.href === baseline.href)
    const aborted = abortSignal()
    const refused = !committed && !finalDestroyed && (aborted || Boolean(navRec && navRec.state === 'rejected')) && urlUnchanged

    const frameMessages = (after && after.frameMessages) || (baseline && baseline.frameMessages) || []
    const frameData = frameMessages.map(item => item.data).filter(Boolean)
    const frameClick = frameData.find(data => data.probe === 'frame-click') || null
    const frameBeforeUnload = frameData.find(data => data.probe === 'frame-beforeunload') || null
    const topBeforeUnload = Boolean(
      consoleMessages.some(item => item.message === 'page-beforeunload-fired') ||
      (after && after.beforeUnloadFired > 0) ||
      (baseline && baseline.beforeUnloadFired > 0) ||
      (report.setup.page && report.setup.page.beforeUnloadFired > 0)
    )
    const frameBeforeUnloadObserved = Boolean(
      consoleMessages.some(item => item.message === 'frame-beforeunload-fired') ||
      frameBeforeUnload ||
      (after && typeof after.frameFired === 'number' && after.frameFired > 0) ||
      (after && (after.frameMessages || []).some(item => item.data && item.data.probe === 'frame-beforeunload'))
    )
    const dialogDenyResolved = dialogHandles.length > 0 && dialogHandles.every(handle => handle.state === 'resolved')
    const dialogDenyRejected = dialogHandles.some(handle => handle.state === 'rejected')
    const sessionSame = Boolean(!finalDestroyed && guest.session === sessionBefore)
    const sessionPath = (() => {
      try { return path.relative(ROOT, String(guest.session.getStoragePath() || '')).replace(/\\/g, '/') } catch (error) { return null }
    })()

    const checks = {
      fixtureOk: fixture.ok,
      activationObserved: activationEvidence.verified === true,
      activationAbsent: activationEvidence.verified === false,
      beforeUnloadObserved: topBeforeUnload,
      frameBeforeUnloadObserved,
      willPreventUnloadFired: willEvents.length > 0,
      dialogOpened: dialogOpenings.length > 0,
      dialogDenyResolved,
      dialogRejected: dialogDenyRejected,
      debuggerDetachedBeforeProof: Boolean(debuggerDetach && debuggerDetach.wasAttached && debuggerDetach.detached) || !debuggerDetach || !debuggerDetach.wasAttached || finalDestroyed,
      navigationStartedMainFrameBlank: didStartNavEvents.some(item => item.url === 'about:blank' && item.isMainFrame !== false),
      navigationCommitted: committed,
      navigationRefused: refused,
      mainFrameBlankCommit: Boolean(committed && blankFresh && didStartNavEvents.some(item => item.url === 'about:blank' && item.isMainFrame !== false)),
      blankDocumentFresh: blankFresh === true,
      heapPreserved: Boolean(!committed && !finalDestroyed && after && baseline && after.marker === baseline.marker && after.marker !== null && after.href === baseline.href),
      draftPreserved: Boolean(!committed && after && baseline && typeof baseline.draft === 'string' && baseline.draft.length > 0 && after.draft === baseline.draft),
      identityPreserved: Boolean(!finalDestroyed && fromIdMatches()),
      sessionPreserved: Boolean(sessionSame),
      jsExecutedTwice: Boolean(proof && proof.jsExecutedTwice),
      guestDestroyed: finalDestroyed,
      closeAfterCommitDestroyedSameGuest: Boolean(report.closeOfBlank && report.closeOfBlank.destroyed && report.closeOfBlank.destroyedEvent && report.closeOfBlank.idGone && report.closeOfBlank.listed === false),
      raceDemandCalled: Boolean(demand && demand.state === 'called'),
      raceDestroyedByDemand: Boolean(demand && demand.state === 'called' && finalDestroyed)
    }
    const activationDesignMet = definition.activation === 'none' ? checks.activationAbsent === true : checks.activationObserved === true
    const unloadEvidencePresent = checks.beforeUnloadObserved || checks.frameBeforeUnloadObserved
    checks.activationDesignMet = activationDesignMet
    checks.unloadEvidencePresent = unloadEvidencePresent
    checks.validEvidence = Boolean(activationDesignMet && (unloadEvidencePresent || checks.navigationCommitted))
    report.checks = checks

    report.observed = {
      variant: definition.variant,
      protection: definition.protection,
      activationDesign: definition.activation,
      settleState,
      classification: classify(settleState),
      navResponse: {
        kind: navRec ? navRec.kind : null,
        state: navRec ? navRec.state : null,
        error: navRec ? navRec.error || null : null,
        errorText: cdpErrorText(),
        value: navRec && navRec.value ? navRec.value : null,
        errorCode: navFailure ? navFailure.errorCode : null,
        errorDescription: navFailure ? navFailure.errorDescription : null,
        settledAt: navRec ? navRec.settledAt || null : null
      },
      willPreventUnloadCount: willEvents.length,
      dialogCount: dialogOpenings.length,
      dialogOpenings,
      dialogHandles,
      dialogClosedEvents,
      beforeUnloadObserved: topBeforeUnload,
      frameBeforeUnloadObserved,
      frameClick,
      frameBeforeUnload,
      activationEvidence,
      draftEvidence,
      baseline: baseline ? { href: baseline.href, marker: baseline.marker, draft: baseline.draft, activation: baseline.activation, ticks: baseline.ticks } : null,
      after: after ? { href: after.href, marker: after.marker, draft: after.draft, ticks: after.ticks, activation: after.activation, beforeUnloadFired: after.beforeUnloadFired, frameFired: after.frameFired } : null,
      urlNow,
      urlUnchanged,
      aborted,
      deniedDialogMechanism: dialogOpenings.length > 0 ? 'cdp' : (willEvents.length > 0 ? 'default-policy' : (aborted ? 'unknown-abort' : 'none')),
      blankSnapshot,
      sessionSameObject: sessionSame,
      sessionStoragePath: sessionPath,
      consoleMessages,
      didNavigateEvents,
      didStartNavEvents,
      didFailLoadEvents,
      demand,
      debuggerDetach,
      cdpMessages
    }
    report.proof = {
      baseline: baseline ? { marker: baseline.marker, draft: baseline.draft, href: baseline.href } : null,
      after,
      proveAlive: proof,
      identity: finalDestroyed ? null : { guestId, fromIdMatches: fromIdMatches(), listed: isListed(), sessionSameObject: sessionSame },
      blankDocument: blankSnapshot
    }

    // 7. cleanup: destroy whatever is still alive, then tear the host down
    const cleanup = { at: now(), wasAlive: !guest.isDestroyed(), destroyedBeforeCleanup: guest.isDestroyed() }
    if (guest.isDestroyed()) {
      try {
        await withTimeout(host.webContents.executeJavaScript("document.getElementById('probe-guest')?.remove(); true"), 1500, 'cleanup-remove-destroyed')
      } catch (error) {
        cleanup.removeError = error.message
      }
    } else {
      detachDebugger('cleanup')
      try {
        await evalGuest(`(() => {
          try { if (window.__probeRemove) window.__probeRemove(); } catch (error) {}
          window.onbeforeunload = null;
          const frame = document.getElementById('frame');
          if (frame && frame.contentWindow) { try { frame.contentWindow.onbeforeunload = null; } catch (error) {} }
          return true;
        })()`, 'cleanup-clear', 1500)
      } catch (error) {
        cleanup.clearError = error.message
      }
      try { guest.close() } catch (error) { cleanup.closeError = error.message }
      cleanup.destroyed = await waitForDestroyed(2500)
      if (!cleanup.destroyed) {
        try {
          await withTimeout(host.webContents.executeJavaScript("document.getElementById('probe-guest')?.remove(); true"), 1500, 'cleanup-remove')
        } catch (error) {
          cleanup.removeError = error.message
        }
        cleanup.destroyed = await waitForDestroyed(2000)
      }
    }
    cleanup.isDestroyed = guest.isDestroyed()
    cleanup.listed = isListed()
    cleanup.guestElement = await guestElementState()
    report.cleanup = cleanup
    mark('cleanup', { destroyed: cleanup.isDestroyed, wasAlive: cleanup.wasAlive })
    if (cleanup.wasAlive && !cleanup.isDestroyed) report.errors.push('cleanup did not destroy the guest')

    report.classification = report.observed.classification
    trace(`experiment-done classification=${report.classification}`)
    finish(0)
  }).catch(error => finish(1, error))
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

function readCommit() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

if (process.argv.includes('--list')) {
  for (const item of CASES) console.log(`${item.name} [${item.variant}/${item.protection}/activation=${item.activation}${item.exploratory ? '/exploratory' : ''}]`)
} else if (process.argv.includes('--aggregate')) {
  const runs = listRawRuns().map(record => ({
    case: record.case,
    round: record.round,
    exitCode: record.run ? 0 : null,
    timedOut: false,
    run: record.run,
    durationMs: record.run ? record.run.durationMs : null,
    stderrTail: null
  }))
  const summary = aggregate(runs, { commit: readCommit(), rounds: ROUNDS })
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(REPORT_FILE, buildReport(summary))
  console.log(`wrote ${path.relative(ROOT, RESULT_FILE)}`)
  console.log(`wrote ${path.relative(ROOT, REPORT_FILE)}`)
  for (const item of summary.cases) console.log(`${item.name}: ${item.verdict} (${item.classifications.join('/')})`)
} else if (IS_ELECTRON) {
  runElectron()
} else {
  runRunner().catch(error => {
    console.error(error.stack || String(error))
    process.exitCode = 1
  })
}
