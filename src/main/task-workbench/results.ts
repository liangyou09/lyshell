import { constants, type BigIntStats } from 'fs'
import { lstat, mkdir, open, realpath } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type {
  TaskArtifact, TaskDefinition, TaskResultBundle, TaskSubmission, TaskVerificationCheck
} from '@shared/task-workbench'
import { atomicWriteFile } from '../storage/atomic-json'
import { comparePerformanceInput, performanceFactsMarkdown } from './templates/component-performance'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
const ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const utf8 = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

export class TaskArtifactError extends Error {
  constructor(message: string) { super(message); this.name = 'TaskArtifactError' }
}

function assertId(id: string): void {
  if (!ID.test(id)) throw new TaskArtifactError('成果标识无效。')
}

function pathParts(value: string): string[] {
  if (isAbsolute(value) || value.includes('\0') || value.includes(':')) throw new TaskArtifactError('成果路径越界。')
  const parts = value.split(/[\\/]/)
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) throw new TaskArtifactError('成果路径越界。')
  return parts
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

/** 每一段都拒绝链接，包括 Windows junction；最后再核对实际路径边界。 */
async function existingPath(base: string, relativePath: string): Promise<{ path: string; stat: BigIntStats }> {
  const parts = pathParts(relativePath)
  const root = await realpath(base)
  const rootStat = await lstat(base)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TaskArtifactError('成果根目录不安全。')
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    const entry = await lstat(current, { bigint: true })
    if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())) {
      throw new TaskArtifactError('成果路径包含链接或非目录条目。')
    }
    if (index === parts.length - 1 && !entry.isFile()) throw new TaskArtifactError('成果不是普通文件。')
  }
  const canonical = await realpath(current)
  if (!inside(root, canonical)) throw new TaskArtifactError('成果实际路径越界。')
  return { path: canonical, stat: await lstat(canonical, { bigint: true }) }
}

/** 有界读取同一个文件句柄，前后核对身份与时间，增长也不会导致无界分配。 */
async function stableRead(base: string, relativePath: string): Promise<Buffer> {
  const before = await existingPath(base, relativePath)
  if (before.stat.size > BigInt(MAX_FILE_BYTES)) throw new TaskArtifactError('单个成果超过 5 MiB。')
  const handle = await open(before.path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(before.stat, opened)) throw new TaskArtifactError('成果在打开时发生变化。')
    const bytes = Buffer.alloc(Number(opened.size) + 1)
    let read = 0
    while (read < bytes.length) {
      const chunk = await handle.read(bytes, read, bytes.length - read, read)
      if (!chunk.bytesRead) break
      read += chunk.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const current = await existingPath(base, relativePath)
    if (current.path !== before.path || !sameFile(opened, after) || !sameFile(after, current.stat) ||
      BigInt(read) !== opened.size) throw new TaskArtifactError('成果在读取期间发生变化，请重新采集。')
    return bytes.subarray(0, read)
  } finally { await handle.close() }
}

async function createDirectory(base: string, parts: string[]): Promise<string> {
  await mkdir(base, { recursive: true, mode: 0o700 })
  if ((await lstat(base)).isSymbolicLink()) throw new TaskArtifactError('受管根目录不能是链接。')
  const root = await realpath(base)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new TaskArtifactError('受管目录包含链接或非目录条目。')
    if (!inside(root, await realpath(current))) throw new TaskArtifactError('受管目录越界。')
  }
  return current
}

