import { describe, expect, it } from 'vitest'
import { buildWorkLauncherDirectories } from './work-launcher-paths'
import type { WorkLauncherProject } from './work-launcher-tree'

const project = (dir: string): WorkLauncherProject => ({ key: dir, dir, entries: [{ id: dir, name: dir, cwd: dir, order: 0 }] })

describe('Work Launcher 路径层级', () => {
  it('逐级合并共同父目录，保留父路径自身的 workspace 与嵌套 workspace', () => {
    const result = buildWorkLauncherDirectories([project('D:/work/app/sub'), project('d:\\work\\app'), project('D:/work/api')], 'win32')
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('D:\\')
    const work = result[0].children[0]
    expect(work.label).toBe('work')
    expect(work.project).toBeUndefined()
    expect(work.children.map(node => node.label)).toEqual(['api', 'app'])
    expect(work.children[1].project?.dir).toBe('d:\\work\\app')
    expect(work.children[1].children[0].project?.dir).toBe('D:/work/app/sub')
  })
  it('同名目录按祖先区分，路径边界不会混淆前缀', () => {
    const result = buildWorkLauncherDirectories([project('/team/app'), project('/teams/app')], 'linux')
    expect(result[0].children.map(node => node.label)).toEqual(['team', 'teams'])
    expect(result[0].children.every(node => node.children[0].label === 'app')).toBe(true)
  })
  it('POSIX 大小写和反斜杠文件名保留，不误作 Windows 路径', () => {
    const result = buildWorkLauncherDirectories([project('/App'), project('/app'), project('/folder\\name')], 'linux')
    expect(result[0].children).toHaveLength(3)
    expect(result[0].children.some(node => node.label === 'folder\\name')).toBe(true)
  })
  it('UNC 共享根独立于 POSIX 根与盘符根', () => {
    const result = buildWorkLauncherDirectories([project('\\\\server\\share\\app'), project('D:/'), project('E:/app')], 'win32')
    expect(result).toHaveLength(3)
    const unc = result.find(node => node.label === '\\\\server\\share\\')!
    expect(unc.children[0].label).toBe('app')
    expect(result.find(node => node.label === 'D:\\')?.project).toBeTruthy()
  })
})
