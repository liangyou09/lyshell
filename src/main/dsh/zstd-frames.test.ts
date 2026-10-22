import { describe, expect, it } from 'vitest'
import * as zlib from 'node:zlib'
import { decodeZstdText, scanZstdFrames, zstdDecodingSupported } from './zstd-frames'

// 压缩能力只在 Node 22.15+ 才有；仓库的 @types/node 还没声明 zstd，这里按运行时取
const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync
const canCompress = typeof zstdCompressSync === 'function'

function compress(input: Buffer): Buffer {
  if (!zstdCompressSync) throw new Error('zstdCompressSync unavailable')
  return zstdCompressSync(input)
}

describe.skipIf(!canCompress)('zstd 多帧扫描', () => {
  it('顺序拼接的多个 frame 全部解出（不是只解第一个）', () => {
    const first = compress(Buffer.from('hello dsh\n', 'utf8'))
    const second = compress(Buffer.from('{"type":"usage"}\n', 'utf8'))
    const scan = scanZstdFrames(Buffer.concat([first, second]))
    expect(scan.frames).toHaveLength(2)
    expect(scan.frames[0]).toEqual({ start: 0, end: first.length })
    expect(scan.tornStart).toBeNull()
    const decoded = decodeZstdText(Buffer.concat([first, second]))
    expect(decoded.text).toBe('hello dsh\n{"type":"usage"}\n')
    expect(decoded.failed).toBe(0)
    expect(decoded.torn).toBe(false)
  })

  it('尾部 frame 被截断时保留已解出的部分并标记 torn，不静默当成完整', () => {
    const first = compress(Buffer.from('a\n', 'utf8'))
    const second = compress(Buffer.from('bbbbbbbbbb\n'.repeat(10), 'utf8'))
    const truncated = Buffer.concat([first, second]).subarray(0, first.length + second.length - 6)
    const decoded = decodeZstdText(truncated)
    expect(decoded.text).toBe('a\n')
    expect(decoded.torn).toBe(true)
  })

  it('完全不是 zstd 的输入给出明确错误而不是抛异常', () => {
    const scan = scanZstdFrames(Buffer.from('definitely not zstd', 'utf8'))
    expect(scan.frames).toHaveLength(0)
    expect(scan.error).toBeTruthy()
    expect(() => decodeZstdText(Buffer.from('definitely not zstd', 'utf8'))).not.toThrow()
  })

  it('能压缩的运行时同时具备解码能力（能力检测不会再把人挡在外面）', () => {
    expect(zstdDecodingSupported()).toBe(true)
  })
})
