import type { FileInfo } from '@shared/types'
import { compileGlob, relPath } from './glob'

export const LIST_SCAN_LIMIT = 10000
export const LIST_DIRECTORY_LIMIT = 256
export const LIST_TIME_LIMIT_MS = 5000

export async function listFilesBounded(rootPath: string, listDir: (dir: string) => Promise<FileInfo[]>, options: {
  recursive: boolean; glob?: string; maxEntries: number; signal: AbortSignal
}): Promise<{ entries: FileInfo[]; truncated: boolean; reason?: string; scannedEntries: number; visitedDirectories: number }> {
  // 预取消必须在编译/计时器/监听器之前：已断开的请求不产生任何 glob 分配，
  // 也不留下 listDir 或定时器（否则 5s 计时器白等一个已放弃的请求）。
  if (options.signal.aborted) {
    return { entries: [], truncated: true, reason: 'cancelled', scannedEntries: 0, visitedDirectories: 0 }
  }
  // compileGlob 在分配 token 前检查模式长度上限；超长模式在此抛出，不会发起 listDir。
  const matcher = options.glob ? compileGlob(options.glob) : undefined
  const root = rootPath.replace(/\/+$/, '') || '/'
  const entries: FileInfo[] = []
  const queue = [root]
  const seen = new Set<string>()
  const started = Date.now()
  let scannedEntries = 0
  let visitedDirectories = 0
  let reason: string | undefined
  let directoryReadError = false
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) controller.abort()
  const timer = setTimeout(() => { reason = 'time limit'; controller.abort() }, LIST_TIME_LIMIT_MS)
  const stopped = () => {
    if (controller.signal.aborted) { reason ??= 'cancelled'; return true }
    if (Date.now() - started >= LIST_TIME_LIMIT_MS) { reason = 'time limit'; return true }
    return false
  }
  try {
    while (queue.length && !stopped()) {
      if (visitedDirectories >= LIST_DIRECTORY_LIMIT) { reason = 'directory limit'; break }
      const dir = queue.shift()!
      if (seen.has(dir)) continue
      seen.add(dir)
      visitedDirectories++
      let files: FileInfo[]
      try {
        // 不能为取消一个请求而拆掉其他文件操作共用的 SSH 连接。
        // 最多留下一次已发出的 listDir；其落定被消费，但不再调度/回写。
        files = await new Promise<FileInfo[]>((resolve, reject) => {
          const onAbort = () => { controller.signal.removeEventListener('abort', onAbort); reject(new Error('Listing cancelled')) }
          controller.signal.addEventListener('abort', onAbort, { once: true })
          void listDir(dir).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort))
        })
      } catch (error) {
        if (stopped()) break
        // 根目录失败必须反馈错误；递归子目录维持跳过策略，但标明结果不完整。
        if (dir === root) throw error
        directoryReadError = true
        continue
      }
      for (const file of files) {
        if (stopped()) break
        if (scannedEntries >= LIST_SCAN_LIMIT) { reason = 'scan limit'; break }
        scannedEntries++
        // 即使每个匹配都很短，也定期让出事件循环以接收 close/abort。
        if (scannedEntries % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
        if (stopped()) break
        const matched = !matcher || await matcher.matchAsync(relPath(root, file.path), stopped)
          || await matcher.matchAsync(file.name, stopped)
        if (stopped()) break
        if (matched) {
          if (entries.length >= options.maxEntries) { reason = 'result limit'; break }
          entries.push(file)
        }
        if (options.recursive && file.isDir) {
          if (queue.length + seen.size >= LIST_DIRECTORY_LIMIT) { reason = 'directory limit'; break }
          queue.push(file.path)
        }
      }
      if (reason) break
    }
    if (directoryReadError) reason ??= 'directory read error'
    return { entries, truncated: Boolean(reason), ...(reason ? { reason } : {}), scannedEntries, visitedDirectories }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}
