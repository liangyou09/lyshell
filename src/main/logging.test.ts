import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { win32 } from 'path'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => 'C:\\Apps\\LyShell\\LyShell.exe'),
    setAppLogsPath: vi.fn()
  },
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  log: {
    transports: {
      file: { level: 'silly', fileName: 'main.log', resolvePathFn: vi.fn() },
      console: { level: 'silly' }
    },
    warn: vi.fn()
  }
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('fs', () => ({
  mkdirSync: mocks.mkdirSync,
  openSync: mocks.openSync,
  closeSync: mocks.closeSync
}))
// 在非 Windows CI 上也按 Windows 的目录语义验收。
vi.mock('path', async () => {
  const { win32: paths } = await vi.importActual<typeof import('path')>('path')
  return { win32: paths, dirname: paths.dirname, isAbsolute: paths.isAbsolute, join: paths.join }
})
vi.mock('electron-log', () => ({ default: mocks.log }))

describe('Windows 应用日志目录', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '')
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
    mocks.app.isPackaged = true
    mocks.mkdirSync.mockReset()
    mocks.openSync.mockReset().mockReturnValue(42)
    mocks.log.transports.file.resolvePathFn = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('安装版和解压版写到 EXE 旁的 logs，而不是当前工作目录', async () => {
    await import('./logging')
    const dir = 'C:\\Apps\\LyShell\\logs'
    expect(mocks.app.getPath).toHaveBeenCalledWith('exe')
    expect(mocks.app.setAppLogsPath).toHaveBeenCalledWith(dir)
    expect(mocks.openSync).toHaveBeenCalledWith(win32.join(dir, 'main.log'), 'a')
    expect(mocks.closeSync).toHaveBeenCalledWith(42)
    expect(mocks.log.transports.file.resolvePathFn({ fileName: 'main.log' }))
      .toBe(win32.join(dir, 'main.log'))
  })

  it('便携版写到原始便携 EXE 所在目录，不写临时解压目录', async () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\便携工具\\LyShell')
    await import('./logging')
    expect(mocks.app.getPath).not.toHaveBeenCalled()
    expect(mocks.app.setAppLogsPath).toHaveBeenCalledWith('D:\\便携工具\\LyShell\\logs')
  })

  it('忽略相对便携目录，避免日志受启动工作目录影响', async () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'relative-directory')
    await import('./logging')
    expect(mocks.app.setAppLogsPath).toHaveBeenCalledWith('C:\\Apps\\LyShell\\logs')
  })

  it.each(['mkdir', 'open'] as const)('目录或文件不可写时保留默认日志（%s）', async (failure) => {
    const defaultResolver = mocks.log.transports.file.resolvePathFn
    const operation = failure === 'mkdir' ? mocks.mkdirSync : mocks.openSync
    operation.mockImplementationOnce(() => { throw new Error('EACCES') })
    await import('./logging')
    expect(mocks.app.setAppLogsPath).not.toHaveBeenCalled()
    expect(mocks.log.transports.file.resolvePathFn).toBe(defaultResolver)
    expect(mocks.log.warn).toHaveBeenCalled()
  })

  it('开发模式保留默认目录，即使继承了便携环境变量', async () => {
    mocks.app.isPackaged = false
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Portable')
    await import('./logging')
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
    expect(mocks.app.setAppLogsPath).not.toHaveBeenCalled()
    expect(mocks.log.transports.file.level).toBe('info')
    expect(mocks.log.transports.console.level).toBe('debug')
  })

  it('非 Windows 打包版保留平台默认日志位置', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
    await import('./logging')
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
    expect(mocks.app.setAppLogsPath).not.toHaveBeenCalled()
  })
})
