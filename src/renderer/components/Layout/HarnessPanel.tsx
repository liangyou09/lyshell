import { findManagedWorkspace } from './work-launcher-tree'
import DialogClose from '@/components/Layout/DialogClose'
import ScrollFold from './ScrollFold'
import { GroupListActions } from './GroupList'
import { PanelHeader, PanelHeaderAction } from './PanelHeader'
import { IconBtn } from './IconBtn'
import { SettingsGlyph } from './SettingsNavigation'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { DEFAULT_CLAUDE_PERMISSION_MODE, DEFAULT_CODEX_PERMISSION_PROFILE, HARNESS_AGENT_VIEWS, type ClaudePermissionMode, type CodexPermissionProfile, type EnvProfileLibraryResult, type HarnessAgentKind, type HarnessEnvProfile, type HarnessWorkspace } from '@shared/harness'
import { BRANCH_PREFIX, generateWorktreeCode, generateWorktreeKey, generateWorktreeStamp, joinWorktreePath } from '@shared/worktree'
import { GroupHeader, type GroupHeaderTone } from './SessionsPanel'
import { normDirKey, wsDirDetail, wsDirLabel } from './ws-dir'
import { ensureDetected, getCachedDetect, redetectHarness } from './harness-detect'
import { useUiStore } from '../../stores/ui-store'
import { useEscDismiss } from '../../hooks'
import { formatCodeWorkspaceName, type CodeWorkspacePreset } from '@shared/code-workspaces'
import './HarnessPanel.css'
import { workspaceProjectHue } from './workspace-project-color'
import RackSelect from './RackSelect'
import RackCombobox from './RackCombobox'
import { ProjectSceneProjectActions } from './ProjectSceneBar'

/**
 * AI Harness 面板 —— dsh / codex / claude 三份第一等终端 Agent 的通用外壳。
 *
 * 每个 kind 通过 HARNESS_AGENT_VIEWS[agent] 注入展示/检测配置（依赖、env 默认、模型建议、
 * 安装信息、是否 Web）；行为差异（启动命令、模型预设、env 归一化）在主进程 harness/config.ts，
 * 渲染层只关心「检测 → 工作区列表 → 增删改/启动」这套通用交互。
 *
 * 缺失依赖时只提示 + 给出安装命令与仓库链接（不自动安装）。就绪后管理多个「工作区」：
 * Codex / Claude 点击名称展开配置，使用独立按钮启动；DeepSeek 保留单击启动。
 * Codex / Claude 按目录展示项目索引，组头可折叠，工作区名称与启动摘要分层；
 * DeepSeek 保留卷轴分组。工作区配置及启动行为由各 kind 的适配器保持。
 * 环境变量的增删改与启用切换都在左侧「环境变量」面板；这里仅为工作区对话框的绑定
 * 下拉与模型建议拉一份只读变量组列表 + 该 kind 的启用指针。
 * Codex / Claude 沿用全局主题面色与系统字体；DeepSeek 保留机柜样式。
 * Web 入口挂标题（仅 hasWeb 时可按，目前只有 dsh），落在 deepseek-harness 自己的默认工作区。
 */

/** 每 kind 的 IPC 适配器 —— 映射到 preload 暴露的 concrete 方法（ElectronAPI = typeof electronAPI） */
const HARNESS_API = {
  dsh: {
    detect: () => window.electronAPI.detectDsh(),
    list: () => window.electronAPI.listDshWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addDshWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateDshWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteDshWorkspace(id),
    launch: (id: string) => window.electronAPI.launchDshWorkspace(id)
  },
  codex: {
    detect: () => window.electronAPI.detectCodex(),
    list: () => window.electronAPI.listCodexWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addCodexWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateCodexWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteCodexWorkspace(id),
    launch: (id: string) => window.electronAPI.launchCodexWorkspace(id)
  },
  claude: {
    detect: () => window.electronAPI.detectClaude(),
    list: () => window.electronAPI.listClaudeWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addClaudeWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateClaudeWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteClaudeWorkspace(id),
    launch: (id: string) => window.electronAPI.launchClaudeWorkspace(id)
  }
} as const

// ─────────────────────────────────────────────────────────────────────────────
// 目录组段身份 —— 工作区按工作目录分组立在双开画轴墙上,每 kind 一色:
// claude 青橙 / codex 青白 / dsh 青花(agents 青紫在 AgentsPanel,四面互斥
// 不同屏)。tone 给纸里目录组头的轴头/系绳(GroupHeader),token 给墙辊/
// 解绳辉光/题签墨(inline --seg-tone 注入,机械在 globals.css 的 .scroll-dual-seg)
// ─────────────────────────────────────────────────────────────────────────────
// segCls:浅色主题的墙轴头漆色；qingbai 另有题签墨覆写
// (见 globals.css .scroll-dual-seg.tone-qingbai)
const WS_TONE: Record<HarnessAgentKind, { tone: GroupHeaderTone; token: string; segCls: string }> = {
  dsh:    { tone: 'seg-qinghua', token: 'var(--seg-qinghua)', segCls: 'tone-qinghua' },
  codex:  { tone: 'seg-qingbai', token: 'var(--seg-qingbai)', segCls: 'tone-qingbai' },
  claude: { tone: 'seg-orange',  token: 'var(--seg-orange)', segCls: 'tone-orange' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 图标
// ─────────────────────────────────────────────────────────────────────────────

const IconCopy: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" strokeLinejoin="miter">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
)

const IconCheck: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
)

const IconFolder: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <path d="M2 4.5h4l1.5 2H14v6H2z" />
  </svg>
)

const IconEdit: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 9l1-3 5-5 2 2-5 5z" /></svg>
)

const IconX: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7" /></svg>
)

/**
 * 母线档位指示 —— 目录隔离单选组每一格的通电状态：左沿 2px 导轨 + LED 圆点。
 * 通电格琥珀点亮并发辉光，其余是空心环（形状差异，不只靠颜色区分）。
 * 危险档位（codex/claude 权限下拉选中完全放开）不走这里 —— 单选组没有带电警示
 * 形态，danger 皮肤收在表单 .danger-field 与列表 .danger-card（globals.css）。
 * 依赖父元素 `relative overflow-hidden` 承接绝对定位的导轨。
 */
const BusLed: React.FC<{ on: boolean }> = ({ on }) => (
  <>
    <span
      aria-hidden
      className={cn(
        'absolute left-0 top-0 bottom-0 w-[2px] transition-colors',
        on ? 'bg-[var(--amber)] shadow-[0_0_6px_var(--amber-glow)]' : 'bg-transparent'
      )}
    />
    <span
      aria-hidden
      className={cn(
        'flex-shrink-0 w-[8px] h-[8px] rounded-full border transition-colors',
        on
          ? 'bg-[var(--amber)] border-[var(--amber)] shadow-[0_0_5px_var(--amber-glow)]'
          : 'bg-transparent border-[var(--rule)]'
      )}
    />
  </>
)

