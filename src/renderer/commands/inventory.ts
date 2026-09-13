import { usePaneStore } from '../stores/pane-store'
import { useSessionStore, type SessionState } from '../stores/session-store'
import { ConnectionStatus } from '@shared/types'
import type { SessionConfig } from '@shared/types'
import type { HarnessEnvProfile, HarnessWorkspace } from '@shared/harness'
import type { PluginListItem } from '@shared/plugin-types'
import { DOC_ACTION_SCHEME } from './doc-actions'
import i18n from '../i18n'

/**
 * /ls 清点文档 —— 会话 / Agent / 变量组 / 三个 harness 工作区 / 插件的全量清单，
 * 或 `/ls <对象>` 的单节子清单（如 /ls env、/ls claude）。
 *
 * 数据在打开时聚合（大多为本地 IPC 快查），markdown 动态生成后以 builtin 文档
 * 页签承载（渲染管线复用 DocPanel：大纲轨 / 缩放 / 主题）。「新建」入口是
 * lyshell-action:// 动作链接（doc-actions 派发），各节都有。
 *
 * 内容是时点快照：重新运行 /ls 或点页签刷新按钮（readDoc.refreshDocTab 的
 * builtin 分支委托回这里）都会重新清点覆写。全量与各子清单是不同的文档身份，
 * 同 pane 并存互不覆写；刷新按页签自己的身份重聚，子清单的作用域不丢。
 */

/** 清点文档身份 —— openDocTab 的同 pane 复用键（见 readDoc 的 BUILTIN_HELP_PATH 注释）。
 *  子清单是独立身份 lyshell://inventory/<节> */
export const BUILTIN_INVENTORY_PATH = 'lyshell://inventory'

/** 子清单的七节：键即 /ls <对象> 的参数名与路径段，数组序 = 全量清点的排版序 */
export type InventorySection = 'sessions' | 'agents' | 'env' | 'dsh' | 'codex' | 'claude' | 'plugins'
export const SECTION_ORDER: InventorySection[] = ['sessions', 'agents', 'env', 'dsh', 'codex', 'claude', 'plugins']

/** 节参数别名表（键按小写匹配；规范名自身即别名，单复数同收） */
const SECTION_ALIASES: Record<string, InventorySection> = {
  sessions: 'sessions', session: 'sessions',
  agents: 'agents', agent: 'agents',
  env: 'env', envs: 'env',
  dsh: 'dsh', codex: 'codex', claude: 'claude',
  plugins: 'plugins', plugin: 'plugins'
}

/**
 * /ls 的对象参数解析：七节之一 = 子清单；undefined = 未带参数或显式 all（全量）；
 * null = 无法识别（调用方回显错误行列出可用值）。
 * 除别名外还收前缀速记：s/se… → sessions、d → dsh、co → codex；
 * c 是 codex/claude 的公共前缀，有歧义按未知处理。
 */
export function resolveInventorySection(args?: string): InventorySection | undefined | null {
  const a = args?.trim().toLowerCase()
  if (!a || a === 'all') return undefined
  if (SECTION_ALIASES[a]) return SECTION_ALIASES[a]
  const prefixed = SECTION_ORDER.filter(s => s.startsWith(a))
  return prefixed.length === 1 ? prefixed[0] : null
}

/** 清点文档身份 → 路径（全量 = 身份本体，子清单 = 身份/节） */
const inventoryPath = (section?: InventorySection): string =>
  section ? `${BUILTIN_INVENTORY_PATH}/${section}` : BUILTIN_INVENTORY_PATH

/** 是否任一形态的清点身份（全量或某节）—— readDoc.refreshDocTab 的委托判据 */
export const isInventoryDocPath = (path: string): boolean =>
  path === BUILTIN_INVENTORY_PATH || path.startsWith(`${BUILTIN_INVENTORY_PATH}/`)

/** 从清点身份解析节参数：全量身份或无法识别的段 → undefined（按全量重聚） */
const sectionFromPath = (path: string): InventorySection | undefined => {
  if (!path.startsWith(`${BUILTIN_INVENTORY_PATH}/`)) return undefined
  const key = path.slice(BUILTIN_INVENTORY_PATH.length + 1)
  return (SECTION_ORDER as readonly string[]).includes(key) ? key as InventorySection : undefined
}

/** Agent 面板的本地投影（preload 返回 unknown，就地把形状断言到这里；字段对齐主进程 AgentConfig） */
interface AgentSummary {
  id: string
  name: string
  command: string
  cwd?: string
  order: number
}

