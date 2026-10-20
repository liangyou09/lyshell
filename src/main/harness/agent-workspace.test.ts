import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lyshell-agent-workspace-'))
})
afterEach(() => {
  const target = resolve(root)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('lyshell-agent-workspace-')) throw new Error('Unexpected fixture cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('resolveAgentWorkspaceCwd', () => {
  it('legacy 无 cwd 返回 undefined（默认目录）', async () => {
    const { resolveAgentWorkspaceCwd } = await import('./agent-workspace')
    expect(await resolveAgentWorkspaceCwd({})).toEqual({ ok: true, cwd: undefined })
    expect(await resolveAgentWorkspaceCwd({ cwd: '  ', isolation: 'shared' })).toEqual({ ok: true, cwd: undefined })
  })

  it('shared 校验绝对存在目录并返回归一化路径', async () => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    const { resolveAgentWorkspaceCwd } = await import('./agent-workspace')
    expect(await resolveAgentWorkspaceCwd({ cwd, isolation: 'shared' })).toEqual({ ok: true, cwd: resolve(cwd) })
  })
  it('损坏的 worktree 配置缺目录时拒绝启动，不回落到默认目录', async () => {
    const { resolveAgentWorkspaceCwd } = await import('./agent-workspace')
    for (const cwd of [undefined, '  ']) {
      expect(await resolveAgentWorkspaceCwd({ cwd, isolation: 'worktree', worktreeKey: 'feature' }))
        .toEqual({ ok: false, error: 'agent.cwd is required for worktree isolation' })
    }
  })

  it('shared 目录不存在返回错误', async () => {
    const { resolveAgentWorkspaceCwd } = await import('./agent-workspace')
    expect(await resolveAgentWorkspaceCwd({ cwd: join(root, 'missing'), isolation: 'shared' }))
      .toEqual({ ok: false, error: 'workspace.cwd does not exist' })
  })

  it('worktree 返回实际 worktree 路径，第二次复用同一棵树', async () => {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'pipe' })
    const { resolveAgentWorkspaceCwd } = await import('./agent-workspace')
    const first = await resolveAgentWorkspaceCwd({ cwd: repo, isolation: 'worktree', worktreeKey: 'feature' })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.error)
    const tree = join(repo, '.lyshell-worktrees', 'feature')
    expect(first.cwd).toBe(tree)
    expect(existsSync(tree)).toBe(true)
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: tree, encoding: 'utf8' }).trim()).toBe('lyshell/feature')
    const second = await resolveAgentWorkspaceCwd({ cwd: repo, isolation: 'worktree', worktreeKey: 'feature' })
    expect(second).toEqual(first)
  }, 15000)

  it('worktree 缺 key 返回错误', async () => {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const { resolveAgentWorkspaceCwd } = await import('./agent-workspace')
    expect(await resolveAgentWorkspaceCwd({ cwd: repo, isolation: 'worktree' }))
      .toEqual({ ok: false, error: 'Worktree name is required' })
  })

  it('worktree 非 git 目录返回错误（失败传播，调用方不创建终端）', async () => {
    const cwd = join(root, 'plain')
    mkdirSync(cwd)
    const { resolveAgentWorkspaceCwd } = await import('./agent-workspace')
    const r = await resolveAgentWorkspaceCwd({ cwd, isolation: 'worktree', worktreeKey: 'feature' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.error).toContain('not inside a git repository')
  }, 15000)
})
