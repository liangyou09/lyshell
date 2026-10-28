import log from 'electron-log'
import type { ShelfBrowserRequest } from '@shared/shelf-browser'
export function validateShelfBrowserRequest(raw: unknown): ShelfBrowserRequest {
  const value = assertObject(raw, 'shelfBrowserRequest')
  const kind = assertEnum(value.kind, 'kind', ['permit', 'demand', 'inspect', 'presented'] as const)
  const fields = kind === 'permit' ? ['kind', 'resourceId', 'url', 'taskId', 'source'] : kind === 'demand' ? ['kind', 'resourceId', 'main', 'shelf'] : kind === 'presented' ? ['kind', 'resourceId', 'token', 'geometryRevision', 'width', 'height', 'dpr'] : ['kind', 'resourceId']
  if (Object.keys(value).some(key => !fields.includes(key))) throw new ValidationError('Invalid shelf browser request')
  const resourceId = assertString(value.resourceId, 'resourceId', { maxLength: 256 })
  if (!/^(tab|saved):.+$/.test(resourceId) || [...resourceId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new ValidationError('Invalid resourceId')
  if (kind === 'inspect') return { kind, resourceId }
  if (kind === 'presented') {
    const token = assertObject(value.token, 'token')
    if (Object.keys(token).some(key => !['scopeId', 'resourceId', 'instanceGeneration', 'navigationGeneration', 'demandRevision'].includes(key))) throw new ValidationError('Invalid browser token')
    const generation = (key: string) => assertNumber(token[key], key, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })
    return { kind, resourceId, token: { scopeId: assertString(token.scopeId, 'scopeId', { maxLength: 256 }), resourceId: assertString(token.resourceId, 'token.resourceId', { maxLength: 256 }), instanceGeneration: generation('instanceGeneration'), navigationGeneration: generation('navigationGeneration'), demandRevision: generation('demandRevision') }, geometryRevision: assertNumber(value.geometryRevision, 'geometryRevision', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true }), width: assertNumber(value.width, 'width', { min: 1, max: 16384 }), height: assertNumber(value.height, 'height', { min: 1, max: 16384 }), dpr: assertNumber(value.dpr, 'dpr', { min: 0.5, max: 8 }) }
  }
  if (kind === 'demand') return { kind, resourceId, main: assertBoolean(value.main, 'main'), shelf: assertBoolean(value.shelf, 'shelf') }
  const url = assertString(value.url, 'url', { maxLength: 4096 })
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new ValidationError('Invalid browser URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) && url !== 'about:blank') throw new ValidationError('Invalid browser URL')
  const taskId = value.taskId === undefined ? undefined : assertString(value.taskId, 'taskId', { maxLength: 128 })
  if (resourceId.startsWith('saved:') && resourceId !== `saved:${taskId}`) throw new ValidationError('Saved resource requires matching taskId')
  return { kind, resourceId, url, ...(taskId ? { taskId } : {}), source: assertEnum(value.source, 'source', ['explicitMain', 'explicitShelf', 'bulkVisible'] as const) }
}
import type { WorkbenchActivityRequest } from '@shared/workbench-activity'
import type { ActivityNavigationRequest } from '@shared/activity-navigation'

export function validateActivityNavigationRequest(raw: unknown): ActivityNavigationRequest {
  const value = assertObject(raw, 'activityNavigation')
  const kind = assertEnum(value.kind, 'kind', ['open', 'navigation'] as const)
  if (Object.keys(value).some(key => !['kind', 'identity', 'sessionId', ...(kind === 'navigation' ? ['requestId'] : [])].includes(key))) throw new ValidationError('Invalid navigation request')
  const identity = assertObject(value.identity, 'identity')
  if (Object.keys(identity).some(key => !['instanceId', 'instanceEpoch'].includes(key))) throw new ValidationError('Invalid backend identity')
  const common = {
    identity: { instanceId: assertString(identity.instanceId, 'instanceId', { maxLength: 128 }), instanceEpoch: assertNumber(identity.instanceEpoch, 'instanceEpoch', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true }) },
    sessionId: assertString(value.sessionId, 'sessionId', { maxLength: 128 })
  }
  return kind === 'open' ? { kind, ...common } : { kind, ...common, requestId: assertString(value.requestId, 'requestId', { maxLength: 128 }) }
}

