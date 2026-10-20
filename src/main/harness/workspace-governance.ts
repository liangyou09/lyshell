import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync, getConfigDir } from '../storage/repository'
import { agentRepository, type AgentConfig } from '../storage/agent-repository'
import { codeWorkspacePresetRepository as presets, codexWorkspaceRepository, claudeWorkspaceRepository } from '../storage/harness-workspace-repository'
import type { HarnessWorkspace } from '@shared/harness'
import type { CodeWorkspacePreset } from '@shared/code-workspaces'
import { validateWorktreeKey } from '@shared/worktree'
import { migrateCodeWorkspacePresets } from './migrate-code-workspaces'
import { codeWorkspaceTargetKey, normalizeCodeWorkspaces } from './normalize-code-workspaces'
import { createTaskSerializer } from './task-serializer'

const serialize = createTaskSerializer()
let initialized = false

/** 一次性把旧快照纳入设置。标记之后不再导入悬空项，防止已删目标复活。 */
export async function ensureManagedWorkspaces(): Promise<void> {
  return serialize('workspace-governance', async () => {
    if (initialized) return
    const config = getConfigDir()
    const marker = join(config, 'workspace-governance-v2.json')
    if (!existsSync(marker)) {
      // 在任何迁移前保留原始文件；.bak 不参与 dev 配置播种。
      for (const name of ['agents.json', 'codex-workspaces.json', 'claude-workspaces.json', 'code-workspace-presets.json']) {
        const source = join(config, name)
        const backup = `${source}.before-workspace-governance.bak`
        if (existsSync(source) && !existsSync(backup)) copyFileSync(source, backup)
      }
    }
    if (!existsSync(marker)) {
      await migrateCodeWorkspacePresets(presets, [
        { kind: 'codex', repository: codexWorkspaceRepository },
        { kind: 'claude', repository: claudeWorkspaceRepository }
      ], join(config, 'code-workspace-presets-migration.json'))
    }
    normalizeCodeWorkspaces(presets, join(config, 'code-workspace-presets-merge.json'))
    if (!existsSync(marker)) {
      const sources = [
        { kind: 'agent', items: agentRepository.getAll(), update: (item: AgentConfig | HarnessWorkspace) => agentRepository.update(item as AgentConfig) },
        { kind: 'codex', items: codexWorkspaceRepository.getAll(), update: (item: AgentConfig | HarnessWorkspace) => codexWorkspaceRepository.update(item as HarnessWorkspace) },
        { kind: 'claude', items: claudeWorkspaceRepository.getAll(), update: (item: AgentConfig | HarnessWorkspace) => claudeWorkspaceRepository.update(item as HarnessWorkspace) }
      ]
      for (const source of sources) for (const snapshot of source.items) {
        let preset = snapshot.workspacePresetId ? getManagedPreset(snapshot.workspacePresetId) : undefined
        if (snapshot.workspacePresetId && !preset) continue
        const target = { ...snapshot }
        // 旧命令未指定 cwd 时在用户主目录启动，不能迁移到任意首个项目或 worktree。
        if (source.kind === 'agent' && !target.cwd?.trim()) {
          target.cwd = process.env.USERPROFILE || process.env.HOME || homedir()
        }
        if (!preset && target.cwd) {
          if (target.isolation === 'worktree' && !target.worktreeKey) {
            const key = validateWorktreeKey(`${source.kind}-${target.id}`)
            if (!key.ok) throw new Error(key.error)
            target.worktreeKey = key.value
          }
          const identity = codeWorkspaceTargetKey({ ...target, cwd: target.cwd })
          preset = presets.getAll().find(item => codeWorkspaceTargetKey(item) === identity)
          if (!preset) {
            // 迁移只收录路径，不创建或移动磁盘目录、分支或 worktree。
            const base = (basename(target.cwd) || snapshot.name || 'Workspace').slice(0, 100)
            let name = base
            let index = 1
            while (presets.getAll().some(item => item.name === name && item.worktreeKey === target.worktreeKey)) name = `${base} (${++index})`
            preset = presets.add({ name, cwd: target.cwd, ...(target.isolation === 'worktree' ? { isolation: 'worktree' as const, worktreeKey: target.worktreeKey } : {}) }) ?? undefined
            if (!preset) throw new Error('Could not import workspace target')
          }
        }
        if (!preset) continue
        if (!source.update({ ...snapshot, ...managedTarget(preset) })) throw new Error('Could not save workspace association')
      }
      normalizeCodeWorkspaces(presets, join(config, 'code-workspace-presets-merge.json'))
      atomicWriteFileSync(marker, JSON.stringify({ version: 2 }, null, 2))
    } else {
      const value = JSON.parse(readFileSync(marker, 'utf8')) as { version?: unknown }
      if (value.version !== 2) throw new Error('Unknown workspace governance version')
    }
    initialized = true
  })
}

export function getManagedPreset(id: string): CodeWorkspacePreset | undefined {
  // 旧合并 ID 只能重定向到仍存在的设置项；绝不按旧 cwd 恢复已删预设。
  const direct = presets.get(id)
  if (direct) return direct
  const marker = join(getConfigDir(), 'code-workspace-presets-merge.json')
  if (!existsSync(marker)) return undefined
  const aliases = (JSON.parse(readFileSync(marker, 'utf8')) as { aliases?: Record<string, string> }).aliases
  return aliases?.[id] ? presets.get(aliases[id]) : undefined
}

export function managedTarget(preset: CodeWorkspacePreset) {
  return { workspacePresetId: preset.id, cwd: preset.cwd, isolation: preset.isolation === 'worktree' ? 'worktree' as const : 'shared' as const, worktreeKey: preset.isolation === 'worktree' ? preset.worktreeKey : undefined }
}

export async function requireManagedTarget(id: string) {
  await ensureManagedWorkspaces()
  const preset = getManagedPreset(id)
  if (!preset) throw new Error('Workspace preset not found. Select a workspace from Settings.')
  return managedTarget(preset)
}

export async function listManagedLaunchers<T extends AgentConfig | HarnessWorkspace>(items: () => T[]): Promise<T[]> {
  await ensureManagedWorkspaces()
  return items().flatMap(item => {
    const preset = item.workspacePresetId ? getManagedPreset(item.workspacePresetId) : undefined
    return preset ? [{ ...item, ...managedTarget(preset) }] : []
  })
}

export function isWorkspaceReferenced(id: string): boolean {
  return [...agentRepository.getAll(), ...codexWorkspaceRepository.getAll(), ...claudeWorkspaceRepository.getAll()]
    .some(item => item.workspacePresetId && getManagedPreset(item.workspacePresetId)?.id === id)
}
