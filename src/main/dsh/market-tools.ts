import { app } from 'electron'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { readSystemPath } from '../env/refresh'

/** pnpm 只装在 LyShell 自己的目录，不改全局 npm、系统 PATH 或用户 DSH 配置。 */
export function marketToolsDirectory(): string {
  return join(app.getPath('userData'), 'dsh-market-tools')
}

export function withMarketToolPath(env: Record<string, string>, bin: string): Record<string, string> {
  const next = { ...env }
  const keys = Object.keys(next).filter(key => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')
  const current = keys.map(key => next[key]).reverse().find(Boolean) || ''
  for (const key of keys) delete next[key]
  next.PATH = [bin, current].filter(Boolean).join(delimiter)
  return next
}

/** 在启动环境冻结之前注入本地工具，后台与安装器使用同一份 PATH。 */
export function withInstalledMarketTools(env: Record<string, string> | undefined): Record<string, string> | undefined {
  const bin = join(marketToolsDirectory(), 'node_modules', '.bin')
  if (!existsSync(join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'))) return env
  const basePath = readSystemPath() || process.env.PATH || ''
  return withMarketToolPath({ PATH: basePath, ...env }, bin)
}
