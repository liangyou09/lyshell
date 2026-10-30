import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SECRET_PLACEHOLDER, isSecretEnvKey } from '@shared/harness'
import { ConnectionType, type LocalConfig, type SessionConfig, type SessionPublicConfig } from '@shared/types'
import { assertNoSecretPlaceholders, hydrateSessionSecrets, publicSessionConfig } from '../storage/session-secrets'
import { SessionImportStaging } from '../storage/session-import'

// handlers.ts 在模块顶层 import electron / 原生模块。这里只抽取「数据导出导入」段
// 的真实源码，注入最小 IO 依赖后执行，覆盖真实 handler + 真实 AES-GCM + 真实秘密 hydration。
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('unused test cipher') },
    decryptString: () => { throw new Error('unused test cipher') }
  }
}))

import { assertResolvedSecrets } from '../storage/secret-store'

const REF_CUSTOM = `sec_${'c'.repeat(32)}`
const REF_API = `sec_${'a'.repeat(32)}`
const REF_OTHER = `sec_${'d'.repeat(32)}`
const PASSWORD = 'fixture-export-password'

const CUSTOM_SECRET = 'custom-real-value'
const API_SECRET = 'sk-real-key'
const TOKEN_SECRET = 'ghp-real-token'
const SSH_PASSWORD = 'ssh-password-real'
const SSH_PRIVATE_KEY = 'ssh-private-key-real'
const SSH_PASSPHRASE = 'ssh-passphrase-real'

const handlersSource = ts.createSourceFile(
  'handlers.ts',
  readFileSync(join(process.cwd(), 'src/main/ipc/handlers.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

/** 从真实 handlers.ts 抽取加密导出/导入相关段落（不含外层 import）。 */
function extractExportImportSection(): string {
  let start = -1
  let end = -1
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(declaration => declaration.name.getText(handlersSource) === 'encryptField')
    ) {
      start = node.getStart(handlersSource)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(handlersSource) === 'applicationIpc.handle' &&
      node.arguments[0]?.getText(handlersSource) === 'IPC_CHANNELS.DATA_IMPORT'
    ) {
      end = node.getEnd()
    }
    ts.forEachChild(node, visit)
  }
  visit(handlersSource)
  if (start < 0 || end <= start) throw new Error('handlers.ts export/import section not found')
  return handlersSource.text.slice(start, end)
}

const injectedNames = [
  'randomBytes', 'scryptSync', 'createCipheriv', 'createDecipheriv',
  'log', 'dialog', 'writeFile', 'readFile', 'fs',
  'sessionRepository', 'sessionManager',
  'isSecretEnvKey', 'structuredClone', 'hydrateSessionSecrets',
  'assertNoSecretPlaceholders', 'assertResolvedSecrets',
  'IPC_CHANNELS', 'applicationIpc', 'sessionImports', 'applicationCallers',
  'importWindows', 'validateSessionImportCommit', 'validateSshPersistence',
  'syncReachabilityTargets', 'broadcastSessionsChanged'
] as const

const createSection = new Function(
  ...injectedNames,
  `"use strict";\n${ts.transpileModule(extractExportImportSection(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText}`
)

type ExportHandler = (
  event: unknown,
  data: { sessions: SessionConfig[]; quickCommands: unknown[]; encryptPassword?: string }
) => Promise<{ success: boolean; path?: string; encrypted?: boolean; message?: string }>

type ImportHandler = (
  event: unknown,
  password?: string,
  existingPath?: string
) => Promise<{
  success: boolean
  message?: string
  encrypted?: boolean
  importToken?: string
  data?: { sessions: SessionPublicConfig[] }
}>

type PreviousSource = 'saved' | 'runtime'

interface Harness {
  exportHandler: ExportHandler
  importHandler: ImportHandler
  staging: SessionImportStaging
}

function createHarness(options: {
  previous: SessionConfig[]
  previousSource: PreviousSource
  savePath: string
}): Harness {
  const handlers = new Map<string, unknown>()
  const previousById = new Map(options.previous.map(session => [session.id, session]))
  const staging = new SessionImportStaging()
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const dialog = {
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: options.savePath })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
  }

  createSection(
    randomBytes, scryptSync, createCipheriv, createDecipheriv,
    log, dialog, writeFile, readFile, fs,
    {
      get: (id: string) => (options.previousSource === 'saved' ? previousById.get(id) ?? null : null)
    },
    {
      getSession: (id: string) => {
        if (options.previousSource !== 'runtime') return null
        const config = previousById.get(id)
        return config ? { config } : null
      }
    },
    isSecretEnvKey, structuredClone, hydrateSessionSecrets,
    assertNoSecretPlaceholders, assertResolvedSecrets,
    { DATA_EXPORT: 'data:export', DATA_IMPORT: 'data:import' },
    { handle: (channel: string, listener: unknown) => { handlers.set(channel, listener) } },
    staging,
    { context: () => ({ principalId: 'test-principal' }) },
    new WeakSet<object>(),
    () => ({}),
    () => undefined,
    () => undefined,
    () => undefined
  )

  const exportHandler = handlers.get('data:export') as ExportHandler | undefined
  const importHandler = handlers.get('data:import') as ImportHandler | undefined
  if (typeof exportHandler !== 'function' || typeof importHandler !== 'function') {
    throw new Error('data:export / data:import handlers not found')
  }
  return { exportHandler, importHandler, staging }
}

