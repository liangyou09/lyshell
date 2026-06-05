/**
 * 上传 Worker 管理器
 * 管理上传 Worker 的创建、消息转发和生命周期
 */
import { Worker } from 'worker_threads'
import * as path from 'path'
import log from 'electron-log'
import type { BrowserWindow } from 'electron'

// Worker 任务数据
interface UploadTaskData {
  taskId: string
  sessionId: string
  method: 'sftp' | 'exec'
  sshConfig: {
    host: string
    port: number
    username: string
    password?: string
    privateKey?: string
    passphrase?: string
    readyTimeout?: number
    keepaliveInterval?: number
    shellEnterCommands?: string
    shellEnterWait?: number
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

// 主窗口引用（用于发送进度）
let mainWindow: BrowserWindow | null = null

/**
 * 设置主窗口引用
 */
export function setMainWindowForUpload(window: BrowserWindow | null) {
  mainWindow = window
}

/**
 * 启动上传 Worker
 */
export function startUploadWorker(task: UploadTaskData): Promise<void> {
  const { taskId, sessionId } = task

  log.info(`Starting upload worker for task ${taskId}`)

  // Worker 脚本路径（编译后叫 uploadWorker.js）
  const workerPath = path.join(__dirname, 'uploadWorker.js')

  log.debug(`Upload worker path: ${workerPath}`)

  // 创建 Worker
  const worker = new Worker(workerPath, {
    workerData: task
  })

  // 记录活动 Worker
  activeWorkers.set(taskId, {
    worker,
    taskId,
    sessionId,
    startTime: Date.now()
  })

  // 监听 Worker 消息
  worker.on('message', (msg: any) => {
    handleWorkerMessage(msg, task)
  })

  // 监听 Worker 错误
  worker.on('error', (err) => {
    log.error(`Upload worker error for task ${taskId}: ${err.message}`)
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
    activeWorkers.delete(taskId)
  })

  // 监听 Worker 退出
  worker.on('exit', (code) => {
    if (code !== 0) {
      log.warn(`Upload worker for task ${taskId} exited with code ${code}`)
    } else {
      log.info(`Upload worker for task ${taskId} completed successfully`)
    }
    activeWorkers.delete(taskId)
  })

  return Promise.resolve()
}

/**
 * 处理 Worker 发来的消息
 */
function handleWorkerMessage(msg: any, task: UploadTaskData) {
  const { taskId, sessionId } = task

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
  const active = activeWorkers.get(taskId)
  if (active) {
    log.info(`Cancelling upload task ${taskId}`)
    active.worker.terminate()
    activeWorkers.delete(taskId)
    return true
  }
  return false
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
  for (const [taskId, active] of activeWorkers) {
    log.info(`Terminating upload worker for task ${taskId}`)
    active.worker.terminate()
  }
  activeWorkers.clear()
}