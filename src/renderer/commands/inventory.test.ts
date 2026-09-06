// @vitest-environment jsdom
/**
 * 清点 markdown 生成单测 —— buildInventoryMarkdown 是纯函数:
 * 只消费传入数据与 i18n 文案,断言各节的表格行、状态聚合、「新建」动作链接与
 * 行内「打开」链接(lyshell-action://open-*,路由语义的副作用在 doc-actions.test.ts),
 * 以及 section 参数的子清单形态(只渲染该节)。
 * (打开/刷新的时序守卫在 command-registry.test.ts 的 /ls 用例覆盖)
 */
import { describe, it, expect } from 'vitest'
import { buildInventoryMarkdown, type InventoryData } from './inventory'
import { ConnectionType, ConnectionStatus } from '@shared/types'
import type { SessionConfig } from '@shared/types'

/** 测试用终端配置占位(生成器不消费该字段) */
const terminal = {} as SessionConfig['terminal']

const savedSsh: SessionConfig = {
  id: 'saved-1',
  name: 'prod',
  type: ConnectionType.SSH,
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  terminal,
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
}

const tempLocal: SessionConfig = {
  id: 'runtime-2',
  name: 'scratch',
  type: ConnectionType.LOCAL,
  local: { cwd: 'D:\\tmp' },
  terminal,
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
}

const base: InventoryData = {
  savedSessions: [savedSsh],
  liveSessions: [
    // saved 的 runtime 克隆(已连接) + 未关联 saved 的临时会话
    { id: 'runtime-1', config: { ...savedSsh, id: 'runtime-1', originSavedSessionId: 'saved-1' }, status: ConnectionStatus.CONNECTED },
    { id: 'runtime-2', config: tempLocal, status: ConnectionStatus.CONNECTED, isTemporary: true }
  ],
  agents: [{ id: 'a1', name: 'Claude Code', command: 'claude', cwd: 'D:\\ws', order: 2 },
           { id: 'a0', name: 'dsh', command: 'dsh-tui', order: 1 }],
  envProfiles: [{ id: 'p1', name: 'prod keys', order: 1, baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', env: { NO_PROXY: '*' } }],
  activeProfileId: 'p1',
  plugins: [{
    id: 'demo', version: '1.0.0', path: 'demo', dev: true, enabled: true,
    grantedCapabilities: [], installedAt: '2026-01-01', source: 'dev',
    name: 'Demo Plugin', runtime: 'node', lifecycle: 'persistent', activationEvents: [],
    capabilities: []
  }],
  dshWorkspaces: [{ id: 'w1', name: 'lyshell', cwd: 'D:\\repo', order: 1, isolation: 'worktree' }],
  codexWorkspaces: [],
  claudeWorkspaces: null
}

describe('buildInventoryMarkdown', () => {
  it('会话节:saved 行名称是打开链接、临时行保持纯文本;目标摘要、运行态聚合(克隆已连接 → saved 行显示已连接)', () => {
    const md = buildInventoryMarkdown(base)
    // 1 saved + 1 未关联 saved 的临时行
    expect(md).toContain('## Sessions · 2')
    expect(md).toContain('| [prod](lyshell-action://open-session?id=saved-1) | ssh | 10.0.0.1:22 | ● connected |')
    expect(md).toContain('| scratch (temporary) | local | D:\\tmp | ● connected |')
  })

  it('Agent 节:按 order 排序,名称为启动链接,命令与工作目录成表', () => {
    const md = buildInventoryMarkdown(base)
    expect(md).toContain('## Agents · 2')
    const dshRow = '| [dsh](lyshell-action://open-agent?id=a0) | dsh-tui | — |'
    expect(md.indexOf(dshRow)).toBeGreaterThan(0)
    expect(md.indexOf('| [Claude Code](lyshell-action://open-agent?id=a1) | claude | D:\\ws |')).toBeGreaterThan(md.indexOf(dshRow))
  })

  it('变量组节:名称为编辑链接 + 全局启用指针打 ACTIVE 角标,密钥以 ✓ 标记而不回显', () => {
    const md = buildInventoryMarkdown(base)
    expect(md).toContain('## Env · 1')
    expect(md).toContain('| [prod keys](lyshell-action://open-env?id=p1) **ACTIVE** | https://api.deepseek.com | 1 extras | ✓ |')
    expect(md).not.toContain('sk-x')
  })

  it('工作区节:名称为启动链接;worktree 隔离标记;空表显示占位;null 显示读取失败', () => {
    const md = buildInventoryMarkdown(base)
    expect(md).toContain('## DeepSeek Harness · Workspaces · 1')
    expect(md).toContain('| [lyshell](lyshell-action://open-dsh?id=w1) | D:\\repo | — | worktree isolation |')
    expect(md).toContain('## Codex · Workspaces · 0')
    expect(md).toContain('*(none)*')
    expect(md).toContain('## Claude · Workspaces · 0')
    expect(md).toContain('*(failed to load)*')
  })

  it('插件节:名称为切面板链接,dev 徽标与启用态成表;竖线与换行在链接文本内转义', () => {
    const md = buildInventoryMarkdown({
      ...base,
      plugins: [...base.plugins!, {
        id: 'p2', version: '2.0.0', path: 'p2', dev: false, enabled: false,
        grantedCapabilities: [], installedAt: '2026-01-01', source: 'url',
        name: 'a|b\nc', runtime: 'python', lifecycle: 'oneshot', activationEvents: [],
        capabilities: []
      }]
    })
    expect(md).toContain('## Plugins · 2')
    expect(md).toContain('| [Demo Plugin dev](lyshell-action://open-plugin?id=demo) | 1.0.0 | node | persistent | Enabled |')
    // a|b 换行 c → 竖线转义 + 换行折叠空格,不断列不断行
    expect(md).toContain('| [a\\|b c](lyshell-action://open-plugin?id=p2) | 2.0.0 | python | oneshot | Disabled |')
  })

  it('头部有「点击名称打开」提示行;各节尾都有「新建」动作链接(lyshell-action://)', () => {
    const md = buildInventoryMarkdown(base)
    expect(md).toContain('Click a name to open it')
    for (const action of ['new-session', 'new-agent', 'new-env', 'new-dsh', 'new-codex', 'new-claude', 'new-plugin']) {
      expect(md).toContain(`lyshell-action://${action}`)
    }
  })
})

describe('buildInventoryMarkdown:section 子清单', () => {
  it('/ls env:只渲染变量组一节 —— 标题带范围、其余节一概不出现、新建/打开链接仍在,刷新提示指回带参命令', () => {
    const md = buildInventoryMarkdown(base, 'env')
    expect(md).toContain('# LyShell inventory · Env')
    expect(md).toContain('## Env · 1')
    expect(md).toContain('| [prod keys](lyshell-action://open-env?id=p1)')
    expect(md).toContain('lyshell-action://new-env')
    expect(md).toContain('/ls env')
    for (const absent of ['## Sessions', '## Agents', '## DeepSeek Harness', '## Codex', '## Claude', '## Plugins']) {
      expect(md).not.toContain(absent)
    }
  })

  it('/ls claude:读取失败的节保持失败标记(不静默当空表),也只此一节', () => {
    const md = buildInventoryMarkdown(base, 'claude')
    expect(md).toContain('# LyShell inventory · Claude')
    expect(md).toContain('## Claude · Workspaces · 0')
    expect(md).toContain('*(failed to load)*')
    expect(md).not.toContain('## Sessions')
  })
})
