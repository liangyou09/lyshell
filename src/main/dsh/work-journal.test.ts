import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface JournalEntry {
  owner: string
  value: unknown
}

interface WorkJournal {
  loadAll: () => JournalEntry[]
  save: (owner: string, value: unknown) => void
}

interface WorkJournalModule {
  openWorkJournal: (directory: string) => WorkJournal
}

interface CodedError {
  code?: unknown
}

const JOURNAL_ENTRY = join(process.cwd(), 'resources', 'dsh-bridge', 'work-journal.mjs')
const MAX_BYTES = 8 * 1024 * 1024

let loadedModule: Promise<WorkJournalModule> | null = null

/** 走真实 ESM 装载路径导入产品源码；`@vite-ignore` 防止 Vite 试图静态解析绝对 file: URL。 */
function journalModule(): Promise<WorkJournalModule> {
  loadedModule ??= import(/* @vite-ignore */ pathToFileURL(JOURNAL_ENTRY).href) as Promise<WorkJournalModule>
  return loadedModule
}

async function openJournal(directory: string): Promise<WorkJournal> {
  return (await journalModule()).openWorkJournal(directory)
}

const tempDirs: string[] = []

function tempDir(prefix = 'lyshell-work-journal-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // 有的用例会把目录临时收紧到 0500，清理前先恢复；Windows 上 chmod 语义不同，跳过。
    if (process.platform !== 'win32') {
      try {
        chmodSync(dir, 0o700)
      } catch {
        // 目录可能已被用例删掉。
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 与产品契约一致：owner 是 SHA-256 的小写十六进制（不是原始 token）。 */
function owner(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

function checksumOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)!).digest('hex')
}

function catchCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return String((error as CodedError).code)
  }
}

function journalFileName(target: string): string {
  return `${target}.json`
}

function readPayload(directory: string, target: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, journalFileName(target)), 'utf8')) as Record<string, unknown>
}

