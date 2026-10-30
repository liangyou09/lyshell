/**
 * 宿主服务端协议回环测试。
 *
 * 这里跑的是**真实的** named pipe / Unix socket 服务端（startHostServer）+ 真实帧编解码，
 * 只把 node-pty 换成 mock PTY —— 因为 Electron ABI 的 node-pty 在 vitest 里不可加载，
 * 且本测试要验证的是协议与生命周期，不是终端仿真。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createConnection } from 'net'
import type { Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_TUNING,
  FrameDecoder,
  HOST_DESCRIPTOR_VERSION,
  LOCAL_HOST_PROTOCOL_VERSION,
  LOCAL_HOST_REQUIRED_CAPABILITIES,
  encodeFrame,
  hostPipePath,
  hostDescriptorPath,
  newHostId,
  newHostToken,
  parseHostFrame,
  readHostDescriptor,
  writeHostDescriptor,
  type HostBootstrapConfig,
  type HostFrame,
  type HostTuning,
  type LocalHostSpawnOptions,
  type LocalHostStatus
} from './local-host-protocol'
import type { InputFence } from '@shared/terminal-control'
import {
  WORKER_EXIT_BOOTSTRAP_TIMEOUT,
  runBootstrapWorker,
  startHostServer,
  type HostPty,
  type HostPtyFactory,
  type LocalHostServerHandle,
  type WorkerBootstrapChannel
} from './local-host-worker'

// ── 测试替身 ──────────────────────────────────────────────────────────────────

let nextPid = 5000
let nextFenceReqId = 1
let nextInputReqId = 1
let fenceEpoch = 0

/** 每个测试客户端一份新租约：epoch 递增，避免跨客户端安装被判成旧代际。 */
function testFence(overrides: Partial<InputFence> = {}): InputFence {
  fenceEpoch += 1
  return {
    epoch: fenceEpoch,
    connectionInstanceId: 'conn-worker-test',
    controllerInstanceId: 'main-worker-test',
    leaseId: `lease-worker-${fenceEpoch}`,
    expiresAt: Date.now() + 60_000,
    ...overrides
  }
}

class MockPty implements HostPty {
  readonly pid = nextPid++
  readonly written: string[] = []
  readonly sizes: Array<[number, number]> = []
  killed = false
  /** kill() 时是否产生真实退出证据；null 表示「杀不掉」，用来测 terminate 超时。 */
  exitCodeOnKill: number | null = 137
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
    if (this.exitCodeOnKill !== null) this.exit(this.exitCodeOnKill)
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }

  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListeners.push(listener)
  }

  /** 模拟 PTY 输出（只有真实 PTY 才会产生）。 */
  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }

  /** 模拟 PTY 退出。 */
  exit(code: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode: code })
  }
}

class RawHostClient {
  readonly frames: HostFrame[] = []
  readonly parseErrors: string[] = []
  readonly fence = testFence()
  private fenceInstalled = false
  private readonly decoder = new FrameDecoder()

