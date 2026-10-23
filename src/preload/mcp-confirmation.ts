import { contextBridge, ipcRenderer } from 'electron'
import { MCP_CONFIRMATION_CHANNEL, MCP_CONFIRMATION_THEME, type McpConfirmationAPI } from '@shared/mcp-confirmation'

const api: McpConfirmationAPI = {
  request: request => ipcRenderer.invoke(MCP_CONFIRMATION_CHANNEL, request),
  onTheme: callback => {
    const listener = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark') => callback(theme)
    ipcRenderer.on(MCP_CONFIRMATION_THEME, listener)
    return () => ipcRenderer.removeListener(MCP_CONFIRMATION_THEME, listener)
  }
}
contextBridge.exposeInMainWorld('mcpConfirmation', api)
