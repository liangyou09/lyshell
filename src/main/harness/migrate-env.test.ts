import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import { HarnessWorkspaceRepository } from '../storage/harness-workspace-repository'
import { HarnessEnvProfileRepository } from '../storage/harness-env-profile-repository'
import { resolveWorkspaceEnv, type HarnessAgentRuntime } from './config'
import { migrateInlineEnvToProfiles } from './migrate-env'

// 独立文件名：vitest 并发跑多个测试文件，与 harness-*-repository.test.ts 共用 tmpdir 会互踩
const configDir = join(tmpdir(), 'config')
const wsFile = 'migrate-env-test-workspaces.json'
const envFile = 'migrate-env-test-profiles.json'
const wsPath = join(configDir, wsFile)
const envPath = join(configDir, envFile)

/** 只有 resolveWorkspaceEnv / migrateInlineEnvToProfiles 用到的字段是真的，其余占位 */
function makeRuntime(): HarnessAgentRuntime {
  return {
    kind: 'codex',
    repository: new HarnessWorkspaceRepository(wsFile),
    envRepository: new HarnessEnvProfileRepository(envFile)
  } as unknown as HarnessAgentRuntime
}

function seedWorkspaces(list: unknown[]): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(wsPath, JSON.stringify(list), 'utf-8')
}

beforeEach(() => {
  mkdirSync(configDir, { recursive: true })
  rmSync(wsPath, { force: true })
  rmSync(envPath, { force: true })
})

afterEach(() => {
  rmSync(wsPath, { force: true })
  rmSync(envPath, { force: true })
})

describe('resolveWorkspaceEnv', () => {
  it('无绑定、无启用组、无 legacy env → undefined（即系统环境变量）', () => {
    const rt = makeRuntime()
    const ws = rt.repository.add({ name: 'w', cwd: '/w' })!
    expect(resolveWorkspaceEnv(rt, ws)).toBeUndefined()
  })

  it('无绑定时用已启用的组', () => {
    const rt = makeRuntime()
    const a = rt.envRepository.add({ name: 'A', env: { K: 'a' } })!
    rt.envRepository.add({ name: 'B', env: { K: 'b' } })
    rt.envRepository.setActive(a.id)
    const ws = rt.repository.add({ name: 'w', cwd: '/w' })!
    expect(resolveWorkspaceEnv(rt, ws)).toEqual({ K: 'a' })
  })

  it('显式绑定优先于已启用的组', () => {
    const rt = makeRuntime()
    const a = rt.envRepository.add({ name: 'A', env: { K: 'a' } })!
    const b = rt.envRepository.add({ name: 'B', env: { K: 'b' } })!
    rt.envRepository.setActive(a.id)
    const ws = rt.repository.add({ name: 'w', cwd: '/w', envProfileId: b.id })!
    expect(resolveWorkspaceEnv(rt, ws)).toEqual({ K: 'b' })
  })

  it('绑定的组被删除后回落已启用的组（等同「没选」，不是第三种状态）', () => {
    const rt = makeRuntime()
    const a = rt.envRepository.add({ name: 'A', env: { K: 'a' } })!
    const b = rt.envRepository.add({ name: 'B', env: { K: 'b' } })!
    rt.envRepository.setActive(a.id)
    const ws = rt.repository.add({ name: 'w', cwd: '/w', envProfileId: b.id })!
    rt.envRepository.delete(b.id)
    expect(resolveWorkspaceEnv(rt, ws)).toEqual({ K: 'a' })
  })

  it('全部停用时回落系统环境变量，即使存在变量组', () => {
    const rt = makeRuntime()
    const a = rt.envRepository.add({ name: 'A', env: { K: 'a' } })!
    rt.envRepository.setActive(a.id)
    rt.envRepository.setActive(null)
    const ws = rt.repository.add({ name: 'w', cwd: '/w' })!
    expect(resolveWorkspaceEnv(rt, ws)).toBeUndefined()
  })

  it('legacy ws.env 排在最后：仅在无绑定且无启用组时命中（迁移失败的防御）', () => {
    const rt = makeRuntime()
    seedWorkspaces([{ id: 'w', name: 'w', cwd: '/w', order: 0, env: { LEGACY: '1' } }])
    const ws = rt.repository.get('w')!
    expect(resolveWorkspaceEnv(rt, ws)).toEqual({ LEGACY: '1' })
    // 一旦有启用组，legacy 就让位
    const a = rt.envRepository.add({ name: 'A', env: { K: 'a' } })!
    rt.envRepository.setActive(a.id)
    expect(resolveWorkspaceEnv(rt, ws)).toEqual({ K: 'a' })
  })
})

