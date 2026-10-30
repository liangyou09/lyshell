import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transferScheduler } from './transfer-scheduler'
import { transferAttemptTimeouts } from './transfer-attempt'
import {
  __resetUploadManagerForTests,
  cancelUpload,
  cleanupAllUploadWorkers,
  getActiveUploadCount,
  setMainWindowForUpload,
  startUploadWorker,
} from './upload-worker-manager'
import {
  __resetDownloadManagerForTests,
  cancelDownload,
  cleanupAllWorkers,
  getActiveTaskCount,
  registerTaskMeta,
  setMainWindow,
  startDownloadWorker,
} from './download-worker-manager'

/**
 * OPT-11：尝试归属（attemptId）、阶段单调、终态只由 result 决定、
 * 取消确认 / 强制终止的有限等待、退出无 result 的兜底语义。
 * 全部使用假 Worker，没有真实线程、SSH 或文件系统。
 */

const state = vi.hoisted(() => ({
  workers: [] as any[],
  failNextConstruct: false,
}))

const historyMock = vi.hoisted(() => ({
  addRecord: vi.fn(() => Promise.resolve()),
  getDownloadDir: vi.fn(() => '/mock-downloads'),
}))

vi.mock('worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('events')

  class MockWorker extends Emitter {
    workerData: any
    terminated = false
    exited = false
    messages: any[] = []

    constructor(_script: string, options: any) {
      if (state.failNextConstruct) {
        state.failNextConstruct = false
        throw new Error('worker construction failed')
      }
      super()
      this.workerData = options?.workerData
      state.workers.push(this)
    }

    postMessage(message: any): void {
      this.messages.push(message)
    }

    terminate(): Promise<number> {
      this.terminated = true
      return Promise.resolve(0)
    }
  }

  return { Worker: MockWorker }
})

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../storage', () => ({ downloadHistory: historyMock }))

vi.mock('../security/ssh-trust', () => ({
  resolveTransferHostKey: (config: { host: string; port: number }) => ({
    endpoint: `${config.host}:${config.port}`,
    fingerprint: `SHA256:${'A'.repeat(43)}`,
  }),
}))

const sent: any[] = []

const flush = async (times = 10): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const exitWorker = (worker: any, code = 0): void => {
  worker.exited = true
  worker.emit('exit', code)
}

const resultMessage = (worker: any, overrides: Record<string, any> = {}): any => {
  const data = worker.workerData
  const size = typeof data.fileSize === 'number' ? data.fileSize : 0
  return {
    type: 'result',
    taskId: data.taskId,
    attemptId: data.attemptId,
    result: {
      taskId: data.taskId,
      attemptId: data.attemptId,
      direction: 'download',
      outcome: 'completed',
      phase: 'completed',
      expectedSize: size,
      transferredSize: size,
      bytesWritten: size,
      finalSize: size,
      targetPath: data.localPath,
      tempPattern: '.lyshell-test.tmp',
      tempCleanup: 'removed',
      fileFsync: 'synced',
      directoryFsync: 'unsupported',
      commitDispatched: true,
      committed: true,
      warnings: [],
      ...overrides,
    },
  }
}

const emitResult = (worker: any, overrides: Record<string, any> = {}): void => {
  worker.emit('message', resultMessage(worker, overrides))
}

const progressMessage = (worker: any, overrides: Record<string, any> = {}): any => {
  const data = worker.workerData
  return {
    type: 'progress',
    taskId: data.taskId,
    attemptId: data.attemptId,
    phase: 'data',
    transferredSize: 50,
    fileSize: data.fileSize,
    speed: 1,
    ...overrides,
  }
}

const phaseMessage = (worker: any, phase: string): any => ({
  type: 'phase',
  taskId: worker.workerData.taskId,
  attemptId: worker.workerData.attemptId,
  phase,
})

const downloadTask = (taskId: string, options: { localPath?: string } = {}) => ({
  taskId,
  sessionId: 's1',
  method: 'sftp' as const,
  sshConfig: { host: 'h1', port: 22, username: 'u', password: 'p' },
  remotePath: `/mock-remote/${taskId}`,
  localPath: options.localPath ?? `/mock-local/${taskId}`,
  fileSize: 100,
})

