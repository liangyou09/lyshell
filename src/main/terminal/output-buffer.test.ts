import { describe, expect, it, vi } from 'vitest'
import { OutputBuffer } from './output-buffer'
import { stripAnsiToText } from './ansi-stripper'

/**
 * stripAnsiToText 调用计数：用来证明“未变更时重复读取命中缓存”。
 * 包装实现仍返回真实清洗结果，其余用例语义不受影响。
 */
const stripCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('./ansi-stripper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ansi-stripper')>()
  return {
    ...actual,
    stripAnsiToText: (input: string) => {
      stripCalls.count += 1
      return actual.stripAnsiToText(input)
    }
  }
})

/** 旧实现（逐行等价复制自优化前的 output-buffer.ts），用于逐码元对拍 */
class ReferenceBuffer {
  buffer = ''
  baseOffset = 0
  writeCursor = 0
  lastDataTime = 0
  maxBytes: number

  constructor(maxBytes = 1024 * 1024) {
    this.maxBytes = maxBytes
  }

  append(data: string): void {
    if (!data) return
    this.buffer += data
    this.writeCursor += data.length
    this.lastDataTime = Date.now()

    if (this.buffer.length > this.maxBytes) {
      const drop = this.buffer.length - this.maxBytes
      this.buffer = this.buffer.slice(drop)
      this.baseOffset += drop
    }
  }

  getWriteCursor(): number {
    return this.writeCursor
  }

  getLastDataTime(): number {
    return this.lastDataTime
  }

  getRecentLines(count: number, stripAnsi: boolean = true): { text: string; lines: number } {
    const source = stripAnsi ? stripAnsiToText(this.buffer) : this.buffer
    const allLines = source.split('\n')
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop()
    }
    const start = Math.max(0, allLines.length - count)
    const lines = allLines.slice(start)
    return { text: lines.join('\n'), lines: lines.length }
  }

  getOutputSince(cursor: number, stripAnsi: boolean = true): { text: string; cursor: number; truncated: boolean } {
    let start: number
    let truncated = false

    if (cursor < this.baseOffset) {
      start = 0
      truncated = true
    } else {
      start = cursor - this.baseOffset
      if (start < 0) start = 0
      if (start > this.buffer.length) start = this.buffer.length
    }

    const raw = this.buffer.slice(start)
    const text = stripAnsi ? stripAnsiToText(raw) : raw
    return { text, cursor: this.writeCursor, truncated }
  }

  clear(): void {
    this.buffer = ''
    this.baseOffset = 0
    this.writeCursor = 0
  }

  size(): number {
    return this.buffer.length
  }
}

/** 可复现的伪随机数（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 覆盖 ANSI/OSC/DCS、控制流、宽字符、代理对、NUL 等形态
const FRAGMENTS = [
  'a',
  'Z',
  '0',
  ' ',
  '\n',
  '\r\n',
  '\r',
  '\b',
  '\t',
  '\x00',
  '中',
  '😀',
  '\x1b[31m',
  '\x1b[0m',
  '\x1b[1;2',
  'H',
  '\x1b]0;ti',
  'tle\x07',
  '\x1b(B',
  '\x1bP1;2q',
  'progress 10%\rprogress 90%',
  'ascii-segment'
]

/** 随机拼一段数据，随机截断（可切开转义序列或代理对） */
function randomData(rnd: () => number): string {
  const pieces = Math.floor(rnd() * 5)
  let out = ''
  for (let i = 0; i < pieces; i += 1) {
    const frag = FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)]
    const repeat = rnd() < 0.1 ? 1 + Math.floor(rnd() * 40) : 1
    const cut = Math.floor(rnd() * (frag.length + 1))
    out += frag.slice(0, cut).repeat(repeat)
  }
  return out
}

/** 随机游标：覆盖已回收、正好在回收点、末尾、越界、负数、NaN、Infinity */
function pickCursor(rnd: () => number, ref: ReferenceBuffer): number {
  const options = [
    0,
    1,
    ref.baseOffset - 1,
    ref.baseOffset,
    ref.baseOffset + 1,
    ref.writeCursor,
    ref.writeCursor - 1,
    ref.writeCursor + 5,
    -3,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Math.floor(rnd() * (ref.writeCursor + 2)),
    Math.floor(rnd() * 8)
  ]
  return options[Math.floor(rnd() * options.length)]
}