/** 清点数据 —— null = 该路 IPC 读取失败（对应节渲染失败标记，不静默当空表） */
export interface InventoryData {
  savedSessions: SessionConfig[]
  /** 运行时会话（含临时）：为 saved 条目聚合出连接状态，未关联 saved 的单独成行 */
  liveSessions: SessionState[]
  agents: AgentSummary[] | null
  envProfiles: HarnessEnvProfile[] | null
  /** 全局启用的变量组 id（env-profile:list 下发的单选指针） */
  activeProfileId: string | null
  plugins: PluginListItem[] | null
  dshWorkspaces: HarnessWorkspace[] | null
  codexWorkspaces: HarnessWorkspace[] | null
  claudeWorkspaces: HarnessWorkspace[] | null
}

// ─────────────────────────────────────────────────────────────────────────────
// markdown 生成（纯函数，单测直接喂合成数据）

/** 表格单元格转义：竖线断列、换行断行、反斜杠+方括号+< 断链接语法 —— 用户可控字符串
 *  （名称/类型/命令/目录/连接目标/runtime 等一切非生成器字段）原样落进内置文档的话，伪造的 [x](lyshell-action://…)
 *  会渲染成活的动作链接（内置来源双门禁都放行），点击即派发 —— mcp-toggle 一类
 *  安全开关动作尤其不能被这样触达。< 开启另一条语法路：尖括号 autolink
 *  <lyshell-action://…> 同样渲染成活链接（连 [x](…) 都不用写），一并转义。
 *  反斜杠必须最先转义：用户自带的 \ 会与注入的 \] 配对成 \\，让 ] 裸露回
 *  链接语法；> 不带语法角色（引用块是块级、表格内不成），不必转。
 *  换行折叠要收 \r:CommonMark 把单独的 \r 也当归一化行结束符,漏折叠会断开
 *  表格行,名称后半段落成块级内容(标题/列表/围栏,围栏未闭合能把整篇后半
 *  文档吞成代码块)——[\r\n] 全形态折叠,连 \n\r 之类的混排一并收掉。 */
const cell = (s: string | undefined | null): string =>
  (s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([[\]<])/g, '\\$1')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')

/** 行内「打开对象」链接:名称格可点,动作语义见 doc-actions.ts 文件头
 *  (会话/Agent 直连启动,变量组/工作区/插件切到对应面板)。
 *  id 侧 encodeURIComponent 会留下原始 ( ): 未配对的 ) 会在 markdown 层提前
 *  终结链接目的地(自己的链接被截断),一并换成 %28/%29 —— 解析侧 URLSearchParams
 *  会解码回原文,往返无损;[]</:?= 等链接成形字符 encodeURIComponent 本就转义 */
const openLink = (action: string, id: string, label: string): string =>
  `[${cell(label)}](${DOC_ACTION_SCHEME}${action}?id=${encodeURIComponent(id).replace(/\(/g, '%28').replace(/\)/g, '%29')})`

/** 会话连接目标的单行摘要（按类型取最关键的一格） */
function sessionTarget(c: SessionConfig): string {
  if (c.type === 'ssh' && c.ssh) return `${c.ssh.host}:${c.ssh.port}`
  if (c.type === 'telnet' && c.telnet) return `${c.telnet.host}:${c.telnet.port}`
  if (c.type === 'serial' && c.serial) return `${c.serial.path} @ ${c.serial.baudRate}`
  if (c.type === 'local') return c.local?.cwd || c.local?.shell || 'shell'
  return '—'
}

/** 运行态聚合：同属一个 saved 条目的多个 runtime 克隆取「最活跃」的状态 */
const STATUS_RANK: Record<ConnectionStatus, number> = {
  [ConnectionStatus.CONNECTED]: 4,
  [ConnectionStatus.RECONNECTING]: 3,
  [ConnectionStatus.CONNECTING]: 3,
  [ConnectionStatus.ERROR]: 2,
  [ConnectionStatus.DISCONNECTED]: 1
}

