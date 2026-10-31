/**
 * 任务工作台业务仓储（W02）。
 *
 * 约定：
 * - 清单固定在 `rootDir/manifest.json`，是业务条目、提交关联与操作回执的同一原子快照。
 * - 单写者：load/read/transact 全部排在同一条 Promise 队列上串行执行，事务内不做并发分支。
 * - 读取路径绝不写盘：清单缺失时只使用默认清单，不在 load/read 期间创建目录或文件。
 * - 事务先改内存草稿，校验通过且原子落盘成功之后才发布新的内存快照。
 * - 损坏或写入结果不确定时锁定存储并明确抛错，绝不退回空清单，也不自动备份恢复。
 */
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import type { TaskHandoffState, TaskWorkbenchManifest } from '@shared/task-workbench'
import type { WorkbenchTaskState } from '@shared/workbench-activity'
import { parseTaskDefinition } from '@shared/task-workbench-validation'
import { atomicWriteFile, cloneJsonValue, isErrno } from '../storage/atomic-json'

/** 清单序列化后的字节上限（W02/6.6）。超限明确拒绝，不淘汰任何去重记录。 */
export const TASK_WORKBENCH_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
/** 等待队列上限：只有挂起或等待续跑的工作才算等待项。 */
export const TASK_WORKBENCH_PENDING_LIMIT = 100
/** 操作回执（去重记录）上限。 */
export const TASK_WORKBENCH_OPERATION_LIMIT = 10_000
/** 单个产物的字节上限。 */
export const TASK_WORKBENCH_ARTIFACT_BYTES_LIMIT = 5 * 1024 * 1024
/** 单次成果全部产物的字节上限。 */
export const TASK_WORKBENCH_RESULT_BYTES_LIMIT = 20 * 1024 * 1024

/** 任一类记录条数上限，防止单个清单被无限记录撑大。 */
const RECORD_LIMIT = 10_000
/** 活动槽位配置上限，仅约束配置本身；不要求现有占用数不超过它。 */
const ACTIVE_LIMIT = 8

const ID_MAX = 128
const TITLE_MAX = 500
const TEXT_MAX = 20_000
const PATH_MAX = 4_096
const ERROR_MAX = 2_000
const NAME_MAX = 500
const FINGERPRINT_MAX = 4_096
const CHECK_DETAIL_MAX = 2_000
const NOTE_LIMIT = 1_000
const ATTEMPT_LIMIT = 1_000
const METRIC_LIMIT = 100
const RESOURCE_LIMIT = 100
const CHECK_LIMIT = 500
const ARTIFACT_LIMIT = 100

const HANDOFF_STATES: readonly TaskHandoffState[] = ['waiting', 'sending', 'bound', 'unknown', 'rejected', 'withdrawn']
const TASK_STATES: readonly WorkbenchTaskState[] = ['accepted', 'running', 'completed', 'failed', 'cancelled', 'unconfirmed', 'unknown']
const QUEUE_MODES = ['host'] as const
const TEMPLATE_IDS = ['general', 'component-performance'] as const
const APPROVAL_POLICIES = ['auto-allow', 'manual'] as const
const DIRECTIONS = ['higher', 'lower'] as const
const ARTIFACT_FORMATS = ['markdown', 'json', 'text'] as const
const ARTIFACT_SOURCES = ['host-check', 'agent-file', 'user-input'] as const
const DECISIONS = ['pending', 'passed', 'failed', 'needs-human'] as const
const OUTCOMES = ['normal', 'regression', 'not-comparable', 'not-evaluated'] as const
const NOTE_KINDS = ['note', 'resource-release', 'approval'] as const
const RESUME_STATES = ['waiting', 'sending', 'unknown'] as const
const SESSION_CREATE_STATES = ['sending', 'bound', 'unknown'] as const

const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/

export type TaskWorkbenchStorageErrorCode =
  | 'TASK_WORKBENCH_CORRUPT'
  | 'TASK_WORKBENCH_UNREADABLE'
  | 'TASK_WORKBENCH_WRITE_FAILED'
  | 'TASK_WORKBENCH_WRITE_UNCERTAIN'
  | 'TASK_WORKBENCH_INVALID'
  | 'TASK_WORKBENCH_LIMIT'

/** 仓储错误：service 依赖 code 区分不存在/损坏/不可读/暂时写失败/结果不确定。 */
export class TaskWorkbenchStorageError extends Error {
  readonly code: TaskWorkbenchStorageErrorCode
  readonly path: string
  readonly cause?: unknown

  constructor(code: TaskWorkbenchStorageErrorCode, path: string, message: string, cause?: unknown) {
    super(message)
    this.name = 'TaskWorkbenchStorageError'
    this.code = code
    this.path = path
    this.cause = cause
  }
}

export interface TaskWorkbenchRepositoryOptions {
  /** 写入实现注入点（测试用它模拟写前失败、回执丢失与外部改写）。 */
  writeFile?: (path: string, data: string) => Promise<void>
}

/** 校验失败。kind='limit' 表示超出上限而不是结构损坏。 */
class ManifestValidationError extends Error {
  readonly kind: 'invalid' | 'limit'

  constructor(kind: 'invalid' | 'limit', message: string) {
    super(message)
    this.name = 'ManifestValidationError'
    this.kind = kind
  }
}

