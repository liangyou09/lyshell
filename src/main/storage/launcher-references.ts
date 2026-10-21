import type { HarnessWorkspace } from '@shared/harness'
import { agentRepository, type AgentConfig } from './agent-repository'
import { claudeWorkspaceRepository, codexWorkspaceRepository, dshWorkspaceRepository } from './harness-workspace-repository'

/**
 * 启动器库的跨库引用清理。
 *
 * 删除变量组（env-profile）或设置项（code-workspace preset）时，引用它们的启动器必须原地解除
 * 绑定而不是被拒绝、更不能被删除。四份库各自原子写，任何一步失败都要回到操作前的整库快照，
 * 不能留下一半清空、一半还悬空的状态 —— 悬空绑定会让启动器在下一次读取时被当成"未引用"，
 * 静默改变用户的启动目录。
 */
export interface LauncherSnapshot {
  agents: AgentConfig[]
  dsh: HarnessWorkspace[]
  codex: HarnessWorkspace[]
  claude: HarnessWorkspace[]
}

/** 一次引用释放的结果：ok 时 restore 用于在后续步骤失败时回滚，返回回滚失败描述（成功回滚返回 undefined）。 */
export type ReferenceRelease =
  | { ok: true; restore: () => string | undefined }
  | { ok: false; error: string }

export function snapshotLaunchers(): LauncherSnapshot {
  return {
    agents: agentRepository.getAll(),
    dsh: dshWorkspaceRepository.getAll(),
    codex: codexWorkspaceRepository.getAll(),
    claude: claudeWorkspaceRepository.getAll()
  }
}

/** 整库写入（只写传入的库）；返回落盘失败的库名，调用方据此决定回滚。 */
export function replaceLaunchers(next: Partial<LauncherSnapshot>): string[] {
  const failed: string[] = []
  if (next.agents && !agentRepository.replaceAll(next.agents)) failed.push('agents')
  if (next.dsh && !dshWorkspaceRepository.replaceAll(next.dsh, { preserveOrder: true })) failed.push('dsh')
  if (next.codex && !codexWorkspaceRepository.replaceAll(next.codex, { preserveOrder: true })) failed.push('codex')
  if (next.claude && !claudeWorkspaceRepository.replaceAll(next.claude, { preserveOrder: true })) failed.push('claude')
  return failed
}

/** 尽力回滚到快照；返回回滚失败的库名（空数组 = 已完全恢复）。 */
export function restoreLaunchers(snapshot: LauncherSnapshot, touched: Partial<LauncherSnapshot> = snapshot): string[] {
  return replaceLaunchers({
    ...(touched.agents ? { agents: snapshot.agents } : {}),
    ...(touched.dsh ? { dsh: snapshot.dsh } : {}),
    ...(touched.codex ? { codex: snapshot.codex } : {}),
    ...(touched.claude ? { claude: snapshot.claude } : {})
  })
}

function rollbackFailure(snapshot: LauncherSnapshot, touched: Partial<LauncherSnapshot>): string | undefined {
  const failed = restoreLaunchers(snapshot, touched)
  return failed.length ? `rollback failed for ${failed.join(', ')}` : undefined
}

/**
 * 解除所有启动器对变量组的显式绑定（Agent + dsh/codex/claude 工作区）。
 * 只清 envProfileId —— command/model/cwd/permissions/order/name 等属性全部保留，
 * 也不复制凭据到其它变量组；解除后的启动语义回到既有默认链（跟随全局启用/系统环境变量）。
 */
export function releaseEnvProfileReferences(profileId: string): ReferenceRelease {
  const snapshot = snapshotLaunchers()
  const next: Partial<LauncherSnapshot> = {}
  let changed = false

  const clear = <T extends { envProfileId?: string }>(items: T[]): T[] | undefined => {
    let touched = false
    const cleared = items.map(item => {
      if (item.envProfileId !== profileId) return item
      touched = true
      // 置 undefined：JSON 落盘时键消失，读回即「未绑定」
      return { ...item, envProfileId: undefined }
    })
    return touched ? cleared : undefined
  }

  const agents = clear(snapshot.agents)
  if (agents) { next.agents = agents; changed = true }
  const dsh = clear(snapshot.dsh)
  if (dsh) { next.dsh = dsh; changed = true }
  const codex = clear(snapshot.codex)
  if (codex) { next.codex = codex; changed = true }
  const claude = clear(snapshot.claude)
  if (claude) { next.claude = claude; changed = true }

  if (!changed) return { ok: true, restore: () => undefined }

  const failed = replaceLaunchers(next)
  if (failed.length > 0) {
    const rollback = rollbackFailure(snapshot, next)
    return {
      ok: false,
      error: `Could not clear env profile references (${failed.join(', ')})${rollback ? `; ${rollback}` : '; launchers were restored'}`
    }
  }

  return {
    ok: true,
    restore: () => rollbackFailure(snapshot, next)
  }
}
