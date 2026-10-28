/**
 * LocalHostClient 的端到端回环测试。
 *
 * 这里不用真进程：注入一个「假 launcher」，让它在**当前进程内**按 bootstrap 消息
 * 起一台真实的宿主服务端（startHostServer + 真实 named pipe / Unix socket），
 * 只把 node-pty 换成 mock PTY。这样 client 走的是真实 socket、真实帧编解码、
 * 真实描述文件（token 用注入的假安全存储加密），验证的是 client 与宿主的完整契约。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_DESCRIPTOR_VERSION,
  LocalHostError,
  hostDescriptorPath,
  hostPipePath,
  listHostDescriptorIds,
  newHostId,
  newHostToken,
  parseHostBootstrapMessage,
  readHostDescriptor,
  writeHostDescriptor,
  LOCAL_HOST_PROTOCOL_VERSION,
  type HostTuning,
  type LocalHostSpawnOptions
} from './local-host-protocol'
import {
  LocalHostClient,
  setLocalHostClientDeps,
  type LaunchedHostProcess,
  type LocalHostClientDeps,
  type LocalHostSecureStorage
} from './local-host-client'
import { startHostServer, type HostPty, type LocalHostServerHandle } from './local-host-worker'

// client 静态 import 了 electron 的 safeStorage；测试全都注入 secureStorage，
// 这里只是防止 vitest 在非 Electron 环境里拿到真实（不可用的）模块。
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

// ── 测试替身 ──────────────────────────────────────────────────────────────────

let nextPid = 7000

class MockPty implements HostPty {
  readonly pid = nextPid++
  readonly written: string[] = []
  readonly sizes: Array<[number, number]> = []
  killed = false
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

  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }

  exit(code: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode: code })
  }
}

/** 假 launcher 的四种行为，用来测 client 对「启动结果不明」的处理。 */
type FakeMode = 'ok' | 'silent' | 'exit' | 'bad-ready'

interface FakeLauncher {
  readonly spawnCount: () => number
  readonly bootstraps: unknown[]
  readonly ptys: MockPty[]
  readonly disconnects: number
  readonly handles: LocalHostServerHandle[]
}

function createLauncher(options: {
  mode: FakeMode
  onPty?: (pty: MockPty) => void
}): { launch: NonNullable<LocalHostClientDeps['launchWorker']>; launcher: FakeLauncher } {
  const bootstraps: unknown[] = []
  const ptys: MockPty[] = []
  const handles: LocalHostServerHandle[] = []
  let spawns = 0
  let disconnects = 0

  const launch = (): LaunchedHostProcess => {
    spawns += 1
    const messageListeners: Array<(message: unknown) => void> = []
    const exitListeners: Array<(code: number | null) => void> = []
    const errorListeners: Array<(error: Error) => void> = []
    let closed = false

    return {
      pid: 4321,
      send: (message) => {
        bootstraps.push(message)
        void (async () => {
          if (options.mode === 'silent') return
          if (options.mode === 'exit') {
            for (const listener of [...exitListeners]) listener(3)
            return
          }
          if (options.mode === 'bad-ready') {
            for (const listener of [...messageListeners]) {
              listener({ kind: 'ready', v: LOCAL_HOST_PROTOCOL_VERSION, id: newHostId(), pid: 4321, pipe: '\\\\.\\pipe\\other-host' })
            }
            return
          }
          const config = parseHostBootstrapMessage(message)
          const pty = new MockPty()
          ptys.push(pty)
          const handle = await startHostServer({ config, ptyFactory: () => pty })
          handles.push(handle)
          // 服务端已挂好 onData，此时输出才会进环形缓冲
          options.onPty?.(pty)
          if (!closed) {
            for (const listener of [...messageListeners]) {
              listener({ kind: 'ready', v: LOCAL_HOST_PROTOCOL_VERSION, id: handle.id, pid: 4321, pipe: handle.pipe })
            }
          }
        })()
      },
      onMessage: (listener) => {
        messageListeners.push(listener)
        return () => {
          const index = messageListeners.indexOf(listener)
          if (index >= 0) messageListeners.splice(index, 1)
        }
      },
      onExit: (listener) => {
        exitListeners.push(listener)
        return () => {
          const index = exitListeners.indexOf(listener)
          if (index >= 0) exitListeners.splice(index, 1)
        }
      },
      onError: (listener) => {
        errorListeners.push(listener)
        return () => {
          const index = errorListeners.indexOf(listener)
          if (index >= 0) errorListeners.splice(index, 1)
        }
      },
      disconnect: () => {
        disconnects += 1
        closed = true
      },
      unref: () => undefined
    }
  }

  return {
    launch,
    launcher: {
      spawnCount: () => spawns,
      bootstraps,
      ptys,
      get disconnects() {
        return disconnects
      },
      handles
    }
  }
}

