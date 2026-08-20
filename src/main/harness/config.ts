import type { HarnessAgentKind, HarnessWorkspace } from '@shared/harness'
import { HARNESS_AGENT_VIEWS } from '@shared/harness'
import type { HarnessWorkspaceRepository } from '../storage/harness-workspace-repository'
import {
  dshWorkspaceRepository,
  codexWorkspaceRepository,
  claudeWorkspaceRepository
} from '../storage/harness-workspace-repository'
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

const identityEnv = (env?: Record<string, string>): NormalizedEnvResult => ({ ok: true, env })
const noModel = (): PresetModelResult => ({ ok: true })

export const HARNESS_AGENTS: Record<HarnessAgentKind, HarnessAgentRuntime> = {
  dsh: {
    kind: 'dsh',
    repository: dshWorkspaceRepository,
    dependencies: HARNESS_AGENT_VIEWS.dsh.dependencies,
    buildLaunchCommand: () => ({ ok: true, command: 'dsh-tui' }),
    normalizeEnv: normalizeDshHomeEnv,
    prepareModel: (ws, env) =>
      ws.model ? presetDshTuiModel(ws.model, env) : clearDshTuiModel(env)
  },
  codex: {
    kind: 'codex',
    repository: codexWorkspaceRepository,
    dependencies: HARNESS_AGENT_VIEWS.codex.dependencies,
    buildLaunchCommand: (ws) => buildCliLaunchCommand('codex', ws.model),
    normalizeEnv: identityEnv,
    prepareModel: noModel
  },
  claude: {
    kind: 'claude',
    repository: claudeWorkspaceRepository,
    dependencies: HARNESS_AGENT_VIEWS.claude.dependencies,
    buildLaunchCommand: (ws) => buildCliLaunchCommand('claude', ws.model),
    normalizeEnv: identityEnv,
    prepareModel: noModel
  }
}
