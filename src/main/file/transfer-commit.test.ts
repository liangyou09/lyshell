import { describe, expect, it } from 'vitest'
import path from 'path'
import {
  buildSyntheticResult,
  classifyTransferFailure,
  compareSourceSnapshot,
  compareTargetSnapshot,
  createTransportFailureSignal,
  decideDownloadCommit,
  decideUploadCommit,
  describeTransferTempPattern,
  missingSnapshot,
  supportsFsync,
  supportsPosixRename,
  transferPercent,
  transferTempPath,
  TransferCommitError,
  TransferTransportLostError,
  verifyTransferSize,
  type FileSnapshot,
  type TransferSftp,
} from './transfer-commit'

/**
 * OPT-11 纯逻辑测试：提交策略、快照比较、临时文件命名、字节校验、
 * 失败分类与连接中断信号。全部无 IO。
 */

const file = (overrides: Partial<FileSnapshot> = {}): FileSnapshot => ({
  exists: true,
  kind: 'file',
  size: 100,
  mtimeMs: 1_000,
  mode: 0o100644,
  ...overrides,
})

const sftpWith = (extensions?: Record<string, string>, methods: { rename?: boolean; fsync?: boolean } = {}): TransferSftp => {
  const sftp: Partial<TransferSftp> = {}
  if (extensions) sftp._extensions = extensions
  if (methods.rename) {
    sftp.ext_openssh_rename = (_old, _next, callback) => callback(undefined)
  }
  if (methods.fsync) {
    sftp.ext_openssh_fsync = (_handle, callback) => callback(undefined)
  }
  return sftp as TransferSftp
}

describe('上传提交策略', () => {
  it('新目标在缺少 posix-rename 时允许普通 rename 创建', () => {
    expect(decideUploadCommit({ target: missingSnapshot(), posixRename: false })).toEqual({
      ok: true,
      strategy: 'plain-rename-new-target',
    })
  })

  it('已有目标在有 posix-rename 时原子替换', () => {
    expect(decideUploadCommit({ target: file(), posixRename: true })).toEqual({
      ok: true,
      strategy: 'posix-rename',
    })
  })

  it('已有目标缺 posix-rename 时明确拒绝，绝不先删旧文件', () => {
    const decision = decideUploadCommit({ target: file(), posixRename: false })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe('TRANSFER_ATOMIC_REPLACE_UNSUPPORTED')
      expect(decision.message).toContain('拒绝危险覆盖')
    }
  })

  it('符号链接与非普通文件一律拒绝', () => {
    const symlink = decideUploadCommit({ target: file({ kind: 'symlink' }), posixRename: true })
    expect(symlink.ok).toBe(false)
    if (!symlink.ok) expect(symlink.code).toBe('TRANSFER_TARGET_IS_SYMLINK')

    const directory = decideUploadCommit({ target: file({ kind: 'directory' }), posixRename: true })
    expect(directory.ok).toBe(false)
    if (!directory.ok) expect(directory.code).toBe('TRANSFER_TARGET_UNSAFE_TYPE')
  })
})

describe('下载提交策略', () => {
  it('普通文件或新目标都用本地同目录 rename', () => {
    expect(decideDownloadCommit({ target: file() })).toEqual({ ok: true, strategy: 'local-rename' })
    expect(decideDownloadCommit({ target: missingSnapshot() })).toEqual({
      ok: true,
      strategy: 'local-rename',
    })
  })

  it('符号链接与非普通文件拒绝覆盖', () => {
    const symlink = decideDownloadCommit({ target: file({ kind: 'symlink' }) })
    expect(symlink.ok).toBe(false)
    if (!symlink.ok) expect(symlink.code).toBe('TRANSFER_TARGET_IS_SYMLINK')

    const other = decideDownloadCommit({ target: file({ kind: 'other' }) })
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.code).toBe('TRANSFER_TARGET_UNSAFE_TYPE')
  })
})

describe('目标快照比较', () => {
  it('未变化/出现/消失/修改/类型变化', () => {
    const initial = file()
    expect(compareTargetSnapshot(initial, file())).toBe('unchanged')
    expect(compareTargetSnapshot(missingSnapshot(), missingSnapshot())).toBe('unchanged')
    expect(compareTargetSnapshot(missingSnapshot(), file())).toBe('appeared')
    expect(compareTargetSnapshot(initial, missingSnapshot())).toBe('removed')
    expect(compareTargetSnapshot(initial, file({ size: 101 }))).toBe('modified')
    expect(compareTargetSnapshot(initial, file({ mtimeMs: 2_000 }))).toBe('modified')
    expect(compareTargetSnapshot(initial, file({ mode: 0o100600 }))).toBe('modified')
    expect(compareTargetSnapshot(initial, file({ kind: 'directory' }))).toBe('type-changed')
  })
})

