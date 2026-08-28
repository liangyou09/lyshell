/**
 * worktree key 纯函数（main �?renderer 共用，不得依�?Node/Electron）�? *
 * key 同时�?.lyshell-worktrees/ 下的一级目录名与分支名 lyshell/<key>�? *   - validateWorktreeKey / sanitizeRefSegment �?main/harness/worktree.ts 下沉而来（单一事实源，
 *     两侧共用同一套校验规则，避免渲染层自动生成的 key 在保存时被主进程拒绝）；
 *   - generateWorktreeCode / generateWorktreeKey 供渲染层在「选择 worktree 隔离」时自动生成
 *     <kind>-<工作区名>-<随机代号> 形态的可读 key（随机代号保证同名工作区不意外共用）�? */
export const WORKTREE_DIR = '.lyshell-worktrees'
export const BRANCH_PREFIX = 'lyshell'

/**
 * 校验 worktree 共享名（worktreeKey）：trim 后非空、≤64 字符、非 ./..、不含路径分隔符�? �?\），
 * �?sanitizeRefSegment 往返一致（即不含会被折叠的空白/ref 非法字符、不�?-/. 开头结尾）�? * 用往返一致而非另写一套白名单，保证「保存的名字 === 实际的目录名与分支名」—�?两个只差一�? * 空格的键折叠成同一�?worktree 是最坏的静默歧义；显式拒绝分隔符则是防嵌套目录与嵌套分支
 * �?a/b' 能过往返校验，但会落到 .lyshell-worktrees/a/b 并建 lyshell/a/b，下拉也只显示首段）�? * 中文�?Unicode 字母合法（git ref 支持）�? */
export function validateWorktreeKey(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, error: 'workspace.worktreeKey must not be empty' }
  if (trimmed.length > 64) return { ok: false, error: 'workspace.worktreeKey must be at most 64 characters' }
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    return { ok: false, error: 'workspace.worktreeKey must not be ., .., or contain path separators' }
  }
  if (sanitizeRefSegment(trimmed) !== trimmed) {
    return { ok: false, error: 'workspace.worktreeKey contains characters not allowed (whitespace or ~^:?*[\\ and leading/trailing -.)' }
  }
  return { ok: true, value: trimmed }
}

/**
 * 分支/目录名段清洗：空白与 ref 非法字符（~ ^ : ? * [ \ 及控制符）折�?'-'，去首尾 '-'/'.'�? * 幂等（折叠类不含 '-'、去首尾在折叠之后），输出恒是往返不动点；全折叠后为空时兜底返回 'wt'�? */
export function sanitizeRefSegment(key: string): string {
  // 控制字符类是有意为之：清洗的�?git ref 语法非法字符（~ ^ : ? * [ \ 与控制符�?  // eslint-disable-next-line no-control-regex, no-useless-escape
  const folded = key.trim().replace(/[~^:?*\[\s\\\x00-\x1f\x7f]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return folded.length > 0 ? folded : 'wt'
}

/** 随机码字符集：小写字�?+ 数字（ref 安全，且避免大小写折叠带来的视觉歧义�?*/
const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 生成随机代号（默�?4 位小写字母数字，36^4 �?168 万组合）。随机源优先 WebCrypto
 * （渲染层�?Node 18 主进程均可用），缺省回落 Math.random —�?代号只求可读唯一，无密码学要求�? */
export function generateWorktreeCode(length = 4): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += CODE_CHARS[randomInt(CODE_CHARS.length)]
  }
  return out
}

function randomInt(maxExclusive: number): number {
  // 结构化类型而非 Crypto：本模块同时�?node/web 两套 tsconfig，不依赖任何一侧的 lib 定义
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (buf: Uint32Array) => Uint32Array } }).crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    // 拒绝采样：Uint32 落在最后一个完整周期外时重抽，保证均匀
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
    const buf = new Uint32Array(1)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      cryptoObj.getRandomValues(buf)
      if (buf[0] < limit) return buf[0] % maxExclusive
    }
  }
  return Math.floor(Math.random() * maxExclusive)
}

/**
 * 生成自动 key�?kind>-<工作区名清洗�?-<代号>（如 claude-lyshell-x7k2）�? * kind/code 当前调用方恒传安全值（kind 为小写字母、代号为 [a-z0-9]），这里同样过彻底清�?—�? * 使「恒�?validateWorktreeKey」的不变量对任意输入成立，未来暴露为通用 API 也无需先校验�? * 名称段按总长 64 预算截断；名称为空、或全被折叠（sanitize 兜底�?'wt' 伪影）时丢弃名称�? * �?<kind>-<代号>�? */
export function generateWorktreeKey(kind: string, name: string, code: string): string {
  const safeKind = sanitizeKeySegment(kind)
  const safeCode = sanitizeKeySegment(code)
  // 两个连接符各�?1 字符；kind/codex 最�?5 + 代号默认 4 �?名称预算 53
  const budget = 64 - safeKind.length - safeCode.length - 2
  const sliced = sliceCodeUnits(name.trim(), Math.max(0, budget))
  const sanitized = sanitizeKeySegment(sliced)
  // 'wt' 兜底伪影判定：折叠产物是 'wt' 而原名不是字�?'wt'，说明名称段全被折叠�?  const useName = sliced.trim().length > 0 && !(sanitized === 'wt' && sliced.trim() !== 'wt')
  const key = [safeKind, ...(useName ? [sanitized] : []), safeCode].join('-')
  // 兜底：病态超长的 kind/code（合法字符但合计 >62）截�?64；截断只可能留尾�?'-' �?  // 悬空代理（sliceCodeUnits 已摘），再过一次彻底清洗去尾，结果仍是不动�?  return key.length > 64 ? sanitizeKeySegment(sliceCodeUnits(key, 64)) : key
}

/**
 * key 段彻底清洗：先折�?/ �?\（sanitizeRefSegment 有意不折分隔�?—�?折了会让 'a/b'
 * 过往返校验、产生嵌套目�?分支），再走 sanitizeRefSegment�? */
function sanitizeKeySegment(segment: string): string {
  return sanitizeRefSegment(segment.replace(/[/\\]/g, '-'))
}

/**
 * �?UTF-16 code unit 截断，并摘掉截断产生的尾部悬空高位代�?—�?截在代理对中�? * （如 emoji）会产生 lone surrogate，渲染成替换字符 U+FFFD；摘除后长度只短不长�? * 不影响「总长 �?64」的预算保证�? */
function sliceCodeUnits(text: string, maxUnits: number): string {
  const sliced = text.slice(0, maxUnits)
  // eslint-disable-next-line no-control-regex
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced
}

/**
 * 拼接 worktree 根路径与 key 的展示路径：分隔符沿用根路径里已有的字符（主进程返回原生
 * 分隔�?—�?win32 �?'\'、POSIX �?'/'），渲染层无需另行猜测平台�? * worktreeRoot 须无尾随分隔符（主进�?resolve(join(...)) 的产物即如此）�? */
export function joinWorktreePath(worktreeRoot: string, key: string): string {
  const sep = worktreeRoot.includes('\\') ? '\\' : '/'
  return `${worktreeRoot}${sep}${key}`
}

/**
 * harness:worktree:list �?IPC 响应 DTO —�?主进�?handler、preload、渲染层三端共用�? * 以此保持两端类型同步（区别于主进程内�?WorktreeKeysResult �?ok 形态：IPC 层用 success）�? */
export type WorktreeListResult =
  | { success: true; keys: string[]; worktreeRoot: string }
  | { success: false; error: string }
