import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  commitDownload,
  commitUpload,
  TransferAbortController,
  type TransferEnvironment,
  type TransferSftp,
  type TransferSftpStats,
} from './transfer-commit'

/**
 * OPT-11 提交协议集成测试：用“真实本地文件系统”实现一个最小 SFTP 替身，
 * 从而在没有真实 SSH 主机的隔离环境里验证：
 * 覆盖中断后旧目标不变、临时文件清理/残留上报、缺少 posix-rename 时拒绝覆盖、
 * 源/目标变化拒绝、取消与提交竞态、rename 回执丢失（结果未知）。
 * 断言全部落在真实文件内容/大小/权限上，不使用 mock 断言替代行为断言。
 */

type Faults = {
  /** 从该偏移开始的写入失败（模拟上传传输中断） */
  writeFailureAt?: number
  /** 从该偏移开始的远端读取失败（模拟下载传输中断） */
  readFailureAt?: number
  /** unlink 失败（模拟无法清理临时文件） */
  unlinkError?: Error
  /** posix rename 执行后不回执（模拟回执丢失） */
  renameAckLost?: boolean
  /** posix rename 执行前钩子（模拟取消竞态） */
  beforeRename?: () => void
  /** 数据写入后钩子（模拟源/目标在传输期间被改动） */
  onWrite?: (position: number) => void | Promise<void>
  /** 远端数据读取后钩子（下载方向的源/目标变化） */
  onRead?: (position: number) => void | Promise<void>
  /** 远端 open 之前钩子（模拟路径 stat 与 open 之间文件被替换） */
  beforeOpen?: (remotePath: string) => void | Promise<void>
  /** lstat 报告为符号链接的路径（远端） */
  symlinkPaths?: Set<string>
}

class FakeSftp implements TransferSftp {
  readonly root: string
  readonly faults: Faults
  readonly handles = new Map<number, fsp.FileHandle>()
  _extensions: Record<string, string>
  private nextHandle = 1

  constructor(root: string, extensions: Record<string, string>, faults: Faults = {}) {
    this.root = root
    this._extensions = extensions
    this.faults = faults
  }

  local(remotePath: string): string {
    return path.join(this.root, remotePath.replace(/^\/+/, '').split('/').join(path.sep))
  }

  private toStats(stats: import('fs').Stats): TransferSftpStats {
    return {
      mode: stats.mode,
      size: stats.size,
      mtime: stats.mtimeMs / 1000,
      isDirectory: () => stats.isDirectory(),
      isFile: () => stats.isFile(),
      isSymbolicLink: () => stats.isSymbolicLink(),
    }
  }

  stat(remotePath: string, callback: (error: Error | undefined, stats: TransferSftpStats) => void): void {
    void fsp.stat(this.local(remotePath)).then(
      stats => callback(undefined, this.toStats(stats)),
      error => callback(error, undefined as unknown as TransferSftpStats)
    )
  }

  lstat(remotePath: string, callback: (error: Error | undefined, stats: TransferSftpStats) => void): void {
    // 故障注入：不触碰文件系统，直接报告为符号链接（Windows 上无法可靠创建符号链接）
    if (this.faults.symlinkPaths?.has(remotePath)) {
      callback(undefined, {
        mode: 0o120777,
        size: 4,
        mtime: 1_700_000_000,
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
      })
      return
    }
    void fsp.lstat(this.local(remotePath)).then(
      stats => callback(undefined, this.toStats(stats)),
      error => callback(error, undefined as unknown as TransferSftpStats)
    )
  }

  fstat(handle: Buffer, callback: (error: Error | undefined, stats: TransferSftpStats) => void): void {
    const local = this.handles.get(handle.readUInt32LE(0))
    if (!local) {
      callback(new Error('no such handle'), undefined as unknown as TransferSftpStats)
      return
    }
    void local.stat().then(
      stats => callback(undefined, this.toStats(stats)),
      error => callback(error, undefined as unknown as TransferSftpStats)
    )
  }

