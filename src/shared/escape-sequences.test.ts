import { describe, it, expect } from 'vitest'
import {
  processInputEscapeSequences,
  appendAutoNewline,
  isPrintableTrailingChar
} from './escape-sequences'

describe('processInputEscapeSequences', () => {
  it('parses \\n as LF', () => {
    expect(processInputEscapeSequences('a\\nb')).toBe('a\nb')
  })

  it('parses \\r as CR', () => {
    expect(processInputEscapeSequences('a\\rb')).toBe('a\rb')
  })

  it('parses \\t as tab', () => {
    expect(processInputEscapeSequences('a\\tb')).toBe('a\tb')
  })

  it('parses uppercase and lowercase \\xHH sequences', () => {
    expect(processInputEscapeSequences('\\x03')).toBe('\x03') // Ctrl+C
    expect(processInputEscapeSequences('\\xAB')).toBe('\xAB')
    expect(processInputEscapeSequences('\\xab')).toBe('\xab')
    expect(processInputEscapeSequences('\\x1b')).toBe('\x1b') // ESC
  })

  it('leaves malformed \\x sequences untouched', () => {
    expect(processInputEscapeSequences('\\x')).toBe('\\x')
    expect(processInputEscapeSequences('\\x1')).toBe('\\x1')
    expect(processInputEscapeSequences('\\xZZ')).toBe('\\xZZ')
  })

  it('handles mixed sequences and leaves plain text intact', () => {
    const input = 'ls\\t-la\\nbash\\r\\x03done'
    const expected = 'ls\t-la\nbash\r\x03done'
    expect(processInputEscapeSequences(input)).toBe(expected)
  })

  it('returns empty string for empty input', () => {
    expect(processInputEscapeSequences('')).toBe('')
  })
})

describe('isPrintableTrailingChar', () => {
  it('treats space (0x20) and above (except DEL) as printable', () => {
    expect(isPrintableTrailingChar(0x20)).toBe(true) // space
    expect(isPrintableTrailingChar(0x41)).toBe(true) // 'A'
    expect(isPrintableTrailingChar(0x7e)).toBe(true) // '~'
    expect(isPrintableTrailingChar(0xff)).toBe(true) // high byte
  })

  it('treats C0 control chars (< 0x20) as non-printable', () => {
    expect(isPrintableTrailingChar(0x00)).toBe(false)
    expect(isPrintableTrailingChar(0x0a)).toBe(false) // \n
    expect(isPrintableTrailingChar(0x0d)).toBe(false) // \r
    expect(isPrintableTrailingChar(0x09)).toBe(false) // \t
    expect(isPrintableTrailingChar(0x03)).toBe(false) // Ctrl+C
    expect(isPrintableTrailingChar(0x1a)).toBe(false) // Ctrl+Z
    expect(isPrintableTrailingChar(0x1f)).toBe(false)
  })

  it('treats DEL (0x7f) as non-printable', () => {
    expect(isPrintableTrailingChar(0x7f)).toBe(false)
  })
})

describe('appendAutoNewline', () => {
  it('appends \\n when enabled and text ends in a printable char', () => {
    expect(appendAutoNewline('ls -la', true)).toBe('ls -la\n')
    expect(appendAutoNewline('vim', true)).toBe('vim\n')
  })

  it('does not append when disabled', () => {
    expect(appendAutoNewline('ls -la', false)).toBe('ls -la')
    // 即使末尾是可见字符，enabled=false 也不补
    expect(appendAutoNewline('vim', false)).toBe('vim')
  })

  it('does not append for empty text', () => {
    expect(appendAutoNewline('', true)).toBe('')
  })

  it('does not append when text already ends in \\n or \\r', () => {
    expect(appendAutoNewline('ls\n', true)).toBe('ls\n')
    expect(appendAutoNewline('ls\r', true)).toBe('ls\r')
  })

  it('does not append when text ends in a control sequence (Ctrl+C / Ctrl+Z / Tab / ESC)', () => {
    expect(appendAutoNewline('cmd\x03', true)).toBe('cmd\x03')
    expect(appendAutoNewline('cmd\x1a', true)).toBe('cmd\x1a')
    expect(appendAutoNewline('cmd\t', true)).toBe('cmd\t')
    expect(appendAutoNewline('cmd\x1b', true)).toBe('cmd\x1b') // ESC
  })

  it('does not append when text ends in DEL (0x7f)', () => {
    expect(appendAutoNewline('cmd\x7f', true)).toBe('cmd\x7f')
  })

  it('appends \\n when text ends in a space (0x20 counts as printable)', () => {
    expect(appendAutoNewline('ls ', true)).toBe('ls \n')
  })
})
