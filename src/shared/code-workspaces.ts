import type { HarnessWorkspace } from './harness'

/** Codex / Claude 共用的具名目录预设；worktree 在保存预设时准备。 */
export type CodeWorkspacePreset = Pick<HarnessWorkspace, 'id' | 'order' | 'name' | 'cwd' | 'isolation' | 'worktreeKey'>
/** 名称字段保留基础名；界面和会话标题统一拼接，避免反复保存后重复追加。 */
export function formatCodeWorkspaceName(workspace: Pick<CodeWorkspacePreset, 'name' | 'isolation' | 'worktreeKey'>): string {
  const suffix = workspace.isolation === 'worktree' && workspace.worktreeKey ? ` · ${workspace.worktreeKey}` : ''
  return suffix && !workspace.name.endsWith(suffix) ? workspace.name + suffix : workspace.name
}
export type CodeWorkspaceRequest =
  | { kind: 'list' }
  | { kind: 'save'; preset: Omit<CodeWorkspacePreset, 'id' | 'order'> & { id?: string } }
  | { kind: 'delete'; id: string }
  | { kind: 'launch'; id: string }
  | { kind: 'launchDirectory'; id: string; cwd: string }
/** 引用计数按「设置项 id」统计（合并别名已折算到仍存在的 id）；无启动器引用时为 0。 */
export type CodeWorkspaceUsage = Record<string, number>
export type CodeWorkspaceResult =
  | { success: true; presets: CodeWorkspacePreset[]; aliases?: Record<string, string>; usage?: CodeWorkspaceUsage }
  | { success: false; error: string }
