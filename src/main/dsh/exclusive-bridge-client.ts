/**
 * Pet 托管控制桥客户端（LyShell 主进程 → dsh 进程内的桥）。
 *
 * 通道：桥自己的**回环端口**（握手回执里的 `controlPort`），鉴权用 S2 的 host-only key 头。
 * 不走 dsh 的 `/api`：那条前缀路由是官方 client-connection 注册的（重复注册会抛），
 * 且自带会话鉴权、又是独占 gate 要拦的对象 —— 控制通道必须与它分离。
 *
 * 凭据边界：key 只在内存里，不进日志、不进快照、不回显到任何返回值。
 */

import http from 'http'
import log from 'electron-log'
import { BRIDGE_KEY_HEADER } from './bridge'
import type { ExclusiveBridgeCommand, ExclusiveBridgeOutcome } from './exclusive-control'
import type {
  ExclusiveApprovalView,
  ExclusiveTaskState,
  ExclusiveTranscriptEntry,
  ExclusiveTranscriptKind
} from '@shared/exclusive-control'
import { EXCLUSIVE_TRANSCRIPT_TEXT_LIMIT, readExclusiveViewerState, exclusiveDiagnostic, readExclusiveDiagnostic, type ExclusiveDiagnostic } from '@shared/exclusive-control'

/** 控制命令的超时：桥侧可能等着官方回合结束，故给足；超时按 bridge/timeout 报，不本地兜底。 */
const CONTROL_TIMEOUT_MS = 30_000
/** 单次控制响应上限（含 transcript/approvals） */
const MAX_CONTROL_RESPONSE_BYTES = 512 * 1024

export interface BridgeControlEndpoint {
  /** 回环端口（0/缺省 ⇒ 无桥控制面） */
  port: number
  /** host-only key（只内存） */
  key: string
}

export type BridgeControlRunner = (command: ExclusiveBridgeCommand) => Promise<ExclusiveBridgeOutcome>

/**
 * 构造桥命令执行器。端点未就绪（无桥/旧版桥/控制面没起来）时立即返回 bridge/unavailable，
 * **绝不**降级到别的通道（不 local fallback、不盲重发）。
 */
export function createBridgeControlRunner(
  endpoint: () => BridgeControlEndpoint | null,
  timeoutMs = CONTROL_TIMEOUT_MS
): BridgeControlRunner {
  return async (command) => {
    const target = endpoint()
    if (!target || !target.port || !target.key) {
      return { ok: false, code: 'bridge/unavailable', error: 'harness bridge control endpoint is unavailable' }
    }
    const body = JSON.stringify(command)
    let diagnostic: ExclusiveDiagnostic | undefined
    let hasResponse = false
    const result = await new Promise<{ status: number; body: string } | null>((resolve) => {
      let settled = false
      const done = (value: { status: number; body: string } | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const req = http.request(
        {
          host: '127.0.0.1',
          port: target.port,
          path: '/',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            [BRIDGE_KEY_HEADER]: target.key
          },
          timeout: timeoutMs
        },
        (res) => {
          hasResponse = true
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_CONTROL_RESPONSE_BYTES) {
              req.destroy()
              done(null)
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', error => { diagnostic = exclusiveDiagnostic(error, 'response-body', true); done(null) })
          res.on('aborted', () => { diagnostic ??= exclusiveDiagnostic({ code: 'ECONNRESET' }, 'response-body', true); done(null) })
        }
      )
      req.on('error', error => { diagnostic ??= exclusiveDiagnostic(error, hasResponse ? 'response-body' : 'connect', hasResponse); done(null) })
      req.on('timeout', () => {
        diagnostic = exclusiveDiagnostic({ code: 'ETIMEDOUT' }, hasResponse ? 'response-body' : 'connect', hasResponse)
        req.destroy()
        done(null)
      })
      req.end(body)
    })

    if (!result) {
      // 桥不可达/超时：明确报错，绝不本地兜底
      diagnostic ??= exclusiveDiagnostic(null, hasResponse ? 'response-body' : 'connect', hasResponse)
      log.warn('[ExclusiveBridge] control response unavailable', diagnostic)
      return { ok: false, code: diagnostic.code === 'ETIMEDOUT' ? 'bridge/timeout' : 'bridge/unavailable', error: 'harness bridge did not answer the control command', diagnostic }
    }
    let payload: unknown
    try {
      payload = JSON.parse(result.body)
    } catch {
      return { ok: false, code: 'bridge/unavailable', error: 'harness bridge returned malformed JSON' }
    }
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, code: 'bridge/unavailable', error: 'harness bridge returned an unexpected payload' }
    }
    const p = payload as Record<string, unknown>
    if (p.ok === true) {
      return {
        ok: true,
        identity: readIdentity(p.identity),
        task: readTask(p.task),
        sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
        approval: typeof p.approval === 'string' ? (p.approval as ExclusiveBridgeOutcome['approval']) : undefined,
        approvals: readApprovals(p.approvals),
        transcript: readTranscript(p.transcript),
        // 工作台查看器状态：严格解码（形状不符即 undefined，绝不用半个状态驱动导航）
        viewer: readExclusiveViewerState(p.viewer),
        holding: p.holding === true,
        webBusy: p.webBusy === true
      }
    }
    // 失败只接受固定分类码；未知码按 bridge/unavailable 处理（不回显桥侧文本）
    return {
      ok: false,
      code: typeof p.code === 'string' ? (p.code as ExclusiveBridgeOutcome['code']) : 'bridge/unavailable',
      error: typeof p.error === 'string' ? p.error.slice(0, 200) : 'harness bridge refused the control command'
    }
  }
}

