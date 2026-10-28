/**
 * 远端可续接终端（tmux）纯函数层
 *
 * 这里只做「名字 → 命令」的确定性转换，不碰网络、不碰状态：
 *  - 远端会话名只允许 [A-Za-z0-9_-]，且必须以字母或数字开头；
 *  - 所有拼进远端 shell 的参数都经过 POSIX 单引号转义；
 *  - tmux 目标一律用 `=名字` 精确匹配，避免 tmux 的前缀匹配误伤别人的会话。
 *
 * 之所以要独立的纯函数文件：可续接终端会把用户/保存区提供的会话名拼进远端命令，
 * 必须能脱离 ssh2 单测「任何非法字符都进不了命令行」。
 */

import { createHash } from 'node:crypto'

/** LyShell 自己创建的 tmux 会话统一前缀，便于识别归属。 */
export const REMOTE_SESSION_NAME_PREFIX = 'lyshell-'

/** tmux 会话名长度上限（含前缀），过长的名字在 cramped 状态下难辨认且易截断。 */
export const MAX_REMOTE_SESSION_NAME_LENGTH = 64

/** 合法字符：只允许字母、数字、下划线和连字符。 */
const SAFE_REMOTE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** `prlimit`… 之外的候选路径：非登录 shell 的 PATH 常常缺 sbin/homebrew。 */
const TMUX_CANDIDATE_PATHS = [
  '/usr/bin/tmux',
  '/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/sbin/tmux',
  '/opt/homebrew/bin/tmux',
  '/opt/local/bin/tmux',
  '$HOME/bin/tmux',
  '$HOME/.local/bin/tmux'
]

/** `ensure` 脚本的退出码：没有该会话（恢复失败）。 */
export const TMUX_EXIT_SESSION_MISSING = 3

/** `ensure` 脚本的退出码：创建会话失败。 */
export const TMUX_EXIT_CREATE_FAILED = 4

/**
 * 校验远端会话名是否安全可用。
 * 只做白名单判断，不做任何「过滤掉非法字符」的猜测式修复 —— 调用方拿到 null 必须报错。
 */
export function isSafeRemoteSessionName(name: string): boolean {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > MAX_REMOTE_SESSION_NAME_LENGTH) return false
  return SAFE_REMOTE_SESSION_NAME.test(name)
}

/**
 * 校验并归一化来自配置/保存区的会话名。
 * 前后空白允许（保存区可能带换行），其余一律不放行。
 */
export function sanitizeRemoteSessionName(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return isSafeRemoteSessionName(trimmed) ? trimmed : null
}

/** 稳定散列，仅用于把不合法/过长的 id 压成一段安全后缀。 */
function stableSuffix(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 20)
}

/**
 * 由 runtime session id 派生远端 tmux 会话名。
 *
 * 同一 runtime 终端每次重连都得到同一个名字，因此「链路断了但远端还在」时可以说
 * attach 回原会话；不同终端之间不会撞名。名字不合法时退回稳定散列，保证确定性。
 */
export function deriveRemoteSessionName(runtimeSessionId: string): string {
  const raw = typeof runtimeSessionId === 'string' ? runtimeSessionId : ''
  const sanitized = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')

  const budget = MAX_REMOTE_SESSION_NAME_LENGTH - REMOTE_SESSION_NAME_PREFIX.length
  // 过滤或截断会使不同 ID 同名，必须保留原始 ID 的摘要。
  const suffix = sanitized === raw && raw.length > 0 && raw.length <= budget
    ? raw : `${sanitized.slice(0, Math.max(0, budget - 21))}-${stableSuffix(raw)}`
  const name = REMOTE_SESSION_NAME_PREFIX + suffix
  // 兜底：前缀 + 空串不该出现，但真出现时用散列而不抛错（派生必须总能给出可用名）。
  if (isSafeRemoteSessionName(name)) return name
  return REMOTE_SESSION_NAME_PREFIX + stableSuffix(raw)
}

/**
 * POSIX 单引号转义。
 * 单引号内的字符不会被 shell 解释，唯一需要处理的是单引号本身（`'` → `'\''`）。
 */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * 探测远端 tmux 绝对路径。
 *
 * 用 `sh -c`（不用 `-l`：登录 profile 的输出版本噪声会污染 stdout）。
 * 先信任 PATH 里的 tmux，再逐个试常见绝对路径（非登录 shell 的 PATH 常缺 /usr/local/bin）。
 */
export function buildTmuxProbeCommand(): string {
  const candidates = TMUX_CANDIDATE_PATHS.map(path => `"${path}"`).join(' ')
  return [
    'FOUND=$(command -v tmux 2>/dev/null || true)',
    'case "$FOUND" in',
    '  /*) printf \'%s\\n\' "$FOUND"; exit 0;;',
    'esac',
    `for candidate in ${candidates}; do`,
    '  if [ -x "$candidate" ]; then printf \'%s\\n\' "$candidate"; break; fi',
    'done'
  ].join('\n')
}

/** 从探测输出里取第一个绝对路径（忽略 PATH 别名、空行与噪声）。 */
export function parseTmuxPath(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const value = line.trim()
    if (!value) continue
    if (!value.startsWith('/')) continue
    if (value.includes('\0')) continue
    return value
  }
  return null
}

/**
 * 确保远端会话就绪。`create=false` 时绝不允许创建同名会话 —— 恢复路径必须
 * 如实报告「原现场已结束」，不能把新建会话冒充成恢复成功。
 *
 * 输出 `created` / `existing` 供调用方区分「本次创建」与「复用残留」。
 */
export function buildTmuxEnsureSessionCommand(options: {
  tmuxPath: string
  sessionName: string
  create: boolean
}): string {
  const { tmuxPath, sessionName, create } = options
  const target = shellQuote(`=${sessionName}`)
  const lines = [
    `TMUX_BIN=${shellQuote(tmuxPath)}`,
    `TARGET=${target}`,
    'if "$TMUX_BIN" has-session -t "$TARGET" 2>/dev/null; then',
    "  printf 'existing\\n'",
    '  exit 0',
    'fi'
  ]
  if (create) {
    lines.push(
      `if "$TMUX_BIN" new-session -d -s ${shellQuote(sessionName)} >/dev/null 2>&1; then`,
      "  printf 'created\\n'",
      '  exit 0',
      'fi',
      `exit ${TMUX_EXIT_CREATE_FAILED}`
    )
  } else {
    lines.push(`exit ${TMUX_EXIT_SESSION_MISSING}`)
  }
  return lines.join('\n')
}

/** 附着到已有会话（带 pty 的交互通道）。 */
export function buildTmuxAttachCommand(options: { tmuxPath: string; sessionName: string }): string {
  return `${shellQuote(options.tmuxPath)} attach-session -t ${shellQuote(`=${options.sessionName}`)}`
}

/** 销毁会话：只对 LyShell 自己创建且未被收纳的会话使用。 */
export function buildTmuxKillSessionCommand(options: { tmuxPath: string; sessionName: string }): string {
  return `${shellQuote(options.tmuxPath)} kill-session -t ${shellQuote(`=${options.sessionName}`)}`
}
