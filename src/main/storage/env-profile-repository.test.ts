import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

// electron-log / electron.app.getPath 在 Node 测试环境不存在，mock 掉（对齐 harness-workspace-repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import { EnvProfileRepository } from './env-profile-repository'

// 独立文件名：vitest 并发跑多个测试文件，与其他测试共用 tmpdir 会互踩
// （也不能用 'env-profiles.json'，会撞上被测单例 envProfileRepository）
const configDir = join(tmpdir(), 'config')
const testFile = 'env-profile-repo-test.json'
const filePath = join(configDir, testFile)

function seed(content: string): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
}

beforeEach(() => {
  mkdirSync(configDir, { recursive: true })
  rmSync(filePath, { force: true })
})

afterEach(() => {
  rmSync(filePath, { force: true })
})

function newRepo(): EnvProfileRepository {
  return new EnvProfileRepository(testFile)
}

describe('EnvProfileRepository（全局变量组库）', () => {
  it('无文件时返回空列表', () => {
    expect(newRepo().getAll()).toEqual([])
  })

  it('损坏 JSON / 非对象 JSON 时降级为空列表（恢复而非崩溃）', () => {
    seed('{ not valid json')
    expect(newRepo().getAll()).toEqual([])
    seed('42')
    expect(newRepo().getAll()).toEqual([])
  })

  it('旧 per-kind 数组格式按损坏处理为空库（并入只走 migrate-profiles.ts）', () => {
    seed(JSON.stringify([{ id: 'a', name: 'a', order: 0, env: { K: 'v' } }]))
    const repo = newRepo()
    expect(repo.getAll()).toEqual([])
    expect(repo.getActiveProfileId('codex')).toBeUndefined()
  })

  it('过滤非法记录：缺 name/order、env 为空或非对象一律丢弃', () => {
    seed(JSON.stringify({ profiles: [
      { id: 'a', name: 'ok', order: 0, env: { K: 'v' } },
      { id: 'b', order: 1, env: { K: 'v' } },
      { id: 'c', name: 'no-order', env: { K: 'v' } },
      // 零变量的组没有意义，按非法处理
      { id: 'd', name: 'empty-env', order: 3, env: {} },
      { id: 'e', name: 'bad-env', order: 4, env: 'not-an-object' },
      'garbage'
    ] }))
    expect(newRepo().getAll().map((p) => p.id)).toEqual(['a'])
  })

  it('env 脏数据过滤：丢空 key / 含 NUL 的 key / 含 NUL 的 value / 非字符串值', () => {
    const NUL = String.fromCharCode(0)
    seed(JSON.stringify({ profiles: [
      { id: 'a', name: 'a', order: 0, env: { '': 'x', ['A' + NUL + 'B']: 'y', K1: 'v1', K2: 'va' + NUL + 'lue', K3: 42 } }
    ] }))
    expect(newRepo().get('a')?.env).toEqual({ K1: 'v1' })
  })

  it('加载时按 order 稳定排序并 reindex 为 0..n-1', () => {
    seed(JSON.stringify({ profiles: [
      { id: 'a', name: 'a', order: 5, env: { K: '1' } },
      { id: 'b', name: 'b', order: 2, env: { K: '2' } },
      { id: 'c', name: 'c', order: 2, env: { K: '3' } }
    ] }))
    const all = newRepo().getAll()
    expect(all.map((p) => p.id)).toEqual(['b', 'c', 'a'])
    expect(all.map((p) => p.order)).toEqual([0, 1, 2])
  })

  it('重复 id 按首个有效记录去重', () => {
    seed(JSON.stringify({ profiles: [
      { id: 'dup', name: 'first', order: 0, env: { K: '1' } },
      { id: 'dup', name: 'second', order: 1, env: { K: '2' } },
      { id: 'other', name: 'other', order: 2, env: { K: '3' } }
    ] }))
    expect(newRepo().getAll().map((p) => p.name)).toEqual(['first', 'other'])
  })

  it('add 分配连续 order，新建不点亮任何 kind 的启用指针', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    expect([a.order, b.order]).toEqual([0, 1])
    expect(repo.getActiveProfileId('dsh')).toBeUndefined()
    expect(repo.getActiveProfileId('codex')).toBeUndefined()
    expect(repo.getActiveProfileId('claude')).toBeUndefined()
  })

  it('setActiveProfile 单选（per-kind 指针）：同 kind 内切换即替换', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    expect(repo.setActiveProfile('codex', a.id)).toBe(true)
    expect(repo.getActiveProfile('codex')?.id).toBe(a.id)
    expect(repo.setActiveProfile('codex', b.id)).toBe(true)
    expect(repo.getActiveProfile('codex')?.id).toBe(b.id)
  })

  it('各 kind 指针互不影响 —— 同一组可被多个 kind 同时启用', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActiveProfile('dsh', a.id)
    repo.setActiveProfile('codex', a.id)
    expect(repo.getActiveProfile('dsh')?.id).toBe(a.id)
    expect(repo.getActiveProfile('codex')?.id).toBe(a.id)
    // 停用 dsh 不牵连 codex
    repo.setActiveProfile('dsh', null)
    expect(repo.getActiveProfile('dsh')).toBeUndefined()
    expect(repo.getActiveProfile('codex')?.id).toBe(a.id)
  })

  it('setActiveProfile(kind, null) 停用该 kind —— 回落系统环境变量', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActiveProfile('codex', a.id)
    expect(repo.setActiveProfile('codex', null)).toBe(true)
    expect(repo.getActiveProfile('codex')).toBeUndefined()
  })

  it('setActiveProfile 指向不存在的 id 返回 false 且不改动现状', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActiveProfile('codex', a.id)
    expect(repo.setActiveProfile('codex', 'nope')).toBe(false)
    expect(repo.getActiveProfile('codex')?.id).toBe(a.id)
  })

  it('加载时清洗 activeByKind：悬空指针、未知 kind、非字符串值一律丢弃', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActiveProfile('codex', a.id)
    // 手工改坏指针：codex 悬空 + 未知 kind + 非字符串
    seed(JSON.stringify({
      profiles: [{ id: a.id, name: 'a', order: 0, env: { K: '1' } }],
      activeByKind: { codex: 'deleted-id', unknown: a.id, dsh: 42, claude: a.id }
    }))
    const repo2 = newRepo()
    expect(repo2.getActiveProfileId('codex')).toBeUndefined()
    expect(repo2.getActiveProfileId('dsh')).toBeUndefined()
    expect(repo2.getActiveProfileId('claude')).toBe(a.id)
  })

  it('update 不改动启用指针（启用只经 setActiveProfile）', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActiveProfile('codex', a.id)
    expect(repo.update({ ...a, name: 'a2' })).toBe(true)
    expect(repo.get(a.id)?.name).toBe('a2')
    expect(repo.getActiveProfile('codex')?.id).toBe(a.id)
  })

  it('update 不存在的 id 返回 false', () => {
    const repo = newRepo()
    expect(repo.update({ id: 'nope', name: 'x', order: 0, env: { K: '1' } })).toBe(false)
  })

  it('delete 后 reindex 不留 order 空洞，且指向被删组的指针一并清掉', () => {
    const repo = newRepo()
    repo.add({ name: 'a', env: { K: '1' } })
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    repo.add({ name: 'c', env: { K: '3' } })
    repo.setActiveProfile('dsh', b.id)
    repo.setActiveProfile('claude', b.id)
    expect(repo.delete(b.id)).toBe(true)
    expect(repo.getAll().map((p) => p.order)).toEqual([0, 1])
    // dsh / claude 指向被删组 → 清空（等价停用）；无指针的 codex 不受影响
    expect(repo.getActiveProfileId('dsh')).toBeUndefined()
    expect(repo.getActiveProfileId('claude')).toBeUndefined()
    expect(repo.delete('nope')).toBe(false)
  })

  it('add / setActiveProfile 后持久化，新实例可读到', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: 'v' } })!
    repo.setActiveProfile('codex', a.id)
    const repo2 = newRepo()
    expect(repo2.getAll().map((p) => p.name)).toEqual(['a'])
    expect(repo2.getActiveProfile('codex')?.name).toBe('a')
  })

  describe('importProfiles（迁移并入）', () => {
    it('保留 id 并入、接在现有 order 之后，指针只补空位', () => {
      const repo = newRepo()
      const kept = repo.add({ name: 'kept', env: { K: 'kept' } })!
      const imported = [
        { id: 'old-1', name: 'o1', order: 0, env: { K: '1' } },
        { id: 'old-2', name: 'o2', order: 1, env: { K: '2' } }
      ]
      expect(repo.importProfiles(imported, { codex: 'old-1' })).toBe(2)
      const all = repo.getAll()
      expect(all.map((p) => p.id)).toEqual([kept.id, 'old-1', 'old-2'])
      expect(all.map((p) => p.order)).toEqual([0, 1, 2])
      expect(repo.getActiveProfile('codex')?.id).toBe('old-1')
    })

    it('幂等：重复 import 同 id 不再并入，已有指针不被覆盖', () => {
      const repo = newRepo()
      const mine = repo.add({ name: 'mine', env: { K: 'm' } })!
      repo.setActiveProfile('codex', mine.id)
      const imported = [{ id: 'old-1', name: 'o1', order: 0, env: { K: '1' } }]
      expect(repo.importProfiles(imported, { codex: 'old-1' })).toBe(1)
      // 第二轮：old-1 已在库中（跳过），codex 指针已占用（不覆盖）
      expect(repo.importProfiles(imported, { codex: 'old-1', dsh: 'old-1' })).toBe(0)
      expect(repo.getAll().length).toBe(2)
      expect(repo.getActiveProfile('codex')?.id).toBe(mine.id)
      expect(repo.getActiveProfile('dsh')?.id).toBe('old-1')
    })

    it('import 的指针指向不存在的组时不落盘（悬空不写）', () => {
      const repo = newRepo()
      repo.importProfiles([{ id: 'old-1', name: 'o1', order: 0, env: { K: '1' } }], { codex: 'nope' })
      expect(repo.getActiveProfileId('codex')).toBeUndefined()
    })

    it('并入结果持久化，新实例可读到', () => {
      const repo = newRepo()
      repo.importProfiles([{ id: 'old-1', name: 'o1', order: 0, env: { K: '1' } }], { claude: 'old-1' })
      const repo2 = newRepo()
      expect(repo2.get('old-1')?.name).toBe('o1')
      expect(repo2.getActiveProfile('claude')?.id).toBe('old-1')
    })
  })

  it('models 脏数据过滤：非字符串/空串丢弃、trim、去重；全空则不写键', () => {
    seed(JSON.stringify({ profiles: [
      { id: 'a', name: 'a', order: 0, env: { K: '1' }, models: [' GLM-5.2 ', 'GLM-5.2', '', 42, null, 'gpt-5-codex'] },
      { id: 'b', name: 'b', order: 1, env: { K: '2' }, models: 'not-an-array' },
      { id: 'c', name: 'c', order: 2, env: { K: '3' }, models: ['', '   '] }
    ] }))
    const all = newRepo().getAll()
    expect(all[0].models).toEqual(['GLM-5.2', 'gpt-5-codex'])
    expect(all[1].models).toBeUndefined() // 非数组按缺失处理
    expect(all[2].models).toBeUndefined() // 归一化后为空不写键
  })

  it('models 超上限截断到 64（兜手工编辑的病态文件）', () => {
    seed(JSON.stringify({ profiles: [
      { id: 'a', name: 'a', order: 0, env: { K: '1' }, models: Array.from({ length: 100 }, (_, i) => `m-${i}`) }
    ] }))
    expect(newRepo().get('a')?.models?.length).toBe(64)
  })

  it('add / update 透传 models，且 update 整条替换（缺席即清空）', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' }, models: ['GLM-5.2'] })!
    expect(repo.get(a.id)?.models).toEqual(['GLM-5.2'])
    // 换一组模型
    expect(repo.update({ ...a, env: { K: '1' }, models: ['GLM-5.2', 'GLM-5.2-air'] })).toBe(true)
    expect(repo.get(a.id)?.models).toEqual(['GLM-5.2', 'GLM-5.2-air'])
    // payload 不带 models 即清空（与 note 同一套整条替换语义）
    const current = repo.get(a.id)!
    expect(repo.update({ id: current.id, name: current.name, order: current.order, env: current.env })).toBe(true)
    expect(repo.get(a.id)?.models).toBeUndefined()
    // 持久化可读回
    expect(newRepo().get(a.id)?.models).toBeUndefined()
  })
})
