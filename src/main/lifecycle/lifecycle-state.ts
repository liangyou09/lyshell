/**
 * 退出状态标记：区分「致命退出」与「正常退出」，供下次启动做保守恢复。
 *
 * 约束（见 docs/lyshell-complete-remediation-plan-2026-10-30.md 4.3/4.5）：
 * - 同步写、定长、脱敏（复用 fatal-error 的 redact），失败返回 false 而不是抛错；
 * - 只写生命周期自己的固定文件，**不调用任何业务仓储**，不覆盖业务数据；
 * - 下次启动只读、只记录，不自动重放副作用。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { FatalReport } from './fatal-error'
import type { ShutdownReport } from './app-lifecycle'

export const LIFECYCLE_STATE_DIR = 'lifecycle'
export const FATAL_STATE_FILE = 'fatal-last.json'
export const SHUTDOWN_STATE_FILE = 'last-shutdown.json'

/** 单条记录的最大字符数：状态文件是诊断标记，不是数据文件。 */
export const EXIT_STATE_MAX_CHARS = 2_048
const REASON_MAX = 600
const UNCONFIRMED_MAX = 32

export interface ExitStateRecord {
  kind: 'fatal' | 'stopped'
  /** 退出发生时刻（毫秒时间戳）。 */
  at: number
  pid: number
  reason?: string
  /** 致命退出时记录进入致命状态前的阶段；正常退出固定为 stopped。 */
  phase?: string
  unconfirmed?: string[]
}

function stateDir(userDataDir: string): string {
  return join(userDataDir, LIFECYCLE_STATE_DIR)
}

function boundReason(text: string): string {
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX)}…`
}

function boundJson(record: ExitStateRecord): string {
  let json = JSON.stringify(record)
  if (json.length <= EXIT_STATE_MAX_CHARS) return json
  json = JSON.stringify({ ...record, reason: record.reason?.slice(0, 200), unconfirmed: record.unconfirmed?.slice(0, 8) })
  if (json.length <= EXIT_STATE_MAX_CHARS) return json
  return JSON.stringify({ kind: record.kind, at: record.at, pid: record.pid })
}

/**
 * 同步落盘。先写同目录临时文件再 rename；rename 失败时退化为直接写
 * （状态文件不是业务数据，宁可留下不完整标记也不要让退出路径抛错）。
 */
function writeAtomic(file: string, data: string): boolean {
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, data, 'utf-8')
    renameSync(temp, file)
    return true
  } catch {
    try { writeFileSync(file, data, 'utf-8') } catch { return false }
    return true
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* ignore */ }
  }
}

function writeExitState(userDataDir: string, fileName: string, record: ExitStateRecord): boolean {
  try {
    mkdirSync(stateDir(userDataDir), { recursive: true })
  } catch {
    return false
  }
  return writeAtomic(join(stateDir(userDataDir), fileName), boundJson(record))
}

/** 致命退出标记：只含定位所需字段，不含业务数据。 */
export function writeFatalState(userDataDir: string, report: FatalReport): boolean {
  return writeExitState(userDataDir, FATAL_STATE_FILE, {
    kind: 'fatal',
    at: report.at,
    pid: report.pid,
    reason: boundReason(`${report.source} ${report.name}: ${report.message}`),
    phase: report.phase
  })
}

/** 正常退出标记：记录未确认步骤名，供下次启动保守恢复参考。 */
export function writeShutdownState(userDataDir: string, report: ShutdownReport): boolean {
  return writeExitState(userDataDir, SHUTDOWN_STATE_FILE, {
    kind: 'stopped',
    at: report.finishedAt,
    pid: process.pid,
    reason: boundReason(`${report.reason} elapsed=${report.elapsedMs}ms timedOut=${report.timedOut}`),
    phase: report.kind,
    unconfirmed: report.unconfirmed.slice(0, UNCONFIRMED_MAX)
  })
}

function parseRecord(raw: string): ExitStateRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (record.kind !== 'fatal' && record.kind !== 'stopped') return null
    if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return null
    if (typeof record.pid !== 'number' || !Number.isFinite(record.pid)) return null
    return {
      kind: record.kind,
      at: record.at,
      pid: record.pid,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
      ...(Array.isArray(record.unconfirmed)
        ? { unconfirmed: record.unconfirmed.filter((item): item is string => typeof item === 'string').slice(0, UNCONFIRMED_MAX) }
        : {})
    }
  } catch {
    return null
  }
}

function readRecord(userDataDir: string, fileName: string): ExitStateRecord | null {
  try {
    return parseRecord(readFileSync(join(stateDir(userDataDir), fileName), 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 读取最近一次退出标记（fatal 与 stopped 取 `at` 更新者）。损坏/缺失返回 null，
 * 调用方只应记录日志，不得据此自动重放业务副作用。
 */
export function readLastExitState(userDataDir: string): ExitStateRecord | null {
  const fatal = readRecord(userDataDir, FATAL_STATE_FILE)
  const stopped = readRecord(userDataDir, SHUTDOWN_STATE_FILE)
  if (fatal && stopped) return fatal.at >= stopped.at ? fatal : stopped
  return fatal ?? stopped
}
