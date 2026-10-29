import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import {
  BRIDGE_HANDSHAKE_PATH,
  BRIDGE_KEY_ENV,
  BRIDGE_KEY_HEADER,
  BRIDGE_PATCH_ENTRY_ID,
  BRIDGE_PATCH_FILE_NAME,
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RUN_DIR_PREFIX,
  BRIDGE_RUN_OWNER_FILE_NAME,
  bridgeKeyMatches,
  bridgePackageSpecifier,
  buildBridgePatchFile,
  buildLaunchLine,
  checkBridgeIdentity,
  locateBridgePackage,
  newBridgeRunId,
  parseBridgeHandshake,
  prepareBridgeRuntime,
  quoteWindowsCmdArg,
  requestBridgeHandshake,
  UnsafeBridgePathError
} from './bridge'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeBridgePackage(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), '// host half\n', 'utf8')
  writeFileSync(join(dir, 'client.js'), '// client half\n', 'utf8')
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n', 'utf8')
  return dir
}

describe('桥包定位（随包发布，不安装进用户 dsh）', () => {
  it('开发态从仓库根 resources/dsh-bridge 定位，并给出三个必需文件', () => {
    const root = tempDir('lyshell-bridge-root-')
    makeBridgePackage(join(root, 'resources', 'dsh-bridge'))
    const found = locateBridgePackage({ isPackaged: false, devRoot: root })
    expect(found).not.toBeNull()
    expect(found?.entry.endsWith(join('resources', 'dsh-bridge', 'index.mjs'))).toBe(true)
    expect(found?.client.endsWith(join('resources', 'dsh-bridge', 'client.js'))).toBe(true)
    expect(found?.manifest.endsWith(join('resources', 'dsh-bridge', 'package.json'))).toBe(true)
  })

  it('打包态从 process.resourcesPath/dsh-bridge 定位（asar 外）', () => {
    const root = tempDir('lyshell-bridge-pack-')
    makeBridgePackage(join(root, 'dsh-bridge'))
    expect(locateBridgePackage({ isPackaged: true, resourcesPath: root, devRoot: 'ignored' })).not.toBeNull()
  })

  it('缺任一必需文件即判「无桥」（不猜路径、不半装载）', () => {
    const root = tempDir('lyshell-bridge-partial-')
    const dir = join(root, 'resources', 'dsh-bridge')
    makeBridgePackage(dir)
    rmSync(join(dir, 'client.js'))
    expect(locateBridgePackage({ isPackaged: false, devRoot: root })).toBeNull()
    expect(locateBridgePackage({ isPackaged: true, resourcesPath: undefined, devRoot: root })).toBeNull()
  })

  it('随仓库发布的真实桥包存在且三件套齐全（回归：打包规则与产品包不能被删）', () => {
    const repoRoot = process.cwd()
    const found = locateBridgePackage({ isPackaged: false, devRoot: repoRoot })
    expect(found).not.toBeNull()
    const manifest = JSON.parse(readFileSync(found!.manifest, 'utf8')) as {
      name: string
      exports: Record<string, string>
      dsh: { client: { platform: string } }
    }
    // 官方 client 装载前置条件：exports['./client'] + dsh.client 声明 + bundle 文件存在
    expect(manifest.exports['./client']).toBe('./client.js')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(existsSync(found!.client)).toBe(true)
  })

  it('宿主半与宿主侧常量不漂移（路由 / 头名 / env 名 / 协议版本必须一致）', () => {
    const repoRoot = process.cwd()
    const source = readFileSync(join(repoRoot, 'resources', 'dsh-bridge', 'index.mjs'), 'utf8')
    expect(source).toContain(`'${BRIDGE_HANDSHAKE_PATH}'`)
    expect(source).toContain(`'${BRIDGE_KEY_HEADER}'`)
    expect(source).toContain(`'${BRIDGE_KEY_ENV}'`)
    expect(source).toContain(`const HARNESS_PROTOCOL_VERSION = ${BRIDGE_PROTOCOL_VERSION}`)
    // 宿主半**不得**把 key 写进任何响应体/日志（只允许读 env 与比较）
    expect(/JSON\.stringify\(\{[^}]*key/is.test(source)).toBe(false)
  })

  // S4 起客户端半不再「只注册存在性」：它要用官方导航服务落地 viewer 请求、上报 ack/browse，
  // 并按桥下发的写路径清单做浏览器侧门禁（fetch/XHR 包装是功能本体）。凭据边界不变 ——
  // 它只走同源 viewer cookie，绝不出现 host bridge key、插件 host token、instanceId/instanceEpoch。
  it('客户端半仍注册存在性，且绝不携带 host 凭据/实例身份（只看代码行，注释不算）', () => {
    const repoRoot = process.cwd()
    const client = readFileSync(join(repoRoot, 'resources', 'dsh-bridge', 'client.js'), 'utf8')
    const code = client
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(code).toContain('__ModuleLoader__')
    // 凭据/身份面：host bridge key 头名、实例身份、凭据类 env 一律不得出现在客户端半
    expect(code).not.toMatch(/instanceId|instanceEpoch|LYSHELL_EXCLUSIVE|x-lyshell-exclusive|bridgeKey|hostToken/i)
    // 只读状态/ack/browse 三个端点只能走同源 viewer 路由（不带端口/绝对地址 = 不跨源取凭据）
    expect(code).toContain("'/__lyshell/harness/viewer/status'")
    expect(code).toContain('/__lyshell/harness/viewer/ack')
    expect(code).toContain('/__lyshell/harness/viewer/browse')
    expect(code).not.toMatch(/https?:\/\/127\.0\.0\.1:\d+/)
  })
})

describe('patch 文件与运行期资源', () => {
  it('patch 里的 insert.name 是规范 file: URL（空格转义），可解回同一文件', () => {
    const dir = tempDir('lyshell bridge space-')
    const entry = join(makeBridgePackage(dir), 'index.mjs')
    const specifier = bridgePackageSpecifier(entry)
    expect(specifier.startsWith('file:')).toBe(true)
    expect(specifier).toContain('%20')
    expect(fileURLToPath(specifier)).toBe(entry)
    expect(specifier).not.toContain('token')
  })

  it('patch 文件只含桥包路径与固定 id，绝不含凭据', () => {
    const entry = join(tempDir('lyshell-patch-'), 'index.mjs')
    const content = buildBridgePatchFile(entry)
    const parsed = JSON.parse(content) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(parsed[0].insert[0].id).toBe(BRIDGE_PATCH_ENTRY_ID)
    expect(parsed[0].insert[0].name).toBe(bridgePackageSpecifier(entry))
    expect(content).not.toMatch(/token|key|secret|password/i)
  })

  it('prepareBridgeRuntime：宿主 owned 目录 + 确定性文件名 + 运行期随机 key，cleanup 回收本代 patch 和空目录', () => {
    const root = tempDir('lyshell-runtime-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const plan = prepareBridgeRuntime({
      runtimeDir,
      location: { dir: pkg, entry: join(pkg, 'index.mjs'), client: join(pkg, 'client.js'), manifest: join(pkg, 'package.json') }
    })
    expect(existsSync(plan.patchFile)).toBe(true)
    expect(plan.patchFile.endsWith(BRIDGE_PATCH_FILE_NAME)).toBe(true)
    // 文件名确定性：没有时间戳/随机段
    expect(BRIDGE_PATCH_FILE_NAME).not.toMatch(/\d{6,}/)
    expect(plan.key).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.childEnv()).toEqual({ [BRIDGE_KEY_ENV]: plan.key })
    // patch 落盘内容与内存 key 无关 —— key 只在 env/内存里
    expect(readFileSync(plan.patchFile, 'utf8')).not.toContain(plan.key)
    plan.cleanup()
    expect(existsSync(plan.patchFile)).toBe(false)
    expect(existsSync(plan.runtimeDir)).toBe(false)
    plan.cleanup()  // 幂等：重复清理不抛
  })

  it('两次 prepare 的 key 与运行目录都不同（运行期随机 + 每次启动隔离）', () => {
    const root = tempDir('lyshell-runtime2-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const location = { dir: pkg, entry: join(pkg, 'index.mjs'), client: join(pkg, 'client.js'), manifest: join(pkg, 'package.json') }
    const a = prepareBridgeRuntime({ runtimeDir: join(root, 'r'), location })
    const b = prepareBridgeRuntime({ runtimeDir: join(root, 'r'), location })
    expect(a.key).not.toBe(b.key)
    // 每次启动一个独有运行目录，但文件名（basename）确定，不随时间戳漂移
    expect(a.runtimeDir).not.toBe(b.runtimeDir)
    expect(dirname(a.patchFile)).toBe(a.runtimeDir)
    expect(dirname(b.patchFile)).toBe(b.runtimeDir)
    expect(a.patchFile.endsWith(BRIDGE_PATCH_FILE_NAME)).toBe(true)
    expect(b.patchFile.endsWith(BRIDGE_PATCH_FILE_NAME)).toBe(true)
    expect(BRIDGE_PATCH_FILE_NAME).not.toMatch(/\d{6,}/)
    expect(newBridgeRunId()).not.toBe(newBridgeRunId())
  })

  it('cleanup 保留外来文件，启动仅回收确认死亡且有归属标记的旧目录', () => {
    const root = tempDir('lyshell-owned-runtime-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const location = { dir: pkg, entry: join(pkg, 'index.mjs'), client: join(pkg, 'client.js'), manifest: join(pkg, 'package.json') }
    const runtimeDir = join(root, 'runtime')
    const foreign = prepareBridgeRuntime({ runtimeDir, location })
    writeFileSync(join(foreign.runtimeDir, 'keep.txt'), 'user data')
    foreign.cleanup()
    expect(readFileSync(join(foreign.runtimeDir, 'keep.txt'), 'utf8')).toBe('user data')
    const stale = prepareBridgeRuntime({ runtimeDir, location })
    const active = prepareBridgeRuntime({ runtimeDir, location })
    // 注入一个本测试专用的「已确认不存在」PID，其他 PID 查询仍原样执行。
    const deadPid = 2147483000
    writeFileSync(join(stale.runtimeDir, '.lyshell-run-owner.json'), JSON.stringify({ version: 1, pid: deadPid, owner: 'fixture' }))
    const original = process.kill
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid) throw Object.assign(new Error('not running'), { code: 'ESRCH' })
      return original(pid, signal)
    })
    try {
      const next = prepareBridgeRuntime({ runtimeDir, location })
      expect(existsSync(stale.runtimeDir)).toBe(false)
      expect(existsSync(active.patchFile)).toBe(true)
      expect(existsSync(join(foreign.runtimeDir, 'keep.txt'))).toBe(true)
      next.cleanup(); active.cleanup()
    } finally { kill.mockRestore() }
  })

  it('落盘路径不得含凭据任何片段：run 目录名与 host key 完全独立', () => {
    const root = tempDir('lyshell-runid-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const location = { dir: pkg, entry: join(pkg, 'index.mjs'), client: join(pkg, 'client.js'), manifest: join(pkg, 'package.json') }
    // key 用「可辨识」长形态（不含路径里天然会出现的 d/r/u 等）才能断言它的片段没漏进路径
    const key = '9f3a1c7e'.repeat(8)
    const plan = prepareBridgeRuntime({ runtimeDir: join(root, 'r'), location, randomKey: () => key })
    expect(plan.key).toBe(key)
    expect(plan.runtimeDir).not.toContain(key)
    expect(plan.patchFile).not.toContain(key)
    // 逐个长度（≥8）的前缀都要查 —— 尤其 16 位，那正是曾经被当作 run id 的片段。
    // 用大小写无关比较，避免凭据片段以不同大小写混进路径而测试看不见。
    const haystack = `${plan.runtimeDir}|${plan.patchFile}`.toLowerCase()
    for (let n = 8; n <= key.length; n++) {
      expect(haystack).not.toContain(key.slice(0, n).toLowerCase())
    }
    // run 目录名只由独立随机段构成，绝不是 key 的任何片段
    expect(dirname(plan.patchFile)).toBe(plan.runtimeDir)
    expect(plan.runtimeDir.endsWith(`run-${plan.key.slice(0, 16)}`)).toBe(false)
  })

  it('真实迟到 cleanup：旧代 cleanup 落在新一代 patch 写好之后，仍不得删掉新资源', () => {
    const root = tempDir('lyshell-late-cleanup-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const location = { dir: pkg, entry: join(pkg, 'index.mjs'), client: join(pkg, 'client.js'), manifest: join(pkg, 'package.json') }
    const oldRun = prepareBridgeRuntime({ runtimeDir, location })
    const newRun = prepareBridgeRuntime({ runtimeDir, location })
    // 目录隔离：每次启动一个独有 run 目录，旧代即便迟到也碰不到新一代的文件
    expect(oldRun.patchFile).not.toBe(newRun.patchFile)
    expect(existsSync(newRun.patchFile)).toBe(true)
    // 旧代迟到（新一代已写好）⇒ 只回收旧代自己的资源
    oldRun.cleanup()
    expect(existsSync(oldRun.patchFile)).toBe(false)
    expect(existsSync(oldRun.runtimeDir)).toBe(false)
    expect(existsSync(newRun.patchFile)).toBe(true)
    expect(existsSync(newRun.runtimeDir)).toBe(true)
    newRun.cleanup()
    expect(existsSync(newRun.patchFile)).toBe(false)
    expect(existsSync(newRun.runtimeDir)).toBe(false)
  })

  // 说明（F3 之后的行为调整）：prepare 现在拒绝与**已存在**的 run 目录碰撞，所以「两代共用同一路径」
  // 不能再靠两次 prepare（同 randomRunId）构造。这里直接构造等价的最强情形：路径已被另一代接管
  // （owner 被重写）——旧 plan 的 cleanup 必须按「拥有者已变化」放手，而不是删掉路径上的资源。
  it('同一 run 路径被接管 / patch 被改写：旧 plan 的 cleanup 一律放手', () => {
    const root = tempDir('lyshell-takeover-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const location = { dir: pkg, entry: join(pkg, 'index.mjs'), client: join(pkg, 'client.js'), manifest: join(pkg, 'package.json') }

    const stale = prepareBridgeRuntime({ runtimeDir, location })
    // 新代在同一路径重写了 owner（等价于旧代的 run 目录被接管）
    writeFileSync(
      join(stale.runtimeDir, BRIDGE_RUN_OWNER_FILE_NAME),
      JSON.stringify({ version: 1, pid: process.pid, owner: 'taken-over-generation' })
    )
    stale.cleanup()
    expect(existsSync(stale.patchFile)).toBe(true)
    expect(existsSync(stale.runtimeDir)).toBe(true)

    // patch 被**别人改写** ⇒ 不删文件、不删非空目录（宁可留，也不删归属不确定的资源）
    const rewritten = prepareBridgeRuntime({ runtimeDir, location })
    writeFileSync(rewritten.patchFile, 'other-generation: not ours\n', 'utf8')
    rewritten.cleanup()
    expect(readFileSync(rewritten.patchFile, 'utf8')).toBe('other-generation: not ours\n')
    expect(existsSync(rewritten.runtimeDir)).toBe(true)
  })
})

describe('prepare 中途写盘失败的回滚（F3：不留孤儿 run 目录）', () => {
  const locationOf = (pkg: string) => ({
    dir: pkg,
    entry: join(pkg, 'index.mjs'),
    client: join(pkg, 'client.js'),
    manifest: join(pkg, 'package.json')
  })

  /** 只数本夹具 runtimeDir 下的 run-* 目录（第一次 mkdir 之前父目录可能还不存在） */
  function runDirNames(runtimeDir: string): string[] {
    return existsSync(runtimeDir)
      ? readdirSync(runtimeDir).filter((name) => name.startsWith(BRIDGE_RUN_DIR_PREFIX)).sort()
      : []
  }

  type WriteFault = 'before-write' | 'after-write' | 'truncated-write' | 'foreign-write'

  /**
   * 在 owner/patch 的写入点注入确定性 EIO（真实 mkdir、真实文件系统，只替换 writeFile）：
   *   - before-write   ：文件根本没被创建（F3 里「5 个空目录」的成因）
   *   - after-write    ：内容已完整落盘后才报错（F3 里「5 个仅含 marker 的目录」的成因）
   *   - truncated-write：只写了一半内容才报错（模拟部分写入）
   *   - foreign-write  ：路径上的内容不是我们写的（归属不可证明）
   */
  function faultyWriter(target: 'owner' | 'patch', fault: WriteFault): {
    writeFile: (file: string, data: string) => void
    failure: Error
    disarm: () => void
    writes: string[]
  } {
    const failure = Object.assign(new Error(`injected EIO at ${target} write`), { code: 'EIO' })
    const writes: string[] = []
    let armed = true
    const writeFile = (file: string, data: string): void => {
      writes.push(file)
      const hit =
        armed && (target === 'owner' ? file.endsWith(BRIDGE_RUN_OWNER_FILE_NAME) : file.endsWith(BRIDGE_PATCH_FILE_NAME))
      if (!hit) {
        writeFileSync(file, data, 'utf8')
        return
      }
      if (fault === 'after-write') writeFileSync(file, data, 'utf8')
      if (fault === 'truncated-write') writeFileSync(file, data.slice(0, Math.ceil(data.length / 2)), 'utf8')
      if (fault === 'foreign-write') writeFileSync(file, 'other-generation: not ours\n', 'utf8')
      throw failure
    }
    return { writeFile, failure, disarm: () => { armed = false }, writes }
  }

  it('owner 写入点 EIO 连续 5 次：每次回滚本次新建的 run 目录，之后正常 prepare/cleanup 仍剩 0 个目录', () => {
    const root = tempDir('lyshell-f3-owner-eio-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const location = locationOf(pkg)
    const faulty = faultyWriter('owner', 'before-write')
    for (let i = 0; i < 5; i++) {
      let caught: unknown
      try {
        prepareBridgeRuntime({ runtimeDir, location, writeFile: faulty.writeFile })
      } catch (error) {
        caught = error
      }
      // 原错误原样上抛（不被回滚包装/替换），调用方的「无桥」判据不变
      expect(caught).toBe(faulty.failure)
    }
    // F3 反证：修复前这里会剩 5 个缺少 marker 的空 run 目录，且没有任何回收路径能删它们
    expect(runDirNames(runtimeDir)).toEqual([])

    faulty.disarm()
    const plan = prepareBridgeRuntime({ runtimeDir, location, writeFile: faulty.writeFile })
    expect(existsSync(plan.patchFile)).toBe(true)
    expect(runDirNames(runtimeDir)).toEqual([dirname(plan.patchFile).split(/[\\/]/).pop()!])
    plan.cleanup()
    expect(runDirNames(runtimeDir)).toEqual([])
  })

  it('patch 写入点 EIO 连续 5 次：回滚 owner marker + 目录，之后正常 prepare/cleanup 仍剩 0 个目录', () => {
    const root = tempDir('lyshell-f3-patch-eio-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const location = locationOf(pkg)
    // 先留一个**正常在用的**代：回滚不得碰别的 run 目录
    const survivor = prepareBridgeRuntime({ runtimeDir, location })
    const faulty = faultyWriter('patch', 'before-write')
    for (let i = 0; i < 5; i++) {
      let caught: unknown
      try {
        prepareBridgeRuntime({ runtimeDir, location, writeFile: faulty.writeFile })
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(faulty.failure)
    }
    // F3 反证：修复前这里会剩 5 个只含 owner marker 的目录（同进程 PID 还活着，启动扫描也不会收）
    expect(runDirNames(runtimeDir)).toEqual([dirname(survivor.patchFile).split(/[\\/]/).pop()!])
    expect(existsSync(survivor.patchFile)).toBe(true)

    faulty.disarm()
    const plan = prepareBridgeRuntime({ runtimeDir, location, writeFile: faulty.writeFile })
    plan.cleanup()
    survivor.cleanup()
    expect(runDirNames(runtimeDir)).toEqual([])
  })

  it('内容已完整落盘后才报错：按完整内容证明归属并回滚（owner / patch 两个写入点）', () => {
    for (const target of ['owner', 'patch'] as const) {
      const root = tempDir(`lyshell-f3-after-${target}-`)
      const pkg = makeBridgePackage(join(root, 'pkg'))
      const runtimeDir = join(root, 'runtime')
      const faulty = faultyWriter(target, 'after-write')
      expect(() => prepareBridgeRuntime({ runtimeDir, location: locationOf(pkg), writeFile: faulty.writeFile })).toThrow(
        faulty.failure
      )
      expect(runDirNames(runtimeDir)).toEqual([])
    }
  })

  it('只写了部分内容才报错：按前缀证明归属并回滚，不留半个文件/空目录', () => {
    for (const target of ['owner', 'patch'] as const) {
      const root = tempDir(`lyshell-f3-partial-${target}-`)
      const pkg = makeBridgePackage(join(root, 'pkg'))
      const runtimeDir = join(root, 'runtime')
      const faulty = faultyWriter(target, 'truncated-write')
      expect(() => prepareBridgeRuntime({ runtimeDir, location: locationOf(pkg), writeFile: faulty.writeFile })).toThrow(
        faulty.failure
      )
      expect(runDirNames(runtimeDir)).toEqual([])
    }
  })

  it('归属无法证明（路径上是别人的内容）：保留文件与目录，绝不递归删除，也不误删后续代', () => {
    const root = tempDir('lyshell-f3-foreign-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const location = locationOf(pkg)
    const faulty = faultyWriter('patch', 'foreign-write')
    expect(() => prepareBridgeRuntime({ runtimeDir, location, writeFile: faulty.writeFile })).toThrow(faulty.failure)

    const names = runDirNames(runtimeDir)
    expect(names.length).toBe(1)
    const dir = join(runtimeDir, names[0])
    // 别人的 patch 内容原样保留；目录因非空而保留（rmdir 失败，绝不递归删除）。
    // 任一文件归属不明时保留整个 run，包括 owner，供后续诊断。
    expect(readFileSync(join(dir, BRIDGE_PATCH_FILE_NAME), 'utf8')).toBe('other-generation: not ours\n')
    expect(existsSync(join(dir, BRIDGE_RUN_OWNER_FILE_NAME))).toBe(true)

    // 归属不明的残留不得妨碍后续正常代
    const plan = prepareBridgeRuntime({ runtimeDir, location })
    plan.cleanup()
    expect(existsSync(dir)).toBe(true)
  })

  it('run 目录已存在（碰撞）：拒绝且不写、不覆盖、不删除已有资源', () => {
    const root = tempDir('lyshell-f3-collision-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const location = locationOf(pkg)
    const collisionDir = join(runtimeDir, `${BRIDGE_RUN_DIR_PREFIX}fixed`)
    mkdirSync(collisionDir, { recursive: true })
    const foreignPatch = join(collisionDir, BRIDGE_PATCH_FILE_NAME)
    const foreignOwner = join(collisionDir, BRIDGE_RUN_OWNER_FILE_NAME)
    writeFileSync(join(collisionDir, 'keep.txt'), 'user data', 'utf8')
    writeFileSync(foreignPatch, '{ "owned": "by someone else" }', 'utf8')
    writeFileSync(foreignOwner, JSON.stringify({ version: 1, pid: 1, owner: 'preexisting' }), 'utf8')

    const writes: string[] = []
    const writeFile = (file: string, data: string): void => {
      writes.push(file)
      writeFileSync(file, data, 'utf8')
    }
    expect(() => prepareBridgeRuntime({ runtimeDir, location, randomRunId: () => 'fixed', writeFile })).toThrow(
      /already exists/
    )
    // 一个字节都没写进别人的目录
    expect(writes).toEqual([])
    expect(readFileSync(join(collisionDir, 'keep.txt'), 'utf8')).toBe('user data')
    expect(readFileSync(foreignPatch, 'utf8')).toBe('{ "owned": "by someone else" }')
    expect(JSON.parse(readFileSync(foreignOwner, 'utf8'))).toEqual({ version: 1, pid: 1, owner: 'preexisting' })
  })

  it('patch 写入报错期间 owner 被另一代接管：回滚不得删除该目录的任何资源', () => {
    const root = tempDir('lyshell-f3-takeover-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    let runDir = ''
    const replacement = JSON.stringify({ version: 1, pid: process.pid, owner: 'new-generation' })
    const failure = Object.assign(new Error('EIO after takeover'), { code: 'EIO' })
    expect(() => prepareBridgeRuntime({ runtimeDir, location: locationOf(pkg), writeFile: (file, content) => {
      runDir = dirname(file)
      writeFileSync(file, content, 'utf8')
      if (file.endsWith(BRIDGE_PATCH_FILE_NAME)) {
        writeFileSync(join(runDir, BRIDGE_RUN_OWNER_FILE_NAME), replacement, 'utf8')
        throw failure
      }
    } })).toThrow(failure)
    expect(readFileSync(join(runDir, BRIDGE_RUN_OWNER_FILE_NAME), 'utf8')).toBe(replacement)
    expect(readFileSync(join(runDir, BRIDGE_PATCH_FILE_NAME), 'utf8')).toBe(buildBridgePatchFile(join(pkg, 'index.mjs')))
  })

  it('mkdir 期间发生同名目录碰撞时不写入或清理碰撞目录', () => {
    const root = tempDir('lyshell-f3-mkdir-race-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const writeFile = vi.fn()
    let collisionDir = ''
    expect(() => prepareBridgeRuntime({ runtimeDir, location: locationOf(pkg), writeFile, mkdir: dir => {
      collisionDir = dir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'keep.txt'), 'other process')
      mkdirSync(dir) // 模拟独占 mkdir 发现刚出现的同名目录。
    } })).toThrow()
    expect(writeFile).not.toHaveBeenCalled()
    expect(readFileSync(join(collisionDir, 'keep.txt'), 'utf8')).toBe('other process')
  })

  it('旧版无归属标记的 run 目录不会被回滚/启动回收顺手删掉', () => {
    const root = tempDir('lyshell-f3-unmarked-')
    const pkg = makeBridgePackage(join(root, 'pkg'))
    const runtimeDir = join(root, 'runtime')
    const location = locationOf(pkg)
    const legacy = join(runtimeDir, `${BRIDGE_RUN_DIR_PREFIX}legacy`)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, BRIDGE_PATCH_FILE_NAME), buildBridgePatchFile(join(pkg, 'index.mjs')), 'utf8')
    const plan = prepareBridgeRuntime({ runtimeDir, location })
    expect(existsSync(legacy)).toBe(true)
    plan.cleanup()
    expect(existsSync(legacy)).toBe(true)
  })
})

describe('Windows 命令行 quoting', () => {
  it('含空格路径必须被双引号包裹', () => {
    expect(quoteWindowsCmdArg('C:\\a b\\p.yml')).toBe('"C:\\a b\\p.yml"')
    expect(quoteWindowsCmdArg('C:\\a\\p.yml')).toBe('C:\\a\\p.yml')
  })

  it('cmd 元字符一律拒绝（猜错的代价是把凭据交给解析错的命令行）', () => {
    for (const bad of ['C:\\a"b\\p.yml', 'C:\\a%b\\p.yml', 'C:\\a&b\\p.yml', 'C:\\a^b\\p.yml', 'C:\\a|b\\p.yml']) {
      expect(() => quoteWindowsCmdArg(bad)).toThrow(UnsafeBridgePathError)
    }
  })

  it('buildLaunchLine 保留 argv 顺序并可被进程表 tokenizer 还原', () => {
    const line = buildLaunchLine('dsh', ['web', '--patch', 'C:\\a b\\p.yml', '--port', '0', '--no-open'], quoteWindowsCmdArg)
    expect(line).toBe('dsh web --patch "C:\\a b\\p.yml" --port 0 --no-open')
  })
})

describe('桥握手解析与身份核对', () => {
  const good = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    instanceId: 'a1b2',
    instanceEpoch: 1700000000000,
    cwd: 'C:\\ws',
    dshHome: 'C:\\home',
    hostBridge: true,
      clientBundle: true,
      controlPort: 0,
  }

  it('形状完整才接受；缺字段/类型错一律 null', () => {
    expect(parseBridgeHandshake(good)).not.toBeNull()
    expect(parseBridgeHandshake({ ...good, instanceId: '' })).toBeNull()
    expect(parseBridgeHandshake({ ...good, instanceEpoch: -1 })).toBeNull()
    expect(parseBridgeHandshake({ ...good, hostBridge: false })).toBeNull()
    expect(parseBridgeHandshake({ ...good, protocolVersion: '1' })).toBeNull()
    expect(parseBridgeHandshake(null)).toBeNull()
    expect(parseBridgeHandshake([good])).toBeNull()
    expect(parseBridgeHandshake({ ...good, instanceId: 'x'.repeat(129) })).toBeNull()
  })

  it('启动身份不符即失败（同后台判据要有真实证据）', () => {
    const hs = parseBridgeHandshake(good)!
    expect(checkBridgeIdentity(hs, { cwd: good.cwd, dshHome: good.dshHome }).ok).toBe(true)
    const cwdMismatch = checkBridgeIdentity(hs, { cwd: 'C:\\other', dshHome: good.dshHome })
    expect(cwdMismatch.ok).toBe(false)
    const homeMismatch = checkBridgeIdentity(hs, { cwd: good.cwd, dshHome: 'C:\\other' })
    expect(homeMismatch.ok).toBe(false)
    const versionMismatch = checkBridgeIdentity({ ...hs, protocolVersion: 1 }, { cwd: good.cwd, dshHome: good.dshHome })
    expect(versionMismatch.ok).toBe(false)
  })

  it('host-only key 常量时间比较：空/短/错长度一律 false', () => {
    expect(bridgeKeyMatches('abc', 'abc')).toBe(true)
    expect(bridgeKeyMatches('abc', 'abd')).toBe(false)
    expect(bridgeKeyMatches('abc', 'ab')).toBe(false)
    expect(bridgeKeyMatches('abc', '')).toBe(false)
    expect(bridgeKeyMatches('abc', undefined)).toBe(false)
  })
})

describe('桥握手请求（真实回环 HTTP）', () => {
  const servers: http.Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  })

  async function serve(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<string> {
    const server = http.createServer(handler)
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return `http://127.0.0.1:${port}/`
  }

  it('带正确 host-only 头取得身份；凭据只走请求头，不进 URL/query', async () => {
    const seen: { url?: string; key?: string; cookie?: string } = {}
    const origin = await serve((req, res) => {
      seen.url = req.url
      seen.key = req.headers[BRIDGE_KEY_HEADER] as string | undefined
      seen.cookie = req.headers.cookie
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        instanceId: 'inst-1',
        instanceEpoch: 1234,
        cwd: 'C:\\ws',
        dshHome: 'C:\\home',
        hostBridge: true,
      clientBundle: true,
      controlPort: 0,
      }))
    })
    const result = await requestBridgeHandshake({ origin, key: 'k'.repeat(64), cookie: 'dsh=a' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.handshake.instanceId).toBe('inst-1')
      expect(result.handshake.instanceEpoch).toBe(1234)
    }
    expect(seen.key).toBe('k'.repeat(64))
    expect(seen.cookie).toBe('dsh=a')
    expect(seen.url).toBe(BRIDGE_HANDSHAKE_PATH)
    expect(seen.url).not.toContain('k'.repeat(64))
  })

  it('401 / 非 200 / 畸形 JSON / 缺字段 → 固定分类失败原因（不回显响应体）', async () => {
    const unauthorized = await serve((_req, res) => {
      res.writeHead(401)
      res.end('{"error":"unauthorized"}')
    })
    const r401 = await requestBridgeHandshake({ origin: unauthorized, key: 'k' })
    expect(r401.ok).toBe(false)
    if (!r401.ok) expect(r401.reason).toContain('host-only credential')

    const missing = await serve((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    const r404 = await requestBridgeHandshake({ origin: missing, key: 'k' })
    expect(r404.ok).toBe(false)
    if (!r404.ok) expect(r404.reason).toContain('status 404')
    if (!r404.ok) expect(r404.reason).not.toContain('nope')

    const malformed = await serve((_req, res) => {
      res.writeHead(200)
      res.end('not-json')
    })
    const rBad = await requestBridgeHandshake({ origin: malformed, key: 'k' })
    expect(rBad.ok).toBe(false)

    const partial = await serve((_req, res) => {
      res.writeHead(200)
      res.end(JSON.stringify({ protocolVersion: 1, hostBridge: true }))
    })
    const rPartial = await requestBridgeHandshake({ origin: partial, key: 'k' })
    expect(rPartial.ok).toBe(false)
    if (!rPartial.ok) expect(rPartial.reason).toContain('incomplete')
  })

  it('后台没带桥（连接被拒/无该路由）→ 明确失败，不猜成功', async () => {
    // 关掉监听端口的服务器：连接必然失败
    const origin = await serve((_req, res) => res.end('x'))
    await new Promise<void>((r) => servers.splice(0).forEach((s) => s.close(() => r())))
    const result = await requestBridgeHandshake({ origin, key: 'k', timeoutMs: 2000 })
    expect(result.ok).toBe(false)
  })
})

interface RegisteredRoute {
  path: string
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
}

interface HostHalfModule {
  apply: (ctx: unknown) => void
}

const bridgeIndexSource = (): string =>
  readFileSync(join(process.cwd(), 'resources', 'dsh-bridge', 'index.mjs'), 'utf8')

/** 每次 import 换一个 query（模块按 URL 缓存，否则同 URL 不会重新执行 apply） */
let loadSeq = 0

/**
 * 在**真实 ESM 装载路径**下执行 host 半：把产品源码复制成临时包目录里的 `index.mjs`，再用
 * `file:` URL（带 query 做 cache bust，因为模块按 URL 缓存）真实 import。
 * 这样 `import.meta.url` 就是该临时包自己的路径，产品代码里**不需要**任何测试专用分支。
 */
async function loadHostHalf(moduleDir: string): Promise<HostHalfModule> {
  const entry = join(moduleDir, 'index.mjs')
  writeFileSync(entry, bridgeIndexSource(), 'utf8')
  for (const file of ['work-journal.mjs', 'work-state.mjs']) {
    writeFileSync(join(moduleDir, file), readFileSync(join(process.cwd(), 'resources/dsh-bridge', file)))
  }
  const url = `${pathToFileURL(entry).href}?case=${loadSeq++}`
  return (await import(/* @vite-ignore */ url)) as HostHalfModule
}

describe('host 半（index.mjs）：真实执行下的凭据与 clientBundle 事实', () => {
  const KEY_ENV_NAME = 'LYSHELL_HARNESS_BRIDGE_KEY'

  afterEach(() => {
    delete process.env[KEY_ENV_NAME]
  })

  async function applyAndGetRoutes(moduleDir: string): Promise<RegisteredRoute[]> {
    const routes: RegisteredRoute[] = []
    const ctx = {
      webServer: {
        register: (route: RegisteredRoute) => {
          routes.push(route)
          return () => {}
        }
      },
      // S3 起 host 半还注册独占控制监听与 gate/审批监听：这里只测 S2 的握手面，
      // 事件注册与官方服务查询给最小替身（真实行为见 exclusive-bridge.test.ts）
      on: () => () => {},
      get: () => undefined,
      effect: (fn: () => unknown) => {
        fn()
        return () => {}
      }
    }
    const mod = await loadHostHalf(moduleDir)
    mod.apply(ctx as never)
    return routes
  }

  function callRoute(route: RegisteredRoute, key: string | undefined): Promise<{ status: number; body: string }> {
    return new Promise((resolvePromise) => {
      const server = http.createServer((req, res) => route.handler(req, res))
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: route.path,
            headers: key === undefined ? {} : { [BRIDGE_KEY_HEADER]: key }
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              server.close()
              resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
            })
          }
        )
        req.on('error', () => {
          server.close()
          resolvePromise({ status: 0, body: '' })
        })
        req.end()
      })
    })
  }

  it('无凭据 env：不注册任何路由（fail closed），且不写任何凭据', async () => {
    delete process.env[KEY_ENV_NAME]
    const dir = join(tempDir('lyshell-hosthalf-nokey-'), 'dsh-bridge')
    makeBridgePackage(dir)
    makeBridgeManifest(dir)
    const routes = await applyAndGetRoutes(dir)
    expect(routes).toEqual([])
  })

  function makeBridgeManifest(dir: string, over: Record<string, unknown> = {}): string {
    const manifest = join(dir, 'package.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        name: BRIDGE_PACKAGE_NAME,
        exports: { './client': './client.js' },
        dsh: { client: { platform: 'web' } },
        ...over
      }),
      'utf8'
    )
    return manifest
  }

  it('无 key / 错 key 一律 401；正确 key 才握手成功，且 env 里的 key 已被抹掉', async () => {
    const dir = join(tempDir('lyshell-hosthalf-'), 'dsh-bridge')
    makeBridgePackage(dir)
    makeBridgeManifest(dir)
    const key = 'a'.repeat(64)
    process.env[KEY_ENV_NAME] = key
    const routes = await applyAndGetRoutes(dir)
    // S4 起宿主半注册一族路由：握手 + 三个 viewer（status/ack/browse，同源签名 cookie）
    expect(routes.length).toBe(4)
    expect(routes[0].path).toBe(BRIDGE_HANDSHAKE_PATH)
    expect(routes.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        BRIDGE_HANDSHAKE_PATH,
        '/__lyshell/harness/viewer/status',
        '/__lyshell/harness/viewer/ack',
        '/__lyshell/harness/viewer/browse'
      ])
    )
    // 关键：注入的 host-only key 不得留在 process.env 里给后续工具子进程继承
    expect(process.env[KEY_ENV_NAME]).toBeUndefined()

    const noKey = await callRoute(routes[0], undefined)
    expect(noKey.status).toBe(401)
    const wrongKey = await callRoute(routes[0], 'b'.repeat(64))
    expect(wrongKey.status).toBe(401)

    const ok = await callRoute(routes[0], key)
    expect(ok.status).toBe(200)
    const payload = JSON.parse(ok.body) as {
      protocolVersion: number
      instanceId: string
      instanceEpoch: number
      hostBridge: boolean
      clientBundle: boolean
      clientBundleFile: string | null
    }
    expect(payload.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION)
    expect(payload.instanceId.length).toBeGreaterThan(0)
    expect(payload.instanceEpoch).toBeGreaterThan(0)
    expect(payload.hostBridge).toBe(true)
    // clientBundle 是**实测事实**（exports['./client'] 指向的文件真实存在且可读 ⇒ true）
    expect(payload.clientBundle).toBe(true)
    expect(payload.clientBundleFile).toBe('client.js')
    // 凭据绝不进响应体
    expect(ok.body).not.toContain(key)
  })

  it('clientBundle 只由可读文件事实决定：缺 exports / 指向缺失文件 / 平台不符 / 不可读 一律 false', async () => {
    const dir = join(tempDir('lyshell-hosthalf-bad-'), 'dsh-bridge')
    makeBridgePackage(dir)

    // exports 里没有 ./client
    makeBridgeManifest(dir, { exports: {} })
    process.env[KEY_ENV_NAME] = 'c'.repeat(64)
    const routes = await applyAndGetRoutes(dir)
    const payload = JSON.parse((await callRoute(routes[0], 'c'.repeat(64))).body) as { clientBundle: boolean }
    expect(payload.clientBundle).toBe(false)

    // exports 指向的文件不存在 ⇒ false
    makeBridgeManifest(dir, { exports: { './client': './gone.js' } })
    process.env[KEY_ENV_NAME] = 'd'.repeat(64)
    const routes2 = await applyAndGetRoutes(dir)
    const payload2 = JSON.parse((await callRoute(routes2[0], 'd'.repeat(64))).body) as { clientBundle: boolean }
    expect(payload2.clientBundle).toBe(false)

    // 平台声明不符（非 web）⇒ false
    makeBridgeManifest(dir, { dsh: { client: { platform: 'tui' } } })
    process.env[KEY_ENV_NAME] = 'e'.repeat(64)
    const routes3 = await applyAndGetRoutes(dir)
    const payload3 = JSON.parse((await callRoute(routes3[0], 'e'.repeat(64))).body) as { clientBundle: boolean }
    expect(payload3.clientBundle).toBe(false)

    // 「存在但读不出内容」⇒ false：判据必须是可读事实（statSync 只证明存在，不足以当判据）
    makeBridgeManifest(dir)
    mkdirSync(join(dir, 'client-as-dir'), { recursive: true })
    makeBridgeManifest(dir, { exports: { './client': './client-as-dir' } })
    process.env[KEY_ENV_NAME] = 'g'.repeat(64)
    const routes4 = await applyAndGetRoutes(dir)
    const payload4 = JSON.parse((await callRoute(routes4[0], 'g'.repeat(64))).body) as { clientBundle: boolean }
    expect(payload4.clientBundle).toBe(false)

    // 真实产品包的 manifest 必须能判为 true（回归：能力判据与产品包一致）
    const real = locateBridgePackage({ isPackaged: false, devRoot: process.cwd() })
    expect(real).not.toBeNull()
    process.env[KEY_ENV_NAME] = 'f'.repeat(64)
    const routes5 = await applyAndGetRoutes(real!.dir)
    const payload5 = JSON.parse((await callRoute(routes5[0], 'f'.repeat(64))).body) as {
      clientBundle: boolean
      clientBundleFile: string | null
    }
    expect(payload5.clientBundle).toBe(true)
    expect(payload5.clientBundleFile).toBe('client.js')
  })

  it('源码里不再有 clientBundle 常量自报（回归：能力必须来自实测事实）', () => {
    const source = bridgeIndexSource()
    expect(source).not.toMatch(/clientBundle:\s*true/)
    // 凭据在捕获后必须从 env 抹掉
    expect(source).toContain('delete process.env[KEY_ENV]')
  })
})
