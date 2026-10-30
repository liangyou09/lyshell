import { createLocalCommandExecution, type LocalCommandDeps } from '../commands/local-command-core'

/**
 * 兼容导出：旧调用方只消费结果与增量输出。
 *
 * 需要取消、资源关闭确认（resourceClosed）或输出预算预占的调用方应改用
 * createLocalCommandExecution / CommandService；本函数只返回 result。
 * 末位 deps 仅供测试固定平台分支，生产调用不传。
 */
export function executeLocalCommandStream(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeout: number,
  onData: (chunk: string) => void,
  signal?: AbortSignal,
  deps?: LocalCommandDeps
): Promise<{ output: string; exitCode: number }> {
  return createLocalCommandExecution({ command, cwd, env, timeoutMs: timeout, onData, signal }, deps).result
}

export { createLocalCommandExecution } from '../commands/local-command-core'
export type { LocalCommandDeps, LocalCommandOptions } from '../commands/local-command-core'
