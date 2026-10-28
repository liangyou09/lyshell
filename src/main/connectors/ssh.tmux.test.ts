import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'ssh2'
import { SSHConnector } from './ssh'
import type { SSHConfig } from './ssh'
import { deriveRemoteSessionName } from './ssh-persistence'

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('ssh2', async () => {
  const { EventEmitter: Emitter } = await import('node:events')

  class FakeChannel extends Emitter {
    stderr = new Emitter()
    closed = false
    close = vi.fn(() => {
      if (this.closed) return
      this.closed = true
      this.emit('close', 0)
    })
    pause = vi.fn()
    resume = vi.fn()
    write = vi.fn()
    setWindow = vi.fn()
  }

  class FakeClient extends Emitter {
    static instances: FakeClient[] = []
    execs: Array<{ command: string; channel: InstanceType<typeof FakeChannel>; options?: unknown }> = []
    shells: Array<InstanceType<typeof FakeChannel>> = []
    shellOptions: unknown[] = []
    /** 按 exec 调用顺序消费的应答脚本；用完后默认「成功、空输出」。 */
    scripts: Array<{ stdout?: string; stderr?: string; code?: number | null; stayOpen?: boolean }> = []
    connect = vi.fn()
    end = vi.fn()

    constructor() {
      super()
      FakeClient.instances.push(this)
    }

    exec(command: string, optionsOrCallback: unknown, maybeCallback?: unknown): InstanceType<typeof FakeChannel> {
      const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as (
        err: Error | null,
        channel: InstanceType<typeof FakeChannel>
      ) => void
      const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback
      const channel = new FakeChannel()
      const script = this.scripts.shift() ?? {}
      this.execs.push({ command, channel, options })
      callback(null, channel)
      if (!script.stayOpen) {
        // 模拟远端命令跑完：先投递输出再关闭通道。
        queueMicrotask(() => {
          if (script.stderr) channel.stderr.emit('data', Buffer.from(script.stderr))
          if (script.stdout) channel.emit('data', Buffer.from(script.stdout))
          channel.emit('exit', script.code ?? 0)
          channel.emit('close', script.code ?? 0)
        })
      }
      return channel
    }

    shell(options: unknown, callback: (err: null, channel: InstanceType<typeof FakeChannel>) => void) {
      const channel = new FakeChannel()
      this.shells.push(channel)
      this.shellOptions.push(options)
      callback(null, channel)
      return channel
    }
  }

  return { Client: FakeClient }
})

