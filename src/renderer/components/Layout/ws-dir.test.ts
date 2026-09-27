import { describe, expect, it } from 'vitest'
import { normDirKey, wsDirLabel } from './ws-dir'

describe('normDirKey —— 目录组键归一化', () => {
  it('剥尾部分隔符:D:\\x 与 D:\\x\\ 同组', () => {
    expect(normDirKey('D:\\work\\x\\')).toBe('D:\\work\\x')
    expect(normDirKey('/home/u/x/')).toBe('/home/u/x')
    expect(normDirKey('D:\\work\\x')).toBe('D:\\work\\x')
  })
  it('根路径保留规范形,不吞成空串(合法工作目录,不并入「未指定目录」)', () => {
    expect(normDirKey('/')).toBe('/')
    expect(normDirKey('\\')).toBe('\\')
    expect(normDirKey('//')).toBe('/')
  })
  it('盘符根规范成 X:\\,与盘符相对路径 D: 分组(D: 指该盘当前目录,是另一个 cwd)', () => {
    expect(normDirKey('D:\\')).toBe('D:\\')
    expect(normDirKey('D:/')).toBe('D:\\')   // 正反斜杠尾的盘符根同组
    expect(normDirKey('D:')).toBe('D:')      // 无尾分隔符原样,不并入 D:\
    expect(normDirKey('C:\\')).toBe('C:\\')
  })
  it('未指定目录(空串)原样返回', () => {
    expect(normDirKey('')).toBe('')
  })
})

describe('wsDirLabel —— 组头题签取 basename', () => {
  it('取最后一段', () => {
    expect(wsDirLabel('D:\\work\\LyShell')).toBe('LyShell')
    expect(wsDirLabel('/home/u/LyShell')).toBe('LyShell')
  })
  it('盘符根/Unix 根没有段,回落原文', () => {
    expect(wsDirLabel('D:')).toBe('D:')
    expect(wsDirLabel('/')).toBe('/')
  })
})
