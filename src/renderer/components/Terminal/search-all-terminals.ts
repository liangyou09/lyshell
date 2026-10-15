import type { ISearchOptions } from '@xterm/addon-search'
import type { PaneNode } from '@shared/types'
import { usePaneStore } from '../../stores/pane-store'
import { useTerminalStore } from '../../stores/terminal-store'

// 只遍历真实存在、未被用户隐藏的终端页签，顺序与分屏树和页签栏一致。
export function terminalTabOrder(node: PaneNode, hidden: Record<string, boolean>): string[] {
  return node.type === 'leaf'
    ? node.sessions.filter(id => !hidden[id])
    : [...terminalTabOrder(node.firstChild, hidden), ...terminalTabOrder(node.secondChild, hidden)]
}

export function searchAllTerminals(currentId: string, text: string, direction: 'next' | 'prev', options: ISearchOptions): string | null {
  const panes = usePaneStore.getState()
  const terminals = useTerminalStore.getState()
  const ids = terminalTabOrder(panes.layout.root, panes.hiddenTabSessions).filter(id => terminals.getTerminal(id))
  const current = terminals.getTerminal(currentId)
  const start = ids.indexOf(currentId)
  if (!current || start < 0) return null
  const search = (id: string): boolean => {
    const addon = terminals.getTerminal(id)!.searchAddon
    return direction === 'next' ? addon.findNext(text, options) : addon.findPrevious(text, options)
  }
  const before = current.terminal.getSelectionPosition()
  const found = search(currentId)
  const after = current.terminal.getSelectionPosition()
  // addon 自带单终端循环；到达边界时先让其它终端参与，再回到当前终端。
  const compare = before && after
    ? after.start.y - before.start.y || after.start.x - before.start.x : 0
  if (found && (!before || (direction === 'next' ? compare > 0 : compare < 0))) return currentId
  const step = direction === 'next' ? 1 : -1
  for (let n = 1; n < ids.length; n++) {
    const id = ids[(start + step * n + ids.length) % ids.length]
    const target = terminals.getTerminal(id)!
    target.searchAddon.clearDecorations()
    target.terminal.clearSelection()
    if (!search(id)) continue
    current.searchAddon.clearDecorations()
    const pane = panes.getPaneBySessionId(id)
    if (pane) {
      panes.deactivateOverlaysInPane(pane.id)
      panes.setActiveSessionInPane(pane.id, id)
    }
    return id
  }
  return found ? currentId : null
}