export function validateWorkbenchActivityRequest(raw: unknown): WorkbenchActivityRequest {
  // TUI 和内置聊天均为只读事件来源；这里的 approve 只允许既有 native work 审批路由，不能代答 Web/TUI。
  const value = assertObject(raw, 'workbenchActivity')
  if (value.kind === 'snapshot' && Object.keys(value).length === 1) return { kind: 'snapshot' }
  if (value.kind !== 'approve' || Object.keys(value).some(key => !['kind', 'identity', 'sessionId', 'taskId', 'approvalId', 'optionId'].includes(key))) throw new ValidationError('Invalid workbench activity request')
  const identity = assertObject(value.identity, 'identity')
  if (Object.keys(identity).some(key => !['instanceId', 'instanceEpoch'].includes(key))) throw new ValidationError('Invalid backend identity')
  return {
    kind: 'approve',
    identity: { instanceId: assertString(identity.instanceId, 'instanceId', { maxLength: 128 }), instanceEpoch: assertNumber(identity.instanceEpoch, 'instanceEpoch', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true }) },
    sessionId: assertString(value.sessionId, 'sessionId', { maxLength: 128 }),
    taskId: assertString(value.taskId, 'taskId', { maxLength: 128 }),
    approvalId: assertString(value.approvalId, 'approvalId', { maxLength: 128 }),
    optionId: assertEnum(value.optionId, 'optionId', ['allowed-once', 'rejected', 'cancelled'] as const)
  }
}
import { parseSceneEntry, parseSceneNode, parseSceneTarget, type ProjectSceneRequest } from '@shared/project-scene'

export function validateProjectSceneRequest(raw: unknown): ProjectSceneRequest {
  const value = assertObject(raw, 'projectScene')
  if (value.kind === 'list') return { kind: 'list' }
  if (value.kind === 'inspect') return { kind: 'inspect', target: parseSceneTarget(value.target) }
  if (value.kind === 'describe') return { kind: 'describe', target: parseSceneTarget(value.target), entry: parseSceneEntry(value.entry) }
  if (value.kind === 'restore') return { kind: 'restore', id: assertString(value.id, 'scene.id', { maxLength: 128 }) }
  if (value.kind === 'save') return { kind: 'save', target: parseSceneTarget(value.target), root: parseSceneNode(value.root), activeLeaf: assertNumber(value.activeLeaf, 'activeLeaf', { min: 0, max: 31, integer: true }) }
  if (value.kind === 'launch') return { kind: 'launch', target: parseSceneTarget(value.target), entry: parseSceneEntry(value.entry), resume: assertBoolean(value.resume, 'resume') }
  throw new ValidationError('Unknown project scene request')
}
import type { McpConfirmationRequest } from '@shared/mcp-confirmation'

export function validateMcpConfirmationRequest(raw: unknown): McpConfirmationRequest {
  const value = assertObject(raw, 'mcpConfirmation')
  return { kind: assertEnum(value.kind, 'kind', ['get', 'ready', 'reject', 'allow', 'copy'] as const) }
}
import { isBrowserMenuAction, type BrowserMenuRequest } from '@shared/browser-context-menu'

export function validateBrowserMenuRequest(raw: unknown): BrowserMenuRequest {
  const value = assertObject(raw, 'browserMenu')
  const kind = assertEnum(value.kind, 'kind', ['get', 'ready', 'dismiss', 'action'] as const)
  if (kind !== 'action') return { kind }
  if (!isBrowserMenuAction(value.id)) throw new ValidationError('Invalid browser menu action')
  return { kind, id: value.id }
}
import type { TerminalOutputControl } from '@shared/terminal-output'

