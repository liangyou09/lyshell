import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { getConfigDir } from './repository'
import { normalizeEnv } from './harness-workspace-repository'
import type { HarnessEnvProfile } from '@shared/harness'

/**
 * AI Harness 环境变量组存储 —— dsh / codex / claude 三份共用（按文件名区分落盘位置）。
 *
 * 每个变量组 = 名称 + 一组 KEY=value，与工作区平级。同一时刻至多一条 active（单选，可全关）；
 * 全关时启动即用系统环境变量。健壮性纪律照搬 HarnessWorkspaceRepository：
 * load 过滤非法记录 / 首个有效 id 去重 / order 重排 0..n-1 / save 失败回滚内存 / 懒加载。
 */

/** 变量组总数上限 —— 兜手工编辑出的病态文件，超出部分丢弃（正常使用远达不到） */
const MAX_PROFILES = 256

/** 单组模型选项上限 —— 与 MAX_PROFILES 同思路，兜手工编辑的病态文件 */
const MAX_MODELS = 64

/**
 * 归一化模型选项：非数组按缺失处理；非字符串/空串项丢弃；trim + 去重 + 截断到上限。
 * 归一化后为空返回 undefined（不写键）。
 */
function normalizeModels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const model = item.trim()
    if (model) seen.add(model)
    if (seen.size >= MAX_MODELS) break
  }
  return seen.size > 0 ? [...seen] : undefined
}

/**
 * 归一化单条 JSON 记录：非法记录返回 null（由 load 过滤）。
 * env 走与工作区同一份 normalizeEnv（空 key / NUL / 非字符串一律丢弃），
 * 归一化后为空的变量组按非法处理 —— 零变量的组没有意义，留着只会在 UI 里当噪声。
 */
function normalizeProfile(raw: unknown): HarnessEnvProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) return null
  if (typeof p.name !== 'string' || p.name.length === 0) return null
  if (typeof p.order !== 'number' || !Number.isFinite(p.order)) return null
  const env = normalizeEnv(p.env)
  if (env === undefined) return null
  // note 非字符串按缺失处理（不因备注脏数据丢整条记录）
  const note = typeof p.note === 'string' && p.note.length > 0 ? p.note : undefined
  const models = normalizeModels(p.models)
  // active 非布尔按 false 处理；「至多一条」的裁剪在 load 里统一做
  const active = typeof p.active === 'boolean' ? p.active : false
  return {
    id: p.id,
    name: p.name,
    order: p.order,
    env,
    active,
    ...(note !== undefined ? { note } : {}),
    ...(models !== undefined ? { models } : {})
  }
}

export class HarnessEnvProfileRepository {
  private readonly fileName: string
  private filePath: string | null = null
  private profiles: HarnessEnvProfile[] = []
  private loaded = false

