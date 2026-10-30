#!/usr/bin/env node
/**
 * OPT-14 合成混合负载基线：32 缓冲 + 4 GUI 消费者 + 临时目录流式拷贝 + 原子 JSON。
 * 直接使用 OutputBuffer / OutputHistoryBudget / TerminalOutputDispatcher / atomic-json。
 * 只测单进程合成输出与本地 IO，不含 xterm/PTY/SSH/网络/插件；不能当作生产 SLO。
 */
import { execFileSync } from 'child_process'
import { randomFillSync } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { cpus, tmpdir, totalmem } from 'os'
import { basename, dirname, join } from 'path'
import { monitorEventLoopDelay, performance } from 'perf_hooks'
import { pipeline } from 'stream/promises'
import { atomicWriteFile, atomicWriteFileSync, readJsonFileSync } from '../src/main/storage/atomic-json'
import { OutputBuffer } from '../src/main/terminal/output-buffer'
import { OutputHistoryBudget, type OutputHistoryLease } from '../src/main/terminal/output-budget'
import { TerminalOutputDispatcher } from '../src/main/terminal/output-dispatcher'
import type { TerminalOutputReceipt } from '../src/shared/terminal-output'

const MIB = 1_024 * 1_024
const C = {
  rounds: 5, roundMs: 3_000, settleMs: 300, sessions: 32, perWindow: 8, appendMs: 25, chunkChars: 8_192,
  historyTotal: 8 * MIB, historyPerBuffer: 1 * MIB, queueBudget: 8 * MIB, maxConsumers: 256,
  ackTimeoutMs: 250, ackDelays: { attentive: 1, delayed: 30, slow: 150 }, watchdogMs: 200,
  sampleMs: 50, jsonMs: 1_000,
  copyBytes: 4 * MIB, copyWorkers: 2, copyHwm: 256 * 1_024, copyIdleMs: 10, prefix: 'lyshell-opt14-benchmark-'
} as const
const ROOT = process.cwd(); const OUT = join(ROOT, 'tmp', 'architecture')
const JSON_PATH = join(OUT, 'benchmark-results.json'); const MD_PATH = join(OUT, 'benchmark-report.md')
const GROUPS = [
  { windowId: 101, behavior: 'attentive', start: 0 }, { windowId: 102, behavior: 'delayed', start: 8 },
  { windowId: 103, behavior: 'slow', start: 16 }, { windowId: 104, behavior: 'lost', start: 24 }
] as const
type Behavior = (typeof GROUPS)[number]['behavior']
type Nums = Record<string, number>
const CHUNKS = Array.from({ length: 96 }, (_, i) => (`\x1b[32m[chunk ${i}]\x1b[0m 会话输出样例 ${i} ` + 'x'.repeat(C.chunkChars)).slice(0, C.chunkChars))
const blank = (): Nums => ({ producedChars: 0, dispatchedChars: 0, dispatchedFrames: 0, ackedChars: 0, ackedFrames: 0, resubscribes: 0, histMax: 0, guiMax: 0, windowsMax: 0, checks: 0, samples: 0, histViolations: 0, guiViolations: 0, rssMax: 0, heapMax: 0, copyBytes: 0, syncCommits: 0, syncFailures: 0, syncMaxMs: 0, asyncCommits: 0, asyncFailures: 0, asyncMaxMs: 0 })
type Sub = { windowId: number; sessionId: string; behavior: Behavior; subscriptionId: string; active: boolean }
type Session = { id: string; buffer: OutputBuffer; lease: OutputHistoryLease; tick: number }
type Writer = { timer: NodeJS.Timeout; statePath: string; auditPath: string; seq: () => number; pending: () => Promise<void> }
type Check = { id: string; ok: boolean; detail: string }
type Clean = Record<string, any>

