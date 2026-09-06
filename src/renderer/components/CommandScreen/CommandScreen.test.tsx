// @vitest-environment jsdom
/**
 * CommandScreen 组件单测 —— 参数目录的可见性回归(用户实测:/ls 带参时候选列表
 * 清空、Tab 无反应;错字 sesion 应就近落到 sessions 而非只剩报错)。命令目录与
 * 参数目录共用 ↑↓/Tab/Enter/点击 四件套;执行副作用断言落在 pane-store 的
 * 清点页签身份上。用 overlay 形态跑(无需 paneActive,单 props 即完整挂载)。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import CommandScreen from './CommandScreen'
import { usePaneStore } from '../../stores/pane-store'
import { BUILTIN_INVENTORY_PATH } from '../../commands/inventory'
import type { DocOverlayPayload } from '@shared/types'

// jsdom 未实现 scrollIntoView(候选列表的滚动跟随 effect 会踩到)
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const listAgents = vi.fn()
const listEnvProfiles = vi.fn()
const listPlugins = vi.fn()
const listDshWorkspaces = vi.fn()
const listCodexWorkspaces = vi.fn()
const listClaudeWorkspaces = vi.fn()

beforeEach(() => {
  // 清点数据源:各路返回空集合(子清单页签能渲染该节的空表 + 新建链接)
  listAgents.mockResolvedValue([])
  listEnvProfiles.mockResolvedValue({ profiles: [], activeProfileId: null })
  listPlugins.mockResolvedValue([])
  listDshWorkspaces.mockResolvedValue([])
  listCodexWorkspaces.mockResolvedValue([])
  listClaudeWorkspaces.mockResolvedValue([])
  // pane-store 是模块级单例,测试间归零防串扰
  usePaneStore.setState({
    layout: {
      root: { id: 'pane-1', type: 'leaf', sessions: ['s-a'], activeSessionId: 's-a', overlays: [] },
      activePaneId: 'pane-1'
    },
    overlayPayloads: {}
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    listAgents,
    listEnvProfiles,
    listPlugins,
    listDshWorkspaces,
    listCodexWorkspaces,
    listClaudeWorkspaces
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

/** 渲染命令屏并键入一段输入(fireEvent.change 模拟逐字输入的最终态) */
const type = (text: string): HTMLInputElement => {
  const input = screen.getByRole('textbox') as HTMLInputElement
  fireEvent.change(input, { target: { value: text } })
  return input
}

const keyDown = (input: HTMLInputElement, key: string): void => {
  fireEvent.keyDown(input, { key })
}

/** 派发可取消的左键原生 mousedown 并返回事件 —— jsdom 不模拟 mousedown 的原生
 *  焦点搬迁,defaultPrevented 就是浏览器里"焦点不搬家"的判定条件 */
const mouseDown = (el: Element): MouseEvent => {
  const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
  el.dispatchEvent(evt)
  return evt
}

const docOf = (): DocOverlayPayload | undefined =>
  Object.values(usePaneStore.getState().overlayPayloads)
    .find(p => p.kind === 'doc') as DocOverlayPayload | undefined

