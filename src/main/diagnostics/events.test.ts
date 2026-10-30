import { expect, it } from 'vitest'
import { diagnosticEvents, recordDiagnosticEvent, type DiagnosticEvent } from './events'

it('诊断默认不保留秘密、任务正文或异常对象，事件有界且快照不共享引用', () => {
  for (let i = 0; i < 300; i++) recordDiagnosticEvent({ at: i, requestId: `fixture-${i}`, operation: 'execute_command',
    source: 'http', outcome: 'completed', password: 'fixture-secret', prompt: 'fixture-prompt', error: { token: 'fixture-token' } } as DiagnosticEvent)
  const snapshot = diagnosticEvents()
  expect(snapshot).toHaveLength(256)
  const json = JSON.stringify(snapshot)
  for (const value of ['fixture-secret', 'fixture-prompt', 'fixture-token']) expect(json).not.toContain(value)
  snapshot[0].operation = 'mutated'
  expect(diagnosticEvents()[0].operation).toBe('execute_command')
})
