import { statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'

/**
 * 展开工作目录里的 `~` 为当前用户 home 目录。
 * node-pty 不会展开 `~`（local.ts 将 cwd 原样传入），故在保存与启动前先在此归一化。
 * 支持 `~`、`~/xxx`（POSIX）与 `~\xxx`（Windows）。
 */
export function expandTilde(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return trimmed
}

export type ResolvedCwd = { ok: true; path: string } | { ok: false; error: string }

/**
 * 校验工作目录：展开 `~` 后须为绝对路径且存在（目录）。
 * 用于 dsh:workspace:launch 启动前 —— node-pty spawn 失败是异步的、无法回传给调用方，
 * 故在创建瞬态会话前先拒绝无效目录。
 */
export function resolveWorkspaceCwd(input: string): ResolvedCwd {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'workspace.cwd is required' }
  }
  const expanded = expandTilde(trimmed)
  if (!isAbsolute(expanded)) {
    return { ok: false, error: 'workspace.cwd must be an absolute path' }
  }
  try {
    if (!statSync(expanded).isDirectory()) {
      return { ok: false, error: 'workspace.cwd is not a directory' }
    }
  } catch {
    return { ok: false, error: 'workspace.cwd does not exist' }
  }
  return { ok: true, path: expanded }
}

export type NormalizedEnvResult = { ok: true; env?: Record<string, string> } | { ok: false; error: string }

/**
 * 校验并归一化工作区 env 里的 DSH_HOME。
 * - 空值/纯空白：视为未设置，删除该键回落默认。否则子进程会读到 `DSH_HOME=""`，
 *   而主进程按默认路径写补丁，写入/读取位置错位。
 * - 相对路径：主进程与子进程各自相对不同 cwd 解析，同样错位，故拒绝（须绝对路径）。
 * 返回归一化后的 env（可能删除了 DSH_HOME 键），或校验错误。
 */
export function normalizeDshHomeEnv(env: Record<string, string> | undefined): NormalizedEnvResult {
  if (!env || env.DSH_HOME === undefined) return { ok: true, env }
  const raw = env.DSH_HOME.trim()
  if (raw.length === 0) {
    const next = { ...env }
    delete next.DSH_HOME
    return { ok: true, env: Object.keys(next).length > 0 ? next : undefined }
  }
  const expanded = expandTilde(raw)
  if (!isAbsolute(expanded)) {
    return { ok: false, error: 'workspace.env.DSH_HOME must be an absolute path' }
  }
  return { ok: true, env: { ...env, DSH_HOME: expanded } }
}
