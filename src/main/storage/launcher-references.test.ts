import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

// electron.app.getPath 在 Node 测试环境不存在，mock 到每个用例独立的临时 userData
const state = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.profile } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

let workdir: string
beforeEach(() => {
  vi.resetModules()
  state.profile = mkdtempSync(join(tmpdir(), 'lyshell-launcher-refs-'))
  workdir = join(state.profile, 'project')
  mkdirSync(workdir)
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(state.profile)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('lyshell-launcher-refs-')) throw new Error('Unexpected fixture cleanup path')
  rmSync(target, { recursive: true, force: true })
})

/** 每条启动器绑定到变量组，并保留各自特有属性用于核验「只清 envProfileId」。 */
async function seed() {
  const { agentRepository } = await import('./agent-repository')
  const { dshWorkspaceRepository, codexWorkspaceRepository, claudeWorkspaceRepository } = await import('./harness-workspace-repository')
  const { envProfileRepository } = await import('./env-profile-repository')
  const profile = envProfileRepository.add({ name: 'Work', env: { A: '1' } })!
  const other = envProfileRepository.add({ name: 'Other', env: { B: '2' } })!
  const agent = agentRepository.add({
    name: 'Agent',
    command: 'tool',
    cwd: workdir,
    envProfileId: profile.id,
    envKeyMap: { baseUrl: 'TOOL_BASE_URL', apiKey: 'TOOL_API_KEY' },
    order: 0
  })!
  const otherAgent = agentRepository.add({ name: 'Other agent', command: 'tool', envProfileId: other.id, order: 1 })!
  const dsh = dshWorkspaceRepository.add({ name: 'dsh', cwd: workdir, envProfileId: profile.id, model: 'dsh-model' })!
  const codex = codexWorkspaceRepository.add({ name: 'codex', cwd: workdir, envProfileId: profile.id, codexPermissions: ':read-only' })!
  const claude = claudeWorkspaceRepository.add({ name: 'claude', cwd: workdir, envProfileId: profile.id, claudePermissions: 'plan' })!
  return { agentRepository, dshWorkspaceRepository, codexWorkspaceRepository, claudeWorkspaceRepository, envProfileRepository, profile, other, agent, otherAgent, dsh, codex, claude }
}

