import type { HarnessAgentKind, HarnessWorkspace } from '@shared/harness'
import { HARNESS_AGENT_VIEWS } from '@shared/harness'
import type { HarnessWorkspaceRepository } from '../storage/harness-workspace-repository'
import {
  dshWorkspaceRepository,
  codexWorkspaceRepository,
  claudeWorkspaceRepository
} from '../storage/harness-workspace-repository'
import type { HarnessEnvProfileRepository } from '../storage/harness-env-profile-repository'
import {
  dshEnvProfileRepository,
  codexEnvProfileRepository,
  claudeEnvProfileRepository
} from '../storage/harness-env-profile-repository'
import { detectDependencies } from './detect'
import { buildCliLaunchCommand, type LaunchCommandResult } from './launch'
import { normalizeDshHomeEnv, type NormalizedEnvResult } from '../dsh/env'
import { presetDshTuiModel, clearDshTuiModel, type PresetModelResult } from '../dsh/model-preset'

/**
 * AI Harness 主进程运行期注册表 —— dsh / codex / claude 三份实例。
 *
 * 渲染层面板配置（依赖/env 默认/模型建议/安装信息/是否 Web）在 @shared/harness 的 HARNESS_AGENT_VIEWS；
 * 这里补足只有 main 才知道的行为：仓库实例、启动命令构造、模型预设、env 归一化。
 * 差异点集中在 dsh：模型走 cordis.patch.yml（prepareModel）+ DSH_HOME 归一化（normalizeEnv）；
 * codex/claude 模型走 --model CLI（buildLaunchCommand），env 原样透传。
 */

export interface HarnessAgentRuntime {
  kind: HarnessAgentKind
  repository: HarnessWorkspaceRepository
  /** 具名环境变量组仓库（与工作区平级的一等配置，见 resolveWorkspaceEnv） */
  envRepository: HarnessEnvProfileRepository
  /** 启动前须全部在 PATH 上的二进制（dsh 须 dsh+dsh-tui；codex/claude 单个） */
  dependencies: string[]
  /** 构造启动命令（dsh 固定 dsh-tui；codex/claude 拼 --model） */
  buildLaunchCommand: (ws: HarnessWorkspace) => LaunchCommandResult
  /** 归一化工作区 env（dsh 校验 DSH_HOME；codex/claude 恒等） */
  normalizeEnv: (env?: Record<string, string>) => NormalizedEnvResult
  /** 启动前准备模型路由（dsh 写/清 cordis 补丁；codex/claude 无事） */
  prepareModel: (ws: HarnessWorkspace, env?: Record<string, string>) => PresetModelResult
}

/** 检测并返回某 kind 的依赖安装状态（launch 前兜底，不依赖前端禁用态） */
export function detectAgentDependencies(kind: HarnessAgentKind): Record<string, boolean> {
  return detectDependencies(HARNESS_AGENT_VIEWS[kind].dependencies)
}

/**
 * 解析某工作区启动时实际注入的环境变量 —— 唯一的真相来源，launch 与 dsh web 两侧都走它。
 *
 *   工作区显式绑定的变量组 → 已启用的变量组 → ws.env（legacy）→ undefined（系统环境变量）
 *
 * envProfileId 悬空（组已被删）时等同「没选」，回落已启用组 —— 删掉一个组不该让工作区
 * 变成「无 env」的第三种状态。
 *
 * 第三级 legacy 分支不是第四种语义，而是迁移失败的防御：迁移横跨两个文件两次落盘
 * （先建组，再回写工作区），若后一次写失败，没有这一级该工作区的 API key 会静默消失。
 * 迁移成功的工作区 ws.env 已清空，这一级永不命中，用户看到的仍是三级链。
 */
export function resolveWorkspaceEnv(
  runtime: HarnessAgentRuntime,
  workspace: HarnessWorkspace
): Record<string, string> | undefined {
  const bound = workspace.envProfileId
    ? runtime.envRepository.get(workspace.envProfileId)
    : undefined
  const profile = bound ?? runtime.envRepository.getActive()
  if (profile) return profile.env
  return workspace.env
}

const identityEnv = (env?: Record<string, string>): NormalizedEnvResult => ({ ok: true, env })
const noModel = (): PresetModelResult => ({ ok: true })

export const HARNESS_AGENTS: Record<HarnessAgentKind, HarnessAgentRuntime> = {
  dsh: {
    kind: 'dsh',
    repository: dshWorkspaceRepository,
    envRepository: dshEnvProfileRepository,
    dependencies: HARNESS_AGENT_VIEWS.dsh.dependencies,
    buildLaunchCommand: () => ({ ok: true, command: 'dsh-tui' }),
    normalizeEnv: normalizeDshHomeEnv,
    prepareModel: (ws, env) =>
      ws.model ? presetDshTuiModel(ws.model, env) : clearDshTuiModel(env)
  },
  codex: {
    kind: 'codex',
    repository: codexWorkspaceRepository,
    envRepository: codexEnvProfileRepository,
    dependencies: HARNESS_AGENT_VIEWS.codex.dependencies,
    buildLaunchCommand: (ws) => buildCliLaunchCommand('codex', ws.model),
    normalizeEnv: identityEnv,
    prepareModel: noModel
  },
  claude: {
    kind: 'claude',
    repository: claudeWorkspaceRepository,
    envRepository: claudeEnvProfileRepository,
    dependencies: HARNESS_AGENT_VIEWS.claude.dependencies,
    buildLaunchCommand: (ws) => buildCliLaunchCommand('claude', ws.model),
    normalizeEnv: identityEnv,
    prepareModel: noModel
  }
}
