import { BrowserWindow } from 'electron'
import { applicationCallers } from '../security/application-caller'
import type { ExclusiveWorkbenchDetail } from '@shared/exclusive-control'

/** 只向仍有效的可信应用窗口广播；服务层无需加载 IPC 注册入口。 */
export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && applicationCallers.isTrusted(win.webContents)) {
      win.webContents.send(channel, ...args)
    }
  }
}

export function broadcastSessionsChanged(): void {
  sendToAllWindows('sessions:changed')
}

/** 共享工作台详情不携带凭据；保持原 force/reopen 语义。 */
export function broadcastDshWebDetail(detail: ExclusiveWorkbenchDetail, force = false, reopen = false): void {
  sendToAllWindows('dsh:web:detail-changed', { detail, force, reopen })
}

export function broadcastMcpOpenConnectionDialog(): void {
  sendToAllWindows('mcp:open-connection-dialog')
}

export function broadcastMcpSessionLocked(sessionId: string): void {
  sendToAllWindows('mcp:session-locked', { sessionId })
}

export function broadcastMcpSessionUnlocked(sessionId: string): void {
  sendToAllWindows('mcp:session-unlocked', { sessionId })
}
