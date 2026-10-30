import { spawn, type ChildProcess } from 'child_process'
import log from 'electron-log'
import { childEnvironment } from '../env/child-environment'
import { CommandOutputCollector } from '../file/command-output'
import { terminatePluginProcess } from '../plugin/process-cleanup'
import { createWindowsCommandExecution } from './windows-command-execution'
import type {
  CancelReason,
  CommandExecutionHandle,
  CommandResult,
  ResourceCloseResult
} from './types'

/**
 * 本地命令的通用执行核心（stdout+stderr 合并、增量 UTF-8、有界输出）。
 *
 * 结果和资源关闭分开结算：abort/timeout/output-limit 时先让 result 失败，
 * 进程树确认退出后才结算 resourceClosed；调度名额由后者决定何时归还。
 */

export interface LocalCommandOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
  /** 单条命令期限。 */
  timeoutMs?: number
  onData?: (chunk: string) => void
  /** 输出保留增量预留；超限抛 RESOURCE_LIMIT。 */
  reserveBytes?: (deltaBytes: number) => void
  signal?: AbortSignal
  /**
   * 独立核实进程树是否已不存在（true=确认消失）。
   *
   * terminatePluginProcess 的 POSIX 分组实现会在 SIGKILL 派发后立刻 resolve，
   * 不能据此宣称资源已关闭；默认实现按平台探测，测试可注入以模拟迟到的树退出。
   */
  probeTreeGone?: (pid: number | undefined, child: ChildProcess) => boolean | Promise<boolean>
  /** 根进程正常 close 后等待后台进程组消退的窗口；超时按 unconfirmed 结算。 */
  treeSettleMs?: number
  /** 终止调用返回后等待进程树真正消失的窗口；超时按 unconfirmed 结算。 */
  terminationConfirmMs?: number
}

export interface LocalCommandDeps {
  /** 仅测试注入；生产按 process.platform 路由。 */
  platform?: NodeJS.Platform
  /** 仅测试注入；win32 默认使用 Job Object 安全实现。 */
  windowsExecution?: (options: LocalCommandOptions) => CommandExecutionHandle
}

const TREE_SETTLE_MS = 500
const TERMINATION_CONFIRM_MS = 3_000
const TREE_PROBE_INTERVAL_MS = 50

/**
 * 按平台路由：Windows 走“先绑定 Job 再启动”的 helper 实现，其余平台用进程组实现。
 * Windows 分支没有无 Job 回退；绑定失败会在命令启动前拒绝。
 */
export function createLocalCommandExecution(
  options: LocalCommandOptions,
  deps: LocalCommandDeps = {}
): CommandExecutionHandle {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    return (deps.windowsExecution ?? createWindowsCommandExecution)(options)
  }
  return createPosixLocalCommandExecution(options)
}

