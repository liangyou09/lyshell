import { mkdtemp, readFile, writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ directory: '', writes: 0, bytes: 0, failRename: false }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))
vi.mock('fs/promises', async () => {
  const original = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return { ...original, rename: async (...args: Parameters<typeof original.rename>) => {
    if (state.failRename) { state.failRename = false; throw new Error('fixture rename failed') }
    return original.rename(...args)
  }, writeFile: async (...args: Parameters<typeof original.writeFile>) => {
    state.writes++; state.bytes += Buffer.byteLength(String(args[1]))
    return original.writeFile(...args)
  } }
})
import { DownloadHistoryStorage, type DownloadRecord, DOWNLOAD_HISTORY_HOT_LIMIT } from './download-history'
let storage: DownloadHistoryStorage
const record = (id: number): DownloadRecord => ({ id: String(id), taskId: String(id), sessionId: id % 2 ? 'a' : 'b', sessionName: 'fixture', host: 'fixture', port: 22, fileName: 'fixture', remotePath: '/fixture', localPath: 'fixture', fileSize: 1, startTime: new Date(0), status: 'success', downloadDir: 'fixture' })
beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'lyshell-history-test-'))
  storage = new DownloadHistoryStorage(); await storage.init()
  state.writes = 0; state.bytes = 0
  state.failRename = false
})
afterEach(async () => { await storage.flush(); await rm(state.directory, { recursive: true, force: true }) })

it('2000 次顺序新增不逐次重写整库，全部记录可跨页恢复，热记录有界', async () => {
  for (let i = 0; i < 2000; i++) await storage.addRecord(record(i))
  expect(storage.getAllRecords().length).toBeLessThanOrEqual(DOWNLOAD_HISTORY_HOT_LIMIT)
  await storage.flush()
  expect(state.writes).toBeLessThanOrEqual(3)
  expect(state.bytes).toBeLessThan(2 * 1024 * 1024)
  const restored = new DownloadHistoryStorage(); await restored.init()
  const ids: string[] = []
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await restored.getPage(undefined, offset)
    expect(page.records.length).toBeLessThanOrEqual(100)
    ids.push(...page.records.map(r => r.id))
    expect(page.hasMore).toBe(offset < 1900)
  }
  expect(ids).toEqual(Array.from({ length: 2000 }, (_, i) => String(1999 - i)))
})

it('旧版 2100 条迁移不删除任何记录、不改原文件；归档记录 MD5 可更新', async () => {
  const file = join(state.directory, 'data', 'download-history.json')
  const legacy = JSON.stringify(Array.from({ length: 2100 }, (_, i) => record(i)))
  await mkdir(join(state.directory, 'data'), { recursive: true }); await writeFile(file, legacy)
  storage = new DownloadHistoryStorage(); await storage.init()
  expect(await readFile(file, 'utf8')).toBe(legacy)
  expect(storage.getAllRecords()).toHaveLength(1000)
  await storage.updateRecordByTaskId('2099', { md5: 'verified' }); await storage.flush()
  const page = await storage.getPage(undefined, 2000)
  expect(page.records).toHaveLength(100)
  expect(page.records.at(-1)).toMatchObject({ id: '2099', md5: 'verified' })
  expect(page.hasMore).toBe(false)
})

it('筛选分页、归档删除和显式清空保持正确，不触碰下载文件', async () => {
  for (let i = 0; i < 1100; i++) await storage.addRecord(record(i))
  const page = await storage.getPage('a', 100, 10000)
  expect(page.records).toHaveLength(100)
  expect(page.records.every(r => r.sessionId === 'a')).toBe(true)
  expect(await storage.deleteRecord('1')).toBe(true)
  expect(await storage.deleteRecord('missing')).toBe(false)
  await storage.clearAll()
  expect(await storage.getPage()).toEqual({ records: [], hasMore: false })
  const restored = new DownloadHistoryStorage(); await restored.init()
  expect(await restored.getPage()).toEqual({ records: [], hasMore: false })
})

it('原子替换失败保留已落盘版本，重试可恢复最新状态', async () => {
  await storage.addRecord(record(0)); await storage.flush()
  const manifest = join(state.directory, 'data', 'download-history-v2.json')
  const previous = await readFile(manifest, 'utf8')
  await storage.addRecord(record(1))
  state.failRename = true
  await expect(storage.flush()).rejects.toThrow('rename failed')
  expect(await readFile(manifest, 'utf8')).toBe(previous)
  await storage.flush()
  const restored = new DownloadHistoryStorage(); await restored.init()
  expect((await restored.getPage()).records.map(r => r.id)).toEqual(['1', '0'])
})

it('损坏历史隔离功能故障，启动继续且禁止用空库覆盖原文件', async () => {
  const manifest = join(state.directory, 'data', 'download-history-v2.json')
  await writeFile(manifest, 'corrupt fixture')
  const broken = new DownloadHistoryStorage()
  await broken.init()
  await expect(broken.getPage()).rejects.toThrow()
  await expect(broken.addRecord(record(1))).rejects.toThrow()
  expect(await readFile(manifest, 'utf8')).toBe('corrupt fixture')
})
