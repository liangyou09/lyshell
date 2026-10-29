// LyShell 托管 Harness 的原生任务日志 —— 宿主侧磁盘存储（dsh 后台进程内运行）。
//
// 用途：Harness 后台跨进程重启后，宿主需要从磁盘恢复「每个 owner 的权威任务日志」。
// 本文件只提供存储原语，不理解任务/会话/审批内容；owner 是 LyShell main 侧派生的
// SHA-256 租户键（小写 64 位十六进制），**不是**凭据本身。目录必须是宿主专用目录：
// 本 helper 不接收、也不应写入任何 token/key/login URL。
//
// 存储语义（fail closed，绝不把失败静默成「空状态」）：
//   * 一次 save = 一个同步持久事务：`wx` 独占临时文件 → 完整写 → fsync → close →
//     atomic rename；rename 返回后调用方才算「已接收」。
//   * loadAll 只认规范文件名 `<owner>.json`，逐个校验版本 / 文件名与 owner 一致 /
//     checksum（SHA256(JSON.stringify(value))）。任何损坏、超限、符号链接、非普通文件
//     都**整批报错**，不跳过坏文件 —— 跳过会让同一任务在重启后重复出现。
//   * 非规范文件（含本 helper 自己的 `.tmp` 残留）一律忽略，不当作任务数据。
//   * loadAll 每次都重新读盘并 JSON.parse，返回的对象与内部/上一次调用不共享引用。
//
// 错误分类（固定 code，调用方按 code 分类，不要解析 message）：
//   journal/bad-directory    目录参数非法
//   journal/unsafe-path      root 或日志文件是符号链接 / 非普通文件
//   journal/bad-owner        owner 不是小写 64 位十六进制
//   journal/serialize        value 不能 JSON 序列化
//   journal/too-many-owners  规范日志文件超过 64 个
//   journal/too-large        单文件或序列化 value 超过 8 MiB
//   journal/corrupt          版本 / owner / checksum / 结构损坏
//   journal/io               文件系统操作失败
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 持久格式版本。任何其它版本都按损坏处理，不做兼容猜测。 */
const VERSION = 1
/** 单个目录最多容纳的 owner 数。 */
const MAX_OWNERS = 64
/** 单个日志文件（整份 payload）的字节上限。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 序列化 value 的字节上限：save 与 load 用同一常量、同一 `Buffer.byteLength` 口径。 */
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024
/** owner 必须是小写 64 位十六进制（SHA-256 的十六进制表示），且绝不是原始 token。 */
const OWNER_PATTERN = /^[0-9a-f]{64}$/
/** 只扫描规范文件名；`<owner>.json.tmp`、未知名字、大写扩展名都不算任务数据。 */
const JOURNAL_FILE_PATTERN = /^([0-9a-f]{64})\.json$/

class WorkJournalError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'WorkJournalError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

const MESSAGES = {
  'journal/bad-directory': 'journal directory must be a non-empty absolute path',
  'journal/unsafe-path': 'journal path must be a plain directory or regular file',
  'journal/bad-owner': 'journal owner must be a lowercase 64-character hex hash',
  'journal/serialize': 'journal value is not JSON-serializable',
  'journal/too-many-owners': 'journal owner limit exceeded',
  'journal/too-large': 'journal entry exceeds the size limit',
  'journal/corrupt': 'journal entry is corrupt',
  'journal/io': 'journal filesystem operation failed'
}

function journalError(code, cause) {
  return new WorkJournalError(code, MESSAGES[code] ?? 'journal error', cause)
}

/** 临时文件名序号：同进程内避免与上一次事务重名（再叠加 pid 与随机串）。 */
let tempSequence = 0

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 唯一的 value 序列化入口：save / load 共用同一上限，保证两边判定一致。 */
function serializedValue(value) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw journalError('journal/serialize', error)
  }
  // undefined / 函数 / symbol 在根位置会得到 undefined，不能落盘。
  if (typeof serialized !== 'string') throw journalError('journal/serialize')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) throw journalError('journal/too-large')
  return serialized
}

/**
 * root 每次操作都重新 lstat：目录可能在 open 之后被删除或被替换成链接。
 * 缺失也按 io 失败上报，绝不当作「空日志」。
 */
