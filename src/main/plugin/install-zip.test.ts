/**
 * install-zip 单元测试 -- zip-slip 防护 + manifest 读取 + 路径包含断言。
 *
 * 纯逻辑 + 临时目录 IO(对齐仓库现有 *.test.ts 模式)。恶意 zip 用 adm-zip 现造,
 * 无需 fixture 文件。详见 docs/plugin-system-design.md §8.3 / §8.4。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertSafeEntryName,
  assertUnderBase,
  assertZipFileSize,
  atomicSwapPlugin,
  extractZipSafely,
  isLoopbackOrLinkLocalHost,
  readManifestFromZip,
  safeDeleteDownload,
  writeEntryCapped,
  ZipBombError,
  ZipSlipError
} from './install-zip'

/** 合法 manifest(满足 validateManifest 全部校验)。 */
const VALID_MANIFEST = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  engines: { lyshell: '^1.0' },
  runtime: 'node',
  activationEvents: ['onStartup'],
  capabilities: ['read']
}

const manifestBuf = (m: unknown = VALID_MANIFEST): Buffer =>
  Buffer.from(JSON.stringify(m), 'utf-8')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lyshell-zip-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * 写一个 zip 到 tmp 下指定文件名,返回绝对路径。addFile 入参为 entryName -> data。
 * 注意:adm-zip 的 addFile 会净化 ../ 等危险名;为如实落盘测试用的恶意名,addFile 后
 * 覆写 entry.entryName 为请求值(已实测 writeZip 会采用覆写后的名)。正常名不受影响。
 */
function writeZip(name: string, entries: Array<[string, Buffer]>): string {
  const zipPath = join(tmp, name)
  const zip = new AdmZip()
  for (const [entryName, data] of entries) {
    const entry = zip.addFile(entryName, data)
    if (entry.entryName !== entryName) entry.entryName = entryName
  }
  zip.writeZip(zipPath)
  return zipPath
}

describe('assertSafeEntryName', () => {
  it('accepts normal relative names (normalized to forward slash, strip leading ./)', () => {
    expect(assertSafeEntryName('dist/main.js')).toBe('dist/main.js')
    expect(assertSafeEntryName('./lyshell-plugin.json')).toBe('lyshell-plugin.json')
    expect(assertSafeEntryName('dist\\sub\\x.js')).toBe('dist/sub/x.js')
  })

  it('rejects empty name', () => {
    expect(() => assertSafeEntryName('')).toThrow(ZipSlipError)
    expect(() => assertSafeEntryName('./')).toThrow(ZipSlipError)
  })

  it('rejects NUL byte', () => {
    expect(() => assertSafeEntryName('evil\0.txt')).toThrow(ZipSlipError)
  })

  it('rejects absolute unix path', () => {
    expect(() => assertSafeEntryName('/etc/passwd')).toThrow(ZipSlipError)
  })

  it('rejects Windows drive letter', () => {
    expect(() => assertSafeEntryName('C:/evil')).toThrow(ZipSlipError)
    expect(() => assertSafeEntryName('D:\\evil')).toThrow(ZipSlipError)
  })

  it('rejects .. traversal (classic zip-slip)', () => {
    expect(() => assertSafeEntryName('../evil.txt')).toThrow(ZipSlipError)
    expect(() => assertSafeEntryName('subdir/../../evil.txt')).toThrow(ZipSlipError)
    expect(() => assertSafeEntryName('a/../b')).toThrow(ZipSlipError)
  })
})

describe('assertUnderBase', () => {
  it('accepts target inside base', () => {
    expect(() => assertUnderBase(join(tmp, 'child', 'x'), tmp)).not.toThrow()
    expect(() => assertUnderBase(join(tmp, 'x'), tmp)).not.toThrow()
  })

  it('accepts target === base', () => {
    expect(() => assertUnderBase(tmp, tmp)).not.toThrow()
  })

  it('rejects sibling outside base', () => {
    expect(() => assertUnderBase(join(tmp, '..', 'sibling'), tmp)).toThrow(ZipSlipError)
  })

  it('rejects .. traversal', () => {
    expect(() => assertUnderBase(join(tmp, '..', '..', 'etc'), tmp)).toThrow(ZipSlipError)
  })

  // 跨盘符仅在 Windows 有意义(relative 返回绝对路径)
  const itOnWin = process.platform === 'win32' ? it : it.skip
  itOnWin('rejects cross-drive path (Windows)', () => {
    expect(() => assertUnderBase('D:\\evil', 'C:\\base')).toThrow(ZipSlipError)
  })
})

