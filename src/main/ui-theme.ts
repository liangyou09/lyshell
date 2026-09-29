/**
 * 界面明暗模式快照（main 侧持有）
 *
 * LyShell 的主题只存在于 renderer（localStorage + <html data-theme-mode>），main
 * 平时不感知。插件视图页面（sandbox guest）又够不着主窗口的 DOM —— 因此 renderer
 * 在应用/切换主题时经 UI_THEME_MODE 把明暗模式推给 main，这里存一份快照：
 *   - view-bridge 的 bootstrap() 从这里取 theme 填进握手负载；
 *   - 模式变化时 view-bridge 向所有在册 guest 广播 themeChanged 事件（见下方
 *     listener 的回调注入，避免本模块依赖 electron/bridge）。
 *
 * 未推送前的缺省值是 dark（默认主题 Graphite 即暗色）；晚到的旧值由下一次推送覆盖，
 * 单 renderer 场景无并发序问题。
 */

export type UiThemeMode = 'dark' | 'light'

let mode: UiThemeMode = 'dark'

/** 模式变化时的回调（main 装配时注入：向所有在册 guest 广播 themeChanged） */
let onChange: ((m: UiThemeMode) => void) | null = null

/** renderer 推送落点：只接受 'dark' | 'light'，其余值静默忽略（来自不受信 IPC） */
export function setRendererThemeMode(value: unknown): void {
  if (value !== 'dark' && value !== 'light') return
  if (value === mode) return
  mode = value
  onChange?.(mode)
}

/** 当前快照（bootstrap 填 theme 字段用） */
export function getRendererThemeMode(): UiThemeMode {
  return mode
}

/** main 启动装配：注入「模式变化 → 广播」回调（view-bridge 提供，避免环依赖） */
export function setUiThemeModeListener(fn: (m: UiThemeMode) => void): void {
  onChange = fn
}

/** 测试隔离用：复位快照与回调 */
export function resetUiThemeModeForTest(): void {
  mode = 'dark'
  onChange = null
}