export function validateTerminalOutputControl(raw: unknown): TerminalOutputControl {
  const value = assertObject(raw, 'terminalOutput')
  const sessionId = assertString(value.sessionId, 'sessionId', { maxLength: 128 })
  if (value.kind === 'subscribe') return { kind: 'subscribe', sessionId }
  const subscriptionId = assertString(value.subscriptionId, 'subscriptionId', { maxLength: 128 })
  if (value.kind === 'unsubscribe') return { kind: 'unsubscribe', sessionId, subscriptionId }
  if (value.kind === 'ack') return {
    kind: 'ack', sessionId, subscriptionId,
    sequence: assertNumber(value.sequence, 'sequence', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true })
  }
  throw new ValidationError('Unknown terminal output control')
}
import { DSH_MARKET_ACTIONS, type DshMarketAction } from '@shared/dsh-market'
import type { BrowserDevToolsRequest } from '@shared/browser-devtools'
export { parseWebTerminalRequest as validateWebTerminalRequest } from '@shared/web-terminal'
import { extractErrorMessage } from '../terminal/session-manager'
import { type BrowserRequest } from '@shared/browser-settings'
import { validateBrowserSettings } from '../browser/validation'
import type { CodeWorkspaceRequest } from '@shared/code-workspaces'
import { validateWorktreeKey } from '@shared/worktree'
import { isMcpAuditRetentionLimit, type McpAuditRetentionLimit } from '@shared/mcp-audit'
import type { ShelfResource, TaskShelfRequest } from '@shared/task-shelf'
import { parseShelfPreferences, SHELF_ACTIVATION_LIMIT } from '@shared/task-shelf'
import { normalizeSshDirectory } from '../terminal/shelf-ssh-context'

export function validateMcpAuditRetentionLimit(value: unknown): McpAuditRetentionLimit {
  if (!isMcpAuditRetentionLimit(value)) throw new ValidationError('Invalid MCP audit retention limit')
  return value
}

export function validateBuiltinTransferMethod(value: unknown): 'sftp' {
  return assertEnum(value, 'transfer method', ['sftp'] as const)
}

export function validateCodeWorkspaceRequest(raw: unknown): CodeWorkspaceRequest {
  const value = assertObject(raw, 'codeWorkspaceRequest')
  if (value.kind === 'list') return { kind: 'list' }
  if (value.kind === 'delete') return { kind: 'delete', id: assertString(value.id, 'id', { maxLength: 128 }) }
  if (value.kind === 'launch') return { kind: 'launch', id: assertString(value.id, 'id', { maxLength: 128 }) }
  if (value.kind === 'launchDirectory') return {
    kind: 'launchDirectory', id: assertString(value.id, 'id', { maxLength: 128 }),
    cwd: assertString(value.cwd, 'cwd', { maxLength: 4096 })
  }
  if (value.kind !== 'save') throw new ValidationError('Unknown workspace preset request')
  const preset = assertObject(value.preset, 'preset')
  const isolation = assertEnum(preset.isolation, 'isolation', ['shared', 'worktree'] as const)
  const key = isolation === 'worktree' ? validateWorktreeKey(assertString(preset.worktreeKey, 'worktreeKey', { maxLength: 64 })) : undefined
  if (key && !key.ok) throw new ValidationError(key.error)
  const name = assertString(preset.name, 'name', { maxLength: 120 }).trim()
  if (!name) throw new ValidationError('name is required')
  return { kind: 'save', preset: {
    ...(preset.id === undefined ? {} : { id: assertString(preset.id, 'id', { maxLength: 128 }) }),
    name,
    cwd: assertString(preset.cwd, 'cwd', { maxLength: 4096 }),
    isolation, worktreeKey: key?.ok ? key.value : undefined
  } }
}

/**
 * 校验通用 Agent 的工作区字段（cwd / isolation / worktreeKey），返回归一化后的三字段。
 * add 不传 existing；update 传 existing —— 缺字段（键不存在）时沿用仓库现状，与
 * envProfileId / envKeyMap 同一套「键存在」语义（旧客户端不传 isolation/worktreeKey 也不丢
 * 已有隔离配置）。跨字段规则：
 *   - isolation = 'worktree'：worktreeKey 必须合法非空，且 cwd 非空（缺 cwd 无法定位仓库根）；
 *   - 其余（'shared' / 缺省）：显式清掉 worktreeKey（shared 目录不该残留 worktree 名）。
 * 旧 payload 无这些字段 / 旧默认 Agent 无 cwd 继续支持（全缺省即 undefined，不抛错）。
 */