describe('OutputBuffer — 追加与回收', () => {
  it('单块超过上限时只保留末尾 maxBytes 个码元并推进回收偏移', () => {
    const buf = new OutputBuffer(8)
    buf.append('abcdefghij') // 10 >= 8：结果必然只剩末尾 8 个码元

    expect(buf.size()).toBe(8)
    expect(buf.getWriteCursor()).toBe(10)
    expect(buf.getRecentLines(1, false).text).toBe('cdefghij')
    expect(buf.getOutputSince(0, false)).toEqual({ text: 'cdefghij', cursor: 10, truncated: true })
    expect(buf.getOutputSince(2, false)).toEqual({ text: 'cdefghij', cursor: 10, truncated: false })

    // 再追加尚未超限的数据后，回收点落在第一块内部，只切片一次
    buf.append('KLM') // 8 + 3 - 8 = 3 个码元被回收
    expect(buf.size()).toBe(8)
    expect(buf.getWriteCursor()).toBe(13)
    expect(buf.getOutputSince(0, false).text).toBe('fghijKLM')
    expect(buf.getOutputSince(4, false)).toEqual({ text: 'fghijKLM', cursor: 13, truncated: true })
    expect(buf.getOutputSince(5, false)).toEqual({ text: 'fghijKLM', cursor: 13, truncated: false })
  })

  it('多次小块写入后按块回收（整块丢弃路径）', () => {
    const buf = new OutputBuffer(6)
    buf.append('ab')
    buf.append('cd')
    buf.append('ef')
    expect(buf.size()).toBe(6)

    buf.append('gh') // 8 > 6，丢弃 'ab' 整块
    expect(buf.size()).toBe(6)
    expect(buf.getOutputSince(0, false).text).toBe('cdefgh')
    expect(buf.getOutputSince(2, false)).toEqual({ text: 'cdefgh', cursor: 8, truncated: false })
    expect(buf.getOutputSince(1, false)).toEqual({ text: 'cdefgh', cursor: 8, truncated: true })
  })

  it('超大块覆盖已有历史（先拼接后裁剪的等价结果）', () => {
    const buf = new OutputBuffer(10)
    buf.append('abc')
    buf.append('0123456789ABCDEF') // 16 个码元全部替换，保留末尾 10 个
    expect(buf.size()).toBe(10)
    expect(buf.getWriteCursor()).toBe(19)
    expect(buf.getOutputSince(9, false).text).toBe('6789ABCDEF')
    expect(buf.getOutputSince(8, false).truncated).toBe(true)

    buf.append('xyz') // 回到普通路径：13 > 10，回收 3 个码元
    expect(buf.size()).toBe(10)
    expect(buf.getOutputSince(12, false).text).toBe('9ABCDEFxyz')
    expect(buf.getRecentLines(1, false).text).toBe('9ABCDEFxyz')
  })

  it('长期写入后保留内容有界，且与旧实现完全一致', () => {
    const buf = new OutputBuffer(256)
    const ref = new ReferenceBuffer(256)
    for (let i = 0; i < 5000; i += 1) {
      const data = `line-${i.toString(36)}\n`
      buf.append(data)
      ref.append(data)
    }
    expect(buf.size()).toBeLessThanOrEqual(256)
    expect(buf.size()).toBe(ref.size())
    expect(buf.getWriteCursor()).toBe(ref.getWriteCursor())
    expect(buf.getRecentLines(1000, false).text).toBe(ref.getRecentLines(1000, false).text)
    expect(buf.getOutputSince(0, false).text).toBe(ref.getOutputSince(0, false).text)
  })

  it('回收与块合并且队首带偏移时内容仍与旧实现一致', () => {
    const buf = new OutputBuffer(5000)
    const ref = new ReferenceBuffer(5000)
    for (let i = 0; i < 9000; i += 1) {
      const data = i % 13 === 0 ? 'yz' : String.fromCharCode(97 + (i % 26))
      buf.append(data)
      ref.append(data)
    }
    expect(buf.size()).toBeLessThanOrEqual(5000)
    expect(buf.size()).toBe(ref.size())
    expect(buf.getOutputSince(0, false).text).toBe(ref.getOutputSince(0, false).text)
    expect(buf.getOutputSince(100, true).text).toBe(ref.getOutputSince(100, true).text)
    expect(buf.getRecentLines(5, true)).toEqual(ref.getRecentLines(5, true))

    // 白盒约束：活块数受控，且字符串总保留量不超过 2 倍上限（多出的是队首块未裁剪的前缀）
    const internals = buf as unknown as { chunks: string[]; head: number }
    expect(internals.chunks.length - internals.head).toBeLessThanOrEqual(8192)
    const retained = internals.chunks.slice(internals.head).reduce((sum, chunk) => sum + chunk.length, 0)
    expect(retained).toBeLessThanOrEqual(5000 * 2)
  })

  it('超小分块累积到数千块时自动合并，内容与旧实现一致', () => {
    const buf = new OutputBuffer(65536)
    const ref = new ReferenceBuffer(65536)
    for (let i = 0; i < 6000; i += 1) {
      const data = i % 7 === 0 ? 'x' : String.fromCharCode(97 + (i % 26))
      buf.append(data)
      ref.append(data)
    }
    // 6000 个单码元块超过合并阈值，合并后必须保持顺序与内容
    expect(buf.size()).toBe(6000)
    expect(buf.size()).toBe(ref.size())
    expect(buf.getOutputSince(0, false).text).toBe(ref.getOutputSince(0, false).text)
    expect(buf.getOutputSince(1234, false).text).toBe(ref.getOutputSince(1234, false).text)
    expect(buf.getRecentLines(3, false)).toEqual(ref.getRecentLines(3, false))
  })
})