const fakeStorage: LocalHostSecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(`enc:${plainText}`, 'utf8'),
  decryptString: (encrypted) => {
    const text = encrypted.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
    return text.slice(4)
  }
}

const cleanedDirs: string[] = []
const cleanedHandles: LocalHostServerHandle[] = []

function makeUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lh-client-'))
  cleanedDirs.push(dir)
  return dir
}

function spawnOptions(): LocalHostSpawnOptions {
  return { shell: 'cmd.exe', args: [], env: { PATH: 'C:\\Windows' }, cols: 80, rows: 24 }
}

interface Harness {
  dir: string
  launcher: FakeLauncher
  pty: () => MockPty
}

function setup(options: {
  mode?: FakeMode
  onPty?: (pty: MockPty) => void
  tune?: Partial<HostTuning>
  storage?: LocalHostSecureStorage | null
  workerScriptPath?: string
  bootstrapTimeoutMs?: number
} = {}): Harness {
  const dir = makeUserDataDir()
  const { launch, launcher } = createLauncher({
    mode: options.mode ?? 'ok',
    ...(options.onPty ? { onPty: options.onPty } : {})
  })
  setLocalHostClientDeps({
    launchWorker: launch,
    secureStorage: options.storage === null ? undefined : (options.storage ?? fakeStorage),
    workerScriptPath: options.workerScriptPath ?? join(dir, 'localHostWorker.js'),
    tuning: { graceMs: 120, exitRetentionMs: 40, terminateTimeoutMs: 400, ...options.tune },
    bootstrapTimeoutMs: options.bootstrapTimeoutMs ?? 2000,
    heartbeatDeadMs: 0,
    rpcTimeoutMs: 2000
  })
  // worker 脚本存在性检查需要一个真实文件（内容无所谓，launcher 是假的）
  if (!options.workerScriptPath) writeFileSync(join(dir, 'localHostWorker.js'), '// fake worker')
  return { dir, launcher, pty: () => launcher.ptys[0] }
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

async function expectError(promise: Promise<unknown>, code: string): Promise<LocalHostError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHostError)
    expect((error as LocalHostError).code).toBe(code)
    return error as LocalHostError
  }
  throw new Error(`expected a rejection with code ${code}`)
}

