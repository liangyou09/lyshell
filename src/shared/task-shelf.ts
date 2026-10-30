import type { ConnectionType } from './types/session'

/** 保存区持久化恢复引用，SSH 另存已显示输出的有限尾部；不复制配置凭据或重放命令。 */
export type ShelfResource =
  | { kind: 'terminal'; id: string }
  | { kind: 'web'; id: string; url: string; title: string; post?: boolean; readonlyMode?: true; reloadableMode?: true }
  | { kind: 'harness'; id: string }

export type ShelfRecovery =
  | { kind: 'terminal'; sessionId: string; sessionConfigId?: string; type: ConnectionType; cwd?: string;
      agentKind?: 'codex' | 'claude' | 'dsh' | 'agent'; agentId?: string; cliSessionId?: string; cliObservationLost?: boolean; connectionKey?: string; tmuxSession?: string; localHostId?: string }
  | { kind: 'web'; url?: string; readonlyMode?: true; reloadableMode?: true; sleep?: ShelfWebSleep }
  | { kind: 'harness'; sessionId?: string; taskId?: string; identity?: { instanceId: string; instanceEpoch: number }; lastState?: string }

export interface ShelfWebSleep {
  formatVersion: 1; recordedAt: number; taskId: string; resourceId: string; suspendOperationId: string;
  url: string; partition: string; zoom: number; scrollY: number
}

export interface TaskShelfEntry {
  id: string
  resourceKey: string
  title: string
  workspace?: string
  createdAt: number
  updatedAt: number
  revision: number
  archivedAt?: number
  /** 退出时未手动保存的终端恢复记录；与归档分类互斥，不占手动保存名额。 */
  trashedAt?: number
  /** SSH 已显示输出的本地只读尾部，不作为命令或运行态重放。 */
  context?: { text: string; capturedAt: number }
  recovery: ShelfRecovery
  capability: 'live-only' | 'local-live' | 'reconnect' | 'ssh-resume' | 'directory' | 'cli-resume' | 'cli-history' | 'web' | 'harness-history'
}

/** 启动归档状态：bootId/scopeId 标识本次运行与唯一保存仓库；ready 才能安全分类。 */
export interface TaskShelfStartup {
  bootId: string
  scopeId: string
  status: 'ready' | 'blocked'
  archiveOnBoot: boolean
  error?: string
}

/** 每项激活只有一种结果；分类失败与资源恢复失败分开计数。 */
export type ShelfClassificationStatus = 'moved' | 'alreadyTasks' | 'conflict' | 'missing' | 'failed'

export interface TaskShelfActivation {
  requestId: string
  items: Array<{ taskId: string; status: ShelfClassificationStatus }>
  total: number
  moved: number
  alreadyTasks: number
  conflict: number
  missing: number
  failed: number
}

/** 一次激活请求最多带仓库上限条记录，避免分批改变点击时的集合。 */
export const SHELF_ACTIVATION_LIMIT = 100
/** 回收站只保留最近的未保存终端，不驱逐手动保存的 Tasks / Archive。 */
export const TASK_SHELF_TRASH_LIMIT = 12

export type TaskShelfRequest =
  | { kind: 'list' }
  | { kind: 'capture'; resource: ShelfResource; entryId?: string }
  | { kind: 'remove'; id: string }
  | { kind: 'restore'; id: string }
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'archive'; id: string; archived: boolean }
  /** 归档区「全部移回 Tasks」：只改列表归属，不恢复任何实例。 */
  | { kind: 'unarchiveAll' }
  | { kind: 'preferences'; preferences: TaskShelfPreferences }
  | { kind: 'activate'; bootId: string; scopeId: string; requestId: string; items: Array<{ taskId: string; expectedRevision: number }> }
  | { kind: 'retryInitialization'; bootId: string; scopeId: string }

export type TaskShelfResult =
  | { success: true; entries: TaskShelfEntry[]; entry?: TaskShelfEntry; preferences?: TaskShelfPreferences;
      restored?: { kind: 'terminal'; sessionId: string } | { kind: 'web'; url: string } | Extract<ShelfRecovery, { kind: 'harness' }>
      startup?: TaskShelfStartup; activation?: TaskShelfActivation }
  | { success: false; error: string; code?: string; startup?: TaskShelfStartup }

export interface TaskShelfPreferences { toggleShortcut: string; collectShortcut: string }
/** 展开默认用 Ctrl+`：不占用带 Shift 的字母组合，也就避开了命令面板的 Ctrl+Shift+P。 */
export const DEFAULT_TASK_SHELF_PREFERENCES: TaskShelfPreferences = { toggleShortcut: 'Ctrl+`', collectShortcut: 'Ctrl+Shift+S' }
/** 旧版默认值；只在加载已保存偏好时迁移，用户显式输入同值仍算自定义。 */
export const LEGACY_TASK_SHELF_TOGGLE_SHORTCUT = 'Ctrl+Shift+J'
export type TaskShelfShortcutAction = 'toggle' | 'collect'

