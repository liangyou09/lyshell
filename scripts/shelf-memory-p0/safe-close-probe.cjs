#!/usr/bin/env node
/*
 * Isolated runtime probe: is there a genuinely cancellable <webview> close path
 * in the installed Electron (43.7.11)?
 *
 * Scope / isolation:
 * - Never loads LyShell's production UI, dist bundle, user profile or user pages.
 * - Every run gets a fresh Electron userData profile, a fresh in-memory webview
 *   partition and exactly one guest; the fixture is a loopback HTTP server.
 * - Guests are sandboxed, context-isolated, nodeIntegration=false.
 * - Proof of survival is always executeJavaScript() running twice in the guest
 *   after the close attempt, never a GET or a DOM scan.
 *
 * Usage:
 *   node scripts/shelf-memory-p0/safe-close-probe.cjs                 # 3 rounds, all experiments
 *   node scripts/shelf-memory-p0/safe-close-probe.cjs --only=cdp-deny-gesture
 *   node scripts/shelf-memory-p0/safe-close-probe.cjs --rounds=1      # fast pass
 *   node scripts/shelf-memory-p0/safe-close-probe.cjs --aggregate     # rebuild JSON from raw
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
const OUT = path.join(ROOT, 'tmp/deep-sleep-probe')
const RAW = path.join(OUT, 'raw')
const RESULT_FILE = path.join(ROOT, 'docs/shelf-memory-p0/safe-close-probe-results.json')
const ROUNDS = 3
const RUN_TIMEOUT_MS = 60000
const PROBE_DEADLINE_MS = 50000

const EXPERIMENTS = [
  {
    name: 'allow-none',
    primary: 'destroyed',
    purpose: 'Control: an unprotected page should be destroyed by a protected close.',
    expectation: 'close({waitForBeforeUnload:true}) destroys the guest and fires no will-prevent-unload.',
    expected: { willPreventUnloadFired: false, destroyed: true, destroyedEvent: true }
  },
  {
    name: 'refuse-onbeforeunload',
    primary: 'survivedFirstClose',
    purpose: 'Reproduce window.onbeforeunload=()=>false with the documented default (main never calls preventDefault).',
    expectation: 'The guest survives the protected close, stays scriptable, survives a second close, and closes after the handler is removed.',
    expected: { willPreventUnloadFired: true, survivedFirstClose: true, jsExecutedAfterRefusal: true, secondCloseAlsoRefused: true, destroyedAfterHandlerRemoved: true }
  },
  {
    name: 'allow-via-preventDefault',
    primary: 'destroyed',
    purpose: 'Control for the documented escape hatch: preventDefault on will-prevent-unload permits unload.',
    expectation: 'preventDefault on will-prevent-unload makes the protected close destroy the guest.',
    expected: { willPreventUnloadFired: true, willEventDefaultPrevented: true, destroyed: true }
  },
  {
    name: 'refuse-addEventListener',
    primary: 'survivedFirstClose',
    purpose: 'Check whether modern addEventListener(beforeunload) + preventDefault/returnValue is honoured.',
    expectation: 'The guest survives the protected close and closes after the listener is removed.',
    expected: { willPreventUnloadFired: true, survivedFirstClose: true, jsExecutedAfterRefusal: true, destroyedAfterHandlerRemoved: true }
  },
  {
    name: 'refuse-iframe',
    primary: 'survivedFirstClose',
    purpose: 'Check whether a same-origin child frame with beforeunload protects the top guest.',
    expectation: 'The guest survives because the child frame refuses unload.',
    expected: { willPreventUnloadFired: true, survivedFirstClose: true, jsExecutedAfterRefusal: true }
  },
  {
    name: 'refuse-gesture',
    primary: 'survivedFirstClose',
    purpose: 'Check whether sticky user activation changes refusal under webContents.close.',
    expectation: 'With activation, the guest still survives the protected close.',
    expected: { pageActivationTrue: true, willPreventUnloadFired: true, survivedFirstClose: true, jsExecutedAfterRefusal: true }
  },
  {
    name: 'cdp-deny-gesture',
    primary: 'survivedFirstClose',
    purpose: 'Test CDP Page.close({runBeforeUnload:true}) + Page.javascriptDialogOpening + Page.handleJavaScriptDialog(accept:false), with activation.',
    expectation: 'The beforeunload dialog opens, deny keeps the guest alive and scriptable, including after detaching the debugger.',
    expected: { pageActivationTrue: true, dialogOpened: true, dialogTypeBeforeunload: true, denyAccepted: true, survivedFirstClose: true, jsExecutedAfterRefusal: true, survivedAfterDetach: true }
  },
  {
    name: 'cdp-accept-gesture',
    primary: 'destroyed',
    purpose: 'Control for CDP: accepting the beforeunload dialog must close the guest.',
    expectation: 'The dialog opens and accept:true destroys the guest.',
    expected: { pageActivationTrue: true, dialogOpened: true, dialogTypeBeforeunload: true, acceptAccepted: true, destroyed: true }
  },
  {
    name: 'cdp-deny-no-gesture',
    primary: 'destroyed',
    purpose: 'Check whether the CDP beforeunload dialog is available without user activation.',
    expectation: 'Without activation the dialog is skipped and the guest closes, so deny is impossible.',
    expected: { pageActivationFalse: true, dialogOpened: false, destroyed: true }
  },
  {
    name: 'cdp-deny-inline',
    primary: 'survivedFirstClose',
    purpose: 'Remove the polling race by replying deny inside the CDP dialogOpening message handler itself.',
    expectation: 'Even an immediate deny keeps the guest alive and scriptable; if it is still destroyed, the CDP close path cannot be cancelled at all.',
    expected: { pageActivationTrue: true, dialogOpened: true, denyInlineResolved: true, survivedFirstClose: true, jsExecutedAfterRefusal: true }
  },
  {
    name: 'window-close-default',
    primary: 'survived',
    purpose: 'Control: does the same close option honour a refusal for a normal BrowserWindow WebContents (not a webview guest)?',
    expectation: 'The documented behaviour (page prevents unload => WebContents is not closed) holds for a BrowserWindow, isolating any failure to webview guests.',
    expected: { willPreventUnloadFired: true, survived: true, jsExecutedAfterRefusal: true }
  },
  {
    name: 'race-late-protection',
    primary: 'destroyed',
    purpose: 'Check the asynchronous protection-change race: the page installs a handler 150ms after the protected close starts.',
    expectation: 'The close is already in flight, so the guest is destroyed and the late handler never takes effect.',
    expected: { closeCalledBeforeProtection: true, destroyed: true }
  }
]

const FIXTURES = {
  'allow-none': 'none',
  'refuse-iframe': 'iframe',
  'race-late-protection': 'race'
}

for (const experiment of EXPERIMENTS) {
  experiment.expected = Object.assign({ fixtureOk: true }, experiment.expected)
}

const HOST_PAGE = '<!doctype html><meta charset="utf-8"><title>probe host</title><body></body>'

const PAGE_HEAD = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;font:16px sans-serif}#content{padding:24px}</style>'
const beforeUnloadScript = `<script>
window.__protection = 'onbeforeunload';
window.__beforeUnloadFired = 0;
window.onbeforeunload = () => { window.__beforeUnloadFired += 1; console.log('page-beforeunload-fired'); return false; };
</script>`
const addEventListenerScript = `<script>
window.__protection = 'addEventListener';
window.__beforeUnloadFired = 0;
window.__probeRemove = () => {};
{
  const handler = (event) => { window.__beforeUnloadFired += 1; event.preventDefault(); event.returnValue = ''; console.log('page-beforeunload-fired'); };
  window.addEventListener('beforeunload', handler);
  window.__probeRemove = () => window.removeEventListener('beforeunload', handler);
}
</script>`
const gestureScript = `<button id="gesture" style="position:fixed;left:20px;top:20px;width:240px;height:70px">activate</button>
<script>
window.__gestureClicks = 0;
document.getElementById('gesture').addEventListener('click', () => { window.__gestureClicks += 1; console.log('page-gesture-click'); });
</script>`

function page(name, body, script) {
  return `${PAGE_HEAD}<title>probe-${name}</title><div id="content">${body}</div>${script || ''}`
}

const PAGES = {
  'allow-none': page('allow-none', 'unprotected fixture page'),
  'refuse-onbeforeunload': page('refuse-onbeforeunload', 'protected fixture page', beforeUnloadScript),
  'allow-via-preventDefault': page('allow-via-preventDefault', 'protected fixture page', beforeUnloadScript),
  'refuse-addEventListener': page('refuse-addEventListener', 'protected with addEventListener', addEventListenerScript),
  'refuse-iframe': page('refuse-iframe', 'top frame without handler<iframe id="frame" src="/frame" style="display:block;width:320px;height:120px"></iframe>'),
  'refuse-gesture': page('refuse-gesture', 'protected + activation button', beforeUnloadScript + gestureScript),
  'cdp-deny-gesture': page('cdp-deny-gesture', 'protected + activation button', beforeUnloadScript + gestureScript),
  'cdp-accept-gesture': page('cdp-accept-gesture', 'protected + activation button', beforeUnloadScript + gestureScript),
  'cdp-deny-no-gesture': page('cdp-deny-no-gesture', 'protected fixture page', beforeUnloadScript),
  'cdp-deny-inline': page('cdp-deny-inline', 'protected + activation button', beforeUnloadScript + gestureScript),
  'race-late-protection': page('race-late-protection', 'protection scheduled after close', `<script>
window.__lateProtection = false;
window.__armLateProtection = (ms) => {
  setTimeout(() => {
    window.onbeforeunload = () => { window.__beforeUnloadFired = (window.__beforeUnloadFired || 0) + 1; console.log('page-late-beforeunload-fired'); return false; };
    window.__lateProtection = true;
    console.log('page-late-protection-set');
  }, ms);
  return true;
};
console.log('page-race-armed');
</script>`)
}

const FRAME_PAGE = `<!doctype html><meta charset="utf-8"><title>probe frame</title>
<script>
window.__frameBeforeUnloadFired = 0;
window.onbeforeunload = () => { window.__frameBeforeUnloadFired += 1; console.log('frame-beforeunload-fired'); return false; };
</script>
<p id="frame-content">same-origin frame</p>`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => Number((performance.now() - T0).toFixed(3))

/* ------------------------------------------------------------------ */
/* Runner (plain Node)                                                */
/* ------------------------------------------------------------------ */

function makeServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/host') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end(HOST_PAGE)
    }
    if (url.pathname === '/frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end(FRAME_PAGE)
    }
    const matched = url.pathname.match(/^\/page\/([A-Za-z0-9-]+)$/)
    if (matched && PAGES[matched[1]] !== undefined) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end(PAGES[matched[1]])
    }
    res.statusCode = 404
    res.end('not found')
  })
}

async function runRunner() {
  fs.mkdirSync(RAW, { recursive: true })
  const onlyArg = process.argv.find(item => item.startsWith('--only='))
  const roundsArg = process.argv.find(item => item.startsWith('--rounds='))
  const only = onlyArg ? onlyArg.slice('--only='.length) : null
  const rounds = roundsArg ? Math.max(1, Number(roundsArg.slice('--rounds='.length)) || ROUNDS) : ROUNDS
  const selected = only ? EXPERIMENTS.filter(item => item.name === only) : EXPERIMENTS
  if (selected.length === 0) {
    throw new Error(`unknown --only=${only}; expected one of ${EXPERIMENTS.map(item => item.name).join(', ')}`)
  }
  const server = makeServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const electronPath = require('electron')
  let commit = null
  try {
    commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    commit = null
  }
  const runs = []
  try {
    for (let round = 1; round <= rounds; round++) {
      for (const experiment of selected) {
        const started = Date.now()
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        delete env.ELECTRON_RENDERER_URL
        const child = spawn(electronPath, [__filename, experiment.name, String(round), origin], {
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
        const killer = setTimeout(() => { timedOut = true; child.kill() }, RUN_TIMEOUT_MS)
        const exit = await new Promise(resolve => {
          child.once('exit', (code, signal) => resolve({ code, signal }))
          child.once('error', error => resolve({ code: null, signal: null, error: error.message }))
        })
        clearTimeout(killer)
        const rawFile = path.join(RAW, `exp-${experiment.name}-round-${round}.json`)
        let run = null
        if (fs.existsSync(rawFile)) {
          try { run = JSON.parse(fs.readFileSync(rawFile, 'utf8')) } catch (error) { run = null }
        }
        const record = {
          experiment: experiment.name,
          round,
          exitCode: exit.code,
          signal: exit.signal || null,
          timedOut,
          error: exit.error || null,
          durationMs: Date.now() - started,
          stdoutTail: stdout || null,
          stderrTail: stderr || null,
          run
        }
        runs.push(record)
        const checkText = run && run.checks ? Object.entries(run.checks).map(([key, value]) => `${key}=${value}`).join(',') : 'no-checks'
        console.log(`[${experiment.name} r${round}] exit=${exit.code}${timedOut ? ' TIMEOUT' : ''} ${record.durationMs}ms ${checkText}`)
        if (!run && (timedOut || exit.code !== 0)) {
          const tail = (stderr || stdout || '').trim().split('\n').slice(-8).join(' | ')
          console.log(`[${experiment.name} r${round}] diagnostics: ${tail || '(no child output)'}`)
        }
      }
    }
  } finally {
    server.close()
  }
  const summary = aggregate(runs, { commit, origin })
  console.log(`wrote ${path.relative(ROOT, RESULT_FILE)}`)
  for (const experiment of summary.experiments) console.log(`${experiment.name}: ${experiment.verdict}`)
  return summary
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                        */
/* ------------------------------------------------------------------ */

function listRawRuns() {
  if (!fs.existsSync(RAW)) return []
  const records = []
  for (const file of fs.readdirSync(RAW)) {
    const matched = file.match(/^exp-(.+)-round-(\d+)\.json$/)
    if (!matched) continue
    let run = null
    try { run = JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8')) } catch (error) { run = null }
    records.push({ experiment: matched[1], round: Number(matched[2]), file, run })
  }
  return records
}

function aggregate(runs, meta) {
  const byExperiment = new Map()
  for (const record of runs) {
    if (!byExperiment.has(record.experiment)) byExperiment.set(record.experiment, [])
    byExperiment.get(record.experiment).push(record)
  }
  const experiments = []
  for (const definition of EXPERIMENTS) {
    const records = (byExperiment.get(definition.name) || []).sort((a, b) => a.round - b.round)
    const rounds = []
    for (let round = 1; round <= ROUNDS; round++) {
      const record = records.find(item => item.round === round)
      if (!record || !record.run || record.exitCode !== 0) {
        rounds.push({
          round,
          status: 'error',
          exitCode: record ? record.exitCode : null,
          timedOut: record ? record.timedOut : null,
          stderrTail: record ? record.stderrTail : null,
          verdict: 'inconclusive'
        })
        continue
      }
      const run = record.run
      const primary = definition.primary
      const primaryValue = run.checks ? run.checks[primary] : null
      const verdict = primaryValue === definition.expected[primary] ? 'expectation-met' : 'expectation-not-met'
      rounds.push({
        round,
        status: 'ok',
        durationMs: record.durationMs,
        verdict,
        primary,
        primaryValue,
        expected: definition.expected,
        checks: run.checks,
        actual: run.observed || null,
        setup: run.setup || null,
        steps: run.steps || [],
        events: compactEvents(run.events || []),
        proof: run.proof || null,
        cleanup: run.cleanup || null,
        errors: run.errors || []
      })
    }
    const primary = definition.primary
    const primaryValues = rounds.filter(item => item.status === 'ok').map(item => item.primaryValue)
    let verdict
    if (rounds.some(item => item.status !== 'ok')) verdict = 'inconclusive'
    else if (primaryValues.every(value => value === definition.expected[primary])) verdict = 'expectation-met'
    else if (primaryValues.every(value => value !== definition.expected[primary])) verdict = 'expectation-not-met'
    else verdict = 'mixed'
    const actualChecks = {}
    for (const key of Object.keys(definition.expected)) {
      const values = rounds.filter(item => item.status === 'ok').map(item => item.checks ? item.checks[key] : null)
      actualChecks[key] = {
        values,
        consistent: values.length === ROUNDS && values.every(value => value === values[0])
      }
    }
    experiments.push({
      name: definition.name,
      purpose: definition.purpose,
      expectation: definition.expectation,
      primary,
      primaryValues,
      expected: definition.expected,
      verdict,
      actualChecks,
      rounds
    })
  }

  const tri = (experiment, key) => {
    const item = experiments.find(entry => entry.name === experiment)
    if (!item) return null
    const values = item.rounds.filter(round => round.status === 'ok').map(round => round.checks ? round.checks[key] : null)
    if (values.length !== ROUNDS) return null
    if (values.every(value => value === true)) return true
    if (values.every(value => value === false)) return false
    return null
  }

  const facts = {
    protectedCloseDefaultKeepsGuest: tri('refuse-onbeforeunload', 'survivedFirstClose'),
    protectedCloseDefaultDestroys: tri('refuse-onbeforeunload', 'survivedFirstClose') === false,
    willPreventUnloadFiredOnRefusal: tri('refuse-onbeforeunload', 'willPreventUnloadFired'),
    preventDefaultPermitsUnload: tri('allow-via-preventDefault', 'destroyed'),
    addEventListenerRefusalWorks: tri('refuse-addEventListener', 'survivedFirstClose'),
    iframeRefusalWorks: tri('refuse-iframe', 'survivedFirstClose'),
    activationRefusalWorks: tri('refuse-gesture', 'survivedFirstClose'),
    cdpDialogOpensWithActivation: tri('cdp-deny-gesture', 'dialogOpened') === true && tri('cdp-accept-gesture', 'dialogOpened') === true,
    cdpDenyKeepsGuestAlive: tri('cdp-deny-gesture', 'survivedFirstClose') === true && tri('cdp-deny-gesture', 'jsExecutedAfterRefusal') === true && tri('cdp-deny-gesture', 'survivedAfterDetach') === true,
    cdpInlineDenyKeepsGuestAlive: tri('cdp-deny-inline', 'survivedFirstClose') === true && tri('cdp-deny-inline', 'jsExecutedAfterRefusal') === true,
    cdpDialogAutoDeniedButGuestDestroyed: tri('cdp-deny-inline', 'dialogOpened') === true && tri('cdp-deny-inline', 'survivedFirstClose') === false,
    cdpAcceptCloses: tri('cdp-accept-gesture', 'destroyed') === true,
    cdpDialogNeedsActivation: tri('cdp-deny-no-gesture', 'dialogOpened') === false,
    lateProtectionLosesRace: tri('race-late-protection', 'destroyed') === true,
    browserWindowCloseKeepsAlive: tri('window-close-default', 'survived')
  }

  let safePath
  if (facts.protectedCloseDefaultKeepsGuest === true) {
    safePath = 'webContents.close({waitForBeforeUnload:true}) already keeps a refusing guest alive under the default will-prevent-unload policy; no additional mechanism is required.'
  } else if (facts.cdpDenyKeepsGuestAlive === true || facts.cdpInlineDenyKeepsGuestAlive === true) {
    safePath = 'CDP Page.close({runBeforeUnload:true}) with Page.javascriptDialogOpening + Page.handleJavaScriptDialog({accept:false}) keeps a refusing guest alive, but only when the beforeunload dialog is shown and replied to (sticky user activation is required in this runtime).'
  } else if (facts.protectedCloseDefaultKeepsGuest === false && facts.cdpDenyKeepsGuestAlive === false && facts.cdpInlineDenyKeepsGuestAlive === false) {
    safePath = `No tested native close path was both cancellable and usable for webview guests: webContents.close({waitForBeforeUnload:true}) destroys the guest despite will-prevent-unload, and CDP Page.close({runBeforeUnload:true}) destroys it even when the beforeunload dialog is explicitly denied.${facts.browserWindowCloseKeepsAlive === true ? ' The same close option kept a BrowserWindow WebContents alive, so the failure is specific to webview guests.' : ''} A production safe-close gate is unsupported for this runtime.`
  } else {
    safePath = 'Inconclusive: at least one experiment did not produce three consistent rounds.'
  }

  const statements = [
    `webContents.close({waitForBeforeUnload:true}) kept a refusing guest alive (documented CloseOpts behaviour): ${facts.protectedCloseDefaultKeepsGuest}.`,
    `will-prevent-unload fired while the guest was still destroyed by the protected close: ${facts.willPreventUnloadFiredOnRefusal === true && facts.protectedCloseDefaultDestroys === true}.`,
    `will-prevent-unload fired on refusal: ${facts.willPreventUnloadFiredOnRefusal}.`,
    `Calling preventDefault on will-prevent-unload permitted the close: ${facts.preventDefaultPermitsUnload}.`,
    `addEventListener(beforeunload) refusal was honoured: ${facts.addEventListenerRefusalWorks}.`,
    `Same-origin child-frame refusal protected the guest: ${facts.iframeRefusalWorks}.`,
    `User activation changed refusal under webContents.close: ${facts.activationRefusalWorks}.`,
    `CDP beforeunload dialog opened with activation: ${facts.cdpDialogOpensWithActivation}.`,
    `CDP deny kept the guest alive after detach: ${facts.cdpDenyKeepsGuestAlive}.`,
    `Inline CDP deny (no polling) kept the guest alive: ${facts.cdpInlineDenyKeepsGuestAlive}.`,
    `CDP beforeunload dialog was denied yet the guest was still destroyed: ${facts.cdpDialogAutoDeniedButGuestDestroyed}.`,
    `CDP accept closed the guest: ${facts.cdpAcceptCloses}.`,
    `CDP dialog was skipped without activation: ${facts.cdpDialogNeedsActivation}.`,
    `Late protection lost the race: ${facts.lateProtectionLosesRace}.`,
    `The same close option kept a BrowserWindow WebContents alive: ${facts.browserWindowCloseKeepsAlive}.`
  ]

  const gateSupported = facts.protectedCloseDefaultKeepsGuest === true || facts.cdpDenyKeepsGuestAlive === true || facts.cdpInlineDenyKeepsGuestAlive === true
    ? true
    : facts.protectedCloseDefaultKeepsGuest === false && facts.cdpDenyKeepsGuestAlive === false && facts.cdpInlineDenyKeepsGuestAlive === false
      ? false
      : null

  const versionsRun = runs.map(record => record.run).find(run => run && run.versions)
  const result = {
    schema: 1,
    kind: 'safe-close-probe-results',
    generatedAt: new Date().toISOString(),
    checkout: ROOT,
    commit: meta && meta.commit ? meta.commit : null,
    probe: 'scripts/shelf-memory-p0/safe-close-probe.cjs',
    commands: {
      full: 'node scripts/shelf-memory-p0/safe-close-probe.cjs',
      aggregate: 'node scripts/shelf-memory-p0/safe-close-probe.cjs --aggregate',
      fixtures: 'loopback HTTP fixture served by the probe; no production UI, dist bundle or user profile is loaded'
    },
    runtime: versionsRun
      ? {
          electron: versionsRun.versions.electron,
          chrome: versionsRun.versions.chrome,
          node: versionsRun.versions.node,
          v8: versionsRun.versions.v8,
          napi: versionsRun.versions.napi,
          platform: versionsRun.platform,
          arch: versionsRun.arch,
          osRelease: versionsRun.osRelease,
          cpu: versionsRun.cpu,
          totalMemoryBytes: versionsRun.totalMemoryBytes
        }
      : null,
    method: {
      rounds: ROUNDS,
      experiments: EXPERIMENTS.length,
      freshProcessPerExperiment: true,
      freshUserDataPerRun: true,
      freshInMemoryPartitionPerRun: true,
      oneGuestPerRun: true,
      hostWindow: 'hidden BrowserWindow, webviewTag=true, sandbox=true, contextIsolation=true, nodeIntegration=false',
      guestPreferencesEnforced: 'will-attach-webview forces sandbox=true, contextIsolation=true, nodeIntegration=false, webSecurity=true, preload removed',
      survivalProof: 'two executeJavaScript calls after the close attempt (incrementing counter + DOM node), plus isDestroyed() and getAllWebContents() membership',
      destroyedProof: "destroyed event, isDestroyed()===true, absence from getAllWebContents(), and getWebContentsId() after teardown",
      boundedTimeouts: '50s per probe process, 60s per child, 2-3s per close/dialog wait'
    },
    experiments,
    conclusion: {
      cancellableSafePath: safePath,
      safeCloseGateSupported: gateSupported,
      recommendation: gateSupported === false
        ? 'Keep the production safe-close gate unsupported for webview guests in this runtime: no tested close path can be cancelled or denied, so an attempted safe close destroys a refusing guest. Do not advertise P2b-style cancellable close for guests.'
        : gateSupported === true
          ? 'A cancellable path exists; wire it into the adapter behind the existing capability gate and rerun this probe after any Electron upgrade.'
          : 'Inconclusive; keep the safe-close gate disabled until three consistent rounds support a path.',
      facts,
      statements,
      supportScope: [
        `Electron ${versionsRun ? versionsRun.versions.electron : '43.7.11'} ${versionsRun ? versionsRun.platform : process.platform}/${versionsRun ? versionsRun.arch : process.arch}.`,
        'Hidden fixture BrowserWindow; sandboxed, context-isolated <webview> guests on a loopback HTTP origin.',
        'Close initiated through webContents.close({waitForBeforeUnload:true}) or the guest debugger CDP Page.close({runBeforeUnload:true}).',
        'Protection installed synchronously by the page before the close attempt (onbeforeunload or addEventListener), plus one late-protection race.',
        'Same-origin top-level fixture pages only; no production LyShell UI, no user pages, no cross-origin frames, no service workers.'
      ],
      limitations: [
        'Three rounds per experiment; timing values are observations, not latency percentiles.',
        'Hidden window and synthetic (CDP Input) activation; visible/focused-window behavior and real hardware input were not tested.',
        'Only close-triggered beforeunload was tested, not navigation/reload-triggered unload.',
        'Cross-origin child frames, sandboxed iframes without allow-same-origin, and OOPIF beforeunload paths were not tested.',
        'CDP is an automation surface; attaching the debugger to a production guest is itself an operational cost and can be detached by DevTools or target destruction.',
        'The probe records one Electron build (43.7.11) and must be rerun after any Electron upgrade.'
      ]
    },
    rawEvidence: {
      directory: 'tmp/deep-sleep-probe/raw',
      files: runs.map(record => record.run ? `exp-${record.experiment}-round-${record.round}.json` : null).filter(Boolean)
    }
  }
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true })
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

function compactEvents(events) {
  const keep = /^(close-called|close-result|will-prevent-unload|guest-destroyed|page-console|cdp-message|cdp-detach|cdp-detach-error|step|cleanup|guest-navigation|render-process-gone|guest-element)$/
  return events.filter(event => keep.test(event.name)).slice(0, 80)
}

/* ------------------------------------------------------------------ */
/* Electron probe (one experiment per process)                        */
/* ------------------------------------------------------------------ */

async function runElectron() {
  console.error('[probe] electron-entry', process.argv.slice(2).join(' '))
  const expName = process.argv[2]
  const round = Number(process.argv[3])
  const origin = process.argv[4]
  const definition = EXPERIMENTS.find(item => item.name === expName)
  if (!definition || !Number.isInteger(round) || round < 1 || round > ROUNDS || !origin) {
    console.error('invalid arguments')
    process.exit(2)
  }
  console.error('[probe] args-ok')
  const { app, BrowserWindow, webContents, screen } = require('electron')
  console.error('[probe] electron-required')
  // Fail loudly instead of Electron's blocking "A JavaScript error occurred in
  // the main process" dialog, which would look like a hang to the runner.
  process.on('uncaughtException', error => {
    console.error(`probe-crash: ${error && error.stack ? error.stack : error}`)
    process.exit(1)
  })
  fs.mkdirSync(path.join(OUT, 'profiles'), { recursive: true })
  console.error('[probe] profiles-ok')
  const profile = fs.mkdtempSync(path.join(OUT, 'profiles', `p-${expName}-${round}-`))
  console.error('[probe] profile', profile)
  try { app.setPath('userData', profile) } catch (error) { /* path already isolated */ }
  try { app.setPath('sessionData', profile) } catch (error) { /* optional path */ }
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.on('window-all-closed', () => {})

  const report = {
    schema: 1,
    kind: 'isolated-safe-close-probe',
    exp: expName,
    round,
    startedAt: new Date().toISOString(),
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: (os.cpus()[0] || {}).model || null,
    totalMemoryBytes: os.totalmem(),
    profile: path.relative(ROOT, profile),
    isolation: {
      freshUserData: true,
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
    cleanup: null,
    errors: []
  }

  let host = null
  let guest = null
  let guestId = null
  let finished = false
  let willPolicyCurrent = 'default'
  let willEventCount = 0
  let destroyedAt = null
  const willEvents = []
  const cdpMessages = []
  let inlineHandle = null

  function mark(name, extra) {
    if (report.events.length >= 400) {
      report.eventsTruncated = true
      return
    }
    report.events.push(Object.assign({ t: now(), name }, extra || {}))
  }

  function trace(message) {
    console.error(`[probe ${expName} r${round} t+${now()}ms] ${message}`)
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
    report.checks = report.checks || {}
    try { if (guest && !guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach() } catch (error) { /* teardown */ }
    try { if (host && !host.isDestroyed()) host.destroy() } catch (error) { /* teardown */ }
    fs.mkdirSync(RAW, { recursive: true })
    fs.writeFileSync(path.join(RAW, `exp-${expName}-round-${round}.json`), `${JSON.stringify(report, null, 2)}\n`)
    app.exit(code)
  }

  const deadline = setTimeout(() => finish(1, new Error('probe deadline exceeded')), PROBE_DEADLINE_MS)
  process.on('uncaughtException', error => finish(1, error))
  process.on('unhandledRejection', error => { report.errors.push(`unhandledRejection: ${error && error.message}`) })
  console.error('[probe] calling-whenReady')

  app.whenReady().then(async () => {
    trace('ready')
    report.display = screen.getPrimaryDisplay()

    if (expName === 'window-close-default') {
      const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 700,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
      })
      win.webContents.setBackgroundThrottling(false)
      const will = []
      win.webContents.on('will-prevent-unload', event => {
        will.push({ at: now(), policy: 'default', before: event.defaultPrevented, after: event.defaultPrevented })
        mark('will-prevent-unload', will[will.length - 1])
      })
      await win.loadURL(`${origin}/page/refuse-onbeforeunload?window=1`)
      const windowPage = await win.webContents.executeJavaScript(`(() => ({
        href: location.href,
        title: document.title,
        protection: window.__protection || null,
        beforeUnloadFired: window.__beforeUnloadFired || 0,
        nodeProcess: typeof process
      }))()`)
      trace(`window-loaded protection=${windowPage.protection}`)
      report.setup.window = { visible: win.isVisible(), bounds: win.getBounds(), page: windowPage }
      report.fixture = { kind: 'protection', ok: windowPage.protection !== null, detail: null }
      const started = now()
      let closeError = null
      mark('close-called', { label: 'window-close', wait: true, policy: 'default' })
      try {
        win.webContents.close({ waitForBeforeUnload: true })
      } catch (error) {
        closeError = error.message
      }
      await sleep(2500)
      const alive = !win.isDestroyed() && !win.webContents.isDestroyed()
      let after = null
      if (alive) {
        try {
          after = await withTimeout(win.webContents.executeJavaScript(`(() => {
            window.__probeTicks = (window.__probeTicks || 0) + 1;
            return { tick: window.__probeTicks, href: location.href, beforeUnloadFired: window.__beforeUnloadFired || 0 };
          })()`), 2000, 'window-prove-alive')
        } catch (error) {
          after = { error: error.message }
        }
      }
      report.observed = {
        page: windowPage,
        willEvents: will,
        closeError,
        elapsedMs: Number((now() - started).toFixed(2)),
        alive,
        after
      }
      report.checks = {
        willPreventUnloadFired: will.length > 0,
        survived: alive,
        jsExecutedAfterRefusal: Boolean(after && after.tick === 1 && !after.error),
        fixtureOk: windowPage.protection !== null
      }
      step('window-close', report.observed)
      if (!win.isDestroyed()) {
        try { await win.webContents.executeJavaScript('window.onbeforeunload = null; true') } catch (error) { /* closing */ }
        try { win.destroy() } catch (error) { /* already gone */ }
      }
      report.cleanup = { wasAlive: alive, destroyed: win.isDestroyed() }
      report.proof = { aliveAtEnd: after }
      mark('cleanup', { label: 'window', destroyed: win.isDestroyed() })
      finish(0)
      return
    }

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
    await host.loadURL(`${origin}/host`)
    trace('host-loaded')
    report.setup.hostLoadMs = Number((now() - hostLoadStart).toFixed(2))
    report.setup.hostBounds = host.getBounds()
    report.setup.hostVisible = host.isVisible()

    const partition = `probe-${expName}-${round}-${crypto.randomUUID()}`
    const guestUrl = `${origin}/page/${expName}?round=${round}&nonce=${crypto.randomUUID()}`
    report.setup.partition = partition
    report.setup.guestUrl = guestUrl

    const attachStart = now()
    let resolveAttach
    let rejectAttach
    const attached = new Promise((resolve, reject) => { resolveAttach = resolve; rejectAttach = reject })
    const attachTimeout = setTimeout(() => rejectAttach(new Error('did-attach-webview timeout')), 15000)
    host.webContents.once('did-attach-webview', (_event, contents) => {
      clearTimeout(attachTimeout)
      guest = contents
      guestId = contents.id
      report.setup.guestId = contents.id
      report.setup.guestType = contents.getType()
      try { guest.setBackgroundThrottling(false) } catch (error) { /* optional */ }
      guest.on('destroyed', () => {
        if (destroyedAt === null) destroyedAt = now()
        mark('guest-destroyed')
      })
      guest.on('will-prevent-unload', event => {
        const before = event.defaultPrevented
        const policy = willPolicyCurrent
        if (policy === 'allow') event.preventDefault()
        const after = event.defaultPrevented
        willEventCount++
        const entry = { at: now(), policy, before, after }
        willEvents.push(entry)
        mark('will-prevent-unload', entry)
      })
      guest.on('render-process-gone', (_e, details) => mark('render-process-gone', { reason: details.reason, exitCode: details.exitCode }))
      guest.on('console-message', details => {
        const message = details && details.message ? details.message : ''
        if (/^(page-|frame-)/.test(message)) mark('page-console', { message })
      })
      guest.on('did-start-navigation', (_e, url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) mark('guest-navigation', { url })
      })
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
      resolveAttach({ guest, load, settleLoad })
    })
    await host.webContents.executeJavaScript(`(() => {
      const element = document.createElement('webview');
      element.id = 'probe-guest';
      element.setAttribute('partition', ${JSON.stringify(partition)});
      element.setAttribute('src', ${JSON.stringify(guestUrl)});
      element.style.cssText = 'width:800px;height:600px;display:flex';
      document.body.append(element);
      return true;
    })()`)
    const { load } = await attached
    trace('guest-attached')
    report.setup.guestLoad = await load
    trace(`guest-loaded:${report.setup.guestLoad}`)
    report.setup.guestLoadMs = Number((now() - attachStart).toFixed(2))
    report.setup.guestProcessId = guest.getProcessId()
    report.setup.guestSize = await host.webContents.executeJavaScript(`(() => {
      const element = document.getElementById('probe-guest');
      const rect = element ? element.getBoundingClientRect() : null;
      return rect ? { width: rect.width, height: rect.height } : null;
    })()`)

    const pageInfoExpr = `(() => ({
      title: document.title,
      href: location.href,
      readyState: document.readyState,
      protection: window.__protection || null,
      beforeUnloadFired: window.__beforeUnloadFired || 0,
      lateProtection: Boolean(window.__lateProtection),
      gestureClicks: window.__gestureClicks || 0,
      activation: navigator.userActivation ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null,
      nodeTypes: { process: typeof process, require: typeof require, module: typeof module },
      navigationType: (performance.getEntriesByType('navigation')[0] || {}).type || null
    }))()`

    async function pageInfo() {
      return withTimeout(guest.executeJavaScript(pageInfoExpr), 3000, 'pageInfo')
    }

    function isListed() {
      try { return webContents.getAllWebContents().some(item => item.id === guestId) } catch (error) { return false }
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
      const info = { label, at: now(), isDestroyed: guest.isDestroyed(), listed: isListed() }
      if (info.isDestroyed) return info
      try {
        info.first = await withTimeout(guest.executeJavaScript(`(() => {
          window.__probeTicks = (window.__probeTicks || 0) + 1;
          const node = document.createElement('span');
          node.id = 'probe-tick-' + window.__probeTicks;
          node.textContent = 'tick-' + window.__probeTicks;
          document.body.appendChild(node);
          return {
            tick: window.__probeTicks,
            href: location.href,
            title: document.title,
            protection: window.__protection || null,
            beforeUnloadFired: window.__beforeUnloadFired || 0,
            lateProtection: Boolean(window.__lateProtection),
            gestureClicks: window.__gestureClicks || 0,
            activation: navigator.userActivation ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null,
            now: performance.now()
          };
        })()`), 1500, 'proveAlive-1')
        info.second = await withTimeout(guest.executeJavaScript(`(() => {
          window.__probeTicks = (window.__probeTicks || 0) + 1;
          const first = document.getElementById('probe-tick-1');
          return { tick: window.__probeTicks, firstNode: first ? first.textContent : null, now: performance.now() };
        })()`), 1500, 'proveAlive-2')
        info.jsExecutedTwice = Boolean(info.first && info.second && info.second.tick === info.first.tick + 1 && info.second.firstNode === 'tick-1')
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

    async function attemptClose(label, options) {
      const settings = Object.assign({ wait: true, policy: 'default' }, options || {})
      willPolicyCurrent = settings.policy
      const before = willEventCount
      const started = now()
      mark('close-called', { label, wait: settings.wait, policy: settings.policy })
      let closeError = null
      try {
        guest.close({ waitForBeforeUnload: settings.wait })
      } catch (error) {
        closeError = error.message
      }
      const destroyed = await waitForDestroyed(settings.wait ? 3000 : 2000)
      const result = {
        label,
        wait: settings.wait,
        policy: settings.policy,
        at: started,
        elapsedMs: Number((now() - started).toFixed(2)),
        destroyed,
        isDestroyed: guest.isDestroyed(),
        destroyedEvent: destroyedAt !== null,
        willPreventUnloadFired: willEventCount > before,
        willPreventUnloadDelta: willEventCount - before,
        closeError
      }
      if (!destroyed) result.alive = await proveAlive(`${label}:alive`)
      mark('close-result', {
        label,
        destroyed: result.destroyed,
        willPreventUnloadDelta: result.willPreventUnloadDelta,
        elapsedMs: result.elapsedMs,
        closeError
      })
      return result
    }

    function ensureDebugger() {
      if (guest.debugger.isAttached()) return
      guest.debugger.attach('1.3')
      guest.debugger.on('message', (_event, method, params) => {
        if (!/^Page\.(javascriptDialog|frameNavigated|frameDetached)|^Inspector\.detached/.test(method)) return
        const entry = { at: now(), method }
        if (method === 'Page.javascriptDialogOpening') {
          entry.params = {
            type: params ? params.type : null,
            message: params ? params.message : null,
            hasBrowserHandler: params ? params.hasBrowserHandler : null,
            defaultPrompt: params ? params.defaultPrompt : null,
            url: params ? params.url : null
          }
        } else if (method === 'Page.javascriptDialogClosed') {
          entry.params = { result: params ? params.result : null, userInput: params ? params.userInput : null }
        }
        if (cdpMessages.length < 200) cdpMessages.push(entry)
        mark('cdp-message', entry)
        if (method === 'Page.javascriptDialogOpening' && inlineHandle && !inlineHandle.sent) {
          // Reply on the same tick the dialog opens, instead of polling for it.
          inlineHandle.sent = true
          inlineHandle.at = now()
          guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: inlineHandle.accept }).then(
            value => { inlineHandle.state = 'resolved'; inlineHandle.value = value; inlineHandle.settledAt = now() },
            error => { inlineHandle.state = 'rejected'; inlineHandle.error = error.message; inlineHandle.settledAt = now() }
          )
        }
      })
      guest.debugger.on('detach', (_event, reason) => mark('cdp-detach', { reason }))
    }

    function detachDebugger() {
      try {
        if (guest.debugger.isAttached()) guest.debugger.detach()
      } catch (error) {
        mark('cdp-detach-error', { message: error.message })
      }
    }

    async function cdpCommand(method, params, ms) {
      return withTimeout(guest.debugger.sendCommand(method, params), ms || 3000, method)
    }

    async function waitCdpDialog(ms) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const found = cdpMessages.find(item => item.method === 'Page.javascriptDialogOpening')
        if (found) return found
        if (guest.isDestroyed() || destroyedAt !== null) return null
        await sleep(25)
      }
      return cdpMessages.find(item => item.method === 'Page.javascriptDialogOpening') || null
    }

    async function handleDialog(accept) {
      const result = { accept, at: now(), state: 'pending' }
      try {
        result.value = await cdpCommand('Page.handleJavaScriptDialog', { accept }, 3000)
        result.state = 'resolved'
      } catch (error) {
        result.state = 'rejected'
        result.error = error.message
      }
      await sleep(50)
      const closed = cdpMessages.find(item => item.method === 'Page.javascriptDialogClosed')
      result.dialogClosedEvent = closed ? closed.params : null
      return result
    }

    function startCdpClose(runBeforeUnload) {
      const outcome = { state: 'pending', at: now() }
      guest.debugger.sendCommand('Page.close', { runBeforeUnload }).then(
        value => { outcome.state = 'resolved'; outcome.value = value; outcome.settledAt = now() },
        error => { outcome.state = 'rejected'; outcome.error = error.message; outcome.settledAt = now() }
      )
      return outcome
    }

    async function pageActivation() {
      return withTimeout(guest.executeJavaScript(`(() => ({
        isActive: navigator.userActivation ? navigator.userActivation.isActive : null,
        hasBeenActive: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
        gestureClicks: window.__gestureClicks || 0
      }))()`), 2000, 'activation')
    }

    async function activateViaCdp(keepAttached) {
      const rect = await withTimeout(guest.executeJavaScript(`(() => {
        const button = document.getElementById('gesture');
        const bounds = button.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      })()`), 2000, 'gesture-rect')
      ensureDebugger()
      await cdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdpCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 })
      let activation = await pageActivation()
      let method = 'cdp-trusted-mouse'
      if (!activation.hasBeenActive) {
        await guest.executeJavaScript("document.getElementById('gesture').click(); true", true)
        activation = await pageActivation()
        method = 'executeJavaScript-userGesture-fallback'
      }
      if (!keepAttached) detachDebugger()
      return { method, rect, activation }
    }

    async function cleanup(label) {
      const record = { label, at: now(), wasAlive: !guest.isDestroyed() }
      if (guest.isDestroyed()) {
        record.alreadyDestroyed = true
        try {
          await withTimeout(host.webContents.executeJavaScript("document.getElementById('probe-guest')?.remove(); true"), 1500, 'cleanup-remove-destroyed')
        } catch (error) {
          record.removeError = error.message
        }
        record.guestElement = await guestElementState()
        return record
      }
      if (guest.debugger.isAttached()) detachDebugger()
      try {
        await withTimeout(guest.executeJavaScript(`(() => {
          try { if (window.__probeRemove) window.__probeRemove(); } catch (error) {}
          window.onbeforeunload = null;
          const frame = document.getElementById('frame');
          if (frame && frame.contentWindow) frame.contentWindow.onbeforeunload = null;
          return true;
        })()`), 1500, 'cleanup-clear')
      } catch (error) {
        record.clearError = error.message
      }
      try {
        guest.close()
      } catch (error) {
        record.closeError = error.message
      }
      record.destroyed = await waitForDestroyed(2500)
      if (!record.destroyed) {
        try {
          await withTimeout(host.webContents.executeJavaScript("document.getElementById('probe-guest')?.remove(); true"), 1500, 'cleanup-remove')
        } catch (error) {
          record.removeError = error.message
        }
        record.destroyed = await waitForDestroyed(2000)
      }
      record.isDestroyed = guest.isDestroyed()
      record.listed = isListed()
      record.guestElement = await guestElementState()
      mark('cleanup', { label, destroyed: record.destroyed, wasAlive: record.wasAlive })
      return record
    }

    const actions = {
      'allow-none': async () => {
        const before = await pageInfo()
        const close = await attemptClose('allow-none', { wait: true })
        report.observed = { before, close }
        report.checks = {
          willPreventUnloadFired: close.willPreventUnloadFired,
          destroyed: close.destroyed,
          destroyedEvent: close.destroyedEvent
        }
        step('close', close)
      },

      'refuse-onbeforeunload': async () => {
        const before = await pageInfo()
        const first = await attemptClose('refuse-first', { wait: true })
        let second = null
        let removedClose = null
        if (!first.destroyed) {
          second = await attemptClose('refuse-second', { wait: true })
        }
        if (!guest.isDestroyed()) {
          await guest.executeJavaScript('window.onbeforeunload = null; true')
          removedClose = await attemptClose('after-handler-removed', { wait: true })
        }
        report.observed = { before, first, second, removedClose, willEvents }
        report.checks = {
          willPreventUnloadFired: first.willPreventUnloadFired,
          survivedFirstClose: !first.destroyed,
          jsExecutedAfterRefusal: Boolean(first.alive && first.alive.jsExecutedTwice),
          secondCloseAlsoRefused: Boolean(second && !second.destroyed),
          destroyedAfterHandlerRemoved: Boolean(removedClose && removedClose.destroyed)
        }
        step('first-close', first)
        if (second) step('second-close', second)
        if (removedClose) step('close-after-handler-removed', removedClose)
      },

      'allow-via-preventDefault': async () => {
        const before = await pageInfo()
        const close = await attemptClose('allow-via-preventDefault', { wait: true, policy: 'allow' })
        const lastWill = willEvents[willEvents.length - 1] || null
        report.observed = { before, close, lastWill, willEvents }
        report.checks = {
          willPreventUnloadFired: close.willPreventUnloadFired,
          willEventDefaultPrevented: Boolean(lastWill && lastWill.after === true),
          destroyed: close.destroyed
        }
        step('close', close)
      },

      'refuse-addEventListener': async () => {
        const before = await pageInfo()
        const first = await attemptClose('refuse-first', { wait: true })
        let removedClose = null
        if (!guest.isDestroyed()) {
          await guest.executeJavaScript('window.__probeRemove(); true')
          removedClose = await attemptClose('after-listener-removed', { wait: true })
        }
        report.observed = { before, first, removedClose, willEvents }
        report.checks = {
          willPreventUnloadFired: first.willPreventUnloadFired,
          survivedFirstClose: !first.destroyed,
          jsExecutedAfterRefusal: Boolean(first.alive && first.alive.jsExecutedTwice),
          destroyedAfterHandlerRemoved: Boolean(removedClose && removedClose.destroyed)
        }
        step('first-close', first)
        if (removedClose) step('close-after-listener-removed', removedClose)
      },

      'refuse-iframe': async () => {
        const before = await pageInfo()
        const first = await attemptClose('refuse-first', { wait: true })
        let frame = null
        if (!guest.isDestroyed()) {
          frame = await withTimeout(guest.executeJavaScript(`(() => {
            const element = document.getElementById('frame');
            if (!element || !element.contentWindow) return null;
            return {
              frameLoaded: true,
              frameFired: element.contentWindow.__frameBeforeUnloadFired || 0,
              frameProtected: Boolean(element.contentWindow.onbeforeunload)
            };
          })()`), 2000, 'frame-info')
        }
        report.observed = { before, first, frame, willEvents }
        report.checks = {
          willPreventUnloadFired: first.willPreventUnloadFired,
          survivedFirstClose: !first.destroyed,
          jsExecutedAfterRefusal: Boolean(first.alive && first.alive.jsExecutedTwice)
        }
        step('first-close', first)
        if (frame) step('frame-state', frame)
      },

      'refuse-gesture': async () => {
        const before = await pageInfo()
        const activation = await activateViaCdp(false)
        const first = await attemptClose('refuse-first', { wait: true })
        report.observed = { before, activation, first, willEvents }
        report.checks = {
          pageActivationTrue: activation.activation.hasBeenActive === true,
          willPreventUnloadFired: first.willPreventUnloadFired,
          survivedFirstClose: !first.destroyed,
          jsExecutedAfterRefusal: Boolean(first.alive && first.alive.jsExecutedTwice)
        }
        step('activation', activation)
        step('first-close', first)
      },

      'cdp-deny-gesture': async () => {
        const before = await pageInfo()
        const activation = await activateViaCdp(true)
        await cdpCommand('Page.enable', {})
        const closeOutcome = startCdpClose(true)
        const dialog = await waitCdpDialog(3000)
        let handle = null
        let afterDeny = null
        if (dialog) handle = await handleDialog(false)
        await sleep(300)
        afterDeny = await proveAlive('cdp-deny')
        const closeAtDeny = Object.assign({}, closeOutcome)
        const survivalAfterDetach = guest.isDestroyed() ? null : await (async () => {
          detachDebugger()
          await sleep(500)
          return proveAlive('cdp-after-detach')
        })()
        report.observed = {
          before,
          activation,
          dialog,
          handle,
          closeAtDeny,
          afterDeny,
          survivalAfterDetach,
          willPreventUnloadDuringCdp: willEventCount,
          cdpMessages
        }
        report.checks = {
          pageActivationTrue: activation.activation.hasBeenActive === true,
          dialogOpened: Boolean(dialog),
          dialogTypeBeforeunload: Boolean(dialog && dialog.params && dialog.params.type === 'beforeunload'),
          denyAccepted: Boolean(handle && handle.state === 'resolved'),
          survivedFirstClose: Boolean(afterDeny && !afterDeny.isDestroyed),
          jsExecutedAfterRefusal: Boolean(afterDeny && afterDeny.jsExecutedTwice),
          survivedAfterDetach: Boolean(survivalAfterDetach && !survivalAfterDetach.isDestroyed && survivalAfterDetach.jsExecutedTwice)
        }
        step('activation', activation)
        step('dialog', dialog)
        if (handle) step('handle-deny', handle)
        step('after-deny', afterDeny)
        if (survivalAfterDetach) step('after-detach', survivalAfterDetach)
      },

      'cdp-accept-gesture': async () => {
        const before = await pageInfo()
        const activation = await activateViaCdp(true)
        await cdpCommand('Page.enable', {})
        const closeOutcome = startCdpClose(true)
        const dialog = await waitCdpDialog(3000)
        let handle = null
        if (dialog) handle = await handleDialog(true)
        const destroyed = await waitForDestroyed(3000)
        report.observed = {
          before,
          activation,
          dialog,
          handle,
          closeOutcome,
          destroyed,
          isDestroyed: guest.isDestroyed(),
          destroyedEvent: destroyedAt !== null,
          guestElement: await guestElementState(),
          cdpMessages
        }
        report.checks = {
          pageActivationTrue: activation.activation.hasBeenActive === true,
          dialogOpened: Boolean(dialog),
          dialogTypeBeforeunload: Boolean(dialog && dialog.params && dialog.params.type === 'beforeunload'),
          acceptAccepted: Boolean(handle && handle.state === 'resolved'),
          destroyed
        }
        step('activation', activation)
        step('dialog', dialog)
        if (handle) step('handle-accept', handle)
        step('close-outcome', closeOutcome)
      },

      'cdp-deny-no-gesture': async () => {
        const before = await pageInfo()
        ensureDebugger()
        await cdpCommand('Page.enable', {})
        const closeOutcome = startCdpClose(true)
        const dialog = await waitCdpDialog(2000)
        let handle = null
        let afterDeny = null
        if (dialog) {
          handle = await handleDialog(false)
          await sleep(300)
          afterDeny = await proveAlive('cdp-deny-no-gesture')
        }
        const destroyed = guest.isDestroyed() || destroyedAt !== null
        report.observed = {
          before,
          dialog,
          handle,
          afterDeny,
          closeOutcome,
          destroyed,
          isDestroyed: guest.isDestroyed(),
          cdpMessages
        }
        report.checks = {
          pageActivationFalse: Boolean(before.activation && before.activation.hasBeenActive === false),
          dialogOpened: Boolean(dialog),
          destroyed
        }
        step('dialog', dialog)
        if (handle) step('handle-deny', handle)
        if (afterDeny) step('after-deny', afterDeny)
        step('close-outcome', closeOutcome)
      },

      'cdp-deny-inline': async () => {
        const before = await pageInfo()
        const activation = await activateViaCdp(true)
        inlineHandle = { accept: false, sent: false, state: 'pending' }
        await cdpCommand('Page.enable', {})
        const closeOutcome = startCdpClose(true)
        const dialog = await waitCdpDialog(3000)
        await sleep(400)
        const handle = Object.assign({}, inlineHandle)
        const afterDeny = await proveAlive('cdp-deny-inline')
        detachDebugger()
        await sleep(300)
        report.observed = {
          before,
          activation,
          dialog,
          inline: handle,
          closeOutcome,
          afterDeny,
          cdpMessages
        }
        report.checks = {
          pageActivationTrue: activation.activation.hasBeenActive === true,
          dialogOpened: Boolean(dialog),
          denyInlineResolved: handle.state === 'resolved',
          survivedFirstClose: !afterDeny.isDestroyed,
          jsExecutedAfterRefusal: Boolean(afterDeny.jsExecutedTwice)
        }
        step('activation', activation)
        step('dialog', dialog)
        step('inline-deny', handle)
        step('after-deny', afterDeny)
        step('close-outcome', closeOutcome)
      },

      'race-late-protection': async () => {
        const before = await pageInfo()
        await guest.executeJavaScript('window.__armLateProtection(250); true')
        await sleep(100)
        const first = await attemptClose('race-close', { wait: true })
        const closeEvent = report.events.find(event => event.name === 'close-called')
        const lateEvent = report.events.find(event => event.name === 'page-console' && event.message === 'page-late-protection-set')
        const closeCalledBeforeProtection = Boolean(closeEvent && (!lateEvent || lateEvent.t > closeEvent.t))
        report.observed = { before, first, closeCalledBeforeProtection, lateMarker: lateEvent || null }
        report.checks = {
          closeCalledBeforeProtection,
          destroyed: first.destroyed
        }
        step('close', first)
      }
    }

    report.setup.page = await pageInfo()
    if (report.setup.page.nodeTypes && (report.setup.page.nodeTypes.process !== 'undefined' || report.setup.page.nodeTypes.require !== 'undefined')) {
      report.errors.push('guest isolation check failed: node globals are reachable')
    }
    const fixtureKind = FIXTURES[expName] || 'protection'
    let fixtureDetail = null
    let fixtureOk = false
    if (fixtureKind === 'none') {
      fixtureOk = report.setup.page.protection === null
    } else if (fixtureKind === 'protection') {
      fixtureOk = Boolean(report.setup.page.protection)
    } else if (fixtureKind === 'race') {
      fixtureOk = (await guest.executeJavaScript("typeof window.__armLateProtection === 'function'")) === true
    } else if (fixtureKind === 'iframe') {
      fixtureDetail = await guest.executeJavaScript(`(() => {
        const element = document.getElementById('frame');
        if (!element || !element.contentWindow) return { loaded: false };
        const doc = element.contentDocument;
        return {
          loaded: Boolean(doc && doc.readyState === 'complete'),
          handler: typeof element.contentWindow.onbeforeunload === 'function',
          text: doc ? (doc.getElementById('frame-content') || {}).textContent || null : null
        };
      })()`)
      fixtureOk = Boolean(fixtureDetail && fixtureDetail.loaded && fixtureDetail.handler)
    }
    report.fixture = { kind: fixtureKind, ok: fixtureOk, detail: fixtureDetail }
    if (!fixtureOk) report.errors.push(`fixture check failed: expected ${fixtureKind}`)
    await actions[expName]()
    report.checks.fixtureOk = fixtureOk
    trace('experiment-done')
    report.proof.aliveAtEnd = guest.isDestroyed() ? null : await proveAlive('end')
    report.cleanup = await cleanup('end')
    trace(`cleanup-done destroyed=${report.cleanup && report.cleanup.destroyed}`)
    report.proof.afterCleanup = {
      isDestroyed: guest.isDestroyed(),
      destroyedEvent: destroyedAt !== null,
      listed: isListed(),
      guestElement: report.cleanup.guestElement || null
    }
    if (report.cleanup && report.cleanup.wasAlive && !report.cleanup.destroyed) {
      report.errors.push('cleanup did not destroy the guest')
    }
    step('cleanup', report.cleanup)
    finish(0)
  }).catch(error => finish(1, error))
}

/* ------------------------------------------------------------------ */
/* Shared helper                                                      */
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

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

if (process.argv.includes('--aggregate')) {
  const runs = listRawRuns().map(record => ({
    experiment: record.experiment,
    round: record.round,
    exitCode: record.run ? 0 : null,
    timedOut: false,
    run: record.run,
    durationMs: record.run ? record.run.durationMs : null,
    stderrTail: null
  }))
  const result = aggregate(runs, { commit: readCommit() })
  console.log(`wrote ${path.relative(ROOT, RESULT_FILE)}`)
  for (const experiment of result.experiments) console.log(`${experiment.name}: ${experiment.verdict}`)
} else if (IS_ELECTRON) {
  runElectron()
} else {
  runRunner().catch(error => {
    console.error(error.stack || String(error))
    process.exitCode = 1
  })
}

function readCommit() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    return null
  }
}
