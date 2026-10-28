import { useLayoutEffect, useRef } from 'react'
import { registerShelfSurface, type ShelfSurfaceKind } from './task-shelf-surfaces'

/** 原视图常驻，本组件仅提供位置和交互额度，不克隆网页、不另开 PTY。 */
export default function TaskShelfLiveSurface({ kind, id, interactive }: { kind: ShelfSurfaceKind; id: string; interactive: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) return registerShelfSurface(kind, id, ref.current, interactive)
    return undefined
  }, [kind, id, interactive])
  return <div ref={ref} className="task-shelf-live-surface" data-shelf-surface={kind} data-shelf-resource={id} />
}
