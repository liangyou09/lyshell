import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import log from 'electron-log'
import { HARNESS_AGENT_KINDS, isSecretPlaceholder, type HarnessAgentKind, type HarnessEnvProfile } from '@shared/harness'
import { atomicWriteFileSync, getConfigDir } from '../storage/repository'
import { envProfileRepository, normalizeProfile } from '../storage/env-profile-repository'

/**
 * 一次性迁移：把 dsh / codex / claude 三份旧 per-kind 变量组文件
 * （&lt;kind&gt;-env-profiles.json，纯数组格式、记录上带 active 字段）并入全局库
 * （storage/env-profile-repository.ts 的 env-profiles.json）。
 *
 * 每次启动都跑，靠「旧文件不存在」天然 no-op（成功后 rename 成 .bak）。
 * 保 id 不去重 —— workspace 的 envProfileId 绑定与旧启用态一个不丢；
 * 启用指针并入全局单根后只补空位，多个 kind 的旧文件都带 active 时
 * 先处理的 kind（dsh 最先）先到先得；内容重复的组由用户手动清理。
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
      const imported = envProfileRepository.importProfiles(profiles, activeId)
      if (imported < 0) {
        log.error(`[${kind}] env profile migration: failed to save global store, will retry next launch`)
        continue
      }
      // 成功后仅保留可恢复的引用快照，不能把旧明文文件改名后永久留在 .bak。
      const archived = profiles.map(profile => {
        const stored = envProfileRepository.getPublic(profile.id)
        if (!stored) throw new Error('Imported profile is missing')
        const clean = { ...stored, env: Object.fromEntries(Object.entries(stored.env).filter(([, value]) => !isSecretPlaceholder(value))) }
        delete clean.apiKey
        return { ...clean, active: profile.id === activeId }
      })
      atomicWriteFileSync(oldPath, JSON.stringify(archived, null, 2))
      renameSync(oldPath, `${oldPath}.bak`)
      log.info(`[${kind}] merged ${imported} env profile(s) into global store (old file kept as .bak)`)
    } catch (error) {
      log.error(`[${kind}] env profile migration aborted:`, error)
    }
  }
}

/**
 * 一次性迁移：把全局库里旧扁平格式的变量组（凭据直接写在 env 记录里，如
 * OPENAI_API_KEY=sk-…）提升成结构化核心（baseUrl/apiKey 两字段），变量名映射下沉到
 * 启动链（materializeProfileEnv 按 kind / agent 映射注入）。
 *
 * 在 migrateKindEnvProfilesToGlobal 之后跑 —— 旧 per-kind 文件并入的记录经
 * normalizeProfile 的防御分支已是结构化，这里处理的是「已经先落在全局库」的存量
 *（先升级应用、后启用结构化的用户）。直接改写 env-profiles.json：
 * 改写前 copyFileSync 备份 .bak（只建一次，不覆盖既有备份）；启用指针原样保留
 * （activeProfileId 新格式 / legacy activeByKind 均为经 spread 原样带回）。
 *
 * 幂等：提升后 env 里不再有已知协议键，二跑全 no-op、不重写文件（也就不覆盖备份）。
 * 原子落盘：先写 .tmp 再 rename 覆盖 —— 直接 writeFileSync 中途崩溃会留下截断的
 * JSON，下次启动整库按损坏处理；rename 在同一卷上原子（Windows 上 Node 走
 * MoveFileEx REPLACE_EXISTING），崩溃时盘上要么旧文件要么新文件，没有中间态。
 * 失败兜底：log 后下启重试；重试落盘成功前 normalizeProfile 的防御分支保证
 * 运行期行为已正确（读旧格式文件一样能解析出结构化核心）。
 */
export function migrateProfilesToStructured(): void {
  const filePath = join(getConfigDir(), 'env-profiles.json')
  if (!existsSync(filePath)) return
  try {
    // normalizeProfile 在仓储加载时提升结构化字段；同一轮 load 把秘密写入 vault、
    // 回读成功后才提交引用和备份，避免先生成另一份明文配置/备份。
    envProfileRepository.getAllPublic()
  } catch (error) {
    log.error('structured env profile migration aborted:', error instanceof Error ? error.name : 'unknown error')
  }
}
