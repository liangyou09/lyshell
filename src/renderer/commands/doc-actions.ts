import { useUiStore, type CreateDialogPanel } from '../stores/ui-store'
import { useSessionStore } from '../stores/session-store'
import { dispatchNavigate } from './navigate'
import { connectSession } from './launch'
import { MCP_TOGGLE_ACTIONS, MCP_TOGGLE_FLAG_KEYS, flipMcpSecurityFlag } from '../components/DocPanel/manualMcp'
import { applyMcpToggleToOpenHelpTabs } from '../components/DocPanel/readDoc'

/**
 * 文档内动作链接 —— 可点入口,三类:
 *
 *  - 新建(lyshell-action://new-session 等):切面板 + 请求打开该面板的新建对话框
 *  - 打开(lyshell-action://open-session?id=… 等):把清单里的既有对象打开,语义随对象走:
 *      会话   → 直连启动(runtime 克隆,终端长在活动分屏,不切左栏)
 *      Agent  → 直连 launchAgent(与 AgentsPanel 行点击完全同一条链)
 *      变量组 → 切到 env 面板并打开该组的编辑对话框(内容长在面板里,须走面板)
 *      工作区 → 切到对应面板并启动该工作区(依赖检测/失败横幅都在面板上)
 *      插件   → 只切到 plugins 面板(插件没有「打开」语义,管理动作都在列表卡上)
 *  - MCP 开关(lyshell-action://mcp-toggle-… 等):/help 手册「MCP 集成」段的两个
 *      安全开关(设置面板 MCP 页签移入手册后的唯一开关 UI),翻转 security 配置
 *      并原地换已开手册页签的链接标签
 *
 * markdown 里以 `lyshell-action://<id>?<params>` 形态书写,MarkdownDoc 的链接渲染器
 * 拿到此前缀即走本模块派发,而不是当普通文档链接/只读外链。面板侧请求走 ui-store
 * (面板条件挂载也不丢),导航走 navigate.ts 的共用解耦通道。
 */

export const DOC_ACTION_SCHEME = 'lyshell-action://'

/** 已知动作表:动作 id → 目标面板 */
const CREATE_ACTIONS: Record<string, CreateDialogPanel> = {
  'new-session': 'sessions',
  'new-agent': 'agents',
  'new-env': 'env',
  'new-plugin': 'plugins',
  'new-dsh': 'dsh',
  'new-codex': 'codex',
  'new-claude': 'claude'
}

/** 「打开既有条目」动作表:动作 id → 目标面板(会话/Agent 不切面板,见文件头注释) */
const OPEN_ACTIONS: Record<string, CreateDialogPanel> = {
  'open-session': 'sessions',
  'open-agent': 'agents',
  'open-env': 'env',
  'open-plugin': 'plugins',
  'open-dsh': 'dsh',
  'open-codex': 'codex',
  'open-claude': 'claude'
}

/** 解析后的文档动作:动作 id + 查询参数(如 open-session 的 id) */
export interface DocAction {
  id: string
  params: Record<string, string>
}

const isKnownAction = (id: string): boolean =>
  Object.prototype.hasOwnProperty.call(CREATE_ACTIONS, id) ||
  Object.prototype.hasOwnProperty.call(OPEN_ACTIONS, id) ||
  Object.prototype.hasOwnProperty.call(MCP_TOGGLE_ACTIONS, id)

/** 链接 href → 动作;非本 scheme 或未知名返回 null(调用方回落普通链接处理) */
export function docActionFromHref(href: string): DocAction | null {
  if (!href.startsWith(DOC_ACTION_SCHEME)) return null
  const rest = href.slice(DOC_ACTION_SCHEME.length)
  const q = rest.indexOf('?')
  const id = (q === -1 ? rest : rest.slice(0, q)).trim()
  if (!isKnownAction(id)) return null
  const params: Record<string, string> = {}
  if (q !== -1) {
    // 重复 key 只取首个：后写覆盖会让 ?id=a&id=b 静默取 b（清点生成器只发单值，
    // 这里按首值定死，外来的重复参数不产生「换值」语义；'__proto__' 这类键因
    // 读到原型上的值非 undefined 也天然被跳过，不会污染对象）
    for (const [k, v] of new URLSearchParams(rest.slice(q + 1))) {
      if (params[k] === undefined) params[k] = v
    }
  }
  return { id, params }
}

/** 执行动作:按 id 路由(见文件头注释的两类语义) */
export function runDocAction(action: DocAction): void {
  const createPanel = CREATE_ACTIONS[action.id]
  if (createPanel) {
    // 新建:切面板 + 请求打开新建对话框(面板未挂载时请求跨挂载存活)
    dispatchNavigate(createPanel)
    useUiStore.getState().requestCreateDialog(createPanel)
    return
  }

  const mcpToggle = MCP_TOGGLE_ACTIONS[action.id]
  if (mcpToggle) {
    // 手册里的 MCP 安全开关:翻 security 配置,再按新状态原地换所有已开手册
    // 页签的链接标签(readDoc.applyMcpToggleToOpenHelpTabs)。异步 fire-and-forget,
    // 失败仅留控制台痕迹(与原设置面板开关的 catch 惯例一致)
    void (async () => {
      try {
        const on = await flipMcpSecurityFlag(MCP_TOGGLE_FLAG_KEYS[mcpToggle])
        applyMcpToggleToOpenHelpTabs(mcpToggle, on)
      } catch (err) {
        console.warn('Failed to toggle MCP security setting:', err)
      }
    })()
    return
  }

  switch (action.id) {
    case 'open-session': {
      // 清单是时点快照,点击时可能已删:找不到就不动(控制台留痕)
      const saved = useSessionStore.getState().savedSessions.find(c => c.id === action.params.id)
      if (saved) void connectSession(saved)
      else console.error(`Doc action open-session: session not found: ${action.params.id}`)
      return
    }
    case 'open-agent': {
      // 与 AgentsPanel 行点击完全同一条链(launchAgent 由主进程拉起终端)
      const agentId = action.params.id
      void (async () => {
        try {
          await window.electronAPI?.launchAgent(agentId)
        } catch (err) {
          console.error('Doc action open-agent failed:', err)
        }
      })()
      return
    }
    case 'open-plugin':
      dispatchNavigate('plugins')
      return
    case 'open-env':
    case 'open-dsh':
    case 'open-codex':
    case 'open-claude': {
      // 变量组开编辑对话框、工作区走面板的启动链(依赖检测/失败横幅都长在面板上)
      const panel = OPEN_ACTIONS[action.id]
      dispatchNavigate(panel)
      if (action.params.id) useUiStore.getState().requestOpenItem(panel, action.params.id)
      return
    }
  }
}
