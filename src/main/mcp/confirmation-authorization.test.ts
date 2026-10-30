import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionType } from '@shared/types'
import type { TokenBinding } from './auth'
import { scanDestructiveCommand } from './destructive-check'
import { EventEmitter } from 'events'
import { operationCapabilities, capabilityEnabled } from './operation-policy'
import { isLocalApiHost, RequestBudget } from './local-request'
import { allowsShutdownRelease } from './shutdown-request-policy'

const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
function script(names: string[]): string {
  return ts.transpileModule(names.map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!declaration) throw new Error(`${name} not found`)
    return declaration.getText(source)
  }).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

describe('MCP 确认期间的授权变化', () => {
  it('HTTP 请求绑定真实凭据检查，撤销后不能继续确认', () => {
    const credentials = new WeakMap<TokenBinding, () => boolean>()
    const binding: TokenBinding = { kind: 'global' }
    let valid = true
    const context = {
      URL, confirmationCredentials: credentials,
      isLocalApiHost, requestBudget: new RequestBudget(),
      allowsShutdownRelease, businessGate: { phase: 'running', accepts: () => true },
      pluginHostManager: { isDeactivatingPlugin: () => false },
      bindingCredentialIds: new WeakMap(),
      mcpAuth: { resolveToken: () => valid ? binding : null, credentialId: () => 'fixture-id' },
      getMcpSecuritySettings: () => ({ enabled: true, allowExternalMcpClients: true }),
      API_ROUTES: [], EXCLUSIVE_CONTROL_BASE: '/api/exclusive-control', sendJson: vi.fn(), uuidv4: () => 'fixture-request', recordDiagnosticEvent: vi.fn(),
      runWithRequestContext: (_context: unknown, action: () => unknown) => action()
    }
    const handler = runInNewContext(script(['handleRequest']) + '\nhandleRequest', context)
    handler({ url: '/api/tools', method: 'GET', headers: { host: '127.0.0.1:32123', 'x-lyshell-token': 'fixture-only' }, socket: { localPort: 32123 } }, Object.assign(new EventEmitter(), { setHeader: vi.fn() }))
    expect(credentials.get(binding)?.()).toBe(true)
    valid = false
    expect(credentials.get(binding)?.()).toBe(false)
  })

  it.each(['valid', 'revoked', 'disabled', 'external-disabled', 'capability-disabled', 'replaced', 'denied'] as const)('破坏性确认：%s', async change => {
    let valid = true, allowed = true
    const settings = { enabled: true, allowExternalMcpClients: true, allowLocalExecute: true }
    const session = { config: { name: 'target', type: ConnectionType.LOCAL } }
    let live = session
    const binding: TokenBinding = { kind: 'global' }
    const credentials = new WeakMap([[binding, () => valid]])
    const request = vi.fn(async (_content: unknown, current: () => boolean) => {
      if (change === 'revoked') valid = false
      if (change === 'disabled') settings.enabled = false
      if (change === 'external-disabled') settings.allowExternalMcpClients = false
      if (change === 'capability-disabled') settings.allowLocalExecute = false
      if (change === 'replaced') live = { ...session }
      if (change === 'denied') allowed = false
      return current()
    })
    const confirm = runInNewContext(script(['isMcpConfirmationAuthorized', 'confirmDestructiveIfNeeded']) + '\nconfirmDestructiveIfNeeded', {
      confirmationCredentials: credentials, getMcpSecuritySettings: () => settings,
      operationCapabilities, capabilityEnabled,
      ConnectionType, sessionManager: { getSession: () => live },
      isSessionAllowedForMcp: () => allowed, resolveRuntimeSessionId: (id: string) => id,
      scanDestructiveCommand, getSessionSummary: () => ({}), summarizeText: (text: string) => text,
      mcpRequestSource: () => 'fixture', t: (key: string) => key,
      requestMcpConfirmation: request, auditMcpOperation: vi.fn()
    })
    const result = await confirm('execute_command', 'reboot', 'target', binding)
    expect(result.allowed).toBe(change === 'valid')
    expect(request).toHaveBeenCalledOnce()
  })

  it('内部 session 不依赖外部权限，插件仍受其 capability 约束', () => {
    const session: TokenBinding = { kind: 'session' }
    const plugin: TokenBinding = { kind: 'plugin', capabilities: ['execute'] }
    const current = runInNewContext(script(['isMcpConfirmationAuthorized']) + '\nisMcpConfirmationAuthorized', {
      confirmationCredentials: new WeakMap([[session, () => true], [plugin, () => true]]),
      operationCapabilities, capabilityEnabled,
      getMcpSecuritySettings: () => ({ enabled: true, allowExternalMcpClients: false })
    })
    expect(current(session, 'localExecute')).toBe(true)
    expect(current(plugin, 'execute')).toBe(true)
    expect(current(plugin, 'localExecute')).toBe(false)
  })
})
