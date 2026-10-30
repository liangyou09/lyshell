/**
 * 宿主执行边界（协议 v2）的端到端测试。
 *
 * 两条路径都用**真实** named pipe / Unix socket 与真实帧编解码，只把 node-pty 换成
 * mock PTY，因此断言的是「宿主最终有没有把字节写进 PTY」，而不是主进程自己说成功：
 *   1. RawHostClient：直接说协议，验证 fence 安装/撤销、代际、过期、断线清空、v1 拒绝；
 *   2. LocalHostClient：验证 client 侧 fail closed 与「宿主确认后才放行」。
 */

import { mkdtempSync, rmSync } from 'fs'
import { createConnection } from 'net'
import type { Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HOST_TUNING,
  FrameDecoder,
  LOCAL_HOST_PROTOCOL_VERSION,
  LOCAL_HOST_REQUIRED_CAPABILITIES,
  encodeFrame,
  hostPipePath,
  newHostId,
  newHostToken,
  parseHostFrame,
  type HostBootstrapConfig,
  type HostFrame,
  type LocalHostSpawnOptions
} from './local-host-protocol'
import {
  startHostServer,
  type HostPty,
  type LocalHostServerHandle
} from './local-host-worker'
import {
  LocalHostClient,
  setLocalHostClientDeps,
  type LaunchedHostProcess,
  type LocalHostClientDeps,
  type LocalHostSecureStorage
} from './local-host-client'
import {
  INPUT_CONTROL_CAPABILITY as SHARED_CAPABILITY,
  type InputFence
} from '@shared/terminal-control'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    }
  }
}))

// 共享层与协议层必须声明同一个能力名，否则握手永远成功但语义对不上。
const INPUT_CONTROL_CAPABILITY = SHARED_CAPABILITY

it('协议要求的必需能力与共享契约一致', () => {
  expect(LOCAL_HOST_REQUIRED_CAPABILITIES).toContain(SHARED_CAPABILITY)
})

let nextPid = 9000

class MockPty implements HostPty {
  readonly pid = nextPid++
  readonly written: string[] = []
  readonly sizes: Array<[number, number]> = []
  killed = false
  private readonly dataListeners: Array<(data: string) => void> = []
  private readonly exitListeners: Array<(event: { exitCode: number }) => void> = []

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }

  kill(): void {
    this.killed = true
    for (const listener of [...this.exitListeners]) listener({ exitCode: 137 })
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }

  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListeners.push(listener)
  }

  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }
}

/** 直接说协议的测试客户端（不走 LocalHostClient，避免被测逻辑自证）。 */
class RawClient {
  readonly frames: HostFrame[] = []
  readonly parseErrors: string[] = []
  private readonly decoder = new FrameDecoder()

  private constructor(
    readonly socket: Socket,
    readonly config: HostBootstrapConfig
  ) {
    socket.on('data', (chunk: Buffer) => {
      for (const raw of this.decoder.push(chunk)) {
        try {
          this.frames.push(parseHostFrame(raw))
        } catch (error) {
          this.parseErrors.push(error instanceof Error ? error.message : String(error))
        }
      }
    })
    socket.on('error', () => undefined)
  }

  static connect(config: HostBootstrapConfig, pipe: string): Promise<RawClient> {
    const socket = createConnection(pipe)
    openSockets.push(socket)
    return new Promise<RawClient>((resolve, reject) => {
      socket.once('connect', () => resolve(new RawClient(socket, config)))
      socket.once('error', reject)
    })
  }

  send(payload: Record<string, unknown>): void {
    this.socket.write(encodeFrame({ v: LOCAL_HOST_PROTOCOL_VERSION, ...payload }))
  }

  hello(options: { capabilities?: string[]; v?: number } = {}): void {
    this.socket.write(
      encodeFrame({
        v: options.v ?? LOCAL_HOST_PROTOCOL_VERSION,
        type: 'hello',
        hostId: this.config.id,
        token: this.config.token,
        clientId: 'raw-client',
        mode: 'attach',
        cursor: 0,
        replay: true,
        capabilities: options.capabilities ?? [INPUT_CONTROL_CAPABILITY]
      })
    )
  }

