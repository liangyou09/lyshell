'use strict'

/**
 * P0 基准 CLI 的参数边界、统计函数与输出路径测试。
 * 目标：CLI 可以被复跑，且越界参数一定失败（不会静默扩大保留上限或写到范围外）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const bench = require('./history-benchmark.cjs')

const CLI = path.join(__dirname, 'history-benchmark.cjs')

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: bench.ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true })
}

test('--child 只返回单轮 JSON，不进入主调度循环', () => {
  const bundles = bench.buildBundles()
  const result = cli(['--child', `--bundle=${bundles.current.outfile}`, `--legacy-bundle=${bundles.legacy.outfile}`, '--rep=1', '--buffers=1', '--max-bytes=64', '--chunk-units=64'])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.mode, 'child')
  assert.equal(parsed.rep, 1)
  assert.equal(parsed.scenarios.length, 1)
  assert.equal(parsed.scenarios[0].buffers, 1)
  assert.equal(parsed.consistency.totals.mismatches, 0)
})

test('默认参数与方案一致：1M 码元上限、1/10/30 缓冲、100 样本、3 个独立进程', () => {
  const opts = bench.parseArgs([])
  assert.equal(opts.seed, 20261028)
  assert.deepEqual(opts.buffers, [1, 10, 30])
  assert.equal(opts.iterations, 100)
  assert.equal(opts.repeat, 3)
  assert.equal(opts.maxBytes, 1048576)
  assert.equal(bench.RETAIN_LIMIT_UNITS, 1048576)
  assert.deepEqual([...bench.ALLOWED_BUFFER_COUNTS], [1, 10, 30])
  assert.equal(bench.REQUIRED_SAMPLES, 100)
  assert.equal(opts.mode, 'main')
  assert.equal(opts.writeOut, true)
  assert.equal(opts.verifyOnly, false)
  assert.equal(path.basename(opts.out), 'history-results.json')
  assert.deepEqual([...bench.REQUIRED_OPERATIONS], ['append_steady', 'recent_cold', 'since_large', 'clear'])
})

test('--iterations 边界：100..2000', () => {
  assert.equal(bench.parseArgs(['--iterations=100']).iterations, 100)
  assert.equal(bench.parseArgs(['--iterations=2000']).iterations, 2000)
  for (const bad of ['--iterations=99', '--iterations=2001', '--iterations=0', '--iterations=abc', '--iterations=1.5']) {
    assert.throws(() => bench.parseArgs([bad]), bench.UsageError, bad)
  }
})

test('--repeat 边界：3..8（更少进程无法满足“至少 3 次独立运行”）', () => {
  assert.equal(bench.parseArgs(['--repeat=3']).repeat, 3)
  assert.equal(bench.parseArgs(['--repeat=8']).repeat, 8)
  for (const bad of ['--repeat=2', '--repeat=9', '--repeat=0']) {
    assert.throws(() => bench.parseArgs([bad]), bench.UsageError, bad)
  }
})

test('--max-bytes 只能收紧、不能扩大：1048577 必须被拒绝', () => {
  assert.equal(bench.parseArgs(['--max-bytes=1048576']).maxBytes, 1048576)
  assert.equal(bench.parseArgs(['--max-bytes=64']).maxBytes, 64)
  for (const bad of ['--max-bytes=1048577', '--max-bytes=2097152', '--max-bytes=63', '--max-bytes=-1']) {
    assert.throws(() => bench.parseArgs([bad]), bench.UsageError, bad)
  }
  // 上限收紧到小于块长时，块长跟着收敛，避免“块永远走 bulk 替换路径”
  const tight = bench.parseArgs(['--max-bytes=64', '--chunk-units=4096'])
  assert.equal(tight.chunkUnits, 64)
})

test('--buffers 只接受 1/10/30 的组合，重复档位直接拒绝', () => {
  assert.deepEqual(bench.parseArgs(['--buffers=30,1,10']).buffers, [1, 10, 30])
  assert.deepEqual(bench.parseArgs(['--buffers=10']).buffers, [10])
  for (const bad of ['--buffers=1,1,10', '--buffers=2', '--buffers=0', '--buffers=1,2', '--buffers=', '--buffers=a,b']) {
    assert.throws(() => bench.parseArgs([bad]), bench.UsageError, bad)
  }
})

test('--seed / --warmup / --chunk-units 边界', () => {
  assert.equal(bench.parseArgs(['--seed=0']).seed, 0)
  assert.equal(bench.parseArgs(['--seed=4294967295']).seed, 4294967295)
  for (const bad of ['--seed=4294967296', '--seed=-1', '--seed=1e9']) {
    assert.throws(() => bench.parseArgs([bad]), bench.UsageError, bad)
  }
  assert.equal(bench.parseArgs(['--warmup=0']).warmup, 0)
  assert.equal(bench.parseArgs(['--warmup=1000']).warmup, 1000)
  assert.throws(() => bench.parseArgs(['--warmup=1001']), bench.UsageError)
  assert.equal(bench.parseArgs(['--chunk-units=64']).chunkUnits, 64)
  assert.equal(bench.parseArgs(['--chunk-units=65536']).chunkUnits, 65536)
  assert.throws(() => bench.parseArgs(['--chunk-units=63']), bench.UsageError)
  assert.throws(() => bench.parseArgs(['--chunk-units=65537']), bench.UsageError)
})

test('未知参数与非 --name=value 形式都被拒绝', () => {
  for (const bad of ['--nope=1', '--seed', '-x', 'seed=1', '--seed=1 --extra']) {
    assert.throws(() => bench.parseArgs(bad.split(' ')), bench.UsageError, bad)
  }
})

test('--out 只能落在两个声明的长期位置', () => {
  const docs = bench.resolveOutPath('docs/shelf-memory-p0/history-results.json')
  assert.ok(docs.endsWith(path.join('docs', 'shelf-memory-p0', 'history-results.json')))
  const tmp = bench.resolveOutPath('tmp/shelf-memory-p0/history/nested/run.json')
  assert.ok(tmp.endsWith(path.join('tmp', 'shelf-memory-p0', 'history', 'nested', 'run.json')))

  for (const bad of [
    'docs/shelf-memory-p0/other.json',
    'docs/other-report.json',
    'src/main/x.json',
    'tmp/shelf-memory-p0/history/../../escape.json',
    'tmp/other/run.json',
    'docs/shelf-memory-p0/history-results.txt'
  ]) {
    assert.throws(() => bench.resolveOutPath(bad), bench.UsageError, bad)
  }
  const parsed = bench.parseArgs(['--out=tmp/shelf-memory-p0/history/x.json', '--no-out'])
  assert.equal(parsed.writeOut, false)
  assert.ok(parsed.out.endsWith('x.json'))
})

test('百分位用 R7 线性插值，空样本不编造数字', () => {
  assert.deepEqual(bench.summarizeTimes([]), { samples: 0 })
  assert.deepEqual(bench.summarizeTimes([Number.NaN, undefined]), { samples: 0 })
  assert.equal(bench.percentile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(bench.percentile([1, 2, 3, 4], 0), 1)
  assert.equal(bench.percentile([1, 2, 3, 4], 1), 4)
  assert.equal(bench.percentile([5], 0.95), 5)
  assert.equal(bench.percentile([], 0.5), null)
  assert.equal(bench.medianValue([3, 1, 2]), 2)

  const stats = bench.summarizeTimes([4, 1, 3, 2])
  assert.equal(stats.samples, 4)
  assert.equal(stats.minMs, 1)
  assert.equal(stats.maxMs, 4)
  assert.equal(stats.p50Ms, 2.5)
  assert.ok(stats.p95Ms >= stats.p50Ms && stats.p95Ms <= stats.maxMs)
  assert.equal(stats.meanMs, 2.5)
  // 输入数组不被原地排序污染
  const source = [4, 1, 3, 2]
  bench.summarizeTimes(source)
  assert.deepEqual(source, [4, 1, 3, 2])
})

test('计时 units 边界：负值/非整数一律拒绝，结果收集器能定位负 units', () => {
  const sink = bench.createTimingSink()
  sink.record('since_large', 1.5, 0, 1024)
  sink.record('since_large', 1.5, 262144, 1048576)
  assert.deepEqual(sink.ops.get('since_large').units, [0, 262144])

  assert.throws(() => sink.record('since_large', 1, -1, 1024), /units/)
  assert.throws(() => sink.record('since_warm', 1, -689280, 1048576), /units/)
  assert.throws(() => sink.record('since_large', 1, 1.5, 1024), /units/)
  assert.throws(() => sink.record('since_large', 1, Number.NaN, 1024), /units/)

  const good = [
    { rep: 1, child: { scenarios: [{ buffers: 10, timings: { since_large: { units: [262144, 0] } } }] } }
  ]
  assert.deepEqual(bench.collectNegativeUnits(good), [])

  const negative = bench.collectNegativeUnits([
    { rep: 2, child: { scenarios: [{ buffers: 30, timings: { since_large: { units: [262144, -689280] } } }] } }
  ])
  assert.deepEqual(negative, [{ rep: 2, buffers: 30, operation: 'since_large', min: -689280 }])

  // NaN 也不能当成合法结果
  const invalid = bench.collectNegativeUnits([
    { rep: 3, child: { scenarios: [{ buffers: 1, timings: { since_warm: { units: [Number.NaN] } } }] } }
  ])
  assert.equal(invalid.length, 1)
})

test('CLI --help 退出码 0 且说明不扩大保留上限', () => {
  const result = cli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--max-bytes/)
  assert.match(result.stdout, /不扩大上限/)
})

test('CLI 参数错误退出码 2 并打印用法', () => {
  for (const bad of [['--iterations=5'], ['--max-bytes=1048577'], ['--buffers=2'], ['--out=docs/x.json']]) {
    const result = cli(bad)
    assert.equal(result.status, 2, `${bad.join(' ')} 应当以 2 退出`)
    assert.match(result.stderr, /参数错误/)
  }
})

test('CLI --verify-only 对拍真实实现与历史实现，0 不一致', () => {
  const result = cli(['--verify-only', '--no-out', '--seed=20261028'])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.mode, 'verify-only')
  assert.equal(parsed.seed, 20261028)
  assert.equal(parsed.consistency.totals.mismatches, 0)
  assert.ok(parsed.consistency.totals.checks > 1000, `检查次数过少: ${parsed.consistency.totals.checks}`)
  assert.equal(parsed.consistency.loneSurrogateChecked, true)
  const names = parsed.consistency.cases.map((item) => item.name)
  assert.ok(names.includes('parity_lone_surrogate_1024'))
  assert.ok(names.includes('surrogate_split_trim_101'))
  assert.ok(names.includes('large_retention_1048576'))
  for (const item of parsed.consistency.cases) {
    assert.equal(item.mismatches, 0, `${item.name} 出现不一致`)
    assert.ok(item.checks > 0)
  }
  assert.equal(parsed.bundles.esbuildVersion, require(require.resolve('esbuild', { paths: [bench.ROOT] })).version)
  assert.ok(fs.existsSync(parsed.bundles.current.outfile))
  assert.ok(fs.existsSync(parsed.bundles.legacy.outfile))
})
