import { useLayoutEffect, useRef } from 'react'
import { registerShelfSurface, updateShelfSurfaceInteraction, type ShelfSurfaceKind } from './task-shelf-surfaces'

/** 原视图常驻，本组件仅提供位置和交互额度，不克隆网页、不另开 PTY。 */
export default function TaskShelfLiveSurface({ kind, id, interactive }: { kind: ShelfSurfaceKind; id: string; interactive: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive
  useLayoutEffect(() => {
    if (ref.current) return registerShelfSurface(kind, id, ref.current, interactiveRef.current)
    return undefined
  }, [kind, id])
  useLayoutEffect(() => { updateShelfSurfaceInteraction(kind, id, interactive) }, [kind, id, interactive])
  return <div ref={ref} className="task-shelf-live-surface" data-shelf-surface={kind} data-shelf-resource={id} />
}