type JsonRecord = Record<string, unknown>

type DiskReadState =
  | { status: 'missing' }
  | { status: 'ok'; raw: string; manifest: TaskWorkbenchManifest }
  | { status: 'corrupt'; message: string }
  | { status: 'unreadable'; message: string }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invalid(path: string, detail: string): never {
  throw new ManifestValidationError('invalid', `${path}：${detail}`)
}

function overLimit(detail: string): never {
  throw new ManifestValidationError('limit', detail)
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(path, '必须是对象')
  return value as JsonRecord
}

function expectString(value: unknown, path: string, max: number, min = 0): string {
  if (typeof value !== 'string') invalid(path, '必须是字符串')
  if (value.length < min) invalid(path, `长度不能小于 ${min}`)
  if (value.length > max) overLimit(`${path} 长度超过上限 ${max}`)
  return value
}

function expectText(value: unknown, path: string, max: number, min = 0): string {
  const text = expectString(value, path, max, min)
  if (text.includes('\u0000')) invalid(path, '不能包含 NUL')
  return text
}

function expectId(value: unknown, path: string): string {
  const text = expectString(value, path, ID_MAX, 1)
  if ([...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid(path, '不能包含控制字符')
  return text
}

function expectInteger(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(path, '必须是安全整数')
  if (value < min || value > max) invalid(path, `必须在 ${min}..${max} 之间`)
  return value
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, '必须是有限数字')
  return value
}

function expectNonNegativeNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path)
  if (number < 0) invalid(path, '不能是负数')
  return number
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, '必须是布尔值')
  return value
}

function expectEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(path, `必须是 ${allowed.join('/')} 之一`)
  }
  return value as T
}

function expectSha256(value: unknown, path: string): string {
  const text = expectString(value, path, 64, 64)
  if (!SHA256_PATTERN.test(text)) invalid(path, '必须是 64 位十六进制摘要')
  return text
}

function expectTimestamp(value: unknown, path: string): number {
  return expectInteger(value, path, 0)
}

/** 受管目录内的相对路径：禁止绝对路径、盘符、NUL 与 `..` 段。 */
function expectRelativePath(value: unknown, path: string): string {
  const text = expectText(value, path, PATH_MAX, 1)
  if (/^[\\/]/.test(text) || /^[a-zA-Z]:/.test(text)) invalid(path, '必须是受管目录内的相对路径')
  if (text.split(/[\\/]+/).some((segment) => segment === '..')) invalid(path, '不能跳出受管目录')
  return text
}

function expectArray(record: JsonRecord, key: string, path: string, min: number, max: number): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) invalid(`${path}.${key}`, '必须是数组')
  if (value.length < min) invalid(`${path}.${key}`, `至少需要 ${min} 条`)
  if (value.length > max) overLimit(`${path}.${key} 超过 ${max} 条上限，不能淘汰旧记录，必须拒绝新增`)
  return value
}

function expectIdList(value: unknown, path: string, max: number): string[] {
  if (!Array.isArray(value)) invalid(path, '必须是数组')
  if (value.length > max) overLimit(`${path} 超过 ${max} 条上限`)
  const seen = new Set<string>()
  const ids: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const id = expectId(value[index], `${path}[${index}]`)
    if (seen.has(id)) invalid(`${path}[${index}]`, `重复的 id ${id}`)
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function validateBackendIdentity(raw: unknown, path: string): void {
  const record = asRecord(raw, path)
  expectId(record.instanceId, `${path}.instanceId`)
  expectInteger(record.instanceEpoch, `${path}.instanceEpoch`, 0)
}

function validateNativeExecutionRef(raw: unknown, path: string): void {
  const record = asRecord(raw, path)
  expectId(record.sessionId, `${path}.sessionId`)
  expectId(record.taskId, `${path}.taskId`)
  if (record.attemptId !== undefined) expectId(record.attemptId, `${path}.attemptId`)
  if (record.executionSessionId !== undefined) expectId(record.executionSessionId, `${path}.executionSessionId`)
  validateBackendIdentity(record.executionIdentity, `${path}.executionIdentity`)
}

function validateObservation(raw: unknown, path: string): void {
  const record = asRecord(raw, path)
  expectEnum(record.state, `${path}.state`, TASK_STATES)
  expectBoolean(record.stale, `${path}.stale`)
  expectTimestamp(record.observedAt, `${path}.observedAt`)
  if (record.identity === undefined) invalid(`${path}.identity`, '必须存在（可以是 null）')
  if (record.identity !== null) validateBackendIdentity(record.identity, `${path}.identity`)
  if (record.executionIdentity !== undefined) validateBackendIdentity(record.executionIdentity, `${path}.executionIdentity`)
  if (record.attemptId !== undefined) expectId(record.attemptId, `${path}.attemptId`)
  if (record.lastConfirmedState !== undefined) {
    expectText(record.lastConfirmedState, `${path}.lastConfirmedState`, NAME_MAX)
  }
}

function validatePerformance(raw: unknown, path: string): void {
  const record = asRecord(raw, path)
  expectText(record.component, `${path}.component`, NAME_MAX)
  expectText(record.baselineVersion, `${path}.baselineVersion`, NAME_MAX)
  expectText(record.currentVersion, `${path}.currentVersion`, NAME_MAX)
  expectText(record.environment, `${path}.environment`, TEXT_MAX)
  expectText(record.workload, `${path}.workload`, TEXT_MAX)
  const metrics = expectArray(record, 'metrics', path, 0, METRIC_LIMIT)
  for (let index = 0; index < metrics.length; index += 1) {
    const metricPath = `${path}.metrics[${index}]`
    const metric = asRecord(metrics[index], metricPath)
    expectText(metric.name, `${metricPath}.name`, NAME_MAX, 1)
    expectText(metric.unit, `${metricPath}.unit`, 64)
    expectEnum(metric.direction, `${metricPath}.direction`, DIRECTIONS)
    expectFiniteNumber(metric.baseline, `${metricPath}.baseline`)
    expectFiniteNumber(metric.current, `${metricPath}.current`)
    expectInteger(metric.samples, `${metricPath}.samples`, 0)
    expectNonNegativeNumber(metric.thresholdPercent, `${metricPath}.thresholdPercent`)
  }
}

function validateDefinition(record: JsonRecord, path: string): void {
  expectText(record.title, `${path}.title`, TITLE_MAX)
  expectText(record.goal, `${path}.goal`, TEXT_MAX)
  expectText(record.workspace, `${path}.workspace`, PATH_MAX)
  expectEnum(record.templateId, `${path}.templateId`, TEMPLATE_IDS)
  expectText(record.acceptanceCriteria, `${path}.acceptanceCriteria`, TEXT_MAX)
  expectIdList(record.resourceIds, `${path}.resourceIds`, RESOURCE_LIMIT)
  expectEnum(record.approvalPolicy, `${path}.approvalPolicy`, APPROVAL_POLICIES)
  if (record.performance !== undefined) validatePerformance(record.performance, `${path}.performance`)
  const keys = ['title', 'goal', 'workspace', 'templateId', 'acceptanceCriteria', 'resourceIds', 'approvalPolicy', 'performance']
  if (!parseTaskDefinition(Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]])))) {
    invalid(path, '任务定义不符合当前业务输入契约')
  }
}

