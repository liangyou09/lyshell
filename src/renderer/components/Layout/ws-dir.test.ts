import { describe, expect, it } from 'vitest'
import { normDirKey, wsDirDetail, wsDirLabel } from './ws-dir'

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

describe('wsDirDetail —— 同名目录的可辨识父路径', () => {
  it('不同父目录下同名时，显示最近的区分段', () => {
    const dirs = ['C:\\Users\\alice\\project', 'C:\\Users\\bob\\project']
    expect(wsDirDetail(dirs[0], dirs)).toEqual({ detail: 'alice', detailMarker: '#1' })
    expect(wsDirDetail(dirs[1], dirs)).toEqual({ detail: 'bob', detailMarker: '#2' })
  })
  it('最近父目录也相同时，向上增加片段直到唯一', () => {
    const dirs = ['/work/one/shared/project', '/work/two/shared/project']
    expect(wsDirDetail(dirs[0], dirs)).toEqual({ detail: 'one', detailMarker: '#1' })
    expect(wsDirDetail(dirs[1], dirs)).toEqual({ detail: 'two', detailMarker: '#2' })
  })
  it('长公共前缀不会掩盖末尾差异，序号留在可见开头', () => {
    const dirs = ['/team-platform-east/project', '/team-platform-west/project']
    expect(wsDirDetail(dirs[0], dirs)).toEqual({ detail: 'east', detailMarker: '#1' })
    expect(wsDirDetail(dirs[1], dirs)).toEqual({ detail: 'west', detailMarker: '#2' })
  })
  it('词中间不同也保留可读名称', () => {
    const dashed = ['/work/foo-bar/project', '/work/foo-baz/project']
    expect(wsDirDetail(dashed[0], dashed)).toEqual({ detail: 'bar', detailMarker: '#1' })
    expect(wsDirDetail(dashed[1], dashed)).toEqual({ detail: 'baz', detailMarker: '#2' })

    const plain = ['/work/foobar/project', '/work/foobaz/project']
    expect(wsDirDetail(plain[0], plain)).toEqual({ detail: 'foobar', detailMarker: '#1' })
    expect(wsDirDetail(plain[1], plain)).toEqual({ detail: 'foobaz', detailMarker: '#2' })
  })
  it('没有同名目录时，仍显示原有完整路径', () => {
    expect(wsDirDetail('/work/project', ['/work/project', '/work/other'])).toEqual({ detail: '/work/project' })
  })
})
