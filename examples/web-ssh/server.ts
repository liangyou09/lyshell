/**
 * 本地 Web SSH 插件服务端。
 *
 * 设计约束（与 tmp/web-ssh-plugin/backend-task.md 对齐）：
 * - 监听 0.0.0.0 随机端口，允许通过本机 IPv4 地址访问。
 * - HTTP 只提供固定路由；WS 票据一次性、短期、只在子协议头里。
 * - SSH 凭据只存在于单次 connect 调用的局部对象中，不写日志/磁盘/URL。
 * - 断网后 SSH 保留最多 60 秒，输出环形缓冲 1 MiB，按 seq 续传；不重放输入。
 * - 本文件不安装进程级信号监听、不调用 process.exit —— 服务运行在共享 pluginHost 里。
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Client as Ssh2Client, type ConnectConfig } from 'ssh2'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

// ====================== 对外类型 ======================

/** ssh2.Client 的最小结构化接口；测试可注入同形状 mock。 */
export interface SshClientLike {
  on(event: 'ready' | 'close', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  connect(config: ConnectConfig): void
  shell(
    window: { term?: string; cols?: number; rows?: number },
    callback: (err: Error | undefined, channel: SshChannelLike) => void
  ): this
  end(): this
  destroy(): void
}

/** ssh2 ClientChannel 的最小结构化接口。 */
export interface SshChannelLike {
  readonly writableLength?: number
  on(event: 'data', listener: (data: Buffer | string) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  write(data: string | Buffer): boolean
  setWindow(rows: number, cols: number, height: number, width: number): void
  end(): void
  close?: () => void
  destroy?: () => void
}

export interface WebSshServerOptions {
  /** 打包后的 web/ 目录；只读取固定文件名。 */
  assetsDir: string
  /** 仅供测试注入；缺省 new ssh2.Client()。 */
  createClient?: () => SshClientLike

  // 以下均为可选测试/调优参数，保持 startWebSshServer 的调用形态不变。
  hostKeyTimeoutMs?: number
  resumeGraceMs?: number
  ticketTtlMs?: number
  outputBufferBytes?: number
  maxConnectionsPerSession?: number
  maxTotalConnections?: number
  maxSessions?: number
  maxTicketsPerSession?: number
  maxSocketsPerSession?: number
  maxTotalSockets?: number
  maxBufferedBytes?: number
  heartbeatIntervalMs?: number
  sessionIdleMs?: number
  sshReadyTimeoutMs?: number
  sshKeepaliveIntervalMs?: number
  maxWsPayloadBytes?: number
}

export interface WebSshServerHandle {
  port: number
  origin: string
  close(): Promise<void>
}

// ====================== 常量 ======================

const COOKIE_NAME = 'lyshell_web_ssh'
const SESSION_ID_RE = /^[A-Za-z0-9_-]{32,64}$/
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/
const WS_PROTOCOL = 'lyshell-web-ssh'
const WS_PATH = '/terminal'
const TICKET_PATH = '/api/ticket'
const DISCONNECT_PATH = '/api/disconnect'

const MAX_REQUEST_BODY = 1024
const MAX_CONTROL_TEXT = 256
const MAX_PASSWORD_LEN = 4096
const MAX_PRIVATE_KEY_LEN = 65536
const MAX_INPUT_CHARS = 16384
const MAX_TERMINAL_DIM = 1000
const MAX_DATA_CHUNK_BYTES = 16 * 1024
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const MAX_CONNECTION_ID_LEN = 64
const CONNECTION_ID_RE = /^[0-9a-f]{32}$/

/**
 * 固定路由白名单，绝不接受任意路径。
 * xterm.js / fit.js 在构建时被 esbuild 打进 terminal.js，因此是可选的；
 * 只有 index.html、terminal.js、terminal.css、xterm.css 缺失时才算启动失败。
 */
const STATIC_ASSETS: ReadonlyArray<
  readonly [route: string, file: string, contentType: string, optional?: boolean]
> = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/terminal.js', 'terminal.js', 'text/javascript; charset=utf-8'],
  ['/terminal.css', 'terminal.css', 'text/css; charset=utf-8'],
  ['/xterm.css', 'xterm.css', 'text/css; charset=utf-8'],
  ['/xterm.js', 'xterm.js', 'text/javascript; charset=utf-8', true],
  ['/fit.js', 'fit.js', 'text/javascript; charset=utf-8', true]
]

const ERR = {
  badRequest: 'bad request',
  forbidden: 'forbidden',
  notFound: 'not found',
  methodNotAllowed: 'method not allowed',
  payloadTooLarge: 'payload too large',
  unauthorized: 'unauthorized',
  tooManyRequests: 'too many requests',
  serverBusy: 'server busy',
  serverClosing: 'server closing',
  invalidMessage: 'invalid message',
  invalidConnect: 'invalid connect parameters',
  connectionLimit: 'connection limit reached',
  connectionExists: 'connection already exists',
  connectionUnavailable: 'connection not available',
  connectionAttached: 'connection already attached',
  connectionClosed: 'connection closed',
  hostKeyRejected: 'host key not trusted',
  hostKeyMismatch: 'host key fingerprint mismatch',
  hostKeyTimeout: 'host key verification timed out',
  sshFailed: 'SSH connection failed',
  sshAuthFailed: 'SSH authentication failed',
  sshTimeout: 'SSH connection timed out',
  shellFailed: 'SSH shell unavailable',
  channelFailed: 'SSH channel failed',
  sshClosed: 'SSH connection closed',
  shellClosed: 'SSH session closed',
  invalidInput: 'invalid input',
  inputBufferFull: 'SSH input buffer full; input result is uncertain',
  inputNotReady: 'connection is not ready for input',
  invalidResize: 'invalid resize parameters',
  notReady: 'connection is not ready',
  binaryNotAllowed: 'binary messages are not supported',
  unknownMessage: 'unknown message type'
} as const

// ====================== 内部类型 ======================

interface Session {
  id: string
  createdAt: number
  lastSeenAt: number
  tickets: Set<string>
  connections: Set<SshConnection>
  sockets: Set<WsState>
}

interface TicketRecord {
  sessionId: string
  expiresAt: number
}

interface HostKeyPrompt {
  algorithm: string
  fingerprint: string
  verify: (valid: boolean) => void
}

interface OutputChunk {
  seq: number
  data: string
  bytes: number
}

type ConnectionState = 'connecting' | 'awaiting-trust' | 'authenticating' | 'ready' | 'closed'

interface SshConnection {
  id: string
  session: Session
  client: SshClientLike
  ws: WsState | null
  state: ConnectionState
  host: string
  port: number
  username: string
  cols: number
  rows: number
  trusted: boolean
  trustedFingerprint: string | null
  shellStarted: boolean
  channel: SshChannelLike | null
  decoder: StringDecoder | null
  seq: number
  ring: OutputChunk[]
  ringBytes: number
  hostKey: HostKeyPrompt | null
  hostKeyTimer: NodeJS.Timeout | null
  graceTimer: NodeJS.Timeout | null
  destroyTimer: NodeJS.Timeout | null
  closed: boolean
  destroyed: boolean
}

interface WsState {
  ws: WebSocket
  session: Session
  conn: SshConnection | null
  alive: boolean
  heartbeat: NodeJS.Timeout | null
  closed: boolean
}

interface ConnectParams {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  cols: number
  rows: number
}

interface StaticAsset {
  contentType: string
  body: Buffer
}

type ServerMessage =
  | { type: 'host-key'; host: string; port: number; algorithm: string; fingerprint: string }
  | { type: 'ready'; connectionId: string }
  | { type: 'data'; seq: number; data: string }
  | { type: 'gap'; nextSeq: number }
  | { type: 'closed'; message: string }
  | { type: 'error'; message: string }

class BodyTooLargeError extends Error {}

// ====================== 工具 ======================

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!key || out.has(key)) continue
    out.set(key, value)
  }
  return out
}

