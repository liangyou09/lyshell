import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { atomicWriteFileSync, getConfigDir } from './repository'
import { normalizeEnv } from './harness-workspace-repository'
import { materializeProfileEnv } from '@shared/harness'

/**
 * AI Agent 配置
 */
export interface AgentConfig {
  id: string
  /** 统一设置工作区的稳定关联；cwd/isolation 仅为兼容快照。 */
  workspacePresetId?: string
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
  /** 工作目录隔离模式（与 harness 工作区 / Codex·Claude 预设同语义）：'worktree' 在专属 git worktree 中启动 */
  isolation?: 'shared' | 'worktree'
  /** worktree 共享名：isolation = 'worktree' 时生效（取值约束见 @shared/worktree 的 validateWorktreeKey） */
  worktreeKey?: string
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
      // 启动项只由用户添加；首次使用不预置任何命令。
      this.agents = []
      this.save()
      log.info('Initialized empty agent library')
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      // 损坏配置保留原文件，内存回落空列表，不凭空恢复启动项。
      if (!Array.isArray(parsed)) {
        log.warn('agents.json is not an array, using an empty agent library')
        this.agents = []
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
      this.agents = []
      this.loaded = true
    }
  }

  /** 落盘结果向上透传：add/update/delete 据此回滚内存并向调用方报失败 */
  private save(): boolean {
    if (!this.filePath) return false

    try {
      // 原子写：崩溃不留截断 JSON（见 repository.ts 的 atomicWriteFileSync）
      atomicWriteFileSync(this.filePath, JSON.stringify(this.agents, null, 2))
      log.info(`Saved ${this.agents.length} agents to storage`)
      return true
    } catch (error) {
      log.error('Failed to save agents:', error)
      return false
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

  /** 落盘失败返回 null 并回滚内存（与 EnvProfileRepository.add 同纪律：内存不领先盘） */
  add(agent: Omit<AgentConfig, 'id'>): AgentConfig | null {
    this.ensureInitialized()
    const newAgent: AgentConfig = {
      ...agent,
      id: uuidv4(),
      order: agent.order ?? this.agents.length
    }
    this.agents.push(newAgent)
    if (!this.save()) {
      this.agents.pop()
      return null
    }
    return newAgent
  }

  update(agent: AgentConfig): boolean {
    this.ensureInitialized()
    const index = this.agents.findIndex(a => a.id === agent.id)
    if (index === -1) return false
    const previous = this.agents[index]
    this.agents[index] = agent
    if (!this.save()) {
      this.agents[index] = previous
      return false
    }
    return true
  }

  delete(id: string): boolean {
    this.ensureInitialized()
    const index = this.agents.findIndex(a => a.id === id)
    if (index === -1) return false
    const [removed] = this.agents.splice(index, 1)
    if (!this.save()) {
      this.agents.splice(index, 0, removed)
      return false
    }
    return true
  }

  /**
   * 内部批量改写：整库原子保存，失败恢复原内存 —— 删除变量组/设置项时统一解除引用，
   * 避免写到一半留下部分清空的启动器。order 原样保留（调用方按 getAll() 顺序传入）。
   */
  replaceAll(agents: AgentConfig[]): boolean {
    this.ensureInitialized()
    const previous = this.agents
    this.agents = agents.map(agent => ({ ...agent }))
    if (this.save()) return true
    this.agents = previous
    return false
  }
}

export const agentRepository = new AgentRepository()