describe('extractZipSafely', () => {
  it('extracts a normal zip (files + nested dirs) into destDir', async () => {
    const zipPath = writeZip('normal.zip', [
      ['lyshell-plugin.json', manifestBuf()],
      ['dist/main.js', Buffer.from('console.log("hi")')],
      ['dist/sub/nested.js', Buffer.from('// nested')],
      ['README.md', Buffer.from('# test')]
    ])
    const dest = join(tmp, 'dest')
    await extractZipSafely(zipPath, dest)

    expect(existsSync(join(dest, 'lyshell-plugin.json'))).toBe(true)
    expect(existsSync(join(dest, 'dist/main.js'))).toBe(true)
    expect(existsSync(join(dest, 'dist/sub/nested.js'))).toBe(true)
    expect(readFileSync(join(dest, 'dist/main.js'), 'utf-8')).toBe('console.log("hi")')
  })

  it('rejects zip with ../ entry (classic zip-slip) and writes nothing outside', async () => {
    const zipPath = writeZip('slip.zip', [
      ['lyshell-plugin.json', manifestBuf()],
      ['../evil.txt', Buffer.from('pwned')]
    ])
    const dest = join(tmp, 'dest')
    await expect(extractZipSafely(zipPath, dest)).rejects.toThrow(ZipSlipError)
    // 逃逸文件不得落到 dest 的父目录(tmp)
    expect(existsSync(join(tmp, 'evil.txt'))).toBe(false)
  })

  it('rejects zip with subdir/../../ entry', async () => {
    const zipPath = writeZip('slip2.zip', [
      ['lyshell-plugin.json', manifestBuf()],
      ['dist/../../evil2.txt', Buffer.from('pwned')]
    ])
    const dest = join(tmp, 'dest')
    await expect(extractZipSafely(zipPath, dest)).rejects.toThrow(ZipSlipError)
    expect(existsSync(join(tmp, 'evil2.txt'))).toBe(false)
  })

  it('throws on unreadable zip path', async () => {
    await expect(extractZipSafely(join(tmp, 'nope.zip'), join(tmp, 'dest'))).rejects.toThrow(
      /无法读取 zip/
    )
  })
})

describe('extractZipSafely / writeEntryCapped zip-bomb 防护 (评审 #4)', () => {
  it('rejects honest zip-bomb at declared-size precheck (single entry over cap)', async () => {
    // 5MB 高压缩比条目:声明解压 5MB(诚实 header),maxEntry=1MB -> 预检直接拒(不碰盘/不分配)
    const zipPath = writeZip('bomb-honest.zip', [
      ['lyshell-plugin.json', manifestBuf()],
      ['big.bin', Buffer.alloc(5 * 1024 * 1024, 0x41)]
    ])
    const dest = join(tmp, 'dest')
    const p = extractZipSafely(zipPath, dest, { maxEntryBytes: 1024 * 1024 })
    await expect(p).rejects.toThrow(ZipBombError)
    await expect(p).rejects.toThrow(/声明解压.*单条上限/)
    // 预检在解压前拒绝,big.bin 不应落盘
    expect(existsSync(join(dest, 'big.bin'))).toBe(false)
  })

  it('rejects honest zip-bomb at declared-size precheck (total over cap)', async () => {
    // 两条 600KB 条目:单条不超 maxEntry(10MB),但总和 ~1.2MB > maxTotal(1MB) -> 预检拒
    const zipPath = writeZip('bomb-total.zip', [
      ['lyshell-plugin.json', manifestBuf()],
      ['a.bin', Buffer.alloc(600 * 1024, 0x41)],
      ['b.bin', Buffer.alloc(600 * 1024, 0x42)]
    ])
    const dest = join(tmp, 'dest')
    const p = extractZipSafely(zipPath, dest, {
      maxEntryBytes: 10 * 1024 * 1024,
      maxTotalBytes: 1024 * 1024
    })
    await expect(p).rejects.toThrow(ZipBombError)
    await expect(p).rejects.toThrow(/声明解压总大小/)
  })

  it('streaming cap rejects over-cap entry via writeEntryCapped (单条上限)', async () => {
    // 直测流式回退:5MB 条目,maxEntry=1MB -> 流式解压到 1MB+ 即拒(绕过预检路径)
    const zipPath = writeZip('stream-entry.zip', [['big.bin', Buffer.alloc(5 * 1024 * 1024, 0x41)]])
    const entry = new AdmZip(zipPath).getEntries().find((e) => !e.isDirectory)!
    const target = join(tmp, 'out.bin')
    const p = writeEntryCapped(entry, target, 1024 * 1024, 10 * 1024 * 1024, 0)
    await expect(p).rejects.toThrow(ZipBombError)
    await expect(p).rejects.toThrow(/解压超过单条上限/)
  })

  it('streaming cap rejects over-total via writeEntryCapped (总量上限)', async () => {
    const zipPath = writeZip('stream-total.zip', [['big.bin', Buffer.alloc(5 * 1024 * 1024, 0x41)]])
    const entry = new AdmZip(zipPath).getEntries().find((e) => !e.isDirectory)!
    const target = join(tmp, 'out.bin')
    // maxEntry=10MB(单条不超),maxTotal=1MB:5MB 流式到 1MB+ 触发总量上限
    const p = writeEntryCapped(entry, target, 10 * 1024 * 1024, 1024 * 1024, 0)
    await expect(p).rejects.toThrow(ZipBombError)
    await expect(p).rejects.toThrow(/总量上限/)
  })

  it('streaming extracts a high-ratio deflated entry under cap and verifies content (CRC + 多块 inflate)', async () => {
    // 2MB of 'B' deflate 到 ~2KB,经多块 inflate + CRC 校验后内容须一致(回归流式 happy path)
    const content = Buffer.alloc(2 * 1024 * 1024, 0x42)
    const zipPath = writeZip('big-ok.zip', [
      ['lyshell-plugin.json', manifestBuf()],
      ['dist/big.bin', content]
    ])
    const dest = join(tmp, 'dest')
    await extractZipSafely(zipPath, dest) // 默认 200MB/500MB 上限,2MB 远低于
    const out = readFileSync(join(dest, 'dist/big.bin'))
    expect(out.length).toBe(content.length)
    expect(out.equals(content)).toBe(true) // CRC 正确则内容一致
  })
})

