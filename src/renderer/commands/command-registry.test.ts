// @vitest-environment jsdom
/**
 * 命令注册表单测 —— 匹配/查找纯函数 + 各类命令的副作用路由与回显:
 *   导航类 → window CustomEvent(NAV_EVENT) + 返回「已切换到 X」回显
 *   /new   → ui-store 请求自增 + navigate(sessions) + 回显
 *   /local → window.electronAPI.connect(临时会话配置,id 空 = 不落盘)+ closeOverlay
 *   /help  → pane-store 挂载内置手册文档页签(builtin 来源,内容随包;chinese/english 参数压过 locale)+ closeOverlay
 *   /ls    → pane-store 挂载清点文档页签(占位先落,异步聚合覆写;对象参数 = 子清单独立身份)+ closeOverlay
 * CommandScreen 只是这层注册表的视图,UI 行为不在此范围。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { COMMANDS, matchCommands, findExact, splitCommand, splitCommandUi, resolveHelpLanguage, filterArgCandidates, NAV_EVENT } from './command-registry'
import i18n from '../i18n'
import { useUiStore } from '../stores/ui-store'
import { usePaneStore } from '../stores/pane-store'
import { BUILTIN_HELP_PATH } from '../components/DocPanel/readDoc'
import { BUILTIN_INVENTORY_PATH, resolveInventorySection, SECTION_ORDER } from './inventory'
import type { DocOverlayPayload } from '@shared/types'
import type { NavTab } from '../components/Layout/ActivityRail'

const connect = vi.fn()
const listAgents = vi.fn()
const listEnvProfiles = vi.fn()
const listPlugins = vi.fn()
const listDshWorkspaces = vi.fn()
const listCodexWorkspaces = vi.fn()
const listClaudeWorkspaces = vi.fn()

beforeEach(() => {
  connect.mockReset()
  // 清点数据源:各路返回空集合(/ls 至少能渲染全节的空表 + 新建链接)
  listAgents.mockResolvedValue([])
  listEnvProfiles.mockResolvedValue({ profiles: [], activeProfileId: null })
  listPlugins.mockResolvedValue([])
  listDshWorkspaces.mockResolvedValue([])
  listCodexWorkspaces.mockResolvedValue([])
  listClaudeWorkspaces.mockResolvedValue([])
  // ui-store 是模块级单例,测试间归零防串扰
  useUiStore.setState({ createDialogRequests: {} })
  // pane-store 同为单例:/help、/ls 会在活动 pane 上挂文档页签,基线归零防跨用例残留
  usePaneStore.setState({
    layout: {
      root: { id: 'pane-1', type: 'leaf', sessions: ['s-a'], activeSessionId: 's-a', overlays: [] },
      activePaneId: 'pane-1'
    },
    overlayPayloads: {}
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    connect,
    listAgents,
    listEnvProfiles,
    listPlugins,
    listDshWorkspaces,
    listCodexWorkspaces,
    listClaudeWorkspaces
  }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('matchCommands:前缀过滤', () => {
  it('空查询返回全部命令 —— 空状态/面板一展开就是完整命令目录', () => {
    expect(matchCommands('')).toEqual(COMMANDS)
  })

  it('仅斜杠等价于空查询', () => {
    expect(matchCommands('/')).toEqual(COMMANDS)
  })

  it('前缀匹配:/se → sessions 与 settings', () => {
    const names = matchCommands('/se').map(c => c.name)
    expect(names).toEqual(['sessions', 'settings'])
  })

  it('大小写与首尾空白不敏感,带不带斜杠等价', () => {
    expect(matchCommands('  /LOCAL  ').map(c => c.name)).toEqual(['local'])
    expect(matchCommands('Se').map(c => c.name)).toEqual(['sessions', 'settings'])
  })

  it('help 与 /? = 「展示全部命令」的传统别名:与空查询同义给完整目录;前缀行为不变', () => {
    expect(matchCommands('help')).toEqual(COMMANDS)
    expect(matchCommands('  /HELP  ')).toEqual(COMMANDS)  // 归一化后仍是别名
    expect(matchCommands('/?')).toEqual(COMMANDS)
    expect(matchCommands('?')).toEqual(COMMANDS)
    // 只是全词别名:hel 仍走前缀过滤(只有 help),helps 则无匹配
    expect(matchCommands('hel').map(c => c.name)).toEqual(['help'])
    expect(matchCommands('helps')).toEqual([])
  })

  it('无匹配返回空数组(调用方据此渲染「无匹配」)', () => {
    expect(matchCommands('/xyz')).toEqual([])
  })
})

describe('findExact:精确查找', () => {
  it('精确命中(执行回车的路由入口)', () => {
    expect(findExact('help')?.name).toBe('help')
    expect(findExact('/LOCAL')?.name).toBe('local')
  })

  it('未知名返回 undefined', () => {
    expect(findExact('nope')).toBeUndefined()
  })
})

describe('splitCommand:输入拆解', () => {
  it('首词归一化为命令名(去斜杠/小写),其余为参数原文(保留大小写)', () => {
    expect(splitCommand('/help chinese')).toEqual({ name: 'help', args: 'chinese' })
    expect(splitCommand('  /HELP   Chinese  ')).toEqual({ name: 'help', args: 'Chinese' })
  })

  it('无空白分隔即无参数;尾随空白不算参数', () => {
    expect(splitCommand('help')).toEqual({ name: 'help' })
    expect(splitCommand('  /Local  ')).toEqual({ name: 'local' })
    expect(splitCommand('/help   ')).toEqual({ name: 'help' })
  })

  it('参数是命令名之后的整段原文;空输入归零', () => {
    expect(splitCommand('/foo bar baz')).toEqual({ name: 'foo', args: 'bar baz' })
    expect(splitCommand('')).toEqual({ name: '' })
  })
})

describe('resolveHelpLanguage:/help 语言参数', () => {
  it('别名:chinese / zh / cn / 中文 → zh,english / en → en;大小写不敏感', () => {
    expect(resolveHelpLanguage('chinese')).toBe('zh')
    expect(resolveHelpLanguage('zh')).toBe('zh')
    expect(resolveHelpLanguage('cn')).toBe('zh')
    expect(resolveHelpLanguage('中文')).toBe('zh')
    expect(resolveHelpLanguage('english')).toBe('en')
    expect(resolveHelpLanguage('en')).toBe('en')
    expect(resolveHelpLanguage('Chinese')).toBe('zh')
  })

  it('前缀速记:c / ch / chin… → chinese,e / en / engl… → english(两词无公共前缀,不歧义)', () => {
    expect(resolveHelpLanguage('c')).toBe('zh')
    expect(resolveHelpLanguage('chin')).toBe('zh')
    expect(resolveHelpLanguage('e')).toBe('en')
    expect(resolveHelpLanguage('ENGL')).toBe('en')
  })

  it('未带参数(undefined / 空白)→ undefined(随界面语言);无法识别 → null', () => {
    expect(resolveHelpLanguage(undefined)).toBeUndefined()
    expect(resolveHelpLanguage('   ')).toBeUndefined()
    expect(resolveHelpLanguage('french')).toBeNull()
    expect(resolveHelpLanguage('cz')).toBeNull()
  })
})

describe('命令执行:副作用路由与回显', () => {
  it('导航命令派发 lyshell:navigate,detail 为目标页签,并返回非空回显行', () => {
    const seen: NavTab[] = []
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<NavTab>).detail)
    }
    window.addEventListener(NAV_EVENT, listener)
    try {
      const out1 = findExact('settings')?.run()
      const out2 = findExact('web')?.run()
      expect(seen).toEqual(['settings', 'web'])
      expect(typeof out1).toBe('string')
      expect(out1).toBeTruthy()
      expect(typeof out2).toBe('string')
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
  })

  it('九个导航命令各派发对应页签', () => {
    const seen: NavTab[] = []
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<NavTab>).detail)
    }
    window.addEventListener(NAV_EVENT, listener)
    try {
      for (const tab of ['sessions', 'agents', 'dsh', 'codex', 'claude', 'env', 'plugins', 'web', 'settings'] as const) {
        findExact(tab)?.run()
      }
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
    expect(seen).toEqual(['sessions', 'agents', 'dsh', 'codex', 'claude', 'env', 'plugins', 'web', 'settings'])
  })

  it('/new:ui-store 请求自增、派发 navigate(sessions)、返回回显行', () => {
    const listener = vi.fn()
    window.addEventListener(NAV_EVENT, listener)
    try {
      const out = findExact('new')?.run()
      expect(useUiStore.getState().createDialogRequests.sessions).toBe(1)
      expect(listener).toHaveBeenCalledTimes(1)
      expect((listener.mock.calls[0][0] as CustomEvent<NavTab>).detail).toBe('sessions')
      expect(typeof out).toBe('string')
      expect(out).toBeTruthy()
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
  })

  it('/local:以临时会话配置调用 connect —— id 为空(不落盘)、类型 local、带默认终端配置;标记 closeOverlay', () => {
    const entry = findExact('local')
    const out = entry?.run()
    expect(connect).toHaveBeenCalledTimes(1)
    const config = connect.mock.calls[0][0] as { id: string; type: string; terminal: { fontSize: number } }
    expect(config.id).toBe('')
    expect(config.type).toBe('local')
    expect(config.terminal.fontSize).toBe(14)
    expect(entry?.closeOverlay).toBe(true)  // overlay 形态执行后关面板,让长出来的终端可见
    expect(typeof out).toBe('string')
    expect(out).toBeTruthy()
  })

  it('/help:在活动分屏同步挂载手册页签(占位) —— builtin 来源、markdown;注入完成后覆写为随包手册原文;标记 closeOverlay 并回显', async () => {
    const entry = findExact('help')
    const out = entry?.run()
    expect(entry?.closeOverlay).toBe(true)  // 手册落在分屏上,盖在下面的命令面板得让位
    // 同步挂载:run() 返回时页签已在(占位内容) —— 命令面板关闭后用户立刻看到落点
    const docNow = Object.values(usePaneStore.getState().overlayPayloads)
      .find(p => p.kind === 'doc') as DocOverlayPayload | undefined
    expect(docNow?.source).toBe('builtin')
    expect(docNow?.docKind).toBe('markdown')
    expect(docNow?.path).toBe(BUILTIN_HELP_PATH)
    expect(docNow?.content).toContain('Opening the user manual')  // 占位(测试环境 en)
    // MCP 动态段注入是异步的,轮询等待覆写完成
    await vi.waitFor(() => {
      const doc = Object.values(usePaneStore.getState().overlayPayloads)
        .find(p => p.kind === 'doc') as DocOverlayPayload | undefined
      expect(doc?.content).toContain('# LyShell')  // ?raw 随包引入的手册原文
    })
    expect(typeof out).toBe('string')
    expect(out).toBeTruthy()
  })

  it('/help chinese:语言参数压过界面 locale,展开中文手册(测试环境界面语言为 en)', async () => {
    const out = findExact('help')?.run('chinese')
    await vi.waitFor(() => {
      const doc = Object.values(usePaneStore.getState().overlayPayloads)
        .find(p => p.kind === 'doc') as DocOverlayPayload | undefined
      expect(doc?.path).toBe(BUILTIN_HELP_PATH)
      expect(doc?.content).toContain('# LyShell 使用手册')  // 中文版 H1,而非 en locale 默认的英文版
    })
    expect(typeof out).toBe('string')
    expect(out).toBeTruthy()
  })

  it('/help english:界面语言为中文时参数反向压过 locale,展开英文手册', async () => {
    const prev = i18n.language
    await i18n.changeLanguage('zh-CN')
    try {
      const out = findExact('help')?.run('english')
      await vi.waitFor(() => {
        const doc = Object.values(usePaneStore.getState().overlayPayloads)
          .find(p => p.kind === 'doc') as DocOverlayPayload | undefined
        expect(doc?.content).toContain('# LyShell User Manual')  // 英文版 H1
        expect(doc?.content).not.toContain('使用手册')
      })
      expect(typeof out).toBe('string')
    } finally {
      await i18n.changeLanguage(prev)
    }
  })

  it('/help 带无法识别的语言:回显错误行(含可用值提示),不打开手册页签', () => {
    const out = findExact('help')?.run('klingon')
    expect(typeof out).toBe('string')
    expect(out).toContain('klingon')
    expect(out).toContain('chinese')
    // 原状保持:没有任何文档页签被挂上(基线 overlayPayloads 为空)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)
  })

  it('/?:目录里的真命令 —— run 把全部命令及简介打进输出区(首行标题 + 一行一条、name 列对齐;带参数目录的命令缩进列出子命令行),输出落在自身输出区不设 closeOverlay', () => {
    const entry = findExact('?')
    expect(entry).toBeDefined()
    expect(entry?.closeOverlay).toBeFalsy()  // overlay 面板不关,清单当场可读
    const out = entry?.run() as string
    const lines = out.split('\n')
    // 首行 = 标题(应用名 + 命令总数,「# 」是 OutputBody 的抬头标记),
    // 其后 14 条命令行 + 子命令行(/help 2 + /ls 8)
    expect(lines[0]).toBe(`# ${i18n.t('commandBar.catalogTitle', { total: COMMANDS.length })}`)
    const argRows = COMMANDS.reduce((n, c) => n + (c.argCandidates?.length ?? 0), 0)
    expect(lines).toHaveLength(1 + COMMANDS.length + argRows)
    for (const c of COMMANDS) {
      expect(out).toContain(`/${c.name}`)
      // 子命令行:4 空格缩进 + 参数词,简介与参数目录同源(descriptionKey)
      for (const a of c.argCandidates ?? []) {
        expect(out).toContain(`    ${a.value}`)
        expect(out).toContain(i18n.t(a.descriptionKey))
      }
    }
    // 描述与目录行同源(descriptionKey),清单可读
    expect(out).toContain(i18n.t('commandBar.cmd.help'))
  })

  it('/ls:在活动分屏挂载清点文档页签 —— 同步落占位、异步聚合覆写为完整清单(空数据也有各节新建链接);标记 closeOverlay 并回显', async () => {
    const entry = findExact('ls')
    const out = entry?.run()
    expect(entry?.closeOverlay).toBe(true)  // 清单落在分屏上,盖在下面的命令面板得让位
    const docOf = (): DocOverlayPayload | undefined =>
      Object.values(usePaneStore.getState().overlayPayloads)
        .find(p => p.kind === 'doc') as DocOverlayPayload | undefined
    // 占位先落(同步开页签,聚合未完成时不空白)
    expect(docOf()?.path).toBe(BUILTIN_INVENTORY_PATH)
    expect(docOf()?.source).toBe('builtin')
    // 异步聚合完成:标题 + 各节的「新建」动作链接都生成(空表也有入口)
    await vi.waitFor(() => {
      expect(docOf()?.content).toContain('# LyShell inventory')
    })
    const content = docOf()?.content ?? ''
    for (const action of ['new-session', 'new-agent', 'new-env', 'new-dsh', 'new-codex', 'new-claude', 'new-plugin']) {
      expect(content).toContain(`lyshell-action://${action}`)
    }
    expect(typeof out).toBe('string')
    expect(out).toBeTruthy()
  })

  it('/ls env:挂载子清单页签 —— 独立身份 lyshell://inventory/env(标题带范围),聚合后只有变量组一节,回显点名对象', async () => {
    const out = findExact('ls')?.run('env')
    const docOf = (): DocOverlayPayload | undefined =>
      Object.values(usePaneStore.getState().overlayPayloads)
        .find(p => p.kind === 'doc') as DocOverlayPayload | undefined
    expect(docOf()?.path).toBe(`${BUILTIN_INVENTORY_PATH}/env`)
    expect(docOf()?.title).toBe('Inventory · Env')
    await vi.waitFor(() => {
      expect(docOf()?.content).toContain('## Env · 0')
    })
    expect(docOf()?.content).not.toContain('## Sessions')
    expect(docOf()?.content).not.toContain('## Plugins')
    // 回显行点明清点的是哪一类(而非含糊的「全部对象」)
    expect(out).toContain('Env')
  })

  it('/ls 带无法识别的对象:回显错误行(含可用值提示),不打开清点页签', () => {
    const out = findExact('ls')?.run('klingon')
    expect(typeof out).toBe('string')
    expect(out).toContain('klingon')
    expect(out).toContain('sessions')
    expect(out).toContain('all')
    // 原状保持:没有任何文档页签被挂上(基线 overlayPayloads 为空)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)
  })
})

describe('resolveInventorySection:/ls 的对象参数', () => {
  it('未带参数与显式 all → 全量(undefined);规范名与单复数别名精确命中,大小写不敏感', () => {
    expect(resolveInventorySection()).toBeUndefined()
    expect(resolveInventorySection('')).toBeUndefined()
    expect(resolveInventorySection('all')).toBeUndefined()
    expect(resolveInventorySection('env')).toBe('env')
    expect(resolveInventorySection('ENV')).toBe('env')
    expect(resolveInventorySection('claude')).toBe('claude')
    expect(resolveInventorySection('session')).toBe('sessions')
    expect(resolveInventorySection('plugin')).toBe('plugins')
    expect(resolveInventorySection('agents')).toBe('agents')
  })

  it('前缀速记:唯一命中才收;d → dsh、co → codex、cl → claude;c 是 codex/claude 公共前缀 → 未知', () => {
    expect(resolveInventorySection('s')).toBe('sessions')
    expect(resolveInventorySection('sess')).toBe('sessions')
    expect(resolveInventorySection('a')).toBe('agents')
    expect(resolveInventorySection('e')).toBe('env')
    expect(resolveInventorySection('d')).toBe('dsh')
    expect(resolveInventorySection('co')).toBe('codex')
    expect(resolveInventorySection('cl')).toBe('claude')
    expect(resolveInventorySection('p')).toBe('plugins')
    expect(resolveInventorySection('c')).toBeNull()
    expect(resolveInventorySection('x')).toBeNull()
  })
})

describe('splitCommandUi:UI 目录拆解(尾空白保留)', () => {
  it('命令名后按过空白即进入参数区:空串参数 = 完整参数目录的展开时机', () => {
    expect(splitCommandUi('/ls ')).toEqual({ name: 'ls', args: '' })
    expect(splitCommandUi('/ls e')).toEqual({ name: 'ls', args: 'e' })
    expect(splitCommandUi('/LS E')).toEqual({ name: 'ls', args: 'E' })  // 命令名归一,参数保留原文
    expect(splitCommandUi('/help chinese')).toEqual({ name: 'help', args: 'chinese' })
    expect(splitCommandUi('ls')).toEqual({ name: 'ls' })  // 无空白 = 未进入参数区
    expect(splitCommandUi('')).toEqual({ name: '' })
  })

  it('与执行拆解的差别:splitCommand 吞掉空参(执行不路由、按无参执行),Ui 版保留(目录展开)', () => {
    expect(splitCommand('/ls ')).toEqual({ name: 'ls' })
    expect(splitCommandUi('/ls ')).toEqual({ name: 'ls', args: '' })
  })
})

describe('argCandidates:参数目录数据源', () => {
  it('/ls = 七节规范名 + all(与 resolveInventorySection 同源),/help = 两语言', () => {
    expect(findExact('ls')?.argCandidates?.map(c => c.value)).toEqual([...SECTION_ORDER, 'all'])
    expect(findExact('help')?.argCandidates?.map(c => c.value)).toEqual(['chinese', 'english'])
    // 目录候选即合法参数:每个 value 都能被参数解析收下(不会给出点了报错的候选)
    for (const c of findExact('ls')?.argCandidates ?? []) {
      expect(resolveInventorySection(c.value)).toBe(c.value === 'all' ? undefined : c.value)
    }
  })

  it('目录描述键可译(nav.* 与专用键都存在)', () => {
    for (const entry of [findExact('ls'), findExact('help')]) {
      for (const c of entry?.argCandidates ?? []) {
        expect(i18n.t(c.descriptionKey)).toBeTruthy()
        expect(i18n.t(c.descriptionKey)).not.toBe(c.descriptionKey)
      }
    }
  })
})

describe('filterArgCandidates:参数目录过滤(前缀优先,错字就近兜底)', () => {
  const lsArgs = findExact('ls')?.argCandidates ?? []

  it('空参数 = 完整目录;前缀命中优先且大小写不敏感,不走兜底', () => {
    expect(filterArgCandidates(lsArgs, '')).toHaveLength(8)
    // c 同时命中 codex/claude:并列前缀全列出,不猜
    expect(filterArgCandidates(lsArgs, 'c').map(c => c.value)).toEqual(['codex', 'claude'])
    expect(filterArgCandidates(lsArgs, 'ENV').map(c => c.value)).toEqual(['env'])
  })

  it('零前缀命中时编辑距离 ≤2 就近兜底:sesion → sessions、codx → codex、ven → env', () => {
    expect(filterArgCandidates(lsArgs, 'sesion').map(c => c.value)).toEqual(['sessions'])
    expect(filterArgCandidates(lsArgs, 'codx').map(c => c.value)).toEqual(['codex'])
    expect(filterArgCandidates(lsArgs, 'ven').map(c => c.value)).toEqual(['env'])
    // /help 的语言参数同样受益(chinse 差一个字母)
    const helpArgs = findExact('help')?.argCandidates ?? []
    expect(filterArgCandidates(helpArgs, 'chinse').map(c => c.value)).toEqual(['chinese'])
  })

  it('太短(<3)不猜、太远(>2)无命中 —— 兜底不是模糊搜索', () => {
    expect(filterArgCandidates(lsArgs, 'l')).toEqual([])   // l 离 all 仅差 2,但太短不猜
    expect(filterArgCandidates(lsArgs, 'xyz')).toEqual([])
  })

  it('最近的并列多个时全部列出,交 ↑↓ 挑', () => {
    const fake = [
      { value: 'codex', descriptionKey: 'x' },
      { value: 'coder', descriptionKey: 'x' }
    ]
    // codez 离两者都差一个字母(并列最近),不擅自择一
    expect(filterArgCandidates(fake, 'codez').map(c => c.value)).toEqual(['codex', 'coder'])
  })
})
