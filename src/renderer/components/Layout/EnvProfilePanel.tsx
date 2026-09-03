import React, { useState, useEffect, useCallback } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import {
  HARNESS_AGENT_KINDS,
  HARNESS_ENV_KEY_MAP,
  isValidHttpBaseUrl,
  type EnvProfileLibraryResult,
  type HarnessAgentKind,
  type HarnessEnvDefault,
  type HarnessEnvProfile
} from '@shared/harness'
import EnvRowsEditor, { type EnvRow } from '../EnvRowsEditor'
import { TOPBAR_HEIGHT } from './topbar-metrics'

/**
 * 环境变量面板 —— 全局变量组库的独占入口（左侧轨 env 页签）。
 *
 * 机柜语境里它是「配电盘」：变量组是从母线引出的电源模块，Agent 与各 harness
 * 工作区是从它取电的负载。本面板是唯一做增删改的地方（HarnessPanel 的环境变量
 * 页签瘦身为纯启用切换），卡片的签名元素是每张卡一排 per-kind 分接开关 ——
 * 点亮即把该 kind 的启用指针拨到这组，全应用只有这里能一眼看全「哪组在喂哪个
 * harness」的路由矩阵；卡片右侧的「n 处引用」是负载侧的回读（Agent 显式绑定 +
 * 工作区显式绑定），悬停列出引用方名字。
 *
 * CRUD 走 kind 无关的 env-profile:add/update/delete 通道；启用切换复用各 kind
 * 既有的 env:setActive（主进程写的是同一份 activeByKind 指针）。
 */

const IconPlus: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10" /></svg>
)

const IconEdit: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 9l1-3 5-5 2 2-5 5z" /></svg>
)

const IconX: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l7 7M9 2l-7 7" /></svg>
)

const IconCopy: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
)

/** 卡片 meta 用的上游地址摘要:取 URL 的 host(:port),解析失败回落原文截断显示 */
const baseUrlHost = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.length > 40 ? `${baseUrl.slice(0, 40)}…` : baseUrl
  }
}

/** 明文查看敏感值的眼睛(与 EnvRowsEditor 同款字形) */
const IconEye: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
)
const IconEyeOff: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.6 5.1C1.7 6.2 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.2 0 2.2-.3 3-.8M6.7 3.7c.4-.1.8-.2 1.3-.2 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.6 2.1" />
    <path d="M2.5 13.5l11-11" />
  </svg>
)

/** 单字段敏感输入(API Key 专用):默认打码,眼睛切换明文 —— 掩码手法与 EnvRowsEditor
 *  一致(-webkit-text-security:disc,不用 type=password 免去 Chromium 自带小眼睛) */
interface SecretInputProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  showTitle: string
  hideTitle: string
}
const SecretInput: React.FC<SecretInputProps> = ({ value, onChange, placeholder, showTitle, hideTitle }) => {
  const [visible, setVisible] = useState(false)
  return (
    <div className="flex items-stretch gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'flex-1 min-w-0 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]',
          !visible && '[-webkit-text-security:disc]'
        )}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        title={visible ? hideTitle : showTitle}
        className="flex-shrink-0 w-[30px] inline-flex items-center justify-center bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:border-[var(--text-rack-faint)] transition-colors"
      >
        {visible ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  )
}

/** 各 kind 推荐变量的拉取（主进程解析后的真实路径覆盖 shared 里的兜底值） */
const DEFAULTS_LOADERS: Record<HarnessAgentKind, () => Promise<HarnessEnvDefault[] | undefined>> = {
  dsh: () => window.electronAPI?.getDshEnvDefaults(),
  codex: () => window.electronAPI?.getCodexEnvDefaults(),
  claude: () => window.electronAPI?.getClaudeEnvDefaults()
}

/** 各 kind 启用指针的写入（主进程写同一份全局 activeByKind） */
const ACTIVE_SETTERS: Record<HarnessAgentKind, (id: string | null) => Promise<unknown>> = {
  dsh: (id) => window.electronAPI?.setDshEnvProfileActive(id) ?? Promise.resolve(),
  codex: (id) => window.electronAPI?.setCodexEnvProfileActive(id) ?? Promise.resolve(),
  claude: (id) => window.electronAPI?.setClaudeEnvProfileActive(id) ?? Promise.resolve()
}

