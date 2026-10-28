/** 恢复队列只等真实导航结束；UI 等待超时不删除这里的在途记录。 */
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
export function waitForBrowserLoad(id: string): Promise<void> {
  if (pending.has(id)) throw new Error('Browser navigation already tracked')
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }) })
}
export function settleBrowserLoad(id: string, error?: string): void {
  const item = pending.get(id)
  if (!item) return
  pending.delete(id)
  if (error) item.reject(new Error(error)); else item.resolve()
}