  constructor(fileName: string) {
    this.fileName = fileName
  }

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), this.fileName)
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    if (!existsSync(this.filePath)) {
      this.profiles = []
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      const rawList = Array.isArray(parsed) ? parsed : []
      // 过滤非法记录 → 按首个有效 id 去重 → 按 order 稳定排序 → reindex 为 0..n-1 → 截断到上限
      const seen = new Set<string>()
      const list = rawList
        .map(normalizeProfile)
        .filter((p): p is HarnessEnvProfile => p !== null)
        .filter((p) => {
          if (seen.has(p.id)) return false
          seen.add(p.id)
          return true
        })
        .sort((a, b) => a.order - b.order)
        .slice(0, MAX_PROFILES)
        .map((p, i) => ({ ...p, order: i }))
      // 单选不变量兜在 load 这一侧：手工编辑出多条 active 时按 order 只认首条，
      // 否则解析结果取决于数组顺序，同一份文件两次启动可能给出不同的环境变量。
      this.profiles = clampSingleActive(list)
      log.info(`Loaded ${this.profiles.length} harness env profiles from ${this.fileName}`)
      this.loaded = true
    } catch (error) {
      log.error(`Failed to load harness env profiles (${this.fileName}):`, error)
      this.profiles = []
      this.loaded = true
    }
  }

  private save(): boolean {
    if (!this.filePath) return false
    try {
      writeFileSync(this.filePath, JSON.stringify(this.profiles, null, 2), 'utf-8')
      return true
    } catch (error) {
      log.error(`Failed to save harness env profiles (${this.fileName}):`, error)
      return false
    }
  }

  getAll(): HarnessEnvProfile[] {
    this.ensureInitialized()
    return [...this.profiles].sort((a, b) => a.order - b.order)
  }

  get(id: string): HarnessEnvProfile | undefined {
    this.ensureInitialized()
    return this.profiles.find((p) => p.id === id)
  }

  /** 当前启用的变量组；无启用项时返回 undefined（调用方据此回落系统环境变量） */
  getActive(): HarnessEnvProfile | undefined {
    this.ensureInitialized()
    return this.profiles.find((p) => p.active === true)
  }

  add(profile: Omit<HarnessEnvProfile, 'id' | 'order'>): HarnessEnvProfile | null {
    this.ensureInitialized()
    if (this.profiles.length >= MAX_PROFILES) return null
    const newProfile: HarnessEnvProfile = {
      ...profile,
      id: uuidv4(),
      // 新建一律不启用 —— 启用是用户的显式选择，不在创建时替他做
      active: false,
      // order 由仓库分配递增，避免用 length 在删除后产生重复值
      order: this.profiles.reduce((max, p) => Math.max(max, p.order), -1) + 1
    }
    this.profiles.push(newProfile)
    if (!this.save()) {
      this.profiles.pop()
      return null
    }
    return newProfile
  }

  update(profile: HarnessEnvProfile): boolean {
    this.ensureInitialized()
    const index = this.profiles.findIndex((p) => p.id === profile.id)
    if (index === -1) return false
    const previous = this.profiles[index]
    // active 只经 setActive 变更，update 一律保留现状 —— 否则编辑名称就能顺手把启用态改掉
    this.profiles[index] = { ...profile, active: previous.active }
    if (!this.save()) {
      this.profiles[index] = previous
      return false
    }
    return true
  }

  /**
   * 单选启用：传 id 启用该条并清掉其余，传 null 全部停用（回落系统环境变量）。
   * 落盘失败整体回滚，不留「内存已切、文件没切」的错位。
   */
  setActive(id: string | null): boolean {
    this.ensureInitialized()
    if (id !== null && !this.profiles.some((p) => p.id === id)) return false
    const previous = this.profiles
    this.profiles = this.profiles.map((p) => ({ ...p, active: id !== null && p.id === id }))
    if (!this.save()) {
      this.profiles = previous
      return false
    }
    return true
  }

  delete(id: string): boolean {
    this.ensureInitialized()
    const index = this.profiles.findIndex((p) => p.id === id)
    if (index === -1) return false
    const previousOrders = this.profiles.map((p) => p.order)
    const [removed] = this.profiles.splice(index, 1)
    // reindex 为 0..n-1，保证运行期 order 恒连续（不留空洞）
    this.profiles.forEach((p, i) => { p.order = i })
    if (!this.save()) {
      // 回滚：恢复被删项与原 order
      this.profiles.splice(index, 0, removed)
      previousOrders.forEach((order, i) => { this.profiles[i].order = order })
      return false
    }
    return true
  }
}

/** 按 order 只保留首条 active，其余清掉（列表须已 reindex） */
function clampSingleActive(list: HarnessEnvProfile[]): HarnessEnvProfile[] {
  const firstActive = list.find((p) => p.active === true)
  if (!firstActive) return list
  return list.map((p) => (p.id === firstActive.id ? p : { ...p, active: false }))
}

export const dshEnvProfileRepository = new HarnessEnvProfileRepository('dsh-env-profiles.json')
export const codexEnvProfileRepository = new HarnessEnvProfileRepository('codex-env-profiles.json')
export const claudeEnvProfileRepository = new HarnessEnvProfileRepository('claude-env-profiles.json')
