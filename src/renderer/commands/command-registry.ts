import { DEFAULT_THEME_DARK } from '@shared/constants'
import { ConnectionType } from '@shared/types'
import type { SessionConfig } from '@shared/types'
import { useUiStore } from '../stores/ui-store'
import i18n from '../i18n'
import type { NavTab } from '../components/Layout/ActivityRail'
import { dispatchNavigate } from './navigate'
import { openBuiltinHelpDoc } from '../components/DocPanel/readDoc'
import { openInventoryDoc, resolveInventorySection, SECTION_ORDER } from './inventory'

// 页签切换事件挪到叶子模块 navigate.ts(见该文件头注释),此处 re-export 保住
// 既有引用方(MainWindow / 测试)的导入路径
export { NAV_EVENT } from './navigate'

/**
 * 命令集注册表 —— 斜杠命令(/help、/new…)的唯一事实来源。
 *
 * 纯数据 + 纯函数,不依赖 React:匹配/查找可单测,UI(CommandScreen)只负责
 * 渲染命令目录与把回车路由到 run()。加一条命令 = 往 COMMANDS 加一个条目,
 * 目录 / 过滤 / 帮助输出全部自动跟进。
 *
 * run() 的返回值是执行后回显到 TUI 输出区的一行(经 i18n 已译,空态/面板共用);
 * 命令与 MainWindow 的通信沿用 window CustomEvent 解耦(先例:MCP
 * open_connection_dialog);跨组件打开对话框走 ui-store(见 ui-store.ts 头注释)。
 */

/** 参数候选(命令屏目录用):value = 补进输入的参数词,descriptionKey = 目录行的描述 */
export interface CommandArgCandidate {
  value: string
  descriptionKey: string
}

export interface CommandEntry {
  /** 命令名,不带斜杠(注册表内统一 'help' 而非 '/help') */
  name: string
  /** 描述的 i18n key(CommandScreen 里 t() 渲染) */
  descriptionKey: string
  /** 全局面板(overlay)形态下执行后直接关闭面板 —— 用于结果要"露出来"的命令(如 /local 长出终端、/help 落手册页签) */
  closeOverlay?: boolean
  /** 参数目录:命令带参数时列出候选 —— 输入进入参数区后命令屏的候选列表切换为它
   *  (当前 /help、/ls);未声明 = 带参输入不进目录模式(执行仍按原文路由) */
  argCandidates?: CommandArgCandidate[]
  /** 执行;args = 输入里命令名之后的参数原文(保留大小写,已 trim,见 splitCommand),
   *  当前 /help(语言)与 /ls(对象)消费,其余命令忽略多余参数;
   *  返回值 = 回显行(已译),void = 无回显 */
  run: (args?: string) => string | void
}

/** /local 的临时会话配置:id 空 = 主进程按临时会话处理不落盘(handlers.ts connection:connect) */
function createLocalRuntimeConfig(): SessionConfig {
  // terminal 默认值对齐 SessionDialog.handleSubmit 的新建路径
  return {
    id: '',
    name: 'Local Terminal',
    type: ConnectionType.LOCAL,
    tags: [],
    terminal: {
      fontSize: 14,
      fontFamily: 'Consolas, Monaco, monospace',
      theme: DEFAULT_THEME_DARK,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 10000,
      encoding: 'utf-8'
    },
    createdAt: new Date(),
    updatedAt: new Date()
  }
}

/** 导航命令工厂:派发页签切换事件,回显「已切换到 X」 */
const navCommand = (tab: NavTab, descriptionKey: string): CommandEntry => ({
  name: tab,
  descriptionKey,
  run: () => {
    dispatchNavigate(tab)
    return i18n.t('commandBar.out.nav', { panel: i18n.t(`nav.${tab}`) })
  }
})

/** /help 语言参数的别名表(键按小写匹配) */
const HELP_LANG_ALIASES: Record<string, 'zh' | 'en'> = {
  zh: 'zh', cn: 'zh', chinese: 'zh', '中文': 'zh',
  en: 'en', english: 'en'
}

/**
 * /help 的语言参数解析:'zh' | 'en' = 显式语言;undefined = 未带参数(随应用界面语言);
 * null = 无法识别(调用方回显错误行)。
 * 除别名外还收前缀速记:c/ch/chin… → chinese,e/en… → english(两词无公共前缀,不会歧义)。
 */
export function resolveHelpLanguage(args?: string): 'zh' | 'en' | undefined | null {
  const a = args?.trim().toLowerCase()
  if (!a) return undefined
  if (HELP_LANG_ALIASES[a]) return HELP_LANG_ALIASES[a]
  if ('chinese'.startsWith(a)) return 'zh'
  if ('english'.startsWith(a)) return 'en'
  return null
}

