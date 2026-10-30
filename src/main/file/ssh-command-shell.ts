import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { SSHFileClient } from './ssh-file-client'
import { cleanCommandOutput, type CommandDispatchGuard } from './ssh-command-executor'
import { ShellCommandOutput } from './shell-command-output'
import { OperationError } from '@shared/operation'

type CommandResult = { output: string; exitCode: number }
type PendingCommand = {
  command: string
  onData?: (chunk: string) => void
  assertCurrent?: CommandDispatchGuard
  initialized: boolean
  finish: (error?: Error, result?: CommandResult) => void
}

/** 保留进入命令的持久 shell；命令串行执行，关闭后拒绝所有等待者。 */
export class SSHCommandShell {
  private channel: ClientChannel | undefined
  private generation = 0
  private queue: PendingCommand[] = []
  private active: PendingCommand | undefined
  private output: ShellCommandOutput | undefined

  constructor(private sshFileClient: SSHFileClient, private shellEnterCommands: string) {}

  async execRaw(command: string, timeout = 30000, assertCurrent?: CommandDispatchGuard): Promise<string> {
    return (await this.execute(command, timeout, undefined, undefined, assertCurrent)).output
  }

  execStream(command: string, timeout: number, onData: (chunk: string) => void, signal?: AbortSignal, assertCurrent?: CommandDispatchGuard): Promise<CommandResult> {
    return this.execute(command, timeout, onData, signal, assertCurrent)
  }

  private execute(command: string, timeout: number, onData?: (chunk: string) => void, signal?: AbortSignal, assertCurrent?: CommandDispatchGuard): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      const item: PendingCommand = { command, onData, assertCurrent, initialized: false, finish: (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(result!)
      } }
      const cancel = (error: Error) => {
        if (settled) return
        if (this.active === item) this.reset(error)
        else {
          this.queue = this.queue.filter(queued => queued !== item)
          item.finish(error)
        }
      }
      const onAbort = () => cancel(new Error('Command aborted'))
      const timer = setTimeout(() => cancel(new Error(`Command timeout after ${timeout}ms`)), timeout)
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(item)
      this.next()
    })
  }

  private next(): void {
    if (this.active) return
    const item = this.queue.shift()
    if (!item) return
    this.active = item
    const generation = this.generation
    void this.openChannel(item).then(channel => {
      if (generation !== this.generation || this.active !== item) return
      this.assertCurrent(item)
      const marker = `___END_MARKER_UUID_${randomUUID()}___`
      this.output = new ShellCommandOutput(marker, item.onData)
      // 独立换行避免命令末尾的注释吞掉完成标记，同时保留实际退出码。
      channel.write(`${item.command}\nprintf '\\n${marker}:%s\\n' "$?"\n`)
    }).catch(error => { if (generation === this.generation) this.reset(error) })
  }

  private assertCurrent(item: PendingCommand): void {
    try { item.assertCurrent?.() } catch (error) {
      if (item.initialized) throw new OperationError('OUTCOME_UNKNOWN', 'SSH shell initialization was dispatched before authorization changed; inspect side effects before retrying', 'reconcile-first')
      throw error
    }
  }

  private async openChannel(item: PendingCommand): Promise<ClientChannel> {
    this.assertCurrent(item)
    if (this.channel) return this.channel
    const generation = this.generation
    const client = await this.sshFileClient.getClient()
    if (generation !== this.generation || this.active !== item) throw new Error('SSH command session closed')
    this.assertCurrent(item)
    return new Promise((resolve, reject) => {
      client.shell((error, stream) => {
        if (error) { reject(error); return }
        if (generation !== this.generation) { stream.destroy(); reject(new Error('SSH command session closed')); return }
        try { this.assertCurrent(item) } catch (error) { stream.destroy(); reject(error); return }
        this.channel = stream
        const stdout = new StringDecoder('utf8')
        const stderr = new StringDecoder('utf8')
        stream.on('data', (data: Buffer) => {
          if (this.channel !== stream || !this.active) return
          const item = this.active
          let result: CommandResult | undefined
          try { result = this.output?.stdout(stdout.write(data)) } catch (error) { this.reset(error as Error); return }
          if (!result || this.active !== item || this.channel !== stream) return
          this.active = undefined
          this.output = undefined
          item.finish(undefined, { ...result, output: cleanCommandOutput(result.output) })
          this.next()
        })
        stream.on('error', (error: Error) => { if (this.channel === stream) this.reset(error) })
        stream.on('close', () => { if (this.channel === stream) this.reset(new Error('Shell channel closed')) })
        // SSH shell 默认没有 PTY，stderr 仍可能使用扩展数据通道。
        stream.stderr.on('data', (data: Buffer) => {
          if (this.channel !== stream || !this.active) return
          try { this.output?.stderr(stderr.write(data)) } catch (error) { this.reset(error as Error) }
        })
        try {
          for (const command of this.shellEnterCommands.split('\n').filter(line => line.trim())) {
            this.assertCurrent(item)
            item.initialized = true
            stream.write(`${command}\n`)
          }
          resolve(stream)
        } catch (error) { reject(error) }
      })
    })
  }

  private reset(error: Error): void {
    this.generation++
    const channel = this.channel
    this.channel = undefined
    const pending = this.active ? [this.active, ...this.queue] : this.queue
    this.active = undefined
    this.queue = []
    this.output = undefined
    for (const item of pending) item.finish(error)
    channel?.destroy()
  }

  async cleanup(): Promise<void> {
    this.reset(new Error('SSH command session closed'))
  }
}
