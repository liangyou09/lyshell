import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExclusiveControlSnapshot } from '@shared/exclusive-control'

/**
 * 共享工作台状态条（S4）—— 挂在 dsh Web 单例覆盖层里、<webview> 之上。
 *
 * 职责边界（刻意很窄）：
 *   - **只显示**Pet 托管控制相位 / 可读原因 / Pet 目标会话 / 导航落地结果；
 *   - 提供一个键盘可达的「回到 Pet 任务会话」入口（显式动作，永不自动拽回）；
 *   - 桥不可达时明确报错并给重试入口，**不**用旧状态假装一切正常。
 *
 * v3：官方工作台可正常输入、新建和操作历史；状态条不设置任何 Web 写门禁。
 *
 * 状态不只靠颜色：相位/连接/导航结果都有文字，按钮有可见标签、可用键盘触发。
 */

/** 轮询间隔：Pet 绑定相位与导航 ack 都是人时尺度的变化，1.5s 足够且不打扰 */
const POLL_MS = 1500
const NAV_ACK_TIMEOUT_MS = 12000

interface SnapshotEnvelope {
  success?: boolean
  error?: string
  code?: string
  snapshot?: ExclusiveControlSnapshot | null
  detail?: { readOnly?: boolean; petSessionId?: string | null; taskId?: string | null; phase?: string } | null
}

/** 拿到快照（唯一数据来源：主进程Pet 托管控制服务）。桥同步失败时 success=false，但 snapshot 仍带着最后的真实状态。 */
async function fetchSnapshot(): Promise<{ snapshot: ExclusiveControlSnapshot | null; error: string | null }> {
  const api = window.electronAPI
  if (!api?.getExclusiveSnapshot) return { snapshot: null, error: 'exclusive-control-ipc-unavailable' }
  try {
    const res = (await api.getExclusiveSnapshot()) as SnapshotEnvelope | undefined
    if (!res) return { snapshot: null, error: 'exclusive-control-ipc-unavailable' }
    return { snapshot: res.snapshot ?? null, error: res.success === false ? res.error ?? 'exclusive-control-unavailable' : null }
  } catch (err) {
    return { snapshot: null, error: err instanceof Error ? err.message : 'exclusive-control-unavailable' }
  }
}

type NavState =
  | { kind: 'idle' }
  | { kind: 'pending'; target: string; revision: number; requestId: string | null; deadline: number }
  | { kind: 'ok'; target: string }
  | { kind: 'error'; target: string; message: string; code?: string }

interface Props {
  /** 这个页签是 Pet 详情工作台（关闭只 detach，不杀后台） */
  detail: boolean
  /** 挂载时已知的 Pet 目标（来自详情 IPC 返回；随后由快照接管） */
  initialPetSessionId?: string | null
  /**
   * 每次取到**新鲜**控制快照时回调（含取失败时不回调）。
   * 用途：让页签 payload 跟随权威状态刷新（详情态 / 只读 / Pet 目标），并让上层观察相位变化，
   * 而不必在这里再存一份状态。**绝不**用于重新挂载或激活页签 —— 那不叫刷新，叫把用户拽回去。
   */
  onSnapshot?: (state: { readOnly: boolean; petSessionId: string | null; phase: string }) => void
}

