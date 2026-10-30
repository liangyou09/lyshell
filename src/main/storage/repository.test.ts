import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, existsSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'fs'

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

// electron-log / electron.app.getPath 在 Node 测试环境不存在，mock 掉（对齐 agent-repository.test.ts）。
// safeStorage 仅为 ssh 凭据加密引入，本地会话不触发，提供空对象即可。
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {}
}))

import { SessionRepository, PreferencesRepository, QuickCommandsRepository } from './repository'
import { RevisionConflictError } from './atomic-json'
import type { SessionConfig } from '@shared/types'
import { ConnectionType } from '@shared/types'
import { PluginResourceRegistry, releasePluginSessions } from '../plugin/resource-registry'

const configDir = join(tmpdir(), 'config')
const sessionsPath = join(configDir, 'sessions.json')
const preferencesPath = join(configDir, 'preferences.json')
const quickCommandsPath = join(configDir, 'quickCommands.json')

const removeStorageFiles = (file: string): void => {
  const name = file.split(/[\\/]/).pop()!
  if (!existsSync(configDir)) return
  for (const entry of readdirSync(configDir)) {
    if (entry === name || entry.startsWith(`${name}.`)) rmSync(join(configDir, entry), { force: true })
  }
}

/** 最小可落盘的本地会话 fixture（terminal 是 SessionConfig 必填的完整形状） */
const makeLocalSession = (local: { shell?: string; shellArgs?: string[] }): SessionConfig => ({
  id: '',
  name: '本地会话',
  type: ConnectionType.LOCAL,
  local,
  terminal: {
    fontSize: 14,
    fontFamily: 'Consolas, Monaco, monospace',
    theme: {
      foreground: '#D4D4D4',
      background: '#1E1E1E',
      cursor: '#D4D4D4',
      selectionBackground: '#264F78',
      black: '#000000',
      red: '#CD3131',
      green: '#0DBC79',
      yellow: '#E5E510',
      blue: '#2472C8',
      magenta: '#BC3FBC',
      cyan: '#11A8CD',
      white: '#E5E5E5',
      brightBlack: '#666666',
      brightRed: '#F14C4C',
      brightGreen: '#23D18B',
      brightYellow: '#F5F543',
      brightBlue: '#3B8EEA',
      brightMagenta: '#D670D6',
      brightCyan: '#29B8DB',
      brightWhite: '#E5E5E5'
    },
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 10000,
    encoding: 'utf-8'
  },
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
})

beforeEach(() => {
  mkdirSync(configDir, { recursive: true })
  removeStorageFiles(sessionsPath)
  removeStorageFiles(preferencesPath)
  removeStorageFiles(quickCommandsPath)
})

afterEach(async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  vi.mocked(writeFileSync).mockImplementation(actual.writeFileSync).mockClear()
  removeStorageFiles(sessionsPath)
  removeStorageFiles(preferencesPath)
  removeStorageFiles(quickCommandsPath)
})

describe('SessionRepository 删除失败重试', () => {
  it('写盘失败恢复内存内容和顺序，重试成功后重新加载也不存在已删除项', () => {
    const repo = new SessionRepository()
    const first = repo.saveSession({ ...makeLocalSession({}), id: 'first', name: 'first' })
    const second = repo.saveSession({ ...makeLocalSession({}), id: 'second', name: 'second' })
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(() => repo.delete(first.id)).toThrow('EACCES')
    expect(repo.get(first.id)).toStrictEqual(first)
    expect(repo.getAll().map(s => s.id)).toEqual([first.id, second.id])
    expect(new SessionRepository().get(first.id)).not.toBeNull()
    expect(repo.delete(first.id)).toBe(true)
    expect(new SessionRepository().getAll().map(s => s.id)).toEqual([second.id])
  })

  it('插件回收连续写盘失败时保留保存项和归属，恢复后重试真正落盘并保留用户项', async () => {
    const repo = new SessionRepository()
    const saved = repo.saveSession({ ...makeLocalSession({}), id: 'plugin-saved', ownerPluginId: 'plugin' })
    const user = repo.saveSession({ ...makeLocalSession({}), id: 'user-saved' })
    const registry = new PluginResourceRegistry()
    registry.track('plugin', saved.id, 0, true)
    const hooks = {
      notifyReleased() {}, listSessions: () => [], deleteSaved: (id: string) => { repo.delete(id) },
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive: async () => {}
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES') })
      await expect(releasePluginSessions(registry, 'plugin', hooks)).rejects.toThrow('EACCES')
      expect(repo.get(saved.id)).toStrictEqual(saved)
      expect(registry.owner(saved.id)).toBe('plugin')
      expect(new SessionRepository().get(saved.id)).not.toBeNull()
    }
    await releasePluginSessions(registry, 'plugin', hooks)
    expect(registry.owner(saved.id)).toBeUndefined()
    expect(repo.get(saved.id)).toBeNull()
    expect(new SessionRepository().getAll().map(s => s.id)).toEqual([user.id])
  })
})

