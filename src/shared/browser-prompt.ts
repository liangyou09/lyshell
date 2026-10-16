export const BROWSER_PROMPT_GET = 'browser:prompt:get'
export const BROWSER_PROMPT_ACTION = 'browser:prompt:action'
export const BROWSER_PROMPT_THEME = 'browser:prompt:theme'

export type BrowserPromptContent = { kind: 'password'; origin: string; username: string }

export interface BrowserPromptData {
  content: BrowserPromptContent
  locale: 'zh' | 'en'
  theme: 'light' | 'dark'
}
export type BrowserPromptAction = { kind: 'ready' | 'cancel' | 'confirm' }
export interface BrowserPromptResult { success: boolean; error?: 'saveFailed' | 'unavailable' }
export interface BrowserPromptAPI {
  get(): Promise<BrowserPromptData | null>
  action(action: BrowserPromptAction): Promise<BrowserPromptResult>
  onTheme(callback: (theme: 'light' | 'dark') => void): () => void
}
