/** 贴图资源预算：编码/解码/临时字节记账、每资源一个提交帧、引用租约和 LRU。纯逻辑，不碰 DOM 或 guest。 */
export interface ShelfFrameToken {
  instanceGeneration: number
  navigationGeneration: number
  geometryRevision: number
  sequence: number
}

export interface ShelfBudgetConfig {
  encodedSoftBytes: number
  encodedAdmissionBytes: number
  decodedSoftBytes: number
  decodedAdmissionBytes: number
  temporaryAdmissionBytes: number
  maxEntries: number
}

/** 初始实验值，单位字节；软目标触发淘汰，准入阈值约束新分配，均不是进程内存硬上限。 */
export const SHELF_BUDGET_DEFAULTS: Readonly<ShelfBudgetConfig> = Object.freeze({
  encodedSoftBytes: 16 * 1024 * 1024,
  encodedAdmissionBytes: 24 * 1024 * 1024,
  decodedSoftBytes: 64 * 1024 * 1024,
  decodedAdmissionBytes: 96 * 1024 * 1024,
  temporaryAdmissionBytes: 64 * 1024 * 1024,
  maxEntries: 100,
})

/** 资源键上限：队列描述符与缓存键都必须有界。 */
export const MAX_SHELF_RESOURCE_ID_LENGTH = 512

export const isShelfResourceId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_SHELF_RESOURCE_ID_LENGTH

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const TOKEN_KEYS = ['instanceGeneration', 'navigationGeneration', 'geometryRevision', 'sequence'] as const

export function isShelfFrameToken(value: unknown): value is ShelfFrameToken {
  if (!value || typeof value !== 'object') return false
  const token = value as Record<string, unknown>
  return TOKEN_KEYS.every(key => isCount(token[key]))
}

/** 逐代比较；负数表示 a 更旧。调用前须已通过 isShelfFrameToken。 */
export function compareShelfFrameTokens(a: ShelfFrameToken, b: ShelfFrameToken): number {
  for (const key of TOKEN_KEYS) {
    if (a[key] < b[key]) return -1
    if (a[key] > b[key]) return 1
  }
  return 0
}

/** DataURL 保守按每 UTF-16 码元 2 字节；溢出返回 null。 */
export function estimateShelfDataUrlBytes(dataUrl: unknown): number | null {
  if (typeof dataUrl !== 'string') return null
  const bytes = dataUrl.length * 2
  return Number.isSafeInteger(bytes) ? bytes : null
}

/** 解码帧按物理像素 * 4 字节；负数、非安全整数或乘法溢出返回 null。 */
export function estimateShelfDecodedBytes(width: unknown, height: unknown): number | null {
  if (!isCount(width) || !isCount(height)) return null
  const pixels = width * height
  if (!Number.isSafeInteger(pixels)) return null
  const bytes = pixels * 4
  return Number.isSafeInteger(bytes) ? bytes : null
}

export interface ShelfFrameOfferInput {
  resourceId: string
  token: ShelfFrameToken
  dataUrl: string
  width: number
  height: number
}

export interface ShelfFrameView {
  resourceId: string
  token: ShelfFrameToken
  dataUrl: string
  width: number
  height: number
  encodedBytes: number
  decodedBytes: number
  decoded: boolean
  leases: number
  lastUsed: number
}

export interface ShelfFrameLease {
  readonly id: number
  readonly resourceId: string
  readonly token: ShelfFrameToken
  readonly frame: ShelfFrameView
}

export type ShelfFrameOfferResult =
  | { ok: true; frame: ShelfFrameView; replaced: boolean; evicted: number }
  | { ok: false; reason: 'invalid' | 'stale' | 'entries' | 'encoded-admission'; detail: string }

export interface ShelfTemporaryReservation { readonly id: number; readonly bytes: number }
/** 终端 Canvas 等非缓存帧的已解码内存预留，与帧解码共用同一总预算。 */
export interface ShelfDecodedReservation { readonly id: number; readonly bytes: number }

