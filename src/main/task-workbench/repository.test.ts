import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  TaskArtifact,
  TaskDefinition,
  TaskEntry,
  TaskResultBundle,
  TaskSubmission,
  TaskWorkbenchManifest
} from '@shared/task-workbench'
import { atomicWriteFile } from '../storage/atomic-json'
import {
  TASK_WORKBENCH_ARTIFACT_BYTES_LIMIT,
  TASK_WORKBENCH_MAX_MANIFEST_BYTES,
  TaskWorkbenchRepository,
  createEmptyTaskWorkbenchManifest
} from './repository'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const AT = 1_700_000_000_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeDefinition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    title: '组件性能回归',
    goal: '确认优化后没有性能回退',
    workspace: 'D:/workspace/demo',
    templateId: 'component-performance',
    acceptanceCriteria: '所有指标都在阈值内',
    resourceIds: ['res-1'],
    approvalPolicy: 'auto-allow',
    performance: { component: 'component', baselineVersion: '1', currentVersion: '2', environment: 'fixture', workload: 'fixture',
      metrics: [{ name: 'latency', unit: 'ms', direction: 'lower', baseline: 10, current: 11, samples: 10, thresholdPercent: 5 }] },
    ...overrides
  }
}

function makeEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'entry-1',
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    ...makeDefinition(),
    ...overrides
  }
}

function makeSubmission(entryId: string, overrides: Partial<TaskSubmission> = {}): TaskSubmission {
  return {
    id: 'sub-1',
    taskEntryId: entryId,
    taskRevision: 1,
    clientOperationId: 'op-1',
    queueMode: 'host',
    enqueueSeq: 1,
    frozenDefinition: makeDefinition(),
    frozenInputRef: 'inputs/sub-1.json',
    frozenInputHash: HASH_A,
    templateVersion: 1,
    requestId: 'req-1',
    handoffState: 'waiting',
    executionHistory: [],
    slotHeld: false,
    resourcesHeld: [],
    notes: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  }
}

function makeArtifact(overrides: Partial<TaskArtifact> = {}): TaskArtifact {
  return {
    artifactId: 'artifact-1',
    submissionId: 'sub-1',
    name: 'report.md',
    relativePath: 'results/sub-1/report.md',
    format: 'markdown',
    bytes: 128,
    sha256: HASH_B,
    collectedAt: AT + 100,
    frozenInputHash: HASH_A,
    templateVersion: 1,
    source: 'agent-file',
    ...overrides
  }
}

function makeResult(overrides: Partial<TaskResultBundle> = {}): TaskResultBundle {
  return {
    id: 'result-1',
    submissionId: 'sub-1',
    artifacts: [],
    decision: 'passed',
    checks: [{ name: '指标阈值', passed: true, detail: 'p95 在阈值内' }],
    businessOutcome: 'normal',
    frozenInputHash: HASH_A,
    verifierVersion: 1,
    verifiedAt: AT + 200,
    ...overrides
  }
}

function makeManifest(overrides: Partial<TaskWorkbenchManifest> = {}): TaskWorkbenchManifest {
  return { ...createEmptyTaskWorkbenchManifest(), ...overrides }
}

let root: string
let manifestPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lyshell-task-workbench-'))
  manifestPath = join(root, 'manifest.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeManifestFile(manifest: unknown): string {
  const data = JSON.stringify(manifest)
  writeFileSync(manifestPath, data)
  return data
}

describe('初始化与读取', () => {
  it('清单缺失时返回默认清单，且读取路径不创建目录或文件', async () => {
    const nested = join(root, 'managed')
    const repository = new TaskWorkbenchRepository(nested)

    expect(await repository.load()).toEqual(makeManifest())
    expect(await repository.read()).toEqual(makeManifest())
    expect(existsSync(nested)).toBe(false)
    expect(repository.error).toBeUndefined()
    expect(repository.rootDir).toBe(nested)
  })

  it('读取已有清单：保留原数据、不写盘，返回副本与内部状态隔离', async () => {
    const seeded = makeManifest({
      revision: 3,
      queueEnabled: true,
      nextEnqueueSeq: 2,
      entries: [makeEntry()],
      submissions: [makeSubmission('entry-1')]
    })
    const before = writeManifestFile(seeded)
    const repository = new TaskWorkbenchRepository(root)

    const loaded = await repository.load()
    expect(loaded.revision).toBe(3)
    expect(loaded.queueEnabled).toBe(true)
    expect(loaded.entries[0].title).toBe('组件性能回归')
    expect(loaded.submissions[0].frozenInputHash).toBe(HASH_A)
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    expect(repository.error).toBeUndefined()

    loaded.entries[0].title = '外部改写'
    loaded.submissions.length = 0
    const again = await repository.read()
    expect(again.entries[0].title).toBe('组件性能回归')
    expect(again.submissions).toHaveLength(1)
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
  })

  it('未调用 load 直接 transact 会先读取磁盘清单', async () => {
    writeManifestFile(makeManifest({ revision: 4, queueEnabled: true }))
    const repository = new TaskWorkbenchRepository(root)

    await repository.transact((draft) => {
      draft.maxActive = 3
    })

    expect((await repository.read()).revision).toBe(5)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).maxActive).toBe(3)
  })
})

