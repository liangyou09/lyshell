/**
 * 上传 Worker 管理器
 * 管理上传 Worker 的创建、消息转发和生命周期
 */
import { Worker } from 'worker_threads'
import * as path from 'path'
import log from 'electron-log'
import type { BrowserWindow } from 'electron'
import { createSerialChain } from './serial-chain'
import {
  transferScheduler,
  transferEndpointKey,
  type TransferLease,
  TransferCancelledError,
  TransferQueueFullError
} from './transfer-scheduler'

// Worker 任务数据
interface UploadTaskData {
  taskId: string
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
  localPath: string
  remotePath: string
  fileSize: number
}

// 活动中的 Worker
interface ActiveWorker {
  worker: Worker
  taskId: string
  sessionId: string
  startTime: number
}

// 全局 Worker 映射
const activeWorkers: Map<string, ActiveWorker> = new Map()

// 已取消但 Worker 尚未 exit 的任务：用于抑制取消后迟到的 progress/complete/error 消息
const cancelledTaskIds: Set<string> = new Set()
// 在首个 await 前登记，覆盖 acquire 已发放额度、调用方尚未恢复的取消窗口。
const admissions = new Map<string, { sessionId: string; cancelled: boolean }>()

// 同 SSH endpoint + 规范化远程路径的上传串行化：两个并发上传写同一远端文件会让
// Python `open(path, "wb")` 互相 truncate + 交错写入，导致远端文件损坏且双方都不报错。
// 后到的同路径上传排队在前一个完成/失败/取消之后执行。
// key 用 host:port:user + 远程路径，不含 sessionId——克隆会话(sessionId 不同但同一主机/
// 用户/路径)写同一远端文件同样会损坏；path.posix.normalize 折叠 //、./、.. 别名防绕过。
const uploadChain = createSerialChain()

function uploadChainKey(sshConfig: UploadTaskData['sshConfig'], remotePath: string): string {
  const norm = path.posix.normalize(remotePath)
  return `${sshConfig.host}:${sshConfig.port}:${sshConfig.username || ''}\0${norm}`
}

// 主窗口引用（用于发送进度）
let mainWindow: BrowserWindow | null = null

/**
 * 设置主窗口引用
 */
export function setMainWindowForUpload(window: BrowserWindow | null) {
  mainWindow = window
}

/**
 * 启动上传 Worker（fire-and-forget，UI 路径用）
 */
export function startUploadWorker(task: UploadTaskData): Promise<void> {
  // 复用阻塞等待路径，仅忽略其 Promise 结果；进度/错误仍通过 message 事件推送
  runUploadWorkerAndWait(task).catch((error) => {
    // 排队容量满必须给 UI 一个明确失败回执，否则进度条会永远停在“等待中”
    if (error instanceof TransferQueueFullError) {
      log.warn(`Upload task ${task.taskId} rejected: ${error.message}`)
      sendProgressToRenderer({
        taskId: task.taskId,
        sessionId: task.sessionId,
        failed: true,
        error: '上传队列已满，请稍后重试',
        progress: 0,
        transferredSize: 0,
        fileSize: task.fileSize,
        speed: 0,
        direction: 'upload'
      })
    }
    // 取消回执由 cancelUpload / cancelUploadsBySession 负责；Worker 侧失败已有回执
  })
  return Promise.resolve()
}

/**
 * 启动上传 Worker 并阻塞等待完成（MCP 同步路径用）
 *
 * 同 SSH endpoint + 规范化远程路径的上传会串行排队，避免并发写同一远端文件导致损坏；
 * 不同路径的上传还会受全局 Worker 调度器限制（全局 4、每 endpoint 2）。
 */
export async function runUploadWorkerAndWait(task: UploadTaskData): Promise<void> {
  if (admissions.has(task.taskId)) throw new Error('Transfer task already exists')
  const admission = { sessionId: task.sessionId, cancelled: false }
  admissions.set(task.taskId, admission)
  let lease: TransferLease | undefined
  try {
    lease = await transferScheduler.acquire({
      taskId: task.taskId,
      sessionId: task.sessionId,
      endpoint: transferEndpointKey(task.sshConfig.host, task.sshConfig.port)
    })
    if (admission.cancelled) throw new TransferCancelledError()
    const key = uploadChainKey(task.sshConfig, task.remotePath)
    return await uploadChain.run(key, () => runUploadWorkerInternal(task), {
      id: task.taskId,
      group: task.sessionId
    })
  } finally {
    admissions.delete(task.taskId)
    lease?.release()
  }
}

