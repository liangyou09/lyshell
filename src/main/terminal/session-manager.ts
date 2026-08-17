import { v4 as uuidv4 } from 'uuid'
import { EventEmitter } from 'events'
import log from 'electron-log'
import { app } from 'electron'
import { SSHConnector, TelnetConnector, SerialConnector, LocalConnector, ConnectionStatus, ConnectionType } from '../connectors'
import type { SessionConfig, SSHConfig, TelnetConfig, SerialConfig, LocalConfig } from '@shared/types'
import { processInputEscapeSequences, appendAutoNewline } from '@shared/escape-sequences'
import { OutputBuffer } from './output-buffer'
import { fileManager, cancelDownloadsBySession, cancelUploadsBySession } from '@main/file'

/** read_output 读取选项 */
export interface ReadOutputOptions {
  lines?: number
  raw?: boolean
}

/** read_output 读取结果 */
export interface ReadOutputResult {
  output: string
  lines: number
  totalBufferSize: number
}

/** send_and_wait 选项 */
export interface SendAndWaitOptions {
  text: string
  waitMs?: number
  idleMs?: number
  maxWaitMs?: number
  waitForPattern?: string
  /** 末尾为普通可见字符时自动补一个 \n（默认 true）。避免调用方忘记加 \n 导致命令只回显不执行 */
  autoNewline?: boolean
  /**
   * best-effort 捕获上一条命令的退出码（POSIX shell only：bash/zsh/sh）。
   * 开启后会在命令后追加 `printf '__LYSHELL_EXIT_%d__' $?`，从输出末尾解析标记。
   * 找不到标记（非 POSIX shell / 命令未提交 / 输出被截断）时 exitCode 为 null。
   * 仅适用于简单 shell 命令；对交互式程序（vim 等）无意义且会污染其输入。
   */
  captureExitCode?: boolean
}

/** send_and_wait 结果 */
export interface SendAndWaitResult {
  output: string
  /** 裁掉前端回显输入行后的输出（与 output 相比去掉了命令回显） */
  cleanOutput: string
  settled: boolean
  patternMatched: boolean
  elapsedMs: number
  /** best-effort 退出码；仅在 captureExitCode=true 且解析成功时有值，否则 null */
  exitCode?: number | null
}


/**
 * 提取错误关键信息（去掉堆栈）
 */
export function extractErrorMessage(error: Error | string): string {
  const msg = typeof error === 'string' ? error : error.message || error.toString()

  // 去掉 Error: 前缀
  let cleanMsg = msg.replace(/^Error:\s*/, '')

  // 只取第一行
  if (cleanMsg.includes('\n')) {
    cleanMsg = cleanMsg.split('\n')[0]
  }

  // 如果包含 at 关键字（堆栈），截取之前的部分
  if (cleanMsg.includes(' at ')) {
    cleanMsg = cleanMsg.split(' at ')[0]
  }

  return cleanMsg.trim()
}

/**
 * 会话信息
 */
export interface Session {
  id: string
  config: SessionConfig
  connector?: SSHConnector | TelnetConnector | SerialConnector | LocalConnector
  status: ConnectionStatus
  createdAt: Date
  lastActiveAt: Date
  welcomeSent?: boolean
  sourceSessionId?: string  // 克隆来源（用于共享 SSH client）
  pendingCols?: number  // 等待应用的终端宽度
  pendingRows?: number  // 等待应用的终端高度
  outputBuffer?: OutputBuffer  // 终端输出缓冲区（用于 MCP 读取输出）
  pendingWaitLock?: boolean  // send_and_wait 并发锁
  lockedByMcp?: boolean  // MCP 是否正在占用该会话 PTY（共享 PTY 模式时阻塞用户输入）
  mcpLockCount?: number  // MCP PTY 锁引用计数：并发 send_input/send_and_wait 各持一份，归零才真正解锁
  disconnectCleanup?: Promise<void>  // 自然 close / 显式 disconnect 共用的幂等清理
  connectorGeneration?: number  // 每次连接递增，隔离旧 connector 的迟到事件
  connectPromise?: Promise<Session>  // 同一 Session 的连接尝试串行化
}

/**
 * 会话管理器
 * 管理所有连接会话
 */
