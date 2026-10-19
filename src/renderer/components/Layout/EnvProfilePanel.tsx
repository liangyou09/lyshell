import { PanelHeader, PanelHeaderAction } from './PanelHeader'
import React, { useState, useEffect, useCallback, useId } from 'react'
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
import { useUiStore } from '../../stores/ui-store'
import { SettingsBackGlyph } from './SettingsNavigation'
import './EnvProfilePanel.css'

/**
 * 环境变量面板 —— 全局变量组库的独占入口（设置 → 环境变量）。
 *
 * 列表按名称、上游地址和配置摘要分层。点击条目即选中并启用，
 * 各条目内的编辑/复制/删除独立操作自己的配置，开关可停用当前组。
 * 启用组用状态文字、开关和浅色底共同标识，同一时刻全应用只启用一组。
 *
 * CRUD 走 kind 无关的 env-profile:add/update/delete 通道；启用切换走
 * env-profile:setActive（主进程写的是同一份全局 activeProfileId 指针）。
 */

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

const IconDelete: React.FC<{ confirming: boolean }> = ({ confirming }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {confirming ? <path d="m3 8 3 3 7-7" /> : <><path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9M6.5 7v4M9.5 7v4" /></>}
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
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  showTitle: string
  hideTitle: string
}
const SecretInput: React.FC<SecretInputProps> = ({ id, value, onChange, placeholder, showTitle, hideTitle }) => {
  const [visible, setVisible] = useState(false)
  return (
    <div className="flex items-stretch gap-1">
      <input
        id={id}
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

const EnvProfilePanel: React.FC<{ embedded?: boolean; onBackToSettings?: () => void }> = ({ embedded = false, onBackToSettings }) => {
  const { t } = useTranslation()

  // ── 库状态（env-profile:list 一并下发的三段） ──
  const [profiles, setProfiles] = useState<HarnessEnvProfile[]>([])
  // 全局启用指针（全应用单选一根；null = 未启用，回落系统环境变量）
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [usage, setUsage] = useState<EnvProfileLibraryResult['usage']>({})
  // 空列表有两种含义（「一个都没有」与「还没拉到」），只有前者才给空态提示
  const [loaded, setLoaded] = useState(false)
  // 列表级操作错误横幅（启用切换失败等）
  const [actionError, setActionError] = useState<string | null>(null)
  // 指针切换进行中：禁用全部分接开关（同一时刻只允许拨一格）
  const [switching, setSwitching] = useState(false)
  const [search, setSearch] = useState('')
  // 操作栏删除的两步确认：记录待确认的组 id（null = 无待确认）
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  // 各 kind 的推荐变量（配置页里的一键补全模板）
  const [defaultsByKind, setDefaultsByKind] = useState<Partial<Record<HarnessAgentKind, HarnessEnvDefault[]>>>({})

  // ── 新增/编辑配置页 ──
  const [editing, setEditing] = useState(false)
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

  const fieldId = useId()

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listEnvProfiles() as EnvProfileLibraryResult | undefined
      if (result && Array.isArray(result.profiles)) {
        setProfiles(result.profiles)
        setActiveProfileId(typeof result.activeProfileId === 'string' ? result.activeProfileId : null)
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

  /** 点击条目只启用；独立开关允许停用并回落系统环境变量，全应用至多启用一组。 */
  const toggleActive = async (profileId: string, deactivateIfActive = true) => {
    if (switching || (!deactivateIfActive && activeProfileId === profileId)) return
    setSwitching(true)
    setActionError(null)
    try {
      const on = deactivateIfActive && activeProfileId === profileId
      const res = await window.electronAPI?.setEnvProfileActive(on ? null : profileId)
      if (res && (res as { success?: boolean }).success === false) {
        setActionError(typeof (res as { error?: unknown }).error === 'string'
          ? (res as { error: string }).error
          : t('env.activeFailed'))
      }
    } catch (err) {
      console.error('Env profile activation failed:', err)
      setActionError(err instanceof Error ? err.message : t('env.activeFailed'))
    } finally {
      // 无论成败都重新拉取，失败时回落到真实状态。重拉落地前保持 switching ——
      // 「指针已切、列表未刷」的窗口里再点卡会用旧状态误判 on，把「切到 A」
      // 算成「关闭 A」发给主进程；条目和开关共享同一个请求锁
      await load()
      setSwitching(false)
    }
  }

  // ── 配置页：模型选项行编辑（单列，供工作区模型建议） ──
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

  const resetEditor = () => {
    setTriedSubmit(false)
    setConfirmDelete(false)
    setSaveError(null)
  }

  const handleAdd = () => {
    setDeleteConfirmId(null)
    setEditProfile(undefined)
    setProfileName('')
    setProfileNote('')
    setProfileBaseUrl('')
    setProfileApiKey('')
    // 不预填任何 kind 的默认变量 —— 组是跨 kind 全局的，该补哪家配置由下方
    // 模板开关（+ codex / + claude）按需一键补全
    setProfileEnv([])
    setProfileModels([])
    resetEditor()
    setEditing(true)
  }

  // 外部「新建变量组」请求(ui-store,如 /ls 清点文档的新建链接):本面板条件挂载,
  // 请求落 store 跨挂载存活,挂载后读到存量也能开配置页,消费后归零防误弹
  const createRequestId = useUiStore(s => s.createDialogRequests.env ?? 0)
  useEffect(() => {
    if (!createRequestId) return
    handleAdd()
    useUiStore.getState().consumeCreateDialogRequest('env')
    // 请求消费只看 id;handleAdd 的引用变化不构成「再来一次」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequestId])

  // 外部「打开变量组」请求(/ls 清点文档点行内名称):按 id 找到组开编辑配置页。
  // 请求可能先于列表到达(刚随 navigate 挂载,load 未返回)—— 未就绪不消费,
  // 列表到了 effect 重跑;列表就绪仍找不到(快照后已删)也要消费,防陈旧请求
  // 随后续列表刷新反复触发
  const openItem = useUiStore(s => s.openItemRequests.env)
  useEffect(() => {
    if (!openItem) return
    const target = profiles.find(p => p.id === openItem.itemId)
    if (target) {
      handleEdit(target)
      useUiStore.getState().consumeOpenItemRequest('env')
    } else if (loaded) {
      useUiStore.getState().consumeOpenItemRequest('env')
    }
    // 请求消费只看请求与列表;handleEdit 的引用变化不构成「再来一次」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openItem, profiles, loaded])

  const handleEdit = (p: HarnessEnvProfile) => {
    setDeleteConfirmId(null)
    setEditProfile(p)
    setProfileName(p.name)
    setProfileNote(p.note || '')
    setProfileBaseUrl(p.baseUrl || '')
    setProfileApiKey(p.apiKey || '')
    setProfileEnv(Object.entries(p.env).map(([key, value]) => ({ key, value })))
    setProfileModels(p.models ? [...p.models] : [])
    resetEditor()
    setEditing(true)
  }

  /**
   * 复制变量组：以既有配置预填「新增」配置页（名称加后缀便于区分），保存才落盘，
   * 取消无副作用。走新增链路即不触碰启用指针 —— 副本不会抢走源组的分接档位。
   */
  const handleDuplicate = (p: HarnessEnvProfile) => {
    setDeleteConfirmId(null)
    setEditProfile(undefined)
    setProfileName(`${p.name}${t('env.copySuffix')}`)
    setProfileNote(p.note || '')
    setProfileBaseUrl(p.baseUrl || '')
    setProfileApiKey(p.apiKey || '')
    setProfileEnv(Object.entries(p.env).map(([key, value]) => ({ key, value })))
    setProfileModels(p.models ? [...p.models] : [])
    resetEditor()
    setEditing(true)
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
    // 记录整条替换后旧值即消失）—— 与工作区/变量组配置页同一套语义
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
    setEditing(false)
  }

  const handleEditorDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    if (editProfile) {
      // 组是 Agent/工作区绑定的目标，删除后绑定方回落下一级 —— 重新拉取让引用计数归零。
      // 失败(落盘失败/组已不存在)保留配置页并展示原因,不静默吞掉
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
      setEditing(false)
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

  const query = search.trim().toLocaleLowerCase()
  // 只检索名称、地址和备注，不让凭据或附加变量值进入搜索结果。
  const visibleProfiles = profiles.filter(p => !query || [p.name, p.baseUrl, p.note]
    .some(value => value?.toLocaleLowerCase().includes(query)))

  const handleCardDelete = async (profile: HarnessEnvProfile) => {
    if (deleteConfirmId !== profile.id) {
      setDeleteConfirmId(profile.id)
      return
    }
    setDeleteConfirmId(null)
    setActionError(null)
    try {
      const result = await window.electronAPI?.deleteEnvProfile(profile.id)
      if (result && (result as { success?: boolean }).success === false) {
        setActionError(typeof (result as { error?: unknown }).error === 'string'
          ? (result as { error: string }).error : t('env.deleteFailed'))
      }
    } catch (error) {
      setActionError(error instanceof Error && error.message ? error.message : t('env.deleteFailed'))
    } finally {
      await load()
    }
  }

  const renderProfileCard = (profile: HarnessEnvProfile) => {
    const total = usageCount(profile.id)
    const active = activeProfileId === profile.id
    const description = profile.baseUrl ? baseUrlHost(profile.baseUrl)
      : profile.apiKey ? t('env.keyPresent') : t('env.vars', { count: Object.keys(profile.env).length })
    return <div key={profile.id} className="env-profile-row" data-active={active}
      onMouseLeave={() => { if (deleteConfirmId === profile.id) setDeleteConfirmId(null) }}
      onContextMenu={event => { event.preventDefault(); handleEdit(profile) }}>
      <button type="button" aria-pressed={active} disabled={switching} aria-label={profile.name}
        className="env-profile-main" onClick={() => { setDeleteConfirmId(null); void toggleActive(profile.id, false) }}>
        <span className="env-profile-heading">
          <span className="env-profile-name" title={profile.name}>{profile.name}</span>
          {active && <span className="env-profile-active">{t('env.activeBadge')}</span>}
        </span>
        <span className="env-profile-meta">
          <span className="env-profile-endpoint" title={description}>
            {description}
          </span>
          {(profile.baseUrl || profile.apiKey) && Object.keys(profile.env).length > 0 && <span className="env-profile-extras" data-count={Object.keys(profile.env).length} title={t('env.vars', { count: Object.keys(profile.env).length })}>{t('env.vars', { count: Object.keys(profile.env).length })}</span>}
          {total > 0 && <span className="env-profile-refs" title={usageNames(profile.id)}>{t('env.refs', { count: total })}</span>}
        </span>
        {profile.note && <span className="env-profile-note" title={profile.note}>{profile.note}</span>}
      </button>
      <button type="button" role="switch" aria-checked={active} aria-label={profile.name}
        disabled={switching} title={active ? t('env.deactivateTitle') : t('env.activateTitle')}
        className="env-profile-toggle" onClick={() => { setDeleteConfirmId(null); void toggleActive(profile.id) }}><span /></button>
      {renderProfileActions(profile)}
    </div>
  }

  const renderProfileActions = (profile: HarnessEnvProfile) => {
    const total = usageCount(profile.id)
    return <div className="env-profile-actions" role="group" aria-label={profile.name} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDeleteConfirmId(null) }} onKeyDown={event => { if (event.key === 'Escape') setDeleteConfirmId(null) }}>
        <button type="button" className="env-profile-action" title={`${t('env.editTitle')}: ${profile.name}`} aria-label={t('env.editTitle')} onClick={() => handleEdit(profile)}><IconEdit /><span>{t('env.editAction')}</span></button>
        <button type="button" className="env-profile-action" title={`${t('env.copy')}: ${profile.name}`} aria-label={t('env.copy')} onClick={() => handleDuplicate(profile)}><IconCopy /><span>{t('env.copyAction')}</span></button>
        <button type="button" className={cn('env-profile-action env-profile-delete', deleteConfirmId === profile.id && 'is-confirming')}
          title={deleteConfirmId === profile.id ? (total > 0 ? t('env.confirmDeleteRefs', { count: total }) : t('env.confirmDelete')) : `${t('env.delete')}: ${profile.name}`}
          aria-label={deleteConfirmId === profile.id ? (total > 0 ? t('env.confirmDeleteRefs', { count: total }) : t('env.confirmDelete')) : t('env.delete')}
          onClick={() => void handleCardDelete(profile)}><IconDelete confirming={deleteConfirmId === profile.id} /><span>{deleteConfirmId === profile.id ? t('env.confirmDeleteAction') : t('env.delete')}</span></button>
    </div>
  }

  return (
    <div
      className="env-profile-panel w-full h-full flex flex-col bg-[var(--bg-base)]"
      style={embedded ? undefined : { fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {!embedded && <PanelHeader
        title={t('env.title')}
        count={profiles.length}
        actions={!editing && <PanelHeaderAction label={t('panelHeader.create')} title={t('env.addTitle')} onClick={handleAdd} />}
      />}

      {embedded && !editing && onBackToSettings && <button type="button" className="settings-category-header" title={t('settings.backToCategories')} aria-label={t('settings.backToCategories')} onClick={onBackToSettings}>
        <span className="settings-content-back" aria-hidden="true"><SettingsBackGlyph /></span>
        <span className="settings-category-title">{t('env.title')}</span>
      </button>}

      {!editing && <div className="env-profile-toolbar">
        <div className="env-profile-toolbar-heading">
          <span className="env-profile-count" title={loaded ? t('env.profileCount', { count: profiles.length }) : t('env.loading')} aria-live="polite">{loaded ? t('env.profileCount', { count: profiles.length }) : t('env.loading')}</span>
          {embedded && <PanelHeaderAction label={t('panelHeader.create')} title={t('env.addTitle')} onClick={handleAdd} />}
        </div>
        <div className="env-profile-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('env.search')} aria-label={t('env.search')} spellCheck={false} />
          {search && <button type="button" title={t('env.clearSearch')} aria-label={t('env.clearSearch')} onClick={() => setSearch('')}><IconX /></button>}
        </div>
      </div>}

      <div className="env-profile-body" hidden={editing}>

      {/* 列表级错误横幅 */}
      {actionError && (
        <div role="alert" className="env-profile-error">{actionError}</div>
      )}

      {loaded && visibleProfiles.length > 0 ? (
        <div className="env-profile-scroll rack-scroll">
          <div className="env-profile-list">
            {visibleProfiles.map(renderProfileCard)}
          </div>
        </div>
      ) : loaded && profiles.length > 0 ? (
        <div className="env-profile-empty" role="status">
          <span>{t('env.noMatches')}</span>
          <button type="button" onClick={() => setSearch('')}>{t('env.clearSearch')}</button>
        </div>
      ) : loaded && profiles.length === 0 ? (
        <div className="env-profile-empty">
          <span>{t('env.empty')}</span>
          <span>{t('env.emptyHint')}</span>
        </div>
      ) : null}

      </div>

      {editing && <section className="env-profile-editor" aria-label={editProfile ? t('env.editTitle') : t('env.addTitle')}
        onKeyDown={event => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing && confirmDelete) {
            event.preventDefault()
            event.stopPropagation()
            setConfirmDelete(false)
          }
        }}>
        <button type="button" className="settings-category-header env-editor-back" title={t('env.backToList')} aria-label={t('env.backToList')} onClick={() => setEditing(false)}>
          <span className="settings-content-back" aria-hidden="true"><SettingsBackGlyph /></span>
          <span className="settings-category-title">{editProfile ? t('env.editTitle') : t('env.addTitle')}</span>
        </button>
        <div className="env-editor-scroll rack-scroll">
          <div className="env-editor-section">
            <div className="env-editor-field">
              <label htmlFor={`${fieldId}-name`}>{t('env.name')}</label>
              <input id={`${fieldId}-name`} value={profileName} onChange={event => { setProfileName(event.target.value); resetTriedSubmit() }} placeholder={t('env.namePh')} autoFocus aria-invalid={triedSubmit && !profileName.trim()} />
            </div>
            <div className="env-editor-field">
              <label htmlFor={`${fieldId}-note`}>{t('env.note')}<span>{t('env.noteHint')}</span></label>
              <input id={`${fieldId}-note`} value={profileNote} onChange={event => setProfileNote(event.target.value)} placeholder={t('env.notePh')} />
            </div>
          </div>
          <div className="env-editor-section">
            <div className="env-editor-field">
              <label htmlFor={`${fieldId}-url`}>{t('env.baseUrl')}</label>
              <input id={`${fieldId}-url`} value={profileBaseUrl} onChange={event => { setProfileBaseUrl(event.target.value); resetTriedSubmit() }} placeholder={t('env.baseUrlPh')} spellCheck={false} aria-invalid={triedSubmit && !profileBaseUrlValid} />
            </div>
            <div className="env-editor-field">
              <label htmlFor={`${fieldId}-key`}>{t('env.apiKey')}</label>
              <SecretInput id={`${fieldId}-key`} value={profileApiKey} onChange={value => { setProfileApiKey(value); resetTriedSubmit() }} placeholder={t('env.apiKeyPh')} showTitle={t('env.showValue')} hideTitle={t('env.hideValue')} />
            </div>
            <details className="env-editor-help"><summary>{t('env.mappingHelp')}</summary><p>{t('env.baseUrlHint')}</p><p>{t('env.apiKeyHint')}</p></details>
          </div>
          <div className="env-editor-section">
            <div className="env-editor-section-title"><h4>{t('env.extras')}</h4></div>
            <p className="env-editor-hint">{t('env.extrasHint')}</p>
            <div className="env-editor-presets">
              {HARNESS_AGENT_KINDS.map(kind => {
                const missing = missingFor(kind)
                return missing.length > 0 && <button type="button" key={kind} onClick={() => fillFromDefaults(kind)} title={`${t('env.envFillTitle', { kind })}: ${missing.map(item => item.key).join(', ')}`}>+ {kind}</button>
              })}
            </div>
            <EnvRowsEditor stacked value={profileEnv} onChange={setProfileEnv} texts={envRowsTexts} onKeyChange={resetTriedSubmit} />
            {profileEnv.some(row => CORE_ENV_KEYS.has(row.key.trim())) && <p className="env-editor-warning">{t('env.coreKeyInExtras')}</p>}
          </div>
          <div className="env-editor-section">
            <div className="env-editor-section-title"><h4>{t('env.models')}</h4></div>
            <p className="env-editor-hint">{t('env.modelsHint')}</p>
            <div className="env-editor-models">
              {profileModels.map((model, index) => <div className="env-editor-model-row" key={index}>
                <input value={model} onChange={event => updateModelRow(index, event.target.value)} placeholder={t('env.modelsPh')} aria-label={`${t('env.models')} ${index + 1}`} />
                <button type="button" title={t('env.delete')} aria-label={t('env.delete')} onClick={() => removeModelRow(index)}><IconX /></button>
              </div>)}
              <button type="button" className="env-editor-add" onClick={addModelRow}>+ {t('env.modelsAdd')}</button>
            </div>
          </div>
          {triedSubmit && !profileBaseUrlValid && <p role="alert" className="env-editor-error">{t('env.baseUrlInvalid')}</p>}
          {triedSubmit && profileBaseUrlValid && !profileValid && <p role="alert" className="env-editor-error">{t('env.required')}</p>}
          {saveError && <p role="alert" className="env-editor-error">{saveError}</p>}
          {editProfile && <div className="env-editor-danger"><button type="button" onClick={() => void handleEditorDelete()}>{confirmDelete ? t('env.confirmDelete') : t('env.delete')}</button></div>}
        </div>
        <footer className="env-editor-footer">
          <button type="button" onClick={() => setEditing(false)}>{t('env.cancel')}</button>
          <button type="button" className="env-editor-save" onClick={() => void handleSave()}>{t('env.save')}</button>
        </footer>
      </section>}

    </div>
  )
}

export default EnvProfilePanel
