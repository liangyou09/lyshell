const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { gzipSync } = require('node:zlib')
const root = path.resolve(__dirname, '../..')
const dest = path.join(root, 'docs/shelf-memory-p0')
fs.mkdirSync(dest, { recursive: true })
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]
const stats = values => ({ n: values.length, min: Math.min(...values), p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values) })
const rounds = [1, 2, 3].map(round => {
  const raw = fs.readFileSync(path.join(root, `tmp/shelf-memory-p0/electron/round-${round}.json`))
  const r = JSON.parse(raw)
  assert.equal(r.errors.length, 0, `round ${round} errors`)
  assert.equal(r.probes.remainingGuests, 0)
  assert.deepEqual(r.scenes.filter(s => s.guests).map(s => s.guests), [1, 10, 30])
  assert.deepEqual(r.scenes.filter(s => s.terminals).map(s => s.terminals), [1, 10, 30])
  fs.writeFileSync(path.join(dest, `electron-round-${round}.json.gz`), gzipSync(raw))
  const phases = [...new Set(r.samples.map(s => s.phase))].map(phase => {
    const samples = r.samples.filter(s => s.phase === phase)
    const sum = (sample, field) => sample.processes.reduce((n, p) => n + p.memory[field], 0) / 1024
    assert.ok(samples.every(s => s.processes.every(p => Number.isFinite(p.memory.privateBytes))))
    // Electron MemoryInfo 单位 KiB，Node process.memoryUsage 单位 byte；重叠字段不相加。
    return { phase, totalPrivateMiB: stats(samples.map(s => sum(s, 'privateBytes'))), totalWorkingSetMiB: stats(samples.map(s => sum(s, 'workingSetSize'))), sampledPeakOnly: true }
  })
  return { round, versions: r.versions, cpu: r.cpu, totalMemory: r.totalMemory, display: r.display, probes: r.probes, phases, samplerMs: stats(r.samples.map(s => s.samplerMs)) }
})
fs.writeFileSync(path.join(dest, 'electron-results.json'), JSON.stringify({ kind: 'isolated-component-fixture', units: 'MiB unless named otherwise', applicationBenchmark: false, productionReady: false, capabilityGate: { safeWebviewClose: rounds.every(r => r.probes.beforeUnload.prevented && r.probes.beforeUnload.survived), hiddenGuestCapture: rounds.every(r => !r.probes.stayHiddenCapture.error) }, externalTasks: 'none launched', sourceCommit: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), rounds }, null, 2))
console.log(JSON.stringify(rounds.map(r => ({ round: r.round, probes: r.probes, phases: r.phases.map(p => ({ phase: p.phase, medianPrivateMiB: p.totalPrivateMiB.p50, peakPrivateMiB: p.totalPrivateMiB.max })) })), null, 2))
