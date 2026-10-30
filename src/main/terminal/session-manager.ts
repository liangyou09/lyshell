import { v4 as uuidv4 } from 'uuid'
import { EventEmitter } from 'events'
import { performance } from 'node:perf_hooks'
import log from 'electron-log'
import { app } from 'electron'
import { SSHConnector, TelnetConnector, SerialConnector, LocalConnector, ConnectionStatus, ConnectionType } from '../connectors'
import type { SessionConfig, SSHConfig, TelnetConfig, SerialConfig, TerminalEncoding } from '@shared/types'
import { processInputEscapeSequences, appendAutoNewline } from '@shared/escape-sequences'
import { OutputBuffer } from './output-buffer'
import { OscCwdTracker } from './osc-cwd-tracker'
import { fileManager, cancelDownloadsBySession, cancelUploadsBySession } from '@main/file'
import { pluginResources } from '@main/plugin/resource-registry'
import { getMcpHttpPort } from '@main/mcp/http-port'
import * as mcpAuth from '@main/mcp/auth'
import { tuiActivity } from '../harness/tui-activity'
import { captureSshContext, formatSshHistoryForTerminal, normalizeSshDirectory } from './shelf-ssh-context'
import type { SshHostKeyChallenge } from '../security/ssh-host-key'
import type { BaseConnector } from '../connectors/base'
import { InputControlService } from './input-control'
import type { ControlHandle, ControllerIdentity } from '@shared/terminal-control'
import { OperationError } from '@shared/operation'
import { applicationCallers } from '../security/application-caller'
import { OutputHistoryBudget } from './output-budget'
import { assertResolvedSecrets } from '../storage/secret-store'
import { assertNoSecretPlaceholders } from '../storage/session-secrets'
import { patternMatcher } from './pattern-matcher'
import {
  BUILTIN_PROMPT_PATTERN,
  PatternMatchError,
  asOutcomeUnknownError,
  asPatternMatchError,
  type MatchMode,
  type PatternSpec
} from './pattern-contract'

const SHELL_OPEN_CLEANUP_TIMEOUT_MS = 5000

export interface SessionConnectOptions {
  /** 只允许可信 GUI 入口注入；外部连接配置不能提供确认函数。 */
  confirmHostKey?: (challenge: SshHostKeyChallenge) => Promise<boolean>
}

