import React, { useCallback, useEffect, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { HARNESS_AGENT_VIEWS, type HarnessAgentKind, type HarnessEnvDefault, type HarnessEnvProfile, type HarnessWorkspace } from '@shared/harness'

/**
 * AI Harness 面板 —— dsh / codex / claude 三份第一等终端 Agent 的通用外壳。
 *
 * 每个 kind 通过 HARNESS_AGENT_VIEWS[agent] 注入展示/检测配置（依赖、env 默认、模型建议、
 * 安装信息、是否 Web）；行为差异（启动命令、模型预设、env 归一化）在主进程 harness/config.ts，
 * 渲染层只关心「检测 → 工作区列表 → 增删改/启动」这套通用交互。
 *
 * 缺失依赖时只提示 + 给出安装命令与仓库链接（不自动安装）。就绪后管理多个「工作区」：
 * 每个工作区 = 名称 + 工作目录，单击在对应目录内启动对应 CLI（参照 Agent 面板交互）。
 * 样式沿用机柜令牌（--bg-base/--bg-slot/--rule/--amber/--text-rack*）与 12px 等宽基线。
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
    launch: (id: string) => window.electronAPI.launchDshWorkspace(id),
    envList: () => window.electronAPI.listDshEnvProfiles(),
    envAdd: (p: unknown) => window.electronAPI.addDshEnvProfile(p),
    envUpdate: (p: unknown) => window.electronAPI.updateDshEnvProfile(p),
    envDelete: (id: string) => window.electronAPI.deleteDshEnvProfile(id),
    envSetActive: (id: string | null) => window.electronAPI.setDshEnvProfileActive(id),
    envDefaults: () => window.electronAPI.getDshEnvDefaults()
  },
  codex: {
    detect: () => window.electronAPI.detectCodex(),
    list: () => window.electronAPI.listCodexWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addCodexWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateCodexWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteCodexWorkspace(id),
    launch: (id: string) => window.electronAPI.launchCodexWorkspace(id),
    envList: () => window.electronAPI.listCodexEnvProfiles(),
    envAdd: (p: unknown) => window.electronAPI.addCodexEnvProfile(p),
    envUpdate: (p: unknown) => window.electronAPI.updateCodexEnvProfile(p),
    envDelete: (id: string) => window.electronAPI.deleteCodexEnvProfile(id),
    envSetActive: (id: string | null) => window.electronAPI.setCodexEnvProfileActive(id),
    envDefaults: () => window.electronAPI.getCodexEnvDefaults()
  },
  claude: {
    detect: () => window.electronAPI.detectClaude(),
    list: () => window.electronAPI.listClaudeWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addClaudeWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateClaudeWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteClaudeWorkspace(id),
    launch: (id: string) => window.electronAPI.launchClaudeWorkspace(id),
    envList: () => window.electronAPI.listClaudeEnvProfiles(),
    envAdd: (p: unknown) => window.electronAPI.addClaudeEnvProfile(p),
    envUpdate: (p: unknown) => window.electronAPI.updateClaudeEnvProfile(p),
    envDelete: (id: string) => window.electronAPI.deleteClaudeEnvProfile(id),
    envSetActive: (id: string | null) => window.electronAPI.setClaudeEnvProfileActive(id),
    envDefaults: () => window.electronAPI.getClaudeEnvDefaults()
  }
} as const

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

const IconPlus: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10" /></svg>
)

const IconEdit: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 9l1-3 5-5 2 2-5 5z" /></svg>
)

const IconX: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7" /></svg>
)

/**
 * 母线档位指示 —— 环境变量单选组每一格的通电状态：左沿 2px 导轨 + LED 圆点。
 * 通电格琥珀点亮并发辉光，其余是空心环（形状差异，不只靠颜色区分）。
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

/** 档位行外壳的通用配色：通电格用琥珀薄底，其余用常规机柜行 */
const slotShell = (on: boolean): string =>
  on
    ? 'border-[color-mix(in_srgb,var(--amber)_28%,var(--rule))] bg-[color-mix(in_srgb,var(--amber)_7%,var(--bg-slot))]'
    : 'border-[var(--rule)] bg-[var(--bg-rack)] hover:bg-[var(--bg-slot)]'

/**
 * 新建条 —— 钉在页签条下方、列表上方的主动作。
 *
 * 位置：紧贴页签，不随列表长短漂移，也不被滚动带走 —— 它是这个页签的动作，不是列表的尾巴。
 * 分量：实线 + 内凹底色 + 半粗标签，比条目更重（它是动作，条目是数据）；只有 + 号用琥珀，
 * 因为琥珀在本面板里稀缺地表示"通电/启用"，整块染琥珀会和环境变量页签的"已启用"读混。
 * 名字直接用它要打开的对话框标题，点下去与看到的一致。
 */
const AddBar: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    className="group flex-shrink-0 w-full flex items-center gap-2.5 px-2 py-2 rounded-[2px] border border-[var(--rule)] bg-[var(--bg-slot)] cursor-pointer transition-colors hover:border-[var(--amber)] hover:bg-[var(--bg-elev)] focus:outline-none focus-visible:border-[var(--amber)]"
  >
    {/* 20px 与列表行的文件夹图标同宽，标签落在条目名的同一左沿上 */}
    <span aria-hidden className="flex-shrink-0 w-[20px] h-[20px] inline-flex items-center justify-center text-[var(--amber)]">
      <IconPlus />
    </span>
    <span className="min-w-0 truncate text-[13px] font-semibold [font-family:inherit] text-[var(--text-rack)] group-hover:text-[var(--amber)] transition-colors">
      {label}
    </span>
  </button>
)

