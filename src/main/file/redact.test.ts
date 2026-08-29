import { describe, it, expect } from 'vitest'
import { redactSecrets } from './redact'

// 这些测试锁定日志脱敏：worker shell/exec 原始 stdout 行可能含一次性握手 token，
// 经 log() 闸口脱敏后不得残留任何 hex，防止 electron-log 明文落盘。

describe('redactSecrets', () => {
  it('脱敏 ===LYSHELL_TOKEN:<hex>=== 中的 token', () => {
    const line = 'Shell: ===LYSHELL_TOKEN:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789==='
    const redacted = redactSecrets(line)
    expect(redacted).not.toContain('abcdef0123456789')
    expect(redacted).toContain('===LYSHELL_TOKEN:***REDACTED***===')
    // 保留 Shell: 前缀等非敏感上下文
    expect(redacted).toContain('Shell:')
  })

  it('不含 token 的普通日志行原样返回', () => {
    const line = 'Python TCP Server port: 12345'
    expect(redactSecrets(line)).toBe(line)
  })

  it('一行中多次出现 token 全部脱敏', () => {
    const line = '===LYSHELL_TOKEN:aaaa=== ===LYSHELL_TOKEN:bbbb==='
    expect(redactSecrets(line)).toBe('===LYSHELL_TOKEN:***REDACTED***=== ===LYSHELL_TOKEN:***REDACTED***===')
  })

  it('大小写 hex 均脱敏', () => {
    const line = '===LYSHELL_TOKEN:ABCDEF0123456789==='
    expect(redactSecrets(line)).not.toContain('ABCDEF0123456789')
  })

  it('空字符串原样返回', () => {
    expect(redactSecrets('')).toBe('')
  })
})
