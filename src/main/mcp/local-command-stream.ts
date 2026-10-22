import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import log from 'electron-log'
import { appendCommandOutput } from '../file/command-output'
import { terminatePluginProcess } from '../plugin/process-cleanup'

export function executeLocalCommandStream(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeout: number,
  onData: (chunk: string) => void,
  signal?: AbortSignal
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const execEnv = { ...process.env, ...env } as Record<string, string>
    const execCwd = cwd || process.env.USERPROFILE || process.env.HOME || ''

    log.info(`[MCP] Executing local command (stream): ${command} (cwd: ${execCwd})`)

    if (signal?.aborted) { reject(new Error('Command aborted')); return }
    const child = spawn(command, { cwd: execCwd, env: execEnv, shell: true, windowsHide: true, detached: process.platform !== 'win32' })
    let output = ''
    let settled = false
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    const finish = (error?: Error, exitCode = -1) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        child.stdout?.destroy(); child.stderr?.destroy()
        void terminatePluginProcess(child, { processGroup: process.platform !== 'win32' }).catch(cleanupError => log.warn('[MCP] Command cleanup failed:', cleanupError.message))
        reject(error)
      }
      else resolve({ output, exitCode })
    }
    const timer = setTimeout(() => finish(new Error('Command timeout')), timeout)
    const onAbort = () => finish(new Error('Command aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const append = (chunk: string) => {
      if (settled || !chunk) return
      try { output = appendCommandOutput(output, chunk); onData(chunk) } catch (error) { finish(error as Error) }
    }
    child.stdout?.on('data', (data: Buffer) => append(stdout.write(data)))
    child.stderr?.on('data', (data: Buffer) => append(stderr.write(data)))
    child.on('error', (error) => finish(error))
    child.on('close', (code: number | null) => {
      append(stdout.end()); append(stderr.end())
      finish(undefined, code ?? -1)
    })
  })
}
