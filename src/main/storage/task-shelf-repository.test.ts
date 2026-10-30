import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionType } from '@shared/types/session'
import { TASK_SHELF_TRASH_LIMIT, type TaskShelfEntry } from '@shared/task-shelf'
import { TASK_SHELF_LIMIT, TaskShelfRepository, type ShelfCaptureInput } from './task-shelf-repository'
import { RevisionConflictError } from './atomic-json'

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

describe('未保存终端回收站', () => {
  const terminal = (key: string, overrides: Partial<ShelfCaptureInput> = {}): ShelfCaptureInput => captureInput({
    resourceKey: `terminal:${key}`, title: key,
    recovery: { kind: 'terminal', sessionId: key, type: ConnectionType.LOCAL, cwd: `C:/work/${key}` },
    capability: 'directory', ...overrides
  })
  const seedManual = (count: number): TaskShelfRepository => {
    const entries = Array.from({ length: count }, (_, index) => ({
      ...terminal(`saved-${index}`), id: `saved-${index}`, createdAt: 1000 + index, updatedAt: 1000 + index, revision: 1
    }))
    writeFileSync(file, JSON.stringify({ version: 1, entries }))
    return new TaskShelfRepository(file)
  }

  it('整批一次写入，仅保留最近十二条，旧回收站按顺序淘汰而手动保存原样保留', () => {
    const repository = new TaskShelfRepository(file)
    const manual = repository.capture(terminal('manual'), 1000).entry
    const archived = repository.capture(terminal('archived'), 1000).entry
    repository.archive(archived.id, true, 1100)
    repository.recycle(Array.from({ length: 5 }, (_, index) => terminal(`old-${index}`)), 1200)
    const before = disk.writes
    repository.recycle(Array.from({ length: 10 }, (_, index) => terminal(`new-${index}`)), 1300)
    const entries = repository.list()
    expect(disk.writes).toBe(before + 1)
    expect(entries.filter(entry => entry.trashedAt !== undefined).map(entry => entry.title))
      .toEqual(['old-3', 'old-4', ...Array.from({ length: 10 }, (_, index) => `new-${index}`)])
    expect(repository.get(manual.id)).toEqual(manual)
    expect(repository.get(archived.id)?.archivedAt).toBe(1100)
    expect(repository.get(archived.id)).not.toHaveProperty('trashedAt')
    expect(new TaskShelfRepository(file).list()).toEqual(entries)
    expect(entries.filter(entry => entry.trashedAt !== undefined)).toHaveLength(TASK_SHELF_TRASH_LIMIT)
  })

  it('同批或重复退出不重复收集，已经保存、归档或同宿主的资源不再新增', () => {
    const repository = new TaskShelfRepository(file)
    const host = '01234567-89ab-cdef-0123-456789abcdef'
    const input = terminal('manual', { recovery: { kind: 'terminal', type: ConnectionType.LOCAL, sessionId: 'manual', localHostId: host } })
    const archived = repository.capture(input, 1000).entry
    repository.archive(archived.id, true, 1100)
    const pending = terminal('pending')
    repository.recycle([input, terminal('rebound', { recovery: { kind: 'terminal', type: ConnectionType.LOCAL, sessionId: 'rebound', localHostId: host } }), pending, pending], 1200)
    expect(repository.list().map(entry => entry.title)).toEqual(['manual', 'pending'])
    const before = readFileSync(file, 'utf8'), writes = disk.writes
    repository.recycle([input, pending], 1300)
    expect(disk.writes).toBe(writes)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(repository.get(archived.id)?.archivedAt).toBe(1100)
  })

  it('超过十二个终端的同批退出重试不复活已经淘汰的早期项', () => {
    const repository = new TaskShelfRepository(file)
    const inputs = Array.from({ length: 15 }, (_, index) => terminal(`tab-${index}`))
    repository.recycle(inputs, 1000)
    const before = readFileSync(file, 'utf8'), entries = repository.list(), writes = disk.writes
    expect(entries.map(entry => entry.title)).toEqual(inputs.slice(-12).map(input => input.title))
    repository.recycle(inputs, 1100)
    expect(disk.writes).toBe(writes)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(repository.list()).toEqual(entries)
  })

  it('回收站输入按白名单重建，未知命令、环境和凭据不进入内存或文件', () => {
    const repository = new TaskShelfRepository(file)
    const input = {
      ...terminal('safe'), command: 'unsafe command', env: { PRIVATE_TOKEN: 'not-for-disk' },
      recovery: { ...terminal('safe').recovery, password: 'secret-password', command: 'unsafe command' }
    }
    repository.recycle([input], 1000)
    const entry = repository.list()[0]
    expect(entry).toMatchObject({ trashedAt: 1000, revision: 1, capability: 'directory' })
    expect(entry.recovery).toEqual(terminal('safe').recovery)
    expect(entry).not.toHaveProperty('command')
    expect(entry).not.toHaveProperty('env')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('not-for-disk')
    expect(raw).not.toContain('secret-password')
    expect(raw).not.toContain('unsafe command')
  })

  it('非法或非终端输入使整批拒绝，不留下部分写入', () => {
    const repository = new TaskShelfRepository(file)
    repository.recycle([terminal('old')], 1000)
    const before = readFileSync(file, 'utf8')
    for (const invalid of [
      terminal('web', { resourceKey: 'web:web', recovery: { kind: 'web', url: 'https://example.com/' }, capability: 'web' }),
      terminal('wrong-key', { resourceKey: 'web:wrong-key' }),
      terminal('bad-title', { title: ' ' })
    ]) {
      expect(() => repository.recycle([terminal('new'), invalid], 1100)).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(repository.list().map(entry => entry.title)).toEqual(['old'])
    }
  })

  it('回收站写失败整体回滚，原始十二项及磁盘保留，恢复后可重试', () => {
    const repository = new TaskShelfRepository(file)
    repository.recycle(Array.from({ length: 12 }, (_, index) => terminal(`old-${index}`)), 1000)
    const before = readFileSync(file, 'utf8'), entries = repository.list()
    disk.failWrite = true
    expect(() => repository.recycle([terminal('new')], 1100)).toThrow('disk full')
    expect(repository.list()).toEqual(entries)
    expect(readFileSync(file, 'utf8')).toBe(before)
    disk.failWrite = false
    repository.recycle([terminal('new')], 1200)
    expect(repository.list().map(entry => entry.title)).toEqual([...Array.from({ length: 11 }, (_, index) => `old-${index + 1}`), 'new'])
  })

  it('手动保存的一百项与十二个回收站名额隔离，激活超容量保留回收站', () => {
    const repository = seedManual(TASK_SHELF_LIMIT)
    repository.recycle(Array.from({ length: 12 }, (_, index) => terminal(`trash-${index}`)), 2000)
    expect(repository.list()).toHaveLength(TASK_SHELF_LIMIT + TASK_SHELF_TRASH_LIMIT)
    expect(new TaskShelfRepository(file).list()).toEqual(repository.list())
    expect(() => repository.capture(terminal('extra'), 2100)).toThrow('保存区已满')
    const trash = repository.list().find(entry => entry.trashedAt !== undefined)!
    const before = readFileSync(file, 'utf8')
    expect(repository.archiveBatch([{ id: trash.id, expectedRevision: trash.revision }], 2200))
      .toMatchObject({ committed: false, items: [{ id: trash.id, status: 'failed' }] })
    expect(repository.get(trash.id)).toEqual(trash)
    expect(readFileSync(file, 'utf8')).toBe(before)
    repository.remove(repository.list()[0].id)
    expect(repository.archiveBatch([{ id: trash.id, expectedRevision: trash.revision }], 2300))
      .toMatchObject({ committed: true, items: [{ id: trash.id, status: 'moved' }] })
    expect(repository.get(trash.id)).toMatchObject({ revision: 2, updatedAt: 2300, recovery: trash.recovery })
    expect(repository.get(trash.id)?.trashedAt).toBeUndefined()
  })

  it('有回收站记录时仍可补满手动保存名额，不能用直接capture/archive绕过激活', () => {
    const repository = seedManual(TASK_SHELF_LIMIT - 1)
    repository.recycle([terminal('trash')], 1000)
    const trash = repository.list().find(entry => entry.trashedAt !== undefined)!
    expect(() => repository.capture(terminal('trash'), 1100)).toThrow('请先激活')
    expect(() => repository.archive(trash.id, false, 1100)).toThrow('请先激活')
    expect(() => repository.archive(trash.id, true, 1100)).toThrow('请先激活')
    repository.capture(terminal('saved-last'), 1200)
    expect(repository.list()).toHaveLength(TASK_SHELF_LIMIT + 1)
    expect(repository.get(trash.id)).toEqual(trash)
  })

  it('混合激活按版本和请求顺序提交，容量不足不影响归档项激活，重复项不重复占名额', () => {
    const repository = seedManual(TASK_SHELF_LIMIT - 1)
    const archived = repository.archive(repository.list()[0].id, true, 1200)
    const trash = repository.recycle([terminal('trash-a'), terminal('trash-b')], 1300).filter(entry => entry.trashedAt !== undefined)
    const result = repository.archiveBatch([
      { id: trash[0].id, expectedRevision: trash[0].revision },
      { id: trash[0].id, expectedRevision: trash[0].revision },
      { id: trash[1].id, expectedRevision: trash[1].revision },
      { id: archived.id, expectedRevision: archived.revision }
    ], 1400)
    expect(result.items.map(item => item.status)).toEqual(['moved', 'conflict', 'failed', 'moved'])
    expect(repository.list().slice(-2).map(entry => entry.id)).toEqual([trash[0].id, archived.id])
    expect(repository.get(trash[1].id)).toEqual(trash[1])
    expect(repository.archiveBatch([{ id: trash[0].id, expectedRevision: trash[0].revision }], 1500).items[0].status).toBe('conflict')
  })

  it('退出归档、启动快照归档与全部取消归档均不移动回收站', () => {
    const repository = new TaskShelfRepository(file)
    const saved = repository.capture(terminal('saved'), 1000).entry
    const trash = repository.recycle([terminal('trash')], 1100).find(entry => entry.trashedAt !== undefined)!
    repository.archiveAll(1200)
    expect(repository.get(saved.id)?.archivedAt).toBe(1200)
    expect(repository.get(trash.id)).toEqual(trash)
    const result = repository.archiveSnapshot([{ id: trash.id, expectedRevision: trash.revision }], 1300)
    expect(result).toMatchObject({ committed: false, items: [{ id: trash.id, status: 'alreadyArchived' }] })
    repository.unarchiveAll(1400)
    expect(repository.get(saved.id)?.archivedAt).toBeUndefined()
    expect(repository.get(trash.id)).toEqual(trash)
  })

  it('激活写失败同时保留回收站分类、顺序与版本', () => {
    const repository = new TaskShelfRepository(file)
    const trash = repository.recycle([terminal('trash')], 1000)[0]
    const before = readFileSync(file, 'utf8')
    disk.failWrite = true
    expect(repository.archiveBatch([{ id: trash.id, expectedRevision: trash.revision }], 1200))
      .toMatchObject({ committed: false, items: [{ id: trash.id, status: 'failed' }] })
    expect(repository.get(trash.id)).toEqual(trash)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('旧档案保持兼容，回收站的非法分类、非终端与越界数量保留原件并拒绝加载', () => {
    const valid = { ...terminal('trash'), id: 'trash', createdAt: 1000, updatedAt: 1000, revision: 1 }
    writeFileSync(file, JSON.stringify({ version: 1, entries: [valid] }))
    expect(new TaskShelfRepository(file).list()[0].trashedAt).toBeUndefined()
    for (const invalid of [
      [{ ...valid, trashedAt: 1100, archivedAt: 1100 }],
      [{ ...valid, trashedAt: 0 }],
      [{ ...valid, resourceKey: 'web:web', recovery: { kind: 'web', url: 'https://example.com/' }, capability: 'web', trashedAt: 1100 }],
      Array.from({ length: 13 }, (_, index) => ({ ...valid, id: String(index), resourceKey: `terminal:${index}`, trashedAt: 1100 }))
    ]) {
      const raw = JSON.stringify({ version: 1, entries: invalid })
      writeFileSync(file, raw)
      expect(() => new TaskShelfRepository(file).list()).toThrow('damaged')
      expect(readFileSync(file, 'utf8')).toBe(raw)
    }
  })
})

describe('归档与偏好持久化', () => {
  it('普通页显式重载同意与原 persist:webbar 快照持久化，撤销时删除快照', () => {
    const repository = new TaskShelfRepository(file)
    const url = 'https://example.com/read'
    const entry = repository.capture(captureInput({ resourceKey: 'web:a', capability: 'web', recovery: { kind: 'web', url } })).entry
    const enabled = repository.setWebReloadable(entry.id, url, true)
    const metadata = { formatVersion: 1 as const, taskId: entry.id, resourceId: 'tab:a', suspendOperationId: 'normal-operation', recordedAt: 1000, url, partition: 'persist:webbar', zoom: 1.25, scrollY: 500 }
    expect(() => repository.saveWebSleep(entry.id, enabled.revision, { ...metadata, partition: 'persist:other-account' })).toThrow()
    repository.saveWebSleep(entry.id, enabled.revision, metadata)
    expect(new TaskShelfRepository(file).get(entry.id)?.recovery).toEqual({ kind: 'web', url, reloadableMode: true, sleep: metadata })
    repository.setWebReloadable(entry.id, url, false)
    expect(new TaskShelfRepository(file).get(entry.id)?.recovery).toEqual({ kind: 'web', url })
  })
  it('普通页重载同意不跨 URL、不覆盖只读契约，写入失败保持原状态', () => {
    const repository = new TaskShelfRepository(file)
    const url = 'https://example.com/read'
    const entry = repository.capture(captureInput({ resourceKey: 'web:a', capability: 'web', recovery: { kind: 'web', url } })).entry
    expect(() => repository.setWebReloadable(entry.id, 'https://example.com/other', true)).toThrow()
    disk.failWrite = true
    expect(() => repository.setWebReloadable(entry.id, url, true)).toThrow('disk full')
    expect(repository.get(entry.id)).toEqual(entry)
    expect(new TaskShelfRepository(file).get(entry.id)).toEqual(entry)
    disk.failWrite = false
    const readonly = repository.capture(captureInput({ resourceKey: 'web:b', capability: 'web', recovery: { kind: 'web', url, readonlyMode: true } })).entry
    expect(() => repository.setWebReloadable(readonly.id, url, true)).toThrow()
  })
  it('只读休眠快照原子保存、校验版本、跨重启保留，失败不覆盖旧快照', () => {
    const repository = new TaskShelfRepository(file)
    const entry = repository.capture(captureInput({ resourceKey: 'web:a', capability: 'web', recovery: { kind: 'web', url: 'https://example.com/read', readonlyMode: true } })).entry
    const metadata = { formatVersion: 1 as const, taskId: entry.id, resourceId: 'tab:a', suspendOperationId: 'operation-1', recordedAt: 1000, url: 'https://example.com/final', partition: 'shelf-readonly-v1:01234567-89ab-cdef-0123-456789abcdef', zoom: 1.25, scrollY: 400 }
    repository.saveWebSleep(entry.id, entry.revision, metadata)
    const saved = new TaskShelfRepository(file).get(entry.id)
    expect(saved?.recovery).toEqual({ kind: 'web', url: metadata.url, readonlyMode: true, sleep: metadata })
    expect(() => repository.saveWebSleep(entry.id, entry.revision, metadata)).toThrow('变化')
    disk.failWrite = true
    expect(() => repository.saveWebSleep(entry.id, saved!.revision, { ...metadata, suspendOperationId: 'operation-2' })).toThrow('disk full')
    expect(repository.get(entry.id)).toEqual(saved)
    expect(new TaskShelfRepository(file).get(entry.id)).toEqual(saved)
  })
  it('拒绝未知快照版本、错误分区与越界滚动，不把动态恢复记录当只读快照', () => {
    const repository = new TaskShelfRepository(file)
    const entry = repository.capture(captureInput({ resourceKey: 'web:a', capability: 'web', recovery: { kind: 'web', url: 'https://example.com/read', readonlyMode: true } })).entry
    const metadata = { formatVersion: 1 as const, taskId: entry.id, resourceId: 'tab:a', suspendOperationId: 'operation', recordedAt: 1000, url: 'https://example.com/read', partition: 'shelf-readonly-v1:01234567-89ab-cdef-0123-456789abcdef', zoom: 1, scrollY: 0 }
    for (const patch of [{ partition: 'persist:webbar' }, { scrollY: Infinity }, { zoom: NaN }]) {
      expect(() => repository.saveWebSleep(entry.id, entry.revision, { ...metadata, ...patch })).toThrow()
      expect(repository.get(entry.id)).toEqual(entry)
    }
    const archive = readArchive()
    archive.entries[0].recovery = { kind: 'web', url: metadata.url, readonlyMode: true, sleep: { ...metadata, formatVersion: 2 } }
    writeFileSync(file, JSON.stringify(archive))
    expect(() => new TaskShelfRepository(file).list()).toThrow('damaged')
  })
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
    expect(repository.getPreferences()).toEqual({ toggleShortcut: 'Ctrl+`', collectShortcut: 'Ctrl+Shift+S' })
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
  it('加载旧默认 Ctrl+Shift+J 迁移为 Ctrl+`，自定义与禁用值原样保留', () => {
    writeFileSync(file, JSON.stringify({ version: 1, preferences: { toggleShortcut: 'Ctrl+Shift+J', collectShortcut: 'Ctrl+Shift+S' }, entries: [] }))
    expect(new TaskShelfRepository(file).getPreferences()).toEqual({ toggleShortcut: 'Ctrl+`', collectShortcut: 'Ctrl+Shift+S' })

    for (const kept of [
      { toggleShortcut: 'Ctrl+Shift+K', collectShortcut: 'Ctrl+Shift+S' },
      { toggleShortcut: 'Meta+`', collectShortcut: '' },
      { toggleShortcut: '', collectShortcut: 'Ctrl+Shift+J' }
    ]) {
      writeFileSync(file, JSON.stringify({ version: 1, preferences: kept, entries: [] }))
      expect(new TaskShelfRepository(file).getPreferences()).toEqual(kept)
    }
  })
  it('迁移后的新默认随下一次写盘固化，旧默认不再写回文件', () => {
    writeFileSync(file, JSON.stringify({ version: 1, preferences: { toggleShortcut: 'Ctrl+Shift+J', collectShortcut: '' }, entries: [] }))
    const repository = new TaskShelfRepository(file)
    repository.capture(captureInput(), 1000)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { preferences: unknown }).preferences).toEqual({ toggleShortcut: 'Ctrl+`', collectShortcut: '' })
    expect(new TaskShelfRepository(file).getPreferences()).toEqual({ toggleShortcut: 'Ctrl+`', collectShortcut: '' })
  })
  it('用户显式保存 Ctrl+Shift+J 时按自定义值写回，不被加载迁移改写', () => {
    const repository = new TaskShelfRepository(file)
    expect(repository.setPreferences({ toggleShortcut: 'Ctrl+Shift+J', collectShortcut: '' })).toEqual({ toggleShortcut: 'Ctrl+Shift+J', collectShortcut: '' })
    expect(repository.getPreferences().toggleShortcut).toBe('Ctrl+Shift+J')
    expect(new TaskShelfRepository(file).getPreferences().toggleShortcut).toBe('Ctrl+Shift+J')
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

/** 退出/启动补归档：整批原子写一次，只收起未归档记录。 */
describe('TaskShelfRepository.archiveAll', () => {
  function webInput(overrides: Partial<ShelfCaptureInput> = {}): ShelfCaptureInput {
    return {
      resourceKey: 'web:w1',
      title: '文档',
      workspace: undefined,
      recovery: { kind: 'web', url: 'https://example.com/docs/guide' },
      capability: 'web',
      ...overrides
    }
  }

  function harnessInput(overrides: Partial<ShelfCaptureInput> = {}): ShelfCaptureInput {
    return {
      resourceKey: 'harness:h1',
      title: '助手任务',
      workspace: 'D:/work/harness',
      recovery: { kind: 'harness', sessionId: 's1', taskId: 'task-1', identity: { instanceId: 'inst-1', instanceEpoch: 2 }, lastState: 'idle' },
      capability: 'harness-history',
      ...overrides
    }
  }

  it('混合资源一次归档：整批只写一次盘，恢复元数据、SSH 上下文与偏好全部保留', () => {
    const repository = new TaskShelfRepository(file)
    const ssh = repository.capture(captureInput({ context: { text: 'previous output\n/home/work', capturedAt: 900 } }), 1000).entry
    const web = repository.capture(webInput(), 1010).entry
    const harness = repository.capture(harnessInput(), 1020).entry
    const preferences = repository.setPreferences({ toggleShortcut: 'Ctrl+Shift+Y', collectShortcut: '' })
    const writes = disk.writes
    const before = repository.list()

    const archived = repository.archiveAll(2000)

    // 整批一次 commit：不是每条记录写一次盘。
    expect(disk.writes).toBe(writes + 1)
    expect(archived.map(item => item.id)).toEqual([ssh.id, web.id, harness.id])
    for (const item of archived) {
      const previous = before.find(candidate => candidate.id === item.id)!
      expect(item.archivedAt).toBe(2000)
      expect(item.revision).toBe(previous.revision + 1)
      expect(item.updatedAt).toBe(Math.max(2000, previous.updatedAt + 1))
      // 归档只加时间戳：恢复引用、工作区与 SSH 上下文都原样保留。
      expect(item.recovery).toEqual(previous.recovery)
      expect(item.workspace).toEqual(previous.workspace)
      expect(item.context).toEqual(previous.context)
    }
    expect(archived.find(item => item.id === ssh.id)?.context).toEqual({ text: 'previous output\n/home/work', capturedAt: 900 })

    const reopened = new TaskShelfRepository(file)
    expect(reopened.list()).toEqual(archived)
    expect(reopened.getPreferences()).toEqual(preferences)
    expect(readArchive().entries.map(item => item.archivedAt)).toEqual([2000, 2000, 2000])
    expect(readArchive().entries).toHaveLength(3)
  })

  it('已有归档记录的时间与版本原样保留，只有未归档记录被收起', () => {
    const repository = new TaskShelfRepository(file)
    const first = repository.capture(captureInput({ resourceKey: 'terminal:t1' }), 1000).entry
    const second = repository.capture(webInput({ resourceKey: 'web:w2' }), 2000).entry
    repository.archive(first.id, true, 3000)
    const frozen = repository.get(first.id)!
    const writes = disk.writes

    const archived = repository.archiveAll(4000)

    expect(disk.writes).toBe(writes + 1)
    // 已归档记录连 revision/updatedAt 都不动。
    expect(archived.find(item => item.id === first.id)).toEqual(frozen)
    expect(readArchive().entries.find(item => item.id === first.id)).toMatchObject({
      archivedAt: frozen.archivedAt,
      revision: frozen.revision,
      updatedAt: frozen.updatedAt
    })
    expect(archived.find(item => item.id === second.id)).toMatchObject({ archivedAt: 4000, revision: 2, updatedAt: 4000 })
    // 重建仓储后归档标记仍在，且已有归档记录没有被重写时间。
    const reopened = new TaskShelfRepository(file)
    expect(reopened.get(first.id)).toEqual(frozen)
    expect(reopened.get(second.id)?.archivedAt).toBe(4000)
  })

  it('空保存区与重复调用都不写盘', () => {
    const empty = new TaskShelfRepository(file)
    expect(empty.archiveAll(1000)).toEqual([])
    expect(disk.writes).toBe(0)
    expect(existsSync(file)).toBe(false)

    const repository = new TaskShelfRepository(file)
    repository.capture(captureInput(), 1000)
    repository.capture(webInput(), 2000)
    const archived = repository.archiveAll(3000)
    const writes = disk.writes

    // 再归档一次：没有待归档项，返回完整列表但一个字节都不写。
    expect(repository.archiveAll(4000)).toEqual(archived)
    expect(repository.archiveAll(5000)).toEqual(archived)
    expect(disk.writes).toBe(writes)
  })

  it('整批写入失败时回滚全部内存与磁盘，恢复后仍可整体归档', () => {
    const repository = new TaskShelfRepository(file)
    repository.capture(captureInput(), 1000)
    repository.capture(webInput(), 2000)
    repository.capture(harnessInput(), 3000)
    const before = readFileSync(file, 'utf8')
    const memoryBefore = repository.list()
    const writes = disk.writes

    disk.failWrite = true
    expect(() => repository.archiveAll(4000)).toThrow(/保存区写入失败/)
    // 一条都没归档：内存、磁盘与写盘次数都停在失败前。
    expect(disk.writes).toBe(writes)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(repository.list()).toEqual(memoryBefore)
    expect(repository.list().map(item => item.archivedAt)).toEqual([undefined, undefined, undefined])
    expect(new TaskShelfRepository(file).list()).toEqual(memoryBefore)

    disk.failWrite = false
    const archived = repository.archiveAll(5000)
    expect(archived.map(item => item.archivedAt)).toEqual([5000, 5000, 5000])
    expect(archived.map(item => item.revision)).toEqual([2, 2, 2])
    expect(new TaskShelfRepository(file).list()).toEqual(archived)
  })

  it('返回值是深拷贝：改返回值不影响仓储内存与磁盘', () => {
    const repository = new TaskShelfRepository(file)
    const saved = repository.capture(captureInput({ context: { text: 'previous output', capturedAt: 900 } }), 1000).entry
    const archived = repository.archiveAll(2000)
    // 归档之后的写盘次数：改返回值不应再触发一次写盘。
    const writes = disk.writes

    archived[0].title = '被改坏'
    archived[0].archivedAt = 1
    archived[0].revision = 99
    archived[0].context!.text = 'rewritten'
    archived[0].context!.capturedAt = 2
    const recovery = archived[0].recovery
    if (recovery.kind === 'terminal') {
      recovery.cwd = 'C:/rewritten'
      recovery.sessionId = 'rewritten'
    }

    expect(disk.writes).toBe(writes)
    expect(repository.get(saved.id)).toMatchObject({ title: '终端 1', archivedAt: 2000, revision: 2 })
    expect(repository.get(saved.id)?.recovery).toEqual(saved.recovery)
    expect(repository.get(saved.id)?.context).toEqual(saved.context)
    expect(new TaskShelfRepository(file).get(saved.id)?.title).toBe('终端 1')
  })

  it('时间回退时 archivedAt 用传入的 now，updatedAt 仍严格前进', () => {
    const repository = new TaskShelfRepository(file)
    const late = repository.capture(captureInput(), 5000).entry

    const [archived] = repository.archiveAll(1000)

    expect(archived.archivedAt).toBe(1000)
    expect(archived.updatedAt).toBe(5001)
    expect(archived.updatedAt).toBeGreaterThan(late.updatedAt)
    expect(archived.revision).toBe(late.revision + 1)
    expect(new TaskShelfRepository(file).get(late.id)?.updatedAt).toBe(5001)
  })

  it('与逐条 archive 得到相同记录（单项归档语义未变）', () => {
    const secondFile = join(dir, 'task-shelf-second.json')
    const batch = new TaskShelfRepository(file)
    const single = new TaskShelfRepository(secondFile)
    const seeds: ShelfCaptureInput[] = [captureInput({ resourceKey: 'terminal:t1' }), webInput({ resourceKey: 'web:w3' }), harnessInput({ resourceKey: 'harness:h3' })]
    const singleResults: TaskShelfEntry[] = []
    seeds.forEach((seed, index) => {
      batch.capture(seed, 1000 + index)
      singleResults.push(single.capture(seed, 1000 + index).entry)
    })

    const archived = batch.archiveAll(9000)
    const expected = singleResults.map(entry => single.archive(entry.id, true, 9000))
    const project = (entries: TaskShelfEntry[]) => entries.map(({ id: _id, ...rest }) => rest)
    expect(project(archived)).toEqual(project(expected))
  })
})

/** 归档区「全部移回 Tasks」：只摘 archivedAt，不动恢复元数据，也不启动任何实例。 */
describe('TaskShelfRepository.unarchiveAll', () => {
  function webInput(overrides: Partial<ShelfCaptureInput> = {}): ShelfCaptureInput {
    return {
      resourceKey: 'web:w1',
      title: '文档',
      workspace: undefined,
      recovery: { kind: 'web', url: 'https://example.com/docs/guide' },
      capability: 'web',
      ...overrides
    }
  }

  it('混合归档与活动记录：只移回归档项，活动项与偏好原样保留，整批只写一次盘', () => {
    const repository = new TaskShelfRepository(file)
    const active = repository.capture(
      captureInput({ resourceKey: 'terminal:active', title: '活动终端', recovery: { kind: 'terminal', sessionId: 'active', type: ConnectionType.LOCAL, cwd: 'C:/work/active' }, capability: 'directory' }),
      1000
    ).entry
    const ssh = repository.capture(captureInput({ context: { text: 'previous output', capturedAt: 900 } }), 1010).entry
    const web = repository.capture(webInput(), 1020).entry
    repository.archive(ssh.id, true, 1500)
    repository.archive(web.id, true, 1600)
    const preferences = repository.setPreferences({ toggleShortcut: 'Ctrl+Shift+Y', collectShortcut: '' })
    const before = repository.list()
    const writes = disk.writes

    const moved = repository.unarchiveAll(2000)

    // 整批一次 commit：不是每条记录写一次盘。
    expect(disk.writes).toBe(writes + 1)
    expect(moved.map(item => item.id)).toEqual([active.id, ssh.id, web.id])
    for (const item of moved) expect(item.archivedAt).toBeUndefined()
    // 本来就活动的记录一个字段都不动。
    expect(moved.find(item => item.id === active.id)).toEqual(before.find(item => item.id === active.id))
    // 归档记录：revision 前进、updatedAt 严格单调，恢复元数据/工作区/上下文原样保留。
    for (const id of [ssh.id, web.id]) {
      const previous = before.find(item => item.id === id)!
      const current = moved.find(item => item.id === id)!
      expect(current.revision).toBe(previous.revision + 1)
      expect(current.updatedAt).toBe(Math.max(2000, previous.updatedAt + 1))
      expect(current.recovery).toEqual(previous.recovery)
      expect(current.workspace).toEqual(previous.workspace)
      expect(current.context).toEqual(previous.context)
    }
    expect(moved.find(item => item.id === ssh.id)?.context).toEqual({ text: 'previous output', capturedAt: 900 })
    expect(repository.getPreferences()).toEqual(preferences)
    expect(readArchive().entries.map(item => item.archivedAt)).toEqual([undefined, undefined, undefined])

    const reopened = new TaskShelfRepository(file)
    expect(reopened.list()).toEqual(moved)
    expect(reopened.getPreferences()).toEqual(preferences)
  })

  it('跨实例重建后整批移回，revision 接着递增且磁盘上不再有归档标记', () => {
    const first = new TaskShelfRepository(file)
    const saved = first.capture(captureInput(), 1000).entry
    first.archive(saved.id, true, 1100)
    expect(readArchive().entries[0]).toMatchObject({ archivedAt: 1100, revision: 2 })

    const [moved] = new TaskShelfRepository(file).unarchiveAll(5000)

    expect(moved).toMatchObject({ revision: 3, updatedAt: 5000 })
    expect(moved.archivedAt).toBeUndefined()
    expect(readArchive().entries[0]).not.toHaveProperty('archivedAt')
    expect(readArchive().entries[0]).toMatchObject({ revision: 3, updatedAt: 5000 })
    expect(new TaskShelfRepository(file).get(saved.id)).toEqual(moved)
  })

  it('空保存区与重复调用都不写盘，返回完整列表', () => {
    const empty = new TaskShelfRepository(file)
    expect(empty.unarchiveAll(1000)).toEqual([])
    expect(disk.writes).toBe(0)
    expect(existsSync(file)).toBe(false)

    const repository = new TaskShelfRepository(file)
    const saved = repository.capture(captureInput(), 1000).entry
    // 没有已归档记录：原样返回，不涨 revision、不写盘。
    expect(repository.unarchiveAll(2000)).toEqual([saved])
    const writes = disk.writes
    expect(repository.unarchiveAll(3000)).toEqual([saved])
    expect(disk.writes).toBe(writes)
    expect(repository.get(saved.id)).toEqual(saved)
  })

  it('整批写入失败时完整回滚内存与磁盘，恢复后仍可整批移回', () => {
    const repository = new TaskShelfRepository(file)
    const one = repository.capture(captureInput(), 1000).entry
    repository.capture(webInput(), 2000)
    repository.archive(one.id, true, 2500)
    const before = readFileSync(file, 'utf8')
    const memoryBefore = repository.list()
    const writes = disk.writes

    disk.failWrite = true
    expect(() => repository.unarchiveAll(3000)).toThrow(/保存区写入失败/)
    expect(disk.writes).toBe(writes)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(repository.list()).toEqual(memoryBefore)
    expect(repository.list().find(item => item.id === one.id)?.archivedAt).toBe(2500)
    expect(new TaskShelfRepository(file).list()).toEqual(memoryBefore)

    disk.failWrite = false
    const moved = repository.unarchiveAll(4000)
    expect(moved.map(item => item.archivedAt)).toEqual([undefined, undefined])
    expect(moved.map(item => item.revision)).toEqual([3, 1])
    expect(new TaskShelfRepository(file).list()).toEqual(moved)
  })

  it('返回值是深拷贝：改返回值不影响仓储内存与磁盘', () => {
    const repository = new TaskShelfRepository(file)
    const saved = repository.capture(captureInput({ context: { text: 'previous output', capturedAt: 900 } }), 1000).entry
    repository.archive(saved.id, true, 1500)
    const moved = repository.unarchiveAll(2000)
    const writes = disk.writes

    moved[0].title = '被改坏'
    moved[0].revision = 99
    moved[0].context!.text = 'rewritten'
    moved[0].context!.capturedAt = 2
    const recovery = moved[0].recovery
    if (recovery.kind === 'terminal') {
      recovery.cwd = 'C:/rewritten'
      recovery.sessionId = 'rewritten'
    }

    expect(disk.writes).toBe(writes)
    expect(repository.get(saved.id)).toMatchObject({ title: '终端 1', revision: 3, updatedAt: 2000 })
    expect(repository.get(saved.id)?.archivedAt).toBeUndefined()
    expect(repository.get(saved.id)?.recovery).toEqual(saved.recovery)
    expect(repository.get(saved.id)?.context).toEqual(saved.context)
    expect(new TaskShelfRepository(file).get(saved.id)?.title).toBe('终端 1')
  })

  it('时间回退时 updatedAt 仍严格前进，归档标记被摘掉', () => {
    const repository = new TaskShelfRepository(file)
    const late = repository.capture(captureInput(), 5000).entry
    repository.archive(late.id, true, 6000)

    const [moved] = repository.unarchiveAll(1000)

    expect(moved.archivedAt).toBeUndefined()
    expect(moved.updatedAt).toBe(6001)
    expect(moved.updatedAt).toBeGreaterThan(6000)
    expect(moved.revision).toBe(late.revision + 2)
    expect(new TaskShelfRepository(file).get(late.id)?.updatedAt).toBe(6001)
  })

  it('与逐条 archive(false) 得到相同记录（单项解除归档语义未变）', () => {
    const secondFile = join(dir, 'task-shelf-second.json')
    const batch = new TaskShelfRepository(file)
    const single = new TaskShelfRepository(secondFile)
    const seeds: ShelfCaptureInput[] = [captureInput({ resourceKey: 'terminal:t1' }), webInput({ resourceKey: 'web:w3' })]
    const singleResults: TaskShelfEntry[] = []
    seeds.forEach((seed, index) => {
      batch.capture(seed, 1000 + index)
      singleResults.push(single.capture(seed, 1000 + index).entry)
    })
    // 先让两条都处于归档态，再分别整批 / 逐条移回。
    batch.archiveAll(1500)
    singleResults.forEach(entry => single.archive(entry.id, true, 1500))

    const moved = batch.unarchiveAll(9000)
    const expected = singleResults.map(entry => single.archive(entry.id, false, 9000))
    const project = (entries: TaskShelfEntry[]) => entries.map(({ id: _id, ...rest }) => rest)
    expect(project(moved)).toEqual(project(expected))
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

describe('expectedRevision 冲突', () => {
  it('重复访问损坏归档也必须拒绝写入，健康查询可报告错误；修复后重新完整加载', () => {
    const broken = '{broken archive'
    writeFileSync(file, broken)
    const repository = new TaskShelfRepository(file)
    expect(() => repository.list()).toThrow(/damaged/)
    expect(() => repository.setPreferences({ toggleShortcut: 'Ctrl+Shift+K', collectShortcut: 'Ctrl+Shift+L' })).toThrow(/damaged/)
    expect(repository.getLoadError()?.reason).toBe('corrupt')
    expect(readFileSync(file, 'utf8')).toBe(broken)
    writeFileSync(file, JSON.stringify({ version: 1, entries: [] }))
    expect(repository.list()).toEqual([])
    expect(repository.getLoadError()).toBeNull()
  })

  it('偏好保存使用过期 revision 时抛冲突，内存与磁盘保持新值', () => {
    const repository = new TaskShelfRepository(file)
    const saved = repository.setPreferences({ toggleShortcut: 'Ctrl+Shift+K', collectShortcut: 'Ctrl+Shift+L' })
    const revision = repository.getRevision()
    expect(() => repository.setPreferences({ toggleShortcut: 'Ctrl+Shift+M', collectShortcut: 'Ctrl+Shift+N' }, { expectedRevision: revision - 1 }))
      .toThrow(RevisionConflictError)
    expect(repository.getPreferences()).toEqual(saved)
    expect(new TaskShelfRepository(file).getPreferences()).toEqual(saved)
  })
})
