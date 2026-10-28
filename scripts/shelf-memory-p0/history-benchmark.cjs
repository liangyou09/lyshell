#!/usr/bin/env node
'use strict'

/**
 * P0 固定日志与输出缓冲基准（LyShell shelf-memory-p0）
 *
 * 做什么：
 * - 用工作区已有的 esbuild 把 src/main/terminal/output-buffer.ts 打包到临时目录，
 *   直接测真实实现（不是复刻一份“差不多”的类）；
 * - 用 scripts/shelf-memory-p0/history-fixtures.cjs 的 seeded 固定语料，按默认
 *   1M UTF-16 码元上限，覆盖 1 / 10 / 30 个并发缓冲实例（会话）；
 * - 至少 3 个独立子进程（--expose-gc）各自完成 append / recent / since / clear /
 *   trim 场景，报告样本数、p50 / p95 / 范围与 process.memoryUsage 全部字段；
 * - 与 git 历史版本 ad246a3 的单字符串实现逐码元比对 cursor / raw / trim / clear /
 *   孤立代理项；
 * - 输出原始 JSON（默认 docs/shelf-memory-p0/history-results.json），子进程原始
 *   结果留在 tmp/shelf-memory-p0/history/raw/。
 *
 * 不做什么：不改生产源码、不接压缩或 Rust、不安装依赖、不测 Electron 全应用内存。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const fixtures = require('./history-fixtures.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const TMP_DIR = path.join(ROOT, 'tmp', 'shelf-memory-p0', 'history')
const DOCS_DIR = path.join(ROOT, 'docs', 'shelf-memory-p0')
const DEFAULT_OUT = path.join(DOCS_DIR, 'history-results.json')
const RAW_DIR = path.join(TMP_DIR, 'raw')

/** OutputBuffer 的默认保留上限（UTF-16 码元）；本基准不允许扩大 */
const RETAIN_LIMIT_UNITS = 1024 * 1024
/** 方案 3.2 的场景档位：1 / 10 / 30 个并发缓冲实例 */
const ALLOWED_BUFFER_COUNTS = Object.freeze([1, 10, 30])
/** 与基准对照的历史实现（单字符串缓冲，语义基准） */
const LEGACY_REF = 'ad246a3'
const LEGACY_SOURCE_PATH = 'src/main/terminal/output-buffer.ts'

const MIN_ITERATIONS = 100
const MAX_ITERATIONS = 2000
const MIN_REPEAT = 3
const MAX_REPEAT = 8
const MIN_CHUNK_UNITS = 64
const MAX_CHUNK_UNITS = 65536
const MAX_SEED = 0xffffffff
/** 验收要求：主要操作至少 100 次 */
const REQUIRED_OPERATIONS = Object.freeze(['append_steady', 'recent_cold', 'since_large', 'clear'])
const REQUIRED_SAMPLES = 100
/** 单次 since 大增量场景的窗口（码元），不超过保留上限 */
const SINCE_LARGE_WINDOW = 262144
/** 子进程 stdout / stderr 缓冲上限与单轮执行时间上限（超限明确失败） */
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_CHILD_STDERR_BYTES = 1024 * 1024
const CHILD_TIMEOUT_MS = 180 * 1000
const MEMORY_FIELDS = Object.freeze(['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'])
const OP_ORDER = Object.freeze([
  'append_fill',
  'append_steady',
  'append_replace',
  'recent_cold',
  'recent_warm',
  'since_large',
  'since_warm',
  'since_recent',
  'raw_full',
  'clear'
])

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'EUSAGE'
  }
}

// ---------------------------------------------------------------------------
// 参数解析与边界
// ---------------------------------------------------------------------------

function parseIntInRange(name, raw, min, max) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new UsageError(`${name} 需要一个整数`)
  if (!/^-?\d+$/.test(raw.trim())) throw new UsageError(`${name} 必须是整数，收到: ${raw}`)
  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value)) throw new UsageError(`${name} 超出安全整数范围: ${raw}`)
  if (value < min || value > max) throw new UsageError(`${name} 必须在 ${min}..${max} 之间，收到: ${value}`)
  return value
}

function parseBufferList(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new UsageError('--buffers 需要一个逗号分隔的整数列表')
  const parts = raw.split(',').map((item) => item.trim())
  if (parts.length === 0) throw new UsageError('--buffers 不能为空')
  const values = []
  for (const part of parts) {
    const value = parseIntInRange('--buffers', part, 1, Math.max(...ALLOWED_BUFFER_COUNTS))
    if (!ALLOWED_BUFFER_COUNTS.includes(value)) {
      throw new UsageError(
        `--buffers 只允许方案档位 ${ALLOWED_BUFFER_COUNTS.join('/')}（不扩大保留上限），收到: ${value}`
      )
    }
    if (values.includes(value)) throw new UsageError(`--buffers 存在重复档位: ${value}`)
    values.push(value)
  }
  return values.sort((a, b) => a - b)
}

function isInside(parent, target) {
  const rel = path.relative(parent, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 只允许写到本任务声明的两个长期位置：
 * - tmp/shelf-memory-p0/history/**\/*.json
 * - docs/shelf-memory-p0/history-results.json
 */
function resolveOutPath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new UsageError('--out 需要一个路径')
  const abs = path.resolve(ROOT, value.trim())
  if (!abs.toLowerCase().endsWith('.json')) throw new UsageError(`--out 必须是 .json 文件: ${abs}`)
  if (isInside(DOCS_DIR, abs)) {
    if (path.basename(abs).toLowerCase() !== 'history-results.json') {
      throw new UsageError('docs/shelf-memory-p0/ 下只允许写 history-results.json')
    }
    return abs
  }
  if (isInside(TMP_DIR, abs)) return abs
  throw new UsageError(
    `--out 必须位于 tmp/shelf-memory-p0/history/ 或 docs/shelf-memory-p0/history-results.json，收到: ${abs}`
  )
}

function splitFlag(arg) {
  const eq = arg.indexOf('=')
  if (eq < 0) return { flag: arg, value: undefined }
  return { flag: arg.slice(0, eq), value: arg.slice(eq + 1) }
}

/**
 * 解析 CLI 参数。导出给测试直接断言边界，不做任何 IO。
 * @param {string[]} argv 不含 node 与脚本名
 */
function parseArgs(argv) {
  const opts = {
    mode: 'main',
    seed: 20261028,
    buffers: [...ALLOWED_BUFFER_COUNTS],
    iterations: MIN_ITERATIONS,
    repeat: MIN_REPEAT,
    maxBytes: RETAIN_LIMIT_UNITS,
    chunkUnits: fixtures.DEFAULT_CHUNK_UNITS,
    warmup: 10,
    out: DEFAULT_OUT,
    writeOut: true,
    verifyOnly: false,
    help: false,
    bundle: null,
    legacyBundle: null,
    rep: 0
  }

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true
      continue
    }
    if (arg === '--child') {
      opts.mode = 'child'
      continue
    }
    if (arg === '--verify-only') {
      opts.verifyOnly = true
      continue
    }
    if (arg === '--no-out') {
      opts.writeOut = false
      continue
    }
    if (!arg.startsWith('--')) throw new UsageError(`无法识别的参数: ${arg}`)

    const { flag, value } = splitFlag(arg)
    if (value === undefined) throw new UsageError(`参数需要 --name=value 形式: ${arg}`)
    switch (flag) {
      case '--seed':
        opts.seed = parseIntInRange('--seed', value, 0, MAX_SEED)
        break
      case '--buffers':
        opts.buffers = parseBufferList(value)
        break
      case '--iterations':
        opts.iterations = parseIntInRange('--iterations', value, MIN_ITERATIONS, MAX_ITERATIONS)
        break
      case '--repeat':
        opts.repeat = parseIntInRange('--repeat', value, MIN_REPEAT, MAX_REPEAT)
        break
      case '--max-bytes':
        opts.maxBytes = parseIntInRange('--max-bytes', value, MIN_CHUNK_UNITS, RETAIN_LIMIT_UNITS)
        break
      case '--chunk-units':
        opts.chunkUnits = parseIntInRange('--chunk-units', value, MIN_CHUNK_UNITS, MAX_CHUNK_UNITS)
        break
      case '--warmup':
        opts.warmup = parseIntInRange('--warmup', value, 0, 1000)
        break
      case '--out':
        opts.out = resolveOutPath(value)
        break
      case '--bundle':
        opts.bundle = path.resolve(ROOT, value)
        break
      case '--legacy-bundle':
        opts.legacyBundle = path.resolve(ROOT, value)
        break
      case '--rep':
        opts.rep = parseIntInRange('--rep', value, 1, 99)
        break
      default:
        throw new UsageError(`无法识别的参数: ${flag}`)
    }
  }

  if (opts.maxBytes < opts.chunkUnits) opts.chunkUnits = opts.maxBytes
  if (opts.mode === 'child') {
    if (!opts.bundle || !opts.legacyBundle) throw new UsageError('--child 模式需要 --bundle 与 --legacy-bundle')
    if (!fs.existsSync(opts.bundle)) throw new UsageError(`打包文件不存在: ${opts.bundle}`)
    if (!fs.existsSync(opts.legacyBundle)) throw new UsageError(`对照打包文件不存在: ${opts.legacyBundle}`)
    if (opts.rep < 1) throw new UsageError('--child 模式需要 --rep')
    if (opts.writeOut) opts.writeOut = false
  }
  return opts
}

