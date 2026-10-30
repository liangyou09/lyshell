import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CodeWorkspacePreset } from '@shared/code-workspaces'
import type { SceneNode, SceneTarget } from '@shared/project-scene'

const { presets } = vi.hoisted(() => ({ presets: new Map<string, CodeWorkspacePreset>() }))
vi.mock('../storage/harness-workspace-repository', () => ({ codeWorkspacePresetRepository: { get: (id: string) => presets.get(id) } }))
vi.mock('../storage/repository', async () => {
  const fs = await import('node:fs')
  return { getConfigDir: () => '.', atomicWriteFileSync: (path: string, data: string) => { fs.writeFileSync(`${path}.tmp`, data); fs.renameSync(`${path}.tmp`, path) } }
})
import { ProjectSceneRepository } from '../storage/project-scene-repository'
import { RevisionConflictError } from '../storage/atomic-json'
import { requestProjectScene, sceneDocAllowed, sceneTargetCwd } from './project-scene'

describe('project scene persistence and selective restoration', () => {
  let dir: string
  let repository: ProjectSceneRepository
  let target: SceneTarget
  const launch = vi.fn(async () => {})
  const check = vi.fn(async () => {})
  const launcher = { launch, check }
  const leaf = (entries: Extract<SceneNode, { type: 'leaf' }>['entries']): SceneNode => ({ type: 'leaf', entries, active: entries.length ? 0 : -1 })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lyshell-scene-'))
    mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'))
    presets.clear(); launch.mockClear(); check.mockReset().mockResolvedValue(undefined)
    presets.set('a', { id: 'a', order: 0, name: 'A', cwd: join(dir, 'a'), isolation: 'shared' })
    presets.set('b', { id: 'b', order: 1, name: 'B', cwd: join(dir, 'b'), isolation: 'shared' })
    target = { presetId: 'a', cwd: join(dir, 'a'), isolation: 'shared' }
    repository = new ProjectSceneRepository(join(dir, 'scenes.json'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('saves, reopens repository, restores layout without executing anything', async () => {
    const doc = join(target.cwd, 'readme.md'); writeFileSync(doc, '# saved')
    const root: SceneNode = { type: 'split', direction: 'vertical', ratio: .35, first: leaf([{ kind: 'directory' }, { kind: 'doc', path: doc }]), second: leaf([{ kind: 'web', url: 'https://example.com/docs' }]) }
    const saved = await requestProjectScene({ kind: 'save', target, root, activeLeaf: 1 }, launcher, repository)
    expect(saved.success).toBe(true)
    if (!saved.success) return
    const reopened = new ProjectSceneRepository(join(dir, 'scenes.json'))
    const restored = await requestProjectScene({ kind: 'restore', id: saved.scene!.id }, launcher, reopened)
    expect(restored.success && restored.scene?.root).toEqual(root)
    expect(restored.success && restored.scene?.activeLeaf).toBe(1)
    expect(launch).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'scenes.json'), 'utf8')).not.toContain('# saved')
  })
  it('isolates two projects and refuses moved/rebound presets', async () => {
    const a = repository.save({ target, directory: target.cwd, root: leaf([{ kind: 'directory' }, { kind: 'web', url: 'https://example.com/a' }]), activeLeaf: 0 })
    const bTarget = { ...target, presetId: 'b', cwd: join(dir, 'b') }
    const b = repository.save({ target: bTarget, directory: bTarget.cwd, root: leaf([{ kind: 'directory' }]), activeLeaf: 0 })
    presets.set('a', { ...presets.get('a')!, cwd: bTarget.cwd })
    const result = await requestProjectScene({ kind: 'restore', id: a.id }, launcher, repository)
    expect(result.success && result.issues.join()).toMatch(/移动/)
    expect(result.success && result.scene?.root).toEqual(leaf([{ kind: 'web', url: 'https://example.com/a' }]))
    const other = await requestProjectScene({ kind: 'restore', id: b.id }, launcher, repository)
    expect(other.success && other.scene?.target.presetId).toBe('b')
    expect(launch).not.toHaveBeenCalled()
  })
  it('reports missing docs, deleted launchers and unavailable CLI while restoring others', async () => {
    const doc = join(target.cwd, 'deleted.md')
    check.mockRejectedValue(new Error('CLI 不可用：codex'))
    const scene = repository.save({ target, directory: target.cwd, root: leaf([{ kind: 'doc', path: doc }, { kind: 'agent', agentKind: 'codex', agentId: 'deleted' }, { kind: 'web', url: 'https://example.com/' }]), activeLeaf: 0 })
    const result = await requestProjectScene({ kind: 'restore', id: scene.id }, launcher, repository)
    expect(result.success && result.issues).toHaveLength(2)
    expect(result.success && result.scene?.root).toEqual(leaf([{ kind: 'web', url: 'https://example.com/' }]))
    presets.delete('a')
    const again = await requestProjectScene({ kind: 'restore', id: scene.id }, launcher, repository)
    expect(again.success && again.issues.join()).toContain('预设已删除')
    expect(launch).not.toHaveBeenCalled()
  })
  it('detects a moved physical directory without rebinding another project', async () => {
    const scene = repository.save({ target, directory: target.cwd, root: leaf([{ kind: 'directory' }]), activeLeaf: 0 })
    renameSync(target.cwd, join(dir, 'moved'))
    const result = await requestProjectScene({ kind: 'restore', id: scene.id }, launcher, repository)
    expect(result.success && result.issues.join()).toContain('项目目录不可用')
  })
  it('uses registered worktrees and never creates a missing worktree', async () => {
    execFileSync('git', ['init', target.cwd], { windowsHide: true })
    execFileSync('git', ['-C', target.cwd, '-c', 'user.name=Scene QA', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { windowsHide: true })
    for (const key of ['one', 'two']) {
      const path = join(target.cwd, '.lyshell-worktrees', key)
      execFileSync('git', ['-C', target.cwd, 'worktree', 'add', '-b', key, path], { windowsHide: true })
      presets.set(key, { id: key, order: 1, name: key, cwd: target.cwd, isolation: 'worktree', worktreeKey: key })
    }
    for (const key of ['one', 'two']) expect(await sceneTargetCwd({ ...target, presetId: key, isolation: 'worktree', worktreeKey: key })).toBe(join(target.cwd, '.lyshell-worktrees', key))
    const treeDoc = join(target.cwd, '.lyshell-worktrees/one/README.md')
    writeFileSync(treeDoc, '# worktree one')
    expect(sceneDocAllowed(treeDoc, target.cwd)).toBe(false)
    expect(sceneDocAllowed(treeDoc, join(target.cwd, '.lyshell-worktrees/one'))).toBe(true)
    await expect(sceneTargetCwd({ ...target, presetId: 'one', isolation: 'worktree', worktreeKey: 'two' })).rejects.toThrow('变更')
    rmSync(join(target.cwd, '.lyshell-worktrees/one'), { recursive: true })
    await expect(sceneTargetCwd({ ...target, presetId: 'one', isolation: 'worktree', worktreeKey: 'one' })).rejects.toThrow()
  })
  it('retains future/corrupt archives instead of overwriting them', () => {
    const file = join(dir, 'scenes.json'); writeFileSync(file, '{"version":2,"scenes":[]}')
    expect(() => repository.save({ target, directory: target.cwd, root: leaf([]), activeLeaf: 0 })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{"version":2,"scenes":[]}')
  })

  it('rejects a stale expectedRevision without changing disk or memory', () => {
    const saved = repository.save({ target, directory: target.cwd, root: leaf([{ kind: 'directory' }]), activeLeaf: 0 })
    const revision = repository.getRevision()
    expect(() => repository.save({ target, directory: target.cwd, root: leaf([]), activeLeaf: 0 }, { expectedRevision: revision - 1 }))
      .toThrow(RevisionConflictError)
    expect(repository.list().map(scene => scene.id)).toEqual([saved.id])
    const reopened = new ProjectSceneRepository(join(dir, 'scenes.json'))
    expect(reopened.list().map(scene => scene.id)).toEqual([saved.id])
  })
})
