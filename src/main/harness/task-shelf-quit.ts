/** 主窗口按页签变化登记 ID；退出只从主进程运行态读取恢复数据，不向已销毁的 renderer 索取现场。 */
let terminalTabs: string[] = []
let collector: ((ids: readonly string[]) => void) | undefined
let collected = false

export function setTaskShelfTerminalTabs(ids: readonly string[]): void {
  terminalTabs = [...ids]
  collected = false
}

export function setTaskShelfQuitCollector(next: (ids: readonly string[]) => void): void {
  collector = next
  collected = false
}

/** 收集器内部原子落盘、去重；退出前及清理后的兜底可安全重复调用。 */
export function recycleTaskShelfTerminalsForQuit(): void {
  if (collected || !collector) return
  collector(terminalTabs)
  collected = true
}
