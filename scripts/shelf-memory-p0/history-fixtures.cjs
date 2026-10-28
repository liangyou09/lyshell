'use strict'

/**
 * P0 固定日志 fixture（seed 决定一切，无外部依赖、无 IO、不 import 生产源码）
 *
 * 目标：给 history-benchmark.cjs 和测试提供可重复的输入语料，覆盖方案 3.2 要求的
 * 普通文本、ANSI 密集、中文、emoji、孤立代理项、高熵六类日志。
 *
 * 约定：
 * - 所有生成只依赖 seed 与参数；同一 seed 在任何进程/平台上产出同一份码元序列。
 * - 长度一律按 UTF-16 码元（code unit）计量，emoji 与孤立代理项都按码元记录；
 *   不按 UTF-8 字节或 Unicode 码点计量。
 * - 校验和按码元序列计算（utf16le），不用 utf8，避免孤立代理项被替换成 U+FFFD
 *   而丢失差异。
 */

const crypto = require('crypto')

const DEFAULT_CHUNK_UNITS = 4096
const DEFAULT_CHUNKS_PER_KIND = 8

/** 六类固定语料；`astral`/`loneSurrogate` 描述该类别“应当出现”的特征，供测试断言 */
const KIND_SPECS = Object.freeze([
  {
    kind: 'plain',
    description: '普通 ASCII 日志行（时间戳/级别/模块/键值）',
    astral: false,
    loneSurrogate: false,
    splitRisk: '低'
  },
  {
    kind: 'ansi',
    description: 'ANSI 密集：CSI 颜色与光标、OSC 标题与超链接、DCS、单字符 ESC、\\r 进度重绘',
    astral: false,
    loneSurrogate: false,
    splitRisk: '转义序列可能被码元截断'
  },
  {
    kind: 'cjk',
    description: '中文（BMP）日志行，含全角标点',
    astral: false,
    loneSurrogate: false,
    splitRisk: '低'
  },
  {
    kind: 'emoji',
    description: 'emoji、ZWJ 序列与变体选择符（增补平面，代理对完整）',
    astral: true,
    loneSurrogate: false,
    splitRisk: '码元截断会拆开代理对'
  },
  {
    kind: 'lone_surrogate',
    description: '含孤立高位/低位代理项的文本（写入器、编码器可能破坏，用于逐码元校验）',
    astral: true,
    loneSurrogate: true,
    splitRisk: '本身即含孤立代理项'
  },
  {
    kind: 'high_entropy',
    description: '高熵随机码元（BMP 广域 + 代理半区 + 可打印控制符）',
    astral: true,
    loneSurrogate: true,
    splitRisk: '随机码元可能落在代理半区'
  }
])

const FIXTURE_KINDS = Object.freeze(KIND_SPECS.map((spec) => spec.kind))

const PLAIN_WORDS = [
  'session',
  'connect',
  'handshake',
  'pty',
  'channel',
  'socket',
  'retry',
  'timeout',
  'upload',
  'download',
  'auth',
  'resize',
  'flush',
  'buffer'
]

const ANSI_WORDS = [
  'status',
  'color',
  'clear',
  'home',
  'cursor',
  'title',
  'link',
  'dcs',
  'erase',
  'progress',
  'redraw',
  'attr'
]

const CJK_WORDS = [
  '终端',
  '会话',
  '连接',
  '输出',
  '缓冲',
  '重连',
  '握手',
  '超时',
  '上传',
  '下载',
  '脚本',
  '插件',
  '任务',
  '内存',
  '测量',
  '远端'
]

const EMOJI_TOKENS = [
  '😀',
  '🚀',
  '🎉',
  '🔥',
  '✅',
  '🧑‍🚀',
  '👨‍👩‍👧‍👦',
  '🏳️‍🌈',
  '❤️',
  '👍🏽',
  '🀄',
  '⭐',
  '🇨🇳',
  '🖥️',
  '🛰️',
  '🧪'
]

