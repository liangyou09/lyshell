import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as Xterm } from '@xterm/xterm'
import { formatSshHistoryForTerminal } from './shelf-ssh-context'
import { TerminalOutputDispatcher } from './output-dispatcher'

let terminal: Xterm | undefined
afterEach(() => { terminal?.dispose(); terminal = undefined; vi.unstubAllGlobals() })

function makeTerminal(): Xterm {
  // 使用真实 xterm 解析器和缓冲，不创建 DOM、窗口或图形验收环境。
  vi.stubGlobal('self', globalThis)
  const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm')
  terminal = new Terminal({ cols: 100, rows: 24 })
  return terminal
}
const write = (term: Xterm, text: string): Promise<void> => new Promise(resolve => term.write(text, resolve))
const lines = (term: Xterm): string[] => Array.from({ length: term.buffer.active.length }, (_, index) => term.buffer.active.getLine(index)!.translateToString(true))

describe('SSH 历史实际进入 xterm 显示缓冲', () => {
  it('历史在新连接提示符前显示，换行从行首开始，不出现阶梯错位', async () => {
    const term = makeTerminal()
    term.resize(146, 37)
    const input = vi.fn()
    term.onData(input)
    await write(term, 'old disconnected screen')
    await write(term, formatSshHistoryForTerminal('saved command result\nsecond history line')!)
    await write(term, 'new login prompt> ')
    const rendered = lines(term)
    expect(rendered[0]).toContain('本机保存的 SSH 历史')
    expect(rendered[1]).toBe('saved command result')
    expect(rendered[2]).toBe('second history line')
    expect(rendered[3]).toContain('以下为本次新连接输出')
    expect(rendered[4]).toBe('new login prompt> ')
    expect(rendered.join('\n')).not.toContain('old disconnected screen')
    expect(input).not.toHaveBeenCalled()
    expect([term.cols, term.rows]).toEqual([146, 37])
  })
  it.each(['before-connect', 'after-connect'])('真实输出订阅与 xterm 显示历史一次；订阅时机=%s', async timing => {
    const term = makeTerminal()
    const dispatcher = new TerminalOutputDispatcher(() => {})
    const history = formatSshHistoryForTerminal('restored result')!
    const live = 'live ssh prompt> '
    dispatcher.subscribe(1, 'ssh', (data, receipt) => {
      term.write(data, () => dispatcher.acknowledge(1, 'ssh', receipt.subscriptionId, receipt.sequence))
    }, timing === 'after-connect' ? history + live : '')
    try {
      if (timing === 'before-connect') { dispatcher.append('ssh', history); dispatcher.append('ssh', live) }
      await vi.waitFor(() => expect(lines(term).join('\n')).toContain(live))
      const rendered = lines(term).join('\n')
      expect(rendered.match(/restored result/g)).toHaveLength(1)
      expect(rendered.indexOf('restored result')).toBeLessThan(rendered.indexOf('live ssh prompt'))
    } finally { dispatcher.removeWindow(1) }
  })
  it('旧输出的清屏、标题与 OSC 控制不生效，只还原可读文本', async () => {
    const term = makeTerminal(), title = vi.fn()
    term.onTitleChange(title)
    const history = 'visible\x1b[2J\x1b]0;old-title\x07\ntext\x1b]52;c;secret\x07'
    await write(term, formatSshHistoryForTerminal(history)!)
    const rendered = lines(term).join('\n')
    expect(rendered).toContain('visible')
    expect(rendered).toContain('text')
    expect(rendered).not.toContain('old-title')
    expect(rendered).not.toContain('secret')
    expect(title).not.toHaveBeenCalled()
  })
  it('没有可读历史时不生成复位或空历史画面', () => {
    expect(formatSshHistoryForTerminal('')).toBeUndefined()
    expect(formatSshHistoryForTerminal('\x1b[2J')).toBeUndefined()
  })
})