describe('损坏或不可读清单', () => {
  const corruptCases: Array<[string, string]> = [
    ['非法 JSON', '{ "schemaVersion": 1,'],
    ['schemaVersion 不受支持', JSON.stringify({ ...makeManifest(), schemaVersion: 2 })],
    ['重复的任务条目 id', JSON.stringify(makeManifest({ entries: [makeEntry(), makeEntry()] }))],
    [
      '提交引用不存在的任务条目',
      JSON.stringify(makeManifest({ nextEnqueueSeq: 2, submissions: [makeSubmission('ghost-entry')] }))
    ],
    [
      '等待项超过上限',
      JSON.stringify(
        makeManifest({
          entries: [makeEntry()],
          nextEnqueueSeq: 102,
          submissions: Array.from({ length: 101 }, (_, index) =>
            makeSubmission('entry-1', {
              id: `sub-${index}`,
              clientOperationId: `op-${index}`,
              requestId: `req-${index}`,
              enqueueSeq: index + 1
            })
          )
        })
      )
    ]
  ]

  for (const [label, data] of corruptCases) {
    it(`${label} → 拒绝加载且不覆盖原文件`, async () => {
      writeFileSync(manifestPath, data)
      const repository = new TaskWorkbenchRepository(root)

      await expect(repository.load()).rejects.toMatchObject({ code: 'TASK_WORKBENCH_CORRUPT' })
      expect(typeof repository.error).toBe('string')
      expect(readFileSync(manifestPath, 'utf8')).toBe(data)

      // 锁定之后 load/read/transact 都明确拒绝，不退回空清单。
      await expect(repository.read()).rejects.toMatchObject({ code: 'TASK_WORKBENCH_CORRUPT' })
      await expect(repository.transact((draft) => void (draft.queueEnabled = true))).rejects.toMatchObject({
        code: 'TASK_WORKBENCH_CORRUPT'
      })
      expect(readFileSync(manifestPath, 'utf8')).toBe(data)
    })
  }

  it('清单路径是目录 → 归类为不可读，且不删除/不覆盖', async () => {
    mkdirSync(manifestPath)
    const repository = new TaskWorkbenchRepository(root)

    await expect(repository.load()).rejects.toMatchObject({ code: 'TASK_WORKBENCH_UNREADABLE' })
    expect(typeof repository.error).toBe('string')
    expect(existsSync(manifestPath)).toBe(true)
  })
})

