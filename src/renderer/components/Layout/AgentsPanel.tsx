import DialogClose from '@/components/Layout/DialogClose'
import { PanelHeader, PanelHeaderMenu } from './PanelHeader'
import { IconPlus } from './IconBtn'
import WorkspaceLauncherTree from './WorkspaceLauncherTree'
import React, { useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { findManagedWorkspace } from './work-launcher-tree'
import { formatCodeWorkspaceName, type CodeWorkspacePreset } from '@shared/code-workspaces'
import RackSelect from './RackSelect'
import './HarnessPanel.css'
import './AgentsPanel.css'
import { generateWorktreeStamp } from '@shared/worktree'
import EnvRowsEditor from '../EnvRowsEditor'
import { useUiStore } from '../../stores/ui-store'
import { useDismiss, useEscDismiss } from '../../hooks'
// 内置品牌图标:Vite new URL 模式取打包后资产 URL(免 *.png 模块声明)
const claudeIcon = new URL('../../assets/agent-icons/claude.png', import.meta.url).href
const codexIcon = new URL('../../assets/agent-icons/codex.png', import.meta.url).href

/**
 * 与 Codex / Claude 共用设置工作区。名称启动命令，独立箭头展开行内配置；
 * 新建弹窗与行内编辑共用字段、校验和保存流程。
 */

interface AgentConfig {
  id: string
  name: string
  command: string
  icon?: string
  workspacePresetId?: string
  cwd?: string
  isolation?: 'shared' | 'worktree'
  worktreeKey?: string
  env?: Record<string, string>
  envProfileId?: string
  /** 绑定变量组时结构化核心(baseUrl/apiKey)的注入变量名(见主进程 AgentConfig) */
  envKeyMap?: { baseUrl?: string; apiKey?: string }
  order: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 图标(与 Sidebar 既有图标同语言:1.4 stroke / square cap)
// ─────────────────────────────────────────────────────────────────────────────

const IconX = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7"/></svg>
)
/** 默认 agent 图标(未设 icon 时用) -- 与 ActivityRail 的机器人头同源 */
const IconRobot = () => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square">
    <rect x="4" y="6" width="12" height="9.5" rx="1" />
    <path d="M10 3v3" />
    <circle cx="10" cy="2.6" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="7.6" cy="10.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.4" cy="10.2" r="1" fill="currentColor" stroke="none" />
    <path d="M7.8 12.8h4.4" />
  </svg>
)

/** 图标选择器内置 emoji 集 -- 面向 AI/开发 agent,点击即用;清空则回退内置/机器人头 */
const ICON_EMOJIS = ['🤖','🧠','⚡','🚀','🐙','🤝','🛠️','📦','🔧','💡','🎯','📊','🔬','🦾','🧩','⚙️','🌐','💻','🗂️','📁','🔌','🔥','✨','🌟','🎨','🦊','🐍','🐳','🍄','🪐','🧪','🦄']

/** 内置品牌图标条目:src=资产 URL;mode=img 用原色(自有配色,明暗皆可见),
 *  mode=mask 用 CSS mask 按 --text-rack 着色(单色剪影,明暗主题自适应)。 */
interface BundledIconEntry { src: string; mode: 'img' | 'mask' }

/**
 * 已知品牌 CLI 的内置图标(打包进 LyShell,按 command 首 token 小写匹配)。
 * 不再运行时从 exe 抠图(不可靠:shim 指向 node.exe、大 exe 抠取失败、Rust 二进制无图标资源);
 * 用 command 名直接映射内置 PNG。无匹配则回退 emoji/机器人头。
 * 新增品牌:抠/取图标到 assets/agent-icons/<name>.png,在此登记即可。
 *  - 自带配色的品牌标(如 Anthropic 暖色)用 mode:'img';
 *  - 单色剪影(如 OpenAI 花朵)用 mode:'mask',随主题文字色着色,明暗皆可见。
 */
const BUNDLED_ICON_BY_COMMAND: Record<string, BundledIconEntry> = {
  claude: { src: claudeIcon, mode: 'img' },
  codex: { src: codexIcon, mode: 'mask' }
}

/** 取 command 首 token(剥引号、小写)查内置图标;无匹配返回 null。 */
function bundledIconFor(command: string): BundledIconEntry | null {
  const t = command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '').toLowerCase()
  return (t && BUNDLED_ICON_BY_COMMAND[t]) || null
}

/** 渲染内置品牌图标:mask 模式取资产 alpha 作剪影、按 --text-rack 着色(明暗自适应);
 *  img 模式直接显示原色品牌标。 */
