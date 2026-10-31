import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import type { TaskDefinition, TaskSubmission } from '@shared/task-workbench'
import { TaskWorkbenchResults } from './results'

const hooks = vi.hoisted(() => ({ afterRead: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const hookedOpen: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args)
    const originalRead = handle.read
    Object.defineProperty(handle, 'read', { value: async (...parameters: unknown[]) => {
      const result = await Reflect.apply(originalRead, handle, parameters)
      const hook = hooks.afterRead
      if (hook) { hooks.afterRead = undefined; await hook(String(args[0])) }
      return result
    } })
    return handle
  }
  return { ...actual, open: hookedOpen }
})

let base: string
let workspace: string
let root: string
let results: TaskWorkbenchResults

function definition(): TaskDefinition {
  return {
    title: '性能分析', goal: '分析已有结果', workspace, templateId: 'component-performance',
    acceptanceCriteria: '', resourceIds: [], approvalPolicy: 'manual',
    performance: {
      component: 'parser', baselineVersion: '1', currentVersion: '2', environment: 'A', workload: 'same workload',
      metrics: [{ name: 'latency', unit: 'ms', direction: 'lower', baseline: 10, current: 12, samples: 10, thresholdPercent: 5 }]
    }
  }
}

async function submission(id = 'submission-1'): Promise<TaskSubmission> {
  const frozenDefinition = definition()
  const frozen = await results.freeze(frozenDefinition, id)
  const identity = { instanceId: 'backend-1', instanceEpoch: 1 }
  return {
    id, taskEntryId: 'entry-1', taskRevision: 1, clientOperationId: 'operation-1', queueMode: 'host', enqueueSeq: 1,
    frozenDefinition, frozenInputRef: frozen.relativePath, frozenInputHash: frozen.sha256, templateVersion: 1,
    requestId: 'request-1', handoffState: 'bound',
    nativeExecutionRef: { sessionId: 'session-1', taskId: 'task-1', attemptId: 'attempt-1', executionIdentity: identity },
    observation: { state: 'completed', stale: false, observedAt: Date.now(), identity },
    executionHistory: [], slotHeld: false, resourcesHeld: [], notes: [], createdAt: Date.now(), updatedAt: Date.now()
  }
}

function report(value: TaskSubmission, body = '真实观察到延迟上升。'): string {
  return [
    `Submission: ${value.id}`, `Input-SHA256: ${value.frozenInputHash}`, 'Template-Version: 1',
    `Execution-Request: ${value.executionRequestId ?? value.requestId}`,
    'Evidence-Source: user-provided-results', '', '## 事实 / Facts', body,
    '## 推测 / Hypotheses', '可能存在竞争，需要证据。', '## 待验证 / To verify', '采集火焰图核对。', ''
  ].join('\n')
}

async function saveReport(value: TaskSubmission, text = report(value)): Promise<string> {
  const target = join(workspace, '.lyshell-task-results', value.id, 'report.md')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text)
  return target
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'lyshell-task-results-'))
  workspace = join(base, 'workspace')
  root = join(base, 'managed')
  await mkdir(workspace)
  results = new TaskWorkbenchResults(root)
})

afterEach(async () => {
  hooks.afterRead = undefined
  // mkdtemp 返回的绝对目录必须仍在本测试的具名临时范围内。
  if (resolve(base).startsWith(resolve(tmpdir()) + sep + 'lyshell-task-results-')) await rm(base, { recursive: true, force: true })
})

