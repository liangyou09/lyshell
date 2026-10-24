import { create } from 'zustand'
import { formatCodeWorkspaceName, type CodeWorkspacePreset } from '@shared/code-workspaces'
import type { ProjectScene, SceneNode, SceneTarget } from '@shared/project-scene'
import { workLauncherTargetKey } from '../components/Layout/work-launcher-tree'

export const sceneTargetKey = (target: SceneTarget) => workLauncherTargetKey(target, window.electronAPI?.platform ?? '')

export const presetSceneTarget = (preset: CodeWorkspacePreset): SceneTarget => ({ presetId: preset.id, cwd: preset.cwd, isolation: preset.isolation, worktreeKey: preset.worktreeKey })
export const sameSceneProject = (a: SceneTarget, b: SceneTarget) => a.presetId === b.presetId && sceneTargetKey(a) === sceneTargetKey(b)
export const sceneResourceCount = (node: SceneNode): number => node.type === 'leaf' ? node.entries.length : sceneResourceCount(node.first) + sceneResourceCount(node.second)
export function sceneProjectName(target: SceneTarget, presets: readonly CodeWorkspacePreset[]): string {
  const preset = presets.find(item => sameSceneProject(presetSceneTarget(item), target))
  if (preset) return formatCodeWorkspaceName(preset)
  const base = target.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || target.cwd
  return `${base}${target.worktreeKey ? ` · ${target.worktreeKey}` : ''}`
}
export function shortSceneDirectory(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}
export interface SceneNotice { kind: 'saved' | 'restored' | 'focused' | 'empty' | 'error'; count?: number; issues: string[] }
interface SceneUIStore {
  loaded: boolean
  presets: CodeWorkspacePreset[]
  scenes: ProjectScene[]
  selected: SceneTarget | null
  busy: boolean
  notice: SceneNotice | null
  menu: 'projects' | 'history' | null
  refresh: (force?: boolean) => Promise<void>
  select: (target: SceneTarget) => void
  openMenu: (menu: 'projects' | 'history' | null, target?: SceneTarget) => void
  save: (target: SceneTarget) => Promise<void>
  continue: (scene: ProjectScene) => Promise<void>
}
let refreshTask: Promise<void> | null = null
let archiveRevision = 0
export const useProjectSceneUI = create<SceneUIStore>((set, get) => ({
  loaded: false, presets: [], scenes: [], selected: null, busy: false, notice: null, menu: null,
  refresh: async (force = false) => {
    if (refreshTask) return refreshTask
    if (get().loaded && !force) return
    // 旧测试宿主/不具备现场 IPC 的视图不显示一个无法使用的控制面。
    if (!window.electronAPI?.projectSceneRequest) { set({ loaded: true }); return }
    const revision = archiveRevision
    refreshTask = (async () => {
      try {
        const [projects, archive] = await Promise.all([window.electronAPI.codeWorkspaceRequest({ kind: 'list' }), window.electronAPI.projectSceneRequest({ kind: 'list' })])
        if (!projects.success) throw new Error(projects.error)
        if (!archive.success) throw new Error(archive.error)
        const selected = get().selected ?? archive.scenes[0]?.target ?? (projects.presets[0] ? presetSceneTarget(projects.presets[0]) : null)
        set({ presets: projects.presets, ...(revision === archiveRevision ? { scenes: archive.scenes } : {}), selected, loaded: true, ...(get().notice?.kind === 'error' ? { notice: null } : {}) })
      } catch (error) { set({ loaded: true, notice: { kind: 'error', issues: [(error as Error).message] } }) }
    })().finally(() => { refreshTask = null })
    return refreshTask
  },
  select: selected => set({ selected, notice: null }),
  openMenu: (menu, target) => set({ menu, ...(target ? { selected: target } : {}) }),
  save: async target => {
    if (get().busy) return
    set({ busy: true, selected: target, notice: null })
    try {
      const { saveCurrentProjectScene } = await import('./project-scene')
      const result = await saveCurrentProjectScene(target)
      archiveRevision++
      set({ scenes: result.scenes, notice: { kind: 'saved', issues: result.issues }, menu: null })
    } catch (error) { set({ notice: { kind: 'error', issues: [(error as Error).message] } }) }
    finally { set({ busy: false }) }
  },
  continue: async scene => {
    if (get().busy) return
    set({ busy: true, selected: scene.target, notice: null })
    try {
      const response = await window.electronAPI.projectSceneRequest({ kind: 'restore', id: scene.id })
      if (!response.success || !response.scene) throw new Error(response.success ? '找不到保存的现场' : response.error)
      const { restoreProjectScene } = await import('./project-scene')
      const result = await restoreProjectScene(response.scene)
      const focused = 'focused' in result && result.focused
      set({ menu: null, notice: { kind: result.restored ? 'restored' : focused ? 'focused' : 'empty', count: result.restored, issues: [...response.issues, ...result.issues] } })
    } catch (error) { set({ notice: { kind: 'error', issues: [(error as Error).message] } }) }
    finally { set({ busy: false }) }
  }
}))
