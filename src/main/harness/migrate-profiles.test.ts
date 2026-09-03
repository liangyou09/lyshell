import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

// electron-log / electron.app.getPath 在 Node 测试环境不存在，mock 掉（对齐 harness-workspace-repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

// 不能静态 import 被测模块：迁移写的是 envProfileRepository 单例（固定 env-profiles.json），
// 其内存态在首次 load 后不再读盘。每个用例 vi.resetModules() 后动态 import 取新单例，
// 否则上一用例并入的组会泄漏进下一用例的内存态。
// 旧文件名（dsh/codex/claude-env-profiles.json）由生产代码拼出，本文件独占（其他测试不用）。
// liftStructuredFields 是 @shared 纯函数，静态 import 不受 resetModules 影响。

import { liftStructuredFields } from '@shared/harness'

const configDir = join(tmpdir(), 'config')
const globalPath = join(configDir, 'env-profiles.json')
const oldPaths = {
  dsh: join(configDir, 'dsh-env-profiles.json'),
  codex: join(configDir, 'codex-env-profiles.json'),
  claude: join(configDir, 'claude-env-profiles.json')
} as const

interface GlobalFile {
  profiles: Array<{ id: string; name: string; order: number; env: Record<string, string>; baseUrl?: string; apiKey?: string }>
  activeByKind: Record<string, string>
}

/** 读全局库落盘内容 —— 断言以盘上为准 */
function readGlobal(): GlobalFile {
  return JSON.parse(readFileSync(globalPath, 'utf-8'))
}

function seedOld(kind: keyof typeof oldPaths, content: string): void {
  writeFileSync(oldPaths[kind], content, 'utf-8')
}

/** 重置模块注册表后动态 import —— 每次调用等价一次「冷启动」 */
async function runMigration(): Promise<void> {
  const mod = await import('./migrate-profiles')
  mod.migrateKindEnvProfilesToGlobal()
}

function cleanFiles(): void {
  mkdirSync(configDir, { recursive: true })
  rmSync(globalPath, { force: true })
  rmSync(`${globalPath}.bak`, { force: true })
  for (const p of Object.values(oldPaths)) {
    rmSync(p, { force: true })
    rmSync(`${p}.bak`, { force: true })
  }
}

beforeEach(() => {
  cleanFiles()
  vi.resetModules()
})

afterEach(() => {
  cleanFiles()
})