export function validateAgentWorkspaceFields(
  raw: Record<string, unknown>,
  existing?: { cwd?: string; isolation?: 'shared' | 'worktree'; worktreeKey?: string }
): { cwd?: string; isolation?: 'shared' | 'worktree'; worktreeKey?: string } {
  // cwd：「键存在」语义 —— undefined 显式清掉（回到默认目录），缺键沿用仓库现状
  let cwd: string | undefined
  if ('cwd' in raw) {
    cwd = raw.cwd === undefined ? undefined : assertString(raw.cwd, 'agent.cwd', { maxLength: 4096 })
  } else if (existing) {
    cwd = existing.cwd
  }

  // isolation：同「键存在」语义 —— undefined 显式回到 shared 缺省，缺键沿用仓库现状
  let isolation: 'shared' | 'worktree' | undefined
  if ('isolation' in raw) {
    isolation = raw.isolation === undefined
      ? undefined
      : assertEnum(raw.isolation, 'agent.isolation', ['shared', 'worktree'] as const)
  } else if (existing) {
    isolation = existing.isolation
  }

  // worktreeKey：同「键存在」语义 —— 显式 undefined 清掉，非法名保存即拒（不做静默折叠）
  let worktreeKey: string | undefined
  if ('worktreeKey' in raw) {
    if (raw.worktreeKey === undefined) {
      worktreeKey = undefined
    } else {
      const key = validateWorktreeKey(assertString(raw.worktreeKey, 'agent.worktreeKey', { maxLength: 64 }))
      if (!key.ok) throw new ValidationError(key.error)
      worktreeKey = key.value
    }
  } else if (existing) {
    worktreeKey = existing.worktreeKey
  }

  // 跨字段规则：worktree 隔离必须同时有合法 key 与非空 cwd；shared/缺省显式清掉 key
  if (isolation === 'worktree') {
    if (!worktreeKey) throw new ValidationError('Worktree name is required')
    if (!cwd || cwd.trim() === '') throw new ValidationError('agent.cwd is required for worktree isolation')
  } else {
    worktreeKey = undefined
  }

  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(worktreeKey !== undefined ? { worktreeKey } : {})
  }
}

export function validateBrowserRequest(raw: unknown): BrowserRequest {
  const value = assertObject(raw, 'browserRequest')
  switch (value.kind) {
    case 'get': case 'passwords': case 'downloads': case 'openDownloadDirectory':
    case 'defaultBrowserStatus': case 'requestDefaultBrowser': return { kind: value.kind }
    case 'searchSuggestions': return { kind: 'searchSuggestions', query: assertString(value.query, 'query', { maxLength: 200 }) }
    case 'downloadAction': return { kind: 'downloadAction', id: assertString(value.id, 'id', { maxLength: 128 }), action: assertEnum(value.action, 'action', ['cancel', 'reveal', 'open', 'remove'] as const) }
    case 'save': return { kind: 'save', settings: validateBrowserSettings(value.settings) }
    case 'clear': return { kind: 'clear', target: assertEnum(value.target, 'target', ['cache', 'siteData'] as const) }
    case 'deletePassword': return { kind: 'deletePassword', id: assertString(value.id, 'id', { maxLength: 128 }) }
    case 'certificateInfo': case 'trustCertificate': {
      const url = assertString(value.url, 'url', { maxLength: 16384 })
      let parsed: URL
      try { parsed = new URL(url) } catch { throw new ValidationError('Invalid certificate URL') }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new ValidationError('Invalid certificate URL')
      const guestId = assertNumber(value.guestId, 'guestId', { min: 1, integer: true })
      return value.kind === 'certificateInfo' ? { kind: 'certificateInfo', guestId, url: parsed.href }
        : { kind: 'trustCertificate', guestId, url: parsed.href, certificateId: assertString(value.certificateId, 'certificateId', { maxLength: 128 }) }
    }
    case 'savePassword': return {
      kind: 'savePassword', origin: assertString(value.origin, 'origin', { maxLength: 4096 }),
      username: assertString(value.username, 'username', { maxLength: 1024, allowEmpty: true }),
      password: assertString(value.password, 'password', { maxLength: 4096 })
    }
    default: throw new ValidationError('Unknown browser request')
  }
}

