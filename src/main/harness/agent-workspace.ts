import { resolveWorkspaceCwd } from './cwd'
import { ensureWorktree } from './worktree'

/**
 * 通用 Agent 启动工作目录解析 —— 与 harness 工作区 / Codex·Claude 预设的 isolation 语义对齐
 * （dsh/codex/claude 共用）。自定义 Agent 在编辑时同样从 CodeWorkspacePreset 选择目录 / 隔离 /
 * worktree，只额外配置 command；启动时据此决定实际 cwd：
 *
 *   - cwd 缺省 / 空白（legacy 默认 Agent，历史记录无 cwd）：返回 undefined —— node-pty 用默认
 *     目录（现状语义不变）；
 *   - isolation = 'worktree'：在仓库根下的专属 git worktree（<仓库根>/.lyshell-worktrees/<key>）
 *     中启动，幂等创建/复用（未提交修改跨启动保留，见 harness/worktree.ts 的 ensureWorktree）；
 *   - 其余（'shared' / 缺省）：resolveWorkspaceCwd 校验「绝对 + 存在的目录」，失败拒绝启动。
 *
 * 错误（cwd 非法 / 缺 worktree key / 非 git 目录）以 ok:false 返回，调用方（agent:launch handler）
 * 据此在创建终端前拒绝 —— 不产生瞬态会话。本模块不 import Electron，可独立单测。
 */

export type AgentWorkspaceCwdResult =
  | { ok: true; cwd: string | undefined }
  | { ok: false; error: string }

/** resolveAgentWorkspaceCwd 的入参子集：Agent 记录里与工作目录决策相关的字段（结构化，不依赖仓库类型） */
export interface AgentWorkspaceSource {
  cwd?: string
  isolation?: 'shared' | 'worktree'
  worktreeKey?: string
}

export async function resolveAgentWorkspaceCwd(agent: AgentWorkspaceSource): Promise<AgentWorkspaceCwdResult> {
  // legacy：无 cwd 的旧默认 Agent 直接走 node-pty 默认目录（不因缺字段而报错）
  if (agent.cwd === undefined || agent.cwd.trim() === '') {
    if (agent.isolation === 'worktree') {
      return { ok: false, error: 'agent.cwd is required for worktree isolation' }
    }
    return { ok: true, cwd: undefined }
  }

  const base = resolveWorkspaceCwd(agent.cwd)
  if (!base.ok) {
    return { ok: false, error: base.error }
  }

  if (agent.isolation !== 'worktree') {
    return { ok: true, cwd: base.path }
  }

  // worktree 隔离：key 保存即已校验，这里兜底手改 JSON 的缺 key（不静默生成，拒绝启动）
  if (!agent.worktreeKey) {
    return { ok: false, error: 'Worktree name is required' }
  }
  const tree = await ensureWorktree(base.path, agent.worktreeKey)
  if (!tree.ok) {
    return { ok: false, error: tree.error }
  }
  return { ok: true, cwd: tree.path }
}
