import type { BrowserMenuData } from './browser-context-menu'

/** 只传递宿主的界面色值；网站内容不能提供菜单样式。 */
export interface BrowserMenuPalette {
  surface: string; hover: string; text: string; muted: string; rule: string; accent: string
}
export type BrowserMenuWindowData = BrowserMenuData & { palette?: BrowserMenuPalette }
