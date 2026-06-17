import log from 'electron-log'
import { BrowserWindow } from 'electron'
import { fileManager } from '../file'
import { IPC_CHANNELS } from '../ipc/handlers'

/**
 * 下载任务
 */
interface DownloadTask {
  taskId: string
  sessionId: string
  remotePath: string
  localPath: string
  fileName: string
  fileSize: number
  startTime: Date
}

/**
 * 下载队列管理器
 * 使用 fire-and-forget 模式，让 IPC handler 立即返回
 * 队列处理器使用 setImmediate 让步给事件循环，避免阻塞终端
 */
class DownloadQueue {
  private queue: DownloadTask[] = []
  private processing: boolean = false
  private paused: boolean = false

  /**
   * 添加任务到队列
   */
  push(task: DownloadTask): void {
    this.queue.push(task)
    log.info(`Download queued: ${task.fileName} (taskId: ${task.taskId})`)

    // 如果没有在处理，启动处理器
    if (!this.processing && !this.paused) {
      this.startProcessing()
    }
  }

  /**
   * 启动队列处理
   */
  private startProcessing(): void {
    this.processing = true
    this.processNext()
  }

  /**
   * 处理下一个任务
   */
  private async processNext(): Promise<void> {
    if (this.paused) {
      this.processing = false
      return
    }

    if (this.queue.length === 0) {
      this.processing = false
      log.debug('Download queue empty, stopping processor')
      return
    }

    const task = this.queue.shift()!

    // 关键：使用 setImmediate 让事件循环先处理其他事件（终端数据）
    await this.yieldToEventLoop()

    try {
      log.info(`Starting download: ${task.fileName}`)

      await fileManager.download(
        task.sessionId,
        task.remotePath,
        task.localPath,
        task.taskId
      )

      log.info(`Download completed: ${task.fileName}`)
    } catch (err) {
      const error = err as Error
      log.error(`Download failed: ${task.fileName}`, error.message)

      // 发送失败事件到所有窗口
      this.sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
        taskId: task.taskId,
        sessionId: task.sessionId,
        error: error.message,
        failed: true
      })
    }

    // 处理下一个任务
    this.processNext()
  }

  /**
   * 让步给事件循环
   * 使用 setImmediate 确保当前帧的终端数据先处理
   */
  private yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve))
  }

  /**
   * 发送事件到所有窗口
   */
  private sendToAllWindows(channel: string, ...args: any[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }

  /**
   * 获取队列长度
   */
  getLength(): number {
    return this.queue.length
  }

  /**
   * 暂停队列处理
   */
  pause(): void {
    this.paused = true
    log.info('Download queue paused')
  }

  /**
   * 恢复队列处理
   */
  resume(): void {
    this.paused = false
    if (!this.processing && this.queue.length > 0) {
      this.startProcessing()
    }
    log.info('Download queue resumed')
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = []
    log.info('Download queue cleared')
  }
}

// 单例导出
export const downloadQueue = new DownloadQueue()