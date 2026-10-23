import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import { appendAutoNewline, processInputEscapeSequences } from '@shared/escape-sequences'
import { scanDestructiveCommand } from './destructive-check'

// 执行真实 handler，确认检查与弹窗拿到的内容和终端实际解释的输入一致。
const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)

describe.each(['handleSendInput', 'handleSendAndWait'])('%s 转义后的确认内容', name => {
  it.each(['echo hi\\nreboot', 'echo hi\\rreboot', 'echo hi\\x0areboot', '\\x72eboot', 'echo hi\\x03reboot', "echo 'hi\\x03reboot'"])('危险输入 %s 必须经过确认，拒绝时不能发送', async text => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!declaration) throw new Error(`${name} not found`)
    const script = ts.transpileModule(`(${declaration.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const session = { config: { type: ConnectionType.SSH }, status: ConnectionStatus.CONNECTED }
    const write = vi.fn()
    const authorize = vi.fn(async () => ({ allowed: true }))
    const confirm = vi.fn(async (_operation: string, content: string) => {
      expect(scanDestructiveCommand(content).map(match => match.name)).toContain('shutdown-reboot')
      return { allowed: false, reason: 'denied' }
    })
    const sendJson = vi.fn()
    const handler = runInNewContext(script, {
      process, ConnectionType, ConnectionStatus, MAX_TEXT_LENGTH: 1024 * 1024,
      sessionManager: { getSession: () => session, lockSessionForMcp: write, writeToSession: write, sendAndWait: write },
      resolveRuntimeSessionId: (id: string) => id, summarizeText: (value: string) => value,
      appendAutoNewline, processInputEscapeSequences, authorizeMcpOperation: authorize,
      confirmDestructiveIfNeeded: confirm, sendJson, log: { error: vi.fn() }
    }) as (data: { sessionId: string; text: string }, res: unknown, binding: unknown) => Promise<void>
    const binding = { kind: 'session' }
    await handler({ sessionId: 'target', text }, {}, binding)
    const actual = appendAutoNewline(processInputEscapeSequences(text), true)
    expect(authorize.mock.calls[0].at(-1)).toBe(actual)
    expect(confirm).toHaveBeenCalledWith(expect.any(String), actual, 'target', binding)
    expect(sendJson).toHaveBeenCalledWith({}, 403, { success: false, error: 'denied' })
    expect(write).not.toHaveBeenCalled()
  })
})
