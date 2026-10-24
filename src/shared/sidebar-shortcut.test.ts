/**
 * 侧栏快捷键匹配矩阵 —— matchSidebarShortcut / matchSidebarShortcutAction 是主进程
 * before-input-event 与渲染层宿主 keydown 共用的唯一手势语义，这里锁住：真实导航
 * 位置 1..8、env 不占数字位、物理 code 优先于键盘布局、code 缺失的 key 回退、
 * 越界数字、Numpad 排除、修饰键组合/长按/IME/keyUp 的让位规则，
 * Alt+` 的 toggle 动作与旧导航契约的互不越界，以及两个白名单的边界。
 */
import { describe, expect, it } from 'vitest'
import {
  isSidebarNavTab,
  isSidebarShortcutAction,
  matchSidebarShortcut,
  matchSidebarShortcutAction,
  SIDEBAR_NAV_TABS,
  type SidebarShortcutInput
} from './sidebar-shortcut'

const command = (over: Partial<SidebarShortcutInput> = {}): SidebarShortcutInput => ({
  type: 'keyDown',
  key: '1',
  code: 'Digit1',
  control: false,
  alt: true,
  shift: false,
  meta: false,
  isAutoRepeat: false,
  isComposing: false,
  ...over
})

/** Alt+` 的标准首按：物理 Backquote，key 为字面反引号 */
const togglePress = (over: Partial<SidebarShortcutInput> = {}): SidebarShortcutInput =>
  command({ key: '`', code: 'Backquote', ...over })

/** 侧栏顺序即快捷键位置：第 N 个 tab 对应 Alt+N */
const positions = SIDEBAR_NAV_TABS.map((tab, index) => ({ position: index + 1, tab }))

describe('SIDEBAR_NAV_TABS / isSidebarNavTab：导航白名单', () => {
  it('固定导航恰好是真实可见的八项，顺序即 Alt+1..Alt+8', () => {
    expect([...SIDEBAR_NAV_TABS]).toEqual([
      'agents',
      'sessions',
      'dsh',
      'codex',
      'claude',
      'plugins',
      'web',
      'settings'
    ])
  })

  it('env 已移入设置，不在侧栏占数字位置', () => {
    expect(SIDEBAR_NAV_TABS).not.toContain('env')
  })

  it('合法 tab 名全部收窄通过', () => {
    for (const tab of SIDEBAR_NAV_TABS) {
      expect(isSidebarNavTab(tab)).toBe(true)
    }
  })

  it('拼写漂移/大小写/空白/越界类型一律拒之门外', () => {
    expect(isSidebarNavTab('env')).toBe(false)
    expect(isSidebarNavTab('')).toBe(false)
    expect(isSidebarNavTab('AGENTS')).toBe(false)
    expect(isSidebarNavTab('Agents')).toBe(false)
    expect(isSidebarNavTab('agents ')).toBe(false)
    expect(isSidebarNavTab(' agents')).toBe(false)
    expect(isSidebarNavTab('agent')).toBe(false)
    expect(isSidebarNavTab('settings\n')).toBe(false)
  })

  it('恶意/畸形输入：对象原型键、数字、null、数组都不能冒充 tab', () => {
    expect(isSidebarNavTab('__proto__')).toBe(false)
    expect(isSidebarNavTab('constructor')).toBe(false)
    expect(isSidebarNavTab('toString')).toBe(false)
    expect(isSidebarNavTab('hasOwnProperty')).toBe(false)
    expect(isSidebarNavTab(1)).toBe(false)
    expect(isSidebarNavTab(0)).toBe(false)
    expect(isSidebarNavTab(undefined)).toBe(false)
    expect(isSidebarNavTab(null)).toBe(false)
    expect(isSidebarNavTab({ tab: 'agents' })).toBe(false)
    expect(isSidebarNavTab(['agents'])).toBe(false)
    expect(isSidebarNavTab(true)).toBe(false)
  })
})

