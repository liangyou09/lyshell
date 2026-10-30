import { isControlHandle, type ControlHandle, type ControlSnapshot } from './terminal-control'

export type TerminalControlRequest =
  | { [K in 'inspect' | 'acquire' | 'takeover']: { kind: K; sessionId: string } }['inspect' | 'acquire' | 'takeover']
  | { [K in 'renew' | 'release']: { kind: K; control: ControlHandle } }['renew' | 'release']

export interface TerminalControlResult {
  success: boolean
  control?: ControlHandle
  snapshot?: ControlSnapshot | null
  error?: string
  code?: string
}

/** 身份不从此请求解码；调用方必须另外核对句柄与已验证身份一致。 */
export function readTerminalControlRequest(raw: unknown): TerminalControlRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (['inspect', 'acquire', 'takeover'].includes(String(p.kind))) {
    if (Object.keys(p).some(key => !['kind', 'sessionId'].includes(key)) || typeof p.sessionId !== 'string' || !p.sessionId || p.sessionId.length > 128) return null
    return p as unknown as TerminalControlRequest
  }
  if (p.kind === 'renew' || p.kind === 'release') {
    if (Object.keys(p).some(key => !['kind', 'control'].includes(key)) || !isControlHandle(p.control)) return null
    return p as unknown as TerminalControlRequest
  }
  return null
}
