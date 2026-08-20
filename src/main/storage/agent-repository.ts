import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { getConfigDir } from './repository'

/**
 * AI Agent 配置
 */
export interface AgentConfig {
  id: string
  name: string           // 显示名称，如 "Claude Code"
  command: string        // Shell 命令，如 "claude"
  icon?: string          // 图标（emoji），如 "🤖"
  cwd?: string           // 工作目录
  env?: Record<string, string>
  order: number
}

const DEFAULT_AGENTS: AgentConfig[] = [
  // Claude Code 省略 icon:走 bundledIconFor('claude') 显示内置品牌标(与 handleSave 落库的 undefined 形态统一)
  { id: 'agent-claude-code', name: 'Claude Code', command: 'claude', order: 0 },
  { id: 'agent-aider', name: 'Aider', command: 'aider', icon: '🤝', order: 1 },
  { id: 'agent-copilot', name: 'Copilot CLI', command: 'gh copilot', icon: '🐙', order: 2 }
]

/**
 * AI Agent 配置存储
 */
export class AgentRepository {
  private filePath: string | null = null
  private agents: AgentConfig[] = []
  private loaded: boolean = false

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'agents.json')
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    if (!existsSync(this.filePath)) {
      // 首次加载，写入默认 Agent
      this.agents = [...DEFAULT_AGENTS]
      this.save()
      log.info(`Initialized ${this.agents.length} default agents`)
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      this.agents = JSON.parse(content) as AgentConfig[]
      log.info(`Loaded ${this.agents.length} agents from storage`)
      this.loaded = true
    } catch (error) {
      log.error('Failed to load agents:', error)
      this.agents = [...DEFAULT_AGENTS]
      this.loaded = true
    }
  }

  private save(): void {
    if (!this.filePath) return

    try {
      writeFileSync(this.filePath, JSON.stringify(this.agents, null, 2), 'utf-8')
      log.info(`Saved ${this.agents.length} agents to storage`)
    } catch (error) {
      log.error('Failed to save agents:', error)
    }
  }

  getAll(): AgentConfig[] {
    this.ensureInitialized()
    return [...this.agents].sort((a, b) => a.order - b.order)
  }

  get(id: string): AgentConfig | undefined {
    this.ensureInitialized()
    return this.agents.find(a => a.id === id)
  }

  add(agent: Omit<AgentConfig, 'id'>): AgentConfig {
    this.ensureInitialized()
    const newAgent: AgentConfig = {
      ...agent,
      id: uuidv4(),
      order: agent.order ?? this.agents.length
    }
    this.agents.push(newAgent)
    this.save()
    return newAgent
  }

  update(agent: AgentConfig): boolean {
    this.ensureInitialized()
    const index = this.agents.findIndex(a => a.id === agent.id)
    if (index === -1) return false
    this.agents[index] = agent
    this.save()
    return true
  }

  delete(id: string): boolean {
    this.ensureInitialized()
    const index = this.agents.findIndex(a => a.id === id)
    if (index === -1) return false
    this.agents.splice(index, 1)
    this.save()
    return true
  }
}

export const agentRepository = new AgentRepository()