describe('CommandScreen:参数目录', () => {
  it('命令名后按空格即展开完整参数目录(行首列 = 回车会执行的完整命令),状态栏切参数计数', () => {
    render(<CommandScreen mode="overlay" />)
    type('/ls ')
    for (const row of ['/ls sessions', '/ls env', '/ls claude', '/ls all']) {
      expect(screen.getByText(row)).toBeTruthy()
    }
    // 完整目录 8 项(七节 + all),状态栏右侧是参数计数而非命令计数
    expect(screen.getByText('8/8 args')).toBeTruthy()
  })

  it('参数前缀过滤:已键参数做前缀匹配(大小写不敏感),无命中显示空态', () => {
    render(<CommandScreen mode="overlay" />)
    type('/ls c')
    expect(screen.getByText('/ls codex')).toBeTruthy()
    expect(screen.getByText('/ls claude')).toBeTruthy()
    expect(screen.queryByText('/ls env')).toBeNull()
    expect(screen.getByText('2/8 args')).toBeTruthy()

    type('/ls ENV')
    expect(screen.getByText('/ls env')).toBeTruthy()

    type('/ls xyz')
    expect(screen.getByText('No matching arguments')).toBeTruthy()
  })

  it('Tab:补全选中的参数候选 —— 唯一命中即它;多候选补 ↑↓ 点亮的那行', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls co')
    keyDown(input, 'Tab')
    expect(input.value).toBe('/ls codex')

    // c 命中 codex/claude:选中行(row 0)
    type('/ls c')
    keyDown(input, 'Tab')
    expect(input.value).toBe('/ls codex')

    type('/ls c')
    keyDown(input, 'ArrowDown')  // 点亮 claude
    keyDown(input, 'Tab')
    expect(input.value).toBe('/ls claude')
  })

  it('Tab:命令名唯一命中且带参数目录时,补全顺势带一个空格,参数目录随即展开', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls')
    keyDown(input, 'Tab')
    expect(input.value).toBe('/ls ')
    expect(screen.getByText('/ls sessions')).toBeTruthy()
  })

  it('Tab:命令目录多候选时补全选中行(↑↓ 点亮的那条);输入已是完整命令名则按它规整', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/se')  // sessions / settings
    keyDown(input, 'Tab')
    expect(input.value).toBe('/sessions')

    type('/se')
    keyDown(input, 'ArrowDown')  // 点亮 settings
    keyDown(input, 'Tab')
    expect(input.value).toBe('/settings')

    // 完整命令名 + Tab:不改写成别的;带参数目录的顺势带空格展开参数
    type('/help')
    keyDown(input, 'Tab')
    expect(input.value).toBe('/help ')
    expect(screen.getByText('/help chinese')).toBeTruthy()

    // help、/? 是展开整张目录的别名,选中行未必是输入本意:Tab 不改写
    type('/?')
    keyDown(input, 'Tab')
    expect(input.value).toBe('/?')
  })

  it('错字兜底:sesion 前缀零命中仍就近给出 sessions,Enter 直接开该节子清单', async () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls sesion')
    // 兜底候选可见(而非「无匹配参数」),状态栏计数随之
    expect(screen.getByText('/ls sessions')).toBeTruthy()
    expect(screen.queryByText('No matching arguments')).toBeNull()
    expect(screen.getByText('1/8 args')).toBeTruthy()

    keyDown(input, 'Enter')
    // 回车执行选中候选(= sessions),落到独立子清单身份,而非报错行
    expect(docOf()?.path).toBe(`${BUILTIN_INVENTORY_PATH}/sessions`)
    await vi.waitFor(() => {
      expect(docOf()?.content).toContain('## Sessions · 0')
    })
    expect(docOf()?.content).not.toContain('## Env ·')
    expect(screen.queryByText(/Unknown section/)).toBeNull()
  })

  it('错字兜底也吃 Tab:唯一候选直接把输入改写成规范值', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls codx')
    keyDown(input, 'Tab')
    expect(input.value).toBe('/ls codex')
  })

  it('Enter:执行选中候选(前缀输入 + ↑↓ 选择),输入清空、子清单页签落到 pane-store', async () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls c')
    keyDown(input, 'ArrowDown')  // codex(0) → claude(1)
    keyDown(input, 'Enter')
    expect(input.value).toBe('')
    expect(docOf()?.path).toBe(`${BUILTIN_INVENTORY_PATH}/claude`)
    expect(docOf()?.title).toBe('Inventory · Claude')
    // 异步聚合落地:子清单只有 Claude 一节
    await vi.waitFor(() => {
      expect(docOf()?.content).toContain('## Claude · Workspaces · 0')
    })
    expect(docOf()?.content).not.toContain('## Sessions')
  })

  it('Enter:空参按原文执行(= 全量清单),无命中参数按原文执行(命令报错、不开页签)', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls ')
    keyDown(input, 'Enter')
    expect(docOf()?.path).toBe(BUILTIN_INVENTORY_PATH)

    type('/ls xyz')
    keyDown(input, 'Enter')
    // 错误回显进输出区(含可用值提示),仍无新页签
    expect(screen.getByText(/Unknown section: xyz/)).toBeTruthy()
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(1)
  })

  it('点击参数行直接执行该候选', async () => {
    render(<CommandScreen mode="overlay" />)
    type('/ls ')
    fireEvent.click(screen.getByText('/ls env'))
    expect(docOf()?.path).toBe(`${BUILTIN_INVENTORY_PATH}/env`)
    await vi.waitFor(() => {
      expect(docOf()?.content).toContain('## Env · 0')
    })
  })
})

