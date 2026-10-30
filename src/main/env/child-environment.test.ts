import { describe, expect, it } from 'vitest'
import { childEnvironment } from './child-environment'

describe('子进程最小环境', () => {
  it('保留运行必须变量，不把宿主模型、MCP、插件凭据或Node注入传播给无关任务', () => {
    const env = childEnvironment({ Path: '/bin', SystemRoot: 'C:/Windows', LANG: 'zh_CN.UTF-8',
      OPENAI_API_KEY: 'fixture-other-agent', LYSHELL_MCP_TOKEN: 'fixture-host',
      LYSHELL_PLUGIN_TOKEN: 'fixture-sibling', NODE_OPTIONS: '--require untrusted.js',
      GITHUB_TOKEN: 'fixture-github' }, { LYSHELL_PLUGIN_TOKEN: 'fixture-this-plugin' })
    expect(env).toMatchObject({ Path: '/bin', SystemRoot: 'C:/Windows', LANG: 'zh_CN.UTF-8', LYSHELL_PLUGIN_TOKEN: 'fixture-this-plugin' })
    for (const key of ['OPENAI_API_KEY', 'LYSHELL_MCP_TOKEN', 'NODE_OPTIONS', 'GITHUB_TOKEN']) expect(env[key]).toBeUndefined()
  })
  it('显式任务变量与指定继承键可用，来源环境保持不变', () => {
    const base = { DSH_HOME: '/own-dsh', OPENAI_API_KEY: 'fixture-other' }
    expect(childEnvironment(base, { OPENAI_API_KEY: 'fixture-selected' }, ['DSH_HOME'])).toEqual({ DSH_HOME: '/own-dsh', OPENAI_API_KEY: 'fixture-selected' })
    expect(base.OPENAI_API_KEY).toBe('fixture-other')
  })
})
