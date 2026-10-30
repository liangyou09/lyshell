/**
 * 本地 PTY 独立宿主（worker 入口 + 宿主服务端）
 *
 * 由 Electron 主进程以 `spawn(process.execPath, [localHostWorker.js])` +
 * `ELECTRON_RUN_AS_NODE=1` + `detached: true` 启动，bootstrap 配置（真实 shell/args/
 * cwd/env/尺寸、token、pipe 地址、调参）经**父进程 IPC** 下发，绝不走命令行。
 *
 * 生命周期：
 *   1. 读 bootstrap（超时即退出，避免孤儿）
 *   2. 在随机 named pipe / profile 目录 Unix socket 上监听（不监听公网）
 *   3. 监听成功后再启动 PTY，然后回 ready，并主动断开父进程 IPC
 *   4. 无客户端时按宽限期终止，收纳任务也不跨应用退出保活
 *   5. PTY 退出后保留状态一段时间，再释放描述文件 / socket 并退出
 *
 * 本文件不依赖 Electron app API，只加载 Node 内置模块 + 原生 node-pty（延迟加载，
 * 便于测试注入 mock PTY）。token 只在内存中比较，不写日志、不回显。
 */

import { mkdirSync, unlinkSync } from 'fs'
import { createServer } from 'net'
import type { Server, Socket } from 'net'
import { dirname } from 'path'
import type { IPty } from 'node-pty'
import {
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  FrameDecoder,
  LOCAL_HOST_PROTOCOL_VERSION,
  LOCAL_HOST_REQUIRED_CAPABILITIES,
  LocalHostError,
  LocalHostRingBuffer,
  MAX_SOCKET_PENDING_BYTES,
  encodeFrame,
  isRecord,
  parseClientFrame,
  parseHostBootstrapMessage,
  removeHostDescriptor,
  tokensMatch,
  type ClientFrame,
  type ClientHelloFrame,
  type HostBootstrapConfig,
  type LocalHostStatus
} from './local-host-protocol'
import {
  checkFenceInstall,
  checkInputFence,
  nextFenceFloor,
  type FenceFloor,
  type InputFence
} from '@shared/terminal-control'

// ── PTY 抽象（生产用 node-pty，测试注入 mock）───────────────────────────────

export interface HostPtySpawnOptions {
  shell: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  cols: number
  rows: number
  name: string
}

/** 只暴露宿主真正需要的 PTY 能力；node-pty 的 IPty 结构上满足该接口。 */
export interface HostPty {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
}

export type HostPtyFactory = (options: HostPtySpawnOptions) => HostPty

/** 崩溃兜底：宿主进程异常时要带走自己的 PTY，别留后台孤儿。 */
let crashGuardPty: HostPty | null = null

function installCrashGuard(): void {
  const bail = (): void => {
    try {
      crashGuardPty?.kill()
    } catch {
      // PTY 可能已经退出
    }
    crashGuardPty = null
    process.exit(1)
  }
  process.on('uncaughtException', bail)
  process.on('unhandledRejection', bail)
}

// ── 服务端句柄 ────────────────────────────────────────────────────────────────

export interface StartHostServerOptions {
  config: HostBootstrapConfig
  ptyFactory: HostPtyFactory
  /** 收尾完成（PTY 已退出 / 服务端已关闭 / 描述文件已释放）时回调一次。 */
  onFinished?: () => void
  /** 可注入时钟（测试用），默认 Date.now。 */
  now?: () => number
}

export interface LocalHostServerHandle {
  readonly id: string
  readonly pipe: string
  /** 当前状态快照（本地视角，不依赖客户端）。 */
  status(): LocalHostStatus
  /** 收到 ready 后宿主进程的 pid。 */
  readonly pid: number
  /** 收尾完成。 */
  readonly finished: Promise<void>
  /** 强制收尾：终止 PTY（若仍在跑）并释放服务端资源。 */
  shutdown(): Promise<void>
}

