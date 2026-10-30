/**
 * 终端输出缓冲区
 * 捕获会话的 terminal:data 事件，提供最近输出读取与增量输出读取能力
 * 原始数据（含 ANSI）原样存储，读取时按需清洗
 *
 * 存储模型：分块队列（chunked queue）
 * 旧实现把整段历史放在一个字符串里，缓冲满后每次 append 都要 slice 复制整段
 * 历史（默认 1M 码元），32MiB / 4KiB 分块的累计 CPU 达秒级。这里改为按 append
 * 分块入队：
 * - 回收时优先只移动队首块内的偏移量（摊销 O(1)），只有整块消费完才出队，
 *   队首块被消费过半时才切片释放前缀，既不用每次 append 复制整段历史，也不会
 *   长期保留已丢弃内容；
 * - 单块 append 超过上限时，直接以末尾 maxBytes 码元替换全部历史；
 * - 活块数超过阈值时就地两两合并，避免超小 append 导致块数量无限膨胀。
 *
 * 语义约定（与旧实现逐码元保持一致）：
 * - 游标（writeCursor）、baseOffset、size()、maxBytes 全部以 UTF-16 码元
 *   （code unit）为单位，不是字节；emoji 等增补平面字符占 2 个码元。
 * - 回收按码元切分，截断点可能落在代理对中间，留下孤立代理项 —— 这是旧实现
 *   就有的行为，读取结果与旧实现完全一致。
 * - 跨块拼接后才做 ANSI 清洗与按行切分，因此转义序列/控制流跨 append 边界时
 *   语义不变。
 * - 读取结果按 generation 缓存，任何写入/回收/清空都会使缓存失效。
 */

import {
  TERMINAL_OUTPUT_HARD_MAX_RESPONSE_CHARS,
  TERMINAL_OUTPUT_MAX_RESPONSE_CHARS,
  type TerminalOutputReadFailure,
  type TerminalOutputReadRequest,
  type TerminalOutputReadResult
} from '@shared/terminal-output'
import { stripAnsiToText } from './ansi-stripper'
import { randomInt } from 'crypto'

const DEFAULT_MAX_BYTES = 1024 * 1024 // 1M 码元（UTF-16 code unit，非字节）

/** 活块数超过该值时就地两两合并，给超小 append 兜底 */
const MAX_CHUNKS = 4096

/**
 * 输出代际计数器：每个新实例取一个从 1 开始递增的值。
 * 0 永远不是合法代际，因此把 0 当“上次值”传进来的调用方会得到 epoch-mismatch。
 */
let nextOutputEpoch = randomInt(1, 2 ** 48)

/**
 * 返回 cut 处是否正处在一个**未完成**的转义/控制序列里。
 * 是则返回该序列起点的下标（应从那里截断），否则返回 -1。
 *
 * 该函数只看 cut 之前最后一个 ESC：末端的转义序列被切断时，宁可少返回几个
 * 码元，也不要把 `\x1b[3` 这类残缺参数当普通文本交给 stripAnsiToText
 * （那会残留 "3"），更不能让调用方从转义序列中间续读。
 */
function unterminatedEscapeStart(raw: string, cut: number): number {
  const esc = raw.lastIndexOf('\x1b', cut - 1)
  if (esc < 0) return -1
  let i = esc + 1
  if (i >= cut) return esc // 只有 ESC 本身
  const kind = raw.charCodeAt(i)
  if (kind === 0x5b) {
    // CSI：参数字节 0x30-0x3f、中间字节 0x20-0x2f、终止字节 0x40-0x7e
    i += 1
    while (i < cut && raw.charCodeAt(i) >= 0x30 && raw.charCodeAt(i) <= 0x3f) i += 1
    while (i < cut && raw.charCodeAt(i) >= 0x20 && raw.charCodeAt(i) <= 0x2f) i += 1
    return i < cut ? -1 : esc
  }
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    // OSC/DCS/SOS/PM/APC：以 BEL 或 ST 结束；ST 的 ESC 会是“最后一个 ESC”，
    // 因此这里只需在 payload 里找 BEL。
    for (let j = esc + 1; j < cut; j += 1) {
      if (raw.charCodeAt(j) === 0x07) return -1
    }
    return esc
  }
  // 单字符转义 / ESC + 中间字节（如 ESC ( B）
  while (i < cut && raw.charCodeAt(i) >= 0x20 && raw.charCodeAt(i) <= 0x2f) i += 1
  return i < cut ? -1 : esc
}

