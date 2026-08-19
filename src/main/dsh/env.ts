import { isAbsolute } from 'path'
import { expandTilde } from '../harness/cwd'

export type NormalizedEnvResult = { ok: true; env?: Record<string, string> } | { ok: false; error: string }

/**
 * 校验并归一化工作区 env 里的 DSH_HOME（dsh 专属，codex/claude 无需）。
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
    // 不带 workspace. 前缀：同一条校验现在也从「变量组」保存路径冒出来，措辞须两处都成立
    return { ok: false, error: 'DSH_HOME must be an absolute path' }
  }
  return { ok: true, env: { ...env, DSH_HOME: expanded } }
}
