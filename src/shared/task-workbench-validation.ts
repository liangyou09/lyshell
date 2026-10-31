import type { PerformanceInput, PerformanceMetric, TaskDefinition, TaskWorkbenchRequest } from './task-workbench'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = (value: RecordValue, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const text = (value: unknown, max: number, multiline = false): value is string => typeof value === 'string' &&
  value.trim().length > 0 && value.length <= max && ![...value].some(character => {
    const code = character.charCodeAt(0)
    return code === 127 || code < 32 && !(multiline && [9, 10, 13].includes(code))
  })
const id = (value: unknown): value is string => text(value, 128)
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const finite = (value: unknown, min = 0, max = Number.MAX_VALUE): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

function metric(raw: unknown): PerformanceMetric | null {
  if (!record(raw) || !fields(raw, ['name', 'unit', 'direction', 'baseline', 'current', 'samples', 'thresholdPercent']) ||
    !text(raw.name, 128) || !text(raw.unit, 64) || !['higher', 'lower'].includes(String(raw.direction)) ||
    !finite(raw.baseline) || !finite(raw.current) || !integer(raw.samples, 1, 1_000_000_000) || !finite(raw.thresholdPercent, 0, 10000)) return null
  return { name: raw.name, unit: raw.unit, direction: raw.direction as 'higher' | 'lower', baseline: raw.baseline,
    current: raw.current, samples: raw.samples, thresholdPercent: raw.thresholdPercent }
}

function performance(raw: unknown): PerformanceInput | null {
  if (!record(raw) || !fields(raw, ['component', 'baselineVersion', 'currentVersion', 'environment', 'workload', 'metrics']) ||
    !text(raw.component, 200) || !text(raw.baselineVersion, 200) || !text(raw.currentVersion, 200) ||
    !text(raw.environment, 1000) || !text(raw.workload, 1000) || !Array.isArray(raw.metrics) || raw.metrics.length < 1 || raw.metrics.length > 100) return null
  const metrics = Array.from(raw.metrics, metric)
  if (metrics.some(value => value === null) || new Set(metrics.map(value => value!.name.trim().toLocaleLowerCase())).size !== metrics.length) return null
  return { component: raw.component, baselineVersion: raw.baselineVersion, currentVersion: raw.currentVersion,
    environment: raw.environment, workload: raw.workload, metrics: metrics as PerformanceMetric[] }
}

/** renderer 只提供业务字段；owner、桥地址、任意成果路径一律不在 DTO 中。 */
export function parseTaskDefinition(raw: unknown): TaskDefinition | null {
  if (!record(raw) || !fields(raw, ['title', 'goal', 'workspace', 'templateId', 'acceptanceCriteria', 'resourceIds', 'approvalPolicy', 'performance']) ||
    !text(raw.title, 200) || !text(raw.goal, 12000, true) || !text(raw.workspace, 2048) ||
    !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(raw.workspace) ||
    !['general', 'component-performance'].includes(String(raw.templateId)) ||
    !(raw.acceptanceCriteria === '' || text(raw.acceptanceCriteria, 8000, true)) ||
    !['auto-allow', 'manual'].includes(String(raw.approvalPolicy)) || !Array.isArray(raw.resourceIds) || raw.resourceIds.length > 16 ||
    !Array.from(raw.resourceIds).every(id) || new Set(raw.resourceIds).size !== raw.resourceIds.length) return null
  const input = raw.performance === undefined ? undefined : performance(raw.performance)
  if (input === null || raw.templateId === 'component-performance' && !input || raw.templateId === 'general' && input !== undefined) return null
  return { title: raw.title, goal: raw.goal, workspace: raw.workspace, templateId: raw.templateId as TaskDefinition['templateId'],
    acceptanceCriteria: raw.acceptanceCriteria, resourceIds: [...raw.resourceIds] as string[],
    approvalPolicy: raw.approvalPolicy as TaskDefinition['approvalPolicy'], ...(input ? { performance: input } : {}) }
}

const requestFields: Record<string, readonly string[]> = {
  list: [], save: ['operationId', 'definition', 'entryId', 'expectedRevision'], start: ['operationId', 'entryId', 'expectedRevision'],
  withdraw: ['operationId', 'submissionId'], cancel: ['operationId', 'submissionId'], verify: ['operationId', 'submissionId'],
  setQueueEnabled: ['operationId', 'enabled', 'maxActive'], inspect: ['submissionId'],
  addNote: ['operationId', 'submissionId', 'text'], releaseResources: ['operationId', 'submissionId', 'text'],
  resume: ['operationId', 'submissionId', 'text'], accept: ['operationId', 'submissionId', 'text'],
  recover: [], openNative: ['submissionId'], readArtifact: ['artifactId'], exportArtifact: ['artifactId']
}

export function parseTaskWorkbenchRequest(raw: unknown): TaskWorkbenchRequest | null {
  if (!record(raw) || typeof raw.kind !== 'string' || !Object.hasOwn(requestFields, raw.kind) ||
    !fields(raw, ['kind', ...requestFields[raw.kind]])) return null
  const kind = raw.kind
  if (kind === 'list' || kind === 'recover') return { kind }
  if (kind === 'openNative' || kind === 'inspect') return id(raw.submissionId) ? { kind, submissionId: raw.submissionId } : null
  if (kind === 'readArtifact' || kind === 'exportArtifact') return id(raw.artifactId) ? { kind, artifactId: raw.artifactId } : null
  if (!id(raw.operationId)) return null
  const operationId = raw.operationId
  if (kind === 'save') {
    const definition = parseTaskDefinition(raw.definition)
    if (!definition || raw.entryId !== undefined && !id(raw.entryId) || raw.expectedRevision !== undefined && !integer(raw.expectedRevision, 1) ||
      (raw.entryId === undefined) !== (raw.expectedRevision === undefined)) return null
    return { kind, operationId, definition, ...(raw.entryId ? { entryId: raw.entryId as string, expectedRevision: raw.expectedRevision as number } : {}) }
  }
  if (kind === 'start') return id(raw.entryId) && integer(raw.expectedRevision, 1) ? { kind, operationId, entryId: raw.entryId, expectedRevision: raw.expectedRevision } : null
  if (kind === 'setQueueEnabled') return typeof raw.enabled === 'boolean' && (raw.maxActive === undefined || integer(raw.maxActive, 1, 8))
    ? { kind, operationId, enabled: raw.enabled, ...(raw.maxActive !== undefined ? { maxActive: raw.maxActive as number } : {}) } : null
  if (!id(raw.submissionId)) return null
  const submissionId = raw.submissionId
  if (kind === 'withdraw' || kind === 'cancel' || kind === 'verify') return { kind, operationId, submissionId }
  if (kind === 'addNote' || kind === 'releaseResources' || kind === 'resume' || kind === 'accept') return text(raw.text, kind === 'resume' ? 12000 : 4000, true)
    ? { kind, operationId, submissionId, text: raw.text } : null
  return null
}