export interface ShelfFrameCacheDiagnostics {
  entries: number
  retired: number
  leases: number
  encodedBytes: number
  decodedBytes: number
  temporaryBytes: number
  decodedReservations: number
  peakEncodedBytes: number
  peakDecodedBytes: number
  peakTemporaryBytes: number
  hits: number
  misses: number
  offers: number
  evictions: number
  reclaims: number
  rejectedStale: number
  rejectedEstimate: number
  rejectedAdmission: number
  rejectedEntries: number
  rejectedDecoded: number
  invalidations: number
  config: ShelfBudgetConfig
}

export interface ShelfFrameCache {
  /** 只读快照；要跨异步持有必须 acquire，租约会阻止淘汰。 */
  get(resourceId: string): ShelfFrameView | null
  acquire(resourceId: string, options?: { decoded?: boolean }): ShelfFrameLease | null
  release(lease: ShelfFrameLease): boolean
  offer(input: ShelfFrameOfferInput): ShelfFrameOfferResult
  invalidate(resourceId: string, token?: ShelfFrameToken): boolean
  reserveTemporary(bytes: number): ShelfTemporaryReservation | null
  releaseTemporary(reservation: ShelfTemporaryReservation): boolean
  /** 预留在分配画布像素前占用 decoded 总额；释放时必须使用同一凭据对象。 */
  reserveDecoded(bytes: number): ShelfDecodedReservation | null
  releaseDecoded(reservation: ShelfDecodedReservation): boolean
  diagnostics(): ShelfFrameCacheDiagnostics
}

interface FrameRecord {
  resourceId: string
  token: ShelfFrameToken
  dataUrl: string
  width: number
  height: number
  encodedBytes: number
  decodedBytes: number
  decoded: boolean
  leases: number
  lastUsed: number
}

interface LeaseRecord { frame: FrameRecord; lease: ShelfFrameLease }

function readConfig(overrides: Partial<ShelfBudgetConfig>): ShelfBudgetConfig {
  const config = { ...SHELF_BUDGET_DEFAULTS, ...overrides }
  const values = [config.encodedSoftBytes, config.encodedAdmissionBytes, config.decodedSoftBytes, config.decodedAdmissionBytes, config.temporaryAdmissionBytes]
  if (!values.every(isCount) || !Number.isSafeInteger(config.maxEntries) || config.maxEntries < 1 ||
    config.encodedSoftBytes > config.encodedAdmissionBytes || config.decodedSoftBytes > config.decodedAdmissionBytes) {
    throw new RangeError('ShelfBudgetConfig 非法：预算须为非负安全整数，软目标不得高于准入阈值，maxEntries >= 1')
  }
  return Object.freeze(config)
}