describe('isSidebarShortcutAction：动作白名单 = 八个导航 + toggle', () => {
  it('八项导航与 toggle 全部通过', () => {
    for (const tab of SIDEBAR_NAV_TABS) {
      expect(isSidebarShortcutAction(tab)).toBe(true)
    }
    expect(isSidebarShortcutAction('toggle')).toBe(true)
  })

  it('toggle 是动作但不是导航 tab，两条白名单不互相污染', () => {
    expect(isSidebarNavTab('toggle')).toBe(false)
    expect(SIDEBAR_NAV_TABS).not.toContain('toggle')
  })

  it('env/拼写漂移/大小写/空白一律拒之门外', () => {
    expect(isSidebarShortcutAction('env')).toBe(false)
    expect(isSidebarShortcutAction('TOGGLE')).toBe(false)
    expect(isSidebarShortcutAction('Toggle')).toBe(false)
    expect(isSidebarShortcutAction('toggle ')).toBe(false)
    expect(isSidebarShortcutAction(' toggle')).toBe(false)
    expect(isSidebarShortcutAction('toggled')).toBe(false)
    expect(isSidebarShortcutAction('toggle\n')).toBe(false)
    expect(isSidebarShortcutAction('')).toBe(false)
  })

  it('对象原型键与越界类型都不能冒充动作', () => {
    expect(isSidebarShortcutAction('__proto__')).toBe(false)
    expect(isSidebarShortcutAction('constructor')).toBe(false)
    expect(isSidebarShortcutAction('toString')).toBe(false)
    expect(isSidebarShortcutAction('hasOwnProperty')).toBe(false)
    expect(isSidebarShortcutAction('valueOf')).toBe(false)
    expect(isSidebarShortcutAction(1)).toBe(false)
    expect(isSidebarShortcutAction(undefined)).toBe(false)
    expect(isSidebarShortcutAction(null)).toBe(false)
    expect(isSidebarShortcutAction({ action: 'toggle' })).toBe(false)
    expect(isSidebarShortcutAction(['toggle'])).toBe(false)
    expect(isSidebarShortcutAction(true)).toBe(false)
  })
})

describe('matchSidebarShortcut：真实导航位置 1..8', () => {
  it.each(positions)('Alt+$position 且物理 code 为 Digit$position → $tab', ({ position, tab }) => {
    expect(matchSidebarShortcut(command({ key: String(position), code: `Digit${position}` }))).toBe(tab)
  })

  it('env 不占位：6/7/8 分别是 plugins/web/settings', () => {
    expect(matchSidebarShortcut(command({ key: '6', code: 'Digit6' }))).toBe('plugins')
    expect(matchSidebarShortcut(command({ key: '7', code: 'Digit7' }))).toBe('web')
    expect(matchSidebarShortcut(command({ key: '8', code: 'Digit8' }))).toBe('settings')
    expect(matchSidebarShortcut(command({ key: '5', code: 'Digit5' }))).toBe('claude')
  })

  it('rawKeyDown 同样命中（Chromium 非合并路径派发 rawKeyDown）', () => {
    expect(matchSidebarShortcut(command({ type: 'rawKeyDown', key: '1', code: 'Digit1' }))).toBe('agents')
    expect(matchSidebarShortcut(command({ type: 'rawKeyDown', key: '8', code: 'Digit8' }))).toBe('settings')
  })
})

describe('matchSidebarShortcut：物理 code 优先于键盘布局', () => {
  it('AZERTY 等布局下 key 变成符号，仍按物理位置跳转', () => {
    expect(matchSidebarShortcut(command({ key: '&', code: 'Digit1' }))).toBe('agents')
    expect(matchSidebarShortcut(command({ key: 'é', code: 'Digit2' }))).toBe('sessions')
    expect(matchSidebarShortcut(command({ key: '"', code: 'Digit3' }))).toBe('dsh')
    expect(matchSidebarShortcut(command({ key: '?', code: 'Digit8' }))).toBe('settings')
  })

  it('en-US 布局 Alt+Shift 已被排除，所以 key 中的特殊字符不参与匹配', () => {
    expect(matchSidebarShortcut(command({ key: '!', code: 'Digit1' }))).toBe('agents')
    expect(matchSidebarShortcut(command({ key: '!', code: 'Digit1', shift: true }))).toBeNull()
  })

  it('code 缺失或为空时才回退到 key 的单数字', () => {
    expect(matchSidebarShortcut(command({ key: '3', code: undefined }))).toBe('dsh')
    expect(matchSidebarShortcut(command({ key: '4', code: '' }))).toBe('codex')
    expect(matchSidebarShortcut(command({ key: '8', code: undefined }))).toBe('settings')
  })

  it('显式 Numpad/其他 code 不匹配，即使 key 是数字', () => {
    expect(matchSidebarShortcut(command({ key: '1', code: 'Numpad1' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '8', code: 'Numpad8' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '1', code: 'KeyA' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '1', code: 'F1' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '1', code: 'digit1' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '1', code: 'Digit01' }))).toBeNull()
  })
})