const testEvent = { sender: { id: 1, once: () => {} } }

function localRecord(localOverrides: Partial<LocalConfig> = {}): SessionConfig {
  return {
    id: 'local-record',
    name: 'Local record',
    type: ConnectionType.LOCAL,
    local: {
      shell: 'bash',
      env: {
        PATH: '/usr/bin',
        CUSTOM_OPTION: CUSTOM_SECRET,
        OPENAI_API_KEY: API_SECRET,
        GITHUB_TOKEN: TOKEN_SECRET,
        EMPTY_VALUE: ''
      },
      // 历史记录：refs 已把 CUSTOM_OPTION 归类为秘密，但 secretEnvKeys 已被清空。
      envSecretRefs: { CUSTOM_OPTION: REF_CUSTOM, OPENAI_API_KEY: REF_API },
      ...localOverrides
    },
    tags: [],
    createdAt: new Date(0),
    updatedAt: new Date(0)
  } as unknown as SessionConfig
}

function sshRecord(): SessionConfig {
  return {
    id: 'ssh-record',
    name: 'SSH record',
    type: ConnectionType.SSH,
    ssh: {
      host: 'example.test',
      port: 22,
      username: 'user',
      password: SSH_PASSWORD,
      privateKey: SSH_PRIVATE_KEY,
      passphrase: SSH_PASSPHRASE
    },
    tags: [],
    createdAt: new Date(0),
    updatedAt: new Date(0)
  } as unknown as SessionConfig
}

/** 渲染层导出入口拿到的是公开 DTO：秘密值只有占位符，引用元数据仍在。 */
function publicDtos(previous: SessionConfig[]): SessionConfig[] {
  return previous.map(session => publicSessionConfig(session) as unknown as SessionConfig)
}

function readExport(filePath: string): {
  text: string
  parsed: {
    version: string
    encrypted: boolean
    sessions: Array<Record<string, any>>
  }
} {
  const text = readFileSync(filePath, 'utf-8')
  return { text, parsed: JSON.parse(text) }
}

let workDir = ''

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lyshell-f08-export-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('加密导出不得把 ref 归类的自定义 env 键写成明文', () => {
  it.each(['saved', 'runtime'] as const)(
    'public DTO 只有占位符，导出文件也不含真实值/占位符/refs（%s 记录）',
    async source => {
      const filePath = join(workDir, `encrypted-${source}.json`)
      const previous = [localRecord(), sshRecord()]
      const incoming = publicDtos(previous)
      // fixture 前提：CUSTOM_OPTION 在 DTO 中只剩占位符 + refs，且没有 secretEnvKeys。
      expect(incoming[0].local?.env?.CUSTOM_OPTION).toBe(SECRET_PLACEHOLDER)
      expect(incoming[0].local?.envSecretRefs).toEqual({ CUSTOM_OPTION: REF_CUSTOM, OPENAI_API_KEY: REF_API })
      expect(incoming[0].local?.secretEnvKeys).toBeUndefined()

      const { exportHandler } = createHarness({ previous, previousSource: source, savePath: filePath })
      const result = await exportHandler(testEvent, {
        sessions: incoming,
        quickCommands: [],
        encryptPassword: PASSWORD
      })
      expect(result).toMatchObject({ success: true, encrypted: true })
      expect(existsSync(filePath)).toBe(true)

      const { text, parsed } = readExport(filePath)
      for (const secret of [
        CUSTOM_SECRET, API_SECRET, TOKEN_SECRET, SSH_PASSWORD, SSH_PRIVATE_KEY, SSH_PASSPHRASE
      ]) {
        expect(text, `导出文件不得包含真实秘密 ${secret}`).not.toContain(secret)
      }
      expect(text, '导出文件不得包含占位符').not.toContain(SECRET_PLACEHOLDER)
      expect(text, '导出文件不得携带 vault 引用').not.toContain('sec_')

      expect(parsed.encrypted).toBe(true)
      const local = parsed.sessions[0].local
      expect(local.env.PATH).toBe('/usr/bin')
      expect(local.env.CUSTOM_OPTION).toMatch(/^enc:/)
      expect(local.env.OPENAI_API_KEY).toMatch(/^enc:/)
      expect(local.env.GITHUB_TOKEN).toMatch(/^enc:/)
      // 分类随导出保留，导入端据此解密自定义键。
      expect(local.secretEnvKeys).toContain('CUSTOM_OPTION')
      expect(local.envSecretRefs).toBeUndefined()
      expect(parsed.sessions[1].ssh.password).toMatch(/^enc:/)
      expect(parsed.sessions[1].ssh.privateKey).toMatch(/^enc:/)
      expect(parsed.sessions[1].ssh.passphrase).toMatch(/^enc:/)
    }
  )

  it('加密导出 → 真实导入解密后可还原全部原值', async () => {
    const filePath = join(workDir, 'round-trip.json')
    const previous = [localRecord(), sshRecord()]
    const incoming = publicDtos(previous)
    const harness = createHarness({ previous, previousSource: 'saved', savePath: filePath })

    const exported = await harness.exportHandler(testEvent, {
      sessions: incoming,
      quickCommands: [],
      encryptPassword: PASSWORD
    })
    expect(exported).toMatchObject({ success: true, encrypted: true })

    const preview = await harness.importHandler(testEvent, PASSWORD, filePath)
    expect(preview).toMatchObject({ success: true, encrypted: true })
    expect(preview.importToken).toBeTruthy()
    // 导入预览给渲染层的仍是安全 DTO：自定义键恢复为占位符（分类被正确保留）。
    expect(preview.data?.sessions[0].local?.env?.CUSTOM_OPTION).toBe(SECRET_PLACEHOLDER)
    expect(JSON.stringify(preview)).not.toContain(CUSTOM_SECRET)
    expect(JSON.stringify(preview)).not.toContain(SSH_PASSWORD)

    const token = preview.importToken!
    const sessionIds = (preview.data?.sessions ?? []).map(session => session.id)
    const restored = harness.staging.take('test-principal', token, sessionIds)
    expect(restored).toHaveLength(2)

    const [local, ssh] = restored
    expect(local.local?.env).toEqual({
      PATH: '/usr/bin',
      CUSTOM_OPTION: CUSTOM_SECRET,
      OPENAI_API_KEY: API_SECRET,
      GITHUB_TOKEN: TOKEN_SECRET,
      EMPTY_VALUE: ''
    })
    expect(local.local?.envSecretRefs).toBeUndefined()
    expect(ssh.ssh?.password).toBe(SSH_PASSWORD)
    expect(ssh.ssh?.privateKey).toBe(SSH_PRIVATE_KEY)
    expect(ssh.ssh?.passphrase).toBe(SSH_PASSPHRASE)
  })
})

