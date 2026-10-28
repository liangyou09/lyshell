import { describe, expect, it } from 'vitest'
import { DEFAULT_TASK_SHELF_PREFERENCES, matchShelfShortcut, parseShelfPreferences } from './task-shelf'

describe('任务区可配置快捷键', () => {
  it('默认展开快捷键是 Ctrl+`，收纳默认仍为 Ctrl+Shift+S', () => {
    expect(DEFAULT_TASK_SHELF_PREFERENCES).toEqual({ toggleShortcut: 'Ctrl+`', collectShortcut: 'Ctrl+Shift+S' })
  })
  it('规范化反引号与 Shift+字母两种形式，去重并保留命令面板快捷键', () => {
    expect(parseShelfPreferences({ toggleShortcut: 'ctrl+`', collectShortcut: '' })).toEqual({ toggleShortcut: 'Ctrl+`', collectShortcut: '' })
    expect(parseShelfPreferences({ toggleShortcut: 'META+BACKQUOTE', collectShortcut: 'ctrl+shift+u' })).toEqual({ toggleShortcut: 'Meta+`', collectShortcut: 'Ctrl+Shift+U' })
    expect(parseShelfPreferences({ toggleShortcut: 'Ctrl+Shift+U', collectShortcut: 'Meta+Shift+K' })).toEqual({ toggleShortcut: 'Ctrl+Shift+U', collectShortcut: 'Meta+Shift+K' })
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+`', collectShortcut: 'Ctrl+`' })).toThrow()
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+Shift+J', collectShortcut: 'Ctrl+Shift+J' })).toThrow()
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+Shift+P', collectShortcut: '' })).toThrow()
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+J', collectShortcut: '' })).toThrow()
  })
  it('只接受 Ctrl/Meta+` 或 Shift+字母，Shift/Alt/双修饰的反引号都非法', () => {
    for (const invalid of ['Ctrl+Shift+`', 'Ctrl+~', 'Ctrl+Alt+`', 'Ctrl+Meta+`', 'Ctrl+Backquote+Shift', 'Ctrl++`', 'Ctrl+`x', '`']) {
      expect(() => parseShelfPreferences({ toggleShortcut: invalid, collectShortcut: '' })).toThrow()
    }
    for (const invalid of ['Ctrl+Shift+P', 'ctrl+shift+p', null, 42, {}]) {
      expect(() => parseShelfPreferences({ toggleShortcut: invalid, collectShortcut: '' })).toThrow()
    }
    expect(() => parseShelfPreferences({ toggleShortcut: 'Ctrl+`', collectShortcut: '' , extra: true })).toThrow()
  })
  it('反引号按物理键位匹配，键盘布局改了 key 也不影响', () => {
    const base = { type: 'keyDown', control: true, shift: false }
    expect(matchShelfShortcut({ ...base, key: '`', code: 'Backquote' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBe('toggle')
    // 德语等布局里 Backquote 键的 key 是 '^'，物理键位仍是同一个。
    expect(matchShelfShortcut({ ...base, key: '^', code: 'Backquote' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBe('toggle')
    // 没有 code 时回退字面反引号；有 code 时不以 key 为准（Quote/Numpad 键不是反引号）。
    expect(matchShelfShortcut({ ...base, key: '`' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBe('toggle')
    expect(matchShelfShortcut({ ...base, key: '`', code: 'Quote' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBeNull()
    expect(matchShelfShortcut({ ...base, key: '`', code: 'NumpadDecimal' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBeNull()
    expect(matchShelfShortcut({ ...base, key: '`', code: 'Backquote', type: 'rawKeyDown' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBe('toggle')
  })
  it('仅在单个 Ctrl/Meta 修饰且无 Shift/Alt 时触发反引号', () => {
    const tick = { type: 'keyDown', key: '`', code: 'Backquote' }
    for (const extra of [
      { shift: true, key: '~' },
      { alt: true },
      { isComposing: true },
      { isAutoRepeat: true },
      { type: 'keyUp' },
      { control: true, meta: true },
      { control: false, meta: false },
      { control: true, shift: true }
    ]) {
      expect(matchShelfShortcut({ ...tick, ...extra }, DEFAULT_TASK_SHELF_PREFERENCES)).toBeNull()
    }
    // 默认是 Ctrl：Meta+` 不触发；改成 Meta 后 Ctrl+` 不再触发，两者互不串。
    expect(matchShelfShortcut({ ...tick, meta: true }, DEFAULT_TASK_SHELF_PREFERENCES)).toBeNull()
    expect(matchShelfShortcut({ ...tick, control: true }, { toggleShortcut: 'Meta+`', collectShortcut: '' })).toBeNull()
    expect(matchShelfShortcut({ ...tick, meta: true }, { toggleShortcut: 'Meta+`', collectShortcut: '' })).toBe('toggle')
    // 留空表示禁用。
    expect(matchShelfShortcut({ ...tick, control: true }, { toggleShortcut: '', collectShortcut: '' })).toBeNull()
  })
  it('保留自定义 Ctrl/Meta+Shift+字母，旧默认不再隐式触发', () => {
    const letter = { type: 'keyDown', key: 'j', code: 'KeyJ', control: true, shift: true }
    expect(matchShelfShortcut(letter, DEFAULT_TASK_SHELF_PREFERENCES)).toBeNull()
    expect(matchShelfShortcut(letter, { toggleShortcut: 'Ctrl+Shift+J', collectShortcut: '' })).toBe('toggle')
    expect(matchShelfShortcut({ ...letter, key: 'S' }, DEFAULT_TASK_SHELF_PREFERENCES)).toBe('collect')
    expect(matchShelfShortcut({ ...letter, control: false, meta: true, key: 'k' }, { toggleShortcut: 'Meta+Shift+K', collectShortcut: '' })).toBe('toggle')
    // 字母组合仍必须是带 Shift 的单个字母：缺 Shift 或按键不是字母都不触发。
    expect(matchShelfShortcut({ ...letter, shift: false }, { toggleShortcut: 'Ctrl+Shift+J', collectShortcut: '' })).toBeNull()
    expect(matchShelfShortcut({ ...letter, key: '1', code: 'Digit1' }, { toggleShortcut: 'Ctrl+Shift+J', collectShortcut: '' })).toBeNull()
    for (const extra of [{ isComposing: true }, { isAutoRepeat: true }, { alt: true }, { meta: true }, { type: 'keyUp' }]) {
      expect(matchShelfShortcut({ ...letter, ...extra }, { toggleShortcut: 'Ctrl+Shift+J', collectShortcut: '' })).toBeNull()
    }
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
