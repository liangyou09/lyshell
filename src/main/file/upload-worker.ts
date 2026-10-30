/**
 * 上传 Worker - 在独立线程中执行文件上传
 * 仅使用 SFTP；其他传输方式由插件提供
 *
 * 提交协议（OPT-11）：
 * - 数据只写入远端目标同目录的唯一随机临时文件，校验通过后才 rename 提交；
 * - 进度 100% 只是数据阶段结束，终态由 `result` 消息给出；
 * - 取消以消息通知（{type:'cancel'}），本线程负责关闭句柄并只清理自己的临时文件；
 *   提交请求发出后不再中断，等待回执（失败/未知由主进程按结果上报）。
 */
import { parentPort, workerData } from 'worker_threads'
import { Client } from 'ssh2'
import type { SFTPWrapper } from '../types/global'
import * as path from 'path'
import { sftpMkdirP } from './sftp-mkdir'
import { connectTransferSSH } from './ssh-transfer-connection'
import { redactSecrets } from './redact'
import { isSshHostKeyError, SshHostKeyError, type TransferHostKeyExpectation } from '../security/ssh-host-key'
import {
  buildSyntheticResult,
  commitUpload,
  createTransportFailureSignal,
  TransferAbortController,
  type TransferAttemptResult,
  type TransferErrorCode,
  type TransferPhase,
  type TransferSftp
} from './transfer-commit'

// Worker 接收的任务数据（attemptId 由主进程派发，Worker 不得自造）
interface UploadTaskData {
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
   * 主进程 dispatch 前从可信记录读出的固定指纹（Worker 不读盘、不碰 Electron）。
   */
  hostKey?: TransferHostKeyExpectation
  localPath: string
  remotePath: string
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
function makeLogger(task: UploadTaskData) {
  return (level: 'info' | 'warn' | 'error', message: string): void => {
    sendMessage({ type: 'log', taskId: task.taskId, attemptId: task.attemptId, level, message: redactSecrets(message) })
  }
}

async function executeUpload(task: UploadTaskData): Promise<TransferAttemptResult> {
  const log = makeLogger(task)
  const abort = new TransferAbortController()
  const { taskId, attemptId, method, sshConfig, localPath, remotePath, fileSize } = task

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

  // 取消通知：只置 abort 标志；真正的清理由 commitUpload 的 finally 完成
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
    log('info', `Worker starting upload (${method}): ${localPath} -> ${remotePath} (${fileSize} bytes)`)

    // 主机密钥固定指纹由主进程 dispatch 前注入；缺失即 fail closed（不建 TCP）
    const hostKey = task.hostKey
    if (!hostKey) {
      throw new SshHostKeyError(
        'SSH_HOST_KEY_UNAVAILABLE',
        `缺少可信主机密钥指纹，已拒绝上传（${sshConfig.host}:${sshConfig.port}）`,
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
        direction: 'upload',
        outcome: 'failed',
        phase: 'data',
        expectedSize: fileSize,
        targetPath: remotePath,
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

    // 确保远程父目录存在（只建目录，不触碰已有目标文件）
    await sftpMkdirP(sftp, path.posix.dirname(remotePath))

    const result = await commitUpload({
      sftp: sftp as unknown as TransferSftp,
      localPath,
      remotePath,
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
    log('error', `上传失败：${message}`)
    if (abort.aborted) {
      return buildSyntheticResult({
        taskId,
        attemptId,
        direction: 'upload',
        outcome: 'cancelled',
        phase,
        expectedSize: fileSize,
        transferredSize,
        targetPath: remotePath,
        tempPath,
        tempCleanup: 'removed',
        code: 'TRANSFER_CANCELLED',
        message: '上传已取消（临时文件已清理，旧目标未改动）'
      })
    }
    if (isSshHostKeyError(error)) {
      return buildSyntheticResult({
        taskId,
        attemptId,
        direction: 'upload',
        outcome: 'failed',
        phase,
        expectedSize: fileSize,
        transferredSize,
        targetPath: remotePath,
        tempPath,
        code: error.code === 'SSH_HOST_KEY_UNAVAILABLE' ? 'TRANSFER_HOST_KEY_UNAVAILABLE' : 'TRANSFER_HOST_KEY_REJECTED',
        message: message
      })
    }
    const code: TransferErrorCode = 'TRANSFER_IO_ERROR'
    return buildSyntheticResult({
      taskId,
      attemptId,
      direction: 'upload',
      outcome: 'failed',
      phase,
      expectedSize: fileSize,
      transferredSize,
      targetPath: remotePath,
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

// Worker 入口：与旧实现一致，成功 exit(0)、失败/取消 exit(1)。
// result 消息在退出前发送；主进程以 exit 事件确认 Worker 真正结束（额度只在此后释放）。
if (workerData) {
  const task = workerData as UploadTaskData
  const log = makeLogger(task)
  void (async () => {
    const result = await executeUpload(task)
    sendMessage({ type: 'result', taskId: task.taskId, attemptId: task.attemptId, result })
    setImmediate(() => process.exit(result.outcome === 'completed' ? 0 : 1))
  })().catch((error) => {
    log('error', `Upload failed: ${error instanceof Error ? error.message : String(error)}`)
    setImmediate(() => process.exit(1))
  })
}
