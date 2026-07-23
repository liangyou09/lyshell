import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

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

  const loadAgents = async () => {
    try {
      const result = await window.electronAPI?.listAgents()
      if (Array.isArray(result)) setAgents(result as AgentConfig[])
    } catch (err) {
      console.error('Failed to load agents:', err)
    }
  }
  useEffect(() => { loadAgents() }, [])

  const handleLaunch = async (agentId: string) => {
    await window.electronAPI?.launchAgent(agentId)
  }

  const handleAdd = () => {
    setEditAgent(undefined)
    setAgentName(''); setAgentCommand(''); setAgentIcon(''); setAgentCwd('')
    setAgentEnv([])
    setTriedSubmit(false); setConfirmDelete(false)
    setShowDialog(true)
  }
  const handleContextMenu = (agent: AgentConfig, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setEditAgent(agent)
    setAgentName(agent.name); setAgentCommand(agent.command)
    setAgentIcon(agent.icon || ''); setAgentCwd(agent.cwd || '')
    setAgentEnv(agent.env ? Object.entries(agent.env).map(([key, value]) => ({ key, value })) : [])
    setTriedSubmit(false); setConfirmDelete(false)
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

  const valid = agentName.trim().length > 0 && agentCommand.trim().length > 0
  const envKeys = agentEnv.map(r => r.key.trim()).filter(Boolean)

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
              {/* 图标槽:有 emoji 直接显,否则默认机器人头 */}
              <span className="flex-shrink-0 w-[24px] h-[24px] inline-flex items-center justify-center text-[15px] leading-none text-[var(--text-rack-mute)] group-hover:text-[var(--amber)] transition-colors">
                {agent.icon ? <span>{agent.icon}</span> : <IconRobot />}
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
              <span className="text-[10.5px] font-mono tracking-[0.14em] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] text-[var(--text-rack-mute)]">
                AGENT
              </span>
            </div>

            {/* 面板:图标 + 名称(插槽丝印) */}
            <div className="flex items-center gap-2.5 py-3.5 px-4 border-b border-[var(--rule)]">
              <input
                type="text"
                value={agentIcon}
                onChange={(e) => setAgentIcon(e.target.value)}
                placeholder="🤖"
                title={t('agents.edit.iconPh')}
                className="w-7 h-7 flex-shrink-0 text-center text-[15px] leading-none bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] focus:outline-none focus:border-[var(--amber)]"
              />
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
                <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-[var(--amber)]">{t('agents.edit.command')}</span>
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
                <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-[var(--amber)]">{t('agents.edit.workdir')}</span>
                <span className="text-[10.5px] text-[var(--text-rack-mute)]">· {t('agents.edit.workdirHint')}</span>
              </div>
              <input
                type="text"
                value={agentCwd}
                onChange={(e) => setAgentCwd(e.target.value)}
                placeholder="~/projects/lyshell"
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 font-mono focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* ENVIRONMENT -- 后端早已支持 env(注入孵化终端),此前 UI 未暴露;此处补齐 key-value 行编辑器 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-[var(--amber)]">{t('agents.edit.env')}</span>
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
                <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-[var(--amber)]">{t('agents.edit.preview')}</span>
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
