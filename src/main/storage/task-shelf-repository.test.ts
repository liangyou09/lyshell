import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('分类命令原子批次', () => {
  /** 造一条已归档记录：capture → revision 1，archive → revision 2。 */
  function archived(repository: TaskShelfRepository, key: string, archivedAt = 2000): ReturnType<TaskShelfRepository['capture']>['entry'] {
    const { entry } = repository.capture(captureInput({ resourceKey: `terminal:${key}`, title: key, recovery: { kind: 'terminal', sessionId: key, type: ConnectionType.LOCAL }, capability: 'directory' }), 1000)
    return repository.archive(entry.id, true, archivedAt)
  }

  it('按请求顺序移动，保留原 Tasks 相对顺序，只改分类/revision/updatedAt', () => {
    const repository = new TaskShelfRepository(file)
    const first = archived(repository, 'a')
    const second = archived(repository, 'b')
    const tasks = repository.capture(captureInput({ resourceKey: 'terminal:c', title: 'c', recovery: { kind: 'terminal', sessionId: 'c', type: ConnectionType.LOCAL }, capability: 'directory' }), 1500).entry

    const result = repository.archiveBatch([{ id: second.id, expectedRevision: second.revision }, { id: first.id, expectedRevision: first.revision }], 3000)
    expect(result.committed).toBe(true)
    expect(result.items).toEqual([
      { id: second.id, status: 'moved' },
      { id: first.id, status: 'moved' }
    ])
    // 原有 Tasks 保持相对顺序，本批成功项按请求顺序追加
    expect(repository.list().map(entry => entry.id)).toEqual([tasks.id, second.id, first.id])
    const movedFirst = repository.get(first.id)!
    expect(movedFirst.archivedAt).toBeUndefined()
    expect(movedFirst.revision).toBe(first.revision + 1)
    expect(movedFirst.updatedAt).toBe(3000)
    expect(movedFirst.title).toBe(first.title)
    expect(movedFirst.recovery).toEqual(first.recovery)
  })

  it('alreadyTasks / conflict / missing 单项计数，且不写盘', () => {
    const repository = new TaskShelfRepository(file)
    const first = archived(repository, 'a')
    const tasks = repository.capture(captureInput({ resourceKey: 'terminal:c', title: 'c', recovery: { kind: 'terminal', sessionId: 'c', type: ConnectionType.LOCAL }, capability: 'directory' }), 1500).entry
    const writes = disk.writes
    const result = repository.archiveBatch([
      { id: tasks.id, expectedRevision: tasks.revision },
      { id: first.id, expectedRevision: 99 },
      { id: 'missing', expectedRevision: 1 },
      { id: first.id, expectedRevision: first.revision },
      { id: first.id, expectedRevision: first.revision }
    ], 3000)
    expect(result.committed).toBe(true)
    expect(result.items.map(item => item.status)).toEqual(['alreadyTasks', 'conflict', 'missing', 'moved', 'conflict'])
    expect(repository.get(first.id)?.archivedAt).toBeUndefined()
    expect(disk.writes).toBe(writes + 1)
  })

  it('同一 id 重复出现只持久化一次：重新从磁盘加载也读不到重复记录', () => {
    const repository = new TaskShelfRepository(file)
    const first = archived(repository, 'a')
    const result = repository.archiveBatch([
      { id: first.id, expectedRevision: first.revision },
      { id: first.id, expectedRevision: first.revision },
      { id: first.id, expectedRevision: first.revision }
    ], 3000)
    // 只有第一次真正移动，重复项按冲突计数，但绝不能重复落盘
    expect(result.items.map(item => item.status)).toEqual(['moved', 'conflict', 'conflict'])
    expect(repository.list().map(entry => entry.id)).toEqual([first.id])
    expect(repository.get(first.id)?.archivedAt).toBeUndefined()
    // 真正重新读取：文件里若出现重复 id，ensureLoaded 会直接判定归档损坏
    const reloaded = new TaskShelfRepository(file)
    expect(reloaded.list().map(entry => entry.id)).toEqual([first.id])
    expect(reloaded.get(first.id)?.archivedAt).toBeUndefined()
    expect(reloaded.get(first.id)?.revision).toBe(first.revision + 1)
  })

  it('全部分类无变化时不提交（alreadyTasks/missing/conflict 不写盘）', () => {
    const repository = new TaskShelfRepository(file)
    const tasks = repository.capture(captureInput({ resourceKey: 'terminal:c', title: 'c', recovery: { kind: 'terminal', sessionId: 'c', type: ConnectionType.LOCAL }, capability: 'directory' }), 1500).entry
    const writes = disk.writes
    const result = repository.archiveBatch([{ id: tasks.id, expectedRevision: tasks.revision }, { id: 'missing', expectedRevision: 1 }], 3000)
    expect(result).toMatchObject({ committed: false })
    expect(disk.writes).toBe(writes)
  })

  it('单次原子写入失败：全部待改项 failed，内存与文件保持原分类', () => {
    const repository = new TaskShelfRepository(file)
    const first = archived(repository, 'a')
    const second = archived(repository, 'b')
    const before = readFileSync(file, 'utf8')

    disk.failWrite = true
    const result = repository.archiveBatch([{ id: first.id, expectedRevision: first.revision }, { id: second.id, expectedRevision: second.revision }], 3000)
    disk.failWrite = false

    expect(result.committed).toBe(false)
    expect(result.error).toMatch(/保存区写入失败/)
    expect(result.items.map(item => item.status)).toEqual(['failed', 'failed'])
    expect(repository.get(first.id)).toMatchObject({ archivedAt: 2000, revision: first.revision })
    expect(repository.get(second.id)).toMatchObject({ archivedAt: 2000, revision: second.revision })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('启动归档原子批次', () => {
  function task(repository: TaskShelfRepository, key: string, now = 1000): ReturnType<TaskShelfRepository['capture']>['entry'] {
    return repository.capture(captureInput({ resourceKey: `terminal:${key}`, title: key, recovery: { kind: 'terminal', sessionId: key, type: ConnectionType.LOCAL }, capability: 'directory' }), now).entry
  }

  it('快照内记录按原顺序进入 Archive，已归档项记 alreadyArchived，冲突/缺失单项计数', () => {
    const repository = new TaskShelfRepository(file)
    const first = task(repository, 'a')
    const second = task(repository, 'b')
    const already = repository.archive(task(repository, 'c').id, true, 1500)
    const writes = disk.writes

    const result = repository.archiveSnapshot([
      { id: first.id, expectedRevision: first.revision },
      { id: already.id, expectedRevision: already.revision },
      { id: second.id, expectedRevision: 99 },
      { id: 'missing', expectedRevision: 1 }
    ], 4000)

    expect(result.items.map(item => item.status)).toEqual(['moved', 'alreadyArchived', 'conflict', 'missing'])
    expect(result.committed).toBe(true)
    expect(repository.list().map(entry => entry.id)).toEqual([first.id, second.id, already.id])
    expect(repository.get(first.id)).toMatchObject({ archivedAt: 4000, revision: first.revision + 1, updatedAt: 4000 })
    expect(repository.get(already.id)).toMatchObject({ archivedAt: 1500, revision: already.revision })
    expect(disk.writes).toBe(writes + 1)
  })

  it('全部已归档时不写盘；写入失败时全部待改项 failed 且原分类保留', () => {
    const repository = new TaskShelfRepository(file)
    const archived = repository.archive(task(repository, 'a').id, true, 1500)
    const writes = disk.writes
    expect(repository.archiveSnapshot([{ id: archived.id, expectedRevision: archived.revision }], 4000)).toMatchObject({ committed: false })
    expect(disk.writes).toBe(writes)

    const pending = task(repository, 'b', 1200)
    const before = readFileSync(file, 'utf8')
    disk.failWrite = true
    const failed = repository.archiveSnapshot([
      { id: pending.id, expectedRevision: pending.revision },
      { id: archived.id, expectedRevision: archived.revision }
    ], 4000)
    disk.failWrite = false
    expect(failed.items.map(item => item.status)).toEqual(['failed', 'alreadyArchived'])
    expect(repository.get(pending.id)).toMatchObject({ revision: pending.revision })
    expect(repository.get(pending.id)?.archivedAt).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('100 条快照全部归档，顺序不变', () => {
    const repository = new TaskShelfRepository(file)
    const entries = Array.from({ length: 100 }, (_, index) => task(repository, `t${index}`, 1000 + index))
    const result = repository.archiveSnapshot(entries.map(entry => ({ id: entry.id, expectedRevision: entry.revision })), 5000)
    expect(result.items.every(item => item.status === 'moved')).toBe(true)
    expect(repository.list().map(entry => entry.id)).toEqual(entries.map(entry => entry.id))
    expect(repository.list().every(entry => entry.archivedAt === 5000)).toBe(true)
  })
})

describe('diskDigest', () => {
  it('只有文件确实不存在（ENOENT）才返回 undefined', () => {
    const repository = new TaskShelfRepository(file)
    expect(repository.diskDigest()).toBeUndefined()
  })

  it('内容不变摘要稳定，内容变化摘要随之变化', () => {
    const repository = new TaskShelfRepository(file)
    repository.capture(captureInput(), 1000)
    const before = repository.diskDigest()
    expect(typeof before).toBe('string')
    expect(repository.diskDigest()).toBe(before)

    const archive = readArchive() as { version: number; entries: Array<Record<string, unknown>> }
    archive.entries[0].title = '外部改名'
    writeFileSync(file, JSON.stringify(archive), 'utf8')
    expect(repository.diskDigest()).not.toBe(before)
  })

  it('文件存在但读不出来时抛错，不能当作「文件不存在」', () => {
    // 归档路径被目录占住：existsSync 仍为真，readFileSync 抛 EISDIR（非 ENOENT）
    mkdirSync(file)
    const repository = new TaskShelfRepository(file)
    expect(() => repository.diskDigest()).toThrow(/读取任务保存区失败/)
  })
})