const registerDownloadMeta = (taskId: string): void => {
  registerTaskMeta(taskId, {
    taskId,
    sessionId: 's1',
    remotePath: `/mock-remote/${taskId}`,
    localPath: `/mock-local/${taskId}`,
    fileName: `${taskId}.bin`,
    fileSize: 100,
    startTime: new Date(0),
    sessionName: 'mock-session',
  })
}

const receipts = (predicate: (item: any) => boolean): any[] => sent.filter(predicate)

const startDownload = async (taskId: string): Promise<any> => {
  registerDownloadMeta(taskId)
  // 这些用例只关心回执与状态机；run* 的拒绝（Worker 未回报终态）由管理器测试覆盖
  void startDownloadWorker(downloadTask(taskId)).catch(() => undefined)
  await flush(10)
  const worker = state.workers.find(item => item.workerData.taskId === taskId)
  expect(worker).toBeTruthy()
  return worker
}

beforeEach(() => {
  vi.clearAllMocks()
  sent.length = 0
  state.workers.length = 0
  state.failNextConstruct = false
  __resetUploadManagerForTests()
  __resetDownloadManagerForTests()
  transferAttemptTimeouts.cancelGraceMs = 10_000
  transferAttemptTimeouts.terminateWaitMs = 2_000

  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, data: any) => {
        if (channel === 'file:progress') sent.push(data)
      },
    },
  }
  setMainWindow(window as any)
  setMainWindowForUpload(window as any)
})

afterEach(async () => {
  for (const worker of state.workers) {
    if (!worker.exited) exitWorker(worker, 1)
  }
  await flush(6)
  cleanupAllWorkers()
  cleanupAllUploadWorkers()
  await flush(6)
  transferAttemptTimeouts.cancelGraceMs = 10_000
  transferAttemptTimeouts.terminateWaitMs = 2_000
})

describe('transfer attempt identity', () => {
  it('丢弃 taskId / attemptId 不符的进度与终态消息', async () => {
    const worker = await startDownload('own')
    const attemptId = worker.workerData.attemptId
    expect(attemptId).toBeTruthy()

    // 伪造成其他任务
    worker.emit('message', progressMessage(worker, { taskId: 'other' }))
    worker.emit('message', progressMessage(worker, { attemptId: 'stale-attempt' }))
    expect(receipts(() => true)).toHaveLength(0)

    // 终态也必须带同一 attemptId，否则视为没有终态
    const foreign = resultMessage(worker)
    foreign.attemptId = 'stale-attempt'
    foreign.result.attemptId = 'stale-attempt'
    worker.emit('message', foreign)
    expect(receipts(() => true)).toHaveLength(0)
    expect(getActiveTaskCount()).toBe(1)

    // 归属正确的消息照常处理
    emitResult(worker)
    const completed = receipts(item => item.completed === true)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ taskId: 'own', attemptId, sessionId: 's1' })
  })

  it('每次派发都生成新的 attemptId，并固定写入 workerData', async () => {
    const first = await startDownload('a1')
    exitWorker(first)
    await flush(8)
    const second = await startDownload('a2')
    expect(first.workerData.attemptId).toBeTruthy()
    expect(second.workerData.attemptId).toBeTruthy()
    expect(first.workerData.attemptId).not.toBe(second.workerData.attemptId)
  })

  it('进度 100% 不产生完成回执，终态只由 result 决定', async () => {
    const worker = await startDownload('full')
    worker.emit('message', progressMessage(worker, { transferredSize: 100 }))

    const progressReceipts = receipts(item => item.taskId === 'full')
    expect(progressReceipts).toHaveLength(1)
    expect(progressReceipts[0]).toMatchObject({ progress: 100, phase: 'data' })
    expect(progressReceipts[0].completed).toBeUndefined()
    expect(progressReceipts[0].failed).toBeUndefined()
    expect(getActiveTaskCount()).toBe(1)

    emitResult(worker)
    const finished = receipts(item => item.taskId === 'full')
    expect(finished).toHaveLength(2)
    expect(finished[1]).toMatchObject({ completed: true, progress: 100 })
  })

  it('阶段只能前进，且进度消息不能宣布 completed 终态', async () => {
    const worker = await startDownload('phase')
    worker.emit('message', phaseMessage(worker, 'verifying'))
    worker.emit('message', progressMessage(worker, { phase: 'data', transferredSize: 10 }))
    worker.emit('message', phaseMessage(worker, 'completed'))

    const phaseReceipts = receipts(item => item.taskId === 'phase')
    expect(phaseReceipts.map(item => item.phase)).toEqual(['verifying', 'verifying'])
    expect(phaseReceipts.every(item => item.completed === undefined)).toBe(true)
    expect(getActiveTaskCount()).toBe(1)
  })
})

