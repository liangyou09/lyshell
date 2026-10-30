import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { OperationError } from '@shared/operation'
import { SSHFileClient } from './ssh-file-client'
import { cleanCommandOutput, type CommandDispatchGuard } from './ssh-command-executor'
import { CommandOutputCollector } from './command-output'
import { ShellCommandOutput } from './shell-command-output'
import type {
  CancelReason,
  CommandExecutionHandle,
  CommandResult,
  ResourceCloseResult
} from '../commands/types'

type PendingCommand = {
  command: string
  onData?: (chunk: string) => void
  assertCurrent?: CommandDispatchGuard
  reserveBytes?: (deltaBytes: number) => void
  /** shell 初始化命令是否已写入（授权变化时决定错误语义）。 */
  initialized: boolean
  /** 用户命令本身是否已写入通道（决定远端是否可能已执行）。 */
  commandWritten: boolean
  /** 已请求创建独立 channel，取消后必须等待迟到的打开/关闭回执。 */
  openRequested: boolean
  finish: (error?: Error, result?: CommandResult) => void
  close: (result: ResourceCloseResult) => void
}

export interface SSHShellCommandOptions {
  command: string
  timeoutMs?: number
  onData?: (chunk: string) => void
  reserveBytes?: (deltaBytes: number) => void
  signal?: AbortSignal
  assertCurrent?: CommandDispatchGuard
}

const NOT_DISPATCHED_CLOSE: ResourceCloseResult = {
  state: 'closed',
  localClosed: true,
  remoteTerminated: 'not-dispatched'
}

/** 保留进入命令的持久 shell；命令串行执行，关闭后拒绝所有等待者。 */
export class SSHCommandShell {
  private channel: ClientChannel | undefined
  private generation = 0
  private queue: PendingCommand[] = []
  private active: PendingCommand | undefined
  private output: ShellCommandOutput | undefined

  constructor(private sshFileClient: SSHFileClient, private shellEnterCommands: string) {}

  async execRaw(command: string, timeout = 30000, assertCurrent?: CommandDispatchGuard): Promise<string> {
    return this.executeCommand({ command, timeoutMs: timeout, assertCurrent }).result.then(result => result.output)
  }

  execStream(command: string, timeout: number, onData: (chunk: string) => void, signal?: AbortSignal, assertCurrent?: CommandDispatchGuard): Promise<CommandResult> {
    return this.executeCommand({ command, timeoutMs: timeout, onData, signal, assertCurrent }).result
  }