function validateEntry(raw: unknown, path: string): { id: string; revision: number } {
  const record = asRecord(raw, path)
  const id = expectId(record.id, `${path}.id`)
  const revision = expectInteger(record.revision, `${path}.revision`, 0)
  const createdAt = expectTimestamp(record.createdAt, `${path}.createdAt`)
  const updatedAt = expectTimestamp(record.updatedAt, `${path}.updatedAt`)
  if (updatedAt < createdAt) invalid(`${path}.updatedAt`, '不能早于 createdAt')
  validateDefinition(record, path)
  return { id, revision }
}

interface SubmissionFacts {
  id: string
  clientOperationId: string
  requestId: string
  enqueueSeq: number
  pending: boolean
  frozenInputHash: string
}

function validateSubmission(raw: unknown, path: string, entryRevisions: Map<string, number>): SubmissionFacts {
  const record = asRecord(raw, path)
  const id = expectId(record.id, `${path}.id`)
  const taskEntryId = expectId(record.taskEntryId, `${path}.taskEntryId`)
  const entryRevision = entryRevisions.get(taskEntryId)
  if (entryRevision === undefined) invalid(`${path}.taskEntryId`, `引用不存在的任务条目 ${taskEntryId}`)
  const taskRevision = expectInteger(record.taskRevision, `${path}.taskRevision`, 0)
  if (taskRevision > entryRevision) invalid(`${path}.taskRevision`, `不能大于任务条目当前修订 ${entryRevision}`)
  const clientOperationId = expectId(record.clientOperationId, `${path}.clientOperationId`)
  expectEnum(record.queueMode, `${path}.queueMode`, QUEUE_MODES)
  const enqueueSeq = expectInteger(record.enqueueSeq, `${path}.enqueueSeq`, 1)
  validateDefinition(asRecord(record.frozenDefinition, `${path}.frozenDefinition`), `${path}.frozenDefinition`)
  expectText(record.frozenInputRef, `${path}.frozenInputRef`, PATH_MAX, 1)
  const frozenInputHash = expectSha256(record.frozenInputHash, `${path}.frozenInputHash`)
  if (record.workspaceFingerprint !== undefined) expectSha256(record.workspaceFingerprint, `${path}.workspaceFingerprint`)
  if (record.templateVersion !== 1) invalid(`${path}.templateVersion`, '必须是 1')
  const requestId = expectId(record.requestId, `${path}.requestId`)
  const handoffState = expectEnum(record.handoffState, `${path}.handoffState`, HANDOFF_STATES)

  if (record.sessionCreate !== undefined) {
    const createPath = `${path}.sessionCreate`
    const create = asRecord(record.sessionCreate, createPath)
    expectEnum(create.state, `${createPath}.state`, SESSION_CREATE_STATES)
    expectText(create.workspace, `${createPath}.workspace`, PATH_MAX)
    if (create.sessionId !== undefined) expectId(create.sessionId, `${createPath}.sessionId`)
  }

  const hasNativeRef = record.nativeExecutionRef !== undefined
  if (hasNativeRef) validateNativeExecutionRef(record.nativeExecutionRef, `${path}.nativeExecutionRef`)
  if (record.executionRequestId !== undefined) expectId(record.executionRequestId, `${path}.executionRequestId`)
  if (record.observation !== undefined) validateObservation(record.observation, `${path}.observation`)

  const history = expectArray(record, 'executionHistory', path, 0, ATTEMPT_LIMIT)
  for (let index = 0; index < history.length; index += 1) {
    validateNativeExecutionRef(history[index], `${path}.executionHistory[${index}]`)
  }

  let resumeWaiting = false
  if (record.resumeIntent !== undefined) {
    const resumePath = `${path}.resumeIntent`
    const intent = asRecord(record.resumeIntent, resumePath)
    expectId(intent.operationId, `${resumePath}.operationId`)
    expectId(intent.requestId, `${resumePath}.requestId`)
    expectText(intent.text, `${resumePath}.text`, TEXT_MAX)
    if (intent.sourceAttemptId !== undefined) expectId(intent.sourceAttemptId, `${resumePath}.sourceAttemptId`)
    if (intent.enqueueSeq !== undefined) expectInteger(intent.enqueueSeq, `${resumePath}.enqueueSeq`, 1)
    resumeWaiting = expectEnum(intent.state, `${resumePath}.state`, RESUME_STATES) === 'waiting'
  }

  const slotHeld = expectBoolean(record.slotHeld, `${path}.slotHeld`)
  const resourcesHeld = expectIdList(record.resourcesHeld, `${path}.resourcesHeld`, RESOURCE_LIMIT)
  if (record.cancelRequestedAt !== undefined) expectTimestamp(record.cancelRequestedAt, `${path}.cancelRequestedAt`)
  if (record.error !== undefined) expectText(record.error, `${path}.error`, ERROR_MAX)

  const notes = expectArray(record, 'notes', path, 0, NOTE_LIMIT)
  const noteIds = new Set<string>()
  for (let index = 0; index < notes.length; index += 1) {
    const notePath = `${path}.notes[${index}]`
    const note = asRecord(notes[index], notePath)
    const noteId = expectId(note.id, `${notePath}.id`)
    if (noteIds.has(noteId)) invalid(`${notePath}.id`, `重复的备注 id ${noteId}`)
    noteIds.add(noteId)
    expectText(note.text, `${notePath}.text`, TEXT_MAX)
    expectTimestamp(note.at, `${notePath}.at`)
    expectEnum(note.kind, `${notePath}.kind`, NOTE_KINDS)
  }

  const createdAt = expectTimestamp(record.createdAt, `${path}.createdAt`)
  const updatedAt = expectTimestamp(record.updatedAt, `${path}.updatedAt`)
  if (updatedAt < createdAt) invalid(`${path}.updatedAt`, '不能早于 createdAt')

  // 交接状态与占用的最小一致性：等待/撤回/拒绝不占用，派发中/结果未知必须占用；
  // bound 允许释放槽位（原生执行已到终态时槽位归还，但绑定关系仍然保留）。
  if (handoffState === 'bound' && !hasNativeRef) {
    invalid(`${path}.nativeExecutionRef`, 'bound 状态必须带有原生执行引用')
  }
  if (handoffState === 'bound' && !slotHeld && (!record.observation ||
    !['completed', 'failed', 'cancelled'].includes(String(asRecord(record.observation, `${path}.observation`).state)))) {
    invalid(`${path}.slotHeld`, '未确认终态的原生绑定必须保留活动槽位')
  }
  if (record.resumeIntent && asRecord(record.resumeIntent, `${path}.resumeIntent`).state !== 'waiting' && !slotHeld) {
    invalid(`${path}.slotHeld`, '已派发或未知的续接必须保留活动槽位')
  }
  if ((handoffState === 'sending' || handoffState === 'unknown') && !slotHeld) {
    invalid(`${path}.slotHeld`, `${handoffState} 状态必须占用一个活动槽位`)
  }
  if ((handoffState === 'waiting' || handoffState === 'withdrawn' || handoffState === 'rejected') && slotHeld) {
    invalid(`${path}.slotHeld`, `${handoffState} 状态不能占用活动槽位`)
  }
  if ((handoffState === 'waiting' || handoffState === 'withdrawn' || handoffState === 'rejected') && resourcesHeld.length > 0) {
    invalid(`${path}.resourcesHeld`, `${handoffState} 状态不能占用资源`)
  }

  return {
    id,
    clientOperationId,
    requestId,
    enqueueSeq,
    pending: handoffState === 'waiting' || resumeWaiting,
    frozenInputHash
  }
}