afterEach(async () => {
  setLocalHostClientDeps(null)
  for (const handle of cleanedHandles.splice(0)) await handle.shutdown()
  for (const dir of cleanedDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// 每个用例自己把 handle 记进来，避免泄漏
function track(launcher: FakeLauncher): void {
  for (const handle of launcher.handles) cleanedHandles.push(handle)
}

// ── create ────────────────────────────────────────────────────────────────────

describe('create', () => {
  it('描述文件写入失败时释放附着，未保存的宿主按宽限期清理', async () => {
    const harness = setup({ tune: { graceMs: 40 } })
    writeFileSync(join(harness.dir, 'terminal-hosts'), 'block directory creation')
    await expect(LocalHostClient.create(harness.dir, spawnOptions())).rejects.toThrow()
    track(harness.launcher)
    await waitUntil(() => harness.pty().killed)
  })
  it('分离后状态属于未知，不能把旧 running 快照当成在线', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    await client.retain(true); await client.detach()
    await expectError(client.status(), 'disconnected')
    expect(await LocalHostClient.probe(harness.dir, client.id)).toMatchObject({ running: true })
  })
  it('拉起宿主、附着、并写下加密 token 的描述文件', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)

    expect(client.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(harness.launcher.spawnCount()).toBe(1)

    const descriptor = readHostDescriptor(harness.dir, client.id)
    expect(descriptor).not.toBeNull()
    expect(descriptor).toMatchObject({
      version: HOST_DESCRIPTOR_VERSION,
      id: client.id,
      pipe: hostPipePath(harness.dir, client.id),
      pid: 4321
    })
    // 落盘的是密文：base64 里解不出 token 明文本身
    const token = fakeStorage.decryptString(Buffer.from(descriptor!.encryptedToken, 'base64'))
    expect(token).toHaveLength(43)
    expect(descriptor!.encryptedToken).not.toContain(token)

    expect(await client.status()).toMatchObject({ id: client.id, running: true, retained: false })
    client.detach()
  })

  it('首帧输出等调用方装好监听才派发，既不丢也不乱序', async () => {
    const harness = setup({ onPty: (pty) => pty.emit('early\r\n') })
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)

    const received: string[] = []
    await delay(60)
    expect(received).toEqual([]) // 还没有监听者

    client.on('data', (text) => received.push(text))
    await waitUntil(() => received.join('') === 'early\r\n')

    harness.pty().emit('later\r\n')
    await waitUntil(() => received.join('') === 'early\r\nlater\r\n')
    client.detach()
  })

  it('safeStorage 不可用时明确失败，不偷偷用明文 token', async () => {
    const harness = setup({ storage: { ...fakeStorage, isEncryptionAvailable: () => false } })
    await expectError(LocalHostClient.create(harness.dir, spawnOptions()), 'secure-storage-unavailable')
    expect(harness.launcher.spawnCount()).toBe(0)
    expect(listHostDescriptorIds(harness.dir)).toEqual([])
  })

  it('编译产物缺失时在 spawn 之前就失败', async () => {
    const dir = makeUserDataDir()
    const harness = setup({ workerScriptPath: join(dir, 'nope.js') })
    await expectError(LocalHostClient.create(harness.dir, spawnOptions()), 'worker-script-missing')
    expect(harness.launcher.spawnCount()).toBe(0)
  })

  it('bootstrap 超时：报未知结果、只 spawn 一次、不按 pid 杀', async () => {
    const harness = setup({ mode: 'silent', bootstrapTimeoutMs: 120 })
    await expectError(LocalHostClient.create(harness.dir, spawnOptions()), 'bootstrap-timeout')
    expect(harness.launcher.spawnCount()).toBe(1)
    expect(harness.launcher.disconnects).toBeGreaterThan(0) // 主动放开 IPC，不占着父进程
  })

  it('worker 启动即退出：报 worker-exited', async () => {
    const harness = setup({ mode: 'exit' })
    await expectError(LocalHostClient.create(harness.dir, spawnOptions()), 'worker-exited')
  })

  it('ready 里的 pipe 与请求不符：拒绝，且不写描述文件', async () => {
    const harness = setup({ mode: 'bad-ready' })
    await expectError(LocalHostClient.create(harness.dir, spawnOptions()), 'protocol-error')
    expect(listHostDescriptorIds(harness.dir)).toEqual([])
  })
})

// ── attach / probe ────────────────────────────────────────────────────────────

