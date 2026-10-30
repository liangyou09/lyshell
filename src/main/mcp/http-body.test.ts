import { EventEmitter } from 'events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// 执行产品里的真实 readBody；不启动共享 Electron/API 服务。
const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readBody')!
const script = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const fixture = () => runInNewContext(`let pendingBodyBytes = 0; const MAX_PENDING_BODY_BYTES = 8; ${script}; ({ readBody, bytes: () => pendingBodyBytes })`, { Buffer }) as {
  readBody: (request: EventEmitter, maxSize?: number) => Promise<string>; bytes: () => number
}
const request = () => Object.assign(new EventEmitter(), { resume: vi.fn() })

describe('HTTP 请求体内存与断连', () => {
  it('真实回环请求中断后依次 aborted/error/close，预算释放且 error 始终有处理器', async () => {
    const f = fixture()
    const events: string[] = []
    let handlersAtError = 0
    let received!: () => void
    const dataReceived = new Promise<void>(resolve => { received = resolve })
    let closed!: () => void
    const requestClosed = new Promise<void>(resolve => { closed = resolve })
    let reading: Promise<string> | undefined
    const server = createServer(req => {
      req.on('aborted', () => events.push('aborted'))
      req.on('error', () => { events.push('error'); handlersAtError = req.listenerCount('error') })
      req.on('close', () => { events.push('close'); closed() })
      req.once('data', () => received())
      reading = f.readBody(req)
      void reading.catch(() => {})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    const socket = connect(address.port, '127.0.0.1')
    try {
      socket.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\nConnection: close\r\n\r\na')
      await dataReceived
      socket.destroy()
      await requestClosed
      await expect(reading).rejects.toThrow(/aborted/)
      expect(events).toEqual(['aborted', 'error', 'close'])
      expect(handlersAtError).toBe(2)
      expect(f.bytes()).toBe(0)
    } finally {
      socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('中断释放全局额度，后续请求可继续读取', async () => {
    const f = fixture(), first = request(), second = request()
    const aborted = f.readBody(first)
    const failure = expect(aborted).rejects.toThrow(/aborted/)
    first.emit('data', Buffer.from('123456'))
    expect(f.bytes()).toBe(6)
    first.emit('aborted')
    await failure
    expect(f.bytes()).toBe(0)
    // IncomingMessage 中断时先 aborted、再 error、最后 close；不能在 aborted 中摘掉唯一 error 监听。
    expect(() => first.emit('error', new Error('aborted socket'))).not.toThrow()
    first.emit('close')
    expect(first.listenerCount('error')).toBe(0)
    const next = f.readBody(second)
    second.emit('data', Buffer.from('abcdefgh')); second.emit('end')
    await expect(next).resolves.toBe('abcdefgh')
    expect(f.bytes()).toBe(0)
    expect(first.listenerCount('data')).toBe(0)
  })
  it('多请求共用预算，超限只释放本请求，结束与错误均不重复扣减', async () => {
    const f = fixture(), first = request(), second = request()
    const a = f.readBody(first), b = f.readBody(second)
    const failure = expect(b).rejects.toThrow(/budget exceeded/)
    first.emit('data', Buffer.from('123456'))
    second.emit('data', Buffer.from('78'))
    second.emit('data', Buffer.from('9'))
    await failure
    expect(second.resume).toHaveBeenCalledOnce()
    expect(f.bytes()).toBe(6)
    second.emit('end')
    first.emit('end')
    await expect(a).resolves.toBe('123456')
    expect(f.bytes()).toBe(0)
  })
  it('单请求大小与读取错误均拒绝并清空缓冲', async () => {
    const f = fixture(), req = request()
    const result = f.readBody(req, 2)
    const failure = expect(result).rejects.toThrow(/budget exceeded/)
    req.emit('data', Buffer.from('abc'))
    await failure
    const broken = request(), next = f.readBody(broken)
    const error = expect(next).rejects.toThrow('fixture')
    broken.emit('data', Buffer.from('ab')); broken.emit('error', new Error('fixture'))
    await error
    expect(f.bytes()).toBe(0)
  })
})
