// @vitest-environment jsdom
/**
 * /ls 清点注入回归（端到端）—— buildInventoryMarkdown 的产物要过真实的
 * MarkdownDoc 渲染管线（内置来源双门禁全放行的形态），断言伪造的对象名
 * 借 []() 语法断不出活的动作链接（尤其 mcp-toggle 安全开关），而本来的
 * open-session 打开链接仍然活着。markdown 级的转义契约在 inventory.test.ts，
 * 本文件守的是「渲染出来」的语义：漏转义即活的 <a>。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import MarkdownDoc from '../components/DocPanel/MarkdownDoc'
import { buildInventoryMarkdown, BUILTIN_INVENTORY_PATH, type InventoryData } from './inventory'
import { runDocAction } from './doc-actions'
import { ConnectionType, ConnectionStatus } from '@shared/types'
import type { SessionConfig, DocOverlayPayload } from '@shared/types'

vi.mock('./doc-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./doc-actions')>()
  return { ...actual, runDocAction: vi.fn() }
})

/** 测试用终端配置占位(生成器不消费该字段) */
const terminal = {} as SessionConfig['terminal']

/** 四种注入形态各占一行(名称位 ](、纯文本位完整 [x](url)、名称位 \ 击穿、纯文本位 <autolink>) */
const evilSaved1: SessionConfig = {
  id: 'saved-evil',
  name: '点我](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)',
  type: ConnectionType.SSH,
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  terminal, tags: [], createdAt: new Date(), updatedAt: new Date()
}
const evilSaved2: SessionConfig = {
  id: 'saved-evil2',
  name: '点我\\](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)',
  type: ConnectionType.LOCAL,
  local: { cwd: 'D:\\tmp' },
  terminal, tags: [], createdAt: new Date(), updatedAt: new Date()
}
const evilTemp: SessionConfig = {
  id: 'runtime-evil',
  name: '[手册](lyshell-action://mcp-toggle-allow-metadata-write?lang=zh)',
  type: ConnectionType.LOCAL,
  local: { cwd: 'D:\\tmp' },
  terminal, tags: [], createdAt: new Date(), updatedAt: new Date()
}
const evilTemp2: SessionConfig = {
  id: 'runtime-evil2',
  name: '<lyshell-action://mcp-toggle-confirm-destructive?lang=zh>',
  type: ConnectionType.LOCAL,
  local: { cwd: 'D:\\tmp' },
  terminal, tags: [], createdAt: new Date(), updatedAt: new Date()
}
/** id 位注入:id 与名称同为用户可控,)[x](url) 想截断 href 后自成链接 */
const evilSaved3: SessionConfig = {
  id: 'x)[y](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)',
  name: 'prod',
  type: ConnectionType.SSH,
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  terminal, tags: [], createdAt: new Date(), updatedAt: new Date()
}
/** 换行位注入:裸 \r 是 CommonMark 行结束符,断行后 # 语法想长出标题/吞掉表格 */
const evilSaved4: SessionConfig = {
  id: 'saved-cr',
  name: 'prod\r# INJECTED HEADING\r```',
  type: ConnectionType.SSH,
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  terminal, tags: [], createdAt: new Date(), updatedAt: new Date()
}
/** 类型位注入:sessions.json 磁盘加载不经枚举闸,type 也得断不出链接 */
const evilSaved5: SessionConfig = {
  id: 'saved-type',
  name: 'prod',
  type: 'ssh\r[x](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)' as ConnectionType.SSH,
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  terminal, tags: [], createdAt: new Date(), updatedAt: new Date()
}

const data: InventoryData = {
  savedSessions: [evilSaved1, evilSaved2, evilSaved3, evilSaved4, evilSaved5],
  liveSessions: [
    { id: 'runtime-evil', config: evilTemp, status: ConnectionStatus.CONNECTED, isTemporary: true },
    { id: 'runtime-evil2', config: evilTemp2, status: ConnectionStatus.CONNECTED, isTemporary: true }
  ],
  agents: [], envProfiles: [], activeProfileId: null,
  plugins: [], dshWorkspaces: [], codexWorkspaces: [], claudeWorkspaces: []
}

const payload: DocOverlayPayload = {
  source: 'builtin',
  docKind: 'markdown',
  path: BUILTIN_INVENTORY_PATH,
  title: 'inventory',
  size: 0,
  mtime: 0,
  content: ''
}

afterEach(cleanup)

describe('/ls 清点注入回归:伪造动作链接不得渲染成活链接', () => {
  it('七种注入形态下 DOM 无 mcp-toggle 锚点,open-session 打开链接仍活着可点', () => {
    const md = buildInventoryMarkdown(data)
    const { container } = render(<MarkdownDoc content={md} payload={payload} paneId="pane-1" />)

    // 闸:注入的 mcp-toggle 一概不落地成 <a>(名称位/纯文本位/反斜杠击穿位/尖括号 autolink 位/id 截断位/换行位/类型位)
    expect(container.querySelectorAll('a[href^="lyshell-action://mcp-toggle"]')).toHaveLength(0)
    // 本来的打开链接不受转义牵连:五个 saved 行的 open-session 锚点都在
    const openLinks = container.querySelectorAll('a[href^="lyshell-action://open-session"]')
    expect(openLinks).toHaveLength(5)
    // 注入的名称成了链接标签里的字面文本(点到的仍是 open-session 语义)
    expect(openLinks[0].textContent).toContain('点我](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)')
    expect(openLinks[1].textContent).toContain('\\](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)')
    // 纯文本位的完整 [x](url) 与 <autolink> 语法只剩字面文本,不成链接
    expect(container.textContent).toContain('[手册](lyshell-action://mcp-toggle-allow-metadata-write?lang=zh) (temporary)')
    expect(container.textContent).toContain('<lyshell-action://mcp-toggle-confirm-destructive?lang=zh> (temporary)')
    expect(container.querySelectorAll(`a[href="lyshell-action://open-session?id=saved-evil"]`)).toHaveLength(1)
    // id 位:注入内容整个困在百分号编码的 id 参数里,href 完整、路由语义不变(点它仍查无此会话而静默)
    expect(container.querySelectorAll('a[href^="lyshell-action://open-session?id=x%29%5By%5D%28lyshell-action%3A%2F%2Fmcp"]').length).toBe(1)
    // 换行位:裸 \r 折叠成空格,断不出标题/围栏 —— 文档只有清单本来的节标题,没有 INJECTED
    expect([...container.querySelectorAll('h1,h2,h3')].map(h => h.textContent)).not.toContain('INJECTED HEADING')
    expect(container.textContent).toContain('prod # INJECTED HEADING ```')
    // 类型位:\r 折叠 + []() 转义,整格只剩字面文本
    expect(container.textContent).toContain('ssh [x](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)')

    // 活性:点行内打开链接仍走 doc-actions 派发(转义不破坏功能)
    fireEvent.click(container.querySelector('a[href="lyshell-action://open-session?id=saved-evil"]')!)
    expect(runDocAction).toHaveBeenCalledWith({ id: 'open-session', params: { id: 'saved-evil' } })
  })
})
