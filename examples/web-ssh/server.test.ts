/**
 * Web SSH 服务端真实回环集成测试。
 *
 * 这里不用 mock 换绿：
 * - HTTP / WS 都连真实 127.0.0.1 端口，负例用裸 TCP upgrade 覆盖 Host/Origin/协议/票据；
 * - SSH 侧起真实 ssh2.Server 夹具，由真实 ssh2.Client 完成 KEX、host-key、密码认证和 shell；
 * - 只有“迟到的 shell 回调”这类真实库无法稳定制造的竞态，才注入最小假 Client。
 */

import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Server as SshServer,
  utils as sshUtils,
  type Connection,
  type ConnectConfig,
  type ServerChannel
} from 'ssh2'
import { WebSocket } from 'ws'
import {
  startWebSshServer,
  type SshChannelLike,
  type SshClientLike,
  type WebSshServerHandle,
  type WebSshServerOptions
} from './server'

const SSH_USER = 'demo'
const SSH_PASSWORD = 'demo-pass'
const WS_PROTOCOL = 'lyshell-web-ssh'

// ====================== 通用工具 ======================

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error('condition not met in time')
}

/** 与协议一致的标准 OpenSSH SHA256 指纹（独立实现，不引用服务端内部函数）。 */
function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

/**
 * 生成 ssh2 自己能解析的 ed25519 主机密钥。
 * ssh2 1.17 的 generateKeyPairSync 偶发产出带 base64 padding 的 OpenSSH
 * 私钥/公钥，而它自己的解析器会以 “Malformed OpenSSH private key” 拒绝，
 * 因此这里按它自己的 parseKey 做校验并重试（概率极低）。
 */
function generateFixtureKeys(): { privateKey: string; publicKey: Buffer } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const keys = sshUtils.generateKeyPairSync('ed25519')
    const parsed = sshUtils.parseKey(keys.private)
    if (parsed instanceof Error) continue
    return { privateKey: keys.private, publicKey: parsed.getPublicSSH() }
  }
  throw new Error('failed to generate a parsable OpenSSH host key')
}

function makeHostKey(): Buffer {
  return generateFixtureKeys().publicKey
}

// ====================== 服务端/夹具生命周期 ======================

interface TestEnv {
  dir: string
  handle: WebSshServerHandle
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch {
      /* 清理失败不掩盖用例本身的失败 */
    }
  }
})

