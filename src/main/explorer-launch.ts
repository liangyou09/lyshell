import { statSync } from 'fs'
import { win32 } from 'path'

/** 仅解析目录，不把路径拼进 shell 命令；保留空格、中文和特殊字符。 */
export function parseExplorerDirectory(
  args: string[],
  workingDirectory: string,
  implicitLaunch: boolean,
  explorerDirectory: string | null = null
): string | null {
  const index = args.indexOf('--open-directory')
  const inline = args.find(arg => arg.startsWith('--open-directory='))
  const directory = index >= 0 ? args[index + 1] : inline?.slice('--open-directory='.length)
  if (index >= 0 || inline !== undefined) {
    if (!directory || directory.startsWith('--') || directory.includes('\0')) return null
    return win32.resolve(workingDirectory, directory)
  }
  // App Paths 启动 cwd 可能是安装目录，地址栏优先采用前台 Explorer 活动页签目录。
  // 开发模式和带其它参数的启动保持原行为（例如 --demo-stage）。
  return implicitLaunch && args.length === 0 ? explorerDirectory ?? workingDirectory : null
}

export function validateExplorerDirectory(directory: unknown): string | null {
  if (typeof directory !== 'string' || !directory || directory.length > 32767 ||
      directory.includes('\0') || !win32.isAbsolute(directory)) return null
  try {
    const normalized = win32.normalize(directory)
    return statSync(normalized).isDirectory() ? normalized : null
  } catch {
    return null
  }
}

/** 冷启动先排队，renderer 装好订阅并加载保存项后再认领；通知丢失也能主动拉取。 */
export class ExplorerLaunchQueue {
  consumerId: number | null = null
  private directories: string[] = []

  enqueue(directory: string): void {
    this.directories.push(directory)
  }

  takeAll(): string[] {
    return this.directories.splice(0)
  }
}

export const explorerLaunchQueue = new ExplorerLaunchQueue()
