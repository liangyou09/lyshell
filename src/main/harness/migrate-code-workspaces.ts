import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HarnessWorkspaceRepository } from '../storage/harness-workspace-repository'
import { atomicWriteFileSync } from '../storage/repository'
import { expandTilde } from './cwd'
import { launchResolveSerializer } from './task-serializer'
import { validateWorktreeKey } from '@shared/worktree'
import type { CodeWorkspacePreset } from '@shared/code-workspaces'
import { formatCodeWorkspaceName } from '@shared/code-workspaces'

interface LegacySource {
  kind: 'codex' | 'claude'
  repository: HarnessWorkspaceRepository
}

const directoryKey = (cwd: string): string => {
  const path = resolve(expandTilde(cwd))
  return process.platform === 'win32' ? path.toLowerCase() : path
}

const sameTarget = (a: Omit<CodeWorkspacePreset, 'id' | 'order'>, b: CodeWorkspacePreset): boolean =>
  directoryKey(a.cwd) === directoryKey(b.cwd) &&
  (a.isolation === 'worktree') === (b.isolation === 'worktree') &&
  (a.isolation !== 'worktree' || a.worktreeKey === b.worktreeKey)

/**
 * 一次性导入旧工作区的目录配置。保留原启动记录，不移动/创建 worktree。
 * 先保存预设，全部成功后再写标记；失败重试按确定性名称复用已导入项。
 * 标记独立于预设库，避免用户删除预设后再次启动时被重新导入。
 */
export async function migrateCodeWorkspacePresets(
  destination: HarnessWorkspaceRepository,
  sources: LegacySource[],
  markerPath: string
): Promise<void> {
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { version?: unknown }
    if (marker.version !== 1) throw new Error('Unknown workspace preset migration marker')
    return
  }
  for (const source of sources) {
    for (const snapshot of source.repository.getAll()) {
      // 与原工作区启动期的 key 回填/迁移共用锁，在锁内重新读取，避免迁移到过时的树。
      await launchResolveSerializer(`${source.kind}:${snapshot.id}`, async () => {
        let workspace = source.repository.get(snapshot.id)
        if (!workspace) return
        if (workspace.isolation === 'worktree' && !workspace.worktreeKey) {
          // 老配置的实际身份是 <kind>-<id>；固定该 key，原启动入口和新预设继续共用原树。
          const key = validateWorktreeKey(`${source.kind}-${workspace.id}`)
          if (!key.ok) throw new Error(key.error)
          workspace = { ...workspace, worktreeKey: key.value }
          if (!source.repository.update(workspace)) throw new Error('Could not preserve legacy worktree identity')
        }
        const preset = {
          name: workspace.name.trim() || source.kind,
          cwd: workspace.cwd,
          isolation: workspace.isolation === 'worktree' ? 'worktree' as const : 'shared' as const,
          worktreeKey: workspace.isolation === 'worktree' ? workspace.worktreeKey : undefined
        }
        const existing = destination.getAll()
        if (existing.some(item => sameTarget(preset, item))) return
        const base = preset.name.slice(0, 120)
        let name = base
        let sequence = 1
        let collision = existing.find(item => formatCodeWorkspaceName(item) === formatCodeWorkspaceName({ ...preset, name }))
        while (collision) {
          if (sameTarget(preset, collision)) return
          sequence++
          const suffix = ` (${sequence})`
          name = `${base.slice(0, 120 - suffix.length)}${suffix}`
          collision = existing.find(item => formatCodeWorkspaceName(item) === formatCodeWorkspaceName({ ...preset, name }))
        }
        if (!destination.add({ ...preset, name })) throw new Error('Could not import workspace preset; retry to continue')
      })
    }
  }
  atomicWriteFileSync(markerPath, JSON.stringify({ version: 1 }, null, 2))
}
