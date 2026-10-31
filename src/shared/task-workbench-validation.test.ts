import { describe, expect, it } from 'vitest'
import { parseTaskDefinition, parseTaskWorkbenchRequest } from './task-workbench-validation'

const definition = { title: '性能分析', goal: '分析结果', workspace: 'D:/workspace/test', templateId: 'general',
  acceptanceCriteria: '报告区分事实与推测', resourceIds: [], approvalPolicy: 'auto-allow' }

describe('task workbench IPC validation', () => {
  it('accepts default approvals and clones nested input', () => {
    const source = { ...definition, resourceIds: ['test-environment'] }
    const result = parseTaskDefinition(source)!
    expect(result.approvalPolicy).toBe('auto-allow')
    result.resourceIds.push('another')
    expect(source.resourceIds).toEqual(['test-environment'])
  })

  it.each([
    { ...definition, owner: 'forged' }, { ...definition, workspace: '../relative' },
    { ...definition, resourceIds: ['a', 'a'] }, { ...definition, approvalPolicy: 'all' },
    { ...definition, goal: '\u0000' }, { ...definition, resourceIds: Array.from({ length: 17 }, (_, i) => String(i)) },
    { ...definition, resourceIds: new Array(1) }
  ])('rejects invalid definitions', value => expect(parseTaskDefinition(value)).toBeNull())

  it('requires exact edit revisions and opaque operation IDs', () => {
    expect(parseTaskWorkbenchRequest({ kind: 'save', definition, operationId: 'save-1' })).not.toBeNull()
    expect(parseTaskWorkbenchRequest({ kind: 'save', definition, operationId: 'save-2', entryId: 'entry' })).toBeNull()
    expect(parseTaskWorkbenchRequest({ kind: 'start', operationId: 'x', entryId: 'entry', expectedRevision: 0 })).toBeNull()
    expect(parseTaskWorkbenchRequest({ kind: 'cancel', operationId: 'x\n', submissionId: 'entry' })).toBeNull()
  })

  it('rejects forged control fields and arbitrary artifact paths', () => {
    expect(parseTaskWorkbenchRequest({ kind: 'list', owner: 'other' })).toBeNull()
    expect(parseTaskWorkbenchRequest({ kind: 'readArtifact', artifactId: 'id', path: 'C:/secret' })).toBeNull()
    expect(parseTaskWorkbenchRequest({ kind: 'recover', cleanup: true })).toBeNull()
    expect(parseTaskWorkbenchRequest({ kind: 'setQueueEnabled', operationId: 'x', enabled: true, maxActive: 9 })).toBeNull()
    expect(parseTaskWorkbenchRequest({ kind: '__proto__' })).toBeNull()
  })

  it('requires bounded finite performance data', () => {
    const performance = { component: 'api', baselineVersion: '1', currentVersion: '2', environment: 'test', workload: 'same',
      metrics: [{ name: 'latency', unit: 'ms', direction: 'lower', baseline: 10, current: 12, samples: 100, thresholdPercent: 5 }] }
    const source = { ...definition, templateId: 'component-performance', performance }
    expect(parseTaskDefinition(source)).not.toBeNull()
    for (const value of [NaN, Infinity, -1]) {
      expect(parseTaskDefinition({ ...source, performance: { ...performance, metrics: [{ ...performance.metrics[0], current: value }] } })).toBeNull()
    }
    expect(parseTaskDefinition({ ...source, performance: { ...performance, metrics: [{ ...performance.metrics[0], samples: 0 }] } })).toBeNull()
    expect(parseTaskDefinition({ ...source, performance: { ...performance, metrics: [performance.metrics[0], performance.metrics[0]] } })).toBeNull()
    expect(parseTaskDefinition({ ...source, performance: { ...performance, metrics: [performance.metrics[0], { ...performance.metrics[0], name: ' LATENCY ' }] } })).toBeNull()
    expect(parseTaskDefinition({ ...source, performance: { ...performance, metrics: new Array(1) } })).toBeNull()
  })
})