interface StringOptions {
  maxLength?: number
  allowEmpty?: boolean
}

/** 插件动作回执只接收有界请求标识、布尔结果及可选错误，身份另由 sender 核对。 */
export function validatePluginActionReceipt(raw: unknown): { requestId: string; ok: boolean; error?: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const data = raw as Record<string, unknown>
  if (typeof data.requestId !== 'string' || !/^act-[a-z0-9-]{1,100}$/.test(data.requestId) || typeof data.ok !== 'boolean') return undefined
  if (data.error !== undefined && (typeof data.error !== 'string' || data.error.length > 4096)) return undefined
  return { requestId: data.requestId, ok: data.ok, ...(typeof data.error === 'string' ? { error: data.error } : {}) }
}

/** 只有主窗口 renderer 可认领资源管理器启动请求，webview/浮窗不能消费队列。 */
export function assertExplorerLaunchConsumer(senderId: number, consumerId: number | null): void {
  if (senderId !== consumerId) throw new ValidationError('Explorer launch requires the main window')
}

export function assertBrowserLaunchConsumer(senderId: number, consumerId: number | null, isMainFrame: boolean): void {
  if (senderId !== consumerId || !isMainFrame) throw new ValidationError('Browser launch requires the main window')
}

/** 插件连接只传动作请求 ID，不接受 renderer 自报 pluginId。 */
export function assertPluginActionRequestId(value: unknown): string | undefined {
  return value === undefined ? undefined : assertString(value, 'pluginActionRequestId', { maxLength: 128 })
}

/** 普通克隆仅传源运行时 ID，归属由 main 从该会话推导。 */
export function assertConnectionCloneSourceId(value: unknown): string | undefined {
  return value === undefined ? undefined : assertString(value, 'sourceSessionId', { maxLength: 128 })
}

interface NumberOptions {
  min?: number
  max?: number
  integer?: boolean
}

interface ArrayOptions {
  maxItems?: number
  maxItemLength?: number
}

interface RecordOptions {
  maxItems?: number
  maxKeyLength?: number
  maxValueLength?: number
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export function validateWebTabDevToolsRequest(raw: unknown): BrowserDevToolsRequest {
  const value = assertObject(raw, 'devtoolsRequest')
  const pageId = assertNumber(value.pageId, 'pageId', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true })
  const kind = assertEnum(value.kind, 'kind', ['open', 'layout', 'close'] as const)
  const inspectorId = kind !== 'open' ? assertNumber(value.inspectorId, 'inspectorId', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true }) : undefined
  if (kind === 'close') return { kind, pageId, inspectorId: inspectorId! }
  if (kind === 'layout' && value.bounds === null) return { kind, pageId, inspectorId: inspectorId!, bounds: null }
  const bounds = assertObject(value.bounds, 'bounds')
  const parsed = {
    x: assertNumber(bounds.x, 'x', { min: -100000, max: 100000 }),
    y: assertNumber(bounds.y, 'y', { min: -100000, max: 100000 }),
    width: assertNumber(bounds.width, 'width', { min: 0, max: 100000 }),
    height: assertNumber(bounds.height, 'height', { min: 0, max: 100000 })
  }
  return kind === 'open' ? { kind, pageId, bounds: parsed } : { kind, pageId, inspectorId: inspectorId!, bounds: parsed }
}

