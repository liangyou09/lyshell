import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type Server } from 'http'
import type { TuiActivityEvent, TuiActivitySession, TuiActivitySnapshot, TuiActivitySource, TuiActivityState } from '@shared/tui-activity'

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd', 'TurnComplete'])
interface HookEvent { hookEvent: string; sessionId: string; turnId?: string; callId?: string; notificationType?: string; eventId: string; at: number }
interface Launch { token: string; row: TuiActivitySession; seen: Set<string>; retiredSessions: Set<string>; retiredTurns: Set<string>; pendingCalls: Set<string>; lastAt: number }
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && ![...value].some(char => char.charCodeAt(0) < 32)
export function parseTuiEvent(raw: unknown, now: number): HookEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  if (Object.keys(e).some(key => !['hookEvent', 'sessionId', 'turnId', 'callId', 'notificationType', 'eventId', 'at'].includes(key))) return null
  if (typeof e.hookEvent !== 'string' || !EVENTS.has(e.hookEvent) || !identifier(e.sessionId) || !identifier(e.eventId) ||
    (e.turnId !== undefined && !identifier(e.turnId)) || (e.callId !== undefined && !identifier(e.callId)) || (e.notificationType !== undefined && (!identifier(e.notificationType) || e.notificationType.length > 128)) ||
    typeof e.at !== 'number' || !Number.isSafeInteger(e.at) || Math.abs(now - e.at) > 30000) return null
  return e as unknown as HookEvent
}

/** 独立的只接收通知的回环端点；每个启动凭据只对应一个终端，没有执行/审批接口。 */
export class TuiActivityRegistry {
  private launches = new Map<string, Launch>()
  private events: TuiActivityEvent[] = []
  private revision = 0
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private port: number | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(snapshot: TuiActivitySnapshot) => void>()
  constructor(private now: () => number = Date.now) {}