describe('SessionRepository.saveSession（Local 同一性判定含 shellArgs）', () => {
  it('插件配置编辑、落盘重读后仍保留原归属，不能转移归属', () => {
    const repo = new SessionRepository()
    const saved = repo.saveSession({ ...makeLocalSession({}), ownerPluginId: 'aipet' })
    const edited = { ...saved }
    delete edited.ownerPluginId
    repo.updateSession({ ...edited, name: 'edited' })
    expect(new SessionRepository().get(saved.id)?.ownerPluginId).toBe('aipet')
    repo.updateSession({ ...edited, ownerPluginId: 'other' })
    expect(repo.get(saved.id)?.ownerPluginId).toBe('aipet')
  })

  it('用户配置不接受更新入参伪造插件归属，新建去重隔离插件归属', () => {
    const repo = new SessionRepository()
    const saved = repo.saveSession(makeLocalSession({}))
    repo.updateSession({ ...saved, ownerPluginId: 'aipet' })
    expect(repo.get(saved.id)?.ownerPluginId).toBeUndefined()
    const pluginSaved = repo.saveSession({ ...makeLocalSession({ shell: 'other' }), ownerPluginId: 'aipet' })
    const deduped = repo.saveSession(makeLocalSession({ shell: 'other' }))
    expect(deduped.id).not.toBe(pluginSaved.id)
    expect(deduped.ownerPluginId).toBeUndefined()
  })

  it('启动和手动去重保留同配置的用户项及不同插件项，禁用不影响用户项', () => {
    const repo = new SessionRepository()
    const user = repo.saveSession({ ...makeLocalSession({}), id: 'user' })
    const a = repo.saveSession({ ...makeLocalSession({}), id: 'a', ownerPluginId: 'aipet' })
    const b = repo.saveSession({ ...makeLocalSession({}), id: 'b', ownerPluginId: 'other' })
    repo.saveSession({ ...a, id: 'a-duplicate' })
    const reload = new SessionRepository()
    expect(reload.getAll()).toHaveLength(3)
    expect(reload.get(user.id)).not.toBeNull()
    expect(reload.get(b.id)).not.toBeNull()
    expect(reload.deduplicate().removed).toBe(0)
    for (const saved of reload.getAll()) {
      if (saved.ownerPluginId === 'aipet') reload.delete(saved.id)
    }
    expect(new SessionRepository().getAll().map(s => s.id).sort()).toEqual(['b', 'user'])
  })

  it('配置回收后迟到的 update 失败，不会在盘上重建配置', () => {
    const repo = new SessionRepository()
    const saved = repo.saveSession({ ...makeLocalSession({}), ownerPluginId: 'aipet' })
    repo.delete(saved.id)
    expect(() => repo.updateSession({ ...saved, name: 'late' })).toThrow('Session not found')
    expect(new SessionRepository().get(saved.id)).toBeNull()
  })

  it('同 shell 不同 shellArgs 是不同会话，不去重', () => {
    const repo = new SessionRepository()
    const a = repo.saveSession(makeLocalSession({ shell: 'pwsh', shellArgs: ['-NoProfile'] }))
    const b = repo.saveSession(makeLocalSession({ shell: 'pwsh' }))
    expect(b.id).not.toBe(a.id)
  })

  it('shell 与 shellArgs 全一致时去重为同一会话', () => {
    const repo = new SessionRepository()
    const a = repo.saveSession(makeLocalSession({ shell: 'pwsh', shellArgs: ['-NoProfile'] }))
    const b = repo.saveSession(makeLocalSession({ shell: 'pwsh', shellArgs: ['-NoProfile'] }))
    expect(b.id).toBe(a.id)
  })

  it('shellArgs 缺省与空数组视为等价（去重为同一会话）', () => {
    const repo = new SessionRepository()
    const a = repo.saveSession(makeLocalSession({ shell: 'pwsh' }))
    const b = repo.saveSession(makeLocalSession({ shell: 'pwsh', shellArgs: [] }))
    expect(b.id).toBe(a.id)
  })
})

describe('SessionRepository.deduplicate（generateSessionKey 含 shellArgs）', () => {
  it('同 shell 不同 shellArgs 不被去重误删', () => {
    const repo = new SessionRepository()
    const a = repo.saveSession(makeLocalSession({ shell: 'pwsh', shellArgs: ['-NoProfile'] }))
    const b = repo.saveSession(makeLocalSession({ shell: 'pwsh', shellArgs: ['-Interactive'] }))
    const result = repo.deduplicate(false)
    expect(result.removed).toBe(0)
    expect(repo.get(a.id)).not.toBeNull()
    expect(repo.get(b.id)).not.toBeNull()
  })
})