export const DshWebWorkbenchStrip: React.FC<Props> = ({ detail, initialPetSessionId, onSnapshot }) => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ExclusiveControlSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reachable, setReachable] = useState(true)
  const [nav, setNav] = useState<NavState>({ kind: 'idle' })
  const navRef = useRef<NavState>({ kind: 'idle' })
  navRef.current = nav
  const refreshSeq = useRef(0)
  // 回调放 ref：父层每次渲染都可能传新的内联函数，不能因此重建轮询（会打乱 ack 等待窗口）
  const onSnapshotRef = useRef(onSnapshot)
  onSnapshotRef.current = onSnapshot

  const apply = useCallback((next: ExclusiveControlSnapshot | null, err: string | null) => {
    setSnapshot(next)
    setError(err)
    setReachable(err === null)
    // 把权威状态如实回传（取失败时给 null：调用方据此不要改写成「已恢复」）
    if (next && err === null) {
      const nextPhase = next.phase
      onSnapshotRef.current?.({
        readOnly: false,
        petSessionId: next.viewer?.petSessionId ?? null,
        phase: nextPhase
      })
    }
    // 导航落地判定：必须由**官方 UI 的实际当前会话**证明（viewer.currentSessionId），
    // 而不是「我发过 openSession」。revision 也要越过请求时的冻结值才算这一拍。
    const pending = navRef.current
    if (pending.kind === 'pending') {
      if (next && next.phase !== 'held' && next.phase !== 'releasing') {
        setNav({ kind: 'idle' })
        return
      }
      const viewer = next?.viewer
      if (!viewer || err !== null || !pending.requestId) return
      const ack = viewer.lastAck
      // 只认本次请求的真实 ack；用户恰好浏览到目标不能冒充导航成功。
      if (ack?.requestId === pending.requestId && ack.revision === pending.revision) {
        if (ack.status !== 'navigated') {
          setNav({ kind: 'error', target: pending.target, message: t('dshWorkbench.navFailed'), code: ack.status === 'superseded' ? 'viewer/stale' : 'viewer/unavailable' })
          return
        }
        if (ack.currentSessionId !== pending.target || viewer.currentSessionId !== pending.target) return
        setNav({ kind: 'ok', target: pending.target })
        return
      }
      // 目标会话已经变了（Pet 起了新任务/新会话）⇒ 不再等旧目标，避免永久 pending
      const petSession = viewer.petSessionId
      if (petSession && petSession !== pending.target) setNav({ kind: 'idle' })
    }
  }, [t])

  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current
    void fetchSnapshot().then(({ snapshot: next, error: err }) => {
      if (seq === refreshSeq.current) apply(next, err)
    })
  }, [apply])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    return () => { refreshSeq.current++; window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    if (nav.kind !== 'pending') return
    const timer = window.setTimeout(() => {
      setNav(current => current === nav
        ? { kind: 'error', target: nav.target, message: t('dshWorkbench.navTimeout'), code: 'viewer/unavailable' }
        : current)
    }, Math.max(0, nav.deadline - Date.now()))
    return () => window.clearTimeout(timer)
  }, [nav, t])

  const petSessionId = snapshot?.viewer?.petSessionId ?? null
  const currentSessionId = snapshot?.viewer?.currentSessionId ?? null
  const phase = snapshot?.phase ?? 'free'
  const connected = phase === 'held' || phase === 'releasing'
  const effectivePet = petSessionId ?? initialPetSessionId ?? null
  const onPetSession = effectivePet !== null && currentSessionId === effectivePet

  const goToPet = useCallback(async () => {
    if (!effectivePet) return
    const api = window.electronAPI
    if (!api?.requestDshWebViewerNav) {
      setNav({ kind: 'error', target: effectivePet, message: t('dshWorkbench.navUnavailable') })
      return
    }
    const revision = snapshot?.viewer?.revision ?? 0
    const pending: NavState = { kind: 'pending', target: effectivePet, revision, requestId: null, deadline: Date.now() + NAV_ACK_TIMEOUT_MS }
    navRef.current = pending
    setNav(pending)
    try {
      const res = (await api.requestDshWebViewerNav({ sessionId: effectivePet })) as
        | { success?: boolean; error?: string; code?: string; skipped?: boolean; currentSessionId?: string | null; requestId?: string | null; revision?: number }
        | undefined
      if (navRef.current !== pending) return
      if (!res || res.success !== true) {
        setNav({ kind: 'error', target: effectivePet, message: res?.error ?? t('dshWorkbench.navFailed'), code: res?.code })
        return
      }
      if (res.skipped && !res.requestId && res.currentSessionId === effectivePet) {
        setNav({ kind: 'ok', target: effectivePet })
        return
      }
      if (!res.requestId || typeof res.revision !== 'number') {
        setNav({ kind: 'error', target: effectivePet, message: t('dshWorkbench.navUnavailable') })
        return
      }
      // 请求已下发：不在这里宣告成功 —— 等快照里官方 UI 的实际当前会话证明（见 apply）
      const waiting: NavState = { ...pending, requestId: res.requestId, revision: res.revision }
      navRef.current = waiting
      setNav(waiting)
      refresh()
    } catch (err) {
      if (navRef.current !== pending) return
      setNav({ kind: 'error', target: effectivePet, message: err instanceof Error ? err.message : t('dshWorkbench.navFailed') })
    }
  }, [effectivePet, refresh, snapshot?.viewer?.revision, t])

  // 非详情安装、且当前没被独占：普通 Web 页签上不显示任何条（保持原界面）
  if (!detail && !connected && !error) return null

  const detailText = !reachable
    ? t('dshWorkbench.offline')
    : phase === 'releasing'
      ? t('dshWorkbench.releasing')
      : connected
        ? (snapshot?.approvals?.length ?? 0) > 0
          ? t('dshWorkbench.heldApproval')
          : t('dshWorkbench.held')
        : t('dshWorkbench.released')

  return (
    <div
      // 底色只用主题令牌的 alpha 变体（--amber-soft / --amber-glow），文字沿用 --text-rack：
      // 固定色号会与浅色主题的墨色文字同色读不出（同 globals.css 「面回落文字色令牌 --text-rack」）。
      // 状态另以文字与 data 属性表达，不只靠颜色。
      className="flex items-center gap-3 px-3 py-1.5 text-xs border-b"
      style={{ background: 'var(--amber-soft)', borderColor: 'var(--amber-glow)', color: 'var(--text-rack)' }}
      role="status"
      aria-live="polite"
      data-lyshell-workbench-strip={connected ? 'shared' : 'free'}
      data-lyshell-workbench-connected={reachable ? '1' : '0'}
    >
      <span className="font-medium whitespace-nowrap" style={{ color: 'var(--amber)' }}>
        {connected || !reachable ? t('dshWorkbench.title') : t('dshWorkbench.titleFree')}
      </span>
      <span className="truncate" title={detailText}>{detailText}</span>
      {effectivePet && (
        <span className="opacity-70 truncate" title={effectivePet}>
          {t('dshWorkbench.target', { id: effectivePet })}
        </span>
      )}

      {/* 导航结果：pending / 已落地 / 明确失败（含固定分类码），都可读、不靠颜色区分 */}
      {nav.kind === 'pending' && <span className="opacity-80">{t('dshWorkbench.navPending')}</span>}
      {nav.kind === 'ok' && <span style={{ color: 'var(--reachable)' }}>{t('dshWorkbench.navOk')}</span>}
      {nav.kind === 'error' && (
        <span style={{ color: 'var(--amber)' }} title={nav.code ?? ''}>
          {t('dshWorkbench.navError', { reason: nav.message })}
        </span>
      )}

      <span className="flex-1" />

      {/* 桥不可达：明确错误 + 键盘可达的重试入口（不自动切本地、不假装成功） */}
      {!reachable && (
        <>
          <span role="alert" style={{ color: 'var(--amber)' }} title={error ?? ''}>
            {t('dshWorkbench.offlineHint')}
          </span>
          <button
            type="button"
            onClick={refresh}
            className="px-2 py-0.5 rounded border cursor-pointer"
            style={{ borderColor: 'var(--amber)', background: 'transparent', color: 'var(--amber)' }}
          >
            {t('dshWorkbench.retry')}
          </button>
        </>
      )}

      {/* 显式「回到 Pet 任务会话」：只在被控制、有目标会话、且已不在目标会话时出现。
          已有未落地请求时按钮换成可读的「等待官方界面确认」—— 既不重复发请求，
          也如实告诉用户上一次导航还没落地。 */}
      {connected && effectivePet && !onPetSession && (
        snapshot?.viewer?.request ? (
          <span className="opacity-70">{t('dshWorkbench.navPending')}</span>
        ) : (
          <button
            type="button"
            onClick={() => void goToPet()}
            disabled={nav.kind === 'pending' || !reachable}
            title={t('dshWorkbench.backHint')}
            className="px-2 py-0.5 rounded border cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--amber)', background: 'transparent', color: 'var(--amber)' }}
          >
            {t('dshWorkbench.back')}
          </button>
        )
      )}
      {connected && effectivePet && onPetSession && (
        <span className="opacity-70">{t('dshWorkbench.onTarget')}</span>
      )}
    </div>
  )
}

export default DshWebWorkbenchStrip
