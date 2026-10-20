import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from '../storage/repository'
import type { HarnessWorkspaceRepository } from '../storage/harness-workspace-repository'
import type { HarnessWorkspace } from '@shared/harness'
import { formatCodeWorkspaceName, type CodeWorkspacePreset } from '@shared/code-workspaces'
import { expandTilde } from './cwd'

export function codeWorkspaceTargetKey(preset: Pick<CodeWorkspacePreset, 'cwd' | 'isolation' | 'worktreeKey'>): string {
  const path = resolve(expandTilde(preset.cwd))
  return JSON.stringify([process.platform === 'win32' ? path.toLowerCase() : path, preset.isolation === 'worktree' ? preset.worktreeKey : null])
}

/** 整理已有预设与后续保存：相同目录/树保留首项身份，名称冲突只用中立数字区分。 */
export function normalizeCodeWorkspaces(repository: HarnessWorkspaceRepository, markerPath: string): Record<string, string> {
  let aliases: Record<string, string> = {}
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { version?: unknown; aliases?: Record<string, string> }
    if (marker.version !== 2) throw new Error('Unknown workspace merge marker')
    aliases = { ...marker.aliases }
  }
  const before = repository.getAll()
  const result: HarnessWorkspace[] = []
  const targets = new Map<string, HarnessWorkspace>()
  const labels = new Set<string>()
  for (const preset of before) {
    if (preset.isolation === 'worktree' && !preset.worktreeKey) throw new Error('Cannot merge a worktree without its identity')
    const target = codeWorkspaceTargetKey(preset)
    const existing = targets.get(target)
    if (existing) { aliases[preset.id] = existing.id; continue }
    const base = preset.name.replace(/\s+\((?:codex|claude)(?: \d+)?\)$/i, '').trim() || 'Workspace'
    let name = base
    let sequence = 1
    while (labels.has(formatCodeWorkspaceName({ ...preset, name }))) {
      const suffix = ` (${++sequence})`
      name = `${base.slice(0, 120 - suffix.length)}${suffix}`
    }
    const kept = { ...preset, name, order: result.length }
    labels.add(formatCodeWorkspaceName(kept))
    targets.set(target, kept)
    result.push(kept)
  }
  for (const id of Object.keys(aliases)) {
    const seen = new Set([id])
    let target = aliases[id]
    while (aliases[target] && !seen.has(target)) { seen.add(target); target = aliases[target] }
    aliases[id] = target
  }
  const marker = JSON.stringify({ version: 2, aliases }, null, 2)
  // 先记录重定向再保存合并库，崩溃重试时旧 id 仍可找回对应的保留项。
  if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8') !== marker) atomicWriteFileSync(markerPath, marker)
  if (JSON.stringify(before) !== JSON.stringify(result) && !repository.replaceAll(result)) throw new Error('Could not merge workspace presets; retry to continue')
  return aliases
}
