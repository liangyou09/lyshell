import type { CodeWorkspacePreset } from '@shared/code-workspaces'
import { normDirKey } from './ws-dir'

/** Work Launcher 工作区树里的一棵「目录」分组。 */
export interface WorkLauncherProject {
  /** 稳定目录身份：Windows 统一斜杠并忽略大小写；POSIX 保持大小写。供 React key 与去重使用。 */
  key: string
  /** 保留的组内首个目录规范形（剥尾部分隔符、盘符根/根路径保持规范），用于展示。 */
  dir: string
  /** 同目录下去重后的预设；shared 在前，worktree 按 key 自然排序。 */
  entries: CodeWorkspacePreset[]
}

/** 目录身份键：Windows 统一斜杠 + 忽略大小写；POSIX 原样保留（区分大小写）。 */
function normalizeDirectory(cwd: string, platform: string): string {
  if (platform === 'win32') return normDirKey(cwd)
  // POSIX 的反斜杠是文件名的一部分，不作为路径分隔符裁剪。
  return cwd.replace(/\/+$/, '') || (cwd.startsWith('/') ? '/' : '')
}

function directoryKey(cwd: string, platform: string): string {
  const normalized = normalizeDirectory(cwd, platform)
  return platform === 'win32' ? normalized.replace(/\\/g, '/').toLowerCase() : normalized
}

export interface WorkLauncherAgent {
  id: string
  workspacePresetId?: string
  cwd?: string
  isolation?: 'shared' | 'worktree'
  worktreeKey?: string
}

/** 启动项与设置预设按实际目录目标匹配，不依赖显示名称。 */
export function workLauncherTargetKey(target: Pick<CodeWorkspacePreset, 'cwd' | 'isolation' | 'worktreeKey'>, platform: string): string {
  return JSON.stringify([directoryKey(target.cwd, platform), target.isolation === 'worktree' ? target.worktreeKey ?? null : null])
}

/** 已有关联以预设 ID 为准；旧快照只允许匹配设置中实际存在的目标。 */
export function findManagedWorkspace(target: WorkLauncherAgent, presets: readonly CodeWorkspacePreset[], platform: string): CodeWorkspacePreset | undefined {
  if (target.workspacePresetId) return presets.find(preset => preset.id === target.workspacePresetId)
  if (!target.cwd) return undefined
  const key = workLauncherTargetKey({ ...target, cwd: target.cwd }, platform)
  return presets.find(preset => workLauncherTargetKey(preset, platform) === key)
}

/** 同目录内的去重身份：worktree 用 worktreeKey，shared/未设 isolation 同一身份（null）。 */
function entryIdentity(preset: CodeWorkspacePreset): string | null | undefined {
  return preset.isolation === 'worktree' ? preset.worktreeKey : null
}

/** 自然排序：数字感知的 localeCompare；比较等价时以码元序兜底。 */
function naturalCompare(a: string, b: string): number {
  const diff = a.localeCompare(b, undefined, { numeric: true })
  return diff !== 0 ? diff : (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * 将预设数组按 cwd 聚成目录分组。
 * - 分组键 = 目录身份键（Windows 统一斜杠 + 忽略大小写，POSIX 区分大小写）；
 * - 同目录内按 [isolation === 'worktree' ? worktreeKey : null] 去重，保留 order 较小者、同 order 取先出现者；
 * - 组按目录自然顺序；组内 shared 在前、worktree 按 key 自然排序；
 * - group.dir = 组内首个（原始输入序）目录规范形，group.key = 稳定身份；
 * - 纯函数：不修改入参、不访问磁盘、不依赖 Node API。
 */
export function buildWorkLauncherProjects(
  presets: readonly CodeWorkspacePreset[],
  platform: string
): WorkLauncherProject[] {
  const groups = new Map<string, { dir: string; byIdentity: Map<string | null | undefined, CodeWorkspacePreset> }>()

  for (const preset of presets) {
    const key = directoryKey(preset.cwd, platform)
    let group = groups.get(key)
    if (!group) {
      group = { dir: normalizeDirectory(preset.cwd, platform), byIdentity: new Map() }
      groups.set(key, group)
    }
    const identity = entryIdentity(preset)
    const existing = group.byIdentity.get(identity)
    if (!existing || preset.order < existing.order) {
      group.byIdentity.set(identity, preset)
    }
  }

  const projects: WorkLauncherProject[] = []
  for (const [key, group] of groups) {
    const entries = Array.from(group.byIdentity.values())
    entries.sort((a, b) => {
      const aWorktree = a.isolation === 'worktree' ? 1 : 0
      const bWorktree = b.isolation === 'worktree' ? 1 : 0
      if (aWorktree !== bWorktree) return aWorktree - bWorktree
      const aSort = aWorktree ? (a.worktreeKey ?? '') : a.name
      const bSort = bWorktree ? (b.worktreeKey ?? '') : b.name
      const bySort = naturalCompare(aSort, bSort)
      if (bySort !== 0) return bySort
      const byName = naturalCompare(a.name, b.name)
      if (byName !== 0) return byName
      if (a.order !== b.order) return a.order - b.order
      return 0 // 稳定排序（ES2019+）按 Map 插入序 = 原始输入序兜底
    })
    projects.push({ key, dir: group.dir, entries })
  }

  projects.sort((a, b) => naturalCompare(a.dir, b.dir))
  return projects
}
