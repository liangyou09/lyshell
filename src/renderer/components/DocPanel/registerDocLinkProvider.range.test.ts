// @vitest-environment jsdom
/**
 * link provider 端到端坐标测试：真实 xterm 实例写入文本 → createDocLinkProvider
 * 直调 provideLinks → 校验 range 的 1-based 列区间精确覆盖匹配文本。
 * 回归点：「- 文件名」弹点行不得把前导破折号/空格划进链接。
 * URL 链接另有激活端到端用例：provideLinks → activate(Ctrl+点击) → openWebTab
 * 网页页签挂载（真实 pane-store，锁住 provider → store 的整条接线）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import type { ILink } from '@xterm/xterm'
import { createDocLinkProvider, guessLocalCwd, findGroupDir, findLsDir, findRemotePrompt, pickRemoteDocPath } from './registerDocLinkProvider'
import type { RemotePromptInfo } from './docLink'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { ConnectionStatus } from '@shared/types'
import type { SessionConfig, OverlayPayload, OverlayRef, PaneLeaf, PaneLayout } from '@shared/types'

interface RangeCase {
  line: string
  expectedText: string
  expectedStartX: number
  expectedEndX: number
}

const CASES: RangeCase[] = [
  { line: '- RELEASE_NOTES_v1.0.3.md', expectedText: 'RELEASE_NOTES_v1.0.3.md', expectedStartX: 3, expectedEndX: 25 },
  { line: '  - RELEASE_NOTES_v1.0.3.md', expectedText: 'RELEASE_NOTES_v1.0.3.md', expectedStartX: 5, expectedEndX: 27 },
  { line: '-rw-r--r-- RELEASE_NOTES_v1.0.3.md', expectedText: 'RELEASE_NOTES_v1.0.3.md', expectedStartX: 12, expectedEndX: 34 },
  { line: 'RELEASE_NOTES_v1.0.3.md', expectedText: 'RELEASE_NOTES_v1.0.3.md', expectedStartX: 1, expectedEndX: 23 },
  // 多段相对（无 ./ 前缀）：error␣ 占 6 列，路径 41 字符 → 1-based [7..47]
  { line: 'error src/renderer/assets/agent-icons/README.md not found', expectedText: 'src/renderer/assets/agent-icons/README.md', expectedStartX: 7, expectedEndX: 47 },
  // 「见」宽字符占 2 列：路径 0-based 列 3..21 → 1-based [4..22]
  { line: '见 D:\\docs\\report.html 详情', expectedText: 'D:\\docs\\report.html', expectedStartX: 4, expectedEndX: 22 },
  // URL 链接：「见」宽字符 + 空格占 3 列，URL 24 字符 → 1-based [4..27]；
  // 同行的 .md 后缀不得被文档路径识别截走（整条归 URL）
  { line: '见 https://example.com/a.md 详情', expectedText: 'https://example.com/a.md', expectedStartX: 4, expectedEndX: 27 },
  // URL 行尾句读剥离：`docs:␣` 占 6 列，URL 29 字符（末尾的 . 不入链接）
  { line: 'docs: https://example.com/docs.html.', expectedText: 'https://example.com/docs.html', expectedStartX: 7, expectedEndX: 35 }
]

async function linksOf(line: string): Promise<ILink[]> {
  const terminal = new Terminal({ cols: 80, rows: 10 })
  try {
    terminal.write(line + '\r\n')
    await new Promise<void>(resolve => terminal.write('', resolve))
    const provider = createDocLinkProvider(terminal, 'test-session')
    return await new Promise<ILink[]>(resolve => provider.provideLinks(1, links => resolve(links ?? [])))
  } finally {
    terminal.dispose()
  }
}

describe('createDocLinkProvider：range 列区间精确性', () => {
  for (const c of CASES) {
    it(`「${c.line}」→ x ∈ [${c.expectedStartX}..${c.expectedEndX}]`, async () => {
      const links = await linksOf(c.line)
      expect(links).toHaveLength(1)
      const link = links[0]
      expect(link.text).toBe(c.expectedText)
      expect(link.range.start.x).toBe(c.expectedStartX)
      expect(link.range.end.x).toBe(c.expectedEndX)
      expect(link.range.start.y).toBe(1)
      expect(link.range.end.y).toBe(1)
    })
  }

  it('无匹配行返回空数组', async () => {
    expect(await linksOf('no docs here')).toEqual([])
  })

  // 混合行锁住「两扫描并排不重叠」：文档路径与 URL 各成一条链，互不截断
  it('同一行既有文档路径又有 URL：两条链各自完整', async () => {
    const links = await linksOf('error in src/a.md, see https://example.com/x for details')
    expect(links).toHaveLength(2)
    expect(links.map(l => l.text)).toEqual(['src/a.md', 'https://example.com/x'])
    // 区间互不重叠（1-based x：src/a.md ∈ [10..17]，URL ∈ [24..44]）
    expect(links[0].range.start.x).toBe(10)
    expect(links[0].range.end.x).toBe(17)
    expect(links[1].range.start.x).toBe(24)
    expect(links[1].range.end.x).toBe(44)
  })
})

// ===== URL 链接激活端到端：provideLinks → activate → openWebTab =====

type WebPayload = Extract<OverlayPayload, { kind: 'web' }>

/** 投影全部 web 覆盖层（叶序 × 引用序） */
const webOverlayViews = (): { paneId: string; ref: OverlayRef; payload: WebPayload }[] => {
  const st = usePaneStore.getState()
  const out: { paneId: string; ref: OverlayRef; payload: WebPayload }[] = []
  for (const pane of st.getAllLeafPanes()) {
    for (const r of pane.overlays) {
      const p = st.overlayPayloads[r.id]
      if (r.kind === 'web' && p?.kind === 'web') out.push({ paneId: pane.id, ref: r, payload: p })
    }
  }
  return out
}

