import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

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

import { SessionRepository } from './repository'
import type { SessionConfig } from '@shared/types'
import { ConnectionType } from '@shared/types'
import { PluginResourceRegistry, releasePluginSessions } from '../plugin/resource-registry'

const configDir = join(tmpdir(), 'config')
const sessionsPath = join(configDir, 'sessions.json')

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
  rmSync(sessionsPath, { recursive: true, force: true })
})

afterEach(async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  vi.mocked(writeFileSync).mockImplementation(actual.writeFileSync).mockClear()
  rmSync(sessionsPath, { recursive: true, force: true })
})

describe('SessionRepository 删除失败重试', () => {
  it('写盘失败恢复内存内容和顺序，重试成功后重新加载也不存在已删除项', () => {
    const repo = new SessionRepository()
    const first = repo.saveSession({ ...makeLocalSession({}), id: 'first', name: 'first' })
    const second = repo.saveSession({ ...makeLocalSession({}), id: 'second', name: 'second' })
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(() => repo.delete(first.id)).toThrow('EACCES')
    expect(repo.get(first.id)).toBe(first)
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
      expect(repo.get(saved.id)).toBe(saved)
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