interface ClientConn {
  socket: Socket
  decoder: FrameDecoder
  /** hello 鉴权通过并成为唯一活动客户端。 */
  attached: boolean
  paused: boolean
  /** 下一个要下发给该客户端的输出序号。 */
  sent: number
  /** 本连接的握手超时（每连接独立，连上不 hello 不能长期占位）。 */
  handshakeTimer: NodeJS.Timeout | null
}

interface TerminateWaiter {
  conn: ClientConn
  reqId: string
}

/** 有界请求去重：重连重发同一 reqId 不会二次写 PTY / 二次改状态。 */
export class BoundedRequestCache {
  private readonly order: string[] = []
  private readonly seen = new Set<string>()

  constructor(private readonly limit = 256) {}

  /** 首次出现返回 true；重复返回 false。 */
  accept(reqId: string): boolean {
    if (this.seen.has(reqId)) return false
    this.seen.add(reqId)
    this.order.push(reqId)
    while (this.order.length > this.limit) {
      const dropped = this.order.shift()
      if (dropped === undefined) break
      this.seen.delete(dropped)
    }
    return true
  }

  get size(): number {
    return this.seen.size
  }
}

/**
 * 启动宿主服务端（监听 + 拉起 PTY）。监听失败不会启动 PTY。
 * 该函数不修改 process 全局状态，便于测试在同一进程内起多个宿主。
 */
