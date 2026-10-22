import type { ClientChannel } from 'ssh2'
import { StringDecoder } from 'string_decoder'
import { SSHFileClient } from './ssh-file-client'
import { appendCommandOutput } from './command-output'

export function cleanCommandOutput(output: string): string {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim()
}

/** 普通 SSH exec 通道，不启动 SFTP，也不提供文件传输。 */
export class SSHCommandExecutor {
  constructor(private sshFileClient: SSHFileClient) {}

  async execRaw(command: string, timeout = 30000): Promise<string> {
    return (await this.execute(command, timeout)).output
  }

  execStream(command: string, timeout: number, onData: (chunk: string) => void, signal?: AbortSignal): Promise<{ output: string; exitCode: number }> {
    return this.execute(command, timeout, onData, signal)
  }

  private execute(command: string, timeout: number, onData?: (chunk: string) => void, signal?: AbortSignal): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let channel: ClientChannel | undefined
      let settled = false
      const finish = (error?: Error, output = '', exitCode = 0) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) { channel?.destroy(); reject(error) }
        else resolve({ output: cleanCommandOutput(output), exitCode })
      }
      const onAbort = () => finish(new Error('Command aborted'))
      const timer = setTimeout(() => finish(new Error(`Command timeout after ${timeout}ms`)), timeout)
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })

      void this.sshFileClient.getClient().then(client => {
        if (settled) return
        client.exec(command, (error, stream) => {
          if (error) { finish(error); return }
          // 取消可能发生在服务器回复 channel-open 之前。
          if (settled) { stream.destroy(); return }
          channel = stream
          let output = ''
          let exitCode = -1
          const stdout = new StringDecoder('utf8')
          const stderr = new StringDecoder('utf8')
          const append = (chunk: string) => {
            if (settled || !chunk) return
            try { output = appendCommandOutput(output, chunk); onData?.(chunk) } catch (error) { finish(error as Error) }
          }
          stream.on('data', (data: Buffer) => append(stdout.write(data)))
          // 仅收集 stdout 时也排空 stderr，避免远端因窗口耗尽阻塞。
          stream.stderr.on('data', (data: Buffer) => { if (onData) append(stderr.write(data)) })
          stream.on('exit', (code: number | null) => { if (typeof code === 'number') exitCode = code })
          stream.on('error', (error: Error) => finish(error))
          stream.on('close', () => {
            append(stdout.end())
            if (onData) append(stderr.end())
            finish(undefined, output, exitCode)
          })
        })
      }).catch(error => finish(error))
    })
  }
}