describe('matchSidebarShortcut：越界与非数字键', () => {
  it('Digit0 / Digit9 / key 0 / key 9 均越界', () => {
    expect(matchSidebarShortcut(command({ key: '0', code: 'Digit0' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '9', code: 'Digit9' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '0', code: undefined }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '9', code: '' }))).toBeNull()
  })

  it('多位数字/带空白/关 NumLock 的 End 都不匹配', () => {
    expect(matchSidebarShortcut(command({ key: '11', code: undefined }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: ' 1', code: undefined }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '1 ', code: '' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: 'End', code: undefined }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: 'Home', code: undefined }))).toBeNull()
  })

  it('字母/方向键等非数字键不匹配', () => {
    expect(matchSidebarShortcut(command({ key: 'a', code: 'KeyA' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: 'ArrowLeft', code: 'ArrowLeft' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: 'Enter', code: 'Enter' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '-', code: undefined }))).toBeNull()
  })
})

describe('matchSidebarShortcut：让位规则', () => {
  it('keyUp / char / keyChar 等非按键首按不拦', () => {
    expect(matchSidebarShortcut(command({ type: 'keyUp' }))).toBeNull()
    expect(matchSidebarShortcut(command({ type: 'char' }))).toBeNull()
    expect(matchSidebarShortcut(command({ type: 'keyChar' }))).toBeNull()
    expect(matchSidebarShortcut(command({ type: '' }))).toBeNull()
  })

  it('长按 autoRepeat 不重复触发导航', () => {
    expect(matchSidebarShortcut(command({ isAutoRepeat: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '3', code: 'Digit3', isAutoRepeat: true }))).toBeNull()
  })

  it('IME 组合中的按键让位给输入法', () => {
    expect(matchSidebarShortcut(command({ isComposing: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '2', code: undefined, isComposing: true }))).toBeNull()
  })

  it('无 Alt 不拦（单独数字键属于输入）', () => {
    expect(matchSidebarShortcut(command({ alt: false }))).toBeNull()
    expect(matchSidebarShortcut(command({ alt: undefined }))).toBeNull()
  })

  it('Alt 叠加 Ctrl/Cmd/Shift 的任何组合都不劫持', () => {
    expect(matchSidebarShortcut(command({ control: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ meta: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ shift: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ control: true, shift: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ alt: true, control: true, meta: true, shift: true }))).toBeNull()
  })

  it('Ctrl/Cmd/Shift 单独出现也不匹配（只认 Alt）', () => {
    expect(matchSidebarShortcut(command({ alt: false, control: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ alt: false, meta: true }))).toBeNull()
    expect(matchSidebarShortcut(command({ alt: false, shift: true }))).toBeNull()
  })
})

describe('matchSidebarShortcutAction：Alt+` 切换侧栏', () => {
  it('keyDown / rawKeyDown 的首按命中 toggle', () => {
    expect(matchSidebarShortcutAction(togglePress())).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ type: 'rawKeyDown' }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ isAutoRepeat: false }))).toBe('toggle')
  })

  it('物理 Backquote 优先：key 按布局变成别的字符仍切换', () => {
    expect(matchSidebarShortcutAction(togglePress({ key: '<' }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ key: '§' }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ key: 'Dead' }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ key: 'Unidentified' }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ key: '' }))).toBe('toggle')
  })

  it('物理 code 压过 key：Backquote 上的数字键不会被当成导航', () => {
    expect(matchSidebarShortcutAction(togglePress({ key: '1' }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ key: '8' }))).toBe('toggle')
  })

  it('code 缺失或为空才回退 key 的字面反引号', () => {
    expect(matchSidebarShortcutAction(togglePress({ code: undefined }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ code: '' }))).toBe('toggle')
    expect(matchSidebarShortcutAction(togglePress({ code: undefined, key: '`' }))).toBe('toggle')
  })

  it('code 明确为其他键位时不因 key 是反引号而匹配', () => {
    expect(matchSidebarShortcutAction(togglePress({ code: 'Quote', key: '`' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: 'Backslash' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: 'KeyA' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: 'IntlRo' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: 'NumpadDecimal' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: 'backquote' }))).toBeNull()
    // 数字键位优先于 key 的反引号：返回导航而不是 toggle
    expect(matchSidebarShortcutAction(togglePress({ code: 'Digit3', key: '`' }))).toBe('dsh')
    expect(matchSidebarShortcutAction(togglePress({ code: 'Numpad1', key: '`' }))).toBeNull()
  })

  it('key 回退只认字面反引号：~ / 空 / 字符名都不行', () => {
    expect(matchSidebarShortcutAction(togglePress({ code: undefined, key: '~' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: undefined, key: 'Backquote' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: undefined, key: '` `' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: undefined, key: '' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: '', key: 'Dead' }))).toBeNull()
  })

  it('keyUp / char / keyChar / 空 type 都不切换（按下才响应）', () => {
    expect(matchSidebarShortcutAction(togglePress({ type: 'keyUp' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ type: 'char' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ type: 'keyChar' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ type: '' }))).toBeNull()
  })

  it('长按 autoRepeat 不连续切换', () => {
    expect(matchSidebarShortcutAction(togglePress({ isAutoRepeat: true }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: undefined, isAutoRepeat: true }))).toBeNull()
  })

  it('IME 组合中的反引号让位给输入法', () => {
    expect(matchSidebarShortcutAction(togglePress({ isComposing: true }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ code: undefined, isComposing: true }))).toBeNull()
  })

  it('无 Alt 不切换（单独反引号属于输入）', () => {
    expect(matchSidebarShortcutAction(togglePress({ alt: false }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ alt: undefined }))).toBeNull()
  })

  it('Alt 叠加 Ctrl/Cmd/Shift 的任何组合都不劫持', () => {
    expect(matchSidebarShortcutAction(togglePress({ control: true }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ meta: true }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ shift: true }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ shift: true, key: '~' }))).toBeNull()
    expect(matchSidebarShortcutAction(togglePress({ control: true, shift: true }))).toBeNull()
    expect(
      matchSidebarShortcutAction(togglePress({ control: true, meta: true, shift: true }))
    ).toBeNull()
  })
})