function readIdentity(value: unknown): ExclusiveBridgeOutcome['identity'] {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.instanceId !== 'string' || typeof v.instanceEpoch !== 'number') return undefined
  return { instanceId: v.instanceId, instanceEpoch: v.instanceEpoch }
}

function readTask(value: unknown): ExclusiveBridgeOutcome['task'] {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (
    typeof v.taskId !== 'string' ||
    typeof v.sessionId !== 'string' ||
    typeof v.epoch !== 'number' ||
    typeof v.state !== 'string' ||
    typeof v.acceptedAt !== 'number'
  ) {
    return null
  }
  return {
    taskId: v.taskId,
    sessionId: v.sessionId,
    epoch: v.epoch,
    state: v.state as ExclusiveTaskState,
    acceptedAt: v.acceptedAt,
    ...(readExclusiveDiagnostic(v.diagnostic) ? { diagnostic: readExclusiveDiagnostic(v.diagnostic) } : {}),
    ...(typeof v.endedAt === 'number' ? { endedAt: v.endedAt } : {}),
    ...(typeof v.endReason === 'string' ? { endReason: v.endReason } : {})
  }
}

/** 严格解码桥侧待答审批列表：任一条形状不合法即整条丢弃（不猜、不部分接受）。 */
function readApprovals(value: unknown): ExclusiveApprovalView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ExclusiveApprovalView[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const v = item as Record<string, unknown>
    if (
      typeof v.approvalId !== 'string' ||
      v.approvalId.length === 0 ||
      typeof v.sessionId !== 'string' ||
      v.sessionId.length === 0 ||
      typeof v.epoch !== 'number' ||
      !Number.isInteger(v.epoch) ||
      typeof v.toolName !== 'string' ||
      typeof v.askedAt !== 'number'
    ) {
      continue
    }
    out.push({
      approvalId: v.approvalId.slice(0, 128),
      taskId: typeof v.taskId === 'string' && v.taskId.length > 0 ? v.taskId.slice(0, 128) : null,
      sessionId: v.sessionId.slice(0, 128),
      epoch: v.epoch,
      toolName: v.toolName.slice(0, 200),
      ...(typeof v.callId === 'string' ? { callId: v.callId.slice(0, 200) } : {}),
      ...(typeof v.reason === 'string' ? { reason: v.reason.slice(0, 2000) } : {}),
      askedAt: v.askedAt
    })
  }
  return out
}

const TRANSCRIPT_KINDS: readonly ExclusiveTranscriptKind[] = ['user', 'assistant', 'tool-call', 'tool-result']

/** 严格解码有界工作输出：只接受已知 kind 与有界文本。 */
function readTranscript(value: unknown): ExclusiveTranscriptEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ExclusiveTranscriptEntry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const v = item as Record<string, unknown>
    if (
      typeof v.seq !== 'number' ||
      typeof v.kind !== 'string' ||
      !TRANSCRIPT_KINDS.includes(v.kind as ExclusiveTranscriptKind) ||
      typeof v.text !== 'string'
    ) {
      continue
    }
    out.push({
      seq: v.seq,
      at: typeof v.at === 'number' ? v.at : 0,
      kind: v.kind as ExclusiveTranscriptKind,
      sessionId: typeof v.sessionId === 'string' ? v.sessionId.slice(0, 128) : '',
      ...(typeof v.taskId === 'string' ? { taskId: v.taskId.slice(0, 128) } : {}),
      ...(typeof v.toolName === 'string' ? { toolName: v.toolName.slice(0, 120) } : {}),
      text: v.text.slice(0, EXCLUSIVE_TRANSCRIPT_TEXT_LIMIT),
      ...(v.failed === true ? { failed: true } : {})
    })
  }
  return out
}

/** 供启动日志使用：只记端口，绝不记 key。 */
export function describeBridgeControl(endpoint: BridgeControlEndpoint | null): string {
  if (!endpoint || !endpoint.port) return 'no control endpoint'
  log.info('[Exclusive] bridge control endpoint ready')
  return `127.0.0.1:${endpoint.port}`
}
