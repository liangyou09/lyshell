import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { publicSessionConfig } from '../storage/session-secrets'
import { SECRET_PLACEHOLDER } from '@shared/harness'
import { ConnectionType, type SessionConfig } from '@shared/types'

// 执行实际 IPC 回调：验证 renderer 的去重回执也遵守会话 DTO 秘密边界。
it('会话去重回执只返回公开 DTO，不能带出密码、私钥或口令', async () => {
  const source = ts.createSourceFile('handlers.ts', readFileSync(join(process.cwd(), 'src/main/ipc/handlers.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'applicationIpc.handle'
      && node.arguments[0]?.getText(source) === 'IPC_CHANNELS.SESSION_DEDUPLICATE') callback = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error('Session deduplicate handler not found')
  const config = { id: 'kept', type: ConnectionType.SSH, tags: [],
    ssh: { host: 'example.test', port: 22, username: 'user', password: 'fixture-password', privateKey: 'fixture-private-key', passphrase: 'fixture-passphrase' }
  } as unknown as SessionConfig
  const pub = publicSessionConfig(config)
  const handler = runInNewContext(ts.transpileModule(`(${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    sessionRepository: { deduplicate: () => ({ removed: 1, kept: [config] }), getPublic: (id: string) => id === config.id ? pub : null },
    syncReachabilityTargets: vi.fn(), log: { info: vi.fn() }
  }) as () => Promise<{ removed: number; kept: SessionConfig[] }>
  const result = await handler()
  expect(result.removed).toBe(1)
  expect(result.kept[0].ssh?.password).toBe(SECRET_PLACEHOLDER)
  expect(result.kept[0].ssh?.privateKey).toBe(SECRET_PLACEHOLDER)
  expect(result.kept[0].ssh?.passphrase).toBe(SECRET_PLACEHOLDER)
  expect(JSON.stringify(result)).not.toContain('fixture-')
})
