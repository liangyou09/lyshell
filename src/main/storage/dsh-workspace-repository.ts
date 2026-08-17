import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { getConfigDir } from './repository'

/**
 * DeepSeek Harness 工作区配置。
 * 每个工作区 = 名称 + 工作目录，单击在对应目录内启动 dsh-tui。
 */
export interface DshWorkspace {
  id: string
  name: string           // 显示名称，如 "lyshell"
  cwd: string            // 工作目录（dsh-tui 启动 cwd）
  order: number
  note?: string          // 可选备注，仅用于记录/说明
}

/** 归一化单条 JSON 记录：非法记录返回 null（由 load 过滤），合法记录补齐 note 默认值。 */
function normalizeWorkspace(raw: unknown): DshWorkspace | null {
  if (typeof raw !== 'object' || raw === null) return null
  const w = raw as Record<string, unknown>
  if (typeof w.id !== 'string' || w.id.length === 0) return null
  if (typeof w.name !== 'string' || w.name.length === 0) return null
  if (typeof w.cwd !== 'string' || w.cwd.length === 0) return null
  if (typeof w.order !== 'number' || !Number.isFinite(w.order)) return null
  // note 非字符串时按缺失处理（不因备注脏数据丢整条记录）
  const note = typeof w.note === 'string' && w.note.length > 0 ? w.note : undefined
  return { id: w.id, name: w.name, cwd: w.cwd, order: w.order, ...(note !== undefined ? { note } : {}) }
}

/**
 * DeepSeek Harness 工作区存储 —— 对齐 agent-repository 的 JSON 文件模式。
 * 健壮性：load 过滤/归一化非法记录、按首个有效 id 去重、按 order 重排为 0..n-1；
 * delete 后 reindex 保持运行期 order 恒连续（0..n-1）；add 分配 maxOrder+1；
 * save 失败返回 false 并回滚内存，避免内存与磁盘不一致。
 */
export class DshWorkspaceRepository {
  private filePath: string | null = null
  private workspaces: DshWorkspace[] = []
  private loaded = false

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'dsh-workspaces.json')
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
        .filter((w): w is DshWorkspace => w !== null)
        .filter((w) => {
          if (seen.has(w.id)) return false
          seen.add(w.id)
          return true
        })
        .sort((a, b) => a.order - b.order)
        .map((w, i) => ({ ...w, order: i }))
      log.info(`Loaded ${this.workspaces.length} dsh workspaces from storage`)
      this.loaded = true
    } catch (error) {
      log.error('Failed to load dsh workspaces:', error)
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
      log.error('Failed to save dsh workspaces:', error)
      return false
    }
  }

  getAll(): DshWorkspace[] {
    this.ensureInitialized()
    return [...this.workspaces].sort((a, b) => a.order - b.order)
  }

  get(id: string): DshWorkspace | undefined {
    this.ensureInitialized()
    return this.workspaces.find((w) => w.id === id)
  }

  add(workspace: Omit<DshWorkspace, 'id' | 'order'>): DshWorkspace | null {
    this.ensureInitialized()
    const newWorkspace: DshWorkspace = {
      ...workspace,
      id: uuidv4(),
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

  update(workspace: DshWorkspace): boolean {
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

export const dshWorkspaceRepository = new DshWorkspaceRepository()