const timers = new Set<NodeJS.Timeout>(); const acks = new Set<NodeJS.Timeout>(); const subs = new Map<string, Sub>()
let budget: OutputHistoryBudget | null = null; let dispatcher: TerminalOutputDispatcher | null = null
let sessions: Session[] = []; let m = blank(); let tempDir = ''; let copySource = ''; let copySize = 0
let workers: AbortController[] = []; let workerRuns: Promise<void>[] = []; let writer: Writer | null = null

const track = (t: NodeJS.Timeout): NodeJS.Timeout => (timers.add(t), t); const stop = (t: NodeJS.Timeout): void => { clearInterval(t); timers.delete(t) }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)); const mib = (n: number): string => (n / MIB).toFixed(2)

function checkBudgets(): void {
  m.checks += 1
  const history = budget!.snapshot()
  m.histMax = Math.max(m.histMax, history.usedChars)
  if (history.usedChars > history.totalLimit || history.overBudget) m.histViolations += 1
  const gui = dispatcher!.getSnapshot()
  m.guiMax = Math.max(m.guiMax, gui.totalPending)
  if (gui.totalPending > gui.globalQueueBudget) m.guiViolations += 1
  const windows = new Set<number>(); for (const sub of subs.values()) if (sub.active) windows.add(sub.windowId)
  m.windowsMax = Math.max(m.windowsMax, windows.size)
}

function subscribe(windowId: number, sessionId: string, behavior: Behavior): void {
  const key = `${windowId}:${sessionId}`
  const subscriptionId = dispatcher!.subscribe(windowId, sessionId, (data: string, receipt: TerminalOutputReceipt) => {
    if (receipt.error) {
      const record = subs.get(key); if (record) record.active = false
      return
    }
    m.dispatchedChars += data.length; m.dispatchedFrames += 1
    if (behavior === 'lost') return
    const timer = setTimeout(() => {
      acks.delete(timer)
      const record = subs.get(key)
      if (!record || !record.active || record.subscriptionId !== receipt.subscriptionId) return
      dispatcher!.acknowledge(windowId, sessionId, receipt.subscriptionId, receipt.sequence)
      m.ackedChars += data.length; m.ackedFrames += 1
    }, C.ackDelays[behavior])
    acks.add(timer)
  })
  subs.set(key, { windowId, sessionId, behavior, subscriptionId, active: true })
}

function resubscribeAll(): void {
  for (const record of [...subs.values()]) if (!record.active) subscribe(record.windowId, record.sessionId, record.behavior)
}

function startAppend(): NodeJS.Timeout {
  return track(setInterval(() => {
    sessions.forEach((session, index) => {
      const chunk = CHUNKS[(session.tick + index * 7) % CHUNKS.length]
      session.tick += 1
      session.buffer.append(chunk)
      m.producedChars += chunk.length
      dispatcher!.append(session.id, chunk)
    })
    checkBudgets()
  }, C.appendMs))
}

function startSample(): NodeJS.Timeout {
  return track(setInterval(() => {
    m.samples += 1
    checkBudgets()
    const memory = process.memoryUsage()
    m.rssMax = Math.max(m.rssMax, memory.rss); m.heapMax = Math.max(m.heapMax, memory.heapUsed)
  }, C.sampleMs))
}

function startWriter(): Writer {
  const statePath = join(tempDir, 'atomic-state.json'); const auditPath = join(tempDir, 'atomic-audit.json')
  let seq = 0; let pending = Promise.resolve()
  const timer = track(setInterval(() => {
    seq += 1
    const payload = JSON.stringify({ schema: 1, seq, at: Date.now(), buffers: sessions.map((s) => ({ id: s.id, cursor: s.buffer.getWriteCursor(), retained: s.buffer.size() })) })
    const syncStart = performance.now()
    try { atomicWriteFileSync(statePath, payload); m.syncCommits += 1; m.syncMaxMs = Math.max(m.syncMaxMs, performance.now() - syncStart) } catch { m.syncFailures += 1 }
    pending = pending.then(async () => {
      const asyncStart = performance.now()
      try { await atomicWriteFile(auditPath, payload); m.asyncCommits += 1; m.asyncMaxMs = Math.max(m.asyncMaxMs, performance.now() - asyncStart) } catch { m.asyncFailures += 1 }
    })
  }, C.jsonMs))
  return { timer, statePath, auditPath, seq: () => seq, pending: () => pending }
}