describe('attach 与 probe', () => {
  it('同一个宿主只允许一个客户端：第二个 attach 得到 host-busy', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)

    await expectError(LocalHostClient.attach(harness.dir, client.id), 'host-busy')

    // 第一个客户端没有被挤掉
    client.write('x')
    await waitUntil(() => harness.pty().written.length === 1)
    client.detach()
  })

  it('probe 只读：不抢占客户端、不改 retained', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)

    const probed = await LocalHostClient.probe(harness.dir, client.id)
    expect(probed).toMatchObject({ id: client.id, running: true, retained: false })

    client.write('still-mine')
    await waitUntil(() => harness.pty().written.length === 1)
    expect((await client.status()).retained).toBe(false)

    expect(await LocalHostClient.probe(harness.dir, newHostId())).toBeNull()
    client.detach()
  })

  it('detach 之后靠 hostId 重新 attach，能接上原 PTY', async () => {
    const harness = setup()
    const first = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    await first.retain(true)
    await first.detach()

    const second = await LocalHostClient.attach(harness.dir, first.id)
    expect(second.id).toBe(first.id)
    expect(await second.status()).toMatchObject({ running: true, retained: true })
    await second.terminate()
  })

  it('token 被换掉时 attach 被拒绝（unauthorized），不会误接管', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    await client.detach()

    const descriptor = readHostDescriptor(harness.dir, client.id)!
    writeFileSync(
      hostDescriptorPath(harness.dir, client.id),
      JSON.stringify({
        ...descriptor,
        encryptedToken: fakeStorage.encryptString(newHostToken()).toString('base64')
      }),
      { encoding: 'utf8', mode: 0o600 }
    )
    await expectError(LocalHostClient.attach(harness.dir, client.id), 'unauthorized')
  })

  it('描述文件损坏：attach 与 probe 都报 descriptor-invalid（不静默退回新建）', async () => {
    const harness = setup()
    const id = newHostId()
    mkdirSync(dirname(hostDescriptorPath(harness.dir, id)), { recursive: true })
    writeFileSync(hostDescriptorPath(harness.dir, id), '{"version":1', 'utf8')

    await expectError(LocalHostClient.attach(harness.dir, id), 'descriptor-invalid')
    await expectError(LocalHostClient.probe(harness.dir, id), 'descriptor-invalid')
  })

  it('描述文件存在但管道不通：probe 抛 host-unreachable，而不是假装进程已结束', async () => {
    const harness = setup()
    const id = newHostId()
    writeHostDescriptor(harness.dir, {
      version: HOST_DESCRIPTOR_VERSION,
      id,
      pipe: hostPipePath(harness.dir, id),
      pid: 999_999,
      encryptedToken: fakeStorage.encryptString(newHostToken()).toString('base64')
    })
    await expectError(LocalHostClient.probe(harness.dir, id), 'host-unreachable')
    await expectError(LocalHostClient.attach(harness.dir, id), 'host-unreachable')
  })
})

// ── 数据通路 ──────────────────────────────────────────────────────────────────