function isBotControlFree(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0 || code === 10 || code === 13) return false
  }
  return true
}

function isPlainText(value: unknown, maxLen: number, allowWhitespace: boolean): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) return false
  if (!allowWhitespace) return isBotControlFree(value)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0) return false
  }
  return true
}

function hostKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const len = key.readUInt32BE(0)
  if (len <= 0 || len > 128 || len > key.length - 4) return 'unknown'
  const name = key.subarray(4, 4 + len).toString('ascii')
  return /^[A-Za-z0-9@._+-]+$/.test(name) ? name : 'unknown'
}

/** 标准 OpenSSH SHA256 指纹：`SHA256:` + 无 padding base64。 */
function hostKeyFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')
  return `SHA256:${digest}`
}

function splitUtf8(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text.length > 0 ? [text] : []
  const parts: string[] = []
  let current = ''
  let currentBytes = 0
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (currentBytes > 0 && currentBytes + bytes > maxBytes) {
      parts.push(current)
      current = ''
      currentBytes = 0
    }
    current += char
    currentBytes += bytes
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

async function loadAssets(dir: string): Promise<Map<string, StaticAsset>> {
  const out = new Map<string, StaticAsset>()
  for (const [route, file, contentType, optional] of STATIC_ASSETS) {
    let body: Buffer
    try {
      body = await readFile(join(dir, file))
    } catch (err) {
      // 可选资源缺失时只是不注册该路由；必需资源缺失则启动失败。
      if (optional === true && (err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`web-ssh: missing asset for ${route}`)
    }
    if (body.byteLength > MAX_ASSET_BYTES) throw new Error(`web-ssh: asset too large for ${route}`)
    out.set(route, { contentType, body })
  }
  return out
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = (): void => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      if (total > limit) {
        fail(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (err: Error): void => fail(err)
    const onAborted = (): void => fail(new Error('request aborted'))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

function cancelTimer(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer)
  return null
}

// ====================== 服务端实现 ======================

export async function startWebSshServer(options: WebSshServerOptions): Promise<WebSshServerHandle> {
  if (typeof options?.assetsDir !== 'string' || options.assetsDir.length === 0) {
    throw new Error('web-ssh: assetsDir is required')
  }

  const assets = await loadAssets(options.assetsDir)
  const createClient: () => SshClientLike =
    options.createClient ?? (() => new Ssh2Client() as unknown as SshClientLike)

  const hostKeyTimeoutMs = positiveInt(options.hostKeyTimeoutMs, 30_000)
  const resumeGraceMs = positiveInt(options.resumeGraceMs, 60_000)
  const ticketTtlMs = positiveInt(options.ticketTtlMs, 30_000)
  const outputBufferBytes = positiveInt(options.outputBufferBytes, 1024 * 1024)
  const maxConnectionsPerSession = positiveInt(options.maxConnectionsPerSession, 4)
  const maxTotalConnections = positiveInt(options.maxTotalConnections, 8)
  const maxSessions = positiveInt(options.maxSessions, 64)
  const maxTicketsPerSession = positiveInt(options.maxTicketsPerSession, 8)
  const maxSocketsPerSession = positiveInt(options.maxSocketsPerSession, 8)
  const maxTotalSockets = positiveInt(options.maxTotalSockets, 32)
  const maxBufferedBytes = positiveInt(options.maxBufferedBytes, 1024 * 1024)
  const heartbeatIntervalMs = positiveInt(options.heartbeatIntervalMs, 15_000)
  const sessionIdleMs = positiveInt(options.sessionIdleMs, 30 * 60_000)
  const sshReadyTimeoutMs = positiveInt(options.sshReadyTimeoutMs, 20_000)
  const sshKeepaliveIntervalMs = positiveInt(options.sshKeepaliveIntervalMs, 15_000)
  const maxWsPayloadBytes = positiveInt(options.maxWsPayloadBytes, 128 * 1024)
  const chunkBytes = Math.max(1, Math.min(MAX_DATA_CHUNK_BYTES, outputBufferBytes))

  const sessions = new Map<string, Session>()
  const tickets = new Map<string, TicketRecord>()
  const connections = new Map<string, SshConnection>()
  // 包括已经 closed、等待 destroy 定时器回收的连接，确保 close() 能取消这些计时器。
  const allConnections = new Set<SshConnection>()
  const wsStates = new Set<WsState>()

  let port = 0
  let origin = ''
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0', hostname().toLowerCase()])
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === 'IPv4') allowedHosts.add(address.address)
    }
  }
  let closing = false
  let closePromise: Promise<void> | null = null
  let purgeTimer: NodeJS.Timeout | null = null
  let sessionPurgeTimer: NodeJS.Timeout | null = null

  // ---------- HTTP 基础 ----------

  function baseHeaders(): Record<string, string> {
    return {
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src 'self' ${Array.from(allowedHosts, host => `ws://${host}:${port}`).join(' ')}`,
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
      ].join('; '),
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache'
    }
  }

  function sendText(
    res: ServerResponse,
    status: number,
    body: string,
    extraHeaders: Record<string, string> = {}
  ): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const buffer = Buffer.from(body, 'utf8')
    const headers: Record<string, string | number> = {
      ...baseHeaders(),
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buffer.byteLength,
      Connection: 'close',
      ...extraHeaders
    }
    res.writeHead(status, headers)
    res.end(buffer)
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    value: unknown,
    extraHeaders: Record<string, string> = {}
  ): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const buffer = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, {
      ...baseHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buffer.byteLength,
      ...extraHeaders
    })
    res.end(buffer)
  }

  function hostMatches(req: IncomingMessage): boolean {
    if (port <= 0 || typeof req.headers.host !== 'string') return false
    const suffix = `:${port}`
    const host = req.headers.host.toLowerCase()
    return host.endsWith(suffix) && allowedHosts.has(host.slice(0, -suffix.length))
  }

  function originMatches(req: IncomingMessage): boolean {
    return hostMatches(req) && typeof req.headers.origin === 'string' &&
      req.headers.origin.toLowerCase() === `http://${req.headers.host?.toLowerCase()}`
  }

  function sessionFromRequest(req: IncomingMessage): Session | null {
    const cookie = parseCookies(req.headers.cookie).get(`${COOKIE_NAME}_${port}`)
    if (!cookie || !SESSION_ID_RE.test(cookie)) return null
    const session = sessions.get(cookie)
    if (!session) return null
    const now = Date.now()
    session.lastSeenAt = now
    return session
  }

  function createSession(): Session {
    const id = randomBytes(32).toString('base64url')
    const session: Session = {
      id,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      tickets: new Set<string>(),
      connections: new Set<SshConnection>(),
      sockets: new Set<WsState>()
    }
    sessions.set(id, session)
    return session
  }

  function sessionCookie(id: string): string {
    // Cookie 不按端口隔离。插件与独立网关同时运行时，名称也必须带端口。
    return `${COOKIE_NAME}_${port}=${id}; Path=/; HttpOnly; SameSite=Strict`
  }

  function purgeExpiredTickets(): void {
    const now = Date.now()
    for (const [ticket, record] of tickets) {
      if (record.expiresAt <= now) {
        tickets.delete(ticket)
        const session = sessions.get(record.sessionId)
        session?.tickets.delete(ticket)
      }
    }
  }

  function purgeIdleSessions(): void {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (session.connections.size > 0 || session.sockets.size > 0) continue
      if (now - session.lastSeenAt <= sessionIdleMs) continue
      sessions.delete(id)
      for (const ticket of session.tickets) tickets.delete(ticket)
    }
  }

  /** 读取 POST 的受限 body；失败时已经写好响应并返回 null。 */
  async function readSmallBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
    const contentLength = req.headers['content-length']
    if (contentLength !== undefined) {
      const length = Number(contentLength)
      if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BODY) {
        sendText(res, 413, ERR.payloadTooLarge)
        req.resume()
        return null
      }
    }
    try {
      return await readBody(req, MAX_REQUEST_BODY)
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendText(res, 413, ERR.payloadTooLarge)
        req.resume()
        return null
      }
      sendText(res, 400, ERR.badRequest)
      return null
    }
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) {
      sendText(res, 503, ERR.serverClosing)
      return
    }
    if (!hostMatches(req)) {
      sendText(res, 403, ERR.forbidden)
      return
    }
    // 拒绝跨站子资源请求，避免任意网页耗尽首次访问的会话配额。
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') {
      sendText(res, 403, ERR.forbidden)
      return
    }
    if (!req.url || req.url.includes('?') || req.url.includes('#')) {
      sendText(res, 404, ERR.notFound)
      return
    }

    if (req.url === TICKET_PATH) {
      if (req.method !== 'POST') {
        sendText(res, 405, ERR.methodNotAllowed, { Allow: 'POST' })
        return
      }
      if (!originMatches(req)) {
        sendText(res, 403, ERR.forbidden)
        return
      }
      const session = sessionFromRequest(req)
      if (!session) {
        sendText(res, 401, ERR.unauthorized)
        return
      }
      if ((await readSmallBody(req, res)) === null) return
      purgeExpiredTickets()
      if (session.tickets.size >= maxTicketsPerSession) {
        sendText(res, 429, ERR.tooManyRequests)
        return
      }
      const ticket = randomBytes(32).toString('base64url')
      tickets.set(ticket, { sessionId: session.id, expiresAt: Date.now() + ticketTtlMs })
      session.tickets.add(ticket)
      sendJson(res, 200, { ticket })
      return
    }

    // 显式关闭：WS 已断开（SSH 仍在 60 秒保留期内）时页面也能释放连接。
    // 只允许当前 cookie 拥有的连接，其他会话一律拒绝。
    if (req.url === DISCONNECT_PATH) {
      if (req.method !== 'POST') {
        sendText(res, 405, ERR.methodNotAllowed, { Allow: 'POST' })
        return
      }
      if (!originMatches(req)) {
        sendText(res, 403, ERR.forbidden)
        return
      }
      const session = sessionFromRequest(req)
      if (!session) {
        sendText(res, 401, ERR.unauthorized)
        return
      }
      const body = await readSmallBody(req, res)
      if (body === null) return
      let connectionId: unknown
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          sendText(res, 400, ERR.badRequest)
          return
        }
        connectionId = (parsed as Record<string, unknown>).connectionId
      } catch {
        sendText(res, 400, ERR.badRequest)
        return
      }
      if (typeof connectionId !== 'string' || !CONNECTION_ID_RE.test(connectionId)) {
        sendText(res, 400, ERR.badRequest)
        return
      }
      const conn = connections.get(connectionId)
      if (!conn) {
        sendJson(res, 404, { ok: false, error: ERR.connectionUnavailable })
        return
      }
      if (conn.session !== session) {
        sendJson(res, 403, { ok: false, error: ERR.forbidden })
        return
      }
      sendJson(res, 200, { ok: true })
      closeConnection(conn, {
        notify: { type: 'closed', message: ERR.connectionClosed },
        closeWs: true
      })
      return
    }

    const asset = assets.get(req.url)
    if (!asset) {
      sendText(res, 404, ERR.notFound)
      return
    }
    if (req.method !== 'GET') {
      sendText(res, 405, ERR.methodNotAllowed, { Allow: 'GET' })
      return
    }

    let session: Session | null = null
    let issueCookie = false
    if (req.url === '/') {
      session = sessionFromRequest(req)
      if (!session) {
        if (sessions.size >= maxSessions) {
          sendText(res, 503, ERR.serverBusy)
          return
        }
        session = createSession()
        issueCookie = true
      }
    }

    const headers: Record<string, string | number> = {
      ...baseHeaders(),
      'Content-Type': asset.contentType,
      'Content-Length': asset.body.byteLength
    }
    if (issueCookie && session) headers['Set-Cookie'] = sessionCookie(session.id)
    res.writeHead(200, headers)
    res.end(asset.body)
  }

  // ---------- HTTP 服务 ----------

  const httpServer: HttpServer = createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'internal error')
      else res.destroy()
    })
  })
  httpServer.headersTimeout = 10_000
  httpServer.requestTimeout = 15_000
  httpServer.keepAliveTimeout = 5_000
  httpServer.maxHeadersCount = 64
  httpServer.on('clientError', (_err, socket) => {
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
  })

  // ---------- WS 服务 ----------

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxWsPayloadBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols: Set<string>) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false)
  })
  wss.on('error', () => {
    /* 由连接级错误处理，避免未捕获的 EventEmitter error */
  })

  function rejectUpgrade(socket: import('node:stream').Duplex, status: number, message: string): void {
    if (socket.destroyed) return
    try {
      if (socket.writable) {
        const body = Buffer.from(message, 'utf8')
        socket.write(
          `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : 'Bad Request'}\r\n` +
            'Connection: close\r\n' +
            'Content-Type: text/plain; charset=utf-8\r\n' +
            `Content-Length: ${body.byteLength}\r\n` +
            'Cache-Control: no-store\r\n' +
            '\r\n'
        )
        socket.write(body)
      }
    } catch {
      /* ignore */
    }
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
  }

  function onUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    socket.on('error', () => {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })

    if (closing) {
      rejectUpgrade(socket, 503, ERR.serverClosing)
      return
    }
    if (!hostMatches(req)) {
      rejectUpgrade(socket, 403, ERR.forbidden)
      return
    }
    if (req.url !== WS_PATH) {
      rejectUpgrade(socket, 400, ERR.badRequest)
      return
    }
    if (!originMatches(req)) {
      rejectUpgrade(socket, 403, ERR.forbidden)
      return
    }

    const rawProtocols = req.headers['sec-websocket-protocol']
    const protocols =
      typeof rawProtocols === 'string'
        ? rawProtocols
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
        : []
    if (protocols.length !== 2 || protocols[0] !== WS_PROTOCOL || !TICKET_RE.test(protocols[1] ?? '')) {
      rejectUpgrade(socket, 400, ERR.badRequest)
      return
    }
    const ticket = protocols[1] as string

    const session = sessionFromRequest(req)
    if (!session) {
      rejectUpgrade(socket, 401, ERR.unauthorized)
      return
    }
    const record = tickets.get(ticket)
    const now = Date.now()
    if (!record || record.expiresAt <= now) {
      if (record) {
        tickets.delete(ticket)
        sessions.get(record.sessionId)?.tickets.delete(ticket)
      }
      rejectUpgrade(socket, 401, ERR.unauthorized)
      return
    }
    if (record.sessionId !== session.id) {
      rejectUpgrade(socket, 403, ERR.forbidden)
      return
    }
    // 一次性：在同步段内删除，两个并发 upgrade 不可能都拿到。
    tickets.delete(ticket)
    session.tickets.delete(ticket)

    if (session.sockets.size >= maxSocketsPerSession || wsStates.size >= maxTotalSockets) {
      rejectUpgrade(socket, 429, ERR.tooManyRequests)
      return
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachSocket(ws, session)
      })
    } catch {
      rejectUpgrade(socket, 400, ERR.badRequest)
    }
  }

  httpServer.on('upgrade', onUpgrade)

  // ---------- WS 生命周期 ----------

  function attachSocket(ws: WebSocket, session: Session): void {
    const state: WsState = {
      ws,
      session,
      conn: null,
      alive: true,
      heartbeat: null,
      closed: false
    }
    wsStates.add(state)
    session.sockets.add(state)

    ws.on('pong', () => {
      state.alive = true
    })
    ws.on('message', (data: RawData, isBinary: boolean) => {
      try {
        onWsMessage(state, data, isBinary)
      } catch {
        protocolAbort(state, ERR.badRequest)
      }
    })
    ws.on('error', () => {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      detachSocket(state)
    })
    ws.on('close', () => detachSocket(state))

    state.heartbeat = setInterval(() => {
      if (state.closed) return
      if (!state.alive) {
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
        return
      }
      state.alive = false
      try {
        ws.ping()
      } catch {
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
      }
    }, heartbeatIntervalMs)
    state.heartbeat.unref()
  }

  function detachSocket(state: WsState): void {
    if (state.closed) return
    state.closed = true
    wsStates.delete(state)
    state.session.sockets.delete(state)
    if (state.heartbeat) {
      clearInterval(state.heartbeat)
      state.heartbeat = null
    }
    const conn = state.conn
    state.conn = null
    if (conn && conn.ws === state) conn.ws = null
    if (!conn || conn.closed) return
    if (conn.state === 'ready') {
      conn.graceTimer = setTimeout(() => {
        conn.graceTimer = null
        closeConnection(conn, {})
      }, resumeGraceMs)
      conn.graceTimer.unref()
      return
    }
    // 尚未 ready 的连接客户端拿不到 connectionId，无法 resume，直接回收。
    closeConnection(conn, {})
  }

  function send(ws: WebSocket, message: ServerMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  function sendToConnection(conn: SshConnection, message: ServerMessage): boolean {
    const state = conn.ws
    if (!state || state.closed) return false
    return send(state.ws, message)
  }

  function sendError(conn: SshConnection, message: string): void {
    sendToConnection(conn, { type: 'error', message })
  }

  function sendDataNow(conn: SshConnection, chunk: OutputChunk): void {
    const state = conn.ws
    if (!state || state.closed) return
    if (state.ws.readyState !== WebSocket.OPEN) return
    if (state.ws.bufferedAmount > maxBufferedBytes) {
      // 慢客户端：断开 WS 但保留 SSH，等待 resume。
      try {
        state.ws.terminate()
      } catch {
        /* ignore */
      }
      return
    }
    send(state.ws, { type: 'data', seq: chunk.seq, data: chunk.data })
  }

  function protocolAbort(state: WsState, message: string): void {
    if (state.closed) return
    if (state.ws.readyState === WebSocket.OPEN) {
      send(state.ws, { type: 'error', message })
      try {
        state.ws.close(1008, 'protocol error')
      } catch {
        /* ignore */
      }
    } else {
      try {
        state.ws.terminate()
      } catch {
        /* ignore */
      }
    }
    const conn = state.conn
    if (conn && !conn.closed) closeConnection(conn, {})
  }

  // ---------- 消息分派 ----------

  function onWsMessage(state: WsState, raw: RawData, isBinary: boolean): void {
    if (state.closed) return
    if (isBinary) {
      protocolAbort(state, ERR.binaryNotAllowed)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawDataToString(raw))
    } catch {
      protocolAbort(state, ERR.invalidMessage)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      protocolAbort(state, ERR.invalidMessage)
      return
    }
    const msg = parsed as Record<string, unknown>
    const type = msg.type
    if (typeof type !== 'string') {
      protocolAbort(state, ERR.invalidMessage)
      return
    }
    switch (type) {
      case 'connect':
        handleConnect(state, msg)
        break
      case 'trust-host':
        handleTrustHost(state, msg)
        break
      case 'resume':
        handleResume(state, msg)
        break
      case 'input':
        handleInput(state, msg)
        break
      case 'resize':
        handleResize(state, msg)
        break
      case 'disconnect':
        handleDisconnect(state)
        break
      default:
        protocolAbort(state, ERR.unknownMessage)
    }
  }

  function parseConnect(msg: Record<string, unknown>): ConnectParams | null {
    const host = msg.host
    const portValue = msg.port
    const username = msg.username
    if (typeof host !== 'string' || host.length === 0 || host.length > 255) return null
    if (!isBotControlFree(host) || /\s/u.test(host) || host.includes('/') || host.includes('\\')) return null
    if (typeof portValue !== 'number' || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
      return null
    }
    if (!isPlainText(username, MAX_CONTROL_TEXT, false)) return null
    if (!isBotControlFree(username)) return null

    const optional = (key: 'password' | 'privateKey' | 'passphrase', max: number): string | undefined | null => {
      const value = msg[key]
      if (value === undefined) return undefined
      if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
      for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 0) return null
      }
      return value
    }
    const password = optional('password', MAX_PASSWORD_LEN)
    const privateKey = optional('privateKey', MAX_PRIVATE_KEY_LEN)
    const passphrase = optional('passphrase', MAX_PASSWORD_LEN)
    if (password === null || privateKey === null || passphrase === null) return null
    if (privateKey === undefined && password === undefined) {
      // 允许 none 认证，但不允许空凭据字段。
      if (msg.password === '' || msg.privateKey === '') return null
    }

    const dimension = (value: unknown, fallback: number): number | null => {
      if (value === undefined) return fallback
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TERMINAL_DIM) {
        return null
      }
      return value
    }
    const cols = dimension(msg.cols, 80)
    const rows = dimension(msg.rows, 24)
    if (cols === null || rows === null) return null

    return { host, port: portValue, username: username as string, password, privateKey, passphrase, cols, rows }
  }

  function handleConnect(state: WsState, msg: Record<string, unknown>): void {
    if (state.conn && !state.conn.closed) {
      send(state.ws, { type: 'error', message: ERR.connectionExists })
      return
    }
    const params = parseConnect(msg)
    if (!params) {
      send(state.ws, { type: 'error', message: ERR.invalidConnect })
      return
    }
    if (
      state.session.connections.size >= maxConnectionsPerSession ||
      connections.size >= maxTotalConnections
    ) {
      send(state.ws, { type: 'error', message: ERR.connectionLimit })
      return
    }
    let client: SshClientLike
    try {
      client = createClient()
    } catch {
      send(state.ws, { type: 'error', message: ERR.sshFailed })
      return
    }

    const conn: SshConnection = {
      id: randomBytes(16).toString('hex'),
      session: state.session,
      client,
      ws: null,
      state: 'connecting',
      host: params.host,
      port: params.port,
      username: params.username,
      cols: params.cols,
      rows: params.rows,
      trusted: false,
      trustedFingerprint: null,
      shellStarted: false,
      channel: null,
      decoder: null,
      seq: 1,
      ring: [],
      ringBytes: 0,
      hostKey: null,
      hostKeyTimer: null,
      graceTimer: null,
      destroyTimer: null,
      closed: false,
      destroyed: false
    }
    connections.set(conn.id, conn)
    allConnections.add(conn)
    state.session.connections.add(conn)
    state.conn = conn
    conn.ws = state

    client.on('ready', () => onClientReady(conn))
    client.on('error', (err: Error) => onClientError(conn, err))
    client.on('close', () => onClientClose(conn))

    const config: ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
      readyTimeout: sshReadyTimeoutMs,
      keepaliveInterval: sshKeepaliveIntervalMs,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        onHostKey(conn, key, verify)
      }
    }
    if (params.password !== undefined) config.password = params.password
    if (params.privateKey !== undefined) config.privateKey = params.privateKey
    if (params.passphrase !== undefined) config.passphrase = params.passphrase

    try {
      client.connect(config)
    } catch {
      sendError(conn, ERR.sshFailed)
      closeConnection(conn, { closeWs: true, destroyNow: true })
    } finally {
      // 主动去除保留的凭据引用（不写日志/磁盘）。
      // ssh2 1.17 的 connect() 在返回前已同步复制 password/privateKey/passphrase
      // （lib/client.js 中 cfg.password / cfg.privateKey / cfg.passphrase 赋值与
      // parseKey），后续握手只使用内部副本，因此这里清空不会破坏真实登录。
      config.password = undefined
      config.privateKey = undefined
      config.passphrase = undefined
      params.password = undefined
      params.privateKey = undefined
      params.passphrase = undefined
    }
  }

  function onHostKey(conn: SshConnection, key: Buffer, verify: (valid: boolean) => void): void {
    if (conn.closed) {
      verify(false)
      return
    }
    if (conn.hostKey) {
      verify(false)
      return
    }
    const algorithm = hostKeyAlgorithm(key)
    const fingerprint = hostKeyFingerprint(key)
    // SSH 会定期重新交换密钥；同一连接仅复用用户已确认的同一主机密钥。
    // 重新提示会把 ready 会话卡在认证态，且 ready 事件不会再次触发。
    if (conn.trustedFingerprint) {
      if (fingerprint === conn.trustedFingerprint) { verify(true); return }
      sendError(conn, ERR.hostKeyMismatch)
      verify(false)
      closeConnection(conn, { closeWs: true })
      return
    }
    conn.hostKey = { algorithm, fingerprint, verify }
    conn.state = 'awaiting-trust'
    const delivered = sendToConnection(conn, {
      type: 'host-key',
      host: conn.host,
      port: conn.port,
      algorithm,
      fingerprint
    })
    if (!delivered) {
      conn.hostKey = null
      verify(false)
      closeConnection(conn, {})
      return
    }
    conn.hostKeyTimer = setTimeout(() => {
      conn.hostKeyTimer = null
      if (conn.closed || !conn.hostKey) return
      conn.hostKey = null
      // 同上：先发错误再让 ssh2 失败，避免错误被 onClientError 覆盖。
      sendError(conn, ERR.hostKeyTimeout)
      verify(false)
      closeConnection(conn, { closeWs: true })
    }, hostKeyTimeoutMs)
    conn.hostKeyTimer.unref()
  }

  function handleTrustHost(state: WsState, msg: Record<string, unknown>): void {
    const conn = state.conn
    if (!conn || conn.closed) {
      send(state.ws, { type: 'error', message: ERR.connectionUnavailable })
      return
    }
    const prompt = conn.hostKey
    if (conn.state !== 'awaiting-trust' || !prompt) {
      send(state.ws, { type: 'error', message: ERR.notReady })
      return
    }
    const fingerprint = msg.fingerprint
    const accept = msg.accept
    if (typeof fingerprint !== 'string' || typeof accept !== 'boolean') {
      send(state.ws, { type: 'error', message: ERR.invalidMessage })
      return
    }
    // 只接受“完全相同”的指纹；不一致按拒绝处理，绝不继续认证。
    if (fingerprint !== prompt.fingerprint) {
      conn.hostKey = null
      conn.hostKeyTimer = cancelTimer(conn.hostKeyTimer)
      // 先发明确的错误再 verify(false)：verify(false) 会让 ssh2 同步派发
      // 'error'，onClientError 可能先关闭连接，把这里的消息吞掉。
      sendError(conn, ERR.hostKeyMismatch)
      prompt.verify(false)
      closeConnection(conn, { closeWs: true })
      return
    }
    conn.hostKey = null
    conn.hostKeyTimer = cancelTimer(conn.hostKeyTimer)
    if (!accept) {
      sendError(conn, ERR.hostKeyRejected)
      prompt.verify(false)
      closeConnection(conn, { closeWs: true })
      return
    }
    conn.trusted = true
    conn.trustedFingerprint = prompt.fingerprint
    conn.state = 'authenticating'
    prompt.verify(true)
  }

  function handleResume(state: WsState, msg: Record<string, unknown>): void {
    if (state.conn && !state.conn.closed) {
      send(state.ws, { type: 'error', message: ERR.connectionAttached })
      return
    }
    const connectionId = msg.connectionId
    const lastSeq = msg.lastSeq
    if (
      typeof connectionId !== 'string' ||
      connectionId.length === 0 ||
      connectionId.length > MAX_CONNECTION_ID_LEN ||
      typeof lastSeq !== 'number' ||
      !Number.isSafeInteger(lastSeq) ||
      lastSeq < 0
    ) {
      send(state.ws, { type: 'error', message: ERR.invalidMessage })
      return
    }
    const conn = connections.get(connectionId)
    if (!conn || conn.closed || conn.session !== state.session || conn.state !== 'ready') {
      send(state.ws, { type: 'error', message: ERR.connectionUnavailable })
      return
    }
    if (conn.ws) {
      send(state.ws, { type: 'error', message: ERR.connectionAttached })
      return
    }
    conn.graceTimer = cancelTimer(conn.graceTimer)
    conn.ws = state
    state.conn = conn
    send(state.ws, { type: 'ready', connectionId: conn.id })
    replayOutput(conn, lastSeq)
  }

  function replayOutput(conn: SshConnection, lastSeq: number): void {
    const latest = conn.seq - 1
    const oldest = conn.ring.length > 0 ? (conn.ring[0] as OutputChunk).seq : latest + 1
    if (lastSeq > latest) {
      sendToConnection(conn, { type: 'gap', nextSeq: conn.seq })
      return
    }
    if (lastSeq < oldest - 1) {
      sendToConnection(conn, { type: 'gap', nextSeq: oldest })
    }
    for (const chunk of conn.ring) {
      if (chunk.seq <= lastSeq) continue
      sendDataNow(conn, chunk)
      if (!conn.ws || conn.ws.closed) break
    }
  }

  function handleInput(state: WsState, msg: Record<string, unknown>): void {
    const conn = state.conn
    if (!conn || conn.closed || conn.state !== 'ready' || !conn.channel) {
      send(state.ws, { type: 'error', message: ERR.inputNotReady })
      return
    }
    const data = msg.data
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INPUT_CHARS) {
      send(state.ws, { type: 'error', message: ERR.invalidInput })
      return
    }
    // write() 可以只把数据排入 Node stream；SSH 对端不再读取时也必须限制积压。
    if ((conn.channel.writableLength ?? 0) + Buffer.byteLength(data, 'utf8') > maxBufferedBytes) {
      sendError(conn, ERR.inputBufferFull)
      closeConnection(conn, { closeWs: true })
      return
    }
    try {
      conn.channel.write(data)
    } catch {
      sendError(conn, ERR.channelFailed)
      closeConnection(conn, { closeWs: true })
    }
  }

  function handleResize(state: WsState, msg: Record<string, unknown>): void {
    const conn = state.conn
    if (!conn || conn.closed || conn.state !== 'ready' || !conn.channel) {
      send(state.ws, { type: 'error', message: ERR.notReady })
      return
    }
    const cols = msg.cols
    const rows = msg.rows
    if (
      typeof cols !== 'number' ||
      typeof rows !== 'number' ||
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows)
    ) {
      send(state.ws, { type: 'error', message: ERR.invalidResize })
      return
    }
    const clampedCols = Math.min(MAX_TERMINAL_DIM, Math.max(1, cols))
    const clampedRows = Math.min(MAX_TERMINAL_DIM, Math.max(1, rows))
    conn.cols = clampedCols
    conn.rows = clampedRows
    try {
      conn.channel.setWindow(clampedRows, clampedCols, 0, 0)
    } catch {
      sendError(conn, ERR.channelFailed)
      closeConnection(conn, { closeWs: true })
    }
  }

  function handleDisconnect(state: WsState): void {
    const conn = state.conn
    if (!conn || conn.closed) {
      send(state.ws, { type: 'closed', message: ERR.sshClosed })
      return
    }
    closeConnection(conn, { notify: { type: 'closed', message: ERR.shellClosed }, closeWs: true })
  }

  // ---------- SSH 生命周期 ----------

  function onClientReady(conn: SshConnection): void {
    if (conn.closed) return
    if (!conn.trusted) {
      // 防御：即使底层库错误地提前 ready，也不得越过 host-key 确认。
      sendError(conn, ERR.hostKeyRejected)
      closeConnection(conn, { closeWs: true })
      return
    }
    if (conn.shellStarted) return
    conn.shellStarted = true
    try {
      conn.client.shell(
        { term: 'xterm-256color', cols: conn.cols, rows: conn.rows },
        (err: Error | undefined, channel: SshChannelLike) => {
          if (conn.closed) {
            try {
              channel?.close?.()
            } catch {
              /* ignore */
            }
            return
          }
          if (err || !channel) {
            sendError(conn, ERR.shellFailed)
            closeConnection(conn, { closeWs: true })
            return
          }
          conn.channel = channel
          conn.decoder = new StringDecoder('utf8')
          channel.on('data', (data: Buffer | string) => onChannelData(conn, data))
          channel.on('close', () => onChannelClose(conn))
          channel.on('error', () => {
            if (conn.closed) return
            sendError(conn, ERR.channelFailed)
            closeConnection(conn, { closeWs: true })
          })
          conn.state = 'ready'
          sendToConnection(conn, { type: 'ready', connectionId: conn.id })
        }
      )
    } catch {
      sendError(conn, ERR.shellFailed)
      closeConnection(conn, { closeWs: true })
    }
  }

  function onChannelData(conn: SshConnection, data: Buffer | string): void {
    if (conn.closed || !conn.decoder) return
    let text: string
    if (typeof data === 'string') {
      text = conn.decoder.write(Buffer.from(data, 'utf8'))
    } else {
      text = conn.decoder.write(data)
    }
    if (text.length === 0) return
    queueOutput(conn, text)
  }

  function onChannelClose(conn: SshConnection): void {
    if (conn.closed) return
    if (conn.decoder) {
      const tail = conn.decoder.end()
      if (tail.length > 0) queueOutput(conn, tail)
      conn.decoder = null
    }
    closeConnection(conn, { notify: { type: 'closed', message: ERR.shellClosed }, closeWs: true })
  }

  function queueOutput(conn: SshConnection, text: string): void {
    if (conn.closed) return
    for (const part of splitUtf8(text, chunkBytes)) {
      const bytes = Buffer.byteLength(part, 'utf8')
      const chunk: OutputChunk = { seq: conn.seq, data: part, bytes }
      conn.seq += 1
      conn.ring.push(chunk)
      conn.ringBytes += bytes
      while (conn.ringBytes > outputBufferBytes && conn.ring.length > 1) {
        const dropped = conn.ring.shift()
        if (dropped) conn.ringBytes -= dropped.bytes
      }
      sendDataNow(conn, chunk)
    }
  }

  function onClientError(conn: SshConnection, err: Error): void {
    if (conn.closed) return
    let message: string = ERR.sshFailed
    const level = (err as Error & { level?: string }).level
    if (conn.state === 'awaiting-trust') message = ERR.hostKeyRejected
    else if (level === 'client-authentication') message = ERR.sshAuthFailed
    else if (level === 'client-timeout') message = ERR.sshTimeout
    else if (level === 'client-socket') message = ERR.sshFailed
    sendError(conn, message)
    closeConnection(conn, { closeWs: true })
  }

  function onClientClose(conn: SshConnection): void {
    if (conn.closed) return
    closeConnection(conn, { notify: { type: 'closed', message: ERR.sshClosed }, closeWs: true })
  }

  function closeConnection(
    conn: SshConnection,
    opts: {
      notify?: { type: 'closed' | 'error'; message: string }
      closeWs?: boolean
      destroyNow?: boolean
    } = {}
  ): void {
    if (conn.closed) {
      // 已关闭但仍在等 1s destroy 定时器的连接：close() 必须能同步收尾。
      if (opts.destroyNow) {
        conn.destroyTimer = cancelTimer(conn.destroyTimer)
        destroyClient(conn)
      }
      return
    }
    conn.closed = true
    conn.state = 'closed'
    conn.hostKeyTimer = cancelTimer(conn.hostKeyTimer)
    conn.graceTimer = cancelTimer(conn.graceTimer)
    if (conn.hostKey) {
      const prompt = conn.hostKey
      conn.hostKey = null
      try {
        prompt.verify(false)
      } catch {
        /* ignore */
      }
    }
    connections.delete(conn.id)
    conn.session.connections.delete(conn)
    const state = conn.ws
    conn.ws = null
    if (state) {
      if (state.conn === conn) state.conn = null
    }
    // 关闭后不再解码残留的 SSH 数据，避免保留缓冲和继续解析。
    conn.decoder = null
    const channel = conn.channel
    conn.channel = null
    if (channel) {
      try {
        channel.end()
      } catch {
        /* ignore */
      }
    }
    try {
      conn.client.end()
    } catch {
      /* ignore */
    }
    if (opts.destroyNow) {
      conn.destroyTimer = cancelTimer(conn.destroyTimer)
      destroyClient(conn)
    } else if (!conn.destroyTimer) {
      conn.destroyTimer = setTimeout(() => {
        conn.destroyTimer = null
        destroyClient(conn)
      }, 1_000)
      conn.destroyTimer.unref()
    }
    if (state && !state.closed) {
      if (opts.notify) {
        if (state.ws.readyState === WebSocket.OPEN) {
          send(state.ws, opts.notify)
        }
      }
      if (opts.closeWs && state.ws.readyState === WebSocket.OPEN) {
        try {
          state.ws.close(opts.notify?.type === 'error' ? 1011 : 1000, 'connection closed')
        } catch {
          /* ignore */
        }
      }
    }
  }

  function destroyClient(conn: SshConnection): void {
    if (conn.destroyed) return
    conn.destroyed = true
    allConnections.delete(conn)
    try {
      conn.client.destroy()
    } catch {
      /* ignore */
    }
  }

  // ---------- 启动/关闭 ----------

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      httpServer.removeListener('error', onError)
      resolve()
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(0, '0.0.0.0')
  })
  const address = httpServer.address() as AddressInfo | null
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    throw new Error('web-ssh: failed to bind listening port')
  }
  port = address.port
  origin = `http://127.0.0.1:${port}`
  httpServer.on('error', () => {
    /* 运行时错误不崩溃共享宿主 */
  })

  purgeTimer = setInterval(purgeExpiredTickets, 10_000)
  purgeTimer.unref()
  sessionPurgeTimer = setInterval(purgeIdleSessions, 60_000)
  sessionPurgeTimer.unref()

  async function performClose(): Promise<void> {
    closing = true
    if (purgeTimer) clearInterval(purgeTimer)
    if (sessionPurgeTimer) clearInterval(sessionPurgeTimer)
    purgeTimer = null
    sessionPurgeTimer = null
    for (const conn of Array.from(allConnections)) {
      // 先取消待执行的 destroy 定时器，再同步销毁，避免 close() 返回后仍有计时器。
      conn.destroyTimer = cancelTimer(conn.destroyTimer)
      closeConnection(conn, { destroyNow: true })
    }
    allConnections.clear()
    for (const state of Array.from(wsStates)) {
      state.closed = true
      wsStates.delete(state)
      state.session.sockets.delete(state)
      if (state.heartbeat) {
        clearInterval(state.heartbeat)
        state.heartbeat = null
      }
      try {
        state.ws.terminate()
      } catch {
        /* ignore */
      }
    }
    sessions.clear()
    tickets.clear()
    connections.clear()
    try {
      wss.close()
    } catch {
      /* ignore */
    }
    const httpClosed = new Promise<void>((resolve) => {
      httpServer.close(() => resolve())
    })
    try {
      httpServer.closeAllConnections?.()
    } catch {
      /* ignore */
    }
    // 最多等 2 秒；定时器本身必须被清掉，close() 返回后不留任何计时器。
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, 2_000)
      timer.unref()
      httpClosed.then(finish, finish)
    })
  }

  const handle: WebSshServerHandle = {
    port,
    origin,
    close(): Promise<void> {
      if (!closePromise) closePromise = performClose()
      return closePromise
    }
  }
  return handle
}