const BundledIconView: React.FC<{ entry: BundledIconEntry; className?: string; title?: string }> = ({ entry, className, title }) => {
  if (entry.mode === 'mask') {
    // mask 模式:bg 着色(默认文字色 --text-rack);列表行内随 .group 悬停切 --amber,
    // 与 IconRobot(currentColor)的悬停高亮一致(emoji 色字与 img 品牌色不参与,各自合理)
    return (
      <span
        aria-hidden
        title={title}
        className={`inline-block bg-[var(--text-rack)] group-hover:bg-[var(--amber)] transition-colors ${className ?? ''}`}
        style={{
          maskImage: `url(${entry.src})`,
          WebkitMaskImage: `url(${entry.src})`,
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat'
        }}
      />
    )
  }
  // img 模式:object-contain 只对替换元素生效,故挂此分支(mask 的 <span> 上无效,不再下发)
  return <img src={entry.src} alt="" title={title} className={`${className ?? ''} object-contain`} />
}

/** agent 图标槽内容:emoji > 内置品牌图标 > 机器人头(颜色/尺寸槽由调用方包裹) */
const AgentSlotIcon: React.FC<{ agent: AgentConfig }> = ({ agent }) => {
  if (agent.icon) return <span className="text-[15px] leading-none">{agent.icon}</span>
  const bundled = bundledIconFor(agent.command)
  if (bundled) return <BundledIconView entry={bundled} className="w-[16px] h-[16px]" />
  return <IconRobot />
}

// ─────────────────────────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────────────────────────

