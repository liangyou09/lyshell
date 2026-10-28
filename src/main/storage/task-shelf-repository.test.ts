import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionType } from '@shared/types/session'
import { TASK_SHELF_LIMIT, TaskShelfRepository, type ShelfCaptureInput } from './task-shelf-repository'

/** 写盘行为可控：用一次失败验证「回滚内存 + 保留上次有效文件」。 */
const disk = vi.hoisted(() => ({ failWrite: false, writes: 0 }))

vi.mock('./repository', async () => {
  const fs = await import('node:fs')
  return {
    getConfigDir: () => '.',
    atomicWriteFileSync: (filePath: string, data: string): void => {
      if (disk.failWrite) throw new Error('disk full')
      disk.writes += 1
      fs.writeFileSync(`${filePath}.tmp`, data, 'utf8')
      fs.renameSync(`${filePath}.tmp`, filePath)
    }
  }
})

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyshell-shelf-'))
  file = join(dir, 'task-shelf.json')
  disk.failWrite = false
  disk.writes = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function captureInput(overrides: Partial<ShelfCaptureInput> = {}): ShelfCaptureInput {
  return {
    resourceKey: 'terminal:t1',
    title: '终端 1',
    workspace: 'C:/work/demo',
    recovery: { kind: 'terminal', sessionId: 't1', type: ConnectionType.SSH, sessionConfigId: 'saved-1' },
    capability: 'reconnect',
    ...overrides
  }
}

function readArchive(): { version: number; entries: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(file, 'utf8')) as { version: number; entries: Record<string, unknown>[] }
}

describe('归档与偏好持久化', () => {
  it('SSH 目录末尾的空格跨重启原样保留，不切换到另一个目录', () => {
    const repository = new TaskShelfRepository(file)
    const cwd = '/srv/task directory '
    const saved = repository.capture(captureInput({ recovery: { kind: 'terminal', sessionId: 't1', type: ConnectionType.SSH, cwd } }), 1000).entry
    expect(new TaskShelfRepository(file).get(saved.id)?.recovery).toMatchObject({ cwd })
  })
  it('SSH 本地输出上下文跨仓储重建保留，归档与重命名不删除内容', () => {
    const repository = new TaskShelfRepository(file)
    const saved = repository.capture(captureInput({ context: { text: 'previous output\n/home/work', capturedAt: 1000 } }), 1000).entry
    repository.archive(saved.id, true, 1100)
    repository.rename(saved.id, 'SSH context', 1200)
    const restored = new TaskShelfRepository(file).get(saved.id)!
    expect(restored.context).toEqual(saved.context)
    expect(restored.archivedAt).toBe(1100)
    expect(restored.title).toBe('SSH context')
  })
  it('损坏清单不能部分提交快捷键，修复后重新完整读取', () => {
    const repository = new TaskShelfRepository(file)
    writeFileSync(file, JSON.stringify({ version: 1, preferences: { toggleShortcut: 'Ctrl+Shift+K', collectShortcut: '' }, entries: [{}] }))
    expect(() => repository.list()).toThrow(/damaged/)
    writeFileSync(file, JSON.stringify({ version: 1, entries: [] }))
    expect(repository.getPreferences()).toEqual({ toggleShortcut: 'Ctrl+Shift+J', collectShortcut: 'Ctrl+Shift+S' })
  })
  it('归档不删除恢复引用，动态捕获保留归档标记，重新实例化可移回', () => {
    const repository = new TaskShelfRepository(file)
    const saved = repository.capture(captureInput(), 10).entry
    const archived = repository.archive(saved.id, true, 20)
    expect(archived.archivedAt).toBe(20)
    repository.capture(captureInput({ title: '更新后的任务' }), 30)
    const reopened = new TaskShelfRepository(file)
    expect(reopened.get(saved.id)).toMatchObject({ archivedAt: 20, title: '更新后的任务', recovery: saved.recovery })
    expect(reopened.archive(saved.id, false, 40).archivedAt).toBeUndefined()
  })
  it('设置写入失败回滚偏好，恢复文件后仍使用有效配置', () => {
    const repository = new TaskShelfRepository(file)
    repository.setPreferences({ toggleShortcut: 'Ctrl+Shift+U', collectShortcut: 'Ctrl+Shift+I' })
    disk.failWrite = true
    expect(() => repository.setPreferences({ toggleShortcut: '', collectShortcut: '' })).toThrow()
    expect(repository.getPreferences().toggleShortcut).toBe('Ctrl+Shift+U')
    expect(new TaskShelfRepository(file).getPreferences().collectShortcut).toBe('Ctrl+Shift+I')
  })
})