describe('migrateKindEnvProfilesToGlobal', () => {
  it('三份旧文件并入全局库：保 id、全局重排 order、per-kind 指针正确、旧文件 rename 为 .bak', async () => {
    seedOld('dsh', JSON.stringify([
      { id: 'd1', name: 'dsh组', order: 0, env: { DSH_HOME: '/d' }, active: true },
      { id: 'd2', name: 'dsh组2', order: 1, env: { K: 'v' } }
    ]))
    seedOld('codex', JSON.stringify([
      { id: 'c1', name: 'codex组', order: 0, env: { OPENAI_API_KEY: 'sk' } }
    ]))
    seedOld('claude', JSON.stringify([
      { id: 'l1', name: 'claude组', order: 0, env: { ANTHROPIC_AUTH_TOKEN: 't' }, active: true }
    ]))

    await runMigration()

    const g = readGlobal()
    // 按 kind 处理顺序（dsh → codex → claude）追加，order 全局重排
    expect(g.profiles.map((p) => p.id)).toEqual(['d1', 'd2', 'c1', 'l1'])
    expect(g.profiles.map((p) => p.order)).toEqual([0, 1, 2, 3])
    // env 内容保真：codex 记录里的 OPENAI_API_KEY 是已知协议键，
    // 并入时经 normalizeProfile 防御分支提升成结构化核心
    const c1 = g.profiles.find((p) => p.id === 'c1')!
    expect(c1.apiKey).toBe('sk')
    expect(c1.env).toEqual({})
    // dsh 记录无协议键，env 原样保留
    expect(g.profiles.find((p) => p.id === 'd1')?.env).toEqual({ DSH_HOME: '/d' })
    // dsh/claude 各有 active 条目 → 指针迁入；codex 无 active → 无指针（回落系统环境变量）
    expect(g.activeByKind).toEqual({ dsh: 'd1', claude: 'l1' })
    // 旧文件改名保留（不删，可回滚）
    for (const p of Object.values(oldPaths)) {
      expect(existsSync(p)).toBe(false)
      expect(existsSync(`${p}.bak`)).toBe(true)
    }
  })

  it('旧记录里的非法条目被过滤，只迁合法的', async () => {
    seedOld('codex', JSON.stringify([
      { id: 'ok', name: 'ok', order: 0, env: { K: '1' } },
      { id: 'no-name', order: 1, env: { K: '2' } },
      { id: 'empty-env', name: 'e', order: 2, env: {} },
      'garbage'
    ]))

    await runMigration()

    expect(readGlobal().profiles.map((p) => p.id)).toEqual(['ok'])
  })

  it('同一 kind 多条 active 只认 order 最小的一条（照搬旧仓库「先排序后钳制」语义，不随文件顺序漂移）', async () => {
    seedOld('codex', JSON.stringify([
      { id: 'x1', name: 'x', order: 2, env: { K: '1' }, active: true },
      { id: 'x2', name: 'y', order: 0, env: { K: '2' }, active: true },
      { id: 'x3', name: 'z', order: 1, env: { K: '3' } }
    ]))

    await runMigration()

    expect(readGlobal().activeByKind).toEqual({ codex: 'x2' })
  })

  it('幂等：重跑同 id 不重复并入（模拟「并入成功但 rename 失败」的重试）', async () => {
    seedOld('codex', JSON.stringify([
      { id: 'c1', name: 'c', order: 0, env: { K: '1' }, active: true }
    ]))
    await runMigration()
    expect(readGlobal().profiles.map((p) => p.id)).toEqual(['c1'])

    // 模拟 rename 失败遗留：把旧文件放回去，冷启动重跑
    seedOld('codex', JSON.stringify([
      { id: 'c1', name: 'c', order: 0, env: { K: '1' }, active: true }
    ]))
    vi.resetModules()
    await runMigration()

    const g = readGlobal()
    expect(g.profiles.map((p) => p.id)).toEqual(['c1'])
    expect(g.activeByKind).toEqual({ codex: 'c1' }) // 已有指针不被覆盖
    expect(existsSync(`${oldPaths.codex}.bak`)).toBe(true)
  })

  it('全局库已有指针时，旧文件的 active 不覆盖（本库优先）', async () => {
    writeFileSync(globalPath, JSON.stringify({
      profiles: [{ id: 'g1', name: 'g', order: 0, env: { K: 'g' } }],
      activeByKind: { codex: 'g1' }
    }), 'utf-8')
    seedOld('codex', JSON.stringify([
      { id: 'c1', name: 'c', order: 0, env: { K: '1' }, active: true }
    ]))

    await runMigration()

    const g = readGlobal()
    expect(g.profiles.map((p) => p.id)).toEqual(['g1', 'c1']) // 并入接在现有之后
    expect(g.activeByKind).toEqual({ codex: 'g1' }) // 指针不覆盖
  })

  it('损坏的旧文件：跳过该 kind 且不 rename（下次启动重试），其他 kind 照常迁移', async () => {
    seedOld('dsh', JSON.stringify([
      { id: 'd1', name: 'd', order: 0, env: { K: '1' } }
    ]))
    seedOld('codex', '{ broken json')

    await runMigration()

    expect(readGlobal().profiles.map((p) => p.id)).toEqual(['d1'])
    expect(existsSync(`${oldPaths.dsh}.bak`)).toBe(true)
    expect(existsSync(oldPaths.codex)).toBe(true) // 未 rename，保留重试
    expect(existsSync(`${oldPaths.codex}.bak`)).toBe(false)
  })

  it('旧文件是非数组 JSON：按空库处理并 rename（不无限重试）', async () => {
    seedOld('claude', '{"a": 1}')

    await runMigration()

    expect(readGlobal().profiles).toEqual([])
    expect(existsSync(`${oldPaths.claude}.bak`)).toBe(true)
  })

  it('旧文件不存在时纯 no-op：不落全局库、不抛出', async () => {
    await runMigration()
    expect(existsSync(globalPath)).toBe(false)
    for (const p of Object.values(oldPaths)) {
      expect(existsSync(p)).toBe(false)
      expect(existsSync(`${p}.bak`)).toBe(false)
    }
  })
})