function validateArtifact(raw: unknown, path: string, submissionId: string, frozenInputHash: string): number {
  const record = asRecord(raw, path)
  expectId(record.artifactId, `${path}.artifactId`)
  const artifactSubmissionId = expectId(record.submissionId, `${path}.submissionId`)
  if (artifactSubmissionId !== submissionId) invalid(`${path}.submissionId`, '必须与所属验收记录的提交一致')
  expectText(record.name, `${path}.name`, NAME_MAX, 1)
  expectRelativePath(record.relativePath, `${path}.relativePath`)
  expectEnum(record.format, `${path}.format`, ARTIFACT_FORMATS)
  const bytes = expectInteger(record.bytes, `${path}.bytes`, 0)
  if (bytes > TASK_WORKBENCH_ARTIFACT_BYTES_LIMIT) {
    overLimit(`${path}.bytes 超过单个产物 ${TASK_WORKBENCH_ARTIFACT_BYTES_LIMIT} 字节上限`)
  }
  expectSha256(record.sha256, `${path}.sha256`)
  expectTimestamp(record.collectedAt, `${path}.collectedAt`)
  const artifactHash = expectSha256(record.frozenInputHash, `${path}.frozenInputHash`)
  if (!sameHash(artifactHash, frozenInputHash)) invalid(`${path}.frozenInputHash`, '必须与所属成果的冻结输入摘要一致')
  if (record.templateVersion !== 1) invalid(`${path}.templateVersion`, '必须是 1')
  expectEnum(record.source, `${path}.source`, ARTIFACT_SOURCES)
  if (record.nativeExecutionRef !== undefined) {
    validateNativeExecutionRef(record.nativeExecutionRef, `${path}.nativeExecutionRef`)
  }
  return bytes
}

