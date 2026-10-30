/**
 * 传输提交协议（OPT-11）
 *
 * 上传/下载都不再直接写最终目标：先写入目标同目录下的唯一随机临时文件，
 * 依次完成 写入(data) → 校验(verifying) → 提交(committing) → 完成(completed)，
 * 只有提交（rename）拿到回执后才算终态。进度 100% 只代表数据阶段结束。
 *
 * 本模块同时承载：
 * - 纯决策逻辑（临时文件命名、快照比较、提交策略、大小校验）——便于单测；
 * - 上传/下载共用的提交编排——以最小 SFTP 结构接口为注入点，Worker 负责连接、
 *   进度消息与取消消息，这里负责数据/校验/提交语义。
 *
 * 安全边界：
 * - 已有目标只允许原子替换；服务器不支持 posix-rename@openssh.com 时显式拒绝覆盖，
 *   绝不先删除旧目标。
 * - 最终目标为符号链接时拒绝，不跟随链接覆盖。
 * - 提交前重新校验源/目标快照与字节计数，任一变化即拒绝。
 * - 提交已发出但回执丢失时返回 outcome-unknown，由上层如实上报，不盲目重试。
 */
import * as fsp from 'fs/promises'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { Stats } from 'fs'

/** 单个数据块大小（与旧 fastPut/fastGet chunkSize 32KiB 相比更大，减少往返次数） */
export const TRANSFER_CHUNK_SIZE = 128 * 1024
/** 数据阶段同时在途的块数（滑动窗口） */
export const TRANSFER_MAX_INFLIGHT = 8
/** 临时文件在“已有目标”场景下的私有权限，避免覆盖前意外放宽权限 */
export const TRANSFER_TEMP_MODE_PRIVATE = 0o600
/** 临时文件在“新目标”场景下的默认权限（由服务端 umask 收敛） */
export const TRANSFER_TEMP_MODE_DEFAULT = 0o600
/** 临时文件重名时的有界重试次数 */
export const TRANSFER_TEMP_CREATE_RETRIES = 3
/** 临时文件名里保留的目标名最大长度（防止 NAME_MAX 溢出） */
const TEMP_BASE_MAX_LENGTH = 48
/** 临时文件名里 attemptId 的可读前缀长度 */
const TEMP_ATTEMPT_TOKEN_LENGTH = 12

export type TransferDirection = 'upload' | 'download'

/** 数据阶段 / 校验阶段 / 提交阶段 / 已提交完成 */
export type TransferPhase = 'data' | 'verifying' | 'committing' | 'completed'

/** 传输终态：成功、确定失败、已取消、结果未知（提交可能已生效） */
export type TransferOutcome = 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'

export type TempCleanupState = 'unused' | 'removed' | 'failed' | 'unknown'
export type FsyncState = 'file' | 'skipped'
export type DirectoryFsyncState = 'synced' | 'skipped' | 'unsupported' | 'failed'

export type CommitStrategy = 'posix-rename' | 'local-rename' | 'plain-rename-new-target'

export type TransferErrorCode =
  | 'TRANSFER_SOURCE_CHANGED'
  | 'TRANSFER_SOURCE_MISSING'
  | 'TRANSFER_SOURCE_UNSAFE_TYPE'
  | 'TRANSFER_TARGET_CHANGED'
  | 'TRANSFER_TARGET_IS_SYMLINK'
  | 'TRANSFER_TARGET_UNSAFE_TYPE'
  | 'TRANSFER_ATOMIC_REPLACE_UNSUPPORTED'
  | 'TRANSFER_SIZE_MISMATCH'
  | 'TRANSFER_IO_ERROR'
  | 'TRANSFER_LOCAL_IO_ERROR'
  | 'TRANSFER_COMMIT_FAILED'
  | 'TRANSFER_COMMIT_ACK_LOST'
  | 'TRANSFER_FINAL_VERIFY_FAILED'
  | 'TRANSFER_CANCELLED'
  | 'TRANSFER_TEMP_CLEANUP_INCOMPLETE'
  | 'TRANSFER_WORKER_EXIT_WITHOUT_RESULT'
  | 'TRANSFER_CANCEL_UNCONFIRMED'
  | 'TRANSFER_WORKER_START_FAILED'
  | 'TRANSFER_CONNECTION_FAILED'
  | 'TRANSFER_HOST_KEY_UNAVAILABLE'
  | 'TRANSFER_HOST_KEY_REJECTED'

/** 带有明确错误码与发生阶段的可分类错误 */
export class TransferCommitError extends Error {
  readonly code: TransferErrorCode
  readonly phase: TransferPhase

  constructor(code: TransferErrorCode, message: string, phase: TransferPhase = 'data') {
    super(message)
    this.name = 'TransferCommitError'
    this.code = code
    this.phase = phase
  }
}

/** 传输连接在提交前后断开：用于区分“确定失败”和“结果未知” */
export class TransferTransportLostError extends Error {
  constructor(message = '传输连接已断开') {
    super(message)
    this.name = 'TransferTransportLostError'
  }
}

/** 一次尝试的最终结果（Worker → 主进程，可安全持久化/上报，不含凭据） */
export interface TransferAttemptResult {
  taskId: string
  attemptId: string
  direction: TransferDirection
  outcome: TransferOutcome
  phase: TransferPhase
  expectedSize: number
  transferredSize: number
  bytesWritten: number
  finalSize?: number
  /** 实际临时文件路径（未创建时缺省） */
  tempPath?: string
  /** 临时文件命名模式：Worker 未上报 tempPath 时供用户核查残留 */
  tempPattern: string
  targetPath: string
  tempCleanup: TempCleanupState
  /** 无法确认已清理时的残留路径 */
  tempResidual?: string
  fileFsync: FsyncState
  directoryFsync: DirectoryFsyncState
  commitStrategy?: CommitStrategy
  commitDispatched: boolean
  committed: boolean
  warnings: string[]
  error?: { code: TransferErrorCode; message: string }
}

/** 协作式取消：提交前每个数据块都会检查；提交发出后不再中断，只等回执 */
export class TransferAbortController {
  private abortedFlag = false
  private readonly listeners = new Set<(reason?: string) => void>()

  get aborted(): boolean {
    return this.abortedFlag
  }

  abort(reason?: string): void {
    if (this.abortedFlag) return
    this.abortedFlag = true
    for (const listener of this.listeners) {
      try {
        listener(reason)
      } catch {
        /* 取消监听器不得影响其它监听器 */
      }
    }
    this.listeners.clear()
  }