describe('releaseEnvProfileReferences', () => {
  it('清引用和回滚都保留启动器原排序值', async () => {
    const { releaseEnvProfileReferences } = await import('./launcher-references')
    const { codexWorkspaceRepository, codex, profile } = await seed()
    expect(codexWorkspaceRepository.update({ ...codex, order: 42 })).toBe(true)
    const released = releaseEnvProfileReferences(profile.id)
    if (!released.ok) throw new Error(released.error)
    expect(codexWorkspaceRepository.get(codex.id)?.order).toBe(42)
    expect(released.restore()).toBeUndefined()
    expect(codexWorkspaceRepository.get(codex.id)?.order).toBe(42)
    expect(codexWorkspaceRepository.get(codex.id)?.envProfileId).toBe(profile.id)
  })
  it('清空四库中指向该变量组的显式绑定，保留其它属性与其它变量组', async () => {
    const { releaseEnvProfileReferences } = await import('./launcher-references')
    const { agentRepository, dshWorkspaceRepository, codexWorkspaceRepository, claudeWorkspaceRepository, envProfileRepository, profile, other, agent, otherAgent, dsh, codex, claude } = await seed()

    const released = releaseEnvProfileReferences(profile.id)
    expect(released.ok).toBe(true)

    // 四类启动器全部解除绑定
    expect(agentRepository.get(agent.id)?.envProfileId).toBeUndefined()
    expect(dshWorkspaceRepository.get(dsh.id)?.envProfileId).toBeUndefined()
    expect(codexWorkspaceRepository.get(codex.id)?.envProfileId).toBeUndefined()
    expect(claudeWorkspaceRepository.get(claude.id)?.envProfileId).toBeUndefined()

    // 只清 envProfileId：命令/目录/模型/权限映射/档位全部原样
    expect(agentRepository.get(agent.id)).toEqual(expect.objectContaining({
      name: 'Agent',
      command: 'tool',
      cwd: workdir,
      envKeyMap: { baseUrl: 'TOOL_BASE_URL', apiKey: 'TOOL_API_KEY' }
    }))
    expect(dshWorkspaceRepository.get(dsh.id)?.model).toBe('dsh-model')
    expect(codexWorkspaceRepository.get(codex.id)?.codexPermissions).toBe(':read-only')
    expect(claudeWorkspaceRepository.get(claude.id)?.claudePermissions).toBe('plan')

    // 绑定其它变量组的启动器不受影响；变量组本身不被改写、也不复制到别处
    expect(agentRepository.get(otherAgent.id)?.envProfileId).toBe(other.id)
    expect(envProfileRepository.get(profile.id)?.env).toEqual({ A: '1' })
    expect(envProfileRepository.get(other.id)?.env).toEqual({ B: '2' })
  })

  it('没有引用时不写盘，也不产生副作用', async () => {
    const { releaseEnvProfileReferences } = await import('./launcher-references')
    const { envProfileRepository, agentRepository, agent, profile } = await seed()
    const write = vi.spyOn(agentRepository, 'replaceAll')
    const released = releaseEnvProfileReferences('missing-profile')
    expect(released.ok).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect(agentRepository.get(agent.id)?.envProfileId).toBe(profile.id)
    expect(envProfileRepository.get(profile.id)).toBeTruthy()
    write.mockRestore()
  })

  it('落盘失败时回滚全部绑定并明确报错（不留半清空状态）', async () => {
    const { releaseEnvProfileReferences } = await import('./launcher-references')
    const { agentRepository, dshWorkspaceRepository, codexWorkspaceRepository, claudeWorkspaceRepository, profile, agent, dsh, codex, claude } = await seed()

    // 前两个库（agents/dsh）已写成功、codex 写失败 —— 必须整库回滚
    const fail = vi.spyOn(codexWorkspaceRepository, 'replaceAll').mockReturnValueOnce(false)
    const released = releaseEnvProfileReferences(profile.id)
    expect(released.ok).toBe(false)
    if (released.ok) throw new Error('unreachable')
    expect(released.error).toContain('Could not clear env profile references')
    expect(released.error).toContain('launchers were restored')
    fail.mockRestore()

    expect(agentRepository.get(agent.id)?.envProfileId).toBe(profile.id)
    expect(dshWorkspaceRepository.get(dsh.id)?.envProfileId).toBe(profile.id)
    expect(codexWorkspaceRepository.get(codex.id)?.envProfileId).toBe(profile.id)
    expect(claudeWorkspaceRepository.get(claude.id)?.envProfileId).toBe(profile.id)
  })

  it('配合变量组删除：清空 activeProfileId，其它变量组与启动器属性不变', async () => {
    const { releaseEnvProfileReferences } = await import('./launcher-references')
    const { envProfileRepository, agentRepository, other, otherAgent, agent, profile } = await seed()
    expect(envProfileRepository.setActiveProfile(profile.id)).toBe(true)

    const released = releaseEnvProfileReferences(profile.id)
    expect(released.ok).toBe(true)
    expect(envProfileRepository.delete(profile.id)).toBe(true)

    expect(envProfileRepository.getActiveProfileId()).toBeNull()
    expect(envProfileRepository.getAll().map(item => item.id)).toEqual([other.id])
    expect(agentRepository.get(agent.id)?.envProfileId).toBeUndefined()
    expect(agentRepository.get(otherAgent.id)?.envProfileId).toBe(other.id)
    expect(agentRepository.getAll()).toHaveLength(2)
  })

  it('变量组删除失败时用 restore 回滚引用，不留悬空绑定', async () => {
    const { releaseEnvProfileReferences } = await import('./launcher-references')
    const { envProfileRepository, agentRepository, codexWorkspaceRepository, profile, agent, codex } = await seed()

    const released = releaseEnvProfileReferences(profile.id)
    expect(released.ok).toBe(true)
    if (!released.ok) throw new Error(released.error)
    expect(agentRepository.get(agent.id)?.envProfileId).toBeUndefined()

    // 变量组本体删不掉（如落盘失败）时，handler 会回滚引用
    const fail = vi.spyOn(envProfileRepository, 'delete').mockReturnValueOnce(false)
    expect(envProfileRepository.delete(profile.id)).toBe(false)
    fail.mockRestore()
    expect(released.restore()).toBeUndefined()

    expect(agentRepository.get(agent.id)?.envProfileId).toBe(profile.id)
    expect(codexWorkspaceRepository.get(codex.id)?.envProfileId).toBe(profile.id)
    expect(envProfileRepository.get(profile.id)).toBeTruthy()
  })
})