describe('URL 链接激活端到端：Ctrl+点击 → openWebTab', () => {
  // 全局 zustand store 每例重置：断言「无残留覆盖层」依赖干净起点，
  // beforeEach 兜住后续新增用例漏调 setup 的坑（漏了会读到上一例的挂载）
  const setupUrlPane = (): void => {
    const leafNode: PaneLeaf = {
      id: 'pane-url', type: 'leaf', sessions: ['sess-url'],
      activeSessionId: 'sess-url', overlays: []
    }
    const layout: PaneLayout = { root: leafNode, activePaneId: 'pane-url' }
    usePaneStore.setState({ layout, overlayPayloads: {}, draggingOverlayId: null, hiddenTabSessions: {} })
  }
  beforeEach(setupUrlPane)

  it('Ctrl+点击 → 网页页签挂到会话所在 pane 并激活，URL 归一化', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    try {
      await writeAndDrain(t, 'see https://example.com/x\r\n')
      const provider = createDocLinkProvider(t, 'sess-url')
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(1, ls => resolve(ls ?? [])))
      expect(links).toHaveLength(1)
      expect(links[0].text).toBe('https://example.com/x')
      // 普通点击不劫持（保留给终端聚焦）
      links[0].activate?.(new MouseEvent('click', { ctrlKey: false }), links[0].text)
      expect(webOverlayViews()).toHaveLength(0)
      // Ctrl+点击开网页页签
      links[0].activate?.(new MouseEvent('click', { ctrlKey: true }), links[0].text)
      const views = webOverlayViews()
      expect(views).toHaveLength(1)
      expect(views[0].paneId).toBe('pane-url')
      expect(views[0].ref.active).toBe(true)
      expect(views[0].payload.url).toBe('https://example.com/x')
    } finally {
      t.dispose()
    }
  })

  it('Cmd（metaKey）+点击同样触发；悬浮提示用 URL 文案', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    try {
      await writeAndDrain(t, 'docs: https://example.com/a.md.\r\n')
      const provider = createDocLinkProvider(t, 'sess-url')
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(1, ls => resolve(ls ?? [])))
      expect(links).toHaveLength(1) // 整条 URL，不被文档路径截走
      links[0].activate?.(new MouseEvent('click', { metaKey: true }), links[0].text)
      expect(webOverlayViews()).toHaveLength(1)
      expect(webOverlayViews()[0].payload.url).toBe('https://example.com/a.md')
    } finally {
      t.dispose()
    }
  })
})

async function writeAndDrain(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>(resolve => terminal.write(data, resolve))
}

describe('guessLocalCwd：本地 cwd 猜测', () => {
  it('空闲 shell：底部裸提示符即 cwd', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    await writeAndDrain(t, 'PS D:\\docs> rg --files\r\nsrc/a.md\r\nexamples/README.md\r\nPS D:\\docs> ')
    expect(guessLocalCwd(t)).toBe('D:\\docs')
    t.dispose()
  })

  it('TUI 输出下方无新提示符：向上扫到带启动命令的提示符行', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    await writeAndDrain(t, 'PS D:\\workspace\\claude\\LyShell> claude\r\n-.claude/plans/x.md\r\nsrc/renderer/assets/agent-icons/README.md\r\n')
    expect(guessLocalCwd(t)).toBe('D:\\workspace\\claude\\LyShell')
    t.dispose()
  })

  it('备用屏幕 TUI：提示符在 normal buffer 里也能找到', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    await writeAndDrain(t, 'PS D:\\docs> vim notes.md\r\n')
    await writeAndDrain(t, '\x1b[?1049h') // 进入备用屏幕
    await writeAndDrain(t, '│ TUI 帧 │\r\nREADME.md\r\n')
    expect(guessLocalCwd(t)).toBe('D:\\docs')
    t.dispose()
  })

  it('全程无提示符：null；带 fallback 用 fallback', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    await writeAndDrain(t, 'some output\r\nmore output\r\n')
    expect(guessLocalCwd(t)).toBeNull()
    expect(guessLocalCwd(t, 'D:\\fallback')).toBe('D:\\fallback')
    t.dispose()
  })
})

