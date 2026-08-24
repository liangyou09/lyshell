import { ElectronAPI } from '../preload/index'
import type * as React from 'react'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  /** 应用版本号 —— electron.vite.config.ts 编译期注入（来自 package.json 的 version） */
  const __APP_VERSION__: string
}

// Electron <webview> 标签 —— React 18 未内置其 JSX 类型，须手动声明。
// 仅用于加载 dsh web（127.0.0.1 本地回环）；导航/弹窗由主进程 did-attach-webview 锁定（见 main/index.ts）。
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
      }
    }
  }
}

export {}