async function createEnv(options: Partial<WebSshServerOptions> = {}): Promise<TestEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'web-ssh-test-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>web ssh</title>', 'utf8')
  await writeFile(join(dir, 'terminal.js'), 'console.log("terminal")', 'utf8')
  await writeFile(join(dir, 'terminal.css'), 'body{margin:0}', 'utf8')
  await writeFile(join(dir, 'xterm.css'), '.xterm{}', 'utf8')
  let handle: WebSshServerHandle
  try {
    handle = await startWebSshServer({ assetsDir: dir, ...options })
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  cleanups.push(async () => {
    await handle.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, handle }
}

interface AuthAttempt {
  method: string
  username: string
  password?: string
  accepted: boolean
}

interface SshFixture {
  port: number
  publicKey: Buffer
  authAttempts: AuthAttempt[]
  readonly pty: { term: string; cols: number; rows: number } | null
  windowChanges: Array<{ cols: number; rows: number }>
  receivedLines: string[]
  readonly clientClosed: boolean
  emit(text: string): void
  rekey(): Promise<void>
  waitClientClosed(timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

async function createFixture(): Promise<SshFixture> {
  const keys = generateFixtureKeys()
  const publicKey = keys.publicKey

  const authAttempts: AuthAttempt[] = []
  const windowChanges: Array<{ cols: number; rows: number }> = []
  const receivedLines: string[] = []
  const clients: Connection[] = []
  const closedResolvers: Array<() => void> = []
  let channel: ServerChannel | null = null
  let pty: { term: string; cols: number; rows: number } | null = null
  let clientClosed = false
  let pendingLine = ''

  const notifyClosed = (): void => {
    clientClosed = true
    for (const resolve of closedResolvers.splice(0)) resolve()
  }

  const server = new SshServer({ hostKeys: [keys.privateKey] }, (client: Connection) => {
    clients.push(client)
    client.on('error', () => {
      /* 客户端断开时的常规错误 */
    })
    client.on('close', notifyClosed)
    client.on('authentication', (ctx) => {
      const attempt: AuthAttempt = {
        method: ctx.method,
        username: ctx.username,
        accepted: false
      }
      if (ctx.method === 'password') {
        const password = (ctx as { password?: string }).password
        attempt.password = password
        if (ctx.username === SSH_USER && password === SSH_PASSWORD) {
          attempt.accepted = true
          authAttempts.push(attempt)
          ctx.accept()
          return
        }
      }
      authAttempts.push(attempt)
      ctx.reject(['password'])
    })
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty, _rejectPty, info) => {
        pty = { term: info.term, cols: info.cols, rows: info.rows }
        acceptPty()
      })
      session.on('window-change', (acceptWindow, _rejectWindow, info) => {
        windowChanges.push({ cols: info.cols, rows: info.rows })
        if (typeof acceptWindow === 'function') acceptWindow()
      })
      session.on('shell', (acceptShell) => {
        const shellChannel = acceptShell()
        channel = shellChannel
        shellChannel.on('data', (data: Buffer) => {
          pendingLine += data.toString('utf8')
          for (;;) {
            const index = pendingLine.indexOf('\n')
            if (index < 0) break
            const line = pendingLine.slice(0, index).replace(/\r$/u, '')
            pendingLine = pendingLine.slice(index + 1)
            receivedLines.push(line)
            if (line.startsWith('emit:')) channel?.write(`${line.slice(5)}\n`)
            else channel?.write(`E:${line}\n`)
          }
        })
        shellChannel.on('close', () => {
          /* 保持夹具静默 */
        })
        shellChannel.on('error', () => {
          /* 保持夹具静默 */
        })
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture failed to bind loopback port')

  let closed = false
  const fixture: SshFixture = {
    port: address.port,
    publicKey,
    authAttempts,
    get pty() {
      return pty
    },
    windowChanges,
    receivedLines,
    get clientClosed() {
      return clientClosed
    },
    emit(text: string): void {
      if (!channel) throw new Error('fixture channel is not ready')
      channel.write(text)
    },
    rekey(): Promise<void> {
      return new Promise((resolve, reject) => {
        const client = clients.at(-1)
        if (!client) { reject(new Error('fixture client is not ready')); return }
        client.rekey(resolve)
      })
    },
    waitClientClosed(timeoutMs = 6_000): Promise<void> {
      if (clientClosed) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for SSH client close')), timeoutMs)
        closedResolvers.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      for (const client of clients) {
        try {
          client.end()
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  }
  cleanups.push(() => fixture.close())
  return fixture
}

// ====================== HTTP / WS 客户端 ======================

interface ServerMessage {
  type: string
  host?: string
  port?: number
  algorithm?: string
  fingerprint?: string
  connectionId?: string
  seq?: number
  data?: string
  nextSeq?: number
  message?: string
}

class WsClient {
  readonly messages: ServerMessage[] = []
  private readonly queue: ServerMessage[] = []
  private readonly waiters: Array<{
    pred: (message: ServerMessage) => boolean
    resolve: (message: ServerMessage) => void
    reject: (error: Error) => void
  }> = []
  private closed = false

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      let message: ServerMessage
      try {
        message = JSON.parse(raw.toString()) as ServerMessage
      } catch {
        return
      }
      this.messages.push(message)
      const index = this.waiters.findIndex((waiter) => waiter.pred(message))
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1)
        waiter?.resolve(message)
      } else {
        this.queue.push(message)
      }
    })
    socket.on('close', () => {
      this.closed = true
      // 关闭与消息可能在同一 tick 到达：先用已排队消息兑现等待者，再拒绝剩下的。
      for (const waiter of this.waiters.splice(0)) {
        const index = this.queue.findIndex(waiter.pred)
        if (index >= 0) {
          waiter.resolve(this.queue.splice(index, 1)[0] as ServerMessage)
          continue
        }
        waiter.reject(
          new Error(`websocket closed; pred=${waiter.pred.toString()}; seen=${JSON.stringify(this.messages)}`)
        )
      }
    })
    socket.on('error', () => {
      /* 关闭阶段的错误由 close 事件统一处理 */
    })
  }

  get protocol(): string {
    return this.socket.protocol
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value))
  }

  waitFor(type: string, timeoutMs = 8_000): Promise<ServerMessage> {
    return this.waitForMatch((message) => message.type === type, timeoutMs)
  }

  waitForMatch(pred: (message: ServerMessage) => boolean, timeoutMs = 8_000): Promise<ServerMessage> {
    const index = this.queue.findIndex(pred)
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0] as ServerMessage)
    return new Promise<ServerMessage>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const waiter = {
        pred,
        resolve: (message: ServerMessage): void => {
          if (timer) clearTimeout(timer)
          resolve(message)
        },
        reject: (error: Error): void => {
          if (timer) clearTimeout(timer)
          reject(error)
        }
      }
      timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter)
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)
        reject(new Error(`timeout waiting for message (${timeoutMs}ms); seen=${JSON.stringify(this.messages)}`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  waitForError(message: string, timeoutMs = 8_000): Promise<ServerMessage> {
    return this.waitForMatch((item) => item.type === 'error' && item.message === message, timeoutMs)
  }

  waitForData(text: string, timeoutMs = 8_000): Promise<ServerMessage> {
    return this.waitForMatch(
      (item) => item.type === 'data' && typeof item.data === 'string' && item.data.includes(text),
      timeoutMs
    )
  }

  waitForClose(timeoutMs = 8_000): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for websocket close')), timeoutMs)
      this.socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  terminate(): void {
    this.socket.terminate()
  }
}

async function getPage(origin: string): Promise<{ cookie: string; response: Response }> {
  const response = await fetch(`${origin}/`)
  expect(response.status).toBe(200)
  const setCookie = response.headers.getSetCookie()
  expect(setCookie.length).toBeGreaterThan(0)
  const cookie = (setCookie[0] as string).split(';')[0] as string
  await response.arrayBuffer()
  return { cookie, response }
}

async function getTicket(origin: string, cookie: string): Promise<string> {
  const response = await fetch(`${origin}/api/ticket`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie }
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { ticket?: unknown }
  expect(typeof body.ticket).toBe('string')
  return body.ticket as string
}

async function postDisconnect(
  origin: string,
  cookie: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(`${origin}/api/disconnect`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: response.status, json }
}

function openWs(origin: string, cookie: string, ticket: string): Promise<WsClient> {
  const url = `${origin.replace(/^http/u, 'ws')}/terminal`
  return new Promise<WsClient>((resolve, reject) => {
    const socket = new WebSocket(url, [WS_PROTOCOL, ticket], {
      headers: { Cookie: cookie, Origin: origin }
    })
    const client = new WsClient(socket)
    socket.once('open', () => resolve(client))
    socket.once('error', (err) => reject(err))
  })
}

interface RawUpgradeOptions {
  host?: string
  origin?: string
  cookie?: string
  protocols?: string[]
  path?: string
}

/** 裸 TCP WebSocket upgrade，用于覆盖被 ws 客户端隐藏的握手负例。 */
function rawUpgrade(port: number, options: RawUpgradeOptions = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const lines = [
      `GET ${options.path ?? '/terminal'} HTTP/1.1`,
      `Host: ${options.host ?? `127.0.0.1:${port}`}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13'
    ]
    if (options.origin !== undefined) lines.push(`Origin: ${options.origin}`)
    if (options.cookie !== undefined) lines.push(`Cookie: ${options.cookie}`)
    if (options.protocols) lines.push(`Sec-WebSocket-Protocol: ${options.protocols.join(', ')}`)
    const request = `${lines.join('\r\n')}\r\n\r\n`

    let text = ''
    socket.setEncoding('utf8')
    socket.setTimeout(4_000, () => socket.destroy())
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      text += chunk
    })
    socket.on('close', () => {
      const statusLine = text.split('\r\n')[0] ?? ''
      resolve({ status: Number(statusLine.split(' ')[1] ?? 0), text })
    })
    socket.on('error', reject)
  })
}

/** 裸 TCP HTTP 请求，用于真实设置非法 Host 头。 */
function rawHttp(port: number, head: string): Promise<{ status: number; headers: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    let text = ''
    socket.setEncoding('utf8')
    socket.setTimeout(4_000, () => socket.destroy())
    socket.on('connect', () => socket.write(head))
    socket.on('data', (chunk) => {
      text += chunk
    })
    socket.on('close', () => {
      const [statusLine = '', ...headerLines] = text.split('\r\n')
      const blank = headerLines.indexOf('')
      resolve({
        status: Number(statusLine.split(' ')[1] ?? 0),
        headers: headerLines.slice(0, blank >= 0 ? blank : headerLines.length).join('\n')
      })
    })
    socket.on('error', reject)
  })
}

// ====================== 测试用例 ======================

describe('本地 Web SSH 服务端', () => {
  it('多个本机网关的浏览器 cookie 可以共存', async () => {
    const first = await createEnv(), second = await createEnv()
    const a = await getPage(first.handle.origin), b = await getPage(second.handle.origin)
    expect(a.cookie.split('=')[0]).not.toBe(b.cookie.split('=')[0])
    const cookies = `${a.cookie}; ${b.cookie}`
    expect(await getTicket(first.handle.origin, cookies)).toBeTruthy()
    expect(await getTicket(second.handle.origin, cookies)).toBeTruthy()
  })
  it('跨站图片请求不能创建浏览器会话', async () => {
    const { handle } = await createEnv({maxSessions:1})
    const image = await rawHttp(handle.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nSec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: no-cors\r\nSec-Fetch-Dest: image\r\nConnection: close\r\n\r\n`)
    expect(image.status).toBe(403)
    const page = await getPage(handle.origin)
    expect(await getTicket(handle.origin, page.cookie)).toBeTruthy()
  })
  it('只在本机提供固定资源、cookie 与安全响应头', async () => {
    const { handle } = await createEnv()
    const { cookie, response } = await getPage(handle.origin)
    expect(cookie).toMatch(/^lyshell_web_ssh_\d+=[A-Za-z0-9_-]{43}$/u)
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("default-src 'none'")
    const setCookie = response.headers.getSetCookie()[0] ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')

    for (const [path, contentType] of [
      ['/terminal.js', 'text/javascript'],
      ['/terminal.css', 'text/css'],
      ['/xterm.css', 'text/css']
    ] as const) {
      const asset = await fetch(`${handle.origin}${path}`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain(contentType)
      await asset.arrayBuffer()
    }
    // xterm.js / fit.js 由 esbuild 打进 terminal.js，缺失时只是没有该路由。
    expect((await fetch(`${handle.origin}/xterm.js`)).status).toBe(404)
    expect((await fetch(`${handle.origin}/fit.js`)).status).toBe(404)
    expect((await fetch(`${handle.origin}/server.ts`)).status).toBe(404)

    // Host 必须精确等于 127.0.0.1:<port>。
    const wrongHost = await rawHttp(
      handle.port,
      'GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'
    )
    expect(wrongHost.status).toBe(403)

    // 票据接口只接受同源 POST + 有效 cookie。
    expect((await fetch(`${handle.origin}/api/ticket`)).status).toBe(405)
    expect((await fetch(`${handle.origin}/api/ticket`, { method: 'POST' })).status).toBe(403)
    const noCookie = await fetch(`${handle.origin}/api/ticket`, {
      method: 'POST',
      headers: { Origin: handle.origin }
    })
    expect(noCookie.status).toBe(401)
    expect(await noCookie.text()).toBe('unauthorized')
  }, 20_000)

  it('缺少必需资源时启动失败，但允许缺少可选的 xterm.js/fit.js', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-ssh-missing-'))
    try {
      await writeFile(join(dir, 'index.html'), '<!doctype html>', 'utf8')
      await writeFile(join(dir, 'terminal.css'), 'body{}', 'utf8')
      await writeFile(join(dir, 'xterm.css'), '.xterm{}', 'utf8')
      await expect(startWebSshServer({ assetsDir: dir })).rejects.toThrow(/missing asset for \/terminal.js/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('WS 握手严格校验 Host/Origin/协议/一次性票据与 cookie 归属', async () => {
    const { handle } = await createEnv()
    const a = await getPage(handle.origin)
    const b = await getPage(handle.origin)
    const ticketA = await getTicket(handle.origin, a.cookie)

    // 其他 cookie 的票据不能给本 cookie 用。
    expect(
      (await rawUpgrade(handle.port, { cookie: b.cookie, origin: handle.origin, protocols: [WS_PROTOCOL, ticketA] }))
        .status
    ).toBe(403)
    // Origin 必须是服务自身 origin。
    expect(
      (
        await rawUpgrade(handle.port, {
          cookie: a.cookie,
          origin: 'http://evil.test',
          protocols: [WS_PROTOCOL, ticketA]
        })
      ).status
    ).toBe(403)
    // Host 必须是 127.0.0.1:<port>。
    expect(
      (
        await rawUpgrade(handle.port, {
          host: 'evil.test',
          cookie: a.cookie,
          origin: handle.origin,
          protocols: [WS_PROTOCOL, ticketA]
        })
      ).status
    ).toBe(403)
    // 子协议必须是 ['lyshell-web-ssh', ticket]。
    expect(
      (await rawUpgrade(handle.port, { cookie: a.cookie, origin: handle.origin, protocols: ['other', ticketA] }))
        .status
    ).toBe(400)
    // 缺少 cookie。
    expect(
      (await rawUpgrade(handle.port, { origin: handle.origin, protocols: [WS_PROTOCOL, ticketA] })).status
    ).toBe(401)

    // 成功握手只协商 lyShell 协议，且票据立即作废。
    const client = await openWs(handle.origin, a.cookie, ticketA)
    expect(client.protocol).toBe(WS_PROTOCOL)
    // 尚未建立 SSH 连接时 disconnect 只回 closed，不主动断开 WS；这里直接收掉。
    client.terminate()
    await client.waitForClose()
    const reused = await rawUpgrade(handle.port, {
      cookie: a.cookie,
      origin: handle.origin,
      protocols: [WS_PROTOCOL, ticketA]
    })
    expect(reused.status).toBe(401)
  }, 20_000)

  it('票据短期有效：过期后拒绝升级', async () => {
    const { handle } = await createEnv({ ticketTtlMs: 40 })
    const page = await getPage(handle.origin)
    const ticket = await getTicket(handle.origin, page.cookie)
    await delay(120)
    const expired = await rawUpgrade(handle.port, {
      cookie: page.cookie,
      origin: handle.origin,
      protocols: [WS_PROTOCOL, ticket]
    })
    expect(expired.status).toBe(401)
  }, 20_000)

  it('真实 SSH：确认 host-key 前不认证，确认后密码登录并收到 shell 输出', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()
    const { cookie } = await getPage(handle.origin)
    const ticket = await getTicket(handle.origin, cookie)
    const client = await openWs(handle.origin, cookie, ticket)

    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD,
      cols: 100,
      rows: 30
    })
    const hostKey = await client.waitFor('host-key')
    expect(hostKey.algorithm).toBe('ssh-ed25519')
    expect(hostKey.fingerprint).toBe(fingerprintOf(fixture.publicKey))
    expect(hostKey.host).toBe('127.0.0.1')
    expect(hostKey.port).toBe(fixture.port)

    // 未确认前不得发起任何认证尝试。
    await delay(200)
    expect(fixture.authAttempts).toHaveLength(0)

    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    const ready = await client.waitFor('ready')
    expect(ready.connectionId).toMatch(/^[0-9a-f]{32}$/u)
    await waitUntil(() => fixture.authAttempts.some((attempt) => attempt.method === 'password'))
    const passwordAttempt = fixture.authAttempts.find((attempt) => attempt.method === 'password')
    expect(passwordAttempt).toMatchObject({
      method: 'password',
      username: SSH_USER,
      password: SSH_PASSWORD,
      accepted: true
    })

    await waitUntil(() => fixture.pty !== null)
    expect(fixture.pty).toMatchObject({ term: 'xterm-256color', cols: 100, rows: 30 })

    client.send({ type: 'input', data: 'hello\n' })
    const echoed = await client.waitForData('E:hello')
    expect(echoed.seq).toBe(1)
    expect(fixture.receivedLines).toContain('hello')

    // 输出 seq 单调递增。
    client.send({ type: 'input', data: 'second\n' })
    const second = await client.waitForData('E:second')
    expect(second.seq).toBeGreaterThan(echoed.seq as number)

    client.send({ type: 'disconnect' })
    const closed = await client.waitFor('closed')
    expect(closed.message).toBe('SSH session closed')
    await fixture.waitClientClosed()
  }, 25_000)

  it('同一 SSH 连接重新交换密钥时复用已确认的指纹，终端继续可用', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({ type: 'connect', host: '127.0.0.1', port: fixture.port, username: SSH_USER, password: SSH_PASSWORD })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    await client.waitFor('ready')
    await fixture.rekey()
    client.send({ type: 'input', data: 'after-rekey\n' })
    await client.waitForData('E:after-rekey')
    expect(client.messages.filter(message => message.type === 'host-key')).toHaveLength(1)
  }, 15_000)

  it('resize 夹取到合法范围，非法参数被拒绝', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()
    const page = await getPage(handle.origin)
    const ticket = await getTicket(handle.origin, page.cookie)
    const client = await openWs(handle.origin, page.cookie, ticket)
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    await client.waitFor('ready')

    client.send({ type: 'resize', cols: 0, rows: 5_000 })
    await waitUntil(() => fixture.windowChanges.length > 0)
    expect(fixture.windowChanges[0]).toEqual({ cols: 1, rows: 1_000 })

    client.send({ type: 'resize', cols: 'wide', rows: 24 })
    await client.waitForError('invalid resize parameters')
  }, 25_000)

  it('拒绝或指纹不匹配的 host-key 都不会继续认证', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()

    // 显式拒绝。
    const pageA = await getPage(handle.origin)
    const clientA = await openWs(handle.origin, pageA.cookie, await getTicket(handle.origin, pageA.cookie))
    clientA.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKeyA = await clientA.waitFor('host-key')
    clientA.send({ type: 'trust-host', fingerprint: hostKeyA.fingerprint, accept: false })
    await clientA.waitForError('host key not trusted')
    await clientA.waitForClose()
    expect(fixture.authAttempts).toHaveLength(0)

    // 指纹不一致按拒绝处理。
    const pageB = await getPage(handle.origin)
    const clientB = await openWs(handle.origin, pageB.cookie, await getTicket(handle.origin, pageB.cookie))
    clientB.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    await clientB.waitFor('host-key')
    clientB.send({ type: 'trust-host', fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', accept: true })
    await clientB.waitForError('host key fingerprint mismatch')
    await clientB.waitForClose()
    expect(fixture.authAttempts).toHaveLength(0)
  }, 25_000)

  it('错误密码返回认证失败，且不泄漏凭据或堆栈', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: 'wrong-password'
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    const error = await client.waitFor('error')
    expect(error.message).toBe('SSH authentication failed')
    expect(JSON.stringify(error)).not.toContain('wrong-password')
    expect(JSON.stringify(error)).not.toContain('stack')
    await client.waitForClose()
  }, 25_000)

  it('WS 断开后按 seq 续传输出，且不重放输入', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    const ready = await client.waitFor('ready')
    const connectionId = ready.connectionId as string

    client.send({ type: 'input', data: 'one\n' })
    const first = await client.waitForData('E:one')
    const inputCount = fixture.receivedLines.length

    // 模拟网络中断：直接 terminate，SSH 侧应保留在宽限期内。
    client.terminate()
    await client.waitForClose()
    expect(fixture.clientClosed).toBe(false)

    // 断开期间仍产生输出，写入环形缓冲。
    fixture.emit('after-drop\n')
    await delay(250)

    const client2 = await openWs(
      handle.origin,
      page.cookie,
      await getTicket(handle.origin, page.cookie)
    )
    client2.send({ type: 'resume', connectionId, lastSeq: first.seq })
    const ready2 = await client2.waitFor('ready')
    expect(ready2.connectionId).toBe(connectionId)
    const replayed = await client2.waitForData('after-drop')
    expect(replayed.seq).toBeGreaterThan(first.seq as number)
    expect(fixture.receivedLines.length).toBe(inputCount)

    // 同一个连接不能被第二个 WS 同时占用。
    const third = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    third.send({ type: 'resume', connectionId, lastSeq: replayed.seq as number })
    await third.waitForError('connection already attached')

    // 其他 cookie 不能 resume 本连接。
    const other = await getPage(handle.origin)
    const stranger = await openWs(handle.origin, other.cookie, await getTicket(handle.origin, other.cookie))
    stranger.send({ type: 'resume', connectionId, lastSeq: 0 })
    await stranger.waitForError('connection not available')
  }, 25_000)

  it('环形缓冲丢失旧 seq 时返回 gap 与正确的 nextSeq', async () => {
    const { handle } = await createEnv({ outputBufferBytes: 32 })
    const fixture = await createFixture()
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    const ready = await client.waitFor('ready')
    const connectionId = ready.connectionId as string

    client.terminate()
    await client.waitForClose()
    fixture.emit('z'.repeat(200))
    await delay(250)

    const client2 = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client2.send({ type: 'resume', connectionId, lastSeq: 1 })
    const gap = await client2.waitFor('gap')
    expect(gap.nextSeq).toBeGreaterThan(1)
    const replayed = await client2.waitFor('data')
    expect(replayed.seq).toBe(gap.nextSeq)
  }, 25_000)

  it('cookie 隔离：只能关闭自己 cookie 的，POST /api/disconnect 生效', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()
    const pageA = await getPage(handle.origin)
    const pageB = await getPage(handle.origin)
    const client = await openWs(handle.origin, pageA.cookie, await getTicket(handle.origin, pageA.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    const ready = await client.waitFor('ready')
    const connectionId = ready.connectionId as string
    client.send({ type: 'input', data: 'alive\n' })
    await client.waitForData('E:alive')

    // 方法/来源/cookie/body 校验。
    expect((await fetch(`${handle.origin}/api/disconnect`)).status).toBe(405)
    expect(
      (
        await fetch(`${handle.origin}/api/disconnect`, {
          method: 'POST',
          headers: { Cookie: pageA.cookie },
          body: '{}'
        })
      ).status
    ).toBe(403)
    expect(
      (
        await fetch(`${handle.origin}/api/disconnect`, {
          method: 'POST',
          headers: { Origin: handle.origin },
          body: '{}'
        })
      ).status
    ).toBe(401)
    expect((await postDisconnect(handle.origin, pageA.cookie, { connectionId: 'not-a-connection' })).status).toBe(400)
    expect((await postDisconnect(handle.origin, pageA.cookie, { connectionId: '0'.repeat(32) })).status).toBe(404)
    expect((await postDisconnect(handle.origin, pageA.cookie, {})).status).toBe(400)

    // 其他 cookie 不能关闭本连接，且连接仍然可用。
    const denied = await postDisconnect(handle.origin, pageB.cookie, { connectionId })
    expect(denied.status).toBe(403)
    expect(denied.json).toEqual({ ok: false, error: 'forbidden' })
    client.send({ type: 'input', data: 'still-here\n' })
    await client.waitForData('E:still-here')

    // 自己的 cookie 可以关闭，并收到 closed。
    const allowed = await postDisconnect(handle.origin, pageA.cookie, { connectionId })
    expect(allowed.status).toBe(200)
    expect(allowed.json).toEqual({ ok: true })
    const closed = await client.waitFor('closed')
    expect(closed.message).toBe('connection closed')
    await fixture.waitClientClosed()
  }, 25_000)

  it('WS 已经断开但 SSH 仍在保留期时，POST /api/disconnect 仍可关闭', async () => {
    const { handle } = await createEnv()
    const fixture = await createFixture()
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    const ready = await client.waitFor('ready')
    client.terminate()
    await client.waitForClose()
    expect(fixture.clientClosed).toBe(false)

    const result = await postDisconnect(handle.origin, page.cookie, { connectionId: ready.connectionId })
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ ok: true })
    await fixture.waitClientClosed()
  }, 25_000)

  it('close() 关闭 HTTP/WS 与保留期内的 SSH，且可重复调用', async () => {
    const fixture = await createFixture()
    const { handle } = await createEnv()
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: fixture.port,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    await client.waitFor('ready')

    // WS 先断开，SSH 进入保留期；close() 仍要回收它。
    client.terminate()
    await client.waitForClose()

    await Promise.all([handle.close(), handle.close()])
    await fixture.waitClientClosed()
    await expect(fetch(`${handle.origin}/`)).rejects.toThrow()
    await expect(handle.close()).resolves.toBeUndefined()
  }, 25_000)

  it('close() 同步回收仍在 1s 销毁定时器里的连接', async () => {
    const fake = new FakeClient(makeHostKey())
    fake.shellDelayMs = 0
    const { handle } = await createEnv({ createClient: () => fake as unknown as SshClientLike })
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: 22,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    await client.waitFor('ready')

    // disconnect 后连接进入 1s destroy 定时器，close() 不能只是等它。
    client.send({ type: 'disconnect' })
    await client.waitFor('closed')
    await handle.close()
    expect(fake.destroyed).toBe(true)
  }, 25_000)

  it('迟到的 shell 回调不会在关闭后写入连接', async () => {
    const fake = new FakeClient(makeHostKey())
    const { handle } = await createEnv({ createClient: () => fake as unknown as SshClientLike })
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: 22,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })

    // fake 在 connect() 内同步拿到凭据，服务端随后立即清除本地引用。
    await delay(60)
    expect(fake.connectSeenPassword).toBe(SSH_PASSWORD)
    expect(fake.config?.password).toBeUndefined()

    // shell 回调被延迟到 200ms 后，此时服务已经关闭。
    await handle.close()
    await delay(400)
    expect(fake.destroyed).toBe(true)
    expect(fake.channel?.closed).toBe(true)
    expect(client.messages.some((message) => message.type === 'ready')).toBe(false)
  }, 25_000)

  it('SSH 写入阻塞时限制输入积压并关闭连接，不接收后续输入', async () => {
    const fake = new FakeClient(makeHostKey())
    fake.shellDelayMs = 0
    const { handle } = await createEnv({ createClient: () => fake, maxBufferedBytes: 16 })
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({ type: 'connect', host: '127.0.0.1', port: 22, username: SSH_USER, password: SSH_PASSWORD })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    await client.waitFor('ready')
    fake.channel!.writableLength = 14
    client.send({ type: 'input', data: '中' })
    await client.waitForError('SSH input buffer full; input result is uncertain')
    await client.waitForClose()
    expect(fake.channel!.written).toEqual([])
  }, 15_000)

  it('已确认连接遇到不同主机密钥时拒绝，不沿用旧信任', async () => {
    const fake = new FakeClient(makeHostKey())
    fake.shellDelayMs = 0
    const { handle } = await createEnv({ createClient: () => fake })
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({ type: 'connect', host: '127.0.0.1', port: 22, username: SSH_USER, password: SSH_PASSWORD })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })
    await client.waitFor('ready')
    let accepted: boolean | undefined
    const verify = fake.config!.hostVerifier as (key: Buffer, callback: (valid: boolean) => void) => void
    verify(makeHostKey(), valid => { accepted = valid })
    expect(accepted).toBe(false)
    await client.waitForError('host key fingerprint mismatch')
    await client.waitForClose()
  }, 15_000)

  it('shell 就绪前拒绝输入，超长输入被拒绝', async () => {
    const fake = new FakeClient(makeHostKey())
    fake.shellDelayMs = 200
    const { handle } = await createEnv({ createClient: () => fake as unknown as SshClientLike })
    const page = await getPage(handle.origin)
    const client = await openWs(handle.origin, page.cookie, await getTicket(handle.origin, page.cookie))
    client.send({
      type: 'connect',
      host: '127.0.0.1',
      port: 22,
      username: SSH_USER,
      password: SSH_PASSWORD
    })
    const hostKey = await client.waitFor('host-key')
    client.send({ type: 'trust-host', fingerprint: hostKey.fingerprint, accept: true })

    // fake 的 session 回调尚未返回，连接还不是 ready。
    client.send({ type: 'input', data: 'too-early' })
    await client.waitForError('connection is not ready for input')

    await client.waitFor('ready')
    client.send({ type: 'input', data: 'x'.repeat(16_385) })
    await client.waitForError('invalid input')
    client.send({ type: 'input', data: '' })
    await client.waitForError('invalid input')
  }, 25_000)
})