describe('findGroupDir：分组列表目录上下文（用户实际场景）', () => {
  // 用户粘贴的原样输出：目录头 + 裸名条目，空行分组
  const GROUPED = [
    'prototypes/（2 个）',
    '- sidebar-rack.html — 侧栏 RACK v2 原型（对应记忆里的 rack-graphite/slate/carbon 主题体系）',
    '- file-manager.html — 文件管理器原型',
    '',
    'docs/（1 个）',
    '- statusbar-quickcmd-sidebar-prototype.html — 快捷命令合入侧栏的原型'
  ]

  it('组内条目命中本组目录头（首个/非首个条目）', async () => {
    const t = new Terminal({ cols: 200, rows: 12 }) // 加宽避免长条目行折行
    try {
      await writeAndDrain(t, GROUPED.join('\r\n') + '\r\n')
      // 1-based：1=prototypes 头 2,3=条目 4=空行 5=docs 头 6=条目
      expect(findGroupDir(t, 2)).toBe('prototypes/')
      expect(findGroupDir(t, 3)).toBe('prototypes/')
      expect(findGroupDir(t, 6)).toBe('docs/')
    } finally {
      t.dispose()
    }
  })

  it('空行截断：条目上方无目录头时不跨组借用', async () => {
    const t = new Terminal({ cols: 200, rows: 12 })
    try {
      await writeAndDrain(t, 'prototypes/（2 个）\r\n- a.html\r\n\r\n- lonely.md\r\n')
      // lonely.md 与上面的组隔着空行 → 无目录上下文
      expect(findGroupDir(t, 4)).toBeNull()
    } finally {
      t.dispose()
    }
  })

  it('普通输出（无目录头）返回 null', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    try {
      await writeAndDrain(t, 'README.md\r\nnotes.md\r\n')
      expect(findGroupDir(t, 2)).toBeNull()
    } finally {
      t.dispose()
    }
  })
})

describe('findGroupDir：组头带描述 + 表格（用户实际场景）', () => {
  // 用户粘贴的原样输出：组头带 — 描述、与表格之间隔一空行、表格行 │ 起头
  const TABLE = [
    'design/（9 个）— UI 方向探索',
    '',
    '┌───────────────────────────────────────┬─────────────────────────────────────────────────────────────┐',
    '│                 文件                  │                            内容                             │',
    '├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┤',
    '│ ground-station.html                   │ Ground Station（地面站）整体 UI 方向初版                    │',
    '├───────────────────────────────────────┼─────────────────────────────────────────────────────────────┤',
    '│ terminal.html → terminal-compare.html │ 终端面板：保留 / 微调 / 重构三种方案对比                    │',
    '└───────────────────────────────────────┴─────────────────────────────────────────────────────────────┘'
  ]

  it('跨过组头与表格间的空行，表格行命中 design/（含双文件名箭头行）', async () => {
    const t = new Terminal({ cols: 200, rows: 12 }) // 加宽避免表格行折行
    try {
      await writeAndDrain(t, TABLE.join('\r\n') + '\r\n')
      // 1-based：1=组头 2=空 3=表顶 4=列头 5=分隔 6/8=数据行
      expect(findGroupDir(t, 6)).toBe('design/')
      expect(findGroupDir(t, 8)).toBe('design/')
    } finally {
      t.dispose()
    }
  })

  it('空行上方首个非空行不是目录头时不跨过（不借用别的组的条目）', async () => {
    const t = new Terminal({ cols: 200, rows: 12 })
    try {
      await writeAndDrain(t, 'prototypes/（2 个）\r\n- a.html\r\n\r\n- lonely.md\r\n')
      // lonely.md 上方隔空行是上一组的条目 - a.html，不是目录头 → 不借用
      expect(findGroupDir(t, 4)).toBeNull()
    } finally {
      t.dispose()
    }
  })
})

// ===== ls 命令行目录候选：裸文件名 → stat 验证 → 开文档页签 =====