  open(
    remotePath: string,
    flags: string,
    attrs: { mode?: number },
    callback: (error: Error | undefined, handle: Buffer) => void
  ): void {
    const nodeFlags = flags.includes('x') ? 'wx' : flags
    void (async () => {
      // 故障注入：在 stat 与 open 之间替换路径所指文件（句柄随后绑定到被替换后的版本）
      await this.faults.beforeOpen?.(remotePath)
      return fsp.open(this.local(remotePath), nodeFlags as 'r' | 'wx', attrs.mode)
    })().then(
      handle => {
        const id = this.nextHandle++
        this.handles.set(id, handle)
        const buffer = Buffer.alloc(4)
        buffer.writeUInt32LE(id, 0)
        callback(undefined, buffer)
      },
      error => callback(error, undefined as unknown as Buffer)
    )
  }

  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | undefined, bytesRead: number) => void
  ): void {
    const local = this.handles.get(handle.readUInt32LE(0))
    if (!local) {
      callback(new Error('no such handle'), 0)
      return
    }
    if (this.faults.readFailureAt !== undefined && position >= this.faults.readFailureAt) {
      callback(Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' }), 0)
      return
    }
    void local.read(buffer, offset, length, position).then(
      async result => {
        await this.faults.onRead?.(position)
        callback(undefined, result.bytesRead)
      },
      error => callback(error, 0)
    )
  }

  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | undefined) => void
  ): void {
    const local = this.handles.get(handle.readUInt32LE(0))
    if (!local) {
      callback(new Error('no such handle'))
      return
    }
    if (this.faults.writeFailureAt !== undefined && position >= this.faults.writeFailureAt) {
      callback(Object.assign(new Error('input/output error'), { code: 'EIO' }))
      return
    }
    void local.write(buffer, offset, length, position).then(
      async () => {
        await this.faults.onWrite?.(position)
        callback(undefined)
      },
      error => callback(error)
    )
  }

  fchmod(handle: Buffer, mode: number, callback: (error: Error | undefined) => void): void {
    const local = this.handles.get(handle.readUInt32LE(0))
    if (!local) {
      callback(new Error('no such handle'))
      return
    }
    void local.chmod(mode).then(
      () => callback(undefined),
      error => callback(error)
    )
  }

  close(handle: Buffer, callback: (error: Error | undefined) => void): void {
    const id = handle.readUInt32LE(0)
    const local = this.handles.get(id)
    if (!local) {
      callback(undefined)
      return
    }
    this.handles.delete(id)
    void local.close().then(
      () => callback(undefined),
      error => callback(error)
    )
  }

  unlink(remotePath: string, callback: (error: Error | undefined) => void): void {
    if (this.faults.unlinkError) {
      callback(this.faults.unlinkError)
      return
    }
    void fsp.unlink(this.local(remotePath)).then(
      () => callback(undefined),
      error => callback(error)
    )
  }

  rename(oldPath: string, newPath: string, callback: (error: Error | undefined) => void): void {
    void fsp.rename(this.local(oldPath), this.local(newPath)).then(
      () => callback(undefined),
      error => callback(error)
    )
  }

  ext_openssh_rename(oldPath: string, newPath: string, callback: (error: Error | undefined) => void): void {
    this.faults.beforeRename?.()
    void fsp.rename(this.local(oldPath), this.local(newPath)).then(
      () => {
        if (this.faults.renameAckLost) return
        callback(undefined)
      },
      error => callback(error)
    )
  }

  ext_openssh_fsync(_handle: Buffer, callback: (error: Error | undefined) => void): void {
    callback(undefined)
  }
}

const POSIX_EXTENSIONS = { 'posix-rename@openssh.com': '1', 'fsync@openssh.com': '1' }

let workDir: string
let remoteRoot: string
let localRoot: string

