import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

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
  // recursive:落盘失败用例会用目录占住文件路径,普通 rm 删不掉;顺手清遗留 .tmp
  rmSync(filePath, { recursive: true, force: true })
  rmSync(`${filePath}.tmp`, { force: true })
})

afterEach(() => {
  rmSync(filePath, { recursive: true, force: true })
  rmSync(`${filePath}.tmp`, { force: true })
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
    expect(repo.getActiveProfileId()).toBeNull()
  })

  it('过滤非法记录：缺 name/order、env 为空或非对象一律丢弃', () => {
    seed(JSON.stringify({ profiles: [
      { id: 'a', name: 'ok', order: 0, env: { K: 'v' } },
      { id: 'b', order: 1, env: { K: 'v' } },
      { id: 'c', name: 'no-order', env: { K: 'v' } },
      // 零变量且无结构化核心的组没有意义，按非法处理
      { id: 'd', name: 'empty-env', order: 3, env: {} },
      { id: 'e', name: 'bad-env', order: 4, env: 'not-an-object' },
      'garbage'
    ] }))
    expect(newRepo().getAll().map((p) => p.id)).toEqual(['a'])
  })

  describe('结构化核心（baseUrl + apiKey）', () => {
    it('核心存在即合法：附加变量可为空（纯凭据 / 纯地址的组都有意义）', () => {
      seed(JSON.stringify({ profiles: [
        { id: 'a', name: 'both', order: 0, baseUrl: 'https://1.1.1.3:8443/v1', apiKey: 'sk-x', env: {} },
        { id: 'b', name: 'url-only', order: 1, baseUrl: 'https://u' },
        { id: 'c', name: 'key-only', order: 2, apiKey: 'sk', env: undefined },
        // 核心字段 trim 后为空按缺省，与附加变量合并判非法
        { id: 'd', name: 'blank', order: 3, baseUrl: '   ', apiKey: '' }
      ] }))
      const all = newRepo().getAll()
      expect(all.map((p) => p.id)).toEqual(['a', 'b', 'c'])
      expect(all[0].env).toEqual({})
      expect(all[2].apiKey).toBe('sk')
    })

    it('legacy 扁平凭据防御性提升：无核心但 env 含已知协议键 → 提回结构化核心', () => {
      // 迁移只跑一次且可能在本仓库加载后才落盘，这一级保证未迁移文件行为也正确
      seed(JSON.stringify({ profiles: [
        { id: 'a', name: 'glm', order: 0, env: { OPENAI_BASE_URL: 'https://1.1.1.3:8443/v1', OPENAI_API_KEY: 'sk-1', CODEX_HOME: 'C:/x' } }
      ] }))
      const p = newRepo().get('a')!
      expect(p.baseUrl).toBe('https://1.1.1.3:8443/v1')
      expect(p.apiKey).toBe('sk-1')
      expect(p.env).toEqual({ CODEX_HOME: 'C:/x' })
    })

    it('add / update 透传结构化核心并持久化，update 整条替换（核心缺席即清空）', () => {
      const repo = newRepo()
      const a = repo.add({ name: 'a', baseUrl: 'https://u', apiKey: 'sk', env: {} })!
      expect(repo.get(a.id)?.baseUrl).toBe('https://u')
      // 持久化可读回
      expect(newRepo().get(a.id)?.apiKey).toBe('sk')
      // 换掉核心（保留附加变量）
      expect(repo.update({ ...repo.get(a.id)!, baseUrl: 'https://v2', apiKey: undefined, env: { K: '1' } })).toBe(true)
      expect(repo.get(a.id)?.baseUrl).toBe('https://v2')
      expect(repo.get(a.id)?.apiKey).toBeUndefined()
      expect(repo.get(a.id)?.env).toEqual({ K: '1' })
      // 持久化再读回
      expect(newRepo().get(a.id)?.baseUrl).toBe('https://v2')
    })
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

  it('add 分配连续 order，新建不点亮启用指针', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    expect([a.order, b.order]).toEqual([0, 1])
    expect(repo.getActiveProfileId()).toBeNull()
  })

  it('setActiveProfile 全局单选：启用新组即替换原指针（dsh/codex/claude 共用同一根）', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    expect(repo.setActiveProfile(a.id)).toBe(true)
    expect(repo.getActiveProfile()?.id).toBe(a.id)
    expect(repo.setActiveProfile(b.id)).toBe(true)
    expect(repo.getActiveProfile()?.id).toBe(b.id)
  })

  it('setActiveProfile(null) 停用 —— 回落系统环境变量', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActiveProfile(a.id)
    expect(repo.setActiveProfile(null)).toBe(true)
    expect(repo.getActiveProfile()).toBeUndefined()
    expect(repo.getActiveProfileId()).toBeNull()
  })

  it('setActiveProfile 指向不存在的 id 返回 false 且不改动现状', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActiveProfile(a.id)
    expect(repo.setActiveProfile('nope')).toBe(false)
    expect(repo.getActiveProfile()?.id).toBe(a.id)
  })

  describe('启用指针加载归一（新键 activeProfileId + legacy activeByKind）', () => {
    const seedProfiles = (extra: Record<string, unknown>): void =>
      seed(JSON.stringify({
        profiles: [
          { id: 'x', name: 'x', order: 0, env: { K: '1' } },
          { id: 'y', name: 'y', order: 1, env: { K: '2' } },
          { id: 'z', name: 'z', order: 2, env: { K: '3' } }
        ],
        ...extra
      }))

    it('新键悬空/非字符串一律按无启用丢弃，不落回盘上', () => {
      seedProfiles({ activeProfileId: 'deleted-id' })
      expect(newRepo().getActiveProfileId()).toBeNull()
      seedProfiles({ activeProfileId: 42 })
      expect(newRepo().getActiveProfileId()).toBeNull()
    })

    it('新键缺席时回落 legacy per-kind 指针：按 dsh → codex → claude 顺序取首个有效', () => {
      // dsh 与 codex 都有指针 → 取 dsh 的（多根指针不一致只保留一根）
      seedProfiles({ activeByKind: { dsh: 'x', codex: 'y' } })
      expect(newRepo().getActiveProfileId()).toBe('x')
      // dsh 缺席 → 取 codex 的
      seedProfiles({ activeByKind: { codex: 'y', claude: 'z' } })
      expect(newRepo().getActiveProfileId()).toBe('y')
    })

    it('legacy 指针逐根校验：悬空/非字符串/未知 kind 跳过，取首个有效的', () => {
      seed(JSON.stringify({
        profiles: [{ id: 'x', name: 'x', order: 0, env: { K: '1' } }],
        activeByKind: { dsh: 42, codex: 'deleted-id', unknown: 'x', claude: 'x' }
      }))
      expect(newRepo().getActiveProfileId()).toBe('x')
    })

    it('新键与 legacy 并存时新键优先', () => {
      seedProfiles({ activeProfileId: 'z', activeByKind: { dsh: 'x' } })
      expect(newRepo().getActiveProfileId()).toBe('z')
    })

    it('legacy 全悬空/全无效 → 无启用', () => {
      seedProfiles({ activeByKind: { dsh: 'nope', codex: 'nada' } })
      expect(newRepo().getActiveProfileId()).toBeNull()
    })

    it('指针指向被 MAX_PROFILES 截断的组 → 按悬空丢弃（校验对截断后的组集）', () => {
      const profiles = Array.from({ length: 260 }, (_, i) => ({ id: `p-${i}`, name: `p${i}`, order: i, env: { K: String(i) } }))
      // order 258 排在截断线（前 256）之外
      seed(JSON.stringify({ profiles, activeProfileId: 'p-258' }))
      const repo = newRepo()
      expect(repo.getAll().length).toBe(256)
      expect(repo.getActiveProfileId()).toBeNull()
      // 指向截断线内的组则有效
      seed(JSON.stringify({ profiles, activeProfileId: 'p-3' }))
      expect(newRepo().getActiveProfileId()).toBe('p-3')
    })

    it('mutation 后以新格式落盘（legacy 键不再写回）', () => {
      seedProfiles({ activeByKind: { codex: 'y' } })
      const repo = newRepo()
      expect(repo.setActiveProfile('x')).toBe(true)
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(onDisk.activeProfileId).toBe('x')
      expect(onDisk.activeByKind).toBeUndefined()
    })
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
    repo.setActiveProfile(b.id)
    expect(repo.delete(b.id)).toBe(true)
    expect(repo.getAll().map((p) => p.order)).toEqual([0, 1])
    // 全局指针指向被删组 → 清空（等价停用，回落系统环境变量）
    expect(repo.getActiveProfileId()).toBeNull()
    expect(repo.delete('nope')).toBe(false)
  })

  it('add / setActiveProfile 后持久化，新实例可读到', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: 'v' } })!
    repo.setActiveProfile(a.id)
    const repo2 = newRepo()
    expect(repo2.getAll().map((p) => p.name)).toEqual(['a'])
    expect(repo2.getActiveProfile()?.name).toBe('a')
  })

  describe('importProfiles（迁移并入）', () => {
    it('保留 id 并入、接在现有 order 之后，指针只补空位', () => {
      const repo = newRepo()
      const kept = repo.add({ name: 'kept', env: { K: 'kept' } })!
      const imported = [
        { id: 'old-1', name: 'o1', order: 0, env: { K: '1' } },
        { id: 'old-2', name: 'o2', order: 1, env: { K: '2' } }
      ]
      expect(repo.importProfiles(imported, 'old-1')).toBe(2)
      const all = repo.getAll()
      expect(all.map((p) => p.id)).toEqual([kept.id, 'old-1', 'old-2'])
      expect(all.map((p) => p.order)).toEqual([0, 1, 2])
      expect(repo.getActiveProfile()?.id).toBe('old-1')
    })

    it('幂等：重复 import 同 id 不再并入，已有指针不被覆盖', () => {
      const repo = newRepo()
      const mine = repo.add({ name: 'mine', env: { K: 'm' } })!
      repo.setActiveProfile(mine.id)
      const imported = [{ id: 'old-1', name: 'o1', order: 0, env: { K: '1' } }]
      expect(repo.importProfiles(imported, 'old-1')).toBe(1)
      // 第二轮：old-1 已在库中（跳过），全局指针已占用（不覆盖）
      expect(repo.importProfiles(imported, 'old-1')).toBe(0)
      expect(repo.getAll().length).toBe(2)
      expect(repo.getActiveProfile()?.id).toBe(mine.id)
    })

    it('import 的指针指向不存在的组时不落盘（悬空不写）', () => {
      const repo = newRepo()
      repo.importProfiles([{ id: 'old-1', name: 'o1', order: 0, env: { K: '1' } }], 'nope')
      expect(repo.getActiveProfileId()).toBeNull()
    })

    it('并入结果持久化，新实例可读到', () => {
      const repo = newRepo()
      repo.importProfiles([{ id: 'old-1', name: 'o1', order: 0, env: { K: '1' } }], 'old-1')
      const repo2 = newRepo()
      expect(repo2.get('old-1')?.name).toBe('o1')
      expect(repo2.getActiveProfile()?.id).toBe('old-1')
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

  describe('落盘失败回滚（原子写）', () => {
    // 用目录占住文件路径让 rename 必败（.tmp 写得进、盖不过目录）→ 验证回滚与 .tmp 清理
    it('add 落盘失败返回 null、回滚内存、不留 .tmp', () => {
      mkdirSync(filePath, { recursive: true })
      const repo = newRepo()
      expect(repo.add({ name: 'a', env: { K: '1' } })).toBeNull()
      expect(repo.getAll().length).toBe(0)
      expect(existsSync(`${filePath}.tmp`)).toBe(false)
    })

    it('update 落盘失败返回 false、回滚内存、不留 .tmp', () => {
      const repo = newRepo()
      const a = repo.add({ name: 'a', env: { K: '1' } })!
      // 换坑：删掉库文件、用目录占住路径 → 下一次 rename 必败
      rmSync(filePath, { force: true })
      mkdirSync(filePath, { recursive: true })
      expect(repo.update({ ...a, name: 'a2' })).toBe(false)
      expect(repo.get(a.id)?.name).toBe('a')
      expect(existsSync(`${filePath}.tmp`)).toBe(false)
    })
  })
})
