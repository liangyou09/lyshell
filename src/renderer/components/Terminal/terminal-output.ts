import type { Terminal } from '@xterm/xterm'
import type { ElectronAPI } from '@preload/index'
import type { TerminalOutputReceipt } from '@shared/terminal-output'
import i18n from '../../i18n'

/** 订阅随 terminal-store 实例存活，移动分屏/重挂载不会丢失在途输出或重复注册。 */
export function bindTerminalOutput(sessionId: string, terminal: Pick<Terminal, 'write'> & Partial<Pick<Terminal, 'reset'>>, api?: ElectronAPI): () => void {
  if (!api?.terminalOutputControl) return () => {}
  let stopped = false
  let subscriptionId: string | undefined
  let early: { data: string; receipt: TerminalOutputReceipt } | undefined
  let pending = false
  let needsRecovery = false
  const control = (request: Parameters<ElectronAPI['terminalOutputControl']>[0]) => {
    void api.terminalOutputControl(request).catch(error => console.warn('Terminal output control failed:', error))
  }
  const deliver = (data: string, receipt: TerminalOutputReceipt) => {
    if (stopped || receipt.subscriptionId !== subscriptionId) return
    if (receipt.error) {
      subscriptionId = undefined
      needsRecovery = true
      terminal.write(`\r\n\x1b[31m${i18n.t('terminal.outputOverflow')}\x1b[0m\r\n`)
      if (receipt.error === 'history-gap') setTimeout(recover, 0)
      return
    }
    try {
      terminal.write(data, () => {
        if (!stopped && subscriptionId === receipt.subscriptionId && !needsRecovery) control({ kind: 'ack', sessionId, subscriptionId: receipt.subscriptionId, sequence: receipt.sequence })
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
  const subscribe = () => {
    if (pending || stopped) return
    pending = true
    void api.terminalOutputControl({ kind: 'subscribe', sessionId }).then(result => {
    if (!result.success || !result.subscriptionId) {
      needsRecovery = true
      console.warn('Terminal output subscription failed:', result.error)
      return
    }
    subscriptionId = result.subscriptionId
    if (stopped) control({ kind: 'unsubscribe', sessionId, subscriptionId })
    else {
      if (needsRecovery || result.historyTruncated) {
        // RIS 与旧 write 排队执行，先恢复解析器/屏幕状态再重放有限历史。
        terminal.write(`\x1bc\r\n\x1b[33m${i18n.t('terminal.historyGap')}\x1b[0m\r\n`)
      }
      needsRecovery = false
      if (early) deliver(early.data, early.receipt)
    }
    early = undefined
    }).catch(error => { needsRecovery = true; console.warn('Terminal output subscription failed:', error) }).finally(() => { pending = false })
  }
  const recover = () => { if (needsRecovery && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) subscribe() }
  if (typeof window !== 'undefined') window.addEventListener('focus', recover)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', recover)
  subscribe()
  return () => {
    stopped = true
    early = undefined
    off()
    if (typeof window !== 'undefined') window.removeEventListener('focus', recover)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', recover)
    if (subscriptionId) control({ kind: 'unsubscribe', sessionId, subscriptionId })
  }
}
