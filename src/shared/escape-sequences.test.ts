import { describe, it, expect } from 'vitest'
import { processInputEscapeSequences } from './escape-sequences'

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