/** mulberry32：32 位状态，纯函数式推进，跨平台一致 */
function createRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 由主 seed 派生互不相关的子 seed */
function deriveSeed(seed, salt) {
  let h = (seed >>> 0) ^ Math.imul((salt >>> 0) + 0x9e3779b9, 2654435761)
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

function rngInt(rng, min, max) {
  if (max < min) throw new RangeError(`rngInt: max(${max}) < min(${min})`)
  return min + Math.floor(rng() * (max - min + 1))
}

function pick(rng, list) {
  if (!Array.isArray(list) || list.length === 0) throw new TypeError('pick: empty list')
  return list[Math.floor(rng() * list.length) % list.length]
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

function genPlain(rng, targetUnits) {
  const parts = []
  let len = 0
  while (len < targetUnits) {
    const line =
      `[2026-10-28T${pad(rngInt(rng, 0, 23))}:${pad(rngInt(rng, 0, 59))}:${pad(rngInt(rng, 0, 59))}.` +
      `${pad(rngInt(rng, 0, 999), 3)}Z] ${pick(rng, ['INFO ', 'WARN ', 'DEBUG', 'ERROR', 'TRACE'])} ` +
      `${pick(rng, PLAIN_WORDS)}-${rngInt(rng, 1, 99)}: ${pick(rng, PLAIN_WORDS)} ` +
      `${pick(rng, PLAIN_WORDS)}=${rngInt(rng, 0, 65535)} ok\n`
    parts.push(line)
    len += line.length
  }
  return parts.join('').slice(0, targetUnits)
}

function genAnsi(rng, targetUnits) {
  const parts = []
  let len = 0
  while (len < targetUnits) {
    let piece
    switch (rngInt(rng, 0, 9)) {
      case 0:
        piece = `\x1b[${rngInt(rng, 30, 37)}m${pick(rng, ANSI_WORDS)}\x1b[0m`
        break
      case 1:
        piece =
          `\x1b[${rngInt(rng, 1, 4)};${rngInt(rng, 30, 37)}m${pick(rng, ANSI_WORDS)}` +
          `\x1b[${rngInt(rng, 0, 1)}m`
        break
      case 2:
        piece = `\x1b[${rngInt(rng, 1, 40)};${rngInt(rng, 1, 120)}H`
        break
      case 3:
        piece = `\x1b[${pick(rng, ['2J', 'K', '?25l', '?25h', 'H', '1;1H', 's', 'u', '6n'])}`
        break
      case 4:
        piece = `\x1b]0;LyShell ${rngInt(rng, 1, 999)}\x07`
        break
      case 5:
        piece =
          `\x1b]8;;https://example.invalid/${rngInt(rng, 1, 999)}\x1b\\${pick(rng, ANSI_WORDS)}` +
          `\x1b]8;;\x1b\\`
        break
      case 6:
        piece = `\x1b${pick(rng, ['(B', '=', '>', 'D', 'M', 'E', '7', '8'])}`
        break
      case 7:
        piece = `\x1bP${rngInt(rng, 0, 9)};${rngInt(rng, 0, 9)}|${pick(rng, ANSI_WORDS)}\x1b\\`
        break
      case 8:
        piece = `\r${pick(rng, ANSI_WORDS)} ${rngInt(rng, 0, 100)}%`
        break
      default:
        piece = `${pick(rng, ANSI_WORDS)} ${rngInt(rng, 0, 999)}\n`
        break
    }
    parts.push(piece)
    len += piece.length
  }
  return parts.join('').slice(0, targetUnits)
}

function genCjk(rng, targetUnits) {
  const parts = []
  let len = 0
  while (len < targetUnits) {
    const line =
      `[会话 ${pad(rngInt(rng, 1, 99))}] ${pick(rng, CJK_WORDS)}${pick(rng, CJK_WORDS)}：` +
      `${pick(rng, CJK_WORDS)}＝${rngInt(rng, 0, 65535)}，${pick(rng, CJK_WORDS)}。\n`
    parts.push(line)
    len += line.length
  }
  return parts.join('').slice(0, targetUnits)
}

function genEmoji(rng, targetUnits) {
  const parts = []
  let len = 0
  while (len < targetUnits) {
    // 按 token 边界拼装，保证本类别只含完整的代理对
    const token = pick(rng, EMOJI_TOKENS)
    const sep = rng() < 0.25 ? '\n' : ' '
    parts.push(token + sep)
    len += token.length + sep.length
  }
  return parts.join('')
}

function genLoneSurrogate(rng, targetUnits) {
  const parts = []
  let len = 0
  let loneHigh = 0
  let loneLow = 0
  while (len < targetUnits) {
    const mode = rngInt(rng, 0, 9)
    let token
    if (mode <= 2) {
      token = String.fromCharCode(0xd800 + rngInt(rng, 0, 0x3ff))
      loneHigh += 1
    } else if (mode <= 4) {
      token = String.fromCharCode(0xdc00 + rngInt(rng, 0, 0x3ff))
      loneLow += 1
    } else if (mode === 5) {
      token = String.fromCharCode(0xd800 + rngInt(rng, 0, 0x3ff), 0xdc00 + rngInt(rng, 0, 0x3ff))
    } else if (mode === 6) {
      token = '\n'
    } else if (mode === 7) {
      token = '中'
    } else {
      token = pick(rng, ['a', 'b', 'ok', 'tmux', '\t'])
    }
    parts.push(token)
    len += token.length
  }
  // 兜底：确保两类孤立代理项都出现过（否则该 fixture 没有覆盖到目标形态）
  if (loneHigh === 0) parts.push(String.fromCharCode(0xd83d))
  if (loneLow === 0) parts.push(String.fromCharCode(0xdc00))
  return parts.join('')
}

function genHighEntropy(rng, targetUnits) {
  const chars = []
  for (let i = 0; i < targetUnits; i += 1) {
    const bucket = rngInt(rng, 0, 99)
    let unit
    if (bucket < 62) unit = rngInt(rng, 0x20, 0x7e)
    else if (bucket < 78) unit = rngInt(rng, 0xa0, 0x2fff)
    else if (bucket < 88) unit = rngInt(rng, 0x3000, 0xd7ff)
    else if (bucket < 94) unit = rngInt(rng, 0xd800, 0xdfff)
    else if (bucket < 99) unit = rngInt(rng, 0xe000, 0xfffd)
    else unit = rngInt(rng, 0x08, 0x1f) // 保留控制符（含 \b \t 之外的 C0）
    chars.push(String.fromCharCode(unit))
  }
  return chars.join('')
}

const GENERATORS = Object.freeze({
  plain: genPlain,
  ansi: genAnsi,
  cjk: genCjk,
  emoji: genEmoji,
  lone_surrogate: genLoneSurrogate,
  high_entropy: genHighEntropy
})

/**
 * 生成单块语料。
 * @param {string} kind KIND_SPECS 中的 kind
 * @param {number} seed 32 位无符号 seed
 * @param {number} targetUnits 目标码元数（实际长度按类别略有偏差，以返回值为准）
 */
function buildChunk(kind, seed, targetUnits = DEFAULT_CHUNK_UNITS) {
  const generator = GENERATORS[kind]
  if (!generator) throw new RangeError(`未知 fixture 类别: ${kind}`)
  if (!Number.isInteger(targetUnits) || targetUnits <= 0) {
    throw new RangeError(`targetUnits 必须是正整数: ${targetUnits}`)
  }
  return generator(createRng(seed >>> 0), targetUnits)
}

/** 统计文本的码元特征（供 fixture 断言与报告使用） */
function analyzeText(text) {
  let astral = 0
  let loneHigh = 0
  let loneLow = 0
  let ansiEscapes = 0
  let newlines = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 0x1b) ansiEscapes += 1
    if (code === 0x0a) newlines += 1
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        astral += 1
        i += 1
        continue
      }
      loneHigh += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      loneLow += 1
    }
  }
  return { units: text.length, astral, loneHigh, loneLow, ansiEscapes, newlines }
}