  onAbort(listener: (reason?: string) => void): () => void {
    if (this.abortedFlag) {
      listener()
      return () => undefined
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 安全检查点：已取消则抛出可分类的 TRANSFER_CANCELLED */
  throwIfAborted(phase: TransferPhase): void {
    if (this.abortedFlag) {
      throw new TransferCommitError('TRANSFER_CANCELLED', '传输已取消', phase)
    }
  }
}

/** 提交编排所需的执行环境（由 Worker 提供消息/日志/取消通道） */
export interface TransferEnvironment {
  taskId: string
  attemptId: string
  expectedSize: number
  abort: TransferAbortController
  /** 传输连接断开信号（提交阶段用于区分回执丢失） */
  transportFailure?: Promise<never>
  onPhase?: (phase: TransferPhase) => void
  onProgress?: (progress: { transferredSize: number; fileSize: number; phase: TransferPhase }) => void
  /** 临时文件创建后立即上报，便于结果未知时定位残留 */
  onTempPath?: (tempPath: string) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** 描述远端 SFTP 的最小结构接口（真实 SFTPWrapper 结构兼容，测试可用本地 fs 假实现） */
export interface TransferSftpStats {
  mode: number
  size: number
  mtime: number
  isDirectory?(): boolean
  isFile?(): boolean
  isSymbolicLink?(): boolean
}

export interface TransferSftp {
  stat(path: string, callback: (error: Error | undefined, stats: TransferSftpStats) => void): void
  lstat(path: string, callback: (error: Error | undefined, stats: TransferSftpStats) => void): void
  fstat(handle: Buffer, callback: (error: Error | undefined, stats: TransferSftpStats) => void): void
  open(
    path: string,
    flags: string,
    attrs: { mode?: number },
    callback: (error: Error | undefined, handle: Buffer) => void
  ): void
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | undefined, bytesRead: number) => void
  ): void
  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | undefined) => void
  ): void
  fchmod(handle: Buffer, mode: number, callback: (error: Error | undefined) => void): void
  close(handle: Buffer, callback: (error: Error | undefined) => void): void
  unlink(path: string, callback: (error: Error | undefined) => void): void
  rename(oldPath: string, newPath: string, callback: (error: Error | undefined) => void): void
  ext_openssh_rename?(oldPath: string, newPath: string, callback: (error: Error | undefined) => void): void
  ext_openssh_fsync?(handle: Buffer, callback: (error: Error | undefined) => void): void
  _extensions?: Record<string, string>
}

/** 文件/目标快照；exists=false 时其余字段为占位值 */
export interface FileSnapshot {
  exists: boolean
  kind: 'file' | 'directory' | 'symlink' | 'other' | 'missing'
  size: number
  mtimeMs: number
  mode: number
  dev?: number
  ino?: number
}

export type TargetChange = 'unchanged' | 'appeared' | 'removed' | 'modified' | 'type-changed'
export type SourceChange = 'unchanged' | 'missing' | 'type-changed' | 'size' | 'mtime' | 'identity'

export interface CommitDecisionOk {
  ok: true
  strategy: CommitStrategy
}

export interface CommitDecisionRejected {
  ok: false
  code: TransferErrorCode
  message: string
}

export type CommitDecision = CommitDecisionOk | CommitDecisionRejected

export function missingSnapshot(): FileSnapshot {
  return { exists: false, kind: 'missing', size: 0, mtimeMs: 0, mode: 0 }
}

/** 仅依赖 mode/类型判定谓词的最小形状：远端 stats（mtime 秒）与本地 fs.Stats（mtime Date）都适用 */
type TypeProbeStats = {
  mode: number
  isDirectory?(): boolean
  isFile?(): boolean
  isSymbolicLink?(): boolean
}

function kindFromStats(stats: TypeProbeStats): FileSnapshot['kind'] {
  if (stats.isSymbolicLink?.()) return 'symlink'
  if (stats.isDirectory?.()) return 'directory'
  if (stats.isFile?.()) return 'file'
  const format = stats.mode & 0o170000
  if (format === 0o040000) return 'directory'
  if (format === 0o100000) return 'file'
  if (format === 0o120000) return 'symlink'
  return 'other'
}

function snapshotFromSftp(stats: TransferSftpStats, mtimeMs: number): FileSnapshot {
  return {
    exists: true,
    kind: kindFromStats(stats),
    size: stats.size,
    mtimeMs,
    mode: stats.mode
  }
}

