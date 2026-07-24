import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// 内置品牌图标:Vite new URL 模式取打包后资产 URL(免 *.png 模块声明)
const claudeIcon = new URL('../../assets/agent-icons/claude.png', import.meta.url).href
const codexIcon = new URL('../../assets/agent-icons/codex.png', import.meta.url).href

/**
 * Agent 面板(机柜左列 Agents 页签内容)。
 *
 * 从原 Sidebar 的 AGENTS 横条升级为独立面板:每个 agent 一张机柜槽位卡,
 * 显示 名称 / 命令 / 工作目录,单击启动、右键编辑、hover 出编辑/删除。
 * 状态、CRUD handler 与编辑对话框整体从 Sidebar 迁出,沿用 sidebar.agent* 文案键。
 *
 * 编辑对话框按"插槽规格表"组织:面板(图标+名称)/ 命令 / 工作目录 / 环境变量 / 实时预览,
 * 与 SessionDialog 同壳(448px / h-10 header / 电源 LED / rounded-sm)。
 * env 字段后端早已支持(注入孵化终端),此前 UI 未暴露 -- 此处补齐 key-value 行编辑器。
 *
 * 提亮处理(避免"暗淡"):section 眉条用 --amber(琥珀脊,结构化表单 + 贴合品牌焦点色);
 * 输入井用 --bg-slot(亮槽,而非比壳更深的暗坑)。
 * 字色分级:已填值 = --text-rack(最亮);placeholder / 路径 / 添加变量 = --text-rack-data(可读二级,
 * 仍比已填值暗,空/填区分保留);env 值提到 --text-rack 与命令同级;琥珀保留给焦点(env 键/眉条/❯)。
 * 预览井保持 --bg-base 深色 -- 它是终端屏,深色才对,琥珀 ❯ 已作标记。
 */

interface AgentConfig {
  id: string
  name: string
  command: string
  icon?: string
  cwd?: string
  env?: Record<string, string>
  order: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 图标(与 Sidebar 既有图标同语言:1.4 stroke / square cap)
// ─────────────────────────────────────────────────────────────────────────────

const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10"/></svg>
)
const IconEdit = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 9l1-3 5-5 2 2-5 5z"/></svg>
)
const IconX = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7"/></svg>
)
/** 文件夹 -- 工作目录选择器按钮 */
const IconFolder = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter"><path d="M2 4.5h4l1.5 2H14v6H2z"/></svg>
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
  if (bundled) return <BundledIconView entry={bundled} className="w-[18px] h-[18px]" />
  return <IconRobot />
}

// ─────────────────────────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────────────────────────

