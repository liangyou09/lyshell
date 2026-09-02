import React, { useState, useEffect, useRef, useCallback } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import SessionsPanel from './SessionsPanel'
import ActivityRail, { type NavTab, RAIL_WIDTH } from './ActivityRail'
import AgentsPanel from './AgentsPanel'
import SplitPaneContainer from './SplitPaneContainer'
import FloatWindow from '../FloatWindow/FloatWindow'
import TopRightControls from './TopRightControls'
import { TOPBAR_HEIGHT, TOP_LEFT_RESERVE, SIDEBAR_DIVIDER_WIDTH, SIDEBAR_PILL_HEIGHT } from './topbar-metrics'
import { startAllHarnessDetects } from './harness-detect'
import PluginPanel from './PluginPanel'
import WebPanel from './WebPanel'
import HarnessPanel from './HarnessPanel'
import EnvProfilePanel from './EnvProfilePanel'
import SettingsPanel from './SettingsPanel'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore, findPane } from '../../stores/pane-store'
import { useThemeStore } from '../../stores/theme-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useQuickCommandsStore } from '../../stores/quick-commands-store'
import { dispatchCommand } from '../../utils/dispatch-command'
import { openLocalDoc } from '../DocPanel/readDoc'
import { isDocPath } from '@shared/types'
import type { SessionConfig, QuickCommand } from '@shared/types'

// 左列收起态/宽度的 localStorage 镜像 key -- 主进程 config 异步,首帧用它同步定态防闪
// (activeNav 的 lyshell.navTab.v1 同款规避);懒读与双写共用常量,防两处字面量漂移
const COLLAPSED_STORAGE_KEY = 'lyshell.sidebarCollapsed.v1'
const WIDTH_STORAGE_KEY = 'lyshell.sidebarWidth.v1'

/**
 * 主窗口布局组件
 */
