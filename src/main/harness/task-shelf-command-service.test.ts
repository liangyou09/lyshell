import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionType } from '@shared/types/session'
import { TaskShelfRepository, type ShelfCaptureInput } from '../storage/task-shelf-repository'
import { createTaskShelfCommandService, SHELF_CONFLICT, SHELF_INITIALIZATION_BLOCKED, SHELF_STALE_BOOT } from './task-shelf-command-service'

/** 写盘行为可控：启动归档/分类批次的原子失败都要能复现。 */
const disk = vi.hoisted(() => ({ failWrite: false, writes: 0 }))

vi.mock('../storage/repository', async () => {
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
  dir = mkdtempSync(join(tmpdir(), 'lyshell-shelf-command-'))
  file = join(dir, 'task-shelf.json')
  disk.failWrite = false
  disk.writes = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function captureInput(key: string): ShelfCaptureInput {
  return {
    resourceKey: `terminal:${key}`,
    title: key,
    recovery: { kind: 'terminal', sessionId: key, type: ConnectionType.LOCAL },
    capability: 'directory'
  }
}

/** 新建记录默认是 Tasks；指定 archivedAt 时再显式归档，revision 包含这次归档。 */
function seedTasks(repository: TaskShelfRepository, keys: string[], archivedAt?: number): ReturnType<TaskShelfRepository['capture']>['entry'][] {
  return keys.map(key => {
    const entry = repository.capture(captureInput(key), 1000).entry
    return archivedAt === undefined ? entry : repository.archive(entry.id, true, archivedAt)
  })
}

/** 启动前处于 Archive 的记录（activate 的目标）。 */
function seedArchived(repository: TaskShelfRepository, keys: string[], archivedAt = 1500): ReturnType<TaskShelfRepository['capture']>['entry'][] {
  return seedTasks(repository, keys, archivedAt)
}

function readArchive(): { version: number; entries: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(file, 'utf8')) as { version: number; entries: Record<string, unknown>[] }
}

describe('T01 启动归档固定首次快照', () => {
  it('启动把启动前记录移入 Archive，之后新增保存与重复读取都不再参与', () => {
    const repository = new TaskShelfRepository(file)
    // 混合重启：a 是 Tasks，b 已在 Archive
    const [first] = seedTasks(repository, ['a'])
    const second = seedTasks(repository, ['b'], 1500)[0]
    const writesBefore = disk.writes
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })

    expect(service.startup()).toMatchObject({ status: 'ready', archiveOnBoot: true })
    expect(typeof service.startup().bootId).toBe('string')
    expect(service.startup().scopeId).toContain('shelf:')
    // 原顺序保留，启动快照全部进入 Archive
    expect(repository.list().map(entry => entry.id)).toEqual([first.id, second.id])
    expect(repository.get(first.id)?.archivedAt).toBe(9000)
    expect(repository.get(second.id)?.archivedAt).toBe(1500)
    expect(disk.writes).toBe(writesBefore + 1)

    // 启动后新建的保存记录直接是 Tasks，不属于旧批次
    const later = repository.capture(captureInput('c'), 9100).entry
    expect(later.archivedAt).toBeUndefined()

    // renderer 重新 list／同一进程重复初始化：不重归档、不换 bootId
    const bootId = service.startup().bootId
    for (let index = 0; index < 3; index += 1) service.ensureStartup()
    expect(disk.writes).toBe(writesBefore + 2)
    expect(service.startup().bootId).toBe(bootId)
    expect(repository.get(first.id)?.archivedAt).toBe(9000)
    expect(repository.get(later.id)?.archivedAt).toBeUndefined()
  })

  it('未显式启用时保留既有 fixture 语义：记录分类原样不动', () => {
    const repository = new TaskShelfRepository(file)
    const entry = seedTasks(repository, ['a'], 1500)[0]
    const service = createTaskShelfCommandService({ repository })
    expect(service.ensureStartup()).toMatchObject({ status: 'ready', archiveOnBoot: false })
    expect(repository.get(entry.id)?.archivedAt).toBe(1500)
  })

  it('空保存区启动直接 ready，不需要写盘', () => {
    const repository = new TaskShelfRepository(file)
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true })
    expect(service.startup().status).toBe('ready')
    expect(disk.writes).toBe(0)
  })
})

