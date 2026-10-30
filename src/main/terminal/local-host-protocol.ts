/**
 * 本地 PTY 独立宿主 —— 纯协议层
 *
 * 该模块只依赖 Node 内置模块与 `@shared/terminal-control`（纯 TS 契约，无 Node/Electron
 * 依赖），供三处共用：
 *   - local-host-client.ts（Electron 主进程侧客户端）
 *   - local-host-worker.ts（ELECTRON_RUN_AS_NODE 独立宿主进程）
 *   - 单元测试（协议回环 / mock PTY）
 *
 * 约定：
 *   - 传输层是 Windows 随机 named pipe 或 profile 目录下的 Unix socket，不监听公网。
 *   - 帧格式：4 字节大端长度 + UTF-8 JSON。JSON 里不含原始换行（由 stringify 转义），
 *     因此二进制安全；长度前缀避免逐行扫描大段输出。
 *   - 输出序号（cursor / seq）以 UTF-16 码元（string.length）计数，与终端缓冲区的
 *     历史语义一致；容量上限按 UTF-8 字节计。
 *   - token 只在内存与 safeStorage 密文里存在，任何日志/命令行/URL 都不带 token。
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { isAbsolute, join } from 'path'
import { INPUT_CONTROL_CAPABILITY, isInputFence, type InputFence } from '@shared/terminal-control'

// ── 常量 ──────────────────────────────────────────────────────────────────────

/**
 * 协议版本：帧内 v 字段，双方都必须等值。
 *
 * v2 = 带输入围栏的协议：hello 声明能力、宿主有 fence 安装 RPC、每次 input 携带 fence。
 * v1 宿主没有围栏概念，若允许它继续用 v1 帧就相当于「静默降级」回无控制的直接写，
 * 因此两端都在解析阶段硬拒绝：版本不同一律 `incompatible-version`，不做兼容回退。
 */
export const LOCAL_HOST_PROTOCOL_VERSION = 2

/** 双方都必须具备的最小能力集合；缺任何一个都在握手阶段被明确拒绝。 */
export const LOCAL_HOST_REQUIRED_CAPABILITIES: readonly string[] = [INPUT_CONTROL_CAPABILITY]

/** 能力名的边界（不信任入参）。 */
export const MAX_CAPABILITIES = 32
export const MAX_CAPABILITY_CHARS = 64

/** 宿主描述文件版本。 */
export const HOST_DESCRIPTOR_VERSION = 1

/** userData 下的宿主目录名（描述文件、Unix socket）。 */
export const HOST_DIR_NAME = 'terminal-hosts'

/** 未被收纳时，最后一个客户端断开后的宽限期（毫秒）。 */
export const DEFAULT_GRACE_MS = 5000

/** PTY 退出后宿主持有状态等待迟到查询的时间（毫秒）。 */
export const DEFAULT_EXIT_RETENTION_MS = 60_000

/** 输出环形缓冲容量（字节）。 */
export const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024

/** 输出环形缓冲块数上限。 */
export const DEFAULT_BUFFER_BLOCKS = 4096

/** 单块最大码元数；超大输出按此切块，避免一块吞掉整个环。 */
export const DEFAULT_MAX_BLOCK_CHARS = 64 * 1024

/** 单帧最大字节数。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** 客户端连上后完成 hello 鉴权的时限。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000

/** bootstrap（父进程 IPC 下发配置 → ready）时限。 */
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000

/** terminate 等待真实 PTY 退出证据的时限。 */
export const DEFAULT_TERMINATE_TIMEOUT_MS = 5000

/** 客户端连接 pipe 的时限。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000

/** 心跳间隔；客户端超过 HEARTBEAT_DEAD_MS 没有任何帧即判定失联。 */
export const DEFAULT_HEARTBEAT_MS = 15_000
export const DEFAULT_HEARTBEAT_DEAD_MS = 45_000

/** 管道内积压超过该值时暂停下发，等 'drain'；慢客户端只丢环形缓冲，不阻塞 PTY。 */
export const MAX_SOCKET_PENDING_BYTES = 1024 * 1024

/** 环境变量/参数的边界（不信任任何入参）。 */
export const MAX_ENV_KEYS = 4096
export const MAX_ENV_KEY_CHARS = 1024
export const MAX_ENV_VALUE_CHARS = 32768
export const MAX_ARGS = 1024
export const MAX_ARG_CHARS = 32768
export const MAX_INPUT_CHARS = 32768
export const MAX_SHELL_CHARS = 4096
export const MAX_CWD_CHARS = 4096
export const MIN_TERM_DIMENSION = 1
export const MAX_TERM_DIMENSION = 4096
export const MAX_DESCRIPTOR_BYTES = 8 * 1024
export const MAX_TOKEN_CHARS = 512
export const MAX_REQUEST_ID_CHARS = 128

/** 描述文件字段名（顺序即写入顺序，便于人工排查）。 */
const DESCRIPTOR_KEYS = ['version', 'id', 'pipe', 'pid', 'encryptedToken'] as const

/** 只允许「本机随机 UUID 管道名」的形态，禁止任意路径被当成 pipe 接管。 */
const PIPE_PREFIX = '\\\\.\\pipe\\lyshell-local-host-'

/** Unix socket 路径长度硬上限（sockaddr_un，Linux 108 / macOS 104，留余量）。 */
const MAX_UNIX_SOCKET_BYTES = 100

// ── 错误 ──────────────────────────────────────────────────────────────────────

export type LocalHostErrorCode =
  | 'descriptor-missing'
  | 'descriptor-invalid'
  | 'secure-storage-unavailable'
  | 'host-unreachable'
  | 'host-busy'
  | 'host-mismatch'
  | 'unauthorized'
  | 'incompatible-version'
  | 'protocol-error'
  | 'fence-rejected'
  | 'input-denied'
  | 'input-expired'
  | 'frame-too-large'
  | 'rpc-timeout'
  | 'terminate-timeout'
  | 'terminate-failed'
  | 'not-running'
  | 'disconnected'
  | 'spawn-failed'
  | 'bootstrap-timeout'
  | 'bootstrap-failed'
  | 'worker-script-missing'
  | 'worker-exited'
  | 'closed'

/** 带稳定 code 的宿主错误：调用方按 code 分支，不解析 message。 */
export class LocalHostError extends Error {
  readonly code: LocalHostErrorCode

  constructor(code: LocalHostErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LocalHostError'
    this.code = code
  }
}

const LOCAL_HOST_ERROR_CODES: ReadonlySet<string> = new Set<LocalHostErrorCode>([
  'descriptor-missing',
  'descriptor-invalid',
  'secure-storage-unavailable',
  'host-unreachable',
  'host-busy',
  'host-mismatch',
  'unauthorized',
  'incompatible-version',
  'protocol-error',
  'fence-rejected',
  'input-denied',
  'input-expired',
  'frame-too-large',
  'rpc-timeout',
  'terminate-timeout',
  'terminate-failed',
  'not-running',
  'disconnected',
  'spawn-failed',
  'bootstrap-timeout',
  'bootstrap-failed',
  'worker-script-missing',
  'worker-exited',
  'closed'
])

/** 对端通过 ack/error 帧回传的 code 必须收敛回已知集合，未知一律按 protocol-error。 */
export function isLocalHostErrorCode(value: unknown): value is LocalHostErrorCode {
  return typeof value === 'string' && LOCAL_HOST_ERROR_CODES.has(value)
}

// ── 基础校验 ──────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new LocalHostError('protocol-error', `${what} must be an object`)
  return value
}

function requireString(value: unknown, what: string, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new LocalHostError('protocol-error', `${what} must be a non-empty string of at most ${maxChars} chars`)
  }
  return value
}

function requireSafeInt(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LocalHostError('protocol-error', `${what} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new LocalHostError('protocol-error', `${what} must be a boolean`)
  return value
}

// ── 身份与 token ──────────────────────────────────────────────────────────────

const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 随机 UUID v4 作为 hostId：与进程/管道绑定，不可预测。 */
export function newHostId(): string {
  return randomUUID()
}

export function isHostId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && HOST_ID_PATTERN.test(value)
}

export function requireHostId(value: unknown, what = 'hostId'): string {
  if (!isHostId(value)) throw new LocalHostError('descriptor-invalid', `${what} is not a valid UUID`)
  return value
}

/** 256 位随机 token（base64url，43 字符）。 */
export function newHostToken(): string {
  return randomBytes(32).toString('base64url')
}

export function isHostToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 43 || value.length > MAX_TOKEN_CHARS) return false
  return /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * 定长比较，避免按字节 early-return 泄漏前缀信息。
 * 长度不同时也走一次比较（对自身），使耗时不随内容变化。
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

// ── 路径 ──────────────────────────────────────────────────────────────────────

/** userData/terminal-hosts —— 描述文件与 Unix socket 的唯一存放目录。 */
export function hostStorageDir(userDataDir: string): string {
  return join(userDataDir, HOST_DIR_NAME)
}

export function hostDescriptorPath(userDataDir: string, id: string): string {
  return join(hostStorageDir(userDataDir), `${requireHostId(id)}.json`)
}

export function hostSocketPath(userDataDir: string, id: string): string {
  return join(hostStorageDir(userDataDir), `${requireHostId(id)}.sock`)
}

/**
 * 宿主监听地址：
 *   - win32：`\\.\pipe\lyshell-local-host-<uuid>`（随机、本机、不可公网访问）
 *   - 其它：profile 目录下的 `<uuid>.sock`
 * 地址由 hostId 确定性推导，因此描述文件里的 pipe 可以用 id 严格校验。
 */
export function hostPipePath(userDataDir: string, id: string, platform: NodeJS.Platform = process.platform): string {
  requireHostId(id)
  if (platform === 'win32') return `${PIPE_PREFIX}${id}`
  const socketPath = hostSocketPath(userDataDir, id)
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_BYTES) {
    throw new LocalHostError(
      'descriptor-invalid',
      `Unix socket path is too long (${Buffer.byteLength(socketPath, 'utf8')} bytes > ${MAX_UNIX_SOCKET_BYTES}); ` +
        'use a shorter userData directory for local PTY hosts'
    )
  }
  return socketPath
}

/** 描述文件里的 pipe 必须与 hostId 推导值完全一致，防止指到别的进程。 */
export function isHostPipeForId(
  pipe: unknown,
  id: string,
  userDataDir: string,
  platform: NodeJS.Platform = process.platform
): pipe is string {
  if (typeof pipe !== 'string' || pipe.length === 0 || pipe.length > 4096) return false
  if (!isHostId(id)) return false
  try {
    return pipe === hostPipePath(userDataDir, id, platform)
  } catch {
    return false
  }
}

// ── 输出环形缓冲 ──────────────────────────────────────────────────────────────

export interface RingBlock {
  /** 该块首码元的绝对序号。 */
  seq: number
  data: string
}

export interface RingReadResult {
  /** 请求游标已被回收时给出的缺失区间（调用方据此发送 gap 帧）。 */
  gap?: { from: number; to: number }
  blocks: RingBlock[]
  /** 缓冲区内最后一个可用序号。 */
  end: number
}

export interface RingBufferOptions {
  maxBytes?: number
  maxBlocks?: number
  maxBlockChars?: number
}

/**
 * 有界输出环：保留最近 maxBytes 字节 / maxBlocks 块，序号单调不回退。
 * 溢出时整块丢弃最旧数据，永远保留最新一块（否则客户端只会看到「全部缺失」）。
 */
export class LocalHostRingBuffer {
  private readonly maxBytes: number
  private readonly maxBlocks: number
  private readonly maxBlockChars: number
  private blocks: (RingBlock & { bytes: number })[] = []
  private byteCount = 0
  private end = 0

  constructor(options: RingBufferOptions = {}) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_BUFFER_BYTES)
    this.maxBlocks = Math.max(1, options.maxBlocks ?? DEFAULT_BUFFER_BLOCKS)
    this.maxBlockChars = Math.max(1, options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS)
  }

  /** 已被回收的首个可用序号。 */
  get start(): number {
    return this.blocks.length > 0 ? this.blocks[0].seq : this.end
  }

  /** 下一个待分配序号（= 已产出的码元总数）。 */
  get next(): number {
    return this.end
  }

  get blockCount(): number {
    return this.blocks.length
  }

  get byteLength(): number {
    return this.byteCount
  }

  /** 追加输出；空串忽略，超长串按 maxBlockChars 切块。 */
  append(data: string): void {
    if (typeof data !== 'string' || data.length === 0) return
    for (let offset = 0; offset < data.length; offset += this.maxBlockChars) {
      const chunk = data.slice(offset, offset + this.maxBlockChars)
      this.blocks.push({ seq: this.end, data: chunk, bytes: Buffer.byteLength(chunk, 'utf8') })
      this.end += chunk.length
      this.byteCount += Buffer.byteLength(chunk, 'utf8')
    }
    this.evict()
  }

  private evict(): void {
    while (this.blocks.length > 1 && (this.byteCount > this.maxBytes || this.blocks.length > this.maxBlocks)) {
      const dropped = this.blocks.shift()
      if (!dropped) break
      this.byteCount -= dropped.bytes
    }
  }

  /**
   * 流式下发用：游标早于已回收起点时返回缺失区间，否则 null。
   * 与 readFrom 的区别是每次只取一块，调用方边写边背压，不会一次性拼出整份快照。
   */
  gapFrom(cursor: number): { from: number; to: number } | null {
    this.assertCursor(cursor)
    if (cursor >= this.start) return null
    return { from: cursor, to: this.start }
  }

  /** 流式下发用：返回游标之后最旧的一块（游标落在块中间时从中间切）。 */
  firstFrom(cursor: number): RingBlock | null {
    this.assertCursor(cursor)
    for (const block of this.blocks) {
      const blockEnd = block.seq + block.data.length
      if (blockEnd <= cursor) continue
      if (block.seq >= cursor) return { seq: block.seq, data: block.data }
      return { seq: cursor, data: block.data.slice(cursor - block.seq) }
    }
    return null
  }

  private assertCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new LocalHostError('protocol-error', `cursor must be a non-negative integer, got ${cursor}`)
    }
    if (cursor > this.end) {
      throw new LocalHostError('protocol-error', `cursor ${cursor} is ahead of emitted output ${this.end}`)
    }
  }

  /**
   * 从游标处读取可用块。
   * 游标落在被回收区间时返回 gap；游标超过已产出序号属于协议错误（不猜意图）。
   */
  readFrom(cursor: number): RingReadResult {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new LocalHostError('protocol-error', `cursor must be a non-negative integer, got ${cursor}`)
    }
    if (cursor > this.end) {
      throw new LocalHostError('protocol-error', `cursor ${cursor} is ahead of emitted output ${this.end}`)
    }
    const start = this.start
    const result: RingReadResult = { blocks: [], end: this.end }
    let from = cursor
    if (from < start) {
      result.gap = { from, to: start }
      from = start
    }
    for (const block of this.blocks) {
      const blockEnd = block.seq + block.data.length
      if (blockEnd <= from) continue
      if (block.seq >= from) {
        result.blocks.push({ seq: block.seq, data: block.data })
      } else {
        result.blocks.push({ seq: from, data: block.data.slice(from - block.seq) })
      }
    }
    return result
  }
}

// ── 帧编解码 ──────────────────────────────────────────────────────────────────

const FRAME_HEADER_BYTES = 4

/** 长度前缀 + UTF-8 JSON。超限直接拒绝，不悄悄截断。 */
export function encodeFrame(message: unknown, maxFrameBytes: number = MAX_FRAME_BYTES): Buffer {
  if (message === undefined) throw new LocalHostError('protocol-error', 'cannot encode undefined frame')
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length === 0) throw new LocalHostError('protocol-error', 'empty frame body')
  if (body.length > maxFrameBytes) {
    throw new LocalHostError('frame-too-large', `frame of ${body.length} bytes exceeds limit ${maxFrameBytes}`)
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** 客户端帧编码：统一补协议版本，避免每处手写 v（宿主帧另有 hostId 前缀）。 */
export function encodeClientFrame(payload: Record<string, unknown>, maxFrameBytes: number = MAX_FRAME_BYTES): Buffer {
  return encodeFrame({ v: LOCAL_HOST_PROTOCOL_VERSION, ...payload }, maxFrameBytes)
}

/** 增量帧解码器：处理跨 chunk 拆包与多帧粘包，坏帧抛错由调用方断链。 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  get pendingBytes(): number {
    return this.buffer.length
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk
    const frames: unknown[] = []
    let offset = 0
    while (this.buffer.length - offset >= FRAME_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(offset)
      if (length === 0 || length > this.maxFrameBytes) {
        throw new LocalHostError('frame-too-large', `invalid frame length ${length}`)
      }
      if (this.buffer.length - offset - FRAME_HEADER_BYTES < length) break
      const body = this.buffer.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length)
      offset += FRAME_HEADER_BYTES + length
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        throw new LocalHostError('protocol-error', 'frame body is not valid JSON')
      }
      frames.push(parsed)
    }
    if (offset > 0) {
      // 复制剩余字节，避免 subarray 长期持有整块大 chunk。
      this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(offset))
    }
    return frames
  }
}

// ── 线协议消息 ────────────────────────────────────────────────────────────────

export interface LocalHostSpawnOptions {
  shell: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface LocalHostStatus {
  id: string
  running: boolean
  retained: boolean
  exitCode?: number
}

export type ClientHelloMode = 'attach' | 'probe'

export interface ClientHelloFrame {
  v: number
  type: 'hello'
  hostId: string
  token: string
  clientId: string
  mode: ClientHelloMode
  cursor: number
  replay: boolean
  /** 客户端具备的能力；必须覆盖 LOCAL_HOST_REQUIRED_CAPABILITIES。 */
  capabilities: string[]
}

export type ClientFrame =
  | ClientHelloFrame
  /** input 必须携带 fence：宿主在写之前核对当前活动连接 + 代际 + 有效期。 */
  | { v: number; type: 'input'; reqId: string; data: string; fence: InputFence }
  /** 安装/撤销输入围栏；`fence: null` = 撤销。 */
  | { v: number; type: 'input-fence'; reqId: string; fence: InputFence | null }
  | { v: number; type: 'resize'; reqId: string; cols: number; rows: number; fence?: InputFence }
  | { v: number; type: 'pause' }
  | { v: number; type: 'resume' }
  | { v: number; type: 'retain'; reqId: string; value: boolean }
  | { v: number; type: 'status'; reqId: string }
  | { v: number; type: 'detach'; reqId: string }
  | { v: number; type: 'terminate'; reqId: string }
  | { v: number; type: 'ping'; reqId: string }

export type HostFrame =
  | { v: number; type: 'welcome'; hostId: string; status: LocalHostStatus; cursor: number; capabilities: string[] }
  | { v: number; type: 'probe'; hostId: string; status: LocalHostStatus; capabilities: string[] }
  | { v: number; type: 'data'; hostId: string; start: number; data: string }
  | { v: number; type: 'gap'; hostId: string; from: number; to: number }
  | { v: number; type: 'exit'; hostId: string; exitCode: number }
  | { v: number; type: 'ack'; hostId: string; reqId: string; ok: true; exitCode?: number; status?: LocalHostStatus }
  | { v: number; type: 'ack'; hostId: string; reqId: string; ok: false; code: string; message: string }
  | { v: number; type: 'status'; hostId: string; reqId: string; status: LocalHostStatus }
  | { v: number; type: 'heartbeat'; hostId: string; at: number }
  | { v: number; type: 'error'; hostId: string; code: string; message: string; fatal: boolean }
  | { v: number; type: 'busy'; hostId: string }

const CLIENT_COMMAND_TYPES = new Set([
  'hello',
  'input',
  'input-fence',
  'resize',
  'pause',
  'resume',
  'retain',
  'status',
  'detach',
  'terminate',
  'ping'
])

const HOST_FRAME_TYPES = new Set([
  'welcome',
  'probe',
  'data',
  'gap',
  'exit',
  'ack',
  'status',
  'heartbeat',
  'error',
  'busy'
])

/**
 * 版本不一致一律按 `incompatible-version` 拒绝：这是「明确不兼容」而不是「帧格式看不懂」，
 * 上层据此提示升级宿主，绝不静默降级到无围栏写入。
 */
function requireProtocolVersion(value: unknown): number {
  if (typeof value !== 'number') {
    throw new LocalHostError('protocol-error', 'frame is missing a numeric protocol version')
  }
  if (value !== LOCAL_HOST_PROTOCOL_VERSION) {
    throw new LocalHostError(
      'incompatible-version',
      `unsupported protocol version ${String(value)} (expected ${LOCAL_HOST_PROTOCOL_VERSION})`
    )
  }
  return LOCAL_HOST_PROTOCOL_VERSION
}

/** 能力列表：有界、去重、字符串非空；越界直接拒绝。 */
export function parseCapabilities(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new LocalHostError('protocol-error', `${what} must be an array of at most ${MAX_CAPABILITIES} strings`)
  }
  const capabilities: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_CAPABILITY_CHARS) {
      throw new LocalHostError('protocol-error', `${what} entries must be non-empty strings of at most ${MAX_CAPABILITY_CHARS} chars`)
    }
    if (!capabilities.includes(entry)) capabilities.push(entry)
  }
  return capabilities
}

/** 缺少必需能力 ⇒ 明确拒绝握手，不降级。 */
export function requireCapabilities(capabilities: readonly string[], what: string): void {
  const missing = LOCAL_HOST_REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability))
  if (missing.length > 0) {
    throw new LocalHostError(
      'incompatible-version',
      `${what} is missing required capabilities: ${missing.join(', ')}`
    )
  }
}

/** fence 五字段必须完整且自洽；缺字段/越界一律 protocol-error。 */
export function parseInputFence(value: unknown, what: string): InputFence {
  if (!isInputFence(value)) {
    throw new LocalHostError(
      'protocol-error',
      `${what} must be an input fence with epoch, connectionInstanceId, controllerInstanceId, leaseId and expiresAt`
    )
  }
  return {
    epoch: value.epoch,
    connectionInstanceId: value.connectionInstanceId,
    controllerInstanceId: value.controllerInstanceId,
    leaseId: value.leaseId,
    expiresAt: value.expiresAt
  }
}

export function parseLocalHostStatus(value: unknown): LocalHostStatus {
  const record = requireRecord(value, 'status')
  const status: LocalHostStatus = {
    id: requireHostId(record.id, 'status.id'),
    running: requireBoolean(record.running, 'status.running'),
    retained: requireBoolean(record.retained, 'status.retained')
  }
  if (record.exitCode !== undefined) {
    status.exitCode = requireSafeInt(record.exitCode, 'status.exitCode', -2147483648, 2147483647)
  }
  return status
}

function requireRequestId(value: unknown): string {
  return requireString(value, 'reqId', MAX_REQUEST_ID_CHARS)
}

/** 客户端 → 宿主帧解析：未知 type 或字段越界一律拒绝，不静默忽略。 */
export function parseClientFrame(value: unknown): ClientFrame {
  const record = requireRecord(value, 'client frame')
  const type = record.type
  if (typeof type !== 'string' || !CLIENT_COMMAND_TYPES.has(type)) {
    throw new LocalHostError('protocol-error', `unknown client frame type ${String(type)}`)
  }
  requireProtocolVersion(record.v)
  const v = LOCAL_HOST_PROTOCOL_VERSION
  switch (type as ClientFrame['type']) {
    case 'hello': {
      const mode = record.mode
      if (mode !== 'attach' && mode !== 'probe') {
        throw new LocalHostError('protocol-error', 'hello.mode must be attach or probe')
      }
      const capabilities = parseCapabilities(record.capabilities, 'hello.capabilities')
      requireCapabilities(capabilities, 'hello')
      return {
        v,
        type: 'hello',
        hostId: requireHostId(record.hostId, 'hello.hostId'),
        token: requireString(record.token, 'hello.token', MAX_TOKEN_CHARS),
        clientId: requireString(record.clientId, 'hello.clientId', 128),
        mode,
        cursor: record.cursor === undefined ? 0 : requireSafeInt(record.cursor, 'hello.cursor', 0, Number.MAX_SAFE_INTEGER),
        replay: record.replay === undefined ? true : requireBoolean(record.replay, 'hello.replay'),
        capabilities
      }
    }
    case 'input': {
      const data = record.data
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INPUT_CHARS) {
        throw new LocalHostError('protocol-error', 'input.data must be a non-empty string within bounds')
      }
      return { v, type: 'input', reqId: requireRequestId(record.reqId), data, fence: parseInputFence(record.fence, 'input.fence') }
    }
    case 'input-fence': {
      const raw = record.fence
      const fence = raw === null ? null : parseInputFence(raw, 'input-fence.fence')
      return { v, type: 'input-fence', reqId: requireRequestId(record.reqId), fence }
    }
    case 'resize':
      return {
        v,
        type: 'resize',
        reqId: requireRequestId(record.reqId),
        ...(record.fence === undefined ? {} : { fence: parseInputFence(record.fence, 'resize.fence') }),
        cols: requireSafeInt(record.cols, 'resize.cols', MIN_TERM_DIMENSION, MAX_TERM_DIMENSION),
        rows: requireSafeInt(record.rows, 'resize.rows', MIN_TERM_DIMENSION, MAX_TERM_DIMENSION)
      }
    case 'pause':
      return { v, type: 'pause' }
    case 'resume':
      return { v, type: 'resume' }
    case 'retain':
      return { v, type: 'retain', reqId: requireRequestId(record.reqId), value: requireBoolean(record.value, 'retain.value') }
    case 'status':
      return { v, type: 'status', reqId: requireRequestId(record.reqId) }
    case 'detach':
      return { v, type: 'detach', reqId: requireRequestId(record.reqId) }
    case 'terminate':
      return { v, type: 'terminate', reqId: requireRequestId(record.reqId) }
    case 'ping':
      return { v, type: 'ping', reqId: requireRequestId(record.reqId) }
    default:
      throw new LocalHostError('protocol-error', `unsupported client frame type ${type}`)
  }
}

/** 宿主 → 客户端帧解析：每条回复都必须带 hostId（防误接另一个宿主）。 */
export function parseHostFrame(value: unknown): HostFrame {
  const record = requireRecord(value, 'host frame')
  const type = record.type
  if (typeof type !== 'string' || !HOST_FRAME_TYPES.has(type)) {
    throw new LocalHostError('protocol-error', `unknown host frame type ${String(type)}`)
  }
  requireProtocolVersion(record.v)
  const v = LOCAL_HOST_PROTOCOL_VERSION
  const hostId = requireHostId(record.hostId, 'host frame hostId')
  switch (type as HostFrame['type']) {
    case 'welcome': {
      const capabilities = parseCapabilities(record.capabilities, 'welcome.capabilities')
      requireCapabilities(capabilities, 'welcome')
      return {
        v,
        type: 'welcome',
        hostId,
        status: parseLocalHostStatus(record.status),
        cursor: requireSafeInt(record.cursor, 'welcome.cursor', 0, Number.MAX_SAFE_INTEGER),
        capabilities
      }
    }
    case 'probe': {
      const capabilities = parseCapabilities(record.capabilities, 'probe.capabilities')
      requireCapabilities(capabilities, 'probe')
      return { v, type: 'probe', hostId, status: parseLocalHostStatus(record.status), capabilities }
    }
    case 'data': {
      const data = record.data
      if (typeof data !== 'string') throw new LocalHostError('protocol-error', 'data.data must be a string')
      return {
        v,
        type: 'data',
        hostId,
        start: requireSafeInt(record.start, 'data.start', 0, Number.MAX_SAFE_INTEGER),
        data
      }
    }
    case 'gap':
      return {
        v,
        type: 'gap',
        hostId,
        from: requireSafeInt(record.from, 'gap.from', 0, Number.MAX_SAFE_INTEGER),
        to: requireSafeInt(record.to, 'gap.to', 0, Number.MAX_SAFE_INTEGER)
      }
    case 'exit':
      return { v, type: 'exit', hostId, exitCode: requireSafeInt(record.exitCode, 'exit.exitCode', -2147483648, 2147483647) }
    case 'ack': {
      const reqId = requireRequestId(record.reqId)
      if (record.ok === true) {
        const ack: Extract<HostFrame, { type: 'ack'; ok: true }> = { v, type: 'ack', hostId, reqId, ok: true }
        if (record.exitCode !== undefined) ack.exitCode = requireSafeInt(record.exitCode, 'ack.exitCode', -2147483648, 2147483647)
        if (record.status !== undefined) ack.status = parseLocalHostStatus(record.status)
        return ack
      }
      if (record.ok === false) {
        return {
          v,
          type: 'ack',
          hostId,
          reqId,
          ok: false,
          code: requireString(record.code, 'ack.code', 64),
          message: typeof record.message === 'string' ? record.message.slice(0, 512) : 'request failed'
        }
      }
      throw new LocalHostError('protocol-error', 'ack.ok must be a boolean')
    }
    case 'status':
      return { v, type: 'status', hostId, reqId: requireRequestId(record.reqId), status: parseLocalHostStatus(record.status) }
    case 'heartbeat':
      return { v, type: 'heartbeat', hostId, at: requireSafeInt(record.at, 'heartbeat.at', 0, Number.MAX_SAFE_INTEGER) }
    case 'error':
      return {
        v,
        type: 'error',
        hostId,
        code: requireString(record.code, 'error.code', 64),
        message: typeof record.message === 'string' ? record.message.slice(0, 512) : 'host error',
        fatal: record.fatal === undefined ? true : requireBoolean(record.fatal, 'error.fatal')
      }
    case 'busy':
      return { v, type: 'busy', hostId }
    default:
      throw new LocalHostError('protocol-error', `unsupported host frame type ${type}`)
  }
}

// ── bootstrap（父进程 IPC → 宿主进程）────────────────────────────────────────

export interface HostTuning {
  graceMs: number
  exitRetentionMs: number
  bufferBytes: number
  bufferBlocks: number
  maxBlockChars: number
  handshakeTimeoutMs: number
  terminateTimeoutMs: number
  heartbeatMs: number
}

export interface HostBootstrapConfig {
  id: string
  token: string
  pipe: string
  spawn: LocalHostSpawnOptions
  tuning: HostTuning
  /**
   * 宿主自己清理描述文件时需要的 userData 目录（协议扩展，见 host-report.md）。
   * 只有路径，不含凭据；未提供时宿主不碰任何描述文件。
   */
  userDataDir?: string
}

export interface HostReadyMessage {
  kind: 'ready'
  v: number
  id: string
  pid: number
  pipe: string
}

export const DEFAULT_HOST_TUNING: HostTuning = {
  graceMs: DEFAULT_GRACE_MS,
  exitRetentionMs: DEFAULT_EXIT_RETENTION_MS,
  bufferBytes: DEFAULT_BUFFER_BYTES,
  bufferBlocks: DEFAULT_BUFFER_BLOCKS,
  maxBlockChars: DEFAULT_MAX_BLOCK_CHARS,
  handshakeTimeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
  terminateTimeoutMs: DEFAULT_TERMINATE_TIMEOUT_MS,
  heartbeatMs: DEFAULT_HEARTBEAT_MS
}

/** 校验父进程下发的真实 shell/args/cwd/env/尺寸；任何越界都拒绝启动。 */
export function validateSpawnOptions(value: unknown): LocalHostSpawnOptions {
  const record = requireRecord(value, 'spawn options')
  const shell = requireString(record.shell, 'spawn.shell', MAX_SHELL_CHARS)
  const argsValue = record.args
  if (!Array.isArray(argsValue) || argsValue.length > MAX_ARGS) {
    throw new LocalHostError('protocol-error', `spawn.args must be an array of at most ${MAX_ARGS} strings`)
  }
  const args = argsValue.map((arg, index) => {
    // 空参数有实际的 shell/CLI 语义，不能按 shell 路径的非空规则拒绝。
    if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS) {
      throw new LocalHostError('protocol-error', `spawn.args[${index}] must be a string within bounds`)
    }
    return arg
  })
  let cwd: string | undefined
  if (record.cwd !== undefined) {
    cwd = requireString(record.cwd, 'spawn.cwd', MAX_CWD_CHARS)
    if (!isAbsolute(cwd)) throw new LocalHostError('protocol-error', 'spawn.cwd must be absolute')
  }
  const envValue = record.env
  if (!isRecord(envValue)) throw new LocalHostError('protocol-error', 'spawn.env must be an object')
  const envKeys = Object.keys(envValue)
  if (envKeys.length > MAX_ENV_KEYS) {
    throw new LocalHostError('protocol-error', `spawn.env has too many keys (${envKeys.length})`)
  }
  const env: Record<string, string> = {}
  for (const key of envKeys) {
    if (key.length === 0 || key.length > MAX_ENV_KEY_CHARS || key.includes('=') || key.includes('\0')) {
      throw new LocalHostError('protocol-error', `spawn.env key ${JSON.stringify(key.slice(0, 32))} is invalid`)
    }
    const raw = envValue[key]
    if (typeof raw !== 'string' || raw.length > MAX_ENV_VALUE_CHARS) {
      throw new LocalHostError('protocol-error', `spawn.env[${key}] must be a string within bounds`)
    }
    env[key] = raw
  }
  return {
    shell,
    args,
    ...(cwd !== undefined ? { cwd } : {}),
    env,
    cols: requireSafeInt(record.cols, 'spawn.cols', MIN_TERM_DIMENSION, MAX_TERM_DIMENSION),
    rows: requireSafeInt(record.rows, 'spawn.rows', MIN_TERM_DIMENSION, MAX_TERM_DIMENSION)
  }
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
}

/**
 * 解析 bootstrap 消息。token 只进内存，任何错误消息都不包含它。
 * tuning 只接受有界整数，越界回落默认值（不因为调参失败拒绝启动 PTY）。
 */
export function parseHostBootstrapMessage(value: unknown, expectedPipe?: string): HostBootstrapConfig {
  const record = requireRecord(value, 'bootstrap')
  if (record.kind !== 'bootstrap') throw new LocalHostError('protocol-error', 'expected bootstrap message')
  requireProtocolVersion(record.v)
  const id = requireHostId(record.id, 'bootstrap.id')
  const token = requireString(record.token, 'bootstrap.token', MAX_TOKEN_CHARS)
  if (!isHostToken(token)) throw new LocalHostError('protocol-error', 'bootstrap.token is not a 256-bit token')
  const pipe = requireString(record.pipe, 'bootstrap.pipe', 4096)
  if (expectedPipe && pipe !== expectedPipe) {
    throw new LocalHostError('protocol-error', 'bootstrap.pipe does not match the requested host')
  }
  // 可选的 userDataDir：只用于宿主退出时清理自己的描述文件，必须是绝对路径。
  let userDataDir: string | undefined
  if (record.userDataDir !== undefined) {
    userDataDir = requireString(record.userDataDir, 'bootstrap.userDataDir', MAX_CWD_CHARS)
    if (!isAbsolute(userDataDir)) {
      throw new LocalHostError('protocol-error', 'bootstrap.userDataDir must be absolute')
    }
  }
  const tuningRecord = isRecord(record.tuning) ? record.tuning : {}
  const tuning: HostTuning = {
    graceMs: numberInRange(tuningRecord.graceMs, DEFAULT_HOST_TUNING.graceMs, 0, 600_000),
    exitRetentionMs: numberInRange(tuningRecord.exitRetentionMs, DEFAULT_HOST_TUNING.exitRetentionMs, 0, 24 * 3600_000),
    bufferBytes: numberInRange(tuningRecord.bufferBytes, DEFAULT_HOST_TUNING.bufferBytes, 1, 64 * 1024 * 1024),
    bufferBlocks: numberInRange(tuningRecord.bufferBlocks, DEFAULT_HOST_TUNING.bufferBlocks, 1, 65_536),
    maxBlockChars: numberInRange(tuningRecord.maxBlockChars, DEFAULT_HOST_TUNING.maxBlockChars, 1, 1024 * 1024),
    handshakeTimeoutMs: numberInRange(tuningRecord.handshakeTimeoutMs, DEFAULT_HOST_TUNING.handshakeTimeoutMs, 100, 120_000),
    terminateTimeoutMs: numberInRange(tuningRecord.terminateTimeoutMs, DEFAULT_HOST_TUNING.terminateTimeoutMs, 100, 120_000),
    heartbeatMs: numberInRange(tuningRecord.heartbeatMs, DEFAULT_HOST_TUNING.heartbeatMs, 100, 600_000)
  }
  return {
    id,
    token,
    pipe,
    spawn: validateSpawnOptions(record.spawn),
    tuning,
    ...(userDataDir !== undefined ? { userDataDir } : {})
  }
}

export function parseHostReadyMessage(value: unknown, expectedId?: string): HostReadyMessage {
  const record = requireRecord(value, 'ready')
  if (record.kind !== 'ready') throw new LocalHostError('protocol-error', 'expected ready message')
  requireProtocolVersion(record.v)
  const id = requireHostId(record.id, 'ready.id')
  if (expectedId && id !== expectedId) throw new LocalHostError('protocol-error', 'ready.id does not match the spawned host')
  return {
    kind: 'ready',
    v: LOCAL_HOST_PROTOCOL_VERSION,
    id,
    pid: requireSafeInt(record.pid, 'ready.pid', 1, Number.MAX_SAFE_INTEGER),
    pipe: requireString(record.pipe, 'ready.pipe', 4096)
  }
}

// ── 宿主描述文件 ──────────────────────────────────────────────────────────────

/** 落盘内容固定这五个字段；token 只有 safeStorage 密文。 */
export interface HostDescriptor {
  version: number
  id: string
  pipe: string
  pid: number
  encryptedToken: string
}

export interface DescriptorContext {
  userDataDir: string
  platform?: NodeJS.Platform
}

/**
 * 严格校验描述文件字段与边界：版本、UUID、pipe 与 id 的对应关系、pid 范围、
 * 密文 base64 长度。损坏/被篡改一律拒绝，不做部分采纳。
 */
export function parseHostDescriptor(raw: unknown, context: DescriptorContext): HostDescriptor {
  const record = requireRecord(raw, 'host descriptor')
  if (record.version !== HOST_DESCRIPTOR_VERSION) {
    throw new LocalHostError(
      'descriptor-invalid',
      `unsupported host descriptor version ${String(record.version)}`
    )
  }
  const id = requireHostId(record.id, 'descriptor.id')
  const platform = context.platform ?? process.platform
  const pipe = record.pipe
  if (!isHostPipeForId(pipe, id, context.userDataDir, platform)) {
    throw new LocalHostError('descriptor-invalid', 'descriptor.pipe does not belong to descriptor.id')
  }
  const encryptedToken = record.encryptedToken
  if (
    typeof encryptedToken !== 'string' ||
    encryptedToken.length === 0 ||
    encryptedToken.length > MAX_DESCRIPTOR_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedToken)
  ) {
    throw new LocalHostError('descriptor-invalid', 'descriptor.encryptedToken is not valid base64')
  }
  return {
    version: HOST_DESCRIPTOR_VERSION,
    id,
    pipe,
    pid: requireSafeInt(record.pid, 'descriptor.pid', 1, 2147483647),
    encryptedToken
  }
}

/** 只读已存在文件；不存在返回 null（损坏抛错，由调用方决定清理策略）。 */
export function readHostDescriptor(userDataDir: string, id: string): HostDescriptor | null {
  const path = hostDescriptorPath(userDataDir, id)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new LocalHostError('descriptor-invalid', 'failed to read host descriptor', { cause: error })
  }
  if (text.length > MAX_DESCRIPTOR_BYTES) {
    throw new LocalHostError('descriptor-invalid', 'host descriptor is too large')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new LocalHostError('descriptor-invalid', 'host descriptor is not valid JSON', { cause: error })
  }
  return parseHostDescriptor(raw, { userDataDir })
}

/**
 * 原子写：先写同目录临时文件（mode 0600）再 rename，随后尽力 chmod 0600。
 * 目录以 0700 创建（Windows 上 mode 基本无效，尽力而为）。
 */
export function writeHostDescriptor(userDataDir: string, descriptor: HostDescriptor): string {
  const dir = hostStorageDir(userDataDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = hostDescriptorPath(userDataDir, descriptor.id)
  const validated = parseHostDescriptor(descriptor, { userDataDir })
  const payload: Record<string, unknown> = {}
  for (const key of DESCRIPTOR_KEYS) payload[key] = validated[key]
  const text = JSON.stringify(payload)
  if (text.length > MAX_DESCRIPTOR_BYTES) {
    throw new LocalHostError('descriptor-invalid', 'host descriptor would exceed the size limit')
  }
  const tmp = join(dir, `.${validated.id}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能根本没写成，忽略
    }
    throw new LocalHostError('descriptor-invalid', 'failed to persist host descriptor', { cause: error })
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows / 只读卷上 chmod 无意义，密文本身只有本机 safeStorage 能解开
  }
  return path
}

/**
 * 删除描述文件，但只删内容 id 与参数一致的（防止 id 复用/竞态误删别的宿主记录）。
 * 返回是否真的删掉了文件。
 */
export function removeHostDescriptor(userDataDir: string, id: string): boolean {
  const path = hostDescriptorPath(userDataDir, id)
  try {
    if (!existsSync(path)) return false
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(raw) || raw.id !== id) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** 缺失/损坏一律返回 null：清理逻辑不因为单个坏文件中断。 */
export function listHostDescriptorIds(userDataDir: string, limit = 256): string[] {
  let names: string[]
  try {
    names = readdirSync(hostStorageDir(userDataDir)) as string[]
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const id = name.slice(0, -'.json'.length)
    if (!isHostId(id)) continue
    ids.push(id)
    if (ids.length >= limit) break
  }
  return ids
}
