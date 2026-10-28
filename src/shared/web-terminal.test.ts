import { describe, expect, it } from 'vitest'
import {
  WEB_TERMINAL_CHANNEL,
  WEB_TERMINAL_MAX_TEXT,
  parseWebTerminalRequest
} from './web-terminal'

const BINDING = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe('网页终端共享契约', () => {
  it('通道名与文本上限是稳定常量', () => {
    expect(WEB_TERMINAL_CHANNEL).toBe('web-tab:terminal')
    expect(WEB_TERMINAL_MAX_TEXT).toBe(16384)
  })

  it('接受四种合法请求并只保留白名单字段', () => {
    expect(parseWebTerminalRequest({ kind: 'bind', pageId: 7 })).toEqual({ kind: 'bind', pageId: 7 })
    expect(parseWebTerminalRequest({ kind: 'discover', pageId: 7 })).toEqual({ kind: 'discover', pageId: 7 })
    expect(parseWebTerminalRequest({ kind: 'send', pageId: 7, bindingId: BINDING, text: 'ls -la\r\nexit\n', enter: true }))
      .toEqual({ kind: 'send', pageId: 7, bindingId: BINDING, text: 'ls -la\r\nexit\n', enter: true })
    expect(parseWebTerminalRequest({ kind: 'release', pageId: 7, bindingId: BINDING }))
      .toEqual({ kind: 'release', pageId: 7, bindingId: BINDING })
  })

  it('discover 只接受 kind/pageId 两个字段', () => {
    const discover = (raw: unknown) => parseWebTerminalRequest(raw)
    expect(discover({ kind: 'discover', pageId: 1 })).toEqual({ kind: 'discover', pageId: 1 })
    expect(discover({ kind: 'discover', pageId: 1, bindingId: BINDING })).toBeNull()
    expect(discover({ kind: 'discover', pageId: 1, text: 'ls' })).toBeNull()
    expect(discover({ kind: 'discover', pageId: 1, enter: true })).toBeNull()
    expect(discover({ kind: 'discover' })).toBeNull()
    for (const pageId of [0, -1, 1.5, Number.NaN, '1', null, undefined]) {
      expect(discover({ kind: 'discover', pageId }), String(pageId)).toBeNull()
    }
  })

  it('归一化结果与输入解耦，且二次解析保持稳定', () => {
    const raw = { kind: 'send', pageId: 3, bindingId: BINDING, text: 'whoami', enter: false }
    const parsed = parseWebTerminalRequest(raw)
    expect(parsed).not.toBe(raw)
    expect(parsed).toEqual(raw)
    expect(parseWebTerminalRequest(parsed)).toEqual(parsed)
  })

  it('允许空文本，但只在与回车同现时成立', () => {
    expect(parseWebTerminalRequest({ kind: 'send', pageId: 1, bindingId: BINDING, text: '', enter: true }))
      .toEqual({ kind: 'send', pageId: 1, bindingId: BINDING, text: '', enter: true })
    expect(parseWebTerminalRequest({ kind: 'send', pageId: 1, bindingId: BINDING, text: '', enter: false })).toBeNull()
  })

  it('只允许 tab/换行/回车，拒绝其余控制字符', () => {
    const send = (text: string) =>
      parseWebTerminalRequest({ kind: 'send', pageId: 1, bindingId: BINDING, text, enter: false })
    expect(send('a\tb\nc\rd')).not.toBeNull()
    for (const text of ['\x00', 'a\x1bb', '\x0b', '\x0c', '\x7f', '\u009b', 'rm -rf /\x04']) {
      expect(send(text), JSON.stringify(text)).toBeNull()
    }
  })

  it('拒绝不成对的代理项，接受合法代理对', () => {
    const send = (text: string) =>
      parseWebTerminalRequest({ kind: 'send', pageId: 1, bindingId: BINDING, text, enter: false })
    expect(send('echo \u{1f600}')).not.toBeNull()
    expect(send('\ud83d')).toBeNull()
    expect(send('\ude00')).toBeNull()
    expect(send('a\ud83db')).toBeNull()
  })

  it('拒绝超长文本，边界长度可用', () => {
    const send = (text: string) =>
      parseWebTerminalRequest({ kind: 'send', pageId: 1, bindingId: BINDING, text, enter: true })
    expect(send('a'.repeat(WEB_TERMINAL_MAX_TEXT))).not.toBeNull()
    expect(send('a'.repeat(WEB_TERMINAL_MAX_TEXT + 1))).toBeNull()
  })

  it('拒绝非对象、未知 kind 和多余字段', () => {
    expect(parseWebTerminalRequest(null)).toBeNull()
    expect(parseWebTerminalRequest(undefined)).toBeNull()
    expect(parseWebTerminalRequest('bind')).toBeNull()
    expect(parseWebTerminalRequest(42)).toBeNull()
    expect(parseWebTerminalRequest([])).toBeNull()
    expect(parseWebTerminalRequest([{ kind: 'bind', pageId: 1 }])).toBeNull()
    expect(parseWebTerminalRequest({})).toBeNull()
    expect(parseWebTerminalRequest({ kind: 'terminal', pageId: 1 })).toBeNull()
    expect(parseWebTerminalRequest({ kind: 'bind', pageId: 1, text: 'ls' })).toBeNull()
    expect(parseWebTerminalRequest({ kind: 'bind', pageId: 1, bindingId: BINDING })).toBeNull()
    expect(parseWebTerminalRequest({ kind: 'release', pageId: 1, bindingId: BINDING, text: 'ls' })).toBeNull()
    expect(parseWebTerminalRequest({ kind: 'send', pageId: 1, bindingId: BINDING, text: 'ls', enter: true, extra: 1 })).toBeNull()
  })

  it('pageId 必须是正的安全整数', () => {
    for (const pageId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', null, undefined, true]) {
      expect(parseWebTerminalRequest({ kind: 'bind', pageId }), String(pageId)).toBeNull()
    }
    expect(parseWebTerminalRequest({ kind: 'bind', pageId: Number.MAX_SAFE_INTEGER })).not.toBeNull()
  })

  it('bindingId 必须是随机 UUID v4', () => {
    const release = (bindingId: unknown) => parseWebTerminalRequest({ kind: 'release', pageId: 1, bindingId })
    expect(release(BINDING)).not.toBeNull()
    expect(release('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeNull()
    expect(release('3f2504e0-4f89-41d3-7a0c-0305e82c3301')).toBeNull()
    expect(release(BINDING.toUpperCase())).toBeNull()
    expect(release('3f2504e04f8941d39a0c0305e82c3301')).toBeNull()
    expect(release(`${BINDING}0`)).toBeNull()
    expect(release('')).toBeNull()
    expect(release(null)).toBeNull()
  })

  it('send 的字段类型必须严格匹配', () => {
    const base = { kind: 'send', pageId: 1, bindingId: BINDING, text: 'ls', enter: false }
    expect(parseWebTerminalRequest({ ...base, text: 1 })).toBeNull()
    expect(parseWebTerminalRequest({ ...base, text: null })).toBeNull()
    expect(parseWebTerminalRequest({ ...base, enter: 1 })).toBeNull()
    expect(parseWebTerminalRequest({ ...base, enter: 'true' })).toBeNull()
    expect(parseWebTerminalRequest({ ...base, enter: undefined })).toBeNull()
    expect(parseWebTerminalRequest({ ...base, bindingId: BINDING.toUpperCase() })).toBeNull()
  })
})