describe('事务语义', () => {
  it('并发 transact 串行执行：单写者、revision 连续、无丢更新', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const writtenRevisions: number[] = []
    const repository = new TaskWorkbenchRepository(root, {
      writeFile: async (path, data) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        writtenRevisions.push((JSON.parse(data) as TaskWorkbenchManifest).revision)
        try {
          await atomicWriteFile(path, data)
          await delay(2)
        } finally {
          inFlight -= 1
        }
      }
    })

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        repository.transact((draft) => {
          draft.operations.push({
            id: `op-${index}`,
            fingerprint: `fp-${index}`,
            entityId: 'queue',
            at: AT + index
          })
        })
      )
    )

    expect(maxInFlight).toBe(1)
    expect(writtenRevisions).toEqual(Array.from({ length: 25 }, (_, index) => index + 1))
    const manifest = await repository.read()
    expect(manifest.revision).toBe(25)
    expect(manifest.operations).toHaveLength(25)
    expect(new Set(manifest.operations.map((receipt) => receipt.id)).size).toBe(25)
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as TaskWorkbenchManifest
    expect(onDisk.revision).toBe(25)
    expect(onDisk.operations).toHaveLength(25)
  })

  it('回调抛错时不写盘、不发布，异常原样透出', async () => {
    const repository = new TaskWorkbenchRepository(root)
    const failure = new Error('验收条件缺失')

    await expect(
      repository.transact(() => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(existsSync(manifestPath)).toBe(false)
    expect((await repository.read()).revision).toBe(0)
    expect(repository.error).toBeUndefined()
  })

  it('回调改坏草稿后抛错，上一次提交的内存与磁盘快照都不变', async () => {
    const repository = new TaskWorkbenchRepository(root)
    await repository.transact((draft) => {
      draft.queueEnabled = true
      draft.entries.push(makeEntry())
    })
    const before = await repository.read()
    const onDiskBefore = readFileSync(manifestPath, 'utf8')

    await expect(
      repository.transact((draft) => {
        draft.queueEnabled = false
        draft.entries[0].title = '被改坏'
        draft.entries.push(makeEntry({ id: 'entry-2' }))
        throw new Error('放弃本次修改')
      })
    ).rejects.toThrow('放弃本次修改')

    expect(await repository.read()).toEqual(before)
    expect(readFileSync(manifestPath, 'utf8')).toBe(onDiskBefore)
    expect(repository.error).toBeUndefined()
  })

  it('transact 返回值是克隆：外部修改不影响已发布状态', async () => {
    const repository = new TaskWorkbenchRepository(root)
    const returned = await repository.transact((draft) => {
      draft.entries.push(makeEntry())
      return draft.entries[0]
    })

    returned.title = '外部改写'
    returned.resourceIds.push('res-2')

    const manifest = await repository.read()
    expect(manifest.entries[0].title).toBe('组件性能回归')
    expect(manifest.entries[0].resourceIds).toEqual(['res-1'])
  })

  it('revision 由仓储强制递增，回调写入的值被忽略', async () => {
    const repository = new TaskWorkbenchRepository(root)
    await repository.transact((draft) => {
      draft.revision = 99
    })
    expect((await repository.read()).revision).toBe(1)

    await repository.transact((draft) => {
      draft.revision = 0
    })
    expect((await repository.read()).revision).toBe(2)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).revision).toBe(2)
  })

  it('flush 等待排队中的慢写入完成，空队列立即完成', async () => {
    const repository = new TaskWorkbenchRepository(root, {
      writeFile: async (path, data) => {
        await delay(20)
        await atomicWriteFile(path, data)
      }
    })

    const pending = [
      repository.transact((draft) => void (draft.queueEnabled = true)),
      repository.transact((draft) => void (draft.maxActive = 3)),
      repository.transact((draft) => void (draft.queueEnabled = false))
    ]
    await repository.flush()

    expect((await repository.read()).revision).toBe(3)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).revision).toBe(3)
    await Promise.all(pending)
    await expect(repository.flush()).resolves.toBeUndefined()
  })
})

