import { execFile } from 'child_process'
import { join } from 'path'
import log from 'electron-log'

/** 异步注册表 PATH 快照；同轮请求合并，五秒缓存，显式检测可强制刷新。 */
const PATH_TTL_MS = 5000
let cachedPath: string | null = null
let cachedAt = 0
let pendingPath: Promise<string | null> | undefined

/** 同步环境物化只能读已确认快照，绝不启动进程。 */
export function getCachedSystemPath(): string | null { return cachedPath }

/** 解析 powershell 回显的 JSON，容错：非对象 / 非字符串值一律回落空串。纯函数。 */
export function parsePathJson(stdout: string): { user: string; machine: string } | null {
  let obj: unknown
  try {
    obj = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const record = obj as Record<string, unknown>
  return {
    user: typeof record.user === 'string' ? record.user : '',
    machine: typeof record.machine === 'string' ? record.machine : ''
  }
}

/** 合并用户级 + 系统级 Path 为生效 PATH（Windows 用 `;` 分隔，用户在前）。纯函数。 */
export function combinePathParts(user: string, machine: string): string | null {
  const parts = [user.trim(), machine.trim()].filter((p) => p.length > 0)
  return parts.length > 0 ? parts.join(';') : null
}

/** 定位 Windows PowerShell 5.1（全路径，不依赖 PATH 本身，PATH 可能已被改坏）。 */
function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 读取当前生效的系统 PATH（用户级 + 系统级，已展开 `%VAR%`）。
 * 非 Windows 或读取失败时返回 null，调用方回落 `process.env.PATH`。best-effort，绝不抛。
 */
export function readSystemPath(force = false): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (pendingPath) return pendingPath
  if (!force && cachedAt && Date.now() - cachedAt < PATH_TTL_MS) return Promise.resolve(cachedPath)
  const script = [
    "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    "$u=[Environment]::GetEnvironmentVariable('Path','User');",
    "$m=[Environment]::GetEnvironmentVariable('Path','Machine');",
    '[pscustomobject]@{user=$u;machine=$m}|ConvertTo-Json -Compress'
  ].join('')
  pendingPath = new Promise<string | null>(resolve => {
    execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        const parsed = error ? null : parsePathJson(stdout)
        if (error || !parsed) log.warn('readSystemPath: failed to read system PATH')
        resolve(parsed ? combinePathParts(parsed.user, parsed.machine) : null)
      })
  }).then(value => { cachedPath = value; cachedAt = Date.now(); return value })
    .finally(() => { pendingPath = undefined })
  return pendingPath
}