  onChange(listener: (snapshot: TuiActivitySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void { this.revision++; const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot) }
  snapshot(): TuiActivitySnapshot {
    return { observedAt: this.now(), revision: this.revision, sessions: [...this.launches.values()].map(item => ({ ...item.row })), events: this.events.map(event => ({ ...event })) }
  }
  register(terminalId: string, source: TuiActivitySource, workspace: string): void {
    if (this.launches.size >= 256 && !this.launches.has(terminalId)) throw new Error('Too many TUI notification sessions')
    this.launches.set(terminalId, { token: randomBytes(32).toString('hex'), row: { terminalId, launchId: randomUUID(), source, workspace,
      cliSessionId: null, turnId: null, state: 'unknown', updatedAt: this.now(), event: null, active: true }, seen: new Set(), retiredSessions: new Set(), retiredTurns: new Set(), pendingCalls: new Set(), lastAt: 0 })
    this.changed()
  }
  env(terminalId: string): Record<string, string> {
    const launch = this.launches.get(terminalId)
    return launch?.row.active && this.port ? { LYSHELL_TUI_ACTIVITY_ENDPOINT: `http://127.0.0.1:${this.port}/events`, LYSHELL_TUI_ACTIVITY_TOKEN: launch.token } : {}
  }
  connectEnv(terminalId: string): Record<string, string> {
    const launch = this.launches.get(terminalId)
    if (launch && !launch.row.active) this.register(terminalId, launch.row.source, launch.row.workspace)
    return this.env(terminalId)
  }
  deactivate(terminalId: string): void {
    const launch = this.launches.get(terminalId)
    if (!launch || !launch.row.active) return
    launch.row.active = false
    // PTY 退出不代表 CLI 回合成功。未确认的运行/审批状态必须降为未知。
    if (['running', 'waiting-approval', 'idle'].includes(launch.row.state)) launch.row.state = 'unknown'
    this.changed()
  }
  remove(terminalId: string): void { this.launches.delete(terminalId); this.changed() }

  receive(token: string, raw: unknown): boolean {
    if (!/^[a-f0-9]{64}$/u.test(token)) return false
    const launch = [...this.launches.values()].find(item => item.row.active && token.length === item.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(item.token)))
    const e = parseTuiEvent(raw, this.now())
    if (!launch || !e || launch.seen.has(e.eventId) || e.at < launch.lastAt || launch.retiredSessions.has(e.sessionId)) return false
    const row = launch.row
    const continuingSession = row.cliSessionId === e.sessionId
    if (row.source === 'claude' && e.hookEvent === 'TurnComplete') return false
    // 新 CLI 会话只由 SessionStart 认领；迟到的其他会话事件不会污染当前会话。
    if (row.cliSessionId && row.cliSessionId !== e.sessionId && e.hookEvent !== 'SessionStart') return false
    if (row.cliSessionId && row.cliSessionId !== e.sessionId) {
      launch.retiredSessions.add(row.cliSessionId)
      while (launch.retiredSessions.size > 128) launch.retiredSessions.delete(launch.retiredSessions.values().next().value!)
      row.turnId = null
      launch.retiredTurns.clear()
      launch.pendingCalls.clear()
    }
    if (e.turnId && launch.retiredTurns.has(e.turnId)) return false
    if (e.turnId && row.turnId && row.turnId !== e.turnId && !['UserPromptSubmit', 'PreToolUse', 'SessionStart', 'TurnComplete'].includes(e.hookEvent)) return false
    row.cliSessionId = e.sessionId
    launch.seen.add(e.eventId)
    while (launch.seen.size > 256) launch.seen.delete(launch.seen.values().next().value!)
    launch.lastAt = e.at
    // compact 会在同一 CLI 会话的活动回合中再次发 SessionStart，不能当作等待新输入。
    if (continuingSession && e.hookEvent === 'SessionStart' && ['running', 'waiting-approval'].includes(row.state)) {
      row.updatedAt = this.now()
      this.changed()
      return true
    }
    const states: Record<string, TuiActivityState> = { SessionStart: 'idle', UserPromptSubmit: 'running', PreToolUse: 'running', PostToolUse: 'running',
      PostToolUseFailure: 'running', PermissionRequest: 'waiting-approval', Stop: 'turn-ended', TurnComplete: 'turn-ended', StopFailure: 'failed', Interrupt: 'interrupted', SessionEnd: 'session-ended' }
    let next = e.hookEvent === 'Notification' ? (e.notificationType === 'permission_prompt' ? 'waiting-approval' : null) : states[e.hookEvent]
    if (!next) return true
    if (next === 'waiting-approval' && (e.hookEvent !== 'Notification' || row.state !== 'waiting-approval')) launch.pendingCalls.add(e.callId ?? 'unidentified')
    while (launch.pendingCalls.size > 128) launch.pendingCalls.delete(launch.pendingCalls.values().next().value!)
    if (e.hookEvent === 'PostToolUse' || e.hookEvent === 'PostToolUseFailure') {
      launch.pendingCalls.delete(e.callId ?? 'unidentified')
      if (e.callId) launch.pendingCalls.delete('unidentified')
    }
    if (['SessionStart', 'UserPromptSubmit', 'Stop', 'TurnComplete', 'StopFailure', 'Interrupt', 'SessionEnd'].includes(e.hookEvent)) launch.pendingCalls.clear()
    if (next === 'running' && launch.pendingCalls.size) next = 'waiting-approval'
    if (e.hookEvent === 'UserPromptSubmit' || (e.hookEvent === 'PreToolUse' && row.state !== 'running' && row.state !== 'waiting-approval') || (e.turnId && row.turnId !== e.turnId)) {
      const nextTurn = e.turnId ?? randomUUID()
      if (row.turnId && row.turnId !== nextTurn) launch.retiredTurns.add(row.turnId)
      while (launch.retiredTurns.size > 128) launch.retiredTurns.delete(launch.retiredTurns.values().next().value!)
      row.turnId = nextTurn
    }
    if (!row.turnId && next !== 'idle' && next !== 'session-ended') row.turnId = e.turnId ?? randomUUID()
    const transition = row.state !== next
    row.state = next; row.event = e.hookEvent; row.updatedAt = this.now()
    if (next !== 'waiting-approval') row.approvalEventId = undefined
    const kind = next === 'waiting-approval' ? 'approval' : next === 'turn-ended' || next === 'failed' || next === 'interrupted' ? next : null
    if (transition && kind && row.turnId) {
      const event: TuiActivityEvent = { id: randomUUID(), terminalId: row.terminalId, launchId: row.launchId, source: row.source, workspace: row.workspace, turnId: row.turnId, kind, at: row.updatedAt }
      if (kind === 'approval') row.approvalEventId = event.id
      this.events.unshift(event)
      this.events = this.events.slice(0, 100)
    }
    this.changed()
    return true
  }
  start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port)
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST' || req.url !== '/events' || req.headers.origin || req.headers['sec-fetch-site']) { res.writeHead(403).end(); return }
        const token = req.headers['x-lyshell-tui-token']
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) { res.writeHead(403).end(); return }
        const chunks: Buffer[] = []; let bytes = 0
        req.setTimeout(1500, () => req.destroy())
        req.on('error', () => {})
        req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) req.destroy(); else chunks.push(chunk) })
        req.on('end', () => {
          let accepted = false
          try { accepted = this.receive(token, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { /* 非法载荷不改变任务。 */ }
          res.writeHead(accepted ? 204 : 400).end()
        })
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        server.on('error', () => {})
        const address = server.address()
        if (!address || typeof address === 'string') { server.close(); reject(new Error('TUI notification endpoint unavailable')); return }
        this.server = server; this.port = address.port; server.unref(); resolve(address.port)
        // CLI 通道独立校准快照时间；原生后台读取变慢时不把 CLI 状态一并判为断线。
        this.heartbeat = setInterval(() => { if (this.launches.size) this.changed() }, 4000)
        this.heartbeat.unref()
      })
    }).finally(() => { this.starting = null })
    return this.starting
  }
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.launches.clear(); this.events = []; this.port = null
    const server = this.server; this.server = null
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}
export const tuiActivity = new TuiActivityRegistry()