describe('worker exit without result', () => {
  it('数据阶段退出且没有终态：明确失败，临时文件清理状态未知', async () => {
    const worker = await startDownload('crash')
    const promise = new Promise<void>(resolve => {
      // 管理器在 exit 后 reject，使用 unhandledRejection 会失败，所以这里挂一个 catch
      resolve()
    })
    void promise
    exitWorker(worker, 1)
    await flush(10)

    const failed = receipts(item => item.taskId === 'crash' && item.failed === true)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      phase: 'data',
      code: 'TRANSFER_WORKER_EXIT_WITHOUT_RESULT',
      tempCleanup: 'unknown',
    })
    expect(failed[0].outcomeUnknown).toBeUndefined()
    expect(getActiveTaskCount()).toBe(0)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
  })

  it('提交阶段退出且没有终态：结果未知，不重试', async () => {
    const worker = await startDownload('ack-lost')
    worker.emit('message', phaseMessage(worker, 'committing'))
    exitWorker(worker, 1)
    await flush(10)

    const unknown = receipts(item => item.taskId === 'ack-lost' && item.outcomeUnknown === true)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]).toMatchObject({
      failed: true,
      phase: 'committing',
      code: 'TRANSFER_COMMIT_ACK_LOST',
      tempCleanup: 'unknown',
      targetPath: '/mock-local/ack-lost',
    })
    // 结果未知仍算一次失败历史记录，便于用户核查
    expect(historyMock.addRecord).toHaveBeenCalledTimes(1)
  })

  it('取消请求后 Worker 未确认即退出：结果未知，而不是 cancelled', async () => {
    const worker = await startDownload('cancel-exit')
    expect(cancelDownload('cancel-exit')).toBe(true)
    expect(worker.messages).toContainEqual({
      type: 'cancel',
      taskId: 'cancel-exit',
      attemptId: worker.workerData.attemptId,
    })
    exitWorker(worker, 1)
    await flush(10)

    expect(receipts(item => item.taskId === 'cancel-exit' && item.cancelled === true)).toHaveLength(0)
    const unknown = receipts(item => item.taskId === 'cancel-exit' && item.outcomeUnknown === true)
    expect(unknown).toHaveLength(1)
    expect(unknown[0].code).toBe('TRANSFER_CANCEL_UNCONFIRMED')
  })
})

describe('cooperative cancellation with bounded force termination', () => {
  it('宽限期内未确认：强制终止；仍未退出则上报未知并保持额度到真实 exit', async () => {
    transferAttemptTimeouts.cancelGraceMs = 15
    transferAttemptTimeouts.terminateWaitMs = 15
    const worker = await startDownload('stuck')

    expect(cancelDownload('stuck')).toBe(true)
    // 管理器不立即宣布 cancelled
    expect(receipts(item => item.cancelled === true)).toHaveLength(0)

    await sleep(40)
    expect(worker.terminated).toBe(true)

    await sleep(60)
    const unknown = receipts(item => item.taskId === 'stuck' && item.outcomeUnknown === true)
    expect(unknown).toHaveLength(1)
    expect(unknown[0].code).toBe('TRANSFER_CANCEL_UNCONFIRMED')
    expect(getActiveTaskCount()).toBe(1)
    expect(transferScheduler.stats()).toMatchObject({ active: 1, queued: 0 })
    exitWorker(worker, 1)
    await flush(10)
    expect(getActiveTaskCount()).toBe(0)
    expect(transferScheduler.stats().active).toBe(0)
  })

  it('强制终止后 Worker 才回报 cancelled：只上报一次 cancelled，且不回退成未知', async () => {
    transferAttemptTimeouts.cancelGraceMs = 15
    const worker = await startDownload('late-confirm')
    expect(cancelDownload('late-confirm')).toBe(true)
    await sleep(40)
    expect(worker.terminated).toBe(true)

    // Worker 在被终止后仍发来了确认取消（真实场景是同进程消息竞争）
    emitResult(worker, {
      outcome: 'cancelled',
      phase: 'verifying',
      commitDispatched: false,
      committed: false,
      error: { code: 'TRANSFER_CANCELLED', message: 'cancelled' },
    })
    exitWorker(worker, 1)
    await flush(10)

    const terminal = receipts(item => item.taskId === 'late-confirm')
    expect(terminal).toHaveLength(1)
    expect(terminal[0].cancelled).toBe(true)
    expect(terminal[0].outcomeUnknown).toBeUndefined()
  })
})

