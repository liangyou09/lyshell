import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Server, utils } from 'ssh2'
import { generateKeyPairSync, createHash, randomBytes } from 'crypto'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import AdmZip from 'adm-zip'
import { base64Transform } from './src/stdio'
import { validateManifest } from '../../src/shared/plugin-types'
import { FileManager } from '../../src/main/file/manager'
import { Worker } from 'worker_threads'
import { build } from 'esbuild'
import type { startService } from './src/main'

const require = createRequire(import.meta.url)
vi.mock('electron-log', () => ({ default: { debug() {}, info() {}, warn() {}, error() {} } }))
const origin = 'lyshell-plugin://legacy-transfer'
let directory: string
let service: Awaited<ReturnType<typeof startService>>
let sshServer: Server
let port: number
let token: string
let fingerprint: string
let installed: string
let commands = 0
let tunnels = 0
let sftpAttempts = 0
const children = new Set<ChildProcess>()
const peers = new Set<import('ssh2').Connection>()
const sockets = new Set<net.Socket>()

function remote(file: string) {
  if (!file.startsWith('/fixture/') || path.basename(file) !== file.slice('/fixture/'.length)) throw new Error('Bad fixture path')
  return path.join(directory, 'remote', path.basename(file))
}

// 只解析本插件生成的 POSIX 单引号参数。fixture 不调用真实交互 shell。
function words(command: string): string[] {
  const result: string[] = []
  let word = '', quoted = false, escaped = false, active = false
  for (const char of command) {
    if (escaped) { word += char; escaped = false; active = true }
    else if (char === '\\' && !quoted) escaped = true
    else if (char === "'") { quoted = !quoted; active = true }
    else if (/\s/.test(char) && !quoted) { if (active) result.push(word); word = ''; active = false }
    else { word += char; active = true }
  }
  if (active) result.push(word)
  return result
}

async function request(route: string, data?: unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}${route}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data)
  })
  return { status: response.status, data: await response.json() as { error?: string; task: { id: string; state: string; error?: string; transferredSize: number } } }
}

async function finished(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { data } = await request('/state')
    expect(data.task.id).toBe(id)
    if (!['running', 'cancelling'].includes(data.task.state)) return data.task
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Fixture transfer timeout')
}

