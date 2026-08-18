import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

// electron-log / electron.app.getPath 在 Node 测试环境不存在，mock 掉（对齐 engine.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import { HarnessWorkspaceRepository } from './harness-workspace-repository'

const configDir = join(tmpdir(), 'config')
const filePath = join(configDir, 'codex-workspaces.json')

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

function newRepo(): HarnessWorkspaceRepository {
  return new HarnessWorkspaceRepository('codex-workspaces.json')
}

describe('HarnessWorkspaceRepository', () => {
  it('无文件时返回空列表', () => {
    const repo = newRepo()
    expect(repo.getAll()).toEqual([])
  })

  it('损坏 JSON 时降级为空列表（恢复而非崩溃）', () => {
    seed('{ not valid json')
    const repo = newRepo()
    expect(repo.getAll()).toEqual([])
  })

  it('非数组 JSON 时降级为空列表', () => {
    seed('{"a": 1}')
    const repo = newRepo()
    expect(repo.getAll()).toEqual([])
  })

  it('过滤非法记录，保留合法记录', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'ok', cwd: '/x', order: 0 },
      { id: 'b', name: 123, cwd: '/y', order: 1 },
      'garbage',
      { id: 'c', cwd: '/z', order: 2 },
      { id: 'd', name: 'ok2', cwd: '/w', order: 'x' }
    ]))
    const repo = newRepo()
    expect(repo.getAll().map((w) => w.id)).toEqual(['a'])
  })

  it('加载时按 order 稳定排序并 reindex 为 0..n-1', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', cwd: '/a', order: 5 },
      { id: 'b', name: 'b', cwd: '/b', order: 2 },
      { id: 'c', name: 'c', cwd: '/c', order: 2 }
    ]))
    const repo = newRepo()
    const all = repo.getAll()
    expect(all.map((w) => w.id)).toEqual(['b', 'c', 'a'])
    expect(all.map((w) => w.order)).toEqual([0, 1, 2])
  })

  it('note 非字符串按缺失处理，字符串保留', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', cwd: '/a', order: 0, note: '备注' },
      { id: 'b', name: 'b', cwd: '/b', order: 1, note: 42 }
    ]))
    const repo = newRepo()
    const all = repo.getAll()
    expect(all[0].note).toBe('备注')
    expect(all[1].note).toBeUndefined()
  })

  it('delete 后 reindex，add 分配连续 order', () => {
    const repo = newRepo()
    repo.add({ name: 'a', cwd: '/a' })
    repo.add({ name: 'b', cwd: '/b' })
    repo.add({ name: 'c', cwd: '/c' })
    const b = repo.getAll().find((w) => w.name === 'b')!
    repo.delete(b.id)
    // 删除中间项后 reindex 为 0..n-1，不留空洞
    expect(repo.getAll().map((w) => w.order)).toEqual([0, 1])
    const d = repo.add({ name: 'd', cwd: '/d' })
    expect(d?.order).toBe(2)
    expect(repo.getAll().map((w) => w.order)).toEqual([0, 1, 2])
  })

  it('重复 id 按首个有效记录去重', () => {
    seed(JSON.stringify([
      { id: 'dup', name: 'first', cwd: '/a', order: 0 },
      { id: 'dup', name: 'second', cwd: '/b', order: 1 },
      { id: 'other', name: 'other', cwd: '/c', order: 2 }
    ]))
    const repo = newRepo()
    expect(repo.getAll().map((w) => w.name)).toEqual(['first', 'other'])
  })

  it('update 不存在的 id 返回 false，存在的 id 返回 true', () => {
    const repo = newRepo()
    expect(repo.update({ id: 'nope', name: 'x', cwd: '/x', order: 0 })).toBe(false)
    const a = repo.add({ name: 'a', cwd: '/a' })!
    expect(repo.update({ ...a, name: 'a2' })).toBe(true)
    expect(repo.get(a.id)?.name).toBe('a2')
  })

  it('add 后持久化，新实例可读到', () => {
    const repo = newRepo()
    repo.add({ name: 'a', cwd: '/a' })
    const repo2 = newRepo()
    expect(repo2.getAll().map((w) => w.name)).toEqual(['a'])
  })

  it('pinned 非布尔按 false，布尔保留', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', cwd: '/a', order: 0, pinned: true },
      { id: 'b', name: 'b', cwd: '/b', order: 1, pinned: 'yes' }
    ]))
    const repo = newRepo()
    const all = repo.getAll()
    expect(all.find((w) => w.id === 'a')?.pinned).toBe(true)
    expect(all.find((w) => w.id === 'b')?.pinned).toBe(false)
  })

  it('add 默认 pinned=false，显式传 true 保留', () => {
    const repo = newRepo()
    const a = repo.add({ name: 'a', cwd: '/a' })!
    const b = repo.add({ name: 'b', cwd: '/b', pinned: true })!
    expect(a.pinned).toBe(false)
    expect(b.pinned).toBe(true)
  })

  it('setPinned 切换置顶，getAll 置顶优先', () => {
    const repo = newRepo()
    repo.add({ name: 'a', cwd: '/a' })
    repo.add({ name: 'b', cwd: '/b' })
    repo.add({ name: 'c', cwd: '/c' })
    const b = repo.getAll().find((w) => w.name === 'b')!
    // 初始均未置顶，按 order 排
    expect(repo.getAll().map((w) => w.name)).toEqual(['a', 'b', 'c'])
    expect(repo.setPinned(b.id, true)).toBe(true)
    // b 置顶后提到最前
    expect(repo.getAll().map((w) => w.name)).toEqual(['b', 'a', 'c'])
    // 取消置顶恢复原序
    expect(repo.setPinned(b.id, false)).toBe(true)
    expect(repo.getAll().map((w) => w.name)).toEqual(['a', 'b', 'c'])
  })

  it('setPinned 不存在的 id 返回 false', () => {
    const repo = newRepo()
    expect(repo.setPinned('nope', true)).toBe(false)
  })

  it('env 过滤非字符串值，空/非对象记录按缺失处理', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', cwd: '/a', order: 0, env: { K1: 'v1', K2: 42, K3: 'v3' } },
      { id: 'b', name: 'b', cwd: '/b', order: 1, env: {} },
      { id: 'c', name: 'c', cwd: '/c', order: 2, env: 'not-an-object' }
    ]))
    const repo = newRepo()
    const all = repo.getAll()
    expect(all.find((w) => w.id === 'a')?.env).toEqual({ K1: 'v1', K3: 'v3' })
    expect(all.find((w) => w.id === 'b')?.env).toBeUndefined()
    expect(all.find((w) => w.id === 'c')?.env).toBeUndefined()
  })

  it('env 丢弃空 key / 含 NUL 的 key / 含 NUL 的 value', () => {
    const NUL = String.fromCharCode(0)
    seed(JSON.stringify([
      { id: 'a', name: 'a', cwd: '/a', order: 0, env: { '': 'empty-key', ['A' + NUL + 'B']: 'nul-key', K1: 'v1', K2: 'va' + NUL + 'lue', K3: 42 } }
    ]))
    const repo = newRepo()
    const env = repo.getAll().find((w) => w.id === 'a')?.env
    expect(env).toEqual({ K1: 'v1' })
  })

  it('model 非字符串/空串按缺失处理，字符串保留', () => {
    seed(JSON.stringify([
      { id: 'a', name: 'a', cwd: '/a', order: 0, model: 'gpt-5-codex' },
      { id: 'b', name: 'b', cwd: '/b', order: 1, model: '' },
      { id: 'c', name: 'c', cwd: '/c', order: 2, model: 42 },
      { id: 'd', name: 'd', cwd: '/d', order: 3 }
    ]))
    const repo = newRepo()
    const all = repo.getAll()
    expect(all.find((w) => w.id === 'a')?.model).toBe('gpt-5-codex')
    expect(all.find((w) => w.id === 'b')?.model).toBeUndefined()
    expect(all.find((w) => w.id === 'c')?.model).toBeUndefined()
    expect(all.find((w) => w.id === 'd')?.model).toBeUndefined()
  })
})
