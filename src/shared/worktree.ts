/**
 * worktree key 纯函数（main 与 renderer 共用，不得依赖 Node/Electron）。
 *
 * key 同时是 .lyshell-worktrees/ 下的一级目录名与分支名 lyshell/<key>：
 *   - validateWorktreeKey / sanitizeRefSegment 自 main/harness/worktree.ts 下沉而来（单一事实源，
 *     两侧共用同一套校验规则，避免渲染层自动生成的 key 在保存时被主进程拒绝）；
 *   - generateWorktreeCode / generateWorktreeKey 供渲染层在「选择 worktree 隔离」时自动生成
 *     <kind>-<工作区名>-<秒级时间戳> 形态的可读 key（时间戳保证同名工作区不意外共用，且可读出
 *     创建时间）。工作区/Agent 名称留空时的默认命名（工作区-<时间戳>）用分钟级的
 *     generateWorktreeStamp —— 同一套拼装、两种粒度。
 */
export const WORKTREE_DIR = '.lyshell-worktrees'
export const BRANCH_PREFIX = 'lyshell'

/**
 * 校验 worktree 共享名（worktreeKey）：trim 后非空、≤64 字符、非 ./..、不含路径分隔符（/ 与 \），
 * 且 sanitizeRefSegment 往返一致（即不含会被折叠的空白/ref 非法字符、不以 -/. 开头结尾）。
 * 用往返一致而非另写一套白名单，保证「保存的名字 === 实际的目录名与分支名」—— 两个只差一个
 * 空格的键折叠成同一个 worktree 是最坏的静默歧义；显式拒绝分隔符则是防嵌套目录与嵌套分支
 * （'a/b' 能过往返校验，但会落到 .lyshell-worktrees/a/b 并建 lyshell/a/b，下拉也只显示首段）。
 * 中文等 Unicode 字母合法（git ref 支持）。
 */
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
 * 分支/目录名段清洗：空白与 ref 非法字符（~ ^ : ? * [ \ 及控制符）折成 '-'，去首尾 '-'/'.'。
 * 幂等（折叠类不含 '-'、去首尾在折叠之后），输出恒是往返不动点；全折叠后为空时兜底返回 'wt'。
 */
export function sanitizeRefSegment(key: string): string {
  // 控制字符类是有意为之：清洗的是 git ref 语法非法字符（~ ^ : ? * [ \ 与控制符）
  // eslint-disable-next-line no-control-regex, no-useless-escape
  const folded = key.trim().replace(/[~^:?*\[\s\\\x00-\x1f\x7f]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return folded.length > 0 ? folded : 'wt'
}

/** 时间戳拼接（本地时区）：withSeconds=false 为 YYYYMMDD-HHmm，true 为 YYYYMMDD-HHmmss。 */
function formatStamp(date: Date, withSeconds: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  return withSeconds ? `${base}${pad(date.getSeconds())}` : base
}

/**
 * 生成分钟级时间戳（本地时区 YYYYMMDD-HHmm，如 20260708-1607）：
 * 工作区/Agent 名称留空时的默认命名后缀（工作区-<时间戳>）与「选目录自动填名」的基名后缀。
 * 分钟粒度与用户示例格式一致；同一分钟内连建多个会重名，由列表的 cwd 行区分。
 */
export function generateWorktreeStamp(): string {
  return formatStamp(new Date(), false)
}

/**
 * 生成秒级时间戳代号（本地时区 YYYYMMDD-HHmmss，如 20260708-160745）：
 * worktree 自动 key 的代号段，取代旧随机代号 —— 仍承担「同名工作区不意外共用」的区分职责
 * （秒级粒度下经 UI 流程实际撞不了车），同时一眼可读出创建时间。
 * 纯 Date 拼接、无随机源，主进程与渲染层（两套 tsconfig）行为一致。
 */
export function generateWorktreeCode(): string {
  return formatStamp(new Date(), true)
}

/**
 * 生成自动 key：<kind>-<工作区名清洗段>-<代号>（如 claude-lyshell-20260708-160745，代号现恒为
 * generateWorktreeCode 的秒级时间戳）。kind/code 当前调用方恒传安全值（kind 为小写字母、时间戳
 * 为数字与连字符），这里同样过彻底清洗 —— 使「恒过 validateWorktreeKey」的不变量对任意输入成立，
 * 未来暴露为通用 API 也无需先校验。
 * 名称段按总长 64 预算截断；名称为空、或全被折叠（sanitize 兜底成 'wt' 伪影）时丢弃名称段，
 * 退化为 <kind>-<代号>。
 */
export function generateWorktreeKey(kind: string, name: string, code: string): string {
  const safeKind = sanitizeKeySegment(kind)
  const safeCode = sanitizeKeySegment(code)
  // 两个连接符各占 1 字符；kind 最长 5 + 秒级代号 15 → 名称预算 42
  const budget = 64 - safeKind.length - safeCode.length - 2
  const sliced = sliceCodeUnits(name.trim(), Math.max(0, budget))
  const sanitized = sanitizeKeySegment(sliced)
  // 'wt' 兜底伪影判定：折叠产物是 'wt' 而原名不是字面 'wt'，说明名称段全被折叠。
  const useName = sliced.trim().length > 0 && !(sanitized === 'wt' && sliced.trim() !== 'wt')
  const key = [safeKind, ...(useName ? [sanitized] : []), safeCode].join('-')
  // 兜底：病态超长的 kind/code（合法字符但合计 >62）截到 64；截断只可能留尾部 '-' 或
  // 悬空代理（sliceCodeUnits 已摘），再过一次彻底清洗去尾，结果仍是不动点。
  return key.length > 64 ? sanitizeKeySegment(sliceCodeUnits(key, 64)) : key
}

/**
 * key 段彻底清洗：先折叠 / 与 \（sanitizeRefSegment 有意不折分隔符 —— 折了会让 'a/b'
 * 过往返校验、产生嵌套目录/分支），再走 sanitizeRefSegment。
 */
function sanitizeKeySegment(segment: string): string {
  return sanitizeRefSegment(segment.replace(/[/\\]/g, '-'))
}

/**
 * 按 UTF-16 code unit 截断，并摘掉截断产生的尾部悬空高位代理 —— 截在代理对中间
 * （如 emoji）会产生 lone surrogate，渲染成替换字符 U+FFFD；摘除后长度只短不长，
 * 不影响「总长 ≤ 64」的预算保证。
 */
function sliceCodeUnits(text: string, maxUnits: number): string {
  const sliced = text.slice(0, maxUnits)
  // eslint-disable-next-line no-control-regex
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced
}

/**
 * 拼接 worktree 根路径与 key 的展示路径：分隔符沿用根路径里已有的字符（主进程返回原生
 * 分隔符 —— win32 为 '\'、POSIX 为 '/'），渲染层无需另行猜测平台。
 * worktreeRoot 须无尾随分隔符（主进程 resolve(join(...)) 的产物即如此）。
 */
export function joinWorktreePath(worktreeRoot: string, key: string): string {
  const sep = worktreeRoot.includes('\\') ? '\\' : '/'
  return `${worktreeRoot}${sep}${key}`
}

/**
 * harness:worktree:list 的 IPC 响应 DTO —— 主进程 handler、preload、渲染层三端共用，
 * 以此保持两端类型同步（区别于主进程内部的 WorktreeKeysResult ok 形态：IPC 层用 success）。
 */
export type WorktreeListResult =
  | { success: true; keys: string[]; worktreeRoot: string }
  | { success: false; error: string }