function input(method: string, direction: string, localPath: string, remotePath = '/fixture/payload.bin') {
  return { host: '127.0.0.1', port, username: 'fixture', password: 'fixture-only', fingerprint, method, direction, localPath, remotePath }
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-ssh-'))
  fs.mkdirSync(path.join(directory, 'remote'))
  fs.mkdirSync(path.join(directory, 'downloads'))
  execFileSync(process.execPath, ['examples/legacy-transfer/build.mjs'], { cwd: process.cwd(), stdio: 'pipe' })
  installed = path.join(directory, 'installed')
  new AdmZip(path.join(process.cwd(), 'examples/legacy-transfer/dist/legacy-transfer-1.0.0.zip')).extractAllTo(installed)
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'lyshell-plugin.json'), 'utf8'))
  expect(validateManifest(manifest).errors).toEqual([])
  const plugin = require(path.join(installed, 'main.js')) as { startService: typeof startService }
  await build({ entryPoints: ['src/main/file/download-worker.ts', 'src/main/file/upload-worker.ts'], outdir: path.join(directory, 'builtin'),
    bundle: true, platform: 'node', format: 'cjs', external: ['cpu-features', './crypto/build/Release/sshcrypto.node'] })
  service = await plugin.startService(path.join(installed, 'worker.js'), path.join(directory, 'downloads'))
  const handshake = await fetch(`http://127.0.0.1:${service.port}/handshake`, { headers: { Origin: origin } })
  token = ((await handshake.json()) as { token: string }).token
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
  const key = utils.parseKey(privateKey)
  if (key instanceof Error || Array.isArray(key)) throw new Error('Invalid fixture key')
  fingerprint = 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')
  sshServer = new Server({ hostKeys: [privateKey] }, client => {
    peers.add(client)
    client.on('close', () => peers.delete(client))
    client.on('error', () => {})
    client.on('authentication', context => context.method === 'password' && context.password === 'fixture-only' ? context.accept() : context.reject())
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1') { reject(); return }
        tunnels++
        const socket = net.connect(info.destPort, '127.0.0.1')
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        const stream = accept()
        socket.pipe(stream).pipe(socket)
        stream.on('close', () => socket.destroy())
      })
      client.on('session', accept => {
        const session = accept()
        session.on('pty', accept => accept())
        session.on('sftp', (_accept, reject) => { sftpAttempts++; reject() })
        session.on('shell', accept => {
          const channel = accept()
          let buffer = ''
          channel.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (line === 'ordinary-command') channel.write('ordinary-command-ok\n')
              const marker = line.match(/(___END_MARKER_UUID_[\w-]+___):%s/)
              if (marker) channel.write(`\n${marker[1]}:0\n`)
            }
          })
          channel.on('error', () => {})
        })
        session.on('exec', (accept, _reject, info) => {
          commands++
          const channel = accept()
          channel.on('error', () => {})
          if (info.command.includes('/fixture/hang')) return
          if (info.command.includes('ENDSCRIPT')) {
            let code = info.command.split("<< 'ENDSCRIPT'\n")[1]?.split('\nENDSCRIPT')[0]
            if (!code) { channel.exit(2); channel.end(); return }
            code = code.replace(/"(\/fixture\/[^"\n]*)"/g, (_match, file) => JSON.stringify(remote(file)))
            const child = spawn('python', ['-u', '-c', code], { windowsHide: true })
            children.add(child)
            child.stdout.pipe(channel, { end: false })
            child.stderr.pipe(channel.stderr, { end: false })
            child.on('close', code => { children.delete(child); if (!channel.destroyed) { channel.exit(code ?? 1); channel.end() } })
            channel.on('close', () => child.kill())
            return
          }
          const args = words(info.command)
          if (args[0] === 'python3') {
            const child = spawn('python', ['-u', '-c', args[2], remote(args[3])], { windowsHide: true })
            children.add(child)
            channel.pipe(child.stdin)
            child.stdout.pipe(channel, { end: false })
            child.stderr.pipe(channel.stderr, { end: false })
            child.on('close', code => { children.delete(child); if (!channel.destroyed) { channel.exit(code ?? 1); channel.end() } })
            channel.on('close', () => child.kill())
            return
          }
          if (info.command.includes('base64 -d')) {
            const output = fs.createWriteStream(remote(args[args.length - 1]))
            channel.pipe(base64Transform(false)).pipe(output)
            output.on('finish', () => { channel.exit(0); channel.end() })
          } else if (args[0] === 'base64') {
            const stream = fs.createReadStream(remote(args[2])).pipe(base64Transform(true))
            stream.pipe(channel, { end: false })
            stream.on('end', () => { channel.exit(0); channel.end() })
          } else { channel.write('ordinary-command-ok'); channel.exit(0); channel.end() }
        })
      })
    })
  })
  await new Promise<void>(resolve => sshServer.listen(0, '127.0.0.1', resolve))
  port = (sshServer.address() as net.AddressInfo).port
}, 20000)

afterAll(async () => {
  await service?.stop()
  for (const child of children) child.kill()
  for (const socket of sockets) socket.destroy()
  for (const peer of peers) peer.end()
  if (sshServer) await new Promise<void>(resolve => sshServer.close(() => resolve()))
  if (directory) await fs.promises.rm(directory, { recursive: true, force: true })
})

