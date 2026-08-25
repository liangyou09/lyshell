import { describe, it, expect } from 'vitest'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { ensureWorktree, listWorktreeKeys, sanitizeRefSegment, validateWorktreeKey } from './worktree'

/**
 * git 环境探测：无 git 的环境整组跳过（describe.skipIf），而非红测。
 * 注意 vitest 的 describe.skipIf 参数在模块加载期求值，须同步探测。
 */
let gitAvailable = false
try {
  execFileSync('git', ['--version'], { timeout: 5000, windowsHide: true })
  gitAvailable = true
} catch {
  gitAvailable = false
}

/** 在临时目录建一个干净 git 仓库（含一个初始提交），返回仓库根路径。 */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lyshell-wt-'))
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, timeout: 10_000, windowsHide: true })
  }
  run(['init'])
  run(['config', 'user.email', 'test@lyshell.local'])
  run(['config', 'user.name', 'lyshell-test'])
  writeFileSync(join(dir, 'README.md'), '# test\n')
  run(['add', '.'])
  run(['commit', '-m', 'init'])
  return dir
}

/** 同步跑 git（测试侧脚手架，不走被测封装）。 */
function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000, windowsHide: true })
}

/** 列出已注册 worktree 的归一化路径集合（复用被测方的比较口径：resolve 折分隔符 + 小写盘符差异忽略）。 */
function registeredWorktrees(repo: string): string[] {
  return gitSync(['worktree', 'list', '--porcelain'], repo)
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length).trim()).toLowerCase())
}