const env = (
  overrides: Partial<TransferEnvironment> & { expectedSize: number; abort?: TransferAbortController }
): TransferEnvironment => ({
  taskId: 'task-1',
  attemptId: 'attempt-1',
  expectedSize: overrides.expectedSize,
  abort: overrides.abort ?? new TransferAbortController(),
  onPhase: overrides.onPhase,
  onProgress: overrides.onProgress,
  onTempPath: overrides.onTempPath,
  transportFailure: overrides.transportFailure,
  log: () => undefined
})

const remotePath = (name: string): string => `/dir/${name}`

const remoteLocal = (name: string): string => path.join(remoteRoot, 'dir', name)

const localPath = (name: string): string => path.join(localRoot, name)

const writeRemote = async (name: string, content: Buffer | string, mode?: number): Promise<void> => {
  await fsp.mkdir(path.join(remoteRoot, 'dir'), { recursive: true })
  const target = remoteLocal(name)
  await fsp.writeFile(target, content)
  if (mode !== undefined) await fsp.chmod(target, mode)
}

const writeLocal = async (name: string, content: Buffer | string, mode?: number): Promise<void> => {
  const target = localPath(name)
  await fsp.writeFile(target, content)
  if (mode !== undefined) await fsp.chmod(target, mode)
}

const readRemote = (name: string): Promise<Buffer> => fsp.readFile(remoteLocal(name))

const readLocal = (name: string): Promise<Buffer> => fsp.readFile(localPath(name))

const tempResidue = async (dir: string): Promise<string[]> => {
  const entries = await fsp.readdir(dir)
  return entries.filter(name => name.includes('.lyshell-') && name.endsWith('.tmp'))
}

/** 把保留下来的旧版本放回远端路径：先 unlink 再 rename，避免 Windows 拒绝覆盖被打开的句柄文件 */
const restoreRemote = async (keepName: string, name: string): Promise<void> => {
  await fsp.unlink(remoteLocal(name))
  await fsp.rename(remoteLocal(keepName), remoteLocal(name))
}

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lyshell-commit-'))
  remoteRoot = path.join(workDir, 'remote')
  localRoot = path.join(workDir, 'local')
  await fsp.mkdir(path.join(remoteRoot, 'dir'), { recursive: true })
  await fsp.mkdir(localRoot, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true })
})

