import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
import ts from 'typescript'
import type { Client, ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import { OperationError } from '@shared/operation'
import { SSHCommandExecutor } from '../file/ssh-command-executor'
import { SSHCommandShell } from '../file/ssh-command-shell'
import { CommandService } from '../commands/command-service'
import type { CommandExecutionHandle, ResourceCloseResult } from '../commands/types'
import type { SSHFileClient } from '../file/ssh-file-client'
import type { TokenBinding } from './auth'
import { capabilityEnabled, operationCapabilities } from './operation-policy'

const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const names = ['commandDispatchGuard', 'isMcpConfirmationAuthorized', 'authorizeMcpOperation', 'confirmDestructiveIfNeeded',
  'commandCaller', 'scheduledCommandTarget', 'retainCommandResponse', 'sendCommandFailure', 'sendOperationError',
  'handleExecuteCommand', 'handleExecuteCommandStream', 'handleRunOnSessions']
// 修复前也运行同一行为用例，缺少新 helper 时仍执行原 handler 复现缺陷。
const script = ts.transpileModule(names.flatMap(name => {
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
  if (!node && name !== 'commandDispatchGuard') throw new Error(`Missing ${name}`)
  return node ? [node.getText(source)] : []
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

const services: CommandService[] = []
afterEach(() => {
  for (const service of services) {
    expect(service.scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, unconfirmed: 0 })
    expect(service.budget.retainedBytes).toBe(0)
    expect(service.budget.sendBytes).toBe(0)
  }
  services.length = 0
})

function fixture(type = ConnectionType.SSH, exitCode: number | null = 7, shell = false) {
  const stream = new EventEmitter() as ClientChannel
  Object.assign(stream, {
    stderr: new EventEmitter(), destroy: vi.fn(() => stream.emit('close')),
    write: vi.fn((text: string) => {
      const marker = text.match(/(___END_MARKER_UUID_[\w-]+___):%s/)?.[1]
      if (marker) queueMicrotask(() => stream.emit('data', Buffer.from(`fixture\n${marker}:${exitCode}\n`)))
      return true
    })
  })
  const exec = vi.fn((_text, callback) => {
    callback(undefined, stream)
    queueMicrotask(() => { stream.emit('data', Buffer.from('fixture')); stream.emit('exit', exitCode); stream.emit('close') })
  })
  const client = { exec, shell: vi.fn(callback => callback(undefined, stream)) }
  const getClient = vi.fn(async () => client as unknown as Client)
  const file = { getClient } as unknown as SSHFileClient
  const connector = shell ? new SSHCommandShell(file, 'enter') : new SSHCommandExecutor(file)
  const session = { config: { type, name: 'private-target', local: {} }, status: ConnectionStatus.CONNECTED,
    connector: {}, connectionInstanceId: 'first' }
  let live: typeof session | undefined = session
  const state = { valid: true, allowed: true }
  const settings = { enabled: true, allowExternalMcpClients: true, allowRead: true, allowSshExecute: true, allowLocalExecute: true,
    requireConfirmation: false, confirmDestructiveCommands: false, deniedSessionIds: [] as string[] }
  const binding: TokenBinding = { kind: 'global' }
  const responses: Array<{ status: number; body: { success: boolean; data?: Record<string, unknown> } }> = []
  const sse: Array<{ type: string; exitCode?: number }> = []
  const confirm = vi.fn(async (_request, current: () => boolean) => current())
  const getConnector = vi.fn(async () => connector)
  const local = vi.fn(async (_options?: unknown) => ({ output: 'fixture', exitCode }))
  let localClose: Promise<ResourceCloseResult> | undefined
  const commandService = new CommandService()
  services.push(commandService)
  const createLocalCommandExecution = (options: { reserveBytes: (bytes: number) => void; onData?: (chunk: string) => void }): CommandExecutionHandle => {
    const result = local(options).then(result => {
      options.reserveBytes(Buffer.byteLength(result.output))
      options.onData?.(result.output)
      return { ...result, exitCode: result.exitCode ?? -1 }
    })
    const closed: ResourceCloseResult = { state: 'closed', localClosed: true, remoteTerminated: 'confirmed' }
    return { result, resourceClosed: localClose ?? result.then(() => closed, () => closed), cancel: vi.fn() }
  }
  const context = {
    ConnectionStatus, ConnectionType, OperationError, operationCapabilities, capabilityEnabled,
    commandService, businessGate: { phase: 'running', accepts: () => true },
    bindingCredentialIds: new WeakMap([[binding, 'fixture-caller']]), uuidv4: randomUUID,
    MAX_TEXT_LENGTH: 1024 * 1024, MAX_COMMAND_TIMEOUT_MS: 300000,
    confirmationCredentials: new WeakMap([[binding, () => state.valid]]), getMcpSecuritySettings: () => settings,
    sessionManager: { getSession: (id: string) => id === 'target' ? live : undefined },
    isSessionAllowedForMcp: () => state.allowed, resolveRuntimeSessionId: (id: string) => id === 'saved' ? 'target' : id,
    getSessionSummary: () => ({}), auditMcpOperation: vi.fn(), summarizeText: (text: string) => text,
    mcpRequestSource: () => 'fixture', t: (key: string) => key, requestMcpConfirmation: confirm, scanDestructiveCommand: (): Array<{ name: string }> => [],
    log: { error: vi.fn() }, clampNumber: (value: number) => value,
    sendJson: (res: EventEmitter & { end: () => void }, status: number, body: typeof responses[number]['body']) => {
      responses.push({ status, body }); res.end()
    },
    CommandStreamWriter: class {
      constructor(private res: EventEmitter & { end: () => void }) {}
      chunk() {}
      async finish(event: typeof sse[number]) { sse.push(event); this.res.end() }
    }, AbortController,
    fileManager: { getCommandConnector: getConnector }, createLocalCommandExecution
  }
  const api = runInNewContext(script + '\n({handleExecuteCommand,handleExecuteCommandStream,handleRunOnSessions})', context)
  const response = () => {
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, headersSent: false,
      writeHead: vi.fn(), end: vi.fn(), write: vi.fn(() => true)
    })
    res.writeHead.mockImplementation(() => { res.headersSent = true; return res })
    res.end.mockImplementation(() => { res.writableEnded = true; res.emit('finish'); return res })
    return res
  }
  return { api, response, state, settings, binding, session, responses, sse, exec, client, stream, getConnector, getClient,
    local, connector, confirm, context, commandService,
    deferLocalClose: (close: Promise<ResourceCloseResult>) => { localClose = close },
    replace: () => { live = { ...session } }, remove: () => { live = undefined } }
}

describe('HTTP 独立命令最终派发与资源身份', () => {
  it.each([false, true])('真实 SSH 执行器在 getClient 等待后撤权仍不派发（shell=%s）', async shell => {
    const f = fixture(ConnectionType.SSH, 0, shell)
    f.getClient.mockImplementation(async () => {
      await Promise.resolve()
      f.state.valid = false
      return f.client as unknown as Client
    })
    await f.api.handleExecuteCommand({ sessionId: 'target', command: 'fixture' }, f.response(), f.binding)
    expect(f.getClient).toHaveBeenCalledOnce()
    expect(f.exec).not.toHaveBeenCalled()
    expect(f.client.shell).not.toHaveBeenCalled()
    expect(f.stream.write).not.toHaveBeenCalled()
  })

  it('HTTP response 先 close 不归还仍待真实资源关闭的执行位', async () => {
    const f = fixture(ConnectionType.LOCAL, 0)
    let close!: (value: ResourceCloseResult) => void
    f.deferLocalClose(new Promise(resolve => { close = resolve }))
    const res = f.response()
    const request = f.api.handleExecuteCommand({ sessionId: 'target', command: 'fixture' }, res, f.binding)
    await vi.waitFor(() => expect(f.local).toHaveBeenCalledOnce())
    expect(f.commandService.scheduler.snapshot().active).toBe(1)
    expect(f.commandService.budget.retainedBytes).toBeGreaterThan(0)
    res.destroyed = true
    res.emit('close')
    await Promise.resolve()
    expect(f.commandService.scheduler.snapshot().active).toBe(1)
    close({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
    await request
    expect(f.commandService.scheduler.snapshot().active).toBe(0)
    expect(f.commandService.budget.retainedBytes).toBe(0)
    expect(f.commandService.budget.sendBytes).toBe(0)
  })

  it('批量破坏性确认通过后目标换代，不能将原批准用于新连接', async () => {
    const f = fixture()
    f.settings.confirmDestructiveCommands = true
    f.context.scanDestructiveCommand = () => [{ name: 'fixture' }]
    f.confirm.mockImplementation(async (_request, current) => {
      expect(current()).toBe(true)
      queueMicrotask(() => f.replace())
      return true
    })
    await f.api.handleRunOnSessions({ sessionIds: ['target'], command: 'reboot' }, f.response(), f.binding)
    expect(f.exec).not.toHaveBeenCalled()
  })

  it.each(['handleExecuteCommand', 'handleExecuteCommandStream', 'handleRunOnSessions'])('%s 在 connector 等待后复核全部撤权条件', async handler => {
    for (const change of ['credential', 'capability', 'disabled', 'external', 'denied', 'session', 'connector', 'connection', 'type', 'disconnected']) {
      const f = fixture()
      f.getConnector.mockImplementation(async () => {
        await Promise.resolve()
        if (change === 'credential') f.state.valid = false
        if (change === 'capability') f.settings.allowSshExecute = false
        if (change === 'disabled') f.settings.enabled = false
        if (change === 'external') f.settings.allowExternalMcpClients = false
        if (change === 'denied') f.state.allowed = false
        if (change === 'session') f.replace()
        if (change === 'connector') f.session.connector = {}
        if (change === 'connection') f.session.connectionInstanceId = 'new'
        if (change === 'type') f.session.config.type = ConnectionType.LOCAL
        if (change === 'disconnected') f.session.status = ConnectionStatus.DISCONNECTED
        return f.connector
      })
      const data = handler === 'handleRunOnSessions' ? { sessionIds: ['target'], command: 'fixture' } : { sessionId: 'target', command: 'fixture' }
      await f.api[handler](data, f.response(), f.binding)
      expect(f.exec, change).not.toHaveBeenCalled()
      expect(f.local, change).not.toHaveBeenCalled()
      expect(f.sse.find(e => e.type === 'done'), change).toBeUndefined()
    }
  })

  it.each([0, 7, null])('单条与批量 exec 保留真实 SSH exit %s', async code => {
    for (const handler of ['handleExecuteCommand', 'handleExecuteCommandStream', 'handleRunOnSessions']) {
      const f = fixture(ConnectionType.SSH, code)
      await f.api[handler](handler === 'handleRunOnSessions' ? { sessionIds: ['target'], command: 'fixture' } : { sessionId: 'target', command: 'fixture' }, f.response(), f.binding)
      const data = f.responses[0]?.body.data
      const actual = handler === 'handleRunOnSessions' ? (data?.results as Array<{ exitCode: number }>)[0].exitCode
        : handler === 'handleExecuteCommand' ? data?.exitCode : f.sse.find(e => e.type === 'done')?.exitCode
      expect(actual).toBe(code ?? -1)
      expect(f.exec).toHaveBeenCalledOnce()
    }
  })

  it.each([0, 7])('批量持久 shell 保留 exit %s，LOCAL 同样保留其结果', async code => {
    const ssh = fixture(ConnectionType.SSH, code, true)
    await ssh.api.handleRunOnSessions({ sessionIds: ['target'], command: 'fixture' }, ssh.response(), ssh.binding)
    expect((ssh.responses[0].body.data?.results as Array<{ exitCode: number }>)[0].exitCode).toBe(code)
    await (ssh.connector as SSHCommandShell).cleanup()
    const local = fixture(ConnectionType.LOCAL, code)
    await local.api.handleRunOnSessions({ sessionIds: ['target'], command: 'fixture' }, local.response(), local.binding)
    expect((local.responses[0].body.data?.results as Array<{ exitCode: number }>)[0].exitCode).toBe(code)
  })
})

describe('批量 dryRun 可见性与执行资格', () => {
  it('多目标预览在等待全部授权结束后再次过滤已撤权的早期结果', async () => {
    const f = fixture()
    let audited = 0
    f.context.auditMcpOperation.mockImplementation(() => {
      if (++audited === 2) queueMicrotask(() => { f.state.valid = false })
    })
    await f.api.handleRunOnSessions({ sessionIds: ['target', 'target'], command: 'fixture', dryRun: true }, f.response(), f.binding)
    expect(JSON.stringify(f.responses)).not.toContain('private-target')
    expect(f.exec).not.toHaveBeenCalled()
  })

  it.each(['no-capability', 'denied', 'other-local', 'external-disabled', 'read-disabled', 'missing', 'revoked'])('%s 不返回存在性或元信息', async change => {
    const f = fixture(ConnectionType.LOCAL)
    if (change === 'no-capability') { f.binding.kind = 'plugin'; f.binding.capabilities = [] }
    if (change === 'denied') f.state.allowed = false
    if (change === 'other-local') { f.binding.kind = 'session'; f.binding.originSessionId = 'other' }
    if (change === 'external-disabled') f.settings.allowExternalMcpClients = false
    if (change === 'read-disabled') f.settings.allowRead = false
    if (change === 'missing') f.remove()
    if (change === 'revoked') f.state.valid = false
    await f.api.handleRunOnSessions({ sessionIds: ['target'], command: 'reboot', dryRun: true }, f.response(), f.binding)
    const target = (f.responses[0].body.data?.targets as Array<Record<string, unknown>>)[0]
    expect(target).toEqual({ sessionId: 'target', wouldExecute: false, error: 'Target unavailable or not authorized' })
    expect(JSON.stringify(f.responses)).not.toContain('private-target')
    expect(f.getConnector).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it.each([true, false])('可见目标仅在当前执行权限为 %s 时 wouldExecute', async canExecute => {
    const f = fixture()
    f.settings.allowSshExecute = canExecute
    await f.api.handleRunOnSessions({ sessionIds: ['saved'], command: 'reboot', dryRun: true }, f.response(), f.binding)
    expect((f.responses[0].body.data?.targets as unknown[])[0]).toEqual({ sessionId: 'saved', sessionName: 'private-target',
      sessionType: ConnectionType.SSH, status: ConnectionStatus.CONNECTED, wouldExecute: canExecute })
    expect(f.getConnector).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
})