/** 创建失败也要继续关闭；等待超时则保留资源，不能误报已经关闭。 */
async function waitForShellOpeningForCleanup(opening: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      opening.catch(() => {}),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SSH shell cleanup timed out while waiting for shell creation')), SHELL_OPEN_CLEANUP_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

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
  /** 匹配模式；缺省 `regex`（保持既有 waitForPattern 的正则语义）。 */
  waitForPatternMode?: MatchMode
  /** 调用方主体标识，用于匹配池的每主体并发配额与公平性（缺省取控制租约主体，再退到 anonymous）。 */
  callerKey?: string
  /** 调用方中止信号：编译/匹配/等待期间中止都走清理路径，不会留下锁或监听器。 */
  signal?: AbortSignal
  /** 末尾为普通可见字符时自动补一个 \n（默认 true）。避免调用方忘记加 \n 导致命令只回显不执行 */
  autoNewline?: boolean
  /**
   * best-effort 捕获上一条命令的退出码（POSIX shell only：bash/zsh/sh）。
   * 开启后会在命令后追加 `printf '__LYSHELL_EXIT_%d__' $?`，从输出末尾解析标记。
   * 找不到标记（非 POSIX shell / 命令未提交 / 输出被截断）时 exitCode 为 null。
   * 仅适用于简单 shell 命令；对交互式程序（vim 等）无意义且会污染其输入。
   */
  captureExitCode?: boolean
  control?: ControlHandle
  authorizeInput?: () => boolean
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

/** 只读等待的观察范围：`new-output` 只看记录游标之后的新输出，`recent` 每轮都看最近若干行。 */
export type WaitPatternScope = 'new-output' | 'recent'

/** wait_for_pattern 选项（供 MCP wait_for_prompt / tail_until 使用，只读、不写终端）。 */
export interface WaitForPatternOptions {
  /** 缺省用内置提示符正则（BUILTIN_PROMPT_PATTERN）；一旦显式给 mode，必须同时给 pattern。 */
  pattern?: string
  mode?: MatchMode
  scope?: WaitPatternScope
  /** `new-output` 范围下先检查一次最近历史（wait_for_prompt 的既有语义）。 */
  checkHistoryFirst?: boolean
  historyLines?: number
  timeoutMs?: number
  /** >0 时，只有整个窗口内几乎没有新输出才提前按「已静默」返回；0 表示一直等到命中或超时。 */
  idleMs?: number
  pollMs?: number
  callerKey?: string
  signal?: AbortSignal
  /** 每轮观察前重新确认授权；撤销后立刻停止等待（只读操作也会被授权撤销打断）。 */
  authorizeObservation?: () => boolean
}

/** wait_for_pattern 结果；`matched:false` 不是错误，`reason` 说明为何结束。 */
export interface WaitForPatternResult {
  matched: boolean
  settled: boolean
  reason: 'matched' | 'idle' | 'timeout' | 'disconnected'
  output: string
  cleanOutput: string
  elapsedMs: number
  pattern: string
  mode: MatchMode
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
 * 协议段 + 运行时编码：connector config.encoding 的唯一派生点 —— terminal.encoding
 * 是编码的唯一来源，connectSessionAttempt 三分支与 cloneChannel 共用此口径，漏一处
 * 就回到「克隆渠道按 utf-8 解码而状态栏读数说谎」的漂移。展开浅拷贝还顺带断开与源
 * config 的共享引用 —— connector.setEncoding 只写进自己的副本，不污染会话/保存配置
 */
function withRuntimeEncoding<T extends object>(proto: T, session: Session): T & { encoding?: TerminalEncoding } {
  return { ...proto, encoding: session.config.terminal?.encoding }
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
  cwd?: string  // 当前工作目录（local：spawn 种子 + OSC 报告实时更新；页签悬停详情卡显示）
  pendingCols?: number  // 等待应用的终端宽度
  pendingRows?: number  // 等待应用的终端高度
  outputBuffer?: OutputBuffer  // 终端输出缓冲区（用于 MCP 读取输出）
  shelfOutputBuffer?: OutputBuffer // 仅收纳的 SSH 持有，断开后仍可保存最后输出
  pendingShelfHistory?: string // SSH 恢复时一次性注入本机显示流，绝不写入连接器
  outputPaused?: boolean  // 图形输出背压，重建 connector 时沿用
  pendingWaitLock?: boolean  // send_and_wait 并发锁
  /** 锁所有者标记：只有持锁的那次等待才释放锁，避免超时清理误放别人的锁。 */
  pendingWaitOwner?: symbol
  lockedByMcp?: boolean  // MCP 是否正在占用该会话 PTY（共享 PTY 模式时阻塞用户输入）
  mcpLockCount?: number  // MCP PTY 锁引用计数：并发 send_input/send_and_wait 各持一份，归零才真正解锁
  disconnectCleanup?: Promise<void>  // 自然 close / 显式 disconnect 共用的幂等清理
  connectorGeneration?: number  // 每次连接递增，隔离旧 connector 的迟到事件
  connectionInstanceId?: string
  startupPending?: boolean
  outputHistoryGap?: boolean
  connectPromise?: Promise<Session>  // 同一 Session 的连接尝试串行化
}

/**
 * 会话管理器
 * 管理所有连接会话
 */
export class SessionManager extends EventEmitter {
  private inputChains = new Map<string, Promise<void>>()
  private inputPending = new Map<string, number>()
  private totalInputPending = 0
  private closing = false

  beginShutdown(): Promise<void> {
    this.closing = true
    return this.invalidateInput('shutdown')
  }

  invalidateInput(reason: string): Promise<void> {
    const pending = this.inputControl.invalidateAll()
    this.emit('terminal:control-invalidated', { reason })
    return pending
  }
  readonly inputControl = new InputControlService({
    onFence: async (id, fence) => {
      const session = this.sessions.get(id)
      const connector = session?.connector
      if (!connector || (fence && session?.connectionInstanceId !== fence.connectionInstanceId)) {
        if (fence) throw new OperationError('STALE_GENERATION', 'Terminal connection was replaced')
        return
      }
      if (connector instanceof LocalConnector) await connector.setInputControl(fence)
    },
    isCredentialCurrent: identity => identity.source === 'gui'
      ? applicationCallers.isPrincipalCurrent(identity.principalId)
      : identity.source === 'internal' || !!identity.credentialId && mcpAuth.isCredentialIdCurrent(identity.credentialId)
  })
  private readonly outputHistory = new OutputHistoryBudget()

  private createOutputBuffer(limit = 1024 * 1024): OutputBuffer {
    const buffer = new OutputBuffer(limit)
    this.outputHistory.attach(buffer)
    buffer.setCapacity(limit)
    return buffer
  }

  outputDiagnostics(): ReturnType<OutputHistoryBudget['snapshot']> { return this.outputHistory.snapshot() }

  retainSshContext(id: string, retained: boolean, history?: string): void {
    const session = this.sessions.get(id)
    if (!session || session.config.type !== ConnectionType.SSH) return
    if (!retained) { if (session.shelfOutputBuffer) this.outputHistory.release(session.shelfOutputBuffer); session.shelfOutputBuffer = undefined; session.pendingShelfHistory = undefined; return }
    const historyText = history ? captureSshContext(history) : undefined
    if (historyText) session.pendingShelfHistory = formatSshHistoryForTerminal(historyText)
    if (session.shelfOutputBuffer) return
    const buffer = this.createOutputBuffer(64 * 1024)
    if (historyText) buffer.append(historyText)
    buffer.append(session.outputBuffer?.getOutputSince(0, false).text ?? '')
    session.shelfOutputBuffer = buffer
  }
  private sessions: Map<string, Session> = new Map()
  private deletingSessions = new WeakMap<Session, Promise<boolean>>()
  private pendingSessionDeletions = new WeakSet<Session>()
  private failedDisconnects = new WeakSet<Session>()
  private disconnectingSessions = new WeakMap<Session, Promise<void>>()
  private pendingShellOpenings = new WeakMap<Session, Promise<void>>()
  private activeSessionId: string | null = null

  // 各渲染窗口中当前在终端页签/分屏里打开的会话集合（key = WebContents.id）
  private terminalOpenSessions: Map<number, Set<string>> = new Map()

  /**
   * 创建新会话
   */
  async createSession(config: SessionConfig): Promise<Session> {
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
    if (this.sessions.size >= 256) throw new OperationError('RESOURCE_LIMIT', 'Runtime session limit reached')
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

  /** 删除在异步断开前即失效，普通克隆不能再从残留 Map 项认领来源。 */
  isSessionDeleting(id: string): boolean {
    const session = this.sessions.get(id)
    return !!session && this.pendingSessionDeletions.has(session)
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values())
  }

  setOutputPaused(id: string, paused: boolean): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.outputPaused = paused
    if (session.connector?.capabilities?.pauseOutput !== false) session.connector?.setOutputPaused?.(paused)
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
   * 运行时切换会话编码（状态栏点击 / MCP create_session 复用落位）。
   * 只改运行时：session.config.terminal.encoding 让 readDoc 等按 config 读取的路径跟随，
   * 也让 reconnect 复用 config 重建连接器时保持切换值；connector.setEncoding 重建解码流。
   * 不写回 repository —— 同一会话重连保持，关闭后重开（从保存配置新建）才回到保存值。
   * 不动 updateSession 的 updatedAt/lastActiveAt（编码切换不算用户活动），
   * 但推 session:encoding-changed 让渲染层 live 读数跟随（handlers 转发到所有窗口）。
   * local 会话恒为 UTF-8（ConPTY 不走编码层，LocalConnector.setEncoding 是空实现）——
   * 前端已隐藏入口，这里再兜一层：返回 false 而不是「成功但无效果」。
   */
  setSessionEncoding(id: string, encoding: TerminalEncoding): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.config.type === ConnectionType.LOCAL) return false
    // 同值幂等短路：配置与连接器都已是该值时无事可做 —— 解码流重建会把半截多字节
    // 序列冲成替换字符（见 replaceDecoder 的 end() 收尾），「重选当前档」不该在终端
    // 里多落一个 �。connector 缺席（未连接）且配置已同值同样视为命中；config 与
    // connector 真值漂移则照常落位修复。短路返回 true（调用方语义是「该会话当前即
    // 此编码」），也不推事件 —— 值没变，渲染层读数本来就对
    if (session.config.terminal?.encoding === encoding && (!session.connector || session.connector.getEncoding() === encoding)) {
      return true
    }
    // spread 合并而非整体替换，保住 terminal 段其余字段（字体/回滚等）。
    // 注意是整体换新对象、不是原地改写：session.config 可能与 repository 的内存对象
    // 同源（MCP create_session 就地连接直接把 repository 对象传入 createSession），
    // 原地改写会把运行时编码污染进保存值（listSessions/编辑对话框立刻可见，
    // 之后任何落盘路径再把它写进 sessions.json）
    session.config = {
      ...session.config,
      terminal: { ...session.config.terminal, encoding }
    }
    session.connector?.setEncoding(encoding)
    log.info(`Session encoding switched: ${id} -> ${encoding}`)
    this.emit('session:encoding-changed', { sessionId: id, encoding })
    return true
  }

  /**
   * 删除运行时会话。先复用完整断开流程取消传输、清理连接器并撤销 token，再立即清除缓冲与 Map。
   */
  deleteSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return Promise.resolve(false)
    const pending = this.deletingSessions.get(session)
    if (pending) return pending

    // 先登记共享 Promise，再开始断开；同步事件中的重入删除也复用本次清理。
    let resolve!: (deleted: boolean) => void
    let reject!: (error: unknown) => void
    const deletion = new Promise<boolean>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
    this.pendingSessionDeletions.add(session)
    this.deletingSessions.set(session, deletion)
    void this.deleteSessionObject(id, session).then(resolve, reject)
    return deletion
  }

  private async deleteSessionObject(id: string, session: Session): Promise<boolean> {
    const outputBuffer = session.outputBuffer

    try {
      await this.disconnectSession(id)
      if (outputBuffer && !this.outputHistory.release(outputBuffer)) outputBuffer.clear()
      if (session.shelfOutputBuffer) this.outputHistory.release(session.shelfOutputBuffer)
      session.outputBuffer = undefined
      // 只移除本次清理的对象，旧删除不能按 ID 误删替代会话或发送其删除事件。
      if (this.sessions.get(id) === session) {
        await this.inputControl.forgetSession(id)
        this.sessions.delete(id)
        if (this.activeSessionId === id) this.activeSessionId = null
        for (const ids of this.terminalOpenSessions.values()) ids.delete(id)
        log.info(`Session deleted: ${id}`)
        this.emit('session:deleted', id)
      }
      this.pendingSessionDeletions.delete(session)
      return true
    } catch (err) {
      // 清理失败保留对象和删除意图；再次 delete 可重试，连接/克隆不能复活残留资源。
      log.warn(`Session cleanup on delete failed for ${id}:`, err)
      throw err
    } finally {
      this.deletingSessions.delete(session)
    }
  }

  /**
   * 连接会话。同一 Session 的并发调用复用同一个 Promise，完整串行化连接生命周期。
   */
  async connectSession(id: string, options: SessionConnectOptions = {}): Promise<Session> {
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    if (this.isSessionDeleting(id)) throw new Error(`Session is being deleted: ${id}`)
    assertNoSecretPlaceholders(session.config)
    if (session.config.local) assertResolvedSecrets(session.config.local)
    if (this.failedDisconnects.has(session)) throw new Error(`Previous disconnect failed: ${id}`)
    if (session.connectPromise) {
      if (!session.disconnectCleanup) return session.connectPromise
      try { await session.connectPromise } catch { /* 旧 attempt 被断开/替代 */ }
      if (this.sessions.get(id) !== session) throw new Error(`Session replaced: ${id}`)
      return this.connectSession(id, options)
    }

    const promise = this.connectSessionAttempt(id, session, options)
    session.connectPromise = promise
    try {
      return await promise
    } finally {
      if (session.connectPromise === promise) session.connectPromise = undefined
    }
  }

  private async connectSessionAttempt(id: string, session: Session, options: SessionConnectOptions): Promise<Session> {
    const disconnect = this.disconnectingSessions.get(session) ?? session.disconnectCleanup
    if (disconnect) await disconnect
    if (this.sessions.get(id) !== session) throw new Error(`Session replaced: ${id}`)
    // 等待断开清理期间可能开始删除，不能为即将移除的对象创建新连接器。
    if (this.isSessionDeleting(id)) throw new Error(`Session is being deleted: ${id}`)
    if (this.failedDisconnects.has(session)) throw new Error(`Previous disconnect failed: ${id}`)

    // 自然关闭/连接失败后的旧 connector 也必须回收后才能替换。
    if (session.connector && !disconnect) await this.disconnectSession(id)
    if (this.sessions.get(id) !== session || this.isSessionDeleting(id)) throw new Error(`Session replaced or deleting: ${id}`)
    session.disconnectCleanup = undefined
    const generation = (session.connectorGeneration ?? 0) + 1
    session.connectorGeneration = generation
    session.connector = undefined
    let connector: Session['connector']
    const isCurrentAttempt = (): boolean =>
      !this.closing &&
      this.sessions.get(id) === session &&
      !this.isSessionDeleting(id) &&
      session.disconnectCleanup === undefined &&
      session.connectorGeneration === generation &&
      (connector === undefined || session.connector === connector)

    session.status = ConnectionStatus.CONNECTING
    session.cwd = undefined  // 重连不残留上次连接的目录,由下方 tracker 重新落位
    this.emit('session:status', { id, status: ConnectionStatus.CONNECTING })

    // 连接信息由前端 TerminalView 显示（Xshell 风格）
    // 不再在终端发送中文连接信息

    try {
      // 根据类型创建连接器
      switch (session.config.type) {
        case ConnectionType.SSH:
          // 保存区只在本机保留上下文；历史配置中的 tmux 开关不再改变连接方式。
          session.connector = new SSHConnector(id, withRuntimeEncoding({ ...session.config.ssh as SSHConfig, keepSessionAlive: false, resumeSessionName: undefined }, session), { confirmHostKey: options.confirmHostKey })
          break
        case ConnectionType.TELNET:
          session.connector = new TelnetConnector(id, withRuntimeEncoding(session.config.telnet as TelnetConfig, session))
          break
        case ConnectionType.SERIAL:
          session.connector = new SerialConnector(id, withRuntimeEncoding(session.config.serial as SerialConfig, session))
          break
        case ConnectionType.LOCAL: {
          const extraEnv: Record<string, string> = tuiActivity.connectEnv(id)
          // 为本地 PTY 生成 per-session MCP token，注入到 PTY env。
          // PTY 内孵化的 Claude Code / MCP Server 子进程将自动继承，
          // 外部进程拿不到 -> 实现"MCP 仅对 LyShell 内部终端开放"。
          // 端口未就绪（HTTP 服务尚未启动）则跳过注入，PTY 仍可正常运行，只是无法连 MCP。
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

          // local 可能缺省（连接类型是 LOCAL 但未填 local 配置），空对象展开后
          // connector 走各自默认值（shell/cwd/env 全可选）。曾在此透传 terminal
          // 的 encoding，但 LocalConnector 从不读它 —— 真正的编码处理在
          // OutputBuffer/渲染层，死管道随 LocalConfig 统一（见 connectors/local.ts）一并移除。
          session.connector = new LocalConnector(id, { ...session.config.local }, extraEnv, { userDataDir: typeof app.getPath === 'function' ? app.getPath('userData') : undefined })
          break
        }
        default:
          throw new Error(`Unknown connection type: ${session.config.type}`)
      }

      // 先挂监听器，再 connect()：连接过程中（认证失败、网络错误）connector 可能 emit 'error'。
      // generation + Session/connector 身份校验，防旧 attempt 的迟到事件污染新连接。
      connector = session.connector
      if (!connector || !isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)
      session.connectionInstanceId = uuidv4()
      this.inputControl.bindSession(id, session.connectionInstanceId)
      if (connector.capabilities?.pauseOutput !== false) connector.setOutputPaused?.(session.outputPaused ?? false)

      if (session.outputBuffer) this.outputHistory.release(session.outputBuffer)
      session.outputBuffer = this.createOutputBuffer()
      session.outputHistoryGap = false
      if (session.config.type === ConnectionType.SSH && session.pendingShelfHistory) {
        const history = session.pendingShelfHistory
        session.pendingShelfHistory = undefined
        // 同时进入当前输出流和订阅初始缓冲，兼容 xterm 在连接前或连接后才建立订阅。
        session.outputBuffer.append(history)
        session.shelfOutputBuffer?.append('\n\n[LyShell: 以下为重新连接后的输出]\n')
        this.emit('terminal:data', { sessionId: id, data: history })
      }
      // local 会话挂工作目录解析器:输出流里的 OSC 报告(9;9 / 7)实时刷新,
      // 推 session:cwd-changed 给页签悬停详情卡。种子(spawn 目录)延到 connect()
      // 之后才取 —— getSpawnCwd 读 this.config 实时值,connect(config) 传新配置
      // 会整体替换,连接前读到的还是构造时的旧配置(当前调用链不传 config,防
      // 后续复用时种子与实际 spawn 目录分叉)。cmd 不发目录序列,停留在种子值
      // (pwsh/PSReadLine 2.1+ 每次 prompt 都会发)
      const remoteCwd = session.config.type === ConnectionType.SSH
      const cwdTracker = connector instanceof LocalConnector || remoteCwd ? new OscCwdTracker() : null
      connector.on('data', (data: string) => {
        if (!isCurrentAttempt()) return
        this.emit('terminal:data', { sessionId: id, data })
        session.outputBuffer?.append(data)
        session.shelfOutputBuffer?.append(data)
        const reported = cwdTracker?.push(data)
        const nextCwd = remoteCwd ? normalizeSshDirectory(reported) : reported
        if (nextCwd) {
          session.cwd = nextCwd
          this.emit('session:cwd-changed', { sessionId: id, cwd: nextCwd })
        }
      })
      connector.on('output-gap', () => {
        if (!isCurrentAttempt()) return
        session.outputBuffer?.clear()
        session.shelfOutputBuffer?.clear()
        session.outputHistoryGap = true
        this.emit('terminal:history-gap', { sessionId: id })
      })
      connector.on('close', () => {
        if (!isCurrentAttempt()) return
        void this.disconnectSession(id).catch((err) => {
          log.warn(`Natural disconnect cleanup failed for ${id}:`, err)
        })
      })
      connector.on('error', (error: Error) => {
        if (!isCurrentAttempt()) return
        session.status = ConnectionStatus.ERROR
        this.emit('session:status', { id, status: ConnectionStatus.ERROR, error: extractErrorMessage(error) })
      })

      // 在 connect 前记录恢复意图，不能被连接器回填的新 hostId 误判为旧进程附着。
      const resumedLocal = session.config.type === ConnectionType.LOCAL && !!session.config.local?.terminalHostId
      // 连接
      await connector.connect()
      if (!isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)

      // 连接成功后，shell 会自动输出欢迎信息，不需要额外显示

      if (!isCurrentAttempt()) throw new Error(`Connection superseded: ${id}`)
      session.status = ConnectionStatus.CONNECTED
      session.startupPending = !resumedLocal && !!session.config.startupCommands?.length
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

      // 工作目录初始落位:连接期间已检出 OSC 更新值时检出值优先(不被种子
      // 覆盖),否则回落 spawn 种子 —— 此时 connect 已跑完,getSpawnCwd 读到的
      // 必是本次连接实际使用的 config(见上方 tracker 创建处的说明)
      if (cwdTracker) {
        const spawnCwd = connector instanceof LocalConnector ? connector.getSpawnCwd() : null
        const reported = cwdTracker.getCwd()
        const cwd = remoteCwd ? normalizeSshDirectory(reported) : reported ?? spawnCwd
        if (cwd != null) {
          session.cwd = cwd
          this.emit('session:cwd-changed', { sessionId: id, cwd })
        }
      }

      if (session.connector instanceof LocalConnector && session.connector.localHostId) {
        session.config.local = { ...session.config.local, terminalHostId: session.connector.localHostId }
      }
      // 发送启动命令（如果有）
      if (!resumedLocal && session.config.startupCommands && session.config.startupCommands.length > 0) {
        // 本地终端启动快，200ms；远程连接需等待 shell 就绪，500ms
        const delay = session.config.type === ConnectionType.LOCAL ? 200 : 500
        await new Promise(resolve => setTimeout(resolve, delay))
        if (!isCurrentAttempt()) throw new OperationError('STALE_GENERATION', 'Startup connection changed')
        await this.sendStartupCommands(id, session, isCurrentAttempt)
      }
      session.startupPending = false
      this.emit('session:status', { id, status: ConnectionStatus.CONNECTED })

      return session

    } catch (error) {
      if (isCurrentAttempt()) {
        const errorMsg = extractErrorMessage(error as Error)
        // 失败也必须撤销 token、取消文件任务并释放原生句柄；前端 error 状态关闭会短路 IPC。
        try {
          await this.disconnectSession(id)
        } catch (cleanupError) {
          log.warn(`Failed connection cleanup could not be confirmed for ${id}:`, cleanupError)
        }
        if (this.sessions.get(id) === session && session.connectorGeneration === generation && !this.isSessionDeleting(id)) {
          session.status = ConnectionStatus.ERROR
          this.emit('session:status', { id, status: ConnectionStatus.ERROR, error: errorMsg })
        }
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
    session.startupPending = false
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
      mcpAuth.revokeSessionToken(id)
      await this.inputControl.unbindSession(id)
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
        // sendAndWait 已持有自己的 buffer 引用，回合结束即可 GC；无需用 30s 定时器额外保活。
        if (!session.pendingWaitLock && !this.outputHistory.release(bufferToClean)) bufferToClean.clear()
      }
    })()
    return session.disconnectCleanup
  }

  /**
   * 断开会话
   */
  disconnectSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return Promise.reject(new Error(`Session not found: ${id}`))
    const pending = this.disconnectingSessions.get(session)
    if (pending) return pending

    // 同步事件重入也共享完整关闭流程，连接必须等原生关闭与文件清理全部结束。
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const disconnect = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
    this.disconnectingSessions.set(session, disconnect)
    void this.disconnectSessionObject(id, session).then(resolve, reject)
    return disconnect
  }

  private async disconnectSessionObject(id: string, session: Session): Promise<void> {
    // 首个 await 前同步开始清理，阻止清理期间启动新的文件任务。
    const connector = session.connector
    const generation = session.connectorGeneration
    try {
      const cleanup = this.cleanupDisconnectedSession(id, generation, connector)
      try {
        // 克隆的 shell 回调可能迟到；创建落定前不能确认 connector 已完整关闭。
        const opening = this.pendingShellOpenings.get(session)
        if (opening) {
          await waitForShellOpeningForCleanup(opening)
        }
        if (connector) await connector.disconnect()
        if (connector instanceof LocalConnector && connector.localHostHasExited && session.config.local?.terminalHostId === connector.localHostId) {
          // 普通显式重连在确认旧进程结束后可新建 shell；保存区自己的旧宿主引用仍保留，
          // 其 restore 路径会探测旧宿主并拒绝用新进程冒充原任务。
          const local = { ...session.config.local }
          delete local.terminalHostId
          session.config.local = local
        }
      } finally {
        // 即使原生关闭失败也完成文件任务取消与撤权，但不得吞掉关闭错误。
        await cleanup
      }
      this.failedDisconnects.delete(session)
    } catch (err) {
      this.failedDisconnects.add(session)
      log.warn(`Connector disconnect failed for ${id}:`, err)
      throw err
    } finally {
      this.disconnectingSessions.delete(session)
    }
  }

  /**
   * 重连会话
   */
  async reconnectSession(id: string, options: SessionConnectOptions = {}): Promise<Session> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    if (this.isSessionDeleting(id)) throw new Error(`Session is being deleted: ${id}`)
    await this.disconnectSession(id)
    // 断开等待后复核身份，不能重连同 ID 的替代对象或删除中的旧会话。
    if (this.sessions.get(id) !== session) throw new Error(`Session replaced: ${id}`)
    if (this.isSessionDeleting(id)) throw new Error(`Session is being deleted: ${id}`)
    return await this.connectSession(id, options)
  }

  /**
   * 写入数据到会话
   */
  async writeToSession(id: string, data: string, control?: ControlHandle, authorized: () => boolean = () => true): Promise<void> {
    const pending = this.inputPending.get(id) ?? 0
    if (data.length > 1024 * 1024 || pending + data.length > 2 * 1024 * 1024 || this.totalInputPending + data.length > 8 * 1024 * 1024) {
      throw new OperationError('RESOURCE_LIMIT', 'Terminal input queue budget exceeded')
    }
    this.inputPending.set(id, pending + data.length)
    this.totalInputPending += data.length
    const previous = this.inputChains.get(id) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => this.dispatchInput(id, data, control, authorized))
    this.inputChains.set(id, run)
    try { await run } finally {
      this.totalInputPending -= data.length
      const remaining = (this.inputPending.get(id) ?? data.length) - data.length
      if (remaining > 0) this.inputPending.set(id, remaining)
      else this.inputPending.delete(id)
      if (this.inputChains.get(id) === run) this.inputChains.delete(id)
    }
  }

  private async dispatchInput(id: string, data: string, control: ControlHandle | undefined, authorized: () => boolean): Promise<void> {
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
    const session = this.sessions.get(id)
    const connector = session?.connector
    if (!session || !connector || session.status !== ConnectionStatus.CONNECTED) throw new OperationError('RESOURCE_NOT_FOUND', 'Terminal is not connected')
    if (!control || control.sessionId !== id) throw new OperationError('CONTROL_CONFLICT', 'Acquire terminal input control before writing')
    let offset = 0
    try {
    do {
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
    const fence = await this.inputControl.assertInput(control)
    const current = this.inputControl.currentSnapshot(id)
    if (this.sessions.get(id) !== session || session.connector !== connector || session.connectionInstanceId !== fence.connectionInstanceId
      || current?.lease?.leaseId !== fence.leaseId || current.lease.epoch !== fence.epoch || Date.now() >= current.lease.expiresAt) {
      throw new OperationError('STALE_GENERATION', 'Terminal input control changed before dispatch')
    }
    if (!authorized()) throw new OperationError('FORBIDDEN', 'Terminal input authorization was revoked')
    let end = Math.min(offset + 32 * 1024, data.length)
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]) && /[\uDC00-\uDFFF]/.test(data[end])) end--
    try { await (connector as BaseConnector).writeConfirmed(data.slice(offset, end), fence) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['rpc-timeout', 'disconnected'].includes(String(error.code))) {
        throw new OperationError('OUTCOME_UNKNOWN', 'Terminal input acknowledgement was lost; inspect output before sending more input', 'reconcile-first')
      }
      throw error
    }
    offset = end
    } while (offset < data.length)
    } catch (error) {
      if (offset > 0) throw new OperationError('OUTCOME_UNKNOWN', 'Terminal input was only partially acknowledged; inspect the terminal before sending more input', 'reconcile-first')
      throw error
    }
  }

  private async sendStartupCommands(id: string, session: Session, current: () => boolean): Promise<void> {
    const handle = await this.inputControl.acquire({ sessionId: id, identity: { principalId: 'internal:startup', source: 'internal' } })
    try {
      for (const command of session.config.startupCommands ?? []) {
        if (!current()) throw new OperationError('STALE_GENERATION', 'Startup connection changed')
        await this.writeToSession(id, command + '\r', handle, current)
      }
    } finally { await this.inputControl.release(handle) }
  }

  async acquireInput(id: string, identity: ControllerIdentity, options: { takeover?: boolean; contextConfirmed?: boolean } = {}): Promise<ControlHandle> {
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
    if (this.sessions.get(id)?.startupPending) throw new OperationError('CONTROL_CONFLICT', 'Configured startup input is still being sent')
    const handle = await this.inputControl.acquire({ sessionId: id, identity, ...options })
    const lockedByMcp = identity.source === 'automation'
    const session = this.sessions.get(id)
    if (session) session.lockedByMcp = lockedByMcp
    this.emit('session:mcp-lock-changed', { sessionId: id, lockedByMcp })
    return handle
  }

  async releaseInput(control: ControlHandle): Promise<void> {
    await this.inputControl.release(control)
    if (this.inputControl.currentSnapshot(control.sessionId)?.lease?.source !== 'automation') {
      const session = this.sessions.get(control.sessionId)
      if (session) session.lockedByMcp = false
      this.emit('session:mcp-lock-changed', { sessionId: control.sessionId, lockedByMcp: false })
    }
  }

  /**
   * 调整会话终端尺寸
   */
  resizeSession(id: string, cols: number, rows: number): void {
    if (this.closing) return
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
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
    if (this.sessions.size >= 256) throw new OperationError('RESOURCE_LIMIT', 'Runtime session limit reached')
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

    const owner = pluginResources.owner(sourceSessionId) ?? sourceSession.config.ownerPluginId
    const resourceGeneration = owner ? pluginResources.generation(owner) : 0

    // 创建新会话 ID
    const newId = uuidv4()

    // 克隆会话保持源会话名称不变（前端 PaneTabBar 会根据 createdAt 显示序号）
    const newName = sourceSession.config.name

    // 创建新会话配置
    const newConfig: SessionConfig = {
      ...sourceSession.config,
      ownerPluginId: owner,
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

    // 创建新的 SSH connector，共享 client。encoding 随源会话运行时值派生
    // （唯一派生点 withRuntimeEncoding，口径同 connectSessionAttempt 的三分支）
    const newConnector = new SSHConnector(newId, withRuntimeEncoding({ ...sourceSession.config.ssh as SSHConfig, keepSessionAlive: false, resumeSessionName: undefined, resumeDirectory: undefined }, sourceSession))
    newConnector.setSharedClient(sshClient)  // 共享 SSH client

    newSession.connector = newConnector
    newSession.connectionInstanceId = uuidv4()
    this.inputControl.bindSession(newId, newSession.connectionInstanceId)

    // 在首个异步 shell 请求前完成缓冲和监听绑定，否则首包/关闭/错误会落进空窗。
    newSession.outputBuffer = this.createOutputBuffer()
    let openingError: Error | undefined
    const isCurrentClone = (): boolean =>
      !this.closing && this.sessions.get(newId) === newSession && newSession.connector === newConnector &&
      !newSession.disconnectCleanup && !this.isSessionDeleting(newId)
    const cloneCwdTracker = new OscCwdTracker()
    newConnector.on('data', (data: string) => {
      if (!isCurrentClone()) return
      this.emit('terminal:data', { sessionId: newId, data })
      newSession.outputBuffer?.append(data)
      newSession.shelfOutputBuffer?.append(data)
      const cwd = normalizeSshDirectory(cloneCwdTracker.push(data))
      if (cwd) { newSession.cwd = cwd; this.emit('session:cwd-changed', { sessionId: newId, cwd }) }
    })
    newConnector.on('close', () => {
      if (!isCurrentClone()) return
      void this.disconnectSession(newId).catch(err => log.warn(`Clone disconnect cleanup failed for ${newId}:`, err))
    })
    newConnector.on('error', (error: Error) => {
      if (!isCurrentClone()) return
      openingError = error
      newSession.status = ConnectionStatus.ERROR
      this.emit('session:status', { id: newId, status: ConnectionStatus.ERROR, error: extractErrorMessage(error) })
    })

    // 首个 await 前登记，禁用可连同正在开启的 shell channel 一并回收。
    if (owner && !pluginResources.track(owner, newId, resourceGeneration)) {
      await this.deleteSession(newId)
      return null
    }

    // 先登记原始创建任务，删除等待它而不是等待 cloneChannel（后者也会加入删除）。
    // 必须在调用连接器前落位，覆盖同步事件重入删除。
    let resolveOpening!: () => void
    let rejectOpening!: (error: unknown) => void
    const opening = new Promise<void>((resolve, reject) => { resolveOpening = resolve; rejectOpening = reject })
    this.pendingShellOpenings.set(newSession, opening)

    // 启动 shell
    try {
      try {
        newConnector.startShellOnly().then(resolveOpening, rejectOpening)
      } catch (error) {
        rejectOpening(error)
      }
      await opening

      if (openingError) throw openingError

      if (this.closing || this.sessions.get(newId) !== newSession || this.sessions.get(sourceSessionId) !== sourceSession
        || sourceSession.status !== ConnectionStatus.CONNECTED || newSession.disconnectCleanup
        || (owner && !pluginResources.isCurrent(owner, resourceGeneration))) {
        throw new Error('Cloned channel was cancelled while opening')
      }

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
      // 共享删除回执；关闭失败保留运行时与归属，不能吞错后丢掉重试入口。
      await this.deleteSession(newId)
      pluginResources.forgetLiveSession(newId)
      return null
    } finally {
      this.pendingShellOpenings.delete(newSession)
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
   * 通过空闲检测/模式匹配/最大超时判断命令完成。
   *
   * 外部正则的**编译与执行一律在隔离子进程**（PatternMatcher）内完成，主线程只做同步形态校验：
   *   1. 同步形态/长度校验 → 2. 原子取会话等待锁并记 owner → 3. Worker 内编译校验
   *   → 4. 复核会话/连接代际/控制租约/授权 → 5. 记游标+epoch、挂监听、走受控写入
   *   → 6. 每次 Worker 返回后复核同一会话实例/仍授权/无输出缺口 → 7. 任何出口都清理锁/监听/预算。
   */
  async sendAndWait(id: string, options: SendAndWaitOptions): Promise<SendAndWaitResult> {
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')

    // ── 1) 同步形态校验：此时未取锁、未取配额、未写终端 ──────────────────────
    if (!options || typeof options !== 'object') throw new OperationError('INVALID_ARGUMENT', 'Invalid wait options')
    if (options.signal?.aborted) throw new PatternMatchError('MATCH_CANCELLED')
    if (typeof options.text !== 'string') throw new OperationError('INVALID_ARGUMENT', 'Wait text must be a string')
    if (options.text.length > 2 * 1024 * 1024) throw new OperationError('INVALID_ARGUMENT', 'Wait text exceeds the maximum length')
    // 显式给了非 string 的 pattern（null / number / object）是参数错误：
    // 绝不能当成「未提供」继续发送输入，否则调用方的等待意图被静默丢弃。
    const rawPattern = options.waitForPattern
    if (rawPattern !== undefined && typeof rawPattern !== 'string') {
      throw new PatternMatchError('PATTERN_NOT_A_STRING')
    }
    const patternText = typeof rawPattern === 'string' ? rawPattern : ''
    const hasPattern = patternText.length > 0
    if (!hasPattern && options.waitForPatternMode !== undefined) {
      // 没有 pattern 却给了 mode：调用方语义含糊，按参数错误拒绝（不默认成内置提示符）。
      throw new PatternMatchError('PATTERN_MODE_WITHOUT_PATTERN')
    }
    // 只做长度/模式校验，不编译正则（编译必须发生在 Worker 内）。
    const spec: PatternSpec | null = hasPattern
      ? patternMatcher.validate({ pattern: patternText, mode: options.waitForPatternMode })
      : null

    const session = this.sessions.get(id)
    if (!session || !session.connector || session.status !== ConnectionStatus.CONNECTED) {
      throw new OperationError('RESOURCE_NOT_FOUND', 'Terminal is not connected')
    }
    if (!session.outputBuffer) throw new OperationError('RESOURCE_NOT_FOUND', 'Terminal output is not available')
    const connector = session.connector
    // 固定缓冲区实例：本次等待只认这一个 buffer，换掉即视为会话被替换。
    const buffer = session.outputBuffer
    if (session.pendingWaitLock) throw new OperationError('CONTROL_CONFLICT', 'A send_and_wait is already in progress for this session')

    const connectionInstanceId = session.connectionInstanceId
    const waitMs = Math.min(Math.max(options.waitMs ?? 2000, 0), 55000)
    const idleMs = Math.min(Math.max(options.idleMs ?? 300, 0), 60000)
    // maxWaitMs 上限钳制：客户端 HTTP 超时 60s，留 5s 余量，防止客户端先超时、服务端仍占用锁
    const maxWaitMs = Math.min(Math.max(options.maxWaitMs ?? 10000, 100), 55000)
    // 总期限从**编译前**的单调时间起算：compile / 排队 / 观测共用同一预算。
    // 短总期限的调用不会因为「编译另给 5s」而在超时之后仍然写入输入。
    const startedAt = performance.now()
    const deadline = startedAt + maxWaitMs

    let processedText = processInputEscapeSequences(options.text)

    // autoNewline：末尾是普通可见字符时自动补一个 \n，避免调用方忘记加换行导致命令只回显不执行；
    // 末尾已是 \n/\r 或控制序列时不补。核心层默认 false（保持"不补换行"的最小语义）；
    // MCP 边界层统一默认 true：handleSendInput 在 http-server 内直接调 appendAutoNewline，
    // handleSendAndWait 经此核心函数（data.autoNewline !== false opt-in），使外部 MCP 调用方免于手写 \n。
    // 新增非 MCP 调用方需自行决定是否传 autoNewline:true。
    const enter = process.platform === 'win32' && session.config.type === ConnectionType.LOCAL ? '\r' : '\n'
    processedText = appendAutoNewline(processedText, options.autoNewline === true, enter)

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

    const callerKey = options.callerKey?.trim() || options.control?.principalId || 'anonymous'
    // 等待器配额覆盖整个 sendAndWait（编译 + 写入 + 观测），而不是单次 match。
    // 配额不足时同步抛 MATCH_QUEUE_FULL（RESOURCE_LIMIT/safe）：此时还没有任何副作用。
    const waiter = patternMatcher.acquireWaiter(callerKey)

    let lastDataAt = performance.now()
    const dataListener = (): void => { lastDataAt = performance.now() }
    let listenerAttached = false
    let inputAttempted = false
    let startCursor = 0
    let outputEpoch = 0
    let lockOwner: symbol | null = null

    try {
      // ── 2) 原子取锁：同步置位并记 owner，finally 只释放自己的锁 ──────────────
      lockOwner = Symbol('sendAndWait')
      session.pendingWaitLock = true
      session.pendingWaitOwner = lockOwner

      // ── 3) 模式编译校验在 Worker 内：失败时还没有任何终端写入 ──────────────
      if (spec) {
        await patternMatcher.compile(spec, {
          callerKey,
          timeoutMs: Math.max(1, Math.min(5000, deadline - performance.now())),
          signal: options.signal
        })
      }
      // 编译/排队已经耗尽总期限：不得再发送输入（无副作用，按可安全重试的排队超时上报）。
      if (performance.now() >= deadline) throw new PatternMatchError('MATCH_QUEUE_TIMEOUT')

      // ── 4) Worker 返回后重新确认会话、连接代际、缓冲区、控制租约与当前授权 ──
      await this.assertSendAndWaitReady(id, session, connector, connectionInstanceId, buffer, options)
      if (performance.now() >= deadline) throw new PatternMatchError('MATCH_QUEUE_TIMEOUT')

      // ── 5) 先挂监听并记录游标/epoch，再走既有受控写入路径 ──────────────────
      connector.on('data', dataListener)
      listenerAttached = true
      startCursor = buffer.getWriteCursor()
      outputEpoch = buffer.getOutputEpoch()
      if (processedText) await this.writeToSession(id, processedText, options.control, () => {
        // 取消和期限均在实际分片派发前复核；已确认的部分输入仍由 dispatchInput 报 unknown。
        if (options.signal?.aborted) throw new PatternMatchError('MATCH_CANCELLED')
        if (performance.now() >= deadline) throw new PatternMatchError('MATCH_QUEUE_TIMEOUT')
        return options.authorizeInput?.() ?? true
      })
      inputAttempted = processedText.length > 0

      let lastSnapshotKey = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
        // ── 6) 每轮（以及每次 Worker 返回后）复核同一会话实例仍授权、无输出缺口 ──
        this.assertSendAndWaitLive(id, session, connector, connectionInstanceId, buffer)
        if (options.signal?.aborted) throw new PatternMatchError('MATCH_CANCELLED')
        if (options.authorizeInput && !options.authorizeInput()) {
          throw new OperationError('FORBIDDEN', 'Terminal input authorization was revoked')
        }
        this.assertOutputGapFree(buffer, startCursor, outputEpoch, 'Output history has a gap; reconcile before sending more input')

        const idleSince = performance.now() - lastDataAt

        // 模式匹配检测：同时在 raw 与 ANSI 清洗后两种基底上匹配（Worker 内执行）。
        // 默认 prompt 正则（[$#>%]\s*$）依赖清洗后的 $ 锚定（raw 末尾常带 ANSI 复位码）；
        // 带 ANSI 码的自定义正则只在 raw 上命中。两者取或，避免基底选择导致漏判。
        // 只在输出游标/缺口位置变化时重新匹配，避免同一快照反复占用 Worker。
        if (spec) {
          const snapshotKey = `${buffer.getWriteCursor()}/${buffer.getEarliestCursor()}/${outputEpoch}`
          if (snapshotKey !== lastSnapshotKey) {
            lastSnapshotKey = snapshotKey
            const rawOutput = buffer.getOutputSince(startCursor, false).text
            const cleanOutput = buffer.getOutputSince(startCursor, true).text
            const matched = await this.matchOnce(
              spec,
              [rawOutput, cleanOutput],
              callerKey,
              Math.max(1, deadline - performance.now()),
              options.signal
            )
            // Worker 返回后必须重新确认（true / false 都一样）：
            // 旧结果不能落到已被替换 / 授权已撤销 / 出现输出缺口的会话上。
            this.assertSendAndWaitLive(id, session, connector, connectionInstanceId, buffer)
            if (options.signal?.aborted) throw new PatternMatchError('MATCH_CANCELLED')
            if (options.authorizeInput && !options.authorizeInput()) {
              throw new OperationError('FORBIDDEN', 'Terminal input authorization was revoked')
            }
            this.assertOutputGapFree(buffer, startCursor, outputEpoch, 'Output history has a gap; reconcile before sending more input')
            if (matched) {
              return finalize(cleanOutput, true, true, performance.now() - startedAt)
            }
          }
        }

        const elapsed = performance.now() - startedAt
        // 空闲检测：超过 waitMs 且空闲超过 idleMs
        if (elapsed >= waitMs && idleSince >= idleMs) {
          return finalize(buffer.getOutputSince(startCursor, true).text, true, false, elapsed)
        }
        // 最大超时
        if (elapsed >= maxWaitMs) {
          return finalize(buffer.getOutputSince(startCursor, true).text, false, false, elapsed)
        }
        // 50ms 轮询（不超过剩余预算）
        await this.delay(Math.min(50, Math.max(1, deadline - performance.now())), options.signal)
      }
    } catch (error) {
      // ── 输入已经发出：任何观测失败都只能是「结果未知」，绝不能标成可安全重试 ──
      // （编译 / 取锁 / 写入之前的失败仍保留原始 code，例如 INVALID_ARGUMENT / CONTROL_CONFLICT。）
      if (inputAttempted) throw asOutcomeUnknownError(error)
      throw error
    } finally {
      // ── 7) 任何出口都清理监听器、只释放自己的锁/配额、归还被替换的缓冲区预算 ──
      if (listenerAttached) connector.off('data', dataListener)
      if (lockOwner && session.pendingWaitOwner === lockOwner) {
        session.pendingWaitLock = false
        session.pendingWaitOwner = undefined
      }
      waiter.release()
      if (session.outputBuffer !== buffer) this.outputHistory.release(buffer)
    }
  }

  /**
   * 只读等待模式命中（供 MCP wait_for_prompt / tail_until）：不写终端、不取 send_and_wait 锁。
   * 匹配同样在隔离子进程内执行；`authorizeObservation` 每轮复核，撤销立即停止。
   * 观察范围与既有语义一致：`recent` 看最近 N 行；`new-output` 只看记录游标之后（可先查一次历史）。
   */
  async waitForPattern(id: string, options: WaitForPatternOptions = {}): Promise<WaitForPatternResult> {
    if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
    if (!options || typeof options !== 'object') throw new OperationError('INVALID_ARGUMENT', 'Invalid wait options')

    // 非 string pattern 是参数错误：不能当成「未提供」退回内置提示符。
    if (options.pattern !== undefined && typeof options.pattern !== 'string') {
      throw new PatternMatchError('PATTERN_NOT_A_STRING')
    }
    const patternText = typeof options.pattern === 'string' ? options.pattern : ''
    const hasPattern = patternText.trim().length > 0
    if (!hasPattern && options.mode !== undefined) {
      // 无 pattern 时只能用内置提示符正则；显式 mode（哪怕 regex）都是含糊调用。
      throw new PatternMatchError('PATTERN_MODE_WITHOUT_PATTERN')
    }
    // 内置提示符固定 regex；自定义 pattern 缺省 regex，可由调用方显式要求 literal。
    const spec = patternMatcher.validate(
      hasPattern ? { pattern: patternText, mode: options.mode } : { pattern: BUILTIN_PROMPT_PATTERN, mode: 'regex' }
    )

    const session = this.sessions.get(id)
    if (!session || !session.connector || session.status !== ConnectionStatus.CONNECTED) {
      throw new OperationError('RESOURCE_NOT_FOUND', 'Terminal is not connected')
    }
    if (!session.outputBuffer) throw new OperationError('RESOURCE_NOT_FOUND', 'Terminal output is not available')
    const connector = session.connector
    // 固定缓冲区实例：等待期间 buffer 被换掉即视为会话被替换，不能拿旧内容当结果。
    const buffer = session.outputBuffer
    const connectionInstanceId = session.connectionInstanceId
    const scope: WaitPatternScope = options.scope ?? 'new-output'
    const historyLines = Math.min(Math.max(options.historyLines ?? 500, 1), 1000)
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30000, 100), 300000)
    const idleMs = Math.min(Math.max(options.idleMs ?? 0, 0), 60000)
    const pollMs = Math.min(Math.max(options.pollMs ?? 250, 25), 5000)
    const callerKey = options.callerKey?.trim() || 'anonymous'
    // 只读等待同样占用「等待器」配额：整个调用期间有效，而不是每次 match 各占一份。
    const waiter = patternMatcher.acquireWaiter(callerKey)

    // 单调时钟：只读等待可能持续数十秒，不能受系统时间调整影响。
    const startedAt = performance.now()
    const startCursor = buffer.getWriteCursor()
    const outputEpoch = buffer.getOutputEpoch()
    let sawOutput = false
    const dataListener = (): void => { sawOutput = true }
    connector.on('data', dataListener)

    /** 用指定快照构造结果：命中时必须返回真正被匹配的那份 bases，而不是事后重算的新输出。 */
    const resultFrom = (
      bases: { raw: string; clean: string },
      matched: boolean,
      settled: boolean,
      reason: WaitForPatternResult['reason']
    ): WaitForPatternResult => ({
      matched,
      settled,
      reason,
      output: bases.raw,
      cleanOutput: bases.clean,
      elapsedMs: performance.now() - startedAt,
      pattern: spec.pattern,
      mode: spec.mode
    })
    const currentBases = (): { raw: string; clean: string } => this.waitPatternBases(buffer, scope, historyLines, startCursor)
    const result = (matched: boolean, settled: boolean, reason: WaitForPatternResult['reason']): WaitForPatternResult =>
      resultFrom(currentBases(), matched, settled, reason)

    /** 观察身份：会话实例、连接、代际都必须还是开始等待时的那一套（断连也算同一终端）。 */
    const sameTerminal = (): boolean =>
      this.sessions.get(id) === session
      && session.connector === connector
      && (connectionInstanceId === undefined || session.connectionInstanceId === connectionInstanceId)
    const disconnected = (): boolean => session.status !== ConnectionStatus.CONNECTED
    /** 缓冲区实例：连接被替换一代时它会换掉；断连时可能被释放，因此只要求在「仍连接」时一致。 */
    const bufferCurrent = (): boolean => session.outputBuffer === buffer
    /** 断连结果不读缓冲区：断开后旧快照既不可信也不保证还存在。 */
    const disconnectedResult = (): WaitForPatternResult => ({
      matched: false,
      settled: false,
      reason: 'disconnected',
      output: '',
      cleanOutput: '',
      elapsedMs: performance.now() - startedAt,
      pattern: spec.pattern,
      mode: spec.mode
    })
    /** 授权优先于断连返回：撤销必须立刻暴露，不能被「正常 unmatched」掩盖。 */
    const assertObservationAuthorized = (): void => {
      if (options.authorizeObservation && !options.authorizeObservation()) {
        throw new PatternMatchError('MATCH_AUTHORIZATION_REVOKED')
      }
    }
    const assertNoGap = (): void => {
      this.assertOutputGapFree(buffer, startCursor, outputEpoch, 'Output history has a gap; reconcile before waiting again')
    }
    /** 每轮/每次 Worker 返回后的统一复核；断连返回 true 表示应立刻以 unmatched 结束。 */
    const recheck = (): boolean => {
      if (!sameTerminal()) {
        throw new OperationError('STALE_GENERATION', 'Terminal changed while waiting for output', 'safe')
      }
      assertObservationAuthorized()
      if (disconnected()) return true
      // 仍连接但缓冲区被换掉：属于连接换代，旧游标/快照不能再用。
      if (!bufferCurrent()) {
        throw new OperationError('STALE_GENERATION', 'Terminal changed while waiting for output', 'safe')
      }
      assertNoGap()
      return false
    }

    try {
      let lastSnapshotKey = ''
      let historyChecked = false
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
        // 会话/连接/缓冲区被换掉：不再返回旧 buffer 的内容，调用方按代际失效处理。
        if (recheck()) return disconnectedResult()

        // 观察范围：recent 始终看最近行；new-output 首次可按调用方要求先看历史，之后只看新输出。
        const useHistory = scope === 'recent' || (!historyChecked && options.checkHistoryFirst === true)
        const snapshotKey = `${useHistory ? 'recent' : 'new'}:${buffer.getWriteCursor()}/${buffer.getEarliestCursor()}/${outputEpoch}`
        if (snapshotKey !== lastSnapshotKey) {
          lastSnapshotKey = snapshotKey
          const bases = useHistory
            ? { raw: buffer.getRecentLines(historyLines, false).text, clean: buffer.getRecentLines(historyLines, true).text }
            : { raw: buffer.getOutputSince(startCursor, false).text, clean: buffer.getOutputSince(startCursor, true).text }
          let matched: boolean
          try {
            matched = await this.matchOnce(spec, [bases.raw, bases.clean], callerKey,
              Math.max(1, timeoutMs - (performance.now() - startedAt)), options.signal)
          } catch (error) {
            // 只读总期限结束是正常 unmatched；独立的正则执行硬超时仍保留 RESOURCE_LIMIT/never。
            if (error instanceof PatternMatchError && error.reason === 'MATCH_QUEUE_TIMEOUT'
              && performance.now() - startedAt >= timeoutMs) {
              if (recheck()) return disconnectedResult()
              return result(false, false, 'timeout')
            }
            throw error
          }
          // Worker 返回后重新确认：结果只能落到同一个会话实例/连接/缓冲区上。
          if (recheck()) return disconnectedResult()
          // 命中时返回真正被 Worker 匹配的那份快照（历史预检命中时不能返回空 output）。
          if (matched) return resultFrom(bases, true, true, 'matched')
        }
        if (useHistory) historyChecked = true

        const elapsed = performance.now() - startedAt
        if (elapsed >= timeoutMs) return result(false, false, 'timeout')
        // idleMs>0 只用于「整个窗口内完全没有新输出」的提前结束；一旦有输出就等到命中或超时。
        if (idleMs > 0 && !sawOutput && elapsed >= idleMs) return result(false, true, 'idle')

        await this.delay(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)), options.signal)
      }
    } finally {
      connector.off('data', dataListener)
      waiter.release()
    }
  }

  /** 观察基底：raw 与 ANSI 清洗后各一份，二者取或匹配（返回给调用方的展示也来自这里）。 */
  private waitPatternBases(
    buffer: OutputBuffer,
    scope: WaitPatternScope,
    historyLines: number,
    startCursor: number
  ): { raw: string; clean: string } {
    if (scope === 'recent') {
      return { raw: buffer.getRecentLines(historyLines, false).text, clean: buffer.getRecentLines(historyLines, true).text }
    }
    return { raw: buffer.getOutputSince(startCursor, false).text, clean: buffer.getOutputSince(startCursor, true).text }
  }

  /** 单次隔离匹配；Worker 侧错误统一收敛成固定 code/reason 的 PatternMatchError。 */
  private async matchOnce(
    spec: PatternSpec,
    inputs: string[],
    callerKey: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const outcome = await patternMatcher.match({ spec, inputs, callerKey, timeoutMs, signal })
      return outcome.matched
    } catch (error) {
      throw asPatternMatchError(error)
    }
  }

  /** 写终端之前的再确认：会话实例/代际/缓冲区/租约/授权都仍是取锁时的那一套。 */
  private async assertSendAndWaitReady(
    id: string,
    session: Session,
    connector: BaseConnector,
    connectionInstanceId: string | undefined,
    buffer: OutputBuffer,
    options: SendAndWaitOptions
  ): Promise<void> {
    /** 同步可见的写前状态（含缓冲区实例）；任何一项不符都不能写终端。 */
    const assertReadySync = (): void => {
      if (options.signal?.aborted) throw new PatternMatchError('MATCH_CANCELLED')
      if (this.closing) throw new OperationError('FORBIDDEN', 'Application is shutting down')
      if (this.sessions.get(id) !== session || session.connector !== connector || session.status !== ConnectionStatus.CONNECTED) {
        throw new OperationError('STALE_GENERATION', 'Terminal changed before sending input', 'safe')
      }
      if (connectionInstanceId !== undefined && session.connectionInstanceId !== connectionInstanceId) {
        throw new OperationError('STALE_GENERATION', 'Terminal connection was replaced before sending input', 'safe')
      }
      // 缓冲区被替换说明会话已换了一代：旧游标/epoch 不能再用于本次等待。
      if (session.outputBuffer !== buffer) {
        throw new OperationError('STALE_GENERATION', 'Terminal changed before sending input', 'safe')
      }
      if (options.control && options.control.sessionId !== id) {
        throw new OperationError('CONTROL_CONFLICT', 'Terminal input control changed before dispatch')
      }
      if (options.authorizeInput && !options.authorizeInput()) {
        throw new OperationError('FORBIDDEN', 'Terminal input authorization was revoked')
      }
    }

    assertReadySync()
    if (options.control) {
      try {
        await this.inputControl.assertInput(options.control)
      } catch {
        throw new OperationError('CONTROL_CONFLICT', 'Terminal input control changed before dispatch')
      }
      // assertInput 是异步的：await 期间连接/锁/授权都可能变化，必须再核对一遍再写。
      assertReadySync()
    }
  }

  /** 等待/观察期间的存活断言：连接/缓冲区被替换 → STALE_GENERATION（输入已发出，需先对账）。 */
  private assertSendAndWaitLive(
    id: string,
    session: Session,
    connector: BaseConnector,
    connectionInstanceId: string | undefined,
    buffer: OutputBuffer
  ): void {
    if (this.sessions.get(id) !== session || session.connector !== connector || session.outputBuffer !== buffer) {
      throw new OperationError('STALE_GENERATION', 'Terminal connection was replaced while observing output', 'reconcile-first')
    }
    if (connectionInstanceId !== undefined && session.connectionInstanceId !== connectionInstanceId) {
      throw new OperationError('STALE_GENERATION', 'Terminal connection was replaced while observing output', 'reconcile-first')
    }
    if (session.status !== ConnectionStatus.CONNECTED) {
      throw new OperationError('OUTCOME_UNKNOWN', 'Terminal disconnected while observing output', 'reconcile-first')
    }
  }

  /**
   * 输出缺口断言：epoch 变化（缓冲区被清空/换过一代）或最早可用游标越过起点，
   * 都说明 startCursor 之后的内容已不完整，不能拿不完整的片段声称「未命中」。
   */
  private assertOutputGapFree(buffer: OutputBuffer, startCursor: number, outputEpoch: number, message: string): void {
    if (buffer.getOutputEpoch() !== outputEpoch || buffer.getEarliestCursor() > startCursor) {
      throw new OperationError('OUTCOME_UNKNOWN', message, 'reconcile-first')
    }
  }

  /** 可中止的定时等待：中止信号触发时立刻返回，不留下计时器。 */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PatternMatchError('MATCH_CANCELLED'))
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new PatternMatchError('MATCH_CANCELLED'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
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