export const COMMANDS: CommandEntry[] = [
  {
    name: 'help',
    descriptionKey: 'commandBar.cmd.help',
    closeOverlay: true,  // 手册落在活动分屏的文档页签上,盖在下面的命令面板得让位
    argCandidates: [
      { value: 'chinese', descriptionKey: 'commandBar.helpArgZh' },
      { value: 'english', descriptionKey: 'commandBar.helpArgEn' }
    ],
    run: (args) => {
      const lang = resolveHelpLanguage(args)
      // 带了参数但不认识:像 shell 一样报错并保持原状(不开页签),错误行列出可用值。
      // null 只在 args 非空时出现(见 resolveHelpLanguage),故此处 lang 即参数原文
      if (lang === null) return i18n.t('commandBar.helpUnknownLang', { lang: args ?? '' })
      openBuiltinHelpDoc(undefined, lang)
      return i18n.t('commandBar.out.help')
    }
  },
  {
    // /? —— Windows CMD 传统:列出全部命令。输入 help、/?、/ 之一即实时展开
    // 完整目录(见 matchCommands 的别名);作为真命令,回车把清单打进输出区
    // (首行标题 + 一行一条、name 列对齐;带参数目录的命令缩进列出子命令行,
    // 简介与参数目录同源)。不设 closeOverlay:输出落在自身输出区,当场可读
    name: '?',
    descriptionKey: 'commandBar.cmd.listCommands',
    run: () => {
      const width = Math.max(...COMMANDS.map(c => c.name.length)) + 2
      // 首行标题:应用名 + 命令总数。「# 」前缀是 OutputBody 的抬头标记
      // (字距标签 + 细底线,标题文本本身词首大写),其后才是目录行
      const lines: string[] = [`# ${i18n.t('commandBar.catalogTitle', { total: COMMANDS.length })}`]
      for (const c of COMMANDS) {
        lines.push(`/${c.name.padEnd(width)}${i18n.t(c.descriptionKey)}`)
        // 子命令行:行首 4 空格缩进作标记(OutputBody 据此挂进父行组、渲染为
        // 树形勾线),参数词与简介都和参数目录同源 —— 印出来的就是输入 /ls 后能选到的
        for (const a of c.argCandidates ?? []) {
          lines.push(`    ${a.value.padEnd(width)}${i18n.t(a.descriptionKey)}`)
        }
      }
      return lines.join('\n')
    }
  },
  {
    name: 'new',
    descriptionKey: 'commandBar.cmd.new',
    closeOverlay: true,  // 对话框开在会话面板上,盖在终端区的命令面板得让位
    run: () => {
      // 先置请求再切页签:store 状态跨组件挂载存活,SessionsPanel 无论何时
      // 挂载都能读到存量请求并开对话框,消费后归零
      useUiStore.getState().requestCreateDialog('sessions')
      dispatchNavigate('sessions')
      return i18n.t('commandBar.out.new')
    }
  },
  {
    name: 'ls',
    descriptionKey: 'commandBar.cmd.ls',
    closeOverlay: true,  // 清单落在活动分屏的文档页签上,盖在下面的命令面板得让位
    // 参数目录与 resolveInventorySection 的规范名同源(SECTION_ORDER),另加显式 all
    argCandidates: [
      ...SECTION_ORDER.map(s => ({ value: s, descriptionKey: `nav.${s}` })),
      { value: 'all', descriptionKey: 'commandBar.inventory.scopeAll' }
    ],
    run: (args) => {
      const section = resolveInventorySection(args)
      // 带了参数但不认识:像 shell 一样报错并保持原状(不开页签),错误行列出可用值。
      // null 只在 args 非空时出现(见 resolveInventorySection),故此处 section 即参数原文
      if (section === null) return i18n.t('commandBar.lsUnknownSection', { section: args ?? '' })
      // 同步开占位页签、异步聚合数据覆写(inventory.ts);数据是时点快照,
      // 重跑即重新清点。section 非空 = 子清单,独立页签身份与全量并存
      openInventoryDoc(undefined, section)
      return i18n.t('commandBar.out.ls', {
        scope: section ? i18n.t(`nav.${section}`) : i18n.t('commandBar.inventory.scopeAll')
      })
    }
  },
  {
    name: 'local',
    descriptionKey: 'commandBar.cmd.local',
    closeOverlay: true,
    run: () => {
      // 连上后由 onConnectionStatus(连接中/已连接且不在任何 pane)自动挂到活动 pane
      void window.electronAPI?.connect(createLocalRuntimeConfig())
      return i18n.t('commandBar.out.local')
    }
  },
  navCommand('sessions', 'commandBar.cmd.sessions'),
  navCommand('agents', 'commandBar.cmd.agents'),
  navCommand('dsh', 'commandBar.cmd.dsh'),
  navCommand('codex', 'commandBar.cmd.codex'),
  navCommand('claude', 'commandBar.cmd.claude'),
  navCommand('env', 'commandBar.cmd.env'),
  navCommand('plugins', 'commandBar.cmd.plugins'),
  navCommand('web', 'commandBar.cmd.web'),
  navCommand('settings', 'commandBar.cmd.settings')
]