describe('liftStructuredFields（协议键提升纯函数）', () => {
  it('单协议命中：该协议的凭据对提走，其余键留在附加变量', () => {
    const lifted = liftStructuredFields({
      OPENAI_BASE_URL: 'https://1.1.1.3:8443/v1',
      OPENAI_API_KEY: 'sk-1',
      CODEX_HOME: 'C:/x'
    })
    expect(lifted.baseUrl).toBe('https://1.1.1.3:8443/v1')
    expect(lifted.apiKey).toBe('sk-1')
    expect(lifted.env).toEqual({ CODEX_HOME: 'C:/x' })
  })

  it('单边命中也算命中：只有 key 没有 url 时照样提走那一维', () => {
    const lifted = liftStructuredFields({ ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: 'C:/c' })
    expect(lifted.baseUrl).toBeUndefined()
    expect(lifted.apiKey).toBe('t')
    expect(lifted.env).toEqual({ CLAUDE_CONFIG_DIR: 'C:/c' })
  })

  it('多协议并存：按 HARNESS_AGENT_KINDS 顺序取首个命中的协议，其余协议键留在附加变量', () => {
    const lifted = liftStructuredFields({
      DEEPSEEK_API_KEY: 'd-key',
      OPENAI_API_KEY: 'o-key',
      ANTHROPIC_BASE_URL: 'https://a'
    })
    // dsh 排最前，只认 DEEPSEEK_API_KEY；codex / claude 的键不抢、也不丢
    expect(lifted.apiKey).toBe('d-key')
    expect(lifted.baseUrl).toBeUndefined()
    expect(lifted.env).toEqual({ OPENAI_API_KEY: 'o-key', ANTHROPIC_BASE_URL: 'https://a' })
  })

  it('无命中原样返回：核心两字段 undefined，env 逐键拷贝不共享引用', () => {
    const source = { K: 'v', CODEX_HOME: 'C:/x' }
    const lifted = liftStructuredFields(source)
    expect(lifted.baseUrl).toBeUndefined()
    expect(lifted.apiKey).toBeUndefined()
    expect(lifted.env).toEqual(source)
    expect(lifted.env).not.toBe(source)
  })
})

