import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { Worker } from 'worker_threads'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { LyShellPluginApi } from '../../../src/shared/plugin-api'
import { assertSafeLocalPath } from '../../../src/main/file/path-safety'
import type { LegacyTask, WorkerMessage } from './types'

const ORIGIN = 'lyshell-plugin://legacy-transfer'
const REQUIRED = ['read', 'execute', 'fileWrite', 'localExecute', 'uiControl'] as const
const MAX_BODY = 64 * 1024
type TaskState = { id: string; state: 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed'; direction: string; method: string; transferredSize: number; progress: number; error?: string }

function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label} 无效`)
  return value
}

export async function validateTask(raw: Record<string, unknown>, downloadRoot: string): Promise<LegacyTask> {
  if (typeof raw.method !== 'string' || !['tcp', 'python', 'base64'].includes(raw.method)) throw new Error('请选择一种传输方式')
  if (raw.direction !== 'upload' && raw.direction !== 'download') throw new Error('请选择上传或下载')
  const host = string(raw.host, '主机', 255)
  const port = raw.port === undefined ? 22 : Number(raw.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口须为 1–65535')
  const username = string(raw.username, '用户名', 255)
  const fingerprint = string(raw.fingerprint, '主机指纹', 64)
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error('请输入已核实的 SHA256 SSH 主机指纹')
  const local = string(raw.localPath, '本地路径')
  if (!path.isAbsolute(local)) throw new Error('本地路径必须为绝对路径')
  const localPath = assertSafeLocalPath(local, raw.direction === 'download' ? { write: true, containmentRoot: downloadRoot } : { write: false })
  const remotePath = string(raw.remotePath, '远端路径')
  if (!remotePath.startsWith('/') || /[\r\n]/.test(remotePath)) throw new Error('远端路径须为单行 POSIX 绝对路径')
  const shellEnterCommands = raw.shellEnterCommands ? string(raw.shellEnterCommands, '进入命令') : undefined
  if (shellEnterCommands && raw.method !== 'tcp') throw new Error('进入命令仅支持 Python TCP 方式')
  let fileSize = 0
  if (raw.direction === 'upload') {
    const stat = await fs.stat(localPath)
    if (!stat.isFile()) throw new Error('上传路径须为普通文件')
    fileSize = stat.size
  } else {
    // 不覆盖已有下载；部分文件也保留，由用户检查后删除或另选名字。
    try { await fs.lstat(localPath); throw new Error('本地目标已存在，请使用新文件名') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const password = raw.password ? string(raw.password, '密码') : undefined
  const privateKeyPath = raw.privateKeyPath ? string(raw.privateKeyPath, '私钥路径') : undefined
  let privateKey: string | undefined
  if (privateKeyPath) {
    if (!path.isAbsolute(privateKeyPath)) throw new Error('私钥路径必须为绝对路径')
    const stat = await fs.stat(privateKeyPath)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('私钥文件无效或超过 1 MiB')
    privateKey = await fs.readFile(privateKeyPath, 'utf8')
  }
  if (Boolean(password) === Boolean(privateKey)) throw new Error('请填写密码或私钥文件路径（二选一）')
  const passphrase = raw.passphrase ? string(raw.passphrase, '私钥口令') : undefined
  return { taskId: randomUUID(), sessionId: 'legacy-transfer', direction: raw.direction as LegacyTask['direction'], method: raw.method as LegacyTask['method'],
    localPath, remotePath, fileSize, sshConfig: { host, port, username, password, privateKey, passphrase, fingerprint, shellEnterCommands, shellEnterWait: 3000 } }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('请求须为 JSON')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY) throw new Error('请求超过 64 KiB')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求无效')
  return value as Record<string, unknown>
}

/** 回环服务仅接收本插件 Origin；随机凭据只在内存和请求头中流转。 */
export async function startService(workerPath: string, downloadRoot = path.join(os.homedir(), 'Downloads', 'LyShell-legacy')) {
  const token = randomBytes(32).toString('hex')
  let worker: Worker | undefined
  let task: TaskState | null = null
  let submitting = false
  let stopping = false
  let cancellation: Promise<void> | undefined
  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(data))
  }
  const cancel = (): Promise<void> => {
    if (cancellation) return cancellation
    if (!worker || !task) return Promise.resolve()
    const active = task
    const activeWorker = worker
    active.state = 'cancelling'
    cancellation = activeWorker.terminate().then(() => { active.state = 'cancelled' }).finally(() => {
      if (worker === activeWorker) worker = undefined
      cancellation = undefined
    })
    return cancellation
  }
  const server = createServer((req, res) => {
    void (async () => {
      // 先核对精确来源，拒绝普通网页、null Origin 及无 Origin 的调用。
      if (req.headers.origin !== ORIGIN) { send(res, 403, { error: '来源被拒绝' }); return }
      res.setHeader('Access-Control-Allow-Origin', ORIGIN)
      res.setHeader('Vary', 'Origin')
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        res.writeHead(204); res.end(); return
      }
      if (req.method === 'GET' && req.url === '/handshake') { send(res, 200, { token, downloadRoot }); return }
      const actual = Buffer.from(req.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${token}`)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(res, 401, { error: '凭据无效，请重新打开插件面板' }); return }
      if (stopping) { send(res, 503, { error: '插件正在停止' }); return }
      if (req.method === 'GET' && req.url === '/state') { send(res, 200, { task }); return }
      if (req.method === 'POST' && req.url === '/cancel') {
        const value = await body(req)
        if (!task || value.taskId !== task.id) { send(res, 409, { error: '任务已改变，请刷新状态' }); return }
        await cancel(); send(res, 200, { task }); return
      }
      if (req.method !== 'POST' || req.url !== '/submit') { send(res, 404, { error: '接口不存在' }); return }
      if (submitting || worker) { send(res, 409, { error: '已有传输在执行，请等待或取消' }); return }
      submitting = true
      try {
        const input = await validateTask(await body(req), downloadRoot)
        if (stopping) throw new Error('插件正在停止')
        const current: TaskState = { id: input.taskId, state: 'running', direction: input.direction, method: input.method, transferredSize: 0, progress: 0 }
        const activeWorker = new Worker(workerPath, { workerData: input })
        task = current
        worker = activeWorker
        let terminal: WorkerMessage | undefined
        activeWorker.on('message', (message: WorkerMessage) => {
          if (current.state !== 'running') return
          if (message.type === 'progress') {
            current.progress = message.progress ?? 0
            current.transferredSize = message.transferredSize ?? 0
          } else if (message.type === 'complete' || message.type === 'error') terminal = message
        })
        activeWorker.on('error', error => { terminal = { type: 'error', error: error.message } })
        activeWorker.on('exit', code => {
          if (worker === activeWorker) worker = undefined
          if (current.state !== 'running') return
          if (code === 0 && terminal?.type === 'complete') {
            current.state = 'completed'; current.progress = 100
            current.transferredSize = terminal.transferredSize ?? current.transferredSize
          } else {
            current.state = 'failed'; current.error = terminal?.error || `传输进程退出（${code}），未收到完成回执`
          }
        })
        send(res, 202, { task: current })
      } finally { submitting = false }
    })().catch(error => send(res, 400, { error: (error as Error).message }))
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as import('net').AddressInfo).port
  return { port, async stop() {
    stopping = true
    await cancel()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

let service: Awaited<ReturnType<typeof startService>> | undefined
let pluginApi: LyShellPluginApi | undefined
export async function activate(api: LyShellPluginApi): Promise<void> {
  if (REQUIRED.some(cap => !api.grantedCapabilities.includes(cap))) throw new Error('传统传输插件缺少安装时声明的权限，请在插件管理中核对授权')
  pluginApi = api
  service = await startService(path.join(__dirname, 'worker.js'))
  try {
    // 仅端口落盘；不保存密码、私钥、握手凭据或任务内容。
    await fs.writeFile(path.join(__dirname, 'views', 'connection.js'), `window.legacyTransferPort = ${service.port};\n`, 'utf8')
    await api.registerView({ id: 'transfer', title: '传统文件传输', icon: 'icon.svg', entry: 'views/transfer.html', connectOrigins: [`http://127.0.0.1:${service.port}`] })
  } catch (error) { await service.stop(); service = undefined; throw error }
}
export async function deactivate(): Promise<void> {
  await service?.stop()
  service = undefined
  await pluginApi?.unregisterView('transfer')
  pluginApi = undefined
}
