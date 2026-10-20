import { describe, expect, it } from 'vitest'
import { formatCodeWorkspaceName } from './code-workspaces'

describe('工作区拼接名', () => {
  it('普通目录只显示名称，worktree 通过中点拼接且不重复追加', () => {
    expect(formatCodeWorkspaceName({ name: 'Project' })).toBe('Project')
    expect(formatCodeWorkspaceName({ name: 'Project', isolation: 'worktree', worktreeKey: 'feature' })).toBe('Project · feature')
    expect(formatCodeWorkspaceName({ name: 'Project · feature', isolation: 'worktree', worktreeKey: 'feature' })).toBe('Project · feature')
  })
})