/** 探测平台是否允许创建文件/目录符号链接，链接用例按需跳过而不是假装通过。 */
const symlinkSupport = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'lyshell-work-journal-probe-'))
  try {
    writeFileSync(join(dir, 'target.json'), '{}')
    mkdirSync(join(dir, 'target-dir'))
    let file = true
    let dirLink = true
    try {
      symlinkSync(join(dir, 'target.json'), join(dir, 'file-link.json'), 'file')
    } catch {
      file = false
    }
    try {
      symlinkSync(join(dir, 'target-dir'), join(dir, 'dir-link'), 'junction')
    } catch {
      dirLink = false
    }
    return { file, dirLink }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe('工作日志：持久格式与跨实例重载', () => {
  it('保存后由新 store 实例重载，落盘格式、checksum 与权限符合契约', async () => {
    const dir = tempDir()
    const alpha = owner('alpha')
    const beta = owner('beta')
    const alphaValue = { revision: 4, sessions: [{ id: 's-1', running: true }], note: null }
    const betaValue = ['queued', 2, { approval: false }]

    const first = await openJournal(dir)
    first.save(alpha, alphaValue)
    first.save(beta, betaValue)

    const second = await openJournal(dir)
    const entries = second.loadAll()
    expect(entries.map(entry => entry.owner)).toEqual([alpha, beta].sort())
    const byOwner = new Map(entries.map(entry => [entry.owner, entry.value]))
    expect(byOwner.get(alpha)).toEqual(alphaValue)
    expect(byOwner.get(beta)).toEqual(betaValue)

    const raw = readPayload(dir, alpha)
    expect(raw).toEqual({
      version: 1,
      owner: alpha,
      value: alphaValue,
      checksum: checksumOf(alphaValue)
    })

    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, journalFileName(alpha))).mode & 0o777).toBe(0o600)
    }
  })

  it('支持 JSON 的各种 value 形态，重载后内容一致', async () => {
    const dir = tempDir()
    const store = await openJournal(dir)
    const cases: Array<[string, unknown]> = [
      ['null', null],
      ['false', false],
      ['zero', 0],
      ['empty-string', ''],
      ['number', 42.5],
      ['text', '任务日志 / emoji 🚀'],
      ['array', [1, 'two', null]],
      ['object', { nested: { deeper: [true, { last: '值' }] } }]
    ]
    for (const [name, value] of cases) store.save(owner(name), value)

    const entries = store.loadAll()
    expect(entries).toHaveLength(cases.length)
    const byOwner = new Map(entries.map(entry => [entry.owner, entry.value]))
    for (const [name, value] of cases) expect(byOwner.get(owner(name))).toEqual(value)
  })

  it('loadAll 确定性排序，且每次返回深隔离的反序列化对象', async () => {
    const dir = tempDir()
    const store = await openJournal(dir)
    const targets = [owner('third'), owner('first'), owner('second')]
    for (const target of targets) store.save(target, { nested: { n: 1 }, list: [1, 2] })

    const first = store.loadAll()
    expect(first.map(entry => entry.owner)).toEqual([...targets].sort())

    const mutable = first[0].value as { nested: { n: number }; list: number[] }
    mutable.nested.n = 99
    mutable.list.push(3)

    const second = store.loadAll()
    expect(second[0].value).toEqual({ nested: { n: 1 }, list: [1, 2] })
    expect(second).not.toBe(first)
    expect(second[0]).not.toBe(first[0])
  })

  it('root 不存在时按 0700 创建（含多级父目录）且初始为空', async () => {
    const base = tempDir()
    const dir = join(base, 'nested', 'journal')
    const store = await openJournal(dir)
    expect(store.loadAll()).toEqual([])
    expect(lstatSync(dir).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('已有的宽松目录会被收紧到 0700（POSIX）', async () => {
    const dir = tempDir()
    if (process.platform === 'win32') return
    chmodSync(dir, 0o755)
    await openJournal(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('工作日志：写入语义', () => {
  it('同一 owner 更新为最新值，成功后不残留临时文件', async () => {
    const dir = tempDir()
    const target = owner('update')
    const store = await openJournal(dir)

    store.save(target, { round: 1 })
    store.save(target, { round: 2 })

    const entries = store.loadAll()
    expect(entries).toEqual([{ owner: target, value: { round: 2 } }])
    expect(readPayload(dir, target).checksum).toBe(checksumOf({ round: 2 }))
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('不同 owner 的写入互不覆盖（多个 store 实例交错写）', async () => {
    const dir = tempDir()
    const stores = await Promise.all([openJournal(dir), openJournal(dir), openJournal(dir)])
    const owners = Array.from({ length: 12 }, (_, index) => owner(`parallel-${index}`))

    // save 是同步事务；这里用多个独立实例交错提交，验证它们只触碰自己的 owner 文件。
    await Promise.all(
      owners.map((target, index) =>
        Promise.resolve().then(() => stores[index % stores.length].save(target, { index }))
      )
    )

    const entries = (await openJournal(dir)).loadAll()
    expect(entries).toHaveLength(owners.length)
    const byOwner = new Map(entries.map(entry => [entry.owner, entry.value]))
    for (const [index, target] of owners.entries()) expect(byOwner.get(target)).toEqual({ index })
  })

  it('目录消失后 loadAll / save 明确报错，不回落成空状态', async () => {
    const base = tempDir()
    const dir = join(base, 'journal')
    const store = await openJournal(dir)
    rmSync(dir, { recursive: true, force: true })

    expect(catchCode(() => store.loadAll())).toBe('journal/io')
    expect(catchCode(() => store.save(owner('gone'), { ok: true }))).toBe('journal/io')
    expect(existsSync(dir)).toBe(false)
  })
})

describe('工作日志：读取校验 fail-closed', () => {
  const corruptCases: Array<{ name: string; build: (target: string) => string }> = [
    { name: '非法 JSON', build: () => '{"version":1,' },
    { name: '顶层不是对象', build: () => '[]' },
    {
      name: '版本不为 1',
      build: target =>
        JSON.stringify({ version: 2, owner: target, value: { ok: true }, checksum: checksumOf({ ok: true }) })
    },
    {
      name: 'owner 与文件名不一致',
      build: () =>
        JSON.stringify({ version: 1, owner: owner('other'), value: { ok: true }, checksum: checksumOf({ ok: true }) })
    },
    {
      name: 'checksum 不匹配',
      build: target =>
        JSON.stringify({ version: 1, owner: target, value: { ok: true }, checksum: '0'.repeat(64) })
    },
    {
      name: '缺少 value 字段',
      build: target => JSON.stringify({ version: 1, owner: target, checksum: '0'.repeat(64) })
    },
    {
      name: 'checksum 不是字符串',
      build: target => JSON.stringify({ version: 1, owner: target, value: { ok: true }, checksum: 7 })
    }
  ]

  for (const corruptCase of corruptCases) {
    it(`损坏条目整批报错：${corruptCase.name}`, async () => {
      const dir = tempDir()
      const target = owner(`corrupt-${corruptCase.name}`)
      writeFileSync(join(dir, journalFileName(target)), corruptCase.build(target), 'utf8')
      const store = await openJournal(dir)
      expect(catchCode(() => store.loadAll())).toBe('journal/corrupt')
    })
  }

  it('同目录存在损坏条目时整批报错，不静默跳过并返回其余条目', async () => {
    const dir = tempDir()
    const healthy = owner('healthy')
    const broken = owner('broken')
    const value = { revision: 9 }
    writeFileSync(
      join(dir, journalFileName(healthy)),
      JSON.stringify({ version: 1, owner: healthy, value, checksum: checksumOf(value) }),
      'utf8'
    )
    writeFileSync(join(dir, journalFileName(broken)), '{"version":1}', 'utf8')
    const store = await openJournal(dir)
    expect(catchCode(() => store.loadAll())).toBe('journal/corrupt')
  })

  it('超过 8 MiB 的日志文件按超限拒绝，不做部分解析', async () => {
    const dir = tempDir()
    const target = owner('oversize-file')
    writeFileSync(join(dir, journalFileName(target)), 'x'.repeat(MAX_BYTES + 1), 'utf8')
    const store = await openJournal(dir)
    expect(catchCode(() => store.loadAll())).toBe('journal/too-large')
  })

  it('规范文件超过 64 个时整批拒绝', async () => {
    const dir = tempDir()
    for (let index = 0; index < 65; index++) {
      writeFileSync(join(dir, journalFileName(owner(`overflow-${index}`))), '{}', 'utf8')
    }
    const store = await openJournal(dir)
    expect(catchCode(() => store.loadAll())).toBe('journal/too-many-owners')
  })

  it('规范名对应目录（非普通文件）时报错', async () => {
    const dir = tempDir()
    const target = owner('directory-entry')
    mkdirSync(join(dir, journalFileName(target)))
    const store = await openJournal(dir)
    expect(catchCode(() => store.loadAll())).toBe('journal/unsafe-path')
  })

  it.runIf(symlinkSupport.file)('规范名是符号链接时报错且不跟随目标', async () => {
    const dir = tempDir()
    const outside = tempDir('lyshell-work-journal-outside-')
    const target = owner('symlink-entry')
    const value = { leaked: false }
    const outsideFile = join(outside, 'payload.json')
    writeFileSync(
      outsideFile,
      JSON.stringify({ version: 1, owner: target, value, checksum: checksumOf(value) }),
      'utf8'
    )
    symlinkSync(outsideFile, join(dir, journalFileName(target)), 'file')
    const store = await openJournal(dir)
    expect(catchCode(() => store.loadAll())).toBe('journal/unsafe-path')
  })
})

describe('工作日志：容量边界与写失败', () => {
  it('最多容纳 64 个 owner；第 65 个被拒，已有 owner 仍可更新', async () => {
    const dir = tempDir()
    const store = await openJournal(dir)
    const owners = Array.from({ length: 64 }, (_, index) => owner(`capacity-${index}`))
    for (const [index, target] of owners.entries()) store.save(target, { index })

    expect(store.loadAll()).toHaveLength(64)
    expect(catchCode(() => store.save(owner('capacity-65'), { index: 65 }))).toBe('journal/too-many-owners')
    store.save(owners[0], { index: 0, updated: true })
    expect(store.loadAll().find(entry => entry.owner === owners[0])?.value).toEqual({ index: 0, updated: true })
  })

  it('接近 8 MiB 的 value 可往返，超过上限的 value 被拒且不破坏既有日志', async () => {
    const dir = tempDir()
    const target = owner('large-value')
    const store = await openJournal(dir)
    store.save(target, { kept: true })

    const nearLimit = 'x'.repeat(MAX_BYTES - 4096)
    store.save(owner('near-limit'), nearLimit)
    const entries = store.loadAll()
    const loaded = entries.find(entry => entry.owner === owner('near-limit'))?.value
    expect(typeof loaded).toBe('string')
    expect((loaded as string).length).toBe(nearLimit.length)
    expect((loaded as string).slice(0, 8)).toBe('xxxxxxxx')
    expect(statSync(join(dir, journalFileName(owner('near-limit')))).size).toBeLessThanOrEqual(MAX_BYTES)

    // 序列化后超过 value 上限。
    expect(catchCode(() => store.save(owner('too-large-value'), 'y'.repeat(MAX_BYTES)))).toBe('journal/too-large')
    // 序列化 value 未超上限，但拼上格式外壳后整文件超上限。
    expect(catchCode(() => store.save(owner('too-large-file'), 'z'.repeat(MAX_BYTES - 64)))).toBe('journal/too-large')
    expect(store.loadAll().find(entry => entry.owner === target)?.value).toEqual({ kept: true })
  })

  it('写事务失败时既有日志仍可读，且不残留临时文件', async () => {
    const dir = tempDir()
    const stable = owner('stable')
    const changing = owner('changing')
    const store = await openJournal(dir)
    store.save(stable, { round: 1 })
    store.save(changing, { round: 1 })

    if (process.platform === 'win32') {
      // Windows：rename 覆盖只读目标会失败，正好在临时文件写完、rename 阶段注入失败。
      chmodSync(join(dir, journalFileName(changing)), 0o444)
    } else {
      // POSIX：目录不可写时临时独占文件创建失败。
      chmodSync(dir, 0o500)
    }
    try {
      expect(catchCode(() => store.save(changing, { round: 2 }))).toBe('journal/io')
    } finally {
      if (process.platform === 'win32') chmodSync(join(dir, journalFileName(changing)), 0o666)
      else chmodSync(dir, 0o700)
    }

    const entries = store.loadAll()
    expect(entries.find(entry => entry.owner === stable)?.value).toEqual({ round: 1 })
    expect(entries.find(entry => entry.owner === changing)?.value).toEqual({ round: 1 })
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('无法 JSON 序列化的 value 被拒，既有日志保持可读', async () => {
    const dir = tempDir()
    const target = owner('serialize')
    const store = await openJournal(dir)
    store.save(target, { kept: true })

    expect(catchCode(() => store.save(owner('undefined'), undefined))).toBe('journal/serialize')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(catchCode(() => store.save(owner('circular'), circular))).toBe('journal/serialize')
    expect(catchCode(() => store.save(owner('bigint'), 10n))).toBe('journal/serialize')
    expect(store.loadAll()).toEqual([{ owner: target, value: { kept: true } }])
  })
})

describe('工作日志：临时残留、未知文件与非法输入', () => {
  it('只扫描规范 owner.json；忽略 .tmp 残留与未知文件，也不删除它们', async () => {
    const dir = tempDir()
    const target = owner('canonical')
    const residue = join(dir, `.${target}.1234.0.deadbeef.tmp`)
    const halfTemp = join(dir, `${target}.json.tmp`)
    const notes = join(dir, 'notes.md')
    writeFileSync(residue, 'partial', 'utf8')
    writeFileSync(halfTemp, 'partial', 'utf8')
    writeFileSync(notes, 'not task data', 'utf8')
    writeFileSync(join(dir, 'other.json'), '{}', 'utf8')
    writeFileSync(join(dir, `${target.toUpperCase()}.json`), '{}', 'utf8')
    mkdirSync(join(dir, 'unrelated-dir'))

    const store = await openJournal(dir)
    store.save(target, { ok: true })

    expect(store.loadAll()).toEqual([{ owner: target, value: { ok: true } }])
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual(
      [residue, halfTemp].map(file => file.slice(dir.length + 1))
    )
    expect(existsSync(notes)).toBe(true)
    expect(existsSync(join(dir, 'other.json'))).toBe(true)
    expect(existsSync(join(dir, `${target.toUpperCase()}.json`))).toBe(true)
  })

  it('拒绝非法目录参数', async () => {
    const dir = tempDir()
    const module = await journalModule()
    const invalid: Array<[string, unknown]> = [
      ['空字符串', ''],
      ['相对路径', join('relative', 'journal')],
      ['非字符串', 42],
      ['含 NUL', join(dir, 'bad\u0000name')]
    ]
    for (const [name, value] of invalid) {
      expect(catchCode(() => module.openWorkJournal(value as string)), name).toBe('journal/bad-directory')
    }
  })

  it('root 是普通文件时报错', async () => {
    const base = tempDir()
    const target = join(base, 'not-a-dir')
    writeFileSync(target, 'x', 'utf8')
    const module = await journalModule()
    expect(catchCode(() => module.openWorkJournal(target))).toBe('journal/unsafe-path')
  })

  it.runIf(symlinkSupport.dirLink)('root 是符号链接时报错', async () => {
    const base = tempDir()
    const real = join(base, 'real')
    const link = join(base, 'linked')
    mkdirSync(real)
    symlinkSync(real, link, 'junction')
    const module = await journalModule()
    expect(catchCode(() => module.openWorkJournal(link))).toBe('journal/unsafe-path')
  })

  it('拒绝非法 owner（大小写/长度/字符/类型）', async () => {
    const dir = tempDir()
    const store = await openJournal(dir)
    const invalid: Array<[string, unknown]> = [
      ['大写十六进制', 'A'.repeat(64)],
      ['长度 63', 'a'.repeat(63)],
      ['长度 65', 'a'.repeat(65)],
      ['非十六进制字符', 'z'.repeat(64)],
      ['空字符串', ''],
      ['非字符串', 123]
    ]
    for (const [name, value] of invalid) {
      expect(catchCode(() => store.save(value as string, { ok: true })), name).toBe('journal/bad-owner')
    }
    expect(store.loadAll()).toEqual([])
  })

  it.runIf(symlinkSupport.file)('save 拒绝对规范名符号链接写入', async () => {
    const dir = tempDir()
    const outside = tempDir('lyshell-work-journal-outside-')
    const target = owner('symlink-save')
    const outsideFile = join(outside, 'keep.json')
    writeFileSync(outsideFile, 'keep', 'utf8')
    symlinkSync(outsideFile, join(dir, journalFileName(target)), 'file')
    const store = await openJournal(dir)
    expect(catchCode(() => store.save(target, { ok: true }))).toBe('journal/unsafe-path')
    expect(readFileSync(outsideFile, 'utf8')).toBe('keep')
  })
})