describe('findLsDir：ls 命令行目录上下文（用户实际场景）', () => {
  // 用户粘贴的原样输出（节选）：提示符 + ls 多列列表，无目录头行
  const LS_LISTING = [
    'fenghuiyu@docker-IPS:~$ ls project/6080/',
    'NGIPS6080SP2              NGIPS6080SP3_VPNCheck_V1s    NGIPS_Main_Branche_20260109           libssh-0.11.4',
    'NGIPS6080SP3              NGIPS6080SP3_YDJC_20251211   NGIPS_Main_Branche_lite_20250211      libssh-0.11.4.tar.xz',
    'NGIPS6080SP3_20260721     NGIPS6080SP3_YDJC_20260715   NGIPS_Main_Branche_lite_20260414      rust-1.92.0-x86_64.tar.gz',
    'NGIPS6080SP3_AI           NGIPS6080_20240130_for_YDJC  NGIPS_Main_Branche_lite_20250211_arm  RELEASE_NOTES_v1.0.6.md'
  ]

  it('多列列表任意行命中上方命令行的目录参数', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, LS_LISTING.join('\r\n') + '\r\n')
      // 1-based：1=提示符命令行 2..5=列表
      expect(findLsDir(t, 2)).toBe('project/6080/')
      expect(findLsDir(t, 5)).toBe('project/6080/')
    } finally {
      t.dispose()
    }
  })

  it('上方无 ls 命令行返回 null（不误认普通输出）', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    try {
      await writeAndDrain(t, 'README.md\r\nnotes.md\r\n')
      expect(findLsDir(t, 1)).toBeNull()
    } finally {
      t.dispose()
    }
  })
})

describe('findRemotePrompt：远端提示符行交互 cwd 上下文（用户实际场景）', () => {
  it('ls 无参时从上方提示符行提取交互 shell 的用户与 cwd', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'fenghuiyu@docker-IPS:~/project/6080$ ls\r\nNGIPS6080SP2  RELEASE_NOTES_v1.0.6.md\r\n')
      // 1-based：1=提示符行 2=列表
      expect(findRemotePrompt(t, 2)).toEqual({ user: 'fenghuiyu', cwd: '~/project/6080' })
    } finally {
      t.dispose()
    }
  })

  it('终端里 su 换用户后：提示符行提取的是新用户与其家目录下的 cwd', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'test@docker-IPS:~/test$ ls\r\nRELEASE_NOTES_v1.0.6.md\r\n')
      expect(findRemotePrompt(t, 2)).toEqual({ user: 'test', cwd: '~/test' })
    } finally {
      t.dispose()
    }
  })

  it('列表多行 / 上方是普通输出时都能扫到（至多 40 行窗口）', async () => {
    const t = new Terminal({ cols: 200, rows: 12 })
    try {
      await writeAndDrain(t, 'fenghuiyu@docker-IPS:~$ ls project/6080/\r\nNGIPS6080SP2\r\nNGIPS6080SP3\r\nRELEASE_NOTES_v1.0.6.md\r\n')
      expect(findRemotePrompt(t, 4)).toEqual({ user: 'fenghuiyu', cwd: '~' })
    } finally {
      t.dispose()
    }
  })

  it('上方无提示符行返回 null', async () => {
    const t = new Terminal({ cols: 80, rows: 10 })
    try {
      await writeAndDrain(t, 'README.md\r\nnotes.md\r\n')
      expect(findRemotePrompt(t, 1)).toBeNull()
    } finally {
      t.dispose()
    }
  })
})