/** 反引号的字符写法与物理键位 code：key 随键盘布局变化，code 恒定。 */
const SHELF_BACKQUOTE_KEY = '`'
const SHELF_BACKQUOTE_CODE = 'Backquote'

function shelfShortcutModifier(modifier: string): 'Ctrl' | 'Meta' {
  return modifier.toLowerCase() === 'ctrl' ? 'Ctrl' : 'Meta'
}

/**
 * 规范化快捷键：Ctrl/Meta+` 或 Ctrl/Meta+Shift+字母，空字符串表示禁用。
 * 反引号同时接受字符与物理键名（Backquote）两种写法，统一存成字符形式；
 * Shift 的反引号是 '~'，不属于合法快捷键。命令面板占用 Ctrl+Shift+P。
 */
export function normalizeShelfShortcut(raw: unknown): string | null {
  if (raw === '') return ''
  if (typeof raw !== 'string' || raw.length > 32) return null
  const text = raw.trim()
  const backquote = /^(ctrl|meta)\+(`|backquote)$/i.exec(text)
  if (backquote) return `${shelfShortcutModifier(backquote[1])}+${SHELF_BACKQUOTE_KEY}`
  const match = /^(ctrl|meta)\+shift\+([a-z])$/i.exec(text)
  if (!match || match[2].toUpperCase() === 'P') return null
  return `${shelfShortcutModifier(match[1])}+Shift+${match[2].toUpperCase()}`
}
export function parseShelfPreferences(raw: unknown): TaskShelfPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid task shelf preferences')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['toggleShortcut', 'collectShortcut'].includes(key))) throw new Error('Invalid task shelf preference field')
  const toggleShortcut = normalizeShelfShortcut(value.toggleShortcut), collectShortcut = normalizeShelfShortcut(value.collectShortcut)
  if (toggleShortcut === null || collectShortcut === null || toggleShortcut && toggleShortcut === collectShortcut) throw new Error('快捷键需使用 Ctrl/Meta+` 或 Ctrl/Meta+Shift+字母，不能重复或占用 P；留空可禁用。')
  return { toggleShortcut, collectShortcut }
}

/** before-input-event / DOM KeyboardEvent 共用的按键形状；code 可选，缺失时退回 key。 */
export interface ShelfShortcutInput {
  type: string
  key: string
  /** 物理键位（DOM/Electron 同名同义，如 'Backquote'、'KeyJ'） */
  code?: string
  control?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
  isAutoRepeat?: boolean
  isComposing?: boolean
}

/**
 * 匹配快捷键：只认首按（keyUp、长按重复不是新意图），让位 IME 组合，
 * 拒绝 Alt 与 Ctrl+Meta 同按。反引号按物理键位 Backquote 识别——非 US 布局下
 * 该键的 key 是 '^' 等字符，只有 code 能保证 Ctrl+` 始终落在同一个键上。
 */
export function matchShelfShortcut(input: ShelfShortcutInput, preferences: TaskShelfPreferences): TaskShelfShortcutAction | null {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null
  if (input.isAutoRepeat || input.isComposing || input.alt) return null
  // 必须恰好一个主修饰键：Ctrl+Meta 同按是组合输入，不触发任何动作。
  if (!!input.control === !!input.meta) return null
  const modifier = input.control ? 'Ctrl' : 'Meta'
  const code = typeof input.code === 'string' ? input.code : ''
  // 有 code 时只认物理键位，避免把 Quote/Numpad 等键上的 '`' 当成反引号。
  if (!input.shift && (code === SHELF_BACKQUOTE_CODE || (!code && input.key === SHELF_BACKQUOTE_KEY))) {
    const chord = `${modifier}+${SHELF_BACKQUOTE_KEY}`
    if (preferences.toggleShortcut && preferences.toggleShortcut === chord) return 'toggle'
    return preferences.collectShortcut && preferences.collectShortcut === chord ? 'collect' : null
  }
  const key = input.key.toLowerCase()
  if (!input.shift || !/^[a-z]$/.test(key)) return null
  const chord = `${modifier}+Shift+${key.toUpperCase()}`
  if (preferences.toggleShortcut && preferences.toggleShortcut === chord) return 'toggle'
  return preferences.collectShortcut && preferences.collectShortcut === chord ? 'collect' : null
}

/** POST、后台登录入口和可能携带凭据的地址，只保留当前实例。 */
export function shelfWebUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 4096) return undefined
    if (url.search || url.hash || /^(localhost|127\..*|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)) return undefined
    if (/(?:^|\/)(?:auth|oauth|callback|login|logout|signin|token|session)(?:\/|$)/i.test(url.pathname)) return undefined
    if (url.pathname.split('/').some(part => /^[a-zA-Z0-9_-]{40,}$/.test(part))) return undefined
    return url.href
  } catch { return undefined }
}
