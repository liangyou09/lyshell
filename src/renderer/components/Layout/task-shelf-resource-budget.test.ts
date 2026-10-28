import { describe, expect, it } from 'vitest'
import {
  SHELF_BUDGET_DEFAULTS, compareShelfFrameTokens, createShelfFrameCache, estimateShelfDataUrlBytes,
  estimateShelfDecodedBytes, isShelfFrameToken, type ShelfFrameToken,
} from './task-shelf-resource-budget'

const token = (sequence = 1, overrides: Partial<ShelfFrameToken> = {}): ShelfFrameToken =>
  ({ instanceGeneration: 1, navigationGeneration: 1, geometryRevision: 1, sequence, ...overrides })
const dataUrl = (bytes: number) => 'x'.repeat(bytes / 2)
const area = () => ({ width: 5, height: 5 })
const frame = (resourceId: string, bytes = 400, frameToken = token()) => ({
  resourceId, token: frameToken, dataUrl: dataUrl(bytes), ...area(),
})
const cache = (overrides = {}) => createShelfFrameCache({
  encodedSoftBytes: 1000, encodedAdmissionBytes: 2000, decodedSoftBytes: 1000, decodedAdmissionBytes: 2000,
  temporaryAdmissionBytes: 1000, maxEntries: 8, ...overrides,
})

describe('预算估算与配置', () => {
  it('默认值与注入配置的边界', () => {
    expect(SHELF_BUDGET_DEFAULTS).toEqual({
      encodedSoftBytes: 16 * 1024 * 1024, encodedAdmissionBytes: 24 * 1024 * 1024,
      decodedSoftBytes: 64 * 1024 * 1024, decodedAdmissionBytes: 96 * 1024 * 1024,
      temporaryAdmissionBytes: 64 * 1024 * 1024, maxEntries: 100,
    })
    expect(() => cache({ encodedSoftBytes: 10, encodedAdmissionBytes: 9 })).toThrow(RangeError)
    expect(() => cache({ maxEntries: 0 })).toThrow(RangeError)
    expect(() => cache({ decodedAdmissionBytes: -1 })).toThrow(RangeError)
  })
  it('DataURL 按码元 2 字节、解码按像素 4 字节，拒绝负数/非整数/溢出', () => {
    expect(estimateShelfDataUrlBytes('😀')).toBe(4)
    expect(estimateShelfDataUrlBytes(0)).toBeNull()
    expect(estimateShelfDecodedBytes(960, 600)).toBe(960 * 600 * 4)
    expect(estimateShelfDecodedBytes(-1, 5)).toBeNull()
    expect(estimateShelfDecodedBytes(1.5, 5)).toBeNull()
    expect(estimateShelfDecodedBytes(Number.MAX_SAFE_INTEGER, 1)).toBeNull()
    expect(isShelfFrameToken(token())).toBe(true)
    expect(isShelfFrameToken({ ...token(), sequence: -1 })).toBe(false)
    expect(compareShelfFrameTokens(token(1), token(2))).toBe(-1)
    expect(compareShelfFrameTokens(token(2, { geometryRevision: 2 }), token(1))).toBe(1)
  })
})

