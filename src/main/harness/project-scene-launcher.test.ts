import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SceneEntry, SceneTarget } from '@shared/project-scene'
const state = vi.hoisted(() => ({ cwd: '/a', available: true, exists: true }))
vi.mock('./project-scene', () => ({ sceneTargetCwd: async () => state.cwd }))
vi.mock('./normalize-code-workspaces', () => ({ codeWorkspaceTargetKey: (target: { cwd: string; worktreeKey?: string }) => JSON.stringify([target.cwd, target.worktreeKey ?? null]) }))
vi.mock('../env/refresh', () => ({ readSystemPath: async () => 'test' }))
vi.mock('./detect', () => ({ detectDependencies: (deps: string[]) => Object.fromEntries(deps.map(dep => [dep, state.available])) }))
vi.mock('./workspace-governance', () => ({ managedTargetOf: () => ({ cwd: state.cwd }) }))
vi.mock('../storage/agent-repository', () => ({ agentRepository: { get: () => null }, resolveAgentLaunchEnv: () => undefined }))
vi.mock('../storage/env-profile-repository', () => ({ envProfileRepository: {} }))
vi.mock('./config', () => {
  const runtime = (kind: string) => ({
    dependencies: [kind], repository: { get: () => state.exists ? { id: 'launcher', name: kind, cwd: state.cwd, workspacePresetId: 'p' } : null },
    normalizeEnv: () => ({ ok: true }), prepareModel: () => ({ ok: true }), buildLaunchCommand: () => ({ ok: true, command: kind })
  })
  return { HARNESS_AGENTS: { codex: runtime('codex'), claude: runtime('claude'), dsh: runtime('dsh') }, resolveWorkspaceEnv: () => undefined }
})
import { createSceneLauncher } from './project-scene-launcher'

describe('scene explicit launch boundary', () => {
  const target: SceneTarget = { presetId: 'p', cwd: '/a' }
  const entry = (agentKind: 'codex' | 'claude' | 'dsh'): SceneEntry => ({ kind: 'agent', agentKind, agentId: 'launcher' })
  const spawn = vi.fn(async (_name: string, _command: string | undefined, _tags: string[], _opts: { cwd: string; env?: Record<string, string> }) => ({ success: true, id: 'new-terminal' }))
  beforeEach(() => { state.cwd = '/a'; state.available = true; state.exists = true; spawn.mockClear() })
  it('requires explicit launch, opens a history picker without choosing last conversation', async () => {
    const launcher = createSceneLauncher(spawn)
    await launcher.check(target, entry('codex') as Extract<SceneEntry, { kind: 'agent' }>)
    expect(spawn).not.toHaveBeenCalled()
    expect(launcher.describe?.(target, entry('codex'))).toBe('codex')
    expect(spawn).not.toHaveBeenCalled()
    expect(await launcher.launch(target, entry('codex'), true)).toEqual({ sessionId: 'new-terminal' })
    expect(spawn.mock.calls[0]?.[1]).toBe('codex resume')
    await launcher.launch(target, entry('claude'), true)
    expect(spawn.mock.calls[1]?.[1]).toBe('claude --resume')
  })
  it('rejects cross-project references, deleted launchers and missing CLI without spawning', async () => {
    const launcher = createSceneLauncher(spawn)
    state.cwd = '/b'
    await expect(launcher.launch(target, entry('codex'), false)).rejects.toThrow('其他目录')
    state.cwd = '/a'; state.exists = false
    await expect(launcher.launch(target, entry('codex'), false)).rejects.toThrow('删除')
    state.exists = true; state.available = false
    await expect(launcher.launch(target, entry('codex'), false)).rejects.toThrow('CLI 不可用')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('refuses unverified DeepSeek continuation and opens directory with no command', async () => {
    const launcher = createSceneLauncher(spawn)
    await expect(launcher.launch(target, entry('dsh'), true)).rejects.toThrow('跨重启')
    expect(spawn).not.toHaveBeenCalled()
    await launcher.launch(target, { kind: 'directory' }, false)
    expect(spawn.mock.calls[0]?.[1]).toBeUndefined()
  })
})
