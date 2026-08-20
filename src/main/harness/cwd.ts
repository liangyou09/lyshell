import { statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'

/**
 * 工作目录校验（AI Harness 通用，dsh/codex/claude 共用）。
 * node-pty 不会展开 `~`（local.ts 将 cwd 原样传入），故在保存与启动前先在此归一化。
 */

/** 展开工作目录里的 `~` 为当前用户 home 目录（支持 `~`、`~/xxx` 与 Windows `~\xxx`） */
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
 * 用于 harness 启动前 —— node-pty spawn 失败是异步的、无法回传给调用方，
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
