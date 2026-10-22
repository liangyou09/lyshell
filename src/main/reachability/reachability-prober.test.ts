import { EventEmitter } from 'events'
import { afterEach, expect, it, vi } from 'vitest'
const sockets = vi.hoisted(() => ({ all: [] as Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> }))
vi.mock('net', () => ({ default: { Socket: class extends EventEmitter {
  destroy = vi.fn()
  connect = vi.fn()
  constructor() { super(); sockets.all.push(this) }
} } }))
import { ReachabilityProber } from './reachability-prober'
afterEach(() => { sockets.all = []; vi.useRealTimers() })
const targets = Array.from({ length: 10 }, (_, i) => ({ key: String(i), host: 'fixture', port: 1 }))

it('三轮共享全局并发，stop 销毁 Socket 且不调度剩余目标、不回写结果', async () => {
  const prober = new ReachabilityProber(30000, 3000, 2)
  prober.setTargets(targets)
  const results = vi.fn(); prober.on('result', results)
  const rounds = [prober.probeNow(), prober.probeNow(), prober.probeNow()]
  expect(sockets.all).toHaveLength(2)
  prober.stop()
  await Promise.all(rounds)
  expect(sockets.all).toHaveLength(2)
  expect(sockets.all.every(socket => socket.destroy.mock.calls.length === 1)).toBe(true)
  expect(results).not.toHaveBeenCalled()
})

it('替换目标作废旧结果，旧轮结束前不会并行新建 Socket', async () => {
  const prober = new ReachabilityProber(30000, 3000, 2)
  prober.setTargets(targets)
  const old = prober.probeNow()
  prober.setTargets([{ key: 'new', host: 'fixture', port: 1 }])
  await prober.probeNow(); await old
  const next = prober.probeNow()
  expect(sockets.all).toHaveLength(3)
  sockets.all[2].emit('connect')
  await next
  prober.stop()
})

it('停止清理首次探测 timer，重新 start 不触发旧代首次轮次', async () => {
  vi.useFakeTimers()
  const prober = new ReachabilityProber(30000, 3000, 2)
  prober.setTargets(targets); prober.start(); prober.stop(); prober.start()
  await vi.advanceTimersByTimeAsync(2000)
  expect(sockets.all).toHaveLength(2)
  prober.stop()
  expect(vi.getTimerCount()).toBe(0)
})