describe('CommandScreen:命令历史(输入空时 ↑↓ 翻历史)', () => {
  it('↑↓ 召回已执行的命令(带 / 前缀):↑ 到最旧停住,↓ 越过最新回空退出;Enter 重跑', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('abc')   // 未知命令也进历史(bash 式:敲过的都算)
    keyDown(input, 'Enter')
    type('def')
    keyDown(input, 'Enter')
    expect(input.value).toBe('')

    keyDown(input, 'ArrowUp')   // 最新一条
    expect(input.value).toBe('/def')
    keyDown(input, 'ArrowUp')   // 更旧一条
    expect(input.value).toBe('/abc')
    keyDown(input, 'ArrowUp')   // 已到最旧:按住不动
    expect(input.value).toBe('/abc')
    keyDown(input, 'ArrowDown')
    expect(input.value).toBe('/def')
    keyDown(input, 'ArrowDown')   // 越过最新 → 清空,退出回溯
    expect(input.value).toBe('')

    keyDown(input, 'ArrowUp')   // 重新召回
    keyDown(input, 'Enter')     // 召回即重跑
    expect(input.value).toBe('')
    expect(screen.getAllByText(/Unknown command \/def/)).toHaveLength(2)
  })

  it('回溯中候选目录与计数暂避;重新输入即退出回溯,↑↓ 恢复候选选择', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/settings')
    keyDown(input, 'Enter')
    expect(input.value).toBe('')

    keyDown(input, 'ArrowUp')   // 召回 /settings
    expect(input.value).toBe('/settings')
    // 召回的是完整命令,过滤目录与计数暂避(计数若在应是 1/14)
    expect(screen.queryByText('1/14 commands')).toBeNull()

    type('/se')   // 重新输入 = 退出回溯,目录恢复
    expect(screen.getByText('2/14 commands')).toBeTruthy()
    keyDown(input, 'ArrowDown')   // 此刻 ↑↓ 又是候选选择(点亮 settings)
    keyDown(input, 'Enter')
    expect(input.value).toBe('')
    expect(screen.getAllByText(/Switched to/)).toHaveLength(2)
  })

  it('历史为空时 ↑ 无处可去;未在回溯时 ↓ 单独按不动', () => {
    render(<CommandScreen mode="overlay" />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    keyDown(input, 'ArrowUp')
    expect(input.value).toBe('')
    keyDown(input, 'ArrowDown')
    expect(input.value).toBe('')
  })

  it('命令名后按了空格:↑↓ 只翻这条命令的参数历史(别的命令不混入),越过最新回到参数区起点', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls env')
    keyDown(input, 'Enter')
    type('xyz')            // 别的命令(未知)也进历史,但不应混入参数回溯
    keyDown(input, 'Enter')

    type('/ls ')
    keyDown(input, 'ArrowUp')   // 召回 ls 最近用过的参数:env
    expect(input.value).toBe('/ls env')
    // 参数回溯保留参数目录:召回值即过滤词,目录是对召回值的预览(selector 限定
    // span:回显行「❯ /ls env」的文本节点也会归一化命中同名文本)
    expect(screen.getByText('/ls env', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByText('/ls sessions')).toBeNull()
    keyDown(input, 'ArrowUp')   // 没有更旧的 ls 用法,停住
    expect(input.value).toBe('/ls env')

    keyDown(input, 'ArrowDown')   // 越过最新 → 回到 '/ls '(参数区起点),退出回溯
    expect(input.value).toBe('/ls ')

    // 整行回溯不受影响:空输入 ↑ 召回的是全局最新一条(xyz)
    type('')
    keyDown(input, 'ArrowUp')
    expect(input.value).toBe('/xyz')
  })

  it('参数回溯连按 ↑ 逐条往旧翻、↓ 往回;召回后 Enter 重跑该参数', () => {
    render(<CommandScreen mode="overlay" />)
    const input = type('/ls env')
    keyDown(input, 'Enter')
    type('/ls claude')
    keyDown(input, 'Enter')

    type('/ls ')
    keyDown(input, 'ArrowUp')   // 最近:claude
    expect(input.value).toBe('/ls claude')
    keyDown(input, 'ArrowUp')   // 更旧:env
    expect(input.value).toBe('/ls env')
    keyDown(input, 'ArrowDown')
    expect(input.value).toBe('/ls claude')

    keyDown(input, 'Enter')     // 召回即重跑
    expect(input.value).toBe('')
    expect(screen.getAllByText(/Taking inventory of Claude/)).toHaveLength(2)
  })
})

