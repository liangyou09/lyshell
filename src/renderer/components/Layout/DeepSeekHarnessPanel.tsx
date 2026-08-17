import React, { useCallback, useEffect, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'

/**
 * DeepSeek Harness 面板 —— 检测 dsh（官方 CLI）与 dsh-tui（TUI 插件）是否已安装。
 *
 * 缺失依赖时只提示 + 给出安装命令与仓库链接（不自动安装，用户已确认）。
 * 就绪后管理多个「工作区」：每个工作区 = 名称 + 工作目录，单击在对应目录内启动 dsh-tui
 * （交互参照 Agent 面板：列表 + 单击启动 + hover 编辑/删除 + 右上角新增）。
 * 样式沿用机柜令牌（--bg-base/--bg-slot/--rule/--amber/--text-rack*）与 12px 等宽基线。
 */

const INSTALL_COMMAND = 'npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui'

/** 两个依赖各自的源码仓库 —— 提示卡各展示一行，指向对应包的出处 */
const REPOS: { dep: string; url: string }[] = [
  { dep: 'dsh', url: 'https://github.com/deepseek-ai/deepseek-harness' },
  { dep: 'dsh-tui', url: 'https://github.com/ccch1mneyyy/dsh-TUI' },
]

interface DshStatus {
  dsh: boolean
  dshTui: boolean
}

/** 工作区 —— 与主进程 DshWorkspace 同构（渲染层本地类型，参照 AgentConfig 的做法） */
interface DshWorkspace {
  id: string
  name: string
  cwd: string
  order: number
  note?: string
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

const IconPlus: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10" /></svg>
)

const IconEdit: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 9l1-3 5-5 2 2-5 5z" /></svg>
)

const IconX: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7" /></svg>
)

