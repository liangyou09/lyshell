import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { getConfigDir } from './repository'
import type { HarnessWorkspace } from '@shared/harness'

/**
 * AI Harness 工作区存储 —— dsh / codex / claude 三份共用（按文件名区分落盘位置）。
 * 每个工作区 = 名称 + 工作目录，单击在对应目录内启动对应 CLI。
 * 泛化自原 DshWorkspaceRepository（逻辑不变，DshWorkspace → HarnessWorkspace）。
 */

/**
 * 归一化 env 记录：过滤非字符串值，空记录按缺失处理（缺省时启动即用系统环境变量）。
 * 导出供变量组仓库（harness-env-profile-repository）复用，两处脏数据规则必须一致。
 */
export function normalizeEnv(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // 丢弃脏数据（手工编辑/历史 JSON 可能残留）：空 key / 含 NUL 的 key / 含 NUL 的 value
    // 会让 node-pty spawn 返回 EINVAL 或截断环境变量（对齐 validation.assertStringRecord 的拒绝）。
    if (key.length === 0) continue
    if (key.includes('\0')) continue
    if (typeof value !== 'string') continue
    if (value.includes('\0')) continue
    result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** 归一化单条 JSON 记录：非法记录返回 null（由 load 过滤），合法记录补齐 note/pinned 默认值。 */
function normalizeWorkspace(raw: unknown): HarnessWorkspace | null {
  if (typeof raw !== 'object' || raw === null) return null
  const w = raw as Record<string, unknown>
  if (typeof w.id !== 'string' || w.id.length === 0) return null
  if (typeof w.name !== 'string' || w.name.length === 0) return null
  if (typeof w.cwd !== 'string' || w.cwd.length === 0) return null
  if (typeof w.order !== 'number' || !Number.isFinite(w.order)) return null
  // note 非字符串时按缺失处理（不因备注脏数据丢整条记录）
  const note = typeof w.note === 'string' && w.note.length > 0 ? w.note : undefined
  // model 非字符串/空串按缺失处理（缺省时用各 CLI 默认模型）
  const model = typeof w.model === 'string' && w.model.length > 0 ? w.model : undefined
  // pinned 非布尔按 false 处理
  const pinned = typeof w.pinned === 'boolean' ? w.pinned : false
  // env 非对象/空记录按缺失处理（不因脏数据丢整条记录）
  // 注意：这是 legacy 字段，但迁移要靠它读到旧数据，删掉这行等于静默丢弃用户的 API key
  const env = normalizeEnv(w.env)
  // envProfileId 非字符串/空串按缺失处理（缺省即「跟随已启用的变量组」）
  const envProfileId = typeof w.envProfileId === 'string' && w.envProfileId.length > 0 ? w.envProfileId : undefined
  return { id: w.id, name: w.name, cwd: w.cwd, order: w.order, pinned, ...(note !== undefined ? { note } : {}), ...(model !== undefined ? { model } : {}), ...(env !== undefined ? { env } : {}), ...(envProfileId !== undefined ? { envProfileId } : {}) }
}

/**
 * 通用工作区仓库。健壮性：load 过滤/归一化非法记录、按首个有效 id 去重、按 order 重排为 0..n-1；
 * delete 后 reindex 保持运行期 order 恒连续；add 分配 maxOrder+1；save 失败返回 false 并回滚内存。
 */
export class HarnessWorkspaceRepository {
  private readonly fileName: string
  private filePath: string | null = null
  private workspaces: HarnessWorkspace[] = []
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
      this.workspaces = []
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      const rawList = Array.isArray(parsed) ? parsed : []
      // 过滤非法记录 → 按首个有效 id 去重 → 按 order 稳定排序 → reindex 为 0..n-1 连续值
      const seen = new Set<string>()
      this.workspaces = rawList
        .map(normalizeWorkspace)
        .filter((w): w is HarnessWorkspace => w !== null)
        .filter((w) => {
          if (seen.has(w.id)) return false
          seen.add(w.id)
          return true
        })
        .sort((a, b) => a.order - b.order)
        .map((w, i) => ({ ...w, order: i }))
      log.info(`Loaded ${this.workspaces.length} harness workspaces from ${this.fileName}`)
      this.loaded = true
    } catch (error) {
      log.error(`Failed to load harness workspaces (${this.fileName}):`, error)
      this.workspaces = []
      this.loaded = true
    }
  }

  private save(): boolean {
    if (!this.filePath) return false
    try {
      writeFileSync(this.filePath, JSON.stringify(this.workspaces, null, 2), 'utf-8')
      return true
    } catch (error) {
      log.error(`Failed to save harness workspaces (${this.fileName}):`, error)
      return false
    }
  }

  getAll(): HarnessWorkspace[] {
    this.ensureInitialized()
    // 置顶优先，其余按 order 升序
    return [...this.workspaces].sort(
      (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.order - b.order
    )
  }

  get(id: string): HarnessWorkspace | undefined {
    this.ensureInitialized()
    return this.workspaces.find((w) => w.id === id)
  }

  add(workspace: Omit<HarnessWorkspace, 'id' | 'order'>): HarnessWorkspace | null {
    this.ensureInitialized()
    const newWorkspace: HarnessWorkspace = {
      ...workspace,
      id: uuidv4(),
      pinned: workspace.pinned === true,
      // order 由仓库分配递增，避免用 workspaces.length 在删除后产生重复值
      order: this.workspaces.reduce((max, w) => Math.max(max, w.order), -1) + 1
    }
    this.workspaces.push(newWorkspace)
    if (!this.save()) {
      this.workspaces.pop()
      return null
    }
    return newWorkspace
  }

  update(workspace: HarnessWorkspace): boolean {
    this.ensureInitialized()
    const index = this.workspaces.findIndex((w) => w.id === workspace.id)
    if (index === -1) return false
    const previous = this.workspaces[index]
    this.workspaces[index] = workspace
    if (!this.save()) {
      this.workspaces[index] = previous
      return false
    }
    return true
  }

  setPinned(id: string, pinned: boolean): boolean {
    this.ensureInitialized()
    const index = this.workspaces.findIndex((w) => w.id === id)
    if (index === -1) return false
    const previous = this.workspaces[index].pinned
    this.workspaces[index] = { ...this.workspaces[index], pinned }
    if (!this.save()) {
      this.workspaces[index] = { ...this.workspaces[index], pinned: previous }
      return false
    }
    return true
  }

  delete(id: string): boolean {
    this.ensureInitialized()
    const index = this.workspaces.findIndex((w) => w.id === id)
    if (index === -1) return false
    const previousOrders = this.workspaces.map((w) => w.order)
    const [removed] = this.workspaces.splice(index, 1)
    // reindex 为 0..n-1，保证运行期 order 恒连续（不留空洞）
    this.workspaces.forEach((w, i) => { w.order = i })
    if (!this.save()) {
      // 回滚：恢复被删项与原 order
      this.workspaces.splice(index, 0, removed)
      previousOrders.forEach((order, i) => { this.workspaces[i].order = order })
      return false
    }
    return true
  }
}

export const dshWorkspaceRepository = new HarnessWorkspaceRepository('dsh-workspaces.json')
export const codexWorkspaceRepository = new HarnessWorkspaceRepository('codex-workspaces.json')
export const claudeWorkspaceRepository = new HarnessWorkspaceRepository('claude-workspaces.json')