describe('migrateInlineEnvToProfiles', () => {
  it('把 inline env 抽成变量组、绑定工作区并清空 legacy 字段', () => {
    seedWorkspaces([{ id: 'w1', name: 'proj', cwd: '/w1', order: 0, env: { OPENAI_API_KEY: 'sk-1' } }])
    const rt = makeRuntime()
    expect(migrateInlineEnvToProfiles(rt)).toBe(1)

    const profiles = rt.envRepository.getAll()
    expect(profiles.length).toBe(1)
    expect(profiles[0].name).toBe('proj')
    expect(profiles[0].env).toEqual({ OPENAI_API_KEY: 'sk-1' })

    const ws = rt.repository.get('w1')!
    expect(ws.envProfileId).toBe(profiles[0].id)
    expect(ws.env).toBeUndefined()
    // 行为不变：迁移前后解析出的环境变量一致
    expect(resolveWorkspaceEnv(rt, ws)).toEqual({ OPENAI_API_KEY: 'sk-1' })
  })

  it('内容相同但 key 顺序不同的工作区合并成一条组（指纹必须排序 key）', () => {
    seedWorkspaces([
      { id: 'w1', name: 'a', cwd: '/a', order: 0, env: { A: '1', B: '2' } },
      { id: 'w2', name: 'b', cwd: '/b', order: 1, env: { B: '2', A: '1' } }
    ])
    const rt = makeRuntime()
    expect(migrateInlineEnvToProfiles(rt)).toBe(2)

    const profiles = rt.envRepository.getAll()
    expect(profiles.length).toBe(1)
    // 用首个持有者的工作区名命名
    expect(profiles[0].name).toBe('a')
    expect(rt.repository.get('w1')!.envProfileId).toBe(profiles[0].id)
    expect(rt.repository.get('w2')!.envProfileId).toBe(profiles[0].id)
  })

  it('内容不同的工作区各建一条组', () => {
    seedWorkspaces([
      { id: 'w1', name: 'a', cwd: '/a', order: 0, env: { K: '1' } },
      { id: 'w2', name: 'b', cwd: '/b', order: 1, env: { K: '2' } }
    ])
    const rt = makeRuntime()
    migrateInlineEnvToProfiles(rt)
    expect(rt.envRepository.getAll().length).toBe(2)
  })

  it('重名工作区不产生重名组', () => {
    seedWorkspaces([
      { id: 'w1', name: 'same', cwd: '/a', order: 0, env: { K: '1' } },
      { id: 'w2', name: 'same', cwd: '/b', order: 1, env: { K: '2' } }
    ])
    const rt = makeRuntime()
    migrateInlineEnvToProfiles(rt)
    const names = rt.envRepository.getAll().map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('same')
  })

  it('幂等：重复运行不再建组、不改动已迁移记录', () => {
    seedWorkspaces([{ id: 'w1', name: 'proj', cwd: '/w1', order: 0, env: { K: '1' } }])
    const rt = makeRuntime()
    expect(migrateInlineEnvToProfiles(rt)).toBe(1)
    const firstId = rt.repository.get('w1')!.envProfileId

    expect(migrateInlineEnvToProfiles(rt)).toBe(0)
    expect(rt.envRepository.getAll().length).toBe(1)
    expect(rt.repository.get('w1')!.envProfileId).toBe(firstId)

    // 换一个新实例重读磁盘（模拟下次启动），结果一致
    const rt2 = makeRuntime()
    expect(migrateInlineEnvToProfiles(rt2)).toBe(0)
    expect(rt2.envRepository.getAll().length).toBe(1)
  })

  it('已绑定变量组的工作区不被迁移碰到', () => {
    const rt = makeRuntime()
    const p = rt.envRepository.add({ name: 'kept', env: { K: 'kept' } })!
    seedWorkspaces([{ id: 'w1', name: 'w', cwd: '/w', order: 0, env: { K: 'legacy' }, envProfileId: p.id }])
    const rt2 = makeRuntime()
    expect(migrateInlineEnvToProfiles(rt2)).toBe(0)
    expect(rt2.envRepository.getAll().length).toBe(1)
  })

  it('迁移不替用户做启用决定 —— 建好的组一律未启用', () => {
    seedWorkspaces([{ id: 'w1', name: 'proj', cwd: '/w1', order: 0, env: { K: '1' } }])
    const rt = makeRuntime()
    migrateInlineEnvToProfiles(rt)
    expect(rt.envRepository.getActive()).toBeUndefined()
    // 但该工作区已显式绑定，仍能拿到原来的变量
    expect(resolveWorkspaceEnv(rt, rt.repository.get('w1')!)).toEqual({ K: '1' })
  })

  it('复用上轮遗留的同内容孤儿组，而不是再建一条', () => {
    // 模拟「组建好了但工作区没写成」：组已在，工作区仍带 legacy env
    const rt = makeRuntime()
    const orphan = rt.envRepository.add({ name: 'orphan', env: { K: '1' } })!
    seedWorkspaces([{ id: 'w1', name: 'proj', cwd: '/w1', order: 0, env: { K: '1' } }])
    const rt2 = makeRuntime()
    expect(migrateInlineEnvToProfiles(rt2)).toBe(1)
    expect(rt2.envRepository.getAll().length).toBe(1)
    expect(rt2.repository.get('w1')!.envProfileId).toBe(orphan.id)
  })

  it('没有待迁移记录时是纯 no-op', () => {
    seedWorkspaces([{ id: 'w1', name: 'w', cwd: '/w', order: 0 }])
    const rt = makeRuntime()
    expect(migrateInlineEnvToProfiles(rt)).toBe(0)
    expect(rt.envRepository.getAll()).toEqual([])
  })
})
