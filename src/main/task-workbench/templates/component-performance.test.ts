import { describe, expect, it } from 'vitest'
import type { PerformanceInput, TaskDefinition } from '@shared/task-workbench'
import { buildTaskPrompt, comparePerformanceInput, performanceFactsMarkdown } from './component-performance'

const input = (): PerformanceInput => ({
  component: 'serializer', baselineVersion: '1.0', currentVersion: '1.1', environment: 'test-host-A', workload: '100 concurrent requests',
  metrics: [
    { name: 'throughput', unit: 'ops/s', direction: 'higher', baseline: 1000, current: 900, samples: 20, thresholdPercent: 5 },
    { name: 'latency', unit: 'ms', direction: 'lower', baseline: 10, current: 12, samples: 20, thresholdPercent: 5 }
  ]
})

describe('component performance deterministic comparison', () => {
  it('计算吞吐量下降10%与延迟上升20%，回退不代表成果格式失败', () => {
    const result = comparePerformanceInput(input())
    expect(result.valid).toBe(true)
    expect(result.comparable).toBe(true)
    expect(result.metrics.map(metric => metric.changePercent)).toEqual([-10, 20])
    expect(result.metrics.every(metric => metric.regression)).toBe(true)
    expect(result.businessOutcome).toBe('regression')
    expect(result.checks.every(check => check.passed)).toBe(true)
  })

  it('尊重指标方向、阈值及精确边界，改善不触发回退', () => {
    const value = input()
    value.metrics[0].current = 1100
    value.metrics[1].current = 9
    expect(comparePerformanceInput(value).businessOutcome).toBe('normal')
    value.metrics[0].current = 950
    expect(comparePerformanceInput(value).metrics[0].regression).toBe(true)
    value.metrics[0].thresholdPercent = 5.1
    expect(comparePerformanceInput(value).metrics[0].regression).toBe(false)
  })

  it('零基线保留不可比较，不能伪造0%或无限回退', () => {
    const value = input()
    value.metrics[0].baseline = 0
    const result = comparePerformanceInput(value)
    expect(result.valid).toBe(true)
    expect(result.comparable).toBe(false)
    expect(result.metrics[0]).toMatchObject({ changePercent: null, adversePercent: null, regression: false })
    expect(result.businessOutcome).toBe('not-comparable')
  })

  it.each([NaN, Infinity, -Infinity])('拒绝非有限数值 %s', baseline => {
    const value = input()
    value.metrics[0].baseline = baseline
    expect(comparePerformanceInput(value).valid).toBe(false)
  })

  it('拒绝缺失比较条件、共同单位、非法样本及重复指标', () => {
    const noEnvironment = input(); noEnvironment.environment = ''
    const noUnit = input(); noUnit.metrics[0].unit = ''
    const noSamples = input(); noSamples.metrics[0].samples = 0
    const duplicate = input(); duplicate.metrics[1].name = 'Throughput'
    for (const value of [noEnvironment, noUnit, noSamples, duplicate]) expect(comparePerformanceInput(value).valid).toBe(false)
  })

  it('拒绝计算溢出，即使两个输入分别是有限数', () => {
    const value = input()
    value.metrics[0].baseline = Number.MIN_VALUE
    value.metrics[0].current = Number.MAX_VALUE
    expect(comparePerformanceInput(value).valid).toBe(false)
  })

  it('事实表清楚标记来源和百分比，不能声称本任务启动过测试', () => {
    const text = performanceFactsMarkdown(input())
    expect(text).toContain('-10.00%')
    expect(text).toContain('20.00%')
    expect(text).toContain('本任务只分析这些数据，没有启动测试')
    expect(text).toContain('用户声明')
  })

  it('supports environment descriptions throughout the public input limit', () => {
    const value = input()
    value.environment = 'a'.repeat(1000)
    value.workload = 'b'.repeat(1000)
    expect(comparePerformanceInput(value).valid).toBe(true)
  })

  it('提示词固定报告位置、输入关联和仅分析模式', () => {
    const definition: TaskDefinition = {
      title: '性能分析', goal: '比较已有结果', workspace: 'D:/tests', templateId: 'component-performance',
      acceptanceCriteria: '', resourceIds: [], approvalPolicy: 'manual', performance: input()
    }
    const text = buildTaskPrompt(definition, 'submission-1', 'a'.repeat(64))
    expect(text.replace(/\\/g, '/')).toContain('D:/tests/.lyshell-task-results/submission-1/report.md')
    expect(text).toContain(`Input-SHA256: ${'a'.repeat(64)}`)
    expect(text).toContain('Evidence-Source: user-provided-results')
    expect(text).toContain('不得运行或声称本任务运行了性能测试')
    expect(() => buildTaskPrompt(definition, '../escape', 'a'.repeat(64))).toThrow('identity')
  })
})