export async function startHostServer(options: StartHostServerOptions): Promise<LocalHostServerHandle> {
  const { config, ptyFactory } = options
  const { id, token, pipe, spawn, tuning } = config
  const now = options.now ?? Date.now
  const ring = new LocalHostRingBuffer({
    maxBytes: tuning.bufferBytes,
    maxBlocks: tuning.bufferBlocks,
    maxBlockChars: tuning.maxBlockChars
  })
  const requestCache = new BoundedRequestCache(256)
  const attachedSockets = new Set<Socket>()
  /** 宿主声明自己具备的能力；客户端握手时会校验必需项。 */
  const hostCapabilities = [...LOCAL_HOST_REQUIRED_CAPABILITIES]

  let pty: HostPty | null = null
  let running = true
  let childExitCode: number | undefined
  let retained = false
  let currentCols = spawn.cols
  let currentRows = spawn.rows
  let terminating = false
  let finished = false
  let active: ClientConn | null = null

  /**
   * 宿主侧输入围栏状态：唯一权威地决定「这次写入能不能落到 PTY」。
   * 只由已附着客户端的 `input-fence` RPC 改写；断线/收尾一律清空并推进下限。
   */
  let activeFence: InputFence | null = null
  let fenceFloor: FenceFloor | null = null

  let graceTimer: NodeJS.Timeout | null = null
  let exitTimer: NodeJS.Timeout | null = null
  let terminateTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null

  let resolveFinished: () => void = () => {}
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve
  })

  const waiters: TerminateWaiter[] = []

  // ── 帧下发 ──────────────────────────────────────────────────────────────

  const writeFrame = (conn: ClientConn, payload: Record<string, unknown>): void => {
    if (!conn.socket.writable) return
    try {
      conn.socket.write(encodeHostFrame(id, payload))
    } catch {
      // 断链会走 close 分支，这里不重复处理
    }
  }

  const ackOk = (conn: ClientConn, reqId: string, extra: { exitCode?: number; status?: LocalHostStatus } = {}): void => {
    writeFrame(conn, {
      type: 'ack',
      reqId,
      ok: true,
      ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      ...(extra.status ? { status: extra.status } : {})
    })
  }

  const ackError = (conn: ClientConn, reqId: string, code: string, message: string): void => {
    writeFrame(conn, { type: 'ack', reqId, ok: false, code, message })
  }

  const statusSnapshot = (): LocalHostStatus =>
    running
      ? { id, running: true, retained }
      : { id, running: false, retained, ...(childExitCode !== undefined ? { exitCode: childExitCode } : {}) }

  // ── 输出下发（含 gap）────────────────────────────────────────────────────

  const flush = (conn: ClientConn): void => {
    if (!conn.attached || conn.paused || finished) return
    while (pendingBytes(conn.socket) < MAX_SOCKET_PENDING_BYTES) {
      if (!conn.socket.writable) return
      const gap = ring.gapFrom(conn.sent)
      if (gap) {
        writeFrame(conn, { type: 'gap', from: gap.from, to: gap.to })
        conn.sent = gap.to
        continue
      }
      const block = ring.firstFrom(conn.sent)
      if (!block) return
      writeFrame(conn, { type: 'data', start: block.seq, data: block.data })
      conn.sent = block.seq + block.data.length
    }
  }

  // ── 定时器 ──────────────────────────────────────────────────────────────

  const clearGrace = (): void => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  const clearExitRetention = (): void => {
    if (exitTimer) {
      clearTimeout(exitTimer)
      exitTimer = null
    }
  }

  const clearHandshake = (conn: ClientConn): void => {
    if (conn.handshakeTimer) {
      clearTimeout(conn.handshakeTimer)
      conn.handshakeTimer = null
    }
  }

  const clearTerminateTimer = (): void => {
    if (terminateTimer) {
      clearTimeout(terminateTimer)
      terminateTimer = null
    }
  }

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const startHeartbeat = (): void => {
    stopHeartbeat()
    if (tuning.heartbeatMs <= 0) return
    heartbeatTimer = setInterval(() => {
      if (!active || finished) return
      writeFrame(active, { type: 'heartbeat', at: now() })
    }, tuning.heartbeatMs)
  }

  const clearAllTimers = (): void => {
    clearGrace()
    clearExitRetention()
    clearTerminateTimer()
    stopHeartbeat()
  }

  const scheduleExitRetention = (): void => {
    if (finished || exitTimer) return
    exitTimer = setTimeout(() => {
      exitTimer = null
      void finish()
    }, tuning.exitRetentionMs)
  }

  /** 没有客户端时宽限期后终止 PTY；短暂重连可保留现场，收纳标记不延长应用生命周期。 */
  const scheduleGrace = (): void => {
    if (finished || graceTimer || !running) return
    graceTimer = setTimeout(() => {
      graceTimer = null
      if (finished || !running || active) return
      killPty()
    }, tuning.graceMs)
  }

  const killPty = (): void => {
    if (!running || !pty) return
    try {
      pty.kill()
    } catch {
      // 进程可能已经退出
    }
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────

  const finish = async (): Promise<void> => {
    if (finished) return
    finished = true
    clearInputFence()
    clearAllTimers()
    terminating = false
    crashGuardPty = null
    const conn = active
    active = null
    if (conn) {
      try {
        conn.socket.end()
      } catch {
        // 已断链
      }
    }
    for (const waiter of waiters.splice(0)) {
      ackError(waiter.conn, waiter.reqId, 'closed', 'host is shutting down')
    }
    await closeServer()
    if (process.platform !== 'win32') {
      try {
        unlinkSync(pipe)
      } catch {
        // socket 文件可能已不存在
      }
    }
    // 只删自己 id 对应的描述文件：removeHostDescriptor 会核对文件内容里的 id。
    // userDataDir 由 bootstrap 提供；缺失时不动任何文件（不在猜出来的目录里删东西）。
    if (config.userDataDir) {
      removeHostDescriptor(config.userDataDir, id)
    }
    resolveFinished()
    options.onFinished?.()
  }

  // ── 客户端断开 / 宽限 / 收尾调度 ────────────────────────────────────────

  const onClientLost = (conn: ClientConn): void => {
    if (active !== conn) return
    // 断线即清空围栏：旧 fence 之后既不能写，也不自动续租/重放任何输入。
    clearInputFence()
    active = null
    stopHeartbeat()
    if (finished) return
    if (!running) {
      scheduleExitRetention()
      return
    }
    scheduleGrace()
  }

  // ── PTY 事件 ────────────────────────────────────────────────────────────

  const broadcastExit = (): void => {
    if (!active) return
    writeFrame(active, { type: 'exit', exitCode: childExitCode ?? -1 })
  }

  const onPtyExit = (event: { exitCode: number }): void => {
    if (!running) return
    running = false
    childExitCode = typeof event.exitCode === 'number' && Number.isSafeInteger(event.exitCode) ? event.exitCode : -1
    terminating = false
    clearTerminateTimer()
    stopHeartbeat()
    clearGrace()
    for (const waiter of waiters.splice(0)) ackOk(waiter.conn, waiter.reqId, { exitCode: childExitCode })
    broadcastExit()
    // 没人附着时也要在有限时间内释放宿主进程，不留无限累积的后台资源
    if (!active) scheduleExitRetention()
  }

  // ── 命令处理 ────────────────────────────────────────────────────────────

  const handleHello = (conn: ClientConn, hello: ClientHelloFrame): void => {
    clearHandshake(conn)
    if (!tokensMatch(hello.token, token)) {
      writeFrame(conn, { type: 'error', code: 'unauthorized', message: 'host authentication failed', fatal: true })
      conn.socket.end()
      return
    }
    if (hello.hostId !== id) {
      // token 正确但目标不是本宿主：拒绝，绝不把输出给错宿主
      writeFrame(conn, { type: 'error', code: 'host-mismatch', message: 'host id mismatch', fatal: true })
      conn.socket.end()
      return
    }
    if (hello.mode === 'probe') {
      // probe 只读：不占客户端位、不改 retained、不重放输出
      writeFrame(conn, { type: 'probe', status: statusSnapshot(), capabilities: hostCapabilities })
      conn.socket.end()
      return
    }
    if (finished) {
      writeFrame(conn, { type: 'error', code: 'closed', message: 'host is shutting down', fatal: true })
      conn.socket.end()
      return
    }
    if (active) {
      writeFrame(conn, { type: 'busy' })
      conn.socket.end()
      return
    }
    if (hello.cursor > ring.next) {
      writeFrame(conn, { type: 'error', code: 'cursor-ahead', message: 'cursor is ahead of host output', fatal: true })
      conn.socket.destroy()
      return
    }
    active = conn
    conn.attached = true
    conn.sent = hello.replay ? hello.cursor : ring.next
    clearGrace()
    clearExitRetention()
    writeFrame(conn, { type: 'welcome', status: statusSnapshot(), cursor: conn.sent, capabilities: hostCapabilities })
    flush(conn)
    if (running) startHeartbeat()
    else broadcastExit()
  }

  const handleTerminate = (conn: ClientConn, reqId: string): void => {
    if (!running) {
      ackOk(conn, reqId, { exitCode: childExitCode })
      scheduleExitRetention()
      return
    }
    if (!pty) {
      ackError(conn, reqId, 'terminate-failed', 'PTY is not available')
      return
    }
    waiters.push({ conn, reqId })
    if (terminating) return
    terminating = true
    killPty()
    // 只有真实 onExit 才 ack 成功；超时明确失败，绝不假装已结束
    terminateTimer = setTimeout(() => {
      terminateTimer = null
      if (!running) return
      terminating = false
      for (const waiter of waiters.splice(0)) {
        ackError(waiter.conn, waiter.reqId, 'terminate-timeout', 'PTY did not exit in time')
      }
    }, tuning.terminateTimeoutMs)
    terminateTimer.unref?.()
  }

  // ── 输入围栏 ────────────────────────────────────────────────────────────

  /**
   * 清空围栏并推进代际下限：断开之后旧 fence 既不能继续写，也不能被原样重装，
   * 除非它仍是同一份未过期租约（由 checkFenceInstall 判定，且不延长有效期）。
   * 这里不保留输入队列，也不重放任何历史输入。
   */
  const clearInputFence = (): void => {
    if (activeFence) fenceFloor = nextFenceFloor(activeFence, fenceFloor)
    activeFence = null
  }

  /** 安装/撤销围栏；只有 ack 成功之后新写入才开放。 */
  const handleFenceFrame = (conn: ClientConn, frame: Extract<ClientFrame, { type: 'input-fence' }>): void => {
    if (finished || !running) {
      ackError(conn, frame.reqId, 'fence-rejected', 'PTY is not running')
      return
    }
    if (frame.fence === null) {
      clearInputFence()
      ackOk(conn, frame.reqId)
      return
    }
    const fence = frame.fence
    if (!(now() < fence.expiresAt)) {
      ackError(conn, frame.reqId, 'input-expired', 'input fence is already expired')
      return
    }
    const rejection = checkFenceInstall(activeFence, fenceFloor, fence)
    if (rejection) {
      ackError(conn, frame.reqId, 'fence-rejected', `input fence rejected: ${rejection}`)
      return
    }
    activeFence = fence
    fenceFloor = nextFenceFloor(fence, fenceFloor)
    ackOk(conn, frame.reqId)
  }

  /** 输入落地前最后一道核对：活动连接 + 当前 fence + 有效期，缺一不写。 */
  const handleInputFrame = (conn: ClientConn, frame: Extract<ClientFrame, { type: 'input' }>): void => {
    if (finished || !running || !pty) {
      ackError(conn, frame.reqId, 'input-denied', 'PTY is not running')
      return
    }
    if (active !== conn) {
      ackError(conn, frame.reqId, 'input-denied', 'this connection is not the active host client')
      return
    }
    const rejection = checkInputFence(activeFence, frame.fence, now())
    if (rejection) {
      ackError(
        conn,
        frame.reqId,
        rejection === 'expired' ? 'input-expired' : 'input-denied',
        `input fence rejected: ${rejection}`
      )
      return
    }
    try {
      pty.write(frame.data)
    } catch {
      ackError(conn, frame.reqId, 'input-denied', 'PTY write failed')
      return
    }
    // 每帧都回 ack：调用方能区分「宿主确实写了」与「被围栏拒绝」。
    ackOk(conn, frame.reqId)
  }

  const handleCommand = (conn: ClientConn, frame: ClientFrame): void => {
    switch (frame.type) {
      case 'hello':
        // hello 只允许一次（重复 hello 视作协议错误）
        writeFrame(conn, { type: 'error', code: 'protocol-error', message: 'duplicate hello', fatal: true })
        conn.socket.end()
        return
      case 'input': {
        if (!requestCache.accept(frame.reqId)) return
        handleInputFrame(conn, frame)
        return
      }
      case 'input-fence': {
        if (!requestCache.accept(frame.reqId)) return
        // 围栏安装/撤销必须按到达顺序落地；并发 RPC 由客户端的串行链保证不重叠。
        handleFenceFrame(conn, frame)
        return
      }
      case 'resize': {
        if (!requestCache.accept(frame.reqId)) return
        if (!running) return
        // 无控制者时只允许 bootstrap 尺寸；已安装控制者后，迟到视图尺寸同样受围栏约束。
        if ((activeFence || frame.fence) && checkInputFence(activeFence, frame.fence, now()) !== null) return
        // ConPTY 即使尺寸相同也可能重绘整屏；恢复/重复 fit 不能反复触发重排。
        if (frame.cols === currentCols && frame.rows === currentRows) return
        try {
          pty?.resize(frame.cols, frame.rows)
          currentCols = frame.cols
          currentRows = frame.rows
        } catch {
          // 尺寸变化竞态（进程刚退出）无需上抛
        }
        return
      }
      case 'pause':
        conn.paused = true
        return
      case 'resume':
        conn.paused = false
        flush(conn)
        return
      case 'retain': {
        if (!requestCache.accept(frame.reqId)) return
        retained = frame.value
        // 先落地再 ack：客户端拿到 ack 后才认为 retained 生效
        ackOk(conn, frame.reqId, { status: statusSnapshot() })
        return
      }
      case 'status':
        writeFrame(conn, { type: 'status', reqId: frame.reqId, status: statusSnapshot() })
        return
      case 'detach': {
        if (!requestCache.accept(frame.reqId)) return
        ackOk(conn, frame.reqId)
        // ack 之后客户端可能立刻重连，不能等 FIN 往返才释放客户端位
        conn.attached = false
        onClientLost(conn)
        conn.socket.end()
        return
      }
      case 'terminate': {
        if (!requestCache.accept(frame.reqId)) return
        handleTerminate(conn, frame.reqId)
        return
      }
      case 'ping': {
        if (!requestCache.accept(frame.reqId)) return
        ackOk(conn, frame.reqId, { status: statusSnapshot() })
        return
      }
      default:
        return
    }
  }

  // ── 连接处理 ────────────────────────────────────────────────────────────

  const handleConnection = (socket: Socket): void => {
    const decoder = new FrameDecoder()
    const conn: ClientConn = { socket, decoder, attached: false, paused: false, sent: 0, handshakeTimer: null }
    attachedSockets.add(socket)

    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[]
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        const code = error instanceof LocalHostError ? error.code : 'protocol-error'
        writeFrame(conn, { type: 'error', code, message: 'failed to decode frame', fatal: true })
        socket.destroy()
        return
      }
      for (const raw of frames) {
        if (finished) return
        let frame: ClientFrame
        try {
          frame = parseClientFrame(raw)
        } catch (error) {
          // 保留帧解析给出的稳定 code（例如 v1 的 incompatible-version、缺能力），
          // 不要一律压成 protocol-error：版本不兼容必须可辨。
          const code = error instanceof LocalHostError ? error.code : 'protocol-error'
          const message = error instanceof Error ? error.message : 'invalid frame'
          writeFrame(conn, { type: 'error', code, message, fatal: true })
          socket.destroy()
          return
        }
        if (frame.type === 'hello') {
          handleHello(conn, frame)
          continue
        }
        if (!conn.attached || active !== conn) {
          // 未鉴权/已被取代的连接不允许发命令（probe 连接也是如此）
          writeFrame(conn, { type: 'error', code: 'unauthorized', message: 'hello required', fatal: true })
          socket.destroy()
          return
        }
        handleCommand(conn, frame)
      }
    })

    socket.on('drain', () => {
      if (conn === active) flush(conn)
    })
    socket.on('error', () => {
      // 断链统一走 close
    })
    socket.on('close', () => {
      attachedSockets.delete(socket)
      clearHandshake(conn)
      onClientLost(conn)
    })

    // 握手超时：连上却不鉴权的连接不能长期占坑
    conn.handshakeTimer = setTimeout(() => {
      conn.handshakeTimer = null
      if (!conn.attached) socket.destroy()
    }, tuning.handshakeTimeoutMs)
    conn.handshakeTimer.unref?.()
  }

  // ── 监听 + 启动 PTY ─────────────────────────────────────────────────────

  const server: Server = createServer(handleConnection)
  const closeServer = async (): Promise<void> => {
    for (const socket of attachedSockets) {
      try {
        socket.destroy()
      } catch {
        // 已断开
      }
    }
    attachedSockets.clear()
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
      // close 等待连接关闭；已有连接已 destroy，这里再兜一次，避免极端情况挂住
      const guard = setTimeout(resolve, 1000)
      guard.unref?.()
    })
  }

  if (process.platform !== 'win32') {
    mkdirSync(dirname(pipe), { recursive: true, mode: 0o700 })
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(pipe)
  })

  server.on('error', () => {
    // 监听期之后的错误（例如管道被拆）只影响后续连接：没有客户端时直接收尾
    if (!active) void finish()
  })

  try {
    pty = ptyFactory({
      shell: spawn.shell,
      args: spawn.args,
      ...(spawn.cwd !== undefined ? { cwd: spawn.cwd } : {}),
      env: spawn.env,
      cols: spawn.cols,
      rows: spawn.rows,
      name: 'xterm-256color'
    })
  } catch (error) {
    await closeServer()
    throw new LocalHostError('spawn-failed', 'failed to spawn PTY in host worker', { cause: error })
  }

  crashGuardPty = pty
  const ptyPid = pty.pid
  pty.onData((data: string) => {
    if (finished) return
    ring.append(data)
    if (active) flush(active)
  })
  pty.onExit(onPtyExit)

  // 尚无客户端：宽限期内没有 attach 就终止（不长期留一个无人认领的 shell）
  scheduleGrace()

  return {
    id,
    pipe,
    pid: ptyPid,
    status: statusSnapshot,
    finished: finishedPromise,
    shutdown: async (): Promise<void> => {
      if (finished) return
      if (running) killPty()
      await finish()
    }
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function encodeHostFrame(hostId: string, payload: Record<string, unknown>): Buffer {
  // 每条宿主回复都带 hostId：客户端据此拒绝来自别的宿主的帧
  return encodeFrame({ v: LOCAL_HOST_PROTOCOL_VERSION, hostId, ...payload })
}

function pendingBytes(socket: Socket): number {
  const value = socket.writableLength
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// ── 生产 PTY 工厂（延迟加载 node-pty，测试注入 mock 时不触碰原生模块）─────────

/** node-pty 是原生模块：只在真实宿主进程里按需加载。 */
export async function loadNodePtyFactory(): Promise<HostPtyFactory> {
  const namespace: unknown = await import('node-pty')
  const candidate =
    isRecord(namespace) && typeof namespace.spawn === 'function'
      ? (namespace as unknown as { spawn: NodePtySpawn })
      : isRecord(namespace) && isRecord(namespace.default) && typeof namespace.default.spawn === 'function'
        ? (namespace.default as unknown as { spawn: NodePtySpawn })
        : null
  if (!candidate) throw new LocalHostError('spawn-failed', 'node-pty does not expose spawn()')
  const spawnFn = candidate.spawn
  return (options: HostPtySpawnOptions): HostPty => {
    const child: IPty = spawnFn(options.shell, options.args, {
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env
    })
    return {
      get pid(): number {
        return child.pid
      },
      write: (data: string) => child.write(data),
      resize: (cols: number, rows: number) => child.resize(cols, rows),
      kill: (signal?: string) => {
        // node-pty 的 signal 参数在 Windows 上被忽略，Unix 上可用于强杀
        if (signal) child.kill(signal)
        else child.kill()
      },
      onData: (listener) => child.onData(listener),
      onExit: (listener) => child.onExit(({ exitCode }) => listener({ exitCode }))
    }
  }
}

type NodePtySpawn = (file: string, args: string[], options: Record<string, unknown>) => IPty

// ── worker 入口 ──────────────────────────────────────────────────────────────

/** worker 与父进程之间的最小 IPC 面；生产走 process IPC，测试可注入。 */
export interface WorkerBootstrapChannel {
  onMessage(listener: (message: unknown) => void): void
  offMessage(listener: (message: unknown) => void): void
  onDisconnect(listener: () => void): void
  offDisconnect(listener: () => void): void
  send(message: unknown): void
  disconnect(): void
}

export interface RunBootstrapWorkerOptions {
  /** 等待 bootstrap 的时限，默认 DEFAULT_BOOTSTRAP_TIMEOUT_MS。 */
  timeoutMs?: number
  /** 默认 process IPC。 */
  channel?: WorkerBootstrapChannel
  /** 默认延迟加载 node-pty（生产路径）。 */
  ptyFactory?: HostPtyFactory
  /** 默认 process.exit；测试注入以避免真的结束进程。 */
  exit?: (code: number) => void
  /** ready 上报的 pid，默认 process.pid。 */
  pid?: number
  /** 默认安装 uncaughtException/unhandledRejection 兜底。 */
  installGuards?: boolean
  now?: () => number
}

function processBootstrapChannel(): WorkerBootstrapChannel {
  return {
    onMessage: (listener) => {
      process.on('message', listener)
    },
    offMessage: (listener) => {
      process.off('message', listener)
    },
    onDisconnect: (listener) => {
      process.on('disconnect', listener)
    },
    offDisconnect: (listener) => {
      process.off('disconnect', listener)
    },
    send: (message) => {
      if (typeof process.send !== 'function') throw new Error('IPC channel is not available')
      ;(process.send as (value: unknown) => void)(message)
    },
    disconnect: () => {
      try {
        process.disconnect?.()
      } catch {
        // 父进程可能已经退出
      }
    }
  }
}

/**
 * 读取父进程 IPC 下发的 bootstrap，启动宿主。
 * 失败/超时以非零码退出（孤儿由启动方 probed 后再决定，不盲目 kill PID）。
 */
export async function runBootstrapWorker(options: RunBootstrapWorkerOptions = {}): Promise<void> {
  const channel = options.channel ?? processBootstrapChannel()
  const exit = options.exit ?? ((code: number) => process.exit(code))
  if (options.installGuards !== false) installCrashGuard()

  const config = await new Promise<HostBootstrapConfig | null>((resolve) => {
    let settled = false
    const finishWait = (value: HostBootstrapConfig | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.offMessage(onMessage)
      channel.offDisconnect(onDisconnect)
      resolve(value)
    }
    const timer = setTimeout(() => finishWait(null), options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS)
    timer.unref?.()
    const onMessage = (raw: unknown): void => {
      if (!isRecord(raw) || raw.kind !== 'bootstrap') return
      try {
        finishWait(parseHostBootstrapMessage(raw))
      } catch {
        finishWait(null)
      }
    }
    const onDisconnect = (): void => finishWait(null)
    channel.onMessage(onMessage)
    channel.onDisconnect(onDisconnect)
  })

  if (!config) {
    // 没有可信 bootstrap 就不该有 PTY：直接退出，由启动方探测结果
    exit(WORKER_EXIT_BOOTSTRAP_TIMEOUT)
    return
  }

  // bootstrap IPC 的断开只代表启动握手结束；宿主生存期由已鉴权客户端管道约束。
  // 全部客户端丢失后按宽限期结束 PTY，收纳标记不允许跨应用退出保活。
  if (!options.channel) process.on('disconnect', () => undefined)

  let handle: LocalHostServerHandle
  try {
    const factory = options.ptyFactory ?? (await loadNodePtyFactory())
    handle = await startHostServer({
      config,
      ptyFactory: factory,
      now: options.now,
      onFinished: () => exit(0)
    })
  } catch {
    exit(WORKER_EXIT_HOST_FAILED)
    return
  }

  try {
    channel.send({
      kind: 'ready',
      v: LOCAL_HOST_PROTOCOL_VERSION,
      id: handle.id,
      pid: options.pid ?? process.pid,
      pipe: handle.pipe
    })
  } catch {
    // 拿不到可信的启动方就不再保留这个 PTY
    await handle.shutdown()
    exit(WORKER_EXIT_HOST_FAILED)
    return
  }

  // 断开启动握手 IPC，后续通过客户端管道维护本次应用的终端。
  channel.disconnect()
}

/** bootstrap 超时/失败码，供启动方区分（不对外承诺协议）。 */
export const WORKER_EXIT_BOOTSTRAP_TIMEOUT = 2
export const WORKER_EXIT_HOST_FAILED = 3

/** 在 worker 入口被直接执行时启动；被 import（测试）时保持纯模块。 */
function invokedAsWorkerEntry(): boolean {
  try {
    if (typeof require === 'undefined' || typeof module === 'undefined') return false
    return require.main === module
  } catch {
    return false
  }
}

if (invokedAsWorkerEntry()) {
  void runBootstrapWorker()
}
