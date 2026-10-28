import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type RetryOptions = {
  rename?: (src: string, dst: string) => Promise<void>
  wait?: (ms: number) => Promise<void>
  maxRetries?: number
  retryDelay?: number
}
const { renameWithRetry, placeUnpacked } = createRequire(import.meta.url)('./rename-unpacked.cjs') as {
  renameWithRetry: (src: string, dst: string, options?: RetryOptions) => Promise<void>
  placeUnpacked: (src: string, dst: string, options?: RetryOptions & { copy?: (src: string, dst: string, options: unknown) => Promise<void> }) => Promise<'renamed' | 'copied'>
}
const temporary: string[] = []
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rename-unpacked-test-'))
  temporary.push(directory)
  const src = path.join(directory, 'win-unpacked'), dst = path.join(directory, 'version-unpacked')
  await mkdir(path.join(src, 'resources'), { recursive: true })
  await writeFile(path.join(src, 'resources', 'app.asar'), Buffer.from([0, 255, 13, 10, 128]))
  return { src, dst }
}
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('rename-unpacked-test-')) throw new Error('Unsafe temporary directory')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('打包产物目录收尾', () => {
  it.each(['EPERM', 'EBUSY', 'ENOTEMPTY'])('瞬时 %s 按线性间隔重试后成功', async code => {
    const error = Object.assign(new Error('locked'), { code })
    const rename = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const wait = vi.fn().mockResolvedValue(undefined)
    await renameWithRetry('src', 'dst', { rename, wait })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(rename).toHaveBeenLastCalledWith('src', 'dst')
    expect(wait.mock.calls).toEqual([[300], [600]])
  })

  it('持续占用最多尝试六次，并保留原错误', async () => {
    const error = Object.assign(new Error('still locked'), { code: 'EPERM' })
    const rename = vi.fn().mockRejectedValue(error), wait = vi.fn().mockResolvedValue(undefined)
    await expect(renameWithRetry('src', 'dst', { rename, wait })).rejects.toBe(error)
    expect(rename).toHaveBeenCalledTimes(6)
    expect(wait.mock.calls).toEqual([[300], [600], [900], [1200], [1500]])
  })

  it.each(['ENOENT', 'EACCES', 'ENOSPC'])('非占用错误 %s 立即失败，不重试或复制', async code => {
    const error = Object.assign(new Error(code), { code })
    const rename = vi.fn().mockRejectedValue(error), wait = vi.fn(), copy = vi.fn()
    await expect(placeUnpacked('src', 'dst', { rename, wait, copy })).rejects.toBe(error)
    expect(rename).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })

  it('无占用时真正重命名，并保持嵌套文件字节', async () => {
    const { src, dst } = await fixture()
    expect(await placeUnpacked(src, dst)).toBe('renamed')
    expect(existsSync(src)).toBe(false)
    expect(await readFile(path.join(dst, 'resources', 'app.asar'))).toEqual(Buffer.from([0, 255, 13, 10, 128]))
  })

  it('持续占用时完整复制，保留原目录；零重试只尝试一次', async () => {
    const { src, dst } = await fixture()
    const error = Object.assign(new Error('locked'), { code: 'EPERM' })
    const rename = vi.fn().mockRejectedValue(error), wait = vi.fn()
    expect(await placeUnpacked(src, dst, { rename, wait, maxRetries: 0 })).toBe('copied')
    expect(rename).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
    expect(await readFile(path.join(dst, 'resources', 'app.asar'))).toEqual(await readFile(path.join(src, 'resources', 'app.asar')))
  })

  it('复制失败时抛出错误，原产物仍在', async () => {
    const { src, dst } = await fixture()
    const copyError = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const rename = vi.fn().mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }))
    const copy = vi.fn().mockRejectedValue(copyError)
    await expect(placeUnpacked(src, dst, { rename, copy, maxRetries: 0 })).rejects.toBe(copyError)
    expect(copy).toHaveBeenCalledWith(src, dst, { recursive: true, errorOnExist: true, force: false })
    expect(existsSync(path.join(src, 'resources', 'app.asar'))).toBe(true)
    expect(existsSync(dst)).toBe(false)
  })

  it('复制不会覆盖目标目录中已有的文件', async () => {
    const { src, dst } = await fixture()
    await mkdir(path.join(dst, 'resources'), { recursive: true })
    await writeFile(path.join(dst, 'resources', 'app.asar'), 'existing')
    const rename = vi.fn().mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }))
    await expect(placeUnpacked(src, dst, { rename, maxRetries: 0 })).rejects.toHaveProperty('code', 'ERR_FS_CP_EEXIST')
    expect(await readFile(path.join(dst, 'resources', 'app.asar'), 'utf8')).toBe('existing')
  })
})