describe('OutputBuffer — 码元/代理对游标语义', () => {
  it('游标与 size 按 UTF-16 码元计数（不是字节）', () => {
    const buf = new OutputBuffer()
    buf.append('中') // UTF-8 3 字节，UTF-16 1 码元
    expect(buf.size()).toBe(1)
    expect(buf.getWriteCursor()).toBe(1)

    buf.append('😀') // 增补平面字符占 2 个码元
    expect(buf.size()).toBe(3)
    expect(buf.getWriteCursor()).toBe(3)
    expect(buf.getOutputSince(1, false).text).toBe('😀')
    expect(buf.getRecentLines(1, false).text).toBe('中😀')
  })

  it('允许游标落在代理对中间，返回孤立代理项（与旧实现一致）', () => {
    const buf = new OutputBuffer(64)
    buf.append('a😀b') // 索引：0 a，1 高代理，2 低代理，3 b

    expect(buf.getWriteCursor()).toBe(4)
    expect(buf.getOutputSince(0, false).text).toBe('a😀b')
    expect(buf.getOutputSince(1, false).text).toBe('😀b')
    expect(buf.getOutputSince(2, false).text).toBe('\uDE00b')
    expect(buf.getOutputSince(3, false).text).toBe('b')
    expect(buf.getOutputSince(2, true).text).toBe('\uDE00b')
  })

  it('回收按码元切分，可能留下孤立低代理项（旧行为，已固化）', () => {
    const buf = new OutputBuffer(3)
    buf.append('a😀b') // 4 >= 3：保留末尾 3 个码元 '😀b'（恰好保留完整代理对）
    expect(buf.getOutputSince(0, false).text).toBe('😀b')

    buf.append('c') // 4 > 3：回收 1 个码元，切在代理对中间
    expect(buf.size()).toBe(3)
    expect(buf.getOutputSince(0, false).text).toBe('\uDE00bc')
    expect(buf.getRecentLines(1, false).text).toBe('\uDE00bc')
  })

  it('代理对跨两次 append 被拼回完整字符', () => {
    const buf = new OutputBuffer(1024)
    buf.append('\ud83d') // 高代理
    buf.append('\ude00 done') // 低代理 + 文本
    expect(buf.getOutputSince(0, false).text).toBe('😀 done')
    expect(buf.getRecentLines(1, true).text).toBe('😀 done')
    expect(buf.getOutputSince(1, false).text).toBe('\ude00 done')
  })
})

