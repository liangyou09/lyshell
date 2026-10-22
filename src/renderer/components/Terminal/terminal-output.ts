import type { Terminal } from '@xterm/xterm'
import type { ElectronAPI } from '@preload/index'
import type { TerminalOutputReceipt } from '@shared/terminal-output'
import i18n from '../../i18n'

/** 订阅随 terminal-store 实例存活，移动分屏/重挂载不会丢失在途输出或重复注册。 */
export function bindTerminalOutput(sessionId: string, terminal: Pick<Terminal, 'write'>, api?: ElectronAPI): () => void {
  if (!api?.terminalOutputControl) return () => {}
  let stopped = false
  let subscriptionId: string | undefined
  let early: { data: string; receipt: TerminalOutputReceipt } | undefined
  const control = (request: Parameters<ElectronAPI['terminalOutputControl']>[0]) => {
    void api.terminalOutputControl(request).catch(error => console.warn('Terminal output control failed:', error))
  }
  const deliver = (data: string, receipt: TerminalOutputReceipt) => {
    if (stopped || receipt.subscriptionId !== subscriptionId) return
    if (receipt.error) {
      terminal.write(`\r\n\x1b[31m${i18n.t('terminal.outputOverflow')}\x1b[0m\r\n`)
      return
    }
    try {
      terminal.write(data, () => {
        if (!stopped) control({ kind: 'ack', sessionId, subscriptionId: receipt.subscriptionId, sequence: receipt.sequence })
      })
    } catch (error) {
      control({ kind: 'unsubscribe', sessionId, subscriptionId: receipt.subscriptionId })
      console.error('Terminal output write failed:', error)
    }
  }
  const off = api.onTerminalData((id, data, receipt) => {
    if (stopped || id !== sessionId || !receipt) return
    if (!subscriptionId) {
      // invoke 回执可能比第一包数据晚到；服务端最多允许一包在途。
      early = { data, receipt }
      return
    }
    deliver(data, receipt)
  })
  void api.terminalOutputControl({ kind: 'subscribe', sessionId }).then(result => {
    if (!result.success || !result.subscriptionId) {
      off()
      console.warn('Terminal output subscription failed:', result.error)
      return
    }
    subscriptionId = result.subscriptionId
    if (stopped) control({ kind: 'unsubscribe', sessionId, subscriptionId })
    else if (early) deliver(early.data, early.receipt)
    early = undefined
  }).catch(error => { off(); console.warn('Terminal output subscription failed:', error) })
  return () => {
    stopped = true
    early = undefined
    off()
    if (subscriptionId) control({ kind: 'unsubscribe', sessionId, subscriptionId })
  }
}