const MainWindow: React.FC = () => {
  // 左列收起态:localStorage 同步懒读定首帧 -- 主进程 config 是异步的,直接以它初始化会
  // "先展开后收起"闪一帧;config 仍是对账权威(见下方载回 effect),变更时双写
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1' } catch { return false }
  })
  const [collapsedLoaded, setCollapsedLoaded] = useState(false) // config 对账回来前禁用宽度动画(纠正路径不播 150ms 滑动)
  // 左列机柜页签轨当前页签 -- 持久化到 localStorage
  const [activeNav, setActiveNav] = useState<NavTab>(() => {
    try {
      const saved = localStorage.getItem('lyshell.navTab.v1')
      if (saved === 'sessions' || saved === 'agents' || saved === 'dsh' || saved === 'codex' || saved === 'claude' || saved === 'env' || saved === 'plugins' || saved === 'web' || saved === 'settings') {
        return saved
      }
    } catch { /* localStorage 不可用,回退默认 */ }
    return 'sessions'
  })
  // 左列宽度(三栏共享) -- localStorage 同步懒读定首帧(同 sidebarCollapsed),config 异步对账;
  // ActivityRail 固定 RAIL_WIDTH 在其左,面板填剩余宽,拖动范围钳在 180-400
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const w = Number(localStorage.getItem(WIDTH_STORAGE_KEY))
      return Number.isFinite(w) && w > 0 ? Math.max(180, Math.min(400, w)) : 240
    } catch { return 240 }
  })
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [floatVisible, setFloatVisible] = useState(false) // 浮窗默认隐藏
  const [isMaximized, setIsMaximized] = useState(false)
  const { sessions, loadSessions, refreshSavedSessions, syncSessionsFromBackend } = useSessionStore()
  // 不订阅 layout：本组件 JSX 不消费布局树（activePaneId 只在事件回调里经
  // getState 现取），订阅会让高频布局写入（拖分屏比例的 setSplitRatio ~60Hz）
  // 逐帧重渲整个窗口 chrome
  const { initFromStorage } = useThemeStore()
  const { initFromStorage: initLocaleFromStorage } = useLocaleStore()
  const { t } = useTranslation()
  const terminalWrapperRef = useRef<HTMLDivElement>(null)

  // 切换左列页签 -- 持久化到 localStorage(Alt+1/2/3 与页签轨点击共用)
  const handleNavChange = useCallback((tab: NavTab) => {
    setActiveNav(tab)
    try { localStorage.setItem('lyshell.navTab.v1', tab) } catch { /* quota */ }
  }, [])

  // 加载主题（index.html 已早期应用，这里仅同步 store 状态）
  useEffect(() => {
    initFromStorage()
  }, [initFromStorage])

  // 加载语言（lang-init.ts 已早期设 <html lang>，i18n.ts 已用 saved 初始化 lng；这里同步 store 状态供选择器显示）
  useEffect(() => {
    initLocaleFromStorage()
  }, [initLocaleFromStorage])

  // 一次性清理:RECENT 段已从会话面板删除并搬到浮窗,旧 localStorage key 是死数据
  // 几次启动后绝大多数客户端就清干净了;新装用户根本不会有这个 key,这段也会是 no-op
  // 注:recentCollapsed 存在 main 的 preferences.json(非 localStorage),清理它需要新增 IPC delete 通道,
  // 只为删一个 boolean 不值得 —— 残留几 bytes,忽略
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem('lyshell.recents.v1')
  }, [])

  // 启动预热 dsh/codex/claude 依赖检测(各一次,并行):结果进应用级缓存,
  // 之后切页签直接读缓存,不再重复打检测 IPC(见 harness-detect.ts)
  useEffect(() => {
    startAllHarnessDetects()
  }, [])

  // 加载会话列表
  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // 全局监听终端数据，设置活动状态（用于标签高亮提示）
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onTerminalData((sessionId, _data) => {
      const { sessions, setSessionActivity } = useSessionStore.getState()
      const { getPaneBySessionId } = usePaneStore.getState()

      // 找到该会话所在的pane
      const pane = getPaneBySessionId(sessionId)
      if (pane && pane.type === 'leaf') {
        // 如果该会话不是该pane的活跃会话，设置活动状态
        if (pane.activeSessionId !== sessionId) {
          const session = sessions.find(s => s.id === sessionId)
          // 只有当前没有活动状态时才设置（避免频繁更新）
          if (session && !session.hasActivity) {
            setSessionActivity(sessionId, true)
          }
        }
      }
    })

    return cleanup
  }, [])

  // 监听会话状态变化并更新 store
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onConnectionStatus((data) => {
      const store = useSessionStore.getState()

      // 如果会话不在 store 中，检查状态
      const existingSession = store.sessions.find(s => s.id === data.id)
      if (!existingSession) {
        // 对于断开或错误状态的会话，不要重新添加（可能是用户关闭后被移除的临时会话）
        if (data.status === 'disconnected' || data.status === 'error') {
          return
        }

        // 从后端获取会话配置并添加（仅对于 connecting/connected 状态）
        window.electronAPI?.getSession(data.id).then(config => {
          if (config) {
            store.addTemporarySession({
              id: data.id,
              config,
              status: data.status,
              skipAutoAddToPane: false
            })

            // 立即添加到当前分屏（即使是 connecting 状态）
            const paneStore = usePaneStore.getState()
            const activePaneId = paneStore.layout.activePaneId
            if (activePaneId) {
              paneStore.addSessionToPane(activePaneId, data.id)
            }
          }
        })
        return
      }

      // 更新状态
      store.updateSessionStatus(data.id, data.status, data.error)

      // 当会话连接成功时，检查是否需要自动添加到分屏
      if (data.status === 'connected') {
        // 检查是否跳过自动添加
        if (existingSession.skipAutoAddToPane) {
          store.clearSkipAutoAddToPane(data.id)
          return  // 跳过自动添加，让克隆逻辑手动处理
        }

        // 检查会话是否已经在某个分屏中
        const paneStore = usePaneStore.getState()
        const allPanes = paneStore.getAllLeafPanes()
        const isInPane = allPanes.some(p => p.sessions.includes(data.id))

        if (!isInPane) {
          const activePaneId = paneStore.layout.activePaneId
          if (activePaneId) {
            paneStore.addSessionToPane(activePaneId, data.id)
          }
        }
      }
    })

    return cleanup
  }, [])

  // 启动时把当前已在终端页签中的会话同步给主进程（覆盖从 localStorage 恢复布局的场景）
  useEffect(() => {
    if (!window.electronAPI?.syncTerminalOpenSessions) return
    const ids = usePaneStore.getState().getAllOpenSessionIds()
    if (ids.length > 0) {
      window.electronAPI.syncTerminalOpenSessions(ids).catch((err: unknown) => {
        console.warn('Failed to sync initial terminal open sessions:', err)
      })
    }
  }, [])

  // MCP 占用/释放共享 PTY 时更新 store 锁定状态，TerminalView 据此阻塞用户输入
  useEffect(() => {
    if (!window.electronAPI?.onMcpSessionLocked) return
    const cleanupLock = window.electronAPI.onMcpSessionLocked(({ sessionId }) => {
      useSessionStore.getState().setSessionMcpLock(sessionId, true)
    })
    return cleanupLock
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onMcpSessionUnlocked) return
    const cleanupUnlock = window.electronAPI.onMcpSessionUnlocked(({ sessionId }) => {
      useSessionStore.getState().setSessionMcpLock(sessionId, false)
    })
    return cleanupUnlock
  }, [])

  // 订阅可达性探测结果
  useEffect(() => {
    if (!window.electronAPI?.onSessionReachable) return
    const cleanup = window.electronAPI.onSessionReachable((payload) => {
      useSessionStore.getState().updateReachability(payload.key, payload.reachable)
    })
    return cleanup
  }, [])

  // 外部路径（MCP 写入/创建）改动会话列表后，主进程推送 sessions:changed —— 增量同步，不重置连接状态
  useEffect(() => {
    if (!window.electronAPI?.onSessionsChanged) return
    const cleanup = window.electronAPI.onSessionsChanged(() => {
      syncSessionsFromBackend()
    })
    return cleanup
  }, [syncSessionsFromBackend])

  // 检查窗口是否最大化
  useEffect(() => {
    window.electronAPI?.isMaximized().then((maximized: boolean) => {
      setIsMaximized(maximized)
    })
  }, [])

  // 左列收起态:config 异步对账 + 变更双写。对账纠正 localStorage 被清/升级首启
  // (镜像缺、config 还在)的场景;collapsedLoaded 守卫让纠正不播动画 -- 懒读命中的
  // 常态路径首帧即终态,守卫只在纠正路径生效
  useEffect(() => {
    window.electronAPI?.getConfig('sidebarCollapsed').then((v: unknown) => {
      if (typeof v === 'boolean') setSidebarCollapsed(v)
    }).catch(() => {}).finally(() => setCollapsedLoaded(true))
  }, [])
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0') } catch { /* quota */ }
    const t = setTimeout(() => {
      window.electronAPI?.setConfig('sidebarCollapsed', sidebarCollapsed)
    }, 500)
    return () => clearTimeout(t)
  }, [sidebarCollapsed])

  // 左列宽度:config 异步对账 + 变更双写(localStorage 镜像即时写,config 防抖写)/ 拖动
  useEffect(() => {
    window.electronAPI?.getConfig('sidebarWidth').then((w: unknown) => {
      if (typeof w === 'number' && w > 0) setSidebarWidth(w)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    try { localStorage.setItem(WIDTH_STORAGE_KEY, String(sidebarWidth)) } catch { /* quota */ }
    const t = setTimeout(() => {
      window.electronAPI?.setConfig('sidebarWidth', sidebarWidth)
    }, 500)
    return () => clearTimeout(t)
  }, [sidebarWidth])
  // 侧栏调宽：pointer 捕获期间事件恒重定向到捕获元素并从它冒泡，move/up 监听直接挂在
  // 分隔条/热区元素上即可覆盖拖拽全程（旧 document 级监听依赖隐式捕获语义，已收拢到元素上）
  const handleSidebarResizeMove = (e: React.PointerEvent) => {
    if (!isResizingSidebar) return
    setSidebarWidth(Math.max(180, Math.min(400, e.clientX - RAIL_WIDTH)))
  }
  const endSidebarResize = () => setIsResizingSidebar(false)

  // Alt+1..9 切换左列页签(实现 footer 既有 "alt + 1…n" 提示;capture 抢在 xterm 前)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return
      // 文本输入中不拦截(避免劫持 PluginPanel/WebPanel URL 输入等)
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      let tab: NavTab | null = null
      if (e.key === '1') tab = 'sessions'
      else if (e.key === '2') tab = 'agents'
      else if (e.key === '3') tab = 'dsh'
      else if (e.key === '4') tab = 'codex'
      else if (e.key === '5') tab = 'claude'
      else if (e.key === '6') tab = 'env'
      else if (e.key === '7') tab = 'plugins'
      else if (e.key === '8') tab = 'web'
      else if (e.key === '9') tab = 'settings'
      if (!tab) return
      e.preventDefault()
      e.stopPropagation()
      handleNavChange(tab)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleNavChange])

  // 监听浮窗显示/隐藏快捷键
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onFloatToggle(() => {
      setFloatVisible(prev => !prev)
    })
    return cleanup
  }, [])

  // 页签 HTML5 拖拽进行中(文档级监听) -- 左缘感应条临时穿透+隐身,不挡最左 pane 的
  // 左缘分屏落点。只认页签类拖拽源(data-tab-id,会话/MCP/dsh web 页签):文件面板等
  // 其他 DnD 与分屏落点无关,不触发让位。dragend 正常会触发,但源元素中途卸载等
  // 异常路径可能丢失,故补 drop / visibilitychange 两道复位兜底,防拖拽态永久卡死
  const [isTabDragging, setIsTabDragging] = useState(false)
  useEffect(() => {
    const isTabSource = (e: DragEvent) =>
      !!(e.target as HTMLElement | null)?.closest?.('[data-tab-id]')
    const onDragStart = (e: DragEvent) => {
      if (isTabSource(e)) setIsTabDragging(true)
    }
    const reset = () => setIsTabDragging(false)
    const onVisibilityChange = () => {
      if (document.hidden) reset()
    }
    document.addEventListener('dragstart', onDragStart)
    document.addEventListener('dragend', reset)
    document.addEventListener('drop', reset)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('dragstart', onDragStart)
      document.removeEventListener('dragend', reset)
      document.removeEventListener('drop', reset)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  // 快捷命令数据常驻加载（原 StatusBar 挂载时加载的逻辑上移）：
  // F 键直发监听在 MainWindow，侧栏面板（SessionsPanel）只是这份数据的视图，
  // 保证切到其他页签/收起侧栏时 Ctrl+F1-F12 仍可用。
  useEffect(() => {
    useQuickCommandsStore.getState().loadAll()
  }, [])

  // Ctrl + F1-F12 快捷键执行快速命令（从 StatusBar 迁移，常驻 MainWindow）
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return

      // F1-F12 对应快捷键索引 0-11
      const fKeyMatch = e.key.match(/^F([1-9]|1[0-2])$/)
      if (!fKeyMatch) return

      // 必须 stopPropagation:capture 阶段截断后阻止事件继续传到 xterm,
      // 否则 xterm 仍会把 F1-F12 解析成转义序列发进 PTY(快捷命令与转义序列双发)。
      e.preventDefault()
      e.stopPropagation()

      // 任何覆盖层（web / 文档 / dsh web / MCP）接管活动分屏时不发：盖住终端时命令发进去
      // 不可见（对齐原"dsh web 激活时快捷命令不可用"语义；归一前漏算 docTabs / MCP，在此修正）
      const paneSt = usePaneStore.getState()
      if (paneSt.activeOverlayInPane(paneSt.layout.activePaneId)) return

      // 发送到活动分屏的活动会话（同 handleExecuteCommand,内联避免 use-before-define）
      const activePane = paneSt.getAllLeafPanes().find(p => p.id === paneSt.layout.activePaneId)
      if (!activePane?.activeSessionId) return

      const index = parseInt(fKeyMatch[1]) - 1
      if (index < 0 || index >= 12) return

      // 直接根据当前 selectedGroupId 过滤命令（store 里取最新值,监听器无需随数据变化重挂）
      const { commands, selectedGroupId } = useQuickCommandsStore.getState()
      const groupId = selectedGroupId || 'default'
      const currentCommands = groupId === 'default'
        ? commands.filter(c => !c.groupId || c.groupId === '')
        : commands.filter(c => c.groupId === groupId)

      const sortedCommands = [...currentCommands].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

      if (index < sortedCommands.length) {
        dispatchCommand(sortedCommands[index], activePane.activeSessionId)
      }
    }
    // 用 capture 阶段:焦点在终端时 xterm 会先在 textarea 上处理 F1-F12 并
    // stopPropagation,冒泡阶段的 window 监听收不到事件;capture 抢在 xterm 之前截走。
    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [])

  // Ctrl+O 打开本地文档（拖放之外的第二个本地入口）：系统文件对话框 → openLocalDoc。
  // 同 Ctrl+F1-F12 用 capture：焦点在终端时 xterm 先于冒泡处理按键，会吃掉 O。
  useEffect(() => {
    const handleOpenDoc = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key !== 'o' && e.key !== 'O') return
      e.preventDefault()
      e.stopPropagation()
      window.electronAPI?.showOpenDialog({
        title: t('doc.openTitle'),
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Documents', extensions: ['md', 'markdown', 'html', 'htm', 'txt'] }]
      }).then((result) => {
        if (!result || result.canceled) return
        for (const p of result.filePaths) {
          if (isDocPath(p)) void openLocalDoc(p)
        }
      }).catch(() => { /* 对话框失败静默 */ })
    }
    window.addEventListener('keydown', handleOpenDoc, true)
    return () => window.removeEventListener('keydown', handleOpenDoc, true)
  }, [t])

  // 本地文档拖入：OS 文件拖放（HTML5 FileList 在 Electron 28 携带绝对路径，先例
  // FileManagerPanel）。只认 Files 类型的拖拽 —— 内部页签 HTML5 拖拽（data-tab-id）
  // 与文本拖放不沾边，dragover 也不 preventDefault，避免全窗口变落点破坏分屏落点语义。
  // 已知限制：harness webview 区域会吞宿主 drop 事件（既有问题，见 webview 记忆）。
  const handleRootDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  }
  const handleRootDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = (file as unknown as { path?: string }).path
      if (p && isDocPath(p)) void openLocalDoc(p)
    }
  }

  // MCP open_connection_dialog 工具（C4）：主进程推送 → 派发 newSession 事件，
  // 由 SessionsPanel 监听并打开"新建连接"对话框。agent 把凭据填写交还给用户（MCP 通道不接受凭据）。
  useEffect(() => {
    if (!window.electronAPI?.onMcpOpenConnectionDialog) return
    const cleanup = window.electronAPI.onMcpOpenConnectionDialog(() => {
      window.dispatchEvent(new Event('newSession'))
    })
    return cleanup
  }, [])

  // 窗口控制
  const handleMinimize = () => {
    window.electronAPI?.minimizeWindow()
  }

  const handleMaximize = () => {
    window.electronAPI?.maximizeWindow().then((maximized: boolean) => {
      setIsMaximized(maximized)
    })
  }

  const handleClose = () => {
    window.electronAPI?.closeWindow()
  }

  // 打开 dsh Web UI：主进程 spawn `dsh web --port 0` 解析端口 → 拿到 URL 后写入 pane-store，
  // 由 PaneTabBar / PaneView 渲染成终端页签 + <webview> 覆盖层（对齐 MCP 活动页签模式，可像标签一样 ✕ 关闭）。
  // 失败把 error 回传给面板横幅展示（面板负责本地化兜底文案）。
  // 打开 dsh Web UI：target 可传 { workspaceId }（沿用该工作区目录）或 { cwd }（直接以该目录为根）。
  // 主进程 spawn `dsh web --port 0` 解析端口 → 拿到 URL/cwd 后写入 pane-store。
  const handleOpenWeb = useCallback(async (target: { workspaceId?: string; cwd?: string }, name?: string) => {
    try {
      const res = await window.electronAPI?.openDshWeb(target)
      if (!res || res.success === false) {
        return { success: false as const, error: res && typeof res.error === 'string' ? res.error : undefined }
      }
      const { openDshWebInPane, layout: paneLayout } = usePaneStore.getState()
      // cwd 回传仅用于页签 tooltip 标注运行目录（PaneTabBar 读 dshWeb.cwd）。页签名优先取调用方给的名字，
      // 否则回落常量 —— 默认目录 $DSH_HOME/web 的基名只是 "web"，不适合直接当页签名。
      const cwd = res.cwd as string | undefined
      const info = { url: res.url as string, name: name ?? 'DeepSeek Harness', cwd }
      openDshWebInPane(paneLayout.activePaneId, info)
      return { success: true as const }
    } catch (err) {
      console.error('dsh web open failed:', err)
      return { success: false as const, error: err instanceof Error ? err.message : undefined }
    }
  }, [])

  // 点击会话直接开启终端
  const handleConnect = async (_sessionId: string, config: SessionConfig) => {
    try {
      // 更新访问时间（仍用原 saved id）
      await window.electronAPI?.updateSession({
        ...config,
        updatedAt: new Date()
      })
      await refreshSavedSessions()

      // 每次点击 saved session 都创建新的 runtime 会话：
      // 把 id 置空让后端生成新 UUID，避免同一 saved id 只能对应一个终端页签。
      // 通过 originSavedSessionId 保留与原保存项的关联，供 MCP list_sessions 同步状态。
      const runtimeConfig: SessionConfig = { ...config, id: '', originSavedSessionId: config.id }

      // 调用后端连接（后端会立即返回 sessionId，前端显示终端）
      await window.electronAPI?.connect(runtimeConfig)
    } catch (error) {
      console.error('Connect failed:', error)
    }
  }

  // 执行快速命令 - 派发到活动分屏的活动会话（拆行/转义/结尾符统一在 dispatchCommand）
  const handleExecuteCommand = (cmd: QuickCommand) => {
    const st = usePaneStore.getState()
    const activePane = st.getAllLeafPanes().find(p => p.id === st.layout.activePaneId)
    if (activePane?.activeSessionId) {
      dispatchCommand(cmd, activePane.activeSessionId)
    }
  }

  // 快捷命令键帽置灰条件：任何覆盖层（web / 文档 / dsh web / MCP）激活在当前活动分屏
  // （webview/面板盖住终端，命令发进去不可见）。树与 activePaneId 都从 selector 的
  // 快照 s 读取（不经过 activeOverlayInPane 这类内部走 get() 的方法 —— 那会撕裂
  // 快照与活 store，React 18 并发渲染下出错位中间态）。
  // 即便覆盖层挂在别的分屏上，活动分屏是终端时快捷命令仍应指向该终端。
  const overlayActiveHere = usePaneStore(s => {
    const pane = findPane(s.layout.root, s.layout.activePaneId)
    return pane?.type === 'leaf' ? pane.overlays.some(r => r.active) : false
  })
  // 在线会话数 -- ActivityRail 的 sessions 槽位 LED 读数
  const liveCount = sessions.filter(s => s.status === 'connected').length

  // 左列展开时的总宽(rail + 面板 + 调宽条) -- 常挂载收起动画的 width 切换值
  const leftColumnWidth = RAIL_WIDTH + sidebarWidth + SIDEBAR_DIVIDER_WIDTH

  return (
    /* 浏览器式单行布局:左列(机柜轨+面板,全高) + 终端列。终端页签条提顶 --
       终端列从窗口顶部开始,最顶排 pane 的页签条即第一行(窗口拖拽区/留白见 PaneTabBar);
       窗口控制与侧栏开关以浮层挂在第一行两端(见 terminal-wrapper 内)。 */
    <div
      className="flex h-screen bg-[var(--bg-base)] text-[var(--text-rack)] overflow-hidden"
      onDragOver={handleRootDragOver}
      onDrop={handleRootDrop}
    >
      {/* 左列:全高机柜轨 + 面板 + 宽度调整条。收起时宽度动画到 0(内容保持挂载、overflow 裁剪、
          不可交互) -- 常挂载让收起/展开有 150ms 推挤动画,也保留面板滚动位置等局部状态;
          副作用是收起时面板的事件监听仍存活(均为 store 写入类,无 UI 后果) */}
      <div
        className={cn(
          'flex-shrink-0 h-full overflow-hidden transition-[width] duration-150 ease-out',
          (isResizingSidebar || !collapsedLoaded) && 'transition-none', // 拖宽跟手 / config 未载回
          sidebarCollapsed && 'pointer-events-none' // 收起瞬间即不可交互
        )}
        style={{ width: sidebarCollapsed ? 0 : leftColumnWidth }}
        aria-hidden={sidebarCollapsed}
        /* inert 把收起的左列整体移出 Tab 序列与无障碍树 -- aria-hidden 只藏不撤焦,
           focus 仍会落进不可见面板;React 18 不识别 inert 布尔 prop,故用展开注入空串 */
        {...(sidebarCollapsed ? { inert: '' } : {})}
      >
        {/* 内层固定宽:动画期间内容不被压缩(squish),只被左缘裁剪 */}
        <div className="flex h-full" style={{ width: leftColumnWidth }}>
          <ActivityRail active={activeNav} onChange={handleNavChange} liveCount={liveCount} onCollapse={() => setSidebarCollapsed(true)} />
          <div style={{ width: `${sidebarWidth}px` }} className="flex-shrink-0 min-w-0 h-full">
            {activeNav === 'sessions' && (
              <SessionsPanel
                onConnect={handleConnect}
                onExecuteCommand={handleExecuteCommand}
                quickCommandsDisabled={overlayActiveHere}
              />
            )}
            {activeNav === 'agents' && <AgentsPanel />}
            {activeNav === 'dsh' && <HarnessPanel agent="dsh" onOpenWeb={handleOpenWeb} />}
            {activeNav === 'codex' && <HarnessPanel agent="codex" />}
            {activeNav === 'claude' && <HarnessPanel agent="claude" />}
            {activeNav === 'env' && <EnvProfilePanel />}
            {activeNav === 'plugins' && <PluginPanel />}
            {activeNav === 'web' && <WebPanel />}
            {activeNav === 'settings' && <SettingsPanel />}
          </div>
          {/* 宽度调整条 */}
          <div
            style={{ width: SIDEBAR_DIVIDER_WIDTH }}
            className="bg-[var(--rule)] cursor-col-resize hover:bg-[var(--amber)] transition-colors flex-shrink-0 relative"
            onPointerDown={(e) => {
              // 指针捕获:拖拽跟随与指针下元素解耦 -- harness webview 激活时往右拖,指针一进
              // webview 范围 mousemove 就被 guest 吞掉(同跨域 iframe),捕获后 pointermove 恒回流本元素
              e.currentTarget.setPointerCapture(e.pointerId)
              setIsResizingSidebar(true)
            }}
            onPointerMove={handleSidebarResizeMove}
            onPointerUp={endSidebarResize}
            onPointerCancel={endSidebarResize}
            onLostPointerCapture={endSidebarResize}
          >
            {/* 左侧 4px 命中热区(面板边缘最右 4px 可见条 + 面板内容最后 4px),扩命中不扩可见宽 */}
            <div
              style={{ left: -SIDEBAR_DIVIDER_WIDTH, width: SIDEBAR_DIVIDER_WIDTH }}
              className="absolute top-0 bottom-0 cursor-col-resize"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                setIsResizingSidebar(true)
              }}
              onPointerMove={handleSidebarResizeMove}
              onPointerUp={endSidebarResize}
              onPointerCancel={endSidebarResize}
              onLostPointerCapture={endSidebarResize}
            />
          </div>
        </div>
      </div>

      {/* 终端列:顶部即窗口第一行(页签条由 SplitPaneContainer 内顶排 pane 渲染) */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div
          ref={terminalWrapperRef}
          className="terminal-wrapper flex-1 min-h-0 bg-[var(--terminal-bg)] overflow-hidden relative pb-0"
          /* 第一行最左页签条的左留白 -- 收起时给展开 pill 让位(TOP_LEFT_RESERVE),
             展开时归零让页签紧贴左列;PaneTabBar 读 var() 消费(镜像右端 --top-right-reserve
             的变量架构,但值随侧栏状态同步切换,无需实测) */
          style={{ '--top-left-reserve': sidebarCollapsed ? `${TOP_LEFT_RESERVE}px` : '0px' } as React.CSSProperties}
        >
          {/* 侧栏收起时,终端画布向内让出框线宽的槽位给内框线 -- 框线画在槽里而不是浮在
              终端内容上方;画布缩量由 pane-resize ResizeObserver 感知,xterm 随之重新 fit。
              槽宽读 --edge-frame-width,与 .edge-frame 边框 / .edge-hit 命中条同源 */}
          <div className={cn('h-full', sidebarCollapsed && 'pl-[var(--edge-frame-width)] pb-[var(--edge-frame-width)]')}>
            <SplitPaneContainer />
          </div>

          {/* 左上侧栏展开控位(ghost,无按钮形) -- 仅收起态可见:静息 chevron 走
              mute(与轨顶收起槽同档),悬停整块托起(bg-elev)+ chevron 提亮到 data,点击展开;展开态的收起开关
              在机柜轨顶槽(ActivityRail onCollapse)。第一行其余区域是窗口拖拽区,
              收不到 click,故命中区收敛在这块 win-no-drag 条带里(TOP_LEFT_RESERVE 宽)。
              淡出时 strip 整体 pointer-events-none,这片留白还给第一行窗口拖拽区。
              32×36 命中区恰好齐平 36px 的第一行(SIDEBAR_PILL_HEIGHT = TOPBAR_HEIGHT);
              顶左角 8px 随窗口圆角收圆(镜像 edge-frame 左下角)。 */}
          <div
            className={cn(
              'win-no-drag absolute top-0 left-0 z-40 flex items-center bg-[var(--bg-rack)] select-none',
              'transition-opacity duration-150 ease-out',
              !sidebarCollapsed && 'opacity-0 pointer-events-none'
            )}
            style={{ height: SIDEBAR_PILL_HEIGHT, width: TOP_LEFT_RESERVE }}
            aria-hidden={!sidebarCollapsed}
          >
            <button
              type="button"
              onClick={() => setSidebarCollapsed(false)}
              tabIndex={sidebarCollapsed ? 0 : -1}
              title={t('settings.expandSidebar')}
              aria-label={t('settings.expandSidebar')}
              className={cn(
                'w-full h-full rounded-[8px_2px_2px_2px]',
                'flex items-center justify-center cursor-pointer group',
                'transition-[background-color] duration-150',
                // 无按钮形:无边框无底色,悬停整块托起 + chevron 提亮,不点亮边缘
                'hover:bg-[var(--bg-elev)]',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--amber)]'
              )}
            >
              {/* 单层 » 余痕 -- Edge 收起侧栏后的展开惯例,指向左列滑入方向 */}
              <svg
                width="18" height="18" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter"
                className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack-data)] group-focus-visible:text-[var(--text-rack-data)] transition-colors"
              >
                <path d="M6 4.5 L10.5 8 L6 11.5" />
              </svg>
            </button>
          </div>

          {/* 侧栏收起时的 L 形内框 -- 左+下两条等宽线(--edge-frame-width),左下角随窗口圆角(8px)连续拐弯
              (单元素 border 画整框,见 globals .edge-frame),不占页签行高度。
              框线画在终端让出的 4px 槽位里(见上方 inset 包裹),不压终端内容。
              两条槽位内的透明命中条(.edge-hit)负责交互:悬停整框通电(amber),点击展开左列;
              页签拖拽分屏期间整框隐身让位。
              注意 DOM 顺序:frame 必须排在两条 hit 条之后 -- 悬停通电靠
              .edge-hit:hover ~ .edge-frame 兄弟选择器,调换顺序选择器即失效 */}
          {sidebarCollapsed && (
            <>
              <div
                className={cn('edge-hit absolute left-0 z-40 w-[var(--edge-frame-width)]', isTabDragging && 'pointer-events-none')}
                style={{ top: TOPBAR_HEIGHT, bottom: 0 }}
                onClick={() => setSidebarCollapsed(false)}
                title={t('settings.expandSidebar')}
              />
              <div
                className={cn('edge-hit absolute bottom-0 left-0 right-0 z-40 h-[var(--edge-frame-width)]', isTabDragging && 'pointer-events-none')}
                onClick={() => setSidebarCollapsed(false)}
                title={t('settings.expandSidebar')}
              />
              <div
                aria-hidden
                className={cn('edge-frame absolute left-0 right-0 bottom-0 z-40', isTabDragging && 'opacity-0')}
                style={{ top: TOPBAR_HEIGHT }}
              />
            </>
          )}

          {/* 右上控制簇 -- MCP 状态片 + 浮窗键 │ 窗口控制,悬浮于第一行页签条右端
              (留白见 TopRightControls 实测发布的 --top-right-reserve) */}
          <div className="absolute top-0 right-0 z-40">
            <TopRightControls
              isMaximized={isMaximized}
              onMinimize={handleMinimize}
              onMaximize={handleMaximize}
              onClose={handleClose}
              floatVisible={floatVisible}
              onToggleFloat={() => setFloatVisible(!floatVisible)}
            />
          </div>

          {/* 右上角会话浮窗 -- 锚在第一行页签条正下方(top 与第一行高度强绑定,引用常量防错位) */}
          {floatVisible && (
            <div
              className="absolute right-[12px] z-50 w-[300px] h-[400px] bg-[var(--bg-slot)] border border-[var(--rule)] overflow-hidden shadow-lg"
              style={{ top: TOPBAR_HEIGHT }}
            >
              <FloatWindow onConnect={handleConnect} />
            </div>
          )}
        </div>
      </div>

      {/* MCP 活动面板以页签形式挂在各分屏 PaneView 内，由布局树里的 mcpAudit 覆盖层引用驱动 */}
    </div>
  )
}

export default MainWindow