/**
 * 归一化查询:trim、去前导斜杠、小写 —— '/Help'、'help'、' /HELP ' 等价。
 */
export function normalizeQuery(query: string): string {
  const trimmed = query.trim().toLowerCase()
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
}

/**
 * 输入拆解:首个词 = 命令名(归一化),其余 = 参数原文(保留大小写,已 trim)。
 * '/help chinese' → { name: 'help', args: 'chinese' };'help' → { name: 'help' }。
 * 执行入口据此把带参输入路由到精确匹配的命令(候选列表按全串前缀过滤,带参时为空)。
 */
export function splitCommand(input: string): { name: string; args?: string } {
  const q = input.trim()
  if (!q) return { name: '' }
  const space = q.search(/\s/)
  if (space === -1) return { name: normalizeQuery(q) }
  const args = q.slice(space + 1).trim()
  return args ? { name: normalizeQuery(q.slice(0, space)), args } : { name: normalizeQuery(q.slice(0, space)) }
}

/**
 * 输入拆解(UI 目录用):与 splitCommand(执行拆解)同构,差别在尾随空白 ——
 * 命令名后只要按过空白就算进入参数区(args 可为空串,目录此刻展开完整参数候选),
 * 执行拆解会把空参吞掉(空参不路由、按无参命令执行)。
 * '/ls e' → { name:'ls', args:'e' };'/ls ' → { name:'ls', args:'' };'/ls' → { name:'ls' }。
 */
export function splitCommandUi(input: string): { name: string; args?: string } {
  const raw = input.trimStart()
  if (!raw) return { name: '' }
  const space = raw.search(/\s/)
  if (space === -1) return { name: normalizeQuery(raw) }
  return { name: normalizeQuery(raw.slice(0, space)), args: raw.slice(space + 1).trim() }
}

/**
 * 前缀匹配命令列表:空查询返回全部(空状态/面板展开即完整命令目录);
 * help / ? 是「列出全部命令」的传统别名(Windows CMD 的 help 与 /?),与空查询
 * 同义 —— 待命 ghost 提示承诺的三个入口(help、/?、/)行为一致;无匹配返回空
 * 数组(调用方据此渲染「无匹配」)。
 */
export function matchCommands(query: string): CommandEntry[] {
  const q = normalizeQuery(query)
  if (!q || q === 'help' || q === '?') return COMMANDS
  return COMMANDS.filter(c => c.name.startsWith(q))
}

/** 精确查找(执行回车时用),找不到返回 undefined */
export function findExact(name: string): CommandEntry | undefined {
  const q = normalizeQuery(name)
  return COMMANDS.find(c => c.name === q)
}

/** 编辑距离(Levenshtein)—— 参数目录错字兜底用;候选词都很短,O(mn) 毫无压力 */
function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,                                    // 删
        dp[i][j - 1] + 1,                                    // 增
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)   // 改
      )
    }
  }
  return dp[a.length][b.length]
}

/**
 * 参数目录过滤:已键参数先做前缀匹配(大小写不敏感);零前缀命中时回落到
 * 编辑距离 ≤2 的最近候选 —— 打错一两个字母仍落到想去的那条(sesion →
 * sessions)。参数太短(<3)不猜:单双字母离什么都很近,误命中率高;最近的
 * 并列多个时全部列出交 ↑↓ 挑,不擅自择一。
 */
export function filterArgCandidates(candidates: CommandArgCandidate[], arg: string): CommandArgCandidate[] {
  const a = arg.trim().toLowerCase()
  if (!a) return candidates
  const prefixed = candidates.filter(c => c.value.startsWith(a))
  if (prefixed.length > 0) return prefixed
  if (a.length < 3) return []
  const dists = candidates
    .map(c => ({ c, d: editDistance(a, c.value) }))
    .filter(x => x.d <= 2)
  if (dists.length === 0) return []
  const min = Math.min(...dists.map(x => x.d))
  return dists.filter(x => x.d === min).map(x => x.c)
}
