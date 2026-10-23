import { describe, expect, it } from 'vitest'
import { validateBrowserMenuRequest } from './validation'
describe('浏览器菜单IPC输入', () => {
  it('只接受固定生命周期请求或动作ID，拒绝页面传入的脚本和地址', () => {
    expect(validateBrowserMenuRequest({ kind: 'ready' })).toEqual({ kind: 'ready' })
    expect(validateBrowserMenuRequest({ kind: 'action', id: 'save-link', url: 'file:///secret' })).toEqual({ kind: 'action', id: 'save-link' })
    for (const raw of [null, {}, { kind: 'action', id: 'executeJavaScript' }, { kind: 'action', id: '' }, { kind: 'navigate', url: 'https://evil.test' }]) {
      expect(() => validateBrowserMenuRequest(raw)).toThrow()
    }
  })
})
