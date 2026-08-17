import { existsSync, accessSync, constants } from 'fs'
import { delimiter, join } from 'path'

/**
 * DeepSeek Harness (dsh) 依赖检测 —— 跨平台扫描 PATH，不 spawn 子进程。
 *
 * 检测两个命令是否可执行：
 *   - `dsh`     : DeepSeek Harness 官方 CLI（@deepseek-ai/dsh）
 *   - `dsh-tui` : 社区 TUI 插件（@deepseek-harness-tui/dsh-tui）
 *
 * 参考既有做法：http-server.ts 的 execSync('where node') 与 python/engine.ts 的 PATH 拆分。
 * 这里用纯文件系统探测，避免在渲染层触发时额外起进程。
 */

/** Windows 下按 PATHEXT 探测可执行扩展名（cmd 实际按此顺序解析命令，不含 .ps1）。
 *  npm 全局安装会生成 .cmd shim（属 PATHEXT）；.ps1 需 powershell 运行、cmd 不直接执行，
 *  故不再硬编码，避免把「仅存在 dsh.ps1」误判为可在本地终端直接启动。 */
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

/** 在 PATH 上查找某命令是否可用（Windows 检查扩展名，POSIX 检查可执行位） */
export function commandExists(command: string): boolean {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)

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

export interface DshInstallationStatus {
  dsh: boolean
  dshTui: boolean
}

/** 检测 dsh 与 dsh-tui 是否已安装 */
export function detectDshInstallation(): DshInstallationStatus {
  return {
    dsh: commandExists('dsh'),
    dshTui: commandExists('dsh-tui')
  }
}
