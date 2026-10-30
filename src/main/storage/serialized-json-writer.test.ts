import { afterEach, describe, expect, it, vi } from 'vitest'
import { SerializedJsonWriter } from './serialized-json-writer'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function tick() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

afterEach(() => { vi.useRealTimers() })

describe('串行完整快照写入', () => {
  it('在途快照不可变，新 revision 与多个 flush 等待者按提交顺序完成', async () => {
    const first = deferred()
    const data = ['one']
    const writes: string[] = []
    const writer = new SerializedJsonWriter('revision-order.json', () => JSON.stringify(data), {
      writePrimary: async (_path, json) => { writes.push(json); if (writes.length === 1) await first.promise },
      writeBackup: async () => true
    })
    writer.markDirty()
    const flushOne = writer.flush()
    await tick()
    data.push('two')
    const revisionTwo = writer.markDirty()
    let secondResolved = false
    const flushTwo = writer.flush(revisionTwo).then(() => { secondResolved = true })
    const anotherFlush = writer.flush(revisionTwo)
    expect(writes).toEqual(['["one"]'])
    expect(secondResolved).toBe(false)
    first.resolve()
    await Promise.all([flushOne, flushTwo, anotherFlush])
    expect(writes).toEqual(['["one"]', '["one","two"]'])
    expect(writer.getState()).toMatchObject({ currentRevision: 2, committedRevision: 2, dirtySince: null, activeWrite: false })
  })

  it('clear 屏障在旧提交后保存空快照，完成后旧记录不能迟到恢复', async () => {
    const old = deferred()
    let records = ['old']
    const saved: string[] = []
    const writer = new SerializedJsonWriter('clear-order.json', () => JSON.stringify(records), {
      writePrimary: async (_path, json) => { if (json !== '[]') await old.promise; saved.push(json) },
      writeBackup: async () => true
    })
    writer.markDirty()
    const original = writer.flush()
    await tick()
    records = []
    const cleared = writer.markDirty()
    const barrier = writer.flush(cleared)
    old.resolve()
    await Promise.all([original, barrier])
    expect(saved).toEqual(['["old"]', '[]'])
    expect(writer.getState().committedRevision).toBe(cleared)
  })

  it('主文件失败保留 dirty 和旧 committedRevision，明确 flush 失败且不忙重试', async () => {
    const write = vi.fn<[string, string], Promise<void>>()
    write.mockRejectedValueOnce(new Error('private path / secret from filesystem')).mockResolvedValue(undefined)
    const writer = new SerializedJsonWriter('failure.json', () => '[]', { writePrimary: write, writeBackup: async () => true })
    writer.markDirty()
    await expect(writer.flush()).rejects.toThrow('Persistence commit failed')
    expect(writer.getState()).toMatchObject({ currentRevision: 1, committedRevision: 0, lastFailure: { phase: 'primary', code: 'PERSISTENCE_FAILED' } })
    expect(JSON.stringify(writer.getState())).not.toContain('secret')
    await tick()
    expect(write).toHaveBeenCalledTimes(1)
    await writer.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(writer.getState()).toMatchObject({ committedRevision: 1, dirtySince: null, lastFailure: null })
  })

  it.each([false, 'throws'] as const)('备份 %s 时主提交成功，flush 成功并保留独立备份诊断', async outcome => {
    const writer = new SerializedJsonWriter(`backup-${outcome}.json`, () => '[]', {
      writePrimary: async () => {},
      writeBackup: async () => { if (outcome === 'throws') throw new Error('backup unavailable'); return false }
    })
    writer.markDirty()
    await writer.flush()
    expect(writer.getState()).toMatchObject({ currentRevision: 1, committedRevision: 1, dirtySince: null, lastFailure: { phase: 'backup' } })
  })

  it('序列化失败不调用磁盘，失败诊断固定且允许显式重试', async () => {
    let failing = true
    const write = vi.fn(async () => {})
    const writer = new SerializedJsonWriter('serialize-failure.json', () => { if (failing) throw new Error('bad'); return '[]' }, {
      writePrimary: write, writeBackup: async () => true
    })
    writer.markDirty()
    await expect(writer.flush()).rejects.toThrow('Persistence commit failed')
    expect(write).not.toHaveBeenCalled()
    expect(writer.getState().lastFailure?.phase).toBe('serialize')
    failing = false
    await writer.flush()
    expect(write).toHaveBeenCalledOnce()
  })

  it('持续输入不能无限推迟，首次 dirty 五秒启动保存', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {})
    const writer = new SerializedJsonWriter('continuous.json', () => '[]', {
      writePrimary: write, writeBackup: async () => true, now: () => Date.now()
    })
    writer.markDirty()
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(1000)
      writer.markDirty()
    }
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledOnce()
    expect(writer.getState().committedRevision).toBe(5)
  })

  it('停止接收后允许 flush 捕获的 revision，拒绝新的变更', async () => {
    const writer = new SerializedJsonWriter('draining.json', () => '[]', { writePrimary: async () => {}, writeBackup: async () => true })
    writer.markDirty()
    const revision = writer.stopAcceptingWrites()
    expect(() => writer.markDirty()).toThrow('draining')
    await writer.flush(revision)
    expect(writer.getState().committedRevision).toBe(revision)
    await expect(writer.flush(revision + 1)).rejects.toThrow('Invalid persistence revision')
  })

  it('同一路径的两个 writer 实例也串行更新主文件和备份', async () => {
    const backup = deferred()
    const calls: string[] = []
    const one = new SerializedJsonWriter('same-path.json', () => 'one', {
      writePrimary: async () => { calls.push('one-primary') },
      writeBackup: async () => { calls.push('one-backup'); await backup.promise; return true }
    })
    const two = new SerializedJsonWriter('same-path.json', () => 'two', {
      writePrimary: async () => { calls.push('two-primary') },
      writeBackup: async () => { calls.push('two-backup'); return true }
    })
    one.markDirty(); two.markDirty()
    const a = one.flush(), b = two.flush()
    await tick()
    expect(calls).toEqual(['one-primary', 'one-backup'])
    backup.resolve()
    await Promise.all([a, b])
    expect(calls).toEqual(['one-primary', 'one-backup', 'two-primary', 'two-backup'])
  })
})
