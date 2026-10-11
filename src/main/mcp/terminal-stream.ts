import type { ServerResponse } from 'http'
import type { EventEmitter } from 'events'

interface TerminalSource extends EventEmitter {
  readOutput(sessionId: string, options: { lines: number; raw: boolean }): { output: string } | null
}
const streams = new Set<(reason?: string) => void>()
export function closeTerminalStreams(): void { for (const close of [...streams]) close('server_stopped') }

/** 按会话订阅真实 PTY 事件。客户端断开、撤权、背压或服务退出都会清理监听器。 */
export function streamTerminal(source: TerminalSource, sessionId: string, res: ServerResponse, allowed: () => boolean): void {
  // 鉴权可能异步完成；已断开的响应不会再触发 close，不能注册永久监听器。
  if (res.destroyed || res.writableEnded) return
  if (streams.size >= 16) { res.writeHead(429); res.end('Too many terminal subscriptions'); return }
  let closed = false
  const close = (reason?: string) => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    source.off('terminal:data', output)
    source.off('session:status', status)
    source.off('session:deleted', deleted)
    res.off('close', close)
    res.off('error', failed)
    streams.delete(close)
    if (reason && !res.destroyed) res.end(`event: closed\ndata: ${JSON.stringify({ sessionId, reason })}\n\n`)
    else res.end()
  }
  const failed = () => close()
  const send = (event: string, data: unknown) => {
    if (closed) return
    if (!allowed()) { close('access_revoked'); return }
    if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) close('consumer_backpressure')
  }
  const output = (event: { sessionId: string; data: string }) => {
    if (event.sessionId === sessionId) send('output', { sessionId, data: event.data })
  }
  const status = (event: { id: string; status: string }) => {
    if (event.id === sessionId) send('status', { sessionId, status: event.status })
  }
  const deleted = (id: string) => { if (id === sessionId) close('session_deleted') }
  const heartbeat = setInterval(() => send('heartbeat', { sessionId }), 5000)
  streams.add(close)
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.on('close', close)
  res.on('error', failed)
  source.on('terminal:data', output)
  source.on('session:status', status)
  source.on('session:deleted', deleted)
  try {
    const snapshot = source.readOutput(sessionId, { lines: 1000, raw: true })?.output ?? ''
    send('snapshot', { sessionId, output: snapshot.slice(-4096), truncated: snapshot.length > 4096 })
  } catch {
    close('snapshot_failed')
  }
}