describe('T02 启动归档保存失败', () => {
  it('写盘失败时保留真实原记录并 blocked，重试成功后 ready', () => {
    const repository = new TaskShelfRepository(file)
    const [first, second] = seedTasks(repository, ['a', 'b'])
    const before = readFileSync(file, 'utf8')
    disk.failWrite = true
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })

    const startup = service.startup()
    expect(startup.status).toBe('blocked')
    expect(startup.error).toMatch(/启动归档保存失败/)
    expect(service.blockedError()).toBe(startup.error)
    // 真实原记录仍在，且没有发生部分提交
    expect(repository.list().map(entry => entry.id)).toEqual([first.id, second.id])
    expect(repository.list().every(entry => entry.archivedAt === undefined)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(before)

    // 初始化未完成时分类变更被拒，且带稳定失败码
    const blocked = service.activate({ bootId: startup.bootId, scopeId: startup.scopeId, requestId: 'r-1', items: [{ taskId: first.id, expectedRevision: first.revision }] })
    expect(blocked).toMatchObject({ success: false, code: SHELF_INITIALIZATION_BLOCKED })
  })

  it('重试成功后 ready，之后再重试保持幂等', () => {
    const repository = new TaskShelfRepository(file)
    const [first] = seedTasks(repository, ['a'])
    disk.failWrite = true
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })
    const startup = service.startup()
    expect(startup.status).toBe('blocked')
    disk.failWrite = false
    const writesAfterSeed = disk.writes
    const retried = service.retryInitialization(startup.bootId, startup.scopeId)
    expect(retried).toMatchObject({ success: true })
    expect(retried.success && retried.startup.status).toBe('ready')
    expect(repository.get(first.id)?.archivedAt).toBe(9000)
    expect(disk.writes).toBe(writesAfterSeed + 1)
    // 已 ready 后重试幂等：不再写盘
    expect(service.retryInitialization(startup.bootId, startup.scopeId)).toMatchObject({ success: true })
    expect(disk.writes).toBe(writesAfterSeed + 1)
  })
})

describe('T06 旧批次晚到与外部更新', () => {
  it('重试前文件被外部合法修改：报冲突且不覆盖外部内容', () => {
    const repository = new TaskShelfRepository(file)
    seedTasks(repository, ['a'])
    disk.failWrite = true
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })
    const startup = service.startup()
    expect(startup.status).toBe('blocked')
    disk.failWrite = false

    const archive = readArchive()
    archive.entries[0].title = '外部改名'
    writeFileSync(file, JSON.stringify(archive), 'utf8')

    const retried = service.retryInitialization(startup.bootId, startup.scopeId)
    expect(retried).toMatchObject({ success: false, code: SHELF_CONFLICT })
    expect(readArchive().entries[0].title).toBe('外部改名')
  })

  it('旧 boot/scope、过期 revision、重复请求与去重容量都有明确结果', () => {
    const repository = new TaskShelfRepository(file)
    const [first, second] = seedArchived(repository, ['a', 'b'])
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })
    const { bootId, scopeId } = service.startup()

    expect(service.activate({ bootId: 'other-boot', scopeId, requestId: 'r-x', items: [] })).toMatchObject({ success: false, code: SHELF_STALE_BOOT })
    expect(service.retryInitialization(bootId, 'other-scope')).toMatchObject({ success: false, code: SHELF_STALE_BOOT })

    // 启动归档已固定 Archive：旧 revision 的迟到请求记冲突
    const stale = service.activate({ bootId, scopeId, requestId: 'r-stale', items: [{ taskId: first.id, expectedRevision: 1 }] })
    expect(stale).toMatchObject({ success: true, activation: { total: 1, conflict: 1, moved: 0 } })

    // 重新归档后按最新 revision 才能移动
    const archived = repository.archive(first.id, true, 9500)
    const moved = service.activate({ bootId, scopeId, requestId: 'r-move', items: [{ taskId: first.id, expectedRevision: archived.revision }] })
    expect(moved).toMatchObject({ success: true, activation: { items: [{ taskId: first.id, status: 'moved' }], total: 1, moved: 1 } })

    // 同 requestId 同载荷：复用结果且不重复写盘
    const writes = disk.writes
    const replay = service.activate({ bootId, scopeId, requestId: 'r-move', items: [{ taskId: first.id, expectedRevision: archived.revision }] })
    expect(replay).toEqual(moved)
    expect(disk.writes).toBe(writes)

    // 同 requestId 不同载荷：冲突，不当作新请求执行
    expect(service.activate({ bootId, scopeId, requestId: 'r-move', items: [{ taskId: second.id, expectedRevision: 2 }] })).toMatchObject({ success: false, code: SHELF_CONFLICT })
  })

  it('容量 256：最旧请求被淘汰后由版本校验兜底，不产生重复副作用', () => {
    const repository = new TaskShelfRepository(file)
    const [first] = seedArchived(repository, ['a'])
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })
    const { bootId, scopeId } = service.startup()
    const initial = repository.get(first.id)!
    const original = { bootId, scopeId, requestId: 'r-move', items: [{ taskId: first.id, expectedRevision: initial.revision }] }
    expect(service.activate(original)).toMatchObject({ success: true, activation: { moved: 1 } })
    for (let index = 0; index < 256; index += 1) {
      expect(service.activate({ bootId, scopeId, requestId: `r-${index}`, items: [] })).toMatchObject({ success: true, activation: { total: 0 } })
    }
    const archived = repository.archive(first.id, true, 9500)
    const writes = disk.writes
    expect(service.activate(original)).toMatchObject({ success: true, activation: { conflict: 1, moved: 0 } })
    expect(repository.get(first.id)?.revision).toBe(archived.revision)
    expect(repository.get(first.id)?.archivedAt).toBe(9500)
    expect(disk.writes).toBe(writes)
  })
})

