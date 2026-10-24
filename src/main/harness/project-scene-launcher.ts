import type { SceneEntry, SceneTarget } from '@shared/project-scene'
import { HARNESS_AGENTS, resolveWorkspaceEnv } from './config'
import { detectDependencies } from './detect'
import { readSystemPath } from '../env/refresh'
import { agentRepository, resolveAgentLaunchEnv } from '../storage/agent-repository'
import { envProfileRepository } from '../storage/env-profile-repository'
import { codeWorkspaceTargetKey } from './normalize-code-workspaces'
import { managedTargetOf } from './workspace-governance'
import { sceneTargetCwd, type SceneLauncher } from './project-scene'

type AgentEntry = Extract<SceneEntry, { kind: 'agent' }>
type Spawn = (name: string, command: string | undefined, tags: string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<{ success: boolean; error?: string; id?: string }>
export function createSceneLauncher(spawn: Spawn): SceneLauncher {
  const source = (target: SceneTarget, entry: AgentEntry) => {
    const record = entry.agentKind === 'agent' ? agentRepository.get(entry.agentId) : HARNESS_AGENTS[entry.agentKind].repository.get(entry.agentId)
    if (!record) throw new Error('Agent 启动项已删除')
    // 显式绑定项被删除/改绑后绝不落到默认目录或另一项目。
    const current = entry.agentKind === 'dsh' ? record : { ...record, ...managedTargetOf(record.workspacePresetId) }
    if (!current.cwd || codeWorkspaceTargetKey({ cwd: current.cwd, isolation: current.isolation, worktreeKey: current.worktreeKey }) !== codeWorkspaceTargetKey(target)) throw new Error('Agent 已解除关联或属于其他目录/worktree')
    return current
  }
  const check = async (target: SceneTarget, entry: AgentEntry) => {
    source(target, entry)
    if (entry.agentKind !== 'agent') {
      const dependencies = HARNESS_AGENTS[entry.agentKind].dependencies
      const found = detectDependencies(dependencies, (await readSystemPath()) ?? undefined)
      const missing = dependencies.filter(name => !found[name])
      if (missing.length) throw new Error(`CLI 不可用：${missing.join(', ')}`)
    }
  }
  return { check, describe: (target, entry) => entry.kind === 'agent' ? source(target, entry).name : '项目终端', async launch(target, entry, resume) {
    const cwd = await sceneTargetCwd(target)
    let result: { success: boolean; error?: string; id?: string }
    if (entry.kind === 'directory') {
      if (resume) throw new Error('目录终端不支持对话续接')
      result = await spawn('项目目录', undefined, [], { cwd })
    } else if (entry.kind === 'agent') {
      await check(target, entry)
      const current = source(target, entry)
      if (entry.agentKind === 'agent') {
        if (resume) throw new Error('自定义 Agent 未声明可靠续接协议，请从 CLI 手动选择历史')
        const agent = agentRepository.get(entry.agentId)!
        result = await spawn(agent.name, agent.command, [`agent:${agent.id}`], { cwd, env: resolveAgentLaunchEnv(agent, envProfileRepository) })
      } else {
        const runtime = HARNESS_AGENTS[entry.agentKind]
        const workspace = runtime.repository.get(entry.agentId)!
        if (resume && entry.agentKind === 'dsh') throw new Error('DeepSeek 原生控制权不能跨重启恢复；请在官方界面选择历史')
        const env = runtime.normalizeEnv(resolveWorkspaceEnv(runtime, workspace))
        if (!env.ok) throw new Error(env.error)
        const prepared = runtime.prepareModel(workspace, env.env)
        if (!prepared.ok) throw new Error(prepared.error)
        const launch = runtime.buildLaunchCommand(workspace)
        if (!launch.ok) throw new Error(launch.error)
        // 选择器由 CLI 负责；没有会话 ID 时不使用 --last / --continue，也不冒称续接成功。
        const command = resume ? (entry.agentKind === 'codex' ? launch.command.replace(/^codex\b/, 'codex resume') : `${launch.command} --resume`) : launch.command
        // 异步准备后再次确认目录和启动项未被修改。
        await sceneTargetCwd(target)
        source(target, entry)
        result = await spawn(`${current.name}${resume ? ' · 历史选择器' : ''}`, command, [`${entry.agentKind}:${entry.agentId}`], { cwd, env: env.env })
      }
    } else throw new Error('此资源不是启动入口')
    if (!result.success) throw new Error(result.error || '启动失败')
    return { sessionId: result.id }
  } }
}
