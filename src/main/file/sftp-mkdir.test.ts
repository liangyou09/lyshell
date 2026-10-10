import { describe, expect, it, vi } from 'vitest'
import { sftpMkdirP } from './sftp-mkdir'

const sftpError = (code: number, message: string) => Object.assign(new Error(message), { code })

function createClient(paths: Record<string, 'directory' | 'file'>) {
  const stat = vi.fn((path: string, callback: (err: Error | undefined, attrs: { isDirectory(): boolean }) => void) => {
    callback(paths[path] ? undefined : sftpError(2, 'No such file'), {
      isDirectory: () => paths[path] === 'directory'
    })
  })
  const mkdir = vi.fn((path: string, callback: (err: Error | undefined) => void) => {
    // 模拟 Windows SFTP 对盘符根目录/已有目录 mkdir 返回 Permission denied。
    if (paths[path]) callback(sftpError(3, 'Permission denied'))
    else {
      paths[path] = 'directory'
      callback(undefined)
    }
  })
  return { stat, mkdir }
}

describe('sftpMkdirP', () => {
  it('Windows 已有目标目录不执行 mkdir，也不访问盘符根目录', async () => {
    const client = createClient({ '/D:': 'directory', '/D:/workspace': 'directory' })
    await sftpMkdirP(client, '/D:/workspace')
    expect(client.stat.mock.calls.map(([path]) => path)).toEqual(['/D:/workspace'])
    expect(client.mkdir).not.toHaveBeenCalled()
  })

  it('仅创建缺失的 Windows 子目录，不 mkdir 已有的上级', async () => {
    const client = createClient({ '/D:/workspace': 'directory' })
    await sftpMkdirP(client, '/D:/workspace/new/nested')
    expect(client.mkdir.mock.calls.map(([path]) => path)).toEqual([
      '/D:/workspace/new', '/D:/workspace/new/nested'
    ])
  })

  it('Linux 绝对路径和相对路径按从上到下创建缺失目录', async () => {
    for (const dir of ['/tmp/uploads/nested', 'uploads/nested']) {
      const client = createClient({ '/tmp': 'directory' })
      await sftpMkdirP(client, dir)
      const prefix = dir.startsWith('/') ? '/tmp/' : ''
      expect(client.mkdir.mock.calls.map(([path]) => path)).toEqual([
        `${prefix}uploads`, `${prefix}uploads/nested`
      ])
    }
  })

  it('stat 权限错误原样抛出，不尝试创建目录', async () => {
    const client = createClient({})
    const error = sftpError(3, 'Permission denied')
    client.stat.mockImplementation((_path, callback) => callback(error, { isDirectory: () => false }))
    await expect(sftpMkdirP(client, '/private')).rejects.toBe(error)
    expect(client.mkdir).not.toHaveBeenCalled()
  })

  it('已有同名文件报错，不把文件当目录忽略', async () => {
    const client = createClient({ '/tmp/file': 'file' })
    await expect(sftpMkdirP(client, '/tmp/file')).rejects.toThrow('not a directory')
    expect(client.mkdir).not.toHaveBeenCalled()
  })

  it('并发创建导致 mkdir 失败，仅在 stat 确认目录存在时忽略', async () => {
    const paths: Record<string, 'directory' | 'file'> = {}
    const client = createClient(paths)
    client.mkdir.mockImplementation((path, callback) => {
      paths[path] = 'directory'
      callback(sftpError(4, 'Failure'))
    })
    await expect(sftpMkdirP(client, '/uploads')).resolves.toBeUndefined()
  })

  it('真实 mkdir 权限错误保留，不吞掉上传失败', async () => {
    const client = createClient({ '/tmp': 'directory' })
    const error = sftpError(3, 'Permission denied')
    client.mkdir.mockImplementation((_path, callback) => callback(error))
    await expect(sftpMkdirP(client, '/tmp/uploads')).rejects.toBe(error)
  })

  it('规范化重复斜线和点路径，不操作根目录', async () => {
    const client = createClient({ '/tmp/uploads/.': 'directory' })
    await sftpMkdirP(client, '/tmp//uploads/./')
    await sftpMkdirP(client, '/')
    await sftpMkdirP(client, '.')
    expect(client.mkdir).not.toHaveBeenCalled()
    expect(client.stat).toHaveBeenCalledTimes(1)
  })

  it('符号链接后的 .. 保留给服务端解析，创建实际目标的子目录', async () => {
    const client = createClient({ '/link/..': 'directory' })
    await sftpMkdirP(client, '/link/../uploads')
    expect(client.stat.mock.calls.map(([path]) => path)).toEqual([
      '/link/../uploads', '/link/..'
    ])
    expect(client.mkdir.mock.calls.map(([path]) => path)).toEqual(['/link/../uploads'])
  })
})
