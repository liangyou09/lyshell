import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import { captureShelfWebFrame, createShelfWebPreviewRuntime } from './task-shelf-web-frame'

const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const frame = (width = 1200, height = 800, url = 'data:image/png;base64,one') => {
  const resized = { toDataURL: vi.fn(() => url) }
  return {
    getSize: () => ({ width, height }), isEmpty: () => false,
    resize: vi.fn(() => resized), resized,
  }
}

function fakePage(width = 1200, height = 800, dpr = 1) {
  const rect = { width, height }
  const listeners = new Set<(event: Event) => void>()
  return {
    rect, capturePage: vi.fn(), isConnected: true,
    getBoundingClientRect: () => rect,
    ownerDocument: { defaultView: { devicePixelRatio: dpr } },
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    navigate: () => { for (const listener of listeners) listener({ isMainFrame: true } as unknown as Event) },
  }
}
const pageOf = (page: ReturnType<typeof fakePage>) => page as unknown as WebviewTag

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('任务架网页预览运行时', () => {
  it('缓存淘汰后400ms时间窗不再持有或返回被淘汰的编码图', async () => {
    vi.useFakeTimers()
    const runtime = createShelfWebPreviewRuntime({ budget: { encodedSoftBytes: 200, encodedAdmissionBytes: 500 } })
    const a = fakePage(), b = fakePage()
    a.capturePage.mockResolvedValue(frame(1200, 800, 'a'.repeat(100)))
    b.capturePage.mockResolvedValue(frame(1200, 800, 'b'.repeat(100)))
    const first = runtime.open(pageOf(a), 'shelf:web:evicted-a')!
    const second = runtime.open(pageOf(b), 'shelf:web:evicted-b')!
    await runtime.refresh(first)
    await runtime.refresh(second)
    expect(runtime.current(first.resourceId)).toBeNull()
    await expect(runtime.refresh(first)).resolves.toBeNull()
    expect(a.capturePage).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })
  it('尺寸变化后保留旧显示租约，稳定200ms才重新采集', async () => {
    vi.useFakeTimers()
    const runtime = createShelfWebPreviewRuntime(), page = fakePage()
    page.capturePage.mockResolvedValue(frame())
    const handle = runtime.open(pageOf(page), 'shelf:web:stable')!
    await runtime.refresh(handle)
    const old = runtime.acquireDisplay(handle.resourceId)!
    // 即使仍处400ms命中窗口，也不能把旧几何的图当作新位置首帧。
    await vi.advanceTimersByTimeAsync(50)
    page.rect.width = 1000
    await expect(runtime.refresh(handle)).resolves.toBeNull()
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    expect(runtime.diagnostics().cache.leases).toBe(1)
    await vi.advanceTimersByTimeAsync(199)
    await runtime.refresh(handle)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await runtime.refresh(handle)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    runtime.releaseDisplay(old); runtime.dispose()
  })
  it('持续失败按退避重试，导航换代可重新采集', async () => {
    vi.useFakeTimers()
    const runtime = createShelfWebPreviewRuntime(), page = fakePage()
    page.capturePage.mockRejectedValue(new Error('UnknownVizError'))
    const handle = runtime.open(pageOf(page), 'shelf:web:backoff')!
    await runtime.refresh(handle)
    await vi.advanceTimersByTimeAsync(500)
    await runtime.refresh(handle)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    await runtime.refresh(handle)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    page.navigate()
    await runtime.refresh(handle)
    expect(page.capturePage).toHaveBeenCalledTimes(3)
    runtime.dispose()
  })
  it('跨两个 page 共享调度，native 只跑一条，排队项在真实结束后启动', async () => {
    vi.useFakeTimers()
    const runtime = createShelfWebPreviewRuntime({ scheduler: { nativeConcurrency: 1 } })
    const first = fakePage(), second = fakePage()
    const a = deferred<ReturnType<typeof frame>>(), b = deferred<ReturnType<typeof frame>>()
    first.capturePage.mockReturnValue(a.promise)
    second.capturePage.mockReturnValue(b.promise)
    const ha = runtime.open(pageOf(first), 'shelf:web:a')!
    const hb = runtime.open(pageOf(second), 'shelf:web:b')!
    const ra = runtime.refresh(ha), rb = runtime.refresh(hb)
    expect(first.capturePage).toHaveBeenCalledTimes(1)
    expect(second.capturePage).not.toHaveBeenCalled()
    a.resolve(frame(1200, 800, 'data:image/png;base64,a'))
    await expect(ra).resolves.toMatchObject({ image: 'data:image/png;base64,a' })
    await Promise.resolve()
    expect(second.capturePage).toHaveBeenCalledTimes(1)
    b.resolve(frame(900, 600, 'data:image/png;base64,b'))
    await expect(rb).resolves.toMatchObject({ width: 900, height: 600 })
  })

  it('悬挂超过看门狗只熔断，不释放 inflight 也不叠加原生请求；真实结束后恢复', async () => {
    vi.useFakeTimers()
    const runtime = createShelfWebPreviewRuntime({ scheduler: { watchdogMs: 5000 } })
    const page = fakePage()
    const hanging = deferred<ReturnType<typeof frame>>()
    page.capturePage.mockReturnValue(hanging.promise)
    const handle = runtime.open(pageOf(page), 'shelf:web:hang')!
    const request = runtime.refresh(handle)
    await vi.advanceTimersByTimeAsync(10000)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    expect(runtime.diagnostics().scheduler).toMatchObject({ circuitOpen: true, watchdogTrips: 1, running: 1 })
    expect(runtime.refresh(handle)).toBe(request)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    hanging.resolve(frame())
    await expect(request).resolves.toMatchObject({ width: 900, height: 600 })
    expect(runtime.diagnostics().scheduler).toMatchObject({ circuitOpen: false, running: 0 })
  })

  it('无法核实或超出原始像素的视口不调用 capturePage', async () => {
    const runtime = createShelfWebPreviewRuntime()
    const missing = runtime.open({ capturePage: vi.fn() } as unknown as WebviewTag, 'shelf:web:missing')!
    await expect(runtime.refresh(missing)).resolves.toBeNull()
    const huge = fakePage(3000, 2000)
    const handle = runtime.open(pageOf(huge), 'shelf:web:huge')!
    await expect(runtime.refresh(handle)).resolves.toBeNull()
    expect(huge.capturePage).not.toHaveBeenCalled()
  })

  it('实际截图尺寸超预算时不 resize/toDataURL，并熔断该源', async () => {
    const runtime = createShelfWebPreviewRuntime()
    const page = fakePage(1000, 1000)
    const raw = frame(4000, 3000)
    page.capturePage.mockResolvedValue(raw)
    const handle = runtime.open(pageOf(page), 'shelf:web:raw')!
    await expect(runtime.refresh(handle)).resolves.toBeNull()
    expect(raw.resize).not.toHaveBeenCalled()
    expect(raw.resized.toDataURL).not.toHaveBeenCalled()
    await expect(runtime.refresh(handle)).resolves.toBeNull()
    expect(page.capturePage).toHaveBeenCalledTimes(1)
  })

  it('导航代际变化后丢弃在途结果且不提交预算', async () => {
    const runtime = createShelfWebPreviewRuntime()
    const page = fakePage()
    const pending = deferred<ReturnType<typeof frame>>()
    page.capturePage.mockReturnValue(pending.promise)
    const handle = runtime.open(pageOf(page), 'shelf:web:nav')!
    const request = runtime.refresh(handle)
    page.navigate()
    const raw = frame()
    pending.resolve(raw)
    await expect(request).resolves.toBeNull()
    expect(raw.resize).not.toHaveBeenCalled()
    expect(runtime.current('shelf:web:nav')).toBeNull()
    expect(runtime.diagnostics().cache.entries).toBe(0)
  })

  it('实际截图超出预留视口但未超过全局像素上限时仍停止编码', async () => {
    const runtime = createShelfWebPreviewRuntime(), page = fakePage(600, 400)
    const raw = frame(1200, 800)
    page.capturePage.mockResolvedValue(raw)
    const handle = runtime.open(pageOf(page), 'shelf:web:underestimated')!
    await expect(runtime.refresh(handle)).resolves.toBeNull()
    expect(raw.resize).not.toHaveBeenCalled()
    expect(runtime.diagnostics().cache.temporaryBytes).toBe(0)
    runtime.dispose()
  })

  it('采集期间尺寸变化会更新几何代际并拒绝旧尺寸结果', async () => {
    const runtime = createShelfWebPreviewRuntime()
    const page = fakePage()
    const pending = deferred<ReturnType<typeof frame>>()
    page.capturePage.mockReturnValue(pending.promise)
    const handle = runtime.open(pageOf(page), 'shelf:web:geom')!
    const request = runtime.refresh(handle)
    page.rect.width = 1000; page.rect.height = 700
    pending.resolve(frame())
    await expect(request).resolves.toBeNull()
    expect(runtime.current('shelf:web:geom')).toBeNull()
  })

  it('可视撤权/释放后不提交，且显示租约可获取与释放', async () => {
    const runtime = createShelfWebPreviewRuntime()
    const page = fakePage()
    const pending = deferred<ReturnType<typeof frame>>()
    page.capturePage.mockReturnValue(pending.promise)
    const handle = runtime.open(pageOf(page), 'shelf:web:visible')!
    const request = runtime.refresh(handle)
    handle.release()
    pending.resolve(frame())
    await expect(request).resolves.toBeNull()
    expect(runtime.diagnostics().cache.entries).toBe(0)

    const page2 = fakePage()
    page2.capturePage.mockResolvedValue(frame())
    const handle2 = runtime.open(pageOf(page2), 'shelf:web:lease')!
    await expect(runtime.refresh(handle2)).resolves.toMatchObject({ image: expect.any(String) })
    const lease = runtime.acquireDisplay('shelf:web:lease')
    expect(lease).not.toBeNull()
    expect(runtime.diagnostics().cache.leases).toBe(1)
    expect(runtime.releaseDisplay(lease!)).toBe(true)
    expect(runtime.diagnostics().cache.leases).toBe(0)
  })

  it('同 page 同帧共享 Promise 与 400ms 缓存，缓存过期后重新采集', async () => {
    vi.useFakeTimers()
    const runtime = createShelfWebPreviewRuntime()
    const page = fakePage()
    page.capturePage.mockResolvedValue(frame())
    const one = runtime.open(pageOf(page), 'shelf:web:shared')!
    const two = runtime.open(pageOf(page), 'shelf:web:shared')!
    const first = runtime.refresh(one)
    expect(runtime.refresh(two)).toBe(first)
    await first
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    await runtime.refresh(one)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(401)
    await runtime.refresh(one)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
  })

  it('兼容入口 captureShelfWebFrame 复用同一调度与 400ms 帧缓存', async () => {
    vi.useFakeTimers()
    const page = fakePage()
    page.capturePage.mockResolvedValue(frame())
    const first = captureShelfWebFrame(pageOf(page))
    expect(captureShelfWebFrame(pageOf(page))).toBe(first)
    await expect(first).resolves.toMatchObject({ width: 900, height: 600, image: expect.any(String) })
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(401)
    await expect(captureShelfWebFrame(pageOf(page))).resolves.toMatchObject({ width: 900, height: 600 })
    expect(page.capturePage).toHaveBeenCalledTimes(2)
  })

  it('兼容入口采集失败时返回空帧，不把错误抛给旧调用方', async () => {
    const page = fakePage()
    page.capturePage.mockRejectedValue(new Error('UnknownVizError'))
    await expect(captureShelfWebFrame(pageOf(page))).resolves.toEqual({ width: 0, height: 0 })
  })
})