describe('SessionRepository 落盘引用隔离（cloneSession 逐层拷贝）', () => {
  it('全部保存入口剥离运行期宿主与 SSH 恢复引用，旧配置读入时也不附着历史宿主', () => {
    const repo = new SessionRepository()
    const config: SessionConfig = {
      ...makeLocalSession({}),
      local: { shell: 'pwsh', terminalHostId: 'cb307d5f-eb03-4273-a658-c15da4b55937' },
      ssh: { host: 'example', port: 22, username: 'test', resumeDirectory: '/srv/work', resumeSessionName: 'lyshell-old' }
    }
    repo.saveSession(config)
    const stored = JSON.parse(readFileSync(sessionsPath, 'utf8')) as SessionConfig[]
    expect(stored[0].local).not.toHaveProperty('terminalHostId')
    expect(stored[0].ssh).not.toHaveProperty('resumeDirectory')
    expect(stored[0].ssh).not.toHaveProperty('resumeSessionName')
    expect(config.local?.terminalHostId).toBeDefined()
    expect(config.ssh?.resumeDirectory).toBe('/srv/work')
    writeFileSync(sessionsPath, JSON.stringify([config]))
    const reloaded = new SessionRepository().get(config.id)!
    expect(reloaded.local?.terminalHostId).toBeUndefined()
    expect(reloaded.ssh?.resumeDirectory).toBeUndefined()
    expect(reloaded.ssh?.resumeSessionName).toBeUndefined()
  })
  it('保存后原地修改调用方数组不影响落盘内容', () => {
    const repo = new SessionRepository()
    const args = ['-NoProfile']
    const saved = repo.saveSession(makeLocalSession({ shell: 'pwsh', shellArgs: args }))
    // saveSession 内存里存的是调用方对象引用，但 save() 的盘序列化走 cloneSession
    // 拷贝 + 同步写盘 —— 事后原地改数组不应影响盘上内容。钉住这条边界契约：
    // 若日后改成延迟序列化或持有加密克隆对象，此测试即红
    args.push('-NoLogo')
    const repo2 = new SessionRepository()
    const reloaded = repo2.get(saved.id)
    expect(reloaded?.local?.shellArgs).toEqual(['-NoProfile'])
  })
})

describe('SessionRepository 损坏保护与版本冲突', () => {
  it('去重提交失败时，合并的 pinned 标签和顺序不能污染旧内存快照', () => {
    const repo = new SessionRepository()
    repo.saveSession({ ...makeLocalSession({}), id: 'older', tags: ['pinned'], pinOrder: 3 })
    repo.saveSession({ ...makeLocalSession({}), id: 'newer' })
    const before = repo.getAll()
    const diskBefore = readFileSync(sessionsPath, 'utf8')
    const revision = repo.getRevision()
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => repo.deduplicate()).toThrow('disk full')
    expect(repo.getAll()).toEqual(before)
    expect(repo.getRevision()).toBe(revision)
    expect(readFileSync(sessionsPath, 'utf8')).toBe(diskBefore)
  })

  it('损坏的 sessions.json 保留原件、禁用写入，默认空状态不覆盖', () => {
    const broken = '{ not a session array'
    writeFileSync(sessionsPath, broken)
    const repo = new SessionRepository()
    expect(repo.getLoadError()?.reason).toBe('corrupt')
    expect(repo.getAll()).toEqual([])
    expect(() => repo.saveSession(makeLocalSession({}))).toThrow()
    expect(readFileSync(sessionsPath, 'utf8')).toBe(broken)
    expect(readdirSync(configDir).some(name => name.startsWith('sessions.json.corrupt-'))).toBe(true)
  })

  it('expectedRevision 过期时明确冲突且不落盘', () => {
    const repo = new SessionRepository()
    const first = repo.saveSession({ ...makeLocalSession({}), id: 'first' })
    const revision = repo.getRevision()
    expect(() => repo.saveSession({ ...makeLocalSession({ shell: 'other' }), id: 'second' }, { expectedRevision: revision - 1 })).toThrow(RevisionConflictError)
    expect(repo.get('second')).toBeNull()
    expect(new SessionRepository().get('second')).toBeNull()
    expect(() => repo.updateSession({ ...first, name: 'late' }, { expectedRevision: revision - 1 })).toThrow(RevisionConflictError)
    expect(new SessionRepository().get(first.id)?.name).toBe(first.name)
  })

  it('save 失败时内存回滚，下一次成功保存不夹带失败内容', () => {
    const repo = new SessionRepository()
    repo.saveSession({ ...makeLocalSession({}), id: 'kept' })
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => repo.saveSession({ ...makeLocalSession({ shell: 'lost' }), id: 'lost' })).toThrow('disk full')
    expect(repo.get('lost')).toBeNull()
    expect(repo.getAll().map(s => s.id)).toEqual(['kept'])
    expect(new SessionRepository().get('lost')).toBeNull()
    repo.saveSession({ ...makeLocalSession({ shell: 'later' }), id: 'later' })
    const reloaded = new SessionRepository()
    expect(reloaded.get('later')).not.toBeNull()
    expect(reloaded.get('lost')).toBeNull()
  })
})