describe('写入失败与回执丢失', () => {
  it('写前失败且磁盘仍是旧快照：拒绝本次，保留旧状态，换回正常写入后可重试', async () => {
    let mode: 'ok' | 'fail' = 'ok'
    const repository = new TaskWorkbenchRepository(root, {
      writeFile: async (path, data) => {
        if (mode === 'fail') throw new Error('磁盘只读')
        await atomicWriteFile(path, data)
      }
    })
    await repository.transact((draft) => void (draft.queueEnabled = true))
    const onDiskBefore = readFileSync(manifestPath, 'utf8')

    mode = 'fail'
    await expect(repository.transact((draft) => void (draft.maxActive = 5))).rejects.toMatchObject({
      code: 'TASK_WORKBENCH_WRITE_FAILED'
    })
    expect(repository.error).toBeUndefined()
    expect((await repository.read()).maxActive).toBe(2)
    expect((await repository.read()).revision).toBe(1)
    expect(readFileSync(manifestPath, 'utf8')).toBe(onDiskBefore)

    mode = 'ok'
    await repository.transact((draft) => void (draft.maxActive = 4))
    expect((await repository.read()).revision).toBe(2)
    expect((await repository.read()).maxActive).toBe(4)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).maxActive).toBe(4)
  })

  it('从未落盘时写前失败：拒绝本次且不留下清单文件', async () => {
    const repository = new TaskWorkbenchRepository(root, {
      writeFile: async () => {
        throw new Error('目录不可写')
      }
    })

    await expect(repository.transact((draft) => void (draft.queueEnabled = true))).rejects.toMatchObject({
      code: 'TASK_WORKBENCH_WRITE_FAILED'
    })
    expect(existsSync(manifestPath)).toBe(false)
    expect((await repository.read()).revision).toBe(0)
    expect(repository.error).toBeUndefined()
  })

  it('写成功但抛错（回执丢失）：核对磁盘后按成功处理', async () => {
    let calls = 0
    const repository = new TaskWorkbenchRepository(root, {
      writeFile: async (path, data) => {
        calls += 1
        await atomicWriteFile(path, data)
        throw new Error('写入回执丢失')
      }
    })

    await expect(repository.transact((draft) => void (draft.queueEnabled = true))).resolves.toBeUndefined()
    expect(calls).toBe(1)
    expect(repository.error).toBeUndefined()
    expect((await repository.read()).revision).toBe(1)
    expect((await repository.read()).queueEnabled).toBe(true)
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as TaskWorkbenchManifest
    expect(onDisk.revision).toBe(1)
    expect(onDisk.queueEnabled).toBe(true)
  })

  it('写入结果不确定且磁盘是另一份内容：锁定存储，禁止继续读写', async () => {
    let mode: 'ok' | 'diverge' = 'ok'
    let writes = 0
    const external = makeManifest({
      revision: 7,
      queueEnabled: true,
      operations: [{ id: 'op-x', fingerprint: 'fp-x', entityId: 'queue', at: 1 }]
    })
    const repository = new TaskWorkbenchRepository(root, {
      writeFile: async (path, data) => {
        writes += 1
        if (mode === 'diverge') {
          await atomicWriteFile(path, JSON.stringify(external))
          throw new Error('写入后回执丢失且内容被替换')
        }
        await atomicWriteFile(path, data)
      }
    })
    await repository.transact((draft) => void (draft.queueEnabled = true))
    expect(writes).toBe(1)

    mode = 'diverge'
    await expect(repository.transact((draft) => void (draft.maxActive = 7))).rejects.toMatchObject({
      code: 'TASK_WORKBENCH_WRITE_UNCERTAIN'
    })
    expect(writes).toBe(2)
    expect(typeof repository.error).toBe('string')
    const lockedRaw = readFileSync(manifestPath, 'utf8')
    expect((JSON.parse(lockedRaw) as TaskWorkbenchManifest).revision).toBe(7)

    mode = 'ok'
    await expect(repository.transact((draft) => void (draft.maxActive = 7))).rejects.toMatchObject({
      code: 'TASK_WORKBENCH_WRITE_UNCERTAIN'
    })
    await expect(repository.read()).rejects.toMatchObject({ code: 'TASK_WORKBENCH_WRITE_UNCERTAIN' })
    expect(writes).toBe(2)
    expect(readFileSync(manifestPath, 'utf8')).toBe(lockedRaw)
  })
})

