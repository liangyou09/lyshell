import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { LyShellHttpClient } from './http-client'
import { LyShellApiError } from './api-error'

const servers: Server[] = []
const failure = {
  success: false,
  error: 'Wait pattern matching exceeded the execution deadline',
  code: 'RESOURCE_LIMIT',
  retryDisposition: 'never',
  reason: 'MATCH_EXECUTION_TIMEOUT',
  requestId: 'fixture-request-1'
}

async function fixture(mode: 'json' | 'stream-status' | 'stream-event'): Promise<LyShellHttpClient> {
  const server = createServer((request, response) => {
    request.resume()
    expect(request.headers['x-lyshell-token']).toBe('fixture-token')
    if (mode === 'stream-event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"type":"chunk","chunk":"partial"}\n\n')
      response.end(`data: ${JSON.stringify({ ...failure, type: 'error' })}\n\n`)
    } else {
      response.writeHead(429, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(failure))
    }
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return new LyShellHttpClient(address.port, 'fixture-token')
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

describe('MCP HTTP 客户端保留结构化失败事实', () => {
  it.each(['json', 'stream-status', 'stream-event'] as const)('%s 保留 code/retry/reason/requestId，部分 chunk 不冒充完整结果', async mode => {
    const client = await fixture(mode)
    const chunks: string[] = []
    const result = mode === 'json' ? client.post('/api/wait-for-prompt', {})
      : client.postStream('/api/execute-command', {}, event => { if (event.chunk) chunks.push(event.chunk) })
    const error = await result.then(() => { throw new Error('Expected rejection') }, error => error)
    expect(error).toBeInstanceOf(LyShellApiError)
    expect(error.message).toBe(failure.error)
    expect(error.details()).toEqual({
      code: failure.code,
      retryDisposition: failure.retryDisposition,
      requestId: failure.requestId,
      reason: failure.reason
    })
    expect(chunks).toEqual(mode === 'stream-event' ? ['partial'] : [])
  })
})
