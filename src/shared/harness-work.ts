import type { ApiRouteMeta } from './api-routes'

export type HarnessWorkRequest =
  | { kind: 'state' | 'targets' | 'disconnect' }
  | { kind: 'new'; workspace?: string }
  | { kind: 'select'; sessionId: string }
  | { kind: 'submit'; text: string; requestId: string; sessionId: string }
  | { kind: 'cancel'; taskId: string }
  | { kind: 'approve'; id: string; optionId: 'allowed-once' | 'rejected' | 'cancelled' }

const fields: Record<string, string[]> = {
  state: [], targets: [], disconnect: [], new: ['workspace'], select: ['sessionId'],
  submit: ['text', 'requestId', 'sessionId'], cancel: ['taskId'], approve: ['id', 'optionId']
}

/** 严格校验外部请求；不允许传 owner、宿主配置或 Pet epoch。 */
export function parseHarnessWorkRequest(value: unknown): HarnessWorkRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (typeof p.kind !== 'string' || !Object.hasOwn(fields, p.kind)) return null
  if (Object.keys(p).some(key => key !== 'kind' && !fields[p.kind as string].includes(key))) return null
  const id = (key: string): boolean => typeof p[key] === 'string' && (p[key] as string).length > 0 && (p[key] as string).length <= 128
  if (p.kind === 'new' && p.workspace !== undefined &&
    (typeof p.workspace !== 'string' || !p.workspace.trim() || p.workspace.length > 2048 || [...p.workspace].some(char => char.charCodeAt(0) < 32))) return null
  if (p.kind === 'select' && !id('sessionId')) return null
  if (p.kind === 'submit' && (!id('requestId') || !id('sessionId') || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 32000)) return null
  if (p.kind === 'cancel' && !id('taskId')) return null
  if (p.kind === 'approve' && (!id('id') || typeof p.optionId !== 'string' || !['allowed-once', 'rejected', 'cancelled'].includes(p.optionId))) return null
  return p as HarnessWorkRequest
}

export const HARNESS_WORK_ROUTE: ApiRouteMeta = {
  name: 'lyshell_harness_work', path: '/api/harness/work/request', method: 'POST',
  capabilities: ['localExecute', 'fileWrite'], transports: ['http', 'stdio-mcp'],
  title: 'DeepSeek Harness 工作控制',
  description: 'LyShell 原生 Harness 工作通道，独立于 PetLink。kind: state/targets/new/select/submit/cancel/approve/disconnect。先 new 或 select 本凭据创建的会话；submit 必须携带 sessionId 与唯一 requestId。接收不等于完成，轮询 state，按 taskId 和官方 completed 判断；未知结果禁止重发。审批只使用 state 返回的 id/options。凭据隔离，不接管 Pet/Web 历史会话。',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  outputSchema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['state', 'targets', 'new', 'select', 'submit', 'cancel', 'approve', 'disconnect'] },
      workspace: { type: 'string', description: 'new 的绝对工作目录；省略使用后台启动目录' },
      sessionId: { type: 'string' }, text: { type: 'string', maxLength: 32000 },
      requestId: { type: 'string', maxLength: 128 }, taskId: { type: 'string' }, id: { type: 'string' },
      optionId: { type: 'string', enum: ['allowed-once', 'rejected', 'cancelled'] }
    }, required: ['kind']
  }
}