function startCopies(round: number): void {
  workers = []
  workerRuns = []
  for (let worker = 0; worker < C.copyWorkers; worker += 1) {
    const controller = new AbortController(); workers.push(controller)
    const destination = join(tempDir, `copy-r${round}-w${worker}.bin`)
    workerRuns.push((async () => {
      while (!controller.signal.aborted) {
        try {
          await pipeline(createReadStream(copySource, { highWaterMark: C.copyHwm }), createWriteStream(destination, { highWaterMark: C.copyHwm }), { signal: controller.signal })
          m.copyBytes += copySize
        } catch { if (controller.signal.aborted) break; await sleep(50); continue }
        await sleep(C.copyIdleMs)
      }
    })())
  }
}

async function runRound(round: number): Promise<Nums> {
  m = blank()
  const historyStart = budget!.snapshot()
  const dispatcherStart = dispatcher!.getSnapshot()
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const cpuStart = process.cpuUsage()
  const startedAt = performance.now()
  const appendTimer = startAppend()
  const sampleTimer = startSample()
  const current = startWriter()
  writer = current
  const watchdog = track(setInterval(resubscribeAll, C.watchdogMs))
  startCopies(round)
  await new Promise<void>((resolve) => { const t = setTimeout(() => { timers.delete(t); resolve() }, C.roundMs); timers.add(t) })
  const activeMs = performance.now() - startedAt
  const cpu = process.cpuUsage(cpuStart)
  histogram.disable()
  ;[appendTimer, sampleTimer, current.timer, watchdog].forEach(stop)
  workers.forEach((controller) => controller.abort())
  await Promise.allSettled(workerRuns)
  await current.pending()
  await sleep(C.settleMs)
  acks.forEach(clearTimeout)
  acks.clear()
  const historyEnd = budget!.snapshot()
  const dispatcherEnd = dispatcher!.getSnapshot()
  const seconds = activeMs / 1_000
  return {
    round, activeMs, producedCps: m.producedChars / seconds, ackedCps: m.ackedChars / seconds, rssMax: m.rssMax, heapMax: m.heapMax,
    cpuPct: ((cpu.user + cpu.system) / 1_000 / activeMs) * 100, p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6,
    p99: histogram.percentile(99) / 1e6, elMax: histogram.max / 1e6, histMax: m.histMax, histLimit: historyEnd.totalLimit, guiMax: m.guiMax,
    guiLimit: dispatcherEnd.globalQueueBudget, evictions: historyEnd.evictions - historyStart.evictions,
    droppedChars: historyEnd.totalDroppedChars - historyStart.totalDroppedChars,
    ackTimeouts: dispatcherEnd.diagnostics.ackTimeouts - dispatcherStart.diagnostics.ackTimeouts,
    copyBytes: m.copyBytes, copyMibps: m.copyBytes / MIB / seconds, jsonSync: m.syncCommits, jsonAsync: m.asyncCommits,
    syncMaxMs: m.syncMaxMs, checks: m.checks, samples: m.samples, histViolations: m.histViolations, guiViolations: m.guiViolations,
    buffers: historyEnd.bufferCount, windows: m.windowsMax, producedChars: m.producedChars, ackedChars: m.ackedChars,
    ackedFrames: m.ackedFrames, dispatchedChars: m.dispatchedChars, dispatchFrames: m.dispatchedFrames
  }
}

