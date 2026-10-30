import type { ApiRouteMeta } from './api-routes'

export type HarnessWorkRequest =
  | { kind: 'state'; sessionId?: string; taskId?: string }
  | { kind: 'targets' | 'disconnect' | 'recover' }
  | { kind: 'new'; workspace?: string }
  | { kind: 'select'; sessionId: string }
  | { kind: 'submit'; text: string; requestId: string; sessionId: string; idempotencyKey?: string }
  | { kind: 'resume'; taskId: string; text: string; requestId: string; sessionId: string; idempotencyKey?: string }
  | { kind: 'cancel'; taskId: string; sessionId?: string }
  | { kind: 'approve'; id: string; sessionId?: string; taskId?: string; optionId: 'allowed-once' | 'rejected' | 'cancelled' }

const fields: Record<string, string[]> = {
  state: ['sessionId', 'taskId'], targets: [], disconnect: [], new: ['workspace'], select: ['sessionId'],
  submit: ['text', 'requestId', 'sessionId', 'idempotencyKey'], cancel: ['taskId', 'sessionId'],
  approve: ['id', 'optionId', 'sessionId', 'taskId'], recover: [],
  resume: ['taskId', 'text', 'requestId', 'sessionId', 'idempotencyKey']
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
  if (['submit', 'resume'].includes(p.kind) && (!id('requestId') || !id('sessionId') || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 32000)) return null
  // requestId 只关联单次调用；显式幂等键才表达“同一提交的重试”，且必须是不含控制字符的不透明值。
  if (['submit', 'resume'].includes(p.kind) && p.idempotencyKey !== undefined &&
    (typeof p.idempotencyKey !== 'string' || p.idempotencyKey.length < 1 || p.idempotencyKey.length > 128 ||
      [...p.idempotencyKey].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return null
  if (p.kind === 'resume' && !id('taskId')) return null
  if (p.kind === 'cancel' && !id('taskId')) return null
  if (p.kind === 'approve' && (!id('id') || typeof p.optionId !== 'string' || !['allowed-once', 'rejected', 'cancelled'].includes(p.optionId))) return null
  return p as HarnessWorkRequest
}

export const HARNESS_WORK_ROUTE: ApiRouteMeta = {
  name: 'lyshell_harness_work', path: '/api/harness/work/request', method: 'POST',
  capabilities: ['localExecute', 'fileWrite'], transports: ['http', 'stdio-mcp'],
  title: 'DeepSeek Harness 工作控制',
  description: 'LyShell 原生 Harness 工作通道，独立于 PetLink。kind: state/targets/new/select/submit/cancel/approve/disconnect/recover/resume。同凭据不同会话可并行，每会话最多一个活动任务。new 创建会话；submit 按 sessionId 和唯一 requestId 提交，可选 idempotencyKey 表达同一提交的重试（同键同参返回原任务，不同参拒绝）。state 按 sessionId/taskId 精确读取，断线保留持久进度但不是当前执行证据。recover 仅恢复后台，绝不重发任务。核对副作用后可 resume，提供原 taskId、sessionId、新 requestId 与剩余工作 text；保留逻辑 taskId、新建 attemptId。审批不跨重启恢复。接收不等于完成，只认对应 attempt 的官方终态。cancel 只停止目标任务。disconnect 不杀共享后台。不接管 Pet/Web 历史会话。',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  outputSchema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['state', 'targets', 'new', 'select', 'submit', 'cancel', 'approve', 'disconnect', 'recover', 'resume'] },
      workspace: { type: 'string', description: 'new 的绝对工作目录；省略使用后台启动目录' },
      sessionId: { type: 'string', maxLength: 128, description: 'submit/select 必填；state/cancel/approve 可用作精确会话定位' }, text: { type: 'string', maxLength: 32000 },
      requestId: { type: 'string', maxLength: 128, description: '单次调用关联 ID，不跨调用复用' },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 128, description: '可选；同一提交的显式重试键。同键同参返回原任务，不同参拒绝；省略时沿用 requestId 去重' },
      taskId: { type: 'string' }, id: { type: 'string' },
      optionId: { type: 'string', enum: ['allowed-once', 'rejected', 'cancelled'] }
    }, required: ['kind']
  }
}