  private constructor(readonly socket: Socket) {
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

  static connect(pipe: string): Promise<RawHostClient> {
    const socket = createConnection(pipe)
    openSockets.push(socket)
    return new Promise<RawHostClient>((resolve, reject) => {
      socket.once('connect', () => resolve(new RawHostClient(socket)))
      socket.once('error', reject)
    })
  }

  send(payload: Record<string, unknown>): void {
    this.socket.write(encodeFrame({ v: LOCAL_HOST_PROTOCOL_VERSION, ...payload }))
  }

  hello(options: {
    hostId: string
    token: string
    mode?: 'attach' | 'probe'
    cursor?: number
    replay?: boolean
    clientId?: string
    capabilities?: string[]
    v?: number
  }): void {
    this.socket.write(
      encodeFrame({
        v: options.v ?? LOCAL_HOST_PROTOCOL_VERSION,
        type: 'hello',
        hostId: options.hostId,
        token: options.token,
        clientId: options.clientId ?? 'test-client',
        mode: options.mode ?? 'attach',
        cursor: options.cursor ?? 0,
        replay: options.replay ?? true,
        capabilities: options.capabilities ?? [...LOCAL_HOST_REQUIRED_CAPABILITIES]
      })
    )
  }

  /** 安装输入围栏（协议 v2 之后 input 必须带围栏，否则宿主拒绝）。 */
  async installFence(fence: InputFence): Promise<void> {
    const reqId = `fence-${nextFenceReqId++}`
    this.send({ type: 'input-fence', reqId, fence })
    const ack = await this.waitForAck(reqId)
    if (!ack.ok) throw new Error(`fence rejected: ${ack.code ?? 'unknown'}`)
  }

  /** 首次发输入时自动安装本客户端的围栏，返回该帧的 ack。 */
  async sendInput(
    data: string,
    reqId = `i-${nextInputReqId++}`,
    fence: InputFence = this.fence
  ): Promise<Extract<HostFrame, { type: 'ack' }>> {
    if (fence === this.fence && !this.fenceInstalled) {
      await this.installFence(this.fence)
      this.fenceInstalled = true
    }
    this.send({ type: 'input', reqId, data, fence })
    return this.waitForAck(reqId)
  }

  async waitFor(predicate: (frame: HostFrame) => boolean, timeoutMs = 2000): Promise<HostFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.frames.find(predicate)
      if (found) return found
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for frame; got [${this.frames.map((frame) => frame.type).join(', ')}] parseErrors=${
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

  async waitForAck(reqId: string, timeoutMs = 2000): Promise<Extract<HostFrame, { type: 'ack' }>> {
    return (await this.waitFor(
      (frame) => frame.type === 'ack' && frame.reqId === reqId,
      timeoutMs
    )) as Extract<HostFrame, { type: 'ack' }>
  }

  data(): string {
    return this.frames
      .filter((frame): frame is Extract<HostFrame, { type: 'data' }> => frame.type === 'data')
      .map((frame) => frame.data)
      .join('')
  }

  close(): void {
    this.socket.destroy()
  }
}

const openSockets: Socket[] = []
const openHosts: LocalHostServerHandle[] = []
const profileDirs: string[] = []

function makeProfileDir(): string {
  const dir = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'lh-host-'))
  profileDirs.push(dir)
  return dir
}

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

/** Windows 走 named pipe（不需要目录）；其它平台用短目录避免 Unix socket 路径超限。 */
const shortBase = process.platform === 'win32' ? process.cwd() : '/tmp/lh'

interface OpenHostOptions {
  tuning?: Partial<HostTuning>
  exitCodeOnKill?: number | null
  userDataDir?: string
}

async function openHost(options: OpenHostOptions = {}): Promise<{
  handle: LocalHostServerHandle
  pty: MockPty
  config: HostBootstrapConfig
}> {
  const id = newHostId()
  const pty = new MockPty()
  if (options.exitCodeOnKill !== undefined) pty.exitCodeOnKill = options.exitCodeOnKill
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
    pipe: hostPipePath(options.userDataDir ?? shortBase, id),
    spawn,
    tuning: {
      ...DEFAULT_HOST_TUNING,
      graceMs: 80,
      exitRetentionMs: 40,
      heartbeatMs: 0,
      terminateTimeoutMs: 150,
      ...options.tuning
    },
    ...(options.userDataDir ? { userDataDir: options.userDataDir } : {})
  }
  const handle = await startHostServer({ config, ptyFactory: () => pty })
  openHosts.push(handle)
  return { handle, pty, config }
}

