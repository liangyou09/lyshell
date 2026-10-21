/**
 * 下载 Worker - 在独立线程中执行文件下载
 * 完全不阻塞主进程
 * 仅使用 SFTP；其他传输方式由插件提供
 */
import { parentPort, workerData } from 'worker_threads'
import { Client } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { redactSecrets } from './redact'

// 类型定义
type SSHConnectConfig = any

// Worker 接收的任务数据
interface DownloadTaskData {
  taskId: string
  sessionId: string
  method: 'sftp'  // 下载方式
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

// 执行下载
async function executeDownload(task: DownloadTaskData) {
  if (task.method !== 'sftp') throw new Error('Built-in file transfers only support SFTP')
  const { taskId, sessionId, method, sshConfig, remotePath, localPath, fileSize } = task

  log('info', `Worker starting download (${method}): ${remotePath} -> ${localPath} (${fileSize} bytes)`)

  // 确保本地目录存在
  const localDir = path.dirname(localPath)
  await fs.promises.mkdir(localDir, { recursive: true })

  // 建立 SSH 连接
  const client = new Client()

  return new Promise<void>((resolve, reject) => {
    let startTime = Date.now()

    // 连接配置
    const connectionConfig: SSHConnectConfig = {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      readyTimeout: sshConfig.readyTimeout || 30000,
      keepaliveInterval: sshConfig.keepaliveInterval || 10000,
      keepaliveCountMax: 3,
    }

    log('info', `Connecting to ${sshConfig.host}:${sshConfig.port} as ${sshConfig.username}`)

    // 认证方式
    if (sshConfig.password) {
      connectionConfig.password = sshConfig.password
      log('info', 'Using password authentication')
    } else if (sshConfig.privateKey) {
      connectionConfig.privateKey = sshConfig.privateKey
      if (sshConfig.passphrase) {
        connectionConfig.passphrase = sshConfig.passphrase
      }
      log('info', 'Using privateKey authentication')
    } else {
      log('warn', 'No authentication method provided!')
    }

    // 连接错误
    client.on('error', (err) => {
      const errMsg = err.message?.split('\n')[0] || err.toString()
      log('error', `SSH connection error: ${errMsg}`)
      sendMessage({
        type: 'error',
        taskId,
        sessionId,
        error: errMsg
      })
      reject(err)
    })

    // 连接就绪
    client.on('ready', () => {
      log('info', `SSH connection ready`)
      startTime = Date.now()

      downloadViaSFTP(client, task, startTime, resolve, reject)
    })

    // 开始连接
    client.connect(connectionConfig)
  })
}

// SFTP 方式下载
function downloadViaSFTP(
  client: Client,
  task: DownloadTaskData,
  startTime: number,
  resolve: () => void,
  reject: (err: Error) => void
) {
  const { taskId, sessionId, remotePath, localPath, fileSize } = task
  let transferred = 0
  let lastProgressSent = 0

  // 发送进度（限制频率）
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

  client.sftp((err, sftp) => {
    if (err) {
      log('error', `SFTP init error: ${err.message}`)
      sendMessage({
        type: 'error',
        taskId,
        sessionId,
        error: `SFTP subsystem error: ${err.message}`
      })
      client.end()
      reject(err)
      return
    }

    log('info', `SFTP subsystem started, downloading...`)

    sftp.fastGet(remotePath, localPath, {
      step: (transferredBytes: number) => {
        transferred = transferredBytes
        sendProgress()
      },
      concurrency: 64,
      chunkSize: 32768
    }, (err) => {
      if (err) {
        log('error', `SFTP download error: ${err.message}`)
        sendMessage({
          type: 'error',
          taskId,
          sessionId,
          error: err.message
        })
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

        log('info', `SFTP download completed: ${localPath}`)
        client.end()
        resolve()
      }
    })
  })
}

// Worker 入口
if (workerData) {
  const task = workerData as DownloadTaskData
  executeDownload(task)
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      log('error', `Download failed: ${err.message}`)
      process.exit(1)
    })
}