import { useEffect } from 'react'
import type { ExclusiveControlSnapshot } from '@shared/exclusive-control'
import { usePaneStore } from '../../stores/pane-store'
import { workbenchDetailLane } from '../../stores/workbench-detail'

/** 轮询间隔：Pet 绑定相位是人时尺度的变化，1.5s 足够且不打扰 */
const POLL_MS = 1500

interface SnapshotEnvelope {
  success?: boolean
  error?: string
  code?: string
  snapshot?: ExclusiveControlSnapshot | null
}

/**
 * 共享工作台**无界面**状态轮询（S4）。
 *
 * 可见状态条（DshWebWorkbenchStrip）已撤掉：它压在 `<webview>` 顶部，会被读成
 * 终端内容区的第一行。「PetLink 正占用共享 Harness」改由页签名表达
 * （PaneTabBar 的 DshWebTabContent：held 时切成 `dsh & petlink`）。
 *
 * 这里只做记账、不渲染：
 *   - 权威相位回写详情面状态机（stores/workbench-detail）—— 用户关掉的详情身份不再被自动重开；
 *   - payload 回写 `held` / `petSessionId`（页签名与 Pet 任务会话目标）。
 *
 * 取失败时**不改写** `held`：桥不可达不等于已释放，不能把最后的真实状态涂成 free。
 */
export function useWorkbenchSnapshot(overlayId: string): void {
  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const refresh = () => {
      // 桥同步可能超过轮询间隔：等待当前请求，避免不断作废慢响应和堆积 IPC。
      if (inFlight || cancelled) return
      inFlight = true
      void (async () => {
        try {
          const api = window.electronAPI
          if (!api?.getExclusiveSnapshot) return
          const res = (await api.getExclusiveSnapshot()) as SnapshotEnvelope | undefined
          // 桥同步失败仍可能携带缓存快照，不能把它当作新鲜相位推进详情记账。
          if (cancelled || res?.success === false || !res?.snapshot) return
          const snap = res.snapshot
          const phase = snap.phase
          if (!['free', 'acquiring', 'held', 'releasing'].includes(phase)) return
          const petSessionId = snap.viewer?.petSessionId ?? null
          const held = phase === 'held' || phase === 'releasing'
          // 同值短路在 updateDshWebInPane 里：轮询落地不换 payload 引用就不会无谓重渲染
          const store = usePaneStore.getState()
          const current = store.getOverlayPayload(overlayId)
          if (!current || current.kind !== 'dshWeb') return
          store.updateDshWebInPane(overlayId, { readOnly: false, petSessionId, held, currentSessionId: snap.viewer?.currentSessionId ?? null })
          const lane = workbenchDetailLane()
          if (!lane) return
          lane.noteKey(current.workbenchKey ?? null)
          lane.notePhase(phase)
        } catch {
          // IPC 不可达时保留最后一次成功读到的状态。
        } finally {
          inFlight = false
        }
      })()
    }

    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [overlayId])
}
