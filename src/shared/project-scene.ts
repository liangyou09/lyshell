import type { CodeWorkspacePreset } from './code-workspaces'
import { validateWorktreeKey } from './worktree'

export type SceneTarget = Pick<CodeWorkspacePreset, 'cwd' | 'isolation' | 'worktreeKey'> & { presetId: string }
export type SceneEntry =
  | { kind: 'directory' }
  | { kind: 'agent'; agentKind: 'codex' | 'claude' | 'dsh' | 'agent'; agentId: string }
  | { kind: 'doc'; path: string }
  | { kind: 'web'; url: string }
export type SceneNode =
  | { type: 'leaf'; entries: SceneEntry[]; active: number }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; first: SceneNode; second: SceneNode }
/** 无运行态、命令、环境变量、文档内容、网页标题或后台身份。 */
export interface ProjectScene {
  version: 1
  id: string
  savedAt: number
  target: SceneTarget
  directory: string
  root: SceneNode
  activeLeaf: number
}
export type ProjectSceneRequest =
  | { kind: 'list' }
  | { kind: 'inspect'; target: SceneTarget }
  | { kind: 'describe'; target: SceneTarget; entry: SceneEntry }
  | { kind: 'save'; target: SceneTarget; root: SceneNode; activeLeaf: number }
  | { kind: 'restore'; id: string }
  | { kind: 'launch'; target: SceneTarget; entry: SceneEntry; resume: boolean }
export type ProjectSceneResult =
  | { success: false; error: string }
  | { success: true; scenes: ProjectScene[]; scene?: ProjectScene; issues: string[]; cwd?: string; projectName?: string; entryName?: string; sessionId?: string }

/** 故意保守：只保存无参数的普通 HTTP(S) 入口；拒绝本机后台、认证及一次性路径。 */
export function sceneWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host) || /^\[::ffff:7f[0-9a-f]{2}:/.test(host)) return null
    if (/(?:auth|oauth|login|signin|callback|token|secret|session|verify|reset|invite|magic|credential|logout|saml|ticket|nonce|sso|signed)/i.test(decodeURIComponent(url.pathname))) return null
    // 具有长随机段的地址也按一次性入口处理。
    if (url.pathname.split('/').some(segment => segment.length > 48)) return null
    return url.href
  } catch { return null }
}

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid project scene object')
  return raw as Record<string, unknown>
}
function string(raw: unknown, max = 4096): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || Array.from(raw).some(char => char.charCodeAt(0) < 32)) throw new Error('Invalid project scene reference')
  return raw
}
export function parseSceneTarget(raw: unknown): SceneTarget {
  const value = object(raw)
  const cwd = string(value.cwd)
  const presetId = string(value.presetId, 128)
  if (value.isolation !== undefined && value.isolation !== 'shared' && value.isolation !== 'worktree') throw new Error('Invalid project isolation')
  if (value.isolation === 'worktree') {
    const key = validateWorktreeKey(string(value.worktreeKey, 64))
    if (!key.ok) throw new Error(key.error)
    return { presetId, cwd, isolation: 'worktree', worktreeKey: key.value }
  }
  return { presetId, cwd, isolation: 'shared' }
}
export function parseSceneEntry(raw: unknown): SceneEntry {
  const value = object(raw)
  if (value.kind === 'directory') return { kind: 'directory' }
  if (value.kind === 'agent' && ['agent', 'codex', 'claude', 'dsh'].includes(String(value.agentKind))) {
    return { kind: 'agent', agentKind: value.agentKind as 'agent' | 'codex' | 'claude' | 'dsh', agentId: string(value.agentId, 128) }
  }
  if (value.kind === 'doc') return { kind: 'doc', path: string(value.path) }
  if (value.kind === 'web') {
    const url = sceneWebUrl(string(value.url))
    if (url) return { kind: 'web', url }
  }
  throw new Error('Unsupported or sensitive project scene resource')
}
export function parseSceneNode(raw: unknown): SceneNode {
  let count = 0
  let entries = 0
  const parse = (rawNode: unknown, depth: number): SceneNode => {
    if (++count > 63 || depth > 6) throw new Error('Project scene layout is too large')
    const node = object(rawNode)
    if (node.type === 'leaf') {
      if (!Array.isArray(node.entries) || (entries += node.entries.length) > 128) throw new Error('Too many project scene resources')
      if (!Number.isInteger(node.active) || Number(node.active) < -1 || Number(node.active) >= node.entries.length) throw new Error('Invalid project scene active tab')
      return { type: 'leaf', entries: node.entries.map(parseSceneEntry), active: Number(node.active) }
    }
    if (node.type !== 'split' || !['horizontal', 'vertical'].includes(String(node.direction)) || typeof node.ratio !== 'number' || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) throw new Error('Invalid project scene split')
    return { type: 'split', direction: node.direction as 'horizontal' | 'vertical', ratio: node.ratio, first: parse(node.first, depth + 1), second: parse(node.second, depth + 1) }
  }
  return parse(raw, 0)
}
export function parseProjectScene(raw: unknown): ProjectScene {
  const value = object(raw)
  if (value.version !== 1) throw new Error('Unsupported project scene version')
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt < 0) throw new Error('Invalid project scene timestamp')
  if (!Number.isInteger(value.activeLeaf) || Number(value.activeLeaf) < 0 || Number(value.activeLeaf) > 31) throw new Error('Invalid project scene active pane')
  return { version: 1, id: string(value.id, 128), savedAt: value.savedAt, target: parseSceneTarget(value.target), directory: string(value.directory), root: parseSceneNode(value.root), activeLeaf: Number(value.activeLeaf) }
}
