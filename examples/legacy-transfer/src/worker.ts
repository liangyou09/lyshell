import { parentPort, workerData } from 'worker_threads'
import { Client } from 'ssh2'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { uploadViaExecPython } from './upload-tcp'
import { downloadViaExecPython } from './download-tcp'
import { transferStdio } from './stdio'
import { redactSecrets } from './redact'
import type { LegacyTask, WorkerMessage } from './types'

const task = workerData as LegacyTask
let finished = false
function sendMessage(message: WorkerMessage): void {
  if (message.type === 'complete' || message.type === 'error') {
    if (finished) return
    finished = true
  }
  if (message.type !== 'log') parentPort?.postMessage(message)
}
function log(_level: string, message: string): void { redactSecrets(message) }

async function run(): Promise<void> {
  const client = new Client()
  const deadline = setTimeout(() => {
    sendMessage({ type: 'error', error: '传输超过 30 分钟，请检查远端命令与网络后重试。' })
    client.destroy()
    process.exit(1)
  }, 30 * 60 * 1000)
  try {
    await fs.promises.mkdir(path.dirname(task.localPath), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      client.on('error', error => { reject(error); if (!finished) sendMessage({ type: 'error', error: error.message }) })
      client.once('ready', resolve)
      client.once('close', () => { if (!finished) reject(new Error('SSH connection closed')) })
      client.connect({ ...task.sshConfig,
        readyTimeout: 30000, keepaliveInterval: 10000,
        hostVerifier: (key: Buffer) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === task.sshConfig.fingerprint
      })
    })
    if (task.method === 'tcp') {
      await new Promise<void>((resolve, reject) => {
        const engine = task.direction === 'upload' ? uploadViaExecPython : downloadViaExecPython
        engine(client, task, Date.now(), resolve, reject, sendMessage, log)
      })
    } else {
      await transferStdio(client, task, sendMessage)
    }
  } finally {
    clearTimeout(deadline)
    client.destroy()
  }
}

void run().then(() => process.exit(0), error => {
  sendMessage({ type: 'error', error: redactSecrets((error as Error).message) })
  process.exit(1)
})