describe('数据通路', () => {
  it('长粘贴的帧边界保留代理对，逐次 PTY write 转 UTF-8 后仍是原文', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    const text = 'x'.repeat(32767) + '🙂tail'
    client.write(text)
    await waitUntil(() => harness.pty().written.length === 2)
    const writtenBytes = harness.pty().written.map(chunk => Buffer.from(chunk, 'utf8'))
    expect(Buffer.concat(writtenBytes).toString('utf8')).toBe(text)
    await client.terminate()
  })
  it('write/resize 透传到 PTY，超长输入按帧上限切分', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    const pty = harness.pty()

    client.write('ls\r')
    client.resize(100, 40)
    await waitUntil(() => pty.written.length === 1 && pty.sizes.length === 1)
    expect(pty.written).toEqual(['ls\r'])
    expect(pty.sizes).toEqual([[100, 40]])

    client.write('x'.repeat(70_000))
    await waitUntil(() => pty.written.length >= 3)
    expect(pty.written.slice(1).join('')).toHaveLength(70_000)
    client.detach()
  })

  it('pause 后不再推输出，resume 补齐（不丢数据）', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    const received: string[] = []
    client.on('data', (text) => received.push(text))

    client.pause()
    await delay(60)
    harness.pty().emit('paused-output')
    await delay(80)
    expect(received.join('')).toBe('')

    client.resume()
    await waitUntil(() => received.join('') === 'paused-output')
    client.detach()
  })

  it('缓冲溢出后重连只拿到仍在缓冲里的尾部（宿主已先发过 gap）', async () => {
    const harness = setup({ tune: { bufferBytes: 4, maxBlockChars: 2 } })
    const first = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    await first.retain(true)
    await first.detach()

    harness.pty().emit('abcdef') // 6 字节 > 4 字节上限 → 最旧的 'ab' 被丢弃

    const second = await LocalHostClient.attach(harness.dir, first.id)
    const received: string[] = []
    second.on('data', (text) => received.push(text))
    await waitUntil(() => received.join('') === 'cdef')
    expect(received.join('')).not.toContain('ab')
    await second.terminate()
  })

  it('PTY 退出：客户端收到真实 exitCode，status 不再报 running', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    const exits: number[] = []
    client.on('exit', (event) => exits.push(event.exitCode))

    harness.pty().exit(5)
    await waitUntil(() => exits.length === 1)
    expect(exits).toEqual([5])
    expect(await client.status()).toMatchObject({ running: false, exitCode: 5 })
  })
})

// ── 生命周期 ──────────────────────────────────────────────────────────────────

describe('生命周期', () => {
  it('未收纳时 detach：宽限期后宿主终止 PTY（detach ≠ terminate，但也不留僵尸）', async () => {
    const harness = setup({ tune: { graceMs: 80 } })
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)

    await client.detach()
    await waitUntil(() => harness.pty().killed, 1000)
  })

  it('收纳后 detach：宽限期到期也保留 PTY', async () => {
    const harness = setup({ tune: { graceMs: 80 } })
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)

    await client.retain(true)
    expect(await client.status()).toMatchObject({ retained: true })
    await client.detach()

    await delay(250)
    expect(harness.pty().killed).toBe(false)
    expect(await LocalHostClient.probe(harness.dir, client.id)).toMatchObject({ running: true, retained: true })
  })

  it('terminate 拿到真实退出码才成功，并清掉描述文件', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    const exits: number[] = []
    client.on('exit', (event) => exits.push(event.exitCode))

    await client.terminate()
    expect(harness.pty().killed).toBe(true)
    expect(exits).toEqual([137])
    expect(readHostDescriptor(harness.dir, client.id)).toBeNull()
    // 已断开的客户端再 terminate 不应该报「正在运行」
    await client.terminate()
  })

  it('PTY 杀不掉时 terminate 明确失败（不假装已结束）', async () => {
    const harness = setup({ tune: { terminateTimeoutMs: 150 } })
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    harness.pty().exitCodeOnKill = null

    await expectError(client.terminate(), 'terminate-timeout')
    expect(readHostDescriptor(harness.dir, client.id)).not.toBeNull() // 状态未知就不删记录
  })

  it('宿主断开连接时触发 disconnect 事件', async () => {
    const harness = setup()
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    let disconnected = 0
    client.on('disconnect', () => {
      disconnected += 1
    })

    await harness.launcher.handles[0]?.shutdown()
    await waitUntil(() => disconnected === 1)
  })

  it('detach 之后 write 不抛错也不缓冲（断开就是没发出去）', async () => {
    const harness = setup({ tune: { graceMs: 80 } })
    const client = await LocalHostClient.create(harness.dir, spawnOptions())
    track(harness.launcher)
    await client.detach()
    const before = harness.pty().written.length
    client.write('after-detach')
    await delay(50)
    expect(harness.pty().written.length).toBe(before)
  })
})
