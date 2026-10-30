import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { open, rename, unlink } from 'fs/promises'

const paths = vi.hoisted(() => ({ userData: '', logs: '' }))
vi.mock('electron', () => ({ app: { getPath: (name: 'logs' | 'userData') => paths[name] } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

import { McpAuditRepository } from './mcp-audit-repository'
import type { McpAuditRecord } from './mcp-audit-repository'

const record: McpAuditRecord = {
  id: 'old-record', timestamp: '2026-10-23T00:00:00.000Z',
  operation: 'list_sessions', capability: 'read', allowed: true, tokenSource: 'global'
}

describe('MCP 活动日志位置、异步提交及旧记录迁移', () => {
  let root: string
  let legacyPath: string
  let logPath: string

  beforeEach(async () => {
    vi.useFakeTimers()
    const sync = await vi.importActual<typeof import('fs')>('fs')
    const asyncFs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    vi.mocked(writeFileSync).mockReset().mockImplementation(sync.writeFileSync)
    vi.mocked(open).mockReset().mockImplementation(asyncFs.open)
    vi.mocked(rename).mockReset().mockImplementation(asyncFs.rename)
    vi.mocked(unlink).mockReset().mockImplementation(asyncFs.unlink)
    root = mkdtempSync(join(tmpdir(), 'lyshell-mcp-audit-'))
    paths.userData = join(root, 'user-data')
    paths.logs = join(root, '便携应用', 'logs')
    mkdirSync(paths.userData, { recursive: true })
    legacyPath = join(paths.userData, 'mcp-audit.json')
    logPath = join(paths.logs, 'mcp-audit.json')
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  })

  const readRecords = (file: string): McpAuditRecord[] => JSON.parse(readFileSync(file, 'utf8'))
  const seedRecords = (count: number) => {
    mkdirSync(paths.logs, { recursive: true })
    writeFileSync(logPath, JSON.stringify(Array.from({ length: count }, (_, index) => ({ ...record, id: String(index) }))))
  }
  const saveSettings = (value: unknown) => {
    mkdirSync(join(paths.userData, 'config'), { recursive: true })
    writeFileSync(join(paths.userData, 'config', 'mcp-audit-settings.json'), JSON.stringify(value))
  }

  it('缩小保留条数裁剪最旧记录，flush 确认日志和设置供重启读取', async () => {
    seedRecords(1200)
    const repo = new McpAuditRepository()
    expect(repo.getRetentionLimit()).toBe(5000)
    repo.setRetentionLimit(1000)
    expect(repo.query({ limit: 2000 }).records.map(item => item.id))
      .toEqual(Array.from({ length: 1000 }, (_, index) => String(1199 - index)))
    await repo.flush()
    expect(readRecords(logPath)).toHaveLength(1000)
    expect(new McpAuditRepository().getRetentionLimit()).toBe(1000)
    repo.append({ operation: 'new-operation', capability: 'read', allowed: true, tokenSource: 'global' })
    expect(repo.query({}).total).toBe(1000)
    expect(repo.query({}).records[0].operation).toBe('new-operation')
    await repo.flush()
    expect(readRecords(logPath)[0].id).toBe('201')
  })

  it('先读已保存上限，不按默认 5000 条裁剪更大的档位', () => {
    saveSettings({ retentionLimit: 10000 }); seedRecords(6000)
    const repo = new McpAuditRepository()
    expect(repo.getRetentionLimit()).toBe(10000)
    expect(repo.query({}).total).toBe(6000)
  })

  it('加载超额日志按所选上限裁剪并异步落盘', async () => {
    saveSettings({ retentionLimit: 1000 }); seedRecords(1200)
    const repo = new McpAuditRepository()
    expect(repo.query({}).total).toBe(1000)
    await repo.flush()
    expect(readRecords(logPath)).toHaveLength(1000)
  })

  it.each([null, { retentionLimit: 0 }, { retentionLimit: 1000000 }, { retentionLimit: '1000' }])('非法设置文件 %j 回退默认档位', settings => {
    saveSettings(settings)
    expect(new McpAuditRepository().getRetentionLimit()).toBe(5000)
  })

  it('设置写入失败不改上限或裁剪记录', () => {
    seedRecords(1200)
    const repo = new McpAuditRepository()
    expect(repo.getRetentionLimit()).toBe(5000)
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(() => repo.setRetentionLimit(1000)).toThrow('EACCES')
    expect(repo.getRetentionLimit()).toBe(5000)
    expect(repo.query({}).total).toBe(1200)
    expect(readRecords(logPath)).toHaveLength(1200)
  })

  it('append 不同步写盘，退出 revision 屏障提交到 logs 并拒绝后续追加', async () => {
    const repo = new McpAuditRepository()
    const writesBefore = vi.mocked(writeFileSync).mock.calls.length
    repo.append({ operation: 'list_sessions', capability: 'read', allowed: true, tokenSource: 'global' })
    expect(vi.mocked(writeFileSync).mock.calls.length).toBe(writesBefore)
    expect(existsSync(logPath)).toBe(false)
    expect(repo.getPersistenceState()).toMatchObject({ currentRevision: 1, committedRevision: 0 })
    const revision = repo.stopAcceptingWrites()
    await repo.flush(revision)
    expect(readRecords(logPath)).toHaveLength(1)
    expect(existsSync(legacyPath)).toBe(false)
    expect(new McpAuditRepository().query({}).total).toBe(1)
    expect(() => repo.append({ operation: 'late', capability: 'read', allowed: true, tokenSource: '' })).toThrow('draining')
  })

  it('旧位置迁移等新文件提交后才删除原件', async () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    const repo = new McpAuditRepository()
    expect(repo.query({}).records).toEqual([record])
    expect(readRecords(legacyPath)).toEqual([record])
    expect(existsSync(logPath)).toBe(false)
    await repo.flush()
    expect(readRecords(logPath)).toEqual([record])
    expect(existsSync(legacyPath)).toBe(false)
    expect(new McpAuditRepository().query({}).records).toEqual([record])
  })

  it('新旧位置都有文件时以 logs 为准，不覆盖新记录', () => {
    writeFileSync(legacyPath, JSON.stringify([record])); seedRecords(1)
    const current = { ...record, id: 'new-record' }
    writeFileSync(logPath, JSON.stringify([current]))
    expect(new McpAuditRepository().query({}).records).toEqual([current])
    expect(readRecords(logPath)).toEqual([current])
    expect(readRecords(legacyPath)).toEqual([record])
  })

  it('清空确认后重新加载为空，不导入残留旧文件', async () => {
    writeFileSync(legacyPath, JSON.stringify([record])); seedRecords(1)
    const repo = new McpAuditRepository()
    await repo.clear()
    expect(readRecords(logPath)).toEqual([])
    expect(new McpAuditRepository().query({}).total).toBe(0)
  })

  it('迁移临时创建失败保留原件与内存，flush 可重试', async () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    const repo = new McpAuditRepository()
    expect(repo.query({}).records).toEqual([record])
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    await expect(repo.flush()).rejects.toThrow('Persistence commit failed')
    expect(readRecords(legacyPath)).toEqual([record])
    expect(existsSync(logPath)).toBe(false)
    expect(repo.getPersistenceState().lastFailure).toEqual({ revision: 1, phase: 'primary', code: 'PERSISTENCE_FAILED' })
    await repo.flush()
    expect(readRecords(logPath)).toEqual([record])
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('迁移 rename 失败不直写目标，保留原件供重试', async () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    const repo = new McpAuditRepository()
    expect(repo.query({}).records).toEqual([record])
    vi.mocked(rename).mockRejectedValueOnce(new Error('EPERM'))
    await expect(repo.flush()).rejects.toThrow('Persistence commit failed')
    expect(existsSync(logPath)).toBe(false)
    expect(readRecords(legacyPath)).toEqual([record])
    await repo.flush()
    expect(readRecords(logPath)).toEqual([record])
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('裁剪 rename 失败保留原日志，重试成功后才替换', async () => {
    seedRecords(1200)
    const repo = new McpAuditRepository()
    repo.setRetentionLimit(1000)
    vi.mocked(rename).mockRejectedValueOnce(new Error('EPERM'))
    await expect(repo.flush()).rejects.toThrow('Persistence commit failed')
    expect(readRecords(logPath)).toHaveLength(1200)
    expect(repo.query({}).total).toBe(1000)
    await repo.flush()
    expect(readRecords(logPath)).toHaveLength(1000)
  })

  it('旧文件删除失败仍读新文件，避免重复导入', async () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    const repo = new McpAuditRepository()
    expect(repo.query({}).records).toEqual([record])
    vi.mocked(unlink).mockRejectedValueOnce(new Error('EACCES'))
    await repo.flush()
    expect(readRecords(legacyPath)).toEqual([record])
    expect(readRecords(logPath)).toEqual([record])
    expect(new McpAuditRepository().query({}).records).toEqual([record])
  })

  it('损坏旧文件不迁移，保留原始字节', () => {
    writeFileSync(legacyPath, '{broken')
    expect(new McpAuditRepository().query({}).total).toBe(0)
    expect(readFileSync(legacyPath, 'utf8')).toBe('{broken')
    expect(existsSync(logPath)).toBe(false)
  })

  it('损坏线上日志只读，append/flush 不覆盖原件且暴露固定错误', async () => {
    mkdirSync(paths.logs, { recursive: true })
    writeFileSync(logPath, '{broken-live-log')
    const repo = new McpAuditRepository()
    expect(repo.query({}).total).toBe(0)
    repo.append({ operation: 'list_sessions', capability: 'read', allowed: true, tokenSource: 'global' })
    await expect(repo.flush()).rejects.toThrow('Persistence commit failed')
    expect(readFileSync(logPath, 'utf8')).toBe('{broken-live-log')
    expect(existsSync(legacyPath)).toBe(false)
    expect(readdirSync(paths.logs).some(name => name.startsWith('mcp-audit.json.corrupt-'))).toBe(true)
    expect(repo.query({}).persistence.lastFailure?.code).toBe('PERSISTENCE_FAILED')
  })
})
