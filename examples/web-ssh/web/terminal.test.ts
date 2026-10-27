// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80
  rows = 24
  loadAddon(): void {}
  open(): void {}
  onData(): void {}
  reset(): void {}
  focus(): void {}
  write(): void {}
  writeln(): void {}
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

class Socket extends EventTarget {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  bufferedAmount = 0
  constructor() { super(); Socket.instances.push(this) }
  send(): void {}
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  document.body.innerHTML = ''
})

describe('Web SSH 网页连接生命周期', () => {
  it('首次 SSH 就绪前 WS 中断也恢复表单并撤掉过期指纹提示', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    Socket.instances = []
    vi.stubGlobal('WebSocket', Socket)
    vi.stubGlobal('ResizeObserver', class { observe(): void {} })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'a'.repeat(43) }) }))
    document.body.innerHTML = readFileSync(`${__dirname}/index.html`, 'utf8')
    await import('./terminal.ts')
    ;(document.getElementById('host') as HTMLInputElement).value = '127.0.0.1'
    ;(document.getElementById('username') as HTMLInputElement).value = 'demo'
    document.getElementById('connect-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.advanceTimersByTimeAsync(0)
    const socket = Socket.instances[0]
    expect(socket).toBeDefined()
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'host-key', fingerprint: `SHA256:${'A'.repeat(43)}`, host: '127.0.0.1', port: 22 }) }))
    expect(document.getElementById('trust')!.hidden).toBe(false)
    socket.close()
    expect((document.getElementById('connect') as HTMLButtonElement).disabled).toBe(false)
    expect(document.getElementById('trust')!.hidden).toBe(true)
    expect(document.getElementById('notice')!.textContent).toContain('连接已中断')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(Socket.instances).toHaveLength(1)
  })
})