  async waitFor(predicate: (frame: HostFrame) => boolean, timeoutMs = 2000): Promise<HostFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.frames.find(predicate)
      if (found) return found
      if (Date.now() > deadline) {
        throw new Error(
          `timed out; got [${this.frames.map((frame) => frame.type).join(', ')}] parseErrors=${
            this.parseErrors.join('; ') || 'none'
          }`
        )
      }
      await delay(5)
    }
  }

  async waitForType(type: HostFrame['type'], timeoutMs = 2000): Promise<HostFrame> {
    return this.waitFor((frame) => frame.type === type, timeoutMs)
  }

  async ack(reqId: string, timeoutMs = 2000): Promise<Extract<HostFrame, { type: 'ack' }>> {
    return (await this.waitFor(
      (frame) => frame.type === 'ack' && frame.reqId === reqId,
      timeoutMs
    )) as Extract<HostFrame, { type: 'ack' }>
  }

  close(): void {
    this.socket.destroy()
  }
}

const openHosts: LocalHostServerHandle[] = []
const openSockets: Socket[] = []
const cleanedDirs: string[] = []

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await delay(5)
  }
}

const shortBase = process.platform === 'win32' ? process.cwd() : '/tmp/lh-control'

async function openHost(): Promise<{ handle: LocalHostServerHandle; pty: MockPty; config: HostBootstrapConfig }> {
  const id = newHostId()
  const pty = new MockPty()
  const spawn: LocalHostSpawnOptions = {
    shell: 'cmd.exe',
    args: [],
    env: { PATH: 'C:\\Windows' },
    cols: 80,
    rows: 24
  }
  const config: HostBootstrapConfig = {
    id,
    token: newHostToken(),
    pipe: hostPipePath(shortBase, id),
    spawn,
    tuning: { ...DEFAULT_HOST_TUNING, graceMs: 2000, exitRetentionMs: 1000, heartbeatMs: 0, terminateTimeoutMs: 200 }
  }
  const handle = await startHostServer({ config, ptyFactory: () => pty })
  openHosts.push(handle)
  return { handle, pty, config }
}

function fenceOf(overrides: Partial<InputFence> = {}): InputFence {
  return {
    epoch: 1,
    connectionInstanceId: 'conn-1',
    controllerInstanceId: 'main-instance-1',
    leaseId: 'lease-1',
    expiresAt: Date.now() + 30_000,
    ...overrides
  }
}

