import { describe, expect, it, vi } from 'vitest'
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
import { validateAgentWorkspaceFields, validateWorkspacePresetId } from './validation'

describe('设置工作区关联校验', () => {
  it('只接受有界的非空设置 ID', () => {
    expect(validateWorkspacePresetId('saved-workspace')).toBe('saved-workspace')
    for (const value of [undefined, null, '', {}, [], 123, 'x'.repeat(129)]) {
      expect(() => validateWorkspacePresetId(value)).toThrow()
    }
  })
})

describe('Agent 工作区字段校验', () => {
  it('worktree 隔离保留合法 key 与非空 cwd，trim key', () => {
    expect(validateAgentWorkspaceFields({ cwd: 'D:/repo', isolation: 'worktree', worktreeKey: ' feature ' }))
      .toEqual({ cwd: 'D:/repo', isolation: 'worktree', worktreeKey: 'feature' })
  })

  it('shared 隔离显式清掉 worktreeKey', () => {
    expect(validateAgentWorkspaceFields({ cwd: 'D:/repo', isolation: 'shared', worktreeKey: 'feature' }))
      .toEqual({ cwd: 'D:/repo', isolation: 'shared' })
  })

  it('缺省 isolation 同样清掉 worktreeKey（不残留 worktree 名）', () => {
    expect(validateAgentWorkspaceFields({ cwd: 'D:/repo', worktreeKey: 'feature' }))
      .toEqual({ cwd: 'D:/repo' })
  })

  it.each([
    { cwd: 'D:/repo', isolation: 'worktree', worktreeKey: '../escape' },
    { cwd: 'D:/repo', isolation: 'worktree', worktreeKey: 'a/b' },
    { cwd: 'D:/repo', isolation: 'worktree', worktreeKey: '  ' },
    { cwd: 'D:/repo', isolation: 'worktree', worktreeKey: 'a'.repeat(65) }
  ])('拒绝非法 worktree key %#', raw => expect(() => validateAgentWorkspaceFields(raw)).toThrow())

  it('worktree 隔离缺 key 拒绝', () => {
    expect(() => validateAgentWorkspaceFields({ cwd: 'D:/repo', isolation: 'worktree' }))
      .toThrow('Worktree name is required')
  })

  it('worktree 隔离缺 cwd 拒绝', () => {
    expect(() => validateAgentWorkspaceFields({ isolation: 'worktree', worktreeKey: 'feature' }))
      .toThrow('agent.cwd is required for worktree isolation')
    expect(() => validateAgentWorkspaceFields({ cwd: undefined, isolation: 'worktree', worktreeKey: 'feature' }))
      .toThrow('agent.cwd is required for worktree isolation')
  })

  it('拒绝非法 isolation 枚举', () => {
    expect(() => validateAgentWorkspaceFields({ cwd: 'D:/repo', isolation: 'invalid' })).toThrow()
  })

  it('legacy 无字段 payload 返回空对象（旧默认 Agent 无 cwd 继续支持）', () => {
    expect(validateAgentWorkspaceFields({})).toEqual({})
    expect(validateAgentWorkspaceFields({ name: 'Claude', command: 'claude' })).toEqual({})
  })

  it('update 缺键沿用仓库现状（旧客户端不传 isolation/worktreeKey 不丢已有配置）', () => {
    const existing = { cwd: 'D:/repo', isolation: 'worktree' as const, worktreeKey: 'feature' }
    expect(validateAgentWorkspaceFields({ name: 'renamed', command: 'claude' }, existing))
      .toEqual({ cwd: 'D:/repo', isolation: 'worktree', worktreeKey: 'feature' })
  })

  it('update 显式传 undefined 清掉字段（键存在语义）', () => {
    const existing = { cwd: 'D:/repo', isolation: 'worktree' as const, worktreeKey: 'feature' }
    expect(validateAgentWorkspaceFields({ cwd: undefined, isolation: undefined, worktreeKey: undefined }, existing))
      .toEqual({})
  })

  it('update 切回 shared 清掉 key，切回 worktree 缺 cwd 拒绝', () => {
    const existing = { cwd: 'D:/repo', isolation: 'worktree' as const, worktreeKey: 'feature' }
    expect(validateAgentWorkspaceFields({ isolation: 'shared' }, existing))
      .toEqual({ cwd: 'D:/repo', isolation: 'shared' })
    expect(() => validateAgentWorkspaceFields({ cwd: undefined, isolation: 'worktree' }, existing))
      .toThrow('agent.cwd is required for worktree isolation')
  })
})
