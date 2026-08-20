/**
 * 主进程 i18n（C3）。
 *
 * 渲染层用 i18next + localStorage；主进程的 MCP 确认弹窗无法访问 i18next，
 * 这里用一个极简的内联翻译表 + preferences 里的 locale 键。
 *
 * locale 来源优先级：
 *   1. preferences.locale（渲染层 setLocale 时经 setConfig 同步写入）
 *   2. 回退 'en'（与渲染层 DEFAULT_LOCALE_ID 一致）
 *
 * 只覆盖主进程实际出现的少量文案（MCP 弹窗）。新增主进程文案时在此补 key。
 */
import { preferencesRepository } from './storage/repository'

type Locale = 'zh' | 'en'

const MESSAGES: Record<Locale, Record<string, string>> = {
  zh: {
    'mcp.dialog.reject': '拒绝',
    'mcp.dialog.allowOnce': '允许一次',
    'mcp.dialog.highRiskTitle': 'MCP 高风险操作确认',
    'mcp.dialog.highRiskMessage': '允许 MCP 执行 {operation}？',
    'mcp.dialog.session': '会话',
    'mcp.dialog.content': '内容',
    'mcp.dialog.destructiveTitle': 'MCP 破坏性命令确认',
    'mcp.dialog.destructiveMessage': '允许 MCP 执行疑似破坏性命令？',
    'mcp.dialog.matchedRules': '命中规则',
    'mcp.dialog.explanation': '说明',
    'mcp.dialog.commandPreview': '命令预览',
    'mcp.dialog.firstNotesTitle': 'MCP 首次写入会话备注',
    'mcp.dialog.firstNotesMessage': '允许 MCP 首次为该会话写入摘要/说明/标签？'
  },
  en: {
    'mcp.dialog.reject': 'Reject',
    'mcp.dialog.allowOnce': 'Allow once',
    'mcp.dialog.highRiskTitle': 'MCP High-Risk Operation',
    'mcp.dialog.highRiskMessage': 'Allow MCP to execute {operation}?',
    'mcp.dialog.session': 'Session',
    'mcp.dialog.content': 'Content',
    'mcp.dialog.destructiveTitle': 'MCP Destructive Command',
    'mcp.dialog.destructiveMessage': 'Allow MCP to execute a likely-destructive command?',
    'mcp.dialog.matchedRules': 'Matched rules',
    'mcp.dialog.explanation': 'Explanation',
    'mcp.dialog.commandPreview': 'Command preview',
    'mcp.dialog.firstNotesTitle': 'MCP First Session-Notes Write',
    'mcp.dialog.firstNotesMessage': 'Allow MCP to write the summary/notes/tags for this session for the first time?'
  }
}

function getLocale(): Locale {
  try {
    const saved = preferencesRepository.get('locale')
    if (typeof saved === 'string') {
      if (saved.startsWith('zh')) return 'zh'
      if (saved.startsWith('en')) return 'en'
    }
  } catch {
    // preferences 未就绪（app 未 ready）—— 回退默认
  }
  return 'en'
}

/**
 * 翻译。{key} 占位符由 params 填充。未知 key 原样返回。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const table = MESSAGES[getLocale()] || MESSAGES.en
  let s = table[key] ?? MESSAGES.en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return s
}
