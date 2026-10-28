/**
 * 协议层单元测试：环形缓冲边界 / 帧编解码 / 描述文件 / 身份与路径校验。
 *
 * 不涉及进程与网络：这里只锁「线上格式」和「落盘格式」的边界行为。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_TUNING,
  FrameDecoder,
  HOST_DESCRIPTOR_VERSION,
  LOCAL_HOST_PROTOCOL_VERSION,
  LocalHostError,
  LocalHostRingBuffer,
  MAX_ARGS,
  MAX_DESCRIPTOR_BYTES,
  encodeClientFrame,
  encodeFrame,
  hostDescriptorPath,
  hostPipePath,
  hostStorageDir,
  isHostId,
  isHostPipeForId,
  isHostToken,
  listHostDescriptorIds,
  newHostId,
  newHostToken,
  parseHostBootstrapMessage,
  parseHostDescriptor,
  parseHostFrame,
  parseHostReadyMessage,
  readHostDescriptor,
  removeHostDescriptor,
  tokensMatch,
  validateSpawnOptions,
  writeHostDescriptor
} from './local-host-protocol'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lh-proto-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function descriptorFor(id: string) {
  return {
    version: HOST_DESCRIPTOR_VERSION,
    id,
    pipe: hostPipePath(dir, id),
    pid: 4242,
    encryptedToken: Buffer.from('encrypted-token-bytes').toString('base64')
  }
}

describe('身份与 token', () => {
  it('hostId 是 36 位 UUIDv4', () => {
    const id = newHostId()
    expect(isHostId(id)).toBe(true)
    expect(id).toHaveLength(36)
    expect(isHostId('not-a-uuid')).toBe(false)
    expect(isHostId('')).toBe(false)
    expect(isHostId(undefined)).toBe(false)
  })

  it('token 是 256 位 base64url，且比较对长度敏感', () => {
    const token = newHostToken()
    expect(isHostToken(token)).toBe(true)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(isHostToken('short')).toBe(false)
    expect(tokensMatch(token, token)).toBe(true)
    expect(tokensMatch(token, newHostToken())).toBe(false)
    expect(tokensMatch('a'.repeat(43), 'a'.repeat(44))).toBe(false)
  })
})

describe('宿主路径', () => {
  it('win32 用随机 named pipe，其它平台用 profile 目录 socket', () => {
    const id = newHostId()
    expect(hostPipePath(dir, id, 'win32')).toBe(`\\\\.\\pipe\\lyshell-local-host-${id}`)
    // Unix socket 路径有 100 字节上限，测试用一个短目录代表 profile 目录
    const shortDir = '/tmp/lh'
    expect(hostPipePath(shortDir, id, 'linux')).toBe(join(hostStorageDir(shortDir), `${id}.sock`))
    expect(() => hostPipePath(dir, id, 'linux')).toThrow(/too long/)
  })

  it('描述文件里的 pipe 必须与 hostId 对应', () => {
    const id = newHostId()
    const other = newHostId()
    expect(isHostPipeForId(hostPipePath(dir, id, 'win32'), id, dir, 'win32')).toBe(true)
    expect(isHostPipeForId(hostPipePath(dir, other, 'win32'), id, dir, 'win32')).toBe(false)
    expect(isHostPipeForId('../../evil', id, dir, 'win32')).toBe(false)
  })
})

describe('环形缓冲', () => {
  it('按游标读取并保持单调序号', () => {
    const ring = new LocalHostRingBuffer()
    ring.append('abc')
    ring.append('def')
    expect(ring.next).toBe(6)
    expect(ring.start).toBe(0)
    expect(ring.gapFrom(0)).toBeNull()
    expect(ring.firstFrom(0)).toEqual({ seq: 0, data: 'abc' })

    const read = ring.readFrom(0)
    expect(read.gap).toBeUndefined()
    expect(read.blocks.map((block) => block.data)).toEqual(['abc', 'def'])
    expect(read.end).toBe(6)

    // 游标落在块中间：从中间切，序号是绝对序号
    expect(ring.firstFrom(2)).toEqual({ seq: 2, data: 'c' })
    expect(ring.readFrom(4).blocks).toEqual([{ seq: 4, data: 'ef' }])
  })

  it('溢出整块丢弃最旧数据，并给出 gap 区间', () => {
    const ring = new LocalHostRingBuffer({ maxBytes: 4, maxBlocks: 16, maxBlockChars: 2 })
    ring.append('abcdef')
    expect(ring.next).toBe(6)
    // 6 字节 > 4 字节上限：丢掉最旧的 'ab'
    expect(ring.start).toBe(2)
    expect(ring.gapFrom(0)).toEqual({ from: 0, to: 2 })
    expect(ring.firstFrom(0)).toEqual({ seq: 2, data: 'cd' })
    expect(ring.readFrom(1)).toEqual({
      gap: { from: 1, to: 2 },
      blocks: [
        { seq: 2, data: 'cd' },
        { seq: 4, data: 'ef' }
      ],
      end: 6
    })
  })

  it('永远保留最新一块，避免客户端只看到「全部缺失」', () => {
    const ring = new LocalHostRingBuffer({ maxBytes: 1, maxBlocks: 1, maxBlockChars: 4 })
    ring.append('abcdefgh')
    expect(ring.blockCount).toBe(1)
    expect(ring.start).toBe(4)
    expect(ring.firstFrom(4)).toEqual({ seq: 4, data: 'efgh' })
  })

  it('游标越界属于协议错误，不做静默修正', () => {
    const ring = new LocalHostRingBuffer()
    ring.append('abc')
    expect(() => ring.readFrom(-1)).toThrow(LocalHostError)
    expect(() => ring.readFrom(99)).toThrow(/ahead of emitted output/)
    expect(() => ring.gapFrom(99)).toThrow(LocalHostError)
    expect(() => ring.firstFrom(99)).toThrow(LocalHostError)
  })
})

describe('帧编解码', () => {
  it('跨 chunk 拆包与粘包都能还原', () => {
    const one = encodeClientFrame({ type: 'ping', reqId: 'r1' })
    const two = encodeClientFrame({ type: 'pause' })
    const joined = Buffer.concat([one, two])
    const decoder = new FrameDecoder()

    expect(decoder.push(joined.subarray(0, 3))).toEqual([])
    expect(decoder.push(joined.subarray(3, 9))).toEqual([])
    const frames = decoder.push(joined.subarray(9)) as Record<string, unknown>[]
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ type: 'ping', reqId: 'r1', v: LOCAL_HOST_PROTOCOL_VERSION })
    expect(frames[1]).toMatchObject({ type: 'pause', v: LOCAL_HOST_PROTOCOL_VERSION })
  })

  it('超限帧与坏 JSON 直接报错，不截断', () => {
    const small = new FrameDecoder(16)
    const oversized = encodeFrame({ type: 'x', data: 'y'.repeat(100) })
    expect(oversized.length).toBeGreaterThan(16)
    expect(() => small.push(oversized)).toThrow(/invalid frame length/)
    // 编码侧也要拦住超限帧，避免发出去才被对端断开
    expect(() => encodeFrame({ type: 'x', data: 'y'.repeat(100) }, 16)).toThrow(/exceeds limit/)
    expect(() => encodeClientFrame({ type: 'pause' }, 4)).toThrow(/exceeds limit/)

    const broken = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{a}', 'utf8')])
    const decoder = new FrameDecoder()
    expect(() => decoder.push(broken)).toThrow(/not valid JSON/)
    expect(() => encodeFrame(undefined as unknown)).toThrow(LocalHostError)
  })

  it('宿主帧必须带 hostId，且带 hostId 的数据帧可被解析', () => {
    const id = newHostId()
    const raw = JSON.parse(
      encodeFrame({ v: LOCAL_HOST_PROTOCOL_VERSION, hostId: id, type: 'data', start: 3, data: 'xyz' }).subarray(4).toString('utf8')
    )
    expect(parseHostFrame(raw)).toMatchObject({ type: 'data', hostId: id, start: 3, data: 'xyz' })
    expect(() =>
      parseHostFrame({ v: LOCAL_HOST_PROTOCOL_VERSION, type: 'data', start: 0, data: 'x' })
    ).toThrow(/hostId/)
  })
})

describe('spawn 选项与 bootstrap 边界', () => {
  const valid = () => ({
    shell: 'cmd.exe',
    args: ['/c'],
    cwd: dir,
    env: { PATH: 'C:\\' },
    cols: 80,
    rows: 24
  })

  it('合法输入原样通过', () => {
    expect(validateSpawnOptions(valid())).toEqual(valid())
  })
  it('空字符串参数原样传给 shell，不拒绝合法的参数边界', () => {
    const options = { ...valid(), args: ['-c', '', 'name', ''] }
    expect(validateSpawnOptions(options).args).toEqual(options.args)
    expect(() => validateSpawnOptions({ ...valid(), args: [null] })).toThrow(/args/)
  })

  it('空 shell / 相对 cwd / 非法 env / 越界尺寸一律拒绝', () => {
    expect(() => validateSpawnOptions({ ...valid(), shell: '' })).toThrow(/shell/)
    expect(() => validateSpawnOptions({ ...valid(), cwd: 'relative/path' })).toThrow(/absolute/)
    expect(() => validateSpawnOptions({ ...valid(), env: { 'A=B': 'x' } })).toThrow(/invalid/)
    expect(() => validateSpawnOptions({ ...valid(), env: { A: 1 } })).toThrow(/must be a string/)
    expect(() => validateSpawnOptions({ ...valid(), cols: 0 })).toThrow(/cols/)
    expect(() => validateSpawnOptions({ ...valid(), rows: 5000 })).toThrow(/rows/)
    expect(() => validateSpawnOptions({ ...valid(), args: Array.from({ length: MAX_ARGS + 1 }, () => 'a') })).toThrow(
      /args/
    )
  })

  it('bootstrap 校验 token、pipe 与可选 userDataDir', () => {
    const id = newHostId()
    const message = {
      kind: 'bootstrap',
      v: LOCAL_HOST_PROTOCOL_VERSION,
      id,
      token: newHostToken(),
      pipe: hostPipePath(dir, id, 'win32'),
      spawn: valid(),
      tuning: { graceMs: 123 },
      userDataDir: dir
    }
    const config = parseHostBootstrapMessage(message, message.pipe)
    expect(config.id).toBe(id)
    expect(config.userDataDir).toBe(dir)
    // 越界调参回落默认值，不因为调参失败拒绝启动
    expect(config.tuning.graceMs).toBe(123)
    expect(config.tuning.bufferBytes).toBe(DEFAULT_HOST_TUNING.bufferBytes)

    expect(() => parseHostBootstrapMessage({ ...message, token: 'short' })).toThrow(/256-bit/)
    expect(() => parseHostBootstrapMessage(message, hostPipePath(dir, newHostId(), 'win32'))).toThrow(/requested host/)
    expect(() => parseHostBootstrapMessage({ ...message, userDataDir: 'relative' })).toThrow(/absolute/)
    expect(() => parseHostBootstrapMessage({ ...message, id: 'nope' })).toThrow(/UUID/)

    const ready = parseHostReadyMessage(
      { kind: 'ready', v: LOCAL_HOST_PROTOCOL_VERSION, id, pid: 1234, pipe: message.pipe },
      id
    )
    expect(ready).toMatchObject({ id, pid: 1234 })
    expect(() =>
      parseHostReadyMessage({ kind: 'ready', v: LOCAL_HOST_PROTOCOL_VERSION, id, pid: 0, pipe: message.pipe })
    ).toThrow(/pid/)
  })
})

describe('宿主描述文件', () => {
  it('原子写入后可读回，字段顺序固定', () => {
    const id = newHostId()
    const path = writeHostDescriptor(dir, descriptorFor(id))
    expect(path).toBe(hostDescriptorPath(dir, id))
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toEqual([
      'version',
      'id',
      'pipe',
      'pid',
      'encryptedToken'
    ])
    expect(readHostDescriptor(dir, id)).toEqual(descriptorFor(id))
    expect(listHostDescriptorIds(dir)).toEqual([id])
  })

  it('损坏 / 版本不符 / pipe 与 id 不对应都拒绝（不部分采纳）', () => {
    const id = newHostId()
    mkdirSync(hostStorageDir(dir), { recursive: true })
    writeFileSync(hostDescriptorPath(dir, id), '{not json')

    expect(() => readHostDescriptor(dir, id)).toThrow(/not valid JSON/)
    expect(readHostDescriptor(dir, newHostId())).toBeNull()

    expect(() => parseHostDescriptor({ ...descriptorFor(id), version: 99 }, { userDataDir: dir })).toThrow(
      /unsupported host descriptor version/
    )
    expect(() =>
      parseHostDescriptor({ ...descriptorFor(id), pipe: hostPipePath(dir, newHostId(), 'win32') }, { userDataDir: dir })
    ).toThrow(/does not belong/)
    expect(() => parseHostDescriptor({ ...descriptorFor(id), pid: 0 }, { userDataDir: dir })).toThrow(/pid/)
    expect(() => parseHostDescriptor({ ...descriptorFor(id), encryptedToken: 'not base64!' }, { userDataDir: dir })).toThrow(
      /base64/
    )
    expect(() =>
      parseHostDescriptor({ ...descriptorFor(id), encryptedToken: 'A'.repeat(MAX_DESCRIPTOR_BYTES + 1) }, { userDataDir: dir })
    ).toThrow(/base64|too large/)
  })

  it('删除只删 id 匹配的那个，避免误删别人的记录', () => {
    const id = newHostId()
    const other = newHostId()
    writeHostDescriptor(dir, descriptorFor(id))
    writeHostDescriptor(dir, descriptorFor(other))

    // 把 other 的文件内容伪装成 id（模拟 id 复用/竞态），remove 必须拒绝
    writeFileSync(hostDescriptorPath(dir, other), JSON.stringify(descriptorFor(id)))
    expect(removeHostDescriptor(dir, other)).toBe(false)
    expect(readHostDescriptor(dir, id)).not.toBeNull()

    expect(removeHostDescriptor(dir, id)).toBe(true)
    expect(readHostDescriptor(dir, id)).toBeNull()
  })
})
