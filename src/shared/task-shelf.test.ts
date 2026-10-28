import { describe, expect, it } from 'vitest'
import { DEFAULT_TASK_SHELF_PREFERENCES, matchShelfShortcut, parseShelfPreferences } from './task-shelf'

describe('任务区可配置快捷键', () => {
  it('规范化、去重并保留命令面板快捷键', () => {
    expect(parseShelfPreferences({ toggleShortcut: 'ctrl+shift+u', collectShortcut: '' })).toEqual({ toggleShortcut: 'Ctrl+Shift+U', collectShortcut: '' })
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+Shift+J', collectShortcut: 'Ctrl+Shift+J' })).toThrow()
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+Shift+P', collectShortcut: '' })).toThrow()
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+J', collectShortcut: '' })).toThrow()
  })
  it('组合输入、重复按键与多余修饰键不会触发动作', () => {
    const input = { type: 'keyDown', key: 'j', control: true, shift: true }
    expect(matchShelfShortcut(input, DEFAULT_TASK_SHELF_PREFERENCES)).toBe('toggle')
    expect(matchShelfShortcut({ ...input, key: 's' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBe('collect')
    for (const extra of [{ isComposing: true }, { isAutoRepeat: true }, { alt: true }, { meta: true }, { type: 'keyUp' }]) expect(matchShelfShortcut({ ...input, ...extra }, DEFAULT_TASK_SHELF_PREFERENCES)).toBeNull()
  })
})
import { shelfWebUrl } from './task-shelf'

/** 归档里的网页地址必须永远能安全重放：只留无凭据、无查询串的 http(s) 深链。 */
describe('shelfWebUrl', () => {
  it('保留可安全重放的公开深链', () => {
    expect(shelfWebUrl('https://example.com/docs/guide')).toBe('https://example.com/docs/guide')
    expect(shelfWebUrl('http://example.com/a/b')).toBe('http://example.com/a/b')
    expect(shelfWebUrl('https://example.com/questions/12345')).toBe('https://example.com/questions/12345')
  })

  it('拒绝本机与回环地址', () => {
    expect(shelfWebUrl('http://localhost:5173/app')).toBeUndefined()
    expect(shelfWebUrl('http://127.0.0.1:8080/x')).toBeUndefined()
    expect(shelfWebUrl('http://127.1.2.3/')).toBeUndefined()
    expect(shelfWebUrl('http://[::1]/x')).toBeUndefined()
    expect(shelfWebUrl('http://0.0.0.0:3000/')).toBeUndefined()
    expect(shelfWebUrl('http://LOCALHOST/app')).toBeUndefined()
  })

  it('拒绝带查询串/片段的地址', () => {
    expect(shelfWebUrl('https://example.com/search?q=secret')).toBeUndefined()
    expect(shelfWebUrl('https://example.com/doc#section')).toBeUndefined()
  })

  it('拒绝内嵌凭据与非法协议', () => {
    expect(shelfWebUrl('https://user:pass@example.com/')).toBeUndefined()
    expect(shelfWebUrl('https://user@example.com/')).toBeUndefined()
    expect(shelfWebUrl('file:///c:/secret.txt')).toBeUndefined()
    expect(shelfWebUrl('javascript:alert(1)')).toBeUndefined()
    expect(shelfWebUrl('ftp://example.com/a')).toBeUndefined()
    expect(shelfWebUrl('not a url')).toBeUndefined()
    expect(shelfWebUrl('')).toBeUndefined()
  })

  it('拒绝认证/会话类路径段', () => {
    for (const path of ['/login', '/logout', '/signin', '/auth/callback', '/oauth/authorize', '/token', '/session/abc', '/v1/auth']) {
      expect(shelfWebUrl(`https://example.com${path}`)).toBeUndefined()
    }
    // 只认整段匹配：单词里包含这些词不算敏感路径。
    expect(shelfWebUrl('https://example.com/sessions-guide/authored')).toBe('https://example.com/sessions-guide/authored')
  })

  it('拒绝超长地址与超长随机路径段', () => {
    expect(shelfWebUrl(`https://example.com/${'a'.repeat(40)}`)).toBeUndefined()
    expect(shelfWebUrl(`https://example.com/${'a'.repeat(39)}`)).toBe(`https://example.com/${'a'.repeat(39)}`)
    expect(shelfWebUrl(`https://example.com/${'a'.repeat(4100)}`)).toBeUndefined()
  })
})