describe('readManifestFromZip', () => {
  it('reads root-level manifest and validates it', async () => {
    const zipPath = writeZip('ok.zip', [['lyshell-plugin.json', manifestBuf()]])
    const result = await readManifestFromZip(zipPath)
    expect(result.ok).toBe(true)
    expect(result.manifest?.id).toBe('test-plugin')
  })

  it('reads root manifest even with a leading ./', async () => {
    const zipPath = writeZip('dot.zip', [['./lyshell-plugin.json', manifestBuf()]])
    const result = await readManifestFromZip(zipPath)
    expect(result.ok).toBe(true)
  })

  it('errors when manifest is missing', async () => {
    const zipPath = writeZip('nomanifest.zip', [['dist/main.js', Buffer.from('x')]])
    const result = await readManifestFromZip(zipPath)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/未找到 lyshell-plugin\.json/)
  })

  it('errors when manifest is only in a subdir (not root)', async () => {
    const zipPath = writeZip('subdir.zip', [
      ['my-plugin/lyshell-plugin.json', manifestBuf()]
    ])
    const result = await readManifestFromZip(zipPath)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/未找到 lyshell-plugin\.json/)
  })

  it('errors when manifest content is invalid (bad manifest shape)', async () => {
    const zipPath = writeZip('bad.zip', [
      ['lyshell-plugin.json', manifestBuf({ id: 'UPPER CASE', runtime: 'nope' })]
    ])
    const result = await readManifestFromZip(zipPath)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('errors when manifest is not valid JSON', async () => {
    const zipPath = writeZip('badjson.zip', [
      ['lyshell-plugin.json', Buffer.from('{ not json')]
    ])
    const result = await readManifestFromZip(zipPath)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/解析失败/)
  })

  it('rejects a zip-bomb manifest entry via injected cap (评审 #4)', async () => {
    // 命名为 lyshell-plugin.json 的高压缩比条目:压缩后极小,解压后远超注入上限。
    // readEntryBytesCapped 流式计数封顶,防预览阶段 OOM(不调 entry.getData 整块分配)。
    const zipPath = writeZip('bomb-manifest.zip', [
      ['lyshell-plugin.json', Buffer.alloc(200 * 1024, 0x61)] // 200KB,非合法 JSON 但先触发上限
    ])
    const result = await readManifestFromZip(zipPath, { maxManifestBytes: 1024 })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/上限|zip-bomb/)
  })
})

describe('assertZipFileSize', () => {
  it('accepts a small file under the default cap', () => {
    const zipPath = writeZip('small.zip', [['lyshell-plugin.json', manifestBuf()]])
    expect(() => assertZipFileSize(zipPath)).not.toThrow()
  })

  it('rejects a file over an injected small cap', () => {
    const zipPath = writeZip('small.zip', [['lyshell-plugin.json', manifestBuf()]])
    // 注入 1 字节上限:任何非空 zip 都超限(防本地大 zip 全量载入耗尽内存,评审 #2)
    expect(() => assertZipFileSize(zipPath, 1)).toThrow(/超过.*上限/)
  })

  it('throws "无法读取" for a missing file (ENOENT)', () => {
    expect(() => assertZipFileSize(join(tmp, 'nope.zip'))).toThrow(/无法读取 zip/)
  })
})

