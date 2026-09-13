/**
 * 内置手册的 MCP 动态段 —— 手册 markdown 里三处占位,打开(/help)时按实例状态注入:
 *
 *  - <!-- lyshell:mcp-register -->       → 注册配置块(主/备选 JSON + Claude 命令 + Codex TOML,
 *                                         渲染层 CodeBlock 自带语言 chip 与复制钮)
 *  - {{MCP_TOGGLE_CONFIRM_DESTRUCTIVE}}  → 破坏性命令确认开关的动作链接(点击切换)
 *  - {{MCP_TOGGLE_ALLOW_METADATA_WRITE}}  → 会话备注写入开关的动作链接
 *
 * 原设置面板的 MCP 页签已删,这里是注册配置与这两个安全开关的唯一 UI。开关链接走
 * lyshell-action:// 动作链(与 /ls 清点文档同一机制,仅内置文档放行):href 携带手册
 * 语言(?lang=zh|en),切换后按语言原地换链接标签(swapMcpToggleLink),不重读整篇手册。
 *
 * 注入文案按手册语言维护在这里而非 locales —— 手册翻译自成体系(manual.*.md 双语),
 * 生成的短标签跟随同一体系;长说明文字直接写在手册文件里,这里只产动态部分。
 */

/** 手册语言(/help 的语言参数,与界面 locale 解耦) */
export type ManualLang = 'zh' | 'en'

/** 手册动作链接可切换的 MCP 安全开关 */
export type McpToggleId = 'confirmDestructive' | 'allowMetadataWrite'

/** security 配置里的持久化键 */
export type McpSecurityFlag = 'confirmDestructiveCommands' | 'allowSessionMetadataWrite'

const TOGGLE_FLAG_KEYS: Record<McpToggleId, McpSecurityFlag> = {
  confirmDestructive: 'confirmDestructiveCommands',
  allowMetadataWrite: 'allowSessionMetadataWrite'
}

/** 开关 → 动作 id(手册链接 href 与 doc-actions 路由共用) */
const TOGGLE_ACTION_IDS: Record<McpToggleId, string> = {
  confirmDestructive: 'mcp-toggle-confirm-destructive',
  allowMetadataWrite: 'mcp-toggle-allow-metadata-write'
}

/** 动作 id → 开关(doc-actions 的 isKnownAction / runDocAction 路由表) */
export const MCP_TOGGLE_ACTIONS: Record<string, McpToggleId> = {
  [TOGGLE_ACTION_IDS.confirmDestructive]: 'confirmDestructive',
  [TOGGLE_ACTION_IDS.allowMetadataWrite]: 'allowMetadataWrite'
}

/** 开关 → security 持久化键(doc-actions 翻转时取用) */
export const MCP_TOGGLE_FLAG_KEYS = TOGGLE_FLAG_KEYS

/** 注册段占位(HTML 注释,即使未经注入落地,渲染层也不可见) */
export const MCP_REGISTER_MARKER = '<!-- lyshell:mcp-register -->'
/** 两个开关的链接占位(打开路径总是先注入再挂页签,不会以占位原文渲染) */
export const MCP_TOGGLE_CONFIRM_PLACEHOLDER = '{{MCP_TOGGLE_CONFIRM_DESTRUCTIVE}}'
export const MCP_TOGGLE_METADATA_PLACEHOLDER = '{{MCP_TOGGLE_ALLOW_METADATA_WRITE}}'

/** 注入文案(按手册语言) */
const LABELS = {
  zh: {
    registerPrimary: '主配置 · 自带二进制（无需 Node）',
    registerFallback: '备选配置 · 系统 Node',
    registerClaude: 'Claude Code · 命令（终端运行）',
    registerCodex: 'Codex · config.toml（写入 ~/.codex/config.toml）',
    registerUnavailable: '注册配置不可用（MCP 服务端未启动或端口信息读取失败）',
    toggleOn: '✔ 已开启 · 点击关闭',
    toggleOff: '○ 已关闭 · 点击开启'
  },
  en: {
    registerPrimary: 'Primary config · bundled binary (no Node.js)',
    registerFallback: 'Fallback config · system Node.js',
    registerClaude: 'Claude Code · command (run in terminal)',
    registerCodex: 'Codex · config.toml (append to ~/.codex/config.toml)',
    registerUnavailable: 'Register config unavailable (MCP server not started or port info unreadable)',
    toggleOn: '✔ On — click to disable',
    toggleOff: '○ Off — click to enable'
  }
} as const

interface McpAddInfo {
  config: string
  systemNodeConfig?: string
  claudeCommand: string
  codexConfig: string
}