/** POST 页签认领只收主进程发放的 UUID token 和有效 guest id。 */
export function validateWebTabPostLoadRequest(token: unknown, webContentsId: unknown):
  { token: string; webContentsId: number } | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) return null
  if (typeof webContentsId !== 'number' || !Number.isSafeInteger(webContentsId) || webContentsId < 1) return null
  return { token, webContentsId }
}

/**
 * sanitizeSessionEncoding 已上移 @shared/encoding —— 收口消费者是 repository
 * （load/saveSession），IPC 入口与它共用同一实现，此处不再自带真相源。
 */

export function assertString(value: unknown, name: string, options: StringOptions = {}): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${name} must be a string`)
  }

  if (!options.allowEmpty && value.length === 0) {
    throw new ValidationError(`${name} is required`)
  }

  if (options.maxLength && value.length > options.maxLength) {
    throw new ValidationError(`${name} is too long`)
  }

  return value
}

/** dsh 工作区 ID 校验：非空字符串，≤128。dsh:workspace:* / dsh:web:* 各处理器共用。 */
export function assertWorkspaceId(value: unknown): string {
  return assertString(value, 'workspaceId', { maxLength: 128 })
}

export function assertNumber(value: unknown, name: string, options: NumberOptions = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${name} must be a finite number`)
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new ValidationError(`${name} must be an integer`)
  }

  if (options.min !== undefined && value < options.min) {
    throw new ValidationError(`${name} is too small`)
  }

  if (options.max !== undefined && value > options.max) {
    throw new ValidationError(`${name} is too large`)
  }

  return value
}

export function assertStringArray(value: unknown, name: string, options: ArrayOptions = {}): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${name} must be an array`)
  }

  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw new ValidationError(`${name} has too many items`)
  }

  return value.map((item, index) => assertString(item, `${name}[${index}]`, {
    maxLength: options.maxItemLength
  }))
}

export function assertStringRecord(
  value: unknown,
  name: string,
  options: RecordOptions = {}
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`)
  }

  const source = value as Record<string, unknown>
  const entries = Object.entries(source)
  if (options.maxItems !== undefined && entries.length > options.maxItems) {
    throw new ValidationError(`${name} has too many items`)
  }

  const result: Record<string, string> = {}
  for (const [key, val] of entries) {
    // 空 key 会让 node-pty spawn 返回 EINVAL；NUL 会截断环境变量（C 字符串以 \0 结尾），
    // 二者在服务端直接拒绝，而非等启动时才报错。
    if (key.length === 0) {
      throw new ValidationError(`${name} key must not be empty`)
    }
    if (key.includes('\0')) {
      throw new ValidationError(`${name} key must not contain NUL`)
    }
    if (options.maxKeyLength !== undefined && key.length > options.maxKeyLength) {
      throw new ValidationError(`${name} key is too long`)
    }
    if (typeof val !== 'string') {
      throw new ValidationError(`${name}[${key}] must be a string`)
    }
    if (val.includes('\0')) {
      throw new ValidationError(`${name}[${key}] must not contain NUL`)
    }
    if (options.maxValueLength !== undefined && val.length > options.maxValueLength) {
      throw new ValidationError(`${name}[${key}] is too long`)
    }
    result[key] = val
  }
  return result
}

export function assertObject<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown, name: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`)
  }
  return value as T
}

export function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${name} must be a boolean`)
  }
  return value
}

/** 枚举字符串校验：值必须是 allowed 之一（workspace.isolation 等小枚举字段用）。 */
export function assertEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

export function normalizeTimeout(value: unknown, defaultMs: number, maxMs: number): number {
  if (value === undefined || value === null) {
    return defaultMs
  }
  return assertNumber(value, 'timeout', { min: 1, max: maxMs, integer: true })
}

export function validationFailure(error: unknown): { success: false, error: string } | null {
  if (error instanceof ValidationError) {
    log.warn('Rejected invalid IPC request:', error.message)
    return { success: false, error: error.message }
  }
  return null
}

export function invalidRequest(message: string): never {
  throw new ValidationError(message)
}

export function validateDshMarketAction(value: unknown): DshMarketAction {
  return assertEnum(value, 'market action', DSH_MARKET_ACTIONS)
}

