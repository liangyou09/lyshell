import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

// 播种的真相源目录共两个：mock 下「分离前的原始 userData」= root（正式版档案），
// 分离后 = root/lyshell-dev。用专属 root 而非 tmpdir/config —— 同目录已被
// harness-workspace-repository.test.ts 占用，vitest 按文件并行跑会互相踩。
const root = join(tmpdir(), 'lyshell-devseed-test')
const prodConfig = join(root, 'config')
const devConfig = join(root, 'lyshell-dev', 'config')
const markerPath = join(devConfig, '.seeded-from-prod')

// 模块顶层就调 app.setPath / app.getPath（index.ts 的首个本地 import，必须早于
// storage 单例构造），故 mock 须提供这两个方法
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => root,
    setPath: () => {}
  }
}))

function seed(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8')
  }
}

function readDev(name: string): unknown {
  return JSON.parse(readFileSync(join(devConfig, name), 'utf-8'))
}

function ids(list: unknown[]): unknown[] {
  return list.map((e) => (e as { id: string }).id)
}

/**
 * 播种入口：路径切换是 import 期副作用，播种本身由持锁方触发
 * （index.ts 拿到单实例锁后调 seedDevConfigFromProd）。
 */
async function runSeed(): Promise<typeof import('./dev-user-data')> {
  const mod = await import('./dev-user-data')
  mod.seedDevConfigFromProd()
  return mod
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('dev-user-data 档案播种', () => {
  it('缺的文件整份拷贝，条目数组按 id 补缺，非条目对象保持 dev 原样', async () => {
    seed(prodConfig, {
      'dsh-workspaces.json': JSON.stringify([{ id: 'p1', name: 'prod' }, { id: 'p2', name: 'prod-only' }]),
      'quickCommands.json': JSON.stringify({
        commands: [{ id: 'c1', name: 'prod' }, { id: 'c2', name: 'prod-only' }],
        groups: [{ id: 'g1', name: 'prod' }, { id: 'g2', name: 'prod-only' }]
      }),
      'tags.json': JSON.stringify({ tags: [{ id: 't1' }, { id: 't2' }] }),
      'agents.json': JSON.stringify([{ id: 'a1' }]),
      'preferences.json': JSON.stringify({ sidebarWidth: 687 }),
      'stale.json.bak': '不是 JSON，且不该被播'
    })
    seed(devConfig, {
      'dsh-workspaces.json': JSON.stringify([{ id: 'p1', name: 'dev-local' }]),
      'quickCommands.json': JSON.stringify({
        commands: [{ id: 'c1', name: 'dev-local' }],
        groups: [{ id: 'g1', name: 'dev-local' }]
      }),
      'tags.json': JSON.stringify({ tags: [{ id: 't1', name: 'dev-local' }] }),
      'preferences.json': JSON.stringify({ sidebarWidth: 300 })
    })

    await runSeed()

    // 顶层数组：dev 已有 p1（保留 dev 版本），正式版独有的 p2 补在后
    const ws = readDev('dsh-workspaces.json') as { id: string; name?: string }[]
    expect(ids(ws)).toEqual(['p1', 'p2'])
    expect(ws[0].name).toBe('dev-local')

    // 多数组包裹（quickCommands.json 的 commands + groups）：各按键按 id 补缺 ——
    // 只认「唯一一个数组」时这份文件整份跳过，命令和分组都补不进来
    const qc = readDev('quickCommands.json') as {
      commands: { id: string; name?: string }[]
      groups: { id: string; name?: string }[]
    }
    expect(ids(qc.commands)).toEqual(['c1', 'c2'])
    expect(qc.commands[0].name).toBe('dev-local')
    expect(ids(qc.groups)).toEqual(['g1', 'g2'])
    expect(qc.groups[0].name).toBe('dev-local')

    // 单数组包裹的对象：同样按 id 补缺
    const tags = readDev('tags.json') as { tags: { id: string; name?: string }[] }
    expect(ids(tags.tags)).toEqual(['t1', 't2'])
    expect(tags.tags[0].name).toBe('dev-local')

    expect(readDev('agents.json')).toEqual([{ id: 'a1' }]) // dev 没有 → 整份拷贝
    expect(readDev('preferences.json')).toEqual({ sidebarWidth: 300 }) // 非条目对象不覆盖
    expect(existsSync(join(devConfig, 'stale.json.bak'))).toBe(false) // .bak 类残留不播
    expect(existsSync(markerPath)).toBe(true)
  })

  it('一次性语义：标记落定后不再重播，dev 里删掉的条目不会被正式版补回', async () => {
    seed(prodConfig, { 'dsh-workspaces.json': JSON.stringify([{ id: 'p1' }, { id: 'p2' }]) })

    await runSeed()
    expect(ids(readDev('dsh-workspaces.json') as unknown[])).toEqual(['p1', 'p2'])

    // 模拟用户在 dev 里主动删掉 p2
    writeFileSync(join(devConfig, 'dsh-workspaces.json'), JSON.stringify([{ id: 'p1' }]), 'utf-8')
    vi.resetModules()
    await runSeed()

    expect(ids(readDev('dsh-workspaces.json') as unknown[])).toEqual(['p1'])
  })

  it('正式版档案不存在时不落标记（等它出现再播），也不抛', async () => {
    mkdirSync(join(root, 'lyshell-dev'), { recursive: true })

    await runSeed()

    expect(existsSync(markerPath)).toBe(false)
  })

  it('半截/畸形源不装不改、也不落标记（下轮启动重试）', async () => {
    // 正式版与 dev 可并发运行，preferences / quickCommands 的 save 都非原子 ——
    // 读到写了一半的 JSON 是真实场景，不能盲拷进 dev
    seed(prodConfig, {
      'dsh-workspaces.json': '{"id": "p1"', // 半截 JSON，目标不存在 → 不该装进去
      'quickCommands.json': '{ 这是坏的'             // 坏 JSON，目标已存在 → 不该覆盖
    })
    seed(devConfig, { 'quickCommands.json': '{ 这也是坏的' })

    await runSeed()

    expect(existsSync(join(devConfig, 'dsh-workspaces.json'))).toBe(false)
    expect(readFileSync(join(devConfig, 'quickCommands.json'), 'utf-8')).toBe('{ 这也是坏的')
    // 解析失败 = 本轮没播完：落了一次性标记，修好后就永远补不回来了
    expect(existsSync(markerPath)).toBe(false)
  })

  it('开发侧目标文件损坏时不覆盖，也不落标记（修好后下轮重试）', async () => {
    seed(prodConfig, { 'dsh-workspaces.json': JSON.stringify([{ id: 'p1' }, { id: 'p2' }]) })
    seed(devConfig, { 'dsh-workspaces.json': '{ 这是坏的' })

    await runSeed()

    expect(readFileSync(join(devConfig, 'dsh-workspaces.json'), 'utf-8')).toBe('{ 这是坏的')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('条目已齐（无新增）仍算播完，照常落标记', async () => {
    seed(prodConfig, { 'dsh-workspaces.json': JSON.stringify([{ id: 'p1' }]) })
    seed(devConfig, { 'dsh-workspaces.json': JSON.stringify([{ id: 'p1' }]) })

    await runSeed()

    expect(readDev('dsh-workspaces.json')).toEqual([{ id: 'p1' }])
    expect(existsSync(markerPath)).toBe(true)
  })

  it('混合内容文件剥掉凭据字段：内联 env 与 ai.apiKey/masterPassword 不进 dev 档案', async () => {
    seed(prodConfig, {
      'agents.json': JSON.stringify([
        { id: 'a1', name: 'Claude', command: 'claude', env: { ANTHROPIC_API_KEY: 'sk-agent' }, envProfileId: 'e1' }
      ]),
      'dsh-workspaces.json': JSON.stringify([
        { id: 'w1', name: 'prod', cwd: '/x', order: 0, env: { DEEPSEEK_API_KEY: 'sk-ws' }, envProfileId: 'e1' }
      ]),
      'preferences.json': JSON.stringify({
        sidebarWidth: 687,
        ai: { enabled: true, apiKey: 'sk-pref', maxTokens: 1, temperature: 0 },
        security: { masterPassword: 'mp-hash', autoLock: true }
      })
    })

    await runSeed()

    const agents = readDev('agents.json') as { id: string; env?: unknown; envProfileId?: string }[]
    expect(agents[0].env).toBeUndefined()
    expect(agents[0].envProfileId).toBe('e1') // 绑定 id 不是凭据，保留

    const ws = readDev('dsh-workspaces.json') as { id: string; env?: unknown; envProfileId?: string }[]
    expect(ws[0].env).toBeUndefined()
    expect(ws[0].envProfileId).toBe('e1')

    const prefs = readDev('preferences.json') as {
      sidebarWidth: number
      ai: { apiKey?: string; maxTokens?: number }
      security: { masterPassword?: string; autoLock?: boolean }
    }
    expect(prefs.sidebarWidth).toBe(687) // 其余偏好照播
    expect(prefs.ai.apiKey).toBeUndefined()
    expect(prefs.ai.maxTokens).toBe(1)
    expect(prefs.security.masterPassword).toBeUndefined()
    expect(prefs.security.autoLock).toBe(true)
    expect(existsSync(markerPath)).toBe(true)
  })

  it('按 id 补进来的条目同样剥凭据（dev 已有的内联 env 不动）', async () => {
    seed(prodConfig, {
      'agents.json': JSON.stringify([
        { id: 'a1', name: 'dev-has', env: { K: 'prod-secret' } },
        { id: 'a2', name: 'prod-only', env: { K: 'sk-new' } }
      ])
    })
    seed(devConfig, {
      'agents.json': JSON.stringify([{ id: 'a1', name: 'dev-has', env: { K: 'dev-local' } }])
    })

    await runSeed()

    const agents = readDev('agents.json') as { id: string; name: string; env?: Record<string, string> }[]
    expect(ids(agents)).toEqual(['a1', 'a2'])
    // dev 自己的凭据是本机数据，不是外带面 —— 不动
    expect(agents[0].env).toEqual({ K: 'dev-local' })
    // 正式版补进来的条目必须剥掉
    expect(agents[1].env).toBeUndefined()
  })

  it('含凭据的文件不播（会话密码 / 变量组 apiKey），其余文件照常播种', async () => {
    seed(prodConfig, {
      'sessions.json': JSON.stringify([{ id: 's1', password: 'secret' }]),
      'env-profiles.json': JSON.stringify({ profiles: [{ id: 'e1', apiKey: 'sk-secret' }] }),
      'dsh-env-profiles.json': JSON.stringify([{ id: 'e0', apiKey: 'sk-legacy' }]),
      'dsh-workspaces.json': JSON.stringify([{ id: 'w1' }])
    })

    await runSeed()

    // dev 档案常被分享排查：密码与模型凭据一律不落进去。变量组整份不播是
    // 有意取舍 —— envProfileId 会悬空（=当作没绑），但换凭据不外带。
    expect(existsSync(join(devConfig, 'sessions.json'))).toBe(false)
    expect(existsSync(join(devConfig, 'env-profiles.json'))).toBe(false)
    expect(existsSync(join(devConfig, 'dsh-env-profiles.json'))).toBe(false)
    expect(readDev('dsh-workspaces.json')).toEqual([{ id: 'w1' }])
  })

  it('import 期只切路径不播种 —— 播种等单实例锁到手再触发，两个 dev 实例才不会并发抢 .tmp', async () => {
    seed(prodConfig, { 'dsh-workspaces.json': JSON.stringify([{ id: 'p1' }]) })

    const mod = await import('./dev-user-data')
    // import 副作用只有 userData 切换；这里若已播，说明播种仍挂在模块顶层
    expect(existsSync(join(devConfig, 'dsh-workspaces.json'))).toBe(false)
    expect(existsSync(markerPath)).toBe(false)

    mod.seedDevConfigFromProd()
    expect(readDev('dsh-workspaces.json')).toEqual([{ id: 'p1' }])
    expect(existsSync(markerPath)).toBe(true)
  })

  it('标记只记结果与时间，不写本机绝对路径（dev 档案常被分享）', async () => {
    seed(prodConfig, { 'dsh-workspaces.json': JSON.stringify([{ id: 'p1' }]) })

    await runSeed()

    const marker = readFileSync(markerPath, 'utf-8')
    expect(marker).not.toContain(root) // 绝对路径含用户名与目录结构
    expect(marker).toContain('seeded')
    expect(marker).toMatch(/\d{4}-\d{2}-\d{2}T/) // 时间戳
  })
})
