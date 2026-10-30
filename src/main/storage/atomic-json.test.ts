import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

const fault = vi.hoisted(() => ({
  write: false,
  rename: false,
  fsync: false,
  open: false,
  read: false,
  asyncRename: false,
  copyCode: undefined as string | undefined,
  copyCollide: false,
  copies: [] as string[],
  temps: [] as string[]
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.write) throw Object.assign(new Error('simulated write failure'), { code: 'ENOSPC' })
      return actual.writeFileSync(...args)
    }) as typeof actual.writeFileSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (fault.rename) throw Object.assign(new Error('simulated rename failure'), { code: 'EPERM' })
      return actual.renameSync(...args)
    }) as typeof actual.renameSync,
    fsyncSync: ((...args: Parameters<typeof actual.fsyncSync>) => {
      if (fault.fsync) throw Object.assign(new Error('simulated fsync failure'), { code: 'EIO' })
      return actual.fsyncSync(...args)
    }) as typeof actual.fsyncSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      if (fault.open) throw Object.assign(new Error('simulated temp create failure'), { code: 'EACCES' })
      fault.temps.push(String(args[0]))
      return actual.openSync(...args)
    }) as typeof actual.openSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (fault.read) throw Object.assign(new Error('simulated permission failure'), { code: 'EACCES' })
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
    copyFileSync: ((...args: Parameters<typeof actual.copyFileSync>) => {
      fault.copies.push(String(args[1]))
      if (fault.copyCollide) throw Object.assign(new Error('simulated naming collision'), { code: 'EEXIST' })
      if (fault.copyCode) {
        throw Object.assign(new Error(`simulated copy failure ${fault.copyCode}`), { code: fault.copyCode })
      }
      return actual.copyFileSync(...args)
    }) as typeof actual.copyFileSync
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      if (fault.asyncRename) throw Object.assign(new Error('simulated async rename failure'), { code: 'EPERM' })
      return actual.rename(...args)
    }) as typeof actual.rename
  }
})

import {
  AtomicJsonError,
  atomicWriteFileSync,
  atomicWriteFile,
  backupPathFor,
  JsonStoreLoadError,
  loadJsonFileSync,
  readJsonFileSync,
  recoverJsonFileFromBackupSync,
  writeBackupSync
} from './atomic-json'

let dir: string
const file = () => join(dir, 'store.json')
const leftovers = () => readdirSync(dir).filter(name => name.includes('.tmp'))

