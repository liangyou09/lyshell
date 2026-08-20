/**
 * .lyshell-plugin zip 安装核心(解压 + zip-slip 防护 + URL 下载)。
 *
 * 详见 docs/plugin-system-design.md §8.3(zip/URL 安装)。C4b 切片。
 *
 * 安全核心 -- zip-slip 防护两道:
 *   1. extractZipSafely:逐 entry 校验 entryName(拒绝对路径/盘符/../NUL/符号链接),
 *      并 path.resolve 断言目标严格在 destDir 之下;写入用自算 safe path,不信任库路径拼接。
 *   2. assertUnderBase:卸载 fs.rmSync 前断言 pluginDir 严格在 pluginsDir 下(纵深防御,
 *      评审点名 handlers.ts 的 rmSync)。
 *
 * manifest 必须在 zip 根(无外层包裹,对齐 vsix);zip 内容直接解进 {pluginsDir}/{id}/。
 *
 * 本模块不引入 electron 依赖(纯 fs/path/http),便于 vitest 直接测。
 */
import AdmZip from 'adm-zip'
import { createWriteStream, existsSync, renameSync, rmSync, statSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import { createInflateRaw } from 'zlib'
import { Readable } from 'stream'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'path'
import * as https from 'https'
import * as http from 'http'
import { validateManifest, isUnsafeRelativePath } from '@shared/plugin-types'
import type { ManifestValidation } from '@shared/plugin-types'

const MANIFEST_NAME = 'lyshell-plugin.json'

/** 插件 zip 大小上限(50MB)。Content-Length 预检 + 运行字节计数双保险。 */
const MAX_ZIP_BYTES = 50 * 1024 * 1024
/** URL 下载超时(socket 空闲,30s)。 */
const DOWNLOAD_TIMEOUT_MS = 30_000
/** 下载跟随跳转上限(防 redirect 循环)。 */
const MAX_REDIRECTS = 5

/** 单条 entry 解压后大小上限(防 zip-bomb:流式解压字节计数,评审 #4)。 */
const MAX_DECOMPRESSED_PER_ENTRY = 200 * 1024 * 1024
/** 全部 entry 解压后总大小上限(防 zip-bomb 总量炸盘)。 */
const MAX_DECOMPRESSED_TOTAL = 500 * 1024 * 1024
/** 清单解压大小上限(清单极小;预览阶段防 zip-bomb 命名为 lyshell-plugin.json)。 */
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024

/** 临时下载目录名(位于 plugins 目录下,不算插件资产,卸载/退出时清理)。 */
const DOWNLOADS_SUBDIR = '.downloads'

/** zip-slip 检出错(解压逃逸 / 卸载路径越界)。调用方据此返回明确错误而非通用 IO 错。 */
export class ZipSlipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipSlipError'
  }
}

/** zip-bomb 检出错(解压超过单条/总量上限,或声明的解压尺寸超限,或加密/未知压缩法)。 */
export class ZipBombError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipBombError'
  }
}

/** {userData}/plugins/.downloads/ -- URL 临时下载 zip 存放处。 */
export function getDownloadsDir(pluginsDir: string): string {
  return join(pluginsDir, DOWNLOADS_SUBDIR)
}

/** 清理 .downloads/ 临时目录(app 退出时调,兜底回收未消费的 URL 下载)。失败静默。 */
export function cleanupDownloadsDir(pluginsDir: string): void {
  try {
    rmSync(join(pluginsDir, DOWNLOADS_SUBDIR), { recursive: true, force: true })
  } catch {
    /* 退出时忽略占用等错误 */
  }
}

/**
 * 校验 zip 文件大小未超上限(防本地大 zip 经 new AdmZip 全量载入耗尽内存)。
 * 文件不存在 -> 抛 "无法读取 zip 文件: ..."(与 new AdmZip 失败同消息);超限 -> 抛 "zip 超过...上限"。
 * maxBytes 默认 MAX_ZIP_BYTES,可注入供测试。
 */
