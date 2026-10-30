/**
 * Windows 本地命令 helper 的 IPC 协议。
 *
 * helper 只负责“等 start → spawn shell → 转发原始字节”，自身不解析输出；
 * 父进程在发出 start 之前已完成 Job Object 绑定，helper 在收到 start 前绝不派发命令。
 */

export interface CommandWorkerStart {
  type: 'start'
  command: string
  cwd: string
  env: Record<string, string>
}

export type CommandWorkerRequest = CommandWorkerStart

/** stdout/stderr 用 base64 承载原始字节，父进程的增量 UTF-8 解码语义不被切断。 */
export type CommandWorkerResponse =
  | { type: 'ready'; pid: number }
  | { type: 'started'; pid: number | null }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; phase: 'spawn' | 'protocol' | 'runtime' | 'output-limit'; message: string }

/** helper 在 start 前的自我期限：父进程崩溃/失联时不留下永久等待的进程。 */
export const COMMAND_WORKER_START_TIMEOUT_MS = 15_000