describe('PreferencesRepository 损坏保护与提交语义', () => {
  it('损坏文件保留原件并拒绝写入，内存保持默认空对象', () => {
    const broken = '{"window": 1'
    writeFileSync(preferencesPath, broken)
    const repo = new PreferencesRepository()
    expect(repo.getLoadError()?.reason).toBe('corrupt')
    expect(repo.getAll()).toEqual({})
    expect(() => repo.set('window', { width: 1000 })).toThrow()
    expect(readFileSync(preferencesPath, 'utf8')).toBe(broken)
  })

  it('set 写盘失败抛错且内存不变，成功后才替换并递增 revision', () => {
    const repo = new PreferencesRepository()
    const value = { width: 1200 }
    repo.set('window', value)
    const revision = repo.getRevision()
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    expect(() => repo.set('theme', 'dark')).toThrow('EACCES')
    expect(repo.get('theme')).toBeUndefined()
    expect(repo.get('window')).toEqual(value)
    expect(repo.getRevision()).toBe(revision)
    repo.set('theme', 'light')
    expect(repo.getRevision()).toBe(revision + 1)
    expect(new PreferencesRepository().get('theme')).toBe('light')
  })

  it('返回值与入参均为副本，外部修改不污染内存或后续提交', () => {
    const repo = new PreferencesRepository()
    const value = { nested: { enabled: true } }
    repo.set('feature', value)
    value.nested.enabled = false
    expect(repo.get('feature')).toEqual({ nested: { enabled: true } })
    const read = repo.get('feature')
    read.nested.enabled = false
    expect(repo.get('feature')).toEqual({ nested: { enabled: true } })
  })

  it('expectedRevision 冲突时不修改内存和磁盘', () => {
    const repo = new PreferencesRepository()
    repo.set('a', 1)
    const revision = repo.getRevision()
    expect(() => repo.set('b', 2, { expectedRevision: revision - 1 })).toThrow(RevisionConflictError)
    expect(repo.getAll()).toEqual({ a: 1 })
    expect(new PreferencesRepository().getAll()).toEqual({ a: 1 })
  })
})

describe('QuickCommandsRepository 损坏保护与提交语义', () => {
  it('损坏文件保留原件、禁用写入，legacy 数组仍可读取', () => {
    writeFileSync(quickCommandsPath, '[{"id":"one","name":"one","content":"ls"}]')
    const legacy = new QuickCommandsRepository()
    expect(legacy.getLoadError()).toBeNull()
    expect(legacy.getAll().map(command => command.id)).toEqual(['one'])

    const broken = '{"commands":[]'
    writeFileSync(quickCommandsPath, broken)
    const repo = new QuickCommandsRepository()
    expect(repo.getLoadError()?.reason).toBe('corrupt')
    expect(() => repo.add({ id: 'two', name: 'two', content: 'pwd' })).toThrow()
    expect(readFileSync(quickCommandsPath, 'utf8')).toBe(broken)
  })

  it('add 写盘失败抛错且内存/磁盘保持旧内容', () => {
    const repo = new QuickCommandsRepository()
    repo.add({ id: 'one', name: 'one', content: 'ls' })
    const before = readFileSync(quickCommandsPath, 'utf8')
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC')
    })
    expect(() => repo.add({ id: 'two', name: 'two', content: 'pwd' })).toThrow('ENOSPC')
    expect(repo.getAll().map(c => c.id)).toEqual(['one'])
    expect(readFileSync(quickCommandsPath, 'utf8')).toBe(before)
  })

  it('expectedRevision 冲突时拒绝删除分组', () => {
    const repo = new QuickCommandsRepository()
    repo.addGroup({ id: 'g1', name: 'g1', order: 0 })
    const revision = repo.getRevision()
    expect(() => repo.deleteGroup('g1', { expectedRevision: revision - 1 })).toThrow(RevisionConflictError)
    expect(repo.getAllGroups().map(g => g.id)).toEqual(['g1'])
    expect(new QuickCommandsRepository().getAllGroups().map(g => g.id)).toEqual(['g1'])
  })
})