describe('terminal state is final', () => {
  it('完成后重复 result / 迟到进度不会回退终态，也不会重复回执', async () => {
    const worker = await startDownload('final')
    emitResult(worker)
    emitResult(worker, { outcome: 'failed', error: { code: 'TRANSFER_IO_ERROR', message: 'late' } })
    worker.emit('message', progressMessage(worker, { transferredSize: 5 }))
    exitWorker(worker, 0)
    await flush(10)

    const terminal = receipts(item => item.taskId === 'final' && (item.completed || item.failed))
    expect(terminal).toHaveLength(1)
    expect(terminal[0].completed).toBe(true)
    expect(historyMock.addRecord).toHaveBeenCalledTimes(1)
    expect(getActiveTaskCount()).toBe(0)
  })

  it('Worker error 事件先记录失败，迟到 result 不能把它翻成完成', async () => {
    const worker = await startDownload('boom')
    worker.emit('error', new Error('worker exploded'))
    emitResult(worker)
    const during = receipts(item => item.taskId === 'boom')
    expect(during).toHaveLength(1)
    expect(during[0].failed).toBe(true)

    exitWorker(worker, 1)
    await flush(10)
    const terminal = receipts(item => item.taskId === 'boom' && (item.completed || item.failed))
    expect(terminal).toHaveLength(1)
    expect(terminal[0].completed).toBeUndefined()
    expect(getActiveTaskCount()).toBe(0)
  })

  it('额度保留到 Worker 真正 exit，而不是终态消息到达时', async () => {
    const worker = await startDownload('lease')
    emitResult(worker)
    await flush(6)
    expect(receipts(item => item.taskId === 'lease' && item.completed === true)).toHaveLength(1)
    expect(transferScheduler.stats().active).toBe(1)

    exitWorker(worker, 0)
    await flush(8)
    expect(transferScheduler.stats().active).toBe(0)
  })
})

describe('upload attempt identity parity', () => {
  it('上传取消通知带固定 attemptId，取消确认后才上报 cancelled', async () => {
    startUploadWorker({
      taskId: 'up-cancel',
      sessionId: 's1',
      method: 'sftp',
      sshConfig: { host: 'h1', port: 22, username: 'u', password: 'p' },
      localPath: '/mock-local/up-cancel',
      remotePath: '/mock-remote/up-cancel',
      fileSize: 100,
    }).catch(() => undefined)
    await flush(10)
    const worker = state.workers.find(item => item.workerData.taskId === 'up-cancel')
    expect(worker).toBeTruthy()
    expect(getActiveUploadCount()).toBe(1)

    expect(cancelUpload('up-cancel')).toBe(true)
    expect(worker.messages).toContainEqual({
      type: 'cancel',
      taskId: 'up-cancel',
      attemptId: worker.workerData.attemptId,
    })
    expect(receipts(item => item.cancelled === true)).toHaveLength(0)

    emitResult(worker, {
      direction: 'upload',
      outcome: 'cancelled',
      phase: 'verifying',
      commitDispatched: false,
      committed: false,
      targetPath: '/mock-remote/up-cancel',
      error: { code: 'TRANSFER_CANCELLED', message: 'cancelled' },
    })
    exitWorker(worker, 1)
    await flush(10)

    const cancelled = receipts(item => item.taskId === 'up-cancel' && item.cancelled === true)
    expect(cancelled).toHaveLength(1)
    expect(getActiveUploadCount()).toBe(0)
  })
})