function validateResult(
  raw: unknown,
  path: string,
  submissionHashes: Map<string, string>
): { id: string; artifactIds: string[] } {
  const record = asRecord(raw, path)
  const id = expectId(record.id, `${path}.id`)
  const submissionId = expectId(record.submissionId, `${path}.submissionId`)
  const expectedHash = submissionHashes.get(submissionId)
  if (expectedHash === undefined) invalid(`${path}.submissionId`, `引用不存在的提交 ${submissionId}`)
  const frozenInputHash = expectSha256(record.frozenInputHash, `${path}.frozenInputHash`)
  if (!sameHash(frozenInputHash, expectedHash)) invalid(`${path}.frozenInputHash`, '与提交的冻结输入摘要不一致')

  const artifacts = expectArray(record, 'artifacts', path, 0, ARTIFACT_LIMIT)
  const artifactIds: string[] = []
  let totalBytes = 0
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifactPath = `${path}.artifacts[${index}]`
    totalBytes += validateArtifact(artifacts[index], artifactPath, submissionId, frozenInputHash)
    artifactIds.push(expectId(asRecord(artifacts[index], artifactPath).artifactId, `${artifactPath}.artifactId`))
  }
  if (totalBytes > TASK_WORKBENCH_RESULT_BYTES_LIMIT) {
    overLimit(`${path} 的产物合计 ${totalBytes} 字节，超过单次成果 ${TASK_WORKBENCH_RESULT_BYTES_LIMIT} 字节上限`)
  }

  expectEnum(record.decision, `${path}.decision`, DECISIONS)
  const checks = expectArray(record, 'checks', path, 0, CHECK_LIMIT)
  for (let index = 0; index < checks.length; index += 1) {
    const checkPath = `${path}.checks[${index}]`
    const check = asRecord(checks[index], checkPath)
    expectText(check.name, `${checkPath}.name`, NAME_MAX, 1)
    expectBoolean(check.passed, `${checkPath}.passed`)
    expectText(check.detail, `${checkPath}.detail`, CHECK_DETAIL_MAX)
  }
  expectEnum(record.businessOutcome, `${path}.businessOutcome`, OUTCOMES)
  if (record.nativeExecutionRef !== undefined) {
    validateNativeExecutionRef(record.nativeExecutionRef, `${path}.nativeExecutionRef`)
  }
  if (record.verifierVersion !== 1) invalid(`${path}.verifierVersion`, '必须是 1')
  expectTimestamp(record.verifiedAt, `${path}.verifiedAt`)
  if (record.reviewer !== undefined) expectText(record.reviewer, `${path}.reviewer`, TEXT_MAX)

  return { id, artifactIds }
}

function validateOperation(raw: unknown, path: string): string {
  const record = asRecord(raw, path)
  const id = expectId(record.id, `${path}.id`)
  expectText(record.fingerprint, `${path}.fingerprint`, FINGERPRINT_MAX, 1)
  expectId(record.entityId, `${path}.entityId`)
  expectTimestamp(record.at, `${path}.at`)
  return id
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item))
  if (typeof value === 'object' && value !== null) {
    const source = value as JsonRecord
    const sorted: JsonRecord = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item === undefined) continue
      sorted[key] = sortJsonValue(item)
    }
    return sorted
  }
  return value
}

/** 与键顺序无关的序列化，用于比较冻结定义是否被改写。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? ''
}

/** 缺省清单：schemaVersion 1、revision 0、队列默认暂停、maxActive 2。 */
export function createEmptyTaskWorkbenchManifest(): TaskWorkbenchManifest {
  return {
    schemaVersion: 1,
    revision: 0,
    queueEnabled: false,
    maxActive: 2,
    nextEnqueueSeq: 1,
    entries: [],
    submissions: [],
    results: [],
    operations: []
  }
}

/**
 * 校验清单结构与关联。非法时抛错而不是返回空清单：
 * 结构/枚举/关联问题 → invalid，条数与字节超限 → limit。
 */
