const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { gzipSync } = require('node:zlib')
const root = path.resolve(__dirname, '../..'), dest = path.join(root, 'docs/shelf-memory-acceptance')
fs.mkdirSync(dest, { recursive: true })
function stats(values) {
  assert.ok(values.length && values.every(Number.isFinite))
  const sorted = [...values].sort((a, b) => a - b)
  const pick = p => { const x = (sorted.length - 1) * p, lower = Math.floor(x); return sorted[lower] + (sorted[Math.ceil(x)] - sorted[lower]) * (x - lower) }
  return { n: sorted.length, min: sorted[0], p50: pick(.5), p95: pick(.95), max: sorted.at(-1) }
}
const runs = []
for (const count of [20, 100]) for (let round = 1; round <= 3; round++) {
  const bytes = fs.readFileSync(path.join(root, `tmp/shelf-memory-acceptance/run-${count}-${round}.json`)), raw = JSON.parse(bytes)
  assert.deepEqual(raw.errors, [])
  assert.equal(raw.archiveGuests, 0); assert.ok(raw.automaticGuests <= 4); assert.equal(raw.explicitGuests, raw.automaticGuests + 1)
  assert.equal(raw.listLatency.length, 100); assert.equal(raw.classificationLatency.length, 100)
  assert.equal(raw.final.entries.length, count); assert.ok(raw.final.entries.every(entry => !entry.archivedAt))
  const phases = [...new Set(raw.samples.map(sample => sample.phase))].map(phase => {
    const rows = raw.samples.filter(sample => sample.phase === phase)
    const total = rows.map(sample => {
      const processes = [...new Map(sample.processes.map(process => [process.pid, process])).values()]
      assert.ok(processes.every(process => Number.isFinite(process.memory.privateBytes)))
      return processes.reduce((sum, process) => sum + process.memory.privateBytes, 0) / 1024
    })
    return { phase, privateMiB: stats(total) }
  })
  fs.writeFileSync(path.join(dest, `app-${count}-${round}.json.gz`), gzipSync(bytes))
  runs.push({ count, round, electron: raw.versions.electron, node: raw.versions.node, chrome: raw.versions.chrome, dpr: raw.dpr, window: raw.window, proxy: raw.proxy, startupMs: raw.startupMs, activateAllMs: raw.activateAllMs, archiveGuests: raw.archiveGuests, automaticGuests: raw.automaticGuests, explicitGuests: raw.explicitGuests, nativeAttaches: raw.nativeAttaches, handshakes: raw.handshakes, mainViewport: raw.mainViewport, mainElement: raw.mainElement, listIpcMs: stats(raw.listLatency), activationIpcMs: stats(raw.classificationLatency), phases, peakPrivateMiB: Math.max(...phases.map(phase => phase.privateMiB.max)) })
}
const result = { schema: 1, kind: 'isolated-full-app-acceptance', sampledPeakOnly: true, notes: ['每规模启动/全部激活各3样本；不能当作100次UI操作的p95。', '每轮100次list和100次activation IPC；不含原生鼠标/IME延迟。', '窗口为测试固定可见性；不访问真实用户档案。', '含全部应用子进程的私有内存，JS heap/external不另行叠加。', '与P0场景不同，不能直接用差值声称内存收益。'], runs }
fs.writeFileSync(path.join(dest, 'results.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(runs.map(run => ({ count: run.count, round: run.round, startupMs: run.startupMs, activateAllMs: run.activateAllMs, guests: [run.archiveGuests, run.automaticGuests, run.explicitGuests], activationP95: run.activationIpcMs.p95, peakPrivateMiB: run.peakPrivateMiB })), null, 2))
