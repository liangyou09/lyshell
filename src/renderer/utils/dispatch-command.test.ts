import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dispatchCommand } from './dispatch-command'
import type { QuickCommand } from '@shared/types'

/**
 * dispatchCommand 唯一可测点：拆行 → 转义解析/trim → 空行跳过 → 逐行 \r 结尾写入。
 * 副作用仅 window.electronAPI.terminalWrite，stub 掉后即近纯函数。
 */

const terminalWrite = vi.fn()

const makeCommand = (overrides: Partial<QuickCommand> = {}): QuickCommand => ({
  id: 'cmd-test',
  name: 'test',
  content: '',
  ...overrides
})

beforeEach(() => {
  terminalWrite.mockReset()
  vi.stubGlobal('window', { electronAPI: { terminalWrite } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dispatchCommand', () => {
  it('单行命令：trim 后以 \\r 结尾写入一次', () => {
    dispatchCommand(makeCommand({ content: '  ls -la  ' }), 'session-1')
    expect(terminalWrite).toHaveBeenCalledTimes(1)
    expect(terminalWrite).toHaveBeenCalledWith('session-1', 'ls -la\r')
  })

  it('多行命令：按 \\n 拆行逐行写入，顺序保持', () => {
    dispatchCommand(makeCommand({ content: 'cd /var\nls\npwd' }), 'session-1')
    expect(terminalWrite).toHaveBeenCalledTimes(3)
    expect(terminalWrite).toHaveBeenNthCalledWith(1, 'session-1', 'cd /var\r')
    expect(terminalWrite).toHaveBeenNthCalledWith(2, 'session-1', 'ls\r')
    expect(terminalWrite).toHaveBeenNthCalledWith(3, 'session-1', 'pwd\r')
  })

  it('空行与纯空白行跳过（trim 后为空不发送）', () => {
    dispatchCommand(makeCommand({ content: 'a\n\n   \nb' }), 'session-1')
    expect(terminalWrite).toHaveBeenCalledTimes(2)
    expect(terminalWrite).toHaveBeenNthCalledWith(1, 'session-1', 'a\r')
    expect(terminalWrite).toHaveBeenNthCalledWith(2, 'session-1', 'b\r')
  })

  it('escapeSequences=true：逐行解析 \\t \\xHH 转义序列（拆行用真实 \\n，转义在后）', () => {
    dispatchCommand(
      makeCommand({ content: 'echo\\t"hi"\n\\x03', escapeSequences: true }),
      'session-1'
    )
    expect(terminalWrite).toHaveBeenCalledTimes(2)
    expect(terminalWrite).toHaveBeenNthCalledWith(1, 'session-1', 'echo\t"hi"\r')
    expect(terminalWrite).toHaveBeenNthCalledWith(2, 'session-1', '\x03\r')
  })

  it('escapeSequences=true：行内字面 \\n 转义为真实 LF，并入同一次写入（不拆行）', () => {
    dispatchCommand(
      makeCommand({ content: 'a\\nb', escapeSequences: true }),
      'session-1'
    )
    expect(terminalWrite).toHaveBeenCalledTimes(1)
    expect(terminalWrite).toHaveBeenCalledWith('session-1', 'a\nb\r')
  })

  it('escapeSequences=false：字面反斜杠原样发送，不做转义解析', () => {
    dispatchCommand(makeCommand({ content: 'echo \\n literal' }), 'session-1')
    expect(terminalWrite).toHaveBeenCalledWith('session-1', 'echo \\n literal\r')
  })

  it('空 content：不产生任何写入', () => {
    dispatchCommand(makeCommand({ content: '' }), 'session-1')
    expect(terminalWrite).not.toHaveBeenCalled()
  })

  it('electronAPI 缺失（无宿主）：静默不抛', () => {
    vi.stubGlobal('window', {})
    expect(() =>
      dispatchCommand(makeCommand({ content: 'ls' }), 'session-1')
    ).not.toThrow()
  })
})
