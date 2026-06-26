import { v4 as uuidv4 } from 'uuid'
import { EventEmitter } from 'events'
import log from 'electron-log'
import { app } from 'electron'
import { SSHConnector, TelnetConnector, SerialConnector, LocalConnector, ConnectionStatus, ConnectionType } from '../connectors'
import type { SessionConfig, SSHConfig, TelnetConfig, SerialConfig, LocalConfig } from '@shared/types'
import { processInputEscapeSequences } from '@shared/escape-sequences'
import { OutputBuffer } from './output-buffer'
import * as mcpAuth from '../mcp/auth'
import { getMcpHttpPort } from '../mcp/http-server'
import { LYSHELL_MCP_ENV } from '../mcp/types'

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
}

/** send_and_wait 结果 */
export interface SendAndWaitResult {
  output: string
  settled: boolean
  patternMatched: boolean
  elapsedMs: number
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
}

/**
 * 会话管理器
 * 管理所有连接会话
 */
export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map()
  private activeSessionId: string | null = null

  /**
   * 创建新会话
   */
  async createSession(config: SessionConfig): Promise<Session> {
    const id = config.id || uuidv4()

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
   * 更新会话配置
   */
  updateSession(id: string, config: Partial<SessionConfig>): Session | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined

    session.config = { ...session.config, ...config }
    session.config.updatedAt = new Date()
    session.lastActiveAt = new Date()

    log.info(`Session updated: ${id}`)
    this.emit('session:updated', session)
    return session
  }

  /**
   * 删除会话
   */
  async deleteSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false

    // 先断开连接
    if (session.connector && session.status === ConnectionStatus.CONNECTED) {
      await session.connector.disconnect()
    }

    // 立即销毁输出缓冲
    session.outputBuffer?.clear()
    session.outputBuffer = undefined

    // 撤销可能存在的 per-session MCP token（仅 LOCAL 会话会持有，但调用幂等）
    mcpAuth.revokeSessionToken(id)

    this.sessions.delete(id)
    log.info(`Session deleted: ${id}`)
    this.emit('session:deleted', id)
    return true
  }

  /**
   * 连接会话
   */
  async connectSession(id: string): Promise<Session> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)

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
          // 为本地 PTY 生成 per-session MCP token，注入到 PTY env。
          // PTY 内孵化的 Claude Code / MCP Server 子进程将自动继承，
          // 外部进程拿不到 -> 实现"MCP 仅对 LyShell 内部终端开放"。
          // 端口未就绪（HTTP 服务尚未启动）则跳过注入，PTY 仍可正常运行，只是无法连 MCP。
          const sessionToken = mcpAuth.bindSessionToken(id)
          const port = getMcpHttpPort()
          const extraEnv: Record<string, string> = {}
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

      // 连接
      await session.connector.connect()

      // 连接成功后，shell 会自动输出欢迎信息，不需要额外显示

      // 创建输出缓冲区
      session.outputBuffer = new OutputBuffer()

      // 监听数据
      session.connector.on('data', (data: string) => {
        this.emit('terminal:data', { sessionId: id, data })
        session.outputBuffer?.append(data)
      })

      // 监听关闭
      session.connector.on('close', () => {
        session.status = ConnectionStatus.DISCONNECTED
        this.emit('session:status', { id, status: ConnectionStatus.DISCONNECTED })
      })

      // 监听错误
      session.connector.on('error', (error: Error) => {
        session.status = ConnectionStatus.ERROR
        this.emit('session:status', { id, status: ConnectionStatus.ERROR, error: extractErrorMessage(error) })
      })

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
          for (const cmd of session.config.startupCommands!) {
            this.writeToSession(id, cmd + '\r')
          }
        }, delay)
      }

      return session

    } catch (error) {
      session.status = ConnectionStatus.ERROR
      const errorMsg = extractErrorMessage(error as Error)

      // 错误信息由前端 TerminalView 显示（Xshell 风格）
      // 不再在终端发送中文错误信息

      this.emit('session:status', { id, status: ConnectionStatus.ERROR, error: errorMsg })
      throw error
    }
  }

  /**
   * 断开会话
   */
  async disconnectSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)

    if (session.connector) {
      await session.connector.disconnect()
    }

    // 撤销 per-session MCP token：PTY 已退出，env 注入的 token 不应再有效。
    // 重连会在 connectSession 中重新 bind 一个新 token，旧的不会被复用。
    mcpAuth.revokeSessionToken(id)

    session.status = ConnectionStatus.DISCONNECTED
    log.info(`Session disconnected: ${id}`)
    this.emit('session:status', { id, status: ConnectionStatus.DISCONNECTED })

    // 保留输出缓冲 30 秒，便于 MCP 读取最后输出后销毁
    const bufferToClean = session.outputBuffer
    if (bufferToClean) {
      session.outputBuffer = undefined
      setTimeout(() => bufferToClean.clear(), 30000)
    }
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

    const processedText = processInputEscapeSequences(options.text)

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

        // 模式匹配检测（在原始数据上匹配，避免清洗影响）
        if (patternRegex) {
          const rawOutput = buffer.getOutputSince(startCursor, false).text
          if (patternRegex.test(rawOutput)) {
            const cleanOutput = buffer.getOutputSince(startCursor, true).text
            return { output: cleanOutput, settled: true, patternMatched: true, elapsedMs: elapsed }
          }
        }

        // 空闲检测：超过 waitMs 且空闲超过 idleMs
        if (elapsed >= waitMs && idleSince >= idleMs) {
          const cleanOutput = buffer.getOutputSince(startCursor, true).text
          return { output: cleanOutput, settled: true, patternMatched: false, elapsedMs: elapsed }
        }

        // 最大超时
        if (elapsed >= maxWaitMs) {
          const cleanOutput = buffer.getOutputSince(startCursor, true).text
          return { output: cleanOutput, settled: false, patternMatched: false, elapsedMs: elapsed }
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

// 单例
export const sessionManager = new SessionManager()