import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transferScheduler } from './transfer-scheduler'
import {
  cancelUpload,
  cancelUploadsBySession,
  cleanupAllUploadWorkers,
  getActiveUploadCount,
  runUploadWorkerAndWait,
  setMainWindowForUpload,
  startUploadWorker,
} from './upload-worker-manager'
import {
  cancelDownload,
  cancelDownloadsBySession,
  cleanupAllWorkers,
  getActiveTaskCount,
  registerTaskMeta,
  runDownloadWorkerAndWait,
  setMainWindow,
  startDownloadWorker,
} from './download-worker-manager'

/**
 * R03 资源测试：上传/下载共享 Worker 并发上限（全局 4、每 endpoint 2）、
 * 额度占用到 Worker exit、排队/会话/全清理取消、下载元信息清理与 UI cancelled 回执。
 * Worker 与 SSH 全部 mock，没有真实服务器、真实下载目录或真实线程。
 */

const state = vi.hoisted(() => ({
  workers: [] as any[],
  failNextConstruct: false,
  onConstruct: null as null | ((worker: any) => void),
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

    constructor(_script: string, options: any) {
      // 必须能在 super() 之前抛错，模拟同步构造失败
      if (state.failNextConstruct) {
        state.failNextConstruct = false
        throw new Error('worker construction failed')
      }
      super()
      this.workerData = options?.workerData
      state.workers.push(this)
      state.onConstruct?.(this)
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

vi.mock('../storage', () => ({
  downloadHistory: historyMock,
}))

const sent: any[] = []

const flush = async (times = 10): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const exitWorker = (worker: any, code = 0): void => {
  worker.exited = true
  worker.emit('exit', code)
}

const completeWorker = (worker: any): void => {
  const data = worker.workerData
  worker.emit('message', {
    type: 'complete',
    taskId: data.taskId,
    sessionId: data.sessionId,
    transferredSize: data.fileSize,
    fileSize: data.fileSize,
    progress: 100,
    speed: 0,
  })
}

const aliveWorkers = (): any[] => state.workers.filter(worker => !worker.exited)

const uploadTask = (
  taskId: string,
  options: { host?: string; port?: number; sessionId?: string; remotePath?: string } = {},
) => ({
  taskId,
  sessionId: options.sessionId ?? 's1',
  method: 'sftp' as const,
  sshConfig: {
    host: options.host ?? 'h1',
    port: options.port ?? 22,
    username: 'u',
    password: 'p',
  },
  localPath: `/mock-local/${taskId}`,
  remotePath: options.remotePath ?? `/mock-remote/${taskId}`,
  fileSize: 100,
})

const downloadTask = (
  taskId: string,
  options: { host?: string; port?: number; sessionId?: string; localPath?: string } = {},
) => ({
  taskId,
  sessionId: options.sessionId ?? 's1',
  method: 'sftp' as const,
  sshConfig: {
    host: options.host ?? 'h1',
    port: options.port ?? 22,
    username: 'u',
    password: 'p',
  },
  remotePath: `/mock-remote/${taskId}`,
  localPath: options.localPath ?? `/mock-local/${taskId}`,
  fileSize: 100,
})

const registerDownloadMeta = (taskId: string, sessionId = 's1'): void => {
  registerTaskMeta(taskId, {
    taskId,
    sessionId,
    remotePath: `/mock-remote/${taskId}`,
    localPath: `/mock-local/${taskId}`,
    fileName: `${taskId}.bin`,
    fileSize: 100,
    startTime: new Date(0),
    sessionName: 'mock-session',
  })
}

const receipts = (predicate: (item: any) => boolean): any[] => sent.filter(predicate)

/** 全部推进到 Worker exit：每轮把所有存活 Worker complete 后 exit，直到队列清空 */
const drainAll = async (maxRounds = 80): Promise<void> => {
  for (let round = 0; round < maxRounds; round++) {
    const alive = aliveWorkers()
    if (alive.length === 0) {
      await flush(4)
      if (aliveWorkers().length === 0) return
      continue
    }
    for (const worker of alive) {
      completeWorker(worker)
      exitWorker(worker)
    }
    await flush(12)
  }
  throw new Error('drainAll did not settle')
}

describe('transfer worker manager resource limits', () => {
  it('首个微任务之前会话断开，已发放的额度也不会创建迟到 Worker', async () => {
    const upload = runUploadWorkerAndWait(uploadTask('immediate-up')).catch(error => error)
    registerDownloadMeta('immediate-down')
    const download = runDownloadWorkerAndWait(downloadTask('immediate-down')).catch(error => error)
    expect(cancelUploadsBySession('s1')).toBe(1)
    expect(cancelDownloadsBySession('s1')).toBe(1)
    expect(await upload).toBeInstanceOf(Error)
    expect(await download).toBeInstanceOf(Error)
    await flush()
    expect(state.workers).toHaveLength(0)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
    expect(receipts(item => item.cancelled)).toHaveLength(2)
  })

  it('首个微任务前单任务取消或全清理不会启动迟到 Worker', async () => {
    const one = runUploadWorkerAndWait(uploadTask('immediate-one')).catch(error => error)
    expect(cancelUpload('immediate-one')).toBe(true)
    const two = runDownloadWorkerAndWait(downloadTask('immediate-two')).catch(error => error)
    cleanupAllWorkers()
    expect(await one).toBeInstanceOf(Error)
    expect(await two).toBeInstanceOf(Error)
    expect(state.workers).toHaveLength(0)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    sent.length = 0
    state.workers.length = 0
    state.failNextConstruct = false
    state.onConstruct = null

    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, data: any) => {
          if (channel === 'file:progress') sent.push(data)
        },
      },
    }
    setMainWindowForUpload(window as any)
    setMainWindow(window as any)
  })

  afterEach(async () => {
    cleanupAllUploadWorkers()
    cleanupAllWorkers()
    for (const worker of aliveWorkers()) {
      exitWorker(worker, 1)
    }
    await flush(12)
    state.workers.length = 0
    state.onConstruct = null
    sent.length = 0
  })

  it('40 个不同路径上传/下载混合：全局峰值 4、每 endpoint 峰值 2，且全部最终启动', async () => {
    let peakGlobal = 0
    const peakByEndpoint = new Map<string, number>()
    state.onConstruct = (worker: any) => {
      const alive = aliveWorkers()
      const endpoint = `${worker.workerData.sshConfig.host}:${worker.workerData.sshConfig.port}`
      const endpointAlive = alive.filter(
        item => `${item.workerData.sshConfig.host}:${item.workerData.sshConfig.port}` === endpoint,
      )
      peakGlobal = Math.max(peakGlobal, alive.length)
      peakByEndpoint.set(endpoint, Math.max(peakByEndpoint.get(endpoint) ?? 0, endpointAlive.length))
    }

    for (let index = 0; index < 40; index++) {
      const host = index % 2 === 0 ? 'h1' : 'h2'
      const taskId = `task-${index}`
      if (index % 2 === 0) {
        startUploadWorker(uploadTask(taskId, { host }))
      } else {
        registerDownloadMeta(taskId)
        startDownloadWorker(downloadTask(taskId, { host }))
      }
    }
    await flush(16)

    // 第一个 complete 之前只可能有 4 个 Worker
    expect(state.workers).toHaveLength(4)
    expect(transferScheduler.stats().active).toBe(4)
    expect(transferScheduler.stats().queued).toBe(36)

    await drainAll()

    expect(state.workers).toHaveLength(40)
    expect(new Set(state.workers.map(worker => worker.workerData.taskId)).size).toBe(40)
    expect(peakGlobal).toBe(4)
    for (const peak of peakByEndpoint.values()) {
      expect(peak).toBeLessThanOrEqual(2)
    }
    expect(historyMock.addRecord).toHaveBeenCalledTimes(20)
    expect(getActiveUploadCount()).toBe(0)
    expect(getActiveTaskCount()).toBe(0)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
  })

  it('complete 后未 exit 不释放额度，也不会新建超限 Worker', async () => {
    for (let index = 0; index < 5; index++) {
      // 不同 endpoint，确保挡在全局 4 而不是每 endpoint 2
      startUploadWorker(uploadTask(`u${index}`, { host: `host-${index}` }))
    }
    await flush(12)

    expect(state.workers).toHaveLength(4)
    expect(transferScheduler.stats()).toMatchObject({ active: 4, queued: 1 })

    for (const worker of aliveWorkers()) {
      completeWorker(worker)
    }
    await flush(8)

    // 协议完成不等于线程退出：额度仍被占用
    expect(state.workers).toHaveLength(4)
    expect(getActiveUploadCount()).toBe(4)
    expect(transferScheduler.stats()).toMatchObject({ active: 4, queued: 1 })
    expect(receipts(item => item.completed === true)).toHaveLength(4)

    exitWorker(aliveWorkers()[0])
    await flush(12)

    // 第 5 个直到有线程真正 exit 才允许创建
    expect(state.workers).toHaveLength(5)
    expect(transferScheduler.stats()).toMatchObject({ active: 4, queued: 0 })
    await drainAll()
  })

  it('排队容量满时明确拒绝，UI 收到失败回执且不再创建 Worker', async () => {
    for (let index = 0; index < 70; index++) {
      startUploadWorker(uploadTask(`full-${index}`, { host: `host-${index}` }))
    }
    await flush(16)

    expect(state.workers).toHaveLength(4)
    expect(transferScheduler.stats()).toMatchObject({ active: 4, queued: 60 })
    const rejected = receipts(item => item.failed === true && item.error === '上传队列已满，请稍后重试')
    expect(rejected).toHaveLength(6)
    expect(rejected.map(item => item.taskId).sort()).toEqual(
      ['full-64', 'full-65', 'full-66', 'full-67', 'full-68', 'full-69'],
    )

    // 清理后额度归零；被容量拒绝的任务从未创建 Worker
    cleanupAllUploadWorkers()
    for (const worker of aliveWorkers()) exitWorker(worker, 1)
    await flush(12)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
    expect(state.workers).toHaveLength(4)
  })

  it('排队中的上传被取消后从不创建 Worker', async () => {
    for (let index = 0; index < 5; index++) {
      startUploadWorker(uploadTask(`q${index}`, { host: `host-${index}` }))
    }
    await flush(12)
    expect(state.workers).toHaveLength(4)

    expect(cancelUpload('q4')).toBe(true)
    await flush(6)
    expect(cancelUpload('q4')).toBe(false)
    expect(state.workers).toHaveLength(4)

    for (const worker of aliveWorkers()) exitWorker(worker, 0)
    await flush(12)
    expect(state.workers).toHaveLength(4)
    expect(state.workers.some(worker => worker.workerData.taskId === 'q4')).toBe(false)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
  })

  it('会话取消覆盖路径串行队列、全局队列与活动 Worker，并补发 cancelled 回执', async () => {
    for (let index = 0; index < 6; index++) {
      registerDownloadMeta(`d${index}`)
    }
    // d1/d2 同本地路径（d2 进入路径串行队列）；d5/d6 进入全局队列
    startDownloadWorker(downloadTask('d0', { host: 'a0', localPath: '/same/path' }))
    startDownloadWorker(downloadTask('d1', { host: 'a1', localPath: '/same/path' }))
    startDownloadWorker(downloadTask('d2', { host: 'a2', localPath: '/other/d2' }))
    startDownloadWorker(downloadTask('d3', { host: 'a3', localPath: '/other/d3' }))
    startDownloadWorker(downloadTask('d4', { host: 'a4', localPath: '/other/d4' }))
    startDownloadWorker(downloadTask('d5', { host: 'a5', localPath: '/other/d5' }))
    await flush(16)

    // d0/d2/d3 真正创建；d1 在路径队列；d4/d5 在全局队列
    expect(state.workers).toHaveLength(3)
    expect(transferScheduler.stats()).toMatchObject({ active: 4, queued: 2 })

    expect(cancelDownloadsBySession('s1')).toBe(6)
    const cancelled = receipts(item => item.cancelled === true)
    expect(cancelled.map(item => item.taskId).sort()).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5'])

    await flush(8)
    expect(state.workers).toHaveLength(3)
    expect(state.workers.some(worker => worker.workerData.taskId === 'd1')).toBe(false)

    for (const worker of aliveWorkers()) exitWorker(worker, 1)
    await flush(12)
    expect(getActiveTaskCount()).toBe(0)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
    expect(state.workers).toHaveLength(3)
    expect(historyMock.addRecord).not.toHaveBeenCalled()
  })

  it('全清理同时撤销路径串行队列与全局队列，不残留额度和迟到回执', async () => {
    startUploadWorker(uploadTask('u0', { host: 'shared-host', remotePath: '/same/remote' }))
    startUploadWorker(uploadTask('u1', { host: 'shared-host', remotePath: '/same/remote' }))
    startUploadWorker(uploadTask('u2', { host: 'c2' }))
    startUploadWorker(uploadTask('u3', { host: 'c3' }))
    startUploadWorker(uploadTask('u4', { host: 'c4' }))
    await flush(16)

    expect(state.workers).toHaveLength(3)
    expect(transferScheduler.stats()).toMatchObject({ active: 4, queued: 1 })

    cleanupAllUploadWorkers()
    expect(getActiveUploadCount()).toBe(0)
    await flush(8)
    expect(state.workers).toHaveLength(3)

    for (const worker of aliveWorkers()) exitWorker(worker, 1)
    await flush(12)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
    expect(state.workers.some(worker => worker.workerData.taskId === 'u4')).toBe(false)
    expect(receipts(item => item.completed === true)).toHaveLength(0)
  })

  it('取消后迟到的 complete 不写下载历史，单任务取消不重复回执', async () => {
    registerDownloadMeta('late')
    startDownloadWorker(downloadTask('late'))
    await flush(10)
    expect(state.workers).toHaveLength(1)

    // 单任务取消：manager 负责终止/清理，cancelled 回执由 IPC 层统一发送，避免重复
    expect(cancelDownload('late')).toBe(true)
    expect(receipts(item => item.taskId === 'late')).toHaveLength(0)

    // 取消已生效，迟到的 complete 不能再点亮完成状态或写历史
    completeWorker(state.workers[0])
    await flush(8)
    expect(receipts(item => item.taskId === 'late' && item.completed === true)).toHaveLength(0)
    expect(historyMock.addRecord).not.toHaveBeenCalled()

    exitWorker(state.workers[0], 1)
    await flush(8)
    expect(getActiveTaskCount()).toBe(0)
    expect(historyMock.addRecord).not.toHaveBeenCalled()
  })

  it('error 后额度仍被占用，迟到 complete 不覆盖终态，exit 后才 settle', async () => {
    const pending = runUploadWorkerAndWait(uploadTask('err'))
    await flush(10)
    expect(state.workers).toHaveLength(1)

    state.workers[0].emit('error', new Error('boom'))
    await flush(6)
    expect(receipts(item => item.taskId === 'err' && item.failed === true)).toHaveLength(1)
    // 线程还活着，额度不能提前释放
    expect(transferScheduler.stats().active).toBe(1)

    completeWorker(state.workers[0])
    await flush(6)
    expect(receipts(item => item.taskId === 'err' && item.completed === true)).toHaveLength(0)

    exitWorker(state.workers[0], 1)
    await expect(pending).rejects.toThrow('boom')
    await flush(4)
    expect(transferScheduler.stats().active).toBe(0)
    expect(receipts(item => item.taskId === 'err')).toHaveLength(1)
  })

  it('同步 Worker 构造失败会释放额度、给出失败回执并清理下载元信息', async () => {
    state.failNextConstruct = true
    const uploadFailure = runUploadWorkerAndWait(uploadTask('ctor-up'))
    await expect(uploadFailure).rejects.toThrow('worker construction failed')
    await flush(6)
    expect(state.workers).toHaveLength(0)
    expect(getActiveUploadCount()).toBe(0)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
    expect(receipts(item => item.taskId === 'ctor-up' && item.failed === true)).toHaveLength(1)

    // 失败不占额度，后续任务可以正常启动
    startUploadWorker(uploadTask('ctor-next', { host: 'next-host' }))
    await flush(8)
    expect(state.workers).toHaveLength(1)

    registerDownloadMeta('ctor-down')
    state.failNextConstruct = true
    await expect(runDownloadWorkerAndWait(downloadTask('ctor-down'))).rejects.toThrow('worker construction failed')
    await flush(6)
    expect(historyMock.addRecord).not.toHaveBeenCalled()
    expect(transferScheduler.stats().active).toBe(1) // 只占用 ctor-next

    await drainAll()
  })

  it('上传会话取消覆盖路径串行队列与全局队列并补发 cancelled 回执', async () => {
    // cu1 与 cu0 同 endpoint 同远程路径：先占额度、再进入路径串行队列；cu4/cu5 进入全局队列
    startUploadWorker(uploadTask('cu0', { host: 'same-host', remotePath: '/same/remote' }))
    startUploadWorker(uploadTask('cu1', { host: 'same-host', remotePath: '/same/remote' }))
    startUploadWorker(uploadTask('cu2', { host: 'h2' }))
    startUploadWorker(uploadTask('cu3', { host: 'h3' }))
    startUploadWorker(uploadTask('cu4', { host: 'h4' }))
    startUploadWorker(uploadTask('cu5', { host: 'h5' }))
    await flush(16)

    // 额度含路径队列中尚未建 Worker 的 cu1：活动 lease 4（cu0/cu1/cu2/cu3），实际 Worker 3 个
    expect(state.workers).toHaveLength(3)
    expect(transferScheduler.stats()).toMatchObject({ active: 4, queued: 2 })

    expect(cancelUploadsBySession('s1')).toBe(6)
    const cancelled = receipts(item => item.cancelled === true)
    expect(cancelled.map(item => item.taskId).sort()).toEqual(
      ['cu0', 'cu1', 'cu2', 'cu3', 'cu4', 'cu5'],
    )

    // 排队任务（路径队列 cu1、全局队列 cu4/cu5）在取消后从不创建 Worker
    await flush(8)
    expect(state.workers).toHaveLength(3)
    expect(
      state.workers.some(worker => ['cu1', 'cu4', 'cu5'].includes(worker.workerData.taskId)),
    ).toBe(false)

    for (const worker of aliveWorkers()) exitWorker(worker, 1)
    await flush(12)
    expect(getActiveUploadCount()).toBe(0)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
    expect(receipts(item => item.completed === true)).toHaveLength(0)
  })

  it('下载路径串行：同本地路径后到任务在前序 exit 后才创建 Worker', async () => {
    registerDownloadMeta('pair-1')
    registerDownloadMeta('pair-2')
    startDownloadWorker(downloadTask('pair-1', { localPath: '/same/local/file' }))
    startDownloadWorker(downloadTask('pair-2', { localPath: '/same/local/file' }))
    await flush(12)

    expect(state.workers).toHaveLength(1)
    expect(state.workers[0].workerData.taskId).toBe('pair-1')

    completeWorker(state.workers[0])
    exitWorker(state.workers[0], 0)
    await flush(12)

    expect(state.workers).toHaveLength(2)
    expect(state.workers[1].workerData.taskId).toBe('pair-2')
    expect(historyMock.addRecord).toHaveBeenCalledTimes(1)

    await drainAll()
    expect(historyMock.addRecord).toHaveBeenCalledTimes(2)
    expect(transferScheduler.stats()).toMatchObject({ active: 0, queued: 0 })
  })
})