export function assertZipFileSize(zipPath: string, maxBytes: number = MAX_ZIP_BYTES): void {
  let stat: { size: number }
  try {
    stat = statSync(zipPath)
  } catch (e) {
    throw new Error(`无法读取 zip 文件: ${(e as Error).message}`)
  }
  if (stat.size > maxBytes) {
    throw new Error(`zip 超过 ${maxBytes} 字节上限(实际 ${stat.size})`)
  }
}

/**
 * 安全删除 .downloads/ 下的临时下载文件(仅当严格在 downloadsDir 下才删,防越界)。
 * 用于用户取消 URL 安装时即时回收(cancelPicked);越界或失败静默返回 false(留待 cleanupDownloadsDir 兜底)。
 */
export function safeDeleteDownload(filePath: string, downloadsDir: string): boolean {
  try {
    assertUnderBase(filePath, downloadsDir)
    rmSync(filePath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 原子换入:把 stagingDir 换到 destDir,失败不损旧 destDir(评审 reinstall #1)。
 * 流程:若 destDir 存在 -> rename 到 trashDir(同卷原子)-> rename staging -> destDir;任一失败回滚。
 *   - destDir->trash 失败:旧完好,返回 {ok:false}(staging 由调用方清)
 *   - staging->destDir 失败:trash 回滚为 destDir,返回 {ok:false}(staging 由调用方清)
 *   - 成功:清 trash(旧版本)
 * staging/dest/trash 均经 assertUnderBase 断言在 baseDir 下。trash 用固定名 `.trash-{id}`,下次安装清残留。
 * 关键不变量:解压/复验阶段只动 staging(旧 destDir 不碰);换入阶段失败则旧版本从 trash 恢复。
 */
export function atomicSwapPlugin(
  stagingDir: string,
  destDir: string,
  baseDir: string
): { ok: boolean; error?: string } {
  assertUnderBase(stagingDir, baseDir)
  assertUnderBase(destDir, baseDir)
  const id = basename(destDir)
  const trashDir = join(baseDir, `.trash-${id}`)
  assertUnderBase(trashDir, baseDir)

  let movedOldToTrash = false
  if (existsSync(destDir)) {
    // 清上次崩溃残留的 trash
    if (existsSync(trashDir)) {
      try {
        rmSync(trashDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    try {
      renameSync(destDir, trashDir)
      movedOldToTrash = true
    } catch (e) {
      return { ok: false, error: `无法移走旧插件目录: ${(e as Error).message}` }
    }
  }
  try {
    renameSync(stagingDir, destDir)
  } catch (e) {
    // 换入失败:把旧版本从 trash 恢复回 destDir(best-effort)
    if (movedOldToTrash) {
      try {
        renameSync(trashDir, destDir)
      } catch {
        /* 双重 rename 失败(极罕见):旧版本留 trash,下次安装清残留 */
      }
    }
    return { ok: false, error: `无法放置新插件目录: ${(e as Error).message}` }
  }
  // 换入成功:清 trash(旧版本)
  if (movedOldToTrash) {
    try {
      rmSync(trashDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  return { ok: true }
}

/**
 * 断言 target 严格在 base 之下(含等于 base)。用于:
 *   - 卸载 fs.rmSync 前(pluginDir ⊆ pluginsDir,纵深防御)
 *   - extractZipSafely 内部(entry 目标 ⊆ destDir,双保险)
 *
 * 用 path.relative 做词法判断(不 realpath:target 由 join(pluginsDir, kebab-id) 构造,
 * 无符号链接介入,词法检查足够且不要求路径存在)。relative 结果以 '..' 段开头或为绝对路径
 * (跨盘符)即逃逸。
 */
export function assertUnderBase(target: string, base: string): void {
  const rel = relative(resolve(base), resolve(target))
  if (rel === '') return // target === base
  const firstSeg = rel.split(/[\\/]/)[0]
  if (firstSeg === '..' || isAbsolute(rel)) {
    throw new ZipSlipError(`路径 "${target}" 逃逸出基目录 "${base}"`)
  }
}

/** unix 符号链接位检测(S_IFMT=0o170000, S_IFLNK=0o120000)。Windows 制作的无 mode zip 返回 false。 */
function isSymlinkEntry(entry: AdmZip.IZipEntry): boolean {
  const mode = (entry as unknown as { unixPermissions?: number }).unixPermissions
  if (typeof mode !== 'number' || mode === 0) return false
  return (mode & 0o170000) === 0o120000
}

/**
 * CRC32(IEEE 802.3)查表实现。流式解压替代 entry.getData() 后,自校验完整性
 * (对齐原 getData 的 crc32OK:损坏条目抛错而非静默落盘)。实现与 adm-zip util/utils.js
 * 完全一致(同表、同 ~0 初值、同 ~crc 终值),保证与 header.crc 比对不误报。
 * 支持分块累计:返回值作为下次 seed 续算(内部还原中间状态 c)。
 */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32Update(seed: number, chunk: Buffer): number {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** adm-zip 类型把 encrypted 拼成 encripted(已知 @types bug),运行时实为 encrypted。 */
function isEncryptedEntry(entry: AdmZip.IZipEntry): boolean {
  return (entry.header as unknown as { encrypted?: boolean }).encrypted === true
}

/**
 * 构造 entry 的解压源(流式,替代 entry.getData() 的整块 Buffer.alloc(header.size))。
 *   - method 0 (STORED):压缩数据即原始数据,用 Readable 单块推送
 *   - method 8 (DEFLATED):getCompressedData() 返回 raw deflate,接 createInflateRaw
 * 拒绝加密条目(getData 需口令,流式不处理)与未知压缩法(对齐 adm-zip UNKNOWN_METHOD)。
 * 返回 { source, kickoff }:listener 就绪后调 kickoff 喂入压缩数据(deflate 路径)。
 * 注:getCompressedData() 已把整条压缩数据载入内存,但其大小受 MAX_ZIP_BYTES(压缩后)约束。
 */
function makeDecompressionSource(entry: AdmZip.IZipEntry): { source: Readable; kickoff: () => void } {
  if (isEncryptedEntry(entry)) {
    throw new ZipBombError(`拒绝加密条目: "${entry.entryName}"`)
  }
  const method = entry.header.method
  const compressed = entry.getCompressedData()
  if (method === 0) {
    const src = new Readable({ read() {} })
    src.push(compressed)
    src.push(null)
    return { source: src, kickoff: () => {} }
  }
  if (method === 8) {
    const inflate = createInflateRaw()
    return { source: inflate, kickoff: () => inflate.end(compressed) }
  }
  throw new ZipBombError(`不支持的压缩方法 ${method}: "${entry.entryName}"`)
}

/**
 * 流式解压单条 entry 到内存 Buffer,带字节上限 + CRC 校验。
 * 供 readManifestFromZip 读清单(清单极小,MAX_MANIFEST_BYTES 封顶):超限抛 ZipBombError,
 * CRC 不符抛错(对齐原 getData 行为)。不调 entry.getData()(避免按声明 size 整块分配)。
 */
async function readEntryBytesCapped(entry: AdmZip.IZipEntry, maxBytes: number): Promise<Buffer> {
  const { source, kickoff } = makeDecompressionSource(entry)
  return new Promise<Buffer>((resolveP, reject) => {
    const chunks: Buffer[] = []
    let written = 0
    let crc = 0
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      source.destroy()
      reject(err)
    }
    source.on('data', (chunk: Buffer) => {
      written += chunk.length
      if (written > maxBytes) {
        fail(
          new ZipBombError(`条目 "${entry.entryName}" 解压超过 ${maxBytes} 字节上限(zip-bomb 嫌疑)`)
        )
        return
      }
      crc = crc32Update(crc, chunk)
      chunks.push(chunk)
    })
    source.on('end', () => {
      if (settled) return
      const data = Buffer.concat(chunks)
      const expected = entry.header.crc >>> 0
      if (expected !== 0 && crc !== expected) {
        fail(new Error(`条目 "${entry.entryName}" CRC 校验失败`))
        return
      }
      settled = true
      resolveP(data)
    })
    source.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
    kickoff()
  })
}

/**
 * 流式解压单条 entry 写入 target 文件,带单条/总量字节上限 + CRC 校验。
 * 替代 writeFile(target, entry.getData()):避免按声明 size 整块分配 + 一次性落盘炸内存/磁盘。
 * 返回实际写入字节数;超 maxEntryBytes 或 totalBefore+written 超 maxTotalBytes 抛 ZipBombError。
 * 超限时销毁流并保留部分文件(由调用方 extractZipSafely 失败后清 staging 兜底)。
 * 导出供 install-zip.test.ts 直接覆盖流式上限(无需构造谎报 header 的恶意 zip)。
 */
export async function writeEntryCapped(
  entry: AdmZip.IZipEntry,
  target: string,
  maxEntryBytes: number,
  maxTotalBytes: number,
  totalBefore: number
): Promise<number> {
  const { source, kickoff } = makeDecompressionSource(entry)
  return new Promise<number>((resolveP, reject) => {
    const ws = createWriteStream(target)
    let written = 0
    let crc = 0
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      source.destroy()
      ws.destroy()
      reject(err)
    }
    const done = (): void => {
      if (settled) return
      const expected = entry.header.crc >>> 0
      if (expected !== 0 && crc !== expected) {
        fail(new Error(`条目 "${entry.entryName}" CRC 校验失败`))
        return
      }
      settled = true
      resolveP(written)
    }
    source.on('data', (chunk: Buffer) => {
      written += chunk.length
      if (written > maxEntryBytes) {
        fail(
          new ZipBombError(
            `条目 "${entry.entryName}" 解压超过单条上限 ${maxEntryBytes} 字节(zip-bomb 嫌疑)`
          )
        )
        return
      }
      if (totalBefore + written > maxTotalBytes) {
        fail(new ZipBombError(`解压超过总量上限 ${maxTotalBytes} 字节(zip-bomb 嫌疑)`))
        return
      }
      crc = crc32Update(crc, chunk)
      if (!ws.write(chunk)) {
        source.pause()
        ws.once('drain', () => {
          if (!settled) source.resume()
        })
      }
    })
    source.on('end', () => ws.end(done))
    source.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
    ws.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
    kickoff()
  })
}

/**
 * 从 zip **根**读 lyshell-plugin.json + 校验(不解压整包)。
 * 供 pick-file / fetch-url 预览权限卡(对齐 pick-folder 流程:先看 manifest 再确认安装)。
 * 根无 manifest -> { ok:false, errors }(要求清单在根,不能有外层包裹文件夹)。
 */
export async function readManifestFromZip(
  zipPath: string,
  opts: { maxManifestBytes?: number } = {}
): Promise<ManifestValidation> {
  // 大小上限:防 new AdmZip 全量载入耗尽内存(本地大 zip)。assertZipFileSize 已给清晰错(含 ENOENT)。
  try {
    assertZipFileSize(zipPath)
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] }
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch (e) {
    return { ok: false, errors: [`无法读取 zip 文件: ${(e as Error).message}`] }
  }
  // 根级 manifest:entryName 去前导 ./ 后恰为 MANIFEST_NAME(其无斜杠,故天然排除子目录条目)
  const entry = zip
    .getEntries()
    .find((e) => !e.isDirectory && e.entryName.replace(/^\.\//, '') === MANIFEST_NAME)
  if (!entry) {
    return {
      ok: false,
      errors: ['zip 根目录未找到 lyshell-plugin.json(清单必须在根,不能有外层包裹文件夹)']
    }
  }
  // 流式解压清单(评审 #4 zip-bomb):不调 entry.getData()(按声明 size 整块分配),
  // 改 readEntryBytesCapped 字节计数封顶,防恶意 lyshell-plugin.json 解压炸弹在预览阶段 OOM。
  let buf: Buffer
  try {
    buf = await readEntryBytesCapped(entry, opts.maxManifestBytes ?? MAX_MANIFEST_BYTES)
  } catch (e) {
    return { ok: false, errors: [`读取 lyshell-plugin.json 失败: ${(e as Error).message}`] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(buf.toString('utf-8'))
  } catch (e) {
    return { ok: false, errors: [`lyshell-plugin.json 解析失败: ${(e as Error).message}`] }
  }
  return validateManifest(raw)
}

/**
 * 校验单条 zip entry 名是否安全(防 zip-slip)。归一化(正斜杠、去前导 ./)后委托 isUnsafeRelativePath
 * (与 validateManifest 的 main 校验同源,单一真相):拒空/NUL/对路径/盘符/.. 段。不安全抛 ZipSlipError。
 * 导出供 install-zip.test.ts 直接覆盖各逃逸模式(无需为每种构造恶意 zip)。
 */
export function assertSafeEntryName(rawName: string): string {
  const name = rawName.replace(/\\/g, '/').replace(/^\.\//, '')
  if (isUnsafeRelativePath(name)) {
    throw new ZipSlipError(`拒绝不安全的条目路径: "${rawName}"`)
  }
  return name
}

/**
 * 安全解压 zip 到 destDir(逐 entry 校验 + 自写 safe path,防 zip-slip)。
 *
 * 每条 entry:
 *   1. assertSafeEntryName 校验 entryName(拒绝对路径/盘符/../NUL)
 *   2. 拒绝符号链接条目(防链接指向 destDir 外)
 *   3. resolve(destDir, name) 经 assertUnderBase 断言严格在 destDir 之下(双保险)
 *   4. mkdir(dirname, recursive) + writeFileSync(target, getData) -- 用自算路径,不信任库拼接
 * 目录 entry 跳过(writeFile 前的 mkdir recursive 已建目录)。
 *
 * 抛 ZipSlipError 表示检出逃逸;其他 IO / zip 读取错原样抛。destDir 不存在会自动建。
 */
export async function extractZipSafely(
  zipPath: string,
  destDir: string,
  opts: { maxEntryBytes?: number; maxTotalBytes?: number } = {}
): Promise<void> {
  // 大小上限(压缩后):防 new AdmZip 全量载入耗尽内存(本地大 zip)
  assertZipFileSize(zipPath) // 超限/文件不存在抛 Error(含 "无法读取" 消息)
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch (e) {
    throw new Error(`无法读取 zip 文件: ${(e as Error).message}`)
  }
  await mkdir(destDir, { recursive: true })
  const destReal = resolve(destDir)
  const maxEntryBytes = opts.maxEntryBytes ?? MAX_DECOMPRESSED_PER_ENTRY
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_DECOMPRESSED_TOTAL

  // 预检:声明的解压尺寸(诚实 zip-bomb 快速失败,不碰盘/不分配)。谎报 header 的 zip
  // 由下方流式字节计数兜底(评审 #4)。header.size=0(数据描述符/未声明)跳过,交流式计数。
  let declaredTotal = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const declared = entry.header.size ?? 0
    if (declared > maxEntryBytes) {
      throw new ZipBombError(
        `条目 "${entry.entryName}" 声明解压 ${declared} 超过单条上限 ${maxEntryBytes}(zip-bomb 嫌疑)`
      )
    }
    declaredTotal += declared
  }
  if (declaredTotal > maxTotalBytes) {
    throw new ZipBombError(
      `zip 声明解压总大小 ${declaredTotal} 超过上限 ${maxTotalBytes}(zip-bomb 嫌疑)`
    )
  }

  let actualTotal = 0
  for (const entry of zip.getEntries()) {
    const name = assertSafeEntryName(entry.entryName)
    if (isSymlinkEntry(entry)) {
      throw new ZipSlipError(`拒绝符号链接条目: "${entry.entryName}"`)
    }

    const target = resolve(destReal, name)
    assertUnderBase(target, destReal) // 双保险:resolve 后再 relative 断言

    if (entry.isDirectory) continue // writeEntryCapped 前 mkdir recursive 会建目录
    await mkdir(dirname(target), { recursive: true })
    // 流式解压写字面(评审 #4 zip-bomb):不调 entry.getData()(按声明 size 整块分配),
    // 改 writeEntryCapped 流式 inflate + 字节计数封顶(单条/总量)+ CRC,超限抛 ZipBombError。
    actualTotal += await writeEntryCapped(entry, target, maxEntryBytes, maxTotalBytes, actualTotal)
  }
}

/**
 * 下载 URL 到 destPath(http/https 流式,跟随跳转,大小上限 + 超时)。
 * 仅 http:/https: 协议(拒 file:/data:/ftp: 等防 SSRF)。Content-Length 预检 + 运行字节计数双保险。
 * 失败时清理半成品文件。抛 Error 含可读原因(协议/状态/大小/超时/IO)。
 */
export async function downloadZip(url: string, destPath: string): Promise<void> {
  const initial = new URL(url)
  if (initial.protocol !== 'http:' && initial.protocol !== 'https:') {
    throw new Error(`不支持的协议 ${initial.protocol}(仅允许 http/https)`)
  }
  await mkdir(dirname(destPath), { recursive: true })
  await downloadFollowingRedirects(url, destPath, 0)
}

/**
 * 判定主机名是否为回环/链路本地(评审 #3 SSRF 硬化)。仅识别 IP 字面量 + 'localhost';
 * DNS 主机名(可被 rebinding)不在判定范围(threat model:本地工具,用户输入 URL,无凭据下行)。
 * 私有网段(10/172.16/192.168)不在此列 -- 用户可能 LAN 内托管插件,放行。
 */
export function isLoopbackOrLinkLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '') // 去 IPv6 方括号
  if (h === 'localhost') return true
  // IPv4:127.0.0.0/8(loopback)、169.254.0.0/16(link-local,含云元数据 169.254.169.254)
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number.parseInt(v4[1], 10)
    const b = Number.parseInt(v4[2], 10)
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    return false
  }
  // IPv6:::1(loopback)、fe80::/10(link-local)
  if (h === '::1') return true
  if (h.startsWith('fe80')) return true
  return false
}

function downloadFollowingRedirects(url: string, destPath: string, redirects: number): Promise<void> {
  return new Promise<void>((resolveP, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (e) {
      reject(new Error(`无效 URL: ${(e as Error).message}`))
      return
    }
    // 每跳都重验协议:防初始 http(s) 经 301 跳到 file:/data: 等(redirect SSRF)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`跳转到不支持的协议 ${parsed.protocol}(仅允许 http/https)`))
      return
    }
    // 跳转目标主机禁 loopback/link-local(评审 #3 SSRF):防 benign URL 跳到 127.0.0.1:{mcpPort}/169.254.169.254 探测内网。
    // 初始 URL(redirects=0)由用户自负;私有网段(10/172.16/192.168)放行(用户可能 LAN 内托管)。
    if (redirects > 0 && isLoopbackOrLinkLocalHost(parsed.hostname)) {
      reject(new Error(`拒绝跳转到内网回环/链路本地地址 ${parsed.hostname}`))
      return
    }
    const lib = parsed.protocol === 'https:' ? https : http
    let settled = false // 共享给 fail/done/req.error,防重复 settle(评审 #4)
    const req = lib.get(url, (res) => {
      // 跟随跳转(3xx + Location)
      const status = res.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`下载跳转超过 ${MAX_REDIRECTS} 次上限`))
          return
        }
        const next = new URL(res.headers.location, url).toString()
        resolveP(downloadFollowingRedirects(next, destPath, redirects + 1))
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`下载失败:HTTP ${status}`))
        return
      }
      // Content-Length 预检(服务端可能不返回,运行计数兜底)
      const lenHeader = res.headers['content-length']
      if (lenHeader) {
        const len = Number.parseInt(lenHeader, 10)
        if (Number.isFinite(len) && len > MAX_ZIP_BYTES) {
          res.resume()
          reject(new Error(`zip 超过 ${MAX_ZIP_BYTES} 字节上限(Content-Length: ${len})`))
          return
        }
      }

      const stream = createWriteStream(destPath)
      let received = 0
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        res.destroy()
        stream.destroy()
        rm(destPath, { force: true }).catch(() => {})
        reject(err)
      }
      const done = (): void => {
        if (settled) return
        settled = true
        resolveP()
      }

      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_ZIP_BYTES) {
          fail(new Error(`zip 超过 ${MAX_ZIP_BYTES} 字节上限(已接收 ${received})`))
          return
        }
        if (!stream.write(chunk)) {
          res.pause()
          stream.once('drain', () => res.resume())
        }
      })
      res.on('end', () => stream.end(done))
      res.on('error', fail)
      stream.on('error', fail)
    })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      reject(e)
    })
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`下载超时(${DOWNLOAD_TIMEOUT_MS}ms)`))
    })
  })
}
