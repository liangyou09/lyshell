export interface DiagnosticEvent {
  at: number
  requestId: string
  operation: string
  source: 'gui' | 'http' | 'plugin'
  outcome: 'accepted' | 'completed' | 'refused' | 'failed'
  durationMs?: number
  status?: number
}

const events: DiagnosticEvent[] = []
const LIMIT = 256

/** 严格投影允许字段。不会保留请求体、命令、异常对象、Token 或环境。 */
export function recordDiagnosticEvent(event: DiagnosticEvent): void {
  const safe: DiagnosticEvent = { at: event.at, requestId: event.requestId, operation: event.operation,
    source: event.source, outcome: event.outcome }
  if (Number.isFinite(event.durationMs)) safe.durationMs = Math.max(0, event.durationMs!)
  if (Number.isInteger(event.status)) safe.status = event.status
  events.push(safe)
  if (events.length > LIMIT) events.splice(0, events.length - LIMIT)
}

export function diagnosticEvents(): DiagnosticEvent[] { return events.map(event => ({ ...event })) }
