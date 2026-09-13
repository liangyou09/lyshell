// @vitest-environment jsdom
/**
 * manualMcp 单测 —— 手册 MCP 动态段(设置面板 MCP 页签移入手册后的唯一 MCP UI):
 *   注入   注册段(注册信息可得/不可得、备选缺失省略、$ 序列安全)+ 两个开关链接(状态+语言)
 *   翻转   flipMcpSecurityFlag 读-合-写保序,返回翻转后的值
 *   换标签 applyMcpToggleToOpenHelpTabs 只动手册页签,语言跟链接 href 的 lang 参数走
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  injectManualMcp,
  buildMcpToggleLink,
  flipMcpSecurityFlag,
  MCP_REGISTER_MARKER,
  MCP_TOGGLE_CONFIRM_PLACEHOLDER,
  MCP_TOGGLE_METADATA_PLACEHOLDER
} from './manualMcp'
import { applyMcpToggleToOpenHelpTabs, BUILTIN_HELP_PATH } from './readDoc'
import { usePaneStore } from '../../stores/pane-store'
import type { DocOverlayPayload, OverlayPayload, OverlayRef, PaneLeaf } from '@shared/types'

const getConfig = vi.fn()
const setConfig = vi.fn()
const getMcpAddCommand = vi.fn()

const leaf = (overlays: OverlayRef[]): PaneLeaf => ({
  id: 'pane-1',
  type: 'leaf',
  sessions: ['s-a'],
  activeSessionId: 's-a',
  overlays
})

/** 挂一个 doc 页签到 pane-1(payload 字典 + 树引用同步构造) */
const mountDoc = (id: string, payload: DocOverlayPayload): void => {
  const st = usePaneStore.getState()
  const prevLayout = st.layout
  usePaneStore.setState({
    layout: {
      ...prevLayout,
      root: leaf([{ id, kind: 'doc', active: true, slot: null }])
    },
    overlayPayloads: {
      ...st.overlayPayloads,
      [id]: { kind: 'doc', ...payload } as OverlayPayload
    }
  })
}