const EnvProfilePanel: React.FC = () => {
  const { t } = useTranslation()

  // ── 库状态（env-profile:list 一并下发的三段） ──
  const [profiles, setProfiles] = useState<HarnessEnvProfile[]>([])
  const [activeByKind, setActiveByKind] = useState<Partial<Record<HarnessAgentKind, string>>>({})
  const [usage, setUsage] = useState<EnvProfileLibraryResult['usage']>({})
  // 空列表有两种含义（「一个都没有」与「还没拉到」），只有前者才给空态提示
  const [loaded, setLoaded] = useState(false)
  // 列表级操作错误横幅（启用切换失败等）
  const [actionError, setActionError] = useState<string | null>(null)
  // 指针切换进行中：禁用全部分接开关（同一时刻只允许拨一格）
  const [switching, setSwitching] = useState(false)
  // 卡片行内删除的两步确认：记录待确认的组 id（null = 无待确认）
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // 各 kind 的推荐变量（对话框里的一键补全模板）
  const [defaultsByKind, setDefaultsByKind] = useState<Partial<Record<HarnessAgentKind, HarnessEnvDefault[]>>>({})

  // ── 新增/编辑对话框 ──
  const [showDialog, setShowDialog] = useState(false)
  const [editProfile, setEditProfile] = useState<HarnessEnvProfile | undefined>(undefined)
  const [profileName, setProfileName] = useState('')
  const [profileNote, setProfileNote] = useState('')
  // 结构化核心:上游地址 + 凭据(凭据输入框自带打码/明文切换)
  const [profileBaseUrl, setProfileBaseUrl] = useState('')
  const [profileApiKey, setProfileApiKey] = useState('')
  // 附加变量:核心放不下的其余配置(CODEX_HOME 等)
  const [profileEnv, setProfileEnv] = useState<EnvRow[]>([])
  const [profileModels, setProfileModels] = useState<string[]>([])
  const [triedSubmit, setTriedSubmit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listEnvProfiles() as EnvProfileLibraryResult | undefined
      if (result && Array.isArray(result.profiles)) {
        setProfiles(result.profiles)
        setActiveByKind(result.activeByKind ?? {})
        setUsage(result.usage ?? {})
        setLoaded(true)
      }
    } catch (err) {
      console.error('Failed to load env profiles:', err)
    }
  }, [])

  // 推荐变量只在挂载时拉一次（主进程按已安装的 CLI 解析，会话内不变）
  useEffect(() => {
    void (async () => {
      const entries = await Promise.all(
        HARNESS_AGENT_KINDS.map(async (kind) => {
          try {
            const defs = await DEFAULTS_LOADERS[kind]()
            return [kind, Array.isArray(defs) ? defs : []] as const
          } catch {
            return [kind, []] as const
          }
        })
      )
      setDefaultsByKind(Object.fromEntries(entries))
    })()
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 引用计数：Agent 显式绑定 + 工作区显式绑定（跟随启用组的不算 —— 那是指针不是依赖） */
  const usageCount = (id: string): number => {
    const u = usage[id]
    return u ? u.agents.length + u.workspaces.length : 0
  }
  /** 引用方名字列表（title 提示用） */
  const usageNames = (id: string): string => {
    const u = usage[id]
    if (!u) return ''
    return [
      ...u.agents.map((a) => `Agent · ${a}`),
      ...u.workspaces.map((w) => `${w.kind} · ${w.name}`)
    ].join('  ·  ')
  }

  /** 拨分接开关：点亮 = 把该 kind 的启用指针拨到这组；再点亮的 = 拨回系统环境变量 */
  const toggleKind = async (kind: HarnessAgentKind, profileId: string) => {
    if (switching) return
    setSwitching(true)
    setActionError(null)
    try {
      const on = activeByKind[kind] === profileId
      const res = await ACTIVE_SETTERS[kind](on ? null : profileId)
      if (res && (res as { success?: boolean }).success === false) {
        setActionError(typeof (res as { error?: unknown }).error === 'string'
          ? (res as { error: string }).error
          : t('env.activeFailed'))
      }
    } catch (err) {
      console.error(`Env profile activation failed for ${kind}:`, err)
      setActionError(err instanceof Error ? err.message : t('env.activeFailed'))
    } finally {
      setSwitching(false)
      // 无论成败都重新拉取，失败时回落到真实状态
      await load()
    }
  }

  // ── 对话框：模型选项行编辑（单列，供工作区模型建议） ──
  const addModelRow = () => setProfileModels((prev) => [...prev, ''])
  const updateModelRow = (i: number, value: string) =>
    setProfileModels((prev) => prev.map((m, idx) => (idx === i ? value : m)))
  const removeModelRow = (i: number) =>
    setProfileModels((prev) => prev.filter((_, idx) => idx !== i))

  // 当前附加变量行里尚缺的某 kind 推荐变量 —— 结构化核心键(HARNESS_ENV_KEY_MAP 涉及的
  // baseUrl/apiKey 变量名)一律排除:那两个维度由上方专用输入框承载,不该再以附加变量出现
  const CORE_ENV_KEYS = new Set(
    HARNESS_AGENT_KINDS.flatMap((k) => [HARNESS_ENV_KEY_MAP[k].baseUrlKey, HARNESS_ENV_KEY_MAP[k].apiKeyKey])
  )
  const missingFor = (kind: HarnessAgentKind): HarnessEnvDefault[] =>
    (defaultsByKind[kind] ?? []).filter(
      (d) => !CORE_ENV_KEYS.has(d.key) && !profileEnv.some((row) => row.key.trim() === d.key)
    )
  // 一键补全该 kind 缺失的推荐变量（保留已有行，仅追加缺失项）
  const fillFromDefaults = (kind: HarnessAgentKind) => {
    setProfileEnv((prev) => [
      ...prev,
      ...missingFor(kind).map((d) => ({ key: d.key, value: d.value }))
    ])
  }

  const resetDialog = () => {
    setTriedSubmit(false)
    setConfirmDelete(false)
    setSaveError(null)
  }

  const handleAdd = () => {
    setEditProfile(undefined)
    setProfileName('')
    setProfileNote('')
    setProfileBaseUrl('')
    setProfileApiKey('')
    // 不预填任何 kind 的默认变量 —— 组是跨 kind 全局的，该补哪家配置由下方
    // 模板开关（+ codex / + claude）按需一键补全
    setProfileEnv([])
    setProfileModels([])
    resetDialog()
    setShowDialog(true)
  }

  const handleEdit = (p: HarnessEnvProfile) => {
    setEditProfile(p)
    setProfileName(p.name)
    setProfileNote(p.note || '')
    setProfileBaseUrl(p.baseUrl || '')
    setProfileApiKey(p.apiKey || '')
    setProfileEnv(Object.entries(p.env).map(([key, value]) => ({ key, value })))
    setProfileModels(p.models ? [...p.models] : [])
    resetDialog()
    setShowDialog(true)
  }

  /**
   * 复制变量组：以既有配置预填「新增」对话框（名称加后缀便于区分），保存才落盘，
   * 取消无副作用。走新增链路即不触碰启用指针 —— 副本不会抢走源组的分接档位。
   */
  const handleDuplicate = (p: HarnessEnvProfile) => {
    setEditProfile(undefined)
    setProfileName(`${p.name}${t('env.copySuffix')}`)
    setProfileNote(p.note || '')
    setProfileBaseUrl(p.baseUrl || '')
    setProfileApiKey(p.apiKey || '')
    setProfileEnv(Object.entries(p.env).map(([key, value]) => ({ key, value })))
    setProfileModels(p.models ? [...p.models] : [])
    resetDialog()
    setShowDialog(true)
  }

  // 折叠 env 行：丢弃空 key；同名 key 后者覆盖
  const collapseEnv = (rows: EnvRow[]): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const row of rows) {
      const k = row.key.trim()
      if (k) env[k] = row.value
    }
    return env
  }
  const profilePayloadEnv = collapseEnv(profileEnv)
  const profileBaseUrlTrimmed = profileBaseUrl.trim()
  const profileApiKeyTrimmed = profileApiKey.trim()
  // baseUrl 非空时必须是可解析的 http(s) URL(与主进程 assertProfileCredential 同一份判定)
  const profileBaseUrlValid = profileBaseUrlTrimmed.length === 0 || isValidHttpBaseUrl(profileBaseUrlTrimmed)
  // 有效 = 名称非空 + baseUrl 格式合法 + 三者至少其一(上游地址 / 凭据 / 附加变量)
  const profileValid =
    profileName.trim().length > 0 &&
    profileBaseUrlValid &&
    (profileBaseUrlTrimmed.length > 0 || profileApiKeyTrimmed.length > 0 || Object.keys(profilePayloadEnv).length > 0)

  const handleSave = async () => {
    if (!profileValid) { setTriedSubmit(true); return }
    setSaveError(null)
    const name = profileName.trim()
    // note/models 传 undefined 即清空（主进程 `if (safe.x !== undefined)` 不写这个键，
    // 记录整条替换后旧值即消失）—— 与工作区/变量组对话框同一套语义
    const note = profileNote.trim() || undefined
    // 核心两字段:trim 后为空传 undefined(主进程「非 undefined 即写入」的整条替换语义下
    // 即清空);apiKey 不 trim 值本体以外无从校验,与 baseUrl 同样按 trim 判空
    const baseUrlPayload = profileBaseUrlTrimmed || undefined
    const apiKeyPayload = profileApiKeyTrimmed || undefined
    const models = [...new Set(profileModels.map((m) => m.trim()).filter((m) => m.length > 0))]
    const modelsPayload = models.length > 0 ? models : undefined
    // 双通道失败都要落到 saveError：handler 正常返回时走 success:false 分支，
    // 主进程意外抛错（invoke reject）走 catch —— 两边都保留表单，用户能看到原因
    try {
      const res = editProfile
        ? await window.electronAPI?.updateEnvProfile({ ...editProfile, name, note, baseUrl: baseUrlPayload, apiKey: apiKeyPayload, env: profilePayloadEnv, models: modelsPayload })
        : await window.electronAPI?.addEnvProfile({ name, note, baseUrl: baseUrlPayload, apiKey: apiKeyPayload, env: profilePayloadEnv, models: modelsPayload })
      if (res && res.success === false) {
        setSaveError(typeof res.error === 'string' ? res.error : t('env.saveFailed'))
        return
      }
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : t('env.saveFailed'))
      return
    }
    await load()
    setShowDialog(false)
  }

  const handleDialogDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    if (editProfile) {
      // 组是 Agent/工作区绑定的目标，删除后绑定方回落下一级 —— 重新拉取让引用计数归零。
      // 失败(落盘失败/组已不存在)保留对话框并展示原因,不静默吞掉
      try {
        const res = await window.electronAPI?.deleteEnvProfile(editProfile.id)
        if (res && (res as { success?: boolean }).success === false) {
          setConfirmDelete(false)
          setSaveError(typeof (res as { error?: unknown }).error === 'string'
            ? (res as { error: string }).error
            : t('env.deleteFailed'))
          return
        }
      } catch (err) {
        setConfirmDelete(false)
        setSaveError(err instanceof Error && err.message ? err.message : t('env.deleteFailed'))
        return
      }
      await load()
      setShowDialog(false)
    }
  }

  const envRowsTexts = {
    keyPh: t('env.envKeyPh'),
    valuePh: t('env.envValuePh'),
    addRow: t('env.envAdd'),
    deleteTitle: t('env.delete'),
    showValue: t('env.showValue'),
    hideValue: t('env.hideValue')
  }
  const resetTriedSubmit = () => { if (triedSubmit) setTriedSubmit(false) }

  return (
    <div
      className="w-full h-full flex flex-col bg-[var(--bg-base)]"
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* 头条：面板铭牌 + 计数 + 添加 —— 与 SessionsPanel/AgentsPanel 头行同族
          （行高对齐终端第一行，铭牌走系统 UI 字体做「厂牌丝印」） */}
      <div
        className="flex items-center justify-between px-3 border-b border-[var(--rule)] flex-shrink-0"
        style={{ height: TOPBAR_HEIGHT }}
      >
        <span className="flex items-baseline gap-1.5 select-none">
          <span
            className="font-bold tracking-[-0.01em] text-[16px] text-[var(--text-rack)]"
            style={{ fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' }}
          >
            {t('env.title')}
          </span>
          <span
            className="font-semibold text-[12px] text-[var(--text-rack-mute)] tabular-nums"
            style={{ fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' }}
          >
            {profiles.length}
          </span>
        </span>
        <button
          onClick={handleAdd}
          title={t('env.addTitle')}
          className="w-[24px] h-[24px] flex items-center justify-center bg-transparent border-none rounded-[3px] cursor-pointer transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--amber)]"
        >
          <IconPlus />
        </button>
      </div>

      {/* 列表级错误横幅 */}
      {actionError && (
        <div className="text-[10.5px] [font-family:inherit] text-[var(--error-rack)] break-words px-3 pt-2">{actionError}</div>
      )}

      {/* 卡片链 —— 与 AgentsPanel 同构的内缩槽位：框线挂在卡片自身，
          逐格连排钉在轨的槽位网格上 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-3 pb-3 rack-scroll">
        {loaded && profiles.length === 0 ? (
          // 空状态 —— 沿用机柜 ─ · ─ 分隔 + 提示
          <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
            <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
            <span className="text-[11.5px] [font-family:inherit] text-[var(--text-rack-mute)]">{t('env.empty')}</span>
            <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-faint)]">{t('env.emptyHint')}</span>
          </div>
        ) : (
          profiles.map((p) => {
            const total = usageCount(p.id)
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => handleEdit(p)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleEdit(p) } }}
                onMouseLeave={() => { if (deleteConfirmId === p.id) setDeleteConfirmId(null) }}
                aria-label={p.name}
                className="group relative flex flex-col gap-1 px-2 py-2 cursor-pointer transition-colors bg-[var(--bg-rack)] border-x border-b border-[var(--rule)] shadow-[inset_0_-1px_0_var(--bg-base)] hover:bg-[var(--bg-slot)] focus:outline-none focus-visible:border-[var(--amber)]"
              >
                {/* 行 1：组名 + hover 操作（复制/编辑/删除） */}
                <div className="flex items-center gap-2">
                  <span className="text-[13px] [font-family:inherit] font-medium text-[var(--text-rack)] truncate leading-tight">
                    {p.name}
                  </span>
                  <div className="absolute right-1.5 top-[13px] -translate-y-1/2 flex gap-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto pl-6 bg-gradient-to-l from-[var(--bg-slot)] from-[24%] to-transparent">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDuplicate(p) }}
                      title={t('env.copy')}
                      className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
                    >
                      <IconCopy />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleEdit(p) }}
                      title={t('env.editTitle')}
                      className="w-[22px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] transition-colors text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]"
                    >
                      <IconEdit />
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        // 两步确认：首次点击切到确认态，再次点击才真正删除（与工作区/变量组一致）
                        if (deleteConfirmId !== p.id) {
                          setDeleteConfirmId(p.id)
                          return
                        }
                        setDeleteConfirmId(null)
                        // 失败(落盘失败/组已不存在)不静默:卡片在下方 load() 后"复活"
                        // 前给出原因 —— 与拨分接开关共用面板级 actionError
                        try {
                          const res = await window.electronAPI?.deleteEnvProfile(p.id)
                          if (res && (res as { success?: boolean }).success === false) {
                            setActionError(typeof (res as { error?: unknown }).error === 'string'
                              ? (res as { error: string }).error
                              : t('env.deleteFailed'))
                          }
                        } catch (err) {
                          setActionError(err instanceof Error && err.message ? err.message : t('env.deleteFailed'))
                        } finally {
                          await load()
                        }
                      }}
                      title={deleteConfirmId === p.id
                        ? (total > 0 ? t('env.confirmDeleteRefs', { count: total }) : t('env.confirmDelete'))
                        : t('env.delete')}
                      className={cn(
                        'w-[22px] h-[22px] inline-flex items-center justify-center border-none cursor-pointer rounded-[2px] transition-colors',
                        deleteConfirmId === p.id
                          ? 'bg-[var(--error-rack)] text-[var(--bg-base)]'
                          : 'bg-transparent text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--error-rack)]'
                      )}
                    >
                      <IconX />
                    </button>
                  </div>
                </div>

                {/* 行 2：上游地址 host · 凭据指示 · 附加变量数 · 备注 —— 结构化核心的读数面 */}
                <span className="text-[11px] [font-family:inherit] text-[var(--text-rack-data)] truncate leading-tight">
                  {[
                    p.baseUrl ? baseUrlHost(p.baseUrl) : null,
                    p.apiKey ? t('env.keyPresent') : null,
                    Object.keys(p.env).length > 0 ? t('env.vars', { count: Object.keys(p.env).length }) : null,
                    p.note || null
                  ].filter(Boolean).join(' · ')}
                </span>

                {/* 行 3：per-kind 分接开关（本面板的签名元素）+ 引用回读。
                    点亮 = 该 kind 的启用指针指向本组（琥珀通电语言：边框/文字/LED 辉光）；
                    再点点亮的那枚 = 拨回系统环境变量。开关状态既是显示也是控制。 */}
                <div className="flex items-center gap-1 flex-wrap">
                  {HARNESS_AGENT_KINDS.map((kind) => {
                    const on = activeByKind[kind] === p.id
                    return (
                      <button
                        key={kind}
                        type="button"
                        aria-pressed={on}
                        disabled={switching}
                        onClick={(e) => { e.stopPropagation(); void toggleKind(kind, p.id) }}
                        title={on ? t('env.chipOff', { kind }) : t('env.chipOn', { kind })}
                        className={cn(
                          'inline-flex items-center gap-1 h-[17px] px-1.5 rounded-[2px] border text-[9.5px] leading-none tracking-[.02em] select-none transition-colors',
                          on
                            ? 'border-[var(--amber)] text-[var(--amber)]'
                            : 'border-[var(--rule)] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:border-[var(--text-rack-faint)]',
                          switching ? 'opacity-60 cursor-wait' : 'cursor-pointer'
                        )}
                      >
                        {on && (
                          <span
                            aria-hidden
                            className="w-[4px] h-[4px] rounded-full bg-[var(--amber)] shadow-[0_0_3px_var(--amber-glow)]"
                          />
                        )}
                        {kind}
                      </button>
                    )
                  })}
                  <span className="flex-1" />
                  {total > 0 ? (
                    <span title={usageNames(p.id)} className="shrink-0 text-[10px] [font-family:inherit] text-[var(--text-rack-mute)] tabular-nums">
                      {t('env.refs', { count: total })}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] [font-family:inherit] text-[var(--text-rack-faint)]">
                      {t('env.unused')}
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 新增/编辑对话框 —— 机柜「插槽规格表」同壳（与 HarnessPanel 变量组对话框同款） */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm w-[448px] max-h-[88vh] overflow-y-auto rack-scroll shadow-xl">
            <div className="flex items-center h-10 px-4 border-b border-[var(--rule)] gap-2.5">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: 'var(--amber)', boxShadow: '0 0 5px var(--amber)' }}
              />
              <span className="text-[13px] [font-family:inherit] font-medium tracking-[0.04em] text-[var(--text-rack)]">
                {editProfile ? t('env.editTitle') : t('env.addTitle')}
              </span>
              <span className="flex-1" />
              <span className="text-[10.5px] [font-family:inherit] tracking-[0.08em] px-1.5 py-px rounded-sm bg-[var(--bg-base)] border border-[var(--rule)] text-[var(--text-rack-mute)]">
                GLOBAL
              </span>
            </div>

            {/* 名称 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t('env.name')}</span>
              </div>
              <input
                type="text"
                value={profileName}
                onChange={(e) => { setProfileName(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
                placeholder={t('env.namePh')}
                autoFocus
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* 备注（可选）—— 卡片行里跟在「n 个变量」后面单行显示，故用 input 而非 textarea */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--text-rack)]">{t('env.note')}</span>
                <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t('env.noteHint')}</span>
              </div>
              <input
                type="text"
                value={profileNote}
                onChange={(e) => setProfileNote(e.target.value)}
                placeholder={t('env.notePh')}
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* Base URL —— 结构化核心之一:协议无关的上游地址,启动时按消费方映射
                注入具体变量名(hint 一行列出三家映射,变量名跟着 agent 走不用记) */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t('env.baseUrl')}</span>
                <div className="mt-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t('env.baseUrlHint')}</div>
              </div>
              <input
                type="text"
                value={profileBaseUrl}
                onChange={(e) => { setProfileBaseUrl(e.target.value); if (triedSubmit) setTriedSubmit(false) }}
                placeholder={t('env.baseUrlPh')}
                spellCheck={false}
                className="w-full bg-[var(--bg-slot)] border border-[var(--rule)] rounded-sm text-[13px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] py-1.5 px-2.5 focus:outline-none focus:border-[var(--amber)]"
              />
            </div>

            {/* API Key —— 结构化核心之二:凭据。默认打码,眼睛切换明文 */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t('env.apiKey')}</span>
                <div className="mt-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t('env.apiKeyHint')}</div>
              </div>
              <SecretInput
                value={profileApiKey}
                onChange={(v) => { setProfileApiKey(v); if (triedSubmit) setTriedSubmit(false) }}
                placeholder={t('env.apiKeyPh')}
                showTitle={t('env.showValue')}
                hideTitle={t('env.hideValue')}
              />
            </div>

            {/* 附加变量 + 各 kind 模板开关。
                核心两字段放不下的其余配置(CODEX_HOME 等)在这里;核心键已被排除,
                开关只补真正属于附加层的推荐项(title 列出会补进的 key,避免盲按) */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t('env.extras')}</span>
                  <span className="flex-1" />
                  {HARNESS_AGENT_KINDS.map((kind) => {
                    const missing = missingFor(kind)
                    if (missing.length === 0) return null
                    return (
                      <button
                        key={kind}
                        onClick={() => fillFromDefaults(kind)}
                        title={`${t('env.envFillTitle', { kind })}: ${missing.map((d) => d.key).join(', ')}`}
                        className="px-1.5 py-0.5 text-[10.5px] [font-family:inherit] rounded-[2px] border border-[color-mix(in_srgb,var(--amber)_40%,var(--rule))] text-[var(--amber)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] transition-colors whitespace-nowrap"
                      >
                        + {kind}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t('env.extrasHint')}</div>
              </div>
              <EnvRowsEditor
                value={profileEnv}
                onChange={setProfileEnv}
                texts={envRowsTexts}
                onKeyChange={resetTriedSubmit}
              />
            </div>

            {/* 模型选项 —— 单列可增删，供工作区「模型」输入框的建议（生效组排在内置建议之前） */}
            <div className="py-3.5 px-4 border-b border-[var(--rule)]">
              <div className="mb-2">
                <span className="text-[12px] [font-family:inherit] tracking-[0.06em] text-[var(--amber)]">{t('env.models')}</span>
                <div className="mt-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)]">· {t('env.modelsHint')}</div>
              </div>
              <div className="bg-[var(--bg-base)] border border-[var(--rule)] rounded-sm overflow-hidden">
                {profileModels.length === 0 ? (
                  <button
                    onClick={addModelRow}
                    className="w-full text-left py-1.5 px-2.5 text-[11.5px] [font-family:inherit] text-[var(--text-rack-data)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] transition-colors"
                  >
                    + {t('env.modelsAdd')}
                  </button>
                ) : (
                  <>
                    {profileModels.map((model, i) => (
                      <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--rule-soft)] last:border-b-0">
                        <input
                          type="text"
                          value={model}
                          onChange={(e) => updateModelRow(i, e.target.value)}
                          placeholder={t('env.modelsPh')}
                          className="flex-1 min-w-0 bg-transparent border-none text-[12px] [font-family:inherit] text-[var(--text-rack)] placeholder:text-[var(--text-rack-data)] focus:outline-none"
                        />
                        <button
                          onClick={() => removeModelRow(i)}
                          title={t('env.delete')}
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
                      + {t('env.modelsAdd')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 校验提示（仅尝试提交后显示；baseUrl 格式错误单独一条，不与必填项混报） */}
            {triedSubmit && !profileBaseUrlValid && (
              <div className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)]">
                {t('env.baseUrlInvalid')}
              </div>
            )}
            {triedSubmit && profileBaseUrlValid && !profileValid && (
              <div className="px-4 py-2 text-[11px] [font-family:inherit] text-[var(--error-rack)] border-b border-[var(--rule)]">
                {t('env.required')}
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
              {editProfile ? (
                <button
                  onClick={() => void handleDialogDelete()}
                  className={
                    confirmDelete
                      ? 'px-2.5 py-1 text-[12px] [font-family:inherit] rounded-sm bg-[var(--error-rack)] text-[var(--bg-base)] font-medium transition-colors'
                      : 'px-2.5 py-1 text-[12px] [font-family:inherit] text-[var(--error-rack)] hover:bg-[var(--bg-slot)] rounded-sm transition-colors'
                  }
                >
                  {confirmDelete ? t('env.confirmDelete') : t('env.delete')}
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDialog(false)}
                  className="px-3 py-1 text-[13px] [font-family:inherit] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
                >
                  {t('env.cancel')}
                </button>
                <button
                  onClick={() => void handleSave()}
                  className={`px-4 py-1 text-[13px] [font-family:inherit] rounded-sm font-medium transition-opacity ${
                    profileValid
                      ? 'bg-[var(--amber)] text-[var(--bg-base)] hover:opacity-90'
                      : 'bg-[var(--bg-slot)] text-[var(--text-rack-dim)] opacity-70'
                  }`}
                >
                  {t('env.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default EnvProfilePanel