function verifyJson(path: string, expected: number): { ok: boolean; status: string; seq: number | null } {
  const result = readJsonFileSync<{ seq: number }>(path)
  return result.status === 'ok' && result.value ? { ok: result.value.seq === expected, status: result.status, seq: result.value.seq } : { ok: false, status: result.status, seq: null }
}

function removeTempDir(): { path: string | null; removed: boolean; guard: string } {
  if (!tempDir) return { path: null, removed: true, guard: 'no temp directory' }
  try {
    const resolved = realpathSync(tempDir); const base = realpathSync(tmpdir())
    if (resolved !== tempDir || dirname(resolved) !== base || !basename(resolved).startsWith(C.prefix)) {
      return { path: resolved, removed: false, guard: 'refused: not the owned mkdtemp directory under os.tmpdir()' }
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 3 })
    return { path: resolved, removed: !existsSync(resolved), guard: 'owned mkdtemp directory under os.tmpdir()' }
  } catch (error) {
    return { path: tempDir, removed: false, guard: `delete failed: ${String(error)}` }
  }
}

async function cleanup(): Promise<Clean> {
  const timersCleared = timers.size; timers.forEach(clearInterval); timers.clear(); const ackTimersCleared = acks.size; acks.forEach(clearTimeout); acks.clear()
  workers.forEach((controller) => controller.abort()); await Promise.allSettled(workerRuns)
  if (writer) await writer.pending().catch(() => undefined)
  const expected = writer?.seq() ?? 0
  const state = writer ? verifyJson(writer.statePath, expected) : null
  const audit = writer ? verifyJson(writer.auditPath, expected) : null
  dispatcher?.dispose(); const afterDispatcher = dispatcher?.getSnapshot()
  for (const session of sessions) session.lease.dispose()
  budget?.dispose(); const afterBudget = budget?.snapshot()
  return {
    timersCleared, ackTimersCleared, timersRemaining: timers.size + acks.size, dispatcherDisposed: afterDispatcher?.disposed === true,
    consumersAfterDispose: afterDispatcher?.consumerCount ?? null, budgetDisposed: afterBudget?.disposed === true,
    buffersAfterDispose: afterBudget?.bufferCount ?? null, json: { expected, state, audit }, tempDir: removeTempDir()
  }
}
function environment(): Record<string, any> {
  let commit: string | null = null
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* 非 git 工作区 */ }
  return { node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryMiB: Math.round(totalmem() / MIB), commit, cwd: ROOT }
}

const aggregate = (values: number[]): { mean: number; min: number; max: number } | null => values.length === 0 ? null : { mean: values.reduce((sum, value) => sum + value, 0) / values.length, min: Math.min(...values), max: Math.max(...values) }

function summarize(rounds: Nums[]): Record<string, { mean: number; min: number; max: number } | null> {
  const pick = (key: string) => aggregate(rounds.map((round) => round[key]).filter((value) => Number.isFinite(value)))
  return Object.fromEntries(['producedCps', 'ackedCps', 'rssMax', 'heapMax', 'cpuPct', 'p50', 'p95', 'p99', 'elMax', 'histMax', 'guiMax', 'evictions', 'ackTimeouts', 'copyMibps', 'syncMaxMs'].map((key) => [key, pick(key)]))
}