describe('OutputBuffer — raw/clean 跨追加边界', () => {
  it('CSI 序列被 append 边界切成两半时仍被清洗', () => {
    const buf = new OutputBuffer(1024)
    buf.append('ab\x1b[3')
    buf.append('1mcd')

    expect(buf.getRecentLines(1, false).text).toBe('ab\x1b[31mcd')
    expect(buf.getRecentLines(1, true).text).toBe('abcd')
    expect(buf.getOutputSince(0, true).text).toBe('abcd')
    expect(buf.getOutputSince(2, true).text).toBe('cd') // 从 ESC 起算，序列完整
  })

  it('OSC/DCS 序列跨边界时仍被清洗', () => {
    const buf = new OutputBuffer(1024)
    buf.append('x\x1b]0;ti')
    buf.append('tle\x07y')
    expect(buf.getRecentLines(1, true).text).toBe('xy')

    const dcs = new OutputBuffer(1024)
    dcs.append('p\x1bP1;2q')
    dcs.append('payload\x1b\\q')
    expect(dcs.getRecentLines(1, true).text).toBe('pq')
  })

  it('\\r 跨边界按整行覆盖；\\b 被当作控制字符删除后再按行处理', () => {
    const buf = new OutputBuffer(1024)
    buf.append('progress 10%')
    buf.append('\rprogress 90%')
    expect(buf.getRecentLines(1, true).text).toBe('progress 90%')

    // stripAnsiCodes 会先删掉 \b（旧实现同样如此），因此退格不会回退字符
    const backspace = new OutputBuffer(1024)
    backspace.append('abc')
    backspace.append('\b')
    backspace.append('\bX')
    expect(backspace.getRecentLines(1, true).text).toBe('abcX')
  })

  it('游标落在转义序列中间时，只对剩余片段做清洗（旧语义）', () => {
    const buf = new OutputBuffer(1024)
    buf.append('x\x1b[31mred') // 索引：0 x，1 ESC，2 '['，3 '3'，4 '1'，5 'm'
    expect(buf.getOutputSince(3, false).text).toBe('31mred')
    expect(buf.getOutputSince(3, true).text).toBe(stripAnsiToText('31mred'))
  })

  it('多行读取跨块拼接，末尾换行不产生空行计数', () => {
    const buf = new OutputBuffer(1024)
    buf.append('l1\nl2')
    buf.append('\nl3\n')
    expect(buf.getRecentLines(2, true)).toEqual({ text: 'l2\nl3', lines: 2 })
    expect(buf.getRecentLines(0, false)).toEqual({ text: '', lines: 0 })
  })
})

describe('OutputBuffer — 陈旧/越界游标', () => {
  it('已被回收的游标返回 truncated，并从最早可用内容开始', () => {
    const buf = new OutputBuffer(4)
    buf.append('abcdef') // 6 >= 4：保留 'cdef'，baseOffset 2
    expect(buf.getOutputSince(1, false)).toEqual({ text: 'cdef', cursor: 6, truncated: true })
    expect(buf.getOutputSince(0, false)).toEqual({ text: 'cdef', cursor: 6, truncated: true })
    expect(buf.getOutputSince(-5, false)).toEqual({ text: 'cdef', cursor: 6, truncated: true })
  })

  it('游标正好等于回收点或末尾时不标记 truncated', () => {
    const buf = new OutputBuffer(4)
    buf.append('abcdef')
    expect(buf.getOutputSince(2, false)).toEqual({ text: 'cdef', cursor: 6, truncated: false })
    expect(buf.getOutputSince(6, false)).toEqual({ text: '', cursor: 6, truncated: false })
    expect(buf.getOutputSince(99, false)).toEqual({ text: '', cursor: 6, truncated: false })
    expect(buf.getOutputSince(Number.POSITIVE_INFINITY, false).text).toBe('')
  })

  it('NaN 游标等价于从 0 开始（旧实现 slice(NaN) 行为）', () => {
    const buf = new OutputBuffer(4)
    buf.append('abcdef')
    expect(buf.getOutputSince(Number.NaN, false).text).toBe('cdef')
    expect(buf.getOutputSince(Number.NaN, true).text).toBe('cdef')
  })

  it('clear 后旧游标返回空文本且不标记 truncated（baseOffset 归零）', () => {
    const buf = new OutputBuffer(16)
    buf.append('abcdef')
    const cursor = buf.getWriteCursor()
    buf.clear()
    expect(buf.getOutputSince(cursor, false)).toEqual({ text: '', cursor: 0, truncated: false })
  })
})

