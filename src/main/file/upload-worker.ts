/**
 * 上传 Worker - 在独立线程中执行文件上传
 * 仅使用 SFTP；其他传输方式由插件提供
 */
import { parentPort, workerData } from 'worker_threads'
import { Client } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { sftpMkdirP } from './sftp-mkdir'
import { connectTransferSSH } from './ssh-transfer-connection'
import { redactSecrets } from './redact'

// 类型定义

// Worker 接收的任务数据
interface UploadTaskData {
  taskId: string
  sessionId: string
  method: 'sftp'  // 上传方式
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
  localPath: string   // 本地文件路径
  remotePath: string  // 远程目标路径
  fileSize: number
}

// 进度消息
interface ProgressMessage {
  type: 'progress'
  taskId: string
  sessionId: string
  progress: number
  transferredSize: number
  fileSize: number
  speed: number
}

// 完成消息
interface CompleteMessage {
  type: 'complete'
  taskId: string
  sessionId: string
  transferredSize: number
}

// 错误消息
interface ErrorMessage {
  type: 'error'
  taskId: string
  sessionId: string
  error: string
}

// 日志消息
interface LogMessage {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage | LogMessage

// 发送消息到主进程
function sendMessage(msg: WorkerMessage) {
  if (parentPort) {
    parentPort.postMessage(msg)
  }
}

// 日志函数（经 redactSecrets 闸口脱敏，确保一次性握手 token 不落盘）
function log(level: 'info' | 'warn' | 'error', message: string) {
  sendMessage({ type: 'log', level, message: redactSecrets(message) })
}

// 执行上传
async function executeUpload(task: UploadTaskData) {
  if (task.method !== 'sftp') throw new Error('Built-in file transfers only support SFTP')
  const { taskId, sessionId, method, sshConfig, localPath, remotePath, fileSize } = task

  log('info', `Worker starting upload (${method}): ${localPath} -> ${remotePath} (${fileSize} bytes)`)

  // 检查本地文件是否存在
  if (!fs.existsSync(localPath)) {
    sendMessage({ type: 'error', taskId, sessionId, error: 'Local file not found' })
    // 抛错走 .catch exit(1)，不走成功 return（否则入口 .then 会 exit(0)，错误却以成功码退出）
    throw new Error('Local file not found')
  }

  // 建立 SSH 连接：仅连接阶段允许重试；连接成功后才开始写远端文件。
  sendMessage({ type: 'progress', taskId, sessionId, progress: 0, transferredSize: 0, fileSize, speed: 0 })
  let client: Client
  try {
    client = await connectTransferSSH(sshConfig, log)
  } catch (error) {
    const errMsg = (error as Error).message
    log('error', `SSH connection error: ${errMsg}`)
    sendMessage({ type: 'error', taskId, sessionId, error: errMsg })
    throw error
  }

  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now()

    // 连接错误
    client.on('error', (err) => {
      const errMsg = err.message?.split('\n')[0] || err.toString()
      log('error', `SSH connection error: ${errMsg}`)
      sendMessage({ type: 'error', taskId, sessionId, error: errMsg })
      reject(err)
    })

    log('info', 'SSH connection ready')
    uploadViaSFTP(client, task, startTime, resolve, reject)
  })
}

// SFTP 方式上传
function uploadViaSFTP(
  client: Client,
  task: UploadTaskData,
  startTime: number,
  resolve: () => void,
  reject: (err: Error) => void
) {
  const { taskId, sessionId, localPath, remotePath, fileSize } = task
  let transferred = 0
  let lastProgressSent = 0

  const sendProgress = () => {
    const now = Date.now()
    if (now - lastProgressSent < 1000) return
    lastProgressSent = now

    const elapsed = (now - startTime) / 1000
    const speed = elapsed > 0 ? transferred / elapsed : 0

    sendMessage({
      type: 'progress',
      taskId,
      sessionId,
      progress: fileSize > 0 ? Math.round((transferred / fileSize) * 100) : 0,
      transferredSize: transferred,
      fileSize,
      speed
    })
  }

  client.sftp(async (err, sftp) => {
    if (err) {
      log('error', `SFTP init error: ${err.message}`)
      sendMessage({ type: 'error', taskId, sessionId, error: `SFTP error: ${err.message}` })
      client.end()
      reject(err)
      return
    }

    log('info', `SFTP subsystem started, uploading...`)

    // 确保远程父目录存在（与 exec/Python 路径的 os.makedirs 对齐）
    try {
      await sftpMkdirP(sftp, path.posix.dirname(remotePath))
    } catch (mkErr: any) {
      log('error', `SFTP mkdir parent dir error: ${mkErr.message}`)
      sendMessage({ type: 'error', taskId, sessionId, error: mkErr.message })
      client.end()
      reject(mkErr)
      return
    }

    sftp.fastPut(localPath, remotePath, {
      step: (transferredBytes: number) => {
        transferred = transferredBytes
        sendProgress()
      },
      concurrency: 64,
      chunkSize: 32768
    }, (err) => {
      if (err) {
        log('error', `SFTP upload error: ${err.message}`)
        sendMessage({ type: 'error', taskId, sessionId, error: err.message })
        client.end()
        reject(err)
      } else {
        const elapsed = (Date.now() - startTime) / 1000
        sendMessage({
          type: 'progress',
          taskId,
          sessionId,
          progress: 100,
          transferredSize: fileSize,
          fileSize,
          speed: elapsed > 0 ? fileSize / elapsed : 0
        })

        sendMessage({
          type: 'complete',
          taskId,
          sessionId,
          transferredSize: fileSize
        })

        log('info', `SFTP upload completed: ${remotePath}`)
        client.end()
        resolve()
      }
    })
  })
}

// Worker 入口
// 与 download-worker 一致：成功 exit(0)、失败 exit(1)。顶层异常或连接/流资源未自然关闭时，
// Worker 线程不会自行退出--管理器靠 exit 事件回收任务，缺 exit 会永久挂起、占用资源。
// catch 不重发 error：各失败路径已在 reject 前发送唯一终态 error 消息，这里只日志+退出，
// 避免 manager 收到两条 error 把同一失败报两次给渲染进程。
if (workerData) {
  const task: UploadTaskData = workerData
  executeUpload(task)
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      log('error', `Upload failed: ${err.message}`)
      process.exit(1)
    })
}
