import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ProjectSceneRequest, ProjectSceneResult, SceneEntry, SceneNode, SceneTarget } from '@shared/project-scene'
import { docKindFromPath } from '@shared/types/doc'
import { WORKTREE_DIR } from '@shared/worktree'
import { codeWorkspaceTargetKey } from './normalize-code-workspaces'
import { codeWorkspacePresetRepository } from '../storage/harness-workspace-repository'
import { ProjectSceneRepository } from '../storage/project-scene-repository'
import { resolveWorkspaceCwd } from './cwd'
import { listWorktreeKeys } from './worktree'

export async function sceneTargetCwd(target: SceneTarget): Promise<string> {
  const current = codeWorkspacePresetRepository.get(target.presetId)
  if (!current) throw new Error('项目目录预设已删除；资源仍可恢复，请在设置中重新关联目录。')
  if (codeWorkspaceTargetKey(current) !== codeWorkspaceTargetKey(target)) throw new Error('目录预设已移动或 worktree 已变更；未替换为其他项目。')
  const resolved = resolveWorkspaceCwd(target.cwd)
  if (!resolved.ok) throw new Error(`项目目录不可用：${target.cwd}`)
  // 只读取现有 worktree，恢复不得创建分支、worktree 或迁移目录。
  let cwd = resolved.path
  if (target.isolation === 'worktree') {
    const trees = await listWorktreeKeys(resolved.path)
    if (!trees.ok || !trees.keys.includes(target.worktreeKey!)) throw new Error('原 worktree 未登记或已删除；恢复不会重建它。')
    cwd = join(trees.worktreeRoot, target.worktreeKey!)
  }
  if (!statSync(cwd).isDirectory()) throw new Error(`工作目录不可用：${cwd}`)
  const latest = codeWorkspacePresetRepository.get(target.presetId)
  if (!latest || codeWorkspaceTargetKey(latest) !== codeWorkspaceTargetKey(target)) throw new Error('检查期间目录预设已变更，请重试。')
  return cwd
}
export function sceneDocAllowed(path: string, cwd: string): boolean {
  try {
    const child = relative(realpathSync(resolve(cwd)), realpathSync(resolve(path)))
    return isAbsolute(path) && !!docKindFromPath(path) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child) && !child.split(/[\\/]/).some(segment => segment.toLowerCase() === WORKTREE_DIR)
  } catch { return false }
}
export interface SceneLauncher {
  check(target: SceneTarget, entry: Extract<SceneEntry, { kind: 'agent' }>): Promise<void>
  describe?(target: SceneTarget, entry: SceneEntry): string
  launch(target: SceneTarget, entry: SceneEntry, resume: boolean): Promise<{ sessionId?: string } | void>
}
export async function requestProjectScene(request: ProjectSceneRequest, launcher: SceneLauncher, repository = new ProjectSceneRepository()): Promise<ProjectSceneResult> {
  try {
    if (request.kind === 'list') return { success: true, scenes: repository.list(), issues: [] }
    if (request.kind === 'inspect') return { success: true, scenes: repository.list(), issues: [], cwd: await sceneTargetCwd(request.target) }
    if (request.kind === 'describe') {
      const project = codeWorkspacePresetRepository.get(request.target.presetId)
      if (!project || codeWorkspaceTargetKey(project) !== codeWorkspaceTargetKey(request.target)) throw new Error('原项目预设已删除或变更')
      return { success: true, scenes: [], issues: [], projectName: project.name, entryName: launcher.describe?.(request.target, request.entry) }
    }
    if (request.kind === 'launch') {
      await sceneTargetCwd(request.target)
      if (request.entry.kind === 'agent') await launcher.check(request.target, request.entry)
      const launched = await launcher.launch(request.target, request.entry, request.resume)
      return { success: true, scenes: [], issues: [], ...(launched?.sessionId ? { sessionId: launched.sessionId } : {}) }
    }
    if (request.kind === 'save') {
      const cwd = await sceneTargetCwd(request.target)
      const validate = async (node: SceneNode): Promise<void> => {
        if (node.type === 'split') { await validate(node.first); await validate(node.second); return }
        for (const entry of node.entries) {
          if (entry.kind === 'doc' && !sceneDocAllowed(entry.path, cwd)) throw new Error('文档必须位于所选项目的实际工作目录内。')
        }
      }
      await validate(request.root)
      const scene = repository.save({ target: request.target, directory: cwd, root: request.root, activeLeaf: request.activeLeaf })
      return { success: true, scenes: repository.list(), scene, issues: [] }
    }
    const scene = repository.list().find(item => item.id === request.id)
    if (!scene) throw new Error('找不到保存的项目现场。')
    const issues: string[] = []
    let cwd: string | null = null
    try { cwd = await sceneTargetCwd(scene.target) } catch (error) { issues.push((error as Error).message) }
    // 目录/预设失效时仍校验原始目录内的文档，绝不重定向到新目录。
    const originalCwd = scene.directory
    const filter = async (node: SceneNode): Promise<SceneNode> => {
      if (node.type === 'split') return { ...node, first: await filter(node.first), second: await filter(node.second) }
      const entries: SceneEntry[] = []
      let active = -1
      for (const [index, entry] of node.entries.entries()) {
        try {
          if (entry.kind === 'doc') {
            if (!sceneDocAllowed(entry.path, cwd ?? originalCwd) || !statSync(entry.path).isFile()) throw new Error('文档已删除或不在项目目录内')
          } else if (entry.kind === 'directory' || entry.kind === 'agent') {
            if (!cwd) throw new Error('目录引用失效')
            if (entry.kind === 'agent') await launcher.check(scene.target, entry)
          }
          if (index === node.active) active = entries.length
          entries.push(entry)
        } catch (error) { issues.push(`${entry.kind === 'doc' ? entry.path : entry.kind === 'agent' ? `${entry.agentKind}:${entry.agentId}` : scene.target.cwd}：${(error as Error).message}`) }
      }
      return { type: 'leaf', entries, active: active >= 0 ? active : entries.length ? 0 : -1 }
    }
    return { success: true, scenes: repository.list(), scene: { ...scene, root: await filter(scene.root) }, issues }
  } catch (error) { return { success: false, error: (error as Error).message } }
}