/** 按码元序列计算校验和（utf16le 保留孤立代理项，utf8 会替换成 U+FFFD） */
function checksumUnits(text) {
  const hash = crypto.createHash('sha256')
  const window = 8192
  for (let offset = 0; offset < text.length; offset += window) {
    const end = Math.min(offset + window, text.length)
    const buf = Buffer.allocUnsafe((end - offset) * 2)
    for (let i = offset; i < end; i += 1) {
      buf.writeUInt16LE(text.charCodeAt(i), (i - offset) * 2)
    }
    hash.update(buf)
  }
  return hash.digest('hex')
}

function summarizeChunks(chunks) {
  const joined = chunks.join('')
  const perChunk = chunks.map((chunk) => chunk.length)
  const totals = analyzeText(joined)
  return {
    chunks: chunks.length,
    totalUnits: joined.length,
    minChunkUnits: perChunk.length ? Math.min(...perChunk) : 0,
    maxChunkUnits: perChunk.length ? Math.max(...perChunk) : 0,
    meanChunkUnits: perChunk.length ? joined.length / perChunk.length : 0,
    totals,
    checksum: checksumUnits(joined)
  }
}

/** 生成某一类别的固定块序列（同一 seed 完全可复现） */
function buildChunks({ seed, kind, count = DEFAULT_CHUNKS_PER_KIND, targetUnits = DEFAULT_CHUNK_UNITS }) {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError(`count 必须是正整数: ${count}`)
  if (!GENERATORS[kind]) throw new RangeError(`未知 fixture 类别: ${kind}`)
  const rng = createRng(deriveSeed(seed, stringSalt(kind)))
  const chunks = []
  for (let i = 0; i < count; i += 1) {
    const generator = GENERATORS[kind]
    chunks.push(generator(rng, targetUnits))
  }
  return { kind, seed: seed >>> 0, targetUnits, chunks, summary: summarizeChunks(chunks) }
}