describe('OutputBuffer — 空追加与 clear', () => {
  it('空追加不推进游标、不更新时间戳、不使缓存失效', () => {
    const buf = new OutputBuffer(16)
    buf.append('abc')
    const cursor = buf.getWriteCursor()
    const time = buf.getLastDataTime()

    stripCalls.count = 0
    expect(buf.getRecentLines(1, true).text).toBe('abc')
    const afterFirstRead = stripCalls.count
    expect(afterFirstRead).toBe(1)

    buf.append('')
    buf.append('')

    expect(buf.getWriteCursor()).toBe(cursor)
    expect(buf.getLastDataTime()).toBe(time)
    expect(buf.size()).toBe(3)
    expect(buf.getRecentLines(1, true).text).toBe('abc')
    expect(stripCalls.count).toBe(afterFirstRead)
  })

  it('clear 重置游标/内容并让缓存失效', () => {
    const buf = new OutputBuffer(64)
    buf.append('hello\nworld')
    expect(buf.getRecentLines(2).text).toBe('hello\nworld')
    expect(buf.getOutputSince(0, true).text).toBe('hello\nworld')

    buf.clear()
    expect(buf.size()).toBe(0)
    expect(buf.getWriteCursor()).toBe(0)
    expect(buf.getRecentLines(5)).toEqual({ text: '', lines: 0 })
    expect(buf.getRecentLines(5, false)).toEqual({ text: '', lines: 0 })
    expect(buf.getOutputSince(0, false)).toEqual({ text: '', cursor: 0, truncated: false })

    // clear 后必须重新清洗新内容，不能返回清空前的缓存
    buf.append('new')
    expect(buf.getRecentLines(5, true).text).toBe('new')
    expect(buf.getOutputSince(0, true).text).toBe('new')
  })
})