describe('源快照比较', () => {
  it('未变化/消失/类型/大小/mtime/身份', () => {
    const initial = file({ dev: 1, ino: 2 })
    expect(compareSourceSnapshot(initial, file({ dev: 1, ino: 2 }))).toBe('unchanged')
    expect(compareSourceSnapshot(initial, missingSnapshot())).toBe('missing')
    expect(compareSourceSnapshot(initial, file({ dev: 1, ino: 2, kind: 'directory' }))).toBe('type-changed')
    expect(compareSourceSnapshot(initial, file({ dev: 1, ino: 2, size: 9 }))).toBe('size')
    expect(compareSourceSnapshot(initial, file({ dev: 1, ino: 2, mtimeMs: 5 }))).toBe('mtime')
    expect(compareSourceSnapshot(initial, file({ dev: 1, ino: 3 }))).toBe('identity')
    expect(compareSourceSnapshot(initial, file({ dev: 9, ino: 2 }))).toBe('identity')
  })
})

describe('字节计数校验', () => {
  it('字节数与最终大小都必须与预期一致', () => {
    expect(verifyTransferSize({ expectedSize: 10, transferredBytes: 10, finalSize: 10 })).toEqual({ ok: true })

    const shortBytes = verifyTransferSize({ expectedSize: 10, transferredBytes: 9, finalSize: 9 })
    expect(shortBytes.ok).toBe(false)

    const shortFile = verifyTransferSize({ expectedSize: 10, transferredBytes: 10, finalSize: 8 })
    expect(shortFile.ok).toBe(false)
    if (!shortFile.ok) expect(shortFile.message).toContain('最终文件大小')
  })
})

describe('临时文件命名', () => {
  it('与目标同目录、隐藏、含尝试标识，上传使用 posix 语义', () => {
    const temp = transferTempPath('/remote/dir/report.txt', 'upload', 'attempt-1234-abcd-efgh', 'deadbeefdeadbeef')
    expect(temp).toBe('/remote/dir/.report.txt.lyshell-attempt-1234-deadbeefdeadbeef.tmp')
    expect(describeTransferTempPattern('/remote/dir/report.txt', 'upload', 'attempt-1234-abcd')).toBe(
      '/remote/dir/.report.txt.lyshell-attempt-1234-*.tmp'
    )
  })

  it('清洗尝试标识与超长文件名，保持唯一随机后缀', () => {
    const temp = transferTempPath('/tmp/x.txt', 'download', '../../etc/passwd', '0123456789abcdef')
    // 下载方向使用宿主 path 语义（Windows 上是反斜杠）
    expect(temp).toBe(path.join('/tmp', '.x.txt.lyshell-etcpasswd-0123456789abcdef.tmp'))

    const longName = 'a'.repeat(120)
    const longTemp = transferTempPath(`/tmp/${longName}`, 'download', 'id', 'ff')
    expect(longTemp).toBe(path.join('/tmp', `.${'a'.repeat(48)}.lyshell-id-ff.tmp`))
  })

  it('每次调用生成不同的随机后缀', () => {
    const first = transferTempPath('/tmp/a.bin', 'download', 'id')
    const second = transferTempPath('/tmp/a.bin', 'download', 'id')
    expect(first).not.toBe(second)
  })
})

describe('服务器能力探测', () => {
  it('以扩展表为准，缺少扩展时不使用同名方法', () => {
    expect(supportsPosixRename(sftpWith({ 'posix-rename@openssh.com': '1' }))).toBe(true)
    expect(supportsPosixRename(sftpWith({}, { rename: true }))).toBe(false)
    expect(supportsPosixRename(sftpWith())).toBe(false)

    expect(supportsFsync(sftpWith({ 'fsync@openssh.com': '1' }))).toBe(true)
    expect(supportsFsync(sftpWith({}, { fsync: true }))).toBe(false)
  })
})