describe('task result snapshots and acceptance', () => {
  it('rejects a previous attempt report after continuation until the new execution writes its own marker', async () => {
    const value = await submission()
    await saveReport(value)
    value.executionHistory.push(structuredClone(value.nativeExecutionRef!))
    value.nativeExecutionRef!.attemptId = 'attempt-2'
    const result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'report-execution')?.passed).toBe(false)
    value.executionRequestId = 'resume:request-2'
    expect((await results.verify(value)).decision).toBe('failed')
    await saveReport(value)
    expect((await results.verify(value)).decision).toBe('passed')
  })
  it('accepts authoritative old completion served by a new backend only for the same execution and attempt', async () => {
    const value = await submission()
    await saveReport(value)
    value.observation!.executionIdentity = value.nativeExecutionRef!.executionIdentity
    value.observation!.attemptId = value.nativeExecutionRef!.attemptId
    value.observation!.identity = { instanceId: 'recovered-backend', instanceEpoch: 2 }
    expect((await results.verify(value)).decision).toBe('passed')
    value.observation!.attemptId = 'other-attempt'
    expect((await results.verify(value)).decision).toBe('needs-human')
  })
  it('完整性能报告可验收通过，并独立报告性能回退', async () => {
    const value = await submission()
    await saveReport(value)
    const result = await results.verify(value)
    expect(result.decision).toBe('passed')
    expect(result.businessOutcome).toBe('regression')
    expect(result.artifacts.map(artifact => artifact.name)).toEqual(['input.json', 'performance-facts.json', 'performance-facts.md', 'report.md'])
    expect(result.checks.every(check => check.passed)).toBe(true)
    const facts = result.artifacts.find(artifact => artifact.name === 'performance-facts.json')!
    expect(JSON.parse(await results.readArtifact(facts)).comparison.metrics[0].changePercent).toBe(20)
  })

  it('冻结输入幂等且不能被同一提交替换，拒绝非JSON数值', async () => {
    const value = definition()
    const first = await results.freeze(value, 'submission-1')
    expect(await results.freeze(value, 'submission-1')).toEqual(first)
    await expect(results.freeze({ ...value, goal: 'different' }, 'submission-1')).rejects.toThrow('不能替换')
    value.performance!.metrics[0].current = NaN
    await expect(results.freeze(value, 'submission-2')).rejects.toThrow('非有限')
    await expect(results.freeze(definition(), '../escape')).rejects.toThrow('标识')
  })

  it('已完成原生执行但报告缺失，保持验收失败且不改原生状态', async () => {
    const value = await submission()
    const result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'report-file')?.passed).toBe(false)
    expect(value.observation?.state).toBe('completed')
  })

  it('输入字节被更换或业务定义不匹配时拒绝验收', async () => {
    const value = await submission()
    await saveReport(value)
    const changed = structuredClone(value)
    changed.frozenDefinition.goal = 'changed after start'
    expect((await results.verify(changed)).decision).toBe('failed')
    await writeFile(join(root, value.frozenInputRef), '{}')
    const result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'frozen-input')?.passed).toBe(false)
    expect(result.artifacts).toHaveLength(0)
  })

  it.each(['stale', 'identity', 'attempt', 'running'] as const)('缺少新鲜正确的完成证据 %s 时不自动通过', async kind => {
    const value = await submission()
    await saveReport(value)
    if (kind === 'stale') value.observation!.stale = true
    if (kind === 'identity') value.observation!.identity = { instanceId: 'different', instanceEpoch: 2 }
    if (kind === 'attempt') delete value.nativeExecutionRef!.attemptId
    if (kind === 'running') value.observation!.state = 'running'
    expect((await results.verify(value)).decision).toBe('needs-human')
  })

  it('报告缺少关联标记或三个独立章节时不能通过', async () => {
    const value = await submission()
    await saveReport(value, report(value).replace(`Submission: ${value.id}`, 'Submission: wrong'))
    expect((await results.verify(value)).decision).toBe('failed')
    await saveReport(value, report(value).replace('## 待验证 / To verify', '验证'))
    expect((await results.verify(value)).checks.find(check => check.name === 'report-sections')?.passed).toBe(false)
  })

  it('缺少用户来源声明不能把分析模式当作本次执行测试', async () => {
    const value = await submission()
    await saveReport(value, report(value).replace('Evidence-Source: user-provided-results', ''))
    const result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'report-source')?.passed).toBe(false)
  })

  it('复验创建新快照，旧验收仍绑定原来的报告字节', async () => {
    const value = await submission()
    await saveReport(value, report(value, '原始报告'))
    const first = await results.verify(value)
    const original = first.artifacts.find(artifact => artifact.name === 'report.md')!
    await saveReport(value, report(value, '新的报告'))
    const second = await results.verify(value)
    expect(second.id).not.toBe(first.id)
    expect(await results.readArtifact(original)).toContain('原始报告')
    expect(second.artifacts.find(artifact => artifact.name === 'report.md')?.sha256).not.toBe(original.sha256)
  })

  it('索引越界、快照字节被篡改时不能读取或导出', async () => {
    const value = await submission()
    await saveReport(value)
    const artifact = (await results.verify(value)).artifacts[0]
    await expect(results.readArtifact({ ...artifact, relativePath: '../manifest.json' })).rejects.toThrow('索引')
    await expect(results.readArtifact({ ...artifact, relativePath: `artifacts/${value.id}/../../escape` })).rejects.toThrow('越界')
    await writeFile(join(root, artifact.relativePath), 'tampered')
    await expect(results.readArtifact(artifact)).rejects.toThrow('摘要')
    await expect(results.exportArtifact(artifact, join(base, 'export.json'))).rejects.toThrow('摘要')
  })

  it('拒绝单个超过5MiB的报告和非UTF-8报告', async () => {
    const value = await submission()
    const target = await saveReport(value)
    await writeFile(target, Buffer.alloc(5 * 1024 * 1024 + 1, 65))
    let result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'report-file')?.detail).toContain('5 MiB')
    await writeFile(target, Buffer.from([0xff, 0xfe, 0xfd]))
    result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'report-file')?.detail).toContain('UTF-8')
  })

  it('拒绝经过junction逃逸的报告路径', async () => {
    const value = await submission()
    const outside = join(base, 'outside')
    await mkdir(join(outside, value.id), { recursive: true })
    await writeFile(join(outside, value.id, 'report.md'), report(value))
    await symlink(outside, join(workspace, '.lyshell-task-results'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'report-file')?.detail).toContain('链接')
  })

  it('读取期间文件增长被识别，不接受不稳定报告', async () => {
    const value = await submission()
    const target = await saveReport(value)
    // 排除先读取的冻结输入：只在实际报告句柄读到字节之后注入同文件变化。
    const addHook = (): void => { hooks.afterRead = async file => {
      if (resolve(file) === resolve(target)) await appendFile(target, '\nchanged')
      else addHook()
    } }
    addHook()
    const result = await results.verify(value)
    expect(result.decision).toBe('failed')
    expect(result.checks.find(check => check.name === 'report-file')?.detail).toContain('变化')
  })

  it('用户自定义完成条件保留人工确认，并能按实际快照导出', async () => {
    const value = await submission()
    // 重新建立带自定义条件的冻结输入，而不是修改已经提交的定义。
    value.id = 'submission-2'
    value.frozenDefinition.acceptanceCriteria = '人工确认根因解释充分'
    const frozen = await results.freeze(value.frozenDefinition, value.id)
    value.frozenInputRef = frozen.relativePath; value.frozenInputHash = frozen.sha256
    await saveReport(value)
    const result = await results.verify(value)
    expect(result.decision).toBe('needs-human')
    const artifact = result.artifacts.find(item => item.name === 'report.md')!
    const target = join(base, 'export.md')
    await results.exportArtifact(artifact, target)
    expect(await readFile(target, 'utf8')).toEqual(await results.readArtifact(artifact))
    expect((await lstat(target)).isFile()).toBe(true)
  })
})
