import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import log from 'electron-log'
import { HARNESS_AGENT_KINDS, type HarnessAgentKind, type HarnessEnvProfile } from '@shared/harness'
import { getConfigDir } from '../storage/repository'
import { envProfileRepository, normalizeProfile } from '../storage/env-profile-repository'

/**
 * 一次性迁移：把 dsh / codex / claude 三份旧 per-kind 变量组文件
 * （&lt;kind&gt;-env-profiles.json，纯数组格式、记录上带 active 字段）并入全局库
 * （storage/env-profile-repository.ts 的 env-profiles.json）。
 *
 * 每次启动都跑，靠「旧文件不存在」天然 no-op（成功后 rename 成 .bak）。
 * 保 id 不去重 —— workspace 的 envProfileId 绑定与旧启用态一个不丢；
 * 内容重复的组由用户手动清理。
 *
 * 失败兜底：某 kind 中途失败则不 rename，下次启动重试；重试幂等靠
 * importProfiles 的「已存在 id 跳过」。迁移期间用户新建的同 id 组不可能出现（uuid）。
 */

/** 旧文件里记录上的 active 字段（新格式没有）—— 多条 active 时按 order 只认首条（照搬旧仓库 clampSingleActive） */
function parseOldFile(raw: unknown): { profiles: HarnessEnvProfile[]; activeId: string | undefined } {
  const rawList = Array.isArray(raw) ? raw : []
  const valid = rawList
    .map(normalizeProfile)
    .filter((p): p is HarnessEnvProfile => p !== null)
    .sort((a, b) => a.order - b.order)
  // normalizeProfile 丢掉了 active 字段与非法记录，与 rawList 下标不再对齐，按 id 对照取回；
  // 在排序后的合法记录里找首个被标 active 的 —— 与旧仓库「先排序后钳制」同语义，
  // 文件乱序时选中的也是 order 最小那条，不随数组顺序漂移
  const activeIds = new Set<string>()
  for (const item of rawList) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (rec.active === true && typeof rec.id === 'string') activeIds.add(rec.id)
  }
  const activeId = valid.find((p) => activeIds.has(p.id))?.id
  return { profiles: valid, activeId }
}

/**
 * 迁移所有 kind 的旧变量组文件到全局库。整体失败不抛出（不阻断应用启动）——
 * 未并入的 kind 下次启动重试，期间该 kind 的旧数据仍在旧文件里（本函数失败即不 rename）。
 */
export function migrateKindEnvProfilesToGlobal(): void {
  for (const kind of HARNESS_AGENT_KINDS as readonly HarnessAgentKind[]) {
    const oldPath = join(getConfigDir(), `${kind}-env-profiles.json`)
    if (!existsSync(oldPath)) continue
    try {
      const parsed = JSON.parse(readFileSync(oldPath, 'utf-8'))
      const { profiles, activeId } = parseOldFile(parsed)
      const imported = envProfileRepository.importProfiles(
        profiles,
        activeId !== undefined ? { [kind]: activeId } : {}
      )
      if (imported < 0) {
        log.error(`[${kind}] env profile migration: failed to save global store, will retry next launch`)
        continue
      }
      // 成功后旧文件改名保留（不删，可回滚）；下次启动旧文件不在 = no-op
      renameSync(oldPath, `${oldPath}.bak`)
      log.info(`[${kind}] merged ${imported} env profile(s) into global store (old file kept as .bak)`)
    } catch (error) {
      log.error(`[${kind}] env profile migration aborted:`, error)
    }
  }
}
