import type { ClientChannel } from 'ssh2'
import { OperationError } from '@shared/operation'
import { SSHFileClient } from './ssh-file-client'
import { CommandOutputCollector } from './command-output'
import type {
  CancelReason,
  CommandExecutionHandle,
  CommandResult,
  ResourceCloseResult
} from '../commands/types'

/** 由可信调用方提供的同步断言，在实际副作用派发前复核当前授权与资源身份。 */
export type CommandDispatchGuard = () => void

export function cleanCommandOutput(output: string): string {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim()
}

export interface SSHCommandOptions {
  command: string
  timeoutMs?: number
  onData?: (chunk: string) => void
  reserveBytes?: (deltaBytes: number) => void
  signal?: AbortSignal
  assertCurrent?: CommandDispatchGuard
}

/**
 * 普通 SSH exec 通道，不启动 SFTP，也不提供文件传输。
 *
 * 取消/超时后本地通道销毁即视为本地资源释放；远端进程是否终止无法确认，
 * 因此结果以 OUTCOME_UNKNOWN 失败，绝不自动重放。
 */
export class SSHCommandExecutor {
  constructor(private sshFileClient: SSHFileClient) {}

  async execRaw(command: string, timeout = 30000, assertCurrent?: CommandDispatchGuard): Promise<string> {
    return this.executeCommand({ command, timeoutMs: timeout, assertCurrent }).result.then(result => result.output)
  }

  execStream(command: string, timeout: number, onData: (chunk: string) => void, signal?: AbortSignal, assertCurrent?: CommandDispatchGuard): Promise<CommandResult> {
    return this.executeCommand({ command, timeoutMs: timeout, onData, signal, assertCurrent }).result
  }

  /** 带资源关闭回执的执行入口；HTTP 接入使用此方法。 */
  executeCommand(options: SSHCommandOptions): CommandExecutionHandle {
    const timeoutMs = options.timeoutMs ?? 30000
    let channel: ClientChannel | undefined
    let resultSettled = false
    let closeSettled = false
    /** 已调用 client.exec（远端可能已开始执行）。 */
    let dispatched = false
    let timer: NodeJS.Timeout | undefined

    let resolveResult!: (result: CommandResult) => void
    let rejectResult!: (error: Error) => void
    let resolveClose!: (result: ResourceCloseResult) => void
    const result = new Promise<CommandResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const resourceClosed = new Promise<ResourceCloseResult>(resolve => { resolveClose = resolve })

    const collector = new CommandOutputCollector({
      reserveBytes: options.reserveBytes,
      onData: chunk => { if (!resultSettled) options.onData?.(chunk) }
    })

    const cleanupListeners = (): void => {
      if (timer) { clearTimeout(timer); timer = undefined }
      options.signal?.removeEventListener('abort', onAbort)
    }

    const settleClose = (close: ResourceCloseResult): void => {
      if (closeSettled) return
      closeSettled = true
      resolveClose(close)
    }

    const settleNotDispatched = (error: Error): void => {
      if (resultSettled) return
      resultSettled = true
      cleanupListeners()
      collector.discard()
      settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
      rejectResult(error)
    }

    /**
     * 失败结算。已派发时先销毁本地通道（本地释放），再以 OUTCOME_UNKNOWN 暴露远端不确定性。
     * 输出上限错误保留 RESOURCE_LIMIT 与 partialOutput；权限类错误按原样保留（F01/F02）。
     */
    const fail = (error: Error, reason: CancelReason | undefined, _preserveError = false): void => {
      if (resultSettled) return
      resultSettled = true
      cleanupListeners()
      // 失败后不再需要完整输出；partialOutput 已随错误对象携带。
      collector.discard()
      if (!dispatched) {
        settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
        rejectResult(error)
        return
      }
      const unknown = new OperationError('OUTCOME_UNKNOWN', reason === 'output-limit'
        ? 'Command output limit exceeded; remote outcome is unknown'
        : reason === 'request-timeout' ? 'SSH command timeout; remote outcome is unknown'
          : 'SSH command outcome is unknown; inspect side effects before retrying', 'reconcile-first')
      const partial = (error as Error & { partialOutput?: unknown }).partialOutput
      if (typeof partial === 'string') Object.assign(unknown, { partialOutput: partial })
      if (reason === 'output-limit') Object.assign(unknown, { reason: 'OUTPUT_LIMIT' })
      if (reason === 'request-timeout') Object.assign(unknown, { reason: 'COMMAND_TIMEOUT' })
      // destroy 只提出关闭请求；没有 channel 或没有 close 证据时名额继续保留。
      try { channel?.destroy() } catch { /* 由实际 close 或请求回执确认本地资源。 */ }
      rejectResult(unknown)
    }

    const onAbort = (): void => fail(new Error('Command aborted'), 'client')

    if (options.signal?.aborted) {
      settleNotDispatched(new Error('Command aborted'))
      return { result, resourceClosed, cancel: () => {} }
    }

    timer = setTimeout(() => fail(new Error(`Command timeout after ${timeoutMs}ms`), 'request-timeout'), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const guard = (): void => {
      try {
        options.assertCurrent?.()
      } catch (error) {
        fail(asError(error), undefined)
        throw error
      }
    }

    if (options.signal?.aborted) {
      fail(new Error('Command aborted'), 'client')
      return { result, resourceClosed, cancel: () => {} }
    }

    try { guard() } catch { return { result, resourceClosed, cancel: () => {} } }

    void this.sshFileClient.getClient().then(client => {
      if (resultSettled) return
      try { guard() } catch { return }
      if (resultSettled) return
      dispatched = true
      client.exec(options.command, (error, stream) => {
        if (error) {
          // exec 已发出：传输失败不能证明远端未执行；回调只证明本地请求已释放。
          fail(error, undefined)
          settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
          return
        }
        channel = stream
        stream.once('close', () => settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' }))
        if (resultSettled) { try { stream.destroy() } catch { /* 保留未确认名额 */ } return }
        let exitCode = -1
        try { options.assertCurrent?.() } catch (guardError) {
          fail(asError(guardError), undefined, true)
          return
        }
        stream.on('data', (data: Buffer) => {
          if (resultSettled) return
          try { collector.writeStdout(data) } catch (collectorError) { fail(asError(collectorError), 'output-limit') }
        })
        // 仅收集 stdout 时也排空 stderr，避免远端因窗口耗尽阻塞。
        stream.stderr.on('data', (data: Buffer) => {
          if (resultSettled) return
          try { collector.writeStderr(data) } catch (collectorError) { fail(asError(collectorError), 'output-limit') }
        })
        stream.on('exit', (code: number | null) => { if (typeof code === 'number') exitCode = code })
        stream.on('error', (streamError: Error) => fail(streamError, undefined))
        stream.on('close', () => {
          if (resultSettled) return
          try { collector.flush() } catch (collectorError) { fail(asError(collectorError), 'output-limit'); return }
          resultSettled = true
          cleanupListeners()
          // exit-status 只描述前台命令，不能证明远端后台进程树已停止。
          settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
          resolveResult({ output: cleanCommandOutput(collector.output), exitCode })
        })
      })
    }).catch(error => {
      if (dispatched) fail(asError(error), undefined)
      else settleNotDispatched(asError(error))
    })

    return {
      result,
      resourceClosed,
      cancel(reason: CancelReason) {
        fail(new Error(reason === 'client' ? 'Command aborted' : `Command aborted (${reason})`), reason)
      }
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