/**
 * 实际创建并运行单个上传 Worker（无串行化逻辑）
 */
function runUploadWorkerInternal(task: UploadTaskData): Promise<void> {
  const { taskId, sessionId } = task

  log.info(`Starting upload worker (await completion) for task ${taskId}`)

  // Worker 脚本路径（编译后叫 uploadWorker.js）
  const workerPath = path.join(__dirname, 'uploadWorker.js')

  log.debug(`Upload worker path: ${workerPath}`)

  // 创建 Worker；同步构造失败时不会有线程需要等待 exit，直接失败
  let worker: Worker
  try {
    worker = new Worker(workerPath, {
      workerData: task
    })
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.error(`Failed to create upload worker for task ${taskId}: ${err.message}`)
    sendProgressToRenderer({
      taskId,
      sessionId,
      failed: true,
      error: err.message,
      progress: 0,
      transferredSize: 0,
      fileSize: task.fileSize,
      speed: 0,
      direction: 'upload'
    })
    return Promise.reject(err)
  }

  // 记录活动 Worker
  activeWorkers.set(taskId, {
    worker,
    taskId,
    sessionId,
    startTime: Date.now()
  })

  return new Promise<void>((resolve, reject) => {
    // 协议终态（complete/error 消息或 error 事件）先记录，真正 settle 等 Worker exit，
    // 这样 complete 之后线程尚未退出的窗口期不会提前释放并发额度。
    let settled = false
    let terminalOk = false
    let terminalError: Error | undefined

    // 监听 Worker 消息
    worker.on('message', (msg: any) => {
      // 取消后迟到的消息一律丢弃，不能再产生进度/完成回执
      if (cancelledTaskIds.has(taskId)) return

      if (msg.type === 'complete' || msg.type === 'error') {
        if (settled) return
        settled = true
        terminalOk = msg.type === 'complete'
        terminalError = msg.type === 'complete'
          ? undefined
          : new Error(msg.error || 'Upload failed')
        handleWorkerMessage(msg, task)
        return
      }

      handleWorkerMessage(msg, task)
    })

    // 监听 Worker 错误：只记录终态与失败回执，不释放额度、不提前 settle
    worker.on('error', (err) => {
      log.error(`Upload worker error for task ${taskId}:`, err.message)
      if (!settled) {
        settled = true
        terminalOk = false
        terminalError = err
        if (!cancelledTaskIds.has(taskId)) {
          sendProgressToRenderer({
            taskId,
            sessionId,
            failed: true,
            error: err.message,
            progress: 0,
            transferredSize: 0,
            fileSize: task.fileSize,
            speed: 0,
            direction: 'upload'
          })
        }
      }
    })

    // 监听 Worker 退出：线程真正结束后才 settle 并释放额度
    worker.on('exit', (code) => {
      activeWorkers.delete(taskId)

      let error: Error | null = null
      if (cancelledTaskIds.delete(taskId)) {
        log.info(`Upload worker for task ${taskId} exited after cancellation`)
        error = new TransferCancelledError('Upload cancelled')
      } else if (terminalOk) {
        log.info(`Upload worker for task ${taskId} completed successfully`)
        error = null
      } else if (settled) {
        error = terminalError ?? new Error('Upload failed')
      } else {
        error = code === 0
          ? new Error('Upload worker exited without a terminal message')
          : new Error(`Upload worker exited with code ${code}`)
        log.warn(`Upload worker for task ${taskId} exited before protocol settlement (code ${code})`)
      }

      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

/**
 * 处理 Worker 发来的消息
 */
function handleWorkerMessage(msg: any, task: UploadTaskData) {
  const { taskId } = task

  switch (msg.type) {
    case 'progress':
      // 转发进度到渲染进程
      sendProgressToRenderer({
        taskId: msg.taskId,
        sessionId: msg.sessionId,
        progress: msg.progress,
        transferredSize: msg.transferredSize,
        fileSize: msg.fileSize,
        speed: msg.speed,
        direction: 'upload',
        failed: false,
        completed: false
      })
      break

    case 'complete':
      // 发送完成消息
      sendProgressToRenderer({
        taskId: msg.taskId,
        sessionId: msg.sessionId,
        progress: 100,
        transferredSize: msg.transferredSize,
        fileSize: msg.transferredSize,
        speed: 0,
        direction: 'upload',
        failed: false,
        completed: true
      })
      log.info(`Upload completed: ${taskId}`)
      break

    case 'error':
      // 发送错误消息
      sendProgressToRenderer({
        taskId: msg.taskId,
        sessionId: msg.sessionId,
        progress: 0,
        transferredSize: 0,
        fileSize: 0,
        speed: 0,
        direction: 'upload',
        failed: true,
        error: msg.error,
        completed: false
      })
      log.error(`Upload failed: ${taskId} - ${msg.error}`)
      break

    case 'log':
      // 处理 Worker 日志
      if (msg.level === 'error') {
        log.error(`[UploadWorker] ${msg.message}`)
      } else if (msg.level === 'warn') {
        log.warn(`[UploadWorker] ${msg.message}`)
      } else {
        log.info(`[UploadWorker] ${msg.message}`)
      }
      break
  }
}

/**
 * 发送进度到渲染进程
 */
function sendProgressToRenderer(data: any) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('file:progress', data)
  }
}

/**
 * 取消上传任务
 */
export function cancelUpload(taskId: string): boolean {
  const pending = admissions.get(taskId)
  if (pending) pending.cancelled = true
  const active = activeWorkers.get(taskId)
  if (active) {
    log.info(`Cancelling upload task ${taskId}`)
    // 先标记再 terminate：exit 前迟到的 complete/progress 消息会被丢弃
    cancelledTaskIds.add(taskId)
    active.worker.terminate()
    return true
  }
  if (uploadChain.cancelId(taskId)) {
    log.info(`Cancelling queued upload task ${taskId}`)
    return true
  }
  if (transferScheduler.cancelId(taskId)) {
    log.info(`Cancelling globally queued upload task ${taskId}`)
    return true
  }
  return Boolean(pending)
}

/**
 * 取消某会话的所有活跃上传任务（会话断开时调用）
 * 返回已取消的任务数；每个被取消的任务都补发一个 cancelled 事件以更新 UI
 */
export function cancelUploadsBySession(sessionId: string): number {
  const pendingIds = [...admissions].filter(([, task]) => task.sessionId === sessionId && !task.cancelled).map(([id, task]) => { task.cancelled = true; return id })
  const selected = new Set(pendingIds)
  // 路径串行队列（已拿到额度、等待同路径前序任务）
  const queuedChainIds = uploadChain.cancelGroup(sessionId)
  // 全局调度队列（尚未拿到 Worker 额度，从未创建 Worker）
  const queuedSchedulerIds = pendingIds.filter(taskId => transferScheduler.cancelId(taskId))
  const queuedTaskIds = [...new Set([...queuedChainIds, ...queuedSchedulerIds, ...pendingIds.filter(taskId => !activeWorkers.has(taskId))])]
  for (const taskId of queuedTaskIds) {
    log.info(`Cancelling queued upload task ${taskId} (session ${sessionId} disconnected)`)
    sendProgressToRenderer({ taskId, cancelled: true })
  }

  let count = queuedTaskIds.length
  for (const [taskId, active] of activeWorkers) {
    if (active.sessionId === sessionId && selected.has(taskId)) {
      log.info(`Cancelling upload task ${taskId} (session ${sessionId} disconnected)`)
      cancelledTaskIds.add(taskId)
      active.worker.terminate()
      sendProgressToRenderer({ taskId, cancelled: true })
      count++
    }
  }
  return count
}

/**
 * 获取活动上传任务数量
 */
export function getActiveUploadCount(): number {
  return activeWorkers.size
}

/**
 * 清理所有上传 Worker
 */
export function cleanupAllUploadWorkers() {
  for (const task of admissions.values()) task.cancelled = true
  uploadChain.cancelAll()
  for (const taskId of admissions.keys()) transferScheduler.cancelId(taskId)
  for (const [taskId, active] of activeWorkers) {
    log.info(`Terminating upload worker for task ${taskId}`)
    cancelledTaskIds.add(taskId)
    active.worker.terminate()
  }
  activeWorkers.clear()
}