export function failureFromError(error: unknown): { success: false, error: string } {
  return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
}

/** 启动项目标必须由设置中的稳定 ID 指定，不接受独立 cwd。 */
export function validateWorkspacePresetId(value: unknown): string {
  return assertString(value, 'workspacePresetId', { maxLength: 128 })
}

/**
 * 可省略的启动项目标：缺省 / null / 空串都表示「不引用工作目录」（启动器落在用户主目录），
 * 非空值仍走同一套 ID 校验。删除设置项后编辑启动器会以这种方式清空旧绑定。
 */
export function validateOptionalWorkspacePresetId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim().length === 0) return undefined
  return validateWorkspacePresetId(value)
}


export function validateDownloadHistoryPage(sessionId: unknown, offset: unknown): { sessionId?: string; offset: number } {
  const safeSessionId = sessionId === undefined ? undefined : assertString(sessionId, 'sessionId', { maxLength: 128 })
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) throw new ValidationError('Invalid history offset')
  return { sessionId: safeSessionId, offset: offset === undefined ? 0 : offset as number }
}

/**
 * 保存区请求只接受契约白名单。收纳的信息全部来自主进程运行态，
 * 这里只校验「指向哪个实例」——渲染层自报的 URL/标题仅用于多标签区分。
 */
export function validateTaskShelfRequest(raw: unknown): TaskShelfRequest {
  const value = assertObject(raw, 'taskShelfRequest')
  const fields: Record<string, string[]> = {
    list: ['kind'],
    capture: ['kind', 'resource', 'entryId'],
    remove: ['kind', 'id'],
    restore: ['kind', 'id'],
    rename: ['kind', 'id', 'title'],
    archive: ['kind', 'id', 'archived'],
    preferences: ['kind', 'preferences'],
    activate: ['kind', 'bootId', 'scopeId', 'requestId', 'items'],
    retryInitialization: ['kind', 'bootId', 'scopeId']
  }
  const allowed = typeof value.kind === 'string' ? fields[value.kind] : undefined
  if (!allowed || Object.keys(value).some(key => !allowed.includes(key))) throw new ValidationError('Unknown task shelf request field')
  if (value.kind === 'list') return { kind: 'list' }
  if (value.kind === 'preferences') return { kind: 'preferences', preferences: parseShelfPreferences(value.preferences) }
  if (value.kind === 'archive') return { kind: 'archive', id: assertString(value.id, 'id', { maxLength: 128 }), archived: assertBoolean(value.archived, 'archived') }
  if (value.kind === 'activate') {
    return {
      kind: 'activate',
      bootId: shelfStartupToken(value.bootId, 'bootId'),
      scopeId: shelfStartupToken(value.scopeId, 'scopeId'),
      requestId: shelfStartupToken(value.requestId, 'requestId'),
      items: parseShelfActivationItems(value.items)
    }
  }
  if (value.kind === 'retryInitialization') {
    return { kind: 'retryInitialization', bootId: shelfStartupToken(value.bootId, 'bootId'), scopeId: shelfStartupToken(value.scopeId, 'scopeId') }
  }
  if (value.kind === 'capture') {
    const resource = taskShelfResource(assertObject(value.resource, 'resource'))
    const entryId = value.entryId === undefined ? undefined : assertString(value.entryId, 'entryId', { maxLength: 128 })
    return entryId === undefined ? { kind: 'capture', resource } : { kind: 'capture', resource, entryId }
  }
  if (value.kind === 'remove' || value.kind === 'restore') {
    return { kind: value.kind, id: assertString(value.id, 'id', { maxLength: 128 }) }
  }
  if (value.kind === 'rename') {
    return {
      kind: 'rename',
      id: assertString(value.id, 'id', { maxLength: 128 }),
      title: assertString(value.title, 'title', { maxLength: 200 })
    }
  }
  throw new ValidationError('Unknown task shelf request')
}

