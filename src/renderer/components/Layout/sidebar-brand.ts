import type { PaneNode } from '@shared/types'

/** 与页签渲染口径一致：隐藏/已移除的会话和没有内容的覆盖层不算可见页签。 */
export function hasVisiblePaneTabs(
  node: PaneNode,
  sessions: ReadonlyArray<{ id: string }>,
  hidden: Readonly<Record<string, boolean>>,
  payloads: Readonly<Record<string, unknown>>
): boolean {
  if (node.type === 'split') {
    return hasVisiblePaneTabs(node.firstChild, sessions, hidden, payloads)
      || hasVisiblePaneTabs(node.secondChild, sessions, hidden, payloads)
  }
  return node.sessions.some(id => !hidden[id] && sessions.some(session => session.id === id))
    || node.overlays.some(overlay => !!payloads[overlay.id])
}
