/**
 * 上传 Worker 管理器
 * 管理上传 Worker 的创建、消息转发和生命周期
 */
import { Worker } from 'worker_threads'
import * as path from 'path'
import log from 'electron-log'
import type { BrowserWindow } from 'electron'
import { createSerialChain } from './serial-chain'

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
  runUploadWorkerAndWait(task).catch(() => {})
  return Promise.resolve()
}

/**
 * 启动上传 Worker 并阻塞等待完成（MCP 同步路径用）
 *
 * 同 SSH endpoint + 规范化远程路径的上传会串行排队，避免并发写同一远端文件导致损坏。
 */
export function runUploadWorkerAndWait(task: UploadTaskData): Promise<void> {
  const key = uploadChainKey(task.sshConfig, task.remotePath)
  return uploadChain.run(key, () => runUploadWorkerInternal(task), {
    id: task.taskId,
    group: task.sessionId
  })
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

  return new Promise<void>((resolve, reject) => {
    let settled = false

    // 监听 Worker 消息
    worker.on('message', (msg: any) => {
      handleWorkerMessage(msg, task)
      if (settled) return
      if (msg.type === 'complete') {
        settled = true
        resolve()
      } else if (msg.type === 'error') {
        settled = true
        reject(new Error(msg.error || 'Upload failed'))
      }
    })

    // 监听 Worker 错误
    worker.on('error', (err) => {
      log.error(`Upload worker error for task ${taskId}:`, err.message)
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
      if (!settled) {
        settled = true
        reject(err)
      }
    })

    // 监听 Worker 退出
    worker.on('exit', (code) => {
      activeWorkers.delete(taskId)
      if (!settled) {
        settled = true
        const error = code === 0
          ? new Error('Upload worker exited without a terminal message')
          : new Error(`Upload worker exited with code ${code}`)
        log.warn(`Upload worker for task ${taskId} exited before protocol settlement (code ${code})`)
        reject(error)
      } else if (code === 0) {
        log.info(`Upload worker for task ${taskId} completed successfully`)
      } else {
        log.warn(`Upload worker for task ${taskId} exited with code ${code} after settlement`)
      }
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
  const active = activeWorkers.get(taskId)
  if (active) {
    log.info(`Cancelling upload task ${taskId}`)
    active.worker.terminate()
    activeWorkers.delete(taskId)
    return true
  }
  if (uploadChain.cancelId(taskId)) {
    log.info(`Cancelling queued upload task ${taskId}`)
    return true
  }
  return false
}

/**
 * 取消某会话的所有活跃上传任务（会话断开时调用）
 * 返回已取消的任务数；每个被终止的 worker 都补发一个 cancelled 事件以更新 UI
 */
export function cancelUploadsBySession(sessionId: string): number {
  const queuedTaskIds = uploadChain.cancelGroup(sessionId)
  for (const taskId of queuedTaskIds) {
    log.info(`Cancelling queued upload task ${taskId} (session ${sessionId} disconnected)`)
    sendProgressToRenderer({ taskId, cancelled: true })
  }
  let count = queuedTaskIds.length
  for (const [taskId, active] of activeWorkers) {
    if (active.sessionId === sessionId) {
      log.info(`Cancelling upload task ${taskId} (session ${sessionId} disconnected)`)
      active.worker.terminate()
      activeWorkers.delete(taskId)
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
  uploadChain.cancelAll()
  for (const [taskId, active] of activeWorkers) {
    log.info(`Terminating upload worker for task ${taskId}`)
    active.worker.terminate()
  }
  activeWorkers.clear()
}