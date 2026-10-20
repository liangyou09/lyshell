import { describe, expect, it } from 'vitest'
import type { CodeWorkspacePreset } from '@shared/code-workspaces'
import { buildWorkLauncherProjects, findManagedWorkspace } from './work-launcher-tree'

const preset = (id: string, cwd: string, order = 0, worktreeKey?: string): CodeWorkspacePreset => ({ id, name: id, cwd, order, ...(worktreeKey ? { isolation: 'worktree', worktreeKey } : {}) })

describe('Work Launcher 工作路径分组', () => {
  it('关联优先使用设置 ID，设置改路径后跟随新目标；悬空 ID 不回退旧路径', () => {
    const saved = preset('managed', 'D:/new')
    expect(findManagedWorkspace({ id: 'agent', workspacePresetId: 'managed', cwd: 'D:/old' }, [saved], 'win32')).toBe(saved)
    expect(findManagedWorkspace({ id: 'agent', workspacePresetId: 'deleted', cwd: 'D:/new' }, [saved], 'win32')).toBeUndefined()
    expect(findManagedWorkspace({ id: 'legacy', cwd: 'd:\\NEW\\' }, [saved], 'win32')).toBe(saved)
    expect(findManagedWorkspace({ id: 'unknown', cwd: 'D:/outside' }, [saved], 'win32')).toBeUndefined()
  })
  it('Windows 斜杠、大小写与尾分隔符去重，保留 order 最小的预设身份', () => {
    const result = buildWorkLauncherProjects([preset('late', 'D:\\work\\app\\', 5), preset('first', 'd:/work/App', 1), preset('equal', 'D:/work/app', 1)], 'win32')
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe('d:/work/app')
    expect(result[0].entries.map(item => item.id)).toEqual(['first'])
  })
  it('POSIX 区分大小写，保留反斜杠文件名', () => {
    expect(buildWorkLauncherProjects([preset('a', '/App'), preset('b', '/app')], 'linux')).toHaveLength(2)
    expect(buildWorkLauncherProjects([preset('a', '/work\\'), preset('b', '/work')], 'linux')).toHaveLength(2)
  })
  it('根目录、盘符根与盘符相对路径各自保留', () => {
    const windows = buildWorkLauncherProjects([preset('a', 'D:/'), preset('b', 'd:\\'), preset('c', 'D:')], 'win32')
    expect(windows).toHaveLength(2)
    expect(buildWorkLauncherProjects([preset('root', '/')], 'linux')[0].dir).toBe('/')
  })
  it('共享目录排在 worktree 前，worktree 自然排序且重复入口去重', () => {
    const result = buildWorkLauncherProjects([
      preset('ten', '/repo', 0, 'feature10'), preset('two', '/repo', 1, 'feature2'),
      preset('shared', '/repo', 2), preset('duplicate', '/repo', 3, 'feature2')
    ], 'linux')
    expect(result[0].entries.map(item => item.id)).toEqual(['shared', 'two', 'ten'])
  })
  it('同名目录按完整路径独立分组，输入不被修改', () => {
    const input = [preset('ten', '/work10/app'), preset('two', '/work2/app')]
    const before = structuredClone(input)
    const result = buildWorkLauncherProjects(input, 'linux')
    expect(result.map(item => item.dir)).toEqual(['/work2/app', '/work10/app'])
    expect(input).toEqual(before)
  })
})
