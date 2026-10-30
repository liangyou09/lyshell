/**
 * 下载 Worker 管理器
 * 管理下载 Worker 的创建、消息转发和生命周期
 *
 * OPT-11 提交协议的主进程侧约束与上传管理器一致：
 * - 每个任务在派发时生成唯一 attemptId，Worker 的每条消息都必须匹配 taskId + attemptId；
 * - 进度 100% 不是终态；终态只能由 Worker 的 `result` 消息决定，且每个任务只上报一次；
 * - 取消先通知 Worker（关闭句柄、清理自己的临时文件），确认后才上报 cancelled；
 *   提交已生效的取消无效、提交回执丢失报 OUTCOME_UNKNOWN，都不盲目重试；
 * - 并发额度只在 Worker 真正 exit 后释放（串行链同理），不因 complete/进度提前释放。
 */
import { Worker } from 'worker_threads'
import * as path from 'path'
import log from 'electron-log'
import { OperationError } from '@shared/operation'
import type { BrowserWindow } from 'electron'
import { downloadHistory, DownloadRecord } from '../storage'
import { v4 as uuidv4 } from 'uuid'
import { createSerialChain } from './serial-chain'
import {
  transferScheduler,
  transferEndpointKey,
  type TransferLease,
  TransferCancelledError,
  TransferQueueFullError
} from './transfer-scheduler'
import { isSshHostKeyError, type TransferHostKeyExpectation } from '../security/ssh-host-key'
import { resolveTransferHostKey } from '../security/ssh-trust'
import { buildSyntheticResult, type TransferAttemptResult, type TransferPhase } from './transfer-commit'
import {
  classifyExitWithoutResult,
  createAttempt,
  createTerminalLedger,
  isAttemptResult,
  isMessageForAttempt,
  isTransferPhase,
  progressToRendererPayload,
  resultToRendererPayload,
  transferAttemptTimeouts,
  type AttemptIdentity,
  type TransferRendererPayload
} from './transfer-attempt'

// Worker 任务数据
interface DownloadTaskData {
  taskId: string
  /** 主进程派发的尝试 ID；Worker 只回传，不自造 */
  attemptId?: string
  sessionId: string
  method: 'sftp'
  sshConfig: {
    host: string
    port: number
    username: string
    password?: string
    privateKey?: string
    passphrase?: string
    readyTimeout?: number
    keepaliveInterval?: number
  }
  /**
   * 内部字段：主进程 dispatch 前从可信记录读出并注入，Worker 只做固定匹配。
   * 调用方传入的同名字段一律被覆盖，绝不采信外部请求自报的指纹。
   */
  hostKey?: TransferHostKeyExpectation
  remotePath: string
  localPath: string
  fileSize: number
}

// 任务元信息（用于保存下载记录）
interface TaskMeta {
  taskId: string
  sessionId: string
  remotePath: string
  localPath: string
  fileName?: string
  fileSize: number
  startTime: Date
  sessionName?: string
}

// 活动中的 Worker
interface ActiveWorker extends AttemptIdentity {
  worker: Worker
  phase: TransferPhase
  lastTransferredSize: number
  speed: number
  tempPath?: string
  cancelRequested: boolean
  terminating: boolean
  shuttingDown: boolean
  terminal: TransferAttemptResult | null
  settled: boolean
  cancelTimer?: NodeJS.Timeout
  terminateTimer?: NodeJS.Timeout
  meta: TaskMeta
  resolve: () => void
  reject: (error: Error) => void
}

// 一次派发/尝试的登记信息（在首个 await 前登记，覆盖取消窗口）
interface Admission extends AttemptIdentity {
  cancelled: boolean
  dispatched: boolean
}

const PHASE_RANK: Record<TransferPhase, number> = { data: 0, verifying: 1, committing: 2, completed: 3 }

// 全局 Worker 映射
const activeWorkers: Map<string, ActiveWorker> = new Map()

// 尝试登记表：覆盖 acquire 已发放额度、调用方尚未恢复的取消窗口
const admissions = new Map<string, Admission>()

// 每个任务只允许一条终态回执，且旧尝试/迟到消息不能回退终态
const terminalLedger = createTerminalLedger()