function report(rounds: Nums[], totals: ReturnType<typeof summarize>, checks: Check[], clean: Clean, fatal: string | null, env: Record<string, any>): string {
  const avg = (key: string, div = 1): string => {
    const value = totals[key]
    return value ? `${(value.mean / div).toFixed(2)}（${(value.min / div).toFixed(2)}–${(value.max / div).toFixed(2)}）` : '未测'
  }
  const table = rounds.map((r) => `| ${r.round} | ${(r.producedCps / MIB).toFixed(2)} | ${(r.ackedCps / MIB).toFixed(2)} | ${mib(r.rssMax)} | ${mib(r.heapMax)} | ${r.cpuPct.toFixed(1)} | ${r.p50.toFixed(1)}/${r.p95.toFixed(1)}/${r.p99.toFixed(1)}/${r.elMax.toFixed(1)} | ${r.histMax}/${r.histLimit} | ${r.guiMax}/${r.guiLimit} | ${r.evictions} | ${r.ackTimeouts} | ${r.copyMibps.toFixed(0)} | ${r.jsonSync}+${r.jsonAsync} |`).join('\n')
  const failed = checks.filter((c) => !c.ok)
  return `# OPT-14 合成混合负载基线报告

- 生成时间：${new Date().toISOString()}
- 代码版本：${String(env.commit ?? '未知')}
- 断言：${checks.filter((c) => c.ok).length}/${checks.length} 通过${failed.length ? `；失败：${failed.map((c) => c.id).join(', ')}` : ''}；运行错误：${fatal ?? '无'}
- 断言项：${checks.map((c) => c.id).join(', ')}

> 仅测量单个 Node 主进程内的合成输出与本地 IO 竞争；不含真实 xterm/PTY/SSH/网络/插件。
> 不能当作生产 SLO 或跨平台基线。输出/历史单位是 UTF-16 码元（chars），磁盘拷贝才是字节。

环境：Node ${String(env.node)} / ${String(env.platform)} / ${String(env.cpu)} × ${String(env.cores)} / ${String(env.memoryMiB)} MiB

## 轮次
| 轮 | 产出 Mi chars/s | ACK Mi chars/s | RSS MiB | heap MiB | CPU % | EL p50/p95/p99/max ms | 历史 chars | GUI chars | 回收 | 超时 | 拷贝 MiB/s | JSON 同步+异步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${table}

## 汇总（均值与范围）
产出 ${avg('producedCps', MIB)} Mi chars/s；ACK ${avg('ackedCps', MIB)} Mi chars/s；RSS ${avg('rssMax', MIB)} MiB；heap ${avg('heapMax', MIB)} MiB；CPU ${avg('cpuPct')}%（单核）。
EL p50/p95/p99/max：${avg('p50')} / ${avg('p95')} / ${avg('p99')} / ${avg('elMax')} ms；历史 ${avg('histMax')} chars；GUI ${avg('guiMax')} chars；每轮回收 ${avg('evictions')}、超时 ${avg('ackTimeouts')}；拷贝 ${avg('copyMibps')} MiB/s；同步原子写 max ${avg('syncMaxMs')} ms。

## 清理
- 定时器剩余 ${String(clean.timersRemaining)}；dispatcher 已销毁 ${String(clean.dispatcherDisposed)}；budget 已销毁 ${String(clean.budgetDisposed)}；缓冲剩余 ${String(clean.buffersAfterDispose)}
- 原子 JSON 回读：state=${clean.json?.state?.ok ? '一致' : '不一致'}，audit=${clean.json?.audit?.ok ? '一致' : '不一致'}；临时目录：${clean.tempDir?.removed ? '已删除' : '未删除'}（${clean.tempDir?.guard}）

## 限制
- 单进程合成负载，不含 xterm 渲染、PTY/SSH/网络、插件宿主或渲染进程；历史总预算压到 8 Mi chars、ACK 超时压到 250 ms，便于 3 秒内触发回收与超时。
- 未强制 GC；RSS/heap 是 50 ms 采样值，CPU 跨轮波动大，只作量级参考；文件 IO 在本地临时目录，可能命中页缓存，且只在一台机器上运行。
- CPU 是进程级 user+system 时间占比，文件 IO 线程池可使其超过单核 100%。
- 未测 GUI 渲染帧率、ACK 端到端延迟、PTY/SSH 背压与跨平台差异。
`
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'package.json')) || !existsSync(join(ROOT, 'src', 'main', 'terminal', 'output-buffer.ts'))) throw new Error(`请从 LyShell 仓库根运行；当前目录：${ROOT}`)
  const env = environment()
  const rounds: Nums[] = []
  let fatal: string | null = null
  let clean: Clean = {}
  const startedAt = Date.now()
  mkdirSync(OUT, { recursive: true })
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), C.prefix)))
  copySource = join(tempDir, 'copy-source.bin')
  const payload = Buffer.allocUnsafe(C.copyBytes); randomFillSync(payload); writeFileSync(copySource, payload); copySize = statSync(copySource).size
  try {
    budget = new OutputHistoryBudget({ totalLimit: C.historyTotal, perBufferLimit: C.historyPerBuffer })
    sessions = Array.from({ length: C.sessions }, (_, index) => {
      const buffer = new OutputBuffer(C.historyPerBuffer)
      return { id: `s${index}`, buffer, lease: budget!.attach(buffer), tick: 0 }
    })
    dispatcher = new TerminalOutputDispatcher(() => undefined, { globalQueueBudget: C.queueBudget, maxConsumers: C.maxConsumers, ackTimeoutMs: C.ackTimeoutMs })
    for (const group of GROUPS) for (let offset = 0; offset < C.perWindow; offset += 1) subscribe(group.windowId, `s${group.start + offset}`, group.behavior)
    console.log('=== OPT-14 合成混合负载基线 ===')
    console.log(`node ${String(env.node)} / ${String(env.platform)} / ${String(env.cores)} cores / commit ${String(env.commit ?? '未知')}`)
    for (let round = 1; round <= C.rounds; round += 1) {
      const r = await runRound(round)
      rounds.push(r)
      console.log(`[${round}/${C.rounds}] ${(r.activeMs / 1000).toFixed(2)}s | 产出 ${(r.producedCps / MIB).toFixed(2)} Mi chars/s | ACK ${(r.ackedCps / MIB).toFixed(2)} Mi chars/s | RSS ${mib(r.rssMax)} MiB | heap ${mib(r.heapMax)} MiB | CPU ${r.cpuPct.toFixed(1)}% | EL ${r.p50.toFixed(1)}/${r.p95.toFixed(1)}/${r.p99.toFixed(1)}/${r.elMax.toFixed(1)} ms | 历史 ${r.histMax}/${r.histLimit} chars (回收 ${r.evictions}) | GUI ${r.guiMax} chars | 超时 ${r.ackTimeouts} | 拷贝 ${r.copyMibps.toFixed(0)} MiB/s | JSON ${r.jsonSync}+${r.jsonAsync}`)
    }
  } catch (error) {
    fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    try { clean = await cleanup() } catch (error) { fatal = fatal ?? `cleanup failed: ${String(error)}` }
  }
  const total = (key: string): number => rounds.reduce((sum, r) => sum + r[key], 0)
  const last = rounds.at(-1)
  const checks: Check[] = [
    { id: 'rounds-completed', ok: rounds.length === C.rounds && rounds.every((r) => r.activeMs >= 2_500 && r.activeMs <= 5_000), detail: `${rounds.length} 轮：${rounds.map((r) => `${r.activeMs.toFixed(0)}ms`).join(' / ')}` },
    { id: 'no-fatal-error', ok: fatal === null, detail: fatal ?? '无' },
    { id: 'buffers-managed', ok: last?.buffers === C.sessions, detail: `末轮 buffers=${String(last?.buffers)}` },
    { id: 'history-evictions', ok: total('evictions') > 0 && total('droppedChars') > 0, detail: `evictions=${total('evictions')}，droppedChars=${total('droppedChars')}` },
    { id: 'budget-checks', ok: total('checks') > 0, detail: `checks=${total('checks')}，samples=${total('samples')}` },
    { id: 'history-budget-respected', ok: total('histViolations') === 0, detail: `违规=${total('histViolations')}` },
    { id: 'gui-budget-respected', ok: total('guiViolations') === 0, detail: `违规=${total('guiViolations')}` },
    { id: 'gui-consumers', ok: rounds.length === C.rounds && rounds.every((r) => r.windows >= 4), detail: rounds.map((r) => `${r.windows} 窗口`).join(' / ') },
    { id: 'gui-ack-timeouts', ok: total('ackTimeouts') > 0, detail: `ackTimeouts=${total('ackTimeouts')}` },
    { id: 'gui-acked', ok: total('ackedChars') > 0 && total('ackedFrames') > 0, detail: `frames=${total('ackedFrames')}，chars=${total('ackedChars')}` },
    { id: 'output-produced', ok: total('producedChars') > 0 && total('dispatchFrames') > 0, detail: `produced=${total('producedChars')} chars，frames=${total('dispatchFrames')}` },
    { id: 'file-copy-ran', ok: total('copyBytes') > 0, detail: `bytes=${total('copyBytes')}` },
    { id: 'atomic-json', ok: rounds.every((r) => r.jsonSync > 0 && r.jsonAsync > 0) && Boolean(clean.json?.state?.ok && clean.json?.audit?.ok), detail: `sync=${total('jsonSync')}，async=${total('jsonAsync')}，回读 state=${String(clean.json?.state?.ok)}/audit=${String(clean.json?.audit?.ok)}` },
    { id: 'cleanup-modules', ok: clean.dispatcherDisposed === true && clean.consumersAfterDispose === 0 && clean.budgetDisposed === true && clean.buffersAfterDispose === 0, detail: `dispatcher=${String(clean.dispatcherDisposed)}/consumers=${String(clean.consumersAfterDispose)}，budget=${String(clean.budgetDisposed)}/buffers=${String(clean.buffersAfterDispose)}` },
    { id: 'cleanup-timers', ok: clean.timersRemaining === 0, detail: `remaining=${String(clean.timersRemaining)}` },
    { id: 'cleanup-temp-dir', ok: clean.tempDir?.removed === true && String(clean.tempDir?.guard).startsWith('owned mkdtemp'), detail: String(clean.tempDir?.guard) }
  ]
  const totals = summarize(rounds)
  const passed = checks.every((check) => check.ok)
  const result = {
    schemaVersion: 1, kind: 'opt14-synthetic-mixed-load-baseline', generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt, environment: env, config: C, rounds, summary: totals, assertions: checks, cleanup: clean,
    limitations: [
      '单进程合成负载，不含真实 xterm/PTY/SSH/网络/插件；不能作为生产 SLO 或跨平台基线。',
      '输出/历史单位是 UTF-16 码元（chars），只有文件拷贝使用字节。',
      'CPU 是进程级 user+system 时间占比，文件 IO 线程池可使其超过单核 100%。'
    ],
    notMeasured: ['xterm 渲染帧率与绘制耗时', 'PTY/SSH 真实吞吐与背压', '渲染进程/插件宿主/MCP 子进程开销', 'ACK 端到端延迟', '其他平台与机型'],
    error: fatal
  }
  atomicWriteFileSync(JSON_PATH, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(MD_PATH, report(rounds, totals, checks, clean, fatal, env), 'utf8')
  console.log(`断言: ${checks.filter((check) => check.ok).length}/${checks.length} 通过`)
  for (const check of checks.filter((item) => !item.ok)) console.log(`  [失败] ${check.id}：${check.detail}`)
  console.log(`清理: 定时器 ${String(clean.timersRemaining)} 剩余，dispatcher=${String(clean.dispatcherDisposed)}，缓冲=${String(clean.buffersAfterDispose)}，临时目录=${clean.tempDir?.removed ? '已删除' : '未删除'}`)
  console.log(`结果: ${JSON_PATH.replace(/\\/g, '/')}\n报告: ${MD_PATH.replace(/\\/g, '/')}`)
  process.exitCode = passed && fatal === null ? 0 : 1
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
