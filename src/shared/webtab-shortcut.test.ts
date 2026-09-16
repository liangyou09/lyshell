/**
 * 网页页签快捷键匹配矩阵 —— matchWebTabShortcut 是主进程 before-input-event 与
 * 渲染层宿主 keydown 共用的唯一手势语义，这里锁住手势集与让位规则
 * （keyUp / autoRepeat / rawKeyDown 双收 / IME 组合 / 修饰键组合 / Shift 大写形态）
 * 与 isWebTabShortcutAction 的 IPC 边界白名单。
 */
import { describe, expect, it } from 'vitest'
import { matchWebTabShortcut, isWebTabShortcutAction, type ShortcutInputShape } from './webtab-shortcut'

const key = (over: Partial<ShortcutInputShape>): ShortcutInputShape => ({
  type: 'keyDown',
  key: 'r',
  control: false,
  alt: false,
  shift: false,
  isAutoRepeat: false,
  ...over
})

describe('matchWebTabShortcut：命中矩阵', () => {
  it('Ctrl+R → reload', () => {
    expect(matchWebTabShortcut(key({ control: true }))).toBe('reload')
  })

  it('Ctrl+Shift+R → reload-hard（含 Shift 大写形态 R）', () => {
    expect(matchWebTabShortcut(key({ control: true, shift: true }))).toBe('reload-hard')
    expect(matchWebTabShortcut(key({ control: true, shift: true, key: 'R' }))).toBe('reload-hard')
  })

  it('Shift 不改变字母键大小写匹配（小写 shift 形态也算 R）', () => {
    expect(matchWebTabShortcut(key({ control: true, key: 'R' }))).toBe('reload')
  })

  it('Alt+← / Alt+→ → back / forward', () => {
    expect(matchWebTabShortcut(key({ alt: true, key: 'ArrowLeft' }))).toBe('back')
    expect(matchWebTabShortcut(key({ alt: true, key: 'ArrowRight' }))).toBe('forward')
  })

  it('Ctrl+L → focus-address-bar（Shift+L 不命中）', () => {
    expect(matchWebTabShortcut(key({ control: true, key: 'l' }))).toBe('focus-address-bar')
    expect(matchWebTabShortcut(key({ control: true, key: 'L' }))).toBe('focus-address-bar')
    expect(matchWebTabShortcut(key({ control: true, shift: true, key: 'L' }))).toBeNull()
  })

  it('meta(Cmd)+R 等价 Ctrl+R', () => {
    expect(matchWebTabShortcut(key({ control: false, meta: true }))).toBe('reload')
  })
})

describe('matchWebTabShortcut：让位规则', () => {
  it('keyUp / 长按 autoRepeat 不拦', () => {
    expect(matchWebTabShortcut(key({ control: true, type: 'keyUp' }))).toBeNull()
    expect(matchWebTabShortcut(key({ control: true, isAutoRepeat: true }))).toBeNull()
  })

  it('rawKeyDown 同样命中（Chromium 非合并路径派发 rawKeyDown，只认 keyDown 会失灵）', () => {
    expect(matchWebTabShortcut(key({ control: true, type: 'rawKeyDown' }))).toBe('reload')
    expect(matchWebTabShortcut(key({ alt: true, key: 'ArrowLeft', type: 'rawKeyDown' }))).toBe('back')
  })

  it('char / 其他 type 不拦（合成字符流与手势无关）', () => {
    expect(matchWebTabShortcut(key({ control: true, type: 'char' }))).toBeNull()
    expect(matchWebTabShortcut(key({ control: true, type: 'keyChar' }))).toBeNull()
  })

  it('IME 组合中的按键不拦（候选确认不是快捷键意图）', () => {
    expect(matchWebTabShortcut(key({ control: true, isComposing: true }))).toBeNull()
    expect(matchWebTabShortcut(key({ alt: true, key: 'ArrowLeft', isComposing: true }))).toBeNull()
  })

  it('无修饰键字母不拦', () => {
    expect(matchWebTabShortcut(key({}))).toBeNull()
    expect(matchWebTabShortcut(key({ key: 'ArrowLeft' }))).toBeNull()
  })

  it('Ctrl+Alt 组合不拦（留给输入法/系统）', () => {
    expect(matchWebTabShortcut(key({ control: true, alt: true }))).toBeNull()
  })

  it('Alt+方向带 Ctrl 或 Shift 不拦（Ctrl+方向是分屏切换，Shift+方向有原生语义）', () => {
    expect(matchWebTabShortcut(key({ alt: true, control: true, key: 'ArrowLeft' }))).toBeNull()
    expect(matchWebTabShortcut(key({ alt: true, shift: true, key: 'ArrowLeft' }))).toBeNull()
  })

  it('其他 Ctrl+字母不拦（只有 R/L 有浏览器语义）', () => {
    expect(matchWebTabShortcut(key({ control: true, key: 't' }))).toBeNull()
    expect(matchWebTabShortcut(key({ control: true, key: 'f' }))).toBeNull()
  })
})

describe('isWebTabShortcutAction：IPC 边界白名单', () => {
  it('五个合法 action 收窄通过', () => {
    for (const a of ['reload', 'reload-hard', 'back', 'forward', 'focus-address-bar']) {
      expect(isWebTabShortcutAction(a)).toBe(true)
    }
  })

  it('未知字符串 / 非字符串拒之门外（preload 边界值不可信）', () => {
    expect(isWebTabShortcutAction('reload-evil')).toBe(false)
    expect(isWebTabShortcutAction('')).toBe(false)
    expect(isWebTabShortcutAction(undefined)).toBe(false)
    expect(isWebTabShortcutAction(null)).toBe(false)
    expect(isWebTabShortcutAction(123)).toBe(false)
    expect(isWebTabShortcutAction({ action: 'reload' })).toBe(false)
  })
})
