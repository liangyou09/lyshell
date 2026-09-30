import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 根级错误边界：兜住任何渲染期/副作用未捕获异常。
 * 没有它时异常会让整棵 React 树卸载，只剩 body 的 #0D1116 背景 ——
 * 表现为无提示的"全局黑屏"（进程活着、日志干净，极难排查）。
 * 兜底 UI 给出错误摘要 + 重载按钮；细节留在控制台供排查。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 渲染树异常，已阻止整树卸载:', error, '\n组件栈:', info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-[#0D1116] p-8 text-slate-300">
        <div className="text-base font-medium text-slate-100">界面出现异常</div>
        <div className="max-w-[720px] max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded bg-[#161B22] p-3 text-xs text-slate-400">
          {error.message || String(error)}
        </div>
        <button
          className="mt-2 rounded bg-[#21262D] px-4 py-1.5 text-sm text-slate-200 hover:bg-[#30363D]"
          onClick={() => location.reload()}
        >
          重新加载
        </button>
      </div>
    )
  }
}
