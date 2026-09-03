import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

// electron-log / electron.app.getPath 在 Node 测试环境不存在，mock 掉（对齐 harness-workspace-repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import { AgentRepository, resolveAgentLaunchEnv, type AgentConfig } from './agent-repository'

const configDir = join(tmpdir(), 'config')
const agentsPath = join(configDir, 'agents.json')

function seed(content: string): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(agentsPath, content, 'utf-8')
}

beforeEach(() => {
  mkdirSync(configDir, { recursive: true })
  rmSync(agentsPath, { force: true })
})

afterEach(() => {
  rmSync(agentsPath, { force: true })
})

describe('AgentRepository.load（env 清洗）', () => {
  it('损坏 JSON / 非数组 JSON 时回落默认 Agent（恢复而非崩溃）', () => {
    seed('{ not valid json')
    expect(new AgentRepository().getAll().length).toBeGreaterThan(0)
    seed('{"a": 1}')
    const agents = new AgentRepository().getAll()
    // 非数组按损坏处理，回落 DEFAULT_AGENTS（与 harness 仓库的 rawList 处理一致）
    expect(agents.map((a) => a.name)).toContain('Claude Code')
  })

  it('env 脏数据清洗：丢空 key / 含 NUL 的 key / 含 NUL 的 value / 非字符串值', () => {
    const NUL = String.fromCharCode(0)
    seed(JSON.stringify([
      {
        id: 'a1', name: 'a', command: 'foo', order: 0,
        env: { '': 'x', ['A' + NUL + 'B']: 'y', K1: 'v1', K2: 'va' + NUL + 'lue', K3: 42 }
      }
    ]))
    expect(new AgentRepository().get('a1')?.env).toEqual({ K1: 'v1' })
  })

  it('清洗后 env 为空则置 undefined（空记录按缺失处理）', () => {
    const NUL = String.fromCharCode(0)
    seed(JSON.stringify([
      { id: 'a1', name: 'a', command: 'foo', order: 0, env: { '': 'x', K: NUL } },
      { id: 'a2', name: 'b', command: 'bar', order: 1 }
    ]))
    const repo = new AgentRepository()
    expect(repo.get('a1')?.env).toBeUndefined()
    expect(repo.get('a2')?.env).toBeUndefined()
  })

  it('合法 env 原样保留（不因清洗误伤）', () => {
    seed(JSON.stringify([
      { id: 'a1', name: 'a', command: 'foo', order: 0, env: { FOO: 'bar', EMPTY_VAL: '' } }
    ]))
    expect(new AgentRepository().get('a1')?.env).toEqual({ FOO: 'bar', EMPTY_VAL: '' })
  })
})

describe('resolveAgentLaunchEnv（通用 Agent 启动 env 解析链）', () => {
  // 组的形状即仓库真实记录:结构化核心(baseUrl/apiKey) + 附加变量 env
  const profiles: Array<{ id: string; baseUrl?: string; apiKey?: string; env: Record<string, string> }> = [
    { id: 'p1', baseUrl: 'https://1.1.1.3:8443/v1', apiKey: 'sk-from-profile', env: { CODEX_HOME: 'C:/x' } },
    { id: 'p2', env: { K: 'p2' } }
  ]
  const store = {
    get: (id: string) => profiles.find((p) => p.id === id)
  }

  it('绑定变量组命中 → 附加变量透传 + 核心按 agent 的 envKeyMap 注入（不合并内联）', () => {
    const agent: Pick<AgentConfig, 'envProfileId' | 'envKeyMap' | 'env'> = {
      envProfileId: 'p1',
      envKeyMap: { baseUrl: 'MY_BASE_URL', apiKey: 'MY_API_KEY' },
      env: { INLINE: 'inline' }
    }
    expect(resolveAgentLaunchEnv(agent, store)).toEqual({
      CODEX_HOME: 'C:/x',
      MY_BASE_URL: 'https://1.1.1.3:8443/v1',
      MY_API_KEY: 'sk-from-profile'
    })
  })

  it('envKeyMap 只声明一个维度 → 只注入那个维度，其余核心字段不注入', () => {
    const agent: Pick<AgentConfig, 'envProfileId' | 'envKeyMap' | 'env'> = {
      envProfileId: 'p1',
      envKeyMap: { apiKey: 'MY_API_KEY' }
    }
    expect(resolveAgentLaunchEnv(agent, store)).toEqual({
      CODEX_HOME: 'C:/x',
      MY_API_KEY: 'sk-from-profile'
    })
  })

  it('未声明 envKeyMap → 只透传附加变量（核心两字段不注入）', () => {
    const agent: Pick<AgentConfig, 'envProfileId' | 'envKeyMap' | 'env'> = {
      envProfileId: 'p1',
      env: { INLINE: 'inline' }
    }
    expect(resolveAgentLaunchEnv(agent, store)).toEqual({ CODEX_HOME: 'C:/x' })
  })

  it('绑定悬空（组已删）→ 回落内联 env，而不是变成「无 env」', () => {
    const agent: Pick<AgentConfig, 'envProfileId' | 'envKeyMap' | 'env'> = {
      envProfileId: 'deleted-id',
      envKeyMap: { apiKey: 'MY_API_KEY' },
      env: { INLINE: 'inline' }
    }
    expect(resolveAgentLaunchEnv(agent, store)).toEqual({ INLINE: 'inline' })
  })

  it('未绑定 → 内联 env', () => {
    expect(resolveAgentLaunchEnv({ envProfileId: undefined, env: { INLINE: '1' } }, store)).toEqual({ INLINE: '1' })
    expect(resolveAgentLaunchEnv({ env: { INLINE: '1' } }, store)).toEqual({ INLINE: '1' })
  })

  it('无绑定且无内联 → undefined（即系统环境变量）', () => {
    expect(resolveAgentLaunchEnv({}, store)).toBeUndefined()
    expect(resolveAgentLaunchEnv({ envProfileId: undefined, env: undefined }, store)).toBeUndefined()
  })
})