function printHelp() {
  const lines = [
    'P0 固定日志与输出缓冲基准（真实 OutputBuffer）',
    '',
    '用法:',
    '  node scripts/shelf-memory-p0/history-benchmark.cjs [--key=value ...]',
    '  node scripts/shelf-memory-p0/history-benchmark.cjs --verify-only [--seed=N]',
    '',
    '参数（全部 --name=value 形式；未知参数直接报错）:',
    `  --seed=N            0..${MAX_SEED}，默认 20261028`,
    `  --buffers=1,10,30   并发缓冲实例数，只允许 ${ALLOWED_BUFFER_COUNTS.join('/')} 的组合`,
    `  --iterations=N      ${MIN_ITERATIONS}..${MAX_ITERATIONS} 每种主要操作的样本数，默认 ${MIN_ITERATIONS}`,
    `  --repeat=N          ${MIN_REPEAT}..${MAX_REPEAT} 个独立子进程，默认 ${MIN_REPEAT}`,
    `  --max-bytes=N       ${MIN_CHUNK_UNITS}..${RETAIN_LIMIT_UNITS} 码元保留上限，默认 ${RETAIN_LIMIT_UNITS}`,
    `  --chunk-units=N     ${MIN_CHUNK_UNITS}..${MAX_CHUNK_UNITS} 单次 append 的码元数，默认 ${fixtures.DEFAULT_CHUNK_UNITS}`,
    `  --warmup=N          0..1000 预热次数，默认 10`,
    `  --out=PATH          只允许 tmp/shelf-memory-p0/history/**/*.json 或 docs/shelf-memory-p0/history-results.json`,
    '  --no-out            不写文件，只打印',
    '  --verify-only       只做逐码元一致性校验（快，不产出性能数据）',
    '',
    '说明: 保留上限固定为 OutputBuffer 默认 1M 码元，CLI 拒绝更大值；不扩大上限。'
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 线性插值（R7）：index = (n-1) * p */
function percentile(sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

/** 汇总一组耗时（ms）；样本为 0 时返回 samples: 0 */
function summarizeTimes(values) {
  const clean = (values || []).filter((value) => Number.isFinite(value))
  if (clean.length === 0) return { samples: 0 }
  const sorted = clean.slice().sort((a, b) => a - b)
  const total = clean.reduce((sum, value) => sum + value, 0)
  return {
    samples: sorted.length,
    minMs: round(sorted[0]),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(total / sorted.length)
  }
}

function medianValue(values) {
  const clean = (values || []).filter((value) => Number.isFinite(value))
  if (!clean.length) return null
  const sorted = clean.slice().sort((a, b) => a - b)
  return percentile(sorted, 0.5)
}

function digestNumbers(values) {
  const hash = crypto.createHash('sha256')
  hash.update(values.map((value) => round(value, 6)).join(','))
  return hash.digest('hex').slice(0, 16)
}

function firstDiffIndex(actual, expected) {
  const limit = Math.min(actual.length, expected.length)
  for (let i = 0; i < limit; i += 1) {
    if (actual.charCodeAt(i) !== expected.charCodeAt(i)) return i
  }
  return actual.length === expected.length ? -1 : limit
}

function previewValue(value) {
  if (typeof value === 'string') {
    const head = value.length > 120 ? value.slice(0, 120) : value
    return { type: 'string', units: value.length, checksum: fixtures.checksumUnits(value).slice(0, 16), head: JSON.stringify(head) }
  }
  return { type: typeof value, value }
}

// ---------------------------------------------------------------------------
// 打包：真实实现 + 历史对照实现
// ---------------------------------------------------------------------------

function ensureTmpDirs() {
  fs.mkdirSync(path.join(TMP_DIR, 'bundle'), { recursive: true })
  fs.mkdirSync(path.join(TMP_DIR, 'oracle'), { recursive: true })
  fs.mkdirSync(RAW_DIR, { recursive: true })
}

function bundleFile(esbuild, entryPoint, outfile, banner) {
  const startedAt = process.hrtime.bigint()
  esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node22'],
    logLevel: 'silent',
    sourcemap: false,
    outfile,
    banner: { js: banner }
  })
  const buildMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  const bytes = fs.statSync(outfile).size
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outfile)).digest('hex')
  return { entryPoint, outfile, bytes, buildMs: round(buildMs), sha256 }
}

function extractLegacySource() {
  const result = spawnSync('git', ['-C', ROOT, 'show', `${LEGACY_REF}:${LEGACY_SOURCE_PATH}`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`无法读取历史实现 ${LEGACY_REF}:${LEGACY_SOURCE_PATH}: ${(result.stderr || '').trim()}`)
  }
  // 用正斜杠绝对路径：Windows 上 JSON 转义会引入反斜杠，直接用 path 会破坏包含性校验
  const ansiPath = path.join(ROOT, 'src', 'main', 'terminal', 'ansi-stripper.ts').split(path.sep).join('/')
  const source = result.stdout.replace(/from\s+['"]\.\/ansi-stripper['"]/g, `from ${JSON.stringify(ansiPath)}`)
  if (!source.includes(ansiPath)) {
    throw new Error('历史实现的 ansi-stripper 导入未能改写，拒绝使用不可信的对照实现')
  }
  return source
}

/**
 * 打包两个实现。当前实现直接取自工作区源码；对照实现取自 git 历史版本，
 * 只把相对导入改写成绝对路径后打包，其余代码不改。
 */
function buildBundles() {
  ensureTmpDirs()
  const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }))
  const currentEntry = path.join(ROOT, LEGACY_SOURCE_PATH)
  if (!fs.existsSync(currentEntry)) throw new Error(`当前实现不存在: ${currentEntry}`)

  const current = bundleFile(
    esbuild,
    currentEntry,
    path.join(TMP_DIR, 'bundle', 'output-buffer.cjs'),
    '/* P0 benchmark bundle: src/main/terminal/output-buffer.ts (working tree) */'
  )

  const legacySourcePath = path.join(TMP_DIR, 'oracle', 'legacy-output-buffer.ts')
  fs.writeFileSync(legacySourcePath, extractLegacySource(), 'utf8')
  const legacy = bundleFile(
    esbuild,
    legacySourcePath,
    path.join(TMP_DIR, 'bundle', 'legacy-output-buffer.cjs'),
    `/* P0 benchmark oracle bundle: ${LEGACY_REF}:${LEGACY_SOURCE_PATH} */`
  )

  return { current, legacy: { ...legacy, ref: LEGACY_REF, sourcePath: LEGACY_SOURCE_PATH }, esbuildVersion: esbuild.version }
}

