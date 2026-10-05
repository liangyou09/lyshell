import { execFile, type ChildProcess } from 'child_process'

// 树杀失败后保留未确认状态；根退出会失去按 PID 重试的依据，不能据此解除失败。
const failedWindowsTreeCleanups = new WeakMap<ChildProcess, Error>()

/** Windows 的 SIGTERM 不执行 Node 清理回调，必须由 main 回收整棵子进程树。 */
export function terminatePluginProcess(child: ChildProcess, options: { processGroup?: boolean } = {}): Promise<void> {
  // POSIX 独立组的根进程可以先退出，后代仍在该组；不能仅凭根退出就结束清理。
  if (process.platform !== 'win32' && options.processGroup && child.pid) return terminateProcessGroup(child.pid)
  if (child.exitCode !== null || child.signalCode !== null) {
    const failure = failedWindowsTreeCleanups.get(child)
    return failure ? Promise.reject(failure) : Promise.resolve()
  }
  if (process.platform === 'win32' && child.pid) {
    return new Promise((resolve, reject) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
        if (error) {
          failedWindowsTreeCleanups.set(child, error)
          reject(error)
          return
        }
        failedWindowsTreeCleanups.delete(child)
        resolve()
      })
    })
  }
  return new Promise(resolve => {
    const finish = (): void => {
      clearTimeout(timer)
      child.removeListener('close', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
      finish()
    }, 2500)
    child.once('close', finish)
    try { child.kill('SIGTERM') } catch { finish() }
  })
}

/** detached 的 POSIX 插件根进程是组长，负 PID 信号覆盖仍存活的整组后代。 */
function terminateProcessGroup(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearInterval(poll)
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const signal = (value: NodeJS.Signals | 0): boolean => {
      try { process.kill(-pid, value); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') finish()
        else finish(error)
        return false
      }
    }
    const poll = setInterval(() => { signal(0) }, 50)
    const timer = setTimeout(() => {
      // 根进程的 close 不代表组已退出；超时仍对整组强制结束。
      if (signal('SIGKILL')) finish()
    }, 2500)
    signal('SIGTERM')
  })
}