describe('上限', () => {
  it('清单序列化超过 2 MiB 时明确拒绝且不写盘', async () => {
    const repository = new TaskWorkbenchRepository(root)
    const hugeEntries = Array.from({ length: 200 }, (_, index) =>
      makeEntry({ id: `entry-${index}`, title: `任务 ${index}`, goal: 'x'.repeat(12_000) })
    )

    await expect(
      repository.transact((draft) => {
        draft.entries.push(...hugeEntries)
      })
    ).rejects.toMatchObject({ code: 'TASK_WORKBENCH_LIMIT' })

    expect(existsSync(manifestPath)).toBe(false)
    expect((await repository.read()).entries).toHaveLength(0)
    expect(JSON.stringify(makeManifest({ entries: hugeEntries })).length).toBeGreaterThan(
      TASK_WORKBENCH_MAX_MANIFEST_BYTES
    )
  })

  it('等待项 100 条可写入，第 101 条被拒绝且不淘汰已有等待项', async () => {
    const repository = new TaskWorkbenchRepository(root)
    await repository.transact((draft) => {
      draft.entries.push(makeEntry())
      draft.nextEnqueueSeq = 101
      for (let index = 0; index < 100; index += 1) {
        draft.submissions.push(
          makeSubmission('entry-1', {
            id: `sub-${index}`,
            clientOperationId: `op-${index}`,
            requestId: `req-${index}`,
            enqueueSeq: index + 1
          })
        )
      }
    })
    const onDiskBefore = readFileSync(manifestPath, 'utf8')
    expect((await repository.read()).submissions).toHaveLength(100)

    await expect(
      repository.transact((draft) => {
        draft.nextEnqueueSeq = 102
        draft.submissions.push(
          makeSubmission('entry-1', {
            id: 'sub-101',
            clientOperationId: 'op-101',
            requestId: 'req-101',
            enqueueSeq: 101
          })
        )
      })
    ).rejects.toMatchObject({ code: 'TASK_WORKBENCH_LIMIT' })

    expect(readFileSync(manifestPath, 'utf8')).toBe(onDiskBefore)
    expect((await repository.read()).submissions).toHaveLength(100)
  })

  it('操作回执上限 10000 条，超限新增与淘汰旧回执都被拒绝', async () => {
    const repository = new TaskWorkbenchRepository(root)
    await repository.transact((draft) => {
      for (let index = 0; index < 10_000; index += 1) {
        draft.operations.push({ id: `op-${index}`, fingerprint: `fp-${index}`, entityId: 'queue', at: index })
      }
    })
    expect((await repository.read()).operations).toHaveLength(10_000)
    const onDiskBefore = readFileSync(manifestPath, 'utf8')

    await expect(
      repository.transact((draft) => {
        draft.operations.push({ id: 'op-overflow', fingerprint: 'fp', entityId: 'queue', at: 1 })
      })
    ).rejects.toMatchObject({ code: 'TASK_WORKBENCH_LIMIT' })

    await expect(
      repository.transact((draft) => {
        draft.operations.shift()
      })
    ).rejects.toMatchObject({ code: 'TASK_WORKBENCH_INVALID' })

    expect(readFileSync(manifestPath, 'utf8')).toBe(onDiskBefore)
    expect((await repository.read()).operations).toHaveLength(10_000)
  })
})