describe('safeDeleteDownload', () => {
  it('deletes a file inside the downloads dir', () => {
    const downloadsDir = join(tmp, '.downloads')
    mkdirSync(downloadsDir, { recursive: true })
    const file = join(downloadsDir, 'a.zip')
    writeFileSync(file, Buffer.from('x'))
    expect(existsSync(file)).toBe(true)
    expect(safeDeleteDownload(file, downloadsDir)).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('refuses to delete a file outside the downloads dir (returns false, file remains)', () => {
    const downloadsDir = join(tmp, '.downloads')
    mkdirSync(downloadsDir, { recursive: true })
    const outside = join(tmp, 'outside.zip') // 在 downloadsDir 之外
    writeFileSync(outside, Buffer.from('x'))
    expect(safeDeleteDownload(outside, downloadsDir)).toBe(false)
    expect(existsSync(outside)).toBe(true) // 未删
  })
})

describe('atomicSwapPlugin', () => {
  it('fresh install: swaps staging -> dest when dest absent', () => {
    const base = join(tmp, 'plugins')
    mkdirSync(base, { recursive: true })
    const staging = join(base, '.staging-x')
    const dest = join(base, 'x')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'lyshell-plugin.json'), manifestBuf())
    writeFileSync(join(staging, 'marker.js'), Buffer.from('new'))
    const res = atomicSwapPlugin(staging, dest, base)
    expect(res.ok).toBe(true)
    expect(existsSync(dest)).toBe(true)
    expect(existsSync(staging)).toBe(false) // staging 已换入 dest
    expect(readFileSync(join(dest, 'marker.js'), 'utf-8')).toBe('new')
  })

  it('update: old dest replaced with new; trash cleaned up', () => {
    const base = join(tmp, 'plugins')
    mkdirSync(base, { recursive: true })
    const staging = join(base, '.staging-x')
    const dest = join(base, 'x')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'marker.js'), Buffer.from('old'))
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'marker.js'), Buffer.from('new'))
    const res = atomicSwapPlugin(staging, dest, base)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dest, 'marker.js'), 'utf-8')).toBe('new')
    expect(existsSync(staging)).toBe(false)
    expect(existsSync(join(base, '.trash-x'))).toBe(false) // trash 已清
  })

  it('failed swap (missing staging): rolls old dest back from trash, old content intact', () => {
    // 模拟评审 reinstall #1 场景:旧 dest 存在,staging 缺失(如解压失败已清)
    const base = join(tmp, 'plugins')
    mkdirSync(base, { recursive: true })
    const staging = join(base, '.staging-x') // 故意不创建 -> rename 失败
    const dest = join(base, 'x')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'marker.js'), Buffer.from('old'))
    const res = atomicSwapPlugin(staging, dest, base)
    expect(res.ok).toBe(false)
    // 旧版本经 trash 回滚为 dest,内容完好
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(join(dest, 'marker.js'), 'utf-8')).toBe('old')
    expect(existsSync(join(base, '.trash-x'))).toBe(false) // trash 已回滚
  })
})

describe('isLoopbackOrLinkLocalHost', () => {
  it('detects loopback', () => {
    expect(isLoopbackOrLinkLocalHost('127.0.0.1')).toBe(true)
    expect(isLoopbackOrLinkLocalHost('127.1.2.3')).toBe(true)
    expect(isLoopbackOrLinkLocalHost('localhost')).toBe(true)
    expect(isLoopbackOrLinkLocalHost('::1')).toBe(true)
  })

  it('detects link-local (cloud metadata etc.)', () => {
    expect(isLoopbackOrLinkLocalHost('169.254.169.254')).toBe(true)
    expect(isLoopbackOrLinkLocalHost('fe80::1')).toBe(true)
  })

  it('allows private LAN and public hosts (LAN 托管场景)', () => {
    expect(isLoopbackOrLinkLocalHost('192.168.1.1')).toBe(false)
    expect(isLoopbackOrLinkLocalHost('10.0.0.1')).toBe(false)
    expect(isLoopbackOrLinkLocalHost('8.8.8.8')).toBe(false)
    expect(isLoopbackOrLinkLocalHost('example.com')).toBe(false)
  })
})