// 同规范化本地路径的下载串行化：两个并发下载写同一本地文件会让
// `fs.openSync(localPath, 'w')` 互相 truncate + 交错写入，导致本地文件损坏且双方都不报错。
// 后到的同路径下载排队在前一个完成/失败/取消之后执行。
// key 不含 sessionId——两个会话写同一本地文件同样会损坏；path.normalize 折叠
// /a//b、/a/./b、/a/../b 等别名，Windows 大小写不敏感统一小写，防别名绕过。
const downloadChain = createSerialChain()

function downloadChainKey(localPath: string): string {
  const norm = path.normalize(localPath)
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

// 任务元信息存储
const taskMetaStore: Map<string, TaskMeta> = new Map()

// 主窗口引用（用于发送进度）
let mainWindow: BrowserWindow | null = null

/**
 * 设置主窗口引用
 */
export function setMainWindow(window: BrowserWindow | null) {
  mainWindow = window
}

/**
 * 注册任务元信息（从 handlers 调用）
 */
export function registerTaskMeta(taskId: string, meta: TaskMeta) {
  taskMetaStore.set(taskId, meta)
}

/**
 * 启动下载 Worker（fire-and-forget，UI 路径用）
 */
export function startDownloadWorker(task: DownloadTaskData): Promise<void> {
  // 复用阻塞等待路径，仅忽略其 Promise 结果；进度/错误仍通过 message 事件推送
  runDownloadWorkerAndWait(task).catch((error) => {
    // 排队容量满必须给 UI 一个明确失败回执，否则进度条会永远停在“等待中”
    if (error instanceof TransferQueueFullError) {
      log.warn(`Download task ${task.taskId} rejected: ${error.message}`)
      const attemptId = task.attemptId ?? 'not-dispatched'
      const synthetic = buildSyntheticResult({
        taskId: task.taskId,
        attemptId,
        direction: 'download',
        outcome: 'failed',
        expectedSize: task.fileSize,
        targetPath: task.localPath,
        code: 'TRANSFER_IO_ERROR',
        message: '下载队列已满，请稍后重试'
      })
      const payload = resultToRendererPayload(synthetic, task.sessionId)
      payload.error = '下载队列已满，请稍后重试'
      recordTerminalAndSend(task.taskId, attemptId, synthetic, payload)
    } else if (isSshHostKeyError(error)) {
      // 主机密钥未受信任/已变化时不会创建 Worker，没有人会再发终态消息：
      // 这里必须给 UI 明确失败原因（含 code 对应的中文说明），否则进度条永远停在「等待中」。
      log.warn(`Download task ${task.taskId} rejected [${error.code}]: ${error.message}`)
      const attemptId = task.attemptId ?? 'not-dispatched'
      const synthetic = buildSyntheticResult({
        taskId: task.taskId,
        attemptId,
        direction: 'download',
        outcome: 'failed',
        expectedSize: task.fileSize,
        targetPath: task.localPath,
        code:
          error.code === 'SSH_HOST_KEY_UNAVAILABLE'
            ? 'TRANSFER_HOST_KEY_UNAVAILABLE'
            : 'TRANSFER_HOST_KEY_REJECTED',
        message: error.message
      })
      recordTerminalAndSend(task.taskId, attemptId, synthetic, resultToRendererPayload(synthetic, task.sessionId))
    }
    // 取消回执由 cancelDownload / cancelDownloadsBySession 负责；Worker 侧失败已有回执
  })
  return Promise.resolve()
}

/**
 * 启动下载 Worker 并阻塞等待完成（MCP 同步路径用）
 *
 * 同规范化本地路径的下载会串行排队，避免并发写同一本地文件导致损坏；
 * 不同路径的下载还会受全局 Worker 调度器限制（全局 4、每 endpoint 2）。
 */
export async function runDownloadWorkerAndWait(task: DownloadTaskData, authorized: () => boolean = () => true): Promise<void> {
  if (!authorized()) throw new OperationError('FORBIDDEN', 'Transfer authorization was revoked before dispatch')
  // 主机密钥先于一切调度：没有可信指纹就不占队列、不开 Worker、不建 TCP。
  // 用主进程可信记录覆盖任务上的同名字段（不接受外部请求自报 fingerprint）。
  const hostKey = resolveTransferHostKey(task.sshConfig)
  if (admissions.has(task.taskId)) throw new Error('Transfer task already exists')

  const attempt = createAttempt({
    taskId: task.taskId,
    sessionId: task.sessionId,
    direction: 'download',
    expectedSize: task.fileSize,
    targetPath: task.localPath
  })
  const dispatched: DownloadTaskData = { ...task, sshConfig: { ...task.sshConfig }, hostKey, attemptId: attempt.attemptId }
  // 让 UI 路径（startDownloadWorker 的 catch）也能带上本次尝试 ID
  task.attemptId = attempt.attemptId
  const admission: Admission = { ...attempt, cancelled: false, dispatched: false }
  admissions.set(task.taskId, admission)

  let lease: TransferLease | undefined
  try {
    lease = await transferScheduler.acquire({
      taskId: task.taskId,
      sessionId: task.sessionId,
      endpoint: transferEndpointKey(task.sshConfig.host, task.sshConfig.port)
    })
    if (admission.cancelled) throw new TransferCancelledError()
    admission.dispatched = true
    const key = downloadChainKey(task.localPath)
    return await downloadChain.run(key, () => {
      if (!authorized()) throw new OperationError('FORBIDDEN', 'Transfer authorization was revoked before dispatch')
      return runDownloadWorkerInternal(dispatched, admission)
    }, {
      id: task.taskId,
      group: task.sessionId
    })
  } finally {
    admissions.delete(task.taskId)
    taskMetaStore.delete(task.taskId)
    lease?.release()
  }
}

/**
 * 实际创建并运行单个下载 Worker（无串行化逻辑）
 */
function runDownloadWorkerInternal(task: DownloadTaskData, admission: Admission): Promise<void> {
  // 额度及同路径队列可能等待很久；以真正派发时的信任为准，撤销后不能沿用旧指纹。
  task.hostKey = resolveTransferHostKey(task.sshConfig)
  const { taskId, sessionId } = task
  const attemptId = admission.attemptId

  log.info(`Starting download worker (await completion) for task ${taskId} [${attemptId}]`)

  // 获取任务元信息
  const meta = taskMetaStore.get(taskId)

  // Worker 脚本路径
  const workerPath = path.join(__dirname, 'worker.js')

  log.debug(`Worker path: ${workerPath}, __dirname: ${__dirname}`)

  // 创建 Worker；同步构造失败时不会有线程需要等待 exit，直接失败
  let worker: Worker
  try {
    worker = new Worker(workerPath, {
      workerData: task
    })
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.error(`Failed to create download worker for task ${taskId}: ${err.message}`)
    taskMetaStore.delete(taskId)
    const synthetic = buildSyntheticResult({
      taskId,
      attemptId,
      direction: 'download',
      outcome: 'failed',
      expectedSize: task.fileSize,
      targetPath: task.localPath,
      code: 'TRANSFER_WORKER_START_FAILED',
      message: err.message
    })
    recordTerminalAndSend(taskId, attemptId, synthetic, resultToRendererPayload(synthetic, sessionId))
    return Promise.reject(err)
  }

  return new Promise<void>((resolve, reject) => {
    const active: ActiveWorker = {
      taskId,
      attemptId,
      direction: 'download',
      sessionId,
      expectedSize: task.fileSize,
      targetPath: task.localPath,
      startedAt: admission.startedAt,
      worker,
      phase: 'data',
      lastTransferredSize: 0,
      speed: 0,
      cancelRequested: false,
      terminating: false,
      shuttingDown: false,
      terminal: null,
      settled: false,
      meta: meta || {
        taskId,
        sessionId,
        remotePath: task.remotePath,
        localPath: task.localPath,
        fileSize: task.fileSize,
        startTime: new Date(admission.startedAt)
      },
      resolve,
      reject
    }

    // 记录活动 Worker
    activeWorkers.set(taskId, active)

    // 监听 Worker 消息：只接受属于本次尝试的消息
    worker.on('message', (message: unknown) => {
      handleWorkerMessage(message, active, task)
    })

    // 监听 Worker 错误：记录失败终态与回执，但不释放额度、不提前 settle（等 exit）
    worker.on('error', (err) => {
      log.error(`Worker error for task ${taskId} [${attemptId}]:`, err.message)
      if (active.terminal) return
      const synthetic = classifyExitWithoutResult({ identity: active, cancelRequested: active.cancelRequested,
        lastPhase: active.phase, lastTransferredSize: active.lastTransferredSize, lastTempPath: active.tempPath,
        terminated: active.terminating })
      recordTerminalAndSend(taskId, attemptId, synthetic, resultToRendererPayload(synthetic, sessionId))
      active.terminal = synthetic
      writeDownloadHistory(task, active.meta, 'failed', synthetic.error?.message)
    })

    // 监听 Worker 退出：线程真正结束后才 settle 并释放额度
    worker.on('exit', (code) => {
      clearTimeout(active.cancelTimer)
      clearTimeout(active.terminateTimer)
      active.cancelTimer = undefined
      active.terminateTimer = undefined
      activeWorkers.delete(taskId)
      taskMetaStore.delete(taskId)
      if (active.settled) return
      active.settled = true

      // 没有 result：按“取消确认/提交阶段/普通失败”三分类兜底，语义必须明确
      if (!active.terminal) {
        const synthetic = classifyExitWithoutResult({
          identity: active,
          cancelRequested: active.cancelRequested,
          lastPhase: active.phase,
          lastTransferredSize: active.lastTransferredSize,
          lastTempPath: active.tempPath,
          terminated: active.terminating
        })
        active.terminal = synthetic
        if (!active.shuttingDown) {
          recordTerminalAndSend(taskId, attemptId, synthetic, resultToRendererPayload(synthetic, sessionId))
          writeDownloadHistory(task, active.meta, 'failed', synthetic.error?.message)
        } else {
          terminalLedger.record(taskId, attemptId, synthetic.outcome)
        }
        log.warn(
          `Worker for task ${taskId} [${attemptId}] exited without result (code ${code}, phase ${active.phase}, outcome ${synthetic.outcome})`
        )
        active.reject(new TransferCancelledError(`Download ${synthetic.outcome}`))
        return
      }

      if (active.terminal.outcome === 'completed') {
        log.info(`Worker for task ${taskId} [${attemptId}] completed`)
        active.resolve()
        return
      }
      if (active.terminal.outcome === 'cancelled') {
        active.reject(new TransferCancelledError('Download cancelled'))
        return
      }
      active.reject(new Error(active.terminal.error?.message ?? 'Download failed'))
    })
  })
}

/**
 * 处理 Worker 发来的消息（attemptId 校验 + 终态幂等）
 */
function handleWorkerMessage(message: unknown, active: ActiveWorker, task: DownloadTaskData) {
  const { taskId, attemptId } = active

  if (!isMessageForAttempt(message, active)) {
    const candidate = message as { taskId?: unknown; attemptId?: unknown; type?: unknown } | null
    log.warn(
      `Dropping download worker message not owned by this attempt: taskId=${String(candidate?.taskId)} attemptId=${String(candidate?.attemptId)} type=${String(candidate?.type)} (expected ${taskId}/${attemptId})`
    )
    return
  }
  // 终态之后一律忽略，避免旧消息回退终态（回执去重也不能让终态被覆盖）
  if (active.terminal || terminalLedger.has(taskId, attemptId)) return

  const msg = message as { type?: string; [key: string]: unknown }

  switch (msg.type) {
    case 'progress': {
      const transferredSize = clampNumber(msg.transferredSize, active.expectedSize)
      const speed = typeof msg.speed === 'number' && Number.isFinite(msg.speed) ? Math.max(0, msg.speed) : 0
      updatePhase(active, msg.phase)
      active.lastTransferredSize = transferredSize
      active.speed = speed
      if (active.shuttingDown) break
      sendProgressToRenderer(
        progressToRendererPayload({
          identity: active,
          phase: active.phase,
          transferredSize,
          speed
        })
      )
      break
    }

    case 'phase': {
      if (!updatePhase(active, msg.phase)) break
      if (active.shuttingDown) break
      // 阶段推进也是进度信息（progress 保持当前字节比例，不产生 completed 回执）
      sendProgressToRenderer(
        progressToRendererPayload({
          identity: active,
          phase: active.phase,
          transferredSize: active.lastTransferredSize,
          speed: 0
        })
      )
      break
    }

    case 'temp': {
      if (typeof msg.tempPath === 'string' && msg.tempPath.length > 0) active.tempPath = msg.tempPath
      break
    }

    case 'result': {
      handleResultMessage(msg.result, active, task)
      break
    }

    case 'log': {
      const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info'
      const text = typeof msg.message === 'string' ? msg.message : ''
      log[level](`[DownloadWorker] ${text}`)
      break
    }

    default:
      log.warn(`Unknown download worker message type: ${String(msg.type)}`)
  }
}

/** Worker 上报的终态：校验归属/结构后记录并只上报一次 */
function handleResultMessage(rawResult: unknown, active: ActiveWorker, task: DownloadTaskData) {
  const { taskId, attemptId } = active
  if (terminalLedger.has(taskId, attemptId)) {
    log.warn(`Dropping download result for already-terminal attempt ${taskId}/${attemptId}`)
    return
  }
  if (!isAttemptResult(rawResult)) {
    log.warn(`Worker for task ${taskId} [${attemptId}] reported a malformed result; treating as missing terminal state`)
    return
  }
  const result = rawResult as TransferAttemptResult
  if (result.taskId !== taskId || result.attemptId !== attemptId) {
    log.warn(
      `Dropping download result with mismatched identity: ${result.taskId}/${result.attemptId} (expected ${taskId}/${attemptId})`
    )
    return
  }
  // phase 只允许前进：迟到的旧阶段不能把终态拉回去
  updatePhase(active, result.phase)
  active.terminal = result
  active.lastTransferredSize = result.transferredSize
  if (result.tempPath) active.tempPath = result.tempPath
  if (result.outcome === 'completed') active.phase = 'completed'

  const payload = resultToRendererPayload(result, active.sessionId)
  recordTerminalAndSend(taskId, attemptId, result, payload)

  if (result.outcome === 'completed') {
    log.info(`Download completed: ${taskId} [${attemptId}]`)
    writeDownloadHistory(task, active.meta, 'success')
  } else if (result.outcome === 'cancelled') {
    // 取消不写下载历史（与旧行为一致：用户主动取消不算失败记录）
    log.info(`Download cancelled: ${taskId} [${attemptId}]`)
  } else if (result.outcome === 'outcome-unknown') {
    log.error(
      `Download outcome unknown: ${taskId} [${attemptId}] temp=${result.tempPath ?? result.tempPattern} target=${result.targetPath}`
    )
    writeDownloadHistory(
      task,
      active.meta,
      'failed',
      `结果未知：${result.error?.message ?? '无法确认提交是否生效'}`
    )
  } else {
    log.error(`Download failed: ${taskId} [${attemptId}] - ${result.error?.message ?? 'unknown error'}`)
    writeDownloadHistory(task, active.meta, 'failed', result.error?.message)
  }
}

/** 下载历史记录（异步、失败只记日志，不影响传输终态） */
function writeDownloadHistory(
  task: DownloadTaskData,
  meta: TaskMeta | undefined,
  status: 'success' | 'failed',
  errorMessage?: string
): void {
  if (!meta) return
  try {
    const record: DownloadRecord = {
      id: uuidv4(),
      taskId: task.taskId,
      sessionId: task.sessionId,
      sessionName: meta.sessionName || 'Unknown',
      host: task.sshConfig.host,
      port: task.sshConfig.port,
      remotePath: meta.remotePath,
      localPath: meta.localPath,
      fileName: meta.fileName || path.basename(meta.remotePath),
      fileSize: meta.fileSize,
      startTime: meta.startTime,
      endTime: new Date(),
      status,
      error: errorMessage,
      downloadDir: downloadHistory.getDownloadDir(
        task.sessionId,
        meta.sessionName || '',
        task.sshConfig.host,
        task.sshConfig.port
      )
    }
    downloadHistory
      .addRecord(record)
      .then(() => {
        log.info(`Download record saved: ${record.fileName} (${status})`)
      })
      .catch((error) => {
        log.error('Failed to save download record:', error)
      })
  } catch (error) {
    log.error('Failed to build download record:', error)
  }
}

function updatePhase(active: ActiveWorker, phase: unknown): boolean {
  if (!isTransferPhase(phase)) return false
  // 终态 'completed' 只能由 result 声明：进度/阶段消息里的 completed 一律忽略
  if (phase === 'completed') {
    log.warn(`Ignoring terminal phase reported as progress for download ${active.taskId}`)
    return false
  }
  if (PHASE_RANK[phase] < PHASE_RANK[active.phase]) {
    log.warn(`Ignoring phase regression for download ${active.taskId}: ${active.phase} -> ${phase}`)
    return false
  }
  const changed = active.phase !== phase
  active.phase = phase
  return changed
}

function clampNumber(value: unknown, total: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.max(0, Math.min(numeric, Math.max(0, total)))
}

/** 终态只上报一次：台账已记录则丢弃（旧尝试/重复 result 不会回退终态） */
function recordTerminalAndSend(
  taskId: string,
  attemptId: string,
  result: TransferAttemptResult,
  payload: TransferRendererPayload
): void {
  if (!terminalLedger.record(taskId, attemptId, result.outcome)) {
    log.warn(`Suppressing duplicate terminal receipt for download task ${taskId} [${attemptId}]`)
    return
  }
  sendProgressToRenderer(payload)
}

/**
 * 发送进度到渲染进程
 */
function sendProgressToRenderer(data: any) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('file:progress', data)
  }
}