describe.skipIf(!gitAvailable)('sanitizeRefSegment', () => {
  it('UUID 形态的 key 恒等返回', () => {
    expect(sanitizeRefSegment('dsh-a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'dsh-a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    )
  })

  it('ref 非法字符与空白折成 -，去首尾 -/.', () => {
    expect(sanitizeRefSegment('my workspace~x')).toBe('my-workspace-x')
    expect(sanitizeRefSegment('-lead.')).toBe('lead')
    expect(sanitizeRefSegment('   ')).toBe('wt')
  })
})

describe('validateWorktreeKey', () => {
  it('合法名通过并 trim（含中文）', () => {
    expect(validateWorktreeKey('  feature-x  ')).toEqual({ ok: true, value: 'feature-x' })
    expect(validateWorktreeKey('重构分支')).toEqual({ ok: true, value: '重构分支' })
    expect(validateWorktreeKey('a.b_c-d')).toEqual({ ok: true, value: 'a.b_c-d' })
  })

  it('空/超长拒绝', () => {
    expect(validateWorktreeKey('   ').ok).toBe(false)
    expect(validateWorktreeKey('x'.repeat(65)).ok).toBe(false)
  })

  it('会被 sanitize 折叠的名字拒绝（保证保存名 === 实际目录/分支名）', () => {
    expect(validateWorktreeKey('a b').ok).toBe(false)       // 空格折叠
    expect(validateWorktreeKey('a~b').ok).toBe(false)       // ref 非法字符
    expect(validateWorktreeKey('-lead').ok).toBe(false)     // 首部 - 被剥
    expect(validateWorktreeKey('trail.').ok).toBe(false)    // 尾部 . 被剥
  })

  it('路径段形态拒绝：. / .. / 含分隔符（防嵌套目录与嵌套分支）', () => {
    expect(validateWorktreeKey('.').ok).toBe(false)
    expect(validateWorktreeKey('..').ok).toBe(false)
    expect(validateWorktreeKey('a/b').ok).toBe(false)
    expect(validateWorktreeKey('/').ok).toBe(false)
    expect(validateWorktreeKey('a\\b').ok).toBe(false)
  })
})

describe.skipIf(!gitAvailable)('ensureWorktree', () => {
  it('非 git 目录 → 明确报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyshell-wt-nogit-'))
    try {
      const r = await ensureWorktree(dir, 'dsh-test')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('git repository')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('首次调用创建 worktree 与分支，二次调用复用同路径', async () => {
    const repo = makeTempRepo()
    try {
      const first = await ensureWorktree(repo, 'dsh-test-1')
      expect(first.ok).toBe(true)
      if (first.ok) {
        expect(first.created).toBe(true)
        expect(existsSync(first.path)).toBe(true)
        expect(registeredWorktrees(repo)).toContain(resolve(first.path).toLowerCase())
      }
      // 分支已创建
      expect(gitSync(['rev-parse', '--verify', 'refs/heads/lyshell/dsh-test-1'], repo).trim().length).toBeGreaterThan(0)

      const second = await ensureWorktree(repo, 'dsh-test-1')
      expect(second.ok).toBe(true)
      if (second.ok && first.ok) {
        expect(second.created).toBe(false)
        expect(second.path).toBe(first.path)
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('exclude 文件幂等追加 .lyshell-worktrees/ 条目', async () => {
    const repo = makeTempRepo()
    try {
      await ensureWorktree(repo, 'dsh-test-2')
      const excludePath = join(repo, '.git', 'info', 'exclude')
      expect(existsSync(excludePath)).toBe(true)
      const first = readFileSync(excludePath, 'utf-8')
      expect(first.split('\n').filter(line => line.trim() === '.lyshell-worktrees/').length).toBe(1)
      await ensureWorktree(repo, 'dsh-test-2')
      const second = readFileSync(excludePath, 'utf-8')
      expect(second).toBe(first)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('目标目录存在但非 worktree → 拒绝且不覆盖', async () => {
    const repo = makeTempRepo()
    try {
      const target = join(repo, '.lyshell-worktrees', 'dsh-test-3')
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'keep.txt'), 'user data')
      const r = await ensureWorktree(repo, 'dsh-test-3')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('exists but is not a git worktree')
      // 原目录原样保留
      expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('user data')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('worktree 目录被删但分支还在 → 重挂同一分支', async () => {
    const repo = makeTempRepo()
    try {
      const first = await ensureWorktree(repo, 'dsh-test-4')
      expect(first.ok).toBe(true)
      // 手删目录（不 git worktree remove，模拟用户直接删文件夹），分支保留
      if (first.ok) rmSync(first.path, { recursive: true, force: true })
      const reattached = await ensureWorktree(repo, 'dsh-test-4')
      expect(reattached.ok).toBe(true)
      if (reattached.ok && first.ok) {
        expect(reattached.path).toBe(first.path)
        expect(existsSync(reattached.path)).toBe(true)
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('worktree 内未提交修改跨 ensureWorktree 保留（持久化保证）', async () => {
    const repo = makeTempRepo()
    try {
      const first = await ensureWorktree(repo, 'dsh-test-5')
      expect(first.ok).toBe(true)
      if (!first.ok) return
      writeFileSync(join(first.path, 'agent-edit.txt'), 'agent 改动')
      const second = await ensureWorktree(repo, 'dsh-test-5')
      expect(second.ok).toBe(true)
      if (second.ok) {
        expect(readFileSync(join(second.path, 'agent-edit.txt'), 'utf-8')).toBe('agent 改动')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('cwd 是仓库子目录时 worktree 仍落在仓库根下', async () => {
    const repo = makeTempRepo()
    try {
      const sub = join(repo, 'sub')
      mkdirSync(sub)
      const r = await ensureWorktree(sub, 'dsh-test-6')
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.path.startsWith(join(repo, '.lyshell-worktrees'))).toBe(true)
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('非法 key 直接 fail-fast，不清洗、不建任何目录', async () => {
    const repo = makeTempRepo()
    try {
      for (const bad of ['a/b', 'a b', '.', '..', 'x'.repeat(65)]) {
        const r = await ensureWorktree(repo, bad)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toContain('invalid worktree key')
      }
      // 未触发任何 git 副作用：worktree 目录不存在
      expect(existsSync(join(repo, '.lyshell-worktrees'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('listWorktreeKeys 列出 .lyshell-worktrees 下的共享名（字典序），主树不入列', async () => {
    const repo = makeTempRepo()
    try {
      await ensureWorktree(repo, 'beta')
      await ensureWorktree(repo, 'alpha')
      const r = await listWorktreeKeys(repo)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.keys).toEqual(['alpha', 'beta'])
      // 从仓库子目录探测也返回同一份（--show-toplevel 归一到根）
      const sub = join(repo, 'sub')
      mkdirSync(sub)
      const r2 = await listWorktreeKeys(sub)
      expect(r2.ok).toBe(true)
      if (r2.ok) expect(r2.keys).toEqual(['alpha', 'beta'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('listWorktreeKeys：无 worktree 的仓库返回空列表，非 git 目录报错', async () => {
    const repo = makeTempRepo()
    try {
      const r = await listWorktreeKeys(repo)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.keys).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
    const dir = mkdtempSync(join(tmpdir(), 'lyshell-wt-list-nogit-'))
    try {
      const r = await listWorktreeKeys(dir)
      expect(r.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
