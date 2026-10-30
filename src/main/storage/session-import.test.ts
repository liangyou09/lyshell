import { describe, expect, it } from 'vitest'
import { SessionImportStaging } from './session-import'
import type { SessionConfig } from '@shared/types'
import { SECRET_PLACEHOLDER } from '@shared/harness'

describe('主进程导入暂存', () => {
  it('预览不泄露秘密，票据绑定窗口且只可消费一次', () => {
    const store = new SessionImportStaging()
    const input = { id: 'old', ssh: { host: 'fixture', password: 'fixture-secret' }, tags: [] } as unknown as SessionConfig
    const preview = store.stage('gui:1', [input])
    expect(preview.sessions[0].ssh?.password).toBe(SECRET_PLACEHOLDER)
    expect(JSON.stringify(preview)).not.toContain('fixture-secret')
    const ids = [preview.sessions[0].id]
    expect(() => store.take('gui:2', preview.token, ids)).toThrow(/expired/)
    expect(store.take('gui:1', preview.token, ids)[0]).toMatchObject({ id: '', ssh: { password: 'fixture-secret' } })
    expect(() => store.take('gui:1', preview.token, ids)).toThrow(/expired/)
    expect(input.id).toBe('old')
  })
  it('过期、伪造条目和超限均拒绝，替换预览使旧票据失效', () => {
    let now = 0
    const store = new SessionImportStaging(() => now)
    const first = store.stage('gui:1', [])
    expect(() => store.take('gui:1', first.token, ['unknown'])).toThrow(/selection/)
    const second = store.stage('gui:1', [])
    expect(() => store.take('gui:1', first.token, [])).toThrow(/expired/)
    now = 600_001
    expect(() => store.take('gui:1', second.token, [])).toThrow(/expired/)
    expect(() => store.stage('gui:1', Array(1025))).toThrow(/limit/)
    const third = store.stage('gui:1', [])
    store.forget('gui:1')
    expect(() => store.take('gui:1', third.token, [])).toThrow(/expired/)
  })
})
