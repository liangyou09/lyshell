/** 等待所有退出清理；单项失败不能截断其他清理，超时只作为退出兜底。 */
export async function waitForQuitCleanup(
  cleanups: readonly Promise<unknown>[], timeoutMs: number, onError: (error: unknown) => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      onError(new Error('Application cleanup timed out'))
      resolve()
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([
      Promise.all(cleanups.map(cleanup => cleanup.catch(onError))),
      budget
    ])
  } finally {
    clearTimeout(timer)
  }
}