type FakeChannel = EventEmitter & {
  stderr: EventEmitter
  closed: boolean
  close: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  setWindow: ReturnType<typeof vi.fn>
}
type FakeScript = { stdout?: string; stderr?: string; code?: number | null; stayOpen?: boolean }
type FakeClient = EventEmitter & {
  execs: Array<{ command: string; channel: FakeChannel; options?: { pty?: { term?: string; rows?: number; cols?: number } } }>
  shells: FakeChannel[]
  shellOptions: unknown[]
  scripts: FakeScript[]
  connect: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

const clients = () => (Client as unknown as { instances: FakeClient[] }).instances
const lastClient = () => clients()[clients().length - 1]

const baseConfig = (): SSHConfig => ({ host: 'example.test', port: 22, username: 'tester' })
const managedConfig = (extra: Partial<SSHConfig> = {}): SSHConfig => ({
  ...baseConfig(),
  keepSessionAlive: true,
  ...extra
})

/** 建 transport → 灌脚本 → 触发 ready → 等 connect 落地。 */
async function connectWith(connector: SSHConnector, scripts: FakeScript[]): Promise<FakeClient> {
  const pending = connector.connect()
  const client = lastClient()
  client.scripts = scripts
  client.emit('ready')
  await pending
  return client
}

const probeOk: FakeScript = { stdout: '/usr/bin/tmux\n' }
const created: FakeScript = { stdout: 'created\n' }
const attachOpen: FakeScript = { stayOpen: true }

const execCommands = (client: FakeClient) => client.execs.map(entry => entry.command)
const attachChannels = (client: FakeClient) =>
  client.execs.filter(entry => entry.command.includes('attach-session')).map(entry => entry.channel)

beforeEach(() => {
  clients().length = 0
})

describe('未开启可续接终端：行为与旧版本一致', () => {
  it('目录命令沿用终端编码，GBK 路径不会被强行按 UTF-8 发送', async () => {
    const connector = new SSHConnector('plain-directory-gbk', { ...baseConfig(), encoding: 'gbk', resumeDirectory: '/srv/项目' })
    const client = await connectWith(connector, [])
    const sent = client.shells[0].write.mock.calls[0][0] as Buffer
    expect(Buffer.isBuffer(sent)).toBe(true)
    const iconv = await import('iconv-lite')
    expect(iconv.decode(sent, 'gbk')).toBe("cd -- '/srv/项目' || :\r")
    await connector.disconnect()
  })
  it('本地上下文恢复只在 shell 就绪后发送一次安全 cd，不调用 tmux 或 exec', async () => {
    const connector = new SSHConnector('plain-directory', { ...baseConfig(), resumeDirectory: "/srv/it's a project" })
    const client = await connectWith(connector, [])
    expect(client.execs).toHaveLength(0)
    expect(client.shells[0].write).toHaveBeenCalledTimes(1)
    expect(client.shells[0].write).toHaveBeenCalledWith("cd -- '/srv/it'\\''s a project' || :\r")
    client.shells[0].emit('data', Buffer.from('cd: no such directory\r\n$ '))
    expect(connector.isConnected()).toBe(true)
    await connector.disconnect()
  })
  it('无法识别目录时仍直接连回 shell，不发任何目录命令', async () => {
    const connector = new SSHConnector('plain-directory-unknown', { ...baseConfig(), resumeDirectory: 'C:/work' })
    const client = await connectWith(connector, [])
    expect(client.execs).toHaveLength(0)
    expect(client.shells[0].write).not.toHaveBeenCalled()
    expect(connector.isConnected()).toBe(true)
    await connector.disconnect()
  })
  it('不执行任何远端命令，直接开交互 shell', async () => {
    const connector = new SSHConnector('plain-runtime', baseConfig())
    const client = await connectWith(connector, [])

    expect(client.execs).toHaveLength(0)
    expect(client.shells).toHaveLength(1)
    expect(client.shellOptions[0]).toMatchObject({ term: 'xterm-256color' })
    expect(connector.isManagedRemoteSession()).toBe(false)
    expect(connector.remoteSessionName).toBeUndefined()
    expect(connector.isConnected()).toBe(true)
  })
})

describe('新建托管终端', () => {
  it('探测 tmux → 创建会话 → 带 pty 附着，名字由 runtime id 派生', async () => {
    const connector = new SSHConnector('runtime-alpha', managedConfig())
    const client = await connectWith(connector, [probeOk, created, attachOpen])

    expect(client.execs).toHaveLength(3)
    expect(execCommands(client)[0]).toContain('command -v tmux')
    expect(execCommands(client)[1]).toContain('new-session -d -s')
    expect(execCommands(client)[2]).toContain('attach-session')

    const attach = client.execs[2]
    expect(attach.options?.pty).toMatchObject({ term: 'xterm-256color', rows: 24, cols: 80 })

    expect(connector.remoteSessionName).toBe(deriveRemoteSessionName('runtime-alpha'))
    expect(connector.isConnected()).toBe(true)
    // 名称只以白名单 + 转义单引号形式进入远端命令
    expect(attach.command).toContain(`'=${deriveRemoteSessionName('runtime-alpha')}'`)
  })

  it('远端没有 tmux 时明确失败，不静默退回普通 shell', async () => {
    const connector = new SSHConnector('runtime-no-tmux', managedConfig())
    const pending = connector.connect()
    const client = lastClient()
    client.scripts = [{ stderr: 'tmux: not found', code: 127 }]
    client.emit('ready')

    await expect(pending).rejects.toThrow(/远端主机未提供 tmux/)
    expect(connector.isConnected()).toBe(false)
    expect(client.shells).toHaveLength(0)
    expect(client.execs).toHaveLength(1)
  })

  it('tmux 建立后立刻退出不能当成连接成功', async () => {
    const connector = new SSHConnector('runtime-early-exit', managedConfig())
    const pending = connector.connect()
    const client = lastClient()
    client.scripts = [probeOk, created, { stderr: 'no server running on /tmp/tmux-1000/default', code: 1 }]
    client.emit('ready')

    await expect(pending).rejects.toThrow(/tmux 终端未就绪即退出/)
    expect(connector.isConnected()).toBe(false)
    // 启动失败时顺手清掉本连接刚建的会话，不留没人认领的 tmux
    expect(execCommands(client)).toContainEqual(expect.stringContaining('kill-session'))
  })
})

describe('恢复到已保存的远端会话', () => {
  it('派生名已存在时也不把它当作本次创建的会话清理', async () => {
    const connector = new SSHConnector('runtime-existing-derived', managedConfig())
    const client = await connectWith(connector, [probeOk, { stdout: 'existing\n' }, attachOpen])
    await connector.disconnect()
    expect(execCommands(client).some(command => command.includes('kill-session'))).toBe(false)
  })
  it('只 attach：准备命令里没有 new-session，也不重放输入', async () => {
    const connector = new SSHConnector('runtime-resume', managedConfig({ resumeSessionName: 'lyshell-old-1' }))
    const client = await connectWith(connector, [probeOk, { stdout: 'existing\n' }, attachOpen])

    const ensureCommand = execCommands(client)[1]
    expect(ensureCommand).toContain('has-session')
    expect(ensureCommand).not.toContain('new-session')
    expect(ensureCommand).toContain("'=lyshell-old-1'")
    expect(connector.remoteSessionName).toBe('lyshell-old-1')

    const [attach] = attachChannels(client)
    // 不重放启动命令：连接流程自己从不往 shell 写东西
    expect(attach.write).toHaveBeenCalledTimes(0)
  })

  it('原会话已不存在时如实报「原现场已结束」，不自作主张新建同名会话', async () => {
    const connector = new SSHConnector('runtime-missing', managedConfig({ resumeSessionName: 'lyshell-gone' }))
    const pending = connector.connect()
    const client = lastClient()
    client.scripts = [probeOk, { stderr: "can't find session", code: 3 }]
    client.emit('ready')

    await expect(pending).rejects.toThrow(/原现场已结束/)
    expect(client.execs).toHaveLength(2)
    expect(execCommands(client).some(command => command.includes('new-session'))).toBe(false)
    expect(execCommands(client).some(command => command.includes('attach-session'))).toBe(false)
    expect(connector.remoteSessionName).toBeUndefined()
  })

  it('非法恢复名在建立 transport 之前就被拒绝', async () => {
    const connector = new SSHConnector('runtime-bad-name', managedConfig({ resumeSessionName: 'x; rm -rf / #' }))

    await expect(connector.connect()).rejects.toThrow(/远端会话名不合法/)
    expect(clients()).toHaveLength(0)
  })

  it('只接受白名单恢复名（首尾空白可容忍）', async () => {
    const connector = new SSHConnector('runtime-trim', managedConfig({ resumeSessionName: '  lyshell-trim-1  ' }))
    await connectWith(connector, [probeOk, { stdout: 'existing\n' }, attachOpen])
    expect(connector.remoteSessionName).toBe('lyshell-trim-1')
  })
})

describe('断开时的清理语义', () => {
  it('未收纳的托管终端：主动断开销毁自己创建的远端会话', async () => {
    const connector = new SSHConnector('runtime-clean', managedConfig())
    const client = await connectWith(connector, [probeOk, created, attachOpen])

    await connector.disconnect()

    expect(execCommands(client)).toContainEqual(expect.stringContaining('kill-session'))
    expect(connector.isConnected()).toBe(false)
    // 名字仍保留，供保存区在断开后读取
    expect(connector.remoteSessionName).toBe(deriveRemoteSessionName('runtime-clean'))
  })

  it('已收纳：只 detach，不销毁远端程序', async () => {
    const connector = new SSHConnector('runtime-kept', managedConfig())
    const client = await connectWith(connector, [probeOk, created, attachOpen])

    connector.setSessionRetained(true)
    await connector.disconnect()

    expect(execCommands(client).some(command => command.includes('kill-session'))).toBe(false)
    const [attach] = attachChannels(client)
    expect(attach.close).toHaveBeenCalled()
    expect(connector.isConnected()).toBe(false)
  })

  it('链路自然中断（远端会话被 detach / 连接掉线）不误杀远端程序', async () => {
    const connector = new SSHConnector('runtime-natural', managedConfig())
    const client = await connectWith(connector, [probeOk, created, attachOpen])

    const [attach] = attachChannels(client)
    attach.emit('close', 0)

    await vi.waitFor(() => expect(connector.isConnected()).toBe(false))
    expect(execCommands(client).some(command => command.includes('kill-session'))).toBe(false)
    expect(connector.remoteSessionName).toBe(deriveRemoteSessionName('runtime-natural'))
  })

  it('恢复来的会话不归本连接所有：主动断开也不销毁', async () => {
    const connector = new SSHConnector('runtime-resume-owner', managedConfig({ resumeSessionName: 'lyshell-other' }))
    const client = await connectWith(connector, [probeOk, { stdout: 'existing\n' }, attachOpen])

    await connector.disconnect()

    expect(execCommands(client).some(command => command.includes('kill-session'))).toBe(false)
  })
})

describe('克隆渠道', () => {
  it('克隆也走托管，但用自己的 runtime id 派生新会话并忽略恢复名', async () => {
    const source = new SSHConnector('runtime-source', managedConfig())
    const client = await connectWith(source, [probeOk, created, attachOpen])

    const clone = new SSHConnector('runtime-clone', managedConfig({ resumeSessionName: 'lyshell-source' }))
    clone.setSharedClient(client)
    client.scripts = [probeOk, created, attachOpen]
    await clone.startShellOnly()

    const cloneName = deriveRemoteSessionName('runtime-clone')
    expect(clone.remoteSessionName).toBe(cloneName)
    const cloneExecs = client.execs.filter(entry => entry.command.includes('attach-session'))
    expect(cloneExecs[cloneExecs.length - 1].command).toContain(`'=${cloneName}'`)
    // 克隆不是恢复：不能两个终端抢同一个 tmux 会话
    expect(client.execs.some(entry => entry.command.includes("'=lyshell-source'"))).toBe(false)
  })
})