describe('提交帧、代际与条目上限', () => {
  it('每资源一个提交帧，拒绝旧 token 与非法估算', () => {
    const frames = cache()
    expect(frames.offer(frame('a', 400, token(1)))).toMatchObject({ ok: true, replaced: false })
    expect(frames.offer(frame('a', 400, token(1)))).toMatchObject({ ok: false, reason: 'stale' })
    expect(frames.offer(frame('a', 400, token(0)))).toMatchObject({ ok: false, reason: 'stale' })
    expect(frames.offer(frame('a', 400, token(2)))).toMatchObject({ ok: true, replaced: true })
    expect(frames.get('a')?.token.sequence).toBe(2)
    expect(frames.diagnostics()).toMatchObject({ entries: 1, encodedBytes: 400, rejectedStale: 2, peakEncodedBytes: 800 })
    expect(frames.offer({ ...frame('b'), width: -1 })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(frames.offer({ ...frame('b'), dataUrl: '' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(frames.offer({ ...frame('b'), height: Number.MAX_SAFE_INTEGER })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(frames.offer({ ...frame('b'), token: { ...token(), sequence: -1 } })).toMatchObject({ ok: false, reason: 'invalid' })
  })
  it('条目已满时淘汰 LRU 可释放帧，全部受租约保护则拒绝，不删除任务记录', () => {
    const frames = cache({ maxEntries: 2, encodedSoftBytes: 100000, encodedAdmissionBytes: 100000 })
    expect(frames.offer(frame('a', 400))).toMatchObject({ ok: true })
    expect(frames.offer(frame('b', 400))).toMatchObject({ ok: true })
    const held = frames.acquire('a')!
    expect(frames.offer(frame('c', 400))).toMatchObject({ ok: true, evicted: 1 })
    expect(frames.get('b')).toBeNull()
    expect(frames.get('a')).not.toBeNull()
    expect(frames.acquire('c')).not.toBeNull()
    expect(frames.offer(frame('d', 400))).toMatchObject({ ok: false, reason: 'entries' })
    frames.release(held)
    expect(frames.offer(frame('d', 400))).toMatchObject({ ok: true, evicted: 1 })
    expect(frames.get('a')).toBeNull()
  })
})

describe('引用租约与替换峰值', () => {
  it('替换旧帧仍有租约时新旧并存计入峰值，释放后回收', () => {
    const frames = cache({ encodedSoftBytes: 2000, encodedAdmissionBytes: 2000 })
    expect(frames.offer(frame('a', 1000, token(1)))).toMatchObject({ ok: true })
    const lease = frames.acquire('a')!
    expect(lease.frame.token.sequence).toBe(1)
    expect(frames.offer(frame('a', 1000, token(2)))).toMatchObject({ ok: true, replaced: true })
    expect(frames.get('a')?.token.sequence).toBe(2)
    expect(lease.frame.token.sequence).toBe(1)
    expect(frames.diagnostics()).toMatchObject({
      entries: 1, retired: 1, encodedBytes: 2000, peakEncodedBytes: 2000, reclaims: 0,
    })
    expect(frames.release(lease)).toBe(true)
    expect(frames.release(lease)).toBe(false)
    expect(frames.diagnostics()).toMatchObject({
      entries: 1, retired: 0, encodedBytes: 1000, peakEncodedBytes: 2000, reclaims: 1,
    })
  })
  it('LRU 淘汰只动无租约帧，受保护帧保留到释放', () => {
    const frames = cache({ maxEntries: 8 })
    expect(frames.offer(frame('a', 400))).toMatchObject({ ok: true })
    expect(frames.offer(frame('b', 400))).toMatchObject({ ok: true })
    const held = frames.acquire('a')!
    expect(frames.offer(frame('c', 400))).toMatchObject({ ok: true, evicted: 1 })
    expect(frames.get('b')).toBeNull()
    expect(frames.diagnostics().entries).toBe(2)
    frames.release(held)
    expect(frames.offer(frame('d', 400))).toMatchObject({ ok: true, evicted: 1 })
    expect(frames.get('a')).toBeNull()
    expect(frames.get('c')).not.toBeNull()
  })
  it('解码预算不足时拒绝 acquire，释放后淘汰可释放解码帧再准入', () => {
    const frames = cache({ maxEntries: 8, decodedSoftBytes: 100, decodedAdmissionBytes: 150 })
    expect(frames.offer(frame('a', 400))).toMatchObject({ ok: true })
    expect(frames.offer(frame('b', 400))).toMatchObject({ ok: true })
    const held = frames.acquire('a', { decoded: true })!
    expect(frames.diagnostics().decodedBytes).toBe(100)
    expect(frames.acquire('b', { decoded: true })).toBeNull()
    expect(frames.diagnostics().rejectedDecoded).toBe(1)
    frames.release(held)
    const lease = frames.acquire('b', { decoded: true })!
    expect(lease).not.toBeNull()
    expect(frames.get('a')).toBeNull()
    expect(frames.diagnostics().decodedBytes).toBe(100)
  })
  it('失效帧保留给既有租约读取，随后回收且新消费者看不到', () => {
    const frames = cache()
    expect(frames.offer(frame('a', 1000, token(1)))).toMatchObject({ ok: true })
    const lease = frames.acquire('a')!
    expect(frames.invalidate('a', token(2))).toBe(false)
    expect(frames.invalidate('a', token(1))).toBe(true)
    expect(frames.get('a')).toBeNull()
    expect(frames.acquire('a')).toBeNull()
    expect(lease.frame.dataUrl).toBe(dataUrl(1000))
    expect(frames.diagnostics()).toMatchObject({ entries: 0, retired: 1, encodedBytes: 1000 })
    frames.release(lease)
    expect(frames.diagnostics()).toMatchObject({ retired: 0, encodedBytes: 0, reclaims: 1 })
    expect(frames.invalidate('missing')).toBe(false)
  })
})

describe('临时预留与诊断', () => {
  it('临时字节准入、峰值和幂等释放', () => {
    const frames = cache()
    const first = frames.reserveTemporary(600)!
    expect(first.bytes).toBe(600)
    expect(frames.reserveTemporary(500)).toBeNull()
    const second = frames.reserveTemporary(400)!
    expect(frames.reserveTemporary(-1)).toBeNull()
    expect(frames.diagnostics()).toMatchObject({ temporaryBytes: 1000, peakTemporaryBytes: 1000 })
    expect(frames.releaseTemporary(first)).toBe(true)
    expect(frames.releaseTemporary(first)).toBe(false)
    expect(frames.releaseTemporary(second)).toBe(true)
    expect(frames.diagnostics()).toMatchObject({ temporaryBytes: 0, peakTemporaryBytes: 1000 })
  })
  it('诊断计数来自同一所有者，get/acquire 未命中可核对', () => {
    const frames = cache()
    expect(frames.get('missing')).toBeNull()
    expect(frames.acquire('missing')).toBeNull()
    expect(frames.diagnostics()).toMatchObject({ hits: 0, misses: 2, entries: 0 })
    expect(frames.offer(frame('a'))).toMatchObject({ ok: true })
    expect(frames.get('a')).not.toBeNull()
    expect(frames.diagnostics()).toMatchObject({ hits: 1, offers: 1, config: { maxEntries: 8 } })
  })
})

describe('替换瞬时峰值与凭据身份', () => {
  it('无租约替换仍按新旧并存检查准入，失败保留旧帧', () => {
    const frames = cache({ encodedSoftBytes: 900, encodedAdmissionBytes: 1500 })
    expect(frames.offer(frame('a', 1000, token(1)))).toMatchObject({ ok: true })
    expect(frames.offer(frame('a', 600, token(2)))).toMatchObject({ ok: false, reason: 'encoded-admission' })
    expect(frames.get('a')?.token.sequence).toBe(1)
    expect(frames.diagnostics()).toMatchObject({ encodedBytes: 1000, peakEncodedBytes: 1000 })
  })
  it('拒绝来自另一个缓存实例的同 id 租约/预留凭据', () => {
    const one = cache(), two = cache()
    expect(one.offer(frame('a', 400))).toMatchObject({ ok: true })
    expect(two.offer(frame('a', 400))).toMatchObject({ ok: true })
    const leaseOne = one.acquire('a')!, leaseTwo = two.acquire('a')!
    expect(one.release(leaseTwo)).toBe(false)
    expect(one.get('a')).not.toBeNull()
    expect(one.release(leaseOne)).toBe(true)

    const tempOne = one.reserveTemporary(100)!, tempTwo = two.reserveTemporary(100)!
    expect(one.releaseTemporary(tempTwo)).toBe(false)
    expect(one.releaseTemporary(tempOne)).toBe(true)

    const decodedOne = one.reserveDecoded(100)!, decodedTwo = two.reserveDecoded(100)!
    expect(one.releaseDecoded(decodedTwo)).toBe(false)
    expect(one.releaseDecoded(decodedOne)).toBe(true)
  })
  it('Canvas 解码预留计入同一 decoded 预算并记录峰值', () => {
    const frames = cache({ decodedSoftBytes: 150, decodedAdmissionBytes: 150 })
    const first = frames.reserveDecoded(100)!
    expect(frames.reserveDecoded(60)).toBeNull()
    expect(frames.diagnostics()).toMatchObject({ decodedBytes: 100, peakDecodedBytes: 100, decodedReservations: 1 })
    expect(frames.releaseDecoded(first)).toBe(true)
    expect(frames.reserveDecoded(60)).not.toBeNull()
    expect(frames.diagnostics()).toMatchObject({ decodedBytes: 60, peakDecodedBytes: 100, decodedReservations: 1 })
  })
  it('resourceId 超过 512 码元时拒绝提交', () => {
    const frames = cache()
    expect(frames.offer(frame('a'.repeat(513)))).toMatchObject({ ok: false, reason: 'invalid' })
  })
})
