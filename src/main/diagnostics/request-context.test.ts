import { describe, expect, it } from 'vitest'
import { currentRequestContext, runWithRequestContext } from './request-context'

describe('跨异步调用的请求关联', () => {
  it('并发请求经过微任务和定时器后仍保留自己的请求ID，不污染外层', async () => {
    const results = await Promise.all(['a', 'b'].map(requestId => runWithRequestContext({ requestId,
      principalId: 'fixture', source: 'http', receivedAt: Date.now() }, async () => {
      await new Promise(resolve => setTimeout(resolve, 2))
      return currentRequestContext()?.requestId
    })))
    expect(results).toEqual(['a', 'b'])
    expect(currentRequestContext()).toBeUndefined()
  })
})