const HarnessPanel: React.FC<{ agent: HarnessAgentKind; onOpenWeb?: (target: { workspaceId?: string; cwd?: string }, name?: string) => Promise<{ success: boolean; error?: string }> }> = ({ agent, onOpenWeb }) => {
  const { t } = useTranslation()
  const view = HARNESS_AGENT_VIEWS[agent]
  const prefix = view.i18nPrefix
  const api = HARNESS_API[agent]
  const deps = view.dependencies

  const [status, setStatus] = useState<Record<string, boolean> | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // 页签：工作区 / 环境变量（两者平级）
  const [activeTab, setActiveTab] = useState<'workspaces' | 'env'>('workspaces')
  // 工作区列表与启动状态
  const [workspaces, setWorkspaces] = useState<HarnessWorkspace[]>([])
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [webOpening, setWebOpening] = useState(false)
  // 列表级操作错误横幅：启动失败统一在此展示具体原因
  const [actionError, setActionError] = useState<string | null>(null)
  // 新增/编辑对话框
  const [showDialog, setShowDialog] = useState(false)
  const [editWorkspace, setEditWorkspace] = useState<HarnessWorkspace | undefined>(undefined)
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')
  const [wsNote, setWsNote] = useState('')
  const [wsModel, setWsModel] = useState('')
  // 跳过权限确认（仅 claude 显示此开关）：true = 启动追加 --dangerously-skip-permissions
  const [wsSkipPermissions, setWsSkipPermissions] = useState(false)
  // 目录隔离模式：shared = 直接在 cwd 启动（现状）；worktree = 仓库根下专属 git worktree
  const [wsIsolation, setWsIsolation] = useState<'shared' | 'worktree'>('shared')
  // worktree 共享名：空 = 私有（kind-id 各用各的树）；填了则同名工作区跨 kind 共用同一 worktree/分支
  const [wsWorktreeKey, setWsWorktreeKey] = useState('')
  // 当前目录所属仓库里已有的 worktree 共享名（下拉选项；检测失败静默置空，硬校验在启动时）
  const [wtKeys, setWtKeys] = useState<string[]>([])
  // 工作区绑定的变量组 id；undefined = 跟随已启用的变量组
  const [wsEnvProfileId, setWsEnvProfileId] = useState<string | undefined>(undefined)
  const [triedSubmit, setTriedSubmit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // 列表行内删除的两步确认：记录待确认的工作区 id（null = 无待确认）
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // ── 环境变量组 ──
  const [envProfiles, setEnvProfiles] = useState<HarnessEnvProfile[]>([])
  // 变量组列表是否已成功拉到 —— 空列表有两种含义（「一个都没有」与「还没拉到/拉失败」），
  // 只有前者才允许把工作区的悬空绑定判为悬空，见 handleEdit
  const [envProfilesLoaded, setEnvProfilesLoaded] = useState(false)
  const [envActionError, setEnvActionError] = useState<string | null>(null)
  const [switchingActive, setSwitchingActive] = useState(false)
  const [envDeleteConfirmId, setEnvDeleteConfirmId] = useState<string | null>(null)
  // 变量组新增/编辑对话框
  const [showEnvDialog, setShowEnvDialog] = useState(false)
  const [editProfile, setEditProfile] = useState<HarnessEnvProfile | undefined>(undefined)
  const [profileName, setProfileName] = useState('')
  const [profileNote, setProfileNote] = useState('')
  const [profileEnv, setProfileEnv] = useState<{ key: string; value: string }[]>([])
  const [profileModels, setProfileModels] = useState<string[]>([])
  const [triedEnvSubmit, setTriedEnvSubmit] = useState(false)
  const [envConfirmDelete, setEnvConfirmDelete] = useState(false)
  const [envSaveError, setEnvSaveError] = useState<string | null>(null)

  const runDetect = useCallback(async () => {
    setDetecting(true)
    try {
      const res = await api.detect()
      if (res && typeof res === 'object') {
        const next: Record<string, boolean> = {}
        for (const dep of deps) next[dep] = Boolean(res[dep])
        setStatus(next)
      }
    } catch (err) {
      console.error(`Failed to detect ${agent}:`, err)
    } finally {
      setDetecting(false)
    }
  }, [api, agent, deps])

  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await api.list()
      if (Array.isArray(result)) setWorkspaces(result as HarnessWorkspace[])
    } catch (err) {
      console.error(`Failed to load ${agent} workspaces:`, err)
    }
  }, [api, agent])

  const loadEnvProfiles = useCallback(async () => {
    try {
      const result = await api.envList()
      if (Array.isArray(result)) {
        setEnvProfiles(result as HarnessEnvProfile[])
        setEnvProfilesLoaded(true)
      }
    } catch (err) {
      // 失败时不置 loaded：此后编辑工作区一律透传已有绑定，不拿一份没拉到的列表去判悬空
      console.error(`Failed to load ${agent} env profiles:`, err)
    }
  }, [api, agent])

  // 变量组「补全默认」—— CODEX_HOME 等要主进程按系统环境/默认路径解析，静态值仅作初始兜底
  const [envDefaults, setEnvDefaults] = useState<HarnessEnvDefault[]>(view.envDefaults)
  const loadEnvDefaults = useCallback(async () => {
    try {
      const result = await api.envDefaults()
      if (Array.isArray(result)) setEnvDefaults(result as HarnessEnvDefault[])
    } catch (err) {
      // 拉失败保留静态兜底（HARNESS_AGENT_VIEWS.envDefaults），不影响补全可用
      console.error(`Failed to load ${agent} env defaults:`, err)
    }
  }, [api, agent])

  // 挂载即检测 + 拉取工作区与变量组（工作区对话框要用变量组渲染选择器，故两者同时拉）
  useEffect(() => {
    void runDetect()
    void loadWorkspaces()
    void loadEnvProfiles()
    void loadEnvDefaults()
  }, [runDetect, loadWorkspaces, loadEnvProfiles, loadEnvDefaults])

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
    }
  }

  // ESC 退出对话框 —— 文档级监听，不依赖子元素焦点（覆盖层本身不可聚焦）
  // 处于删除二次确认态时，首次 ESC 仅回退确认态，再次 ESC 才关闭（与两步确认语义一致）
  useEffect(() => {
    if (!showDialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (confirmDelete) {
        setConfirmDelete(false)
        return
      }
      setShowDialog(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showDialog, confirmDelete])

  // worktree 模式下检测当前目录所属仓库的已有共享名（防抖 300ms，供共享名下拉）。
  // 检测失败（非 git 目录 / git 缺失）静默置空 —— 保存与启动自有各自的校验，这里只管选项。
  useEffect(() => {
    if (!showDialog || wsIsolation !== 'worktree' || wsCwd.trim().length === 0) {
      setWtKeys([])
      return
    }
    const timer = setTimeout(() => {
      window.electronAPI.listHarnessWorktrees(wsCwd.trim())
        .then((res: { success: boolean; keys?: string[] }) => {
          setWtKeys(res.success && Array.isArray(res.keys) ? res.keys : [])
        })
        .catch(() => setWtKeys([]))
    }, 300)
    return () => clearTimeout(timer)
  }, [showDialog, wsIsolation, wsCwd])

  // 变量组对话框同上（两个对话框互斥，各自监听自己的开关）
  useEffect(() => {
    if (!showEnvDialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (envConfirmDelete) {
        setEnvConfirmDelete(false)
        return
      }
      setShowEnvDialog(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showEnvDialog, envConfirmDelete])

  // ── 对话框 ──
  const handleAdd = () => {
    setEditWorkspace(undefined)
    setWsName(''); setWsCwd(''); setWsNote(''); setWsModel(''); setWsSkipPermissions(false); setWsEnvProfileId(undefined); setWsIsolation('shared'); setWsWorktreeKey('')
    setTriedSubmit(false); setConfirmDelete(false); setSaveError(null)
    setShowDialog(true)
  }
  const handleEdit = (ws: HarnessWorkspace) => {
    setEditWorkspace(ws)
    setWsName(ws.name); setWsCwd(ws.cwd); setWsNote(ws.note || ''); setWsModel(ws.model || ''); setWsSkipPermissions(ws.skipPermissions === true)
    setWsIsolation(ws.isolation === 'worktree' ? 'worktree' : 'shared')
    setWsWorktreeKey(ws.worktreeKey || '')
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
  const handlePickCwd = async () => {
    const result = await window.electronAPI.showOpenDialog({
      title: t(`${prefix}.browse`),
      defaultPath: wsCwd && !wsCwd.startsWith('~') ? wsCwd : undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result && !result.canceled && result.filePaths.length > 0) {
      const dir = result.filePaths[0]
      setWsCwd(dir)
      // 名称为空时自动用目录基名填充（镜像 agent 交互，减少手填）
      if (!wsName.trim()) {
        const base = dir.split(/[\\/]/).filter(Boolean).pop() || dir
        setWsName(base)
      }
    }
  }
  const valid = wsName.trim().length > 0 && wsCwd.trim().length > 0
  const handleSave = async () => {
    if (!valid) { setTriedSubmit(true); return }
    setSaveError(null)
    const name = wsName.trim()
    const cwd = wsCwd.trim()
    // 备注：仅 dsh 有此字段（hasWorkspaceNote）。codex/claude 字段不可见时透传历史值 ——
    // UI 退场不该让「改个名字」顺手清掉 JSON 里的旧备注（静默数据丢失，同 legacy env 的保留策略）
    const note = view.hasWorkspaceNote ? wsNote.trim() || undefined : editWorkspace?.note
    const model = wsModel.trim()
    const modelPayload = model.length > 0 ? model : undefined
    // 跳过权限确认：仅 claude 有此开关（其余 kind 连键都不带，主进程也按 kind 忽略）；
    // 关闭时传 undefined（键存在）以清掉旧标记
    const skipPermissionsPayload = view.hasSkipPermissions
      ? { skipPermissions: wsSkipPermissions || undefined }
      : {}
    // order 由主进程仓库分配递增，前端不再传 workspaces.length（删除后可能产生重复）
    // envProfileId 传 undefined 即「跟随已启用的变量组」；主进程按「键存在」判断，故必须显式带上这个键
    // worktreeKey 同理：空串 trim 后传 undefined = 私有 worktree（键必须显式存在才能清掉旧共享名）
    const worktreeKeyPayload = wsWorktreeKey.trim().length > 0 ? wsWorktreeKey.trim() : undefined
    const res = editWorkspace
      ? await api.update({ ...editWorkspace, name, cwd, note, model: modelPayload, envProfileId: wsEnvProfileId, isolation: wsIsolation, worktreeKey: worktreeKeyPayload, ...skipPermissionsPayload })
      : await api.add({ name, cwd, note, model: modelPayload, envProfileId: wsEnvProfileId, isolation: wsIsolation, worktreeKey: worktreeKeyPayload, ...skipPermissionsPayload })
    // 保存失败（校验未通过 / 落盘失败）：保留表单，展示具体错误，不关闭对话框
    if (res && res.success === false) {
      setSaveError(typeof res.error === 'string' ? res.error : t(`${prefix}.wsSaveFailed`))
      return
    }
    await loadWorkspaces()
    setShowDialog(false)
  }
  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    if (editWorkspace) {
      await api.delete(editWorkspace.id)
      await loadWorkspaces()
      setShowDialog(false)
    }
  }

  // ── 变量组：环境变量行编辑（对齐 AgentsPanel 的 env 编辑器） ──
  const addEnvRow = () => setProfileEnv((prev) => [...prev, { key: '', value: '' }])
  const updateEnvRow = (i: number, field: 'key' | 'value', value: string) =>
    setProfileEnv((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)))
  const removeEnvRow = (i: number) => setProfileEnv((prev) => prev.filter((_, idx) => idx !== i))
  // ── 变量组：模型选项行编辑（单列，供工作区模型建议） ──
  const addModelRow = () => setProfileModels((prev) => [...prev, ''])
  const updateModelRow = (i: number, value: string) =>
    setProfileModels((prev) => prev.map((m, idx) => (idx === i ? value : m)))
  const removeModelRow = (i: number) => setProfileModels((prev) => prev.filter((_, idx) => idx !== i))
  // 当前 env 行里尚缺的默认变量（按 key 名精确匹配）
  const missingEnv = envDefaults.filter(
    (d) => !profileEnv.some((row) => row.key.trim() === d.key)
  )
  // 一键补全缺失的默认变量（保留已有行，仅追加缺失项）
  const fillEnv = () => {
    setProfileEnv((prev) => [
      ...prev,
      ...envDefaults
        .filter((d) => !prev.some((row) => row.key.trim() === d.key))
        .map((d) => ({ key: d.key, value: d.value }))
    ])
  }

  // ── 变量组：对话框与单选启用 ──
  const activeProfile = envProfiles.find((p) => p.active === true)
  // 工作区表单实际生效的变量组（显式绑定 → 已启用组，与主进程 resolveWorkspaceEnv 同一条链）；
  // 其模型选项排在内置建议之前，供工作区「模型」输入框的 datalist
  const effectiveProfile = envProfiles.find((p) => p.id === wsEnvProfileId) ?? activeProfile
  const modelSuggestions = [
    ...new Set([...(effectiveProfile?.models ?? []), ...view.modelSuggestions])
  ]

  const handleAddProfile = () => {
    setEditProfile(undefined)
    setProfileName(''); setProfileNote('')
    // 新建即预填该 kind 的默认变量（API key 等），省掉「先加行再想 key 叫什么」这一步
    setProfileEnv(envDefaults.map((d) => ({ key: d.key, value: d.value })))
    setProfileModels([])
    setTriedEnvSubmit(false); setEnvConfirmDelete(false); setEnvSaveError(null)
    setShowEnvDialog(true)
  }
  const handleEditProfile = (p: HarnessEnvProfile) => {
    setEditProfile(p)
    setProfileName(p.name); setProfileNote(p.note || '')
    setProfileEnv(Object.entries(p.env).map(([key, value]) => ({ key, value })))
    setProfileModels(p.models ? [...p.models] : [])
    setTriedEnvSubmit(false); setEnvConfirmDelete(false); setEnvSaveError(null)
    setShowEnvDialog(true)
  }

  // 折叠 env 行：丢弃空 key；同名 key 后者覆盖
  const collapseEnv = (rows: { key: string; value: string }[]): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const row of rows) {
      const k = row.key.trim()
      if (k) env[k] = row.value
    }
    return env
  }
  const profilePayloadEnv = collapseEnv(profileEnv)
  const profileValid = profileName.trim().length > 0 && Object.keys(profilePayloadEnv).length > 0

  const handleSaveProfile = async () => {
    if (!profileValid) { setTriedEnvSubmit(true); return }
    setEnvSaveError(null)
    const name = profileName.trim()
    // note 传 undefined 即清空：主进程 `if (safe.note !== undefined)` 不写这个键，
    // 记录整条替换后备注即消失（与工作区对话框同一套语义）；models 同理（空数组清空）
    const note = profileNote.trim() || undefined
    const models = [...new Set(profileModels.map((m) => m.trim()).filter((m) => m.length > 0))]
    const modelsPayload = models.length > 0 ? models : undefined
    const res = editProfile
      ? await api.envUpdate({ ...editProfile, name, note, env: profilePayloadEnv, models: modelsPayload })
      : await api.envAdd({ name, note, env: profilePayloadEnv, models: modelsPayload })
    if (res && res.success === false) {
      setEnvSaveError(typeof res.error === 'string' ? res.error : t(`${prefix}.envSaveFailed`))
      return
    }
    await loadEnvProfiles()
    setShowEnvDialog(false)
  }

  const handleDeleteProfile = async () => {
    if (!envConfirmDelete) { setEnvConfirmDelete(true); return }
    if (editProfile) {
      await api.envDelete(editProfile.id)
      // 变量组是工作区绑定的目标，删除后工作区会回落 —— 一并刷新列表让绑定标记消失
      await Promise.all([loadEnvProfiles(), loadWorkspaces()])
      setShowEnvDialog(false)
    }
  }

  /** 单选启用：传 id 启用该条，传 null 全部停用（回落系统环境变量） */
  const applyActiveProfile = async (id: string | null) => {
    if (switchingActive) return
    setSwitchingActive(true)
    setEnvActionError(null)
    try {
      const res = await api.envSetActive(id)
      if (res && res.success === false) {
        setEnvActionError(typeof res.error === 'string' ? res.error : t(`${prefix}.envActiveFailed`))
      }
    } catch (err) {
      console.error(`${agent} env profile activation failed:`, err)
      setEnvActionError(err instanceof Error ? err.message : t(`${prefix}.envActiveFailed`))
    } finally {
      setSwitchingActive(false)
      // 无论成败都重新拉取，失败时回落到真实状态
      await loadEnvProfiles()
    }
  }
  // 点已通电的那格即停用 —— 系统那格随之点亮，构成一个可关的单选组
  const toggleProfile = (p: HarnessEnvProfile) => applyActiveProfile(p.active === true ? null : p.id)

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

  return (
    <div
      className="w-full h-full flex flex-col bg-[var(--bg-base)] p-3 space-y-2"
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* 标题 + 重新检测。
          hasWeb 的 kind（目前只有 dsh）标题本身就是 Web UI 入口：它是面板里最稳的一块 ——
          不随页签、不随数据增减改位置，故入口挂这儿比挂一个会来会去的图标按钮更可达。
          点标题直接开 Web，落在 deepseek-harness 自己的默认工作区（$DSH_HOME/web），与 TUI 工作区解耦。
          不加边框与状态字，仅靠悬停变琥珀提示可按；启动中同样标黄（琥珀=此刻与 Web 有关）。
          codex/claude 无 Web UI，标题不可按 —— 有能力的地方才有控件。 */}
      <div className="flex items-center justify-between gap-1 flex-shrink-0">
        {view.hasWeb ? (
          <button
            onClick={handleNameplate}
            disabled={!titleEnabled}
            title={t(`${prefix}.webDefault`)}
            className={cn(
              'flex-1 min-w-0 flex items-center gap-2 p-0 bg-transparent border-none text-left',
              'text-[15px] font-semibold tracking-[0.02em] [font-family:inherit] transition-colors',
              'focus:outline-none focus-visible:text-[var(--amber)] focus-visible:underline underline-offset-[3px]',
              webOpening && 'text-[var(--amber)] cursor-wait',
              !webOpening && titleEnabled && 'text-[var(--text-rack)] cursor-pointer hover:text-[var(--amber)]',
              !webOpening && !titleEnabled && 'text-[var(--text-rack)] cursor-default'
            )}
          >
            {/* 通电 LED —— 面板标题的琥珀锚点，与对话框头条同源（不表示 Web 状态） */}
            <span aria-hidden className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] shadow-[0_0_5px_var(--amber-glow)] flex-shrink-0" />
            <span className="min-w-0 truncate">{t(`${prefix}.title`)}</span>
          </button>
        ) : (
          <span className="flex-1 min-w-0 flex items-center gap-2 text-[15px] font-semibold tracking-[0.02em] [font-family:inherit] text-[var(--text-rack)]">
            <span aria-hidden className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] shadow-[0_0_5px_var(--amber-glow)] flex-shrink-0" />
            <span className="truncate">{t(`${prefix}.title`)}</span>
          </span>
        )}
        <div className="flex items-center gap-0 flex-shrink-0">
          {/* 依赖齐全时无需重新检测（隐藏）；检测中/缺依赖时保留 */}
          {!launchReady && (
            <button
              onClick={() => void runDetect()}
              disabled={detecting}
              className="px-2.5 py-1 text-[12.5px] [font-family:inherit] rounded-[2px] border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              {detecting ? t(`${prefix}.detecting`) : t(`${prefix}.redetect`)}
            </button>
          )}
        </div>
      </div>

      {/* 未就绪：首个依赖缺失 → 依赖状态行 + 提示卡（无首个依赖则列表/启动均不可用） */}
      {!listReady && (
        <>
          <div className="space-y-1">
            {deps.map((dep) => {
              const installed = status ? Boolean(status[dep]) : null
              return (
                <div
                  key={dep}
                  className="flex items-center gap-2 border border-[var(--rule)] rounded-[2px] px-2 py-1.5"
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
        </>
      )}

      {/* 就绪：工作区 / 环境变量两个平级页签（首个依赖就绪即可） */}
      {listReady && (
        <>
          {/* 页签条 —— 沿用 FileManagerPanel 的语汇：齐平文字按钮 + 琥珀下划线压在容器发丝线上 */}
          <div className="flex items-center gap-0 flex-shrink-0 border-b border-[var(--rule)]">
            {([
              { key: 'workspaces' as const, label: t(`${prefix}.tabWorkspaces`), count: workspaces.length },
              { key: 'env' as const, label: t(`${prefix}.tabEnv`), count: envProfiles.length }
            ]).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                aria-selected={activeTab === tab.key}
                className={cn(
                  'px-2 py-1 -mb-px font-semibold text-[11px] tracking-[0.08em] [font-family:inherit] bg-transparent border-none border-b cursor-pointer transition-colors',
                  activeTab === tab.key
                    ? 'text-[var(--text-rack)] border-[var(--amber)]'
                    : 'text-[var(--text-rack-mute)] border-transparent hover:text-[var(--text-rack)]'
                )}
              >
                {tab.label}
                <span className="ml-1.5 tabular-nums text-[var(--text-rack-dim)]">{tab.count}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* 工作区页签 */}
      {listReady && activeTab === 'workspaces' && (
        <>
          {/* 新建排在告警/错误横幅之前：它是本页签的固定动作，位置不该被临时横幅推来推去 */}
          <AddBar label={t(`${prefix}.wsAddTitle`)} onClick={handleAdd} />

          {/* 其余依赖未装：启动禁用（dsh 仅装了 dsh 缺 dsh-tui 时出现） */}
          {!launchReady && (
            <div className="flex items-start gap-2 rounded-[2px] border border-[color-mix(in_srgb,var(--amber)_28%,var(--rule))] bg-[color-mix(in_srgb,var(--amber)_7%,var(--bg-slot))] px-2 py-1.5">
              <span className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] shadow-[0_0_5px_var(--amber-glow)] mt-[3px] shrink-0" />
              <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] break-words">{t(`${prefix}.tuiMissingHint`)}</span>
            </div>
          )}

          {actionError && (
            <div className="text-[10.5px] [font-family:inherit] text-[var(--error-rack)] break-words">{actionError}</div>
          )}

          <div className="flex-1 overflow-y-auto min-h-0 space-y-1 rack-scroll">
            {workspaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
                <span className="text-[11.5px] [font-family:inherit] text-[var(--text-rack-mute)]">{t(`${prefix}.wsEmpty`)}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-faint)]">{t(`${prefix}.wsEmptyHint`)}</span>
              </div>
            ) : (
              workspaces.map((ws) => {
                const launching = launchingId === ws.id
                // 显式绑定的变量组（悬空绑定不显示 —— 主进程会回落已启用组，标出来反而误导）
                const boundProfile = ws.envProfileId
                  ? envProfiles.find((p) => p.id === ws.envProfileId)
                  : undefined
                return (
                  <div
                    key={ws.id}
                    onClick={() => void handleLaunch(ws)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleEdit(ws) }}
                    onMouseLeave={() => { if (deleteConfirmId === ws.id) setDeleteConfirmId(null) }}
                    title={t(`${prefix}.launch`)}
                    className={cn(
                      'group relative flex items-center gap-2.5 px-2 py-1.5 rounded-[2px] cursor-pointer border border-[var(--rule)] bg-[var(--bg-rack)] hover:bg-[var(--bg-slot)] transition-colors',
                      launching && 'opacity-60 cursor-wait'
                    )}
                  >
                    <span className="flex-shrink-0 w-[20px] h-[20px] inline-flex items-center justify-center text-[var(--text-rack-mute)] group-hover:text-[var(--amber)] transition-colors">
                      <IconFolder />
                    </span>
                    <span className="flex flex-col min-w-0 flex-1">
                      <span className="text-[13px] [font-family:inherit] font-medium text-[var(--text-rack)] truncate leading-tight">
                        {ws.name}
                        {launching && <span className="ml-1.5 text-[10.5px] [font-family:inherit] text-[var(--amber)]">{t(`${prefix}.launching`)}</span>}
                      </span>
                      <span className="text-[11px] [font-family:inherit] text-[var(--text-rack-data)] truncate leading-tight">{ws.cwd}</span>
                      {/* 绑定了变量组时标出来 —— 点这行即刻启动，用哪份密钥必须点之前就看得见 */}
                      {boundProfile && (
                        <span className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] leading-tight min-w-0">
                          <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--amber)] flex-shrink-0" />
                          <span className="truncate">{boundProfile.name}</span>
                        </span>
                      )}
                      {/* worktree 隔离标出来（悬停见分支名；共享名随行显示）—— 在哪个树里跑是看得见的承诺 */}
                      {ws.isolation === 'worktree' && (
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
                      {/* 跳过权限确认标出来 —— 行文即 flag 本身（琥珀=已通电，与面板语义一致），
                          点之前就看得见危险模式；不引入任何文案 */}
                      {ws.skipPermissions && (
                        <span className="flex items-center gap-1 text-[10.5px] [font-family:inherit] text-[var(--amber)] leading-tight min-w-0">
                          <span aria-hidden className="w-[4px] h-[4px] rounded-full bg-[var(--amber)] flex-shrink-0" />
                          <span className="truncate">--dangerously-skip-permissions</span>
                        </span>
                      )}
                      {view.hasWorkspaceNote && ws.note && (
                        <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] truncate leading-tight">{ws.note}</span>
                      )}
                    </span>
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto pl-6 bg-gradient-to-l from-[var(--bg-slot)] from-[24%] to-transparent">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEdit(ws) }}
                        title={t(`${prefix}.wsEditTitle`)}
                        className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
                      >
                        <IconEdit />
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          // 两步确认：首次点击切到确认态，再次点击才真正删除（与对话框一致）
                          if (deleteConfirmId !== ws.id) {
                            setDeleteConfirmId(ws.id)
                            return
                          }
                          setDeleteConfirmId(null)
                          await api.delete(ws.id)
                          await loadWorkspaces()
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
                  </div>
                )
              })
            )}
          </div>
        </>
      )}

      {/* 环境变量页签 —— N+1 单选组（母线）：系统档位常驻列首，恒有且仅有一格通电 */}
      {listReady && activeTab === 'env' && (
        <>
          {/* 排在 radiogroup 之外、之上：它是动作不是档位，混进单选组会同时破坏「系统档位常驻列首」
              的读法与 radiogroup 的 role 语义。虚线换实线后与下方档位的实心槽也不会混淆。 */}
          <AddBar label={t(`${prefix}.envAddTitle`)} onClick={handleAddProfile} />

          {envActionError && (
            <div className="text-[10.5px] [font-family:inherit] text-[var(--error-rack)] break-words">{envActionError}</div>
          )}

          <div role="radiogroup" aria-label={t(`${prefix}.tabEnv`)} className="flex-1 overflow-y-auto min-h-0 space-y-1 rack-scroll">
            {/* 系统档位：不是「无选择」，而是与各变量组平级的一格。全部停用时它通电。 */}
            <div
              role="radio"
              aria-checked={!activeProfile}
              tabIndex={0}
              onClick={() => void applyActiveProfile(null)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void applyActiveProfile(null) } }}
              title={activeProfile ? t(`${prefix}.envUseSystem`) : undefined}
              className={cn(
                'relative overflow-hidden flex items-center gap-2.5 px-2 py-1.5 rounded-[2px] cursor-pointer border transition-colors focus:outline-none focus-visible:border-[var(--amber)]',
                slotShell(!activeProfile),
                switchingActive && 'opacity-60 cursor-wait'
              )}
            >
              <BusLed on={!activeProfile} />
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[13px] [font-family:inherit] font-medium text-[var(--text-rack)] truncate leading-tight">
                  {t(`${prefix}.envSystem`)}
                </span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] truncate leading-tight">
                  {t(`${prefix}.envSystemHint`)}
                </span>
              </span>
            </div>

            {envProfiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-4 pt-8 text-center">
                <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
                <span className="text-[11.5px] [font-family:inherit] text-[var(--text-rack-mute)]">{t(`${prefix}.envEmpty`)}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-faint)]">{t(`${prefix}.envEmptyHint`)}</span>
              </div>
            ) : (
              envProfiles.map((p) => {
                const on = p.active === true
                return (
                  <div
                    key={p.id}
                    role="radio"
                    aria-checked={on}
                    tabIndex={0}
                    onClick={() => void toggleProfile(p)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggleProfile(p) } }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleEditProfile(p) }}
                    onMouseLeave={() => { if (envDeleteConfirmId === p.id) setEnvDeleteConfirmId(null) }}
                    title={on ? t(`${prefix}.envDisable`) : t(`${prefix}.envEnable`)}
                    className={cn(
                      'group relative overflow-hidden flex items-center gap-2.5 px-2 py-1.5 rounded-[2px] cursor-pointer border transition-colors focus:outline-none focus-visible:border-[var(--amber)]',
                      slotShell(on),
                      switchingActive && 'opacity-60 cursor-wait'
                    )}
                  >
                    <BusLed on={on} />
                    <span className="flex flex-col min-w-0 flex-1">
                      <span className="text-[13px] [font-family:inherit] font-medium text-[var(--text-rack)] truncate leading-tight">
                        {p.name}
                      </span>
                      <span className="text-[11px] [font-family:inherit] text-[var(--text-rack-data)] truncate leading-tight">
                        {t(`${prefix}.envVars`, { count: Object.keys(p.env).length })}
                        {p.note && <span className="text-[var(--text-rack-mute)]"> · {p.note}</span>}
                      </span>
                    </span>
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto pl-6 bg-gradient-to-l from-[var(--bg-slot)] from-[24%] to-transparent">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEditProfile(p) }}
                        title={t(`${prefix}.envEditTitle`)}
                        className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
                      >
                        <IconEdit />
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          // 两步确认：首次点击切到确认态，再次点击才真正删除（与工作区一致）
                          if (envDeleteConfirmId !== p.id) {
                            setEnvDeleteConfirmId(p.id)
                            return
                          }
                          setEnvDeleteConfirmId(null)
                          await api.envDelete(p.id)
                          await Promise.all([loadEnvProfiles(), loadWorkspaces()])
                        }}
                        title={envDeleteConfirmId === p.id ? t(`${prefix}.wsConfirmDelete`) : t(`${prefix}.wsDelete`)}
                        className={cn(
                          'w-[22px] h-[22px] inline-flex items-center justify-center border-none cursor-pointer rounded-[2px] transition-colors',
                          envDeleteConfirmId === p.id
                            ? 'bg-[var(--error-rack)] text-[var(--bg-base)]'
                            : 'bg-transparent text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--error-rack)]'
                        )}
                      >
                        <IconX />
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </>
      )}

      {/* 工作区新增/编辑对话框 —— 机柜"插槽规格表"同壳（参照 Agent 对话框） */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm w-[448px] max-h-[88vh] overflow-y-auto rack-scroll shadow-xl">
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
            </div>

            {/* 名称 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsName`)}</span>
              </div>
              <input
                type="text"
                value={wsName}
                onChange={(e) => { setWsName(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
                placeholder={t(`${prefix}.wsNamePh`)}
                autoFocus
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
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
                  onClick={() => setWsIsolation('shared')}
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
                  onClick={() => setWsIsolation('worktree')}
                  className="relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0 bg-transparent cursor-pointer hover:bg-[var(--bg-slot)] transition-colors"
                >
                  <BusLed on={wsIsolation === 'worktree'} />
                  <span className="flex-1 min-w-0 text-[12px] [font-family:inherit] text-[var(--text-rack)] truncate">
                    {t(`${prefix}.wsIsolationWorktree`)}
                  </span>
                </button>
              </div>
              {/* 共享名：仅 worktree 模式有意义。空 = 私有（各用各的树）；填了则同名工作区跨 kind 共用同一棵树与分支。
                  datalist 下拉列出该仓库已有的共享名 —— 选中即加入既有 worktree，也可自由输入新名字 */}
              {wsIsolation === 'worktree' && (
                <>
                  <input
                    type="text"
                    list={`${agent}-worktree-keys`}
                    value={wsWorktreeKey}
                    onChange={(e) => setWsWorktreeKey(e.target.value)}
                    placeholder={t(`${prefix}.wsWorktreeKeyPh`)}
                    className="mt-2 w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
                  />
                  <datalist id={`${agent}-worktree-keys`}>
                    {wtKeys.map((k) => (
                      <option key={k} value={k} />
                    ))}
                  </datalist>
                </>
              )}
            </div>

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

            {/* 模型 —— dsh 走补丁、codex/claude 走 --model；留空则用各 CLI 默认 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsModel`)}</span>
              </div>
              <input
                type="text"
                list={`${agent}-model-suggestions`}
                value={wsModel}
                onChange={(e) => setWsModel(e.target.value)}
                placeholder={t(`${prefix}.wsModelPh`)}
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
              <datalist id={`${agent}-model-suggestions`}>
                {modelSuggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            {/* 跳过权限确认（仅 claude）—— 启动追加 --dangerously-skip-permissions。
                单格开关沿用 BusLed 通话语义：行文恒为 flag 本身（要拼什么一目了然），
                点亮 = 琥珀生效，熄灭 = 灰置未启用；不放任何说明文字 */}
            {view.hasSkipPermissions && (
              <div className="py-3.5 px-4 border-b border-[var(--rule)]">
                <div className="mb-2">
                  <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsSkipPerms`)}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={wsSkipPermissions}
                  aria-label={t(`${prefix}.wsSkipPerms`)}
                  onClick={() => setWsSkipPermissions((v) => !v)}
                  className={cn(
                    'relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-sm border transition-colors cursor-pointer',
                    'bg-[var(--bg-base)] hover:bg-[var(--bg-slot)] focus:outline-none focus-visible:border-[var(--amber)]',
                    wsSkipPermissions
                      ? 'border-[color-mix(in_srgb,var(--amber)_28%,var(--rule))]'
                      : 'border-[var(--rule)]'
                  )}
                >
                  <BusLed on={wsSkipPermissions} />
                  <code
                    className={cn(
                      'flex-1 min-w-0 text-[11px] [font-family:inherit] truncate transition-colors',
                      wsSkipPermissions ? 'text-[var(--amber)]' : 'text-[var(--text-rack)]'
                    )}
                  >
                    --dangerously-skip-permissions
                  </code>
                </button>
              </div>
            )}

            {/* 环境变量 —— 选一组预配置变量；不选则跟随已启用的那组（三级链在这里就地摊开） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsEnvProfile`)}</span>
              </div>
              <div role="radiogroup" aria-label={t(`${prefix}.wsEnvProfile`)} className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm overflow-hidden max-h-[168px] overflow-y-auto rack-scroll">
                {/* 跟随档位：默认值。就地显示解析结果，免得用户还要切页签才知道实际会用哪份 */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={wsEnvProfileId === undefined}
                  onClick={() => setWsEnvProfileId(undefined)}
                  className="relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0 bg-transparent cursor-pointer hover:bg-[var(--bg-slot)] transition-colors"
                >
                  <BusLed on={wsEnvProfileId === undefined} />
                  <span className="flex-1 min-w-0 text-[12px] [font-family:inherit] text-[var(--text-rack)] truncate">
                    {t(`${prefix}.wsEnvFollow`)}
                  </span>
                  <span className="flex-shrink-0 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] truncate max-w-[46%]">
                    {t(`${prefix}.wsEnvFollowNow`, { name: activeProfile ? activeProfile.name : t(`${prefix}.envSystem`) })}
                  </span>
                </button>
                {envProfiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={wsEnvProfileId === p.id}
                    onClick={() => setWsEnvProfileId(p.id)}
                    className="relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0 bg-transparent cursor-pointer hover:bg-[var(--bg-slot)] transition-colors"
                  >
                    <BusLed on={wsEnvProfileId === p.id} />
                    <span className="flex-1 min-w-0 text-[12px] [font-family:inherit] text-[var(--text-rack)] truncate">{p.name}</span>
                    <span className="flex-shrink-0 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] tabular-nums">
                      {t(`${prefix}.envVars`, { count: Object.keys(p.env).length })}
                    </span>
                  </button>
                ))}
                {envProfiles.length === 0 && (
                  <div className="px-2.5 py-1.5 text-[10.5px] [font-family:inherit] text-[var(--text-rack-faint)]">
                    {t(`${prefix}.wsEnvNone`)}
                  </div>
                )}
              </div>
            </div>

            {/* 校验提示（仅尝试提交后显示） */}
            {triedSubmit && !valid && (
              <div className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)]">
                {t(`${prefix}.wsRequired`)}
              </div>
            )}

            {/* 保存失败提示（校验未通过 / 落盘失败，保留表单） */}
            {saveError && (
              <div className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)] break-all">
                {saveError}
              </div>
            )}

            {/* footer：删除（两步确认）/ 取消 / 保存 */}
            <div className="flex items-center justify-between px-4 py-3">
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
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDialog(false)}
                  className="px-3 py-1 text-[13px] [font-family:inherit] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
                >
                  {t(`${prefix}.wsCancel`)}
                </button>
                <button
                  onClick={() => void handleSave()}
                  className={`px-4 py-1 text-[13px] [font-family:inherit] rounded-sm font-medium transition-opacity ${
                    valid
                      ? 'bg-[var(--amber)] text-[var(--bg-base)] hover:opacity-90'
                      : 'bg-[var(--bg-slot)] text-[var(--text-rack-dim)] opacity-70'
                  }`}
                >
                  {t(`${prefix}.wsSave`)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 变量组新增/编辑对话框 —— 与工作区对话框同壳，只有名称 + 键值表两段 */}
      {showEnvDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm w-[448px] max-h-[88vh] overflow-y-auto rack-scroll shadow-xl">
            <div className="flex items-center h-10 px-4 border-b border-[var(--rule)] gap-2.5">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: 'var(--amber)', boxShadow: '0 0 5px var(--amber)' }}
              />
              <span className="text-[13px] [font-family:inherit] font-medium tracking-[0.04em] text-[var(--text-rack)]">
                {editProfile ? t(`${prefix}.envEditTitle`) : t(`${prefix}.envAddTitle`)}
              </span>
              <span className="flex-1" />
              <span className="text-[10.5px] [font-family:inherit] tracking-[0.08em] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] text-[var(--text-rack-mute)]">
                {agent.toUpperCase()}
              </span>
            </div>

            {/* 名称 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.envName`)}</span>
              </div>
              <input
                type="text"
                value={profileName}
                onChange={(e) => { setProfileName(e.target.value); if (triedEnvSubmit) setTriedEnvSubmit(false) }}
                placeholder={t(`${prefix}.envNamePh`)}
                autoFocus
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* 备注（可选）—— 列表行里跟在「n 个变量」后面单行显示，故用 input 而非 textarea */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--text-rack)]">{t(`${prefix}.wsNote`)}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t(`${prefix}.wsNoteHint`)}</span>
              </div>
              <input
                type="text"
                value={profileNote}
                onChange={(e) => setProfileNote(e.target.value)}
                placeholder={t(`${prefix}.wsNotePh`)}
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* 变量键值表 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                {/* 标题 + fill 按钮一行；说明单独一行，避免长说明与按钮相互挤压 */}
                <div className="flex items-center gap-2">
                  <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsEnv`)}</span>
                  <span className="flex-1" />
                  {missingEnv.length > 0 && (
                    <button
                      onClick={fillEnv}
                      title={missingEnv.map((d) => d.key).join(', ')}
                      className="px-1.5 py-0.5 text-[10.5px] [font-family:inherit] rounded-[2px] border border-[color-mix(in_srgb,var(--amber)_40%,var(--rule))] text-[var(--amber)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] transition-colors whitespace-nowrap"
                    >
                      + {t(`${prefix}.wsEnvFill`)}
                    </button>
                  )}
                </div>
                <div className="mt-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t(`${prefix}.wsEnvHint`)}</div>
              </div>
              <div className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm overflow-hidden">
                {profileEnv.length === 0 ? (
                  <button
                    onClick={addEnvRow}
                    className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                  >
                    + {t(`${prefix}.wsEnvAdd`)}
                  </button>
                ) : (
                  <>
                    {profileEnv.map((row, i) => (
                      <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0">
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) => { updateEnvRow(i, 'key', e.target.value); if (triedEnvSubmit) setTriedEnvSubmit(false) }}
                          placeholder={t(`${prefix}.wsEnvKeyPh`)}
                          className="flex-1 min-w-0 bg-transparent border-none text-[12px] [font-family:inherit] text-[var(--amber)] placeholder:text-[var(--text-rack-data)] focus:outline-none"
                        />
                        <span className="text-[var(--text-rack-mute)] [font-family:inherit] text-[12px] select-none">=</span>
                        <input
                          type="text"
                          value={row.value}
                          onChange={(e) => updateEnvRow(i, 'value', e.target.value)}
                          placeholder={t(`${prefix}.wsEnvValuePh`)}
                          className="flex-[2] min-w-0 bg-transparent border-none text-[12px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] focus:outline-none"
                        />
                        <button
                          onClick={() => removeEnvRow(i)}
                          title={t(`${prefix}.wsDelete`)}
                          className="w-[18px] h-[18px] flex-shrink-0 inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] text-[var(--text-rack-faint)] hover:text-[var(--error-rack)] transition-colors"
                        >
                          <IconX />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={addEnvRow}
                      className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                    >
                      + {t(`${prefix}.wsEnvAdd`)}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 模型选项 —— 单列可增删，供工作区「模型」输入框的建议（生效组排在内置建议之前） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.envModels`)}</span>
                <div className="mt-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t(`${prefix}.envModelsHint`)}</div>
              </div>
              <div className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm overflow-hidden">
                {profileModels.length === 0 ? (
                  <button
                    onClick={addModelRow}
                    className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                  >
                    + {t(`${prefix}.envModelsAdd`)}
                  </button>
                ) : (
                  <>
                    {profileModels.map((model, i) => (
                      <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0">
                        <input
                          type="text"
                          value={model}
                          onChange={(e) => updateModelRow(i, e.target.value)}
                          placeholder={t(`${prefix}.envModelsPh`)}
                          className="flex-1 min-w-0 bg-transparent border-none text-[12px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] focus:outline-none"
                        />
                        <button
                          onClick={() => removeModelRow(i)}
                          title={t(`${prefix}.wsDelete`)}
                          className="w-[18px] h-[18px] flex-shrink-0 inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] text-[var(--text-rack-faint)] hover:text-[var(--error-rack)] transition-colors"
                        >
                          <IconX />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={addModelRow}
                      className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                    >
                      + {t(`${prefix}.envModelsAdd`)}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 校验提示（仅尝试提交后显示） */}
            {triedEnvSubmit && !profileValid && (
              <div className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)]">
                {t(`${prefix}.envRequired`)}
              </div>
            )}

            {/* 保存失败提示（校验未通过 / 落盘失败，保留表单） */}
            {envSaveError && (
              <div className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)] break-all">
                {envSaveError}
              </div>
            )}

            {/* footer：删除（两步确认）/ 取消 / 保存 */}
            <div className="flex items-center justify-between px-4 py-3">
              {editProfile ? (
                <button
                  onClick={() => void handleDeleteProfile()}
                  className={
                    envConfirmDelete
                      ? 'px-2.5 py-1 text-[12px] [font-family:inherit] rounded-sm bg-[var(--error-rack)] text-[var(--bg-base)] font-medium transition-colors'
                      : 'px-2.5 py-1 text-[12px] [font-family:inherit] text-[var(--error-rack)] hover:bg-[var(--bg-slot)] rounded-sm transition-colors'
                  }
                >
                  {envConfirmDelete ? t(`${prefix}.wsConfirmDelete`) : t(`${prefix}.wsDelete`)}
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowEnvDialog(false)}
                  className="px-3 py-1 text-[13px] [font-family:inherit] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
                >
                  {t(`${prefix}.wsCancel`)}
                </button>
                <button
                  onClick={() => void handleSaveProfile()}
                  className={`px-4 py-1 text-[13px] [font-family:inherit] rounded-sm font-medium transition-opacity ${
                    profileValid
                      ? 'bg-[var(--amber)] text-[var(--bg-base)] hover:opacity-90'
                      : 'bg-[var(--bg-slot)] text-[var(--text-rack-dim)] opacity-70'
                  }`}
                >
                  {t(`${prefix}.wsSave`)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default HarnessPanel
