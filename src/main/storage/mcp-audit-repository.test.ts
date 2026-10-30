import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ userData: '', logs: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: 'logs' | 'userData') => paths[name] }
}))
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync), unlinkSync: vi.fn(actual.unlinkSync) }
})

import { McpAuditRepository } from './mcp-audit-repository'
import type { McpAuditRecord } from './mcp-audit-repository'

const record: McpAuditRecord = {
  id: 'old-record', timestamp: '2026-10-23T00:00:00.000Z',
  operation: 'list_sessions', capability: 'read', allowed: true, tokenSource: 'global'
}

describe('MCP 活动日志位置及旧记录迁移', () => {
  let root: string
  let legacyPath: string
  let logPath: string

  beforeEach(async () => {
    vi.useFakeTimers()
    const actual = await vi.importActual<typeof import('fs')>('fs')
    vi.mocked(writeFileSync).mockReset().mockImplementation(actual.writeFileSync)
    vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync)
    vi.mocked(unlinkSync).mockReset().mockImplementation(actual.unlinkSync)
    root = mkdtempSync(join(tmpdir(), 'lyshell-mcp-audit-'))
    paths.userData = join(root, 'user-data')
    // 不预建 logs，验证首次使用自动建目录；与用户数据目录相互独立。
    paths.logs = join(root, '便携应用', 'logs')
    mkdirSync(paths.userData, { recursive: true })
    legacyPath = join(paths.userData, 'mcp-audit.json')
    logPath = join(paths.logs, 'mcp-audit.json')
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    // 清理目标必须是本用例在系统临时目录下创建的独立目录。
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

  it('缩小保留条数立即裁剪最旧记录，并保存设置供重启读取', () => {
    seedRecords(1200)
    const repo = new McpAuditRepository()
    expect(repo.getRetentionLimit()).toBe(5000)
    repo.setRetentionLimit(1000)
    expect(repo.query({ limit: 2000 }).records.map(item => item.id))
      .toEqual(Array.from({ length: 1000 }, (_, index) => String(1199 - index)))
    repo.flushSync()
    expect(readRecords(logPath)).toHaveLength(1000)
    expect(new McpAuditRepository().getRetentionLimit()).toBe(1000)
    repo.append({ operation: 'new-operation', capability: 'read', allowed: true, tokenSource: 'global' })
    expect(repo.query({}).total).toBe(1000)
    expect(repo.query({}).records[0].operation).toBe('new-operation')
    repo.flushSync()
    expect(readRecords(logPath)[0].id).toBe('201')
  })

  it('启动先读取已保存的上限，不会按默认 5000 条裁剪更大的已选档位', () => {
    saveSettings({ retentionLimit: 10000 })
    seedRecords(6000)
    const repo = new McpAuditRepository()
    expect(repo.getRetentionLimit()).toBe(10000)
    expect(repo.query({}).total).toBe(6000)
  })

  it('启动加载超额日志也按所选上限裁剪并落盘', () => {
    saveSettings({ retentionLimit: 1000 })
    seedRecords(1200)
    const repo = new McpAuditRepository()
    expect(repo.query({}).total).toBe(1000)
    repo.flushSync()
    expect(readRecords(logPath)).toHaveLength(1000)
  })

  it.each([null, { retentionLimit: 0 }, { retentionLimit: 1000000 }, { retentionLimit: '1000' }])('非法设置文件 %j 回退默认档位', (settings) => {
    saveSettings(settings)
    expect(new McpAuditRepository().getRetentionLimit()).toBe(5000)
  })

  it('设置文件写入失败不改变原上限，也不裁剪现有记录', () => {
    seedRecords(1200)
    const repo = new McpAuditRepository()
    expect(repo.getRetentionLimit()).toBe(5000)
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(() => repo.setRetentionLimit(1000)).toThrow('EACCES')
    expect(repo.getRetentionLimit()).toBe(5000)
    expect(repo.query({}).total).toBe(1200)
    expect(readRecords(logPath)).toHaveLength(1200)
  })

  it('新记录和退出前刷盘都写入所配置的 logs 目录', () => {
    const repo = new McpAuditRepository()
    repo.append({ operation: 'list_sessions', capability: 'read', allowed: true, tokenSource: 'global' })
    repo.flushSync()
    expect(readRecords(logPath)).toHaveLength(1)
    expect(existsSync(legacyPath)).toBe(false)
    expect(new McpAuditRepository().query({}).total).toBe(1)
  })

  it('迁移旧位置的记录，确认新文件成功保存后移除旧文件', () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    const repo = new McpAuditRepository()
    expect(repo.query({}).records).toEqual([record])
    expect(readRecords(logPath)).toEqual([record])
    expect(existsSync(legacyPath)).toBe(false)
    expect(new McpAuditRepository().query({}).records).toEqual([record])
  })

  it('新旧位置都有文件时以 logs 为准，不覆盖已有新记录', () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    mkdirSync(paths.logs, { recursive: true })
    const current = { ...record, id: 'new-record' }
    writeFileSync(logPath, JSON.stringify([current]))
    expect(new McpAuditRepository().query({}).records).toEqual([current])
    expect(readRecords(logPath)).toEqual([current])
    expect(readRecords(legacyPath)).toEqual([record])
  })

  it('清空后重新加载仍为空，不会重新导入残留旧文件', () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    mkdirSync(paths.logs, { recursive: true })
    writeFileSync(logPath, JSON.stringify([record]))
    const repo = new McpAuditRepository()
    repo.clear()
    repo.flushSync()
    expect(readRecords(logPath)).toEqual([])
    expect(new McpAuditRepository().query({}).total).toBe(0)
  })

  it('迁移写盘失败时保留旧文件和内存记录，后续保存可重试', () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    const repo = new McpAuditRepository()
    expect(repo.query({}).records).toEqual([record])
    expect(readRecords(legacyPath)).toEqual([record])
    expect(existsSync(logPath)).toBe(false)
    repo.flushSync()
    expect(readRecords(logPath)).toEqual([record])
  })

  it('迁移重命名失败时不直写目标文件，保留旧记录供下次完整迁移', () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('EPERM') })
    expect(new McpAuditRepository().query({}).records).toEqual([record])
    expect(existsSync(logPath)).toBe(false)
    expect(readRecords(legacyPath)).toEqual([record])
    expect(new McpAuditRepository().query({}).records).toEqual([record])
    expect(readRecords(logPath)).toEqual([record])
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('裁剪记录的重命名失败时保留原日志文件，刷盘重试成功后再替换', () => {
    seedRecords(1200)
    const repo = new McpAuditRepository()
    repo.setRetentionLimit(1000)
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('EPERM') })
    repo.flushSync()
    expect(readRecords(logPath)).toHaveLength(1200)
    expect(repo.query({}).total).toBe(1000)
    repo.flushSync()
    expect(readRecords(logPath)).toHaveLength(1000)
  })

  it('旧文件删除失败时仍可读取新文件，避免重复导入', () => {
    writeFileSync(legacyPath, JSON.stringify([record]))
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(new McpAuditRepository().query({}).records).toEqual([record])
    expect(readRecords(legacyPath)).toEqual([record])
    expect(readRecords(logPath)).toEqual([record])
    expect(new McpAuditRepository().query({}).records).toEqual([record])
  })

  it('不迁移损坏的旧文件，保留原始内容', () => {
    writeFileSync(legacyPath, '{broken')
    expect(new McpAuditRepository().query({}).total).toBe(0)
    expect(readFileSync(legacyPath, 'utf8')).toBe('{broken')
    expect(existsSync(logPath)).toBe(false)
  })

  it('损坏的线上日志拒绝被空内存覆盖，append/flush 均保留原件', () => {
    mkdirSync(paths.logs, { recursive: true })
    writeFileSync(logPath, '{broken-live-log')
    const repo = new McpAuditRepository()
    expect(repo.query({}).total).toBe(0)
    repo.append({ operation: 'list_sessions', capability: 'read', allowed: true, tokenSource: 'global' })
    repo.flushSync()
    expect(readFileSync(logPath, 'utf8')).toBe('{broken-live-log')
    expect(existsSync(legacyPath)).toBe(false)
    expect(readdirSync(paths.logs).some(name => name.startsWith('mcp-audit.json.corrupt-'))).toBe(true)
  })
})