function loadImplementations(bundlePath, legacyBundlePath) {
  const currentModule = require(bundlePath)
  const legacyModule = require(legacyBundlePath)
  if (typeof currentModule.OutputBuffer !== 'function') throw new Error(`打包结果没有导出 OutputBuffer: ${bundlePath}`)
  if (typeof legacyModule.OutputBuffer !== 'function') throw new Error(`对照打包结果没有导出 OutputBuffer: ${legacyBundlePath}`)
  return { current: currentModule.OutputBuffer, legacy: legacyModule.OutputBuffer }
}

// ---------------------------------------------------------------------------
// 逐码元一致性校验（真实实现 vs 历史单字符串实现）
// ---------------------------------------------------------------------------

const ALL_KINDS = fixtures.FIXTURE_KINDS
const PARITY_CAPS = Object.freeze([37, 1024, 4096])
const DEFAULT_RECENT_COUNTS = Object.freeze([0, 1, 3, 50])

function createCaseResult(name, meta = {}) {
  return {
    name,
    kind: meta.kind || null,
    maxBytes: meta.maxBytes ?? null,
    ops: 0,
    checks: 0,
    mismatches: 0,
    firstMismatch: null,
    loneSurrogate: { high: 0, low: 0 },
    notes: [],
    ...meta
  }
}

function checkEqual(result, label, actual, expected) {
  result.checks += 1
  if (actual === expected) return true
  result.mismatches += 1
  if (!result.firstMismatch) {
    const mismatch = { label, expected: previewValue(expected), actual: previewValue(actual) }
    if (typeof actual === 'string' && typeof expected === 'string') {
      mismatch.firstDiffIndex = firstDiffIndex(actual, expected)
      mismatch.expectedUnits = expected.length
      mismatch.actualUnits = actual.length
    }
    result.firstMismatch = mismatch
  }
  return false
}

function checkTrue(result, label, condition, detail) {
  result.checks += 1
  if (condition) return true
  result.mismatches += 1
  if (!result.firstMismatch) result.firstMismatch = { label, detail: detail || null }
  return false
}

/**
 * 比较两端在一个时刻的完整可观察状态。
 * cursors 由当前 size/cursor 推导，覆盖：起点之前、起点、中间、末尾、游标之后。
 */
function compareBuffers(result, label, real, oracle, { cursors = null, full = true } = {}) {
  const realCursor = real.getWriteCursor()
  const oracleCursor = oracle.getWriteCursor()
  const realSize = real.size()
  const oracleSize = oracle.size()

  checkEqual(result, `${label}.cursor`, realCursor, oracleCursor)
  checkEqual(result, `${label}.size`, realSize, oracleSize)
  checkTrue(result, `${label}.size<=maxBytes`, realSize <= result.maxBytes, {
    size: realSize,
    maxBytes: result.maxBytes
  })

  const realRaw = real.getOutputSince(0, false).text
  const oracleRaw = oracle.getOutputSince(0, false).text
  checkEqual(result, `${label}.raw`, realRaw, oracleRaw)
  checkEqual(result, `${label}.rawUnits`, realRaw.length, realSize)

  if (!full) return

  for (const stripAnsi of [true, false]) {
    for (const count of DEFAULT_RECENT_COUNTS) {
      const realRecent = real.getRecentLines(count, stripAnsi)
      const oracleRecent = oracle.getRecentLines(count, stripAnsi)
      checkEqual(result, `${label}.recent(${count},${stripAnsi})`, realRecent.text, oracleRecent.text)
      checkEqual(result, `${label}.recentLines(${count},${stripAnsi})`, realRecent.lines, oracleRecent.lines)
    }
  }

  const base = realCursor - realSize
  const derived = cursors || [
    0,
    Math.max(0, base - 1),
    base,
    base + Math.floor(realSize / 2),
    Math.max(0, realCursor - 1),
    realCursor,
    realCursor + 1
  ]
  for (const stripAnsi of [true, false]) {
    for (const cursor of derived) {
      const realSince = real.getOutputSince(cursor, stripAnsi)
      const oracleSince = oracle.getOutputSince(cursor, stripAnsi)
      checkEqual(result, `${label}.since(${cursor},${stripAnsi}).text`, realSince.text, oracleSince.text)
      checkEqual(result, `${label}.since(${cursor},${stripAnsi}).cursor`, realSince.cursor, oracleSince.cursor)
      checkEqual(result, `${label}.since(${cursor},${stripAnsi}).truncated`, realSince.truncated, oracleSince.truncated)
    }
  }
}

function countLoneSurrogates(text) {
  let high = 0
  let low = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1
        continue
      }
      high += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      low += 1
    }
  }
  return { high, low }
}

/** 随机操作序列的逐码元对拍（同 seed 同序列，两端都从空缓冲开始） */
function runParityCase({ current, legacy, seed, kind, maxBytes, ops }) {
  const result = createCaseResult(`parity_${kind}_${maxBytes}`, { kind, maxBytes })
  const built = fixtures.buildChunks({ seed, kind, count: 12, targetUnits: Math.min(maxBytes, 4096) })
  const pool = built.chunks
  const rng = fixtures.createRng(fixtures.deriveSeed(seed, maxBytes ^ fixtures.deriveSeed(seed, 7)))
  const real = new current(maxBytes)
  const oracle = new legacy(maxBytes)
  let appended = 0

  for (let step = 0; step < ops; step += 1) {
    const roll = rng()
    if (roll < 0.05) {
      real.clear()
      oracle.clear()
      appended += 1
    } else if (roll < 0.1) {
      // 单块超过（或等于）上限：走“整段替换”路径
      const big = pool[fixtures.rngInt(rng, 0, pool.length - 1)]
      const chunk = big.length >= maxBytes ? big.slice(0, maxBytes) + 'Z' : big.repeat(Math.ceil((maxBytes + 8) / big.length)).slice(0, maxBytes + 8)
      real.append(chunk)
      oracle.append(chunk)
      appended += 1
    } else {
      const source = pool[fixtures.rngInt(rng, 0, pool.length - 1)]
      const cut = fixtures.rngInt(rng, 1, source.length)
      const chunk = rng() < 0.5 ? source.slice(0, cut) : source
      real.append(chunk)
      oracle.append(chunk)
      appended += 1
    }
    result.ops += 1
    compareBuffers(result, `step${step}`, real, oracle, { full: step % 4 === 0 })
    if (result.mismatches > 0) break
  }

  const raw = real.getOutputSince(0, false).text
  const lone = countLoneSurrogates(raw)
  result.loneSurrogate = lone
  if (kind === 'lone_surrogate' || kind === 'high_entropy') {
    checkTrue(result, `${result.name}.hasLoneSurrogate`, lone.high + lone.low > 0, lone)
  }
  result.notes.push(`appended=${appended}`)
  return result
}

/**
 * 用奇数上限 + 偶数纯代理对块长，强迫 trim 截断点落在代理对中间。
 * 算术：先写 1 个码元的 'A'，之后每块长度 L = 2n（偶数），上限 C 为奇数，
 * 则存活区起点 head = 1 + L*k - C 为偶数且 >= 2；块内偶数下标是低位代理项，
 * 所以存活区开头必然是一个孤立低位代理项（除非整块恰好被消耗，此时落入下一块
 * 的奇数下标，仍是低位）。这样该用例一定覆盖“截断拆开代理对”的形态。
 */
