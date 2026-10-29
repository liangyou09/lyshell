import { describe, expect, it } from 'vitest'
import { readHarnessRecoveredEvent } from './harness-recovery'
describe('恢复推送边界', () => {
  it('只保留可信字段，拒绝凭据 URL 和非回环地址', () => {
    const identity = { instanceId: 'backend', instanceEpoch: 1, privateField: 'must-not-leak' }
    const valid = { identity, cwd: 'D:/work', url: 'http://127.0.0.1:3000' }
    expect(readHarnessRecoveredEvent(valid)).toEqual({ ...valid, identity: { instanceId: 'backend', instanceEpoch: 1 } })
    for (const url of ['https://external.example', 'http://127.0.0.1:3000/?token=x', 'http://user:pass@127.0.0.1:3000', 'file:///a', 'http://localhost:3000']) {
      expect(readHarnessRecoveredEvent({ ...valid, url })).toBeNull()
    }
  })
})
