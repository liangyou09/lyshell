/**
 * 网页页签快捷键匹配（纯函数，主进程 before-input-event 与渲染层宿主 keydown 共用语义，
 * 故放 shared —— 两 bundle 各自编译，跨 bundle 引用只有 shared 可达）。
 *
 * 手势集（对齐浏览器惯例）：
 * - Ctrl/Cmd+R（无 Shift）刷新 / +Shift 强制刷新（忽略缓存）
 * - Alt+← / Alt+→（无 Ctrl）后退 / 前进
 * - Ctrl/Cmd+L 聚焦地址栏（渲染层切到 Web 面板并聚焦 URL 输入框）
 *
 * 拦截范围约束（两侧路由层各自把守，匹配函数本身不判断焦点）：
 * - 渲染层宿主 keydown：仅当活动分屏正显示网页页签时拦。xterm 只对「无 Shift 的
 *   Ctrl+字母」发控制字符（Ctrl+R=\x12 是 bash 反向搜索、Ctrl+L=\x0C 清屏），
 *   焦点在别的分屏终端时 activePaneId 跟着那 pane 走 → 路由层 no-op，终端原生
 *   行为不被劫持。
 * - 主进程 before-input-event：焦点在 webview 内，键盘全被 guest 吃掉，宿主
 *   keydown 收不到 —— 在 guest 事件分发前拦截（仅 webbar partition，dsh 锁定不挂）。
 */

export type WebTabShortcutAction =
  | 'reload'
  | 'reload-hard'
  | 'back'
  | 'forward'
  | 'focus-address-bar'

/** IPC 转发后的 action 白名单（preload 边界值校验用） */
const WEB_TAB_ACTIONS: ReadonlySet<string> = new Set<WebTabShortcutAction>([
  'reload', 'reload-hard', 'back', 'forward', 'focus-address-bar'
])

/** preload 边界到达的 action 不可信：白名单收窄后才路由（防 IPC 复用/注入） */
export function isWebTabShortcutAction(v: unknown): v is WebTabShortcutAction {
  return typeof v === 'string' && WEB_TAB_ACTIONS.has(v)
}

/** before-input-event 的 input 形状（Electron Input；type: 'keyDown' | 'keyUp' | 'rawKeyDown' …） */
export interface ShortcutInputShape {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat: boolean
  meta?: boolean
  /** IME 组合中的按键（Electron Input / DOM KeyboardEvent 同名同义） */
  isComposing?: boolean
}

export function matchWebTabShortcut(input: ShortcutInputShape): WebTabShortcutAction | null {
  // 只拦按键的首按：keyUp / 长按 autoRepeat 都不是用户的新意图。keyDown 与
  // rawKeyDown 双收：Chromium 观察到的浏览器侧事件流,合并路径派发 keyDown
  // (常规键),非合并路径(部分键盘布局/IME 相邻事件)派发 rawKeyDown —— 只认
  // keyDown 会让 webview 内拦截在这些路径下失灵。同一按键两型不会成对出现
  // (合并路径里 rawKeyDown 被并入 keyDown,不再单独转发),无双重触发面
  if ((input.type !== 'keyDown' && input.type !== 'rawKeyDown') || input.isAutoRepeat) {
    return null
  }
  // IME 组合中的按键是候选确认/编辑操作,不是快捷键意图 —— 让位给输入法
  if (input.isComposing) return null
  const ctrl = input.control || (input.meta ?? false)
  const key = input.key.toLowerCase()

  if (ctrl && !input.alt) {
    if (key === 'r') return input.shift ? 'reload-hard' : 'reload'
    if (key === 'l' && !input.shift) return 'focus-address-bar'
    return null
  }
  if (input.alt && !ctrl && !input.shift) {
    if (input.key === 'ArrowLeft') return 'back'
    if (input.key === 'ArrowRight') return 'forward'
  }
  return null
}