describe('pickRemoteDocPath：ls 目录 × cwd 双轴候选 + stat 验证', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  const setApi = (statPath: (p: string) => Promise<unknown>): void => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      filePwd: () => Promise.resolve({ success: true, data: '/home/fenghuiyu' }),
      fileStat: (_s: string, p: string) => statPath(p)
    }
  }

  /** 提示符信息构造糖 */
  const prompt = (user: string, cwd: string): RemotePromptInfo => ({ user, cwd })

  it('stat 命中 ls 目录候选（用户实际场景一的路径形态）', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/project/6080/RELEASE.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    expect(await pickRemoteDocPath('ls-pick-1', 'RELEASE.md', 'project/6080/', null)).toBe('/home/fenghuiyu/project/6080/RELEASE.md')
  })

  it('ls 候选未命中 → cwd 归并候选胜出（启发猜错不致错开页签）', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/RELEASE.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    expect(await pickRemoteDocPath('ls-pick-2', 'RELEASE.md', 'old/dir/', null)).toBe('/home/fenghuiyu/RELEASE.md')
  })

  it('ls 候选是目录 → 视为未命中落到 cwd 候选', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/RELEASE.md'
        ? { success: true, data: { isDir: false } }
        : { success: true, data: { isDir: true } }
    ))
    expect(await pickRemoteDocPath('ls-pick-3', 'RELEASE.md', 'somewhere/', null)).toBe('/home/fenghuiyu/RELEASE.md')
  })

  it('全部未命中 → 取首选候选（错误页签展示最可能意图；无尾斜杠 lsDir 同样拼对）', async () => {
    setApi(() => Promise.resolve({ success: false, error: 'No such file' }))
    expect(await pickRemoteDocPath('ls-pick-4', 'RELEASE.md', 'project/6080', null)).toBe('/home/fenghuiyu/project/6080/RELEASE.md')
  })

  it('stat 通道异常 → 仍取候选路径（开页签出显式报错）', async () => {
    setApi(() => Promise.reject(new Error('channel down')))
    expect(await pickRemoteDocPath('ls-pick-5', 'RELEASE.md', 'project/6080/', null)).toBe('/home/fenghuiyu/project/6080/RELEASE.md')
  })

  it('无 cwd（filePwd 失败）且目录相对 → null', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      filePwd: () => Promise.resolve({ success: false, error: 'no connector' }),
      fileStat: () => Promise.resolve({ success: false })
    }
    expect(await pickRemoteDocPath('ls-pick-6', 'RELEASE.md', 'project/6080/', null)).toBeNull()
  })

  it('提示符 cwd 候选胜出（用户实际场景二：cd 后 ls 无参，登录目录无该文件）', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/project/6080/RELEASE.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    // ls 无参 → lsDir null；提示符 ~/project/6080 按登录目录展开为候选 cwd
    // （提示符用户 = 会话 SSH 用户，~ 归登录 home）
    expect(await pickRemoteDocPath('ls-pick-7', 'RELEASE.md', null, prompt('fenghuiyu', '~/project/6080'), 'fenghuiyu')).toBe('/home/fenghuiyu/project/6080/RELEASE.md')
  })

  it('提示符用户 ≠ 会话 SSH 用户且 cwd 为 ~ 形态（终端里 su 过，用户实际场景三）→ 弃用提示符 cwd，退回登录 home（读取跟随登录用户）', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/RELEASE_NOTES_v1.0.6.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    // 会话以 fenghuiyu 连接（filePwd = /home/fenghuiyu），终端里 su 到 test ——
    // ~/test 属于 test，登录用户解释不了它：不按 /home/test 硬追，也不拼
    // /home/fenghuiyu/test 假路径，直接退回登录 home 归并
    expect(await pickRemoteDocPath('ls-pick-8', 'RELEASE_NOTES_v1.0.6.md', null, prompt('test', '~/test'), 'fenghuiyu')).toBe('/home/fenghuiyu/RELEASE_NOTES_v1.0.6.md')
  })

  it('su 场景退回登录 home 后 stat 全未命中 → 兜底取登录 home 归并候选（错误页签可排查）', async () => {
    setApi(() => Promise.resolve({ success: false, error: 'No such file' }))
    // 唯一候选 = 登录 home 归并路径
    expect(await pickRemoteDocPath('ls-pick-9', 'RELEASE.md', null, prompt('test', '~/test'), 'fenghuiyu')).toBe('/home/fenghuiyu/RELEASE.md')
  })

  it('root 特判：root 会话 filePwd 失败 → 惯例家目录 /root 作 ~ 基准', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      filePwd: () => Promise.resolve({ success: false, error: 'no connector' }),
      fileStat: (_s: string, p: string) => Promise.resolve(
        p === '/root/RELEASE.md'
          ? { success: true, data: { isDir: false } }
          : { success: false, error: 'No such file' }
      )
    }
    // 无登录 home，按会话 SSH 用户名 root 猜惯例家目录 /root
    expect(await pickRemoteDocPath('ls-pick-10', 'RELEASE.md', null, prompt('root', '~'), 'root')).toBe('/root/RELEASE.md')
  })

  it('filePwd 失败但会话 SSH 用户已知 → 惯例家目录仍是可用基准（不静默放弃）', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      filePwd: () => Promise.resolve({ success: false, error: 'no connector' }),
      fileStat: (_s: string, p: string) => Promise.resolve(
        p === '/home/test/test/RELEASE.md'
          ? { success: true, data: { isDir: false } }
          : { success: false, error: 'No such file' }
      )
    }
    // 无登录 home 且提示符用户与会话 SSH 用户一致 → 惯例家目录是唯一 ~ 基准
    expect(await pickRemoteDocPath('ls-pick-11', 'RELEASE.md', null, prompt('test', '~/test'), 'test')).toBe('/home/test/test/RELEASE.md')
  })

  it('提示符 cwd ~/ 前缀无 home 可展开且无提示符用户可用 → 放弃该候选（无候选返回 null）', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      filePwd: () => Promise.resolve({ success: false, error: 'no connector' }),
      fileStat: () => Promise.resolve({ success: false })
    }
    expect(await pickRemoteDocPath('ls-pick-12', 'RELEASE.md', null, null)).toBeNull()
  })

  it('提示符 cwd 解析错（stat 未命中）→ 登录目录候选兜底胜出', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/RELEASE.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    expect(await pickRemoteDocPath('ls-pick-13', 'RELEASE.md', null, prompt('fenghuiyu', '/wrong/place'), 'fenghuiyu')).toBe('/home/fenghuiyu/RELEASE.md')
  })

  it('多段相对路径 × 提示符 cwd（cd 后点相对路径的同族修复）', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/project/6080/docs/a.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    expect(await pickRemoteDocPath('ls-pick-14', 'docs/a.md', null, prompt('fenghuiyu', '~/project/6080'), 'fenghuiyu')).toBe('/home/fenghuiyu/project/6080/docs/a.md')
  })

  it('~/ 前缀路径自身按登录目录展开成 stat 可用候选', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/docs/notes.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    expect(await pickRemoteDocPath('ls-pick-15', '~/docs/notes.md', null, null)).toBe('/home/fenghuiyu/docs/notes.md')
  })

  it('~/ 前缀路径 + 提示符用户 ≠ 会话用户：~ 仍按登录 home 展开（不追提示符用户）', async () => {
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/docs/notes.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    // 读取跟随登录用户：点击路径里的 ~ 一律按登录 home（filePwd）展开，
    // 提示符里的 su 身份不改变它
    expect(await pickRemoteDocPath('ls-pick-16', '~/docs/notes.md', null, prompt('test', '~/test'), 'fenghuiyu')).toBe('/home/fenghuiyu/docs/notes.md')
  })

  it('ls 目录参数为反斜杠风格（Windows 远端 shell）时按反斜杠拼接', async () => {
    // posix 归并只按 / 切分：整段反斜杠 rel 作为单个段接上（混合分隔符形态，
    // Windows 远端侧可 stat）—— 候选至少不再被错误地用 / 拼接反斜杠目录
    setApi(p => Promise.resolve(
      p === '/home/fenghuiyu/project\\6080\\RELEASE.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    expect(await pickRemoteDocPath('ls-pick-17', 'RELEASE.md', 'project\\6080', null)).toBe('/home/fenghuiyu/project\\6080\\RELEASE.md')
  })

  it('ls 参数即文件本身（用户实际场景四：`ls foo.md` 输出裸名）→ 不作目录上下文，cwd 归并即正解', async () => {
    setApi(p => Promise.resolve(
      p === '/tmp/RELEASE_NOTES_v1.0.6.md'
        ? { success: true, data: { isDir: false } }
        : { success: false, error: 'No such file' }
    ))
    // 参数 foo.md 与点击裸名同名：不再拼出 foo.md/foo.md 候选
    expect(await pickRemoteDocPath('ls-pick-18', 'RELEASE_NOTES_v1.0.6.md', 'RELEASE_NOTES_v1.0.6.md', prompt('test', '/tmp'), 'fenghuiyu')).toBe('/tmp/RELEASE_NOTES_v1.0.6.md')
  })

  it('参数即文件本身 + stat 全未命中 → 兜底首选也是 cwd 归并路径（不是 foo.md/foo.md）', async () => {
    setApi(() => Promise.resolve({ success: false, error: 'No such file' }))
    expect(await pickRemoteDocPath('ls-pick-19', 'RELEASE_NOTES_v1.0.6.md', 'RELEASE_NOTES_v1.0.6.md', prompt('test', '/tmp'), 'fenghuiyu')).toBe('/tmp/RELEASE_NOTES_v1.0.6.md')
  })
})