/** 启动标识与请求 ID 都参与幂等判定：规范化首尾空白后必须非空、≤128。 */
function shelfStartupToken(value: unknown, name: string): string {
  const text = assertString(value, name, { maxLength: 128 }).trim()
  if (!text) throw new ValidationError(`${name} is required`)
  return text
}

/**
 * 一次激活最多携带仓库上限条记录（0 条合法：UI 无任务时也要能拿到空结果）；
 * 每项严格 { taskId, expectedRevision }，taskId 同批唯一，版本必须是正的安全整数。
 */
function parseShelfActivationItems(value: unknown): Array<{ taskId: string; expectedRevision: number }> {
  if (!Array.isArray(value)) throw new ValidationError('items must be an array')
  if (value.length > SHELF_ACTIVATION_LIMIT) throw new ValidationError(`items must have at most ${SHELF_ACTIVATION_LIMIT} entries`)
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidationError(`items[${index}] must be an object`)
    const entry = item as Record<string, unknown>
    if (Object.keys(entry).some(key => key !== 'taskId' && key !== 'expectedRevision')) throw new ValidationError(`items[${index}] has unknown field`)
    const taskId = assertString(entry.taskId, `items[${index}].taskId`, { maxLength: 128 }).trim()
    if (!taskId) throw new ValidationError(`items[${index}].taskId is required`)
    if (seen.has(taskId)) throw new ValidationError(`items[${index}].taskId is duplicated`)
    seen.add(taskId)
    const expectedRevision = entry.expectedRevision
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ValidationError(`items[${index}].expectedRevision must be a positive safe integer`)
    }
    return { taskId, expectedRevision }
  })
}

/** 远端持久终端开关进入配置前校验；运行期附着引用不能写进普通会话配置。 */
export function validateSshPersistence(config: import('@shared/types').SessionConfig, saved = false): void {
  if (config.type === 'local' && config.local?.terminalHostId !== undefined) {
    const id = assertString(config.local.terminalHostId, 'local.terminalHostId', { maxLength: 36 })
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new ValidationError('Invalid local terminal host')
    if (saved) delete config.local.terminalHostId
  }
  if (config.type !== 'ssh' || !config.ssh) return
  const ssh = assertObject(config.ssh, 'ssh')
  if (ssh.keepSessionAlive !== undefined) assertBoolean(ssh.keepSessionAlive, 'ssh.keepSessionAlive')
  if (ssh.resumeDirectory !== undefined) {
    const directory = normalizeSshDirectory(ssh.resumeDirectory)
    if (!directory) throw new ValidationError('Invalid SSH resume directory')
    if (saved) delete config.ssh.resumeDirectory
  }
  if (ssh.resumeSessionName !== undefined) {
    const name = assertString(ssh.resumeSessionName, 'ssh.resumeSessionName', { maxLength: 64 })
    if (!/^lyshell[-_][A-Za-z0-9_-]+$/.test(name)) throw new ValidationError('Invalid remote task session name')
    if (saved) delete config.ssh.resumeSessionName
  }
}

function taskShelfResource(value: Record<string, unknown>): ShelfResource {
  const allowed = value.kind === 'web' ? ['kind', 'id', 'url', 'title', 'post'] : ['kind', 'id']
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ValidationError('Unknown task shelf resource field')
  if (value.kind === 'terminal' || value.kind === 'harness') {
    const id = assertString(value.id, 'resource.id', { maxLength: 128 })
    return value.kind === 'terminal' ? { kind: 'terminal', id } : { kind: 'harness', id }
  }
  if (value.kind !== 'web') throw new ValidationError('Unknown task shelf resource')
  const web: Extract<ShelfResource, { kind: 'web' }> = {
    kind: 'web',
    id: assertString(value.id, 'resource.id', { maxLength: 128 }),
    // 空 URL 合法：调用方允许登记「只在当前实例有效」的页面，安全判定在主进程做。
    url: assertString(value.url, 'resource.url', { maxLength: 4096, allowEmpty: true }),
    title: assertString(value.title, 'resource.title', { maxLength: 200, allowEmpty: true })
  }
  if (value.post !== undefined) web.post = assertBoolean(value.post, 'resource.post')
  return web
}