describe('上传提交协议', () => {
  it('已有目标被原子替换：内容/大小正确、旧权限继承、临时文件不残留', async () => {
    const source = Buffer.alloc(300 * 1024, 7)
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT', 0o640)
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS)
    const phases: string[] = []
    const temps: string[] = []

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length, onPhase: phase => phases.push(phase), onTempPath: p => temps.push(p) })
    })

    expect(result.outcome).toBe('completed')
    expect(result.commitStrategy).toBe('posix-rename')
    expect(result.committed).toBe(true)
    expect(result.finalSize).toBe(source.length)
    // rename 已消费本次创建的临时路径；并非没有创建临时文件。
    expect(result.tempCleanup).toBe('removed')
    expect(phases).toEqual(['data', 'verifying', 'committing', 'completed'])
    expect(temps).toHaveLength(1)
    expect(await readRemote('target.bin')).toEqual(source)
    const stats = await fsp.stat(remoteLocal('target.bin'))
    // Windows 不保留 POSIX 组/其它位（chmod 只映射只读位），精确权限断言只在 POSIX 平台执行
    if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o640)
    expect(stats.isFile()).toBe(true)
    expect(await tempResidue(path.join(remoteRoot, 'dir'))).toEqual([])
  })

  it('目标不存在时可用普通 rename 创建（服务器无 posix-rename）', async () => {
    const source = Buffer.from('hello-new-target')
    await fsp.writeFile(localPath('source.bin'), source)
    const sftp = new FakeSftp(remoteRoot, {})

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('brand-new.bin'),
      env: env({ expectedSize: source.length })
    })

    expect(result.outcome).toBe('completed')
    expect(result.commitStrategy).toBe('plain-rename-new-target')
    expect(await readRemote('brand-new.bin')).toEqual(source)
  })

  it('缺 posix-rename 且目标已存在：明确拒绝，旧目标一个字节都不动', async () => {
    const source = Buffer.from('new data that must not land')
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const sftp = new FakeSftp(remoteRoot, {})

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_ATOMIC_REPLACE_UNSUPPORTED')
    expect(result.commitDispatched).toBe(false)
    // 决策在写数据之前完成：不创建临时文件，更不会删除旧目标
    expect(result.tempCleanup).toBe('unused')
    expect(await readRemote('target.bin')).toEqual(Buffer.from('OLD CONTENT'))
    expect(await tempResidue(path.join(remoteRoot, 'dir'))).toEqual([])
  })

  it('目标符号链接：拒绝覆盖，链接目标与链接本身都不变', async () => {
    const source = Buffer.from('payload')
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('real.bin', 'REAL FILE')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, { symlinkPaths: new Set([remotePath('link.bin')]) })

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('link.bin'),
      env: env({ expectedSize: source.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_TARGET_IS_SYMLINK')
    expect(await readRemote('real.bin')).toEqual(Buffer.from('REAL FILE'))
    expect(await tempResidue(path.join(remoteRoot, 'dir'))).toEqual([])
  })

  it('传输中断：旧目标保持原样，本任务的临时文件被清理', async () => {
    const source = Buffer.alloc(300 * 1024, 3)
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, { writeFailureAt: 128 * 1024 })

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_IO_ERROR')
    expect(result.committed).toBe(false)
    expect(result.phase).toBe('data')
    expect(result.tempCleanup).toBe('removed')
    expect(await readRemote('target.bin')).toEqual(Buffer.from('OLD CONTENT'))
    expect(await tempResidue(path.join(remoteRoot, 'dir'))).toEqual([])
  })

  it('源文件在传输期间变化：拒绝提交，旧目标不变', async () => {
    const source = Buffer.alloc(300 * 1024, 1)
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      onWrite: async position => {
        if (position !== 0) return
        // 传输过程中源文件被另一进程改写：mtime/size 变化
        await fsp.writeFile(localPath('source.bin'), Buffer.alloc(300 * 1024, 9))
      }
    })

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_SOURCE_CHANGED')
    expect(result.committed).toBe(false)
    expect(await readRemote('target.bin')).toEqual(Buffer.from('OLD CONTENT'))
    expect(await tempResidue(path.join(remoteRoot, 'dir'))).toEqual([])
  })

  it('目标在传输期间被他人改动：拒绝覆盖，保留他人结果', async () => {
    const source = Buffer.alloc(300 * 1024, 1)
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      onWrite: async position => {
        if (position !== 0) return
        await writeRemote('target.bin', 'SOMEONE ELSE WROTE THIS')
      }
    })

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_TARGET_CHANGED')
    expect(await readRemote('target.bin')).toEqual(Buffer.from('SOMEONE ELSE WROTE THIS'))
    expect(await tempResidue(path.join(remoteRoot, 'dir'))).toEqual([])
  })

  it('提交前取消：报 cancelled，旧目标不变，临时文件清理', async () => {
    const source = Buffer.alloc(300 * 1024, 2)
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const abort = new TransferAbortController()
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      onWrite: position => {
        if (position === 0) abort.abort('user cancelled')
      }
    })

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length, abort })
    })

    expect(result.outcome).toBe('cancelled')
    expect(result.error?.code).toBe('TRANSFER_CANCELLED')
    expect(result.committed).toBe(false)
    expect(result.tempCleanup).toBe('removed')
    expect(await readRemote('target.bin')).toEqual(Buffer.from('OLD CONTENT'))
    expect(await tempResidue(path.join(remoteRoot, 'dir'))).toEqual([])
  })

  it('提交已派发后取消无效：rename 完成即报完成', async () => {
    const source = Buffer.from('cancel-too-late')
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const abort = new TransferAbortController()
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, { beforeRename: () => abort.abort('too late') })

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length, abort })
    })

    expect(result.outcome).toBe('completed')
    expect(result.committed).toBe(true)
    expect(await readRemote('target.bin')).toEqual(source)
  })

  it('rename 回执丢失：报结果未知（OUTCOME_UNKNOWN），不重试、附核查信息', async () => {
    const source = Buffer.from('ack lost payload')
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, { renameAckLost: true })
    let rejectTransport: ((error: Error) => void) | null = null
    const transportFailure = new Promise<never>((_resolve, reject) => {
      rejectTransport = reject
    })
    void transportFailure.catch(() => undefined)

    const pending = commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length, transportFailure })
    })
    // rename 已经执行、回执永远不会来：模拟连接中断
    await new Promise(resolve => setTimeout(resolve, 30))
    rejectTransport!(new Error('connection closed'))
    const result = await pending

    expect(result.outcome).toBe('outcome-unknown')
    expect(result.error?.code).toBe('TRANSFER_COMMIT_ACK_LOST')
    expect(result.commitDispatched).toBe(true)
    expect(result.tempPattern).toContain('.target.bin.lyshell-attempt-1-*.tmp')
    expect(result.targetPath).toBe(remotePath('target.bin'))
    // 无法确认是否生效：不重试、不删目标、也不谎报成功
    expect(await readRemote('target.bin')).toEqual(source)
  })

  it('无法清理临时文件时如实上报残留路径', async () => {
    const source = Buffer.alloc(200 * 1024, 4)
    await fsp.writeFile(localPath('source.bin'), source)
    await writeRemote('target.bin', 'OLD CONTENT')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      writeFailureAt: 64 * 1024,
      unlinkError: Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    const result = await commitUpload({
      sftp,
      localPath: localPath('source.bin'),
      remotePath: remotePath('target.bin'),
      env: env({ expectedSize: source.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.tempCleanup).toBe('failed')
    expect(result.tempResidual).toBeTruthy()
    expect(path.posix.dirname(result.tempResidual!)).toBe(remotePath('target.bin').replace(/\/[^/]+$/, ''))
    expect(result.warnings.join('\n')).toContain('临时文件未能确认清理')
    expect(await readRemote('target.bin')).toEqual(Buffer.from('OLD CONTENT'))
  })
})

describe('下载提交协议', () => {
  const putRemote = async (name: string, content: Buffer, mode?: number): Promise<void> => {
    await writeRemote(name, content, mode)
  }

  it('下载覆盖已有本地文件：rename 原子替换、权限继承、无临时残留', async () => {
    const remote = Buffer.alloc(300 * 1024, 5)
    await putRemote('source.bin', remote)
    await writeLocal('target.bin', 'OLD LOCAL', 0o600)
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS)
    const phases: string[] = []

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('target.bin'),
      env: env({ expectedSize: remote.length, onPhase: phase => phases.push(phase) })
    })

    expect(result.outcome).toBe('completed')
    expect(result.commitStrategy).toBe('local-rename')
    expect(result.finalSize).toBe(remote.length)
    expect(result.fileFsync).toBe('file')
    expect(['synced', 'unsupported', 'failed']).toContain(result.directoryFsync)
    expect(phases).toEqual(['data', 'verifying', 'committing', 'completed'])
    expect(await readLocal('target.bin')).toEqual(remote)
    const stats = await fsp.stat(localPath('target.bin'))
    if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o600)
    expect(stats.isFile()).toBe(true)
    expect(await tempResidue(localRoot)).toEqual([])
  })

  it('下载到不存在的新目标：创建成功', async () => {
    const remote = Buffer.from('brand new download')
    await putRemote('source.bin', remote)
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS)

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('new.bin'),
      env: env({ expectedSize: remote.length })
    })

    expect(result.outcome).toBe('completed')
    expect(await readLocal('new.bin')).toEqual(remote)
  })

  it('远端源在传输期间变化：拒绝提交，本地旧目标不变', async () => {
    const remote = Buffer.alloc(300 * 1024, 6)
    await putRemote('source.bin', remote)
    await writeLocal('target.bin', 'OLD LOCAL')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      onRead: async position => {
        if (position !== 0) return
        await putRemote('source.bin', Buffer.alloc(300 * 1024, 8))
      }
    })

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('target.bin'),
      env: env({ expectedSize: remote.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_SOURCE_CHANGED')
    expect(await readLocal('target.bin')).toEqual(Buffer.from('OLD LOCAL'))
    expect(await tempResidue(localRoot)).toEqual([])
  })

  it('源在 stat 与 open 之间被同大小不同 mtime 替换（路径随后还原）：拒绝提交，旧目标原字节不变', async () => {
    // 版本 A 与版本 B 字节数相同，只有内容与 mtime 不同：size 检查无法区分两者。
    const versionA = Buffer.from('VERSION-A-original')
    const versionB = Buffer.from('VERSION-B-INTRUDER')
    expect(versionB.length).toBe(versionA.length)
    await putRemote('source.bin', versionA)
    await writeLocal('target.bin', 'OLD LOCAL')

    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      // stat 已经看到版本 A，open 之前路径被换成版本 B（B 的 mtime 与 A 不同）
      beforeOpen: async () => {
        await fsp.rename(remoteLocal('source.bin'), remoteLocal('keep.bin'))
        await putRemote('source.bin', versionB)
        await fsp.utimes(remoteLocal('source.bin'), 1_600_000_123.456, 1_600_000_123.456)
      },
      // 路径在读取期间又被还原成版本 A（同一份文件的 rename，mtime 精确保留）
      onRead: async position => {
        if (position !== 0) return
        await restoreRemote('keep.bin', 'source.bin')
      }
    })

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('target.bin'),
      env: env({ expectedSize: versionA.length })
    })

    // 服务器 fstat 已经给出与路径 stat 不一致的 mtime：必须在读取前就拒绝
    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_SOURCE_CHANGED')
    expect(result.commitDispatched).toBe(false)
    expect(result.committed).toBe(false)
    expect(result.tempCleanup).toBe('unused')
    expect(await readLocal('target.bin')).toEqual(Buffer.from('OLD LOCAL'))
    expect(await fsp.readdir(localRoot)).toEqual(['target.bin'])
  })

  it('读取句柄在传输期间变化而路径始终还原旧快照：拒绝提交，旧目标原字节不变', async () => {
    const versionA = Buffer.from('VERSION-A-original')
    const versionB = Buffer.from('VERSION-B-INTRUDER')
    expect(versionB.length).toBe(versionA.length)
    const fixedMtime = 1_600_000_000.25
    await putRemote('source.bin', versionA)
    await putRemote('keep.bin', versionA)
    // 还原副本与源用同一 utimes 输入，保证“旧快照”的 mtime 精确可比
    await fsp.utimes(remoteLocal('source.bin'), fixedMtime, fixedMtime)
    await fsp.utimes(remoteLocal('keep.bin'), fixedMtime, fixedMtime)
    await writeLocal('target.bin', 'OLD LOCAL')

    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      onRead: async position => {
        if (position !== 0) return
        // 传输中直接改写被句柄打开的源（同一 inode），并把它的 mtime 改到新版本
        const handle = await fsp.open(remoteLocal('source.bin'), 'r+')
        await handle.writeFile(versionB)
        await handle.close()
        await fsp.utimes(remoteLocal('source.bin'), fixedMtime + 60, fixedMtime + 60)
        // 路径随后还原成旧快照：大小与 mtime 都与初始 stat 完全一致
        await restoreRemote('keep.bin', 'source.bin')
      }
    })

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('target.bin'),
      env: env({ expectedSize: versionA.length })
    })

    // 路径 stat 复核通过，但读取句柄本身已不是初始版本：必须拒绝拼接出的内容
    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_SOURCE_CHANGED')
    expect(result.commitDispatched).toBe(false)
    expect(result.committed).toBe(false)
    expect(result.tempCleanup).toBe('removed')
    expect(await readLocal('target.bin')).toEqual(Buffer.from('OLD LOCAL'))
    expect(await tempResidue(localRoot)).toEqual([])
  })

  it('本地目标在传输期间被改动：拒绝覆盖，保留他人写入', async () => {
    const remote = Buffer.alloc(300 * 1024, 6)
    await putRemote('source.bin', remote)
    await writeLocal('target.bin', 'OLD LOCAL')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      onRead: async position => {
        if (position !== 0) return
        await writeLocal('target.bin', 'SOMEONE ELSE WROTE')
      }
    })

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('target.bin'),
      env: env({ expectedSize: remote.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_TARGET_CHANGED')
    expect(await readLocal('target.bin')).toEqual(Buffer.from('SOMEONE ELSE WROTE'))
    expect(await tempResidue(localRoot)).toEqual([])
  })

  it('下载取消（数据阶段）：报 cancelled，临时文件清理，旧目标不变', async () => {
    const remote = Buffer.alloc(300 * 1024, 2)
    await putRemote('source.bin', remote)
    await writeLocal('target.bin', 'OLD LOCAL')
    const abort = new TransferAbortController()
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, {
      onRead: position => {
        if (position === 0) abort.abort('cancelled')
      }
    })

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('target.bin'),
      env: env({ expectedSize: remote.length, abort })
    })

    expect(result.outcome).toBe('cancelled')
    expect(result.tempCleanup).toBe('removed')
    expect(await readLocal('target.bin')).toEqual(Buffer.from('OLD LOCAL'))
    expect(await tempResidue(localRoot)).toEqual([])
  })

  it('远端安装目录列出的文件大小与派发时不一致：拒绝下载', async () => {
    const remote = Buffer.from('12345')
    await putRemote('source.bin', remote)
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS)

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('never.bin'),
      env: env({ expectedSize: 999 })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_SOURCE_CHANGED')
    expect(await fsp.readdir(localRoot)).toEqual([])
  })

  it('本地目标是符号链接：拒绝覆盖（平台不支持创建符号链接时跳过）', async () => {
    const remote = Buffer.from('payload')
    await putRemote('source.bin', remote)
    await writeLocal('real.bin', 'REAL LOCAL')
    try {
      await fsp.symlink(localPath('real.bin'), localPath('link.bin'))
    } catch {
      return
    }
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS)

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('link.bin'),
      env: env({ expectedSize: remote.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('TRANSFER_TARGET_IS_SYMLINK')
    expect(await readLocal('real.bin')).toEqual(Buffer.from('REAL LOCAL'))
    expect(await fsp.readlink(localPath('link.bin'))).toBe(localPath('real.bin'))
    expect(await tempResidue(localRoot)).toEqual([])
  })

  it('本地写入中断：旧目标不变，临时文件清理', async () => {
    const remote = Buffer.alloc(300 * 1024, 3)
    await putRemote('source.bin', remote)
    await writeLocal('target.bin', 'OLD LOCAL')
    const sftp = new FakeSftp(remoteRoot, POSIX_EXTENSIONS, { readFailureAt: 1024 })

    const result = await commitDownload({
      sftp,
      remotePath: remotePath('source.bin'),
      localPath: localPath('target.bin'),
      env: env({ expectedSize: remote.length })
    })

    expect(result.outcome).toBe('failed')
    expect(result.tempCleanup).toBe('removed')
    expect(await readLocal('target.bin')).toEqual(Buffer.from('OLD LOCAL'))
    expect(await tempResidue(localRoot)).toEqual([])
  })
})
