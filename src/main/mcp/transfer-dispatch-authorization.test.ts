import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import { OperationError } from '@shared/operation'

const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)

describe('HTTP 传输派发时重新验证授权和连接归属', () => {
  it.each(['download', 'upload'] as const)('实际 %s handler 把服务端授权闭包传入 Worker 队列', async direction => {
    const name = direction === 'download' ? 'handleDownloadFile' : 'handleUploadFile'
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!declaration) throw new Error('Transfer handler missing')
    const script = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const session = { config: { type: ConnectionType.SSH, ssh: { host: 'fixture', port: 22, username: 'test' } },
      status: ConnectionStatus.CONNECTED, connector: {}, connectionInstanceId: 'first' }
    let live = session
    let authorized = true
    let allowed = true
    const dispatch = vi.fn(async (_task: unknown, current: () => boolean) => {
      expect(current).toBeTypeOf('function')
      expect(current()).toBe(true)
      authorized = false
      expect(current()).toBe(false)
      authorized = true; allowed = false
      expect(current()).toBe(false)
      allowed = true; live = { ...session }
      expect(current()).toBe(false)
      live = session; session.connectionInstanceId = 'replaced'
      expect(current()).toBe(false)
      throw new OperationError('FORBIDDEN', 'Authorization changed while queued')
    })
    const sendJson = vi.fn()
    const handler = runInNewContext(`${script}\n${name}`, {
      path, fs: { statSync: () => ({ size: 1 }) }, OperationError, ConnectionType, ConnectionStatus,
      resolveRuntimeSessionId: (id: string) => id, sessionManager: { getSession: () => live },
      downloadHistory: { getDownloadDir: () => 'C:/fixture' }, assertSafeLocalPath: (p: string) => p,
      authorizeMcpOperation: async () => ({ allowed: true }), isMcpConfirmationAuthorized: () => authorized,
      isSessionAllowedForMcp: () => allowed, uuidv4: () => 'transfer-task',
      fileManager: { stat: async () => ({ size: 1 }), getConnectorType: async () => 'sftp' },
      runUploadWorkerAndWait: dispatch, runDownloadWorkerAndWait: dispatch, sendJson, log: { warn: vi.fn() }
    }) as (data: unknown, res: unknown, binding: unknown) => Promise<void>
    await handler({ sessionId: 'target', localPath: 'fixture.txt', remotePath: '/fixture.txt' }, {}, {})
    expect(dispatch).toHaveBeenCalledOnce()
    expect(sendJson.mock.calls.at(-1)?.[1]).toBe(403)
  })
})
