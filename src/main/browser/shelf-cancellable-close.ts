import type { WebContents } from 'electron'

/**
 * 普通 guest 的 close 会忽略 beforeunload 拒绝；先用原生导航请求卸载。
 * 只有本次导航真正提交到空白文档，才关闭这个确切的 guest。
 * 拒绝不放行；超时保留原句柄和监听，继续接收迟到的原生证据。
 */
export function requestCancellableGuestClose(guest: WebContents, callbacks: {
  isCurrent: () => boolean
  refused: () => void
  unconfirmed: () => void
}): void {
  if (guest.isDestroyed() || !callbacks.isCurrent()) return
  let settled = false
  let committed = false
  let closeRequested = false
  const cleanup = () => {
    guest.removeListener('will-prevent-unload', refused)
    guest.removeListener('did-navigate', navigated)
    guest.removeListener('destroyed', destroyed)
  }
  const destroyed = () => { settled = true; cleanup() }
  const refused = () => {
    if (settled || committed) return
    settled = true; cleanup(); callbacks.refused()
  }
  const closeBlank = () => {
    if (settled || closeRequested || !committed || guest.isDestroyed()) return
    if (!callbacks.isCurrent() || guest.getURL() !== 'about:blank') { callbacks.unconfirmed(); return }
    closeRequested = true
    try { guest.close({ waitForBeforeUnload: true }) }
    catch { closeRequested = false; callbacks.unconfirmed() }
  }
  const navigated = (_event: unknown, url: string) => {
    if (settled) return
    if (url !== 'about:blank') { callbacks.unconfirmed(); return }
    committed = true
    // 等导航 loadURL Promise 收尾，避免同步关闭触发未处理的导航拒绝。
  }
  guest.on('will-prevent-unload', refused)
  guest.on('did-navigate', navigated)
  guest.once('destroyed', destroyed)
  try {
    void guest.loadURL('about:blank').then(() => {
      if (settled || guest.isDestroyed()) return
      if (!committed || guest.getURL() !== 'about:blank') { callbacks.unconfirmed(); return }
      closeBlank()
    }, () => {
      if (settled || guest.isDestroyed()) return
      if (!committed && !guest.isLoadingMainFrame()) refused()
      else callbacks.unconfirmed()
    })
  } catch { if (!settled) { settled = true; cleanup(); callbacks.unconfirmed() } }
}