function createPosixLocalCommandExecution(options: LocalCommandOptions): CommandExecutionHandle {
  const timeoutMs = options.timeoutMs ?? 30_000
  const treeSettleMs = options.treeSettleMs ?? TREE_SETTLE_MS
  const terminationConfirmMs = options.terminationConfirmMs ?? TERMINATION_CONFIRM_MS
  let child: ChildProcess | undefined
  let childPid: number | undefined
  let closeObserved = false
  let resultSettled = false
  let closeSettled = false
  let timer: NodeJS.Timeout | undefined
  // close 事件本身不能证明整个进程组消失；POSIX 还要独立探测独立组。
  const probeTreeGone = options.probeTreeGone
    ?? ((pid: number | undefined, target: ChildProcess) => defaultTreeGone(pid, target, closeObserved))

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

  const settleClose = (close: ResourceCloseResult): void => {
    if (closeSettled) return
    closeSettled = true
    resolveClose(close)
  }

  const cleanupListeners = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined }
    options.signal?.removeEventListener('abort', onAbort)
  }

  /**
   * 轮询独立探测直到确认或窗口耗尽。
   * terminatePluginProcess 的 resolve 只代表信号已派发，必须另行确认树已消失。
   */
  const waitForTreeGone = async (windowMs: number): Promise<boolean> => {
    const target = child
    if (!target) return true
    const deadline = Date.now() + Math.max(0, windowMs)
    for (;;) {
      let gone = false
      try { gone = await probeTreeGone(childPid, target) } catch { gone = false }
      if (gone) return true
      if (Date.now() >= deadline) return false
      await delay(TREE_PROBE_INTERVAL_MS)
    }
  }

  /** 终止进程树；结果先失败，关闭确认后结算 resourceClosed。 */
  const fail = (error: Error, reason: CancelReason | undefined, dispatched: boolean): void => {
    if (resultSettled) return
    resultSettled = true
    cleanupListeners()
    // 完整输出不再需要；失败诊断片段已随 error 带走。
    collector.discard()
    if (!child || !dispatched) {
      settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
      rejectResult(error)
      return
    }
    const target = child
    target.stdout?.destroy()
    target.stderr?.destroy()
    // 先拒绝结果：调用方看到失败时清理可能仍在进行，名额不会提前归还。
    rejectResult(error)
    log.info(`[MCP] Local command stopping (${reason ?? 'error'}): ${error.message}`)
    void terminatePluginProcess(target, { processGroup: process.platform !== 'win32' })
      .then(async () => {
        const gone = await waitForTreeGone(terminationConfirmMs)
        if (gone) {
          settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
          return
        }
        // 终止信号已发出但树仍在：名额继续占用，不能假报 closed。
        log.warn('[MCP] Local command tree exit unconfirmed after termination')
        settleClose({
          state: 'unconfirmed',
          localClosed: true,
          remoteTerminated: 'unknown',
          detail: `Local process tree was still present ${terminationConfirmMs}ms after termination`
        })
      })
      .catch((cleanupError: Error) => {
        log.warn('[MCP] Local command cleanup unconfirmed:', cleanupError.message)
        settleClose({
          state: 'failed',
          localClosed: false,
          remoteTerminated: 'unknown',
          detail: cleanupError.message
        })
      })
  }

  const onAbort = (): void => {
    fail(new Error('Command aborted'), 'client', isDispatched())
  }

  const isDispatched = (): boolean => child !== undefined

  if (options.signal?.aborted) {
    fail(new Error('Command aborted'), 'client', false)
    return { result, resourceClosed, cancel: () => {} }
  }

  const execEnv = childEnvironment(process.env, options.env) as Record<string, string>
  const execCwd = options.cwd || process.env.USERPROFILE || process.env.HOME || ''
  log.info(`[MCP] Executing local command (${options.command.length} characters)`)

  try {
    child = spawn(options.command, {
      cwd: execCwd,
      env: execEnv,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    childPid = child.pid
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)), undefined, false)
    return { result, resourceClosed, cancel: () => {} }
  }

  timer = setTimeout(() => {
    fail(new Error(`Command timeout after ${timeoutMs}ms`), 'request-timeout', isDispatched())
  }, timeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })

  child.stdout?.on('data', (data: Buffer) => {
    if (resultSettled) return
    try { collector.writeStdout(data) } catch (error) { fail(asError(error), 'output-limit', true) }
  })
  child.stderr?.on('data', (data: Buffer) => {
    if (resultSettled) return
    try { collector.writeStderr(data) } catch (error) { fail(asError(error), 'output-limit', true) }
  })
  child.on('error', (error: Error) => {
    // spawn 失败时没有 pid，说明命令从未执行；否则按已派发处理。
    fail(error, undefined, childPid !== undefined)
  })
  child.on('close', (code: number | null) => {
    closeObserved = true
    if (resultSettled) return
    try {
      collector.flush()
    } catch (error) {
      fail(asError(error), 'output-limit', true)
      return
    }
    resultSettled = true
    cleanupListeners()
    const output = collector.output
    // 结果先返回；后台进程组可能仍在运行，关闭回执必须独立确认。
    resolveResult({ output, exitCode: code ?? -1 })
    void waitForTreeGone(treeSettleMs).then(gone => {
      if (gone) {
        settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
        return
      }
      log.warn('[MCP] Local command left live processes in its process group')
      settleClose({
        state: 'unconfirmed',
        localClosed: true,
        remoteTerminated: 'unknown',
        detail: `Background processes were still alive ${treeSettleMs}ms after the command exited`
      })
    })
  })

  return {
    result,
    resourceClosed,
    cancel(reason: CancelReason) {
      if (reason === 'client') { fail(new Error('Command aborted'), reason, isDispatched()); return }
      fail(new Error(`Command aborted (${reason})`), reason, isDispatched())
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * PID 身份保护：只有仍指向本次 spawn 的 child 才允许判定其进程组。
 * 不依赖命令行或进程名，避免 PID 复用后误判。
 */
function targetPidMatches(child: ChildProcess, pid: number | undefined): boolean {
  return pid !== undefined && child.pid === pid
}

/**
 * 平台默认的树消失探测：PID 必须仍是本次 spawn 的进程。
 * POSIX 用负 PID 探测独立组；Windows 没有等价组探测，以根进程 close/退出为准。
 */
function defaultTreeGone(pid: number | undefined, child: ChildProcess, closeObserved: boolean): boolean {
  if (!targetPidMatches(child, pid)) return false
  if (process.platform === 'win32') {
    return closeObserved || child.exitCode !== null || child.signalCode !== null
  }
  if (pid === undefined) return false
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** 不在事件循环里保持进程存活；关闭确认轮询只服务于请求生命周期。 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
  })
}
