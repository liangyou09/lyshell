// @vitest-environment jsdom
/**
 * link provider 端到端坐标测试：真实 xterm 实例写入文本 → createDocLinkProvider
 * 直调 provideLinks → 校验 range 的 1-based 列区间精确覆盖匹配文本。
 * 回归点：「- 文件名」弹点行不得把前导破折号/空格划进链接。
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import type { ILink } from '@xterm/xterm'
import { createDocLinkProvider, guessLocalCwd, findGroupDir } from './registerDocLinkProvider'

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
  { line: '见 D:\\docs\\report.html 详情', expectedText: 'D:\\docs\\report.html', expectedStartX: 4, expectedEndX: 22 }
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