const DeepSeekHarnessPanel: React.FC = () => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DshStatus | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // 工作区列表与启动状态
  const [workspaces, setWorkspaces] = useState<DshWorkspace[]>([])
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [launchFailed, setLaunchFailed] = useState(false)
  // 新增/编辑对话框
  const [showDialog, setShowDialog] = useState(false)
  const [editWorkspace, setEditWorkspace] = useState<DshWorkspace | undefined>(undefined)
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')
  const [wsNote, setWsNote] = useState('')
  const [triedSubmit, setTriedSubmit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const runDetect = useCallback(async () => {
    setDetecting(true)
    try {
      const res = await window.electronAPI?.detectDsh()
      if (res && typeof res === 'object') {
        setStatus({ dsh: Boolean(res.dsh), dshTui: Boolean(res.dshTui) })
      }
    } catch (err) {
      console.error('Failed to detect dsh:', err)
    } finally {
      setDetecting(false)
    }
  }, [])

  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listDshWorkspaces()
      if (Array.isArray(result)) setWorkspaces(result as DshWorkspace[])
    } catch (err) {
      console.error('Failed to load dsh workspaces:', err)
    }
  }, [])

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

  const handleLaunch = async (ws: DshWorkspace) => {
    if (launchingId) return
    setLaunchingId(ws.id)
    setLaunchFailed(false)
    try {
      const res = await window.electronAPI?.launchDshWorkspace(ws.id)
      if (res && res.success === false) {
        console.error('dsh workspace launch failed:', res.error)
        setLaunchFailed(true)
        // 检测与点击之间依赖可能已被卸载 —— 重新检测刷新 UI，回到「缺少依赖」提示卡
        void runDetect()
      }
    } catch (err) {
      console.error('dsh workspace launch failed:', err)
      setLaunchFailed(true)
    } finally {
      setLaunchingId(null)
    }
  }

  // ── 对话框 ──
  const handleAdd = () => {
    setEditWorkspace(undefined)
    setWsName(''); setWsCwd(''); setWsNote('')
    setTriedSubmit(false); setConfirmDelete(false)
    setShowDialog(true)
  }
  const handleEdit = (ws: DshWorkspace) => {
    setEditWorkspace(ws)
    setWsName(ws.name); setWsCwd(ws.cwd); setWsNote(ws.note || '')
    setTriedSubmit(false); setConfirmDelete(false)
    setShowDialog(true)
  }
  const handlePickCwd = async () => {
    const result = await window.electronAPI?.showOpenDialog({
      title: t('dsh.browse'),
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
    const name = wsName.trim()
    const cwd = wsCwd.trim()
    const note = wsNote.trim()
    if (editWorkspace) {
      await window.electronAPI?.updateDshWorkspace({ ...editWorkspace, name, cwd, note })
    } else {
      await window.electronAPI?.addDshWorkspace({ name, cwd, note, order: workspaces.length })
    }
    await loadWorkspaces()
    setShowDialog(false)
  }
  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    if (editWorkspace) {
      await window.electronAPI?.deleteDshWorkspace(editWorkspace.id)
      await loadWorkspaces()
      setShowDialog(false)
    }
  }

  const allInstalled = status !== null && status.dsh && status.dshTui
  const missing: string[] = []
  if (status) {
    if (!status.dsh) missing.push('dsh')
    if (!status.dshTui) missing.push('dsh-tui')
  }

  return (
    <div
      className="w-full h-full flex flex-col bg-[var(--bg-base)] p-3 space-y-2"
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* 标题 + 重新检测 */}
      <div className="flex items-center justify-between gap-1 flex-shrink-0">
        <span className="text-[12px] [font-family:inherit] text-[var(--text-rack)]">{t('dsh.title')}</span>
        <button
          onClick={() => void runDetect()}
          disabled={detecting}
          className="px-2 py-0.5 text-[11px] [font-family:inherit] rounded-[2px] border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
        >
          {detecting ? t('dsh.detecting') : t('dsh.redetect')}
        </button>
      </div>

      {/* 未就绪：依赖状态行 + 提示卡 */}
      {!allInstalled && (
        <>
          <div className="space-y-1">
            {(['dsh', 'dsh-tui'] as const).map((dep) => {
              const installed = status ? (dep === 'dsh' ? status.dsh : status.dshTui) : null
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
                    <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">{t('dsh.detecting')}</span>
                  ) : (
                    <span
                      className={cn(
                        'text-[10.5px] [font-family:inherit]',
                        installed ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)]'
                      )}
                    >
                      {installed ? t('dsh.installed') : t('dsh.missing')}
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
                    {t('dsh.missingDeps')}
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
                      {INSTALL_COMMAND}
                    </code>
                    <button
                      onClick={() => void copy(INSTALL_COMMAND, 'command')}
                      title={copied === 'command' ? t('dsh.copied') : t('dsh.copy')}
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
                {REPOS.map((repo) => {
                  const key = `repo-${repo.dep}`
                  return (
                    <div key={repo.dep} className="py-2 flex items-center gap-2">
                      <span className="w-[46px] shrink-0 text-[10px] [font-family:inherit] text-[var(--text-rack)]">{repo.dep}</span>
                      <span className="flex-1 min-w-0 text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)] break-all select-all">{repo.url}</span>
                      <button
                        onClick={() => void copy(repo.url, key)}
                        title={copied === key ? t('dsh.copied') : t('dsh.copy')}
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

      {/* 就绪：工作区列表（多工作区） */}
      {allInstalled && (
        <>
          <div className="flex items-center justify-between gap-1 flex-shrink-0">
            <span className="text-[12px] [font-family:inherit] text-[var(--text-rack)]">
              {t('dsh.wsHeader')}
              <span className="text-[var(--text-rack-dim)] mx-1.5">·</span>
              <span className="tabular-nums">{workspaces.length}</span>
            </span>
            <button
              onClick={handleAdd}
              title={t('dsh.wsAddTitle')}
              className="w-[24px] h-[24px] flex items-center justify-center bg-transparent border-none rounded-[3px] cursor-pointer transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--amber)]"
            >
              <IconPlus />
            </button>
          </div>

          {launchFailed && (
            <div className="text-[10.5px] [font-family:inherit] text-[var(--error-rack)]">{t('dsh.launchFailed')}</div>
          )}

          <div className="flex-1 overflow-y-auto min-h-0 space-y-1 rack-scroll">
            {workspaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
                <span className="text-[11.5px] [font-family:inherit] text-[var(--text-rack-mute)]">{t('dsh.wsEmpty')}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-faint)]">{t('dsh.wsEmptyHint')}</span>
              </div>
            ) : (
              workspaces.map((ws) => {
                const launching = launchingId === ws.id
                return (
                  <div
                    key={ws.id}
                    onClick={() => void handleLaunch(ws)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleEdit(ws) }}
                    title={t('dsh.launch')}
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
                        {launching && <span className="ml-1.5 text-[10.5px] [font-family:inherit] text-[var(--amber)]">{t('dsh.launching')}</span>}
                      </span>
                      <span className="text-[11px] [font-family:inherit] text-[var(--text-rack-data)] truncate leading-tight">{ws.cwd}</span>
                      {ws.note && (
                        <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] truncate leading-tight">{ws.note}</span>
                      )}
                    </span>
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto pl-6 bg-gradient-to-l from-[var(--bg-slot)] from-[24%] to-transparent">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEdit(ws) }}
                        title={t('dsh.wsEditTitle')}
                        className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
                      >
                        <IconEdit />
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          await window.electronAPI?.deleteDshWorkspace(ws.id)
                          await loadWorkspaces()
                        }}
                        title={t('dsh.wsDelete')}
                        className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--error-rack)]"
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
                {editWorkspace ? t('dsh.wsEditTitle') : t('dsh.wsAddTitle')}
              </span>
              <span className="flex-1" />
              <span className="text-[10.5px] [font-family:inherit] tracking-[0.08em] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] text-[var(--text-rack-mute)]">
                DSH
              </span>
            </div>

            {/* 名称 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t('dsh.wsName')}</span>
              </div>
              <input
                type="text"
                value={wsName}
                onChange={(e) => { setWsName(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
                placeholder={t('dsh.wsNamePh')}
                autoFocus
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* 工作目录 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t('dsh.wsCwd')}</span>
              </div>
              <div className="flex items-stretch gap-1.5">
                <input
                  type="text"
                  value={wsCwd}
                  onChange={(e) => { setWsCwd(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
                  placeholder={t('dsh.wsCwdPh')}
                  className="flex-1 min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
                />
                <button
                  type="button"
                  onClick={() => void handlePickCwd()}
                  title={t('dsh.browse')}
                  className="flex-shrink-0 w-[34px] inline-flex items-center justify-center bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[var(--text-rack-mute)] hover:text-[var(--amber)] hover:border-[var(--amber)] transition-colors cursor-pointer"
                >
                  <IconFolder />
                </button>
              </div>
            </div>

            {/* 备注（可选，仅用于记录） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--text-rack)]">{t('dsh.wsNote')}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t('dsh.wsNoteHint')}</span>
              </div>
              <textarea
                value={wsNote}
                onChange={(e) => setWsNote(e.target.value)}
                placeholder={t('dsh.wsNotePh')}
                rows={2}
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)] resize-none"
              />
            </div>

            {/* 校验提示（仅尝试提交后显示） */}
            {triedSubmit && !valid && (
              <div className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)]">
                {t('dsh.wsRequired')}
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
                  {confirmDelete ? t('dsh.wsConfirmDelete') : t('dsh.wsDelete')}
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDialog(false)}
                  className="px-3 py-1 text-[13px] [font-family:inherit] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
                >
                  {t('dsh.wsCancel')}
                </button>
                <button
                  onClick={() => void handleSave()}
                  className={`px-4 py-1 text-[13px] [font-family:inherit] rounded-sm font-medium transition-opacity ${
                    valid
                      ? 'bg-[var(--amber)] text-[var(--bg-base)] hover:opacity-90'
                      : 'bg-[var(--bg-slot)] text-[var(--text-rack-dim)] opacity-70'
                  }`}
                >
                  {t('dsh.wsSave')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DeepSeekHarnessPanel
