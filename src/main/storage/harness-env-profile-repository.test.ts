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

import { HarnessEnvProfileRepository } from './harness-env-profile-repository'

const configDir = join(tmpdir(), 'config')
const filePath = join(configDir, 'codex-env-profiles.json')

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

function newRepo(): HarnessEnvProfileRepository {
  return new HarnessEnvProfileRepository('codex-env-profiles.json')
}

describe('HarnessEnvProfileRepository', () => {
  it('无文件时返回空列表', () => {
    expect(newRepo().getAll()).toEqual([])
  })

  it('损坏 JSON / 非数组 JSON 时降级为空列表（恢复而非崩溃）', () => {
    seed('{ not valid json')
    expect(newRepo().getAll()).toEqual([])
    seed('{"a": 1}')
    expect(newRepo().getAll()).toEqual([])
  })

  it('过滤非法记录：缺 name/order、env 为空或非对象一律丢弃', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'ok', order: 0, env: { K: 'v' } },
      { id: 'b', order: 1, env: { K: 'v' } },
      { id: 'c', name: 'no-order', env: { K: 'v' } },
      // 零变量的组没有意义，按非法处理
      { id: 'd', name: 'empty-env', order: 3, env: {} },
      { id: 'e', name: 'bad-env', order: 4, env: 'not-an-object' },
      'garbage'
    ]))
    expect(newRepo().getAll().map((p) => p.id)).toEqual(['a'])
  })

  it('env 脏数据过滤：丢空 key / 含 NUL 的 key / 含 NUL 的 value / 非字符串值', () => {
    const NUL = String.fromCharCode(0)
    seed(JSON.stringify([
      { id: 'a', name: 'a', order: 0, env: { '': 'x', ['A' + NUL + 'B']: 'y', K1: 'v1', K2: 'va' + NUL + 'lue', K3: 42 } }
    ]))
    expect(newRepo().get('a')?.env).toEqual({ K1: 'v1' })
  })

  it('加载时按 order 稳定排序并 reindex 为 0..n-1', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', order: 5, env: { K: '1' } },
      { id: 'b', name: 'b', order: 2, env: { K: '2' } },
      { id: 'c', name: 'c', order: 2, env: { K: '3' } }
    ]))
    const all = newRepo().getAll()
    expect(all.map((p) => p.id)).toEqual(['b', 'c', 'a'])
    expect(all.map((p) => p.order)).toEqual([0, 1, 2])
  })

  it('重复 id 按首个有效记录去重', () => {
    seed(JSON.stringify([
      { id: 'dup', name: 'first', order: 0, env: { K: '1' } },
      { id: 'dup', name: 'second', order: 1, env: { K: '2' } },
      { id: 'other', name: 'other', order: 2, env: { K: '3' } }
    ]))
    expect(newRepo().getAll().map((p) => p.name)).toEqual(['first', 'other'])
  })

  it('add 分配连续 order，且新建一律不启用', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    expect([a.order, b.order]).toEqual([0, 1])
    expect(a.active).toBe(false)
    expect(b.active).toBe(false)
    expect(repo.getActive()).toBeUndefined()
  })

  it('setActive 单选：启用一条即清掉其余', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    expect(repo.setActive(a.id)).toBe(true)
    expect(repo.getActive()?.id).toBe(a.id)
    expect(repo.setActive(b.id)).toBe(true)
    expect(repo.getActive()?.id).toBe(b.id)
    // 恒有且仅有一格通电
    expect(repo.getAll().filter((p) => p.active).length).toBe(1)
  })

  it('setActive(null) 全部停用 —— 回落系统环境变量', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActive(a.id)
    expect(repo.setActive(null)).toBe(true)
    expect(repo.getActive()).toBeUndefined()
    expect(repo.getAll().every((p) => p.active === false)).toBe(true)
  })

  it('setActive 不存在的 id 返回 false 且不改动现状', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActive(a.id)
    expect(repo.setActive('nope')).toBe(false)
    expect(repo.getActive()?.id).toBe(a.id)
  })

  it('手工编辑出多条 active 时，load 后按 order 只认首条', () => {
    // 单选不变量必须在 load 侧兜住：否则解析结果取决于数组顺序，同一份文件两次启动可能不同
    seed(JSON.stringify([
      { id: 'b', name: 'b', order: 2, env: { K: '2' }, active: true },
      { id: 'a', name: 'a', order: 1, env: { K: '1' }, active: true },
      { id: 'c', name: 'c', order: 3, env: { K: '3' }, active: true }
    ]))
    const repo = newRepo()
    expect(repo.getAll().filter((p) => p.active).length).toBe(1)
    // order 最小的 a 排在最前，故它是那条被认下的
    expect(repo.getActive()?.id).toBe('a')
  })

  it('update 不改动启用态（启用只经 setActive）', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: '1' } })!
    repo.setActive(a.id)
    // 传一份 active:false 的记录进来，仓库应保留现状
    expect(repo.update({ ...a, name: 'a2', active: false })).toBe(true)
    expect(repo.get(a.id)?.name).toBe('a2')
    expect(repo.getActive()?.id).toBe(a.id)
  })

  it('update 不存在的 id 返回 false', () => {
    const repo = newRepo()
    expect(repo.update({ id: 'nope', name: 'x', order: 0, env: { K: '1' } })).toBe(false)
  })

  it('delete 后 reindex，不留 order 空洞', () => {
    const repo = newRepo()
    repo.add({ name: 'a', env: { K: '1' } })
    const b = repo.add({ name: 'b', env: { K: '2' } })!
    repo.add({ name: 'c', env: { K: '3' } })
    expect(repo.delete(b.id)).toBe(true)
    expect(repo.getAll().map((p) => p.order)).toEqual([0, 1])
    expect(repo.delete('nope')).toBe(false)
  })

  it('add / setActive 后持久化，新实例可读到', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', env: { K: 'v' } })!
    repo.setActive(a.id)
    const repo2 = newRepo()
    expect(repo2.getAll().map((p) => p.name)).toEqual(['a'])
    expect(repo2.getActive()?.name).toBe('a')
  })

  it('models 脏数据过滤：非字符串/空串丢弃、trim、去重；全空则不写键', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', order: 0, env: { K: '1' }, models: [' GLM-5.2 ', 'GLM-5.2', '', 42, null, 'gpt-5-codex'] },
      { id: 'b', name: 'b', order: 1, env: { K: '2' }, models: 'not-an-array' },
      { id: 'c', name: 'c', order: 2, env: { K: '3' }, models: ['', '   '] }
    ]))
    const all = newRepo().getAll()
    expect(all[0].models).toEqual(['GLM-5.2', 'gpt-5-codex'])
    expect(all[1].models).toBeUndefined() // 非数组按缺失处理
    expect(all[2].models).toBeUndefined() // 归一化后为空不写键
  })

  it('models 超上限截断到 64（兜手工编辑的病态文件）', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', order: 0, env: { K: '1' }, models: Array.from({ length: 100 }, (_, i) => `m-${i}`) }
    ]))
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
