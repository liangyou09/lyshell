import { contextBridge, ipcRenderer } from 'electron'
import { BROWSER_PROMPT_ACTION, BROWSER_PROMPT_GET, BROWSER_PROMPT_THEME, type BrowserPromptAPI } from '@shared/browser-prompt'

const api: BrowserPromptAPI = {
  get: () => ipcRenderer.invoke(BROWSER_PROMPT_GET),
  action: action => ipcRenderer.invoke(BROWSER_PROMPT_ACTION, action),
  onTheme: callback => {
    const listener = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark') => callback(theme)
    ipcRenderer.on(BROWSER_PROMPT_THEME, listener)
    return () => ipcRenderer.removeListener(BROWSER_PROMPT_THEME, listener)
  }
}
contextBridge.exposeInMainWorld('browserPrompt', api)