describe('T04/T05 一次载荷 100 条', () => {
  it('100 条全部 moved、顺序按请求、计数自洽', () => {
    const repository = new TaskShelfRepository(file)
    const entries = seedArchived(repository, Array.from({ length: 100 }, (_, index) => `t${index}`))
    // 不启用自动归档：启动只校验，保留 100 条待分类记录
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: false, now: () => 9000 })
    const { bootId, scopeId } = service.startup()
    const items = entries.map(entry => ({ taskId: entry.id, expectedRevision: entry.revision }))
    const result = service.activate({ bootId, scopeId, requestId: 'r-100', items })
    if (!result.success) throw new Error(result.error)
    expect(result.activation).toMatchObject({ total: 100, moved: 100, alreadyTasks: 0, conflict: 0, missing: 0, failed: 0 })
    expect(result.activation.items.map(item => item.taskId)).toEqual(entries.map(entry => entry.id))
    expect(repository.list().map(entry => entry.id)).toEqual(entries.map(entry => entry.id))
    expect(repository.list().every(entry => entry.archivedAt === undefined)).toBe(true)
  })

  it('0 条返回空结果；超过 100 条在服务层被拒', () => {
    const repository = new TaskShelfRepository(file)
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: false })
    const { bootId, scopeId } = service.startup()
    expect(service.activate({ bootId, scopeId, requestId: 'r-empty', items: [] })).toMatchObject({ success: true, activation: { total: 0, items: [] } })
    const tooMany = Array.from({ length: 101 }, (_, index) => ({ taskId: `t${index}`, expectedRevision: 1 }))
    expect(service.activate({ bootId, scopeId, requestId: 'r-101', items: tooMany })).toMatchObject({ success: false })
  })
})

describe('T07 保存区读取异常不当作「文件不存在」', () => {
  it('重试时摘要读不出来：保持 blocked、不写盘', () => {
    const repository = new TaskShelfRepository(file)
    const [first] = seedTasks(repository, ['a'])
    disk.failWrite = true
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })
    const startup = service.startup()
    expect(startup.status).toBe('blocked')
    disk.failWrite = false

    // 归档路径被目录占住：existsSync 仍为真，readFileSync 抛 EISDIR（非 ENOENT）
    rmSync(file)
    mkdirSync(file)
    const writesBefore = disk.writes
    const retried = service.retryInitialization(startup.bootId, startup.scopeId)
    expect(retried).toMatchObject({ success: false, code: SHELF_INITIALIZATION_BLOCKED })
    expect(retried.success ? '' : retried.error).toMatch(/无法读取保存区/)
    expect(disk.writes).toBe(writesBefore)
    expect(service.startup().status).toBe('blocked')
    expect(repository.get(first.id)?.archivedAt).toBeUndefined()
  })

  it('首次初始化读取失败：blocked 不写盘；修好后重试重新完整加载', () => {
    mkdirSync(file)
    const repository = new TaskShelfRepository(file)
    const service = createTaskShelfCommandService({ repository, startupArchiveEnabled: true, now: () => 9000 })
    const startup = service.startup()
    expect(startup).toMatchObject({ status: 'blocked' })
    expect(startup.error).toMatch(/无法读取保存区/)
    expect(disk.writes).toBe(0)

    // 仍读不到：继续 blocked，绝不因为「读不到＝没文件」就去写
    expect(service.retryInitialization(startup.bootId, startup.scopeId)).toMatchObject({ success: false, code: SHELF_INITIALIZATION_BLOCKED })
    expect(disk.writes).toBe(0)

    // 换成合法归档后重试：重新固定快照并完成启动归档
    rmSync(file, { recursive: true, force: true })
    const [first] = seedTasks(repository, ['a'])
    const retried = service.retryInitialization(startup.bootId, startup.scopeId)
    expect(retried.success && retried.startup.status).toBe('ready')
    expect(repository.get(first.id)?.archivedAt).toBe(9000)
  })
})

describe('T08 快照漂移不发布 ready', () => {
  it('提交前记录被改/被删：即使其余项写入成功也保持 blocked', () => {
    const repository = new TaskShelfRepository(file)
    const [first, second, third] = seedTasks(repository, ['a', 'b', 'c'])
    let drifted = false
    const service = createTaskShelfCommandService({
      repository,
      startupArchiveEnabled: true,
      now: () => {
        if (!drifted) {
          drifted = true
          // 固定快照之后、真正提交之前，别处合法改动了 a、删掉了 b
          repository.archive(first.id, true, 8888)
          repository.remove(second.id)
        }
        return 9000
      }
    })

    const startup = service.startup()
    expect(startup.status).toBe('blocked')
    expect(startup.error).toMatch(/启动归档未完成/)
    // 未漂移的 c 确实写成功了，但整批归档仍未完成：不发布 ready
    expect(repository.get(third.id)?.archivedAt).toBe(9000)
    expect(repository.get(first.id)?.archivedAt).toBe(8888)
    expect(repository.get(second.id)).toBeUndefined()
    // 初始化未完成时分类变更照旧被拒
    expect(service.activate({ bootId: startup.bootId, scopeId: startup.scopeId, requestId: 'r-1', items: [] })).toMatchObject({ success: false, code: SHELF_INITIALIZATION_BLOCKED })
  })
})

