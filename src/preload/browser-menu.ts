import { contextBridge, ipcRenderer } from 'electron'
import { BROWSER_MENU_CHANNEL, type BrowserMenuAPI } from '@shared/browser-context-menu'

const api: BrowserMenuAPI = { request: request => ipcRenderer.invoke(BROWSER_MENU_CHANNEL, request) }
contextBridge.exposeInMainWorld('browserMenu', api)
