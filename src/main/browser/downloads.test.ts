import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { validateBrowserRequest } from '../ipc/validation'

const mocks = vi.hoisted(() => ({ directory: '', session: null as unknown as EventEmitter, send: vi.fn(), reveal: vi.fn(), open: vi.fn(), icon: vi.fn() }))
vi.mock('electron', () => ({
  app: { getFileIcon: mocks.icon },
  session: { fromPartition: () => mocks.session },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } }] },
  shell: { showItemInFolder: mocks.reveal, openPath: mocks.open }
}))
vi.mock('../storage/download-history', () => ({ downloadHistory: { getConfig: () => ({ defaultDir: mocks.directory }) } }))

function download(name = 'report.zip', total = 1024) {
  const item = Object.assign(new EventEmitter(), {
    getFilename: () => name, getTotalBytes: () => total,
    getReceivedBytes: vi.fn(() => 0), setSavePath: vi.fn(),
    cancel: vi.fn(() => { item.emit('done', {}, 'cancelled') })
  })
  mocks.session.emit('will-download', {}, item)
  return item
}
let directory: string
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'lyshell-browser-downloads-'))
  mocks.directory = directory; mocks.session = new EventEmitter(); mocks.open.mockResolvedValue('')
  mocks.icon.mockResolvedValue({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,fixture' })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }) })

describe('浏览器下载管理', () => {
  it('只安装一次；推送真实字节、未知总大小及完成后的实际路径', async () => {
    const service = await import('./downloads')
    service.initializeBrowserDownloads(); service.initializeBrowserDownloads()
    expect(mocks.session.listenerCount('will-download')).toBe(1)
    const item = download('report.zip', 0)
    expect(item.setSavePath).toHaveBeenCalledWith(join(directory, 'report.zip'))
    expect(mocks.send.mock.lastCall?.[1].notice).toMatchObject({ kind: 'started' })
    item.getReceivedBytes.mockReturnValue(512)
    item.emit('updated', {}, 'progressing')
    vi.advanceTimersByTime(200)
    expect(mocks.send.mock.lastCall?.[1].downloads[0]).toMatchObject({ receivedBytes: 512, totalBytes: 0, active: true })
    expect(mocks.send.mock.lastCall?.[1].notice).toBeUndefined()
    item.emit('done', {}, 'completed')
    expect(mocks.send.mock.lastCall?.[1].notice).toMatchObject({ kind: 'completed' })
    expect(service.getBrowserDownloads().downloads[0]).toMatchObject({ state: 'completed', active: false, receivedBytes: 512, savePath: join(directory, 'report.zip') })
    expect(mocks.icon).toHaveBeenCalledWith(join(directory, 'report.zip'), { size: 'normal' })
    await vi.waitFor(() => expect(service.getBrowserDownloads().downloads[0].iconDataUrl).toBe('data:image/png;base64,fixture'))
    expect(mocks.send.mock.lastCall?.[1].notice).toBeUndefined()
  })
  it('同名已有文件和并行下载均加序号，文件名不能穿越目录', async () => {
    const service = await import('./downloads'); service.initializeBrowserDownloads()
    writeFileSync(join(directory, 'report.zip'), 'keep')
    const first = download('../report.zip')
    const second = download('..\\report.zip')
    expect(first.setSavePath).toHaveBeenCalledWith(join(directory, 'report (1).zip'))
    expect(second.setSavePath).toHaveBeenCalledWith(join(directory, 'report (2).zip'))
    expect(readFileSync(join(directory, 'report.zip'), 'utf8')).toBe('keep')
    const device = download('CON.txt')
    expect(basename(device.setSavePath.mock.calls[0][0])).toBe('_CON.txt')
  })
  it('取消目标下载，定位只允许已完成且仍存在的记录', async () => {
    const service = await import('./downloads'); service.initializeBrowserDownloads()
    const item = download()
    const id = service.getBrowserDownloads().downloads[0].id
    expect(service.browserDownloadAction('C:/arbitrary.exe', 'reveal')).toBe(false)
    expect(service.browserDownloadAction(id, 'reveal')).toBe(false)
    expect(service.browserDownloadAction(id, 'cancel')).toBe(true)
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(service.getBrowserDownloads().downloads[0]).toMatchObject({ state: 'cancelled', active: false })
    const completed = download('done.txt'); writeFileSync(join(directory, 'done.txt'), 'done'); completed.emit('done', {}, 'completed')
    expect(service.browserDownloadAction(service.getBrowserDownloads().downloads[0].id, 'reveal')).toBe(true)
    expect(mocks.reveal).toHaveBeenCalledWith(join(directory, 'done.txt'))
  })
  it('中途 interrupted 仍可取消；done interrupted 才是终态', async () => {
    const service = await import('./downloads'); service.initializeBrowserDownloads()
    const item = download(); item.emit('updated', {}, 'interrupted')
    expect(service.getBrowserDownloads().downloads[0]).toMatchObject({ state: 'interrupted', active: true })
    item.emit('done', {}, 'interrupted')
    expect(service.getBrowserDownloads().downloads[0]).toMatchObject({ state: 'interrupted', active: false })
  })
  it('目录不可写时取消下载并显示失败；后续下载读取最新配置', async () => {
    const service = await import('./downloads'); service.initializeBrowserDownloads()
    mocks.directory = join(directory, 'file'); writeFileSync(mocks.directory, 'not a directory')
    const failed = download()
    expect(failed.cancel).toHaveBeenCalledOnce()
    expect(service.getBrowserDownloads().downloads[0]).toMatchObject({ state: 'interrupted', active: false })
    mocks.directory = join(directory, 'new')
    service.notifyBrowserDownloadDirectoryChanged()
    expect(mocks.send.mock.lastCall?.[1].downloadDirectory).toBe(mocks.directory)
    const next = download()
    expect(next.setSavePath).toHaveBeenCalledWith(join(mocks.directory, 'report.zip'))
    expect(await service.openBrowserDownloadDirectory()).toBe(true)
    expect(mocks.open).toHaveBeenCalledWith(mocks.directory)
  })
  it('IPC 只接收登记 ID 与允许的动作，拒绝任意动作和无效 ID', () => {
    expect(validateBrowserRequest({ kind: 'downloadAction', id: 'known-id', action: 'cancel', path: 'arbitrary' })).toEqual({ kind: 'downloadAction', id: 'known-id', action: 'cancel' })
    for (const patch of [{ action: 'execute' }, { id: '' }, { id: 3 }, { id: 'x'.repeat(129) }]) {
      expect(() => validateBrowserRequest({ kind: 'downloadAction', id: 'known-id', action: 'reveal', ...patch })).toThrow()
    }
  })
  it('结束记录保持有界，同时不删除活动任务', async () => {
    const service = await import('./downloads'); service.initializeBrowserDownloads()
    download('active.zip')
    const activeId = service.getBrowserDownloads().downloads[0].id
    for (let index = 0; index < 105; index++) download(`done-${index}.zip`).emit('done', {}, 'completed')
    expect(service.getBrowserDownloads().downloads).toHaveLength(101)
    expect(service.getBrowserDownloads().downloads.find(item => item.id === activeId)?.active).toBe(true)
    expect(service.browserDownloadAction(activeId, 'cancel')).toBe(true)
    expect(service.getBrowserDownloads().downloads).toHaveLength(100)
  })
  it('打开只接受已完成的登记文件，系统打开失败会返回失败', async () => {
    const service = await import('./downloads'); service.initializeBrowserDownloads()
    const item = download('report.pdf')
    const id = service.getBrowserDownloads().downloads[0].id
    expect(await service.browserDownloadAction(id, 'open')).toBe(false)
    expect(await service.browserDownloadAction('C:/arbitrary.exe', 'open')).toBe(false)
    expect(mocks.open).not.toHaveBeenCalled()
    writeFileSync(join(directory, 'report.pdf'), 'fixture'); item.emit('done', {}, 'completed')
    expect(await service.browserDownloadAction(id, 'open')).toBe(true)
    expect(mocks.open).toHaveBeenCalledWith(join(directory, 'report.pdf'))
    mocks.open.mockResolvedValueOnce('No application associated')
    expect(await service.browserDownloadAction(id, 'open')).toBe(false)
  })
  it('移除记录保留磁盘文件，并拒绝移除活动任务', async () => {
    const service = await import('./downloads'); service.initializeBrowserDownloads()
    const item = download('keep.txt')
    const id = service.getBrowserDownloads().downloads[0].id
    expect(service.browserDownloadAction(id, 'remove')).toBe(false)
    writeFileSync(join(directory, 'keep.txt'), 'keep'); item.emit('done', {}, 'completed')
    expect(service.browserDownloadAction(id, 'remove')).toBe(true)
    expect(service.getBrowserDownloads().downloads).toHaveLength(0)
    expect(readFileSync(join(directory, 'keep.txt'), 'utf8')).toBe('keep')
    expect(service.browserDownloadAction(id, 'open')).toBe(false)
  })
})
