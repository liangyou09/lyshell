/**
 * dsh 会话日志的发现与读取（`$DSH_HOME/sessions`）。
 *
 * 目录形状：`sessions/<projectKey>/session-<uuid>/session.v<N>.jsonl(.zstd)`。
 * - 同一个会话目录里可能同时留着 v3 与 v4 两代日志（dsh 升级后重写）：**只认最高版本**，
 *   否则同一段对话会被统计两遍。
 * - 文件可能是明文 `.jsonl`（早期版本）或 `.zstd`（多 frame 拼接，见 `zstd-frames.ts`）。
 * - 正在跑的会话随时在追加，所以「读到的不是全部」是常态：截断/损坏一律标记 `partial`，
 *   由上层把「读数可能偏低」显示出来，绝不假装完整。
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeZstdText } from './zstd-frames'

export interface DshSessionLogRef {
  projectKey: string
  sessionId: string
  path: string
  version: number
  zstd: boolean
  size: number
  mtimeMs: number
}

const LOG_NAME = /^session\.v(\d+)\.jsonl(\.zstd)?$/

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 列出所有会话日志（每个会话目录只取最高版本），按最后写入时间降序。 */
export async function listDshSessionLogs(sessionsDir: string): Promise<DshSessionLogRef[]> {
  let projects: string[]
  try {
    projects = await readdir(sessionsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  const refs: DshSessionLogRef[] = []
  for (const projectKey of projects) {
    const projectDir = join(sessionsDir, projectKey)
    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(projectDir)
    } catch (error) {
      if (isGone(error)) continue
      throw error
    }
    for (const sessionId of sessionDirs) {
      const dir = join(projectDir, sessionId)
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch (error) {
        if (isGone(error)) continue
        throw error
      }
      let best: { version: number; zstd: boolean; name: string } | null = null
      for (const name of entries) {
        const match = LOG_NAME.exec(name)
        if (!match) continue
        const version = Number(match[1])
        const zstd = match[2] === '.zstd'
        if (!best || version > best.version || (version === best.version && zstd && !best.zstd)) {
          best = { version, zstd, name }
        }
      }
      if (!best) continue
      const path = join(dir, best.name)
      try {
        const info = await stat(path)
        if (!info.isFile()) continue
        refs.push({
          projectKey,
          sessionId,
          path,
          version: best.version,
          zstd: best.zstd,
          size: info.size,
          mtimeMs: info.mtimeMs
        })
      } catch (error) {
        if (isGone(error)) continue
        throw error
      }
    }
  }
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return refs
}

/** 会话日志的事件行。字段按 dsh 持久化格式只取用得上的部分；未知字段忽略。 */
export interface DshSessionEvent {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
  // 会话头（`type: 'session'`）把身份写在顶层，不在 data 里
  version?: number
  id?: string
  createdAt?: number
  cwd?: string
  isSeeded?: boolean
}

export interface DshSessionLogRead {
  events: DshSessionEvent[]
  bytes: number
  frames: number
  failedFrames: number
  skippedLines: number
  /** 日志有损坏/截断/坏行：读数可能偏低 */
  partial: boolean
  error: string | null
}

function parseEventLines(text: string): { events: DshSessionEvent[]; skipped: number } {
  const events: DshSessionEvent[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      skipped += 1
      continue
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      skipped += 1
      continue
    }
    events.push(parsed as DshSessionEvent)
  }
  return { events, skipped }
}

/** 会话头的只读摘要（用于「这个日志属于哪个工作目录」的匹配，不需要解完整文件）。 */
export interface DshSessionHeader {
  id: string | null
  cwd: string | null
  createdAt: number | null
  isSeeded: boolean
}

/** 会话头只占日志开头：探针读 64KB 就够，避免为了匹配目录把几十 MB 日志全读一遍。 */
const HEADER_PROBE_BYTES = 64 * 1024

/**
 * 只读会话头。日志动辄上 MB（单文件最多 270 个 frame），而「哪个目录的会话」这个判断
 * 只需要第一行，所以这里刻意只读开头一段。
 */
export async function readDshSessionHeader(ref: DshSessionLogRef): Promise<DshSessionHeader> {
  let probe: Buffer
  try {
    const handle = await open(ref.path, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_PROBE_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEADER_PROBE_BYTES, 0)
      probe = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return { id: null, cwd: null, createdAt: null, isSeeded: false }
  }
  const text = ref.zstd ? decodeZstdText(probe).text : probe.toString('utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // 探针可能在某个 frame 中间截断，坏行跳过即可（会话头是第一行，通常已经读到）
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (record.type !== 'session') continue
    return {
      id: typeof record.id === 'string' ? record.id : null,
      cwd: typeof record.cwd === 'string' ? record.cwd : null,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : null,
      isSeeded: record.isSeeded === true
    }
  }
  return { id: null, cwd: null, createdAt: null, isSeeded: false }
}

/** 读一个会话日志的全部事件。调用方负责按 `size + mtimeMs` 做缓存，这里不做记忆化。 */
export async function readDshSessionLog(ref: DshSessionLogRef): Promise<DshSessionLogRead> {
  let buffer: Buffer
  try {
    buffer = await readFile(ref.path)
  } catch (error) {
    return {
      events: [],
      bytes: 0,
      frames: 0,
      failedFrames: 0,
      skippedLines: 0,
      partial: true,
      error: (error as Error).message
    }
  }
  if (!ref.zstd) {
    const { events, skipped } = parseEventLines(buffer.toString('utf8'))
    return {
      events,
      bytes: buffer.length,
      frames: 0,
      failedFrames: 0,
      skippedLines: skipped,
      partial: skipped > 0,
      error: null
    }
  }
  const decoded = decodeZstdText(buffer)
  const { events, skipped } = parseEventLines(decoded.text)
  const failedFrames = decoded.failed
  return {
    events,
    bytes: buffer.length,
    frames: decoded.frames,
    failedFrames,
    skippedLines: skipped,
    partial: failedFrames > 0 || decoded.torn || skipped > 0 || decoded.error !== null,
    error: decoded.error
  }
}