describe('OutputBuffer — 重复读取与写入后失效', () => {
  it('内容未变更时重复读取不重复清洗', () => {
    const buf = new OutputBuffer(1024)
    buf.append('\x1b[31mred\x1b[0m\n')

    stripCalls.count = 0
    const first = buf.getRecentLines(1, true)
    expect(first.text).toBe('red')
    expect(stripCalls.count).toBe(1)

    // 同一 (count, stripAnsi) 命中 recentCache
    expect(buf.getRecentLines(1, true)).toEqual(first)
    expect(stripCalls.count).toBe(1)

    // raw 读取不触发清洗
    expect(buf.getRecentLines(1, false).text).toBe('\x1b[31mred\x1b[0m')
    expect(stripCalls.count).toBe(1)

    // 起点为 0 的 getOutputSince 复用整段清洗缓存（与 getRecentLines 共享）
    expect(buf.getOutputSince(0, true).text).toBe('red')
    expect(stripCalls.count).toBe(1)
    expect(buf.getOutputSince(0, true).text).toBe('red')
    expect(stripCalls.count).toBe(1)

    // 写入后缓存失效，重新清洗并反映新内容
    buf.append('\x1b[32mgreen\x1b[0m\n')
    expect(buf.getRecentLines(1, true).text).toBe('green')
    expect(stripCalls.count).toBe(2)
    expect(buf.getOutputSince(0, true).text).toBe('red\ngreen')
    expect(stripCalls.count).toBe(2)
  })

  it('send_and_wait 轮询模式（同一游标先 raw 再 clean）只清洗一次', () => {
    const buf = new OutputBuffer(1024)
    buf.append('boot\n')
    const cursor = buf.getWriteCursor()
    buf.append('\x1b[32mready\x1b[0m\n')

    stripCalls.count = 0
    for (let poll = 0; poll < 5; poll += 1) {
      expect(buf.getOutputSince(cursor, false).text).toBe('\x1b[32mready\x1b[0m\n')
      expect(buf.getOutputSince(cursor, true).text).toBe('ready')
    }
    // 首轮切片 + 清洗各一次，之后 raw 切片与清洗结果都命中缓存
    expect(stripCalls.count).toBe(1)
  })

  it('写入后读取反映新增内容（缓存不返回旧结果）', () => {
    const buf = new OutputBuffer(1024)
    buf.append('one\n')
    expect(buf.getRecentLines(5, true).text).toBe('one')
    expect(buf.getRecentLines(5, true).text).toBe('one') // 命中缓存
    expect(buf.getOutputSince(0, true).text).toBe('one')

    buf.append('two\n')
    expect(buf.getRecentLines(5, true).text).toBe('one\ntwo')
    expect(buf.getOutputSince(0, true).text).toBe('one\ntwo')
    expect(buf.getOutputSince(buf.getWriteCursor(), true).text).toBe('')

    const cursor = buf.getWriteCursor()
    buf.append('three\n')
    expect(buf.getOutputSince(cursor, true).text).toBe('three')
  })
})

describe('OutputBuffer — 与旧实现随机对拍', () => {
  it('随机 append/回收/读取/清空序列逐码元一致', () => {
    const configs = [1, 2, 3, 5, 8, 13, 64, 257, 1024]
    for (const maxBytes of configs) {
      const rnd = mulberry32(0x9e3779b9 ^ maxBytes)
      const actual = new OutputBuffer(maxBytes)
      const reference = new ReferenceBuffer(maxBytes)

      for (let step = 0; step < 400; step += 1) {
        const op = rnd()
        if (op < 0.62) {
          const data = randomData(rnd)
          actual.append(data)
          reference.append(data)
        } else if (op < 0.68) {
          actual.append('')
          reference.append('')
        } else if (op < 0.84) {
          const count = Math.floor(rnd() * 9)
          const stripAnsi = rnd() < 0.5
          expect(actual.getRecentLines(count, stripAnsi)).toEqual(reference.getRecentLines(count, stripAnsi))
        } else if (op < 0.97) {
          const cursor = pickCursor(rnd, reference)
          const stripAnsi = rnd() < 0.5
          expect(actual.getOutputSince(cursor, stripAnsi)).toEqual(reference.getOutputSince(cursor, stripAnsi))
        } else {
          actual.clear()
          reference.clear()
        }

        expect(actual.getWriteCursor()).toBe(reference.getWriteCursor())
        expect(actual.size()).toBe(reference.size())
      }
    }
  })

  it('较大上限 + 较大分块下同样逐码元一致', () => {
    for (const maxBytes of [4096, 65536, 65539]) {
      const rnd = mulberry32(0x51ed270b ^ maxBytes)
      const actual = new OutputBuffer(maxBytes)
      const reference = new ReferenceBuffer(maxBytes)

      for (let step = 0; step < 300; step += 1) {
        const op = rnd()
        if (op < 0.7) {
          const data = randomData(rnd)
          actual.append(data)
          reference.append(data)
        } else if (op < 0.9) {
          const count = 1 + Math.floor(rnd() * 20)
          const stripAnsi = rnd() < 0.5
          expect(actual.getRecentLines(count, stripAnsi)).toEqual(reference.getRecentLines(count, stripAnsi))
        } else {
          const cursor = pickCursor(rnd, reference)
          const stripAnsi = rnd() < 0.5
          expect(actual.getOutputSince(cursor, stripAnsi)).toEqual(reference.getOutputSince(cursor, stripAnsi))
        }
        expect(actual.size()).toBe(reference.size())
      }
    }
  })
})
