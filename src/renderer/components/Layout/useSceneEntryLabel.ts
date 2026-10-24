import { useEffect, useState } from 'react'
import type { OverlayPayload } from '@shared/types'
import { sceneTargetKey } from '../../stores/project-scene-ui'

type Payload = Extract<OverlayPayload, { kind: 'projectEntry' }>
const pending = new Map<string, Promise<{ projectName?: string; entryName?: string }>>()
/** 只查询当前配置的可读名称，不把名称或配置内容写进保存点。 */
export function useSceneEntryLabel(payload: Payload) {
  const key = `${payload.target.presetId}:${sceneTargetKey(payload.target)}:${JSON.stringify(payload.entry)}`
  const [label, setLabel] = useState<{ projectName?: string; entryName?: string }>({})
  useEffect(() => {
    let active = true
    setLabel({})
    if (!window.electronAPI?.projectSceneRequest) return
    let request = pending.get(key)
    if (!request) {
      const created: Promise<{ projectName?: string; entryName?: string }> = Promise.resolve(window.electronAPI.projectSceneRequest({ kind: 'describe', target: payload.target, entry: payload.entry })).then(result => result.success ? { projectName: result.projectName, entryName: result.entryName } : {}).catch(() => ({})).finally(() => { pending.delete(key) })
      pending.set(key, created)
      request = created
    }
    void request.then(result => { if (active) setLabel(result) })
    return () => { active = false }
    // key 完整编码引用身份；避免 pane/覆盖层状态更新反复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return label
}
