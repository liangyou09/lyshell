/**
 * 工作区 git worktree 隔离（AI Harness 通用，dsh/codex/claude 共用）。
 *
 * isolation = 'worktree' 的工作区启动时，先经 ensureWorktree 在仓库根下确保一个专属
 * worktree（<仓库根>/.lyshell-worktrees/<key>），agent 在里面跑，多 agent 同仓互不踩踏。
 * 幂等：已存在则原样复用（未提交修改跨启动保留）；分支 lyshell/<key> 首次创建后固定复用，
 * worktree 目录被手删但分支还在时重挂同一分支。
 *
 * key 的纯函数（校验/清洗/自动生成，WORKTREE_DIR/BRANCH_PREFIX 常量）在 @shared/worktree ——
 * 渲染层编辑对话框共用同一套规则（自动生成的 key 保存时必过校验）；此处 re-export 保持
 * 既有 importer（handlers / repository / 测试）不动。
 *
 * 本模块不 import Electron，可独立单测；中文注释、英文错误串（对齐 cwd.ts 风格）。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { BRANCH_PREFIX, WORKTREE_DIR, validateWorktreeKey } from '@shared/worktree'

export { BRANCH_PREFIX, WORKTREE_DIR, sanitizeRefSegment, validateWorktreeKey } from '@shared/worktree'

export type WorktreeResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; error: string }

export type WorktreeKeysResult =
  | { ok: true; keys: string[]; worktreeRoot: string }
  | { ok: false; error: string }

/**
 * 列出 cwd 所属仓库 .lyshell-worktrees/ 下已注册的 worktree 共享名（去重、按字典序），
 * 一并返回 worktree 根目录绝对路径（原生分隔符）供渲染层做路径预览。
 * 供工作区编辑对话框做「已有 worktree」下拉；非 git 目录 / git 失败返回 error，
 * 调用方静默置空即可（真正的硬校验在启动时的 ensureWorktree）。
 */
export async function listWorktreeKeys(repoCwd: string): Promise<WorktreeKeysResult> {
  let toplevel: string
  try {
    toplevel = (await git(['rev-parse', '--show-toplevel'], repoCwd)).trim()
  } catch {
    return { ok: false, error: 'workspace.cwd is not inside a git repository' }
  }
  let stdout: string
  try {
    stdout = await git(['worktree', 'list', '--porcelain'], toplevel)
  } catch (err) {
    return { ok: false, error: `list worktrees: ${(err as Error).message}` }
  }
  // 只收 .lyshell-worktrees/ 根下一级目录名（共享名不含路径分隔符，嵌套目录是手放的、不入选项）
  const root = resolve(join(toplevel, WORKTREE_DIR))
  const keys = new Set<string>()
  for (const p of parseWorktreePaths(stdout)) {
    const rel = relative(root, resolve(p))
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) continue
    keys.add(rel.split(/[\\/]/)[0])
  }
  return { ok: true, keys: Array.from(keys).sort((a, b) => a.localeCompare(b)), worktreeRoot: root }
}

/** execFile 的 git 封装：不走 shell（避免 Windows 引号问题），失败抛出可读错误（stderr 首个非空行）。 */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // git 不在 PATH：execFile 回 ENOENT，stderr 为空，须给出独立可读信息
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            rejectPromise(new Error('git executable not found on PATH'))
            return
          }
          const firstLine = (stderr || '').split('\n').map(l => l.trim()).find(l => l.length > 0)
          rejectPromise(new Error(firstLine || error.message))
          return
        }
        resolvePromise(stdout)
      }
    )
  })
}

/** 路径归一化比较键：resolve 展开后，win32 再大小写折叠（git 可能回显大小写不同的盘符）。 */
function pathKey(p: string): string {
  const normalized = resolve(p)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 解析 `git worktree list --porcelain` 输出中所有 worktree 路径（worktree 开头的行）。 */
function parseWorktreePaths(stdout: string): string[] {
  const paths: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim())
  }
  return paths
}

/**
 * 确保 .git/info/exclude 含 `.lyshell-worktrees/` 条目（幂等，绝不触碰 tracked 的 .gitignore）。
 * gitDir 须为绝对路径（调用方已对相对 --git-common-dir 结果 resolve）。
 */