export function createShelfFrameCache(overrides: Partial<ShelfBudgetConfig> = {}): ShelfFrameCache {
  const config = readConfig(overrides)
  const frames = new Map<string, FrameRecord>()
  const retired: FrameRecord[] = []
  const leases = new Map<number, LeaseRecord>()
  const reservations = new Map<number, { bytes: number; reservation: ShelfTemporaryReservation }>()
  const decodedReservations = new Map<number, { bytes: number; reservation: ShelfDecodedReservation }>()
  let encodedBytes = 0, decodedBytes = 0, temporaryBytes = 0
  let peakEncodedBytes = 0, peakDecodedBytes = 0, peakTemporaryBytes = 0
  let clock = 0, leaseId = 0, reservationId = 0, decodedReservationId = 0
  const stats = { hits: 0, misses: 0, offers: 0, evictions: 0, reclaims: 0, rejectedStale: 0, rejectedEstimate: 0, rejectedAdmission: 0, rejectedEntries: 0, rejectedDecoded: 0, invalidations: 0 }

  const view = (frame: FrameRecord): ShelfFrameView => Object.freeze({
    resourceId: frame.resourceId, token: Object.freeze({ ...frame.token }), dataUrl: frame.dataUrl, width: frame.width, height: frame.height,
    encodedBytes: frame.encodedBytes, decodedBytes: frame.decodedBytes, decoded: frame.decoded, leases: frame.leases, lastUsed: frame.lastUsed,
  })
  const markPeaks = (encoded = encodedBytes, decoded = decodedBytes) => {
    peakEncodedBytes = Math.max(peakEncodedBytes, encoded)
    peakDecodedBytes = Math.max(peakDecodedBytes, decoded)
  }
  const drop = (frame: FrameRecord) => {
    if (frames.get(frame.resourceId) !== frame) return false
    frames.delete(frame.resourceId)
    encodedBytes -= frame.encodedBytes
    if (frame.decoded) decodedBytes -= frame.decodedBytes
    stats.evictions += 1
    return true
  }
  const lru = (exclude?: string) => [...frames.values()]
    .filter(frame => frame.resourceId !== exclude && frame.leases === 0)
    .sort((a, b) => a.lastUsed - b.lastUsed)

  const get = (resourceId: string): ShelfFrameView | null => {
    const frame = frames.get(resourceId)
    if (!frame) { stats.misses += 1; return null }
    stats.hits += 1
    frame.lastUsed = ++clock
    return view(frame)
  }

  const acquire = (resourceId: string, options: { decoded?: boolean } = {}): ShelfFrameLease | null => {
    const frame = frames.get(resourceId)
    if (!frame) { stats.misses += 1; return null }
    if (options.decoded && !frame.decoded) {
      let projected = decodedBytes
      const plan: FrameRecord[] = []
      for (const candidate of lru().filter(item => item.decoded && item.resourceId !== resourceId)) {
        if (projected + frame.decodedBytes <= config.decodedSoftBytes) break
        plan.push(candidate)
        projected -= candidate.decodedBytes
      }
      if (projected + frame.decodedBytes > config.decodedAdmissionBytes) { stats.rejectedDecoded += 1; return null }
      plan.forEach(drop)
      frame.decoded = true
      decodedBytes += frame.decodedBytes
      markPeaks()
    }
    stats.hits += 1
    frame.leases += 1
    frame.lastUsed = ++clock
    const lease = Object.freeze({ id: ++leaseId, resourceId, token: Object.freeze({ ...frame.token }), frame: view(frame) })
    leases.set(lease.id, { frame, lease })
    return lease
  }

  const release = (lease: ShelfFrameLease): boolean => {
    const id = lease && typeof lease.id === 'number' ? lease.id : -1
    const held = leases.get(id)
    if (!held || held.lease !== lease) return false
    leases.delete(id)
    const frame = held.frame
    frame.leases = Math.max(0, frame.leases - 1)
    if (frame.leases === 0 && frames.get(frame.resourceId) !== frame) {
      const index = retired.indexOf(frame)
      if (index >= 0) {
        retired.splice(index, 1)
        encodedBytes -= frame.encodedBytes
        if (frame.decoded) decodedBytes -= frame.decodedBytes
        stats.reclaims += 1
      }
    }
    return true
  }

  const offer = (input: ShelfFrameOfferInput): ShelfFrameOfferResult => {
    stats.offers += 1
    const { resourceId, token, dataUrl, width, height } = (input ?? {}) as Partial<ShelfFrameOfferInput>
    const encoded = estimateShelfDataUrlBytes(dataUrl)
    const decoded = estimateShelfDecodedBytes(width, height)
    if (!isShelfResourceId(resourceId) || !isShelfFrameToken(token) || !dataUrl ||
      encoded === null || decoded === null || typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1) {
      stats.rejectedEstimate += 1
      return { ok: false, reason: 'invalid', detail: '资源、token、DataURL 或像素字段非法，或字节估算溢出' }
    }
    const current = frames.get(resourceId)
    if (current && compareShelfFrameTokens(token, current.token) <= 0) {
      stats.rejectedStale += 1
      return { ok: false, reason: 'stale', detail: 'token 不新于已提交帧' }
    }

    let projectedEncoded = encodedBytes, projectedDecoded = decodedBytes
    const plan: FrameRecord[] = []
    if (current && current.leases === 0) {
      projectedEncoded -= current.encodedBytes
      if (current.decoded) projectedDecoded -= current.decodedBytes
    }
    if (!current && frames.size >= config.maxEntries) {
      const victim = lru(resourceId)[0]
      if (!victim) { stats.rejectedEntries += 1; return { ok: false, reason: 'entries', detail: '条目已满且全部受租约保护' } }
      plan.push(victim)
      projectedEncoded -= victim.encodedBytes
      if (victim.decoded) projectedDecoded -= victim.decodedBytes
    }
    for (const candidate of lru(resourceId)) {
      if ((projectedEncoded + encoded <= config.encodedSoftBytes && projectedDecoded <= config.decodedSoftBytes) || plan.includes(candidate)) continue
      plan.push(candidate)
      projectedEncoded -= candidate.encodedBytes
      if (candidate.decoded) projectedDecoded -= candidate.decodedBytes
    }
    // 新图生成时旧帧（即使无租约）仍同时存在，准入与峰值都必须按瞬时并存计。
    const transientEncoded = encodedBytes + encoded
    if (!Number.isSafeInteger(transientEncoded) || transientEncoded > config.encodedAdmissionBytes) {
      stats.rejectedAdmission += 1
      return { ok: false, reason: 'encoded-admission', detail: '编码瞬时峰值超过准入阈值' }
    }

    peakEncodedBytes = Math.max(peakEncodedBytes, transientEncoded)
    plan.forEach(drop)
    if (current) {
      frames.delete(resourceId)
      if (current.leases > 0) retired.push(current)
      else { encodedBytes -= current.encodedBytes; if (current.decoded) decodedBytes -= current.decodedBytes; stats.evictions += 1 }
    }
    const frame: FrameRecord = {
      resourceId, token: Object.freeze({ ...token }), dataUrl, width, height, encodedBytes: encoded, decodedBytes: decoded,
      decoded: false, leases: 0, lastUsed: ++clock,
    }
    frames.set(resourceId, frame)
    encodedBytes += encoded
    return { ok: true, frame: view(frame), replaced: Boolean(current), evicted: plan.length }
  }

  const invalidate = (resourceId: string, token?: ShelfFrameToken): boolean => {
    const frame = frames.get(resourceId)
    if (!frame || (token && compareShelfFrameTokens(token, frame.token) !== 0)) return false
    frames.delete(resourceId)
    if (frame.leases > 0) retired.push(frame)
    else { encodedBytes -= frame.encodedBytes; if (frame.decoded) decodedBytes -= frame.decodedBytes; stats.evictions += 1 }
    stats.invalidations += 1
    return true
  }

  const reserveTemporary = (bytes: number): ShelfTemporaryReservation | null => {
    if (!isCount(bytes) || temporaryBytes + bytes > config.temporaryAdmissionBytes) return null
    const reservation = Object.freeze({ id: ++reservationId, bytes })
    reservations.set(reservation.id, { bytes, reservation })
    temporaryBytes += bytes
    peakTemporaryBytes = Math.max(peakTemporaryBytes, temporaryBytes)
    return reservation
  }

  const releaseTemporary = (reservation: ShelfTemporaryReservation): boolean => {
    const held = reservations.get(reservation && typeof reservation.id === 'number' ? reservation.id : -1)
    if (!held || held.reservation !== reservation) return false
    reservations.delete(reservation.id)
    temporaryBytes -= held.bytes
    return true
  }

  const reserveDecoded = (bytes: number): ShelfDecodedReservation | null => {
    if (!isCount(bytes) || bytes < 1 || decodedBytes + bytes > config.decodedAdmissionBytes) return null
    const reservation = Object.freeze({ id: ++decodedReservationId, bytes })
    decodedReservations.set(reservation.id, { bytes, reservation })
    decodedBytes += bytes
    peakDecodedBytes = Math.max(peakDecodedBytes, decodedBytes)
    return reservation
  }

  const releaseDecoded = (reservation: ShelfDecodedReservation): boolean => {
    const held = decodedReservations.get(reservation && typeof reservation.id === 'number' ? reservation.id : -1)
    if (!held || held.reservation !== reservation) return false
    decodedReservations.delete(reservation.id)
    decodedBytes -= held.bytes
    return true
  }

  return {
    get, acquire, release, offer, invalidate, reserveTemporary, releaseTemporary, reserveDecoded, releaseDecoded,
    diagnostics: () => ({
      entries: frames.size, retired: retired.length, leases: leases.size, encodedBytes, decodedBytes, temporaryBytes,
      decodedReservations: decodedReservations.size, peakEncodedBytes, peakDecodedBytes, peakTemporaryBytes, ...stats, config: { ...config },
    }),
  }
}
