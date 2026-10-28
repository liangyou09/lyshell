import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostStorageDir, newHostId } from './local-host-protocol'
import { stopRecordedLocalHosts } from './local-host-lifecycle'

vi.mock('./local-host-client', () => ({ LocalHostClient: { attach: vi.fn() } }))

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'lyshell-host-lifecycle-')) })
afterEach(async () => {
  if (dirname(directory) !== resolve(tmpdir()) || !directory.includes('lyshell-host-lifecycle-')) throw new Error('Unsafe temporary path')
  await rm(directory, { recursive: true, force: true })
})
async function record(id = newHostId()) {
  await mkdir(hostStorageDir(directory), { recursive: true })
  await writeFile(join(hostStorageDir(directory), `${id}.json`), '{}')
  return id
}
function host() {
  return { retain: vi.fn().mockResolvedValue(undefined), terminate: vi.fn().mockResolvedValue(undefined), detach: vi.fn().mockResolvedValue(undefined) }
}

describe('退出和启动时清理登记的本地宿主', () => {
  it('没有宿主目录时不启动或附着任何进程', async () => {
    const attach = vi.fn(), onError = vi.fn()
    await stopRecordedLocalHosts(directory, onError, attach)
    expect(attach).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('只处理当前档案内 UUID 命名的普通描述文件，按撤销保活、终止、断开的顺序执行', async () => {
    const id = await record()
    await writeFile(join(hostStorageDir(directory), 'other.json'), '{}')
    await writeFile(join(hostStorageDir(directory), `${newHostId()}.sock`), '')
    await mkdir(join(hostStorageDir(directory), `${newHostId()}.json`))
    const client = host(), attach = vi.fn().mockResolvedValue(client), onError = vi.fn()
    await stopRecordedLocalHosts(directory, onError, attach)
    expect(attach).toHaveBeenCalledOnce()
    expect(attach).toHaveBeenCalledWith(directory, id)
    expect(client.retain).toHaveBeenCalledWith(false)
    expect(client.retain.mock.invocationCallOrder[0]).toBeLessThan(client.terminate.mock.invocationCallOrder[0])
    expect(client.terminate.mock.invocationCallOrder[0]).toBeLessThan(client.detach.mock.invocationCallOrder[0])
    expect(onError).not.toHaveBeenCalled()
    expect(await readdir(hostStorageDir(directory))).toHaveLength(4)
  })

  it('鉴权或断链失败保留描述文件，单项失败不跳过其他宿主', async () => {
    const failedId = await record(), goodId = await record()
    const client = host(), failure = new Error('authentication failed'), onError = vi.fn()
    const attach = vi.fn(async (_directory: string, id: string) => {
      if (id === failedId) throw failure
      return client
    })
    await stopRecordedLocalHosts(directory, onError, attach)
    expect(onError).toHaveBeenCalledWith(failedId, failure)
    expect(attach).toHaveBeenCalledWith(directory, goodId)
    expect(client.terminate).toHaveBeenCalledOnce()
    expect(client.detach).toHaveBeenCalledOnce()
    expect(await readdir(hostStorageDir(directory))).toContain(`${failedId}.json`)
  })

  it('撤销保活失败仍尝试终止；终止失败也释放本次附着并保留未知记录', async () => {
    const id = await record(), client = host(), onError = vi.fn()
    const retainError = new Error('retention unknown'), terminateError = new Error('termination unknown')
    client.retain.mockRejectedValue(retainError)
    client.terminate.mockRejectedValue(terminateError)
    await stopRecordedLocalHosts(directory, onError, vi.fn().mockResolvedValue(client))
    expect(client.terminate).toHaveBeenCalledOnce()
    expect(client.detach).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(id, retainError)
    expect(onError).toHaveBeenCalledWith(id, terminateError)
    expect(await readdir(hostStorageDir(directory))).toContain(`${id}.json`)
  })

  it('多个历史宿主限制同时附着的数量，全部完成后才返回', async () => {
    for (let index = 0; index < 19; index++) await record()
    let active = 0, maximum = 0
    const attach = vi.fn(async () => {
      maximum = Math.max(maximum, ++active)
      return {
        retain: async () => {},
        terminate: async () => { await new Promise(resolve => setTimeout(resolve, 2)) },
        detach: async () => { active-- }
      }
    })
    await stopRecordedLocalHosts(directory, vi.fn(), attach)
    expect(attach).toHaveBeenCalledTimes(19)
    expect(maximum).toBeLessThanOrEqual(8)
    expect(active).toBe(0)
  })

  it('撤销保活尚未确认时立即发送终止，不耗尽退出预算再开始杀进程', async () => {
    await record()
    const client = host()
    let release!: () => void
    client.retain.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    client.terminate.mockImplementation(async () => { release() })
    await stopRecordedLocalHosts(directory, vi.fn(), vi.fn().mockResolvedValue(client))
    expect(client.terminate).toHaveBeenCalledOnce()
    expect(client.detach).toHaveBeenCalledOnce()
  })
})
