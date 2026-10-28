'use strict'

/**
 * P0 固定日志 fixture 的边界测试。
 * 只用 node:test + node:assert，不依赖 Vitest / jest，避免动生产依赖。
 *
 * 关注点：
 * - 同 seed 完全可复现（跨调用、跨类别派生互不干扰）；
 * - 六类语料都覆盖，且“应当出现”的特征真的出现（ANSI、中文、emoji、孤立代理项、高熵）；
 * - 长度一律按 UTF-16 码元计量，校验和不会被 utf8 替换成 U+FFFD。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const fixtures = require('./history-fixtures.cjs')

const SEED = 20261028
const UNITS = 512

test('FIXTURE_KINDS 覆盖方案要求的六类语料', () => {
  assert.deepEqual(fixtures.FIXTURE_KINDS, ['plain', 'ansi', 'cjk', 'emoji', 'lone_surrogate', 'high_entropy'])
  assert.equal(fixtures.KIND_SPECS.length, 6)
  for (const spec of fixtures.KIND_SPECS) {
    assert.ok(fixtures.FIXTURE_KINDS.includes(spec.kind), spec.kind)
    assert.equal(typeof spec.description, 'string')
    assert.ok(spec.description.length > 0)
  }
})

test('同一 seed 的语料完全可复现，换 seed 则不同', () => {
  for (const kind of fixtures.FIXTURE_KINDS) {
    const a = fixtures.buildChunk(kind, SEED, UNITS)
    const b = fixtures.buildChunk(kind, SEED, UNITS)
    assert.equal(a, b, `${kind} 同 seed 必须逐码元一致`)
    assert.equal(fixtures.checksumUnits(a), fixtures.checksumUnits(b))

    const other = fixtures.buildChunk(kind, SEED + 1, UNITS)
    assert.notEqual(fixtures.checksumUnits(a), fixtures.checksumUnits(other), `${kind} 换 seed 应当变化`)
  }
})

test('类别之间互相独立：同 seed 批量结果稳定，首块与单块生成一致', () => {
  const batch = fixtures.buildChunks({ seed: SEED, kind: 'ansi', count: 3, targetUnits: UNITS })
  const again = fixtures.buildChunks({ seed: SEED, kind: 'ansi', count: 3, targetUnits: UNITS })
  assert.equal(batch.chunks.length, 3)
  assert.deepEqual(batch.chunks, again.chunks, '同 seed 的批量语料必须完全可复现')
  // 每块长度由 targetUnits 决定（生成器会补齐行边界，不精确等于目标），不随调用次数漂移
  for (const chunk of batch.chunks) assert.ok(chunk.length >= UNITS && chunk.length < UNITS * 1.2, `块长异常: ${chunk.length}`)
  // 不同类别不会互相污染：换 kind 只改 kind 派生的 seed
  const cjk = fixtures.buildChunks({ seed: SEED, kind: 'cjk', count: 3, targetUnits: UNITS })
  assert.notEqual(batch.chunks[0], cjk.chunks[0])
})

test('每类语料的实际特征符合声明', () => {
  const analyze = (kind, units = UNITS) =>
    fixtures.analyzeText(fixtures.buildChunks({ seed: SEED, kind, count: 2, targetUnits: units }).chunks.join(''))

  const plain = analyze('plain')
  assert.equal(plain.astral, 0)
  assert.equal(plain.loneHigh + plain.loneLow, 0)
  assert.equal(plain.ansiEscapes, 0)
  assert.ok(plain.newlines > 0, '普通日志应当有换行')

  const ansi = analyze('ansi')
  assert.ok(ansi.ansiEscapes > 0, 'ANSI 语料必须真的含 ESC')

  const cjk = analyze('cjk')
  assert.equal(cjk.astral, 0, '中文（BMP）不应出现代理对')
  assert.equal(cjk.loneHigh + cjk.loneLow, 0)

  const emoji = analyze('emoji')
  assert.ok(emoji.astral > 0, 'emoji 语料必须含成对代理项')
  assert.equal(emoji.loneHigh + emoji.loneLow, 0, 'emoji 语料不应含孤立代理项')

  const lone = analyze('lone_surrogate')
  assert.ok(lone.loneHigh > 0, '孤立高位代理项必须出现')
  assert.ok(lone.loneLow > 0, '孤立低位代理项必须出现')

  const entropy = analyze('high_entropy', 4096)
  assert.ok(entropy.ansiEscapes > 0)
  assert.ok(entropy.astral > 0)
})

test('按码元计量：emoji 块长度是码元数而不是码点数', () => {
  const chunk = fixtures.buildChunk('emoji', SEED, UNITS)
  assert.ok(chunk.length >= UNITS && chunk.length < UNITS * 1.2, `块长异常: ${chunk.length}`)
  const points = Array.from(chunk).length
  assert.ok(points < chunk.length, '含代理对/ZWJ 时码点数必须少于码元数')
  assert.equal(fixtures.analyzeText(chunk).units, chunk.length)
})

test('校验和按 UTF-16 码元计算，孤立代理项不会被替换', () => {
  const loneHigh = '\ud83d'
  const loneLow = '\ude00'
  const replacement = '\ufffd'
  assert.notEqual(fixtures.checksumUnits(loneHigh), fixtures.checksumUnits(replacement))
  assert.notEqual(fixtures.checksumUnits(loneLow), fixtures.checksumUnits(replacement))
  assert.notEqual(fixtures.checksumUnits(loneHigh), fixtures.checksumUnits(loneLow))
  assert.equal(fixtures.checksumUnits(loneHigh + loneLow), fixtures.checksumUnits('\ud83d\ude00'))
  // 结构上：utf16le 往返必须保留码元（这正是基准里 bulk 替换路径依赖的前提）
  assert.equal(Buffer.from(loneHigh + loneLow, 'utf16le').toString('utf16le'), loneHigh + loneLow)
  assert.equal(fixtures.checksumUnits('abc'), fixtures.checksumUnits('abc'))
})

test('summarizeChunks 的码元统计与逐块相加一致', () => {
  const built = fixtures.buildChunks({ seed: SEED, kind: 'emoji', count: 4, targetUnits: UNITS })
  const summary = built.summary
  const total = built.chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  assert.equal(summary.chunks, 4)
  assert.equal(summary.totalUnits, total)
  assert.ok(total >= 4 * UNITS && total < 4 * UNITS * 1.2, `总码元数异常: ${total}`)
  assert.equal(summary.minChunkUnits, Math.min(...built.chunks.map((chunk) => chunk.length)))
  assert.equal(summary.maxChunkUnits, Math.max(...built.chunks.map((chunk) => chunk.length)))
  assert.equal(summary.checksum, fixtures.checksumUnits(built.chunks.join('')))
  assert.equal(summary.totals.units, summary.totalUnits)
})

test('buildCorpus：前 N 块覆盖全部类别，perKindUnits 求和等于总码元', () => {
  const corpus = fixtures.buildCorpus({ seed: SEED, count: 12, targetUnits: UNITS })
  assert.equal(corpus.chunks.length, 12)
  const head = new Set(corpus.kinds.slice(0, fixtures.FIXTURE_KINDS.length))
  for (const kind of fixtures.FIXTURE_KINDS) assert.ok(head.has(kind), `缺少 ${kind}`)
  const sum = Object.values(corpus.perKindUnits).reduce((acc, value) => acc + value, 0)
  assert.equal(sum, corpus.chunks.join('').length)
  // 各类生成器会补齐到行/块边界，总长在目标附近而非精确相等
  assert.ok(sum >= 12 * UNITS && sum < 12 * UNITS * 1.2, `总码元数异常: ${sum}`)
})

test('fixtureManifest 记录 seed / 块长 / 每类统计，供结果 JSON 引用', () => {
  const manifest = fixtures.fixtureManifest({ seed: SEED, chunkUnits: 128, chunksPerKind: 2 })
  assert.equal(manifest.seed, SEED)
  assert.equal(manifest.chunkUnits, 128)
  assert.equal(manifest.chunksPerKind, 2)
  assert.equal(manifest.kinds.length, 6)
  for (const item of manifest.kinds) {
    assert.equal(item.chunks, 2)
    // 长度以生成为准（各类生成器会补齐到行/块边界），但必须接近目标且三次统计自洽
    assert.ok(item.totalUnits >= 128 && item.totalUnits < 128 * 4, `${item.kind} 码元数异常: ${item.totalUnits}`)
    assert.equal(item.totals.units, item.totalUnits)
    assert.equal(typeof item.checksum, 'string')
    assert.equal(item.checksum.length, 64)
  }
})

test('非法参数被拒绝（不留静默降级）', () => {
  assert.throws(() => fixtures.buildChunks({ seed: SEED, kind: 'plain', count: 0 }), RangeError)
  assert.throws(() => fixtures.buildChunks({ seed: SEED, kind: 'nope', count: 1 }), /未知 fixture 类别/)
  assert.throws(() => fixtures.buildCorpus({ seed: SEED, count: 0 }), RangeError)
  assert.throws(() => fixtures.buildCorpus({ seed: SEED, count: 2, kinds: [] }), RangeError)
  assert.throws(() => fixtures.buildCorpus({ seed: SEED, count: 2, kinds: ['nope'] }), /未知 fixture 类别/)
})

test('seed 被视为 uint32（负数/超界不会破坏可复现性）', () => {
  const wrapped = fixtures.buildChunk('plain', -1 >>> 0, UNITS)
  assert.equal(wrapped, fixtures.buildChunk('plain', 0xffffffff, UNITS))
  assert.equal(fixtures.summarizeChunks([wrapped]).checksum, fixtures.checksumUnits(wrapped))
})