describe('文档链接激活端到端：Ctrl+点击 ls 列表裸文件名（ssh 会话）', () => {
  type DocPayload = Extract<OverlayPayload, { kind: 'doc' }>

  /** 投影全部 doc 覆盖层（叶序 × 引用序） */
  const docOverlayViews = (): { paneId: string; payload: DocPayload }[] => {
    const st = usePaneStore.getState()
    const out: { paneId: string; payload: DocPayload }[] = []
    for (const pane of st.getAllLeafPanes()) {
      for (const r of pane.overlays) {
        const p = st.overlayPayloads[r.id]
        if (r.kind === 'doc' && p?.kind === 'doc') out.push({ paneId: pane.id, payload: p })
      }
    }
    return out
  }

  beforeEach(() => {
    const leafNode: PaneLeaf = {
      id: 'pane-ssh', type: 'leaf', sessions: ['sess-ssh'],
      activeSessionId: 'sess-ssh', overlays: []
    }
    const layout: PaneLayout = { root: leafNode, activePaneId: 'pane-ssh' }
    usePaneStore.setState({ layout, overlayPayloads: {}, draggingOverlayId: null, hiddenTabSessions: {} })
    useSessionStore.setState({
      sessions: [{
        id: 'sess-ssh',
        // 会话以 fenghuiyu 连接（filePwd 走它的独立连接 → /home/fenghuiyu）
        config: { id: 'sess-ssh', name: 'ssh-test', type: 'ssh', tags: [], ssh: { host: 'docker-IPS', port: 22, username: 'fenghuiyu' } } as unknown as SessionConfig,
        status: ConnectionStatus.CONNECTED
      }]
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      filePwd: () => Promise.resolve({ success: true, data: '/home/fenghuiyu' }),
      fileStat: (_s: string, p: string) => Promise.resolve(
        ['/home/fenghuiyu/project/6080/RELEASE_NOTES_v1.0.6.md', '/home/test/test/RELEASE_NOTES_v1.0.6.md', '/tmp/RELEASE_NOTES_v1.0.6.md'].includes(p)
          ? { success: true, data: { isDir: false } }
          : { success: false, error: 'No such file' }
      ),
      fileReadDoc: (_s: string, p: string) => Promise.resolve(
        ['/home/fenghuiyu/project/6080/RELEASE_NOTES_v1.0.6.md', '/home/test/test/RELEASE_NOTES_v1.0.6.md', '/tmp/RELEASE_NOTES_v1.0.6.md'].includes(p)
          ? { success: true, data: { content: '# v1.0.6', size: 7, mtime: 1, encoding: 'utf-8' } }
          : { success: false, error: 'No such file' }
      )
    }
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('用户实际场景：多列 ls 列表里的裸文件名 → stat 命中 ls 目录候选，开文档页签', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'fenghuiyu@docker-IPS:~$ ls project/6080/\r\nNGIPS6080SP2              RELEASE_NOTES_v1.0.6.md\r\n')
      const provider = createDocLinkProvider(t, 'sess-ssh')
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(2, ls => resolve(ls ?? [])))
      const link = links.find(l => l.text === 'RELEASE_NOTES_v1.0.6.md')
      expect(link).toBeDefined()
      // Ctrl+点击开文档页签（openRemoteDoc 异步落页签，waitFor 轮询等挂载）
      link!.activate?.(new MouseEvent('click', { ctrlKey: true }), link!.text)
      await vi.waitFor(() => {
        expect(docOverlayViews()).toHaveLength(1)
      })
      const [view] = docOverlayViews()
      expect(view.paneId).toBe('pane-ssh')
      // 修复点：拼上 ls 命令行的目录，而不是丢掉 project/6080/ 直接并 cwd
      expect(view.payload.path).toBe('/home/fenghuiyu/project/6080/RELEASE_NOTES_v1.0.6.md')
      expect(view.payload.content).toBe('# v1.0.6')
      expect(view.payload.loadError).toBeUndefined()
    } finally {
      t.dispose()
    }
  })

  it('用户实际场景二：ls 无参、提示符含 cd 后的 cwd → 提示符 cwd 候选命中', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'fenghuiyu@docker-IPS:~/project/6080$ ls\r\nNGIPS6080SP2              RELEASE_NOTES_v1.0.6.md\r\n')
      const provider = createDocLinkProvider(t, 'sess-ssh')
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(2, ls => resolve(ls ?? [])))
      const link = links.find(l => l.text === 'RELEASE_NOTES_v1.0.6.md')
      expect(link).toBeDefined()
      link!.activate?.(new MouseEvent('click', { ctrlKey: true }), link!.text)
      await vi.waitFor(() => {
        expect(docOverlayViews()).toHaveLength(1)
      })
      const [view] = docOverlayViews()
      // 修复点：交互 shell cd 到 ~/project/6080 后，裸名按提示符 cwd 归并
      // （filePwd 的登录目录 /home/fenghuiyu 下并无该文件）
      expect(view.payload.path).toBe('/home/fenghuiyu/project/6080/RELEASE_NOTES_v1.0.6.md')
      expect(view.payload.loadError).toBeUndefined()
    } finally {
      t.dispose()
    }
  })

  it('用户实际场景三（换用户）：终端 su 到 test 后 ls → 读取跟随登录用户，按登录 home 归并，读不到出显式错误', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'test@docker-IPS:~/test$ ls\r\nRELEASE_NOTES_v1.0.6.md\r\ntest@docker-IPS:~/test$ pwd\r\n/home/test/test\r\n')
      const provider = createDocLinkProvider(t, 'sess-ssh')
      // 点第 2 行列表里的裸文件名（1-based：1=提示符命令行 2=列表）
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(2, ls => resolve(ls ?? [])))
      const link = links.find(l => l.text === 'RELEASE_NOTES_v1.0.6.md')
      expect(link).toBeDefined()
      link!.activate?.(new MouseEvent('click', { ctrlKey: true }), link!.text)
      await vi.waitFor(() => {
        expect(docOverlayViews()).toHaveLength(1)
      })
      const [view] = docOverlayViews()
      // 读取跟随登录用户：会话以 fenghuiyu 连接，终端里 su 到 test —— ~/test
      // 的 ~ 形态提示符 cwd 属于 test，登录用户解释不了，弃用退回登录 home
      // 归并（stat 全未命中取首选候选）。文件实际在 /home/test/test，读不到
      // 是显式报错而非追错身份 —— 换身份读取请直连目标环境（独立会话）
      expect(view.payload.path).toBe('/home/fenghuiyu/RELEASE_NOTES_v1.0.6.md')
      expect(view.payload.loadError).toBe('No such file')
    } finally {
      t.dispose()
    }
  })

  it('用户实际场景五：绝对路径输出行（`ls /tmp/x.md` 的输出）→ 透传直读', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'test@docker-IPS:~$ ls /tmp/RELEASE_NOTES_v1.0.6.md\r\n/tmp/RELEASE_NOTES_v1.0.6.md\r\n')
      const provider = createDocLinkProvider(t, 'sess-ssh')
      // 点第 2 行输出里的绝对路径（1-based：1=命令行 2=输出）
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(2, ls => resolve(ls ?? [])))
      const link = links.find(l => l.text === '/tmp/RELEASE_NOTES_v1.0.6.md')
      expect(link).toBeDefined()
      link!.activate?.(new MouseEvent('click', { ctrlKey: true }), link!.text)
      await vi.waitFor(() => {
        expect(docOverlayViews()).toHaveLength(1)
      })
      const [view] = docOverlayViews()
      // 绝对路径无 cwd 参与，原样透传去读
      expect(view.payload.path).toBe('/tmp/RELEASE_NOTES_v1.0.6.md')
      expect(view.payload.content).toBe('# v1.0.6')
      expect(view.payload.loadError).toBeUndefined()
    } finally {
      t.dispose()
    }
  })

  it('用户实际场景六：root 提示符（绝对 cwd）+ `ls 相对目录` → cwd × ls 目录拼接', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'root@docker-IPS:/home/test# ls test\r\nRELEASE_NOTES_v1.0.6.md\r\n')
      const provider = createDocLinkProvider(t, 'sess-ssh')
      // 点第 2 行输出里的裸文件名（1-based：1=命令行 2=输出）
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(2, ls => resolve(ls ?? [])))
      const link = links.find(l => l.text === 'RELEASE_NOTES_v1.0.6.md')
      expect(link).toBeDefined()
      link!.activate?.(new MouseEvent('click', { ctrlKey: true }), link!.text)
      await vi.waitFor(() => {
        expect(docOverlayViews()).toHaveLength(1)
      })
      const [view] = docOverlayViews()
      // 路径解析：提示符 cwd /home/test（绝对形态）× ls 参数 test。
      // 提示符用户 root ≠ 会话用户 fenghuiyu 只影响读权限，不影响路径候选
      // （cwd 是绝对的，不经过 ~ 展开那套逻辑）
      expect(view.payload.path).toBe('/home/test/test/RELEASE_NOTES_v1.0.6.md')
      expect(view.payload.loadError).toBeUndefined()
    } finally {
      t.dispose()
    }
  })

  it('用户实际场景四：`ls foo.md`（参数即文件本身）→ 裸名按提示符 cwd 归并，不拼 foo.md/foo.md', async () => {
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'test@docker-IPS:/tmp$ ls RELEASE_NOTES_v1.0.6.md\r\nRELEASE_NOTES_v1.0.6.md\r\n')
      const provider = createDocLinkProvider(t, 'sess-ssh')
      // 点第 2 行输出里的裸文件名（1-based：1=命令行 2=输出）
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(2, ls => resolve(ls ?? [])))
      const link = links.find(l => l.text === 'RELEASE_NOTES_v1.0.6.md')
      expect(link).toBeDefined()
      link!.activate?.(new MouseEvent('click', { ctrlKey: true }), link!.text)
      await vi.waitFor(() => {
        expect(docOverlayViews()).toHaveLength(1)
      })
      const [view] = docOverlayViews()
      // 修复点：ls 的文件参数不再被当目录拼出
      // /tmp/RELEASE_NOTES_v1.0.6.md/RELEASE_NOTES_v1.0.6.md，直接 /tmp + 裸名
      expect(view.payload.path).toBe('/tmp/RELEASE_NOTES_v1.0.6.md')
      expect(view.payload.loadError).toBeUndefined()
    } finally {
      t.dispose()
    }
  })

  it('无从落定（filePwd 失败且无提示符行）：以原相对路径开错误页签而非静默无反应', async () => {
    const w = window as unknown as { electronAPI: unknown }
    w.electronAPI = {
      filePwd: () => Promise.resolve({ success: false, error: 'no connector' }),
      fileStat: () => Promise.resolve({ success: false }),
      fileReadDoc: () => Promise.resolve({ success: false, error: 'SFTP 会话不可用' })
    }
    const t = new Terminal({ cols: 200, rows: 10 })
    try {
      await writeAndDrain(t, 'RELEASE_NOTES_v1.0.6.md\r\n')
      const provider = createDocLinkProvider(t, 'sess-ssh')
      const links = await new Promise<ILink[]>(resolve => provider.provideLinks(1, ls => resolve(ls ?? [])))
      const link = links.find(l => l.text === 'RELEASE_NOTES_v1.0.6.md')
      expect(link).toBeDefined()
      link!.activate?.(new MouseEvent('click', { ctrlKey: true }), link!.text)
      // 修复点：不再静默无反应 —— 错误页签展示原路径与显式报错，可排查
      await vi.waitFor(() => {
        expect(docOverlayViews()).toHaveLength(1)
      })
      const [view] = docOverlayViews()
      expect(view.payload.path).toBe('RELEASE_NOTES_v1.0.6.md')
      expect(view.payload.loadError).toBe('SFTP 会话不可用')
    } finally {
      t.dispose()
    }
  })
})