describe('失败分类', () => {
  it('取消/提交回执丢失/连接中断/普通 IO 错误', () => {
    expect(
      classifyTransferFailure(new TransferCommitError('TRANSFER_CANCELLED', 'cancelled', 'data'), {
        phase: 'data',
        commitDispatched: false,
        committed: false,
      })
    ).toMatchObject({ outcome: 'cancelled', code: 'TRANSFER_CANCELLED' })

    expect(
      classifyTransferFailure(new TransferCommitError('TRANSFER_COMMIT_ACK_LOST', 'ack lost', 'committing'), {
        phase: 'committing',
        commitDispatched: true,
        committed: false,
      })
    ).toMatchObject({ outcome: 'outcome-unknown', code: 'TRANSFER_COMMIT_ACK_LOST' })

    expect(
      classifyTransferFailure(new TransferTransportLostError('connection closed'), {
        phase: 'committing',
        commitDispatched: true,
        committed: false,
      })
    ).toMatchObject({ outcome: 'outcome-unknown', code: 'TRANSFER_COMMIT_ACK_LOST' })

    const econnreset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(
      classifyTransferFailure(econnreset, { phase: 'data', commitDispatched: false, committed: false })
    ).toMatchObject({ outcome: 'failed', code: 'TRANSFER_IO_ERROR' })

    expect(
      classifyTransferFailure(new Error('disk full'), { phase: 'data', commitDispatched: false, committed: false })
    ).toMatchObject({ outcome: 'failed', code: 'TRANSFER_IO_ERROR', message: 'disk full' })
  })

  it('提交已生效后的失败保持 failed，不报未知', () => {
    expect(
      classifyTransferFailure(new TransferCommitError('TRANSFER_FINAL_VERIFY_FAILED', 'verify', 'completed'), {
        phase: 'completed',
        commitDispatched: true,
        committed: true,
      })
    ).toMatchObject({ outcome: 'failed', code: 'TRANSFER_FINAL_VERIFY_FAILED' })
  })
})

describe('合成结果', () => {
  it('带临时文件路径但没有清理结论时标记 unknown，便于用户核查残留', () => {
    const result = buildSyntheticResult({
      taskId: 't1',
      attemptId: 'a1',
      direction: 'upload',
      outcome: 'failed',
      expectedSize: 10,
      targetPath: '/remote/a.bin',
      tempPath: '/remote/.a.bin.lyshell-a1-x.tmp',
      code: 'TRANSFER_IO_ERROR',
      message: 'boom',
    })
    expect(result.tempCleanup).toBe('unknown')
    expect(result.tempResidual).toBe('/remote/.a.bin.lyshell-a1-x.tmp')
    expect(result.tempPattern).toContain('.a.bin.lyshell-a1-*.tmp')
    expect(result.error).toEqual({ code: 'TRANSFER_IO_ERROR', message: 'boom' })
  })

  it('没有临时文件时标记 unused', () => {
    const result = buildSyntheticResult({
      taskId: 't2',
      attemptId: 'a2',
      direction: 'download',
      outcome: 'cancelled',
      expectedSize: 0,
      targetPath: '/tmp/a.bin',
      code: 'TRANSFER_CANCELLED',
    })
    expect(result.tempCleanup).toBe('unused')
    expect(result.tempPath).toBeUndefined()
  })
})

describe('连接中断信号', () => {
  it('error/close 都触发失败，dispose 后不再触发', async () => {
    const emitter = new (await import('events')).EventEmitter()
    const signal = createTransportFailureSignal([{ on: emitter.on.bind(emitter) }])
    emitter.emit('close')
    await expect(signal.failure).rejects.toBeInstanceOf(TransferTransportLostError)
    signal.dispose()

    const second = createTransportFailureSignal([{ on: emitter.on.bind(emitter) }])
    second.dispose()
    emitter.emit('error', new Error('late'))
    await new Promise(resolve => setTimeout(resolve, 5))
    // dispose 之后不会 reject；预挂 catch 保证没有 unhandledRejection
    await expect(Promise.race([second.failure, Promise.resolve('quiet')])).resolves.toBe('quiet')
  })
})

describe('百分比', () => {
  it('夹取到 0..100，未知总量时按已传输字节推断', () => {
    expect(transferPercent(5, 10)).toBe(50)
    expect(transferPercent(20, 10)).toBe(100)
    expect(transferPercent(-1, 10)).toBe(0)
    expect(transferPercent(0, 0)).toBe(0)
    expect(transferPercent(3, 0)).toBe(100)
  })
})