describe('matchSidebarShortcutAction：导航与越界回归', () => {
  it.each(positions)(
    'Alt+$position 且物理 code 为 Digit$position → $tab（新动作匹配器同样只返回导航）',
    ({ position, tab }) => {
      expect(
        matchSidebarShortcutAction(command({ key: String(position), code: `Digit${position}` }))
      ).toBe(tab)
    }
  )

  it('布局字符与 code 缺失回退在新匹配器上与原语义一致', () => {
    expect(matchSidebarShortcutAction(command({ key: '&', code: 'Digit1' }))).toBe('agents')
    expect(matchSidebarShortcutAction(command({ key: '3', code: undefined }))).toBe('dsh')
    expect(matchSidebarShortcutAction(command({ key: '8', code: '' }))).toBe('settings')
  })

  it('Digit0/Digit9/Numpad/多位数等越界仍为 null', () => {
    expect(matchSidebarShortcutAction(command({ key: '0', code: 'Digit0' }))).toBeNull()
    expect(matchSidebarShortcutAction(command({ key: '9', code: 'Digit9' }))).toBeNull()
    expect(matchSidebarShortcutAction(command({ key: '9', code: undefined }))).toBeNull()
    expect(matchSidebarShortcutAction(command({ key: '1', code: 'Numpad1' }))).toBeNull()
    expect(matchSidebarShortcutAction(command({ key: '11', code: undefined }))).toBeNull()
    expect(matchSidebarShortcutAction(command({ key: 'a', code: 'KeyA' }))).toBeNull()
  })

  it('反引号键位不影响 Alt+1..8、Alt+9 与 Numpad 的既有结论', () => {
    expect(matchSidebarShortcut(command({ key: '2', code: 'Digit2' }))).toBe('sessions')
    expect(matchSidebarShortcut(command({ key: '9', code: 'Digit9' }))).toBeNull()
    expect(matchSidebarShortcut(command({ key: '1', code: 'Numpad1' }))).toBeNull()
  })
})

describe('旧 matchSidebarShortcut 与 matchSidebarShortcutAction 的契约边界', () => {
  it('旧的导航函数对 Backquote 一律 null，绝不返回 toggle', () => {
    expect(matchSidebarShortcut(togglePress())).toBeNull()
    expect(matchSidebarShortcut(togglePress({ type: 'rawKeyDown' }))).toBeNull()
    expect(matchSidebarShortcut(togglePress({ code: undefined }))).toBeNull()
    expect(matchSidebarShortcut(togglePress({ key: '1' }))).toBeNull()
  })

  it('导航输入上两个函数结论完全一致', () => {
    const navCases: SidebarShortcutInput[] = [
      command({ key: '1', code: 'Digit1' }),
      command({ key: 'é', code: 'Digit2' }),
      command({ key: '8', code: 'Digit8' }),
      command({ key: '5', code: undefined }),
      command({ key: '0', code: 'Digit0' }),
      command({ key: '9', code: undefined }),
      command({ key: '1', code: 'Numpad1' }),
      command({ key: '1', code: 'Digit1', type: 'keyUp' }),
      command({ key: '1', code: 'Digit1', isAutoRepeat: true }),
      command({ key: '1', code: 'Digit1', isComposing: true }),
      command({ key: '1', code: 'Digit1', control: true }),
      command({ key: '1', code: 'Digit1', alt: false })
    ]
    for (const input of navCases) {
      expect(matchSidebarShortcutAction(input)).toBe(matchSidebarShortcut(input))
    }
  })
})
