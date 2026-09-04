import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'

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

afterEach(() => {
  rmSync(sessionsPath, { recursive: true, force: true })
})

describe('SessionRepository.saveSession（Local 同一性判定含 shellArgs）', () => {
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
