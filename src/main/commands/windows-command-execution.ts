/**
 * Windows 本地命令的 Job Object 执行实现。
 *
 * 关键顺序：spawn helper → 把 helper PID 绑定进 Job（KILL_ON_JOB_CLOSE）→
 * 查询 Job 的 ActiveProcesses 确认绑定 → 才发送 start 让 helper spawn 用户 shell。
 * 用户命令及其后代因此从创建起就属于 Job，不存在“先 spawn 再 attach”的竞态。
 *
 * 关闭确认只认 Job 的明确 ActiveProcesses=0；查询失败或超窗仍有成员都按 unconfirmed 保留名额。
 */
import { spawn } from 'child_process'
import { join } from 'path'
import { OperationError } from '@shared/operation'
import { attachDshProcessJob, type DshProcessJob } from '../dsh/windows-job'
import { CommandOutputCollector } from '../file/command-output'
import type {
  CommandWorkerRequest,
  CommandWorkerResponse
} from './command-worker-protocol'
import type {
  CancelReason,
  CommandExecutionHandle,
  CommandResult,
  ResourceCloseResult
} from './types'

export interface WindowsCommandOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  onData?: (chunk: string) => void
  reserveBytes?: (deltaBytes: number) => void
  signal?: AbortSignal
  treeSettleMs?: number
  terminationConfirmMs?: number
}

