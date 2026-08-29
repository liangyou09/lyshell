import { describe, it, expect, afterEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

// electron-log / electron.app.getPath 在 Node 测试环境不存在，mock 掉
// （config.ts 经仓库实例间接引入，对齐 harness-env-profile-repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => homedir() }
}))

import { HARNESS_AGENTS } from './config'

const origCodexHome = process.env.CODEX_HOME
const origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(() => {
  if (origCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = origCodexHome
  if (origClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir
})

describe('HarnessAgentRuntime.envDefaults', () => {
  it('codex：系统 CODEX_HOME 有值时预填该值（与启动透传语义一致）', () => {
    process.env.CODEX_HOME = 'D:\\custom-codex-home'
    const rows = HARNESS_AGENTS.codex.envDefaults()
    expect(rows.find((r) => r.key === 'CODEX_HOME')?.value).toBe('D:\\custom-codex-home')
    expect(rows.find((r) => r.key === 'OPENAI_API_KEY')?.value).toBe('')
    expect(rows.find((r) => r.key === 'OPENAI_BASE_URL')?.value).toBe('')
  })

  it('codex：未设系统 CODEX_HOME 时回落默认路径 ~/.codex', () => {
    delete process.env.CODEX_HOME
    const rows = HARNESS_AGENTS.codex.envDefaults()
    expect(rows.find((r) => r.key === 'CODEX_HOME')?.value).toBe(join(homedir(), '.codex'))
  })

  it('codex：系统 CODEX_HOME 为空白串时同样回落默认路径', () => {
    process.env.CODEX_HOME = '   '
    const rows = HARNESS_AGENTS.codex.envDefaults()
    expect(rows.find((r) => r.key === 'CODEX_HOME')?.value).toBe(join(homedir(), '.codex'))
  })

  it('claude：系统 CLAUDE_CONFIG_DIR 有值时预填该值', () => {
    process.env.CLAUDE_CONFIG_DIR = 'D:\\custom-claude-config'
    const rows = HARNESS_AGENTS.claude.envDefaults()
    expect(rows.find((r) => r.key === 'CLAUDE_CONFIG_DIR')?.value).toBe('D:\\custom-claude-config')
    expect(rows.find((r) => r.key === 'ANTHROPIC_AUTH_TOKEN')?.value).toBe('')
    expect(rows.find((r) => r.key === 'ANTHROPIC_BASE_URL')?.value).toBe('')
  })

  it('claude：未设系统 CLAUDE_CONFIG_DIR 时回落默认路径 ~/.claude', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const rows = HARNESS_AGENTS.claude.envDefaults()
    expect(rows.find((r) => r.key === 'CLAUDE_CONFIG_DIR')?.value).toBe(join(homedir(), '.claude'))
  })

  it('claude：系统 CLAUDE_CONFIG_DIR 为空白串时同样回落默认路径', () => {
    process.env.CLAUDE_CONFIG_DIR = '   '
    const rows = HARNESS_AGENTS.claude.envDefaults()
    expect(rows.find((r) => r.key === 'CLAUDE_CONFIG_DIR')?.value).toBe(join(homedir(), '.claude'))
  })

  it('dsh：静态默认原样返回（无动态解析项）', () => {
    expect(HARNESS_AGENTS.dsh.envDefaults()[0]?.key).toBe('DEEPSEEK_API_KEY')
  })
})