describe('TaskShelfRepository', () => {
  it('首次收纳写出 version 1 归档并可从新实例读回', () => {
    const repository = new TaskShelfRepository(file)
    const result = repository.capture(captureInput(), 1000)

    expect(result.created).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.entry.revision).toBe(1)
    expect(result.entry.createdAt).toBe(1000)
    expect(result.entry.updatedAt).toBe(1000)
    expect(readArchive()).toMatchObject({ version: 1 })
    expect(readArchive().entries).toHaveLength(1)

    const reloaded = new TaskShelfRepository(file).list()
    expect(reloaded).toEqual([result.entry])
  })

  it('重复收纳同一份有效内容不改 revision/updatedAt，也不写盘', () => {
    const repository = new TaskShelfRepository(file)
    repository.capture(captureInput(), 1000)
    const writes = disk.writes

    const again = repository.capture(captureInput(), 5000)
    expect(again.created).toBe(false)
    expect(again.changed).toBe(false)
    expect(again.entry.revision).toBe(1)
    expect(again.entry.updatedAt).toBe(1000)
    expect(disk.writes).toBe(writes)
  })

  it('内容变化时 revision 单调递增且 updatedAt 前进', () => {
    const repository = new TaskShelfRepository(file)
    repository.capture(captureInput(), 1000)
    // now 传得更早也不允许 updatedAt 倒退。
    const renamed = repository.capture(captureInput({ title: '终端 1（改）' }), 900)

    expect(renamed.entry.revision).toBe(2)
    expect(renamed.entry.updatedAt).toBe(1001)
    expect(renamed.entry.title).toBe('终端 1（改）')
  })

  it('只保留白名单字段：手工塞入 command/env/password/cookie 的旧归档不会复活', () => {
    const legacy = {
      version: 1,
      entries: [
        {
          ...captureInput(),
          id: 'entry-1',
          createdAt: 10,
          updatedAt: 10,
          revision: 3,
          command: 'claude --dangerously-skip-permissions',
          env: { DEEPSEEK_API_KEY: 'sk-secret' },
          password: 'hunter2',
          cookie: 'session=abc',
          recovery: { ...captureInput().recovery, password: 'hunter2', cliSessionId: 'cli-1' }
        }
      ]
    }
    writeFileSync(file, JSON.stringify(legacy), 'utf8')

    const repository = new TaskShelfRepository(file)
    const [entry] = repository.list()
    expect(entry.title).toBe('终端 1')
    expect(entry.recovery).toEqual({
      kind: 'terminal',
      sessionId: 't1',
      sessionConfigId: 'saved-1',
      type: ConnectionType.SSH,
      cliSessionId: 'cli-1'
    })
    for (const forbidden of ['command', 'env', 'password', 'cookie']) {
      expect(entry).not.toHaveProperty(forbidden)
    }

    repository.capture(captureInput({ title: '改名' }), 20)
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('dangerously-skip-permissions')
    expect(readArchive().entries[0]).not.toHaveProperty('env')
  })

  it('版本不对或结构损坏时抛错且保留原文件', () => {
    for (const broken of [
      '{"version":2,"entries":[]}',
      '{"version":1,"entries":{}}',
      '{"version":1,"entries":[{"id":"a"}]}',
      '{"version":1,"entries":[]}',
      '',
      'not json'
    ]) {
      writeFileSync(file, broken, 'utf8')
      const repository = new TaskShelfRepository(file)
      if (broken === '{"version":1,"entries":[]}') {
        expect(repository.list()).toEqual([])
        continue
      }
      expect(() => repository.list()).toThrow(/Unsupported or damaged task shelf archive/)
      expect(readFileSync(file, 'utf8')).toBe(broken)
    }
  })

  it('拒绝重复 id / 重复 resourceKey / 非法恢复记录', () => {
    const entry = {
      ...captureInput(),
      id: 'entry-1',
      createdAt: 10,
      updatedAt: 10,
      revision: 1
    }
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry, entry] }), 'utf8')
    expect(() => new TaskShelfRepository(file).list()).toThrow(/damaged/)

    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: [{ ...entry, recovery: { kind: 'web', url: 'http://localhost:5173/app' } }] }),
      'utf8'
    )
    // 资源键是 terminal 但恢复记录是 web：类型对不上同样视为损坏。
    expect(() => new TaskShelfRepository(file).list()).toThrow(/damaged/)
  })

  it('写盘失败时回滚内存并保留上次有效文件', () => {
    const repository = new TaskShelfRepository(file)
    repository.capture(captureInput(), 1000)
    const before = readFileSync(file, 'utf8')

    disk.failWrite = true
    expect(() => repository.capture(captureInput({ title: '改坏了' }), 2000)).toThrow(/保存区写入失败/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(repository.list()[0].title).toBe('终端 1')

    disk.failWrite = false
    const recovered = repository.capture(captureInput({ title: '改好了' }), 3000)
    expect(recovered.entry.revision).toBe(2)
    expect(recovered.entry.title).toBe('改好了')
  })

  it(`最多 ${TASK_SHELF_LIMIT} 项：满了拒绝新增而不是驱逐旧记录`, () => {
    const repository = new TaskShelfRepository(file)
    for (let index = 0; index < TASK_SHELF_LIMIT; index += 1) {
      repository.capture(captureInput({ resourceKey: `terminal:t${index}`, title: `终端 ${index}`, recovery: { kind: 'terminal', sessionId: `t${index}`, type: ConnectionType.LOCAL, cwd: `C:/work/${index}` }, capability: 'directory' }), 1000 + index)
    }
    expect(repository.list()).toHaveLength(TASK_SHELF_LIMIT)
    expect(() => repository.capture(captureInput({ resourceKey: 'terminal:extra', recovery: { kind: 'terminal', sessionId: 'extra', type: ConnectionType.LOCAL } }), 9999)).toThrow(/保存区已满/)
    expect(repository.list()).toHaveLength(TASK_SHELF_LIMIT)
    // 已存在的记录仍可更新（不算新增）。
    expect(repository.capture(captureInput({ resourceKey: 'terminal:t0', title: '终端 0（改）', recovery: { kind: 'terminal', sessionId: 't0', type: ConnectionType.LOCAL, cwd: 'C:/work/0' }, capability: 'directory' }), 10000).entry.revision).toBe(2)
  })

  it('remove 与 rename 维护单调 revision', () => {
    const repository = new TaskShelfRepository(file)
    const { entry } = repository.capture(captureInput(), 1000)

    expect(repository.rename(entry.id, '  新名字  ', 1100).title).toBe('新名字')
    expect(repository.rename(entry.id, '新名字', 1200).revision).toBe(2)
    expect(() => repository.rename(entry.id, '   ', 1300)).toThrow(/damaged|required/i)
    expect(repository.rename(entry.id, '再改', 1400).revision).toBe(3)

    expect(repository.remove('missing')).toBe(false)
    expect(repository.remove(entry.id)).toBe(true)
    expect(repository.list()).toEqual([])
    expect(() => repository.capture(captureInput({ entryId: entry.id }), 1500)).toThrow('保存记录不存在')
  })

  it('web 恢复记录只接受仍然安全的地址', () => {
    const repository = new TaskShelfRepository(file)
    const safe = repository.capture(
      captureInput({
        resourceKey: 'web:w1',
        title: '文档',
        workspace: undefined,
        recovery: { kind: 'web', url: 'https://example.com/docs/guide' },
        capability: 'web'
      }),
      1000
    )
    expect(safe.entry.recovery).toEqual({ kind: 'web', url: 'https://example.com/docs/guide' })

    const liveOnly = repository.capture(
      captureInput({
        resourceKey: 'web:w2',
        title: '搜索结果',
        workspace: undefined,
        recovery: { kind: 'web' },
        capability: 'live-only'
      }),
      2000
    )
    expect(liveOnly.entry.recovery).toEqual({ kind: 'web' })
    expect(readFileSync(file, 'utf8')).not.toContain('localhost')
  })
})
