import type { WebContents } from 'electron'
import { matchWebTabShortcut, type ShortcutInputShape, type WebTabShortcutAction } from '@shared/webtab-shortcut'

/** 小窗刷新直接落到获得焦点的 guest，完整页签继续由宿主统一路由。 */
export function handleBrowserShortcut(
  guest: Pick<WebContents, 'reload' | 'reloadIgnoringCache'>,
  event: { preventDefault: () => void },
  input: ShortcutInputShape,
  kind: 'mini' | 'tab' | 'dsh',
  forward: (action: WebTabShortcutAction) => void
): void {
  const action = matchWebTabShortcut(input)
  if (!action) return
  if (kind === 'mini') {
    if (action !== 'reload' && action !== 'reload-hard') return
    event.preventDefault()
    if (action === 'reload-hard') guest.reloadIgnoringCache()
    else guest.reload()
    return
  }
  if (kind === 'dsh' && action !== 'find') return
  event.preventDefault()
  forward(action)
}