afterEach(async () => {
  setLocalHostClientDeps(null)
  for (const socket of openSockets.splice(0)) {
    try {
      socket.destroy()
    } catch {
      // 已关闭
    }
  }
  for (const handle of openHosts.splice(0)) await handle.shutdown()
  for (const dir of cleanedDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── 宿主：没有围栏就没有输入 ──────────────────────────────────────────────────

describe('宿主输入围栏', () => {
  it('人工接管后迟到的旧 resize 不改变 PTY 尺寸，新控制者可以调整', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello()
    await client.waitForType('welcome')
    const old = fenceOf(), fresh = fenceOf({ epoch: 2, leaseId: 'fresh' })
    client.send({ type: 'input-fence', reqId: 'old', fence: old })
    await client.ack('old')
    client.send({ type: 'input-fence', reqId: 'fresh', fence: fresh })
    await client.ack('fresh')
    client.send({ type: 'resize', reqId: 'stale-size', cols: 140, rows: 50, fence: old })
    client.send({ type: 'resize', reqId: 'missing-size', cols: 150, rows: 50 })
    client.send({ type: 'resize', reqId: 'valid-size', cols: 120, rows: 40, fence: fresh })
    await waitUntil(() => pty.sizes.length > 0)
    expect(pty.sizes).toEqual([[120, 40]])
  })
  it('未安装围栏时 input 被拒，PTY 一个字节都收不到', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello()
    await client.waitForType('welcome')

    client.send({ type: 'input', reqId: 'in-1', data: 'rm -rf /', fence: fenceOf() })
    const ack = await client.ack('in-1')
    expect(ack).toMatchObject({ ok: false, code: 'input-denied' })
    expect(pty.written).toEqual([])
  })

  it('围栏 ack 之后输入才落地，且 ack 与 fence 中的租约一致', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello()
    await client.waitForType('welcome')

    const fence = fenceOf()
    client.send({ type: 'input-fence', reqId: 'fence-1', fence })
    expect(await client.ack('fence-1')).toMatchObject({ ok: true })

    client.send({ type: 'input', reqId: 'in-1', data: 'echo hi\r', fence })
    expect(await client.ack('in-1')).toMatchObject({ ok: true })
    expect(pty.written).toEqual(['echo hi\r'])
  })

  it('旧代际/旧租约的 input 被拒，PTY 保持干净', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello()
    await client.waitForType('welcome')

    const first = fenceOf()
    client.send({ type: 'input-fence', reqId: 'fence-1', fence: first })
    await client.ack('fence-1')

    // 人工接管：新租约推进 epoch
    const second = fenceOf({ epoch: 2, leaseId: 'lease-2' })
    client.send({ type: 'input-fence', reqId: 'fence-2', fence: second })
    expect(await client.ack('fence-2')).toMatchObject({ ok: true })

    client.send({ type: 'input', reqId: 'stale', data: 'OLD', fence: first })
    expect(await client.ack('stale')).toMatchObject({ ok: false, code: 'input-denied' })
    expect(pty.written).toEqual([])

    client.send({ type: 'input', reqId: 'fresh', data: 'NEW', fence: second })
    await client.ack('fresh')
    expect(pty.written).toEqual(['NEW'])
  })

  it('同 epoch 换了租约的安装被拒（epoch-stale），不能绕过接管', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello()
    await client.waitForType('welcome')

    const first = fenceOf()
    client.send({ type: 'input-fence', reqId: 'fence-1', fence: first })
    await client.ack('fence-1')

    const forged = fenceOf({ leaseId: 'other-lease' })
    client.send({ type: 'input-fence', reqId: 'fence-2', fence: forged })
    expect(await client.ack('fence-2')).toMatchObject({ ok: false, code: 'fence-rejected' })
    expect(pty.written).toEqual([])
  })

  it('已过期的 fence 安装与输入都被拒', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello()
    await client.waitForType('welcome')

    const expired = fenceOf({ expiresAt: Date.now() - 1 })
    client.send({ type: 'input-fence', reqId: 'fence-1', fence: expired })
    expect(await client.ack('fence-1')).toMatchObject({ ok: false, code: 'input-expired' })
    expect(pty.written).toEqual([])
  })

  it('撤销围栏后输入立即失效', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello()
    await client.waitForType('welcome')

    const fence = fenceOf()
    client.send({ type: 'input-fence', reqId: 'fence-1', fence })
    await client.ack('fence-1')
    client.send({ type: 'input-fence', reqId: 'revoke', fence: null })
    await client.ack('revoke')

    client.send({ type: 'input', reqId: 'in-1', data: 'x', fence })
    expect(await client.ack('in-1')).toMatchObject({ ok: false, code: 'input-denied' })
    expect(pty.written).toEqual([])
  })
})

// ── 断线：清空围栏，不续租、不重放 ────────────────────────────────────────────

describe('断线与重连', () => {
  it('断线清空围栏；重连后旧租约不能复活', async () => {
    const { handle, pty, config } = await openHost()
    const first = await RawClient.connect(config, handle.pipe)
    first.hello()
    await first.waitForType('welcome')
    const fence = fenceOf()
    first.send({ type: 'input-fence', reqId: 'fence-1', fence })
    await first.ack('fence-1')
    first.send({ type: 'input', reqId: 'in-1', data: 'A', fence })
    await first.ack('in-1')
    expect(pty.written).toEqual(['A'])

    first.close()
    await delay(80)

    const second = await RawClient.connect(config, handle.pipe)
    second.hello()
    await second.waitForType('welcome')

    // 旧 fence 不再生效：断线即清空
    second.send({ type: 'input', reqId: 'in-2', data: 'B', fence })
    expect(await second.ack('in-2')).toMatchObject({ ok: false, code: 'input-denied' })

    // 断线后同 epoch 想延长有效期 = 偷偷续租：先于原样重装发生，必须拒绝
    const extended = { ...fence, expiresAt: fence.expiresAt + 60_000 }
    second.send({ type: 'input-fence', reqId: 'fence-ext', fence: extended })
    expect(await second.ack('fence-ext')).toMatchObject({ ok: false, code: 'fence-rejected' })

    // 同一份未过期的租约也不能原样重装。
    second.send({ type: 'input-fence', reqId: 'fence-2', fence })
    expect(await second.ack('fence-2')).toMatchObject({ ok: false, code: 'fence-rejected' })
    second.send({ type: 'input', reqId: 'in-3', data: 'C', fence })
    expect(await second.ack('in-3')).toMatchObject({ ok: false, code: 'input-denied' })
    expect(pty.written).toEqual(['A'])
  })

  it('断线推进代际：新 main 取得更大 epoch 后被接受', async () => {
    const { handle, config } = await openHost()
    const first = await RawClient.connect(config, handle.pipe)
    first.hello()
    await first.waitForType('welcome')
    first.send({ type: 'input-fence', reqId: 'fence-1', fence: fenceOf({ epoch: 5 }) })
    await first.ack('fence-1')
    first.close()
    await delay(80)

    const second = await RawClient.connect(config, handle.pipe)
    second.hello()
    await second.waitForType('welcome')
    second.send({ type: 'input-fence', reqId: 'fence-2', fence: fenceOf({ epoch: 6, leaseId: 'lease-6' }) })
    expect(await second.ack('fence-2')).toMatchObject({ ok: true })
  })
})

