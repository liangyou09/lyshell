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

const configDir = join(tmpdir(), 'config')
const globalPath = join(configDir, 'env-profiles.json')
const oldPaths = {
  dsh: join(configDir, 'dsh-env-profiles.json'),
  codex: join(configDir, 'codex-env-profiles.json'),
  claude: join(configDir, 'claude-env-profiles.json')
} as const

interface GlobalFile {
  profiles: Array<{ id: string; name: string; order: number; env: Record<string, string> }>
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
    // env 内容保真
    expect(g.profiles.find((p) => p.id === 'c1')?.env).toEqual({ OPENAI_API_KEY: 'sk' })
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