/**
 * 把截断点收缩到安全的码元边界：
 * - 末尾是高代理、下一个码元是低代理时把整个代理对纳入本次响应（最多超出
 *   maxChars 1 个码元），既不切裂 emoji，也保证调用方总能推进游标；
 * - 不切开未完成的转义序列（回到 ESC 之前）。
 * `raw` 至少有 `limit + 1` 个码元（响应被截断时才调用）。
 */
function adjustTruncation(raw: string, cut: number): number {
  let safe = Math.min(cut, raw.length)
  if (safe > 0) {
    const last = raw.charCodeAt(safe - 1)
    const next = raw.charCodeAt(safe)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) safe += 1
  }
  const esc = unterminatedEscapeStart(raw, safe)
  // esc === 0 时说明单个序列就超过 maxChars：保留候选截断点，否则无法推进游标。
  if (esc > 0) safe = esc
  return safe
}

export interface RecentOutputResult {
  text: string
  lines: number
}

export interface SinceOutputResult {
  text: string
  cursor: number
  truncated: boolean // 游标已被回收，返回了从最早可用位置开始的内容
}

interface TextCache {
  generation: number
  text: string
}

interface RecentCache extends TextCache {
  count: number
  stripAnsi: boolean
  lines: number
}

interface SliceCache {
  generation: number
  start: number
  raw: string
}

export class OutputBuffer {
  /** 原始数据块队列（含 ANSI 转义码）；[head, chunks.length) 为存活区间 */
  private chunks: string[] = []
  /** 队列头部下标（已被逻辑丢弃的块仍留在数组里，定期压缩） */
  private head = 0
  /** 队首块内已被回收的码元偏移，避免每次回收都切片复制整块内容 */
  private headOffset = 0
  /** 存活内容总长度（UTF-16 码元） */
  private length = 0
  /** 已被回收的码元数（存活内容起点对应的绝对偏移） */
  private baseOffset = 0
  /** 已写入的总码元数（绝对游标） */
  private writeCursor = 0
  /** 最近一次写入时间戳（ms） */
  private lastDataTime = 0
  /** 最大缓冲码元数（可由全局历史预算调整，见 setCapacity） */
  private maxBytes: number
  /** 输出代际：每个实例唯一，clear() 后更换，用于识别过期游标 */
  private outputEpoch: number
  /** 容量/长度变化观察者，供全局预算实时记账（不做任何强制约束） */
  private sizeObserver: ((buffer: OutputBuffer, size: number) => void) | null = null

