/* Codex 独立核对并归档证据；不启动应用、不执行任务、不改生产源码。 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
const out = path.join(root, 'docs/shelf-memory-p0/reloadable-raw')
const hash = data => crypto.createHash('sha256').update(data).digest('hex')
const read = rel => JSON.parse(fs.readFileSync(path.join(root, rel)))
const manifest = { generatedAt: new Date().toISOString(), artifacts: [], checks: {} }
fs.mkdirSync(out, { recursive: true })
function archive(rel, name) {
  const raw = fs.readFileSync(path.join(root, rel))
  const compressed = zlib.gzipSync(raw, { level: 9 })
  assert.deepEqual(zlib.gunzipSync(compressed), raw)
  fs.writeFileSync(path.join(out, name + '.gz'), compressed)
  manifest.artifacts.push({ source: rel, file: name + '.gz', bytes: raw.length, sha256: hash(raw), gzipSha256: hash(compressed) })
}
const runtime = read('tmp/reloadable-runtime-acceptance/results.json')
assert.deepEqual(runtime.errors, [])
assert.equal(runtime.cycles.length, 100)
for (const cycle of runtime.cycles) {
  for (const flag of ['partitionPreserved', 'zoomPreserved', 'scrollPreserved', 'cookiePreserved']) assert.equal(cycle[flag], true)
}
assert.equal(runtime.saveFailureKeptOriginal, true)
assert.equal(runtime.demandDuringSaveKeptOriginal, true)
assert.equal(runtime.inFlightDemandRestoredOnlyAfterDestroyed, true)
assert.equal(runtime.redirectedGuestBound, true)
assert.ok(runtime.lateBlankCaptureChecks >= 100)
for (const [file, expected] of Object.entries(runtime.sourceSha256)) assert.equal(hash(fs.readFileSync(path.join(root, file))), expected)
manifest.checks.runtime = { cycles: runtime.cycles.length, lateBlankCaptureChecks: runtime.lateBlankCaptureChecks, sourceSha256: runtime.sourceSha256, finalGuests: runtime.finalGuests, stats: runtime.stats }
archive('tmp/reloadable-runtime-acceptance/results.json', 'runtime-100.json')
const gui = read('tmp/reloadable-gui/results.json')
assert.deepEqual(gui.errors, [])
assert.equal(gui.uiRevokeKeptAlive, true)
assert.equal(gui.actualUiAndMainConsentChecked, true)
assert.equal(gui.lateBlankCapturePersisted, true)
assert.deepEqual(gui.confirmationRequests.map(item => item.simulatedResponse), [0, 1])
for (const [file, expected] of Object.entries(gui.buildSha256)) assert.equal(hash(fs.readFileSync(path.join(root, file))), expected)
manifest.checks.gui = { revokeKeepsAlive: true, uiAndMainIPC: true, lateBlankCapturePersisted: true, nativeDialogResponsesSimulated: true }
archive('tmp/reloadable-gui/results.json', 'gui.json')
for (const label of ['readonly-main', 'sleeping', 'restored-main']) archive(`tmp/reloadable-gui/${label}.png`, `gui-${label}.png`)
for (const name of fs.readdirSync(path.join(root, 'tmp/reloadable-gui')).filter(name => /attempt.*\.json$/.test(name))) archive('tmp/reloadable-gui/' + name, 'retained-gui-' + name)
archive('tmp/reloadable-redirect/failed-before-fix.json', 'redirect-before-fix.json')
archive('tmp/reloadable-redirect/results.json', 'redirect-after-fix.json')
archive('tmp/reloadable-redirect/failed-consent-before-fix.json', 'redirect-consent-before-fix.json')
archive('tmp/reloadable-app/codex-takeover.json', 'native-task-cancelled-handoff.json')
archive('tmp/reloadable-app/codex-aborted-open-only-edge.json', 'aborted-fixture-edge-action.json')
const guard = read('docs/shelf-memory-p0/reloadable-guard-probe-results.json')
assert.deepEqual(guard.errors, [])
assert.equal(guard.cases.length, 42)
assert.ok(guard.cases.every(item => item.pass === true && Object.values(item.checks).every(value => value === true)))
assert.equal(guard.checks.length, 270)
assert.ok(guard.checks.every(item => item.pass === true))
assert.equal(guard.sourceStability.stableDuringProbe, true)
assert.equal(guard.sourceStability.exercisedSourceHash, hash(fs.readFileSync(path.join(root, 'src/main/browser/shelf-reloadable-guard.ts'))))
manifest.checks.guard = { cases: 42, checks: 270, sourceSha256: guard.sourceStability.exercisedSourceHash }
archive('docs/shelf-memory-p0/reloadable-guard-probe-results.json', 'guard.json')
const navigation = read('docs/shelf-memory-p0/navigation-close-probe-results.json')
assert.equal(navigation.cases.length, 15)
for (const entry of navigation.cases) {
  assert.equal(entry.rounds.length, 3)
  assert.ok(entry.rounds.every(round => round.status === 'ok' && round.checks.validEvidence === true && round.errors.length === 0 && round.mismatches.length === 0))
}
manifest.checks.navigation = { cases: 15, roundsPerCase: 3, validEvidence: 45, backendTurnEndEvidence: 'navigation-terminal.json.gz', originalNativeApiCompletedReceipt: false }
archive('docs/shelf-memory-p0/navigation-close-probe-results.json', 'navigation-close.json')
archive('tmp/navigation-close-probe-terminal-evidence.json', 'navigation-terminal.json')
const fullPath = path.join(root, 'docs/shelf-memory-p0/reloadable-app-results.json')
if (fs.existsSync(fullPath) && JSON.parse(fs.readFileSync(fullPath)).ok === true) {
  const full = JSON.parse(fs.readFileSync(fullPath))
  assert.equal(full.validity.status, 'valid')
  assert.equal(full.build.stable, true)
  assert.equal(full.source.stable, true)
  const sourceFiles = {}
  const walk = dir => {
    for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir + '/' + item.name
      if (item.isDirectory()) walk(rel)
      else if (item.isFile()) sourceFiles[rel] = hash(fs.readFileSync(path.join(root, rel)))
    }
  }
  walk('src')
  for (const rel of ['scripts/shelf-memory-p0/reloadable-app.cjs', 'package.json', 'electron.vite.config.ts']) sourceFiles[rel] = hash(fs.readFileSync(path.join(root, rel)))
  const currentSourceDigest = hash(Object.keys(sourceFiles).sort().map(key => `${key}:${sourceFiles[key]}`).join('\n'))
  assert.equal(currentSourceDigest, full.source.after.shelfDigest)
  for (const [rel, expected] of Object.entries(full.build.after.files)) assert.equal(hash(fs.readFileSync(path.join(root, rel))), expected.sha256)
  for (const [rel, expected] of Object.entries(full.build.after.app)) assert.equal(hash(fs.readFileSync(path.join(root, rel))), expected)
  assert.equal(full.budget.wakeCycles, 102)
  assert.equal(full.runs.length, 6)
  const measurements = []
  for (const run of full.runs) {
    assert.equal(run.ok, true)
    const rawRel = run.base.replaceAll('\\', '/') + '/result.json'
    const raw = read(rawRel)
    assert.equal(raw.ok, true)
    assert.equal(raw.cyclesLog.length, 34)
    assert.ok(raw.checks.every(item => item.ok === true))
    const phases = {}
    let peak = 0
    for (const sample of raw.memory.samples) {
      const pids = new Map()
      for (const row of sample.processes) pids.set(row.pid, Math.max(pids.get(row.pid) || 0, row.privateKiB))
      const total = [...pids.values()].reduce((sum, value) => sum + value, 0) / 1024
      assert.ok(Math.abs(total - sample.totalMiB) < 0.02, `PID arithmetic ${run.arm} ${run.round}`)
      assert.equal(pids.size, sample.pidCount)
      peak = Math.max(peak, sample.totalMiB)
      ;(phases[sample.phase] ??= []).push(sample.totalMiB)
    }
    for (const [phase, samples] of Object.entries(phases)) {
      if (!raw.memory.phases[phase]) continue
      samples.sort((a, b) => a - b)
      const mid = Math.floor(samples.length / 2)
      const median = samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2
      assert.ok(Math.abs(median - raw.memory.phases[phase].median) < 0.011)
    }
    measurements.push({ arm: run.arm, round: run.round, sampleCount: raw.memory.samples.length, allPhaseObservedPeakMiB: peak, phases: raw.memory.phases, softFailures: raw.softFailures })
    archive(rawRel, `app-${run.arm}-${run.round}.json`)
    archive(run.base.replaceAll('\\', '/') + '/appData/lyshell-dev/config/task-shelf.json', `app-${run.arm}-${run.round}-shelf.json`)
    if (run.arm === 'after') {
      const recheckRel = run.base.replaceAll('\\', '/') + '/recheck.json'
      const recheck = read(recheckRel)
      assert.equal(recheck.ok, true)
      assert.equal(recheck.guests, 0)
      assert.ok(recheck.checks.every(item => item.ok === true))
      archive(recheckRel, `restart-${run.round}.json`)
    }
  }
  manifest.checks.fullApp = { currentSourceDigest, sourceFileCount: Object.keys(sourceFiles).length, measurements, deltas: full.memory.deltas, latency: full.latency }
  archive('scripts/shelf-memory-p0/reloadable-app.cjs', 'measured-app-fixture.cjs')
  archive('docs/shelf-memory-p0/reloadable-app-results.json', 'app-summary.json')
  manifest.retainedRuns = []
  for (const dir of fs.readdirSync(path.join(root, 'tmp/reloadable-app'))) {
    const rawRel = 'tmp/reloadable-app/' + dir + '/result.json'
    if (!fs.existsSync(path.join(root, rawRel)) || full.runs.some(run => run.base.replaceAll('\\', '/') === 'tmp/reloadable-app/' + dir)) continue
    const previous = read(rawRel)
    manifest.retainedRuns.push({ source: rawRel, ok: previous.ok, error: previous.error?.message, includedInComparison: false })
    archive(rawRel, 'retained-app-' + dir + '.json')
    const shelfRel = 'tmp/reloadable-app/' + dir + '/appData/lyshell-dev/config/task-shelf.json'
    if (fs.existsSync(path.join(root, shelfRel))) archive(shelfRel, 'retained-app-' + dir + '-shelf.json')
  }
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ archived: manifest.artifacts.length, checks: Object.keys(manifest.checks) }))
