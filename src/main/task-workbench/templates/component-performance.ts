import { join } from 'path'
import type {
  PerformanceInput, TaskDefinition, TaskResultBundle, TaskVerificationCheck
} from '@shared/task-workbench'

export interface PerformanceComparisonMetric {
  name: string
  unit: string
  direction: 'higher' | 'lower'
  baseline: number
  current: number
  samples: number
  thresholdPercent: number
  changePercent: number | null
  adversePercent: number | null
  regression: boolean
}

export interface PerformanceComparison {
  valid: boolean
  comparable: boolean
  checks: TaskVerificationCheck[]
  metrics: PerformanceComparisonMetric[]
  businessOutcome: TaskResultBundle['businessOutcome']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0')
}

/** 只计算用户提供的数据；此函数不启动测试，也不把输入中的声明当作执行证据。 */
export function comparePerformanceInput(value: unknown): PerformanceComparison {
  const checks: TaskVerificationCheck[] = []
  const fail = (detail: string): PerformanceComparison => ({
    valid: false, comparable: false, metrics: [], businessOutcome: 'not-comparable',
    checks: [...checks, { name: 'performance-schema', passed: false, detail }]
  })
  if (!isRecord(value)) return fail('缺少组件性能数据。')
  for (const key of ['component', 'baselineVersion', 'currentVersion', 'environment', 'workload']) {
    if (!boundedText(value[key], key === 'environment' || key === 'workload' ? 1000 : 200)) return fail(`缺少或无效的性能字段：${key}。`)
  }
  if (!Array.isArray(value.metrics) || !value.metrics.length || value.metrics.length > 128) {
    return fail('需要 1 至 128 项性能指标。')
  }
  const names = new Set<string>()
  const metrics: PerformanceComparisonMetric[] = []
  for (const raw of value.metrics) {
    if (!isRecord(raw) || !boundedText(raw.name) || !boundedText(raw.unit, 64) ||
      !['higher', 'lower'].includes(String(raw.direction))) return fail('指标名称、共同单位或方向无效。')
    if (names.has(raw.name.trim().toLocaleLowerCase())) return fail('指标名称重复，无法可靠对应两组结果。')
    names.add(raw.name.trim().toLocaleLowerCase())
    if (typeof raw.baseline !== 'number' || !Number.isFinite(raw.baseline) ||
      typeof raw.current !== 'number' || !Number.isFinite(raw.current) ||
      typeof raw.samples !== 'number' || !Number.isSafeInteger(raw.samples) || raw.samples < 1 ||
      typeof raw.thresholdPercent !== 'number' || !Number.isFinite(raw.thresholdPercent) || raw.thresholdPercent < 0) {
      return fail(`指标 ${raw.name} 必须包含有限数值、正整数样本数和非负告警阈值。`)
    }
    const changePercent = raw.baseline === 0 ? null : (raw.current - raw.baseline) / Math.abs(raw.baseline) * 100
    if (changePercent !== null && !Number.isFinite(changePercent)) return fail(`指标 ${raw.name} 的差值超出可计算范围。`)
    const adversePercent = changePercent === null ? null : raw.direction === 'higher' ? -changePercent : changePercent
    metrics.push({
      name: raw.name, unit: raw.unit, direction: raw.direction as 'higher' | 'lower',
      baseline: raw.baseline, current: raw.current, samples: raw.samples,
      thresholdPercent: raw.thresholdPercent, changePercent, adversePercent,
      regression: adversePercent !== null && adversePercent > 0 && adversePercent >= raw.thresholdPercent
    })
  }
  checks.push({ name: 'performance-schema', passed: true, detail: '字段、有限数值、共同单位、方向、样本数和阈值有效。' })
  checks.push({ name: 'performance-source', passed: true, detail: '来源为用户提供的已有结果；本次任务没有启动性能测试。' })
  const comparable = metrics.every(metric => metric.changePercent !== null)
  checks.push({
    name: 'performance-comparability', passed: comparable,
    detail: comparable
      ? '按用户声明的共同环境、工作负载和每项共同单位进行比较；程序未独立证明这些条件。'
      : '存在零基线，不能计算回归百分比，需要人工核对。'
  })
  return {
    valid: true, comparable, checks, metrics,
    businessOutcome: !comparable ? 'not-comparable' : metrics.some(metric => metric.regression) ? 'regression' : 'normal'
  }
}

