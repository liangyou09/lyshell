const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { gzipSync } = require('node:zlib')
const root = path.resolve(__dirname, '../..')
const dest = path.join(root, 'docs/shelf-memory-p0')
const file = path.join(dest, 'history-results.json')
const result = JSON.parse(fs.readFileSync(file, 'utf8'))
assert.equal(result.acceptance.pass, true)
assert.equal(result.consistency.totals.mismatches, 0)
assert.equal(result.runs.length, 3)
const checksums = []
for (const run of result.runs) {
  const raw = fs.readFileSync(path.join(root, run.rawFile))
  const child = JSON.parse(raw)
  checksums.push(child.corpus.summary.checksum)
  for (const scenario of child.scenarios) for (const entry of Object.values(scenario.timings)) {
    assert.ok(entry.units.every(n => Number.isSafeInteger(n) && n >= 0))
  }
  fs.writeFileSync(path.join(dest, `history-round-${run.rep}.json.gz`), gzipSync(raw))
}
assert.equal(new Set(checksums).size, 1, '各轮须为相同语料')
// 测量完成后的元数据勘误，不修改计时/内存样本。
result.method.independence = '父进程打包一次，每个 rep 在独立 node 进程（--expose-gc）重新加载相同实现与相同 seeded 语料，进程间不共享堆或缓存'
result.limitations.push('同一轮各缓冲复用语料字符串池，原始字符串可能共享；raw_only 不是不同真实会话原文内存的估计，派生缓存差值不等于应用总收益')
result.limitations = [...new Set(result.limitations)]
fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n')
const rows = result.operations.filter(o => ['append_steady', 'recent_cold', 'since_large', 'clear'].includes(o.operation)).map(o => `| ${o.buffers} | ${o.operation} | ${o.samples} | ${o.stats.p50Ms} | ${o.stats.p95Ms} | ${o.stats.minMs}–${o.stats.maxMs} |`)
const memory = result.memory.map(m => `| ${m.buffers} | ${(m.states.raw_only.heapUsed.median / 1048576).toFixed(2)} | ${(m.derivedHoldBytesMedian / 1048576).toFixed(2)} |`)
fs.writeFileSync(path.join(dest, 'history-report.md'), `# P0 输出缓冲基准结果

命令：\`node scripts/shelf-memory-p0/history-benchmark.cjs\`，随后 \`node scripts/shelf-memory-p0/summarize-history.cjs\`。

执行环境 ${result.environment.node} / ${result.environment.platform}，源提交 ${result.git.head}。三个独立进程、每轮相同 seeded 语料、默认每缓冲 1048576 个 UTF-16 码元保留上限。${result.consistency.totals.checks} 次语义检查，0 不一致；与 git ad246a3 的原始单字符串实现比较 raw、ANSI 清洗、游标、clear、trim 与孤立代理项。该旧实现只作为语义对照，没有进行性能比较。基准验收通过。

| 缓冲数 | 操作 | 样本数 | p50 ms | p95 ms | 范围 ms |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

计时使用 hrtime；百分位采用 R7 插值。append_steady 包含稳态 trim；recent_cold 每次写入失效后读取全保留区并取最后50行；since_large 读取262144码元增量。它们是同步函数耗时，不代表终端输入或完整 MCP 的往返延迟。

| 缓冲数 | raw_only 进程 heapUsed 中位数 MiB | 填充派生缓存后 heapUsed 增量 MiB |
| --- | --- | --- |
${memory.join('\n')}

每个内存状态采样5轮，每轮两次显式GC并让出事件循环；JSON同时保留 rss、heapTotal、heapUsed、external、arrayBuffers，不把重叠字段相加。各缓冲共享固定语料池，raw_only 低值不能解释为真实会话都只占这些内存。派生缓存增量是潜在优化对象的证据，不是已实现的收益。内存测量在独立 Node 进程中，未测 Electron 总量、GC暂停或真实PTY背压。

原始样本：history-round-{1,2,3}.json.gz；精确汇总：history-results.json。修复了工具的增量长度统计、子进程入口与嵌套启动保护；子进程时间和stdout/stderr均有边界。25项脚本测试通过。生产源码未修改。

旧后台任务重启后不可跟踪；新后台续做任务经权威状态确认 cancelled，随后由 Codex 完成本次修正、执行和审查。不得把旧任务记作 completed。OutputBuffer仍有同步调用者，未确认可迁移的独立冷历史，Rust生产迁移保持关闭。完整P0的其他未验收项见 README.md。
`)
console.log('History samples archived; checksums and unit bounds verified')
