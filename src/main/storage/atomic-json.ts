import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { mkdir, open, rename, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'

/**
 * 可靠 JSON 文件基础层。
 *
 * 约定：
 * - 只做「同目录唯一临时文件 → 完整写入 → fsync → close → rename」的替换式提交，
 *   任何阶段失败都保留旧目标文件、清理本次临时对象并抛错；永远不会先删除目标。
 * - 读取严格区分「不存在 / 内容损坏（含 schema 不符）/ 不可读（权限、IO）」，
 *   读取路径绝不写文件。损坏时可从同目录 `.bak` 校验后恢复，且先把损坏原件
 *   另存为 `.corrupt-<时间戳>`，不会让默认值直接覆盖原件。
 * - 备份只保存调用方已经成功提交过的原始文本；本层不知道内容语义，因此由仓储
 *   在提交成功后调用 writeBackupSync。
 *
 * Windows 边界：rename 走 MoveFileEx(REPLACE_EXISTING) 语义，文件内容 fsync 后
 * 再替换；但 Windows 没有可移植的「目录 fsync」，目录项刷新时机由系统决定，
 * 本层不声明掉电保证。POSIX 上会尽力 fsync 父目录。
 */

export type AtomicWritePhase = 'mkdir' | 'temp-create' | 'write' | 'fsync' | 'chmod' | 'rename' | 'dir-fsync'

export class AtomicJsonError extends Error {
  readonly code = 'ATOMIC_WRITE_FAILED'
  readonly phase: AtomicWritePhase
  readonly path: string
  readonly cause?: unknown

  constructor(phase: AtomicWritePhase, filePath: string, cause: unknown) {
    super(`原子写入失败（${phase}）：${filePath}：${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'AtomicJsonError'
    this.phase = phase
    this.path = filePath
    this.cause = cause
  }
}

export class JsonStoreLoadError extends Error {
  readonly code = 'JSON_STORE_LOAD_FAILED'
  readonly path: string
  readonly reason: 'corrupt' | 'unreadable'

  constructor(filePath: string, reason: 'corrupt' | 'unreadable', cause?: unknown) {
    // JSON.parse 的 SyntaxError 可能包含原文片段（包括旧版明文密钥）。
    const detail = reason === 'corrupt' ? '' : cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause)
    super(
      `配置文件${reason === 'corrupt' ? '损坏或 schema 不受支持' : '不可读'}：${filePath}${detail ? `（${detail}）` : ''}`
    )
    this.name = 'JsonStoreLoadError'
    this.path = filePath
    this.reason = reason
    this.cause = reason === 'corrupt' ? undefined : cause
  }
}

export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT'
  readonly path: string
  readonly expected: number
  readonly actual: number

  constructor(filePath: string, expected: number, actual: number) {
    super(`配置版本冲突：${filePath}：期望 revision ${expected}，当前为 ${actual}`)
    this.name = 'RevisionConflictError'
    this.path = filePath
    this.expected = expected
    this.actual = actual
  }
}

export interface AtomicWriteOptions {
  /** 文件权限，默认 0600。 */
  mode?: number
  /** 是否在 close 前 fsync 文件内容，默认 true。 */
  fsync?: boolean
}

function tempPathFor(filePath: string): string {
  const dir = dirname(filePath)
  return join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
}

function tryFsyncDir(dir: string): void {
  // Windows 无法打开目录句柄做 fsync；不把目录刷新计入保证。
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // 尽力而为：目录 fsync 失败不影响已经完成的 rename 结果
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 同步原子写：同目录唯一临时文件 + 0600 + 完整写入 + fsync + close + rename。
 * 失败时旧目标保持原样，临时文件被清理，并抛出 AtomicJsonError。
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string,
  options: AtomicWriteOptions = {}
): void {
  const mode = options.mode ?? 0o600
  const dir = dirname(filePath)
  let tmpPath: string | undefined
  let fd: number | undefined
  let created = false
  let phase: AtomicWritePhase = 'mkdir'

  try {
    mkdirSync(dir, { recursive: true })
    phase = 'temp-create'
    tmpPath = tempPathFor(filePath)
    fd = openSync(tmpPath, 'wx', mode)
    created = true

    phase = 'write'
    writeFileSync(fd, data, { encoding: 'utf-8' })

    if (options.fsync !== false) {
      phase = 'fsync'
      fsyncSync(fd)
    }

    phase = 'chmod'
    closeSync(fd)
    fd = undefined
    try {
      chmodSync(tmpPath, mode)
    } catch {
      // 权限收紧是尽力而为：open 时已带 mode，Windows 上 chmod 语义有限
    }

    phase = 'rename'
    renameSync(tmpPath, filePath)
    tmpPath = undefined

    tryFsyncDir(dir)
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
    if (tmpPath && created) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // 清理失败也不能掩盖原始错误
      }
    }
    throw new AtomicJsonError(phase, filePath, err)
  }
}

/**
 * 异步原子写（供 download-history 等已有异步仓储使用）。
 * 语义与同步版本一致：唯一临时文件、0600、fsync、rename，失败清理临时文件。
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const mode = options.mode ?? 0o600
  const dir = dirname(filePath)
  let tmpPath: string | undefined
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  let phase: AtomicWritePhase = 'mkdir'

  try {
    await mkdir(dir, { recursive: true })

    phase = 'temp-create'
    tmpPath = tempPathFor(filePath)
    handle = await open(tmpPath, 'wx', mode)
    created = true

    phase = 'write'
    await handle.writeFile(data, { encoding: 'utf-8' })

    if (options.fsync !== false) {
      phase = 'fsync'
      await handle.sync()
    }

    phase = 'chmod'
    try { await handle.chmod(mode) } catch { /* open 时已指定权限；Windows chmod 有限 */ }
    await handle.close()
    handle = undefined

    phase = 'rename'
    await rename(tmpPath, filePath)
    tmpPath = undefined

    // 与同步版相同：POSIX 目录 fsync 尽力执行；失败不能否认已完成的 rename。
    if (process.platform !== 'win32') {
      let directory: Awaited<ReturnType<typeof open>> | undefined
      try {
        directory = await open(dir, 'r')
        await directory.sync()
      } catch { /* 平台/文件系统不支持目录同步时保留已提交结果 */ }
      finally { try { await directory?.close() } catch { /* ignore */ } }
    }
  } catch (err) {
    try { await handle?.close() } catch { /* 保留原始错误 */ }
    if (tmpPath && created) {
      try { await unlink(tmpPath) } catch { /* 临时文件可能尚未创建 */ }
    }
    throw new AtomicJsonError(phase, filePath, err)
  }
}

/** 主文件提交后串行刷新备份；失败只影响备份，不撤回主文件提交。 */
export async function writeBackup(filePath: string, raw: string): Promise<boolean> {
  try {
    await atomicWriteFile(backupPathFor(filePath), raw)
    return true
  } catch {
    return false
  }
}

export type JsonReadStatus = 'missing' | 'ok' | 'corrupt' | 'unreadable'

export interface JsonReadResult<T> {
  status: JsonReadStatus
  value?: T
  raw?: string
  error?: unknown
}

/**
 * 只读解析：不存在仅指 ENOENT；JSON/schema 失败归为 corrupt；其余 IO/权限错误归为
 * unreadable。绝不写文件。
 */
export function readJsonFileSync<T>(
  filePath: string,
  validate?: (raw: unknown) => T
): JsonReadResult<T> {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { status: 'missing' }
    return { status: 'unreadable', error: err }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { status: 'corrupt', raw, error: err }
  }

  if (!validate) return { status: 'ok', value: parsed as T, raw }

  try {
    return { status: 'ok', value: validate(parsed), raw }
  } catch (err) {
    return { status: 'corrupt', raw, error: err }
  }
}

export function backupPathFor(filePath: string): string {
  return `${filePath}.bak`
}

/**
 * 提交成功后写 `.bak`。返回 false 表示备份失败——调用方应记录告警，但不能因此
 * 把已经成功的正式提交报告为失败。
 */
export function writeBackupSync(filePath: string, raw: string): boolean {
  try {
    atomicWriteFileSync(backupPathFor(filePath), raw)
    return true
  } catch {
    return false
  }
}

export type JsonLoadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T; raw: string }
  | { status: 'recovered'; value: T; raw: string; preservedPath?: string }
  | { status: 'failed'; error: JsonStoreLoadError; preservedPath?: string }

export interface LoadJsonOptions<T> {
  validate: (raw: unknown) => T
  /**
   * 损坏时是否自动用 `.bak` 替换正式文件，默认 false。
   * 默认只另存 `.corrupt-*` 并进入失败态：未知的新版本 schema 或运行中产生的
   * 半截文件都不应被旧备份静默覆盖。需要恢复时调用 `recoverJsonFileFromBackupSync`。
   * 即使为 true，也只有在损坏原件成功另存为 `.corrupt-*` 之后才会替换。
   */
  backup?: boolean
}

function preserveCorruptFile(filePath: string): string | undefined {
  const stamp = Date.now()
  for (let attempt = 0; attempt < 100; attempt++) {
    const target = `${filePath}.corrupt-${stamp}${attempt === 0 ? '' : `-${attempt}`}`
    try {
      copyFileSync(filePath, target, fsConstants.COPYFILE_EXCL)
      return target
    } catch (err) {
      if (isErrno(err, 'EEXIST')) continue
      return undefined
    }
  }
  return undefined
}

/**
 * 加载 JSON：
 * - missing：文件不存在（调用方按首次启动处理，可自行初始化）
 * - ok：解析并校验通过
 * - recovered：正式文件损坏，但 `.bak` 校验通过；损坏原件已另存 `.corrupt-*`，
 *   正式文件被恢复为备份内容
 * - failed：损坏或不可读，且没有可用备份（或损坏原件无法保全）；正式文件保持
 *   原样，调用方必须进入「只读失败态」，不能用默认值覆盖
 */
export function loadJsonFileSync<T>(filePath: string, options: LoadJsonOptions<T>): JsonLoadResult<T> {
  const primary = readJsonFileSync(filePath, options.validate)
  if (primary.status === 'missing') return { status: 'missing' }
  if (primary.status === 'ok') {
    return { status: 'ok', value: primary.value as T, raw: primary.raw as string }
  }

  if (primary.status === 'unreadable') {
    return { status: 'failed', error: new JsonStoreLoadError(filePath, 'unreadable', primary.error) }
  }

  // 损坏：先保留原件，再从备份恢复；原件无法保全（copy 失败、命名冲突耗尽）时
  // 立即停止，即使显式请求了备份恢复也不覆盖正式文件，避免原件字节丢失。
  const preservedPath = preserveCorruptFile(filePath)
  if (options.backup !== true || preservedPath === undefined) {
    return {
      status: 'failed',
      error: new JsonStoreLoadError(filePath, 'corrupt', primary.error),
      preservedPath
    }
  }

  const backup = readJsonFileSync(backupPathFor(filePath), options.validate)
  if (backup.status !== 'ok') {
    return {
      status: 'failed',
      error: new JsonStoreLoadError(filePath, 'corrupt', primary.error),
      preservedPath
    }
  }

  try {
    atomicWriteFileSync(filePath, backup.raw as string)
  } catch (err) {
    return {
      status: 'failed',
      error: new JsonStoreLoadError(filePath, 'corrupt', err),
      preservedPath
    }
  }

  return { status: 'recovered', value: backup.value as T, raw: backup.raw as string, preservedPath }
}

/**
 * 显式备份恢复：只有调用方确认需要时才执行。`.bak` 必须能通过同一个 validate；
 * 损坏原件先另存为 `.corrupt-*`，再原子替换正式文件。校验/写入失败、或损坏原件
 * 无法保全时返回 false，正式文件不变。
 */
export function recoverJsonFileFromBackupSync<T>(filePath: string, validate: (raw: unknown) => T): boolean {
  const result = loadJsonFileSync(filePath, { validate, backup: true })
  return result.status === 'recovered'
}

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}

/** 深拷贝 JSON 值，避免调用方绕过仓储直接改内存状态。 */
export function cloneJsonValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return structuredClone(value)
}