beforeEach(() => {
  dir = join(tmpdir(), `lyshell-atomic-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  fault.write = fault.rename = fault.fsync = fault.open = fault.read = fault.asyncRename = false
  fault.copyCode = undefined
  fault.copyCollide = false
  fault.copies = []
  fault.temps = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('atomicWriteFileSync', () => {
  it('写入成功、0600、不留临时文件，覆盖时只保留新内容', () => {
    writeFileSync(file(), 'old')
    atomicWriteFileSync(file(), '{"v":1}')
    expect(readFileSync(file(), 'utf8')).toBe('{"v":1}')
    expect(leftovers()).toEqual([])
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['write', 'ENOSPC', 'write'],
    ['fsync', 'EIO', 'fsync'],
    ['rename', 'EPERM', 'rename'],
    ['open', 'EACCES', 'temp-create']
  ] as const)('%s 失败时旧目标完整、临时对象清理并抛出带 phase 的错误', (key, code, phase) => {
    writeFileSync(file(), 'old-complete')
    fault[key] = true
    let thrown: unknown
    try {
      atomicWriteFileSync(file(), 'new-content')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AtomicJsonError)
    expect((thrown as AtomicJsonError).phase).toBe(phase)
    expect((thrown as Error).message).toContain('simulated')
    expect(((thrown as AtomicJsonError).cause as { code?: string }).code).toBe(code)
    expect(readFileSync(file(), 'utf8')).toBe('old-complete')
    expect(leftovers()).toEqual([])
  })

  it('目标不存在且 rename 失败时不留半成品目标或临时文件', () => {
    fault.rename = true
    expect(() => atomicWriteFileSync(file(), 'x')).toThrow(AtomicJsonError)
    expect(existsSync(file())).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('临时文件名同目录且每次唯一', () => {
    atomicWriteFileSync(file(), 'one')
    atomicWriteFileSync(file(), 'two')
    expect(fault.temps).toHaveLength(2)
    for (const temp of fault.temps) {
      expect(join(temp, '..')).toBe(dir)
      expect(temp).not.toBe(file())
    }
    expect(new Set(fault.temps).size).toBe(2)
    expect(leftovers()).toEqual([])
  })
})

describe('atomicWriteFile（异步）', () => {
  it('成功提交且不留临时文件', async () => {
    await atomicWriteFile(file(), 'async-ok')
    expect(readFileSync(file(), 'utf8')).toBe('async-ok')
    expect(leftovers()).toEqual([])
  })

  it('rename 失败保留旧目标并清理临时文件', async () => {
    writeFileSync(file(), 'old')
    fault.asyncRename = true
    await expect(atomicWriteFile(file(), 'new')).rejects.toBeInstanceOf(AtomicJsonError)
    expect(readFileSync(file(), 'utf8')).toBe('old')
    expect(leftovers()).toEqual([])
  })
})

describe('readJsonFileSync / loadJsonFileSync', () => {
  it('损坏 JSON 的错误对象和日志说明不携带原文片段', () => {
    writeFileSync(file(), 'fixture-secret-value-not-json')
    const result = loadJsonFileSync(file(), { validate: raw => raw })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(String(result.error)).not.toContain('fixture-secret-value')
      expect(result.error.cause).toBeUndefined()
    }
  })
  const validate = (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('object required')
    return raw as Record<string, unknown>
  }

  it('区分 missing / ok / corrupt', () => {
    expect(readJsonFileSync(file(), validate).status).toBe('missing')
    writeFileSync(file(), '{"a":1}')
    expect(readJsonFileSync(file(), validate).status).toBe('ok')
    writeFileSync(file(), '{broken')
    const corrupt = readJsonFileSync(file(), validate)
    expect(corrupt.status).toBe('corrupt')
  })

  it('读取权限失败归类为 unreadable 且不改文件', () => {
    writeFileSync(file(), '{"a":1}')
    fault.read = true
    const result = readJsonFileSync(file(), validate)
    fault.read = false
    expect(result.status).toBe('unreadable')
    expect(readFileSync(file(), 'utf8')).toBe('{"a":1}')
  })

  it('损坏时默认只保留 .corrupt-* 副本，不自动用备份覆盖', () => {
    writeFileSync(file(), '{broken')
    writeFileSync(backupPathFor(file()), '{"from":"backup"}')
    const result = loadJsonFileSync(file(), { validate })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error).toBeInstanceOf(JsonStoreLoadError)
    expect(readFileSync(file(), 'utf8')).toBe('{broken')
    const preserved = readdirSync(dir).filter(name => name.includes('.corrupt-'))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(dir, preserved[0]), 'utf8')).toBe('{broken')
  })

  it('显式恢复要求备份通过同一校验，恢复后原文进入 .corrupt-*', () => {
    writeFileSync(file(), '{broken')
    writeFileSync(backupPathFor(file()), '{"from":"backup"}')
    expect(recoverJsonFileFromBackupSync(file(), validate)).toBe(true)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ from: 'backup' })
    const preserved = readdirSync(dir).filter(name => name.includes('.corrupt-'))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(dir, preserved[0]), 'utf8')).toBe('{broken')
  })

  it('备份 schema 不合法时拒绝恢复且正式文件不变', () => {
    writeFileSync(file(), '{"live":true}')
    writeFileSync(backupPathFor(file()), '[]')
    expect(recoverJsonFileFromBackupSync(file(), validate)).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('{"live":true}')
  })
})

describe('损坏原件无法保全时必须停止恢复（F04）', () => {
  const validate = (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('object required')
    return raw as Record<string, unknown>
  }
  const primaryBytes = '{broken-primary-bytes'
  const backupBytes = '{"from":"backup"}'
  const corruptCopies = () => readdirSync(dir).filter(name => name.includes('.corrupt-'))
  const seedCorruptWithValidBackup = () => {
    writeFileSync(file(), primaryBytes)
    writeFileSync(backupPathFor(file()), backupBytes)
  }

  it.each([
    ['EACCES', 'EACCES'],
    ['ENOSPC', 'ENOSPC']
  ])('copy 失败（%s）时不恢复，返回 failed 且原件字节不变', (_label, code) => {
    seedCorruptWithValidBackup()
    fault.copyCode = code
    const result = loadJsonFileSync(file(), { validate, backup: true })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error).toBeInstanceOf(JsonStoreLoadError)
      expect(result.error.reason).toBe('corrupt')
      expect(result.preservedPath).toBeUndefined()
    }
    expect(readFileSync(file(), 'utf8')).toBe(primaryBytes)
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe(backupBytes)

    fault.copyCode = code
    expect(recoverJsonFileFromBackupSync(file(), validate)).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(primaryBytes)
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe(backupBytes)
  })

  it('100 个命名冲突（COPYFILE_EXCL 持续 EEXIST）耗尽后不恢复，返回 failed', () => {
    seedCorruptWithValidBackup()
    fault.copyCollide = true
    const result = loadJsonFileSync(file(), { validate, backup: true })
    expect(fault.copies).toHaveLength(100)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.preservedPath).toBeUndefined()
    expect(readFileSync(file(), 'utf8')).toBe(primaryBytes)
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe(backupBytes)
  })

  it('默认损坏只读行为不变：copy 失败时仍 failed，不写正式文件也不消耗备份', () => {
    seedCorruptWithValidBackup()
    fault.copyCode = 'EACCES'
    const result = loadJsonFileSync(file(), { validate })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.preservedPath).toBeUndefined()
    expect(readFileSync(file(), 'utf8')).toBe(primaryBytes)
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe(backupBytes)
  })

  it('备份无效时不恢复，保留损坏原件副本且备份不被消耗', () => {
    writeFileSync(file(), primaryBytes)
    writeFileSync(backupPathFor(file()), '[]')
    const result = loadJsonFileSync(file(), { validate, backup: true })
    expect(result.status).toBe('failed')
    expect(readFileSync(file(), 'utf8')).toBe(primaryBytes)
    const copies = corruptCopies()
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(dir, copies[0]), 'utf8')).toBe(primaryBytes)
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe('[]')
    expect(recoverJsonFileFromBackupSync(file(), validate)).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(primaryBytes)
  })

  it('恢复期 rename 失败时不覆盖正式文件，保留损坏副本与备份', () => {
    seedCorruptWithValidBackup()
    fault.rename = true
    const result = loadJsonFileSync(file(), { validate, backup: true })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error).toBeInstanceOf(JsonStoreLoadError)
      expect(result.preservedPath).toBeDefined()
    }
    expect(readFileSync(file(), 'utf8')).toBe(primaryBytes)
    const copies = corruptCopies()
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(dir, copies[0]), 'utf8')).toBe(primaryBytes)
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe(backupBytes)
    fault.rename = false
    expect(recoverJsonFileFromBackupSync(file(), validate)).toBe(true)
    expect(readFileSync(file(), 'utf8')).toBe(backupBytes)
  })

  it('正常恢复：返回 recovered，正式文件变为备份内容，原件副本与备份都保留', () => {
    seedCorruptWithValidBackup()
    const result = loadJsonFileSync(file(), { validate, backup: true })
    expect(result.status).toBe('recovered')
    if (result.status === 'recovered') {
      expect(result.value).toEqual({ from: 'backup' })
      expect(result.raw).toBe(backupBytes)
      expect(result.preservedPath).toBeDefined()
      expect(readFileSync(result.preservedPath as string, 'utf8')).toBe(primaryBytes)
    }
    expect(readFileSync(file(), 'utf8')).toBe(backupBytes)
    expect(corruptCopies()).toHaveLength(1)
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe(backupBytes)
  })
})

describe('writeBackupSync', () => {
  it('备份写入成功返回 true，失败只返回 false 且不影响正式文件', () => {
    expect(writeBackupSync(file(), '{"a":1}')).toBe(true)
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe('{"a":1}')
    fault.write = true
    expect(writeBackupSync(file(), '{"a":2}')).toBe(false)
    expect(readFileSync(backupPathFor(file()), 'utf8')).toBe('{"a":1}')
  })
})
