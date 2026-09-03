import log from 'electron-log'
import { liftStructuredFields, type HarnessWorkspace } from '@shared/harness'
import type { HarnessAgentRuntime } from './config'

/**
 * 一次性迁移：把工作区里的 legacy inline env 抽成具名「变量组」。
 *
 * 每次启动都跑，靠「有 inline env 且无 envProfileId」这个条件对已迁移记录天然 no-op，
 * 因此无需落盘迁移标记 —— 手工编辑重新塞回 env 的记录也会被再次接住。
 *
 * 内容相同的多个工作区合并到同一条变量组（同一把 API key 不该生成 N 份），
 * 用首个持有者的工作区名命名。
 */

/**
 * 变量组内容的规范化指纹。**必须排序 key**：JSON.stringify 按插入序输出，
 * 不排序则 {A,B} 与 {B,A} 指纹不同，去重会失效、同一套 key 生成两条组。
 * 基准是结构化三元组（baseUrl/apiKey + 排序后的附加变量）：工作区 inline env
 * 先 lift 成同形再比对，与既有结构化组的两侧基准一致。
 */
function canonicalProfile(core: { baseUrl?: string; apiKey?: string; env: Record<string, string> }): string {
  return JSON.stringify([
    core.baseUrl,
    core.apiKey,
    Object.keys(core.env).sort().map((k) => [k, core.env[k]])
  ])
}

/** 在已用名字里取一个不冲突的名称（同名工作区/多次迁移都可能撞名） */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`
    if (!used.has(candidate)) return candidate
  }
  return `${base} (${used.size + 1})`
}

/**
 * 迁移单个 kind，返回成功迁移的工作区条数。
 *
 * 逐条 try/catch 后继续，而不是首次失败就整体中止 —— 一条坏记录不该挡住其余工作区。
 * 失败那条保留 inline env，由 resolveWorkspaceEnv 的 legacy 分支继续供能，下次启动重试。
 */
export function migrateInlineEnvToProfiles(runtime: HarnessAgentRuntime): number {
  // getAll 顺带强制 load 两个仓库（懒加载）
  const workspaces = runtime.repository.getAll()
  const pending = workspaces.filter((w) => w.env !== undefined && w.envProfileId === undefined)
  const existing = runtime.envRepository.getAll()
  if (pending.length === 0) return 0

  // 已有组按内容建索引 —— 含上一轮迁移中「组建好了但工作区没写成」留下的孤儿组，
  // 这样重试时会复用它而不是再建一条。
  const byContent = new Map<string, string>()
  const usedNames = new Set<string>()
  for (const p of existing) {
    const fingerprint = canonicalProfile(p)
    if (!byContent.has(fingerprint)) byContent.set(fingerprint, p.id)
    usedNames.add(p.name)
  }

  let migrated = 0
  for (const ws of pending) {
    try {
      const env = ws.env
      if (!env) continue
      // inline env 先提升成结构化形（凭据对从扁平键提回核心），指纹与建组共用一份结果
      const lifted = liftStructuredFields(env)
      const fingerprint = canonicalProfile(lifted)
      let profileId = byContent.get(fingerprint)

      if (!profileId) {
        const name = uniqueName(ws.name, usedNames)
        const created = runtime.envRepository.add({ name, baseUrl: lifted.baseUrl, apiKey: lifted.apiKey, env: lifted.env })
        if (!created) {
          log.error(`[${runtime.kind}] env migration: failed to create profile for workspace ${ws.id}`)
          continue
        }
        profileId = created.id
        byContent.set(fingerprint, profileId)
        usedNames.add(name)
      }

      // update 整条替换记录：省掉 env 即清空 legacy 字段
      const next: HarnessWorkspace = { ...ws, envProfileId: profileId }
      delete next.env
      if (!runtime.repository.update(next)) {
        // 组已落盘、工作区没写成 —— 该工作区这轮保持原状（legacy env 仍生效），下次启动重试复用该组
        log.error(`[${runtime.kind}] env migration: failed to update workspace ${ws.id}`)
        continue
      }
      migrated++
    } catch (error) {
      log.error(`[${runtime.kind}] env migration failed for workspace ${ws.id}:`, error)
    }
  }

  if (migrated > 0) {
    log.info(`[${runtime.kind}] migrated inline env of ${migrated} workspace(s) into env profiles`)
  }
  return migrated
}