describe('migrateProfilesToStructured', () => {
  /** 结构化迁移不碰单例内存态（直接读写文件），无需 resetModules 也能重入 */
  async function runStructuredMigration(): Promise<void> {
    const mod = await import('./migrate-profiles')
    mod.migrateProfilesToStructured()
  }

  it('旧扁平组提升为结构化核心：协议键提走、附加变量保留、activeByKind 原样、.bak 备份提升前内容', async () => {
    writeFileSync(globalPath, JSON.stringify({
      profiles: [
        {
          id: 'glm', name: 'glm', order: 0,
          env: { OPENAI_BASE_URL: 'https://1.1.1.3:8443/v1', OPENAI_API_KEY: 'sk-1', CODEX_HOME: 'C:/x', NO_PROXY: 'h' }
        },
        { id: 'plain', name: 'plain', order: 1, env: { K: 'v' } }
      ],
      activeByKind: { codex: 'glm' }
    }), 'utf-8')

    await runStructuredMigration()

    const g = readGlobal()
    const glm = g.profiles.find((p) => p.id === 'glm')!
    expect(glm.baseUrl).toBe('https://1.1.1.3:8443/v1')
    expect(glm.apiKey).toBe('sk-1')
    expect(glm.env).toEqual({ CODEX_HOME: 'C:/x', NO_PROXY: 'h' })
    // 无协议键的组不动
    const plain = g.profiles.find((p) => p.id === 'plain')!
    expect(plain.baseUrl).toBeUndefined()
    expect(plain.env).toEqual({ K: 'v' })
    expect(g.activeByKind).toEqual({ codex: 'glm' })
    // 备份是提升前的原始内容（凭据还在 env 里）
    expect(existsSync(`${globalPath}.bak`)).toBe(true)
    const bak = JSON.parse(readFileSync(`${globalPath}.bak`, 'utf-8'))
    expect(bak.profiles[0].env).toHaveProperty('OPENAI_API_KEY', 'sk-1')
    expect(bak.profiles[0].baseUrl).toBeUndefined()
  })

  it('幂等：二跑不再改动文件、不覆盖既有备份', async () => {
    writeFileSync(globalPath, JSON.stringify({
      profiles: [
        { id: 'a', name: 'a', order: 0, env: { DEEPSEEK_BASE_URL: 'https://u', DEEPSEEK_API_KEY: 'k' } }
      ],
      activeByKind: { dsh: 'a' }
    }), 'utf-8')

    await runStructuredMigration()
    const afterFirst = readFileSync(globalPath, 'utf-8')
    const bakAfterFirst = readFileSync(`${globalPath}.bak`, 'utf-8')

    // 提升后 env 里不再有已知协议键 → 二跑全 no-op
    await runStructuredMigration()

    expect(readFileSync(globalPath, 'utf-8')).toBe(afterFirst)
    expect(readFileSync(`${globalPath}.bak`, 'utf-8')).toBe(bakAfterFirst)
  })

  it('已有结构化核心的组跳过：不改动文件、不建 .bak', async () => {
    const structured = {
      profiles: [
        { id: 'a', name: 'a', order: 0, baseUrl: 'https://u', apiKey: 'sk', env: { CODEX_HOME: 'C:/x' } }
      ],
      activeByKind: { codex: 'a' }
    }
    const raw = JSON.stringify(structured)
    writeFileSync(globalPath, raw, 'utf-8')

    await runStructuredMigration()

    expect(readFileSync(globalPath, 'utf-8')).toBe(raw)
    expect(existsSync(`${globalPath}.bak`)).toBe(false)
  })

  it('全局库文件缺失时纯 no-op：不抛出、不建文件', async () => {
    await runStructuredMigration()
    expect(existsSync(globalPath)).toBe(false)
    expect(existsSync(`${globalPath}.bak`)).toBe(false)
  })

  it('与旧 per-kind 并入链路衔接：并入时 normalizeProfile 已防御提升，结构化迁移无事可做', async () => {
    // handlers.ts 里 migrateKindEnvProfilesToGlobal 之后紧跟 migrateProfilesToStructured
    seedOld('codex', JSON.stringify([
      { id: 'c1', name: 'c', order: 0, env: { OPENAI_BASE_URL: 'https://u', OPENAI_API_KEY: 'sk', CODEX_HOME: 'C:/x' } }
    ]))

    const mod = await import('./migrate-profiles')
    mod.migrateKindEnvProfilesToGlobal()
    mod.migrateProfilesToStructured()

    const g = readGlobal()
    const c1 = g.profiles.find((p) => p.id === 'c1')!
    // 并入路径经 normalizeProfile 防御分支已是结构化，第二轮迁移零改动
    expect(c1.baseUrl).toBe('https://u')
    expect(c1.apiKey).toBe('sk')
    expect(c1.env).toEqual({ CODEX_HOME: 'C:/x' })
    expect(existsSync(`${globalPath}.bak`)).toBe(false)
  })
})
