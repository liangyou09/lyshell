import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { getConfigDir } from './repository'
import { normalizeEnv } from './harness-workspace-repository'
import { materializeProfileEnv } from '@shared/harness'

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
  /** 绑定的全局变量组 id（storage/env-profile-repository.ts）；缺省 = 未绑定 */
  envProfileId?: string
  /**
   * 绑定变量组时结构化核心（baseUrl/apiKey）的注入变量名 —— 命令是任意的，只有
   * agent 作者知道读哪些变量名，故映射跟 agent 走而非跟协议走（harness kind 的
   * 固定映射见 @shared/harness 的 HARNESS_ENV_KEY_MAP）。缺省 = 两个维度都不注入，
   * 绑定的组只透传附加变量。
   */
  envKeyMap?: { baseUrl?: string; apiKey?: string }
  order: number
}

/**
 * 解析通用 Agent 启动时实际注入的环境变量 —— 与 harness 的 resolveWorkspaceEnv 同构
 * （命中即用、不合并）：
 *
 *   agent.envProfileId 绑定的变量组 → agent.env（内联 legacy）→ undefined（系统环境变量）
 *
 * 绑定命中后经 materializeProfileEnv 物化：附加变量原样透传，结构化核心按本 agent 的
 * envKeyMap 注入（未声明的维度不注入）。绑定悬空（组已被删）时等同「没绑」，回落内联
 * env —— 删组不该让 agent 变成「无 env」。
 */
export function resolveAgentLaunchEnv(
  agent: Pick<AgentConfig, 'envProfileId' | 'envKeyMap' | 'env'>,
  store: { get(id: string): { baseUrl?: string; apiKey?: string; env: Record<string, string> } | undefined }
): Record<string, string> | undefined {
  if (agent.envProfileId !== undefined) {
    const profile = store.get(agent.envProfileId)
    if (profile) {
      return materializeProfileEnv(profile, agent.envKeyMap?.baseUrl ?? null, agent.envKeyMap?.apiKey ?? null)
    }
  }
  return agent.env
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
      const parsed = JSON.parse(content)
      // 非数组按损坏处理（回落默认 Agent）
      if (!Array.isArray(parsed)) {
        log.warn('agents.json is not an array, falling back to defaults')
        this.agents = [...DEFAULT_AGENTS]
        this.loaded = true
        return
      }
      // 每条记录的 env 走与 harness 同一份清洗（空 key / NUL / 非字符串丢弃）——
      // 手工编辑的脏数据直通 node-pty spawn 会拿到 EINVAL
      this.agents = (parsed as AgentConfig[]).map((a) => ({ ...a, env: normalizeEnv(a.env) }))
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