/** 新版本独占创建；完整写入和同步后，调用方才可以登记清单引用。 */
async function writeManaged(base: string, relativePath: string, bytes: Buffer): Promise<void> {
  if (bytes.length > MAX_FILE_BYTES) throw new TaskArtifactError('单个成果超过 5 MiB。')
  const parts = pathParts(relativePath)
  const filename = parts.pop()!
  const directory = await createDirectory(base, parts)
  const target = join(directory, filename)
  const handle = await open(target, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  const saved = await stableRead(base, relativePath)
  if (!saved.equals(bytes)) throw new TaskArtifactError('成果快照保存后校验失败。')
}

function validJsonNumbers(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(validJsonNumbers)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(validJsonNumbers)
  return false
}

function reportChecks(text: string, submission: TaskSubmission): TaskVerificationCheck[] {
  const lines = text.split(/\r?\n/).map(line => line.trim())
  const association = lines.includes(`Submission: ${submission.id}`) &&
    lines.includes(`Input-SHA256: ${submission.frozenInputHash}`) && lines.includes('Template-Version: 1')
  // 续接共用 Submission 与输入；缺少当前执行标记时不能把上一轮报告重新盖章。
  const requestId = submission.executionRequestId ?? (submission.executionHistory.length === 0 ? submission.requestId : undefined)
  const execution = !!requestId && lines.includes(`Execution-Request: ${requestId}`)
  const sections = [/^#{1,6}\s+(?:事实|Facts)(?:[\s/:：]|$)/im, /^#{1,6}\s+(?:推测|Hypotheses)(?:[\s/:：]|$)/im,
    /^#{1,6}\s+(?:待验证|To verify)(?:[\s/:：]|$)/im].every(pattern => pattern.test(text))
  return [
    { name: 'report-association', passed: association, detail: association ? '报告标识、冻结输入摘要和模板版本匹配。' : '报告缺少或不匹配本次 Submission、Input-SHA256、Template-Version 标记。' },
    { name: 'report-execution', passed: execution, detail: execution ? '报告声明当前执行的请求标记。' : '报告缺少当前 Execution-Request 标记；续接后必须由本次执行重新核对并更新报告。' },
    { name: 'report-sections', passed: sections, detail: sections ? '报告包含事实、推测和待验证三个独立章节。' : '报告需要事实 / Facts、推测 / Hypotheses、待验证 / To verify 三个独立标题。' },
    ...(submission.frozenDefinition.templateId === 'component-performance' ? [{
      name: 'report-source', passed: lines.includes('Evidence-Source: user-provided-results'),
      detail: '分析模式报告必须声明 Evidence-Source: user-provided-results；这不构成本次启动测试的证据。'
    }] : [])
  ]
}

export class TaskWorkbenchResults {
  readonly rootDir: string
  constructor(rootDir: string) { this.rootDir = resolve(rootDir) }

  async freeze(definition: TaskDefinition, submissionId: string): Promise<{ relativePath: string; sha256: string }> {
    assertId(submissionId)
    if (!validJsonNumbers(definition)) throw new TaskArtifactError('冻结输入含有非 JSON 值或非有限数值。')
    const relativePath = `inputs/${submissionId}.json`
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, templateVersion: 1, submissionId, definition }, null, 2) + '\n', 'utf8')
    try { await writeManaged(this.rootDir, relativePath, bytes) } catch (error) {
      // 同一运行身份只允许使用原来的字节；重复冻结不能覆盖已经引用的输入。
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const saved = await stableRead(this.rootDir, relativePath)
      if (!saved.equals(bytes)) throw new TaskArtifactError('同一提交的冻结输入已经存在，不能替换。')
    }
    return { relativePath, sha256: hash(bytes) }
  }

  async verify(submission: TaskSubmission): Promise<TaskResultBundle> {
    assertId(submission.id)
    const id = randomUUID()
    const verifiedAt = Date.now()
    const checks: TaskVerificationCheck[] = []
    const artifacts: TaskArtifact[] = []
    let totalBytes = 0
    let hardFailure = false
    let needsHuman = false
    let businessOutcome: TaskResultBundle['businessOutcome'] = 'not-evaluated'
    const collect = async (name: string, bytes: Buffer, source: TaskArtifact['source'], format: TaskArtifact['format']): Promise<void> => {
      if (totalBytes + bytes.length > MAX_BUNDLE_BYTES) throw new TaskArtifactError('单次成果总量超过 20 MiB。')
      const artifactId = randomUUID()
      const relativePath = `artifacts/${submission.id}/${id}/${artifactId}-${name}`
      await writeManaged(this.rootDir, relativePath, bytes)
      totalBytes += bytes.length
      artifacts.push({
        artifactId, submissionId: submission.id, name, relativePath, format, bytes: bytes.length,
        sha256: hash(bytes), collectedAt: verifiedAt, frozenInputHash: submission.frozenInputHash,
        templateVersion: 1, source,
        ...(submission.nativeExecutionRef ? { nativeExecutionRef: structuredClone(submission.nativeExecutionRef) } : {})
      })
    }
    let frozenValid = false
    try {
      if (submission.frozenInputRef !== `inputs/${submission.id}.json` || !HASH.test(submission.frozenInputHash)) {
        throw new TaskArtifactError('冻结输入引用或摘要无效。')
      }
      const bytes = await stableRead(this.rootDir, submission.frozenInputRef)
      if (hash(bytes) !== submission.frozenInputHash) throw new TaskArtifactError('冻结输入的实际字节摘要不匹配。')
      const frozen = JSON.parse(utf8(bytes)) as Record<string, unknown>
      if (frozen.schemaVersion !== 1 || frozen.templateVersion !== submission.templateVersion || frozen.submissionId !== submission.id ||
        JSON.stringify(frozen.definition) !== JSON.stringify(submission.frozenDefinition)) throw new TaskArtifactError('冻结输入与本次提交或模板版本不匹配。')
      await collect('input.json', bytes, 'user-input', 'json')
      checks.push({ name: 'frozen-input', passed: true, detail: '读取同一冻结输入字节，摘要、业务定义和模板版本匹配。' })
      frozenValid = true
    } catch (error) {
      checks.push({ name: 'frozen-input', passed: false, detail: describe(error) })
      hardFailure = true
    }

    const ref = submission.nativeExecutionRef
    const observation = submission.observation
    const observedExecution = observation?.executionIdentity ?? observation?.identity
    const nativeComplete = submission.handoffState === 'bound' && !submission.resumeIntent && ref && ID.test(ref.sessionId) &&
      ID.test(ref.taskId) && ref.attemptId && ID.test(ref.attemptId) && observation?.state === 'completed' && !observation.stale &&
      observedExecution?.instanceId === ref.executionIdentity.instanceId && observedExecution?.instanceEpoch === ref.executionIdentity.instanceEpoch &&
      (observation.attemptId === undefined || observation.attemptId === ref.attemptId) &&
      observation.observedAt >= verifiedAt - 60000 && observation.observedAt <= verifiedAt + 5000
    checks.push({ name: 'native-completion', passed: !!nativeComplete, detail: nativeComplete
      ? '当前原生执行引用与新鲜完成观察相符；这只证明回合已结束。'
      : '尚无同一任务、attempt 和执行身份的新鲜完成证据，不能自动通过验收。' })
    if (!nativeComplete) needsHuman = true

    if (frozenValid && submission.frozenDefinition.templateId === 'component-performance') {
      const performance = submission.frozenDefinition.performance
      const comparison = comparePerformanceInput(performance)
      checks.push(...comparison.checks)
      businessOutcome = comparison.businessOutcome
      if (!comparison.valid) hardFailure = true
      else {
        if (!comparison.comparable) needsHuman = true
        await collect('performance-facts.json', Buffer.from(JSON.stringify({
          schemaVersion: 1, submissionId: submission.id, frozenInputHash: submission.frozenInputHash,
          templateVersion: 1, evidenceSource: 'user-provided-results', input: performance, comparison
        }, null, 2) + '\n'), 'host-check', 'json')
        await collect('performance-facts.md', Buffer.from(performanceFactsMarkdown(performance!, comparison)), 'host-check', 'markdown')
      }
    }

    if (frozenValid) try {
      const bytes = await stableRead(submission.frozenDefinition.workspace, `.lyshell-task-results/${submission.id}/report.md`)
      const text = utf8(bytes)
      if (!text.trim()) throw new TaskArtifactError('报告为空。')
      await collect('report.md', bytes, 'agent-file', 'markdown')
      checks.push({ name: 'report-file', passed: true, detail: '已采集稳定、有界的报告字节并保存不可替换的新快照。' })
      const report = reportChecks(text, submission)
      checks.push(...report)
      if (report.some(check => !check.passed)) hardFailure = true
    } catch (error) {
      checks.push({ name: 'report-file', passed: false, detail: describe(error) })
      hardFailure = true
    }

    if (submission.frozenDefinition.templateId === 'general' || submission.frozenDefinition.acceptanceCriteria.trim()) {
      needsHuman = true
      checks.push({ name: 'human-criteria', passed: false, detail: '自定义目标或完成条件需要用户依据已保存成果确认；结构检查不能证明任务目标达成。' })
    }
    return {
      id, submissionId: submission.id, artifacts, decision: hardFailure ? 'failed' : needsHuman ? 'needs-human' : 'passed',
      checks, businessOutcome, frozenInputHash: submission.frozenInputHash,
      ...(ref ? { nativeExecutionRef: structuredClone(ref) } : {}), verifierVersion: 1, verifiedAt
    }
  }

  private async artifactBytes(artifact: TaskArtifact): Promise<Buffer> {
    assertId(artifact.artifactId)
    assertId(artifact.submissionId)
    if (!HASH.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_FILE_BYTES ||
      !artifact.relativePath.startsWith(`artifacts/${artifact.submissionId}/`)) throw new TaskArtifactError('成果索引无效。')
    const bytes = await stableRead(this.rootDir, artifact.relativePath)
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new TaskArtifactError('成果字节数或摘要与验收快照不匹配。')
    return bytes
  }

  async readArtifact(artifact: TaskArtifact): Promise<string> {
    return utf8(await this.artifactBytes(artifact))
  }

  /** target 只能来自主进程保存对话框，公开 renderer 请求不接受目标路径。 */
  async exportArtifact(artifact: TaskArtifact, target: string): Promise<void> {
    if (!isAbsolute(target) || target.includes('\0')) throw new TaskArtifactError('导出目标必须为绝对文件路径。')
    try {
      const entry = await lstat(target)
      if (!entry.isFile() || entry.isSymbolicLink()) throw new TaskArtifactError('不能导出到链接或非普通文件。')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const bytes = await this.artifactBytes(artifact)
    // 所有成果都是经 UTF-8 验证的文本；原子替换也保留原有目标，直到完整写入成功。
    await atomicWriteFile(target, utf8(bytes))
  }
}

function describe(error: unknown): string {
  if (error instanceof TaskArtifactError) return error.message
  if (error instanceof SyntaxError || error instanceof TypeError) return '成果内容不是有效的 UTF-8 / JSON。'
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return '缺少输入或必需报告文件。'
  if (code === 'EACCES' || code === 'EPERM') return '没有读取或保存成果的权限。'
  return '成果读取或保存失败，未获得完整验收证据。'
}