function liveStatusFor(savedId: string, live: SessionState[]): ConnectionStatus | null {
  let best: ConnectionStatus | null = null
  for (const s of live) {
    // 关联取两种形态（均已核实为「按设计」而非侥幸）:originSavedSessionId 是常规
    // 路径 —— 渲染层全部连接入口（会话列表/对话框/浮窗/doc-actions//local）都收敛到
    // launch.ts 的 connectSession 或 createLocalRuntimeConfig,id 恒清空,runtime id 由
    // createSession 的 `config.id || uuidv4()` 生成,恒为 UUID;s.id 直命只发生在主进程
    // 以非空 id 建会话时（如外部客户端经 MCP create_session 携带 saved id）—— 那一刻
    // 它就是在声明该 saved 会话,关联正是正确语义。UUID 无假命中面,不会误关联
    const linked = s.id === savedId || s.config.originSavedSessionId === savedId
    if (!linked) continue
    if (!best || STATUS_RANK[s.status] > STATUS_RANK[best]) best = s.status
  }
  return best
}

function statusWord(status: ConnectionStatus | null): string {
  const t = i18n.t.bind(i18n)
  switch (status) {
    case ConnectionStatus.CONNECTED: return t('commandBar.inventory.stConnected')
    case ConnectionStatus.CONNECTING: return t('commandBar.inventory.stConnecting')
    case ConnectionStatus.RECONNECTING: return t('commandBar.inventory.stReconnecting')
    case ConnectionStatus.ERROR: return t('commandBar.inventory.stError')
    default: return '—' // 无运行态（保存了但从没连）与 disconnected 一并显示为占位
  }
}

/** 单节骨架：标题行 + 表格/占位 + 动作链接（「新建」入口） */
function renderSection(title: string, table: string | null, actionHref: string, actionLabel: string): string {
  const body = table ?? `*${i18n.t('commandBar.inventory.empty')}*`
  return `## ${title}\n\n${body}\n\n**[${actionLabel}](${actionHref})**\n\n`
}

/**
 * 清点 markdown —— 纯函数：只消费传入数据与 i18n 文案。
 * 各节按「## 标题 · N → 表格 → ＋新建链接」的统一节奏排版；
 * section 参数只渲染该节（子清单），缺省按 SECTION_ORDER 渲染全部。
 */