describe('CommandScreen:embedded 焦点让位与收回(覆盖层盖屏)', () => {
  // 空态跑 /ls、/help 会开出文档页签(absolute inset-0)盖住命令屏:期间键盘
  // 不该打进看不见的输入框攒幽灵命令,关掉页签后焦点要自动收回接着打字
  const inputOf = (): HTMLInputElement => screen.getByRole('textbox') as HTMLInputElement

  it('被覆盖层盖住时让出焦点,覆盖层全撤后收回', () => {
    const { rerender } = render(<CommandScreen mode="embedded" paneActive covered />)
    expect(document.activeElement).not.toBe(inputOf())

    rerender(<CommandScreen mode="embedded" paneActive covered={false} />)
    expect(document.activeElement).toBe(inputOf())

    rerender(<CommandScreen mode="embedded" paneActive covered />)
    expect(document.activeElement).not.toBe(inputOf())
  })

  it('非激活 pane 不抢焦点(焦点属于别处的终端)', () => {
    render(<CommandScreen mode="embedded" paneActive={false} />)
    expect(document.activeElement).not.toBe(inputOf())
  })

  it('点击屏面任意处聚焦 prompt(TUI 惯例,焦点丢失的自愈通道);covered 态不抢', () => {
    const { container, rerender } = render(<CommandScreen mode="embedded" paneActive={false} />)
    expect(document.activeElement).not.toBe(inputOf())
    fireEvent.mouseDown(container.firstElementChild as HTMLElement)
    expect(document.activeElement).toBe(inputOf())

    // 被覆盖层盖住时不抢焦点(活动覆盖层 zIndex 更高,点击本也到不了,守卫是防御)
    rerender(<CommandScreen mode="embedded" paneActive covered />)
    expect(document.activeElement).not.toBe(inputOf())
    fireEvent.mouseDown(container.firstElementChild as HTMLElement)
    expect(document.activeElement).not.toBe(inputOf())
  })
})

describe('CommandScreen:空输入待命(只有输入命令才开始补全和提示)', () => {
  it('空输入:无候选行、状态栏无计数;键入 / 即展开完整目录', () => {
    render(<CommandScreen mode="overlay" />)
    // 待命态:候选行与计数都不出现(prompt 本身就是邀请,不抢在输入之前)
    expect(screen.queryByText('/help')).toBeNull()
    expect(screen.queryByText(/\d+\/\d+ commands/)).toBeNull()

    // 第一个字符落下,提示随即开始:完整命令目录 + 计数
    type('/')
    expect(screen.getByText('/help')).toBeTruthy()
    expect(screen.getByText(/commands/)).toBeTruthy()
  })

  it('待命 ghost 提示:空输入时点名 help、/?、/ 三个入口;三者都展开完整目录,输入即让位', () => {
    render(<CommandScreen mode="embedded" paneActive />)
    // 待命:块状光标后跟一行暗色 ghost,承诺三个入口;候选行仍不出现
    expect(screen.getByText('Type help, /? or / to list all commands')).toBeTruthy()
    expect(screen.queryByText('/help')).toBeNull()

    const input = screen.getByRole('textbox') as HTMLInputElement
    // help(传统别名,Windows CMD 语义):完整目录(不止 help 前缀的 1 条),ghost 让位
    type('help')
    expect(screen.queryByText('Type help, /? or / to list all commands')).toBeNull()
    expect(screen.getByText('/settings')).toBeTruthy()
    expect(screen.getByText(/commands/)).toBeTruthy()

    // /? 与 / 同义:三个入口行为一致
    fireEvent.change(input, { target: { value: '/?' } })
    expect(screen.getByText('/settings')).toBeTruthy()
    fireEvent.change(input, { target: { value: '/' } })
    expect(screen.getByText('/settings')).toBeTruthy()
  })

  it('空输入(含纯空白)回车是空行:不执行任何命令、不回显', () => {
    render(<CommandScreen mode="overlay" />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    keyDown(input, 'Enter')
    // 此前会静默执行候选列表第一条(help):echo 行 + 手册页签都不该出现
    expect(screen.queryByText('❯ /help')).toBeNull()
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)

    // 纯空白同样不算"开始输入"
    fireEvent.change(input, { target: { value: '  ' } })
    keyDown(input, 'Enter')
    expect(screen.queryByText('❯ /help')).toBeNull()
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)
  })

  it('空态屏面干净:无铭牌、无 POST 自检 —— 待命屏上除 ghost 提示外没有任何未经请求的信息', () => {
    render(<CommandScreen mode="embedded" paneActive />)
    expect(screen.queryByText('LYSHELL')).toBeNull()
    expect(screen.queryByText(/POST|自检|self-test/)).toBeNull()
    // 屏上仅剩 prompt(聚焦)+ ghost 提示与状态栏
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
    expect(screen.getByText(/↑↓/)).toBeTruthy()
  })
})

