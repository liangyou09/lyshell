import { ElectronAPI } from '../preload/index'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
  /** 编译期开关:true 表示当前构建不包含 MCP(与 main 的 __DISABLE_MCP__ 同源,见 electron.vite.config.ts) */
  const __DISABLE_MCP__: boolean
}

export {}