function snapshotFromLocal(stats: Stats): FileSnapshot {
  return {
    exists: true,
    kind: kindFromStats(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
    dev: stats.dev,
    ino: stats.ino
  }
}

/** 目标变化：用于提交前拒绝覆盖被他人改动的目标 */
export function compareTargetSnapshot(initial: FileSnapshot, current: FileSnapshot): TargetChange {
  if (!initial.exists && !current.exists) return 'unchanged'
  if (!initial.exists) return 'appeared'
  if (!current.exists) return 'removed'
  if (initial.kind !== current.kind) return 'type-changed'
  if (initial.size !== current.size) return 'modified'
  if (initial.mtimeMs !== current.mtimeMs) return 'modified'
  if (initial.dev !== undefined && current.dev !== initial.dev) return 'modified'
  if (initial.ino !== undefined && current.ino !== initial.ino) return 'modified'
  if ((initial.mode & 0o7777) !== (current.mode & 0o7777)) return 'modified'
  return 'unchanged'
}

/** 源版本变化：用于拒绝把不同版本拼接成一次传输 */
export function compareSourceSnapshot(initial: FileSnapshot, current: FileSnapshot): SourceChange {
  if (!current.exists) return 'missing'
  if (initial.kind !== current.kind) return 'type-changed'
  if (initial.size !== current.size) return 'size'
  if (initial.mtimeMs !== current.mtimeMs) return 'mtime'
  if (initial.dev !== undefined && current.dev !== undefined && initial.dev !== current.dev) return 'identity'
  if (initial.ino !== undefined && current.ino !== undefined && initial.ino !== current.ino) return 'identity'
  return 'unchanged'
}

/** 上传提交策略：有 posix-rename 才能原子替换已有目标 */
export function decideUploadCommit(input: { target: FileSnapshot; posixRename: boolean }): CommitDecision {
  const { target, posixRename } = input
  if (target.exists && target.kind === 'symlink') {
    return {
      ok: false,
      code: 'TRANSFER_TARGET_IS_SYMLINK',
      message: '远端目标是指向其他位置的符号链接，已拒绝覆盖（旧文件未改动）'
    }
  }
  if (target.exists && target.kind !== 'file') {
    return {
      ok: false,
      code: 'TRANSFER_TARGET_UNSAFE_TYPE',
      message: '远端目标不是普通文件，已拒绝覆盖（旧目标未改动）'
    }
  }
  if (posixRename) return { ok: true, strategy: 'posix-rename' }
  if (target.exists) {
    return {
      ok: false,
      code: 'TRANSFER_ATOMIC_REPLACE_UNSUPPORTED',
      message:
        '远端 SFTP 服务器不支持 posix-rename@openssh.com，无法原子替换已有文件；已拒绝危险覆盖（旧文件未改动）'
    }
  }
  return { ok: true, strategy: 'plain-rename-new-target' }
}

/** 下载提交策略：本地同目录 rename 即原子替换，但符号链接/非普通文件一律拒绝 */
export function decideDownloadCommit(input: { target: FileSnapshot }): CommitDecision {
  const { target } = input
  if (target.exists && target.kind === 'symlink') {
    return {
      ok: false,
      code: 'TRANSFER_TARGET_IS_SYMLINK',
      message: '本地目标是指向其他位置的符号链接，已拒绝覆盖（旧目标未改动）'
    }
  }
  if (target.exists && target.kind !== 'file') {
    return {
      ok: false,
      code: 'TRANSFER_TARGET_UNSAFE_TYPE',
      message: '本地目标不是普通文件，已拒绝覆盖（旧目标未改动）'
    }
  }
  return { ok: true, strategy: 'local-rename' }
}

/** 字节计数/最终大小校验 */
export function verifyTransferSize(input: {
  expectedSize: number
  transferredBytes: number
  finalSize: number
}): { ok: true } | { ok: false; message: string } {
  if (input.transferredBytes !== input.expectedSize) {
    return {
      ok: false,
      message: `传输字节数与预期不符（预期 ${input.expectedSize}，实际 ${input.transferredBytes}），已拒绝提交`
    }
  }
  if (input.finalSize !== input.expectedSize) {
    return {
      ok: false,
      message: `最终文件大小与预期不符（预期 ${input.expectedSize}，实际 ${input.finalSize}），已拒绝提交`
    }
  }
  return { ok: true }
}

/** 服务器是否声明支持 posix-rename@openssh.com */
export function supportsPosixRename(sftp: TransferSftp): boolean {
  const extensions = sftp._extensions
  if (extensions) return extensions['posix-rename@openssh.com'] === '1'
  // 兼容测试替身/旧包装：真实 ssh2 的 _extensions 始终存在（未支持时为 {}），
  // 只有存在方法且没有扩展表时才尝试，调用失败会归类为提交失败。
  return typeof sftp.ext_openssh_rename === 'function'
}

/** 服务器是否声明支持 fsync@openssh.com（上传时用于确认临时文件已落盘） */
export function supportsFsync(sftp: TransferSftp): boolean {
  return sftp._extensions?.['fsync@openssh.com'] === '1'
}

function sanitizeAttemptToken(attemptId: string): string {
  const token = attemptId.replace(/[^A-Za-z0-9_-]/g, '')
  return token.length > 0 ? token.slice(0, TEMP_ATTEMPT_TOKEN_LENGTH) : 'attempt'
}

function tempBaseName(baseName: string): string {
  return baseName.length > TEMP_BASE_MAX_LENGTH ? baseName.slice(0, TEMP_BASE_MAX_LENGTH) : baseName
}

/**
 * 目标同目录、唯一随机的临时文件路径。
 * 上传使用 posix 语义，下载使用宿主 path 语义（Windows 分隔符/大小写）。
 */
export function transferTempPath(
  targetPath: string,
  direction: TransferDirection,
  attemptId: string,
  random = randomBytes(8).toString('hex')
): string {
  const impl = direction === 'upload' ? path.posix : path
  const base = tempBaseName(impl.basename(targetPath))
  const name = `.${base}.lyshell-${sanitizeAttemptToken(attemptId)}-${random}.tmp`
  return impl.join(impl.dirname(targetPath), name)
}

/** 临时文件命名模式（结果未知且未上报具体路径时供用户核查残留） */
export function describeTransferTempPattern(
  targetPath: string,
  direction: TransferDirection,
  attemptId: string
): string {
  const impl = direction === 'upload' ? path.posix : path
  const base = tempBaseName(impl.basename(targetPath))
  return impl.join(impl.dirname(targetPath), `.${base}.lyshell-${sanitizeAttemptToken(attemptId)}-*.tmp`)
}

/** 由上层合成结果（连接失败、Worker 退出无终态、排队取消等） */
export function buildSyntheticResult(input: {
  taskId: string
  attemptId: string
  direction: TransferDirection
  outcome: TransferOutcome
  phase?: TransferPhase
  expectedSize: number
  transferredSize?: number
  targetPath: string
  tempPath?: string
  tempCleanup?: TempCleanupState
  code?: TransferErrorCode
  message?: string
  commitDispatched?: boolean
  committed?: boolean
  warnings?: string[]
}): TransferAttemptResult {
  const transferred = input.transferredSize ?? 0
  const tempCleanup = input.tempCleanup ?? (input.tempPath ? 'unknown' : 'unused')
  return {
    taskId: input.taskId,
    attemptId: input.attemptId,
    direction: input.direction,
    outcome: input.outcome,
    phase: input.phase ?? 'data',
    expectedSize: input.expectedSize,
    transferredSize: transferred,
    bytesWritten: transferred,
    finalSize: undefined,
    tempPath: input.tempPath,
    tempPattern: describeTransferTempPattern(input.targetPath, input.direction, input.attemptId),
    targetPath: input.targetPath,
    tempCleanup,
    tempResidual: tempCleanup !== 'removed' ? input.tempPath : undefined,
    fileFsync: 'skipped',
    directoryFsync: 'skipped',
    commitStrategy: undefined,
    commitDispatched: input.commitDispatched ?? false,
    committed: input.committed ?? false,
    warnings: input.warnings ?? [],
    error: input.code ? { code: input.code, message: input.message ?? '' } : undefined
  }
}

/** 错误 → 终态分类（提交已发出且连接断开时只能报未知） */
export function classifyTransferFailure(
  error: unknown,
  state: { phase: TransferPhase; commitDispatched: boolean; committed: boolean }
): { outcome: TransferOutcome; code: TransferErrorCode; message: string } {
  const transportLost = isTransportLost(error)
  if (error instanceof TransferCommitError) {
    if (error.code === 'TRANSFER_COMMIT_ACK_LOST') {
      return { outcome: 'outcome-unknown', code: error.code, message: error.message }
    }
    if (error.code === 'TRANSFER_CANCELLED') {
      return { outcome: 'cancelled', code: error.code, message: error.message }
    }
    if (transportLost && state.commitDispatched && !state.committed) {
      return {
        outcome: 'outcome-unknown',
        code: 'TRANSFER_COMMIT_ACK_LOST',
        message: `提交请求已发出但连接中断，无法确认是否生效：${error.message}`
      }
    }
    return { outcome: 'failed', code: error.code, message: error.message }
  }
  const message = describeError(error)
  if (transportLost) {
    if (state.commitDispatched && !state.committed) {
      return {
        outcome: 'outcome-unknown',
        code: 'TRANSFER_COMMIT_ACK_LOST',
        message: `提交请求已发出但未收到回执（连接中断），无法确认是否生效：${message}`
      }
    }
    return { outcome: 'failed', code: 'TRANSFER_IO_ERROR', message: `传输连接中断：${message}` }
  }
  return { outcome: 'failed', code: 'TRANSFER_IO_ERROR', message }
}

export function isTransportLost(error: unknown): boolean {
  if (error instanceof TransferTransportLostError) return true
  const candidate = error as { code?: unknown; message?: unknown } | null
  const code = typeof candidate?.code === 'string' ? candidate.code : ''
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_DESTROYED'].includes(code)) {
    return true
  }
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  return /(not connected|connection lost|connection closed|channel closed|no response from server|socket hang up)/i.test(
    message
  )
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export interface TransportFailureSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * 从 SSH client / SFTP 通道收集“连接已断开”信号。
 * 提交阶段用它区分「rename 明确失败」与「回执丢失，结果未知」。
 * 返回值预挂 catch，避免提交前无人 await 时出现 unhandledRejection。
 */
export function createTransportFailureSignal(sources: TransportFailureSource[]): {
  failure: Promise<never>
  dispose: () => void
} {
  let rejectFailure: ((error: Error) => void) | null = null
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject
  })
  void failure.catch(() => undefined)

  const listeners: Array<{ source: TransportFailureSource; event: string; listener: (...args: unknown[]) => void }> = []
  const notify = (event: string, arg?: unknown): void => {
    const detail = arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : ''
    rejectFailure?.(new TransferTransportLostError(`传输连接已断开（${event}${detail ? `：${detail}` : ''}）`))
    rejectFailure = null
  }

  for (const source of sources) {
    for (const event of ['error', 'close'] as const) {
      const listener = (...args: unknown[]): void => notify(event, args[0])
      try {
        source.on(event, listener)
        listeners.push({ source, event, listener })
      } catch {
        /* 单个事件源不支持该事件时忽略 */
      }
    }
  }

  return {
    failure,
    dispose: () => {
      rejectFailure = null
      for (const entry of listeners) {
        try {
          entry.source.removeListener?.(entry.event, entry.listener)
        } catch {
          /* 已销毁的连接在移除监听时可能抛错，忽略 */
        }
      }
      listeners.length = 0
    }
  }
}