export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map()
  private activeSessionId: string | null = null

  // 各渲染窗口中当前在终端页签/分屏里打开的会话集合（key = WebContents.id）
  private terminalOpenSessions: Map<number, Set<string>> = new Map()

  /**
   * 创建新会话
   */
  async createSession(config: SessionConfig): Promise<Session> {
    const id = config.id || uuidv4()
    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`)
    }
    // 回填 config.id，确保 live session 的 config 与 session 本身一致，
    // 避免后续依赖 config.id 的地方（如 MCP list_sessions）拿到空 id。
    config.id = id

    const session: Session = {
      id,
      config,
      status: ConnectionStatus.DISCONNECTED,
      createdAt: new Date(),
      lastActiveAt: new Date()
    }

    this.sessions.set(id, session)
    log.info(`Session created: ${id} (${config.name})`)

    this.emit('session:created', session)
    return session
  }

  /**
   * 获取会话
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 设置某个渲染窗口当前在终端中打开的会话集合
   */
  setTerminalOpenSessionsForWindow(windowId: number, ids: string[]): void {
    this.terminalOpenSessions.set(windowId, new Set(ids))
  }

  /**
   * 移除某个渲染窗口的终端打开会话记录（窗口关闭时清理）
   */
  removeTerminalOpenSessionsForWindow(windowId: number): void {
    this.terminalOpenSessions.delete(windowId)
  }

  /**
   * 获取所有窗口中当前在终端里打开的会话 ID 集合（并集）
   */
  getAllTerminalOpenSessionIds(): Set<string> {
    const union = new Set<string>()
    for (const set of this.terminalOpenSessions.values()) {
      for (const id of set) {
        union.add(id)
      }
    }
    return union
  }

  /**
   * 锁定指定会话的 PTY，阻止渲染层用户键盘输入。
   * 用于 MCP send_input / send_and_wait 在共享 PTY 模式时避免人机输入冲突。
   * 采用引用计数：并发调用各持一份，计数归零才真正解锁，避免长任务进行中被短任务 finally 过早放行。
   */
  lockSessionForMcp(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const prev = session.mcpLockCount ?? 0
    session.mcpLockCount = prev + 1
    if (!session.lockedByMcp) {
      session.lockedByMcp = true
      this.emit('session:mcp-lock-changed', { sessionId, lockedByMcp: true })
    }
    return true
  }

  /**
   * 释放一份 MCP PTY 锁。仅当计数归零才真正解锁、恢复用户键盘输入。
   */
  unlockSessionForMcp(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const prev = session.mcpLockCount ?? 0
    if (prev <= 0) return false
    const next = prev - 1
    session.mcpLockCount = next
    if (next === 0 && session.lockedByMcp) {
      session.lockedByMcp = false
      this.emit('session:mcp-lock-changed', { sessionId, lockedByMcp: false })
    }
    return true
  }

  /**
   * 更新会话配置
   *
   * @param options.touchLastActive 是否同时刷新 lastActiveAt（默认 true）。
   *                                对于不表示用户活动的元数据写入（如 MCP 修改备注），应传 false，
   *                                避免干扰"最近会话"排序。
   * @param options.timestamp      强制使用指定时间戳；不传则内部新建 Date()。
   */
  updateSession(
    id: string,
    config: Partial<SessionConfig>,
    options?: { touchLastActive?: boolean; timestamp?: Date }
  ): Session | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined

    const touchLastActive = options?.touchLastActive !== false
    const timestamp = options?.timestamp ?? new Date()

    session.config = { ...session.config, ...config }
    session.config.updatedAt = timestamp
    if (touchLastActive) {
      session.lastActiveAt = timestamp
    }

    log.info(`Session updated: ${id}`)
    this.emit('session:updated', session)
    return session
  }

  /**
   * 删除运行时会话。先复用完整断开流程取消传输、清理连接器并撤销 token，再立即清除缓冲与 Map。
   */
  async deleteSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    const outputBuffer = session.outputBuffer

    try {
      await this.disconnectSession(id)
    } catch (err) {
      log.warn(`Session cleanup on delete failed for ${id}:`, err)
    } finally {
      outputBuffer?.clear()
      session.outputBuffer = undefined
      this.sessions.delete(id)
      if (this.activeSessionId === id) this.activeSessionId = null
      for (const ids of this.terminalOpenSessions.values()) ids.delete(id)
      log.info(`Session deleted: ${id}`)
      this.emit('session:deleted', id)
    }
    return true
  }

  /**
   * 连接会话。同一 Session 的并发调用复用同一个 Promise，完整串行化连接生命周期。
   */
  async connectSession(id: string): Promise<Session> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    if (session.connectPromise) {
      if (!session.disconnectCleanup) return session.connectPromise
      try { await session.connectPromise } catch { /* 旧 attempt 被断开/替代 */ }
      if (this.sessions.get(id) !== session) throw new Error(`Session replaced: ${id}`)
      return this.connectSession(id)
    }

    const promise = this.connectSessionAttempt(id, session)
    session.connectPromise = promise
    try {
      return await promise
    } finally {
      if (session.connectPromise === promise) session.connectPromise = undefined
    }
  }

  private async connectSessionAttempt(id: string, session: Session): Promise<Session> {
    if (session.disconnectCleanup) await session.disconnectCleanup
    if (this.sessions.get(id) !== session) throw new Error(`Session replaced: ${id}`)

    session.disconnectCleanup = undefined
    const generation = (session.connectorGeneration ?? 0) + 1
    session.connectorGeneration = generation
    session.connector = undefined
    let connector: Session['connector']
    const isCurrentAttempt = (): boolean =>
      this.sessions.get(id) === session &&
      session.disconnectCleanup === undefined &&
      session.connectorGeneration === generation &&
      (connector === undefined || session.connector === connector)

    session.status = ConnectionStatus.CONNECTING
    this.emit('session:status', { id, status: ConnectionStatus.CONNECTING })

    // 连接信息由前端 TerminalView 显示（Xshell 风格）
    // 不再在终端发送中文连接信息

    try {
      // 根据类型创建连接器
      switch (session.config.type) {
        case ConnectionType.SSH:
          session.connector = new SSHConnector(id, {
            ...session.config.ssh as SSHConfig,
            encoding: session.config.terminal?.encoding
          })
          break
        case ConnectionType.TELNET:
          session.connector = new TelnetConnector(id, {
            ...session.config.telnet as TelnetConfig,
            encoding: session.config.terminal?.encoding
          })
          break
        case ConnectionType.SERIAL:
          session.connector = new SerialConnector(id, {
            ...session.config.serial as SerialConfig,
            encoding: session.config.terminal?.encoding
          })
          break
        case ConnectionType.LOCAL: {
          const extraEnv: Record<string, string> = {}
          // 为本地 PTY 生成 per-session MCP token，注入到 PTY env。
          // PTY 内孵化的 Claude Code / MCP Server 子进程将自动继承，
          // 外部进程拿不到 -> 实现"MCP 仅对 LyShell 内部终端开放"。
          // 端口未就绪（HTTP 服务尚未启动）则跳过注入，PTY 仍可正常运行，只是无法连 MCP。
          const mcpAuth = await import('@main/mcp/auth')
          const { getMcpHttpPort } = await import('@main/mcp/http-server')
          const { LYSHELL_MCP_ENV } = await import('@main/mcp/types')
          if (!isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)
          const sessionToken = mcpAuth.bindSessionToken(id)
          const port = getMcpHttpPort()
          if (port !== null) {
            extraEnv[LYSHELL_MCP_ENV.PORT] = String(port)
            extraEnv[LYSHELL_MCP_ENV.TOKEN] = sessionToken
            extraEnv[LYSHELL_MCP_ENV.SESSION_ID] = id
            try {
              extraEnv[LYSHELL_MCP_ENV.USER_DATA] = app.getPath('userData')
            } catch {
              // 极少数测试环境下 app 不可用，忽略
            }
          } else {
            log.warn(`[MCP] HTTP server not ready when spawning local session ${id}; MCP env will not be injected`)
          }

          session.connector = new LocalConnector(id, {
            ...session.config.local as LocalConfig,
            encoding: session.config.terminal?.encoding
          }, extraEnv)
          break
        }
        default:
          throw new Error(`Unknown connection type: ${session.config.type}`)
      }

      // 先挂监听器，再 connect()：连接过程中（认证失败、网络错误）connector 可能 emit 'error'。
      // generation + Session/connector 身份校验，防旧 attempt 的迟到事件污染新连接。
      connector = session.connector
      if (!connector || !isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)

      session.outputBuffer = new OutputBuffer()
      connector.on('data', (data: string) => {
        if (!isCurrentAttempt()) return
        this.emit('terminal:data', { sessionId: id, data })
        session.outputBuffer?.append(data)
      })
      connector.on('close', () => {
        if (!isCurrentAttempt()) return
        void this.cleanupDisconnectedSession(id, generation, connector).catch((err) => {
          log.warn(`Natural disconnect cleanup failed for ${id}:`, err)
        })
      })
      connector.on('error', (error: Error) => {
        if (!isCurrentAttempt()) return
        session.status = ConnectionStatus.ERROR
        this.emit('session:status', { id, status: ConnectionStatus.ERROR, error: extractErrorMessage(error) })
      })

      // 连接
      await connector.connect()
      if (!isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)

      // 连接成功后，shell 会自动输出欢迎信息，不需要额外显示

      if (!isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)
      session.status = ConnectionStatus.CONNECTED
      session.lastActiveAt = new Date()

      // 应用 pending 的终端尺寸（如果在连接前已经发送了 resize）
      if (session.pendingCols && session.pendingRows) {
        session.connector.resize(session.pendingCols, session.pendingRows)
        log.debug(`Applied pending resize for session ${id}: ${session.pendingCols}x${session.pendingRows}`)
        session.pendingCols = undefined
        session.pendingRows = undefined
      }

      // 增加连接计数
      session.config.connectCount = (session.config.connectCount || 0) + 1

      log.info(`Session connected: ${id}`)
      this.emit('session:status', { id, status: ConnectionStatus.CONNECTED })

      // 发送启动命令（如果有）
      if (session.config.startupCommands && session.config.startupCommands.length > 0) {
        // 本地终端启动快，200ms；远程连接需等待 shell 就绪，500ms
        const delay = session.config.type === ConnectionType.LOCAL ? 200 : 500
        setTimeout(() => {
          if (!isCurrentAttempt()) return
          for (const cmd of session.config.startupCommands!) {
            this.writeToSession(id, cmd + '\r')
          }
        }, delay)
      }

      return session

    } catch (error) {
      if (isCurrentAttempt()) {
        session.status = ConnectionStatus.ERROR
        const errorMsg = extractErrorMessage(error as Error)
        this.emit('session:status', { id, status: ConnectionStatus.ERROR, error: errorMsg })
      }
      throw error
    }
  }

  /**
   * 自然 close 与显式 disconnect 共用的幂等资源清理。
   */
  private cleanupDisconnectedSession(
    id: string,
    generation?: number,
    connector?: Session['connector']
  ): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return Promise.resolve()
    if (generation !== undefined && (
      session.connectorGeneration !== generation || session.connector !== connector
    )) return Promise.resolve()
    if (session.disconnectCleanup) return session.disconnectCleanup

    session.status = ConnectionStatus.DISCONNECTED
    cancelDownloadsBySession(id)
    cancelUploadsBySession(id)

    const isSameSession = (): boolean => this.sessions.get(id) === session
    session.disconnectCleanup = (async () => {
      if (!isSameSession()) return
      try {
        await fileManager.removeConnector(id)
      } catch (err) {
        log.warn(`File cleanup on disconnect failed for ${id}:`, err)
      }
      if (!isSameSession()) return

      const mcpAuth = await import('@main/mcp/auth')
      if (!isSameSession()) return
      mcpAuth.revokeSessionToken(id)
      if (!isSameSession()) return

      if (session.lockedByMcp) {
        session.lockedByMcp = false
        session.mcpLockCount = 0
        this.emit('session:mcp-lock-changed', { sessionId: id, lockedByMcp: false })
      }
      log.info(`Session disconnected: ${id}`)
      this.emit('session:status', { id, status: ConnectionStatus.DISCONNECTED })

      const bufferToClean = session.outputBuffer
      if (bufferToClean) {
        session.outputBuffer = undefined
        setTimeout(() => bufferToClean.clear(), 30000)
      }
    })()
    return session.disconnectCleanup
  }

  /**
   * 断开会话
   */
  async disconnectSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)

    // 首个 await 前同步开始清理，阻止清理期间启动新的文件任务。
    const connector = session.connector
    const generation = session.connectorGeneration
    const cleanup = this.cleanupDisconnectedSession(id, generation, connector)
    if (connector) {
      try {
        await connector.disconnect()
      } catch (err) {
        log.warn(`Connector disconnect failed for ${id}:`, err)
      }
    }
    await cleanup
  }

  /**
   * 重连会话
   */
  async reconnectSession(id: string): Promise<Session> {
    await this.disconnectSession(id)
    return await this.connectSession(id)
  }

  /**
   * 写入数据到会话
   */
  writeToSession(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.connector) {
      log.warn(`Cannot write to session: ${id}`)
      return
    }

    session.connector.write(data)
  }

  /**
   * 调整会话终端尺寸
   */
  resizeSession(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) {
      log.warn(`Cannot resize session: ${id}`)
      return
    }

    // 如果 connector 还没准备好，保存 pending 尺寸，连接成功后应用
    if (!session.connector) {
      session.pendingCols = cols
      session.pendingRows = rows
      log.debug(`Pending resize saved for session ${id}: ${cols}x${rows}`)
      return
    }

    session.connector.resize(cols, rows)
  }

  /**
   * 设置活动会话
   */
  setActiveSession(id: string | null): void {
    this.activeSessionId = id
    if (id) {
      const session = this.sessions.get(id)
      if (session) {
        session.lastActiveAt = new Date()
      }
    }
    this.emit('session:active', id)
  }

  /**
   * 获取活动会话
   */
  getActiveSession(): Session | undefined {
    if (!this.activeSessionId) return undefined
    return this.sessions.get(this.activeSessionId)
  }

  /**
   * 克隆渠道（在现有 SSH 连接上创建新 shell channel）
   */
  async cloneChannel(sourceSessionId: string): Promise<{ id: string; status: ConnectionStatus; config: SessionConfig } | null> {
    const sourceSession = this.sessions.get(sourceSessionId)
    if (!sourceSession) {
      log.warn(`Source session not found: ${sourceSessionId}`)
      return null
    }

    // 只支持 SSH 克隆渠道
    if (sourceSession.config.type !== ConnectionType.SSH) {
      log.warn(`Clone channel only supported for SSH, got: ${sourceSession.config.type}`)
      return null
    }

    if (sourceSession.status !== ConnectionStatus.CONNECTED) {
      log.warn(`Source session not connected: ${sourceSessionId}`)
      return null
    }

    // 创建新会话 ID
    const newId = uuidv4()

    // 克隆会话保持源会话名称不变（前端 PaneTabBar 会根据 createdAt 显示序号）
    const newName = sourceSession.config.name

    // 创建新会话配置
    const newConfig: SessionConfig = {
      ...sourceSession.config,
      id: newId,
      name: newName,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // 创建新会话
    const newSession: Session = {
      id: newId,
      config: newConfig,
      status: ConnectionStatus.CONNECTING,
      createdAt: new Date(),
      lastActiveAt: new Date(),
      sourceSessionId: sourceSessionId  // 记录来源
    }

    this.sessions.set(newId, newSession)

    // 获取源 SSH connector 的 client，创建新 channel
    const sourceConnector = sourceSession.connector as SSHConnector
    const sshClient = sourceConnector.getClient()

    if (!sshClient) {
      log.warn(`SSH client not available for source session: ${sourceSessionId}`)
      this.sessions.delete(newId)
      return null
    }

    // 创建新的 SSH connector，共享 client
    const newConnector = new SSHConnector(newId, sourceSession.config.ssh as SSHConfig)
    newConnector.setSharedClient(sshClient)  // 共享 SSH client

    newSession.connector = newConnector

    // 启动 shell
    try {
      await newConnector.startShellOnly()

      // 创建输出缓冲区
      newSession.outputBuffer = new OutputBuffer()

      // 监听数据
      newConnector.on('data', (data: string) => {
        this.emit('terminal:data', { sessionId: newId, data })
        newSession.outputBuffer?.append(data)
      })

      // 监听关闭
      newConnector.on('close', () => {
        newSession.status = ConnectionStatus.DISCONNECTED
        this.emit('session:status', { id: newId, status: ConnectionStatus.DISCONNECTED })
      })

      // 监听错误
      newConnector.on('error', (error: Error) => {
        newSession.status = ConnectionStatus.ERROR
        this.emit('session:status', { id: newId, status: ConnectionStatus.ERROR, error: error.message })
      })

      newSession.status = ConnectionStatus.CONNECTED
      newSession.lastActiveAt = new Date()

      log.info(`Channel cloned: ${newId} from ${sourceSessionId}`)
      this.emit('session:status', { id: newId, status: ConnectionStatus.CONNECTED })

      return {
        id: newId,
        status: newSession.status,
        config: newConfig
      }

    } catch (error) {
      log.error(`Failed to start shell for cloned channel: ${error}`)
      this.sessions.delete(newId)
      return null
    }
  }

  /**
   * 读取会话的最近终端输出（用于 MCP read_output）
   */
  readOutput(id: string, options: ReadOutputOptions = {}): ReadOutputResult | null {
    const session = this.sessions.get(id)
    if (!session || !session.outputBuffer) {
      return null
    }

    const lines = Math.min(Math.max(options.lines ?? 100, 1), 1000)
    const raw = options.raw ?? false
    const result = session.outputBuffer.getRecentLines(lines, !raw)

    return {
      output: result.text,
      lines: result.lines,
      totalBufferSize: session.outputBuffer.size()
    }
  }

  /**
   * 发送输入并等待响应（用于 MCP send_and_wait）
   * 通过空闲检测/模式匹配/最大超时判断命令完成
   */
  async sendAndWait(id: string, options: SendAndWaitOptions): Promise<SendAndWaitResult> {
    const session = this.sessions.get(id)
    if (!session || !session.connector || session.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`Session not connected: ${id}`)
    }
    if (!session.outputBuffer) {
      throw new Error(`Output buffer not available for session: ${id}`)
    }

    // 并发锁：同一会话同时只能有一个 send_and_wait
    if (session.pendingWaitLock) {
      throw new Error(`A send_and_wait is already in progress for session: ${id}`)
    }

    // 先校验正则、计算参数，再获取锁、再 write —— 避免校验失败导致锁泄漏或输入已发送
    const waitMs = options.waitMs ?? 2000
    const idleMs = options.idleMs ?? 300
    // maxWaitMs 上限钳制：客户端 HTTP 超时 60s，留 5s 余量，防止客户端先超时、服务端仍占用锁
    const maxWaitMs = Math.min(options.maxWaitMs ?? 10000, 55000)
    const pattern = options.waitForPattern

    let patternRegex: RegExp | null = null
    if (pattern) {
      try {
        patternRegex = new RegExp(pattern)
      } catch (e) {
        throw new Error(`Invalid waitForPattern regex: ${pattern}`)
      }
    }

    let processedText = processInputEscapeSequences(options.text)

    // autoNewline：末尾是普通可见字符时自动补一个 \n，避免调用方忘记加换行导致命令只回显不执行；
    // 末尾已是 \n/\r 或控制序列时不补。核心层默认 false（保持"不补换行"的最小语义）；
    // MCP 边界层统一默认 true：handleSendInput 在 http-server 内直接调 appendAutoNewline，
    // handleSendAndWait 经此核心函数（data.autoNewline !== false opt-in），使外部 MCP 调用方免于手写 \n。
    // 新增非 MCP 调用方需自行决定是否传 autoNewline:true。
    processedText = appendAutoNewline(processedText, options.autoNewline === true)

    // captureExitCode：追加 POSIX 退出码探针（best-effort，纯 ASCII 标记 survives ANSI 清洗）
    let capturingExit = false
    if (options.captureExitCode === true) {
      if (!processedText.endsWith('\n')) processedText += '\n'
      processedText += "printf '__LYSHELL_EXIT_%d__' $?\n"
      capturingExit = true
    }

    // 结果统一构造：captureExitCode 时从 cleanOutput 末尾剥除标记并解析退出码。
    // output 保持 raw（含探针回显与标记，符合"原始终端输出"语义）；cleanOutput 剥除回显+标记。
    const finalize = (ansiStripped: string, settled: boolean, patternMatched: boolean, elapsed: number): SendAndWaitResult => {
      let cleanOutput = stripEcho(ansiStripped, processedText)
      let exitCode: number | null = null
      if (capturingExit) {
        const m = cleanOutput.match(/__LYSHELL_EXIT_(\d+)__\s*$/)
        if (m) {
          exitCode = parseInt(m[1], 10)
          cleanOutput = cleanOutput.replace(/__LYSHELL_EXIT_\d+__\s*$/, '').trimEnd()
        }
      }
      return { output: ansiStripped, cleanOutput, settled, patternMatched, elapsedMs: elapsed, exitCode }
    }

    session.pendingWaitLock = true
    const connector = session.connector
    const dataListener = () => { lastDataTime = Date.now() }
    let lastDataTime: number

    try {
      const buffer = session.outputBuffer!
      const startCursor = buffer.getWriteCursor()

      // 发送输入（在锁保护范围内，确保 write 抛错也能释放锁）
      connector.write(processedText)

      // 事件驱动更新最近数据时间
      lastDataTime = Date.now()
      connector.on('data', dataListener)

      const startTime = Date.now()
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const now = Date.now()
        const elapsed = now - startTime
        const idleSince = now - lastDataTime

        // 模式匹配检测：同时在 raw 与 ANSI 清洗后两种基底上匹配。
        // 默认 prompt 正则（[$#>%]\s*$）依赖清洗后的 $ 锚定（raw 末尾常带 ANSI 复位码）；
        // 带 ANSI 码的自定义正则只在 raw 上命中。两者取或，避免基底选择导致漏判。
        if (patternRegex) {
          const rawOutput = buffer.getOutputSince(startCursor, false).text
          const ansiStripped = buffer.getOutputSince(startCursor, true).text
          if (patternRegex.test(rawOutput) || patternRegex.test(ansiStripped)) {
            return finalize(ansiStripped, true, true, elapsed)
          }
        }

        // 空闲检测：超过 waitMs 且空闲超过 idleMs
        if (elapsed >= waitMs && idleSince >= idleMs) {
          const ansiStripped = buffer.getOutputSince(startCursor, true).text
          return finalize(ansiStripped, true, false, elapsed)
        }

        // 最大超时
        if (elapsed >= maxWaitMs) {
          const ansiStripped = buffer.getOutputSince(startCursor, true).text
          return finalize(ansiStripped, false, false, elapsed)
        }

        // 50ms 轮询
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    } finally {
      connector.off('data', dataListener)
      session.pendingWaitLock = false
    }
  }
}

/**
 * 把发送文本中的 C0 控制字符 / DEL 归一化为终端的 caret 回显记法（^C / ^Z / ^? 等）。
 * 终端在 cooked 模式下会把控制字符回显为 caret 记法（如 \x03 回显为 ^C），
 * 与发送的原始字节不一致，导致 stripEcho 精确匹配失败。归一化后才能对齐。
 */
function normalizeControlEcho(text: string): string {
  // 按码点遍历（避免在正则里写字面控制字符，触发 no-control-regex）。
  // C0(0x00–0x1f) / DEL(0x7f) → caret 记法（^C / ^Z / ^? 等），对齐终端 cooked 模式的回显。
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code <= 0x1f || code === 0x7f) {
      out += '^' + String.fromCharCode(code === 0x7f ? 0x3f : 0x40 + code)
    } else {
      out += ch
    }
  }
  return out
}

/**
 * 从捕获的输出前端裁掉与发送文本精确相等的回显行。
 * 终端会把输入逐行回显（如发送 "ls\n" 会先回显 "ls"），混进真实输出里。
 * 仅裁前端逐行精确匹配的部分，避免误伤真实输出；不匹配则原样返回。
 *
 * 两点对齐：
 *  - 发送端的控制字符按 caret 记法归一化（\x03 → ^C），对齐终端回显；
 *  - 捕获端跳过空行，使多行命令（含空行分隔）也能逐行对齐。
 */
function stripEcho(captured: string, sentText: string): string {
  const echoLines = sentText.split(/\r\n|\r|\n/).filter(l => l !== '').map(normalizeControlEcho)
  if (echoLines.length === 0) return captured
  const lines = captured.split(/\r\n|\r|\n/)
  let i = 0
  for (const echo of echoLines) {
    while (i < lines.length && lines[i] === '') i++
    if (i < lines.length && lines[i] === echo) {
      i++
    } else {
      break
    }
  }
  return lines.slice(i).join('\n')
}

// 单例
export const sessionManager = new SessionManager()