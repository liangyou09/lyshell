import { describe, expect, it, vi } from 'vitest'
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
import { assertBrowserLaunchConsumer, validateBrowserRequest } from './validation'

describe('默认浏览器 IPC 边界', () => {
  it('主窗口主框架可以认领，guest、子框架和未创建窗口拒绝', () => {
    expect(() => assertBrowserLaunchConsumer(12, 12, true)).not.toThrow()
    for (const [sender, consumer, mainFrame] of [[14, 12, true], [12, 12, false], [12, null, true]] as const) {
      expect(() => assertBrowserLaunchConsumer(sender, consumer, mainFrame)).toThrow()
    }
  })
  it('注册和状态操作不接受 renderer 指定命令、路径或设置 URL', () => {
    for (const kind of ['defaultBrowserStatus', 'requestDefaultBrowser']) {
      expect(validateBrowserRequest({ kind, command: 'evil', execPath: 'C:/evil.exe', url: 'https://evil.test' })).toEqual({ kind })
    }
    expect(() => validateBrowserRequest({ kind: 'registerProtocol', protocol: 'file' })).toThrow()
  })
})
