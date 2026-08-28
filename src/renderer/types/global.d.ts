import { ElectronAPI } from '../preload/index'
import type { WebviewTag } from 'electron'
import type * as React from 'react'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  /** 应用版本号 —— electron.vite.config.ts 编译期注入（来自 package.json 的 version） */
  const __APP_VERSION__: string
}

// Electron <webview> 标签 —— React 18 未内置其 JSX 类型，须手动声明。
// 元素类型用 Electron 的 WebviewTag（而非裸 HTMLElement）：ref 与 webview 专属
// 方法/事件类型随之可用，减少组件侧手写断言。
// 用于加载 dsh web（127.0.0.1 本地回环，origin 锁定）与网页访问栏（persist:webbar，仅放行
// http/https）；导航/弹窗由主进程 will/did-attach-webview 按 partition 分流锁定（见 main/index.ts）。
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<WebviewTag>, WebviewTag> & {
        src?: string
        partition?: string
        allowpopups?: string
      }
    }
  }
}

export {}