export function validateTaskWorkbenchManifest(raw: unknown): TaskWorkbenchManifest {
  const record = asRecord(raw, 'manifest')
  if (record.schemaVersion !== 1) {
    invalid(
      'manifest.schemaVersion',
      `只支持 schemaVersion 1（收到 ${String(record.schemaVersion)}）：拒绝加载而不是用空清单覆盖`
    )
  }
  expectInteger(record.revision, 'manifest.revision', 0)
  expectBoolean(record.queueEnabled, 'manifest.queueEnabled')
  expectInteger(record.maxActive, 'manifest.maxActive', 1, ACTIVE_LIMIT)
  const nextEnqueueSeq = expectInteger(record.nextEnqueueSeq, 'manifest.nextEnqueueSeq', 1)

  const entryRevisions = new Map<string, number>()
  const entries = expectArray(record, 'entries', 'manifest', 0, RECORD_LIMIT)
  for (let index = 0; index < entries.length; index += 1) {
    const facts = validateEntry(entries[index], `manifest.entries[${index}]`)
    if (entryRevisions.has(facts.id)) invalid(`manifest.entries[${index}].id`, `重复的任务条目 id ${facts.id}`)
    entryRevisions.set(facts.id, facts.revision)
  }

  const submissionHashes = new Map<string, string>()
  const clientOperationIds = new Set<string>()
  const requestIds = new Set<string>()
  const enqueueSeqs = new Set<number>()
  const submissions = expectArray(record, 'submissions', 'manifest', 0, RECORD_LIMIT)
  const heldResources = new Set<string>()
  let pendingCount = 0
  for (let index = 0; index < submissions.length; index += 1) {
    const path = `manifest.submissions[${index}]`
    const facts = validateSubmission(submissions[index], path, entryRevisions)
    if (submissionHashes.has(facts.id)) invalid(`${path}.id`, `重复的提交 id ${facts.id}`)
    if (clientOperationIds.has(facts.clientOperationId)) {
      invalid(`${path}.clientOperationId`, `重复的业务操作 id ${facts.clientOperationId}`)
    }
    if (requestIds.has(facts.requestId)) invalid(`${path}.requestId`, `重复的请求 id ${facts.requestId}`)
    if (enqueueSeqs.has(facts.enqueueSeq)) invalid(`${path}.enqueueSeq`, `重复的排队序号 ${facts.enqueueSeq}`)
    if (facts.enqueueSeq >= nextEnqueueSeq) {
      invalid(`${path}.enqueueSeq`, `必须小于 nextEnqueueSeq ${nextEnqueueSeq}`)
    }
    clientOperationIds.add(facts.clientOperationId)
    requestIds.add(facts.requestId)
    enqueueSeqs.add(facts.enqueueSeq)
    submissionHashes.set(facts.id, facts.frozenInputHash)
    if (facts.pending) pendingCount += 1
    const submission = asRecord(submissions[index], path)
    for (const resource of submission.resourcesHeld as string[]) {
      if (heldResources.has(resource)) invalid(`${path}.resourcesHeld`, '不同提交不能同时持有同一独占资源')
      heldResources.add(resource)
    }
    if (submission.resumeIntent) {
      const intent = asRecord(submission.resumeIntent, `${path}.resumeIntent`)
      if (intent.enqueueSeq !== undefined) {
        const sequence = Number(intent.enqueueSeq)
        if (enqueueSeqs.has(sequence) || sequence >= nextEnqueueSeq) invalid(`${path}.resumeIntent.enqueueSeq`, '续接排队序号重复或超出范围')
        enqueueSeqs.add(sequence)
      }
    }
  }
  if (pendingCount > TASK_WORKBENCH_PENDING_LIMIT) {
    overLimit(`等待队列 ${pendingCount} 条超过上限 ${TASK_WORKBENCH_PENDING_LIMIT}：不能静默淘汰，必须拒绝新增`)
  }

  const resultIds = new Set<string>()
  const artifactIds = new Set<string>()
  const results = expectArray(record, 'results', 'manifest', 0, RECORD_LIMIT)
  for (let index = 0; index < results.length; index += 1) {
    const path = `manifest.results[${index}]`
    const facts = validateResult(results[index], path, submissionHashes)
    if (resultIds.has(facts.id)) invalid(`${path}.id`, `重复的验收记录 id ${facts.id}`)
    resultIds.add(facts.id)
    for (const artifactId of facts.artifactIds) {
      if (artifactIds.has(artifactId)) invalid(`${path}.artifacts`, `重复的产物 id ${artifactId}`)
      artifactIds.add(artifactId)
    }
  }

  const operationIds = new Set<string>()
  const operations = expectArray(record, 'operations', 'manifest', 0, TASK_WORKBENCH_OPERATION_LIMIT)
  for (let index = 0; index < operations.length; index += 1) {
    const id = validateOperation(operations[index], `manifest.operations[${index}]`)
    if (operationIds.has(id)) invalid(`manifest.operations[${index}].id`, `重复的操作回执 id ${id}`)
    operationIds.add(id)
  }

  return raw as TaskWorkbenchManifest
}

export class TaskWorkbenchRepository {
  readonly rootDir: string
  private readonly manifestPath: string
  private readonly writeFile: (path: string, data: string) => Promise<void>
  private manifest: TaskWorkbenchManifest | null = null
  /** 上一次成功落盘（或加载到）的原始字节，用于核对写失败后的磁盘内容。 */
  private committedRaw: string | null = null
  private loaded = false
  private fatal: TaskWorkbenchStorageError | null = null
  /** 串行队列尾：所有 load/read/transact 排队执行，且永不 reject。 */
  private tail: Promise<void> = Promise.resolve()

