import type { OperationErrorCode, RetryDisposition } from './operation'

export const BROWSER_HOST_CHANNEL = 'browser-host:request'
export type BrowserHostKind = 'webview' | 'web-contents-view'
export interface BrowserHostHandle { hostId: string; generation: number; kind: BrowserHostKind }
export interface BrowserHostBounds { x: number; y: number; width: number; height: number }
export type BrowserHostPhase = 'created' | 'attached' | 'detached' | 'crashed' | 'closing' | 'close-unconfirmed' | 'closed'
export interface BrowserHostSnapshot {
  handle: BrowserHostHandle
  phase: BrowserHostPhase
  revision: number
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  bounds: BrowserHostBounds
  readonly: boolean
  protection: 'safe' | 'blocked' | 'unknown'
}
export type BrowserHostRequest =
  | { kind: 'capabilities' }
  | { kind: 'create-readonly-pilot'; url: string }
  | { kind: 'inspect' | 'attach' | 'detach' | 'back' | 'forward' | 'stop' | 'focus' | 'capture' | 'close'; host: BrowserHostHandle }
  | { kind: 'navigate'; host: BrowserHostHandle; url: string }
  | { kind: 'reload'; host: BrowserHostHandle; ignoreCache?: boolean }
  | { kind: 'bounds'; host: BrowserHostHandle; bounds: BrowserHostBounds }
  | { kind: 'visibility'; host: BrowserHostHandle; visible: boolean }

/** 两类 renderer 代理共用的导航/观察/关闭契约；具体布局仍由相应宿主管理。 */
export interface BrowserHostClient {
  readonly handle: BrowserHostHandle
  snapshot(): BrowserHostSnapshot
  navigate(url: string): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(ignoreCache?: boolean): Promise<void>
  stop(): Promise<void>
  focus(): void | Promise<void>
  capture(): Promise<string | undefined>
  close(): Promise<BrowserHostSnapshot>
  dispose(): void
}

export type BrowserHostResult =
  | { success: true; pilotEnabled?: boolean; snapshot?: BrowserHostSnapshot; image?: string }
  | { success: false; code: OperationErrorCode; error: string; retryDisposition: RetryDisposition }
