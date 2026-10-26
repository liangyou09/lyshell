import type { ApiRouteMeta } from './api-routes'

export type HarnessWorkRequest =
  | { kind: 'state'; sessionId?: string; taskId?: string }
  | { kind: 'targets' | 'disconnect' }
  | { kind: 'new'; workspace?: string }
  | { kind: 'select'; sessionId: string }
  | { kind: 'submit'; text: string; requestId: string; sessionId: string }
  | { kind: 'cancel'; taskId: string; sessionId?: string }
  | { kind: 'approve'; id: string; sessionId?: string; taskId?: string; optionId: 'allowed-once' | 'rejected' | 'cancelled' }

const fields: Record<string, string[]> = {
  state: ['sessionId', 'taskId'], targets: [], disconnect: [], new: ['workspace'], select: ['sessionId'],
  submit: ['text', 'requestId', 'sessionId'], cancel: ['taskId', 'sessionId'], approve: ['id', 'optionId', 'sessionId', 'taskId']
}

/** 严格校验外部请求；不允许传 owner、宿主配置或 Pet epoch。 */
export function parseHarnessWorkRequest(value: unknown): HarnessWorkRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (typeof p.kind !== 'string' || !Object.hasOwn(fields, p.kind)) return null
  if (Object.keys(p).some(key => key !== 'kind' && !fields[p.kind as string].includes(key))) return null
  const id = (key: string): boolean => typeof p[key] === 'string' && (p[key] as string).length > 0 && (p[key] as string).length <= 128
  if (['state', 'cancel', 'approve'].includes(p.kind) &&
    (p.sessionId !== undefined && !id('sessionId') || p.taskId !== undefined && !id('taskId'))) return null
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
  description: 'LyShell 原生 Harness 工作通道，独立于 PetLink。kind: state/targets/new/select/submit/cancel/approve/disconnect。同凭据不同会话可并行，每会话只允许一个活动任务。先 new 创建会话；submit 按 sessionId 定位，不依赖当前选择，并携带凭据内唯一 requestId。state 可按 sessionId/taskId 精确读取；无参数返回默认会话，sessions 含各会话最新任务视图。接收不等于完成，按 identity、acceptedTaskId 与官方 completed 跟踪；未知结果禁止重发。cancel 按 taskId，approve 按返回的 id/options，可附 sessionId/taskId 核对归属。disconnect 要求所有任务结束。凭据隔离，不接管 Pet/Web 历史会话。',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  outputSchema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['state', 'targets', 'new', 'select', 'submit', 'cancel', 'approve', 'disconnect'] },
      workspace: { type: 'string', description: 'new 的绝对工作目录；省略使用后台启动目录' },
      sessionId: { type: 'string', maxLength: 128, description: 'submit/select 必填；state/cancel/approve 可用作精确会话定位' }, text: { type: 'string', maxLength: 32000 },
      requestId: { type: 'string', maxLength: 128 }, taskId: { type: 'string' }, id: { type: 'string' },
      optionId: { type: 'string', enum: ['allowed-once', 'rejected', 'cancelled'] }
    }, required: ['kind']
  }
}