  constructor(rootDir: string, options: TaskWorkbenchRepositoryOptions = {}) {
    if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
      throw new TypeError('TaskWorkbenchRepository 需要非空的根目录')
    }
    this.rootDir = resolve(rootDir)
    this.manifestPath = join(this.rootDir, 'manifest.json')
    this.writeFile = options.writeFile ?? atomicWriteFile
  }

  /** 存储被锁定时给出诊断信息；正常情况下为 undefined。 */
  get error(): string | undefined {
    return this.fatal?.message
  }

  /** 首次读取磁盘清单（缺失时使用默认清单，不写盘），返回克隆。 */
  async load(): Promise<TaskWorkbenchManifest> {
    return this.enqueue(async () => cloneJsonValue(await this.ensureLoaded()))
  }

  /** 读取当前内存快照（首次调用等价于 load），返回克隆。 */
  async read(): Promise<TaskWorkbenchManifest> {
    return this.enqueue(async () => cloneJsonValue(await this.ensureLoaded()))
  }

  /**
   * 在克隆出的草稿上执行修改，校验通过并原子落盘后才发布结果。
   * 回调异常原样透出（仓储不替 service 归类业务失败）；返回值是克隆。
   */
  async transact<T>(update: (draft: TaskWorkbenchManifest) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const previous = await this.ensureLoaded()
      // 草稿是独立克隆：回调只能改它，失败时上一次快照保持不变。
      const draft = cloneJsonValue(previous)
      const produced = await update(draft)

      let result: T
      try {
        result = cloneJsonValue(produced)
      } catch (error) {
        throw new TaskWorkbenchStorageError(
          'TASK_WORKBENCH_INVALID',
          this.manifestPath,
          `事务返回值无法克隆为 JSON 值：${describeError(error)}`,
          error
        )
      }

      // revision 由仓储递增，忽略回调写入的值。
      draft.revision = previous.revision + 1
      if (!Number.isSafeInteger(draft.revision)) {
        throw new TaskWorkbenchStorageError('TASK_WORKBENCH_LIMIT', this.manifestPath, '清单修订号已到达安全整数上限')
      }

      try {
        validateTaskWorkbenchManifest(draft)
        this.assertPreserved(previous, draft)
      } catch (error) {
        throw this.toStorageError(error)
      }

      let json: string
      try {
        json = JSON.stringify(draft)
        if (typeof json !== 'string') throw new Error('序列化没有产生字符串')
      } catch (error) {
        throw this.toStorageError(error)
      }
      const bytes = Buffer.byteLength(json, 'utf8')
      if (bytes > TASK_WORKBENCH_MAX_MANIFEST_BYTES) {
        throw new TaskWorkbenchStorageError(
          'TASK_WORKBENCH_LIMIT',
          this.manifestPath,
          `清单序列化后 ${bytes} 字节，超过上限 ${TASK_WORKBENCH_MAX_MANIFEST_BYTES}：本次修改未写入`
        )
      }

      // 发布用克隆：隔断回调残留的引用，内存快照不会被外部继续改写。
      const next = cloneJsonValue(draft)
      try {
        await this.writeFile(this.manifestPath, json)
      } catch (error) {
        const outcome = await this.reconcileWriteFailure(json)
        if (outcome === 'rejected') {
          throw new TaskWorkbenchStorageError(
            'TASK_WORKBENCH_WRITE_FAILED',
            this.manifestPath,
            `清单写入失败，磁盘仍是上一次提交的内容，本次修改未生效（可重试）：${describeError(error)}`,
            error
          )
        }
      }

      this.manifest = next
      this.committedRaw = json
      return result
    })
  }

  /** 等待队列里所有已排队的读写结束（队列不会因为单个事务失败而中断）。 */
  async flush(): Promise<void> {
    await this.tail
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async ensureLoaded(): Promise<TaskWorkbenchManifest> {
    if (!this.loaded) {
      this.loaded = true
      const disk = await this.readDisk()
      if (disk.status === 'ok') {
        this.manifest = cloneJsonValue(disk.manifest)
        this.committedRaw = disk.raw
      } else if (disk.status === 'missing') {
        // 缺失时只使用默认清单：读取路径不创建目录，也不写任何文件。
        this.manifest = createEmptyTaskWorkbenchManifest()
        this.committedRaw = null
      } else {
        const code: TaskWorkbenchStorageErrorCode =
          disk.status === 'corrupt' ? 'TASK_WORKBENCH_CORRUPT' : 'TASK_WORKBENCH_UNREADABLE'
        throw this.lock(code, disk.message)
      }
    }
    if (this.fatal) throw this.fatal
    if (!this.manifest) {
      throw new TaskWorkbenchStorageError('TASK_WORKBENCH_CORRUPT', this.manifestPath, '清单尚未加载')
    }
    return this.manifest
  }

  /** 只读地读取并校验磁盘清单，绝不写盘、不建目录。 */
  private async readDisk(): Promise<DiskReadState> {
    const read = await readFile(this.manifestPath, 'utf8').then(
      (raw) => ({ ok: true as const, raw }),
      (error: unknown) => ({ ok: false as const, error })
    )
    if (!read.ok) {
      if (isErrno(read.error, 'ENOENT')) return { status: 'missing' }
      return { status: 'unreadable', message: `清单无法读取：${describeError(read.error)}` }
    }

    const bytes = Buffer.byteLength(read.raw, 'utf8')
    if (bytes > TASK_WORKBENCH_MAX_MANIFEST_BYTES) {
      return {
        status: 'corrupt',
        message: `清单 ${bytes} 字节，超过上限 ${TASK_WORKBENCH_MAX_MANIFEST_BYTES}：拒绝加载并保留原文件`
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(read.raw)
    } catch (error) {
      return { status: 'corrupt', message: `清单不是合法 JSON：${describeError(error)}` }
    }
    try {
      return { status: 'ok', raw: read.raw, manifest: validateTaskWorkbenchManifest(parsed) }
    } catch (error) {
      return { status: 'corrupt', message: `清单校验失败：${describeError(error)}` }
    }
  }

  /**
   * 写入失败后核对磁盘（此时本次操作已结束，队列里没有并发写）：
   * 已是目标内容 → 视为成功；仍是上一次提交内容 → 拒绝本次但可重试；
   * 其他内容 → 锁定存储，禁止继续写入以免覆盖未知状态。
   */
  private async reconcileWriteFailure(attemptedJson: string): Promise<'committed' | 'rejected'> {
    const disk = await this.readDisk()
    if (disk.status === 'ok' && disk.raw === attemptedJson) return 'committed'
    if (disk.status === 'missing' && this.committedRaw === null) return 'rejected'
    if (disk.status === 'ok' && this.committedRaw !== null && disk.raw === this.committedRaw) return 'rejected'

    const detail =
      disk.status === 'ok'
        ? '磁盘上是另一份内容'
        : disk.status === 'missing'
          ? '磁盘上的清单已消失'
          : disk.message
    throw this.lock(
      'TASK_WORKBENCH_WRITE_UNCERTAIN',
      `清单写入失败且无法核对结果（${detail}）：已锁定存储，禁止继续读写以免覆盖未知状态`
    )
  }

  /**
   * 已保存的记录不允许被淘汰或改写：操作回执是最小去重摘要，提交承载冻结输入与
   * 原生工作关联，验收记录承载提交关联。删除它们会丢失去重与追溯能力。
   */
  private assertPreserved(previous: TaskWorkbenchManifest, next: TaskWorkbenchManifest): void {
    const nextOperations = new Map(next.operations.map((receipt) => [receipt.id, receipt]))
    for (const receipt of previous.operations) {
      const kept = nextOperations.get(receipt.id)
      if (!kept) invalid('manifest.operations', `不能淘汰已保存的操作回执 ${receipt.id}（去重记录必须保留）`)
      if (kept.fingerprint !== receipt.fingerprint || kept.entityId !== receipt.entityId || kept.at !== receipt.at) {
        invalid(`manifest.operations[${receipt.id}]`, '已保存的操作回执不可改写')
      }
    }

    const nextSubmissions = new Map(next.submissions.map((submission) => [submission.id, submission]))
    for (const submission of previous.submissions) {
      const kept = nextSubmissions.get(submission.id)
      if (!kept) {
        invalid('manifest.submissions', `不能删除已提交的 ${submission.id}：去重摘要与原生工作关联必须保留`)
      }
      if (
        kept.clientOperationId !== submission.clientOperationId ||
        kept.requestId !== submission.requestId ||
        kept.taskEntryId !== submission.taskEntryId ||
        kept.taskRevision !== submission.taskRevision ||
        kept.enqueueSeq !== submission.enqueueSeq ||
        kept.queueMode !== submission.queueMode ||
        kept.frozenInputRef !== submission.frozenInputRef ||
        kept.workspaceFingerprint !== submission.workspaceFingerprint ||
        !sameHash(kept.frozenInputHash, submission.frozenInputHash) ||
        kept.templateVersion !== submission.templateVersion ||
        kept.createdAt !== submission.createdAt ||
        canonicalJson(kept.frozenDefinition) !== canonicalJson(submission.frozenDefinition)
      ) {
        invalid(
          `manifest.submissions[${submission.id}]`,
          '提交身份、冻结输入或来源条目修订不可改写（改 TaskEntry 不能改已提交输入）'
        )
      }
    }

    const nextResults = new Map(next.results.map((result) => [result.id, result]))
    for (const result of previous.results) {
      const kept = nextResults.get(result.id)
      if (!kept) invalid('manifest.results', `不能删除已保存的验收记录 ${result.id}`)
      if (kept.submissionId !== result.submissionId || !sameHash(kept.frozenInputHash, result.frozenInputHash)) {
        invalid(`manifest.results[${result.id}]`, '验收记录的提交关联与冻结输入摘要不可改写')
      }
    }
  }

  private toStorageError(error: unknown): TaskWorkbenchStorageError {
    if (error instanceof ManifestValidationError) {
      const code: TaskWorkbenchStorageErrorCode =
        error.kind === 'limit' ? 'TASK_WORKBENCH_LIMIT' : 'TASK_WORKBENCH_INVALID'
      return new TaskWorkbenchStorageError(code, this.manifestPath, `清单校验失败：${error.message}`, error)
    }
    return new TaskWorkbenchStorageError(
      'TASK_WORKBENCH_INVALID',
      this.manifestPath,
      `清单校验失败：${describeError(error)}`,
      error
    )
  }

  private lock(code: TaskWorkbenchStorageErrorCode, message: string): TaskWorkbenchStorageError {
    const error = new TaskWorkbenchStorageError(code, this.manifestPath, message)
    this.fatal = error
    return error
  }
}
