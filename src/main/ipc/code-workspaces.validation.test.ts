import { describe, expect, it, vi } from 'vitest'
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
import { validateCodeWorkspaceRequest } from './validation'

describe('工作区预设输入校验', () => {
  it('规范化名称和 worktree key，只保留允许的字段', () => {
    expect(validateCodeWorkspaceRequest({ kind: 'save', preset: { name: ' Feature ', cwd: 'D:/repo', isolation: 'worktree', worktreeKey: ' feature ', model: 'ignored' } })).toEqual({ kind: 'save', preset: { name: 'Feature', cwd: 'D:/repo', isolation: 'worktree', worktreeKey: 'feature' } })
  })
  it.each([
    { kind: 'save', preset: { name: ' ', cwd: 'D:/repo', isolation: 'shared' } },
    { kind: 'save', preset: { name: 'Feature', cwd: 'D:/repo', isolation: 'worktree', worktreeKey: '../escape' } },
    { kind: 'save', preset: { name: 'Feature', cwd: 'D:/repo', isolation: 'worktree' } },
    { kind: 'save', preset: { name: 'Feature', cwd: 'D:/repo', isolation: 'invalid' } },
    { kind: 'delete', id: '' }, { kind: 'unknown' }
  ])('拒绝无效输入 %#', request => expect(() => validateCodeWorkspaceRequest(request)).toThrow())
  it('launch 只保留 kind/id，接受非空 id', () => {
    expect(validateCodeWorkspaceRequest({ kind: 'launch', id: 'preset-1', preset: { name: 'ignored' }, extra: true })).toEqual({ kind: 'launch', id: 'preset-1' })
  })
  it.each([
    { kind: 'launch', id: '' },
    { kind: 'launch', id: 'x'.repeat(129) },
    { kind: 'launch' },
    { kind: 'launch', id: 42 }
  ])('拒绝无效 launch 输入 %#', request => expect(() => validateCodeWorkspaceRequest(request)).toThrow())
})
