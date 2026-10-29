/** 侧栏恢复回执返回前，连接状态通知不能抢先把终端放到主区。 */
const pendingRestores = new Set<Promise<void>>()

export function beginShelfTerminalRestore(): () => void {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  pendingRestores.add(pending)
  let released = false
  return () => {
    if (released) return
    released = true
    pendingRestores.delete(pending)
    finish()
  }
}

/** 只等待通知到达时已在途的恢复，不阻塞之后新发起的任务。 */
export function waitForShelfTerminalRestores(): Promise<void> {
  return Promise.all([...pendingRestores]).then(() => undefined)
}
