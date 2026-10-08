import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { captureExplorerWindow, explorerDirectoryScript, readActiveExplorerDirectory } from './explorer-directory'

const native = vi.hoisted(() => ({
  foreground: vi.fn(), className: vi.fn(), findChild: vi.fn(), visible: vi.fn()
}))
vi.mock('koffi', () => ({
  default: { load: () => ({ func: (signature: string) => {
    if (signature.includes('GetForegroundWindow')) return native.foreground
    if (signature.includes('GetClassNameW')) return native.className
    if (signature.includes('FindWindowExW')) return native.findChild
    return native.visible
  } }) }
}))
vi.mock('child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))

beforeEach(() => {
  vi.resetAllMocks()
  native.foreground.mockReturnValue(123)
  native.className.mockImplementation((_window: number, buffer: Buffer) => {
    buffer.write('CabinetWClass', 'utf16le')
    return 'CabinetWClass'.length
  })
  native.findChild.mockReturnValue(0)
})

describe('captureExplorerWindow', () => {
  it.skipIf(process.platform !== 'win32')('前台 Explorer 没有页签时保留窗口句柄', () => {
    expect(captureExplorerWindow()).toEqual({ window: 123, tab: 0 })
  })

  it.skipIf(process.platform !== 'win32')('只选择可见页签，跳过同一窗口的非活动页签', () => {
    native.findChild.mockReturnValueOnce(456).mockReturnValueOnce(789)
    native.visible.mockReturnValueOnce(0).mockReturnValueOnce(1)
    expect(captureExplorerWindow()).toEqual({ window: 123, tab: 789 })
    expect(native.findChild.mock.calls[1][1]).toBe(456)
  })

  it.skipIf(process.platform !== 'win32')('启动来源不是 Explorer 时不猜目录、不起子进程', () => {
    native.className.mockImplementation((_window: number, buffer: Buffer) => {
      buffer.write('Chrome_WidgetWin_1', 'utf16le')
      return 'Chrome_WidgetWin_1'.length
    })
    expect(readActiveExplorerDirectory()).toBeNull()
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

describe('readActiveExplorerDirectory', () => {
  it.skipIf(process.platform !== 'win32')('接收真实目录并隐藏辅助 PowerShell 窗口', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(process.cwd()))
    expect(readActiveExplorerDirectory()).toBe(process.cwd())
    expect(execFileSync).toHaveBeenCalledWith(expect.stringMatching(/powershell.exe$/),
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']),
      expect.objectContaining({ windowsHide: true, timeout: 5000 }))
  })

  it.skipIf(process.platform !== 'win32')('超时或 COM 查询失败时回落，不阻止 LyShell 启动', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('timeout') })
    expect(readActiveExplorerDirectory()).toBeNull()
  })

  it.skipIf(process.platform !== 'win32')('虚拟文件夹与有歧义的结果不当作目录', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify('::{virtual-folder}'))
    expect(readActiveExplorerDirectory()).toBeNull()
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(['D:\\first', 'D:\\second']))
    expect(readActiveExplorerDirectory()).toBeNull()
  })
})

describe('explorerDirectoryScript', () => {
  it.each([-1, NaN, Infinity, 1.5])('拒绝无效句柄 %s，避免将不可信值插进脚本', value => {
    expect(() => explorerDirectoryScript({ window: value, tab: 0 })).toThrow('Invalid')
    expect(() => explorerDirectoryScript({ window: 123, tab: value })).toThrow('Invalid')
  })
})
