import { ipcMain } from 'electron'
import log from 'electron-log'
import { applicationCallers } from '../security/application-caller'
import { recordDiagnosticEvent } from '../diagnostics/events'
import { runWithRequestContext } from '../diagnostics/request-context'
import { businessGate, LifecycleRejectedError } from '../lifecycle/app-lifecycle'

/** 特殊确认/浏览器弹层使用各自的身份桥；主应用操作统一通过此登记入口。 */
export const applicationIpc = {
  handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
    ipcMain.handle(channel, async (event, ...args) => {
      const context = applicationCallers.context(event)
      if (!businessGate.accepts()) {
        recordDiagnosticEvent({ at: Date.now(), requestId: context.requestId, operation: channel, source: 'gui', outcome: 'refused' })
        throw new LifecycleRejectedError(channel, businessGate.phase)
      }
      try {
        const result = await runWithRequestContext(context, () => listener(event, ...args))
        recordDiagnosticEvent({ at: Date.now(), requestId: context.requestId, operation: channel, source: 'gui', outcome: 'completed', durationMs: Date.now() - context.receivedAt })
        return result
      } catch (error) {
        recordDiagnosticEvent({ at: Date.now(), requestId: context.requestId, operation: channel, source: 'gui', outcome: 'failed', durationMs: Date.now() - context.receivedAt })
        throw error
      }
    })
  },
  on(channel: string, listener: Parameters<typeof ipcMain.on>[1]): void {
    ipcMain.on(channel, (event, ...args) => {
      if (!businessGate.accepts()) return
      try {
        const context = applicationCallers.context(event)
        void Promise.resolve(runWithRequestContext(context, () => listener(event, ...args)))
          .catch(() => log.warn('[IPC] Application event failed', channel))
      } catch { log.warn('[IPC] Rejected application event', channel) }
    })
  }
}