describe('安装包真实 SSH 传输（SFTP 被禁用）', () => {
  for (const method of ['tcp', 'python', 'base64']) {
    for (const size of [0, 1024 * 1024 + 17]) {
      it(`${method}: ${size} 字节上传/下载与原始内容一致`, async () => {
        const source = path.join(directory, `source-${method}-${size}`)
        const destination = path.join(directory, 'downloads', `received-${method}-${size}`)
        const binary = randomBytes(size)
        fs.writeFileSync(source, binary)
        const upload = await request('/submit', input(method, 'upload', source))
        expect(upload.status, upload.data.error).toBe(202)
        const uploaded = await finished(upload.data.task.id)
        expect(uploaded.state, uploaded.error).toBe('completed')
        expect(fs.readFileSync(remote('/fixture/payload.bin'))).toEqual(binary)
        const download = await request('/submit', input(method, 'download', destination))
        expect(download.status, download.data.error).toBe(202)
        const downloaded = await finished(download.data.task.id)
        expect(downloaded.state, downloaded.error).toBe('completed')
        expect(downloaded.transferredSize).toBe(size)
        expect(fs.readFileSync(destination)).toEqual(binary)
        expect(sftpAttempts).toBe(0)
      }, 20000)
    }
  }
  it('错误指纹拒绝连接且不执行远端命令', async () => {
    const source = path.join(directory, 'source-base64-0')
    const before = commands
    const receipt = await request('/submit', { ...input('base64', 'upload', source), fingerprint: 'SHA256:' + 'a'.repeat(43) })
    const task = await finished(receipt.data.task.id)
    expect(task.state).toBe('failed')
    expect(task.error).toMatch(/verification|handshake/i)
    expect(commands).toBe(before)
  })
  it('忙状态拒绝第二任务，取消等 Worker 终止后才返回', async () => {
    const source = path.join(directory, 'source-base64-0')
    const receipt = await request('/submit', input('python', 'upload', source, '/fixture/hang'))
    expect(receipt.status).toBe(202)
    expect((await request('/submit', input('base64', 'upload', source))).status).toBe(409)
    expect((await request('/cancel', { taskId: 'wrong-task' })).status).toBe(409)
    const cancelled = await request('/cancel', { taskId: receipt.data.task.id })
    expect(cancelled.data.task.state).toBe('cancelled')
    expect((await request('/state')).data.task.state).toBe('cancelled')
  })
  it('安装包 activate 注册带实际端口的视图，deactivate 关闭服务', async () => {
    const plugin = require(path.join(installed, 'main.js'))
    let view: { connectOrigins: string[] } | undefined
    let removed = false
    await plugin.activate({ grantedCapabilities: ['read', 'execute', 'fileWrite', 'localExecute', 'uiControl'],
      registerView: async (value: typeof view) => { view = value }, unregisterView: async () => { removed = true } })
    expect(view?.connectOrigins[0]).toMatch(/^http:\/\/127.0.0.1:\d+$/)
    const generated = fs.readFileSync(path.join(installed, 'views/connection.js'), 'utf8')
    expect(generated).toMatch(/^window\.legacyTransferPort = \d+;\n$/)
    await plugin.deactivate()
    expect(removed).toBe(true)
    await expect(fetch(`${view!.connectOrigins[0]}/handshake`, { headers: { Origin: origin } })).rejects.toThrow()
    expect(tunnels).toBeGreaterThan(0)
  })

  it('内置管理器没有 SFTP 时明确失败，普通 SSH 命令仍能执行', async () => {
    const manager = new FileManager()
    manager.setGetSSHConfigFn(() => ({ host: '127.0.0.1', port, username: 'fixture', password: 'fixture-only' }))
    const before = commands
    try {
      await expect(manager.getConnector('fixture')).rejects.toThrow('SFTP 不可用')
      await expect(manager.upload('fixture', path.join(directory, 'source-base64-0'), '/fixture/no-transfer', 'upload')).rejects.toThrow('仅支持 SFTP')
      await expect(manager.download('fixture', '/fixture/no-transfer', path.join(directory, 'downloads', 'no-transfer'), 'download')).rejects.toThrow('仅支持 SFTP')
      expect(commands).toBe(before)
      const executor = await manager.getCommandConnector('fixture')
      expect(await executor.execRaw('ordinary-command')).toBe('ordinary-command-ok')
      expect(commands).toBe(before + 1)
      const chunks: string[] = []
      expect((await executor.execStream('ordinary-command', 1000, chunk => chunks.push(chunk))).output).toBe('ordinary-command-ok')
      expect(chunks.join('')).toBe('ordinary-command-ok')
    } finally { await manager.removeConnector('fixture') }
  })

  it('带进入命令的 SSH 会话仍支持普通命令与流式输出，不请求 SFTP', async () => {
    const manager = new FileManager()
    manager.setGetSSHConfigFn(() => ({ host: '127.0.0.1', port, username: 'fixture', password: 'fixture-only', shellEnterCommands: 'enter-fixture' }))
    const before = sftpAttempts
    try {
      const executor = await manager.getCommandConnector('shell-fixture')
      expect(await executor.execRaw('ordinary-command', 1000)).toBe('ordinary-command-ok')
      const chunks: string[] = []
      expect((await executor.execStream('ordinary-command', 1000, chunk => chunks.push(chunk))).output).toBe('ordinary-command-ok')
      expect(chunks.join('')).toContain('ordinary-command-ok')
      expect(sftpAttempts).toBe(before)
    } finally { await manager.removeConnector('shell-fixture') }
  })

  it('两个内置 Worker 拒绝 EXEC，且 SFTP 失败后不执行任何命令', async () => {
    for (const direction of ['upload', 'download']) {
      for (const method of ['sftp', 'exec']) {
        const before = commands
        const messages: Array<{ type: string; error?: string; message?: string }> = []
        const worker = new Worker(path.join(directory, 'builtin', `${direction}-worker.js`), { workerData: {
          taskId: 'builtin-test', sessionId: 'fixture', method,
          sshConfig: { host: '127.0.0.1', port, username: 'fixture', password: 'fixture-only' },
          localPath: path.join(directory, 'source-base64-0'), remotePath: '/fixture/no-transfer', fileSize: 0
        } })
        worker.on('message', message => messages.push(message))
        const code = await new Promise<number>(resolve => worker.on('exit', resolve))
        expect(code).toBe(1)
        expect(commands).toBe(before)
        expect(messages.some(message => /SFTP|only support/.test(message.error || message.message || ''))).toBe(true)
      }
    }
  })
})
