/** 仅承载内嵌 DevTools 的内存会话，不与普通网页共享 preload / 登录态。 */
export const BROWSER_DEVTOOLS_PARTITION = 'browser-devtools'
export const BROWSER_DEVTOOLS_CHANNEL = 'web-tab:devtools'
export const BROWSER_DEVTOOLS_EVENT = 'web-tab:devtools-event'

export interface BrowserDevToolsBounds { x: number; y: number; width: number; height: number }
export type BrowserDevToolsRequest =
  | { kind: 'open'; pageId: number; bounds: BrowserDevToolsBounds }
  | { kind: 'layout'; pageId: number; inspectorId: number; bounds: BrowserDevToolsBounds | null }
  | { kind: 'close'; pageId: number; inspectorId: number }
export interface BrowserDevToolsEvent { kind: 'focus' | 'closed'; pageId: number; inspectorId: number }
