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

// Worker 任务数据
interface DownloadTaskData {
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
 * 启动下载 Worker
 */
export function startDownloadWorker(task: DownloadTaskData): Promise<void> {
  const { taskId, sessionId } = task

  log.info(`Starting download worker for task ${taskId}`)

  // 获取任务元信息
  const meta = taskMetaStore.get(taskId)

  // Worker 脚本路径
  // electron-vite 在开发和生产模式都输出到 dist/main/
  // __dirname 是当前执行文件所在目录，即 dist/main/
  const workerPath = path.join(__dirname, 'worker.js')

  log.debug(`Worker path: ${workerPath}, __dirname: ${__dirname}`)

  // 创建 Worker
  const worker = new Worker(workerPath, {
    workerData: task
  })

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

  // 监听 Worker 消息
  worker.on('message', (msg: any) => {
    handleWorkerMessage(msg, task)
  })

  // 监听 Worker 错误
  worker.on('error', (err) => {
    log.error(`Worker error for task ${taskId}: ${err.message}`)
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
    activeWorkers.delete(taskId)
    taskMetaStore.delete(taskId)
  })

  // 监听 Worker 退出
  worker.on('exit', (code) => {
    if (code !== 0) {
      log.warn(`Worker for task ${taskId} exited with code ${code}`)
    } else {
      log.info(`Worker for task ${taskId} completed successfully`)
    }
    activeWorkers.delete(taskId)
    taskMetaStore.delete(taskId)
  })

  return Promise.resolve()
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
  const active = activeWorkers.get(taskId)
  if (active) {
    log.info(`Cancelling download task ${taskId}`)
    active.worker.terminate()
    activeWorkers.delete(taskId)
    taskMetaStore.delete(taskId)
    return true
  }
  return false
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
  for (const [taskId, active] of activeWorkers) {
    log.info(`Terminating worker for task ${taskId}`)
    active.worker.terminate()
  }
  activeWorkers.clear()
  taskMetaStore.clear()
}