function runSurrogateSplitCase({ current, legacy, seed, maxBytes }) {
  const result = createCaseResult(`surrogate_split_trim_${maxBytes}`, { kind: 'emoji', maxBytes })
  const pair = ['😀', '🚀', '🎉'][seed % 3]
  const chunk = pair.repeat(Math.max(8, Math.floor(maxBytes / 4)))
  const real = new current(maxBytes)
  const oracle = new legacy(maxBytes)
  real.append('A')
  oracle.append('A')
  result.ops += 1
  let index = 0
  while (real.size() <= maxBytes && index < 4096) {
    real.append(chunk)
    oracle.append(chunk)
    index += 1
    result.ops += 1
    compareBuffers(result, `fill${index}`, real, oracle, { full: index % 8 === 0 })
    if (result.mismatches > 0) return result
  }
  for (let step = 0; step < 20 && result.mismatches === 0; step += 1) {
    real.append(chunk)
    oracle.append(chunk)
    result.ops += 1
    compareBuffers(result, `trim${step}`, real, oracle, { full: step % 5 === 0 })
  }
  const alone = countLoneSurrogates(real.getOutputSince(0, false).text)
  result.loneSurrogate = { high: alone.high, low: alone.low }
  result.notes.push('奇数上限 + 偶数纯代理对块长：存活区起点落在代理对中间')
  checkTrue(result, `${result.name}.sawSplitPair`, alone.high + alone.low > 0, alone)
  return result
}

/** 单次 append 超过上限：走 Buffer utf16le 复制路径，必须保留孤立代理项 */
function runBulkReplaceCase({ current, legacy, seed }) {
  const maxBytes = 1024
  const result = createCaseResult('bulk_replace_lone_surrogate', { kind: 'lone_surrogate', maxBytes })
  const built = fixtures.buildChunks({ seed, kind: 'lone_surrogate', count: 2, targetUnits: maxBytes * 3 })
  const big = built.chunks[0] + built.chunks[1]
  const real = new current(maxBytes)
  const oracle = new legacy(maxBytes)
  real.append(big)
  oracle.append(big)
  result.ops = 1
  compareBuffers(result, 'after_bulk', real, oracle)
  const lone = countLoneSurrogates(real.getOutputSince(0, false).text)
  result.loneSurrogate = { high: lone.high, low: lone.low }
  checkTrue(result, `${result.name}.hasLoneSurrogate`, lone.high + lone.low > 0, lone)
  checkEqual(result, `${result.name}.size`, real.size(), maxBytes)
  return result
}

/** clear 与游标边界：truncated 标志、游标越界、清空后再写入 */
function runClearAndCursorCase({ current, legacy, seed }) {
  const maxBytes = 4096
  const result = createCaseResult('clear_and_cursor_boundaries', { kind: 'lone_surrogate', maxBytes })
  const built = fixtures.buildChunks({ seed, kind: 'lone_surrogate', count: 6, targetUnits: 2048 })
  const real = new current(maxBytes)
  const oracle = new legacy(maxBytes)
  for (const chunk of built.chunks) {
    real.append(chunk)
    oracle.append(chunk)
    result.ops += 1
  }
  compareBuffers(result, 'filled', real, oracle)

  const cursor = real.getWriteCursor()
  const base = cursor - real.size()
  compareBuffers(result, 'cursor_matrix', real, oracle, {
    cursors: [-5, 0, Math.max(0, base - 1), base, base + 1, cursor - 1, cursor, cursor + 1, cursor + 1024]
  })

  real.clear()
  oracle.clear()
  result.ops += 1
  compareBuffers(result, 'after_clear', real, oracle)
  checkEqual(result, `${result.name}.clearCursor`, real.getWriteCursor(), 0)
  checkEqual(result, `${result.name}.clearSize`, real.size(), 0)

  const again = built.chunks[0]
  real.append(again)
  oracle.append(again)
  result.ops += 1
  compareBuffers(result, 'after_clear_append', real, oracle)
  return result
}

/** 大保留量（默认 1M 码元）下的对拍：只比 cursor/size/raw + 抽样 full */
function runLargeRetentionCase({ current, legacy, seed, kinds }) {
  const maxBytes = RETAIN_LIMIT_UNITS
  const result = createCaseResult(`large_retention_${maxBytes}`, { kind: kinds.join('+'), maxBytes })
  const corpus = fixtures.buildCorpus({ seed, count: 32, targetUnits: 8192, kinds })
  const real = new current(maxBytes)
  const oracle = new legacy(maxBytes)
  let i = 0
  while (real.size() < maxBytes && i < 512) {
    const chunk = corpus.chunks[i % corpus.chunks.length]
    real.append(chunk)
    oracle.append(chunk)
    i += 1
    result.ops += 1
    if (i % 32 === 0) {
      compareBuffers(result, `fill${i}`, real, oracle, { full: false })
      if (result.mismatches > 0) break
    }
  }
  if (result.mismatches === 0) {
    compareBuffers(result, 'steady', real, oracle, { full: true })
    // 稳态下再写 10 次，每次都触发 trim
    for (let step = 0; step < 10 && result.mismatches === 0; step += 1) {
      const chunk = corpus.chunks[step % corpus.chunks.length]
      real.append(chunk)
      oracle.append(chunk)
      result.ops += 1
      compareBuffers(result, `steady${step}`, real, oracle, { full: step % 5 === 0 })
    }
  }
  const lone = countLoneSurrogates(real.getOutputSince(0, false).text)
  result.loneSurrogate = lone
  return result
}

/**
 * 运行全部一致性用例。返回结构与写进 JSON 的 consistency 字段一致。
 */
function runConsistency({ current, legacy, seed, chunkUnits = fixtures.DEFAULT_CHUNK_UNITS }) {
  const cases = []
  for (const maxBytes of PARITY_CAPS) {
    for (const kind of ALL_KINDS) {
      cases.push(runParityCase({ current, legacy, seed, kind, maxBytes, ops: 120 }))
    }
  }
  cases.push(runSurrogateSplitCase({ current, legacy, seed, maxBytes: 101 }))
  cases.push(runSurrogateSplitCase({ current, legacy, seed, maxBytes: 4097 }))
  cases.push(runBulkReplaceCase({ current, legacy, seed }))
  cases.push(runClearAndCursorCase({ current, legacy, seed }))
  cases.push(runLargeRetentionCase({ current, legacy, seed, kinds: ['plain', 'emoji', 'lone_surrogate'] }))

  const totals = cases.reduce(
    (acc, item) => {
      acc.checks += item.checks
      acc.mismatches += item.mismatches
      acc.ops += item.ops
      return acc
    },
    { checks: 0, mismatches: 0, ops: 0 }
  )
  return {
    available: true,
    comparedAgainst: { ref: LEGACY_REF, sourcePath: LEGACY_SOURCE_PATH, chunkUnits },
    cases,
    totals,
    loneSurrogateChecked: cases.some((item) => item.loneSurrogate.high + item.loneSurrogate.low > 0)
  }
}

// ---------------------------------------------------------------------------
// 计时：append / recent / since / clear / trim
// ---------------------------------------------------------------------------

function timeCall(fn) {
  const startedAt = process.hrtime.bigint()
  const value = fn()
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
  return { ms, value }
}

function assertValidUnits(op, units) {
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new RangeError(`计时样本 ${op} 的 units 必须是非负安全整数，收到: ${units}`)
  }
}

function createTimingSink() {
  const ops = new Map()
  return {
    ops,
    record(op, ms, units, heldUnits) {
      assertValidUnits(op, units)
      let entry = ops.get(op)
      if (!entry) {
        entry = { timingsMs: [], units: [], heldUnits: [] }
        ops.set(op, entry)
      }
      entry.timingsMs.push(ms)
      entry.units.push(units)
      entry.heldUnits.push(heldUnits)
    }
  }
}