/** helper 进程的最小接口；测试注入 fake，生产为 child_process.spawn 的 IPC 子进程。 */
export interface WindowsHelperProcess {
  pid?: number
  send(message: CommandWorkerRequest): boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface WindowsCommandDeps {
  /** 编译产物同目录的 helper 脚本；默认 `join(__dirname, 'localCommandWorker.js')`。 */
  workerScriptPath?: string
  attachJob?: (pid: number, spawnedAt: number) => DshProcessJob | null
  spawnHelper?: (scriptPath: string) => WindowsHelperProcess
  now?: () => number
  pollIntervalMs?: number
  readyTimeoutMs?: number
}

const READY_TIMEOUT_MS = 10_000
const TREE_SETTLE_MS = 500
const TERMINATION_CONFIRM_MS = 3_000
const PROBE_INTERVAL_MS = 50

const BINDING_FAILURE =
  'Windows Job Object could not be verified before the command started; the command was not executed'
const UNKNOWN_OUTCOME =
  'Command result is unknown after the command helper terminated; inspect side effects before retrying'

type EmptyProbe =
  | { state: 'empty' }
  | { state: 'busy'; active: number }
  | { state: 'unknown'; detail: string }

export function createWindowsCommandExecution(
  options: WindowsCommandOptions,
  deps: WindowsCommandDeps = {}
): CommandExecutionHandle {
  const timeoutMs = options.timeoutMs ?? 30_000
  const treeSettleMs = options.treeSettleMs ?? TREE_SETTLE_MS
  const terminationConfirmMs = options.terminationConfirmMs ?? TERMINATION_CONFIRM_MS
  const pollIntervalMs = deps.pollIntervalMs ?? PROBE_INTERVAL_MS
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS
  const now = deps.now ?? (() => performance.now())
  const attachJob = deps.attachJob ?? attachDshProcessJob
  const spawnHelper = deps.spawnHelper ?? defaultSpawnHelper
  const workerScriptPath = deps.workerScriptPath ?? join(__dirname, 'localCommandWorker.js')

  let helper: WindowsHelperProcess | undefined
  let job: DshProcessJob | undefined
  let started = false
  let commandExited = false
  let resultSettled = false
  let closeSettled = false
  let helperExited = false
  let timer: NodeJS.Timeout | undefined
  let readyTimer: NodeJS.Timeout | undefined

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

  // 函数声明提升：pre-abort 时 cleanupTimers 需要在初始化前就能移除监听。
  function onAbort(): void {
    if (started) failDispatched(new Error('Command aborted'), 'client')
    else failBeforeDispatch(new Error('Command aborted'))
  }

  const cleanupTimers = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = undefined }
    options.signal?.removeEventListener('abort', onAbort)
  }

  /** 查询 Job 是否已空；undefined（查询不可用/失败）绝不当成空。 */
  const probeEmpty = (): EmptyProbe => {
    if (!job?.activeProcesses) return { state: 'unknown', detail: 'Job object query is unavailable' }
    let active: number | undefined
    try { active = job.activeProcesses() } catch { active = undefined }
    if (active === undefined || !Number.isInteger(active) || active < 0) return { state: 'unknown', detail: 'Job object query failed' }
    return active === 0 ? { state: 'empty' } : { state: 'busy', active }
  }

  const waitForEmpty = async (windowMs: number): Promise<EmptyProbe> => {
    const deadline = now() + Math.max(0, windowMs)
    for (;;) {
      const probe = probeEmpty()
      if (probe.state !== 'busy') return probe
      if (now() >= deadline) return probe
      await delay(pollIntervalMs)
    }
  }

  /** 命令已结束：先等后台成员自然消退，超窗则受控终止，仍不能确认就保持名额。 */
  const confirmTreeAfterExit = async (): Promise<void> => {
    const first = await waitForEmpty(treeSettleMs)
    if (first.state === 'empty') {
      closeEmptyJob('confirmed')
      return
    }
    if (first.state === 'unknown') {
      terminateJob()
      settleClose({ state: 'unconfirmed', localClosed: true, remoteTerminated: 'unknown', detail: first.detail })
      return
    }
    terminateJob()
    const after = await waitForEmpty(terminationConfirmMs)
    if (after.state === 'empty') {
      closeEmptyJob('confirmed')
      return
    }
    const detail = after.state === 'unknown'
      ? after.detail
      : `Windows job still reported ${after.active} process(es) ${terminationConfirmMs}ms after termination`
    settleClose({ state: 'unconfirmed', localClosed: true, remoteTerminated: 'unknown', detail })
  }

  const terminateJob = (): void => {
    try { job?.terminate() } catch { /* 查询关闭证据仍必须继续。 */ }
  }

  const closeEmptyJob = (remoteTerminated: ResourceCloseResult['remoteTerminated']): void => {
    let closed = false
    try { closed = job?.close() === true } catch { /* 保留未确认状态。 */ }
    settleClose(closed
      ? { state: 'closed', localClosed: true, remoteTerminated }
      : { state: 'unconfirmed', localClosed: false, remoteTerminated, detail: 'Windows job handle close was not confirmed' })
  }

  /** 已派发命令失败：结果先失败，终止 Job 后等待 ActiveProcesses=0 才归还名额。 */
  const failDispatched = (error: Error, reason?: CancelReason): void => {
    if (resultSettled) return
    resultSettled = true
    cleanupTimers()
    const partialOutput = (error as Error & { partialOutput?: string }).partialOutput ?? collector.partialOutput
    const failure = new OperationError('OUTCOME_UNKNOWN',
      reason === 'request-timeout' ? `Command timeout after ${timeoutMs}ms; inspect side effects before retrying`
        : reason ? 'Command aborted; inspect side effects before retrying' : UNKNOWN_OUTCOME,
      'reconcile-first') as OperationError & { reason?: string; partialOutput?: string }
    failure.reason = reason === 'output-limit' ? 'OUTPUT_LIMIT' : reason === 'request-timeout' ? 'COMMAND_TIMEOUT' : reason ? 'COMMAND_CANCELLED' : undefined
    failure.partialOutput = partialOutput
    collector.discard()
    rejectResult(failure)
    terminateJob()
    try { helper?.kill() } catch { /* 已退出 */ }
    void (async () => {
      const after = await waitForEmpty(terminationConfirmMs)
      if (after.state === 'empty') {
        closeEmptyJob('confirmed')
        return
      }
      const detail = after.state === 'unknown'
        ? after.detail
        : `Windows job still reported ${after.active} process(es) ${terminationConfirmMs}ms after termination`
      settleClose({ state: 'unconfirmed', localClosed: true, remoteTerminated: 'unknown', detail })
    })()
  }

  /** start 之前失败：用户命令从未派发，清理 helper/Job 后以 not-dispatched 结算。 */
  const failBeforeDispatch = (error: Error): void => {
    if (resultSettled) return
    resultSettled = true
    cleanupTimers()
    collector.discard()
    rejectResult(error)
    terminateJob()
    try { helper?.kill() } catch { /* 已退出 */ }
    // 未派发仍须核实 helper/Job 已退出，kill() 的布尔值不是关闭证据。
    void (async () => {
      if (job) {
        const after = await waitForEmpty(terminationConfirmMs)
        if (after.state === 'empty') { closeEmptyJob('not-dispatched'); return }
      } else if (!helper) {
        settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
        return
      } else {
        const deadline = now() + terminationConfirmMs
        while (!helperExited && now() < deadline) await delay(pollIntervalMs)
        if (helperExited) {
          settleClose({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
          return
        }
      }
      settleClose({ state: 'unconfirmed', localClosed: false, remoteTerminated: 'not-dispatched', detail: 'Command helper cleanup was not confirmed' })
    })()
  }

  if (options.signal?.aborted) {
    failBeforeDispatch(new Error('Command aborted'))
    return { result, resourceClosed, cancel: () => {} }
  }

  const spawnedAt = Date.now()
  try {
    helper = spawnHelper(workerScriptPath)
  } catch (error) {
    failBeforeDispatch(asError(error))
    return { result, resourceClosed, cancel: () => {} }
  }
  // 即使绑定失败提前返回，也观察真实 exit/error，避免留下未观察的 error 事件。
  helper.on('exit', () => { helperExited = true })
  helper.on('error', () => {})
  if (!helper?.pid) {
    failBeforeDispatch(new OperationError('RESOURCE_LIMIT', BINDING_FAILURE, 'safe'))
    return { result, resourceClosed, cancel: () => {} }
  }

  try {
    job = attachJob(helper.pid, spawnedAt) ?? undefined
  } catch {
    job = undefined
  }
  if (!job || probeEmpty().state !== 'busy') {
    // 绑定或验证失败：绝不发送 start，也不回退到无 Job 执行。
    failBeforeDispatch(new OperationError('RESOURCE_LIMIT', BINDING_FAILURE, 'safe'))
    return { result, resourceClosed, cancel: () => {} }
  }

  const sendStart = (): void => {
    if (resultSettled || started) return
    clearReadyTimer()
    started = true
    try {
      // send(false) 表示 IPC 背压，消息仍可能已派发，不能降级为 not-dispatched。
      helper!.send({
        type: 'start',
        command: options.command,
        cwd: options.cwd || process.env.USERPROFILE || process.env.HOME || '',
        env: options.env ?? {}
      })
    } catch {
      failDispatched(new Error('Command helper channel failed'))
      return
    }
    timer = setTimeout(() => {
      failDispatched(new Error(`Command timeout after ${timeoutMs}ms`), 'request-timeout')
    }, timeoutMs)
  }

  const clearReadyTimer = (): void => {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = undefined }
  }

  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== 'object') return
    const frame = message as Partial<CommandWorkerResponse> & { data?: string }
    switch (frame.type) {
      case 'ready':
        sendStart()
        break
      case 'started':
        // helper 已完成 spawn；绑定已在 start 前确认，此处只记录事实。
        break
      case 'stdout':
      case 'stderr': {
        if (!started || resultSettled || typeof frame.data !== 'string') return
        const bytes = Buffer.from(frame.data, 'base64')
        try {
          if (frame.type === 'stdout') collector.writeStdout(bytes)
          else collector.writeStderr(bytes)
        } catch (error) {
          failDispatched(asError(error), 'output-limit')
        }
        break
      }
      case 'exit': {
        if (!started || resultSettled) return
        commandExited = true
        const code = (frame as { code?: unknown }).code
        completeCommand(typeof code === 'number' ? code : null)
        break
      }
      case 'error': {
        if (resultSettled) return
        const phase = (frame as { phase?: string }).phase
        if (!started || phase === 'spawn') {
          failBeforeDispatch(new OperationError('RESOURCE_LIMIT', 'Command process could not be started', 'safe'))
          return
        }
        failDispatched(new OperationError('OUTCOME_UNKNOWN', UNKNOWN_OUTCOME, 'reconcile-first'), phase === 'output-limit' ? 'output-limit' : undefined)
        break
      }
      default:
        break
    }
  }

  const completeCommand = (code: number | null): void => {
    if (resultSettled) return
    try {
      collector.flush()
    } catch (error) {
      failDispatched(asError(error), 'output-limit')
      return
    }
    resultSettled = true
    cleanupTimers()
    resolveResult({ output: collector.output, exitCode: code ?? -1 })
    void confirmTreeAfterExit()
  }

  helper.on('message', onMessage)
  helper.on('error', (error: Error) => {
    if (started) failDispatched(asError(error))
    else failBeforeDispatch(asError(error))
  })
  helper.on('exit', () => {
    if (resultSettled) return
    if (!started) {
      failBeforeDispatch(new Error('Command helper exited before the command started'))
      return
    }
    if (commandExited) return
    failDispatched(new OperationError('OUTCOME_UNKNOWN', UNKNOWN_OUTCOME, 'reconcile-first'))
  })

  readyTimer = setTimeout(() => {
    failBeforeDispatch(new Error('Command helper did not become ready before the startup deadline'))
  }, readyTimeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    result,
    resourceClosed,
    cancel(reason: CancelReason) {
      if (reason === 'client') onAbort()
      else if (started) failDispatched(new Error(`Command aborted (${reason})`), reason)
      else failBeforeDispatch(new Error(`Command aborted (${reason})`))
    }
  }
}

function defaultSpawnHelper(scriptPath: string): WindowsHelperProcess {
  // ELECTRON_RUN_AS_NODE 只作用于 helper 启动；helper 在 spawn 用户命令前会移除它。
  return spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
  })
}
