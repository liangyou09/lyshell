import { existsSync, accessSync, constants } from 'fs'
import { delimiter, join } from 'path'

/**
 * AI Harness 依赖检测 —— 跨平台扫描 PATH，不 spawn 子进程。
 *
 * 检测若干命令是否可执行（dsh / dsh-tui / codex / claude）。参考既有做法：
 * http-server.ts 的 execSync('where node') 与 python/engine.ts 的 PATH 拆分。
 * 这里用纯文件系统探测，避免在渲染层触发时额外起进程。
 */

/** Windows 下按 PATHEXT 探测可执行扩展名（cmd 实际按此顺序解析命令，不含 .ps1）。
 *  npm 全局安装会生成 .cmd shim（属 PATHEXT）；.ps1 需 powershell 运行、cmd 不直接执行，
 *  故不再硬编码，避免把「仅存在 xxx.ps1」误判为可在本地终端直接启动。 */
export function windowsExecutableExtensions(): string[] {
  const pathext = process.env.PATHEXT
  if (!pathext) return ['.com', '.exe', '.bat', '.cmd']
  const exts = pathext
    .split(';')
    .map((e) => {
      const ext = e.trim().toLowerCase()
      return ext && !ext.startsWith('.') ? '.' + ext : ext
    })
    .filter(Boolean)
  return exts.length > 0 ? exts : ['.com', '.exe', '.bat', '.cmd']
}

/**
 * 在 PATH 上查找某命令是否可用（Windows 检查扩展名，POSIX 检查可执行位）。
 * `path` 缺省读 process.env.PATH；调用方可注入即时读取的系统 PATH（见 env/refresh.ts），
 * 以便在「用户改环境变量后未重启 app」时也能探测到新安装的命令。
 */
export function commandExists(command: string, path: string = process.env.PATH || ''): boolean {
  const dirs = (path || '').split(delimiter).filter(Boolean)

  if (process.platform === 'win32') {
    const exts = windowsExecutableExtensions()
    for (const dir of dirs) {
      for (const ext of exts) {
        if (existsSync(join(dir, command + ext))) return true
      }
    }
    return false
  }

  // POSIX
  for (const dir of dirs) {
    const candidate = join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      /* 不存在或无执行权限，继续 */
    }
  }
  return false
}

/**
 * 批量检测一组命令是否已安装，返回 `{ [key]: boolean }`。
 * 面板据此逐行渲染依赖状态；launch 据此判「全部就绪」。
 */
export function detectDependencies(keys: string[], path?: string): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const key of keys) result[key] = commandExists(key, path)
  return result
}