describe('非法/无法解析的引用一律拒绝加密导出', () => {
  it('跨记录复制的外部 ref 不被接受，且不落盘', async () => {
    const filePath = join(workDir, 'foreign-ref.json')
    const previous = [localRecord()]
    const incoming = publicDtos(previous)
    // 渲染层伪造/跨记录引用：与 main 持有的上一条记录不一致。
    incoming[0].local!.envSecretRefs = { CUSTOM_OPTION: REF_OTHER }

    const { exportHandler } = createHarness({ previous, previousSource: 'saved', savePath: filePath })
    const result = await exportHandler(testEvent, {
      sessions: incoming,
      quickCommands: [],
      encryptPassword: PASSWORD
    })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Secret references cannot be copied/)
    expect(existsSync(filePath)).toBe(false)
  })

  it('引用仍在但运行期解析失败时拒绝导出，不写占位符也不写明文', async () => {
    const filePath = join(workDir, 'unresolved-ref.json')
    const previous = [localRecord({ env: { PATH: '/usr/bin' } })]
    const incoming = publicDtos(previous)
    expect(incoming[0].local?.env?.CUSTOM_OPTION).toBe(SECRET_PLACEHOLDER)

    const { exportHandler } = createHarness({ previous, previousSource: 'saved', savePath: filePath })
    const result = await exportHandler(testEvent, {
      sessions: incoming,
      quickCommands: [],
      encryptPassword: PASSWORD
    })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Unresolved secret placeholders/)
    expect(existsSync(filePath)).toBe(false)
  })
})

describe('未加密导出只保留普通值', () => {
  it('剔除 SSH 凭据与秘密 env 键，且不含占位符/refs', async () => {
    const filePath = join(workDir, 'plaintext.json')
    const previous = [localRecord(), sshRecord()]
    const incoming = publicDtos(previous)
    const { exportHandler } = createHarness({ previous, previousSource: 'saved', savePath: filePath })

    const result = await exportHandler(testEvent, { sessions: incoming, quickCommands: [] })
    expect(result).toMatchObject({ success: true, encrypted: false })

    const { text, parsed } = readExport(filePath)
    expect(parsed.encrypted).toBe(false)
    expect(parsed.sessions[0].local.env).toEqual({ PATH: '/usr/bin', EMPTY_VALUE: '' })
    expect(parsed.sessions[0].local.envSecretRefs).toBeUndefined()
    expect(parsed.sessions[1].ssh).toEqual({ host: 'example.test', port: 22, username: 'user' })
    for (const secret of [
      CUSTOM_SECRET, API_SECRET, TOKEN_SECRET, SSH_PASSWORD, SSH_PRIVATE_KEY, SSH_PASSPHRASE
    ]) {
      expect(text, `明文导出不得包含真实秘密 ${secret}`).not.toContain(secret)
    }
    expect(text).not.toContain(SECRET_PLACEHOLDER)
    expect(text).not.toContain('sec_')
  })
})
