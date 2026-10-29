// 核验正式应用对照的原始 PID 样本，并保存可随仓库复现的压缩证据。
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), docs = path.join(root, 'docs/shelf-memory-p0')
const source = path.join(docs, 'deep-sleep-app-codex-results.json')
const result = JSON.parse(fs.readFileSync(source, 'utf8'))
assert.equal(result.validity.status, 'valid', JSON.stringify(result.validity))
assert.equal(result.runs.length, 6)
assert.equal(result.recheck.ok, true)
const rawDir = path.join(docs, 'deep-sleep-codex-raw'); fs.mkdirSync(rawDir, { recursive: true })
const manifests = []
for (const run of result.runs) {
  assert.equal(run.ok, true)
  const raw = fs.readFileSync(path.join(root, run.base, 'result.json'))
  const data = JSON.parse(raw)
  assert.equal(data.memory.errors, 0)
  assert.equal(data.counts.cycles, 34)
  assert.equal(data.cyclesLog.length, 34)
  assert.equal(data.counts.nativeAttaches, run.arm === 'before' ? 12 : 46)
  assert.equal(data.counts.finalGuests, run.arm === 'before' ? 12 : 2)
  assert.ok(data.softFailures.length === 0, JSON.stringify(data.softFailures))
  const types = new Set()
  for (const sample of data.memory.samples) {
    const unique = new Map()
    for (const process of sample.processes) {
      assert.ok(process.pid > 0 && Number.isFinite(process.privateKiB) && process.privateKiB >= 0, 'Missing process private memory')
      unique.set(process.pid, Math.max(process.privateKiB, unique.get(process.pid) ?? 0))
      types.add(process.type)
    }
    assert.equal(unique.size, sample.pidCount)
    const total = [...unique.values()].reduce((a,b) => a+b, 0) / 1024
    assert.ok(Math.abs(total - sample.totalMiB) < 0.002, 'PID dedup / unit mismatch')
  }
  for (const type of ['Browser', 'Tab', 'GPU', 'Utility']) assert.ok(types.has(type), `Missing ${type} process samples`)
  for (const cycle of data.cyclesLog) assert.ok(Number.isFinite(cycle.readyMs) && Number.isFinite(cycle.inputMs) && cycle.inputMs > 0)
  const file = `${run.arm}-${run.round}.json.gz`
  fs.writeFileSync(path.join(rawDir, file), zlib.gzipSync(raw, { level: 9 }))
  manifests.push({ file, sha256: crypto.createHash('sha256').update(raw).digest('hex'), samples: data.memory.samples.length, processTypes: [...types], nativeCreates: data.counts.nativeAttaches, nativeDestroyed: data.counts.nativeDestroyed ?? 0 })
}
const sourceFiles = ['src/main/browser/shelf-browser-runtime.ts', 'src/main/browser/shelf-resource-lifecycle.ts', 'src/main/browser/shelf-readonly-contract.ts', 'src/main/browser/service.ts', 'src/main/ipc/handlers.ts', 'src/main/ipc/validation.ts', 'src/main/storage/task-shelf-repository.ts', 'src/preload/shelf-readonly.ts', 'src/renderer/components/Layout/WebTabLayer.tsx']
result.evidence = { raw: manifests, sourceSha256: Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])), metric: 'All getAppMetrics processes had finite Windows privateBytes; Browser/Tab/GPU/Utility included, deduplicated by PID. Tab includes UI and guest renderers.' }
fs.writeFileSync(source, JSON.stringify(result, null, 2) + '\n')
const rows = result.runs.map(run => `| ${run.round} | ${run.arm} | ${run.memory.loaded.median} | ${run.memory.final.median} | ${result.memory.sampledPeakAllPhasesMiB[run.arm][run.round-1]} |`).join('\n')
const before = result.memory.final.before.medianOfMedians, after = result.memory.final.after.medianOfMedians
const latency = result.latency
const failures = result.priorFailedAttempts ?? []
for (const [index, attempt] of failures.entries()) {
  const raw = fs.readFileSync(path.join(root, attempt.base, 'result.json'))
  fs.writeFileSync(path.join(rawDir, `failed-attempt-${index + 1}.json.gz`), zlib.gzipSync(raw, { level: 9 }))
}
const retryNote = failures.length ? `初次第三轮 before 在第一张页面的实际输入闸门等待超时，未进入循环，原因尚未确定。失败记录保留于汇总的 priorFailedAttempts 和压缩原始证据；未计入成功轮次。保留同一生产构建已完成的两组配对，仅重跑失败的第三组；fixture 增加了可见性核查及已有“显示当前页面”按钮的显式恢复路径（若触发则记录），未改生产实现。最终六个成功进程的 softFailures 均为空；这不消除首次超时所揭示的间歇性首屏风险。` : '本次未记录先前失败尝试。'
fs.writeFileSync(path.join(docs, 'deep-sleep-report.md'), `# 只读副本深睡：完整应用三轮对照

2026-10-28，Electron 43.7.11 / Windows。六个新进程、独立 appData/userData/DSH_HOME，前后交错，同一构建。每轮 10 个显式可丢弃的只读副本、1 个有 beforeunload 和未保存草稿的动态页、1 个 unknown 动态页。每组 102 次成功的打开/重载操作；另用生产 runtime fixture 完成 100 次睡眠/恢复。没有运行真实账号、远端任务或付费模型。

before 是同一只读契约和独立分区关闭自动深睡，after 仅启用自动深睡。这隔离了睡眠功能的影响，**不是旧版本共享分区浏览器与新模式的对照**。默认动态网页不放行；配置 fixture 的覆盖率为 10/12，不能推为真实站点覆盖率。保留原网页再开副本会先增加内存，独立 Session 也有活跃成本。

每个 PID 只计一次 Windows privateBytes（KiB→MiB），原始数据包含 Browser/Tab/GPU/Utility。Tab 包含宿主与 guest renderer；没有叠加 JS heap/external。100ms 采样峰值不是绝对峰值。HTTP 使用本机固定 fixture、no-store 和隔离直连配置。虚拟时间只推进测试主进程 Date.now，五分钟生产阈值未修改；这不等于五分钟真实等待或整机休眠验收。

| 轮 | 实现 | 12页加载稳态 MiB | 长循环后稳态 MiB | 全阶段采样峰值 MiB |
| --- | --- | --- | --- | --- |
${rows}

长循环后总私有内存三轮中位数 **${before} → ${after} MiB**，减少 **${(before-after).toFixed(2)} MiB（${((before-after)/before*100).toFixed(1)}%）**。结论只适用于多个明确可丢弃只读副本闲置的本地合成场景；不是任意网页、真实终端/Agent 混合负载或旧版本的普遍收益保证。峰值及各轮范围应一起看，不能把较低的睡眠稳态描述为启动峰值降低。

| 延迟指标 | before p50 / p95 ms | after p50 / p95 ms | 每组样本数 |
| --- | --- | --- | --- |
| 主区打开/重载到实际可输入、内容与恢复元数据校验 | ${latency.before.readyMs.p50} / ${latency.before.readyMs.p95} | ${latency.after.readyMs.p50} / ${latency.after.readyMs.p95} | ${latency.after.readyMs.n} |
| 原生滚轮输入到隔离 preload 的滚动 IPC | ${latency.before.wheelToPreloadIpcMs.p50} / ${latency.before.wheelToPreloadIpcMs.p95} | ${latency.after.wheelToPreloadIpcMs.p50} / ${latency.after.wheelToPreloadIpcMs.p95} | ${latency.after.wheelToPreloadIpcMs.n} |

可输入时间包含 UI 的 100ms 观测间隔，滚轮 IPC 包含应用遥测节流；均不是硬件键盘/IME 输入时延。after 的恢复代价与释放收益需一并评估。

${retryNote}

三轮最终均为 10 sleeping、2 动态 guest 存活；草稿不变、无禁用路径请求、分区/缩放/非零滚动恢复匹配。每轮 native create 为 before 12 / after 46，after 销毁 44；卡片和快照保留。新进程重读快照归入 Archive、0 guest、10 份原分区快照，bootId 换代。

复现：先构建并建立脚本要求的本地 ready 标记，再运行 \`node scripts/shelf-memory-p0/deep-sleep-app-codex.cjs --rounds=3 --cycles=34\`，最后运行 \`node scripts/shelf-memory-p0/summarize-deep-sleep.cjs\`。详细汇总为 [JSON](deep-sleep-app-codex-results.json)，六轮全部原始 PID 样本为 [压缩证据](deep-sleep-codex-raw/)；JSON 记录每份原始文件 SHA-256 和源码摘要。

尚未验证真实 SSH/PTY 持续输出、Agent/审批混合高负载、实际整机锁屏/休眠、硬件中文 IME、混合 DPI/多屏或低内存设备；相关资源未加入自动销毁路径。原生 Harness 的本轮应用测试委派失联未确认完成，正式三轮对照由 Codex 独立修正 fixture 并执行，不能把原委派草稿当验收通过。
`)
console.log(JSON.stringify({ valid: true, runs: result.runs.length, rawFiles: manifests.length, beforeMiB: before, afterMiB: after }))
