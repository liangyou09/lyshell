import { describe, it, expect } from 'vitest'
import { parsePathJson, combinePathParts } from './refresh'

describe('parsePathJson', () => {
  it('解析正常 JSON 对象', () => {
    expect(parsePathJson('{"user":"u","machine":"m"}')).toEqual({ user: 'u', machine: 'm' })
  })

  it('解析含反斜杠的 Windows 路径', () => {
    const json = JSON.stringify({ user: 'C:\\Users\\a\\bin', machine: 'C:\\Windows' })
    expect(parsePathJson(json)).toEqual({ user: 'C:\\Users\\a\\bin', machine: 'C:\\Windows' })
  })

  it('容忍首尾空白', () => {
    expect(parsePathJson('\n{"user":"u","machine":"m"}\r\n')).toEqual({ user: 'u', machine: 'm' })
  })

  it('非字符串值回落空串', () => {
    expect(parsePathJson('{"user":null,"machine":42}')).toEqual({ user: '', machine: '' })
  })

  it('缺失键回落空串', () => {
    expect(parsePathJson('{"user":"u"}')).toEqual({ user: 'u', machine: '' })
  })

  it('非法 JSON 返回 null', () => {
    expect(parsePathJson('not json')).toBeNull()
  })

  it('非对象（数组/标量/null）返回 null', () => {
    expect(parsePathJson('[1,2]')).toBeNull()
    expect(parsePathJson('123')).toBeNull()
    expect(parsePathJson('null')).toBeNull()
  })
})

describe('combinePathParts', () => {
  it('用户级在前、系统级在后，`;` 分隔', () => {
    expect(combinePathParts('C:\\Users\\a', 'C:\\Windows')).toBe('C:\\Users\\a;C:\\Windows')
  })

  it('用户级为空只保留系统级', () => {
    expect(combinePathParts('', 'C:\\Windows')).toBe('C:\\Windows')
  })

  it('系统级为空只保留用户级', () => {
    expect(combinePathParts('C:\\Users\\a', '')).toBe('C:\\Users\\a')
  })

  it('两侧空白会被裁剪', () => {
    expect(combinePathParts('  C:\\a  ', '  ')).toBe('C:\\a')
  })

  it('都为空白返回 null', () => {
    expect(combinePathParts('', '')).toBeNull()
    expect(combinePathParts('  ', '\t')).toBeNull()
  })
})
