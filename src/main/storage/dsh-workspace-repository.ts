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

/**
 * DeepSeek Harness 工作区存储 —— 对齐 agent-repository 的 JSON 文件模式。
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
      this.workspaces = JSON.parse(content) as DshWorkspace[]
      log.info(`Loaded ${this.workspaces.length} dsh workspaces from storage`)
      this.loaded = true
    } catch (error) {
      log.error('Failed to load dsh workspaces:', error)
      this.workspaces = []
      this.loaded = true
    }
  }

  private save(): void {
    if (!this.filePath) return

    try {
      writeFileSync(this.filePath, JSON.stringify(this.workspaces, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to save dsh workspaces:', error)
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

  add(workspace: Omit<DshWorkspace, 'id'>): DshWorkspace {
    this.ensureInitialized()
    const newWorkspace: DshWorkspace = {
      ...workspace,
      id: uuidv4(),
      order: workspace.order ?? this.workspaces.length
    }
    this.workspaces.push(newWorkspace)
    this.save()
    return newWorkspace
  }

  update(workspace: DshWorkspace): boolean {
    this.ensureInitialized()
    const index = this.workspaces.findIndex((w) => w.id === workspace.id)
    if (index === -1) return false
    this.workspaces[index] = workspace
    this.save()
    return true
  }

  delete(id: string): boolean {
    this.ensureInitialized()
    const index = this.workspaces.findIndex((w) => w.id === id)
    if (index === -1) return false
    this.workspaces.splice(index, 1)
    this.save()
    return true
  }
}

export const dshWorkspaceRepository = new DshWorkspaceRepository()