/** 读 MCP 注册信息;IPC 通道缺失/失败返回 null(渲染「不可用」占位) */
async function fetchMcpAddInfo(): Promise<McpAddInfo | null> {
  try {
    const info = await window.electronAPI?.getMcpAddCommand()
    if (info?.config) {
      return {
        config: info.config,
        systemNodeConfig: info.systemNodeConfig,
        claudeCommand: info.claudeCommand ?? '',
        codexConfig: info.codexConfig ?? ''
      }
    }
  } catch { /* 通道缺失(测试环境)/读取失败:按不可用渲染 */ }
  return null
}

/** 读 MCP 安全开关当前值;读取失败回退默认(与后端 DEFAULT_MCP_SECURITY 一致) */
export async function readMcpSecurityFlags(): Promise<Record<McpSecurityFlag, boolean>> {
  try {
    const raw = await window.electronAPI?.getConfig('security')
    const mcp = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).mcp : null
    if (mcp && typeof mcp === 'object') {
      const m = mcp as Record<string, unknown>
      return {
        // confirmDestructiveCommands 默认 true:仅显式 false 时关闭
        confirmDestructiveCommands: m.confirmDestructiveCommands !== false,
        allowSessionMetadataWrite: m.allowSessionMetadataWrite === true
      }
    }
  } catch { /* 读失败按默认值 */ }
  return { confirmDestructiveCommands: true, allowSessionMetadataWrite: false }
}

/**
 * 翻转一个 MCP 安全开关(读-合-写,保留 security 其余字段与 mcp 其余键),返回翻转后的值。
 * 与原设置面板开关的写路径完全同一条。
 */
export async function flipMcpSecurityFlag(flag: McpSecurityFlag): Promise<boolean> {
  const raw = await window.electronAPI?.getConfig('security')
  const security = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const existingMcp = security.mcp && typeof security.mcp === 'object'
    ? (security.mcp as Record<string, unknown>)
    : {}
  const current = flag === 'confirmDestructiveCommands'
    ? existingMcp.confirmDestructiveCommands !== false
    : existingMcp.allowSessionMetadataWrite === true
  const next = !current
  await window.electronAPI?.setConfig('security', {
    ...security,
    mcp: {
      ...existingMcp,
      [flag]: next
    }
  })
  return next
}

/** 开关动作链接 —— href 带 lang 参数,切换后按它原地换标签 */
export function buildMcpToggleLink(toggle: McpToggleId, lang: ManualLang, on: boolean): string {
  const l = LABELS[lang]
  return `[${on ? l.toggleOn : l.toggleOff}](lyshell-action://${TOGGLE_ACTION_IDS[toggle]}?lang=${lang})`
}

/** 链接标签原地换(切换后刷新已开手册页签):语言跟链接 href 自带的 lang 参数走 */
export function swapMcpToggleLink(content: string, toggle: McpToggleId, on: boolean): string {
  const re = new RegExp(`\\[[^\\]]*\\]\\(lyshell-action://${TOGGLE_ACTION_IDS[toggle]}\\?lang=(zh|en)\\)`, 'g')
  return content.replace(re, (_m, lang: string) => buildMcpToggleLink(toggle, lang === 'zh' ? 'zh' : 'en', on))
}

/** 注册段代码块 —— 标签行 + fenced code(CodeBlock 自带语言 chip 与复制钮) */
const registerBlock = (label: string, codeLang: string, code: string): string =>
  `**${label}**\n\n\`\`\`${codeLang}\n${code}\n\`\`\``

/** 生成注册段(主/备选 JSON + Claude 命令 + Codex TOML);不可用时单行占位 */
async function buildMcpRegisterBlock(lang: ManualLang): Promise<string> {
  const info = await fetchMcpAddInfo()
  if (!info) return LABELS[lang].registerUnavailable
  const l = LABELS[lang]
  return [
    registerBlock(l.registerPrimary, 'json', info.config),
    ...(info.systemNodeConfig ? [registerBlock(l.registerFallback, 'json', info.systemNodeConfig)] : []),
    registerBlock(l.registerClaude, 'bash', info.claudeCommand),
    registerBlock(l.registerCodex, 'toml', info.codexConfig)
  ].join('\n\n')
}

/**
 * 手册 MCP 段注入:三处占位 → 实例态内容。字符串替换一律用函数替换 —— 注册 JSON 里
 * 出现 `$&` 一类序列时字符串替换会被当替换模式吃掉。
 */
export async function injectManualMcp(content: string, lang: ManualLang): Promise<string> {
  const [registerBlockText, flags] = await Promise.all([buildMcpRegisterBlock(lang), readMcpSecurityFlags()])
  return content
    .replace(MCP_REGISTER_MARKER, () => registerBlockText)
    .replace(MCP_TOGGLE_CONFIRM_PLACEHOLDER, () => buildMcpToggleLink('confirmDestructive', lang, flags.confirmDestructiveCommands))
    .replace(MCP_TOGGLE_METADATA_PLACEHOLDER, () => buildMcpToggleLink('allowMetadataWrite', lang, flags.allowSessionMetadataWrite))
}