function errorCode(error: unknown): string {
  const candidate = error as { code?: unknown } | null
  return typeof candidate?.code === 'string' ? candidate.code : ''
}

function isNoSuchFile(error: unknown): boolean {
  // ssh2 的 SFTP 状态错误把 SSH_FX_NO_SUCH_FILE(2) 放在数值 code 上；
  // 本地 fs 走 ENOENT 字符串。两者都视为“不存在”。
  const candidate = error as { code?: unknown; message?: unknown } | null
  if (candidate?.code === 2 || candidate?.code === 'ENOENT') return true
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  return /no such file/i.test(message)
}

function remoteCall<T>(
  invoke: (callback: (error: Error | undefined, value: T) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((error, value) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
}

function remoteCallVoid(invoke: (callback: (error: Error | undefined) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    invoke((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export async function readRemoteLstat(sftp: TransferSftp, targetPath: string): Promise<FileSnapshot> {
  try {
    const stats = await remoteCall<TransferSftpStats>((callback) => sftp.lstat(targetPath, callback))
    return snapshotFromSftp(stats, stats.mtime * 1000)
  } catch (error) {
    if (isNoSuchFile(error)) return missingSnapshot()
    throw error
  }
}

export async function readRemoteStat(sftp: TransferSftp, targetPath: string): Promise<FileSnapshot> {
  try {
    const stats = await remoteCall<TransferSftpStats>((callback) => sftp.stat(targetPath, callback))
    return snapshotFromSftp(stats, stats.mtime * 1000)
  } catch (error) {
    if (isNoSuchFile(error)) return missingSnapshot()
    throw error
  }
}

async function readLocalSnapshot(targetPath: string, symlink: boolean): Promise<FileSnapshot> {
  try {
    const stats = symlink ? await fsp.stat(targetPath) : await fsp.lstat(targetPath)
    return snapshotFromLocal(stats)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return missingSnapshot()
    throw error
  }
}

async function readLocalLstat(targetPath: string): Promise<FileSnapshot> {
  return readLocalSnapshot(targetPath, false)
}

async function readLocalStat(targetPath: string): Promise<FileSnapshot> {
  return readLocalSnapshot(targetPath, true)
}

function createSemaphore(max: number) {
  let free = max
  const waiters: Array<() => void> = []
  return {
    async acquire(): Promise<void> {
      if (free > 0) {
        free -= 1
        return
      }
      await new Promise<void>((resolve) => waiters.push(resolve))
    },
    release(): void {
      const next = waiters.shift()
      if (next) next()
      else free += 1
    }
  }
}

type TransferReader = (buffer: Buffer, offset: number, length: number, position: number) => Promise<number>
type TransferWriter = (buffer: Buffer, offset: number, length: number, position: number) => Promise<void>

/**
 * 带滑动窗口的数据搬运：最多 MAX_INFLIGHT 个块在途，可随时被 abort 检查点中断。
 * 短读意味着源在传输中变化，直接以 TRANSFER_SOURCE_CHANGED 结束，绝不拼接。
 */
async function pumpTransfer(options: {
  total: number
  env: TransferEnvironment
  phase: TransferPhase
  read: TransferReader
  write: TransferWriter
}): Promise<number> {
  const { total, env, phase, read, write } = options
  const gate = createSemaphore(TRANSFER_MAX_INFLIGHT)
  const pending = new Set<Promise<void>>()
  let failure: unknown = null
  let nextOffset = 0
  let transferred = 0

  while (nextOffset < total) {
    await gate.acquire()
    if (failure !== null) {
      gate.release()
      break
    }
    const offset = nextOffset
    const length = Math.min(TRANSFER_CHUNK_SIZE, total - offset)
    nextOffset += length
    const buffer = Buffer.allocUnsafe(length)
    const task = (async () => {
      try {
        env.abort.throwIfAborted(phase)
        const filled = await read(buffer, 0, length, offset)
        if (filled !== length) {
          throw new TransferCommitError(
            'TRANSFER_SOURCE_CHANGED',
            `源文件在传输期间变短（位置 ${offset} 期望 ${length} 字节，实际 ${filled} 字节），已拒绝拼接不同版本`,
            phase
          )
        }
        env.abort.throwIfAborted(phase)
        await write(buffer, 0, filled, offset)
        transferred += filled
        env.onProgress?.({ transferredSize: transferred, fileSize: total, phase })
      } finally {
        gate.release()
      }
    })()
    const tracked = task.catch((error: unknown) => {
      if (failure === null) failure = error
    }).finally(() => { pending.delete(tracked) })
    pending.add(tracked)
  }

  // 等所有在途块结束，避免清理临时文件时仍有写入在飞
  await Promise.all([...pending])
  if (failure !== null) throw failure
  return transferred
}

async function raceTransport<T>(
  operation: Promise<T>,
  transportFailure: Promise<never> | undefined,
  onLost: () => Error
): Promise<T> {
  if (!transportFailure) return operation
  // 竞速失败后 operation 仍可能 reject，提前挂 catch 防止 unhandledRejection
  void operation.catch(() => undefined)
  try {
    return await Promise.race([operation, transportFailure])
  } catch (error) {
    if (error instanceof TransferTransportLostError) throw onLost()
    throw error
  }
}

async function openRemoteTemp(options: {
  sftp: TransferSftp
  targetPath: string
  attemptId: string
  inheritMode: boolean
}): Promise<{ handle: Buffer; tempPath: string }> {
  const { sftp, targetPath, attemptId, inheritMode } = options
  const mode = inheritMode ? TRANSFER_TEMP_MODE_PRIVATE : TRANSFER_TEMP_MODE_DEFAULT
  let tempPath = transferTempPath(targetPath, 'upload', attemptId)
  let lastError: unknown = null
  for (let attempt = 0; attempt < TRANSFER_TEMP_CREATE_RETRIES; attempt++) {
    try {
      const handle = await remoteCall<Buffer>((callback) => sftp.open(tempPath, 'wx', { mode }, callback))
      return { handle, tempPath }
    } catch (error) {
      lastError = error
      // O_EXCL 冲突（SSH_FX_FAILURE）时换随机名重试；其它错误立即上抛
      if (!isAlreadyExists(error)) break
      tempPath = transferTempPath(targetPath, 'upload', attemptId)
    }
  }
  throw new TransferCommitError('TRANSFER_IO_ERROR', `无法创建远端临时文件：${describeError(lastError)}`, 'data')
}

function isAlreadyExists(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null
  if (candidate?.code === 4 || candidate?.code === 'EEXIST') return true
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  return /exist/i.test(message)
}

async function openLocalTemp(options: {
  targetPath: string
  attemptId: string
  inheritMode: boolean
}): Promise<{ handle: fsp.FileHandle; tempPath: string }> {
  const { targetPath, attemptId, inheritMode } = options
  const mode = inheritMode ? TRANSFER_TEMP_MODE_PRIVATE : TRANSFER_TEMP_MODE_DEFAULT
  let tempPath = transferTempPath(targetPath, 'download', attemptId)
  for (let attempt = 0; attempt < TRANSFER_TEMP_CREATE_RETRIES; attempt++) {
    try {
      const handle = await fsp.open(tempPath, 'wx', mode)
      return { handle, tempPath }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new TransferCommitError(
          'TRANSFER_LOCAL_IO_ERROR',
          `无法创建本地临时文件：${describeError(error)}`,
          'data'
        )
      }
      tempPath = transferTempPath(targetPath, 'download', attemptId)
    }
  }
  throw new TransferCommitError('TRANSFER_LOCAL_IO_ERROR', '无法创建唯一的本地临时文件', 'data')
}

async function removeRemoteTemp(
  sftp: TransferSftp,
  tempPath: string
): Promise<{ state: TempCleanupState; residual?: string }> {
  try {
    await remoteCallVoid((callback) => sftp.unlink(tempPath, callback))
    return { state: 'removed' }
  } catch (error) {
    if (isNoSuchFile(error)) return { state: 'removed' }
    return { state: isTransportLost(error) ? 'unknown' : 'failed', residual: tempPath }
  }
}

async function removeLocalTemp(
  tempPath: string
): Promise<{ state: TempCleanupState; residual?: string }> {
  try {
    await fsp.unlink(tempPath)
    return { state: 'removed' }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: 'removed' }
    return { state: 'failed', residual: tempPath }
  }
}

async function closeRemoteHandle(sftp: TransferSftp, handle: Buffer): Promise<void> {
  try {
    await remoteCallVoid((callback) => sftp.close(handle, callback))
  } catch {
    /* 关闭失败不改变已写入数据的事实；后续以 fstat/unlink 结果为准 */
  }
}

/** 提交后确保目录项落盘；Windows 不支持对目录句柄 fsync，显式标记 unsupported */
async function syncDirectory(directory: string): Promise<DirectoryFsyncState> {
  if (process.platform === 'win32') return 'unsupported'
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(directory, 'r')
    await handle.sync()
    return 'synced'
  } catch (error) {
    const code = errorCode(error)
    if (['EINVAL', 'ENOTSUP', 'EACCES', 'EPERM', 'EISDIR'].includes(code)) return 'unsupported'
    return 'failed'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function describeSourceChange(change: SourceChange): string {
  switch (change) {
    case 'missing':
      return '源文件已消失'
    case 'type-changed':
      return '源路径类型已变化'
    case 'size':
      return '源文件大小已变化'
    case 'mtime':
      return '源文件修改时间已变化'
    case 'identity':
      return '源文件已被替换'
    default:
      return '源文件未变化'
  }
}

function describeTargetChange(change: TargetChange): string {
  switch (change) {
    case 'appeared':
      return '目标在传输期间出现'
    case 'removed':
      return '目标在传输期间被删除'
    case 'modified':
      return '目标在传输期间被修改'
    case 'type-changed':
      return '目标类型已变化'
    default:
      return '目标未变化'
  }
}

function percentOf(transferred: number, total: number): number {
  if (total <= 0) return transferred > 0 ? 100 : 0
  return Math.max(0, Math.min(100, Math.round((transferred / total) * 100)))
}

export interface UploadCommitOptions {
  sftp: TransferSftp
  localPath: string
  remotePath: string
  env: TransferEnvironment
  /** 测试注入；默认在远端目标同目录生成唯一随机名 */
  tempPath?: string
}

/**
 * 上传提交编排：本地源 → 远端临时文件 → 校验/元数据/fsync → rename → 终态校验。
 * 永不抛出：任何失败都折叠为带 outcome 的结果，便于 Manager 发明确回执。
 */
export async function commitUpload(options: UploadCommitOptions): Promise<TransferAttemptResult> {
  const { sftp, localPath, remotePath, env } = options
  const expectedSize = env.expectedSize
  const tempPath = options.tempPath ?? transferTempPath(remotePath, 'upload', env.attemptId)
  const targetPath = remotePath
  const tempPattern = describeTransferTempPattern(targetPath, 'upload', env.attemptId)

  let phase: TransferPhase = 'data'
  let sourceHandle: fsp.FileHandle | null = null
  let remoteHandle: Buffer | null = null
  let tempCreated = false
  let actualTempPath: string | undefined
  let bytesWritten = 0
  let finalSize: number | undefined
  let commitStrategy: CommitStrategy | undefined
  let commitDispatched = false
  let committed = false
  let fileFsync: FsyncState = 'skipped'
  const directoryFsync: DirectoryFsyncState = 'skipped'
  let tempCleanup: TempCleanupState = 'unused'
  let tempResidual: string | undefined
  const warnings: string[] = []
  let outcome: TransferOutcome = 'failed'
  let failure: { code: TransferErrorCode; message: string } | undefined
  let initialSource: FileSnapshot = missingSnapshot()
  let initialTarget: FileSnapshot = missingSnapshot()

  const setPhase = (next: TransferPhase): void => {
    phase = next
    env.onPhase?.(next)
  }

  try {
    env.abort.throwIfAborted('data')

    // 1. 源版本：先 lstat/stat 路径，再用已打开的句柄固定版本（句柄是唯一读取来源）
    const sourcePathSnapshot = await readLocalStat(localPath)
    if (!sourcePathSnapshot.exists) {
      throw new TransferCommitError('TRANSFER_SOURCE_MISSING', `本地源文件不存在：${localPath}`, 'data')
    }
    if (sourcePathSnapshot.kind !== 'file') {
      throw new TransferCommitError('TRANSFER_SOURCE_UNSAFE_TYPE', `本地源路径不是普通文件：${localPath}`, 'data')
    }
    sourceHandle = await fsp.open(localPath, 'r')
    const sourceHandleSnapshot = snapshotFromLocal(await sourceHandle.stat())
    if (compareSourceSnapshot(sourcePathSnapshot, sourceHandleSnapshot) !== 'unchanged') {
      throw new TransferCommitError('TRANSFER_SOURCE_CHANGED', '打开源文件前后源文件已被替换，已拒绝上传', 'data')
    }
    initialSource = sourceHandleSnapshot
    if (initialSource.size !== expectedSize) {
      throw new TransferCommitError(
        'TRANSFER_SOURCE_CHANGED',
        `源文件大小与派发时不一致（派发 ${expectedSize}，实际 ${initialSource.size}），已拒绝上传`,
        'data'
      )
    }

    // 2. 目标初始快照（lstat，不跟随符号链接）
    initialTarget = await readRemoteLstat(sftp, targetPath)
    const decision = decideUploadCommit({ target: initialTarget, posixRename: supportsPosixRename(sftp) })
    if (!decision.ok) {
      throw new TransferCommitError(decision.code, decision.message, 'verifying')
    }
    commitStrategy = decision.strategy

    // 3. 数据阶段：写入目标同目录临时文件
    setPhase('data')
    const opened = await openRemoteTemp({
      sftp,
      targetPath,
      attemptId: env.attemptId,
      inheritMode: initialTarget.exists
    })
    remoteHandle = opened.handle
    tempCreated = true
    actualTempPath = opened.tempPath
    env.onTempPath?.(opened.tempPath)

    const handle = remoteHandle
    bytesWritten = await pumpTransfer({
      total: expectedSize,
      env,
      phase: 'data',
      read: async (buffer, offset, length, position) => {
        let filled = 0
        while (filled < length) {
          env.abort.throwIfAborted('data')
          const { bytesRead } = await sourceHandle!.read(buffer, offset + filled, length - filled, position + filled)
          if (bytesRead === 0) break
          filled += bytesRead
        }
        return filled
      },
      write: async (buffer, offset, length, position) => {
        env.abort.throwIfAborted('data')
        await remoteCallVoid((callback) => sftp.write(handle, buffer, offset, length, position, callback))
      }
    })

    // 4. 校验阶段：字节数、临时文件大小、源/目标快照、权限、落盘
    env.abort.throwIfAborted('verifying')
    setPhase('verifying')

    const sourceNow = snapshotFromLocal(await sourceHandle.stat())
    const sourceChange = compareSourceSnapshot(initialSource, sourceNow)
    if (sourceChange !== 'unchanged') {
      throw new TransferCommitError(
        'TRANSFER_SOURCE_CHANGED',
        `传输期间${describeSourceChange(sourceChange)}，已拒绝提交`,
        'verifying'
      )
    }
    const sourcePathNow = await readLocalStat(localPath)
    if (compareSourceSnapshot(initialSource, sourcePathNow) !== 'unchanged') {
      throw new TransferCommitError('TRANSFER_SOURCE_CHANGED', '传输期间源文件路径被替换，已拒绝提交', 'verifying')
    }

    const sizeCheck = verifyTransferSize({
      expectedSize,
      transferredBytes: bytesWritten,
      finalSize: (await remoteCall<TransferSftpStats>((callback) => sftp.fstat(handle, callback))).size
    })
    if (!sizeCheck.ok) throw new TransferCommitError('TRANSFER_SIZE_MISMATCH', sizeCheck.message, 'verifying')

    const targetNow = await readRemoteLstat(sftp, targetPath)
    const targetChange = compareTargetSnapshot(initialTarget, targetNow)
    if (targetChange !== 'unchanged') {
      throw new TransferCommitError(
        'TRANSFER_TARGET_CHANGED',
        `传输期间${describeTargetChange(targetChange)}，已拒绝覆盖（旧目标未改动）`,
        'verifying'
      )
    }

    // 继承旧目标权限，避免临时文件默认权限意外放宽
    if (initialTarget.exists && initialTarget.kind === 'file') {
      try {
        await remoteCallVoid((callback) => sftp.fchmod(handle, initialTarget.mode & 0o7777, callback))
      } catch (error) {
        throw new TransferCommitError(
          'TRANSFER_IO_ERROR',
          `无法继承旧目标权限（mode ${(initialTarget.mode & 0o7777).toString(8)}）：${describeError(error)}`,
          'verifying'
        )
      }
    }

    if (supportsFsync(sftp)) {
      if (typeof sftp.ext_openssh_fsync !== 'function') {
        throw new TransferCommitError('TRANSFER_IO_ERROR', '远端声明支持 fsync@openssh.com 但缺少对应实现', 'verifying')
      }
      try {
        await remoteCallVoid((callback) => sftp.ext_openssh_fsync!(handle, callback))
        fileFsync = 'file'
      } catch (error) {
        throw new TransferCommitError('TRANSFER_IO_ERROR', `远端临时文件 fsync 失败：${describeError(error)}`, 'verifying')
      }
    } else {
      warnings.push('远端 SFTP 未声明 fsync@openssh.com，已跳过临时文件落盘刷写确认')
    }

    await closeRemoteHandle(sftp, handle)
    remoteHandle = null

    // 5. 提交阶段：取消只在派发前生效；派发后等待回执，不盲目重试
    env.abort.throwIfAborted('committing')
    setPhase('committing')

    const targetPreCommit = await readRemoteLstat(sftp, targetPath)
    const preCommitChange = compareTargetSnapshot(initialTarget, targetPreCommit)
    if (preCommitChange !== 'unchanged') {
      throw new TransferCommitError(
        'TRANSFER_TARGET_CHANGED',
        `提交前${describeTargetChange(preCommitChange)}，已拒绝覆盖（旧目标未改动）`,
        'committing'
      )
    }

    env.abort.throwIfAborted('committing')
    commitDispatched = true
    const strategy = commitStrategy ?? 'posix-rename'
    const commitOperation =
      strategy === 'posix-rename'
        ? remoteCallVoid((callback) => {
            if (typeof sftp.ext_openssh_rename !== 'function') {
              throw new TransferCommitError(
                'TRANSFER_ATOMIC_REPLACE_UNSUPPORTED',
                '远端 SFTP 未提供 posix-rename@openssh.com，已拒绝覆盖已有文件',
                'committing'
              )
            }
            sftp.ext_openssh_rename(actualTempPath ?? tempPath, targetPath, callback)
          })
        : remoteCallVoid((callback) => sftp.rename(actualTempPath ?? tempPath, targetPath, callback))
    const guardedCommit = commitOperation.catch((error: unknown) => {
      if (error instanceof TransferCommitError) throw error
      if (isTransportLost(error)) throw new TransferTransportLostError(describeError(error))
      throw new TransferCommitError(
        'TRANSFER_COMMIT_FAILED',
        `提交（rename）失败，旧目标未被替换：${describeError(error)}`,
        'committing'
      )
    })
    await raceTransport(guardedCommit, env.transportFailure, () => {
      return new TransferCommitError(
        'TRANSFER_COMMIT_ACK_LOST',
        '提交请求已发出但连接中断，未收到 rename 回执；无法确认是否生效，已停止重试',
        'committing'
      )
    })
    committed = true
    tempCleanup = 'removed'
    setPhase('completed')

    // 6. 终态校验：rename 回执之后目标必须是预期大小的普通文件
    const finalSnapshot = await readRemoteLstat(sftp, targetPath)
    if (!finalSnapshot.exists || finalSnapshot.kind !== 'file' || finalSnapshot.size !== expectedSize) {
      committed = true
      warnings.push('提交已收到回执，但提交后目标校验失败；目标可能已被替换，请人工核查')
      throw new TransferCommitError(
        'TRANSFER_FINAL_VERIFY_FAILED',
        `提交后目标校验失败（期望 ${expectedSize} 字节普通文件，实际 ${finalSnapshot.exists ? `${finalSnapshot.kind} ${finalSnapshot.size} 字节` : '不存在'}）`,
        'completed'
      )
    }
    finalSize = finalSnapshot.size
    outcome = 'completed'
  } catch (error) {
    const classified = classifyTransferFailure(error, { phase, commitDispatched, committed })
    outcome = classified.outcome
    failure = { code: classified.code, message: classified.message }
  } finally {
    if (sourceHandle) {
      await sourceHandle.close().catch(() => undefined)
      sourceHandle = null
    }
    if (remoteHandle) {
      const handle = remoteHandle
      remoteHandle = null
      await closeRemoteHandle(sftp, handle)
    }
    if (!committed && tempCreated) {
      const cleanup = await removeRemoteTemp(sftp, actualTempPath ?? tempPath)
      tempCleanup = cleanup.state
      tempResidual = cleanup.residual
      if (cleanup.state !== 'removed') {
        warnings.push(`临时文件未能确认清理，可能残留：${cleanup.residual ?? actualTempPath ?? tempPath}`)
      }
    }
  }

  if (tempCleanup === 'failed' || tempCleanup === 'unknown') {
    // 结果未知时保留原错误码（例如 ACK 丢失），清理残留只作为附加信息
    warnings.push('临时文件清理状态：' + tempCleanup)
  }

  return {
    taskId: env.taskId,
    attemptId: env.attemptId,
    direction: 'upload',
    outcome,
    phase,
    expectedSize,
    transferredSize: bytesWritten,
    bytesWritten,
    finalSize,
    tempPath: actualTempPath,
    tempPattern,
    targetPath,
    tempCleanup,
    tempResidual,
    fileFsync,
    directoryFsync,
    commitStrategy,
    commitDispatched,
    committed,
    warnings,
    error: failure
  }
}

export interface DownloadCommitOptions {
  sftp: TransferSftp
  remotePath: string
  localPath: string
  env: TransferEnvironment
  /** 测试注入；默认在本地目标同目录生成唯一随机名 */
  tempPath?: string
}

/**
 * 下载提交编排：远端源 → 本地临时文件 → 校验/权限/fsync → 本地 rename → 终态校验。
 * 永不抛出：失败折叠为结果，Manager 据此发明确回执（含残留路径）。
 */
export async function commitDownload(options: DownloadCommitOptions): Promise<TransferAttemptResult> {
  const { sftp, remotePath, localPath, env } = options
  const expectedSize = env.expectedSize
  const tempPath = options.tempPath ?? transferTempPath(localPath, 'download', env.attemptId)
  const targetPath = localPath
  const tempPattern = describeTransferTempPattern(targetPath, 'download', env.attemptId)

  let phase: TransferPhase = 'data'
  let remoteHandle: Buffer | null = null
  let localHandle: fsp.FileHandle | null = null
  let tempCreated = false
  let actualTempPath: string | undefined
  let bytesWritten = 0
  let finalSize: number | undefined
  let commitStrategy: CommitStrategy | undefined
  let commitDispatched = false
  let committed = false
  let fileFsync: FsyncState = 'skipped'
  let directoryFsync: DirectoryFsyncState = 'skipped'
  let tempCleanup: TempCleanupState = 'unused'
  let tempResidual: string | undefined
  const warnings: string[] = []
  let outcome: TransferOutcome = 'failed'
  let failure: { code: TransferErrorCode; message: string } | undefined
  let initialSource: FileSnapshot = missingSnapshot()
  let initialSourceHandle: FileSnapshot = missingSnapshot()
  let initialTarget: FileSnapshot = missingSnapshot()

  const setPhase = (next: TransferPhase): void => {
    phase = next
    env.onPhase?.(next)
  }

  try {
    env.abort.throwIfAborted('data')

    // 1. 本地目标初始快照（lstat，不跟随符号链接）
    initialTarget = await readLocalLstat(targetPath)
    const decision = decideDownloadCommit({ target: initialTarget })
    if (!decision.ok) {
      throw new TransferCommitError(decision.code, decision.message, 'verifying')
    }
    commitStrategy = decision.strategy

    // 2. 远端源版本：stat 取快照，再用句柄固定版本
    const sourcePathSnapshot = await readRemoteStat(sftp, remotePath)
    if (!sourcePathSnapshot.exists) {
      throw new TransferCommitError('TRANSFER_SOURCE_MISSING', `远端源文件不存在：${remotePath}`, 'data')
    }
    if (sourcePathSnapshot.kind !== 'file') {
      throw new TransferCommitError('TRANSFER_SOURCE_UNSAFE_TYPE', `远端源路径不是普通文件：${remotePath}`, 'data')
    }
    if (sourcePathSnapshot.size !== expectedSize) {
      throw new TransferCommitError(
        'TRANSFER_SOURCE_CHANGED',
        `远端源文件大小与列目录时不一致（列目录 ${expectedSize}，当前 ${sourcePathSnapshot.size}），已拒绝下载`,
        'data'
      )
    }
    remoteHandle = await remoteCall<Buffer>((callback) => sftp.open(remotePath, 'r', { mode: 0o600 }, callback))
    const handleStats = await remoteCall<TransferSftpStats>((callback) => sftp.fstat(remoteHandle!, callback))
    // 句柄快照保留服务器给出的真实 mtime：路径 stat 与 open 之间被同大小文件替换时，mtime 是唯一可证伪的证据
    const sourceHandleSnapshot = snapshotFromSftp(handleStats, handleStats.mtime * 1000)
    if (compareSourceSnapshot(sourcePathSnapshot, sourceHandleSnapshot) !== 'unchanged') {
      throw new TransferCommitError('TRANSFER_SOURCE_CHANGED', '打开远端源文件前后文件已变化，已拒绝下载', 'data')
    }
    initialSource = sourcePathSnapshot
    initialSourceHandle = sourceHandleSnapshot

    // 3. 数据阶段：写入本地目标同目录临时文件
    setPhase('data')
    const opened = await openLocalTemp({
      targetPath,
      attemptId: env.attemptId,
      inheritMode: initialTarget.exists
    })
    localHandle = opened.handle
    tempCreated = true
    actualTempPath = opened.tempPath
    env.onTempPath?.(opened.tempPath)

    const local = localHandle
    const remote = remoteHandle
    bytesWritten = await pumpTransfer({
      total: expectedSize,
      env,
      phase: 'data',
      read: async (buffer, offset, length, position) => {
        let filled = 0
        while (filled < length) {
          env.abort.throwIfAborted('data')
          const bytesRead = await remoteCall<number>((callback) =>
            sftp.read(remote, buffer, offset + filled, length - filled, position + filled, callback)
          )
          if (!bytesRead) break
          filled += bytesRead
        }
        return filled
      },
      write: async (buffer, offset, length, position) => {
        let written = 0
        while (written < length) {
          env.abort.throwIfAborted('data')
          const result = await local.write(buffer, offset + written, length - written, position + written)
          if (!result.bytesWritten) {
            throw new TransferCommitError('TRANSFER_LOCAL_IO_ERROR', '本地写入未推进', 'data')
          }
          written += result.bytesWritten
        }
      }
    })

    // 4. 校验阶段
    env.abort.throwIfAborted('verifying')
    setPhase('verifying')

    const localStats = await local.stat()
    const sizeCheck = verifyTransferSize({
      expectedSize,
      transferredBytes: bytesWritten,
      finalSize: localStats.size
    })
    if (!sizeCheck.ok) throw new TransferCommitError('TRANSFER_SIZE_MISMATCH', sizeCheck.message, 'verifying')

    const sourceNow = await readRemoteStat(sftp, remotePath)
    const sourceChange = compareSourceSnapshot(initialSource, sourceNow)
    if (sourceChange !== 'unchanged') {
      throw new TransferCommitError(
        'TRANSFER_SOURCE_CHANGED',
        `传输期间远端${describeSourceChange(sourceChange)}，已拒绝提交`,
        'verifying'
      )
    }
    // 读取句柄复核：路径可能已被还原成旧快照，只有句柄自身的 fstat 能证明读到的字节属于初始版本
    const handleNowStats = await remoteCall<TransferSftpStats>((callback) => sftp.fstat(remoteHandle!, callback))
    const handleChange = compareSourceSnapshot(
      initialSourceHandle,
      snapshotFromSftp(handleNowStats, handleNowStats.mtime * 1000)
    )
    if (handleChange !== 'unchanged') {
      throw new TransferCommitError(
        'TRANSFER_SOURCE_CHANGED',
        `传输期间远端读取句柄${describeSourceChange(handleChange)}，已拒绝提交`,
        'verifying'
      )
    }
    const targetNow = await readLocalLstat(targetPath)
    const targetChange = compareTargetSnapshot(initialTarget, targetNow)
    if (targetChange !== 'unchanged') {
      throw new TransferCommitError(
        'TRANSFER_TARGET_CHANGED',
        `传输期间本地${describeTargetChange(targetChange)}，已拒绝覆盖（旧目标未改动）`,
        'verifying'
      )
    }

    if (initialTarget.exists && initialTarget.kind === 'file') {
      try {
        await local.chmod(initialTarget.mode & 0o7777)
      } catch (error) {
        throw new TransferCommitError(
          'TRANSFER_LOCAL_IO_ERROR',
          `无法继承旧目标权限（mode ${(initialTarget.mode & 0o7777).toString(8)}）：${describeError(error)}`,
          'verifying'
        )
      }
    }

    // 本地文件 fsync：确保 rename 前数据已落盘（Windows 上 Node 的 fsync 语义有限，仍调用）
    try {
      await local.sync()
      fileFsync = 'file'
    } catch (error) {
      throw new TransferCommitError('TRANSFER_LOCAL_IO_ERROR', `本地临时文件 fsync 失败：${describeError(error)}`, 'verifying')
    }

    await local.close()
    localHandle = null
    if (remoteHandle) {
      await closeRemoteHandle(sftp, remoteHandle)
      remoteHandle = null
    }

    // 5. 提交阶段：本地同目录 rename 原子替换
    env.abort.throwIfAborted('committing')
    setPhase('committing')

    const targetPreCommit = await readLocalLstat(targetPath)
    const preCommitChange = compareTargetSnapshot(initialTarget, targetPreCommit)
    if (preCommitChange !== 'unchanged') {
      throw new TransferCommitError(
        'TRANSFER_TARGET_CHANGED',
        `提交前本地${describeTargetChange(preCommitChange)}，已拒绝覆盖（旧目标未改动）`,
        'committing'
      )
    }

    env.abort.throwIfAborted('committing')
    commitDispatched = true
    try {
      await fsp.rename(actualTempPath ?? tempPath, targetPath)
    } catch (error) {
      throw new TransferCommitError(
        'TRANSFER_COMMIT_FAILED',
        `本地 rename 失败，旧目标未被替换：${describeError(error)}`,
        'committing'
      )
    }
    committed = true
    tempCleanup = 'removed'
    setPhase('completed')

    const finalSnapshot = await readLocalLstat(targetPath)
    if (!finalSnapshot.exists || finalSnapshot.kind !== 'file' || finalSnapshot.size !== expectedSize) {
      committed = true
      warnings.push('提交已成功，但提交后目标校验失败；目标可能已被替换，请人工核查')
      throw new TransferCommitError(
        'TRANSFER_FINAL_VERIFY_FAILED',
        `提交后目标校验失败（期望 ${expectedSize} 字节普通文件，实际 ${finalSnapshot.exists ? `${finalSnapshot.kind} ${finalSnapshot.size} 字节` : '不存在'}）`,
        'completed'
      )
    }
    finalSize = finalSnapshot.size

    directoryFsync = await syncDirectory(path.dirname(targetPath))
    if (directoryFsync === 'failed') {
      warnings.push('目录项 fsync 失败：rename 已生效，但目录变更可能未立即落盘')
    } else if (directoryFsync === 'unsupported') {
      warnings.push('当前平台/文件系统不支持对目录句柄 fsync，目录项落盘依赖系统行为')
    }

    outcome = 'completed'
  } catch (error) {
    const classified = classifyTransferFailure(error, { phase, commitDispatched, committed })
    outcome = classified.outcome
    failure = { code: classified.code, message: classified.message }
  } finally {
    if (localHandle) {
      const handle = localHandle
      localHandle = null
      await handle.close().catch(() => undefined)
    }
    if (remoteHandle) {
      const handle = remoteHandle
      remoteHandle = null
      await closeRemoteHandle(sftp, handle)
    }
    if (!committed && tempCreated) {
      const cleanup = await removeLocalTemp(actualTempPath ?? tempPath)
      tempCleanup = cleanup.state
      tempResidual = cleanup.residual
      if (cleanup.state !== 'removed') {
        warnings.push(`临时文件未能确认清理，可能残留：${cleanup.residual ?? actualTempPath ?? tempPath}`)
      }
    }
  }

  if (tempCleanup === 'failed' || tempCleanup === 'unknown') {
    warnings.push('临时文件清理状态：' + tempCleanup)
  }

  return {
    taskId: env.taskId,
    attemptId: env.attemptId,
    direction: 'download',
    outcome,
    phase,
    expectedSize,
    transferredSize: bytesWritten,
    bytesWritten,
    finalSize,
    tempPath: actualTempPath,
    tempPattern,
    targetPath,
    tempCleanup,
    tempResidual,
    fileFsync,
    directoryFsync,
    commitStrategy,
    commitDispatched,
    committed,
    warnings,
    error: failure
  }
}

/** 百分比（供 Worker 进度与 Manager 回执复用） */
export function transferPercent(transferred: number, total: number): number {
  return percentOf(transferred, total)
}
