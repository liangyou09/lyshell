import { execFileSync } from 'child_process'
import { join } from 'path'
import log from 'electron-log'

/**
 * 即时读取系统 PATH —— 从 Windows 注册表拉取「用户级 + 系统级」Path 的当前值并合并。
 *
 * 背景：`process.env.PATH` 是主进程启动那一刻的固定快照，之后用户在系统设置里改环境变量
 * （系统属性对话框 / setx / reg add）不会反映进来。而 PATH 是唯一真正「会漂移」的键
 * （装 dsh/codex/claude、改 node 全局目录都动它），故这里只处理 PATH，不碰其它键——
 * 避免把 `NODE_ENV` / `LYSHELL_*` 等运行时注入变量一并覆盖。
 *
 * 设计取舍：
 * - 不修改 `process.env`（无副作用、纯读取），由调用方决定如何注入（检测用 path 参数、
 *   spawn 用 env 覆盖），避免全局变异污染其它仍在跑的代码。
 * - 用 powershell 的 `[Environment]::GetEnvironmentVariable(name, target)` 读取，它会把
 *   注册表里的 REG_EXPAND_SZ（如 `%SystemRoot%\...`）自动展开成可执行路径——`spawn`/`exec`
 *   传 env 时不会二次展开 `%VAR%`，所以必须在这里展开。
 * - 显式置 `[Console]::OutputEncoding=UTF8` 再输出 JSON，规避 `reg query` 在中文 Windows
 *   上按控制台代码页（GBK）输出导致的乱码。
 * - `execFileSync` 会同步阻塞主进程 ~100ms；只在用户动作（开终端/启动 harness/探测依赖）
 *   时调用一次，符合既有 `execSync('where node')` 的做法。若后续变热点，再考虑加 TTL 缓存。
 */

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
export function readSystemPath(): string | null {
  if (process.platform !== 'win32') return null

  const script = [
    "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    "$u=[Environment]::GetEnvironmentVariable('Path','User');",
    "$m=[Environment]::GetEnvironmentVariable('Path','Machine');",
    '[pscustomobject]@{user=$u;machine=$m}|ConvertTo-Json -Compress'
  ].join('')

  try {
    const stdout = execFileSync(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const parsed = parsePathJson(stdout)
    if (!parsed) {
      log.warn('readSystemPath: unexpected powershell output:', stdout.trim().slice(0, 200))
      return null
    }
    return combinePathParts(parsed.user, parsed.machine)
  } catch (error) {
    log.warn('readSystemPath: failed to read system PATH:', (error as Error).message)
    return null
  }
}
