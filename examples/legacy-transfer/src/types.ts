import type { ConnectConfig } from 'ssh2'

export interface LegacyTask {
  taskId: string
  sessionId: string
  direction: 'upload' | 'download'
  method: 'tcp' | 'python' | 'base64'
  sshConfig: ConnectConfig & {
    host: string
    fingerprint: string
    shellEnterCommands?: string
    shellEnterWait?: number
  }
  localPath: string
  remotePath: string
  fileSize: number
}

export interface WorkerMessage {
  type: 'progress' | 'complete' | 'error' | 'log'
  taskId?: string
  sessionId?: string
  progress?: number
  transferredSize?: number
  fileSize?: number
  speed?: number
  error?: string
  level?: string
  message?: string
}
