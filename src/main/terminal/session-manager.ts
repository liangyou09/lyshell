import { v4 as uuidv4 } from 'uuid'
import { EventEmitter } from 'events'
import log from 'electron-log'
import { app } from 'electron'
import { SSHConnector, TelnetConnector, SerialConnector, ConnectionStatus, ConnectionType } from '../connectors'
import type { SessionConfig, SSHConfig, TelnetConfig, SerialConfig } from '@shared/types'

/**
 * 提取错误关键信息（去掉堆栈）
 */
function extractErrorMessage(error: Error | string): string {
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
  connector?: SSHConnector | TelnetConnector | SerialConnector
  status: ConnectionStatus
  createdAt: Date
  lastActiveAt: Date
  welcomeSent?: boolean
  sourceSessionId?: string  // 克隆来源（用于共享 SSH client）
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
        default:
          throw new Error(`Unknown connection type: ${session.config.type}`)
      }

      // 连接
      await session.connector.connect()

      // 监听数据
      session.connector.on('data', (data: string) => {
        log.debug(`Terminal data received for ${id}: ${data.length} bytes`)
        this.emit('terminal:data', { sessionId: id, data })
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

      // 增加连接计数
      session.config.connectCount = (session.config.connectCount || 0) + 1

      log.info(`Session connected: ${id}`)
      this.emit('session:status', { id, status: ConnectionStatus.CONNECTED })

      // 发送启动命令（如果有）
      if (session.config.startupCommands && session.config.startupCommands.length > 0) {
        // 延迟发送启动命令，等待终端稳定
        setTimeout(() => {
          for (const cmd of session.config.startupCommands!) {
            this.writeToSession(id, cmd + '\r')
          }
        }, 500)
      }

      return session

    } catch (error) {
      session.status = ConnectionStatus.ERROR
      this.emit('session:status', { id, status: ConnectionStatus.ERROR, error: extractErrorMessage(error as Error) })
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

    session.status = ConnectionStatus.DISCONNECTED
    log.info(`Session disconnected: ${id}`)
    this.emit('session:status', { id, status: ConnectionStatus.DISCONNECTED })
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
    if (!session || !session.connector) {
      log.warn(`Cannot resize session: ${id}`)
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

      // 监听数据
      newConnector.on('data', (data: string) => {
        this.emit('terminal:data', { sessionId: newId, data })
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
}

// 单例
export const sessionManager = new SessionManager()