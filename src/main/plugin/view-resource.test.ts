import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RESOURCE_BYTES, ViewProtocolError } from './view-protocol-core'
import { readPluginViewResource } from './view-resource'

const { openFile } = vi.hoisted(() => ({ openFile: vi.fn() }))
vi.mock('fs/promises', () => ({ open: openFile }))

function makeFile(size: number, reportedSize = size, content?: Buffer) {
  let position = 0
  return {
    stat: vi.fn(async () => ({ size: reportedSize, isFile: (): boolean => true })),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = Math.min(length, size - position)
      if (content) content.copy(buffer, offset, position, position + bytesRead)
      else buffer.fill(7, offset, offset + bytesRead)
      position += bytesRead
      return { bytesRead }
    }),
    close: vi.fn(async () => {})
  }
}

beforeEach(() => openFile.mockReset())

describe('readPluginViewResource', () => {
  it('超大文件在读取和分配数据缓冲前拒绝，并关闭句柄', async () => {
    const file = makeFile(2 ** 32)
    openFile.mockResolvedValue(file)
    await expect(readPluginViewResource('large.bin')).rejects.toThrow('resource too large')
    expect(file.read).not.toHaveBeenCalled()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('正常资源字节保持不变，空文件也可读取', async () => {
    for (const content of [Buffer.from('<html>插件页面</html>'), Buffer.alloc(0)]) {
      const file = makeFile(content.length, content.length, content)
      openFile.mockResolvedValue(file)
      expect(await readPluginViewResource('panel.html')).toEqual(content)
      expect(file.close).toHaveBeenCalledOnce()
    }
  })

  it('恰好达到限额的文件允许返回', async () => {
    const file = makeFile(MAX_RESOURCE_BYTES)
    openFile.mockResolvedValue(file)
    const result = await readPluginViewResource('limit.bin')
    expect(result.length).toBe(MAX_RESOURCE_BYTES)
    expect(result[0]).toBe(7)
    expect(result[result.length - 1]).toBe(7)
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('stat 后增长仍拒绝，最多实际读取限额 + 1 字节', async () => {
    const file = makeFile(MAX_RESOURCE_BYTES + 1024 * 1024, 1)
    openFile.mockResolvedValue(file)
    await expect(readPluginViewResource('growing.bin')).rejects.toThrow('resource too large')
    const requested = file.read.mock.calls.reduce((sum, [, , length]) => sum + length, 0)
    expect(requested).toBe(MAX_RESOURCE_BYTES + 1)
    expect(file.read.mock.calls.every(([, , length]) => length <= 64 * 1024)).toBe(true)
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('读取中报错也关闭句柄，保留原始错误', async () => {
    const file = makeFile(10)
    const error = new Error('read failed')
    file.read.mockRejectedValueOnce(error)
    openFile.mockResolvedValue(file)
    await expect(readPluginViewResource('broken.bin')).rejects.toBe(error)
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('打开后发现目标不是文件时拒绝，不执行读取', async () => {
    const file = makeFile(0)
    file.stat.mockResolvedValue({ size: 0, isFile: () => false })
    openFile.mockResolvedValue(file)
    await expect(readPluginViewResource('directory')).rejects.toBeInstanceOf(ViewProtocolError)
    expect(file.read).not.toHaveBeenCalled()
    expect(file.close).toHaveBeenCalledOnce()
  })
})