export function buildInventoryMarkdown(data: InventoryData, section?: InventorySection): string {
  const t = i18n.t.bind(i18n)
  const inv = 'commandBar.inventory.'
  const stamp = new Date().toLocaleString()

  const out: string[] = []
  out.push(`# ${t(inv + 'h1')}${section ? ` · ${t(`nav.${section}`)}` : ''}`, '')
  out.push(`> ${t(inv + 'refreshedAt', { time: stamp, cmd: section ? `/ls ${section}` : '/ls' })}`, '')
  out.push(`> ${t(inv + 'openHint')}`, '')

  // ── 会话：saved 全列 + 未关联 saved 的运行中临时会话 ──
  // saved 行的名称可点(直连启动);临时行没有可再打开的落点,保持纯文本
  const buildSessions = (): void => {
    const savedRows = data.savedSessions.map(c =>
      `| ${openLink('open-session', c.id, c.name || c.id)} | ${cell(c.type)} | ${cell(sessionTarget(c))} | ${statusWord(liveStatusFor(c.id, data.liveSessions))} |`
    )
    const linkedIds = new Set(data.savedSessions.map(c => c.id))
    const tempRows = data.liveSessions
      .filter(s => !linkedIds.has(s.config.originSavedSessionId ?? '') && !linkedIds.has(s.id))
      .map(s => `| ${cell(s.config.name) + t(inv + 'tempSuffix')} | ${cell(s.config.type)} | ${cell(sessionTarget(s.config))} | ${statusWord(s.status)} |`)
    const sessionRows = [...savedRows, ...tempRows]
    out.push(renderSection(
      `${t('nav.sessions')} · ${sessionRows.length}`,
      sessionRows.length > 0
        ? `| ${t(inv + 'colName')} | ${t(inv + 'colType')} | ${t(inv + 'colTarget')} | ${t(inv + 'colStatus')} |\n| --- | --- | --- | --- |\n` + sessionRows.join('\n')
        : null,
      DOC_ACTION_SCHEME + 'new-session',
      t(inv + 'newSession')
    ))
  }

  // ── AI Agent ──
  const buildAgents = (): void => {
    const agents = data.agents
    out.push(renderSection(
      `${t('nav.agents')} · ${agents?.length ?? 0}`,
      agents && agents.length > 0
        ? `| ${t(inv + 'colName')} | ${t(inv + 'colCommand')} | ${t(inv + 'colWorkdir')} |\n| --- | --- | --- |\n` +
            [...agents].sort((a, b) => a.order - b.order)
              .map(a => `| ${openLink('open-agent', a.id, a.name)} | ${cell(a.command)} | ${cell(a.cwd) || '—'} |`).join('\n')
        : agents ? null : `*${t(inv + 'failed')}*`,
      DOC_ACTION_SCHEME + 'new-agent',
      t(inv + 'newAgent')
    ))
  }

  // ── 变量组：全局单选指针在名称上标记 ──
  const buildEnv = (): void => {
    const envs = data.envProfiles
    out.push(renderSection(
      `${t('nav.env')} · ${envs?.length ?? 0}`,
      envs && envs.length > 0
        ? `| ${t(inv + 'colName')} | ${t(inv + 'colBaseUrl')} | ${t(inv + 'colVars')} | ${t(inv + 'colKey')} |\n| --- | --- | --- | --- |\n` +
            [...envs].sort((a, b) => a.order - b.order)
              .map(p => {
                const active = p.id === data.activeProfileId ? ` **${t('env.activeBadge')}**` : ''
                const key = p.apiKey ? '✓' : '—'
                return `| ${openLink('open-env', p.id, p.name)}${active} | ${cell(p.baseUrl) || '—'} | ${t('env.vars', { count: Object.keys(p.env ?? {}).length })} | ${key} |`
              }).join('\n')
        : envs ? null : `*${t(inv + 'failed')}*`,
      DOC_ACTION_SCHEME + 'new-env',
      t(inv + 'newEnvProfile')
    ))
  }

  // ── 插件 ──
  const buildPlugins = (): void => {
    const plugins = data.plugins
    out.push(renderSection(
      `${t('nav.plugins')} · ${plugins?.length ?? 0}`,
      plugins && plugins.length > 0
        ? `| ${t(inv + 'colName')} | ${t(inv + 'colVersion')} | ${t(inv + 'colRuntime')} | ${t(inv + 'colLifecycle')} | ${t(inv + 'colState')} |\n| --- | --- | --- | --- | --- |\n` +
            plugins.map(p =>
              `| ${openLink('open-plugin', p.id, p.name + (p.dev ? ' dev' : ''))} | ${cell(p.version)} | ${cell(p.runtime)} | ${t(`plugin.lifecycle${p.lifecycle === 'oneshot' ? 'Oneshot' : 'Persistent'}`)} | ${p.enabled ? t('plugin.enabled') : t('plugin.disabled')} |`).join('\n')
        : plugins ? null : `*${t(inv + 'failed')}*`,
      DOC_ACTION_SCHEME + 'new-plugin',
      t(inv + 'newPlugin')
    ))
  }

  // ── 三个 harness 工作区（同一张表结构，kind 只差标题） ──
  const wsSection = (title: string, list: HarnessWorkspace[] | null, newAction: string, openAction: string): string => {
    return renderSection(
      `${title} · ${list?.length ?? 0}`,
      list && list.length > 0
        ? `| ${t(inv + 'colName')} | ${t(inv + 'colWorkdir')} | ${t(inv + 'colModel')} | ${t(inv + 'colIsolation')} |\n| --- | --- | --- | --- |\n` +
            [...list].sort((a, b) => a.order - b.order)
              .map(w => `| ${openLink(openAction, w.id, w.name)} | ${cell(w.cwd)} | ${cell(w.model) || '—'} | ${w.isolation === 'worktree' ? t(inv + 'isoWorktree') : t(inv + 'isoShared')} |`).join('\n')
        : list ? null : `*${t(inv + 'failed')}*`,
      DOC_ACTION_SCHEME + newAction,
      t(inv + 'newWorkspace')
    )
  }
  const builders: Record<InventorySection, () => void> = {
    sessions: buildSessions,
    agents: buildAgents,
    env: buildEnv,
    dsh: () => out.push(wsSection(`${t('nav.dsh')} · ${t('dsh.wsHeader')}`, data.dshWorkspaces, 'new-dsh', 'open-dsh')),
    codex: () => out.push(wsSection(`${t('nav.codex')} · ${t('dsh.wsHeader')}`, data.codexWorkspaces, 'new-codex', 'open-codex')),
    claude: () => out.push(wsSection(`${t('nav.claude')} · ${t('dsh.wsHeader')}`, data.claudeWorkspaces, 'new-claude', 'open-claude')),
    plugins: buildPlugins
  }
  for (const s of section ? [section] : SECTION_ORDER) builders[s]()

  return out.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据聚合与页签开/刷

/** 聚合清点数据：会话从 store 快照（同步），其余走本地 IPC 快查（失败置 null） */
async function gatherInventory(): Promise<InventoryData> {
  const sessionSnapshot = useSessionStore.getState()
  const [agents, envLibrary, plugins, dsh, codex, claude] = await Promise.all([
    window.electronAPI?.listAgents().catch(() => null),
    window.electronAPI?.listEnvProfiles().catch(() => null),
    window.electronAPI?.listPlugins().catch(() => null),
    window.electronAPI?.listDshWorkspaces().catch(() => null),
    window.electronAPI?.listCodexWorkspaces().catch(() => null),
    window.electronAPI?.listClaudeWorkspaces().catch(() => null)
  ])
  return {
    savedSessions: sessionSnapshot.savedSessions,
    liveSessions: sessionSnapshot.sessions,
    agents: Array.isArray(agents) ? (agents as AgentSummary[]) : null,
    envProfiles: envLibrary && Array.isArray((envLibrary as { profiles?: unknown }).profiles)
      ? (envLibrary as { profiles: HarnessEnvProfile[] }).profiles
      : null,
    activeProfileId: envLibrary && typeof (envLibrary as { activeProfileId?: unknown }).activeProfileId === 'string'
      ? (envLibrary as { activeProfileId: string }).activeProfileId
      : null,
    plugins: Array.isArray(plugins) ? (plugins as PluginListItem[]) : null,
    dshWorkspaces: Array.isArray(dsh) ? (dsh as HarnessWorkspace[]) : null,
    codexWorkspaces: Array.isArray(codex) ? (codex as HarnessWorkspace[]) : null,
    claudeWorkspaces: Array.isArray(claude) ? (claude as HarnessWorkspace[]) : null
  }
}

/** 刷新竞态守卫（页签 id → 自增版本）：同页签连点 /ls 或刷新时，旧聚合响应不得覆盖新一轮 */
const inventoryVersions = new Map<string, number>()

// 页签关闭即同步删除版本项（与 readDoc 的 readVersions 订阅同一形态）
usePaneStore.subscribe((state, prev) => {
  if (state.overlayPayloads === prev.overlayPayloads) return
  for (const id of inventoryVersions.keys()) {
    if (!state.overlayPayloads[id]) inventoryVersions.delete(id)
  }
})

/**
 * 打开清点文档（/ls 命令入口，section = `/ls <对象>` 的子清单形态）：先同步开页签
 * 让用户立刻看到落点（占位内容），聚合完成后再覆写 —— run() 是同步回显，异步聚合
 * 只能先行开表。同 pane 重复打开复用页签（openDocTab 无 readVersion = 无条件覆写）；
 * 全量与各子清单是不同身份，并存互不覆写。
 */
export function openInventoryDoc(paneId?: string, section?: InventorySection): string {
  const id = usePaneStore.getState().openDocTab(paneId, {
    source: 'builtin',
    docKind: 'markdown',
    path: inventoryPath(section),
    // 子清单标题带范围，与全量页签共存时一眼可辨
    title: section
      ? `${i18n.t('commandBar.inventory.title')} · ${i18n.t(`nav.${section}`)}`
      : i18n.t('commandBar.inventory.title'),
    size: 0,
    mtime: 0, // 非文件，无修改时间；DocHeader 对 0 隐藏该项
    content: `# ${i18n.t('commandBar.inventory.loading')}\n`
  })
  void refreshInventoryDoc(id)
  return id
}

/** 重新清点并覆写已有页签（重跑 /ls 的覆写路径与页签刷新按钮共用）；
 *  节参数取自页签当前身份，刷新按钮因此能保持子清单的作用域 */
export async function refreshInventoryDoc(id: string): Promise<void> {
  const version = (inventoryVersions.get(id) ?? 0) + 1
  inventoryVersions.set(id, version)
  const data = await gatherInventory()
  // 页签已关 / 已被换内容，或已被更新一轮的 /ls 刷新取代：丢弃旧响应
  const cur = usePaneStore.getState().getOverlayPayload(id)
  if (!cur || cur.kind !== 'doc' || !isInventoryDocPath(cur.path)) return
  if (inventoryVersions.get(id) !== version) return
  const content = buildInventoryMarkdown(data, sectionFromPath(cur.path))
  usePaneStore.getState().updateDocTab(id, { content, size: content.length })
}