function ensureExcludeEntry(gitDir: string): void {
  const infoDir = join(gitDir, 'info')
  mkdirSync(infoDir, { recursive: true })
  const excludePath = join(infoDir, 'exclude')
  let existing = ''
  if (existsSync(excludePath)) {
    existing = readFileSync(excludePath, 'utf-8')
    // 已有条目则跳过（按行精确比较，避免每次启动重复追加）
    const hasEntry = existing.split('\n').some(line => line.trim() === WORKTREE_DIR + '/')
    if (hasEntry) return
  }
  // 无尾随换行则先补一个，保证追加行独立成行
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  appendFileSync(excludePath, `${prefix}${WORKTREE_DIR}/\n`, 'utf-8')
}

/**
 * 确保工作区的专属 git worktree 存在（幂等：已存在则复用）。
 * key 建议传 `${kind}-${workspaceId}` —— id 稳定（工作区改名不换树），UUID 字符集对目录/ref 天然安全。
 * key 须通过 validateWorktreeKey（入口侧已校验，这里 fail-fast 兜底）：非法 key 直接报错，
 * 绝不静默清洗 —— 两个只差一个空格的 key 折叠成同一个 worktree 是最坏的静默歧义。
 *
 * 步骤：校验 key → 定位仓库根 → 定位真实 .git（common-dir，兼容 cwd 本身是 linked worktree）→
 * 本地排除条目 → prune 陈旧管理数据 → 已注册则复用 → 否则按分支存在与否创建/重挂。
 */
export async function ensureWorktree(repoCwd: string, key: string): Promise<WorktreeResult> {
  const check = validateWorktreeKey(key)
  if (!check.ok) {
    return { ok: false, error: `ensureWorktree: invalid worktree key "${key.trim()}": ${check.error}` }
  }
  const safeKey = check.value
  const branch = `${BRANCH_PREFIX}/${safeKey}`
  const fail = (step: string, err: unknown): WorktreeResult => ({
    ok: false,
    error: `ensureWorktree: ${step}: ${(err as Error).message}`
  })

  // 1. 仓库根：cwd 是子目录也返回根（worktree 必须落在根下，exclude 才能罩住）
  let toplevel: string
  try {
    toplevel = (await git(['rev-parse', '--show-toplevel'], repoCwd)).trim()
  } catch (err) {
    return { ok: false, error: 'workspace.cwd is not inside a git repository' }
  }

  // 2. 真实 .git：用 common-dir 而非 --git-dir，cwd 本身是 linked worktree 时仍指向主仓库的 .git
  let gitDir: string
  try {
    const raw = (await git(['rev-parse', '--git-common-dir'], repoCwd)).trim()
    gitDir = isAbsolute(raw) ? raw : join(toplevel, raw)
  } catch (err) {
    return fail('resolve git dir', err)
  }

  // 3. 本地排除（幂等；失败不致命 —— 最多是 .lyshell-worktrees/ 在 git status 里显形）
  try {
    ensureExcludeEntry(gitDir)
  } catch {
    /* best-effort */
  }

  // 4. 清理陈旧 worktree 管理数据（目录被手删后残留的登记项）；best-effort
  try {
    await git(['worktree', 'prune'], toplevel)
  } catch {
    /* best-effort */
  }

  const target = join(toplevel, WORKTREE_DIR, safeKey)

  // 5. 查已注册的 worktree：命中即复用（未提交修改原样保留）
  const listWorktrees = async (): Promise<string[]> => {
    const stdout = await git(['worktree', 'list', '--porcelain'], toplevel)
    return parseWorktreePaths(stdout).map(pathKey)
  }
  try {
    const registered = await listWorktrees()
    if (registered.includes(pathKey(target))) {
      return { ok: true, path: target, created: false }
    }
  } catch (err) {
    return fail('list worktrees', err)
  }

  // 目录存在但未注册：宁可拒绝也不覆盖（可能是用户手放的目录）
  if (existsSync(target)) {
    return {
      ok: false,
      error: `ensureWorktree: ${target} exists but is not a git worktree; remove it or pick another directory`
    }
  }

  // 6. 分支存在则重挂（目录被手删、分支保留的场景），不存在则从 HEAD 新建
  let branchExists: boolean
  try {
    await git(['rev-parse', '--verify', `refs/heads/${branch}`], toplevel)
    branchExists = true
  } catch {
    branchExists = false
  }
  const addArgs = branchExists
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target]
  try {
    await git(addArgs, toplevel)
  } catch (err) {
    // 并发双启动同一工作区：另一个调用可能恰好先建完。重查一次 list，命中按复用收场。
    try {
      const registered = await listWorktrees()
      if (registered.includes(pathKey(target))) {
        return { ok: true, path: target, created: false }
      }
    } catch {
      /* 落到下方报错 */
    }
    return fail('git worktree add', err)
  }

  return { ok: true, path: target, created: true }
}