const AgentsPanel: React.FC = () => {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [editAgent, setEditAgent] = useState<AgentConfig | undefined>(undefined)
  const [agentName, setAgentName] = useState('')
  const [agentCommand, setAgentCommand] = useState('')
  const [agentIcon, setAgentIcon] = useState('')
  const [agentCwd, setAgentCwd] = useState('')
  // 环境变量:以行数组编辑,保存时折叠为 Record<string,string>(空 key 行丢弃)
  const [agentEnv, setAgentEnv] = useState<{ key: string; value: string }[]>([])
  // 校验:首次提交前不报错;删除两步确认(复用 closeAll 的"再点一次"语义)
  const [triedSubmit, setTriedSubmit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 图标选择器浮层开合 + 外部点击关闭用 ref
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const iconPickerRef = useRef<HTMLDivElement>(null)

  const loadAgents = async () => {
    try {
      const result = await window.electronAPI?.listAgents()
      if (Array.isArray(result)) setAgents(result as AgentConfig[])
    } catch (err) {
      console.error('Failed to load agents:', err)
    }
  }
  useEffect(() => { loadAgents() }, [])

  // 图标选择器浮层:外部点击关闭
  useEffect(() => {
    if (!iconPickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
        setIconPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [iconPickerOpen])

  // ESC 退出对话框 -- 文档级监听,不依赖子元素焦点(覆盖层本身不可聚焦)
  // 处于删除二次确认态时,首次 ESC 仅回退确认态,再次 ESC 才关闭(与两步确认语义一致)
  useEffect(() => {
    if (!showDialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // 优先级:图标浮层 > 删除二次确认 > 关闭对话框(逐层回退,ESC 不越级跳)
      if (iconPickerOpen) {
        setIconPickerOpen(false)
        return
      }
      if (confirmDelete) {
        setConfirmDelete(false)
        return
      }
      setShowDialog(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showDialog, confirmDelete, iconPickerOpen])

  const handleLaunch = async (agentId: string) => {
    await window.electronAPI?.launchAgent(agentId)
  }

  const handleAdd = () => {
    setEditAgent(undefined)
    setAgentName(''); setAgentCommand(''); setAgentIcon(''); setAgentCwd('')
    setAgentEnv([])
    setTriedSubmit(false); setConfirmDelete(false); setIconPickerOpen(false)
    setShowDialog(true)
  }
  const handleContextMenu = (agent: AgentConfig, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setEditAgent(agent)
    setAgentName(agent.name); setAgentCommand(agent.command)
    setAgentIcon(agent.icon || ''); setAgentCwd(agent.cwd || '')
    setAgentEnv(agent.env ? Object.entries(agent.env).map(([key, value]) => ({ key, value })) : [])
    setTriedSubmit(false); setConfirmDelete(false); setIconPickerOpen(false)
    setShowDialog(true)
  }
  const handleSave = async () => {
    if (!agentName.trim() || !agentCommand.trim()) {
      setTriedSubmit(true)
      return
    }
    // 折叠 env:丢弃空 key 行;同名 key 后者覆盖
    const env: Record<string, string> = {}
    for (const row of agentEnv) {
      const k = row.key.trim()
      if (k) env[k] = row.value
    }
    const envPayload = Object.keys(env).length > 0 ? env : undefined
    if (editAgent) {
      await window.electronAPI?.updateAgent({
        ...editAgent,
        name: agentName.trim(),
        command: agentCommand.trim(),
        icon: agentIcon || undefined,
        cwd: agentCwd || undefined,
        env: envPayload
      })
    } else {
      await window.electronAPI?.addAgent({
        name: agentName.trim(),
        command: agentCommand.trim(),
        icon: agentIcon || undefined,
        cwd: agentCwd || undefined,
        env: envPayload,
        order: agents.length
      })
    }
    await loadAgents()
    setShowDialog(false)
  }
  const handleDelete = async () => {
    // 两步确认:首次点击切到确认态,再次点击才真正删除
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    if (editAgent) {
      await window.electronAPI?.deleteAgent(editAgent.id)
      await loadAgents()
      setShowDialog(false)
    }
  }

  // 环境变量行编辑
  const addEnvRow = () => setAgentEnv(prev => [...prev, { key: '', value: '' }])
  const updateEnvRow = (i: number, field: 'key' | 'value', value: string) =>
    setAgentEnv(prev => prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)))
  const removeEnvRow = (i: number) => setAgentEnv(prev => prev.filter((_, idx) => idx !== i))

  // 工作目录:复用通用目录选择器(与下载设置同源),弹原生选择框;以当前填入路径为起始目录
  const handlePickCwd = async () => {
    const result = await window.electronAPI?.showOpenDialog({
      title: t('agents.edit.browse'),
      // 仅以绝对路径作起始目录;~ 开头 Electron 不展开,会相对 app cwd 打开,故跳过
      defaultPath: agentCwd && !agentCwd.startsWith('~') ? agentCwd : undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result && !result.canceled && result.filePaths.length > 0) {
      setAgentCwd(result.filePaths[0])
    }
  }

  const valid = agentName.trim().length > 0 && agentCommand.trim().length > 0
  const envKeys = agentEnv.map(r => r.key.trim()).filter(Boolean)
  // 编辑中 command 对应的内置图标(emoji 为空时在选择器按钮上预览)
  const previewIcon = bundledIconFor(agentCommand)

  return (
    <div className="flex flex-col h-full bg-[var(--bg-base)] min-w-0">
      {/* 头条:AGENTS · 计数 + 添加 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--rule)] flex-shrink-0">
        <span className="font-semibold tracking-[.18em] text-[11px] text-[var(--text-rack)] select-none">
          {t('agents.title')}
          <span className="text-[var(--text-rack-dim)] mx-1.5 font-normal">·</span>
          <span className="text-[var(--text-rack-mute)] font-medium tabular-nums">{agents.length}</span>
        </span>
        <button
          onClick={handleAdd}
          title={t('sidebar.addAgent')}
          className="w-[24px] h-[24px] flex items-center justify-center bg-transparent border-none rounded-[3px] cursor-pointer transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--amber)]"
        >
          <IconPlus />
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto min-h-0 rack-scroll">
        {agents.length === 0 ? (
          // 空状态 -- 沿用机柜 ─ · ─ 分隔 + 提示
          <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
            <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
            <span className="text-[11.5px] text-[var(--text-rack-mute)]">{t('agents.empty')}</span>
            <span className="text-[10.5px] font-mono text-[var(--text-rack-faint)]">{t('agents.emptyHint')}</span>
          </div>
        ) : (
          agents.map(agent => (
            <div
              key={agent.id}
              onClick={() => handleLaunch(agent.id)}
              onContextMenu={(e) => handleContextMenu(agent, e)}
              title={`${agent.name}: ${agent.command}`}
              className="group relative flex items-center gap-2.5 px-3 min-h-[42px] py-1.5 cursor-pointer transition-colors bg-[var(--bg-rack)] border-b border-[var(--rule-soft)] shadow-[inset_0_-1px_0_var(--bg-base)] hover:bg-[var(--bg-slot)]"
            >
              {/* 图标槽:emoji > 内置品牌图标 > 默认机器人头 */}
              <span className="flex-shrink-0 w-[24px] h-[24px] inline-flex items-center justify-center text-[15px] leading-none text-[var(--text-rack-mute)] group-hover:text-[var(--amber)] transition-colors">
                <AgentSlotIcon agent={agent} />
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[13px] font-semibold text-[var(--text-rack)] truncate leading-tight">{agent.name}</span>
                <span className="font-mono text-[10.5px] text-[var(--text-rack-data)] truncate leading-tight">
                  {agent.command}{agent.cwd ? ` · ${agent.cwd}` : ''}
                </span>
              </span>
              {/* hover actions */}
              <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto pl-8 bg-gradient-to-l from-[var(--bg-slot)] from-[24%] to-transparent">
                <button
                  onClick={(e) => handleContextMenu(agent, e)}
                  title={t('sidebar.agentEditTitle')}
                  className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
                >
                  <IconEdit />
                </button>
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    await window.electronAPI?.deleteAgent(agent.id)
                    await loadAgents()
                  }}
                  title={t('sidebar.agentDelete')}
                  className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--error-rack)]"
                >
                  <IconX />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Agent 编辑对话框 -- 机柜"插槽规格表":header + 面板(图标/名称) + 命令/工作目录/环境变量 + 实时预览 */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm w-[448px] max-h-[88vh] overflow-y-auto rack-scroll shadow-xl">
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

            {/* 面板:图标 + 名称(插槽丝印) */}
            <div className="flex items-center gap-2.5 py-3.5 px-4 border-b border-[var(--rule)]">
              {/* 图标:点选 emoji(浮层);留空回退自动 exe 图标。非文本输入,避免敲 emoji 的别扭 */}
              <div className="relative flex-shrink-0" ref={iconPickerRef}>
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
                  <div className="absolute top-full left-0 mt-1 z-50 w-[224px] bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm p-1.5 shadow-xl">
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
                <span className="text-[12px] font-mono tracking-[0.06em] text-[var(--amber)]">{t('agents.edit.command')}</span>
                <span className="text-[10.5px] text-[var(--text-rack-mute)]">· {t('agents.edit.commandHint')}</span>
              </div>
              <input
                type="text"
                value={agentCommand}
                onChange={(e) => { setAgentCommand(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
                placeholder="claude"
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 font-mono focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* WORKDIR */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] font-mono tracking-[0.06em] text-[var(--amber)]">{t('agents.edit.workdir')}</span>
                <span className="text-[10.5px] text-[var(--text-rack-mute)]">· {t('agents.edit.workdirHint')}</span>
              </div>
              <div className="flex items-stretch gap-1.5">
                <input
                  type="text"
                  value={agentCwd}
                  onChange={(e) => setAgentCwd(e.target.value)}
                  placeholder="~/projects/lyshell"
                  className="flex-1 min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 font-mono focus:outline-none focus:border-[var(--amber)]"
                />
                <button
                  type="button"
                  onClick={handlePickCwd}
                  title={t('agents.edit.browse')}
                  className="flex-shrink-0 w-[34px] inline-flex items-center justify-center bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[var(--text-rack-mute)] hover:text-[var(--amber)] hover:border-[var(--amber)] transition-colors"
                >
                  <IconFolder />
                </button>
              </div>
            </div>

            {/* ENVIRONMENT -- 后端早已支持 env(注入孵化终端),此前 UI 未暴露;此处补齐 key-value 行编辑器 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] font-mono tracking-[0.06em] text-[var(--amber)]">{t('agents.edit.env')}</span>
                <span className="text-[10.5px] text-[var(--text-rack-mute)]">· {t('agents.edit.envHint')}</span>
              </div>
              <div className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm overflow-hidden">
                {agentEnv.length === 0 ? (
                  <button
                    onClick={addEnvRow}
                    className="w-full text-left py-1.5 px-2.5 text-[11.5px] font-mono text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                  >
                    + {t('agents.edit.envAdd')}
                  </button>
                ) : (
                  <>
                    {agentEnv.map((row, i) => (
                      <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0">
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) => updateEnvRow(i, 'key', e.target.value)}
                          placeholder={t('agents.edit.envKeyPh')}
                          className="flex-1 min-w-0 bg-transparent border-none text-[12px] font-mono text-[var(--amber)] placeholder:text-[var(--text-rack-data)] focus:outline-none"
                        />
                        <span className="text-[var(--text-rack-mute)] font-mono text-[12px] select-none">=</span>
                        <input
                          type="text"
                          value={row.value}
                          onChange={(e) => updateEnvRow(i, 'value', e.target.value)}
                          placeholder={t('agents.edit.envValuePh')}
                          className="flex-[2] min-w-0 bg-transparent border-none text-[12px] font-mono text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] focus:outline-none"
                        />
                        <button
                          onClick={() => removeEnvRow(i)}
                          title={t('sidebar.agentDelete')}
                          className="w-[18px] h-[18px] flex-shrink-0 inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] text-[var(--text-rack-faint)] hover:text-[var(--error-rack)] transition-colors"
                        >
                          <IconX />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={addEnvRow}
                      className="w-full text-left py-1.5 px-2.5 text-[11.5px] font-mono text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                    >
                      + {t('agents.edit.envAdd')}
                    </button>
                  </>
                )}
              </div>
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

            {/* 校验提示(仅尝试提交后显示) */}
            {triedSubmit && !valid && (
              <div className="px-4 py-2 text-[11px] text-[var(--error-rack)] border-b border-[var(--rule)]">
                {t('agents.edit.required')}
              </div>
            )}

            {/* footer:删除(两步确认)/ 取消 / 保存 */}
            <div className="flex items-center justify-between px-4 py-3">
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
                  onClick={() => setShowDialog(false)}
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
                  {t('sidebar.agentSave')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentsPanel
