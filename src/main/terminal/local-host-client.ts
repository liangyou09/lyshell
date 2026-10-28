/**
 * 本地 PTY 独立宿主 —— 主进程侧客户端
 *
 * 职责（与 local-host-worker.ts 对偶）：
 *   - create()：spawn 一个 `ELECTRON_RUN_AS_NODE` 的宿主进程，经**父进程 IPC** 下发
 *     bootstrap（真实 shell/args/cwd/env/尺寸 + token + pipe 地址），拿到 ready 后
 *     把「哪台宿主、在哪个管道、pid 多少、token 密文」写进 userData/terminal-hosts。
 *   - attach()：只凭 hostId 找回宿主。token 从描述文件解出，永远不进命令行/URL/日志。
 *   - probe()：只读查询，不抢占已有客户端、不改 retained。
 *
 * 纪律：
 *   - token 只在内存与 safeStorage 密文里；日志/异常消息里不出现 token。
 *   - 输入只显式发送，重连绝不重放；请求带 reqId，宿主侧有界去重。
 *   - 断线不当成功：pending RPC 全部以 disconnected 失败，terminate 必须有真实 exitCode。
 *   - 输出重放等调用方装好监听才派发（见 pump()），避免 attach 同步返回时丢首屏。
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { connect } from 'net'
import type { Socket } from 'net'
import { isAbsolute, join } from 'path'
import { safeStorage } from 'electron'
import {
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_DEAD_MS,
  DEFAULT_HOST_TUNING,
  DEFAULT_TERMINATE_TIMEOUT_MS,
  FrameDecoder,
  HOST_DESCRIPTOR_VERSION,
  LOCAL_HOST_PROTOCOL_VERSION,
  LocalHostError,
  MAX_INPUT_CHARS,
  MAX_TERM_DIMENSION,
  MIN_TERM_DIMENSION,
  encodeClientFrame,
  hostPipePath,
  isHostId,
  isLocalHostErrorCode,
  newHostId,
  newHostToken,
  parseHostFrame,
  parseHostReadyMessage,
  readHostDescriptor,
  removeHostDescriptor,
  requireHostId,
  validateSpawnOptions,
  writeHostDescriptor,
  type HostFrame,
  type HostTuning,
  type LocalHostSpawnOptions,
  type LocalHostStatus
} from './local-host-protocol'

export type { LocalHostSpawnOptions, LocalHostStatus }

/** 主进程可用的 safeStorage 子集（测试注入替身，避免真的走 OS 密钥环）。 */
export interface LocalHostSecureStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** 宿主进程句柄：只暴露客户端真正需要的能力，便于测试替换成进程内宿主。 */
export interface LaunchedHostProcess {
  readonly pid: number | undefined
  send(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (code: number | null) => void): () => void
  onError(listener: (error: Error) => void): () => void
  disconnect(): void
  unref(): void
}

export interface LocalHostLauncherContext {
  /** 编译后的 localHostWorker.js 绝对路径。 */
  scriptPath: string
  env: NodeJS.ProcessEnv
}

/**
 * 依赖注入点（仅测试与诊断使用）。
 * 生产路径全部用默认实现；测试用它替换「拉起进程」和「安全存储」。
 */
export interface LocalHostClientDeps {
  workerScriptPath?: string
  launchWorker?: (context: LocalHostLauncherContext) => LaunchedHostProcess
  secureStorage?: LocalHostSecureStorage
  tuning?: Partial<HostTuning>
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  bootstrapTimeoutMs?: number
  rpcTimeoutMs?: number
  terminateTimeoutMs?: number
  heartbeatDeadMs?: number
  now?: () => number
}

let injectedDeps: LocalHostClientDeps = {}

/**
 * 设置注入依赖（传 null 复位）。仅供测试/诊断使用：不要在生产代码里改。
 * 这是相对固定 API 的**扩展**，不改变任何固定签名，已在 host-report.md 说明。
 */
export function setLocalHostClientDeps(deps: LocalHostClientDeps | null): void {
  injectedDeps = deps ?? {}
}

interface PendingRpc {
  resolve(frame: HostFrame): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface HelloWaiter {
  resolve(frame: HostFrame): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

type BlockingEvent = 'data' | 'exit' | 'disconnect'

interface OutboxEntry {
  event: BlockingEvent
  payload: unknown
}

/** 客户端事件（除固定四种外，gap 为扩展：输出已被回收时的缺失区间）。 */
export interface LocalHostClientEventMap {
  data: string
  exit: { exitCode: number }
  error: Error
  disconnect: undefined
  gap: { from: number; to: number }
}

const DEFAULT_RPC_TIMEOUT_MS = 5000
const MAX_PENDING_ERRORS = 8

/**
 * 一台独立宿主的客户端。
 *
 * 一个 hostId 同时只允许一个活动客户端：第二个 attach 会被宿主以 busy 拒绝
 * （host-busy），绝不静默接管他人的 PTY。
 */
export class LocalHostClient extends EventEmitter {
  readonly id: string

  private readonly userDataDir: string
  private readonly pipe: string
  private readonly token: string
  private readonly deps: LocalHostClientDeps
  private readonly clientId = randomUUID()

  private socket: Socket | null = null
  private decoder: FrameDecoder | null = null
  private helloWaiter: HelloWaiter | null = null
  private readonly pending = new Map<string, PendingRpc>()
  private readonly outbox: OutboxEntry[] = []
  private readonly pendingErrors: Error[] = []

  private cursor = 0
  private snapshot: LocalHostStatus
  private seq = 0
  private exitEmitted = false
  private exitCode: number | undefined
  private disposed = false
  private watchdog: NodeJS.Timeout | null = null
  private lastFrameAt = 0
  private pumping = false

  private constructor(params: {
    id: string
    userDataDir: string
    pipe: string
    token: string
    status: LocalHostStatus
    deps: LocalHostClientDeps
  }) {
    super()
    this.id = params.id
    this.userDataDir = params.userDataDir
    this.pipe = params.pipe
    this.token = params.token
    this.snapshot = params.status
    this.deps = params.deps
    // 监听器晚到时把已排队的输出/退出补发出去（attach 的同步返回不丢首屏）
    this.on('newListener', (event: string | symbol) => {
      if (event === 'data' || event === 'exit' || event === 'disconnect' || event === 'error') {
        queueMicrotask(() => this.pump())
      }
    })
  }

  // ── 构造入口 ────────────────────────────────────────────────────────────

  /**
   * 拉起一台全新宿主并附着。
   * 启动失败/超时保留未知结果：先探测管道，探测到宿主才接管，绝不重复 spawn。
   */
  static async create(userDataDir: string, options: LocalHostSpawnOptions): Promise<LocalHostClient> {
    const deps = resolveDeps()
    const storage = resolveSecureStorage(deps)
    if (!storage) {
      throw new LocalHostError(
        'secure-storage-unavailable',
        'OS secure storage is unavailable; refusing to start a local PTY host whose token could not be protected'
      )
    }
    const dir = requireUserDataDir(userDataDir)
    const spawnOptions = validateSpawnOptions(options)
    const id = newHostId()
    const token = newHostToken()
    const pipe = hostPipePath(dir, id)
    const scriptPath = deps.workerScriptPath ?? defaultWorkerScriptPath()
    if (!existsSync(scriptPath)) {
      throw new LocalHostError('worker-script-missing', `compiled host worker is missing: ${scriptPath}`)
    }

    const launcher = deps.launchWorker ?? launchElectronWorker
    let child: LaunchedHostProcess
    try {
      child = launcher({ scriptPath, env: process.env })
    } catch (error) {
      throw new LocalHostError('spawn-failed', 'failed to spawn the local PTY host', { cause: error })
    }

    const ready = await waitForReady(child, {
      message: {
        kind: 'bootstrap',
        v: LOCAL_HOST_PROTOCOL_VERSION,
        id,
        token,
        pipe,
        spawn: spawnOptions,
        tuning: { ...DEFAULT_HOST_TUNING, ...(deps.tuning ?? {}) },
        // 宿主退出时据此清理自己的描述文件（协议扩展，见 host-report.md）
        userDataDir: dir
      },
      timeoutMs: deps.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS
    })

    // 父进程这一侧也要放开 IPC：宿主已经 ready，不该再被主进程的事件循环拖住
    releaseChild(child)

    const client = new LocalHostClient({
      id,
      userDataDir: dir,
      pipe,
      token,
      status: { id, running: true, retained: false },
      deps
    })

    let status: LocalHostStatus
    try {
      const hello = await client.connectAndHello('attach', 0, true)
      status = hello.status
    } catch (error) {
      client.dispose()
      throw error
    }
    if (!client.exitEmitted) client.snapshot = status

    // 描述文件只在确认宿主可用后写：不留指向死管道的记录
    const pid = ready.pid ?? child.pid
    if (!pid) {
      client.dispose()
      throw new LocalHostError('bootstrap-failed', 'host worker did not report a usable pid')
    }
    try {
      writeHostDescriptor(dir, {
        version: HOST_DESCRIPTOR_VERSION,
        id,
        pipe,
        pid,
        encryptedToken: encryptToken(storage, token)
      })
    } catch (error) {
      // 没有恢复凭据就不能把无人可找回的连接一直留在宿主上。
      client.dispose()
      throw error
    }
    return client
  }

  /** 只凭 hostId 找回已存在的宿主。找不到/密文解不开就明确失败。 */
  static async attach(userDataDir: string, id: string): Promise<LocalHostClient> {
    const deps = resolveDeps()
    const dir = requireUserDataDir(userDataDir)
    const hostId = requireHostId(id)
    const descriptor = readHostDescriptor(dir, hostId)
    if (!descriptor) {
      throw new LocalHostError('descriptor-missing', `no local PTY host ${hostId} is recorded`)
    }
    const storage = resolveSecureStorage(deps)
    if (!storage) {
      throw new LocalHostError('secure-storage-unavailable', 'OS secure storage is unavailable; cannot unlock the host token')
    }
    const token = decryptToken(storage, descriptor.encryptedToken)
    const client = new LocalHostClient({
      id: hostId,
      userDataDir: dir,
      pipe: descriptor.pipe,
      token,
      status: { id: hostId, running: true, retained: false },
      deps
    })
    try {
      const hello = await client.connectAndHello('attach', 0, true)
      if (!client.exitEmitted) client.snapshot = hello.status
      return client
    } catch (error) {
      client.dispose()
      throw error
    }
  }

  /**
   * 只读探测：返回 null 表示没有这台宿主的记录；
   * 记录存在但连不上**抛错**（不假装「进程已结束」，调用方据此不退化新建）。
   */
  static async probe(userDataDir: string, id: string): Promise<LocalHostStatus | null> {
    // 明确不是宿主 id 的字符串不当作宿主：直接视为没有记录
    if (!isHostId(id)) return null
    const deps = resolveDeps()
    const dir = requireUserDataDir(userDataDir)
    const descriptor = readHostDescriptor(dir, id)
    if (!descriptor) return null
    const storage = resolveSecureStorage(deps)
    if (!storage) {
      throw new LocalHostError('secure-storage-unavailable', 'OS secure storage is unavailable; cannot unlock the host token')
    }
    const token = decryptToken(storage, descriptor.encryptedToken)
    const client = new LocalHostClient({
      id,
      userDataDir: dir,
      pipe: descriptor.pipe,
      token,
      status: { id, running: true, retained: false },
      deps
    })
    try {
      const hello = await client.connectAndHello('probe', 0, false)
      return hello.status
    } finally {
      client.dispose()
    }
  }

  // ── 对外操作 ────────────────────────────────────────────────────────────

  /** 显式发送输入。断线后不缓存、不重放：连不上就是没发出去。 */
  write(text: string): void {
    if (typeof text !== 'string' || text.length === 0) return
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + MAX_INPUT_CHARS, text.length)
      // PTY 每次 write 各自转 UTF-8，不能在帧边界劈开 emoji 等代理对。
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
      const chunk = text.slice(offset, end)
      this.trySend({ type: 'input', reqId: this.nextReqId(), data: chunk })
      offset = end
    }
  }

  resize(cols: number, rows: number): void {
    if (!isDimension(cols) || !isDimension(rows)) return
    this.trySend({ type: 'resize', reqId: this.nextReqId(), cols, rows })
  }

  /** 暂停下发（宿主侧背压，仍继续排空 PTY，不会丢数据）。 */
  pause(): void {
    this.trySend({ type: 'pause' })
  }

  resume(): void {
    this.trySend({ type: 'resume' })
  }

  /** retained 只有在宿主 ack 之后才生效（ack 里带落地后的状态）。 */
  async retain(value: boolean): Promise<void> {
    const frame = await this.rpc((reqId) => ({ type: 'retain', reqId, value }), this.rpcTimeoutMs)
    if (frame.type === 'ack' && frame.ok) {
      this.snapshot = frame.status ?? { ...this.snapshot, retained: value }
    }
  }

  /** 仅放开连接，PTY 交给宿主的宽限期（≠ terminate）。 */
  async detach(): Promise<void> {
    if (this.disposed) return
    try {
      if (this.socket?.writable) {
        await this.rpc((reqId) => ({ type: 'detach', reqId }), this.rpcTimeoutMs)
      }
    } catch {
      // 断开本身一定生效（下面会关 socket）；ack 拿不到只说明宿主已经走了
    } finally {
      this.dispose()
    }
  }

  /** 真杀 PTY：必须有真实退出证据，拿不到证据就报错，绝不宣布成功。 */
  async terminate(): Promise<void> {
    if (this.disposed) {
      if (this.snapshot.running) {
        throw new LocalHostError('disconnected', 'cannot terminate: the local PTY host is not connected')
      }
      return
    }
    const frame = await this.rpc(
      (reqId) => ({ type: 'terminate', reqId }),
      this.terminateTimeoutMs + 1000
    )
    if (frame.type !== 'ack' || !frame.ok) {
      throw new LocalHostError('terminate-failed', 'the local PTY host did not confirm the termination')
    }
    const exitCode = typeof frame.exitCode === 'number' ? frame.exitCode : this.exitCode
    if (typeof exitCode !== 'number') {
      throw new LocalHostError('terminate-failed', 'the local PTY host did not report an exit code')
    }
    this.markExit(exitCode)
    this.dispose()
    // 宿主的 exit retention 到期后也会删；这里立刻清掉，避免残留指向死管道的记录
    removeHostDescriptor(this.userDataDir, this.id)
  }

  /**
   * 状态快照。连着宿主时以宿主回复为准（退出后的 exitCode 只有宿主知道）；
   * 已确认退出可返回终态；否则失联必须报未知，不能把旧快照当成在线证据。
   */
  async status(): Promise<LocalHostStatus> {
    if (!this.disposed && this.socket?.writable) {
      const frame = await this.rpc((reqId) => ({ type: 'status', reqId }), this.rpcTimeoutMs)
      if (frame.type === 'status') {
        this.snapshot = frame.status
        return frame.status
      }
    }
    if (!this.snapshot.running) return this.snapshot
    throw new LocalHostError('disconnected', 'the local PTY host state is unknown until it can be reached again')
  }

  // ── 握手 ────────────────────────────────────────────────────────────────