function statusOf(frame: HostFrame): LocalHostStatus {
  if (frame.type === 'welcome' || frame.type === 'probe') return frame.status
  if (frame.type === 'status') return frame.status
  throw new Error(`frame ${frame.type} carries no status`)
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    try {
      socket.destroy()
    } catch {
      // 已关闭
    }
  }
  const hosts = openHosts.splice(0)
  for (const handle of hosts) await handle.shutdown()
  for (const dir of profileDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── 鉴权 ──────────────────────────────────────────────────────────────────────

describe('鉴权', () => {
  it('重复实际尺寸不重排 PTY，重新附着后同样按宿主当前尺寸去重', async () => {
    const { handle, config, pty } = await openHost({ tuning: { graceMs: 1000 } })
    const first = await RawHostClient.connect(handle.pipe)
    first.hello({ hostId: handle.id, token: config.token })
    await first.waitForType('welcome')
    first.send({ type: 'resize', reqId: 'initial', cols: 80, rows: 24 })
    first.send({ type: 'resize', reqId: 'changed', cols: 146, rows: 37 })
    first.send({ type: 'resize', reqId: 'same', cols: 146, rows: 37 })
    first.send({ type: 'status', reqId: 'barrier' })
    await first.waitForType('status')
    expect(pty.sizes).toEqual([[146, 37]])
    first.send({ type: 'detach', reqId: 'detach' })
    await first.waitForType('ack')
    const second = await RawHostClient.connect(handle.pipe)
    second.hello({ hostId: handle.id, token: config.token })
    await second.waitForType('welcome')
    second.send({ type: 'resize', reqId: 'reattach-same', cols: 146, rows: 37 })
    second.send({ type: 'status', reqId: 'barrier2' })
    await second.waitForType('status')
    expect(pty.sizes).toEqual([[146, 37]])
  })
  it('token 不对：拒绝且不下发任何输出', async () => {
    const { handle, pty } = await openHost()
    pty.emit('secret-output')

    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: newHostToken() })

    const error = await client.waitForType('error')
    expect(error).toMatchObject({ type: 'error', code: 'unauthorized', hostId: handle.id })
    expect((error as Extract<HostFrame, { type: 'error' }>).fatal).toBe(true)
    expect(client.frames.filter((frame) => frame.type === 'data')).toHaveLength(0)
    expect(client.frames.filter((frame) => frame.type === 'welcome')).toHaveLength(0)
  })

  it('token 对但 hostId 不是本宿主：拒绝', async () => {
    const { handle, config } = await openHost()
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: newHostId(), token: config.token })

    const error = await client.waitForType('error')
    expect(error).toMatchObject({ code: 'host-mismatch', hostId: handle.id })
  })

  it('未 hello 就发命令：拒绝该连接', async () => {
    const { handle } = await openHost()
    const client = await RawHostClient.connect(handle.pipe)
    client.send({ type: 'status', reqId: 'r1' })

    const error = await client.waitForType('error')
    expect(error).toMatchObject({ code: 'unauthorized', message: 'hello required' })
  })

  it('probe 只读：不占位、不改 retained、不重放输出', async () => {
    const { handle, config, pty } = await openHost()
    pty.emit('boot-log')

    const probe = await RawHostClient.connect(handle.pipe)
    probe.hello({ hostId: handle.id, token: config.token, mode: 'probe' })
    const probeFrame = await probe.waitForType('probe')
    expect(statusOf(probeFrame)).toMatchObject({ id: handle.id, running: true, retained: false })
    // probe 不重放输出
    expect(probe.frames.filter((frame) => frame.type === 'data')).toHaveLength(0)

    // probe 没占住客户端位：真正的 attach 仍然能拿到 welcome 与重放
    const attach = await RawHostClient.connect(handle.pipe)
    attach.hello({ hostId: handle.id, token: config.token })
    await attach.waitForType('welcome')
    expect(attach.data()).toBe('boot-log')
    expect(handle.status().retained).toBe(false)
  })
})

// ── 单客户端排他 ──────────────────────────────────────────────────────────────

describe('单客户端排他', () => {
  it('第二个 attach 被 busy 拒绝，第一个不受影响', async () => {
    const { handle, config, pty } = await openHost({ tuning: { graceMs: 500 } })
    const first = await RawHostClient.connect(handle.pipe)
    first.hello({ hostId: handle.id, token: config.token })
    await first.waitForType('welcome')

    const second = await RawHostClient.connect(handle.pipe)
    second.hello({ hostId: handle.id, token: config.token })
    await second.waitForType('busy')
    expect(second.frames.filter((frame) => frame.type === 'welcome')).toHaveLength(0)

    // 被拒绝的连接不会影响已有客户端
    expect((await first.sendInput('x')).ok).toBe(true)
    await waitUntil(() => pty.written.length === 1)
    expect(pty.written).toEqual(['x'])
  })

  it('前一个断开后才允许新的 attach', async () => {
    const { handle, config } = await openHost()
    const first = await RawHostClient.connect(handle.pipe)
    first.hello({ hostId: handle.id, token: config.token })
    await first.waitForType('welcome')
    first.send({ type: 'detach', reqId: 'd1' })
    await first.waitForAck('d1')

    const second = await RawHostClient.connect(handle.pipe)
    second.hello({ hostId: handle.id, token: config.token })
    await second.waitForType('welcome')
  })
})

// ── 输出缓冲 / 重放 ───────────────────────────────────────────────────────────