// ====================== 最小假 Client（仅制造迟到的 shell 回调） ======================

class FakeChannel extends EventEmitter {
  writableLength = 0
  readonly written: string[] = []
  readonly windows: Array<{ rows: number; cols: number }> = []
  closed = false

  write(data: string | Buffer): boolean {
    this.written.push(data.toString())
    return true
  }

  setWindow(rows: number, cols: number, _height: number, _width: number): void {
    this.windows.push({ rows, cols })
  }

  end(): void {
    /* noop */
  }

  close(): void {
    this.closed = true
  }
}

class FakeClient extends EventEmitter {
  connectSeenPassword: string | undefined
  config: ConnectConfig | undefined
  channel: FakeChannel | null = null
  destroyed = false
  shellDelayMs = 200

  constructor(private readonly hostKey: Buffer) {
    super()
  }

  connect(config: ConnectConfig): void {
    this.config = config
    this.connectSeenPassword = config.password
    const verifier = config.hostVerifier as (key: Buffer, verify: (valid: boolean) => void) => void
    verifier(this.hostKey, (valid) => {
      if (!valid) return
      setTimeout(() => this.emit('ready'), 10)
    })
  }

  shell(
    _window: { term?: string; cols?: number; rows?: number },
    callback: (err: Error | undefined, channel: SshChannelLike) => void
  ): this {
    setTimeout(() => {
      const channel = new FakeChannel()
      this.channel = channel
      callback(undefined, channel as unknown as SshChannelLike)
    }, this.shellDelayMs)
    return this
  }

  end(): this {
    return this
  }

  destroy(): void {
    this.destroyed = true
  }
}
