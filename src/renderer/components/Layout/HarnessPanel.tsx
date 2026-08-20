import React, { useCallback, useEffect, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { HARNESS_AGENT_VIEWS, type HarnessAgentKind, type HarnessWorkspace } from '@shared/harness'

/**
 * AI Harness 面板 —— dsh / codex / claude 三份第一等终端 Agent 的通用外壳。
 *
 * 每个 kind 通过 HARNESS_AGENT_VIEWS[agent] 注入展示/检测配置（依赖、env 默认、模型建议、
 * 安装信息、是否 Web）；行为差异（启动命令、模型预设、env 归一化）在主进程 harness/config.ts，
 * 渲染层只关心「检测 → 工作区列表 → 增删改/置顶/启动」这套通用交互。
 *
 * 缺失依赖时只提示 + 给出安装命令与仓库链接（不自动安装）。就绪后管理多个「工作区」：
 * 每个工作区 = 名称 + 工作目录，单击在对应目录内启动对应 CLI（参照 Agent 面板交互）。
 * 样式沿用机柜令牌（--bg-base/--bg-slot/--rule/--amber/--text-rack*）与 12px 等宽基线。
 * Web 入口（地球仪）仅在 hasWeb 时渲染（目前只有 dsh）。
 */

/** 每 kind 的 IPC 适配器 —— 映射到 preload 暴露的 concrete 方法（ElectronAPI = typeof electronAPI） */
const HARNESS_API = {
  dsh: {
    detect: () => window.electronAPI.detectDsh(),
    list: () => window.electronAPI.listDshWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addDshWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateDshWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteDshWorkspace(id),
    setPinned: (id: string, pinned: boolean) => window.electronAPI.setDshWorkspacePinned(id, pinned),
    launch: (id: string) => window.electronAPI.launchDshWorkspace(id)
  },
  codex: {
    detect: () => window.electronAPI.detectCodex(),
    list: () => window.electronAPI.listCodexWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addCodexWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateCodexWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteCodexWorkspace(id),
    setPinned: (id: string, pinned: boolean) => window.electronAPI.setCodexWorkspacePinned(id, pinned),
    launch: (id: string) => window.electronAPI.launchCodexWorkspace(id)
  },
  claude: {
    detect: () => window.electronAPI.detectClaude(),
    list: () => window.electronAPI.listClaudeWorkspaces(),
    add: (ws: unknown) => window.electronAPI.addClaudeWorkspace(ws),
    update: (ws: unknown) => window.electronAPI.updateClaudeWorkspace(ws),
    delete: (id: string) => window.electronAPI.deleteClaudeWorkspace(id),
    setPinned: (id: string, pinned: boolean) => window.electronAPI.setClaudeWorkspacePinned(id, pinned),
    launch: (id: string) => window.electronAPI.launchClaudeWorkspace(id)
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

/** 置顶图钉 —— 实心填充，置顶态常显 amber，未置顶态在 hover 动作里以描边灰呈现 */
const IconPin: React.FC<{ filled?: boolean }> = ({ filled = true }) => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" strokeLinejoin="miter">
    <path d="M5 1.5h2l.6 3h1.9l.8 1H1.7l.8-1H4.4zM6 5.5V10M4.5 8.5h3" />
  </svg>
)

/** 地球仪 —— Web UI 入口图标（嵌入 dsh web 面板） */
const IconGlobe: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" strokeLinejoin="miter">
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12" />
  </svg>
)

const HarnessPanel: React.FC<{ agent: HarnessAgentKind; onOpenWeb?: (ws: HarnessWorkspace) => Promise<{ success: boolean; error?: string }> }> = ({ agent, onOpenWeb }) => {
  const { t } = useTranslation()
  const view = HARNESS_AGENT_VIEWS[agent]
  const prefix = view.i18nPrefix
  const api = HARNESS_API[agent]
  const deps = view.dependencies

  const [status, setStatus] = useState<Record<string, boolean> | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // 工作区列表与启动状态
  const [workspaces, setWorkspaces] = useState<HarnessWorkspace[]>([])
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [webOpeningId, setWebOpeningId] = useState<string | null>(null)
  // 全局栏地球仪的目标工作区：默认置顶（首个），新建后自动选中新建项，点行内地球仪可重选。
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null)
  // 列表级操作错误横幅：启动失败与置顶切换失败共用，统一在此展示具体原因
  const [actionError, setActionError] = useState<string | null>(null)
  // 新增/编辑对话框
  const [showDialog, setShowDialog] = useState(false)
  const [editWorkspace, setEditWorkspace] = useState<HarnessWorkspace | undefined>(undefined)
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')
  const [wsNote, setWsNote] = useState('')
  const [wsModel, setWsModel] = useState('')
  const [wsEnv, setWsEnv] = useState<{ key: string; value: string }[]>([])
  const [triedSubmit, setTriedSubmit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // 列表行内删除的两步确认：记录待确认的工作区 id（null = 无待确认）
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

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

  // 挂载即检测 + 拉取工作区
  useEffect(() => {
    void runDetect()
    void loadWorkspaces()
  }, [runDetect, loadWorkspaces])

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

  const handleWeb = async (ws: HarnessWorkspace) => {
    if (webOpeningId) return
    setWebOpeningId(ws.id)
    setActionError(null)
    try {
      const res = await onOpenWeb?.(ws)
      if (res && res.success === false) {
        setActionError(typeof res.error === 'string' && res.error ? res.error : t(`${prefix}.webFailed`))
      }
    } catch (err) {
      console.error(`${agent} web open failed:`, err)
      setActionError(err instanceof Error ? err.message : t(`${prefix}.webFailed`))
    } finally {
      setWebOpeningId(null)
    }
  }

  const togglePin = async (ws: HarnessWorkspace) => {
    const next = !ws.pinned
    try {
      const res = await api.setPinned(ws.id, next)
      // 置顶切换失败（如工作区已被删除/落盘失败）：记录 + 展示具体原因，随后列表刷新回落真实状态
      if (res && res.success === false) {
        console.error(`${agent} workspace pin toggle failed:`, res.error ?? 'unknown error')
        setActionError(typeof res.error === 'string' ? res.error : t(`${prefix}.wsPinFailed`))
      }
    } catch (err) {
      console.error(`${agent} workspace pin toggle failed:`, err)
      setActionError(err instanceof Error ? err.message : t(`${prefix}.wsPinFailed`))
    } finally {
      // 无论成败都重新拉取，确保列表与主进程状态一致（失败时回落到未切换的原状态）
      await loadWorkspaces()
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

  // ── 对话框 ──
  const handleAdd = () => {
    setEditWorkspace(undefined)
    setWsName(''); setWsCwd(''); setWsNote(''); setWsModel(''); setWsEnv([])
    setTriedSubmit(false); setConfirmDelete(false); setSaveError(null)
    setShowDialog(true)
  }
  const handleEdit = (ws: HarnessWorkspace) => {
    setEditWorkspace(ws)
    setWsName(ws.name); setWsCwd(ws.cwd); setWsNote(ws.note || ''); setWsModel(ws.model || '')
    setWsEnv(ws.env ? Object.entries(ws.env).map(([key, value]) => ({ key, value })) : [])
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
    const note = wsNote.trim()
    const model = wsModel.trim()
    const modelPayload = model.length > 0 ? model : undefined
    // 折叠 env：丢弃空 key 行；同名 key 后者覆盖；空时传 undefined（启动即用系统环境变量）
    const env: Record<string, string> = {}
    for (const row of wsEnv) {
      const k = row.key.trim()
      if (k) env[k] = row.value
    }
    const envPayload = Object.keys(env).length > 0 ? env : undefined
    // order 由主进程仓库分配递增，前端不再传 workspaces.length（删除后可能产生重复）
    const res = editWorkspace
      ? await api.update({ ...editWorkspace, name, cwd, note: note || undefined, model: modelPayload, env: envPayload })
      : await api.add({ name, cwd, note: note || undefined, model: modelPayload, env: envPayload })
    // 保存失败（校验未通过 / 落盘失败）：保留表单，展示具体错误，不关闭对话框
    if (res && res.success === false) {
      setSaveError(typeof res.error === 'string' ? res.error : t(`${prefix}.wsSaveFailed`))
      return
    }
    // 新建成功即选中新建项，让全局栏地球仪指向它（否则地球仪仍开置顶工作区，用户会以为新建没生效）
    if (!editWorkspace && res && res.success && res.workspace) {
      setSelectedWsId(res.workspace.id)
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

  // 环境变量行编辑（对齐 AgentsPanel 的 env 编辑器）
  const addEnvRow = () => setWsEnv((prev) => [...prev, { key: '', value: '' }])
  const updateEnvRow = (i: number, field: 'key' | 'value', value: string) =>
    setWsEnv((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)))
  const removeEnvRow = (i: number) => setWsEnv((prev) => prev.filter((_, idx) => idx !== i))
  // 当前 env 行里尚缺的默认变量（按 key 名精确匹配）
  const missingEnv = view.envDefaults.filter(
    (d) => !wsEnv.some((row) => row.key.trim() === d.key)
  )
  // 一键补全缺失的默认变量（保留已有行，仅追加缺失项）
  const fillEnv = () => {
    setWsEnv((prev) => [
      ...prev,
      ...view.envDefaults
        .filter((d) => !prev.some((row) => row.key.trim() === d.key))
        .map((d) => ({ key: d.key, value: d.value }))
    ])
  }

  const missing: string[] = status ? deps.filter((d) => !status[d]) : []
  // 全局栏 Web 入口作用于置顶（首个）工作区 —— getAll 已按 pinned 优先、order 升序返回
  const topWorkspace = workspaces.length > 0 ? workspaces[0] : undefined
  // 地球仪实际目标：优先「当前选中」工作区（新建后自动选中），否则回落置顶工作区
  const globeTarget = (selectedWsId ? workspaces.find(w => w.id === selectedWsId) : undefined) ?? topWorkspace

  return (
    <div
      className="w-full h-full flex flex-col bg-[var(--bg-base)] p-3 space-y-2"
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* 标题 + 全局操作（Web 入口 / 重新检测） */}
      <div className="flex items-center justify-between gap-1 flex-shrink-0">
        <span className="flex items-center gap-2 text-[15px] font-semibold tracking-[0.02em] [font-family:inherit] text-[var(--text-rack)]">
          {/* 通电 LED —— 标题的琥珀色锚点，与对话框头条同源；工作区眉条无此标记，形成主从层次 */}
          <span aria-hidden className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] shadow-[0_0_5px_var(--amber-glow)] flex-shrink-0" />
          {t(`${prefix}.title`)}
        </span>
        <div className="flex items-center gap-0">
          {/* 依赖就绪且有工作区时，Web 入口（地球仪）提升到全局栏，作用于「当前选中/置顶」工作区；分屏改为拖拽 Web 页签 */}
          {view.hasWeb && listReady && globeTarget && (
            <button
              onClick={() => void handleWeb(globeTarget)}
              title={t(`${prefix}.webLaunch`)}
              disabled={!!webOpeningId}
              className="w-[24px] h-[24px] flex items-center justify-center bg-transparent border-none rounded-[4px] cursor-pointer transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--amber)] disabled:opacity-50 disabled:cursor-wait"
            >
              <IconGlobe />
            </button>
          )}
          {/* 新建工作区入口 —— 依赖就绪即提升到全局栏 */}
          {listReady && (
            <button
              onClick={handleAdd}
              title={t(`${prefix}.wsAddTitle`)}
              className="w-[24px] h-[24px] flex items-center justify-center bg-transparent border-none rounded-[4px] cursor-pointer transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--amber)]"
            >
              <IconPlus />
            </button>
          )}
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

      {/* 就绪：工作区列表（多工作区；首个依赖就绪即可） */}
      {listReady && (
        <>
          <div className="flex items-center justify-between gap-1 flex-shrink-0">
            <span className="text-[11px] font-semibold tracking-[0.08em] [font-family:inherit] text-[var(--text-rack-mute)]">
              {t(`${prefix}.wsHeader`)}
              <span className="text-[var(--text-rack-dim)] mx-1.5">·</span>
              <span className="text-[var(--text-rack)] font-medium tabular-nums">{workspaces.length}</span>
            </span>
          </div>

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
                        {ws.pinned && (
                          <span aria-hidden className="inline-flex align-[-1px] mr-1 text-[var(--amber)]">
                            <IconPin />
                          </span>
                        )}
                        {ws.name}
                        {launching && <span className="ml-1.5 text-[10.5px] [font-family:inherit] text-[var(--amber)]">{t(`${prefix}.launching`)}</span>}
                      </span>
                      <span className="text-[11px] [font-family:inherit] text-[var(--text-rack-data)] truncate leading-tight">{ws.cwd}</span>
                      {ws.note && (
                        <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] truncate leading-tight">{ws.note}</span>
                      )}
                    </span>
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto pl-6 bg-gradient-to-l from-[var(--bg-slot)] from-[24%] to-transparent">
                      {view.hasWeb && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedWsId(ws.id); void handleWeb(ws) }}
                          title={t(`${prefix}.webLaunch`)}
                          disabled={!!webOpeningId}
                          className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--amber)] disabled:opacity-50 disabled:cursor-wait"
                        >
                          <IconGlobe />
                        </button>
                      )}
                      <button
                        onClick={async (e) => { e.stopPropagation(); await togglePin(ws) }}
                        title={ws.pinned ? t(`${prefix}.wsUnpin`) : t(`${prefix}.wsPin`)}
                        className={cn(
                          'w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors',
                          ws.pinned
                            ? 'text-[var(--amber)] hover:bg-[var(--bg-elev)]'
                            : 'text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--amber)]'
                        )}
                      >
                        <IconPin filled={ws.pinned} />
                      </button>
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

            {/* 备注（可选，仅用于记录） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--text-rack)]">{t(`${prefix}.wsNote`)}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t(`${prefix}.wsNoteHint`)}</span>
              </div>
              <textarea
                value={wsNote}
                onChange={(e) => setWsNote(e.target.value)}
                placeholder={t(`${prefix}.wsNotePh`)}
                rows={2}
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)] resize-none"
              />
            </div>

            {/* 模型 —— dsh 走补丁、codex/claude 走 --model；留空则用各 CLI 默认 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t(`${prefix}.wsModel`)}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]" title={t(`${prefix}.wsModelHintTitle`)}>· {t(`${prefix}.wsModelHint`)}</span>
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
                {view.modelSuggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            {/* 环境变量 —— 注入 CLI 会话；留空则用系统环境变量 */}
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
                {wsEnv.length === 0 ? (
                  <button
                    onClick={addEnvRow}
                    className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                  >
                    + {t(`${prefix}.wsEnvAdd`)}
                  </button>
                ) : (
                  <>
                    {wsEnv.map((row, i) => (
                      <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0">
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) => updateEnvRow(i, 'key', e.target.value)}
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
    </div>
  )
}

export default HarnessPanel