const AgentsPanel: React.FC<{ visible?: boolean; onOpenEnvSettings?: () => void; onOpenWorkspaceSettings?: () => void }> = ({ visible = true, onOpenEnvSettings, onOpenWorkspaceSettings }) => {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null)
  const closeEditor = () => {
    if (savingRef.current) return
    setShowDialog(false)
    setIconPickerOpen(false)
    editorTriggerRef.current?.focus()
  }
  const [editAgent, setEditAgent] = useState<AgentConfig | undefined>(undefined)
  const [agentName, setAgentName] = useState('')
  const [agentCommand, setAgentCommand] = useState('')
  const [agentIcon, setAgentIcon] = useState('')
  const [agentCwd, setAgentCwd] = useState('')
  const [agentIsolation, setAgentIsolation] = useState<'shared' | 'worktree'>('shared')
  const [agentWorktreeKey, setAgentWorktreeKey] = useState('')
  const [workspacePresets, setWorkspacePresets] = useState<CodeWorkspacePreset[]>([])
  const [agentPresetId, setAgentPresetId] = useState('')
  const agentsRequestSeq = useRef(0)
  // 环境变量:以行数组编辑,保存时折叠为 Record<string,string>(空 key 行丢弃)
  const [agentEnv, setAgentEnv] = useState<{ key: string; value: string }[]>([])
  // 绑定的全局变量组 id(null = 不绑定,回落内联 env → 系统环境变量)
  const [agentEnvProfileId, setAgentEnvProfileId] = useState<string | null>(null)
  // 绑定变量组时结构化核心(baseUrl/apiKey)的注入变量名 —— 命令读哪些变量名只有
  // agent 作者知道,故映射跟 agent 走(空 = 不注入该维度,绑定的组只透传附加变量)
  const [agentEnvKeyMapBaseUrl, setAgentEnvKeyMapBaseUrl] = useState('')
  const [agentEnvKeyMapApiKey, setAgentEnvKeyMapApiKey] = useState('')
  // 全局变量组列表(绑定下拉用;拉失败不阻断编辑 —— 下拉只有「不绑定」一项)
  const [envProfiles, setEnvProfiles] = useState<{ id: string; name: string }[]>([])
  // 全局启用指针(env-profile:list 一并下发) —— 新建 agent 的绑定下拉默认选它,
  // 与 Harness 工作区对话框同一默认;agent 无「跟随」档,选中即显式绑定
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  // 变量组列表是否已成功拉到 —— 空列表有两种含义(「一个都没有」与「还没拉到/拉失败」),
  // 只有前者才允许把 agent 的悬空绑定判为悬空,见 handleContextMenu
  const [envProfilesLoaded, setEnvProfilesLoaded] = useState(false)
  // 校验:首次提交前不报错;删除两步确认(复用 closeAll 的"再点一次"语义)
  const [triedSubmit, setTriedSubmit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 保存失败(IPC 返回 success:false 或 invoke reject)—— 保留表单并展示原因
  const [saveError, setSaveError] = useState<string | null>(null)
  // 列表级操作失败(卡片删除落盘失败等)—— 与 EnvProfilePanel 的 actionError 同族
  const [actionError, setActionError] = useState<string | null>(null)
  const [launchingAgentId, setLaunchingAgentId] = useState<string | null>(null)
  const launchingAgentRef = useRef(false)
  // 列表行内删除的两步确认:记录待确认的 agent id(null = 无待确认)——
  // 与 Harness 工作区/变量组卡同一套删除仪式
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  // 图标选择器浮层开合 + 外部点击关闭用 ref
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const iconPickerRef = useRef<HTMLDivElement>(null)

  const loadAgents = async () => {
    const requestSeq = ++agentsRequestSeq.current
    try {
      const result = await window.electronAPI?.listAgents()
      if (requestSeq === agentsRequestSeq.current && Array.isArray(result)) setAgents(result as AgentConfig[])
    } catch (err) {
      console.error('Failed to load agents:', err)
    }
  }
  useEffect(() => {
    if (visible) void loadAgents()
  }, [visible])
  const selectAgentPreset = (preset: CodeWorkspacePreset) => {
    setAgentPresetId(preset.id); setAgentCwd(preset.cwd)
    setAgentIsolation(preset.isolation === 'worktree' ? 'worktree' : 'shared')
    setAgentWorktreeKey(preset.worktreeKey ?? '')
    if (!editAgent && !agentName.trim()) setAgentName(preset.name)
    setSaveError(null)
    try { localStorage.setItem('lyshell.codeWorkspacePreset.v1', preset.id) } catch { /* 本次选择继续生效 */ }
  }
  useEffect(() => {
    if (!showDialog) return
    if (agentCwd || agentPresetId) {
      const matched = findManagedWorkspace({ id: editAgent?.id ?? '', workspacePresetId: agentPresetId || undefined, cwd: agentCwd, isolation: agentIsolation, worktreeKey: agentWorktreeKey }, workspacePresets, window.electronAPI?.platform ?? '')
      setAgentPresetId(matched?.id ?? '')
      if (matched) {
        setAgentCwd(matched.cwd)
        setAgentIsolation(matched.isolation === 'worktree' ? 'worktree' : 'shared')
        setAgentWorktreeKey(matched.worktreeKey ?? '')
      }
      return
    }
    if (!editAgent) {
      let remembered = ''
      try { remembered = localStorage.getItem('lyshell.codeWorkspacePreset.v1') || '' } catch { /* 使用首项 */ }
      const selected = workspacePresets.find(preset => preset.id === remembered) ?? workspacePresets[0]
      if (selected) selectAgentPreset(selected)
    }
    // 只在设置列表更新或打开编辑时同步目标，避免输入时重置草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePresets, showDialog])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void window.electronAPI?.listEnvProfiles().then(result => {
      if (!cancelled && result && Array.isArray(result.profiles)) {
        setEnvProfiles(result.profiles)
        setActiveProfileId(typeof result.activeProfileId === 'string' ? result.activeProfileId : null)
        setEnvProfilesLoaded(true)
        setAgentEnvProfileId(current => current && !result.profiles.some(p => p.id === current) ? null : current)
      }
    }).catch(err => console.error('Failed to load env profiles:', err))
    return () => { cancelled = true }
  }, [visible])

  useDismiss(iconPickerOpen && visible, () => setIconPickerOpen(false), [iconPickerRef])
  useEscDismiss(showDialog && visible, () => {
    if (confirmDelete) { setConfirmDelete(false); return }
    closeEditor()
  })

  const handleLaunch = async (agentId: string) => {
    if (launchingAgentRef.current) return
    launchingAgentRef.current = true
    setLaunchingAgentId(agentId)
    setActionError(null)
    try {
      const result = await window.electronAPI?.launchAgent(agentId)
      if (result?.success === false) setActionError(result.error || t('agents.launchFailed'))
    } catch (error) { setActionError(error instanceof Error ? error.message : t('agents.launchFailed')) }
    finally { launchingAgentRef.current = false; setLaunchingAgentId(null) }
  }

  const handleAdd = () => {
    if (savingRef.current) return
    editorTriggerRef.current = null
    setEditAgent(undefined)
    setAgentName(''); setAgentCommand(''); setAgentIcon(''); setAgentCwd('')
    setAgentPresetId(''); setAgentIsolation('shared'); setAgentWorktreeKey('')
    setAgentEnv([]); setAgentEnvProfileId(activeProfileId)
    setAgentEnvKeyMapBaseUrl(''); setAgentEnvKeyMapApiKey('')
    setTriedSubmit(false); setConfirmDelete(false); setIconPickerOpen(false); setSaveError(null)
    setShowDialog(true)
  }

  // 外部「新建 Agent」请求(ui-store,如 /ls 清点文档的新建链接):本面板条件挂载,
  // 请求落 store 跨挂载存活,挂载后读到存量也能开对话框,消费后归零防误弹
  const createRequestId = useUiStore(s => s.createDialogRequests.agents ?? 0)
  useEffect(() => {
    if (!createRequestId) return
    handleAdd()
    useUiStore.getState().consumeCreateDialogRequest('agents')
    // 请求消费只看 id;handleAdd 的引用变化不构成「再来一次」(它读 activeProfileId
    // 只为给新建表单预选默认绑定,不参与触发判据)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequestId])
  const handleEdit = (agent: AgentConfig) => {
    if (savingRef.current) return
    setEditAgent(agent)
    setAgentName(agent.name); setAgentCommand(agent.command)
    setAgentIcon(agent.icon || ''); setAgentCwd(agent.cwd || '')
    setAgentIsolation(agent.isolation === 'worktree' ? 'worktree' : 'shared')
    setAgentWorktreeKey(agent.worktreeKey ?? '')
    const matched = findManagedWorkspace(agent, workspacePresets, window.electronAPI?.platform ?? '')
    setAgentPresetId(matched?.id ?? '')
    setAgentEnv(agent.env ? Object.entries(agent.env).map(([key, value]) => ({ key, value })) : [])
    // 绑定的变量组已被删除时按「不绑定」呈现 —— 与主进程 resolveAgentLaunchEnv 的回落
    // (悬空 → 内联 env → 系统)一致,否则下拉会显示成「什么都没选中」,看不出实际生效哪份。
    // 与 Harness 工作区同一条归一化规则:只在列表确实拉到之后才成立(agent 与变量组是
    // 并发 IPC,拉取前/拉失败时 envProfiles 还是 [],会把有效绑定误判成悬空,保存后绑定
    // 就没了) —— 列表状态未知时一律透传原值
    setAgentEnvProfileId(
      !envProfilesLoaded || (agent.envProfileId !== undefined && envProfiles.some((p) => p.id === agent.envProfileId))
        ? agent.envProfileId ?? null
        : null
    )
    setAgentEnvKeyMapBaseUrl(agent.envKeyMap?.baseUrl || '')
    setAgentEnvKeyMapApiKey(agent.envKeyMap?.apiKey || '')
    setTriedSubmit(false); setConfirmDelete(false); setIconPickerOpen(false); setSaveError(null)
    setShowDialog(true)
  }
  const handleSave = async () => {
    if (savingRef.current) return
    if (!agentCommand.trim() || (!workspacePresets.some(preset => preset.id === agentPresetId))) {
      setTriedSubmit(true)
      return
    }
    // 名称留空 → 默认名「工作区-<时间戳>」（与 Harness 工作区同一套默认命名,
    // 时间戳格式同为 @shared/worktree 的 generateWorktreeStamp:YYYYMMDD-HHmm）
    const name = agentName.trim() || `${t('agents.edit.defaultName')}-${generateWorktreeStamp()}`
    // 折叠 env:丢弃空 key 行;同名 key 后者覆盖
    const env: Record<string, string> = {}
    for (const row of agentEnv) {
      const k = row.key.trim()
      if (k) env[k] = row.value
    }
    const envPayload = Object.keys(env).length > 0 ? env : undefined
    // 绑定的变量组:「键存在」语义 —— null 显式传 undefined 即取消绑定(主进程不会沿用旧值)
    const envProfileIdPayload = agentEnvProfileId ?? undefined
    // 注入变量名:trim 后两空 = 未声明(undefined,不写键);主进程按整条替换清掉旧声明
    const mapBaseUrl = agentEnvKeyMapBaseUrl.trim()
    const mapApiKey = agentEnvKeyMapApiKey.trim()
    const envKeyMapPayload =
      mapBaseUrl || mapApiKey
        ? { ...(mapBaseUrl ? { baseUrl: mapBaseUrl } : {}), ...(mapApiKey ? { apiKey: mapApiKey } : {}) }
        : undefined
    setSaveError(null)
    savingRef.current = true
    setSaving(true)
    // 双通道失败都落到 saveError:handler 正常返回走 success:false 分支,主进程
    // 意外抛错(invoke reject)走 catch —— 两边都保留表单,用户能看到原因
    try {
      const res = editAgent
        ? await window.electronAPI?.updateAgent({
            ...editAgent,
            name,
            command: agentCommand.trim(),
            icon: agentIcon || undefined,
            workspacePresetId: agentPresetId,
            cwd: agentCwd || undefined,
            isolation: agentIsolation,
            worktreeKey: agentIsolation === 'worktree' ? agentWorktreeKey : undefined,
            env: envPayload,
            envProfileId: envProfileIdPayload,
            envKeyMap: envKeyMapPayload
          })
        : await window.electronAPI?.addAgent({
            name,
            command: agentCommand.trim(),
            icon: agentIcon || undefined,
            workspacePresetId: agentPresetId,
            cwd: agentCwd || undefined,
            isolation: agentIsolation,
            worktreeKey: agentIsolation === 'worktree' ? agentWorktreeKey : undefined,
            env: envPayload,
            envProfileId: envProfileIdPayload,
            envKeyMap: envKeyMapPayload,
            order: agents.length
          })
      if (res && res.success === false) {
        setSaveError(typeof res.error === 'string' ? res.error : t('agents.edit.saveFailed'))
        return
      }
      await loadAgents()
      setShowDialog(false)
      editorTriggerRef.current?.focus()
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : t('agents.edit.saveFailed'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const handleDelete = async () => {
    // 两步确认:首次点击切到确认态,再次点击才真正删除
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    if (editAgent) {
      // 失败(落盘失败/agent 已不存在)保留对话框并展示原因,不静默吞掉
      try {
        const res = await window.electronAPI?.deleteAgent(editAgent.id)
        if (res && res.success === false) {
          setConfirmDelete(false)
          setSaveError(typeof res.error === 'string' ? res.error : t('agents.edit.deleteFailed'))
          return
        }
      } catch (err) {
        setConfirmDelete(false)
        setSaveError(err instanceof Error && err.message ? err.message : t('agents.edit.deleteFailed'))
        return
      }
      await loadAgents()
      setShowDialog(false)
    }
  }

  // 环境变量行编辑：脱敏/明文切换逻辑在共享组件 EnvRowsEditor 内
  const envRowsTexts = {
    keyPh: t('agents.edit.envKeyPh'),
    valuePh: t('agents.edit.envValuePh'),
    addRow: t('agents.edit.envAdd'),
    deleteTitle: t('sidebar.agentDelete'),
    showValue: t('agents.edit.envShowValue'),
    hideValue: t('agents.edit.envHideValue')
  }

  // 名称可留空(保存时默认「工作区-<时间戳>」),命令必填 —— 它才是 Agent 的身份
  const valid = agentCommand.trim().length > 0 && (workspacePresets.some(preset => preset.id === agentPresetId))
  const envKeys = agentEnv.map(r => r.key.trim()).filter(Boolean)
  // 编辑中 command 对应的内置图标(emoji 为空时在选择器按钮上预览)
  const previewIcon = bundledIconFor(agentCommand)

  // 新建与行内编辑共用字段、校验和保存流程。
  const renderAgentEditor = (inline: boolean) => (
    <fieldset disabled={saving} aria-busy={saving} className={cn('agents-editor', inline && 'agents-inline-editor')}>
    {/* 工作区目标与 Codex / Claude 相同，只从设置预设选择。 */}
    <div className="py-3.5 px-4 border-b border-[var(--rule)]">
      <div className="flex items-baseline gap-2 mb-2">
        <label htmlFor="agent-workspace" className="text-[12px] text-[var(--amber)]">{t('settings.workspace')}</label>
        {onOpenWorkspaceSettings && <button type="button" className="ml-auto text-[12px] text-[var(--text-rack-data)] underline underline-offset-2" onClick={onOpenWorkspaceSettings}>{t('workspacePresets.manage')}</button>}
      </div>
      <RackSelect id="agent-workspace" value={agentPresetId} className="rack-select"
        onChange={event => { const preset = workspacePresets.find(item => item.id === event.target.value); if (preset) selectAgentPreset(preset) }}>
        <option value="" disabled>{t('workspacePresets.choose')}</option>
        {workspacePresets.map(preset => <option key={preset.id} value={preset.id}>{formatCodeWorkspaceName(preset)}</option>)}
      </RackSelect>
      <p className="agents-workspace-target">{agentCwd || t('workspacePresets.empty')}{agentIsolation === 'worktree' && agentWorktreeKey ? ` · ${agentWorktreeKey}` : ''}</p>
    </div>

    {/* 面板:图标 + 名称(插槽丝印) */}
    <div className="flex items-center gap-2.5 py-3.5 px-4 border-b border-[var(--rule)]">
      {/* 图标:点选 emoji(浮层);留空回退自动 exe 图标。非文本输入,避免敲 emoji 的别扭 */}
      <div className="agents-icon-anchor relative flex-shrink-0" ref={iconPickerRef}>
        <button
          type="button"
          onClick={() => setIconPickerOpen(o => !o)}
          title={t('agents.edit.iconPh')}
          className="w-7 h-7 flex items-center justify-center bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[var(--text-rack)] hover:border-[var(--amber)] focus:outline-none focus:border-[var(--amber)] transition-colors"
        >
          {agentIcon ? (
            <span className="text-[15px] leading-none">{agentIcon}</span>
          ) : previewIcon ? (
            <BundledIconView entry={previewIcon} title={t('agents.edit.iconAuto')} className="w-[18px] h-[18px]" />
          ) : (
            <span className="text-[15px] leading-none text-[var(--text-rack-data)]">🤖</span>
          )}
        </button>
        {iconPickerOpen && (
          <div className="agents-icon-picker absolute top-full left-0 mt-1 z-50 w-[224px] bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm p-1.5 shadow-xl">
            <div className="grid grid-cols-8 gap-0.5">
              {ICON_EMOJIS.map(em => (
                <button
                  key={em}
                  type="button"
                  onClick={() => { setAgentIcon(em); setIconPickerOpen(false) }}
                  className="w-6 h-6 flex items-center justify-center text-[15px] leading-none rounded-sm hover:bg-[var(--bg-slot)] transition-colors overflow-hidden"
                >
                  {em}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => { setAgentIcon(''); setIconPickerOpen(false) }}
              className="mt-1 pt-1 w-full text-[10.5px] font-mono text-[var(--text-rack-data)] hover:text-[var(--amber)] border-t border-[var(--rule-soft)] transition-colors"
            >
              {t('agents.edit.iconClear')}
            </button>
          </div>
        )}
      </div>
      <input
        type="text"
        aria-label={t('agents.edit.name')}
        value={agentName}
        onChange={(e) => { setAgentName(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
        placeholder={t('agents.edit.namePh')}
        autoFocus
        className="flex-1 min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
      />
    </div>

    {/* COMMAND */}
    <div className="py-3.5 px-4 border-b border-[var(--rule)]">
      <div className="flex items-baseline gap-2 mb-2">
        <label htmlFor="agent-command" className="text-[12px] font-mono tracking-[0.06em] text-[var(--amber)]">{t('agents.edit.command')}</label>
        <span className="text-[10.5px] text-[var(--text-rack-mute)]">· {t('agents.edit.commandHint')}</span>
      </div>
      <input
        type="text"
        id="agent-command"
        value={agentCommand}
        onChange={(e) => { setAgentCommand(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
        placeholder="claude"
        className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 font-mono focus:outline-none focus:border-[var(--amber)]"
      />
    </div>

    <details className="agents-editor-advanced" open={inline ? undefined : true}>
      <summary>{t('workspacePresets.advanced')}</summary>
    {/* ENV PROFILE -- 绑定全局变量组(优先于下方内联变量;与 Harness 工作区同一套绑定语义) */}
    <div className="py-3.5 px-4 border-b border-[var(--rule)]">
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <span className="text-[12px] font-mono tracking-[0.06em] text-[var(--amber)]">{t('agents.edit.envProfile')}</span>
        <span className="text-[10.5px] text-[var(--text-rack-mute)]">· {t('agents.edit.envProfileHint')}</span>
        {onOpenEnvSettings && <button type="button" className="ml-auto text-[12px] text-[var(--text-rack-data)] hover:text-[var(--amber)] underline underline-offset-2" onClick={onOpenEnvSettings}>{t('env.manage')}</button>}
      </div>
      <select
        value={agentEnvProfileId ?? ''}
        onChange={(e) => setAgentEnvProfileId(e.target.value || null)}
        className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] text-[var(--text-rack)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)] appearance-none cursor-pointer"
      >
        <option value="">{t('agents.edit.envProfileNone')}</option>
        {envProfiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {/* 注入变量名:变量组核心存的是协议无关的 baseURL/apiKey,启动时按这两个
          名字注入 —— 命令读哪些变量名只有 agent 作者知道,故跟 agent 走。
          留空 = 不注入该维度(绑定的组仍透传附加变量) */}
      {agentEnvProfileId && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <input
            type="text"
            value={agentEnvKeyMapBaseUrl}
            onChange={(e) => setAgentEnvKeyMapBaseUrl(e.target.value)}
            placeholder={t('agents.edit.mapBaseUrl')}
            title={t('agents.edit.mapHint')}
            spellCheck={false}
            className="w-full min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[12px] font-mono text-[var(--text-rack)] placeholder:text-[var(--text-rack-faint)] py-1 px-2 focus:outline-none focus:border-[var(--amber)]"
          />
          <input
            type="text"
            value={agentEnvKeyMapApiKey}
            onChange={(e) => setAgentEnvKeyMapApiKey(e.target.value)}
            placeholder={t('agents.edit.mapApiKey')}
            title={t('agents.edit.mapHint')}
            spellCheck={false}
            className="w-full min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[12px] font-mono text-[var(--text-rack)] placeholder:text-[var(--text-rack-faint)] py-1 px-2 focus:outline-none focus:border-[var(--amber)]"
          />
        </div>
      )}
    </div>

    {/* ENVIRONMENT -- 后端早已支持 env(注入孵化终端),此前 UI 未暴露;此处补齐 key-value 行编辑器(与 Harness 变量组共用组件,敏感值默认打码)。
        绑定了变量组时提示「内联不生效」—— 解析链是绑定组 → 内联 → 系统(命中即用不合并) */}
    <div className="py-3.5 px-4 border-b border-[var(--rule)]">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[12px] font-mono tracking-[0.06em] text-[var(--amber)]">{t('agents.edit.env')}</span>
        <span className="text-[10.5px] text-[var(--text-rack-mute)]">
          · {agentEnvProfileId ? t('agents.edit.envInlineBound') : t('agents.edit.envHint')}
        </span>
      </div>
      <EnvRowsEditor stacked={inline} value={agentEnv} onChange={setAgentEnv} texts={envRowsTexts} />
    </div>

    {/* PREVIEW -- 签名:实时渲染启动时真正执行的命令行(终端口吻,随输入更新) */}
    <div className="py-3.5 px-4 border-b border-[var(--rule)]">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[12px] font-mono tracking-[0.06em] text-[var(--amber)]">{t('agents.edit.preview')}</span>
        <span className="text-[10.5px] text-[var(--text-rack-mute)]">· {t('agents.edit.previewHint')}</span>
      </div>
      <div className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm px-3 py-2 font-mono text-[12px] leading-relaxed overflow-hidden">
        {agentCommand.trim() ? (
          <div className="flex items-center gap-1.5 min-w-0">
            {agentCwd.trim() && (
              <span className="text-[var(--text-rack-data)] truncate">{agentCwd.trim()}</span>
            )}
            <span className="text-[var(--amber)] flex-shrink-0">❯</span>
            <span className="text-[var(--text-rack)] truncate">{agentCommand.trim()}</span>
          </div>
        ) : (
          <span className="text-[var(--text-rack-mute)]">{t('agents.edit.previewNoCmd')}</span>
        )}
        {envKeys.length > 0 && (
          <div className="flex items-center gap-1.5 mt-1 min-w-0 flex-wrap">
            <span className="text-[var(--text-rack-mute)] text-[10.5px]">env</span>
            {envKeys.map((k, idx) => (
              <span key={idx} className="text-[var(--amber)] text-[10.5px] tracking-[0.02em]">{k}</span>
            ))}
          </div>
        )}
      </div>
    </div>

    </details>

    {/* 校验提示(仅尝试提交后显示) */}
    {triedSubmit && !valid && (
      <div className="px-4 py-2 text-[11px] text-[var(--error-rack)] border-b border-[var(--rule)]">
        {t('agents.edit.required')}
      </div>
    )}

    {/* 保存失败提示(校验未通过 / 落盘失败,保留表单) */}
    {saveError && (
      <div role="alert" className="px-4 py-2 text-[11px] text-[var(--error-rack)] border-b border-[var(--rule)] break-all">
        {saveError}
      </div>
    )}

    {/* footer:删除(两步确认)/ 取消 / 保存 */}
    <div className="agents-editor-actions flex items-center justify-between px-4 py-3">
      {editAgent ? (
        <button
          onClick={handleDelete}
          className={
            confirmDelete
              ? 'px-2.5 py-1 text-[12px] rounded-sm bg-[var(--error-rack)] text-[var(--bg-base)] font-medium transition-colors'
              : 'px-2.5 py-1 text-[12px] text-[var(--error-rack)] hover:bg-[var(--bg-slot)] rounded-sm transition-colors'
          }
        >
          {confirmDelete ? t('agents.edit.confirmDelete') : t('sidebar.agentDelete')}
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={closeEditor}
          className="px-3 py-1 text-[13px] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
        >
          {t('sidebar.agentCancel')}
        </button>
        <button
          onClick={handleSave}
          className={`px-4 py-1 text-[13px] rounded-sm font-medium transition-opacity ${
            valid
              ? 'bg-[var(--amber)] text-[var(--bg-base)] hover:opacity-90'
              : 'bg-[var(--bg-slot)] text-[var(--text-rack-dim)] opacity-70'
          }`}
        >
          {saving ? t('agents.edit.saving') : t('sidebar.agentSave')}
        </button>
      </div>
    </div>
    </fieldset>
  )

  // 子项沿用项目树行边界，命令保留在名称下方；启动与编辑/删除按钮互不嵌套。
  const renderAgentCard = (agent: AgentConfig) => (
    <div key={agent.id} className="harness-workspace-item">
      <div
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); handleEdit(agent) }}
        onMouseLeave={() => { if (deleteConfirmId === agent.id) setDeleteConfirmId(null) }}
        className="group relative harness-project-row agents-project-row"
      >
        <button type="button" className="workspace-launcher-disclosure agents-editor-toggle"
          title={t('sidebar.agentEditTitle')} aria-label={`${t('agents.edit.toggle')} · ${agent.name}`}
          aria-expanded={showDialog && editAgent?.id === agent.id} aria-controls={`agent-editor-${agent.id}`}
          disabled={saving}
          onClick={event => {
            editorTriggerRef.current = event.currentTarget
            if (showDialog && editAgent?.id === agent.id) closeEditor()
            else handleEdit(agent)
          }}>
          <svg className={cn('workspace-launcher-chevron', { 'is-open': showDialog && editAgent?.id === agent.id })} width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" /></svg>
        </button>
        <button type="button" className="harness-workspace-main agents-workspace-main" aria-label={agent.name}
          disabled={launchingAgentId !== null || saving} aria-busy={launchingAgentId === agent.id}
          title={`${agent.name}: ${agent.command}`} onClick={() => handleLaunch(agent.id)}>
          {/* 图标槽:emoji > 内置品牌图标 > 默认机器人头 */}
          <span className="harness-workspace-symbol" aria-hidden="true">
            <AgentSlotIcon agent={agent} />
          </span>
          <span className="agents-workspace-copy">
            <span className="agents-workspace-name">{agent.name}</span>
            <span className="agents-workspace-command">
              {agent.command}
            </span>
          </span>
        </button>
        {/* 悬停或键盘焦点进入行后显示操作，保留独立按钮位置 */}
        <div className="agents-workspace-actions">
          <button
            disabled={saving}
            onClick={async (e) => {
              e.stopPropagation()
              // 两步确认:首次点击切到确认态,再次点击才真正删除(与工作区/变量组卡一致)
              if (deleteConfirmId !== agent.id) {
                setDeleteConfirmId(agent.id)
                return
              }
              setDeleteConfirmId(null)
              // 失败(落盘失败/agent 已不存在)不静默:卡片在下方 loadAgents()
              // 后"复活"前给出原因 —— 与拨分接开关/变量组卡片删除同族错误位
              try {
                const res = await window.electronAPI?.deleteAgent(agent.id)
                if (res && res.success === false) {
                  setActionError(typeof res.error === 'string' ? res.error : t('agents.edit.deleteFailed'))
                }
              } catch (err) {
                setActionError(err instanceof Error && err.message ? err.message : t('agents.edit.deleteFailed'))
              } finally {
                await loadAgents()
              }
            }}
            title={deleteConfirmId === agent.id ? t('agents.edit.confirmDelete') : t('sidebar.agentDelete')}
            className={cn(
              'w-[22px] h-[22px] inline-flex items-center justify-center border-none cursor-pointer rounded-[2px] transition-colors',
              deleteConfirmId === agent.id
                ? 'bg-[var(--error-rack)] text-[var(--bg-base)]'
                : 'bg-transparent text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--error-rack)]'
            )}
          >
            <IconX />
          </button>
        </div>
      </div>
      <div id={`agent-editor-${agent.id}`} hidden={!(showDialog && editAgent?.id === agent.id)}>
        {showDialog && editAgent?.id === agent.id && visible && renderAgentEditor(true)}
      </div>
    </div>
  )

  return (
    <div
      className="flex flex-col h-full bg-[var(--bg-base)] min-w-0"
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      <WorkspaceLauncherTree visible={visible} agents={agents} renderAgent={renderAgentCard}
        onManage={onOpenWorkspaceSettings} onPresetsChange={setWorkspacePresets} refreshKey={showDialog}
        renderHeader={controls => <PanelHeader title={t('agents.workLauncher')} actions={<>
          {controls}
          <PanelHeaderMenu title={t('panelHeader.add')} icon={<IconPlus/>} items={[
            { label: t('sidebar.addAgent'), onClick: handleAdd },
            ...(onOpenWorkspaceSettings ? [{ label: t('workspacePresets.add'), onClick: onOpenWorkspaceSettings }] : [])
          ]}/>
          {(onOpenWorkspaceSettings || onOpenEnvSettings) && <PanelHeaderMenu title={t('agents.launcherManage')} items={[
            ...(onOpenWorkspaceSettings ? [{ label: t('workspacePresets.manage'), onClick: onOpenWorkspaceSettings }] : []),
            ...(onOpenEnvSettings ? [{ label: t('env.manage'), onClick: onOpenEnvSettings }] : [])
          ]}/>}
        </>}/>}/>
      {actionError && <div role="alert" className="agents-launch-error">{actionError}</div>}

      {/* Agent 编辑对话框 -- 机柜"插槽规格表":header + 面板(图标/名称) + 命令/工作目录/环境变量 + 实时预览 */}
      {showDialog && !editAgent && visible && (
        <div className="ly-dialog-backdrop fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="ly-dialog-surface bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm w-[448px] max-h-[88vh] overflow-y-auto rack-scroll shadow-xl">
            <DialogClose onClose={closeEditor} />
            {/* header:电源 LED + 标题 + 类型牌 */}
            <div className="flex items-center h-10 px-4 border-b border-[var(--rule)] gap-2.5">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: 'var(--amber)', boxShadow: '0 0 5px var(--amber)' }}
              />
              <span className="text-[13px] font-medium tracking-[0.04em] text-[var(--text-rack)]">
                {editAgent ? t('sidebar.agentEditTitle') : t('sidebar.agentAddTitle')}
              </span>
              <span className="flex-1" />
              <span className="text-[10.5px] font-mono tracking-[0.08em] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] text-[var(--text-rack-mute)]">
                Agent
              </span>
            </div>

            {renderAgentEditor(false)}
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentsPanel
