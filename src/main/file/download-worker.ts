/**
 * 下载 Worker - 在独立线程中执行文件下载
 * 完全不阻塞主进程
 * 仅使用 SFTP；其他传输方式由插件提供
 *
 * 提交协议（OPT-11）：
 * - 数据先写到本地目标同目录的唯一随机临时文件，校验/fsync 后 rename 原子替换；
 * - 进度 100% 只是数据阶段结束，终态由 `result` 消息给出；
 * - 取消以消息通知，本线程关闭句柄并只清理自己的临时文件；rename 已发出后不再中断。
 */
import { parentPort, workerData } from 'worker_threads'
import { Client } from 'ssh2'
import type { SFTPWrapper } from '../types/global'
import * as fs from 'fs'
import * as path from 'path'
import { redactSecrets } from './redact'
import { connectTransferSSH } from './ssh-transfer-connection'
import { isSshHostKeyError, SshHostKeyError, type TransferHostKeyExpectation } from '../security/ssh-host-key'
import {
  buildSyntheticResult,
  commitDownload,
  createTransportFailureSignal,
  TransferAbortController,
  type TransferAttemptResult,
  type TransferErrorCode,
  type TransferPhase,
  type TransferSftp
} from './transfer-commit'

// Worker 接收的任务数据（attemptId 由主进程派发，Worker 不得自造）
interface DownloadTaskData {
  taskId: string
  attemptId: string
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
   * 主进程 dispatch 前从可信记录读出的固定指纹。
   * Worker 不读盘、不碰 Electron，也不会信任外部请求自报的 fingerprint。
   */
  hostKey?: TransferHostKeyExpectation
  remotePath: string
  localPath: string
  fileSize: number
}

interface CancelMessage {
  type: 'cancel'
  taskId: string
  attemptId: string
}

type WorkerOutbound =
  | { type: 'progress'; taskId: string; attemptId: string; phase: TransferPhase; transferredSize: number; fileSize: number; speed: number }
  | { type: 'phase'; taskId: string; attemptId: string; phase: TransferPhase }
  | { type: 'temp'; taskId: string; attemptId: string; tempPath: string }
  | { type: 'result'; taskId: string; attemptId: string; result: TransferAttemptResult }
  | { type: 'log'; taskId: string; attemptId: string; level: 'info' | 'warn' | 'error'; message: string }

function sendMessage(msg: WorkerOutbound): void {
  if (parentPort) parentPort.postMessage(msg)
}

/** 日志经 redactSecrets 闸口脱敏，确保一次性握手 token 不落盘 */
function makeLogger(task: DownloadTaskData) {
  return (level: 'info' | 'warn' | 'error', message: string): void => {
    sendMessage({ type: 'log', taskId: task.taskId, attemptId: task.attemptId, level, message: redactSecrets(message) })
  }
}

async function executeDownload(task: DownloadTaskData): Promise<TransferAttemptResult> {
  const log = makeLogger(task)
  const abort = new TransferAbortController()
  const { taskId, attemptId, method, sshConfig, remotePath, localPath, fileSize } = task

  let phase: TransferPhase = 'data'
  let transferredSize = 0
  let tempPath: string | undefined
  let client: Client | null = null
  let transport: ReturnType<typeof createTransportFailureSignal> | null = null
  let lastProgressAt = 0
  let speed = 0
  let lastSampleAt = Date.now()
  let lastSampleBytes = 0

  const sendProgress = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastProgressAt < 400) return
    lastProgressAt = now
    const elapsed = (now - lastSampleAt) / 1000
    const instant = elapsed > 0 ? (transferredSize - lastSampleBytes) / elapsed : 0
    speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant
    lastSampleAt = now
    lastSampleBytes = transferredSize
    sendMessage({ type: 'progress', taskId, attemptId, phase, transferredSize, fileSize, speed: Math.max(0, speed) })
  }

  const onCancelMessage = (message: unknown): void => {
    const candidate = message as CancelMessage | null
    if (!candidate || candidate.type !== 'cancel') return
    if (candidate.taskId !== taskId || candidate.attemptId !== attemptId) return
    log('warn', `收到取消请求（attemptId=${attemptId}）`)
    abort.abort('worker-cancel')
  }
  parentPort?.on('message', onCancelMessage)

  try {
    if (method !== 'sftp') throw new Error('Built-in file transfers only support SFTP')
    log('info', `Worker starting download (${method}): ${remotePath} -> ${localPath} (${fileSize} bytes)`)

    // 确保本地目标目录存在（只建目录，不触碰已有目标文件）
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true })

    // 主机密钥固定匹配：只认主进程 dispatch 前注入的可信指纹，缺失即 fail closed
    const hostKey = task.hostKey
    if (!hostKey || !hostKey.fingerprint) {
      throw new SshHostKeyError(
        'SSH_HOST_KEY_UNAVAILABLE',
        `缺少可信主机密钥指纹，已拒绝下载（${sshConfig.host}:${sshConfig.port}）`,
        { host: sshConfig.host, port: sshConfig.port }
      )
    }

    sendProgress(true)
    abort.throwIfAborted('data')

    try {
      client = await connectTransferSSH(sshConfig, log, hostKey)
    } catch (error) {
      if (abort.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      log('error', `SSH connection error: ${message}`)
      return buildSyntheticResult({
        taskId,
        attemptId,
        direction: 'download',
        outcome: 'failed',
        phase: 'data',
        expectedSize: fileSize,
        targetPath: localPath,
        code: isSshHostKeyError(error) ? 'TRANSFER_HOST_KEY_REJECTED' : 'TRANSFER_CONNECTION_FAILED',
        message: `SSH 连接失败：${message}`
      })
    }

    transport = createTransportFailureSignal([client])
    log('info', 'SSH connection ready')
    abort.throwIfAborted('data')

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client!.sftp((error, wrapper) => (error ? reject(new Error(`SFTP subsystem unavailable: ${error.message}`)) : resolve(wrapper)))
    })
    transport.dispose()
    transport = createTransportFailureSignal([client, sftp])

    const result = await commitDownload({
      sftp: sftp as unknown as TransferSftp,
      remotePath,
      localPath,
      env: {
        taskId,
        attemptId,
        expectedSize: fileSize,
        abort,
        transportFailure: transport.failure,
        onPhase: (next) => {
          phase = next
          sendMessage({ type: 'phase', taskId, attemptId, phase: next })
        },
        onProgress: (progress) => {
          transferredSize = progress.transferredSize
          sendProgress()
        },
        onTempPath: (created) => {
          tempPath = created
          sendMessage({ type: 'temp', taskId, attemptId, tempPath: created })
        },
        log
      }
    })
    transferredSize = result.transferredSize
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', `下载失败：${message}`)
    if (abort.aborted) {
      return buildSyntheticResult({
        taskId,
        attemptId,
        direction: 'download',
        outcome: 'cancelled',
        phase,
        expectedSize: fileSize,
        transferredSize,
        targetPath: localPath,
        tempPath,
        tempCleanup: 'removed',
        code: 'TRANSFER_CANCELLED',
        message: '下载已取消（临时文件已清理，旧目标未改动）'
      })
    }
    if (isSshHostKeyError(error)) {
      return buildSyntheticResult({
        taskId,
        attemptId,
        direction: 'download',
        outcome: 'failed',
        phase,
        expectedSize: fileSize,
        transferredSize,
        targetPath: localPath,
        tempPath,
        code: error.code === 'SSH_HOST_KEY_UNAVAILABLE' ? 'TRANSFER_HOST_KEY_UNAVAILABLE' : 'TRANSFER_HOST_KEY_REJECTED',
        message
      })
    }
    const code: TransferErrorCode = 'TRANSFER_IO_ERROR'
    return buildSyntheticResult({
      taskId,
      attemptId,
      direction: 'download',
      outcome: 'failed',
      phase,
      expectedSize: fileSize,
      transferredSize,
      targetPath: localPath,
      tempPath,
      code,
      message
    })
  } finally {
    parentPort?.off('message', onCancelMessage)
    transport?.dispose()
    try {
      client?.end()
    } catch {
      /* 连接可能已断开 */
    }
  }
}

// Worker 入口：成功 exit(0)、失败/取消 exit(1)。result 在退出前发送，
// 主进程只在 exit 事件后回收额度（进度/终态都不等于线程结束）。
if (workerData) {
  const task = workerData as DownloadTaskData
  const log = makeLogger(task)
  void (async () => {
    const result = await executeDownload(task)
    sendMessage({ type: 'result', taskId: task.taskId, attemptId: task.attemptId, result })
    setImmediate(() => process.exit(result.outcome === 'completed' ? 0 : 1))
  })().catch((error) => {
    log('error', `Download failed: ${error instanceof Error ? error.message : String(error)}`)
    setImmediate(() => process.exit(1))
  })
}
