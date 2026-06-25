import net from 'net'
import { EventEmitter } from 'events'
import log from 'electron-log'

/**
 * 可达性探测目标
 */
export interface ReachabilityTarget {
  /** 主键：与渲染端 (type|name|host) 对齐 */
  key: string
  host: string
  port: number
}

/**
 * 探测结果
 */
export interface ReachabilityResult {
  key: string
  reachable: boolean
  /** 服务器拒绝/超时时的简短原因，用于日志诊断；UI 不展示 */
  reason?: string
}

/**
 * TCP 可达性探测器
 *
 * 周期对一组目标发起 TCP 三次握手，握手成功立即关闭。
 * 仅判断"对端是否能在 timeout 内 accept"，不做 RTT 测量、不读写任何数据。
 *
 * - 协议无关：SSH / Telnet 都靠这一层；Serial / Local 不在目标集
 * - 并发上限避免一次性把网卡撑爆
 * - 防火墙路径上看到的就是一次 SYN → SYN-ACK → ACK → FIN，正常 SSH 客户端会做的事
 */
export class ReachabilityProber extends EventEmitter {
  private targets: Map<string, ReachabilityTarget> = new Map()
  private timer: NodeJS.Timeout | null = null
  private running: boolean = false
  private inflight: Set<string> = new Set()

  constructor(
    /** 探测周期，毫秒 */
    private intervalMs: number = 30_000,
    /** 单次探测超时，毫秒 */
    private timeoutMs: number = 3_000,
    /** 最大并发探测数 */
    private concurrency: number = 6
  ) {
    super()
  }

  /**
   * 覆盖整个目标集合（add / remove 通过整体替换语义实现）
   */
  setTargets(targets: ReachabilityTarget[]): void {
    const next = new Map<string, ReachabilityTarget>()
    for (const t of targets) {
      if (!t.host || !t.port) continue
      next.set(t.key, t)
    }
    this.targets = next
  }

  /**
   * 启动周期探测；首次立即跑一轮
   */
  start(): void {
    if (this.running) return
    this.running = true
    // 启动延迟 2s，避开应用启动高峰
    setTimeout(() => {
      if (this.running) this.probeAll().catch(err => log.warn('reachability initial probe failed:', err))
    }, 2_000)
    this.timer = setInterval(() => {
      this.probeAll().catch(err => log.warn('reachability probe failed:', err))
    }, this.intervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 手动触发一轮探测（不影响周期定时器）
   */
  async probeNow(): Promise<void> {
    await this.probeAll()
  }

  /**
   * 探测一组目标，按 concurrency 分批
   */
  private async probeAll(): Promise<void> {
    const all = Array.from(this.targets.values())
    if (all.length === 0) return

    // 简单的滑动窗口并发
    let idx = 0
    const workers: Promise<void>[] = []
    const next = async () => {
      while (idx < all.length) {
        const target = all[idx++]
        if (this.inflight.has(target.key)) continue
        this.inflight.add(target.key)
        try {
          const result = await this.probeOne(target)
          this.emit('result', result)
        } finally {
          this.inflight.delete(target.key)
        }
      }
    }
    for (let i = 0; i < Math.min(this.concurrency, all.length); i++) {
      workers.push(next())
    }
    await Promise.all(workers)
  }

  /**
   * 探测单个目标：TCP connect → 立即 destroy
   */
  private probeOne(target: ReachabilityTarget): Promise<ReachabilityResult> {
    return new Promise(resolve => {
      let settled = false
      const socket = new net.Socket()

      const cleanup = () => {
        socket.removeAllListeners()
        try { socket.destroy() } catch { /* ignore */ }
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ key: target.key, reachable: false, reason: 'timeout' })
      }, this.timeoutMs)

      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanup()
        resolve({ key: target.key, reachable: true })
      })

      socket.once('error', err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanup()
        resolve({ key: target.key, reachable: false, reason: err.message })
      })

      try {
        socket.connect(target.port, target.host)
      } catch (e) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanup()
        resolve({ key: target.key, reachable: false, reason: (e as Error).message })
      }
    })
  }
}

/**
 * 单例
 */
export const reachabilityProber = new ReachabilityProber()
