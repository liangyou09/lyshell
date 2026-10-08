import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ExplorerLaunchQueue, parseExplorerDirectory, validateExplorerDirectory } from './explorer-launch'

describe('parseExplorerDirectory', () => {
  it('右键目录保留中文、空格与 shell 特殊字符', () => {
    expect(parseExplorerDirectory(['--open-directory', 'D:\\项目 A & B\\.'], 'C:\\Windows', false))
      .toBe('D:\\项目 A & B')
  })

  it('根目录与 UNC 共享路径正确归一化', () => {
    expect(parseExplorerDirectory(['--open-directory', 'D:\\\\.'], 'C:\\Windows', false)).toBe('D:\\')
    expect(parseExplorerDirectory(['--open-directory=\\\\server\\share\\.'], 'C:\\Windows', false))
      .toBe('\\\\server\\share\\')
  })

  it('相对路径相对于此次启动的 cwd，而非已运行主实例的 cwd', () => {
    expect(parseExplorerDirectory(['--open-directory', '.'], 'D:\\new folder', false)).toBe('D:\\new folder')
  })

  it('无参数安装版启动在未找到前台 Explorer 时回落启动 cwd', () => {
    expect(parseExplorerDirectory([], 'D:\\address bar', true)).toBe('D:\\address bar')
  })

  it('地址栏启动 cwd 为安装目录时，使用 Explorer 活动页签的目录', () => {
    expect(parseExplorerDirectory([], 'D:\\tool\\lyshell', true, 'D:\\workspace\\claude\\LyShell\\release\\explorer-validation'))
      .toBe('D:\\workspace\\claude\\LyShell\\release\\explorer-validation')
  })

  it('右键明确指定的目录优先于前台 Explorer 目录', () => {
    expect(parseExplorerDirectory(['--open-directory', 'D:\\clicked folder'], 'D:\\tool\\lyshell', true, 'D:\\other tab'))
      .toBe('D:\\clicked folder')
  })

  it('开发启动和其它命令行启动不隐式新增终端', () => {
    expect(parseExplorerDirectory([], 'D:\\repo', false)).toBeNull()
    expect(parseExplorerDirectory(['--demo-stage'], 'D:\\repo', true)).toBeNull()
  })

  it.each([['--open-directory'], ['--open-directory', '--demo-stage'], ['--open-directory='], ['--open-directory', 'D:\\bad\0path']])(
    '缺失或非法目录不回落到 cwd：%j', (...args) => {
      expect(parseExplorerDirectory(args, 'D:\\repo', true)).toBeNull()
    }
  )
})

describe('validateExplorerDirectory', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  it.each([undefined, null, 42, '', 'relative', 'D:\\bad\0path'])('拒绝不可信输入 %j', value => {
    expect(validateExplorerDirectory(value)).toBeNull()
  })

  it.skipIf(process.platform !== 'win32')('只接受存在的目录，拒绝普通文件与已删除目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'lyshell-explorer-'))
    roots.push(root)
    const file = join(root, 'file.txt')
    writeFileSync(file, '')
    expect(validateExplorerDirectory(root)).toBe(root)
    expect(validateExplorerDirectory(file)).toBeNull()
    expect(validateExplorerDirectory(join(root, 'missing'))).toBeNull()
  })
})

describe('ExplorerLaunchQueue', () => {
  it('保留就绪前的连续请求，每次认领只消费一次，同目录再次启动也会新增终端', () => {
    const queue = new ExplorerLaunchQueue()
    queue.enqueue('D:\\first')
    queue.enqueue('D:\\second')
    queue.enqueue('D:\\first')
    expect(queue.takeAll()).toEqual(['D:\\first', 'D:\\second', 'D:\\first'])
    expect(queue.takeAll()).toEqual([])
    queue.enqueue('D:\\later')
    expect(queue.takeAll()).toEqual(['D:\\later'])
  })
})