describe('输出缓冲与重放', () => {
  it('attach 时按 cursor 重放；超出缓冲先发 gap 再发剩余', async () => {
    const { handle, config, pty } = await openHost({
      tuning: { bufferBytes: 4, bufferBlocks: 16, maxBlockChars: 2 }
    })
    pty.emit('abcdef') // 6 字节 > 4 字节上限 → 丢掉 'ab'

    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })

    const welcome = await client.waitForType('welcome')
    expect(welcome.type === 'welcome' && welcome.cursor).toBe(0)
    const gap = await client.waitForType('gap')
    expect(gap).toMatchObject({ from: 0, to: 2 })
    await waitUntil(() => client.data() === 'cdef')
    const dataFrames = client.frames.filter(
      (frame): frame is Extract<HostFrame, { type: 'data' }> => frame.type === 'data'
    )
    expect(dataFrames[0]).toMatchObject({ start: 2, data: 'cd' })
    expect(gap.type === 'gap' && client.frames.indexOf(gap) < client.frames.indexOf(dataFrames[0])).toBe(true)
  })

  it('从 cursor 续传只发新内容', async () => {
    const { handle, config, pty } = await openHost({ tuning: { graceMs: 500 } })
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')
    pty.emit('one')
    await waitUntil(() => client.data() === 'one')

    client.send({ type: 'detach', reqId: 'd1' })
    await client.waitForAck('d1')
    pty.emit('two')

    const next = await RawHostClient.connect(handle.pipe)
    next.hello({ hostId: handle.id, token: config.token, cursor: 3 })
    await next.waitForType('welcome')
    await waitUntil(() => next.data() === 'two')
    expect(next.frames.filter((frame) => frame.type === 'gap')).toHaveLength(0)
  })

  it('cursor 超前属于协议错误（不接受来路不明的光标）', async () => {
    const { handle, config } = await openHost()
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 999 })
    const error = await client.waitForType('error')
    expect(error).toMatchObject({ code: 'cursor-ahead' })
  })

  it('pause 期间不推输出，resume 后补齐', async () => {
    const { handle, config, pty } = await openHost()
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')

    client.send({ type: 'pause' })
    await delay(50) // pause 没有 ack，等宿主处理完再让 PTY 输出
    pty.emit('while-paused')
    await delay(50)
    expect(client.data()).toBe('')

    client.send({ type: 'resume' })
    await waitUntil(() => client.data() === 'while-paused')
  })
})

// ── 输入 ──────────────────────────────────────────────────────────────────────

describe('输入', () => {
  it('输入只在显式发送时写 PTY，重连绝不重放', async () => {
    const { handle, config, pty } = await openHost({ tuning: { graceMs: 500 } })
    const first = await RawHostClient.connect(handle.pipe)
    first.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await first.waitForType('welcome')
    await first.sendInput('ls\r')
    await waitUntil(() => pty.written.length === 1)
    first.send({ type: 'detach', reqId: 'd1' })
    await first.waitForAck('d1')

    const second = await RawHostClient.connect(handle.pipe)
    second.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await second.waitForType('welcome')
    await delay(50)
    // 重放的是输出，不是输入
    expect(pty.written).toEqual(['ls\r'])
  })

  it('重复 reqId 只执行一次（有界去重）', async () => {
    const { handle, config, pty } = await openHost()
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')

    expect((await client.sendInput('a', 'dup')).ok).toBe(true)
    // 同一 reqId 的第二份（即使内容相同）不再执行
    client.send({ type: 'input', reqId: 'dup', data: 'a', fence: client.fence })
    client.send({ type: 'resize', reqId: 'size', cols: 100, rows: 40, fence: client.fence })
    client.send({ type: 'resize', reqId: 'size', cols: 120, rows: 50, fence: client.fence })
    await waitUntil(() => pty.written.length === 1 || pty.sizes.length === 1)
    await delay(50)
    expect(pty.written).toEqual(['a'])
    expect(pty.sizes).toEqual([[100, 40]])
  })
})

// ── 存活策略：宽限期 / retained / terminate ───────────────────────────────────

