/**
 * 侧栏快捷键匹配（纯函数，主进程 before-input-event 与渲染层宿主 keydown 共用语义，
 * 故放 shared —— 两 bundle 各自编译，跨 bundle 引用只有 shared 可达）。
 *
 * 手势：Alt+1..Alt+8 直达侧栏第 N 个固定导航（应用内全局，与焦点所在分屏无关）。
 * 位置只认真实可见的固定导航；env 已从侧栏移入设置，不得占用数字位置，否则
 * 用户记住的 Alt+6 在某个版本后指向别的页面。
 * Alt+` 切换侧栏开合，与导航分开成独立动作（见 matchSidebarShortcutAction）。
 *
 * 匹配范围约束（路由层各自把守，匹配函数本身不判断焦点）：
 * - 仅 Alt，且无 Ctrl/Cmd/Shift：Alt+Shift+数字、Ctrl+Alt+数字交给系统/输入法。
 * - 只认 keyDown / rawKeyDown 的首按：keyUp、长按 autoRepeat 不是新意图，
 *   IME 组合中的按键是候选确认，一律让位。
 * - 物理 code（Digit1..Digit8）优先：键盘布局改变时 key 会变成 '&'、'é' 等，
 *   按物理位置跳转才符合用户预期；code 缺失/为空时才回退到 key 的单数字
 *   （兼容不含 code 的合成事件）。显式 Numpad1、KeyA 等非 Digit1..8 的 code
 *   不匹配 —— 数字小键盘有独立语义，不能被侧栏劫持。
 * - 0/9 等越界数字一律 null。
 *
 * Alt+` 沿用同一套守卫：有 code 时只认物理 Backquote（key 按布局可能是别的字符），
 * code 明确为其他键位则不匹配；code 缺失/空才回退 key 的字面反引号。
 * 旧的 matchSidebarShortcut 只表达导航，对 Backquote 仍返回 null。
 */

/** 真实可见的固定导航，顺序即快捷键位置（第 N 个 = Alt+N）。 */
export const SIDEBAR_NAV_TABS = [
  'agents',
  'sessions',
  'dsh',
  'codex',
  'claude',
  'plugins',
  'web',
  'settings'
] as const

export type SidebarNavTab = (typeof SIDEBAR_NAV_TABS)[number]

/** 运行时白名单：外部到达的 tab 名不可信，收窄后才路由（防注入/拼写漂移）。 */
const SIDEBAR_NAV_TAB_SET: ReadonlySet<string> = new Set(SIDEBAR_NAV_TABS)

export function isSidebarNavTab(value: unknown): value is SidebarNavTab {
  return typeof value === 'string' && SIDEBAR_NAV_TAB_SET.has(value)
}

/** before-input-event 的 input 形状（Electron Input；type: 'keyDown' | 'keyUp' | 'rawKeyDown' …） */
export interface SidebarShortcutInput {
  type: string
  key: string
  /** 物理键位 code（DOM/Electron 同名同义，如 'Digit1'、'Numpad1'） */
  code?: string
  control?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
  isAutoRepeat?: boolean
  /** IME 组合中的按键（Electron Input / DOM KeyboardEvent 同名同义） */
  isComposing?: boolean
}

/** 侧栏开合：导航之外的第 9 个动作 */
export type SidebarShortcutAction = SidebarNavTab | 'toggle'

/** 运行时白名单：导航 + toggle，不接受 env/原型链键等越界值。 */
const SIDEBAR_SHORTCUT_ACTION_SET: ReadonlySet<string> = new Set<string>([
  ...SIDEBAR_NAV_TABS,
  'toggle'
])

export function isSidebarShortcutAction(value: unknown): value is SidebarShortcutAction {
  return typeof value === 'string' && SIDEBAR_SHORTCUT_ACTION_SET.has(value)
}

/** 物理位置：只认主键区 Digit1..Digit8（显式排除小键盘与其他键位） */
const SIDEBAR_DIGIT_CODE_RE = /^Digit([1-8])$/
/** code 缺失时的 key 回退：单个数字字符，1..8 */
const SIDEBAR_DIGIT_KEY_RE = /^[1-8]$/
/** 反引号的物理键位；key 在该键上随布局变化，故有 code 时只认它 */
const SIDEBAR_TOGGLE_CODE = 'Backquote'
/** code 缺失时的 key 回退：字面反引号（'~' 是 Shift 组合，已被守卫排除） */
const SIDEBAR_TOGGLE_KEY = '`'

/** 位置（1 起）→ tab；越界/非整数返回 null，不靠数组越界凑出 undefined */
function sidebarTabAt(position: number): SidebarNavTab | null {
  if (!Number.isInteger(position) || position < 1 || position > SIDEBAR_NAV_TABS.length) {
    return null
  }
  return SIDEBAR_NAV_TABS[position - 1]
}

/**
 * 共用守卫：只拦按键首按（keyUp / 长按重复不是新意图），让位 IME 组合，
 * 且仅 Alt 无 Ctrl/Cmd/Shift。匹配函数不做焦点判断，路由层各自把守。
 */
function isSidebarShortcutPress(input: SidebarShortcutInput): boolean {
  // keyDown 与 rawKeyDown 双收：Chromium 观察到的浏览器侧事件流在合并路径派发
  // keyDown，非合并路径（部分键盘布局/IME 相邻事件）派发 rawKeyDown，只认 keyDown
  // 会在这些路径失灵；同一按键两型不会成对出现，无双重触发面
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false
  if (input.isAutoRepeat) return false
  // IME 组合中的按键是候选确认/编辑操作，不是快捷键意图
  if (input.isComposing) return false
  // Ctrl/Cmd 是应用/系统快捷键，Shift 有原生选择语义，任何组合都不劫持
  if (!input.alt || input.control || input.meta || input.shift) return false
  return true
}

export function matchSidebarShortcutAction(
  input: SidebarShortcutInput
): SidebarShortcutAction | null {
  if (!isSidebarShortcutPress(input)) return null

  const code = typeof input.code === 'string' ? input.code : ''
  if (code !== '') {
    // 有 code 就以物理键位为准：布局无关，且不因 key 恰好是数字/反引号而放行 Numpad 等
    if (code === SIDEBAR_TOGGLE_CODE) return 'toggle'
    const matched = SIDEBAR_DIGIT_CODE_RE.exec(code)
    return matched ? sidebarTabAt(Number(matched[1])) : null
  }

  // code 缺失/为空才回退 key；'0'/'9'、'End'（关 NumLock 的小键盘）等都不匹配
  const key = typeof input.key === 'string' ? input.key : ''
  if (key === SIDEBAR_TOGGLE_KEY) return 'toggle'
  if (!SIDEBAR_DIGIT_KEY_RE.test(key)) return null
  return sidebarTabAt(Number(key))
}

/** 仅导航语义（旧契约）：Backquote 等非导航动作一律 null。 */
export function matchSidebarShortcut(input: SidebarShortcutInput): SidebarNavTab | null {
  const action = matchSidebarShortcutAction(input)
  return action === null || action === 'toggle' ? null : action
}
