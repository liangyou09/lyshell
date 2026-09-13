// @vitest-environment jsdom
/**
 * 清点 markdown 生成单测 —— buildInventoryMarkdown 是纯函数:
 * 只消费传入数据与 i18n 文案,断言各节的表格行、状态聚合、「新建」动作链接与
 * 行内「打开」链接(lyshell-action://open-*,路由语义的副作用在 doc-actions.test.ts),
 * 以及 section 参数的子清单形态(只渲染该节)。
 * 另有链接语法转义组:用户可控字符串(名称/命令/目录)不得借 []() 断出伪造动作链接
 * (渲染端到端回归在 inventory.action-injection.test.tsx)。
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
    expect(md).toContain('| scratch (temporary) | local | D:\\\\tmp | ● connected |')
  })

  it('用户可控字符串转义链接语法:名称位 ]( 断不出链接,纯文本位 [x](url) 与 <autolink> 只剩字面文本', () => {
    // 名称位注入:openLink 把名称包在 [名称](真 href) 里,伪造的 ]( 想断出 mcp-toggle 动作链接
    const evilSaved: SessionConfig = {
      ...savedSsh,
      id: 'saved-evil',
      name: '点我](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)'
    }
    // 纯文本位注入:临时行名称不经 openLink 包装,直接落表 —— 完整链接语法即活链接
    const evilTemp: SessionConfig = {
      ...tempLocal,
      id: 'runtime-evil',
      name: '[手册](lyshell-action://mcp-toggle-allow-metadata-write?lang=zh)'
    }
    // 尖括号 autolink 注入:不需要 [x](…) 语法,<scheme:…> 本身就渲染成活链接
    const evilTemp2: SessionConfig = {
      ...tempLocal,
      id: 'runtime-evil2',
      name: '<lyshell-action://mcp-toggle-confirm-destructive?lang=zh>'
    }
    const md = buildInventoryMarkdown({
      ...base,
      savedSessions: [evilSaved],
      liveSessions: [
        { id: 'runtime-evil', config: evilTemp, status: ConnectionStatus.CONNECTED, isTemporary: true },
        { id: 'runtime-evil2', config: evilTemp2, status: ConnectionStatus.CONNECTED, isTemporary: true }
      ]
    })
    // 名称位:] 已转义,断不出链接;外层 open-session 链接结构完好(点击仍是本来的连接语义)
    expect(md).toContain('[点我\\](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)](lyshell-action://open-session?id=saved-evil)')
    // 纯文本位:[ 与 ] 均已转义,只剩字面文本
    expect(md).toContain('\\[手册\\](lyshell-action://mcp-toggle-allow-metadata-write?lang=zh) (temporary)')
    // autolink 位:< 已转义,<> 内的 href 不再被解析成链接
    expect(md).toContain('\\<lyshell-action://mcp-toggle-confirm-destructive?lang=zh> (temporary)')
    // 语义闸:注入的 mcp-toggle href 不以未转义 ]( 的链接形态出现(\]( 是转义残影,非链接)
    expect(md).not.toMatch(/[^\\]\]\(lyshell-action:\/\/mcp-toggle/)
    // 语义闸:也不以未转义 < 的 autolink 形态出现(\< 是转义残影)
    expect(md).not.toMatch(/[^\\]<lyshell-action:\/\//)
  })

  it('名称自带反斜杠时转义不被配对击穿:\\ 先行转义,不会与注入的 \\] 配对成 \\\\ 让 ] 裸露', () => {
    const evilSaved: SessionConfig = {
      ...savedSsh,
      id: 'saved-evil2',
      // 反斜杠紧跟 ] —— 若不先转义反斜杠,用户 \ 会与注入的 \] 配对成 \\,让 ] 裸露回链接语法
      name: '点我\\](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)'
    }
    const md = buildInventoryMarkdown({ ...base, savedSessions: [evilSaved] })
    // \ → \\\\、] → \\]:名称后跟三个反斜杠 + ],markdown 读作 字面\\ + 字面],断不出链接
    expect(md).toContain('[点我\\\\\\](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)](lyshell-action://open-session?id=saved-evil2)')
  })

  it('id 借 ) 提前终结 href 的注入:括号百分号编码,注入内容整个困在 id 参数里', () => {
    // id 与名称同为用户可控(导入配置可带任意 id);)[x](url) 想截断 href 后自成链接。
    // encodeURIComponent 已转义 []/从而注入括号对无从成形,这里守 ( ) 本身:
    // 编码成 %28/%29 后目的地不被截断,整串进 params.id(URLSearchParams 解码回原文)
    const evilSaved: SessionConfig = {
      ...savedSsh,
      id: 'x)[y](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)',
      name: 'prod'
    }
    const md = buildInventoryMarkdown({ ...base, savedSessions: [evilSaved] })
    // 完整 href 一体落表:注入的 ) [ ] ( / : ? 全部百分号化(含 id 结尾的 )),目的地读到模板 ) 才闭合
    expect(md).toContain('(lyshell-action://open-session?id=x%29%5By%5D%28lyshell-action%3A%2F%2Fmcp-toggle-confirm-destructive%3Flang%3Dzh%29)')
    // 语义闸:id 注入的 mcp-toggle 不以未转义 ]( 的链接形态出现
    expect(md).not.toMatch(/[^\\]\]\(lyshell-action:\/\/mcp-toggle/)
  })

  it('换行折叠收全 \\r 形态:裸 \\r 也是 CommonMark 行结束符,不折叠会断行成块级内容', () => {
    // 裸 \r 断开表格行后,名称后半段落成块级(标题/列表/未闭合围栏能吞掉整篇后半文档);
    // [\r\n] 连 \n\r 混排一并折叠成单空格
    const evilSaved: SessionConfig = {
      ...savedSsh,
      id: 'saved-cr',
      name: 'prod\r# INJECTED\r\nTAIL'
    }
    const md = buildInventoryMarkdown({ ...base, savedSessions: [evilSaved] })
    // 折叠成空格:行不断,标题语法 # 落进链接标签成字面文本
    expect(md).toContain('[prod # INJECTED TAIL](lyshell-action://open-session?id=saved-cr)')
    // 语义闸:产物不含任何裸 \r
    expect(md).not.toMatch(/\r/)
  })

  it('类型位同样过 cell():磁盘/IPC 来源的 type 不经枚举闸时也断不出链接', () => {
    // type 在 MCP create_session 有枚举闸,但 sessions.json 磁盘加载是裸 JSON.parse ——
    // 不对称的转义(名称过 cell、type 不)会让未来新增的写入路径静默重开注入面,
    // 不变量收全:一切非生成器字段一律 cell()
    const evilSaved: SessionConfig = {
      ...savedSsh,
      id: 'saved-type',
      name: 'prod',
      type: 'ssh\r[x](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)' as ConnectionType.SSH
    }
    const md = buildInventoryMarkdown({ ...base, savedSessions: [evilSaved] })
    // 类型位:\r 折叠、[]() 转义,整格只剩字面文本;名称位照旧是活链接
    // 目标列变 —:sessionTarget 按 type 分支,注入的 type 不等于 'ssh' 落到占位 —— 转义不影响该语义
    expect(md).toContain('| [prod](lyshell-action://open-session?id=saved-type) | ssh \\[x\\](lyshell-action://mcp-toggle-confirm-destructive?lang=zh) | — | — |')
    // 语义闸:类型注入的 mcp-toggle 不以未转义 ]( 的链接形态出现
    expect(md).not.toMatch(/[^\\]\]\(lyshell-action:\/\/mcp-toggle/)
  })

  it('Agent 节:按 order 排序,名称为启动链接,命令与工作目录成表', () => {
    const md = buildInventoryMarkdown(base)
    expect(md).toContain('## Agents · 2')
    const dshRow = '| [dsh](lyshell-action://open-agent?id=a0) | dsh-tui | — |'
    expect(md.indexOf(dshRow)).toBeGreaterThan(0)
    expect(md.indexOf('| [Claude Code](lyshell-action://open-agent?id=a1) | claude | D:\\\\ws |')).toBeGreaterThan(md.indexOf(dshRow))
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
    // 反斜杠按转义契约双写(D:\repo → D:\\repo,渲染回显仍是一个 \)
    expect(md).toContain('| [lyshell](lyshell-action://open-dsh?id=w1) | D:\\\\repo | — | worktree isolation |')
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