function fillBuffer(buffer, chunks, maxBytes, sink, startIndex) {
  let index = startIndex
  while (buffer.size() < maxBytes) {
    const chunk = chunks[index % chunks.length]
    index += 1
    const { ms } = timeCall(() => buffer.append(chunk))
    if (sink) sink.record('append_fill', ms, chunk.length, buffer.size())
  }
  return index
}

function buildReplacementChunk(corpus, maxBytes) {
  const joined = corpus.chunks.join('')
  let text = joined
  while (text.length < maxBytes + 4096) text += joined
  return text.slice(0, maxBytes + 4096)
}

/**
 * 一个缓冲实例数档位的计时场景。
 * 稳态下每次 append 都会触发一次 trim，因此 append_steady 同时就是 trim 场景；
 * recent / since 之前都先做一次 append，保证读到的是冷缓存（真实读路径）。
 */
function measureTimings({ current, corpus, buffers, maxBytes, iterations, warmup }) {
  const sink = createTimingSink()
  const instances = []
  let chunkIndex = 0
  let maxSizeObserved = 0

  for (let i = 0; i < buffers; i += 1) {
    const buffer = new current(maxBytes)
    chunkIndex = fillBuffer(buffer, corpus.chunks, maxBytes, sink, chunkIndex)
    instances.push(buffer)
  }
  for (const buffer of instances) maxSizeObserved = Math.max(maxSizeObserved, buffer.size())

  for (let i = 0; i < warmup; i += 1) {
    const buffer = instances[i % instances.length]
    const chunk = corpus.chunks[chunkIndex % corpus.chunks.length]
    chunkIndex += 1
    buffer.append(chunk)
    buffer.getRecentLines(50)
    buffer.getOutputSince(Math.max(0, buffer.getWriteCursor() - 8192), true)
  }

  const largeWindow = Math.min(SINCE_LARGE_WINDOW, Math.max(1, maxBytes))
  for (let i = 0; i < iterations; i += 1) {
    const buffer = instances[i % instances.length]
    const chunk = corpus.chunks[chunkIndex % corpus.chunks.length]
    chunkIndex += 1
    const held = buffer.size()
    const cursorBefore = buffer.getWriteCursor()

    const appendSample = timeCall(() => buffer.append(chunk))
    sink.record('append_steady', appendSample.ms, chunk.length, held)
    maxSizeObserved = Math.max(maxSizeObserved, buffer.size())

    const recentCold = timeCall(() => buffer.getRecentLines(50))
    sink.record('recent_cold', recentCold.ms, buffer.size(), buffer.size())
    const recentWarm = timeCall(() => buffer.getRecentLines(50))
    sink.record('recent_warm', recentWarm.ms, buffer.size(), buffer.size())

    // largeCursor 是绝对游标；读取长度必须用绝对写游标相减。
    // 旧的 buffer.size() - largeCursor 混用保留长度与绝对游标，trim 后会变成负数。
    const largeCursor = Math.max(0, buffer.getWriteCursor() - Math.min(largeWindow, buffer.size()))
    const sinceLarge = timeCall(() => buffer.getOutputSince(largeCursor, true))
    sink.record('since_large', sinceLarge.ms, buffer.getWriteCursor() - largeCursor, buffer.size())
    const sinceWarm = timeCall(() => buffer.getOutputSince(largeCursor, true))
    sink.record('since_warm', sinceWarm.ms, buffer.getWriteCursor() - largeCursor, buffer.size())

    const sinceRecent = timeCall(() => buffer.getOutputSince(cursorBefore, true))
    sink.record('since_recent', sinceRecent.ms, Math.max(0, buffer.getWriteCursor() - cursorBefore), buffer.size())

    if (i % 5 === 0) {
      const rawFull = timeCall(() => buffer.getOutputSince(0, false))
      sink.record('raw_full', rawFull.ms, buffer.size(), buffer.size())
    }
  }

  const replacementChunk = buildReplacementChunk(corpus, maxBytes)
  const replaceSamples = Math.min(iterations, 20)
  for (let i = 0; i < replaceSamples; i += 1) {
    const buffer = instances[i % instances.length]
    const { ms } = timeCall(() => buffer.append(replacementChunk))
    sink.record('append_replace', ms, replacementChunk.length, buffer.size())
    maxSizeObserved = Math.max(maxSizeObserved, buffer.size())
  }

  for (let i = 0; i < iterations; i += 1) {
    const buffer = instances[i % instances.length]
    const held = buffer.size()
    const { ms } = timeCall(() => buffer.clear())
    sink.record('clear', ms, held, held)
    // 重新填充到上限（不计时），让下一次 clear 仍面对满缓冲
    chunkIndex = fillBuffer(buffer, corpus.chunks, maxBytes, null, chunkIndex)
  }

  const timings = {}
  for (const [op, entry] of sink.ops) {
    timings[op] = {
      timingsMs: entry.timingsMs.map((value) => round(value, 6)),
      units: entry.units,
      heldUnits: entry.heldUnits,
      stats: summarizeTimes(entry.timingsMs),
      unitsMedian: medianValue(entry.units),
      heldUnitsMedian: medianValue(entry.heldUnits)
    }
  }
  return { timings, maxSizeObserved, heldCodeUnits: instances.reduce((sum, item) => sum + item.size(), 0) }
}

// ---------------------------------------------------------------------------
// 内存：append-only 与派生缓存填充的持有成本
// ---------------------------------------------------------------------------

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function sampleMemory({ rounds = 5 } = {}) {
  const samples = []
  for (let round = 0; round < rounds; round += 1) {
    if (typeof global.gc === 'function') {
      global.gc()
      await tick()
      global.gc()
      await tick()
    } else {
      await tick()
    }
    const usage = process.memoryUsage()
    const sample = {}
    for (const field of MEMORY_FIELDS) sample[field] = usage[field]
    samples.push(sample)
  }
  const summarized = {}
  for (const field of MEMORY_FIELDS) {
    const values = samples.map((sample) => sample[field])
    summarized[field] = {
      median: round(medianValue(values), 0),
      min: round(Math.min(...values), 0),
      max: round(Math.max(...values), 0)
    }
  }
  return {
    gc: typeof global.gc === 'function' ? 'forced:global.gc twice per round' : 'unavailable',
    rounds,
    samples,
    median: Object.fromEntries(MEMORY_FIELDS.map((field) => [field, summarized[field].median])),
    range: summarized
  }
}

function buildMemoryDeltas(snapshots) {
  const pairs = [
    ['before_buffers', 'raw_only'],
    ['raw_only', 'derived_filled'],
    ['raw_only', 'derived_dropped']
  ]
  const deltas = []
  for (const [from, to] of pairs) {
    for (const field of MEMORY_FIELDS) {
      deltas.push({
        from,
        to,
        field,
        bytes: round(snapshots[to].median[field] - snapshots[from].median[field], 0)
      })
    }
  }
  return deltas
}

/**
 * 对照三种持有状态：
 * - raw_only：只装原始分块（append-only）
 * - derived_filled：再把 joined / clean / recent / since 派生缓存全部填满
 * - derived_dropped：append 一个码元使缓存失效并 GC，验证派生缓存是可回收的临时持有
 */
