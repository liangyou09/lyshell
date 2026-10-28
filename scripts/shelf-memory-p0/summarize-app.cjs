const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { gzipSync } = require('node:zlib')
const root = path.resolve(__dirname, '../..')
const dest = path.join(root, 'docs/shelf-memory-p0')
fs.mkdirSync(dest, { recursive: true })
const stats = values => {
  assert.ok(values.length > 0 && values.every(Number.isFinite))
  const sorted = [...values].sort((a, b) => a - b)
  const pick = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return { n: sorted.length, min: sorted[0], p50: pick(.5), p95: pick(.95), max: sorted.at(-1) }
}
const runs = []
for (const count of [20, 100]) for (let round = 1; round <= 3; round++) {
  const raw = fs.readFileSync(path.join(root, `tmp/shelf-memory-p0/app/run-${count}-${round}.json`))
  const r = JSON.parse(raw)
  assert.equal(r.errors.length, 0); assert.equal(r.guests, 0)
  assert.equal(r.list.length, 100); assert.equal(r.classification.length, 100)
  fs.writeFileSync(path.join(dest, `app-${count}-${round}.json.gz`), gzipSync(raw))
  const phases = [...new Set(r.samples.map(s => s.phase))].map(phase => {
    const samples = r.samples.filter(s => s.phase === phase)
    assert.ok(samples.every(s => s.processes.every(p => Number.isFinite(p.memory.privateBytes))))
    return { phase, totalPrivateMiB: stats(samples.map(s => s.processes.reduce((n, p) => n + p.memory.privateBytes, 0) / 1024)) }
  })
  runs.push({ count, round, versions: r.versions, window: r.window, devicePixelRatio: r.devicePixelRatio, loadedMs: r.loadedMs, shelfMountedMs: r.shelfMountedMs, visibleTaskCards: r.cards, guests: r.guests, listIpcMs: stats(r.list), classificationIpcMs: stats(r.classification), phases })
}
const results = { kind: 'isolated-full-app-existing-api', scope: 'startup, metadata and existing single archive IPC; no new activation feature', productionReady: false, sampledPeakOnly: true, sourceCommit: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), runs }
fs.writeFileSync(path.join(dest, 'app-results.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(runs.map(r => ({ count: r.count, round: r.round, loadedMs: r.loadedMs, shelfMountedMs: r.shelfMountedMs, visibleTaskCards: r.visibleTaskCards, guests: r.guests, listIpcMs: r.listIpcMs, classificationIpcMs: r.classificationIpcMs, settledPrivateMiB: r.phases.find(p => p.phase === 'settled')?.totalPrivateMiB.p50 })), null, 2))