  /** 内容版本号：任何写入/回收/清空都自增，用于读取缓存失效 */
  private generation = 0
  private joinedCache: TextCache | null = null
  private cleanCache: TextCache | null = null
  private recentCache: RecentCache | null = null
  /** 起点非 0 时的原始切片缓存（send_and_wait 每轮轮询会先 raw 再 clean，可共用一次切片） */
  private sliceCache: SliceCache | null = null
  /** getOutputSince 清洗结果缓存（按 generation + 起点） */
  private sinceTextCache: TextCache & { start: number } | null = null

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    // 上限按码元计；非正/非法值收敛为 0（等价于不保留任何历史）
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0
    this.outputEpoch = nextOutputEpoch
    nextOutputEpoch += 1
  }

  /**
   * 追加原始终端数据
   */
  append(data: string): void {
    if (!data) return
    this.writeCursor += data.length
    this.lastDataTime = Date.now()
    this.generation += 1
    this.dropCaches()

    // 单块就达到上限：结果必然只剩该块末尾 maxBytes 码元，直接替换全部历史，
    // 避免先入队再回收带来的中间态拷贝（结果与“先拼接后裁剪”一致）。
    if (data.length >= this.maxBytes) {
      // V8 的 substring 可能引用整个超大输入；独立复制保留尾部以释放 backing string。
      const tail = this.maxBytes > 0 ? data.slice(data.length - this.maxBytes) : ''
      const keep = data.length > this.maxBytes && tail ? Buffer.from(tail, 'utf16le').toString('utf16le') : tail
      this.baseOffset += this.length + data.length - keep.length
      this.replaceChunks(keep)
      this.publishSize()
      return
    }

    this.chunks.push(data)
    this.length += data.length

    // 超过上限时从头部回收
    if (this.length > this.maxBytes) {
      this.trim(this.length - this.maxBytes)
    }

    if (this.chunks.length - this.head > MAX_CHUNKS) {
      this.compactChunks()
    }
    this.publishSize()
  }

  /**
   * 当前写入游标（绝对偏移，UTF-16 码元），用于 send_and_wait 记录起点
   */
  getWriteCursor(): number {
    return this.writeCursor
  }

  /**
   * 最近一次数据写入时间戳（ms）
   */
  getLastDataTime(): number {
    return this.lastDataTime
  }

  /**
   * 当前输出代际（每个实例唯一，clear() 后更换）
   */
  getOutputEpoch(): number {
    return this.outputEpoch
  }

  /**
   * 当前仍可取到的最早游标；小于它的历史已被容量回收
   */
  getEarliestCursor(): number {
    return this.baseOffset
  }

  /**
   * 当前最新游标（等于 getWriteCursor）
   */
  getLatestCursor(): number {
    return this.writeCursor
  }

  /**
   * 当前容量上限（UTF-16 码元）
   */
  getCapacity(): number {
    return this.maxBytes
  }

  /**
   * 调整容量上限；缩小时立即回收超额历史。
   * 供全局历史预算按会话配额调用，不会改变游标语义。
   */
  setCapacity(next: number): void {
    const capacity = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0
    this.maxBytes = capacity
    if (this.length > capacity) {
      this.trim(this.length - capacity)
      this.generation += 1
      this.dropCaches()
    }
    this.publishSize()
  }

  /**
   * 丢弃全部历史但保留实例/游标连续性：游标继续增长，earliestCursor 前移到最新。
   * 返回是否真的丢弃了内容。
   */
  dropHistory(): boolean {
    if (!this.length) return false
    this.baseOffset += this.length
    this.replaceChunks('')
    this.generation += 1
    this.dropCaches()
    this.publishSize()
    return true
  }

  /**
   * 注册容量/长度变化观察者（全局历史预算用）；传 null 解除。
   * 观察者抛错会被吞掉，不能影响输出路径。
   */
  setSizeObserver(observer: ((buffer: OutputBuffer, size: number) => void) | null): void {
    this.sizeObserver = observer
  }

  /**
   * 增量读取一段原始输出，供 MCP 等外部消费者使用。
   *
   * 与 getOutputSince 的区别：
   * - 明确返回 outputEpoch / earliestCursor / latestCursor，游标过期可识别；
   * - 历史缺口（historyGap）与本次响应截断（responseTruncated）分开报告，
   *   前者是永久丢失，后者可以继续用 nextCursor 读完；
   * - 有响应上限，且截断点不会切开代理对或未完成的转义序列。
   *
   * 注意：这里返回的是**文本历史**，不是“完整屏幕内容”，不能据此假定已看到
   * 全屏状态；全屏 TUI 仍需真实终端。
   */
  readIncremental(request: TerminalOutputReadRequest): TerminalOutputReadResult | TerminalOutputReadFailure {
    if (!request || typeof request !== 'object') {
      return { ok: false, code: 'request-invalid', message: 'Output read request is required' }
    }
    const { cursor, outputEpoch } = request
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return { ok: false, code: 'cursor-invalid', message: 'Cursor must be a non-negative safe integer' }
    }
    if (outputEpoch !== undefined) {
      if (!Number.isSafeInteger(outputEpoch)) {
        return { ok: false, code: 'request-invalid', message: 'outputEpoch must be a safe integer' }
      }
      if (outputEpoch !== this.outputEpoch) {
        return {
          ok: false,
          code: 'epoch-mismatch',
          message: `Output epoch ${outputEpoch} is stale (current ${this.outputEpoch}); history was replaced`
        }
      }
    }
    if (cursor > this.writeCursor) {
      return { ok: false, code: 'cursor-ahead', message: `Cursor ${cursor} is ahead of latest ${this.writeCursor}` }
    }
    let maxChars = TERMINAL_OUTPUT_MAX_RESPONSE_CHARS
    if (request.maxChars !== undefined) {
      if (!Number.isSafeInteger(request.maxChars) || request.maxChars < 1) {
        return { ok: false, code: 'request-invalid', message: 'maxChars must be a positive safe integer' }
      }
      maxChars = Math.min(request.maxChars, TERMINAL_OUTPUT_HARD_MAX_RESPONSE_CHARS)
    }

    const earliestCursor = this.baseOffset
    const historyGap = cursor < earliestCursor
      ? { fromCursor: cursor, toCursor: earliestCursor, lostChars: earliestCursor - cursor }
      : undefined
    // 有缺口时从最早可用位置开始；否则从请求游标开始。
    const consumedBase = historyGap ? earliestCursor : cursor
    const start = consumedBase - earliestCursor
    const available = this.length - start
    const limit = Math.min(maxChars, available)
    const responseTruncated = limit < available

    let cut = limit
    let raw: string
    if (responseTruncated) {
      // 多取 1 个码元，用于判断截断点是否落在代理对中间。
      raw = this.takeFrom(start, limit + 1)
      cut = adjustTruncation(raw, limit)
    } else {
      raw = this.getSlice(start)
      cut = raw.length
    }
    const rawText = cut === raw.length ? raw : raw.slice(0, cut)
    return {
      ok: true,
      text: request.stripAnsi ? stripAnsiToText(rawText) : rawText,
      outputEpoch: this.outputEpoch,
      cursor,
      earliestCursor,
      latestCursor: this.writeCursor,
      nextCursor: consumedBase + cut,
      historyGap,
      responseTruncated,
      maxChars
    }
  }

  /**
   * 获取最近 N 行（按 \n 分割）
   * @param count 行数
   * @param stripAnsi 是否清洗 ANSI（默认 true）
   */
  getRecentLines(count: number, stripAnsi: boolean = true): RecentOutputResult {
    const cached = this.recentCache
    if (cached && cached.generation === this.generation && cached.count === count && cached.stripAnsi === stripAnsi) {
      return { text: cached.text, lines: cached.lines }
    }

    const source = stripAnsi ? this.cleanedText() : this.joinedText()
    const allLines = source.split('\n')
    // 去除末尾因结尾 \n 产生的空串
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop()
    }
    const start = Math.max(0, allLines.length - count)
    const lines = allLines.slice(start)
    const result = { text: lines.join('\n'), lines: lines.length }

    this.recentCache = {
      generation: this.generation,
      count,
      stripAnsi,
      text: result.text,
      lines: result.lines
    }
    return result
  }

  /**
   * 获取从指定游标之后的所有新增输出
   * @param cursor 起始游标（getWriteCursor 返回值）
   * @param stripAnsi 是否清洗 ANSI（默认 true）
   */
  getOutputSince(cursor: number, stripAnsi: boolean = true): SinceOutputResult {
    let start: number
    let truncated = false

    if (cursor < this.baseOffset) {
      // 游标已被回收，从最早可用位置开始
      start = 0
      truncated = true
    } else {
      start = cursor - this.baseOffset
      if (!(start > 0)) start = 0
      if (start > this.length) start = this.length
    }

    const cachedText = this.sinceTextCache
    if (stripAnsi && cachedText && cachedText.generation === this.generation && cachedText.start === start) {
      return { text: cachedText.text, cursor: this.writeCursor, truncated }
    }

    const raw = this.getSlice(start)
    let text: string
    if (!stripAnsi) {
      text = raw
    } else if (start === 0) {
      // 起点就是缓冲最早位置：复用整段清洗缓存（与 getRecentLines 共享）
      text = this.cleanedText()
    } else {
      text = stripAnsiToText(raw)
    }
    if (stripAnsi) {
      this.sinceTextCache = { generation: this.generation, start, text }
    }
    return { text, cursor: this.writeCursor, truncated }
  }

  /**
   * 清空缓冲区。游标与代际语义：游标归零，代际更换（旧游标/旧代际一律作废）。
   */
  clear(): void {
    this.replaceChunks('')
    this.baseOffset = 0
    this.writeCursor = 0
    this.generation += 1
    this.outputEpoch = nextOutputEpoch
    nextOutputEpoch += 1
    this.dropCaches()
    this.publishSize()
  }

  /**
   * 当前缓冲大小（UTF-16 码元）
   */
  size(): number {
    return this.length
  }

  /** 通知观察者当前存活长度；观察者异常不得影响写入路径 */
  private publishSize(): void {
    if (!this.sizeObserver) return
    try {
      this.sizeObserver(this, this.length)
    } catch { /* 预算记账异常不能破坏输出 */ }
  }

  /**
   * 从队首回收 drop 个码元
   * 常规路径只移动队首块内偏移量（O(1)），整块消费完才出队；队首块被消费过半时
   * 才切片释放前缀，因此既不会在每次 append 时复制整段历史，也不会长期保留已丢弃内容。
   */
  private trim(drop: number): void {
    let remaining = drop
    let consumed = 0
    while (remaining > 0 && this.head < this.chunks.length) {
      const available = this.chunks[this.head].length - this.headOffset
      if (remaining < available) {
        this.headOffset += remaining
        consumed += remaining
        remaining = 0
        break
      }
      remaining -= available
      consumed += available
      this.chunks[this.head] = ''
      this.head += 1
      this.headOffset = 0
    }

    this.length -= consumed
    this.baseOffset += consumed

    if (this.head >= this.chunks.length) {
      this.replaceChunks('')
      return
    }

    const headChunk = this.chunks[this.head]
    if (this.headOffset > 0 && this.headOffset * 2 >= headChunk.length) {
      // 已丢弃过半：裁剪前缀，释放对已回收内容的引用
      this.chunks[this.head] = headChunk.slice(this.headOffset)
      this.headOffset = 0
    }

    if (this.head > 0 && (this.head >= 64 || this.head * 2 >= this.chunks.length)) {
      // 压缩头部空槽，避免 chunks 数组无限增长（只复制引用，不复制内容）
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  /** 就地两两合并相邻块，把活块数减半（均摊 O(n) 复制） */
  private compactChunks(): void {
    if (this.headOffset > 0) {
      this.chunks[this.head] = this.chunks[this.head].slice(this.headOffset)
      this.headOffset = 0
    }
    const merged: string[] = []
    for (let i = this.head; i < this.chunks.length; i += 2) {
      merged.push(i + 1 < this.chunks.length ? this.chunks[i] + this.chunks[i + 1] : this.chunks[i])
    }
    this.chunks = merged
    this.head = 0
  }

  /** 以单个块替换全部历史（keep 为空表示清空） */
  private replaceChunks(keep: string): void {
    this.head = 0
    this.headOffset = 0
    if (keep) {
      this.chunks = [keep]
      this.length = keep.length
    } else {
      this.chunks = []
      this.length = 0
    }
  }

  private dropCaches(): void {
    this.joinedCache = null
    this.cleanCache = null
    this.recentCache = null
    this.sliceCache = null
    this.sinceTextCache = null
  }

  /** 存活区间的完整原始文本（按 generation 缓存） */
  private joinedText(): string {
    const cached = this.joinedCache
    if (cached && cached.generation === this.generation) return cached.text
    let text: string
    if (this.head >= this.chunks.length) {
      text = ''
    } else if (this.headOffset > 0) {
      const first = this.chunks[this.head].slice(this.headOffset)
      text = this.head + 1 < this.chunks.length ? first + this.chunks.slice(this.head + 1).join('') : first
    } else {
      text = this.chunks.slice(this.head).join('')
    }
    this.joinedCache = { generation: this.generation, text }
    return text
  }

  /** 完整原始文本经 ANSI/控制流清洗后的文本（按 generation 缓存） */
  private cleanedText(): string {
    const cached = this.cleanCache
    if (cached && cached.generation === this.generation) return cached.text
    const text = stripAnsiToText(this.joinedText())
    this.cleanCache = { generation: this.generation, text }
    return text
  }

  /** 取起点为 start 的原始文本；start 为 0 时复用整段拼接缓存 */
  private getSlice(start: number): string {
    if (start === 0) return this.joinedText()
    const cached = this.sliceCache
    if (cached && cached.generation === this.generation && cached.start === start) return cached.raw
    const raw = this.sliceFrom(start)
    this.sliceCache = { generation: this.generation, start, raw }
    return raw
  }

  /** 从绝对偏移 start 起最多复制 limit 个码元（UTF-16 代码单元） */
  private takeFrom(start: number, limit: number): string {
    if (!(limit > 0)) return ''
    let skip = Math.max(0, start)
    let remaining = limit
    const parts: string[] = []
    for (let i = this.head; i < this.chunks.length && remaining > 0; i += 1) {
      const offset = i === this.head ? this.headOffset : 0
      const available = this.chunks[i].length - offset
      if (skip >= available) {
        skip -= available
        continue
      }
      const take = Math.min(available - skip, remaining)
      parts.push(this.chunks[i].slice(offset + skip, offset + skip + take))
      remaining -= take
      skip = 0
    }
    return parts.join('')
  }

  /** 从绝对偏移 start 起截取原始文本；只复制 start 所在块及其后的内容 */
  private sliceFrom(start: number): string {
    if (!(start > 0)) return this.joinedText()

    let remaining = start
    for (let i = this.head; i < this.chunks.length; i += 1) {
      const offset = i === this.head ? this.headOffset : 0
      const available = this.chunks[i].length - offset
      if (remaining >= available) {
        remaining -= available
        continue
      }
      const parts: string[] = [this.chunks[i].slice(offset + remaining)]
      for (let j = i + 1; j < this.chunks.length; j += 1) {
        parts.push(this.chunks[j])
      }
      return parts.join('')
    }
    return ''
  }
}