  /** 带资源关闭回执的执行入口；共享 shell 的通道在取消/超时时整体重置。 */
  executeCommand(options: SSHShellCommandOptions): CommandExecutionHandle {
    const timeoutMs = options.timeoutMs ?? 30000
    let resultSettled = false
    let closeSettled = false
    let timer: NodeJS.Timeout | undefined

    let resolveResult!: (result: CommandResult) => void
    let rejectResult!: (error: Error) => void
    let resolveClose!: (result: ResourceCloseResult) => void
    const result = new Promise<CommandResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const resourceClosed = new Promise<ResourceCloseResult>(resolve => { resolveClose = resolve })

    const cleanupListeners = (): void => {
      if (timer) { clearTimeout(timer); timer = undefined }
      options.signal?.removeEventListener('abort', onAbort)
    }

    const item: PendingCommand = {
      command: options.command,
      onData: options.onData,
      assertCurrent: options.assertCurrent,
      reserveBytes: options.reserveBytes,
      initialized: false,
      commandWritten: false,
      openRequested: false,
      finish: (error, commandResult) => {
        if (resultSettled) return
        resultSettled = true
        cleanupListeners()
        if (error) rejectResult(error)
        else resolveResult(commandResult!)
      },
      close: close => {
        if (closeSettled) return
        closeSettled = true
        resolveClose(close)
      }
    }

    const cancel = (error: Error): void => {
      if (resultSettled) return
      if (this.active === item) {
        this.reset(error)
        return
      }
      this.queue = this.queue.filter(queued => queued !== item)
      item.close(NOT_DISPATCHED_CLOSE)
      item.finish(error)
    }

    const onAbort = (): void => cancel(new Error('Command aborted'))

    if (options.signal?.aborted) {
      item.close(NOT_DISPATCHED_CLOSE)
      item.finish(new Error('Command aborted'))
      return { result, resourceClosed, cancel: () => {} }
    }

    timer = setTimeout(() => cancel(Object.assign(new Error('Command timeout'), { reason: 'COMMAND_TIMEOUT' })), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    this.queue.push(item)
    this.next()

    return {
      result,
      resourceClosed,
      cancel(reason: CancelReason) {
        if (resultSettled) return
        cancel(new Error(reason === 'client' ? 'Command aborted' : `Command aborted (${reason})`))
      }
    }
  }

  private next(): void {
    if (this.active) return
    const item = this.queue.shift()
    if (!item) return
    this.active = item
    const generation = this.generation
    void this.openChannel(item).then(channel => {
      if (generation !== this.generation || this.active !== item) return
      this.assertCurrent(item)
      const marker = `___END_MARKER_UUID_${randomUUID()}___`
      const collector = new CommandOutputCollector({ reserveBytes: item.reserveBytes })
      this.output = new ShellCommandOutput(marker, item.onData, collector)
      // 独立换行避免命令末尾的注释吞掉完成标记，同时保留实际退出码。
      item.commandWritten = true
      channel.write(`${item.command}\nprintf '\\n${marker}:%s\\n' "$?"\n`)
    }).catch(error => { if (generation === this.generation) this.reset(error) })
  }

  private assertCurrent(item: PendingCommand): void {
    try { item.assertCurrent?.() } catch (error) {
      if (item.initialized) throw new OperationError('OUTCOME_UNKNOWN', 'SSH shell initialization was dispatched before authorization changed; inspect side effects before retrying', 'reconcile-first')
      throw error
    }
  }

  private async openChannel(item: PendingCommand): Promise<ClientChannel> {
    this.assertCurrent(item)
    if (this.channel) return this.channel
    const generation = this.generation
    const client = await this.sshFileClient.getClient()
    if (generation !== this.generation || this.active !== item) throw new Error('SSH command session closed')
    this.assertCurrent(item)
    return new Promise((resolve, reject) => {
      item.openRequested = true
      client.shell((error, stream) => {
        if (error) {
          item.close({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
          reject(error); return
        }
        if (generation !== this.generation || this.active !== item) {
          stream.once('close', () => item.close({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' }))
          try { stream.destroy() } catch { /* 保留未确认名额 */ }
          reject(new Error('SSH command session closed')); return
        }
        this.channel = stream
        stream.on('error', (error: Error) => { if (this.channel === stream) this.reset(error) })
        stream.on('close', () => { if (this.channel === stream) this.reset(new Error('Shell channel closed'), true) })
        try { this.assertCurrent(item) } catch (error) { reject(error); return }
        const stdout = new StringDecoder('utf8')
        const stderr = new StringDecoder('utf8')
        stream.on('data', (data: Buffer) => {
          if (this.channel !== stream || !this.active) return
          const item = this.active
          let result: CommandResult | undefined
          try { result = this.output?.stdout(stdout.write(data)) } catch (error) { this.reset(error as Error); return }
          if (!result || this.active !== item || this.channel !== stream) return
          this.active = undefined
          this.output = undefined
          item.close({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
          item.finish(undefined, { ...result, output: cleanCommandOutput(result.output) })
          this.next()
        })
        // SSH shell 默认没有 PTY，stderr 仍可能使用扩展数据通道。
        stream.stderr.on('data', (data: Buffer) => {
          if (this.channel !== stream || !this.active) return
          try { this.output?.stderr(stderr.write(data)) } catch (error) { this.reset(error as Error) }
        })
        try {
          for (const command of this.shellEnterCommands.split('\n').filter(line => line.trim())) {
            this.assertCurrent(item)
            item.initialized = true
            stream.write(`${command}\n`)
          }
          resolve(stream)
        } catch (error) { reject(error) }
      })
    })
  }

  /**
   * 重置共享通道。已写入命令的目标远端结果未知，必须 OUTCOME_UNKNOWN，不能当作确定失败重放。
   */
  private reset(error: Error, channelAlreadyClosed = false): void {
    this.generation++
    const channel = this.channel
    this.channel = undefined
    const active = this.active
    const pending = active ? [active, ...this.queue] : this.queue
    this.active = undefined
    this.queue = []
    // 失败后完整输出不再需要；诊断片段已随错误对象（若存在）保留。
    this.output?.discard()
    this.output = undefined
    for (const item of pending) {
      const sideEffectsPossible = item.commandWritten || item.initialized || item.openRequested
      let failure = error
      if (sideEffectsPossible) {
        const outputLimit = error instanceof OperationError && error.code === 'RESOURCE_LIMIT'
        const timeout = (error as Error & { reason?: string }).reason === 'COMMAND_TIMEOUT'
        failure = new OperationError('OUTCOME_UNKNOWN', outputLimit
          ? 'SSH shell command output limit exceeded; remote outcome is unknown'
          : timeout ? 'SSH shell command timeout; remote outcome is unknown'
            : 'SSH shell outcome is unknown; inspect side effects before retrying', 'reconcile-first')
        const partial = (error as Error & { partialOutput?: unknown }).partialOutput
        if (typeof partial === 'string') Object.assign(failure, { partialOutput: partial })
        if (outputLimit) Object.assign(failure, { reason: 'OUTPUT_LIMIT' })
        if (timeout) Object.assign(failure, { reason: 'COMMAND_TIMEOUT' })
      }
      const close: ResourceCloseResult = { state: 'closed', localClosed: true,
        remoteTerminated: sideEffectsPossible ? 'unknown' : 'not-dispatched' }
      if (item !== active) item.close(NOT_DISPATCHED_CLOSE)
      else if (channel) {
        if (channelAlreadyClosed) item.close(close)
        else channel.once('close', () => item.close(close))
      } else if (!item.openRequested) item.close(NOT_DISPATCHED_CLOSE)
      // 正在等待 shell-open 的 active 由迟到回调销毁 stream，并等真正 close 后结算。
      item.finish(failure)
    }
    if (!channelAlreadyClosed) { try { channel?.destroy() } catch { /* 保留实际关闭待确认 */ } }
  }

  async cleanup(): Promise<void> {
    this.reset(new Error('SSH command session closed'))
  }
}