const HarnessPanel: React.FC<{ agent: HarnessAgentKind; visible?: boolean; onOpenWorkspaceSettings?: () => void; onOpenEnvSettings?: () => void; onOpenWeb?: (target: { workspaceId?: string; cwd?: string }, name?: string) => Promise<{ success: boolean; error?: string }> }> = ({ agent, visible = true, onOpenWorkspaceSettings, onOpenEnvSettings, onOpenWeb }) => {
  const { t } = useTranslation()
  const view = HARNESS_AGENT_VIEWS[agent]
  const prefix = view.i18nPrefix
  const api = HARNESS_API[agent]
  const deps = view.dependencies
  const compactTree = agent !== 'dsh'

  const [status, setStatus] = useState<Record<string, boolean> | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // 工作区列表与启动状态
  const [workspaces, setWorkspaces] = useState<HarnessWorkspace[]>([])
  // 工作区列表是否已拉到(一次拉取完成即为 true,不随失败回退)——
  // 「打开指定工作区」请求的消费判据:未就绪等列表,就绪仍无此 id 则消费掉
  const [wsLoaded, setWsLoaded] = useState(false)
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [webOpening, setWebOpening] = useState(false)
  // 列表级操作错误横幅：启动失败统一在此展示具体原因
  const [actionError, setActionError] = useState<string | null>(null)
  // DeepSeek 使用对话框；Codex / Claude 使用行内编辑区。
  const [showDialog, setShowDialog] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = React.useRef(false)
  const closeEditor = () => {
    if (savingRef.current) return
    setShowDialog(false)
    setSaveError(null)
    if (agent !== 'dsh') requestAnimationFrame(() => document.getElementById(`${agent}-workspace-${editWorkspace?.id ?? 'add'}`)?.focus())
  }
  const [editWorkspace, setEditWorkspace] = useState<HarnessWorkspace | undefined>(undefined)
  const [presets, setPresets] = useState<CodeWorkspacePreset[]>([])
  const [presetId, setPresetId] = useState('')
  // 刷新候选只更新列表，表单目标独立保存，避免暂离设置或复制时重置草稿。
  const presetTargetRef = React.useRef<CodeWorkspacePreset | HarnessWorkspace | null>(null)
  const selectedPreset = presets.find(preset => preset.id === presetId)
  const usePreset = agent !== 'dsh'
  const WorkspaceSelect = usePreset ? RackSelect : 'select'
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')
  const [wsNote, setWsNote] = useState('')
  const [wsModel, setWsModel] = useState('')
  // 模型处于自动跟随档位（由变量组选择自动填充、未被手动编辑）：切换变量组时重取生效组的首个
  // 模型选项；手动输入/清空即退出自动档位，之后的变量组切换不再覆盖（与 wsKeyAuto 同一套模式）
  const [wsModelAuto, setWsModelAuto] = useState(false)
  // 权限模式（仅 claude 显示此下拉）：值即 claude CLI --permission-mode 模式字面量；
  // bypassPermissions 档启动追加 --dangerously-skip-permissions（直连 flag），
  // acceptEdits/plan 档追加 --permission-mode <mode>，default 不追加
  const [wsClaudePermissions, setWsClaudePermissions] = useState<ClaudePermissionMode>(DEFAULT_CLAUDE_PERMISSION_MODE)
  // 权限档位（仅 codex 显示此下拉）：值即 Codex 档位字面量（含 `:` 前缀），
  // 启动追加 -c default_permissions=<档位>；表单默认选中 :workspace（保存即显式落盘）
  const [wsCodexPermissions, setWsCodexPermissions] = useState<CodexPermissionProfile>(DEFAULT_CODEX_PERMISSION_PROFILE)
  // 目录隔离模式：shared = 直接在 cwd 启动（现状）；worktree = 仓库根下专属 git worktree
  const [wsIsolation, setWsIsolation] = useState<'shared' | 'worktree'>('shared')
  // worktree 共享名：空 = 私有（kind-id 各用各的树）；填了则同名工作区跨 kind 共用同一 worktree/分支。
  // 切到 worktree 时自动生成 <kind>-<名称>-<时间戳> 预填（可改可清空），保存即持久化 → 下次仍是同一 worktree
  const [wsWorktreeKey, setWsWorktreeKey] = useState('')
  // key 处于自动派生模式（未被手动编辑）：改名时 key 的名称段跟随重派生，时间戳保持稳定
  const [wsKeyAuto, setWsKeyAuto] = useState(false)
  // 本次对话框会话的时间戳代号（秒级，打开时生成一次；保存前重生成无副作用——worktree 只在启动时创建）
  const [wsKeyCode, setWsKeyCode] = useState('')
  // 当前目录所属仓库里已有的 worktree 共享名（下拉选项；检测失败静默置空，硬校验在启动时）
  const [wtKeys, setWtKeys] = useState<string[]>([])
  // 主进程解析的 .lyshell-worktrees 绝对路径（路径预览用；null = 未解析/非 git 目录）
  const [wtRoot, setWtRoot] = useState<string | null>(null)
  // 工作区绑定的变量组 id；undefined = 跟随已启用的变量组
  const [wsEnvProfileId, setWsEnvProfileId] = useState<string | undefined>(undefined)
  const [triedSubmit, setTriedSubmit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const selectPreset = (preset: CodeWorkspacePreset) => {
    presetTargetRef.current = preset
    setSaveError(null); setTriedSubmit(false)
    setPresetId(preset.id)
    setWsName(preset.name); setWsCwd(preset.cwd)
    setWsIsolation(preset.isolation === 'worktree' ? 'worktree' : 'shared')
    setWsWorktreeKey(preset.worktreeKey || ''); setWsKeyAuto(false)
    try { localStorage.setItem('lyshell.codeWorkspacePreset.v1', preset.id) } catch { /* 本次选择继续生效 */ }
  }
  useEffect(() => {
    if (!visible || agent === 'dsh') return
    let cancelled = false
    void window.electronAPI.codeWorkspaceRequest({ kind: 'list' }).then(result => {
      if (cancelled) return
      if (!result.success) { setSaveError(result.error); return }
      setPresets(result.presets)
      const draftTarget = presetTargetRef.current
      if (showDialog && draftTarget) {
        const selected = findManagedWorkspace(draftTarget, result.presets, window.electronAPI.platform)
        setPresetId(selected?.id ?? '')
        setWsName(draftTarget.name)
        setWsCwd(selected?.cwd ?? '')
        setWsIsolation(selected?.isolation === 'worktree' ? 'worktree' : 'shared')
        setWsWorktreeKey(selected?.worktreeKey || '')
      } else if (showDialog) {
        let previous = ''
        try { previous = localStorage.getItem('lyshell.codeWorkspacePreset.v1') || '' } catch { /* 使用首个预设 */ }
        const selected = result.presets.find(preset => preset.id === previous || preset.id === result.aliases?.[previous]) ?? result.presets[0]
        if (selected) selectPreset(selected)
        else { setPresetId(''); setWsName(''); setWsCwd('') }
      }
    }).catch(error => { if (!cancelled) setSaveError(error instanceof Error ? error.message : t('workspacePresets.failed')) })
    return () => { cancelled = true }
    // 仅在进入面板/新建表单时刷新，手动选择不触发重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, visible, showDialog, editWorkspace])
  // 列表行内删除的两步确认：记录待确认的工作区 id（null = 无待确认）
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // ── 环境变量组（管理入口已整体收编到左侧「环境变量」面板；这里仅为工作区
  //    对话框的绑定下拉与模型建议拉一份只读列表 + 全局启用指针） ──
  const [envProfiles, setEnvProfiles] = useState<HarnessEnvProfile[]>([])
  // 全局启用指针（env-profile:list 与变量组列表一并下发，全应用单选一根）
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  // 变量组列表是否已成功拉到 —— 空列表有两种含义（「一个都没有」与「还没拉到/拉失败」），
  // 只有前者才允许把工作区的悬空绑定判为悬空，见 handleEdit
  const [envProfilesLoaded, setEnvProfilesLoaded] = useState(false)

  // 检测走应用级缓存(harness-detect):启动时已预热,这里只把缓存结果装进本组件状态。
  // runDetect 是「强制重检」—— 手动「重新检测」按钮与启动失败后的复核用,
  // 落地后覆盖缓存,下次切页签回来读到的就是新结果
  const runDetect = useCallback(async () => {
    setDetecting(true)
    try {
      const next = await redetectHarness(agent)
      if (next) setStatus(next)
    } finally {
      setDetecting(false)
    }
  }, [agent])

  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await api.list()
      if (Array.isArray(result)) setWorkspaces(result as HarnessWorkspace[])
    } catch (err) {
      console.error(`Failed to load ${agent} workspaces:`, err)
    } finally {
      setWsLoaded(true)
    }
  }, [api, agent])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void (async () => {
      try {
        // 返回形状 { profiles, activeProfileId, usage }：全局变量组 + 全局启用指针
        //（usage 本面板不用）—— 变量组列表 kind 无关，与 ENV 面板共用同一通道
        const result = await window.electronAPI?.listEnvProfiles() as EnvProfileLibraryResult | undefined
        if (!cancelled && result && Array.isArray(result.profiles)) {
          setEnvProfiles(result.profiles as HarnessEnvProfile[])
          setActiveProfileId(typeof result.activeProfileId === 'string' ? result.activeProfileId : null)
          setEnvProfilesLoaded(true)
          setWsEnvProfileId(current => current && !result.profiles.some(p => p.id === current) ? undefined : current)
        }
      } catch (err) {
        // 失败时不置 loaded：此后编辑工作区一律透传已有绑定，不拿一份没拉到的列表去判悬空
        console.error(`Failed to load ${agent} env profiles:`, err)
      }
    })()
    // 暂离设置后可能马上返回，旧响应不得覆盖新列表或清除草稿绑定。
    return () => { cancelled = true }
  }, [agent, visible])

  // ── 目录分组视图(工作区按工作目录分组立在双开画轴墙上)──
  // 稳定分组:组序吃仓库自有的工作区顺序(首现序,不重排 —— 排序语义照旧落在
  // 组间与组内),键归一化(normDirKey)剥尾分隔符避免 D:\x 与 D:\x\ 裂成两组,
  // 根路径 / 保留原文(合法工作目录,不能吞成空串);cwd 校验必填,键不可能是
  // 空串。组开合态与 Web 栏域名组同管线(组件内留存,不存档 ——
  // 面板条件挂载,切机柜页签回来复位);列表增删留下的陈旧键无害
  const wsGroups = useMemo(() => {
    const map = new Map<string, HarnessWorkspace[]>()
    for (const snapshot of workspaces) {
      const preset = usePreset ? findManagedWorkspace(snapshot, presets, window.electronAPI.platform) : undefined
      const ws = preset ? { ...snapshot, workspacePresetId: preset.id, cwd: preset.cwd, isolation: preset.isolation, worktreeKey: preset.worktreeKey } : usePreset ? { ...snapshot, workspacePresetId: undefined, cwd: '', isolation: undefined, worktreeKey: undefined } : snapshot
      const key = normDirKey(ws.cwd)
      const list = map.get(key)
      if (list) list.push(ws)
      else map.set(key, [ws])
    }
    return [...map.entries()]
  }, [workspaces, presets, usePreset])
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({})
  const toggleDirCollapsed = useCallback((dir: string) => {
    setCollapsedDirs(s => ({ ...s, [dir]: !s[dir] }))
  }, [])
  // 一键收/放(会话墙「全体」同语义):收 = 把展开着的目录卷全卷起,放 = 全放
  const allDirsCollapsed =
    wsGroups.length > 0 && wsGroups.every(([dir]) => !!collapsedDirs[dir])
  const allDirsExpanded = wsGroups.every(([dir]) => !collapsedDirs[dir])
  const setAllDirsCollapsed = useCallback((collapsed: boolean) => {
    setCollapsedDirs(prev => {
      const next = { ...prev }
      for (const [dir] of wsGroups) next[dir] = collapsed
      return next
    })
  }, [wsGroups])

  // 挂载:检测结果读应用级缓存(启动时已预热,切页签回来不再打检测 IPC;
  // 预热漏掉/失败时 ensureDetected 兜底发起一次)。工作区与变量组列表仍按需拉取
  // (工作区对话框要用变量组渲染选择器,故两者同时拉)
  useEffect(() => {
    let active = true
    const cached = getCachedDetect(agent)
    if (cached) {
      setStatus(cached)
    } else {
      setDetecting(true)
      void ensureDetected(agent).then((next) => {
        if (!active) return
        if (next) setStatus(next)
        setDetecting(false)
      })
    }
    void loadWorkspaces()
    return () => {
      active = false
    }
  }, [agent, loadWorkspaces])

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      /* 剪贴板不可用，忽略 */
    }
  }

  // 启动就绪 = 全部依赖就绪（dsh 须 dsh+dsh-tui；codex/claude 单个）。列表就绪只看首个依赖。
  const listReady = status !== null && deps.length > 0 && Boolean(status[deps[0]])
  const launchReady = status !== null && deps.every((d) => Boolean(status[d]))

  const handleLaunch = async (ws: HarnessWorkspace) => {
    if (launchingId) return
    // 启动前校验全部依赖就绪；dsh 仅装了 dsh 缺 dsh-tui 时阻断并提示走 Web
    if (!launchReady) {
      setActionError(t(`${prefix}.tuiMissingHint`))
      void runDetect()
      return
    }
    setLaunchingId(ws.id)
    setActionError(null)
    try {
      const res = await api.launch(ws.id)
      if (res && res.success === false) {
        console.error(`${agent} workspace launch failed:`, res.error)
        // 展示具体失败原因（如补丁解析失败/权限错误），而非只给一句通用的「启动失败」
        setActionError(typeof res.error === 'string' ? res.error : t(`${prefix}.launchFailed`))
        // 检测与点击之间依赖可能已被卸载 —— 重新检测刷新 UI，回到「缺少依赖」提示卡
        void runDetect()
      }
    } catch (err) {
      console.error(`${agent} workspace launch failed:`, err)
      setActionError(err instanceof Error ? err.message : t(`${prefix}.launchFailed`))
    } finally {
      setLaunchingId(null)
      // 启动路径会给缺省 worktreeKey 的工作区回填自动生成的 key（主进程 resolveLaunchWorktree），
      // 失败分支也可能已落盘 —— 统一刷新列表让角标/编辑对话框立即反映回填结果
      void loadWorkspaces()
    }
  }

  // ESC 退出对话框 —— 入 ESC 回退栈(栈顶优先、逐层回退,IME 组合期不触发),不自留
  // document 冒泡监听:栈顶成员在捕获层截停后自留监听收不到,第一下 ESC 表现为死键。
  // 处于删除二次确认态时,首次 ESC 仅回退确认态,再次 ESC 才关闭 —— 两步确认即栈内
  // 子层级,一次 ESC 退一层,与回退栈语义一致
  useEscDismiss(showDialog && visible, () => {
    if (confirmDelete) {
      setConfirmDelete(false)
      return
    }
    closeEditor()
  })

  // worktree 模式下检测当前目录所属仓库的已有共享名与 worktree 根路径（防抖 300ms，供下拉与路径预览）。
  // 检测失败（非 git 目录 / git 缺失）静默置空 —— 保存与启动自有各自的校验，这里只管选项。
  useEffect(() => {
    if (!showDialog || wsIsolation !== 'worktree' || wsCwd.trim().length === 0) {
      setWtKeys([])
      setWtRoot(null)
      return
    }
    // 竞态防护：防抖只能取消未发出的请求；已发出的在途响应由 cancelled 标志拦下 ——
    // cwd 快速连续变化时旧响应可能晚于新响应到达，晚写回会把下拉/路径预览留在旧仓库
    let cancelled = false
    const timer = setTimeout(() => {
      window.electronAPI.listHarnessWorktrees(wsCwd.trim())
        .then((res) => {
          if (cancelled) return
          // WorktreeListResult 判别联合（preload 已标类型）：失败侧带 error，静默置空即可
          if (res && res.success) {
            setWtKeys(res.keys)
            setWtRoot(res.worktreeRoot)
          } else {
            setWtKeys([])
            setWtRoot(null)
          }
        })
        .catch(() => {
          if (cancelled) return
          setWtKeys([]); setWtRoot(null)
        })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [showDialog, wsIsolation, wsCwd])

  // ── 对话框 ──
  // 名称统一入口：自动模式下 key 的名称段跟随重派生（时间戳稳定）。手输与「选目录自动填名」
  // （handlePickCwd）两条路径都必须走这里，否则自动 key 会与名称脱节。
  const updateWsName = (value: string) => {
    setWsName(value)
    if (triedSubmit) setTriedSubmit(false)
    if (wsKeyAuto) setWsWorktreeKey(generateWorktreeKey(agent, value, wsKeyCode))
  }
  // 隔离模式切换：切到 worktree 且 key 为空时进入自动模式并预填 <kind>-<名称>-<时间戳>。
  // 「已持久化 worktree 隔离的既有工作区」不自动填 —— 其空 key 的生效树是 kind-<uuid>，
  // 静默换成新 key 会让既有 worktree（含未提交修改）被遗弃。
  const selectIsolation = (mode: 'shared' | 'worktree') => {
    setWsIsolation(mode)
    if (mode === 'worktree' && wsWorktreeKey.trim().length === 0 && editWorkspace?.isolation !== 'worktree') {
      setWsKeyAuto(true)
      setWsWorktreeKey(generateWorktreeKey(agent, wsName, wsKeyCode))
    }
  }
  const handleAdd = () => {
    if (savingRef.current) return
    presetTargetRef.current = null
    setEditWorkspace(undefined)
    // 新建默认选中「已启用的变量组」（显式绑定）—— 用户在左侧面板拨的那根指针就是当下
    // 想用的密钥；无启用指针时回落「跟随」（运行时同样落到系统环境变量）。变量组列表
    // 未拉到的极端竞态下 activeProfileId 还是 null，同样回落跟随，不阻塞开对话框
    setWsName(''); setWsCwd(''); setPresetId(''); setWsNote(''); setWsModel(''); setWsModelAuto(false); setWsClaudePermissions(DEFAULT_CLAUDE_PERMISSION_MODE); setWsCodexPermissions(DEFAULT_CODEX_PERMISSION_PROFILE); setWsEnvProfileId(activeProfileId ?? undefined); setWsIsolation('shared'); setWsWorktreeKey('')
    setWsKeyAuto(false); setWsKeyCode(generateWorktreeCode())
    setTriedSubmit(false); setConfirmDelete(false); setSaveError(null)
    setShowDialog(true)
  }

  // 外部「新建工作区」请求(ui-store,如 /ls 清点文档的新建链接):本面板按 kind
  // 条件挂载,请求落 store 跨挂载存活,挂载后读到存量也能开对话框,消费后归零防误弹
  const createRequestId = useUiStore(s => s.createDialogRequests[agent] ?? 0)
  useEffect(() => {
    if (!createRequestId) return
    handleAdd()
    useUiStore.getState().consumeCreateDialogRequest(agent)
    // 请求消费只看 id;handleAdd 的引用变化不构成「再来一次」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequestId])

  // 外部「打开工作区」请求(/ls 清点文档点行内名称):按 id 找到工作区走启动链
  // (依赖检测/失败横幅都在 handleLaunch 里,点进来就能看到为什么起不来)。
  // 请求可能先于列表到达(刚随 navigate 挂载)—— 未就绪等列表,就绪仍无此 id
  // (快照后已删)则消费掉,防陈旧请求随后续列表刷新反复触发
  const openItem = useUiStore(s => s.openItemRequests[agent])
  useEffect(() => {
    if (!openItem) return
    const ws = workspaces.find(w => w.id === openItem.itemId)
    if (ws) {
      void handleLaunch(ws)
      useUiStore.getState().consumeOpenItemRequest(agent)
    } else if (wsLoaded) {
      useUiStore.getState().consumeOpenItemRequest(agent)
    }
    // 请求消费只看请求与列表;handleLaunch 的引用变化不构成「再来一次」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openItem, workspaces, wsLoaded])
  const handleEdit = (ws: HarnessWorkspace) => {
    if (savingRef.current) return
    presetTargetRef.current = { ...ws, worktreeKey: ws.isolation === 'worktree' ? ws.worktreeKey || `${agent}-${ws.id}` : undefined }
    setEditWorkspace(ws)
    setPresetId('')
    setWsName(ws.name); setWsCwd(ws.cwd); setWsNote(ws.note || ''); setWsModel(ws.model || ''); setWsModelAuto(false)
    // 老工作区可能没存过档位（字段后加）—— 按表单默认呈现，保存即落盘；
    // legacy skipPermissions=true 已在主进程归一化折叠成 bypassPermissions
    setWsClaudePermissions(ws.claudePermissions ?? DEFAULT_CLAUDE_PERMISSION_MODE)
    // 老工作区可能没存过档位（字段后加）—— 按表单默认 :workspace 呈现，保存即落盘
    setWsCodexPermissions(ws.codexPermissions ?? DEFAULT_CODEX_PERMISSION_PROFILE)
    setWsIsolation(ws.isolation === 'worktree' ? 'worktree' : 'shared')
    setWsWorktreeKey(ws.worktreeKey || '')
    // 编辑既有工作区永不自动派生：key 即 worktree 身份，改名不该换树
    setWsKeyAuto(false); setWsKeyCode(generateWorktreeCode())
    // 绑定的变量组已被删除时按「跟随已启用」呈现 —— 与主进程 resolveWorkspaceEnv 的回落一致，
    // 否则选择器会显示成「什么都没选中」，看不出实际会用哪份变量。
    // 但这条归一化只在变量组列表确实拉到之后才成立：工作区与变量组是两条并发 IPC，
    // 若在变量组返回前（或它拉失败时）点编辑，envProfiles 还是 []，会把有效绑定误判成悬空，
    // 保存后绑定就没了。列表状态未知时一律透传原值。
    setWsEnvProfileId(
      !envProfilesLoaded || (ws.envProfileId && envProfiles.some((p) => p.id === ws.envProfileId))
        ? ws.envProfileId
        : undefined
    )
    setTriedSubmit(false); setConfirmDelete(false); setSaveError(null)
    setShowDialog(true)
  }
  /**
   * 复制工作区：以既有配置预填「新增」对话框（名称加后缀便于区分），保存才落盘，取消无副作用。
   * envProfileId 归一化与 handleEdit 同一条规则 —— 别把源工作区的悬空绑定原样带进副本。
   */
  const handleDuplicateWorkspace = (ws: HarnessWorkspace) => {
    if (savingRef.current) return
    setEditWorkspace(undefined)
    setWsName(`${ws.name}${t(`${prefix}.copySuffix`)}`)
    setWsCwd(ws.cwd); setWsNote(ws.note || ''); setWsModel(ws.model || ''); setWsModelAuto(false)
    setWsClaudePermissions(ws.claudePermissions ?? DEFAULT_CLAUDE_PERMISSION_MODE)
    setWsCodexPermissions(ws.codexPermissions ?? DEFAULT_CODEX_PERMISSION_PROFILE)
    setWsIsolation(ws.isolation === 'worktree' ? 'worktree' : 'shared')
    setWsWorktreeKey(ws.worktreeKey || '')
    // 源是私有 worktree（无显式 key）时直接给副本自动派生新 key：副本是新 id，本就各用各的树；
    // 源有显式 key 则照抄（沿用现状语义：副本与源共用同一 worktree —— 同名共享本就是显式 key 的功能）。
    // key 用局部值（副本名 + 新时间戳）计算，避免读到尚未生效的 state。
    const dupCode = generateWorktreeCode()
    setWsKeyAuto(ws.isolation === 'worktree' && !(ws.worktreeKey || '').trim())
    setWsKeyCode(dupCode)
    const duplicateKey = ws.isolation === 'worktree' && !(ws.worktreeKey || '').trim()
      ? generateWorktreeKey(agent, `${ws.name}${t(`${prefix}.copySuffix`)}`, dupCode)
      : ws.worktreeKey
    presetTargetRef.current = { ...ws, name: `${ws.name}${t(`${prefix}.copySuffix`)}`, worktreeKey: duplicateKey }
    if (ws.isolation === 'worktree' && !(ws.worktreeKey || '').trim()) {
      setWsWorktreeKey(duplicateKey || '')
    }
    setWsEnvProfileId(
      !envProfilesLoaded || (ws.envProfileId && envProfiles.some((p) => p.id === ws.envProfileId))
        ? ws.envProfileId
        : undefined
    )
    setTriedSubmit(false); setConfirmDelete(false); setSaveError(null)
    setShowDialog(true)
  }
  const handlePickCwd = async () => {
    const result = await window.electronAPI.showOpenDialog({
      title: t(`${prefix}.browse`),
      defaultPath: wsCwd && !wsCwd.startsWith('~') ? wsCwd : undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result && !result.canceled && result.filePaths.length > 0) {
      const dir = result.filePaths[0]
      setWsCwd(dir)
      // 名称为空时自动用「目录基名-时间戳」填充（镜像 agent 交互减少手填；时间戳与默认名同一
      // 分钟级格式 YYYYMMDD-HHmm —— worktree key 的代号段是秒级，见 generateWorktreeCode。
      // 分钟粒度：同一目录同分钟连建两个会完全重名）。
      // 走 updateWsName 而非直接 setWsName：worktree 自动模式下 key 的名称段要跟着刷新
      if (!wsName.trim()) {
        const base = dir.split(/[\\/]/).filter(Boolean).pop() || dir
        updateWsName(`${base}-${generateWorktreeStamp()}`)
      }
    }
  }
  const valid = usePreset ? !presetId || presets.some(preset => preset.id === presetId) : wsCwd.trim().length > 0
  // worktree 生效 key 与路径预览派生值：显式 key 优先；空 key 的既有工作区预览回落私有
  // kind-<id>（迁移前的旧形态 —— 实际启动时 resolveLaunchWorktree 会生成可读 key 并把旧
  // worktree 原地改名迁移，启动时刻的时间戳无法预知，故预览只能显示旧路径）；新工作区空 key 则
  // id 保存后才存在，无法预览
  const effectiveWorktreeKey = wsWorktreeKey.trim().length > 0
    ? wsWorktreeKey.trim()
    : editWorkspace ? `${agent}-${editWorkspace.id}` : null
  // 完整路径预览：joinWorktreePath 沿用主进程返回根路径里的原生分隔符，渲染层不猜平台
  const effectiveWorktreePath = wtRoot && effectiveWorktreeKey
    ? joinWorktreePath(wtRoot, effectiveWorktreeKey)
    : null
  const handleSave = async () => {
    if (savingRef.current) return
    if (!valid) { setTriedSubmit(true); return }
    setSaveError(null)
    // 名称留空 → 默认名「工作区-<时间戳>」（本地时间分钟级 YYYYMMDD-HHmm；worktree key 的
    // 代号段是秒级时间戳，同名工作区不会共用树）。分钟粒度 —— 同一分钟内连建多个会重名，
    // 列表里靠下方 cwd 行区分
    const name = wsName.trim() || `${t(`${prefix}.wsDefaultName`)}-${generateWorktreeStamp()}`
    const cwd = wsCwd.trim()
    // 备注：仅 dsh 有此字段（hasWorkspaceNote）。codex/claude 字段不可见时透传历史值 ——
    // UI 退场不该让「改个名字」顺手清掉 JSON 里的旧备注（静默数据丢失，同 legacy env 的保留策略）
    const note = view.hasWorkspaceNote ? wsNote.trim() || undefined : editWorkspace?.note
    const model = wsModel.trim()
    const modelPayload = model.length > 0 ? model : undefined
    // 权限模式：仅 claude 有此下拉（其余 kind 连键都不带，主进程也按 kind 忽略）；
    // 表单恒有选中值，保存即显式落盘（default 档 = 不追加参数的 CLI 默认形态）
    const claudePermissionsPayload = view.hasClaudePermissions
      ? { claudePermissions: wsClaudePermissions }
      : {}
    // 权限档位：仅 codex 有此下拉（门控同上）；表单恒有选中值，保存即显式落盘
    const codexPermissionsPayload = view.hasCodexPermissions
      ? { codexPermissions: wsCodexPermissions }
      : {}
    // order 由主进程仓库分配递增，前端不再传 workspaces.length（删除后可能产生重复）
    // envProfileId 传 undefined 即「跟随已启用的变量组」；主进程按「键存在」判断，故必须显式带上这个键
    // worktreeKey 同理：空串 trim 后传 undefined = 私有 worktree（键必须显式存在才能清掉旧共享名）
    const worktreeKeyPayload = wsWorktreeKey.trim().length > 0 ? wsWorktreeKey.trim() : undefined
    const managedTarget = usePreset ? { workspacePresetId: presetId || undefined } : {}
    savingRef.current = true
    setSaving(true)
    try {
      const res = editWorkspace
        ? await api.update({ ...editWorkspace, ...managedTarget, name, cwd, note, model: modelPayload, envProfileId: wsEnvProfileId, isolation: wsIsolation, worktreeKey: worktreeKeyPayload, ...claudePermissionsPayload, ...codexPermissionsPayload })
        : await api.add({ ...managedTarget, name, cwd, note, model: modelPayload, envProfileId: wsEnvProfileId, isolation: wsIsolation, worktreeKey: worktreeKeyPayload, ...claudePermissionsPayload, ...codexPermissionsPayload })
      // 保存失败（校验未通过 / 落盘失败）：保留表单，展示具体错误，不关闭对话框
      if (res && res.success === false) {
        setSaveError(typeof res.error === 'string' ? res.error : t(`${prefix}.wsSaveFailed`))
        return
      }
      await loadWorkspaces()
      setShowDialog(false)
      if (agent !== 'dsh') requestAnimationFrame(() => document.getElementById(`${agent}-workspace-${editWorkspace?.id ?? 'add'}`)?.focus())
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t(`${prefix}.wsSaveFailed`))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const handleDelete = async () => {
    if (savingRef.current) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    if (editWorkspace) {
      savingRef.current = true
      setSaving(true)
      try {
        const result = await api.delete(editWorkspace.id)
        if (result && result.success === false) {
          setSaveError(typeof result.error === 'string' ? result.error : t(`${prefix}.wsDeleteFailed`))
          return
        }
        await loadWorkspaces()
        setShowDialog(false)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : t(`${prefix}.wsDeleteFailed`))
      } finally { savingRef.current = false; setSaving(false) }
    }
  }

  // ── 变量组：单选启用（增删改在左侧「环境变量」面板，本页签只拨指针） ──
  const activeProfile = envProfiles.find((p) => p.id === activeProfileId)
  // 工作区表单实际生效的变量组（显式绑定 → 已启用组，与主进程 resolveWorkspaceEnv 同一条链）；
  // 其模型选项排在内置建议之前，供工作区「模型」输入框的 datalist
  const effectiveProfile = envProfiles.find((p) => p.id === wsEnvProfileId) ?? activeProfile
  const modelSuggestions = [
    ...new Set([...(effectiveProfile?.models ?? []), ...view.modelSuggestions])
  ]
  /**
   * 选中/切换变量组时模型默认跟随：自动档位（或模型为空）下取「生效变量组」的首个模型选项
   * 预填 —— 与 datalist 建议同一条生效链（显式绑定 → 已启用组）。手动改过模型则不覆盖；
   * 跟随档位同样生效（其生效组就是已启用组）。自动档位下切到无模型选项的组时清掉旧值，
   * 避免残留上一个组的模型。
   */
  const selectEnvProfile = (profileId: string | undefined) => {
    setWsEnvProfileId(profileId)
    if (!wsModelAuto && wsModel.trim().length > 0) return
    const effective = envProfiles.find((p) => p.id === profileId) ?? activeProfile
    const first = effective?.models?.[0]
    if (first) {
      setWsModel(first)
      setWsModelAuto(true)
    } else if (wsModelAuto) {
      setWsModel('')
      setWsModelAuto(false)
    }
  }

  const missing: string[] = status ? deps.filter((d) => !status[d]) : []
  // 标题按钮：有 Web UI 的 kind（dsh）总是可点 —— 直接开 Web，落在 deepseek-harness 自己的
  // 默认工作区（$DSH_HOME/web），与 TUI 工作区解耦。
  const titleEnabled = view.hasWeb && listReady && !webOpening
  const handleNameplate = (): void => {
    if (webOpening) return
    setWebOpening(true)
    setActionError(null)
    // 缺省 target：主进程落到 dsh 专属默认工作区（$DSH_HOME/web）。环境走「已启用组 → 系统」。
    void (async () => {
      try {
        const res = await onOpenWeb?.({})
        if (res && res.success === false) {
          setActionError(typeof res.error === 'string' && res.error ? res.error : t(`${prefix}.webFailed`))
        }
      } catch (err) {
        console.error(`${agent} web open failed:`, err)
        setActionError(err instanceof Error ? err.message : t(`${prefix}.webFailed`))
      } finally {
        setWebOpening(false)
      }
    })()
  }

  const renderWorkspaceEditor = (inline: boolean) => (
    <div className={cn('min-w-0 bg-[var(--bg-rack)]', inline && 'harness-inline-editor')}>
      <fieldset disabled={saving} className="min-w-0 border-0 p-0 m-0">
            {!inline && <DialogClose onClose={closeEditor} />}
            {inline ? <div className="harness-editor-heading">
              <h3>{editWorkspace ? t('harnessLauncher.launchSettings') : t(`${prefix}.wsAddTitle`)}</h3>
              {editWorkspace && <button type="button" title={t(`${prefix}.copy`)} aria-label={t(`${prefix}.copy`)}
                className="harness-editor-icon" onClick={() => handleDuplicateWorkspace(editWorkspace)}><IconCopy /></button>}
            </div> :
            <div className="flex items-center h-10 px-4 border-b border-[var(--rule)] gap-2.5">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: 'var(--amber)', boxShadow: '0 0 5px var(--amber)' }}
              />
              <span className="text-[13px] [font-family:inherit] font-medium tracking-[0.04em] text-[var(--text-rack)]">
                {editWorkspace ? t(`${prefix}.wsEditTitle`) : t(`${prefix}.wsAddTitle`)}
              </span>
              <span className="flex-1" />
              <span className="text-[10.5px] [font-family:inherit] tracking-[0.08em] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] text-[var(--text-rack-mute)]">
                {agent.toUpperCase()}
              </span>
            </div>}

            {usePreset ? <div className="harness-editor-preset">
              <div className="harness-editor-label">
                <label htmlFor={`${agent}-preset-select`}>{t('settings.workspace')}</label>
                {onOpenWorkspaceSettings && <button type="button" onClick={onOpenWorkspaceSettings}>{t('workspacePresets.manage')}</button>}
              </div>
              <WorkspaceSelect id={`${agent}-preset-select`} autoFocus className="rack-select" title={selectedPreset ? formatCodeWorkspaceName(selectedPreset) : undefined} value={presetId} onChange={event => { const preset = presets.find(item => item.id === event.target.value); if (preset) selectPreset(preset); else { presetTargetRef.current = { id: '', name: wsName, cwd: '', order: 0 }; setPresetId(''); setWsCwd(''); setWsIsolation('shared'); setWsWorktreeKey('') } }}>
                <option value="">{t('workspacePresets.unassigned')}</option>
                {presets.map(preset => <option key={preset.id} value={preset.id}>{formatCodeWorkspaceName(preset)}</option>)}
              </WorkspaceSelect>
              {presetId && <div className="harness-editor-location">
                <p title={wsCwd}>{wsCwd}</p>
                <span title={t(wsIsolation === 'worktree' ? `${prefix}.wsIsolationWorktree` : `${prefix}.wsIsolationShared`)}>
                  <IconFolder />
                  {t(wsIsolation === 'worktree' ? 'workspacePresets.dedicatedWorktree' : 'workspacePresets.sharedDirectory')}
                </span>
              </div>}
              {!presetId && <p className="harness-editor-hint">{t('workspacePresets.unassignedHint')}</p>}
            </div> : <>
            {/* 名称 —— label 与输入框同行（label 定宽，与下方模型行对齐） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)] flex items-center gap-3">
              <span className="flex-shrink-0 w-[3.5rem] text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsName`)}</span>
              <input
                type="text"
                aria-label={t(`${prefix}.wsName`)}
                value={wsName}
                onChange={(e) => updateWsName(e.target.value)}
                placeholder={t(`${prefix}.wsNamePh`)}
                autoFocus
                className="flex-1 min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* 工作目录 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsCwd`)}</span>
              </div>
              <div className="flex items-stretch gap-1.5">
                <input
                  type="text"
                  aria-label={t(`${prefix}.wsCwd`)}
                  value={wsCwd}
                  onChange={(e) => { setWsCwd(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
                  placeholder={t(`${prefix}.wsCwdPh`)}
                  className="flex-1 min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
                />
                <button
                  type="button"
                  onClick={() => void handlePickCwd()}
                  title={t(`${prefix}.browse`)}
                  className="flex-shrink-0 w-[34px] inline-flex items-center justify-center bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[var(--text-rack-mute)] hover:text-[var(--amber)] hover:border-[var(--amber)] transition-colors cursor-pointer"
                >
                  <IconFolder />
                </button>
              </div>
            </div>

            {/* 目录隔离 —— 直接在 cwd 启动，或仓库根下的专属 git worktree（多 agent 同仓互不踩踏） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsIsolation`)}</span>
              </div>
              <div role="radiogroup" aria-label={t(`${prefix}.wsIsolation`)} className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm overflow-hidden">
                <button
                  type="button"
                  role="radio"
                  aria-checked={wsIsolation === 'shared'}
                  onClick={() => selectIsolation('shared')}
                  className="relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0 bg-transparent cursor-pointer hover:bg-[var(--bg-slot)] transition-colors"
                >
                  <BusLed on={wsIsolation === 'shared'} />
                  <span className="flex-1 min-w-0 text-[12px] [font-family:inherit] text-[var(--text-rack)] truncate">
                    {t(`${prefix}.wsIsolationShared`)}
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={wsIsolation === 'worktree'}
                  onClick={() => selectIsolation('worktree')}
                  className="relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0 bg-transparent cursor-pointer hover:bg-[var(--bg-slot)] transition-colors"
                >
                  <BusLed on={wsIsolation === 'worktree'} />
                  <span className="flex-1 min-w-0 text-[12px] [font-family:inherit] text-[var(--text-rack)] truncate">
                    {t(`${prefix}.wsIsolationWorktree`)}
                  </span>
                </button>
              </div>
              {/* 共享名：仅 worktree 模式有意义。切到 worktree 时自动生成 <kind>-<名称>-<时间戳> 预填（可改可清空，
                  空则私有各用各的树）；datalist 下拉列出该仓库已有的共享名 —— 选中即加入既有 worktree，也可自由输入 */}
              {wsIsolation === 'worktree' && (
                <>
                  <input
                    type="text"
                    list={`${agent}-worktree-keys`}
                    value={wsWorktreeKey}
                    onChange={(e) => { setWsKeyAuto(false); setWsWorktreeKey(e.target.value) }}
                    placeholder={t(`${prefix}.wsWorktreeKeyPh`)}
                    className="mt-2 w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
                  />
                  <datalist id={`${agent}-worktree-keys`}>
                    {wtKeys.map((k) => (
                      <option key={k} value={k} />
                    ))}
                  </datalist>
                  {/* 路径预览：选定 worktree 即可见完整路径与分支（实际目录点击启动时才创建） */}
                  <div className="mt-1.5 px-0.5 text-[11px] leading-[1.6] [font-family:inherit] text-[var(--text-rack-data)] select-text break-all">
                    {effectiveWorktreeKey ? (
                      <>
                        <div title={effectiveWorktreePath ?? undefined}>
                          {t(`${prefix}.wsWorktreePath`)}{' '}
                          {effectiveWorktreePath ?? t(`${prefix}.wsWorktreeNoRepo`)}
                        </div>
                        <div>
                          {t(`${prefix}.wsWorktreeBranch`)} {`${BRANCH_PREFIX}/${effectiveWorktreeKey}`}
                          <span className="mx-1.5 opacity-60">·</span>
                          {t(`${prefix}.wsWorktreeLaunchNote`)}
                        </div>
                        {wsKeyAuto && <div>{t(`${prefix}.wsWorktreeAutoHint`)}</div>}
                      </>
                    ) : (
                      <div>{t(`${prefix}.wsWorktreePrivateHint`)}</div>
                    )}
                  </div>
                </>
              )}
            </div>

            </>}
            {/* 备注（可选，仅用于记录）—— 仅 dsh 保留（hasWorkspaceNote）；codex/claude 表单更紧凑，备注退场 */}
            {view.hasWorkspaceNote && (
              <div className="py-3.5 px-4 border-b border-[var(--rule)]">
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--text-rack)]">{t(`${prefix}.wsNote`)}</span>
                </div>
                <textarea
                  value={wsNote}
                  onChange={(e) => setWsNote(e.target.value)}
                  placeholder={t(`${prefix}.wsNotePh`)}
                  rows={2}
                  className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)] resize-none"
                />
              </div>
            )}

            <details className={cn('harness-advanced-options', (inline || agent === 'dsh') && '[&>summary]:hidden')} open={inline || agent === 'dsh' ? true : undefined}>
              <summary className="px-4 py-3 cursor-pointer text-[12px] text-[var(--text-rack-data)]">{t('workspacePresets.advanced')}</summary>
            {/* 模型 —— dsh 走补丁、codex/claude 走 --model；留空则用各 CLI 默认。
                label 与输入框同行（label 定宽，与上方名称行对齐） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)] flex items-center gap-3">
              <span className="flex-shrink-0 w-[3.5rem] text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsModel`)}</span>
              {inline ? <RackCombobox value={wsModel} options={modelSuggestions} label={t(`${prefix}.wsModel`)}
                optionsLabel={t('workspacePresets.modelSuggestions')} emptyText={t('workspacePresets.customModel')}
                placeholder={t(`${prefix}.wsModelPh`)} disabled={saving}
                onChange={value => { setWsModel(value); setWsModelAuto(false) }} /> : <><input
                type="text"
                list={`${agent}-model-suggestions`}
                aria-label={t(`${prefix}.wsModel`)}
                value={wsModel}
                onChange={(e) => { setWsModel(e.target.value); setWsModelAuto(false) }}
                placeholder={t(`${prefix}.wsModelPh`)}
                className="flex-1 min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
              <datalist id={`${agent}-model-suggestions`}>
                {modelSuggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              </>}
            </div>

            {/* 环境变量 —— 选一组预配置变量；不选则跟随已启用的那组（三级链在这里就地摊开）。
                原生 select（与权限档位下拉同款机柜样式，选项名后缀变量数）；「跟随」档位的
                解析结果摊开在下沿提示行，免得用户还要切页签才知道实际会用哪份 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex flex-wrap items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsEnvProfile`)}</span>
                {onOpenEnvSettings && <button type="button" className="ml-auto text-[12px] text-[var(--text-rack-data)] hover:text-[var(--amber)] underline underline-offset-2" onClick={onOpenEnvSettings}>{t('env.manage')}</button>}
              </div>
              <WorkspaceSelect
                value={wsEnvProfileId ?? ''}
                onChange={(e) => selectEnvProfile(e.target.value || undefined)}
                aria-label={t(`${prefix}.wsEnvProfile`)}
                className={inline ? 'rack-select' : 'w-full px-2 py-1.5 border rounded-[2px] text-[12px] [font-family:inherit] cursor-pointer focus:outline-none focus:border-[var(--amber)] transition-colors bg-[var(--bg-base)] border-[var(--rule)] text-[var(--text-rack)]'}
              >
                {/* 空值 = 「跟随」：主进程按 envProfileId 缺省回落全局启用指针 */}
                <option value="">{t(`${prefix}.wsEnvFollow`)}</option>
                {envProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {t(`${prefix}.envVars`, { count: Object.keys(p.env).length })}
                  </option>
                ))}
              </WorkspaceSelect>
              {/* 跟随档位选中时才显示：显式绑定自明，不占行。一个组都没有时直接摊开空态说明 */}
              {wsEnvProfileId === undefined && (
                <div className="harness-editor-hint mt-1.5 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] leading-snug">
                  {envProfiles.length === 0
                    ? t(`${prefix}.wsEnvNone`)
                    : t(`${prefix}.wsEnvFollowNow`, { name: activeProfile ? activeProfile.name : t(`${prefix}.envSystem`) })}
                </div>
              )}
            </div>

            {/* 权限模式（仅 claude）—— bypassPermissions 档启动追加 --dangerously-skip-permissions
                （直连 flag，等价 --permission-mode bypassPermissions 但后者需额外设置），
                acceptEdits/plan 档追加 --permission-mode <mode>，default 不追加。
                原生 select（与 codex 权限档位下拉同款机柜样式）；选中 bypassPermissions 时
                换 .danger-field 危险态皮肤（红染底 + 左沿条纹导轨 + 红字）+ 附警示行
                —— 完全放开是用户显式选的危险形态 */}
            {view.hasClaudePermissions && (
              <div className="py-3.5 px-4 border-b border-[var(--rule)]">
                <div className="mb-2">
                  <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsPermissions`)}</span>
                </div>
                <WorkspaceSelect
                  value={wsClaudePermissions}
                  onChange={(e) => setWsClaudePermissions(e.target.value as ClaudePermissionMode)}
                  aria-label={t(`${prefix}.wsPermissions`)}
                  className={cn(
                    inline ? 'rack-select' : 'w-full px-2 py-1.5 border rounded-[2px] text-[12px] [font-family:inherit] cursor-pointer focus:outline-none focus:border-[var(--amber)] transition-colors',
                    wsClaudePermissions === 'bypassPermissions'
                      ? 'danger-field'
                      : !inline && 'bg-[var(--bg-base)] border-[var(--rule)] text-[var(--text-rack)]'
                  )}
                >
                  <option value="default">{t(`${prefix}.wsPermDefault`)}</option>
                  <option value="acceptEdits">{t(`${prefix}.wsPermAcceptEdits`)}</option>
                  <option value="plan">{t(`${prefix}.wsPermPlan`)}</option>
                  <option value="bypassPermissions">{t(`${prefix}.wsPermBypass`)}</option>
                </WorkspaceSelect>
                {wsClaudePermissions === 'bypassPermissions' && (
                  <div className="mt-1.5 text-[10.5px] [font-family:inherit] text-[var(--error-rack)] leading-snug">
                    {t(`${prefix}.wsPermBypassDangerHint`)}
                  </div>
                )}
              </div>
            )}

            {/* 权限档位（仅 codex）—— 启动追加 -c default_permissions=<档位>。
                原生 select（沿用设置面板下拉的机柜样式）；选中 :danger-full-access 时
                换 .danger-field 危险态皮肤（红染底 + 左沿条纹导轨 + 红字）+ 附警示行
                —— 完全放开是用户显式选的危险形态 */}
            {view.hasCodexPermissions && (
              <div className="py-3.5 px-4 border-b border-[var(--rule)]">
                <div className="mb-2">
                  <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsPermissions`)}</span>
                </div>
                <WorkspaceSelect
                  value={wsCodexPermissions}
                  onChange={(e) => setWsCodexPermissions(e.target.value as CodexPermissionProfile)}
                  aria-label={t(`${prefix}.wsPermissions`)}
                  className={cn(
                    inline ? 'rack-select' : 'w-full px-2 py-1.5 border rounded-[2px] text-[12px] [font-family:inherit] cursor-pointer focus:outline-none focus:border-[var(--amber)] transition-colors',
                    wsCodexPermissions === ':danger-full-access'
                      ? 'danger-field'
                      : !inline && 'bg-[var(--bg-base)] border-[var(--rule)] text-[var(--text-rack)]'
                  )}
                >
                  <option value=":read-only">{t(`${prefix}.wsPermReadOnly`)}</option>
                  <option value=":workspace">{t(`${prefix}.wsPermWorkspace`)}</option>
                  <option value=":danger-full-access">{t(`${prefix}.wsPermDanger`)}</option>
                </WorkspaceSelect>
                {wsCodexPermissions === ':danger-full-access' && (
                  <div className="mt-1.5 text-[10.5px] [font-family:inherit] text-[var(--error-rack)] leading-snug">
                    {t(`${prefix}.wsPermDangerHint`)}
                  </div>
                )}
              </div>
            )}

            </details>
            {/* 校验提示（仅尝试提交后显示） */}
            {triedSubmit && !valid && (
              <div role="alert" className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)]">
                {t(`${prefix}.wsRequired`)}
              </div>
            )}

            {/* 保存失败提示（校验未通过 / 落盘失败，保留表单） */}
            {saveError && (
              <div role="alert" className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)] break-all">
                {saveError}
              </div>
            )}

            {/* footer：删除（两步确认）/ 取消 / 保存 */}
            <div className="harness-editor-actions flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              {editWorkspace ? (
                <button
                  onClick={() => void handleDelete()}
                  className={
                    confirmDelete
                      ? 'px-2.5 py-1 text-[12px] [font-family:inherit] rounded-sm bg-[var(--error-rack)] text-[var(--bg-base)] font-medium transition-colors'
                      : 'px-2.5 py-1 text-[12px] [font-family:inherit] text-[var(--error-rack)] hover:bg-[var(--bg-slot)] rounded-sm transition-colors'
                  }
                >
                  {confirmDelete ? t(`${prefix}.wsConfirmDelete`) : t(`${prefix}.wsDelete`)}
                </button>
              ) : (
                <span />
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  onClick={closeEditor}
                  className="harness-editor-cancel px-3 py-1 text-[13px] [font-family:inherit] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
                >
                  {t(`${prefix}.wsCancel`)}
                </button>
                <button
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className={`px-4 py-1 text-[13px] [font-family:inherit] rounded-sm font-medium transition-opacity ${
                    valid
                      ? 'bg-[var(--amber)] text-[var(--bg-base)] hover:opacity-90'
                      : 'bg-[var(--bg-slot)] text-[var(--text-rack-dim)] opacity-70'
                  }`}
                >
                  {saving ? t('workspacePresets.saving') : t(`${prefix}.wsSave`)}
                </button>
              </div>
            </div>
      </fieldset>
    </div>
  )

  // Codex / Claude 的名称行展开预设与启动配置，独立按钮启动；组内顺序沿用仓库顺序。
  const renderWorkspaceCard = (ws: HarnessWorkspace) => {
    const launching = launchingId === ws.id
    // 显式绑定的变量组（悬空绑定不显示 —— 主进程会回落已启用组，标出来反而误导）
    const boundProfile = ws.envProfileId
      ? envProfiles.find((p) => p.id === ws.envProfileId)
      : undefined
    // 危险态：codex 完全放开档 / claude bypassPermissions 档 —— 卡片整体换
    // .danger-card（红染底 + 左沿条纹导轨，与表单同语），点之前就看得见
    // 这是个绕过审批跑的工作区
    const dangerPerm =
      ws.codexPermissions === ':danger-full-access' || ws.claudePermissions === 'bypassPermissions'
    // Codex / Claude 点击名称展开行内配置，目录与分支图标区分目标类型。
    // DeepSeek 保留完整信息卡和单击启动。
    const folded = agent !== 'dsh'
    const detailOpen = folded && showDialog && editWorkspace?.id === ws.id
    const toggleEditor = () => { if (detailOpen) closeEditor(); else handleEdit(ws) }
    const detailId = `harness-ws-detail-${ws.id}`
    if (folded) {
      const scenePreset = findManagedWorkspace(ws, presets, window.electronAPI.platform)
      const fullName = formatCodeWorkspaceName(ws)
      const isWorktree = ws.isolation === 'worktree'
      const worktreeName = isWorktree ? ws.worktreeKey : undefined
      const suffix = worktreeName ? ` · ${worktreeName}` : ''
      const baseName = suffix && ws.name.endsWith(suffix) ? ws.name.slice(0, -suffix.length) : ws.name
      const modelLabel = ws.model || t('harnessLauncher.defaultModel')
      const environmentLabel = boundProfile?.name || activeProfile?.name || t(`${prefix}.envSystem`)
      const permissionLabel = dangerPerm
        ? t('harnessLauncher.fullAccess')
        : ws.codexPermissions === ':read-only'
          ? t('harnessLauncher.readOnly')
          : agent === 'claude' && ws.claudePermissions === 'plan'
            ? t(`${prefix}.wsPermPlan`)
            : agent === 'claude' && ws.claudePermissions === 'acceptEdits'
              ? t(`${prefix}.wsPermAcceptEdits`)
              : undefined
      return <div key={ws.id} className="harness-workspace-item">
        <div className={cn('harness-project-row', { 'is-expanded': detailOpen, 'is-danger': dangerPerm, 'is-launching': launching })}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); handleEdit(ws) }}>
          <button type="button" id={`${agent}-workspace-${ws.id}`} className="harness-workspace-main"
            aria-label={fullName} aria-expanded={detailOpen} aria-controls={detailId}
            title={fullName} disabled={saving} onClick={toggleEditor}>
            <span className="harness-workspace-symbol" aria-hidden="true">
              {isWorktree ? <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="4" r="2" /><circle cx="6" cy="16" r="2" /><circle cx="15" cy="5" r="2" /><path d="M6 6v8m0-3c6 0 9-1 9-4" />
              </svg> : <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 8h14M7 4v12" />
              </svg>}
            </span>
            <span className="harness-workspace-content">
            <span className="harness-workspace-name">
              {worktreeName && baseName ? <>
                <span className="harness-workspace-prefix">{baseName}</span>
                <span className="harness-workspace-separator"> · </span>
                <span className="harness-workspace-branch">{worktreeName}</span>
              </> : <span className="harness-workspace-branch">{fullName}</span>}
            </span>
            <span className="harness-workspace-summary" title={`${modelLabel} · ${environmentLabel}`}>
              <span className="harness-workspace-model">{modelLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="harness-workspace-environment">{environmentLabel}</span>
              {permissionLabel && <span className={cn('harness-workspace-permission', dangerPerm && 'is-danger')} title={dangerPerm ? t('harnessLauncher.fullAccessHint') : permissionLabel}>{permissionLabel}</span>}
            </span>
            </span>
          </button>
          {scenePreset && <ProjectSceneProjectActions preset={scenePreset} />}
          <button type="button" className="harness-project-launch" disabled={!!launchingId || saving}
            aria-busy={launching}
            aria-label={`${t(`${prefix}.launch`)} · ${fullName}`} title={`${t(`${prefix}.launch`)} · ${fullName}`}
            onClick={() => void handleLaunch(ws)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="m5 3 8 5-8 5Z" /></svg>
            <span>{launching ? t('harnessLauncher.launching') : t('workspacePresets.launch')}</span>
          </button>
        </div>
        <div id={detailId} hidden={!detailOpen} className="harness-workspace-editor">
          {detailOpen && visible && renderWorkspaceEditor(true)}
        </div>
      </div>
    }
    return (
      <div key={ws.id} className="min-w-0">
      <div
        onClick={() => void handleLaunch(ws)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleEdit(ws) }}
        onMouseLeave={() => { if (deleteConfirmId === ws.id) setDeleteConfirmId(null) }}
        title={t(`${prefix}.launch`)}
        className={cn(
          'group relative flex items-start gap-2.5 px-2 py-1.5 rounded-[2px] cursor-pointer border transition-colors overflow-hidden',
          // 常规面 = 槽位色 bg-slot（比面板底高两档，与 bg-base 沟拉开卡界），
          // 悬停 elev 再提一档；危险态染底配方见 .danger-card（同走 slot 基）
          dangerPerm ? 'danger-card' : 'border-[var(--rule)] bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)]',
          launching && 'opacity-60 cursor-wait'
        )}
      >
        <span className={cn(
          '-mt-0.5 flex-shrink-0 w-[20px] h-[20px] inline-flex items-center justify-center transition-colors',
          dangerPerm ? 'text-[var(--error-rack)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--amber)]'
        )}>
          <IconFolder />
        </span>
        <span className="flex flex-col min-w-0 flex-1">
          {/* 名称行 —— 卡面唯一的常显行(行首下拉 + 目录图标 + 名称 + 启动中)。
              悬停操作簇以这一行为定位容器(而不是整张卡):详情展开后卡会变高,
              按钮不能跟着沉到详情区去盖住标注 */}
          <span className="relative flex min-w-0 items-center">
            <button type="button" id={`${agent}-workspace-${ws.id}`} disabled={saving}
              onClick={e => { e.stopPropagation(); void handleLaunch(ws) }}
              title={ws.name} className="flex-1 min-w-0 text-left text-[13px] [font-family:inherit] font-medium text-[var(--text-rack)] truncate leading-tight focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--amber)]">
              {ws.name}
              {launching && <span className="ml-1.5 text-[10.5px] [font-family:inherit] text-[var(--amber)]">{t(`${prefix}.launching`)}</span>}
            </button>
            {/* 悬停操作簇遮罩颜色跟悬停面色(elev)—— 用面色的不透明渐变盖住按钮底下的字；
                focus-within 同步显形，键盘 Tab 聚到按钮时不必悬停也能操作 */}
            <div className="absolute -right-0.5 top-1/2 -translate-y-1/2 flex gap-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto pl-6 bg-gradient-to-l from-[var(--bg-elev)] from-[24%] to-transparent">
              <button
                disabled={saving}
                onClick={(e) => { e.stopPropagation(); handleDuplicateWorkspace(ws) }}
                title={t(`${prefix}.copy`)}
                className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
              >
                <IconCopy />
              </button>
              <button
                disabled={saving}
                onClick={(e) => { e.stopPropagation(); handleEdit(ws) }}
                title={t(`${prefix}.wsEditTitle`)}
                className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
              >
                <IconEdit />
              </button>
              <button
                disabled={saving}
                onClick={async (e) => {
                  e.stopPropagation()
                  if (savingRef.current) return
                  // 两步确认：首次点击切到确认态，再次点击才真正删除（与对话框一致）
                  if (deleteConfirmId !== ws.id) {
                    setDeleteConfirmId(ws.id)
                    return
                  }
                  setDeleteConfirmId(null)
                  // 失败(落盘失败/工作区已不存在)不静默:卡片在下方 loadWorkspaces()
                  // "复活"前给出原因 —— 与 Agent/变量组卡同一族错误位
                  savingRef.current = true
                  setSaving(true)
                  try {
                    const res = await api.delete(ws.id)
                    if (res && res.success === false) {
                      setActionError(typeof res.error === 'string' ? res.error : t(`${prefix}.wsDeleteFailed`))
                    }
                  } catch (err) {
                    setActionError(err instanceof Error ? err.message : t(`${prefix}.wsDeleteFailed`))
                  } finally {
                    await loadWorkspaces()
                    savingRef.current = false
                    setSaving(false)
                  }
                }}
                title={deleteConfirmId === ws.id ? t(`${prefix}.wsConfirmDelete`) : t(`${prefix}.wsDelete`)}
                className={cn(
                  'w-[22px] h-[22px] inline-flex items-center justify-center border-none cursor-pointer rounded-[2px] transition-colors',
                  deleteConfirmId === ws.id
                    ? 'bg-[var(--error-rack)] text-[var(--bg-base)]'
                    : 'bg-transparent text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--error-rack)]'
                )}
              >
                <IconX />
              </button>
            </div>
          </span>
          <>
            {/* 绑定了变量组时标出来 —— 点这行即刻启动，用哪份密钥必须点之前就看得见 */}
            {boundProfile && (
              <span className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] leading-tight min-w-0">
                <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--amber)] flex-shrink-0" />
                <span className="truncate">{boundProfile.name}</span>
              </span>
            )}
            {/* worktree 隔离标出来（悬停见分支名；共享名随行显示）—— 在哪个树里跑是看得见的承诺 */}
            {agent === 'dsh' && ws.isolation === 'worktree' && (
              <span
                className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] leading-tight min-w-0"
                title={`lyshell/${ws.worktreeKey || `${agent}-${ws.id}`}`}
              >
                <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--text-rack-mute)] flex-shrink-0" />
                <span className="truncate">
                  {ws.worktreeKey
                    ? `${t(`${prefix}.wsIsolationBadge`)} · ${ws.worktreeKey}`
                    : t(`${prefix}.wsIsolationBadge`)}
                </span>
              </span>
            )}
            {/* claude 权限模式标出来 —— 行文即启动实际追加的参数（红=带电警示，
                危险态与卡片红染底同源；acceptEdits/plan 灰置，与 codex read-only
                角标同族），点之前就看得见；default 即 CLI 默认形态，不标 */}
            {ws.claudePermissions === 'bypassPermissions' && (
              <span className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--error-rack)] leading-tight min-w-0">
                <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--error-rack)] flex-shrink-0" />
                <span className="truncate">--dangerously-skip-permissions</span>
              </span>
            )}
            {(ws.claudePermissions === 'acceptEdits' || ws.claudePermissions === 'plan') && (
              <span className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] leading-tight min-w-0">
                <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--text-rack-mute)] flex-shrink-0" />
                <span className="truncate">--permission-mode {ws.claudePermissions}</span>
              </span>
            )}
            {/* 权限档位标出来 —— danger 红（错误令牌，与卡片危险态皮肤同源）；
                read-only 灰置（worktree 角标同族：在哪个权限下跑是看得见的承诺）；
                workspace/缺省即 Codex 默认形态，不标 */}
            {ws.codexPermissions === ':danger-full-access' && (
              <span className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--error-rack)] leading-tight min-w-0">
                <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--error-rack)] flex-shrink-0" />
                <span className="truncate">:danger-full-access</span>
              </span>
            )}
            {ws.codexPermissions === ':read-only' && (
              <span className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] leading-tight min-w-0">
                <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--text-rack-mute)] flex-shrink-0" />
                <span className="truncate">:read-only</span>
              </span>
            )}
            {view.hasWorkspaceNote && ws.note && (
              <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] truncate leading-tight">{ws.note}</span>
            )}
          </>
        </span>

      </div>
      </div>
    )
  }

  return (
    <div
      className={cn('w-full h-full flex flex-col', compactTree ? 'harness-launcher' : 'bg-[var(--bg-base)]')}
      style={compactTree ? undefined : { fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* DeepSeek 铭牌继续打开默认 Web UI；列表就绪后才提供新建工作区。 */}
      <PanelHeader
        title={t(`${prefix}.title`)}
        count={listReady ? wsGroups.reduce((count, [, list]) => count + list.length, 0) : undefined}
        countHint={t('panelHeader.workspaces')}
        onTitleClick={view.hasWeb ? handleNameplate : undefined}
        titleHint={view.hasWeb ? t(`${prefix}.webDefault`) : undefined}
        titleDisabled={!titleEnabled}
        actions={<>
          {listReady && wsGroups.length > 0 && <GroupListActions allCollapsed={allDirsCollapsed} allExpanded={allDirsExpanded} onChange={setAllDirsCollapsed} />}
          {onOpenEnvSettings && <IconBtn title={t('env.manage')} onClick={onOpenEnvSettings}><SettingsGlyph name="env" /></IconBtn>}
          {agent !== 'dsh' && onOpenWorkspaceSettings && <IconBtn title={t('workspacePresets.manage')} onClick={onOpenWorkspaceSettings}><SettingsGlyph name="workspace" /></IconBtn>}
          {listReady && <span id={`${agent}-workspace-add`} tabIndex={-1}><PanelHeaderAction label={t('panelHeader.create')} title={t(`${prefix}.wsAddTitle`)} onClick={handleAdd} /></span>}
          {!launchReady && (
            <button
              type="button"
              onClick={() => void runDetect()}
              disabled={detecting}
              className="win-no-drag px-2.5 py-1 text-[12.5px] rounded-[2px] border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              {detecting ? t(`${prefix}.detecting`) : t(`${prefix}.redetect`)}
            </button>
          )}
        </>}
      />

      {/* ===== 内容壳 ===== 头行以下整列离缘 6(mx-1.5) —— 与会话栏器物两端同线
          (栏内器物一律离缘,墙纸不再通铺到面板两缘);段内既有垫距保留;壳不
          定位,fixed 弹窗与绝对定位浮层不受影响 */}
      <div className={cn('flex-1 min-h-0 flex flex-col min-w-0', compactTree ? 'harness-launcher-content' : 'mx-1.5 pt-2')}>

      {/* 未就绪内容笼：依赖状态行 + 安装提示卡 —— 顶距统一由内容壳提供，
          侧距归内容壳（旧 px-3 已撤，不叠两层），头条满幅贴顶
          （与 PluginPanel 同构）。新增动作已上收头条右上角 chip，头顶不再有
          新增条分割线，恢复整段顶距。就绪态不走这层（见下方卡片区域） */}
      {!listReady && (
        <div className="flex-1 min-h-0 flex flex-col pb-3 space-y-2">
          <div className="space-y-1">
            {deps.map((dep) => {
              const installed = status ? Boolean(status[dep]) : null
              return (
                <div
                  key={dep}
                  className="flex items-center gap-2 border border-[var(--rule)] rounded-[2px] bg-[var(--bg-slot)] px-2 py-1.5"
                >
                  <span
                    aria-hidden
                    className="w-[6px] h-[6px] rounded-full flex-shrink-0"
                    style={{
                      backgroundColor:
                        installed === true
                          ? 'var(--amber)'
                          : installed === false
                            ? 'var(--rule)'
                            : 'transparent',
                      boxShadow: installed === true ? '0 0 5px var(--amber)' : 'none'
                    }}
                  />
                  <span className="font-mono text-[12px] [font-family:inherit] text-[var(--text-rack)]">{dep}</span>
                  <span className="flex-1" />
                  {installed === null ? (
                    <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">{t(`${prefix}.detecting`)}</span>
                  ) : (
                    <span
                      className={cn(
                        'text-[10.5px] [font-family:inherit]',
                        installed ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)]'
                      )}
                    >
                      {installed ? t(`${prefix}.installed`) : t(`${prefix}.missing`)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {/* 缺失：提示卡（只提示，不安装） */}
          {status !== null && missing.length > 0 && (
            <div className="relative overflow-hidden rounded-[2px] border border-[color-mix(in_srgb,var(--amber)_28%,var(--rule))] bg-[color-mix(in_srgb,var(--amber)_7%,var(--bg-slot))]">
              <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--amber)] shadow-[0_0_6px_var(--amber-glow)]" />
              <div className="pl-3 pr-2.5 py-2 divide-y divide-[var(--rule-soft)]">
                <div className="pb-2 flex items-center gap-1.5 flex-wrap">
                  <span aria-hidden className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] shadow-[0_0_5px_var(--amber-glow)] flex-shrink-0" />
                  <span className="text-[10px] [font-family:inherit] font-semibold tracking-[.02em] text-[var(--amber)]">
                    {t(`${prefix}.missingDeps`)}
                  </span>
                  {missing.map((dep) => (
                    <span key={dep} className="px-1.5 py-px text-[10px] [font-family:inherit] rounded-[2px] border border-[var(--amber)] text-[var(--amber)]">
                      {dep}
                    </span>
                  ))}
                </div>
                <div className="py-2">
                  <div className="flex items-center gap-2 rounded-[2px] border border-[var(--rule)] bg-[var(--bg-base)] pl-2 pr-1.5 py-1.5">
                    <span aria-hidden className="text-[var(--amber)] text-[12px] leading-none select-none">❯</span>
                    <code className="flex-1 min-w-0 text-[11px] [font-family:inherit] text-[var(--text-rack)] break-all select-all">
                      {view.installCommand}
                    </code>
                    <button
                      onClick={() => void copy(view.installCommand, 'command')}
                      title={copied === 'command' ? t(`${prefix}.copied`) : t(`${prefix}.copy`)}
                      className={cn(
                        'w-[22px] h-[22px] inline-flex items-center justify-center rounded-[2px] cursor-pointer shrink-0 transition-colors',
                        copied === 'command'
                          ? 'text-[var(--amber)]'
                          : 'text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--amber)]'
                      )}
                    >
                      {copied === 'command' ? <IconCheck /> : <IconCopy />}
                    </button>
                  </div>
                </div>
                {view.repos.map((repo) => {
                  const key = `repo-${repo.dep}`
                  return (
                    <div key={repo.dep} className="py-2 flex items-center gap-2">
                      <span className="w-[46px] shrink-0 text-[10px] [font-family:inherit] text-[var(--text-rack)]">{repo.dep}</span>
                      <span className="flex-1 min-w-0 text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)] break-all select-all">{repo.url}</span>
                      <button
                        onClick={() => void copy(repo.url, key)}
                        title={copied === key ? t(`${prefix}.copied`) : t(`${prefix}.copy`)}
                        className={cn(
                          'w-[22px] h-[22px] inline-flex items-center justify-center rounded-[2px] cursor-pointer shrink-0 transition-colors',
                          copied === key
                            ? 'text-[var(--amber)]'
                            : 'text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--amber)]'
                        )}
                      >
                        {copied === key ? <IconCheck /> : <IconCopy />}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 工作区按目录分组，标题行控制单组开合，顶部按钮批量操作。 */}
      {listReady && (
        <div className={cn('flex-1 min-h-0 flex flex-col', compactTree ? 'harness-launcher-list' : 'bg-[var(--bg-rack)]')}>
          {/* 横幅位（仅异常时占行，随卡片区域走）：其余依赖未装时启动禁用
              （dsh 仅装了 dsh 缺 dsh-tui 时出现） */}
          {!launchReady && (
            <div className="flex items-start gap-2 rounded-[2px] border border-[color-mix(in_srgb,var(--amber)_28%,var(--rule))] bg-[color-mix(in_srgb,var(--amber)_7%,var(--bg-slot))] px-2 py-1.5 mx-3 mt-3">
              <span className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] shadow-[0_0_5px_var(--amber-glow)] mt-[3px] shrink-0" />
              <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] break-words">{t(`${prefix}.tuiMissingHint`)}</span>
            </div>
          )}

          {actionError && (
            <div className="text-[10.5px] [font-family:inherit] text-[var(--error-rack)] break-words pt-3">{actionError}</div>
          )}

          {/* 项目组与空态：Codex / Claude 使用紧凑列表，DeepSeek 沿用卷轴。 */}
          {wsGroups.length > 0 || (agent !== 'dsh' && showDialog) ? (
            <div
              className={compactTree ? 'harness-project-tree' : cn('group-list scroll-dual-seg flex-1 min-h-0', WS_TONE[agent].segCls)}
              style={compactTree ? undefined : { '--seg-tone': WS_TONE[agent].token } as React.CSSProperties}
            >
              <div className={compactTree ? 'harness-project-viewport rack-scroll' : 'group-list-viewport rack-scroll'}>
                <div className={compactTree ? 'harness-project-body' : 'group-list-body'}>
                  {agent !== 'dsh' && showDialog && !editWorkspace && visible && renderWorkspaceEditor(true)}
                  {wsGroups.map(([dir, list], index) => {
                    const detail = wsDirDetail(dir, wsGroups.map(([key]) => key))
                    const groupId = `${agent}-project-group-${index}`
                    return <div key={dir} className={compactTree ? 'harness-project-group' : undefined}
                      style={compactTree ? { '--project-hue': workspaceProjectHue(dir) } as React.CSSProperties : undefined}>
                      {compactTree ? <>
                        <button type="button" className="harness-project-header" title={dir}
                          aria-expanded={!collapsedDirs[dir]} aria-controls={groupId}
                          onClick={() => toggleDirCollapsed(dir)}>
                          <span className="harness-project-symbol" aria-hidden="true"><IconFolder /></span>
                          <span className="harness-project-heading">
                            <span className="harness-project-label">{dir ? wsDirLabel(dir) : t('workspacePresets.unassigned')}</span>
                            <span className="harness-project-parent">{detail.detailMarker ? detail.detail : dir}</span>
                          </span>
                          <span className="harness-project-count">{list.length}</span>
                          <svg className={cn('harness-project-chevron', !collapsedDirs[dir] && 'is-open')} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
                        </button>
                        <div id={groupId} className="harness-project-items" hidden={!!collapsedDirs[dir]} role="group" aria-label={dir || t('workspacePresets.unassigned')}>
                          {list.map(renderWorkspaceCard)}
                        </div>
                      </> : <>
                        <GroupHeader
                          tone={WS_TONE[agent].tone}
                          label={dir ? wsDirLabel(dir) : t('workspacePresets.unassigned')}
                          labelTitle={dir}
                          {...detail}
                          count={list.length}
                          truncateLabel
                          collapsed={!!collapsedDirs[dir]}
                          onToggle={() => toggleDirCollapsed(dir)}
                        />
                        <ScrollFold open={!collapsedDirs[dir]}>
                          <div className="paper-sheet mx-2 px-1.5 py-1.5 space-y-1.5">
                            {list.map(renderWorkspaceCard)}
                          </div>
                        </ScrollFold>
                      </>}
                    </div>
                  })}
                </div>
              </div>

            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-4 pb-6 text-center">
              <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
              <span className="text-[11.5px] [font-family:inherit] text-[var(--text-rack-mute)]">{t(`${prefix}.wsEmpty`)}</span>
              <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-faint)]">{t(`${prefix}.wsEmptyHint`)}</span>
            </div>
          )}
        </div>
      )}

      {/* DeepSeek 保留对话框；Claude / Codex 在列表内展开配置。 */}
      {showDialog && visible && agent === 'dsh' && (
        <div className="ly-dialog-backdrop fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="ly-dialog-surface bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm w-[448px] max-h-[88vh] overflow-y-auto rack-scroll shadow-xl">
            {renderWorkspaceEditor(false)}
          </div>
        </div>
      )}
      </div>{/* ===== /内容壳 ===== */}
    </div>
  )
}

export default HarnessPanel