function assertRoot(root) {
  let info
  try {
    info = lstatSync(root)
  } catch (error) {
    throw journalError('journal/io', error)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw journalError('journal/unsafe-path')
  return info
}

/** 只返回规范 `<owner>.json` 名字，并确定性排序（纯十六进制 → 默认字典序稳定）。 */
function journalNames(root) {
  let names
  try {
    names = readdirSync(root)
  } catch (error) {
    throw journalError('journal/io', error)
  }
  return names.filter(name => JOURNAL_FILE_PATTERN.test(name)).sort()
}

function readEntry(root, fileName) {
  const expectedOwner = fileName.slice(0, 64)
  const filePath = join(root, fileName)
  let info
  try {
    info = lstatSync(filePath)
  } catch (error) {
    throw journalError('journal/io', error)
  }
  // 符号链接绝不跟随；目录 / FIFO / 设备等非普通文件也绝不当日志读。
  if (info.isSymbolicLink() || !info.isFile()) throw journalError('journal/unsafe-path')
  if (info.size > MAX_FILE_BYTES) throw journalError('journal/too-large')
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw journalError('journal/io', error)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw journalError('journal/corrupt', error)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw journalError('journal/corrupt')
  if (payload.version !== VERSION) throw journalError('journal/corrupt')
  // 文件名与内容 owner 必须一致：否则把 A 的日志挂到 B 名下就是伪造/重复。
  if (payload.owner !== expectedOwner) throw journalError('journal/corrupt')
  if (!Object.prototype.hasOwnProperty.call(payload, 'value')) throw journalError('journal/corrupt')
  let serialized
  try {
    serialized = JSON.stringify(payload.value)
  } catch (error) {
    throw journalError('journal/corrupt', error)
  }
  if (typeof serialized !== 'string') throw journalError('journal/corrupt')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) throw journalError('journal/too-large')
  if (typeof payload.checksum !== 'string' || payload.checksum !== sha256(serialized)) {
    throw journalError('journal/corrupt')
  }
  return { owner: expectedOwner, value: payload.value }
}

/** rename 之后尽力 fsync 父目录；Windows 不能 fsync 目录，POSIX 上失败也不改变已落地的事务。 */
function syncDirectory(root) {
  if (process.platform === 'win32') return
  let fd
  try {
    fd = openSync(root, 'r')
    fsyncSync(fd)
  } catch {
    // 目录 fsync 是尽力而为：数据文件本身已 fsync，rename 也已返回。
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 忽略：close 失败不改变磁盘上已提交的内容。
      }
    }
  }
}

/**
 * 打开（必要时创建）宿主专用的任务日志目录。
 * @param {string} directory 非空绝对路径；root 不存在时按 0700 创建，已存在时规范为 0700。
 */
export function openWorkJournal(directory) {
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.includes('\0') ||
    !isAbsolute(directory)
  ) {
    throw journalError('journal/bad-directory')
  }
  const root = resolve(directory)
  let exists = true
  try {
    lstatSync(root)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw journalError('journal/io', error)
    exists = false
  }
  if (!exists) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw journalError('journal/io', error)
    }
  }
  const info = assertRoot(root)
  // Windows 跟随用户目录 ACL；POSIX 上把既有目录也收紧到 0700。
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) {
    try {
      chmodSync(root, 0o700)
    } catch (error) {
      throw journalError('journal/io', error)
    }
  }

  function loadAll() {
    assertRoot(root)
    const names = journalNames(root)
    // 目录被外部写到超过上限时同样 fail closed，不截断、不跳过。
    if (names.length > MAX_OWNERS) throw journalError('journal/too-many-owners')
    return names.map(name => readEntry(root, name))
  }

  function save(owner, value) {
    if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) throw journalError('journal/bad-owner')
    const serialized = serializedValue(value)
    assertRoot(root)
    const fileName = `${owner}.json`
    const targetPath = join(root, fileName)
    // 目标只能是「不存在」或普通文件：符号链接 / 目录一律拒绝，避免 rename 覆盖非预期对象。
    let targetInfo = null
    try {
      targetInfo = lstatSync(targetPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw journalError('journal/io', error)
    }
    if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
      throw journalError('journal/unsafe-path')
    }
    const names = journalNames(root)
    if (names.length > MAX_OWNERS) throw journalError('journal/too-many-owners')
    if (!names.includes(fileName) && names.length >= MAX_OWNERS) throw journalError('journal/too-many-owners')

    const checksum = sha256(serialized)
    // 直接拼装：value 只 stringify 一次，checksum 与落盘内容必然同源。
    const payload = `{"version":${VERSION},"owner":${JSON.stringify(owner)},"value":${serialized},"checksum":"${checksum}"}`
    if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) throw journalError('journal/too-large')

    const tempPath = join(
      root,
      `.${owner}.${process.pid}.${tempSequence++}.${randomBytes(8).toString('hex')}.tmp`
    )
    let fd = null
    try {
      fd = openSync(tempPath, 'wx', 0o600)
      writeFileSync(fd, payload, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tempPath, targetPath)
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 忽略：下面的 unlink 仍会清掉临时文件。
        }
      }
      try {
        unlinkSync(tempPath)
      } catch {
        // 残留的 .tmp 会被 loadAll 忽略；不递归删除任何东西。
      }
      throw error instanceof WorkJournalError ? error : journalError('journal/io', error)
    }
    syncDirectory(root)
  }

  return { loadAll, save }
}