  private async connectAndHello(
    mode: 'attach' | 'probe',
    cursor: number,
    replay: boolean
  ): Promise<{ status: LocalHostStatus; cursor: number }> {
    const socket = await connectPipe(this.pipe, this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
    this.installSocket(socket)

    const settled = new Promise<HostFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null
        reject(new LocalHostError('rpc-timeout', 'the local PTY host did not answer the handshake in time'))
      }, this.deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)
      timer.unref?.()
      this.helloWaiter = { resolve, reject, timer }
    })

    try {
      socket.write(
        encodeClientFrame({
          type: 'hello',
          hostId: this.id,
          token: this.token,
          clientId: this.clientId,
          mode,
          cursor,
          replay
        })
      )
    } catch (error) {
      this.failHello(new LocalHostError('host-unreachable', 'failed to send the handshake', { cause: error }))
    }

    const frame = await settled
    if (frame.type === 'welcome') {
      this.cursor = Math.max(this.cursor, frame.cursor)
      this.startWatchdog()
      return { status: frame.status, cursor: frame.cursor }
    }
    if (frame.type === 'probe') {
      // probe 连接用完即弃：宿主自己也会 end，这里只保证本地资源不悬空
      return { status: frame.status, cursor: 0 }
    }
    throw new LocalHostError('protocol-error', 'unexpected handshake reply from the local PTY host')
  }

  private settleHello(frame: HostFrame): void {
    const waiter = this.helloWaiter
    if (!waiter) return
    this.helloWaiter = null
    clearTimeout(waiter.timer)
    waiter.resolve(frame)
  }

  private failHello(error: Error): void {
    const waiter = this.helloWaiter
    if (!waiter) return
    this.helloWaiter = null
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  // ── socket / 帧 ─────────────────────────────────────────────────────────

  private installSocket(socket: Socket): void {
    this.socket = socket
    this.decoder = new FrameDecoder()
    this.lastFrameAt = this.now()

    socket.on('data', (chunk: Buffer) => {
      const decoder = this.decoder
      if (!decoder || this.disposed) return
      let frames: unknown[]
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        this.pushError(error instanceof Error ? error : new LocalHostError('protocol-error', 'invalid frame'))
        this.destroySocket()
        return
      }
      for (const raw of frames) {
        if (this.disposed) return
        this.handleFrame(raw)
      }
    })

    socket.on('error', (error: NodeJS.ErrnoException) => {
      // 断链统一由 close 收尾；这里只记录原因
      this.pushError(new LocalHostError('disconnected', `local PTY host connection failed: ${error.message}`, { cause: error }))
    })

    socket.on('close', () => {
      this.socket = null
      this.decoder = null
      this.stopWatchdog()
      this.failHello(new LocalHostError('disconnected', 'the local PTY host closed the connection during the handshake'))
      this.rejectPending(new LocalHostError('disconnected', 'the local PTY host connection was closed'))
      if (!this.disposed) this.push({ event: 'disconnect', payload: undefined })
    })
  }

  private handleFrame(raw: unknown): void {
    this.lastFrameAt = this.now()
    let frame: HostFrame
    try {
      frame = parseHostFrame(raw)
    } catch (error) {
      this.pushError(error instanceof Error ? error : new LocalHostError('protocol-error', 'invalid host frame'))
      this.destroySocket()
      return
    }
    if (frame.hostId !== this.id) {
      this.pushError(new LocalHostError('host-mismatch', 'received a frame from a different local PTY host'))
      this.destroySocket()
      return
    }

    switch (frame.type) {
      case 'welcome':
      case 'probe':
        this.settleHello(frame)
        return
      case 'busy':
        this.failHello(new LocalHostError('host-busy', 'another client is already attached to this local PTY host'))
        return
      case 'heartbeat':
        return
      case 'data': {
        if (frame.start > this.cursor) {
          // 宿主应发 gap；收到跳空的数据帧时也如实报告缺失区间
          this.pushGap(this.cursor, frame.start)
        } else if (frame.start < this.cursor) {
          const skip = this.cursor - frame.start
          if (skip >= frame.data.length) return
          frame = { ...frame, start: this.cursor, data: frame.data.slice(skip) }
        }
        if (frame.data.length === 0) return
        this.cursor = frame.start + frame.data.length
        this.push({ event: 'data', payload: frame.data })
        return
      }
      case 'gap':
        this.cursor = frame.to
        this.pushGap(frame.from, frame.to)
        return
      case 'exit':
        this.markExit(frame.exitCode)
        return
      case 'ack':
      case 'status':
        this.settlePending(frame)
        return
      case 'error': {
        const error = new LocalHostError(
          isLocalHostErrorCode(frame.code) ? frame.code : 'protocol-error',
          frame.message || 'the local PTY host reported an error'
        )
        this.pushError(error)
        if (frame.fatal) {
          this.failHello(error)
          this.destroySocket()
        }
        return
      }
      default:
        return
    }
  }

  private settlePending(frame: HostFrame): void {
    if (frame.type !== 'ack' && frame.type !== 'status') return
    const pending = this.pending.get(frame.reqId)
    if (!pending) return
    this.pending.delete(frame.reqId)
    clearTimeout(pending.timer)
    if (frame.type === 'ack' && !frame.ok) {
      const code = isLocalHostErrorCode(frame.code) ? frame.code : 'protocol-error'
      pending.reject(new LocalHostError(code, frame.message || 'the local PTY host rejected the request'))
      return
    }
    pending.resolve(frame)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  // ── 请求 ────────────────────────────────────────────────────────────────

  private nextReqId(): string {
    this.seq += 1
    return `${this.clientId.slice(0, 8)}-${this.seq}`
  }

  private trySend(payload: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket || !socket.writable || this.disposed) return false
    try {
      socket.write(encodeClientFrame(payload))
      return true
    } catch {
      return false
    }
  }

  private rpc(build: (reqId: string) => Record<string, unknown>, timeoutMs: number): Promise<HostFrame> {
    const reqId = this.nextReqId()
    const frame = build(reqId)
    return new Promise<HostFrame>((resolve, reject) => {
      if (this.disposed || !this.socket?.writable) {
        reject(new LocalHostError('disconnected', 'the local PTY host is not connected'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new LocalHostError('rpc-timeout', `the local PTY host did not answer ${String(frame.type)} in ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(reqId, { resolve, reject, timer })
      if (!this.trySend(frame)) {
        this.pending.delete(reqId)
        clearTimeout(timer)
        reject(new LocalHostError('disconnected', 'the local PTY host connection is not writable'))
      }
    })
  }

  // ── 退出 / 事件派发 ─────────────────────────────────────────────────────

  private markExit(exitCode: number): void {
    if (this.exitEmitted) return
    this.exitEmitted = true
    this.exitCode = exitCode
    this.snapshot = { ...this.snapshot, running: false, exitCode }
    this.stopWatchdog()
    this.push({ event: 'exit', payload: { exitCode } })
  }

  private push(entry: OutboxEntry): void {
    this.outbox.push(entry)
    this.pump()
  }

  /** gap 是提示性事件：没有监听者就丢掉，绝不阻塞后续输出。 */
  private pushGap(from: number, to: number): void {
    if (this.listenerCount('gap') === 0) return
    this.emit('gap', { from, to })
  }

  private pushError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
      return
    }
    if (this.pendingErrors.length >= MAX_PENDING_ERRORS) this.pendingErrors.shift()
    this.pendingErrors.push(error)
  }

  /**
   * 只把调用方已经装好监听的事件派发出去：attach() 同步返回之后的第一帧输出
   * 不会因为「还没 on('data')」而丢掉，顺序也不会被打乱。
   */
  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.outbox.length > 0) {
        const head = this.outbox[0]
        if (this.listenerCount(head.event) === 0) return
        this.outbox.shift()
        this.emit(head.event, head.payload)
      }
      if (this.pendingErrors.length > 0 && this.listenerCount('error') > 0) {
        for (const error of this.pendingErrors.splice(0)) this.emit('error', error)
      }
    } finally {
      this.pumping = false
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    const dead = this.deps.heartbeatDeadMs ?? DEFAULT_HEARTBEAT_DEAD_MS
    if (dead <= 0) return
    const interval = Math.max(1000, Math.min(dead, 15_000))
    this.watchdog = setInterval(() => {
      if (this.disposed) return
      if (this.now() - this.lastFrameAt <= dead) return
      this.pushError(new LocalHostError('disconnected', 'the local PTY host stopped sending heartbeats'))
      this.destroySocket()
    }, interval)
    this.watchdog.unref?.()
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
  }

  private destroySocket(): void {
    const socket = this.socket
    if (!socket) return
    try {
      socket.destroy()
    } catch {
      // 已经断了
    }
  }

  /** 关掉本地资源但不触发 disconnect 事件（调用方主动 detach/terminate 时用）。 */
  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopWatchdog()
    this.failHello(new LocalHostError('disconnected', 'the local PTY host client was closed'))
    this.rejectPending(new LocalHostError('disconnected', 'the local PTY host client was closed'))
    const socket = this.socket
    this.socket = null
    this.decoder = null
    if (socket) {
      try {
        socket.destroy()
      } catch {
        // 已关闭
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get rpcTimeoutMs(): number {
    return this.deps.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
  }

  private get terminateTimeoutMs(): number {
    return this.deps.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS
  }
}

// ── 依赖解析 ──────────────────────────────────────────────────────────────────

function resolveDeps(): LocalHostClientDeps {
  return injectedDeps
}

function defaultWorkerScriptPath(): string {
  // 主进程 bundle 与 localHostWorker.js 同在 dist/main
  return join(__dirname, 'localHostWorker.js')
}

function resolveSecureStorage(deps: LocalHostClientDeps): LocalHostSecureStorage | null {
  const candidate: Partial<LocalHostSecureStorage> | undefined =
    deps.secureStorage ?? (safeStorage as unknown as Partial<LocalHostSecureStorage> | undefined)
  if (
    !candidate ||
    typeof candidate.isEncryptionAvailable !== 'function' ||
    typeof candidate.encryptString !== 'function' ||
    typeof candidate.decryptString !== 'function'
  ) {
    return null
  }
  try {
    return candidate.isEncryptionAvailable() ? (candidate as LocalHostSecureStorage) : null
  } catch {
    // isEncryptionAvailable 在无密钥环的 Linux/headless 上可能抛
    return null
  }
}

function encryptToken(storage: LocalHostSecureStorage, token: string): string {
  try {
    return storage.encryptString(token).toString('base64')
  } catch (error) {
    throw new LocalHostError('secure-storage-unavailable', 'failed to encrypt the host token', { cause: error })
  }
}

function decryptToken(storage: LocalHostSecureStorage, encryptedToken: string): string {
  try {
    return storage.decryptString(Buffer.from(encryptedToken, 'base64'))
  } catch (error) {
    throw new LocalHostError('descriptor-invalid', 'failed to decrypt the host token', { cause: error })
  }
}

function requireUserDataDir(userDataDir: string): string {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0 || !isAbsolute(userDataDir)) {
    throw new LocalHostError('descriptor-invalid', 'userDataDir must be an absolute path')
  }
  return userDataDir
}

function isDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_TERM_DIMENSION && value <= MAX_TERM_DIMENSION
}

// ── 子进程 ────────────────────────────────────────────────────────────────────

const HOST_WORKER_ENV = 'ELECTRON_RUN_AS_NODE'

function launchElectronWorker(context: LocalHostLauncherContext): LaunchedHostProcess {
  const env: NodeJS.ProcessEnv = { ...context.env, [HOST_WORKER_ENV]: '1' }
  const child: ChildProcess = spawn(process.execPath, [context.scriptPath], {
    env,
    // detached：宿主不跟随主进程退出；windowsHide：不弹控制台窗口
    detached: true,
    windowsHide: true,
    // 不继承父进程 stdio：宿主永远不往主进程的 stdout/stderr 写东西
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  return {
    get pid(): number | undefined {
      return child.pid
    },
    send: (message: unknown): void => {
      const send = child.send as unknown as (value: unknown) => boolean
      if (typeof send !== 'function') throw new LocalHostError('bootstrap-failed', 'host worker has no IPC channel')
      send.call(child, message)
    },
    onMessage: (listener) => {
      const handler = (message: unknown): void => listener(message)
      child.on('message', handler)
      return () => child.off('message', handler)
    },
    onExit: (listener) => {
      const handler = (code: number | null): void => listener(code)
      child.once('exit', handler)
      return () => child.off('exit', handler)
    },
    onError: (listener) => {
      const handler = (error: Error): void => listener(error)
      child.once('error', handler)
      return () => child.off('error', handler)
    },
    disconnect: (): void => {
      try {
        child.disconnect()
      } catch {
        // 通道可能已经因为子进程退出而关闭
      }
    },
    unref: (): void => {
      try {
        child.unref()
      } catch {
        // 已退出
      }
    }
  }
}

/** ready 之后主动放开 IPC 通道 + unref，宿主从此完全独立（不 kill、不等待）。 */
function releaseChild(child: LaunchedHostProcess): void {
  try {
    child.disconnect()
  } catch {
    // 通道已关
  }
  try {
    child.unref()
  } catch {
    // 已退出
  }
}

interface WaitForReadyOptions {
  message: Record<string, unknown>
  timeoutMs: number
}

/**
 * 下发 bootstrap 并等 ready。
 *
 * 超时/启动失败的处理原则：**保留未知结果**。不重复 spawn、不按 pid kill，
 * 只把错误抛给调用方，由调用方用 probe() 判定宿主是否其实已经起来了
 * （宿主在无人 attach 时会按宽限期自行退出）。
 */
function waitForReady(child: LaunchedHostProcess, options: WaitForReadyOptions): Promise<{ id: string; pid: number; pipe: string }> {
  const expectedId = options.message.id
  return new Promise((resolve, reject) => {
    let settled = false
    let offMessage: (() => void) | null = null
    let offExit: (() => void) | null = null
    let offError: (() => void) | null = null

    const finish = (error: Error | null, value?: { id: string; pid: number; pipe: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      offMessage?.()
      offExit?.()
      offError?.()
      // 无论成败都不再持有 IPC：失败时宿主会自己按宽限期收尾
      try {
        child.disconnect()
      } catch {
        // 通道已关
      }
      try {
        child.unref()
      } catch {
        // 已退出
      }
      if (error) reject(error)
      else if (value) resolve(value)
    }

    const timer = setTimeout(() => {
      finish(
        new LocalHostError(
          'bootstrap-timeout',
          'the local PTY host did not report ready in time; its state is kept unknown and must be probed before any retry'
        )
      )
    }, options.timeoutMs)
    timer.unref?.()

    offMessage = child.onMessage((message) => {
      if (typeof message !== 'object' || message === null) return
      if ((message as { kind?: unknown }).kind !== 'ready') return
      try {
        const ready = parseHostReadyMessage(message, typeof expectedId === 'string' ? expectedId : undefined)
        if (ready.pipe !== options.message.pipe) {
          throw new LocalHostError('protocol-error', 'host worker reported an unexpected pipe')
        }
        finish(null, { id: ready.id, pid: ready.pid, pipe: ready.pipe })
      } catch (error) {
        finish(error instanceof Error ? error : new LocalHostError('bootstrap-failed', 'invalid ready message'))
      }
    })
    offExit = child.onExit((code) => {
      finish(new LocalHostError('worker-exited', `the local PTY host exited during bootstrap (code ${String(code)})`))
    })
    offError = child.onError((error) => {
      finish(new LocalHostError('spawn-failed', 'failed to spawn the local PTY host', { cause: error }))
    })

    try {
      child.send(options.message)
    } catch (error) {
      finish(new LocalHostError('bootstrap-failed', 'failed to send the bootstrap message', { cause: error }))
    }
  })
}

// ── 管道连接 ──────────────────────────────────────────────────────────────────

function connectPipe(pipe: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let socket: Socket
    try {
      socket = connect(pipe)
    } catch (error) {
      reject(new LocalHostError('host-unreachable', 'cannot open the local PTY host pipe', { cause: error }))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new LocalHostError('host-unreachable', 'timed out connecting to the local PTY host'))
    }, timeoutMs)
    timer.unref?.()
    const done = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        socket.destroy()
        reject(error)
        return
      }
      resolve(socket)
    }
    socket.once('connect', () => done())
    // 连上之后的 error 由 installSocket 处理；这里只兜住连接阶段
    socket.once('error', (error: Error) => {
      done(new LocalHostError('host-unreachable', `cannot reach the local PTY host: ${error.message}`, { cause: error }))
    })
  })
}
