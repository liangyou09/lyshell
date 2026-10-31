import { BrowserWindow } from 'electron'
import { applicationIpc } from '../ipc/application-ipc'
import { validateTaskWorkbenchRequest, ValidationError } from '../ipc/validation'
import { requestTaskWorkbench } from './runtime'

/** 业务动作仍经过 applicationIpc 的可信 caller 与生命周期检查。 */
export function registerTaskWorkbenchIpc(): void {
  applicationIpc.handle('task-workbench:request', async (event, raw: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent || parent.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
      throw new ValidationError('Task workbench requires the main window')
    }
    const reply = await requestTaskWorkbench(validateTaskWorkbenchRequest(raw), parent)
    if (reply.snapshot && !event.sender.isDestroyed()) event.sender.send('task-workbench:changed', reply.snapshot)
    return reply
  })
}
