import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync, getConfigDir } from '../storage/repository'
import { agentRepository, type AgentConfig } from '../storage/agent-repository'
import { replaceLaunchers, restoreLaunchers, snapshotLaunchers, type LauncherSnapshot } from '../storage/launcher-references'
import { codeWorkspacePresetRepository as presets, codexWorkspaceRepository, claudeWorkspaceRepository } from '../storage/harness-workspace-repository'
import type { HarnessWorkspace } from '@shared/harness'
import type { CodeWorkspacePreset } from '@shared/code-workspaces'
import { validateWorktreeKey } from '@shared/worktree'
import { migrateCodeWorkspacePresets } from './migrate-code-workspaces'
import { codeWorkspaceTargetKey, normalizeCodeWorkspaces } from './normalize-code-workspaces'
import { createTaskSerializer } from './task-serializer'

/** 启动器生效的目录目标：绑定项来自设置项，未绑定项为 cwd=''（启动用用户主目录）。 */
export interface ManagedTarget {
  workspacePresetId?: string
  cwd: string
  isolation: 'shared' | 'worktree'
  worktreeKey?: string
}

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

export function managedTarget(preset: CodeWorkspacePreset): ManagedTarget {
  return { workspacePresetId: preset.id, cwd: preset.cwd, isolation: preset.isolation === 'worktree' ? 'worktree' as const : 'shared' as const, worktreeKey: preset.isolation === 'worktree' ? preset.worktreeKey : undefined }
}

/**
 * 未引用工作目录的启动器目标：cwd 空串（启动时落到用户主目录），不继承任何旧隔离参数。
 * 删除设置项后启动器就停在这个状态 —— 保留全部其它设置，只是不再绑定目录。
 */
export function unboundTarget(): ManagedTarget {
  return { workspacePresetId: undefined, cwd: '', isolation: 'shared', worktreeKey: undefined }
}

/** 未绑定设置项时的启动目录：用户主目录，绝不自动绑定其它设置项或复用旧快照。 */
export function defaultLaunchCwd(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

/** 启动路径的宽松解析：未指定/悬空一律按未绑定处理（启动仍可用，只是回到主目录）。 */
export function managedTargetOf(id: string | undefined): ManagedTarget {
  const preset = id ? getManagedPreset(id) : undefined
  return preset ? managedTarget(preset) : unboundTarget()
}

/** 启动器视图：绑定项跟随设置项（含合并别名），未绑定/悬空项投影成「未引用工作目录」项。 */
export function managedLauncher<T extends AgentConfig | HarnessWorkspace>(item: T): T {
  return { ...item, ...managedTargetOf(item.workspacePresetId) }
}

/** 初始化完成后同步解析保存目标，解析和写入之间不让出事件循环，避免删除后写回旧引用。 */
export function preparedManagedTarget(id?: string): ManagedTarget {
  if (!id) return unboundTarget()
  const preset = getManagedPreset(id)
  if (!preset) throw new Error('Workspace preset not found. Select a workspace from Settings.')
  return managedTarget(preset)
}

export async function requireManagedTarget(id: string): Promise<ManagedTarget> {
  await ensureManagedWorkspaces()
  return preparedManagedTarget(id)
}

/**
 * 列出启动器：绑定项跟随设置项目录，未绑定项（含设置项已悬空的存量记录）也原样返回 ——
 * 过滤会让它们从 UI 里消失，看起来像启动器"丢了"。
 */
export async function listManagedLaunchers<T extends AgentConfig | HarnessWorkspace>(items: () => T[]): Promise<T[]> {
  await ensureManagedWorkspaces()
  return items().map(managedLauncher)
}

/**
 * 每个设置项被多少启动器引用（agent/codex/claude；合并别名折算到仍存在的 id）。
 * 删除前用它显示引用数，删除后用它确认引用已清空。
 */
export function countWorkspaceUsage(): Record<string, number> {
  const usage: Record<string, number> = {}
  for (const preset of presets.getAll()) usage[preset.id] = 0
  const items = [...agentRepository.getAll(), ...codexWorkspaceRepository.getAll(), ...claudeWorkspaceRepository.getAll()]
  for (const item of items) {
    if (!item.workspacePresetId) continue
    const preset = getManagedPreset(item.workspacePresetId)
    if (preset && usage[preset.id] !== undefined) usage[preset.id] += 1
  }
  return usage
}

/**
 * 删除设置项 + 解除全部引用（agent/codex/claude，含合并别名），整体可回滚。
 *
 * 顺序是「先清引用、再删设置项」：删除失败就回滚引用，绝不出现「设置项没了、启动器还悬空」
 * 或「引用清了、设置项还在」的半成品。磁盘目录/worktree/分支一律不动。
 */
export async function deleteManagedWorkspace(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureManagedWorkspaces()
  // 旧合并 ID 也允许删除：解析到仍存在的设置项，删的就是它。
  const target = getManagedPreset(id)
  if (!target) return { ok: false, error: 'Workspace preset not found' }
  const snapshot = snapshotLaunchers()
  const next: Partial<LauncherSnapshot> = {}
  const agents = clearWorkspaceReference(snapshot.agents, target.id)
  if (agents) next.agents = agents
  const codex = clearWorkspaceReference(snapshot.codex, target.id)
  if (codex) next.codex = codex
  const claude = clearWorkspaceReference(snapshot.claude, target.id)
  if (claude) next.claude = claude

  const failed = replaceLaunchers(next)
  if (failed.length > 0) {
    const rollback = restoreLaunchers(snapshot, next)
    return {
      ok: false,
      error: `Could not clear launcher references (${failed.join(', ')})${rollback.length ? `; rollback failed for ${rollback.join(', ')}` : '; launchers were restored'}`
    }
  }
  if (!presets.delete(target.id)) {
    const rollback = restoreLaunchers(snapshot, next)
    return {
      ok: false,
      error: `Workspace preset could not be deleted${rollback.length ? `; rollback failed for ${rollback.join(', ')}` : '; launcher references were restored'}`
    }
  }
  return { ok: true }
}

/**
 * 清除单个启动器对设置项的引用：cwd 清成空串、隔离参数回到默认，保留 command/model/env/
 * envProfileId/permissions/order/name/id。返回 undefined 表示没有引用需要清理（不必落盘）。
 */
function clearWorkspaceReference<T extends AgentConfig | HarnessWorkspace>(items: T[], presetId: string): T[] | undefined {
  let changed = false
  const next = items.map(item => {
    const bound = item.workspacePresetId ? getManagedPreset(item.workspacePresetId) : undefined
    if (!bound || bound.id !== presetId) return item
    changed = true
    const cleared = { ...item }
    return Object.assign(cleared, { workspacePresetId: undefined, cwd: '', isolation: 'shared' as const, worktreeKey: undefined })
  })
  return changed ? next : undefined
}
