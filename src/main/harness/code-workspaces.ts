import { formatCodeWorkspaceName, type CodeWorkspacePreset, type CodeWorkspaceRequest, type CodeWorkspaceResult } from '@shared/code-workspaces'
import { codeWorkspacePresetRepository } from '../storage/harness-workspace-repository'
import { getConfigDir } from '../storage/repository'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { ensureManagedWorkspaces, isWorkspaceReferenced } from './workspace-governance'
import { resolveWorkspaceCwd } from './cwd'
import { ensureWorktree } from './worktree'
import { createTaskSerializer } from './task-serializer'
import { codeWorkspaceTargetKey, normalizeCodeWorkspaces } from './normalize-code-workspaces'

const repository = codeWorkspacePresetRepository
const serialize = createTaskSerializer()

export async function requestCodeWorkspaces(
  request: CodeWorkspaceRequest,
  launch?: (workspace: CodeWorkspacePreset, cwd: string) => Promise<void>
): Promise<CodeWorkspaceResult> {
  return serialize('presets', async () => {
    const result = (): CodeWorkspaceResult => {
      const aliases = normalizeCodeWorkspaces(repository, join(getConfigDir(), 'code-workspace-presets-merge.json'))
      return { success: true, presets: repository.getAll(), ...(Object.keys(aliases).length ? { aliases } : {}) }
    }
    try { await ensureManagedWorkspaces() }
    catch (error) { return { success: false, error: `Could not prepare managed workspaces: ${error instanceof Error ? error.message : String(error)}` } }
    // 也整理已经完成旧版导入的配置；后续新增/编辑仍按同一目标规则去重。
    const initial = result()
    if (request.kind === 'list') return initial
    if (request.kind === 'launch' || request.kind === 'launchDirectory') {
      if (!launch) return { success: false, error: 'Workspace terminal launcher is unavailable' }
      const workspace = repository.get(initial.success && initial.aliases?.[request.id] || request.id)
      if (!workspace) return { success: false, error: 'Workspace preset not found' }
      const cwd = resolveWorkspaceCwd(workspace.cwd)
      if (!cwd.ok) return { success: false, error: cwd.error }
      if (request.kind === 'launchDirectory') {
        const directory = resolveWorkspaceCwd(request.cwd)
        if (!directory.ok) return { success: false, error: directory.error }
        // 目录树的启动入口只接受已保存路径本身或其祖先；不能借预设 ID 启动任意目录。
        const child = relative(directory.path, cwd.path)
        if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
          return { success: false, error: 'Launch directory must be the workspace directory or one of its parents' }
        }
        await launch({ ...workspace, name: basename(directory.path) || directory.path, isolation: 'shared', worktreeKey: undefined }, directory.path)
        return result()
      }
      let launchCwd = cwd.path
      if (workspace.isolation === 'worktree') {
        if (!workspace.worktreeKey) return { success: false, error: 'Worktree name is required' }
        const tree = await ensureWorktree(cwd.path, workspace.worktreeKey)
        if (!tree.ok) return { success: false, error: tree.error }
        launchCwd = tree.path
      }
      await launch(workspace, launchCwd)
      return result()
    }
    if (request.kind === 'delete') {
      if (isWorkspaceReferenced(request.id)) return { success: false, error: 'Workspace is used by launchers. Reassign or delete those launchers first.' }
      if (!repository.get(request.id) || !repository.delete(request.id)) return { success: false, error: 'Workspace preset could not be deleted' }
      // 删除配置不删除 worktree 或分支，保留其中的改动。
      return result()
    }
    const { id, ...preset } = request.preset
    const current = id ? repository.get(id) : undefined
    if (id && !current) return { success: false, error: 'Workspace preset not found' }
    const cwd = resolveWorkspaceCwd(preset.cwd)
    if (!cwd.ok) return { success: false, error: cwd.error }
    const value = { ...preset, cwd: cwd.path }
    const target = codeWorkspaceTargetKey(value)
    if (repository.getAll().some(item => item.id !== id && codeWorkspaceTargetKey(item) !== target && formatCodeWorkspaceName(item) === formatCodeWorkspaceName(value))) return { success: false, error: 'Choose a distinct workspace name' }
    if (preset.isolation === 'worktree') {
      if (!preset.worktreeKey) return { success: false, error: 'Worktree name is required' }
      const tree = await ensureWorktree(cwd.path, preset.worktreeKey)
      if (!tree.ok) return { success: false, error: tree.error }
    }
    if (!current && repository.getAll().some(item => codeWorkspaceTargetKey(item) === target)) return result()
    const saved = current ? repository.update({ ...current, ...value }) : repository.add(value)
    if (!saved) return { success: false, error: 'Could not save workspace preset; any prepared worktree is retained and can be reused' }
    return result()
  })
}