// ── 版本协商 ─────────────────────────────────────────────────────────────────

describe('协议 v2 握手', () => {
  it('v1 客户端被明确拒绝，不静默降级', async () => {
    const { handle, pty, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello({ v: 1 })
    const error = await client.waitForType('error')
    expect(error).toMatchObject({ v: LOCAL_HOST_PROTOCOL_VERSION, code: 'incompatible-version', fatal: true })
    expect(pty.written).toEqual([])
  })

  it('缺少必需能力的 v2 客户端被拒绝', async () => {
    const { handle, config } = await openHost()
    const client = await RawClient.connect(config, handle.pipe)
    client.hello({ capabilities: ['something-else'] })
    const error = await client.waitForType('error')
    expect(error).toMatchObject({ code: 'incompatible-version' })
  })
})

// ── LocalHostClient：fail closed 与宿主确认 ───────────────────────────────────

const fakeStorage: LocalHostSecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(`enc:${plainText}`, 'utf8'),
  decryptString: (encrypted) => {
    const text = encrypted.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
    return text.slice(4)
  }
}

function spawnOptions(): LocalHostSpawnOptions {
  return { shell: 'cmd.exe', args: [], env: { PATH: 'C:\\Windows' }, cols: 80, rows: 24 }
}

function setupClient(): { dir: string; ptys: MockPty[]; bootstraps: unknown[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lh-control-'))
  cleanedDirs.push(dir)
  const ptys: MockPty[] = []
  const bootstraps: unknown[] = []
  writeFileSync(join(dir, 'localHostWorker.js'), '// fake worker')

  const launch = (): LaunchedHostProcess => {
    const messageListeners: Array<(message: unknown) => void> = []
    const exitListeners: Array<(code: number | null) => void> = []
    const errorListeners: Array<(error: Error) => void> = []
    return {
      pid: 4711,
      send: (message) => {
        bootstraps.push(message)
        void (async () => {
          const config = message as HostBootstrapConfig
          const pty = new MockPty()
          ptys.push(pty)
          const handle = await startHostServer({ config, ptyFactory: () => pty })
          openHosts.push(handle)
          for (const listener of [...messageListeners]) {
            listener({ kind: 'ready', v: LOCAL_HOST_PROTOCOL_VERSION, id: handle.id, pid: 4711, pipe: handle.pipe })
          }
        })()
      },
      onMessage: (listener) => {
        messageListeners.push(listener)
        return () => undefined
      },
      onExit: (listener) => {
        exitListeners.push(listener)
        return () => undefined
      },
      onError: (listener) => {
        errorListeners.push(listener)
        return () => undefined
      },
      disconnect: () => undefined,
      unref: () => undefined
    }
  }

  const deps: LocalHostClientDeps = {
    launchWorker: launch,
    secureStorage: fakeStorage,
    workerScriptPath: join(dir, 'localHostWorker.js'),
    tuning: { ...DEFAULT_HOST_TUNING, graceMs: 60, exitRetentionMs: 20, heartbeatMs: 0, terminateTimeoutMs: 300 },
    bootstrapTimeoutMs: 2000,
    heartbeatDeadMs: 0,
    rpcTimeoutMs: 2000
  }
  setLocalHostClientDeps(deps)
  return { dir, ptys, bootstraps }
}

describe('LocalHostClient 控制通道', () => {
  it('没有句柄的 write 一帧都不发（默认 fail closed）', async () => {
    const { dir, ptys } = setupClient()
    const client = await LocalHostClient.create(dir, spawnOptions())
    expect(client.write('echo hi\r')).toBe(false)
    await delay(30)
    expect(ptys[0].written).toEqual([])
    await client.detach()
  })

  it('setInputControl 得到宿主确认后，带句柄的 write 才落地', async () => {
    const { dir, ptys } = setupClient()
    const client = await LocalHostClient.create(dir, spawnOptions())
    const fence = fenceOf()
    await client.setInputControl(fence)

    expect(client.write('echo hi\r', fence)).toBe(true)
    await waitUntil(() => ptys[0].written.length > 0)
    expect(ptys[0].written).toEqual(['echo hi\r'])
    await client.detach()
  })

  it('未安装围栏就带句柄写入仍然不发', async () => {
    const { dir, ptys } = setupClient()
    const client = await LocalHostClient.create(dir, spawnOptions())
    expect(client.write('x', fenceOf())).toBe(false)
    await delay(20)
    expect(ptys[0].written).toEqual([])
    await client.detach()
  })

  it('接管后的旧句柄写入被本地拒绝，宿主也拒绝（双保险）', async () => {
    const { dir, ptys } = setupClient()
    const client = await LocalHostClient.create(dir, spawnOptions())
    const oldFence = fenceOf()
    await client.setInputControl(oldFence)
    const newFence = fenceOf({ epoch: 2, leaseId: 'lease-2' })
    await client.setInputControl(newFence)

    expect(client.write('OLD', oldFence)).toBe(false)
    await delay(20)
    expect(ptys[0].written).toEqual([])

    expect(client.write('NEW', newFence)).toBe(true)
    await waitUntil(() => ptys[0].written.length > 0)
    expect(ptys[0].written).toEqual(['NEW'])
    await client.detach()
  })

  it('撤销围栏后带旧句柄写入被拒', async () => {
    const { dir, ptys } = setupClient()
    const client = await LocalHostClient.create(dir, spawnOptions())
    const fence = fenceOf()
    await client.setInputControl(fence)
    await client.setInputControl(null)
    expect(client.write('x', fence)).toBe(false)
    await delay(20)
    expect(ptys[0].written).toEqual([])
    await client.detach()
  })

  it('宿主拒绝安装时 setInputControl 抛错，且不留下可用围栏', async () => {
    const { dir, ptys } = setupClient()
    const client = await LocalHostClient.create(dir, spawnOptions())
    await client.setInputControl(fenceOf({ expiresAt: Date.now() - 1 })).catch(() => undefined)
    await expect(client.setInputControl(fenceOf())).resolves.toBeUndefined()
    await client.setInputControl(null)
    const stale = fenceOf()
    expect(client.write('x', stale)).toBe(false)
    await delay(20)
    expect(ptys[0].written).toEqual([])
    await client.detach()
  })

  it('旧宿主（v1）在握手阶段被拒绝，不会静默降级', async () => {
    // 假 worker：不启动 v2 宿主，直接在管道上回一个 v1 的 welcome 帧
    const dir = mkdtempSync(join(tmpdir(), 'lh-legacy-'))
    cleanedDirs.push(dir)
    writeFileSync(join(dir, 'localHostWorker.js'), '// fake worker')
    const { createServer } = await import('net')
    const servers: Array<{ close: () => void }> = []
    const launch = (): LaunchedHostProcess => ({
      pid: 4712,
      send: (message) => {
        const config = message as HostBootstrapConfig
        const server = createServer((socket) => {
          socket.on('data', () => {
            socket.write(
              encodeFrame({
                v: 1,
                type: 'welcome',
                hostId: config.id,
                status: { id: config.id, running: true, retained: false },
                cursor: 0,
                capabilities: []
              })
            )
          })
        })
        server.listen(config.pipe)
        servers.push(server)
        // 不发送 ready：让 client 走「启动结果不明 → probe 管道」的路径
      },
      onMessage: () => () => undefined,
      onExit: () => () => undefined,
      onError: () => () => undefined,
      disconnect: () => undefined,
      unref: () => undefined
    })
    setLocalHostClientDeps({
      launchWorker: launch,
      secureStorage: fakeStorage,
      workerScriptPath: join(dir, 'localHostWorker.js'),
      bootstrapTimeoutMs: 200,
      heartbeatDeadMs: 0,
      rpcTimeoutMs: 500
    })
    try {
      await expect(LocalHostClient.create(dir, spawnOptions())).rejects.toThrow()
    } finally {
      for (const server of servers) server.close()
    }
  })
})

// 保底：解码器本身不认识 v1 的 welcome（客户端不会误读旧帧）
it('parseHostFrame 拒绝 v1 帧', () => {
  expect(() =>
    parseHostFrame({
      v: 1,
      type: 'welcome',
      hostId: 'x',
      status: { id: 'x', running: true, retained: false },
      cursor: 0,
      capabilities: []
    })
  ).toThrow()
})