async function measureMemory({ current, corpus, buffers, maxBytes, moduleId }) {
  const snapshots = {}
  snapshots.before_buffers = await sampleMemory()
  const instances = []
  for (let i = 0; i < buffers; i += 1) {
    const buffer = new current(maxBytes)
    fillBuffer(buffer, corpus.chunks, maxBytes, null, i * 7)
    instances.push(buffer)
  }
  snapshots.raw_only = await sampleMemory()

  for (const buffer of instances) {
    buffer.getRecentLines(50, true)
    buffer.getOutputSince(0, true)
    buffer.getOutputSince(0, false)
  }
  snapshots.derived_filled = await sampleMemory()

  for (const buffer of instances) buffer.append('x')
  snapshots.derived_dropped = await sampleMemory()

  const heldCodeUnits = instances.reduce((sum, item) => sum + item.size(), 0)
  const deltas = buildMemoryDeltas(snapshots)
  const pickDelta = (from, to, field) => {
    const found = deltas.find((item) => item.from === from && item.to === to && item.field === field)
    return found ? found.bytes : 0
  }
  return {
    buffers,
    maxBytes,
    moduleId,
    rounds: snapshots.before_buffers.rounds,
    heldCodeUnits,
    snapshots,
    deltas,
    derivedHoldBytes: pickDelta('raw_only', 'derived_filled', 'heapUsed'),
    derivedHoldBytesPerCodeUnit: heldCodeUnits ? round(pickDelta('raw_only', 'derived_filled', 'heapUsed') / heldCodeUnits, 6) : null,
    rawHoldBytes: pickDelta('before_buffers', 'raw_only', 'heapUsed'),
    derivedReleasedBytes: pickDelta('raw_only', 'derived_dropped', 'heapUsed')
  }
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

async function runChild(opts) {
  const { current, legacy } = loadImplementations(opts.bundle, opts.legacyBundle)
  const startedAt = Date.now()
  const consistency = runConsistency({ current, legacy, seed: opts.seed, chunkUnits: opts.chunkUnits })
  const corpus = fixtures.buildCorpus({
    seed: fixtures.deriveSeed(opts.seed, 1),
    count: 64,
    targetUnits: opts.chunkUnits
  })

  const scenarios = []
  for (const buffers of opts.buffers) {
    const timings = measureTimings({
      current,
      corpus,
      buffers,
      maxBytes: opts.maxBytes,
      iterations: opts.iterations,
      warmup: opts.warmup
    })
    const memory = await measureMemory({
      current,
      corpus,
      buffers,
      maxBytes: opts.maxBytes,
      moduleId: buffers
    })
    scenarios.push({
      buffers,
      maxBytes: opts.maxBytes,
      iterations: opts.iterations,
      maxSizeObserved: timings.maxSizeObserved,
      heldCodeUnits: timings.heldCodeUnits,
      timings: timings.timings,
      memory
    })
  }

  return {
    mode: 'child',
    rep: opts.rep,
    seed: opts.seed,
    pid: process.pid,
    node: process.version,
    gcAvailable: typeof global.gc === 'function',
    durationMs: Date.now() - startedAt,
    corpus: { summary: corpus.summary, perKindUnits: corpus.perKindUnits },
    consistency,
    scenarios
  }
}

function spawnChild(opts, bundles, rep) {
  if (opts.mode === 'child') throw new Error('基准子进程禁止再次创建子进程')
  const args = [
    '--expose-gc',
    __filename,
    '--child',
    `--bundle=${bundles.current.outfile}`,
    `--legacy-bundle=${bundles.legacy.outfile}`,
    `--seed=${opts.seed}`,
    `--buffers=${opts.buffers.join(',')}`,
    `--iterations=${opts.iterations}`,
    `--max-bytes=${opts.maxBytes}`,
    `--chunk-units=${opts.chunkUnits}`,
    `--warmup=${opts.warmup}`,
    `--rep=${rep}`
  ]
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let failure = null
    let settled = false

    const fail = (error) => {
      if (failure || settled) return
      failure = error
      // 只终止本脚本自己 spawn 的子进程；不触碰系统/共享进程。
      try {
        child.kill('SIGKILL')
      } catch (killError) {
        failure = new Error(`${error.message}（终止子进程失败: ${killError.message}）`)
      }
    }

    const timer = setTimeout(() => {
      fail(new Error(`子进程 rep=${rep} 超过单轮上限 ${CHILD_TIMEOUT_MS}ms，已终止`))
    }, CHILD_TIMEOUT_MS)

    child.stdout.on('data', (data) => {
      if (failure) return
      stdoutBytes += data.length
      if (stdoutBytes > MAX_CHILD_STDOUT_BYTES) {
        fail(new Error(`子进程 rep=${rep} stdout 超过 ${MAX_CHILD_STDOUT_BYTES} 字节上限（已收到 ${stdoutBytes}），已终止`))
        return
      }
      stdout.push(data)
    })
    child.stderr.on('data', (data) => {
      if (failure) return
      stderrBytes += data.length
      if (stderrBytes > MAX_CHILD_STDERR_BYTES) {
        fail(new Error(`子进程 rep=${rep} stderr 超过 ${MAX_CHILD_STDERR_BYTES} 字节上限（已收到 ${stderrBytes}），已终止`))
        return
      }
      stderr.push(data)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) {
        // 等 close 之后再拒绝：确保被终止的子进程已真正退出
        if (!settled) {
          settled = true
          reject(failure)
        }
        return
      }
      if (settled) return
      settled = true
      const out = Buffer.concat(stdout).toString('utf8').trim()
      const err = Buffer.concat(stderr).toString('utf8').trim()
      const durationMs = Date.now() - startedAt
      if (code !== 0) {
        reject(new Error(`子进程 rep=${rep} 退出码 ${code}: ${err.split('\n').slice(-8).join('\n')}`))
        return
      }
      let parsed
      try {
        parsed = JSON.parse(out)
      } catch (error) {
        reject(new Error(`子进程 rep=${rep} 输出不是 JSON: ${error.message}; head=${out.slice(0, 200)}`))
        return
      }
      const rawFile = path.join(RAW_DIR, `child-rep-${rep}.json`)
      fs.writeFileSync(rawFile, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
      resolve({
        rep,
        pid: child.pid,
        exitCode: code,
        durationMs,
        stderr,
        rawFile,
        rawBytes: fs.statSync(rawFile).size,
        digest: crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex').slice(0, 16),
        child: parsed
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

function aggregateOperations(runs, buffersList) {
  const operations = []
  for (const buffers of buffersList) {
    const perRepScenarios = runs.map((run) => {
      const scenario = run.child.scenarios.find((item) => item.buffers === buffers)
      return { rep: run.rep, scenario }
    })
    const opNames = new Set()
    for (const item of perRepScenarios) {
      if (!item.scenario) continue
      for (const name of Object.keys(item.scenario.timings)) opNames.add(name)
    }
    const ordered = [...opNames].sort((a, b) => {
      const ai = OP_ORDER.indexOf(a)
      const bi = OP_ORDER.indexOf(b)
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
    })
    for (const op of ordered) {
      const pooled = []
      const perRep = []
      for (const item of perRepScenarios) {
        const entry = item.scenario && item.scenario.timings[op]
        if (!entry) continue
        pooled.push(...entry.timingsMs)
        perRep.push({
          rep: item.rep,
          ...summarizeTimes(entry.timingsMs),
          unitsMedian: entry.unitsMedian,
          heldUnitsMedian: entry.heldUnitsMedian
        })
      }
      const held = perRepScenarios
        .map((item) => (item.scenario ? item.scenario.heldCodeUnits : null))
        .filter((value) => Number.isFinite(value))
      operations.push({
        buffers,
        operation: op,
        samples: pooled.length,
        stats: summarizeTimes(pooled),
        perRep,
        digest: digestNumbers(pooled),
        heldCodeUnitsMedian: held.length ? medianValue(held) : null
      })
    }
  }
  return operations
}

function aggregateMemory(runs, buffersList) {
  const states = ['before_buffers', 'raw_only', 'derived_filled', 'derived_dropped']
  const pairs = [
    ['before_buffers', 'raw_only'],
    ['raw_only', 'derived_filled'],
    ['raw_only', 'derived_dropped']
  ]
  const result = []
  for (const buffers of buffersList) {
    const perRep = runs.map((run) => ({
      rep: run.rep,
      memory: run.child.scenarios.find((item) => item.buffers === buffers).memory
    }))
    const stateSummary = {}
    for (const state of states) {
      const fields = {}
      for (const field of MEMORY_FIELDS) {
        const medians = perRep.map((item) => item.memory.snapshots[state].median[field])
        fields[field] = {
          median: round(medianValue(medians), 0),
          min: Math.min(...medians),
          max: Math.max(...medians),
          perRep: medians
        }
      }
      stateSummary[state] = fields
    }
    const deltas = []
    for (const [from, to] of pairs) {
      for (const field of MEMORY_FIELDS) {
        const values = perRep.map((item) => {
          const found = item.memory.deltas.find((delta) => delta.from === from && delta.to === to && delta.field === field)
          return found ? found.bytes : 0
        })
        deltas.push({
          from,
          to,
          field,
          bytesMedian: round(medianValue(values), 0),
          bytesPerRep: values
        })
      }
    }
    const heldCodeUnits = perRep[0].memory.heldCodeUnits
    const derivedBytes = deltas.find((item) => item.from === 'raw_only' && item.to === 'derived_filled' && item.field === 'heapUsed')
    result.push({
      buffers,
      maxBytes: perRep[0].memory.maxBytes,
      heldCodeUnits,
      gc: perRep[0].memory.snapshots.raw_only.gc,
      rounds: perRep[0].memory.rounds,
      states: stateSummary,
      deltas,
      derivedHoldBytesMedian: derivedBytes ? derivedBytes.bytesMedian : null,
      derivedHoldBytesPerCodeUnit: derivedBytes && heldCodeUnits ? round(derivedBytes.bytesMedian / heldCodeUnits, 6) : null,
      perRep: perRep.map((item) => ({
        rep: item.rep,
        rawOnlyHeapUsed: item.memory.snapshots.raw_only.median.heapUsed,
        derivedFilledHeapUsed: item.memory.snapshots.derived_filled.median.heapUsed,
        derivedDroppedHeapUsed: item.memory.snapshots.derived_dropped.median.heapUsed
      }))
    })
  }
  return result
}

/**
 * 结果边界检查：任何计时样本的 units 都不允许为负（含 NaN）。
 * since_* 的 units 是绝对写游标差（读取长度），不是保留长度。
 */
function collectNegativeUnits(runs) {
  const found = []
  for (const run of runs) {
    const scenarios = (run.child && run.child.scenarios) || []
    for (const scenario of scenarios) {
      const timings = scenario.timings || {}
      for (const [operation, entry] of Object.entries(timings)) {
        const units = Array.isArray(entry && entry.units) ? entry.units : []
        if (units.length === 0) continue
        const min = Math.min(...units)
        if (!(min >= 0)) found.push({ rep: run.rep, buffers: scenario.buffers, operation, min })
      }
    }
  }
  return found
}

function gitInfo() {
  const run = (args) => {
    const result = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : null
  }
  const dirty = run(['status', '--porcelain'])
  return {
    head: run(['rev-parse', 'HEAD']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyCount: dirty ? dirty.split('\n').filter(Boolean).length : 0,
    dirtySample: dirty ? dirty.split('\n').filter(Boolean).slice(0, 12) : []
  }
}

function assembleResult({ opts, bundles, runs }) {
  const operations = aggregateOperations(runs, opts.buffers)
  const memory = aggregateMemory(runs, opts.buffers)
  const consistencyCases = []
  for (const run of runs) {
    for (const item of run.child.consistency.cases) {
      const existing = consistencyCases.find(
        (candidate) => candidate.name === item.name && candidate.maxBytes === item.maxBytes
      )
      if (existing) {
        existing.checks += item.checks
        existing.mismatches += item.mismatches
        existing.ops += item.ops
        existing.reps.push(run.rep)
      } else {
        consistencyCases.push({
          name: item.name,
          kind: item.kind,
          maxBytes: item.maxBytes,
          ops: item.ops,
          checks: item.checks,
          mismatches: item.mismatches,
          firstMismatch: item.firstMismatch,
          loneSurrogate: item.loneSurrogate,
          notes: item.notes,
          reps: [run.rep]
        })
      }
    }
  }
  const consistencyTotals = consistencyCases.reduce(
    (acc, item) => {
      acc.checks += item.checks
      acc.mismatches += item.mismatches
      acc.ops += item.ops
      return acc
    },
    { checks: 0, mismatches: 0, ops: 0 }
  )

  const acceptanceChecks = []
  for (const operation of operations) {
    if (!REQUIRED_OPERATIONS.includes(operation.operation)) continue
    acceptanceChecks.push({
      name: `samples>=${REQUIRED_SAMPLES}:${operation.operation}@${operation.buffers}`,
      pass: operation.samples >= REQUIRED_SAMPLES,
      detail: { samples: operation.samples }
    })
  }
  acceptanceChecks.push({
    name: `independentSubprocesses>=${MIN_REPEAT}`,
    pass: runs.length >= MIN_REPEAT,
    detail: { runs: runs.length, pids: runs.map((run) => run.pid) }
  })
  acceptanceChecks.push({
    name: 'forcedGCInEverySubprocess',
    pass: runs.every((run) => run.child.gcAvailable === true),
    detail: { gc: runs.map((run) => run.child.gcAvailable) }
  })
  acceptanceChecks.push({
    name: 'retentionNeverExceedsMaxBytes',
    pass: runs.every((run) => run.child.scenarios.every((scenario) => scenario.maxSizeObserved <= scenario.maxBytes)),
    detail: { maxBytes: opts.maxBytes }
  })
  const negativeUnits = collectNegativeUnits(runs)
  acceptanceChecks.push({
    name: 'unitsNeverNegative',
    pass: negativeUnits.length === 0,
    detail: { negativeUnits }
  })
  acceptanceChecks.push({
    name: 'codeUnitParityWithLegacy',
    pass: consistencyTotals.mismatches === 0,
    detail: { checks: consistencyTotals.checks, mismatches: consistencyTotals.mismatches }
  })
  const failed = acceptanceChecks.filter((item) => !item.pass)

  return {
    schemaVersion: 1,
    kind: 'lyshell-shelf-memory-p0-history-benchmark',
    generatedAt: new Date().toISOString(),
    worktree: ROOT,
    git: gitInfo(),
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpuModel: (os.cpus()[0] || {}).model || null,
      cpuCount: os.cpus().length,
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem()
    },
    inputs: {
      seed: opts.seed,
      buffers: opts.buffers,
      buffersMeaning: '同一 1M 码元上限的并发 OutputBuffer 实例数（方案 3.2 的 1/10/30 会话档位）',
      iterations: opts.iterations,
      repeat: opts.repeat,
      warmup: opts.warmup,
      chunkUnits: opts.chunkUnits,
      maxBytes: opts.maxBytes,
      maxBytesDefault: RETAIN_LIMIT_UNITS,
      retentionLimitEnforced: true,
      retentionLimitNote: 'CLI 拒绝大于默认 1M 码元的上限，不扩大保留范围'
    },
    bundles,
    fixtures: {
      manifest: fixtures.fixtureManifest({ seed: opts.seed, chunkUnits: opts.chunkUnits, chunksPerKind: 8 }),
      corpus: runs.map((run) => ({ rep: run.rep, ...run.child.corpus }))
    },
    method: {
      timing: 'process.hrtime.bigint() 包住单次调用并换算成 ms；recent/since 采样前都先 append 一块，确保测的是冷缓存读路径',
      percentiles: '线性插值（R7，index=(n-1)*p）；p50/p95 由全部子进程的样本合并后计算',
      sampling: '每个 (档位, 操作) 至少 100 个样本；内存快照 5 轮取中位数，同时给出 min/max，不把轮询当绝对峰值',
      memoryInstrumentation:
        '子进程以 --expose-gc 启动，每次快照前连续 global.gc() 两次并用 setImmediate 让出，再读 process.memoryUsage() 的全部字段（rss/heapTotal/heapUsed/external/arrayBuffers）',
      memoryScopeLimit:
        'memoryUsage 只描述该子进程的 JS 运行时；heapUsed 差值只代表该进程内持有量变化，不是 Electron 全应用内存，也不能当作应用总收益',
      trim: '稳态下每次 append 都会回收等量码元，append_steady 即 trim 场景；append_replace 覆盖单块超过上限的替换路径',
      retentionLimit: '输出不扩大保留上限：所有用例 maxBytes 不超过 1M 码元，并逐次断言 size <= maxBytes',
      independence: '父进程打包一次，每个 rep 在独立 node 进程（--expose-gc）重新加载相同实现与相同 seeded 语料，进程间不共享堆或缓存',
      units: 'units 是该次调用实际读取的码元数；since_* 用绝对写游标差计算，结果必须非负，负值直接判定验收失败',
      childLimits: `每个子进程 stdout 上限 ${MAX_CHILD_STDOUT_BYTES} 字节、stderr 上限 ${MAX_CHILD_STDERR_BYTES} 字节、单轮上限 ${CHILD_TIMEOUT_MS}ms；超限/超时只终止本次 spawn 的子进程并等待 close`
    },
    consistency: {
      available: consistencyTotals.checks > 0,
      comparedAgainst: { ref: LEGACY_REF, sourcePath: LEGACY_SOURCE_PATH },
      totals: consistencyTotals,
      cases: consistencyCases,
      loneSurrogateChecked: consistencyCases.some((item) => item.loneSurrogate.high + item.loneSurrogate.low > 0)
    },
    runs: runs.map((run) => ({
      rep: run.rep,
      pid: run.pid,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      node: run.child.node,
      gcAvailable: run.child.gcAvailable,
      rawFile: path.relative(ROOT, run.rawFile).split(path.sep).join('/'),
      rawBytes: run.rawBytes,
      digest: run.digest
    })),
    operations,
    memory,
    acceptance: {
      pass: failed.length === 0,
      checks: acceptanceChecks,
      failed: failed.map((item) => item.name)
    },
    limitations: [
      '只测 Node 独立进程中的真实 OutputBuffer，不含 Electron 主进程、renderer、xterm、PTY、GPU 或其他资源',
      'heapUsed 差值仅表示该子进程 JS 堆内持有量变化，不能当作应用总内存收益；V8 可能保留空闲容量（heapTotal 变化更迟钝）',
      '固定 seeded 合成日志，不代表某个真实客户端的输出分布；未做真实会话回放',
      '1/10/30 指同 1M 码元上限的并发缓冲实例数，不是三档不同保留上限',
      '未接入压缩 / Rust / 生产链路，未测 GC 暂停对端到端交互延迟的影响',
      '循环内是预热后的密集操作，生产中的稀疏 append 会得到不同的分布',
      `对照实现取自 git ${LEGACY_REF} 的单字符串版本，语义基准是“相同可观察行为”，不是性能对比`
    ]
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function formatMiB(bytes) {
  return `${round(bytes / (1024 * 1024), 2)} MiB`
}

function printSummary(result) {
  const lines = []
  lines.push(
    `P0 history benchmark: ${result.runs.length} 个独立子进程, buffers=${result.inputs.buffers.join('/')}, ` +
      `seed=${result.inputs.seed}, maxBytes=${result.inputs.maxBytes} 码元`
  )
  lines.push(
    `一致性: ${result.consistency.totals.checks} 次逐码元检查, ${result.consistency.totals.mismatches} 处不一致` +
      `（对照 ${result.consistency.comparedAgainst.ref}）`
  )
  for (const buffers of result.inputs.buffers) {
    const picks = result.operations.filter(
      (item) => item.buffers === buffers && ['append_steady', 'recent_cold', 'since_large', 'clear'].includes(item.operation)
    )
    for (const item of picks) {
      const stats = item.stats
      lines.push(
        `  buffers=${buffers} ${item.operation.padEnd(13)} n=${stats.samples} ` +
          `p50=${stats.p50Ms}ms p95=${stats.p95Ms}ms range=[${stats.minMs}, ${stats.maxMs}]ms`
      )
    }
    const memory = result.memory.find((item) => item.buffers === buffers)
    lines.push(
      `  buffers=${buffers} 持有: raw_only=${formatMiB(memory.states.raw_only.heapUsed.median)} heapUsed, ` +
        `派生缓存填充 +${formatMiB(memory.derivedHoldBytesMedian)}（本进程 heapUsed 差值）`
    )
  }
  lines.push(`验收: ${result.acceptance.pass ? 'pass' : 'FAIL ' + result.acceptance.failed.join(', ')}`)
  process.stdout.write(lines.join('\n') + '\n')
  if (result.acceptance.pass === false) process.exitCode = 1
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }

  // 子进程模式：只加载已打包的实现、跑场景并把 JSON 写到 stdout（由父进程解析）。
  // 不重新 buildBundles，避免多个子进程并发写同一打包文件。
  if (opts.mode === 'child') {
    const result = await runChild(opts)
    process.stdout.write(JSON.stringify(result) + '\n')
    return 0
  }

  const bundles = buildBundles()

  if (opts.verifyOnly) {
    const { current, legacy } = loadImplementations(bundles.current.outfile, bundles.legacy.outfile)
    const consistency = runConsistency({ current, legacy, seed: opts.seed, chunkUnits: opts.chunkUnits })
    process.stdout.write(
      JSON.stringify({
        mode: 'verify-only',
        seed: opts.seed,
        bundles,
        consistency: {
          totals: consistency.totals,
          loneSurrogateChecked: consistency.loneSurrogateChecked,
          cases: consistency.cases.map((item) => ({
            name: item.name,
            kind: item.kind,
            maxBytes: item.maxBytes,
            ops: item.ops,
            checks: item.checks,
            mismatches: item.mismatches,
            loneSurrogate: item.loneSurrogate,
            firstMismatch: item.firstMismatch
          }))
        }
      }) + '\n'
    )
    if (consistency.totals.mismatches > 0) process.exitCode = 1
    return 0
  }

  const runs = []
  for (let rep = 1; rep <= opts.repeat; rep += 1) {
    const run = await spawnChild(opts, bundles, rep)
    runs.push(run)
    process.stderr.write(
      `[history-benchmark] rep=${rep}/${opts.repeat} pid=${run.pid} ${run.durationMs}ms ` +
        `一致性=${run.child.consistency.totals.mismatches === 0 ? 'ok' : 'mismatch'}\n`
    )
  }

  const result = assembleResult({ opts, bundles, runs })
  if (opts.writeOut) writeJson(opts.out, result)
  printSummary(result)
  if (!result.acceptance.pass) process.exitCode = 1
  return 0
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`参数错误: ${error.message}\n\n`)
      printHelp()
      process.exitCode = 2
      return
    }
    process.stderr.write(`基准失败: ${error && error.stack ? error.stack : error}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  ROOT,
  TMP_DIR,
  DOCS_DIR,
  DEFAULT_OUT,
  RETAIN_LIMIT_UNITS,
  ALLOWED_BUFFER_COUNTS,
  LEGACY_REF,
  REQUIRED_OPERATIONS,
  REQUIRED_SAMPLES,
  MAX_CHILD_STDOUT_BYTES,
  MAX_CHILD_STDERR_BYTES,
  CHILD_TIMEOUT_MS,
  UsageError,
  parseArgs,
  resolveOutPath,
  summarizeTimes,
  percentile,
  medianValue,
  createTimingSink,
  collectNegativeUnits,
  buildBundles,
  loadImplementations,
  runConsistency,
  runParityCase,
  runSurrogateSplitCase,
  runBulkReplaceCase,
  runClearAndCursorCase,
  runLargeRetentionCase,
  compareBuffers,
  countLoneSurrogates,
  aggregateOperations,
  aggregateMemory,
  assembleResult,
  main
}