beforeEach(() => {
  getConfig.mockReset()
  setConfig.mockReset().mockResolvedValue(undefined)
  getMcpAddCommand.mockReset()
  usePaneStore.setState({
    layout: { root: leaf([]), activePaneId: 'pane-1' },
    overlayPayloads: {}
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    getConfig,
    setConfig,
    getMcpAddCommand
  }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('buildMcpToggleLink', () => {
  it('开关状态进标签,href 携带手册语言(切换后按它原地换标签)', () => {
    const zhOn = buildMcpToggleLink('confirmDestructive', 'zh', true)
    expect(zhOn).toBe('[✔ 已开启 · 点击关闭](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)')
    const zhOff = buildMcpToggleLink('confirmDestructive', 'zh', false)
    expect(zhOff).toBe('[○ 已关闭 · 点击开启](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)')
    const enOn = buildMcpToggleLink('allowMetadataWrite', 'en', true)
    expect(enOn).toBe('[✔ On — click to disable](lyshell-action://mcp-toggle-allow-metadata-write?lang=en)')
  })
})

describe('injectManualMcp', () => {
  const base = [
    '### 注册',
    MCP_REGISTER_MARKER,
    '### 安全机制',
    `- **破坏性命令执行前确认** —— ${MCP_TOGGLE_CONFIRM_PLACEHOLDER}：对疑似灾难性命令弹窗确认`,
    `- **允许 MCP 写入会话备注** —— ${MCP_TOGGLE_METADATA_PLACEHOLDER}：仅对外部客户端生效`
  ].join('\n\n')

  it('注册信息可得:占位符换成带语言围栏的代码块,开关链接按当前状态生成', async () => {
    getMcpAddCommand.mockResolvedValue({
      config: '{"mcpServers":{"lyshell":{"command":"lyshell$&"}}}',
      systemNodeConfig: '{"mcpServers":{"lyshell":{"command":"node"}}}',
      claudeCommand: 'claude mcp add lyshell',
      codexConfig: '[mcp_servers.lyshell]'
    })
    getConfig.mockResolvedValue({
      mcp: { allowSessionMetadataWrite: true, confirmDestructiveCommands: false }
    })

    const out = await injectManualMcp(base, 'zh')

    // 注册段:主/备选 JSON(带 $& 的内容按原文保留,不当替换模式吃掉)+ Claude/Codex
    expect(out).not.toContain(MCP_REGISTER_MARKER)
    expect(out).toContain('**主配置 · 自带二进制（无需 Node）**')
    expect(out).toContain('```json\n{"mcpServers":{"lyshell":{"command":"lyshell$&"}}}\n```')
    expect(out).toContain('**备选配置 · 系统 Node**')
    expect(out).toContain('**Claude Code · 命令（终端运行）**')
    expect(out).toContain('```bash\nclaude mcp add lyshell\n```')
    expect(out).toContain('**Codex · config.toml（写入 ~/.codex/config.toml）**')
    expect(out).toContain('```toml\n[mcp_servers.lyshell]\n```')
    // 开关链接:confirm=false → 关,metadata=true → 开
    expect(out).toContain('[○ 已关闭 · 点击开启](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)')
    expect(out).toContain('[✔ 已开启 · 点击关闭](lyshell-action://mcp-toggle-allow-metadata-write?lang=zh)')
    expect(out).not.toContain(MCP_TOGGLE_CONFIRM_PLACEHOLDER)
    expect(out).not.toContain(MCP_TOGGLE_METADATA_PLACEHOLDER)
  })

  it('备选配置缺失时省略该块;en 手册用英文标签与 lang=en 链接', async () => {
    getMcpAddCommand.mockResolvedValue({
      config: '{}',
      claudeCommand: 'claude',
      codexConfig: '[x]'
    })
    getConfig.mockResolvedValue(undefined)

    const out = await injectManualMcp(base, 'en')

    expect(out).not.toContain('Fallback config')
    expect(out).toContain('**Primary config · bundled binary (no Node.js)**')
    // security 读不到 → 默认态(confirm=true / metadata=false)
    expect(out).toContain('[✔ On — click to disable](lyshell-action://mcp-toggle-confirm-destructive?lang=en)')
    expect(out).toContain('[○ Off — click to enable](lyshell-action://mcp-toggle-allow-metadata-write?lang=en)')
  })

  it('注册信息不可得:单行占位,开关链接照常注入', async () => {
    getMcpAddCommand.mockRejectedValue(new Error('no port file'))
    getConfig.mockResolvedValue({})

    const out = await injectManualMcp(base, 'zh')

    expect(out).toContain('注册配置不可用')
    expect(out).toContain('lyshell-action://mcp-toggle-confirm-destructive?lang=zh')
  })
})

describe('flipMcpSecurityFlag', () => {
  it('读-合-写:保留 security 其余字段与 mcp 其余键,返回翻转后的值', async () => {
    getConfig.mockResolvedValue({
      mcp: { allowSessionMetadataWrite: false, confirmDestructiveCommands: true },
      unrelated: 'keep'
    })

    const next = await flipMcpSecurityFlag('allowSessionMetadataWrite')

    expect(next).toBe(true)
    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(setConfig).toHaveBeenCalledWith('security', {
      mcp: { allowSessionMetadataWrite: true, confirmDestructiveCommands: true },
      unrelated: 'keep'
    })
  })

  it('confirmDestructiveCommands 默认 true:配置缺失时翻成 false', async () => {
    getConfig.mockResolvedValue({ mcp: {} })

    const next = await flipMcpSecurityFlag('confirmDestructiveCommands')

    expect(next).toBe(false)
    expect(setConfig).toHaveBeenCalledWith('security', {
      mcp: { confirmDestructiveCommands: false }
    })
  })
})

describe('applyMcpToggleToOpenHelpTabs', () => {
  const zhDoc = (content: string): DocOverlayPayload => ({
    source: 'builtin',
    docKind: 'markdown',
    path: BUILTIN_HELP_PATH,
    title: 'help',
    size: content.length,
    mtime: 0,
    content
  })

  it('只换手册页签里该开关的链接:zh/en 各自保持语言,另一开关与其他文档不动', () => {
    const zhLinkOff = buildMcpToggleLink('confirmDestructive', 'zh', false)
    const enLinkOff = buildMcpToggleLink('confirmDestructive', 'en', false)
    const zhMetaOn = buildMcpToggleLink('allowMetadataWrite', 'zh', true)
    const zhContent = `安全\n${zhLinkOff}\n${zhMetaOn}`
    const enContent = `Security\n${enLinkOff}`
    mountDoc('doc-zh', zhDoc(zhContent))
    mountDoc('doc-en', zhDoc(enContent))
    // 非手册文档(本地来源 + 非 help 路径):不得被动
    mountDoc('doc-other', {
      source: 'local',
      docKind: 'markdown',
      path: 'D:\\a.md',
      title: 'a.md',
      size: zhContent.length,
      mtime: 1,
      content: zhContent
    })

    applyMcpToggleToOpenHelpTabs('confirmDestructive', true)

    const payloads = usePaneStore.getState().overlayPayloads
    const zh = payloads['doc-zh']
    const en = payloads['doc-en']
    const other = payloads['doc-other']
    if (zh?.kind !== 'doc' || en?.kind !== 'doc' || other?.kind !== 'doc') throw new Error('doc payload expected')
    // 目标开关:两份手册都换成开,语言各随其 href 的 lang 参数
    expect(zh.content).toContain('[✔ 已开启 · 点击关闭](lyshell-action://mcp-toggle-confirm-destructive?lang=zh)')
    expect(en.content).toContain('[✔ On — click to disable](lyshell-action://mcp-toggle-confirm-destructive?lang=en)')
    expect(zh.content).not.toContain('已关闭')
    // 另一开关、其他文档原样
    expect(zh.content).toContain(zhMetaOn)
    expect(other.content).toBe(zhContent)
    // size 跟随新内容
    expect(zh.size).toBe(zh.content.length)
  })

  it('链接已是目标状态时不写 payload(无谓的字典写会触发全量订阅重渲染)', () => {
    const link = buildMcpToggleLink('confirmDestructive', 'zh', true)
    mountDoc('doc-zh', zhDoc(`安全\n${link}`))
    const before = usePaneStore.getState().overlayPayloads

    applyMcpToggleToOpenHelpTabs('confirmDestructive', true)

    // 同引用 = 未产生新字典
    expect(usePaneStore.getState().overlayPayloads).toBe(before)
  })
})