const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')

export function performanceFactsMarkdown(input: PerformanceInput, comparison = comparePerformanceInput(input)): string {
  const rows = comparison.metrics.map(metric =>
    `| ${cell(metric.name)} | ${metric.baseline} | ${metric.current} | ${cell(metric.unit)} | ${metric.changePercent === null ? '不可比较（零基线）' : `${metric.changePercent.toFixed(2)}%`} | ${metric.regression ? '性能回退' : metric.changePercent === null ? '待核对' : '未达到回退阈值'} |`
  )
  return [
    '# 组件性能事实表', '',
    '来源：用户提供的已有结果。本任务只分析这些数据，没有启动测试。', '',
    `组件：${input.component}；版本：${input.baselineVersion} → ${input.currentVersion}`, '',
    `共同环境（用户声明）：${input.environment}`, '',
    `共同工作负载（用户声明）：${input.workload}`, '',
    '| 指标 | 基线 | 当前 | 共同单位 | 变化 | 结论 |', '| --- | ---: | ---: | --- | ---: | --- |',
    ...rows, '',
    '变化按 (当前 − 基线) / |基线| × 100% 计算。higher 指标下降、lower 指标上升且达到阈值时标为回退；零基线不计算百分比。', '',
    '这些确定性计算不证明模型提出的根因，也不证明用户提供的结果由本次任务执行。', ''
  ].join('\n')
}

/** 报告使用固定位置与关联标记，重新验收不会再次调用 Harness。 */
export function taskReportInstructions(definition: TaskDefinition, submissionId: string, inputHash: string, requestId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(submissionId) || !/^[a-f0-9]{64}$/.test(inputHash) ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId)) {
    throw new Error('Invalid task report identity')
  }
  const reportPath = join(definition.workspace, '.lyshell-task-results', submissionId, 'report.md')
  const lines = [
    '交付报告必须写到下列绝对路径，报告应为 UTF-8 Markdown：', reportPath,
    '报告必须保留以下四行原样的关联标记，本次执行需重新核对并更新报告：',
    `Submission: ${submissionId}`, `Input-SHA256: ${inputHash}`, 'Template-Version: 1',
    `Execution-Request: ${requestId}`,
    '', '报告包含三个独立标题：## 事实 / Facts、## 推测 / Hypotheses、## 待验证 / To verify。',
    '区分实际观察、推测和未完成事项；不能用自述代替真实工具回执。不得在报告中放凭据。',
    '不要为了证明报告完整而另开任务。报告完成后返回路径、实际动作、验证结果和剩余问题。'
  ]
  if (definition.templateId === 'component-performance') lines.push('报告另保留此行：Evidence-Source: user-provided-results')
  return lines.join('\n')
}

export function buildTaskPrompt(definition: TaskDefinition, submissionId: string, inputHash: string): string {
  const lines = [
    `任务：${definition.title}`, `目标：${definition.goal}`,
    `工作目录：${definition.workspace}`, `完成条件：${definition.acceptanceCriteria || '提交可核对的报告，由用户确认成果。'}`,
    '', taskReportInstructions(definition, submissionId, inputHash, `workbench:${submissionId}`)
  ]
  if (definition.templateId === 'component-performance') {
    const comparison = comparePerformanceInput(definition.performance)
    lines.push('', '模式：仅分析用户已提供的结果；不得运行或声称本任务运行了性能测试。',
      '请根据以下宿主确定性事实表解释现象、提出可能原因和可执行的后续验证建议。不要改写数字以迎合结论。',
      JSON.stringify({ input: definition.performance, comparison }, null, 2))
  }
  return lines.join('\n')
}