/** 混合语料：每种类别至少出现一次，其余按 seed 抽取，模拟真实多会话日志 */
function buildCorpus({
  seed,
  count = 64,
  targetUnits = DEFAULT_CHUNK_UNITS,
  kinds = FIXTURE_KINDS
}) {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError(`count 必须是正整数: ${count}`)
  if (!Array.isArray(kinds) || kinds.length === 0) throw new RangeError('kinds 不能为空')
  for (const kind of kinds) {
    if (!GENERATORS[kind]) throw new RangeError(`未知 fixture 类别: ${kind}`)
  }
  const rng = createRng(deriveSeed(seed, 0xc0a5e))
  const kindRng = createRng(deriveSeed(seed, 0x5eed))
  const chunks = []
  const usedKinds = []
  for (let i = 0; i < count; i += 1) {
    const kind = i < kinds.length ? kinds[i] : pick(kindRng, kinds)
    usedKinds.push(kind)
    chunks.push(GENERATORS[kind](rng, targetUnits))
  }
  return {
    seed: seed >>> 0,
    targetUnits,
    kinds: usedKinds,
    chunks,
    summary: summarizeChunks(chunks),
    perKindUnits: countKindUnits(usedKinds, chunks)
  }
}

function countKindUnits(usedKinds, chunks) {
  const map = {}
  for (let i = 0; i < chunks.length; i += 1) {
    const kind = usedKinds[i]
    map[kind] = (map[kind] || 0) + chunks[i].length
  }
  return map
}

function stringSalt(value) {
  let h = 2166136261
  for (let i = 0; i < String(value).length; i += 1) {
    h ^= String(value).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 固定 fixture 清单：写进结果 JSON，说明这次到底用了什么输入。
 */
function fixtureManifest({
  seed,
  chunkUnits = DEFAULT_CHUNK_UNITS,
  chunksPerKind = DEFAULT_CHUNKS_PER_KIND
}) {
  const kinds = KIND_SPECS.map((spec) => {
    const built = buildChunks({ seed, kind: spec.kind, count: chunksPerKind, targetUnits: chunkUnits })
    return {
      kind: spec.kind,
      description: spec.description,
      astral: spec.astral,
      loneSurrogate: spec.loneSurrogate,
      splitRisk: spec.splitRisk,
      ...built.summary
    }
  })
  return { seed: seed >>> 0, chunkUnits, chunksPerKind, kinds }
}

module.exports = {
  DEFAULT_CHUNK_UNITS,
  DEFAULT_CHUNKS_PER_KIND,
  FIXTURE_KINDS,
  KIND_SPECS,
  createRng,
  deriveSeed,
  rngInt,
  pick,
  buildChunk,
  buildChunks,
  buildCorpus,
  analyzeText,
  checksumUnits,
  summarizeChunks,
  fixtureManifest
}