describe('拒绝非法状态与改写已保存记录', () => {
  async function seed(): Promise<TaskWorkbenchRepository> {
    const repository = new TaskWorkbenchRepository(root)
    await repository.transact((draft) => {
      draft.entries.push(makeEntry())
      draft.nextEnqueueSeq = 2
      draft.submissions.push(makeSubmission('entry-1'))
      draft.operations.push({ id: 'op-receipt', fingerprint: 'fp-receipt', entityId: 'queue', at: 1 })
    })
    return repository
  }

  it('合法验收记录与多份产物可以写入并读回', async () => {
    const repository = await seed()
    await repository.transact((draft) => {
      draft.results.push(
        makeResult({
          artifacts: [
            makeArtifact(),
            makeArtifact({
              artifactId: 'artifact-2',
              relativePath: 'results/sub-1/raw.json',
              format: 'json',
              source: 'host-check'
            })
          ]
        })
      )
    })

    const manifest = await repository.read()
    expect(manifest.results).toHaveLength(1)
    expect(manifest.results[0].artifacts).toHaveLength(2)
    expect(manifest.results[0].decision).toBe('passed')
  })

  /** 超限类拒绝用 LIMIT，其余结构/关联问题用 INVALID。 */
  const limitCases = new Set(['单个产物超过字节上限'])
  const cases: Array<[string, (draft: TaskWorkbenchManifest) => void]> = [
    [
      '提交引用不存在的任务条目',
      (draft) => {
        draft.submissions[0].taskEntryId = 'ghost-entry'
      }
    ],
    [
      '提交修订晚于任务条目修订',
      (draft) => {
        draft.submissions[0].taskRevision = 2
      }
    ],
    [
      '重复的业务操作 id',
      (draft) => {
        draft.nextEnqueueSeq = 3
        draft.submissions.push(
          makeSubmission('entry-1', { id: 'sub-2', enqueueSeq: 2, clientOperationId: 'op-1', requestId: 'req-2' })
        )
      }
    ],
    [
      '未知交接状态',
      (draft) => {
        draft.submissions[0].handoffState = 'running' as never
      }
    ],
    [
      'bound 状态缺少原生执行引用',
      (draft) => {
        draft.submissions[0].handoffState = 'bound'
        draft.submissions[0].slotHeld = true
      }
    ],
    [
      'waiting 状态占用活动槽位',
      (draft) => {
        draft.submissions[0].slotHeld = true
      }
    ],
    [
      'withdrawn 状态仍占用资源',
      (draft) => {
        draft.submissions[0].handoffState = 'withdrawn'
        draft.submissions[0].resourcesHeld = ['res-1']
      }
    ],
    [
      '冻结输入摘要不是 sha256',
      (draft) => {
        draft.submissions[0].frozenInputHash = 'not-a-hash'
      }
    ],
    [
      '验收记录引用不存在的提交',
      (draft) => {
        draft.results.push(makeResult({ submissionId: 'ghost-sub' }))
      }
    ],
    [
      '验收记录摘要与提交不一致',
      (draft) => {
        draft.results.push(makeResult({ frozenInputHash: HASH_B }))
      }
    ],
    [
      '产物使用绝对路径',
      (draft) => {
        draft.results.push(makeResult({ artifacts: [makeArtifact({ relativePath: 'C:/tmp/report.md' })] }))
      }
    ],
    [
      '产物跳出受管目录',
      (draft) => {
        draft.results.push(makeResult({ artifacts: [makeArtifact({ relativePath: 'results/../../escape.md' })] }))
      }
    ],
    [
      '产物摘要与成果不一致',
      (draft) => {
        draft.results.push(makeResult({ artifacts: [makeArtifact({ frozenInputHash: HASH_B })] }))
      }
    ],
    [
      '单个产物超过字节上限',
      (draft) => {
        draft.results.push(
          makeResult({ artifacts: [makeArtifact({ bytes: TASK_WORKBENCH_ARTIFACT_BYTES_LIMIT + 1 })] })
        )
      }
    ],
    [
      '重复的产物 id',
      (draft) => {
        draft.results.push(makeResult({ artifacts: [makeArtifact(), makeArtifact()] }))
      }
    ],
    [
      'maxActive 小于 1',
      (draft) => {
        draft.maxActive = 0
      }
    ],
    [
      'nextEnqueueSeq 不大于已用排队号',
      (draft) => {
        draft.nextEnqueueSeq = 1
      }
    ],
    [
      '任务条目 updatedAt 早于 createdAt',
      (draft) => {
        draft.entries[0].updatedAt = 0
      }
    ],
    [
      '未知模板 id',
      (draft) => {
        draft.entries[0].templateId = 'unknown' as never
      }
    ],
    [
      '淘汰已保存的操作回执',
      (draft) => {
        draft.operations.length = 0
      }
    ],
    [
      '改写已保存提交的业务操作 id',
      (draft) => {
        draft.submissions[0].clientOperationId = 'op-other'
      }
    ],
    [
      '改写已提交的冻结定义',
      (draft) => {
        draft.submissions[0].frozenDefinition.title = '被改写'
      }
    ],
    [
      '删除已保存的提交',
      (draft) => {
        draft.submissions.length = 0
      }
    ]
  ]

  for (const [label, mutate] of cases) {
    it(`${label} → 拒绝本次写入且文件不变`, async () => {
      const repository = await seed()
      const onDiskBefore = readFileSync(manifestPath, 'utf8')

      await expect(repository.transact(mutate)).rejects.toMatchObject({
        code: limitCases.has(label) ? 'TASK_WORKBENCH_LIMIT' : 'TASK_WORKBENCH_INVALID'
      })

      expect(readFileSync(manifestPath, 'utf8')).toBe(onDiskBefore)
      expect(repository.error).toBeUndefined()
      const manifest = await repository.read()
      expect(manifest.revision).toBe(1)
      expect(manifest.submissions[0].handoffState).toBe('waiting')
    })
  }

  it('已绑定且原生执行到终态时可以释放槽位', async () => {
    // 与 service 的绑定收尾一致：handoffState 保持 bound，原生任务终态后归还槽位。
    const repository = await seed()
    const identity = { instanceId: 'instance-1', instanceEpoch: 1 }

    await repository.transact((draft) => {
      const submission = draft.submissions[0]
      submission.handoffState = 'bound'
      submission.nativeExecutionRef = { sessionId: 'session-1', taskId: 'task-1', executionIdentity: identity }
      submission.observation = { state: 'completed', stale: false, observedAt: AT + 300, identity }
      submission.slotHeld = false
    })

    const manifest = await repository.read()
    expect(manifest.submissions[0].handoffState).toBe('bound')
    expect(manifest.submissions[0].slotHeld).toBe(false)
    expect(manifest.revision).toBe(2)
  })
})