describe('存活策略', () => {
  it('未收纳时客户端断开：宽限期后终止 PTY', async () => {
    const { handle, config, pty } = await openHost({ tuning: { graceMs: 60 } })
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')

    client.send({ type: 'detach', reqId: 'd1' })
    await client.waitForAck('d1')
    await waitUntil(() => pty.killed, 1000)
    expect(handle.status().running).toBe(false)
  })

  it('收纳任务在应用连接期间保持运行，连接释放后宽限期内结束', async () => {
    const { handle, config, pty } = await openHost({ tuning: { graceMs: 60 } })
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')

    client.send({ type: 'retain', reqId: 'r1', value: true })
    const ack = await client.waitForAck('r1')
    expect(ack).toMatchObject({ ok: true, status: { retained: true, running: true } })
    await delay(200)
    expect(pty.killed).toBe(false)
    expect(handle.status()).toMatchObject({ running: true, retained: true })
    client.send({ type: 'detach', reqId: 'd1' })
    await client.waitForAck('d1')
    await waitUntil(() => pty.killed, 1000)
    expect(handle.status().running).toBe(false)
  })

  it('应用异常断链时，收纳标记也不能让 PTY 无限存活', async () => {
    const { handle, config, pty } = await openHost({ tuning: { graceMs: 60 } })
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')
    client.send({ type: 'retain', reqId: 'r1', value: true })
    await client.waitForAck('r1')
    client.socket.destroy()
    await waitUntil(() => pty.killed, 1000)
    expect(handle.status().running).toBe(false)
  })

  it('terminate 只在拿到真实退出证据后才 ack 成功', async () => {
    const { handle, config, pty } = await openHost()
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')

    client.send({ type: 'terminate', reqId: 't1' })
    const ack = await client.waitForAck('t1')
    expect(ack).toMatchObject({ ok: true, exitCode: 137 })
    expect(pty.killed).toBe(true)

    // 已退出：再次 terminate 直接返回真实退出码，不重复杀
    client.send({ type: 'terminate', reqId: 't2' })
    expect(await client.waitForAck('t2')).toMatchObject({ ok: true, exitCode: 137 })
  })

  it('PTY 杀不掉时 terminate 明确失败，不假装已结束', async () => {
    const { handle, config, pty } = await openHost({
      exitCodeOnKill: null,
      tuning: { terminateTimeoutMs: 120 }
    })
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')

    client.send({ type: 'terminate', reqId: 't1' })
    const ack = await client.waitForAck('t1')
    expect(ack.ok).toBe(false)
    expect(ack).toMatchObject({ code: 'terminate-timeout' })
    expect(pty.killed).toBe(true) // 确实尝试过
    expect(handle.status().running).toBe(true) // 但状态没有被伪造
  })

  it('PTY 自然退出：广播真实 exitCode，客户端断开后释放宿主', async () => {
    const { handle, config, pty } = await openHost({ tuning: { exitRetentionMs: 30, graceMs: 500 } })
    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')

    pty.exit(7)
    const exitFrame = await client.waitForType('exit')
    expect(exitFrame).toMatchObject({ exitCode: 7 })
    expect(handle.status()).toMatchObject({ running: false, exitCode: 7 })

    client.send({ type: 'status', reqId: 's1' })
    expect(statusOf(await client.waitForType('status'))).toMatchObject({ running: false, exitCode: 7 })

    client.close()
    await handle.finished
    expect(handle.status().running).toBe(false)
  })

  it('宿主收尾时只删自己的描述文件', async () => {
    const userDataDir = makeProfileDir()
    const { handle, config, pty } = await openHost({
      tuning: { exitRetentionMs: 20, graceMs: 500 },
      userDataDir
    })
    writeHostDescriptor(userDataDir, {
      version: HOST_DESCRIPTOR_VERSION,
      id: handle.id,
      pipe: handle.pipe,
      pid: handle.pid,
      encryptedToken: Buffer.from('cipher').toString('base64')
    })
    expect(readHostDescriptor(userDataDir, handle.id)).not.toBeNull()

    const client = await RawHostClient.connect(handle.pipe)
    client.hello({ hostId: handle.id, token: config.token, cursor: 0 })
    await client.waitForType('welcome')
    pty.exit(0)
    await client.waitForType('exit')
    client.close()

    await handle.finished
    expect(readHostDescriptor(userDataDir, handle.id)).toBeNull()
  })

  it('宿主收尾保留同路径中伪造为其他 hostId 的描述文件', async () => {
    const userDataDir = makeProfileDir()
    const { handle } = await openHost({ userDataDir })
    const file = hostDescriptorPath(userDataDir, handle.id)
    mkdirSync(join(userDataDir, 'terminal-hosts'), { recursive: true })
    const forged = JSON.stringify({
      version: HOST_DESCRIPTOR_VERSION,
      id: newHostId(),
      pipe: handle.pipe,
      pid: handle.pid,
      encryptedToken: Buffer.from('cipher').toString('base64')
    })
    writeFileSync(file, forged)
    expect(() => readHostDescriptor(userDataDir, handle.id)).toThrow()
    await handle.shutdown()
    expect(readFileSync(file, 'utf8')).toBe(forged)
  })
})

