/**
 * Windows 本地命令 helper（构建为 `dist/main/localCommandWorker.js`）。
 *
 * 父进程先 spawn 本 helper，把其 PID 绑定进已设置 KILL_ON_JOB_CLOSE 的 Job Object，
 * 确认绑定成功后才发送 start；因此 helper 在收到 start 之前不会派发任何用户命令。
 * 用户 shell 由 helper 继承 Job 成员资格，父进程查询 Job 的 ActiveProcesses 来确认整树释放。
 *
 * 协议失败不回退到无 Job 执行；helper 在 start 前超时或与父进程断开时自行退出。
 */
import { spawn, type ChildProcess } from 'child_process'
import { childEnvironment } from '../env/child-environment'
import {
  COMMAND_WORKER_START_TIMEOUT_MS,
  type CommandWorkerRequest,
  type CommandWorkerResponse
} from './command-worker-protocol'

// ELECTRON_RUN_AS_NODE 只用于启动本 helper；用户命令不得继承它。
delete process.env.ELECTRON_RUN_AS_NODE

let child: ChildProcess | undefined
let receivedStart = false
let settled = false

function send(message: CommandWorkerResponse, done?: (error: Error | null) => void): void {
  try {
    if (!process.send) { done?.(new Error('command helper IPC channel is unavailable')); return }
    process.send(message, undefined, undefined, error => {
      if (done) done(error)
      else if (error) process.exit(4)
    })
  } catch {
    done?.(new Error('command helper IPC channel is unavailable'))
  }
}

function exitAfterFlush(code: number): void {
  // 留出 IPC 排空时间；父进程同时持有 Job handle，helper 退出不会影响命令树。
  setTimeout(() => process.exit(code), 50)
}

const startTimer = setTimeout(() => {
  if (receivedStart) return
  send({ type: 'error', phase: 'protocol', message: 'command helper received no start' })
  exitAfterFlush(3)
}, COMMAND_WORKER_START_TIMEOUT_MS)

process.on('disconnect', () => {
  // 父进程失联：不再等待命令，退出后由 Job handle 关闭回收整棵树。
  settled = true
  try { child?.kill() } catch { /* 已退出 */ }
  process.exit(4)
})

function startCommand(request: CommandWorkerRequest): void {
  receivedStart = true
  clearTimeout(startTimer)
  if (typeof request.command !== 'string' || request.command.length === 0) {
    send({ type: 'error', phase: 'protocol', message: 'command helper received an invalid command' })
    exitAfterFlush(2)
    return
  }
  const execEnv = childEnvironment(process.env, request.env ?? {}) as Record<string, string>
  for (const key of Object.keys(execEnv)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete execEnv[key]
  }
  const execCwd = request.cwd || process.env.USERPROFILE || process.env.HOME || ''
  try {
    child = spawn(request.command, {
      cwd: execCwd,
      env: execEnv,
      shell: true,
      windowsHide: true,
      detached: false
    })
  } catch {
    send({ type: 'error', phase: 'spawn', message: 'command process could not be started' })
    exitAfterFlush(1)
    return
  }

  child.on('spawn', () => send({ type: 'started', pid: child?.pid ?? null }))
  // 每条管道至多一个 IPC 分片在途；pause/resume 避免 helper 的 IPC 写队列无界增长。
  // UTF-8 单字符至多四字节；超过原始字节上限明确失败，不把截断结果当成功。
  let outputBytes = 0
  for (const [stream, type] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
    stream?.on('data', (data: Buffer) => {
      if (settled) return
      outputBytes += data.length
      stream.pause()
      if (outputBytes > 4 * 1024 * 1024) {
        settled = true
        send({ type: 'error', phase: 'output-limit', message: 'Command output limit exceeded' }, () => exitAfterFlush(1))
        return
      }
      send({ type, data: data.toString('base64') }, error => {
        if (error) { settled = true; process.exit(4) }
        else if (!settled) stream.resume()
      })
    })
  }
  child.on('error', () => {
    if (settled) return
    settled = true
    send({ type: 'error', phase: 'runtime', message: 'command process reported a runtime error' })
    exitAfterFlush(1)
  })
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return
    settled = true
    send({ type: 'exit', code, signal: signal ?? null }, () => exitAfterFlush(0))
  })
}

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return
  const request = message as Partial<CommandWorkerRequest>
  if (request.type !== 'start') return
  if (receivedStart) return
  startCommand(request as CommandWorkerRequest)
})

send({ type: 'ready', pid: process.pid })