describe('CommandScreen:/? 真命令', () => {
  it('目录里有 /? 本尊一行;Enter 把全部命令及简介打进输出区(一行一条、两列排版),不落文档页签', () => {
    const { container } = render(<CommandScreen mode="embedded" paneActive />)
    const input = type('/?')
    // 输入即展开完整目录(help、/?、/ 三入口同义),目录里有 /? 这一行
    expect(screen.getByText('/?')).toBeTruthy()

    keyDown(input, 'Enter')
    // 回显行 + 清单进输出区;输入清空回待命(textContent 含嵌套 span,echo 行整条可见)
    const text = container.textContent ?? ''
    expect(text).toContain('❯ /?')
    for (const name of ['help', 'new', 'ls', 'local', 'sessions', 'settings']) {
      expect(text).toContain(`/${name}`)
    }
    // 清单按两列排版:名字与说明各自成 span,整行糊在一起时这种精确匹配拿不到
    expect(screen.getByText('/help')).toBeTruthy()
    expect(screen.getByText('List every command with its description')).toBeTruthy()
    // 标题行:应用名 + 命令总数,man-page 式抬头,词首大写(不走 CSS 全大写)
    expect(screen.getByText('LyShell · 14 Commands')).toBeTruthy()
    // 子命令行:树形勾线挂进所属命令的组(├ 兄弟 / └ 组尾;勾线是 aria-hidden
    // 的独立 span,名字列的直接文本仍是纯参数词)
    expect(screen.getByText('chinese', { selector: 'span' })).toBeTruthy()
    expect(screen.getByText('sessions', { selector: 'span' })).toBeTruthy()
    expect(screen.getAllByText('├')).toHaveLength(8)   // chinese + /ls 的前七节
    expect(screen.getAllByText('└')).toHaveLength(2)  // english、all(两组的组尾)
    // 子命令列琥珀点亮:清单里「能跟着命令接着输的词」用焦点色标记,一扫即见
    expect(screen.getByText('chinese', { selector: 'span' }).className).toContain('amber')
    expect(input.value).toBe('')
    // 清单是 /? 自己的输出(区别于 /help、/ls 开文档页签):pane-store 不动
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)
  })
})

describe('CommandScreen:内联文档(md 在上、prompt 在下)', () => {
  // 空态跑出文档页签(/ls、/help)时,激活的文档内联为命令屏的输出区:文档即
  // 本次命令的输出,输入框始终在渲染后的文档下面、保持聚焦(不再盖屏失焦)
  const docPayload: DocOverlayPayload = {
    source: 'builtin',
    docKind: 'markdown',
    path: 'lyshell://inventory',
    title: 'inventory',
    size: 16,
    mtime: 0,
    content: '# inventory\n\n- session-one\n'
  }

  it('inlineDoc:文档渲染进输出区(头条路径 + 内容),输入框保持聚焦', async () => {
    render(
      <CommandScreen
        mode="embedded"
        paneActive
        inlineDoc={{ id: 'doc-1', paneId: 'pane-1', payload: docPayload }}
      />
    )
    // 完整 DocTabOverlay 内联:头条路径 + md 内容(lazy MarkdownDoc 需等一拍,
    // 全量并发跑时模块加载可能超过默认 1s,放宽到 3s 防抖)
    expect(screen.getByTitle('lyshell://inventory')).toBeTruthy()
    expect(await screen.findByText('session-one', {}, { timeout: 3000 })).toBeTruthy()
    // 键盘始终在命令屏:输入框聚焦
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('点击文档内容不动输入焦点:可聚焦控件拦 mousedown,文本与 prompt 维持原生', async () => {
    render(
      <CommandScreen
        mode="embedded"
        paneActive
        inlineDoc={{ id: 'doc-1', paneId: 'pane-1', payload: docPayload }}
      />
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    // 文档头条的关闭按钮(可聚焦控件):mousedown 默认动作被拦 —— 浏览器不再把
    // 焦点搬给按钮,键盘留在 prompt,点完文档接着打字
    expect(mouseDown(screen.getByTitle('Close document tab')).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)

    // 文档正文(纯文本):不拦 —— 拖选文字维持原生行为(同上,lazy md 放宽超时)
    const body = await screen.findByText('session-one', {}, { timeout: 3000 })
    expect(mouseDown(body).defaultPrevented).toBe(false)

    // prompt 自身:不拦 —— 光标定位/拖选维持原生行为
    expect(mouseDown(input).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
  })
})