/** 超过宽限期仍未确认取消：强制终止，并给 terminate 本身有限等待 */
function forceTerminate(active: ActiveWorker): void {
  if (active.terminal || active.terminating) return
  active.terminating = true
  log.warn(`Download task ${active.taskId} [${active.attemptId}] did not confirm cancellation in time; terminating worker`)
  try {
    void active.worker.terminate()
  } catch (error) {
    log.warn(`Terminate download worker ${active.taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  active.terminateTimer = setTimeout(() => {
    if (active.settled || active.terminal) return
    // 强制终止后仍未退出：不能假设远端/本地已回滚，只能按结果未知结算并释放额度
    log.error(`Worker ${active.taskId} [${active.attemptId}] did not exit after terminate; settling as outcome-unknown`)
    const synthetic = buildSyntheticResult({
      taskId: active.taskId,
      attemptId: active.attemptId,
      direction: 'download',
      outcome: 'outcome-unknown',
      phase: active.phase,
      expectedSize: active.expectedSize,
      transferredSize: active.lastTransferredSize,
      targetPath: active.targetPath,
      tempPath: active.tempPath,
      tempCleanup: 'unknown',
      code: 'TRANSFER_CANCEL_UNCONFIRMED',
      message: '传输 Worker 在强制终止后仍未退出；无法确认目标是否已被替换，已按结果未知结算'
    })
    active.terminal = synthetic
    recordTerminalAndSend(active.taskId, active.attemptId, synthetic, resultToRendererPayload(synthetic, active.sessionId))
    // 只有 exit 能释放 Worker/目标串行链/调度名额；结果未知不等于线程已停止。
  }, transferAttemptTimeouts.terminateWaitMs)
  active.terminateTimer.unref?.()
}

/** 通知 Worker 停止（由它关闭句柄、清理自己的临时文件），不在这里宣布取消 */
function requestWorkerCancel(active: ActiveWorker): boolean {
  if (active.terminal) return false
  if (active.cancelRequested) return true
  active.cancelRequested = true
  try {
    active.worker.postMessage({ type: 'cancel', taskId: active.taskId, attemptId: active.attemptId })
  } catch (error) {
    log.warn(
      `Failed to post cancel message to download worker ${active.taskId}: ${error instanceof Error ? error.message : String(error)}`
    )
    forceTerminate(active)
    return true
  }
  active.cancelTimer = setTimeout(() => {
    active.cancelTimer = undefined
    forceTerminate(active)
  }, transferAttemptTimeouts.cancelGraceMs)
  active.cancelTimer.unref?.()
  return true
}

/**
 * 取消下载任务
 *
 * 活动任务只发送取消通知：确认由 Worker 的 result 决定，管理器不会立即宣布 cancelled。
 * 排队任务（尚未创建 Worker）可立即上报 cancelled，因为不存在需要回滚的副作用。
 */
export function cancelDownload(taskId: string): boolean {
  const admission = admissions.get(taskId)
  if (admission) admission.cancelled = true

  const active = activeWorkers.get(taskId)
  if (active) {
    if (active.terminal) return true
    log.info(`Requesting cancellation of download task ${taskId} [${active.attemptId}]`)
    return requestWorkerCancel(active)
  }

  if (downloadChain.cancelId(taskId)) {
    log.info(`Cancelling queued download task ${taskId}`)
    reportUnstartedCancelled(taskId)
    return true
  }
  if (transferScheduler.cancelId(taskId)) {
    log.info(`Cancelling globally queued download task ${taskId}`)
    reportUnstartedCancelled(taskId)
    return true
  }
  if (admission) {
    // acquire 已同步发放额度、await 尚未恢复：没有 Worker，仍须给 UI 明确终态。
    reportUnstartedCancelled(taskId)
    return true
  }
  return false
}

/** 尚未创建 Worker 的任务：没有远端/本地副作用可回滚，可立即确认取消 */
function reportUnstartedCancelled(taskId: string): void {
  const admission = admissions.get(taskId)
  const attemptId = admission?.attemptId ?? 'not-dispatched'
  const synthetic = buildSyntheticResult({
    taskId,
    attemptId,
    direction: 'download',
    outcome: 'cancelled',
    expectedSize: admission?.expectedSize ?? 0,
    targetPath: admission?.targetPath ?? '',
    tempCleanup: 'unused',
    code: 'TRANSFER_CANCELLED',
    message: '下载已取消（Worker 尚未启动，无副作用）'
  })
  recordTerminalAndSend(taskId, attemptId, synthetic, resultToRendererPayload(synthetic, admission?.sessionId ?? ''))
}

/**
 * 取消某会话的所有活跃下载任务（会话断开时调用）
 * 返回已取消的任务数；排队任务立即补发 cancelled，活动任务等 Worker 确认后再上报
 */
export function cancelDownloadsBySession(sessionId: string): number {
  const pendingIds = [...admissions]
    .filter(([, task]) => task.sessionId === sessionId && !task.cancelled)
    .map(([id, task]) => {
      task.cancelled = true
      return id
    })
  const selected = new Set(pendingIds)

  // 路径串行队列（已拿到额度、等待同路径前序任务）
  const queuedChainIds = downloadChain.cancelGroup(sessionId)
  // 全局调度队列（尚未拿到 Worker 额度，从未创建 Worker）
  const queuedSchedulerIds = pendingIds.filter((taskId) => transferScheduler.cancelId(taskId))
  const queuedTaskIds = [
    ...new Set([...queuedChainIds, ...queuedSchedulerIds, ...pendingIds.filter((taskId) => !activeWorkers.has(taskId))])
  ]
  for (const taskId of queuedTaskIds) {
    log.info(`Cancelling queued download task ${taskId} (session ${sessionId} disconnected)`)
    reportUnstartedCancelled(taskId)
  }

  let count = queuedTaskIds.length
  for (const [taskId, active] of activeWorkers) {
    if (active.sessionId === sessionId && selected.has(taskId) && !active.cancelRequested) {
      log.info(`Requesting cancellation of download task ${taskId} (session ${sessionId} disconnected)`)
      // 不立即上报 cancelled：等 Worker 关闭句柄、清理临时文件后确认
      requestWorkerCancel(active)
      count++
    }
  }
  return count
}

/**
 * 获取活动任务数量
 */
export function getActiveTaskCount(): number {
  return activeWorkers.size
}

/**
 * 获取所有活动任务
 */
export function getActiveTasks(): string[] {
  return Array.from(activeWorkers.keys())
}

/**
 * 清理所有 Worker（应用退出路径，不再向界面发回执）
 */
export function cleanupAllWorkers(): Promise<void> {
  const exits: Promise<unknown>[] = []
  for (const task of admissions.values()) task.cancelled = true
  downloadChain.cancelAll()
  for (const taskId of admissions.keys()) transferScheduler.cancelId(taskId)
  for (const [taskId, active] of activeWorkers) {
    log.info(`Terminating worker for task ${taskId}`)
    active.shuttingDown = true
    active.cancelRequested = true
    clearTimeout(active.cancelTimer)
    clearTimeout(active.terminateTimer)
    active.cancelTimer = undefined
    active.terminateTimer = undefined
    try {
      exits.push(active.worker.terminate())
    } catch {
      /* 已退出 */
    }
  }
  // terminate 的 Promise 只有在线程已退出后才完成；exit 监听器负责释放额度和元信息。
  return Promise.all(exits).then(() => undefined)
}

/** 测试用：重置模块级状态 */
export function __resetDownloadManagerForTests(): void {
  activeWorkers.clear()
  admissions.clear()
  terminalLedger.clear()
  taskMetaStore.clear()
}