// ── worker 入口（bootstrap 握手）────────────────────────────────────────────

interface FakeChannel {
  api: WorkerBootstrapChannel
  sent: unknown[]
  deliver(message: unknown): void
  readonly didDisconnect: boolean
}

function createFakeChannel(): FakeChannel {
  const messageListeners = new Set<(message: unknown) => void>()
  const disconnectListeners = new Set<() => void>()
  const sent: unknown[] = []
  let didDisconnect = false
  return {
    api: {
      onMessage: (listener) => messageListeners.add(listener),
      offMessage: (listener) => messageListeners.delete(listener),
      onDisconnect: (listener) => disconnectListeners.add(listener),
      offDisconnect: (listener) => disconnectListeners.delete(listener),
      send: (message) => {
        sent.push(message)
      },
      disconnect: () => {
        didDisconnect = true
      }
    },
    sent,
    deliver: (message) => {
      for (const listener of [...messageListeners]) listener(message)
    },
    get didDisconnect() {
      return didDisconnect
    }
  }
}

function bootstrapMessage(overrides: { tuning?: Partial<HostTuning> } = {}): HostBootstrapConfig {
  const id = newHostId()
  return {
    id,
    token: newHostToken(),
    pipe: hostPipePath(shortBase, id),
    spawn: { shell: 'cmd.exe', args: [], env: {}, cols: 80, rows: 24 },
    tuning: { ...DEFAULT_HOST_TUNING, graceMs: 60, exitRetentionMs: 30, heartbeatMs: 0, ...overrides.tuning }
  }
}

describe('worker 入口', () => {
  it('收到 bootstrap 后回 ready、断开父 IPC，并在收尾后 exit(0)', async () => {
    const channel = createFakeChannel()
    const exits: number[] = []
    let created: MockPty | null = null
    const factory: HostPtyFactory = () => {
      created = new MockPty()
      return created
    }
    const config = bootstrapMessage()

    const running = runBootstrapWorker({
      channel: channel.api,
      exit: (code) => exits.push(code),
      ptyFactory: factory,
      installGuards: false,
      pid: 777,
      timeoutMs: 1000
    })

    channel.deliver({ kind: 'bootstrap', v: LOCAL_HOST_PROTOCOL_VERSION, ...config })
    await waitUntil(() => channel.sent.length > 0)
    expect(channel.sent[0]).toMatchObject({ kind: 'ready', id: config.id, pid: 777, pipe: config.pipe })
    expect(channel.didDisconnect).toBe(true)

    await waitUntil(() => created !== null)
    const pty: MockPty = created ?? new MockPty()
    pty.exit(0)
    await waitUntil(() => exits.length > 0)
    expect(exits).toEqual([0])
    await running
  })

  it('等不到 bootstrap 就以专用码退出，且不起 PTY', async () => {
    const channel = createFakeChannel()
    const exits: number[] = []
    const factory: HostPtyFactory = () => {
      throw new Error('must not spawn')
    }
    await runBootstrapWorker({
      channel: channel.api,
      exit: (code) => exits.push(code),
      ptyFactory: factory,
      installGuards: false,
      timeoutMs: 40
    })
    expect(exits).toEqual([WORKER_EXIT_BOOTSTRAP_TIMEOUT])
    expect(channel.sent).toHaveLength(0)
  })

  it('bootstrap 内容不可信时同样退出，不带病启动', async () => {
    const channel = createFakeChannel()
    const exits: number[] = []
    const running = runBootstrapWorker({
      channel: channel.api,
      exit: (code) => exits.push(code),
      ptyFactory: () => {
        throw new Error('must not spawn')
      },
      installGuards: false,
      timeoutMs: 1000
    })
    channel.deliver({ kind: 'bootstrap', v: LOCAL_HOST_PROTOCOL_VERSION, id: 'nope' })
    await running
    expect(exits).toEqual([WORKER_EXIT_BOOTSTRAP_TIMEOUT])
    expect(channel.sent).toHaveLength(0)
  })
})
