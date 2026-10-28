import type { ConnectionType } from './types/session'

/** 保存区持久化恢复引用，SSH 另存已显示输出的有限尾部；不复制配置凭据或重放命令。 */
export type ShelfResource =
  | { kind: 'terminal'; id: string }
  | { kind: 'web'; id: string; url: string; title: string; post?: boolean }
  | { kind: 'harness'; id: string }

export type ShelfRecovery =
  | { kind: 'terminal'; sessionId: string; sessionConfigId?: string; type: ConnectionType; cwd?: string;
      agentKind?: 'codex' | 'claude' | 'dsh' | 'agent'; agentId?: string; cliSessionId?: string; cliObservationLost?: boolean; connectionKey?: string; tmuxSession?: string; localHostId?: string }
  | { kind: 'web'; url?: string }
  | { kind: 'harness'; sessionId?: string; taskId?: string; identity?: { instanceId: string; instanceEpoch: number }; lastState?: string }

export interface TaskShelfEntry {
  id: string
  resourceKey: string
  title: string
  workspace?: string
  createdAt: number
  updatedAt: number
  revision: number
  archivedAt?: number
  /** SSH 已显示输出的本地只读尾部，不作为命令或运行态重放。 */
  context?: { text: string; capturedAt: number }
  recovery: ShelfRecovery
  capability: 'live-only' | 'local-live' | 'reconnect' | 'ssh-resume' | 'directory' | 'cli-resume' | 'cli-history' | 'web' | 'harness-history'
}

export type TaskShelfRequest =
  | { kind: 'list' }
  | { kind: 'capture'; resource: ShelfResource; entryId?: string }
  | { kind: 'remove'; id: string }
  | { kind: 'restore'; id: string }
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'archive'; id: string; archived: boolean }
  | { kind: 'preferences'; preferences: TaskShelfPreferences }

export type TaskShelfResult =
  | { success: true; entries: TaskShelfEntry[]; entry?: TaskShelfEntry; preferences?: TaskShelfPreferences;
      restored?: { kind: 'terminal'; sessionId: string } | { kind: 'web'; url: string } | Extract<ShelfRecovery, { kind: 'harness' }> }
  | { success: false; error: string }

export interface TaskShelfPreferences { toggleShortcut: string; collectShortcut: string }
export const DEFAULT_TASK_SHELF_PREFERENCES: TaskShelfPreferences = { toggleShortcut: 'Ctrl+Shift+J', collectShortcut: 'Ctrl+Shift+S' }
export type TaskShelfShortcutAction = 'toggle' | 'collect'

/** 只占用带 Shift 的应用组合键，空字符串表示禁用；不覆盖已有命令面板入口。 */
export function normalizeShelfShortcut(raw: unknown): string | null {
  if (raw === '') return ''
  if (typeof raw !== 'string' || raw.length > 32) return null
  const match = /^(ctrl|meta)\+shift\+([a-z])$/i.exec(raw.trim())
  if (!match || match[2].toUpperCase() === 'P') return null
  return `${match[1].toLowerCase() === 'ctrl' ? 'Ctrl' : 'Meta'}+Shift+${match[2].toUpperCase()}`
}
export function parseShelfPreferences(raw: unknown): TaskShelfPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid task shelf preferences')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['toggleShortcut', 'collectShortcut'].includes(key))) throw new Error('Invalid task shelf preference field')
  const toggleShortcut = normalizeShelfShortcut(value.toggleShortcut), collectShortcut = normalizeShelfShortcut(value.collectShortcut)
  if (toggleShortcut === null || collectShortcut === null || toggleShortcut && toggleShortcut === collectShortcut) throw new Error('快捷键需使用 Ctrl/Meta+Shift+字母，不能重复或占用 P；留空可禁用。')
  return { toggleShortcut, collectShortcut }
}
export function matchShelfShortcut(input: { type: string; key: string; control?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; isAutoRepeat?: boolean; isComposing?: boolean }, preferences: TaskShelfPreferences): TaskShelfShortcutAction | null {
  if (!['keyDown', 'rawKeyDown'].includes(input.type) || input.isAutoRepeat || input.isComposing || input.alt || !input.shift || !!input.control === !!input.meta) return null
  const chord = `${input.control ? 'Ctrl' : 'Meta'}+Shift+${input.key.toUpperCase()}`
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
