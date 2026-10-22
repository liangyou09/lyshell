/**
 * 下载 Worker 管理器
 * 管理下载 Worker 的创建、消息转发和生命周期
 */
import { Worker } from 'worker_threads'
import * as path from 'path'
import log from 'electron-log'
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

// Worker 任务数据
interface DownloadTaskData {
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
interface ActiveWorker {
  worker: Worker
  taskId: string
  sessionId: string
  startTime: number
  meta: TaskMeta
}

// 全局 Worker 映射
const activeWorkers: Map<string, ActiveWorker> = new Map()

// 已取消但 Worker 尚未 exit 的任务：用于抑制取消后迟到的 progress/complete 消息，
// 避免取消后仍写下载历史或把已移除的进度条重新点亮。
const cancelledTaskIds: Set<string> = new Set()
// 在首个 await 前登记，覆盖 acquire 已发放额度、调用方尚未恢复的取消窗口。
const admissions = new Map<string, { sessionId: string; cancelled: boolean }>()

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
      sendProgressToRenderer({
        taskId: task.taskId,
        sessionId: task.sessionId,
        failed: true,
        error: '下载队列已满，请稍后重试',
        progress: 0,
        transferredSize: 0,
        fileSize: task.fileSize,
        speed: 0
      })
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
export async function runDownloadWorkerAndWait(task: DownloadTaskData): Promise<void> {
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
    const key = downloadChainKey(task.localPath)
    return await downloadChain.run(key, () => runDownloadWorkerInternal(task), {
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
function runDownloadWorkerInternal(task: DownloadTaskData): Promise<void> {
  const { taskId, sessionId } = task

  log.info(`Starting download worker (await completion) for task ${taskId}`)

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
    sendProgressToRenderer({
      taskId,
      sessionId,
      failed: true,
      error: err.message,
      progress: 0,
      transferredSize: 0,
      fileSize: task.fileSize,
      speed: 0
    })
    return Promise.reject(err)
  }

  // 记录活动 Worker
  activeWorkers.set(taskId, {
    worker,
    taskId,
    sessionId,
    startTime: Date.now(),
    meta: meta || {
      taskId,
      sessionId,
      remotePath: task.remotePath,
      localPath: task.localPath,
      fileSize: task.fileSize,
      startTime: new Date()
    }
  })

  return new Promise<void>((resolve, reject) => {
    // 协议终态先记录，真正 settle 等 Worker exit，避免 complete 后线程未退出的窗口期提前释放额度
    let settled = false
    let terminalOk = false
    let terminalError: Error | undefined

    // 监听 Worker 消息
    worker.on('message', (msg: any) => {
      // 取消后迟到的消息一律丢弃，不能再写历史或产生完成回执
      if (cancelledTaskIds.has(taskId)) return

      if (msg.type === 'complete' || msg.type === 'error') {
        if (settled) return
        settled = true
        terminalOk = msg.type === 'complete'
        terminalError = msg.type === 'complete'
          ? undefined
          : new Error(msg.error || 'Download failed')
        handleWorkerMessage(msg, task)
        return
      }

      handleWorkerMessage(msg, task)
    })

    // 监听 Worker 错误：只记录终态与失败回执，不释放额度、不提前 settle
    worker.on('error', (err) => {
      log.error(`Worker error for task ${taskId}:`, err.message)
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
            speed: 0
          })
        }
      }
    })

    // 监听 Worker 退出：线程真正结束后才 settle 并释放额度
    worker.on('exit', (code) => {
      activeWorkers.delete(taskId)
      taskMetaStore.delete(taskId)

      let error: Error | null = null
      if (cancelledTaskIds.delete(taskId)) {
        log.info(`Worker for task ${taskId} exited after cancellation`)
        error = new TransferCancelledError('Download cancelled')
      } else if (terminalOk) {
        log.info(`Worker for task ${taskId} completed successfully`)
        error = null
      } else if (settled) {
        error = terminalError ?? new Error('Download failed')
      } else {
        error = code === 0
          ? new Error('Download worker exited without a terminal message')
          : new Error(`Download worker exited with code ${code}`)
        log.warn(`Worker for task ${taskId} exited before protocol settlement (code ${code})`)
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
function handleWorkerMessage(msg: any, task: DownloadTaskData) {
  const { taskId, sessionId } = task
  const active = activeWorkers.get(taskId)

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
        failed: false,
        completed: true
      })
      log.info(`Download completed: ${taskId}`)

      // 保存下载记录
      if (active?.meta) {
        const meta = active.meta
        const record: DownloadRecord = {
          id: uuidv4(),
          taskId: taskId,
          sessionId: sessionId,
          sessionName: meta.sessionName || 'Unknown',
          host: task.sshConfig.host,
          port: task.sshConfig.port,
          remotePath: meta.remotePath,
          localPath: meta.localPath,
          fileName: meta.fileName || path.basename(meta.remotePath),
          fileSize: meta.fileSize,
          startTime: meta.startTime,
          endTime: new Date(),
          status: 'success',
          downloadDir: downloadHistory.getDownloadDir(
            sessionId,
            meta.sessionName || '',
            task.sshConfig.host,
            task.sshConfig.port
          )
        }

        // 异步保存记录
        downloadHistory.addRecord(record).then(() => {
          log.info(`Download record saved: ${record.fileName}`)
        }).catch(err => {
          log.error('Failed to save download record:', err)
        })
      }
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
        failed: true,
        error: msg.error,
        completed: false
      })
      log.error(`Download failed: ${taskId} - ${msg.error}`)

      // 保存失败记录
      if (active?.meta) {
        const meta = active.meta
        const record: DownloadRecord = {
          id: uuidv4(),
          taskId: taskId,
          sessionId: sessionId,
          sessionName: meta.sessionName || 'Unknown',
          host: task.sshConfig.host,
          port: task.sshConfig.port,
          remotePath: meta.remotePath,
          localPath: meta.localPath,
          fileName: meta.fileName || path.basename(meta.remotePath),
          fileSize: meta.fileSize,
          startTime: meta.startTime,
          endTime: new Date(),
          status: 'failed',
          error: msg.error,
          downloadDir: downloadHistory.getDownloadDir(
            sessionId,
            meta.sessionName || '',
            task.sshConfig.host,
            task.sshConfig.port
          )
        }

        downloadHistory.addRecord(record).catch(err => {
          log.error('Failed to save failed download record:', err)
        })
      }
      break

    case 'log':
      // 处理 Worker 日志
      if (msg.level === 'error') {
        log.error(`[Worker] ${msg.message}`)
      } else if (msg.level === 'warn') {
        log.warn(`[Worker] ${msg.message}`)
      } else {
        log.info(`[Worker] ${msg.message}`)
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
 * 取消下载任务
 */
export function cancelDownload(taskId: string): boolean {
  const pending = admissions.get(taskId)
  if (pending) pending.cancelled = true
  const active = activeWorkers.get(taskId)
  if (active) {
    log.info(`Cancelling download task ${taskId}`)
    // 先标记再 terminate：exit 前迟到的 complete/progress 消息会被丢弃
    cancelledTaskIds.add(taskId)
    active.worker.terminate()
    taskMetaStore.delete(taskId)
    return true
  }
  if (downloadChain.cancelId(taskId)) {
    log.info(`Cancelling queued download task ${taskId}`)
    return true
  }
  if (transferScheduler.cancelId(taskId)) {
    log.info(`Cancelling globally queued download task ${taskId}`)
    return true
  }
  return Boolean(pending)
}

/**
 * 取消某会话的所有活跃下载任务（会话断开时调用）
 * 返回已取消的任务数；每个被取消的任务都补发一个 cancelled 事件以更新 UI
 */
export function cancelDownloadsBySession(sessionId: string): number {
  const pendingIds = [...admissions].filter(([, task]) => task.sessionId === sessionId && !task.cancelled).map(([id, task]) => { task.cancelled = true; return id })
  const selected = new Set(pendingIds)
  // 路径串行队列（已拿到额度、等待同路径前序任务）
  const queuedChainIds = downloadChain.cancelGroup(sessionId)
  // 全局调度队列（尚未拿到 Worker 额度，从未创建 Worker）
  const queuedSchedulerIds = pendingIds.filter(taskId => transferScheduler.cancelId(taskId))
  const queuedTaskIds = [...new Set([...queuedChainIds, ...queuedSchedulerIds, ...pendingIds.filter(taskId => !activeWorkers.has(taskId))])]
  for (const taskId of queuedTaskIds) {
    log.info(`Cancelling queued download task ${taskId} (session ${sessionId} disconnected)`)
    taskMetaStore.delete(taskId)
    sendProgressToRenderer({ taskId, cancelled: true })
  }

  let count = queuedTaskIds.length
  for (const [taskId, active] of activeWorkers) {
    if (active.sessionId === sessionId && selected.has(taskId)) {
      log.info(`Cancelling download task ${taskId} (session ${sessionId} disconnected)`)
      cancelledTaskIds.add(taskId)
      active.worker.terminate()
      taskMetaStore.delete(taskId)
      sendProgressToRenderer({ taskId, cancelled: true })
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
 * 清理所有 Worker
 */
export function cleanupAllWorkers() {
  for (const task of admissions.values()) task.cancelled = true
  downloadChain.cancelAll()
  for (const taskId of admissions.keys()) transferScheduler.cancelId(taskId)
  for (const [taskId, active] of activeWorkers) {
    log.info(`Terminating worker for task ${taskId}`)
    cancelledTaskIds.add(taskId)
    active.worker.terminate()
  }
  activeWorkers.clear()
  taskMetaStore.clear()
}
