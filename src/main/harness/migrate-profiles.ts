import { copyFileSync, existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import log from 'electron-log'
import { HARNESS_AGENT_KINDS, liftStructuredFields, type HarnessAgentKind, type HarnessEnvProfile } from '@shared/harness'
import { atomicWriteFileSync, getConfigDir } from '../storage/repository'
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

/**
 * 一次性迁移：把全局库里旧扁平格式的变量组（凭据直接写在 env 记录里，如
 * OPENAI_API_KEY=sk-…）提升成结构化核心（baseUrl/apiKey 两字段），变量名映射下沉到
 * 启动链（materializeProfileEnv 按 kind / agent 映射注入）。
 *
 * 在 migrateKindEnvProfilesToGlobal 之后跑 —— 旧 per-kind 文件并入的记录经
 * normalizeProfile 的防御分支已是结构化，这里处理的是「已经先落在全局库」的存量
 *（先升级应用、后启用结构化的用户）。直接改写 env-profiles.json：
 * 改写前 copyFileSync 备份 .bak（只建一次，不覆盖既有备份）；activeByKind 原样保留。
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
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      profiles?: unknown[]
    }
    if (!Array.isArray(parsed?.profiles)) return
    let changed = false
    const profiles = parsed.profiles.map((raw) => {
      // 逐条只认「有 env 记录、无结构化核心」的旧扁平形态；normalizeProfile 的完整
      // 解析这里不重复 —— 提升只碰 baseUrl/apiKey/env 三个键，其余字段原样带回
      const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const env = (typeof record.env === 'object' && record.env !== null ? record.env : {}) as Record<string, unknown>
      const hasStructuredCore =
        (typeof record.baseUrl === 'string' && record.baseUrl.trim().length > 0) ||
        (typeof record.apiKey === 'string' && record.apiKey.trim().length > 0)
      if (hasStructuredCore || Object.keys(env).length === 0) return raw
      const typedEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === 'string') typedEnv[k] = v
      }
      const lifted = liftStructuredFields(typedEnv)
      if (lifted.baseUrl === undefined && lifted.apiKey === undefined) return raw
      changed = true
      return {
        ...record,
        baseUrl: lifted.baseUrl,
        apiKey: lifted.apiKey,
        env: lifted.env
      }
    })
    if (!changed) return
    const backupPath = `${filePath}.bak`
    if (!existsSync(backupPath)) copyFileSync(filePath, backupPath)
    // 原子写入与仓库层同一份实现（repository.ts 的 atomicWriteFileSync）
    atomicWriteFileSync(filePath, JSON.stringify({ ...parsed, profiles }, null, 2))
    log.info('env profiles migrated to structured core (baseUrl + apiKey); previous file kept as .bak')
  } catch (error) {
    log.error('structured env profile migration aborted (will retry next launch):', error)
  }
}
