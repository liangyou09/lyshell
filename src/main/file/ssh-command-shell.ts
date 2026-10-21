import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { SSHFileClient } from './ssh-file-client'
import { cleanCommandOutput } from './ssh-command-executor'

type CommandResult = { output: string; exitCode: number }
type PendingCommand = {
  command: string
  onData?: (chunk: string) => void
  finish: (error?: Error, result?: CommandResult) => void
}

/** 保留进入命令的持久 shell；命令串行执行，关闭后拒绝所有等待者。 */
export class SSHCommandShell {
  private channel: ClientChannel | undefined
  private generation = 0
  private queue: PendingCommand[] = []
  private active: PendingCommand | undefined
  private marker: string | undefined
  private output = ''

  constructor(private sshFileClient: SSHFileClient, private shellEnterCommands: string) {}

  async execRaw(command: string, timeout = 30000): Promise<string> {
    return (await this.execute(command, timeout)).output
  }

  execStream(command: string, timeout: number, onData: (chunk: string) => void, signal?: AbortSignal): Promise<CommandResult> {
    return this.execute(command, timeout, onData, signal)
  }

  private execute(command: string, timeout: number, onData?: (chunk: string) => void, signal?: AbortSignal): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      const item: PendingCommand = { command, onData, finish: (error, result) => {
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
    void this.openChannel().then(channel => {
      if (generation !== this.generation || this.active !== item) return
      this.output = ''
      const marker = `___END_MARKER_UUID_${randomUUID()}___`
      this.marker = marker
      // 独立换行避免命令末尾的注释吞掉完成标记，同时保留实际退出码。
      channel.write(`${item.command}\nprintf '\\n${marker}:%s\\n' "$?"\n`)
    }).catch(error => { if (generation === this.generation) this.reset(error) })
  }

  private async openChannel(): Promise<ClientChannel> {
    if (this.channel) return this.channel
    const generation = this.generation
    const client = await this.sshFileClient.getClient()
    if (generation !== this.generation) throw new Error('SSH command session closed')
    return new Promise((resolve, reject) => {
      client.shell((error, stream) => {
        if (error) { reject(error); return }
        if (generation !== this.generation) { stream.destroy(); reject(new Error('SSH command session closed')); return }
        this.channel = stream
        const stdout = new StringDecoder('utf8')
        const stderr = new StringDecoder('utf8')
        stream.on('data', (data: Buffer) => {
          if (this.channel !== stream || !this.active) return
          const chunk = stdout.write(data)
          this.output += chunk
          try { this.active.onData?.(chunk) } catch (error) { this.reset(error as Error); return }
          if (!this.marker) return
          const match = new RegExp(`(?:^|\\n)${this.marker}:(\\d+)\\r?\\n`).exec(this.output)
          if (!match) return
          const item = this.active
          const result = { output: cleanCommandOutput(this.output.slice(0, match.index)), exitCode: Number(match[1]) }
          this.active = undefined
          this.marker = undefined
          this.output = ''
          item.finish(undefined, result)
          this.next()
        })
        stream.on('error', (error: Error) => { if (this.channel === stream) this.reset(error) })
        stream.on('close', () => { if (this.channel === stream) this.reset(new Error('Shell channel closed')) })
        // SSH shell 默认没有 PTY，stderr 仍可能使用扩展数据通道。
        stream.stderr.on('data', (data: Buffer) => {
          if (this.channel !== stream || !this.active) return
          const chunk = stderr.write(data)
          this.output += chunk
          try { this.active.onData?.(chunk) } catch (error) { this.reset(error as Error) }
        })
        try {
          for (const command of this.shellEnterCommands.split('\n').filter(line => line.trim())) stream.write(`${command}\n`)
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
    this.marker = undefined
    this.output = ''
    for (const item of pending) item.finish(error)
    channel?.destroy()
  }

  async cleanup(): Promise<void> {
    this.reset(new Error('SSH command session closed'))
  }
}